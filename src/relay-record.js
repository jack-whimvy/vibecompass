import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BUILDER_TO_REVIEWER_HEADING,
  REVIEWER_TO_BUILDER_HEADING,
  REVIEW_LOG_HEADING,
  fingerprintSection,
  locateSection,
  readSectionBody,
  replaceSectionBody,
  sha256Hex,
} from './relay-sections.js';
import { computeCurrentFingerprints, shortRound, writeFileAtomic } from './relay-mark.js';
import { extractReviewLogLines, parseReviewLog } from './review-log.js';
import { withMemoryRootLock } from './serialization.js';

// D-419 items 5 and 6: the reviewer's answer, checked; the relayed pass the
// relay writes from it into the reviewer's two sections; and the write's two
// recoverable halves, each over its expected predecessor.

const VERDICTS = ['confirmed', 'reopened', 'withdrawn'];
const SEVERITIES = ['P1', 'P2', 'P3'];
const MAX_TEXT = 4000;
const MAX_EVIDENCE = 20;

/** The answer's JSON schema, given to the reviewer tool as its output schema. */
export const REVIEWER_ANSWER_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['read', 'verdicts', 'findings', 'summary'],
  properties: {
    read: { type: 'string', description: 'What this pass read: files, diffs, and commands.' },
    verdicts: {
      type: 'array',
      description: 'Exactly one verdict for each finding waiting for the reviewer.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'status', 'severity', 'reason', 'evidence'],
        properties: {
          id: { type: 'string', description: 'The finding id, such as R1.2.' },
          status: { type: 'string', enum: VERDICTS },
          severity: { type: 'string', enum: SEVERITIES },
          reason: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    findings: {
      type: 'array',
      description: 'New findings. The relay numbers them.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'finding', 'evidence'],
        properties: {
          severity: { type: 'string', enum: SEVERITIES },
          finding: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    summary: { type: 'string', description: 'A short summary for the handoff.' },
  },
});

// Each nested object's keys, from the schema, so the check and the schema agree.
const VERDICT_KEYS = Object.keys(REVIEWER_ANSWER_SCHEMA.properties.verdicts.items.properties);
const FINDING_KEYS = Object.keys(REVIEWER_ANSWER_SCHEMA.properties.findings.items.properties);

export function newWriteId() {
  return randomBytes(6).toString('hex');
}

/**
 * Reviewer text as data (D-419 item 6): control characters dropped, tabs to
 * spaces, and, outside the last field, " | " made " / " so the field holds.
 * Returns the text's lines.
 */
export function sanitizeLines(text, { lastField = true } = {}) {
  const cleaned = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F\u0080-\u009F\u2028\u2029]/g, '');
  const lines = cleaned.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return lastField ? lines : lines.map((line) => line.replaceAll(' | ', ' / ').replace(/\|$/, '').replace(/^\|/, ''));
}

/**
 * A line of reviewer text written at the start of a line in a lane file: one
 * that would read as a heading or a fence delimiter gets a backslash, so it
 * stays text inside the reviewer's section and the section's end stays where
 * the relay put it (D-419 item 6).
 */
export function asDataLine(line) {
  return /^(#|`{3,}|~{3,})/.test(line) ? `\\${line}` : line;
}

function oneLine(text, options) {
  return sanitizeLines(text, options).join(' ').trim();
}

function isString(value) {
  return typeof value === 'string';
}

/**
 * Checks an answer against the schema and the record (D-419 item 5): every
 * finding waiting for the reviewer gets exactly one verdict, and no verdict
 * names a finding that isn't waiting. Returns `{ ok, problem, answer }`.
 */
export function validateReviewerAnswer(answer, parsed) {
  const fail = (problem) => ({ ok: false, problem, answer: null });
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return fail('the answer is not a JSON object');
  const keys = Object.keys(answer);
  for (const key of ['read', 'verdicts', 'findings', 'summary']) {
    if (!keys.includes(key)) return fail(`the answer has no "${key}"`);
  }
  const extra = keys.filter((key) => !['read', 'verdicts', 'findings', 'summary'].includes(key));
  if (extra.length > 0) return fail(`the answer has fields the schema doesn't allow: ${extra.join(', ')}`);
  if (!isString(answer.read) || oneLine(answer.read, { lastField: false }) === '') return fail('"read" must say what the pass read');
  if (!isString(answer.summary)) return fail('"summary" must be text');
  if (!Array.isArray(answer.verdicts)) return fail('"verdicts" must be a list');
  if (!Array.isArray(answer.findings)) return fail('"findings" must be a list');
  if (!parsed?.ok) return fail('the review log is malformed, so no verdict can be checked');

  const waiting = new Set(parsed.findings.filter((finding) => !finding.resolved && finding.waitingFor === 'reviewer').map((finding) => finding.id));
  const seen = new Set();
  const verdicts = [];
  for (const [index, verdict] of answer.verdicts.entries()) {
    if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict)) return fail(`verdict ${index + 1} is not an object`);
    const extraVerdictKeys = Object.keys(verdict).filter((key) => !VERDICT_KEYS.includes(key));
    if (extraVerdictKeys.length > 0) return fail(`verdict ${index + 1} has fields the schema doesn't allow: ${extraVerdictKeys.join(', ')}`);
    const { id, status, severity, reason, evidence } = verdict;
    if (!isString(id) || !/^R[1-9]\d*\.[1-9]\d*$/.test(id)) return fail(`verdict ${index + 1} has no finding id`);
    if (!VERDICTS.includes(status)) return fail(`the verdict on ${id} is "${status}", not confirmed, reopened, or withdrawn`);
    if (!SEVERITIES.includes(severity)) return fail(`the verdict on ${id} has severity "${severity}", not P1, P2, or P3`);
    if (!isString(reason) || oneLine(reason) === '') return fail(`the verdict on ${id} gives no reason`);
    if (!Array.isArray(evidence) || !evidence.every(isString)) return fail(`the verdict on ${id} has evidence that isn't a list of text`);
    if (seen.has(id)) return fail(`${id} has two verdicts`);
    if (!waiting.has(id)) return fail(`${id} isn't waiting for the reviewer, so it takes no verdict`);
    seen.add(id);
    verdicts.push({ id, status, severity, reason, evidence: evidence.slice(0, MAX_EVIDENCE) });
  }
  const missing = [...waiting].filter((id) => !seen.has(id));
  if (missing.length > 0) return fail(`no verdict on ${missing.join(', ')}, which ${missing.length === 1 ? 'waits' : 'wait'} for the reviewer`);

  const findings = [];
  for (const [index, finding] of answer.findings.entries()) {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return fail(`new finding ${index + 1} is not an object`);
    const extraFindingKeys = Object.keys(finding).filter((key) => !FINDING_KEYS.includes(key));
    if (extraFindingKeys.length > 0) return fail(`new finding ${index + 1} has fields the schema doesn't allow: ${extraFindingKeys.join(', ')}`);
    if (!SEVERITIES.includes(finding.severity)) return fail(`new finding ${index + 1} has severity "${finding.severity}", not P1, P2, or P3`);
    if (!isString(finding.finding) || oneLine(finding.finding) === '') return fail(`new finding ${index + 1} states nothing`);
    if (!Array.isArray(finding.evidence) || !finding.evidence.every(isString)) return fail(`new finding ${index + 1} has evidence that isn't a list of text`);
    findings.push({ severity: finding.severity, finding: finding.finding, evidence: finding.evidence.slice(0, MAX_EVIDENCE) });
  }
  return { ok: true, problem: null, answer: { read: answer.read, summary: answer.summary, verdicts, findings } };
}

function clip(text) {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

/** A finding line with its reason's later lines and the evidence as continuation lines. */
function findingLines(id, severity, status, reasonText, evidence) {
  const reasonLines = sanitizeLines(clip(reasonText));
  const lines = [`  - ${id} | ${severity} | ${status} | ${reasonLines[0]}`];
  for (const extra of reasonLines.slice(1)) lines.push(`    ${extra}`);
  for (const item of evidence) {
    for (const [index, line] of sanitizeLines(clip(item)).entries()) {
      lines.push(index === 0 ? `    Evidence: ${line}` : `    ${line}`);
    }
  }
  return lines;
}

/** `YYYY-MM-DD HH:MM ±HH:MM`, the record's time format, in local time. */
export function formatRecordTime(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} ${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * The relayed pass's lines (D-419 item 6): an owner line first for a go past
 * the cap, then the pass line, the verdicts, and the new findings, numbered
 * R<pass>.<k> in order. The outcome is `findings` when a finding opens or
 * reopens, else `no findings`.
 */
export function buildRelayedPassLines({ answer, passNumber, time, reviewerLabel, writeId, roundId, pastCap = false }) {
  const opensOrReopens = answer.findings.length > 0 || answer.verdicts.some((verdict) => verdict.status === 'reopened');
  const scope = `relay write ${writeId}, round ${shortRound(roundId)}; ${oneLine(clip(answer.read), { lastField: false })}`;
  const lines = [];
  if (pastCap) {
    lines.push(`- owner | ${time} | the owner | another round | the owner ran the relay for one pass past the cap (relay write ${writeId})`); // D-419 item 6, D-403 item 3
  }
  lines.push(`- pass ${passNumber} | ${time} | ${oneLine(reviewerLabel, { lastField: false })} | ${scope} | ${opensOrReopens ? 'findings' : 'no findings'}`);
  for (const verdict of answer.verdicts) {
    lines.push(...findingLines(verdict.id, verdict.severity, verdict.status, verdict.reason, verdict.evidence));
  }
  const ids = [];
  for (const [index, finding] of answer.findings.entries()) {
    const id = `R${passNumber}.${index + 1}`;
    ids.push(id);
    lines.push(...findingLines(id, finding.severity, 'open', finding.finding, finding.evidence));
  }
  return { lines, outcome: opensOrReopens ? 'findings' : 'no findings', newIds: ids };
}

/** The `## Reviewer → Builder` body; its first line names the write id. */
export function buildHandoffSummaryLines({ answer, passNumber, reviewerLabel, writeId, roundId, newIds, laneId }) {
  const lines = [
    `Relay write ${writeId}: pass ${passNumber} by ${oneLine(reviewerLabel)}, round ${shortRound(roundId)}.`,
    '',
    '### Findings summary',
  ];
  const summary = sanitizeLines(clip(answer.summary)).map(asDataLine);
  lines.push(...(summary.length > 0 ? summary : ['(no summary given)']));
  for (const verdict of answer.verdicts) lines.push(`- ${verdict.id} (${verdict.severity}) ${verdict.status}: ${oneLine(clip(verdict.reason))}`);
  for (const [index, finding] of answer.findings.entries()) lines.push(`- ${newIds[index]} (${finding.severity}) open: ${oneLine(clip(finding.finding))}`);
  lines.push('', '### Recommended next step');
  const open = answer.findings.length > 0 || answer.verdicts.some((verdict) => verdict.status === 'reopened');
  lines.push(open
    ? `- The builder answers pass ${passNumber} (\`address review ${laneId}\`), then runs \`vibecompass ready-for-review --session ${laneId}\`.`
    : '- Nothing is open from this pass.');
  return lines;
}

function reviewLogBodyLines(wipContent) {
  const body = readSectionBody(wipContent, REVIEW_LOG_HEADING);
  return body === null || body === '' ? [] : body.split('\n');
}

/**
 * Prepares the write (D-419 item 6): the write id, each half's exact new
 * section text, the hashes of each half's expected predecessor, and the
 * round's fingerprints. Nothing is written here. Throws when the new log
 * wouldn't parse.
 */
export function prepareRelayWrite({ wipContent, handoffContent, answer, passNumber, time, reviewerLabel, roundId, fingerprints, laneId, pastCap = false, writeId = newWriteId() }) {
  const pass = buildRelayedPassLines({ answer, passNumber, time, reviewerLabel, writeId, roundId, pastCap });
  const wipBody = [...reviewLogBodyLines(wipContent), ...pass.lines];
  const nextWip = replaceSectionBody(wipContent, REVIEW_LOG_HEADING, wipBody);
  const reparsed = parseReviewLog(extractReviewLogLines(nextWip).lines);
  if (!reparsed.ok) {
    const error = new Error(`the answer would make the review log unparseable (${reparsed.malformed.reason}: ${reparsed.malformed.text})`);
    error.invalidAnswer = true;
    throw error;
  }
  if (reparsed.passCount !== passNumber) {
    const error = new Error(`the relayed pass would be pass ${reparsed.passCount}, not ${passNumber}`);
    error.invalidAnswer = true;
    throw error;
  }
  const handoffBody = buildHandoffSummaryLines({ answer, passNumber, reviewerLabel, writeId, roundId, newIds: pass.newIds, laneId });
  return {
    id: writeId,
    pass: passNumber,
    round_id: roundId,
    fingerprints,
    outcome: pass.outcome,
    new_ids: pass.newIds,
    wip: {
      body: wipBody,
      predecessor: fingerprints.record,
    },
    handoff: {
      body: handoffBody,
      predecessor_reviewer: fingerprintSection(handoffContent, REVIEWER_TO_BUILDER_HEADING),
      predecessor_builder: fingerprints.handoff,
    },
    state: 'pending',
    wip_landed: false,
    handoff_landed: false,
  };
}

function wipHalfLanded(wipContent, writeId) {
  const body = readSectionBody(wipContent, REVIEW_LOG_HEADING) ?? '';
  return body.split('\n').some((line) => /^- pass \d+ \| /.test(line) && line.includes(`| relay write ${writeId}, round `));
}

function handoffHalfLanded(handoffContent, writeId) {
  const located = locateSection(handoffContent, REVIEWER_TO_BUILDER_HEADING);
  if (!located) return false;
  const first = located.lines.slice(located.bodyStart, located.bodyEnd).find((line) => line.trim() !== '');
  return Boolean(first && first.startsWith(`Relay write ${writeId}:`));
}

async function readText(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

/**
 * One half, under the memory-root lock: re-read the file, and write it only
 * when the half hasn't landed and every section in it still matches its
 * expected predecessor. Returns `landed`, `wrote`, or `changed`.
 */
async function writeWipHalf({ rootDir, laneDir, write, recheck = null }) {
  const wipPath = path.join(laneDir, 'wip.md');
  return withMemoryRootLock(rootDir, 'review-relay', async () => {
    const content = await readFile(wipPath, 'utf8');
    if (wipHalfLanded(content, write.id)) return 'landed';
    if (fingerprintSection(content, REVIEW_LOG_HEADING) !== write.wip.predecessor) return 'changed';
    // The covered work and the builder's handoff, checked again inside the
    // lock just before the pass is recorded: a change queued behind this lock
    // discards the pass (D-419 item 4).
    if (recheck) {
      const now = await recheck();
      if (now.work !== write.fingerprints.work || now.handoff !== write.fingerprints.handoff) return 'work-changed';
    }
    await writeFileAtomic(wipPath, replaceSectionBody(content, REVIEW_LOG_HEADING, write.wip.body));
    return 'wrote';
  });
}

async function writeHandoffHalf({ rootDir, laneDir, write }) {
  const handoffPath = path.join(laneDir, 'handoff.md');
  return withMemoryRootLock(rootDir, 'review-relay', async () => {
    const content = await readText(handoffPath);
    if (handoffHalfLanded(content, write.id)) return 'landed';
    if (fingerprintSection(content, REVIEWER_TO_BUILDER_HEADING) !== write.handoff.predecessor_reviewer
      || fingerprintSection(content, BUILDER_TO_REVIEWER_HEADING) !== write.handoff.predecessor_builder) {
      return 'changed';
    }
    await writeFileAtomic(handoffPath, replaceSectionBody(content, REVIEWER_TO_BUILDER_HEADING, write.handoff.body));
    return 'wrote';
  });
}

/**
 * Runs or finishes a recorded write and returns it with its end state
 * (D-419 item 6): `complete` (both halves landed), `superseded` (the wip.md
 * half landed and newer text is in handoff.md, so the summary is printed
 * instead), or `discarded` (the wip.md half never landed). A write already in
 * an end state is returned untouched, so recovery replays nothing.
 *
 * `recheck` re-checks the round's work and handoff fingerprints inside the
 * wip.md half's lock, just before the pass is written. `onStep` records each
 * half as it lands.
 */
export async function settleRelayWrite({ rootDir, laneDir, write, recheck = null, onStep = async () => {} }) {
  if (['complete', 'superseded', 'discarded'].includes(write.state)) {
    return { write, wrote: [], unwritten: null };
  }
  const wrote = [];
  let current = { ...write };
  const wipNow = await readFile(path.join(laneDir, 'wip.md'), 'utf8');
  if (!wipHalfLanded(wipNow, write.id)) {
    const wipResult = await writeWipHalf({ rootDir, laneDir, write: current, recheck });
    if (wipResult === 'work-changed') {
      current = { ...current, state: 'discarded', reason: 'the work or the handoff changed after the review' };
      await onStep(current);
      return { write: current, wrote, unwritten: 'pass' };
    }
    if (wipResult === 'changed') {
      current = { ...current, state: 'discarded', reason: 'wip.md › ## Review log changed before the pass was written' };
      await onStep(current);
      return { write: current, wrote, unwritten: 'pass' };
    }
    if (wipResult === 'wrote') wrote.push('wip.md');
  }
  current = { ...current, wip_landed: true };
  await onStep(current);

  const handoffResult = await writeHandoffHalf({ rootDir, laneDir, write: current });
  if (handoffResult === 'changed') {
    current = { ...current, state: 'superseded', reason: 'handoff.md changed after the pass, so its summary was printed instead of written' };
    await onStep(current);
    return { write: current, wrote, unwritten: 'summary' };
  }
  if (handoffResult === 'wrote') wrote.push('handoff.md');
  current = { ...current, handoff_landed: true, state: 'complete' };
  await onStep(current);
  return { write: current, wrote, unwritten: null };
}

/** The recheck recovery runs before a wip.md half: the round's work and handoff, now. */
export function makeRecheck({ rootDir, laneDir, worktrees, paths, projectRepos, env }) {
  return async () => {
    const now = await computeCurrentFingerprints({ rootDir, laneDir, worktrees, paths, projectRepos, env });
    return now.fingerprints;
  };
}

export function describeWriteEnd(write) {
  switch (write.state) {
    case 'complete':
      return `relay write ${write.id} is complete: pass ${write.pass} and its handoff summary are recorded.`;
    case 'superseded':
      return `relay write ${write.id} is superseded: pass ${write.pass} stands, and newer text in handoff.md was kept, so its summary is printed here instead.`;
    case 'discarded':
      return `relay write ${write.id} is discarded: nothing was recorded (${write.reason ?? 'its predecessor changed'}); the answer is printed here.`;
    default:
      return `relay write ${write.id} has no end state.`;
  }
}

export function hashText(text) {
  return sha256Hex(text);
}
