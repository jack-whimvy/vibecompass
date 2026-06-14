import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectProjectCompatibility } from './compatibility.js';
import { sha256Text } from './hash.js';
import { parseSimpleYaml } from './simple-yaml.js';
import { listProjectSessions } from './session.js';
import { syncAgentInstructionFiles } from './generators/agent-files/index.js';

export async function getProjectStatus(options = {}) {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const rootDir = path.resolve(cwd, options.rootDir ?? '.compass');
  const toolingRootDir = options.toolingRootDir
    ? path.resolve(cwd, options.toolingRootDir)
    : cwd;

  const compatibility = await inspectProjectCompatibility({
    rootDir,
    cwd,
    ...(options.packageVersion ? { packageVersion: options.packageVersion } : {}),
  });
  const [project, sessions, docsReview, agentFiles] = await Promise.all([
    readProjectSummary(compatibility.projectFilePath),
    readSessionsStatus(rootDir),
    readDocsReviewStatus(rootDir),
    readAgentFileStatus(rootDir, toolingRootDir),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    rootDir,
    toolingRootDir,
    project,
    compatibility: {
      cliPackageVersion: compatibility.cliPackageVersion,
      package: compatibility.package,
      state: compatibility.state,
      warnings: compatibility.warnings,
    },
    sessions,
    docsReview,
    agentFiles,
    recommendations: buildRecommendations({
      project,
      compatibility,
      sessions,
      docsReview,
      agentFiles,
    }),
  };
}

export function renderStatusText(status) {
  if (status.project.status === 'unreadable') {
    return [
      'VibeCompass status',
      `Status: not initialized`,
      `Generated: ${status.generatedAt}`,
      `Root: ${status.rootDir}`,
      `Message: Not a VibeCompass project memory root. Run \`vibecompass init --guided\` to set one up.`,
      '',
      'Recommended next commands:',
      '- vibecompass init --guided',
      '',
    ].join('\n');
  }

  const summary = hasStatusDrift(status) ? 'drift detected' : 'ok';
  const lines = [
    'VibeCompass status',
    `Status: ${summary}`,
    `Generated: ${status.generatedAt}`,
    `Project: ${status.project.name ?? 'Unknown'}`,
    `Mode: ${status.project.mode ?? 'Unknown'}`,
    `Root: ${status.rootDir}`,
    `Repos: ${status.project.repos.length > 0 ? status.project.repos.map((repo) => repo.id).join(', ') : 'None recorded'}`,
    `Active lanes: ${formatActiveLanes(status.sessions)}`,
    '',
    'Package:',
    `- CLI version: ${status.compatibility.cliPackageVersion}`,
    `- Root stamp: ${formatPackageStatus(status.compatibility.package)}`,
    ...(status.compatibility.state.packageObservedVersion
      ? [`- Local observed: ${status.compatibility.state.packageObservedVersion} (from state/manifest.json)`]
      : []),
    `- State manifest: ${formatStateStatus(status.compatibility.state)}`,
  ];

  if (status.compatibility.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const warning of status.compatibility.warnings) {
      lines.push(`- ${warning.message}`);
    }
  }

  lines.push(
    '',
    'Docs review:',
    `- ${formatDocsReviewStatus(status.docsReview)}`,
    ...(status.docsReview.outputDrift?.hasDrift
      ? [`- Output drift: ${status.docsReview.outputDrift.reasons.join('; ')}`]
      : []),
    '',
    'Agent files:',
    ...formatAgentFileStatus(status.agentFiles),
  );

  if (status.recommendations.length > 0) {
    lines.push('', 'Recommended next commands:');
    for (const recommendation of status.recommendations) {
      lines.push(`- ${recommendation}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export function toStatusJson(status) {
  // Keep this as an explicit public-output shape. Nested status fields must
  // remain free of raw manifests, preview tokens, and resolved env values.
  return {
    generatedAt: status.generatedAt,
    rootDir: status.rootDir,
    toolingRootDir: status.toolingRootDir,
    project: status.project,
    compatibility: status.compatibility,
    sessions: status.sessions,
    docsReview: status.docsReview,
    agentFiles: status.agentFiles,
    recommendations: status.recommendations,
  };
}

async function readProjectSummary(projectFilePath) {
  try {
    const config = parseSimpleYaml(await readFile(projectFilePath, 'utf8'), {
      sourceName: projectFilePath,
    });
    return {
      status: 'ok',
      name: typeof config.name === 'string' ? config.name : null,
      mode: typeof config.mode === 'string' ? config.mode : null,
      repos: Array.isArray(config.repos)
        ? config.repos
            .filter((repo) => repo && typeof repo === 'object')
            .map((repo) => ({
              id: typeof repo.id === 'string' ? repo.id : null,
              source: typeof repo.source === 'string' ? repo.source : (typeof repo.remote === 'string' ? 'git' : 'local'),
              remote: typeof repo.remote === 'string' ? repo.remote : null,
              path: typeof repo.path === 'string' ? repo.path : null,
              defaultBranch: typeof repo.default_branch === 'string' ? repo.default_branch : null,
            }))
            .filter((repo) => repo.id)
        : [],
      sync: config.sync && typeof config.sync === 'object'
        ? {
            provider: typeof config.sync.provider === 'string' ? config.sync.provider : null,
            apiUrl: typeof config.sync.api_url === 'string' ? config.sync.api_url : null,
            projectId: typeof config.sync.project_id === 'string' ? config.sync.project_id : null,
            credentialSource: typeof config.sync.credential_source === 'string' ? config.sync.credential_source : null,
            credentialEnvVar: typeof config.sync.credential_env_var === 'string' ? config.sync.credential_env_var : null,
            defaultTarget:
              typeof config.sync.default_target === 'string' ? config.sync.default_target : null,
            targets:
              config.sync.targets && typeof config.sync.targets === 'object'
                ? Object.entries(config.sync.targets)
                    .filter(([, target]) => target && typeof target === 'object')
                    .map(([name, target]) => ({
                      name,
                      apiUrl: typeof target.api_url === 'string' ? target.api_url : null,
                      projectId: typeof target.project_id === 'string' ? target.project_id : null,
                      credentialEnvVar:
                        typeof target.credential_env_var === 'string' ? target.credential_env_var : null,
                    }))
                : [],
          }
        : null,
    };
  } catch (error) {
    return {
      status: 'unreadable',
      name: null,
      mode: null,
      repos: [],
      sync: null,
      errorMessage: error instanceof Error ? error.message : 'Unable to read project.yaml.',
    };
  }
}

async function readSessionsStatus(rootDir) {
  try {
    const sessions = await listProjectSessions({ rootDir });
    return {
      status: 'ok',
      current: sessions.current,
      lanes: sessions.lanes.map((lane) => ({
        id: lane.id,
        status: lane.status,
        workingOn: lane.workingOn,
      })),
    };
  } catch (error) {
    return {
      status: 'unreadable',
      current: null,
      lanes: [],
      errorMessage: error instanceof Error ? error.message : 'Unable to read active sessions.',
    };
  }
}

async function readDocsReviewStatus(rootDir) {
  const markerPath = path.join(rootDir, 'state', 'docs-review.json');
  try {
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    const outputDrift = await readDocsReviewOutputDrift(rootDir, marker);
    return {
      status: typeof marker.status === 'string' ? marker.status : 'unknown',
      markerPath,
      completedAt: typeof marker.completed_at === 'string' ? marker.completed_at : null,
      provider: typeof marker.provider === 'string' ? marker.provider : null,
      model: typeof marker.model === 'string' ? marker.model : null,
      applied: marker.applied ?? null,
      outputDrift,
    };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return {
        status: 'missing',
        markerPath,
      };
    }

    return {
      status: 'unreadable',
      markerPath,
      errorMessage: error instanceof Error ? error.message : 'Unable to read docs-review marker.',
    };
  }
}

async function readDocsReviewOutputDrift(rootDir, marker) {
  const applied = marker?.applied;
  if (!applied || typeof applied !== 'object') {
    return { status: 'not-tracked', hasDrift: false, reasons: [] };
  }

  const reasons = [];
  if (typeof applied.output_path === 'string' && typeof applied.output_hash === 'string') {
    try {
      const outputContent = await readFile(applied.output_path, 'utf8');
      const currentOutputHash = sha256Text(outputContent);
      if (currentOutputHash !== applied.output_hash) {
        reasons.push('state/docs-review-output.md changed since apply');
      }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        reasons.push('state/docs-review-output.md is missing since apply');
      } else {
        reasons.push('state/docs-review-output.md could not be read for drift check');
      }
    }
  }

  return {
    status: reasons.length > 0 ? 'drift' : 'current',
    hasDrift: reasons.length > 0,
    reasons,
  };
}

async function readAgentFileStatus(rootDir, toolingRootDir) {
  try {
    const result = await syncAgentInstructionFiles({
      rootDir,
      toolingRootDir,
      dryRun: true,
    });
    return {
      status: 'ok',
      dryRun: true,
      results: result.results.map((item) => ({
        format: item.format,
        relativePath: item.relativePath,
        status: item.changed || item.warning ? item.status : 'current',
        warning: item.warning,
        changed: item.changed,
        conflicts: item.conflicts ?? [],
      })),
    };
  } catch (error) {
    return {
      status: 'unavailable',
      dryRun: true,
      results: [],
      errorMessage: error instanceof Error ? error.message : 'Unable to inspect agent files.',
    };
  }
}

function buildRecommendations({ project, compatibility, sessions, docsReview, agentFiles }) {
  const recommendations = [];
  if (project.status === 'unreadable') {
    recommendations.push('vibecompass init --guided');
    return recommendations;
  }

  const packageStatus = compatibility.package.status;
  const stateStatus = compatibility.state.status;
  if (['legacy', 'behind', 'ahead', 'invalid'].includes(packageStatus) || ['missing', 'unreadable', 'unsupported'].includes(stateStatus)) {
    recommendations.push('vibecompass refresh-workflow --dry-run');
  }

  if (docsReview.status === 'missing' || docsReview.status === 'rebuild-ready') {
    recommendations.push('vibecompass docs-review --guided');
  } else if (docsReview.outputDrift?.hasDrift) {
    recommendations.push('vibecompass docs-review --apply-output');
  }

  if (agentFiles.status === 'ok' && agentFiles.results.some((item) => item.changed || item.warning)) {
    recommendations.push('vibecompass sync-agents --dry-run');
  }

  if (sessions.status === 'ok' && sessions.lanes.length === 0) {
    recommendations.push('vibecompass start-session --id LANE_ID --working-on "TASK"');
  } else if (sessions.status === 'ok' && sessions.lanes.length >= 2) {
    recommendations.push('vibecompass list-sessions');
  }

  return [...new Set(recommendations)];
}

function hasStatusDrift(status) {
  return (
    status.compatibility.warnings.length > 0 ||
    status.docsReview.status !== 'completed' ||
    Boolean(status.docsReview.outputDrift?.hasDrift) ||
    status.agentFiles.status !== 'ok' ||
    status.agentFiles.results.some((item) => item.changed || item.warning)
  );
}

function formatActiveLanes(sessions) {
  if (sessions.status !== 'ok') {
    return `unavailable (${sessions.errorMessage})`;
  }

  if (sessions.lanes.length === 0) {
    return 'none';
  }

  return `${sessions.lanes.length}${sessions.current ? ` (current: ${sessions.current})` : ''}`;
}

function formatPackageStatus(packageStatus) {
  if (packageStatus.status === 'legacy') {
    return 'legacy/unknown';
  }
  if (packageStatus.status === 'unknown') {
    return `unknown (${packageStatus.errorMessage})`;
  }
  if (packageStatus.status === 'invalid') {
    return `invalid (${String(packageStatus.rootVersion)})`;
  }
  return `${packageStatus.rootVersion ?? 'none'} (${packageStatus.status})`;
}

function formatStateStatus(stateStatus) {
  if (stateStatus.status === 'current') {
    return `state_version ${stateStatus.observedVersion} (current)`;
  }
  if (stateStatus.status === 'unsupported') {
    return `state_version ${stateStatus.observedVersion ?? 'missing'} (unsupported; expected ${stateStatus.expectedVersion})`;
  }
  if (stateStatus.status === 'unreadable') {
    return `unreadable (${stateStatus.errorMessage})`;
  }
  if (stateStatus.status === 'missing') {
    return 'no manifest yet (will be created on first command that writes state)';
  }
  return stateStatus.status;
}

function formatDocsReviewStatus(docsReview) {
  if (docsReview.status === 'missing') {
    return 'No docs-review marker found';
  }
  if (docsReview.status === 'unreadable') {
    return `Marker unreadable (${docsReview.errorMessage})`;
  }
  return `${docsReview.status}${docsReview.completedAt ? ` at ${docsReview.completedAt}` : ''}`;
}

function formatAgentFileStatus(agentFiles) {
  if (agentFiles.status !== 'ok') {
    return [`- unavailable (${agentFiles.errorMessage})`];
  }

  if (agentFiles.results.length === 0) {
    return ['- none configured'];
  }

  return agentFiles.results.map((item) => {
    const warning = item.warning ? ` — ${item.warning}` : '';
    return `- ${item.relativePath}: ${item.status}${warning}`;
  });
}
