import { PACKAGE_VERSION } from '../version.js';

export const WORKFLOW_REGISTRY = [
  {
    id: 'session-lifecycle',
    title: 'Session lifecycle',
    detailPath: 'context.md',
    summary: 'Builder/reviewer/project-manager lane lifecycle, handoffs, planning mode, and close-out.',
    promptCommands: [
      { trigger: 'start session', summary: 'builder role trigger; opens a new named lane — if a builder lane is already active, resume it with `continue session` instead of opening a duplicate; `start session` never resumes a project-manager lane' }, // D-392
      { trigger: 'continue session', summary: 'resumes an already-open lane with `vibecompass continue-session [<lane-id>]`, in the role the lane records: builder, or project manager for a lane opened with `--role project-manager`; with multiple active lanes name the lane explicitly: `continue session <lane-id>` — the agent presents the lane inventory and asks rather than guessing' }, // D-353, D-392
      { trigger: 'join as reviewer', summary: 'reviewer role trigger' },
      // The trigger is a session-lifecycle entry (D-392); the generated guide
      // it points to belongs to the project-manager entry below.
      { trigger: 'join as project manager', summary: 'project manager role trigger, with the plan to run: `join as project manager <plan-path>`; opens and selects no lane, reads the session startup steps 1–3, then the project manager workflow, then the plan, and with no plan named asks which plan to run or offers to write one', detailPath: 'workflows/project-manager.md' }, // D-392
      { trigger: 'planning mode', summary: 'optional prompt-level mode for scoping work before implementation' },
      { trigger: 'review handoff', summary: 'reviewer reads the selected lane handoff and records the pass as record lines in `wip.md` › `## Review log` and a summary in `handoff.md` › `## Reviewer → Builder`, the only two sections a pass writes; with multiple active lanes name the lane explicitly: `review handoff <lane-id>`' }, // D-394, D-392
      { trigger: 'address review', summary: 'builder critically resolves reviewer feedback from the selected lane scratch files and answers each pass with a response line in `wip.md` › `## Review log`' }, // D-394
      { trigger: 'docs update', summary: 'builder runs a targeted session-delta documentation maintenance plan with `vibecompass docs-update --session <lane-id>`' },
      { trigger: 'close session', summary: 'builder runs the close-out checklist and ends with `vibecompass close-session --session <lane-id>` plus required document-maintenance checkpoint statuses; `end session` and `vibecompass end-session` are accepted aliases; a project manager closes its own lanes the same way' },
    ],
  },
  {
    id: 'project-manager',
    title: 'Project manager',
    detailPath: 'workflows/project-manager.md',
    summary: 'Plan tasks, write build prompts, check close reports, and decide when to move on.', // D-392, D-393
    // Entered through the session-lifecycle trigger above; this entry owns
    // only the generated guide.
    promptCommands: [],
    generatedFileKind: 'workflow-project-manager',
    renderFile: renderProjectManagerWorkflow,
  },
  {
    id: 'docs-review',
    title: 'Docs review',
    detailPath: 'workflows/docs-review.md',
    summary: 'Generate evidence-backed architecture docs from the user\'s preferred AI session.',
    promptCommands: [
      { trigger: 'docs review', summary: 'agent-led architecture documentation review using the preferred LLM prompt box' },
    ],
    generatedFileKind: 'workflow-docs-review',
    renderFile: renderDocsReviewWorkflow,
  },
];

export function getPromptCommands() {
  return WORKFLOW_REGISTRY.flatMap((workflow) =>
    workflow.promptCommands.map((command) => ({
      ...command,
      workflowId: workflow.id,
      workflowTitle: workflow.title,
      detailPath: command.detailPath ?? workflow.detailPath,
    })),
  );
}

export function getWorkflowConflictScanPatterns() {
  const patterns = new Set([
    'session',
    'handoff',
    'decisions',
    'wip.md',
    'builder',
    'reviewer',
  ]);

  for (const command of getPromptCommands()) {
    const normalizedTrigger = command.trigger.toLowerCase();
    patterns.add(normalizedTrigger);
    patterns.add(slugifyPromptTrigger(normalizedTrigger));
  }

  return Array.from(patterns);
}

export function getGeneratedWorkflowFiles(options = {}) {
  const rootRelativePath = options.rootRelativePath ?? '.';
  return WORKFLOW_REGISTRY
    .filter((workflow) => typeof workflow.renderFile === 'function')
    .map((workflow) => ({
      kind: workflow.generatedFileKind,
      relativePath: workflow.detailPath,
      content: workflow.renderFile({
        rootRelativePath,
        workflow,
      }),
    }));
}

export function renderPromptCommandLines(options = {}) {
  const rootRelativePath = options.rootRelativePath ?? '.';
  return getPromptCommands().map((command) => {
    const detailPath = command.detailPath
      ? ` Read \`${joinRootRelative(rootRelativePath, command.detailPath)}\` for the full workflow.`
      : '';
    return `- \`${command.trigger}\` — ${command.summary}.${detailPath}`;
  });
}

// Steps, item 6 (current-state docs): D-292, D-293.
function renderDocsReviewWorkflow(options = {}) {
  const rootRelativePath = options.rootRelativePath ?? '.';
  const projectYamlPath = joinRootRelative(rootRelativePath, 'project.yaml');
  const contextPath = joinRootRelative(rootRelativePath, 'context.md');
  const architecturePath = joinRootRelative(rootRelativePath, 'architecture/');
  const decisionsPath = joinRootRelative(rootRelativePath, 'decisions/');
  const sessionsPath = joinRootRelative(rootRelativePath, 'sessions/');
  const outputPath = joinRootRelative(rootRelativePath, 'state/docs-review-output.md');
  const applyCommand = `vibecompass docs-review --root ${rootRelativePath} --apply-output --output ${outputPath}`;
  const npxApplyCommand = `npx -y @vibecompass/vibecompass@${PACKAGE_VERSION} docs-review --root ${rootRelativePath} --apply-output --output ${outputPath}`;

  return `# VibeCompass Workflow — docs review

Generated by VibeCompass. This file is a package-owned workflow guide and may be refreshed by \`vibecompass refresh-workflow --apply\`.

## Prompt trigger

When the user says \`docs review\`, run this workflow inside the current Claude Code, Codex, Cursor, or Copilot session. The npm package owns state markers and apply mechanics; the AI session owns repository inspection and writing accepted docs-review output.

## Goal

Turn starter project memory into evidence-backed architecture docs under \`architecture/<domain>/<feature>/<component>.md\`, a projected coverage plan, a journey-aware project map, and optional accepted decision recommendations.

The first pass is breadth-first: establish an honest project denominator, compact baseline docs, and explicit deferred or missing areas before spending tokens on deep dives. Focused deepening happens after that baseline, either because the user chooses a feature/system or because an implementation session needs better docs for a specific area.

## Steps

1. Read \`${projectYamlPath}\`, \`${contextPath}\`, existing \`${architecturePath}\`, \`${decisionsPath}\`, and finalized \`${sessionsPath}\` notes.
2. Inspect the declared source repos in stages:
   - inventory paths, manifests, configs, route/job/test directories, and existing architecture frontmatter first
   - identify project topology before choosing taxonomy: single-repo/monolith, multi-repo, multi-surface, package/CLI, workers/services, mobile app, or mixed
   - build a subsystem-level completeness inventory of apps/repos, routes/screens, APIs, tables/storage, jobs/cron/tasks, auth/session flows, external integrations, runtime surfaces, and product features
   - distinguish product features from participating surfaces such as web, mobile, backend/API, data, jobs, integrations, and deployment/runtime
   - produce a coverage plan before reading broad source bodies
   - classify each planned area as \`baseline\` breadth or \`deepening\` follow-up scope
   - read targeted source files only when the coverage plan needs evidence
3. Run \`vibecompass docs-review --guided --llm <tool-name> --model <model-name>\` to record the review marker and print the canonical docs-review contract. Use the current AI tool name and model when known.
4. Present the evidence inventory, completeness inventory with accepted/deferred/missing accounting, topology, chosen taxonomy axis, prior-doc reuse/update/split/merge/defer/replace classifications, coverage plan, backbone outputs (core feature inventory, user journey map, project systems map, coverage/quality summary), proposed architecture docs, blindspots, token-budget risks, quality report, and any decision candidates before generating accepted output. At this gate, ask whether to apply the compact baseline now, adjust the plan, or spend a follow-up pass deepening specific high-risk areas. If you stop here for user approval, state clearly that no architecture docs have been applied yet and do not label proposed areas as accepted.
5. Draft only output the user accepts. After approval, the accepted plan must be fenced as \`vibecompass-coverage-plan version=1\` and should preserve each area's \`run_scope\` as \`baseline\` or \`deepening\`. Accepted architecture docs must be fenced as \`vibecompass-architecture-doc path=architecture/domain/feature/component.md\` blocks and must include required frontmatter: \`domain\`, \`feature\`, \`component\`, and \`status\`. Feature docs may include compact prose-only surface matrices; surface/platform ownership docs stay under the existing \`architecture/platform/<surface>/<component>.md\` shape rather than a new top-level systems tree. The accepted \`architecture/overview/project-shape.md\` doc should include compact backbone sections and exactly one \`vibecompass-project-map version=1\` JSON block with journey-facing features, entry points, evidence-backed relationships, and minimal optional derived \`systems[]\` metadata. Accepted local decisions may be fenced as \`vibecompass-decision-recommendation target=decisions/domain.md\` blocks without D-numbers.
6. Keep each generated architecture doc focused and retrieval-oriented. Soft budget: under 12000 bytes per doc unless the extra detail is necessary and called out in review metadata or retrieval guidance. Write every doc as a current-state contract: updates rewrite the affected sections in place or create a new focused doc — never append dated session/audit sections. Keep the durable plan and rollout state in the doc; work/ship chronology belongs in session notes, and decision entries record accepted choices.
7. Write the accepted fenced blocks verbatim to \`${outputPath}\`.
8. Run \`${applyCommand}\` to validate and apply the accepted blocks. If \`vibecompass\` is not installed on PATH, run \`${npxApplyCommand}\` instead. Only report docs-review as applied after this command succeeds. If accepted docs were written manually outside the output file, run \`vibecompass docs-review --root ${rootRelativePath} --complete\` after confirming the marker should be completed.
9. Run \`vibecompass status\` to confirm the docs-review marker is complete and not drifted. Report the applied architecture paths, coverage projection, baseline/deepening split, decision recommendations, parser warnings such as oversized docs or missing review metadata, and any blindspots or deepening candidates documented in the accepted docs-review output.

## Rebuild option

If the user explicitly wants to rerun docs-review for a focused architecture-doc scope, preview the scope first with \`vibecompass docs-review --rebuild --path architecture/<scope>\`. Only apply cleanup after the user accepts the preview; use \`vibecompass docs-review --rebuild --apply --stale-policy archive --path architecture/<scope>\` when the user explicitly wants selected stale docs archived before the next review. Rebuild archives selected \`architecture/**/*.md\` docs under \`state/docs-review-archive/\`; it does not mutate decisions, sessions, project.yaml, workflow files, agent instruction files, \`architecture/README.md\`, or \`architecture/overview/project-shape.md\`. Rebuild is not permission to cold-regenerate taxonomy: the next docs-review coverage plan must anchor to the prior tree and explain reuse/update/split/merge/defer/replace actions before prose generation.

## Rules

- Do not duplicate the full canonical review prompt in this file. The package command prints that contract from its current implementation.
- Follow the canonical review prompt for evidence, blindspot, and decision-recommendation constraints.
- Treat the package-owned prompt as the source of truth. Tool-specific skills may wrap this workflow, but should not define a divergent docs-review protocol.
- Do not edit generated agent files directly. Update VibeCompass project memory or rerun package commands instead.
`;
}

// The generic role (D-392) and plan format (D-393). Project-specific practice
// (who the owner is, which tools build and review, owner-only steps) belongs
// in the project's own docs, never here.
// The decisions behind each section's rules:
// - Prompt trigger: the role D-392.
// - Build prompts: quoting --plan-task D-395.
// - The review rule: who counts as a reviewer D-398; the record lines D-394.
// - Checking a close report: the note's Plan tasks D-395; the note's Review
//   D-394, D-398.
// - Plan format: D-393; naming a task outside its plan D-395.
// - Operating rules: reviewed recommendations D-398.
function renderProjectManagerWorkflow(options = {}) {
  const rootRelativePath = options.rootRelativePath ?? '.';
  const contextPath = joinRootRelative(rootRelativePath, 'context.md');
  const projectYamlPath = joinRootRelative(rootRelativePath, 'project.yaml');
  const architecturePath = joinRootRelative(rootRelativePath, 'architecture/');
  // Every command names the root, `--root .` included: outside a lane
  // worktree an omitted --root means .compass, not this root.
  const rootFlag = ` --root ${rootRelativePath || '.'}`;

  return `# VibeCompass Workflow — project manager

Generated by VibeCompass. This file is a package-owned workflow guide and may be refreshed by \`vibecompass refresh-workflow --apply\`.

## Prompt trigger

When the user says \`join as project manager <plan-path>\`, take the project manager role for that plan. The trigger opens no lane and selects none. Read \`${contextPath}\` › Session startup steps 1–3 (\`project.yaml\`, the latest finalized session note, and the lane inventory), then this file, then the plan. A plan path is relative to the project-memory root, such as \`architecture/<domain>/<feature>/<plan>.md\`. With no plan named, ask which plan to run, or offer to write one (Starting without a plan).

## The role

One person and three session roles:
- **Owner:** the person who brings the idea, makes the decisions, and does the steps only a person can, such as releases, credentials, and spending. The owner is not a session role.
- **Project manager:** plans tasks, writes each build lane's prompt, checks each close report against primary sources, decides when the plan moves to the next task, and escalates to the owner with options and a recommendation. It doesn't write product code and doesn't stand in for the reviewer.
- **Builder** (\`start session\`) does the work in a lane, and **reviewer** (\`join as reviewer\`, \`review handoff\`) evaluates it. Their contracts are in \`${contextPath}\`.

The project manager works in a standing conversation, not a lane: status reports, prompts, and report checks need no lane.

## Inputs and outputs

Inputs: the owner's idea, goals, and decisions; project memory (\`context.md\`, the plan, architecture docs, decisions, finalized notes); the lane inventory (\`vibecompass list-sessions${rootFlag}\`) and other lanes' \`wip.md\`, \`handoff.md\`, and \`brief.md\`, read only; and builders' close reports with the primary sources that confirm them: git heads and tags, pull requests, package registries, and the live product.

Outputs:
- **The plan** (Plan format) and **build prompts** (Build prompts).
- **Status reports:** done, next, blocked, and the owner's actions, each checked against a primary source rather than relayed.
- **The session map** and **the owner actions** (Plan format).
- **Move-on calls and escalations.** An escalation states the options and recommends one.

## Writing project memory: lanes of its own

The project manager changes canonical memory (plans, architecture docs, decisions) only inside short lanes of its own:
1. Open one with \`vibecompass start-session${rootFlag} --id <lane-id> --working-on "..." --role project-manager\`. The lane records \`role: project-manager\` in its \`session.yaml\`.
2. Work it with the builder's lane mechanics: keep \`wip.md\` and \`handoff.md\` current, and append each decision before acting on it.
3. Close it with \`close session\` in the same sitting.

A lane keeps the role it was opened with. If a sitting ends before the close, \`continue session <lane-id>\` resumes the lane as project manager, with this role's write limits; \`start session\` never resumes a project-manager lane.

The project manager never edits another lane's scratch files and never writes into a closed lane; feedback for a closed lane goes to the owner or into the next prompt. It never hand-edits package output: \`context.md\`, \`workflows/\`, the generated READMEs, \`state/\`, and the agent files' managed blocks.

## Build prompts

The project manager writes each build lane's prompt, and the owner gives it to a builder. Every prompt has seven parts:
1. **Start:** \`start session\` and the exact \`vibecompass start-session${rootFlag} --id <lane-id> --working-on "<task IDs>" --plan-task "<plan-path>#<ID>" --architecture-doc <doc>\` line, with one \`--plan-task\` per task and each reference quoted, since \`#\` is a glob character in zsh, plus \`--branch <name> --repo <id> --worktree\` for code in Git repositories (binding is opt-in; lanes work without Git). The command refuses a reference that names no task line in the plan, so a mistyped ID is caught while the prompt is at hand. On a root that opts into briefs, read \`brief.md\` as a starting point.
2. **Parallel-lane rules:** an explicit \`--session <lane-id>\` on lane commands while other lanes are open; stage only the lane's own files; the shared files or lines another open lane owns; timestamps from \`date\`; any files the lane must never open.
3. **Context:** the plan lines, docs, decisions, notes, and code the lane needs, with paths.
4. **Scope:** the task IDs, what is out of scope, and an exit point if the lane runs long.
5. **Quality bar:** tests, checks, browser verification, and the docs to update.
6. **Review and release:** reviewer passes under the review rule, and what may merge, publish, or release, on whose go.
7. **Close-out:** plan ticks (only when merged and verified, otherwise annotated), the finalized note with its review summary, the consistency checks, publication, and what the report back must contain.

## The review rule

A build lane closes only after:
- **At least one recorded reviewer pass,** even when it finds nothing, by a reviewer the owner started and pointed at the lane with \`review handoff <lane-id>\`. An agent the builder launched or directed (a subagent, a second model it prompts, a review tool it runs on its own work) does the builder's own checks, recorded in the lane's \`## Log\`, never as pass lines. A pass writes only the lane's \`wip.md\` › \`## Review log\` and \`handoff.md\` › \`## Reviewer → Builder\`.
- **Findings drive more passes.** After \`address review\`, the reviewer's next pass checks each response. The loop ends at a pass that leaves no finding open: each one fixed and confirmed, rejected with evidence the reviewer accepts, or deferred with a scoped reason.
- **A cap on rounds,** where a round is one reviewer pass and the builder's response. The cap is \`metadata.workflow.review.round_cap\`, 3 by default; \`${contextPath}\` › Workflow defaults gives this project's value. If findings are still open after the last round the cap allows, the builder stops and reports, and the project manager escalates to the owner, who chooses: another round, a scoped deferral whose reason the session note carries, or leaving the lane open. Each pass past the cap needs one more owner \`another round\` line before it. A cap never marks a finding resolved.

Passes, responses, and owner choices are record lines in \`wip.md\` › \`## Review log\` (${contextPath} › Review log format). \`close-session\` checks the record before it writes and puts the outcome in the finalized note's \`## Review\` section: the \`Check:\` line, the passes and their reviewers, one line per finding, and each owner line. Each deferred finding and its reason join the note's next steps. \`vibecompass review-check${rootFlag} --session <lane-id>\` runs the same check on an open lane. Work the owner accepts without an independent pass closes with \`--review-override "<the owner's reason>"\`, which the note's \`Check:\` line shows; it is not a pass.

## Checking a close report

Check each claim against its primary source before accepting it: \`vibecompass list-sessions${rootFlag}\` (the lane closed), the finalized note and its review summary, git heads and tags, the pull request, the registry version and checksum, and the live page. For a lane still open, read its latest \`wip.md\` log lines too, since a handoff can lag the work. A claim that doesn't hold goes back to the lane while it is open, or to the owner once it has closed.

The note's \`## Plan tasks\` section lists the tasks the lane linked with \`--plan-task\`; compare it with the prompt and the session map row. Close ticks nothing, so check that each linked task is ticked only once its work is merged and verified, and annotated otherwise.

Read the note's \`## Review\` section against the review rule. Its \`Check:\` line says whether the record passed, failed, or was overridden, and why. Compare each reviewer on its \`Passes:\` line with the reviewer the build prompt named and any reviewer the owner has named to you since. A pass by the builder's own tool and model, or by a reviewer nobody named, counts when the prompt or the owner's word says the owner started that reviewer. It goes to the owner when nothing does, or when the record shows the builder launched or directed the run, whatever the pass line names. The builder's own account doesn't establish who started a reviewer.

## When to move on

Move the plan to the next task when:
- the close report checks out against primary sources;
- the review rule is met, as the note's review summary shows;
- the plan's ticks match the evidence, with anything not merged or verified annotated rather than ticked;
- the owner's steps for the task are done, or listed with what waits on them.

Otherwise write a follow-up prompt for the same task, or escalate to the owner.

## Plan format

- **Where plans live.** A plan is an architecture doc under \`${architecturePath}\`, beside the feature it plans. Nothing else marks it: a doc is a plan when its \`## Next steps\` holds task lines. A finished plan moves to \`archive/\` once its open items live in another doc.
- **Task lines.** A task is a top-level item under \`## Next steps\`: \`- [ ] <ID> — <scope>\`, ticked \`- [x] <ID> — <scope>\` once done. \`<ID>\` matches \`[A-Z]{1,6}[0-9]{1,3}\`: capital letters for the track, then a number, such as \`PM3\` or \`DOC2\`, with no dot, hyphen, space, or lowercase letter. An ID is unique within its plan and never reused there, even after its task is removed. Bold group labels may separate tracks; subtasks are nested bullets or checkboxes without IDs. The scope says whether the task is reviewed. A ticked task keeps one dated done line naming its lane or note.
- **Order, owner decisions, assumption changes, and costs.** The plan's \`## Details\` give the order of the tasks, the decisions each step needs from the owner (a table once decided), every assumption change called out explicitly, and the costs.
- **Session map.** A \`### Session map\` table under the plan's \`## Details\`, with the columns Session, Lane, Tasks, Note, and Outcome and evidence. Add a row only after checking it against primary sources. When the map outgrows the plan, move it to a companion doc named in the plan's Retrieval guidance.
- **Owner actions.** A labeled group in the plan's \`## Next steps\` holding the owner's current actions and the standing steps each release needs, including steps no repository prompts, such as a client configuration that sits outside every repository. An owner step that is planned work gets a task line with an ID; the rest are plain bullets.
- **Naming a task outside its plan:** \`<plan-path>#<ID>\`, with the plan's memory-root-relative path, such as \`architecture/<domain>/<feature>/<plan>.md#PM3\`. Commands and stored records always use this form, as \`start-session --plan-task\` does. Prose may shorten it to the file name and the ID while that file name is unique under \`architecture/\`. Inside its own plan a task is cited bare. There is no root-wide ID registry.
- **Moving a task** to another plan keeps its ID unless the destination already uses it, and its line names the origin: \`(moved from <old-plan-path>#<ID>)\`.
- **IDs already written bare** elsewhere are never rewritten. In its own plan, a bare ID is that plan's task. Elsewhere, look outward from the occurrence and stop at the first step that names any plan: a plan named in the same sentence or list item; then the plans the note or decision names; then, for a note, the plan whose session map lists it, and for a decision, the plans named by the note that lists it under \`## Decisions made\`. If exactly one plan at that step has a task line for the ID, the ID is that task. If none or several do, it is ambiguous, and the reader says so instead of guessing; a later step never overrides or repairs an earlier one. An ID presented as a review finding is a finding, not a task. No command resolves a bare ID.

## Starting without a plan

When the project has no plan yet, no architecture doc whose \`## Next steps\` holds task lines, writing one is the first job:
- **Offer a short project manager lane that writes the plan** in the plan format, gathering the tasks from the project's existing scope docs. A plan is a consequential recommendation, so it follows the review rule before the owner adopts it.
- **A doc that holds tasks only in prose isn't a plan.** The new plan links to it rather than copying it.
- **Until the plan exists,** prompts name tasks in words, or with IDs marked "proposed", such as \`DOC1 (proposed)\`. The plan then keeps those exact IDs and lists those sessions in its session map, so the notes that cited them can be read later: a note that names no plan reaches the plan through the session-map step of the bare-ID lookup (Plan format).
- **Lanes already open when the role starts** are listed in the session map once the plan exists. They aren't reopened.

## Operating rules

- **Change canonical memory only in short lanes of your own** (Writing project memory, above).
- **In Git, stage only your own files,** or your own hunks in a shared doc such as the plan. Never \`git add -A\`, stash, or \`--autostash\` while other lanes are open; if the remote moved, merge rather than rebase.
- **Check before editing or reporting.** Two project-manager sessions can run at once. Before an edit, a status report, or a question to the owner, run \`vibecompass list-sessions${rootFlag}\` and \`git status\`, and read the notes finalized since your last look and open lanes' latest scratch files. Build lanes report only their own status.
- **Check interpretive claims against the code,** not only a doc's tables or summary, in close reports and in your own docs.
- **Send consequential recommendations through a reviewed lane** before the owner decides (a plan, a reorder, a protocol change): one that meets the review rule, with passes by reviewers the owner started. Flag every assumption change explicitly.
- **Take timestamps from \`date\`.**

## Publication

Beyond the Git publish step that \`${projectYamlPath}\` › \`metadata.workflow.close_session\` configures, close-out publication depends on the project's mode:
- **local-only:** no hosted push, unless the project is later connected with \`vibecompass connect-hosted${rootFlag}\`.
- **local-primary with a hosted binding:** once canonical files are final, \`vibecompass push${rootFlag}\` refreshes the hosted dashboard. Push reads files from disk, not commits, so check \`git status\` first: another lane's uncommitted edits would go too. Without a binding there is nothing to push.
- **hosted-only:** no authoritative local push. Confirm the hosted state was updated, or record it as deferred.

Which lanes may publish without asking is the owner's call, recorded in the project's working agreements.

## Rules

- This file is the generic role. A project may keep its own role doc under \`architecture/\` with its specifics, such as who the owner is, which tools build and review, and the steps only the owner takes; read it as well.
- Do not edit generated files directly. Update project memory or rerun package commands instead.
`;
}

function slugifyPromptTrigger(trigger) {
  return trigger.trim().replace(/\s+/g, '-');
}

function joinRootRelative(rootRelativePath, relativePath) {
  if (!rootRelativePath || rootRelativePath === '.') {
    return relativePath;
  }

  return `${rootRelativePath.replace(/\/$/, '')}/${relativePath}`;
}
