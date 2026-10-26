import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_REVIEW_CHECK, DEFAULT_ROUND_CAP } from './review-log.js';
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

  // The decisions behind each section's rules, one per place the text states
  // one; the rendered text names none of the package's decision numbers:
  // - Canonical files: architecture docs D-292.
  // - Derived and scratch files: brief.md D-359, D-364, its opt-in D-368; the
  //   lane marker D-280; INDEX.md D-283.
  // - Session model: the brief's opt-in D-368 and brief.md D-359, D-364; lane
  //   selection D-277; open sessions D-353; the lane's role D-392; plan tasks
  //   D-395 and task lines D-393; git binding D-281; lane runtime D-282;
  //   architecture docs D-292, D-293.
  // - Session roles: continue session's role D-392; the owner D-392.
  // - Session prompt commands: reviewer handback D-394, D-392.
  // - Session startup: lane selection D-277.
  // - Open, resume, or choose: D-353, D-392.
  // - Builder workflow: --plan-task D-395; git binding D-281; lane-env D-282;
  //   current-state docs D-292; response and owner lines D-394; who counts as
  //   a reviewer D-398; re-reading before a release, merge, or push D-392;
  //   append-decision D-283; an existing lane D-353.
  // - At session close: what each doc keeps D-292, D-293; the note's Review
  //   section D-394; folding pending work into docs D-292, D-293.
  // - Reviewer workflow: who counts as a reviewer D-398; write nothing else
  //   D-392.
  // - Review log format: D-394, D-398; who counts as a reviewer D-398.
  // - Project manager workflow: D-392, D-393; --plan-task D-395; checking the
  //   note's Review section D-398.
  return `# Project Context — ${projectName}

This workspace uses VibeCompass project memory rooted at \`${rootRelativePath}\`.

## Canonical files
- \`${rootRelativePath}/project.yaml\` — machine-oriented project metadata
- \`${rootRelativePath}/architecture/\` — canonical architecture docs; the mutable current-state layer, rewritten in place as contracts change
- \`${rootRelativePath}/decisions/\` — append-only decision log for this project-memory root
- \`${rootRelativePath}/sessions/\` — finalized session notes

## Derived and scratch files
- \`${rootRelativePath}/context.md\` — generated AI-facing workflow context
- \`${rootRelativePath}/state/manifest.json\` — machine-owned local state; do not hand-edit
- \`${rootRelativePath}/sessions/active/index.yaml\` — active session lane inventory and continuity pointer
- \`${rootRelativePath}/sessions/active/<lane-id>/session.yaml\` — lane metadata (including the lane's \`role\` and the recorded \`lane_marker\` when one exists)
- \`${rootRelativePath}/sessions/active/<lane-id>/wip.md\` — lane-local builder scratchpad
- \`${rootRelativePath}/sessions/active/<lane-id>/handoff.md\` — lane-local builder/reviewer relay
- \`${rootRelativePath}/sessions/active/<lane-id>/brief.md\` — generated session brief: the memory this lane should read first, written by \`start-session\` and \`continue-session\` when \`brief.enabled: true\` (opt-in) or on request with \`vibecompass brief --write\`; never hand-edit
- \`.vibecompass-lane.yaml\` — worktree-local lane marker; lives outside the memory root, written only by \`vibecompass write-lane-marker\` or worktree provisioning, never synced
- \`${rootRelativePath}/decisions/INDEX.md\` — derived grouped decision index; refresh with \`vibecompass refresh-decision-index\` (structure-preserving) instead of hand-editing rows

## Session model
- VibeCompass active builder sessions are named lanes. Use one lane per active feature or workstream.
- \`vibecompass start-session\` requires \`--id <lane-id>\` so each active lane has a meaningful feature or workstream name.
- The active lane scratch files live under \`${rootRelativePath}/sessions/active/<lane-id>/\`.
- When \`${rootRelativePath}/project.yaml\` sets \`brief.enabled: true\` (opt-in), \`start-session\` and \`continue-session\` write the lane's generated \`brief.md\`: the task is the lane's working-on, the files its claims, and the features its feature slugs. A brief failure is reported as a warning or an incomplete brief and never fails the lifecycle command. \`--no-brief\` skips it for one command, \`vibecompass brief --session <lane-id> --write\` writes one on request whatever the setting, and \`brief.exclude\` lists root-relative globs the brief must never read.
- Lane selection: an explicit \`--session\` wins, then the nearest worktree lane marker (\`.vibecompass-lane.yaml\`, walking up from cwd), then the single active lane. With two or more active lanes there is no implicit current-lane fallback.
- \`${rootRelativePath}/sessions/active/index.yaml\` is the lane inventory; its \`current\` pointer and the tool-specific Current session block are human-readable continuity summaries, not the lane-selection source of truth.
- An active lane directory is an open session, not an unclosed crash. Resume it with \`vibecompass continue-session [<lane-id>]\`: the lane keeps its opening date and session number; the command records \`resumed_at\`/\`resume_count\` in \`session.yaml\`, appends a dated \`Resumed\` line to \`wip.md\`, moves the index \`current\` hint and the Current session block to the lane, and re-emits runtime, git-binding, and staleness warnings. \`start-session --id <existing-lane>\` fails closed and names \`continue-session\`.
- Each lane records its role in \`session.yaml\`: \`builder\`, the default, or \`project-manager\`, set with \`start-session --role project-manager\`. A lane without the field is a builder lane. No command changes a lane's role: \`continue-session\` resumes the lane in it and prints it, \`list-sessions\` names a project-manager lane's role, and \`list-sessions --json\` gives every lane's.
- A lane may link the plan tasks it works on: \`start-session --plan-task "<plan-path>#<ID>"\`, repeatable and quoted, since \`#\` is a glob character in zsh. Each link must name a task line (\`- [ ] <ID> — <scope>\`) in the plan's \`## Next steps\`, or nothing is written; a ticked task warns and is kept. Links are stored as \`plan_tasks\` in \`session.yaml\`, and the plan joins the lane's \`architecture_docs\`. \`continue-session --plan-task\` adds links, and nothing removes one. \`list-sessions\` prints a linked lane's \`tasks:\` line (\`planTasks\` in \`--json\`), and \`close-session\` lists the links in the note's \`## Plan tasks\` section and ticks nothing.
- Optional git binding: \`start-session --branch <name> --repo <id> [--worktree]\` creates or reuses the branch in every bound repo; \`--worktree\` additionally provisions per-repo worktrees under \`<workspace>/worktrees/<lane-id>/<repo-id>\` with the lane marker written into the container, so commands run from inside a worktree need neither \`--root\` nor \`--session\`. Binding is opt-in and git is never required for lanes.
- At close, \`close-session\` removes a bound lane's recorded clean worktrees (guarded and never forced: dirty, in-use, or unverifiable worktrees survive with guidance, the lane marker is kept while any worktree survives, and branches are never deleted). Do not hand-remove provisioned worktrees; follow the printed guidance instead.
- Every lane gets a per-lane runtime assignment at start: a lane port and temp dir recorded in \`session.yaml\` and exported with \`eval "$(vibecompass lane-env)"\` (includes conventional \`PORT\`/\`TMPDIR\` aliases), so parallel lanes never fight over dev-server ports or temp paths. Defaults are configurable under \`project.yaml\` \`runtime:\`; \`close-session\` removes the lane temp dir under guards.
- Finalized sessions are append-only notes named \`${rootRelativePath}/sessions/YYYY-MM-DD-N-title.md\`; multiple sessions on the same day increment \`N\`.
- Decisions remain append-only and independent from session notes. A session note may reference decisions, but the decision entry in \`${rootRelativePath}/decisions/\` is the durable decision record for this root.
- Architecture docs are the opposite of the append-only surfaces: they are current-state contracts, rewritten in place. Fold changes into the existing sections and keep the durable plan, unresolved next steps, and material rollout state in the doc. Work/ship chronology belongs in finalized session notes; decision entries record accepted choices and rationale; lane scratch holds only transient execution/review state, and anything still pending at close moves to the session note's next steps and, when durable, into architecture. Intentionally dated ledger/report docs may declare frontmatter \`content_mode: chronological-ledger\`.

## Repos in scope
${repos}

## Session roles
| Entry trigger | Role | Owns session lifecycle? |
|---|---|---|
| "start session" | Builder | Yes — opens a new lane, keeps scratch files current, and writes the final session note |
| "continue session" | The lane's recorded role: builder, or project manager for a lane opened with \`--role project-manager\` | Yes — resumes an already-open lane in that role and owns its lifecycle from there |
| "join as reviewer" | Reviewer | No — reviews the builder's work, appends findings, and updates handoff guidance |
| "join as project manager" | Project manager | Only of its own lanes — plans tasks, writes build prompts, and checks close reports from a standing conversation with no lane; opens a short lane of its own (\`--role project-manager\`) only to change canonical memory, and closes it the way a builder does |

The owner is the person who brings the idea and makes the decisions; the owner is not a session role.

## Session prompt commands
${promptCommands}

These are prompt commands for agent behavior, not \`vibecompass\` CLI subcommands.
Reviewer handback is explicit: the reviewer ends the pass by updating the selected lane's \`wip.md\` › \`## Review log\` (record lines in the Review log format below) and \`handoff.md\` › \`## Reviewer → Builder\`, the only two sections a pass writes, and then stopping. The \`close session\` prompt runs builder close-out and ends with \`vibecompass close-session --session <lane-id>\` plus document-maintenance checkpoint statuses, which follows the workflow defaults recorded in \`${rootRelativePath}/project.yaml\`.
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
3. Inventory active lanes with \`vibecompass list-sessions\` (or read \`${rootRelativePath}/sessions/active/index.yaml\`), then follow the "Open, resume, or choose" protocol below to decide between opening a new lane and resuming one; select a lane from an explicit \`--session\`, the nearest worktree lane marker, or the single active lane.
4. If present, read \`${rootRelativePath}/sessions/active/<lane-id>/wip.md\`.
5. If present, read \`${rootRelativePath}/sessions/active/<lane-id>/handoff.md\`.
6. If present, read \`${rootRelativePath}/sessions/active/<lane-id>/brief.md\` before planning: the generated session brief selects the architecture docs, decisions (with their declared successors), and notes for the lane's task. Its status line says whether it is complete, partial, incomplete (read the listed required reads first), or no-match; \`vibecompass brief --check\` reports whether it is stale.
7. Read the relevant docs under \`${rootRelativePath}/architecture/\` and \`${rootRelativePath}/decisions/\`, starting from the brief's units and follow-up reads.

The project manager (\`join as project manager\`) reads steps 1–3, then \`${rootRelativePath}/workflows/project-manager.md\` and the plan; it opens and selects no lane (Project manager workflow).

## Open, resume, or choose
Both \`start session\` and \`continue session\` begin with the active-lane inventory. Every lane has a role: builder, unless the inventory names \`role project-manager\`. \`continue session\` counts every lane and resumes each in its recorded role; \`start session\` counts only builder lanes and never resumes a project-manager lane. Then:
- **No active lane:** open one with \`vibecompass start-session --id <lane-id> --working-on "..."\`. \`continue session\` with no lane reports that there is nothing to resume and hands off to \`start session\`.
- **Exactly one active lane, or a cwd bound to a lane by a worktree marker:** resume it with \`vibecompass continue-session\` without asking. Open a second lane only when the user is clearly asking for separate new work; never re-open a lane that already exists.
- **Two or more active lanes, no marker, no lane named by the user:** do not guess. Present the inventory (lane id, working-on, opened date, resume count, branch/worktree, last log line) and ask which lane to continue or whether to open a new one. The index \`current\` pointer and the Current session block are continuity hints to mention, never defaults to adopt silently. Resume with \`vibecompass continue-session <lane-id>\` once the user answers (\`continue session <lane-id>\`).
- **Lane named by the user:** \`continue session <lane-id>\` resumes that lane in its recorded role; an unknown id fails closed with the inventory.
- **Both roles open, under \`start session\`:** apply the rules above to the builder lanes only.
  - One builder lane and one project-manager lane: resume the builder lane by id, \`vibecompass continue-session <lane-id>\`, because the command without an id refuses whenever two or more lanes are open.
  - Only project-manager lanes: open a new builder lane.
- **The role on resume:** \`continue-session\` prints the role it resumed. A project-manager lane resumes as project manager, with that role's write limits (Project manager workflow); every other lane resumes as builder.
- After resuming, read the lane's \`wip.md\` (latest \`## Log\` entries and \`## Reviewer input needed\`), \`handoff.md\`, \`brief.md\` if present (with \`brief.enabled: true\`, continue-session keeps a current brief and regenerates a missing or stale one), and the latest finalized note; treat resume-staleness warnings (new decisions past the lane snapshot, stale base revisions, newer finalized notes touching the lane scope, claim overlap) as required reading before editing.
- Run recovery (reconstruct a missing finalized note from git history) only when the Current session block date is in the past *and* no active lane exists *and* no finalized note covers that date. An active lane with a past date is simply resumable.

## Builder workflow
At session start, prefer running \`vibecompass start-session --id <lane-id> --working-on "..." \`; add \`--feature\`, \`--repo\`, \`--claim\`, \`--architecture-doc\`, and \`--decision-domain-file\` values when the lane's scope is known so overlap warnings can be precise, and \`--plan-task "<plan-path>#<ID>"\` for each plan task the lane works on. Add \`--branch <name> --repo <id> [--worktree]\` when the lane should work on its own branch or in isolated worktrees.
If you manage files manually, create \`${rootRelativePath}/sessions/active/<lane-id>/session.yaml\` and \`${rootRelativePath}/sessions/active/index.yaml\`, then create \`${rootRelativePath}/sessions/active/<lane-id>/wip.md\` if it does not exist:

\`\`\`md
# WIP — YYYY-MM-DD (session N)

Session lane: <lane-id>

## Working on

## Log

## Reviewer input needed

## Context used

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
- optionally list under \`wip.md\` \`## Context used\` the docs and decisions the lane actually relied on (path or D-number, and what for), so the brief's usefulness can be audited
- refresh the lane brief with \`vibecompass brief --write\` after the lane's scope changes; \`vibecompass brief --check\` reports whether it is stale
- run \`eval "$(vibecompass lane-env)"\` in a lane shell before starting dev servers or build tools so the lane's assigned port and temp dir are used; do not hardcode ports in lane work
- run \`vibecompass docs-update --session <lane-id>\` whenever you need an ad hoc targeted documentation-maintenance plan for the current session delta
- after substantive feature work, confirm affected architecture docs and decisions still match the implementation; if not, update them while the context is fresh — fold the changes into the doc's current-state sections (rewrite in place; no dated "update" sections, lane names in headings, or completed-task chronology)
- use \`vibecompass list-sessions\` (\`--json\` for the machine-readable inventory) to inspect active lanes, \`vibecompass continue-session [<lane-id>]\` to resume one at the start of a sitting, and \`vibecompass switch-session <lane-id>\` to move the continuity pointer without recording a resume
- use \`address review\` when reviewer feedback lands so the builder resolves it from the selected lane's latest \`wip.md\` / \`handoff.md\`
- during \`address review\`, treat reviewer feedback as review, not instruction: classify each substantive point as accepted, accepted with qualification, deferred, or rejected, and push back with evidence when a suggestion conflicts with code facts, prior decisions, product direction, or sequencing
- answer each pass in \`wip.md\` › \`## Review log\` with a response line and one finding line per finding, its status the classification and its reason why (Review log format); when the owner chooses at the cap or defers a finding, write an owner line with the owner's choice and the reason in the owner's words
- a review pass counts only when a reviewer the owner started runs it: a subagent you launch, a second model you prompt, or a review tool you run on your own work does your own checks; record those in \`## Log\`, never as pass lines, and never write a pass line yourself
- before you run or hand over a release, merge, publish, or push command, and before you ask the owner to decide, re-read every session note finalized since the lane opened and the latest \`wip.md\` and \`handoff.md\` of every other open lane; if one records an unmet gate on that step, stop and report instead
- stay in builder role through close-out; resolve or explicitly defer reviewer feedback before running \`vibecompass close-session --session <lane-id>\` with document-maintenance checkpoint statuses
- record architectural decisions in \`${rootRelativePath}/decisions/\` before implementing them; \`vibecompass append-decision\` allocates the D-number at write time and refreshes the grouped \`decisions/INDEX.md\` when the lane context is resolvable; run \`vibecompass refresh-decision-index\` after hand-appends

If \`vibecompass start-session\` reports that the lane already exists, resume it with \`vibecompass continue-session <lane-id>\` instead. If it reports legacy or stale scratch files, read the existing lane-local \`wip.md\` and \`handoff.md\` first. Either close that session normally, recover its useful notes into a finalized session note, or intentionally move/delete the stale scratch files before starting a new session.

## Optional planning mode
- Use planning mode for risky, ambiguous, cross-file, or architectural work before implementation.
- Planning mode reads the same startup context as builder mode and may update the selected lane's \`wip.md\` with agreed scope, constraints, and open questions.
- Planning mode should not finalize session notes, mutate decisions, or make broad code changes until the user approves the plan.
- If planning produces a real architectural decision, append it to \`${rootRelativePath}/decisions/\` before implementing.

At session close:
- prefer running \`vibecompass close-session --session <lane-id> --title "..." --completed "..." --architecture-docs updated|not-needed|deferred --decision-log updated|not-needed|deferred --session-maintenance updated|not-needed|deferred --next-step "..."\`; \`vibecompass end-session\` is a supported alias
- close-session prints the same targeted docs-update plan — including the pre-close staleness set (new decisions since lane start, stale base revisions, newer finalized notes touching this lane's scope, claim overlap with other active lanes) — before the document-maintenance checkpoint; use it to decide whether affected \`architecture/\`, \`decisions/\`, and active-session scratch/final note inputs are updated, not-needed, or deferred
- document-maintenance checkpoint statuses are required before close-session writes the finalized note; the package validates the status values, while the closer owns semantic doc authorship — architecture docs keep current behavior plus the durable plan, unresolved next steps, and material rollout state; session notes keep work chronology and close-out next steps; decisions keep accepted choices and rationale
- follow the stored close-session defaults from \`${rootRelativePath}/project.yaml\`
- run \`vibecompass review-check --session <lane-id>\` before close-session: it runs the check close-session runs (Review log format) and prints each finding's state; resolve what it reports, or take it to the owner
- finalize the lane-local \`wip.md\` into \`${rootRelativePath}/sessions/YYYY-MM-DD-N-title.md\`; close-session writes the note's \`## Review\` section after \`## Models used\` from the record (its \`Check:\` and \`Passes:\` lines, one line per finding, and each owner line) and adds each deferred finding to the next steps unless a \`--next-step\` names its id, so the review needs no \`--completed\` line; add context with \`--review-note "<text>"\` (repeatable), and pass \`--review-override "<reason>"\` only on the owner's instruction, with the owner's reason in the owner's words
- close-session deletes the closed lane directory under \`${rootRelativePath}/sessions/active/<lane-id>/\` and cleans up provisioned worktrees, the lane marker, the container, and the lane temp dir when they are safely removable; leftover pieces come with printed guidance
- refresh any affected architecture/decision docs by folding changes into their current-state contract prose — do not append session chronology; distill anything still pending from lane scratch into the session note's next steps and, when durable, into the docs
- for local-primary roots with hosted sync configured, run \`vibecompass push --root ${rootRelativePath}\` after canonical docs/session files are finalized when the hosted dashboard should reflect the session; pass \`--sync-target <name>\` when using a non-default or named target
- for hosted-only projects, there is no local authoritative push; confirm hosted dashboard/proposal/Understanding state was updated or record the refresh/apply work as deferred

## Reviewer workflow
- use \`review handoff\` when you want the reviewer to run the next review pass
- you are the lane's reviewer only when the owner started you and pointed you at the lane with \`review handoff <lane-id>\`; an agent the builder launched or directed does the builder's own checks: it reports to the builder and writes no pass line
- read the latest finalized session note, then the selected lane's \`wip.md\`, then \`handoff.md\`
- inspect the relevant code/docs diffs
- append the pass to \`wip.md\` › \`## Review log\` as record lines (Review log format): a pass line, then a finding line for each new finding (\`open\`) and a verdict on each finding the builder answered (\`confirmed\`, \`reopened\`, or \`withdrawn\`), with detail and evidence on continuation lines; \`<reviewer>\` names your tool and model
- write a concise baton-pass summary into \`handoff.md\` › \`## Reviewer → Builder\`
- write nothing else: a pass writes only the selected lane's \`wip.md\` › \`## Review log\` and \`handoff.md\` › \`## Reviewer → Builder\`. A change you think is needed anywhere else (code, docs, decisions, agent files, settings) is a finding or a proposal to the owner, not an edit. Read-only commands stay allowed
- end the review pass after those file updates; there is no separate reviewer-exit step

## Review log format
A lane's \`wip.md\` › \`## Review log\` holds only record lines, finding lines, continuation lines, and blank lines: no prose, headings, or code fences. Fields are separated by \` | \` (space, bar, space), and the last field takes the rest of the line.
- **Pass line** (reviewer): \`- pass <n> | <time> | <reviewer> | <scope> | <outcome>\`. Passes are numbered 1, 2, 3… within the lane. \`<outcome>\` is \`no findings\` when the pass opens and reopens nothing, and \`findings\` otherwise.
- **Response line** (builder): \`- response <n> | <time> | <builder>\`, answering pass \`<n>\`.
- **Owner line** (written by the builder, or the owner, in the owner's words): \`- owner | <time> | <owner> | <choice> | <reason>\`. \`<choice>\` is \`another round\`, \`defer <id>[, <id>…]\`, or \`leave open\`.
- **Finding line**, indented two spaces under a pass or response line: \`  - <id> | <severity> | <status> | <reason>\`. Under a pass line, \`<status>\` is \`open\` (a new finding), \`confirmed\`, \`reopened\`, or \`withdrawn\`; under a response line, \`accepted\`, \`accepted with qualification\`, \`deferred\`, or \`rejected\`. \`<reason>\` is never empty: on \`open\` it states the finding, and otherwise it says why.
- **Continuation lines**, indented four or more spaces under a finding line, carry detail and evidence. The check ignores them.
- \`<time>\` is \`YYYY-MM-DD HH:MM\` taken from \`date\`, optionally followed by a zone (\`PDT\`, \`+07:00\`). \`<reviewer>\`, \`<builder>\`, and \`<owner>\` name a person, or a tool and model (\`Codex (GPT-6)\`). \`<scope>\` names what the pass read. \`<id>\` is \`R<p>.<k>\`: the pass that opened the finding and its number in that pass (\`R1.1\`); a reopened finding keeps its id. \`<severity>\` is \`P1\` (fix before the work ships), \`P2\` (fix before close), or \`P3\` (minor).
- Nobody edits or deletes an earlier line while the lane is open. A line in the record format that doesn't parse was never a record, and the role that wrote it may correct it in place; free text is never rewritten into records.

\`\`\`
## Review log
- pass 1 | 2026-10-20 10:42 PDT | Codex (GPT-6) | the four draft decisions | findings
  - R1.1 | P2 | open | the owner line doesn't say who writes it
  - R1.2 | P3 | open | \`leave open\` changes nothing the check can see
- response 1 | 2026-10-20 11:05 PDT | Claude Opus 5.5
  - R1.1 | P2 | accepted | item 2 now says the builder writes it in the owner's words
  - R1.2 | P3 | rejected | it records the owner's choice for the note; the check ignores it on purpose
- pass 2 | 2026-10-20 11:40 PDT | Codex (GPT-6) | pass 1 responses; the docs | no findings
  - R1.1 | P2 | confirmed | fixed in item 2
  - R1.2 | P3 | confirmed | accepts the reason
\`\`\`

A finding is resolved when its latest line is the reviewer's \`confirmed\` or \`withdrawn\`; a confirmed \`deferred\` is resolved as a deferral, and the note carries the builder's reason. An owner \`defer\` line keeps a finding unresolved but out of the check's failures until the reviewer's next line for it.

**Who counts as a reviewer.** A pass is a run by a reviewer the owner started and pointed at the lane with \`review handoff <lane-id>\`: an agent session the owner opened, or a person the owner asked. An agent the builder launched or directed (a subagent, a second model it prompts, a review tool it runs on its own work) is not a reviewer, whatever its model: its checks are builder work, recorded in \`## Log\`, and the builder writes no pass line. The check can't see who started a run, so the project manager compares each pass's reviewer with the reviewer the build prompt or the owner named. When the owner accepts work with no independent pass, the builder closes with \`--review-override "<reason>"\` in the owner's words; that is not a pass.

**The check.** \`close-session\` runs it after reading \`wip.md\` and before writing anything, and \`vibecompass review-check --session <lane-id>\` runs it on an open lane without closing it. It fails when the log has no pass line; when the log is malformed (the message names the first bad line, and a malformed log has no parseable pass); when a finding is open and not deferred by the owner; or when pass \`<n>\` beyond the cap has fewer than \`<n>\` minus the cap owner \`another round\` lines before it. It covers every builder lane, and a project-manager lane once its log has a pass line. \`metadata.workflow.review.check\` sets what a failure does (Workflow defaults).

## Project manager workflow
- \`join as project manager <plan-path>\` enters the role. It opens no lane and selects none: read Session startup steps 1–3, then \`${rootRelativePath}/workflows/project-manager.md\` (the role in full: inputs and outputs, build prompts, checking close reports, when to move on, the plan format, operating rules, and publication), then the plan. With no plan named, ask which plan to run, or offer to write one.
- The project manager plans tasks, writes each build lane's prompt, checks each close report against primary sources, decides when the plan moves to the next task, and escalates to the owner with options and a recommendation. It doesn't write product code and doesn't stand in for the reviewer.
- It reads all of project memory, plus other lanes' \`wip.md\`, \`handoff.md\`, and \`brief.md\`, read only. Status reports, prompts, and report checks need no lane.
- It changes canonical memory (plans, architecture docs, decisions) only inside short lanes of its own: opened with \`vibecompass start-session --id <lane-id> --working-on "..." --role project-manager\`, run with the builder's lane mechanics, and closed with \`close session\` in the same sitting. \`continue session <lane-id>\` resumes such a lane as project manager.
- It never edits another lane's scratch files, never writes into a closed lane, and never hand-edits package output.
- Each build prompt's \`start-session\` line links the lane to its tasks with \`--plan-task "<plan-path>#<ID>"\`, one per task, with the reference quoted, since \`#\` is a glob character in zsh; \`--working-on\` stays free text. The lane's finalized note lists the links under \`## Plan tasks\`. close-session ticks nothing: the prompt's close-out says who ticks each task, only once its work is merged and verified, and who annotates it otherwise.
- When it checks a close report, it reads the note's \`## Review\` section: the \`Check:\` line, and the reviewers on the \`Passes:\` line, compared with the reviewer the build prompt named and any the owner has named since. A pass by the builder's own tool and model, or by a reviewer nobody named, counts when the prompt or the owner's word says the owner started that reviewer; it goes to the owner when nothing does or the record shows the builder launched or directed the run, whatever the pass line names.

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

// A local-folder source shows its folder; a Git repo shows its remote, plus
// the local path where one is recorded beside it (PC2).
function formatRepoDescriptor(repo) {
  if (repo.source === 'local' || (repo.path && !repo.remote)) {
    return `local folder ${repo.path}`;
  }

  if (repo.remote) {
    return repo.path ? `${repo.remote} (local path ${repo.path})` : repo.remote;
  }

  return 'source not recorded';
}

// Shared quality bar, current-state docs: D-292, D-293.
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
- Docs are mutable current-state contracts: fold updates into the existing sections by rewriting them in place, keeping the durable plan, unresolved next steps, and material rollout state in the doc. Dated session headings, lane names, and completed-task chronology belong in session notes; decision entries record accepted choices and rationale. Docs whose artifact itself is dated (migration ledgers, incident/upstream reports) may declare frontmatter \`content_mode: chronological-ledger\` to suppress the changelog-shape advisory.

Each component doc is canonical. This README is only a convenience guide.
`;
}

// Conventions, INDEX.md: D-283. The example heading shows the install's own
// numbering, not a package decision.
function generateDecisionsGuide(projectConfig) {
  return `# Decisions

Append-only decision log for ${projectConfig.name}.

## Conventions
- store canonical decision entries in domain-grouped files such as \`cross-cutting.md\`
- never edit or delete prior decision entries
- use headings in the form \`### D-<number> — Title\` (em-dash; hyphen-only headings cannot be indexed)
- include \`**Timestamp:**\`, \`**Decision:**\`, and \`**Rationale:**\`
- \`INDEX.md\` is a derived grouped index: refresh it with \`vibecompass refresh-decision-index\` (structure-preserving) rather than hand-editing rows; \`vibecompass append-decision\` refreshes it automatically when it can label the session group

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

// Active-session scratch files: index.yaml D-277; brief.md D-359, D-364.
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
- \`active/index.yaml\` — active lane inventory and continuity pointer (not a resolver with 2+ lanes)
- \`active/<lane-id>/session.yaml\` — lane metadata, including the recorded \`lane_marker\` when one exists
- \`active/<lane-id>/wip.md\` — builder scratchpad during an active lane
- \`active/<lane-id>/handoff.md\` — reviewer/builder baton-pass during an active lane
- \`active/<lane-id>/brief.md\` — generated session brief for the lane; regenerated, never hand-edited

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
    '- close-session: refresh any relevant architecture docs before finalizing the session, folding changes into their current-state contract prose', // D-292
    '- close-session: refresh any relevant decision files before finalizing the session',
    `- review check: \`metadata.workflow.review.check\` is \`${workflow.review.check}\`${workflow.review.check === DEFAULT_REVIEW_CHECK ? ' (the default)' : ''}; on a failed check, \`warn\` closes and records the failures in the note, \`block\` refuses to close and writes nothing, and \`off\` skips the check`, // D-394
    `- review round cap: \`metadata.workflow.review.round_cap\` is ${workflow.review.roundCap}${workflow.review.roundCap === DEFAULT_ROUND_CAP ? ' (the default)' : ''}; a pass beyond it needs an owner \`another round\` line before it`, // D-394
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
    return 'update sessions/active/<lane-id>/wip.md › ## Review log and sessions/active/<lane-id>/handoff.md › ## Reviewer → Builder, the only sections a pass writes, then stop the review pass'; // D-392
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
