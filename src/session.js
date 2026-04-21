import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSimpleYaml } from './simple-yaml.js';
import { buildCloseSessionGuidance, resolveWorkflowSettings } from './workflow.js';

const CURRENT_SESSION_REQUIRED_FIELDS = ['Date:', 'Working on:', 'Last thing completed:', 'Blockers:', 'Next session should:'];
const WIP_HEADER_PATTERN = /^# WIP — (\d{4}-\d{2}-\d{2}) \(session (\d+)\)$/m;
const SESSION_FILENAME_PATTERN = /^(\d{4}-\d{2}-\d{2})-(\d+)-([a-z0-9-]+)\.md$/i;

export async function startProjectSession(options) {
  const normalized = normalizeSessionPaths(options);
  const workingOn = requireNonEmptyString(options?.workingOn, 'start-session requires a non-empty workingOn value.');
  const sessionDate = normalizeSessionDate(options?.date);

  await ensureInitializedProjectMemory(normalized.rootDir);
  const claude = await readClaudeFile(normalized.claudePath);

  if ((await fileExists(normalized.wipFilePath)) || (await fileExists(normalized.handoffFilePath))) {
    throw new Error(
      `An active session scratch file already exists under ${normalized.sessionsDir}. Close or recover the existing session before starting a new one.`,
    );
  }

  const nextSessionNumber = await getNextSessionNumber(normalized.sessionsDir, sessionDate);
  const currentSession = parseCurrentSessionBlock(claude.content);
  const updatedClaude = replaceCurrentSessionBlock(claude.content, {
    date: `${sessionDate} (session ${nextSessionNumber})`,
    workingOn,
    lastThingCompleted:
      normalizeOptionalString(options?.lastThingCompleted) ??
      currentSession.lastThingCompleted ??
      'Project memory bootstrap completed.',
    blockers: normalizeOptionalString(options?.blockers) ?? 'No blocker yet.',
    nextSessionShould:
      normalizeOptionalString(options?.nextSessionShould) ??
      'Finish the active session and close it with a finalized session note.',
  });

  await mkdir(normalized.sessionsDir, { recursive: true });
  await writeFile(normalized.claudePath, updatedClaude, 'utf8');
  await writeFile(
    normalized.wipFilePath,
    renderWipTemplate({
      sessionDate,
      sessionNumber: nextSessionNumber,
      workingOn,
    }),
    'utf8',
  );
  await writeFile(
    normalized.handoffFilePath,
    renderHandoffTemplate({
      sessionDate,
      sessionNumber: nextSessionNumber,
      workingOn,
    }),
    'utf8',
  );

  return {
    rootDir: normalized.rootDir,
    toolingRootDir: normalized.toolingRootDir,
    claudePath: normalized.claudePath,
    wipFilePath: normalized.wipFilePath,
    handoffFilePath: normalized.handoffFilePath,
    sessionDate,
    sessionNumber: nextSessionNumber,
  };
}

export async function closeProjectSession(options) {
  const normalized = normalizeSessionPaths(options);
  const title = requireNonEmptyString(options?.title, 'close-session requires a non-empty title.');
  const completed = normalizeStringArray(options?.completed);
  const models = normalizeStringArray(options?.models);
  const nextSteps = normalizeStringArray(options?.nextSteps);
  const decisions = normalizeStringArray(options?.decisions);
  const blockers = normalizeStringArray(options?.blockers);

  if (completed.length === 0) {
    throw new Error('close-session requires at least one completed item.');
  }

  if (nextSteps.length === 0) {
    throw new Error('close-session requires at least one next-step entry.');
  }

  await ensureInitializedProjectMemory(normalized.rootDir, { allowMissingProjectFile: true });
  const claude = await readClaudeFile(normalized.claudePath);
  const workflowSettings = await readWorkflowSettings(normalized.projectFilePath);

  if (!(await fileExists(normalized.wipFilePath))) {
    throw new Error(
      `No active session scratchpad exists at ${normalized.wipFilePath}. Start a session before trying to close it.`,
    );
  }

  const wipContent = await readFile(normalized.wipFilePath, 'utf8');
  const activeSession = parseActiveSession(wipContent);
  const currentSession = parseCurrentSessionBlock(claude.content);
  const workedOn =
    normalizeOptionalString(options?.workedOn) ??
    extractSectionBody(wipContent, 'Working on') ??
    currentSession.workingOn;

  if (!workedOn) {
    throw new Error('close-session could not determine what the session worked on. Pass workedOn explicitly.');
  }

  const sessionSlug = slugifyTitle(title);
  if (!sessionSlug) {
    throw new Error('close-session title must contain at least one letter or number.');
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

  const hadHandoff = await fileExists(normalized.handoffFilePath);
  await rm(normalized.wipFilePath, { force: true });
  if (hadHandoff) {
    await rm(normalized.handoffFilePath, { force: true });
  }

  const updatedClaude = replaceCurrentSessionBlock(claude.content, {
    date: `${activeSession.sessionDate} (session ${activeSession.sessionNumber})`,
    workingOn: 'Session closed. Ready for the next builder session.',
    lastThingCompleted:
      normalizeOptionalString(options?.lastThingCompleted) ??
      `Closed session ${activeSession.sessionNumber} and wrote \`${sessionRelativePath}\`.`,
    blockers: blockers.length > 0 ? summarizeList(blockers) : 'No blocker remains.',
    nextSessionShould:
      normalizeOptionalString(options?.nextSessionShould) ?? summarizeOrderedList(nextSteps),
  });

  await writeFile(normalized.claudePath, updatedClaude, 'utf8');

  return {
    rootDir: normalized.rootDir,
    toolingRootDir: normalized.toolingRootDir,
    claudePath: normalized.claudePath,
    projectFilePath: normalized.projectFilePath,
    sessionFilePath,
    sessionRelativePath,
    sessionDate: activeSession.sessionDate,
    sessionNumber: activeSession.sessionNumber,
    workflowGuidance: buildCloseSessionGuidance(workflowSettings),
    removedScratchFiles: [
      normalized.wipFilePath,
      ...(hadHandoff ? [normalized.handoffFilePath] : []),
    ],
  };
}

function normalizeSessionPaths(options) {
  const cwd = options?.cwd ? path.resolve(options.cwd) : process.cwd();

  return {
    rootDir: path.resolve(cwd, options?.rootDir ?? '.compass'),
    toolingRootDir: options?.toolingRootDir
      ? path.resolve(cwd, options.toolingRootDir)
      : cwd,
    projectFilePath: path.resolve(path.resolve(cwd, options?.rootDir ?? '.compass'), 'project.yaml'),
    claudePath: path.resolve(
      options?.toolingRootDir ? path.resolve(cwd, options.toolingRootDir) : cwd,
      'CLAUDE.md',
    ),
    sessionsDir: path.resolve(path.resolve(cwd, options?.rootDir ?? '.compass'), 'sessions'),
    wipFilePath: path.resolve(path.resolve(cwd, options?.rootDir ?? '.compass'), 'sessions/wip.md'),
    handoffFilePath: path.resolve(path.resolve(cwd, options?.rootDir ?? '.compass'), 'sessions/handoff.md'),
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

async function getNextSessionNumber(sessionsDir, sessionDate) {
  const sessions = await listFinalizedSessions(sessionsDir);
  const todaysSessions = sessions.filter((session) => session.sessionDate === sessionDate);
  const highestNumber = todaysSessions.reduce((max, session) => Math.max(max, session.sessionNumber), 0);
  return highestNumber + 1;
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

function parseActiveSession(wipContent) {
  const match = wipContent.match(WIP_HEADER_PATTERN);
  if (!match) {
    throw new Error('sessions/wip.md is missing the expected "# WIP — YYYY-MM-DD (session N)" header.');
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
