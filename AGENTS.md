# VibeCompass Core Package

Project memory lives in this repo's workspace, not in the repo. From a main checkout the workspace is `..`; from a lane worktree (`<workspace>/worktrees/<lane-id>/<repo-id>/`) it is `../../..`, and `../.vibecompass-lane.yaml` names the lane's memory root (`memory_root`). Read the workspace `AGENTS.md` first: it names the canonical root and the session protocol. Architecture docs are under `<workspace>/vibecompass-docs/architecture/`.

## Repo Purpose

This package is the local-first core for VibeCompass. It owns canonical
project-memory file parsing, validation, manifest generation, and later the
local workflows that `vibecompass-mcp` will read through.

## Working Rules

- Keep file and manifest behavior aligned with
  `<workspace>/vibecompass-docs/architecture/platform/project-memory/`
- Treat canonical local files as the authority; derived files and local state
  must stay regenerable
- Avoid introducing hosted-only assumptions into the core package

## Commands

- `node --test src/tests/*.test.js`

## Release checklist

Before publishing a new version of this package:

1. Update `CHANGELOG.md` (move the `Unreleased` block under the new version heading) and bump `package.json`.
2. Run the full suite: `npm test` and `npm run test:source-inventory-stress`.
3. **Check `vibecompass-mcp`:** confirm its `@vibecompass/vibecompass` dependency range in `<workspace>/vibecompass-mcp/package.json` still matches the new version (a `^0.x` range does NOT span 0.x minor bumps — `^0.11.0` excludes `0.12.0`). If the range excludes the new version, bump it, run the MCP suite (`npm test` in `<workspace>/vibecompass-mcp`), and release the MCP package alongside. The MCP local provider consumes `loadProjectReadModel`/`getProjectContext`/`getFeatureContext`/`getDecisionLog`/`getFileContext` — treat their signatures as a public contract.

## Important Context

- This package is the implementation of the `vibecompass` side of D-110 and
  the local-first architecture/spec work from session 29
- The first implementation target is the parser/validator and
  `state/manifest.json` generation, not hosted sync or MCP transport
