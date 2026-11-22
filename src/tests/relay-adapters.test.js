import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BUILDER_DENY_LIST,
  SUPPORTED_REVIEWER_VERSIONS,
  builderPrompt,
  builderTurnEnv,
  checkBuilderInit,
  checkBuilderVersion,
  checkClaudeReviewerStream,
  checkReviewerVersion,
  claudeAnswer,
  claudeBuilderLaunch,
  claudeReviewerLaunch,
  codexReviewerLaunch,
  compareVersions,
  parseToolVersion,
  readClaudeStream,
  readCodexEvents,
  reviewerPrompt,
  validateBuilderMode,
} from '../relay-adapters.js';
import {
  classifyFixtureCheck,
  classifyWriteCheck,
  readClaudeWriteEvidence,
  readCodexRollout,
  runWatchedTurn,
  versionVerdict,
} from '../../scripts/relay-capability-check.js';

// D-419 items 5, 7, 8, and 12: the adapters' version gates, launches, turn
// environment, stream checks, and fixed text; and item 17's check harness
// with a stand-in tool.

test('tool versions parse and compare', () => {
  assert.equal(parseToolVersion('codex-cli 0.171.0'), '0.171.0');
  assert.equal(parseToolVersion('2.1.318 (Claude Code)'), '2.1.318');
  assert.equal(parseToolVersion('nothing here'), null);
  assert.equal(compareVersions('2.1.318', '2.1.318'), 0);
  assert.equal(compareVersions('2.1.330', '2.1.318'), 1);
  assert.equal(compareVersions('2.1.9', '2.1.318'), -1);
  assert.equal(compareVersions('2.1.318-beta.1', '2.1.318'), -1);
});

test('the reviewer gate: exact listed versions only, per platform', () => {
  const supported = { codex: { darwin: ['0.147.0', '0.171.0'] }, claude: { darwin: [] } };
  assert.equal(checkReviewerVersion({ tool: 'codex', version: '0.147.0', platform: 'darwin', supported }).ok, true);
  assert.equal(checkReviewerVersion({ tool: 'codex', version: '0.171.0', platform: 'darwin', supported }).ok, true);
  const between = checkReviewerVersion({ tool: 'codex', version: '0.160.0', platform: 'darwin', supported, otherTool: 'claude' });
  assert.equal(between.ok, false);
  assert.match(between.message, /Codex 0\.160\.0 isn't a supported reviewer version on darwin \(supported: 0\.147\.0, 0\.171\.0\)\. The relay checks exact versions only\./);
  assert.equal(checkReviewerVersion({ tool: 'codex', version: '0.172.0', platform: 'darwin', supported }).ok, false);
  assert.equal(checkReviewerVersion({ tool: 'codex', version: '0.171.0', platform: 'linux', supported }).ok, false);
  assert.match(checkReviewerVersion({ tool: 'claude', version: '2.1.318', platform: 'darwin', supported }).message, /The Claude Code reviewer isn't enabled on darwin/);
  assert.match(checkReviewerVersion({ tool: 'codex', version: null, platform: 'darwin', supported }).message, /version couldn't be read/);
});

test('the package lists only versions whose capability checks held', () => {
  for (const tool of ['codex', 'claude']) {
    for (const versions of Object.values(SUPPORTED_REVIEWER_VERSIONS[tool])) {
      for (const version of versions) assert.match(version, /^\d+\.\d+\.\d+$/);
    }
  }
  assert.ok(Object.isFrozen(SUPPORTED_REVIEWER_VERSIONS));
});

test('the builder gate: the minimum, and newer versions run with a note', () => {
  assert.equal(checkBuilderVersion({ version: '2.1.318' }).ok, true);
  assert.equal(checkBuilderVersion({ version: '2.1.318' }).message, null);
  const newer = checkBuilderVersion({ version: '2.1.330' });
  assert.equal(newer.ok, true);
  assert.match(newer.message, /newer than the newest version checked with the relay \(2\.1\.318\); it runs, and each turn's init is checked/);
  assert.match(checkBuilderVersion({ version: '2.1.300' }).message, /older than the relay's builder minimum, 2\.1\.318/);
  assert.equal(checkBuilderVersion({ version: null }).ok, false);
});

test('builder modes: default, acceptEdits, auto; bypass modes refused', () => {
  assert.equal(validateBuilderMode(undefined), 'default');
  for (const mode of ['default', 'acceptEdits', 'auto']) assert.equal(validateBuilderMode(mode), mode);
  for (const mode of ['bypassPermissions', 'dangerously-skip-permissions', 'dontAsk', 'plan']) {
    assert.throws(() => validateBuilderMode(mode), /is refused|must be default/);
  }
  assert.throws(() => validateBuilderMode('yolo'), /must be default, acceptEdits, or auto/);
});

test('the Codex launches: read-only fresh, resume without a sandbox flag', () => {
  const fresh = codexReviewerLaunch({ model: 'gpt-x', schemaPath: '/s.json', outputPath: '/o.json', gitRepository: false });
  assert.deepEqual(fresh.args, ['exec', '-s', 'read-only', '--ignore-user-config', '--ignore-rules', '--disable', 'hooks', '--disable', 'apps', '--disable', 'plugins', '--disable', 'browser_use', '--disable', 'in_app_browser', '--disable', 'computer_use', '-m', 'gpt-x', '--output-schema', '/s.json', '-o', '/o.json', '--json', '--skip-git-repo-check']);
  const resumed = codexReviewerLaunch({ model: 'gpt-x', schemaPath: '/s.json', outputPath: '/o.json', threadId: 't-1' });
  assert.deepEqual(resumed.args.slice(0, 3), ['exec', 'resume', 't-1']);
  assert.ok(!resumed.args.includes('-s'));
  for (const launch of [fresh, resumed]) {
    assert.ok(!launch.args.some((arg) => /dangerously|full-access|workspace-write/.test(arg)));
  }
});

test('the Claude Code launches: the reviewer\'s reading set, and the builder\'s resume with the deny list', () => {
  const reviewer = claudeReviewerLaunch({ schemaJson: '{}' });
  assert.equal(reviewer.args[0], '-p');
  for (const flag of ['--safe-mode', '--strict-mcp-config', '--include-hook-events', '--verbose']) assert.ok(reviewer.args.includes(flag));
  assert.equal(reviewer.args[reviewer.args.indexOf('--permission-mode') + 1], 'default');
  assert.ok(!reviewer.args.includes('--resume'));
  assert.equal(claudeReviewerLaunch({ schemaJson: '{}', conversationId: 'c-1' }).args[2], 'c-1');
  const builder = claudeBuilderLaunch({ conversationId: 'conv', mode: 'auto' });
  assert.deepEqual(builder.args.slice(0, 5), ['-p', '--resume', 'conv', '--permission-mode', 'auto']);
  assert.deepEqual(builder.args.slice(builder.args.indexOf('--disallowedTools') + 1), [...BUILDER_DENY_LIST]);
  for (const pattern of ['Bash(git push:*)', 'Bash(git merge:*)', 'Bash(gh pr merge:*)', 'Bash(gh release:*)', 'Bash(npm publish:*)', 'Bash(*close-session*)', 'Bash(*end-session*)', 'Bash(*review-relay*)', 'Bash(*promote-hosted*)', 'Bash(*demote-hosted*)', 'Bash(*connect-hosted*)', 'Bash(*sync-adopt*)']) {
    assert.ok(BUILDER_DENY_LIST.includes(pattern), pattern);
  }
  assert.throws(() => claudeBuilderLaunch({ conversationId: 'conv', mode: 'bypassPermissions' }), /refused/);
});

test('the builder turn\'s environment rewrites every push prefix and drops GitHub sign-ins', () => {
  const env = builderTurnEnv({ PATH: '/bin', GH_TOKEN: 'a', GITHUB_TOKEN: 'b', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'x' }, { ghConfigDir: '/empty', relayToken: 'tok' });
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GH_CONFIG_DIR, '/empty');
  assert.equal(env.VIBECOMPASS_RELAY_TURN, 'tok');
  assert.equal(env.GIT_CONFIG_COUNT, '7');
  assert.equal(env.GIT_CONFIG_KEY_0, 'user.name', 'existing entries are kept');
  const values = [1, 2, 3, 4, 5, 6].map((index) => [env[`GIT_CONFIG_KEY_${index}`], env[`GIT_CONFIG_VALUE_${index}`]]);
  assert.deepEqual(values.map(([, value]) => value), ['https://', 'ssh://', 'git://', 'git@', 'file://', '/']);
  assert.ok(values.every(([key]) => key === 'url.relay-blocked::.pushInsteadOf'));
});

test('streams: Codex thread ids and failures; Claude Code init, hooks, and results', () => {
  const codex = readCodexEvents('{"type":"thread.started","thread_id":"th-1"}\n{"type":"turn.completed"}\n');
  assert.deepEqual([codex.threadId, codex.failed, codex.completed], ['th-1', null, true]);
  assert.equal(readCodexEvents('{"type":"turn.failed","error":{"message":"model_not_found"}}').failed, 'model_not_found');

  const hook = JSON.stringify({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart' });
  const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'c-1', permissionMode: 'default', tools: ['Read', 'Glob', 'Grep', 'Bash'], mcp_servers: [], plugins: [] });
  const result = JSON.stringify({ type: 'result', subtype: 'success', structured_output: { ok: 1 }, permission_denials: [] });
  const stream = readClaudeStream([hook, hook, init, result].join('\n'));
  assert.equal(stream.otherBeforeInit.length, 0);
  assert.equal(checkBuilderInit(stream, { conversationId: 'c-1', mode: 'default' }), null);
  assert.match(checkBuilderInit(stream, { conversationId: 'c-1', mode: 'auto' }), /permission mode default, not auto/);
  assert.match(checkBuilderInit(readClaudeStream([JSON.stringify({ type: 'assistant' }), init].join('\n')), { conversationId: 'c-1', mode: 'default' }), /had an event \(assistant\) before init/);
  assert.deepEqual(claudeAnswer(stream.result), { ok: 1 });
  assert.deepEqual(claudeAnswer({ result: '{"read":"x"}' }), { read: 'x' });
  // Every Claude Code reviewer turn: SessionStart hook events are always in the stream, so any hook event discards it.
  assert.match(checkClaudeReviewerStream(stream), /shows a hook event/);
  assert.equal(checkClaudeReviewerStream(readClaudeStream([init, result].join('\n'))), null);
  const withMcp = JSON.stringify({ type: 'system', subtype: 'init', tools: ['Read'], mcp_servers: [{ name: 'x' }], plugins: [] });
  assert.match(checkClaudeReviewerStream(readClaudeStream(withMcp)), /lists an MCP server \(x\)/);
  const withTool = JSON.stringify({ type: 'system', subtype: 'init', tools: ['Read', 'Write'], mcp_servers: [], plugins: [] });
  assert.match(checkClaudeReviewerStream(readClaudeStream(withTool)), /tools outside the reading set \(Write\)/);
});

test('the fixed text carries only the lane id, the pass number, paths, and the round id', () => {
  const reviewer = reviewerPrompt({ laneId: 'lane-x', passNumber: 3, rootDir: '/root', roundId: 'a'.repeat(64) });
  assert.match(reviewer, /^review handoff lane-x\n/);
  assert.match(reviewer, /pass 3, round aaaaaaaaaaaa/);
  assert.match(reviewer, /Write no file and change nothing/);
  const builder = builderPrompt({ laneId: 'lane-x', passNumber: 3 });
  assert.match(builder, /^address review lane-x\n/);
  assert.match(builder, /vibecompass ready-for-review --session lane-x/);
  assert.match(builder, /don't close the lane, push code or project memory, merge, publish, release, start a reviewer, run the relay/);
  assert.doesNotMatch(reviewer + builder, /D-\d{3}/, 'no decision number in installed text');
});

// ---------------------------------------------------------------------------
// The check harness, with a stand-in tool

const STANDIN_TOOL = `
const { spawn } = require('node:child_process');
const [mode, marker] = process.argv.slice(1);
const token = process.env.FIXTURE_TOKEN;
if (mode !== 'none') {
  const write = mode === 'fixture-with-marker' ? "require('fs').writeFileSync(" + JSON.stringify(marker) + ", 'x');" : '';
  spawn(process.execPath, ['-e', write + 'setTimeout(() => {}, 1200) /* ' + token + ' */'], { stdio: 'ignore' }).unref();
}
setTimeout(() => {}, 300);
`;

async function turn(t, mode) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-check-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const token = `relay-fixture-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const marker = path.join(dir, 'marker');
  // The token reaches only the fixture's command line, as a config file would put it there.
  return runWatchedTurn({ command: process.execPath, args: ['-e', STANDIN_TOOL, mode, marker], cwd: dir, env: { ...process.env, FIXTURE_TOKEN: token }, token, markerPath: marker, timeoutMs: 20_000 });
}

test('the check harness: a fixture that starts but can\'t create its marker counts as loaded and fails the version', async (t) => {
  const control = await turn(t, 'fixture-with-marker');
  assert.equal(control.seen, true);
  assert.equal(control.marker, true);
  const restricted = await turn(t, 'fixture-no-marker');
  assert.equal(restricted.seen, true);
  assert.equal(restricted.marker, false);
  const check = classifyFixtureCheck({ control, restricted });
  assert.equal(check.verdict, 'loaded');
  assert.match(check.reason, /without writing its marker, which counts as loaded/);
  assert.equal(versionVerdict([{ verdict: 'held' }, check]), 'fail');
});

test('the check harness: a control in which the fixture never appears is inconclusive', async (t) => {
  const control = await turn(t, 'none');
  const restricted = await turn(t, 'none');
  const check = classifyFixtureCheck({ control, restricted });
  assert.equal(check.verdict, 'inconclusive');
  assert.equal(versionVerdict([{ verdict: 'held' }, check]), 'inconclusive');
});

test('the check harness: a fixture absent for the whole restricted turn, with the control showing it, passes', async (t) => {
  const control = await turn(t, 'fixture-with-marker');
  const restricted = await turn(t, 'none');
  const check = classifyFixtureCheck({ control, restricted });
  assert.equal(check.verdict, 'held');
  assert.equal(versionVerdict([check, { verdict: 'held' }]), 'pass');
});

test('write checks need the tool\'s record of a refused attempt', () => {
  assert.equal(classifyWriteCheck({ fileCreated: true, attempted: true, refusalEvidence: 'x' }).verdict, 'failed');
  assert.equal(classifyWriteCheck({ fileCreated: false, attempted: false, refusalEvidence: null }).verdict, 'inconclusive');
  assert.equal(classifyWriteCheck({ fileCreated: false, attempted: true, refusalEvidence: null }).verdict, 'inconclusive');
  assert.equal(classifyWriteCheck({ fileCreated: false, attempted: true, refusalEvidence: 'touch: probe.txt: Operation not permitted' }).verdict, 'held');
  const rollout = [
    JSON.stringify({ type: 'turn_context', payload: { type: 'turn_context', sandbox_policy: { type: 'read-only' } } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call', arguments: '{"command":["touch","probe.txt"]}' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'touch: probe.txt: Operation not permitted' } }),
  ].join('\n');
  const evidence = readCodexRollout(rollout, 'probe.txt');
  assert.equal(evidence.attempted, true);
  assert.match(evidence.refused, /Operation not permitted/);
  assert.deepEqual(evidence.sandboxPolicies, ['{"type":"read-only"}']);
  const stream = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/x/probe.txt' } }] } }),
    JSON.stringify({ type: 'result', permission_denials: [{ tool_name: 'Write' }] }),
  ].join('\n');
  assert.deepEqual(readClaudeWriteEvidence(stream, { pathFragment: 'probe.txt' }), { attempted: true, refusal: 'permission_denials: Write' });
});
