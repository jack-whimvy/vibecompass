import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeProjectMemory } from '../init.js';
import { runCli } from '../cli.js';
import { listProjectSessions, startProjectSession } from '../session.js';

// End-to-end twin of the S4 throwaway primary-repo fixture (D-266): the unit
// tests exercise preflightGitBinding directly, but the memory-fork guard must
// also hold through the full start-session path with a genuinely initialized
// root — and leave nothing behind.

function hasGit() {
  return spawnSync('git', ['--version']).status === 0;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.toString().trim();
}

test('start-session fails closed end-to-end in a primary-repo layout (D-266)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-primary-repo-'));
  const repoDir = path.join(tempDir, 'primary');

  try {
    await mkdir(repoDir, { recursive: true });
    git(repoDir, ['init']);
    git(repoDir, ['config', 'user.email', 'test@example.com']);
    git(repoDir, ['config', 'user.name', 'Test']);
    await writeFile(path.join(repoDir, 'README.md'), 'hello\n', 'utf8');
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-m', 'initial']);

    const rootDir = path.join(repoDir, '.compass');
    await initializeProjectMemory({
      cwd: repoDir,
      rootDir,
      name: 'Primary Repo Guard',
      mode: 'local-only',
      repos: [{ id: 'primary', source: 'local', path: '.' }],
      bootstrap: { workflow: true, claude: true },
    });
    const claudeBefore = await readFile(path.join(repoDir, 'CLAUDE.md'), 'utf8');

    // Branch-only binding hits the D-266 memory-fork guard.
    await assert.rejects(
      startProjectSession({
        cwd: repoDir,
        sessionId: 'd266-probe',
        workingOn: 'D-266 fixture probe',
        repos: ['primary'],
        branch: 'd266-probe',
      }),
      /would fork shared memory \(D-266\)/,
    );

    // Worktree mode hits the placement guard first (the workspace itself sits
    // inside the repo work tree) — the same layout refused with worktree text.
    await assert.rejects(
      runCli(
        ['start-session', '--id', 'd266-probe', '--working-on', 'D-266 fixture probe', '--repo', 'primary', '--branch', 'd266-probe', '--worktree'],
        { stdout: { write() {} }, stderr: { write() {} } },
        { cwd: repoDir },
      ),
      /Run without --worktree/,
    );

    // Fail-closed means nothing survives either refusal.
    assert.equal(existsSync(path.join(rootDir, 'sessions/active/d266-probe')), false, 'no lane dir');
    assert.equal(existsSync(path.join(repoDir, 'worktrees')), false, 'no worktree container');
    assert.equal(
      spawnSync('git', ['-C', repoDir, 'rev-parse', '--verify', '--quiet', 'refs/heads/d266-probe']).status !== 0,
      true,
      'no branch created',
    );
    assert.equal(await readFile(path.join(repoDir, 'CLAUDE.md'), 'utf8'), claudeBefore, 'CLAUDE.md untouched');
    assert.deepEqual((await listProjectSessions({ rootDir })).lanes, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
