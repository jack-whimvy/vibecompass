import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializeProjectMemory } from '../../init.js';
import { startProjectSession } from '../../session.js';

// Shared setup for the review relay's tests: a workspace with a memory root and
// a code repository side by side, lanes with and without a worktree, and the
// lane files the relay reads.

export function git(cwd, args, env = {}) {
  const result = spawnSync('git', args, { cwd, env: { ...process.env, ...env } });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.toString().trim();
}

export async function createGitRepo(repoDir, files = { 'README.md': 'hello\n' }) {
  await mkdir(repoDir, { recursive: true });
  git(repoDir, ['init', '-q', '-b', 'main']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  git(repoDir, ['config', 'commit.gpgsign', 'false']);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repoDir, name)), { recursive: true });
    await writeFile(path.join(repoDir, name), content, 'utf8');
  }
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-q', '-m', 'initial']);
  return git(repoDir, ['rev-parse', 'HEAD']);
}

export function captureIo() {
  const out = [];
  const err = [];
  return {
    io: { stdout: { write: (chunk) => out.push(chunk) }, stderr: { write: (chunk) => err.push(chunk) } },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

/**
 * A workspace: `<tmp>/.compass` (the memory root, a git repository when
 * `docsGit`), `<tmp>/app` (a code repository), and `review` lines for
 * project.yaml's review block.
 */
export async function createWorkspace(t, { docsGit = true, review = null, prefix = 'vibecompass-relay-' } = {}) {
  const tempDir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const rootDir = path.join(tempDir, '.compass');
  const appDir = path.join(tempDir, 'app');
  await createGitRepo(appDir, { 'README.md': 'hello\n', 'src/index.js': 'export const answer = 42;\n' });
  await initializeProjectMemory({
    cwd: tempDir,
    rootDir,
    name: 'Relay Test',
    mode: 'local-only',
    repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
    bootstrap: { workflow: true, claude: true },
  });
  await mkdir(path.join(rootDir, 'architecture', 'platform'), { recursive: true });
  await writeFile(path.join(rootDir, 'architecture', 'platform', 'relay.md'), '# Relay\n\nThe contract.\n', 'utf8');
  await writeFile(path.join(rootDir, 'architecture', 'platform', 'other.md'), '# Other\n\nUnrelated.\n', 'utf8');
  if (review) {
    const projectPath = path.join(rootDir, 'project.yaml');
    const source = await readFile(projectPath, 'utf8');
    await writeFile(projectPath, source.replace('\n  workflow:\n', `\n  workflow:\n    review:\n${review.map((line) => `      ${line}`).join('\n')}\n`), 'utf8');
  }
  if (docsGit) {
    git(rootDir, ['init', '-q', '-b', 'main']);
    git(rootDir, ['config', 'user.email', 'test@example.com']);
    git(rootDir, ['config', 'user.name', 'Test']);
    git(rootDir, ['config', 'commit.gpgsign', 'false']);
    git(rootDir, ['add', '.']);
    git(rootDir, ['commit', '-q', '-m', 'memory']);
  }
  return { tempDir, rootDir, appDir };
}

/** Opens a lane, with a worktree of `app` on its own branch when `worktree`. */
export async function openLane(ws, laneId, { worktree = false } = {}) {
  await startProjectSession({
    cwd: ws.tempDir,
    rootDir: ws.rootDir,
    sessionId: laneId,
    workingOn: `Work in ${laneId}.`,
    date: '2026-11-21',
    ...(worktree ? { repos: ['app'], branch: `feat/${laneId}`, worktree: true } : {}),
    brief: false,
  });
  const laneDir = path.join(ws.rootDir, 'sessions', 'active', laneId);
  return {
    laneId,
    laneDir,
    wipPath: path.join(laneDir, 'wip.md'),
    handoffPath: path.join(laneDir, 'handoff.md'),
    worktreeDir: worktree ? path.join(ws.tempDir, 'worktrees', laneId, 'app') : null,
  };
}

export async function writeReviewLog(lane, lines) {
  const wip = await readFile(lane.wipPath, 'utf8');
  const at = wip.indexOf('## Review log');
  assert.ok(at >= 0, 'the wip template ends with ## Review log');
  await writeFile(lane.wipPath, `${wip.slice(0, at)}## Review log\n${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`, 'utf8');
}

export async function appendWipLog(lane, line) {
  const wip = await readFile(lane.wipPath, 'utf8');
  await writeFile(lane.wipPath, wip.replace('\n## Reviewer input needed', `- ${line}\n\n## Reviewer input needed`), 'utf8');
}

export async function setBuilderHandoff(lane, text) {
  const handoff = await readFile(lane.handoffPath, 'utf8');
  const start = handoff.indexOf('## Builder → Reviewer');
  const end = handoff.indexOf('## Reviewer → Builder');
  assert.ok(start >= 0 && end > start);
  await writeFile(lane.handoffPath, `${handoff.slice(0, start)}## Builder → Reviewer\n\n${text}\n\n${handoff.slice(end)}`, 'utf8');
}

export const OPEN_TWO = [
  '- pass 1 | 2026-11-21 10:00 PST | Codex (GPT-6) | the diff | findings',
  '  - R1.1 | P2 | open | the parser accepts a bad time',
  '  - R1.2 | P3 | open | a message names a decision number',
];

export const ANSWER_BOTH = [
  ...OPEN_TWO,
  '- response 1 | 2026-11-21 10:30 PST | Claude Opus 5.5',
  '  - R1.1 | P2 | accepted | fixed the pattern',
  '  - R1.2 | P3 | rejected | the number sits in a code comment',
];

export const ANSWER_ONE = [
  ...OPEN_TWO,
  '- response 1 | 2026-11-21 10:30 PST | Claude Opus 5.5',
  '  - R1.1 | P2 | accepted | fixed the pattern',
];

export const CLEAN = ['- pass 1 | 2026-11-21 10:00 PST | Codex (GPT-6) | the diff | no findings'];
