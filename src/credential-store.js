import { execFile as nodeExecFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, link, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Layered local credential store for hosted sync tokens (D-355).
 *
 * Resolution order for every hosted command is fixed:
 *   1. the environment variable named by the binding's `credential_env_var`
 *      (explicit per-shell override for CI, automation, and agents);
 *   2. the local credential store entry keyed by the binding's normalized
 *      `api_url` + `project_id`, whose secret lives in the OS keychain when a
 *      keychain backend is available and otherwise in a per-user file.
 *
 * The store lives outside every project root and Git checkout. The index file
 * (`credentials.json`) holds non-secret metadata per entry — backend, token
 * prefix, label, stored-at time, capture source — and, for the file backend
 * only, the secret itself. The directory is created 0700 and the file 0600;
 * a file store with broader permissions is refused rather than read.
 *
 * Nothing here ever writes a token into project.yaml, state/, manifests, or
 * output: callers receive the resolved secret and a source label only.
 */

export const CREDENTIAL_STORE_VERSION = 1;
export const CREDENTIAL_STORE_FILE_NAME = 'credentials.json';
export const KEYCHAIN_SERVICE = 'vibecompass-sync';
export const CONFIG_DIR_ENV_VAR = 'VIBECOMPASS_CONFIG_DIR';
export const STORE_BACKEND_ENV_VAR = 'VIBECOMPASS_CREDENTIAL_STORE';
export const STORE_BACKENDS = new Set(['auto', 'keychain', 'file']);
export const TOKEN_PREFIX_LENGTH = 14;

const SAFE_ACCOUNT_PATTERN = /^[A-Za-z0-9._:/@|+-]+$/;
const LOCK_FILE_SUFFIX = '.lock';
const RECLAIM_LOCK_SUFFIX = '.reclaim';
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const KEYCHAIN_LABEL_MAX = 120;

/**
 * Resolves the per-user config directory that owns the credential store.
 * `VIBECOMPASS_CONFIG_DIR` wins, then `XDG_CONFIG_HOME/vibecompass`, then the
 * platform default (`~/.config/vibecompass`; `%APPDATA%\vibecompass` on
 * Windows). Tests isolate the store by pointing the env var at a temp dir.
 */
export function resolveCredentialStoreDir(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();

  const explicit = normalizeOptionalString(env[CONFIG_DIR_ENV_VAR]);
  if (explicit) {
    return path.resolve(explicit);
  }

  const xdg = normalizeOptionalString(env.XDG_CONFIG_HOME);
  if (xdg) {
    return path.join(path.resolve(xdg), 'vibecompass');
  }

  if (platform === 'win32') {
    const appData = normalizeOptionalString(env.APPDATA);
    return appData
      ? path.join(path.resolve(appData), 'vibecompass')
      : path.join(homeDir, 'AppData', 'Roaming', 'vibecompass');
  }

  return path.join(homeDir, '.config', 'vibecompass');
}

export function resolveCredentialStorePath(options = {}) {
  return path.join(resolveCredentialStoreDir(options), CREDENTIAL_STORE_FILE_NAME);
}

/**
 * Canonical target identity: scheme and host are case-insensitive and are
 * lowercased; the path is case-sensitive and is preserved exactly (trailing
 * slashes trimmed) so `/TeamA` and `/teama` stay distinct targets.
 */
export function normalizeApiUrl(apiUrl) {
  const raw = normalizeOptionalString(apiUrl);
  if (!raw) {
    throw new Error('A hosted api_url is required to address the credential store.');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Hosted api_url "${raw}" is not a valid URL.`);
  }
  const pathname = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${pathname}`;
}

export function credentialStoreKey(apiUrl, projectId) {
  const project = normalizeOptionalString(projectId);
  if (!project) {
    throw new Error('A hosted project_id is required to address the credential store.');
  }
  return `${normalizeApiUrl(apiUrl)}|${project}`;
}

export function tokenPrefixOf(token) {
  return String(token).slice(0, TOKEN_PREFIX_LENGTH);
}

/**
 * Returns the requested backend policy: `auto` (keychain when available,
 * else file), `keychain` (required), or `file`. The CLI flag wins over the
 * `VIBECOMPASS_CREDENTIAL_STORE` environment default.
 */
export function resolveStoreBackendPolicy(options = {}) {
  const env = options.env ?? process.env;
  const requested = normalizeOptionalString(options.backend)
    ?? normalizeOptionalString(env[STORE_BACKEND_ENV_VAR])
    ?? 'auto';
  if (!STORE_BACKENDS.has(requested)) {
    throw new Error(
      `Unknown credential store backend "${requested}". Use auto, keychain, or file.`,
    );
  }
  return requested;
}

// ---------------------------------------------------------------------------
// Keychain backends
// ---------------------------------------------------------------------------

/**
 * Keychain item account for a store key. Keys are usually safe as-is; any key
 * outside the conservative charset is mapped to a stable digest so the
 * keychain never sees characters the backends cannot quote.
 */
export function keychainAccountFor(key) {
  return SAFE_ACCOUNT_PATTERN.test(key) ? key : `k:${createHash('sha256').update(key).digest('hex')}`;
}

/**
 * Display label for a keychain item. Project names may contain quotes,
 * backslashes, or control characters; those are replaced so the label can
 * never break the backend command line (the token itself is untouched).
 */
export function keychainLabelFor(label) {
  const cleaned = String(label ?? '')
    .replace(/[\u0000-\u001f\u007f"\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, KEYCHAIN_LABEL_MAX);
  return cleaned || 'VibeCompass sync token';
}

function promisifiedExecFile(execFileImpl) {
  return (file, args, input) =>
    new Promise((resolve, reject) => {
      let child;
      try {
        child = execFileImpl(
          file,
          args,
          { encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true },
          (error, stdout, stderr) => {
            if (error) {
              const wrapped = new Error(error.message);
              wrapped.code = error.code;
              wrapped.exitCode = typeof error.code === 'number' ? error.code : null;
              wrapped.stderr = typeof stderr === 'string' ? stderr : '';
              wrapped.stdout = typeof stdout === 'string' ? stdout : '';
              reject(wrapped);
              return;
            }
            resolve({ stdout: typeof stdout === 'string' ? stdout : '', stderr: typeof stderr === 'string' ? stderr : '' });
          },
        );
      } catch (error) {
        reject(error);
        return;
      }
      if (child?.stdin) {
        if (input !== undefined) {
          child.stdin.on('error', () => {});
          child.stdin.end(input);
        } else {
          child.stdin.end();
        }
      }
    });
}

function assertSafeAccount(account) {
  if (!SAFE_ACCOUNT_PATTERN.test(account)) {
    throw new Error(`Credential store key "${account}" contains characters the keychain backend does not accept.`);
  }
}

function quoteForSecurityInteractive(value) {
  // `security -i` tokenizes its command line with double quotes; the values we
  // pass (store keys, hex tokens, short labels) never contain quotes or
  // backslashes, so a plain wrap is exact. Anything else is refused upstream.
  if (/["\\\r\n]/.test(value)) {
    throw new Error('Keychain values may not contain quotes, backslashes, or line breaks.');
  }
  return `"${value}"`;
}

function createMacOsSecurityBackend(execFileImpl) {
  const run = promisifiedExecFile(execFileImpl);
  return {
    name: 'keychain',
    description: 'macOS Keychain',
    async available() {
      return true;
    },
    async get(account) {
      assertSafeAccount(account);
      try {
        const { stdout } = await run('security', [
          'find-generic-password',
          '-a', account,
          '-s', KEYCHAIN_SERVICE,
          '-w',
        ]);
        const value = stdout.replace(/\r?\n$/, '');
        return value === '' ? null : value;
      } catch (error) {
        if (error.exitCode === 44) {
          return null; // errSecItemNotFound
        }
        throw new Error(`macOS Keychain read failed (${describeExecError(error)}). Set ${STORE_BACKEND_ENV_VAR}=file to use the file store instead.`);
      }
    },
    async set(account, secret, label) {
      assertSafeAccount(account);
      // The token is handed to `security -i` on stdin so it never appears in a
      // process argument list.
      const command = [
        'add-generic-password',
        '-a', quoteForSecurityInteractive(account),
        '-s', quoteForSecurityInteractive(KEYCHAIN_SERVICE),
        '-l', quoteForSecurityInteractive(label),
        '-j', quoteForSecurityInteractive('VibeCompass hosted sync token'),
        '-U',
        '-w', quoteForSecurityInteractive(secret),
      ].join(' ');
      try {
        await run('security', ['-i'], `${command}\n`);
      } catch (error) {
        throw new Error(`macOS Keychain write failed (${describeExecError(error)}). Retry with --credential-store file to use the file store instead.`);
      }
    },
    async remove(account) {
      assertSafeAccount(account);
      try {
        await run('security', ['delete-generic-password', '-a', account, '-s', KEYCHAIN_SERVICE]);
        return true;
      } catch (error) {
        if (error.exitCode === 44) {
          return false;
        }
        throw new Error(`macOS Keychain delete failed (${describeExecError(error)}).`);
      }
    },
  };
}

function createSecretToolBackend(execFileImpl) {
  const run = promisifiedExecFile(execFileImpl);
  return {
    name: 'keychain',
    description: 'system keyring (secret-tool)',
    async available() {
      try {
        await run('secret-tool', ['lookup', 'service', `${KEYCHAIN_SERVICE}.probe`, 'account', 'probe']);
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') {
          return false;
        }
        // A missing item exits 1; that still proves the tool exists.
        return error.exitCode === 1;
      }
    },
    async get(account) {
      assertSafeAccount(account);
      try {
        const { stdout } = await run('secret-tool', ['lookup', 'service', KEYCHAIN_SERVICE, 'account', account]);
        const value = stdout.replace(/\r?\n$/, '');
        return value === '' ? null : value;
      } catch (error) {
        if (error.exitCode === 1) {
          return null;
        }
        throw new Error(`Keyring read failed (${describeExecError(error)}). Set ${STORE_BACKEND_ENV_VAR}=file to use the file store instead.`);
      }
    },
    async set(account, secret, label) {
      assertSafeAccount(account);
      try {
        await run(
          'secret-tool',
          ['store', `--label=${label}`, 'service', KEYCHAIN_SERVICE, 'account', account],
          secret,
        );
      } catch (error) {
        throw new Error(`Keyring write failed (${describeExecError(error)}). Retry with --credential-store file to use the file store instead.`);
      }
    },
    async remove(account) {
      assertSafeAccount(account);
      try {
        await run('secret-tool', ['clear', 'service', KEYCHAIN_SERVICE, 'account', account]);
        return true;
      } catch (error) {
        if (error.exitCode === 1) {
          return false;
        }
        throw new Error(`Keyring delete failed (${describeExecError(error)}).`);
      }
    },
  };
}

function describeExecError(error) {
  if (error?.code === 'ENOENT') {
    return 'tool not found';
  }
  const stderr = normalizeOptionalString(error?.stderr);
  if (stderr) {
    return stderr.split(/\r?\n/)[0];
  }
  return error?.message ?? 'unknown error';
}

/**
 * Picks the platform keychain backend, or null when none exists. An injected
 * `keychainBackend` (tests) short-circuits detection; `false` disables it.
 */
export async function detectKeychainBackend(options = {}) {
  if (options.keychainBackend === false) {
    return null;
  }
  if (options.keychainBackend && typeof options.keychainBackend === 'object') {
    return options.keychainBackend;
  }

  const platform = options.platform ?? process.platform;
  const execFileImpl = options.execFile ?? nodeExecFile;

  if (platform === 'darwin') {
    return createMacOsSecurityBackend(execFileImpl);
  }
  if (platform === 'linux') {
    const backend = createSecretToolBackend(execFileImpl);
    return (await backend.available()) ? backend : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Index file
// ---------------------------------------------------------------------------

function emptyIndex() {
  return { version: CREDENTIAL_STORE_VERSION, entries: {} };
}

async function assertPrivateFile(filePath, platform) {
  if (platform === 'win32') {
    return;
  }
  const info = await stat(filePath);
  if ((info.mode & 0o077) !== 0) {
    throw new Error(
      `Refusing to read ${filePath}: it is readable by other users. Run: chmod 600 ${filePath}`,
    );
  }
}

export async function readCredentialIndex(options = {}) {
  const platform = options.platform ?? process.platform;
  const filePath = resolveCredentialStorePath(options);
  let raw;
  try {
    await assertPrivateFile(filePath, platform);
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { filePath, exists: false, index: emptyIndex() };
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Credential store ${filePath} is not valid JSON. Fix or remove the file and store the token again.`);
  }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== CREDENTIAL_STORE_VERSION || !parsed.entries || typeof parsed.entries !== 'object') {
    throw new Error(`Credential store ${filePath} has an unsupported shape (expected version ${CREDENTIAL_STORE_VERSION}).`);
  }
  return { filePath, exists: true, index: parsed };
}

export async function writeCredentialIndex(index, options = {}, hooks = {}) {
  const platform = options.platform ?? process.platform;
  const dir = resolveCredentialStoreDir(options);
  const filePath = path.join(dir, CREDENTIAL_STORE_FILE_NAME);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (platform !== 'win32') {
    await chmod(dir, 0o700);
  }
  // Exclusive creation with a random suffix: concurrent writers in one
  // process or across processes can never share a temp file.
  const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(tempPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(index, null, 2)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
  if (platform !== 'win32') {
    await chmod(tempPath, 0o600);
  }
  if (typeof hooks.beforeCommit === 'function') {
    // Defensive tripwire, not the exclusion mechanism: the lock below is what
    // keeps writers apart. This only refuses to publish if the lock file was
    // removed by hand while this writer was running.
    try {
      await hooks.beforeCommit();
    } catch (error) {
      await unlink(tempPath).catch(() => {});
      throw error;
    }
  }
  if (typeof hooks.beforeRename === 'function') {
    await hooks.beforeRename(); // test seam only
  }
  await rename(tempPath, filePath);
  return filePath;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user — still alive.
    return error?.code === 'EPERM';
  }
}

async function readLockOwner(lockPath) {
  try {
    const parsed = JSON.parse(await readFile(lockPath, 'utf8'));
    return parsed && typeof parsed === 'object' && typeof parsed.id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Creates a lock file atomically: the owner record is written to a private
 * temp file and hard-linked into place, so the lock either appears fully
 * formed or not at all and a contender never reads a half-written record.
 * Returns false when the path is already taken.
 */
async function createLockAtomically(lockPath, owner) {
  const tempPath = `${lockPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(tempPath, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(owner), 'utf8');
  } finally {
    await handle.close();
  }
  try {
    await link(tempPath, lockPath);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') {
      return false;
    }
    throw error;
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

/**
 * A contended lock may be reclaimed only when it was taken on this host by
 * a process that no longer exists. A live process keeps its lock however
 * long it waits (a keychain prompt, a paused terminal); a lock from another
 * host or an unreadable lock is never removed automatically.
 */
function isAbandoned(owner, host) {
  return Boolean(owner) && owner.host === host && !isProcessAlive(owner.pid);
}

function describeLockOwner(owner) {
  return owner ? `pid ${owner.pid}${owner.host ? ` on ${owner.host}` : ''}` : 'an unreadable lock file';
}

/**
 * Serialized dead-owner recovery. Exactly one process may unlink an
 * abandoned lock: the holder of the reclaim lock, which re-reads the owner
 * record under that lock and removes it only if it is still the same dead
 * owner. A lock re-acquired by a live process in the meantime has a
 * different id and is left alone. A reclaim lock left behind by a reclaimer
 * that itself died is never cleaned automatically (it blocks recovery and is
 * named in the timeout error) so that no old observation can ever unlink a
 * successor's lock.
 */
async function reclaimAbandonedLock(lockPath, reclaimPath, seenOwner, host) {
  const reclaimer = { id: randomBytes(12).toString('hex'), pid: process.pid, host, acquired_at: new Date().toISOString() };
  if (!(await createLockAtomically(reclaimPath, reclaimer))) {
    return false; // another reclaimer is active; the caller retries after it finishes
  }
  try {
    const current = await readLockOwner(lockPath);
    if (current && current.id === seenOwner.id && isAbandoned(current, host)) {
      await unlink(lockPath).catch(() => {});
    }
    return true;
  } finally {
    const mine = await readLockOwner(reclaimPath);
    if (mine && mine.id === reclaimer.id) {
      await unlink(reclaimPath).catch(() => {});
    }
  }
}

/**
 * Cross-process mutual exclusion for read-modify-write of the index and the
 * keychain operations that go with it. The lock is a file next to the index
 * that appears atomically (see createLockAtomically) and names its owner
 * (random id, pid, host). It is never taken from a live process on this
 * host; writers wait up to lockTimeoutMs, then fail naming the owner. When
 * the owner process no longer exists, recovery goes through a second lock so
 * that exactly one reclaimer removes it after re-reading the owner under that
 * lock. Readers do not take the lock: the atomic rename in
 * writeCredentialIndex guarantees a complete snapshot.
 */
export async function withCredentialStoreLock(options, work) {
  const platform = options.platform ?? process.platform;
  const dir = resolveCredentialStoreDir(options);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (platform !== 'win32') {
    await chmod(dir, 0o700);
  }
  const lockPath = path.join(dir, `${CREDENTIAL_STORE_FILE_NAME}${LOCK_FILE_SUFFIX}`);
  const reclaimPath = `${lockPath}${RECLAIM_LOCK_SUFFIX}`;
  const host = options.hostname ?? os.hostname();
  const timeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const owner = { id: randomBytes(12).toString('hex'), pid: process.pid, host, acquired_at: new Date().toISOString() };

  for (;;) {
    if (await createLockAtomically(lockPath, owner)) {
      break;
    }
    const current = await readLockOwner(lockPath);
    if (current === null) {
      try {
        await stat(lockPath);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          continue; // released between our attempt and the read
        }
        throw error;
      }
    } else if (isAbandoned(current, host)) {
      if (await reclaimAbandonedLock(lockPath, reclaimPath, current, host)) {
        continue; // removed (or confirmed already gone); try to acquire again
      }
      // Another reclaimer holds the reclaim lock (or a dead one blocks it):
      // fall through to the bounded wait so this can never spin forever.
    }
    if (Date.now() > deadline) {
      let reclaimNote = '';
      const reclaimHolder = await readLockOwner(reclaimPath);
      if (reclaimHolder) {
        reclaimNote = ` A reclaim lock (${reclaimPath}, ${describeLockOwner(reclaimHolder)}) is also present.`;
      }
      throw new Error(
        `The credential store is locked by another vibecompass process (${describeLockOwner(current)}; ${lockPath}). `
        + 'It is released automatically when that process exits. If no such process exists (for example the lock was left by another machine), delete the lock file and retry.'
        + reclaimNote,
      );
    }
    await sleep(20 + Math.floor(Math.random() * 40));
  }

  const assertOwned = async () => {
    const current = await readLockOwner(lockPath);
    if (!current || current.id !== owner.id) {
      throw new Error(
        'The credential store lock file was removed while this command was running; nothing was written. Retry the command.',
      );
    }
  };

  try {
    return await work({ assertOwned });
  } finally {
    const current = await readLockOwner(lockPath);
    if (current && current.id === owner.id) {
      await unlink(lockPath).catch(() => {});
    }
  }
}

function publicEntry(key, entry) {
  return {
    key,
    apiUrl: entry.api_url,
    projectId: entry.project_id,
    backend: entry.backend,
    tokenPrefix: entry.token_prefix ?? null,
    label: entry.label ?? null,
    storedAt: entry.stored_at ?? null,
    source: entry.source ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Builds resolver options from a command environment (`{ env, runtime }`). */
export function credentialStoreOptionsFrom(environment = {}) {
  const overrides = environment.runtime?.credentialStore
    ?? environment.credentialStore
    ?? {};
  return {
    env: environment.env ?? process.env,
    ...overrides,
  };
}

/**
 * Resolves the credential for a binding through the D-355 order. Never
 * throws for a merely missing credential; callers format the guidance.
 */
export async function resolveSyncCredential(binding, options = {}) {
  const env = options.env ?? process.env;
  const envVar = binding?.credentialEnvVar;
  const fromEnv = envVar ? normalizeOptionalString(env[envVar]) : null;
  if (fromEnv) {
    return { credential: fromEnv, source: 'env', envVar };
  }

  let key;
  try {
    key = credentialStoreKey(binding.apiUrl, binding.projectId);
  } catch {
    return { credential: null, source: 'missing', envVar };
  }

  const { index, filePath } = await readCredentialIndex(options);
  const entry = index.entries[key];
  if (!entry) {
    return { credential: null, source: 'missing', envVar, key };
  }

  if (entry.backend === 'file') {
    const token = normalizeOptionalString(entry.token);
    return token
      ? { credential: token, source: 'file', envVar, key, entry: publicEntry(key, entry), storePath: filePath }
      : { credential: null, source: 'missing', envVar, key, detail: 'file entry has no token' };
  }

  if (entry.backend === 'keychain') {
    const backend = await detectKeychainBackend(options);
    if (!backend) {
      return {
        credential: null,
        source: 'missing',
        envVar,
        key,
        detail: 'the index says this token is in the OS keychain, but no keychain backend is available here',
      };
    }
    const token = await backend.get(entry.keychain_account ?? keychainAccountFor(key));
    return token
      ? { credential: token, source: 'keychain', envVar, key, entry: publicEntry(key, entry) }
      : { credential: null, source: 'missing', envVar, key, detail: 'the index names a keychain item that no longer exists' };
  }

  return { credential: null, source: 'missing', envVar, key, detail: `unknown backend "${entry.backend}"` };
}

/**
 * Stores a token for a binding. `auto` prefers the keychain when available;
 * the chosen backend is recorded in the index so later lookups never probe.
 */
export async function storeSyncCredential(input, options = {}) {
  const token = normalizeOptionalString(input?.token);
  if (!token) {
    throw new Error('A sync token is required.');
  }
  if (/\s/.test(token)) {
    throw new Error('A sync token cannot contain whitespace. Paste it exactly as the dashboard showed it.');
  }
  const key = credentialStoreKey(input.apiUrl, input.projectId);
  const policy = resolveStoreBackendPolicy({ ...options, backend: input.backend });
  const label = normalizeOptionalString(input.label) ?? `VibeCompass sync token (${normalizeOptionalString(input.projectId)})`;
  const warnings = [];

  return withCredentialStoreLock(options, async (lock) => {
    let backend = null;
    if (policy !== 'file') {
      backend = await detectKeychainBackend(options);
      if (!backend && policy === 'keychain') {
        throw new Error('No OS keychain backend is available on this machine. Use --credential-store file instead.');
      }
    }

    const { index } = await readCredentialIndex(options);
    const previous = index.entries[key] ?? null;
    const account = keychainAccountFor(key);

    const entry = {
      api_url: normalizeApiUrl(input.apiUrl),
      project_id: normalizeOptionalString(input.projectId),
      backend: 'file',
      token_prefix: tokenPrefixOf(token),
      label,
      stored_at: (options.now ?? new Date()).toISOString(),
      source: normalizeOptionalString(input.source) ?? 'sync-credential',
    };

    if (backend) {
      try {
        await backend.set(account, token, keychainLabelFor(label));
        entry.backend = 'keychain';
        entry.keychain_account = account;
      } catch (error) {
        if (policy !== 'auto') {
          throw error;
        }
        // Headless session, locked keychain, missing Secret Service: keep the
        // token rather than losing a one-time claim, and say where it went.
        warnings.push(`OS keychain write failed (${error.message}); the token was stored in the credential store file instead.`);
        backend = null;
      }
    }
    if (!backend) {
      entry.token = token;
    }

    // A previous keychain item is retired when the new entry moves to the
    // file backend so a stale secret never lingers in the keychain.
    if (previous?.backend === 'keychain' && !backend) {
      const previousBackend = await detectKeychainBackend(options);
      if (previousBackend) {
        await previousBackend.remove(previous.keychain_account ?? keychainAccountFor(key)).catch(() => false);
      }
    }

    index.entries[key] = entry;
    const filePath = await writeCredentialIndex(index, options, {
      beforeCommit: lock.assertOwned,
      beforeRename: options.testHooks?.beforeIndexRename,
    });

    return {
      key,
      backend: entry.backend,
      backendDescription: backend ? backend.description : filePath,
      storePath: filePath,
      tokenPrefix: entry.token_prefix,
      replaced: Boolean(previous),
      warnings,
    };
  });
}

export async function removeSyncCredential(input, options = {}) {
  const key = credentialStoreKey(input.apiUrl, input.projectId);
  return withCredentialStoreLock(options, async (lock) => {
    const { index, exists } = await readCredentialIndex(options);
    const entry = index.entries[key];
    if (!entry) {
      return { key, removed: false, backend: null };
    }

    let keychainRemoved = null;
    if (entry.backend === 'keychain') {
      const backend = await detectKeychainBackend(options);
      keychainRemoved = backend ? await backend.remove(entry.keychain_account ?? keychainAccountFor(key)) : false;
    }

    delete index.entries[key];
    const filePath = exists
      ? await writeCredentialIndex(index, options, { beforeCommit: lock.assertOwned })
      : resolveCredentialStorePath(options);
    return { key, removed: true, backend: entry.backend, keychainRemoved, storePath: filePath };
  });
}

export async function listSyncCredentials(options = {}) {
  const { index, filePath, exists } = await readCredentialIndex(options);
  return {
    storePath: filePath,
    exists,
    entries: Object.entries(index.entries)
      .map(([key, entry]) => publicEntry(key, entry))
      .sort((a, b) => a.key.localeCompare(b.key)),
  };
}

/** Human description of where a resolved credential came from (never the value). */
export function describeCredentialSource(resolution) {
  switch (resolution?.source) {
    case 'env':
      return `environment variable ${resolution.envVar}`;
    case 'keychain':
      return 'OS keychain';
    case 'file':
      return `credential store file${resolution.storePath ? ` (${resolution.storePath})` : ''}`;
    default:
      return 'missing';
  }
}

/**
 * The single missing-credential message every hosted command prints (D-355):
 * login first, then the manual store, then the per-shell override.
 */
export function formatMissingCredentialError(binding, context = {}) {
  const target = binding?.target ? ` --sync-target ${binding.target}` : '';
  const where = binding?.apiUrl && binding?.projectId
    ? ` for ${binding.apiUrl} (project ${binding.projectId})`
    : '';
  const action = context.action ? `${context.action} needs a hosted sync token` : 'No hosted sync token found';
  const detail = context.detail ? ` (${context.detail})` : '';
  return (
    `${action}${where}${detail}. `
    + `Sign in from this terminal with "vibecompass login${target}" (opens the dashboard, no copy-paste), `
    + `store a dashboard token with "vibecompass sync-credential set${target} --token-stdin", `
    + `or export ${binding?.credentialEnvVar ?? 'VIBECOMPASS_SYNC_TOKEN'} for this shell only. `
    + 'Lost the token? Create a new one on the hosted dashboard under Setup -> Hosted sync, or run login again.'
  );
}

function normalizeOptionalString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
