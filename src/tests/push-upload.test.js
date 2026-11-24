import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { initializeProjectMemory } from '../init.js';
import { runCli } from '../cli.js';
import { pushProjectMemory } from '../sync.js';
import {
  choosePushTransport,
  INLINE_PUSH_MAX_BYTES,
  PushOutcomeError,
  readResponseText,
  sendLargeSinglePush,
} from '../push-upload.js';

// The hosted push's large path against a local stand-in of the app: the
// single request up to 4,000,000 bytes, the compressed upload above, the
// older-app fallback, redirects refused, retries, polls, refusals, and the
// details fetch after a valid 202.

const CLI_PATH = fileURLToPath(new URL('../cli.js', import.meta.url));
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
      if (match && request.method === 'GET' && behavior.details) return behavior.details({ send, url, state, response });
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
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        // A stalled answer (the budget tests) must not hold the server open.
        server.closeAllConnections();
      }),
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

test('redirects are refused on begin, parts, commit, the large-document request, the fallback, and the small push; no body leaves for the other address', async () => {
  const elsewhere = await startStandIn();
  try {
    for (const target of ['push-uploads', 'parts', 'commit', 'push-large', 'fallback', 'push-small']) {
      const standIn = await startStandIn({
        noUploadRoutes: target === 'fallback',
        intercept: async ({ route, request, response }) => {
          const hit =
            (target === 'push-uploads' && route === 'push-uploads') ||
            (target === 'parts' && /\/parts\//.test(route)) ||
            (target === 'commit' && /\/commit$/.test(route)) ||
            ((target === 'push-large' || target === 'fallback' || target === 'push-small') && route === 'push');
          if (!hit) return false;
          response.writeHead(307, { location: `${elsewhere.url}${request.url}` });
          response.end();
          return true;
        },
      });
      try {
        const { tempDir, rootDir } = await createRoot(standIn.url);
        if (target === 'push-large') await addDocument(rootDir, 'huge', 4_100_000);
        else if (target === 'push-small') await addDocument(rootDir, 'a', 10_000);
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
  const runId = randomUUID();
  let commits = 0;
  const standIn = await startStandIn({
    commit: ({ send, response }) => {
      commits += 1;
      if (commits === 1) return response.destroy();
      if (commits <= 3) return send(409, { error: 'in progress', code: 'upload_in_progress' }, { 'retry-after': '1' });
      return send(202, { run_id: runId, status: 'completed', remote_revision_id: randomUUID(), projection: { warnings: [], warnings_total: 0 } });
    },
  });
  try {
    const { tempDir, rootDir } = await createRoot(standIn.url);
    await addDocument(rootDir, 'a', 2_200_000);
    await addDocument(rootDir, 'b', 2_200_000);
    const waits = [];
    const result = await pushProjectMemory({ rootDir: '.compass' }, environment(tempDir, { sleep: async (ms) => waits.push(ms) }));
    assert.equal(result.runId, runId);
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
        return send(200, { run_id: runId, item, message_bytes: bytes.length, message_offset: offset, text: bytes.subarray(offset, end).toString('utf8'), next_message_offset: end < bytes.length ? end : null });
      }
      const offset = Number(url.searchParams.get('offset'));
      const source = list === 'warnings' ? warnings : applied;
      const items = source.slice(offset, offset + 200).map((item, i) => (list === 'warnings' ? { index: offset + i, ...item } : item));
      return send(200, { run_id: runId, list, total: source.length, offset, items, next_offset: offset + items.length < source.length ? offset + items.length : null });
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

// Review pass 6: answers validated before the cursor, ambiguous retries,
// time budgets that bound reads, refusal details, and checked details.

async function readManifestSync(rootDir) {
  const manifest = JSON.parse(await readFile(path.join(rootDir, 'state', 'manifest.json'), 'utf8'));
  return manifest.sync ?? null;
}

function validAnswer(extra = {}) {
  return { run_id: randomUUID(), status: 'completed', remote_revision_id: randomUUID(), projection: { counts: {}, warnings: [], warnings_total: 0 }, details_truncated: false, ...extra };
}

/** A root that already pushed once, so a later failure can be checked against its recorded cursor. */
async function rootWithCursor(standIn) {
  const { tempDir, rootDir } = await createRoot(standIn.url);
  await addDocument(rootDir, 'a', 2_200_000);
  await addDocument(rootDir, 'b', 2_200_000);
  await pushProjectMemory({ rootDir: '.compass' }, environment(tempDir));
  const before = await readManifestSync(rootDir);
  assert.equal(before.last_sync_direction, 'push');
  await addDocument(rootDir, 'c', 300_000);
  return { tempDir, rootDir, before };
}

test('a commit reply cut off mid-body is retried for the same upload, and the replayed receipt is recorded', async () => {
  const replay = validAnswer();
  const uploadIds = [];
  const standIn = await startStandIn({
    intercept: async ({ route }) => {
      const match = route.match(/^push-uploads\/([^/]+)\/commit$/);
      if (match) uploadIds.push(match[1]);
      return false;
    },
    commit: ({ send, response }) => {
      if (uploadIds.length === 1) {
        response.writeHead(202, { 'content-type': 'application/json' });
        response.write(JSON.stringify(replay).slice(0, 40));
        setTimeout(() => response.destroy(), 20);
        return;
      }
      return send(202, replay);
    },
  });
  try {
    const { tempDir, rootDir } = await createRoot(standIn.url);
    await addDocument(rootDir, 'a', 2_200_000);
    await addDocument(rootDir, 'b', 2_200_000);
    const result = await pushProjectMemory({ rootDir: '.compass' }, environment(tempDir));
    assert.equal(uploadIds.length, 2);
    assert.equal(uploadIds[0], uploadIds[1], 'the retry names the same upload');
    assert.equal(result.runId, replay.run_id);
    assert.equal((await readManifestSync(rootDir)).last_successful_remote_revision, replay.remote_revision_id);
  } finally {
    await standIn.close();
  }
});

test('a 202 that never carries a valid acknowledgement is an unknown outcome, and the recorded cursor stays as it was', async () => {
  for (const malformed of ['not json', '{"status":"completed"}', JSON.stringify({ ...validAnswer(), run_id: 'run-1' })]) {
    let failing = false;
    const standIn = await startStandIn({
      commit: ({ send }) => (failing ? send(202, malformed) : send(202, validAnswer())),
    });
    try {
      const { tempDir, rootDir, before } = await rootWithCursor(standIn);
      failing = true;
      await assert.rejects(pushProjectMemory({ rootDir: '.compass' }, environment(tempDir)), (error) => {
        assert.equal(error.outcome, 'unknown', malformed);
        assert.match(error.message, /outcome is unknown/);
        return true;
      });
      assert.deepEqual(await readManifestSync(rootDir), before, 'cursor, manifest hash, and pending previews unchanged');
    } finally {
      await standIn.close();
    }
  }
});

test('an empty or malformed success on a single request (the older-app fallback, and a small push) is unknown and records nothing', async () => {
  for (const kind of ['fallback-204', 'small-empty-object', 'small-not-json']) {
    const standIn = await startStandIn({
      noUploadRoutes: kind === 'fallback-204',
      intercept: async ({ route, response, send }) => {
        if (route !== 'push') return false;
        if (kind === 'fallback-204') {
          response.writeHead(204);
          response.end();
        } else if (kind === 'small-empty-object') send(202, {});
        else send(200, '<html>ok</html>');
        return true;
      },
    });
    try {
      const { tempDir, rootDir } = await createRoot(standIn.url);
      if (kind === 'fallback-204') {
        await addDocument(rootDir, 'a', 2_200_000);
        await addDocument(rootDir, 'b', 2_200_000);
      } else await addDocument(rootDir, 'a', 10_000);
      await assert.rejects(pushProjectMemory({ rootDir: '.compass' }, environment(tempDir)), (error) => {
        assert.equal(error.outcome, 'unknown', kind);
        assert.equal(error.code, 'invalid_answer', kind);
        return true;
      });
      assert.notEqual((await readManifestSync(rootDir))?.last_sync_direction, 'push', kind);
    } finally {
      await standIn.close();
    }
  }
});

test('after a lost commit reply, an answer that isn\'t this upload\'s record (a 401, another upload\'s refusal) is unknown, not refused', async () => {
  for (const second of ['401', 'other-upload']) {
    let commits = 0;
    const standIn = await startStandIn({
      commit: ({ send, response }) => {
        commits += 1;
        if (commits === 1) return response.destroy();
        if (second === '401') return send(401, { error: 'Invalid sync credential' });
        return send(409, { error: 'The upload used all of its commit attempts.', code: 'upload_attempts_exhausted', upload_id: randomUUID() });
      },
    });
    try {
      const { tempDir, rootDir } = await createRoot(standIn.url);
      await addDocument(rootDir, 'a', 2_200_000);
      await addDocument(rootDir, 'b', 2_200_000);
      await assert.rejects(pushProjectMemory({ rootDir: '.compass' }, environment(tempDir)), (error) => {
        assert.equal(error.outcome, 'unknown', second);
        assert.match(error.message, /doesn't say what the earlier attempt did/);
        assert.doesNotMatch(error.message, /didn't change/);
        return true;
      });
      assert.equal(commits, 2);
    } finally {
      await standIn.close();
    }
  }
});

test('after a lost commit reply, the upload\'s replayed refusal reports its original outcome and details', async () => {
  let commits = 0;
  const auditRun = randomUUID();
  const head = randomUUID();
  const standIn = await startStandIn({
    commit: ({ send, response, upload, state }) => {
      commits += 1;
      if (commits === 1) return response.destroy();
      const uploadId = [...state.uploads.entries()].find(([, value]) => value === upload)[0];
      return send(409, { error: 'Remote project-memory head has advanced; pull before pushing.', upload_id: uploadId, status: 'needs_rebase', target_remote_revision_id: head, run_id: auditRun });
    },
  });
  try {
    const { tempDir, rootDir } = await createRoot(standIn.url);
    await addDocument(rootDir, 'a', 2_200_000);
    await addDocument(rootDir, 'b', 2_200_000);
    await assert.rejects(pushProjectMemory({ rootDir: '.compass' }, environment(tempDir)), (error) => {
      assert.equal(error.outcome, 'refused');
      assert.equal(error.code, 'needs_rebase');
      assert.match(error.message, new RegExp(`hosted head ${head}, run ${auditRun}\\). The hosted memory didn't change`));
      return true;
    });
  } finally {
    await standIn.close();
  }
});

test('a commit answer that sends its headers and then stalls ends as an unknown outcome within the budget', async () => {
  let commits = 0;
  const standIn = await startStandIn({
    commit: ({ send, response }) => {
      commits += 1;
      if (commits === 1) return send(409, { error: 'in progress', code: 'upload_in_progress' }, { 'retry-after': '1' });
      response.writeHead(202, { 'content-type': 'application/json' });
      response.write('{"run_id":');
    },
  });
  try {
    const { tempDir, rootDir } = await createRoot(standIn.url);
    await addDocument(rootDir, 'a', 2_200_000);
    await addDocument(rootDir, 'b', 2_200_000);
    const started = Date.now();
    await assert.rejects(
      pushProjectMemory({ rootDir: '.compass' }, environment(tempDir, { pushBudgets: { commitMs: 1_500 } })),
      (error) => error.outcome === 'unknown' && /time budget/.test(error.message),
    );
    assert.ok(Date.now() - started < 6_000, `ended after ${Date.now() - started} ms`);
    assert.equal(commits, 2);
    assert.notEqual((await readManifestSync(rootDir))?.last_sync_direction, 'push');
  } finally {
    await standIn.close();
  }
});

test('a details read that stalls after a valid 202 keeps the push, its run id and cursor, and reports what is missing', async () => {
  const answer = validAnswer({
    projection: { counts: {}, warnings: [{ code: 'unknown_status', message: 'short', message_truncated: true, message_bytes: 900 }], warnings_total: 3 },
    details_truncated: true,
  });
  const standIn = await startStandIn({
    commit: ({ send }) => send(202, answer),
    details: ({ response }) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"items":[');
    },
  });
  try {
    const { tempDir, rootDir } = await createRoot(standIn.url);
    await addDocument(rootDir, 'a', 2_200_000);
    await addDocument(rootDir, 'b', 2_200_000);
    const started = Date.now();
    const result = await pushProjectMemory({ rootDir: '.compass' }, environment(tempDir, { pushBudgets: { detailsMs: 1_000 } }));
    assert.ok(Date.now() - started < 6_000, `ended after ${Date.now() - started} ms`);
    assert.equal(result.runId, answer.run_id);
    assert.deepEqual(result.detailsIncomplete, { runId: answer.run_id, warnings: 2, cutWarnings: 1, applied_proposal_ids: 0, stale_proposal_ids: 0 });
    assert.equal((await readManifestSync(rootDir)).last_successful_remote_revision, answer.remote_revision_id);
  } finally {
    await standIn.close();
  }
});

/** Runs the real CLI as a child process and returns its exit code and output. */
function runCliProcess(cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, 'push'], {
      cwd,
      env: { PATH: process.env.PATH, HOME: cwd, [TOKEN_VAR]: TOKEN },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('the CLI prints a refusal\'s recorded details: the needs_rebase run and head, and schema issues, first time and replayed', async () => {
  const auditRun = randomUUID();
  const head = randomUUID();
  const issues = Array.from({ length: 25 }, (_, i) => ({ path: `documents.${i}.raw_text`, message: `Document ${i} is invalid` }));
  for (const kind of ['needs_rebase', 'issues-all-kept', 'issues-omitted-replayed', 'needs_rebase-replayed']) {
    let commits = 0;
    const standIn = await startStandIn({
      commit: ({ send, response, upload, state }) => {
        commits += 1;
        const uploadId = [...state.uploads.entries()].find(([, value]) => value === upload)[0];
        if (kind.endsWith('-replayed') && commits === 1) return response.destroy();
        if (kind === 'issues-all-kept') {
          return send(422, { error: 'Invalid push request', upload_id: uploadId, issues, issues_total: 25, issues_omitted: 0 });
        }
        if (kind === 'issues-omitted-replayed') {
          return send(422, { error: 'Invalid push request', upload_id: uploadId, issues, issues_total: 40, issues_omitted: 15 });
        }
        return send(409, { error: 'Remote project-memory head has advanced; pull before pushing.', upload_id: uploadId, status: 'needs_rebase', target_remote_revision_id: head, run_id: auditRun });
      },
    });
    try {
      const { tempDir, rootDir } = await createRoot(standIn.url);
      await addDocument(rootDir, 'a', 2_200_000);
      await addDocument(rootDir, 'b', 2_200_000);
      const { code, stderr } = await runCliProcess(tempDir);
      assert.equal(code, 1, kind);
      if (kind.startsWith('issues')) {
        assert.match(stderr, /Error: Push refused \(422\): Invalid push request\. The hosted memory didn't change\./, kind);
        // Every issue the receipt kept is printed, the 25th included.
        for (const i of [0, 19, 20, 24]) {
          assert.match(stderr, new RegExp(`\\n {2}- documents\\.${i}\\.raw_text: Document ${i} is invalid\\n`), `${kind}: issue ${i}`);
        }
        if (kind === 'issues-all-kept') assert.doesNotMatch(stderr, /more the hosted app counted/, kind);
        else assert.match(stderr, /\n {2}- and 15 more the hosted app counted but didn't keep \(40 in all\)/, kind);
      } else {
        assert.match(stderr, new RegExp(`Error: Push refused \\(409\\): Remote project-memory head has advanced; pull before pushing \\(needs_rebase, hosted head ${head}, run ${auditRun}\\)\\. The hosted memory didn't change\\.`), kind);
      }
      assert.doesNotMatch(stderr, new RegExp(TOKEN));
    } finally {
      await standIn.close();
    }
  }
});

/** UTF-8 cut points the app uses: chunk k ends at the last character boundary at or before (k + 1) × 999,997 bytes. */
function appChunk(bytes, offset) {
  const grid = 999_997;
  const k = offset === 0 ? 0 : Math.ceil(offset / grid);
  let end = Math.min(bytes.length, (k + 1) * grid);
  if (end < bytes.length) while (end > offset && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return end;
}

/**
 * A receipt with 1,000 plain warnings and a total of 1,300, so the cut warning
 * at index 1,150 is first found on a later page. `chunkFault(n, body)` can
 * change the nth chunk's answer.
 */
async function laterPageStandIn({ chunkFault } = {}) {
  const runId = randomUUID();
  const long = `status "xy${'€😀a'.repeat(330_000)}"`;
  const longBytes = Buffer.from(long, 'utf8');
  const warnings = Array.from({ length: 1_300 }, (_, i) => ({ code: 'unknown_status', message: i === 1_150 ? long : `note ${i}`, path: `a/${i}.md` }));
  let chunks = 0;
  const standIn = await startStandIn({
    commit: ({ send }) =>
      send(202, validAnswer({
        run_id: runId,
        projection: { counts: {}, warnings: warnings.slice(0, 1_000), warnings_total: 1_300 },
        details_truncated: true,
      })),
    details: ({ send, url }) => {
      if (url.searchParams.has('item')) {
        const item = Number(url.searchParams.get('item'));
        const offset = Number(url.searchParams.get('message_offset'));
        assert.equal(item, 1_150);
        const end = appChunk(longBytes, offset);
        chunks += 1;
        const body = { run_id: runId, item, message_bytes: longBytes.length, message_offset: offset, text: longBytes.subarray(offset, end).toString('utf8'), next_message_offset: end < longBytes.length ? end : null };
        const faulted = chunkFault?.(chunks, body);
        if (faulted === 'fail') return send(500, { error: 'down' });
        return send(200, faulted ?? body);
      }
      const offset = Number(url.searchParams.get('offset'));
      const items = warnings.slice(offset, offset + 100).map((warning, i) => {
        const index = offset + i;
        if (index !== 1_150) return { index, ...warning };
        return { index, code: warning.code, path: warning.path, message: longBytes.subarray(0, 65_536).toString('utf8').replace(/�+$/, ''), message_truncated: true, message_bytes: longBytes.length };
      });
      return send(200, { run_id: runId, list: 'warnings', total: 1_300, offset, items, next_offset: offset + items.length < 1_300 ? offset + items.length : null });
    },
  });
  return { standIn, long, longBytes, chunkCount: () => chunks };
}

test('a cut warning first found on a later page is recovered exactly, across multibyte chunk boundaries', async () => {
  const { standIn, long, chunkCount } = await laterPageStandIn();
  try {
    const { tempDir, rootDir } = await createRoot(standIn.url);
    await addDocument(rootDir, 'a', 2_200_000);
    await addDocument(rootDir, 'b', 2_200_000);
    const result = await pushProjectMemory({ rootDir: '.compass' }, environment(tempDir));
    assert.equal(result.warnings.length, 1_300);
    assert.equal(result.warnings[1_150].message, long);
    assert.equal(result.warnings[1_150].message_truncated, undefined);
    assert.equal(result.warnings[1_299].message, 'note 1299');
    assert.equal(result.detailsIncomplete, null);
    assert.ok(chunkCount() >= 3);
  } finally {
    await standIn.close();
  }
});

test('an interrupted or malformed message read keeps the preview and its marks, and reports one incomplete warning', async () => {
  const faults = {
    'interrupted': (n) => (n === 2 ? 'fail' : undefined),
    'empty final chunk': (n, body) => (n === 1 ? { ...body, text: '', next_message_offset: null } : undefined),
    'offset not advanced by the text': (n, body) => (n === 1 ? { ...body, next_message_offset: body.next_message_offset + 1 } : undefined),
    'wrong item': (n, body) => (n === 2 ? { ...body, item: 1_149 } : undefined),
    'message_bytes changed': (n, body) => (n === 2 ? { ...body, message_bytes: body.message_bytes - 1 } : undefined),
    'wrong echoed offset': (n, body) => (n === 2 ? { ...body, message_offset: 0 } : undefined),
    'no message_bytes': (n, body) => (n === 1 ? { ...body, message_bytes: undefined } : undefined),
  };
  for (const [name, chunkFault] of Object.entries(faults)) {
    const { standIn, longBytes } = await laterPageStandIn({ chunkFault });
    try {
      const { tempDir, rootDir } = await createRoot(standIn.url);
      await addDocument(rootDir, 'a', 2_200_000);
      await addDocument(rootDir, 'b', 2_200_000);
      const result = await pushProjectMemory({ rootDir: '.compass' }, environment(tempDir));
      const entry = result.warnings[1_150];
      assert.equal(entry.message_truncated, true, name);
      assert.equal(entry.message_bytes, longBytes.length, name);
      assert.ok(entry.message.length > 0 && entry.message.length < 70_000, name);
      assert.equal(result.detailsIncomplete?.cutWarnings, 1, name);
      assert.equal(result.detailsIncomplete?.warnings, 0, name);
      assert.equal((await readManifestSync(rootDir)).last_sync_direction, 'push', name);
    } finally {
      await standIn.close();
    }
  }
});

test('a warning page whose items are out of order is not used past the break', async () => {
  const runId = randomUUID();
  const warnings = Array.from({ length: 1_200 }, (_, i) => ({ code: 'unknown_status', message: `note ${i}` }));
  const standIn = await startStandIn({
    commit: ({ send }) => send(202, validAnswer({ run_id: runId, projection: { counts: {}, warnings: warnings.slice(0, 1_000), warnings_total: 1_200 }, details_truncated: true })),
    details: ({ send, url }) => {
      const offset = Number(url.searchParams.get('offset'));
      const items = warnings.slice(offset, offset + 100).map((warning, i) => ({ index: offset + i + (i === 50 ? 1 : 0), ...warning }));
      return send(200, { run_id: runId, list: 'warnings', total: 1_200, offset, items, next_offset: offset + 100 < 1_200 ? offset + 100 : null });
    },
  });
  try {
    const { tempDir, rootDir } = await createRoot(standIn.url);
    await addDocument(rootDir, 'a', 2_200_000);
    await addDocument(rootDir, 'b', 2_200_000);
    const result = await pushProjectMemory({ rootDir: '.compass' }, environment(tempDir));
    assert.equal(result.warnings.length, 1_050);
    assert.equal(result.detailsIncomplete.warnings, 150);
  } finally {
    await standIn.close();
  }
});

test('a malformed 202 is asked again for the same upload, and a valid replay is recorded', async () => {
  const replay = validAnswer();
  let commits = 0;
  const standIn = await startStandIn({
    commit: ({ send }) => {
      commits += 1;
      return commits === 1 ? send(202, '{"status":"completed"') : send(202, replay);
    },
  });
  try {
    const { tempDir, rootDir } = await createRoot(standIn.url);
    await addDocument(rootDir, 'a', 2_200_000);
    await addDocument(rootDir, 'b', 2_200_000);
    const result = await pushProjectMemory({ rootDir: '.compass' }, environment(tempDir));
    assert.equal(commits, 2);
    assert.equal(result.runId, replay.run_id);
  } finally {
    await standIn.close();
  }
});

test('the large single request accepts only a 202 with a valid acknowledgement, and words a refusal with its details', async () => {
  const context = (status, body) => ({
    apiUrl: 'http://127.0.0.1:9/',
    projectId: 'proj-upload',
    credential: TOKEN,
    fetch: async () => new Response(body === null ? null : typeof body === 'string' ? body : JSON.stringify(body), { status }),
  });
  const documents = [{ path: 'a.md', raw_text: 'x' }];
  const valid = validAnswer();
  assert.equal((await sendLargeSinglePush(context(202, valid), '{}', documents)).run_id, valid.run_id);
  for (const [status, body] of [[204, null], [200, valid], [202, { status: 'completed' }], [202, 'not json']]) {
    await assert.rejects(
      sendLargeSinglePush(context(status, body), '{}', documents),
      (error) => error.outcome === 'unknown' && error.code === 'invalid_answer',
      `${status} ${JSON.stringify(body)}`,
    );
  }
  const issues = Array.from({ length: 3 }, (_, i) => ({ path: `documents.${i}.kind`, message: `Kind ${i} is invalid` }));
  await assert.rejects(sendLargeSinglePush(context(422, { error: 'Invalid push request', issues }), '{}', documents), (error) => {
    assert.equal(error.outcome, 'refused');
    assert.match(error.message, /^Push refused \(422\): Invalid push request\. The hosted memory didn't change\.\n {2}- documents\.0\.kind: Kind 0 is invalid\n/);
    assert.match(error.message, /documents\.2\.kind: Kind 2 is invalid$/);
    return true;
  });
});

test('a body read gives up when its signal aborts, even on a stream that never sends another byte', async () => {
  const stalled = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"run')); } }));
  const started = Date.now();
  // A real request's socket keeps the process alive while it stalls; this
  // stream holds nothing open, and AbortSignal.timeout's timer is unref'd.
  const keepAlive = setInterval(() => {}, 1_000);
  // A backstop, so a read that never gives up fails instead of hanging.
  setTimeout(() => clearInterval(keepAlive), 5_000).unref();
  try {
    await assert.rejects(readResponseText(stalled, 1_000, { signal: AbortSignal.timeout(200) }));
  } finally {
    clearInterval(keepAlive);
  }
  assert.ok(Date.now() - started < 5_000);
});

test('a details response naming another run or another list is not used: the preview and missing ids stay, reported incomplete', async () => {
  for (const fault of ['chunk-other-run', 'page-other-list', 'page-other-run', 'warnings-page-other-run', 'warnings-page-other-list']) {
    const runId = randomUUID();
    const long = 'é'.repeat(600);
    const applied = Array.from({ length: 1_200 }, () => randomUUID());
    const standIn = await startStandIn({
      commit: ({ send }) =>
        send(202, validAnswer({
          run_id: runId,
          applied_proposal_ids: applied.slice(0, 1_000),
          applied_proposal_ids_total: 1_200,
          projection: { counts: {}, warnings: [{ code: 'unknown_status', message: 'é'.repeat(500), message_truncated: true, message_bytes: 1_200 }], warnings_total: 2 },
          details_truncated: true,
        })),
      details: ({ send, url }) => {
        if (url.searchParams.has('item')) {
          const body = { run_id: runId, item: 0, message_bytes: 1_200, message_offset: 0, text: long, next_message_offset: null };
          return send(200, fault === 'chunk-other-run' ? { ...body, run_id: randomUUID() } : body);
        }
        const offset = Number(url.searchParams.get('offset'));
        if (url.searchParams.get('list') === 'warnings') {
          const warningsPage = { run_id: runId, list: 'warnings', total: 2, offset, items: [{ index: 1, code: 'unknown_status', message: 'second' }], next_offset: null };
          if (fault === 'warnings-page-other-run') return send(200, { ...warningsPage, run_id: randomUUID() });
          if (fault === 'warnings-page-other-list') return send(200, { ...warningsPage, list: 'stale_proposal_ids' });
          return send(200, warningsPage);
        }
        const items = applied.slice(offset, offset + 500);
        const page = { run_id: runId, list: 'applied_proposal_ids', total: 1_200, offset, items, next_offset: null };
        if (fault === 'page-other-list') return send(200, { ...page, list: 'stale_proposal_ids' });
        if (fault === 'page-other-run') return send(200, { ...page, run_id: randomUUID() });
        return send(200, page);
      },
    });
    try {
      const { tempDir, rootDir } = await createRoot(standIn.url);
      await addDocument(rootDir, 'a', 2_200_000);
      await addDocument(rootDir, 'b', 2_200_000);
      const result = await pushProjectMemory({ rootDir: '.compass' }, environment(tempDir));
      assert.equal(result.runId, runId, fault);
      if (fault === 'chunk-other-run') {
        assert.equal(result.warnings[0].message_truncated, true, fault);
        assert.equal(result.detailsIncomplete.cutWarnings, 1, fault);
        assert.equal(result.appliedProposalIds.length, 1_200, fault);
      } else if (fault.startsWith('warnings-page')) {
        assert.equal(result.warnings.length, 1, fault);
        assert.equal(result.detailsIncomplete.warnings, 1, fault);
        assert.equal(result.appliedProposalIds.length, 1_200, fault);
      } else {
        assert.equal(result.appliedProposalIds.length, 1_000, fault);
        assert.equal(result.detailsIncomplete.applied_proposal_ids, 200, fault);
        assert.equal(result.warnings[0].message, long, fault);
        assert.equal(result.warnings[1].message, 'second', fault);
      }
    } finally {
      await standIn.close();
    }
  }
});

test('a single request whose connection fails is an unknown outcome, never resent, and an unreachable app sent nothing', async () => {
  for (const kind of ['large-reset-before-answer', 'small-reset-mid-answer']) {
    let posts = 0;
    const standIn = await startStandIn({
      intercept: async ({ route, response }) => {
        if (route !== 'push') return false;
        posts += 1;
        if (kind === 'large-reset-before-answer') {
          response.socket.destroy();
        } else {
          response.writeHead(202, { 'content-type': 'application/json' });
          response.write('{"run_id":"');
          setTimeout(() => response.socket.destroy(), 20);
        }
        return true;
      },
    });
    try {
      const { tempDir, rootDir } = await createRoot(standIn.url, { secretCheck: 'warn' });
      if (kind === 'large-reset-before-answer') {
        // Over 4,000,000 bytes with a document over 4,000,000: the large single request.
        await addDocument(rootDir, 'large', 4_100_000);
      } else await addDocument(rootDir, 'a', 10_000);
      const before = await readManifestSync(rootDir);
      await assert.rejects(pushProjectMemory({ rootDir: '.compass' }, environment(tempDir)), (error) => {
        assert.ok(error instanceof PushOutcomeError, kind);
        assert.equal(error.outcome, 'unknown', kind);
        assert.equal(error.code, 'connection_failed', kind);
        assert.match(error.message, /The push's outcome is unknown: the connection to the hosted app failed/, kind);
        assert.ok(error.secretCheck, `${kind}: the error carries the secret-check report`);
        return true;
      });
      assert.equal(posts, 1, `${kind}: the request is not resent`);
      assert.deepEqual(await readManifestSync(rootDir), before, `${kind}: nothing recorded`);
      // The message the user sees.
      const { code, stdout, stderr } = await runCliProcess(tempDir);
      assert.equal(code, 1, kind);
      assert.match(stderr, /Error: The push's outcome is unknown: the connection to the hosted app failed (before its answer arrived|while its answer was read) \(.+\)\. Nothing was recorded locally\. Run vibecompass status/, kind);
      assert.match(stdout, /Secret check: passed/, `${kind}: the report is printed on failure`);
    } finally {
      await standIn.close();
    }
  }

  // A small push answered with a redirect to an address that refuses the
  // connection: the app received the POST, so the push never follows it and
  // the outcome is unknown, never "nothing was sent".
  {
    const refused = http.createServer();
    await new Promise((resolve) => refused.listen(0, '127.0.0.1', resolve));
    const refusedPort = refused.address().port;
    await new Promise((resolve) => refused.close(resolve));
    let posts = 0;
    const standIn = await startStandIn({
      intercept: async ({ route, request, response }) => {
        if (route !== 'push') return false;
        posts += 1;
        response.writeHead(303, { location: `http://127.0.0.1:${refusedPort}${request.url}` });
        response.end();
        return true;
      },
    });
    try {
      const { tempDir, rootDir } = await createRoot(standIn.url, { secretCheck: 'warn' });
      await addDocument(rootDir, 'a', 10_000);
      const before = await readManifestSync(rootDir);
      await assert.rejects(pushProjectMemory({ rootDir: '.compass' }, environment(tempDir)), (error) => {
        assert.ok(error instanceof PushOutcomeError);
        assert.equal(error.outcome, 'unknown');
        assert.equal(error.code, 'redirect_refused');
        assert.doesNotMatch(error.message, /Nothing was sent/);
        assert.ok(error.secretCheck, 'the error carries the secret-check report');
        return true;
      });
      assert.equal(posts, 1, 'the redirect is not followed and the request is not resent');
      assert.deepEqual(await readManifestSync(rootDir), before, 'nothing recorded');
      const { code, stdout, stderr } = await runCliProcess(tempDir);
      assert.equal(code, 1);
      assert.match(stderr, /Error: The push's outcome is unknown: the hosted app at .+ answered 303, a redirect, which a push never follows\. Nothing was recorded locally\./);
      assert.match(stderr, /Set sync\.api_url to the app's final address, then run vibecompass status, or push again/);
      assert.doesNotMatch(stderr, /Nothing was sent/);
      assert.match(stdout, /Secret check: passed/);
    } finally {
      await standIn.close();
    }
  }

  // Nothing listens: the connection was never made, so nothing was sent.
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  const { tempDir, rootDir } = await createRoot(`http://127.0.0.1:${port}`);
  await addDocument(rootDir, 'a', 10_000);
  await assert.rejects(pushProjectMemory({ rootDir: '.compass' }, environment(tempDir)), (error) => {
    assert.equal(error.outcome, 'refused_before_upload');
    assert.equal(error.code, 'app_unreachable');
    assert.match(error.message, /couldn't be reached \(ECONNREFUSED\)\. Nothing was sent\./);
    return true;
  });

  // A name that doesn't resolve is unreachable even when it contains the word
  // "redirect": a redirect is known by the answer's status, never by error text.
  const hostname = 'sync-redirect.example.invalid';
  const dnsFailure = async () => {
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND', hostname }),
    });
  };
  for (const large of [false, true]) {
    const { tempDir: dnsDir, rootDir: dnsRoot } = await createRoot(`http://${hostname}`);
    if (large) {
      await addDocument(dnsRoot, 'a', 2_200_000);
      await addDocument(dnsRoot, 'b', 2_200_000);
    } else await addDocument(dnsRoot, 'a', 10_000);
    await assert.rejects(pushProjectMemory({ rootDir: '.compass' }, environment(dnsDir, { fetch: dnsFailure })), (error) => {
      assert.notEqual(error.code, 'redirect_refused', `large: ${large}`);
      assert.doesNotMatch(error.message, /a redirect, which a push never follows/, `large: ${large}`);
      if (!large) {
        assert.equal(error.outcome, 'refused_before_upload');
        assert.equal(error.code, 'app_unreachable');
        assert.match(error.message, /couldn't be reached \(ENOTFOUND\)\. Nothing was sent\./);
      }
      return true;
    });
  }
});
