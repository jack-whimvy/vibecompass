import { execFile } from 'node:child_process';
import { realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { assertMarkerTargetDisjoint, findEnclosingGitDir, readLaneMarker } from './lane-marker.js';
import { isSimpleYamlKeySafe } from './simple-yaml.js';

const execFileAsync = promisify(execFile);

// Cheap read-only probes (rev-parse, check-ref-format, worktree list) keep the
// docs-update timeout; worktree add/remove perform full checkouts and get a
// generous budget — a 5s SIGTERM mid-checkout is exactly the half-created
// state the rollback ordering exists to avoid.
const QUICK_GIT_TIMEOUT_MS = 5000;
const WORKTREE_GIT_TIMEOUT_MS = 120000;
const GIT_OUTPUT_MAX_BUFFER = 1024 * 1024;

/**
 * Repo working copies live as siblings of the memory root: the workspace is
 * `dirname(rootDir)` and a declared `repo.path` (else the repo id) resolves
 * against it. This is the same convention docs-update uses for status scans.
 */
export function resolveRepoSourceDir(workspaceDir, repoId, projectRepos) {
  const declared = (projectRepos ?? []).find((repo) => repo && typeof repo === 'object' && repo.id === repoId);
  const relative = typeof declared?.path === 'string' && declared.path.trim() !== '' ? declared.path : repoId;
  return path.resolve(workspaceDir, relative);
}

/**
 * D-281: capture base_revisions for every claimed repo at lane start. A
 * non-git directory is skipped silently — git is never mandatory for lanes
 * (D-265/D-279). A git repo with no commits and a repo id that cannot be a
 * session.yaml map key produce warnings instead of blocking the start.
 */
export async function captureBaseRevisions(options) {
  const baseRevisions = {};
  const warnings = [];

  for (const repoId of options.repoIds ?? []) {
    if (!isSimpleYamlKeySafe(repoId)) {
      warnings.push(
        `base_revisions skipped for repo "${repoId}": the id is not a safe session.yaml map key (letter or underscore first, then letters, digits, hyphens, underscores).`,
      );
      continue;
    }

    const repoDir = resolveRepoSourceDir(options.workspaceDir, repoId, options.projectRepos);
    // Only a repository ROOT records a base — `git -C` from a plain
    // subdirectory of some enclosing repo would silently record the outer
    // repo's HEAD as this repo's base.
    const toplevel = await readGitToplevel(repoDir);
    if (!toplevel || !(await isSameDirectoryReal(toplevel, repoDir))) {
      continue;
    }
    const head = await readGitHeadRevision(repoDir);
    if (head.status === 'ok') {
      baseRevisions[repoId] = head.revision;
    } else if (head.status === 'unborn') {
      warnings.push(`base_revisions skipped for repo "${repoId}": ${repoDir} is a git repository with no commits yet.`);
    }
  }

  return { baseRevisions, warnings };
}

/**
 * S3-4 base-revision staleness probe: the current HEAD of a repo source
 * checkout, with the same repository-root-only semantics as
 * captureBaseRevisions (a nested directory would report the outer repo's
 * HEAD). Returns null for missing/non-git/nested/unborn sources — the
 * caller names unreadable heads for repos that recorded a base (unevaluable
 * staleness pieces are named, not skipped).
 */
export async function readCurrentRepoHead(repoDir) {
  const toplevel = await readGitToplevel(repoDir);
  if (!toplevel || !(await isSameDirectoryReal(toplevel, repoDir))) {
    return null;
  }

  const head = await readGitHeadRevision(repoDir);
  return head.status === 'ok' ? head.revision : null;
}

/**
 * `--verify --quiet` exits 1 silently on an unborn HEAD, which also lands in
 * the catch alongside "not a repository" — the git-dir probe separates the
 * two so only real repos without commits warn.
 */
async function readGitHeadRevision(repoDir) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoDir, 'rev-parse', '--verify', '--quiet', 'HEAD'],
      { timeout: QUICK_GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_MAX_BUFFER },
    );
    const revision = stdout.trim();
    if (revision !== '') {
      return { status: 'ok', revision };
    }

    return { status: 'unborn' };
  } catch {
    return (await isGitRepository(repoDir)) ? { status: 'unborn' } : { status: 'not-a-repo' };
  }
}

async function isGitRepository(repoDir) {
  try {
    await execFileAsync(
      'git',
      ['-C', repoDir, 'rev-parse', '--git-dir'],
      { timeout: QUICK_GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_MAX_BUFFER },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * D-281: validate and normalize a branch name with git itself. check-ref-format
 * --branch expands shorthand like `@{-1}` — the normalized stdout is what gets
 * recorded and used, and names containing `@{` are rejected outright so the
 * recorded branch can never diverge from the real one.
 */
export async function normalizeBranchName(branch) {
  const trimmed = typeof branch === 'string' ? branch.trim() : '';
  if (trimmed === '') {
    throw new Error('--branch requires a non-empty branch name.');
  }
  if (trimmed.includes('@{')) {
    throw new Error(`Branch name "${trimmed}" contains "@{", which git expands as a ref shortcut; use a literal branch name.`);
  }

  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      'git',
      ['check-ref-format', '--branch', trimmed],
      { timeout: QUICK_GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_MAX_BUFFER },
    ));
  } catch {
    throw new Error(`Branch name "${trimmed}" is not a valid git branch name (git check-ref-format --branch refused it).`);
  }

  const normalized = stdout.trim();
  if (normalized === '') {
    throw new Error(`Branch name "${trimmed}" did not normalize to a usable git branch name.`);
  }

  return normalized;
}

/**
 * D-281/D-266/D-279 git-readiness preflight. Runs before any filesystem write
 * so a refused binding leaves nothing behind. Returns per-repo plans (mode,
 * source dir, base revision, worktree target) plus non-fatal warnings.
 */
export async function preflightGitBinding(options) {
  const warnings = [];
  const repoIds = options.repoIds ?? [];
  if (repoIds.length === 0) {
    throw new Error('--branch requires at least one --repo so the lane names which repositories it binds.');
  }

  if (options.worktree) {
    // Placement guard: dirname(root) workspace inference is only sound when
    // the workspace is not itself a git work tree — otherwise the container
    // and its marker would land inside a repository (D-278/D-279).
    const enclosingGitDir = await findEnclosingGitDir(options.workspaceDir);
    if (enclosingGitDir) {
      throw new Error(
        `Cannot provision worktrees: the inferred workspace ${options.workspaceDir} sits inside the git work tree at ${enclosingGitDir}. ` +
          'The <workspace>/worktrees container must live outside every repository (D-279/D-281). Run without --worktree, or pass --root pointing at a shared memory root whose parent is not a repository.',
      );
    }

    await assertMarkerTargetDisjoint(options.containerDir, options.rootDir);
    if (await pathExists(options.containerDir)) {
      throw new Error(
        `Cannot provision worktrees: ${options.containerDir} already exists. Remove it or close the lane that owns it first (D-279: provisioning never adopts existing paths).`,
      );
    }
  }

  const declaredIds = new Set(
    (options.projectRepos ?? [])
      .map((repo) => (repo && typeof repo === 'object' ? repo.id : null))
      .filter(Boolean),
  );

  const repoPlans = [];
  for (const repoId of repoIds) {
    if (!declaredIds.has(repoId)) {
      throw new Error(`--branch cannot bind repo "${repoId}": it is not declared in project.yaml repos.`);
    }
    if (!isSimpleYamlKeySafe(repoId)) {
      throw new Error(
        `--branch cannot bind repo "${repoId}": the id is not a safe session.yaml map key (letter or underscore first, then letters, digits, hyphens, underscores). Rename the repo id or run without --branch.`,
      );
    }

    const sourceDir = resolveRepoSourceDir(options.workspaceDir, repoId, options.projectRepos);
    const toplevel = await readGitToplevel(sourceDir);
    if (!toplevel) {
      throw new Error(`--branch requires repo "${repoId}" to be a git repository at ${sourceDir}, but git could not resolve a work tree there. Clone or init it first, or run without --branch.`);
    }
    if (!(await isSameDirectoryReal(toplevel, sourceDir))) {
      throw new Error(`Repo "${repoId}" at ${sourceDir} sits inside the git repository rooted at ${toplevel}; git binding needs the repository root, not a subdirectory.`);
    }

    // D-266 memory-fork guard, both containment directions. Conservative: an
    // untracked .compass inside the repo is also refused — worktree adds would
    // not fork it, but binding a lane there still invites divergent memory.
    const realRoot = await canonicalizePathReal(options.rootDir);
    const realTop = await canonicalizePathReal(sourceDir);
    if (isPathEqualOrInsideReal(realRoot, realTop)) {
      throw new Error(
        `Cannot git-bind repo "${repoId}": the project-memory root ${options.rootDir} sits inside its work tree at ${sourceDir}, so a per-lane worktree would fork shared memory (D-266). ` +
          'Run without --branch/--worktree, or pass --root pointing at this project\'s initialized shared memory root outside the repository. ' +
          '(An untracked .compass inside the repository is refused conservatively as well.)',
      );
    }
    if (isPathEqualOrInsideReal(realTop, realRoot)) {
      throw new Error(
        `Cannot git-bind repo "${repoId}": its work tree ${sourceDir} sits inside the project-memory root ${options.rootDir} — code never lives in package memory (D-278).`,
      );
    }

    const head = await readGitHeadRevision(sourceDir);
    if (head.status !== 'ok') {
      throw new Error(`--branch requires repo "${repoId}" to have at least one commit at ${sourceDir}; commit first so the lane has a base revision to start from.`);
    }

    // Two probes (reviewer-verified): worktree list only shows checked-out
    // branches, so ref existence needs its own probe — whose stdout is also
    // the reuse-mode base revision.
    const branchTip = await readBranchTip(sourceDir, options.branch);
    const checkedOutAt = await findBranchCheckout(sourceDir, options.branch);
    if (checkedOutAt) {
      if (options.worktree) {
        throw new Error(
          `Branch "${options.branch}" is already checked out at ${checkedOutAt} in repo "${repoId}". Pick another branch or detach that checkout; if nothing is visibly checked out there, a stale registration is blocking it — run \`git -C ${sourceDir} worktree prune\`.`,
        );
      }
      warnings.push(
        `Branch "${options.branch}" is already checked out at ${checkedOutAt} in repo "${repoId}"; branch-only binding records it without touching that checkout.`,
      );
    }

    if (await isSourceTreeDirty(sourceDir)) {
      warnings.push(`Repo "${repoId}" has uncommitted changes at ${sourceDir}; they will not be part of the lane's base revision.`);
    }

    const mode = branchTip ? 'reuse' : 'create';
    if (mode === 'reuse' && !checkedOutAt) {
      warnings.push(`Branch "${options.branch}" already exists in repo "${repoId}"; reusing it (base ${branchTip.slice(0, 12)}).`);
    }

    repoPlans.push({
      repoId,
      sourceDir,
      mode,
      // Reuse mode bases the lane on what actually gets checked out — the
      // existing branch tip — not the source HEAD.
      baseRevision: branchTip ?? head.revision,
      startPoint: head.revision,
      worktreePath: options.worktree ? path.join(options.containerDir, repoId) : null,
    });
  }

  for (const lane of options.existingLanes ?? []) {
    if (!lane?.branch) {
      continue;
    }

    const sharedRepos = (lane.repos ?? []).filter((repoId) => repoIds.includes(repoId));
    if (sharedRepos.length === 0) {
      continue;
    }

    if (lane.branch === options.branch) {
      throw new Error(
        `Active lane "${lane.id}" already binds branch "${options.branch}" in shared repo(s) ${sharedRepos.join(', ')}; two lanes cannot share a branch. Pick a different --branch.`,
      );
    }

    warnings.push(
      `Active lane "${lane.id}" binds branch "${lane.branch}" in shared repo(s) ${sharedRepos.join(', ')}; diverging branches on the same repo reconcile through normal git merge (D-266).`,
    );
  }

  return { repoPlans, warnings };
}

/**
 * Executes the git side of a binding. Ref creation is always its own command
 * (`git branch <name> <start-point>`) and is recorded as owned only AFTER it
 * succeeds: a branch that appeared externally in the preflight→provision race
 * window — even at the same tip — makes the create fail with no ownership
 * record, so rollback can never delete a ref this call did not create
 * (D-281). Worktree checkouts then always use the reuse form
 * `worktree add <path> <branch>` (the -b form would conflate ref creation
 * with checkout, and the plain-commit form would produce a detached HEAD).
 * Worktree PATHS are still recorded before their command runs — the
 * container is exclusively in-call (preflight refused an existing one), so
 * path ownership is unambiguous and a mid-checkout kill must stay removable.
 */
export async function provisionGitBinding(options, progress) {
  for (const plan of options.repoPlans) {
    if (plan.mode === 'create') {
      await runProvisioningGit(
        ['-C', plan.sourceDir, 'branch', options.branch, plan.startPoint],
        `create branch "${options.branch}" in repo "${plan.repoId}"`,
      );
      progress.createdBranches.push({ sourceDir: plan.sourceDir, startPoint: plan.startPoint });
    }
    if (plan.worktreePath) {
      progress.worktrees.push({ sourceDir: plan.sourceDir, worktreePath: plan.worktreePath });
      await runProvisioningGit(
        ['-C', plan.sourceDir, 'worktree', 'add', plan.worktreePath, options.branch],
        `provision worktree ${plan.worktreePath} for repo "${plan.repoId}"`,
      );
    }
  }
}

/**
 * D-281 rollback ordering (reviewer-verified): a live worktree registration
 * blocks both `branch -D` and any retry of the same path, so each worktree is
 * removed (force is safe — nothing user-authored can exist yet), falling back
 * to rm + `worktree prune --expire now` when the registration is broken, and
 * only then are branches created in this call deleted. Reused branches are
 * never in `createdBranches`, so user branches survive every rollback.
 */
export async function rollbackGitBinding(progress, branch) {
  const notes = [];

  for (const worktree of [...progress.worktrees].reverse()) {
    try {
      await execFileAsync(
        'git',
        ['-C', worktree.sourceDir, 'worktree', 'remove', '--force', worktree.worktreePath],
        { timeout: WORKTREE_GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_MAX_BUFFER },
      );
    } catch {
      await rm(worktree.worktreePath, { recursive: true, force: true }).catch(() => {});
      try {
        await execFileAsync(
          'git',
          ['-C', worktree.sourceDir, 'worktree', 'prune', '--expire', 'now'],
          { timeout: QUICK_GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_MAX_BUFFER },
        );
      } catch (error) {
        notes.push(`could not prune worktree registration in ${worktree.sourceDir}: ${describeGitError(error)}`);
      }
    }
  }

  for (const created of [...progress.createdBranches].reverse()) {
    // Ownership was established at record time: the ref-create command
    // succeeded in this call (a same-tip external branch fails the create
    // and is never recorded). The tip check is defense-in-depth — if
    // something moved OUR branch between the create and this rollback,
    // deleting it would destroy work that is no longer in-call state, so it
    // is preserved with a note instead (D-281: delete only in-call refs).
    const tip = await readBranchTip(created.sourceDir, branch);
    if (tip === null) {
      continue;
    }
    if (created.startPoint && tip !== created.startPoint) {
      notes.push(
        `branch "${branch}" in ${created.sourceDir} was left in place: its tip ${tip.slice(0, 12)} does not match the revision this call would have created (${created.startPoint.slice(0, 12)}).`,
      );
      continue;
    }
    try {
      await execFileAsync(
        'git',
        ['-C', created.sourceDir, 'branch', '-D', branch],
        { timeout: QUICK_GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_MAX_BUFFER },
      );
    } catch (error) {
      notes.push(`could not delete branch "${branch}" in ${created.sourceDir}: ${describeGitError(error)}`);
    }
  }

  return notes;
}

/**
 * D-281 close-side guarded removal (S3-3). Recorded clean worktrees are
 * removed by default; everything else survives with actionable guidance.
 * The destructive path is strictly narrower than the creative one:
 * - only paths recorded in session.yaml AND contained in the lane's recorded
 *   container AND covered by a token-matched container marker are removable
 *   (D-279/D-280 guards — arbitrary path removal is refused)
 * - removal is never forced; a status failure counts as unknown, not clean
 * - removal is skipped with guidance when the process cwd sits inside the
 *   target
 * - branches are never deleted at close
 * Recorded-but-missing worktrees are benign crash residue and never block or
 * warn. Returns { attempted, removed, surviving, warnings }; the caller keeps
 * the container marker while any recorded worktree survives.
 */
export async function removeLaneWorktreesAtClose(options) {
  const removed = [];
  const surviving = [];
  const warnings = [];
  const recordedEntries = Object.entries(options.worktrees ?? {});
  if (recordedEntries.length === 0) {
    return { attempted: false, removed, surviving, warnings };
  }

  const manualCommand = ({ repoId, worktreePath }) => {
    const sourceDir = options.worktreeSources?.[repoId];
    return sourceDir
      ? `git -C ${sourceDir} worktree remove ${worktreePath}`
      : `git worktree remove ${worktreePath} (run from repo "${repoId}"'s source checkout)`;
  };
  const keep = (entry, reason, detail) => {
    surviving.push({ repoId: entry.repoId, worktreePath: entry.worktreePath, reason });
    warnings.push(
      `Worktree ${entry.worktreePath} for repo "${entry.repoId}" was left in place: ${detail} Remove it manually: ${manualCommand(entry)}`,
    );
  };

  const existingEntries = [];
  for (const [repoId, worktreePath] of recordedEntries) {
    // A relative recorded path is refused before any probe: the guards here
    // resolve it against the process cwd while `git -C <source>` would
    // resolve it against the source repo, so the validated path and the
    // removed path could differ (D-279: arbitrary path removal is refused).
    if (!path.isAbsolute(worktreePath)) {
      keep({ repoId, worktreePath }, 'not-absolute', 'its recorded path is not absolute, so the guards and the removal command could resolve to different locations (D-279: arbitrary path removal is refused).');
      continue;
    }
    if (await pathExists(worktreePath)) {
      existingEntries.push({ repoId, worktreePath });
    }
  }
  if (existingEntries.length === 0) {
    return { attempted: true, removed, surviving, warnings };
  }

  // Container-level guard, checked once: removal is licensed by the recorded
  // container plus a token-matched container marker (D-280). Any failure here
  // keeps every surviving worktree — an unverifiable container may belong to
  // someone else.
  const containerGuardFailure = await describeContainerGuardFailure(options);
  if (containerGuardFailure) {
    for (const entry of existingEntries) {
      keep(entry, 'container-unverified', `${containerGuardFailure} (D-280/D-281: only marker-verified container contents are removable).`);
    }
    return { attempted: true, removed, surviving, warnings };
  }

  const realContainer = await canonicalizePathReal(options.worktreeContainer);
  const realCwd = await canonicalizePathReal(options.cwd ?? process.cwd());
  for (const entry of existingEntries) {
    const realWorktree = await canonicalizePathReal(entry.worktreePath);
    if (realWorktree === realContainer || !isPathEqualOrInsideReal(realWorktree, realContainer)) {
      keep(entry, 'outside-container', `its recorded path sits outside the lane's worktree container ${options.worktreeContainer} (D-279: arbitrary path removal is refused).`);
      continue;
    }
    if (isPathEqualOrInsideReal(realCwd, realWorktree)) {
      keep(entry, 'cwd-inside', 'the current working directory is inside it (D-281). cd out of the worktree first.');
      continue;
    }

    const cleanliness = await readWorktreeCleanliness(entry.worktreePath);
    if (cleanliness === 'dirty') {
      keep(entry, 'dirty', 'it has uncommitted changes and close-session never forces removal (D-281). Commit or discard them first.');
      continue;
    }
    if (cleanliness === 'unknown') {
      keep(entry, 'status-unknown', 'its cleanliness could not be determined — a status failure counts as unknown, not clean (D-281). Inspect it first.');
      continue;
    }

    const sourceDir = options.worktreeSources?.[entry.repoId];
    if (!sourceDir) {
      keep(entry, 'no-source-recorded', 'the lane recorded no source repository for it, so the removal command cannot be constructed safely.');
      continue;
    }
    try {
      await execFileAsync(
        'git',
        ['-C', sourceDir, 'worktree', 'remove', entry.worktreePath],
        { timeout: WORKTREE_GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_MAX_BUFFER },
      );
      removed.push({ repoId: entry.repoId, worktreePath: entry.worktreePath, sourceDir });
    } catch (error) {
      keep(entry, 'git-refused', `git refused the removal: ${describeGitError(error)}. Resolve that first.`);
    }
  }

  return { attempted: true, removed, surviving, warnings };
}

/**
 * Returns a human-readable reason when the D-280 container guard cannot
 * license removal, or null when the container marker verifies. The marker
 * must live directly in the recorded container and match the lane's recorded
 * token and lane id — a mismatch means the container may not be ours.
 */
async function describeContainerGuardFailure(options) {
  if (!options.worktreeContainer) {
    return 'the lane recorded no worktree container';
  }
  if (!options.recordedMarker?.path || !options.recordedMarker?.token) {
    return 'the lane recorded no container marker to verify ownership against';
  }

  const realContainer = await canonicalizePathReal(options.worktreeContainer);
  const recordedMarkerDir = await canonicalizePathReal(path.dirname(path.resolve(options.recordedMarker.path)));
  if (recordedMarkerDir !== realContainer) {
    return `the recorded marker path ${options.recordedMarker.path} does not sit in the recorded container ${options.worktreeContainer}`;
  }

  let marker;
  try {
    marker = await readLaneMarker(options.recordedMarker.path);
  } catch (error) {
    return `the container marker could not be verified: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (marker.token !== options.recordedMarker.token) {
    return `the container marker at ${options.recordedMarker.path} does not match the lane's recorded token`;
  }
  if (options.laneId && marker.laneId !== options.laneId) {
    return `the container marker at ${options.recordedMarker.path} belongs to lane "${marker.laneId}", not "${options.laneId}"`;
  }

  return null;
}

/**
 * Close-side cleanliness probe. Unlike the start-side dirty warning (which
 * fails open — a probe failure only skips a warning), removal must fail
 * closed: an unreadable status is 'unknown' and the worktree survives.
 * Gitignored files intentionally do NOT count as dirty, matching git's own
 * unforced `worktree remove` semantics — ignored local files (.env, caches)
 * are deleted with the worktree, and treating them as dirty would make
 * every real worktree (node_modules etc.) survive by default.
 */
async function readWorktreeCleanliness(worktreePath) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', worktreePath, 'status', '--porcelain=v1', '--untracked-files=all'],
      { timeout: QUICK_GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_MAX_BUFFER },
    );
    return stdout.trim() === '' ? 'clean' : 'dirty';
  } catch {
    return 'unknown';
  }
}

async function runProvisioningGit(args, description) {
  try {
    await execFileAsync('git', args, { timeout: WORKTREE_GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_MAX_BUFFER });
  } catch (error) {
    throw new Error(`Failed to ${description}: ${describeGitError(error)}`);
  }
}

function describeGitError(error) {
  if (error && typeof error === 'object') {
    if (error.killed || error.signal) {
      return `git was terminated (${error.signal ?? 'timeout'}) — likely the ${WORKTREE_GIT_TIMEOUT_MS / 1000}s provisioning timeout on a large checkout.`;
    }
    if (typeof error.stderr === 'string' && error.stderr.trim() !== '') {
      return error.stderr.trim();
    }
  }

  return error instanceof Error ? error.message : String(error);
}

async function readGitToplevel(repoDir) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoDir, 'rev-parse', '--show-toplevel'],
      { timeout: QUICK_GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_MAX_BUFFER },
    );
    const toplevel = stdout.trim();
    return toplevel === '' ? null : toplevel;
  } catch {
    return null;
  }
}

async function readBranchTip(repoDir, branch) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoDir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
      { timeout: QUICK_GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_MAX_BUFFER },
    );
    const tip = stdout.trim();
    return tip === '' ? null : tip;
  } catch {
    return null;
  }
}

/**
 * Where (if anywhere) a branch is checked out: the porcelain listing's first
 * entry is the main checkout; `bare` and `detached` entries carry no branch
 * line and never match. Matches the full `branch refs/heads/<name>` line —
 * stale registrations still list their branch and still block worktree add.
 */
async function findBranchCheckout(repoDir, branch) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      'git',
      ['-C', repoDir, 'worktree', 'list', '--porcelain'],
      { timeout: QUICK_GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_MAX_BUFFER },
    ));
  } catch (error) {
    throw new Error(`Could not list worktrees for ${repoDir}: ${describeGitError(error)}`);
  }

  let currentPath = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length).trim();
    } else if (line === `branch refs/heads/${branch}`) {
      return currentPath;
    }
  }

  return null;
}

async function isSourceTreeDirty(repoDir) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoDir, 'status', '--porcelain=v1', '--untracked-files=all'],
      { timeout: QUICK_GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_MAX_BUFFER },
    );
    return stdout.trim() !== '';
  } catch {
    return false;
  }
}

/** Realpath-based directory equality — mkdtemp fixtures on macOS live under a /var → /private/var symlink. */
async function isSameDirectoryReal(left, right) {
  return (await canonicalizePathReal(left)) === (await canonicalizePathReal(right));
}

async function canonicalizePathReal(value) {
  try {
    return await realpath(value);
  } catch {
    return path.resolve(value);
  }
}

function isPathEqualOrInsideReal(candidate, parentDir) {
  const relative = path.relative(parentDir, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
