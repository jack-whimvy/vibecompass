import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { runCli } from '../cli.js';
import { initializeProjectMemory } from '../init.js';
import { parseSimpleYaml } from '../simple-yaml.js';

const ADOPTED_HEAD = '99999999-8888-4777-a666-555555555555';

function createIo(stdout = [], stderr = []) {
  return {
    stdout: { write(chunk) { stdout.push(chunk); } },
    stderr: { write(chunk) { stderr.push(chunk); } },
  };
}

function fetchMock(previewResponse) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => previewResponse,
        text: async () => JSON.stringify(previewResponse),
      };
    },
  };
}

async function createConnectedRoot(tempDir) {
  await initializeProjectMemory({
    cwd: tempDir,
    rootDir: '.compass',
    name: 'Adopt Fixture',
    mode: 'local-primary',
    repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
  });
  const exitCode = await runCli(
    [
      'connect-hosted',
      '--root',
      path.join(tempDir, '.compass'),
      '--sync-api-url',
      'https://vibecompass.example',
      '--sync-project-id',
      'proj-adopt',
      '--sync-credential-env-var',
      'VIBECOMPASS_SYNC_TOKEN',
    ],
    createIo(),
    { cwd: tempDir, env: {} },
  );
  assert.equal(exitCode, 0);
}

async function readCursor(tempDir) {
  const manifest = JSON.parse(
    await readFile(path.join(tempDir, '.compass/state/manifest.json'), 'utf8'),
  );
  const project = parseSimpleYaml(
    await readFile(path.join(tempDir, '.compass/project.yaml'), 'utf8'),
    { sourceName: 'project.yaml' },
  );
  const target = project.sync?.default_target;
  return target ? manifest.sync?.targets?.[target] : manifest.sync;
}

test('sync-adopt re-baselines the cursor onto the hosted head after a clean preview', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-sync-adopt-'));
  try {
    await createConnectedRoot(tempDir);
    const mock = fetchMock({
      preview_token: 'pt-1',
      target_remote_revision_id: ADOPTED_HEAD,
      proposals: [],
      conflicts: [],
      warnings: [],
    });

    const stdout = [];
    const exitCode = await runCli(
      ['sync-adopt', '--root', path.join(tempDir, '.compass')],
      createIo(stdout),
      { cwd: tempDir, env: { VIBECOMPASS_SYNC_TOKEN: 'token' }, fetch: mock.fetch },
    );
    assert.equal(exitCode, 0);
    assert.match(stdout.join(''), /Adopted head: 99999999-8888-4777-a666-555555555555/);
    // D-215: the preview endpoint was consulted before adopting.
    assert.ok(mock.calls.some((call) => call.url.includes('/pull-preview')));

    const cursor = await readCursor(tempDir);
    assert.equal(cursor?.last_successful_remote_revision, ADOPTED_HEAD);
    assert.equal(cursor?.last_sync_direction, 'adopt');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('sync-adopt refuses on pending proposals unless --accept-divergence (D-215 inspect-then-choose)', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-sync-adopt-div-'));
  try {
    await createConnectedRoot(tempDir);
    const divergent = {
      preview_token: 'pt-2',
      target_remote_revision_id: ADOPTED_HEAD,
      proposals: [{ proposal_id: 'prop-1' }],
      conflicts: [],
      warnings: [],
    };

    await assert.rejects(
      () =>
        runCli(
          ['sync-adopt', '--root', path.join(tempDir, '.compass')],
          createIo(),
          { cwd: tempDir, env: { VIBECOMPASS_SYNC_TOKEN: 'token' }, fetch: fetchMock(divergent).fetch },
        ),
      /Refusing to adopt.*pull-preview/s,
    );

    const exitCode = await runCli(
      ['sync-adopt', '--root', path.join(tempDir, '.compass'), '--accept-divergence'],
      createIo(),
      { cwd: tempDir, env: { VIBECOMPASS_SYNC_TOKEN: 'token' }, fetch: fetchMock(divergent).fetch },
    );
    assert.equal(exitCode, 0);
    const cursor = await readCursor(tempDir);
    assert.equal(cursor?.last_successful_remote_revision, ADOPTED_HEAD);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
