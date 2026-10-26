import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Single-machine serialization tier for shared project-memory writers (D-276).
 *
 * Three layers cooperate so every package-owned writer of shared memory runs
 * one at a time per root:
 * - an on-disk mkdir-as-mutex lock directory under `state/` serializes across
 *   processes (mkdir without `recursive` is atomic on APFS/ext4)
 * - an in-process promise queue serializes concurrent async callers inside one
 *   process, where the disk lock alone cannot arbitrate
 * - AsyncLocalStorage tracks held roots so nested calls inside a lock holder
 *   re-enter instead of deadlocking (e.g. close-session refreshing the
 *   manifest, which is itself lock-wrapped)
 *
 * Every command takes the disk lock, on an uninitialized root too: a locked
 * command can create a root there (bootstrap, or apply-export from an external
 * bundle), so skipping the lock would let two of them validate the same
 * missing files and both write. The lock leaves nothing behind (PC1): at
 * release it removes the directories it created to hold itself (state/, and
 * the root when it was missing) while they are still empty, and a root the
 * lock created still counts as missing to the command
 * (`memoryRootCreatedByLock`).
 *
 * This tier is intentionally local-only. Cross-machine serialization belongs
 * to git merge (local-primary teams) or the hosted database (hosted-only);
 * no distributed locking is ever built on top of this file.
 */

const LOCK_DIR_NAME = 'memory-root.lock';
const OWNER_FILE_NAME = 'owner.json';
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_ATTEMPTS = 120;
const RETRY_BASE_DELAY_MS = 25;
const RETRY_MAX_DELAY_MS = 100;

// Held root key -> { createdRoot }: whether this lock made the root directory.
const heldRoots = new AsyncLocalStorage();
const processQueues = new Map();

export class MemoryRootLockError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MemoryRootLockError';
  }
}

export function memoryRootLockPath(rootDir) {
  return path.join(path.resolve(rootDir), 'state', LOCK_DIR_NAME);
}

/**
 * Runs `fn` while holding the serialization lock for `rootDir`. Reentrant:
 * a nested call from inside the lock holder runs immediately.
 */
// Commands that stay allowed on a promoted root: the transition flows
// themselves, plus recovery tooling that must be able to repair state.
const PROMOTED_ROOT_ALLOWED_COMMANDS = new Set([
  'promote-hosted',
  'demote-hosted',
  'bootstrap',
]);

async function assertNotPromotedRoot(rootDir, label) {
  if (PROMOTED_ROOT_ALLOWED_COMMANDS.has(label)) return;
  if (process.env.VIBECOMPASS_ALLOW_PROMOTED_ROOT_WRITES === '1') return;
  const markerPath = path.join(rootDir, 'state', 'promoted-root.json');
  let marker;
  try {
    marker = JSON.parse(await readFile(markerPath, 'utf8'));
  } catch {
    return;
  }
  throw new Error(
    `This root was promoted to hosted-only${marker?.promoted_at ? ` on ${marker.promoted_at}` : ''}: the hosted app is canonical and local writes here can never sync back. ` // D-288
    + 'Make changes on the hosted dashboard, run vibecompass demote-hosted to make this root canonical again, '
    + 'or set VIBECOMPASS_ALLOW_PROMOTED_ROOT_WRITES=1 to override deliberately.',
  );
}

export async function withMemoryRootLock(rootDir, label, fn, options = {}) {
  await assertNotPromotedRoot(rootDir, label);
  const key = await canonicalizeMemoryRootKey(rootDir);
  const held = heldRoots.getStore();
  if (await findHeldMemoryRootKey(held, key)) {
    return fn();
  }

  const previous = processQueues.get(key) ?? Promise.resolve();
  let releaseQueue;
  const queueSlot = new Promise((resolve) => {
    releaseQueue = resolve;
  });
  processQueues.set(key, previous.then(() => queueSlot));
  await previous;

  try {
    const lock = await acquireDiskLock(key, label, options);
    try {
      const nextHeld = new Map(held ?? []);
      nextHeld.set(key, { createdRoot: lock.createdRoot });
      return await heldRoots.run(nextHeld, fn);
    } finally {
      await releaseDiskLock(key, lock.ownerToken);
      await removeLockCreatedDirectories(key, lock.created);
    }
  } finally {
    releaseQueue();
    if (processQueues.get(key) === queueSlot) {
      processQueues.delete(key);
    }
  }
}

/**
 * Whether `rootDir` exists only because the lock this caller holds made it
 * (PC1): the root was missing when the command started and still holds
 * nothing but the lock, so a command that requires an existing root reports
 * it missing instead of reading the lock's own directory as one. Once the
 * command writes into it (bootstrap), it is a root in its own right. False
 * outside a lock holder.
 */
export async function memoryRootCreatedByLock(rootDir) {
  const held = heldRoots.getStore();
  if (!held) {
    return false;
  }
  const heldKey = await findHeldMemoryRootKey(held, await canonicalizeMemoryRootKey(rootDir));
  if (!heldKey || !held.get(heldKey).createdRoot) {
    return false;
  }
  try {
    const rootEntries = await readdir(heldKey);
    const stateEntries = await readdir(path.dirname(memoryRootLockPath(heldKey)));
    return rootEntries.every((entry) => entry === 'state') && stateEntries.every((entry) => entry.startsWith(LOCK_DIR_NAME));
  } catch {
    return false;
  }
}

/**
 * Removes the directories acquisition created (state/, then the root and any
 * missing parents up to `created`) while each is still empty (PC1). A command
 * that wrote memory there, or another holder's lock, keeps a directory
 * non-empty, so it stays. Two commands racing on the same missing root can
 * leave an empty directory when the second found it already made; it never
 * holds memory.
 */
async function removeLockCreatedDirectories(key, created) {
  if (!created) {
    return;
  }
  const top = path.resolve(created);
  for (let dir = path.dirname(memoryRootLockPath(key)); ; dir = path.dirname(dir)) {
    try {
      await rmdir(dir);
    } catch {
      return;
    }
    if (dir === top || path.dirname(dir) === dir) {
      return;
    }
  }
}

async function canonicalizeMemoryRootKey(rootDir) {
  const resolved = path.resolve(rootDir);
  try {
    return await realpath(resolved);
  } catch {
    try {
      return path.join(await realpath(path.dirname(resolved)), path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}

async function findHeldMemoryRootKey(held, key) {
  if (!held) {
    return null;
  }

  if (held.has(key)) {
    return key;
  }

  for (const heldKey of held.keys()) {
    if (await memoryRootKeysReferToSamePath(heldKey, key)) {
      return heldKey;
    }
  }

  return null;
}

async function memoryRootKeysReferToSamePath(left, right) {
  try {
    return (await realpath(left)) === (await realpath(right));
  } catch {
    return false;
  }
}

async function acquireDiskLock(key, label, options) {
  const lockDir = memoryRootLockPath(key);
  const stateDir = path.dirname(lockDir);
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  // The topmost directory this acquisition created, if any (mkdir reports it).
  let created = await mkdir(stateDir, { recursive: true });

  for (let attempt = 1; ; attempt += 1) {
    const ownerToken = randomUUID();
    try {
      await mkdir(lockDir);
      await writeFile(
        path.join(lockDir, OWNER_FILE_NAME),
        `${JSON.stringify({ pid: process.pid, token: ownerToken, label, acquired_at: new Date().toISOString() })}\n`,
        'utf8',
      );
      return {
        ownerToken,
        created,
        createdRoot: Boolean(created) && path.resolve(created) !== path.resolve(stateDir),
      };
    } catch (error) {
      if (error?.code === 'ENOENT') {
        // A releasing holder removed the state/ (or root) it had created; make
        // it again, and remove it at release in turn.
        created = topmostDirectory(created, await mkdir(stateDir, { recursive: true }));
      } else if (error?.code !== 'EEXIST') {
        throw error;
      }
    }

    if (await isAbandonedLock(lockDir, staleMs)) {
      await reclaimAbandonedLock(lockDir);
      continue;
    }

    if (attempt >= attempts) {
      const owner = await readLockOwner(lockDir);
      const ownerText = owner
        ? `held by live pid ${owner.pid ?? 'unknown'} (${owner.label ?? 'unknown command'}) since ${owner.acquired_at ?? 'unknown'}`
        : 'owner unreadable';
      throw new MemoryRootLockError(
        `Timed out waiting for the project-memory lock at ${lockDir} — ${ownerText}. ` +
          'Locks held by a live process are never stolen, however long they run. ' +
          'If no other vibecompass command is running against this root, remove the lock directory and retry.',
      );
    }

    await delay(RETRY_BASE_DELAY_MS + Math.floor(Math.random() * RETRY_MAX_DELAY_MS));
  }
}

function topmostDirectory(left, right) {
  if (!left || !right) {
    return left ?? right;
  }
  return path.resolve(left).length <= path.resolve(right).length ? left : right;
}

/**
 * A lock is abandoned only when its owner process is provably gone (dead PID),
 * or the owner file never became readable within the grace window (a crash
 * between mkdir and the owner write). A lock held by a live process is NEVER
 * treated as stale, regardless of age — long-running holders time out waiters
 * with an actionable error instead of being silently stolen.
 */
async function isAbandonedLock(lockDir, staleMs) {
  const owner = await readLockOwner(lockDir);

  if (owner && Number.isInteger(owner.pid)) {
    return !isProcessAlive(owner.pid);
  }

  try {
    const stats = await stat(lockDir);
    return Date.now() - stats.mtimeMs > staleMs;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Reclaims an abandoned lock via atomic rename so racing waiters cannot
 * double-free: exactly one contender wins the rename and deletes the moved
 * directory; the others see ENOENT and simply retry the mkdir claim. This can
 * never delete a freshly acquired lock, because a new claim creates a new
 * directory at the original path rather than reusing the renamed one.
 */
async function reclaimAbandonedLock(lockDir) {
  const reclaimPath = `${lockDir}.reclaim-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockDir, reclaimPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  await rm(reclaimPath, { recursive: true, force: true });
}

/**
 * Releases only a lock this caller still owns (token compare), so a holder
 * whose lock was reclaimed after a crash-recovery cannot delete a successor's
 * live lock.
 */
async function releaseDiskLock(key, ownerToken) {
  const lockDir = memoryRootLockPath(key);
  const owner = await readLockOwner(lockDir);
  if (owner?.token !== ownerToken) {
    return;
  }
  await rm(lockDir, { recursive: true, force: true });
}

async function readLockOwner(lockDir) {
  try {
    return JSON.parse(await readFile(path.join(lockDir, OWNER_FILE_NAME), 'utf8'));
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error?.code === 'EPERM';
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
