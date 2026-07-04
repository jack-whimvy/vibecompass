import { createHash } from 'node:crypto';
import { lstat, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Per-lane runtime assignment (D-282).
 *
 * Every lane started on a package-managed root gets a lane port and a lane
 * temp directory, computed during start-session preflight inside the D-276
 * memory-root lock. Assignment is lane coordination on one root — the package
 * never probes or binds the port and never supervises processes (the Phase 8
 * scope fence). Consumption goes through `lane-env` config/env export.
 */

export const DEFAULT_LANE_PORT_BASE = 3100;
export const DEFAULT_LANE_PORT_STEP = 1;
export const LANE_PORT_MIN = 1024;
export const LANE_PORT_MAX = 65535;
const LANE_TMP_NAMESPACE = 'vibecompass-lanes';

export function defaultLaneTmpBase() {
  return path.join(os.tmpdir(), LANE_TMP_NAMESPACE);
}

/**
 * Resolves `project.yaml` `runtime:` overrides (`port_base`, `port_step`,
 * `tmp_base`) against the D-282 defaults. Invalid values warn and fall back —
 * a misconfigured runtime block must not stop a session from starting.
 */
export function resolveRuntimeSettings(projectConfig) {
  const warnings = [];
  const runtimeValue = projectConfig?.runtime;
  const runtime = isPlainObject(runtimeValue) ? runtimeValue : {};
  if (runtimeValue !== undefined && runtimeValue !== null && !isPlainObject(runtimeValue)) {
    warnings.push('project.yaml "runtime" is not a mapping; the D-282 runtime defaults apply.');
  }

  for (const key of Object.keys(runtime)) {
    if (!['port_base', 'port_step', 'tmp_base'].includes(key)) {
      warnings.push(`Unknown project.yaml runtime field "${key}" (D-282 supports port_base, port_step, tmp_base).`);
    }
  }

  let portBase = DEFAULT_LANE_PORT_BASE;
  if (runtime.port_base !== undefined) {
    if (Number.isInteger(runtime.port_base) && runtime.port_base >= LANE_PORT_MIN && runtime.port_base <= LANE_PORT_MAX) {
      portBase = runtime.port_base;
    } else {
      warnings.push(
        `project.yaml runtime.port_base must be an integer between ${LANE_PORT_MIN} and ${LANE_PORT_MAX}; using the default ${DEFAULT_LANE_PORT_BASE}.`,
      );
    }
  }

  let portStep = DEFAULT_LANE_PORT_STEP;
  if (runtime.port_step !== undefined) {
    if (Number.isInteger(runtime.port_step) && runtime.port_step >= 1) {
      portStep = runtime.port_step;
    } else {
      warnings.push(`project.yaml runtime.port_step must be a positive integer; using the default ${DEFAULT_LANE_PORT_STEP}.`);
    }
  }

  let tmpBase = defaultLaneTmpBase();
  if (runtime.tmp_base !== undefined) {
    const candidate = typeof runtime.tmp_base === 'string' ? runtime.tmp_base.trim() : '';
    if (candidate && path.isAbsolute(candidate)) {
      tmpBase = candidate;
    } else {
      warnings.push('project.yaml runtime.tmp_base must be an absolute path; using the OS temp namespace default.');
    }
  }

  return { portBase, portStep, tmpBase, warnings };
}

/**
 * Lowest `port_base + k * port_step` not recorded by any sibling lane.
 * Unparseable sibling lanes contribute no port — their metadata warnings
 * already surface at start — so assignment degrades to a possible collision
 * warning path rather than blocking the start (D-282: coordination, not an
 * OS-level reservation).
 */
export function assignLanePort(options) {
  const portBase = options.portBase ?? DEFAULT_LANE_PORT_BASE;
  const portStep = options.portStep ?? DEFAULT_LANE_PORT_STEP;
  const used = new Set();
  for (const lane of options.existingLanes ?? []) {
    const port = lane?.runtime?.port;
    if (Number.isInteger(port)) {
      used.add(port);
    }
  }

  for (let candidate = portBase; candidate <= LANE_PORT_MAX; candidate += portStep) {
    if (!used.has(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `No free lane port at or above ${portBase} (step ${portStep}, max ${LANE_PORT_MAX}); ` +
      'close unused lanes or configure project.yaml runtime.port_base / runtime.port_step (D-282).',
  );
}

/**
 * Root key: first 12 hex chars of the SHA-256 of the memory root's canonical
 * realpath. Disambiguates lane temp dirs across roots that share lane ids
 * without leaking the full root path into the shared OS temp namespace.
 */
export async function computeLaneTmpRootKey(rootDir) {
  const canonical = await realpath(rootDir).catch(() => path.resolve(rootDir));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

export function buildLaneTmpDir(options) {
  return path.join(options.tmpBase, options.rootKey, options.laneId);
}

/**
 * D-282 guarded recursive removal at close, mirroring D-279/D-281
 * conservatism: the recorded path must be absolute, resolve strictly inside
 * the package-owned namespace for this root, end in the closing lane's id,
 * and not contain the process cwd. Any guard failure keeps the directory with
 * guidance; a missing directory is benign crash residue.
 */
export async function removeLaneTmpDirAtClose(options) {
  const { recordedTmpDir, laneId, namespaceDir, cwd } = options;
  const base = { tmpDir: recordedTmpDir, removed: false };

  if (!path.isAbsolute(recordedTmpDir)) {
    return {
      ...base,
      reason: 'not-absolute',
      warnings: [
        `Lane temp dir ${recordedTmpDir} was left in place: the recorded path is not absolute (D-282 guarded removal). Inspect and delete it manually.`,
      ],
    };
  }

  if (!(await pathExists(recordedTmpDir))) {
    // Benign crash residue, matching recorded-but-missing worktrees.
    return { ...base, reason: 'missing', warnings: [] };
  }

  const realTmp = await canonicalizePathBestEffort(recordedTmpDir);
  const realNamespace = await canonicalizePathBestEffort(namespaceDir);
  const namespaceRelative = path.relative(realNamespace, realTmp);
  if (namespaceRelative === '' || namespaceRelative.startsWith('..') || path.isAbsolute(namespaceRelative)) {
    return {
      ...base,
      reason: 'outside-namespace',
      warnings: [
        `Lane temp dir ${recordedTmpDir} was left in place: it does not sit inside the lane temp namespace ${namespaceDir} (D-282 guarded removal; a changed runtime.tmp_base can cause this). Inspect and delete it manually.`,
      ],
    };
  }

  if (path.basename(realTmp) !== laneId) {
    return {
      ...base,
      reason: 'lane-id-mismatch',
      warnings: [
        `Lane temp dir ${recordedTmpDir} was left in place: it does not end in the closing lane's id "${laneId}" (D-282 guarded removal). Inspect and delete it manually.`,
      ],
    };
  }

  const realCwd = await canonicalizePathBestEffort(cwd ?? process.cwd());
  const cwdRelative = path.relative(realTmp, realCwd);
  if (cwdRelative === '' || (!cwdRelative.startsWith('..') && !path.isAbsolute(cwdRelative))) {
    return {
      ...base,
      reason: 'cwd-inside',
      warnings: [
        `Lane temp dir ${recordedTmpDir} was left in place: the current working directory is inside it (D-282). cd out of the temp dir, then delete it manually.`,
      ],
    };
  }

  try {
    await rm(recordedTmpDir, { recursive: true, force: true });
    return { ...base, removed: true, reason: null, warnings: [] };
  } catch (error) {
    return {
      ...base,
      reason: 'remove-failed',
      warnings: [
        `Lane temp dir ${recordedTmpDir} could not be removed: ${error instanceof Error ? error.message : String(error)}. Inspect and delete it manually.`,
      ],
    };
  }
}

async function pathExists(value) {
  try {
    await lstat(value);
    return true;
  } catch {
    return false;
  }
}

async function canonicalizePathBestEffort(value) {
  try {
    return await realpath(value);
  } catch {
    return path.resolve(value);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
