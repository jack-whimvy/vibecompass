// Offline checks for the A7 evaluation harness (scripts/evaluate-brief-a7.js):
// no model calls. A mock `claude` child stands in for the CLI — research
// sessions, report turns, and graders — and the whole pipeline runs against a
// tiny tagged corpus.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFile, chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, '..', '..');
const FIXTURE_ROOT = path.join(here, 'fixtures', 'brief', 'root');

// The mock CLI. Modes come from its arguments; failure switches from env:
// MOCK_SCENARIO=excess (research stream with an excess call), MOCK_CALLS=N,
// MOCK_REPORT_TURN=bad, MOCK_GRADER=invalid|error|wrongmodel.
const MOCK = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.1.288 (Claude Code)'); process.exit(0); }
const toolsIndex = args.indexOf('--tools');
const noTools = toolsIndex !== -1 && args[toolsIndex + 1] === '';
const grader = args.includes('--json-schema');
const env = process.env;
const init = (tools, overrides = {}) => ({ type: 'system', subtype: 'init', session_id: 's-' + Math.random().toString(16).slice(2), model: 'claude-opus-5-5', tools, permissionMode: 'dontAsk', mcp_servers: [], claude_code_version: '2.1.288', ...overrides });
const usage = { 'claude-opus-5-5': { costUSD: 0.1 } };
const out = (events) => process.stdout.write(events.map((event) => JSON.stringify(event)).join('\\n') + '\\n');
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  if (grader) {
    const keysLine = input.match(/^Checklist keys \\(.*?\\): (.*)$/m);
    const keys = keysLine && !keysLine[1].startsWith('none') ? keysLine[1].split(', ') : [];
    const forbiddenLine = input.match(/^Forbidden claims \\(once each(?:, for each report)?\\): (.*)$/m);
    let forbidden = forbiddenLine ? forbiddenLine[1].split(', ') : [];
    if (env.MOCK_GRADER === 'invalid') forbidden = forbidden.slice(0, -1);
    const side = { clauses: keys.map((key) => ({ key, stated: true, attributed: true, evidence: '' })), forbidden: forbidden.map((id) => ({ id, violated: false, evidence: '', reasoning: '' })), states_no_governing_memory: keys.length === 0, notes: '' };
    const structured = input.includes('\\nReport P:\\n') ? { P: side, Q: side } : { forbidden: side.forbidden, presents_governing_memory_for_no_match: false, closest_call: '', notes: '' };
    const error = env.MOCK_GRADER === 'error';
    out([init(['StructuredOutput']), { type: 'result', subtype: error ? 'error_max_turns' : 'success', is_error: error, structured_output: structured, total_cost_usd: 0.1, modelUsage: env.MOCK_GRADER === 'wrongmodel' ? { 'claude-haiku-4-5': { costUSD: 0.1 } } : usage }]);
    return;
  }
  if (noTools) {
    const bad = env.MOCK_REPORT_TURN === 'bad';
    out([init([], bad ? { model: 'claude-haiku-4-5', claude_code_version: '0.0.0', permissionMode: 'default', mcp_servers: [{ name: 'x' }] } : {}), { type: 'result', subtype: 'success', is_error: false, result: 'REPORT from the transcript', total_cost_usd: 0.1, modelUsage: usage }]);
    return;
  }
  if (env.MOCK_SCENARIO === 'excess') {
    out([
      init(['Glob', 'Grep', 'Read']),
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'CLAUDE.md' } }], usage: { input_tokens: 1, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 10 } } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ALLOWED-RESULT' }] } },
      { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'PRE-BOUNDARY note' }, { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'project.yaml' } }], usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000, output_tokens: 10 } } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'SECRET-EXCESS-RESULT' }] } },
      { type: 'assistant', message: { id: 'm3', content: [{ type: 'text', text: 'POSTCAP text using SECRET-EXCESS-RESULT' }], usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000, output_tokens: 10 } } },
      { type: 'result', subtype: 'success', is_error: false, result: 'RESEARCH SESSION REPORT', total_cost_usd: 0.2, modelUsage: usage },
    ]);
    setTimeout(() => {}, 1500);
    return;
  }
  const calls = Number(env.MOCK_CALLS ?? 1);
  const events = [init(['Glob', 'Grep', 'Read'])];
  for (let index = 1; index <= calls; index += 1) {
    events.push({ type: 'assistant', message: { id: 'm' + index, content: [{ type: 'tool_use', id: 'c' + index, name: 'Read', input: { file_path: 'CLAUDE.md' } }], usage: { input_tokens: 1, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 5 } } });
    events.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c' + index, content: 'read ' + index }] } });
  }
  events.push({ type: 'result', subtype: 'success', is_error: false, result: 'REPORT ' + (env.MOCK_REPORT ?? 'ok'), total_cost_usd: 0.3, modelUsage: usage });
  out(events);
});
`;

async function loadHarness(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'a7-harness-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mock = path.join(dir, 'mock-claude');
  await writeFile(mock, MOCK);
  await chmod(mock, 0o755);
  process.env.A7_CLAUDE_BIN = mock;
  for (const key of ['MOCK_SCENARIO', 'MOCK_CALLS', 'MOCK_REPORT_TURN', 'MOCK_GRADER', 'MOCK_REPORT']) delete process.env[key];
  const harness = await import(`../../scripts/evaluate-brief-a7.js?mock=${Date.now()}-${Math.random()}`);
  return { harness, dir };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

// --------------------------------------------------------------- R1

test('replicate briefs from different run roots are identical once only location metadata is normalized (review R1)', async (t) => {
  const { harness, dir } = await loadHarness(t);
  const files = [];
  for (const name of ['runs/r002', 'runs/r010']) {
    const root = path.join(dir, name);
    await cp(FIXTURE_ROOT, root, { recursive: true });
    await mkdir(path.join(root, 'sessions', 'active', 'eval'), { recursive: true });
    await writeFile(path.join(root, 'sessions', 'active', 'eval', 'session.yaml'), 'id: eval\nstatus: active\nsession_date: 2026-10-02\nsession_number: 1\nworking_on: "Rewrite the refused refresh message"\nfeature_slugs: []\nrepos: []\nclaimed_paths: []\narchitecture_docs: []\ndecision_domain_files: []\n');
    const child = spawnSync('node', ['src/cli.js', 'brief', '--root', root, '--session', 'eval', '--write'], { cwd: packageDir, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    files.push({ root, text: await readFile(path.join(root, 'sessions', 'active', 'eval', 'brief.md'), 'utf8') });
  }
  assert.notEqual(files[0].text, files[1].text, 'raw files differ by their roots');
  const normalized = files.map((file) => harness.normalizeRunLocation(file.text, file.root));
  assert.equal(normalized[0], normalized[1]);
  assert.notEqual(harness.normalizeRunLocation(files[0].text.replace('Run ledger', 'Run journal'), files[0].root), normalized[1], 'a substantive difference still shows');
});

// --------------------------------------------------------------- R3

test('a stopped run replays only up to the boundary; excess results and later text never reach the report turn (review R3)', async (t) => {
  const { harness, dir } = await loadHarness(t);
  process.env.MOCK_SCENARIO = 'excess';
  const root = path.join(dir, 'runs', 'r001');
  await mkdir(root, { recursive: true });
  await mkdir(path.join(dir, 'transcripts'), { recursive: true });
  await mkdir(path.join(dir, 'prompts'), { recursive: true });
  await writeFile(path.join(dir, 'prompts', 'r001.txt'), 'PROMPT');
  const meta = await harness.runAgent('PROMPT', root, path.join(dir, 'transcripts', 'r001'), 1);
  assert.equal(meta.stopped, true);

  const reportPrompt = await readFile(path.join(dir, 'transcripts', 'r001.report-prompt.txt'), 'utf8');
  assert.match(reportPrompt, /ALLOWED-RESULT/);
  assert.match(reportPrompt, /PRE-BOUNDARY note/, 'text before the excess tool-use block is kept');
  assert.doesNotMatch(reportPrompt, /SECRET-EXCESS-RESULT|POSTCAP/);

  const metrics = await harness.auditRun(dir, { id: 'r001', root }, 1, { claude_version: '2.1.288 (Claude Code)' });
  assert.deepEqual(metrics.violations, []);
  assert.equal(metrics.tool_calls, 1);
  assert.equal(metrics.calls_issued, 2);
  assert.equal(metrics.excess_results_observed, 1);
  assert.equal(metrics.report, 'REPORT from the transcript');

  await writeFile(path.join(dir, 'transcripts', 'r001.report-prompt.txt'), `${reportPrompt}\nSECRET-EXCESS-RESULT`);
  assert.ok((await harness.auditRun(dir, { id: 'r001', root }, 1)).violations.some((entry) => /boundary-truncated replay/.test(entry)));
});

test('the boundary falls inside a message that holds both allowed and excess calls', async (t) => {
  const { harness } = await loadHarness(t);
  const events = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a' }, { type: 'text', text: 'between' }, { type: 'tool_use', id: 'b' }, { type: 'text', text: 'after' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'A-RESULT' }, { type: 'tool_result', tool_use_id: 'b', content: 'B-RESULT' }] } },
  ];
  assert.deepEqual([harness.findBoundary(events, 1).event, harness.findBoundary(events, 1).block], [0, 2]);
  const transcript = harness.renderResearchTranscript(events, 1);
  assert.match(transcript, /A-RESULT/);
  assert.match(transcript, /between/);
  assert.doesNotMatch(transcript, /B-RESULT|after/);
  assert.equal(harness.findBoundary(events, 2), null);
});

// --------------------------------------------------------------- R9

test('every session is checked: a report turn with another model, version, permission mode, or MCP server is a violation (review R9)', async (t) => {
  const { harness, dir } = await loadHarness(t);
  process.env.MOCK_SCENARIO = 'excess';
  process.env.MOCK_REPORT_TURN = 'bad';
  const root = path.join(dir, 'runs', 'r001');
  await mkdir(root, { recursive: true });
  await mkdir(path.join(dir, 'transcripts'), { recursive: true });
  await harness.runAgent('PROMPT', root, path.join(dir, 'transcripts', 'r001'), 1);
  const { violations } = await harness.auditRun(dir, { id: 'r001', root }, 1, { claude_version: '2.1.288 (Claude Code)' });
  for (const expected of [/report turn: model claude-haiku-4-5/, /report turn: Claude Code 0\.0\.0/, /report turn: permission mode default/, /report turn: MCP servers/]) {
    assert.ok(violations.some((entry) => expected.test(entry)), `${expected} in ${violations.join(' | ')}`);
  }
  assert.equal(harness.parseVersion('2.1.288 (Claude Code)'), '2.1.288');
  assert.equal(harness.parseVersion('2.1'), null, 'a version prefix is not a version');
});

// --------------------------------------------------------------- R2

const LABEL = { id: 'F1', clauses: [{ item: 'M1', clause: 'a' }, { item: 'M1', clause: 'b' }, { item: 'M2', clause: '-' }], forbidden: ['X1', 'X2'] };

function reportSide(stated, violated = []) {
  return {
    clauses: ['M1(a)', 'M1(b)', 'M2'].map((key) => ({ key, stated: stated.includes(key), attributed: stated.includes(key), evidence: '' })),
    forbidden: ['X1', 'X2'].map((id) => ({ id, violated: violated.includes(id), evidence: '', reasoning: '' })),
    states_no_governing_memory: false,
    notes: '',
  };
}

test('grades must cover the checklist exactly: missing, duplicate, unexpected, and malformed entries are invalid (review R2)', async (t) => {
  const { harness } = await loadHarness(t);
  const valid = { P: reportSide(['M1(a)']), Q: reportSide([]) };
  assert.deepEqual(harness.validateReportGrade(LABEL, valid), []);
  const missingX = structuredClone(valid);
  missingX.P.forbidden = missingX.P.forbidden.filter((entry) => entry.id !== 'X2');
  assert.ok(harness.validateReportGrade(LABEL, missingX).some((problem) => /P forbidden: missing X2/.test(problem)));
  const duplicate = structuredClone(valid);
  duplicate.Q.clauses.push({ key: 'M2', stated: true, attributed: true, evidence: '' });
  assert.ok(harness.validateReportGrade(LABEL, duplicate).some((problem) => /Q clauses: duplicate M2/.test(problem)));
  const unexpected = structuredClone(valid);
  unexpected.P.clauses[0].key = 'M1';
  assert.ok(harness.validateReportGrade(LABEL, unexpected).some((problem) => /unexpected M1\b/.test(problem)));
  assert.ok(harness.validateReportGrade(LABEL, { P: { clauses: 'x' } }).length > 0);
  assert.ok(harness.validateBriefGrade(LABEL, { forbidden: [{ id: 'X1', violated: false }], presents_governing_memory_for_no_match: false }).some((problem) => /missing X2/.test(problem)));
  assert.throws(() => harness.armVerdicts(LABEL, { task: 'F1', replicate: 1, grader: 'g1', order: { P: 'baseline', Q: 'brief' }, graded: missingX }, 'baseline'), /invalid report grade/);
});

test('a split verdict needs a tie-break, for report clauses and for the brief governing verdict (review R2)', async (t) => {
  const { harness } = await loadHarness(t);
  const grade = (stated, grader) => ({ task: 'F1', replicate: 1, grader, order: { P: 'baseline', Q: 'brief' }, graded: { P: reportSide(stated), Q: reportSide(stated) } });
  const first = harness.armVerdicts(LABEL, grade(['M1(a)'], 'g1'), 'brief');
  const second = harness.armVerdicts(LABEL, grade([], 'g2'), 'brief');
  assert.throws(() => harness.majority([first, second], LABEL), /no tie-break/);
  assert.equal(harness.majority([first, second, harness.armVerdicts(LABEL, grade(['M1(a)'], 'g3'), 'brief')], LABEL).clauses['M1:a'].stated, true);
  const brief = (violated, governing, grader) => ({ task: 'F1', grader, graded: { forbidden: ['X1', 'X2'].map((id) => ({ id, violated: violated.includes(id), evidence: '', reasoning: '' })), presents_governing_memory_for_no_match: governing, closest_call: '', notes: '' } });
  assert.deepEqual(harness.briefDisagreements(LABEL, brief(['X1'], false, 'g1'), brief([], false, 'g2')), ['X1']);
  assert.deepEqual(harness.briefDisagreements(LABEL, brief([], true, 'g1'), brief([], false, 'g2')), ['governing']);
});

// --------------------------------------------------------------- R6

test('the pre-registered screen flags baseline-majority clause drops of two and task drops; confirmation needs six replicates (review R6)', async (t) => {
  const { harness } = await loadHarness(t);
  const row = (clauseCounts, baseline = 0.9, brief = 0.9, n = 3) => ({ id: 'T', positive: true, replicates: n, recall: { baseline: { mean: baseline }, brief: { mean: brief } }, clause_counts: clauseCounts.map(([b, r], index) => ({ clause: `M${index + 1}`, n, baseline: b, brief: r })) });
  assert.equal(harness.screenRows([row([[2, 0]])]).flagged.length, 1, '2/3 → 0/3 is flagged');
  assert.equal(harness.screenRows([row([[3, 1]])]).flagged.length, 1);
  assert.equal(harness.screenRows([row([[3, 2]])]).flagged.length, 0, 'a one-replicate drop is reported as weakened, not flagged');
  assert.equal(harness.screenRows([row([[1, 0]])]).flagged.length, 0);
  assert.equal(harness.screenRows([row([], 0.933, 0.8)]).flagged.length, 0);
  assert.equal(harness.screenRows([row([], 0.95, 0.75)]).flagged.length, 1);
  assert.equal(harness.screenRows(Array.from({ length: 6 }, () => row([[3, 0]]))).systematic, true);
  assert.deepEqual(harness.confirmedLoss(row([[5, 2]], 0.9, 0.85, 6)), []);
  assert.equal(harness.confirmedLoss(row([[5, 1]], 0.9, 0.85, 6)).length, 1);
  assert.equal(harness.confirmedLoss(row([], 0.95, 0.75, 6)).length, 1);
});

// ------------------------------------------------- end-to-end pipeline

const TUNING_LABELS = `### Tuning tasks

#### F1 — file-scoped · tuning
- **Task:** Rewrite the message a user sees when a hosted refresh run is refused.
- **Files:** \`app:src/lib/entitlements.ts\`
- **Must-have facts:**
  - M1 (a) One; (b) two.
  - M2 Single.
- **Forbidden authority claims:**
  - X1 Bad.
  - X2 Worse.
- **Tags:** —

#### N1 — no-match · tuning
- **Task:** Add Klingon subtitles and a karaoke kiosk mode.
- **Forbidden authority claims:**
  - X1 Bad.
- **Tags:** no-match

### Corpus v2 tuning-label re-verification (A7)
Synthetic.

#### Merged v2 tuning labels (mechanical consolidation; the harness grades these)
None.

## Results
`;
const HELDOUT_LABELS = `#### F5 — task-only · held-out
- **Task:** Change the Free plan credit balance and the Solo plan price.
- **Must-have facts:**
  - M1 Single.
- **Forbidden authority claims:**
  - X1 Bad.
- **Tags:** —
`;

/** A tagged docs repo, its corpus export, label copies, and a prepared evaluation directory. */
async function prepared(harness, dir) {
  const repo = path.join(dir, 'docs');
  await cp(FIXTURE_ROOT, repo, { recursive: true });
  await writeFile(path.join(repo, 'CLAUDE.md'), '# Acme Widgets\n');
  await mkdir(path.join(repo, 'architecture', 'platform', 'project-memory'), { recursive: true });
  await writeFile(path.join(repo, 'architecture', 'platform', 'project-memory', 'recall-evaluation.md'), TUNING_LABELS);
  const git = (...args) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-q', '-m', 'corpus'], ['tag', 'recall-eval-corpus-v2']]) assert.equal(git(...args).status, 0);
  const corpus = path.join(dir, 'corpus');
  await cp(FIXTURE_ROOT, corpus, { recursive: true });
  await writeFile(path.join(corpus, 'CLAUDE.md'), '# Acme Widgets\n');
  const labelsDir = path.join(dir, 'labels-in');
  await mkdir(labelsDir, { recursive: true });
  await writeFile(path.join(labelsDir, 'recall-evaluation.md'), TUNING_LABELS);
  await writeFile(path.join(labelsDir, 'recall-evaluation-heldout-v2.md'), HELDOUT_LABELS);
  const ctx = { dir: path.join(dir, 'eval'), cap: 100, concurrency: 4, quiet: true, identity: () => ({ package_commit: 'test', package_dirty: '', package_src_tree: 'test' }) };
  const opts = { corpus, docsRepo: repo, labelsDir, heldoutSha: sha256(HELDOUT_LABELS), warmRuns: 1, expectTasks: 3 };
  await harness.prepare(ctx, opts);
  return { ctx, opts };
}

test('the pipeline scores complete, verified evidence; changed inputs, stale grades, and reused directories stop it (review R8)', async (t) => {
  const { harness, dir } = await loadHarness(t);
  const { ctx, opts } = await prepared(harness, dir);
  await harness.run(ctx);
  await harness.grade(ctx);
  await harness.screen(ctx);
  const summary = await harness.score(ctx);
  assert.equal(summary.go, true, JSON.stringify(summary.gates));
  // 18 runs at $0.30 and 24 grader calls at $0.10, all from the ledger.
  assert.equal(Math.round(summary.cost_usd.total * 100) / 100, 7.8);
  assert.equal(summary.cost_usd.attempts, 42);

  await assert.rejects(() => harness.prepare(ctx, opts), /Refusing to prepare/);

  // A report changed after grading: its grades no longer match their inputs.
  const transcript = path.join(ctx.dir, 'transcripts', 'r001.jsonl');
  const original = await readFile(transcript, 'utf8');
  await writeFile(transcript, original.replace('REPORT ok', 'I have no relevant facts to report.'));
  await assert.rejects(() => harness.score(ctx), /graded a different input|transcript changed/);
  await writeFile(transcript, original);

  // A prepared memory file changed in a run copy.
  const manifest = JSON.parse(await readFile(path.join(ctx.dir, 'manifest.json'), 'utf8'));
  const ledgerDoc = path.join(manifest.runs[0].root, 'architecture', 'billing', 'ledger.md');
  const doc = await readFile(ledgerDoc, 'utf8');
  await writeFile(ledgerDoc, `${doc}\nTampered.\n`);
  await assert.rejects(() => harness.score(ctx), /Run copies changed since prepare/);
  await writeFile(ledgerDoc, doc);

  // A cached grade whose verdicts were edited.
  const gradeFile = path.join(ctx.dir, 'grading', 'F1-r1-reports-g1.json');
  const gradeText = await readFile(gradeFile, 'utf8');
  const edited = JSON.parse(gradeText);
  edited.graded.Q.clauses[0].stated = false;
  await writeFile(gradeFile, JSON.stringify(edited));
  await assert.rejects(() => harness.score(ctx), /recorded verdicts differ from the session output/);
  await writeFile(gradeFile, gradeText);

  // The graded brief file, and the manifest itself.
  const briefFile = path.join(ctx.dir, 'briefs', 'F1.md');
  const briefText = await readFile(briefFile, 'utf8');
  await writeFile(briefFile, `${briefText}\n`);
  await assert.rejects(() => harness.score(ctx), /briefs\/F1\.md changed since prepare/);
  await writeFile(briefFile, briefText);
  const manifestText = await readFile(path.join(ctx.dir, 'manifest.json'), 'utf8');
  await writeFile(path.join(ctx.dir, 'manifest.json'), manifestText.replace('"package_dirty": false', '"package_dirty": false '));
  await assert.rejects(() => harness.score(ctx), /manifest\.json differs/);
  await writeFile(path.join(ctx.dir, 'manifest.json'), manifestText);

  assert.equal((await harness.score(ctx)).go, true, 'restored evidence scores again');
});

test('every paid attempt stays in the ledger across resumes; the attempt limit and the spend never reset (review R7)', async (t) => {
  const { harness, dir } = await loadHarness(t);
  const { ctx } = await prepared(harness, dir);
  await harness.run({ ...ctx, only: new Set(['r013', 'r014', 'r015', 'r016', 'r017', 'r018']) });
  const ranOnce = await harness.ledgerSpend(ctx.dir);
  assert.equal(Math.round(ranOnce.total * 100) / 100, 1.8);

  // Invalid grades: each job tries three times, then stops; a resume makes no new call.
  process.env.MOCK_GRADER = 'invalid';
  const gradeF5 = { ...ctx, only: new Set(['F5']) };
  await assert.rejects(() => harness.grade(gradeF5), /no valid grade after 3 attempts/);
  const afterFirst = await harness.readLedger(ctx.dir);
  await assert.rejects(() => harness.grade(gradeF5), /no valid grade after 3 attempts/);
  assert.equal((await harness.readLedger(ctx.dir)).length, afterFirst.length, 'a resume starts no new attempt');
  assert.equal(await harness.attemptsOf(ctx.dir, 'grade:F5-brief-g1'), 3);
  const files = await readdir(path.join(ctx.dir, 'grading'));
  for (const attempt of [1, 2, 3]) {
    assert.ok(files.includes(`F5-brief-g1.attempt-${attempt}.stdout.jsonl`), `attempt ${attempt} stream kept`);
    assert.ok(files.includes(`F5-brief-g1.attempt-${attempt}.invalid.json`), `attempt ${attempt} kept as invalid`);
  }
  assert.ok(!files.includes('F5-brief-g1.json'), 'no invalid grade is ever saved as the grade');
  // 8 F5 grading jobs × 3 attempts at $0.10, plus the six runs.
  const spend = await harness.ledgerSpend(ctx.dir);
  assert.equal(Math.round(spend.by_kind.grader * 100) / 100, 2.4);
  assert.equal(Math.round(spend.total * 100) / 100, 4.2);

  // An attempt interrupted before it recorded anything holds its reserve.
  await appendFile(path.join(ctx.dir, 'ledger.jsonl'), `${JSON.stringify({ event: 'start', call: 'run:r001#1', kind: 'research', job: 'run:r001', attempt: 1, reserve_usd: 1.5, file: path.join(ctx.dir, 'transcripts', 'missing.jsonl') })}\n`);
  const interrupted = await harness.ledgerSpend(ctx.dir);
  assert.deepEqual(interrupted.unresolved, ['run:r001#1']);
  assert.equal(Math.round(interrupted.total * 100) / 100, 5.7);

  // The cap counts it: with $6 approved, no further run starts.
  delete process.env.MOCK_GRADER;
  const capped = await harness.run({ ...ctx, cap: 6, only: new Set(['r001', 'r002']) });
  assert.deepEqual(capped.skipped.sort(), ['r001', 'r002']);
  process.exitCode = 0;
});

test('a grader session that errors or used another model never yields a grade (review R9)', async (t) => {
  const { harness, dir } = await loadHarness(t);
  const { ctx } = await prepared(harness, dir);
  await harness.run(ctx);
  for (const mode of ['error', 'wrongmodel']) {
    process.env.MOCK_GRADER = mode;
    const only = { ...ctx, only: new Set([mode === 'error' ? 'F5' : 'N1']) };
    await assert.rejects(() => harness.grade(only), /no valid grade after 3 attempts/);
    const invalid = JSON.parse(await readFile(path.join(ctx.dir, 'grading', `${mode === 'error' ? 'F5' : 'N1'}-brief-g1.attempt-1.invalid.json`), 'utf8'));
    assert.ok(invalid.problems.some((problem) => (mode === 'error' ? /did not complete \(error_max_turns, is_error\)/ : /model usage \["claude-haiku-4-5"\]/).test(problem)), invalid.problems.join(' | '));
  }
});

// --------------------------------------------------------- pass 4

test('missing, empty, or partial run metadata never disables transcript verification; recovery rebuilds it from the ledger (review pass 4, R8)', async (t) => {
  const { harness, dir } = await loadHarness(t);
  const { ctx } = await prepared(harness, dir);
  await harness.run(ctx);
  await harness.grade(ctx);
  await harness.screen(ctx);
  assert.equal((await harness.score(ctx)).go, true);

  const metaFile = path.join(ctx.dir, 'transcripts', 'r001.meta.json');
  const transcript = path.join(ctx.dir, 'transcripts', 'r001.jsonl');
  const metaText = await readFile(metaFile, 'utf8');
  const transcriptText = await readFile(transcript, 'utf8');
  const findings = async () => (await harness.score(ctx)).gates.conformance.findings.join(' | ');

  await rm(metaFile);
  assert.match(await findings(), /run metadata is missing or does not match the ledger for the research session/);
  // Changed research evidence (a tool result) with the metadata gone: the ledger still catches it.
  await writeFile(transcript, transcriptText.replace('read 1', 'read nothing useful'));
  assert.match(await findings(), /research transcript differs from the ledger record/);
  await writeFile(transcript, transcriptText);

  await writeFile(metaFile, '{}');
  assert.match(await findings(), /run metadata is missing or does not match the ledger/);
  const partial = JSON.parse(metaText);
  delete partial.research_sha256;
  await writeFile(metaFile, JSON.stringify(partial));
  assert.match(await findings(), /run metadata is missing or does not match the ledger/);

  // `run` rebuilds missing metadata from the ledger and the attempt stream, without a new paid attempt.
  await rm(metaFile);
  const attemptsBefore = await harness.attemptsOf(ctx.dir, 'run:r001');
  await harness.run(ctx);
  assert.equal(await harness.attemptsOf(ctx.dir, 'run:r001'), attemptsBefore, 'nothing is re-run');
  assert.equal(JSON.parse(await readFile(metaFile, 'utf8')).recovered, true);
  assert.equal((await harness.score(ctx)).go, true);
});

test('a stopped run whose report turn the cap cannot fund stays pending, then resumes without repeating research (review pass 4, R10)', async (t) => {
  const { harness, dir } = await loadHarness(t);
  const { ctx } = await prepared(harness, dir);
  process.env.MOCK_CALLS = '25';
  const tight = await harness.run({ ...ctx, cap: 1.51, concurrency: 1, only: new Set(['r001']) });
  assert.deepEqual(tight.skipped, ['r001 (report turn pending)']);
  process.exitCode = 0;
  const metaFile = path.join(ctx.dir, 'transcripts', 'r001.meta.json');
  assert.equal(JSON.parse(await readFile(metaFile, 'utf8')).state, 'report-pending');
  assert.equal(await harness.attemptsOf(ctx.dir, 'run:r001'), 1);
  assert.equal(await harness.attemptsOf(ctx.dir, 'report:r001'), 0, 'no report session started past the cap');

  await harness.run({ ...ctx, cap: 10, concurrency: 1, only: new Set(['r001']) });
  assert.equal(await harness.attemptsOf(ctx.dir, 'run:r001'), 1, 'research is not repeated');
  assert.equal(await harness.attemptsOf(ctx.dir, 'report:r001'), 1);
  const meta = JSON.parse(await readFile(metaFile, 'utf8'));
  assert.equal(meta.state, 'complete');
  const manifest = JSON.parse(await readFile(path.join(ctx.dir, 'manifest.json'), 'utf8'));
  const audit = await harness.auditRun(ctx.dir, manifest.runs[0], manifest.tool_call_cap, manifest);
  assert.deepEqual(audit.violations, []);
  assert.equal(audit.stopped_at_cap, true);
  assert.equal(audit.tool_calls, 24);
});

test('the split guard uses final task means: a stage-1 dip that confirmation runs recover passes (review pass 4, R11 parity control)', async (t) => {
  const { harness } = await loadHarness(t);
  // 15 two-item positive tasks (9 tuning, 6 held-out). Three tuning tasks have
  // baseline [1, 1, 1] and brief [1, 1, 0.5] in stage 1, and perfect
  // confirmation runs; everything else is perfect. Same case as the
  // simulation's --self-test.
  const run = (items) => ({ items, recall: items.filter(Boolean).length === items.length ? 1 : 0.5 });
  const full = run([true, true]);
  const half = run([true, false]);
  const row = (id, split, base, brief) => ({
    id,
    split,
    positive: true,
    replicates: base.length,
    recall: Object.fromEntries([['baseline', base], ['brief', brief]].map(([arm, runs]) => [arm, { mean: runs.reduce((sum, entry) => sum + entry.recall, 0) / runs.length, min: Math.min(...runs.map((entry) => entry.recall)), max: Math.max(...runs.map((entry) => entry.recall)), per_run: runs.map((entry) => entry.recall) }])),
    clause_counts: [0, 1].map((index) => ({ clause: `M${index + 1}`, n: base.length, baseline: base.filter((entry) => entry.items[index]).length, brief: brief.filter((entry) => entry.items[index]).length })),
    runs: { baseline: base.map(() => ({ metrics: { violations: [], stopped_at_cap: false }, forbidden: [] })), brief: brief.map(() => ({ metrics: { violations: [], stopped_at_cap: false }, forbidden: [] })) },
    weakened: [],
    gained: [],
    baseline_unstable: [],
    brief_violations: [],
    brief_presents_governing: false,
  });
  const ids = [...Array.from({ length: 9 }, (_, index) => [`T${index}`, 'tuning']), ...Array.from({ length: 6 }, (_, index) => [`H${index}`, 'held-out'])];
  const stage1Rows = ids.map(([id, split], index) => row(id, split, [full, full, full], index < 3 ? [full, full, half] : [full, full, full]));
  const finalRows = ids.map(([id, split], index) => (index < 3 ? row(id, split, [full, full, full, full, full, full], [full, full, half, full, full, full]) : stage1Rows[index]));
  const stage1 = harness.screenRows(stage1Rows);
  assert.deepEqual(stage1.flagged.map((entry) => entry.id), ['T0', 'T1', 'T2']);
  const manifest = {
    stage1_replicates: 3,
    briefs: Object.fromEntries(ids.map(([id]) => [id, { status: 'complete', safe_overflow: [], body_matches_json: true, replicates: [{ normalized_sha256: 'x' }] }])),
    latency: { warm_p50_max_ms: 200, cold_max_ms: 400 },
    preflight: { pass: true },
    pre_run_gates: { pass: true, failures: [] },
    package_dirty: false,
  };
  const spend = { total: 0, by_kind: {}, attempts: 0, estimated: [], unresolved: [], reserved_unresolved: 0 };
  const summary = harness.summarize(finalRows, manifest, {}, spend, stage1);
  assert.equal(Math.round(summary.gates.no_regression.split_drops.tuning * 1e6) / 1e6, 0.027778, 'final tuning drop');
  assert.deepEqual(summary.gates.no_regression.confirmed_losses, []);
  assert.equal(summary.gates.no_regression.pass, true);
  assert.equal(summary.go, true);
  // The stage-1 means alone would have breached the guard.
  const stage1Drop = stage1Rows.slice(0, 9).reduce((sum, entry) => sum + entry.recall.baseline.mean - entry.recall.brief.mean, 0) / 9;
  assert.ok(stage1Drop > 0.05);
});
