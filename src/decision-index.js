import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { formatDecisionId, listDecisionFileNames } from './decisions.js';
import { resolveLaneSelection } from './lane-marker.js';
import { listProjectSessions } from './session.js';
import { withMemoryRootLock } from './serialization.js';

/**
 * Grouped structure-preserving decisions/INDEX.md generator (D-283).
 *
 * The existing index file is the source of structure: hand-authored session
 * group headings ("## 2026-07-03 — Session 1 (lane-x lane)") are editorial
 * history no canonical entry records, so regeneration preserves every
 * existing line verbatim and only appends missing rows. Anything the parser
 * cannot round-trip byte-identically fails closed with named findings — the
 * hand-maintained file is never "repaired" by regeneration.
 */

const INDEX_H1 = '# Decision Index';
const TABLE_HEADER = '| # | Decision | Domain |';
const TABLE_SEPARATOR = '|---|----------|--------|';
const TABLE_SEPARATOR_PATTERN = /^\|-+\|-+\|-+\|$/;
const GROUP_HEADING_PATTERN = /^## (.+)$/;
const INDEX_ROW_PATTERN = /^\| (D-\d{3,}) \| (.*) \| \[([A-Za-z0-9_-]+)\]\(([A-Za-z0-9_.-]+)\) \|$/;
const CANONICAL_DECISION_PATTERN = /^###\s+D-(\d+)\s+—\s+(.+)$/gm;
const HYPHEN_ONLY_DECISION_PATTERN = /^###\s+D-(\d+)\s+-\s+(.+)$/gm;

/**
 * Conservative predicate for the flat-generator quarantine (D-209/D-255):
 * any `## ` heading marks the content as grouped-shaped, including malformed
 * grouped files — a broken grouped index must survive a flat overwrite too.
 */
export function looksLikeGroupedDecisionIndex(content) {
  return typeof content === 'string' && /^## /m.test(content);
}

/** Strict structural parse. Returns { ok, problems, lines, groups }. */
export function parseGroupedDecisionIndex(content) {
  const problems = [];

  if (typeof content !== 'string' || content.trim() === '') {
    return { ok: false, problems: ['decisions/INDEX.md is empty or unreadable.'], lines: [], groups: [] };
  }

  if (content.includes('\r')) {
    return { ok: false, problems: ['decisions/INDEX.md uses CRLF line endings; the grouped generator preserves LF files only.'], lines: [], groups: [] };
  }

  const lines = content.split('\n');
  const groups = [];
  const firstNonEmpty = lines.find((line) => line.trim() !== '');
  if (firstNonEmpty !== INDEX_H1) {
    problems.push(`decisions/INDEX.md does not start with the "${INDEX_H1}" title.`);
  }

  let index = 0;
  // Preamble: everything before the first group heading, kept verbatim.
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (GROUP_HEADING_PATTERN.test(line)) {
      break;
    }
    if (line.startsWith('|')) {
      problems.push(`Line ${index + 1} is a table row outside any "## <date> — <session>" group (flat-index shape?).`);
    }
  }

  while (index < lines.length) {
    const headingMatch = lines[index].match(GROUP_HEADING_PATTERN);
    if (!headingMatch) {
      problems.push(`Line ${index + 1} ("${truncate(lines[index])}") was not recognized inside the grouped index structure.`);
      index += 1;
      continue;
    }

    const group = { label: headingMatch[1], headingLineIndex: index, rows: [], lastRowLineIndex: -1 };
    index += 1;
    while (index < lines.length && lines[index].trim() === '') {
      index += 1;
    }

    if (lines[index] !== TABLE_HEADER) {
      problems.push(`Group "${group.label}" is missing the exact "${TABLE_HEADER}" header row (line ${index + 1}).`);
    } else {
      index += 1;
      if (!TABLE_SEPARATOR_PATTERN.test(lines[index] ?? '')) {
        problems.push(`Group "${group.label}" is missing the table separator row (line ${index + 1}).`);
      } else {
        index += 1;
        while (index < lines.length && lines[index].startsWith('|')) {
          const rowMatch = lines[index].match(INDEX_ROW_PATTERN);
          if (!rowMatch) {
            problems.push(`Group "${group.label}" row on line ${index + 1} ("${truncate(lines[index])}") does not match the "| D-NNN | <title> | [<domain>](<domain>.md) |" shape.`);
          } else if (rowMatch[4] !== `${rowMatch[3]}.md`) {
            problems.push(`Group "${group.label}" row ${rowMatch[1]} links [${rowMatch[3]}] to ${rowMatch[4]}; domain links must be [<domain>](<domain>.md).`);
          } else {
            group.rows.push({
              id: Number(rowMatch[1].slice(2)),
              idText: rowMatch[1],
              title: unescapeRowTitle(rowMatch[2]),
              domain: rowMatch[3],
              lineIndex: index,
            });
            group.lastRowLineIndex = index;
          }
          index += 1;
        }
        if (group.rows.length === 0) {
          problems.push(`Group "${group.label}" has no decision rows.`);
        }
      }
    }

    // Only blank lines may separate a group's table from the next heading.
    while (index < lines.length && !GROUP_HEADING_PATTERN.test(lines[index])) {
      if (lines[index].trim() !== '') {
        problems.push(`Line ${index + 1} ("${truncate(lines[index])}") was not recognized inside the grouped index structure.`);
      }
      index += 1;
    }

    groups.push(group);
  }

  if (groups.length === 0) {
    problems.push('decisions/INDEX.md has no "## <date> — <session>" groups; the grouped generator only maintains the grouped shape.');
  }

  return { ok: problems.length === 0, problems, lines, groups };
}

/**
 * Collects canonical decisions from the domain files using the strict
 * em-dash heading form. Hyphen-only headings cannot be indexed and are
 * reported, never silently dropped (D-283).
 */
export async function collectCanonicalDecisions(rootDir) {
  const decisionsDir = path.join(rootDir, 'decisions');
  const decisions = [];
  const problems = [];
  const seen = new Map();

  for (const fileName of await listDecisionFileNames(decisionsDir)) {
    const content = await readFile(path.join(decisionsDir, fileName), 'utf8');
    const strictIds = new Set();
    for (const match of content.matchAll(CANONICAL_DECISION_PATTERN)) {
      const id = Number(match[1]);
      strictIds.add(id);
      const domain = path.basename(fileName, '.md');
      const previous = seen.get(id);
      if (previous) {
        problems.push(`Canonical decision ${formatDecisionId(id)} appears in both ${previous} and ${fileName}; repair the duplicate before regenerating the index (D-276).`);
        continue;
      }
      seen.set(id, fileName);
      decisions.push({ id, title: match[2].trim(), domain });
    }
    for (const match of content.matchAll(HYPHEN_ONLY_DECISION_PATTERN)) {
      if (!strictIds.has(Number(match[1]))) {
        problems.push(`Decision heading "D-${match[1]}" in ${fileName} uses "-" instead of "—" and cannot be indexed; fix the canonical heading.`);
      }
    }
  }

  decisions.sort((left, right) => left.id - right.id);
  return { decisions, problems };
}

/**
 * Canonical↔index correspondence: every canonical decision exactly once with
 * a matching title and domain link; no orphan or duplicate rows. Returns the
 * mismatch findings plus the canonical decisions absent from the index.
 */
function diffIndexAgainstCanonical(parsed, decisions) {
  const problems = [];
  const canonicalById = new Map(decisions.map((decision) => [decision.id, decision]));
  const rowsById = new Map();

  for (const group of parsed.groups) {
    for (const row of group.rows) {
      if (rowsById.has(row.id)) {
        problems.push(`Index row ${row.idText} appears more than once (groups "${rowsById.get(row.id).groupLabel}" and "${group.label}").`);
        continue;
      }
      rowsById.set(row.id, { ...row, groupLabel: group.label });

      const canonical = canonicalById.get(row.id);
      if (!canonical) {
        problems.push(`Index row ${row.idText} ("${truncate(row.title)}") has no canonical decision entry.`);
        continue;
      }
      if (canonical.title !== row.title) {
        problems.push(`Index row ${row.idText} title ("${truncate(row.title)}") does not match the canonical heading ("${truncate(canonical.title)}").`);
      }
      if (canonical.domain !== row.domain) {
        problems.push(`Index row ${row.idText} links domain [${row.domain}] but the canonical entry lives in ${canonical.domain}.md.`);
      }
    }
  }

  const missing = decisions.filter((decision) => !rowsById.has(decision.id));
  return { problems, missing, rowCount: rowsById.size };
}

/** Read-only validation (`refresh-decision-index --check`). */
export async function checkGroupedDecisionIndex(options) {
  const rootDir = requireRootDir(options);
  const indexPath = path.join(rootDir, 'decisions', 'INDEX.md');
  const content = await readFile(indexPath, 'utf8').catch(() => null);
  if (content === null) {
    return { ok: false, indexPath, problems: [`No decisions/INDEX.md exists at ${indexPath}.`], stats: null };
  }

  const parsed = parseGroupedDecisionIndex(content);
  const canonical = await collectCanonicalDecisions(rootDir);
  const problems = [...parsed.problems, ...canonical.problems];
  let stats = null;

  if (parsed.ok) {
    const diff = diffIndexAgainstCanonical(parsed, canonical.decisions);
    problems.push(...diff.problems);
    for (const decision of diff.missing) {
      problems.push(`Canonical decision ${formatDecisionId(decision.id)} ("${truncate(decision.title)}") is missing from the index.`);
    }
    stats = {
      groupCount: parsed.groups.length,
      rowCount: diff.rowCount,
      decisionCount: canonical.decisions.length,
    };
  }

  return { ok: problems.length === 0, indexPath, problems, stats };
}

/**
 * Structure-preserving refresh: appends canonical decisions missing from the
 * index to the group named by `groupLabel` (created at the tail when absent).
 * Existing lines are preserved verbatim; with nothing missing the file is not
 * rewritten, so a no-op refresh is byte-idempotent. Any parse or
 * correspondence problem refuses the write with named findings.
 */
export async function refreshGroupedDecisionIndex(options) {
  const rootDir = requireRootDir(options);
  return withMemoryRootLock(rootDir, 'refresh-decision-index', () => refreshGroupedDecisionIndexLocked(rootDir, options));
}

async function refreshGroupedDecisionIndexLocked(rootDir, options) {
  const indexPath = path.join(rootDir, 'decisions', 'INDEX.md');
  const groupLabel = normalizeOptionalString(options.groupLabel);
  const result = {
    indexPath,
    refreshed: false,
    upToDate: false,
    added: [],
    groupLabel,
    problems: [],
    warnings: [],
  };

  const content = await readFile(indexPath, 'utf8').catch(() => null);
  if (content === null) {
    result.problems.push(
      `No decisions/INDEX.md exists at ${indexPath}; the grouped generator preserves an existing index and never creates one from scratch (D-283).`,
    );
    return result;
  }

  const parsed = parseGroupedDecisionIndex(content);
  const canonical = await collectCanonicalDecisions(rootDir);
  result.problems.push(...parsed.problems);
  // Duplicate canonical IDs refuse the refresh; hyphen-heading findings are
  // reported as warnings but do not block indexing the decisions that parse.
  const duplicateProblems = canonical.problems.filter((problem) => problem.includes('appears in both'));
  const headingWarnings = canonical.problems.filter((problem) => !problem.includes('appears in both'));
  result.problems.push(...duplicateProblems);
  result.warnings.push(...headingWarnings);
  if (result.problems.length > 0) {
    return result;
  }

  const diff = diffIndexAgainstCanonical(parsed, canonical.decisions);
  result.problems.push(...diff.problems);
  if (result.problems.length > 0) {
    return result;
  }

  if (diff.missing.length === 0) {
    result.upToDate = true;
    return result;
  }

  if (!groupLabel) {
    result.problems.push(
      `${diff.missing.length} decision(s) are missing from the index but no group label was determined; pass --group "<date> — Session <N> (<lane-id> lane)" or run with a resolvable lane (D-283).`,
    );
    return result;
  }

  const rowLines = diff.missing.map(renderIndexRow);
  const lines = [...parsed.lines];
  const targetGroups = parsed.groups.filter((group) => group.label === groupLabel);
  if (targetGroups.length > 0) {
    const target = targetGroups[targetGroups.length - 1];
    lines.splice(target.lastRowLineIndex + 1, 0, ...rowLines);
  } else {
    // New trailing group. The file ends with a trailing newline, so the last
    // split element is an empty string — insert before it to keep the EOF
    // byte layout unchanged.
    const insertAt = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    lines.splice(insertAt, 0, '', `## ${groupLabel}`, '', TABLE_HEADER, TABLE_SEPARATOR, ...rowLines);
  }

  await writeFile(indexPath, lines.join('\n'), 'utf8');
  result.refreshed = true;
  result.added = diff.missing;
  return result;
}

/**
 * Default group label per D-283: `<session_date> — Session <N> (<lane-id>
 * lane)` for the lane resolved by the shared D-277/D-280 selection order.
 * Returns null when the resolved lane cannot supply a date/number; callers
 * that need a label anyway surface the refresh problem. The marker is passed
 * in from the caller's already-resolved command context (so a worktree
 * marker's root has already been adopted); this function only selects the
 * lane and does not re-resolve the root — re-resolving with the defaulted
 * root would null a valid marker as a root mismatch (D-280).
 */
export async function resolveDefaultIndexGroupLabel(options) {
  const rootDir = requireRootDir(options);
  const sessions = await listProjectSessions({ rootDir, cwd: options.cwd });
  const selection = resolveLaneSelection({
    explicitSessionId: options.sessionId ?? null,
    marker: options.marker ?? null,
    laneIds: sessions.lanes.map((lane) => lane.id),
    rootDir,
    purpose: 'label the decision index group for',
  });

  if (!selection.sessionId) {
    return null;
  }

  const lane = sessions.lanes.find((item) => item.id === selection.sessionId);
  if (!lane?.sessionDate || !lane.sessionNumber) {
    return null;
  }

  return {
    label: `${lane.sessionDate} — Session ${lane.sessionNumber} (${lane.id} lane)`,
    sessionId: selection.sessionId,
    warnings: [...selection.warnings],
  };
}

function renderIndexRow(decision) {
  return `| ${formatDecisionId(decision.id)} | ${escapeRowTitle(decision.title)} | [${decision.domain}](${decision.domain}.md) |`;
}

function escapeRowTitle(title) {
  return title.replace(/\|/g, '\\|');
}

function unescapeRowTitle(title) {
  return title.replace(/\\\|/g, '|');
}

function truncate(value, max = 80) {
  const text = String(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function requireRootDir(options) {
  if (typeof options?.rootDir !== 'string' || options.rootDir.trim() === '') {
    throw new Error('The grouped decision index requires a rootDir.');
  }
  return options.rootDir;
}

function normalizeOptionalString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
