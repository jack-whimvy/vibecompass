import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  REVIEWER_TOOLS,
  SUPPORTED_REVIEWER_VERSIONS,
  TOOL_NAMES,
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
  readClaudeStream,
  readCodexEvents,
  readToolVersion,
  reviewerPrompt,
  reviewerTurnEnv,
  validateBuilderMode,
} from './relay-adapters.js';
import {
  RELAY_TURN_DIR,
  compareMark,
  findingsWaitingForBuilder,
  gitText,
  readReadyMark,
  resolveMarkPath,
  shortRound,
} from './relay-mark.js';
import {
  REVIEWER_ANSWER_SCHEMA,
  describeWriteEnd,
  formatRecordTime,
  makeRecheck,
  prepareRelayWrite,
  settleRelayWrite,
  validateReviewerAnswer,
} from './relay-record.js';
import { REVIEWER_TO_BUILDER_HEADING, readSectionBody } from './relay-sections.js';
import { isReviewClean, passOnRound } from './relay-stage.js';
import {
  acquireConversationLock,
  acquireLaneLock,
  createProcessTable,
  emptyRelayState,
  inspectProcessGroup,
  processStartTime,
  readRelayState,
  releaseConversationLock,
  releaseLaneLock,
  saveRelayState,
  turnUnfinished,
  writeUnfinished,
} from './relay-state.js';
import { extractReviewLogLines, parseReviewLog, resolveReviewSettings } from './review-log.js';
import { inferToolingRootForMemoryRoot, resolveActiveLaneContext } from './session.js';
import { parseSimpleYaml } from './simple-yaml.js';

// D-419: `vibecompass review-relay --session <lane-id>`, the owner's command.
// It starts a read-only reviewer, checks its answer, and writes it as the
// lane's pass; with the builder's Claude Code conversation closed it then sends
// the builder a fixed address-review turn and repeats until a clean pass or the
// cap, and otherwise runs one pass and stops. It never closes, pushes, merges,
// publishes, releases, starts a builder conversation, or retries.

export const DEFAULT_REVIEWER_TIMEOUT_MINUTES = 45;
export const DEFAULT_BUILDER_TIMEOUT_MINUTES = 60;
const GROUP_POLL_MS = 250;
const KILL_GRACE_MS = 5000;

/** The commands a relayed builder turn may not run (D-419 item 8). */
export const RELAY_TURN_REFUSED_COMMANDS = new Set([
  'close-session',
  'end-session',
  'review-relay',
  'push',
  'promote-hosted',
  'demote-hosted',
  'connect-hosted',
  'sync-adopt',
]);

/**
 * The package's own refusal inside a relayed turn, at the command entry point:
 * while VIBECOMPASS_RELAY_TURN is set, close, the relay, and the hosted
 * commands refuse however they were spelled.
 */
export function refuseInsideRelayTurn(command, env = process.env) {
  const token = env?.VIBECOMPASS_RELAY_TURN;
  if (!token || !RELAY_TURN_REFUSED_COMMANDS.has(command)) return;
  throw new Error(`${command} is refused inside a relayed builder turn (VIBECOMPASS_RELAY_TURN is set). The review relay never closes, pushes, or uploads project memory, and its builder turns don't either; the owner runs ${command} after the relay stops.`); // D-419 item 8
}

class RelayStop extends Error {
  constructor(kind, reason, details = {}) {
    super(reason);
    this.name = 'RelayStop';
    this.kind = kind;
    this.reason = reason;
    this.details = details;
  }
}

// Stops that are an ordinary end of a run exit 0; the rest exit 1.
const ORDINARY_STOPS = new Set(['clean', 'one-pass', 'cap', 'ceiling', 'builder-question', 'owner-pause', 'recovered', 'nothing-open']);

function parseMinutes(value, flag, fallback) {
  if (value === undefined || value === null) return fallback;
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`${flag} must be a positive number of minutes; got "${value}".`);
  }
  return minutes;
}

function newId(bytes = 6) {
  return randomBytes(bytes).toString('hex');
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readRoundCap(rootDir) {
  try {
    const config = parseSimpleYaml(await readFile(path.join(rootDir, 'project.yaml'), 'utf8'));
    return resolveReviewSettings(config?.metadata?.workflow?.review).roundCap;
  } catch {
    return resolveReviewSettings(undefined).roundCap;
  }
}

function parseLog(wipContent) {
  return parseReviewLog(extractReviewLogLines(wipContent).lines);
}

function describeFinding(finding) {
  if (finding.resolved) return finding.resolution === 'deferral' ? 'resolved as a deferral' : `resolved (${finding.resolution})`;
  if (finding.deferredByOwner) return 'deferred by the owner';
  return `${finding.latestStatus}, waiting for the ${finding.waitingFor}`;
}

function openFindingLines(parsed) {
  if (!parsed?.ok) return ['- (the review log is malformed)'];
  const open = parsed.findings.filter((finding) => !finding.resolved);
  if (open.length === 0) return ['- none'];
  return open.map((finding) => `- ${finding.id} (${finding.severity}) ${describeFinding(finding)}: ${finding.finding}`);
}

/**
 * Runs one turn in its own process group (D-419 item 10): the tool starts
 * with stdin open and the prompt unsent; `onSpawned` records its identity;
 * then the prompt is sent and stdin closed. The turn runs until every process
 * in the group has exited. `onLine` may return a reason to end the group.
 */
async function runTurn({ command, args, cwd, env, input, timeoutMs, table, onSpawned, onLine = () => null, logPath, active }) {
  let child;
  try {
    child = spawn(command, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    return { spawnError: error instanceof Error ? error.message : String(error) };
  }
  // Every listener is attached before the first await, so no event is missed.
  const closed = once(child, 'close').catch(() => [null, null]);
  const spawned = Promise.race([
    once(child, 'spawn').then(() => null),
    once(child, 'error').then(([error]) => error),
  ]);
  let aborted = null;
  let timedOut = false;
  let pgid = null;
  const endGroup = () => {
    if (pgid === null) return;
    table.killGroup(pgid, 'SIGTERM');
    setTimeout(() => table.killGroup(pgid, 'SIGKILL'), KILL_GRACE_MS).unref();
  };
  const stdoutLines = [];
  const stderrChunks = [];
  const reader = createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    stdoutLines.push(line);
    if (logPath) appendFile(logPath, `${line}\n`).catch(() => {});
    if (!aborted) {
      const reason = onLine(line);
      if (reason) {
        aborted = reason;
        endGroup();
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    if (stderrChunks.join('').length < 16_384) stderrChunks.push(chunk);
  });
  child.stdin.on('error', () => {});

  const spawnError = await spawned;
  if (spawnError) {
    return { spawnError: spawnError.code === 'ENOENT' ? `${command} wasn't found on PATH` : spawnError.message };
  }
  const pid = child.pid;
  pgid = pid;
  // Ctrl-C from here on ends this group.
  active.group = { pgid, kill: (signal) => table.killGroup(pgid, signal) };
  const timer = setTimeout(() => {
    timedOut = true;
    endGroup();
  }, timeoutMs);
  timer.unref();
  // The tool waits with stdin open and the prompt unsent while its identity is recorded.
  const startedAt = await processStartTime(table, pid).catch(() => null);
  await onSpawned({ pid, pgid, startedAt });
  if (active.interrupted) {
    // Stopped before the prompt went out: close stdin empty and end the group.
    child.stdin.end();
    endGroup();
  } else {
    child.stdin.end(input);
  }

  const [code, signal] = await closed;
  // A tool's own child can outlive it: the turn runs until its group is empty.
  while (!timedOut) {
    const group = await inspectProcessGroup(table, { pgid, pid, startedAt });
    if (group.state === 'ended') break;
    await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_MS));
  }
  clearTimeout(timer);
  active.group = null;
  return { code, signal, stdout: stdoutLines.join('\n'), stderr: stderrChunks.join('').trim(), timedOut, aborted, interrupted: active.interrupted, pid, pgid, startedAt };
}

async function remoteRefs(dirs) {
  const snapshot = {};
  for (const dir of dirs) {
    const refs = await gitText(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes'], dir);
    snapshot[dir] = refs.ok ? refs.stdout.trim() : null;
  }
  return snapshot;
}

async function isGitRepository(dir) {
  return (await gitText(['rev-parse', '--git-dir'], dir)).ok;
}

/**
 * The relay. `deps` carries the seams: `io`, `env`, `platform`, the process
 * `table`, the reviewer version list (`supportedReviewerVersions`), `confirm`
 * for the owner's answers on a terminal, `userInfo` for the conversation lock,
 * and `signals` for Ctrl-C.
 */
export async function runReviewRelay(options = {}, deps = {}) {
  const io = deps.io ?? { stdout: process.stdout, stderr: process.stderr };
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const table = deps.table ?? createProcessTable();
  const supported = deps.supportedReviewerVersions ?? SUPPORTED_REVIEWER_VERSIONS;
  const out = (line = '') => io.stdout.write(`${line}\n`);

  if (platform === 'win32') {
    throw new Error('review-relay isn\'t supported on Windows. Review by hand: start a reviewer with `review handoff <lane-id>`.'); // D-419 item 12
  }
  if (platform !== 'darwin') {
    throw new Error(`review-relay doesn't run on ${platform === 'linux' ? 'Linux' : platform} yet: it runs there once an acceptance run on that platform is recorded. Review by hand meanwhile: start a reviewer with \`review handoff <lane-id>\`.`); // D-419 item 12
  }

  const reviewerTool = options.reviewer ?? 'codex';
  if (!REVIEWER_TOOLS.includes(reviewerTool)) {
    throw new Error(`--reviewer must be codex or claude; got "${reviewerTool}".`);
  }
  const builderMode = validateBuilderMode(options.builderMode);
  const reviewerTimeoutMs = parseMinutes(options.reviewerTimeout, '--reviewer-timeout', DEFAULT_REVIEWER_TIMEOUT_MINUTES) * 60_000;
  const builderTimeoutMs = parseMinutes(options.builderTimeout, '--builder-timeout', DEFAULT_BUILDER_TIMEOUT_MINUTES) * 60_000;
  if (!options.recover && reviewerTool === 'codex' && !options.reviewerModel) {
    throw new Error('The Codex reviewer needs --reviewer-model <model>: Codex reports no model, and the relay ignores the model your Codex settings name.'); // D-419 item 5
  }
  if (options.pastCap && options.recover) {
    throw new Error('--recover starts no agent, so it takes no --past-cap.');
  }

  const context = await resolveActiveLaneContext({ rootDir: options.rootDir, sessionId: options.sessionId, cwd: options.cwd }, { purpose: 'relay a review for', requireExplicit: true });
  if ((context.metadata.role ?? 'builder') !== 'builder') {
    throw new Error(`Lane ${context.sessionId} is a ${context.metadata.role} lane; the review relay runs on builder lanes.`);
  }
  for (const warning of context.warnings) io.stderr.write(`Warning: ${warning}\n`);
  const { rootDir, laneDir, sessionId: laneId } = context;
  const relayCwd = path.resolve(options.cwd ?? process.cwd());
  const toolingRoot = await inferToolingRootForMemoryRoot(rootDir);
  const worktrees = context.metadata.worktrees ?? {};
  const projectRepos = context.projectRepos;
  const runId = newId();
  const token = newId(16);
  const turnDir = path.join(laneDir, RELAY_TURN_DIR);
  const active = { group: null, interrupted: false };

  const laneLock = await acquireLaneLock({ laneDir, laneId, runId, token, table, rootDir });
  if (laneLock.tookOver) {
    out(`Took over lane ${laneId}'s relay lock from run ${laneLock.tookOver.run_id}, whose process is gone.`);
  }
  let conversationLock = null;
  let state = null;
  const onSigint = () => {
    active.interrupted = true;
    if (active.group) {
      active.group.kill('SIGTERM');
      setTimeout(() => active.group?.kill('SIGKILL'), KILL_GRACE_MS).unref();
    }
  };
  const signals = deps.signals ?? process;
  signals.on('SIGINT', onSigint);

  const save = async (patch) => {
    state = await saveRelayState(laneDir, { ...state, ...patch });
    return state;
  };

  try {
    try {
      state = (await readRelayState(laneDir)) ?? emptyRelayState(laneId);
    } catch (error) {
      throw new RelayStop('failure', `${error.message} The relay doesn't run over a state it can't read; move the file aside only if no relayed write is unfinished.`);
    }

    // Recovery first: settle a recorded write, inspect an interrupted turn.
    const recovered = await recoverLane({ state, save, table, rootDir, laneDir, laneId, worktrees, projectRepos, env, out });
    state = recovered.state;
    if (recovered.reserved) {
      throw new RelayStop('interrupted', recovered.stopReason);
    }
    if (options.recover) {
      throw new RelayStop('recovered', recovered.summary || 'nothing to recover');
    }
    if (recovered.stopReason) {
      throw new RelayStop('interrupted', recovered.stopReason);
    }

    const mark = await readReadyMark(laneDir).catch((error) => {
      throw new RelayStop('failure', error.message);
    });
    if (!mark) {
      throw new RelayStop('no-mark', `lane ${laneId} has no ready-for-review mark. The builder runs \`vibecompass ready-for-review --session ${laneId}\` when the round is ready.`);
    }
    const conversationId = mark.builder?.tool === 'claude-code' ? mark.builder.conversation_id : null;
    const mode = conversationId && !options.onePass ? 'loop' : 'one-pass';

    const reviewerVersion = await readToolVersion(reviewerTool, { env });
    if (reviewerVersion.missing) {
      throw new RelayStop('unsupported', `${reviewerTool} wasn't found on PATH. The relay installs nothing; install ${TOOL_NAMES[reviewerTool]}, choose the other reviewer, or review by hand.`);
    }
    const reviewerGate = checkReviewerVersion({ tool: reviewerTool, version: reviewerVersion.version, platform, supported, otherTool: REVIEWER_TOOLS.find((tool) => tool !== reviewerTool) });
    if (!reviewerGate.ok) {
      throw new RelayStop('unsupported', reviewerGate.message);
    }
    let builderVersion = null;
    if (mode === 'loop') {
      builderVersion = await readToolVersion('claude', { env });
      if (builderVersion.missing) {
        throw new RelayStop('unsupported', 'claude wasn\'t found on PATH, so the relay can\'t resume the builder\'s conversation. Run one pass with --one-pass instead.');
      }
      const builderGate = checkBuilderVersion({ version: builderVersion.version });
      if (!builderGate.ok) throw new RelayStop('unsupported', builderGate.message);
      if (builderGate.message) out(builderGate.message);
    }

    const cap = await readRoundCap(rootDir);
    const parsedAtGo = parseLog(await readFile(path.join(laneDir, 'wip.md'), 'utf8'));
    if (!parsedAtGo.ok) {
      throw new RelayStop('failure', `the review log is malformed at wip.md line ${parsedAtGo.malformed.lineNumber} (${parsedAtGo.malformed.reason}); the relay writes nothing until it parses.`);
    }

    // A restarted relay keeps the go it recorded; a run after a stop is a new go.
    const restart = state.run && !state.run.stopped && state.run.go;
    let go;
    if (restart) {
      go = state.run.go;
      out(`Restarting run ${state.run.id}'s go: ${go.kind === 'past-cap' ? 'one pass past the cap' : `up to ${go.ceiling} passes`}.`);
    } else if (options.pastCap) {
      if (parsedAtGo.passCount < cap) {
        throw new RelayStop('refused', `--past-cap is refused: lane ${laneId} has run ${parsedAtGo.passCount} of ${cap} passes, below the cap. Run without --past-cap.`); // D-419 item 2
      }
      go = { at: new Date().toISOString(), mode, kind: 'past-cap', ceiling: parsedAtGo.passCount + 1, pass_count_at_go: parsedAtGo.passCount };
    } else {
      go = { at: new Date().toISOString(), mode, kind: 'normal', ceiling: cap, pass_count_at_go: parsedAtGo.passCount };
    }

    if (mode === 'loop') {
      conversationLock = await acquireConversationLock({ conversationId, rootDir, laneId, runId, token, table, userInfo: deps.userInfo });
      if (conversationLock.tookOver) {
        out(`Took over conversation ${conversationId}'s lock: ${conversationLock.tookOver.reason}.`);
      }
      if (!options.conversationClosed) {
        const question = `The relay resumes Claude Code conversation ${conversationId} from ${relayCwd}. Is that conversation closed in every terminal, and was it started in this folder? [y/N]`;
        if (typeof deps.confirm !== 'function') {
          throw new RelayStop('refused', `before the first builder turn the owner confirms that conversation ${conversationId} is closed and was started in ${relayCwd}. Run in a terminal, or pass --conversation-closed to confirm both. Use --one-pass to keep the window open.`); // D-419 item 3
        }
        const answer = String(await deps.confirm(question)).trim().toLowerCase();
        if (!['y', 'yes'].includes(answer)) {
          throw new RelayStop('refused', `the conversation isn't confirmed closed. Close it and run again, or run --one-pass and answer in the window.`);
        }
      }
    }

    await save({
      run: { id: runId, started_at: new Date().toISOString(), go, stopped: null },
      step: 'running',
      builder: conversationId ? { conversation_id: conversationId, mode: builderMode } : null,
      conversation_lock: conversationLock ? { path: conversationLock.filePath } : null,
    });
    out(`Review relay on lane ${laneId}: ${mode === 'loop' ? `loop with Claude Code conversation ${conversationId}` : 'one pass'}; reviewer ${TOOL_NAMES[reviewerTool]} ${reviewerVersion.version}${options.reviewerModel ? ` (${options.reviewerModel})` : ''}; cap ${cap}${go.kind === 'past-cap' ? ', one pass past it' : `, ceiling ${go.ceiling}`}.`);

    const runCtx = {
      options, deps, io, env, out, table, active, save, getState: () => state,
      rootDir, laneDir, laneId, worktrees, projectRepos, toolingRoot, relayCwd, turnDir, runId, token,
      reviewerTool, reviewerVersion: reviewerVersion.version, builderVersion: builderVersion?.version ?? null,
      builderMode, reviewerTimeoutMs, builderTimeoutMs, conversationId, mode, go, supported, platform,
    };
    await mkdir(turnDir, { recursive: true });
    await relayLoop(runCtx);
    throw new RelayStop('clean', 'unreachable');
  } catch (error) {
    if (!(error instanceof RelayStop)) {
      if (state && state.run && !state.run.stopped && state.run.id === runId) {
        await saveRelayState(laneDir, { ...state, step: 'stopped', run: { ...state.run, stopped: { at: new Date().toISOString(), kind: 'error' } }, last_stop: { at: new Date().toISOString(), kind: 'error', reason: error.message } }).catch(() => {});
      }
      throw error;
    }
    return finishStop({ error, state, laneDir, laneId, runId, out, save, conversationId: state?.builder?.conversation_id ?? null, mode: state?.run?.go?.mode ?? null });
  } finally {
    signals.off?.('SIGINT', onSigint);
    signals.removeListener?.('SIGINT', onSigint);
    await releaseConversationLock(conversationLock).catch(() => {});
    await releaseLaneLock(laneLock).catch(() => {});
  }
}

/**
 * The stop (D-419 item 9): the reason, the open findings as review-check
 * gives them, the choices, and in the loop the command that reopens the
 * builder's conversation.
 */
async function finishStop({ error, state, laneDir, laneId, runId, out, save, conversationId, mode }) {
  const kind = error.kind;
  let parsed = null;
  try {
    parsed = parseLog(await readFile(path.join(laneDir, 'wip.md'), 'utf8'));
  } catch {
    parsed = null;
  }
  if (state && kind !== 'recovered' && state.run?.id === runId) {
    const at = new Date().toISOString();
    await save({ step: 'stopped', run: { ...state.run, stopped: { at, kind } }, last_stop: { at, kind, reason: summarizeStop(kind, error.reason) } }).catch(() => {});
  }
  out('');
  out(`Stopped: ${error.reason}`);
  out('Open findings:');
  for (const line of openFindingLines(parsed)) out(line);
  const choices = error.details.choices ?? defaultChoices(kind, laneId);
  if (choices.length > 0) {
    out('Choices:');
    for (const choice of choices) out(`- ${choice}`);
  }
  if (mode === 'loop' && conversationId) {
    out(`Reopen the builder's conversation: claude --resume ${conversationId}`); // D-419 item 3
  }
  if (error.details.print) {
    out('');
    out(error.details.print);
  }
  return { exitCode: ORDINARY_STOPS.has(kind) ? 0 : 1, kind, reason: error.reason };
}

function summarizeStop(kind, reason) {
  const labels = {
    clean: 'a clean pass',
    'one-pass': 'one pass recorded',
    cap: 'the cap',
    ceiling: 'the run\'s ceiling',
    'builder-question': 'a builder question or an unfinished response',
    'owner-pause': 'the owner\'s pause',
    refusal: 'a refusal or a step out of bounds',
    failure: 'a failure',
    timeout: 'a timeout',
    unsupported: 'an unsupported version',
    fingerprint: 'the work, handoff, or record changed',
    interrupted: 'an interrupted turn',
    'no-mark': 'no ready-for-review mark',
    refused: 'refused',
    'nothing-open': 'nothing waits for the reviewer',
  };
  return `${labels[kind] ?? kind}: ${String(reason).slice(0, 300)}`;
}

function defaultChoices(kind, laneId) {
  switch (kind) {
    case 'clean':
      return ['close the lane in the builder\'s conversation; the relay never closes'];
    case 'one-pass':
      return [`type \`address review ${laneId}\` in the builder's window; the builder marks ready again, and you run the relay again`];
    case 'cap':
      return [
        `run \`vibecompass review-relay --session ${laneId} --past-cap\` for one more pass (it runs past the cap)`,
        'defer findings in the builder\'s conversation (an owner line)',
        'leave the lane open',
      ];
    case 'ceiling':
      return [`run \`vibecompass review-relay --session ${laneId}\` again: a new run continues up to the current cap`];
    case 'builder-question':
      return ['answer in the builder\'s conversation (reopen it below), then have it mark ready again and run the relay again'];
    case 'fingerprint':
      return [`the builder runs \`vibecompass ready-for-review --session ${laneId}\` again once the round is ready, then run the relay again`];
    case 'unsupported':
      return ['the other reviewer adapter, or hand-run review'];
    case 'interrupted':
      return [`let the turn finish or stop its processes, then run \`vibecompass review-relay --session ${laneId} --recover\``];
    default:
      return [];
  }
}

/**
 * Recovery (D-419 items 6 and 10): settle a recorded write without an end
 * state, and inspect a turn that was running when a relay died. It sends no
 * signal to a group recovered from disk.
 */
async function recoverLane({ state, save, table, rootDir, laneDir, laneId, worktrees, projectRepos, env, out }) {
  const notes = [];
  let stopReason = null;
  let reserved = false;
  let current = state;
  if (turnUnfinished(current)) {
    const turn = current.turn;
    if (!turn.pgid) {
      // The prompt is sent only after the process is recorded, so an
      // unrecorded process never got it: a tool whose stdin closes empty exits.
      current = await saveRelayState(laneDir, { ...current, turn: { ...turn, ended: { at: new Date().toISOString(), how: 'prompt never sent' } } });
      notes.push(`The ${turn.role} turn for pass ${turn.pass} was never recorded as started, so its prompt was never sent: no model turn ran.`);
    } else {
      const group = await inspectProcessGroup(table, { pgid: turn.pgid, pid: turn.pid, startedAt: turn.process_started_at });
      if (group.state === 'ended') {
        const partial = Boolean(turn.prompt_sent);
        current = await saveRelayState(laneDir, { ...current, turn: { ...turn, ended: { at: new Date().toISOString(), how: 'observed ended' }, possibly_partial: partial, partial_reported_at: partial ? new Date().toISOString() : null } });
        if (partial) {
          const text = `The ${turn.role} turn for pass ${turn.pass} was running when a relay stopped, and its process group has ended (${group.reason}): it may have run partly. Running the relay again repeats it, on your go; or answer in the conversation yourself.`;
          notes.push(text);
          stopReason = text;
        } else {
          notes.push(`The ${turn.role} turn for pass ${turn.pass} ended before its prompt was sent: no model turn ran.`);
        }
      } else {
        const listed = group.processes.map((row) => `${row.pid} ${row.command}`.trim()).join('; ');
        reserved = true;
        stopReason = `the ${turn.role} turn for pass ${turn.pass} from a stopped relay is ${group.state === 'active' ? 'still running' : 'uncertain'} (${group.reason}${listed ? `: ${listed}` : ''}). The lane and conversation stay reserved; the relay sends no signal. Let it finish, or stop those processes yourself, then run --recover again.`; // D-419 item 10
        notes.push(stopReason);
      }
    }
  }
  if (writeUnfinished(current)) {
    const recheck = makeRecheck({ rootDir, laneDir, worktrees, paths: current.write.paths ?? [], projectRepos, env });
    const result = await settleRelayWrite({
      rootDir,
      laneDir,
      write: current.write,
      recheck,
      onStep: async (write) => {
        current = await saveRelayState(laneDir, { ...current, write });
      },
    });
    current = await saveRelayState(laneDir, { ...current, write: result.write, writes: [...(current.writes ?? []), { id: result.write.id, pass: result.write.pass, state: result.write.state, at: new Date().toISOString() }] });
    notes.push(describeWriteEnd(result.write));
    if (result.unwritten === 'summary') {
      notes.push(`The summary that wasn't written:\n${result.write.handoff.body.join('\n')}`);
    } else if (result.unwritten === 'pass') {
      notes.push(`The pass that wasn't recorded:\n${result.write.wip.body.slice(-((result.write.pass_lines ?? 0) || result.write.wip.body.length)).join('\n')}`);
    }
  }
  // A reserved turn is printed once, in the stop.
  for (const note of notes) {
    if (note !== stopReason || !reserved) out(note);
  }
  return { state: current, summary: notes.join(' '), stopReason, reserved };
}

/** The run, one step at a time, from the record and the mark. */
async function relayLoop(ctx) {
  const { out, laneDir, laneId, rootDir, mode, go } = ctx;
  let ranPass = false;
  for (;;) {
    if (ctx.active.interrupted) throw new RelayStop('owner-pause', 'Ctrl-C: the owner stopped the relay.');
    const wip = await readFile(path.join(laneDir, 'wip.md'), 'utf8');
    const parsed = parseLog(wip);
    if (!parsed.ok) {
      throw new RelayStop('refusal', `the review log is malformed at wip.md line ${parsed.malformed.lineNumber} (${parsed.malformed.reason}); the relay didn't write that.`);
    }
    const mark = await readReadyMark(laneDir).catch(() => null);
    if (!mark) throw new RelayStop('no-mark', 'the ready-for-review mark is gone.');
    const recorded = passOnRound(parsed, mark.round_id);

    if (recorded) {
      // This round's pass is in the log: the builder answers next.
      if (isReviewClean(parsed)) {
        throw new RelayStop('clean', `pass ${parsed.passCount} is clean: nothing is open or waiting.`);
      }
      const { waiting } = findingsWaitingForBuilder(wip);
      if (mode !== 'loop') {
        throw new RelayStop('one-pass', ranPass ? `pass ${recorded.number} is recorded.` : `pass ${recorded.number} on this round is already recorded; the builder answers it.`);
      }
      if (waiting.length === 0) {
        throw new RelayStop('nothing-open', `pass ${recorded.number}'s findings wait for nobody's answer.`);
      }
      await builderTurn(ctx, recorded.number, mark);
      continue;
    }

    // A pass on the mark's round: first the ceiling or the cap.
    const cap = await readRoundCap(rootDir);
    const limit = go.kind === 'past-cap' ? go.ceiling : Math.min(go.ceiling, cap);
    if (parsed.passCount >= limit) {
      if (go.kind !== 'past-cap' && parsed.passCount < cap) {
        throw new RelayStop('ceiling', `this run's go covered ${go.ceiling} passes, and the cap is now ${cap}: the go is used up.`); // D-419 item 9
      }
      throw new RelayStop('cap', `the lane has run ${parsed.passCount} pass${parsed.passCount === 1 ? '' : 'es'} against a cap of ${cap}: the next pass runs past the cap.`); // D-419 item 9
    }
    const comparison = await compareMark(mark, { rootDir, laneDir, worktrees: ctx.worktrees, projectRepos: ctx.projectRepos, env: ctx.env });
    if (!comparison.current) {
      throw new RelayStop('fingerprint', `the ${comparison.differences.join(' and ')} changed since the ready-for-review mark (round ${shortRound(mark.round_id)}).`);
    }
    const { waiting } = findingsWaitingForBuilder(wip);
    if (waiting.length > 0) {
      throw new RelayStop('builder-question', `${waiting.join(', ')} ${waiting.length === 1 ? 'waits' : 'wait'} for the builder's response, so no pass runs.`);
    }

    const passNumber = parsed.passCount + 1;
    const pastCapPass = go.kind === 'past-cap';
    await reviewerTurn(ctx, { passNumber, mark, comparison, parsed, pastCapPass });
    ranPass = true;

    const after = parseLog(await readFile(path.join(laneDir, 'wip.md'), 'utf8'));
    if (isReviewClean(after)) {
      throw new RelayStop('clean', `pass ${passNumber} is clean: nothing is open or waiting.`);
    }
    if (mode !== 'loop') {
      throw new RelayStop('one-pass', `pass ${passNumber} is recorded.`);
    }
    if (ctx.options.confirmEachRound) {
      if (typeof ctx.deps.confirm !== 'function') {
        throw new RelayStop('owner-pause', '--confirm-each-round needs a terminal for the owner\'s Enter.');
      }
      const answer = String(await ctx.deps.confirm('Press Enter to send the builder its turn, or type anything else to stop here.'));
      if (answer.trim() !== '') {
        throw new RelayStop('owner-pause', `the owner stopped after pass ${passNumber}.`);
      }
    }
  }
}

function reviewerLabel(ctx, model, reported) {
  const name = `${TOOL_NAMES[ctx.reviewerTool]} ${ctx.reviewerVersion}`;
  if (model) return `${name} (${model}${reported ? '' : ' requested'}) via the relay`;
  return `${name} via the relay`;
}

/** One reviewer turn, its answer checked, and the pass written (D-419 items 4–6). */
async function reviewerTurn(ctx, { passNumber, mark, comparison, parsed, pastCapPass }) {
  const { laneDir, laneId, rootDir, out, save, table, active, turnDir } = ctx;
  const state = ctx.getState();
  // Before each turn the installed version is checked again.
  const version = await readToolVersion(ctx.reviewerTool, { env: ctx.env });
  const gate = checkReviewerVersion({ tool: ctx.reviewerTool, version: version.version, platform: ctx.platform, supported: ctx.supported });
  if (!gate.ok) throw new RelayStop('unsupported', gate.message);

  const fresh = ctx.options.freshReviewer || !state.reviewer || state.reviewer.tool !== ctx.reviewerTool || !state.reviewer.thread_id;
  const threadId = fresh ? null : state.reviewer.thread_id;
  const schemaPath = path.join(turnDir, 'answer-schema.json');
  const answerPath = path.join(turnDir, `pass-${passNumber}-${ctx.runId}-answer.json`);
  const logPath = path.join(turnDir, `pass-${passNumber}-${ctx.runId}-reviewer.jsonl`);
  await writeFile(schemaPath, `${JSON.stringify(REVIEWER_ANSWER_SCHEMA, null, 2)}\n`, 'utf8');
  let launch;
  if (ctx.reviewerTool === 'codex') {
    launch = codexReviewerLaunch({ model: ctx.options.reviewerModel, schemaPath, outputPath: answerPath, threadId, gitRepository: await isGitRepository(ctx.toolingRoot) });
  } else {
    // The reviewer reads from the tooling root; the memory root and any covered
    // repository outside it are added, since the launch confines file reads.
    const inside = (dir) => {
      const relative = path.relative(ctx.toolingRoot, dir);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    };
    const addDirs = [...new Set([path.resolve(rootDir), ...(await coveredRepositories(ctx, mark))])].filter((dir) => !inside(dir)).sort();
    launch = claudeReviewerLaunch({ model: ctx.options.reviewerModel ?? null, schemaJson: JSON.stringify(REVIEWER_ANSWER_SCHEMA), conversationId: threadId, addDirs });
  }
  const prompt = reviewerPrompt({ laneId, passNumber, rootDir, roundId: mark.round_id });
  out(`Pass ${passNumber}: ${TOOL_NAMES[ctx.reviewerTool]} ${version.version} reviewing round ${shortRound(mark.round_id)}${threadId ? ` (resuming ${threadId})` : ''}…`);
  await save({ step: 'reviewer-turn', round: { id: mark.round_id, fingerprints: mark.fingerprints }, turn: { role: 'reviewer', pass: passNumber, pid: null, pgid: null, process_started_at: null, prompt_sent: false, started_at: new Date().toISOString(), ended: null }, answer: null });
  const result = await runTurn({
    command: launch.command,
    args: launch.args,
    cwd: ctx.toolingRoot,
    env: reviewerTurnEnv(ctx.env),
    input: prompt,
    timeoutMs: ctx.reviewerTimeoutMs,
    table,
    active,
    logPath,
    onSpawned: async ({ pid, pgid, startedAt }) => {
      await save({ turn: { ...ctx.getState().turn, pid, pgid, process_started_at: startedAt, prompt_sent: true } });
    },
  });
  const ended = { at: new Date().toISOString(), how: result.timedOut ? 'timed out' : result.interrupted ? 'interrupted' : 'exited', exit_code: result.code ?? null };
  await save({ turn: { ...ctx.getState().turn, ended, possibly_partial: Boolean(result.timedOut || result.interrupted), partial_reported_at: result.timedOut || result.interrupted ? new Date().toISOString() : null } });
  if (result.spawnError) throw new RelayStop('failure', `the reviewer couldn't start: ${result.spawnError}.`);
  if (result.interrupted) throw new RelayStop('owner-pause', 'Ctrl-C: the owner stopped the relay during the reviewer\'s turn; no pass was recorded.');
  if (result.timedOut) throw new RelayStop('timeout', `the reviewer's turn ran past ${Math.round(ctx.reviewerTimeoutMs / 60000)} minutes; its process group was ended, and no pass was recorded.`);

  let answer = null;
  let model = ctx.options.reviewerModel ?? null;
  let reported = false;
  let threadOut = threadId;
  if (ctx.reviewerTool === 'codex') {
    const events = readCodexEvents(result.stdout);
    if (events.threadId) threadOut = events.threadId;
    if (result.code !== 0 || events.failed) {
      throw new RelayStop('failure', `the Codex reviewer failed (exit ${result.code}${events.failed ? `, ${events.failed}` : ''}${result.stderr ? `: ${result.stderr.split('\n').slice(-3).join(' ')}` : ''}). No retry.`);
    }
    try {
      answer = JSON.parse(await readFile(answerPath, 'utf8'));
    } catch (error) {
      answer = { unreadable: error instanceof Error ? error.message : String(error) };
    }
  } else {
    const stream = readClaudeStream(result.stdout);
    if (stream.init?.session_id) threadOut = stream.init.session_id;
    if (stream.init?.model) {
      model = stream.init.model;
      reported = true;
    }
    const problem = checkClaudeReviewerStream(stream);
    if (problem) throw new RelayStop('refusal', `${problem}. The turn's answer is discarded.`);
    if (result.code !== 0 || stream.result?.is_error || (stream.result && stream.result.subtype !== 'success')) {
      throw new RelayStop('failure', `the Claude Code reviewer failed (exit ${result.code}${stream.result?.subtype ? `, ${stream.result.subtype}` : ''}). No retry.${stream.rateLimit ? ` Last rate-limit event: ${JSON.stringify(stream.rateLimit.rate_limit_info ?? stream.rateLimit)}.` : ''}`);
    }
    answer = claudeAnswer(stream.result);
  }
  await save({ reviewer: { tool: ctx.reviewerTool, version: version.version, model, model_reported: reported, thread_id: threadOut } });

  const checked = answer && !answer.unreadable ? validateReviewerAnswer(answer, parsed) : { ok: false, problem: answer?.unreadable ? `the answer couldn't be read (${answer.unreadable})` : 'the reviewer returned no answer' };
  if (!checked.ok) {
    await save({ answer: { pass: passNumber, round_id: mark.round_id, valid: false, problem: checked.problem, raw: answer } });
    throw new RelayStop('failure', `the reviewer's answer is invalid: ${checked.problem}. Nothing was written; the answer is kept in ${path.join(laneDir, 'relay.json')}.`); // D-419 item 5
  }
  await save({ answer: { pass: passNumber, round_id: mark.round_id, valid: true, problem: null, raw: answer } });

  // The second comparison: a change during the review discards the answer.
  const now = await compareMark(mark, { rootDir, laneDir, worktrees: ctx.worktrees, projectRepos: ctx.projectRepos, env: ctx.env });
  if (!now.current) {
    throw new RelayStop('fingerprint', `the ${now.differences.join(' and ')} changed during the review, so its answer is discarded and nothing was written.`); // D-419 item 4
  }

  const label = reviewerLabel(ctx, model, reported);
  let write;
  try {
    write = prepareRelayWrite({
      wipContent: now.wipContent,
      handoffContent: now.handoffContent,
      answer: checked.answer,
      passNumber,
      time: formatRecordTime(),
      reviewerLabel: label,
      roundId: mark.round_id,
      fingerprints: mark.fingerprints,
      laneId,
      pastCap: pastCapPass,
    });
  } catch (error) {
    if (error.invalidAnswer) {
      await save({ answer: { ...ctx.getState().answer, valid: false, problem: error.message } });
      throw new RelayStop('failure', `the reviewer's answer is invalid: ${error.message}. Nothing was written.`);
    }
    throw error;
  }
  write.paths = mark.paths ?? [];
  await save({ step: 'write', write });
  const settled = await settleRelayWrite({
    rootDir,
    laneDir,
    write,
    onStep: async (step) => {
      await save({ write: step });
    },
  });
  await save({ write: settled.write, writes: [...(ctx.getState().writes ?? []), { id: settled.write.id, pass: passNumber, state: settled.write.state, at: new Date().toISOString() }], step: 'running' });
  if (settled.write.state === 'discarded') {
    throw new RelayStop('fingerprint', `${describeWriteEnd(settled.write)}`, { print: `The answer:\n${JSON.stringify(checked.answer, null, 2)}` });
  }
  printPass(out, await readFile(path.join(laneDir, 'wip.md'), 'utf8'), passNumber);
  if (settled.write.state === 'superseded') {
    throw new RelayStop('refusal', describeWriteEnd(settled.write), { print: settled.write.handoff.body.join('\n') });
  }
}

function printPass(out, wipContent, passNumber) {
  const parsed = parseLog(wipContent);
  const pass = parsed.ok ? parsed.passes.find((item) => item.number === passNumber) : null;
  if (!pass) return;
  out(`Pass ${passNumber} recorded (${pass.outcome}) by ${pass.reviewer}:`);
  for (const finding of pass.findings) {
    const state = parsed.findings.find((item) => item.id === finding.id);
    const reason = finding.status === 'open' ? state?.finding : state?.lastVerdict?.reason;
    out(`- ${finding.id} (${state?.severity ?? '?'}) ${finding.status}: ${reason ?? ''}`);
  }
}

function printResponse(out, wipContent, passNumber) {
  const parsed = parseLog(wipContent);
  if (!parsed.ok) return;
  const response = [...parsed.records].reverse().find((record) => record.kind === 'response' && record.number === passNumber);
  if (!response) return;
  out(`Response ${passNumber} by ${response.builder}:`);
  for (const finding of response.findings) {
    const state = parsed.findings.find((item) => item.id === finding.id);
    out(`- ${finding.id} ${finding.status}: ${state?.lastDisposition?.reason ?? ''}`);
  }
}

/** One builder turn with the fixed address-review text (D-419 items 7–8). */
async function builderTurn(ctx, passNumber, markBefore) {
  const { laneDir, laneId, out, save, table, active, turnDir } = ctx;
  const version = await readToolVersion('claude', { env: ctx.env });
  const gate = checkBuilderVersion({ version: version.version });
  if (!gate.ok) throw new RelayStop('unsupported', gate.message);

  const wipBefore = await readFile(path.join(laneDir, 'wip.md'), 'utf8');
  const parsedBefore = parseLog(wipBefore);
  const handoffBefore = await readFile(path.join(laneDir, 'handoff.md'), 'utf8').catch(() => '');
  const reviewerSectionBefore = readSectionBody(handoffBefore, REVIEWER_TO_BUILDER_HEADING);
  const coveredRepos = await coveredRepositories(ctx, markBefore);
  const refsBefore = await remoteRefs(coveredRepos);
  const ghConfigDir = path.join(turnDir, 'gh-config-empty');
  await mkdir(ghConfigDir, { recursive: true });
  const launch = claudeBuilderLaunch({ conversationId: ctx.conversationId, mode: ctx.builderMode });
  const logPath = path.join(turnDir, `pass-${passNumber}-${ctx.runId}-builder.jsonl`);
  out(`Builder turn for pass ${passNumber}: resuming conversation ${ctx.conversationId} in ${ctx.builderMode} mode…`);
  await save({ step: 'builder-turn', turn: { role: 'builder', pass: passNumber, pid: null, pgid: null, process_started_at: null, prompt_sent: false, started_at: new Date().toISOString(), ended: null } });

  // The stream is read in order: hook events may come before init; anything
  // else, or an init naming another mode or conversation, ends the turn.
  let sawInit = false;
  let earlyProblem = null;
  const onLine = (line) => {
    if (sawInit || earlyProblem) return null;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return null;
    }
    if (event?.type === 'system' && typeof event.subtype === 'string' && event.subtype.startsWith('hook')) return null;
    if (event?.type === 'system' && event.subtype === 'init') {
      sawInit = true;
      const problem = checkBuilderInit({ otherBeforeInit: [], init: event }, { conversationId: ctx.conversationId, mode: ctx.builderMode });
      if (problem) earlyProblem = problem;
      return earlyProblem;
    }
    earlyProblem = `the builder's stream had an event (${event?.type ?? 'unknown'}) before init`;
    return earlyProblem;
  };
  const result = await runTurn({
    command: launch.command,
    args: launch.args,
    cwd: ctx.relayCwd,
    env: builderTurnEnv(ctx.env, { ghConfigDir, relayToken: ctx.token }),
    input: builderPrompt({ laneId, passNumber }),
    timeoutMs: ctx.builderTimeoutMs,
    table,
    active,
    logPath,
    onLine,
    onSpawned: async ({ pid, pgid, startedAt }) => {
      await save({ turn: { ...ctx.getState().turn, pid, pgid, process_started_at: startedAt, prompt_sent: true } });
    },
  });
  const partial = Boolean(result.timedOut || result.interrupted || result.aborted);
  await save({ turn: { ...ctx.getState().turn, ended: { at: new Date().toISOString(), how: result.timedOut ? 'timed out' : result.interrupted ? 'interrupted' : result.aborted ? 'ended by the relay' : 'exited', exit_code: result.code ?? null }, possibly_partial: partial, partial_reported_at: partial ? new Date().toISOString() : null } });
  if (result.spawnError) throw new RelayStop('failure', `the builder couldn't start: ${result.spawnError}.`);
  if (result.interrupted) throw new RelayStop('owner-pause', 'Ctrl-C: the owner stopped the relay during the builder\'s turn, which may have run partly.');
  if (result.timedOut) throw new RelayStop('timeout', `the builder's turn ran past ${Math.round(ctx.builderTimeoutMs / 60000)} minutes; its process group was ended, and the turn may have run partly.`);
  if (result.aborted) throw new RelayStop('failure', `${result.aborted}; the relay ended the turn, which may have run partly.`);

  const stream = readClaudeStream(result.stdout);
  const initProblem = checkBuilderInit(stream, { conversationId: ctx.conversationId, mode: ctx.builderMode });
  if (initProblem) throw new RelayStop('failure', `${initProblem}.`);
  const denials = Array.isArray(stream.result?.permission_denials) ? stream.result.permission_denials : [];
  if (denials.length > 0) {
    const first = denials[0];
    throw new RelayStop('refusal', `the builder's turn was refused ${denials.length} action${denials.length === 1 ? '' : 's'} (first: ${first.tool_name ?? 'a tool'}${first.tool_input?.command ? ` \`${String(first.tool_input.command).slice(0, 200)}\`` : ''}). Answer in the conversation, or run the relay with another --builder-mode.`); // D-419 item 8
  }
  if (result.code !== 0 || stream.result?.is_error || !stream.result || stream.result.subtype !== 'success') {
    throw new RelayStop('failure', `the builder's turn failed (exit ${result.code}${stream.result?.subtype ? `, ${stream.result.subtype}` : ', no result'}). No retry.${stream.rateLimit ? ` Last rate-limit event: ${JSON.stringify(stream.rateLimit.rate_limit_info ?? stream.rateLimit)}.` : ''}`);
  }

  if (!(await exists(laneDir))) {
    throw new RelayStop('refusal', `lane ${laneId} closed during the builder's turn.`);
  }
  const refsAfter = await remoteRefs(coveredRepos);
  const moved = coveredRepos.filter((dir) => refsBefore[dir] !== refsAfter[dir]);
  if (moved.length > 0) {
    throw new RelayStop('refusal', `a remote-tracking ref moved during the builder's turn in ${moved.join(', ')}: something may have been pushed.`); // D-419 item 8
  }
  const wipAfter = await readFile(path.join(laneDir, 'wip.md'), 'utf8');
  const parsedAfter = parseLog(wipAfter);
  if (!parsedAfter.ok) {
    throw new RelayStop('refusal', `the builder left the review log malformed at wip.md line ${parsedAfter.malformed.lineNumber} (${parsedAfter.malformed.reason}).`);
  }
  if (parsedAfter.passCount !== parsedBefore.passCount) {
    throw new RelayStop('refusal', 'a pass line the relay didn\'t write appeared during the builder\'s turn.'); // D-419 item 8
  }
  const handoffAfter = await readFile(path.join(laneDir, 'handoff.md'), 'utf8').catch(() => '');
  if (readSectionBody(handoffAfter, REVIEWER_TO_BUILDER_HEADING) !== reviewerSectionBefore) {
    throw new RelayStop('refusal', '## Reviewer → Builder changed during the builder\'s turn; the relay writes that section.'); // D-419 item 8
  }
  printResponse(out, wipAfter, passNumber);
  const markAfter = await readReadyMark(laneDir).catch(() => null);
  const responded = parsedAfter.records.some((record) => record.kind === 'response' && record.number === passNumber);
  const newMark = markAfter && markAfter.round_id !== markBefore.round_id && markAfter.marked_at !== markBefore.marked_at;
  if (!responded || !newMark) {
    const { waiting } = findingsWaitingForBuilder(wipAfter);
    const last = stream.lastAssistantText ?? (typeof stream.result?.result === 'string' ? stream.result.result : '');
    throw new RelayStop('builder-question', `the builder's turn ended ${responded ? 'without a new ready-for-review mark' : `without a response line for pass ${passNumber}`}${waiting.length > 0 ? `; ${waiting.join(', ')} still ${waiting.length === 1 ? 'waits' : 'wait'} for the builder` : ''}.`, { print: last ? `The builder's last message:\n${last.slice(0, 4000)}` : null });
  }
  out(`The builder marked round ${shortRound(markAfter.round_id)} ready.`);
}

async function coveredRepositories(ctx, mark) {
  const dirs = new Set(Object.values(ctx.worktrees).map((dir) => path.resolve(dir)));
  for (const spec of mark.paths ?? []) {
    try {
      const resolved = resolveMarkPath(spec, { rootDir: ctx.rootDir, projectRepos: ctx.projectRepos, worktrees: ctx.worktrees });
      const top = await gitText(['rev-parse', '--show-toplevel'], (await exists(resolved.absolute)) ? path.dirname(resolved.absolute) : resolved.base);
      if (top.ok) dirs.add(top.stdout.trim());
    } catch {
      // A path that can't be resolved covers no repository.
    }
  }
  return [...dirs].sort();
}

export function defaultConfirm(io = { stdin: process.stdin, stdout: process.stdout }) {
  if (!io.stdin?.isTTY) return null;
  return async (question) => {
    const { createInterface: createPrompt } = await import('node:readline/promises');
    const rl = createPrompt({ input: io.stdin, output: io.stdout });
    try {
      return await rl.question(`${question} `);
    } finally {
      rl.close();
    }
  };
}

export const RELAY_HOME_NOTE = () => path.join(os.userInfo().homedir, '.config', 'vibecompass', 'relay-locks');
