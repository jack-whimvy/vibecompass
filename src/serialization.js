import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
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
export async function withMemoryRootLock(rootDir, label, fn, options = {}) {
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
    const ownerToken = await acquireDiskLock(key, label, options);
    try {
      const nextHeld = new Set(held ?? []);
      nextHeld.add(key);
      return await heldRoots.run(nextHeld, fn);
    } finally {
      await releaseDiskLock(key, ownerToken);
    }
  } finally {
    releaseQueue();
    if (processQueues.get(key) === queueSlot) {
      processQueues.delete(key);
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

  for (const heldKey of held) {
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
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  await mkdir(path.dirname(lockDir), { recursive: true });

  for (let attempt = 1; ; attempt += 1) {
    const ownerToken = randomUUID();
    try {
      await mkdir(lockDir);
      await writeFile(
        path.join(lockDir, OWNER_FILE_NAME),
        `${JSON.stringify({ pid: process.pid, token: ownerToken, label, acquired_at: new Date().toISOString() })}\n`,
        'utf8',
      );
      return ownerToken;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
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
