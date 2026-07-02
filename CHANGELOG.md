# Changelog

## Unreleased

## 0.10.8 - 2026-07-02

- Clarify generated docs-review workflow guidance so first passes establish breadth-first baseline coverage before optional scoped deepening.
- Add build-session guidance that tells builders to inspect relevant docs, decisions, coverage state, and source before feature work, then record, deepen, or explicitly defer documentation gaps before close-out.
- Print mode-aware hosted projection guidance during `close-session` / `end-session`: connected `local-primary` roots get an explicit `vibecompass push` reminder, `hosted-only` roots are directed through hosted/dashboard refresh, and `local-only` roots have no hosted push expectation.
- Expand close-session hosted guidance tests across local-primary with binding, local-primary without binding, hosted-only, and local-only modes.

## 0.10.7 - 2026-06-25

- Let `connect-hosted` attach hosted sync to existing `local-only` project-memory roots by promoting them to `local-primary`, so local-only users can run the hosted setup command copied from the app without first editing `project.yaml`.
- Print the mode promotion in CLI output and preserve existing `local-primary` / `hosted-only` behavior.
- Cover hosted-only passthrough, local-only promotion, and named-target promotion with CLI regression tests.

## 0.10.6 - 2026-06-22

- Add `docs-update` as a session-delta documentation maintenance planner that maps changed files, lane claims, session repos/features, new decisions, and package-owned generated/state surfaces to targeted architecture/decision/session follow-up.
- Print the same docs-update plan during `close-session` / `end-session` before the required document-maintenance checkpoint, while keeping semantic document authorship with the closing agent or human.
- Breaking: `close-session` / `end-session` and the `closeProjectSession` API now require document-maintenance checkpoint statuses for architecture docs, the decision log, and session handoff/scratch maintenance before a lane can be finalized.
- Surface shared docs-review architecture quality warnings for missing review metadata, evidence, blindspots, retrieval guidance, and repo scope in scanner/status output.
- Refresh `state/manifest.json.active_sessions` after session start, switch, and close commands so package-managed roots do not keep stale active-lane summaries.

## 0.10.5 - 2026-06-20

- Include compact docs-review evidence summaries in hosted review submissions, covering coverage score basis, source-inventory totals, documentation-plan totals, reconciliation deltas, producer stamps, and warning provenance.
- Bump docs-review to `VibeCompass Docs Review Prompt v7` and reject accepted coverage plans where `areas[].linked_inventory_ids[]` references inventory IDs missing from the same plan's `completeness_inventory[]`; hosted parsing now enforces the same contract under `hosted-docs-review-parser-v6`.
- Preserve optional `completeness_inventory[].repo_id` and `confidence` fields in accepted coverage-plan projections for hosted source-inventory filtering.

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
