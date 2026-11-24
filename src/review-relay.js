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
  relayCommand,
  remarkCommand,
  reviewerPrompt,
  reviewerTurnEnv,
  validateBuilderMode,
} from './relay-adapters.js';

export { describeListedReviewers } from './relay-adapters.js';
import {
  RELAY_TURN_DIR,
  compareMark,
  findingsWaitingForBuilder,
  fingerprintWork,
  gitText,
  readReadyMark,
  repositoryTopLevel,
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
  RELAY_TURN_MARKER,
  emptyRelayState,
  findMarkedProcesses,
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
import { withMemoryRootLock } from './serialization.js';
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
// After SIGKILL, how long a group may take to disappear before it counts as
// uncertain and stays reserved.
const GROUP_SETTLE_MS = 5000;
// Once the group is gone, how long its output may take to reach the relay
// before the relay closes a pipe something outside the group still holds.
const DRAIN_MS = 2000;

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

/** A turn's limit in words: "45 minutes", or seconds for a limit under a minute. */
function formatMinutes(ms) {
  if (ms < 60_000) {
    const seconds = Math.max(1, Math.round(ms / 1000));
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  const minutes = Math.round(ms / 60_000);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
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
 * `deliver`, when given, makes the last check before the prompt: it is called
 * with `send` and returns null once it has sent the prompt, or the reason it
 * withheld it, and stdin then closes empty.
 */
async function runTurn({ command, args, cwd, env, input, timeoutMs, table, onSpawned, deliver = null, onLine = () => null, logPath, active, killGraceMs = KILL_GRACE_MS, settleMs = GROUP_SETTLE_MS, drainMs = DRAIN_MS }) {
  let child;
  try {
    child = spawn(command, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    return { spawnError: error instanceof Error ? error.message : String(error) };
  }
  // Every listener is attached before the first await, so no event is missed.
  // The turn follows the process's exit and its group, never the pipes: a
  // helper that left the group can hold stdout open long after both.
  let exitInfo = null;
  const exited = once(child, 'exit').then(([code, signal]) => {
    exitInfo = { code, signal };
  }).catch(() => {
    exitInfo = { code: null, signal: null };
  });
  let pipesClosed = false;
  const closed = once(child, 'close').then(() => {
    pipesClosed = true;
  }).catch(() => {
    pipesClosed = true;
  });
  const spawned = Promise.race([
    once(child, 'spawn').then(() => null),
    once(child, 'error').then(([error]) => error),
  ]);
  let aborted = null;
  let timedOut = false;
  let pgid = null;
  let terminatedAt = null;
  let killTimer = null;
  // Ending the group: SIGTERM now, SIGKILL after the grace period. The kill
  // timer is tracked, keeps the process alive until it fires, and is cleared
  // once the whole group is gone.
  const endGroup = () => {
    if (pgid === null || terminatedAt !== null) return;
    terminatedAt = Date.now();
    table.killGroup(pgid, 'SIGTERM');
    killTimer = setTimeout(() => {
      killTimer = null;
      table.killGroup(pgid, 'SIGKILL');
    }, killGraceMs);
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
  active.group = { pgid, kill: (signal) => table.killGroup(pgid, signal), terminate: endGroup };
  const timer = setTimeout(() => {
    timedOut = true;
    endGroup();
  }, timeoutMs);
  timer.unref();
  // The tool waits with stdin open and the prompt unsent while its identity is recorded.
  const startedAt = await processStartTime(table, pid).catch(() => null);
  let recordError = null;
  try {
    await onSpawned({ pid, pgid, startedAt });
  } catch (error) {
    recordError = error instanceof Error ? error.message : String(error);
  }
  // The prompt goes out only to a recorded process that nothing has begun to
  // stop: not after Ctrl-C, a timeout, or the relay's own end of the turn,
  // any of which may have come while the identity was being recorded, and
  // not when the caller's last check withholds it.
  let promptSent = false;
  let withheld = null;
  let deliverError = null;
  const canSend = () => !recordError && !active.interrupted && terminatedAt === null;
  const send = () => {
    if (!canSend()) return false;
    child.stdin.end(input);
    promptSent = true;
    return true;
  };
  if (canSend()) {
    if (deliver) {
      // A reason not to send is a change the check saw; a check that failed
      // (the lock or a read) is an error, never a reason to try again.
      try {
        withheld = await deliver(send);
      } catch (error) {
        deliverError = error instanceof Error ? error.message : String(error);
      }
      if (promptSent) withheld = null;
    } else {
      send();
    }
  }
  if (!promptSent) {
    // Stdin closes empty, and the group is ended.
    child.stdin.end();
    endGroup();
  }

  // A tool's own child can outlive it: the turn runs until its process has
  // exited and its whole group is gone. A group being ended gets SIGKILL after
  // the grace period; one still there after that is uncertain, and the caller
  // keeps it reserved.
  let groupEnded = false;
  for (;;) {
    if (exitInfo) {
      const group = await inspectProcessGroup(table, { pgid, pid, startedAt });
      if (group.state === 'ended') {
        groupEnded = true;
        break;
      }
    }
    if (terminatedAt !== null && Date.now() - terminatedAt > killGraceMs + settleMs) break;
    // Before the exit, the wait ends at the exit or the next poll; after it,
    // the group is read once per poll interval.
    const poll = new Promise((resolve) => setTimeout(resolve, GROUP_POLL_MS));
    await (exitInfo ? poll : Promise.race([exited, poll]));
  }
  clearTimeout(timer);
  if (groupEnded && killTimer) {
    clearTimeout(killTimer);
    killTimer = null;
  }
  // What the group wrote is read to the end, for a bounded time: a pipe still
  // held by a process outside the group is closed on the relay's side.
  if (!pipesClosed) {
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, drainMs))]);
  }
  if (!pipesClosed) {
    reader.close();
    child.stdout.destroy();
    child.stderr.destroy();
  }
  active.group = null;
  return { code: exitInfo?.code ?? null, signal: exitInfo?.signal ?? null, stdout: stdoutLines.join('\n'), stderr: stderrChunks.join('').trim(), timedOut, aborted, interrupted: active.interrupted, recordError, promptSent, withheld, deliverError, groupEnded, pipesHeld: !pipesClosed, pid, pgid, startedAt };
}

/**
 * A turn whose group couldn't be seen to end: the turn stays unfinished in
 * relay.json, so the lane and conversation stay reserved for recovery.
 */
function groupStillRunning(ctx, role, passNumber, result, unrecorded = null) {
  const recover = ctx.commands.recover;
  if (unrecorded) {
    return new RelayStop('interrupted', `the ${role} turn for pass ${passNumber} was ended, but its process group (${result.pgid}, process ${result.pid}) was still present after SIGKILL, and relay.json couldn't record it (${unrecorded}). The lane and conversation stay reserved until you settle it: check that no process in group ${result.pgid} is left (\`ps -A -o pid,pgid,command\`), stop any you find, then run \`${recover}\` in a terminal, which looks for the turn's processes by its id and, with none found, asks you to settle it.`, { reserved: true }); // D-419 item 10
  }
  return new RelayStop('interrupted', `the ${role} turn for pass ${passNumber} was ended, but its process group (${result.pgid}) was still present after SIGKILL. The lane and conversation stay reserved; when those processes are gone, run \`${recover}\`.`, { reserved: true }); // D-419 item 10
}

/**
 * A turn whose process couldn't be recorded before its prompt: the prompt was
 * never sent, and its identity is recorded now, so recovery and close can
 * inspect a group that hasn't ended. Returns the save's error, if any.
 */
async function recordLateIdentity(ctx, result) {
  const turn = ctx.getState().turn;
  try {
    if (ctx.deps.onTurnRecord) await ctx.deps.onTurnRecord({ stage: 'late identity', role: turn.role });
    await ctx.save({
      turn: {
        ...turn,
        pid: result.pid,
        pgid: result.pgid,
        process_started_at: result.startedAt,
        prompt_sent: false,
        identity_recorded_late: true,
        ended: result.groupEnded ? { at: new Date().toISOString(), how: 'prompt never sent' } : null,
      },
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * After a turn's process has run: a process that couldn't be recorded gets its
 * identity recorded late, and a group that didn't end keeps the turn
 * unfinished. Throws the stop for either; returns when the turn is settled.
 */
async function settleTurnStart(ctx, role, passNumber, result) {
  if (result.recordError) {
    const lateError = await recordLateIdentity(ctx, result);
    if (!result.groupEnded) throw groupStillRunning(ctx, role, passNumber, result, lateError);
    throw new RelayStop(lateError ? 'interrupted' : 'failure', `the ${role}'s process couldn't be recorded (${result.recordError}), so its stdin was closed empty and its process group ended: no model turn ran.${lateError ? ` relay.json couldn't record that either (${lateError}), so the lane and conversation stay reserved: run \`${ctx.commands.recover}\` in a terminal, which looks for the turn's processes by its id and, with none found, asks you to settle it.` : ''}`);
  }
  if (!result.groupEnded) {
    // A turn stopped before its prompt went out says so in relay.json.
    if (!result.promptSent) await ctx.save({ turn: { ...ctx.getState().turn, prompt_sent: false } }).catch(() => {});
    throw groupStillRunning(ctx, role, passNumber, result);
  }
}

function turnEndHow(result) {
  return result.timedOut ? 'timed out' : result.interrupted ? 'interrupted' : result.aborted ? 'ended by the relay' : 'exited';
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
  // The commands a stop prints, as this run was started, so each runs as printed.
  const commandSpec = {
    laneId,
    rootDir,
    reviewerTool,
    reviewerModel: options.reviewerModel ?? null,
    onePass: Boolean(options.onePass),
    confirmEachRound: Boolean(options.confirmEachRound),
    freshReviewer: Boolean(options.freshReviewer),
    builderMode: options.builderMode ?? null,
    reviewerTimeout: options.reviewerTimeout ?? null,
    builderTimeout: options.builderTimeout ?? null,
  };
  const commands = {
    relay: (extra = []) => relayCommand(commandSpec, extra),
    recover: relayCommand(commandSpec, ['--recover']),
    remark: (paths = []) => remarkCommand({ laneId, rootDir, paths }),
  };

  const laneLock = await acquireLaneLock({ laneDir, laneId, runId, token, table, rootDir });
  if (laneLock.tookOver) {
    out(`Took over lane ${laneId}'s relay lock from run ${laneLock.tookOver.run_id}, whose process is gone.`);
  }
  let conversationLock = null;
  let state = null;
  // What the current mark names, for a stop before this run's state is saved.
  let stopConversation = null;
  let stopMode = null;
  const stopMark = { paths: [] };
  const onSigint = () => {
    active.interrupted = true;
    active.group?.terminate();
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
    const recovered = await recoverLane({ state, save, table, rootDir, laneDir, laneId, worktrees, projectRepos, env, out, commands, confirm: deps.confirm, recoverMode: Boolean(options.recover) });
    state = recovered.state;
    if (recovered.reserved) {
      throw new RelayStop('interrupted', recovered.stopReason, recovered.choices ? { choices: recovered.choices } : {});
    }
    if (options.recover) {
      throw new RelayStop('recovered', recovered.summary || 'nothing to recover');
    }
    if (recovered.stopReason) {
      throw new RelayStop(recovered.stopKind ?? 'interrupted', recovered.stopReason);
    }

    const mark = await readReadyMark(laneDir).catch((error) => {
      throw new RelayStop('failure', error.message);
    });
    if (!mark) {
      throw new RelayStop('no-mark', `lane ${laneId} has no ready-for-review mark. The builder runs \`${commands.remark()}\` when the round is ready.`);
    }
    const conversationId = markConversation(mark);
    const mode = conversationId && !options.onePass ? 'loop' : 'one-pass';
    stopConversation = conversationId;
    stopMode = mode;
    stopMark.paths = mark.paths ?? [];

    const reviewerVersion = await readToolVersion(reviewerTool, { env });
    if (reviewerVersion.missing) {
      throw new RelayStop('unsupported', `${reviewerTool} wasn't found on PATH. The relay installs nothing; install ${TOOL_NAMES[reviewerTool]}, choose the other reviewer, or review by hand.`);
    }
    const reviewerGate = checkReviewerVersion({ tool: reviewerTool, version: reviewerVersion.ok ? reviewerVersion.version : null, platform, supported, otherTool: REVIEWER_TOOLS.find((tool) => tool !== reviewerTool) });
    if (!reviewerGate.ok) {
      throw new RelayStop('unsupported', reviewerGate.message);
    }
    let builderVersion = null;
    if (mode === 'loop') {
      builderVersion = await readToolVersion('claude', { env });
      if (builderVersion.missing) {
        throw new RelayStop('unsupported', 'claude wasn\'t found on PATH, so the relay can\'t resume the builder\'s conversation. Run one pass with --one-pass instead.');
      }
      const builderGate = checkBuilderVersion({ version: builderVersion.ok ? builderVersion.version : null });
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
      killGraceMs: deps.killGraceMs ?? KILL_GRACE_MS, settleMs: deps.groupSettleMs ?? GROUP_SETTLE_MS,
      commands, stopMark,
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
    // Awaited here, so the stop is recorded while this run still holds its locks.
    return await finishStop({ error, state, laneDir, laneId, runId, out, save, deps, commands, markPaths: stopMark.paths, conversationId: stopConversation ?? state?.builder?.conversation_id ?? null, mode: stopMode ?? state?.run?.go?.mode ?? null });
  } finally {
    signals.off?.('SIGINT', onSigint);
    signals.removeListener?.('SIGINT', onSigint);
    // A turn whose group may still be running keeps the conversation reserved.
    if (!turnUnfinished(state)) await releaseConversationLock(conversationLock).catch(() => {});
    await releaseLaneLock(laneLock).catch(() => {});
  }
}

/**
 * The stop (D-419 item 9): the reason, the open findings as review-check
 * gives them, the choices, and in the loop the command that reopens the
 * builder's conversation.
 */
async function finishStop({ error, state, laneDir, laneId, runId, out, save, deps = {}, commands, markPaths = [], conversationId, mode }) {
  const kind = error.kind;
  let parsed = null;
  try {
    parsed = parseLog(await readFile(path.join(laneDir, 'wip.md'), 'utf8'));
  } catch {
    parsed = null;
  }
  let unrecorded = null;
  if (state && kind !== 'recovered' && state.run?.id === runId) {
    const at = new Date().toISOString();
    try {
      if (deps.beforeStopSave) await deps.beforeStopSave();
      await save({ step: 'stopped', run: { ...state.run, stopped: { at, kind } }, last_stop: { at, kind, reason: summarizeStop(kind, error.reason) } });
    } catch (saveError) {
      unrecorded = saveError instanceof Error ? saveError.message : String(saveError);
    }
  }
  out('');
  out(`Stopped: ${error.reason}`);
  out('Open findings:');
  for (const line of openFindingLines(parsed)) out(line);
  const reopens = mode === 'loop' && Boolean(conversationId);
  const choices = error.details.choices ?? defaultChoices(kind, { laneId, reopens, commands, markPaths });
  if (choices.length > 0) {
    out('Choices:');
    for (const choice of choices) out(`- ${choice}`);
  }
  if (reopens) {
    out(`Reopen the builder's conversation: claude --resume ${conversationId}`); // D-419 item 3
  }
  if (error.details.print) {
    out('');
    out(error.details.print);
  }
  if (unrecorded) {
    out('');
    out(`Warning: this stop couldn't be recorded in ${path.join(laneDir, 'relay.json')} (${unrecorded}); run \`${commands.recover}\` before the next run.`);
  }
  return { exitCode: ORDINARY_STOPS.has(kind) && !unrecorded ? 0 : 1, kind, reason: error.reason };
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
    conversation: 'the mark names another conversation',
  };
  return `${labels[kind] ?? kind}: ${String(reason).slice(0, 300)}`;
}

/**
 * The choices a stop prints, rendered from how the run was started: each
 * command runs as printed, and the builder's conversation is offered only
 * when the stop prints the command that reopens it.
 */
function defaultChoices(kind, { laneId, reopens, commands, markPaths = [] }) {
  const relay = (extra) => `\`${commands.relay(extra)}\``;
  const answer = reopens
    ? 'answer in the builder\'s conversation (reopen it below)'
    : `answer in the builder's window (\`address review ${laneId}\`)`;
  switch (kind) {
    case 'clean':
      return ['close the lane in the builder\'s conversation; the relay never closes'];
    case 'one-pass':
      return [`type \`address review ${laneId}\` in the builder's window; the builder marks ready again, and you run ${relay()} again`];
    case 'cap':
      return [
        `run ${relay(['--past-cap'])} for one more pass (it runs past the cap)`,
        'defer findings in the builder\'s conversation (an owner line)',
        'leave the lane open',
      ];
    case 'ceiling':
      return [`run ${relay()} again: a new run continues up to the current cap`];
    case 'builder-question':
      return [`${answer}, then have it mark ready again and run ${relay()} again`];
    case 'fingerprint':
      return [`the builder runs \`${commands.remark(markPaths)}\` again once the round is ready, then run ${relay()} again`];
    case 'unsupported':
      return ['the other reviewer adapter, or hand-run review'];
    case 'interrupted':
      return [`let the turn finish or stop its processes, then run \`${commands.recover}\``];
    case 'timeout':
      return reopens
        ? [
          `run ${relay()} again to repeat the turn, with a longer --reviewer-timeout or --builder-timeout if it needs one`,
          'look at what the builder did in its conversation (reopen it below), and answer there yourself',
          'review by hand',
        ]
        : [`run ${relay()} again to repeat the turn, with a longer --reviewer-timeout if it needs one`, 'review by hand'];
    case 'owner-pause':
      return [`run ${relay()} again to continue`, reopens ? 'answer in the builder\'s conversation yourself (reopen it below)' : 'review by hand'];
    case 'failure':
      return [`fix what the reason names, then run ${relay()} again`, 'review by hand'];
    case 'refusal':
      return [`${answer}, then have it mark ready again and run ${relay()} again`, 'review by hand'];
    case 'no-mark':
      return [`the builder runs \`${commands.remark(markPaths)}\` when the round is ready, then run ${relay()}`];
    case 'nothing-open':
      return ['close the lane in the builder\'s conversation, or continue by hand'];
    case 'refused':
      return ['do what the reason names, then run the relay again'];
    default:
      return [];
  }
}

/** The Claude Code conversation a mark names, or null for a mark from elsewhere. */
function markConversation(mark) {
  return mark?.builder?.tool === 'claude-code' ? mark.builder.conversation_id ?? null : null;
}

/**
 * Recovery (D-419 items 6 and 10): settle a recorded write without an end
 * state, and inspect a turn that was running when a relay died. It sends no
 * signal to a group recovered from disk.
 */
async function recoverLane({ state, save, table, rootDir, laneDir, laneId, worktrees, projectRepos, env, out, commands, confirm = null, recoverMode = false }) {
  const notes = [];
  let stopReason = null;
  let reserved = false;
  let choices = null;
  let current = state;
  // Reporting a turn and closing its run are one save, so a turn is reported once.
  const reportTurn = async (turn, text) => {
    const at = new Date().toISOString();
    const run = current.run && !current.run.stopped ? { ...current.run, stopped: { at, kind: 'interrupted' } } : current.run;
    current = await saveRelayState(laneDir, { ...current, turn: { ...turn, reported_at: at }, ...(run !== current.run ? { step: 'stopped', run, last_stop: { at, kind: 'interrupted', reason: text.slice(0, 300) } } : {}) });
  };
  if (turnUnfinished(current)) {
    const turn = current.turn;
    if (!turn.pgid) {
      // Recorded before its process started and never with it: the prompt
      // goes out only after that record, so no model turn ran, but a process
      // may be left that the relay can't inspect by its group. The turn's own
      // processes carry its id in their environment: any found keep the lane
      // reserved. With none found, a system program the turn started (a
      // shell shows no environment) can't be ruled out, so it stays reserved
      // until the owner, at --recover in a terminal, settles it. No other
      // session's process is named or needs stopping.
      const since = turn.started_at ? new Date(turn.started_at).toString() : 'an unknown time';
      const marker = turn.id ? `${RELAY_TURN_MARKER}=${turn.id}` : null;
      const found = await findMarkedProcesses(table, turn.id);
      const head = `the ${turn.role} turn for pass ${turn.pass}, started ${since}, was never recorded with its process, so the relay can't inspect its process group. Its prompt was never sent, since the prompt goes out only after that record, so no model turn ran.`;
      // Stopping a group is suggested only where a process that leads it
      // carries the id, so the group was made by the turn; any other process
      // carrying it is named by its id alone.
      const stopCommand = (row) => (row.pid === row.pgid ? `kill -TERM -${row.pgid}` : `kill -TERM ${row.pid}`);
      const unclear = found.ok && found.ambiguous.length > 0
        ? `${found.ambiguous.length === 1 ? 'One process names' : `${found.ambiguous.length} processes name`} its id where the relay can't tell its environment from its arguments, or changed between two reads of the process table, so ${found.ambiguous.length === 1 ? 'it isn\'t' : 'they aren\'t'} taken for the turn's: ${found.ambiguous.map((row) => `process ${row.pid}${row.command ? ` (${row.command})` : ''}`).join('; ')}. The relay waits until ${found.ambiguous.length === 1 ? 'it is' : 'they are'} gone.`
        : '';
      if (!found.ok) {
        // An inspection that failed settles nothing (D-419 item 10).
        reserved = true;
        stopReason = `${head} The relay couldn't look for its processes (${found.reason}), so the lane and conversation stay reserved and nothing is asked. Run \`${commands.recover}\` again once the process table can be read.`; // D-419 item 10
        choices = [`run \`${commands.recover}\` again once \`ps\` works`];
        notes.push(stopReason);
      } else if (found.verified.length > 0) {
        reserved = true;
        stopReason = `${head} These processes carry its id (${marker}) in their environment: ${found.verified.map((row) => `${row.pid} in group ${row.pgid}${row.command ? ` ${row.command}` : ''}`).join('; ')}. The lane and conversation stay reserved; the relay sends no signal. Let them finish, or stop them yourself (${[...new Set(found.verified.map((row) => `\`${stopCommand(row)}\``))].join(', ')}), then run \`${commands.recover}\` again.${unclear ? ` ${unclear}` : ''} No other process needs stopping.`; // D-419 item 10
        choices = [`let those processes finish, or stop them (${[...new Set(found.verified.map(stopCommand))].join('; ')}), then run \`${commands.recover}\``];
        notes.push(stopReason);
      } else if (unclear) {
        reserved = true;
        stopReason = `${head} No process is shown to carry its id (${marker}) in its environment. ${unclear} The lane and conversation stay reserved; run \`${commands.recover}\` again then. No other process needs stopping.`; // D-419 item 10
        choices = [`run \`${commands.recover}\` again once ${found.ambiguous.length === 1 ? 'that process is' : 'those processes are'} gone`];
        notes.push(stopReason);
      } else {
        const looked = `No running process carries its id (${marker}), but a system program it started, such as a shell, doesn't show its environment, so the relay can't rule one out.`;
        const answer = recoverMode && typeof confirm === 'function'
          ? String(await confirm(`The ${turn.role} turn for pass ${turn.pass}, started ${since}, was never recorded with its process, so its prompt was never sent and no model turn ran. ${looked} Settle the turn and release the lane and conversation? Other sessions aren't affected. [y/N]`)).trim().toLowerCase()
          : null;
        if (answer === 'y' || answer === 'yes') {
          current = await saveRelayState(laneDir, { ...current, turn: { ...turn, ended: { at: new Date().toISOString(), how: 'prompt never sent; settled by the owner' } } });
          notes.push(`The ${turn.role} turn for pass ${turn.pass} was never recorded with its process, so its prompt was never sent: no model turn ran. You settled it.`);
        } else {
          reserved = true;
          stopReason = `${head} ${looked} The lane and conversation stay reserved until you run \`${commands.recover}\` in a terminal, which asks you to settle it. No other session's process needs stopping.`; // D-419 item 10
          choices = [`run \`${commands.recover}\` in a terminal and settle the turn`];
          notes.push(stopReason);
        }
      }
    } else {
      const group = await inspectProcessGroup(table, { pgid: turn.pgid, pid: turn.pid, startedAt: turn.process_started_at });
      if (group.state === 'ended') {
        const partial = Boolean(turn.prompt_sent);
        const ended = { ...turn, ended: { at: new Date().toISOString(), how: 'observed ended' }, possibly_partial: partial, partial_reported_at: partial ? new Date().toISOString() : null };
        if (partial) {
          const text = `The ${turn.role} turn for pass ${turn.pass} was running when a relay stopped, and its process group has ended (${group.reason}): it may have run partly. Running the relay again repeats it, on your go; or answer in the conversation yourself.`;
          await reportTurn(ended, text);
          notes.push(text);
          stopReason = text;
        } else {
          current = await saveRelayState(laneDir, { ...current, turn: ended });
          notes.push(`The ${turn.role} turn for pass ${turn.pass} ended before its prompt was sent: no model turn ran.`);
        }
      } else {
        const listed = group.processes.map((row) => `${row.pid} ${row.command}`.trim()).join('; ');
        reserved = true;
        stopReason = `the ${turn.role} turn for pass ${turn.pass} from a stopped relay is ${group.state === 'active' ? 'still running' : 'uncertain'} (${group.reason}${listed ? `: ${listed}` : ''}). The lane and conversation stay reserved; the relay sends no signal. Let it finish, or stop those processes yourself, then run \`${commands.recover}\` again.`; // D-419 item 10
        notes.push(stopReason);
      }
    }
  }
  // A reviewer turn that ran its prompt and finished in a run that recorded no
  // stop, with no write from that same turn: the relay died between the turn
  // and its write. A write is bound to its turn by the turn's id, never by the
  // pass number, since a discarded write leaves the number unused. It is
  // reported, and the run is closed, so repeating it takes the owner's next go.
  const lastTurn = current.turn;
  const writeFromTurn = (turn) => Boolean(turn.id) && ((current.writes ?? []).some((item) => item.turn_id === turn.id) || current.write?.turn_id === turn.id);
  if (!stopReason && lastTurn?.role === 'reviewer' && lastTurn.ended && lastTurn.prompt_sent && !lastTurn.reported_at && current.run && !current.run.stopped && !writeFromTurn(lastTurn)) {
    const text = `the reviewer's turn for pass ${lastTurn.pass} finished (${lastTurn.ended.how}) in a relay that stopped before recording a pass from it, so no pass was written. Running the relay again repeats the pass, on your go.`;
    await reportTurn(lastTurn, text);
    notes.push(text);
    stopReason = text;
  }
  let stopKind = null;
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
    current = await saveRelayState(laneDir, { ...current, write: result.write, writes: [...(current.writes ?? []), { id: result.write.id, pass: result.write.pass, turn_id: result.write.turn_id ?? null, state: result.write.state, at: new Date().toISOString() }] });
    notes.push(describeWriteEnd(result.write));
    if (result.write.state === 'superseded' || result.write.state === 'discarded') {
      // As on the live path: this run stops, and any next turn is the owner's next run.
      stopReason = stopReason ?? describeWriteEnd(result.write);
      stopKind = result.write.state === 'discarded' ? 'fingerprint' : 'refusal';
    }
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
  return { state: current, summary: notes.join(' '), stopReason, stopKind, reserved, choices };
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
    ctx.stopMark.paths = mark.paths ?? [];
    // The loop resumes the conversation the run started with; a newer mark
    // made in another conversation, or from a plain shell, stops it before any
    // turn, so a finding never goes to a conversation the mark doesn't name.
    if (mode === 'loop' && markConversation(mark) !== ctx.conversationId) {
      const named = markConversation(mark);
      throw new RelayStop('conversation', `the ready-for-review mark (round ${shortRound(mark.round_id)}) now ${named ? `names Claude Code conversation ${named}` : 'names no Claude Code conversation (it was made from a shell)'}, not ${ctx.conversationId}, which this run resumes. Nothing was sent to either.`, {
        choices: named
          ? [`run \`${ctx.commands.relay()}\` again to continue with conversation ${named}: the relay asks you to confirm it is closed`, `run \`${ctx.commands.relay(['--one-pass'])}\` for one pass, and answer in the builder's window`]
          : [`run \`${ctx.commands.relay()}\` again for one pass, and answer in the builder's window`, `have the builder mark ready again from its Claude Code conversation, then run \`${ctx.commands.relay()}\` again for the loop`],
      });
    }
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
      // The owner's Enter comes right before each builder turn, after a fresh
      // pass and after a restart or recovery alike.
      if (ctx.options.confirmEachRound) {
        if (typeof ctx.deps.confirm !== 'function') {
          throw new RelayStop('owner-pause', '--confirm-each-round needs a terminal for the owner\'s Enter.');
        }
        const answer = String(await ctx.deps.confirm(`Pass ${recorded.number} is recorded. Press Enter to send the builder its turn, or type anything else to stop here.`));
        if (answer.trim() !== '') {
          throw new RelayStop('owner-pause', `the owner stopped after pass ${recorded.number}, before the builder's turn.`);
        }
      }
      // A turn not sent because the lane changed meanwhile: the loop reads
      // the lane again.
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
  const gate = checkReviewerVersion({ tool: ctx.reviewerTool, version: version.ok ? version.version : null, platform: ctx.platform, supported: ctx.supported });
  if (!gate.ok) throw new RelayStop('unsupported', gate.message);
  // The pass is labelled with the version checked for this turn.
  ctx.reviewerVersion = version.version;

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
  const turnId = newId();
  await save({ step: 'reviewer-turn', round: { id: mark.round_id, fingerprints: mark.fingerprints }, turn: { id: turnId, role: 'reviewer', command: launch.command, pass: passNumber, pid: null, pgid: null, process_started_at: null, prompt_sent: false, started_at: new Date().toISOString(), ended: null }, answer: null });
  // A Claude Code reviewer's stream is checked as it arrives: a hook event, an
  // event before init, or an init outside what the reviewer may load ends the
  // group at once (D-419 item 5, D-421).
  let sawReviewerInit = false;
  const onLine = ctx.reviewerTool === 'claude'
    ? (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return null;
      }
      if (event?.type === 'system' && typeof event.subtype === 'string' && event.subtype.startsWith('hook')) {
        return checkClaudeReviewerStream({ hookEvents: [event], init: null });
      }
      if (sawReviewerInit) return null;
      if (event?.type === 'system' && event.subtype === 'init') {
        sawReviewerInit = true;
        return checkClaudeReviewerStream({ hookEvents: [], init: event });
      }
      return `the reviewer's stream had an event (${event?.type ?? 'unknown'}) before init`;
    }
    : () => null;
  const result = await runTurn({
    command: launch.command,
    args: launch.args,
    cwd: ctx.toolingRoot,
    // The turn's id rides in its environment, so recovery can tell its
    // processes from any other session's (D-419 item 10).
    env: { ...reviewerTurnEnv(ctx.env), [RELAY_TURN_MARKER]: turnId },
    input: prompt,
    timeoutMs: ctx.reviewerTimeoutMs,
    table,
    active,
    logPath,
    onLine,
    killGraceMs: ctx.killGraceMs,
    settleMs: ctx.settleMs,
    onSpawned: async ({ pid, pgid, startedAt }) => {
      if (ctx.deps.onTurnRecord) await ctx.deps.onTurnRecord({ stage: 'identity', role: 'reviewer' });
      await save({ turn: { ...ctx.getState().turn, pid, pgid, process_started_at: startedAt, prompt_sent: true } });
    },
  });
  if (result.spawnError) {
    await save({ turn: { ...ctx.getState().turn, ended: { at: new Date().toISOString(), how: 'never started' } } });
    throw new RelayStop('failure', `the reviewer couldn't start: ${result.spawnError}.`);
  }
  await settleTurnStart(ctx, 'reviewer', passNumber, result);
  const sent = result.promptSent;
  const partialReviewer = sent && Boolean(result.timedOut || result.interrupted || result.aborted);
  const ended = { at: new Date().toISOString(), how: turnEndHow(result), exit_code: result.code ?? null };
  await save({ turn: { ...ctx.getState().turn, prompt_sent: sent, ended, possibly_partial: partialReviewer, partial_reported_at: partialReviewer ? new Date().toISOString() : null } });
  const unsent = 'before its prompt was sent, so no model turn ran';
  if (result.interrupted) throw new RelayStop('owner-pause', sent ? 'Ctrl-C: the owner stopped the relay during the reviewer\'s turn; no pass was recorded.' : `Ctrl-C: the owner stopped the relay ${unsent}; no pass was recorded.`);
  if (result.timedOut) throw new RelayStop('timeout', sent ? `the reviewer's turn ran past ${formatMinutes(ctx.reviewerTimeoutMs)}; its process group was ended, and no pass was recorded.` : `the reviewer's turn reached its ${formatMinutes(ctx.reviewerTimeoutMs)} limit ${unsent}; its process group was ended, and no pass was recorded.`);
  if (result.aborted) throw new RelayStop('refusal', `${result.aborted}; the relay ended the turn${sent ? '' : ` ${unsent}`}, and its answer is discarded.`);

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
  // The write names the turn it came from, so recovery never takes another
  // turn's write for this one.
  write.turn_id = ctx.getState().turn?.id ?? null;
  await save({ step: 'write', write });
  const settled = await settleRelayWrite({
    rootDir,
    laneDir,
    write,
    recheck: makeRecheck({ rootDir, laneDir, worktrees: ctx.worktrees, paths: write.paths, projectRepos: ctx.projectRepos, env: ctx.env }),
    onStep: async (step) => {
      await save({ write: step });
    },
  });
  await save({ write: settled.write, writes: [...(ctx.getState().writes ?? []), { id: settled.write.id, pass: passNumber, turn_id: write.turn_id, state: settled.write.state, at: new Date().toISOString() }], step: 'running' });
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
  const gate = checkBuilderVersion({ version: version.ok ? version.version : null });
  if (!gate.ok) throw new RelayStop('unsupported', gate.message);

  const coveredRepos = await coveredRepositories(ctx, markBefore);
  const refsBefore = await remoteRefs(coveredRepos);
  const ghConfigDir = path.join(turnDir, 'gh-config-empty');
  await mkdir(ghConfigDir, { recursive: true });
  const launch = claudeBuilderLaunch({ conversationId: ctx.conversationId, mode: ctx.builderMode });
  const logPath = path.join(turnDir, `pass-${passNumber}-${ctx.runId}-builder.jsonl`);
  // After the owner's Enter and the checks above: the mark, its conversation,
  // and the findings waiting on this pass are read again. Anything changed,
  // and the loop looks at the lane afresh instead. The same check is made once
  // more right before the prompt goes out (below).
  const wipPath = path.join(laneDir, 'wip.md');
  const handoffPath = path.join(laneDir, 'handoff.md');
  let wipBefore = await readFile(wipPath, 'utf8');
  let parsedBefore = parseLog(wipBefore);
  const due = await builderTurnDue(ctx, passNumber, markBefore, parsedBefore, wipBefore);
  if (!due.ok) {
    out(`Not sending the builder its turn for pass ${passNumber}: ${due.reason}. Reading the lane again.`);
    return { sent: false };
  }
  let reviewerSectionBefore = readSectionBody(await readFile(handoffPath, 'utf8').catch(() => ''), REVIEWER_TO_BUILDER_HEADING);
  out(`Builder turn for pass ${passNumber}: resuming conversation ${ctx.conversationId} in ${ctx.builderMode} mode…`);
  const turnId = newId();
  await save({ step: 'builder-turn', turn: { id: turnId, role: 'builder', command: launch.command, pass: passNumber, pid: null, pgid: null, process_started_at: null, prompt_sent: false, started_at: new Date().toISOString(), ended: null } });

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
    env: { ...builderTurnEnv(ctx.env, { ghConfigDir, relayToken: ctx.token }), [RELAY_TURN_MARKER]: turnId },
    input: builderPrompt({ laneId, passNumber, rootDir: ctx.rootDir, paths: markBefore.paths ?? [] }),
    timeoutMs: ctx.builderTimeoutMs,
    table,
    active,
    logPath,
    onLine,
    killGraceMs: ctx.killGraceMs,
    settleMs: ctx.settleMs,
    onSpawned: async ({ pid, pgid, startedAt }) => {
      if (ctx.deps.onTurnRecord) await ctx.deps.onTurnRecord({ stage: 'identity', role: 'builder' });
      await save({ turn: { ...ctx.getState().turn, pid, pgid, process_started_at: startedAt, prompt_sent: true } });
    },
    // The last check, under the memory-root lock that ready-for-review writes
    // its mark under, with the prompt sent before the lock is let go: a new
    // mark lands either before this check, and the tool gets no prompt, or
    // after the prompt has gone.
    deliver: (send) => withMemoryRootLock(ctx.rootDir, 'review-relay', async () => {
      const wipNow = await readFile(wipPath, 'utf8');
      const parsedNow = parseLog(wipNow);
      const dueNow = await builderTurnDue(ctx, passNumber, markBefore, parsedNow, wipNow);
      if (!dueNow.ok) return dueNow.reason;
      const reviewerSectionNow = readSectionBody(await readFile(handoffPath, 'utf8').catch(() => ''), REVIEWER_TO_BUILDER_HEADING);
      if (!send()) return null;
      // What the turn is checked against afterwards is what it was sent on.
      wipBefore = wipNow;
      parsedBefore = parsedNow;
      reviewerSectionBefore = reviewerSectionNow;
      return null;
    }),
  });
  if (result.spawnError) {
    await save({ turn: { ...ctx.getState().turn, ended: { at: new Date().toISOString(), how: 'never started' } } });
    throw new RelayStop('failure', `the builder couldn't start: ${result.spawnError}.`);
  }
  await settleTurnStart(ctx, 'builder', passNumber, result);
  const sent = result.promptSent;
  const partial = sent && Boolean(result.timedOut || result.interrupted || result.aborted);
  const how = !sent && result.deliverError ? 'prompt not sent: the last check failed' : !sent && result.withheld ? 'prompt withheld' : turnEndHow(result);
  await save({ turn: { ...ctx.getState().turn, prompt_sent: sent, ended: { at: new Date().toISOString(), how, exit_code: result.code ?? null }, possibly_partial: partial, partial_reported_at: partial ? new Date().toISOString() : null } });
  const unsent = 'before its prompt was sent, so no model turn ran';
  if (result.interrupted) throw new RelayStop('owner-pause', sent ? 'Ctrl-C: the owner stopped the relay during the builder\'s turn, which may have run partly.' : `Ctrl-C: the owner stopped the relay ${unsent}.`);
  if (result.timedOut) throw new RelayStop('timeout', sent ? `the builder's turn ran past ${formatMinutes(ctx.builderTimeoutMs)}; its process group was ended, and the turn may have run partly.` : `the builder's turn reached its ${formatMinutes(ctx.builderTimeoutMs)} limit ${unsent}; its process group was ended.`);
  if (!sent && result.deliverError) {
    throw new RelayStop('failure', `the last check before the builder's prompt failed (${result.deliverError}), so its stdin was closed empty and no model turn ran. The relay doesn't try the turn again; run it again once the lane can be read and locked.`);
  }
  if (!sent && result.withheld) {
    out(`Not sending the builder its turn for pass ${passNumber}: ${result.withheld}. Its process got no prompt, so no model turn ran. Reading the lane again.`);
    return { sent: false };
  }
  if (result.aborted) throw new RelayStop('failure', `${result.aborted}; the relay ended the turn${sent ? ', which may have run partly' : ` ${unsent}`}.`);

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
  // The builder may only append its response to this pass: every earlier line
  // of the review log stays as it was (D-419 item 8).
  const logBefore = extractReviewLogLines(wipBefore).lines.map((line) => line.text);
  while (logBefore.length > 0 && logBefore.at(-1).trim() === '') logBefore.pop();
  const logAfter = extractReviewLogLines(wipAfter).lines.map((line) => line.text);
  if (logBefore.some((line, index) => logAfter[index] !== line)) {
    throw new RelayStop('refusal', 'the builder changed earlier lines of ## Review log during its turn; a relayed turn may only append its response.'); // D-419 item 8
  }
  // What it appends starts with its response line: an indented line before
  // it would join the reviewer's pass above, as a finding or as evidence.
  const firstAppended = logAfter.slice(logBefore.length).find((line) => line.trim() !== '');
  if (firstAppended !== undefined && !new RegExp(`^- response ${passNumber} \\|`).test(firstAppended)) {
    throw new RelayStop('refusal', `the builder appended to ## Review log before its response line (\`${firstAppended.trim().slice(0, 120)}\`); a relayed turn's lines start with \`- response ${passNumber} |\`, and every line it adds is part of that response.`); // D-419 item 8
  }
  const added = parsedAfter.records.slice(parsedBefore.records.length);
  if (added.length > 1 || added.some((record) => !(record.kind === 'response' && record.number === passNumber))) {
    throw new RelayStop('refusal', `the builder added a record other than its response to pass ${passNumber} during its turn (${added.map((record) => `${record.kind} ${record.number ?? ''}`.trim()).join(', ')}).`); // D-419 item 8
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
  return { sent: true };
}

/**
 * Whether the builder's turn for `passNumber` is still due, as the loop saw it
 * before the owner's Enter: the same mark, naming this run's conversation, and
 * that pass on its round with findings still waiting for the builder. These
 * are the loop's own conditions, so a turn found not due is never chosen
 * again from the same lane.
 */
async function builderTurnDue(ctx, passNumber, markBefore, parsed, wip) {
  // An unreadable mark throws: a failed read is an error, never a change.
  const mark = await readReadyMark(ctx.laneDir);
  if (!mark) return { ok: false, reason: 'the ready-for-review mark is gone' };
  if (mark.round_id !== markBefore.round_id || mark.marked_at !== markBefore.marked_at) {
    return { ok: false, reason: `the ready-for-review mark changed (now round ${shortRound(mark.round_id)})` };
  }
  if (markConversation(mark) !== ctx.conversationId) return { ok: false, reason: 'the mark names another conversation' };
  if (!parsed.ok) return { ok: false, reason: 'the review log no longer parses' };
  if (passOnRound(parsed, mark.round_id)?.number !== passNumber) return { ok: false, reason: `pass ${passNumber} is no longer the pass on this round` };
  if (findingsWaitingForBuilder(wip).waiting.length === 0) return { ok: false, reason: 'no finding waits for the builder' };
  return { ok: true };
}

/**
 * The git repositories a mark covers: the lane's worktrees, each named path's
 * repository, and every checkout the work fingerprint reads, checked-out
 * submodules included at any depth (D-423 item 2).
 */
export async function coveredRepositories(ctx, mark) {
  const dirs = new Set(Object.values(ctx.worktrees).map((dir) => path.resolve(dir)));
  for (const spec of mark.paths ?? []) {
    let resolved;
    try {
      resolved = resolveMarkPath(spec, { rootDir: ctx.rootDir, projectRepos: ctx.projectRepos, worktrees: ctx.worktrees });
    } catch {
      // A path that can't be resolved covers no repository.
      continue;
    }
    const kind = await stat(resolved.absolute).then((info) => (info.isDirectory() ? 'directory' : 'file')).catch(() => 'missing');
    const start = kind === 'directory' ? resolved.absolute : kind === 'file' ? path.dirname(resolved.absolute) : resolved.base;
    // A path inside a repository git can't read stops the relay (D-423 item 3).
    let top;
    try {
      top = await repositoryTopLevel(start, ctx.env);
    } catch (error) {
      throw new RelayStop('failure', error instanceof Error ? error.message : String(error));
    }
    if (top) dirs.add(top);
  }
  let work;
  try {
    work = await fingerprintWork({ rootDir: ctx.rootDir, laneDir: ctx.laneDir, worktrees: ctx.worktrees, paths: mark.paths ?? [], projectRepos: ctx.projectRepos, env: ctx.env });
  } catch (error) {
    throw new RelayStop('failure', `the work's repositories couldn't be listed for the remote-ref check: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const dir of work.repositories) dirs.add(dir);
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
