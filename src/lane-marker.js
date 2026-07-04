import { access, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseSimpleYaml } from './simple-yaml.js';

// D-280: the worktree-local lane marker is a single hand-inspectable YAML file
// written and removed only by package commands. This module owns the marker
// contract plus the shared lane-identity primitives (lane-ID validation and
// the D-277 selection order) so session.js and docs-update.js cannot diverge.
export const LANE_MARKER_FILENAME = '.vibecompass-lane.yaml';
export const LANE_MARKER_FORMAT_VERSION = 1;

export const LANE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
export const RESERVED_LANE_IDS = new Set([
  'active',
  'current',
  'default',
  'false',
  'handoff',
  'index',
  'new',
  'no',
  'null',
  'off',
  'on',
  'sessions',
  'state',
  'true',
  'wip',
  'yes',
]);

export function validateLaneId(value) {
  const normalized = value.trim();
  if (!LANE_ID_PATTERN.test(normalized)) {
    throw new Error('Session lane ID must be a lowercase slug 3-64 characters long using letters, numbers, and hyphens.');
  }

  if (RESERVED_LANE_IDS.has(normalized)) {
    throw new Error(`Session lane ID "${normalized}" is reserved.`);
  }

  return normalized;
}

/**
 * Walks up from `startDir` to the filesystem root and returns the nearest
 * directory containing a lane marker file, or null. Nearest-marker-wins keeps
 * nested contexts coherent (D-280); no parsing happens here.
 */
export async function findNearestLaneMarker(startDir) {
  let dir = path.resolve(startDir);

  for (;;) {
    const markerPath = path.join(dir, LANE_MARKER_FILENAME);
    if (await fileExists(markerPath)) {
      return { markerDir: dir, markerPath };
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }

    dir = parent;
  }
}

/**
 * Reads and validates a lane marker file. Corrupt or invalid markers fail
 * closed with an actionable error naming the marker path — a marker that
 * cannot be validated is broken session context, not something to guess past.
 */
export async function readLaneMarker(markerPath) {
  let source;
  try {
    source = await readFile(markerPath, 'utf8');
  } catch (error) {
    throw new Error(
      `Lane marker at ${markerPath} exists but cannot be read (${error instanceof Error ? error.message : String(error)}). ` +
        'Fix the file permissions or remove the marker, or pass both --root and --session to bypass it.',
    );
  }

  let data;
  try {
    data = parseSimpleYaml(source, { sourceName: markerPath });
  } catch (error) {
    throw new Error(
      `Lane marker at ${markerPath} is not valid marker YAML (${error instanceof Error ? error.message : String(error)}). ` +
        'Remove the marker or recreate it with `vibecompass write-lane-marker`, or pass both --root and --session to bypass it.',
    );
  }

  const formatVersion = typeof data.format_version === 'number' ? data.format_version : Number(data.format_version);
  if (formatVersion !== LANE_MARKER_FORMAT_VERSION) {
    throw new Error(
      `Lane marker at ${markerPath} has unsupported format_version ${data.format_version ?? '(missing)'}; this package understands version ${LANE_MARKER_FORMAT_VERSION}. ` +
        'Recreate the marker with `vibecompass write-lane-marker`, upgrade the vibecompass package, or pass both --root and --session to bypass it.',
    );
  }

  const laneId = typeof data.lane_id === 'string' ? data.lane_id.trim() : '';
  if (!laneId || !LANE_ID_PATTERN.test(laneId) || RESERVED_LANE_IDS.has(laneId)) {
    throw new Error(
      `Lane marker at ${markerPath} has a missing or invalid lane_id. ` +
        'Recreate the marker with `vibecompass write-lane-marker`, or pass both --root and --session to bypass it.',
    );
  }

  const memoryRoot = typeof data.memory_root === 'string' ? data.memory_root.trim() : '';
  if (!memoryRoot || !isAbsolutePathForAnySupportedPlatform(memoryRoot)) {
    throw new Error(
      `Lane marker at ${markerPath} must record memory_root as an absolute path (found ${JSON.stringify(data.memory_root ?? null)}). ` +
        'Recreate the marker with `vibecompass write-lane-marker`, or pass both --root and --session to bypass it.',
    );
  }

  const token = typeof data.token === 'string' ? data.token.trim() : '';
  if (!token) {
    throw new Error(
      `Lane marker at ${markerPath} is missing its token. ` +
        'Recreate the marker with `vibecompass write-lane-marker`, or pass both --root and --session to bypass it.',
    );
  }

  return {
    markerPath,
    markerDir: path.dirname(markerPath),
    laneId,
    memoryRoot,
    token,
    createdAt: typeof data.created_at === 'string' ? data.created_at : null,
    createdBy: typeof data.created_by === 'string' ? data.created_by : null,
  };
}

/**
 * Pre-lock context resolution (D-280): finds the nearest marker from cwd,
 * fail-closes on corrupt markers, applies root binding, and returns the
 * memory root the command should target. An explicit --root always wins;
 * otherwise a valid marker supplies the root; only when no marker resolves
 * does the `cwd/.compass` default apply.
 */
export async function resolveLaneMarkerContext(options) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const explicitRootDir = options.explicitRootDir ? path.resolve(cwd, options.explicitRootDir) : null;
  const explicitSessionId = options.explicitSessionId ?? null;
  const warnings = [];

  const found = await findNearestLaneMarker(cwd);
  let marker = null;
  if (found) {
    try {
      marker = await readLaneMarker(found.markerPath);
    } catch (error) {
      // Corrupt markers fail closed unless the context is fully explicit:
      // passing both --root and --session is the documented escape hatch,
      // since the marker could then contribute nothing but warnings.
      if (explicitRootDir && explicitSessionId) {
        warnings.push(
          `${error instanceof Error ? error.message : String(error)} Ignored because --root and --session were provided; fix or remove the marker.`,
        );
      } else {
        throw error;
      }
    }
  }

  if (marker && explicitRootDir) {
    const markerRoot = await canonicalizePath(marker.memoryRoot);
    const explicitRoot = await canonicalizePath(explicitRootDir);
    if (markerRoot !== explicitRoot) {
      warnings.push(
        `Lane marker at ${marker.markerPath} binds to memory root ${marker.memoryRoot}, not ${explicitRootDir}; ignoring the marker for this command.`,
      );
      marker = null;
    }
  }

  const rootDir = explicitRootDir ?? marker?.memoryRoot ?? path.resolve(cwd, '.compass');

  return {
    cwd,
    rootDir,
    rootSource: explicitRootDir ? 'flag' : marker ? 'marker' : 'default',
    marker,
    warnings,
  };
}

/**
 * In-lock revalidation for a marker snapshot captured before waiting on the
 * memory-root lock. If the marker changed while the command waited, fail
 * closed instead of using stale lane/root context for a mutating operation.
 */
export async function assertLaneMarkerSnapshotCurrent(markerContext) {
  const snapshot = markerContext?.marker;
  if (!snapshot) {
    return;
  }

  let current;
  try {
    current = await readLaneMarker(snapshot.markerPath);
  } catch (error) {
    throw new Error(
      `Lane marker at ${snapshot.markerPath} changed while waiting for the project-memory lock. ` +
        `Could not re-read the original marker (${error instanceof Error ? error.message : String(error)}). ` +
        'Rerun the command so lane selection and root inference are based on the current marker.',
    );
  }

  if (
    current.laneId !== snapshot.laneId ||
    current.memoryRoot !== snapshot.memoryRoot ||
    current.token !== snapshot.token
  ) {
    throw new Error(
      `Lane marker at ${snapshot.markerPath} changed while waiting for the project-memory lock. ` +
        'Rerun the command so lane selection and root inference are based on the current marker.',
    );
  }
}

/**
 * The D-277 lane selection order, shared by every lane-scoped resolver:
 * explicit --session wins (warning when it contradicts a resolvable marker,
 * naming both lanes) > marker lane (fail closed when stale, even if a
 * single-lane fallback would have succeeded) > single active lane > null at
 * zero lanes > actionable error at 2+ lanes. Pure function; the caller
 * enumerates lanes (inside its lock for mutating commands).
 */
export function resolveLaneSelection(options) {
  // Validating here (not only in callers) keeps the two resolvers from
  // diverging on the explicit-flag contract.
  const explicitSessionId = options.explicitSessionId ? validateLaneId(options.explicitSessionId) : null;
  const marker = options.marker ?? null;
  const laneIds = options.laneIds ?? [];
  const purpose = options.purpose ?? 'use';
  const warnings = [];

  if (explicitSessionId) {
    // An explicit selection still fails closed when it names a lane that is
    // not active — otherwise a typo'd --session silently plans or writes
    // against a lane that does not exist (the mis-selection D-277 removes).
    if (!laneIds.includes(explicitSessionId)) {
      throw new Error(
        `Session lane "${explicitSessionId}" is not an active lane in ${options.rootDir ?? 'the project-memory root'}. ` +
          'Run `vibecompass list-sessions` to see active lanes.',
      );
    }

    if (marker && marker.laneId !== explicitSessionId && !options.suppressLaneWarnings) {
      warnings.push(
        `--session ${explicitSessionId} overrides the lane marker at ${marker.markerPath} (marker lane: ${marker.laneId}). ` +
          'If that is unintentional, run the command from a directory bound to the intended lane.',
      );
    }

    return { sessionId: explicitSessionId, source: 'flag', warnings };
  }

  if (marker) {
    if (!laneIds.includes(marker.laneId)) {
      throw new Error(
        `Lane marker at ${marker.markerPath} names lane "${marker.laneId}", which is not an active lane in ${options.rootDir ?? 'the project-memory root'}. ` +
          'Remove the stale marker or recreate it with `vibecompass write-lane-marker`, or pass --session explicitly (D-280: stale markers fail closed).',
      );
    }

    return { sessionId: marker.laneId, source: 'marker', warnings };
  }

  if (laneIds.length === 1) {
    return { sessionId: laneIds[0], source: 'single-lane', warnings };
  }

  if (laneIds.length > 1) {
    throw new Error(
      `Multiple active session lanes exist. Pass --session to choose which lane to ${purpose}, ` +
        'or run the command from a directory with a worktree lane marker (`vibecompass write-lane-marker`).',
    );
  }

  return { sessionId: null, source: 'none', warnings };
}

/**
 * D-280 guard: a marker target must be path-disjoint from the memory root.
 * An ancestor target would turn the shared workspace tree into a de facto
 * global current pointer; an equal-or-descendant target would put marker
 * state inside the memory root D-278 keeps local-only.
 */
export async function assertMarkerTargetDisjoint(targetDir, rootDir) {
  const target = await canonicalizePath(path.resolve(targetDir));
  const root = await canonicalizePath(path.resolve(rootDir));

  if (target === root) {
    throw new Error(
      `write-lane-marker refuses ${targetDir}: the target equals the project-memory root. Markers must be path-disjoint from the memory root (D-280).`,
    );
  }

  if (isPathInside(root, target)) {
    throw new Error(
      `write-lane-marker refuses ${targetDir}: the target contains the project-memory root, so the marker would govern the shared workspace tree (D-280).`,
    );
  }

  if (isPathInside(target, root)) {
    throw new Error(
      `write-lane-marker refuses ${targetDir}: the target is inside the project-memory root; lane markers are local working state and never live in package memory (D-278/D-280).`,
    );
  }
}

/**
 * Renders the marker file body. String fields that can hold arbitrary text
 * are quoted with JSON.stringify to match the codebase's hand-rendered YAML
 * convention; values needing escape sequences are out of contract for the
 * parseSimpleYaml subset.
 */
export function renderLaneMarker(options) {
  return [
    `format_version: ${LANE_MARKER_FORMAT_VERSION}`,
    `lane_id: ${options.laneId}`,
    `memory_root: ${JSON.stringify(options.memoryRoot)}`,
    `token: ${JSON.stringify(options.token)}`,
    `created_at: ${options.createdAt}`,
    `created_by: ${JSON.stringify(options.createdBy)}`,
    '',
  ].join('\n');
}

/** Walks up from `dir` looking for a `.git` entry (directory or file). */
export async function findEnclosingGitDir(dir) {
  let current = path.resolve(dir);

  for (;;) {
    if (await fileExists(path.join(current, '.git'))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

function isPathInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function canonicalizePath(value) {
  try {
    return await realpath(value);
  } catch {
    return path.resolve(value);
  }
}

function isAbsolutePathForAnySupportedPlatform(value) {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
