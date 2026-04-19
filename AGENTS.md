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

## Important Context

- This package is the implementation of the `vibecompass` side of D-110 and
  the local-first architecture/spec work from session 29
- The first implementation target is the parser/validator and
  `state/manifest.json` generation, not hosted sync or MCP transport
