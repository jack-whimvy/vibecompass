import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serializeProjectConfig } from './project-yaml.js';
import { writeStateManifest } from './manifest.js';
import { withMemoryRootLock } from './serialization.js';
import { scaffoldInitFiles } from './scaffold.js';
import { applyPlacementDefaults } from './setup.js';
import { buildWorkflowMetadata } from './workflow.js';
import { parseSimpleYaml } from './simple-yaml.js';
import {
  assertValidSyncTargetName,
  buildSyncSectionWithTargets,
  mirrorTargetCursorToFlat,
  readSyncTargets,
  reconcileCursorsAfterConnect,
} from './sync-binding.js';
import { PACKAGE_VERSION } from './version.js';

const VALID_MODES = new Set(['local-only', 'local-primary', 'hosted-only']);

export async function initializeProjectMemory(options) {
  const normalized = normalizeInitOptions(options);

  if (normalized.force && !normalized.replaceActiveLanes) {
    await assertNoActiveSessionLanes(normalized.rootDir);
  }

  await mkdir(normalized.rootDir, { recursive: true });
  await mkdir(path.join(normalized.rootDir, 'architecture'), { recursive: true });
  await mkdir(path.join(normalized.rootDir, 'decisions'), { recursive: true });
  await mkdir(path.join(normalized.rootDir, 'sessions'), { recursive: true });

  const projectFilePath = path.join(normalized.rootDir, 'project.yaml');
  const gitignorePath = path.join(normalized.rootDir, '.gitignore');

  await writeProjectFile(projectFilePath, normalized.projectConfig, normalized.force);
  const gitignoreUpdated = await ensureStateIgnored(gitignorePath);
  const scaffoldResult = await scaffoldInitFiles(normalized.bootstrap);
  const manifestResult = await writeStateManifest(normalized.rootDir, {
    generatedAt: normalized.generatedAt,
  });

  return {
    rootDir: normalized.rootDir,
    projectFilePath,
    gitignorePath,
    gitignoreUpdated,
    manifestPath: manifestResult.manifestPath,
    manifest: manifestResult.manifest,
    scanResult: manifestResult.scanResult,
    syncEnvVar: normalized.projectConfig.sync?.credential_env_var ?? null,
    contextFilePath: scaffoldResult.contextFilePath,
    scaffoldCreatedFiles: scaffoldResult.createdFiles,
    scaffoldSkippedFiles: scaffoldResult.skippedFiles,
  };
}

export async function connectHostedProjectMemory(options) {
  const cwd = options?.cwd ? path.resolve(options.cwd) : process.cwd();
  const rootDir = path.resolve(cwd, options?.rootDir ?? '.compass');
  return withMemoryRootLock(rootDir, 'connect-hosted', () => connectHostedProjectMemoryLocked(options, rootDir));
}

async function connectHostedProjectMemoryLocked(options, rootDir) {
  const projectFilePath = path.join(rootDir, 'project.yaml');
  let projectConfig;
  try {
    projectConfig = parseSimpleYaml(await readFile(projectFilePath, 'utf8'), {
      sourceName: projectFilePath,
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`No project.yaml found in ${rootDir}. Run "vibecompass init" first.`);
    }

    throw error;
  }

  if (!VALID_MODES.has(projectConfig.mode)) {
    throw new Error('connect-hosted requires project.yaml mode to be local-only, local-primary, or hosted-only.');
  }

  const previousMode = projectConfig.mode;
  if (projectConfig.mode === 'local-only') {
    projectConfig.mode = 'local-primary';
  }

  const targetName = typeof options?.targetName === 'string' && options.targetName.trim() !== ''
    ? assertValidSyncTargetName(options.targetName.trim())
    : null;
  const existingTargets = readSyncTargets(projectConfig);

  if (!targetName && existingTargets) {
    throw new Error(
      `This project uses named sync targets (${Object.keys(existingTargets.targets).join(', ')}). Pass --target <name> to add or update one, or use "vibecompass sync-target <name>" to switch the default.`,
    );
  }

  const previousFlatSync = projectConfig.sync && typeof projectConfig.sync === 'object'
    ? projectConfig.sync
    : null;
  const sync = normalizeSyncOptions(options?.sync, projectConfig.mode);

  let syncTarget = null;
  if (targetName) {
    const targets = { ...(existingTargets?.targets ?? {}) };
    targets[targetName] = {
      api_url: sync.api_url,
      project_id: sync.project_id,
      credential_env_var: sync.credential_env_var,
    };
    const defaultTarget = existingTargets?.defaultTarget ?? targetName;
    projectConfig.sync = buildSyncSectionWithTargets(targets, defaultTarget);
    syncTarget = { name: targetName, defaultTarget };
  } else {
    projectConfig.sync = sync;
  }

  await writeFile(projectFilePath, serializeProjectConfig(projectConfig), 'utf8');

  // D-237: reconcile manifest cursor state with the (re)bound target —
  // first-conversion cursor migration, dropping a rebound target's stale
  // cursor, and re-mirroring/clearing the flat cursor when the default
  // target's binding changed (so ≤0.7.0 CLIs can't pair the new flat binding
  // with a previous environment's cursor).
  if (targetName) {
    await updateManifestSyncState(rootDir, (manifestSync) =>
      reconcileCursorsAfterConnect(
        manifestSync,
        targetName,
        { apiUrl: sync.api_url, projectId: sync.project_id },
        {
          isDefault: syncTarget.defaultTarget === targetName,
          isFirstConversion: !existingTargets,
          flatBindingMatches: Boolean(
            previousFlatSync &&
              previousFlatSync.api_url === sync.api_url &&
              previousFlatSync.project_id === sync.project_id,
          ),
        },
      ),
    );
  }

  return {
    rootDir,
    projectFilePath,
    mode: projectConfig.mode,
    previousMode,
    modeChanged: previousMode !== projectConfig.mode,
    syncEnvVar: sync.credential_env_var,
    syncTarget,
  };
}

async function updateManifestSyncState(rootDir, updater) {
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(path.join(rootDir, 'state', 'manifest.json'), 'utf8'),
    );
  } catch {
    return; // no manifest yet — nothing to migrate
  }

  const nextSync = updater(
    manifest?.sync && typeof manifest.sync === 'object' ? manifest.sync : {},
  );
  if (!nextSync) {
    return;
  }

  await writeStateManifest(rootDir, { sync: nextSync });
}

export async function setDefaultSyncTarget(options) {
  const cwd = options?.cwd ? path.resolve(options.cwd) : process.cwd();
  const rootDir = path.resolve(cwd, options?.rootDir ?? '.compass');
  return withMemoryRootLock(rootDir, 'sync-target', () => setDefaultSyncTargetLocked(options, rootDir));
}

async function setDefaultSyncTargetLocked(options, rootDir) {
  const projectFilePath = path.join(rootDir, 'project.yaml');
  const projectConfig = parseSimpleYaml(await readFile(projectFilePath, 'utf8'), {
    sourceName: projectFilePath,
  });

  const named = readSyncTargets(projectConfig);
  if (!named) {
    throw new Error(
      'No named sync targets are defined in project.yaml. Run "vibecompass connect-hosted --target <name>" to add one.',
    );
  }

  const targetName = typeof options?.targetName === 'string' && options.targetName.trim() !== ''
    ? options.targetName.trim()
    : null;

  if (!targetName) {
    return {
      rootDir,
      projectFilePath,
      changed: false,
      defaultTarget: named.defaultTarget,
      targets: named.targets,
    };
  }

  if (!named.targets[targetName]) {
    throw new Error(
      `Unknown sync target "${targetName}". Available targets: ${Object.keys(named.targets).join(', ')}.`,
    );
  }

  projectConfig.sync = buildSyncSectionWithTargets(named.targets, targetName);
  await writeFile(projectFilePath, serializeProjectConfig(projectConfig), 'utf8');

  // D-237: the flat manifest cursor mirrors the default target so ≤0.7.0 CLIs
  // stay correct; re-mirror it from the new default (clearing it when the new
  // default has no identity-matching cursor yet).
  await updateManifestSyncState(rootDir, (manifestSync) =>
    mirrorTargetCursorToFlat(manifestSync, targetName, {
      apiUrl: named.targets[targetName].api_url,
      projectId: named.targets[targetName].project_id,
    }),
  );

  return {
    rootDir,
    projectFilePath,
    changed: named.defaultTarget !== targetName,
    defaultTarget: targetName,
    targets: named.targets,
  };
}

function normalizeInitOptions(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('initializeProjectMemory requires an options object.');
  }

  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const preparedOptions = applyPlacementDefaults(options, { cwd });
  const rootDir = path.resolve(cwd, preparedOptions.rootDir ?? '.compass');
  const toolingRootDir = preparedOptions.toolingRootDir
    ? path.resolve(cwd, preparedOptions.toolingRootDir)
    : cwd;

  if (typeof preparedOptions.name !== 'string' || preparedOptions.name.trim() === '') {
    throw new Error(
      'init requires a non-empty project name. Run guided setup with `vibecompass init --guided`, or provide `--name <project-name>`.',
    );
  }

  if (typeof preparedOptions.mode !== 'string' || !VALID_MODES.has(preparedOptions.mode)) {
    throw new Error('init requires mode to be local-only, local-primary, or hosted-only.');
  }

  if (!Array.isArray(preparedOptions.repos) || preparedOptions.repos.length === 0) {
    throw new Error('init requires at least one repo descriptor.');
  }

  const seenRepoIds = new Set();
  const repos = preparedOptions.repos.map((repo, index) => {
    if (!repo || typeof repo !== 'object') {
      throw new Error(`repo ${index + 1} must be an object.`);
    }

    if (typeof repo.id !== 'string' || repo.id.trim() === '') {
      throw new Error(`repo ${index + 1} requires a non-empty id.`);
    }

    if (seenRepoIds.has(repo.id)) {
      throw new Error(`repo id "${repo.id}" was provided more than once.`);
    }
    seenRepoIds.add(repo.id);

    const source = typeof repo.source === 'string' && repo.source.trim() !== ''
      ? repo.source.trim()
      : null;
    const pathValue = typeof repo.path === 'string' && repo.path.trim() !== ''
      ? repo.path.trim()
      : null;
    const remote = typeof repo.remote === 'string' ? repo.remote.trim() : '';

    if (source && !['git', 'local'].includes(source)) {
      throw new Error(`repo "${repo.id}" source must be git or local.`);
    }

    if (source === 'local' || (!source && !remote && pathValue)) {
      if (!['local-only', 'local-primary'].includes(preparedOptions.mode)) {
        throw new Error(`repo "${repo.id}" local sources are supported only in local-only or local-primary mode.`);
      }

      if (!pathValue) {
        throw new Error(`repo "${repo.id}" source local requires a non-empty path.`);
      }

      return {
        id: repo.id,
        source: 'local',
        path: pathValue,
      };
    }

    if (!remote) {
      throw new Error(`repo "${repo.id}" requires a non-empty remote, or use a local repo source with source: local and path.`);
    }

    return {
      id: repo.id,
      ...(source === 'git' ? { source: 'git' } : {}),
      remote,
      ...(repo.defaultBranch ? { default_branch: repo.defaultBranch } : {}),
    };
  });

  const sync = preparedOptions.sync
    ? normalizeSyncOptions(preparedOptions.sync, preparedOptions.mode)
    : undefined;

  const projectConfig = {
    format_version: 1,
    name: preparedOptions.name.trim(),
    ...(preparedOptions.slug ? { slug: preparedOptions.slug } : {}),
    ...(preparedOptions.description ? { description: preparedOptions.description } : {}),
    mode: preparedOptions.mode,
    repos,
    ...(sync ? { sync } : {}),
    metadata: buildAgentFilesMetadata(buildWorkflowMetadata({
      ...(preparedOptions.metadata && typeof preparedOptions.metadata === 'object' ? preparedOptions.metadata : {}),
      package_version: PACKAGE_VERSION,
    }, {
      gitPublish:
        typeof preparedOptions.closeSessionGitPublish === 'boolean'
          ? preparedOptions.closeSessionGitPublish
          : undefined,
      gitRemote: preparedOptions.closeSessionGitRemote,
    })),
  };

  const bootstrapOptions = normalizeBootstrapOptions(preparedOptions.bootstrap, {
    rootDir,
    toolingRootDir,
    projectConfig,
    generatedAt: preparedOptions.generatedAt,
  });

  return {
    rootDir,
    force: Boolean(preparedOptions.force),
    replaceActiveLanes: Boolean(preparedOptions.replaceActiveLanes),
    generatedAt: preparedOptions.generatedAt,
    projectConfig,
    bootstrap: bootstrapOptions,
  };
}

async function assertNoActiveSessionLanes(rootDir) {
  const activeDir = path.join(rootDir, 'sessions', 'active');
  let entries = [];
  try {
    entries = await readdir(activeDir, { withFileTypes: true });
  } catch {
    return;
  }

  const activeLaneIds = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const laneDir = path.join(activeDir, entry.name);
    if (
      (await fileExists(path.join(laneDir, 'session.yaml'))) ||
      (await fileExists(path.join(laneDir, 'wip.md')))
    ) {
      activeLaneIds.push(entry.name);
    }
  }

  if (activeLaneIds.length > 0) {
    throw new Error(
      `Cannot overwrite project memory while active session lanes exist: ${activeLaneIds.join(', ')}. Close the lanes first or pass --replace-active-lanes.`,
    );
  }
}

function normalizeSyncOptions(syncOptions, mode) {
  if (!syncOptions || typeof syncOptions !== 'object') {
    throw new Error('sync configuration must be an object.');
  }

  if (!['local-primary', 'hosted-only'].includes(mode)) {
    throw new Error('sync configuration is only supported when mode is local-primary or hosted-only.');
  }

  const requiredFields = ['apiUrl', 'projectId', 'credentialEnvVar'];
  const missing = requiredFields.filter((field) => typeof syncOptions[field] !== 'string' || syncOptions[field].trim() === '');

  if (missing.length > 0) {
    throw new Error(
      `sync configuration is incomplete. Missing: ${missing.join(', ')}.`,
    );
  }

  return {
    provider: 'vibecompass',
    api_url: syncOptions.apiUrl,
    project_id: syncOptions.projectId,
    credential_source: 'env',
    credential_env_var: syncOptions.credentialEnvVar,
  };
}

function buildAgentFilesMetadata(metadata) {
  const existingAgentFiles = metadata?.agent_files && typeof metadata.agent_files === 'object'
    ? metadata.agent_files
    : {};

  return {
    ...metadata,
    agent_files: {
      claude_md: existingAgentFiles.claude_md !== false,
      agents_md: existingAgentFiles.agents_md !== false,
      cursor_rules: existingAgentFiles.cursor_rules !== false,
      copilot_instructions: existingAgentFiles.copilot_instructions !== false,
      windsurf_rules: existingAgentFiles.windsurf_rules === true,
      gemini_md: existingAgentFiles.gemini_md === true,
    },
  };
}

function normalizeBootstrapOptions(bootstrap, context) {
  const requested = bootstrap && typeof bootstrap === 'object' ? bootstrap : {};
  const workflow = Boolean(requested.workflow || requested.claude || requested.agents);
  const contextFilePath = path.join(context.rootDir, 'context.md');

  return {
    workflow,
    claude: Boolean(requested.claude),
    agents: Boolean(requested.agents),
    rootDir: context.rootDir,
    toolingRootDir: context.toolingRootDir,
    projectConfig: context.projectConfig,
    rootRelativePath: toPosix(path.relative(context.toolingRootDir, context.rootDir) || '.'),
    contextRelativeToToolingRoot: toPosix(
      path.relative(context.toolingRootDir, contextFilePath) || 'context.md',
    ),
    generatedAt: context.generatedAt,
  };
}

async function writeProjectFile(projectFilePath, projectConfig, force) {
  if (!force && (await fileExists(projectFilePath))) {
    throw new Error(`project.yaml already exists at ${projectFilePath}. Use --force to overwrite it.`);
  }

  const source = serializeProjectConfig(projectConfig);
  await writeFile(projectFilePath, source, 'utf8');
}

async function ensureStateIgnored(gitignorePath) {
  const stateEntry = 'state/';

  if (!(await fileExists(gitignorePath))) {
    await writeFile(gitignorePath, `${stateEntry}\n`, 'utf8');
    return true;
  }

  const current = await readFile(gitignorePath, 'utf8');
  const entries = current.split(/\r?\n/).map((line) => line.trim());
  if (entries.includes(stateEntry)) {
    return false;
  }

  const separator = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
  await writeFile(gitignorePath, `${current}${separator}${stateEntry}\n`, 'utf8');
  return true;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}
