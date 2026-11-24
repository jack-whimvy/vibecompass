import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../cli.js';
import { readReadyMark } from '../relay-mark.js';
import { prepareRelayWrite } from '../relay-record.js';
import { computeCurrentFingerprints } from '../relay-mark.js';
import { createProcessTable, emptyRelayState, findMarkedProcesses, readRelayState, saveRelayState } from '../relay-state.js';
import { coveredRepositories } from '../review-relay.js';
import { withMemoryRootLock } from '../serialization.js';
import { REVIEWER_TO_BUILDER_HEADING, readSectionBody } from '../relay-sections.js';
import { extractReviewLogLines, parseReviewLog } from '../review-log.js';
import { closeProjectSession, listProjectSessions } from '../session.js';
import {
  CLI_PATH,
  captureIo,
  createWorkspace,
  git,
  installStandins,
  openLane,
  writeReviewLog,
} from './fixtures/relay-fixtures.js';

// D-419 item 17's relay tests with scripted stand-ins for both tools: each
// stop, a restart, a handoff or work that changes during a review, an invalid
// reviewer answer, a refused builder action, the cap, the builder's turn,
// reviewer versions and events, and the concurrency group's relay cases.

const CONV = '7f3c2a10-1111-4222-8333-444455556666';
const SUPPORTED = { codex: { darwin: ['0.171.0'] }, claude: { darwin: ['2.1.318'] } };
const HARNESS = new URL('./fixtures/relay-harness.js', import.meta.url).pathname;
const CLEAN_ANSWER = { read: 'the diff and the handoff', verdicts: [], findings: [], summary: 'Nothing found.' };
const ONE_FINDING = { read: 'the diff', verdicts: [], findings: [{ severity: 'P2', finding: 'the parser accepts a bad time', evidence: ['src/index.js:1'] }], summary: 'One finding.' };
const CONFIRM_R11 = { read: 'response 1 and the fix', verdicts: [{ id: 'R1.1', status: 'confirmed', severity: 'P2', reason: 'fixed in the pattern', evidence: [] }], findings: [], summary: 'Confirmed.' };
const CLOSE = { title: 'Relay Close', completed: ['x'], nextSteps: ['y'], documentMaintenance: { architectureDocs: 'updated', decisionLog: 'updated', sessionMaintenance: 'updated' } };

function answerR11(lane, { mark = true, response = true } = {}) {
  return [
    ...(response ? [{ type: 'append-review-log', lines: ['- response 1 | 2026-11-21 22:00 -08:00 | Claude Opus 5.5', '  - R1.1 | P2 | accepted | fixed the time pattern'] }] : []),
    { type: 'write-file', path: path.join(lane.worktreeDir, 'src', 'index.js'), content: 'export const answer = 43;\n' },
    ...(mark ? [{ type: 'mark-ready' }] : []),
  ];
}

function parse(content) {
  return parseReviewLog(extractReviewLogLines(content).lines);
}

async function setup(t, { review = ['check: block'], scenario = {}, laneId = 'relay-lane' } = {}) {
  const ws = await createWorkspace(t, { review });
  const lane = await openLane(ws, laneId, { worktree: true });
  const standin = await installStandins(t, ws, lane, { codex: { version: '0.171.0', reviewTurns: [] }, claude: { version: '2.1.318' }, ...scenario });
  const home = path.join(ws.tempDir, 'home');
  const signals = new EventEmitter();
  const relay = async (extra = [], overrides = {}) => {
    const capture = captureIo();
    const code = await runCli(['review-relay', '--root', ws.rootDir, '--session', lane.laneId, ...extra], capture.io, {
      cwd: ws.tempDir,
      env: standin.env,
      platform: 'darwin',
      supportedReviewerVersions: SUPPORTED,
      userInfo: { homedir: home },
      signals,
      confirm: null,
      ...overrides,
    });
    return { code, out: capture.stdout(), err: capture.stderr() };
  };
  const mark = async (conversationId = CONV) => {
    const capture = captureIo();
    const code = await runCli(['ready-for-review', '--root', ws.rootDir, '--session', lane.laneId], capture.io, { cwd: ws.tempDir, env: { ...process.env, CLAUDE_CODE_SESSION_ID: conversationId ?? '' } });
    assert.equal(code, 0, capture.stderr());
  };
  const wip = () => readFile(lane.wipPath, 'utf8');
  const handoff = () => readFile(lane.handoffPath, 'utf8');
  return { ws, lane, standin, relay, mark, home, signals, wip, handoff };
}

const codexArgs = ['--reviewer-model', 'gpt-test'];

test('one pass: the relay writes the reviewer\'s answer as the pass and stops clean', async (t) => {
  const s = await setup(t, { scenario: { codex: { version: '0.171.0', reviewTurns: [{ answer: CLEAN_ANSWER, threadId: 'thread-1' }] } } });
  await s.mark(null);
  const result = await s.relay(codexArgs);
  assert.equal(result.code, 0, result.out + result.err);
  assert.match(result.out, /Review relay on lane relay-lane: one pass; reviewer Codex 0\.171\.0 \(gpt-test\); cap 3, ceiling 3\./);
  assert.match(result.out, /Stopped: pass 1 is clean: nothing is open or waiting\./);
  assert.match(result.out, /close the lane in the builder's conversation; the relay never closes/);
  const parsed = parse(await s.wip());
  assert.equal(parsed.passCount, 1);
  assert.equal(parsed.passes[0].reviewer, 'Codex 0.171.0 (gpt-test requested) via the relay');
  assert.match(parsed.passes[0].scope, /^relay write [0-9a-f]{12}, round [0-9a-f]{12}; the diff and the handoff$/);
  assert.match(readSectionBody(await s.handoff(), REVIEWER_TO_BUILDER_HEADING), /^Relay write [0-9a-f]{12}: pass 1 by Codex 0\.171\.0/);
  const [call] = (await s.standin.calls()).filter((item) => item.kind === 'review');
  assert.deepEqual(call.args.slice(0, 5), ['exec', '-s', 'read-only', '--ignore-user-config', '--ignore-rules']);
  assert.deepEqual(call.args.slice(call.args.indexOf('-m'), call.args.indexOf('-m') + 4), ['-m', 'gpt-test', '--output-schema', path.join(s.lane.laneDir, 'relay-turns', 'answer-schema.json')]);
  assert.ok(call.args.join(' ').includes('--disable hooks --disable apps --disable plugins'));
  assert.ok(call.args.includes('--json') && call.args.includes('-o'));
  assert.ok(call.args.includes('--skip-git-repo-check'), 'the workspace folder (the tooling root) is not a git repository');
  assert.match(call.prompt, /^review handoff relay-lane\n/);
  assert.equal(call.cwd, s.ws.tempDir, 'the reviewer runs in the tooling root');
  assert.equal(call.relayTurn, false);
  const stage = (await listProjectSessions({ cwd: s.ws.tempDir, rootDir: s.ws.rootDir })).inventory.lanes[0];
  assert.equal(stage.stage, 'review clean');
  const state = await readRelayState(s.lane.laneDir);
  assert.equal(state.write.state, 'complete');
  assert.equal(state.reviewer.thread_id, 'thread-1');
  assert.equal(state.last_stop.kind, 'clean');
  // Locks are released at the stop.
  assert.equal(existsSync(path.join(s.lane.laneDir, 'relay.lock')), false);
});

test('one pass with findings stops for the builder; a second run on the same round runs no second pass', async (t) => {
  const s = await setup(t, { scenario: { codex: { version: '0.171.0', reviewTurns: [{ answer: ONE_FINDING }] } } });
  await s.mark(null);
  const first = await s.relay(codexArgs);
  assert.equal(first.code, 0);
  assert.match(first.out, /Pass 1 recorded \(findings\) by Codex 0\.171\.0 \(gpt-test requested\) via the relay:\n- R1\.1 \(P2\) open: the parser accepts a bad time/);
  assert.match(first.out, /Stopped: pass 1 is recorded\./);
  assert.match(first.out, /type `address review relay-lane` in the builder's window/);
  const second = await s.relay(codexArgs);
  assert.equal(second.code, 0);
  assert.match(second.out, /pass 1 on this round is already recorded; the builder answers it\./);
  assert.equal((await s.standin.calls()).filter((item) => item.kind === 'review').length, 1);
  assert.equal(parse(await s.wip()).passCount, 1);
});

test('the loop: a pass, the builder\'s fixed turn, and a resumed reviewer thread until a clean pass', async (t) => {
  const s = await setup(t);
  await s.standin.setScenario({
    codex: { version: '0.171.0', reviewTurns: [{ answer: ONE_FINDING, threadId: 'thread-9' }, { answer: CONFIRM_R11 }] },
    claude: { version: '2.1.318', builderTurns: [{ hooksBefore: 3, actions: answerR11(s.lane) }] },
  });
  await s.mark();
  const result = await s.relay([...codexArgs, '--conversation-closed'], { env: { ...s.standin.env, GH_TOKEN: 'should-not-pass', GITHUB_TOKEN: 'nor-this' } });
  assert.equal(result.code, 0, result.out + result.err);
  assert.match(result.out, /loop with Claude Code conversation 7f3c2a10/);
  assert.match(result.out, /Response 1 by Claude Opus 5\.5:\n- R1\.1 accepted: fixed the time pattern/);
  assert.match(result.out, /Stopped: pass 2 is clean/);
  assert.match(result.out, new RegExp(`Reopen the builder's conversation: claude --resume ${CONV}`));
  const calls = await s.standin.calls();
  const reviews = calls.filter((item) => item.kind === 'review');
  assert.equal(reviews.length, 2);
  assert.deepEqual(reviews[1].args.slice(0, 3), ['exec', 'resume', 'thread-9']);
  assert.ok(!reviews[1].args.includes('-s'), 'resume takes no sandbox flag');
  const [builder] = calls.filter((item) => item.kind === 'builder');
  assert.deepEqual(builder.args.slice(0, 9), ['-p', '--resume', CONV, '--permission-mode', 'default', '--output-format', 'stream-json', '--verbose', '--disallowedTools']);
  assert.ok(builder.args.includes('Bash(git push:*)') && builder.args.includes('Bash(*close-session*)') && builder.args.includes('Bash(*review-relay*)'));
  assert.ok(!builder.args.some((arg) => /dangerously|bypassPermissions/.test(arg)));
  assert.match(builder.prompt, /^address review relay-lane\n\nThe review relay recorded pass 1/);
  assert.doesNotMatch(builder.prompt, /parser accepts/, 'no reviewer words reach the builder\'s prompt');
  assert.equal(builder.relayTurn, true);
  assert.equal(builder.env.GIT_CONFIG_COUNT, '6');
  assert.equal(builder.env.GH_TOKEN, null);
  assert.equal(builder.env.GITHUB_TOKEN, null);
  assert.match(builder.env.GH_CONFIG_DIR, /relay-turns\/gh-config-empty$/);
  assert.equal(builder.cwd, s.ws.tempDir);
  const parsed = parse(await s.wip());
  assert.equal(parsed.passCount, 2);
  assert.ok(parsed.findings.every((finding) => finding.resolved));
  const close = await closeProjectSession({ cwd: s.ws.tempDir, rootDir: s.ws.rootDir, sessionId: s.lane.laneId, ...CLOSE });
  assert.equal(close.review.checkLine, 'passed');
  assert.match(close.review.passesLine, /2 against a cap of 3; reviewers: Codex 0\.171\.0 \(gpt-test requested\) via the relay/);
});

test('the loop asks the owner to confirm the conversation is closed', async (t) => {
  const s = await setup(t, { scenario: { codex: { version: '0.171.0', reviewTurns: [{ answer: CLEAN_ANSWER }] } } });
  await s.mark();
  const noTerminal = await s.relay(codexArgs);
  assert.equal(noTerminal.code, 1);
  assert.match(noTerminal.out, /the owner confirms that conversation 7f3c2a10-1111-4222-8333-444455556666 is closed and was started in .*Run in a terminal, or pass --conversation-closed/);
  const questions = [];
  const declined = await s.relay(codexArgs, { confirm: async (question) => { questions.push(question); return 'n'; } });
  assert.equal(declined.code, 1);
  assert.match(questions[0], /Is that conversation closed in every terminal, and was it started in this folder\? \[y\/N\]/);
  assert.match(questions[0], new RegExp(`from ${s.ws.tempDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  const accepted = await s.relay(codexArgs, { confirm: async () => 'y' });
  assert.equal(accepted.code, 0);
  assert.equal((await s.standin.calls()).filter((item) => item.kind === 'review').length, 1);
  // --one-pass keeps the window open: no question, one pass.
});

test('no mark, a changed mark, and a finding waiting for the builder each stop before any pass', async (t) => {
  const s = await setup(t, { scenario: { codex: { version: '0.171.0', reviewTurns: [{ answer: CLEAN_ANSWER }] } } });
  const noMark = await s.relay(codexArgs);
  assert.equal(noMark.code, 1);
  assert.match(noMark.out, /has no ready-for-review mark\. The builder runs `vibecompass ready-for-review --root \S+ --session relay-lane`/);
  await s.mark(null);
  await writeFile(path.join(s.lane.worktreeDir, 'README.md'), 'changed after the mark\n', 'utf8');
  const changed = await s.relay(codexArgs);
  assert.equal(changed.code, 1);
  assert.match(changed.out, /Stopped: the work changed since the ready-for-review mark/);
  await s.mark(null);
  await writeReviewLog(s.lane, ['- pass 1 | 2026-11-21 10:00 PST | Codex (GPT-6) | by hand | findings', '  - R1.1 | P2 | open | a hand-run finding']);
  const waiting = await s.relay(codexArgs);
  assert.match(waiting.out, /the record changed since the ready-for-review mark|R1\.1 waits for the builder's response, so no pass runs/);
  assert.equal((await s.standin.calls()).filter((item) => item.kind === 'review').length, 0, 'no pass budget spent');
});

test('the work changing during the review discards the answer and writes nothing', async (t) => {
  const s = await setup(t);
  await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: CLEAN_ANSWER, actions: [{ type: 'write-file', path: path.join(s.lane.worktreeDir, 'README.md'), content: 'edited during the review\n' }] }] } });
  await s.mark(null);
  const result = await s.relay(codexArgs);
  assert.equal(result.code, 1);
  assert.match(result.out, /Stopped: the work changed during the review, so its answer is discarded and nothing was written\./);
  assert.equal(parse(await s.wip()).passCount, 0);
  assert.doesNotMatch(await s.handoff(), /Relay write/);
});

test('a change only to what is staged during a review discards the verdict', async (t) => {
  const s = await setup(t);
  const file = path.join(s.lane.worktreeDir, 'README.md');
  await writeFile(file, 'hello\nstaged\n', 'utf8');
  git(s.lane.worktreeDir, ['add', 'README.md']);
  await writeFile(file, 'hello\n', 'utf8');
  await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: CLEAN_ANSWER, actions: [{ type: 'write-file', path: path.join(s.ws.tempDir, 'stage-now'), content: '' }] }] } });
  await s.mark(null);
  // The stand-in's action can't run git, so the test stages while the turn
  // waits: once the reviewer has its prompt, after the first comparison.
  const prompted = path.join(s.ws.tempDir, 'reviewer-prompted');
  await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: CLEAN_ANSWER, promptMarker: prompted, waitFor: path.join(s.ws.tempDir, 'staged-now') }] } });
  const running = s.relay(codexArgs);
  while (!existsSync(prompted)) await new Promise((resolve) => setTimeout(resolve, 25));
  git(s.lane.worktreeDir, ['add', 'README.md']);
  await writeFile(path.join(s.ws.tempDir, 'staged-now'), '', 'utf8');
  const result = await running;
  assert.equal(result.code, 1);
  assert.match(result.out, /the work changed during the review/);
  assert.equal(parse(await s.wip()).passCount, 0);
});

test('an invalid answer writes nothing and is kept in relay.json', async (t) => {
  const s = await setup(t);
  await writeReviewLog(s.lane, [
    '- pass 1 | 2026-11-21 10:00 PST | Codex (GPT-6) | by hand | findings',
    '  - R1.1 | P2 | open | one',
    '  - R1.2 | P3 | open | two',
    '- response 1 | 2026-11-21 10:30 PST | Claude Opus 5.5',
    '  - R1.1 | P2 | accepted | fixed',
    '  - R1.2 | P3 | rejected | not a bug',
  ]);
  const missing = { read: 'responses', verdicts: [{ id: 'R1.1', status: 'confirmed', severity: 'P2', reason: 'ok', evidence: [] }], findings: [], summary: 's' };
  await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: missing }, { answer: 'not json' }] } });
  await s.mark(null);
  const result = await s.relay(codexArgs);
  assert.equal(result.code, 1);
  assert.match(result.out, /the reviewer's answer is invalid: no verdict on R1\.2, which waits for the reviewer\. Nothing was written; the answer is kept in .*relay\.json/);
  const state = await readRelayState(s.lane.laneDir);
  assert.equal(state.answer.valid, false);
  assert.deepEqual(state.answer.raw, missing);
  assert.equal(parse(await s.wip()).passCount, 1);
  const unreadable = await s.relay(codexArgs);
  assert.match(unreadable.out, /the reviewer's answer is invalid: the answer couldn't be read/);
});

test('reviewer versions: only exact listed versions reach the launch', async (t) => {
  const s = await setup(t);
  await s.mark(null);
  const listed = { codex: { darwin: ['0.170.0', '0.172.0'] }, claude: { darwin: [] } };
  for (const [version, expected] of [['0.170.0', 0], ['0.172.0', 0], ['0.171.0', 1], ['0.180.0', 1]]) {
    await s.standin.setScenario({ codex: { version, reviewTurns: [{ answer: { ...ONE_FINDING } }] } });
    // Each run starts from a fresh log and mark.
    await writeReviewLog(s.lane, []);
    await s.mark(null);
    const before = (await s.standin.calls()).filter((item) => item.kind === 'review').length;
    const result = await s.relay(codexArgs, { supportedReviewerVersions: listed });
    const after = (await s.standin.calls()).filter((item) => item.kind === 'review').length;
    assert.equal(after - before, expected === 0 ? 1 : 0, `version ${version}`);
    if (expected === 1) {
      assert.match(result.out, new RegExp(`Codex ${version.replaceAll('.', '\\.')} isn't a supported reviewer version on darwin \\(supported: 0\\.170\\.0, 0\\.172\\.0\\)`));
      assert.match(result.out, /the Claude Code reviewer \(`--reviewer claude`\), which has no supported version on this platform either, or hand-run review/);
    }
  }
  const disabled = await s.relay(codexArgs, { supportedReviewerVersions: { codex: { darwin: [] }, claude: { darwin: [] } } });
  assert.match(disabled.out, /The Codex reviewer isn't enabled on darwin: no Codex version has passed its capability checks there yet/);
  // The package's own list: an adapter is enabled only once its checks hold.
  const packaged = await s.relay(codexArgs, { supportedReviewerVersions: undefined });
  assert.equal(packaged.code, 1);
});

test('a Claude Code reviewer: a pass whose init lists the built-in plugins counts; a hook event, an MCP server, or another plugin discards the turn', async (t) => {
  const s = await setup(t);
  await s.standin.setScenario({ claude: { version: '2.1.318', reviewTurns: [{ answer: ONE_FINDING, newSessionId: 'rev-conv-1', model: 'claude-opus-5-5' }, { answer: CLEAN_ANSWER, hookAfterInit: true }, { answer: CLEAN_ANSWER, mcpServers: [{ name: 'evil', status: 'connected' }] }, { answer: CLEAN_ANSWER, plugins: [{ name: 'market-plugin', path: '/plugins/market-plugin', source: 'market-plugin@market' }] }] } });
  await s.mark(null);
  const first = await s.relay(['--reviewer', 'claude']);
  assert.equal(first.code, 0, first.out);
  assert.equal(parse(await s.wip()).passes[0].reviewer, 'Claude Code 2.1.318 (claude-opus-5-5) via the relay');
  const [call] = (await s.standin.calls()).filter((item) => item.kind === 'review');
  for (const flag of ['-p', '--safe-mode', '--restricted', '--strict-mcp-config', '--include-hook-events', '--json-schema']) assert.ok(call.args.includes(flag), flag);
  // The memory root and the lane's worktrees sit inside the tooling root, so no folder is added.
  assert.ok(!call.args.includes('--add-dir'));
  assert.equal(call.args[call.args.indexOf('--tools') + 1], 'Read,Glob,Grep,Bash');
  assert.equal(call.args[call.args.indexOf('--permission-mode') + 1], 'default');
  assert.ok(call.args.includes('mcp__*') && call.args.includes('Edit') && call.args.includes('Write'));
  // The builder answers by hand, then the next passes resume the relay's own conversation.
  const wip = await s.wip();
  await writeFile(s.lane.wipPath, `${wip.replace(/\n*$/, '')}\n- response 1 | 2026-11-21 22:00 -08:00 | Claude Opus 5.5\n  - R1.1 | P2 | accepted | fixed\n`, 'utf8');
  await s.mark(null);
  const hooked = await s.relay(['--reviewer', 'claude']);
  assert.equal(hooked.code, 1);
  assert.match(hooked.out, /the reviewer's stream shows a hook event \(hook_response PreToolUse\); a hook ran, so the turn is discarded/);
  const reviews = (await s.standin.calls()).filter((item) => item.kind === 'review');
  assert.equal(reviews[1].args[reviews[1].args.indexOf('--resume') + 1], 'rev-conv-1');
  const mcp = await s.relay(['--reviewer', 'claude']);
  assert.match(mcp.out, /the reviewer's init lists an MCP server \(evil\)/);
  const plugin = await s.relay(['--reviewer', 'claude']);
  assert.equal(plugin.code, 1);
  assert.match(plugin.out, /the reviewer's init lists a plugin \(market-plugin\)/);
  assert.equal(parse(await s.wip()).passCount, 1);
});

for (const [name, turn, pattern] of [
  ['an event of another kind before init', { earlyEvent: 'assistant' }, /the builder's stream had an event \(assistant\) before init; the relay ended the turn/],
  ['a stream with no init', { noInit: true }, /the builder's stream ended without an init event/],
  ['a mode other than the one passed', { initMode: 'bypassPermissions' }, /the builder ran in permission mode bypassPermissions, not default/],
  ['another conversation\'s id', { initSessionId: '00000000-0000-4000-8000-000000000000' }, /the builder's init names conversation 00000000-0000-4000-8000-000000000000, not 7f3c2a10/],
]) {
  test(`the builder's turn: ${name} stops the relay`, async (t) => {
    const s = await setup(t);
    await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: ONE_FINDING }] }, claude: { version: '2.1.318', builderTurns: [{ ...turn, actions: answerR11(s.lane) }] } });
    await s.mark();
    const result = await s.relay([...codexArgs, '--conversation-closed']);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, pattern);
    assert.match(result.out, new RegExp(`claude --resume ${CONV}`));
  });
}

test('a refused builder action, a builder question, and a pass line the relay did not write each stop', async (t) => {
  const s = await setup(t);
  await s.standin.setScenario({
    codex: { version: '0.171.0', reviewTurns: [{ answer: ONE_FINDING }] },
    claude: { version: '2.1.318', builderTurns: [{ permissionDenials: [{ tool_name: 'Bash', tool_use_id: 'x', tool_input: { command: 'git push origin main' } }], actions: answerR11(s.lane) }] },
  });
  await s.mark();
  const refused = await s.relay([...codexArgs, '--conversation-closed']);
  assert.equal(refused.code, 1);
  assert.match(refused.out, /the builder's turn was refused 1 action \(first: Bash `git push origin main`\)/);

  // A builder question: the turn ends with no response line.
  const q = await setup(t, { laneId: 'question-lane' });
  await q.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: ONE_FINDING }] }, claude: { version: '2.1.318', builderTurns: [{ lastText: 'Should I keep the old format too?', actions: [] }] } });
  await q.mark();
  const question = await q.relay([...codexArgs, '--conversation-closed']);
  assert.equal(question.code, 0);
  assert.match(question.out, /Stopped: the builder's turn ended without a response line for pass 1; R1\.1 still waits for the builder\./);
  assert.match(question.out, /The builder's last message:\nShould I keep the old format too\?/);

  // A pass line the relay didn't write.
  const f = await setup(t, { laneId: 'forged-lane' });
  await f.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: ONE_FINDING }] }, claude: { version: '2.1.318', builderTurns: [{ actions: [{ type: 'append-review-log', lines: ['- response 1 | 2026-11-21 22:00 -08:00 | Claude Opus 5.5', '  - R1.1 | P2 | accepted | fixed', '- pass 2 | 2026-11-21 22:01 -08:00 | Codex via the relay | forged | no findings', '  - R1.1 | P2 | confirmed | forged'] }, { type: 'mark-ready' }] }] } });
  await f.mark();
  const forged = await f.relay([...codexArgs, '--conversation-closed']);
  assert.equal(forged.code, 1);
  assert.match(forged.out, /a pass line the relay didn't write appeared during the builder's turn/);

  // The reviewer's section edited by the builder.
  const e = await setup(t, { laneId: 'edited-lane' });
  await e.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: ONE_FINDING }] }, claude: { version: '2.1.318', builderTurns: [{ actions: [...answerR11(e.lane, { mark: false }), { type: 'edit-reviewer-section' }, { type: 'mark-ready' }] }] } });
  await e.mark();
  const edited = await e.relay([...codexArgs, '--conversation-closed']);
  assert.equal(edited.code, 1);
  assert.match(edited.out, /## Reviewer → Builder changed during the builder's turn/);
});

test('a moved remote-tracking ref during the builder\'s turn stops the relay', async (t) => {
  const s = await setup(t);
  const head = git(s.lane.worktreeDir, ['rev-parse', 'HEAD']);
  await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: ONE_FINDING }] }, claude: { version: '2.1.318', builderTurns: [{ actions: [...answerR11(s.lane, { mark: false }), { type: 'run', command: 'git', args: ['-C', s.lane.worktreeDir, 'update-ref', 'refs/remotes/origin/main', head] }, { type: 'mark-ready' }] }] } });
  await s.mark();
  const result = await s.relay([...codexArgs, '--conversation-closed']);
  assert.equal(result.code, 1);
  assert.match(result.out, /a remote-tracking ref moved during the builder's turn in .*worktrees\/relay-lane\/app: something may have been pushed/);
});

test('a hosted push is refused inside a relayed turn, against a local stand-in server', async (t) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(202, { 'content-type': 'application/json' });
    response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const s = await setup(t);
  const projectPath = path.join(s.ws.rootDir, 'project.yaml');
  await writeFile(projectPath, `${(await readFile(projectPath, 'utf8')).replace('mode: local-only', 'mode: local-primary')}sync:\n  provider: vibecompass\n  api_url: http://127.0.0.1:${server.address().port}\n  project_id: 00000000-0000-4000-8000-000000000001\n  credential_source: env\n  credential_env_var: RELAY_TEST_SYNC_TOKEN\n`, 'utf8');
  git(s.ws.rootDir, ['add', 'project.yaml']);
  git(s.ws.rootDir, ['commit', '-q', '-m', 'bind']);
  const pushArgs = [CLI_PATH, 'push', '--root', s.ws.rootDir];
  await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: ONE_FINDING }] }, claude: { version: '2.1.318', builderTurns: [{ actions: [...answerR11(s.lane, { mark: false }), { type: 'run', command: 'node', args: pushArgs }, { type: 'run', command: 'node', args: [CLI_PATH, 'close-session', '--root', s.ws.rootDir, '--session', s.lane.laneId, '--title', 'x', '--completed', 'x', '--next-step', 'x', '--architecture-docs', 'updated', '--decision-log', 'updated', '--session-maintenance', 'updated'] }, { type: 'mark-ready' }] }] } });
  await s.mark();
  await s.relay([...codexArgs, '--conversation-closed'], { env: { ...s.standin.env, RELAY_TEST_SYNC_TOKEN: 'test-token' } });
  const runs = (await s.standin.calls()).filter((item) => item.action === 'run');
  assert.equal(runs[0].status, 1);
  assert.match(runs[0].stderr, /push is refused inside a relayed builder turn \(VIBECOMPASS_RELAY_TURN is set\)/);
  assert.equal(runs[1].status, 1);
  assert.match(runs[1].stderr, /close-session is refused inside a relayed builder turn/);
  assert.deepEqual(requests, [], 'the stand-in server received nothing');
  assert.ok(existsSync(s.lane.laneDir), 'the lane is still open');
  // Outside a relayed turn the push reaches the stand-in server.
  const outside = captureIo();
  const outsideError = await runCli(['push', '--root', s.ws.rootDir], outside.io, { cwd: s.ws.tempDir, env: { ...process.env, RELAY_TEST_SYNC_TOKEN: 'test-token' } }).then(() => null, (error) => error);
  assert.ok(requests.length > 0, `${outsideError?.message ?? ''} ${outside.stdout()} ${outside.stderr()}`);
});

test('the refusal inside a relayed turn covers every command it names, and nothing else', async () => {
  for (const command of ['close-session', 'end-session', 'review-relay', 'push', 'promote-hosted', 'demote-hosted', 'connect-hosted', 'sync-adopt']) {
    await assert.rejects(runCli([command, '--root', '/nonexistent'], captureIo().io, { env: { VIBECOMPASS_RELAY_TURN: 'token' } }), new RegExp(`^Error: ${command} is refused inside a relayed builder turn|${command} is refused inside a relayed builder turn`));
  }
  const capture = captureIo();
  assert.equal(await runCli(['version'], capture.io, { env: { VIBECOMPASS_RELAY_TURN: 'token' } }), 0);
});

test('the cap: lowered during a run, raised during a run, and --past-cap', async (t) => {
  // Lowered: cap 3, the builder lowers it to 1 after pass 1, and the relay stops at the cap after the answer.
  const low = await setup(t, { review: ['check: block', 'round_cap: 3'], laneId: 'cap-low' });
  await low.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: ONE_FINDING }] }, claude: { version: '2.1.318', builderTurns: [{ actions: [...answerR11(low.lane, { mark: false }), { type: 'run', command: 'node', args: [CLI_PATH, 'review-settings', '--root', low.ws.rootDir, '--round-cap', '1'] }, { type: 'mark-ready' }] }] } });
  await low.mark();
  const lowered = await low.relay([...codexArgs, '--conversation-closed']);
  assert.equal(lowered.code, 0, lowered.out);
  assert.match(lowered.out, /Stopped: the lane has run 1 pass against a cap of 1: the next pass runs past the cap\./);
  assert.match(lowered.out, /run `vibecompass review-relay --root \S+ --session cap-low --reviewer codex --reviewer-model gpt-test --past-cap` for one more pass/);
  assert.match(lowered.out, /- R1\.1 \(P2\) accepted, waiting for the reviewer: the parser accepts a bad time/);

  // Raised: cap 1, the builder raises it to 3; the go is used up, and a new run continues.
  const high = await setup(t, { review: ['check: block', 'round_cap: 1'], laneId: 'cap-high' });
  await high.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: ONE_FINDING }, { answer: CONFIRM_R11 }] }, claude: { version: '2.1.318', builderTurns: [{ actions: [...answerR11(high.lane, { mark: false }), { type: 'run', command: 'node', args: [CLI_PATH, 'review-settings', '--root', high.ws.rootDir, '--round-cap', '3'] }, { type: 'mark-ready' }] }] } });
  await high.mark();
  const raised = await high.relay([...codexArgs, '--conversation-closed']);
  assert.equal(raised.code, 0);
  assert.match(raised.out, /Stopped: this run's go covered 1 passes, and the cap is now 3: the go is used up\./);
  assert.match(raised.out, /run `vibecompass review-relay --root \S+ --session cap-high --reviewer codex --reviewer-model gpt-test` again: a new run continues up to the current cap/);
  const resumed = await high.relay([...codexArgs, '--conversation-closed']);
  assert.match(resumed.out, /Stopped: pass 2 is clean/);

  // --past-cap: refused below the cap; at the cap one pass with an owner line, then the builder's answer, then the stop.
  const past = await setup(t, { review: ['check: block', 'round_cap: 1'], laneId: 'cap-past' });
  await past.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: ONE_FINDING }, { answer: { ...CONFIRM_R11, findings: [{ severity: 'P3', finding: 'a nit', evidence: [] }] } }] }, claude: { version: '2.1.318', builderTurns: [{ actions: answerR11(past.lane) }, { actions: [{ type: 'append-review-log', lines: ['- response 2 | 2026-11-21 23:00 -08:00 | Claude Opus 5.5', '  - R2.1 | P3 | accepted | done'] }, { type: 'write-file', path: path.join(past.lane.worktreeDir, 'nit.txt'), content: 'n\n' }, { type: 'mark-ready' }] }] } });
  await past.mark();
  const below = await past.relay([...codexArgs, '--conversation-closed', '--past-cap']);
  assert.equal(below.code, 1);
  assert.match(below.out, /--past-cap is refused: lane cap-past has run 0 of 1 passes, below the cap\. Run without --past-cap\./);
  const atCap = await past.relay([...codexArgs, '--conversation-closed']);
  assert.match(atCap.out, /Stopped: the lane has run 1 pass against a cap of 1/);
  const pastRun = await past.relay([...codexArgs, '--conversation-closed', '--past-cap']);
  assert.equal(pastRun.code, 0, pastRun.out);
  assert.match(pastRun.out, /Stopped: the lane has run 2 passes against a cap of 1: the next pass runs past the cap\./);
  const parsed = parse(await past.wip());
  assert.equal(parsed.passCount, 2);
  assert.equal(parsed.ownerLines.length, 1);
  assert.equal(parsed.ownerLines[0].choice, 'another round');
  assert.match(parsed.ownerLines[0].reason, /^the owner ran the relay for one pass past the cap \(relay write [0-9a-f]{12}\)$/);
  const check = captureIo();
  await runCli(['review-check', '--root', past.ws.rootDir, '--session', past.lane.laneId], check.io, { cwd: past.ws.tempDir });
  assert.match(check.stdout(), /Passes: 2 against a cap of 1, 1 past it/);
});

test('Ctrl-C during the reviewer\'s turn stops the relay; a restart repeats the pass once', async (t) => {
  const s = await setup(t);
  const started = path.join(s.ws.tempDir, 'reviewer-started');
  const prompted = path.join(s.ws.tempDir, 'reviewer-prompted');
  const release = path.join(s.ws.tempDir, 'never');
  await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: CLEAN_ANSWER, startedMarker: started, promptMarker: prompted, waitFor: release }, { answer: CLEAN_ANSWER }] } });
  await s.mark(null);
  const running = s.relay(codexArgs);
  // Ctrl-C once the prompt is in: the model turn has begun.
  while (!existsSync(prompted)) await new Promise((resolve) => setTimeout(resolve, 50));
  s.signals.emit('SIGINT');
  const stopped = await running;
  assert.equal(stopped.code, 0);
  assert.match(stopped.out, /Stopped: Ctrl-C: the owner stopped the relay during the reviewer's turn; no pass was recorded\./);
  const state = await readRelayState(s.lane.laneDir);
  assert.equal(state.turn.ended.how, 'interrupted');
  assert.equal(state.turn.possibly_partial, true);
  assert.equal(parse(await s.wip()).passCount, 0);
  const pid = Number(await readFile(started, 'utf8'));
  assert.throws(() => process.kill(pid, 0), 'the turn\'s process group was ended');
  const again = await s.relay(codexArgs);
  assert.equal(again.code, 0, again.out);
  assert.equal(parse(await s.wip()).passCount, 1);
});

test('a reviewer turn past its timeout ends the group and stops', async (t) => {
  const s = await setup(t, { scenario: { codex: { version: '0.171.0', reviewTurns: [{ answer: CLEAN_ANSWER, sleepMs: 10_000 }] } } });
  await s.mark(null);
  const started = Date.now();
  const result = await s.relay([...codexArgs, '--reviewer-timeout', '0.01']);
  assert.ok(Date.now() - started < 9_000);
  assert.equal(result.code, 1);
  assert.match(result.out, /the reviewer's turn ran past 1 second; its process group was ended, and no pass was recorded\./);
  assert.equal(parse(await s.wip()).passCount, 0);
});

test('a tool whose first process exits while a child it started keeps working: the turn waits for the group', async (t) => {
  const s = await setup(t, { scenario: { codex: { version: '0.171.0', reviewTurns: [{ answer: CLEAN_ANSWER, childWritesAnswerAfterMs: 800 }] } } });
  await s.mark(null);
  const result = await s.relay(codexArgs);
  assert.equal(result.code, 0, result.out);
  assert.equal(parse(await s.wip()).passCount, 1);
});

function runHarness(s, options) {
  const child = spawn(process.execPath, [HARNESS, JSON.stringify({ rootDir: s.ws.rootDir, sessionId: s.lane.laneId, cwd: s.ws.tempDir, ...options }), JSON.stringify(SUPPORTED), s.home], { env: s.standin.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { out += chunk; });
  return { child, output: () => out, done: new Promise((resolve) => child.on('close', (code) => resolve(code))) };
}

test('a relay that dies during a turn: recovery keeps the lane reserved, sends no signal, then repeats once on the owner\'s go', async (t) => {
  const s = await setup(t);
  const started = path.join(s.ws.tempDir, 'turn-started');
  const release = path.join(s.ws.tempDir, 'turn-release');
  await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: CLEAN_ANSWER, startedMarker: started, waitFor: release }, { answer: CLEAN_ANSWER }] } });
  await s.mark(null);
  const harness = runHarness(s, { reviewerModel: 'gpt-test' });
  while (!existsSync(started)) await new Promise((resolve) => setTimeout(resolve, 50));
  // Kill the relay once it has recorded the turn's process and sent the prompt.
  for (;;) {
    const recorded = await readRelayState(s.lane.laneDir).catch(() => null);
    if (recorded?.turn?.prompt_sent) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  harness.child.kill('SIGKILL');
  await harness.done;
  const toolPid = Number(await readFile(started, 'utf8'));
  process.kill(toolPid, 0); // the tool outlives the relay in its own group

  const signals = { count: 0 };
  const table = (await import('../relay-state.js')).createProcessTable();
  const countingTable = { list: () => table.list(), killGroup: () => { signals.count += 1; return true; } };
  const reserved = await s.relay(['--recover'], { relayProcessTable: countingTable });
  assert.equal(reserved.code, 1);
  assert.match(reserved.out, /the reviewer turn for pass 1 from a stopped relay is still running .*The lane and conversation stay reserved; the relay sends no signal/);
  await assert.rejects(closeProjectSession({ cwd: s.ws.tempDir, rootDir: s.ws.rootDir, sessionId: s.lane.laneId, ...CLOSE, relayProcessTable: countingTable }), /reviewer turn on lane relay-lane is still running/);
  const stillReserved = await s.relay(codexArgs, { relayProcessTable: countingTable });
  assert.match(stillReserved.out, /still running/);
  assert.equal(signals.count, 0, 'recovery sends zero signals');

  await writeFile(release, '', 'utf8');
  for (let tries = 0; tries < 100; tries += 1) {
    try {
      process.kill(toolPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      break;
    }
  }
  const partial = await s.relay(codexArgs, { relayProcessTable: countingTable });
  assert.equal(partial.code, 1);
  assert.match(partial.out, /it may have run partly\. Running the relay again repeats it, on your go/);
  // Repeated recovery after the observed exit leaves the turn finished.
  const recoverAgain = await s.relay(['--recover'], { relayProcessTable: countingTable });
  assert.equal(recoverAgain.code, 0);
  assert.doesNotMatch(recoverAgain.out, /may have run partly/);
  const go = await s.relay(codexArgs, { relayProcessTable: countingTable });
  assert.equal(go.code, 0, go.out);
  assert.equal(parse(await s.wip()).passCount, 1);
  assert.equal(signals.count, 0);
});

test('a relay that dies after starting a tool and before sending its prompt: no model turn ran', async (t) => {
  const s = await setup(t, { scenario: { codex: { version: '0.171.0', reviewTurns: [{ answer: CLEAN_ANSWER }] } } });
  await s.mark(null);
  // A process waiting on stdin, as the tool does before the prompt.
  const waiting = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  const table = (await import('../relay-state.js')).createProcessTable();
  const startedAt = (await table.list()).find((row) => row.pid === waiting.pid)?.startedAt;
  await saveRelayState(s.lane.laneDir, { ...emptyRelayState(s.lane.laneId), run: { id: 'dead-run', go: { kind: 'normal', ceiling: 3, mode: 'one-pass' }, stopped: null }, step: 'reviewer-turn', turn: { role: 'reviewer', pass: 1, pid: waiting.pid, pgid: waiting.pid, process_started_at: startedAt, prompt_sent: false, ended: null } });
  const reserved = await s.relay(['--recover']);
  assert.match(reserved.out, /still running/);
  waiting.stdin.end();
  await new Promise((resolve) => waiting.on('close', resolve));
  const recovered = await s.relay(['--recover']);
  assert.equal(recovered.code, 0);
  assert.match(recovered.out, /ended before its prompt was sent: no model turn ran/);
  const go = await s.relay(codexArgs);
  assert.equal(go.code, 0, go.out);
  assert.equal(parse(await s.wip()).passCount, 1);
});

test('--recover finishes a recorded write as complete, superseded, or discarded, and replays nothing after', async (t) => {
  for (const scenario of ['complete', 'superseded', 'discarded']) {
    const s = await setup(t, { laneId: `recover-${scenario}` });
    await s.mark(null);
    const now = await computeCurrentFingerprints({ rootDir: s.ws.rootDir, laneDir: s.lane.laneDir, worktrees: { app: s.lane.worktreeDir }, paths: [], projectRepos: [{ id: 'app' }] });
    const write = prepareRelayWrite({ wipContent: now.wipContent, handoffContent: now.handoffContent, answer: CLEAN_ANSWER, passNumber: 1, time: '2026-11-21 22:00 -08:00', reviewerLabel: 'Codex 0.171.0 (gpt-test requested) via the relay', roundId: now.roundId, fingerprints: now.fingerprints, laneId: s.lane.laneId });
    write.paths = [];
    await saveRelayState(s.lane.laneDir, { ...emptyRelayState(s.lane.laneId), run: { id: 'dead', go: { kind: 'normal', ceiling: 3, mode: 'one-pass' }, stopped: null }, step: 'write', write });
    if (scenario === 'superseded') {
      // The wip.md half landed before the crash; a new builder handoff followed.
      const wip = await s.wip();
      await writeFile(s.lane.wipPath, wip.replace(/## Review log\n?[\s\S]*$/, `## Review log\n${write.wip.body.join('\n')}\n`), 'utf8');
      const handoff = await s.handoff();
      await writeFile(s.lane.handoffPath, handoff.replace('- Opened session', '- Moved on; opened session'), 'utf8');
    }
    if (scenario === 'discarded') {
      await writeFile(path.join(s.lane.worktreeDir, 'README.md'), 'changed\n', 'utf8');
    }
    const first = await s.relay(['--recover']);
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, new RegExp(`relay write ${write.id} is ${scenario}`));
    const passes = parse(await s.wip()).passCount;
    assert.equal(passes, scenario === 'discarded' ? 0 : 1);
    if (scenario === 'superseded') assert.match(first.out, /The summary that wasn't written:\nRelay write/);
    const second = await s.relay(['--recover']);
    assert.match(second.out, /nothing to recover/);
    assert.equal(parse(await s.wip()).passCount, passes);
    // Close isn't held by an ended write.
    await closeProjectSession({ cwd: s.ws.tempDir, rootDir: s.ws.rootDir, sessionId: s.lane.laneId, ...CLOSE, reviewOverride: scenario === 'discarded' ? 'test: no pass recorded' : undefined });
  }
});

test('two relays: a second on the same lane refuses; two lanes naming one conversation get one lock; close refuses while a relay runs', async (t) => {
  const s = await setup(t);
  const started = path.join(s.ws.tempDir, 'builder-started');
  const release = path.join(s.ws.tempDir, 'builder-release');
  await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: ONE_FINDING }, { answer: CONFIRM_R11 }] }, claude: { version: '2.1.318', builderTurns: [{ startedMarker: started, waitFor: release, actions: answerR11(s.lane) }] } });
  await s.mark();
  const first = s.relay([...codexArgs, '--conversation-closed'], { env: { ...s.standin.env, TMPDIR: path.join(s.ws.tempDir, 'tmp-a') } });
  while (!existsSync(started)) await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(s.relay([...codexArgs, '--conversation-closed']), /Another relay is running on lane relay-lane \(process \d+, run [0-9a-f]{12}\)\. One relay runs per lane\./);
  // Another lane whose mark names the same conversation, with its own TMPDIR.
  const other = await openLane(s.ws, 'other-lane', { worktree: true });
  const capture = captureIo();
  await runCli(['ready-for-review', '--root', s.ws.rootDir, '--session', other.laneId], capture.io, { cwd: s.ws.tempDir, env: { ...process.env, CLAUDE_CODE_SESSION_ID: CONV } });
  const otherRelay = captureIo();
  await assert.rejects(runCli(['review-relay', '--root', s.ws.rootDir, '--session', other.laneId, ...codexArgs, '--conversation-closed'], otherRelay.io, { cwd: s.ws.tempDir, env: { ...s.standin.env, TMPDIR: path.join(s.ws.tempDir, 'tmp-b') }, platform: 'darwin', supportedReviewerVersions: SUPPORTED, userInfo: { homedir: s.home }, signals: new EventEmitter() }), /Conversation 7f3c2a10-1111-4222-8333-444455556666 is in use by another relay: lane relay-lane/);
  await assert.rejects(closeProjectSession({ cwd: s.ws.tempDir, rootDir: s.ws.rootDir, sessionId: s.lane.laneId, ...CLOSE }), /a review relay is running on lane relay-lane/);
  const stage = (await listProjectSessions({ cwd: s.ws.tempDir, rootDir: s.ws.rootDir })).inventory.lanes.find((lane) => lane.id === 'relay-lane');
  assert.equal(stage.stage, 'builder answering');
  await writeFile(release, '', 'utf8');
  const done = await first;
  assert.equal(done.code, 0, done.out);
  assert.match(done.out, /Stopped: pass 2 is clean/);
  assert.equal(existsSync(path.join(s.home, '.config', 'vibecompass', 'relay-locks', `${CONV}.json`)), false, 'the conversation lock goes when its run ends');
});

test('the relay names its lane every time, runs only on builder lanes, refuses bypass modes, and stays off Linux and Windows', async (t) => {
  const s = await setup(t, { scenario: { codex: { version: '0.171.0', reviewTurns: [{ answer: CLEAN_ANSWER }] } } });
  await s.mark(null);
  await assert.rejects(runCli(['review-relay', '--root', s.ws.rootDir, ...codexArgs], captureIo().io, { cwd: s.ws.tempDir, env: s.standin.env, platform: 'darwin', supportedReviewerVersions: SUPPORTED, signals: new EventEmitter() }), /Name the lane to relay a review for with --session <lane-id>, even when it is the only active lane\./);
  await assert.rejects(s.relay([...codexArgs, '--builder-mode', 'bypassPermissions']), /--builder-mode bypassPermissions is refused/);
  await assert.rejects(s.relay([...codexArgs, '--dangerously-skip-permissions']), /refused: the review relay never passes a bypass flag/);
  await assert.rejects(s.relay([]), /The Codex reviewer needs --reviewer-model/);
  await assert.rejects(s.relay(codexArgs, { platform: 'linux' }), /review-relay doesn't run on Linux yet: it runs there once an acceptance run on that platform is recorded/);
  await assert.rejects(s.relay(codexArgs, { platform: 'win32' }), /review-relay isn't supported on Windows/);
  const pm = await openLane(s.ws, 'pm-lane');
  const sessionYaml = path.join(pm.laneDir, 'session.yaml');
  await writeFile(sessionYaml, (await readFile(sessionYaml, 'utf8')).replace(/^role: .*$/m, 'role: project-manager'), 'utf8');
  await assert.rejects(runCli(['review-relay', '--root', s.ws.rootDir, '--session', pm.laneId, ...codexArgs], captureIo().io, { cwd: s.ws.tempDir, env: s.standin.env, platform: 'darwin', supportedReviewerVersions: SUPPORTED, signals: new EventEmitter() }), /is a project-manager lane; the review relay runs on builder lanes/);
  assert.equal(await readReadyMark(pm.laneDir), null);
});

test('the role text carries the mark, the relay, a relayed pass, and the project manager\'s check, with no decision number', async (t) => {
  const ws = await createWorkspace(t);
  const context = await readFile(path.join(ws.rootDir, 'context.md'), 'utf8');
  assert.match(context, /- when a round's work is ready for review, run `vibecompass ready-for-review --session <lane-id>`: after you update `handoff\.md` › `## Builder → Reviewer`, and from the second round on after your response line\./);
  assert.match(context, /- the owner may relay a round with `vibecompass review-relay --root \.compass --session <lane-id> --reviewer-model <model>` instead of starting a reviewer by hand/);
  assert.match(context, /In a relayed turn never close the lane, push code or project memory, merge, publish, release, start a reviewer, run the relay, or write a pass line or the reviewer's section/);
  assert.match(context, /- when the owner's `vibecompass review-relay` starts you, you run read-only: do the same review, write no file, and return the pass in the JSON form the relay asks for/);
  assert.match(context, /- \*\*A relayed pass\*\* is written by the review relay from its reviewer's checked answer: `<reviewer>` names the tool, its version, and the model, then `via the relay`/);
  assert.match(context, /`- owner \| <time> \| the owner \| another round \| the owner ran the relay for one pass past the cap \(relay write <write id>\)`/);
  assert.match(context, /or the reviewer the owner's `vibecompass review-relay` run started for that lane\./);
  assert.match(context, /A pass `… via the relay` counts when the prompt or the owner's word says the owner ran the relay on that lane/);
  assert.match(context, /`vibecompass review-settings --round-cap <n>` changes it/);
  assert.match(context, /ready\.json`, `relay\.json`, `relay\.lock` — the lane's ready-for-review mark and the review relay's state and lock/);
  const guide = await readFile(path.join(ws.rootDir, 'workflows', 'project-manager.md'), 'utf8');
  assert.match(guide, /Count relayed passes when the build prompt or the owner's word says the owner ran the review relay on that lane; take them to the owner when nothing does or the record conflicts\./);
  assert.match(guide, /the reviewer the owner's `vibecompass review-relay --root \S+ --session <lane-id> --reviewer-model <model>` run started/);
  // The help names the reviewer versions the package lists, from the same list the relay checks.
  const help = captureIo();
  await runCli(['help'], help.io);
  assert.match(help.stdout(), /vibecompass review-relay --session <lane-id> --reviewer-model <model> \[--recover\]/);
  assert.match(help.stdout(), /Listed on macOS: Codex 0\.171\.0; no Claude Code version\n/);
  for (const text of [context, guide]) {
    assert.doesNotMatch(text, /\bD-\d{3}\b/, 'installed text names no decision number');
  }
});

// ---------------------------------------------------------------------------
// Pass 2's cases: process groups, ownership of the record, recovery, and stops.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

test('a timeout ends a descendant that ignores SIGTERM and outlives its leader before the turn counts as ended', async (t) => {
  const s = await setup(t);
  const pidFile = path.join(s.ws.tempDir, 'lingering.pid');
  await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ lingeringPidFile: pidFile, sleepMs: 30_000, answer: CLEAN_ANSWER }] } });
  await s.mark(null);
  const result = await s.relay([...codexArgs, '--reviewer-timeout', '0.01'], { relayKillGraceMs: 300, relayGroupSettleMs: 3000 });
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /Stopped: the reviewer's turn ran past/);
  assert.match(result.out, /Choices:\n- run `vibecompass review-relay --root \S+ --session relay-lane --reviewer codex --reviewer-model gpt-test --reviewer-timeout 0\.01` again to repeat the turn, with a longer --reviewer-timeout if it needs one\n- review by hand\n/);
  assert.doesNotMatch(result.out, /reopen it below/, 'a one-pass stop offers no conversation it doesn\'t print');
  const lingering = Number(await readFile(pidFile, 'utf8'));
  assert.equal(isRunning(lingering), false, 'the descendant is gone when the relay returns');
  assert.ok((await readRelayState(s.lane.laneDir)).turn.ended, 'the turn ended once its group was gone');
});

test('a group still present after SIGKILL keeps the turn unfinished and the conversation reserved', async (t) => {
  const s = await setup(t);
  await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ sleepMs: 30_000, answer: CLEAN_ANSWER }] }, claude: { version: '2.1.318' } });
  await s.mark();
  // A process table that keeps showing a later-started member of every group the relay ends.
  const real = createProcessTable();
  const ended = new Set();
  const ghost = {
    async list() {
      return [...(await real.list()), ...[...ended].map((pgid) => ({ pid: 999_990, pgid, startedAt: 'Fri Dec 31 23:59:59 2099', command: 'ghost' }))];
    },
    killGroup(pgid, signal) {
      ended.add(pgid);
      return real.killGroup(pgid, signal);
    },
  };
  const result = await s.relay([...codexArgs, '--reviewer-timeout', '0.01', '--conversation-closed'], { relayProcessTable: ghost, relayKillGraceMs: 200, relayGroupSettleMs: 500 });
  assert.match(result.out, /was still present after SIGKILL\. The lane and conversation stay reserved/);
  const state = await readRelayState(s.lane.laneDir);
  assert.equal(state.turn.ended, null, 'the turn stays unfinished');
  assert.ok(existsSync(path.join(s.home, '.config', 'vibecompass', 'relay-locks', `${CONV}.json`)), 'the conversation lock is kept');
  // The next run finds the group still uncertain and keeps it reserved.
  const again = await s.relay([...codexArgs, '--conversation-closed'], { relayProcessTable: ghost });
  assert.match(again.out, /from a stopped relay is (uncertain|still running)/);
});

test('a Claude Code reviewer whose init lists a plugin is ended at init, not after it finishes', async (t) => {
  const s = await setup(t);
  await s.standin.setScenario({ claude: { version: '2.1.318', reviewTurns: [{ plugins: [{ name: 'market', path: '/plugins/market', source: 'market@market' }], sleepMs: 20_000, answer: CLEAN_ANSWER }] } });
  await s.mark(null);
  const started = Date.now();
  const result = await s.relay(['--reviewer', 'claude']);
  assert.ok(Date.now() - started < 12_000, 'the turn was ended at init');
  assert.match(result.out, /the reviewer's init lists a plugin \(market\); the relay ended the turn, and its answer is discarded/);
  assert.equal(parse(await s.wip()).passCount, 0);
});

test('the stop is recorded while the run still holds its lane lock', async (t) => {
  const s = await setup(t);
  await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: CLEAN_ANSWER }] } });
  await s.mark(null);
  let lockDuringStop = null;
  const result = await s.relay(codexArgs, {
    relayBeforeStopSave: async () => {
      await sleep(150);
      lockDuringStop = existsSync(path.join(s.lane.laneDir, 'relay.lock'));
    },
  });
  assert.equal(result.code, 0, result.out);
  assert.equal(lockDuringStop, true);
  assert.equal(existsSync(path.join(s.lane.laneDir, 'relay.lock')), false, 'released after the stop is recorded');
  assert.equal((await readRelayState(s.lane.laneDir)).run.stopped.kind, 'clean');
});

test('a builder turn that changes an earlier review line, or adds a record besides its response, stops the relay', async (t) => {
  const edit = await setup(t, { laneId: 'edit-earlier' });
  await edit.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: ONE_FINDING }] }, claude: { version: '2.1.318', builderTurns: [{ actions: [{ type: 'replace-in-file', path: edit.lane.wipPath, from: 'the parser accepts a bad time', to: 'nothing that matters' }, ...answerR11(edit.lane)] }] } });
  await edit.mark();
  const edited = await edit.relay([...codexArgs, '--conversation-closed']);
  assert.match(edited.out, /Stopped: the builder changed earlier lines of ## Review log during its turn; a relayed turn may only append its response\./);

  const owner = await setup(t, { laneId: 'owner-line' });
  await owner.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: ONE_FINDING }] }, claude: { version: '2.1.318', builderTurns: [{ actions: [{ type: 'append-review-log', lines: ['- response 1 | 2026-11-21 22:00 -08:00 | Claude Opus 5.5', '  - R1.1 | P2 | accepted | fixed', '- owner | 2026-11-21 22:01 -08:00 | the owner | another round | written by the builder'] }, { type: 'write-file', path: path.join(owner.lane.worktreeDir, 'src', 'index.js'), content: 'export const answer = 43;\n' }, { type: 'mark-ready' }] }] } });
  await owner.mark();
  const added = await owner.relay([...codexArgs, '--conversation-closed']);
  assert.match(added.out, /Stopped: the builder added a record other than its response to pass 1 during its turn \(.*owner.*\)/);
});

test('the builder re-marks with the memory root and the last mark\'s named paths', async (t) => {
  const s = await setup(t);
  await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: ONE_FINDING }, { answer: CONFIRM_R11 }] }, claude: { version: '2.1.318', builderTurns: [{ actions: answerR11(s.lane) }] } });
  const capture = captureIo();
  assert.equal(await runCli(['ready-for-review', '--root', s.ws.rootDir, '--session', s.lane.laneId, '--path', 'architecture/platform/relay.md'], capture.io, { cwd: s.ws.tempDir, env: { ...process.env, CLAUDE_CODE_SESSION_ID: CONV } }), 0, capture.stderr());
  const result = await s.relay([...codexArgs, '--conversation-closed']);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /Stopped: pass 2 is clean/);
  const remark = (await s.standin.calls()).find((item) => item.action === 'mark-ready');
  assert.deepEqual(remark.argv, ['ready-for-review', '--root', s.ws.rootDir, '--session', s.lane.laneId, '--path', 'architecture/platform/relay.md']);
  assert.deepEqual((await readReadyMark(s.lane.laneDir)).paths, ['architecture/platform/relay.md']);
});

test('a reviewer turn that finished in a relay that died before its write is reported once, then repeated on a new go', async (t) => {
  const s = await setup(t);
  await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: CLEAN_ANSWER }] } });
  await s.mark(null);
  await saveRelayState(s.lane.laneDir, { ...emptyRelayState(s.lane.laneId), run: { id: 'dead', go: { kind: 'normal', ceiling: 3, mode: 'one-pass', pass_count_at_go: 0 }, stopped: null }, step: 'reviewer-turn', turn: { role: 'reviewer', pass: 1, pid: 4400, pgid: 4400, process_started_at: 'x', prompt_sent: true, ended: { at: new Date().toISOString(), how: 'exited', exit_code: 0 } }, writes: [] });
  const first = await s.relay(codexArgs);
  assert.match(first.out, /the reviewer's turn for pass 1 finished \(exited\) in a relay that stopped before recording a pass from it/);
  assert.equal((await s.standin.calls()).filter((item) => item.kind === 'review').length, 0, 'no turn repeated without the owner\'s go');
  const second = await s.relay(codexArgs);
  assert.equal(second.code, 0, second.out);
  assert.match(second.out, /Stopped: pass 1 is clean/);
});

test('a stop before the run is saved still prints the reopen command from the current mark', async (t) => {
  const s = await setup(t);
  await s.standin.setScenario({ codex: { version: '0.160.0' }, claude: { version: '2.1.318' } });
  await s.mark();
  const result = await s.relay([...codexArgs, '--conversation-closed']);
  assert.match(result.out, /isn't a supported reviewer version/);
  assert.match(result.out, new RegExp(`Reopen the builder's conversation: claude --resume ${CONV}`));
});

test('a failed save of the turn\'s process closes its stdin empty and ends its group: no model turn', async (t) => {
  const s = await setup(t);
  await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: CLEAN_ANSWER }] } });
  await s.mark(null);
  const result = await s.relay(codexArgs, { relayOnTurnRecord: async () => { throw new Error('disk full'); } });
  assert.equal(result.code, 1);
  assert.match(result.out, /the reviewer's process couldn't be recorded \(disk full\), so its stdin was closed empty and its process group ended: no model turn ran/);
  // The tool may be ended before it records anything; if it did, it read no prompt.
  for (const review of (await s.standin.calls()).filter((item) => item.kind === 'review')) assert.equal(review.prompt, '', 'the tool got no prompt');
  assert.equal(parse(await s.wip()).passCount, 0);
});

test('a version command that fails is no version, even when it prints one', async (t) => {
  const s = await setup(t);
  await s.standin.setScenario({ codex: { version: '0.171.0', versionExit: 1, reviewTurns: [{ answer: CLEAN_ANSWER }] } });
  await s.mark(null);
  const result = await s.relay(codexArgs);
  assert.match(result.out, /version couldn't be read/);
  assert.doesNotMatch(result.out, /Review relay on lane/, 'stopped by the check before the run starts');
  assert.equal((await s.standin.calls()).filter((item) => item.kind === 'review').length, 0);
  // The check before each turn: a probe that passes at the start and fails before the turn.
  const later = await setup(t, { laneId: 'version-later' });
  await later.standin.setScenario({ codex: { version: '0.171.0', versionExitFrom: 2, reviewTurns: [{ answer: CLEAN_ANSWER }] } });
  await later.mark(null);
  const turn = await later.relay(codexArgs);
  assert.match(turn.out, /Review relay on lane version-later/);
  assert.match(turn.out, /version couldn't be read/);
  assert.equal((await later.standin.calls()).filter((item) => item.kind === 'review').length, 0);
});

test('recovery that finds a write superseded stops the run before any builder turn', async (t) => {
  const s = await setup(t);
  await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [] }, claude: { version: '2.1.318', builderTurns: [{ actions: answerR11(s.lane) }] } });
  await s.mark();
  const now = await computeCurrentFingerprints({ rootDir: s.ws.rootDir, laneDir: s.lane.laneDir, worktrees: { app: s.lane.worktreeDir }, paths: [], projectRepos: [{ id: 'app' }] });
  const write = prepareRelayWrite({ wipContent: now.wipContent, handoffContent: now.handoffContent, answer: ONE_FINDING, passNumber: 1, time: '2026-11-21 22:00 -08:00', reviewerLabel: 'Codex 0.171.0 (gpt-test requested) via the relay', roundId: now.roundId, fingerprints: now.fingerprints, laneId: s.lane.laneId });
  write.paths = [];
  await saveRelayState(s.lane.laneDir, { ...emptyRelayState(s.lane.laneId), run: { id: 'dead', go: { kind: 'normal', ceiling: 3, mode: 'loop', pass_count_at_go: 0 }, stopped: null }, step: 'write', write, builder: { conversation_id: CONV, mode: 'default' } });
  const wip = await s.wip();
  await writeFile(s.lane.wipPath, wip.replace(/## Review log\n?[\s\S]*$/, `## Review log\n${write.wip.body.join('\n')}\n`), 'utf8');
  const handoff = await s.handoff();
  await writeFile(s.lane.handoffPath, handoff.replace('- Opened session', '- Moved on; opened session'), 'utf8');
  const result = await s.relay([...codexArgs, '--conversation-closed']);
  assert.match(result.out, new RegExp(`relay write ${write.id} is superseded`));
  assert.match(result.out, /Stopped: relay write/);
  assert.equal((await s.standin.calls()).filter((item) => item.kind === 'builder').length, 0, 'no builder turn after a superseded write');
});

test('a named repository is found from the directory itself, outside the tooling root too', async (t) => {
  const ws = await createWorkspace(t);
  const external = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-relay-external-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  git(external, ['init', '-q', '-b', 'main']);
  await writeFile(path.join(external, 'README.md'), 'x\n', 'utf8');
  const ctx = { worktrees: {}, rootDir: ws.rootDir, projectRepos: [{ id: 'ext', path: external }] };
  const top = await realpath(external);
  assert.deepEqual(await coveredRepositories(ctx, { paths: ['ext:.'] }), [top]);
  assert.deepEqual(await coveredRepositories(ctx, { paths: ['ext:README.md'] }), [top]);
});

test('a helper outside the turn\'s group that holds its output open delays neither a finished turn nor a timeout, and gets no signal', { timeout: 60_000 }, async (t) => {
  const holders = [];
  t.after(() => {
    for (const pid of holders) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
  });
  const readHolder = async (file) => {
    const pid = Number(await readFile(file, 'utf8'));
    holders.push(pid);
    return pid;
  };

  // The tool answers and exits; its helper keeps stdout open.
  const done = await setup(t, { laneId: 'pipe-held-done' });
  const doneFile = path.join(done.ws.tempDir, 'holder-done.pid');
  await done.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ pipeHolderPidFile: doneFile, answer: CLEAN_ANSWER }] } });
  await done.mark(null);
  let started = Date.now();
  const finished = await done.relay(codexArgs);
  assert.ok(Date.now() - started < 15_000, 'the turn ended with its group, not with the pipe');
  assert.equal(finished.code, 0, finished.out);
  assert.match(finished.out, /Stopped: pass 1 is clean/);
  assert.equal(isRunning(await readHolder(doneFile)), true, 'the helper outside the group got no signal');

  // The tool runs past its timeout; its helper keeps stdout open.
  const late = await setup(t, { laneId: 'pipe-held-late' });
  const lateFile = path.join(late.ws.tempDir, 'holder-late.pid');
  await late.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ pipeHolderPidFile: lateFile, sleepMs: 60_000, answer: CLEAN_ANSWER }] } });
  await late.mark(null);
  started = Date.now();
  const timedOut = await late.relay([...codexArgs, '--reviewer-timeout', '0.01'], { relayKillGraceMs: 300, relayGroupSettleMs: 1000 });
  assert.ok(Date.now() - started < 15_000, 'the timeout ended the group and the relay returned');
  assert.match(timedOut.out, /Stopped: the reviewer's turn ran past/);
  assert.ok((await readRelayState(late.lane.laneDir)).turn.ended, 'the turn ended once its group was gone');
  assert.equal(isRunning(await readHolder(lateFile)), true, 'the helper outside the group got no signal');
});

// ---------------------------------------------------------------------------
// Pass 3's cases: owner control, review authorship, recovery, and stops.

test('a builder turn that appends a finding or evidence before its response line stops the relay', async (t) => {
  for (const [laneId, line] of [['before-finding', '  - R1.2 | P2 | open | a finding the builder wrote under the reviewer\'s pass'], ['before-evidence', '    evidence the builder added to R1.1: src/index.js:9']]) {
    const s = await setup(t, { laneId });
    await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: ONE_FINDING }] }, claude: { version: '2.1.318', builderTurns: [{ actions: [{ type: 'append-review-log', lines: [line, '- response 1 | 2026-11-21 22:00 -08:00 | Claude Opus 5.5', '  - R1.1 | P2 | accepted | fixed the time pattern'] }, { type: 'write-file', path: path.join(s.lane.worktreeDir, 'src', 'index.js'), content: 'export const answer = 43;\n' }, { type: 'mark-ready' }] }] } });
    await s.mark();
    const result = await s.relay([...codexArgs, '--conversation-closed']);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /Stopped: the builder appended to ## Review log before its response line \(`.+`\); a relayed turn's lines start with `- response 1 \|`, and every line it adds is part of that response\./, laneId);
    assert.equal((await s.standin.calls()).filter((item) => item.kind === 'review').length, 1, 'no second pass');
  }
});

test('--confirm-each-round waits for Enter before every builder turn, after a restart too', async (t) => {
  const s = await setup(t);
  await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: ONE_FINDING }, { answer: CONFIRM_R11 }] }, claude: { version: '2.1.318', builderTurns: [{ actions: answerR11(s.lane) }] } });
  await s.mark();
  const asked = [];
  const stopHere = async (question) => { asked.push(question); return 'stop'; };
  const first = await s.relay([...codexArgs, '--conversation-closed', '--confirm-each-round'], { confirm: stopHere });
  assert.match(first.out, /Stopped: the owner stopped after pass 1, before the builder's turn\./);
  assert.equal(asked.length, 1);
  // A relay that died after the pass was recorded and before the Enter: the run has no stop.
  const state = await readRelayState(s.lane.laneDir);
  await saveRelayState(s.lane.laneDir, { ...state, step: 'running', run: { ...state.run, stopped: null }, last_stop: null });
  const restarted = await s.relay([...codexArgs, '--conversation-closed', '--confirm-each-round'], { confirm: stopHere });
  assert.match(restarted.out, /Restarting run [0-9a-f]+'s go/);
  assert.match(restarted.out, /Stopped: the owner stopped after pass 1, before the builder's turn\./);
  assert.equal(asked.length, 2, 'the restart asked before the builder\'s turn');
  assert.match(asked[1], /^Pass 1 is recorded\. Press Enter to send the builder its turn/);
  assert.equal((await s.standin.calls()).filter((item) => item.kind === 'builder').length, 0, 'no builder turn without the Enter');
  // With the Enter, one question per builder turn, and the loop runs to a clean pass.
  const goOn = [];
  const done = await s.relay([...codexArgs, '--conversation-closed', '--confirm-each-round'], { confirm: async (question) => { goOn.push(question); return ''; } });
  assert.equal(done.code, 0, done.out);
  assert.match(done.out, /Stopped: pass 2 is clean/);
  assert.equal(goOn.length, 1);
  assert.equal((await s.standin.calls()).filter((item) => item.kind === 'builder').length, 1);
});

test('a newer mark from another conversation or a plain shell stops the loop before any builder turn', async (t) => {
  const OTHER = '9e8d7c6b-2222-4333-8444-555566667777';
  for (const [laneId, conversationId, expected] of [['mark-shell', null, /now names no Claude Code conversation \(it was made from a shell\), not 7f3c2a10-1111-4222-8333-444455556666, which this run resumes\. Nothing was sent to either\./], ['mark-other', OTHER, new RegExp(`now names Claude Code conversation ${OTHER}, not 7f3c2a10-1111-4222-8333-444455556666, which this run resumes`)]]) {
    const s = await setup(t, { laneId });
    // The new mark is made while the reviewer works, as the owner might from another terminal.
    await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: ONE_FINDING, actions: [{ type: 'mark-ready', conversationId }] }] }, claude: { version: '2.1.318', builderTurns: [{ actions: answerR11(s.lane) }] } });
    await s.mark();
    const result = await s.relay([...codexArgs, '--conversation-closed']);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, expected);
    assert.match(result.out, conversationId ? new RegExp(`continue with conversation ${conversationId}: the relay asks you to confirm it is closed`) : /again for one pass, and answer in the builder's window/);
    assert.equal(parse(await s.wip()).passCount, 1);
    assert.equal((await s.standin.calls()).filter((item) => item.kind === 'builder').length, 0, 'the finding went to no conversation');
  }
});

test('recovery binds a reviewer turn to its own write: an earlier discarded write for the same pass hides nothing', async (t) => {
  const s = await setup(t);
  await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: CLEAN_ANSWER }] } });
  await s.mark(null);
  const discarded = { id: 'aaaaaaaaaaaa', pass: 1, turn_id: 'turn-first', state: 'discarded', reason: 'the work or the handoff changed after the review' };
  await saveRelayState(s.lane.laneDir, { ...emptyRelayState(s.lane.laneId), run: { id: 'dead', go: { kind: 'normal', ceiling: 3, mode: 'one-pass', pass_count_at_go: 0 }, stopped: null }, step: 'reviewer-turn', turn: { id: 'turn-second', role: 'reviewer', pass: 1, pid: 4400, pgid: 4400, process_started_at: 'x', prompt_sent: true, ended: { at: new Date().toISOString(), how: 'exited', exit_code: 0 } }, write: discarded, writes: [{ id: discarded.id, pass: 1, turn_id: 'turn-first', state: 'discarded', at: new Date().toISOString() }] });
  const result = await s.relay(['--recover']);
  assert.match(result.out, /the reviewer's turn for pass 1 finished \(exited\) in a relay that stopped before recording a pass from it/);
  assert.equal((await readRelayState(s.lane.laneDir)).run.stopped.kind, 'interrupted');
});

test('a turn recovery reports as possibly partial is reported once', async (t) => {
  const s = await setup(t);
  await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: CLEAN_ANSWER }] } });
  await s.mark(null);
  const empty = { async list() { return []; }, killGroup() {} };
  await saveRelayState(s.lane.laneDir, { ...emptyRelayState(s.lane.laneId), run: { id: 'dead', go: { kind: 'normal', ceiling: 3, mode: 'one-pass', pass_count_at_go: 0 }, stopped: null }, step: 'reviewer-turn', turn: { id: 'turn-one', role: 'reviewer', pass: 1, pid: 4400, pgid: 4400, process_started_at: 'x', prompt_sent: true, ended: null }, writes: [] });
  const first = await s.relay(['--recover'], { relayProcessTable: empty });
  assert.match(first.out, /The reviewer turn for pass 1 was running when a relay stopped, and its process group has ended .*it may have run partly/);
  const second = await s.relay(['--recover'], { relayProcessTable: empty });
  assert.match(second.out, /Stopped: nothing to recover/);
  assert.doesNotMatch(second.out, /finished|may have run partly/);
  const state = await readRelayState(s.lane.laneDir);
  assert.ok(state.turn.reported_at);
  assert.equal(state.run.stopped.kind, 'interrupted');
});

test('a failed save of the turn\'s process with a group that won\'t end keeps an inspectable reservation', async (t) => {
  const s = await setup(t);
  await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: CLEAN_ANSWER }] }, claude: { version: '2.1.318' } });
  await s.mark();
  const real = createProcessTable();
  const ended = new Set();
  const ghost = {
    async list() {
      return [...(await real.list()), ...[...ended].map((pgid) => ({ pid: 999_990, pgid, startedAt: 'Fri Dec 31 23:59:59 2099', command: 'ghost' }))];
    },
    killGroup(pgid, signal) {
      ended.add(pgid);
      return real.killGroup(pgid, signal);
    },
  };
  let failures = 0;
  // Only the first record fails; the late record of the identity succeeds.
  const result = await s.relay([...codexArgs, '--conversation-closed'], { relayProcessTable: ghost, relayKillGraceMs: 200, relayGroupSettleMs: 500, relayOnTurnRecord: async ({ stage }) => { if (stage !== 'identity') return; failures += 1; throw new Error('disk full'); } });
  assert.equal(failures, 1);
  assert.match(result.out, /was still present after SIGKILL\. The lane and conversation stay reserved/);
  const state = await readRelayState(s.lane.laneDir);
  assert.equal(state.turn.ended, null, 'the turn stays unfinished');
  assert.ok(Number.isInteger(state.turn.pgid), 'the group is recorded, so it can be inspected');
  assert.equal(state.turn.prompt_sent, false);
  assert.equal(state.turn.identity_recorded_late, true);
  assert.ok(existsSync(path.join(s.home, '.config', 'vibecompass', 'relay-locks', `${CONV}.json`)), 'the conversation lock is kept');
  // The next run inspects the group and keeps it reserved; close refuses too.
  const again = await s.relay([...codexArgs, '--conversation-closed'], { relayProcessTable: ghost });
  assert.match(again.out, /the reviewer turn for pass 1 from a stopped relay is uncertain/);
  await assert.rejects(closeProjectSession({ cwd: s.ws.tempDir, rootDir: s.ws.rootDir, sessionId: s.lane.laneId, ...CLOSE, relayProcessTable: ghost }), /close-session is refused: the relay's reviewer turn on lane relay-lane is uncertain/);
  // Once the group is gone: no model turn ran, and the lane runs again.
  ended.clear();
  const recovered = await s.relay(['--recover'], { relayProcessTable: ghost });
  assert.match(recovered.out, /ended before its prompt was sent: no model turn ran/);
});

test('a stop\'s commands run as printed: the past-cap command from another folder starts the pass', async (t) => {
  const s = await setup(t, { review: ['check: block', 'round_cap: 1'], laneId: 'runnable' });
  await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: ONE_FINDING }, { answer: CONFIRM_R11 }] } });
  await s.mark(null);
  assert.equal((await s.relay(codexArgs)).code, 0);
  // The builder answers by hand and marks the next round.
  await writeReviewLog(s.lane, [...extractReviewLogLines(await s.wip()).lines.map((line) => line.text).filter((line) => line.trim() !== ''), '- response 1 | 2026-11-21 22:00 -08:00 | Claude Opus 5.5', '  - R1.1 | P2 | accepted | fixed the time pattern']);
  await writeFile(path.join(s.lane.worktreeDir, 'src', 'index.js'), 'export const answer = 43;\n', 'utf8');
  await s.mark(null);
  const atCap = await s.relay(codexArgs);
  const printed = /run `(vibecompass review-relay [^`]+--past-cap)` for one more pass/.exec(atCap.out)?.[1];
  assert.ok(printed, atCap.out);
  const words = printed.split(' ');
  assert.equal(words[0], 'vibecompass');
  // A folder with no lane marker and no memory root: the command alone must name both.
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-relay-elsewhere-'));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  const capture = captureIo();
  const code = await runCli(words.slice(1), capture.io, { cwd: elsewhere, env: s.standin.env, platform: 'darwin', supportedReviewerVersions: SUPPORTED, userInfo: { homedir: s.home }, signals: s.signals, confirm: null });
  assert.equal(code, 0, capture.stdout() + capture.stderr());
  assert.match(capture.stdout(), /Stopped: pass 2 is clean/);
  assert.equal(parse(await s.wip()).passCount, 2);
});

// Pass 4's cases: the printed continuation, an unrecorded turn, the lane
// changing during the owner's Enter, polling after the exit, and a stop
// before the prompt.

test('the pause command, run as printed, keeps the owner\'s options: the Enter, a fresh reviewer, and the timeouts', async (t) => {
  const s = await setup(t, { laneId: 'verbatim' });
  await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: ONE_FINDING }, { answer: CONFIRM_R11 }] }, claude: { version: '2.1.318', builderTurns: [{ actions: answerR11(s.lane) }] } });
  await s.mark();
  const first = await s.relay([...codexArgs, '--conversation-closed', '--confirm-each-round', '--fresh-reviewer', '--reviewer-timeout', '30', '--builder-timeout', '50'], { confirm: async () => 'stop' });
  assert.match(first.out, /Stopped: the owner stopped after pass 1, before the builder's turn\./);
  const printed = /run `(vibecompass review-relay [^`]+)` again to continue/.exec(first.out)?.[1];
  assert.ok(printed, first.out);
  for (const flag of ['--confirm-each-round', '--fresh-reviewer', '--reviewer-timeout 30', '--builder-timeout 50', '--reviewer-model gpt-test']) {
    assert.ok(printed.includes(flag), `${flag} in ${printed}`);
  }
  assert.ok(!printed.includes('--conversation-closed'), 'the conversation is confirmed again, since the stop prints the command that reopens it');
  // Followed as printed, from a folder with no lane: the relay asks about the
  // conversation, then asks for the Enter again before the builder's turn.
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-relay-verbatim-'));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  const asked = [];
  const capture = captureIo();
  const code = await runCli(printed.split(' ').slice(1), capture.io, { cwd: elsewhere, env: s.standin.env, platform: 'darwin', supportedReviewerVersions: SUPPORTED, userInfo: { homedir: s.home }, signals: s.signals, confirm: async (question) => { asked.push(question); return /closed in every terminal/.test(question) ? 'y' : 'stop'; } });
  assert.equal(code, 0, capture.stdout());
  assert.equal(asked.length, 2, asked.join('\n'));
  assert.match(asked[1], /^Pass 1 is recorded\. Press Enter to send the builder its turn/);
  assert.equal((await s.standin.calls()).filter((item) => item.kind === 'builder').length, 0, 'no builder turn without the Enter');
});

test('a turn whose process was never recorded stays reserved through a restart and close until the owner confirms at --recover', async (t) => {
  const s = await setup(t, { laneId: 'unrecorded' });
  await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: CLEAN_ANSWER }] }, claude: { version: '2.1.318' } });
  await s.mark();
  // Both records of the process fail: the first, and the late one after it.
  const stages = [];
  const result = await s.relay([...codexArgs, '--conversation-closed'], { relayOnTurnRecord: async ({ stage }) => { stages.push(stage); throw new Error('disk full'); } });
  assert.deepEqual(stages, ['identity', 'late identity']);
  assert.equal(result.code, 1);
  assert.match(result.out, /relay\.json couldn't record that either \(disk full\), so the lane and conversation stay reserved: run `vibecompass review-relay --root \S+ --session unrecorded --recover` in a terminal/);
  for (const review of (await s.standin.calls()).filter((item) => item.kind === 'review')) assert.equal(review.prompt, '', 'the tool got no prompt');
  const state = await readRelayState(s.lane.laneDir);
  assert.equal(state.turn.pgid, null);
  assert.equal(state.turn.ended, null, 'the turn stays unfinished');
  assert.equal(state.turn.command, 'codex');
  const marker = `VIBECOMPASS_RELAY_TURN_ID=${state.turn.id}`;
  const lockPath = path.join(s.home, '.config', 'vibecompass', 'relay-locks', `${CONV}.json`);
  assert.ok(existsSync(lockPath), 'the conversation lock is kept');
  // A restart starts nothing and stays reserved.
  const reviewsBefore = (await s.standin.calls()).filter((item) => item.kind === 'review').length;
  const again = await s.relay([...codexArgs, '--conversation-closed']);
  assert.equal(again.code, 1);
  assert.match(again.out, /the reviewer turn for pass 1, started .+, was never recorded with its process, so the relay can't inspect its process group\. Its prompt was never sent, since the prompt goes out only after that record, so no model turn ran\./);
  assert.ok(again.out.includes(`No running process carries its id (${marker}), but a system program it started, such as a shell, doesn't show its environment`), again.out);
  assert.match(again.out, /The lane and conversation stay reserved until you run `vibecompass review-relay --root \S+ --session unrecorded --recover` in a terminal, which asks you to settle it\. No other session's process needs stopping\./);
  assert.match(again.out, /Choices:\n- run `vibecompass review-relay --root \S+ --session unrecorded --recover` in a terminal and settle the turn\n/);
  assert.doesNotMatch(again.out, /codex process|started then or later|stop any you find/, 'nothing points at other sessions of the same tool');
  assert.equal((await s.standin.calls()).filter((item) => item.kind === 'review').length, reviewsBefore, 'no reviewer started');
  // Close refuses.
  await assert.rejects(closeProjectSession({ cwd: s.ws.tempDir, rootDir: s.ws.rootDir, sessionId: s.lane.laneId, ...CLOSE }), /close-session is refused: the relay's reviewer turn on lane unrecorded, started .+, was never recorded with its process, so its process group can't be inspected\. Run `.+--recover` in a terminal: it looks for the turn's own processes by the id in their environment/);
  // --recover with no terminal, then with a no: still reserved.
  assert.match((await s.relay(['--recover'])).out, /run `vibecompass review-relay --root \S+ --session unrecorded --recover` in a terminal, which asks you to settle it/);
  const questions = [];
  const declined = await s.relay(['--recover'], { confirm: async (question) => { questions.push(question); return 'n'; } });
  assert.equal(declined.code, 1);
  assert.match(questions[0], /^The reviewer turn for pass 1, started .+, was never recorded with its process, so its prompt was never sent and no model turn ran\. No running process carries its id \(VIBECOMPASS_RELAY_TURN_ID=[0-9a-f]{12}\), but a system program it started, such as a shell, doesn't show its environment, so the relay can't rule one out\. Settle the turn and release the lane and conversation\? Other sessions aren't affected\. \[y\/N\]$/);
  assert.ok(questions[0].includes(marker));
  assert.equal((await readRelayState(s.lane.laneDir)).turn.ended, null);
  // The owner confirms: the turn is settled, and the lane runs again.
  const confirmed = await s.relay(['--recover'], { confirm: async () => 'y' });
  assert.equal(confirmed.code, 0, confirmed.out);
  assert.match(confirmed.out, /You settled it\./);
  // The first relay's process has exited, as a real relay's does after its run;
  // here every relay runs in the test's own process.
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  await writeFile(lockPath, JSON.stringify({ ...lock, pid: 999_999 }), 'utf8');
  const go = await s.relay([...codexArgs, '--conversation-closed']);
  assert.equal(go.code, 0, go.out);
  assert.match(go.out, /Took over conversation [0-9a-f-]+'s lock: run [0-9a-f]+ on lane unrecorded has ended\./, 'the settled run\'s lock is taken over');
  assert.equal(parse(await s.wip()).passCount, 1);
});

test('the lane changing while the relay waits for the Enter: no builder turn goes to a conversation the lane no longer names', async (t) => {
  const OTHER = '9e8d7c6b-2222-4333-8444-555566667777';
  for (const [laneId, conversationId] of [['enter-other', OTHER], ['enter-same', CONV]]) {
    const s = await setup(t, { laneId });
    await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: ONE_FINDING }, { answer: CONFIRM_R11 }] }, claude: { version: '2.1.318', builderTurns: [{ actions: answerR11(s.lane) }] } });
    await s.mark();
    // At the Enter: the owner answers by hand and marks again, from another
    // conversation or from this one, then presses Enter.
    const atEnter = async () => {
      await writeReviewLog(s.lane, [...extractReviewLogLines(await s.wip()).lines.map((line) => line.text).filter((line) => line.trim() !== ''), '- response 1 | 2026-11-21 22:00 -08:00 | Claude Opus 5.5', '  - R1.1 | P2 | accepted | fixed the time pattern']);
      await writeFile(path.join(s.lane.worktreeDir, 'src', 'index.js'), 'export const answer = 43;\n', 'utf8');
      await s.mark(conversationId);
      return '';
    };
    const result = await s.relay([...codexArgs, '--conversation-closed', '--confirm-each-round'], { confirm: atEnter });
    assert.match(result.out, /Not sending the builder its turn for pass 1: the ready-for-review mark changed/, laneId);
    assert.equal((await s.standin.calls()).filter((item) => item.kind === 'builder').length, 0, `${laneId}: no builder turn`);
    if (conversationId === OTHER) {
      assert.equal(result.code, 1);
      assert.match(result.out, new RegExp(`now names Claude Code conversation ${OTHER}, not ${CONV}, which this run resumes\\. Nothing was sent to either\\.`));
      assert.equal(parse(await s.wip()).passCount, 1);
    } else {
      // The same conversation's new round gets its pass.
      assert.equal(result.code, 0, result.out);
      assert.match(result.out, /Stopped: pass 2 is clean/);
    }
  }
});

test('recovery names only the processes that carry the turn\'s id: another session of the same tool is left out', { skip: process.platform !== 'darwin' }, async (t) => {
  const s = await setup(t, { laneId: 'marked-recovery' });
  const turnId = 'a1b2c3d4e5f6';
  await saveRelayState(s.lane.laneDir, { ...emptyRelayState(s.lane.laneId), step: 'builder-turn', turn: { id: turnId, role: 'builder', command: 'claude', pass: 1, pid: null, pgid: null, process_started_at: null, prompt_sent: false, started_at: new Date().toISOString(), ended: null } });
  // One process from the turn, carrying its id, and one from another session
  // of the same tool, which doesn't.
  const start = (extraEnv) => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', 'claude'], { env: { ...process.env, ...extraEnv }, detached: true, stdio: 'ignore' });
    t.after(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    });
    return child;
  };
  const fromTurn = start({ VIBECOMPASS_RELAY_TURN_ID: turnId });
  const other = start({});
  // Two more that name the id only in their arguments: a process whose
  // environment macOS shows, without the id, and a shell, whose environment
  // macOS doesn't show.
  const named = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', `VIBECOMPASS_RELAY_TURN_ID=${turnId}`], { detached: true, stdio: 'ignore' });
  const shell = spawn('/bin/sh', ['-c', 'sleep 60; :', `VIBECOMPASS_RELAY_TURN_ID=${turnId}`], { detached: true, stdio: 'ignore' });
  for (const child of [named, shell]) {
    t.after(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  const questions = [];
  const ask = async (question) => {
    questions.push(question);
    return 'y';
  };
  const held = await s.relay(['--recover'], { confirm: ask });
  assert.equal(held.code, 1);
  assert.equal(questions.length, 0, 'with the turn\'s own process found, nothing is asked');
  assert.match(held.out, new RegExp(`These processes carry its id \\(VIBECOMPASS_RELAY_TURN_ID=${turnId}\\) in their environment: ${fromTurn.pid} in group ${fromTurn.pid} `));
  assert.match(held.out, new RegExp(`\`kill -TERM -${fromTurn.pid}\``));
  assert.ok(!held.out.includes(String(other.pid)), 'the other session\'s process isn\'t named');
  assert.ok(!held.out.includes(String(named.pid)), 'nor one whose shown environment lacks the id, whatever its arguments say');
  assert.match(held.out, new RegExp(`One process names its id where the relay can't tell its environment from its arguments.+process ${shell.pid} `));
  assert.ok(!held.out.includes(`group ${shell.pid}`) && !held.out.includes(`kill -TERM -${shell.pid}`) && !held.out.includes(`kill -TERM ${shell.pid}`), 'the shell isn\'t called the turn\'s, and nothing says to stop it');
  assert.match(held.out, /No other process needs stopping\./);
  assert.equal((await readRelayState(s.lane.laneDir)).turn.ended, null);
  const gone = async (pid) => {
    for (let tries = 0; tries < 50 && (await createProcessTable().list()).some((row) => row.pid === pid); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  // The turn's process is gone; the shell that only names the id still keeps the reservation, and nothing is asked.
  process.kill(-fromTurn.pid, 'SIGKILL');
  await gone(fromTurn.pid);
  const unclear = await s.relay(['--recover'], { confirm: ask });
  assert.equal(unclear.code, 1);
  assert.equal(questions.length, 0);
  assert.match(unclear.out, /No process is shown to carry its id .+ in its environment\. One process names its id/);
  assert.ok(!unclear.out.includes(`kill -TERM -${shell.pid}`));
  // Once it is gone too, the owner is asked, and settles the turn.
  process.kill(-shell.pid, 'SIGKILL');
  await gone(shell.pid);
  const settled = await s.relay(['--recover'], { confirm: ask });
  assert.equal(settled.code, 0, settled.out);
  assert.equal(questions.length, 1);
  assert.match(settled.out, /You settled it\./);
  assert.match((await readRelayState(s.lane.laneDir)).turn.ended.how, /settled by the owner/);
  assert.ok((await createProcessTable().list()).some((row) => row.pid === other.pid), 'the other session still runs');
});

test('a turn\'s process is one seen twice the same way with its id among its environment entries; anything less is ambiguous', async () => {
  const id = 'c0ffee123456';
  const marker = `VIBECOMPASS_RELAY_TURN_ID=${id}`;
  const at = 'Mon Nov 23 17:10:02 2026';
  const plain = [
    { pid: 10, pgid: 10, startedAt: at, command: 'node turn.js' },
    { pid: 11, pgid: 11, startedAt: at, command: `node grep.js ${marker}` },
    { pid: 12, pgid: 12, startedAt: at, command: `sh -c sleep ${marker}` },
    { pid: 13, pgid: 13, startedAt: 'Mon Nov 23 17:11:00 2026', command: 'node reused.js' },
    { pid: 14, pgid: 99, startedAt: at, command: 'node moved.js' },
    { pid: 16, pgid: 10, startedAt: at, command: 'node child.js' },
  ];
  const withEnvironment = [
    { pid: 10, pgid: 10, startedAt: at, text: `node turn.js HOME=/h ${marker}` },
    // Its environment is shown, without the id: not the turn's.
    { pid: 11, pgid: 11, startedAt: at, text: `node grep.js ${marker} HOME=/h` },
    // No environment shown: the id is in its arguments, so it can't be told.
    { pid: 12, pgid: 12, startedAt: at, text: `sh -c sleep ${marker}` },
    // Another start time, another group, or gone by the second read.
    { pid: 13, pgid: 13, startedAt: at, text: `node reused.js ${marker}` },
    { pid: 14, pgid: 14, startedAt: at, text: `node moved.js ${marker}` },
    { pid: 15, pgid: 15, startedAt: at, text: `node gone.js ${marker}` },
    { pid: 16, pgid: 10, startedAt: at, text: `node child.js ${marker} PATH=/bin` },
    // A longer id isn't this one.
    { pid: 17, pgid: 17, startedAt: at, text: `node other.js ${marker}7` },
  ];
  const found = await findMarkedProcesses({ listEnvironments: async () => withEnvironment, list: async () => plain }, id);
  assert.equal(found.ok, true);
  assert.deepEqual(found.verified.map((row) => row.pid), [10, 16]);
  assert.deepEqual(found.ambiguous.map((row) => row.pid), [12, 13, 14, 15]);
  const failed = await findMarkedProcesses({ listEnvironments: async () => withEnvironment, list: async () => { throw new Error('no ps'); } }, id);
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /no ps/);
});

test('recovery whose look for a turn\'s processes fails keeps the reservation and asks nothing', async (t) => {
  const s = await setup(t, { laneId: 'failed-scan' });
  await saveRelayState(s.lane.laneDir, { ...emptyRelayState(s.lane.laneId), step: 'builder-turn', turn: { id: 'b1c2d3e4f5a6', role: 'builder', command: 'claude', pass: 1, pid: null, pgid: null, process_started_at: null, prompt_sent: false, started_at: new Date().toISOString(), ended: null } });
  const real = createProcessTable();
  const broken = { list: () => real.list(), listEnvironments: async () => { throw new Error('ps: operation not permitted'); }, killGroup: (pgid, signal) => real.killGroup(pgid, signal) };
  const questions = [];
  const result = await s.relay(['--recover'], { relayProcessTable: broken, confirm: async (question) => { questions.push(question); return 'y'; } });
  assert.equal(result.code, 1);
  assert.equal(questions.length, 0, 'nothing is asked');
  assert.match(result.out, /The relay couldn't look for its processes \(ps couldn't list the processes \(ps: operation not permitted\)\), so the lane and conversation stay reserved and nothing is asked\./);
  assert.equal((await readRelayState(s.lane.laneDir)).turn.ended, null, 'the turn stays unfinished');
});

test('a last check before the builder\'s prompt that fails stops the run: the builder starts once, and no prompt goes out', { skip: process.getuid?.() === 0 }, async (t) => {
  const s = await setup(t, { laneId: 'lock-fails' });
  await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: ONE_FINDING }] }, claude: { version: '2.1.318', builderTurns: [{ actions: answerR11(s.lane) }, { actions: answerR11(s.lane) }] } });
  await s.mark();
  // While the builder's process starts, the memory-root lock can't be taken.
  const stateDir = path.join(s.ws.rootDir, 'state');
  await mkdir(stateDir, { recursive: true });
  const restore = () => chmod(stateDir, 0o755).catch(() => {});
  t.after(restore);
  const result = await s.relay([...codexArgs, '--conversation-closed'], { relayOnTurnRecord: async ({ stage, role }) => {
    if (stage === 'identity' && role === 'builder') await chmod(stateDir, 0o500);
  } });
  await restore();
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /Stopped: the last check before the builder's prompt failed \(.*EACCES.*\), so its stdin was closed empty and no model turn ran\. The relay doesn't try the turn again/);
  const builders = (await s.standin.calls()).filter((item) => item.kind === 'builder');
  assert.ok(builders.length <= 1, `the builder started once (${builders.length} recorded)`);
  for (const builder of builders) assert.equal(builder.prompt, '');
  assert.equal((await s.standin.calls()).filter((item) => item.kind === 'review').length, 1);
  const turn = (await readRelayState(s.lane.laneDir)).turn;
  assert.equal(turn.role, 'builder');
  assert.equal(turn.prompt_sent, false);
  assert.equal(turn.ended.how, 'prompt not sent: the last check failed');
  assert.match(await readFile(path.join(s.lane.worktreeDir, 'src', 'index.js'), 'utf8'), /answer = 42/);

  // A mark that can't be read at that check stops the run the same way.
  const u = await setup(t, { laneId: 'mark-unreadable' });
  await u.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: ONE_FINDING }] }, claude: { version: '2.1.318', builderTurns: [{ actions: answerR11(u.lane) }, { actions: answerR11(u.lane) }] } });
  await u.mark();
  const unreadable = await u.relay([...codexArgs, '--conversation-closed'], { relayOnTurnRecord: async ({ stage, role }) => {
    if (stage === 'identity' && role === 'builder') await writeFile(path.join(u.lane.laneDir, 'ready.json'), '{ not json', 'utf8');
  } });
  assert.equal(unreadable.code, 1, unreadable.out);
  assert.match(unreadable.out, /Stopped: the last check before the builder's prompt failed \(.+ready\.json can't be read/);
  assert.equal((await readRelayState(u.lane.laneDir)).turn.ended.how, 'prompt not sent: the last check failed');
});

test('a mark replaced while the builder\'s process is starting: the process gets no prompt, and the lane is read again', async (t) => {
  const OTHER = '9e8d7c6b-2222-4333-8444-555566667777';
  // While the process's identity is recorded; and from a holder of the
  // memory-root lock that ready-for-review writes under, held across the
  // relay's last check, which waits for it.
  for (const [laneId, conversationId, timing] of [['startup-other', OTHER, 'identity'], ['startup-same', CONV, 'identity'], ['startup-locked', CONV, 'locked']]) {
    const s = await setup(t, { laneId });
    await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: ONE_FINDING }, { answer: CONFIRM_R11 }] }, claude: { version: '2.1.318', builderTurns: [{ actions: answerR11(s.lane) }] } });
    await s.mark();
    // After the relay's check before the turn, while the builder's process
    // waits for its prompt: the owner answers by hand and marks again.
    let remarked = false;
    let holder = null;
    const ownerAnswers = async () => {
      await writeReviewLog(s.lane, [...extractReviewLogLines(await s.wip()).lines.map((line) => line.text).filter((line) => line.trim() !== ''), '- response 1 | 2026-11-21 22:00 -08:00 | Claude Opus 5.5', '  - R1.1 | P2 | accepted | fixed the time pattern']);
      await writeFile(path.join(s.lane.worktreeDir, 'src', 'index.js'), 'export const answer = 43;\n', 'utf8');
      await s.mark(conversationId);
      remarked = true;
    };
    const duringStart = async ({ stage, role }) => {
      if (stage !== 'identity' || role !== 'builder' || remarked || holder) return;
      if (timing === 'identity') {
        await ownerAnswers();
        return;
      }
      let entered;
      const inside = new Promise((resolve) => {
        entered = resolve;
      });
      holder = withMemoryRootLock(s.ws.rootDir, 'owner', async () => {
        entered();
        await new Promise((resolve) => setTimeout(resolve, 400));
        await ownerAnswers();
      });
      await inside;
    };
    const result = await s.relay([...codexArgs, '--conversation-closed'], { relayOnTurnRecord: duringStart });
    if (holder) await holder;
    assert.ok(remarked, laneId);
    assert.match(result.out, /Not sending the builder its turn for pass 1: the ready-for-review mark changed \(now round [0-9a-f]{12}\)\. Its process got no prompt, so no model turn ran\. Reading the lane again\./, laneId);
    // The process is ended as its stdin closes empty, often before it can
    // record anything; none ever read a prompt.
    const builders = (await s.standin.calls()).filter((item) => item.kind === 'builder');
    assert.ok(builders.length <= 1, laneId);
    for (const builder of builders) assert.equal(builder.prompt, '', `${laneId}: no prompt`);
    assert.equal(await readFile(path.join(s.lane.worktreeDir, 'src', 'index.js'), 'utf8'), 'export const answer = 43;\n');
    assert.equal(parse(await s.wip()).records.filter((record) => record.kind === 'response').length, 1, `${laneId}: only the owner's response`);
    if (conversationId === OTHER) {
      assert.equal(result.code, 1);
      assert.match(result.out, new RegExp(`now names Claude Code conversation ${OTHER}, not ${CONV}, which this run resumes\\. Nothing was sent to either\\.`));
      const turn = (await readRelayState(s.lane.laneDir)).turn;
      assert.equal(turn.role, 'builder');
      assert.equal(turn.prompt_sent, false);
      assert.equal(turn.ended.how, 'prompt withheld');
    } else {
      assert.equal(result.code, 0, result.out);
      assert.match(result.out, /Stopped: pass 2 is clean/);
    }
  }
});

test('the remote-ref check around a builder turn covers checked-out submodules, nested ones too', async (t) => {
  const s = await setup(t, { laneId: 'submodule-refs' });
  const repo = async (name, file) => {
    const dir = path.join(s.ws.tempDir, name);
    await mkdir(dir);
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    await writeFile(path.join(dir, file), `${name}\n`, 'utf8');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', name]);
    return dir;
  };
  const deep = await repo('deep', 'deep.txt');
  const lib = await repo('lib', 'lib.js');
  git(lib, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', deep, 'deps/deep']);
  git(lib, ['commit', '-q', '-m', 'deep']);
  const wt = s.lane.worktreeDir;
  git(wt, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib']);
  git(wt, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init', '--recursive']);
  git(wt, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'vendor lib']);
  const ctx = { worktrees: { app: wt }, rootDir: s.ws.rootDir, laneDir: s.lane.laneDir, projectRepos: [{ id: 'app' }], env: process.env };
  const sub = path.join(wt, 'vendor', 'lib');
  const nested = path.join(sub, 'deps', 'deep');
  assert.deepEqual(await coveredRepositories(ctx, { paths: [] }), [wt, sub, nested].sort());
  // A ref moved in the nested submodule during the builder's turn is seen.
  const head = git(nested, ['rev-parse', 'HEAD']).trim();
  await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: ONE_FINDING }] }, claude: { version: '2.1.318', builderTurns: [{ actions: [...answerR11(s.lane, { mark: false }), { type: 'run', command: 'git', args: ['-C', nested, 'update-ref', 'refs/remotes/origin/moved', head] }, { type: 'mark-ready' }] }] } });
  await s.mark();
  const result = await s.relay([...codexArgs, '--conversation-closed']);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /a remote-tracking ref moved during the builder's turn in .*vendor\/lib\/deps\/deep: something may have been pushed/);
  // Each turn's processes carried that turn's own id (D-419 item 10).
  const calls = await s.standin.calls();
  const turn = (await readRelayState(s.lane.laneDir)).turn;
  assert.equal(turn.role, 'builder');
  assert.deepEqual(calls.filter((item) => item.kind === 'builder').map((item) => item.turnId), [turn.id]);
  const reviewIds = calls.filter((item) => item.kind === 'review').map((item) => item.turnId);
  assert.equal(reviewIds.length, 1);
  assert.match(reviewIds[0], /^[0-9a-f]{12}$/);
  assert.notEqual(reviewIds[0], turn.id);
});

test('after the leader exits, a group member that stays is read once per poll interval, not continuously', async (t) => {
  const s = await setup(t, { laneId: 'poll-rate' });
  const started = path.join(s.ws.tempDir, 'leader-started');
  await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: CLEAN_ANSWER, startedMarker: started }] } });
  await s.mark(null);
  // The real table, read at most once a second, with one member of the
  // turn's group that stays 1.5 s: each read is cheap, so only the relay's
  // own pacing bounds how often it reads.
  const real = createProcessTable();
  let cached = null;
  let member = null;
  const reads = [];
  const table = {
    async list() {
      const now = Date.now();
      if (!member && existsSync(started)) member = { pgid: Number(await readFile(started, 'utf8')), until: now + 1500 };
      if (member) reads.push(now);
      if (!cached || now - cached.at > 1000) cached = { at: now, rows: await real.list() };
      return [...cached.rows, ...(member && now < member.until ? [{ pid: 999_992, pgid: member.pgid, startedAt: 'Fri Dec 31 23:59:59 2099', command: 'a member that stays' }] : [])];
    },
    killGroup: (pgid, signal) => real.killGroup(pgid, signal),
  };
  const result = await s.relay(codexArgs, { relayProcessTable: table });
  assert.equal(result.code, 0, result.out);
  assert.ok(reads.length >= 3, `the group was read while the member stayed (${reads.length})`);
  assert.ok(reads.length <= 16, `${reads.length} reads in about 1.5 s; one per 250 ms poll allows a few more than 6`);
});

test('a timeout while the process is being recorded closes stdin empty: no prompt reaches a tool still running', async (t) => {
  const s = await setup(t, { laneId: 'late-prompt' });
  await s.standin.setScenario({ codex: { version: '0.171.0', ignoreSigterm: true, reviewTurns: [{ answer: CLEAN_ANSWER }] } });
  await s.mark(null);
  // The record takes a second; the limit is a fraction of that. The tool keeps
  // running through SIGTERM, so it would read whatever stdin carried.
  const result = await s.relay([...codexArgs, '--reviewer-timeout', '0.002'], { relayKillGraceMs: 4000, relayOnTurnRecord: async ({ stage }) => { if (stage === 'identity') await new Promise((resolve) => setTimeout(resolve, 1000)); } });
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /Stopped: the reviewer's turn reached its 1 second limit before its prompt was sent, so no model turn ran; its process group was ended, and no pass was recorded\./);
  const reviews = (await s.standin.calls()).filter((item) => item.kind === 'review');
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].prompt, '', 'the tool read an empty stdin');
  const state = await readRelayState(s.lane.laneDir);
  assert.equal(state.turn.prompt_sent, false);
  assert.equal(state.turn.possibly_partial, false);
  assert.equal(parse(await s.wip()).passCount, 0);
});
