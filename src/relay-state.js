import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RELAY_LOCK_FILE, RELAY_STATE_FILE, isConversationId, writeFileAtomic } from './relay-mark.js';
import { relayCommand } from './relay-adapters.js';
import { withMemoryRootLock } from './serialization.js';

// D-419 item 10: the relay's state, its two locks, and what a restarted relay
// or close-session can tell about a turn that was running when a relay died.
// State is recorded before each step it starts (D-281), replaced whole, and
// lives in the lane folder, so it goes at close (D-278). A restarted relay only
// inspects processes: it never signals a group recovered from disk.

export const RELAY_STATE_FORMAT = 1;
export const WRITE_END_STATES = new Set(['complete', 'superseded', 'discarded']);

// ---------------------------------------------------------------------------
// Processes

function parseProcessTable(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 7) continue;
    const pid = Number(tokens[0]);
    const pgid = Number(tokens[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(pgid)) continue;
    rows.push({ pid, pgid, startedAt: tokens.slice(2, 7).join(' '), command: tokens.slice(7).join(' ') });
  }
  return rows;
}

/**
 * The operating system's process table, read with `ps`. Injectable so tests
 * can stand in a table and count signals; the default never signals anything
 * but the live relay's own groups (`killGroup`).
 */
export function createProcessTable({ exec = execFile } = {}) {
  return {
    list() {
      return new Promise((resolve, reject) => {
        exec('ps', ['-A', '-o', 'pid=,pgid=,lstart=,command='], { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(parseProcessTable(String(stdout)));
        });
      });
    },
    // Each process as `list` gives it, with its environment after its
    // command line (macOS `ps -E`). macOS shows the environment of the
    // owner's own processes, but not of system programs such as /bin/sh.
    listEnvironments() {
      return new Promise((resolve, reject) => {
        exec('ps', ['-A', '-wwE', '-o', 'pid=,pgid=,lstart=,command='], { maxBuffer: 256 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(parseProcessTable(String(stdout)).map(({ command, ...row }) => ({ ...row, text: command })));
        });
      });
    },
    killGroup(pgid, signal = 'SIGTERM') {
      try {
        process.kill(-pgid, signal);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * The variable each relayed turn's environment carries, set to the turn's id
 * in relay.json, so recovery can tell that turn's processes from any other
 * session's (D-419 item 10).
 */
export const RELAY_TURN_MARKER = 'VIBECOMPASS_RELAY_TURN_ID';

/**
 * The running processes whose environment carries a turn's marker, from two
 * reads of the process table: one with each command line alone, one with the
 * environment after it. A process counts as the turn's (`verified`) only when
 * both reads show it with the same group and start time, the second read's
 * line is the first's with the environment after it, and the marker is an
 * entry of that environment. A process whose line names the marker where the
 * environment can't be told apart from its arguments (macOS shows no
 * environment for a system program such as /bin/sh), or that changed between
 * the reads, is `ambiguous`: it keeps a reservation but isn't called the
 * turn's. One whose environment is shown without the marker isn't the turn's,
 * whatever its arguments say. Resolves `{ ok, reason, verified, ambiguous }`;
 * `ok` is false when the table can't be read with environments.
 */
export async function findMarkedProcesses(table, marker) {
  const none = { verified: [], ambiguous: [] };
  if (!marker) return { ok: false, reason: 'the turn recorded no id to look for', ...none };
  if (typeof table.listEnvironments !== 'function') return { ok: false, reason: 'this process table shows no environments', ...none };
  let withEnvironment;
  let plain;
  try {
    withEnvironment = await table.listEnvironments();
    plain = await table.list();
  } catch (error) {
    return { ok: false, reason: `ps couldn't list the processes (${error instanceof Error ? error.message : String(error)})`, ...none };
  }
  const needle = `${RELAY_TURN_MARKER}=${marker}`;
  const byPid = new Map(plain.map((row) => [row.pid, row]));
  const verified = [];
  const ambiguous = [];
  for (const row of withEnvironment) {
    if (!row.text.split(' ').includes(needle)) continue;
    const seen = byPid.get(row.pid);
    const shown = { pid: row.pid, pgid: row.pgid, command: String(seen?.command ?? '').slice(0, 200) };
    if (!seen || seen.pgid !== row.pgid || seen.startedAt !== row.startedAt || !row.text.startsWith(`${seen.command} `)) {
      ambiguous.push(shown);
      continue;
    }
    if (row.text.slice(seen.command.length + 1).split(' ').includes(needle)) verified.push(shown);
  }
  return { ok: true, reason: null, verified, ambiguous };
}

export async function processStartTime(table, pid) {
  const rows = await table.list();
  return rows.find((row) => row.pid === pid)?.startedAt ?? null;
}

/**
 * What became of a recorded process group (D-419 item 10):
 * - `ended`: no process is in the group, or a different process (another
 *   start time) holds the leader's process id; POSIX doesn't reuse a process
 *   id while a group with that id has a member;
 * - `active`: the recorded leader still runs;
 * - `uncertain`: members remain without the leader, or the table can't be read.
 */
export async function inspectProcessGroup(table, { pgid, pid, startedAt }) {
  let rows;
  try {
    rows = await table.list();
  } catch (error) {
    return { state: 'uncertain', processes: [], reason: `the process table couldn't be read (${error instanceof Error ? error.message : String(error)})` };
  }
  const members = rows.filter((row) => row.pgid === pgid);
  const leader = rows.find((row) => row.pid === pid);
  if (leader && startedAt && leader.startedAt !== startedAt) {
    return { state: 'ended', processes: [], reason: 'another process now holds the leader\'s process id' };
  }
  if (members.length === 0) {
    return { state: 'ended', processes: [], reason: 'no process is left in the group' };
  }
  if (leader && leader.pgid === pgid && (!startedAt || leader.startedAt === startedAt)) {
    return { state: 'active', processes: members, reason: 'the turn\'s process is still running' };
  }
  return { state: 'uncertain', processes: members, reason: 'processes remain in the group without its leader, so they can\'t be told from a reused group' };
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** Whether a lock's recorded process is the one still running. */
export async function lockHolderAlive(table, record) {
  if (!record || !isAlive(record.pid)) return false;
  if (!record.process_started_at) return true;
  try {
    return (await processStartTime(table, record.pid)) === record.process_started_at;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// relay.json

export function relayStatePath(laneDir) {
  return path.join(laneDir, RELAY_STATE_FILE);
}

export async function readRelayState(laneDir) {
  let source;
  try {
    source = await readFile(relayStatePath(laneDir), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const state = JSON.parse(source);
    if (!state || typeof state !== 'object' || state.format !== RELAY_STATE_FORMAT) {
      throw new Error('not a relay state this package reads');
    }
    return state;
  } catch (error) {
    const wrapped = new Error(`${relayStatePath(laneDir)} can't be read (${error instanceof Error ? error.message : String(error)}).`);
    wrapped.unreadable = true;
    throw wrapped;
  }
}

export async function saveRelayState(laneDir, state) {
  const next = { ...state, format: RELAY_STATE_FORMAT, updated_at: new Date().toISOString() };
  await writeFileAtomic(relayStatePath(laneDir), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function emptyRelayState(laneId) {
  return {
    format: RELAY_STATE_FORMAT,
    lane: laneId,
    run: null,
    step: 'idle',
    round: null,
    reviewer: null,
    builder: null,
    turn: null,
    answer: null,
    write: null,
    writes: [],
    last_stop: null,
    conversation_lock: null,
  };
}

/** A turn counts as running until its end is recorded. */
export function turnUnfinished(state) {
  return Boolean(state?.turn && !state.turn.ended);
}

export function writeUnfinished(state) {
  return Boolean(state?.write && !WRITE_END_STATES.has(state.write.state));
}

// ---------------------------------------------------------------------------
// Locks

async function createExclusive(filePath, record) {
  const handle = await open(filePath, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
}

async function readLockRecord(filePath) {
  let source;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { missing: true };
    return { unreadable: true, error };
  }
  try {
    const record = JSON.parse(source);
    if (!record || typeof record !== 'object') throw new Error('not an object');
    return { record };
  } catch (error) {
    return { unreadable: true, error };
  }
}

/**
 * Takes over a dead holder's lock: the old file is renamed aside, then the
 * new lock is created exclusively. Callers serialize takeovers (the
 * memory-root lock for a lane, the takeover mutex for a conversation) and
 * read the dead holder's record inside that serialization, so a second taker
 * reads the first one's live lock instead of renaming it away.
 */
async function takeOver(filePath, record) {
  const aside = `${filePath}.stale-${randomUUID()}`;
  await rename(filePath, aside);
  try {
    await createExclusive(filePath, record);
  } finally {
    await rm(aside, { force: true });
  }
}

/**
 * The lane lock, `sessions/active/<lane-id>/relay.lock`: one relay per lane.
 * It is taken under the memory-root lock, which close-session holds from its
 * relay check through the lane's removal, so a relay is admitted only to a
 * lane that is still open and close never removes a lane a relay was just
 * admitted to. The same lock serializes two relays taking over one dead
 * holder's lock: the second reads the first's live lock and refuses. A dead
 * holder's lock is taken over with a message; a live one refuses.
 * `beforeTakeOver` is a test hook.
 */
export async function acquireLaneLock({ laneDir, laneId, runId, token, table, rootDir = path.resolve(laneDir, '..', '..', '..'), beforeTakeOver = null }) {
  const filePath = path.join(laneDir, RELAY_LOCK_FILE);
  const record = { lane: laneId, run_id: runId, token, pid: process.pid, process_started_at: await processStartTime(table, process.pid).catch(() => null), at: new Date().toISOString() };
  return withMemoryRootLock(rootDir, 'review-relay', async () => {
    if (!(await laneStillOpen(laneDir))) {
      throw new Error(`Lane ${laneId} is no longer open (sessions/active/${laneId}/session.yaml is gone); the relay runs only on an open lane.`); // D-419 item 10
    }
    try {
      await createExclusive(filePath, record);
      return { filePath, record, tookOver: null };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const existing = await readLockRecord(filePath);
    if (existing.missing) {
      await createExclusive(filePath, record);
      return { filePath, record, tookOver: null };
    }
    if (existing.unreadable) {
      throw new Error(`${filePath} exists but can't be read, so another relay may hold lane ${laneId}. If no relay is running, move it aside and run again.`);
    }
    if (await lockHolderAlive(table, existing.record)) {
      throw new Error(`Another relay is running on lane ${laneId} (process ${existing.record.pid}, run ${existing.record.run_id}). One relay runs per lane.`); // D-419 item 10
    }
    if (beforeTakeOver) await beforeTakeOver();
    await takeOver(filePath, record);
    return { filePath, record, tookOver: existing.record };
  });
}

async function laneStillOpen(laneDir) {
  try {
    await stat(path.join(laneDir, 'session.yaml'));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

const TAKEOVER_MUTEX = '.takeover';
const TAKEOVER_WAIT_MS = 2_000;

/**
 * The conversation locks' takeover mutex, a folder in the per-user lock
 * folder, so takeovers of one conversation's lock are serialized across
 * memory roots. It is held only while a dead holder's record is read again
 * and replaced. A mutex left by a process that died inside that step is never
 * reclaimed automatically: the message names it, and the owner removes it.
 */
async function withTakeoverMutex(dir, table, fn, { waitMs = TAKEOVER_WAIT_MS } = {}) {
  const mutexPath = path.join(dir, TAKEOVER_MUTEX);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await mkdir(mutexPath);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    if (Date.now() >= deadline) {
      const owner = await readLockRecord(path.join(mutexPath, 'owner.json'));
      const alive = owner.record ? await lockHolderAlive(table, owner.record) : false;
      throw new Error(alive
        ? `Another relay is taking over a conversation lock (${mutexPath}); run again in a moment.`
        : `An earlier takeover of a conversation lock didn't finish (${mutexPath}). If no review relay is running, remove that folder and run again.`); // D-419 item 10
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    await writeFile(path.join(mutexPath, 'owner.json'), `${JSON.stringify({ pid: process.pid, process_started_at: await processStartTime(table, process.pid).catch(() => null), at: new Date().toISOString() })}\n`, 'utf8');
    return await fn();
  } finally {
    await rm(mutexPath, { recursive: true, force: true });
  }
}

export async function releaseLaneLock(lock) {
  if (!lock) return;
  const existing = await readLockRecord(lock.filePath);
  if (existing.record?.token === lock.record.token) {
    await rm(lock.filePath, { force: true });
  }
}

/**
 * The per-user conversation lock's folder: `.config/vibecompass/relay-locks/`
 * under the home folder the user record names, which no environment variable
 * moves (D-419 item 10).
 */
export function conversationLockDir(userInfo = os.userInfo()) {
  return path.join(userInfo.homedir, '.config', 'vibecompass', 'relay-locks');
}

export function conversationLockPath(conversationId, userInfo) {
  if (!isConversationId(conversationId)) {
    throw new Error(`"${conversationId}" is not a conversation id the relay accepts.`);
  }
  return path.join(conversationLockDir(userInfo), `${conversationId}.json`);
}

/**
 * Whether a dead run's conversation lock may be taken over: only once that
 * run's recorded turn is finished, or its lane has closed. A record that can't
 * be read keeps the lock.
 */
async function deadConversationLockReleasable(record) {
  if (typeof record.root !== 'string' || typeof record.lane !== 'string') {
    return { ok: false, reason: 'its record names no lane' };
  }
  const laneDir = path.join(record.root, 'sessions', 'active', record.lane);
  try {
    await stat(laneDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, reason: `lane ${record.lane} has closed` };
    return { ok: false, reason: `lane ${record.lane} can't be read` };
  }
  let state;
  try {
    state = await readRelayState(laneDir);
  } catch {
    return { ok: false, reason: `lane ${record.lane}'s relay state can't be read` };
  }
  if (state && state.run?.id === record.run_id && turnUnfinished(state)) {
    return { ok: false, reason: `run ${record.run_id} on lane ${record.lane} left a turn unfinished; run \`${relayCommand({ laneId: record.lane, rootDir: record.root }, ['--recover'])}\` there` };
  }
  return { ok: true, reason: `run ${record.run_id} on lane ${record.lane} has ended` };
}

export async function acquireConversationLock({ conversationId, rootDir, laneId, runId, token, table, userInfo, beforeTakeOver = null }) {
  const filePath = conversationLockPath(conversationId, userInfo);
  await mkdir(path.dirname(filePath), { recursive: true });
  const record = {
    conversation_id: conversationId,
    root: path.resolve(rootDir),
    lane: laneId,
    run_id: runId,
    token,
    pid: process.pid,
    process_started_at: await processStartTime(table, process.pid).catch(() => null),
    at: new Date().toISOString(),
  };
  try {
    await createExclusive(filePath, record);
    return { filePath, record, tookOver: null };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  // Every reading of an existing holder, and any takeover, happens under the
  // takeover mutex (D-419 item 10).
  return withTakeoverMutex(path.dirname(filePath), table, async () => {
    const existing = await readLockRecord(filePath);
    if (existing.missing) {
      await createExclusive(filePath, record);
      return { filePath, record, tookOver: null };
    }
    if (existing.unreadable) {
      throw new Error(`Conversation ${conversationId} is locked by a record that can't be read (${filePath}); the lock is kept. If no relay uses the conversation, move it aside and run again.`); // D-419 item 10
    }
    const held = existing.record;
    if (await lockHolderAlive(table, held)) {
      throw new Error(`Conversation ${conversationId} is in use by another relay: lane ${held.lane} in ${held.root}, run ${held.run_id}. One relay runs per conversation.`); // D-419 item 10
    }
    // The same run's own lock (a restart) is ours to reuse once its turn is settled.
    const releasable = await deadConversationLockReleasable(held);
    if (!releasable.ok) {
      throw new Error(`Conversation ${conversationId} is still reserved: ${releasable.reason}.`);
    }
    if (beforeTakeOver) await beforeTakeOver();
    await takeOver(filePath, record);
    return { filePath, record, tookOver: { ...held, reason: releasable.reason } };
  });
}

export async function releaseConversationLock(lock) {
  if (!lock) return;
  const existing = await readLockRecord(lock.filePath);
  if (existing.record?.token === lock.record.token) {
    await rm(lock.filePath, { force: true });
  }
}

/**
 * At close: a conversation lock whose record names this root and lane goes
 * with the lane (D-278). Close refuses earlier while a live relay holds it.
 * The file is found from the conversation id the relay recorded, in the OS
 * user's lock folder, never from a stored path: a recorded path anywhere
 * else is left alone, and so is a lock whose record names another
 * conversation, lane, or root.
 */
export async function removeConversationLockForLane({ state, rootDir, laneId, userInfo, table = createProcessTable(), beforeRemove = null }) {
  const conversationId = state?.builder?.conversation_id;
  if (!state?.conversation_lock || !isConversationId(conversationId)) return null;
  const expected = conversationLockPath(conversationId, userInfo);
  const recorded = state.conversation_lock.path;
  if (typeof recorded !== 'string' || path.resolve(recorded) !== path.resolve(expected)) return null;
  // Read and removed under the takeover mutex, so another root's takeover
  // can't replace the lock between the check and the removal.
  return withTakeoverMutex(path.dirname(expected), table, async () => {
    const existing = await readLockRecord(expected);
    if (existing.record
      && existing.record.conversation_id === conversationId
      && existing.record.lane === laneId
      && path.resolve(existing.record.root ?? '') === path.resolve(rootDir)) {
      if (beforeRemove) await beforeRemove();
      await rm(expected, { force: true });
      return expected;
    }
    return null;
  });
}

// ---------------------------------------------------------------------------
// What the stage and close-session read

/**
 * The relay's state as the stage reads it: whether a relay holds the lane, the
 * step it is on, anything unfinished, and the last stop.
 */
export async function readRelayView(laneDir, { table = createProcessTable() } = {}) {
  let state;
  try {
    state = await readRelayState(laneDir);
  } catch {
    return { live: false, step: null, unfinished: 'the relay state can\'t be read', lastStop: null };
  }
  const lock = await readLockRecord(path.join(laneDir, RELAY_LOCK_FILE));
  const live = Boolean(lock.record) && (await lockHolderAlive(table, lock.record));
  if (!state) {
    return { live, step: live ? 'starting' : null, unfinished: null, lastStop: null };
  }
  let unfinished = null;
  if (!live && turnUnfinished(state)) {
    unfinished = 'a relay stopped during a turn; run review-relay --recover';
  } else if (!live && writeUnfinished(state)) {
    unfinished = 'a relayed write has no end state; run review-relay --recover';
  }
  return { live, step: state.step, unfinished, lastStop: state.last_stop ?? null };
}

/**
 * close-session's refusal (D-419 item 10): while a live relay holds the lane,
 * while an interrupted turn's group is active or uncertain, or while a write
 * has no end state. Null when the lane has no relay state or nothing is
 * unfinished, so a lane that never ran the relay closes as before.
 */
export async function inspectRelayForClose({ laneDir, laneId, table = createProcessTable() }) {
  const recover = relayCommand({ laneId, rootDir: path.resolve(laneDir, '..', '..', '..') }, ['--recover']);
  const lock = await readLockRecord(path.join(laneDir, RELAY_LOCK_FILE));
  if (lock.unreadable) {
    return `close-session is refused: ${path.join(laneDir, RELAY_LOCK_FILE)} can't be read, so a relay may hold lane ${laneId}. If no relay is running, move it aside and close again.`;
  }
  if (lock.record && (await lockHolderAlive(table, lock.record))) {
    return `close-session is refused: a review relay is running on lane ${laneId} (process ${lock.record.pid}, run ${lock.record.run_id}). Let it stop, or stop it with Ctrl-C, then close.`; // D-419 item 10
  }
  let state;
  try {
    state = await readRelayState(laneDir);
  } catch (error) {
    return `close-session is refused: ${error.message} It records whether a relayed write finished; run \`${recover}\`, or move the file aside to close without it.`;
  }
  if (!state) return null;
  if (turnUnfinished(state) && !state.turn.pgid) {
    // A turn recorded before its process started and never with it: the
    // group can't be inspected, so only the owner can settle it.
    const since = state.turn.started_at ? new Date(state.turn.started_at).toString() : 'an unknown time';
    return `close-session is refused: the relay's ${state.turn.role} turn on lane ${laneId}, started ${since}, was never recorded with its process, so its process group can't be inspected. Run \`${recover}\` in a terminal: it looks for the turn's own processes by the id in their environment, and with none found asks you to settle the turn.`; // D-419 item 10
  }
  if (turnUnfinished(state) && state.turn.pgid) {
    const group = await inspectProcessGroup(table, { pgid: state.turn.pgid, pid: state.turn.pid, startedAt: state.turn.process_started_at });
    if (group.state !== 'ended') {
      const listed = group.processes.map((row) => `${row.pid} ${row.command}`.trim()).join('; ');
      return `close-session is refused: the relay's ${state.turn.role} turn on lane ${laneId} is ${group.state === 'active' ? 'still running' : 'uncertain'} (${group.reason}${listed ? `: ${listed}` : ''}). Let it finish or stop those processes, then run \`${recover}\`.`; // D-419 item 10
    }
  }
  if (writeUnfinished(state)) {
    return `close-session is refused: relay write ${state.write.id} on lane ${laneId} has no end state. Run \`${recover}\` to finish it.`; // D-419 items 6 and 10
  }
  return null;
}
