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

// `versionExit` fails every probe; `versionExitFrom: n` fails the nth and later.
function versionExitCode() {
  if (spec.versionExit) return spec.versionExit;
  if (!spec.versionExitFrom) return 0;
  const counterPath = path.join(dir, `${tool}-version-counter`);
  const count = (existsSync(counterPath) ? Number(readFileSync(counterPath, 'utf8')) : 0) + 1;
  writeFileSync(counterPath, String(count));
  return count >= spec.versionExitFrom ? 1 : 0;
}

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

// A child in the tool's own process group that ignores SIGTERM and outlives
// its leader; only SIGKILL ends it.
function spawnLingering(pidFile) {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: 'ignore' });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
}

// A helper that leaves the tool's process group (a new session) and keeps the
// tool's stdout and stderr open after the tool and its group are gone.
function spawnPipeHolder(pidFile) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// The re-mark command a builder turn's fixed text names, split as a POSIX
// shell would split it (plain words and single-quoted words).
function remarkFromPrompt(prompt) {
  const match = /`(vibecompass ready-for-review [^`]+)`/.exec(prompt ?? '');
  if (!match) return null;
  const words = [];
  let word = null;
  for (let index = 0; index < match[1].length; index += 1) {
    const char = match[1][index];
    if (char === "'") {
      const end = match[1].indexOf("'", index + 1);
      word = (word ?? '') + match[1].slice(index + 1, end);
      index = end;
    } else if (char === '\\') {
      word = (word ?? '') + match[1][index + 1];
      index += 1;
    } else if (char === ' ') {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? '') + char;
    }
  }
  if (word !== null) words.push(word);
  return words.slice(1);
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
    } else if (action.type === 'replace-in-file') {
      writeFileSync(action.path, readFileSync(action.path, 'utf8').replace(action.from, action.to));
    } else if (action.type === 'write-file') {
      writeFileSync(action.path, action.content);
    } else if (action.type === 'mark-ready') {
      // In a builder turn the command is the one the relay's text gives, run
      // as written from the turn's folder.
      const fromPrompt = remarkFromPrompt(context.prompt);
      const cliArgs = fromPrompt ?? ['ready-for-review', '--root', scenario.rootDir, '--session', scenario.laneId, ...(action.paths ?? []).flatMap((item) => ['--path', item])];
      // `conversationId` stands for a mark made elsewhere: null from a plain
      // shell, or another conversation's id.
      const conversation = action.conversationId !== undefined ? action.conversationId ?? '' : context.conversationId ?? '';
      const result = spawnSync(process.execPath, [scenario.cliPath, ...cliArgs], {
        env: { ...process.env, CLAUDE_CODE_SESSION_ID: conversation },
        encoding: 'utf8',
        cwd: process.cwd(),
      });
      record({ action: 'mark-ready', argv: cliArgs, status: result.status, stderr: result.stderr.slice(0, 500) });
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
  // `ignoreSigterm`: a tool that keeps running through SIGTERM, as one still
  // starting might, until SIGKILL.
  if (spec.ignoreSigterm && args[0] !== '--version') process.on('SIGTERM', () => {});
  if (args[0] === '--version') {
    process.stdout.write(`codex-cli ${spec.version ?? '0.0.0'}\n`);
    return versionExitCode();
  }
  const resumeAt = args.indexOf('resume');
  const threadIn = args[0] === 'exec' && resumeAt === 1 ? args[2] : null;
  const turn = nextTurn('review');
  if (turn.startedMarker) writeFileSync(turn.startedMarker, String(process.pid));
  const prompt = await readStdin();
  // Written once stdin has closed: with the prompt in it, the model turn has begun.
  if (turn.promptMarker) writeFileSync(turn.promptMarker, prompt);
  record({ kind: 'review', args, cwd: process.cwd(), prompt, relayTurn: Boolean(process.env.VIBECOMPASS_RELAY_TURN) });
  if (turn.lingeringPidFile) spawnLingering(turn.lingeringPidFile);
  if (turn.pipeHolderPidFile) spawnPipeHolder(turn.pipeHolderPidFile);
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
    return versionExitCode();
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
  await runActions(turn.actions, { conversationId, prompt });
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
