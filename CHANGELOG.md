# Changelog

## 0.9.2 - 2026-06-14

- Clarify docs-review acceptance gates so agents state when no architecture docs have been applied yet and only report completion after apply succeeds.
- Render local folder repo sources correctly in generated agent files instead of showing `null`.
- Fix false agent-file drift in `status` after `sync-agents` when managed files are already current.

## 0.9.1 - 2026-06-14

- Make local docs-review prompts self-contained by printing the accepted output file, root-scoped apply command, and same-version `npx` fallback the agent should run after user acceptance.

## 0.9.0 - 2026-06-14

- Add explicit local folder sources for non-Git projects: `project.yaml.repos[]` may use `source: local` plus `path`, and `init` accepts `--repo-local <id=path>`.
- Keep blank Git remotes invalid, but report an actionable `--repo-local` hint when `--repo <id=remote>` resolves to an empty value.
- Update guided init, starter docs, status, scanning, and read-model output so local-source roots validate and render cleanly.
- Bump docs-review to `VibeCompass Docs Review Prompt v3`, requiring first-pass docs to include a user journey, project/system map, and core journey-facing feature summaries.
- Add `vibecompass-project-map version=1` support inside `architecture/overview/project-shape.md`, including nested-fence parsing so generated overview docs can round-trip the machine-readable journey map block.

## 0.8.0 - 2026-06-12

- Add named sync targets (D-236): `connect-hosted --target <name>` binds one project root to multiple hosted environments (for example `dev` on localhost and `prod` on vibecompass.dev).
- Add a `sync-target` command to list named targets and switch the default; flat `sync` fields in project.yaml always mirror the default target so older CLIs keep working.
- Add `--sync-target <name>` to `push`, `pull-preview`, `pull-export`, and `docs-review` for per-command environment selection; unknown target names error instead of falling back.
- Partition local sync cursor state per target (D-237): each target keeps its own last-pushed revision and pull previews, identity-checked against its URL and project id, so one environment's history can never become another environment's baseline.
- Carry the existing sync history over when a flat binding is converted into its first named target with the same URL and project id.
- Record the submitted sync target in the docs-review marker so `--poll-hosted` stays pinned to the environment the run was submitted to.

## 0.7.0 - 2026-05-30

- Add `docs-review --rebuild` with dry-run preview, scoped architecture paths, and archive-based stale-doc preparation.
- Simplify the npm README into a short package entrypoint with links to the developer docs.

## 0.6.0 - 2026-05-25

- Bump docs-review to `VibeCompass Docs Review Prompt v2`.
- Add a staged docs-review workflow: evidence inventory, coverage plan, bounded doc generation, and apply/verify.
- Add retrieval-oriented metadata expectations so generated architecture docs are useful future context without requiring broad token-heavy loads.
- Add soft `oversized_architecture_doc` warnings for accepted architecture docs over the 12000-byte budget.
- Include package-owned workflow registry files in the npm tarball.

## 0.5.0

- Previous published release.
