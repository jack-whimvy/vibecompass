import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeProjectMemory } from '../init.js';
import { planDocsUpdate } from '../docs-update.js';
import { buildNonInteractiveGitEnv } from '../git-binding.js';
import { startProjectSession } from '../session.js';

// Where start-session cuts a new lane branch: the checkout's HEAD, or its
// upstream's tip when HEAD is behind it, after an isolated, non-interactive
// fetch that may fail (D-411 item 1).

function hasGit() {
  return spawnSync('git', ['--version']).status === 0;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.toString().trim();
}

function gitStatus(cwd, args) {
  return spawnSync('git', args, { cwd }).status;
}

function configureUser(repoDir) {
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
}

async function commit(repoDir, message) {
  await writeFile(path.join(repoDir, `${message}.txt`), `${message}\n`, 'utf8');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-q', '-m', message]);
  return git(repoDir, ['rev-parse', 'HEAD']);
}

/**
 * A workspace with an initialized root, a bare `origin`, a `seed` clone that
 * pushes to it, and the bound repo `app`, cloned from origin on `main`.
 */
async function createWorkspace(prefix) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const rootDir = path.join(tempDir, '.compass');
  await initializeProjectMemory({
    cwd: tempDir,
    rootDir,
    name: 'Start Point Test',
    mode: 'local-only',
    repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
    bootstrap: { workflow: true, claude: true },
  });

  const origin = path.join(tempDir, 'origin.git');
  git(tempDir, ['init', '-q', '--bare', origin]);
  git(origin, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const seed = path.join(tempDir, 'seed');
  git(tempDir, ['clone', '-q', origin, seed]);
  configureUser(seed);
  git(seed, ['checkout', '-q', '-B', 'main']);
  const base = await commit(seed, 'base');
  git(seed, ['push', '-q', 'origin', 'main']);
  const appDir = path.join(tempDir, 'app');
  git(tempDir, ['clone', '-q', origin, appDir]);
  configureUser(appDir);

  return { tempDir, rootDir, origin, seed, appDir, base };
}

async function pushFromSeed(seed, message) {
  const tip = await commit(seed, message);
  git(seed, ['push', '-q', 'origin', 'main']);
  return tip;
}

function startLane(tempDir, extra = {}) {
  return startProjectSession({
    cwd: tempDir,
    sessionId: 'lane-a',
    workingOn: 'Start point',
    repos: ['app'],
    branch: 'lane-a',
    worktree: true,
    ...extra,
  });
}

function startPointWarnings(result) {
  return result.warnings.filter((warning) => warning.startsWith('Repo "app":'));
}

async function readBaseRevision(rootDir) {
  const sessionYaml = await readFile(path.join(rootDir, 'sessions/active/lane-a/session.yaml'), 'utf8');
  return sessionYaml.match(/^ {2}app: "([0-9a-f]+)"$/m)?.[1] ?? null;
}

// Runs fn with process.env changed, then restores it: an empty global git
// config and no system config, so the user's own settings can't reach a test.
async function withIsolatedGitEnv(tempDir, changes, fn) {
  const globalConfig = path.join(tempDir, 'empty-gitconfig');
  await writeFile(globalConfig, '', 'utf8');
  const all = { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', ...changes };
  const saved = Object.fromEntries(Object.keys(all).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(all)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('a new lane branch starts at the upstream when local main is behind it and not yet fetched; local main is left alone', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }
  const { tempDir, rootDir, seed, appDir, base } = await createWorkspace('vibecompass-start-behind-');
  try {
    const remoteTip = await pushFromSeed(seed, 'remote-only');
    assert.equal(git(appDir, ['rev-parse', 'origin/main']), base, 'the checkout has not fetched the new commit');

    const result = await startLane(tempDir);

    assert.equal(git(appDir, ['rev-parse', 'refs/heads/lane-a']), remoteTip);
    assert.equal(await readBaseRevision(rootDir), remoteTip, 'base_revisions records the start point');
    assert.equal(git(appDir, ['rev-parse', 'refs/heads/main']), base, 'local main was left unchanged');
    assert.equal(git(appDir, ['rev-parse', 'origin/main']), remoteTip, 'the fetch updated the tracking ref');
    assert.deepEqual(startPointWarnings(result), [
      `Repo "app": local main is 1 commit behind origin/main, so the lane branch starts at origin/main (${remoteTip.slice(0, 12)}). Local main was left unchanged.`,
    ]);

    // The checkout is behind the lane's base, so nothing landed the lane lacks.
    const plan = await planDocsUpdate({ cwd: tempDir, rootDir, sessionId: 'lane-a' });
    assert.ok(!plan.staleness.entries.some((entry) => entry.startsWith('Base revision for repo "app"')), plan.staleness.entries.join('\n'));

    // A commit on local main that the lane doesn't have is staleness again.
    await commit(appDir, 'local-after-start');
    const later = await planDocsUpdate({ cwd: tempDir, rootDir, sessionId: 'lane-a' });
    assert.ok(later.staleness.entries.some((entry) => entry.startsWith('Base revision for repo "app" is stale')));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('a new lane branch starts at the upstream when local main is behind its fetched tracking ref', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }
  const { tempDir, seed, appDir, base } = await createWorkspace('vibecompass-start-fetched-');
  try {
    const remoteTip = await pushFromSeed(seed, 'remote-only');
    git(appDir, ['fetch', '-q']);

    const result = await startLane(tempDir);

    assert.equal(git(appDir, ['rev-parse', 'refs/heads/lane-a']), remoteTip);
    assert.equal(git(appDir, ['rev-parse', 'refs/heads/main']), base);
    assert.equal(startPointWarnings(result).length, 1);
    assert.match(startPointWarnings(result)[0], /local main is 1 commit behind origin\/main/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('a new lane branch starts at local main when it is ahead of its upstream, and says it includes the local commits', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }
  const { tempDir, appDir } = await createWorkspace('vibecompass-start-ahead-');
  try {
    await commit(appDir, 'local-one');
    const localTip = await commit(appDir, 'local-two');

    const result = await startLane(tempDir);

    assert.equal(git(appDir, ['rev-parse', 'refs/heads/lane-a']), localTip);
    assert.deepEqual(startPointWarnings(result), [
      `Repo "app": local main is 2 commits ahead of origin/main; the lane branch starts at local main (${localTip.slice(0, 12)}) and includes them.`,
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('a new lane branch starts at local main when it has diverged from its upstream, with both counts and the way to include the upstream', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }
  const { tempDir, seed, appDir } = await createWorkspace('vibecompass-start-diverged-');
  try {
    await pushFromSeed(seed, 'remote-only');
    const localTip = await commit(appDir, 'local-only');

    const result = await startLane(tempDir);

    assert.equal(git(appDir, ['rev-parse', 'refs/heads/lane-a']), localTip);
    assert.deepEqual(startPointWarnings(result), [
      `Repo "app": local main and origin/main have diverged (1 commit only on local main, 1 commit only on origin/main); the lane branch starts at local main (${localTip.slice(0, 12)}). If the lane should include origin/main's commits, reconcile main and fast-forward the lane branch before any edit.`,
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('a repo with no remote starts the lane at HEAD with no start-point message', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-start-noremote-'));
  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir: path.join(tempDir, '.compass'),
      name: 'Start Point Test',
      mode: 'local-only',
      repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
      bootstrap: { workflow: true, claude: true },
    });
    const appDir = path.join(tempDir, 'app');
    await mkdir(appDir);
    git(appDir, ['init', '-q']);
    configureUser(appDir);
    const head = await commit(appDir, 'only');

    const result = await startLane(tempDir);

    assert.equal(git(appDir, ['rev-parse', 'refs/heads/lane-a']), head);
    assert.deepEqual(startPointWarnings(result), []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('a fetch that fails falls back to the upstream as last fetched and says the remote could not be reached', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }
  const { tempDir, seed, appDir, base } = await createWorkspace('vibecompass-start-offline-');
  try {
    const fetchedTip = await pushFromSeed(seed, 'fetched-earlier');
    git(appDir, ['fetch', '-q']);
    await pushFromSeed(seed, 'never-fetched');
    git(appDir, ['remote', 'set-url', 'origin', path.join(tempDir, 'missing.git')]);

    const result = await startLane(tempDir);

    const warnings = startPointWarnings(result);
    assert.equal(warnings.length, 2, warnings.join('\n'));
    assert.match(warnings[0], /^Repo "app": could not reach origin to update origin\/main \(.+\); comparing with origin\/main as last fetched\.$/);
    assert.match(warnings[1], /local main is 1 commit behind origin\/main, so the lane branch starts at origin\/main/);
    assert.equal(git(appDir, ['rev-parse', 'refs/heads/lane-a']), fetchedTip, 'the last-fetched tip, not the unreachable one');
    assert.equal(git(appDir, ['rev-parse', 'refs/heads/main']), base);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('a fetch past its time limit is stopped, process group and all, and the lane still starts', async (t) => {
  if (!hasGit() || process.platform === 'win32') {
    t.skip('git and a POSIX shell are required.');
    return;
  }
  const { tempDir, appDir, base } = await createWorkspace('vibecompass-start-timeout-');
  const pidFile = path.join(tempDir, 'ssh-pids.txt');
  try {
    // Each run of the stand-in SSH records its pid, then becomes a 30-second sleep.
    const hangingSsh = path.join(tempDir, 'hanging-ssh.sh');
    await writeFile(hangingSsh, `#!/bin/sh\necho $$ >> '${pidFile}'\nexec sleep 30\n`, 'utf8');
    await chmod(hangingSsh, 0o755);
    git(appDir, ['remote', 'set-url', 'origin', 'ssh://git@example.invalid/app.git']);

    const started = Date.now();
    const result = await withIsolatedGitEnv(tempDir, { GIT_SSH_COMMAND: hangingSsh }, () =>
      startLane(tempDir, { upstreamFetchTimeoutMs: 1000 }));
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 10000, `start-session took ${elapsed} ms`);
    // Killing git alone would leave its SSH child running; the whole group goes.
    const pids = (await readFile(pidFile, 'utf8')).split('\n').filter(Boolean).map(Number);
    assert.ok(pids.length > 0, 'the stand-in SSH ran');
    for (const pid of pids) {
      assert.equal(await waitForProcessExit(pid, 3000), true, `process ${pid} from the fetch is still running`);
    }
    assert.equal(git(appDir, ['rev-parse', 'refs/heads/lane-a']), base);
    assert.deepEqual(startPointWarnings(result), [
      'Repo "app": could not reach origin to update origin/main (no answer within 1 second); comparing with origin/main as last fetched.',
    ]);
  } finally {
    // Never leave a stand-in running, whatever the assertions found.
    const pids = await readFile(pidFile, 'utf8').then((text) => text.split('\n').filter(Boolean).map(Number), () => []);
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') {
        return true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test('an existing branch is reused as it is, and nothing is fetched for it', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }
  const { tempDir, seed, appDir, base } = await createWorkspace('vibecompass-start-reuse-');
  try {
    git(appDir, ['branch', 'lane-a']);
    await pushFromSeed(seed, 'remote-only');

    const result = await startLane(tempDir);

    assert.equal(git(appDir, ['rev-parse', 'refs/heads/lane-a']), base, 'the reused branch was not moved');
    assert.equal(git(appDir, ['rev-parse', 'origin/main']), base, 'nothing was fetched');
    assert.deepEqual(startPointWarnings(result), []);
    assert.ok(result.warnings.some((warning) => warning.includes('already exists in repo "app"; reusing it')));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('a lane without --branch fetches nothing', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }
  const { tempDir, seed, appDir, base } = await createWorkspace('vibecompass-start-unbound-');
  try {
    await pushFromSeed(seed, 'remote-only');
    await startProjectSession({ cwd: tempDir, sessionId: 'lane-a', workingOn: 'W', repos: ['app'] });
    assert.equal(git(appDir, ['rev-parse', 'origin/main']), base);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('the fetch moves only the upstream tracking ref: configured extra mappings, pruning, and tag pruning write nothing', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }
  const { tempDir, seed, appDir } = await createWorkspace('vibecompass-start-isolated-');
  try {
    // A branch and a tag the checkout has, then deleted on the remote, so a
    // pruning fetch would remove the checkout's copies.
    git(seed, ['push', '-q', 'origin', 'main:refs/heads/other']);
    git(seed, ['tag', 'v1']);
    git(seed, ['push', '-q', 'origin', 'v1']);
    git(appDir, ['fetch', '-q', '--tags']);
    git(seed, ['push', '-q', 'origin', ':refs/heads/other']);
    git(seed, ['push', '-q', 'origin', ':refs/tags/v1']);
    git(appDir, ['config', '--add', 'remote.origin.fetch', '+refs/heads/main:refs/heads/shadow']);
    git(appDir, ['config', 'fetch.prune', 'true']);
    git(appDir, ['config', 'fetch.pruneTags', 'true']);
    const remoteTip = await pushFromSeed(seed, 'remote-only');

    await startLane(tempDir);

    assert.equal(git(appDir, ['rev-parse', 'origin/main']), remoteTip, 'the tracking ref moved');
    assert.equal(git(appDir, ['rev-parse', 'refs/heads/lane-a']), remoteTip);
    assert.notEqual(gitStatus(appDir, ['rev-parse', '--verify', '--quiet', 'refs/heads/shadow']), 0, 'no local branch from the extra mapping');
    assert.equal(gitStatus(appDir, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/other']), 0, 'no pruning');
    assert.equal(gitStatus(appDir, ['rev-parse', '--verify', '--quiet', 'refs/tags/v1']), 0, 'no tag pruning');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('a remote that asks for credentials never reaches an askpass helper, and the lane starts from the last fetch', async (t) => {
  if (!hasGit() || process.platform === 'win32') {
    t.skip('git and a POSIX shell are required.');
    return;
  }
  const { tempDir, appDir, base } = await createWorkspace('vibecompass-start-askpass-');
  const server = http.createServer((request, response) => {
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' });
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const marker = path.join(tempDir, 'askpass-called.txt');
    const askpass = path.join(tempDir, 'askpass.sh');
    await writeFile(askpass, `#!/bin/sh\necho "$1" >> '${marker}'\necho secret\n`, 'utf8');
    await chmod(askpass, 0o755);
    git(appDir, ['config', 'core.askPass', askpass]);
    git(appDir, ['remote', 'set-url', 'origin', `http://127.0.0.1:${server.address().port}/app.git`]);

    const result = await withIsolatedGitEnv(tempDir, {}, () => startLane(tempDir));

    assert.equal(existsSync(marker), false, 'the askpass helper was never called');
    assert.equal(git(appDir, ['rev-parse', 'refs/heads/lane-a']), base);
    assert.equal(startPointWarnings(result).length, 1);
    assert.match(startPointWarnings(result)[0], /^Repo "app": could not reach origin to update origin\/main \(.+\); comparing with origin\/main as last fetched\.$/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('an SSH remote runs SSH in batch mode with no terminal and no askpass, and its refusal falls back', async (t) => {
  if (!hasGit() || process.platform === 'win32') {
    t.skip('git and a POSIX shell are required.');
    return;
  }
  const { tempDir, appDir, base } = await createWorkspace('vibecompass-start-ssh-');
  try {
    const binDir = path.join(tempDir, 'bin');
    await mkdir(binDir);
    const record = path.join(tempDir, 'ssh-record.txt');
    await writeFile(path.join(binDir, 'ssh'), [
      '#!/bin/sh',
      `echo "args: $*" >> '${record}'`,
      `echo "SSH_ASKPASS_REQUIRE=$SSH_ASKPASS_REQUIRE" >> '${record}'`,
      `if (exec 3</dev/tty) 2>/dev/null; then echo "tty=yes" >> '${record}'; else echo "tty=no" >> '${record}'; fi`,
      'echo "Host key verification failed." >&2',
      'exit 255',
      '',
    ].join('\n'), 'utf8');
    await chmod(path.join(binDir, 'ssh'), 0o755);
    git(appDir, ['remote', 'set-url', 'origin', 'ssh://git@example.invalid/app.git']);

    const result = await withIsolatedGitEnv(
      tempDir,
      { PATH: `${binDir}${path.delimiter}${process.env.PATH}`, GIT_SSH_COMMAND: undefined, GIT_SSH: undefined },
      () => startLane(tempDir),
    );

    const recorded = await readFile(record, 'utf8');
    assert.match(recorded, /-o BatchMode=yes/);
    assert.match(recorded, /SSH_ASKPASS_REQUIRE=never/);
    assert.match(recorded, /tty=no/);
    assert.equal(git(appDir, ['rev-parse', 'refs/heads/lane-a']), base);
    assert.equal(startPointWarnings(result).length, 1);
    assert.match(startPointWarnings(result)[0], /could not reach origin to update origin\/main \(.*Host key verification failed/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('the fetch environment turns off Git prompts, every askpass program, and Git Credential Manager interaction', () => {
  const env = buildNonInteractiveGitEnv({ PATH: '/bin', GIT_ASKPASS: '/usr/bin/ask', SSH_ASKPASS: '/usr/bin/ask' });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_ASKPASS, '');
  assert.equal(env.SSH_ASKPASS, '');
  assert.equal(env.SSH_ASKPASS_REQUIRE, 'never');
  assert.equal(env.GCM_INTERACTIVE, 'never');
});
