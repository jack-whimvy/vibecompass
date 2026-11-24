import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, readFile, readdir, realpath, rm, symlink, unlink, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../cli.js';
import { WORKING_READ_FLAGS, compareMark, fingerprintWork, readReadyMark, readWorkingFileHash, writeReadyMark } from '../relay-mark.js';
import { withMemoryRootLock } from '../serialization.js';
import { listProjectSessions } from '../session.js';
import {
  ANSWER_BOTH,
  ANSWER_ONE,
  CLEAN,
  OPEN_TWO,
  appendWipLog,
  captureIo,
  createWorkspace,
  git,
  openLane,
  setBuilderHandoff,
  writeReviewLog,
} from './fixtures/relay-fixtures.js';

// D-419 item 4's mark and item 11's stage, with item 17's "rounds and marks"
// group: a response that changes only the record, a response that answers one
// of two findings, a named directory edited inside, a mixed code and docs
// change, an unrelated docs edit, a named directory that covers nothing, a
// git-ignored named file, a staged-only change, and a non-git memory root
// across two lock cycles.

async function mark(ws, lane, { paths = [], env = {}, json = false } = {}) {
  const capture = captureIo();
  const args = ['ready-for-review', '--root', ws.rootDir, '--session', lane.laneId, ...paths.flatMap((item) => ['--path', item]), ...(json ? ['--json'] : [])];
  const code = await runCli(args, capture.io, { cwd: ws.tempDir, env: { ...process.env, CLAUDE_CODE_SESSION_ID: '', ...env } });
  return { code, ...capture, mark: await readReadyMark(lane.laneDir) };
}

async function compare(ws, lane) {
  const current = await readReadyMark(lane.laneDir);
  const sessionYaml = await readFile(path.join(lane.laneDir, 'session.yaml'), 'utf8');
  const worktrees = lane.worktreeDir && sessionYaml.includes('worktrees:') ? { app: lane.worktreeDir } : {};
  return compareMark(current, { rootDir: ws.rootDir, laneDir: lane.laneDir, worktrees, projectRepos: [{ id: 'app' }] });
}

test('a lane with no worktree and no --path is refused, naming the work', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'no-work');
  await assert.rejects(mark(ws, lane), /has no worktree, so name the work under review with --path/);
  assert.equal(await readReadyMark(lane.laneDir), null);
});

test('a worktree lane marks, and marking again with nothing changed keeps the round', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'wt-lane', { worktree: true });
  const first = await mark(ws, lane);
  assert.equal(first.code, 0);
  assert.match(first.stdout(), /Marked lane wt-lane ready for review \(round [0-9a-f]{12}\)\./);
  assert.match(first.stdout(), /worktree app at [0-9a-f]{12}: staged and working changes, 0 untracked files/);
  assert.match(first.stdout(), /No builder conversation recorded \(CLAUDE_CODE_SESSION_ID is not set\): the relay runs one pass\./);
  assert.equal(first.mark.lane, 'wt-lane');
  assert.equal(first.mark.builder, null);
  assert.match(first.mark.round_id, /^[0-9a-f]{64}$/);
  // Writing the mark never changes the mark.
  const second = await mark(ws, lane);
  assert.equal(second.mark.round_id, first.mark.round_id);
  assert.equal((await compare(ws, lane)).current, true);
});

test('the builder conversation is recorded when CLAUDE_CODE_SESSION_ID is set', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'conv-lane', { worktree: true });
  const result = await mark(ws, lane, { env: { CLAUDE_CODE_SESSION_ID: '1b2c3d4e-0000-4000-8000-00000000abcd' } });
  assert.deepEqual(result.mark.builder, { tool: 'claude-code', conversation_id: '1b2c3d4e-0000-4000-8000-00000000abcd' });
  assert.match(result.stdout(), /Builder conversation: 1b2c3d4e-0000-4000-8000-00000000abcd \(Claude Code\)/);
  const odd = await mark(ws, lane, { env: { CLAUDE_CODE_SESSION_ID: '../../etc' } });
  assert.equal(odd.mark.builder, null);
  assert.match(odd.stderr(), /CLAUDE_CODE_SESSION_ID is set but is not a conversation id/);
});

test('a response that changes only the record makes a new round', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'record-only', { worktree: true });
  await writeReviewLog(lane, OPEN_TWO);
  await assert.rejects(mark(ws, lane), /R1\.1, R1\.2 wait for the builder's response/);
  await writeReviewLog(lane, ANSWER_BOTH);
  const before = (await mark(ws, lane)).mark;
  // A rejection with evidence that changes nothing else is still a new round.
  await writeReviewLog(lane, [...ANSWER_BOTH, '- pass 2 | 2026-11-21 11:00 PST | Codex (GPT-6) | responses | findings', '  - R1.1 | P2 | confirmed | fixed', '  - R1.2 | P3 | reopened | still there', '- response 2 | 2026-11-21 11:30 PST | Claude Opus 5.5', '  - R1.2 | P3 | rejected | the comment is the place for it']);
  const comparison = await compare(ws, lane);
  assert.deepEqual(comparison.differences, ['record']);
  const after = (await mark(ws, lane)).mark;
  assert.notEqual(after.round_id, before.round_id);
  assert.equal(after.fingerprints.work, before.fingerprints.work);
  assert.equal(after.fingerprints.handoff, before.fingerprints.handoff);
});

test('a response that answers one of two findings is refused with the other id named', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'half-answer', { worktree: true });
  await writeReviewLog(lane, ANSWER_ONE);
  await assert.rejects(mark(ws, lane), (error) => {
    assert.match(error.message, /R1\.2 waits for the builder's response/);
    assert.doesNotMatch(error.message, /R1\.1/);
    return true;
  });
  assert.equal(await readReadyMark(lane.laneDir), null);
  // An owner deferral lets the round be marked.
  await writeReviewLog(lane, [...ANSWER_ONE, '- owner | 2026-11-21 10:40 PST | the owner | defer R1.2 | after the release']);
  assert.equal((await mark(ws, lane)).code, 0);
});

test('a malformed review log refuses the mark', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'malformed', { worktree: true });
  await writeReviewLog(lane, ['Codex found nothing.']);
  await assert.rejects(mark(ws, lane), /ready-for-review is refused: the review log is malformed at wip\.md line \d+/);
});

test('the builder writing its log in ## Log changes no fingerprint; its handoff does', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'log-lane', { worktree: true });
  await mark(ws, lane);
  await appendWipLog(lane, 'worked on the parser');
  assert.equal((await compare(ws, lane)).current, true);
  await setBuilderHandoff(lane, '### What changed\n- the parser');
  assert.deepEqual((await compare(ws, lane)).differences, ['handoff']);
});

test('a change only to what is staged changes the work fingerprint', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'staged-lane', { worktree: true });
  const file = path.join(lane.worktreeDir, 'README.md');
  await writeFile(file, 'hello\nstaged line\n', 'utf8');
  git(lane.worktreeDir, ['add', 'README.md']);
  await writeFile(file, 'hello\n', 'utf8');
  // git diff HEAD is empty here; the staged and working diffs are not.
  assert.equal(git(lane.worktreeDir, ['diff', '--binary', 'HEAD']), '');
  await mark(ws, lane);
  // Stage the working file (matching HEAD): only what is staged changes.
  git(lane.worktreeDir, ['add', 'README.md']);
  assert.equal(git(lane.worktreeDir, ['diff', '--binary', 'HEAD']), '');
  assert.deepEqual((await compare(ws, lane)).differences, ['work']);
});

test('untracked files count; a commit moves HEAD', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'untracked-lane', { worktree: true });
  await mark(ws, lane);
  await writeFile(path.join(lane.worktreeDir, 'new.js'), 'x\n', 'utf8');
  assert.deepEqual((await compare(ws, lane)).differences, ['work']);
  await mark(ws, lane);
  git(lane.worktreeDir, ['add', 'new.js']);
  git(lane.worktreeDir, ['commit', '-q', '-m', 'add']);
  assert.deepEqual((await compare(ws, lane)).differences, ['work']);
});

test('a named directory edited inside, a mixed change, and an unrelated docs edit', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'dir-lane', { worktree: true });
  const result = await mark(ws, lane, { paths: ['architecture/platform/relay.md'] });
  assert.equal(result.code, 0);
  // An unrelated docs edit: another file in the memory root.
  await writeFile(path.join(ws.rootDir, 'architecture/platform/other.md'), '# Other\n\nEdited.\n', 'utf8');
  assert.equal((await compare(ws, lane)).current, true);
  // A named directory edited inside.
  await mark(ws, lane, { paths: ['architecture/platform'] });
  await writeFile(path.join(ws.rootDir, 'architecture/platform/relay.md'), '# Relay\n\nChanged.\n', 'utf8');
  assert.deepEqual((await compare(ws, lane)).differences, ['work']);
  // A mixed code and docs change.
  await mark(ws, lane, { paths: ['architecture/platform'] });
  await writeFile(path.join(lane.worktreeDir, 'src/index.js'), 'export const answer = 43;\n', 'utf8');
  await writeFile(path.join(ws.rootDir, 'architecture/platform/relay.md'), '# Relay\n\nChanged again.\n', 'utf8');
  assert.deepEqual((await compare(ws, lane)).differences, ['work']);
  const marked = await mark(ws, lane, { paths: ['architecture/platform'] });
  assert.match(marked.stdout(), /architecture\/platform\/: 2 files covered, 0 ignored by git left out/);
});

test('another lane committing to the shared memory root does not change named paths', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'shared-lane', { worktree: true });
  await mark(ws, lane, { paths: ['architecture/platform/relay.md'] });
  await writeFile(path.join(ws.rootDir, 'architecture/platform/other.md'), '# Other\n\nAnother lane.\n', 'utf8');
  git(ws.rootDir, ['add', 'architecture/platform/other.md']);
  git(ws.rootDir, ['commit', '-q', '-m', 'another lane']);
  assert.equal((await compare(ws, lane)).current, true);
});

test('a named directory that covers no files is refused; the lane folder is one', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'empty-dir', { worktree: true });
  await mkdir(path.join(ws.rootDir, 'architecture/empty'), { recursive: true });
  await assert.rejects(mark(ws, lane, { paths: ['architecture/empty'] }), /--path architecture\/empty covers no files; name the files instead\./);
  // sessions/active/ is never covered by a directory.
  await assert.rejects(mark(ws, lane, { paths: [`sessions/active/${lane.laneId}`] }), /covers no files/);
  // A file there counts only when named.
  await writeFile(path.join(lane.laneDir, 'draft-decision.md'), '### D-NEXT — draft\n', 'utf8');
  const named = await mark(ws, lane, { paths: [`sessions/active/${lane.laneId}/draft-decision.md`] });
  assert.equal(named.code, 0);
  await writeFile(path.join(lane.laneDir, 'draft-decision.md'), '### D-NEXT — draft 2\n', 'utf8');
  assert.deepEqual((await compare(ws, lane)).differences, ['work']);
});

test("the lane's own files are never part of the work, even when named", async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'own-files', { worktree: true });
  const result = await mark(ws, lane, { paths: [`sessions/active/${lane.laneId}/wip.md`, `sessions/active/${lane.laneId}/ready.json`] });
  assert.match(result.stdout(), /is the lane's own file and is never part of the work/);
  await appendWipLog(lane, 'more log');
  assert.equal((await compare(ws, lane)).current, true);
});

test('a named file git ignores is still fingerprinted; a missing one counts as missing', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'ignored-file', { worktree: true });
  await writeFile(path.join(ws.rootDir, '.gitignore'), `${await readFile(path.join(ws.rootDir, '.gitignore'), 'utf8')}notes.local.md\n`, 'utf8');
  await writeFile(path.join(ws.rootDir, 'notes.local.md'), 'one\n', 'utf8');
  await mark(ws, lane, { paths: ['notes.local.md', 'app:src/index.js'] });
  await writeFile(path.join(ws.rootDir, 'notes.local.md'), 'two\n', 'utf8');
  assert.deepEqual((await compare(ws, lane)).differences, ['work']);
  // A deletion: mark it missing, then restoring changes the fingerprint.
  await unlink(path.join(ws.rootDir, 'notes.local.md'));
  const marked = await mark(ws, lane, { paths: ['notes.local.md'] });
  assert.match(marked.stdout(), /notes\.local\.md: missing \(counts as a deletion\)/);
  await writeFile(path.join(ws.rootDir, 'notes.local.md'), 'two\n', 'utf8');
  assert.deepEqual((await compare(ws, lane)).differences, ['work']);
});

test('a repository path resolves to the lane worktree, and a path outside the root is refused', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'repo-path', { worktree: true });
  const result = await mark(ws, lane, { paths: ['app:src/index.js'], json: true });
  const json = JSON.parse(result.stdout());
  assert.deepEqual(json.paths, ['app:src/index.js']);
  await assert.rejects(mark(ws, lane, { paths: ['../outside.md'] }), /is outside the memory root/);
  await assert.rejects(mark(ws, lane, { paths: ['app:../../etc/passwd'] }), /points outside repository app/);
});

test('a mark over a non-git memory root stays the same across two memory-root lock cycles', async (t) => {
  const ws = await createWorkspace(t, { docsGit: false });
  const lane = await openLane(ws, 'non-git');
  const result = await mark(ws, lane, { paths: ['.'] });
  assert.equal(result.code, 0);
  for (let cycle = 0; cycle < 2; cycle += 1) {
    // Inside the lock its owner file exists under state/, which no directory covers.
    const inside = await withMemoryRootLock(ws.rootDir, 'test', () => compare(ws, lane));
    assert.equal(inside.current, true, `cycle ${cycle + 1} inside the lock`);
    assert.equal((await compare(ws, lane)).current, true, `cycle ${cycle + 1} after the lock`);
  }
  // Every file in a non-git root counts, ignored or not.
  await writeFile(path.join(ws.rootDir, 'scratch.txt'), 'x\n', 'utf8');
  assert.deepEqual((await compare(ws, lane)).differences, ['work']);
});

test('fingerprintWork entries sort, so the order of --path values does not matter', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'order-lane');
  const a = await fingerprintWork({ rootDir: ws.rootDir, laneDir: lane.laneDir, paths: ['architecture/platform/relay.md', 'architecture/platform/other.md'] });
  const b = await fingerprintWork({ rootDir: ws.rootDir, laneDir: lane.laneDir, paths: ['architecture/platform/other.md', 'architecture/platform/relay.md'] });
  assert.equal(a.fingerprint, b.fingerprint);
});

test('list-sessions shows no stage for a lane without a mark, and the stage for one with', async (t) => {
  const ws = await createWorkspace(t);
  const plain = await openLane(ws, 'plain-lane');
  const marked = await openLane(ws, 'marked-lane', { worktree: true });
  const listText = async () => {
    const capture = captureIo();
    assert.equal(await runCli(['list-sessions', '--root', ws.rootDir], capture.io, { cwd: ws.tempDir }), 0);
    return capture.stdout();
  };
  const stageOf = async (laneId) => {
    const result = await listProjectSessions({ cwd: ws.tempDir, rootDir: ws.rootDir });
    return result.inventory.lanes.find((item) => item.id === laneId);
  };

  assert.doesNotMatch(await listText(), /stage:/);
  assert.equal((await stageOf('plain-lane')).stage, null);

  await mark(ws, marked);
  assert.match(await listText(), /marked-lane: Work in marked-lane\.[\s\S]*\n    stage: ready for review\n/);
  assert.equal((await stageOf('marked-lane')).stage, 'ready for review');
  assert.equal((await stageOf('plain-lane')).stage, null);

  await writeFile(path.join(marked.worktreeDir, 'README.md'), 'edited\n', 'utf8');
  assert.equal((await stageOf('marked-lane')).stage, 'building');

  await writeReviewLog(marked, CLEAN);
  assert.equal((await stageOf('marked-lane')).stage, 'review clean');

  const json = captureIo();
  assert.equal(await runCli(['list-sessions', '--root', ws.rootDir, '--json'], json.io, { cwd: ws.tempDir }), 0);
  const lanes = JSON.parse(json.stdout()).lanes;
  assert.equal(lanes.find((item) => item.id === 'plain-lane').stage, null);
  assert.equal(lanes.find((item) => item.id === 'marked-lane').stage, 'review clean');
  assert.equal(lanes.find((item) => item.id === 'marked-lane').stageReason, null);
  assert.ok(plain);
});

test('a hand-run pass after the mark moves the stage back to building', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'hand-run', { worktree: true });
  await mark(ws, lane);
  await writeReviewLog(lane, OPEN_TWO);
  const result = await listProjectSessions({ cwd: ws.tempDir, rootDir: ws.rootDir });
  assert.equal(result.inventory.lanes.find((item) => item.id === 'hand-run').stage, 'building');
  await rm(path.join(lane.laneDir, 'ready.json'));
  const after = await listProjectSessions({ cwd: ws.tempDir, rootDir: ws.rootDir });
  assert.equal(after.inventory.lanes.find((item) => item.id === 'hand-run').stage, null);
});

test('a lane without a worktree that names only its own files covers no work and writes no mark', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'scratch-only');
  await assert.rejects(
    mark(ws, lane, { paths: [`sessions/active/${lane.laneId}/wip.md`] }),
    /ready-for-review is refused: the paths named cover no work \(sessions\/active\/scratch-only\/wip\.md is the lane's own file, never part of the work\)/,
  );
  assert.equal(await readReadyMark(lane.laneDir), null);
  // A named missing file is coverage: a deletion.
  const deletion = await mark(ws, lane, { paths: [`sessions/active/${lane.laneId}/wip.md`, 'architecture/gone.md'] });
  assert.equal(deletion.code, 0);
  assert.deepEqual(deletion.mark.paths, ['architecture/gone.md']);
});

test('a named directory in a git checkout reached through a symlink is listed under the path as named', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'symlinked-root');
  const link = path.join(ws.tempDir, 'docs-link');
  await symlink(ws.rootDir, link);
  const work = await fingerprintWork({ rootDir: link, laneDir: path.join(link, 'sessions', 'active', lane.laneId), paths: ['architecture/platform'] });
  const covered = work.covers.paths[0];
  assert.equal(covered.kind, 'directory');
  assert.ok(covered.covered >= 1);
  for (const entry of work.entries) assert.doesNotMatch(entry, /\t\.\.\//, 'no entry reaches outside the directory');
  // The same work through the real path fingerprints the same.
  const direct = await fingerprintWork({ rootDir: ws.rootDir, laneDir: lane.laneDir, paths: ['architecture/platform'] });
  assert.equal(work.fingerprint, direct.fingerprint);
});

test('every file in a wholly ignored directory counts as left out', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'ignored-dir');
  await writeFile(path.join(ws.rootDir, '.gitignore'), `${await readFile(path.join(ws.rootDir, '.gitignore'), 'utf8')}architecture/platform/build/\n`, 'utf8');
  await mkdir(path.join(ws.rootDir, 'architecture/platform/build/deep'), { recursive: true });
  for (const name of ['a.txt', 'b.txt', 'deep/c.txt']) await writeFile(path.join(ws.rootDir, 'architecture/platform/build', name), 'x\n', 'utf8');
  const work = await fingerprintWork({ rootDir: ws.rootDir, laneDir: lane.laneDir, paths: ['architecture/platform'] });
  assert.equal(work.covers.paths[0].ignored, 3);
});

test('a new mark after a clean pass is ready for review, not review clean', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'clean-then-mark', { worktree: true });
  const first = await mark(ws, lane);
  const short = first.mark.round_id.slice(0, 12);
  await writeReviewLog(lane, [`- pass 1 | 2026-11-22 10:00 -08:00 | Codex 0.171.0 (gpt-6.2-astra requested) via the relay | relay write abcdef012345, round ${short}; the diff | no findings`]);
  const stageOf = async () => (await listProjectSessions({ cwd: ws.tempDir, rootDir: ws.rootDir })).inventory.lanes.find((item) => item.id === lane.laneId).stage;
  assert.equal(await stageOf(), 'review clean');
  // The builder changes the work and marks a new round.
  await writeFile(path.join(lane.worktreeDir, 'src/index.js'), 'export const answer = 44;\n', 'utf8');
  await mark(ws, lane);
  assert.equal(await stageOf(), 'ready for review');
});

test('writeReadyMark refuses work that names nothing', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'api-lane');
  await assert.rejects(writeReadyMark({ rootDir: ws.rootDir, laneId: lane.laneId, laneDir: lane.laneDir }), /name the work under review/);
});

test('the relay\'s own git reads start no helper a repository configures: no filesystem monitor, filter driver, or hook', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'helpers-off', { worktree: true });
  const marks = path.join(ws.tempDir, 'helper-marks');
  await mkdir(marks);
  const hooks = path.join(ws.tempDir, 'helper-hooks');
  await mkdir(hooks);
  const script = async (file, name, tail) => {
    await writeFile(file, `#!/bin/sh\ntouch '${path.join(marks, name)}'\n${tail}\n`, { mode: 0o755 });
    return file;
  };
  git(lane.worktreeDir, ['config', 'core.fsmonitor', await script(path.join(ws.tempDir, 'fsmonitor.sh'), 'fsmonitor', 'exit 1')]);
  git(lane.worktreeDir, ['config', 'filter.probe.clean', await script(path.join(ws.tempDir, 'clean.sh'), 'clean', 'cat')]);
  git(lane.worktreeDir, ['config', 'filter.probe.required', 'true']);
  git(lane.worktreeDir, ['config', 'core.hooksPath', hooks]);
  await script(path.join(hooks, 'post-index-change'), 'hook', 'exit 0');
  await writeFile(path.join(lane.worktreeDir, '.gitattributes'), '* filter=probe\n', 'utf8');
  // A tracked file changed in the working tree: a diff cleans it.
  await writeFile(path.join(lane.worktreeDir, 'src', 'index.js'), 'export const answer = 99;\n', 'utf8');
  const projectRepos = [{ id: 'app' }];
  const worktrees = { app: lane.worktreeDir };
  // The control: git as anyone would run it starts the monitor and the filter here.
  spawnSync('git', ['diff'], { cwd: lane.worktreeDir, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  assert.deepEqual((await readdir(marks)).sort(), ['clean', 'fsmonitor'], 'the repository\'s helpers run under a plain git diff');
  for (const name of await readdir(marks)) await rm(path.join(marks, name));

  // Marking, comparing, and a named directory's listing: nothing starts.
  const work = await fingerprintWork({ rootDir: ws.rootDir, laneDir: lane.laneDir, worktrees, paths: ['app:src'], projectRepos, marking: true });
  assert.equal(work.covers.paths[0].covered, 1);
  const marked = await mark(ws, lane, { paths: ['app:src'] });
  assert.equal(marked.code, 0, marked.stderr());
  const compared = await compareMark(marked.mark, { rootDir: ws.rootDir, laneDir: lane.laneDir, worktrees, projectRepos });
  assert.equal(compared.current, true);
  assert.deepEqual(await readdir(marks), [], 'no repository-selected helper ran');
  // The change still counts.
  await writeFile(path.join(lane.worktreeDir, 'src', 'index.js'), 'export const answer = 100;\n', 'utf8');
  assert.equal((await compareMark(marked.mark, { rootDir: ws.rootDir, laneDir: lane.laneDir, worktrees, projectRepos })).current, false);
  assert.deepEqual(await readdir(marks), []);
});

test('a filter configured after the mark, under any name, never runs in a comparison, and the change it would hide still counts', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'helpers-late', { worktree: true });
  const projectRepos = [{ id: 'app' }];
  const worktrees = { app: lane.worktreeDir };
  const marked = await mark(ws, lane, { paths: ['app:src'] });
  assert.equal(marked.code, 0, marked.stderr());
  const marks = path.join(ws.tempDir, 'late-marks');
  await mkdir(marks);
  // After the mark: two drivers, one whose name no -c argument could carry,
  // each a clean filter that turns any change back into what is staged.
  for (const name of ['late', 'a=b']) {
    const file = path.join(ws.tempDir, `clean-${name.replace('=', '-')}.sh`);
    await writeFile(file, `#!/bin/sh\ntouch '${path.join(marks, name.replace('=', '-'))}'\ncat >/dev/null\ngit show ":$1"\n`, { mode: 0o755 });
    git(lane.worktreeDir, ['config', `filter.${name}.clean`, `${file} %f`]);
  }
  await writeFile(path.join(lane.worktreeDir, '.git', 'info', 'attributes'), 'src/index.js filter=late\nREADME.md filter=a=b\n', 'utf8').catch(async () => {
    // A linked worktree keeps info/ in the common directory.
    const common = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: lane.worktreeDir, encoding: 'utf8' }).stdout.trim();
    await mkdir(path.resolve(lane.worktreeDir, common, 'info'), { recursive: true });
    await writeFile(path.resolve(lane.worktreeDir, common, 'info', 'attributes'), 'src/index.js filter=late\nREADME.md filter=a=b\n', 'utf8');
  });
  await writeFile(path.join(lane.worktreeDir, 'src', 'index.js'), 'export const answer = 7;\n', 'utf8');
  await writeFile(path.join(lane.worktreeDir, 'README.md'), 'changed\n', 'utf8');
  // The control: git's own working-tree diff runs both filters, which hide both changes.
  const plain = spawnSync('git', ['diff', '--name-only'], { cwd: lane.worktreeDir, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8' });
  assert.equal(plain.stdout.trim(), '', 'the filters hide the changes from git diff');
  assert.deepEqual((await readdir(marks)).sort(), ['a-b', 'late']);
  for (const name of await readdir(marks)) await rm(path.join(marks, name));
  const compared = await compareMark(marked.mark, { rootDir: ws.rootDir, laneDir: lane.laneDir, worktrees, projectRepos });
  assert.equal(compared.current, false, 'the change counts');
  assert.deepEqual(compared.differences, ['work']);
  assert.deepEqual(await readdir(marks), [], 'no filter ran');
});

test('a checked-out submodule\'s edits and untracked files change the work, every time; one not checked out counts as its entry', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'submodule-lane', { worktree: true });
  const lib = path.join(ws.tempDir, 'lib');
  await mkdir(lib);
  git(lib, ['init', '-q', '-b', 'main']);
  git(lib, ['config', 'user.email', 'test@example.com']);
  git(lib, ['config', 'user.name', 'Test']);
  await writeFile(path.join(lib, 'lib.js'), 'export const one = 1;\n', 'utf8');
  git(lib, ['add', '.']);
  git(lib, ['commit', '-q', '-m', 'lib']);
  git(lane.worktreeDir, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib']);
  git(lane.worktreeDir, ['commit', '-q', '-m', 'vendor lib']);
  const worktrees = { app: lane.worktreeDir };
  const projectRepos = [{ id: 'app' }];
  const first = await mark(ws, lane);
  assert.equal(first.code, 0, first.stderr());
  assert.match(first.stdout(), /0 untracked files, 1 checked-out submodule/);
  const sub = path.join(lane.worktreeDir, 'vendor', 'lib', 'lib.js');
  // git's own diff shows the submodule only as dirty, whatever the edit.
  await writeFile(sub, 'export const one = 2;\n', 'utf8');
  assert.equal((await compare(ws, lane)).current, false, 'a tracked edit in the submodule counts');
  const second = await mark(ws, lane);
  await writeFile(sub, 'export const one = 3;\n', 'utf8');
  assert.equal((await compareMark(second.mark, { rootDir: ws.rootDir, laneDir: lane.laneDir, worktrees, projectRepos })).current, false, 'a second edit counts too');
  const third = await mark(ws, lane);
  await writeFile(path.join(lane.worktreeDir, 'vendor', 'lib', 'new.js'), 'x\n', 'utf8');
  assert.equal((await compareMark(third.mark, { rootDir: ws.rootDir, laneDir: lane.laneDir, worktrees, projectRepos })).current, false, 'an untracked file in the submodule counts');
  // Not checked out: the entry alone, and the mark still works.
  git(lane.worktreeDir, ['submodule', 'deinit', '-q', '-f', 'vendor/lib']);
  const fourth = await mark(ws, lane);
  assert.equal(fourth.code, 0, fourth.stderr());
  assert.doesNotMatch(fourth.stdout(), /checked-out submodule/);
  // A repository inside the worktree that isn't a submodule is refused, by name.
  const nested = path.join(lane.worktreeDir, 'scratch-repo');
  await mkdir(nested);
  git(nested, ['init', '-q']);
  await assert.rejects(mark(ws, lane), /holds a git repository that isn't a submodule \(scratch-repo\/\)/);
});

test('a partial clone whose staged diff needs a missing object refuses the work without fetching it', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'partial-lane');
  const source = path.join(ws.tempDir, 'source');
  await mkdir(source);
  git(source, ['init', '-q', '-b', 'main']);
  git(source, ['config', 'user.email', 'test@example.com']);
  git(source, ['config', 'user.name', 'Test']);
  git(source, ['config', 'uploadpack.allowFilter', 'true']);
  await writeFile(path.join(source, 'f.txt'), 'a\n', 'utf8');
  git(source, ['add', '.']);
  git(source, ['commit', '-q', '-m', 'A']);
  await writeFile(path.join(source, 'f.txt'), 'b\n', 'utf8');
  git(source, ['commit', '-q', '-am', 'B']);
  const clone = path.join(ws.tempDir, 'clone');
  git(ws.tempDir, ['clone', '-q', '--filter=blob:none', `file://${source}`, clone]);
  // HEAD moves back to A, whose blob was never fetched; the index keeps B's.
  git(clone, ['reset', '-q', '--soft', 'HEAD~1']);
  const objects = async () => (await readdir(path.join(clone, '.git', 'objects'), { recursive: true })).length;
  const before = await objects();
  await assert.rejects(
    fingerprintWork({ rootDir: ws.rootDir, laneDir: lane.laneDir, worktrees: { app: clone }, projectRepos: [{ id: 'app' }] }),
    /git diff --cached failed in Lane worktree app at .+(not allowed|could not fetch)/,
  );
  assert.equal(await objects(), before, 'nothing was fetched');
  // The control: git as anyone would run it fetches the object.
  spawnSync('git', ['diff', '--cached', '--binary'], { cwd: clone, encoding: 'utf8' });
  assert.ok((await objects()) > before);
});

test('a named directory in a repository git can\'t read is refused, never walked; outside every repository it is walked', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'no-git-lane');
  await writeFile(path.join(ws.appDir, '.gitignore'), 'cache.bin\n', 'utf8');
  await writeFile(path.join(ws.appDir, 'src', 'cache.bin'), 'ignored\n', 'utf8');
  const projectRepos = [{ id: 'app' }];
  const withGit = await fingerprintWork({ rootDir: ws.rootDir, laneDir: lane.laneDir, paths: ['app:src'], projectRepos });
  assert.equal(withGit.covers.paths[0].covered, 1);
  const noGit = { ...process.env, PATH: path.join(ws.tempDir, 'no-such-bin') };
  await assert.rejects(
    fingerprintWork({ rootDir: ws.rootDir, laneDir: lane.laneDir, paths: ['app:src'], projectRepos, env: noGit }),
    new RegExp(`git couldn't read the repository at ${ws.appDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(.+\\), so the relay doesn't read .+src as plain files`),
  );
  // A folder no repository holds is plain files, with git or without.
  const plain = path.join(ws.tempDir, 'plain');
  await mkdir(plain);
  await writeFile(path.join(plain, 'a.txt'), 'a\n', 'utf8');
  await writeFile(path.join(plain, 'b.txt'), 'b\n', 'utf8');
  const repos = [{ id: 'plain', path: 'plain' }];
  const walked = await fingerprintWork({ rootDir: ws.rootDir, laneDir: lane.laneDir, paths: ['plain:.'], projectRepos: repos, env: noGit });
  assert.equal(walked.covers.paths[0].covered, 2);
  assert.equal(walked.covers.paths[0].git, false);
});

test('the relay\'s git reads ignore a repository the environment names', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'env-repo', { worktree: true });
  git(lane.worktreeDir, ['config', 'user.email', 'test@example.com']);
  git(lane.worktreeDir, ['config', 'user.name', 'Test']);
  git(lane.worktreeDir, ['commit', '-q', '--allow-empty', '-m', 'lane commit']);
  const laneHead = git(lane.worktreeDir, ['rev-parse', 'HEAD']).trim();
  const appHead = git(ws.appDir, ['rev-parse', 'HEAD']).trim();
  assert.notEqual(laneHead, appHead);
  // A shell that exported GIT_DIR and GIT_WORK_TREE for the app checkout.
  const env = { ...process.env, GIT_DIR: path.join(ws.appDir, '.git'), GIT_WORK_TREE: ws.appDir, GIT_INDEX_FILE: path.join(ws.appDir, '.git', 'index') };
  const work = await fingerprintWork({ rootDir: ws.rootDir, laneDir: lane.laneDir, worktrees: { app: lane.worktreeDir }, projectRepos: [{ id: 'app' }], env });
  assert.equal(work.covers.worktrees[0].head, laneHead, 'the worktree is read, not the repository the environment names');
});

test('a repository\'s own transport setting lets no relay read fetch, where protocol.allow on the command line alone would', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'transport-lane');
  const source = path.join(ws.tempDir, 'source');
  await mkdir(source);
  git(source, ['init', '-q', '-b', 'main']);
  git(source, ['config', 'user.email', 'test@example.com']);
  git(source, ['config', 'user.name', 'Test']);
  git(source, ['config', 'uploadpack.allowFilter', 'true']);
  await writeFile(path.join(source, 'f.txt'), 'a\n', 'utf8');
  git(source, ['add', '.']);
  git(source, ['commit', '-q', '-m', 'A']);
  await writeFile(path.join(source, 'f.txt'), 'b\n', 'utf8');
  git(source, ['commit', '-q', '-am', 'B']);
  const clone = path.join(ws.tempDir, 'clone');
  git(ws.tempDir, ['clone', '-q', '--filter=blob:none', `file://${source}`, clone]);
  git(clone, ['reset', '-q', '--soft', 'HEAD~1']);
  // The repository allows its own transport, which outranks a default.
  git(clone, ['config', 'protocol.file.allow', 'always']);
  const objects = async () => (await readdir(path.join(clone, '.git', 'objects'), { recursive: true })).length;
  const before = await objects();
  await assert.rejects(
    fingerprintWork({ rootDir: ws.rootDir, laneDir: lane.laneDir, worktrees: { app: clone }, projectRepos: [{ id: 'app' }] }),
    /git diff --cached failed in Lane worktree app at .+(not allowed|could not fetch)/,
  );
  assert.equal(await objects(), before, 'nothing was fetched');
  // The control: the command-line default alone gives way to the setting.
  const env = { ...process.env };
  delete env.GIT_NO_LAZY_FETCH;
  delete env.GIT_ALLOW_PROTOCOL;
  spawnSync('git', ['-c', 'protocol.allow=never', 'diff', '--cached', '--binary'], { cwd: clone, env, encoding: 'utf8' });
  assert.ok((await objects()) > before, 'protocol.allow=never alone fetched');
});

test('a named directory reached through a symbolic link into a repository is that repository\'s: git missing refuses it, never walks it', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'alias-lane');
  await writeFile(path.join(ws.appDir, '.gitignore'), 'cache.bin\n', 'utf8');
  await mkdir(path.join(ws.appDir, 'src', 'lib'));
  await writeFile(path.join(ws.appDir, 'src', 'lib', 'keep.js'), 'kept\n', 'utf8');
  await writeFile(path.join(ws.appDir, 'src', 'lib', 'cache.bin'), 'ignored\n', 'utf8');
  // A folder no repository holds, with a link to a folder inside the app
  // checkout (not its top, where the lookup for .git would go through the
  // link), and the named directory below the link.
  const plain = path.join(ws.tempDir, 'plain');
  await mkdir(plain);
  await symlink(path.join(ws.appDir, 'src'), path.join(plain, 'alias'));
  const projectRepos = [{ id: 'plain', path: 'plain' }];
  const withGit = await fingerprintWork({ rootDir: ws.rootDir, laneDir: lane.laneDir, paths: ['plain:alias/lib'], projectRepos });
  assert.equal(withGit.covers.paths[0].covered, 1);
  assert.equal(withGit.covers.paths[0].ignored, 1);
  const noGit = { ...process.env, PATH: path.join(ws.tempDir, 'no-such-bin') };
  await assert.rejects(
    fingerprintWork({ rootDir: ws.rootDir, laneDir: lane.laneDir, paths: ['plain:alias/lib'], projectRepos, env: noGit }),
    /git couldn't read the repository at \S+\/app \(.+\), so the relay doesn't read .+alias\/lib as plain files/,
  );
});

test('a tracked file losing its executable bit changes the work, with group and other execute bits still set', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'mode-lane', { worktree: true });
  const script = path.join(lane.worktreeDir, 'run.sh');
  await writeFile(script, '#!/bin/sh\necho hi\n', 'utf8');
  await chmod(script, 0o755);
  git(lane.worktreeDir, ['add', 'run.sh']);
  git(lane.worktreeDir, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'script']);
  const marked = await mark(ws, lane);
  assert.equal(marked.code, 0, marked.stderr());
  await chmod(script, 0o655);
  // The control: git records the change.
  assert.match(git(lane.worktreeDir, ['diff', '--summary']), /mode change 100755 => 100644 run\.sh/);
  const compared = await compare(ws, lane);
  assert.equal(compared.current, false, 'the mode change counts');
  assert.deepEqual(compared.differences, ['work']);
});

test('a named directory over a submodule that isn\'t checked out changes when the submodule\'s commit changes', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'gitlink-lane');
  const lib = path.join(ws.tempDir, 'lib');
  await mkdir(lib);
  git(lib, ['init', '-q', '-b', 'main']);
  git(lib, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '--allow-empty', '-m', 'one']);
  git(ws.appDir, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib']);
  git(ws.appDir, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'vendor lib']);
  git(ws.appDir, ['submodule', 'deinit', '-q', '-f', 'vendor/lib']);
  const projectRepos = [{ id: 'app' }];
  const first = await fingerprintWork({ rootDir: ws.rootDir, laneDir: lane.laneDir, paths: ['app:vendor'], projectRepos });
  assert.equal(first.covers.paths[0].covered, 1);
  // The submodule's entry now names another commit; nothing is checked out.
  const other = git(ws.appDir, ['rev-parse', 'HEAD']).trim();
  git(ws.appDir, ['update-index', '--cacheinfo', `160000,${other},vendor/lib`]);
  assert.equal(git(ws.appDir, ['diff', '--cached', '--name-only']).trim(), 'vendor/lib', 'the control: git sees the change');
  const second = await fingerprintWork({ rootDir: ws.rootDir, laneDir: lane.laneDir, paths: ['app:vendor'], projectRepos });
  assert.notEqual(second.fingerprint, first.fingerprint, 'the new commit counts');
});

test('a tracked folder replaced by a symbolic link: nothing past the link is read, and the link counts', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'link-lane', { worktree: true });
  await mkdir(path.join(lane.worktreeDir, 'lib'));
  await writeFile(path.join(lane.worktreeDir, 'lib', 'a.txt'), 'tracked\n', 'utf8');
  git(lane.worktreeDir, ['add', 'lib']);
  git(lane.worktreeDir, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'lib']);
  const first = await mark(ws, lane);
  assert.equal(first.code, 0, first.stderr());
  // The folder becomes a link to one outside the checkout, with the same file in it.
  const outside = path.join(ws.tempDir, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'a.txt'), 'tracked\n', 'utf8');
  await rm(path.join(lane.worktreeDir, 'lib'), { recursive: true });
  await symlink(outside, path.join(lane.worktreeDir, 'lib'));
  assert.equal((await compare(ws, lane)).current, false, 'the replacement counts');
  const second = await mark(ws, lane);
  assert.equal(second.code, 0, second.stderr());
  // A change past the link is never read.
  await writeFile(path.join(outside, 'a.txt'), 'changed outside\n', 'utf8');
  assert.equal((await compare(ws, lane)).current, true, 'nothing past the link counts');
  // Pointing the link elsewhere counts.
  const elsewhere = path.join(ws.tempDir, 'elsewhere');
  await mkdir(elsewhere);
  await unlink(path.join(lane.worktreeDir, 'lib'));
  await symlink(elsewhere, path.join(lane.worktreeDir, 'lib'));
  assert.equal((await compare(ws, lane)).current, false, 'the link\'s new target counts');
});

test('ready-for-review writes its mark under the memory-root lock: it waits while the relay holds the lock to check and send a prompt', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'locked-mark', { worktree: true });
  let entered;
  const inside = new Promise((resolve) => {
    entered = resolve;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const holder = withMemoryRootLock(ws.rootDir, 'review-relay', async () => {
    entered();
    await gate;
  });
  await inside;
  const marking = mark(ws, lane);
  for (let tries = 0; tries < 30; tries += 1) {
    assert.equal(await readReadyMark(lane.laneDir), null, 'no mark while the lock is held');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  release();
  await holder;
  const done = await marking;
  assert.equal(done.code, 0, done.stderr());
  assert.ok(done.mark, 'the mark lands once the lock is let go');
});

test('a named directory over a submodule in a merge conflict changes when any stage\'s commit changes', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'conflict-lane');
  const lib = path.join(ws.tempDir, 'lib');
  await mkdir(lib);
  git(lib, ['init', '-q', '-b', 'main']);
  git(lib, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '--allow-empty', '-m', 'one']);
  git(ws.appDir, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib']);
  git(ws.appDir, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'vendor lib']);
  git(ws.appDir, ['submodule', 'deinit', '-q', '-f', 'vendor/lib']);
  const commits = [git(ws.appDir, ['rev-parse', 'HEAD']).trim(), git(lib, ['rev-parse', 'HEAD']).trim(), git(ws.appDir, ['rev-parse', 'HEAD~1']).trim()];
  // The submodule's entry as a merge leaves it in conflict: three stages.
  const stages = (second) => `0 ${'0'.repeat(40)}\tvendor/lib\n160000 ${commits[0]} 1\tvendor/lib\n160000 ${second} 2\tvendor/lib\n160000 ${commits[2]} 3\tvendor/lib\n`;
  spawnSync('git', ['update-index', '--index-info'], { cwd: ws.appDir, input: stages(commits[1]), encoding: 'utf8' });
  assert.equal(git(ws.appDir, ['ls-files', '--unmerged']).trim().split('\n').length, 3, 'the control: three stages');
  const projectRepos = [{ id: 'app' }];
  const first = await fingerprintWork({ rootDir: ws.rootDir, laneDir: lane.laneDir, paths: ['app:vendor'], projectRepos });
  // Only stage 2's commit changes.
  spawnSync('git', ['update-index', '--index-info'], { cwd: ws.appDir, input: stages(commits[0]), encoding: 'utf8' });
  assert.match(git(ws.appDir, ['ls-files', '--unmerged']), new RegExp(`${commits[0]} 2\tvendor/lib`));
  const second = await fingerprintWork({ rootDir: ws.rootDir, laneDir: lane.laneDir, paths: ['app:vendor'], projectRepos });
  assert.notEqual(second.fingerprint, first.fingerprint, 'the stage-2 commit counts');
});

test('a working file is read through one handle that no link in any part of its path can redirect', async (t) => {
  const ws = await createWorkspace(t);
  const inside = path.join(await realpath(ws.tempDir), 'inside');
  await mkdir(path.join(inside, 'dir'), { recursive: true });
  await writeFile(path.join(inside, 'dir', 'f.txt'), 'tracked\n', 'utf8');
  assert.equal(await readWorkingFileHash(path.join(inside, 'dir', 'f.txt')), createHash('sha256').update('tracked\n').digest('hex'));
  // A FIFO opens without waiting, and isn't read.
  spawnSync('mkfifo', [path.join(inside, 'pipe')]);
  assert.equal(await readWorkingFileHash(path.join(inside, 'pipe')), 'special');
  if (process.platform !== 'darwin') return;
  // On macOS a folder that became a link after it was checked can't lead the
  // read elsewhere: the open refuses a link in any part of the path.
  const outside = path.join(await realpath(ws.tempDir), 'outside');
  await mkdir(path.join(outside, 'dir'), { recursive: true });
  await writeFile(path.join(outside, 'dir', 'f.txt'), 'outside\n', 'utf8');
  await symlink(outside, path.join(inside, 'swapped'));
  assert.equal(await readWorkingFileHash(path.join(inside, 'swapped', 'dir', 'f.txt')), null, 'a link part-way is refused');
  await symlink(path.join(outside, 'dir', 'f.txt'), path.join(inside, 'leaf'));
  assert.equal(await readWorkingFileHash(path.join(inside, 'leaf')), null, 'so is a link at the end');
  assert.ok(WORKING_READ_FLAGS & 0x20000000, 'O_NOFOLLOW_ANY');
});
