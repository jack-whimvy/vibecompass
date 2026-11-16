import { execFile, spawn } from 'node:child_process';
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

// H3: close-time removal has no kill timeout. Git is the only deleter, and it
// makes every refusal (locked, submodules, modified or untracked files, not a
// worktree of this repo) before it deletes anything; killing it while it
// deletes a large tree (a full node_modules) left a half-deleted checkout that
// the next close saw as modified. A filesystem that stalls makes close wait
// until git finishes or the user interrupts it.
export const WORKTREE_REMOVE_AT_CLOSE_EXEC_OPTIONS = Object.freeze({ maxBuffer: GIT_OUTPUT_MAX_BUFFER });

// D-411 item 1: start-session fetches a bound repo's upstream before it takes
// the memory-root lock, and stops the fetch after this long. Outside the lock,
// a slow remote can't make another lane's command time out waiting for it.
export const UPSTREAM_FETCH_TIMEOUT_MS = 15000;
const FETCH_STDERR_MAX_BYTES = 8192;
// How long start-session waits for git's error output to close once git has
// exited (D-413 item 3).
const EXIT_GRACE_MS = 1000;

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
 * D-411 item 1: the checked-out branch's upstream as git records it, or null
 * when HEAD is detached or the branch has no upstream (a repo with no remote
 * included). `trackingRef` is where the upstream's tip is kept locally:
 * `refs/remotes/<remote>/<branch>` for a remote, `refs/heads/<branch>` for an
 * upstream on a local branch (remote `.`).
 */
export async function readBranchUpstream(repoDir) {
  let headRef;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoDir, 'symbolic-ref', '--quiet', 'HEAD'],
      { timeout: QUICK_GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_MAX_BUFFER },
    );
    headRef = stdout.trim();
  } catch {
    return null;
  }
  if (!headRef.startsWith('refs/heads/')) {
    return null;
  }

  const branch = headRef.slice('refs/heads/'.length);
  const remote = await readGitConfigValue(repoDir, `branch.${branch}.remote`);
  const mergeRef = await readGitConfigValue(repoDir, `branch.${branch}.merge`);
  if (!remote || !mergeRef) {
    return null;
  }

  let trackingRef = '';
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoDir, 'for-each-ref', '--format=%(upstream)', headRef],
      { timeout: QUICK_GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_MAX_BUFFER },
    );
    trackingRef = stdout.trim().split('\n')[0] ?? '';
  } catch {
    return null;
  }
  if (!trackingRef) {
    return null;
  }

  return { branch, remote, mergeRef, trackingRef, local: remote === '.' };
}

/**
 * D-411 item 1, as amended by D-413 and D-414: fetch one upstream ref into
 * its remote-tracking ref and nothing else. The empty --refmap stops the
 * remote's configured fetch mappings from updating any other ref (a local
 * branch included); the other options stop pruning, tags, submodules, remote
 * HEAD updates, automatic maintenance, a configured commit-graph write, and a
 * configured bundle URI's downloads (bundle refs, temporary files, and a
 * creation-token line in .git/config). A symbolic tracking ref is never a
 * destination, since git would write through it to its target. What git
 * itself writes for this fetch, whatever settings are on: fetched objects,
 * that one tracking ref (and its reflog where reflogs are on), and FETCH_HEAD.
 * The programs and outputs the user configured for git (credential helpers,
 * an SSH command, hooks, trace output, a cookie file) run and write as on any
 * fetch, wherever they write, .git included; they are outside that budget
 * (D-415). Never throws: returns
 * `fetched`; `skipped` (nothing to fetch, or not a ref under refs/remotes/);
 * `symbolic` with the ref it points at; `not-on-windows`; or `failed` with
 * git's first line of error.
 */
export async function fetchBranchUpstream(repoDir, upstream, options = {}) {
  if (!upstream || upstream.local) {
    return { status: 'skipped' };
  }
  if (!upstream.trackingRef.startsWith('refs/remotes/') || !upstream.mergeRef.startsWith('refs/')) {
    return { status: 'skipped' };
  }
  // D-413 item 4: no process group on Windows to stop git's descendants at the
  // limit, so start-session compares with the upstream as last fetched there.
  if ((options.platform ?? process.platform) === 'win32') {
    return { status: 'not-on-windows' };
  }
  // D-413 item 2: git follows a symbolic destination to its target.
  const symbolicTarget = await readSymbolicRefTarget(repoDir, upstream.trackingRef);
  if (symbolicTarget) {
    return { status: 'symbolic', target: symbolicTarget };
  }

  const timeoutMs = options.timeoutMs ?? UPSTREAM_FETCH_TIMEOUT_MS;
  const sshOverride = await hasCustomSshCommand(repoDir)
    ? []
    // No SSH command of the user's own: authentication and host-key questions
    // fail at once instead of asking.
    : ['-c', 'core.sshCommand=ssh -o BatchMode=yes'];
  const result = await runNonInteractiveGit([
    '-C', repoDir,
    '-c', `remote.${upstream.remote}.followRemoteHEAD=never`,
    // D-414 item 1: empty turns bundle downloads off for this command only;
    // the user's saved bundle settings stay as they are.
    '-c', 'fetch.bundleURI=',
    ...sshOverride,
    'fetch', '--quiet', '--refmap=', '--no-prune', '--no-prune-tags', '--no-tags',
    '--no-recurse-submodules', '--no-auto-gc', '--no-write-commit-graph',
    upstream.remote,
    `+${upstream.mergeRef}:${upstream.trackingRef}`,
  ], { timeoutMs });

  if (result.ok) {
    return { status: 'fetched' };
  }
  return {
    status: 'failed',
    reason: result.timedOut
      ? `no answer within ${describeSeconds(timeoutMs)}`
      : firstErrorLine(result.stderr) ?? `git exited with ${result.code ?? result.signal}`,
  };
}

/**
 * D-411 item 1, before the memory-root lock: fetch each bound repo's upstream
 * that a new branch could start from. A repo whose branch already exists
 * (reuse mode) fetches nothing. Never throws; a repo that isn't a git
 * repository root, or has no upstream, is left out.
 */
export async function refreshUpstreamsForBinding(options) {
  const entries = await Promise.all((options.repoIds ?? []).map(async (repoId) => {
    try {
      const sourceDir = resolveRepoSourceDir(options.workspaceDir, repoId, options.projectRepos);
      const toplevel = await readGitToplevel(sourceDir);
      if (!toplevel || !(await isSameDirectoryReal(toplevel, sourceDir))) {
        return null;
      }
      if (options.branch && (await readBranchTip(sourceDir, options.branch))) {
        return [repoId, { status: 'skipped' }];
      }
      const upstream = await readBranchUpstream(sourceDir);
      if (!upstream) {
        return null;
      }
      return [repoId, await fetchBranchUpstream(sourceDir, upstream, { timeoutMs: options.timeoutMs, platform: options.platform })];
    } catch (error) {
      return [repoId, { status: 'failed', reason: error instanceof Error ? error.message : String(error) }];
    }
  }));

  return Object.fromEntries(entries.filter(Boolean));
}

/**
 * D-411 item 1, inside the lock: where a new lane branch starts, from what
 * git holds now. HEAD when it is detached, has no upstream, or equals the
 * upstream's tip; the upstream's tip when HEAD is strictly behind it; HEAD,
 * with a message, when HEAD is ahead or the two have diverged. A failed fetch
 * compares with the upstream as last fetched and says so.
 */
export async function chooseLaneStartPoint(options) {
  const { repoId, sourceDir, headRevision, fetchOutcome } = options;
  const upstream = await readBranchUpstream(sourceDir);
  if (!upstream) {
    return { startPoint: headRevision, warnings: [] };
  }

  const warnings = [];
  const upstreamName = displayRefName(upstream.trackingRef);
  const localName = `local ${upstream.branch}`;
  const atHead = `the lane branch starts at ${localName} (${headRevision.slice(0, 12)})`;
  const upstreamTip = await resolveCommitRevision(sourceDir, upstream.trackingRef);
  const notFetched = describeNotFetched(fetchOutcome, upstream, upstreamName);
  if (notFetched) {
    warnings.push(
      upstreamTip
        ? `Repo "${repoId}": ${notFetched.reason}; ${notFetched.comparing}.`
        : `Repo "${repoId}": ${notFetched.reason}, and there is no copy of ${upstreamName} to compare, so ${atHead}.`,
    );
  }
  if (!upstreamTip || upstreamTip === headRevision) {
    return { startPoint: headRevision, warnings };
  }

  const headIsBehind = await isAncestorRevision(sourceDir, headRevision, upstreamTip);
  const headIsAhead = headIsBehind ? false : await isAncestorRevision(sourceDir, upstreamTip, headRevision);
  if (headIsBehind === true) {
    const behind = await countCommits(sourceDir, headRevision, upstreamTip);
    warnings.push(
      `Repo "${repoId}": ${localName} is ${describeCommitCount(behind)} behind ${upstreamName}, so the lane branch starts at ${upstreamName} (${upstreamTip.slice(0, 12)}). ${capitalize(localName)} was left unchanged.`,
    );
    return { startPoint: upstreamTip, warnings };
  }
  if (headIsAhead === true) {
    const ahead = await countCommits(sourceDir, upstreamTip, headRevision);
    warnings.push(
      `Repo "${repoId}": ${localName} is ${describeCommitCount(ahead)} ahead of ${upstreamName}; ${atHead} and includes ${ahead === 1 ? 'it' : 'them'}.`,
    );
    return { startPoint: headRevision, warnings };
  }
  if (headIsBehind === false && headIsAhead === false) {
    const onlyLocal = await countCommits(sourceDir, upstreamTip, headRevision);
    const onlyUpstream = await countCommits(sourceDir, headRevision, upstreamTip);
    warnings.push(
      `Repo "${repoId}": ${localName} and ${upstreamName} have diverged (${describeCommitCount(onlyLocal)} only on ${localName}, ${describeCommitCount(onlyUpstream)} only on ${upstreamName}); ${atHead}. If the lane should include ${upstreamName}'s commits, reconcile ${upstream.branch} and fast-forward the lane branch before any edit.`,
    );
    return { startPoint: headRevision, warnings };
  }

  warnings.push(`Repo "${repoId}": could not compare ${localName} with ${upstreamName}; ${atHead}.`);
  return { startPoint: headRevision, warnings };
}

// Why the upstream wasn't fetched, when that changes what the comparison means.
function describeNotFetched(fetchOutcome, upstream, upstreamName) {
  switch (fetchOutcome?.status) {
    case 'failed':
      return {
        reason: `could not reach ${upstream.remote} to update ${upstreamName} (${fetchOutcome.reason})`,
        comparing: `comparing with ${upstreamName} as last fetched`,
      };
    case 'symbolic':
      // D-413 item 2
      return {
        reason: `${upstreamName} is a symbolic ref to ${fetchOutcome.target}, so start-session didn't fetch into it`,
        comparing: `comparing with ${upstreamName} as it stands`,
      };
    case 'not-on-windows':
      // D-413 item 4
      return {
        reason: `start-session doesn't fetch on Windows (run \`git fetch\` first to start the lane from the remote's latest)`,
        comparing: `comparing with ${upstreamName} as last fetched`,
      };
    default:
      return null;
  }
}

async function readSymbolicRefTarget(repoDir, ref) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoDir, 'symbolic-ref', '--quiet', ref],
      { timeout: QUICK_GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_MAX_BUFFER },
    );
    const target = stdout.trim();
    return target === '' ? null : target;
  } catch {
    return null;
  }
}

/**
 * Whether `ancestor` is an ancestor of (or equal to) `descendant` in the repo:
 * true, false, or null when git can't tell (an unknown revision).
 */
export async function isAncestorRevision(repoDir, ancestor, descendant) {
  try {
    await execFileAsync(
      'git',
      ['-C', repoDir, 'merge-base', '--is-ancestor', ancestor, descendant],
      { timeout: QUICK_GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_MAX_BUFFER },
    );
    return true;
  } catch (error) {
    return error && typeof error === 'object' && error.code === 1 ? false : null;
  }
}

async function resolveCommitRevision(repoDir, ref) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoDir, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      { timeout: QUICK_GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_MAX_BUFFER },
    );
    const revision = stdout.trim();
    return revision === '' ? null : revision;
  } catch {
    return null;
  }
}

async function countCommits(repoDir, from, to) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoDir, 'rev-list', '--count', `${from}..${to}`],
      { timeout: QUICK_GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_MAX_BUFFER },
    );
    const count = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

async function readGitConfigValue(repoDir, key) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoDir, 'config', '--get', key],
      { timeout: QUICK_GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_MAX_BUFFER },
    );
    const value = stdout.trim();
    return value === '' ? null : value;
  } catch {
    return null;
  }
}

async function hasCustomSshCommand(repoDir) {
  if (normalizeEnvValue(process.env.GIT_SSH_COMMAND) || normalizeEnvValue(process.env.GIT_SSH)) {
    return true;
  }
  return (await readGitConfigValue(repoDir, 'core.sshCommand')) !== null;
}

/**
 * D-411 item 1: the fetch can't ask anything. It runs with no input and, off
 * Windows, in its own session (setsid), so it has no controlling terminal; Git's
 * terminal prompts are off; empty GIT_ASKPASS and SSH_ASKPASS turn off every
 * askpass program, core.askPass included; OpenSSH is told never to use one;
 * and Git Credential Manager is told not to interact. Credential helpers still
 * run, since stored credentials are what reach a private remote. On timeout the
 * whole process group is killed.
 */
export function buildNonInteractiveGitEnv(baseEnv = process.env) {
  return {
    ...baseEnv,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    SSH_ASKPASS_REQUIRE: 'never',
    GCM_INTERACTIVE: 'never',
  };
}

function runNonInteractiveGit(args, options) {
  return new Promise((resolve) => {
    const ownSession = process.platform !== 'win32';
    let child;
    try {
      child = spawn('git', args, {
        detached: ownSession,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: buildNonInteractiveGitEnv(),
        windowsHide: true,
      });
    } catch (error) {
      resolve({ ok: false, code: null, signal: null, timedOut: false, stderr: error instanceof Error ? error.message : String(error) });
      return;
    }

    let stderr = '';
    let timedOut = false;
    let settled = false;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length < FETCH_STDERR_MAX_BYTES) {
        stderr += chunk.slice(0, FETCH_STDERR_MAX_BYTES - stderr.length);
      }
    });
    let graceTimer = null;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (ownSession) {
          process.kill(-child.pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        // Already gone.
      }
      // Never wait past a short grace after the kill, even if no exit comes.
      graceTimer = setTimeout(() => {
        child.stderr.destroy();
        finish({ ok: false, code: null, signal: 'SIGKILL', timedOut, stderr });
      }, EXIT_GRACE_MS);
    }, options.timeoutMs);
    child.on('error', (error) => {
      finish({ ok: false, code: null, signal: null, timedOut, stderr: stderr || (error instanceof Error ? error.message : String(error)) });
    });
    // D-413 item 3: once git has exited, go on. After a kill, at once; after a
    // normal exit, as soon as its error output closes, or after a short grace
    // when a process that left the group still holds that output open.
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(graceTimer);
      if (timedOut) {
        child.stderr.destroy();
        finish({ ok: false, code, signal, timedOut, stderr });
        return;
      }
      graceTimer = setTimeout(() => {
        child.stderr.destroy();
        finish({ ok: code === 0, code, signal, timedOut, stderr });
      }, EXIT_GRACE_MS);
    });
    child.on('close', (code, signal) => {
      finish({ ok: code === 0 && !timedOut, code, signal, timedOut, stderr });
    });
  });
}

function firstErrorLine(stderr) {
  const line = (stderr ?? '').split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry !== '');
  if (!line) {
    return null;
  }
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

function displayRefName(ref) {
  if (ref.startsWith('refs/remotes/')) {
    return ref.slice('refs/remotes/'.length);
  }
  if (ref.startsWith('refs/heads/')) {
    return ref.slice('refs/heads/'.length);
  }
  return ref;
}

function describeCommitCount(count) {
  if (count === null || count === undefined) {
    return 'some commits';
  }
  return `${count} commit${count === 1 ? '' : 's'}`;
}

function describeSeconds(milliseconds) {
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function normalizeEnvValue(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
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
          'The <workspace>/worktrees container must live outside every repository. Run without --worktree, or pass --root pointing at a shared memory root whose parent is not a repository.', // D-279, D-281
      );
    }

    await assertMarkerTargetDisjoint(options.containerDir, options.rootDir);
    if (await pathExists(options.containerDir)) {
      throw new Error(
        `Cannot provision worktrees: ${options.containerDir} already exists. Remove it or close the lane that owns it first (provisioning never adopts existing paths).`, // D-279
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
        `Cannot git-bind repo "${repoId}": the project-memory root ${options.rootDir} sits inside its work tree at ${sourceDir}, so a per-lane worktree would fork shared memory. ` + // D-266
          'Run without --branch/--worktree, or pass --root pointing at this project\'s initialized shared memory root outside the repository. ' +
          '(An untracked .compass inside the repository is refused conservatively as well.)',
      );
    }
    if (isPathEqualOrInsideReal(realTop, realRoot)) {
      throw new Error(
        `Cannot git-bind repo "${repoId}": its work tree ${sourceDir} sits inside the project-memory root ${options.rootDir} — code never lives in package memory.`, // D-278
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

    // D-411 item 1: a created branch starts at HEAD, or at the upstream's tip
    // when HEAD is strictly behind it; reuse mode never moves the branch.
    let startPoint = head.revision;
    if (mode === 'create') {
      const choice = await chooseLaneStartPoint({
        repoId,
        sourceDir,
        headRevision: head.revision,
        fetchOutcome: options.upstreamFetches?.[repoId] ?? null,
      });
      startPoint = choice.startPoint;
      warnings.push(...choice.warnings);
    }

    repoPlans.push({
      repoId,
      sourceDir,
      mode,
      // Reuse mode bases the lane on what actually gets checked out — the
      // existing branch tip — and create mode on the start point.
      baseRevision: branchTip ?? startPoint,
      startPoint,
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
      `Active lane "${lane.id}" binds branch "${lane.branch}" in shared repo(s) ${sharedRepos.join(', ')}; diverging branches on the same repo reconcile through normal git merge.`, // D-266
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
 * - git is the only deleter and runs without a kill timeout (H3), so its own
 *   refusals (lock, submodules, registration) come before any deletion and a
 *   large ignored tree is never left half-deleted by a timer
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
      keep({ repoId, worktreePath }, 'not-absolute', 'its recorded path is not absolute, so the guards and the removal command could resolve to different locations (arbitrary path removal is refused).'); // D-279
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
      keep(entry, 'container-unverified', `${containerGuardFailure} (only marker-verified container contents are removable).`); // D-280, D-281
    }
    return { attempted: true, removed, surviving, warnings };
  }

  const realContainer = await canonicalizePathReal(options.worktreeContainer);
  const realCwd = await canonicalizePathReal(options.cwd ?? process.cwd());
  for (const entry of existingEntries) {
    const realWorktree = await canonicalizePathReal(entry.worktreePath);
    if (realWorktree === realContainer || !isPathEqualOrInsideReal(realWorktree, realContainer)) {
      keep(entry, 'outside-container', `its recorded path sits outside the lane's worktree container ${options.worktreeContainer} (arbitrary path removal is refused).`); // D-279
      continue;
    }
    if (isPathEqualOrInsideReal(realCwd, realWorktree)) {
      keep(entry, 'cwd-inside', 'the current working directory is inside it. cd out of the worktree first.'); // D-281
      continue;
    }

    const cleanliness = await readWorktreeCleanliness(entry.worktreePath);
    if (cleanliness === 'dirty') {
      keep(entry, 'dirty', 'it has uncommitted changes and close-session never forces removal. Commit or discard them first.'); // D-281
      continue;
    }
    if (cleanliness === 'unknown') {
      keep(entry, 'status-unknown', 'its cleanliness could not be determined — a status failure counts as unknown, not clean. Inspect it first.'); // D-281
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
        WORKTREE_REMOVE_AT_CLOSE_EXEC_OPTIONS,
      );
      removed.push({ repoId: entry.repoId, worktreePath: entry.worktreePath, sourceDir });
    } catch (error) {
      if (error && typeof error === 'object' && error.signal) {
        // No timer kills this call (H3), so a signal is an outside
        // interruption, possibly mid-delete.
        keep(entry, 'git-interrupted', `git was interrupted (${error.signal}) while removing it, so the checkout may be partly deleted. Inspect it before removing it.`);
        continue;
      }
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
