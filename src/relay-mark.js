import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, readlink, rename, writeFile } from 'node:fs/promises';
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

/** The git environment for the relay's own reads: no optional index writes. */
export function readOnlyGitEnv(baseEnv = process.env) {
  return { ...baseEnv, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
}

/**
 * Runs git and hashes its standard output as it streams, so a large diff
 * never sits in memory. Resolves `{ ok, code, hash, bytes, stderr }`.
 */
export function gitHash(args, cwd, env = process.env) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, { cwd, env: readOnlyGitEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, code: null, hash: null, bytes: 0, stderr: String(error?.message ?? error) });
      return;
    }
    const hash = createHash('sha256');
    let bytes = 0;
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += chunk;
    });
    child.on('error', (error) => resolve({ ok: false, code: null, hash: null, bytes, stderr: String(error?.message ?? error) }));
    child.on('close', (code) => resolve({ ok: code === 0, code, hash: hash.digest('hex'), bytes, stderr: stderr.trim() }));
  });
}

/** Runs git and returns its output as text (small outputs only). */
export function gitText(args, cwd, env = process.env) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, { cwd, env: readOnlyGitEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, code: null, stdout: '', stderr: String(error?.message ?? error) });
      return;
    }
    const out = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += chunk;
    });
    child.on('error', (error) => resolve({ ok: false, code: null, stdout: '', stderr: String(error?.message ?? error) }));
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout: Buffer.concat(out).toString('utf8'), stderr: stderr.trim() }));
  });
}

async function hashFile(filePath) {
  const info = await lstat(filePath);
  if (info.isSymbolicLink()) {
    return sha256Hex(`symlink:${await readlink(filePath)}`);
  }
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
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

async function gitTopLevel(dir, env) {
  const result = await gitText(['rev-parse', '--show-toplevel'], dir, env);
  return result.ok ? result.stdout.trim() : null;
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
 * The work fingerprint (D-419 item 4): SHA-256 over sorted entries from each
 * recorded worktree (its HEAD, a hash of the staged diff, a hash of the
 * working diff, and each untracked, not-ignored file) and each named path.
 */
export async function fingerprintWork({ rootDir, laneDir, worktrees = {}, paths = [], projectRepos = [], env = process.env }) {
  const entries = [];
  const covers = { worktrees: [], paths: [] };
  const notes = [];

  for (const repoId of Object.keys(worktrees).sort()) {
    const dir = path.resolve(worktrees[repoId]);
    const head = await gitText(['rev-parse', '--verify', 'HEAD'], dir, env);
    if (!head.ok) {
      throw new Error(`Lane worktree ${repoId} at ${dir} isn't a readable git checkout (${head.stderr || 'git rev-parse HEAD failed'}).`);
    }
    const headSha = head.stdout.trim();
    const staged = await gitHash(['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', '--no-color'], dir, env);
    const unstaged = await gitHash(['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-color'], dir, env);
    if (!staged.ok || !unstaged.ok) {
      throw new Error(`git diff failed in lane worktree ${repoId} at ${dir}: ${(staged.ok ? unstaged : staged).stderr}`);
    }
    const untracked = await gitText(['ls-files', '--others', '--exclude-standard', '-z'], dir, env);
    if (!untracked.ok) {
      throw new Error(`git ls-files failed in lane worktree ${repoId} at ${dir}: ${untracked.stderr}`);
    }
    const untrackedFiles = splitNul(untracked.stdout).sort();
    entries.push(`worktree\t${repoId}\thead\t${headSha}`);
    entries.push(`worktree\t${repoId}\tstaged\t${staged.hash}`);
    entries.push(`worktree\t${repoId}\tunstaged\t${unstaged.hash}`);
    for (const relative of untrackedFiles) {
      entries.push(`worktree\t${repoId}\tuntracked\t${relative}\t${await hashFile(path.join(dir, relative))}`);
    }
    covers.worktrees.push({ repo: repoId, path: dir, head: headSha, untracked: untrackedFiles.length });
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
      throw new Error(`ready-for-review --path ${resolved.spec} covers no files${listing.ignored > 0 ? ` (${listing.ignored} ignored left out)` : ''}; name the files instead.`); // D-419 item 4
    }
    for (const file of listing.files) {
      const relative = toPosix(path.relative(resolved.absolute, file));
      // A tracked file deleted in the working tree is still listed: it counts as missing.
      entries.push((await pathKind(file)) === 'missing'
        ? `path\t${resolved.spec}\tmissing\t${relative}`
        : `path\t${resolved.spec}\tfile\t${relative}\t${await hashFile(file)}`);
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
  const top = await gitTopLevel(dir, env);
  let files;
  let ignored = 0;
  if (top) {
    const relative = toPosix(path.relative(top, dir)) || '.';
    const listed = await gitText(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', relative], top, env);
    if (!listed.ok) {
      throw new Error(`git ls-files failed for ${dir}: ${listed.stderr}`);
    }
    files = [...new Set(splitNul(listed.stdout))].map((item) => path.join(top, item));
    const ignoredListing = await gitText(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z', '--', relative], top, env);
    ignored = ignoredListing.ok ? splitNul(ignoredListing.stdout).length : 0;
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
export async function computeCurrentFingerprints({ rootDir, laneDir, worktrees, paths, projectRepos, env }) {
  const files = await fingerprintLaneFiles(laneDir);
  const work = await fingerprintWork({ rootDir, laneDir, worktrees, paths, projectRepos, env });
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
  const current = await computeCurrentFingerprints({ rootDir, laneDir, worktrees, paths, projectRepos, env });
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
