import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serializeProjectConfig } from './project-yaml.js';
import { writeStateManifest } from './manifest.js';

const VALID_MODES = new Set(['local-only', 'local-primary', 'hosted-only']);

export async function initializeProjectMemory(options) {
  const normalized = normalizeInitOptions(options);

  await mkdir(normalized.rootDir, { recursive: true });
  await mkdir(path.join(normalized.rootDir, 'architecture'), { recursive: true });
  await mkdir(path.join(normalized.rootDir, 'decisions'), { recursive: true });
  await mkdir(path.join(normalized.rootDir, 'sessions'), { recursive: true });

  const projectFilePath = path.join(normalized.rootDir, 'project.yaml');
  const gitignorePath = path.join(normalized.rootDir, '.gitignore');

  await writeProjectFile(projectFilePath, normalized.projectConfig, normalized.force);
  const gitignoreUpdated = await ensureStateIgnored(gitignorePath);
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
  };
}

function normalizeInitOptions(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('initializeProjectMemory requires an options object.');
  }

  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const rootDir = path.resolve(cwd, options.rootDir ?? '.compass');

  if (typeof options.name !== 'string' || options.name.trim() === '') {
    throw new Error('init requires a non-empty project name.');
  }

  if (typeof options.mode !== 'string' || !VALID_MODES.has(options.mode)) {
    throw new Error('init requires mode to be local-only, local-primary, or hosted-only.');
  }

  if (!Array.isArray(options.repos) || options.repos.length === 0) {
    throw new Error('init requires at least one repo descriptor.');
  }

  const seenRepoIds = new Set();
  const repos = options.repos.map((repo, index) => {
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

    if (typeof repo.remote !== 'string' || repo.remote.trim() === '') {
      throw new Error(`repo "${repo.id}" requires a non-empty remote.`);
    }

    return {
      id: repo.id,
      remote: repo.remote,
      ...(repo.defaultBranch ? { default_branch: repo.defaultBranch } : {}),
    };
  });

  const syncOptions = options.sync ?? null;
  let sync = undefined;
  if (syncOptions) {
    const requiredFields = ['apiUrl', 'projectId', 'credentialEnvVar'];
    const missing = requiredFields.filter((field) => typeof syncOptions[field] !== 'string' || syncOptions[field].trim() === '');

    if (missing.length > 0) {
      throw new Error(
        `sync configuration is incomplete. Missing: ${missing.join(', ')}.`,
      );
    }

    sync = {
      provider: 'vibecompass',
      api_url: syncOptions.apiUrl,
      project_id: syncOptions.projectId,
      credential_source: 'env',
      credential_env_var: syncOptions.credentialEnvVar,
    };
  }

  const projectConfig = {
    format_version: 1,
    name: options.name.trim(),
    ...(options.slug ? { slug: options.slug } : {}),
    ...(options.description ? { description: options.description } : {}),
    mode: options.mode,
    repos,
    ...(sync ? { sync } : {}),
  };

  return {
    rootDir,
    force: Boolean(options.force),
    generatedAt: options.generatedAt,
    projectConfig,
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
