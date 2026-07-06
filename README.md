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
  --architecture-docs updated \
  --decision-log not-needed \
  --session-maintenance updated \
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
npx -y @vibecompass/vibecompass@latest docs-update --root .compass --session auth-flow
npx -y @vibecompass/vibecompass@latest close-session --root .compass --session auth-flow --title "Auth Flow" --completed "Built auth" --architecture-docs updated --decision-log not-needed --session-maintenance updated --next-step "Review"

# Optional git binding for a lane (D-281): create/reuse a branch in each bound
# repo; --worktree provisions per-repo worktrees under
# <workspace>/worktrees/<lane-id>/<repo-id> with the lane marker in the
# container, so commands run from inside a worktree need no --root/--session.
# At close, close-session removes the recorded worktrees when they are clean
# (guarded, never forced; branches are never deleted); dirty or in-use
# worktrees survive with guidance and the lane marker stays as a breadcrumb.
# Gitignored files (e.g. .env) do not count as dirty and are deleted with a
# clean worktree — copy ignored local files out before closing.
# close-session and docs-update also print a pre-close staleness set: new
# decisions since lane start, stale base revisions, newer finalized notes
# that mention the lane's scope, and claim overlap with other active lanes.
npx -y @vibecompass/vibecompass@latest start-session \
  --id auth-flow \
  --working-on "Auth flow" \
  --repo app \
  --claim src/app/auth \
  --architecture-doc architecture/product/auth/login.md \
  --decision-domain-file cross-cutting.md \
  --branch feature/auth \
  --worktree

# Per-lane runtime isolation (D-282): every lane gets its own port and temp
# dir at start (recorded in the lane's session.yaml; defaults configurable
# under project.yaml runtime: port_base/port_step/tmp_base). Export them into
# a shell — includes conventional PORT/TMPDIR aliases so unmodified dev
# servers pick them up — before running dev servers or build tools, so
# parallel lanes never fight over ports or temp paths. close-session removes
# the lane temp dir (guarded; the port record vanishes with the lane).
eval "$(npx -y @vibecompass/vibecompass@latest lane-env)"

# Agent instruction files
npx -y @vibecompass/vibecompass@latest sync-agents --root .compass

# Decision log maintenance: append-decision allocates the D-number at write
# time and refreshes the grouped decisions/INDEX.md when it can label the
# group from the lane context (D-283, structure-preserving — hand-authored
# session group headings are preserved verbatim; unparseable structure fails
# closed). refresh-decision-index --check validates the index against the
# canonical decision files without writing.
npx -y @vibecompass/vibecompass@latest append-decision --root .compass --target cross-cutting.md --entry staged-entry.md
npx -y @vibecompass/vibecompass@latest refresh-decision-index --root .compass --check

# Targeted and comprehensive architecture docs maintenance
npx -y @vibecompass/vibecompass@latest docs-update --root .compass --session auth-flow --changed app:src/auth/login.ts
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
- `docs update`
- `close session` / `end session`
- `docs review`

The npm package owns the file mechanics. Your AI session owns reading the
workflow files, updating handoffs, and applying reviewed changes. Use
`docs review` for the broad baseline and scoped deepening work; use
`docs update` / `vibecompass docs-update` for ordinary session-delta
maintenance tied to the current lane.

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

After `close-session`, run `push` again when a connected local-primary root
changed canonical project-memory files and the hosted dashboard should catch
up. Hosted-only projects do not use a local authoritative push; update or
refresh them through the hosted dashboard/proposal flow.

The sync token is read from the environment variable you bind (for example
`VIBECOMPASS_SYNC_TOKEN`). One-off `export`s do not survive new terminals —
persist the token in your shell profile (`~/.zshenv` or `~/.bashrc`):

```bash
echo 'export VIBECOMPASS_SYNC_TOKEN="<your sync token>"' >> ~/.zshenv
```

If the token is lost, rotate it on the hosted dashboard under Setup -> Hosted
sync and export the new value.

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
