import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveLaneMarkerContext } from './lane-marker.js';
import { STATE_VERSION } from './manifest.js';
import { parseSimpleYaml } from './simple-yaml.js';
import { PACKAGE_VERSION } from './version.js';

/**
 * Inspect root compatibility without writing files.
 * `packageVersion` is a test override; production callers should omit it.
 */
export async function inspectProjectCompatibility(options = {}) {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const rootResolution = await resolveInspectionRootDir(cwd, options.rootDir);
  const rootDir = rootResolution.rootDir;
  const cliPackageVersion = normalizePackageVersion(options.packageVersion ?? PACKAGE_VERSION);
  const projectFilePath = path.join(rootDir, 'project.yaml');
  const manifestPath = path.join(rootDir, 'state', 'manifest.json');
  const warnings = [];

  if (rootResolution.markerError) {
    warnings.push(warning({
      code: 'lane-marker-unreadable',
      message: `A lane marker near ${cwd} could not be resolved (${rootResolution.markerError}); inspecting ${rootDir} instead. Lane-scoped commands will fail closed on it.`,
      errorMessage: rootResolution.markerError,
    }));
  }

  const project = await readProjectStamp(projectFilePath);
  const manifest = await readManifestState(manifestPath);
  const packageStatus = project.status === 'unreadable'
    ? {
        status: 'unknown',
        rootVersion: null,
        cliVersion: cliPackageVersion,
        errorMessage: project.errorMessage,
      }
    : buildPackageStatus(project.packageVersion, cliPackageVersion);
  const stateStatus = buildStateStatus(manifest);
  // Package and state statuses intentionally use different vocabularies:
  // canonical package-stamp drift is distinct from derived-state drift.

  if (packageStatus.status === 'unknown') {
    warnings.push(warning({
      code: 'project-yaml-unreadable',
      message: `project.yaml is unreadable. ${packageStatus.errorMessage}`,
      errorMessage: packageStatus.errorMessage,
    }));
  } else if (packageStatus.status === 'legacy') {
    warnings.push(warning({
      code: 'package-version-legacy-root',
      message: 'project.yaml has no metadata.package_version stamp; treating the root as legacy/unknown.',
      cliVersion: cliPackageVersion,
    }));
  } else if (packageStatus.status === 'behind') {
    warnings.push(warning({
      code: 'package-version-behind',
      message: `project.yaml metadata.package_version ${packageStatus.rootVersion} is older than CLI package ${cliPackageVersion}.`,
      rootVersion: packageStatus.rootVersion,
      cliVersion: cliPackageVersion,
    }));
  } else if (packageStatus.status === 'ahead') {
    warnings.push(warning({
      code: 'package-version-ahead',
      message: `project.yaml metadata.package_version ${packageStatus.rootVersion} is newer than CLI package ${cliPackageVersion}.`,
      rootVersion: packageStatus.rootVersion,
      cliVersion: cliPackageVersion,
    }));
  } else if (packageStatus.status === 'invalid') {
    warnings.push(warning({
      code: 'package-version-invalid',
      message: 'project.yaml metadata.package_version is present but is not a non-empty semver string.',
      rootVersion: packageStatus.rootVersion,
      cliVersion: cliPackageVersion,
    }));
  }

  if (stateStatus.status === 'missing') {
    warnings.push(warning({
      code: 'state-manifest-missing',
      message: 'state/manifest.json is missing; commands that need derived state can regenerate it.',
    }));
  } else if (stateStatus.status === 'unreadable') {
    warnings.push(warning({
      code: 'state-manifest-unreadable',
      message: `state/manifest.json is unreadable; commands that need derived state can discard and regenerate it. ${stateStatus.errorMessage}`,
      errorMessage: stateStatus.errorMessage,
    }));
  } else if (stateStatus.status === 'unsupported') {
    warnings.push(warning({
      code: 'state-version-unsupported',
      message: `state/manifest.json state_version ${stateStatus.observedVersion} is unsupported by this CLI (expected ${STATE_VERSION}); commands that need derived state can regenerate it.`,
      observedVersion: stateStatus.observedVersion,
      expectedVersion: STATE_VERSION,
      packageObservedVersion: stateStatus.packageObservedVersion,
    }));
  }

  return {
    rootDir,
    projectFilePath,
    manifestPath,
    cliPackageVersion,
    package: packageStatus,
    state: stateStatus,
    warnings,
  };
}

export function formatCompatibilityWarnings(result) {
  return (result?.warnings ?? []).map((warning) => warning.message);
}

/**
 * D-280: read-only inspection adopts the nearest valid marker's memory root
 * the same way lane-scoped commands do, so a worktree cwd is inspected
 * against the root it is bound to instead of a nonexistent `cwd/.compass`.
 * The preflight must never block a command, so marker resolution failures
 * fall back to the cwd default — the command that follows surfaces the
 * marker error itself.
 */
async function resolveInspectionRootDir(cwd, explicitRootDir) {
  if (explicitRootDir) {
    return { rootDir: path.resolve(cwd, explicitRootDir), markerError: null };
  }

  try {
    return { rootDir: (await resolveLaneMarkerContext({ cwd })).rootDir, markerError: null };
  } catch (error) {
    return {
      rootDir: path.resolve(cwd, '.compass'),
      markerError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readProjectStamp(projectFilePath) {
  try {
    const config = parseSimpleYaml(await readFile(projectFilePath, 'utf8'), {
      sourceName: projectFilePath,
    });
    const metadata = isPlainObject(config.metadata) ? config.metadata : {};
    return {
      status: 'ok',
      packageVersion: Object.hasOwn(metadata, 'package_version')
        ? metadata.package_version
        : undefined,
    };
  } catch (error) {
    return {
      status: 'unreadable',
      packageVersion: undefined,
      errorMessage: error instanceof Error ? error.message : 'Unable to read project.yaml.',
    };
  }
}

async function readManifestState(manifestPath) {
  try {
    return {
      status: 'ok',
      manifest: JSON.parse(await readFile(manifestPath, 'utf8')),
    };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { status: 'missing' };
    }

    return {
      status: 'unreadable',
      errorMessage: error instanceof Error ? error.message : 'Unable to read state/manifest.json.',
    };
  }
}

function buildPackageStatus(rootVersion, cliPackageVersion) {
  if (rootVersion === undefined) {
    return {
      status: 'legacy',
      rootVersion: null,
      cliVersion: cliPackageVersion,
    };
  }

  if (typeof rootVersion !== 'string' || rootVersion.trim() === '') {
    return {
      status: 'invalid',
      rootVersion,
      cliVersion: cliPackageVersion,
    };
  }

  const normalizedRootVersion = normalizePackageVersion(rootVersion);
  if (!parseSemver(normalizedRootVersion)) {
    return {
      status: 'invalid',
      rootVersion,
      cliVersion: cliPackageVersion,
    };
  }

  const comparison = comparePackageVersions(normalizedRootVersion, cliPackageVersion);

  return {
    status: comparison === 0 ? 'current' : comparison < 0 ? 'behind' : 'ahead',
    rootVersion: normalizedRootVersion,
    cliVersion: cliPackageVersion,
  };
}

function buildStateStatus(manifestResult) {
  if (manifestResult.status === 'missing') {
    return { status: 'missing' };
  }

  if (manifestResult.status === 'unreadable') {
    return {
      status: 'unreadable',
      errorMessage: manifestResult.errorMessage,
    };
  }

  const manifest = manifestResult.manifest;
  if (manifest?.state_version !== STATE_VERSION) {
    return {
      status: 'unsupported',
      observedVersion: manifest?.state_version ?? null,
      expectedVersion: STATE_VERSION,
      packageObservedVersion:
        typeof manifest?.package?.observed_version === 'string'
          ? manifest.package.observed_version
          : null,
    };
  }

  return {
    status: 'current',
    observedVersion: manifest.state_version,
    expectedVersion: STATE_VERSION,
    packageObservedVersion:
      typeof manifest?.package?.observed_version === 'string'
        ? manifest.package.observed_version
        : null,
  };
}

function comparePackageVersions(left, right) {
  const leftSemver = parseSemver(left);
  const rightSemver = parseSemver(right);
  if (!leftSemver || !rightSemver) {
    return 0;
  }

  const leftParts = [leftSemver.major, leftSemver.minor, leftSemver.patch];
  const rightParts = [rightSemver.major, rightSemver.minor, rightSemver.patch];
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] < rightParts[index]) {
      return -1;
    }
    if (leftParts[index] > rightParts[index]) {
      return 1;
    }
  }

  return comparePrerelease(leftSemver.prerelease, rightSemver.prerelease);
}

function parseSemver(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }

  if (left.length === 0) {
    return 1;
  }

  if (right.length === 0) {
    return -1;
  }

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }

    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const difference = Number(leftPart) - Number(rightPart);
      if (difference !== 0) {
        return difference < 0 ? -1 : 1;
      }
      continue;
    }

    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }

    const comparison = leftPart.localeCompare(rightPart);
    if (comparison !== 0) {
      return comparison < 0 ? -1 : 1;
    }
  }

  return 0;
}

function normalizePackageVersion(version) {
  return String(version).trim();
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function warning(fields) {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
}
