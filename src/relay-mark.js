import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, readlink, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BUILDER_TO_REVIEWER_HEADING,
  REVIEW_LOG_HEADING,
  fingerprintSection,
  sha256Hex,
} from './relay-sections.js';
import { extractReviewLogLines, parseReviewLog } from './review-log.js';

// D-419 item 4: the ready-for-review mark. The builder runs
// `vibecompass ready-for-review` when a round's work is ready; the mark holds
// three fingerprints (handoff, record, work) and the round id they make, and,
// when the builder is a Claude Code conversation, its id. The relay compares
// the fingerprints when it starts a pass and again before it records one.

export const READY_FILE = 'ready.json';
export const RELAY_STATE_FILE = 'relay.json';
export const RELAY_LOCK_FILE = 'relay.lock';
export const RELAY_TURN_DIR = 'relay-turns';
// Never part of the work, even when named: the builder's log and the relay's
// own files (D-419 item 4).
export const LANE_OWN_FILES = new Set(['wip.md', 'handoff.md', READY_FILE, RELAY_STATE_FILE, RELAY_LOCK_FILE]);
// The memory root's local-only paths, which a named directory never covers.
const ROOT_LOCAL_ONLY_PREFIXES = ['state/', 'sessions/active/'];
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MARK_FORMAT = 1;

// Git's repository-location variables: the relay's reads are about the
// repository at the folder each runs in, never one the environment names.
const GIT_LOCATION_VARIABLES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES'];

/**
 * The git environment for the relay's own reads: no optional index writes, no
 * prompt, no fetch of a missing object, and no repository the environment
 * names. Discovery crosses filesystems, as the relay's own search for a
 * `.git` does (D-423 item 3).
 */
export function readOnlyGitEnv(baseEnv = process.env) {
  const env = { ...baseEnv, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_DISCOVERY_ACROSS_FILESYSTEM: '1' };
  for (const name of GIT_LOCATION_VARIABLES) delete env[name];
  return env;
}

// The relay's own git reads run on the host, outside any reviewer sandbox, so
// none of them may start a program a repository's configuration names
// (D-423). The filesystem monitor and hooks are turned off on the command
// line, which no configuration overrides, and so is every transport, so a
// read that needs an object a partial clone lacks fails instead of fetching
// it. No read runs a working file through a filter: the work fingerprint
// reads working files itself, and the staged diff compares stored objects,
// with --no-ext-diff and --no-textconv.
const HELPERS_OFF = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never'];
const STAGED_DIFF = ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=dirty'];
const MAX_SUBMODULE_DEPTH = 8;

function spawnGit(args, cwd, env, onStdout) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', [...HELPERS_OFF, ...args], { cwd, env: readOnlyGitEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: null, stderr: String(error?.message ?? error) });
      return;
    }
    let stderr = '';
    child.stdout.on('data', onStdout);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += chunk;
    });
    child.on('error', (error) => resolve({ code: null, stderr: String(error?.message ?? error) }));
    child.on('close', (code) => resolve({ code, stderr: stderr.trim() }));
  });
}

/**
 * Runs git, with the repository's helpers and fetching off, and hashes its
 * standard output as it streams, so a large diff never sits in memory.
 * Resolves `{ ok, code, hash, bytes, stderr }`.
 */
export async function gitHash(args, cwd, env = process.env) {
  const hash = createHash('sha256');
  let bytes = 0;
  const result = await spawnGit(args, cwd, env, (chunk) => {
    bytes += chunk.length;
    hash.update(chunk);
  });
  return { ok: result.code === 0, code: result.code, hash: result.code === null ? null : hash.digest('hex'), bytes, stderr: result.stderr };
}

/** Runs git, with the repository's helpers and fetching off, and returns its output as text. */
export async function gitText(args, cwd, env = process.env) {
  const out = [];
  const result = await spawnGit(args, cwd, env, (chunk) => out.push(chunk));
  return { ok: result.code === 0, code: result.code, stdout: result.code === null ? '' : Buffer.concat(out).toString('utf8'), stderr: result.stderr };
}

/** The nearest folder at or above `dir` that holds a `.git`, or null. */
async function folderHoldingGit(dir) {
  let current = path.resolve(dir);
  for (;;) {
    try {
      await lstat(path.join(current, '.git'));
      return current;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * The top level of the repository `dir` is in, or null when no folder at or
 * above it holds a `.git`. Inside a repository a git error throws, so a
 * repository's folder is never read as plain files (D-423 item 3).
 */
export async function repositoryTopLevel(dir, env = process.env) {
  const result = await gitText(['rev-parse', '--show-toplevel'], dir, env);
  if (result.ok) return result.stdout.trim();
  const holder = await folderHoldingGit(dir);
  if (holder === null) return null;
  throw new Error(`git couldn't read the repository at ${holder} (${result.stderr || (result.code === null ? 'git didn\'t start' : `git exited ${result.code}`)}), so the relay doesn't read ${dir} as plain files.`);
}

async function hashStream(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

/** A file's content hash, a symbolic link's target, or what else is there; never a read of a pipe. */
async function hashFile(filePath) {
  const info = await lstat(filePath);
  if (info.isSymbolicLink()) {
    return sha256Hex(`symlink:${await readlink(filePath)}`);
  }
  if (!info.isFile()) return sha256Hex(info.isDirectory() ? 'directory:' : 'special:');
  return hashStream(filePath);
}

/**
 * What is at an index entry's path in the working tree (D-423 item 1): a
 * regular file's bytes and executable bit, a symbolic link's target, or that
 * it is missing, a directory, or something else.
 */
async function workingState(filePath) {
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return 'missing';
    throw error;
  }
  if (info.isSymbolicLink()) return `symlink ${sha256Hex(await readlink(filePath))}`;
  if (info.isDirectory()) return 'directory';
  if (!info.isFile()) return 'special';
  return `file ${(info.mode & 0o111) !== 0 ? 'x' : '-'} ${await hashStream(filePath)}`;
}

/** Whether a folder holds a checkout of its own: a `.git` file or folder. */
async function holdsCheckout(dir) {
  try {
    await lstat(path.join(dir, '.git'));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

/**
 * One checkout's entries for the work fingerprint (D-419 item 4, D-423): its
 * HEAD, a hash of its staged diff, a hash of its index entries with what is at
 * each path in the working tree, where a checked-out submodule gives its own
 * fingerprint, and each untracked, not-ignored file. No git command here
 * reads a working file through a filter.
 */
async function fingerprintCheckout(dir, label, env, depth = 0) {
  const head = await gitText(['rev-parse', '--verify', 'HEAD'], dir, env);
  if (!head.ok) {
    throw new Error(`${label} at ${dir} isn't a readable git checkout (${head.stderr || 'git rev-parse HEAD failed'}).`);
  }
  const headSha = head.stdout.trim();
  const staged = await gitHash(STAGED_DIFF, dir, env);
  if (!staged.ok) {
    throw new Error(`git diff --cached failed in ${label} at ${dir}: ${staged.stderr}`);
  }
  const index = await gitText(['ls-files', '--stage', '-z'], dir, env);
  if (!index.ok) {
    throw new Error(`git ls-files --stage failed in ${label} at ${dir}: ${index.stderr}`);
  }
  const working = createHash('sha256');
  let submodules = 0;
  for (const record of splitNul(index.stdout)) {
    const tab = record.indexOf('\t');
    const [mode, oid, stage] = record.slice(0, tab).split(' ');
    const relative = record.slice(tab + 1);
    const full = path.join(dir, relative);
    let state;
    if (mode === '160000' && (await pathKind(full)) === 'directory' && (await holdsCheckout(full))) {
      if (depth + 1 > MAX_SUBMODULE_DEPTH) {
        throw new Error(`${label} nests checked-out submodules deeper than ${MAX_SUBMODULE_DEPTH} at ${full}; the relay doesn't fingerprint work that deep.`); // D-423 item 2
      }
      const inner = await fingerprintCheckout(full, `submodule ${relative} of ${label}`, env, depth + 1);
      submodules += 1 + inner.submodules;
      state = `submodule ${inner.fingerprint}`;
    } else if (mode === '160000') {
      state = (await pathKind(full)) === 'directory' ? 'submodule not checked out' : await workingState(full);
    } else {
      state = await workingState(full);
    }
    working.update(`${relative}\0${mode}\0${oid}\0${stage}\0${state}\n`);
  }
  const untracked = await gitText(['ls-files', '--others', '--exclude-standard', '-z'], dir, env);
  if (!untracked.ok) {
    throw new Error(`git ls-files failed in ${label} at ${dir}: ${untracked.stderr}`);
  }
  const untrackedFiles = splitNul(untracked.stdout).sort();
  const entries = [`head\t${headSha}`, `staged\t${staged.hash}`, `working\t${working.digest('hex')}`];
  for (const relative of untrackedFiles) {
    if (relative.endsWith('/')) {
      // git lists a repository inside the worktree that isn't a submodule as
      // a folder and doesn't look inside it.
      throw new Error(`${label} at ${dir} holds a git repository that isn't a submodule (${relative}); the relay can't tell when its work changes. Add it as a submodule, ignore it, or move it out.`);
    }
    entries.push(`untracked\t${relative}\t${await hashFile(path.join(dir, relative))}`);
  }
  entries.sort();
  return { head: headSha, entries, untracked: untrackedFiles.length, submodules, fingerprint: sha256Hex(entries.join('\n')) };
}

async function pathKind(filePath) {
  try {
    const info = await lstat(filePath);
    if (info.isDirectory()) return 'directory';
    return 'file';
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return 'missing';
    throw error;
  }
}

function splitNul(text) {
  return text.split('\0').filter((item) => item !== '');
}

async function walkFiles(dir) {
  const files = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else {
        files.push(full);
      }
    }
  }
  return files;
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Resolves a `--path` value: `<repo-id>:<path>` for a repository in
 * project.yaml, else a path relative to the memory root. Repositories resolve
 * as `## Involved files` lines do: the lane's worktree for that repository if
 * it has one, else the checkout beside the memory root.
 */
export function resolveMarkPath(spec, { rootDir, projectRepos = [], worktrees = {} }) {
  const trimmed = String(spec ?? '').trim();
  if (!trimmed) {
    throw new Error('ready-for-review --path needs a value: <repo-id>:<path> or a path relative to the memory root.');
  }
  const colon = trimmed.indexOf(':');
  if (colon > 0 && !/^[A-Za-z]:[\\/]/.test(trimmed)) {
    const repoId = trimmed.slice(0, colon);
    const repo = projectRepos.find((item) => item && typeof item === 'object' && item.id === repoId);
    if (repo) {
      const relative = trimmed.slice(colon + 1).replace(/^\/+/, '');
      const base = worktrees[repoId]
        ? path.resolve(worktrees[repoId])
        : path.resolve(path.dirname(rootDir), typeof repo.path === 'string' && repo.path.trim() ? repo.path : repoId);
      const absolute = path.resolve(base, relative || '.');
      if (!isInside(absolute, base)) {
        throw new Error(`ready-for-review --path ${trimmed} points outside repository ${repoId}.`);
      }
      return { spec: `${repoId}:${toPosix(path.relative(base, absolute)) || '.'}`, absolute, repoId, base };
    }
  }
  const absolute = path.resolve(rootDir, trimmed);
  if (!isInside(absolute, rootDir)) {
    throw new Error(`ready-for-review --path ${trimmed} is outside the memory root; name a repository file as <repo-id>:<path>.`);
  }
  return { spec: toPosix(path.relative(rootDir, absolute)) || '.', absolute, repoId: null, base: rootDir };
}

function rootRelative(absolute, rootDir) {
  return isInside(absolute, rootDir) ? toPosix(path.relative(rootDir, absolute)) : null;
}

function isRootLocalOnly(absolute, rootDir) {
  const relative = rootRelative(absolute, rootDir);
  if (relative === null) return false;
  const withSlash = `${relative}/`;
  return ROOT_LOCAL_ONLY_PREFIXES.some((prefix) => withSlash.startsWith(prefix));
}

function isLaneOwnFile(absolute, laneDir) {
  return path.dirname(absolute) === laneDir && LANE_OWN_FILES.has(path.basename(absolute));
}

/**
 * The work fingerprint (D-419 item 4, D-423): SHA-256 over sorted entries from
 * each recorded worktree (its HEAD, a hash of the staged diff, a hash of its
 * index entries with their working files and checked-out submodules, and each
 * untracked, not-ignored file) and each named path.
 */
export async function fingerprintWork({ rootDir, laneDir, worktrees = {}, paths = [], projectRepos = [], env = process.env, marking = false }) {
  const entries = [];
  const covers = { worktrees: [], paths: [] };
  const notes = [];

  for (const repoId of Object.keys(worktrees).sort()) {
    const dir = path.resolve(worktrees[repoId]);
    const checkout = await fingerprintCheckout(dir, `Lane worktree ${repoId}`, env);
    for (const entry of checkout.entries) entries.push(`worktree\t${repoId}\t${entry}`);
    covers.worktrees.push({ repo: repoId, path: dir, head: checkout.head, untracked: checkout.untracked, ...(checkout.submodules > 0 ? { submodules: checkout.submodules } : {}) });
  }

  const seen = new Set();
  for (const raw of paths) {
    const resolved = resolveMarkPath(raw, { rootDir, projectRepos, worktrees });
    if (seen.has(resolved.absolute)) continue;
    seen.add(resolved.absolute);
    if (isLaneOwnFile(resolved.absolute, laneDir)) {
      notes.push(`${resolved.spec} is the lane's own file and is never part of the work.`);
      covers.paths.push({ spec: resolved.spec, kind: 'lane file', covered: 0 });
      continue;
    }
    const kind = await pathKind(resolved.absolute);
    if (kind === 'missing') {
      entries.push(`path\t${resolved.spec}\tmissing`);
      covers.paths.push({ spec: resolved.spec, kind: 'missing', covered: 1 });
      continue;
    }
    if (kind === 'file') {
      entries.push(`path\t${resolved.spec}\tfile\t${await hashFile(resolved.absolute)}`);
      covers.paths.push({ spec: resolved.spec, kind: 'file', covered: 1 });
      continue;
    }
    const listing = await listDirectoryFiles(resolved.absolute, { rootDir, laneDir, env });
    if (listing.files.length === 0) {
      // Marking refuses a directory with nothing to cover. Comparing against a
      // mark, a directory that lost its last file is changed work, never an
      // error that would stop recovery from recording an end state.
      if (marking) {
        throw new Error(`ready-for-review --path ${resolved.spec} covers no files${listing.ignored > 0 ? ` (${listing.ignored} ignored left out)` : ''}; name the files instead.`); // D-419 item 4
      }
      entries.push(`path\t${resolved.spec}\tempty directory`);
      covers.paths.push({ spec: resolved.spec, kind: 'directory', covered: 0, ignored: listing.ignored, git: listing.git });
      continue;
    }
    for (const file of listing.files) {
      const relative = toPosix(path.relative(resolved.absolute, file));
      const fileKind = await pathKind(file);
      // A tracked file deleted in the working tree is still listed: it counts
      // as missing. A listed folder is a submodule: checked out, it gives its
      // own fingerprint (D-423 item 2).
      if (fileKind === 'missing') {
        entries.push(`path\t${resolved.spec}\tmissing\t${relative}`);
      } else if (fileKind === 'directory') {
        entries.push((await holdsCheckout(file))
          ? `path\t${resolved.spec}\tsubmodule\t${relative}\t${(await fingerprintCheckout(file, `submodule ${relative} under ${resolved.spec}`, env, 1)).fingerprint}`
          : `path\t${resolved.spec}\tsubmodule not checked out\t${relative}`);
      } else {
        entries.push(`path\t${resolved.spec}\tfile\t${relative}\t${await hashFile(file)}`);
      }
    }
    covers.paths.push({ spec: resolved.spec, kind: 'directory', covered: listing.files.length, ignored: listing.ignored, git: listing.git });
  }

  entries.sort();
  return { fingerprint: sha256Hex(entries.join('\n')), entries, covers, notes };
}

/**
 * A named directory's files: in a git repository the tracked files and the
 * untracked ones git doesn't ignore; elsewhere every file. Never the memory
 * root's state/ or sessions/active/, and never the lane's own files.
 */
async function listDirectoryFiles(dir, { rootDir, laneDir, env }) {
  // Walked as plain files only outside every repository (D-423 item 3).
  const top = await repositoryTopLevel(dir, env);
  let files;
  let ignored = 0;
  if (top) {
    // Git names its top level by the physical path; the named directory may
    // be reached through a symlink. Both are resolved before the relative
    // path is taken, and git's listing is mapped back under the path as
    // named, so the exclusions below compare like with like.
    const physicalTop = await realpath(top);
    const physicalDir = await realpath(dir);
    const relative = toPosix(path.relative(physicalTop, physicalDir)) || '.';
    const listed = await gitText(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', relative], top, env);
    if (!listed.ok) {
      throw new Error(`git ls-files failed for ${dir}: ${listed.stderr}`);
    }
    files = [...new Set(splitNul(listed.stdout))].map((item) => path.join(dir, path.relative(physicalDir, path.join(physicalTop, item))));
    // Every ignored file is counted: without --directory, git lists the files
    // inside a wholly ignored directory instead of one entry for it.
    const ignoredListing = await gitText(['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', relative], top, env);
    if (!ignoredListing.ok) {
      throw new Error(`git ls-files failed for ${dir}: ${ignoredListing.stderr}`);
    }
    ignored = splitNul(ignoredListing.stdout).length;
  } else {
    files = await walkFiles(dir);
  }
  const kept = [];
  for (const file of files) {
    if (isRootLocalOnly(file, rootDir) || isLaneOwnFile(file, laneDir)) {
      continue;
    }
    kept.push(file);
  }
  return { files: kept.sort(), ignored, git: Boolean(top) };
}

/** The round id: SHA-256 of the three fingerprints (D-419 item 4). */
export function computeRoundId({ handoff, record, work }) {
  return sha256Hex(`handoff ${handoff}\nrecord ${record}\nwork ${work}`);
}

export function shortRound(roundId) {
  return String(roundId ?? '').slice(0, 12);
}

/** The handoff and record fingerprints from the lane's two files. */
export async function fingerprintLaneFiles(laneDir) {
  const handoff = await readFile(path.join(laneDir, 'handoff.md'), 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return '';
    throw error;
  });
  const wip = await readFile(path.join(laneDir, 'wip.md'), 'utf8');
  return {
    handoffContent: handoff,
    wipContent: wip,
    handoff: fingerprintSection(handoff, BUILDER_TO_REVIEWER_HEADING),
    record: fingerprintSection(wip, REVIEW_LOG_HEADING),
  };
}

/** All three fingerprints and the round id, as of now. */
export async function computeCurrentFingerprints({ rootDir, laneDir, worktrees, paths, projectRepos, env, marking = false }) {
  const files = await fingerprintLaneFiles(laneDir);
  const work = await fingerprintWork({ rootDir, laneDir, worktrees, paths, projectRepos, env, marking });
  const fingerprints = { handoff: files.handoff, record: files.record, work: work.fingerprint };
  return { fingerprints, roundId: computeRoundId(fingerprints), work, wipContent: files.wipContent, handoffContent: files.handoffContent };
}

/**
 * Findings waiting for the builder's response with no owner deferral, as
 * review-check reports them. A malformed log throws with its first bad line.
 */
export function findingsWaitingForBuilder(wipContent) {
  const parsed = parseReviewLog(extractReviewLogLines(wipContent).lines);
  if (!parsed.ok) {
    const error = new Error(`the review log is malformed at wip.md line ${parsed.malformed.lineNumber} (${parsed.malformed.reason}): ${parsed.malformed.text}`);
    error.malformed = parsed.malformed;
    throw error;
  }
  return {
    parsed,
    waiting: parsed.findings.filter((finding) => !finding.resolved && !finding.deferredByOwner && finding.waitingFor === 'builder').map((finding) => finding.id),
  };
}

export async function readReadyMark(laneDir) {
  try {
    const mark = JSON.parse(await readFile(path.join(laneDir, READY_FILE), 'utf8'));
    return mark && typeof mark === 'object' ? mark : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    const wrapped = new Error(`${path.join(laneDir, READY_FILE)} can't be read (${error instanceof Error ? error.message : String(error)}); run ready-for-review again.`);
    wrapped.unreadable = true;
    throw wrapped;
  }
}

/** Atomic whole-file replace in the same directory: a temporary file, then a rename. */
export async function writeFileAtomic(filePath, content) {
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  await writeFile(tempPath, content, 'utf8');
  await rename(tempPath, filePath);
}

export function readBuilderConversation(env = process.env) {
  const id = typeof env.CLAUDE_CODE_SESSION_ID === 'string' ? env.CLAUDE_CODE_SESSION_ID.trim() : '';
  if (!id) return { builder: null, warning: null };
  if (!CONVERSATION_ID_PATTERN.test(id)) {
    return { builder: null, warning: 'CLAUDE_CODE_SESSION_ID is set but is not a conversation id this command accepts, so the mark names no conversation and the relay runs one pass.' };
  }
  return { builder: { tool: 'claude-code', conversation_id: id }, warning: null };
}

export function isConversationId(value) {
  return typeof value === 'string' && CONVERSATION_ID_PATTERN.test(value);
}

/**
 * `vibecompass ready-for-review`: writes the lane's `ready.json`. Refused, with
 * nothing written, while a finding waits for the builder's response and no
 * owner line defers it, and when there is no work to name.
 */
export async function writeReadyMark({ rootDir, laneId, laneDir, worktrees = {}, paths = [], projectRepos = [], env = process.env, now = new Date() }) {
  const wipContent = await readFile(path.join(laneDir, 'wip.md'), 'utf8');
  let waiting;
  try {
    ({ waiting } = findingsWaitingForBuilder(wipContent));
  } catch (error) {
    throw new Error(`ready-for-review is refused: ${error.message}. Correct the record first.`);
  }
  if (waiting.length > 0) {
    throw new Error(`ready-for-review is refused: ${waiting.join(', ')} ${waiting.length === 1 ? 'waits' : 'wait'} for the builder's response. Answer ${waiting.length === 1 ? 'it' : 'each'} with a response line (\`address review\`), or the owner defers ${waiting.length === 1 ? 'it' : 'them'}, then mark again.`); // D-419 item 4
  }
  if (Object.keys(worktrees).length === 0 && paths.length === 0) {
    throw new Error('ready-for-review is refused: this lane has no worktree, so name the work under review with --path <repo-id>:<path> or a path relative to the memory root.'); // D-419 item 4
  }
  const current = await computeCurrentFingerprints({ rootDir, laneDir, worktrees, paths, projectRepos, env, marking: true });
  // The work must cover something: a worktree, or a named path that isn't the
  // lane's own file (a named missing file counts, for a deletion).
  const covered = current.work.covers.worktrees.length + current.work.covers.paths.filter((item) => item.kind !== 'lane file').length;
  if (covered === 0) {
    throw new Error(`ready-for-review is refused: the paths named cover no work (${current.work.covers.paths.map((item) => item.spec).join(', ')} ${current.work.covers.paths.length === 1 ? 'is the lane\'s own file' : 'are the lane\'s own files'}, never part of the work). Name the work under review with --path <repo-id>:<path> or a path relative to the memory root.`); // D-419 item 4
  }
  const { builder, warning } = readBuilderConversation(env);
  const mark = {
    format: MARK_FORMAT,
    lane: laneId,
    marked_at: now.toISOString(),
    round_id: current.roundId,
    fingerprints: current.fingerprints,
    covers: {
      handoff: `handoff.md › ${BUILDER_TO_REVIEWER_HEADING.slice(3)}`,
      record: `wip.md › ${REVIEW_LOG_HEADING.slice(3)}`,
      worktrees: current.work.covers.worktrees,
      paths: current.work.covers.paths,
    },
    paths: current.work.covers.paths.filter((item) => item.kind !== 'lane file').map((item) => item.spec),
    builder,
  };
  await writeFileAtomic(path.join(laneDir, READY_FILE), `${JSON.stringify(mark, null, 2)}\n`);
  return { mark, notes: current.work.notes, warnings: warning ? [warning] : [], readyPath: path.join(laneDir, READY_FILE) };
}

/**
 * Whether the mark still matches the lane: each fingerprint compared with now.
 * Returns `{ current, differences, fingerprints, roundId }`.
 */
export async function compareMark(mark, { rootDir, laneDir, worktrees, projectRepos, env }) {
  const now = await computeCurrentFingerprints({ rootDir, laneDir, worktrees, paths: mark.paths ?? [], projectRepos, env });
  const differences = ['handoff', 'record', 'work'].filter((key) => now.fingerprints[key] !== mark.fingerprints?.[key]);
  return { current: differences.length === 0, differences, ...now };
}
