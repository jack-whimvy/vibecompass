# Changelog

## Unreleased

- Add opt-in per-lane git binding (D-279/D-281): `start-session --branch <name>` creates or reuses the branch in every bound `--repo` (branch state detected with two probes — `rev-parse --verify --quiet refs/heads/<name>` for existence and tip, `worktree list --porcelain` for checked-out state; branch names are normalized via `git check-ref-format --branch` and `@{` shorthand is rejected), and the boolean `--worktree` flag provisions per-repo worktrees under the fixed `<workspace>/worktrees/<lane-id>/<repo-id>` container with the lane marker written into the container. Preflight fails closed on undeclared or non-key-safe repo ids, non-repo or nested source dirs, unborn HEADs, branches checked out elsewhere (worktree mode), the D-266 memory-fork layouts in both containment directions, a workspace that itself sits inside a git work tree, an existing container, and a branch another active lane already binds on a shared repo; dirty sources, branch reuse, and cross-lane branch divergence warn. Ref creation is always its own command whose success establishes rollback ownership, so a branch that appears externally between preflight and provisioning — even at the same start commit — fails the create with no ownership record and is never deleted; a failed provision rolls back everything this call actually created (worktree remove with rm+prune fallback, `branch -D` only for owned refs, container/marker/lane files, CLAUDE.md and index restoration) so `start-session` stays atomic. Until the close-side guarded removal lands, `close-session` refuses to close a lane whose recorded worktrees still exist on disk and prints the manual cleanup commands; recorded-but-missing worktrees are benign and do not block the close.
- Record git binding in lane metadata: `session.yaml` gains `branch`, `worktree_container`, `worktrees:`, `worktree_sources:`, and `base_revisions:` (captured at start for every claimed repo — bound repos record the created start point or reused branch tip, non-git dirs skip silently, unborn HEADs warn, non-key-safe repo ids fail closed instead of relaxing the parser); `state/manifest.json.active_sessions` lanes expose `branch` + `worktree_container` (omitted for unbound lanes); `write-lane-marker` refuses to rebind a lane that records a worktree container (D-281: a rebind would orphan the close-time removal guard).
- Breaking: root resolution for read-only surfaces and repo scans now matches lane-scoped commands (D-280): the compatibility preflight and `status` adopt the nearest valid marker's memory root when `--root` is omitted (previously always `cwd/.compass`, which emitted spurious warnings from marker-bound cwds), and `docs-update` resolves declared repo directories against the workspace (`dirname(rootDir)`) instead of the invoking cwd — from a worktree or nested cwd it previously scanned nonexistent paths and silently dropped every repo delta. `docs-update` also scans a git-bound lane's recorded worktrees (prefixed `repo-id:`) instead of the source checkouts for bound repos, and skips the unprefixed cwd scan when cwd is inside a recorded worktree.
- Quoted scalars in the simple-yaml subset now unescape symmetrically with the writers' `JSON.stringify` quoting (backslashes and embedded quotes round-trip; hand-authored non-JSON quoting keeps the historical naive slice).

- Add worktree lane markers (D-280): `.vibecompass-lane.yaml` written only by the new `write-lane-marker` command (S3 worktree provisioning becomes the second producer), recorded in the lane's `session.yaml` as a `lane_marker:` block map, token-matched for removal at `close-session`, and required to be path-disjoint from the memory root (ancestor, equal, and inside-root targets are refused).
- Breaking: resolve lane identity per D-277 in `close-session` and `docs-update`: an explicit `--session` wins (warning names both lanes when it overrides a marker; a non-active explicit lane now fails closed), then the nearest worktree lane marker walking up from cwd (stale markers fail closed, even when a single-lane fallback would have succeeded; mismatched-root markers are ignored with a warning), then the single active lane. `docs-update` / the exported `planDocsUpdate` previously succeeded at 2+ active lanes by silently using the root-global index pointer and now error without an explicit `--session` or marker.
- Breaking: `listProjectSessions().current` (and the `list-sessions` / `status` / `state/manifest.json.active_sessions` surfaces derived from it) can now be `null` when 2+ lanes are active and no valid pointer selects one, instead of fabricating the alphabetically-first lane.
- Infer the memory root from the marker when `--root` is omitted (explicit `--root` always wins; `cwd/.compass` remains the no-marker default), so lane-scoped commands run from a worktree cwd with neither `--root` nor `--session`; the tooling root follows the memory root's parent directory in that case.
- Remove the implicit current-lane defaults: `list-sessions`/status/state-manifest no longer fabricate a current lane from an unvalidated index pointer, and closing a lane never auto-promotes an alphabetical survivor — with 2+ survivors the pointer goes null until an explicit selection (a sole survivor is still promoted). This also fixes a partial-close crash when a stale pointer named a missing lane.
- Render the Current-session block as a derived multi-lane listing (one line per active lane plus the selected lane) whenever 2+ lanes are active, keeping the legacy five-field shape parse-compatible; generated agent/workflow guidance now teaches the D-277 resolution order and explicit reviewer lane selection (`review handoff <lane-id>`).

- Add a per-root serialization lock (mkdir-mutex under `state/` with owner tokens, release-only-own semantics, atomic rename-based reclaim of dead-process locks, and no stealing from live holders) so all package writers of shared project memory — session lifecycle, `refresh-workflow --apply`, docs-review apply paths, `apply-export`, `connect-hosted`, `sync-target`, state-manifest refresh, and managed agent-file sync — run one at a time per project-memory root (D-276).
- Add `append-decision`: an atomic append path that allocates the next D-number at write time from a staged `### D-NEXT — <title>` entry, plus `next-decision-id` as an advisory preview.
- Block `close-session` when duplicate decision IDs exist in canonical decision files; duplicates are surfaced for human repair, never auto-renumbered.
- Add `rebuild-active-index` to regenerate `sessions/active/index.yaml` from active lane directories with an explicit current-lane selection when multiple lanes are active (D-277).

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
