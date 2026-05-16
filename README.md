<p align="center">
  <a href="https://vibecompass.dev">
    <img src="https://raw.githubusercontent.com/jack-whimvy/vibecompass/main/brand/logo-a4.png" alt="VibeCompass" height="96" />
  </a>
</p>

# @vibecompass/vibecompass

Local-first project-memory core for [VibeCompass](https://vibecompass.dev).

This package owns the canonical local file contract for VibeCompass project
memory: `project.yaml`, `architecture/`, `decisions/`, `sessions/`, and the
derived `state/manifest.json` that lets tools read the local root efficiently.

## Current scope

Shipped today:

- `vibecompass init` for scaffolding a project-memory root
- interactive guided init for placement, workflow bootstrap, and first-session setup
- lightweight starter architecture/session memory plus example-only decision guidance
- generated `context.md` plus opt-in workflow guide files
- opt-in starter `CLAUDE.md` / `AGENTS.md` templates that are created once and never overwritten
- `vibecompass start-session` / `vibecompass close-session` for lane-aware local builder workflow
- `vibecompass list-sessions` / `vibecompass switch-session` for multiple active session lanes
- `vibecompass end-session` as a discoverable alias for `close-session`
- `vibecompass sync-agents` for generated `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, and `.github/copilot-instructions.md` views
- `vibecompass status` for a read-only project-memory health and drift report
- `vibecompass refresh-workflow` for explicit dry-run/apply refresh of package-owned derived workflow files
- `vibecompass docs-review --guided` — print a comprehensive review prompt for your chosen LLM to run
- `vibecompass docs-review --submit-hosted` — submit the review request to the hosted app and poll for proposal/artifact output
- `vibecompass docs-review --run-local --provider anthropic` — local provider adapter that saves review output locally
- `vibecompass docs-review --apply-output` — apply accepted architecture-doc blocks into canonical `architecture/` docs
- `vibecompass docs-review --complete` — mark the review accepted after the docs land
- hosted sync commands: `push`, `pull-preview`, `pull-export`, and `apply-export`
- canonical file scanning and validation
- `state/manifest.json` generation
- JavaScript read-model helpers for project, feature, decision, and file context

Not shipped yet:

- one-command hosted docs-review that directly writes canonical local docs
- additional local docs-review providers beyond Anthropic
- automatic acceptance of review findings without a local apply step

The package is useful today as the local project-memory CLI and JavaScript
core. Use it to create a root, keep project memory current, run local sessions,
and sync with hosted VibeCompass when you have a hosted project binding.

## Requirements

- Node.js 20+

## Install

### CLI

```bash
npx -y @vibecompass/vibecompass --help
```

The npm package is scoped under the VibeCompass org, but the installed CLI
command is intentionally unscoped: `vibecompass`.

### Library

```bash
npm install @vibecompass/vibecompass
```

## Quickstart

Most users should start with the guided bootstrap:

```bash
npx -y @vibecompass/vibecompass init --guided
```

Guided init asks about repo topology, recommends a placement pattern
(`workspace-root`, `dedicated-memory-repo`, or `primary-repo`), writes
lightweight starter project memory, scaffolds the workflow files you opt into,
and can open the first builder session immediately.

After init, the usual loop is:

```bash
npx -y @vibecompass/vibecompass status --root .compass
npx -y @vibecompass/vibecompass start-session --root .compass --id feature-lane --working-on "Build the next feature"
npx -y @vibecompass/vibecompass docs-review --root .compass --guided
npx -y @vibecompass/vibecompass close-session --root .compass --session feature-lane --title "Feature Lane" --completed "Shipped the slice" --next-step "Review and publish"
```

Run `vibecompass status` when you are not sure what to do next. It is
read-only and prints the safest follow-up commands for the current root.

When the owner directory is a workspace root or primary repo, the canonical
root defaults to `.compass/` inside that directory. For a dedicated memory repo,
the canonical root defaults to the repo root itself.

Skip the prompts and drive the setup explicitly:

```bash
npx -y @vibecompass/vibecompass init \
  --placement primary-repo \
  --tooling-root . \
  --name "Acme Platform" \
  --mode local-only \
  --repo app=https://github.com/acme/app.git \
  --with-workflow \
  --with-claude \
  --with-agents \
  --close-session-git-publish \
  --close-session-git-remote origin \
  --start-session \
  --session-id mcp-dogfood \
  --session-working-on "Validate the local-first MCP workflow"
```

That creates the canonical root plus lightweight starter memory:

```text
PROJECT_MEMORY_ROOT/project.yaml
PROJECT_MEMORY_ROOT/architecture/overview/project-shape.md
PROJECT_MEMORY_ROOT/decisions/EXAMPLE.md      # example-only, ignored by canonical parsing
PROJECT_MEMORY_ROOT/sessions/YYYY-MM-DD-1-project-memory-initialized.md
PROJECT_MEMORY_ROOT/state/manifest.json
```

The starter architecture doc is intentionally marked as initial scaffold
coverage. It is useful orientation, not a comprehensive review. Before risky
implementation work, inspect the relevant code and replace or expand the
starter docs with evidence-backed domain/feature/component docs.

When workflow scaffolding is enabled, init also creates:

```text
PROJECT_MEMORY_ROOT/context.md
PROJECT_MEMORY_ROOT/architecture/README.md
PROJECT_MEMORY_ROOT/decisions/README.md
PROJECT_MEMORY_ROOT/sessions/README.md
CLAUDE.md           # at the tooling root, only if missing and --with-claude is used
AGENTS.md           # at the tooling root, only if missing and --with-agents is used
```

`context.md` is a derived package-owned file. Re-running `init --force --with-workflow`
regenerates it; do not treat it as a hand-edited source document.

Check an initialized root without writing files:

```bash
npx -y @vibecompass/vibecompass status --root .compass
```

Use `status --json` when another tool needs the typed diagnostic model. The
JSON output intentionally excludes raw hosted preview tokens and resolved
credential values.

Preview package-owned workflow refreshes without mutating files:

```bash
npx -y @vibecompass/vibecompass refresh-workflow --root .compass --dry-run
```

Apply the refresh explicitly when the plan looks right:

```bash
npx -y @vibecompass/vibecompass refresh-workflow --root .compass --apply
```

`refresh-workflow` updates generated workflow artifacts such as `context.md`,
workflow guide READMEs, managed agent-file blocks, and the local
`state/manifest.json`. Existing package-version stamps are sticky by default;
pass `--update-package-stamp` when you intentionally want to move the
canonical `project.yaml.metadata.package_version` stamp to the current CLI.

## After init: generate real architecture docs

`init` writes a small starter map of your project. To turn it into real
architecture docs, run a docs-review and let your AI tool write them:

```bash
npx -y @vibecompass/vibecompass docs-review --guided
```

You can run this right after `init`, or any time later — for example after
scope expands, or before risky implementation work. `start-session` will
remind you with a non-blocking warning if no completed review exists.

What happens:

1. The CLI asks which LLM you'll use, then prints a versioned prompt template with fixed review criteria.
2. You paste that prompt into your AI tool (Claude Code, Codex, Cursor, etc.).
3. The AI reads your repo and writes architecture docs under
   `architecture/<domain>/<feature>/<component>.md`.
4. Run `vibecompass docs-review --apply-output` after accepting fenced
   architecture-doc blocks, or `--complete` if accepted docs were written
   manually.

The guided prompt is deterministic apart from project-specific fields
(`project`, `mode`, `root`, provider, and model). It uses the same structure
VibeCompass dogfoods: read project memory first, inspect source evidence,
write component docs with review metadata, preserve the starter overview, and
emit accepted docs as `vibecompass-architecture-doc` blocks.

Plain `--guided` never calls an AI itself. You stay in control of which
provider runs the review and what gets saved. Use `--run-local --provider
anthropic` when you want the package to execute the same review through your
local Anthropic key.

### Other ways to run a review

- `--submit-hosted` sends the review request to the hosted app and records a
  run ID. Hosted execution creates proposals and docs-review artifacts; for
  local-primary projects, canonical local files change only after
  pull-preview/export/apply and a confirming push.
- `--run-local --provider anthropic` calls Anthropic directly with your
  `ANTHROPIC_API_KEY` and saves the raw output to
  `state/docs-review-output.md`.
- `--apply-output` writes accepted fenced architecture-doc blocks from
  `state/docs-review-output.md` into canonical `architecture/` docs and
  completes the local review marker.

For most users, stick with `--guided`.

If you do not chain straight into a first session from `init`, open one later:

```bash
npx -y @vibecompass/vibecompass start-session \
  --id mcp-dogfood \
  --working-on "Validate the MCP dogfood workflow against the docs repo"
```

Close the active builder session:

```bash
npx -y @vibecompass/vibecompass close-session \
  --session mcp-dogfood \
  --title "Workflow Parity Commands" \
  --completed "Added package-owned start-session and close-session commands" \
  --next-step "Run the package publish dry-run"
```

`end-session` is accepted as an alias for the same lifecycle step and flags:
`npx -y @vibecompass/vibecompass end-session ...`.

The package CLI owns filesystem lifecycle only. The default scaffolded
workflow also uses prompt commands inside your coding tool:

```text
start session      # builder role trigger
join as reviewer   # reviewer role trigger
review handoff     # reviewer reads selected-lane wip.md, handoff.md, and diffs
address review     # builder reads selected-lane feedback, responds inline, and continues
```

Those prompt commands are documented in the generated `context.md`,
`CLAUDE.md`, and `AGENTS.md` templates. They are not additional
`vibecompass` CLI subcommands.
Reviewer handback is explicit in the package-managed workflow: the reviewer
ends the pass by updating the selected lane's `wip.md` + `handoff.md`, and
the builder closes the session with `vibecompass close-session --session
<lane-id>` using the defaults stored in
`project.yaml.metadata.workflow.close_session`.

Active builder sessions are named lanes under
`sessions/active/<lane-id>/`. Use one lane per active feature or workstream.
`start-session` requires `--id <lane-id>` for every lane, including the first
one in a project.
Finalized sessions are append-only notes named
`sessions/YYYY-MM-DD-N-title.md`, so multiple sessions on the same day
increment `N`. Decisions remain append-only in `decisions/`; a session note
can reference a decision, but the decision file is the durable source of truth.

For higher-risk work, use planning mode as a prompt-level step inside the
active session. Planning mode should read the same context, propose scope and
tradeoffs, and record the agreed plan in the selected lane's `wip.md`; it
should not create a separate lifecycle artifact or finalize decisions until
you approve implementation.

Generate agent-instruction files from project memory:

```bash
npx -y @vibecompass/vibecompass sync-agents --root .compass
```

`sync-agents` writes only VibeCompass managed regions:

```md
<!-- vibecompass:start - managed by VibeCompass, do not edit -->
... generated content ...
<!-- vibecompass:end -->
```

Content outside those markers is preserved. Existing files without markers are
reported as warnings and left untouched unless you explicitly adopt them:

```bash
npx -y @vibecompass/vibecompass sync-agents --root .compass --adopt-existing
```

Adoption appends a managed VibeCompass block to the end of existing unmarked
agent files, preserves everything outside the markers, and reports possible
workflow-overlap lines before you rely on the result. Guided init may offer the
same adoption step for existing files, but the prompt defaults to no.

Connect hosted VibeCompass later when you want browser views, team sync, or hosted docs-review:

```bash
npx -y @vibecompass/vibecompass connect-hosted \
  --sync-api-url https://vibecompass.dev \
  --sync-project-id vc_proj_example \
  --sync-credential-env-var VIBECOMPASS_SYNC_TOKEN
```

Then set the secret locally and push the first baseline:

```bash
export VIBECOMPASS_SYNC_TOKEN='your-sync-token'
npx -y @vibecompass/vibecompass push
```

Create a `local-primary` root non-interactively when you also want the hosted sync binding written into `project.yaml` during init:

```bash
npx -y @vibecompass/vibecompass init \
  --placement primary-repo \
  --tooling-root . \
  --name "Acme Platform" \
  --mode local-primary \
  --repo app=https://github.com/acme/app.git \
  --sync-api-url https://vibecompass.dev \
  --sync-project-id vc_proj_example \
  --sync-credential-env-var VIBECOMPASS_SYNC_TOKEN
```

That creates:

```text
.compass/
  project.yaml
  architecture/
  decisions/
  sessions/
  state/
    manifest.json
```

The sync fields in `project.yaml` are non-secret. The token value stays in
your environment and is never written to canonical project memory.

## CLI

### `vibecompass init`

```text
vibecompass init --name <project-name> --mode <local-only|local-primary|hosted-only> --repo <id=remote> [options]
```

Options:

- `--root <path>`: project-memory root; defaults to `.compass`
- `--tooling-root <path>`: owner directory for workflow files and placement defaults
- `--slug <slug>`: optional project slug
- `--description <text>`: optional short project description
- `--placement <workspace-root|dedicated-memory-repo|primary-repo>`: optional explicit placement pattern
- `--guided`: ask placement and setup questions interactively
- `--repo <id=remote>`: repeatable repo descriptor
- `--repo-branch <id=branch>`: optional per-repo default branch
- `--sync-api-url <url>`: hosted sync API URL for `local-primary` or `hosted-only`
- `--sync-project-id <id>`: hosted sync project ID for `local-primary` or `hosted-only`
- `--sync-credential-env-var <name>`: local env-var reference for `local-primary` or `hosted-only`
- `--with-workflow`: generate `context.md` plus workflow guide files
- `--with-claude`: create a starter `CLAUDE.md` if it does not already exist
- `--with-agents`: create a starter `AGENTS.md` if it does not already exist
- `--adopt-existing-agent-files`: append managed blocks to existing unmarked agent files
- `--start-session`: open the first builder session after init
- `--session-working-on <text>`: required with `--start-session` outside guided mode
- `--session-id <lane-id>`: required with `--start-session`; names the first builder lane
- `--close-session-git-publish`: store that the close-session workflow includes a Git publish step
- `--close-session-git-remote <name>`: optional default Git remote name for that stored publish step
- `--force`: overwrite an existing `project.yaml`
- `--replace-active-lanes`: allow `--force` to replace a root that has active session lanes

When `--start-session` is used, `init` automatically enables the minimum
workflow bootstrap required for that session: `context.md` plus `CLAUDE.md`.
Guided init can also record workflow defaults in
`project.yaml.metadata.workflow`, including whether close-session should
include a Git publish step and which remote name to use for that step.

Guided init is inference-first for common repo layouts: it reads `package.json`,
detects the current Git `origin` when you run it inside a repo, or scans a
parent workspace for immediate child repos when the parent is not itself a Git
checkout. It asks once before using detected repos, maps a friendly setup goal
to the stored project mode, places single-child repo memory under that child
repo, and uses workspace-root placement for multi-repo parent folders. Hosted
credentials are deferred by default; run `vibecompass connect-hosted` when you
are ready to connect the local root to `vibecompass.dev`.

### `vibecompass connect-hosted`

```text
vibecompass connect-hosted [options]
```

Options:

- `--root <path>`: project-memory root; defaults to `.compass`
- `--sync-api-url <url>`: hosted sync API URL
- `--sync-project-id <id>`: hosted sync project ID
- `--sync-credential-env-var <name>`: local env-var reference

Without all three sync flags, `connect-hosted` prompts for the missing fields.
It updates only the non-secret `project.yaml.sync` binding; you still set the
actual token in your environment before running hosted commands.
Running it again replaces the existing hosted binding in `project.yaml`, which
is the intended rotation path after you create a new sync credential.

### `vibecompass status`

```text
vibecompass status [options]
```

Options:

- `--root <path>`: project-memory root; defaults to `.compass`
- `--tooling-root <path>`: directory where agent files are inspected; defaults to cwd
- `--json`: print the typed status model as JSON

`status` is strictly read-only. It reports project identity, active session
lanes, package-version drift, local manifest compatibility, docs-review
marker state, generated agent-file drift, warnings, and recommended next
commands. It does not write canonical files, generated workflow files, agent
instruction files, or `state/manifest.json`.

### `vibecompass refresh-workflow`

```text
vibecompass refresh-workflow [--dry-run|--apply] [options]
```

Options:

- `--root <path>`: project-memory root; defaults to `.compass`
- `--tooling-root <path>`: directory where agent files are refreshed; defaults to cwd
- `--dry-run`: show planned refresh without changing files; this is the default
- `--apply`: apply the planned workflow refresh
- `--update-package-stamp`: update an existing `project.yaml` package-version stamp
- `--allow-downgrade-templates`: allow applying templates with a CLI older than the root stamp

`refresh-workflow` is the explicit upgrade path for package-owned derived
artifacts. Dry-run mode is read-only. Apply mode can regenerate `context.md`,
workflow guide READMEs that still match the package-generated shape, managed
agent-file blocks, and `state/manifest.json`. It leaves user-authored workflow
guide files untouched when they no longer match the generated guide shape.

Package-version stamps are intentionally conservative: missing legacy stamps
can be created by apply mode, existing older or invalid stamps are left
untouched unless `--update-package-stamp` is passed, and roots stamped by a
newer CLI require `--allow-downgrade-templates` before older templates are
applied.

### `vibecompass start-session`

```text
vibecompass start-session --id <lane-id> --working-on <text> [options]
```

Options:

- `--root <path>`: project-memory root; defaults to `.compass`
- `--tooling-root <path>`: workspace root that contains `CLAUDE.md`; defaults to cwd
- `--working-on <text>`: required active-session summary
- `--id <lane-id>`: required lane ID
- `--feature <slug>`: repeatable feature slug for the lane
- `--repo <id>`: repeatable repo ID for the lane
- `--claim <path>`: repeatable path claim for overlap warnings
- `--date <YYYY-MM-DD>`: optional explicit session date
- `--last-thing-completed <text>`: optional override for the `CLAUDE.md` current-session block
- `--blockers <text>`: optional current blockers summary
- `--next-session-should <text>`: optional current-session handoff summary

This command updates the `Current session` block in `CLAUDE.md` and creates
`sessions/active/<lane-id>/session.yaml`, `wip.md`, and `handoff.md` for the
next session number. It also updates `sessions/active/index.yaml`.

If no completed docs-review marker exists under `state/docs-review.json`,
`start-session` prints a non-blocking warning that starter docs are not a
comprehensive architecture review.

### `vibecompass list-sessions`

```text
vibecompass list-sessions [options]
```

Lists active session lanes and marks the current lane.

Options:

- `--root <path>`: project-memory root; defaults to `.compass`

### `vibecompass switch-session`

```text
vibecompass switch-session <lane-id> [options]
```

Changes the current lane in `sessions/active/index.yaml`.

Options:

- `--root <path>`: project-memory root; defaults to `.compass`
- `--session <lane-id>`: lane ID; positional ID is also accepted

### `vibecompass close-session`

```text
vibecompass close-session --title <text> --completed <text> --next-step <text> [options]
```

`vibecompass end-session` accepts the same options and runs the same close
path. `close-session` remains the canonical command name in generated workflow
metadata and docs.

Options:

- `--root <path>`: project-memory root; defaults to `.compass`
- `--tooling-root <path>`: workspace root that contains `CLAUDE.md`; defaults to cwd
- `--title <text>`: required finalized session-note title
- `--worked-on <text>`: optional override for the "What we worked on" section
- `--session <lane-id>`: active lane to close; required when multiple lanes are active
- `--completed <text>`: repeatable completed item
- `--decision <text>`: repeatable decision reference or summary
- `--model <text>`: optional repeatable model contribution entry
- `--blocker <text>`: repeatable blocker or open question
- `--next-step <text>`: repeatable next-session instruction
- `--last-thing-completed <text>`: optional override for the `CLAUDE.md` completed summary
- `--next-session-should <text>`: optional override for the `CLAUDE.md` next-session summary

This command finalizes the active scratchpad into
`sessions/YYYY-MM-DD-N-display-title.md`, deletes the closed lane directory
under `sessions/active/<lane-id>/`, updates `sessions/active/index.yaml`, and
updates the `Current session` block in `CLAUDE.md`. If no `--model` flags are
provided, the session note records `Not recorded.` under `Models used`.
This is the final builder lifecycle step after the last `address review`
pass, not a reviewer action. It also prints the workflow guidance derived
from `project.yaml.metadata.workflow.close_session`, including any
configured Git publish step.

### `vibecompass sync-agents`

```text
vibecompass sync-agents [options]
```

Options:

- `--root <path>`: project-memory root; defaults to `.compass`
- `--tooling-root <path>`: directory where agent files are written; defaults to cwd
- `--format <name>`: optional format filter: `claude_md`, `agents_md`, `cursor_rules`, or `copilot_instructions`
- `--adopt-existing`: append managed blocks to existing unmarked files
- `--dry-run`: show planned writes without changing files

This command generates enabled agent-instruction files from canonical project
memory. It creates missing files with managed markers, replaces existing
managed regions, preserves content outside markers, and warns instead of
overwriting existing unmarked files unless `--adopt-existing` is supplied.

### Hosted sync commands

```text
vibecompass push [options]
vibecompass pull-preview [options]
vibecompass pull-export [options]
vibecompass apply-export [options]
```

Common option:

- `--root <path>`: project-memory root; defaults to `.compass`

Hosted sync commands require `project.yaml` mode `local-primary`, a
non-secret `project.yaml.sync` binding, and the token named by
`sync.credential_env_var` in your environment.

`push` sends canonical local project memory to the hosted sync API.

`pull-preview` asks hosted sync for pending proposal state without changing
canonical local files. It records preview metadata in local `state/`. Pass
`--no-pending-proposals` when you only want remote state and conflict data.

`pull-export` exports accepted hosted proposal operations into a local bundle
under `state/pull-export.json` by default. Use `--proposal <id>` to select
proposal IDs, `--preview-token <token>` to export from a specific preview, and
`--output <path>` to choose a different output path under the root.

`apply-export` applies a local export bundle to canonical project-memory files
and records the resulting state. Use `--output <path>` when the export bundle
is not at the default `state/pull-export.json`.

### `vibecompass docs-review`

```text
vibecompass docs-review --guided [options]
```

Options:

- `--root <path>`: project-memory root; defaults to `.compass`
- `--guided`: print a comprehensive review prompt for your chosen LLM to run (recommended)
- `--submit-hosted`: submit the review request to the hosted app
- `--poll-hosted`: poll a hosted docs-review run and update `state/docs-review.json`
- `--run-local`: run the generated review request with a local provider
- `--provider <name>`: local provider for `--run-local`; currently `anthropic`
- `--run-local-anthropic`: compatibility alias for `--run-local --provider anthropic`
- `--apply-output`: apply accepted architecture-doc blocks from review output
- `--apply-decision-artifact`: append an accepted hosted decision artifact locally
- `--artifact <id>`: artifact ID for `--apply-decision-artifact`
- `--refresh-index`: also regenerate `decisions/INDEX.md` after applying a decision artifact
- `--output <path>`: review output path for `--apply-output`; defaults to `state/docs-review-output.md`
- `--complete`: mark accepted docs-review changes as completed in local state
- `--llm <name>`: preferred LLM/provider to record for the review (e.g. `claude`, `codex`, `gemini`)
- `--model <name>`: model name/version to record for the review
- `--anthropic-env-var <name>`: env var for local Anthropic runtime; defaults to `ANTHROPIC_API_KEY`
- `--max-tokens <number>`: local Anthropic output budget, 1024–32000; defaults to 16000

Plain `--guided` does not call an AI itself; it prints a review prompt your
chosen LLM runs. `--submit-hosted`, `--run-local`, and `--apply-output` are
explicit alternative steps.

Project-mode requirements:

- `local-only` — `--guided` can use any external LLM; `--run-local` requires a supported local provider key
- `local-primary` — hosted sync binding preferred for hosted submission; local provider key accepted for `--run-local`
- `hosted-only` — hosted sync binding required

`--run-local --provider anthropic` always uses local Anthropic regardless of
hosted binding, so hosted precedence does not apply when that flag is set.

`--submit-hosted` uses `sync.credential_env_var` and records the hosted run
ID in `state/docs-review.json`. Use `--poll-hosted` to refresh the run marker.
Hosted execution creates review proposals and artifacts; for `local-primary`
roots, local files stay untouched until you pull-preview, export, apply
locally, and push to confirm the accepted output.
Missing or stale hosted baselines fail with package-facing next-step guidance
instead of running model work against the wrong source of truth.

`--run-local-anthropic` remains as a compatibility alias. New scripts should
use `--run-local --provider anthropic`.

`--apply-output` looks for accepted architecture docs in fenced blocks:

````md
```vibecompass-architecture-doc path=architecture/domain/feature/component.md
---
domain: Platform
feature: Example
component: Backend
status: In progress
---

## Description
Accepted review content.
```
````

Only `architecture/*.md` paths are writable through this apply step.

`vibecompass docs-review --complete` updates the marker in
`state/docs-review.json` to `status: "completed"` once the docs have
landed, preserving the recorded `llm` / `model` so future sessions know
what reviewed the architecture.

### Prompt commands

These are the default prompt commands used by the scaffolded workflow files:

- `start session`: builder role trigger
- `join as reviewer`: reviewer role trigger
- `review handoff`: reviewer reads the selected lane's latest `wip.md`, `handoff.md`, latest finalized note, and relevant diffs before appending findings
- `address review`: builder reads the latest reviewer feedback in the selected lane's `wip.md` / `handoff.md`, responds inline, applies accepted changes, and refreshes the builder handoff
- `close session`: builder runs the close-out checklist and ends with `vibecompass close-session --session <lane-id>`; `end session` is accepted as a synonym

They are prompt commands for AI-tool behavior, not package CLI commands.
Reviewer handback ends when the reviewer has updated the selected lane's
`wip.md` and `handoff.md`; there is no extra reviewer-exit step. The builder
remains in builder role, uses `address review` until findings are resolved or
explicitly deferred, and then uses the `close session` prompt to run
`vibecompass close-session --session <lane-id>` using the workflow defaults
recorded in `project.yaml`.

## JavaScript API

```js
import {
  PACKAGE_VERSION,
  STATE_VERSION,
  initializeProjectMemory,
  inspectProjectCompatibility,
  formatCompatibilityWarnings,
  preflightDocsReview,
  startProjectSession,
  listProjectSessions,
  switchProjectSession,
  closeProjectSession,
  syncAgentInstructionFiles,
  getSupportedAgentFormats,
  getProjectStatus,
  renderStatusText,
  toStatusJson,
  refreshWorkflow,
  scanProjectMemory,
  generateStateManifest,
  prepareStateManifest,
  writeStateManifest,
  pushProjectMemory,
  pullPreviewProjectMemory,
  pullExportProjectMemory,
  applyPullExport,
  loadProjectReadModel,
  getProjectContext,
  getFeatureContext,
  getDecisionLog,
  getFileContext,
} from "@vibecompass/vibecompass";
```

Typical flow:

```js
const readModel = await loadProjectReadModel("/absolute/path/to/.compass");
const project = getProjectContext(readModel);
```

## Relationship to `vibecompass-mcp`

`vibecompass` owns the local canonical files and read model.
`vibecompass-mcp` is the MCP transport adapter that exposes that memory to
Claude Code, Codex, Cursor, and similar tools.

Use `vibecompass-mcp` when you want AI tooling integration.
Use `vibecompass` when you want to create, validate, and read the local
project-memory root itself.
