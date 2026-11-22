import assert from 'node:assert/strict';
import { readFile, rm, unlink, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../cli.js';
import { compareMark, fingerprintWork, readReadyMark, writeReadyMark } from '../relay-mark.js';
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

test('writeReadyMark refuses work that names nothing', async (t) => {
  const ws = await createWorkspace(t);
  const lane = await openLane(ws, 'api-lane');
  await assert.rejects(writeReadyMark({ rootDir: ws.rootDir, laneId: lane.laneId, laneDir: lane.laneDir }), /name the work under review/);
});
