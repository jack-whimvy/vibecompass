import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { runCli } from '../cli.js';
import { initializeProjectMemory } from '../init.js';

const HEAD_ID = '77777777-6666-4555-a444-333333333333';

function createIo(stdout = [], stderr = []) {
  return {
    stdout: { write(chunk) { stdout.push(chunk); } },
    stderr: { write(chunk) { stderr.push(chunk); } },
  };
}

/** URL-dispatching fetch mock simulating the hosted transition endpoints. */
function hostedMock(initialMode) {
  const state = { mode: initialMode, pending: null };
  const calls = [];
  const json = (body) => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  return {
    state,
    calls,
    fetch: async (url, init = {}) => {
      calls.push({ url, method: init.method ?? 'GET' });
      if (url.includes('/status')) {
        return json({
          mode: state.mode,
          current_remote_revision_id: state.mode ? HEAD_ID : null,
          current_manifest_hash: 'sha256:server-head',
          pending_mode_transition: state.pending,
        });
      }
      if (url.includes('/push')) {
        return json({
          status: 'completed',
          run_id: 'run-1',
          remote_revision_id: HEAD_ID,
          applied_proposal_ids: [],
          stale_proposal_ids: [],
        });
      }
      if (url.includes('/mode-transition')) {
        const body = JSON.parse(init.body);
        if (body.action === 'begin') {
          state.pending = { target_mode: body.target_mode, initiated_at: 'now', base_remote_revision_id: HEAD_ID };
          return json({
            phase: 'pending',
            target_mode: body.target_mode,
            completeness: {
              documents_by_kind: { project: 1, architecture: 2 },
              carries_over: 'All canonical documents at the current hosted head (project.yaml, architecture, decisions, session notes).',
              does_not_carry_over: ['Active lane scratch under sessions/active/ — local-only by design (D-278); close or finalize lanes before promoting.'],
            },
          });
        }
        if (body.action === 'confirm') {
          state.mode = body.target_mode;
          state.pending = null;
          return json({ phase: 'confirmed', mode: state.mode });
        }
        state.pending = null;
        return json({ phase: 'aborted' });
      }
      if (url.includes('/pull-preview')) {
        return json({
          preview_token: 'pt',
          target_remote_revision_id: HEAD_ID,
          proposals: [],
          conflicts: [],
          warnings: [],
        });
      }
      throw new Error(`Unexpected URL in mock: ${url}`);
    },
  };
}

async function createConnectedRoot(tempDir) {
  await initializeProjectMemory({
    cwd: tempDir,
    rootDir: '.compass',
    name: 'Cutover Fixture',
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
      'proj-cutover',
      '--sync-credential-env-var',
      'VIBECOMPASS_SYNC_TOKEN',
    ],
    createIo(),
    { cwd: tempDir, env: {} },
  );
  assert.equal(exitCode, 0);
}

test('promote-hosted runs the two-phase cutover, demarcates the root, and demote-hosted reverses it', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-cutover-'));
  const rootDir = path.join(tempDir, '.compass');
  try {
    await createConnectedRoot(tempDir);
    const mock = hostedMock('local-primary');
    const env = { VIBECOMPASS_SYNC_TOKEN: 'token' };

    const stdout = [];
    const exitCode = await runCli(
      ['promote-hosted', '--root', rootDir],
      createIo(stdout),
      { cwd: tempDir, env, fetch: mock.fetch },
    );
    assert.equal(exitCode, 0);
    const output = stdout.join('');
    assert.match(output, /Mode transition: promoted/);
    assert.match(output, /Does not carry over:/);
    assert.match(output, /sessions\/active/);

    const projectYaml = await readFile(path.join(rootDir, 'project.yaml'), 'utf8');
    assert.match(projectYaml, /^mode: hosted-only$/m);
    await access(path.join(rootDir, 'state', 'promoted-root.json'));
    assert.equal(mock.state.mode, 'hosted-only');
    assert.equal(mock.state.pending, null);

    // D-288/Q7: the promoted root hard-refuses canonical write commands...
    await assert.rejects(
      () =>
        runCli(
          ['start-session', '--id', 'test-lane', '--working-on', 'anything', '--root', rootDir],
          createIo(),
          { cwd: tempDir, env },
        ),
      /promoted to hosted-only/,
    );
    // ...unless deliberately overridden.
    const overrideEnvBackup = process.env.VIBECOMPASS_ALLOW_PROMOTED_ROOT_WRITES;
    process.env.VIBECOMPASS_ALLOW_PROMOTED_ROOT_WRITES = '1';
    try {
      // With the override, execution gets PAST the promoted-root guard and
      // fails on an unrelated fixture gap (no CLAUDE.md) — proving the guard
      // (and only the guard) was bypassed.
      await assert.rejects(
        () =>
          runCli(
            ['start-session', '--id', 'test-lane', '--working-on', 'override check', '--root', rootDir],
            createIo(),
            { cwd: tempDir, env },
          ),
        /No CLAUDE\.md/,
      );
    } finally {
      if (overrideEnvBackup === undefined) {
        delete process.env.VIBECOMPASS_ALLOW_PROMOTED_ROOT_WRITES;
      } else {
        process.env.VIBECOMPASS_ALLOW_PROMOTED_ROOT_WRITES = overrideEnvBackup;
      }
    }

    // Re-running promote on an already-promoted project is a no-op success.
    const rerun = [];
    const rerunExit = await runCli(
      ['promote-hosted', '--root', rootDir],
      createIo(rerun),
      { cwd: tempDir, env, fetch: mock.fetch },
    );
    assert.equal(rerunExit, 0);
    assert.match(rerun.join(''), /already-promoted/);

    // Demote reverses the cutover and re-baselines the cursor.
    const demoteOut = [];
    const demoteExit = await runCli(
      ['demote-hosted', '--root', rootDir],
      createIo(demoteOut),
      { cwd: tempDir, env, fetch: mock.fetch },
    );
    assert.equal(demoteExit, 0);
    assert.match(demoteOut.join(''), /Mode transition: demoted/);
    const demotedYaml = await readFile(path.join(rootDir, 'project.yaml'), 'utf8');
    assert.match(demotedYaml, /^mode: local-primary$/m);
    await assert.rejects(() => access(path.join(rootDir, 'state', 'promoted-root.json')));
    assert.equal(mock.state.mode, 'local-primary');

    const manifest = JSON.parse(
      await readFile(path.join(rootDir, 'state', 'manifest.json'), 'utf8'),
    );
    const cursor = manifest.sync?.targets
      ? Object.values(manifest.sync.targets)[0]
      : manifest.sync;
    assert.equal(cursor?.last_successful_remote_revision, HEAD_ID);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('promote-hosted --abort restores both sides after an interrupted cutover', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-cutover-abort-'));
  const rootDir = path.join(tempDir, '.compass');
  try {
    await createConnectedRoot(tempDir);
    const mock = hostedMock('local-primary');
    const env = { VIBECOMPASS_SYNC_TOKEN: 'token' };

    // Simulate an interruption: begin recorded + local mode flipped, no confirm.
    mock.state.pending = { target_mode: 'hosted-only', initiated_at: 'now', base_remote_revision_id: HEAD_ID };
    const raw = await readFile(path.join(rootDir, 'project.yaml'), 'utf8');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      path.join(rootDir, 'project.yaml'),
      raw.replace(/^mode: local-primary$/m, 'mode: hosted-only'),
      'utf8',
    );

    const stdout = [];
    const exitCode = await runCli(
      ['promote-hosted', '--abort', '--root', rootDir],
      createIo(stdout),
      { cwd: tempDir, env, fetch: mock.fetch },
    );
    assert.equal(exitCode, 0);
    assert.match(stdout.join(''), /Mode transition: aborted/);
    const restored = await readFile(path.join(rootDir, 'project.yaml'), 'utf8');
    assert.match(restored, /^mode: local-primary$/m);
    assert.equal(mock.state.pending, null);
    assert.equal(mock.state.mode, 'local-primary');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('promote-hosted --abort refuses after the server has confirmed (no split-brain rewrite)', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-cutover-late-abort-'));
  const rootDir = path.join(tempDir, '.compass');
  try {
    await createConnectedRoot(tempDir);
    const mock = hostedMock('local-primary');
    const env = { VIBECOMPASS_SYNC_TOKEN: 'token' };

    const exitCode = await runCli(
      ['promote-hosted', '--root', rootDir],
      createIo(),
      { cwd: tempDir, env, fetch: mock.fetch },
    );
    assert.equal(exitCode, 0);
    assert.equal(mock.state.mode, 'hosted-only');

    // The cutover is confirmed: abort must refuse instead of rewriting only
    // the local record back to local-primary.
    await assert.rejects(
      () =>
        runCli(
          ['promote-hosted', '--abort', '--root', rootDir],
          createIo(),
          { cwd: tempDir, env, fetch: mock.fetch },
        ),
      /already confirmed[\s\S]*demote-hosted/,
    );
    const projectYaml = await readFile(path.join(rootDir, 'project.yaml'), 'utf8');
    assert.match(projectYaml, /^mode: hosted-only$/m);
    await access(path.join(rootDir, 'state', 'promoted-root.json'));
    assert.equal(mock.state.mode, 'hosted-only');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('hosted-only exported root: connect-hosted then demote-hosted is the executable documented sequence', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-cutover-demote-path-'));
  const rootDir = path.join(tempDir, '.compass');
  try {
    // Simulate a bootstrap-restored hosted-only root: no sync binding yet
    // (dashboard-created project.yaml stubs carry none).
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir: '.compass',
      name: 'Exported Hosted Fixture',
      mode: 'hosted-only',
      repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
    });
    const mock = hostedMock('hosted-only');
    const env = { VIBECOMPASS_SYNC_TOKEN: 'token' };

    // Without a binding, demote names the missing step instead of a dead end.
    await assert.rejects(
      () =>
        runCli(['demote-hosted', '--root', rootDir], createIo(), {
          cwd: tempDir,
          env,
          fetch: mock.fetch,
        }),
      /connect-hosted/,
    );

    // Step 1 of the documented sequence: bind the root to the hosted project.
    const connectExit = await runCli(
      [
        'connect-hosted',
        '--root',
        rootDir,
        '--sync-api-url',
        'https://vibecompass.example',
        '--sync-project-id',
        'proj-demote',
        '--sync-credential-env-var',
        'VIBECOMPASS_SYNC_TOKEN',
      ],
      createIo(),
      { cwd: tempDir, env: {} },
    );
    assert.equal(connectExit, 0);
    // connect-hosted must not change hosted-only mode (passthrough).
    assert.match(
      await readFile(path.join(rootDir, 'project.yaml'), 'utf8'),
      /^mode: hosted-only$/m,
    );

    // Step 2: demote flips both records and adopts the head cursor.
    const stdout = [];
    const demoteExit = await runCli(
      ['demote-hosted', '--root', rootDir],
      createIo(stdout),
      { cwd: tempDir, env, fetch: mock.fetch },
    );
    assert.equal(demoteExit, 0);
    assert.match(stdout.join(''), /Mode transition: demoted/);
    assert.match(
      await readFile(path.join(rootDir, 'project.yaml'), 'utf8'),
      /^mode: local-primary$/m,
    );
    assert.equal(mock.state.mode, 'local-primary');

    const manifest = JSON.parse(
      await readFile(path.join(rootDir, 'state', 'manifest.json'), 'utf8'),
    );
    const cursor = manifest.sync?.targets
      ? Object.values(manifest.sync.targets)[0]
      : manifest.sync;
    assert.equal(cursor?.last_successful_remote_revision, HEAD_ID);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
