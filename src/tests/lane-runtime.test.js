import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeProjectMemory } from '../init.js';
import { runCli } from '../cli.js';
import { closeProjectSession, readLaneEnvironment, startProjectSession } from '../session.js';
import {
  DEFAULT_LANE_PORT_BASE,
  assignLanePort,
  computeLaneTmpRootKey,
  defaultLaneTmpBase,
  removeLaneTmpDirAtClose,
  resolveRuntimeSettings,
} from '../lane-runtime.js';

const DOCUMENT_MAINTENANCE_UPDATED = {
  architectureDocs: 'updated',
  decisionLog: 'updated',
  sessionMaintenance: 'updated',
};
const CLOSE_DEFAULTS = {
  title: 'Lane Close',
  completed: ['Did the work'],
  nextSteps: ['Continue'],
  documentMaintenance: DOCUMENT_MAINTENANCE_UPDATED,
};

function hasGit() {
  return spawnSync('git', ['--version']).status === 0;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.toString().trim();
}

async function createGitRepoWithCommit(repoDir) {
  await mkdir(repoDir, { recursive: true });
  git(repoDir, ['init']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  await writeFile(path.join(repoDir, 'README.md'), 'hello\n', 'utf8');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'initial']);
  return git(repoDir, ['rev-parse', 'HEAD']);
}

async function createInitializedRoot(prefix, repos = [{ id: 'app', remote: 'https://github.com/example/app.git' }]) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const rootDir = path.join(tempDir, '.compass');
  await initializeProjectMemory({
    cwd: tempDir,
    rootDir,
    name: 'Lane Runtime Test',
    mode: 'local-only',
    repos,
    bootstrap: { workflow: true, claude: true },
  });
  return { tempDir, rootDir };
}

/** Appends a top-level `runtime:` block to project.yaml (D-282 overrides). */
async function appendRuntimeConfig(rootDir, entries) {
  const projectFilePath = path.join(rootDir, 'project.yaml');
  const lines = ['runtime:', ...Object.entries(entries).map(([key, value]) => `  ${key}: ${value}`), ''];
  await writeFile(projectFilePath, `${await readFile(projectFilePath, 'utf8')}${lines.join('\n')}`, 'utf8');
}

function createCaptureIo() {
  const stdout = [];
  const stderr = [];
  return {
    io: {
      stdout: { write(chunk) { stdout.push(chunk); } },
      stderr: { write(chunk) { stderr.push(chunk); } },
    },
    stdout,
    stderr,
  };
}

async function rewriteLaneTmpDir(rootDir, laneId, newValue) {
  const sessionFilePath = path.join(rootDir, 'sessions/active', laneId, 'session.yaml');
  const content = await readFile(sessionFilePath, 'utf8');
  const rewritten = content.replace(/^ {2}tmp_dir: .*$/m, `  tmp_dir: ${JSON.stringify(newValue)}`);
  assert.notEqual(rewritten, content, 'expected a tmp_dir line to rewrite');
  await writeFile(sessionFilePath, rewritten, 'utf8');
}

test('start-session assigns a lane runtime and records it end to end (D-282)', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-lane-runtime-');
  const rootKey = await computeLaneTmpRootKey(rootDir);
  const namespaceDir = path.join(defaultLaneTmpBase(), rootKey);

  try {
    const result = await startProjectSession({ cwd: tempDir, sessionId: 'lane-a', workingOn: 'Runtime work' });

    assert.equal(result.runtime.port, DEFAULT_LANE_PORT_BASE);
    assert.equal(result.runtime.tmpDir, path.join(namespaceDir, 'lane-a'));
    assert.equal(existsSync(result.runtime.tmpDir), true, 'lane temp dir created before first root write');

    const sessionYaml = await readFile(path.join(rootDir, 'sessions/active/lane-a/session.yaml'), 'utf8');
    assert.match(sessionYaml, /^runtime:$/m);
    assert.match(sessionYaml, new RegExp(`^ {2}port: ${DEFAULT_LANE_PORT_BASE}$`, 'm'));
    assert.ok(sessionYaml.includes(`  tmp_dir: ${JSON.stringify(result.runtime.tmpDir)}`));

    const manifest = JSON.parse(await readFile(path.join(rootDir, 'state/manifest.json'), 'utf8'));
    assert.deepEqual(manifest.active_sessions.lanes[0].runtime, {
      port: DEFAULT_LANE_PORT_BASE,
      tmp_dir: result.runtime.tmpDir,
    });
  } finally {
    await rm(namespaceDir, { recursive: true, force: true });
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('sibling lanes get distinct ports and temp dirs; a freed port is reused (D-282)', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-lane-runtime-');
  await appendRuntimeConfig(rootDir, { tmp_base: JSON.stringify(path.join(tempDir, 'lane-tmp')) });

  try {
    const laneA = await startProjectSession({ cwd: tempDir, sessionId: 'lane-a', workingOn: 'A' });
    const laneB = await startProjectSession({ cwd: tempDir, sessionId: 'lane-b', workingOn: 'B' });
    assert.equal(laneA.runtime.port, DEFAULT_LANE_PORT_BASE);
    assert.equal(laneB.runtime.port, DEFAULT_LANE_PORT_BASE + 1);
    assert.notEqual(laneA.runtime.tmpDir, laneB.runtime.tmpDir);
    assert.equal(path.basename(laneA.runtime.tmpDir), 'lane-a');
    assert.equal(path.basename(laneB.runtime.tmpDir), 'lane-b');

    await closeProjectSession({ cwd: tempDir, sessionId: 'lane-a', ...CLOSE_DEFAULTS });
    const laneC = await startProjectSession({ cwd: tempDir, sessionId: 'lane-c', workingOn: 'C' });
    assert.equal(laneC.runtime.port, DEFAULT_LANE_PORT_BASE, 'closing lane-a freed its port for the next lane');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('project.yaml runtime overrides port_base, port_step, and tmp_base (D-282)', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-lane-runtime-');
  const tmpBase = path.join(tempDir, 'lane-tmp');
  await appendRuntimeConfig(rootDir, { port_base: 4500, port_step: 10, tmp_base: JSON.stringify(tmpBase) });
  const rootKey = await computeLaneTmpRootKey(rootDir);

  try {
    const laneA = await startProjectSession({ cwd: tempDir, sessionId: 'lane-a', workingOn: 'A' });
    const laneB = await startProjectSession({ cwd: tempDir, sessionId: 'lane-b', workingOn: 'B' });
    assert.equal(laneA.runtime.port, 4500);
    assert.equal(laneB.runtime.port, 4510);
    assert.equal(laneA.runtime.tmpDir, path.join(tmpBase, rootKey, 'lane-a'));
    assert.equal(existsSync(laneA.runtime.tmpDir), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('invalid runtime settings warn and fall back to the D-282 defaults', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-lane-runtime-');
  await appendRuntimeConfig(rootDir, { port_base: 80, port_step: 0, tmp_base: JSON.stringify('relative/tmp'), color: '"blue"' });
  const rootKey = await computeLaneTmpRootKey(rootDir);
  const namespaceDir = path.join(defaultLaneTmpBase(), rootKey);

  try {
    const result = await startProjectSession({ cwd: tempDir, sessionId: 'lane-a', workingOn: 'A' });
    assert.equal(result.runtime.port, DEFAULT_LANE_PORT_BASE);
    assert.equal(result.runtime.tmpDir, path.join(namespaceDir, 'lane-a'));
    assert.ok(result.warnings.some((warning) => warning.includes('runtime.port_base')), 'port_base warning');
    assert.ok(result.warnings.some((warning) => warning.includes('runtime.port_step')), 'port_step warning');
    assert.ok(result.warnings.some((warning) => warning.includes('runtime.tmp_base')), 'tmp_base warning');
    assert.ok(result.warnings.some((warning) => warning.includes('runtime field "color"')), 'unknown-field warning');
  } finally {
    await rm(namespaceDir, { recursive: true, force: true });
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('close-session removes the recorded lane temp dir (D-282)', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-lane-runtime-');
  await appendRuntimeConfig(rootDir, { tmp_base: JSON.stringify(path.join(tempDir, 'lane-tmp')) });

  try {
    const started = await startProjectSession({ cwd: tempDir, sessionId: 'lane-a', workingOn: 'A' });
    await writeFile(path.join(started.runtime.tmpDir, 'scratch.txt'), 'build residue\n', 'utf8');

    const { io, stdout } = createCaptureIo();
    const exitCode = await runCli(
      ['close-session', '--session', 'lane-a', '--title', 'Lane Close', '--completed', 'Did the work', '--next-step', 'Continue', '--architecture-docs', 'updated', '--decision-log', 'updated', '--session-maintenance', 'updated'],
      io,
      { cwd: tempDir },
    );
    assert.equal(exitCode, 0);
    assert.equal(existsSync(started.runtime.tmpDir), false, 'temp dir removed at close');
    assert.ok(stdout.join('').includes(`Lane temp dir: removed ${started.runtime.tmpDir}`));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('close-session keeps a lane temp dir the cwd sits inside (D-282)', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-lane-runtime-');
  await appendRuntimeConfig(rootDir, { tmp_base: JSON.stringify(path.join(tempDir, 'lane-tmp')) });

  try {
    const started = await startProjectSession({ cwd: tempDir, sessionId: 'lane-a', workingOn: 'A' });
    const result = await closeProjectSession({
      cwd: started.runtime.tmpDir,
      rootDir,
      sessionId: 'lane-a',
      ...CLOSE_DEFAULTS,
    });
    assert.equal(result.runtimeCleanup.removed, false);
    assert.equal(result.runtimeCleanup.reason, 'cwd-inside');
    assert.equal(existsSync(started.runtime.tmpDir), true, 'temp dir survives while cwd is inside it');
    assert.ok(result.warnings.some((warning) => warning.includes('current working directory is inside it')));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('close-session keeps a recorded temp dir outside the lane namespace (D-282 guarded removal)', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-lane-runtime-');
  await appendRuntimeConfig(rootDir, { tmp_base: JSON.stringify(path.join(tempDir, 'lane-tmp')) });

  try {
    await startProjectSession({ cwd: tempDir, sessionId: 'lane-a', workingOn: 'A' });
    const decoyDir = path.join(tempDir, 'decoy', 'lane-a');
    await mkdir(decoyDir, { recursive: true });
    await writeFile(path.join(decoyDir, 'precious.txt'), 'do not delete\n', 'utf8');
    await rewriteLaneTmpDir(rootDir, 'lane-a', decoyDir);

    const result = await closeProjectSession({ cwd: tempDir, sessionId: 'lane-a', ...CLOSE_DEFAULTS });
    assert.equal(result.runtimeCleanup.removed, false);
    assert.equal(result.runtimeCleanup.reason, 'outside-namespace');
    assert.equal(existsSync(path.join(decoyDir, 'precious.txt')), true, 'decoy dir untouched');
    assert.ok(result.warnings.some((warning) => warning.includes('lane temp namespace')));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('close-session removes the lane temp dir even after runtime.tmp_base changed (D-282 env/tmp_base independence)', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-lane-runtime-');
  const startBase = path.join(tempDir, 'lane-tmp-a');
  await appendRuntimeConfig(rootDir, { tmp_base: JSON.stringify(startBase) });

  try {
    const started = await startProjectSession({ cwd: tempDir, sessionId: 'lane-a', workingOn: 'A' });
    assert.equal(started.runtime.tmpDir.startsWith(startBase), true);
    // Reconfigure tmp_base after the lane recorded its path. The close-time
    // guard must key off the recorded <root-key>/<lane-id> tail, not a
    // recomputed <tmp_base>/<root-key> — otherwise the dir would be stranded.
    const projectFilePath = path.join(rootDir, 'project.yaml');
    const rewritten = (await readFile(projectFilePath, 'utf8')).replace(
      new RegExp(`  tmp_base: .*`),
      `  tmp_base: ${JSON.stringify(path.join(tempDir, 'lane-tmp-b'))}`,
    );
    await writeFile(projectFilePath, rewritten, 'utf8');

    const result = await closeProjectSession({ cwd: tempDir, sessionId: 'lane-a', ...CLOSE_DEFAULTS });
    assert.equal(result.runtimeCleanup.removed, true, 'temp dir removed despite the tmp_base change');
    assert.equal(existsSync(started.runtime.tmpDir), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('removeLaneTmpDirAtClose keys off the recorded root-key/lane-id tail (D-282 unit)', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-tmp-guard-'));
  try {
    const rootKey = 'abc123def456';
    const good = path.join(tempDir, 'anywhere', rootKey, 'lane-a');
    await mkdir(good, { recursive: true });
    // Correct tail removes regardless of where the namespace physically lives.
    const removed = await removeLaneTmpDirAtClose({ recordedTmpDir: good, laneId: 'lane-a', rootKey, cwd: tempDir });
    assert.equal(removed.removed, true);
    assert.equal(existsSync(good), false);

    // Wrong root key (different root) is refused.
    const foreignRoot = path.join(tempDir, 'x', 'ffffffffffff', 'lane-a');
    await mkdir(foreignRoot, { recursive: true });
    const keptRoot = await removeLaneTmpDirAtClose({ recordedTmpDir: foreignRoot, laneId: 'lane-a', rootKey, cwd: tempDir });
    assert.equal(keptRoot.removed, false);
    assert.equal(keptRoot.reason, 'outside-namespace');
    assert.equal(existsSync(foreignRoot), true);

    // Wrong lane id is refused.
    const wrongLane = path.join(tempDir, 'y', rootKey, 'lane-b');
    await mkdir(wrongLane, { recursive: true });
    const keptLane = await removeLaneTmpDirAtClose({ recordedTmpDir: wrongLane, laneId: 'lane-a', rootKey, cwd: tempDir });
    assert.equal(keptLane.removed, false);
    assert.equal(keptLane.reason, 'lane-id-mismatch');

    // Relative path and missing path.
    assert.equal((await removeLaneTmpDirAtClose({ recordedTmpDir: 'rel/lane-a', laneId: 'lane-a', rootKey, cwd: tempDir })).reason, 'not-absolute');
    assert.equal((await removeLaneTmpDirAtClose({ recordedTmpDir: path.join(tempDir, 'gone', rootKey, 'lane-a'), laneId: 'lane-a', rootKey, cwd: tempDir })).reason, 'missing');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('close-session refuses a relative recorded temp dir outright (D-282)', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-lane-runtime-');
  await appendRuntimeConfig(rootDir, { tmp_base: JSON.stringify(path.join(tempDir, 'lane-tmp')) });

  try {
    await startProjectSession({ cwd: tempDir, sessionId: 'lane-a', workingOn: 'A' });
    await rewriteLaneTmpDir(rootDir, 'lane-a', 'relative/lane-a');

    const result = await closeProjectSession({ cwd: tempDir, sessionId: 'lane-a', ...CLOSE_DEFAULTS });
    assert.equal(result.runtimeCleanup.removed, false);
    assert.equal(result.runtimeCleanup.reason, 'not-absolute');
    assert.ok(result.warnings.some((warning) => warning.includes('not absolute')));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('a recorded-but-missing lane temp dir is benign at close (D-282)', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-lane-runtime-');
  await appendRuntimeConfig(rootDir, { tmp_base: JSON.stringify(path.join(tempDir, 'lane-tmp')) });

  try {
    const started = await startProjectSession({ cwd: tempDir, sessionId: 'lane-a', workingOn: 'A' });
    await rm(started.runtime.tmpDir, { recursive: true, force: true });

    const { io, stdout } = createCaptureIo();
    const exitCode = await runCli(
      ['close-session', '--session', 'lane-a', '--title', 'Lane Close', '--completed', 'Did the work', '--next-step', 'Continue', '--architecture-docs', 'updated', '--decision-log', 'updated', '--session-maintenance', 'updated'],
      io,
      { cwd: tempDir },
    );
    assert.equal(exitCode, 0);
    assert.equal(stdout.join('').includes('Lane temp dir:'), false, 'missing dir prints no cleanup line');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('a pre-S4 lane without a runtime block closes exactly as before (D-282)', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-lane-runtime-');
  await appendRuntimeConfig(rootDir, { tmp_base: JSON.stringify(path.join(tempDir, 'lane-tmp')) });

  try {
    await startProjectSession({ cwd: tempDir, sessionId: 'lane-a', workingOn: 'A' });
    const sessionFilePath = path.join(rootDir, 'sessions/active/lane-a/session.yaml');
    const content = await readFile(sessionFilePath, 'utf8');
    const stripped = content.replace(/^runtime:\r?\n(?:[ \t]+.*\r?\n?)*/m, '');
    assert.notEqual(stripped, content, 'expected to strip a runtime block');
    await writeFile(sessionFilePath, stripped, 'utf8');

    const result = await closeProjectSession({ cwd: tempDir, sessionId: 'lane-a', ...CLOSE_DEFAULTS });
    assert.equal(result.runtimeCleanup, null, 'no runtime cleanup is attempted for a pre-S4 lane');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('lane-env exports the lane runtime with conventional aliases (D-282)', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-lane-runtime-');
  await appendRuntimeConfig(rootDir, { tmp_base: JSON.stringify(path.join(tempDir, 'lane-tmp')) });

  try {
    const { io: startIo, stdout: startStdout } = createCaptureIo();
    await runCli(['start-session', '--id', 'lane-a', '--working-on', 'Runtime work'], startIo, { cwd: tempDir });
    assert.match(startStdout.join(''), /Runtime: port \d+, temp dir /, 'start-session prints the assignment');

    const { io, stdout } = createCaptureIo();
    const exitCode = await runCli(['lane-env'], io, { cwd: tempDir });
    assert.equal(exitCode, 0);
    const output = stdout.join('');
    assert.ok(output.includes("export VIBECOMPASS_LANE_ID='lane-a'"));
    assert.match(output, /export VIBECOMPASS_LANE_PORT='\d+'/);
    assert.match(output, /export VIBECOMPASS_LANE_TMPDIR='[^']+lane-a'/);
    assert.match(output, /export PORT='\d+'/);
    assert.match(output, /export TMPDIR='[^']+'/);

    const { io: bareIo, stdout: bareStdout } = createCaptureIo();
    await runCli(['lane-env', '--no-conventional'], bareIo, { cwd: tempDir });
    const bareOutput = bareStdout.join('');
    assert.equal(/^export PORT=/m.test(bareOutput), false, '--no-conventional omits PORT');
    assert.equal(/^export TMPDIR=/m.test(bareOutput), false, '--no-conventional omits TMPDIR');

    const { io: jsonIo, stdout: jsonStdout } = createCaptureIo();
    await runCli(['lane-env', '--json'], jsonIo, { cwd: tempDir });
    const parsed = JSON.parse(jsonStdout.join(''));
    assert.equal(parsed.lane_id, 'lane-a');
    assert.equal(typeof parsed.port, 'number');
    assert.equal(parsed.env.PORT, String(parsed.port));
    assert.equal(parsed.env.VIBECOMPASS_LANE_TMPDIR, parsed.tmp_dir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('lane-env requires an explicit selection at 2+ lanes and accepts --session (D-277)', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-lane-runtime-');
  await appendRuntimeConfig(rootDir, { tmp_base: JSON.stringify(path.join(tempDir, 'lane-tmp')) });

  try {
    await startProjectSession({ cwd: tempDir, sessionId: 'lane-a', workingOn: 'A' });
    await startProjectSession({ cwd: tempDir, sessionId: 'lane-b', workingOn: 'B' });

    await assert.rejects(readLaneEnvironment({ cwd: tempDir }), /Multiple active session lanes exist/);

    const result = await readLaneEnvironment({ cwd: tempDir, sessionId: 'lane-b' });
    assert.equal(result.sessionId, 'lane-b');
    assert.equal(result.env.VIBECOMPASS_LANE_ID, 'lane-b');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('lane-env fails actionably for a lane without a recorded runtime assignment', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-lane-runtime-');
  await appendRuntimeConfig(rootDir, { tmp_base: JSON.stringify(path.join(tempDir, 'lane-tmp')) });

  try {
    await startProjectSession({ cwd: tempDir, sessionId: 'lane-a', workingOn: 'A' });
    const sessionFilePath = path.join(rootDir, 'sessions/active/lane-a/session.yaml');
    const stripped = (await readFile(sessionFilePath, 'utf8')).replace(/^runtime:\r?\n(?:[ \t]+.*\r?\n?)*/m, '');
    await writeFile(sessionFilePath, stripped, 'utf8');

    await assert.rejects(readLaneEnvironment({ cwd: tempDir }), /no recorded runtime assignment/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('a failed git provisioning also unwinds the lane temp dir (D-281/D-282)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-lane-runtime-rollback-');
  const tmpBase = path.join(tempDir, 'lane-tmp');
  await appendRuntimeConfig(rootDir, { tmp_base: JSON.stringify(tmpBase) });
  const rootKey = await computeLaneTmpRootKey(rootDir);

  try {
    await createGitRepoWithCommit(path.join(tempDir, 'app'));
    const hookPath = path.join(tempDir, 'app', '.git', 'hooks', 'post-checkout');
    await writeFile(hookPath, '#!/bin/sh\nexit 1\n', 'utf8');
    await chmod(hookPath, 0o755);

    await assert.rejects(
      startProjectSession({
        cwd: tempDir,
        sessionId: 'lane-a',
        workingOn: 'Doomed work',
        repos: ['app'],
        branch: 'feat',
        worktree: true,
      }),
      /rolled back and lane "lane-a" was not created/,
    );

    assert.equal(existsSync(path.join(tmpBase, rootKey, 'lane-a')), false, 'lane temp dir unwound with the rollback');
    assert.equal(existsSync(path.join(rootDir, 'sessions/active/lane-a')), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('assignLanePort skips ports recorded by parseable siblings only (unit)', () => {
  assert.equal(assignLanePort({ existingLanes: [], portBase: 3100, portStep: 1 }), 3100);
  assert.equal(
    assignLanePort({
      existingLanes: [
        { runtime: { port: 3100 } },
        { runtime: null },
        { runtime: { port: 3102 } },
      ],
      portBase: 3100,
      portStep: 1,
    }),
    3101,
  );
  assert.throws(
    () => assignLanePort({ existingLanes: [{ runtime: { port: 65535 } }], portBase: 65535, portStep: 1 }),
    /No free lane port/,
  );
});

test('resolveRuntimeSettings validates overrides and reports every problem (unit)', () => {
  const defaults = resolveRuntimeSettings(null);
  assert.equal(defaults.portBase, DEFAULT_LANE_PORT_BASE);
  assert.equal(defaults.warnings.length, 0);
  assert.equal(defaults.tmpBase, defaultLaneTmpBase());

  const invalid = resolveRuntimeSettings({ runtime: { port_base: '3200', port_step: -1, tmp_base: 42, extra: true } });
  assert.equal(invalid.portBase, DEFAULT_LANE_PORT_BASE);
  assert.equal(invalid.warnings.length, 4);

  const valid = resolveRuntimeSettings({ runtime: { port_base: 4000, port_step: 5, tmp_base: path.join(os.tmpdir(), 'custom') } });
  assert.deepEqual([valid.portBase, valid.portStep, valid.tmpBase], [4000, 5, path.join(os.tmpdir(), 'custom')]);
  assert.equal(valid.warnings.length, 0);
});
