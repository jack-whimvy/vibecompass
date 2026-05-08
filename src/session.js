import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSimpleYaml } from './simple-yaml.js';
import { buildCloseSessionGuidance, resolveWorkflowSettings } from './workflow.js';
import { syncAgentInstructionFiles } from './generators/agent-files/index.js';

const CURRENT_SESSION_REQUIRED_FIELDS = ['Date:', 'Working on:', 'Last thing completed:', 'Blockers:', 'Next session should:'];
const WIP_HEADER_PATTERN = /^# WIP — (\d{4}-\d{2}-\d{2}) \(session (\d+)\)$/m;
const SESSION_FILENAME_PATTERN = /^(\d{4}-\d{2}-\d{2})-(\d+)-([a-z0-9-]+)\.md$/i;
const LANE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const RESERVED_LANE_IDS = new Set([
  'active',
  'current',
  'default',
  'false',
  'handoff',
  'index',
  'new',
  'no',
  'null',
  'off',
  'on',
  'sessions',
  'state',
  'true',
  'wip',
  'yes',
]);

export async function startProjectSession(options) {
  const normalized = normalizeSessionPaths(options);
  const workingOn = requireNonEmptyString(options?.workingOn, 'start-session requires a non-empty workingOn value.');
  const sessionDate = normalizeSessionDate(options?.date);

  await ensureInitializedProjectMemory(normalized.rootDir);
  const claude = await readClaudeFile(normalized.claudePath);
  const sessionId = await resolveStartSessionId(normalized, options);
  const lanePaths = getLanePaths(normalized, sessionId);

  const nextSessionNumber = await getNextSessionNumber(normalized.sessionsDir, sessionDate);
  const currentSession = parseCurrentSessionBlock(claude.content);
  const updatedClaude = replaceCurrentSessionBlock(claude.content, {
    date: `${sessionDate} (session ${nextSessionNumber}, lane ${sessionId})`,
    workingOn: `${workingOn} [${sessionId}]`,
    lastThingCompleted:
      normalizeOptionalString(options?.lastThingCompleted) ??
      currentSession.lastThingCompleted ??
      'Project memory bootstrap completed.',
    blockers: normalizeOptionalString(options?.blockers) ?? 'No blocker yet.',
    nextSessionShould:
      normalizeOptionalString(options?.nextSessionShould) ??
      'Finish the active session and close it with a finalized session note.',
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
      features: normalizeStringArray(options?.features),
      repos: normalizeStringArray(options?.repos),
      claims: normalizeStringArray(options?.claims),
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
  await upsertActiveSessionIndex(normalized, {
    id: sessionId,
    status: 'active',
    workingOn,
  }, { current: sessionId });
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
    agentFileSync,
  };
}

export async function closeProjectSession(options) {
  const normalized = normalizeSessionPaths(options);
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
  const claude = await readClaudeFile(normalized.claudePath);
  const workflowSettings = await readWorkflowSettings(normalized.projectFilePath);
  const sessionId = await resolveExistingSessionId(normalized, options);
  const lanePaths = sessionId ? getLanePaths(normalized, sessionId) : normalized;

  if (!(await fileExists(lanePaths.wipFilePath))) {
    throw new Error(
      `No active session scratchpad exists at ${lanePaths.wipFilePath}. Start a session before trying to close it.`,
    );
  }

  const wipContent = await readFile(lanePaths.wipFilePath, 'utf8');
  const activeSession = parseActiveSession(wipContent, lanePaths.wipFilePath);
  const currentSession = parseCurrentSessionBlock(claude.content);
  const workedOn =
    normalizeOptionalString(options?.workedOn) ??
    extractSectionBody(wipContent, 'Working on') ??
    currentSession.workingOn;

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
      blockers,
      nextSteps,
    }),
    'utf8',
  );

  const hadHandoff = await fileExists(lanePaths.handoffFilePath);
  let activeSessionIndex = null;
  if (sessionId) {
    await rm(lanePaths.laneDir, { recursive: true, force: true });
    activeSessionIndex = await removeActiveSessionFromIndex(normalized, sessionId);
  } else {
    await rm(lanePaths.wipFilePath, { force: true });
    if (hadHandoff) {
      await rm(lanePaths.handoffFilePath, { force: true });
    }
  }

  const closedSummary = `Closed session ${activeSession.sessionNumber} and wrote \`${sessionRelativePath}\`.`;
  const updatedClaude = replaceCurrentSessionBlock(
    claude.content,
    activeSessionIndex?.current
      ? buildCurrentSessionFieldsForLane(activeSessionIndex.lanes.find((lane) => lane.id === activeSessionIndex.current), {
          lastThingCompleted: normalizeOptionalString(options?.lastThingCompleted) ?? closedSummary,
        })
      : {
          date: `${activeSession.sessionDate} (session ${activeSession.sessionNumber})`,
          workingOn: 'Session closed. Ready for the next builder session.',
          lastThingCompleted: normalizeOptionalString(options?.lastThingCompleted) ?? closedSummary,
          blockers: blockers.length > 0 ? summarizeList(blockers) : 'No blocker remains.',
          nextSessionShould:
            normalizeOptionalString(options?.nextSessionShould) ?? summarizeOrderedList(nextSteps),
        },
  );

  await writeFile(normalized.claudePath, updatedClaude, 'utf8');
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
    workflowGuidance: buildCloseSessionGuidance(workflowSettings),
    agentFileSync,
    removedScratchFiles: [
      lanePaths.wipFilePath,
      ...(hadHandoff ? [lanePaths.handoffFilePath] : []),
    ],
  };
}

export async function listProjectSessions(options = {}) {
  const normalized = normalizeSessionPaths(options);
  await ensureInitializedProjectMemory(normalized.rootDir, { allowMissingProjectFile: true });
  const index = await readActiveSessionIndex(normalized);
  const lanes = await listActiveSessionLanes(normalized);

  return {
    rootDir: normalized.rootDir,
    current: index.current ?? lanes[0]?.id ?? null,
    lanes,
  };
}

export async function switchProjectSession(options = {}) {
  const normalized = normalizeSessionPaths(options);
  const sessionId = validateLaneId(requireNonEmptyString(options?.sessionId, 'switch-session requires a session ID.'));
  const lanes = await listActiveSessionLanes(normalized);
  const lane = lanes.find((item) => item.id === sessionId);

  if (!lane) {
    throw new Error(`Active session lane "${sessionId}" does not exist.`);
  }

  await upsertActiveSessionIndex(normalized, null, { current: sessionId });
  const claude = await readClaudeFile(normalized.claudePath);
  await writeFile(
    normalized.claudePath,
    replaceCurrentSessionBlock(
      claude.content,
      buildCurrentSessionFieldsForLane(lane, {
        lastThingCompleted: `Switched current lane to ${sessionId}.`,
      }),
    ),
    'utf8',
  );
  const agentFileSync = await syncAgentInstructionFilesSafely({
    rootDir: normalized.rootDir,
    toolingRootDir: normalized.toolingRootDir,
  });

  return {
    rootDir: normalized.rootDir,
    claudePath: normalized.claudePath,
    current: sessionId,
    lanes,
    agentFileSync,
  };
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

function normalizeSessionPaths(options) {
  const cwd = options?.cwd ? path.resolve(options.cwd) : process.cwd();
  const rootDir = path.resolve(cwd, options?.rootDir ?? '.compass');
  const toolingRootDir = options?.toolingRootDir
    ? path.resolve(cwd, options.toolingRootDir)
    : cwd;

  return {
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

async function readWorkflowSettings(projectFilePath) {
  try {
    const source = await readFile(projectFilePath, 'utf8');
    const data = parseSimpleYaml(source, { sourceName: projectFilePath });
    return resolveWorkflowSettings(data);
  } catch {
    return resolveWorkflowSettings(null);
  }
}

async function readClaudeFile(claudePath) {
  if (!(await fileExists(claudePath))) {
    throw new Error(
      `No CLAUDE.md was found at ${claudePath}. Re-run "vibecompass init --with-claude" or create a compatible Current session block first.`,
    );
  }

  return {
    path: claudePath,
    content: await readFile(claudePath, 'utf8'),
  };
}

function parseCurrentSessionBlock(content) {
  const sessionFence = findCurrentSessionFence(content);
  if (!sessionFence) {
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

function replaceCurrentSessionBlock(content, fields) {
  const sessionFence = findCurrentSessionFence(content);
  if (!sessionFence) {
    throw new Error('CLAUDE.md is missing a recognizable "## Current session" fenced block.');
  }

  const blockBody = [
    `Date: ${fields.date}`,
    `Working on: ${fields.workingOn}`,
    `Last thing completed: ${fields.lastThingCompleted}`,
    `Blockers: ${fields.blockers}`,
    `Next session should: ${fields.nextSessionShould}`,
  ].join('\n');

  return `${content.slice(0, sessionFence.bodyStart)}${blockBody}${content.slice(sessionFence.bodyEnd)}`;
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

async function resolveExistingSessionId(normalized, options) {
  const explicitId = normalizeOptionalString(options?.sessionId);
  if (explicitId) {
    return validateLaneId(explicitId);
  }

  const lanes = await listActiveSessionLanes(normalized);
  if (lanes.length === 1) {
    return lanes[0].id;
  }

  if (lanes.length > 1) {
    throw new Error('Multiple active session lanes exist. Pass --session to choose which lane to close.');
  }

  return null;
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
      sessionDate: normalizeOptionalString(data.session_date),
      sessionNumber: typeof data.session_number === 'number' ? data.session_number : Number(data.session_number) || null,
    };
  } catch {
    return {
      status: null,
      workingOn: null,
      features: [],
      repos: [],
      claims: [],
      sessionDate: null,
      sessionNumber: null,
    };
  }
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
  const currentIndex = await readActiveSessionIndex(normalized);
  const lanes = await listActiveSessionLanes(normalized);
  const laneMap = new Map(lanes.map((item) => [item.id, item]));
  if (lane) {
    laneMap.set(lane.id, {
      id: lane.id,
      status: lane.status,
      workingOn: lane.workingOn,
    });
  }

  const current = options.current ?? currentIndex.current ?? lane?.id ?? null;
  await mkdir(normalized.activeSessionsDir, { recursive: true });
  await writeFile(normalized.activeSessionsIndexPath, renderActiveSessionIndex(current, [...laneMap.values()]), 'utf8');
}

/**
 * Removes a closed lane from the active index and returns the surviving lane
 * state used to refresh the Current session block. `lanes` contains the full
 * lane metadata read from each sibling lane's `session.yaml` / `wip.md`.
 */
async function removeActiveSessionFromIndex(normalized, sessionId) {
  const index = await readActiveSessionIndex(normalized);
  const lanes = (await listActiveSessionLanes(normalized)).filter((lane) => lane.id !== sessionId);
  const current = index.current === sessionId ? lanes[0]?.id ?? null : index.current;
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

function validateLaneId(value) {
  const normalized = value.trim();
  if (!LANE_ID_PATTERN.test(normalized)) {
    throw new Error('Session lane ID must be a lowercase slug 3-64 characters long using letters, numbers, and hyphens.');
  }

  if (RESERVED_LANE_IDS.has(normalized)) {
    throw new Error(`Session lane ID "${normalized}" is reserved.`);
  }

  return normalized;
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
    `started_at: ${new Date().toISOString()}`,
    'decision_snapshot:',
    '  highest_decision_id: null',
    '',
  ].join('\n');
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

## Blockers / open questions
${renderBulletList(options.blockers, 'No blocker remains.')}

## Next session should start with
${renderOrderedList(options.nextSteps)}
`;
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
