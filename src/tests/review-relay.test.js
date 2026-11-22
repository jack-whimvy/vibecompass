import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../cli.js';
import { readReadyMark } from '../relay-mark.js';
import { prepareRelayWrite } from '../relay-record.js';
import { computeCurrentFingerprints } from '../relay-mark.js';
import { emptyRelayState, readRelayState, saveRelayState } from '../relay-state.js';
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
  assert.match(noMark.out, /has no ready-for-review mark\. The builder runs `vibecompass ready-for-review --session relay-lane`/);
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
  // The stand-in's action can't run git, so the test stages while the turn waits.
  await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: CLEAN_ANSWER, waitFor: path.join(s.ws.tempDir, 'staged-now') }] } });
  const running = s.relay(codexArgs);
  await new Promise((resolve) => setTimeout(resolve, 600));
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
  assert.match(lowered.out, /run `vibecompass review-relay --session cap-low --past-cap` for one more pass/);
  assert.match(lowered.out, /- R1\.1 \(P2\) accepted, waiting for the reviewer: the parser accepts a bad time/);

  // Raised: cap 1, the builder raises it to 3; the go is used up, and a new run continues.
  const high = await setup(t, { review: ['check: block', 'round_cap: 1'], laneId: 'cap-high' });
  await high.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: ONE_FINDING }, { answer: CONFIRM_R11 }] }, claude: { version: '2.1.318', builderTurns: [{ actions: [...answerR11(high.lane, { mark: false }), { type: 'run', command: 'node', args: [CLI_PATH, 'review-settings', '--root', high.ws.rootDir, '--round-cap', '3'] }, { type: 'mark-ready' }] }] } });
  await high.mark();
  const raised = await high.relay([...codexArgs, '--conversation-closed']);
  assert.equal(raised.code, 0);
  assert.match(raised.out, /Stopped: this run's go covered 1 passes, and the cap is now 3: the go is used up\./);
  assert.match(raised.out, /run `vibecompass review-relay --session cap-high` again: a new run continues up to the current cap/);
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
  const release = path.join(s.ws.tempDir, 'never');
  await s.standin.setScenario({ codex: { version: '0.171.0', reviewTurns: [{ answer: CLEAN_ANSWER, startedMarker: started, waitFor: release }, { answer: CLEAN_ANSWER }] } });
  await s.mark(null);
  const running = s.relay(codexArgs);
  while (!existsSync(started)) await new Promise((resolve) => setTimeout(resolve, 50));
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
  assert.match(result.out, /the reviewer's turn ran past 0 minutes; its process group was ended, and no pass was recorded\./);
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
  assert.match(context, /- the owner may relay a round with `vibecompass review-relay --session <lane-id>` instead of starting a reviewer by hand/);
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
  for (const text of [context, guide]) {
    assert.doesNotMatch(text, /\bD-\d{3}\b/, 'installed text names no decision number');
  }
});
