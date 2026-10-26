import { stepFence } from './markdown-sections.js';

// D-394: the review record in a lane's `wip.md` › `## Review log`, its parse,
// and the check close-session and review-check run on it. The check reads only
// the record: who started a reviewer (D-398) is a rule in the role text, since
// no line can show it.

export const REVIEW_CHECK_MODES = ['warn', 'block', 'off'];
export const DEFAULT_REVIEW_CHECK = 'warn';
export const DEFAULT_ROUND_CAP = 3;
const MIN_ROUND_CAP = 1;
const MAX_ROUND_CAP = 10;
const REVIEW_SETTING_KEYS = ['check', 'round_cap'];

const REVIEW_LOG_HEADING = '## review log';
const FIELD_SEPARATOR = ' | ';
const SEVERITIES = ['P1', 'P2', 'P3'];
const PASS_STATUSES = ['open', 'confirmed', 'reopened', 'withdrawn'];
const RESPONSE_STATUSES = ['accepted', 'accepted with qualification', 'deferred', 'rejected'];
const OUTCOMES = ['no findings', 'findings'];
const FINDING_ID_PATTERN = /^R([1-9]\d*)\.([1-9]\d*)$/;
const TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?: ([A-Za-z]{1,6}|[+-]\d{2}:?\d{2}))?$/;
const PASS_LINE_HINT = /^-\s+pass\b/i;

/**
 * D-394 item 7: `metadata.workflow.review` takes `check` (warn, block, off)
 * and `round_cap` (1–10). A missing block or key means its default; anything
 * else warns and falls back to that key's default.
 */
export function resolveReviewSettings(rawReview) {
  const warnings = [];
  const settings = { check: DEFAULT_REVIEW_CHECK, roundCap: DEFAULT_ROUND_CAP, warnings };
  if (rawReview === undefined || rawReview === null) {
    return settings;
  }

  if (!isPlainObject(rawReview)) {
    warnings.push(
      `project.yaml metadata.workflow.review is not a mapping; using check ${DEFAULT_REVIEW_CHECK} and round_cap ${DEFAULT_ROUND_CAP}.`, // D-394
    );
    return settings;
  }

  for (const key of Object.keys(rawReview)) {
    if (!REVIEW_SETTING_KEYS.includes(key)) {
      warnings.push(
        `project.yaml metadata.workflow.review has an unknown key "${key}", which is ignored; the keys are check and round_cap.`, // D-394
      );
    }
  }

  if (Object.hasOwn(rawReview, 'check')) {
    const value = typeof rawReview.check === 'string' ? rawReview.check.trim() : rawReview.check;
    if (REVIEW_CHECK_MODES.includes(value)) {
      settings.check = value;
    } else {
      warnings.push(
        `project.yaml metadata.workflow.review.check is ${JSON.stringify(rawReview.check)}, not warn, block, or off; using ${DEFAULT_REVIEW_CHECK}.`, // D-394
      );
    }
  }

  if (Object.hasOwn(rawReview, 'round_cap')) {
    const value = rawReview.round_cap;
    if (Number.isInteger(value) && value >= MIN_ROUND_CAP && value <= MAX_ROUND_CAP) {
      settings.roundCap = value;
    } else {
      warnings.push(
        `project.yaml metadata.workflow.review.round_cap is ${JSON.stringify(value)}, not a whole number from ${MIN_ROUND_CAP} to ${MAX_ROUND_CAP}; using ${DEFAULT_ROUND_CAP}.`, // D-394
      );
    }
  }

  return settings;
}

/**
 * The lines of `## Review log` with their `wip.md` line numbers, up to the
 * next level-1 or level-2 heading. Fence-aware, so an example of the section
 * in `## Log` is not the section; a fence inside the real section is still a
 * line the record can't hold. A missing section reads as an empty log.
 */
export function extractReviewLogLines(wipContent) {
  const lines = wipContent.split('\n');
  const collected = [];
  let inSection = false;
  let found = false;
  let fence = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/, '');
    const wasInFence = Boolean(fence);
    fence = stepFence(fence, line).fence;
    if (!wasInFence && /^#{1,2}\s/.test(line)) {
      if (inSection) {
        break;
      }

      inSection = line.trim().toLowerCase() === REVIEW_LOG_HEADING;
      found = found || inSection;
      continue;
    }

    if (inSection) {
      collected.push({ lineNumber: index + 1, text: line });
    }
  }

  return { found, lines: collected };
}

/**
 * Parse the record (D-394 items 2–5). Fails fast: a malformed log has no
 * parseable pass, and the result names its first bad line.
 */
export function parseReviewLog(lines) {
  const records = [];
  const findings = new Map();
  const ownerLines = [];
  let passCount = 0;
  let anotherRounds = 0;
  let current = null;
  let currentFinding = null;
  let order = 0;

  const fail = (line, reason) => ({
    ok: false,
    malformed: { lineNumber: line.lineNumber, text: line.text.trim(), reason },
    hasPassLine: lines.some((candidate) => PASS_LINE_HINT.test(candidate.text)),
  });

  // An outcome is checked once its pass's finding lines are all read.
  const closePass = () => {
    if (current?.kind !== 'pass') {
      return null;
    }

    const opensOrReopens = current.findings.some((finding) => finding.status === 'open' || finding.status === 'reopened');
    if (current.outcome === 'no findings' && opensOrReopens) {
      return 'its outcome is "no findings" but it opens or reopens a finding';
    }

    if (current.outcome === 'findings' && !opensOrReopens) {
      return 'its outcome is "findings" but it opens and reopens none';
    }

    return null;
  };

  for (const line of lines) {
    if (line.text.trim() === '') {
      continue;
    }

    const indent = measureIndent(line.text);
    const body = line.text.trim();

    if (indent >= 4) {
      if (!currentFinding) {
        return fail(line, 'a continuation line (indented four or more spaces) must sit under a finding line');
      }
      continue;
    }

    if (indent === 0) {
      const outcomeProblem = closePass();
      if (outcomeProblem) {
        return fail(current.line, outcomeProblem);
      }

      if (!body.startsWith('- ')) {
        return fail(line, 'not a record line: the log holds only pass, response, owner, finding, and continuation lines');
      }

      const record = parseRecordLine(body.slice(2));
      if (record.error) {
        return fail(line, record.error);
      }

      record.line = line;
      if (record.kind === 'pass') {
        if (record.number !== passCount + 1) {
          return fail(line, `passes are numbered 1, 2, 3… in order; this one should be pass ${passCount + 1}`);
        }
        passCount = record.number;
        record.anotherRoundsBefore = anotherRounds;
      } else if (record.kind === 'response') {
        if (record.number > passCount) {
          return fail(line, `response ${record.number} comes before pass ${record.number}`);
        }
      } else {
        for (const id of record.deferIds) {
          if (!findings.has(id)) {
            return fail(line, `it defers ${id}, which no pass has opened`);
          }
        }
        if (record.choice === 'another round') {
          anotherRounds += 1;
        }
        order += 1;
        record.order = order;
        for (const id of record.deferIds) {
          const finding = findings.get(id);
          if (!isResolved(finding)) {
            finding.ownerDeferral = { owner: record.owner, time: record.time, reason: record.reason };
          }
        }
        ownerLines.push(record);
      }

      records.push(record);
      current = record;
      currentFinding = null;
      continue;
    }

    if (indent === 2) {
      if (!body.startsWith('- ')) {
        return fail(line, 'a line indented two spaces must be a finding line, "  - <id> | <severity> | <status> | <reason>"');
      }

      if (!current) {
        return fail(line, 'a finding line must sit under a pass or response line');
      }

      if (current.kind === 'owner') {
        return fail(line, 'an owner line takes no finding lines');
      }

      const findingLine = parseFindingLine(body.slice(2));
      if (findingLine.error) {
        return fail(line, findingLine.error);
      }

      const statuses = current.kind === 'pass' ? PASS_STATUSES : RESPONSE_STATUSES;
      if (!statuses.includes(findingLine.status)) {
        return fail(
          line,
          `"${findingLine.status}" is not a status under a ${current.kind} line, which takes ${statuses.join(', ')}`,
        );
      }

      const existing = findings.get(findingLine.id);
      if (findingLine.status === 'open') {
        if (existing) {
          return fail(line, `${findingLine.id} was opened before; a pass reopens it with "reopened"`);
        }
        if (findingLine.pass !== current.number) {
          return fail(line, `a finding opened in pass ${current.number} takes an R${current.number}.<k> id`);
        }
      } else if (!existing) {
        return fail(line, `${current.kind === 'pass' ? 'a verdict' : 'a disposition'} for ${findingLine.id}, which no pass has opened`);
      }

      order += 1;
      const entry = {
        by: current.kind === 'pass' ? 'reviewer' : 'builder',
        recordNumber: current.number,
        status: findingLine.status,
        severity: findingLine.severity,
        reason: findingLine.reason,
        order,
      };
      if (findingLine.status === 'open') {
        findings.set(findingLine.id, {
          id: findingLine.id,
          severity: findingLine.severity,
          finding: findingLine.reason,
          openedIn: current.number,
          history: [entry],
          ownerDeferral: null,
        });
      } else {
        existing.history.push(entry);
        if (entry.by === 'reviewer') {
          existing.severity = findingLine.severity;
          // D-394 item 4: an owner deferral ends at the reviewer's next line.
          existing.ownerDeferral = null;
        }
      }

      current.findings.push({ id: findingLine.id, status: findingLine.status });
      currentFinding = findingLine;
      continue;
    }

    return fail(
      line,
      `indented ${indent} spaces; record lines start at the margin, finding lines are indented two spaces, and continuation lines four or more`,
    );
  }

  const outcomeProblem = closePass();
  if (outcomeProblem) {
    return fail(current.line, outcomeProblem);
  }

  return {
    ok: true,
    malformed: null,
    hasPassLine: passCount > 0,
    records,
    passCount,
    anotherRounds,
    passes: records.filter((record) => record.kind === 'pass'),
    reviewers: uniqueInOrder(records.filter((record) => record.kind === 'pass').map((record) => record.reviewer)),
    ownerLines,
    findings: [...findings.values()].map(describeFindingState),
  };
}

/**
 * D-394 item 6, with D-392's coverage: every builder lane, and a
 * project-manager lane once its log has a pass line.
 */
export function checkReviewRecord(parsed, { roundCap = DEFAULT_ROUND_CAP, role = 'builder', laneId = null } = {}) {
  const laneRef = laneId ?? '<lane-id>';
  if (role === 'project-manager' && !parsed.hasPassLine) {
    return { status: 'not-required', failures: [] };
  }

  const failures = [];
  if (!parsed.ok) {
    failures.push({
      kind: 'malformed',
      lineNumber: parsed.malformed.lineNumber,
      message: `the review log is malformed at wip.md line ${parsed.malformed.lineNumber} (${parsed.malformed.reason}): ${parsed.malformed.text}`,
      nextStep:
        'the role that wrote a record-format line corrects it in place; a free-text or legacy log stays malformed, and only the owner can close past it with --review-override', // D-394 items 5 and 12
    });
    return { status: 'failed', failures };
  }

  if (parsed.passCount === 0) {
    failures.push({
      kind: 'no-pass',
      message: 'the review log has no pass line',
      nextStep: `ask the owner to start a reviewer with \`review handoff ${laneRef}\`; a check the builder runs itself is not a pass`, // D-398
    });
  }

  const allowedPasses = roundCap + parsed.anotherRounds;
  for (const finding of parsed.findings) {
    if (finding.resolved || finding.deferredByOwner) {
      continue;
    }

    const waitingOnBuilder = finding.waitingFor === 'builder';
    failures.push({
      kind: 'open-finding',
      id: finding.id,
      message: `${finding.id} (${finding.severity}) is open, waiting for the ${waitingOnBuilder ? "builder's response" : "reviewer's verdict"}`,
      nextStep: waitingOnBuilder
        ? 'answer it with a response line (`address review`)'
        : parsed.passCount >= allowedPasses
          ? `the lane has used its ${allowedPasses} passes (cap ${roundCap}): stop and report; the owner chooses another round, defer ${finding.id}, or leave open` // D-394 item 8
          : `ask the owner for the reviewer's next pass (\`review handoff ${laneRef}\`)`,
    });
  }

  for (const pass of parsed.passes) {
    const needed = pass.number - roundCap;
    if (needed > 0 && pass.anotherRoundsBefore < needed) {
      failures.push({
        kind: 'cap',
        lineNumber: pass.line.lineNumber,
        message: `pass ${pass.number} runs past the cap of ${roundCap} with ${pass.anotherRoundsBefore} owner "another round" line${pass.anotherRoundsBefore === 1 ? '' : 's'} before it; it needs ${needed}`,
        nextStep: 'escalate to the owner, whose choice goes in an owner line; only the owner continues a lane past the cap', // D-394 item 8
      });
    }
  }

  return { status: failures.length > 0 ? 'failed' : 'passed', failures };
}

export function formatReviewFailure(failure) {
  return `${failure.message} — next: ${failure.nextStep}`;
}

/**
 * Parse, check, and describe one lane's record for close-session and
 * review-check. `override` is the owner's --review-override reason.
 */
export function evaluateReviewRecord(wipContent, { settings, role = 'builder', laneId = null, override = null } = {}) {
  const resolvedSettings = settings ?? resolveReviewSettings(undefined);
  const section = extractReviewLogLines(wipContent);
  const parsed = parseReviewLog(section.lines);
  const checked = resolvedSettings.check === 'off'
    ? { status: 'off', failures: [] }
    : checkReviewRecord(parsed, { roundCap: resolvedSettings.roundCap, role, laneId });

  let outcome = checked.status;
  if (override) {
    outcome = 'overridden';
  }

  return {
    settings: resolvedSettings,
    role,
    parsed,
    status: checked.status,
    outcome,
    failures: checked.failures,
    override,
    checkLine: renderCheckLine({ status: checked.status, failures: checked.failures, override, mode: resolvedSettings.check }),
    passesLine: renderPassesLine(parsed, resolvedSettings.roundCap),
  };
}

/**
 * D-394 item 9: the note's `## Review` section body.
 */
export function renderReviewSection(evaluation, reviewNotes = []) {
  const lines = [`- Check: ${evaluation.checkLine}`, `- Passes: ${evaluation.passesLine}`];
  const { parsed } = evaluation;
  if (parsed.ok) {
    for (const finding of parsed.findings) {
      lines.push(`- ${renderFindingSummary(finding)}`);
    }
    for (const owner of parsed.ownerLines) {
      lines.push(`- Owner, ${owner.owner}, ${owner.time}: ${owner.choiceText} — ${owner.reason}`);
    }
  } else {
    lines.push(`- No parseable review record: ${parsed.malformed.text}`);
  }

  for (const note of reviewNotes) {
    lines.push(`- ${note}`);
  }

  return lines.join('\n');
}

/**
 * D-394 item 9: each deferred finding joins the note's next steps unless a
 * --next-step already names its id. The reason is the builder's `deferred`
 * line or the owner's line, never the reviewer's verdict.
 */
export function buildDeferredFindingNextSteps(evaluation, nextSteps = []) {
  if (!evaluation.parsed.ok) {
    return [];
  }

  const steps = [];
  for (const finding of evaluation.parsed.findings) {
    let reason = null;
    if (finding.deferredByOwner) {
      reason = `deferred by the owner: ${finding.ownerDeferral.reason}`;
    } else if (finding.resolution === 'deferral') {
      reason = finding.lastDisposition.reason;
    }

    if (!reason) {
      continue;
    }

    const idPattern = new RegExp(`\\b${finding.id.replace('.', '\\.')}\\b`);
    if (nextSteps.some((step) => idPattern.test(step))) {
      continue;
    }

    steps.push(`Deferred review finding ${finding.id} (${finding.severity}): ${finding.finding} — ${reason}`);
  }

  return steps;
}

function renderCheckLine({ status, failures, override, mode }) {
  const failureText = failures.length > 0 ? failures.map((failure) => failure.message).join('; ') : 'none';
  if (override) {
    const skipped = status === 'off'
      ? ' (the check is off)'
      : status === 'not-required'
        ? ' (not required: project-manager lane)'
        : '';
    return `overridden by the owner: ${override}; failures: ${failureText}${skipped}`;
  }

  if (status === 'off') {
    return 'off';
  }

  if (status === 'not-required') {
    return 'not required (project-manager lane)';
  }

  if (status === 'passed') {
    return 'passed';
  }

  return `failed (${mode}): ${failureText}`;
}

function renderPassesLine(parsed, roundCap) {
  if (!parsed.ok) {
    return 'none parseable';
  }

  const extra = parsed.anotherRounds > 0
    ? `, plus ${parsed.anotherRounds} more round${parsed.anotherRounds === 1 ? '' : 's'} the owner chose`
    : '';
  const reviewers = parsed.reviewers.length > 0 ? `; reviewers: ${parsed.reviewers.join(', ')}` : '';
  return `${parsed.passCount} against a cap of ${roundCap}${extra}${reviewers}`;
}

function renderFindingSummary(finding) {
  const parts = [`${finding.id} (${finding.severity}) ${finding.finding}`];
  const tail = [finding.lastDisposition, finding.lastVerdict]
    .filter(Boolean)
    .sort((left, right) => left.order - right.order);
  for (const entry of tail) {
    parts.push(`${entry.status}: ${entry.reason}`);
  }
  if (finding.deferredByOwner) {
    parts.push(`deferred by the owner: ${finding.ownerDeferral.reason}`);
  }
  return parts.join(' — ');
}

// D-394 item 4: a finding's state is its latest finding line.
function describeFindingState(finding) {
  const latest = finding.history.at(-1);
  const lastDisposition = findLast(finding.history, (entry) => entry.by === 'builder') ?? null;
  const lastVerdict = findLast(finding.history, (entry) => entry.by === 'reviewer' && entry.status !== 'open') ?? null;
  const resolved = isResolved(finding);
  let resolution = null;
  if (resolved) {
    resolution = latest.status === 'withdrawn'
      ? 'withdrawn'
      : lastDisposition?.status === 'deferred' && lastDisposition.order < latest.order
        ? 'deferral'
        : 'confirmed';
  }

  return {
    id: finding.id,
    severity: finding.severity,
    finding: finding.finding,
    openedIn: finding.openedIn,
    resolved,
    resolution,
    deferredByOwner: !resolved && Boolean(finding.ownerDeferral),
    ownerDeferral: finding.ownerDeferral,
    waitingFor: resolved ? null : latest.by === 'reviewer' ? 'builder' : 'reviewer',
    latestStatus: latest.status,
    lastDisposition,
    lastVerdict,
  };
}

function isResolved(finding) {
  const latest = finding.history.at(-1);
  return latest.by === 'reviewer' && (latest.status === 'confirmed' || latest.status === 'withdrawn');
}

function parseRecordLine(text) {
  const head = text.split(FIELD_SEPARATOR, 1)[0];
  const passMatch = head.match(/^pass ([1-9]\d*)$/);
  const responseMatch = head.match(/^response ([1-9]\d*)$/);

  if (passMatch) {
    const fields = splitFields(text, 5);
    if (!fields) {
      return { error: 'a pass line is "- pass <n> | <time> | <reviewer> | <scope> | <outcome>"' };
    }
    const [, time, reviewer, scope, outcome] = fields;
    const problem = validateTime(time) ?? requireField(reviewer, 'reviewer') ?? requireField(scope, 'scope');
    if (problem) {
      return { error: problem };
    }
    if (!OUTCOMES.includes(outcome)) {
      return { error: `the outcome "${outcome}" is not "no findings" or "findings"` };
    }
    return { kind: 'pass', number: Number(passMatch[1]), time, reviewer, scope, outcome, findings: [] };
  }

  if (responseMatch) {
    const fields = splitFields(text, 3);
    if (!fields) {
      return { error: 'a response line is "- response <n> | <time> | <builder>"' };
    }
    const [, time, builder] = fields;
    const problem = validateTime(time) ?? requireField(builder, 'builder');
    if (problem) {
      return { error: problem };
    }
    return { kind: 'response', number: Number(responseMatch[1]), time, builder, findings: [] };
  }

  if (head === 'owner') {
    const fields = splitFields(text, 5);
    if (!fields) {
      return { error: 'an owner line is "- owner | <time> | <owner> | <choice> | <reason>"' };
    }
    const [, time, owner, choice, reason] = fields;
    const problem = validateTime(time) ?? requireField(owner, 'owner') ?? requireField(reason, 'reason');
    if (problem) {
      return { error: problem };
    }
    if (choice === 'another round' || choice === 'leave open') {
      return { kind: 'owner', time, owner, choice, choiceText: choice, deferIds: [], reason };
    }
    const deferMatch = choice.match(/^defer (.+)$/);
    if (deferMatch) {
      const ids = deferMatch[1].split(',').map((id) => id.trim());
      const badId = ids.find((id) => !FINDING_ID_PATTERN.test(id));
      if (badId !== undefined) {
        return { error: `"${badId}" is not a finding id (R<pass>.<k>)` };
      }
      return { kind: 'owner', time, owner, choice: 'defer', choiceText: `defer ${ids.join(', ')}`, deferIds: ids, reason };
    }
    return { error: `the owner's choice "${choice}" is not "another round", "defer <id>[, <id>…]", or "leave open"` };
  }

  return { error: 'not a record line: a record starts "- pass <n>", "- response <n>", or "- owner"' };
}

function parseFindingLine(text) {
  const fields = splitFields(text, 4);
  if (!fields) {
    return { error: 'a finding line is "  - <id> | <severity> | <status> | <reason>"' };
  }

  const [id, severity, status, reason] = fields;
  const idMatch = id.match(FINDING_ID_PATTERN);
  if (!idMatch) {
    return { error: `"${id}" is not a finding id (R<pass>.<k>, such as R1.1)` };
  }
  if (!SEVERITIES.includes(severity)) {
    return { error: `the severity "${severity}" is not P1, P2, or P3` };
  }
  if (!PASS_STATUSES.includes(status) && !RESPONSE_STATUSES.includes(status)) {
    return { error: `"${status}" is not a finding status` };
  }
  const reasonProblem = requireField(reason, 'reason');
  if (reasonProblem) {
    return { error: reasonProblem };
  }

  return { id, pass: Number(idMatch[1]), severity, status, reason };
}

// The last field takes the rest of the line (D-394 item 2).
function splitFields(text, count) {
  const fields = [];
  // A trimmed line loses the space after a final empty field's bar.
  let rest = text.endsWith(' |') ? `${text} ` : text;
  for (let index = 0; index < count - 1; index += 1) {
    const at = rest.indexOf(FIELD_SEPARATOR);
    if (at < 0) {
      return null;
    }
    fields.push(rest.slice(0, at).trim());
    rest = rest.slice(at + FIELD_SEPARATOR.length);
  }
  fields.push(rest.trim());
  return fields;
}

function validateTime(value) {
  const match = value.match(TIME_PATTERN);
  if (!match) {
    return `the time "${value}" is not "YYYY-MM-DD HH:MM" with an optional zone`;
  }
  const [, , month, day, hour, minute] = match.map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    return `the time "${value}" is not a valid date and time`;
  }
  return null;
}

function requireField(value, name) {
  return value ? null : `the ${name} field is empty`;
}

function measureIndent(text) {
  let width = 0;
  for (const character of text) {
    if (character === ' ') {
      width += 1;
    } else if (character === '\t') {
      width += 4;
    } else {
      break;
    }
  }
  return width;
}

function findLast(items, predicate) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) {
      return items[index];
    }
  }
  return undefined;
}

function uniqueInOrder(values) {
  return [...new Set(values)];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
