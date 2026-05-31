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

Run without installing:

```bash
npx -y @vibecompass/vibecompass --help
```

Or install in a project:

```bash
npm install @vibecompass/vibecompass
```

Requires Node.js 20+.

## Quick Start

Create project memory:

```bash
npx -y @vibecompass/vibecompass init --guided
```

Check what to do next:

```bash
npx -y @vibecompass/vibecompass status --root .compass
```

Start a builder session:

```bash
npx -y @vibecompass/vibecompass start-session \
  --root .compass \
  --id feature-lane \
  --working-on "Build the next feature"
```

Generate evidence-backed architecture docs:

```bash
npx -y @vibecompass/vibecompass docs-review --root .compass --guided
```

Close the session:

```bash
npx -y @vibecompass/vibecompass close-session \
  --root .compass \
  --session feature-lane \
  --title "Feature Lane" \
  --completed "Shipped the slice" \
  --next-step "Review and publish"
```

## Common Commands

```bash
# Create or inspect project memory
vibecompass init --guided
vibecompass status --root .compass

# Session workflow
vibecompass start-session --root .compass --id auth-flow --working-on "Auth flow"
vibecompass list-sessions --root .compass
vibecompass switch-session auth-flow --root .compass
vibecompass close-session --root .compass --session auth-flow --title "Auth Flow" --completed "Built auth" --next-step "Review"

# Agent instruction files
vibecompass sync-agents --root .compass

# Architecture docs review
vibecompass docs-review --root .compass --guided
vibecompass docs-review --root .compass --apply-output

# Rerun docs review from an archived architecture-doc slate
vibecompass docs-review --root .compass --rebuild --path architecture
vibecompass docs-review --root .compass --rebuild --apply --stale-policy archive --path architecture
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
vibecompass connect-hosted \
  --root .compass \
  --sync-api-url https://vibecompass.dev \
  --sync-project-id vc_proj_example \
  --sync-credential-env-var VIBECOMPASS_SYNC_TOKEN

vibecompass push --root .compass
```

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
