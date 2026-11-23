import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { initializeProjectMemory } from '../init.js';
import { runCli } from '../cli.js';
import { pushProjectMemory } from '../sync.js';
import {
  choosePushTransport,
  INLINE_PUSH_MAX_BYTES,
  PushOutcomeError,
  readResponseText,
} from '../push-upload.js';

// The hosted push's large path against a local stand-in of the app: the
// single request up to 4,000,000 bytes, the compressed upload above, the
// older-app fallback, redirects refused, retries, polls, refusals, and the
// details fetch after a valid 202.

const TOKEN_VAR = 'PUSH_UPLOAD_TEST_TOKEN';
const TOKEN = ['test', 'upload', 'credential'].join('-');

async function createRoot(apiUrl, options = {}) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-push-upload-'));
  const rootDir = path.join(tempDir, '.compass');
  await initializeProjectMemory({
    cwd: tempDir,
    rootDir,
    name: 'Push Upload Project',
    mode: 'local-primary',
    repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
    bootstrap: { workflow: true, claude: true },
  });
  let project = await readFile(path.join(rootDir, 'project.yaml'), 'utf8');
  if (options.secretCheck) project = project.replace('  workflow:\n', `  workflow:\n    secret_check: ${options.secretCheck}\n`);
  project += [
    'sync:',
    '  provider: vibecompass',
    `  api_url: ${apiUrl}`,
    '  project_id: proj-upload',
    '  credential_source: env',
    `  credential_env_var: ${TOKEN_VAR}`,
    '',
  ].join('\n');
  await writeFile(path.join(rootDir, 'project.yaml'), project, 'utf8');
  return { tempDir, rootDir };
}

/** Hex text: no secret-check matches, about 2:1 under gzip. */
async function addDocument(rootDir, name, bytes) {
  const text = [
    '---',
    'domain: Project',
    'feature: Overview',
    `component: ${name}`,
    'status: In progress',
    'repos:',
    '  - "app"',
    'confidence: Test',
    'coverage: Test',
    '---',
    '',
    '## Description',
    randomBytes(Math.ceil(bytes / 2)).toString('hex').slice(0, bytes),
    '',
  ].join('\n');
  await writeFile(path.join(rootDir, 'architecture', 'overview', `${name}.md`), text, 'utf8');
  return text;
}

function environment(tempDir, extra = {}) {
  return {
    cwd: tempDir,
    env: { [TOKEN_VAR]: TOKEN },
    runtime: { fetch: globalThis.fetch, sleep: async () => {}, ...extra },
  };
}

async function startStandIn(behavior = {}) {
  const state = { requests: [], uploads: new Map(), committedBody: null };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(request.url, 'http://stand-in');
    state.requests.push({ method: request.method, path: url.pathname, query: url.search, authorization: request.headers.authorization, bytes: body.length });
    const send = (status, value, headers = {}) => {
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(typeof value === 'string' ? value : JSON.stringify(value));
    };
    const route = url.pathname.replace(/^\/api\/sync\/projects\/proj-upload\//, '');
    try {
      if (behavior.intercept && (await behavior.intercept({ route, request, response, body, state, send, url }))) return;
      if (route === 'push' && request.method === 'POST') {
        state.singleBody = body.toString('utf8');
        return send(202, { run_id: randomUUID(), status: 'completed', remote_revision_id: randomUUID(), projection: { warnings: [] } });
      }
      if (route === 'push-uploads' && request.method === 'POST') {
        if (behavior.noUploadRoutes) return send(404, { error: 'Not found' });
        const declaration = JSON.parse(body.toString('utf8'));
        const id = randomUUID();
        const partBytes = behavior.partBytes ?? 1_000_000;
        state.uploads.set(id, { declaration, parts: new Map(), partBytes });
        return send(201, { upload_id: id, part_bytes: partBytes, part_count: Math.ceil(declaration.packed_bytes / partBytes) });
      }
      let match = route.match(/^push-uploads\/([^/]+)\/parts\/(\d+)$/);
      if (match && request.method === 'PUT') {
        state.uploads.get(match[1]).parts.set(Number(match[2]), body);
        return send(200, { index: Number(match[2]) });
      }
      match = route.match(/^push-uploads\/([^/]+)\/commit$/);
      if (match && request.method === 'POST') {
        const upload = state.uploads.get(match[1]);
        const packed = Buffer.concat([...upload.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, part]) => part));
        assert.equal(createHash('sha256').update(packed).digest('hex'), upload.declaration.packed_sha256);
        assert.equal(JSON.parse(body.toString('utf8')).packed_sha256, upload.declaration.packed_sha256);
        const json = gunzipSync(packed);
        assert.equal(json.length, upload.declaration.unpacked_bytes);
        state.committedBody = json.toString('utf8');
        if (behavior.commit) return behavior.commit({ send, state, upload, response });
        return send(202, { run_id: randomUUID(), status: 'completed', remote_revision_id: randomUUID(), projection: { counts: {}, warnings: [], warnings_total: 0 }, details_truncated: false });
      }
      match = route.match(/^runs\/([^/]+)\/push-details$/);
      if (match && request.method === 'GET' && behavior.details) return behavior.details({ send, url, state });
      return send(404, { error: 'not found' });
    } catch (error) {
      send(500, { error: String(error?.message ?? error) });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('the transport switch uses serialized UTF-8 bytes on both sides of 4,000,000 and 5,000,000', () => {
  const small = [{ raw_text: 'x' }];
  assert.equal(choosePushTransport(INLINE_PUSH_MAX_BYTES, small), 'single');
  assert.equal(choosePushTransport(INLINE_PUSH_MAX_BYTES + 1, small), 'upload');
  const bigDocument = [{ raw_text: '€'.repeat(1_400_000) }]; // 4.2 MB in UTF-8, 1.4M characters
  assert.equal(choosePushTransport(4_500_000, bigDocument), 'single-large');
  assert.equal(choosePushTransport(5_000_001, bigDocument), 'upload');
});

test('a push over 4,000,000 bytes goes compressed in parts and commits; the app receives the exact body', async () => {
  const standIn = await startStandIn();
  try {
    const { tempDir, rootDir } = await createRoot(standIn.url);
    await addDocument(rootDir, 'big-1', 2_200_000);
    await addDocument(rootDir, 'big-2', 2_200_000);
    const result = await pushProjectMemory({ rootDir: '.compass' }, environment(tempDir));
    assert.equal(result.transport, 'upload');
    assert.equal(result.status, 'completed');
    const routes = standIn.state.requests.map((request) => `${request.method} ${request.path.split('/proj-upload/')[1].replace(/[0-9a-f-]{36}/, ':id')}`);
    assert.deepEqual(routes, ['POST push-uploads', 'PUT push-uploads/:id/parts/0', 'PUT push-uploads/:id/parts/1', 'PUT push-uploads/:id/parts/2', 'POST push-uploads/:id/commit']);
    assert.ok(standIn.state.requests.every((request) => request.authorization === `Bearer ${TOKEN}`));
    const sent = JSON.parse(standIn.state.committedBody);
    assert.ok(sent.documents.some((document) => document.path === 'architecture/overview/big-1.md'));
    const manifest = JSON.parse(await readFile(path.join(rootDir, 'state', 'manifest.json'), 'utf8'));
    assert.equal(manifest.sync.last_sync_direction, 'push', 'the cursor is written');
  } finally {
    await standIn.close();
  }
});

test('a push of 4,000,000 bytes or less keeps the single request', async () => {
  const standIn = await startStandIn();
  try {
    const { tempDir, rootDir } = await createRoot(standIn.url);
    await addDocument(rootDir, 'medium', 3_500_000);
    const result = await pushProjectMemory({ rootDir: '.compass' }, environment(tempDir));
    assert.equal(result.transport, 'single');
    assert.deepEqual(standIn.state.requests.map((request) => request.path.split('/proj-upload/')[1]), ['push']);
  } finally {
    await standIn.close();
  }
});

test('a body up to 5,000,000 bytes holding a document over 4,000,000 bytes keeps the single request on a capable app', async () => {
  const standIn = await startStandIn();
  try {
    const { tempDir, rootDir } = await createRoot(standIn.url);
    await addDocument(rootDir, 'huge', 4_100_000);
    const result = await pushProjectMemory({ rootDir: '.compass' }, environment(tempDir));
    assert.equal(result.transport, 'single-large');
    assert.deepEqual(standIn.state.requests.map((request) => request.path.split('/proj-upload/')[1]), ['push']);
  } finally {
    await standIn.close();
  }
});

test('against an older app: up to 5,000,000 bytes falls back to the single request; above, nothing more is sent', async () => {
  const standIn = await startStandIn({ noUploadRoutes: true });
  try {
    const { tempDir, rootDir } = await createRoot(standIn.url);
    await addDocument(rootDir, 'a', 2_200_000);
    await addDocument(rootDir, 'b', 2_200_000);
    const result = await pushProjectMemory({ rootDir: '.compass' }, environment(tempDir));
    assert.equal(result.transport, 'single-fallback');
    assert.deepEqual(standIn.state.requests.map((request) => request.path.split('/proj-upload/')[1]), ['push-uploads', 'push']);

    standIn.state.requests.length = 0;
    await addDocument(rootDir, 'c', 1_500_000);
    await assert.rejects(
      pushProjectMemory({ rootDir: '.compass' }, environment(tempDir)),
      (error) => error instanceof PushOutcomeError && error.outcome === 'refused_before_upload' && /needs an update/.test(error.message),
    );
    assert.deepEqual(standIn.state.requests.map((request) => request.path.split('/proj-upload/')[1]), ['push-uploads']);
  } finally {
    await standIn.close();
  }
});

test('an older app behind Vercel\'s 413 gets the too-large message, not Vercel\'s raw JSON', async () => {
  const standIn = await startStandIn({
    noUploadRoutes: true,
    intercept: async ({ route, send }) => {
      if (route !== 'push') return false;
      send(413, '{"error":{"code":"413","message":"FUNCTION_PAYLOAD_TOO_LARGE"}}');
      return true;
    },
  });
  try {
    const { tempDir, rootDir } = await createRoot(standIn.url);
    await addDocument(rootDir, 'a', 2_300_000);
    await addDocument(rootDir, 'b', 2_300_000);
    await assert.rejects(pushProjectMemory({ rootDir: '.compass' }, environment(tempDir)), (error) => {
      assert.equal(error.outcome, 'refused');
      assert.match(error.message, /over what the hosted app takes in one request/);
      assert.doesNotMatch(error.message, /FUNCTION_PAYLOAD_TOO_LARGE/);
      return true;
    });
  } finally {
    await standIn.close();
  }
});

test('redirects are refused on begin, parts, commit, the large-document request, and the fallback; no body leaves for the other address', async () => {
  const elsewhere = await startStandIn();
  try {
    for (const target of ['push-uploads', 'parts', 'commit', 'push-large', 'fallback']) {
      const standIn = await startStandIn({
        noUploadRoutes: target === 'fallback',
        intercept: async ({ route, request, response }) => {
          const hit =
            (target === 'push-uploads' && route === 'push-uploads') ||
            (target === 'parts' && /\/parts\//.test(route)) ||
            (target === 'commit' && /\/commit$/.test(route)) ||
            ((target === 'push-large' || target === 'fallback') && route === 'push');
          if (!hit) return false;
          response.writeHead(307, { location: `${elsewhere.url}${request.url}` });
          response.end();
          return true;
        },
      });
      try {
        const { tempDir, rootDir } = await createRoot(standIn.url);
        if (target === 'push-large') await addDocument(rootDir, 'huge', 4_100_000);
        else {
          await addDocument(rootDir, 'a', 2_200_000);
          await addDocument(rootDir, 'b', 2_200_000);
        }
        await assert.rejects(
          pushProjectMemory({ rootDir: '.compass' }, environment(tempDir)),
          (error) => error instanceof PushOutcomeError && error.code === 'redirect_refused',
          target,
        );
      } finally {
        await standIn.close();
      }
    }
    assert.equal(elsewhere.state.requests.length, 0, 'nothing reached the redirect target');
  } finally {
    await elsewhere.close();
  }
});

test('a commit retried after a network error succeeds; polls honour in-progress answers', async () => {
  let commits = 0;
  const standIn = await startStandIn({
    commit: ({ send, response }) => {
      commits += 1;
      if (commits === 1) return response.destroy();
      if (commits <= 3) return send(409, { error: 'in progress', code: 'upload_in_progress' }, { 'retry-after': '1' });
      return send(202, { run_id: 'run-9', status: 'completed', remote_revision_id: randomUUID(), projection: { warnings: [], warnings_total: 0 } });
    },
  });
  try {
    const { tempDir, rootDir } = await createRoot(standIn.url);
    await addDocument(rootDir, 'a', 2_200_000);
    await addDocument(rootDir, 'b', 2_200_000);
    const waits = [];
    const result = await pushProjectMemory({ rootDir: '.compass' }, environment(tempDir, { sleep: async (ms) => waits.push(ms) }));
    assert.equal(result.runId, 'run-9');
    assert.equal(commits, 4);
    assert.deepEqual(waits, [1000, 1000]);
  } finally {
    await standIn.close();
  }
});

test('a commit that never settles within the budget is an unknown outcome, and no cursor is written', async () => {
  const standIn = await startStandIn({
    commit: ({ send }) => send(429, { error: 'Too many requests', code: 'sync_credential_requests' }, { 'retry-after': '60' }),
  });
  try {
    const { tempDir, rootDir } = await createRoot(standIn.url);
    await addDocument(rootDir, 'a', 2_200_000);
    await addDocument(rootDir, 'b', 2_200_000);
    await assert.rejects(pushProjectMemory({ rootDir: '.compass' }, environment(tempDir)), (error) => {
      assert.equal(error.outcome, 'unknown');
      assert.match(error.message, /outcome is unknown/);
      return true;
    });
    const manifest = JSON.parse(await readFile(path.join(rootDir, 'state', 'manifest.json'), 'utf8'));
    assert.notEqual(manifest.sync?.last_sync_direction, 'push');
  } finally {
    await standIn.close();
  }
});

test('a refused commit says the hosted memory didn\'t change and names the refusal', async () => {
  const standIn = await startStandIn({
    commit: ({ send }) => send(409, { error: 'Remote project-memory head has advanced; pull before pushing.', status: 'needs_rebase', target_remote_revision_id: 'head-2', run_id: 'audit-1' }),
  });
  try {
    const { tempDir, rootDir } = await createRoot(standIn.url);
    await addDocument(rootDir, 'a', 2_200_000);
    await addDocument(rootDir, 'b', 2_200_000);
    await assert.rejects(pushProjectMemory({ rootDir: '.compass' }, environment(tempDir)), (error) => {
      assert.equal(error.outcome, 'refused');
      assert.equal(error.code, 'needs_rebase');
      assert.match(error.message, /head has advanced.*hosted head head-2.*didn't change/);
      return true;
    });
  } finally {
    await standIn.close();
  }
});

test('the secret check runs before begin, and a failed commit still prints its report (warn)', async () => {
  const standIn = await startStandIn({ commit: ({ send }) => send(422, { error: 'Invalid push request', code: 'upload_hash_mismatch' }) });
  try {
    const { tempDir, rootDir } = await createRoot(standIn.url, { secretCheck: 'warn' });
    await addDocument(rootDir, 'a', 2_200_000);
    await addDocument(rootDir, 'b', 2_200_000);
    const key = ['ghp', '_', 'A'.repeat(36)].join('');
    await writeFile(path.join(rootDir, 'architecture', 'overview', 'leak.md'), `---\ndomain: Project\nfeature: Overview\ncomponent: Leak\nstatus: In progress\nrepos:\n  - "app"\nconfidence: Test\ncoverage: Test\n---\n\n## Description\ntoken: ${key}\n`, 'utf8');
    const stdout = [];
    const io = { stdout: { write: (chunk) => stdout.push(chunk) }, stderr: { write: () => {} } };
    await assert.rejects(
      runCli(['push'], io, { cwd: tempDir, env: { [TOKEN_VAR]: TOKEN }, fetch: globalThis.fetch }),
      /Push refused \(422\)/,
    );
    const output = stdout.join('');
    assert.match(output, /Secret check \(warn\): .*then failed/);
    assert.match(output, /architecture\/overview\/leak\.md:13/);
    assert.ok(!output.includes(key));

    // Block mode refuses before anything is sent.
    standIn.state.requests.length = 0;
    const project = await readFile(path.join(rootDir, 'project.yaml'), 'utf8');
    await writeFile(path.join(rootDir, 'project.yaml'), project.replace('secret_check: warn', 'secret_check: block'), 'utf8');
    await assert.rejects(pushProjectMemory({ rootDir: '.compass' }, environment(tempDir)));
    assert.equal(standIn.state.requests.length, 0);
  } finally {
    await standIn.close();
  }
});

test('after a valid 202 the package fetches omitted warnings, both lists, and each cut message, even one past its read cap', async () => {
  const runId = randomUUID();
  const longMessage = 'é'.repeat(9_000_000); // 18 MB in UTF-8: past the 16 MB read cap as one answer
  const warnings = Array.from({ length: 1_500 }, (_, i) => ({ code: 'unknown_status', message: i === 2 ? longMessage : `note ${i}`, path: `a/${i}.md` }));
  const applied = Array.from({ length: 1_200 }, () => randomUUID());
  const standIn = await startStandIn({
    commit: ({ send }) =>
      send(202, {
        run_id: runId,
        status: 'completed',
        remote_revision_id: randomUUID(),
        applied_proposal_ids: applied.slice(0, 1_000),
        applied_proposal_ids_total: 1_200,
        stale_proposal_ids: [],
        stale_proposal_ids_total: 0,
        projection: {
          counts: {},
          warnings: warnings.slice(0, 1_000).map((w, i) => (i === 2 ? { ...w, message: 'é'.repeat(500), message_truncated: true, message_bytes: 18_000_000 } : w)),
          warnings_total: 1_500,
        },
        details_truncated: true,
      }),
    details: ({ send, url }) => {
      const list = url.searchParams.get('list');
      if (url.searchParams.has('item')) {
        const item = Number(url.searchParams.get('item'));
        const offset = Number(url.searchParams.get('message_offset'));
        const bytes = Buffer.from(warnings[item].message, 'utf8');
        const end = Math.min(bytes.length, offset + 1_000_000);
        return send(200, { item, message_offset: offset, text: bytes.subarray(offset, end).toString('utf8'), next_message_offset: end < bytes.length ? end : null });
      }
      const offset = Number(url.searchParams.get('offset'));
      const source = list === 'warnings' ? warnings : applied;
      const items = source.slice(offset, offset + 200).map((item, i) => (list === 'warnings' ? { index: offset + i, ...item } : item));
      return send(200, { list, total: source.length, offset, items, next_offset: offset + items.length < source.length ? offset + items.length : null });
    },
  });
  try {
    const { tempDir, rootDir } = await createRoot(standIn.url);
    await addDocument(rootDir, 'a', 2_200_000);
    await addDocument(rootDir, 'b', 2_200_000);
    const result = await pushProjectMemory({ rootDir: '.compass' }, environment(tempDir));
    assert.equal(result.warnings.length, 1_500);
    assert.equal(result.warnings[2].message, longMessage);
    assert.equal(result.warnings[2].message_truncated, undefined);
    assert.equal(result.warnings[1_499].message, 'note 1499');
    assert.deepEqual(result.appliedProposalIds, applied);
    assert.equal(result.detailsIncomplete, null);
    assert.equal(result.totals.warnings, 1_500);
  } finally {
    await standIn.close();
  }
});

test('a details fetch that fails after a valid 202 keeps the push, its cursor, and its run id, and reports what is missing', async () => {
  const runId = randomUUID();
  const standIn = await startStandIn({
    commit: ({ send }) =>
      send(202, {
        run_id: runId,
        status: 'completed',
        remote_revision_id: randomUUID(),
        projection: { counts: {}, warnings: [{ code: 'unknown_status', message: 'short', message_truncated: true, message_bytes: 900 }], warnings_total: 3 },
        details_truncated: true,
      }),
    details: ({ send }) => send(500, { error: 'down' }),
  });
  try {
    const { tempDir, rootDir } = await createRoot(standIn.url);
    await addDocument(rootDir, 'a', 2_200_000);
    await addDocument(rootDir, 'b', 2_200_000);
    const result = await pushProjectMemory({ rootDir: '.compass' }, environment(tempDir));
    assert.equal(result.runId, runId);
    assert.deepEqual(result.detailsIncomplete, { runId, warnings: 2, cutWarnings: 1, applied_proposal_ids: 0, stale_proposal_ids: 0 });
    assert.equal(result.warnings[0].message_truncated, true, 'the mapper keeps the cut marks');
    assert.equal(result.warnings[0].message_bytes, 900);
    const manifest = JSON.parse(await readFile(path.join(rootDir, 'state', 'manifest.json'), 'utf8'));
    assert.equal(manifest.sync.last_sync_direction, 'push');
  } finally {
    await standIn.close();
  }
});

test('an answer past the read cap is refused without buffering it whole', async () => {
  const big = new Response('x'.repeat(2_000));
  await assert.rejects(readResponseText(big, 1_000), /larger than 1000 bytes/);
  assert.equal(await readResponseText(new Response('ok'), 1_000), 'ok');
});
