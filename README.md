<p align="center">
  <a href="https://vibecompass.dev">
    <img src="https://raw.githubusercontent.com/jack-whimvy/vibecompass/main/brand/logo-a4.png" alt="VibeCompass" height="96" />
  </a>
</p>

# @vibecompass/vibecompass

Local-first project memory for AI coding sessions.

VibeCompass creates a `.compass/` project-memory root with architecture docs,
decision logs, session notes, and agent instructions so Claude Code, Codex,
Cursor, and Copilot can pick up where the last session left off.

Full docs: https://vibecompass.dev/developers

## Install

Most people can run VibeCompass without installing it globally:

```bash
npx -y @vibecompass/vibecompass@latest --help
```

Or install it globally if you want the shorter `vibecompass` command:

```bash
npm install -g @vibecompass/vibecompass@latest
```

Requires Node.js 20+.

## Quick Start

### Easiest path: ask your AI coding tool

Open Claude Code, Codex, Cursor, or Copilot in the project folder you want
VibeCompass to remember, then paste:

```text
VibeCompass is project memory for vibe coding. Use the npm package
@vibecompass/vibecompass@latest.

Please set it up in this project:
1. Run the needed VibeCompass commands with npx.
2. Initialize project memory with guided setup.
3. If this folder is not a Git repo, use a local folder source.
4. Start a named session lane for this setup work.
5. If you run docs review, continue until either architecture docs are applied
   or you are waiting for my explicit coverage-plan approval. Do not call docs
   review done just because the marker was created.
6. Tell me which files changed, whether docs were actually applied, and what I
   should review next.

Do not ask me to paste secret tokens into chat.
```

After setup, start a fresh AI session in the same project and type:

```text
docs review
```

That asks the AI to inspect your code and create the first real architecture
docs. If it asks you to approve a coverage plan, approve it or ask for changes;
the package prints the output file and exact apply command after the accepted
docs are ready.

### Terminal path

Run this from your project folder:

```bash
npx -y @vibecompass/vibecompass@latest init --guided
```

If the folder is not a Git repo, use a local folder source:

```bash
npx -y @vibecompass/vibecompass@latest init \
  --root .compass \
  --name "My Project" \
  --mode local-primary \
  --repo-local app=.
```

Check what to do next:

```bash
npx -y @vibecompass/vibecompass@latest status --root .compass
```

Start a builder session:

```bash
npx -y @vibecompass/vibecompass@latest start-session \
  --root .compass \
  --id feature-lane \
  --working-on "Build the next feature"
```

Generate evidence-backed architecture docs:

```bash
npx -y @vibecompass/vibecompass@latest docs-review --root .compass --guided
```

Close the session:

```bash
npx -y @vibecompass/vibecompass@latest close-session \
  --root .compass \
  --session feature-lane \
  --title "Feature Lane" \
  --completed "Shipped the slice" \
  --next-step "Review and publish"
```

## Common Commands

```bash
# Create or inspect project memory
npx -y @vibecompass/vibecompass@latest init --guided
npx -y @vibecompass/vibecompass@latest status --root .compass

# Session workflow
npx -y @vibecompass/vibecompass@latest start-session --root .compass --id auth-flow --working-on "Auth flow"
npx -y @vibecompass/vibecompass@latest list-sessions --root .compass
npx -y @vibecompass/vibecompass@latest switch-session auth-flow --root .compass
npx -y @vibecompass/vibecompass@latest close-session --root .compass --session auth-flow --title "Auth Flow" --completed "Built auth" --next-step "Review"

# Agent instruction files
npx -y @vibecompass/vibecompass@latest sync-agents --root .compass

# Architecture docs review
npx -y @vibecompass/vibecompass@latest docs-review --root .compass --guided
npx -y @vibecompass/vibecompass@latest docs-review --root .compass --guided --source-root app=../app
npx -y @vibecompass/vibecompass@latest docs-review --root .compass --apply-output

# Rerun docs review from an archived architecture-doc slate
npx -y @vibecompass/vibecompass@latest docs-review --root .compass --rebuild --path architecture
npx -y @vibecompass/vibecompass@latest docs-review --root .compass --rebuild --apply --stale-policy archive --path architecture
```

## What It Creates

```text
.compass/
  project.yaml
  context.md
  architecture/
  decisions/
  sessions/
  state/
```

Docs review writes derived state under `state/`, including scanned source
inventory, accepted coverage, and the accepted documentation-plan projection.

Generated agent files can also include managed VibeCompass blocks:

```text
CLAUDE.md
AGENTS.md
.cursorrules
.github/copilot-instructions.md
```

## Prompt Commands

After setup, use these phrases inside your AI coding tool:

- `start session`
- `join as reviewer`
- `planning mode`
- `review handoff`
- `address review`
- `close session` / `end session`
- `docs review`

The npm package owns the file mechanics. Your AI session owns reading the
workflow files, updating handoffs, and applying reviewed changes.

## Hosted Sync

Use hosted sync when you want browser review, team workflows, or hosted
docs-review proposals:

```bash
npx -y @vibecompass/vibecompass@latest connect-hosted \
  --root .compass \
  --sync-api-url https://vibecompass.dev \
  --sync-project-id vc_proj_example \
  --sync-credential-env-var VIBECOMPASS_SYNC_TOKEN

npx -y @vibecompass/vibecompass@latest push --root .compass
```

### Multiple environments

One project can have named sync targets (for example a local dev server and
production) so you never have to rebind:

```bash
# add targets once — the first one becomes the default
npx -y @vibecompass/vibecompass@latest connect-hosted --root .compass --target dev \
  --sync-api-url http://localhost:3000 --sync-project-id vc_proj_dev \
  --sync-credential-env-var VIBECOMPASS_SYNC_TOKEN
npx -y @vibecompass/vibecompass@latest connect-hosted --root .compass --target prod \
  --sync-api-url https://vibecompass.dev --sync-project-id vc_proj_prod \
  --sync-credential-env-var VIBECOMPASS_SYNC_TOKEN_PROD

# then pick per command, or switch the default
npx -y @vibecompass/vibecompass@latest push --root .compass --sync-target prod
npx -y @vibecompass/vibecompass@latest sync-target prod --root .compass
```

Tip: if you already have a single (flat) binding, add it as your first named
target using the same URL and project id — its sync history carries over.

See https://vibecompass.dev/developers for the full local-primary workflow.

## JavaScript API

```js
import {
  initializeProjectMemory,
  getProjectStatus,
  scanProjectMemory,
  loadProjectReadModel,
  getProjectContext,
} from "@vibecompass/vibecompass";
```

Use the JavaScript API when building tools that need to inspect or manage a
local VibeCompass project-memory root.

## More Documentation

- Developer guide: https://vibecompass.dev/developers
- CLI reference: https://vibecompass.dev/developers/cli
- Session protocol: https://vibecompass.dev/developers/protocol
- Concepts: https://vibecompass.dev/developers/concepts
