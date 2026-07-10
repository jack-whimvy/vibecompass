# Changelog

## Unreleased

## 0.12.0 - 2026-07-10

- New `vibecompass bootstrap --bundle <file>` materializes a complete local
  root from a hosted bootstrap-export bundle (fail-closed hash validation,
  verbatim writes, sync-cursor seeding for local-primary bundles).
- New `vibecompass sync-adopt [--accept-divergence]` re-baselines a root's
  sync cursor onto the hosted head after a divergence preview (D-215) — the
  recovery path for fresh clones and second devices.
- New `vibecompass promote-hosted [--resume|--abort]` and
  `vibecompass demote-hosted [--accept-divergence]` run the D-288 two-phase
  hosting-mode cutover: fresh verified baseline, server-side transition
  intent with a completeness report, local flip + promoted-root marker, and
  confirm — resumable after any crash and fully reversible.
- Promoted roots hard-refuse canonical write commands (override with
  VIBECOMPASS_ALLOW_PROMOTED_ROOT_WRITES=1); `vibecompass status` now checks
  the hosted mode and warns on local/hosted mode mismatches.
- `apply-export` pre-validates every operation before writing and treats
  already-applied operations as converged, so retries after partial failure
  succeed. `docs-review --apply-decision-artifact` is idempotent and
  crash-safe (provenance Source line, marker repair, post-write verification,
  code-enforced append-only) and warns on hosted-only roots.

- The missing-sync-token error now explains how to recover: re-export the bound
  env var, persist it in a shell profile, or rotate the token from the hosted
  dashboard (previously a bare "requires VIBECOMPASS_SYNC_TOKEN" with no
  guidance). README documents the persistence recipe.
- AGENTS.md gains a release checklist, including verifying that
  `vibecompass-mcp`'s dependency range still spans the new version so core
  releases stop stranding the MCP package (its `^0.1.0` pin had drifted 27
  releases behind).

## 0.11.2 - 2026-07-06

- Complete the remaining Phase 8 start-session overlap warnings: lanes can now
  declare expected architecture doc paths with `--architecture-doc` and
  decision domain files with `--decision-domain-file` / `--decision-domain`;
  active-lane overlap warnings compare normalized path spellings for those
  fields, and same-repo ownership ambiguity now covers one-sided or
  unparseable path claims while treating single-repo unprefixed claims and
  disjoint feature slugs as real non-overlapping ownership.
- Harden S2 lane-marker follow-ups: mutating session commands revalidate a
  pre-lock marker snapshot after acquiring the memory-root lock, close-session
  reports unrecorded cwd markers that name the closing lane, and marker parsing
  round-trips Windows absolute `memory_root` values with backslashes.

## 0.11.1 - 2026-07-06

- Harden the per-root serialization lock for symlink-aliased memory roots: root keys now canonicalize through existing parent directories when the memory root itself does not yet exist, and nested lock holders compare held/requested roots by `realpath` before reacquiring the disk lock. This preserves reentrancy when an outer lock creates the root and an inner call reaches it through another spelling.
- Make shared-checkout lane warnings honest about runnable isolation: unbound same-repo lanes now recommend `--branch <name> --worktree` for independent files or dev servers, including at `lane-env` where `PORT` is exported, while keeping `--claim` as the ownership-review fallback.
- Suppress shared-checkout warnings when either the selected lane or the sibling lane is already worktree-bound, and add regression coverage for the symlink-root reentrancy and worktree-bound warning paths.

## 0.11.0 - 2026-07-03

Phase 8 concurrent multi-session lanes (stages S1–S4). Highlights: a per-root
serialization lock, per-session lane identity with no implicit current-lane
fallback, opt-in per-lane git branch/worktree binding, per-lane runtime
(port + temp-dir) isolation, and a structure-preserving grouped decision-index
generator. This release carries breaking changes to lane/root resolution and
lane-metadata shapes — see the `Breaking:` entries below.

- Add per-lane runtime assignment (D-282, D-284): every `start-session` computes, inside the memory-root lock, a lane port — the lowest `port_base + k * port_step` not recorded by any other active lane — and a lane temp directory `<tmp_base>/<root-key>/<lane-id>` (root-key: first 12 hex chars of the SHA-256 of the memory root's canonical realpath; defaults `port_base` 3100, `port_step` 1, `tmp_base` `os.tmpdir()/vibecompass-lanes`, overridable via a new validated top-level `runtime:` key in `project.yaml` whose invalid values warn and fall back). The assignment is recorded as a `runtime:` block map in the lane's `session.yaml` (local-only per D-278), projected presence-gated into `state/manifest.json.active_sessions` (pre-S4 lanes keep their shapes), printed by `start-session`, and consumed via the new `lane-env` command — D-277/D-280 lane resolution, POSIX `export` lines for `VIBECOMPASS_LANE_ID`/`VIBECOMPASS_LANE_PORT`/`VIBECOMPASS_LANE_TMPDIR` plus conventional `PORT`/`TMPDIR` aliases (`--no-conventional` omits them, `--json` for tooling), so `eval "$(vibecompass lane-env)"` makes unmodified dev servers pick up the lane's assignment. Assignment is lane coordination, not an OS-level reservation: no port is probed or bound, and process supervision stays out of scope. Because `lane-env` exports `TMPDIR=<laneTmpDir>` and `os.tmpdir()` reads it, the default temp base strips any `vibecompass-lanes` segment out of the resolved OS temp root before appending the namespace (D-284), so a lane started from inside a `lane-env` shell is a sibling of the exporting lane, never nested inside it — nesting would let closing the outer lane recursively remove the inner lane's active temp dir; a start-time warning surfaces the un-nesting. The temp dir is created before the first root write (a failure aborts with the root untouched), joins the git-binding rollback, and is removed at close only under D-279/D-281-style guards keyed to the recorded env-independent `<root-key>/<lane-id>` tail (`basename(dirname)` = root-key, final segment = lane id) plus absolute-path and cwd-outside checks — never a live-`os.tmpdir()` recompute, which the exported `TMPDIR` would poison (D-284); guard refusals keep the dir with a `Lane temp dir:` line plus guidance, a missing dir is benign crash residue, and lanes without a `runtime:` record close exactly as before.
- Add `refresh-decision-index` (D-283), a grouped structure-preserving generator for `decisions/INDEX.md`: the existing file is the source of structure — H1, preamble, rule blockquote, then `## <date> — <session>` groups each holding one `| # | Decision | Domain |` table — and anything the parser cannot round-trip byte-identically fails closed with named findings (the hand-maintained file is never "repaired"). Rows are collected from strict `### D-NNN — <title>` canonical headings (hyphen-only headings are reported, never silently dropped) and refresh appends only missing decisions, into the group matching the target label — default `<session_date> — Session <N> (<lane-id> lane)` from the D-277/D-280 lane resolution, or an explicit `--group` — creating the group at the tail when absent; a no-op refresh is byte-idempotent. `--check` validates canonical↔index correspondence (every canonical decision exactly once with matching title and domain link, no orphan or duplicate rows) without writing. `append-decision` now refreshes the index through this generator inside the same lock when a group label is determinable and otherwise keeps the hand-refresh reminder — the canonical append never fails because of an index refusal (a structural refusal or an fs-error throw both degrade to a named warning, so a retry can never duplicate the decision). `append-decision` and `refresh-decision-index` adopt the D-280 marker-supplied memory root when `--root` is omitted and resolve the group label tolerantly, but only the 2+-active-lane no-selection ambiguity degrades to "no label": an explicit `--session` naming a non-active lane, or a stale worktree marker, still fails the command closed (D-277/D-280) rather than silently appending. The docs-review flat `--refresh-index` generator (D-209) now refuses to overwrite an index that contains grouped `## ` headings and points at `refresh-decision-index` instead.

- Add opt-in per-lane git binding (D-279/D-281): `start-session --branch <name>` creates or reuses the branch in every bound `--repo` (branch state detected with two probes — `rev-parse --verify --quiet refs/heads/<name>` for existence and tip, `worktree list --porcelain` for checked-out state; branch names are normalized via `git check-ref-format --branch` and `@{` shorthand is rejected), and the boolean `--worktree` flag provisions per-repo worktrees under the fixed `<workspace>/worktrees/<lane-id>/<repo-id>` container with the lane marker written into the container. Preflight fails closed on undeclared or non-key-safe repo ids, non-repo or nested source dirs, unborn HEADs, branches checked out elsewhere (worktree mode), the D-266 memory-fork layouts in both containment directions, a workspace that itself sits inside a git work tree, an existing container, and a branch another active lane already binds on a shared repo; dirty sources, branch reuse, and cross-lane branch divergence warn. Ref creation is always its own command whose success establishes rollback ownership, so a branch that appears externally between preflight and provisioning — even at the same start commit — fails the create with no ownership record and is never deleted; a failed provision rolls back everything this call actually created (worktree remove with rm+prune fallback, `branch -D` only for owned refs, container/marker/lane files, CLAUDE.md and index restoration) so `start-session` stays atomic.
- Add close-side guarded worktree removal (D-281, replacing the interim close-session refusal): `close-session` removes a bound lane's recorded clean worktrees by default, licensed by the D-279/D-280 guards — the recorded path must sit inside the lane's recorded container, and the container marker must parse and match the lane's recorded token and lane id — so arbitrary path removal is refused. Removal is never forced: dirty worktrees, unverifiable containers, paths outside the container, and worktrees whose `git status` fails (a status failure counts as unknown, not clean) all survive with per-worktree guidance, and removal is skipped with guidance when the process cwd sits inside the target. Branches are never deleted at close. The container marker is removed token-matched only when no recorded worktree survives (otherwise it is kept as a fail-closed breadcrumb), the empty container is then removed non-recursively (a stray user file keeps it in place with a note, and a container the process cwd sits inside is never rmdirred), and recorded-but-missing worktrees remain benign crash residue. `close-session` also fails closed when the closing lane's `session.yaml` cannot be parsed — a null-degraded parse would hide recorded worktrees and destroy the removal-guard records while the worktrees survive. Relative recorded worktree paths are refused outright (guards and `git -C <source>` would resolve them differently). Note that gitignored files (e.g. `.env`) do not count as dirty — matching git's own unforced `worktree remove` semantics — and are deleted with a clean worktree; copy ignored local files out before closing. The close result and CLI print a `Worktree cleanup:` summary; marker-only lanes close exactly as before.
- Add the pre-close staleness set (A:192, D-281): `docs-update` now computes, for the selected lane, canonical decisions appended after the lane's frozen start-of-lane snapshot (named with their domain file), base revisions stale relative to the current source repo heads (bound repos compare against the recorded source checkout, not the lane worktree), finalized session notes materialized after lane start that mention the lane's declared scope (claimed paths matched against the note's backticked path references with repo scoping, feature slugs, or backticked `repo:path` references), and repo-scope-aware claimed-path overlap with other active lanes (an explicit `repo:` prefix pins a claim to that repo, an unprefixed claim can live in any repo its lane declares — `app:src/x` and `lib:src/x` never cross-flag). The set renders as a `Pre-close staleness set:` section in the docs-update plan (pieces that cannot be evaluated are named, not skipped), and `close-session` re-emits every entry as a `Pre-close staleness:` warning so mid-session and close-out see the same target set.
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
