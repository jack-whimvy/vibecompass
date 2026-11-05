import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scanProjectMemory } from './project-memory.js';
import { withMemoryRootLock } from './serialization.js';
import { parseSimpleYaml } from './simple-yaml.js';

// D-406: the secret check push runs before it uploads canonical memory, that
// close-session runs as a warning, and that `vibecompass secret-check` runs on
// demand. The patterns are D-405 item 3's, copied from the app's
// src/lib/github/secret-guard.ts at d717d2b, under the names the app's count
// script uses without its `mask:` prefix. A change to them, or to the four
// differences below, is made by a decision that names every copy (D-406 item 2).
//
// The four differences from the app (D-406 item 1): matches are reported from
// the text as written, keeping every match no other match contains, not in
// masking order; no path rule; no Actions secret reference; and the app's own
// `[redacted]` marker is not a match.
//
// Nothing here returns, prints, or stores matched text (D-406 item 6): a match
// leaves the module as its rule, line, column, and fingerprint.

export const SECRET_CHECK_MODES = ['block', 'warn', 'off'];
export const DEFAULT_SECRET_CHECK = 'block';
export const SECRET_CHECK_ALLOW_FILE = 'secret-check-allow.yaml';
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{16}$/;
const MAX_REASON_LENGTH = 300;
const ALLOW_RECORD_KEYS = ['path', 'rule', 'fingerprint', 'reason'];
const REDACTED_VALUE = '[redacted]';

const KEY_LABEL = String.raw`-----BEGIN (?:[A-Z0-9]+ ){0,3}PRIVATE KEY(?: BLOCK)?-----`;
const KEY_END = String.raw`-----END (?:[A-Z0-9]+ ){0,3}PRIVATE KEY(?: BLOCK)?-----`;
// A line break as it appears in text: a real newline, JSON's escaped `\n`, and
// a diff's `+`, `-`, or context-space prefix.
const LINE_BREAK = String.raw`[ \t]*(?:\r?\n|(?:\\r)?\\n)[ \t+-]*`;
const LINE_END = String.raw`(?=[ \t]*(?:\r?\n|(?:\\r)?\\n|["',]|$))`;
// One or two breaks: armor headers end with one blank line before the payload.
const LINE_BREAKS = `(?:${LINE_BREAK}){1,2}`;

// The units of a quoted secret value: a character or a backslash escape, in
// raw text or text escaped once as JSON writes it; a value ends at its own
// closing quote (the app's QUOTED_VALUE_UNITS, D-405 review R4.2).
const QUOTED_VALUE_UNITS = [
  ['"', String.raw`[^\s\\"]|\\\S`],
  ["'", String.raw`[^\s\\']|(?<!\\)(?:\\\\\\\\)*\\\\'|\\\S`],
  ['\\"', String.raw`[^\s\\]|\\\\(?:[^\s\\]|\\\S)|\\[^\s\\"]`],
  ["\\'", String.raw`[^\s\\]|\\\\(?:[^\s\\]|\\\S)|\\[^\s\\']`],
];
const QUOTED_VALUE = QUOTED_VALUE_UNITS.map(([delimiter, units]) => {
  const literal = delimiter.replaceAll('\\', '\\\\');
  return `${literal}(?:${units}){8,256}${literal}`;
}).join('|');
// A key whose name ends in a secret word, then `=` or `:` (not `==`, `=>`, or
// `::`). The name may close a quote, raw or JSON-escaped.
const SECRET_NAME_HEAD =
  /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]*?(?:secret|token|password|passwd|passphrase|api[_-]?key|access_key|secret_key|private_key)(?:\\?["'])?[ \t]*(?:=(?![=>])|:(?![:=]))[ \t]*/
    .source;
// An unquoted value ends the token: at whitespace, `,`, `;`, a closing
// bracket, or a backslash (JSON's escaped `\n`).
const BARE_VALUE = /([^\s"'`.$()[\]{}<>,;\\]{8,256})(?=$|[\s,;)\]}\\])/.source;

/**
 * D-405 item 3's patterns, in its order, without the Actions secret reference
 * (D-406 item 1). The app's two private-key rules report as one rule.
 * `accept` drops a regex match the rule doesn't count.
 */
const SECRET_RULES = [
  {
    name: 'private-key',
    pattern: new RegExp(`${KEY_LABEL}[\\s\\S]{0,20000}?${KEY_END}`, 'g'),
  },
  {
    // A header whose end was cut off, or never there, or a block longer than
    // the bound above: the header, its armor headers, the blank line after
    // them, the base64 lines, and the end line if there is one.
    name: 'private-key',
    pattern: new RegExp(
      `${KEY_LABEL}(?:${LINE_BREAKS}(?:[A-Za-z0-9+/=]+|[A-Za-z][A-Za-z-]*: [^\\r\\n\\\\]*)${LINE_END})*(?:${LINE_BREAKS}${KEY_END})?`,
      'g',
    ),
  },
  { name: 'token-legacy', pattern: /\b(?:ghp|github_pat|glpat|sk|pk|xox[baprs])[_-][A-Za-z0-9_=-]{16,}\b/g },
  { name: 'token-github', pattern: /\bgh[ousr]_[A-Za-z0-9]{16,}\b/g },
  { name: 'token-stripe', pattern: /\b(?:rk|whsec)_[A-Za-z0-9_]{16,}\b/g },
  { name: 'token-supabase', pattern: /(?<![A-Za-z0-9_-])sb_secret_[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g },
  { name: 'token-npm', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: 'token-aws', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: 'token-google', pattern: /(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g },
  { name: 'token-jwt', pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  {
    name: 'url-password',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/?#]*):([^\s@/?#]+)@/gi,
    // The app's marker is not a match (D-406 item 1).
    accept: (match) => match[2] !== REDACTED_VALUE,
  },
  {
    name: 'secret-named-assignment',
    pattern: new RegExp(`(${SECRET_NAME_HEAD})(?:(${QUOTED_VALUE})|${BARE_VALUE})`, 'gim'),
    accept: (match) => {
      const quoted = match[2];
      if (quoted !== undefined) {
        const delimiterLength = quoted.startsWith('\\') ? 2 : 1;
        return quoted.slice(delimiterLength, quoted.length - delimiterLength) !== REDACTED_VALUE;
      }
      const bare = match[3];
      return bare !== undefined && /[A-Za-z]/.test(bare) && /\d/.test(bare);
    },
  },
];

export const SECRET_RULE_NAMES = [...new Set(SECRET_RULES.map((rule) => rule.name))];

/**
 * Every match in `text` that no other match contains (D-406 item 1): a match
 * is dropped when another covers its span and is longer, or covers the same
 * span under an earlier rule. Each result holds the rule, the 1-based line and
 * column where the match starts, and the fingerprint; never the text.
 */
export function findSecretMatches(text, documentPath) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const candidates = [];
  SECRET_RULES.forEach((rule, order) => {
    for (const match of text.matchAll(rule.pattern)) {
      if (rule.accept && !rule.accept(match)) continue;
      candidates.push({ rule: rule.name, order, start: match.index, end: match.index + match[0].length, value: match[0] });
    }
  });

  const kept = candidates.filter((candidate) => !candidates.some((other) =>
    other !== candidate
    && other.start <= candidate.start
    && other.end >= candidate.end
    && (other.end - other.start > candidate.end - candidate.start || other.order < candidate.order)));
  kept.sort((left, right) => left.start - right.start || left.order - right.order);

  const lineStarts = computeLineStarts(text);
  return kept.map((match) => {
    const { line, column } = locate(text, lineStarts, match.start);
    return {
      rule: match.rule,
      line,
      column,
      fingerprint: fingerprintMatch(match.rule, documentPath, match.value),
    };
  });
}

/** Whether a text holds anything the check matches; used to vet an allow reason. */
export function textHasSecretMatch(text) {
  return findSecretMatches(text, '').length > 0;
}

/**
 * `sha256:` and the first 16 hex digits of SHA-256 over the rule, the path,
 * and the matched text (D-406 item 5). It never leaves this module with the
 * text it was made from.
 */
function fingerprintMatch(rule, documentPath, value) {
  const digest = createHash('sha256').update(`${rule}\n${documentPath}\n${value}`).digest('hex');
  return `sha256:${digest.slice(0, 16)}`;
}

function computeLineStarts(text) {
  const starts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

function locate(text, lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  // Columns count code points, so a character outside the BMP is one column.
  return { line: low + 1, column: Array.from(text.slice(lineStarts[low], offset)).length + 1 };
}

/**
 * `metadata.workflow.secret_check`: `block` (the default), `warn`, or `off`
 * (D-406 item 4). A missing key means `block`; any other value warns and
 * falls back to `block`.
 */
export function resolveSecretCheckSettings(rawValue) {
  const warnings = [];
  if (rawValue === undefined || rawValue === null) {
    return { mode: DEFAULT_SECRET_CHECK, warnings };
  }
  const value = typeof rawValue === 'string' ? rawValue.trim() : rawValue;
  if (SECRET_CHECK_MODES.includes(value)) {
    return { mode: value, warnings };
  }
  // D-406 item 6: the warning describes the value and never repeats it, since
  // a key pasted into the setting would be printed with it.
  warnings.push(
    `project.yaml metadata.workflow.secret_check is set to ${describeSettingValue(value)}, not block, warn, or off (lowercase); using ${DEFAULT_SECRET_CHECK}.`,
  );
  return { mode: DEFAULT_SECRET_CHECK, warnings };
}

function describeSettingValue(value) {
  if (typeof value === 'string') return value === '' ? 'empty text' : 'other text';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'a mapping';
  if (typeof value === 'boolean') return 'true or false';
  return `a ${typeof value}`;
}

/**
 * Reads `secret-check-allow.yaml` at the memory root. A missing file holds no
 * records. A file that can't be parsed, or a record missing a field or naming
 * an unknown rule or a malformed fingerprint, throws: the check fails closed
 * rather than read a broken list as empty. Unknown keys warn.
 */
export async function readSecretAllowList(rootDir) {
  const filePath = path.join(rootDir, SECRET_CHECK_ALLOW_FILE);
  let source;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { filePath, exists: false, source: null, records: [], warnings: [] };
    }
    throw error;
  }
  return { filePath, exists: true, source, ...parseSecretAllowList(source, filePath) };
}

export function parseSecretAllowList(source, filePath = SECRET_CHECK_ALLOW_FILE) {
  const label = path.basename(filePath);
  const warnings = [];
  let data;
  // D-406 item 6: every message below names a record by its number, a field
  // by its name, and a parse error by its line, and never repeats text from
  // the file, which a pasted key could be part of. So the parser's own message
  // (which can name a key) is not passed through.
  try {
    data = source.trim() === '' ? {} : parseSimpleYaml(source, { sourceName: label });
  } catch (error) {
    const lineNumber = parseErrorLine(error, label);
    throw new Error(`${label} could not be parsed${lineNumber ? ` at line ${lineNumber}` : ''}; it holds an allow: list of records. Fix it, or remove it to list every match again.`);
  }
  if (data === null || data === undefined) data = {};
  if (!isPlainObject(data)) {
    throw new Error(`${label} must be a mapping with an allow: list.`);
  }
  const extraTopLevel = Object.keys(data).filter((key) => key !== 'allow').length;
  if (extraTopLevel > 0) {
    warnings.push(`${label} has ${countOf(extraTopLevel, 'top-level key')} other than allow, ignored.`);
  }
  const rawRecords = data.allow ?? [];
  if (!Array.isArray(rawRecords)) {
    throw new Error(`${label}: allow must be a list of records.`);
  }
  const records = rawRecords.map((record, index) => {
    const where = `${label}: allow record ${index + 1}`;
    if (!isPlainObject(record)) throw new Error(`${where} is not a mapping.`);
    const extraKeys = Object.keys(record).filter((key) => !ALLOW_RECORD_KEYS.includes(key)).length;
    if (extraKeys > 0) {
      warnings.push(`${where} has ${countOf(extraKeys, 'key')} other than path, rule, fingerprint, and reason, ignored.`);
    }
    for (const key of ALLOW_RECORD_KEYS) {
      if (typeof record[key] !== 'string' || record[key].trim() === '') {
        throw new Error(`${where} needs a non-empty ${key}.`);
      }
    }
    if (!SECRET_RULE_NAMES.includes(record.rule)) {
      throw new Error(`${where} names a rule the check doesn't have; the rules are ${SECRET_RULE_NAMES.join(', ')}.`);
    }
    if (!FINGERPRINT_PATTERN.test(record.fingerprint)) {
      throw new Error(`${where} has a malformed fingerprint; it is sha256: and 16 lowercase hex digits.`);
    }
    // The path is printed when no match uses the record, and the reason is
    // checked before --allow writes it (D-406 item 5); a record holding text a
    // rule matches fails the list closed, as a malformed one does.
    for (const key of ['path', 'reason']) {
      if (textHasSecretMatch(record[key])) {
        throw new Error(`${where}'s ${key} matches a secret-check rule itself; remove that text from ${label} (and rotate it if it is a real key).`);
      }
    }
    return { path: record.path, rule: record.rule, fingerprint: record.fingerprint, reason: record.reason };
  });
  return { records, warnings };
}

/** The line number from a parser error that starts `<label>:<line> `, or null. */
function parseErrorLine(error, label) {
  const message = error instanceof Error ? error.message : '';
  if (!message.startsWith(`${label}:`)) return null;
  const match = /^(\d+) /.exec(message.slice(label.length + 1));
  return match ? Number(match[1]) : null;
}

function countOf(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Checks documents (`{ path, text }`) against the allow records. Returns every
 * reported match with `allowed`, the matches no record allows, counts per
 * rule, and the records no match uses. Holds no matched text.
 */
export function evaluateSecretMatches(documents, records = []) {
  const allowKeys = new Set(records.map((record) => allowKey(record.path, record.rule, record.fingerprint)));
  const usedKeys = new Set();
  const matches = [];
  for (const document of documents) {
    for (const match of findSecretMatches(document.text, document.path)) {
      const key = allowKey(document.path, match.rule, match.fingerprint);
      const allowed = allowKeys.has(key);
      if (allowed) usedKeys.add(key);
      matches.push({ path: document.path, ...match, allowed });
    }
  }
  const counts = {};
  for (const match of matches) {
    const entry = counts[match.rule] ?? { matches: 0, allowed: 0 };
    entry.matches += 1;
    if (match.allowed) entry.allowed += 1;
    counts[match.rule] = entry;
  }
  const unallowed = matches.filter((match) => !match.allowed);
  return {
    ok: unallowed.length === 0,
    documentCount: documents.length,
    matches,
    unallowed,
    allowedCount: matches.length - unallowed.length,
    counts,
    unusedAllows: records
      .filter((record) => !usedKeys.has(allowKey(record.path, record.rule, record.fingerprint)))
      .map(({ path: recordPath, rule, fingerprint }) => ({ path: recordPath, rule, fingerprint })),
  };
}

function allowKey(documentPath, rule, fingerprint) {
  return `${documentPath}\u0000${rule}\u0000${fingerprint}`;
}

/** Reads every canonical document in the root: what push would send. */
export async function readCanonicalDocumentsForSecretCheck(rootDir) {
  const scan = await scanProjectMemory(rootDir);
  const documents = [];
  for (const document of scan.documents) {
    let text;
    try {
      text = await readFile(path.join(rootDir, document.path), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    documents.push({ path: document.path, text });
  }
  return documents;
}

/**
 * The check over a whole root (`vibecompass secret-check`, and close-session's
 * warning). Read-only.
 */
export async function checkProjectMemorySecrets(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? '.compass');
  await assertProjectRoot(rootDir);
  const allowList = await readSecretAllowList(rootDir);
  const documents = await readCanonicalDocumentsForSecretCheck(rootDir);
  return {
    rootDir,
    allowFile: { path: allowList.filePath, exists: allowList.exists, recordCount: allowList.records.length },
    warnings: allowList.warnings,
    ...evaluateSecretMatches(documents, allowList.records),
  };
}

/**
 * `vibecompass secret-check --allow <path>:<line> --reason <text>
 * [--fingerprint <fp>]` (D-406 item 5): records one match as allowed. The
 * line's only match is recorded; a line with two or more distinct matches
 * needs `--fingerprint`. Writes under the root lock and appends the record,
 * keeping the rest of the file as written.
 */
export async function allowSecretMatch(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? '.compass');
  const target = parseAllowTarget(options.target);
  const reason = normalizeReason(options.reason);
  const fingerprint = normalizeFingerprint(options.fingerprint);
  return withMemoryRootLock(rootDir, 'secret-check-allow', async () => {
    await assertProjectRoot(rootDir);
    const allowList = await readSecretAllowList(rootDir);
    const documents = await readCanonicalDocumentsForSecretCheck(rootDir);
    const document = documents.find((entry) => entry.path === target.path);
    if (!document) {
      // Not repeated: a path that names no canonical document is only the
      // caller's text (D-406 item 6).
      throw new Error('The --allow path is not a canonical document in this root; pass the path secret-check prints, relative to the root. Nothing was recorded.');
    }
    const onLine = findSecretMatches(document.text, document.path).filter((match) => match.line === target.line);
    const distinct = [...new Map(onLine.map((match) => [`${match.rule}\u0000${match.fingerprint}`, match])).values()];
    if (distinct.length === 0) {
      throw new Error(`secret-check found no match on ${target.path}:${target.line}; nothing was recorded.`);
    }
    let selected;
    if (fingerprint) {
      selected = distinct.filter((match) => match.fingerprint === fingerprint);
      if (selected.length === 0) {
        throw new Error(`No match on ${target.path}:${target.line} has fingerprint ${fingerprint}; nothing was recorded.\n${renderLineMatches(distinct)}`);
      }
    } else if (distinct.length > 1) {
      throw new Error(
        `${target.path}:${target.line} has ${distinct.length} matches, and one command records one; nothing was recorded. Choose one with --fingerprint:\n${renderLineMatches(distinct)}`,
      );
    } else {
      selected = distinct;
    }
    const [match] = selected;
    const record = { path: target.path, rule: match.rule, fingerprint: match.fingerprint, reason };
    const already = allowList.records.some((existing) =>
      existing.path === record.path && existing.rule === record.rule && existing.fingerprint === record.fingerprint);
    if (already) {
      return { status: 'already-allowed', rootDir, filePath: allowList.filePath, record: withLine(record, target.line) };
    }
    const content = appendAllowRecord(allowList.source, record);
    // Fail closed: the new file must parse and hold the record before it is written.
    const reparsed = parseSecretAllowList(content, allowList.filePath);
    const holdsRecord = reparsed.records.some((existing) =>
      existing.path === record.path && existing.rule === record.rule && existing.fingerprint === record.fingerprint);
    if (!holdsRecord || reparsed.records.length !== allowList.records.length + 1) {
      throw new Error(`${SECRET_CHECK_ALLOW_FILE} would not hold the new record if it were appended; add it by hand under allow:. Nothing was written.`);
    }
    await writeFile(allowList.filePath, content, 'utf8');
    return { status: 'allowed', rootDir, filePath: allowList.filePath, record: withLine(record, target.line) };
  });
}

function withLine(record, line) {
  return { path: record.path, line, rule: record.rule, fingerprint: record.fingerprint };
}

function renderLineMatches(matches) {
  return matches.map((match) => `- column ${match.column}: ${match.rule} ${match.fingerprint}`).join('\n');
}

const ALLOW_FILE_HEADER = [
  '# Matches the VibeCompass secret check reported that are not secrets.',
  '# Each record names a canonical document, a rule, and a fingerprint of the matched text:',
  '# a hash, never the text. A real key is removed from the document and rotated, never allowed.',
  '# Add records with: vibecompass secret-check --allow <path>:<line> --reason "<why>"',
  'allow:',
];

function appendAllowRecord(source, record) {
  const lines = [
    `  - path: ${JSON.stringify(record.path)}`,
    `    rule: ${record.rule}`,
    `    fingerprint: ${JSON.stringify(record.fingerprint)}`,
    `    reason: ${JSON.stringify(record.reason)}`,
  ];
  if (source === null || source.trim() === '') {
    return `${[...ALLOW_FILE_HEADER, ...lines].join('\n')}\n`;
  }
  const base = source.endsWith('\n') ? source : `${source}\n`;
  // A file whose allow: list is empty or absent gets an allow: line first.
  const hasAllowKey = /^allow:[ \t]*(?:#.*)?$/m.test(base);
  if (!hasAllowKey) {
    return `${base}allow:\n${lines.join('\n')}\n`;
  }
  return `${base}${lines.join('\n')}\n`;
}

function parseAllowTarget(value) {
  if (typeof value !== 'string' || !value.includes(':')) {
    throw new Error('--allow expects <path>:<line>, the path and line secret-check prints.');
  }
  const separator = value.lastIndexOf(':');
  const targetPath = value.slice(0, separator).trim();
  const lineText = value.slice(separator + 1).trim();
  if (!targetPath || !/^[1-9]\d*$/.test(lineText)) {
    throw new Error('--allow expects <path>:<line>, the path and line secret-check prints.');
  }
  return { path: targetPath, line: Number(lineText) };
}

/** A `--fingerprint` is checked for its shape before it is ever printed back. */
function normalizeFingerprint(value) {
  if (value === undefined || value === null) return null;
  const fingerprint = typeof value === 'string' ? value.trim() : '';
  if (!FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new Error('--fingerprint takes sha256: and 16 lowercase hex digits, as secret-check prints it. Nothing was recorded.');
  }
  return fingerprint;
}

function normalizeReason(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('--allow needs --reason "<why this match is not a secret>".');
  }
  const reason = value.trim();
  if (/[\r\n]/.test(reason)) {
    throw new Error('--reason must be one line.');
  }
  if (reason.length > MAX_REASON_LENGTH) {
    throw new Error(`--reason must be at most ${MAX_REASON_LENGTH} characters.`);
  }
  if (textHasSecretMatch(reason)) {
    throw new Error('--reason matches a secret-check rule itself; describe the match without quoting it. Nothing was recorded.');
  }
  return reason;
}

async function assertProjectRoot(rootDir) {
  try {
    await readFile(path.join(rootDir, 'project.yaml'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`No project memory root at ${rootDir} (no project.yaml); pass --root.`);
    }
    throw error;
  }
}

/**
 * The lines push, close-session, and secret-check print for a result: a
 * summary, then each match no record allows as `path:line rule`.
 */
export function renderSecretCheckSummary(result) {
  const documents = `${result.documentCount} document${result.documentCount === 1 ? '' : 's'}`;
  if (result.ok) {
    return result.allowedCount > 0
      ? `passed (${documents}; ${result.allowedCount} match${result.allowedCount === 1 ? '' : 'es'} allowed by ${SECRET_CHECK_ALLOW_FILE})`
      : `passed (${documents}; no match)`;
  }
  const files = new Set(result.unallowed.map((match) => match.path)).size;
  return `${result.unallowed.length} possible secret${result.unallowed.length === 1 ? '' : 's'} in ${files} document${files === 1 ? '' : 's'}${result.allowedCount > 0 ? ` (${result.allowedCount} other match${result.allowedCount === 1 ? '' : 'es'} allowed)` : ''}`;
}

export function renderSecretMatchLines(matches) {
  return matches.map((match) => `${match.path}:${match.line} ${match.rule}`);
}

export const SECRET_CHECK_NEXT_STEP =
  'remove each value from its document (rotate a real key: it may also be in the root\'s Git history), or, if a match is not a secret, allow it with: vibecompass secret-check --allow <path>:<line> --reason "<why>"';

/** Thrown by push when the check finds a match no record allows and the setting is block. */
export class SecretCheckRefusal extends Error {
  constructor(result, settingWarnings = []) {
    super(
      [
        `Secret check: ${renderSecretCheckSummary(result)}, so nothing was pushed.`, // D-406
        ...renderSecretMatchLines(result.unallowed).map((line) => `- ${line}`),
        `Next: ${SECRET_CHECK_NEXT_STEP}. metadata.workflow.secret_check in project.yaml sets block, warn, or off.`,
        ...settingWarnings,
      ].join('\n'),
    );
    this.name = 'SecretCheckRefusal';
    this.result = toPublicSecretCheckResult(result);
  }
}

/** The JSON shape: every field but matched text, which the result never holds. */
export function toPublicSecretCheckResult(result) {
  return {
    ok: result.ok,
    ...(result.rootDir ? { root: result.rootDir } : {}),
    ...(result.mode ? { setting: result.mode } : {}),
    documents: result.documentCount,
    matches: result.matches.map(({ path: matchPath, line, column, rule, fingerprint, allowed }) => ({
      path: matchPath, line, column, rule, fingerprint, allowed,
    })),
    counts: result.counts,
    ...(result.allowFile ? { allow_file: result.allowFile } : {}),
    unused_allows: result.unusedAllows,
    ...(result.warnings ? { warnings: result.warnings } : {}),
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
