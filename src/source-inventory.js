import { access, lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PACKAGE_VERSION } from './version.js';

export const SOURCE_INVENTORY_STATE_VERSION = 1;
export const SOURCE_INVENTORY_SCANNER_VERSION = 'source-inventory-v1';
export const SCANNED_UNACCOUNTED_WARNING_CODE = 'scanned_unaccounted';
export const SOURCE_UNAVAILABLE_WARNING_CODE = 'source_unavailable';

const DEFAULT_MAX_FILES = 2000;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.turbo',
  '.vercel',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.cache',
  'tmp',
  'temp',
]);
const IGNORED_FILE_NAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
]);
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.tgz',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp3',
  '.mp4',
  '.mov',
]);
const PROVIDERS = [
  'anthropic',
  'clerk',
  'github',
  'google',
  'openai',
  'stripe',
  'supabase',
  'tiktok',
];

export async function buildDocsReviewSourceInventory(project, options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const generatedAt = options.generatedAt instanceof Date ? options.generatedAt : new Date();
  const overrides = normalizeSourceRootOverrides(options.sourceRootOverrides);
  const sourceRoots = [];
  const itemsByKey = new Map();
  const warnings = [];

  for (const repo of normalizeRepos(project?.repos)) {
    const resolved = await resolveRepoSourceRoot({
      repo,
      rootDir,
      cwd,
      overrides,
      projectRepoRootPath: normalizeRepoRootPath(project?.repo_root_path ?? project?.repoRootPath),
    });

    sourceRoots.push(resolved.sourceRoot);
    warnings.push(...resolved.warnings);

    if (resolved.sourceRoot.status !== 'scanned') {
      continue;
    }

    const scanResult = await scanRepoRoot({
      repoId: repo.id,
      scanPath: resolved.scanPath,
      sourcePath: resolved.sourceRoot.path,
      maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
      maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    });
    warnings.push(...scanResult.warnings);
    for (const item of scanResult.items) {
      mergeItem(itemsByKey, item);
    }
  }

  const items = [...itemsByKey.values()]
    .map((item) => ({
      ...item,
      evidence: item.evidence.sort((left, right) => left.path.localeCompare(right.path)),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    version: SOURCE_INVENTORY_STATE_VERSION,
    producer: {
      package_version: PACKAGE_VERSION,
      scanner_version: SOURCE_INVENTORY_SCANNER_VERSION,
      generated_at: generatedAt.toISOString(),
    },
    source_roots: sourceRoots,
    summary: {
      item_count: items.length,
      by_kind: countBy(items, 'kind'),
      warning_count: warnings.length,
    },
    items,
    warnings,
  };
}

export async function writeDocsReviewSourceInventory(rootDir, inventory) {
  const statePath = docsReviewSourceInventoryPath(rootDir);
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
  return statePath;
}

export async function readDocsReviewSourceInventory(rootDir) {
  try {
    return JSON.parse(await readFile(docsReviewSourceInventoryPath(rootDir), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export function docsReviewSourceInventoryPath(rootDir) {
  return path.join(rootDir, 'state', 'docs-review-source-inventory.json');
}

export function summarizeSourceInventory(inventory) {
  if (!inventory) {
    return null;
  }

  return {
    path: 'state/docs-review-source-inventory.json',
    scanner_version: inventory.producer?.scanner_version ?? null,
    item_count: Array.isArray(inventory.items) ? inventory.items.length : 0,
    by_kind: inventory.summary?.by_kind ?? countBy(inventory.items ?? [], 'kind'),
    source_roots: Array.isArray(inventory.source_roots)
      ? inventory.source_roots.map((sourceRoot) => ({
        repo_id: sourceRoot.repo_id,
        kind: sourceRoot.kind,
        status: sourceRoot.status,
        ...(sourceRoot.repo_root_path ? { repo_root_path: sourceRoot.repo_root_path } : {}),
      }))
      : [],
    unavailable_repo_ids: Array.isArray(inventory.source_roots)
      ? inventory.source_roots
        .filter((sourceRoot) => sourceRoot.status === 'source_unavailable')
        .map((sourceRoot) => sourceRoot.repo_id)
      : [],
  };
}

export function reconcileCoverageWithSourceInventory(coverageProjection, inventory) {
  if (!coverageProjection || !inventory || !Array.isArray(inventory.items)) {
    return null;
  }

  const scannedIds = new Set(inventory.items.map((item) => item.id).filter(Boolean));
  const declaredIds = new Set(
    Array.isArray(coverageProjection.completeness_inventory)
      ? coverageProjection.completeness_inventory.map((item) => item.id).filter(Boolean)
      : [],
  );
  const unaccountedIds = [...scannedIds].filter((id) => !declaredIds.has(id)).sort();
  const unknownDeclaredIds = [...declaredIds].filter((id) => !scannedIds.has(id)).sort();
  const sourceUnavailableRepoIds = Array.isArray(inventory.source_roots)
    ? inventory.source_roots
      .filter((sourceRoot) => sourceRoot.status === 'source_unavailable')
      .map((sourceRoot) => sourceRoot.repo_id)
      .sort()
    : [];
  const warnings = [
    ...unaccountedIds.map((id) => ({
      code: SCANNED_UNACCOUNTED_WARNING_CODE,
      inventory_id: id,
      message: `Scanned source inventory item "${id}" is not accounted for in completeness_inventory.`,
    })),
    ...sourceUnavailableRepoIds.map((repoId) => ({
      code: SOURCE_UNAVAILABLE_WARNING_CODE,
      repo_id: repoId,
      message: `Repo "${repoId}" had no local source root, so scanned source coverage could not run for it.`,
    })),
  ];

  return {
    scanned_count: scannedIds.size,
    declared_count: declaredIds.size,
    accounted_count: [...scannedIds].filter((id) => declaredIds.has(id)).length,
    unaccounted_ids: unaccountedIds,
    unknown_declared_ids: unknownDeclaredIds,
    source_unavailable_repo_ids: sourceUnavailableRepoIds,
    warnings,
  };
}

function normalizeRepos(repos) {
  return Array.isArray(repos)
    ? repos
      .filter((repo) => repo && typeof repo === 'object' && normalizeOptionalString(repo.id))
      .map((repo) => ({ ...repo, id: normalizeOptionalString(repo.id) }))
    : [];
}

function normalizeSourceRootOverrides(value) {
  const overrides = new Map();
  if (!value) {
    return overrides;
  }

  const entries = Array.isArray(value)
    ? value
    : Object.entries(value).map(([repoId, rootPath]) => ({ repoId, path: rootPath }));
  for (const entry of entries) {
    const repoId = normalizeOptionalString(entry?.repoId ?? entry?.repo_id ?? entry?.id);
    const rootPath = normalizeOptionalString(entry?.path ?? entry?.rootPath ?? entry?.root_path);
    if (repoId && rootPath) {
      overrides.set(repoId, rootPath);
    }
  }
  return overrides;
}

async function resolveRepoSourceRoot(options) {
  const overridePath = options.overrides.get(options.repo.id);
  const repoRootPath = normalizeRepoRootPath(options.repo.root_path ?? options.repo.repo_root_path ?? options.projectRepoRootPath);
  const warnings = [];

  if (overridePath) {
    return resolveAvailableSourceRoot({
      repo: options.repo,
      kind: 'source_root_override',
      configuredPath: overridePath,
      cwd: options.cwd,
      rootDir: options.rootDir,
      repoRootPath: '/',
      applyRepoRootPath: false,
      warnings,
    });
  }

  if (options.repo.source === 'local' && normalizeOptionalString(options.repo.path)) {
    return resolveAvailableSourceRoot({
      repo: options.repo,
      kind: 'local_descriptor',
      configuredPath: options.repo.path,
      cwd: options.cwd,
      rootDir: options.rootDir,
      repoRootPath,
      applyRepoRootPath: true,
      warnings,
    });
  }

  return {
    sourceRoot: {
      repo_id: options.repo.id,
      kind: 'unavailable',
      status: 'source_unavailable',
      ...(normalizeOptionalString(options.repo.remote) ? { remote: normalizeOptionalString(options.repo.remote) } : {}),
    },
    scanPath: null,
    warnings: [
      {
        code: SOURCE_UNAVAILABLE_WARNING_CODE,
        repo_id: options.repo.id,
        message: `Repo "${options.repo.id}" has no local source root; source inventory scanner skipped it.`,
      },
    ],
  };
}

async function resolveAvailableSourceRoot(options) {
  const checkoutPath = await resolveConfiguredPath({
    configuredPath: options.configuredPath,
    cwd: options.cwd,
    rootDir: options.rootDir,
  });
  const scanPath = options.applyRepoRootPath && options.repoRootPath !== '/'
    ? path.join(checkoutPath, options.repoRootPath)
    : checkoutPath;
  const sourceRoot = {
    repo_id: options.repo.id,
    kind: options.kind,
    status: 'scanned',
    path: checkoutPath,
    scan_path: scanPath,
    ...(options.repoRootPath !== '/' ? { repo_root_path: options.repoRootPath } : {}),
  };

  try {
    const scanStat = await stat(scanPath);
    if (!scanStat.isDirectory()) {
      throw new Error('not a directory');
    }
    return { sourceRoot, scanPath, warnings: options.warnings };
  } catch {
    return {
      sourceRoot: {
        ...sourceRoot,
        status: 'source_unavailable',
      },
      scanPath: null,
      warnings: [
        ...options.warnings,
        {
          code: SOURCE_UNAVAILABLE_WARNING_CODE,
          repo_id: options.repo.id,
          path: scanPath,
          message: `Repo "${options.repo.id}" source root was not readable at ${scanPath}.`,
        },
      ],
    };
  }
}

async function resolveConfiguredPath(options) {
  if (path.isAbsolute(options.configuredPath)) {
    return path.normalize(options.configuredPath);
  }

  const candidates = [
    path.resolve(options.cwd, options.configuredPath),
    path.resolve(path.dirname(options.rootDir), options.configuredPath),
    path.resolve(options.rootDir, options.configuredPath),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next likely base. The final fallback remains deterministic.
    }
  }
  return candidates[0];
}

async function scanRepoRoot(options) {
  const itemsByKey = new Map();
  const warnings = [];
  const visitedDirectories = new Set();
  let scannedFileCount = 0;
  let rootRealPath;

  try {
    rootRealPath = await realpath(options.scanPath);
  } catch {
    return {
      items: [],
      warnings: [
        {
          code: 'directory_unreadable',
          repo_id: options.repoId,
          path: '.',
          message: `Skipped unreadable source root for repo "${options.repoId}".`,
        },
      ],
    };
  }

  const pending = [rootRealPath];

  while (pending.length > 0) {
    const currentPath = pending.pop();
    let directoryRealPath;
    try {
      directoryRealPath = await realpath(currentPath);
    } catch {
      continue;
    }
    if (visitedDirectories.has(directoryRealPath)) {
      continue;
    }
    visitedDirectories.add(directoryRealPath);

    let entries;
    try {
      entries = await readdir(currentPath, { withFileTypes: true });
    } catch {
      const relativePath = toPosixPath(path.relative(rootRealPath, currentPath)) || '.';
      warnings.push({
        code: 'directory_unreadable',
        repo_id: options.repoId,
        path: relativePath,
        message: `Skipped unreadable directory ${options.repoId}:${relativePath}.`,
      });
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = toPosixPath(path.relative(rootRealPath, absolutePath));

      if (IGNORED_FILE_NAMES.has(entry.name)) {
        continue;
      }

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        pending.push(absolutePath);
        continue;
      }

      if (entry.isSymbolicLink()) {
        let targetStat;
        try {
          targetStat = await stat(absolutePath);
        } catch {
          warnings.push({
            code: 'symlink_skipped',
            repo_id: options.repoId,
            path: relativePath,
            message: `Skipped unreadable symlink ${options.repoId}:${relativePath}.`,
          });
          continue;
        }
        if (targetStat.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name)) {
            let targetRealPath;
            try {
              targetRealPath = await realpath(absolutePath);
            } catch {
              warnings.push({
                code: 'symlink_skipped',
                repo_id: options.repoId,
                path: relativePath,
                message: `Skipped unreadable symlink ${options.repoId}:${relativePath}.`,
              });
              continue;
            }
            if (!isWithinRoot(rootRealPath, targetRealPath)) {
              warnings.push({
                code: 'symlink_escapes_root',
                repo_id: options.repoId,
                path: relativePath,
                message: `Skipped symlink ${options.repoId}:${relativePath} because its target is outside the declared source root.`,
              });
              continue;
            }
            pending.push(targetRealPath);
          }
          continue;
        }
        warnings.push({
          code: 'symlink_skipped',
          repo_id: options.repoId,
          path: relativePath,
          message: `Skipped symlink ${options.repoId}:${relativePath}.`,
        });
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      scannedFileCount += 1;
      if (scannedFileCount > options.maxFiles) {
        warnings.push({
          code: 'scan_cap_reached',
          repo_id: options.repoId,
          limit: options.maxFiles,
          message: `Source inventory scan stopped after ${options.maxFiles} files for repo "${options.repoId}".`,
        });
        return {
          items: [...itemsByKey.values()],
          warnings,
        };
      }

      if (BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        warnings.push({
          code: 'binary_file_skipped',
          repo_id: options.repoId,
          path: relativePath,
          message: `Skipped binary-like file ${options.repoId}:${relativePath}.`,
        });
        continue;
      }

      let fileStat;
      try {
        fileStat = await lstat(absolutePath);
      } catch {
        warnings.push({
          code: 'file_unreadable',
          repo_id: options.repoId,
          path: relativePath,
          message: `Skipped unreadable file ${options.repoId}:${relativePath}.`,
        });
        continue;
      }
      if (fileStat.size > options.maxFileBytes) {
        warnings.push({
          code: 'large_file_skipped',
          repo_id: options.repoId,
          path: relativePath,
          size_bytes: fileStat.size,
          message: `Skipped large file ${options.repoId}:${relativePath}.`,
        });
        continue;
      }

      for (const detected of detectInventoryItems(relativePath)) {
        mergeItem(itemsByKey, createInventoryItem({
          repoId: options.repoId,
          relativePath,
          detected,
        }));
      }
    }
  }

  return {
    items: [...itemsByKey.values()],
    warnings,
  };
}

function detectInventoryItems(relativePath) {
  const segments = relativePath.split('/').filter(Boolean);
  const basename = segments.at(-1) ?? relativePath;
  const basenameNoExt = basename.replace(/\.[^.]+$/, '');
  const lowerPath = relativePath.toLowerCase();
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const hasAuthMarker = lowerSegments.some((segment) => ['auth', 'session', 'sessions', 'login', 'oauth'].includes(segment));

  const withCrossCuttingTags = (detected) => {
    if (!hasAuthMarker || detected.kind === 'auth_session') {
      return detected;
    }
    return {
      ...detected,
      tags: mergeTags(detected.tags, ['auth_session']),
    };
  };

  const provider = PROVIDERS.find((candidate) => lowerSegments.includes(candidate) || lowerPath.includes(`/${candidate}.`));
  if (provider || lowerSegments.includes('integrations') || lowerSegments.includes('integration')) {
    const logicalName = provider ?? nextSegmentAfter(lowerSegments, segments, ['integrations', 'integration']) ?? basenameNoExt;
    return [withCrossCuttingTags({
      kind: 'integration',
      logicalName,
      label: titleize(logicalName),
      confidence: provider ? 'high' : 'medium',
      reason: 'integration/provider path marker',
    })];
  }

  const apiName = detectApiName(segments);
  if (apiName) {
    return [withCrossCuttingTags({
      kind: 'api_surface',
      logicalName: apiName,
      label: `API ${apiName}`,
      confidence: 'high',
      reason: 'api route marker',
    })];
  }

  const jobName = detectJobName(segments, basenameNoExt);
  if (jobName) {
    return [withCrossCuttingTags({
      kind: 'job_task',
      logicalName: jobName,
      label: titleize(jobName),
      confidence: 'high',
      reason: 'job/task path marker',
    })];
  }

  const dataName = detectDataName(segments, basenameNoExt);
  if (dataName) {
    return [withCrossCuttingTags({
      kind: 'data_boundary',
      logicalName: dataName,
      label: titleize(dataName),
      confidence: 'high',
      reason: 'data/schema path marker',
    })];
  }

  const routeName = detectRouteName(segments);
  if (routeName) {
    return [withCrossCuttingTags({
      kind: 'route_group',
      logicalName: routeName,
      label: routeName === 'root' ? 'Root route' : `Route ${routeName}`,
      confidence: 'high',
      reason: 'route file marker',
    })];
  }

  const screenName = detectScreenName(segments, basenameNoExt);
  if (screenName) {
    return [withCrossCuttingTags({
      kind: 'screen_group',
      logicalName: screenName,
      label: titleize(screenName),
      confidence: 'high',
      reason: 'screen path marker',
    })];
  }

  const runtimeName = detectRuntimeName(segments, basename);
  if (runtimeName) {
    return [withCrossCuttingTags({
      kind: 'runtime_surface',
      logicalName: runtimeName,
      label: titleize(runtimeName),
      confidence: 'medium',
      reason: 'runtime/deploy config marker',
    })];
  }

  const platformName = detectPlatformName(segments, basenameNoExt);
  if (platformName) {
    return [withCrossCuttingTags({
      kind: 'platform_subsystem',
      logicalName: platformName,
      label: titleize(platformName),
      confidence: 'medium',
      reason: 'platform/config path marker',
    })];
  }

  if (hasAuthMarker) {
    return [{
      kind: 'auth_session',
      logicalName: 'auth session',
      label: 'Auth session',
      confidence: 'high',
      reason: 'auth/session path marker',
    }];
  }

  return [];
}

function detectApiName(segments) {
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const appIndex = lowerSegments.indexOf('app');
  const apiAfterApp = appIndex >= 0 ? lowerSegments.indexOf('api', appIndex + 1) : -1;
  if (apiAfterApp >= 0) {
    const routeSegments = cleanRouteSegments(segments.slice(apiAfterApp + 1, -1));
    return routeSegments[0] ?? 'api';
  }

  const pagesIndex = lowerSegments.indexOf('pages');
  const apiAfterPages = pagesIndex >= 0 ? lowerSegments.indexOf('api', pagesIndex + 1) : -1;
  if (apiAfterPages >= 0) {
    const routeSegments = cleanRouteSegments(segments.slice(apiAfterPages + 1));
    return routeSegments[0] ?? 'api';
  }

  const apiIndex = lowerSegments.indexOf('api');
  if (apiIndex >= 0) {
    const routeSegments = cleanRouteSegments(segments.slice(apiIndex + 1, -1));
    return routeSegments[0] ?? 'api';
  }

  return null;
}

function detectJobName(segments, basenameNoExt) {
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const markerIndex = lowerSegments.findIndex((segment) =>
    ['jobs', 'job', 'tasks', 'task', 'cron', 'worker', 'workers', 'inngest', 'trigger'].includes(segment)
  );
  if (markerIndex < 0) {
    return null;
  }
  return segments[markerIndex + 1]?.replace(/\.[^.]+$/, '') ?? basenameNoExt;
}

function detectDataName(segments, basenameNoExt) {
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  if (lowerSegments.includes('migrations')) {
    return 'migrations';
  }
  if (
    lowerSegments.includes('schema') ||
    lowerSegments.includes('schemas') ||
    lowerSegments.includes('models') ||
    lowerSegments.includes('db') ||
    lowerSegments.includes('database') ||
    basenameNoExt.toLowerCase() === 'schema'
  ) {
    return 'database schema';
  }
  return null;
}

function detectRouteName(segments) {
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const basename = lowerSegments.at(-1);
  if (!['page.tsx', 'page.ts', 'page.jsx', 'page.js'].includes(basename)) {
    return null;
  }

  const appIndex = lowerSegments.indexOf('app');
  if (appIndex >= 0) {
    return clusterRouteGroup(segments.slice(appIndex + 1, -1));
  }

  const pagesIndex = lowerSegments.indexOf('pages');
  if (pagesIndex >= 0) {
    return clusterRouteGroup(segments.slice(pagesIndex + 1, -1));
  }

  return null;
}

function detectScreenName(segments, basenameNoExt) {
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const screenIndex = lowerSegments.findIndex((segment) => ['screens', 'screen'].includes(segment));
  if (screenIndex >= 0) {
    if (screenIndex + 1 < segments.length - 1) {
      return segments[screenIndex + 1]?.replace(/\.[^.]+$/, '') ?? basenameNoExt;
    }
    return basenameNoExt.replace(/screen$/i, '') || basenameNoExt;
  }
  if (/screen$/i.test(basenameNoExt)) {
    return basenameNoExt.replace(/screen$/i, '') || basenameNoExt;
  }
  return null;
}

function detectRuntimeName(segments, basename) {
  const lowerPath = segments.join('/').toLowerCase();
  const lowerBasename = basename.toLowerCase();
  if (lowerBasename === 'package.json') return 'package runtime';
  if (lowerBasename === 'dockerfile') return 'docker runtime';
  if (lowerBasename === 'vercel.json') return 'vercel runtime';
  if (lowerBasename === 'wrangler.toml') return 'worker runtime';
  if (/^next\.config\./.test(lowerBasename)) return 'next runtime';
  if (lowerPath.startsWith('.github/workflows/')) return 'github actions';
  return null;
}

function detectPlatformName(segments, basenameNoExt) {
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  if (lowerSegments.includes('cli') || lowerSegments.includes('commands')) {
    return 'cli commands';
  }
  const configIndex = lowerSegments.findIndex((segment) => ['config', 'configs'].includes(segment));
  if (configIndex >= 0) {
    const configGroup = segments[configIndex + 1]?.replace(/\.[^.]+$/, '');
    if (configGroup && configIndex + 1 < segments.length - 1) {
      return formatConfigGroupName(configGroup);
    }
    return basenameNoExt;
  }
  return null;
}

function formatConfigGroupName(configGroup) {
  const logicalName = normalizeLogicalName(configGroup);
  if (!logicalName) {
    return null;
  }
  if (['font', 'fonts'].includes(logicalName.toLowerCase())) {
    return 'font configuration';
  }
  return `${logicalName} configuration`;
}

function createInventoryItem(options) {
  const logicalName = normalizeLogicalName(options.detected.logicalName);
  const id = `${options.repoId}:${options.detected.kind}:${slugify(logicalName)}`;
  const tags = normalizeTags(options.detected.tags);
  return {
    id,
    repo_id: options.repoId,
    kind: options.detected.kind,
    logical_name: logicalName,
    label: options.detected.label,
    confidence: options.detected.confidence,
    ...(tags.length > 0 ? { tags } : {}),
    evidence: [
      {
        path: `${options.repoId}:${options.relativePath}`,
        reason: options.detected.reason,
        ...(tags.length > 0 ? { tags } : {}),
      },
    ],
  };
}

function mergeItem(itemsByKey, item) {
  const existing = itemsByKey.get(item.id);
  if (!existing) {
    itemsByKey.set(item.id, { ...item, evidence: [...item.evidence] });
    return;
  }

  existing.tags = mergeTags(existing.tags, item.tags);
  if (existing.tags.length === 0) {
    delete existing.tags;
  }
  for (const evidence of item.evidence) {
    if (!existing.evidence.some((entry) => entry.path === evidence.path)) {
      existing.evidence.push(evidence);
    }
  }
  if (confidenceRank(item.confidence) > confidenceRank(existing.confidence)) {
    existing.confidence = item.confidence;
  }
}

function cleanRouteSegments(segments) {
  return segments
    .map((segment) => segment.replace(/\.[^.]+$/, ''))
    .filter((segment) => segment && !segment.startsWith('(') && !segment.startsWith('@'))
    .map((segment) => segment.replace(/^\[(.+)\]$/, '$1'));
}

function isWithinRoot(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function clusterRouteGroup(segments) {
  const routeSegments = segments
    .map((segment) => segment.replace(/\.[^.]+$/, ''))
    .filter((segment) => segment && !segment.startsWith('(') && !segment.startsWith('@'))
    .filter((segment) => !/^\[.+\]$/.test(segment));
  return routeSegments[0] ?? 'root';
}

function normalizeTags(value) {
  return [...new Set(Array.isArray(value) ? value.filter(Boolean) : [])].sort();
}

function mergeTags(left, right) {
  return normalizeTags([...(left ?? []), ...(right ?? [])]);
}

function nextSegmentAfter(lowerSegments, originalSegments, markers) {
  const index = lowerSegments.findIndex((segment) => markers.includes(segment));
  return index >= 0 ? originalSegments[index + 1] : null;
}

function normalizeRepoRootPath(value) {
  const normalized = normalizeOptionalString(value);
  if (!normalized || normalized === '/') {
    return '/';
  }
  return normalized.replace(/^\/+/, '').replace(/\/+$/, '') || '/';
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function normalizeLogicalName(value) {
  return String(value ?? '').trim().replaceAll('\\', '/').replace(/\/+/g, '/');
}

function slugify(value) {
  return normalizeLogicalName(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'root';
}

function titleize(value) {
  return normalizeLogicalName(value)
    .replace(/[-_/]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

function confidenceRank(value) {
  if (value === 'high') return 3;
  if (value === 'medium') return 2;
  if (value === 'low') return 1;
  return 0;
}

function countBy(items, key) {
  return (items ?? []).reduce((counts, item) => {
    const value = item?.[key];
    if (value) {
      counts[value] = (counts[value] ?? 0) + 1;
    }
    return counts;
  }, {});
}
