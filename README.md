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
- `vibecompass docs-review --guided` runtime preflight for the explicit comprehensive documentation review workflow
- `vibecompass docs-review --submit-hosted` for explicit hosted docs-review handoff
- `vibecompass docs-review --run-local-anthropic` for local Anthropic review output under `state/`
- `vibecompass docs-review --complete` for marking accepted review work complete locally
- canonical file scanning and validation
- `state/manifest.json` generation
- JavaScript read-model helpers for project, feature, decision, and file context

Not shipped yet:

- hosted sync commands such as push, pull-preview, and pull-export
- hosted docs-review execution workers that produce applied canonical docs automatically

The package is publishable now as the file-contract and read-model core. The
broader local-primary sync workflow is still being built on top of it.

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

Run the guided bootstrap:

```bash
npx -y @vibecompass/vibecompass init --guided
```

Guided init asks about repo topology, recommends a placement pattern
(`workspace-root`, `dedicated-memory-repo`, or `primary-repo`), writes
lightweight starter project memory, scaffolds the workflow files you opt into,
and can open the first builder session immediately.

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

Run the explicit docs-review preflight when you are ready for the heavier
documentation review workflow:

```bash
npx -y @vibecompass/vibecompass docs-review --guided
```

Today this asks which LLM/model will run the architecture review, records that
selection in `state/docs-review.json`, checks whether the selected project mode
has the required runtime available, and prints a review prompt to run in your
preferred LLM. Guided mode suggests Claude, Codex, and Gemini, but custom
provider names are accepted. A real comprehensive review still requires the
selected LLM or hosted scan adapter to apply accepted documentation changes;
init never makes an AI call.

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
reported as warnings and left untouched.

Create a `local-primary` root when you also want the hosted sync binding written into `project.yaml`:

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

Next step after init:

```bash
export VIBECOMPASS_SYNC_TOKEN='your-sync-token'
```

`vibecompass` does not yet perform hosted sync itself. The sync fields in
`project.yaml` are the non-secret binding for the upcoming push/pull flows.

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
- `--sync-api-url <url>`: hosted sync API URL for `local-primary`
- `--sync-project-id <id>`: hosted sync project ID for `local-primary`
- `--sync-credential-env-var <name>`: local env-var reference for `local-primary`
- `--with-workflow`: generate `context.md` plus workflow guide files
- `--with-claude`: create a starter `CLAUDE.md` if it does not already exist
- `--with-agents`: create a starter `AGENTS.md` if it does not already exist
- `--start-session`: open the first builder session after init
- `--session-working-on <text>`: required with `--start-session` outside guided mode
- `--session-id <lane-id>`: required with `--start-session`; names the first builder lane
- `--close-session-git-publish`: store that the close-session workflow includes a Git publish step
- `--close-session-git-remote <name>`: optional default Git remote name for that stored publish step
- `--force`: overwrite an existing `project.yaml`

When `--start-session` is used, `init` automatically enables the minimum
workflow bootstrap required for that session: `context.md` plus `CLAUDE.md`.
Guided init can also record workflow defaults in
`project.yaml.metadata.workflow`, including whether close-session should
include a Git publish step and which remote name to use for that step.

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

### `vibecompass switch-session`

```text
vibecompass switch-session <lane-id> [options]
```

Changes the current lane in `sessions/active/index.yaml`.

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
- `--dry-run`: show planned writes without changing files

This command generates enabled agent-instruction files from canonical project
memory. It creates missing files with managed markers, replaces existing
managed regions, preserves content outside markers, and warns instead of
overwriting existing unmarked files.

### `vibecompass docs-review`

```text
vibecompass docs-review --guided [options]
```

Options:

- `--root <path>`: project-memory root; defaults to `.compass`
- `--guided`: accepted for the explicit comprehensive-review workflow
- `--submit-hosted`: submit the generated review request to the configured hosted sync binding
- `--complete`: mark accepted docs-review changes as completed in local state
- `--run-local-anthropic`: run the generated review request with local Anthropic and save the review output under `state/`
- `--llm <name>`: preferred LLM/provider to run the external architecture review; common choices are `claude`, `codex`, and `gemini`
- `--model <name>`: model name/version to record for the review
- `--anthropic-env-var <name>`: env var to use for local Anthropic runtime; defaults to `ANTHROPIC_API_KEY`
- `--max-tokens <number>`: local Anthropic output budget from 1024 to 32000; defaults to 16000

This command currently performs external-review handoff and runtime preflight.
It records the preferred LLM/provider and model in `state/docs-review.json`,
then prints an architecture-review prompt to run in that tool. The generated
prompt tells the reviewer to include a `## Review metadata` section in generated
architecture docs with provider, model/version, creation timestamp, project
mode, project-memory root, evidence standard, and coverage status. It enforces
the mode-aware contract from D-189 without pretending that a static scan is a
comprehensive review:

- `local-only`: requires a local Anthropic key
- `local-primary`: prefers hosted sync binding, otherwise accepts a local Anthropic key
- `hosted-only`: requires hosted sync binding

Use `--submit-hosted` when you want the package to submit the same generated
review request to the hosted sync binding. The request uses
`sync.credential_env_var`, sends project metadata and the generated prompt,
records the hosted run ID in `state/docs-review.json`, and leaves local
canonical files untouched until accepted docs changes are applied locally.

Use `--run-local-anthropic` when you want the package to execute the generated
review request through Anthropic with the configured local key. It saves the raw
review output to `state/docs-review-output.md`; apply accepted docs changes
manually so canonical project memory stays under user control. If Anthropic
stops at the configured `max_tokens` budget, the CLI warns that the saved output
may be partial.

The marker stays `external-review-requested`, `hosted-review-requested`, or
`local-review-generated` until the actual review runs and accepted docs changes are applied. Run
`vibecompass docs-review --complete` after those changes are in place; it
updates the marker to `status: "completed"` and preserves the `llm` / `model`
fields so future sessions know what reviewed the architecture.

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
  initializeProjectMemory,
  preflightDocsReview,
  startProjectSession,
  closeProjectSession,
  syncAgentInstructionFiles,
  scanProjectMemory,
  writeStateManifest,
  loadProjectReadModel,
  getProjectContext,
  getFeatureContext,
  getDecisionLog,
  getFileContext,
} from "vibecompass";
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
