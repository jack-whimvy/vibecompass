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

  return [
    `# ${heading}`,
    '',
    intro,
    '',
    '## Read First',
    `- Project memory root: \`${context.rootDir}\``,
    '- Read `project.yaml` for project identity, repos, mode, and workflow defaults.',
    '- Read the latest finalized session note under `sessions/` before resuming work.',
    '- Read `sessions/active/index.yaml` when it exists, then read the selected lane under `sessions/active/<lane-id>/`.',
    '- Read the selected lane `wip.md` and `handoff.md` when they exist; they are the active builder/reviewer scratch files.',
    '- Read relevant `architecture/` and `decisions/` files before changing implementation.',
    '',
    '## Project Shape',
    ...renderProjectShape(context),
    '',
    '## Workflow Rules',
    '- VibeCompass active builder sessions are named lanes. Use one lane per active feature or workstream; finalized session notes are append-only history under `sessions/YYYY-MM-DD-N-title.md`.',
    '- Use `start session` for builder work and `join as reviewer` for review work.',
    '- Use `vibecompass start-session --id <lane-id>` for concurrent lanes. Omitting `--id` opens the compatibility `default` lane only when no other lanes are active.',
    '- Use `vibecompass list-sessions` and `vibecompass switch-session <lane-id>` to inspect or change the current lane.',
    '- Treat `sessions/active/index.yaml` as the current lane source of truth; tool-specific Current session blocks are continuity summaries.',
    '- Use optional planning mode for risky or ambiguous work: read the same context, propose scope, and record the agreed plan in the selected lane `wip.md` before implementation.',
    '- Use `review handoff` to ask a reviewer to inspect the active handoff.',
    '- Use `address review` to process reviewer feedback from the selected lane `wip.md` and `handoff.md`.',
    '- End the active builder session with `vibecompass close-session --session <lane-id>`; `vibecompass end-session` is an accepted alias.',
    '- If stale scratch files block `start-session`, read them first, then close, recover, move, or delete them intentionally before retrying.',
    '- Keep decisions append-only in `decisions/`. Session notes may reference decisions, but decisions are the durable source of truth.',
    '- Treat generated agent files as views. Update canonical VibeCompass project memory instead of editing managed regions.',
    '',
    '## Recent Decisions',
    ...renderDecisionLines(context.recentDecisions),
  ].join('\n');
}

function renderProjectShape(context) {
  const lines = [];

  if (context.description) {
    lines.push(`- Description: ${context.description}`);
  }

  if (context.mode) {
    lines.push(`- Mode: ${context.mode}`);
  }

  for (const repo of context.repos) {
    lines.push(`- Repo \`${repo.id}\`: ${repo.remote}`);
  }

  for (const domain of context.domains.slice(0, 8)) {
    const features = domain.features.map((feature) => feature.feature).join(', ');
    lines.push(`- ${domain.domain}: ${features || 'No features recorded yet.'}`);
  }

  return lines.length > 0 ? lines : ['- No architecture domains recorded yet.'];
}

function renderDecisionLines(decisions) {
  if (!decisions || decisions.length === 0) {
    return ['- No decisions recorded yet.'];
  }

  return decisions.map((decision) => `- D-${String(decision.decision_id).padStart(3, '0')} — ${decision.title}`);
}
