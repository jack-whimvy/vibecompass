import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeProjectMemory } from '../init.js';
import { runCli } from '../cli.js';
import { evaluateReviewRecord, resolveReviewSettings } from '../review-log.js';
import { checkProjectSessionReview, closeProjectSession, startProjectSession } from '../session.js';
import { buildWorkflowMetadata } from '../workflow.js';

// D-394 item 11's acceptance tests, plus D-398's rule in the installed text.

const DOCUMENT_MAINTENANCE_UPDATED = {
  architectureDocs: 'updated',
  decisionLog: 'updated',
  sessionMaintenance: 'updated',
};

const CLOSE_DEFAULTS = {
  title: 'Review Check Lane',
  completed: ['Did the work.'],
  nextSteps: ['Continue.'],
  documentMaintenance: DOCUMENT_MAINTENANCE_UPDATED,
};

const WORKED_EXAMPLE = [
  '- pass 1 | 2026-10-20 10:42 PDT | Codex (GPT-6) | the four draft decisions | findings',
  "  - R1.1 | P2 | open | the owner line doesn't say who writes it",
  '  - R1.2 | P3 | open | `leave open` changes nothing the check can see',
  '- response 1 | 2026-10-20 11:05 PDT | Claude Opus 5.5',
  "  - R1.1 | P2 | accepted | item 2 now says the builder writes it in the owner's words",
  "  - R1.2 | P3 | rejected | it records the owner's choice for the note; the check ignores it on purpose",
  '- pass 2 | 2026-10-20 11:40 PDT | Codex (GPT-6) | pass 1 responses; the docs | no findings',
  '  - R1.1 | P2 | confirmed | fixed in item 2',
  '  - R1.2 | P3 | confirmed | accepts the reason',
];

const CLEAN_PASS = ['- pass 1 | 2026-10-23 09:05 PDT | Codex (GPT-6) | the diff | no findings'];

const OPEN_FINDING = [
  '- pass 1 | 2026-10-23 09:05 PDT | Codex (GPT-6) | the diff | findings',
  '  - R1.1 | P2 | open | the parser accepts a time without minutes',
  '    Evidence: review-log.js TIME_PATTERN.',
];

async function createRoot(t, { review } = {}) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-review-check-'));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const rootDir = path.join(tempDir, '.compass');
  await initializeProjectMemory({
    cwd: tempDir,
    rootDir,
    name: 'Review Check Project',
    mode: 'local-only',
    repos: [{ id: 'docs', remote: 'https://github.com/example/docs.git' }],
    bootstrap: { workflow: true, claude: true },
  });
  if (review) {
    await setReviewSettings(rootDir, review);
  }
  return { tempDir, rootDir };
}

async function setReviewSettings(rootDir, lines) {
  const projectPath = path.join(rootDir, 'project.yaml');
  const source = await readFile(projectPath, 'utf8');
  assert.match(source, /\n  workflow:\n/);
  await writeFile(
    projectPath,
    source.replace('\n  workflow:\n', `\n  workflow:\n    review:\n${lines.map((line) => `      ${line}`).join('\n')}\n`),
    'utf8',
  );
}

async function openLane(root, sessionId, options = {}) {
  await startProjectSession({
    cwd: root.tempDir,
    rootDir: root.rootDir,
    sessionId,
    workingOn: `Work in ${sessionId}.`,
    date: '2026-10-23',
    ...options,
  });
  return path.join(root.rootDir, 'sessions/active', sessionId, 'wip.md');
}

async function writeReviewLog(wipPath, lines) {
  const wip = await readFile(wipPath, 'utf8');
  const at = wip.indexOf('## Review log');
  assert.ok(at >= 0, 'the wip template ends with ## Review log');
  await writeFile(wipPath, `${wip.slice(0, at)}## Review log\n${lines.join('\n')}\n`, 'utf8');
}

async function writeLaneLog(root, sessionId, lines) {
  await writeReviewLog(await openLane(root, sessionId), lines);
  return sessionId;
}

async function close(root, sessionId, options = {}) {
  return closeProjectSession({ cwd: root.tempDir, rootDir: root.rootDir, sessionId, ...CLOSE_DEFAULTS, ...options });
}

function reviewSection(note) {
  const match = note.match(/\n## Review\n([\s\S]*?)\n\n## /);
  assert.ok(match, 'the note has a ## Review section followed by another section');
  return match[1];
}

function captureIo() {
  const out = [];
  const err = [];
  return {
    io: { stdout: { write: (chunk) => out.push(chunk) }, stderr: { write: (chunk) => err.push(chunk) } },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

function evaluate(lines, options = {}) {
  return evaluateReviewRecord(`# WIP — 2026-10-23 (session 1)\n\n## Log\n- x\n\n## Review log\n${lines.join('\n')}\n`, options);
}

test('the worked example parses, resolves both findings, and passes', () => {
  const result = evaluate(WORKED_EXAMPLE);
  assert.equal(result.status, 'passed');
  assert.equal(result.parsed.passCount, 2);
  assert.deepEqual(result.parsed.reviewers, ['Codex (GPT-6)']);
  assert.deepEqual(result.parsed.findings.map((finding) => [finding.id, finding.resolved, finding.resolution]), [
    ['R1.1', true, 'confirmed'],
    ['R1.2', true, 'confirmed'],
  ]);
});

test('each malformed shape fails and names its first bad line (D-394 item 6)', () => {
  const cases = [
    { lines: ['Codex looked at it and found nothing.'], line: 1, reason: /not a record line/ },
    { lines: ['- pass 2 | 2026-10-23 09:05 | Codex (GPT-6) | diff | no findings'], line: 1, reason: /should be pass 1/ },
    { lines: [...CLEAN_PASS, '- pass 3 | 2026-10-23 09:05 | Codex (GPT-6) | diff | no findings'], line: 2, reason: /should be pass 2/ },
    { lines: ['- response 1 | 2026-10-23 09:05 PDT | Claude Opus 5.5', ...CLEAN_PASS], line: 1, reason: /response 1 comes before pass 1/ },
    { lines: [...OPEN_FINDING, '- response 1 | 2026-10-23 09:30 PDT | Claude Opus 5.5', '  - R1.1 | P2 | confirmed | fine'], line: 5, reason: /not a status under a response line/ },
    { lines: ['- pass 1 | 2026-10-23 09:05 PDT | Codex (GPT-6) | diff | findings', '  - R1.1 | P2 | accepted | fine'], line: 2, reason: /not a status under a pass line/ },
    { lines: [...OPEN_FINDING, '- pass 2 | 2026-10-23 09:40 PDT | Codex (GPT-6) | diff | findings', '  - R1.1 | P2 | open | again'], line: 5, reason: /R1\.1 was opened before/ },
    { lines: ['- pass 1 | 2026-10-23 09:05 PDT | Codex (GPT-6) | diff | findings', '  - R2.1 | P2 | open | wrong pass'], line: 2, reason: /takes an R1\.<k> id/ },
    { lines: [...CLEAN_PASS, '- response 1 | 2026-10-23 09:30 PDT | Claude Opus 5.5', '  - R1.4 | P2 | accepted | fixed'], line: 3, reason: /R1\.4, which no pass has opened/ },
    { lines: [...CLEAN_PASS, '- owner | 2026-10-23 10:00 PDT | Jack | defer R1.1 | later'], line: 2, reason: /defers R1\.1, which no pass has opened/ },
    { lines: ['- pass 1 | 2026-10-23 09:05 PDT | Codex (GPT-6) | diff | no findings', '  - R1.1 | P2 | open | a finding'], line: 1, reason: /"no findings" but it opens/ },
    { lines: ['- pass 1 | 2026-10-23 09:05 PDT | Codex (GPT-6) | diff | findings'], line: 1, reason: /"findings" but it opens and reopens none/ },
    { lines: ['- pass 1 | 2026-10-23 9:05 PDT | Codex (GPT-6) | diff | no findings'], line: 1, reason: /the time "2026-10-23 9:05 PDT"/ },
    { lines: ['- pass 1 | 2026-10-23 09:05 PDT | Codex (GPT-6) | diff | nothing'], line: 1, reason: /outcome "nothing"/ },
    { lines: ['- pass 1 | 2026-10-23 09:05 PDT | Codex (GPT-6) | diff | findings', '  - R1.1 | P4 | open | x'], line: 2, reason: /severity "P4"/ },
    { lines: ['- pass 1 | 2026-10-23 09:05 PDT | Codex (GPT-6) | diff | findings', '  - R1.1 | P2 | open | '], line: 2, reason: /reason field is empty/ },
    { lines: ['- pass 1 | 2026-10-23 09:05 PDT | Codex (GPT-6) | diff | findings', '  - A1 | P2 | open | x'], line: 2, reason: /"A1" is not a finding id/ },
    { lines: [...CLEAN_PASS, '    stray detail'], line: 2, reason: /continuation line/ },
    { lines: [...CLEAN_PASS, ' - indented once'], line: 2, reason: /indented 1 spaces/ },
    { lines: [...CLEAN_PASS, '- owner | 2026-10-23 10:00 PDT | Jack | ship it | fine'], line: 2, reason: /choice "ship it"/ },
    { lines: [...CLEAN_PASS, '- owner | 2026-10-23 10:00 PDT | Jack | another round | fine', '  - R1.1 | P2 | open | x'], line: 3, reason: /owner line takes no finding lines/ },
  ];

  for (const testCase of cases) {
    const result = evaluate(testCase.lines);
    assert.equal(result.status, 'failed', testCase.lines.join(' / '));
    assert.equal(result.parsed.ok, false);
    // The log starts at wip.md line 7 in this fixture.
    assert.equal(result.parsed.malformed.lineNumber, 6 + testCase.line, testCase.lines.join(' / '));
    assert.match(result.parsed.malformed.reason, testCase.reason);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].message, new RegExp(`malformed at wip\\.md line ${6 + testCase.line}`));
    assert.equal(result.passesLine, 'none parseable');
  }
});

test('a fenced example of the section in ## Log is not the review log; a fence inside the real one is malformed', () => {
  const wip = [
    '# WIP — 2026-10-23 (session 1)',
    '',
    '## Log',
    '- the format, for reference:',
    '```',
    '## Review log',
    ...CLEAN_PASS,
    '```',
    '',
    '## Review log',
    ...OPEN_FINDING,
    '',
  ].join('\n');
  const real = evaluateReviewRecord(wip);
  assert.equal(real.parsed.ok, true);
  assert.equal(real.status, 'failed');
  assert.deepEqual(real.parsed.findings.map((finding) => [finding.id, finding.severity]), [['R1.1', 'P2']]);
  assert.match(real.failures[0].message, /^R1\.1 \(P2\) is open/);

  const fencedRecord = evaluate(['```', ...CLEAN_PASS, '```']);
  assert.equal(fencedRecord.parsed.ok, false);
  assert.equal(fencedRecord.parsed.malformed.lineNumber, 7);
  assert.equal(fencedRecord.parsed.malformed.text, '```');
});

test('review settings: defaults, valid values, and fallbacks with warnings (D-394 item 7)', () => {
  assert.deepEqual(resolveReviewSettings(undefined), { check: 'warn', roundCap: 3, warnings: [] });
  assert.deepEqual(resolveReviewSettings({ check: 'block', round_cap: 10 }), { check: 'block', roundCap: 10, warnings: [] });
  assert.deepEqual(resolveReviewSettings({ check: 'off', round_cap: 1 }), { check: 'off', roundCap: 1, warnings: [] });
  const fallback = resolveReviewSettings({ check: 'strict', round_cap: 11, colour: 'red' });
  assert.equal(fallback.check, 'warn');
  assert.equal(fallback.roundCap, 3);
  assert.equal(fallback.warnings.length, 3);
  assert.match(fallback.warnings.join('\n'), /unknown key "colour"/);
  assert.match(fallback.warnings.join('\n'), /check is "strict", not warn, block, or off; using warn/);
  assert.match(fallback.warnings.join('\n'), /round_cap is 11, not a whole number from 1 to 10; using 3/);
  assert.match(resolveReviewSettings({ round_cap: '3' }).warnings[0], /round_cap is "3"/);
  assert.match(resolveReviewSettings('block').warnings[0], /not a mapping/);
});

test('no pass: warn closes, records the failure, and names the next step', async (t) => {
  const root = await createRoot(t);
  await openLane(root, 'no-pass');
  const result = await close(root, 'no-pass');
  const note = await readFile(result.sessionFilePath, 'utf8');
  assert.match(note, /## Models used\n- Not recorded\.\n\n## Review\n- Check: failed \(warn\): the review log has no pass line\n- Passes: 0 against a cap of 3\n\n## Document maintenance checkpoint/);
  assert.equal(result.review.outcome, 'failed');
  assert.ok(result.warnings.some((warning) => /^Review check failed \(warn\): the review log has no pass line — next: ask the owner to start a reviewer with `review handoff no-pass`; a check the builder runs itself is not a pass$/.test(warning)));
});

test('a clean pass passes, with the reviewer on the Passes line', async (t) => {
  const root = await createRoot(t);
  await writeReviewLog(await openLane(root, 'clean'), CLEAN_PASS);
  const result = await close(root, 'clean');
  const section = reviewSection(await readFile(result.sessionFilePath, 'utf8'));
  assert.equal(section, '- Check: passed\n- Passes: 1 against a cap of 3; reviewers: Codex (GPT-6)');
  assert.equal(result.review.checkLine, 'passed');
  assert.ok(!result.warnings.some((warning) => warning.startsWith('Review check failed')));
});

test('open findings: warn closes with the failure; block refuses and writes or deletes nothing', async (t) => {
  const warnRoot = await createRoot(t);
  await writeReviewLog(await openLane(warnRoot, 'open-warn'), OPEN_FINDING);
  const warned = await close(warnRoot, 'open-warn');
  const section = reviewSection(await readFile(warned.sessionFilePath, 'utf8'));
  assert.match(section, /^- Check: failed \(warn\): R1\.1 \(P2\) is open, waiting for the builder's response\n/);
  assert.match(section, /\n- R1\.1 \(P2\) the parser accepts a time without minutes$/);
  assert.ok(warned.warnings.some((warning) => /R1\.1 \(P2\) is open, waiting for the builder's response — next: answer it with a response line/.test(warning)));

  const blockRoot = await createRoot(t, { review: ['check: block'] });
  const wipPath = await openLane(blockRoot, 'open-block');
  await writeReviewLog(wipPath, OPEN_FINDING);
  const laneDir = path.dirname(wipPath);
  const before = {
    wip: await readFile(wipPath, 'utf8'),
    claude: await readFile(path.join(blockRoot.tempDir, 'CLAUDE.md'), 'utf8'),
    index: await readFile(path.join(blockRoot.rootDir, 'sessions/active/index.yaml'), 'utf8'),
    lane: (await readdir(laneDir)).sort(),
    notes: (await readdir(path.join(blockRoot.rootDir, 'sessions'))).sort(),
  };
  await assert.rejects(
    () => close(blockRoot, 'open-block'),
    (error) => {
      assert.match(error.message, /^close-session refused: the review check failed and project\.yaml sets metadata\.workflow\.review\.check to block\. Nothing was written or deleted\./);
      assert.match(error.message, /\n- R1\.1 \(P2\) is open, waiting for the builder's response — next: answer it/);
      assert.match(error.message, /vibecompass review-check --session open-block/);
      assert.match(error.message, /--review-override "<the owner's reason>"/);
      return true;
    },
  );
  assert.equal(await readFile(wipPath, 'utf8'), before.wip);
  assert.equal(await readFile(path.join(blockRoot.tempDir, 'CLAUDE.md'), 'utf8'), before.claude);
  assert.equal(await readFile(path.join(blockRoot.rootDir, 'sessions/active/index.yaml'), 'utf8'), before.index);
  assert.deepEqual((await readdir(laneDir)).sort(), before.lane);
  assert.deepEqual((await readdir(path.join(blockRoot.rootDir, 'sessions'))).sort(), before.notes);
});

test('addressed and confirmed findings pass, and the note keeps each finding with its disposition and verdict', async (t) => {
  const root = await createRoot(t, { review: ['check: block'] });
  await writeReviewLog(await openLane(root, 'addressed'), WORKED_EXAMPLE);
  const result = await close(root, 'addressed');
  const section = reviewSection(await readFile(result.sessionFilePath, 'utf8'));
  assert.equal(section, [
    '- Check: passed',
    '- Passes: 2 against a cap of 3; reviewers: Codex (GPT-6)',
    "- R1.1 (P2) the owner line doesn't say who writes it — accepted: item 2 now says the builder writes it in the owner's words — confirmed: fixed in item 2",
    "- R1.2 (P3) `leave open` changes nothing the check can see — rejected: it records the owner's choice for the note; the check ignores it on purpose — confirmed: accepts the reason",
  ].join('\n'));
});

test('a confirmed deferral keeps the builder\'s reason in the note and its next steps, unless a --next-step names the id', async (t) => {
  const root = await createRoot(t);
  const log = [
    '- pass 1 | 2026-10-23 09:05 PDT | Codex (GPT-6) | the diff | findings',
    '  - R1.1 | P3 | open | the help text repeats the flag list',
    '- response 1 | 2026-10-23 09:30 PDT | Claude Opus 5.5',
    '  - R1.1 | P3 | deferred | out of scope here; the help rewrite in PKG1 takes it',
    '- pass 2 | 2026-10-23 09:50 PDT | Codex (GPT-6) | response 1 | no findings',
    '  - R1.1 | P3 | confirmed | accepts the deferral to PKG1',
  ];
  await writeReviewLog(await openLane(root, 'deferral'), log);
  const result = await close(root, 'deferral');
  const note = await readFile(result.sessionFilePath, 'utf8');
  assert.match(reviewSection(note), /\n- R1\.1 \(P3\) the help text repeats the flag list — deferred: out of scope here; the help rewrite in PKG1 takes it — confirmed: accepts the deferral to PKG1$/);
  assert.match(note, /## Next session should start with\n1\. Continue\.\n2\. Deferred review finding R1\.1 \(P3\): the help text repeats the flag list — out of scope here; the help rewrite in PKG1 takes it\n$/);
  assert.equal(result.review.outcome, 'passed');

  await writeReviewLog(await openLane(root, 'deferral-named'), log);
  const named = await close(root, 'deferral-named', { title: 'Named Deferral', nextSteps: ['PKG1 takes review finding R1.1.'] });
  const namedNote = await readFile(named.sessionFilePath, 'utf8');
  assert.match(namedNote, /## Next session should start with\n1\. PKG1 takes review finding R1\.1\.\n$/);
});

test('a malformed line fails, and the same line corrected in place passes', async (t) => {
  const root = await createRoot(t);
  const wipPath = await openLane(root, 'corrected');
  await writeReviewLog(wipPath, ['- pass 1 | 2026-10-23 9:05 PDT | Codex (GPT-6) | the diff | no findings']);
  const failed = await checkProjectSessionReview({ cwd: root.tempDir, rootDir: root.rootDir, sessionId: 'corrected' });
  assert.equal(failed.ok, false);
  assert.match(failed.failures[0].message, /malformed at wip\.md line \d+ \(the time "2026-10-23 9:05 PDT" is not "YYYY-MM-DD HH:MM" with an optional zone\): - pass 1 \| 2026-10-23 9:05 PDT/);
  assert.match(failed.failures[0].nextStep, /corrects it in place/);

  await writeReviewLog(wipPath, CLEAN_PASS);
  const fixed = await checkProjectSessionReview({ cwd: root.tempDir, rootDir: root.rootDir, sessionId: 'corrected' });
  assert.equal(fixed.ok, true);
  assert.equal(fixed.status, 'passed');
  const result = await close(root, 'corrected');
  assert.equal(result.review.checkLine, 'passed');
});

test('a legacy free-text log fails, and still fails after a clean pass is appended', async (t) => {
  const root = await createRoot(t);
  const wipPath = await openLane(root, 'legacy');
  const legacy = ['- 2026-10-23 09:05 PDT Codex reviewed the diff: no findings.'];
  await writeReviewLog(wipPath, legacy);
  const first = await checkProjectSessionReview({ cwd: root.tempDir, rootDir: root.rootDir, sessionId: 'legacy' });
  assert.equal(first.ok, false);

  await writeReviewLog(wipPath, [...legacy, ...CLEAN_PASS]);
  const second = await checkProjectSessionReview({ cwd: root.tempDir, rootDir: root.rootDir, sessionId: 'legacy' });
  assert.equal(second.ok, false);
  assert.equal(second.failures[0].kind, 'malformed');
  assert.match(second.failures[0].message, /- 2026-10-23 09:05 PDT Codex reviewed the diff: no findings\.$/);

  const result = await close(root, 'legacy');
  const section = reviewSection(await readFile(result.sessionFilePath, 'utf8'));
  assert.match(section, /^- Check: failed \(warn\): the review log is malformed at wip\.md line \d+ \(not a record line: a record starts "- pass <n>", "- response <n>", or "- owner"\): - 2026-10-23 09:05 PDT Codex/);
  assert.match(section, /\n- Passes: none parseable\n- No parseable review record: - 2026-10-23 09:05 PDT Codex reviewed the diff: no findings\.$/);
});

test('a malformed log closes with --review-override in block mode, and the note keeps the check line and the owner\'s reason', async (t) => {
  const root = await createRoot(t, { review: ['check: block'] });
  await writeReviewLog(await openLane(root, 'override'), ['Reviewed by Codex in chat; nothing found.']);
  await assert.rejects(() => close(root, 'override'), /close-session refused/);
  await assert.rejects(() => close(root, 'override', { reviewOverride: '   ' }), /--review-override needs the owner's reason/);

  const result = await close(root, 'override', {
    reviewOverride: 'The lane opened before PM5 shipped; I accept the chat review.',
    reviewNotes: ['Codex reviewed the diff in chat on 2026-10-23.'],
  });
  const section = reviewSection(await readFile(result.sessionFilePath, 'utf8'));
  assert.match(section, /^- Check: overridden by the owner: The lane opened before PM5 shipped; I accept the chat review\.; failures: the review log is malformed at wip\.md line \d+ \(not a record line: the log holds only pass, response, owner, finding, and continuation lines\): Reviewed by Codex in chat; nothing found\.\n/);
  assert.match(section, /\n- Passes: none parseable\n- No parseable review record: Reviewed by Codex in chat; nothing found\.\n- Codex reviewed the diff in chat on 2026-10-23\.$/);
  assert.equal(result.review.outcome, 'overridden');
  assert.ok(!result.warnings.some((warning) => warning.startsWith('Review check failed')));
});

const CAP_ROUNDS = [
  '- pass 1 | 2026-10-23 09:00 PDT | Codex (GPT-6) | diff | findings',
  '  - R1.1 | P2 | open | the check skips project-manager lanes with a pass',
  '- response 1 | 2026-10-23 09:10 PDT | Claude Opus 5.5',
  '  - R1.1 | P2 | accepted | the role check now looks for a pass line',
  '- pass 2 | 2026-10-23 09:20 PDT | Codex (GPT-6) | response 1 | findings',
  '  - R1.1 | P2 | reopened | a malformed project-manager log still skips',
  '- response 2 | 2026-10-23 09:30 PDT | Claude Opus 5.5',
  '  - R1.1 | P2 | accepted | it now reads the raw pass lines',
  '- pass 3 | 2026-10-23 09:40 PDT | Codex (GPT-6) | response 2 | findings',
  '  - R1.1 | P2 | reopened | no test covers it',
  '- response 3 | 2026-10-23 09:50 PDT | Claude Opus 5.5',
  '  - R1.1 | P2 | accepted | added the test',
];

const CAP_PASS_4 = [
  '- pass 4 | 2026-10-23 10:10 PDT | Codex (GPT-6) | response 3 | no findings',
  '  - R1.1 | P2 | confirmed | the test covers it',
];

const ANOTHER_ROUND = '- owner | 2026-10-23 10:00 PDT | Jack (owner) | another round | one more pass to confirm the test';

const STOP_AND_REPORT = (passes, id, lane) => new RegExp(
  `^the lane has run ${passes} passes against a cap of 3: stop and report the open findings, and say the next pass runs past the cap; the owner starts a reviewer \\(\`review handoff ${lane}\`\\), defers ${id.replace('.', '\\.')}, or leaves the lane open$`,
);

// D-403: a pass past the cap needs no owner line; the cap stays the builder's
// stop-and-report point, and the Passes line counts the passes past it.
test('the cap: at it the next step is to stop and report; a pass past it needs no owner line, in block mode too', async (t) => {
  const root = await createRoot(t, { review: ['check: block'] });

  const atCap = await checkProjectSessionReview({ cwd: root.tempDir, rootDir: root.rootDir, sessionId: await writeLaneLog(root, 'at-cap', CAP_ROUNDS) });
  assert.equal(atCap.ok, false);
  assert.deepEqual(atCap.failures.map((failure) => failure.kind), ['open-finding']);
  assert.match(atCap.failures[0].message, /^R1\.1 \(P2\) is open, waiting for the reviewer's verdict$/);
  assert.match(atCap.failures[0].nextStep, STOP_AND_REPORT(3, 'R1.1', 'at-cap'));
  await assert.rejects(() => close(root, 'at-cap'), /close-session refused/);

  // Below the cap the builder still asks the owner for the next pass.
  const below = await checkProjectSessionReview({ cwd: root.tempDir, rootDir: root.rootDir, sessionId: await writeLaneLog(root, 'below-cap', CAP_ROUNDS.slice(0, 4)) });
  assert.match(below.failures[0].nextStep, /^ask the owner for the reviewer's next pass \(`review handoff below-cap`\)$/);

  // Pass 4 with no owner line before it: review-check passes and the lane closes.
  const past = await checkProjectSessionReview({ cwd: root.tempDir, rootDir: root.rootDir, sessionId: await writeLaneLog(root, 'past-cap', [...CAP_ROUNDS, ...CAP_PASS_4]) });
  assert.equal(past.ok, true);
  assert.equal(past.status, 'passed');
  assert.deepEqual(past.failures, []);
  assert.equal(past.passesLine, '4 against a cap of 3, 1 past it; reviewers: Codex (GPT-6)');

  const io = captureIo();
  assert.equal(await runCli(['review-check', '--root', root.rootDir, '--session', 'past-cap', '--json'], io.io, { cwd: root.tempDir }), 0);
  const payload = JSON.parse(io.stdout());
  assert.equal(payload.result, 'passed');
  assert.equal(payload.passes, 4);
  assert.equal(payload.passes_past_cap, 1);
  assert.equal(payload.another_rounds, 0);

  const closed = await close(root, 'past-cap');
  assert.equal(closed.review.checkLine, 'passed');
  const section = reviewSection(await readFile(closed.sessionFilePath, 'utf8'));
  assert.match(section, /^- Check: passed\n- Passes: 4 against a cap of 3, 1 past it; reviewers: Codex \(GPT-6\)\n- R1\.1 \(P2\) the check skips project-manager lanes with a pass — accepted: added the test — confirmed: the test covers it$/);

  // Past the cap, every round still ends with the builder's report.
  const pastAgain = await checkProjectSessionReview({
    cwd: root.tempDir,
    rootDir: root.rootDir,
    sessionId: await writeLaneLog(root, 'past-cap-again', [
      ...CAP_ROUNDS,
      '- pass 4 | 2026-10-23 10:10 PDT | Codex (GPT-6) | response 3 | findings',
      '  - R1.1 | P2 | reopened | the test never runs the block mode',
      '- response 4 | 2026-10-23 10:20 PDT | Claude Opus 5.5',
      '  - R1.1 | P2 | accepted | the test now runs it',
    ]),
  });
  assert.equal(pastAgain.ok, false);
  assert.deepEqual(pastAgain.failures.map((failure) => failure.kind), ['open-finding']);
  assert.match(pastAgain.failures[0].nextStep, STOP_AND_REPORT(4, 'R1.1', 'past-cap-again'));
});

test('an older log with another-round lines still passes and reads the same in the note; the line buys no pass', async (t) => {
  const root = await createRoot(t, { review: ['check: block'] });

  const io = captureIo();
  const lane = await writeLaneLog(root, 'owner-round', [...CAP_ROUNDS, ANOTHER_ROUND, ...CAP_PASS_4]);
  assert.equal(await runCli(['review-check', '--root', root.rootDir, '--session', lane, '--json'], io.io, { cwd: root.tempDir }), 0);
  const payload = JSON.parse(io.stdout());
  assert.equal(payload.passes_past_cap, 1);
  assert.equal(payload.another_rounds, 1);
  assert.deepEqual(payload.owner_lines, [{ time: '2026-10-23 10:00 PDT', owner: 'Jack (owner)', choice: 'another round', reason: 'one more pass to confirm the test' }]);

  const withOwner = await close(root, lane);
  const section = reviewSection(await readFile(withOwner.sessionFilePath, 'utf8'));
  assert.match(section, /^- Check: passed\n- Passes: 4 against a cap of 3, 1 past it; reviewers: Codex \(GPT-6\)\n/);
  assert.match(section, /\n- Owner, Jack \(owner\), 2026-10-23 10:00 PDT: another round — one more pass to confirm the test$/);

  // The same log without the owner line reads the same, apart from that line.
  const plain = await close(root, await writeLaneLog(root, 'no-owner-round', [...CAP_ROUNDS, ...CAP_PASS_4]));
  const plainSection = reviewSection(await readFile(plain.sessionFilePath, 'utf8'));
  assert.equal(section, `${plainSection}\n- Owner, Jack (owner), 2026-10-23 10:00 PDT: another round — one more pass to confirm the test`);

  // An another-round line at the cap doesn't move the stop-and-report point.
  const atCap = await checkProjectSessionReview({ cwd: root.tempDir, rootDir: root.rootDir, sessionId: await writeLaneLog(root, 'owner-round-at-cap', [...CAP_ROUNDS, ANOTHER_ROUND]) });
  assert.equal(atCap.ok, false);
  assert.match(atCap.failures[0].nextStep, STOP_AND_REPORT(3, 'R1.1', 'owner-round-at-cap'));
});

test('at the cap, an owner defer line passes the check and leave open keeps the lane failing', async (t) => {
  const root = await createRoot(t, { review: ['check: block'] });

  const deferLane = await writeLaneLog(root, 'cap-defer', [...CAP_ROUNDS, '- owner | 2026-10-23 10:00 PDT | Jack (owner) | defer R1.1 | ship it; the next lane adds the test']);
  const deferred = await checkProjectSessionReview({ cwd: root.tempDir, rootDir: root.rootDir, sessionId: deferLane });
  assert.equal(deferred.ok, true);
  assert.equal(deferred.parsed.findings[0].deferredByOwner, true);
  const closed = await close(root, deferLane);
  const note = await readFile(closed.sessionFilePath, 'utf8');
  assert.match(reviewSection(note), /^- Check: passed\n- Passes: 3 against a cap of 3; reviewers: Codex \(GPT-6\)\n[\s\S]*\n- Owner, Jack \(owner\), 2026-10-23 10:00 PDT: defer R1\.1 — ship it; the next lane adds the test$/);
  assert.match(note, /\n2\. Deferred review finding R1\.1 \(P2\): the check skips project-manager lanes with a pass — deferred by the owner: ship it; the next lane adds the test\n$/);

  const leaveLane = await writeLaneLog(root, 'cap-leave-open', [...CAP_ROUNDS, '- owner | 2026-10-23 10:00 PDT | Jack (owner) | leave open | I will decide after the release']);
  const leftOpen = await checkProjectSessionReview({ cwd: root.tempDir, rootDir: root.rootDir, sessionId: leaveLane });
  assert.equal(leftOpen.ok, false);
  assert.match(leftOpen.failures[0].nextStep, STOP_AND_REPORT(3, 'R1.1', 'cap-leave-open'));
  const io = captureIo();
  assert.equal(await runCli(['review-check', '--root', root.rootDir, '--session', leaveLane], io.io, { cwd: root.tempDir }), 1);
  assert.match(io.stdout(), /\nOwner, Jack \(owner\), 2026-10-23 10:00 PDT: leave open — I will decide after the release\n/);
  await assert.rejects(() => close(root, leaveLane), /close-session refused/);
});

test('an owner deferral stops failing the check until the reviewer reopens the finding', async (t) => {
  const deferred = [
    '- pass 1 | 2026-10-23 09:00 PDT | Codex (GPT-6) | diff | findings',
    '  - R1.1 | P2 | open | the note drops continuation lines',
    '- response 1 | 2026-10-23 09:10 PDT | Claude Opus 5.5',
    '  - R1.1 | P2 | rejected | D-394 says the check ignores them',
    '- owner | 2026-10-23 09:30 PDT | Jack (owner) | defer R1.1 | ship it; PM6 decides whether the note keeps evidence',
  ];
  const root = await createRoot(t, { review: ['check: block'] });
  const deferredPath = await openLane(root, 'owner-defer');
  await writeReviewLog(deferredPath, deferred);
  const check = await checkProjectSessionReview({ cwd: root.tempDir, rootDir: root.rootDir, sessionId: 'owner-defer' });
  assert.equal(check.ok, true);
  assert.equal(check.parsed.findings[0].deferredByOwner, true);
  assert.equal(check.parsed.findings[0].resolved, false);

  const io = captureIo();
  assert.equal(await runCli(['review-check', '--root', root.rootDir, '--session', 'owner-defer'], io.io, { cwd: root.tempDir }), 0);
  assert.match(io.stdout(), /- R1\.1 \(P2\) deferred by the owner: the note drops continuation lines/);

  const closed = await close(root, 'owner-defer');
  const note = await readFile(closed.sessionFilePath, 'utf8');
  assert.match(reviewSection(note), /\n- R1\.1 \(P2\) the note drops continuation lines — rejected: D-394 says the check ignores them — deferred by the owner: ship it; PM6 decides whether the note keeps evidence\n- Owner, Jack \(owner\), 2026-10-23 09:30 PDT: defer R1\.1 — ship it; PM6 decides whether the note keeps evidence$/);
  assert.match(note, /\n2\. Deferred review finding R1\.1 \(P2\): the note drops continuation lines — deferred by the owner: ship it; PM6 decides whether the note keeps evidence\n$/);

  const reopenedPath = await openLane(root, 'owner-defer-reopened');
  await writeReviewLog(reopenedPath, [
    ...deferred,
    '- pass 2 | 2026-10-23 10:00 PDT | Codex (GPT-6) | the deferral | findings',
    '  - R1.1 | P1 | reopened | the release notes now quote the dropped evidence',
  ]);
  const reopened = await checkProjectSessionReview({ cwd: root.tempDir, rootDir: root.rootDir, sessionId: 'owner-defer-reopened' });
  assert.equal(reopened.ok, false);
  assert.match(reopened.failures[0].message, /^R1\.1 \(P1\) is open, waiting for the builder's response$/);
  await assert.rejects(() => close(root, 'owner-defer-reopened'), /R1\.1 \(P1\) is open/);
});

test('each check value: warn closes with warnings, block refuses, off skips the check but still writes the section', async (t) => {
  const offRoot = await createRoot(t, { review: ['check: off'] });
  await writeReviewLog(await openLane(offRoot, 'check-off'), OPEN_FINDING);
  const off = await close(offRoot, 'check-off');
  const offSection = reviewSection(await readFile(off.sessionFilePath, 'utf8'));
  assert.match(offSection, /^- Check: off\n- Passes: 1 against a cap of 3; reviewers: Codex \(GPT-6\)\n- R1\.1 \(P2\) the parser accepts a time without minutes$/);
  assert.ok(!off.warnings.some((warning) => warning.startsWith('Review check failed')));

  const invalidRoot = await createRoot(t, { review: ['check: strict', 'round_cap: 0', 'colour: red'] });
  await openLane(invalidRoot, 'invalid');
  const invalid = await close(invalidRoot, 'invalid');
  assert.equal(invalid.review.check, 'warn');
  assert.equal(invalid.review.roundCap, 3);
  assert.ok(invalid.warnings.some((warning) => /review\.check is "strict", not warn, block, or off; using warn/.test(warning)));
  assert.ok(invalid.warnings.some((warning) => /round_cap is 0, not a whole number from 1 to 10; using 3/.test(warning)));
  assert.ok(invalid.warnings.some((warning) => /unknown key "colour"/.test(warning)));
  assert.match(reviewSection(await readFile(invalid.sessionFilePath, 'utf8')), /^- Check: failed \(warn\): the review log has no pass line/);

  // A pass past the cap fails nothing in warn mode (D-403).
  const capRoot = await createRoot(t, { review: ['round_cap: 1'] });
  await writeReviewLog(await openLane(capRoot, 'cap-one'), [...CLEAN_PASS, '- pass 2 | 2026-10-23 09:40 PDT | Codex (GPT-6) | again | no findings']);
  const capOne = await close(capRoot, 'cap-one');
  assert.ok(!capOne.warnings.some((warning) => warning.startsWith('Review check failed')));
  assert.match(reviewSection(await readFile(capOne.sessionFilePath, 'utf8')), /^- Check: passed\n- Passes: 2 against a cap of 1, 1 past it; reviewers: Codex \(GPT-6\)$/);

  // At the cap, warn closes and records the open finding; its next step is the builder's report.
  const warnRoot = await createRoot(t);
  await writeReviewLog(await openLane(warnRoot, 'warn-at-cap'), CAP_ROUNDS);
  const warnAtCap = await close(warnRoot, 'warn-at-cap');
  assert.ok(warnAtCap.warnings.some((warning) => /^Review check failed \(warn\): R1\.1 \(P2\) is open, waiting for the reviewer's verdict — next: the lane has run 3 passes against a cap of 3: stop and report/.test(warning)));
  assert.match(reviewSection(await readFile(warnAtCap.sessionFilePath, 'utf8')), /^- Check: failed \(warn\): R1\.1 \(P2\) is open, waiting for the reviewer's verdict\n- Passes: 3 against a cap of 3; reviewers: Codex \(GPT-6\)\n/);

  // Off skips the check; the Passes line still counts the passes past the cap.
  await writeReviewLog(await openLane(offRoot, 'off-past-cap'), [...CAP_ROUNDS, ...CAP_PASS_4]);
  const offPast = await close(offRoot, 'off-past-cap', { title: 'Off Past Cap' });
  assert.match(reviewSection(await readFile(offPast.sessionFilePath, 'utf8')), /^- Check: off\n- Passes: 4 against a cap of 3, 1 past it; reviewers: Codex \(GPT-6\)\n/);
});

test('a project-manager lane needs no pass until its log has one (D-392)', async (t) => {
  const root = await createRoot(t, { review: ['check: block'] });
  await openLane(root, 'pm-plain', { role: 'project-manager' });
  const plain = await close(root, 'pm-plain');
  assert.match(reviewSection(await readFile(plain.sessionFilePath, 'utf8')), /^- Check: not required \(project-manager lane\)\n- Passes: 0 against a cap of 3$/);

  await writeReviewLog(await openLane(root, 'pm-reviewed', { role: 'project-manager' }), OPEN_FINDING);
  await assert.rejects(() => close(root, 'pm-reviewed', { title: 'PM Reviewed' }), /R1\.1 \(P2\) is open/);
});

test('close-session and review-check on the command line', async (t) => {
  const root = await createRoot(t);
  await writeReviewLog(await openLane(root, 'cli-lane'), OPEN_FINDING);

  const failing = captureIo();
  assert.equal(await runCli(['review-check', '--root', root.rootDir, '--session', 'cli-lane'], failing.io, { cwd: root.tempDir }), 1);
  assert.match(failing.stdout(), /^Review check for lane cli-lane \(builder lane; check warn, round_cap 3\)\nPasses: 1 against a cap of 3; reviewers: Codex \(GPT-6\)\nFindings:\n- R1\.1 \(P2\) open, waiting for the builder: the parser accepts a time without minutes\nResult: failed \(warn\): R1\.1 \(P2\) is open, waiting for the builder's response\n- R1\.1 \(P2\) is open, waiting for the builder's response — next: answer it with a response line \(`address review`\)\n$/);

  const json = captureIo();
  assert.equal(await runCli(['review-check', '--root', root.rootDir, '--session', 'cli-lane', '--json'], json.io, { cwd: root.tempDir }), 1);
  const payload = JSON.parse(json.stdout());
  assert.equal(payload.lane_id, 'cli-lane');
  assert.equal(payload.result, 'failed');
  assert.equal(payload.ok, false);
  assert.equal(payload.passes, 1);
  assert.deepEqual(payload.reviewers, ['Codex (GPT-6)']);
  assert.equal(payload.findings[0].id, 'R1.1');
  assert.equal(payload.findings[0].waiting_for, 'builder');
  assert.equal(payload.failures[0].kind, 'open-finding');
  assert.equal(payload.malformed, null);

  const closing = captureIo();
  const exitCode = await runCli([
    'close-session', '--root', root.rootDir, '--session', 'cli-lane',
    '--title', 'CLI Close', '--completed', 'Done.', '--next-step', 'Next.',
    '--architecture-docs', 'updated', '--decision-log', 'updated', '--session-maintenance', 'updated',
    '--review-override', 'I reviewed this one myself.',
    '--review-note', 'First note.', '--review-note', 'Second note.',
  ], closing.io, { cwd: root.tempDir });
  assert.equal(exitCode, 0);
  assert.match(closing.stdout(), /\nReview check: overridden by the owner: I reviewed this one myself\.; failures: R1\.1 \(P2\) is open, waiting for the builder's response\n/);
  const notePath = closing.stdout().match(/^Wrote (.+)$/m)[1];
  assert.match(notePath, /-cli-close\.md$/);
  assert.match(reviewSection(await readFile(notePath, 'utf8')), /\n- First note\.\n- Second note\.$/);
  await assert.rejects(() => access(path.join(root.rootDir, 'sessions/active/cli-lane')));
});

test('init and refresh-workflow write no review: block; refresh keeps one the owner wrote; context names both keys and their effective values', async (t) => {
  const root = await createRoot(t);
  const projectPath = path.join(root.rootDir, 'project.yaml');
  assert.doesNotMatch(await readFile(projectPath, 'utf8'), /\n\s+review:/);
  const context = await readFile(path.join(root.rootDir, 'context.md'), 'utf8');
  assert.match(context, /- review check: `metadata\.workflow\.review\.check` is `warn` \(the default\); on a failed check, `warn` closes and records the failures in the note, `block` refuses to close and writes nothing, and `off` skips the check/);
  assert.match(context, /- review round cap: `metadata\.workflow\.review\.round_cap` is 3 \(the default\); at it, the builder stops and reports the open findings, and a pass past it is the owner's to start, with no owner line/);

  const io = captureIo();
  assert.equal(await runCli(['refresh-workflow', '--root', root.rootDir, '--apply'], io.io, { cwd: root.tempDir }), 0);
  assert.doesNotMatch(await readFile(projectPath, 'utf8'), /\n\s+review:/);

  await setReviewSettings(root.rootDir, ['check: block', 'round_cap: 5']);
  const before = await readFile(projectPath, 'utf8');
  const refreshed = captureIo();
  assert.equal(await runCli(['refresh-workflow', '--root', root.rootDir, '--apply'], refreshed.io, { cwd: root.tempDir }), 0);
  assert.equal(await readFile(projectPath, 'utf8'), before);
  const customContext = await readFile(path.join(root.rootDir, 'context.md'), 'utf8');
  assert.match(customContext, /- review check: `metadata\.workflow\.review\.check` is `block`; on a failed check/);
  assert.match(customContext, /- review round cap: `metadata\.workflow\.review\.round_cap` is 5; at it, the builder stops and reports/);
  // The generated guide names the setting rather than a number, so a non-default cap never contradicts it.
  const customGuide = await readFile(path.join(root.rootDir, 'workflows/project-manager.md'), 'utf8');
  assert.match(customGuide, /- \*\*A cap on rounds,\*\* where a round is one reviewer pass and the builder's response\. The cap is `metadata\.workflow\.review\.round_cap`, 3 by default; `\.compass\/context\.md` › Workflow defaults gives this project's value\. If findings are still open once the lane has run as many rounds as the cap/);
  assert.doesNotMatch(customGuide, /cap of 3|after the third/);

  const metadata = buildWorkflowMetadata({ workflow: { review: { check: 'block', round_cap: 5 }, reviewer_handback: 'handoff-file' } });
  assert.deepEqual(metadata.workflow.review, { check: 'block', round_cap: 5 });
  assert.equal(Object.hasOwn(buildWorkflowMetadata({}).workflow, 'review'), false);
});

test('context.md, the managed block, and workflows/project-manager.md carry the independent-review rule (D-398) and the record format (D-394)', async (t) => {
  const root = await createRoot(t);
  const context = await readFile(path.join(root.rootDir, 'context.md'), 'utf8');
  const managed = await readFile(path.join(root.tempDir, 'CLAUDE.md'), 'utf8');
  const guide = await readFile(path.join(root.rootDir, 'workflows/project-manager.md'), 'utf8');

  // context.md: the format section with item 3's worked example, and the rule in each role's text.
  assert.match(context, /## Review log format\n/);
  assert.match(context, /- \*\*Pass line\*\* \(reviewer\): `- pass <n> \| <time> \| <reviewer> \| <scope> \| <outcome>`/);
  assert.match(context, /```\n## Review log\n- pass 1 \| 2026-10-20 10:42 PDT \| Codex \(GPT-6\) \| the four draft decisions \| findings\n  - R1\.1 \| P2 \| open \| the owner line doesn't say who writes it\n[\s\S]*?  - R1\.2 \| P3 \| confirmed \| accepts the reason\n```/);
  assert.match(context, /\*\*Who counts as a reviewer\.\*\* A pass is a run by a reviewer the owner started and pointed at the lane with `review handoff <lane-id>`/);
  assert.match(context, /- a review pass counts only when a reviewer the owner started runs it: a subagent you launch, a second model you prompt, or a review tool you run on your own work does your own checks; record those in `## Log`, never as pass lines, and never write a pass line yourself/);
  assert.match(context, /- answer each pass in `wip\.md` › `## Review log` with a response line/);
  assert.match(context, /- you are the lane's reviewer only when the owner started you and pointed you at the lane with `review handoff <lane-id>`/);
  assert.match(context, /- run `vibecompass review-check --session <lane-id>` before close-session/);
  assert.match(context, /close-session writes the note's `## Review` section after `## Models used` from the record/);
  assert.doesNotMatch(context, /rather than preserving the full `## Review log`/);
  assert.doesNotMatch(context, /if a granular reviewer trail must remain durable/);
  assert.match(context, /- When it checks a close report, it reads the note's `## Review` section: the `Check:` line, and the reviewers on the `Passes:` line, compared with the reviewer the build prompt named and any the owner has named since/);

  // The managed block's Hard Rules.
  assert.match(managed, /- A review pass counts only when a reviewer the owner started runs it, pointed at the lane with `review handoff <lane-id>`\. An agent the builder launched or directed \(a subagent, a second model, a review tool\) does the builder's own checks: record them in `wip\.md` › `## Log`, never as pass lines\./);

  // The generic project manager guide: The review rule, Checking a close report, Operating rules.
  assert.match(guide, /- \*\*At least one recorded reviewer pass,\*\* even when it finds nothing, by a reviewer the owner started and pointed at the lane with `review handoff <lane-id>`\. An agent the builder launched or directed/);
  assert.match(guide, /## Checking a close report\n[\s\S]*?Read the note's `## Review` section against the review rule\.[\s\S]*?The builder's own account doesn't establish who started a reviewer\.\n\n## When to move on/);
  assert.match(guide, /`vibecompass review-check --root \.compass --session <lane-id>` runs the same check on an open lane/);
  assert.match(guide, /- \*\*Send consequential recommendations through a reviewed lane\*\* before the owner decides \(a plan, a reorder, a protocol change\): one that meets the review rule, with passes by reviewers the owner started\./);
});

test('context.md and workflows/project-manager.md say a pass past the cap needs no owner line and the cap is the builder\'s stop-and-report point (D-403)', async (t) => {
  const root = await createRoot(t);
  const context = await readFile(path.join(root.rootDir, 'context.md'), 'utf8');
  const guide = await readFile(path.join(root.rootDir, 'workflows/project-manager.md'), 'utf8');
  const managed = await readFile(path.join(root.tempDir, 'CLAUDE.md'), 'utf8');

  // Builder workflow: owner lines for defer and leave open, and the stop at the cap.
  assert.match(context, /when the owner defers a finding or leaves the lane open, write an owner line with the owner's choice and the reason in the owner's words\n/);
  assert.match(context, /\n- at the round cap \(Workflow defaults\), when a finding still waits for the reviewer, stop and report: list the open findings and say that the next pass runs past the cap\. Never ask for that pass or start a reviewer yourself\. The owner chooses: another round, by starting a reviewer, which needs no owner line; a deferral; or leaving the lane open\. The same holds after each pass past the cap\n/);
  // Review log format: the owner line's choices.
  assert.match(context, /`<choice>` is `defer <id>\[, <id>…\]` or `leave open`\. `another round` is still accepted but never needed: a pass past the cap needs no owner line, because the owner starting its reviewer is that choice\.\n/);
  // The check.
  assert.match(context, /or when a finding is open and not deferred by the owner\. A pass past the round cap fails nothing\. Once the lane has run as many passes as the cap, the next step for a finding waiting for the reviewer is to stop and report/);
  // The generated guide's review rule.
  assert.match(guide, /it never asks for that pass or starts a reviewer\. The project manager escalates to the owner, who chooses: another round, by starting a reviewer, which needs no owner line; a scoped deferral, recorded as an owner `defer` line whose reason the session note carries; or leaving the lane open\. The same holds after each pass past the cap\. A cap never marks a finding resolved\./);

  for (const [name, text] of [['context.md', context], ['workflows/project-manager.md', guide], ['the managed block', managed]]) {
    assert.doesNotMatch(text, /minus the cap owner|needs one more owner `another round` line|needs an owner `another round` line|the owner chooses at the cap/, `${name} still asks for an owner line before a pass past the cap`);
  }
});
