import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveWorkflowSettings } from './workflow.js';

export async function scaffoldInitFiles(options) {
  const createdFiles = [];
  const skippedFiles = [];

  if (!options.workflow) {
    return {
      contextFilePath: null,
      createdFiles,
      skippedFiles,
    };
  }

  await mkdir(path.join(options.rootDir, 'architecture'), { recursive: true });
  await mkdir(path.join(options.rootDir, 'decisions'), { recursive: true });
  await mkdir(path.join(options.rootDir, 'sessions'), { recursive: true });

  const contextFilePath = path.join(options.rootDir, 'context.md');
  // context.md is a derived artifact owned by the package; regenerate it on rerun.
  await writeFile(contextFilePath, generateContextMarkdown(options), 'utf8');
  createdFiles.push(contextFilePath);

  const workflowFiles = [
    {
      path: path.join(options.rootDir, 'architecture', 'README.md'),
      content: generateArchitectureGuide(options.projectConfig),
    },
    {
      path: path.join(options.rootDir, 'decisions', 'README.md'),
      content: generateDecisionsGuide(options.projectConfig),
    },
    {
      path: path.join(options.rootDir, 'sessions', 'README.md'),
      content: generateSessionsGuide(options.projectConfig),
    },
  ];

  for (const file of workflowFiles) {
    const outcome = await writeIfMissing(file.path, file.content);
    if (outcome.created) {
      createdFiles.push(file.path);
    } else {
      skippedFiles.push(file.path);
    }
  }

  const bootstrapFiles = [];
  if (options.claude) {
    bootstrapFiles.push({
      path: path.join(options.toolingRootDir, 'CLAUDE.md'),
      content: generateClaudeTemplate(options),
    });
  }

  if (options.agents) {
    bootstrapFiles.push({
      path: path.join(options.toolingRootDir, 'AGENTS.md'),
      content: generateAgentsTemplate(options),
    });
  }

  for (const file of bootstrapFiles) {
    const outcome = await writeIfMissing(file.path, file.content);
    if (outcome.created) {
      createdFiles.push(file.path);
    } else {
      skippedFiles.push(file.path);
    }
  }

  return {
    contextFilePath,
    createdFiles,
    skippedFiles,
  };
}

async function writeIfMissing(filePath, content) {
  if (await fileExists(filePath)) {
    return { created: false };
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  return { created: true };
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function generateContextMarkdown(options) {
  const projectName = options.projectConfig.name;
  const rootRelativePath = options.rootRelativePath;
  const workflow = resolveWorkflowSettings(options.projectConfig);
  const repos = options.projectConfig.repos
    .map((repo) => `- \`${repo.id}\` → ${repo.remote}`)
    .join('\n');

  return `# Project Context — ${projectName}

This workspace uses VibeCompass project memory rooted at \`${rootRelativePath}\`.

## Canonical files
- \`${rootRelativePath}/project.yaml\` — machine-oriented project metadata
- \`${rootRelativePath}/architecture/\` — canonical architecture docs
- \`${rootRelativePath}/decisions/\` — canonical decision log
- \`${rootRelativePath}/sessions/\` — finalized session notes

## Derived and scratch files
- \`${rootRelativePath}/context.md\` — generated AI-facing workflow context
- \`${rootRelativePath}/state/manifest.json\` — machine-owned local state; do not hand-edit
- \`${rootRelativePath}/sessions/active/index.yaml\` — active session lane index and current lane pointer
- \`${rootRelativePath}/sessions/active/<lane-id>/session.yaml\` — lane metadata
- \`${rootRelativePath}/sessions/active/<lane-id>/wip.md\` — lane-local builder scratchpad
- \`${rootRelativePath}/sessions/active/<lane-id>/handoff.md\` — lane-local builder/reviewer relay

## Session model
- VibeCompass active builder sessions are named lanes. Use one lane per active feature or workstream.
- \`vibecompass start-session\` without \`--id\` opens the compatibility \`default\` lane only when no other lanes are active; use \`--id <lane-id>\` for concurrent work.
- The active lane scratch files live under \`${rootRelativePath}/sessions/active/<lane-id>/\`.
- \`${rootRelativePath}/sessions/active/index.yaml\` is the authoritative current lane pointer; the tool-specific Current session block is a human-readable continuity summary, not the lane-selection source of truth.
- Finalized sessions are append-only notes named \`${rootRelativePath}/sessions/YYYY-MM-DD-N-title.md\`; multiple sessions on the same day increment \`N\`.
- Decisions remain append-only and independent from session notes. A session note may reference decisions, but the decision entry in \`${rootRelativePath}/decisions/\` is the durable source of truth.

## Repos in scope
${repos}

## Session roles
| Trigger | Role | Owns session lifecycle? |
|---|---|---|
| "start session" | Builder | Yes — opens the session, keeps scratch files current, and writes the final session note |
| "join as reviewer" | Reviewer | No — reviews the builder's work, appends findings, and updates handoff guidance |

## Session prompt commands
- \`start session\` — builder role trigger
- \`join as reviewer\` — reviewer role trigger
- \`planning mode\` — optional prompt-level mode for scoping work before implementation
- \`review handoff\` — reviewer reads the selected lane's \`wip.md\`, \`handoff.md\`, latest finalized note, and relevant diffs before appending findings
- \`address review\` — builder reads reviewer feedback in the selected lane's \`wip.md\` / \`handoff.md\`, responds inline, applies accepted changes, and refreshes the builder handoff

These are prompt commands for agent behavior, not \`vibecompass\` CLI subcommands.
Reviewer handback is explicit: the reviewer ends the pass by updating the selected lane's \`wip.md\` + \`handoff.md\` and then stopping. Builder close-out uses \`vibecompass close-session --session <lane-id>\`, which follows the workflow defaults recorded in \`${rootRelativePath}/project.yaml\`.
\`vibecompass end-session\` is also accepted as an alias for \`vibecompass close-session\`; the canonical command name remains \`close-session\`.

## Workflow defaults
${renderWorkflowDefaults(workflow)}

## Session startup
1. Read \`${rootRelativePath}/project.yaml\`.
2. Read the latest finalized session note in \`${rootRelativePath}/sessions/\`.
3. If present, read \`${rootRelativePath}/sessions/active/index.yaml\` and choose the selected or current lane.
4. If present, read \`${rootRelativePath}/sessions/active/<lane-id>/wip.md\`.
5. If present, read \`${rootRelativePath}/sessions/active/<lane-id>/handoff.md\`.
6. Read the relevant docs under \`${rootRelativePath}/architecture/\` and \`${rootRelativePath}/decisions/\`.

## Builder workflow
At session start, prefer running \`vibecompass start-session --id <lane-id> --working-on "..." \`. Omit \`--id\` only for the first/default lane in a project with no other active lanes.
If you manage files manually, create \`${rootRelativePath}/sessions/active/<lane-id>/session.yaml\` and \`${rootRelativePath}/sessions/active/index.yaml\`, then create \`${rootRelativePath}/sessions/active/<lane-id>/wip.md\` if it does not exist:

\`\`\`md
# WIP — YYYY-MM-DD (session N)

Session lane: <lane-id>

## Working on

## Log

## Reviewer input needed

## Review log
\`\`\`

Also create \`${rootRelativePath}/sessions/active/<lane-id>/handoff.md\` if it does not exist:

\`\`\`md
# Handoff — YYYY-MM-DD (session N)

Session lane: <lane-id>

## Builder → Reviewer

### What changed

### What needs review

### What's next

## Reviewer → Builder

### Findings summary

### Recommended next step
\`\`\`

During the session:
- append short summaries to \`wip.md\` after meaningful exchanges
- keep \`handoff.md\` current after substantive work blocks
- use \`vibecompass list-sessions\` and \`vibecompass switch-session <lane-id>\` to inspect or change the current lane
- use \`address review\` when reviewer feedback lands so the builder resolves it from the selected lane's latest \`wip.md\` / \`handoff.md\`
- stay in builder role through close-out; resolve or explicitly defer reviewer feedback before running \`vibecompass close-session --session <lane-id>\`
- record architectural decisions in \`${rootRelativePath}/decisions/\` before implementing them

If \`vibecompass start-session\` reports stale scratch files, read the existing lane-local \`wip.md\` and \`handoff.md\` first. Either close that session normally, recover its useful notes into a finalized session note, or intentionally move/delete the stale scratch files before starting a new session.

## Optional planning mode
- Use planning mode for risky, ambiguous, cross-file, or architectural work before implementation.
- Planning mode reads the same startup context as builder mode and may update the selected lane's \`wip.md\` with agreed scope, constraints, and open questions.
- Planning mode should not finalize session notes, mutate decisions, or make broad code changes until the user approves the plan.
- If planning produces a real architectural decision, append it to \`${rootRelativePath}/decisions/\` before implementing.

At session close:
- prefer running \`vibecompass close-session --session <lane-id> --title "..." --completed "..." --model "..." --next-step "..."\`; \`vibecompass end-session\` is a supported alias
- follow the stored close-session defaults from \`${rootRelativePath}/project.yaml\`
- finalize the lane-local \`wip.md\` into \`${rootRelativePath}/sessions/YYYY-MM-DD-N-title.md\`
- delete the closed lane directory under \`${rootRelativePath}/sessions/active/<lane-id>/\`
- refresh any affected architecture/decision docs

## Reviewer workflow
- use \`review handoff\` when you want the reviewer to run the next review pass
- read the latest finalized session note, then the selected lane's \`wip.md\`, then \`handoff.md\`
- inspect the relevant code/docs diffs
- append findings under \`## Review log\` in \`wip.md\`
- write a concise baton-pass summary into \`handoff.md\`
- end the review pass after those file updates; there is no separate reviewer-exit step

## Tooling note
\`CLAUDE.md\` and \`AGENTS.md\` are developer-owned starter files. If they exist,
they should point back to this context file and should not be overwritten
automatically by package commands.
`;
}

function generateArchitectureGuide(projectConfig) {
  return `# Architecture

This directory holds canonical architecture docs for ${projectConfig.name}.

## Recommended layout

\`\`\`text
architecture/<domain-slug>/<feature-slug>/<component>.md
\`\`\`

## Required frontmatter
- \`domain\`
- \`feature\`
- \`component\`
- \`status\`
- optional \`repo\` or \`repos\`

## Recommended sections
- \`## Description\`
- \`## Details\`
- \`## Next steps\`
- \`## Involved files\`

Each component doc is canonical. This README is only a convenience guide.
`;
}

function generateDecisionsGuide(projectConfig) {
  return `# Decisions

Append-only decision log for ${projectConfig.name}.

## Conventions
- store canonical decision entries in domain-grouped files such as \`cross-cutting.md\`
- never edit or delete prior decision entries
- use headings in the form \`### D-<number> — Title\`
- include \`**Timestamp:**\`, \`**Decision:**\`, and \`**Rationale:**\`

## Example

\`\`\`md
### D-001 — Example decision
**Timestamp:** YYYY-MM-DD HH:MM TZ
**Decision:** What was decided.
**Rationale:** Why this was the correct tradeoff.
\`\`\`

This README is guidance only; canonical decision content lives in the domain files.
`;
}

function generateSessionsGuide(projectConfig) {
  return `# Sessions

Finalized session notes for ${projectConfig.name} live here.

## Finalized session note format
- recommended filename: \`YYYY-MM-DD-N-title.md\`
- recommended H1: \`# Session — YYYY-MM-DD-N — Title\`

## Recommended sections
- \`## What we worked on\`
- \`## Completed\`
- \`## Decisions made\`
- \`## Models used\`
- \`## Blockers / open questions\`
- \`## Next session should start with\`

## Active-session scratch files
- \`active/index.yaml\` — active lane index and current lane pointer
- \`active/<lane-id>/session.yaml\` — lane metadata
- \`active/<lane-id>/wip.md\` — builder scratchpad during an active lane
- \`active/<lane-id>/handoff.md\` — reviewer/builder baton-pass during an active lane

Those scratch files are session-scoped working artifacts, not finalized history.
`;
}

function generateClaudeTemplate(options) {
  const workflow = resolveWorkflowSettings(options.projectConfig);

  return `# ${options.projectConfig.name} Workspace

Read \`${options.contextRelativeToToolingRoot}\` before doing substantive work.

## Session roles

| Trigger | Role | Owns session lifecycle? |
|---|---|---|
| "start session" | Builder | Yes |
| "join as reviewer" | Reviewer | No |
| "planning mode" | Planner | No — scopes work inside the selected active lane before implementation |

## Prompt commands

- \`start session\` — builder role trigger
- \`join as reviewer\` — reviewer role trigger
- \`planning mode\` — optional prompt-level mode for scoping risky or ambiguous work before implementation
- \`review handoff\` — reviewer reads the selected lane's \`wip.md\`, \`handoff.md\`, latest finalized note, and relevant diffs before appending findings
- \`address review\` — builder reads reviewer feedback in the selected lane's \`wip.md\` / \`handoff.md\`, responds inline, applies accepted changes, and refreshes the builder handoff

These are prompt commands for agent behavior, not \`vibecompass\` CLI subcommands.
Reviewer handback is explicit: the reviewer ends the pass by updating the selected lane's \`wip.md\` + \`handoff.md\` and then stopping. Builder close-out uses \`vibecompass close-session --session <lane-id>\`, which follows the workflow defaults recorded in \`${options.rootRelativePath}/project.yaml\`.
\`vibecompass end-session\` is accepted as an alias for \`vibecompass close-session\`; \`close-session\` remains the canonical command name.

## Current session

**Update this block at the start and end of every session.**

\`\`\`
Date: not started
Working on: Session not started yet.
Last thing completed: Project memory bootstrap completed.
Blockers: None recorded.
Next session should: Read \`${options.contextRelativeToToolingRoot}\`, then open the first builder or reviewer session.
\`\`\`

## Startup
- Read \`${options.contextRelativeToToolingRoot}\`
- Follow the builder/reviewer protocol defined there
- Use \`vibecompass start-session --id <lane-id>\`, \`vibecompass list-sessions\`, \`vibecompass switch-session <lane-id>\`, and \`vibecompass close-session --session <lane-id>\` to manage active lanes when possible
- Treat \`${options.rootRelativePath}/sessions/active/index.yaml\` as the current lane source of truth; this Current session block is only a continuity summary
- Keep the selected lane's \`${options.rootRelativePath}/sessions/active/<lane-id>/wip.md\` and \`${options.rootRelativePath}/sessions/active/<lane-id>/handoff.md\` current during an active session
- Use planning mode when scope is unclear; record the agreed plan in the selected lane's \`wip.md\` before implementing
- If stale scratch files block \`start-session\`, read them first, then close, recover, move, or delete them intentionally before retrying
- Workflow defaults:
${renderWorkflowDefaults(workflow)}
`;
}

function generateAgentsTemplate(options) {
  const workflow = resolveWorkflowSettings(options.projectConfig);

  return `# ${options.projectConfig.name} Workspace

This workspace uses VibeCompass project memory rooted at \`${options.rootRelativePath}\`.

## Session roles

| Trigger | Role | Owns session lifecycle? |
|---|---|---|
| "start session" | Builder | Yes — opens and closes the session lifecycle |
| "join as reviewer" | Reviewer | No — reviews the builder's work and updates the handoff |
| "planning mode" | Planner | No — scopes work inside the selected active lane before implementation |

## Prompt commands

- \`start session\` — builder role trigger
- \`join as reviewer\` — reviewer role trigger
- \`planning mode\` — optional prompt-level mode for scoping risky or ambiguous work before implementation
- \`review handoff\` — reviewer reads the selected lane's \`wip.md\`, \`handoff.md\`, latest finalized note, and relevant diffs before appending findings
- \`address review\` — builder reads reviewer feedback in the selected lane's \`wip.md\` / \`handoff.md\`, responds inline, applies accepted changes, and refreshes the builder handoff

These are prompt commands for agent behavior, not \`vibecompass\` CLI subcommands.
Reviewer handback is explicit: the reviewer ends the pass by updating the selected lane's \`wip.md\` + \`handoff.md\` and then stopping. Builder close-out uses \`vibecompass close-session --session <lane-id>\`, which follows the workflow defaults recorded in \`${options.rootRelativePath}/project.yaml\`.
\`vibecompass end-session\` is accepted as an alias for \`vibecompass close-session\`; \`close-session\` remains the canonical command name.

## Startup
Before doing substantive work:
1. Read \`${options.contextRelativeToToolingRoot}\`.
2. Read the latest finalized session note under \`${options.rootRelativePath}/sessions/\`.
3. If present, read \`${options.rootRelativePath}/sessions/active/index.yaml\` and choose the selected or current lane.
4. If present, read \`${options.rootRelativePath}/sessions/active/<lane-id>/wip.md\`.
5. If present, read \`${options.rootRelativePath}/sessions/active/<lane-id>/handoff.md\`.
6. Read the relevant docs under \`${options.rootRelativePath}/architecture/\` and \`${options.rootRelativePath}/decisions/\`.

## Working rule
Treat \`${options.contextRelativeToToolingRoot}\` as the local workflow source of truth for the builder/reviewer protocol and session scratch-file structure. When the package provides \`start-session\` / \`close-session\`, prefer those commands over hand-editing boilerplate.
Use planning mode when scope is unclear; record the agreed plan in the selected lane's \`wip.md\` before implementing.
If stale scratch files block \`start-session\`, read them first, then close, recover, move, or delete them intentionally before retrying.
- Workflow defaults:
${renderWorkflowDefaults(workflow)}
`;
}

function renderWorkflowDefaults(workflow) {
  const lines = [
    `- reviewer handback: ${describeReviewerHandback(workflow)}`,
    '- close-session: refresh any relevant architecture docs before finalizing the session',
    '- close-session: refresh any relevant decision files before finalizing the session',
  ];

  if (workflow.closeSession.gitPublish) {
    lines.push(
      `- close-session: include a Git publish step after finalization using remote \`${workflow.closeSession.gitRemote}\``,
      `- close-session: use commit message format \`${workflow.closeSession.commitTemplate}\` for VibeCompass-templated commits`,
    );
  } else {
    lines.push('- close-session: no Git publish step is included by default');
  }

  return lines.join('\n');
}

function describeReviewerHandback(workflow) {
  if (workflow.reviewerHandback === 'handoff-file') {
    return 'update sessions/active/<lane-id>/wip.md and sessions/active/<lane-id>/handoff.md, then stop the review pass';
  }

  return workflow.reviewerHandback;
}
