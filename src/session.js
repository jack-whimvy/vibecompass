import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scanProjectMemory } from './project-memory.js';
import { parseSimpleYaml } from './simple-yaml.js';
import { buildCloseSessionGuidance, resolveWorkflowSettings } from './workflow.js';
import { syncAgentInstructionFiles } from './generators/agent-files/index.js';
import { START_MARKER } from './generators/agent-files/markers.js';
import { planDocsUpdate } from './docs-update.js';
import {
  captureBaseRevisions,
  normalizeBranchName,
  preflightGitBinding,
  provisionGitBinding,
  rollbackGitBinding,
} from './git-binding.js';
import { withMemoryRootLock } from './serialization.js';
import { findDuplicateDecisionIds, formatDecisionId } from './decisions.js';
import {
  LANE_MARKER_FILENAME,
  assertMarkerTargetDisjoint,
  findEnclosingGitDir,
  readLaneMarker,
  renderLaneMarker,
  resolveLaneMarkerContext,
  resolveLaneSelection,
  validateLaneId,
} from './lane-marker.js';
import { PACKAGE_VERSION } from './version.js';
// This lazy-only cycle is intentional: manifest.js reads lane state from this
// module, and session command handlers rewrite the derived manifest after
// lane mutations. Keep both sides free of top-level calls into the other.
import { writeStateManifest } from './manifest.js';

const CURRENT_SESSION_REQUIRED_FIELDS = ['Date:', 'Working on:', 'Last thing completed:', 'Blockers:', 'Next session should:'];
const WIP_HEADER_PATTERN = /^# WIP — (\d{4}-\d{2}-\d{2}) \(session (\d+)\)$/m;
const SESSION_FILENAME_PATTERN = /^(\d{4}-\d{2}-\d{2})-(\d+)-([a-z0-9-]+)\.md$/i;
const DOCUMENT_MAINTENANCE_STATUSES = new Set(['updated', 'not-needed', 'deferred']);
const DOCUMENT_MAINTENANCE_FIELDS = [
  {
    key: 'architectureDocs',
    label: 'Architecture docs',
    flag: '--architecture-docs',
  },
  {
    key: 'decisionLog',
    label: 'Decision log',
    flag: '--decision-log',
  },
  {
    key: 'sessionMaintenance',
    label: 'Session handoff/scratch',
    flag: '--session-maintenance',
  },
];
export async function startProjectSession(options) {
  const { normalized, markerContext } = await resolveSessionCommandContext(options);
  return withMemoryRootLock(normalized.rootDir, 'start-session', () =>
    startProjectSessionLocked(normalized, options, markerContext));
}

/**
 * Pre-lock command context (D-280): an explicit --root always wins; otherwise
 * lane-scoped commands adopt the nearest valid worktree lane marker's
 * memory_root, and only when no marker resolves does the `cwd/.compass`
 * default apply. Commands that never resolve a lane from the marker skip the
 * marker walk entirely when --root is explicit, so internal callers that
 * always pass rootDir (manifest/status refresh) keep their existing behavior.
 */
async function resolveSessionCommandContext(options, { needMarkerForLane = false } = {}) {
  let markerContext;
  if (options?.rootDir && !needMarkerForLane) {
    const cwd = options?.cwd ? path.resolve(options.cwd) : process.cwd();
    markerContext = { cwd, rootDir: path.resolve(cwd, options.rootDir), rootSource: 'flag', marker: null, warnings: [] };
  } else {
    markerContext = await resolveLaneMarkerContext({
      cwd: options?.cwd,
      explicitRootDir: options?.rootDir ?? null,
      explicitSessionId: normalizeOptionalString(options?.sessionId),
    });
  }

  const inferredToolingRootDir = await inferToolingRootDirForContext(options, markerContext);
  const normalized = normalizeSessionPaths({
    ...options,
    cwd: markerContext.cwd,
    rootDir: markerContext.rootDir,
    ...(inferredToolingRootDir ? { toolingRootDir: inferredToolingRootDir } : {}),
  });
  return { normalized, markerContext };
}

/**
 * The tooling root (CLAUDE.md home) defaults to cwd, but follows the memory
 * root's placement in two cases: when the marker supplied the root (a
 * worktree cwd must update the real Current-session block), and when an
 * explicit --root is used from a cwd with no CLAUDE.md (e.g. the corrupt-
 * marker bypass run from a worktree) — a case where the cwd default could
 * only fail at readClaudeFile, so inferring is strictly recovery, never a
 * behavior change for working flows.
 */
async function inferToolingRootDirForContext(options, markerContext) {
  if (options?.toolingRootDir) {
    return undefined;
  }

  if (markerContext.rootSource === 'marker') {
    return inferToolingRootForMemoryRoot(markerContext.rootDir);
  }

  if (markerContext.rootSource === 'flag' && !(await fileExists(path.join(markerContext.cwd, 'CLAUDE.md')))) {
    return inferToolingRootForMemoryRoot(markerContext.rootDir);
  }

  return undefined;
}

/**
 * The `<owner>/.compass` placement keeps CLAUDE.md one level above the memory
 * root; the dedicated-memory-repo placement keeps it inside the root itself.
 * Prefer whichever directory actually holds a CLAUDE.md, falling back to the
 * parent (the actionable readClaudeFile error and --tooling-root remain the
 * escape hatch for layouts with no CLAUDE.md at either).
 * Exported for read-only surfaces (status) that adopt a marker-supplied root
 * and must follow the same placement rule for the tooling root.
 */
export async function inferToolingRootForMemoryRoot(rootDir) {
  if (await fileExists(path.join(rootDir, 'CLAUDE.md'))) {
    return rootDir;
  }

  return path.dirname(rootDir);
}

async function startProjectSessionLocked(normalized, options, markerContext) {
  const workingOn = requireNonEmptyString(options?.workingOn, 'start-session requires a non-empty workingOn value.');
  const sessionDate = normalizeSessionDate(options?.date);

  await ensureInitializedProjectMemory(normalized.rootDir);
  const claude = await readClaudeFile(normalized.claudePath);
  const sessionId = await resolveStartSessionId(normalized, options);
  const lanePaths = getLanePaths(normalized, sessionId);
  const features = normalizeStringArray(options?.features);
  const repos = normalizeStringArray(options?.repos);
  const claims = normalizeStringArray(options?.claims);
  const existingLanes = await listActiveSessionLanes(normalized);
  const overlapWarnings = buildOverlapWarnings({
    sessionId,
    features,
    repos,
    claims,
    existingLanes,
  });
  const highestDecisionId = await readHighestDecisionId(normalized.rootDir);
  const projectConfig = await readProjectConfig(normalized.projectFilePath);
  const baseRevisionCapture = await captureBaseRevisions({
    workspaceDir: path.dirname(normalized.rootDir),
    repoIds: repos,
    projectRepos: Array.isArray(projectConfig?.repos) ? projectConfig.repos : [],
  });

  // D-281 opt-in git binding: normalize + preflight before the first write so
  // a refused binding leaves the root untouched.
  if (options?.worktree && !options?.branch) {
    throw new Error('--worktree requires --branch; a worktree checks out the lane branch.');
  }
  let gitBinding = null;
  if (options?.branch) {
    const branch = await normalizeBranchName(options.branch);
    const workspaceDir = path.dirname(normalized.rootDir);
    const containerDir = path.join(workspaceDir, 'worktrees', sessionId);
    const useWorktree = options.worktree === true;
    const preflight = await preflightGitBinding({
      workspaceDir,
      rootDir: normalized.rootDir,
      branch,
      worktree: useWorktree,
      repoIds: repos,
      projectRepos: Array.isArray(projectConfig?.repos) ? projectConfig.repos : [],
      existingLanes,
      containerDir,
    });
    gitBinding = {
      branch,
      containerDir: useWorktree ? containerDir : null,
      repoPlans: preflight.repoPlans,
      warnings: preflight.warnings,
      marker: useWorktree
        ? {
            path: path.join(containerDir, LANE_MARKER_FILENAME),
            token: randomUUID(),
            createdAt: formatLocalDateTime(new Date()),
          }
        : null,
    };
    // Bound repos base on what the binding checks out (create: start point;
    // reuse: existing branch tip), overriding the plain HEAD capture.
    for (const plan of preflight.repoPlans) {
      baseRevisionCapture.baseRevisions[plan.repoId] = plan.baseRevision;
    }
  }

  const nextSessionNumber = await getNextSessionNumber(normalized.sessionsDir, sessionDate);
  const currentSession = parseCurrentSessionBlock(claude.content, { optional: true });
  const updatedClaude = replaceCurrentSessionBlock(claude.content, {
    date: `${sessionDate} (session ${nextSessionNumber}, lane ${sessionId})`,
    workingOn: `${workingOn} [${sessionId}]`,
    lastThingCompleted:
      normalizeOptionalString(options?.lastThingCompleted) ??
      currentSession?.lastThingCompleted ??
      'Project memory bootstrap completed.',
    blockers: normalizeOptionalString(options?.blockers) ?? 'No blocker yet.',
    nextSessionShould:
      normalizeOptionalString(options?.nextSessionShould) ??
      'Finish the active session and close it with a finalized session note.',
  }, {
    lanes: [
      ...existingLanes.map((lane) => ({ id: lane.id, workingOn: lane.workingOn })),
      { id: sessionId, workingOn },
    ],
    selectedId: sessionId,
  });

  await mkdir(normalized.activeSessionsDir, { recursive: true });
  await mkdir(lanePaths.laneDir, { recursive: false }).catch((error) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      throw new Error(`Active session lane "${sessionId}" already exists. Choose a different --id or close that lane first.`);
    }

    throw error;
  });
  await writeFile(normalized.claudePath, updatedClaude, 'utf8');
  await writeFile(
    lanePaths.sessionFilePath,
    renderLaneMetadata({
      sessionId,
      sessionDate,
      sessionNumber: nextSessionNumber,
      workingOn,
      features,
      repos,
      claims,
      baseRevisions: baseRevisionCapture.baseRevisions,
      // Record-before-create (D-281): the full binding plan — including the
      // marker path/token — is in session.yaml before any git artifact or
      // marker file exists, so a crash leaves only benign recorded-but-missing
      // entries.
      ...(gitBinding
        ? {
            branch: gitBinding.branch,
            worktreeContainer: gitBinding.containerDir,
            worktrees: gitBinding.containerDir
              ? Object.fromEntries(gitBinding.repoPlans.map((plan) => [plan.repoId, plan.worktreePath]))
              : null,
            worktreeSources: gitBinding.containerDir
              ? Object.fromEntries(gitBinding.repoPlans.map((plan) => [plan.repoId, plan.sourceDir]))
              : null,
            laneMarker: gitBinding.marker,
          }
        : {}),
      highestDecisionId,
    }),
    'utf8',
  );
  await writeFile(
    lanePaths.wipFilePath,
    renderWipTemplate({
      sessionDate,
      sessionNumber: nextSessionNumber,
      workingOn,
      sessionId,
    }),
    'utf8',
  );
  await writeFile(
    lanePaths.handoffFilePath,
    renderHandoffTemplate({
      sessionDate,
      sessionNumber: nextSessionNumber,
      workingOn,
      sessionId,
    }),
    'utf8',
  );
  const priorIndexContent = await readFile(normalized.activeSessionsIndexPath, 'utf8').catch(() => null);
  await upsertActiveSessionIndex(normalized, {
    id: sessionId,
    status: 'active',
    workingOn,
  }, { current: sessionId });

  if (gitBinding) {
    const progress = { worktrees: [], createdBranches: [] };
    try {
      if (gitBinding.containerDir) {
        await mkdir(gitBinding.containerDir, { recursive: true });
        await writeFile(
          gitBinding.marker.path,
          renderLaneMarker({
            laneId: sessionId,
            memoryRoot: normalized.rootDir,
            token: gitBinding.marker.token,
            createdAt: gitBinding.marker.createdAt,
            createdBy: PACKAGE_VERSION,
          }),
          'utf8',
        );
      }
      await provisionGitBinding({ branch: gitBinding.branch, repoPlans: gitBinding.repoPlans }, progress);
    } catch (error) {
      // D-281: start-session is atomic — unwind git artifacts created this
      // call, then the lane files, CLAUDE.md, and index this call wrote.
      const rollbackNotes = await rollbackGitBinding(progress, gitBinding.branch);
      if (gitBinding.containerDir) {
        await rm(gitBinding.containerDir, { recursive: true, force: true }).catch(() => {});
      }
      await rm(lanePaths.laneDir, { recursive: true, force: true }).catch(() => {});
      await writeFile(normalized.claudePath, claude.content, 'utf8').catch(() => {});
      if (priorIndexContent === null) {
        await rm(normalized.activeSessionsIndexPath, { force: true }).catch(() => {});
      } else {
        await writeFile(normalized.activeSessionsIndexPath, priorIndexContent, 'utf8').catch(() => {});
      }
      await refreshStateManifestSafely(normalized.rootDir);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message}\nGit binding failed; start-session was rolled back and lane "${sessionId}" was not created.` +
          (rollbackNotes.length > 0 ? `\nRollback notes: ${rollbackNotes.join('; ')}` : '') +
          '\nIf a crash interrupts this rollback, run `vibecompass rebuild-active-index` and close the lane normally.',
      );
    }
  }

  const manifestRefresh = await refreshStateManifestSafely(normalized.rootDir);
  const auditWarnings = await buildDocsReviewWarnings(normalized);
  const metadataWarnings = collectLaneMetadataWarnings(existingLanes);
  const agentFileSync = await syncAgentInstructionFilesSafely({
    rootDir: normalized.rootDir,
    toolingRootDir: normalized.toolingRootDir,
  });

  return {
    rootDir: normalized.rootDir,
    toolingRootDir: normalized.toolingRootDir,
    claudePath: normalized.claudePath,
    sessionId,
    sessionFilePath: lanePaths.sessionFilePath,
    wipFilePath: lanePaths.wipFilePath,
    handoffFilePath: lanePaths.handoffFilePath,
    sessionDate,
    sessionNumber: nextSessionNumber,
    warnings: [
      ...markerContext.warnings,
      ...metadataWarnings,
      ...overlapWarnings,
      ...baseRevisionCapture.warnings,
      ...(gitBinding?.warnings ?? []),
      ...manifestRefresh.warnings,
      ...auditWarnings,
    ],
    ...(gitBinding
      ? {
          gitBinding: {
            branch: gitBinding.branch,
            worktreeContainer: gitBinding.containerDir,
            markerPath: gitBinding.marker?.path ?? null,
            repos: gitBinding.repoPlans.map((plan) => ({
              repoId: plan.repoId,
              mode: plan.mode,
              baseRevision: plan.baseRevision,
              worktreePath: plan.worktreePath,
            })),
          },
        }
      : {}),
    manifest: manifestRefresh.manifest,
    agentFileSync,
  };
}

export async function closeProjectSession(options) {
  const { normalized, markerContext } = await resolveSessionCommandContext(options, { needMarkerForLane: true });
  return withMemoryRootLock(normalized.rootDir, 'close-session', () =>
    closeProjectSessionLocked(normalized, options, markerContext));
}

async function closeProjectSessionLocked(normalized, options, markerContext) {
  const title = requireNonEmptyString(options?.title, 'session close requires a non-empty title.');
  const completed = normalizeStringArray(options?.completed);
  const models = normalizeStringArray(options?.models);
  const nextSteps = normalizeStringArray(options?.nextSteps);
  const decisions = normalizeStringArray(options?.decisions);
  const blockers = normalizeStringArray(options?.blockers);

  if (completed.length === 0) {
    throw new Error('session close requires at least one completed item.');
  }

  if (nextSteps.length === 0) {
    throw new Error('session close requires at least one next-step entry.');
  }

  await ensureInitializedProjectMemory(normalized.rootDir, { allowMissingProjectFile: true });

  const duplicateDecisionIds = await findDuplicateDecisionIds(normalized.rootDir);
  if (duplicateDecisionIds.length > 0) {
    throw new Error(
      `close-session is blocked: duplicate decision IDs detected — ${duplicateDecisionIds
        .map((duplicate) => `${formatDecisionId(duplicate.id)} (${duplicate.occurrences.join(', ')})`)
        .join('; ')}. Repair the canonical decision files by hand before closing (D-276); duplicates are never auto-renumbered.`,
    );
  }

  const claude = await readClaudeFile(normalized.claudePath);
  const projectConfig = await readProjectConfig(normalized.projectFilePath);
  const workflowSettings = resolveWorkflowSettings(projectConfig);
  const laneSelection = await resolveExistingSessionId(normalized, options, markerContext, 'close');
  const sessionId = laneSelection.sessionId;
  const lanePaths = sessionId ? getLanePaths(normalized, sessionId) : normalized;
  const closingLaneMetadata = sessionId ? await readLaneMetadata(lanePaths.sessionFilePath) : null;
  // Interim S3-2 guard (D-281): the close-side guarded worktree removal is
  // S3-3 work, and closing a lane whose recorded worktrees still exist would
  // token-delete the container marker and destroy session.yaml — the only
  // records the removal guard depends on — while the worktrees (and any
  // uncommitted work in them) survive unmanaged. Refuse before any
  // irreversible write; recorded-but-missing worktrees are benign crash
  // residue and do not block the close.
  if (closingLaneMetadata) {
    const survivingWorktrees = [];
    for (const [repoId, worktreePath] of Object.entries(closingLaneMetadata.worktrees ?? {})) {
      if (await fileExists(worktreePath)) {
        survivingWorktrees.push({ repoId, worktreePath });
      }
    }
    if (survivingWorktrees.length > 0) {
      const cleanupCommands = survivingWorktrees
        .map(({ repoId, worktreePath }) => {
          const sourceDir = closingLaneMetadata.worktreeSources?.[repoId];
          return `git -C ${sourceDir ?? '<source repo>'} worktree remove ${worktreePath}`;
        })
        .join('\n  ');
      throw new Error(
        `Lane "${sessionId}" still has provisioned worktrees on disk:\n  ${survivingWorktrees.map((entry) => entry.worktreePath).join('\n  ')}\n` +
          'close-session cannot yet remove worktrees (D-281 close-side removal is unimplemented); closing now would destroy the records the removal guard needs while the worktrees survive. ' +
          `Commit or discard their work, remove them manually:\n  ${cleanupCommands}\nthen rerun close-session.`,
      );
    }
  }
  const documentMaintenance = normalizeDocumentMaintenanceCheckpoint(options?.documentMaintenance);
  const docsUpdate = await planDocsUpdateSafely({
    rootDir: normalized.rootDir,
    cwd: normalized.cwd,
    sessionId,
    // close-session already resolved (and warned about) the lane selection;
    // the embedded plan must not repeat the flag-vs-marker warning.
    suppressLaneWarnings: true,
    // Test injection seam; production callers should let close-session use the default planner.
    planner: options?.docsUpdatePlanner,
  });

  if (!(await fileExists(lanePaths.wipFilePath))) {
    throw new Error(
      `No active session scratchpad exists at ${lanePaths.wipFilePath}. Start a session before trying to close it.`,
    );
  }

  const wipContent = await readFile(lanePaths.wipFilePath, 'utf8');
  const activeSession = parseActiveSession(wipContent, lanePaths.wipFilePath);
  const currentSession = parseCurrentSessionBlock(claude.content, { optional: true });
  const workedOn =
    normalizeOptionalString(options?.workedOn) ??
    extractSectionBody(wipContent, 'Working on') ??
    currentSession?.workingOn;

  if (!workedOn) {
    throw new Error('session close could not determine what the session worked on. Pass workedOn explicitly.');
  }

  const sessionSlug = slugifyTitle(title);
  if (!sessionSlug) {
    throw new Error('session close title must contain at least one letter or number.');
  }

  const sessionRelativePath = toPosix(
    path.join('sessions', `${activeSession.sessionDate}-${activeSession.sessionNumber}-${sessionSlug}.md`),
  );
  const sessionFilePath = path.join(normalized.rootDir, sessionRelativePath);

  if (await fileExists(sessionFilePath)) {
    throw new Error(`Session note already exists at ${sessionFilePath}.`);
  }

  await writeFile(
    sessionFilePath,
    renderSessionNote({
      sessionDate: activeSession.sessionDate,
      sessionNumber: activeSession.sessionNumber,
      title,
      workedOn,
      completed,
      decisions,
      models: models.length > 0 ? models : ['Not recorded.'],
      documentMaintenance,
      blockers,
      nextSteps,
    }),
    'utf8',
  );

  const hadHandoff = await fileExists(lanePaths.handoffFilePath);
  const markerCleanupWarnings = [];
  let activeSessionIndex = null;
  if (sessionId) {
    if (closingLaneMetadata?.laneMarker?.path) {
      const cleanup = await removeRecordedLaneMarker(closingLaneMetadata.laneMarker);
      markerCleanupWarnings.push(...cleanup.warnings);
    }
    await rm(lanePaths.laneDir, { recursive: true, force: true });
    activeSessionIndex = await removeActiveSessionFromIndex(normalized, sessionId);
  } else {
    await rm(lanePaths.wipFilePath, { force: true });
    if (hadHandoff) {
      await rm(lanePaths.handoffFilePath, { force: true });
    }
  }

  const closedSummary = `Closed session ${activeSession.sessionNumber} and wrote \`${sessionRelativePath}\`.`;
  const survivingLanes = activeSessionIndex?.lanes ?? [];
  const survivorListing = { lanes: survivingLanes.map((lane) => ({ id: lane.id, workingOn: lane.workingOn })), selectedId: activeSessionIndex?.current ?? null };
  const updatedClaude = replaceCurrentSessionBlock(
    claude.content,
    activeSessionIndex?.current
      ? buildCurrentSessionFieldsForLane(survivingLanes.find((lane) => lane.id === activeSessionIndex.current), {
          lastThingCompleted: normalizeOptionalString(options?.lastThingCompleted) ?? closedSummary,
        })
      : survivingLanes.length >= 2
        ? {
            date: `${activeSession.sessionDate} (session ${activeSession.sessionNumber})`,
            workingOn:
              'Multiple lanes remain active. Select one explicitly with `vibecompass switch-session <lane-id>`, --session, or a worktree lane marker.',
            lastThingCompleted: normalizeOptionalString(options?.lastThingCompleted) ?? closedSummary,
            blockers: blockers.length > 0 ? summarizeList(blockers) : 'No blocker remains.',
            nextSessionShould:
              normalizeOptionalString(options?.nextSessionShould) ??
              'Pick the next lane explicitly (D-277: no implicit current-lane fallback while multiple lanes are active).',
          }
        : {
            date: `${activeSession.sessionDate} (session ${activeSession.sessionNumber})`,
            workingOn: 'Session closed. Ready for the next builder session.',
            lastThingCompleted: normalizeOptionalString(options?.lastThingCompleted) ?? closedSummary,
            blockers: blockers.length > 0 ? summarizeList(blockers) : 'No blocker remains.',
            nextSessionShould:
              normalizeOptionalString(options?.nextSessionShould) ?? summarizeOrderedList(nextSteps),
          },
    survivorListing,
  );

  await writeFile(normalized.claudePath, updatedClaude, 'utf8');
  const manifestRefresh = await refreshStateManifestSafely(normalized.rootDir);
  const agentFileSync = await syncAgentInstructionFilesSafely({
    rootDir: normalized.rootDir,
    toolingRootDir: normalized.toolingRootDir,
  });

  return {
    rootDir: normalized.rootDir,
    toolingRootDir: normalized.toolingRootDir,
    claudePath: normalized.claudePath,
    projectFilePath: normalized.projectFilePath,
    sessionId,
    sessionFilePath,
    sessionRelativePath,
    sessionDate: activeSession.sessionDate,
    sessionNumber: activeSession.sessionNumber,
    documentMaintenance,
    docsUpdatePlan: docsUpdate.plan,
    workflowGuidance: buildCloseSessionGuidance(workflowSettings, {
      projectConfig,
      rootFlag: buildRootFlagForGuidance(normalized),
    }),
    warnings: [
      ...markerContext.warnings,
      ...laneSelection.warnings,
      ...markerCleanupWarnings,
      ...docsUpdate.warnings,
      ...manifestRefresh.warnings,
    ],
    manifest: manifestRefresh.manifest,
    agentFileSync,
    removedScratchFiles: [
      lanePaths.wipFilePath,
      ...(hadHandoff ? [lanePaths.handoffFilePath] : []),
    ],
  };
}

function normalizeDocumentMaintenanceCheckpoint(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
  const missing = [];
  const invalid = [];
  const checkpoint = {};

  for (const field of DOCUMENT_MAINTENANCE_FIELDS) {
    const normalized = normalizeOptionalString(source[field.key]);
    if (!normalized) {
      missing.push(`${field.flag} <updated|not-needed|deferred>`);
      continue;
    }

    if (!DOCUMENT_MAINTENANCE_STATUSES.has(normalized)) {
      invalid.push(`${field.flag}=${normalized}`);
      continue;
    }

    checkpoint[field.key] = normalized;
  }

  if (missing.length > 0 || invalid.length > 0) {
    const details = [
      missing.length > 0
        ? `Missing document-maintenance checkpoint status: ${missing.join(', ')}.`
        : null,
      invalid.length > 0
        ? `Invalid document-maintenance checkpoint status: ${invalid.join(', ')}. Allowed values: updated, not-needed, deferred.`
        : null,
      'The package validates the close-session checkpoint, but the closer remains responsible for semantic doc updates.',
    ].filter(Boolean);

    throw new Error(details.join(' '));
  }

  return checkpoint;
}

export async function listProjectSessions(options = {}) {
  const { normalized } = await resolveSessionCommandContext(options);
  await ensureInitializedProjectMemory(normalized.rootDir, { allowMissingProjectFile: true });
  const index = await readActiveSessionIndex(normalized);
  const lanes = await listActiveSessionLanes(normalized);

  return {
    rootDir: normalized.rootDir,
    current: resolveValidatedCurrentLane(index.current, lanes),
    lanes,
  };
}

/**
 * D-277: the index pointer is only reported as current when it names an
 * existing active lane; a single active lane may be current implicitly, but
 * with two or more lanes an invalid/missing pointer is never repaired by
 * picking one — current becomes null until an explicit selection.
 */
function resolveValidatedCurrentLane(pointer, lanes) {
  if (pointer && lanes.some((lane) => lane.id === pointer)) {
    return pointer;
  }

  return lanes.length === 1 ? lanes[0].id : null;
}

export async function switchProjectSession(options = {}) {
  const { normalized, markerContext } = await resolveSessionCommandContext(options);
  return withMemoryRootLock(normalized.rootDir, 'switch-session', () =>
    switchProjectSessionLocked(normalized, options, markerContext));
}

async function switchProjectSessionLocked(normalized, options, markerContext) {
  const sessionId = validateLaneId(requireNonEmptyString(options?.sessionId, 'switch-session requires a session ID.'));
  const lanes = await listActiveSessionLanes(normalized);
  const lane = lanes.find((item) => item.id === sessionId);

  if (!lane) {
    throw new Error(`Active session lane "${sessionId}" does not exist.`);
  }

  // D-280 disagreement warning: switching to a lane other than the one the
  // enclosing marker binds proceeds, but names both lanes.
  const selection = resolveLaneSelection({
    explicitSessionId: sessionId,
    marker: markerContext?.marker ?? null,
    laneIds: lanes.map((item) => item.id),
    rootDir: normalized.rootDir,
    purpose: 'switch to',
  });

  await upsertActiveSessionIndex(normalized, null, { current: sessionId });
  const claude = await readClaudeFile(normalized.claudePath);
  await writeFile(
    normalized.claudePath,
    replaceCurrentSessionBlock(
      claude.content,
      buildCurrentSessionFieldsForLane(lane, {
        lastThingCompleted: `Switched current lane to ${sessionId}.`,
      }),
      { lanes: lanes.map((item) => ({ id: item.id, workingOn: item.workingOn })), selectedId: sessionId },
    ),
    'utf8',
  );
  const manifestRefresh = await refreshStateManifestSafely(normalized.rootDir);
  const agentFileSync = await syncAgentInstructionFilesSafely({
    rootDir: normalized.rootDir,
    toolingRootDir: normalized.toolingRootDir,
  });

  return {
    rootDir: normalized.rootDir,
    claudePath: normalized.claudePath,
    current: sessionId,
    lanes,
    warnings: [...markerContext.warnings, ...selection.warnings, ...manifestRefresh.warnings],
    manifest: manifestRefresh.manifest,
    agentFileSync,
  };
}

/**
 * Rebuilds `sessions/active/index.yaml` from the active lane directories plus
 * an explicit current-lane selection (D-266/D-277 recovery path). The current
 * pointer is never derived from enumeration alone: an explicit `current` wins,
 * a still-valid existing pointer is preserved, and only a single surviving
 * lane may become current implicitly.
 */
export async function rebuildActiveSessionIndex(options = {}) {
  const { normalized } = await resolveSessionCommandContext(options);
  return withMemoryRootLock(normalized.rootDir, 'rebuild-active-index', async () => {
    await ensureInitializedProjectMemory(normalized.rootDir, { allowMissingProjectFile: true });
    const lanes = await listActiveSessionLanes(normalized);
    const requested = options?.current == null || options.current === ''
      ? null
      : validateLaneId(requireNonEmptyString(options.current, 'rebuild-active-index requires a non-empty --current lane ID when provided.'));

    if (requested && !lanes.some((lane) => lane.id === requested)) {
      throw new Error(`Active session lane "${requested}" does not exist; cannot set it as the current lane.`);
    }

    if (lanes.length === 0) {
      await rm(normalized.activeSessionsIndexPath, { force: true });
      return {
        rootDir: normalized.rootDir,
        indexPath: normalized.activeSessionsIndexPath,
        current: null,
        lanes,
        removed: true,
      };
    }

    const existing = await readActiveSessionIndex(normalized);
    const current =
      requested ??
      (lanes.some((lane) => lane.id === existing.current) ? existing.current : null) ??
      (lanes.length === 1 ? lanes[0].id : null);

    if (!current) {
      throw new Error(
        'rebuild-active-index needs an explicit --current <lane-id> because more than one lane is active and the existing pointer is not valid (D-277: the current lane is an explicit selection, not a derived default).',
      );
    }

    await mkdir(normalized.activeSessionsDir, { recursive: true });
    await writeFile(normalized.activeSessionsIndexPath, renderActiveSessionIndex(current, lanes), 'utf8');
    return {
      rootDir: normalized.rootDir,
      indexPath: normalized.activeSessionsIndexPath,
      current,
      lanes,
      removed: false,
    };
  });
}

/**
 * Writes the worktree lane marker for an active lane (D-280). Markers are
 * never written implicitly: this explicit command and S3 worktree
 * provisioning are the only producers. The target must be path-disjoint from
 * the memory root, and the lane's session.yaml records the marker under a
 * `lane_marker:` block map so close-session and S3 removal can token-match.
 */
export async function writeLaneMarkerForSession(options) {
  // needMarkerForLane: the enclosing marker is consulted even under an
  // explicit --root so the D-280 flag-vs-marker disagreement warning fires
  // when this command binds a different lane than the invoking context.
  const { normalized, markerContext } = await resolveSessionCommandContext(options, { needMarkerForLane: true });
  return withMemoryRootLock(normalized.rootDir, 'write-lane-marker', () =>
    writeLaneMarkerForSessionLocked(normalized, options, markerContext));
}

async function writeLaneMarkerForSessionLocked(normalized, options, markerContext) {
  const sessionId = validateLaneId(
    requireNonEmptyString(options?.sessionId, 'write-lane-marker requires --session <lane-id> so the marker binds to an explicit lane.'),
  );
  await ensureInitializedProjectMemory(normalized.rootDir, { allowMissingProjectFile: true });
  const warnings = [...markerContext.warnings];
  const lanes = await listActiveSessionLanes(normalized);
  // Shared D-277/D-280 selection: validates the explicit lane is active and
  // emits the disagreement warning when an enclosing marker names another lane.
  const selection = resolveLaneSelection({
    explicitSessionId: sessionId,
    marker: markerContext.marker,
    laneIds: lanes.map((lane) => lane.id),
    rootDir: normalized.rootDir,
    purpose: 'bind the marker to',
  });
  warnings.push(...selection.warnings);

  const lanePaths = getLanePaths(normalized, sessionId);
  if (!(await fileExists(lanePaths.sessionFilePath))) {
    throw new Error(
      `Lane "${sessionId}" has no session.yaml at ${lanePaths.sessionFilePath}; the marker cannot be recorded. Repair the lane (rebuild-active-index) before writing a marker.`,
    );
  }

  const targetDir = path.resolve(normalized.cwd, options?.dir ?? '.');
  const targetStat = await stat(targetDir).catch(() => null);
  if (!targetStat) {
    throw new Error(
      `write-lane-marker target directory ${targetDir} does not exist. Create it first; markers are never provisioned implicitly (D-280).`,
    );
  }
  if (!targetStat.isDirectory()) {
    throw new Error(`write-lane-marker target ${targetDir} is not a directory.`);
  }

  await assertMarkerTargetDisjoint(targetDir, normalized.rootDir);
  const gitDir = await findEnclosingGitDir(targetDir);
  if (gitDir) {
    warnings.push(
      `Marker target ${targetDir} sits inside a git work tree (${gitDir}); lane markers are local-only (D-278) — make sure ${LANE_MARKER_FILENAME} is git-ignored there.`,
    );
  }

  const markerPath = path.join(targetDir, LANE_MARKER_FILENAME);
  if (await fileExists(markerPath)) {
    try {
      const existing = await readLaneMarker(markerPath);
      if (existing.laneId !== sessionId) {
        warnings.push(`Replaced the marker at ${markerPath} previously bound to lane "${existing.laneId}".`);
      }
    } catch {
      warnings.push(`Replaced an unreadable marker at ${markerPath}.`);
    }
  }

  const laneMetadata = await readLaneMetadata(lanePaths.sessionFilePath);
  // Fail closed when the lane metadata is unreadable: a null-degraded parse
  // would hide a recorded worktree container and let a rebind orphan the
  // removal guard (D-281).
  if (laneMetadata.warnings.length > 0) {
    throw new Error(
      `Lane "${sessionId}"'s session.yaml could not be parsed (${laneMetadata.warnings[0]}); refusing to rebind its marker — a provisioned worktree container would be undetectable (D-281). Repair the lane metadata first.`,
    );
  }
  // D-281: a provisioned lane's container marker is what authorizes guarded
  // worktree removal at close; rebinding would token-delete it and orphan
  // the worktrees permanently.
  if (laneMetadata.worktreeContainer) {
    throw new Error(
      `Lane "${sessionId}" has a provisioned worktree container at ${laneMetadata.worktreeContainer}; its marker is managed by start/close-session and rebinding it would orphan the worktree-removal guard (D-281). Close the lane to remove the worktrees instead.`,
    );
  }
  if (laneMetadata.laneMarker?.path && path.resolve(laneMetadata.laneMarker.path) !== markerPath) {
    const cleanup = await removeRecordedLaneMarker(laneMetadata.laneMarker);
    warnings.push(...cleanup.warnings);
  }

  const token = randomUUID();
  const createdAt = formatLocalDateTime(new Date());
  const sessionYaml = await readFile(lanePaths.sessionFilePath, 'utf8');
  // Record before writing the marker file: a crash between the two leaves the
  // benign recorded-but-missing state (cleanup is a no-op) instead of an
  // unrecorded on-disk marker that nothing can remove or report.
  await writeFile(
    lanePaths.sessionFilePath,
    upsertLaneMarkerBlock(sessionYaml, { path: markerPath, token, createdAt }),
    'utf8',
  );
  await writeFile(
    markerPath,
    renderLaneMarker({
      laneId: sessionId,
      memoryRoot: normalized.rootDir,
      token,
      createdAt,
      createdBy: PACKAGE_VERSION,
    }),
    'utf8',
  );

  return {
    rootDir: normalized.rootDir,
    sessionId,
    markerPath,
    token,
    warnings,
  };
}

/**
 * Removes a lane's recorded marker file only when the on-disk token still
 * matches the recorded token (D-280 guarded removal); anything else is
 * reported and left in place.
 */
async function removeRecordedLaneMarker(recorded) {
  const warnings = [];
  if (!recorded?.path) {
    return { removed: false, warnings };
  }

  if (!(await fileExists(recorded.path))) {
    return { removed: false, warnings };
  }

  try {
    const marker = await readLaneMarker(recorded.path);
    if (recorded.token && marker.token === recorded.token) {
      await rm(recorded.path, { force: true });
      return { removed: true, warnings };
    }

    warnings.push(
      `Lane marker at ${recorded.path} left in place: its token does not match the lane's recorded marker (D-280: only token-matched markers are removed).`,
    );
  } catch (error) {
    warnings.push(
      `Lane marker at ${recorded.path} left in place: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { removed: false, warnings };
}

/** Replaces (or appends) the `lane_marker:` block map in a session.yaml body. */
function upsertLaneMarkerBlock(content, marker) {
  // CRLF-tolerant to match parseSimpleYaml's /\r?\n/ splitting; a missed
  // strip here would append a duplicate key and void the whole lane metadata.
  const stripped = content.replace(/^lane_marker:\r?\n(?:[ \t]+.*\r?\n?)*/m, '');
  const base = stripped.endsWith('\n') ? stripped : `${stripped}\n`;
  const block = [
    'lane_marker:',
    `  path: ${quoteYamlString(marker.path)}`,
    `  token: ${quoteYamlString(marker.token)}`,
    `  created_at: ${marker.createdAt}`,
    '',
  ].join('\n');

  return `${base}${block}`;
}

async function refreshStateManifestSafely(rootDir) {
  try {
    const manifest = await writeStateManifest(rootDir);
    return {
      manifest,
      warnings: [],
    };
  } catch (error) {
    return {
      manifest: null,
      warnings: [
        `State manifest refresh skipped: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

async function planDocsUpdateSafely(options) {
  try {
    const planner = typeof options.planner === 'function' ? options.planner : planDocsUpdate;
    return {
      plan: await planner({
        rootDir: options.rootDir,
        cwd: options.cwd,
        sessionId: options.sessionId,
        suppressLaneWarnings: options.suppressLaneWarnings === true,
      }),
      warnings: [],
    };
  } catch (error) {
    return {
      plan: null,
      warnings: [
        `Docs-update plan skipped: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

async function syncAgentInstructionFilesSafely(options) {
  try {
    return await syncAgentInstructionFiles(options);
  } catch (error) {
    return {
      rootDir: options.rootDir,
      toolingRootDir: options.toolingRootDir,
      dryRun: false,
      results: [
        {
          format: 'all',
          path: options.toolingRootDir,
          relativePath: '.',
          status: 'warning',
          warning: `Agent instruction file sync skipped: ${error instanceof Error ? error.message : String(error)}`,
          changed: false,
        },
      ],
    };
  }
}

async function buildDocsReviewWarnings(normalized) {
  const markerPath = path.join(normalized.rootDir, 'state', 'docs-review.json');
  try {
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    if (marker && marker.status === 'completed') {
      return [];
    }
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      return [
        `Docs-review marker at ${markerPath} is unreadable. Starter docs are not a comprehensive architecture review; run "vibecompass docs-review --guided" before risky implementation work.`,
      ];
    }
  }

  return [
    `No docs-review marker found at ${markerPath}. Starter docs are not a comprehensive architecture review; run "vibecompass docs-review --guided" before risky implementation work.`,
  ];
}

function normalizeSessionPaths(options) {
  const cwd = options?.cwd ? path.resolve(options.cwd) : process.cwd();
  const rootDir = path.resolve(cwd, options?.rootDir ?? '.compass');
  const toolingRootDir = options?.toolingRootDir
    ? path.resolve(cwd, options.toolingRootDir)
    : cwd;

  return {
    cwd,
    rootDir,
    toolingRootDir,
    projectFilePath: path.resolve(rootDir, 'project.yaml'),
    claudePath: path.resolve(toolingRootDir, 'CLAUDE.md'),
    sessionsDir: path.resolve(rootDir, 'sessions'),
    activeSessionsDir: path.resolve(rootDir, 'sessions/active'),
    activeSessionsIndexPath: path.resolve(rootDir, 'sessions/active/index.yaml'),
    wipFilePath: path.resolve(rootDir, 'sessions/wip.md'),
    handoffFilePath: path.resolve(rootDir, 'sessions/handoff.md'),
  };
}

function getLanePaths(normalized, sessionId) {
  const laneDir = path.resolve(normalized.activeSessionsDir, sessionId);

  return {
    laneDir,
    sessionFilePath: path.resolve(laneDir, 'session.yaml'),
    wipFilePath: path.resolve(laneDir, 'wip.md'),
    handoffFilePath: path.resolve(laneDir, 'handoff.md'),
  };
}

async function ensureInitializedProjectMemory(rootDir, options = {}) {
  if (!(await fileExists(rootDir))) {
    throw new Error(
      `No project memory root was found at ${rootDir}. Run "vibecompass init" before using session commands.`,
    );
  }

  const projectFilePath = path.join(rootDir, 'project.yaml');
  if (!options.allowMissingProjectFile && !(await fileExists(projectFilePath))) {
    throw new Error(
      `No project.yaml was found at ${projectFilePath}. Run "vibecompass init" before using session commands.`,
    );
  }
}

async function readProjectConfig(projectFilePath) {
  try {
    const source = await readFile(projectFilePath, 'utf8');
    return parseSimpleYaml(source, { sourceName: projectFilePath });
  } catch {
    return null;
  }
}

function buildRootFlagForGuidance(normalized) {
  return `--root ${toPosix(path.relative(normalized.cwd, normalized.rootDir) || '.')}`;
}

async function readClaudeFile(claudePath) {
  if (!(await fileExists(claudePath))) {
    throw new Error(
      `No CLAUDE.md was found at ${claudePath}. Re-run "vibecompass init --with-claude" or create the file before using session commands.`,
    );
  }

  return {
    path: claudePath,
    content: await readFile(claudePath, 'utf8'),
  };
}

function parseCurrentSessionBlock(content, options = {}) {
  const sessionFence = findCurrentSessionFence(content);
  if (!sessionFence) {
    if (options.optional) {
      return null;
    }

    throw new Error('CLAUDE.md is missing a recognizable "## Current session" fenced block.');
  }

  const fields = {};
  for (const rawLine of sessionFence.body.trim().split('\n')) {
    const separatorIndex = rawLine.indexOf(':');
    if (separatorIndex <= 0) {
      continue;
    }

    const label = rawLine.slice(0, separatorIndex).trim().toLowerCase();
    const value = rawLine.slice(separatorIndex + 1).trim();
    fields[label] = value;
  }

  return {
    date: fields.date ?? null,
    workingOn: fields['working on'] ?? null,
    lastThingCompleted: fields['last thing completed'] ?? null,
    blockers: fields.blockers ?? null,
    nextSessionShould: fields['next session should'] ?? null,
  };
}

function replaceCurrentSessionBlock(content, fields, laneListing = null) {
  const sessionFence = findCurrentSessionFence(content);
  const blockBody = renderCurrentSessionBlockBody(fields, laneListing);

  if (!sessionFence) {
    return insertCurrentSessionBlock(content, blockBody);
  }

  return `${content.slice(0, sessionFence.bodyStart)}${blockBody}${content.slice(sessionFence.bodyEnd)}`;
}

/**
 * D-277: with two or more active lanes the block becomes a derived multi-lane
 * listing (one line per active lane plus the selected lane); with at most one
 * lane it keeps the exact legacy five-field shape. The five field labels stay
 * present in both shapes so parseCurrentSessionBlock/findCurrentSessionFence
 * keep working on either.
 */
function renderCurrentSessionBlockBody(fields, laneListing = null) {
  const lines = [`Date: ${fields.date}`];

  if (laneListing && Array.isArray(laneListing.lanes) && laneListing.lanes.length >= 2) {
    lines.push('Active lanes:');
    for (const lane of [...laneListing.lanes].sort((left, right) => left.id.localeCompare(right.id))) {
      const selectedSuffix = laneListing.selectedId === lane.id ? ' [selected]' : '';
      lines.push(`- ${lane.id} — ${lane.workingOn ?? 'No summary recorded'}${selectedSuffix}`);
    }
  }

  lines.push(
    `Working on: ${fields.workingOn}`,
    `Last thing completed: ${fields.lastThingCompleted}`,
    `Blockers: ${fields.blockers}`,
    `Next session should: ${fields.nextSessionShould}`,
  );

  return lines.join('\n');
}

function insertCurrentSessionBlock(content, blockBody) {
  const currentSessionBlock = [
    '## Current session',
    '',
    '**Update this block at the start and end of every session.**',
    '',
    '```',
    blockBody,
    '```',
    '',
  ].join('\n');
  const markerIndex = content.indexOf(START_MARKER);
  const normalizedContent = content.endsWith('\n') ? content : `${content}\n`;

  if (markerIndex >= 0) {
    const beforeMarker = content.slice(0, markerIndex).trimEnd();
    const fromMarker = content.slice(markerIndex);
    return `${beforeMarker}\n\n${currentSessionBlock}${fromMarker}`;
  }

  return `${normalizedContent}\n${currentSessionBlock}`;
}

function buildCurrentSessionFieldsForLane(lane, overrides = {}) {
  if (!lane) {
    throw new Error('Cannot update the Current session block without active lane metadata.');
  }

  const sessionDate = lane.sessionDate ?? normalizeSessionDate();
  const sessionNumber = lane.sessionNumber || 0;
  const workingOn = lane.workingOn ?? 'No summary recorded.';

  return {
    date: `${sessionDate} (session ${sessionNumber}, lane ${lane.id})`,
    workingOn: `${workingOn} [${lane.id}]`,
    lastThingCompleted:
      overrides.lastThingCompleted ?? 'Current lane selected from `sessions/active/index.yaml`.',
    blockers: overrides.blockers ?? 'No blocker recorded for the selected lane.',
    nextSessionShould:
      overrides.nextSessionShould ?? 'Continue the selected active lane from `sessions/active/index.yaml`.',
  };
}

async function getNextSessionNumber(sessionsDir, sessionDate) {
  const sessions = await listFinalizedSessions(sessionsDir);
  const activeSessions = await listActiveSessionLanes({ sessionsDir, activeSessionsDir: path.join(sessionsDir, 'active') });
  const todaysSessions = [
    ...sessions,
    ...activeSessions,
  ].filter((session) => session.sessionDate === sessionDate);
  const highestNumber = todaysSessions.reduce((max, session) => Math.max(max, session.sessionNumber), 0);
  return highestNumber + 1;
}

async function resolveStartSessionId(normalized, options) {
  const explicitId = normalizeOptionalString(options?.sessionId);
  if (explicitId) {
    return validateLaneId(explicitId);
  }

  if ((await fileExists(normalized.wipFilePath)) || (await fileExists(normalized.handoffFilePath))) {
    throw new Error(
      `Legacy active session scratch files already exist under ${normalized.sessionsDir}. Close or recover that session before starting a lane.`,
    );
  }

  throw new Error('start-session requires --id <lane-id> so each active lane has a meaningful name.');
}

async function resolveExistingSessionId(normalized, options, markerContext, purpose) {
  const explicitId = normalizeOptionalString(options?.sessionId);
  const lanes = await listActiveSessionLanes(normalized);

  return resolveLaneSelection({
    explicitSessionId: explicitId ? validateLaneId(explicitId) : null,
    marker: markerContext?.marker ?? null,
    laneIds: lanes.map((lane) => lane.id),
    rootDir: normalized.rootDir,
    purpose,
  });
}

async function listActiveSessionLanes(normalized) {
  try {
    const entries = await readdir(normalized.activeSessionsDir, { withFileTypes: true });
    const lanes = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const sessionId = entry.name;
      const lanePaths = getLanePaths(normalized, sessionId);
      const metadata = await readLaneMetadata(lanePaths.sessionFilePath);
      const wipSession = await readLaneWipSession(lanePaths.wipFilePath);
      lanes.push({
        id: sessionId,
        status: metadata.status ?? 'active',
        workingOn: metadata.workingOn ?? null,
        features: metadata.features,
        repos: metadata.repos,
        claims: metadata.claims,
        startedAt: metadata.startedAt,
        decisionSnapshot: metadata.decisionSnapshot,
        branch: metadata.branch ?? null,
        worktreeContainer: metadata.worktreeContainer ?? null,
        worktrees: metadata.worktrees ?? {},
        worktreeSources: metadata.worktreeSources ?? {},
        baseRevisions: metadata.baseRevisions ?? {},
        warnings: metadata.warnings,
        sessionDate: metadata.sessionDate ?? wipSession?.sessionDate ?? null,
        sessionNumber: metadata.sessionNumber ?? wipSession?.sessionNumber ?? 0,
      });
    }

    return lanes.sort((left, right) => left.id.localeCompare(right.id));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

async function readLaneWipSession(wipFilePath) {
  try {
    return parseActiveSession(await readFile(wipFilePath, 'utf8'), wipFilePath);
  } catch {
    return null;
  }
}

async function readLaneMetadata(sessionFilePath) {
  try {
    const content = await readFile(sessionFilePath, 'utf8');
    const data = parseSimpleYaml(content, { sourceName: sessionFilePath });
    return {
      status: normalizeOptionalString(data.status),
      workingOn: normalizeOptionalString(data.working_on),
      features: normalizeStringArray(data.feature_slugs),
      repos: normalizeStringArray(data.repos),
      claims: normalizeStringArray(data.claimed_paths),
      startedAt: normalizeOptionalString(data.started_at),
      decisionSnapshot: {
        highestDecisionId: parseNullableNumber(data.decision_snapshot?.highest_decision_id),
      },
      laneMarker: data.lane_marker && typeof data.lane_marker === 'object'
        ? {
            path: normalizeOptionalString(data.lane_marker.path),
            token: normalizeOptionalString(data.lane_marker.token),
            createdAt: normalizeOptionalString(data.lane_marker.created_at),
          }
        : null,
      branch: normalizeOptionalString(data.branch),
      worktreeContainer: normalizeOptionalString(data.worktree_container),
      worktrees: normalizeStringMap(data.worktrees),
      worktreeSources: normalizeStringMap(data.worktree_sources),
      baseRevisions: normalizeStringMap(data.base_revisions),
      sessionDate: normalizeOptionalString(data.session_date),
      sessionNumber: typeof data.session_number === 'number' ? data.session_number : Number(data.session_number) || null,
      warnings: [],
    };
  } catch (error) {
    return {
      status: null,
      workingOn: null,
      features: [],
      repos: [],
      claims: [],
      startedAt: null,
      decisionSnapshot: {
        highestDecisionId: null,
      },
      laneMarker: null,
      branch: null,
      worktreeContainer: null,
      worktrees: {},
      worktreeSources: {},
      baseRevisions: {},
      sessionDate: null,
      sessionNumber: null,
      warnings: [
        `Could not parse ${sessionFilePath}: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

/**
 * One-level block map of string values (worktrees, worktree_sources,
 * base_revisions). Unquoted all-digit values come back numerically coerced
 * from parseScalar — normalize them back to strings.
 */
function normalizeStringMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalized = normalizeOptionalString(typeof entry === 'number' ? String(entry) : entry);
    if (normalized) {
      result[key] = normalized;
    }
  }

  return result;
}

async function readActiveSessionIndex(normalized) {
  try {
    const data = parseSimpleYaml(await readFile(normalized.activeSessionsIndexPath, 'utf8'), {
      sourceName: normalized.activeSessionsIndexPath,
    });
    return {
      current: normalizeOptionalString(data.current),
    };
  } catch {
    return {
      current: null,
    };
  }
}

async function upsertActiveSessionIndex(normalized, lane, options = {}) {
  // D-277: callers must select `current` explicitly; the upsert never derives
  // a current lane from the lane being written or a stale existing pointer.
  if (!('current' in options)) {
    throw new Error('upsertActiveSessionIndex requires an explicit current-lane selection.');
  }

  const lanes = await listActiveSessionLanes(normalized);
  const laneMap = new Map(lanes.map((item) => [item.id, item]));
  if (lane) {
    laneMap.set(lane.id, {
      id: lane.id,
      status: lane.status,
      workingOn: lane.workingOn,
    });
  }

  await mkdir(normalized.activeSessionsDir, { recursive: true });
  await writeFile(normalized.activeSessionsIndexPath, renderActiveSessionIndex(options.current, [...laneMap.values()]), 'utf8');
}

/**
 * Removes a closed lane from the active index and returns the surviving lane
 * state used to refresh the Current session block. `lanes` contains the full
 * lane metadata read from each sibling lane's `session.yaml` / `wip.md`.
 */
async function removeActiveSessionFromIndex(normalized, sessionId) {
  const index = await readActiveSessionIndex(normalized);
  const lanes = (await listActiveSessionLanes(normalized)).filter((lane) => lane.id !== sessionId);
  // D-277: a surviving pointer is kept only when it names a surviving lane; a
  // sole survivor may become current implicitly, but with 2+ survivors the
  // pointer goes null until an explicit switch-session / marker selection.
  // This also repairs stale pointers that named an already-missing lane.
  const keptPointer =
    index.current && index.current !== sessionId && lanes.some((lane) => lane.id === index.current)
      ? index.current
      : null;
  const current = keptPointer ?? (lanes.length === 1 ? lanes[0].id : null);
  if (lanes.length === 0) {
    await rm(normalized.activeSessionsIndexPath, { force: true });
    return {
      current: null,
      lanes,
    };
  }

  await writeFile(normalized.activeSessionsIndexPath, renderActiveSessionIndex(current, lanes), 'utf8');
  return {
    current,
    lanes,
  };
}

async function listFinalizedSessions(sessionsDir) {
  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name.match(SESSION_FILENAME_PATTERN))
      .filter(Boolean)
      .map((match) => ({
        sessionDate: match[1],
        sessionNumber: Number(match[2]),
        slug: match[3],
      }))
      .sort((left, right) => {
        if (left.sessionDate !== right.sessionDate) {
          return left.sessionDate.localeCompare(right.sessionDate);
        }

        return left.sessionNumber - right.sessionNumber;
      });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

function parseActiveSession(wipContent, wipFilePath = 'sessions/active/<lane-id>/wip.md') {
  const match = wipContent.match(WIP_HEADER_PATTERN);
  if (!match) {
    throw new Error(`${wipFilePath} is missing the expected "# WIP — YYYY-MM-DD (session N)" header.`);
  }

  return {
    sessionDate: match[1],
    sessionNumber: Number(match[2]),
  };
}

function extractSectionBody(content, sectionTitle) {
  const heading = `## ${sectionTitle}`.toLowerCase();
  const lines = content.split('\n');
  const collected = [];
  let inSection = false;

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (inSection) {
        break;
      }

      inSection = line.trim().toLowerCase() === heading;
      continue;
    }

    if (inSection) {
      collected.push(line);
    }
  }

  const body = collected.join('\n').trim();
  return body.length > 0 ? body : null;
}

function findCurrentSessionFence(content) {
  const headingIndex = content.indexOf('## Current session');
  if (headingIndex < 0) {
    return null;
  }

  const afterHeading = content.slice(headingIndex);
  const fencePattern = /```[^\n]*\n([\s\S]*?)\n```/g;

  for (const match of afterHeading.matchAll(fencePattern)) {
    const body = match[1];
    if (!CURRENT_SESSION_REQUIRED_FIELDS.every((field) => body.includes(field))) {
      continue;
    }

    const fullMatch = match[0];
    const fullMatchIndex = match.index ?? 0;
    const bodyOffset = fullMatch.indexOf(body);
    const bodyStart = headingIndex + fullMatchIndex + bodyOffset;

    return {
      body,
      bodyStart,
      bodyEnd: bodyStart + body.length,
    };
  }

  return null;
}

function renderWipTemplate(options) {
  return `# WIP — ${options.sessionDate} (session ${options.sessionNumber})

Session lane: ${options.sessionId}

## Working on
${options.workingOn}

## Log
- Opened session ${options.sessionNumber}. Working on: ${options.workingOn}

## Reviewer input needed
- None yet.

## Review log
`;
}

function renderHandoffTemplate(options) {
  return `# Handoff — ${options.sessionDate} (session ${options.sessionNumber})

Session lane: ${options.sessionId}

## Builder → Reviewer

### What changed
- Opened session ${options.sessionNumber}. No implementation work has been recorded yet.

### What needs review
- None yet.

### What's next
- ${options.workingOn}

## Reviewer → Builder

### Findings summary
- Review not requested yet.

### Recommended next step
- Continue the builder work and request review after the first substantive change block.
`;
}

function renderLaneMetadata(options) {
  return [
    `id: ${options.sessionId}`,
    'status: active',
    `session_date: ${options.sessionDate}`,
    `session_number: ${options.sessionNumber}`,
    `working_on: ${quoteYamlString(options.workingOn)}`,
    renderYamlArray('feature_slugs', options.features),
    renderYamlArray('repos', options.repos),
    renderYamlArray('claimed_paths', options.claims),
    `started_at: ${formatLocalDateTime(new Date())}`,
    ...(options.branch ? [`branch: ${quoteYamlString(options.branch)}`] : []),
    ...(options.worktreeContainer ? [`worktree_container: ${quoteYamlString(options.worktreeContainer)}`] : []),
    ...renderYamlBlockMapLines('worktrees', options.worktrees),
    ...renderYamlBlockMapLines('worktree_sources', options.worktreeSources),
    ...renderYamlBlockMapLines('base_revisions', options.baseRevisions),
    ...(options.laneMarker
      ? [
          'lane_marker:',
          `  path: ${quoteYamlString(options.laneMarker.path)}`,
          `  token: ${quoteYamlString(options.laneMarker.token)}`,
          `  created_at: ${options.laneMarker.createdAt}`,
        ]
      : []),
    'decision_snapshot:',
    `  highest_decision_id: ${options.highestDecisionId ?? 'null'}`,
    '',
  ].join('\n');
}

/**
 * One-level block map of id keys to quoted string values, omitted entirely
 * when empty. Writers validate keys with isSimpleYamlKeySafe before recording
 * them — an unparseable key would null-degrade the whole lane for readers.
 */
function renderYamlBlockMapLines(key, map) {
  const entries = map ? Object.entries(map).filter(([, value]) => value !== null && value !== undefined) : [];
  if (entries.length === 0) {
    return [];
  }

  return [
    `${key}:`,
    ...entries.map(([mapKey, value]) => `  ${mapKey}: ${quoteYamlString(String(value))}`),
  ];
}

function renderActiveSessionIndex(current, lanes) {
  const lines = [
    `current: ${current ?? 'null'}`,
    'lanes:',
  ];

  for (const lane of lanes.sort((left, right) => left.id.localeCompare(right.id))) {
    lines.push(`  - id: ${lane.id}`);
    lines.push(`    status: ${lane.status ?? 'active'}`);
    lines.push(`    working_on: ${quoteYamlString(lane.workingOn ?? '')}`);
  }

  return `${lines.join('\n')}\n`;
}

function renderYamlArray(key, values) {
  if (!values || values.length === 0) {
    return `${key}: []`;
  }

  return [
    `${key}:`,
    ...values.map((value) => `  - ${quoteYamlString(value)}`),
  ].join('\n');
}

function quoteYamlString(value) {
  return JSON.stringify(value);
}

function renderSessionNote(options) {
  return `# Session — ${options.sessionDate}-${options.sessionNumber} — ${options.title}

## What we worked on
${options.workedOn}

## Completed
${renderBulletList(options.completed)}

## Decisions made
${renderBulletList(options.decisions, 'No new decisions were logged in this session.')}

## Models used
${renderBulletList(options.models)}

## Document maintenance checkpoint
${renderDocumentMaintenanceCheckpoint(options.documentMaintenance)}

## Blockers / open questions
${renderBulletList(options.blockers, 'No blocker remains.')}

## Next session should start with
${renderOrderedList(options.nextSteps)}
`;
}

function renderDocumentMaintenanceCheckpoint(documentMaintenance) {
  return DOCUMENT_MAINTENANCE_FIELDS
    .map((field) => `- ${field.label}: ${documentMaintenance[field.key]}`)
    .join('\n');
}

function renderBulletList(items, fallback) {
  if (items.length === 0) {
    return `- ${fallback}`;
  }

  return items.map((item) => `- ${item}`).join('\n');
}

function renderOrderedList(items) {
  return items.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

function summarizeList(items) {
  return items.join('; ');
}

function summarizeOrderedList(items) {
  return items.map((item, index) => `${index + 1}. ${item}`).join(' ');
}

function slugifyTitle(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => normalizeOptionalString(item))
    .filter(Boolean);
}

function normalizeSessionDate(value) {
  if (typeof value === 'string') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error('Session date must use YYYY-MM-DD.');
    }

    return value;
  }

  const date = value instanceof Date ? value : new Date();
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

async function readHighestDecisionId(rootDir) {
  try {
    const scanResult = await scanProjectMemory(rootDir);
    const decisionIds = scanResult.documents.flatMap((document) => document.extracted?.decision_ids ?? []);
    return decisionIds.reduce((max, id) => Math.max(max, id), 0) || null;
  } catch {
    return null;
  }
}

function buildOverlapWarnings(options) {
  const warnings = [];
  for (const lane of options.existingLanes) {
    const sharedFeatures = intersect(options.features, lane.features ?? []);
    if (sharedFeatures.length > 0) {
      warnings.push(
        `Active session lane "${options.sessionId}" overlaps "${lane.id}" on feature(s): ${sharedFeatures.join(', ')}.`,
      );
    }

    const claimOverlaps = findClaimOverlaps(options.claims, lane.claims ?? []);
    for (const overlap of claimOverlaps) {
      warnings.push(
        `Active session lane "${options.sessionId}" overlaps "${lane.id}" on claimed path ${overlap.repo}:${overlap.path}.`,
      );
    }

    const sharedRepos = intersect(options.repos, lane.repos ?? []);
    if (sharedRepos.length > 0 && options.claims.length === 0 && (lane.claims ?? []).length === 0) {
      warnings.push(
        `Active session lane "${options.sessionId}" shares repo(s) ${sharedRepos.join(', ')} with "${lane.id}" without path claims; add --claim values to clarify ownership.`,
      );
    }
  }

  return warnings;
}

function collectLaneMetadataWarnings(lanes) {
  return lanes.flatMap((lane) => lane.warnings ?? []);
}

function intersect(left, right) {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item));
}

function findClaimOverlaps(leftClaims, rightClaims) {
  const overlaps = [];
  for (const left of leftClaims.map(parseClaim).filter(Boolean)) {
    for (const right of rightClaims.map(parseClaim).filter(Boolean)) {
      if (left.repo !== right.repo) {
        continue;
      }

      if (pathPrefixesOverlap(left.path, right.path)) {
        overlaps.push({
          repo: left.repo,
          path: left.path.length <= right.path.length ? left.path : right.path,
        });
      }
    }
  }

  return overlaps;
}

function parseClaim(value) {
  const separatorIndex = value.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    return null;
  }

  return {
    repo: value.slice(0, separatorIndex),
    path: normalizeClaimPath(value.slice(separatorIndex + 1)),
  };
}

function normalizeClaimPath(value) {
  return value.replace(/^\/+/, '').replace(/\/+$/, '');
}

function pathPrefixesOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function parseNullableNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatLocalDateTime(date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absOffset / 60)).padStart(2, '0')}:${String(absOffset % 60).padStart(2, '0')}`;

  return [
    date.getFullYear(),
    '-',
    String(date.getMonth() + 1).padStart(2, '0'),
    '-',
    String(date.getDate()).padStart(2, '0'),
    'T',
    String(date.getHours()).padStart(2, '0'),
    ':',
    String(date.getMinutes()).padStart(2, '0'),
    ':',
    String(date.getSeconds()).padStart(2, '0'),
    offset,
  ].join('');
}

function requireNonEmptyString(value, message) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(message);
  }

  return normalized;
}

function normalizeOptionalString(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}
