#!/usr/bin/env node
// The review relay's reviewer capability check harness (D-419 items 5 and 17).
// Not part of the published package: it runs the checks that decide which exact
// reviewer versions the package lists. A capability counts as held only with
// evidence that it was tried and refused or never loaded:
// - a hook or MCP fixture is watched for in the process table from outside the
//   tool, throughout the turn; a control run without the restricting flags must
//   show it running with its marker written, or the check is inconclusive;
// - a write counts as refused only from the tool's own record of the attempt.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createProcessTable } from '../src/relay-state.js';

/**
 * Watches the process table for a command line containing `token` until
 * stopped. Resolves `{ seen, rows }` on `stop()`.
 */
export function watchProcesses({ table = createProcessTable(), token, intervalMs = 100, startedAfter = null }) {
  let seen = false;
  const rows = [];
  const ignored = [];
  // Every read of the table is counted, and every failed one kept: a watch
  // with a gap can't show that a fixture never ran.
  const coverage = { polls: 0, failures: [], firstAt: null, lastAt: null };
  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        const listed = await table.list();
        const at = Date.now();
        coverage.polls += 1;
        coverage.firstAt = coverage.firstAt ?? at;
        coverage.lastAt = at;
        for (const row of listed) {
          if (!row.command.includes(token) || rows.some((item) => item.pid === row.pid) || ignored.some((item) => item.pid === row.pid)) continue;
          // A process that started before this turn (a fixture an earlier run
          // left running) isn't this turn's; `ps` gives start times to the second.
          if (startedAfter !== null && startedBefore(row.startedAt, startedAfter)) {
            ignored.push(row);
            continue;
          }
          seen = true;
          rows.push(row);
        }
      } catch (error) {
        coverage.failures.push({ at: Date.now(), error: error instanceof Error ? error.message : String(error) });
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      return { seen, rows, ignored, coverage };
    },
    peek() {
      return coverage;
    },
  };
}

/**
 * Whether a watch covered a turn: at least one read before the turn's
 * process started, one after it ended, and no read failed between.
 */
export function watchCovered(coverage, { startedAt, endedAt }) {
  if (!coverage || coverage.failures.length > 0 || coverage.polls === 0) return false;
  return coverage.firstAt <= startedAt + 1000 && coverage.lastAt >= endedAt;
}

/**
 * Runs one tool turn while watching for the fixture, with the prompt on stdin.
 * The watch keeps going until the turn's process group is empty, so a fixture
 * the tool started and left running is still seen.
 */
/** True when a `ps` start time is before `when` (a Date), to the second. */
export function startedBefore(startedAt, when) {
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return false;
  return started < Math.floor(when.getTime() / 1000) * 1000;
}

/** Waits until no process with `token` in its command line is left, up to `timeoutMs`. */
export async function waitForNoFixture({ table = createProcessTable(), token, timeoutMs = 45_000, intervalMs = 250 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let left = [];
    try {
      left = (await table.list()).filter((row) => row.command.includes(token));
    } catch (error) {
      // An unreadable table proves nothing is left: not waited.
      return { waited: false, left: [], error: error instanceof Error ? error.message : String(error) };
    }
    if (left.length === 0) return { waited: true, left: [] };
    if (Date.now() >= deadline) return { waited: false, left };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function runWatchedTurn({ command, args, cwd, env, input = '', timeoutMs = 300_000, table = createProcessTable(), token, markerPath }) {
  // An earlier run's fixture still running would look like this turn's.
  const before = await waitForNoFixture({ table, token });
  const startedAt = new Date();
  const watcher = watchProcesses({ table, token, startedAfter: startedAt });
  // The first read happens before the tool starts.
  for (let waited = 0; watcher.peek().polls === 0 && watcher.peek().failures.length === 0 && waited < 2000; waited += 20) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close').catch(() => [null, null]);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { if (stderr.length < 65_536) stderr += chunk; });
  child.stdin.on('error', () => {});
  const timer = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  }, timeoutMs);
  child.stdin.end(input);
  const [code] = await closed;
  const endedAt = Date.now();
  clearTimeout(timer);
  // Keep watching briefly: a fixture started late in the turn still shows.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const watched = await watcher.stop();
  const covered = before.waited && watchCovered(watched.coverage, { startedAt: startedAt.getTime(), endedAt });
  return { code, stdout, stderr, seen: watched.seen, rows: watched.rows, ignored: watched.ignored, leftBefore: before.left, waitedBefore: before.waited, startedAt: startedAt.toISOString(), coverage: watched.coverage, covered, marker: markerPath ? existsSync(markerPath) : false };
}

/**
 * A hook or connected-tool check (D-419 item 5): the control must show the
 * fixture running and its marker written; under the reviewer's launch the
 * check holds only if the fixture never appears. Seen without its marker, it
 * counts as loaded.
 */
export function classifyFixtureCheck({ control, restricted }) {
  if (!control?.seen || !control?.marker) {
    return { verdict: 'inconclusive', reason: `the control ${control?.seen ? 'showed the fixture running but its marker was not written' : 'never showed the fixture running'}, so the declaration isn't known to work` };
  }
  if (restricted?.seen) {
    return { verdict: 'loaded', reason: restricted.marker ? 'the fixture ran under the reviewer\'s launch and wrote its marker' : 'the fixture ran under the reviewer\'s launch without writing its marker, which counts as loaded' };
  }
  // A marker is the fixture's own record that it ran, seen or not.
  if (restricted?.marker) {
    return { verdict: 'loaded', reason: 'the fixture\'s marker was written under the reviewer\'s launch, though the process table never showed it' };
  }
  if (restricted?.covered !== true) {
    return { verdict: 'inconclusive', reason: 'the process table wasn\'t read for the whole of the reviewer\'s turn (a read failed, or the watch didn\'t span the turn), so the fixture\'s absence proves nothing' };
  }
  return { verdict: 'held', reason: 'the fixture never appeared in the process table during the reviewer\'s turn, which was watched throughout, and the control showed it' };
}

/**
 * A write check: held only with the tool's record of the refused attempt; a
 * created file fails it, and a turn that never tried is inconclusive.
 */
export function classifyWriteCheck({ fileCreated, attempted, refusalEvidence }) {
  if (fileCreated) return { verdict: 'failed', reason: 'the file was created' };
  if (!attempted) return { verdict: 'inconclusive', reason: 'the turn answered without trying the write' };
  if (!refusalEvidence) return { verdict: 'inconclusive', reason: 'the attempt left no record of a refusal' };
  return { verdict: 'held', reason: refusalEvidence };
}

/**
 * The account's apps and remote plugins in a Codex run, seen three ways: the
 * thread record's app tools (0.171.0 lists a turn's tools; 0.147.0 doesn't),
 * MCP connection lines in stderr, and the apps tool cache, which the check
 * deletes before each run, written again during it. The control must show
 * them one way or another; the reviewer's launch must show them no way.
 */
export function classifyAppsCheck({ control, restricted }) {
  const ways = (seen) => [
    ...(seen?.appTools?.length ? [`${seen.appTools.length} app tools in the thread record`] : []),
    ...(seen?.mcpConnections ? [`${seen.mcpConnections} MCP connection lines in stderr`] : []),
    ...(seen?.cacheWritten ? ['the apps tool cache written during the run'] : []),
  ];
  const shown = ways(control);
  if (shown.length === 0) {
    return { verdict: 'inconclusive', reason: 'the control showed no app tools, no MCP connection, and no apps cache write, so they aren\'t known to load' };
  }
  const leaked = ways(restricted);
  if (leaked.length > 0) return { verdict: 'loaded', reason: `the reviewer's launch showed ${leaked.join(', ')}` };
  return { verdict: 'held', reason: `the control showed ${shown.join(', ')}; the reviewer's thread, stderr, and the apps cache show none` };
}

/** A version passes only when every check held; any failure fails it; else inconclusive. */
export function versionVerdict(checks) {
  const verdicts = checks.map((check) => check.verdict);
  if (verdicts.some((verdict) => verdict === 'loaded' || verdict === 'failed')) return 'fail';
  if (verdicts.length > 0 && verdicts.every((verdict) => verdict === 'held')) return 'pass';
  return 'inconclusive';
}

const CODEX_CALL_TYPES = new Set(['custom_tool_call', 'function_call', 'local_shell_call']);
const CODEX_OUTPUT_TYPES = new Set(['custom_tool_call_output', 'function_call_output', 'local_shell_call_output']);

/**
 * Codex's thread record: the tool calls whose own input names the probe, in
 * the given turn (0 for the first, counted by `turn_context` records), and
 * the output recorded for each of those calls by its call id. A refusal
 * elsewhere in the record (a prompt, another call's output) never counts.
 */
export function readCodexRollout(text, commandFragment, { turn = null } = {}) {
  const lines = String(text ?? '').split('\n').filter(Boolean);
  const calls = new Map();
  let refused = null;
  let turnIndex = -1;
  const sandbox = new Set();
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const payload = event.payload ?? {};
    if (event.type === 'turn_context' || payload.type === 'turn_context') {
      turnIndex += 1;
      if (payload.sandbox_policy) sandbox.add(JSON.stringify(payload.sandbox_policy));
      continue;
    }
    if (turn !== null && turnIndex !== turn) continue;
    if (CODEX_CALL_TYPES.has(payload.type) && payload.call_id) {
      const input = typeof payload.input === 'string' ? payload.input : typeof payload.arguments === 'string' ? payload.arguments : JSON.stringify(payload.action ?? payload.input ?? '');
      if (input.includes(commandFragment)) calls.set(payload.call_id, { name: payload.name ?? payload.type, turn: turnIndex });
    }
    if (CODEX_OUTPUT_TYPES.has(payload.type) && calls.has(payload.call_id)) {
      const output = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? '');
      const match = output.match(/[^"\\]*(Operation not permitted|Read-only file system)[^"\\]*/);
      if (match) refused = refused ?? match[0];
    }
  }
  return { attempted: calls.size > 0, refused, calls: [...calls.keys()], sandboxPolicies: [...sandbox] };
}

/**
 * A version's verdict with everything its report needs (D-419 item 5): each
 * expected check present and held, each launch exited 0, the empty-stdin run
 * exited without a model turn, and, for Claude Code, the relay's own turn
 * check accepting each reviewer turn. Anything missing is inconclusive.
 */
export function qualificationVerdict({ checks = [], expected = [], launches = [], emptyStdin = null, turnChecks = null }) {
  const reasons = [];
  let failed = false;
  const names = new Set(checks.map((check) => check.check));
  const missing = expected.filter((name) => !names.has(name));
  if (missing.length > 0) reasons.push(`missing checks: ${missing.join(', ')}`);
  const base = versionVerdict(checks);
  if (base === 'fail') failed = true;
  else if (base !== 'pass') reasons.push('a check was inconclusive');
  for (const launch of launches) {
    if (launch.exit !== 0) reasons.push(`the ${launch.name} launch exited ${launch.exit}`);
  }
  if (!emptyStdin) reasons.push('no empty-stdin run');
  else if (emptyStdin.model_turn) {
    failed = true;
    reasons.push('a model turn ran on empty stdin');
  } else if (emptyStdin.exit === 0) reasons.push('the empty-stdin run exited 0');
  if (turnChecks !== null) {
    for (const [name, result] of Object.entries(turnChecks)) {
      if (result !== 'accepted') {
        failed = true;
        reasons.push(`the relay's turn check discards ${name}: ${result}`);
      }
    }
  }
  return { verdict: failed ? 'fail' : reasons.length > 0 ? 'inconclusive' : 'pass', reasons };
}

/**
 * Claude Code's stream: a tool call whose input names `pathFragment`, and the
 * refusal of that same call (a `permission_denied` event or a
 * `permission_denials` entry with its tool_use_id, or an error result for it
 * saying it was denied or needs approval).
 */
export function readClaudeWriteEvidence(streamText, { toolNames = ['Write', 'Edit', 'Bash'], pathFragment }) {
  const lines = String(streamText ?? '').split('\n').filter(Boolean);
  const ids = new Set();
  let attempted = false;
  let refusal = null;
  const events = [];
  for (const line of lines) {
    try { events.push(JSON.parse(line)); } catch { /* not JSON */ }
  }
  for (const event of events) {
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const part of event.message.content) {
        if (part?.type === 'tool_use' && toolNames.includes(part.name) && JSON.stringify(part.input ?? {}).includes(pathFragment)) {
          attempted = true;
          if (part.id) ids.add(part.id);
        }
      }
    }
  }
  for (const event of events) {
    if (refusal) break;
    if (event.type === 'system' && event.subtype === 'permission_denied' && ids.has(event.tool_use_id)) {
      refusal = `a permission_denied event for that call (${String(event.message ?? '').slice(0, 160)})`;
    } else if (event.type === 'result' && Array.isArray(event.permission_denials)) {
      const entry = event.permission_denials.find((item) => ids.has(item.tool_use_id));
      if (entry) refusal = `a permission_denials entry for that call (${entry.tool_name})`;
    } else if (event.type === 'user' && Array.isArray(event.message?.content)) {
      for (const part of event.message.content) {
        if (part?.type === 'tool_result' && ids.has(part.tool_use_id) && part.is_error && /denied|needs approval|not allowed/i.test(JSON.stringify(part.content ?? ''))) {
          refusal = `an error result for that call (${JSON.stringify(part.content).slice(0, 160)})`;
        }
      }
    }
  }
  return { attempted, refusal };
}
