import { execFile } from 'node:child_process';
import { access, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';
import { getSupportedAgentFilePaths } from './generators/agent-files/index.js';
import { END_MARKER, START_MARKER } from './generators/agent-files/markers.js';
import { parseSimpleYaml } from './simple-yaml.js';

const execFileAsync = promisify(execFile);

export const PLACEMENT_PATTERNS = {
  WORKSPACE_ROOT: 'workspace-root',
  DEDICATED_MEMORY_REPO: 'dedicated-memory-repo',
  PRIMARY_REPO: 'primary-repo',
};

export const VALID_PLACEMENT_PATTERNS = new Set(Object.values(PLACEMENT_PATTERNS));

export async function resolveInitCliOptions(options, environment = {}) {
  const cwd = environment.cwd ? path.resolve(environment.cwd) : process.cwd();
  let resolved = cloneInitOptions(options);
  let guidedSummary = null;

  if (resolved.guided) {
    if (!resolved.force) {
      const existingProject = await resolveExistingGuidedProject(resolved, {
        cwd,
        io: environment.io,
        runtime: environment.runtime,
      });
      if (existingProject) {
        return {
          existingProject,
          initOptions: null,
          placementPattern: null,
          guidedSummary: null,
          agentFileSyncPlan: null,
          sessionPlan: null,
        };
      }
    }

    const prompter = createPrompter(environment.io, environment.runtime);
    try {
      const guided = await completeGuidedInitOptions(resolved, {
        cwd,
        prompter,
      });
      resolved = guided.options;
      guidedSummary = guided.summary;
    } finally {
      await prompter.close();
    }
  }

  resolved = applyPlacementDefaults(resolved, { cwd });
  ensureSessionBootstrap(resolved);

  if (resolved.closeSessionGitRemote && resolved.closeSessionGitPublish === undefined) {
    resolved.closeSessionGitPublish = true;
  }

  if (resolved.startSession && !resolved.sessionWorkingOn) {
    throw new Error('init requires --session-working-on when --start-session is used without guided setup.');
  }

  if (resolved.startSession && !resolved.sessionId) {
    throw new Error('init requires --session-id when --start-session is used.');
  }

  return {
    initOptions: {
      rootDir: resolved.rootDir,
      toolingRootDir: resolved.toolingRootDir,
      name: resolved.name,
      slug: resolved.slug,
      description: resolved.description,
      mode: resolved.mode,
      repos: resolved.repos,
      force: resolved.force,
      replaceActiveLanes: resolved.replaceActiveLanes,
      sync: resolved.sync,
      bootstrap: resolved.bootstrap,
      generatedAt: resolved.generatedAt,
      metadata: resolved.metadata,
      closeSessionGitPublish: resolved.closeSessionGitPublish,
      closeSessionGitRemote: resolved.closeSessionGitRemote,
      placementPattern: resolved.placementPattern,
    },
    placementPattern: resolved.placementPattern ?? null,
    guidedSummary,
    agentFileSyncPlan: resolved.adoptExistingAgentFiles
      ? {
          rootDir: resolved.rootDir,
          toolingRootDir: resolved.toolingRootDir,
          adoptExisting: true,
          existingOnly: true,
        }
      : null,
    sessionPlan: resolved.startSession
      ? {
          sessionId: resolved.sessionId,
          workingOn: resolved.sessionWorkingOn,
        }
      : null,
  };
}

export async function resolveConnectHostedCliOptions(options, environment = {}) {
  const cwd = environment.cwd ? path.resolve(environment.cwd) : process.cwd();
  let resolved = {
    ...options,
    sync: isPlainObject(options?.sync) ? { ...options.sync } : {},
  };

  if (!resolved.sync.apiUrl || !resolved.sync.projectId || !resolved.sync.credentialEnvVar) {
    const prompter = createPrompter(environment.io, environment.runtime);
    try {
      if (!resolved.sync.apiUrl) {
        resolved.sync.apiUrl = await askInput(prompter, 'Hosted sync API URL', {
          defaultValue: 'https://vibecompass.dev',
        });
      }
      if (!resolved.sync.projectId) {
        resolved.sync.projectId = await askInput(prompter, 'Hosted project id');
      }
      if (!resolved.sync.credentialEnvVar) {
        resolved.sync.credentialEnvVar = await askInput(prompter, 'Credential env var', {
          defaultValue: 'VIBECOMPASS_SYNC_TOKEN',
        });
      }
    } finally {
      await prompter.close();
    }
  }

  return {
    rootDir: resolved.rootDir ? toRelativeIfInsideCwd(resolved.rootDir, cwd) : undefined,
    sync: resolved.sync,
  };
}

async function resolveExistingGuidedProject(options, environment) {
  const candidates = await findExistingGuidedProjectRoots(options, environment.cwd);
  if (candidates.length === 0) {
    return null;
  }

  if (candidates.length === 1) {
    return readExistingGuidedProject(candidates[0], environment.cwd);
  }

  if (!canPrompt(environment)) {
    return {
      status: 'ambiguous',
      candidates,
    };
  }

  const prompter = createPrompter(environment.io, environment.runtime);
  try {
    const selectedRootDir = await askChoice(
      prompter,
      'Multiple VibeCompass project memory roots found. Which one should be shown? No files will be modified.',
      candidates.map((candidate) => ({
        value: candidate.rootDir,
        description: candidate.displayPath,
      })),
      {
        defaultValue: candidates[0].rootDir,
      },
    );
    return readExistingGuidedProject(
      candidates.find((candidate) => candidate.rootDir === selectedRootDir) ?? candidates[0],
      environment.cwd,
    );
  } finally {
    await prompter.close();
  }
}

async function findExistingGuidedProjectRoots(options, cwd) {
  const candidateRoots = options.rootDir
    ? [path.resolve(cwd, options.rootDir)]
    : [path.resolve(cwd, '.compass'), path.resolve(cwd)];

  const existing = [];
  for (const rootDir of [...new Set(candidateRoots)]) {
    if (await fileExists(path.join(rootDir, 'project.yaml'))) {
      existing.push({
        rootDir,
        displayPath: toRelativeIfInsideCwd(rootDir, cwd),
      });
    }
  }

  return existing;
}

async function readExistingGuidedProject(candidate, cwd) {
  const projectFilePath = path.join(candidate.rootDir, 'project.yaml');
  const activeSummary = await readActiveLaneSummary(candidate.rootDir);
  try {
    const projectConfig = parseSimpleYaml(await readFile(projectFilePath, 'utf8'), {
      sourceName: projectFilePath,
    });

    return {
      status: 'ok',
      rootDir: candidate.rootDir,
      displayPath: candidate.displayPath ?? toRelativeIfInsideCwd(candidate.rootDir, cwd),
      projectFilePath,
      projectConfig,
      activeSummary,
    };
  } catch (error) {
    return {
      status: 'unreadable',
      rootDir: candidate.rootDir,
      displayPath: candidate.displayPath ?? toRelativeIfInsideCwd(candidate.rootDir, cwd),
      projectFilePath,
      errorMessage: error instanceof Error ? error.message : 'Unable to read project.yaml.',
      activeSummary,
    };
  }
}

async function readActiveLaneSummary(rootDir) {
  const activeDir = path.join(rootDir, 'sessions', 'active');
  let count = 0;
  try {
    const entries = await readdir(activeDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const laneDir = path.join(activeDir, entry.name);
      if (
        (await fileExists(path.join(laneDir, 'session.yaml'))) ||
        (await fileExists(path.join(laneDir, 'wip.md')))
      ) {
        count += 1;
      }
    }
  } catch {
    count = 0;
  }

  let current = null;
  try {
    const indexPath = path.join(activeDir, 'index.yaml');
    const activeIndex = parseSimpleYaml(await readFile(indexPath, 'utf8'), {
      sourceName: indexPath,
    });
    current = typeof activeIndex.current === 'string' && activeIndex.current !== 'null'
      ? activeIndex.current
      : null;
  } catch {
    current = null;
  }

  return { count, current };
}

function canPrompt(environment) {
  if (typeof environment.runtime?.prompt === 'function') {
    return true;
  }

  const input = environment.runtime?.stdin ?? environment.io?.stdin ?? process.stdin;
  return Boolean(input?.isTTY);
}

export function applyPlacementDefaults(options, environment = {}) {
  const cwd = environment.cwd ? path.resolve(environment.cwd) : process.cwd();
  const resolved = cloneInitOptions(options);

  if (resolved.placementPattern && !VALID_PLACEMENT_PATTERNS.has(resolved.placementPattern)) {
    throw new Error(
      `init placement must be one of ${[...VALID_PLACEMENT_PATTERNS].join(', ')}.`,
    );
  }

  if (!resolved.placementPattern) {
    return resolved;
  }

  const ownerDir = resolved.toolingRootDir ?? '.';
  if (!resolved.rootDir) {
    resolved.rootDir =
      resolved.placementPattern === PLACEMENT_PATTERNS.DEDICATED_MEMORY_REPO
        ? ownerDir
        : path.join(ownerDir, '.compass');
  }

  if (!resolved.toolingRootDir) {
    resolved.toolingRootDir = ownerDir;
  }

  const existingMetadata = isPlainObject(resolved.metadata) ? resolved.metadata : {};
  const existingSetup = isPlainObject(existingMetadata.setup) ? existingMetadata.setup : {};
  resolved.metadata = {
    ...existingMetadata,
    setup: {
      ...existingSetup,
      placement_pattern: resolved.placementPattern,
    },
  };

  // Keep relative paths relative to the current CLI cwd; initializeProjectMemory resolves them later.
  if (resolved.rootDir) {
    resolved.rootDir = toRelativeIfInsideCwd(resolved.rootDir, cwd);
  }

  if (resolved.toolingRootDir) {
    resolved.toolingRootDir = toRelativeIfInsideCwd(resolved.toolingRootDir, cwd);
  }

  return resolved;
}

export function recommendPlacementPattern(context) {
  if (context.repoCount <= 1) {
    return {
      pattern: PLACEMENT_PATTERNS.PRIMARY_REPO,
      reason: 'Single-repo projects usually fit best when project memory lives alongside the primary codebase.',
    };
  }

  if (context.hasPrimaryRepo) {
    return {
      pattern: PLACEMENT_PATTERNS.PRIMARY_REPO,
      reason: 'One repo clearly owns the product center of gravity, so colocating project memory there is the best default.',
    };
  }

  if (context.usesSharedWorkspace) {
    return {
      pattern: PLACEMENT_PATTERNS.WORKSPACE_ROOT,
      reason: 'You already work from a shared multi-repo checkout, so a workspace-root `.compass/` keeps the shared memory close to that workflow.',
    };
  }

  return {
    pattern: PLACEMENT_PATTERNS.DEDICATED_MEMORY_REPO,
    reason: 'No single repo owns the product and there is no shared checkout to anchor on, so a dedicated memory repo is the safest default.',
  };
}

async function completeGuidedInitOptions(options, environment) {
  let resolved = cloneInitOptions(options);
  const cwd = environment.cwd;
  const prompter = environment.prompter;
  const inferredProject = await inferProjectFromCwd(cwd);
  const projectNameDefault = inferredProject.projectName ?? path.basename(cwd);

  if (!resolved.name) {
    resolved.name = await askInput(prompter, 'Project name', {
      defaultValue: projectNameDefault,
    });
  }

  if (!resolved.mode) {
    const setupGoal = await askChoice(prompter, 'What should VibeCompass set up?', [
      {
        value: 'share-later',
        description: 'Recommended. Local notes, with the option to share or collaborate later.',
      },
      {
        value: 'local-only',
        description: 'Local files only. No hosted sync or hosted docs-review prompts.',
      },
      {
        value: 'hosted-only',
        description: 'Hosted VibeCompass is already the source of truth for this project.',
      },
    ], {
      defaultValue: 'share-later',
    });
    resolved.mode = setupGoal === 'share-later' ? 'local-primary' : setupGoal;
  }

  const detectedRepos = inferredProject.repos ?? [];

  if (!Array.isArray(resolved.repos) || resolved.repos.length === 0) {
    if (detectedRepos.length > 0) {
      const useDetectedRepos = await askConfirm(
        prompter,
        formatDetectedReposPrompt(detectedRepos),
        true,
      );
      resolved.repos = useDetectedRepos
        ? detectedRepos.map((repo) => toProjectRepo(repo))
        : await promptForRepos(prompter, cwd);
    } else {
      resolved.repos = await promptForRepos(prompter, cwd);
    }
  }

  let recommendation = null;
  if (!resolved.placementPattern) {
    if (inferredProject.source === 'child-repos' && detectedRepos.length > 1 && reposMatchDetected(resolved.repos, detectedRepos)) {
      recommendation = recommendPlacementPattern({
        repoCount: detectedRepos.length,
        usesSharedWorkspace: true,
      });
      resolved.placementPattern = recommendation.pattern;
      prompter.write(`Recommended placement: ${recommendation.pattern}\n`);
      prompter.write(`${recommendation.reason}\n`);
    } else if (detectedRepos.length === 1 && reposMatchDetected(resolved.repos, detectedRepos)) {
      recommendation = recommendPlacementPattern({ repoCount: 1 });
      resolved.placementPattern = recommendation.pattern;
    } else {
      recommendation = await promptForPlacement(prompter, {
        cwd,
        repoCount: resolved.repos.length,
      });
      resolved.placementPattern = recommendation.pattern;
    }
  }

  if (!resolved.toolingRootDir) {
    if (resolved.placementPattern === PLACEMENT_PATTERNS.PRIMARY_REPO && detectedRepos.length === 1 && reposMatchDetected(resolved.repos, detectedRepos)) {
      resolved.toolingRootDir = detectedRepos[0].directory;
    } else if (resolved.placementPattern === PLACEMENT_PATTERNS.WORKSPACE_ROOT && inferredProject.source === 'child-repos' && detectedRepos.length > 1 && reposMatchDetected(resolved.repos, detectedRepos)) {
      resolved.toolingRootDir = '.';
    } else {
      const ownerLabel = describePlacementOwner(resolved.placementPattern);
      const defaultOwnerDir = await suggestOwnerDirectory({
        cwd,
        placementPattern: resolved.placementPattern,
        repos: resolved.repos,
      });
      resolved.toolingRootDir = await askInput(prompter, ownerLabel, {
        defaultValue: defaultOwnerDir,
        validate: async (value) => {
          if (!(await directoryExists(path.resolve(cwd, value)))) {
            return `${ownerLabel} must already exist relative to the current working directory.`;
          }

          return null;
        },
      });
    }
  }

  resolved = applyPlacementDefaults(resolved, { cwd });

  if (!resolved.sync && resolved.mode === 'hosted-only') {
    const configureSync = await askConfirm(
      prompter,
      'Connect hosted VibeCompass now?',
      resolved.mode === 'hosted-only',
    );

    if (configureSync) {
      resolved.sync = {
        apiUrl: await askInput(prompter, 'Hosted sync API URL', {
          defaultValue: 'https://vibecompass.dev',
        }),
        projectId: await askInput(prompter, 'Hosted project id'),
        credentialEnvVar: await askInput(prompter, 'Credential env var', {
          defaultValue: 'VIBECOMPASS_SYNC_TOKEN',
        }),
      };
    }
  }

  if (!resolved.bootstrap) {
    resolved.bootstrap = {};
  }

  if (
    resolved.bootstrap.workflow === undefined &&
    resolved.bootstrap.claude === undefined &&
    resolved.bootstrap.agents === undefined
  ) {
    const wantsWorkflow = await askConfirm(
      prompter,
      'Scaffold workflow files (context.md plus guide READMEs)?',
      true,
    );

    if (wantsWorkflow) {
      resolved.bootstrap.workflow = true;
      resolved.bootstrap.claude = await askConfirm(
        prompter,
        'Create a starter CLAUDE.md if missing?',
        true,
      );
      resolved.bootstrap.agents = await askConfirm(
        prompter,
        'Create a starter AGENTS.md if missing?',
        true,
      );
    }
  }

  if (resolved.adoptExistingAgentFiles === undefined) {
    const adoptionCandidates = await findExistingUnmarkedAgentFiles({
      cwd,
      toolingRootDir: resolved.toolingRootDir,
    });

    if (adoptionCandidates.length > 0) {
      writeAgentAdoptionPreview(prompter, adoptionCandidates);
      resolved.adoptExistingAgentFiles = await askConfirm(
        prompter,
        'Append VibeCompass managed sections to existing agent instruction files?',
        false,
      );
    }
  }

  if (!resolved.startSession) {
    resolved.startSession = await askConfirm(
      prompter,
      'Open the first builder session immediately after init?',
      false,
    );
  }

  let autoEnabledSessionBootstrap = false;
  if (resolved.startSession) {
    if (!resolved.bootstrap.workflow || !resolved.bootstrap.claude) {
      resolved.bootstrap.workflow = true;
      resolved.bootstrap.claude = true;
      autoEnabledSessionBootstrap = true;
    }

    if (!resolved.sessionWorkingOn) {
      resolved.sessionWorkingOn = await askInput(prompter, 'What are you working on?');
    }

    if (!resolved.sessionId) {
      resolved.sessionId = await askInput(prompter, 'Session lane id', {
        defaultValue: suggestLaneId(resolved.sessionWorkingOn),
        validate(value) {
          return validateLaneIdForPrompt(value);
        },
      });
    }
  }

  if (resolved.closeSessionGitPublish === undefined && (resolved.bootstrap.workflow || resolved.startSession)) {
    resolved.closeSessionGitPublish = await askConfirm(
      prompter,
      'Should close-session include a Git publish step?',
      false,
    );
  }

  if (resolved.closeSessionGitPublish && !resolved.closeSessionGitRemote) {
    resolved.closeSessionGitRemote = await askInput(
      prompter,
      'Git remote for the close-session publish step',
      {
        defaultValue: 'origin',
      },
    );
  }

  return {
    options: resolved,
    summary: {
      recommendedPlacementPattern: recommendation?.pattern ?? null,
      recommendationReason: recommendation?.reason ?? null,
      autoEnabledSessionBootstrap,
    },
  };
}

async function inferProjectFromCwd(cwd) {
  const [packageName, gitInfo, childRepos] = await Promise.all([
    readPackageName(cwd),
    readGitInfo(cwd),
    discoverChildGitRepos(cwd),
  ]);
  const projectName = packageName ?? path.basename(cwd);

  if (gitInfo?.remote) {
    const remoteSlug = extractRemoteSlug(gitInfo.remote);
    const repoId = suggestRepoId(remoteSlug ?? packageName ?? path.basename(gitInfo.root ?? cwd));

    return {
      projectName,
      source: 'current-repo',
      repos: [
        {
          id: repoId,
          remote: gitInfo.remote,
          directory: '.',
          ...(gitInfo.branch ? { defaultBranch: gitInfo.branch } : {}),
        },
      ],
    };
  }

  if (childRepos.length > 0) {
    return {
      projectName,
      source: 'child-repos',
      repos: childRepos,
    };
  }

  return {
    projectName,
    source: 'none',
    repos: [],
  };
}

async function readPackageName(cwd) {
  try {
    const packageJson = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8'));
    return typeof packageJson.name === 'string' && packageJson.name.trim()
      ? packageJson.name.trim()
      : null;
  } catch {
    return null;
  }
}

async function readGitInfo(cwd) {
  try {
    const [{ stdout: remote }, { stdout: root }, branchResult] = await Promise.all([
      execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd }),
      execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd }),
      execFileAsync('git', ['branch', '--show-current'], { cwd }).catch(() => ({ stdout: '' })),
    ]);
    const normalizedRemote = remote.trim();
    if (!normalizedRemote) {
      return null;
    }

    return {
      remote: normalizedRemote,
      root: root.trim() || null,
      branch: branchResult.stdout.trim() || null,
    };
  } catch {
    return null;
  }
}

async function discoverChildGitRepos(cwd) {
  let entries = [];
  try {
    entries = await readdir(cwd, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates = entries
    .filter((entry) => entry.isDirectory() && isScannableWorkspaceChild(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));

  const discovered = await Promise.all(candidates.map(async (entry) => {
    const directory = entry.name;
    const absoluteDirectory = path.join(cwd, directory);
    const [gitInfo, packageName] = await Promise.all([
      readGitInfo(absoluteDirectory),
      readPackageName(absoluteDirectory),
    ]);

    if (!gitInfo?.remote) {
      return null;
    }

    if (gitInfo.root && !(await isSameDirectory(gitInfo.root, absoluteDirectory))) {
      return null;
    }

    const remoteSlug = extractRemoteSlug(gitInfo.remote);
    return {
      id: suggestRepoId(remoteSlug ?? packageName ?? directory),
      remote: gitInfo.remote,
      directory,
      ...(gitInfo.branch ? { defaultBranch: gitInfo.branch } : {}),
    };
  }));

  const reposByDirectory = new Map();
  for (const repo of discovered) {
    if (repo && !reposByDirectory.has(repo.directory)) {
      reposByDirectory.set(repo.directory, repo);
    }
  }

  return [...reposByDirectory.values()].sort((left, right) => left.directory.localeCompare(right.directory));
}

function isScannableWorkspaceChild(name) {
  if (!name || name.startsWith('.')) {
    return false;
  }

  return !new Set([
    'build',
    'coverage',
    'dist',
    'node_modules',
    'out',
    'target',
    'vendor',
  ]).has(name);
}

function formatDetectedReposPrompt(repos) {
  if (repos.length === 1) {
    const repo = repos[0];
    const location = repo.directory && repo.directory !== '.' ? ` in ${repo.directory}` : '';
    return `Use detected Git repo${location} (${repo.remote})?`;
  }

  return `Use ${repos.length} detected Git repos (${repos.map((repo) => repo.directory).join(', ')})?`;
}

function toProjectRepo(repo) {
  return {
    id: repo.id,
    remote: repo.remote,
    ...(repo.defaultBranch ? { defaultBranch: repo.defaultBranch } : {}),
  };
}

function reposMatchDetected(repos, detectedRepos) {
  if (!Array.isArray(repos) || repos.length !== detectedRepos.length) {
    return false;
  }

  const detectedKeys = new Set(detectedRepos.map((repo) => `${repo.id}\n${repo.remote}`));
  return repos.every((repo) => detectedKeys.has(`${repo.id}\n${repo.remote}`));
}

async function findExistingUnmarkedAgentFiles(context) {
  const toolingRootDir = path.resolve(context.cwd, context.toolingRootDir ?? '.');
  const candidates = [];

  for (const relativePath of getSupportedAgentFilePaths()) {
    const filePath = path.join(toolingRootDir, relativePath);
    let content = null;
    try {
      content = await readFile(filePath, 'utf8');
    } catch {
      continue;
    }

    if (content.includes(START_MARKER) || content.includes(END_MARKER)) {
      continue;
    }

    candidates.push({
      relativePath,
      conflicts: scanPotentialAgentWorkflowConflicts(content),
    });
  }

  return candidates;
}

function writeAgentAdoptionPreview(prompter, candidates) {
  prompter.write('Existing agent instruction files without VibeCompass markers:\n');
  for (const candidate of candidates) {
    prompter.write(`- ${candidate.relativePath}: VibeCompass can append a managed block at the end of this file.\n`);
    if (candidate.conflicts.length > 0) {
      prompter.write(`  possible workflow overlap on lines ${candidate.conflicts.map((conflict) => conflict.line).join(', ')}\n`);
    }
  }
  prompter.write('Content outside the managed block stays user-owned and will not be rewritten.\n');
}

function scanPotentialAgentWorkflowConflicts(content) {
  const patterns = [
    'session',
    'handoff',
    'decisions',
    'wip.md',
    'review handoff',
    'close-session',
    'address review',
    'builder',
    'reviewer',
  ];

  return content
    .split(/\r?\n/)
    .map((line, index) => ({
      line: index + 1,
      normalized: line.toLowerCase(),
    }))
    .filter((entry) => patterns.some((pattern) => entry.normalized.includes(pattern)));
}

async function promptForRepos(prompter, cwd) {
  const repoCount = await askInteger(prompter, 'How many repos belong to this logical project?', {
    defaultValue: 1,
    min: 1,
  });
  const repoIdDefault = suggestRepoId(path.basename(cwd));
  const repos = [];

  for (let index = 0; index < repoCount; index += 1) {
    const ordinal = index + 1;
    const repo = {
      id: await askInput(prompter, `Repo ${ordinal} id`, {
        defaultValue: repoCount === 1 ? repoIdDefault : `repo-${ordinal}`,
      }),
      remote: await askInput(prompter, `Repo ${ordinal} remote`),
    };

    const defaultBranch = await askOptionalInput(prompter, `Repo ${ordinal} default branch`);
    if (defaultBranch) {
      repo.defaultBranch = defaultBranch;
    }

    repos.push(repo);
  }

  return repos;
}

async function promptForPlacement(prompter, context) {
  let topology = {
    repoCount: context.repoCount,
    usesSharedWorkspace: false,
    hasPrimaryRepo: false,
  };

  if (context.repoCount > 1) {
    topology.usesSharedWorkspace = await askConfirm(
      prompter,
      'Do you already work from a shared multi-repo workspace checkout?',
      true,
    );
    topology.hasPrimaryRepo = await askConfirm(
      prompter,
      'Does one repo clearly act as the product center of gravity?',
      false,
    );
  }

  const recommendation = recommendPlacementPattern(topology);
  prompter.write(`Recommended placement: ${recommendation.pattern}\n`);
  prompter.write(`${recommendation.reason}\n`);

  const useRecommendation = await askConfirm(
    prompter,
    `Use ${recommendation.pattern}?`,
    true,
  );

  if (useRecommendation) {
    return recommendation;
  }

  const overriddenPattern = await askChoice(prompter, 'Choose a placement pattern', [
    {
      value: PLACEMENT_PATTERNS.WORKSPACE_ROOT,
      description: 'Shared multi-repo workspace root with a nested .compass/ directory.',
    },
    {
      value: PLACEMENT_PATTERNS.DEDICATED_MEMORY_REPO,
      description: 'A dedicated memory repo where canonical project memory lives at repo root.',
    },
    {
      value: PLACEMENT_PATTERNS.PRIMARY_REPO,
      description: 'One designated primary repo with a nested .compass/ directory.',
    },
  ], {
    defaultValue: recommendation.pattern,
  });

  return {
    pattern: overriddenPattern,
    reason: recommendation.reason,
  };
}

function describePlacementOwner(placementPattern) {
  switch (placementPattern) {
    case PLACEMENT_PATTERNS.WORKSPACE_ROOT:
      return 'Directory of the shared workspace root';
    case PLACEMENT_PATTERNS.DEDICATED_MEMORY_REPO:
      return 'Directory of the dedicated memory repo';
    case PLACEMENT_PATTERNS.PRIMARY_REPO:
      return 'Directory of the designated primary repo';
    default:
      return 'Directory that should own the project memory';
  }
}

async function suggestOwnerDirectory(context) {
  if (context.placementPattern === PLACEMENT_PATTERNS.WORKSPACE_ROOT) {
    return '.';
  }

  if (!Array.isArray(context.repos) || context.repos.length !== 1) {
    return '.';
  }

  const hints = getRepoDirectoryHints(context.repos[0]);
  if (hints.has(path.basename(context.cwd).toLowerCase())) {
    return '.';
  }

  for (const hint of hints) {
    if (await directoryExists(path.resolve(context.cwd, hint))) {
      return hint;
    }
  }

  return '.';
}

function ensureSessionBootstrap(options) {
  if (!options.startSession) {
    return;
  }

  if (!options.bootstrap || typeof options.bootstrap !== 'object') {
    options.bootstrap = {};
  }

  if (!options.bootstrap.workflow || !options.bootstrap.claude) {
    options.bootstrap.workflow = true;
    options.bootstrap.claude = true;
  }
}

function createPrompter(io = {}, runtime = {}) {
  if (typeof runtime.prompt === 'function') {
    return {
      async ask(spec) {
        return runtime.prompt(spec);
      },
      write(text) {
        (io.stdout ?? process.stdout).write(text);
      },
      async close() {},
    };
  }

  const input = runtime.stdin ?? io.stdin ?? process.stdin;
  const output = io.stdout ?? process.stdout;

  if (!input?.isTTY) {
    throw new Error('Guided init requires an interactive TTY or a custom prompt adapter.');
  }

  const rl = createInterface({ input, output });
  return {
    async ask(spec) {
      const suffix = renderPromptSuffix(spec);
      return rl.question(`${spec.message}${suffix}: `);
    },
    write(text) {
      output.write(text);
    },
    async close() {
      rl.close();
    },
  };
}

async function askInput(prompter, message, options = {}) {
  while (true) {
    const raw = await prompter.ask({
      type: 'input',
      message,
      defaultValue: options.defaultValue ?? null,
    });
    const value = normalizePromptAnswer(raw, options.defaultValue ?? null);

    if (!value) {
      prompter.write('A value is required.\n');
      continue;
    }

    if (typeof options.validate === 'function') {
      const validationError = await options.validate(value);
      if (validationError) {
        prompter.write(`${validationError}\n`);
        continue;
      }
    }

    return value;
  }
}

async function askOptionalInput(prompter, message, options = {}) {
  const raw = await prompter.ask({
    type: 'input',
    message,
    defaultValue: options.defaultValue ?? null,
  });
  return normalizePromptAnswer(raw, options.defaultValue ?? null);
}

async function askConfirm(prompter, message, defaultValue) {
  while (true) {
    const raw = await prompter.ask({
      type: 'confirm',
      message,
      defaultValue,
    });

    const normalized = String(raw ?? '').trim().toLowerCase();
    if (!normalized) {
      return defaultValue;
    }

    if (['y', 'yes', 'true'].includes(normalized)) {
      return true;
    }

    if (['n', 'no', 'false'].includes(normalized)) {
      return false;
    }

    prompter.write('Please answer yes or no.\n');
  }
}

async function askChoice(prompter, message, choices, options = {}) {
  const defaultValue = options.defaultValue ?? choices[0]?.value ?? null;
  prompter.write(
    `${choices
      .map((choice, index) => `${index + 1}. ${choice.value} — ${choice.description}`)
      .join('\n')}\n`,
  );

  while (true) {
    const raw = await prompter.ask({
      type: 'choice',
      message,
      defaultValue,
      choices,
    });
    const normalized = normalizePromptAnswer(raw, defaultValue)?.toLowerCase();

    if (!normalized) {
      prompter.write('A choice is required.\n');
      continue;
    }

    const byIndex = Number.parseInt(normalized, 10);
    if (!Number.isNaN(byIndex) && choices[byIndex - 1]) {
      return choices[byIndex - 1].value;
    }

    const byValue = choices.find((choice) => choice.value === normalized);
    if (byValue) {
      return byValue.value;
    }

    prompter.write('Please choose one of the listed options.\n');
  }
}

async function askInteger(prompter, message, options = {}) {
  while (true) {
    const raw = await prompter.ask({
      type: 'input',
      message,
      defaultValue: options.defaultValue ?? null,
    });
    const normalized = normalizePromptAnswer(raw, options.defaultValue ?? null);
    const value = Number.parseInt(String(normalized), 10);

    if (Number.isNaN(value)) {
      prompter.write('Please enter a whole number.\n');
      continue;
    }

    if (options.min !== undefined && value < options.min) {
      prompter.write(`Value must be at least ${options.min}.\n`);
      continue;
    }

    return value;
  }
}

function renderPromptSuffix(spec) {
  if (spec.type === 'confirm') {
    return spec.defaultValue ? ' [Y/n]' : ' [y/N]';
  }

  if (spec.defaultValue) {
    return ` [${spec.defaultValue}]`;
  }

  return '';
}

function normalizePromptAnswer(raw, defaultValue) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) {
    if (defaultValue === null || defaultValue === undefined) {
      return null;
    }

    return String(defaultValue);
  }

  return trimmed;
}

function cloneInitOptions(options = {}) {
  return {
    ...options,
    repos: Array.isArray(options.repos)
      ? options.repos.map((repo) => ({ ...repo }))
      : [],
    bootstrap: isPlainObject(options.bootstrap) ? { ...options.bootstrap } : undefined,
    sync: isPlainObject(options.sync) ? { ...options.sync } : undefined,
    metadata: isPlainObject(options.metadata) ? cloneMetadata(options.metadata) : undefined,
  };
}

function cloneMetadata(metadata) {
  const clone = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (Array.isArray(value)) {
      clone[key] = [...value];
      continue;
    }

    if (isPlainObject(value)) {
      clone[key] = cloneMetadata(value);
      continue;
    }

    clone[key] = value;
  }

  return clone;
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function suggestRepoId(value) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'repo';
}

function suggestLaneId(value) {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');

  return slug.length >= 3 ? slug : 'builder-session';
}

function validateLaneIdForPrompt(value) {
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(value)) {
    return 'Lane id must be 3-64 lowercase letters, numbers, or hyphens, and must start and end with a letter or number.';
  }

  if ([
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
  ].includes(value)) {
    return `Lane id "${value}" is reserved.`;
  }

  return null;
}

function getRepoDirectoryHints(repo) {
  const hints = new Set();

  if (typeof repo?.id === 'string' && repo.id.trim()) {
    hints.add(repo.id.trim().toLowerCase());
  }

  if (typeof repo?.remote === 'string' && repo.remote.trim()) {
    const remoteHint = extractRemoteSlug(repo.remote.trim());
    if (remoteHint) {
      hints.add(remoteHint);
    }
  }

  return hints;
}

function extractRemoteSlug(remote) {
  const normalized = remote.replace(/\/+$/, '');
  const slashIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf(':'));
  const tail = slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
  const slug = tail.replace(/\.git$/i, '').trim().toLowerCase();
  return slug || null;
}

async function directoryExists(directoryPath) {
  try {
    await access(directoryPath);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isSameDirectory(left, right) {
  try {
    const [leftRealPath, rightRealPath] = await Promise.all([
      realpath(left),
      realpath(right),
    ]);
    return leftRealPath === rightRealPath;
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

function toRelativeIfInsideCwd(targetPath, cwd) {
  const absolute = path.resolve(cwd, targetPath);
  const relative = path.relative(cwd, absolute);

  if (!relative || relative === '') {
    return '.';
  }

  if (relative.startsWith('..')) {
    return absolute;
  }

  return relative;
}
