# Changelog

## 0.10.4 - 2026-06-19

- Add `vibecompass --version`, `vibecompass -v`, and `vibecompass version` CLI support.
- Make bare `vibecompass init` errors point users to `vibecompass init --guided`.
- Clarify guided first-session prompts so lane IDs are presented as short kebab-case slugs and reserved yes/no answers explain that pressing Enter accepts the suggested slug.
- Propagate declared project repo ids into the first lane opened by guided init.

## 0.10.3 - 2026-06-19

- Let `start-session` create a missing `## Current session` summary block in adopted existing `CLAUDE.md` files instead of failing after guided init.
- Use the local calendar date, not UTC, when naming the starter `project-memory-initialized` session note during init.

## 0.10.2 - 2026-06-19

- Add a package-owned docs-review source inventory scanner that writes `state/docs-review-source-inventory.json`, includes scanned subsystem inventory in the review prompt, and records `scanned_unaccounted` / `source_unavailable` reconciliation warnings without changing the primary coverage score basis.
- Add an accepted docs-review documentation-plan projection at `state/docs-review-documentation-plan.json`, preserving plan titles, purposes, parent groups, baseline/deepening scope, linked inventory ids, evidence, anchors, and producer stamps as derived state.
- Add `docs-review --source-root <id=path>` so Git-backed repos can be scanned from local checkouts for a run without committing machine-local paths to `project.yaml`.
- Add a source-inventory concurrency stress test script and run it during `prepublishOnly` to guard symlink root-containment regressions.
- Ignore common OS metadata files such as `.DS_Store` during source inventory scans so package evidence does not create false route/API items.
- Collapse nested `config/<group>/**` source-inventory evidence into one platform subsystem per config group instead of fragmenting every leaf config file into its own item.
- Report all dangling `completeness_inventory[].coverage_area_ids[]` references in one docs-review apply error and prompt agents to fix them at the plan gate.
- Clarify docs-review coverage reporting so scores are described as evidence/completeness-inventory accounting when present, not doc-count accounting.

## 0.10.1 - 2026-06-14

- Add completeness-inventory guidance to docs-review so coverage plans account for accepted, deferred, and missing subsystems instead of silently omitting large areas.
- Score accepted coverage against the optional completeness inventory denominator when present, with a backwards-compatible fallback for older coverage plans.
- Add soft parser warnings for modern coverage plans that omit completeness inventory or under-explain accepted/deferred/missing inventory items.
- Add prose-only surface matrix guidance for feature docs while keeping `systems[]` as derived overview metadata rather than a second projected graph.

## 0.10.0 - 2026-06-14

- Make docs-review prompts mode-aware: interactive AI sessions stop at the coverage-plan approval gate, while `--run-local` and hosted single-turn runs emit fenced proposal material for later apply/proposal review.
- Clarify that pre-approval coverage plans are proposed scope, not accepted output, so agents should not label proposed areas `accepted` before user approval.
- Add docs-review Stage 0 quality guidance: topology-aware taxonomy rules, re-review anchoring, prior-doc reuse/update/split/merge/defer/replace classifications, and concrete evidence requirements.
- Preserve optional topology, taxonomy, and anchor classification fields in accepted coverage-plan projections.
- Surface quality warnings for architecture docs that keep generic evidence metadata instead of concrete repo:path references.
- Add Stage 1 backbone guidance for topology, core feature inventory, user journey map, project systems map, coverage/quality summary, and minimal optional derived project-map `systems[]` metadata.
- Update generated docs-review workflow guidance and prompt regression coverage for the interactive vs single-turn split, Stage 0 anchoring contract, and Stage 1 backbone outputs.

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
