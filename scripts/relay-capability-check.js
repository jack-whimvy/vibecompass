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
export function watchProcesses({ table = createProcessTable(), token, intervalMs = 100 }) {
  let seen = false;
  const rows = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        for (const row of await table.list()) {
          if (row.command.includes(token) && !rows.some((item) => item.pid === row.pid)) {
            seen = true;
            rows.push(row);
          }
        }
      } catch {
        // An unreadable table this round; the next one is read again.
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      return { seen, rows };
    },
  };
}

/**
 * Runs one tool turn while watching for the fixture, with the prompt on stdin.
 * The watch keeps going until the turn's process group is empty, so a fixture
 * the tool started and left running is still seen.
 */
export async function runWatchedTurn({ command, args, cwd, env, input = '', timeoutMs = 300_000, table = createProcessTable(), token, markerPath }) {
  const watcher = watchProcesses({ table, token });
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
  clearTimeout(timer);
  // Keep watching briefly: a fixture started late in the turn still shows.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const watched = await watcher.stop();
  return { code, stdout, stderr, seen: watched.seen, rows: watched.rows, marker: markerPath ? existsSync(markerPath) : false };
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
  return { verdict: 'held', reason: 'the fixture never appeared in the process table during the reviewer\'s turn, and the control showed it' };
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

/** A version passes only when every check held; any failure fails it; else inconclusive. */
export function versionVerdict(checks) {
  const verdicts = checks.map((check) => check.verdict);
  if (verdicts.some((verdict) => verdict === 'loaded' || verdict === 'failed')) return 'fail';
  if (verdicts.length > 0 && verdicts.every((verdict) => verdict === 'held')) return 'pass';
  return 'inconclusive';
}

/** Codex's thread record: did a command run, and what did it print? */
export function readCodexRollout(text, commandFragment) {
  const lines = String(text ?? '').split('\n').filter(Boolean);
  let attempted = false;
  let refused = null;
  const sandbox = new Set();
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const payload = event.payload ?? event;
    const serialized = JSON.stringify(payload);
    if (payload?.type === 'turn_context' && payload.sandbox_policy) sandbox.add(JSON.stringify(payload.sandbox_policy));
    if (serialized.includes(commandFragment)) attempted = true;
    if (attempted && /Operation not permitted|Read-only file system/.test(serialized)) {
      refused = refused ?? (serialized.match(/[^"]*(Operation not permitted|Read-only file system)[^"]*/)?.[0] ?? 'Operation not permitted');
    }
  }
  return { attempted, refused, sandboxPolicies: [...sandbox] };
}

/** Claude Code's stream: a write tool attempt and its refusal. */
export function readClaudeWriteEvidence(streamText, { toolNames = ['Write', 'Edit', 'Bash'], pathFragment }) {
  const lines = String(streamText ?? '').split('\n').filter(Boolean);
  let attempted = false;
  let refusal = null;
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const serialized = JSON.stringify(event);
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const part of event.message.content) {
        if (part?.type === 'tool_use' && toolNames.includes(part.name) && JSON.stringify(part.input ?? {}).includes(pathFragment)) attempted = true;
      }
    }
    if (event.type === 'result' && Array.isArray(event.permission_denials) && event.permission_denials.length > 0) {
      refusal = `permission_denials: ${event.permission_denials.map((item) => item.tool_name).join(', ')}`;
    }
    if (!refusal && /permission_denied/.test(serialized)) refusal = 'a permission_denied event';
  }
  return { attempted, refusal };
}
