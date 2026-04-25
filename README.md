# @vibecompass/vibecompass

Local-first project-memory core for [VibeCompass](https://vibecompass.dev).

This package owns the canonical local file contract for VibeCompass project
memory: `project.yaml`, `architecture/`, `decisions/`, `sessions/`, and the
derived `state/manifest.json` that lets tools read the local root efficiently.

## Current scope

Shipped today:

- `vibecompass init` for scaffolding a project-memory root
- interactive guided init for placement, workflow bootstrap, and first-session setup
- generated `context.md` plus opt-in workflow guide files
- opt-in starter `CLAUDE.md` / `AGENTS.md` templates that are created once and never overwritten
- `vibecompass start-session` / `vibecompass close-session` for the local builder workflow
- `vibecompass sync-agents` for generated `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, and `.github/copilot-instructions.md` views
- canonical file scanning and validation
- `state/manifest.json` generation
- JavaScript read-model helpers for project, feature, decision, and file context

Not shipped yet:

- hosted sync commands such as push, pull-preview, and pull-export

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
(`workspace-root`, `dedicated-memory-repo`, or `primary-repo`), scaffolds the
workflow files you opt into, and can open the first builder session
immediately.

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
  --session-working-on "Validate the local-first MCP workflow"
```

That creates the canonical root plus, when workflow scaffolding is enabled:

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

If you do not chain straight into a first session from `init`, open one later:

```bash
npx -y @vibecompass/vibecompass start-session \
  --working-on "Validate the MCP dogfood workflow against the docs repo"
```

Close the active builder session:

```bash
npx -y @vibecompass/vibecompass close-session \
  --title "Workflow Parity Commands" \
  --completed "Added package-owned start-session and close-session commands" \
  --next-step "Run the package publish dry-run"
```

The package CLI owns filesystem lifecycle only. The default scaffolded
workflow also uses prompt commands inside your coding tool:

```text
start session      # builder role trigger
join as reviewer   # reviewer role trigger
review handoff     # reviewer reads the latest note, wip.md, handoff.md, and diffs
address review     # builder reads reviewer feedback, responds inline, and continues
```

Those prompt commands are documented in the generated `context.md`,
`CLAUDE.md`, and `AGENTS.md` templates. They are not additional
`vibecompass` CLI subcommands.
Reviewer handback is explicit in the package-managed workflow: the reviewer
ends the pass by updating `wip.md` + `handoff.md`, and the builder closes
the session with `vibecompass close-session` using the defaults stored in
`project.yaml.metadata.workflow.close_session`.

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
vibecompass start-session --working-on <text> [options]
```

Options:

- `--root <path>`: project-memory root; defaults to `.compass`
- `--tooling-root <path>`: workspace root that contains `CLAUDE.md`; defaults to cwd
- `--working-on <text>`: required active-session summary
- `--date <YYYY-MM-DD>`: optional explicit session date

This command updates the `Current session` block in `CLAUDE.md` and creates
`sessions/wip.md` plus `sessions/handoff.md` for the next session number.

### `vibecompass close-session`

```text
vibecompass close-session --title <text> --completed <text> --next-step <text> [options]
```

Options:

- `--root <path>`: project-memory root; defaults to `.compass`
- `--tooling-root <path>`: workspace root that contains `CLAUDE.md`; defaults to cwd
- `--title <text>`: required finalized session-note title
- `--worked-on <text>`: optional override for the "What we worked on" section
- `--completed <text>`: repeatable completed item
- `--decision <text>`: repeatable decision reference or summary
- `--model <text>`: optional repeatable model contribution entry
- `--blocker <text>`: repeatable blocker or open question
- `--next-step <text>`: repeatable next-session instruction

This command finalizes the active scratchpad into
`sessions/YYYY-MM-DD-N-display-title.md`, deletes `wip.md` / `handoff.md`, and
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

### Prompt commands

These are the default prompt commands used by the scaffolded workflow files:

- `start session`: builder role trigger
- `join as reviewer`: reviewer role trigger
- `review handoff`: reviewer reads the latest finalized note, `wip.md`, `handoff.md`, and relevant diffs before appending findings
- `address review`: builder reads the latest reviewer feedback in `wip.md` / `handoff.md`, responds inline, applies accepted changes, and refreshes the builder handoff

They are prompt commands for AI-tool behavior, not package CLI commands.
Reviewer handback ends when the reviewer has updated `wip.md` and
`handoff.md`; there is no extra reviewer-exit step. The builder remains
in builder role, uses `address review` until findings are resolved or
explicitly deferred, and then runs `vibecompass close-session` using the
workflow defaults recorded in `project.yaml`.

## JavaScript API

```js
import {
  initializeProjectMemory,
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
