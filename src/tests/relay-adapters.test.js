import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BUILDER_DENY_LIST,
  CLAUDE_REVIEWER_ALLOWED_COMMANDS,
  CLAUDE_REVIEWER_DENIED,
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
  reviewerTurnEnv,
  shellWord,
  validateBuilderMode,
} from '../relay-adapters.js';
import {
  classifyAppsCheck,
  classifyFixtureCheck,
  classifyWriteCheck,
  qualificationVerdict,
  readClaudeWriteEvidence,
  readCodexRollout,
  runWatchedTurn,
  startedBefore,
  versionVerdict,
  waitForNoFixture,
  watchCovered,
  watchProcesses,
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
  // Exactly the versions the real-tool checks passed on, and no other platform.
  assert.deepEqual(JSON.parse(JSON.stringify(SUPPORTED_REVIEWER_VERSIONS)), { codex: { darwin: ['0.171.0'] }, claude: { darwin: [] } });
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
  for (const flag of ['--safe-mode', '--restricted', '--strict-mcp-config', '--include-hook-events', '--verbose']) assert.ok(reviewer.args.includes(flag), flag);
  assert.equal(reviewer.args[reviewer.args.indexOf('--permission-mode') + 1], 'default');
  assert.ok(!reviewer.args.includes('--resume'));
  assert.ok(!reviewer.args.includes('--add-dir'));
  assert.equal(claudeReviewerLaunch({ schemaJson: '{}', conversationId: 'c-1' }).args[2], 'c-1');
  const withDirs = claudeReviewerLaunch({ schemaJson: '{}', addDirs: ['/memory', '/repo'] }).args;
  assert.deepEqual(withDirs.filter((arg, index) => withDirs[index - 1] === '--add-dir'), ['/memory', '/repo']);
  // No command that runs another command or writes a file through an option.
  assert.ok(!CLAUDE_REVIEWER_ALLOWED_COMMANDS.some((rule) => /git grep/.test(rule)));
  assert.ok(CLAUDE_REVIEWER_DENIED.includes('Bash(*--output*)'));
  assert.equal(reviewerTurnEnv({ VIBECOMPASS_RELAY_TURN: 'x' }).GIT_OPTIONAL_LOCKS, '0');
  assert.equal(reviewerTurnEnv({ VIBECOMPASS_RELAY_TURN: 'x' }).VIBECOMPASS_RELAY_TURN, undefined);
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
  // The answer schema adds StructuredOutput, which the reading set allows.
  const withAnswerTool = JSON.stringify({ type: 'system', subtype: 'init', tools: ['Bash', 'Glob', 'Grep', 'Read', 'StructuredOutput'], mcp_servers: [], plugins: [] });
  assert.equal(checkClaudeReviewerStream(readClaudeStream(withAnswerTool)), null);
  const withPlugin = JSON.stringify({ type: 'system', subtype: 'init', tools: ['Read'], mcp_servers: [], plugins: [{ name: 'p', path: '/x', source: 'p@market' }] });
  assert.match(checkClaudeReviewerStream(readClaudeStream(withPlugin)), /lists a plugin \(p\)/);
  // The four plugins built into Claude Code 2.1.318, as its init listed them in the real checks, don't end the turn.
  const builtIn = ['cc-plugin-agents-md', 'cc-plugin-telemetry', 'cc-plugin-privacy', 'cc-plugin-plugin-authoring'].map((name) => ({ name, path: 'builtin', source: `${name}@builtin` }));
  const withBuiltIn = JSON.stringify({ type: 'system', subtype: 'init', tools: ['Bash', 'Glob', 'Grep', 'Read', 'StructuredOutput'], mcp_servers: [], plugins: builtIn });
  assert.equal(checkClaudeReviewerStream(readClaudeStream(withBuiltIn)), null);
  // Only one of the two marks, or another plugin beside the built-in ones, still ends it.
  for (const [plugin, name] of [[{ name: 'a', path: 'builtin', source: 'a@market' }, 'a'], [{ name: 'b', path: '/plugins/b', source: 'b@builtin' }, 'b'], [{ name: 'c', path: 'builtin' }, 'c'], ['d', 'd']]) {
    const mixed = JSON.stringify({ type: 'system', subtype: 'init', tools: ['Read'], mcp_servers: [], plugins: [...builtIn, plugin] });
    const reason = checkClaudeReviewerStream(readClaudeStream(mixed));
    assert.match(reason, new RegExp(`lists a plugin \\(${name}\\)$`));
  }
  // An init that doesn't list its tools, MCP servers, or plugins can't be checked, so it ends the turn.
  for (const [key, label] of [['tools', 'tools'], ['mcp_servers', 'MCP servers'], ['plugins', 'plugins']]) {
    const init = { type: 'system', subtype: 'init', tools: ['Read'], mcp_servers: [], plugins: [] };
    delete init[key];
    assert.match(checkClaudeReviewerStream(readClaudeStream(JSON.stringify(init))), new RegExp(`init doesn't list its ${label}`));
    assert.match(checkClaudeReviewerStream(readClaudeStream(JSON.stringify({ ...init, [key]: 'x' }))), new RegExp(`init doesn't list its ${label}`));
  }
  // A hook event or an MCP server still ends a turn whose plugins are all built in.
  const builtInWithMcp = JSON.stringify({ type: 'system', subtype: 'init', tools: ['Read'], mcp_servers: [{ name: 'x' }], plugins: builtIn });
  assert.match(checkClaudeReviewerStream(readClaudeStream(builtInWithMcp)), /MCP server \(x\)/);
});

test('the fixed text carries only the lane id, the pass number, paths, and the round id', () => {
  const reviewer = reviewerPrompt({ laneId: 'lane-x', passNumber: 3, rootDir: '/root', roundId: 'a'.repeat(64) });
  assert.match(reviewer, /^review handoff lane-x\n/);
  assert.match(reviewer, /pass 3, round aaaaaaaaaaaa/);
  assert.match(reviewer, /Write no file and change nothing/);
  const builder = builderPrompt({ laneId: 'lane-x', passNumber: 3, rootDir: '/w/vibecompass-docs', paths: ['app:src', "docs/it's here.md"] });
  assert.match(builder, /^address review lane-x\n/);
  // The memory root and the last mark's paths, so the new mark covers the same work from any folder.
  assert.ok(builder.includes("`vibecompass ready-for-review --root /w/vibecompass-docs --session lane-x --path app:src --path 'docs/it'\\''s here.md'`"), builder);
  assert.equal(shellWord('/plain/path-1.md'), '/plain/path-1.md');
  assert.equal(shellWord('a b'), "'a b'");
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

test('the apps check: the control shows the account\'s apps one way or another, the reviewer\'s launch no way', () => {
  const none = { appTools: [], mcpConnections: 0, cacheWritten: false };
  // 0.147.0's thread record lists no tools: the cache write alone shows the control loaded them.
  const cacheOnly = classifyAppsCheck({ control: { ...none, cacheWritten: true }, restricted: none });
  assert.equal(cacheOnly.verdict, 'held');
  assert.match(cacheOnly.reason, /the apps tool cache written during the run/);
  assert.equal(classifyAppsCheck({ control: { ...none, appTools: ['mcp__codex_apps__x'] }, restricted: none }).verdict, 'held');
  assert.equal(classifyAppsCheck({ control: none, restricted: none }).verdict, 'inconclusive');
  // Any one way under the reviewer's launch counts as loaded.
  for (const leak of [{ cacheWritten: true }, { appTools: ['mcp__codex_apps__x'] }, { mcpConnections: 1 }]) {
    const check = classifyAppsCheck({ control: { ...none, cacheWritten: true }, restricted: { ...none, ...leak } });
    assert.equal(check.verdict, 'loaded');
    assert.equal(versionVerdict([{ verdict: 'held' }, check]), 'fail');
  }
});

test('a restricted run seen through a gap, or whose fixture wrote its marker, never holds', () => {
  const control = { seen: true, marker: true };
  assert.equal(classifyFixtureCheck({ control, restricted: { seen: false, marker: false, covered: true } }).verdict, 'held');
  assert.equal(classifyFixtureCheck({ control, restricted: { seen: false, marker: false, covered: false } }).verdict, 'inconclusive');
  assert.equal(classifyFixtureCheck({ control, restricted: { seen: false, marker: false } }).verdict, 'inconclusive');
  assert.match(classifyFixtureCheck({ control, restricted: { seen: false, marker: true, covered: true } }).reason, /marker was written under the reviewer's launch/);
  assert.equal(classifyFixtureCheck({ control, restricted: { seen: false, marker: true, covered: false } }).verdict, 'loaded');
  // Coverage: reads before the start and after the end, and no failed read.
  const coverage = (failures = []) => ({ polls: 5, failures, firstAt: 1000, lastAt: 9000 });
  assert.equal(watchCovered(coverage(), { startedAt: 1500, endedAt: 8000 }), true);
  assert.equal(watchCovered(coverage([{ at: 4000, error: 'ps failed' }]), { startedAt: 1500, endedAt: 8000 }), false);
  assert.equal(watchCovered(coverage(), { startedAt: 1500, endedAt: 9500 }), false);
  assert.equal(watchCovered({ polls: 0, failures: [], firstAt: null, lastAt: null }, { startedAt: 1, endedAt: 2 }), false);
});

test('a version passes only with every expected check, clean launches, an empty-stdin exit, and accepted turns', () => {
  const held = (name) => ({ check: name, verdict: 'held' });
  const expected = ['a (fresh)', 'a (resumed)'];
  const ok = { checks: expected.map(held), expected, launches: [{ name: 'fresh', exit: 0 }, { name: 'resumed', exit: 0 }], emptyStdin: { exit: 1, model_turn: false } };
  assert.equal(qualificationVerdict(ok).verdict, 'pass');
  assert.match(qualificationVerdict({ ...ok, checks: [held('a (fresh)')] }).reasons.join(), /missing checks: a \(resumed\)/);
  assert.equal(qualificationVerdict({ ...ok, checks: [held('a (fresh)')] }).verdict, 'inconclusive');
  assert.equal(qualificationVerdict({ ...ok, launches: [{ name: 'resumed', exit: 'not run' }] }).verdict, 'inconclusive');
  assert.equal(qualificationVerdict({ ...ok, emptyStdin: null }).verdict, 'inconclusive');
  assert.equal(qualificationVerdict({ ...ok, emptyStdin: { exit: 0, model_turn: true } }).verdict, 'fail');
  assert.equal(qualificationVerdict({ ...ok, turnChecks: { 'the fresh turn': 'accepted', 'the resumed turn': 'the reviewer\'s init lists a plugin (x)' } }).verdict, 'fail');
  assert.equal(qualificationVerdict({ ...ok, turnChecks: { 'the fresh turn': 'accepted', 'the resumed turn': 'accepted' } }).verdict, 'pass');
  assert.equal(qualificationVerdict({ ...ok, checks: [held('a (fresh)'), { check: 'a (resumed)', verdict: 'inconclusive' }] }).verdict, 'inconclusive');
});

test('write checks need the tool\'s record of a refused attempt', () => {
  assert.equal(classifyWriteCheck({ fileCreated: true, attempted: true, refusalEvidence: 'x' }).verdict, 'failed');
  assert.equal(classifyWriteCheck({ fileCreated: false, attempted: false, refusalEvidence: null }).verdict, 'inconclusive');
  assert.equal(classifyWriteCheck({ fileCreated: false, attempted: true, refusalEvidence: null }).verdict, 'inconclusive');
  assert.equal(classifyWriteCheck({ fileCreated: false, attempted: true, refusalEvidence: 'touch: probe.txt: Operation not permitted' }).verdict, 'held');
  const rollout = [
    JSON.stringify({ type: 'turn_context', payload: { sandbox_policy: { type: 'read-only' } } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Run touch probe.txt; touch probe-2.txt is not permitted here' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'c1', arguments: '{"command":["touch","probe.txt"]}' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'touch: probe.txt: Operation not permitted' } }),
    JSON.stringify({ type: 'turn_context', payload: { sandbox_policy: { type: 'read-only' } } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c2', input: 'exec touch probe-2.txt' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c3', input: 'exec ls' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c3', output: 'ls: x: Operation not permitted' } }),
  ].join('\n');
  const evidence = readCodexRollout(rollout, 'probe.txt', { turn: 0 });
  assert.equal(evidence.attempted, true);
  assert.match(evidence.refused, /touch: probe\.txt: Operation not permitted/);
  assert.deepEqual(evidence.sandboxPolicies, ['{"type":"read-only"}']);
  // In the second turn the probe's own call has no recorded output: another
  // call's denial and the prompt's words don't count, so there's no refusal.
  const second = readCodexRollout(rollout, 'probe-2.txt', { turn: 1 });
  assert.equal(second.attempted, true);
  assert.equal(second.refused, null);
  assert.equal(classifyWriteCheck({ fileCreated: false, attempted: second.attempted, refusalEvidence: second.refused }).verdict, 'inconclusive');
  // A probe named only in the prompt was never attempted.
  assert.equal(readCodexRollout(rollout, 'probe-2.txt', { turn: 0 }).attempted, false);
  const stream = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Write', input: { file_path: '/x/probe.txt' } }] } }),
    JSON.stringify({ type: 'result', permission_denials: [{ tool_name: 'Write', tool_use_id: 'tu-1' }] }),
  ].join('\n');
  assert.deepEqual(readClaudeWriteEvidence(stream, { pathFragment: 'probe.txt' }), { attempted: true, refusal: 'a permission_denials entry for that call (Write)' });
  // A refusal of another call isn't evidence for this one.
  const other = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'touch probe.txt' } }, { type: 'tool_use', id: 'tu-2', name: 'Bash', input: { command: 'rm -rf x' } }] } }),
    JSON.stringify({ type: 'system', subtype: 'permission_denied', tool_use_id: 'tu-2', message: 'denied' }),
    JSON.stringify({ type: 'result', permission_denials: [{ tool_name: 'Bash', tool_use_id: 'tu-2' }] }),
  ].join('\n');
  assert.deepEqual(readClaudeWriteEvidence(other, { toolNames: ['Bash'], pathFragment: 'probe.txt' }), { attempted: true, refusal: null });
  const event = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-3', name: 'Bash', input: { command: 'touch probe.txt' } }] } }),
    JSON.stringify({ type: 'system', subtype: 'permission_denied', tool_use_id: 'tu-3', message: 'Permission to use Bash with command touch probe.txt has been denied.' }),
  ].join('\n');
  assert.match(readClaudeWriteEvidence(event, { toolNames: ['Bash'], pathFragment: 'probe.txt' }).refusal, /^a permission_denied event for that call/);
});

test('the check harness ignores a fixture an earlier run left running, and waits for it to end first', async () => {
  assert.equal(startedBefore('Sat Nov 21 23:44:23 2026', new Date(Date.parse('Sat Nov 21 23:44:24 2026') + 500)), true);
  assert.equal(startedBefore('Sat Nov 21 23:44:24 2026', new Date(Date.parse('Sat Nov 21 23:44:24 2026') + 500)), false, 'the same second counts as this turn');
  const startedAfter = new Date(Date.parse('Sat Nov 21 23:44:30 2026'));
  const rows = [
    { pid: 10, pgid: 10, startedAt: 'Sat Nov 21 23:44:05 2026', command: 'node fixture.js m tok-left' },
    { pid: 11, pgid: 11, startedAt: 'Sat Nov 21 23:44:31 2026', command: 'node fixture.js m tok-new' },
  ];
  const watcher = watchProcesses({ table: { list: async () => rows }, token: 'tok-', intervalMs: 5, startedAfter });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const watched = await watcher.stop();
  assert.deepEqual(watched.rows.map((row) => row.pid), [11]);
  assert.deepEqual(watched.ignored.map((row) => row.pid), [10]);
  let reads = 0;
  const draining = { list: async () => (reads++ < 2 ? [rows[0]] : []) };
  assert.deepEqual(await waitForNoFixture({ table: draining, token: 'tok-', intervalMs: 5 }), { waited: true, left: [] });
  const stuck = await waitForNoFixture({ table: { list: async () => [rows[0]] }, token: 'tok-', intervalMs: 5, timeoutMs: 20 });
  assert.equal(stuck.waited, false);
});
