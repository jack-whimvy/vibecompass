import { readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BRIEF_CONTRACT_VERSION,
  BRIEF_DEFAULT_BUDGET,
  BRIEF_OVERVIEW_PATH,
  buildSessionBrief,
  computeBriefCorpusDigest,
  describeBriefInputs,
  hashBriefInputs,
  readBriefLaneBindings,
} from './brief.js';
import { renderBrief } from './brief-render.js';
import { compileBriefExclusions, readBriefSettingsForRoot } from './brief-settings.js';
import { parseFrontmatter } from './frontmatter.js';
import { validateLaneId } from './lane-marker.js';
import { scanProjectMemory } from './project-memory.js';
import { withMemoryRootLock } from './serialization.js';
import { parseSimpleYaml } from './simple-yaml.js';
import { PACKAGE_VERSION } from './version.js';

/**
 * The session brief in the lane lifecycle (plan task A4; D-359, D-364).
 * `start-session` and `continue-session` write `sessions/active/<lane-id>/
 * brief.md` — local-only lane scratch (D-278) and a generated view (D-357) —
 * whose YAML header binds the inputs the brief read, so staleness can be
 * computed later without trusting a stored flag. During D-255 dogfood an
 * explicit source root can be read instead of the lane's own root; it is only
 * ever read. Contract: `architecture/platform/project-memory/session-brief.md`.
 */

export const LANE_BRIEF_FILENAME = 'brief.md';
export const LANE_BRIEF_FORMAT = 1;
const MAX_HEADER_INPUTS = 24;
const MAX_REASON_LENGTH = 400;

export function laneBriefPath(rootDir, laneId) {
  return path.join(path.resolve(rootDir), 'sessions', 'active', laneId, LANE_BRIEF_FILENAME);
}

/**
 * Generates and writes the lane's `brief.md` under the destination root's
 * memory-root lock. The brief reads `sourceRootDir` when given (the dual-root
 * adapter, after the lane-correspondence check), otherwise the lane's own
 * root. A refused or unresolvable source, a build error, and memory that
 * could not be read still write an `incomplete` brief whose header says
 * `generation: "failed"` with the reason, returned as `refused` or `failed`.
 * A brief that is incomplete only because mandatory units overflowed the
 * budget is a successful generation (`written`). Only errors that prevent
 * writing the file throw.
 */
export async function generateLaneBrief(options = {}) {
  const destinationRoot = path.resolve(requireString(options.rootDir, 'generateLaneBrief requires rootDir.'));
  const laneId = validateLaneId(requireString(options.laneId, 'generateLaneBrief requires laneId.'));
  const budget = options.budget ?? BRIEF_DEFAULT_BUDGET;
  const build = options.buildBrief ?? buildSessionBrief;
  if (options.sourceSessionId && !options.sourceRootDir) {
    throw new Error('--source-session requires --source-root; without a source root the brief reads the lane\'s own root.');
  }
  const requestedSource = options.sourceRootDir ? path.resolve(options.sourceRootDir) : null;

  return withMemoryRootLock(destinationRoot, 'brief', async () => {
    const briefPath = laneBriefPath(destinationRoot, laneId);
    if (!(await isFile(path.join(path.dirname(briefPath), 'session.yaml')))) {
      throw new Error(`Session lane "${laneId}" is not an active lane in ${destinationRoot}; a brief is written only into an open lane.`);
    }

    const generatedAt = formatLocalDateTime(options.now ?? new Date());
    const frame = { destinationRoot, laneId, generatedAt, budget, requestedSource };
    let source;
    try {
      source = await resolveBriefSource({
        destinationRoot,
        laneId,
        sourceRootDir: requestedSource ?? undefined,
        sourceSessionId: options.sourceSessionId,
      });
    } catch (error) {
      // A source that cannot even be read (for example an unreadable lane
      // session.yaml) is refused like a non-corresponding one.
      source = {
        adapter: Boolean(requestedSource),
        rootDir: requestedSource ?? destinationRoot,
        laneId,
        repoAliases: {},
        aliasPairs: [],
        refusal: `the source could not be read: ${errorMessage(error)}`,
      };
    }

    const failed = async (state, reason, warning) => {
      await writeLaneBriefFile(briefPath, renderFailedLaneBrief({ ...frame, source, reason }));
      return { state, status: 'incomplete', reason, path: briefPath, source: describeSource(source), warnings: [warning] };
    };

    if (source.refusal) {
      return failed('refused', `the dual-root source was refused: ${source.refusal}`, `Session brief refused (D-364): ${source.refusal}. Fix it, then run: ${briefCommand(frame, 'write')}`);
    }

    // The adapter reads another root, so the destination's exclusions apply
    // too (their union); a destination whose settings cannot be trusted
    // fails closed before the source is read.
    let extraExclude = [];
    if (source.adapter) {
      const destinationSettings = await readBriefSettingsForRoot(destinationRoot);
      if (destinationSettings.problems.length > 0) {
        const reason = `project.yaml brief settings in the destination root are invalid, so no canonical document was read (D-364): ${destinationSettings.problems.join('; ')}`;
        return failed('failed', reason, `Session brief incomplete: ${reason}`);
      }
      extraExclude = destinationSettings.exclude;
    }

    let result;
    try {
      result = await build({
        rootDir: source.rootDir,
        laneId: source.laneId,
        budget,
        exclude: extraExclude,
        repoAliases: source.repoAliases,
      });
    } catch (error) {
      const reason = `the brief engine failed: ${errorMessage(error)}`;
      return failed('failed', reason, `Session brief incomplete: ${reason}. Retry with: ${briefCommand(frame, 'write')}`);
    }

    // The engine reports unreadable memory (invalid settings included) as a
    // returned result, not a throw: that is a failed generation, although
    // its body still lists the reads to make.
    if (result.retrieval_error) {
      const reason = `memory could not be read: ${result.retrieval_error}`;
      await writeLaneBriefFile(briefPath, renderLaneBriefDocument({ ...frame, source, result, failure: reason }));
      return {
        state: 'failed',
        status: result.status,
        reason,
        path: briefPath,
        source: describeSource(source),
        warnings: [`Session brief incomplete: ${reason}. Retry with: ${briefCommand(frame, 'write')}`],
      };
    }

    await writeLaneBriefFile(briefPath, renderLaneBriefDocument({ ...frame, source, result }));
    return {
      state: 'written',
      status: result.status,
      reason: result.status_reason,
      path: briefPath,
      source: describeSource(source),
      warnings: result.status === 'incomplete' ? [`Session brief is incomplete: ${result.status_reason}`] : [],
    };
  });
}

/**
 * Read-only freshness check of a lane's `brief.md` against its header
 * bindings (D-364). The expected source is the one this call names
 * (`sourceRootDir`, else the lane's own root); a brief recorded against any
 * other root is stale, and that recorded root is never read. A check that
 * cannot read what it needs reports the brief stale, never current.
 */
export async function inspectLaneBrief(options = {}) {
  const destinationRoot = path.resolve(requireString(options.rootDir, 'inspectLaneBrief requires rootDir.'));
  const laneId = validateLaneId(requireString(options.laneId, 'inspectLaneBrief requires laneId.'));
  const briefPath = laneBriefPath(destinationRoot, laneId);
  const content = await readOptional(briefPath);
  if (content === null) {
    return { exists: false, path: briefPath, stale: true, reasons: ['no brief.md exists for this lane'], status: null, generatedAt: null, header: null };
  }

  let header;
  try {
    header = parseFrontmatter(content, { sourceName: briefPath }).data;
  } catch (error) {
    header = null;
  }
  const base = { exists: true, path: briefPath, status: optionalString(header?.status), generatedAt: optionalString(header?.generated_at), header };
  const stale = (reasons) => ({ ...base, stale: reasons.length > 0, reasons });

  if (!header || typeof header !== 'object') {
    return stale(['the brief header is missing or unreadable']);
  }
  if (header.brief_format !== LANE_BRIEF_FORMAT || header.contract_version !== BRIEF_CONTRACT_VERSION) {
    return stale([`the brief was written in another format (brief_format ${header.brief_format ?? 'none'}, contract ${header.contract_version ?? 'none'})`]);
  }
  if (header.generation !== 'ok') {
    return stale([`the last generation did not complete${header.reason ? `: ${header.reason}` : ''}`]);
  }

  try {
    return stale(await compareBindings({ header, destinationRoot, laneId, sourceRootDir: options.sourceRootDir, sourceSessionId: options.sourceSessionId }));
  } catch (error) {
    return stale([`freshness could not be checked: ${errorMessage(error)}`]);
  }
}

async function compareBindings({ header, destinationRoot, laneId, sourceRootDir, sourceSessionId }) {
  const source = await resolveBriefSource({ destinationRoot, laneId, sourceRootDir, sourceSessionId });
  if (source.refusal) {
    return [`the dual-root source is refused: ${source.refusal}`];
  }
  if (!(await sameDirectory(header.source_root, source.rootDir))) {
    // Never read the recorded root: only the root this call names is read.
    return [`the brief was built from ${header.source_root ?? 'an unrecorded root'}, and this run reads ${source.rootDir}`];
  }
  if (header.source_lane !== source.laneId || header.destination_lane !== laneId || !(await sameDirectory(header.destination_root, destinationRoot))) {
    return ['the brief is bound to a different lane or destination root'];
  }

  const reasons = [];
  // The alias map comes from both roots' project.yaml; the destination's is
  // not part of the source corpus, so it is compared directly.
  const recordedAliases = Array.isArray(header.repo_aliases) ? header.repo_aliases.map(String) : [];
  if (JSON.stringify(recordedAliases) !== JSON.stringify(source.aliasPairs.map(formatAliasPair))) {
    reasons.push('the repo alias map changed (a destination or source repo id or remote)');
  }

  const sourceSettings = await readBriefSettingsForRoot(source.rootDir);
  const destinationSettings = source.adapter ? await readBriefSettingsForRoot(destinationRoot) : { exclude: [], problems: [] };
  const problems = [...sourceSettings.problems, ...destinationSettings.problems];
  if (problems.length > 0) {
    return [...reasons, `brief settings are invalid, so freshness cannot be checked without reading excluded paths: ${problems.join('; ')}`];
  }
  const exclusions = compileBriefExclusions(uniqueStrings([...sourceSettings.exclude, ...destinationSettings.exclude]));

  const lane = await readBriefLaneBindings(source.rootDir, source.laneId);
  const identity = lane.sessionDate && Number.isInteger(lane.sessionNumber) ? `${lane.sessionDate}-${lane.sessionNumber}` : null;
  if (!identity) {
    reasons.push('the lane has no usable session identity (session_date and session_number)');
  } else if (header.source_session !== identity) {
    reasons.push(`the lane session identity changed (${header.source_session ?? 'none'} → ${identity})`);
  }
  const recordedLane = header.lane_bindings && typeof header.lane_bindings === 'object' ? header.lane_bindings : {};
  if (recordedLane.session !== lane.bindings.session) reasons.push('session.yaml changed (working-on, claims, features, architecture docs, repos, snapshot, or worktrees)');
  if (recordedLane.handoff !== encodeOptionalHash(lane.bindings.handoff)) reasons.push('handoff.md changed');
  if (recordedLane.other_lanes !== lane.bindings.other_lanes) reasons.push('the other active lanes changed');

  const scan = await scanProjectMemory(source.rootDir, { exclude: (relativePath) => exclusions.matches(relativePath) });
  const recordedInputs = parseInputLines(header.inputs);
  const current = hashBriefInputs(scan.documents, recordedInputs.map((input) => input.key));
  const changed = recordedInputs.filter((input) => current.get(input.key) !== input.hash).map((input) => input.key);
  if (changed.length > 0) {
    reasons.push(`changed or removed input${changed.length === 1 ? '' : 's'}: ${changed.slice(0, 6).join(', ')}${changed.length > 6 ? ` (+${changed.length - 6} more)` : ''}`);
  }
  if (header.corpus_digest === 'none') {
    reasons.push('the brief could not read canonical memory when it was generated');
  } else if (header.corpus_digest !== computeBriefCorpusDigest(scan.documents, exclusions.patterns) && changed.length === 0) {
    reasons.push('other canonical memory changed (docs, decisions, notes, or project.yaml), so selection may differ');
  }
  return reasons;
}

/**
 * Lifecycle entry point for `start-session` and `continue-session`. Never
 * throws: a brief failure becomes a warning (and, where possible, an
 * `incomplete` brief), so it cannot overturn an otherwise successful start or
 * resume (D-359). `continue-session` keeps a current brief and regenerates a
 * missing or stale one; a freshness check that fails counts as stale, so the
 * old brief is replaced by one that discloses the failure.
 */
export async function refreshLaneBriefForLifecycle(options = {}) {
  const trigger = options.trigger === 'continue' ? 'continue' : 'start';
  const commandFrame = {
    destinationRoot: typeof options.rootDir === 'string' ? path.resolve(options.rootDir) : '<root>',
    laneId: options.laneId ?? '<lane-id>',
    requestedSource: options.sourceRootDir ? path.resolve(options.sourceRootDir) : null,
  };
  let briefPath = null;
  try {
    const rootDir = path.resolve(requireString(options.rootDir, 'The lifecycle brief requires rootDir.'));
    const laneId = validateLaneId(requireString(options.laneId, 'The lifecycle brief requires laneId.'));
    briefPath = laneBriefPath(rootDir, laneId);

    if (options.disabled === true) {
      return { state: 'off', reason: '--no-brief', path: briefPath, warnings: [] };
    }
    // Opt-in (D-368): only an explicit `brief.enabled: true` generates. Invalid
    // settings still go on to fail closed as a disclosed incomplete brief.
    const settings = await readBriefSettingsForRoot(rootDir);
    if (settings.problems.length === 0 && settings.enabled !== true) {
      const reason = settings.enabledDeclared ? 'project.yaml brief.enabled: false' : 'opt-in; project.yaml does not set brief.enabled: true';
      return { state: 'off', reason, path: briefPath, warnings: [] };
    }

    let previous = null;
    if (trigger === 'continue') {
      try {
        previous = await inspectLaneBrief({ rootDir, laneId, sourceRootDir: options.sourceRootDir, sourceSessionId: options.sourceSessionId });
      } catch (error) {
        previous = { exists: true, stale: true, reasons: [`freshness could not be checked: ${errorMessage(error)}`] };
      }
      if (previous.exists && !previous.stale) {
        return { state: 'kept', status: previous.status, generatedAt: previous.generatedAt, path: briefPath, warnings: [] };
      }
    }

    const generated = await generateLaneBrief({
      rootDir,
      laneId,
      sourceRootDir: options.sourceRootDir,
      sourceSessionId: options.sourceSessionId,
      buildBrief: options.buildBrief,
    });
    return {
      ...generated,
      state: generated.state === 'written' && previous?.exists ? 'regenerated' : generated.state,
      staleReasons: previous?.exists ? previous.reasons : [],
    };
  } catch (error) {
    const message = errorMessage(error);
    return {
      state: 'failed',
      status: null,
      reason: message,
      path: briefPath,
      warnings: [
        `Session brief not written: ${message}. The ${trigger}-session result is unaffected; retry with: ${briefCommand(commandFrame, 'write')} (D-364).`,
      ],
    };
  }
}

/**
 * Resolves where a lane brief reads from. Without `sourceRootDir` it is the
 * lane's own root. With it (D-255 dual-root dogfood, D-364), the source lane
 * must have the destination lane's id, session date, and session number, or
 * the source is refused; repo ids translate from destination to source by
 * matching normalized remotes, then identical ids.
 */
export async function resolveBriefSource({ destinationRoot, laneId, sourceRootDir, sourceSessionId }) {
  const destination = path.resolve(destinationRoot);
  const own = { adapter: false, rootDir: destination, laneId, repoAliases: {}, aliasPairs: [], identity: null, refusal: null };
  if (sourceSessionId && !sourceRootDir) {
    throw new Error('--source-session requires --source-root; without a source root the brief reads the lane\'s own root.');
  }
  if (!sourceRootDir || (await sameDirectory(sourceRootDir, destination))) {
    const { repos } = await readBriefSettingsForRoot(destination);
    const ids = repos.filter((repo) => repo && typeof repo.id === 'string').map((repo) => repo.id).sort();
    return { ...own, aliasPairs: ids.map((id) => ({ destination: id, source: id })) };
  }

  const sourceRoot = path.resolve(sourceRootDir);
  const refuse = (refusal) => ({ ...own, adapter: true, rootDir: sourceRoot, refusal });
  if (sourceSessionId && sourceSessionId !== laneId) {
    return refuse(`--source-session "${sourceSessionId}" does not match the destination lane "${laneId}"; the source lane must have the same id`);
  }
  if (!(await isFile(path.join(sourceRoot, 'project.yaml')))) {
    return refuse(`${sourceRoot} is not a project-memory root (no project.yaml)`);
  }

  const destinationIdentity = await readLaneIdentity(destination, laneId);
  const sourceIdentity = await readLaneIdentity(sourceRoot, laneId);
  if (!destinationIdentity) {
    return refuse(`lane "${laneId}" has no readable session.yaml in the destination root ${destination}`);
  }
  if (!sourceIdentity) {
    return refuse(`the source root ${sourceRoot} has no active lane "${laneId}"; mirror the lane there first (D-255)`);
  }
  if (sourceIdentity.id !== laneId || sourceIdentity.date !== destinationIdentity.date || sourceIdentity.number !== destinationIdentity.number) {
    return refuse(
      `the source lane is session ${formatIdentity(sourceIdentity)} and the destination lane is session ${formatIdentity(destinationIdentity)}; they must be the same lane id, session date, and session number`,
    );
  }

  const [destinationSettings, sourceSettings] = await Promise.all([readBriefSettingsForRoot(destination), readBriefSettingsForRoot(sourceRoot)]);
  const aliasPairs = buildRepoAliasPairs(destinationSettings.repos, sourceSettings.repos);
  const repoAliases = Object.fromEntries(
    aliasPairs.filter((pair) => pair.source && pair.source !== pair.destination).map((pair) => [pair.destination, pair.source]),
  );
  return { adapter: true, rootDir: sourceRoot, laneId, repoAliases, aliasPairs, identity: sourceIdentity, refusal: null };
}

// ---------------------------------------------------------------------------
// brief.md rendering
// ---------------------------------------------------------------------------

function renderLaneBriefDocument({ destinationRoot, laneId, generatedAt, budget, source, result, failure = null }) {
  const inputs = describeBriefInputs(result);
  const shown = inputs.slice(0, inputs.length > MAX_HEADER_INPUTS ? MAX_HEADER_INPUTS - 1 : MAX_HEADER_INPUTS);
  const folded = inputs.slice(shown.length);
  const lane = result.source.lane_bindings;
  const session = result.source.lane_session;

  const fields = [
    `generation: ${quote(failure ? 'failed' : 'ok')}`,
    `status: ${quote(result.status)}`,
    ...(failure ? [`reason: ${quote(boundReason(failure))}`] : []),
    `budget: ${budget}`,
    `source_root: ${quote(source.rootDir)}`,
    `source_lane: ${quote(source.laneId)}`,
    `source_session: ${quote(session?.date && Number.isInteger(session?.number) ? `${session.date}-${session.number}` : 'unknown')}`,
    `destination_root: ${quote(destinationRoot)}`,
    `destination_lane: ${quote(laneId)}`,
    `corpus_digest: ${quote(result.source.corpus_digest ?? 'none')}`,
    ...renderList('exclude', result.source.exclude ?? []),
    'lane_bindings:',
    `  session: ${quote(lane?.session ?? 'none')}`,
    `  handoff: ${quote(encodeOptionalHash(lane?.handoff ?? null))}`,
    `  other_lanes: ${quote(lane?.other_lanes ?? 'none')}`,
    ...renderList('repo_aliases', source.aliasPairs.map(formatAliasPair)),
    ...renderList('inputs', [
      ...shown.map((input) => `${input.hash} ${input.key}`),
      ...(folded.length > 0 ? [`+${folded.length} more inputs (covered by corpus_digest)`] : []),
    ]),
  ];
  return assembleBriefDocument(commandsFor(destinationRoot, laneId, source), generatedAt, fields, renderBrief(result));
}

function renderFailedLaneBrief({ destinationRoot, laneId, generatedAt, source, reason }) {
  const rootNote = source.rootDir === destinationRoot ? '' : ` (paths are relative to \`${source.rootDir}\`)`;
  const commands = commandsFor(destinationRoot, laneId, source);
  const fields = [
    'generation: "failed"',
    'status: "incomplete"',
    `reason: ${quote(boundReason(reason))}`,
    `source_root: ${quote(source.rootDir)}`,
    `source_lane: ${quote(source.laneId)}`,
    `destination_root: ${quote(destinationRoot)}`,
    `destination_lane: ${quote(laneId)}`,
  ];
  const body = [
    '# Session brief',
    '',
    `**INCOMPLETE — the session brief could not be generated:** ${boundReason(reason)}`,
    '',
    `Read these before planning${rootNote}:`,
    `- \`sessions/active/${laneId}/handoff.md\` — the lane's baton-pass state`,
    `- \`${BRIEF_OVERVIEW_PATH}\` — whole-project orientation`,
    "- `decisions/INDEX.md` — decision index; read each entry's Impact on prior decisions before relying on it",
    '',
    `Retry once the cause is fixed: \`${commands.write}\``,
    '',
  ].join('\n');
  return assembleBriefDocument(commands, generatedAt, fields, body);
}

/** Check and refresh commands that keep this brief's root, lane, and source explicit. */
function commandsFor(destinationRoot, laneId, source) {
  const frame = { destinationRoot, laneId, requestedSource: source.adapter ? source.rootDir : null };
  return { check: briefCommand(frame, 'check'), write: briefCommand(frame, 'write') };
}

function assembleBriefDocument(commands, generatedAt, fields, body) {
  const lines = [
    '---',
    '# Generated session brief (D-357, D-359, D-364); do not edit. It is stale once any binding below changes.',
    `# Check: ${commands.check}`,
    `# Refresh: ${commands.write}`,
    `brief_format: ${LANE_BRIEF_FORMAT}`,
    `contract_version: ${BRIEF_CONTRACT_VERSION}`,
    `generated_at: ${quote(generatedAt)}`,
    `generated_by: ${quote(PACKAGE_VERSION)}`,
    ...fields,
    '---',
    '',
  ];
  const document = `${lines.join('\n')}${body}`;
  // The header must round-trip through the package's YAML subset, or later
  // freshness checks could not read it.
  parseSimpleYaml(lines.slice(1, -2).join('\n'), { sourceName: 'brief.md header' });
  return document;
}

function renderList(key, values) {
  if (values.length === 0) return [`${key}: []`];
  return [`${key}:`, ...values.map((value) => `  - ${quote(value)}`)];
}

function parseInputLines(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => String(value).match(/^([0-9a-f]{16}) (.+)$/))
    .filter(Boolean)
    .map((match) => ({ hash: match[1], key: match[2] }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function writeLaneBriefFile(briefPath, content) {
  const temporary = `${briefPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, briefPath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function readLaneIdentity(rootDir, laneId) {
  const sessionPath = path.join(rootDir, 'sessions', 'active', laneId, 'session.yaml');
  const content = await readOptional(sessionPath);
  if (content === null) return null;
  try {
    const data = parseSimpleYaml(content, { sourceName: sessionPath });
    return {
      id: typeof data?.id === 'string' ? data.id : laneId,
      date: data?.session_date === undefined || data?.session_date === null ? null : String(data.session_date),
      number: Number.isInteger(data?.session_number) ? data.session_number : null,
    };
  } catch {
    return null;
  }
}

function buildRepoAliasPairs(destinationRepos, sourceRepos) {
  const sources = (Array.isArray(sourceRepos) ? sourceRepos : []).filter((repo) => repo && typeof repo.id === 'string');
  return (Array.isArray(destinationRepos) ? destinationRepos : [])
    .filter((repo) => repo && typeof repo.id === 'string')
    .map((repo) => {
      const remote = normalizeRemote(repo.remote);
      const match = (remote && sources.find((candidate) => normalizeRemote(candidate.remote) === remote)) ?? sources.find((candidate) => candidate.id === repo.id) ?? null;
      return { destination: repo.id, source: match?.id ?? null };
    })
    .sort((left, right) => left.destination.localeCompare(right.destination));
}

/** `https://github.com/o/r.git`, `git@github.com:o/r`, and `ssh://git@github.com/o/r` compare equal. */
function normalizeRemote(remote) {
  if (typeof remote !== 'string' || remote.trim() === '') return null;
  return remote
    .trim()
    .toLowerCase()
    .replace(/^[a-z+]+:\/\//, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^/:]+):(?!\d)/, '$1/')
    .replace(/\.git\/?$/, '')
    .replace(/\/+$/, '');
}

/**
 * A `vibecompass brief` command for this lane with its root, lane, and (when
 * one was named) source root spelled out, so following the advice never
 * falls back to another root or fails lane selection.
 */
function briefCommand({ destinationRoot, laneId, requestedSource }, action) {
  return [
    'vibecompass brief',
    '--root',
    shellQuote(destinationRoot),
    '--session',
    shellQuote(laneId),
    `--${action}`,
    ...(requestedSource ? ['--source-root', shellQuote(requestedSource)] : []),
  ].join(' ');
}

function shellQuote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

function formatAliasPair(pair) {
  return `${pair.destination} -> ${pair.source ?? '(no match)'}`;
}

function describeSource(source) {
  return {
    adapter: source.adapter,
    root_dir: source.rootDir,
    lane_id: source.laneId,
    repo_aliases: source.aliasPairs,
  };
}

function encodeOptionalHash(value) {
  return value ?? 'missing';
}

function formatIdentity(identity) {
  return `${identity.id} ${identity.date ?? '?'}-${identity.number ?? '?'}`;
}

async function sameDirectory(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const canonical = async (value) => {
    const resolved = path.resolve(value);
    try {
      return await realpath(resolved);
    } catch {
      return resolved;
    }
  };
  return (await canonical(left)) === (await canonical(right));
}

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function readOptional(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function formatLocalDateTime(date) {
  const pad = (value) => String(value).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function boundReason(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= MAX_REASON_LENGTH ? text : `${text.slice(0, MAX_REASON_LENGTH - 1)}…`;
}

function quote(value) {
  return JSON.stringify(String(value));
}

function uniqueStrings(values) {
  return [...new Set((values ?? []).filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requireString(value, message) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(message);
  return value.trim();
}

function errorMessage(error) {
  return String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_LENGTH);
}
