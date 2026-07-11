import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveWorkflowSettings } from './workflow.js';
import { getGeneratedWorkflowFiles, renderPromptCommandLines } from './workflows/registry.js';
import { renderManagedBlock } from './generators/agent-files/markers.js';
import { renderSharedInstructionBody } from './generators/agent-files/template.js';

export async function scaffoldInitFiles(options) {
  const createdFiles = [];
  const skippedFiles = [];

  await mkdir(path.join(options.rootDir, 'architecture'), { recursive: true });
  await mkdir(path.join(options.rootDir, 'decisions'), { recursive: true });
  await mkdir(path.join(options.rootDir, 'sessions'), { recursive: true });

  const starterFiles = [
    {
      path: path.join(options.rootDir, 'decisions', 'EXAMPLE.md'),
      content: generateDecisionExample(options.projectConfig),
    },
  ];

  if (!(await hasCanonicalMarkdown(path.join(options.rootDir, 'architecture'), {
    ignoredNames: new Set(['README.md']),
  }))) {
    starterFiles.push({
      path: path.join(options.rootDir, 'architecture', 'overview', 'project-shape.md'),
      content: generateStarterArchitectureDoc(options.projectConfig),
    });
  }

  if (!(await hasCanonicalMarkdown(path.join(options.rootDir, 'sessions'), {
    ignoredNames: new Set(['README.md', 'wip.md', 'handoff.md']),
    ignoredDirectories: new Set(['active']),
  }))) {
    starterFiles.push({
      path: path.join(options.rootDir, 'sessions', `${sessionDateFromGeneratedAt(options.generatedAt)}-1-project-memory-initialized.md`),
      content: generateStarterSessionNote(options),
    });
  }

  for (const file of starterFiles) {
    const outcome = await writeIfMissing(file.path, file.content);
    if (outcome.created) {
      createdFiles.push(file.path);
    } else {
      skippedFiles.push(file.path);
    }
  }

  if (!options.workflow) {
    return {
      contextFilePath: null,
      createdFiles,
      skippedFiles,
    };
  }

  const workflowScaffold = buildWorkflowScaffoldFiles(options);
  const contextFilePath = workflowScaffold.contextFilePath;
  // context.md is a derived artifact owned by the package; regenerate it on rerun.
  await writeFile(contextFilePath, workflowScaffold.context.content, 'utf8');
  createdFiles.push(contextFilePath);

  for (const file of [...workflowScaffold.guides, ...workflowScaffold.workflowFiles]) {
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

export function buildWorkflowScaffoldFiles(options) {
  const contextFilePath = path.join(options.rootDir, 'context.md');
  const context = {
    kind: 'context',
    path: contextFilePath,
    content: generateContextMarkdown(options),
  };

  const guides = [
    {
      kind: 'architecture-guide',
      path: path.join(options.rootDir, 'architecture', 'README.md'),
      content: generateArchitectureGuide(options.projectConfig),
    },
    {
      kind: 'decisions-guide',
      path: path.join(options.rootDir, 'decisions', 'README.md'),
      content: generateDecisionsGuide(options.projectConfig),
    },
    {
      kind: 'sessions-guide',
      path: path.join(options.rootDir, 'sessions', 'README.md'),
      content: generateSessionsGuide(options.projectConfig),
    },
  ];
  const workflowFiles = getGeneratedWorkflowFiles({
    rootRelativePath: options.rootRelativePath,
  }).map((file) => ({
    kind: file.kind,
    path: path.join(options.rootDir, file.relativePath),
    content: file.content,
  }));

  return {
    contextFilePath,
    context,
    guides,
    workflowFiles,
    files: [context, ...guides, ...workflowFiles],
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

async function hasCanonicalMarkdown(directoryPath, options = {}) {
  const ignoredNames = options.ignoredNames ?? new Set();
  const ignoredDirectories = options.ignoredDirectories ?? new Set();

  try {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }

      if (entry.isDirectory()) {
        if (ignoredDirectories.has(entry.name)) {
          continue;
        }

        if (await hasCanonicalMarkdown(path.join(directoryPath, entry.name), options)) {
          return true;
        }
        continue;
      }

      if (entry.isFile() && entry.name.endsWith('.md') && !ignoredNames.has(entry.name)) {
        return true;
      }
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false;
    }

    throw error;
  }

  return false;
}

function generateContextMarkdown(options) {
  const projectName = options.projectConfig.name;
  const rootRelativePath = options.rootRelativePath;
  const workflow = resolveWorkflowSettings(options.projectConfig);
  const promptCommands = renderPromptCommandLines({ rootRelativePath }).join('\n');
  const repos = options.projectConfig.repos
    .map((repo) => `- \`${repo.id}\` → ${formatRepoDescriptor(repo)}`)
    .join('\n');

  return `# Project Context — ${projectName}

This workspace uses VibeCompass project memory rooted at \`${rootRelativePath}\`.

## Canonical files
- \`${rootRelativePath}/project.yaml\` — machine-oriented project metadata
- \`${rootRelativePath}/architecture/\` — canonical architecture docs; the mutable current-state layer, rewritten in place as contracts change (D-292)
- \`${rootRelativePath}/decisions/\` — append-only decision log for this project-memory root
- \`${rootRelativePath}/sessions/\` — finalized session notes

## Derived and scratch files
- \`${rootRelativePath}/context.md\` — generated AI-facing workflow context
- \`${rootRelativePath}/state/manifest.json\` — machine-owned local state; do not hand-edit
- \`${rootRelativePath}/sessions/active/index.yaml\` — active session lane inventory and continuity pointer
- \`${rootRelativePath}/sessions/active/<lane-id>/session.yaml\` — lane metadata (including the recorded \`lane_marker\` when one exists)
- \`${rootRelativePath}/sessions/active/<lane-id>/wip.md\` — lane-local builder scratchpad
- \`${rootRelativePath}/sessions/active/<lane-id>/handoff.md\` — lane-local builder/reviewer relay
- \`.vibecompass-lane.yaml\` — worktree-local lane marker (D-280); lives outside the memory root, written only by \`vibecompass write-lane-marker\` or worktree provisioning, never synced
- \`${rootRelativePath}/decisions/INDEX.md\` — derived grouped decision index; refresh with \`vibecompass refresh-decision-index\` (D-283, structure-preserving) instead of hand-editing rows

## Session model
- VibeCompass active builder sessions are named lanes. Use one lane per active feature or workstream.
- \`vibecompass start-session\` requires \`--id <lane-id>\` so each active lane has a meaningful feature or workstream name.
- The active lane scratch files live under \`${rootRelativePath}/sessions/active/<lane-id>/\`.
- Lane selection follows D-277: an explicit \`--session\` wins, then the nearest worktree lane marker (\`.vibecompass-lane.yaml\`, walking up from cwd), then the single active lane. With two or more active lanes there is no implicit current-lane fallback.
- \`${rootRelativePath}/sessions/active/index.yaml\` is the lane inventory; its \`current\` pointer and the tool-specific Current session block are human-readable continuity summaries, not the lane-selection source of truth.
- Optional git binding (D-281): \`start-session --branch <name> --repo <id> [--worktree]\` creates or reuses the branch in every bound repo; \`--worktree\` additionally provisions per-repo worktrees under \`<workspace>/worktrees/<lane-id>/<repo-id>\` with the lane marker written into the container, so commands run from inside a worktree need neither \`--root\` nor \`--session\`. Binding is opt-in and git is never required for lanes.
- At close, \`close-session\` removes a bound lane's recorded clean worktrees (guarded and never forced: dirty, in-use, or unverifiable worktrees survive with guidance, the lane marker is kept while any worktree survives, and branches are never deleted). Do not hand-remove provisioned worktrees; follow the printed guidance instead.
- Every lane gets a per-lane runtime assignment at start (D-282): a lane port and temp dir recorded in \`session.yaml\` and exported with \`eval "$(vibecompass lane-env)"\` (includes conventional \`PORT\`/\`TMPDIR\` aliases), so parallel lanes never fight over dev-server ports or temp paths. Defaults are configurable under \`project.yaml\` \`runtime:\`; \`close-session\` removes the lane temp dir under guards.
- Finalized sessions are append-only notes named \`${rootRelativePath}/sessions/YYYY-MM-DD-N-title.md\`; multiple sessions on the same day increment \`N\`.
- Decisions remain append-only and independent from session notes. A session note may reference decisions, but the decision entry in \`${rootRelativePath}/decisions/\` is the durable decision record for this root.
- Architecture docs are the opposite of the append-only surfaces (D-292): they are current-state contracts, rewritten in place. Fold changes into the existing sections and keep the durable plan, unresolved next steps, and material rollout state in the doc. Work/ship chronology belongs in finalized session notes; decision entries record accepted choices and rationale; lane scratch holds only transient execution/review state, and anything still pending at close moves to the session note's next steps and, when durable, into architecture (D-293). Intentionally dated ledger/report docs may declare frontmatter \`content_mode: chronological-ledger\`.

## Repos in scope
${repos}

## Session roles
| Entry trigger | Role | Owns session lifecycle? |
|---|---|---|
| "start session" | Builder | Yes — opens the session, keeps scratch files current, and writes the final session note |
| "join as reviewer" | Reviewer | No — reviews the builder's work, appends findings, and updates handoff guidance |

## Session prompt commands
${promptCommands}

These are prompt commands for agent behavior, not \`vibecompass\` CLI subcommands.
Reviewer handback is explicit: the reviewer ends the pass by updating the selected lane's \`wip.md\` + \`handoff.md\` and then stopping. The \`close session\` prompt runs builder close-out and ends with \`vibecompass close-session --session <lane-id>\` plus document-maintenance checkpoint statuses, which follows the workflow defaults recorded in \`${rootRelativePath}/project.yaml\`.
\`vibecompass end-session\` is also accepted as an alias for \`vibecompass close-session\`; the canonical command name remains \`close-session\`.

## Workflow defaults
${renderWorkflowDefaults(workflow)}

## Documentation coverage
- The architecture, decision, and session files created by init are an initial scaffold, not a comprehensive codebase review.
- Comprehensive \`docs review\` establishes a breadth-first baseline first: inventory the project, propose a coverage plan, create compact accepted docs, and leave deferred/missing areas visible before focused deepening.
- Before implementation work on a specific feature, inspect the relevant architecture docs, decisions, coverage/documentation-plan state if present, and source files. If the area is missing, partial, or has never been deepened enough for the build, record that gap in the lane scratch and use \`docs update\`, a focused docs-review/deepening pass, or an explicit deferral before close-out.
- Use \`vibecompass docs-update --session <lane-id>\` during a session for a targeted maintenance plan based on changed files, lane claims, session repos/features, and new decisions. This is a session-delta planner, not a broad architecture review.
- Use the \`docs review\` prompt command when you want the current AI session to run a comprehensive documentation review. It may run \`vibecompass docs-review --guided\` as package mechanics to record marker state and print the canonical review contract.

## Session startup
1. Read \`${rootRelativePath}/project.yaml\`.
2. Read the latest finalized session note in \`${rootRelativePath}/sessions/\`.
3. If present, read \`${rootRelativePath}/sessions/active/index.yaml\` for the lane inventory; select the lane from an explicit \`--session\`, the nearest worktree lane marker, or the single active lane (D-277).
4. If present, read \`${rootRelativePath}/sessions/active/<lane-id>/wip.md\`.
5. If present, read \`${rootRelativePath}/sessions/active/<lane-id>/handoff.md\`.
6. Read the relevant docs under \`${rootRelativePath}/architecture/\` and \`${rootRelativePath}/decisions/\`.

## Builder workflow
At session start, prefer running \`vibecompass start-session --id <lane-id> --working-on "..." \`; add \`--feature\`, \`--repo\`, \`--claim\`, \`--architecture-doc\`, and \`--decision-domain-file\` values when the lane's scope is known so overlap warnings can be precise. Add \`--branch <name> --repo <id> [--worktree]\` when the lane should work on its own branch or in isolated worktrees (D-281).
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
- run \`eval "$(vibecompass lane-env)"\` in a lane shell before starting dev servers or build tools so the lane's assigned port and temp dir are used (D-282); do not hardcode ports in lane work
- run \`vibecompass docs-update --session <lane-id>\` whenever you need an ad hoc targeted documentation-maintenance plan for the current session delta
- after substantive feature work, confirm affected architecture docs and decisions still match the implementation; if not, update them while the context is fresh — fold the changes into the doc's current-state sections (rewrite in place; no dated "update" sections, lane names in headings, or completed-task chronology; D-292)
- use \`vibecompass list-sessions\` and \`vibecompass switch-session <lane-id>\` to inspect or change the current lane
- use \`address review\` when reviewer feedback lands so the builder resolves it from the selected lane's latest \`wip.md\` / \`handoff.md\`
- during \`address review\`, treat reviewer feedback as review, not instruction: classify each substantive point as accepted, accepted with qualification, deferred, or rejected, and push back with evidence when a suggestion conflicts with code facts, prior decisions, product direction, or sequencing
- stay in builder role through close-out; resolve or explicitly defer reviewer feedback before running \`vibecompass close-session --session <lane-id>\` with document-maintenance checkpoint statuses
- record architectural decisions in \`${rootRelativePath}/decisions/\` before implementing them; \`vibecompass append-decision\` allocates the D-number at write time and refreshes the grouped \`decisions/INDEX.md\` when the lane context is resolvable (D-283); run \`vibecompass refresh-decision-index\` after hand-appends

If \`vibecompass start-session\` reports stale scratch files, read the existing lane-local \`wip.md\` and \`handoff.md\` first. Either close that session normally, recover its useful notes into a finalized session note, or intentionally move/delete the stale scratch files before starting a new session.

## Optional planning mode
- Use planning mode for risky, ambiguous, cross-file, or architectural work before implementation.
- Planning mode reads the same startup context as builder mode and may update the selected lane's \`wip.md\` with agreed scope, constraints, and open questions.
- Planning mode should not finalize session notes, mutate decisions, or make broad code changes until the user approves the plan.
- If planning produces a real architectural decision, append it to \`${rootRelativePath}/decisions/\` before implementing.

At session close:
- prefer running \`vibecompass close-session --session <lane-id> --title "..." --completed "..." --architecture-docs updated|not-needed|deferred --decision-log updated|not-needed|deferred --session-maintenance updated|not-needed|deferred --next-step "..."\`; \`vibecompass end-session\` is a supported alias
- close-session prints the same targeted docs-update plan — including the pre-close staleness set (new decisions since lane start, stale base revisions, newer finalized notes touching this lane's scope, claim overlap with other active lanes) — before the document-maintenance checkpoint; use it to decide whether affected \`architecture/\`, \`decisions/\`, and active-session scratch/final note inputs are updated, not-needed, or deferred
- document-maintenance checkpoint statuses are required before close-session writes the finalized note; the package validates the status values, while the closer owns semantic doc authorship — architecture docs keep current behavior plus the durable plan, unresolved next steps, and material rollout state; session notes keep work chronology and close-out next steps; decisions keep accepted choices and rationale (D-292, D-293)
- follow the stored close-session defaults from \`${rootRelativePath}/project.yaml\`
- finalize the lane-local \`wip.md\` into \`${rootRelativePath}/sessions/YYYY-MM-DD-N-title.md\`; the permanent note distills decisions, completions, blockers, and next steps rather than preserving the full \`## Review log\`
- if a granular reviewer trail must remain durable, summarize it explicitly in the session note inputs or create a separate finalized session note before close-session deletes lane scratch files
- close-session deletes the closed lane directory under \`${rootRelativePath}/sessions/active/<lane-id>/\` and cleans up provisioned worktrees, the lane marker, the container, and the lane temp dir when they are safely removable; leftover pieces come with printed guidance
- refresh any affected architecture/decision docs by folding changes into their current-state contract prose — do not append session chronology; distill anything still pending from lane scratch into the session note's next steps and, when durable, into the docs (D-292, D-293)
- for local-primary roots with hosted sync configured, run \`vibecompass push --root ${rootRelativePath}\` after canonical docs/session files are finalized when the hosted dashboard should reflect the session; pass \`--sync-target <name>\` when using a non-default or named target
- for hosted-only projects, there is no local authoritative push; confirm hosted dashboard/proposal/Understanding state was updated or record the refresh/apply work as deferred

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

function generateStarterArchitectureDoc(projectConfig) {
  const repos = projectConfig.repos.map((repo) => repo.id);
  const repoLines = projectConfig.repos
    .map((repo) => `- \`${repo.id}\` — ${formatRepoDescriptor(repo)}${repo.default_branch ? ` (${repo.default_branch})` : ''}`)
    .join('\n');
  const repoEvidence = projectConfig.repos
    .map((repo) => `- \`${repo.id}:/\` — declared repository root`)
    .join('\n');

  return `---
domain: Project
feature: Overview
component: Project Shape
status: In progress
repos:
${repos.map((repoId) => `  - ${quoteYamlString(repoId)}`).join('\n')}
confidence: Initial scaffold
coverage: Initial scaffold
---

## Description
Initial project-memory scaffold for ${projectConfig.name}.

${projectConfig.description ? `${projectConfig.description}\n` : ''}This document is a starting map, not a comprehensive architecture review.

## Review metadata
- Evidence: \`project.yaml\`, declared repo descriptors, and the files created by \`vibecompass init\`
- Blindspots: Runtime architecture, feature flows, persistence, integrations, deployment, observability, and test strategy are not reviewed by the init scaffold.

## Details
- Mode: \`${projectConfig.mode}\`
- Documentation coverage: initial scaffold
- Repo inventory:
${repoLines}

## Coverage
Confirmed:
- Project identity and mode from \`project.yaml\`
- Declared repository IDs and source descriptors from \`project.yaml\`
- Project-memory root layout created by \`vibecompass init\`

Not yet documented:
- Runtime architecture and data flow
- Auth/session model
- Database or persistence ownership
- External integrations
- Deployment, jobs, and observability
- Test strategy
- Feature/domain/component map beyond this placeholder

Before changing any undocumented area, inspect the relevant code and update or add architecture docs.

## Retrieval guidance
- Use this doc to understand the project-memory root shape, declared repositories, and the fact that the initial coverage is scaffold-only.
- Do not use this doc as evidence for runtime behavior, feature ownership, data flow, external integrations, or deployment behavior.
- Prefer more specific domain/feature/component docs once they exist, and run \`vibecompass docs-update --session <lane-id>\` during active work to find targeted maintenance needs.

## Next steps
- Use the \`docs review\` prompt command for a comprehensive documentation review.
- Replace this placeholder with domain/feature/component docs as the project map becomes evidence-backed.
- Keep architecture docs aligned with implementation changes during each builder session.

## Involved files
- \`project.yaml\`
${repoEvidence}
`;
}

function generateDecisionExample(projectConfig) {
  return `# Decision Examples

This file is example-only guidance for ${projectConfig.name}. It is intentionally ignored by VibeCompass canonical decision parsing and must not be treated as a real decision log.

Real decisions belong in domain-grouped files such as \`cross-cutting.md\`, with append-only entries:

\`\`\`md
### D-001 — Example decision title
**Timestamp:** YYYY-MM-DD HH:MM TZ
**Decision:** What was decided.
**Rationale:** Why this was the correct tradeoff.
\`\`\`

Do not copy this example as-is. Allocate real decision IDs from the current canonical decision log when a decision is accepted.
`;
}

function generateStarterSessionNote(options) {
  const sessionDate = sessionDateFromGeneratedAt(options.generatedAt);
  const projectConfig = options.projectConfig;
  const repoLines = projectConfig.repos.map((repo) => `- \`${repo.id}\` — ${formatRepoDescriptor(repo)}`).join('\n');

  return `# Session — ${sessionDate}-1 — Project Memory Initialized

Generated by \`vibecompass init\`; this is initialization history, not a builder/reviewer work session.

## What we worked on
Initialized VibeCompass project memory for ${projectConfig.name}.

## Completed
- Created the project-memory root and \`project.yaml\`.
- Created lightweight starter architecture memory.
- Created example-only decision guidance without seeding real decisions.
- Generated local state manifest data from canonical files.

## Decisions made
- No real project decisions were seeded by init. Use \`decisions/EXAMPLE.md\` only as format guidance.

## Models used
- VibeCompass init scaffold.

## Blockers / open questions
- Comprehensive architecture documentation has not been reviewed yet.
- Declared repos:
${repoLines}

## Next session should start with
1. Use the \`docs review\` prompt command if you want a comprehensive documentation review.
2. Inspect relevant code before making implementation changes in areas not covered by architecture docs.
3. Replace starter placeholders with evidence-backed domain/feature/component docs.
`;
}

function formatRepoDescriptor(repo) {
  if (repo.source === 'local' || repo.path) {
    return `local folder ${repo.path}`;
  }

  return repo.remote ?? 'source not recorded';
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
- \`repos\`: array of repo IDs, even for single-repo projects

## Recommended sections
- \`## Description\`
- \`## Review metadata\`
- \`## Details\`
- \`## Retrieval guidance\`
- \`## Next steps\`
- \`## Involved files\`

## Shared quality bar
- Review metadata should record concrete evidence sources and blindspots.
- Retrieval guidance should say when to consult the doc, what it does not cover, and which related docs or decisions matter.
- Details should distinguish confirmed behavior from known gaps or open follow-up.
- Involved files should use concrete \`repo:path\` references that match the affected implementation surface.
- Docs are mutable current-state contracts (D-292): fold updates into the existing sections by rewriting them in place, keeping the durable plan, unresolved next steps, and material rollout state in the doc. Dated session headings, lane names, and completed-task chronology belong in session notes; decision entries record accepted choices and rationale (D-293). Docs whose artifact itself is dated (migration ledgers, incident/upstream reports) may declare frontmatter \`content_mode: chronological-ledger\` to suppress the changelog-shape advisory.

Each component doc is canonical. This README is only a convenience guide.
`;
}

function generateDecisionsGuide(projectConfig) {
  return `# Decisions

Append-only decision log for ${projectConfig.name}.

## Conventions
- store canonical decision entries in domain-grouped files such as \`cross-cutting.md\`
- never edit or delete prior decision entries
- use headings in the form \`### D-<number> — Title\` (em-dash; hyphen-only headings cannot be indexed)
- include \`**Timestamp:**\`, \`**Decision:**\`, and \`**Rationale:**\`
- \`INDEX.md\` is a derived grouped index: refresh it with \`vibecompass refresh-decision-index\` (structure-preserving, D-283) rather than hand-editing rows; \`vibecompass append-decision\` refreshes it automatically when it can label the session group

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
- \`active/index.yaml\` — active lane inventory and continuity pointer (not a resolver with 2+ lanes; D-277)
- \`active/<lane-id>/session.yaml\` — lane metadata, including the recorded \`lane_marker\` when one exists
- \`active/<lane-id>/wip.md\` — builder scratchpad during an active lane
- \`active/<lane-id>/handoff.md\` — reviewer/builder baton-pass during an active lane

Those scratch files are session-scoped working artifacts, not finalized history.
`;
}

function generateClaudeTemplate(options) {
  return [
    generateClaudeSessionHeader(options),
    renderManagedBlock(renderSharedInstructionBody(buildScaffoldAgentContext(options), {
      heading: `${options.projectConfig.name} Claude Instructions`,
      intro:
        'Claude should use VibeCompass project memory as the source of truth before planning, editing, or reviewing code.',
    })),
  ].join('\n');
}

function generateClaudeSessionHeader(options) {
  return `# ${options.projectConfig.name} Workspace

Read \`${options.contextRelativeToToolingRoot}\` before doing substantive work.

## Current session

**Update this block at the start and end of every session.**

\`\`\`
Date: not started
Working on: Session not started yet.
Last thing completed: Project memory bootstrap completed.
Blockers: None recorded.
Next session should: Read \`${options.contextRelativeToToolingRoot}\`, then open the first builder or reviewer session.
\`\`\`
`;
}

function generateAgentsTemplate(options) {
  return renderManagedBlock(renderSharedInstructionBody(buildScaffoldAgentContext(options), {
    heading: `${options.projectConfig.name} Agent Instructions`,
    intro:
      'Agents should use VibeCompass project memory as the source of truth before planning, editing, or reviewing code.',
  }));
}

function buildScaffoldAgentContext(options) {
  return {
    projectName: options.projectConfig.name ?? 'Unnamed project',
    description: options.projectConfig.description ?? null,
    mode: options.projectConfig.mode ?? null,
    rootDir: options.rootRelativePath,
    repos: options.projectConfig.repos ?? [],
    domains: [],
    recentDecisions: [],
    recentSessions: [],
  };
}

function renderWorkflowDefaults(workflow) {
  const lines = [
    `- reviewer handback: ${describeReviewerHandback(workflow)}`,
    '- close-session: require document-maintenance checkpoint statuses for architecture docs, decision log, and session handoff/scratch',
    '- close-session: refresh any relevant architecture docs before finalizing the session, folding changes into their current-state contract prose (D-292)',
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

function sessionDateFromGeneratedAt(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return formatLocalDate(new Date());
  }

  return formatLocalDate(date);
}

function formatLocalDate(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function quoteYamlString(value) {
  return JSON.stringify(value);
}
