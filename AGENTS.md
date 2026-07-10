# VibeCompass Core Package

Read `../vibecompass-docs/CLAUDE.md` first for project context and session continuity.

## Repo Purpose

This package is the local-first core for VibeCompass. It owns canonical
project-memory file parsing, validation, manifest generation, and later the
local workflows that `vibecompass-mcp` will read through.

## Working Rules

- Keep file and manifest behavior aligned with
  `../vibecompass-docs/architecture/platform/project-memory/`
- Treat canonical local files as the authority; derived files and local state
  must stay regenerable
- Avoid introducing hosted-only assumptions into the core package

## Commands

- `node --test src/tests/*.test.js`

## Release checklist

Before publishing a new version of this package:

1. Update `CHANGELOG.md` (move the `Unreleased` block under the new version heading) and bump `package.json`.
2. Run the full suite: `npm test` and `npm run test:source-inventory-stress`.
3. **Check `vibecompass-mcp`:** confirm its `@vibecompass/vibecompass` dependency range in `../vibecompass-mcp/package.json` still matches the new version (a `^0.x` range does NOT span 0.x minor bumps — `^0.11.0` excludes `0.12.0`). If the range excludes the new version, bump it, run the MCP suite (`npm test` in `../vibecompass-mcp`), and release the MCP package alongside. The MCP local provider consumes `loadProjectReadModel`/`getProjectContext`/`getFeatureContext`/`getDecisionLog`/`getFileContext` — treat their signatures as a public contract.

## Important Context

- This package is the implementation of the `vibecompass` side of D-110 and
  the local-first architecture/spec work from session 29
- The first implementation target is the parser/validator and
  `state/manifest.json` generation, not hosted sync or MCP transport
