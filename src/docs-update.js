import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseFrontmatter } from './frontmatter.js';
import { readCurrentRepoHead, resolveRepoSourceDir } from './git-binding.js';
import { resolveLaneMarkerContext, resolveLaneSelection } from './lane-marker.js';
import { ARCHITECTURE_DOC_SOFT_SIZE_LIMIT_BYTES, scanProjectMemory } from './project-memory.js';
import { parseSimpleYaml } from './simple-yaml.js';

const execFileAsync = promisify(execFile);
const PACKAGE_OWNED_PATH_PATTERNS = [
  /^state\//,
  /^context\.md$/,
  /^workflows\//,
  /^CLAUDE\.md$/,
  /^AGENTS\.md$/,
  /^\.cursorrules$/,
  /^\.github\/copilot-instructions\.md$/,
];

export async function planDocsUpdate(options = {}) {
  const normalized = normalizeDocsUpdateOptions(options);
  // D-280: docs-update shares the same context resolution as session
  // commands — explicit --root wins, else the nearest valid marker's
  // memory_root, else cwd/.compass — and the same D-277 lane selection.
  const markerContext = await resolveLaneMarkerContext({
    cwd: normalized.cwd,
    explicitRootDir: options.rootDir ?? null,
    explicitSessionId: normalized.sessionId,
  });
  normalized.rootDir = markerContext.rootDir;
  // suppressLaneWarnings marks the embedded close-session plan, which already
  // carries the same marker-context warnings on the close result itself.
  const warnings = options.suppressLaneWarnings === true ? [] : [...markerContext.warnings];
  const scan = await scanProjectMemory(normalized.rootDir);
  const project = scan.project?.extracted ?? {};
  const activeSession = await readActiveSession(normalized.rootDir, normalized.sessionId, {
    markerContext,
    warnings,
    suppressLaneWarnings: options.suppressLaneWarnings === true,
  });
  const changedFiles = await resolveChangedFiles({
    cwd: normalized.cwd,
    // Repo working copies live as siblings of the memory root (the
    // workspace), not relative to wherever the command runs — a worktree or
    // nested cwd previously made every repo dir resolve to a nonexistent
    // path whose git-status errors were silently swallowed.
    workspaceDir: path.dirname(normalized.rootDir),
    // D-281: a git-bound lane's diff lives in its recorded worktrees, not the
    // source checkouts — scan those for bound repos so the delta carries
    // correct `repo-id:` prefixes.
    laneWorktrees: activeSession?.worktrees ?? {},
    explicitChangedFiles: normalized.changedFiles,
    repos: project.repos ?? [],
    warnings,
  });
  const architectureDocs = scan.documents
    .filter((document) => document.kind === 'architecture')
    .map((document) => summarizeArchitectureDocument(document));
  const delta = {
    changedFiles,
    claimedPaths: activeSession?.claimedPaths ?? [],
    sessionRepos: activeSession?.repos ?? [],
    featureSlugs: activeSession?.featureSlugs ?? [],
  };
  const affectedArchitectureDocs = findAffectedArchitectureDocs(architectureDocs, delta);
  const packageOwnedChanges = changedFiles
    .filter((file) => isPackageOwnedPath(file.normalizedPath))
    .map((file) => file.raw);
  const decisionStatus = summarizeDecisionStatus(scan, activeSession);
  // A:192 (D-281): the pre-close staleness set is computed on every
  // docs-update run for the selected lane and re-emitted by close-session, so
  // mid-session and close-out see the same target set.
  const staleness = activeSession
    ? await buildPreCloseStaleness({
        rootDir: normalized.rootDir,
        workspaceDir: path.dirname(normalized.rootDir),
        activeSession,
        otherLanes: await listOtherActiveLanes(path.join(normalized.rootDir, 'sessions', 'active'), activeSession.id),
        decisionStatus,
        projectRepos: project.repos ?? [],
      })
    : null;
  const recommendations = buildRecommendations({
    changedFiles,
    affectedArchitectureDocs,
    packageOwnedChanges,
    decisionStatus,
    activeSession,
  });

  return {
    rootDir: normalized.rootDir,
    cwd: normalized.cwd,
    session: activeSession
      ? {
          id: activeSession.id,
          workingOn: activeSession.workingOn,
          decisionSnapshotHighestId: activeSession.decisionSnapshotHighestId,
        }
      : null,
    delta: {
      changedFiles: changedFiles.map((file) => file.raw),
      claimedPaths: delta.claimedPaths,
      sessionRepos: delta.sessionRepos,
      featureSlugs: delta.featureSlugs,
    },
    architecture: {
      affected: affectedArchitectureDocs,
      needsNewDoc: changedFiles.some((file) => isImplementationLikePath(file.normalizedPath)) && affectedArchitectureDocs.length === 0,
    },
    decisions: decisionStatus,
    staleness,
    packageOwnedChanges,
    recommendations,
    warnings,
  };
}

export function renderDocsUpdatePlan(plan) {
  const lines = [
    'Docs update plan:',
    `- Session: ${plan.session?.id ?? '(none selected)'}`,
    `- Changed files: ${plan.delta.changedFiles.length > 0 ? plan.delta.changedFiles.join(', ') : 'none detected'}`,
    `- Claimed paths: ${plan.delta.claimedPaths.length > 0 ? plan.delta.claimedPaths.join(', ') : 'none recorded'}`,
  ];

  lines.push('Affected architecture docs:');
  if (plan.architecture.affected.length === 0) {
    lines.push(plan.architecture.needsNewDoc
      ? '- No matching architecture doc found for implementation-like changes; create a focused component doc or defer explicitly.'
      : '- None detected from the current session delta.');
  } else {
    for (const doc of plan.architecture.affected) {
      lines.push(`- ${doc.path}`);
      for (const reason of doc.reasons) {
        lines.push(`  - ${reason}`);
      }
      if (doc.qualityWarnings.length > 0) {
        lines.push(`  - quality warnings: ${doc.qualityWarnings.map((warning) => warning.code).join(', ')}`);
      }
      if (doc.size?.exceedsSoftLimit) {
        lines.push(`  - size advisory: ${doc.size.byteLength} bytes exceeds the ${doc.size.softLimitBytes}-byte soft budget; this session is about to edit the doc — split it into focused component docs or trim low-value detail while folding in changes.`);
      }
    }
  }

  lines.push('Decision log:');
  if (plan.decisions.newDecisionIds.length > 0) {
    lines.push(`- New decisions since lane start: ${plan.decisions.newDecisionIds.map((id) => `D-${id}`).join(', ')}`);
  } else if (plan.decisions.decisionSnapshotHighestId === null) {
    lines.push('- No lane decision snapshot available.');
  } else {
    lines.push('- No new decisions detected since lane start.');
  }

  if (plan.staleness) {
    lines.push('Pre-close staleness set:');
    if (plan.staleness.entries.length === 0) {
      lines.push('- none detected');
    } else {
      for (const entry of plan.staleness.entries) {
        lines.push(`- ${entry}`);
      }
    }
    for (const skipped of plan.staleness.notEvaluated) {
      lines.push(`- (not evaluated) ${skipped}`);
    }
  }

  if (plan.packageOwnedChanges.length > 0) {
    lines.push('Package-owned generated/state surfaces:');
    for (const filePath of plan.packageOwnedChanges) {
      lines.push(`- ${filePath}`);
    }
  }

  lines.push('Recommended next actions:');
  for (const recommendation of plan.recommendations) {
    lines.push(`- ${recommendation}`);
  }

  for (const warning of plan.warnings ?? []) {
    lines.push(`Warning: ${warning}`);
  }

  return `${lines.join('\n')}\n`;
}

function normalizeDocsUpdateOptions(options) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  return {
    cwd,
    rootDir: path.resolve(cwd, options.rootDir ?? '.compass'),
    sessionId: normalizeOptionalString(options.sessionId),
    changedFiles: Array.isArray(options.changedFiles) ? options.changedFiles : [],
  };
}

async function readActiveSession(rootDir, requestedSessionId, laneContext = {}) {
  const activeRoot = path.join(rootDir, 'sessions', 'active');
  // D-277 lane selection via the shared resolver: explicit --session wins,
  // then the worktree marker (stale markers fail closed), then the single
  // active lane; with 2+ lanes and no selection this throws instead of
  // silently trusting the root-global index pointer.
  const selection = resolveLaneSelection({
    explicitSessionId: normalizeOptionalString(requestedSessionId),
    marker: laneContext.markerContext?.marker ?? null,
    laneIds: await listActiveLaneDirIds(activeRoot),
    rootDir,
    purpose: 'plan docs updates for',
    suppressLaneWarnings: laneContext.suppressLaneWarnings === true,
  });
  if (Array.isArray(laneContext.warnings)) {
    laneContext.warnings.push(...selection.warnings);
  }

  const sessionId = selection.sessionId;
  if (!sessionId) {
    return null;
  }

  const sessionPath = path.join(activeRoot, sessionId, 'session.yaml');
  try {
    const data = parseSimpleYaml(await readFile(sessionPath, 'utf8'), { sourceName: sessionPath });
    return {
      id: sessionId,
      workingOn: normalizeOptionalString(data.working_on),
      repos: normalizeStringArray(data.repos),
      claimedPaths: normalizeStringArray(data.claimed_paths),
      featureSlugs: normalizeStringArray(data.feature_slugs),
      startedAt: normalizeOptionalString(data.started_at),
      worktrees: normalizeWorktreeMap(data.worktrees),
      worktreeSources: normalizeWorktreeMap(data.worktree_sources),
      baseRevisions: normalizeStringValueMap(data.base_revisions),
      decisionSnapshotHighestId: Number.isInteger(data.decision_snapshot?.highest_decision_id)
        ? data.decision_snapshot.highest_decision_id
        : null,
    };
  } catch {
    return {
      id: sessionId,
      workingOn: null,
      repos: [],
      claimedPaths: [],
      featureSlugs: [],
      startedAt: null,
      worktrees: {},
      worktreeSources: {},
      baseRevisions: {},
      decisionSnapshotHighestId: null,
    };
  }
}

/** Other active lanes' scope fields, for the pre-close claim-overlap check. */
async function listOtherActiveLanes(activeRoot, selectedId) {
  const lanes = [];
  for (const laneId of await listActiveLaneDirIds(activeRoot)) {
    if (laneId === selectedId) {
      continue;
    }

    try {
      const sessionPath = path.join(activeRoot, laneId, 'session.yaml');
      const data = parseSimpleYaml(await readFile(sessionPath, 'utf8'), { sourceName: sessionPath });
      lanes.push({
        id: laneId,
        repos: normalizeStringArray(data.repos),
        claimedPaths: normalizeStringArray(data.claimed_paths),
      });
    } catch {
      // An unreadable sibling lane cannot contribute overlap detail; the lane
      // lifecycle commands own reporting corrupt lane metadata.
    }
  }

  return lanes;
}

function normalizeWorktreeMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalized = normalizeOptionalString(entry);
    if (normalized) {
      result[key] = path.resolve(normalized);
    }
  }

  return result;
}

/** Plain string map (base_revisions) — values are revisions, not paths. */
function normalizeStringValueMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalized = entry === null || entry === undefined ? null : String(entry).trim();
    if (normalized) {
      result[key] = normalized;
    }
  }

  return result;
}

const SESSION_NOTE_FILENAME_PATTERN = /^\d{4}-\d{2}-\d{2}-\d+-[a-z0-9-]+\.md$/i;

/**
 * A:192 (D-281): the pre-close staleness set. Everything here is a warning
 * surface — actionable and non-destructive; the closer chooses whether to
 * reconcile, close anyway, or keep the lane active. Pieces that cannot be
 * evaluated (no started_at, no decision snapshot) are named instead of being
 * silently skipped.
 */
async function buildPreCloseStaleness(options) {
  const activeSession = options.activeSession;
  const entries = [];
  const notEvaluated = [];

  // 1. New canonical decisions appended after the lane's frozen start-of-lane
  //    snapshot (D-266). Elevated from the informational decision-log summary:
  //    the closer confirms each one is either this lane's own append or does
  //    not change this lane's contracts.
  const newDecisions = options.decisionStatus.newDecisions ?? [];
  if (options.decisionStatus.decisionSnapshotHighestId === null) {
    notEvaluated.push('decision staleness: the lane has no decision snapshot.');
  } else {
    for (const decision of newDecisions) {
      entries.push(
        `New decision D-${decision.id} since lane start (${decision.path}) — confirm it is this lane's own append or does not change this lane's contracts.`,
      );
    }
  }

  // 2. Base revisions stale relative to the current source repo heads. Bound
  //    repos compare against the recorded source checkout, not the lane
  //    worktree — the lane's own commits are not staleness. A repo that
  //    RECORDED a base but whose current head is unreadable is named in
  //    notEvaluated (something changed since capture); repos that never
  //    captured a base (non-git sources) stay silent by design — git is
  //    never required for lanes (D-265/D-279).
  const staleBaseRevisions = [];
  for (const [repoId, baseRevision] of Object.entries(activeSession.baseRevisions ?? {})) {
    const sourceDir = activeSession.worktreeSources?.[repoId]
      ?? resolveRepoSourceDir(options.workspaceDir, repoId, options.projectRepos);
    const head = await readCurrentRepoHead(sourceDir);
    if (head === null) {
      notEvaluated.push(
        `base-revision staleness for repo "${repoId}": the current head of ${sourceDir} could not be read (missing, non-git, nested, or unborn) even though the lane recorded base ${baseRevision.slice(0, 12)} there at start.`,
      );
      continue;
    }
    if (head !== baseRevision) {
      staleBaseRevisions.push({ repoId, baseRevision, headRevision: head });
      entries.push(
        `Base revision for repo "${repoId}" is stale: lane base ${baseRevision.slice(0, 12)}, current source head ${head.slice(0, 12)} — review what landed since lane start.`,
      );
    }
  }

  // 3. Finalized session notes materialized after this lane started that
  //    mention the lane's declared scope. mtime ordering is intentional: a
  //    note that arrives in this root after lane start (local close, pull,
  //    apply-export) is new to this lane regardless of its filename date.
  const newSessionNotes = [];
  const startedAtMs = activeSession.startedAt ? Date.parse(activeSession.startedAt) : Number.NaN;
  if (Number.isNaN(startedAtMs)) {
    notEvaluated.push('session-note staleness: the lane has no parseable started_at.');
  } else {
    for (const note of await listFinalizedSessionNotesSince(options.rootDir, startedAtMs)) {
      const reasons = describeNoteScopeOverlap(note.content, activeSession);
      if (reasons.length > 0) {
        newSessionNotes.push({ path: note.relativePath, reasons });
        entries.push(
          `Finalized session note ${note.relativePath} was written after this lane started (${reasons.join('; ')}) — check it for overlap with this lane's scope.`,
        );
      }
    }
  }

  // 4. Claimed-path overlap with other active lanes (recently closed lanes
  //    surface through the finalized-note check above). Claims only overlap
  //    when their repo scopes can intersect: an explicit `repo:` prefix pins
  //    a claim to that repo, an unprefixed claim can live in any repo its
  //    lane declares — `app:src/x` vs `lib:src/x` never cross-flag.
  const laneOverlaps = [];
  for (const lane of options.otherLanes ?? []) {
    const sharedRepos = lane.repos.filter((repoId) => (activeSession.repos ?? []).includes(repoId));
    if (sharedRepos.length === 0) {
      continue;
    }

    const overlappingPaths = [];
    for (const claim of activeSession.claimedPaths ?? []) {
      const claimScope = claimRepoScope(claim, activeSession.repos ?? []);
      for (const otherClaim of lane.claimedPaths) {
        if (!repoScopesIntersect(claimScope, claimRepoScope(otherClaim, lane.repos))) {
          continue;
        }
        if (pathsOverlap(normalizeClaimPath(claim), normalizeClaimPath(otherClaim))) {
          overlappingPaths.push(normalizeClaimPath(claim));
        }
      }
    }
    if (overlappingPaths.length > 0) {
      const uniquePaths = Array.from(new Set(overlappingPaths));
      laneOverlaps.push({ laneId: lane.id, sharedRepos, overlappingPaths: uniquePaths });
      entries.push(
        `Active lane "${lane.id}" overlaps this lane's claimed path(s) ${uniquePaths.join(', ')} in shared repo(s) ${sharedRepos.join(', ')} — coordinate before closing.`,
      );
    }
  }

  return {
    newDecisions,
    staleBaseRevisions,
    newSessionNotes,
    laneOverlaps,
    notEvaluated,
    entries,
  };
}

/**
 * Notes newer than the lane start, stat-first: mature roots accumulate
 * finalized notes forever, so content is read only for the (normally tiny)
 * set that passes the mtime filter.
 */
async function listFinalizedSessionNotesSince(rootDir, sinceMs) {
  const sessionsDir = path.join(rootDir, 'sessions');
  let names;
  try {
    names = await readdir(sessionsDir);
  } catch {
    return [];
  }

  const candidates = await Promise.all(
    names
      .filter((name) => SESSION_NOTE_FILENAME_PATTERN.test(name))
      .map(async (name) => {
        const filePath = path.join(sessionsDir, name);
        try {
          const fileStat = await stat(filePath);
          return fileStat.mtimeMs > sinceMs ? { name, filePath, mtimeMs: fileStat.mtimeMs } : null;
        } catch {
          return null;
        }
      }),
  );

  const notes = [];
  for (const candidate of candidates.filter(Boolean).sort((left, right) => left.name.localeCompare(right.name))) {
    try {
      notes.push({
        relativePath: `sessions/${candidate.name}`,
        mtimeMs: candidate.mtimeMs,
        content: await readFile(candidate.filePath, 'utf8'),
      });
    } catch {
      // A note that disappears mid-scan is not staleness.
    }
  }

  return notes;
}

/**
 * Scope-overlap heuristics between a finalized note and the lane. Claimed
 * paths match only against backticked path-like tokens in the note (session
 * notes reference files in backticks by convention) with repo scoping — an
 * unanchored substring scan would make directory claims like `src/` match
 * virtually every note. Feature slugs match by mention; repos only via
 * backticked `repo:path` references (a bare repo id matches too much prose
 * to be a signal).
 */
function describeNoteScopeOverlap(content, activeSession) {
  const reasons = [];
  const lowerContent = content.toLowerCase();
  const noteTokens = Array.from(content.matchAll(/`([^`\n]+)`/g))
    .map((match) => match[1].trim())
    .filter((token) => token.includes('/') || token.includes(':'));

  for (const claim of activeSession.claimedPaths ?? []) {
    const claimPath = normalizeClaimPath(claim);
    if (!claimPath) {
      continue;
    }
    const claimScope = claimRepoScope(claim, activeSession.repos ?? []);
    const matched = noteTokens.some((token) => {
      const tokenRepoMatch = token.match(/^([^:/\s]+):(.+)$/);
      if (tokenRepoMatch && claimScope && !claimScope.includes(tokenRepoMatch[1])) {
        return false;
      }
      const tokenPath = normalizePath(tokenRepoMatch ? tokenRepoMatch[2] : token).replace(/\/+$/, '');
      return tokenPath !== '' && pathsOverlap(claimPath, tokenPath);
    });
    if (matched) {
      reasons.push(`mentions claimed path ${claimPath}`);
    }
  }

  for (const feature of activeSession.featureSlugs ?? []) {
    if (feature && lowerContent.includes(feature.toLowerCase())) {
      reasons.push(`mentions lane feature "${feature}"`);
    }
  }

  for (const repoId of activeSession.repos ?? []) {
    const referencePattern = new RegExp(`\`${escapeRegExp(repoId)}:[^\`\\n]+\``);
    if (referencePattern.test(content)) {
      reasons.push(`references repo "${repoId}" files`);
    }
  }

  return reasons;
}

/**
 * A claim's possible repo scope: an explicit `repo:` prefix pins it, an
 * unprefixed claim can live in any repo its lane declares. null means the
 * scope is unknowable and intersects everything (conservative for a warning
 * surface).
 */
function claimRepoScope(claim, laneRepos) {
  const match = String(claim).match(/^([^:/\s]+):/);
  if (match) {
    return [match[1]];
  }

  return Array.isArray(laneRepos) && laneRepos.length > 0 ? laneRepos : null;
}

function repoScopesIntersect(left, right) {
  if (!left || !right) {
    return true;
  }

  return left.some((repoId) => right.includes(repoId));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Claims may carry a repo prefix and a trailing slash; neither survives into prefix matching. */
function normalizeClaimPath(claim) {
  return stripRepoPrefix(claim).replace(/\/+$/, '');
}

async function listActiveLaneDirIds(activeRoot) {
  try {
    const entries = await readdir(activeRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function resolveChangedFiles(options) {
  if (options.explicitChangedFiles.length > 0) {
    return normalizeChangedFiles(options.explicitChangedFiles, options.repos);
  }

  const changedPaths = new Set();
  const laneWorktrees = options.laneWorktrees ?? {};
  // A cwd equal to or inside a recorded worktree is fully covered by that
  // worktree's prefixed scan below; running the unprefixed cwd scan too would
  // report the same files twice, once without a repo prefix.
  const cwdInsideRecordedWorktree = Object.values(laneWorktrees).some((worktreePath) =>
    isPathEqualOrInside(options.cwd, worktreePath));
  if (!cwdInsideRecordedWorktree) {
    for (const filePath of await readGitStatusPaths(options.cwd)) {
      changedPaths.add(filePath);
    }
  }

  const repoStatusResults = await Promise.all(
    options.repos.map(async (repo) => {
      if (!repo?.id) {
        return [];
      }

      let laneWorktree = laneWorktrees[repo.id] ?? null;
      if (laneWorktree && !(await directoryExists(laneWorktree))) {
        // Recorded-but-missing is benign crash residue (D-281); fall back to
        // the source checkout rather than silently zeroing this repo's delta.
        options.warnings?.push(
          `Recorded worktree ${laneWorktree} for repo "${repo.id}" does not exist; scanning the source checkout instead.`,
        );
        laneWorktree = null;
      }
      const repoDir = laneWorktree ?? resolveRepoWorkingDirectory(options.workspaceDir, repo);
      // The cwd containment skip applies only to source dirs: a cwd at or
      // inside an unbound repo's checkout is already covered by the
      // unprefixed scan (git status paths are toplevel-relative, so a
      // prefixed scan would double-report every file). A recorded worktree
      // is scanned prefixed even when it is the cwd.
      if (!repoDir || (!laneWorktree && isPathEqualOrInside(options.cwd, repoDir))) {
        return [];
      }

      return (await readGitStatusPaths(repoDir)).map((filePath) => `${repo.id}:${filePath}`);
    }),
  );

  for (const filePath of repoStatusResults.flat()) {
    changedPaths.add(filePath);
  }

  return normalizeChangedFiles(Array.from(changedPaths).sort((left, right) => left.localeCompare(right)), options.repos);
}

async function readGitStatusPaths(cwd) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'status', '--porcelain=v1', '--untracked-files=all'], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return parseGitStatusPaths(stdout);
  } catch {
    return [];
  }
}

function isPathEqualOrInside(candidate, parentDir) {
  const relative = path.relative(path.resolve(parentDir), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function directoryExists(target) {
  try {
    await readdir(target);
    return true;
  } catch {
    return false;
  }
}

function resolveRepoWorkingDirectory(workspaceDir, repo) {
  if (!repo?.id) {
    return null;
  }

  if (repo.path) {
    return path.resolve(workspaceDir, repo.path);
  }

  return path.resolve(workspaceDir, repo.id);
}

function parseGitStatusPaths(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const rawPath = line.slice(3).trim();
      const renameIndex = findUnquotedRenameSeparator(rawPath);
      const pathPart = renameIndex >= 0 ? rawPath.slice(renameIndex + 4).trim() : rawPath;
      return unquoteGitPorcelainPath(pathPart);
    });
}

function findUnquotedRenameSeparator(value) {
  let inQuotes = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }

    if (inQuotes && char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && value.startsWith(' -> ', index)) {
      return index;
    }
  }

  return -1;
}

function unquoteGitPorcelainPath(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    return trimmed;
  }

  let decoded = '';
  let octalBytes = [];
  const flushOctalBytes = () => {
    if (octalBytes.length === 0) {
      return;
    }

    decoded += Buffer.from(octalBytes).toString('utf8');
    octalBytes = [];
  };

  for (let index = 1; index < trimmed.length - 1; index += 1) {
    const char = trimmed[index];
    if (char !== '\\') {
      flushOctalBytes();
      decoded += char;
      continue;
    }

    const next = trimmed[index + 1];
    if (next === undefined) {
      flushOctalBytes();
      decoded += '\\';
      continue;
    }

    const octalMatch = trimmed.slice(index + 1).match(/^[0-7]{1,3}/);
    if (octalMatch) {
      octalBytes.push(Number.parseInt(octalMatch[0], 8));
      index += octalMatch[0].length;
      continue;
    }

    flushOctalBytes();
    const escapes = {
      a: '\u0007',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\v',
      '\\': '\\',
      '"': '"',
    };
    decoded += escapes[next] ?? next;
    index += 1;
  }

  flushOctalBytes();
  return decoded;
}

function normalizeChangedFiles(paths, repos) {
  return paths
    .map((raw) => normalizeOptionalString(raw))
    .filter(Boolean)
    .map((raw) => {
      const normalizedPath = normalizePath(raw);
      return {
        raw,
        normalizedPath,
        repoPathCandidates: buildRepoPathCandidates(normalizedPath, repos),
      };
    });
}

function buildRepoPathCandidates(filePath, repos) {
  const candidates = new Set([filePath]);
  const explicitRepoMatch = filePath.match(/^([^:/]+):(.+)$/);
  if (explicitRepoMatch) {
    const repoRelativePath = normalizePath(explicitRepoMatch[2]);
    candidates.add(`${explicitRepoMatch[1]}:${repoRelativePath}`);
    candidates.add(repoRelativePath);
  }

  if (!explicitRepoMatch && repos.length === 1 && repos[0]?.id) {
    candidates.add(`${repos[0].id}:${filePath}`);
  }

  for (const repo of repos) {
    if (!repo?.id) {
      continue;
    }
    if (filePath.startsWith(`${repo.id}/`)) {
      candidates.add(`${repo.id}:${filePath.slice(repo.id.length + 1)}`);
    }
    if (repo.path) {
      const repoPath = normalizePath(repo.path).replace(/^\.\//, '');
      if (repoPath && filePath.startsWith(`${repoPath}/`)) {
        candidates.add(`${repo.id}:${filePath.slice(repoPath.length + 1)}`);
      }
    }
  }

  return Array.from(candidates);
}

function summarizeArchitectureDocument(document) {
  const frontmatter = parseFrontmatter(document.content, { sourceName: document.path });
  const data = frontmatter.data ?? {};
  return {
    path: document.path,
    repoIds: [
      ...(typeof data.repo === 'string' ? [data.repo] : []),
      ...(Array.isArray(data.repos) ? data.repos.filter((repo) => typeof repo === 'string') : []),
    ],
    domain: normalizeOptionalString(data.domain),
    feature: normalizeOptionalString(data.feature),
    component: normalizeOptionalString(data.component),
    involvedFiles: extractInvolvedFiles(frontmatter.body),
    byteLength: document.byteLength,
    warnings: document.warnings,
  };
}

function extractInvolvedFiles(body) {
  return Array.from(body.matchAll(/`([^`\n]+:[^`\n]+)`/g))
    .map((match) => normalizePath(match[1]))
    .filter(Boolean);
}

function findAffectedArchitectureDocs(docs, delta) {
  return docs
    .map((doc) => {
      const reasons = [];

      for (const changedFile of delta.changedFiles) {
        if (pathMatchesDocument(changedFile, doc)) {
          reasons.push(`matches changed file ${changedFile.raw}`);
        }
      }

      for (const claimedPath of delta.claimedPaths) {
        const normalizedClaim = normalizePath(claimedPath);
        if (doc.involvedFiles.some((involvedFile) => pathsOverlap(involvedFile, normalizedClaim))) {
          reasons.push(`matches lane claim ${claimedPath}`);
        }
      }

      if (delta.featureSlugs.some((feature) => slugify(doc.feature ?? '') === feature)) {
        reasons.push(`matches lane feature ${delta.featureSlugs.filter((feature) => slugify(doc.feature ?? '') === feature).join(', ')}`);
      }

      return {
        path: doc.path,
        reasons: Array.from(new Set(reasons)),
        qualityWarnings: doc.warnings,
        // Session-scoped size advisory (D-292): surfaced only for docs the
        // session is about to touch, deliberately not a standing status
        // check. Self-describing so every renderer reads the same values.
        size: {
          byteLength: typeof doc.byteLength === 'number' ? doc.byteLength : null,
          softLimitBytes: ARCHITECTURE_DOC_SOFT_SIZE_LIMIT_BYTES,
          exceedsSoftLimit: typeof doc.byteLength === 'number' && doc.byteLength > ARCHITECTURE_DOC_SOFT_SIZE_LIMIT_BYTES,
        },
      };
    })
    .filter((doc) => doc.reasons.length > 0)
    .sort((left, right) => left.path.localeCompare(right.path));
}

function pathMatchesDocument(changedFile, doc) {
  if (changedFile.normalizedPath === doc.path) {
    return true;
  }

  return changedFile.repoPathCandidates.some((candidate) =>
    doc.involvedFiles.some((involvedFile) => pathsOverlap(involvedFile, candidate)),
  );
}

function pathsOverlap(left, right) {
  const normalizedLeft = normalizePath(left);
  const normalizedRight = normalizePath(right);
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`) ||
    normalizedLeft.endsWith(`/${normalizedRight}`) ||
    normalizedRight.endsWith(`/${normalizedLeft}`)
  );
}

function summarizeDecisionStatus(scan, activeSession) {
  const decisionEntries = scan.documents
    .filter((document) => document.kind === 'decision')
    .flatMap((document) => (document.extracted?.decision_ids ?? []).map((id) => ({ id, path: document.path })))
    .sort((left, right) => left.id - right.id);
  const decisionIds = decisionEntries.map((entry) => entry.id);
  const highestDecisionId = decisionIds.length > 0 ? decisionIds[decisionIds.length - 1] : null;
  const snapshot = activeSession?.decisionSnapshotHighestId ?? null;
  // A:192 staleness elevation: keep the id-with-source-file detail so the
  // pre-close staleness set can name the domain file each new decision
  // landed in.
  const newDecisions = snapshot === null ? [] : decisionEntries.filter((entry) => entry.id > snapshot);

  return {
    highestDecisionId,
    decisionSnapshotHighestId: snapshot,
    newDecisionIds: newDecisions.map((entry) => entry.id),
    newDecisions,
  };
}

function buildRecommendations(options) {
  const recommendations = [];

  if (options.affectedArchitectureDocs.length > 0) {
    recommendations.push('Fold the session changes into the affected architecture docs as current-state contracts — rewrite sections in place, keep the durable plan/next steps/rollout state in the doc, and move work/ship chronology to the session note (D-292, D-293) — then close with --architecture-docs updated.');
  } else if (options.changedFiles.length > 0 && options.affectedArchitectureDocs.length === 0) {
    recommendations.push('No matching architecture doc was found for the session delta; create a focused doc written as a current-state contract, mark docs not-needed with evidence, or defer explicitly.');
  } else {
    recommendations.push('No architecture doc update is indicated by the current delta; close with --architecture-docs not-needed if that remains true.');
  }

  if (options.decisionStatus.newDecisionIds.length > 0) {
    recommendations.push('Ensure affected architecture docs reference the new decisions where they change contracts or ownership.');
  } else {
    recommendations.push('Append a decision only if this session accepted a real architectural/product/process choice.');
  }

  if (options.packageOwnedChanges.length > 0) {
    recommendations.push('Do not hand-edit package-owned state/generated surfaces; use refresh-workflow --dry-run/--apply or sync-agents as appropriate.');
  }

  if (options.activeSession) {
    recommendations.push('Keep the active lane wip.md/handoff.md current; close-session will distill them into the finalized note.');
  }

  return recommendations;
}

function isPackageOwnedPath(filePath) {
  const normalized = normalizePath(filePath).replace(/^\.compass\//, '');
  return PACKAGE_OWNED_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isImplementationLikePath(filePath) {
  const normalized = stripRepoPrefix(filePath);
  return !(
    normalized.startsWith('architecture/') ||
    normalized.startsWith('decisions/') ||
    normalized.startsWith('sessions/') ||
    isPackageOwnedPath(normalized)
  );
}

function stripRepoPrefix(filePath) {
  const normalized = normalizePath(filePath);
  const repoMatch = normalized.match(/^[^:/]+:(.+)$/);
  return repoMatch ? normalizePath(repoMatch[1]) : normalized;
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value.map((item) => normalizeOptionalString(item)).filter(Boolean)
    : [];
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function normalizePath(value) {
  return String(value).replace(/\\/g, '/').replace(/^\.\//, '');
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
