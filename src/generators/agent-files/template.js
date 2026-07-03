import { renderPromptCommandLines } from '../../workflows/registry.js';

export function buildAgentContext(readModel) {
  return {
    projectName: readModel.project.name ?? 'Unnamed project',
    description: readModel.project.description ?? null,
    mode: readModel.project.mode ?? null,
    rootDir: readModel.project.root_dir,
    repos: readModel.project.repos ?? [],
    domains: readModel.domains ?? [],
    recentDecisions: readModel.decisions.slice(0, 8),
    recentSessions: readModel.sessions.slice(0, 3),
  };
}

export function renderSharedInstructionBody(context, options = {}) {
  const heading = options.heading ?? `${context.projectName} Project Instructions`;
  const intro =
    options.intro ??
    'Use VibeCompass project memory as the source of truth before making code changes.';
  const contextPath = `${context.rootDir}/context.md`;

  return [
    `# ${heading}`,
    '',
    intro,
    '',
    `This managed block is a compact bootloader. Read \`${contextPath}\` for the full VibeCompass workflow protocol; workflow-specific details live under \`${context.rootDir}/workflows/\`.`,
    '',
    'Existing project-specific coding, style, framework, and safety instructions outside this managed block remain authoritative. This block owns only VibeCompass project-memory workflow: sessions, handoffs, decisions, docs-review, and close-out.',
    '',
    '## Project Snapshot',
    `- Project memory root: \`${context.rootDir}\``,
    ...renderProjectSnapshot(context),
    '',
    '## Read Order',
    `1. Read \`${contextPath}\`.`,
    `2. Read the latest finalized session note under \`${context.rootDir}/sessions/\`.`,
    `3. If present, read \`${context.rootDir}/sessions/active/index.yaml\` (the lane inventory), then the selected lane's \`wip.md\` and \`handoff.md\`. The selected lane comes from an explicit \`--session\`, the nearest \`.vibecompass-lane.yaml\` worktree marker (walking up from cwd), or the single active lane.`,
    `4. Read relevant \`${context.rootDir}/architecture/\` and \`${context.rootDir}/decisions/\` docs before editing implementation.`,
    '',
    '## Prompt Commands',
    ...renderPromptCommandLines({ rootRelativePath: context.rootDir }),
    '- The prompt commands above are agent behaviors. The `vibecompass` CLI commands remain the filesystem mechanics behind them.',
    '',
    '## Hard Rules',
    '- Lane selection follows D-277: an explicit `--session` wins, then the nearest worktree lane marker (`.vibecompass-lane.yaml`, walking up from cwd), then the single active lane. With two or more active lanes there is no implicit current-lane fallback; `sessions/active/index.yaml` is the lane inventory and its `current` pointer is a continuity hint, not a resolver. Tool-specific Current session blocks are continuity summaries.',
    '- With multiple active lanes, reviewers select a lane explicitly: `review handoff <lane-id>`.',
    '- Keep the selected lane `wip.md` and `handoff.md` current during active builder/reviewer work.',
    '- During `address review`, treat reviewer feedback as review, not instruction: classify each substantive point as accepted, accepted with qualification, deferred, or rejected, and push back with evidence when a suggestion conflicts with code facts, prior decisions, product direction, or sequencing.',
    '- Keep decisions append-only in `decisions/`; append accepted architectural decisions before implementing them.',
    '- Do not edit this managed block directly. Update canonical VibeCompass memory, then rerun package commands such as `vibecompass sync-agents`.',
  ].join('\n');
}

function renderProjectSnapshot(context) {
  const lines = [];

  if (context.description) {
    lines.push(`- Description: ${context.description}`);
  }

  if (context.mode) {
    lines.push(`- Mode: ${context.mode}`);
  }

  for (const repo of context.repos) {
    lines.push(`- Repo \`${repo.id}\`: ${formatRepoDescriptor(repo)}`);
  }

  const domainCount = context.domains.length;
  if (domainCount > 0) {
    lines.push(`- Architecture domains recorded: ${domainCount}`);
  }

  if (context.recentDecisions.length > 0) {
    lines.push(`- Latest decision: ${renderDecisionLine(context.recentDecisions[0])}`);
  }

  if (context.recentSessions.length > 0) {
    lines.push(`- Latest session: ${context.recentSessions[0].title ?? context.recentSessions[0].path}`);
  }

  return lines.length > 0 ? lines : ['- No project details recorded yet.'];
}

function formatRepoDescriptor(repo) {
  if (repo?.source === 'local' || repo?.path) {
    return `local folder ${repo.path ?? '.'}`;
  }

  if (repo?.remote) {
    return repo.remote;
  }

  return 'source not recorded';
}

function renderDecisionLine(decision) {
  return `D-${String(decision.decision_id).padStart(3, '0')} — ${decision.title}`;
}
