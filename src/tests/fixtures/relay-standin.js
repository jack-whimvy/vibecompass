#!/usr/bin/env node
// A scripted stand-in for `codex` and `claude` in the review relay's tests.
// `node relay-standin.js <codex|claude> ...args`. The scenario lives in
// $RELAY_STANDIN_DIR/scenario.json: per tool a version and a queue of turns.
// Every call is appended to calls.jsonl there. Test-only: the package never
// reads RELAY_STANDIN_DIR.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [tool, ...args] = process.argv.slice(2);
const BUILT_IN_PLUGINS = ['cc-plugin-agents-md', 'cc-plugin-telemetry', 'cc-plugin-privacy', 'cc-plugin-plugin-authoring'].map((name) => ({ name, path: 'builtin', source: `${name}@builtin` }));
const dir = process.env.RELAY_STANDIN_DIR;
const scenario = JSON.parse(readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
const spec = scenario[tool] ?? {};

function record(entry) {
  appendFileSync(path.join(dir, 'calls.jsonl'), `${JSON.stringify({ tool, pid: process.pid, ...entry })}\n`);
}

function nextTurn(kind) {
  const counterPath = path.join(dir, `${tool}-${kind}-counter`);
  const index = existsSync(counterPath) ? Number(readFileSync(counterPath, 'utf8')) : 0;
  writeFileSync(counterPath, String(index + 1));
  const queue = spec[`${kind}Turns`] ?? spec.turns ?? [];
  return queue[index] ?? queue.at(-1) ?? {};
}

function flagValue(name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : null;
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(file, timeoutMs = 60_000) {
  const start = Date.now();
  while (!existsSync(file)) {
    if (Date.now() - start > timeoutMs) return false;
    await sleep(50);
  }
  return true;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function runActions(actions = [], context) {
  for (const action of actions) {
    if (action.type === 'append-review-log') {
      const wipPath = path.join(scenario.laneDir, 'wip.md');
      const wip = readFileSync(wipPath, 'utf8').replace(/\n*$/, '\n');
      writeFileSync(wipPath, `${wip}${action.lines.join('\n')}\n`);
    } else if (action.type === 'set-builder-handoff') {
      const handoffPath = path.join(scenario.laneDir, 'handoff.md');
      const handoff = readFileSync(handoffPath, 'utf8');
      const start = handoff.indexOf('## Builder → Reviewer');
      const end = handoff.indexOf('## Reviewer → Builder');
      writeFileSync(handoffPath, `${handoff.slice(0, start)}## Builder → Reviewer\n\n${action.text}\n\n${handoff.slice(end)}`);
    } else if (action.type === 'edit-reviewer-section') {
      const handoffPath = path.join(scenario.laneDir, 'handoff.md');
      writeFileSync(handoffPath, `${readFileSync(handoffPath, 'utf8').replace(/\n*$/, '\n')}- the builder wrote here\n`);
    } else if (action.type === 'write-file') {
      writeFileSync(action.path, action.content);
    } else if (action.type === 'mark-ready') {
      const result = spawnSync(process.execPath, [scenario.cliPath, 'ready-for-review', '--root', scenario.rootDir, '--session', scenario.laneId, ...(action.paths ?? []).flatMap((item) => ['--path', item])], {
        env: { ...process.env, CLAUDE_CODE_SESSION_ID: context.conversationId },
        encoding: 'utf8',
      });
      record({ action: 'mark-ready', status: result.status, stderr: result.stderr.slice(0, 500) });
    } else if (action.type === 'run') {
      const result = spawnSync(action.command === 'node' ? process.execPath : action.command, action.args, { env: process.env, encoding: 'utf8', cwd: action.cwd });
      record({ action: 'run', argv: action.args, status: result.status, stdout: result.stdout.slice(0, 2000), stderr: result.stderr.slice(0, 2000) });
    } else if (action.type === 'sleep') {
      await sleep(action.ms);
    } else if (action.type === 'touch') {
      writeFileSync(action.path, 'x');
    }
  }
}

async function codex() {
  if (args[0] === '--version') {
    process.stdout.write(`codex-cli ${spec.version ?? '0.0.0'}\n`);
    return 0;
  }
  const resumeAt = args.indexOf('resume');
  const threadIn = args[0] === 'exec' && resumeAt === 1 ? args[2] : null;
  const turn = nextTurn('review');
  if (turn.startedMarker) writeFileSync(turn.startedMarker, String(process.pid));
  const prompt = await readStdin();
  record({ kind: 'review', args, cwd: process.cwd(), prompt, relayTurn: Boolean(process.env.VIBECOMPASS_RELAY_TURN) });
  if (turn.waitFor) await waitFor(turn.waitFor);
  if (turn.sleepMs) await sleep(turn.sleepMs);
  await runActions(turn.actions, {});
  const threadId = threadIn ?? turn.threadId ?? randomUUID();
  emit({ type: 'thread.started', thread_id: threadId });
  const outputPath = flagValue('-o');
  if (turn.childWritesAnswerAfterMs) {
    // The first process exits while a child it started keeps working.
    const child = spawn(process.execPath, ['-e', `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(outputPath)}, ${JSON.stringify(JSON.stringify(turn.answer))}), ${turn.childWritesAnswerAfterMs})`], { stdio: 'ignore' });
    child.unref();
    emit({ type: 'turn.completed' });
    return 0;
  }
  if (turn.failed) {
    emit({ type: 'turn.failed', error: { message: turn.failed } });
    return turn.exitCode ?? 1;
  }
  if (outputPath && turn.answer !== undefined) {
    writeFileSync(outputPath, typeof turn.answer === 'string' ? turn.answer : JSON.stringify(turn.answer));
  }
  emit({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } });
  emit({ type: 'turn.completed' });
  return turn.exitCode ?? 0;
}

async function claude() {
  if (args[0] === '--version') {
    process.stdout.write(`${spec.version ?? '0.0.0'} (Claude Code)\n`);
    return 0;
  }
  const reviewer = args.includes('--json-schema');
  const kind = reviewer ? 'review' : 'builder';
  const turn = nextTurn(kind);
  if (turn.startedMarker) writeFileSync(turn.startedMarker, String(process.pid));
  const prompt = await readStdin();
  const resume = flagValue('--resume');
  const mode = flagValue('--permission-mode');
  record({ kind, args, cwd: process.cwd(), prompt, relayTurn: Boolean(process.env.VIBECOMPASS_RELAY_TURN), env: {
    GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT ?? null,
    GH_CONFIG_DIR: process.env.GH_CONFIG_DIR ?? null,
    GH_TOKEN: process.env.GH_TOKEN ?? null,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? null,
  } });
  const conversationId = turn.initSessionId ?? resume ?? turn.newSessionId ?? randomUUID();
  for (let index = 0; index < (turn.hooksBefore ?? 0); index += 1) {
    emit({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' });
  }
  if (turn.earlyEvent) emit({ type: turn.earlyEvent, message: { content: [] } });
  if (turn.noInit) {
    // A stream that ends without init: only the hook events above.
    return turn.exitCode ?? 0;
  }
  if (turn.waitFor) await waitFor(turn.waitFor);
  if (!turn.noInit) {
    emit({
      type: 'system',
      subtype: 'init',
      session_id: conversationId,
      cwd: process.cwd(),
      permissionMode: turn.initMode ?? mode,
      model: turn.model ?? 'claude-opus-5-5',
      // A reviewer's init as Claude Code 2.1.318 lists it under the relay's
      // launch: the reading set, the answer's tool, and the built-in plugins.
      tools: turn.tools ?? (reviewer ? ['Bash', 'Glob', 'Grep', 'Read', 'StructuredOutput'] : ['Bash', 'Edit', 'Read']),
      mcp_servers: turn.mcpServers ?? [],
      plugins: turn.plugins ?? (reviewer ? BUILT_IN_PLUGINS : []),
    });
  }
  if (turn.hookAfterInit) emit({ type: 'system', subtype: 'hook_response', hook_name: 'PreToolUse' });
  if (turn.sleepMs) await sleep(turn.sleepMs);
  await runActions(turn.actions, { conversationId });
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: turn.lastText ?? 'Done.' }] } });
  emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'seven_day' } });
  emit({
    type: 'result',
    subtype: turn.resultSubtype ?? 'success',
    is_error: Boolean(turn.isError),
    session_id: conversationId,
    result: turn.lastText ?? 'Done.',
    permission_denials: turn.permissionDenials ?? [],
    ...(reviewer && turn.answer !== undefined ? { structured_output: turn.answer } : {}),
  });
  return turn.exitCode ?? 0;
}

const code = await (tool === 'codex' ? codex() : claude());
process.exitCode = code;
