import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withMemoryRootLock } from './serialization.js';

/**
 * Canonical decision-log primitives (D-276).
 *
 * D-numbers are allocated from the current shared root at write time, never
 * reserved ahead of a write. `appendDecisionEntry` is the mediated atomic
 * append path: it allocates and appends under the memory-root lock as one
 * operation. `readNextDecisionId` exists for advisory previews and for the
 * allocation step itself; callers outside the lock must treat its result as
 * informational only.
 */

const DECISION_HEADING_PATTERN = /^###\s+D-(\d+)\b/gm;

/**
 * Canonical headings use zero-padded D-NNN (the manifest scanner rejects
 * shorter forms); IDs past 999 grow naturally.
 */
export function formatDecisionId(id) {
  return `D-${String(id).padStart(3, '0')}`;
}
const NEXT_ID_PLACEHOLDER_PATTERN = /^###\s+D-NEXT\s+(—|-)\s+\S/m;
const EXCLUDED_DECISION_FILES = ['INDEX.md', 'README.md', 'EXAMPLE.md'];

export async function listDecisionFileNames(decisionsDir) {
  try {
    return (await readdir(decisionsDir))
      .filter((fileName) => fileName.endsWith('.md') && !EXCLUDED_DECISION_FILES.includes(fileName))
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function readNextDecisionId(rootDir) {
  const decisionsDir = path.join(rootDir, 'decisions');
  let max = 0;

  for (const fileName of await listDecisionFileNames(decisionsDir)) {
    const content = await readFile(path.join(decisionsDir, fileName), 'utf8');
    for (const match of content.matchAll(DECISION_HEADING_PATTERN)) {
      max = Math.max(max, Number(match[1]));
    }
  }

  return max + 1;
}

/**
 * Scans every canonical decision file and returns duplicate D-number usage as
 * `[{ id, occurrences: ["file.md", ...] }]`. Duplicates block close-session
 * for human repair (D-276); they are never auto-renumbered.
 */
export async function findDuplicateDecisionIds(rootDir) {
  const decisionsDir = path.join(rootDir, 'decisions');
  const occurrencesById = new Map();

  for (const fileName of await listDecisionFileNames(decisionsDir)) {
    const content = await readFile(path.join(decisionsDir, fileName), 'utf8');
    for (const match of content.matchAll(DECISION_HEADING_PATTERN)) {
      const id = Number(match[1]);
      const occurrences = occurrencesById.get(id) ?? [];
      occurrences.push(fileName);
      occurrencesById.set(id, occurrences);
    }
  }

  return [...occurrencesById.entries()]
    .filter(([, occurrences]) => occurrences.length > 1)
    .map(([id, occurrences]) => ({ id, occurrences }))
    .sort((left, right) => left.id - right.id);
}

/**
 * Atomically appends a staged decision entry to a canonical domain file.
 *
 * The staged entry must open with `### D-NEXT — <title>`; the placeholder is
 * replaced with the D-number allocated at write time under the memory-root
 * lock. Returns the allocated ID plus a derived-index reminder, because the
 * grouped `decisions/INDEX.md` refresh stays with the closer until a
 * structure-preserving generator exists (S4).
 */
export async function appendDecisionEntry(options) {
  const rootDir = requireNonEmptyString(options?.rootDir, 'append-decision requires a rootDir.');
  const targetName = normalizeTargetName(options?.target);
  const entrySource = requireNonEmptyString(options?.entryContent, 'append-decision requires non-empty staged entry content.').trim();

  if (!NEXT_ID_PLACEHOLDER_PATTERN.test(entrySource)) {
    throw new Error(
      'Staged decision entries must start with a "### D-NEXT — <title>" heading. ' +
        'The D-number is allocated at write time (D-276); do not pre-assign one.',
    );
  }

  const warnings = [];
  if (!/\*\*Timestamp:\*\*/.test(entrySource)) {
    warnings.push('Staged entry has no "**Timestamp:**" line; canonical decisions should carry a real timestamp.');
  }
  if (!/\*\*Rationale:\*\*/.test(entrySource)) {
    warnings.push('Staged entry has no "**Rationale:**" line; canonical decisions should record why.');
  }

  return withMemoryRootLock(rootDir, 'append-decision', async () => {
    const targetPath = path.join(rootDir, 'decisions', targetName);
    const existing = await readFile(targetPath, 'utf8').catch((error) => {
      if (error?.code === 'ENOENT') {
        throw new Error(
          `Decision target ${targetName} does not exist under ${path.join(rootDir, 'decisions')}. ` +
            'Create the domain file first (or pick an existing domain).',
        );
      }
      throw error;
    });

    const decisionId = await readNextDecisionId(rootDir);
    const entry = entrySource.replace(/^(###\s+)D-NEXT\b/m, `$1${formatDecisionId(decisionId)}`);
    const separator = existing.endsWith('\n') ? '\n---\n\n' : '\n\n---\n\n';
    await writeFile(targetPath, `${existing}${separator}${entry}\n`, 'utf8');

    const duplicates = await findDuplicateDecisionIds(rootDir);
    if (duplicates.length > 0) {
      warnings.push(
        `Duplicate decision IDs detected after append: ${duplicates
          .map((duplicate) => `${formatDecisionId(duplicate.id)} (${duplicate.occurrences.join(', ')})`)
          .join('; ')}. Repair by hand before close-session; duplicates are never auto-renumbered.`,
      );
    }

    return {
      decisionId,
      target: targetName,
      targetPath,
      warnings,
      indexReminder:
        'decisions/INDEX.md is derived; add the grouped index row for this entry by hand until the structure-preserving generator lands (S4).',
    };
  });
}

function normalizeTargetName(value) {
  const raw = requireNonEmptyString(value, 'append-decision requires a --target decision domain file.');
  const name = path.basename(raw);
  if (!name.endsWith('.md') || EXCLUDED_DECISION_FILES.includes(name) || name !== raw.replace(/^decisions\//, '')) {
    throw new Error(
      `Invalid decision target "${raw}". Use a domain file name such as "cross-cutting.md" (optionally prefixed with "decisions/").`,
    );
  }
  return name;
}

function requireNonEmptyString(value, message) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(message);
  }
  return value;
}
