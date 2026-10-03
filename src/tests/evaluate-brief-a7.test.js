// Offline checks for the A7 evaluation harness (scripts/evaluate-brief-a7.js):
// no model calls. A mock `claude` child stands in for the CLI, and grading
// artifacts are synthetic.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, '..', '..');
const FIXTURE_ROOT = path.join(here, 'fixtures', 'brief', 'root');

// The mock child: research sessions emit a coalesced stream with an allowed
// call, an excess call with its result, and later text; a no-tools report
// turn emits a report. It waits on stdin so the harness's kill can land.
const MOCK = `#!/usr/bin/env node
const args = process.argv.slice(2);
const toolsIndex = args.indexOf('--tools');
const reportTurn = toolsIndex !== -1 && args[toolsIndex + 1] === '';
const init = (tools) => ({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', tools, permissionMode: 'dontAsk', mcp_servers: [], claude_code_version: '2.1.288' });
const out = (events) => process.stdout.write(events.map((event) => JSON.stringify(event)).join('\\n') + '\\n');
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  if (reportTurn) {
    out([init([]), { type: 'result', subtype: 'success', is_error: false, result: 'REPORT from the transcript', total_cost_usd: 0.1, duration_ms: 5 }]);
    return;
  }
  out([
    init(['Glob', 'Grep', 'Read']),
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'CLAUDE.md' } }], usage: { input_tokens: 1, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 10 } } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ALLOWED-RESULT' }] } },
    { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'PRE-BOUNDARY note' }, { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'project.yaml' } }], usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000, output_tokens: 10 } } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'SECRET-EXCESS-RESULT' }] } },
    { type: 'assistant', message: { id: 'm3', content: [{ type: 'text', text: 'POSTCAP text using SECRET-EXCESS-RESULT' }], usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000, output_tokens: 10 } } },
    { type: 'result', subtype: 'success', is_error: false, result: 'RESEARCH SESSION REPORT', total_cost_usd: 0.2, duration_ms: 5 },
  ]);
  setTimeout(() => {}, 2000);
});
`;

async function loadHarness(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'a7-harness-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mock = path.join(dir, 'mock-claude');
  await writeFile(mock, MOCK);
  await chmod(mock, 0o755);
  process.env.A7_CLAUDE_BIN = mock;
  const harness = await import(`../../scripts/evaluate-brief-a7.js?mock=${Date.now()}`);
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
  // A substantive difference still shows.
  assert.notEqual(harness.normalizeRunLocation(files[0].text.replace('Run ledger', 'Run journal'), files[0].root), normalized[1]);
});

// --------------------------------------------------------------- R3

test('a stopped run replays only up to the boundary; excess results and later text never reach the report turn (review R3)', async (t) => {
  const { harness, dir } = await loadHarness(t);
  const root = path.join(dir, 'runs', 'r001');
  await mkdir(root, { recursive: true });
  await mkdir(path.join(dir, 'transcripts'), { recursive: true });
  await mkdir(path.join(dir, 'prompts'), { recursive: true });
  const prompt = 'PROMPT';
  await writeFile(path.join(dir, 'prompts', 'r001.txt'), prompt);
  const meta = await harness.runAgent(prompt, root, path.join(dir, 'transcripts', 'r001'), 1);
  assert.equal(meta.stopped, true);

  const reportPrompt = await readFile(path.join(dir, 'transcripts', 'r001.report-prompt.txt'), 'utf8');
  assert.match(reportPrompt, /ALLOWED-RESULT/);
  assert.match(reportPrompt, /PRE-BOUNDARY note/, 'text before the excess call in the same message is kept');
  assert.doesNotMatch(reportPrompt, /SECRET-EXCESS-RESULT/);
  assert.doesNotMatch(reportPrompt, /POSTCAP/);

  const metrics = await harness.auditRun(dir, { id: 'r001', root }, 1, '2.1.288 (Claude Code)');
  assert.deepEqual(metrics.violations, []);
  assert.equal(metrics.stopped_at_cap, true);
  assert.equal(metrics.tool_calls, 1);
  assert.equal(metrics.calls_issued, 2);
  assert.equal(metrics.excess_results_observed, 1, 'the excess result is recorded as observed in the discarded stream');
  assert.equal(metrics.report, 'REPORT from the transcript', 'the report is the report turn, never the research session');

  // A report prompt that is not the boundary-truncated replay is a violation.
  await writeFile(path.join(dir, 'transcripts', 'r001.report-prompt.txt'), `${reportPrompt}\nSECRET-EXCESS-RESULT`);
  assert.ok((await harness.auditRun(dir, { id: 'r001', root }, 1)).violations.some((entry) => /boundary-truncated replay/.test(entry)));
});

test('the boundary falls inside a message that holds both allowed and excess calls', async (t) => {
  const { harness } = await loadHarness(t);
  const events = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a' }, { type: 'text', text: 'between' }, { type: 'tool_use', id: 'b' }, { type: 'text', text: 'after' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'A-RESULT' }, { type: 'tool_result', tool_use_id: 'b', content: 'B-RESULT' }] } },
  ];
  const boundary = harness.findBoundary(events, 1);
  assert.equal(boundary.event, 0);
  assert.equal(boundary.block, 2);
  const transcript = harness.renderResearchTranscript(events, 1);
  assert.match(transcript, /A-RESULT/);
  assert.match(transcript, /between/);
  assert.doesNotMatch(transcript, /B-RESULT|after/);
  assert.equal(harness.findBoundary(events, 2), null);
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

test('a split verdict without a tie-break refuses to score, for reports and briefs alike (review R2)', async (t) => {
  const { harness } = await loadHarness(t);
  const grade = (stated, grader) => ({ task: 'F1', replicate: 1, grader, order: { P: 'baseline', Q: 'brief' }, graded: { P: reportSide(stated), Q: reportSide(stated) } });
  const first = harness.armVerdicts(LABEL, grade(['M1(a)'], 'g1'), 'brief');
  const second = harness.armVerdicts(LABEL, grade([], 'g2'), 'brief');
  assert.throws(() => harness.majority([first, second], LABEL), /no tie-break/);
  const third = harness.armVerdicts(LABEL, grade(['M1(a)'], 'g3'), 'brief');
  assert.equal(harness.majority([first, second, third], LABEL).clauses['M1:a'].stated, true);

  const brief = (violated, governing, grader) => ({ task: 'F1', grader, graded: { forbidden: ['X1', 'X2'].map((id) => ({ id, violated: violated.includes(id), evidence: '', reasoning: '' })), presents_governing_memory_for_no_match: governing, closest_call: '', notes: '' } });
  assert.deepEqual(harness.briefDisagreements(LABEL, brief(['X1'], false, 'g1'), brief([], false, 'g2')), ['X1']);
  assert.deepEqual(harness.briefDisagreements(LABEL, brief([], true, 'g1'), brief([], false, 'g2')), ['governing'], 'the governing-memory verdict needs a tie-break too');
});

// ------------------------------------------------- synthetic evaluation

const TUNING_LABELS = `### Tuning tasks

#### F1 — file-scoped · tuning
- **Task:** Do F1.
- **Must-have facts:**
  - M1 (a) One; (b) two.
  - M2 Single.
- **Forbidden authority claims:**
  - X1 Bad.
  - X2 Worse.
- **Tags:** —

#### N1 — no-match · tuning
- **Task:** Do N1.
- **Forbidden authority claims:**
  - X1 Bad.
- **Tags:** no-match

### Corpus v2 tuning-label re-verification (A7)
Synthetic.

#### Merged v2 tuning labels (mechanical consolidation; the harness grades these)
None.

## Results
`;
const HELDOUT_LABELS = `#### F5 — file-scoped · held-out
- **Task:** Do F5.
- **Must-have facts:**
  - M1 Single.
- **Forbidden authority claims:**
  - X1 Bad.
- **Tags:** —
`;

/** A complete synthetic evaluation directory: labels, manifest, transcripts, and agreeing grades. */
async function syntheticEval(dir, { statedBy = () => true, replicates = 3 } = {}) {
  await mkdir(path.join(dir, 'labels'), { recursive: true });
  await mkdir(path.join(dir, 'transcripts'), { recursive: true });
  await mkdir(path.join(dir, 'grading'), { recursive: true });
  await writeFile(path.join(dir, 'labels', 'recall-evaluation.md'), TUNING_LABELS);
  await writeFile(path.join(dir, 'labels', 'recall-evaluation-heldout-v2.md'), HELDOUT_LABELS);
  const root = path.join(dir, 'root');
  await mkdir(root, { recursive: true });
  const tasks = [
    { id: 'F1', split: 'tuning', keys: ['M1(a)', 'M1(b)', 'M2'], forbidden: ['X1', 'X2'] },
    { id: 'N1', split: 'tuning', keys: [], forbidden: ['X1'] },
    { id: 'F5', split: 'held-out', keys: ['M1'], forbidden: ['X1'] },
  ];
  const runs = [];
  for (const task of tasks) {
    for (let replicate = 1; replicate <= replicates; replicate += 1) {
      for (const arm of ['baseline', 'brief']) {
        const id = `r${String(runs.length + 1).padStart(3, '0')}`;
        runs.push({ id, task: task.id, arm, replicate, stage: replicate > 3 ? 2 : 1, root });
        const events = [
          { type: 'system', subtype: 'init', model: 'claude-opus-5-5', tools: ['Glob', 'Grep', 'Read'], permissionMode: 'dontAsk', mcp_servers: [], claude_code_version: '2.1.288' },
          { type: 'result', subtype: 'success', is_error: false, result: `report ${id}`, total_cost_usd: 0.5, duration_ms: 1000 },
        ];
        await writeFile(path.join(dir, 'transcripts', `${id}.jsonl`), events.map((event) => JSON.stringify(event)).join('\n'));
        await writeFile(path.join(dir, 'transcripts', `${id}.meta.json`), '{"stopped": false}');
      }
      for (const grader of ['g1', 'g2']) {
        const side = (arm) => ({
          clauses: task.keys.map((key) => ({ key, stated: statedBy(task.id, arm, replicate, key), attributed: true, evidence: '' })),
          forbidden: task.forbidden.map((id) => ({ id, violated: false, evidence: '', reasoning: '' })),
          states_no_governing_memory: task.keys.length === 0,
          notes: '',
        });
        await writeFile(path.join(dir, 'grading', `${task.id}-r${replicate}-reports-${grader}.json`), JSON.stringify({ task: task.id, replicate, grader, order: { P: 'baseline', Q: 'brief' }, cost_usd: 0.2, graded: { P: side('baseline'), Q: side('brief') } }));
      }
    }
    for (const grader of ['g1', 'g2']) {
      await writeFile(path.join(dir, 'grading', `${task.id}-brief-${grader}.json`), JSON.stringify({ task: task.id, grader, cost_usd: 0.1, graded: { forbidden: task.forbidden.map((id) => ({ id, violated: false, evidence: '', reasoning: '' })), presents_governing_memory_for_no_match: false, closest_call: '', notes: '' } }));
    }
  }
  const brief = (status) => ({ status, topic_absent: false, safe_overflow: [], body_matches_json: true, body_tokens: 100, whole_file_tokens: 150, replicates: [{ run: 'r002', normalized_sha256: 'same' }, { run: 'r004', normalized_sha256: 'same' }] });
  return {
    tasks: tasks.map(({ id, split }) => ({ id, split, task: `Do ${id}.`, files: [] })),
    runs,
    briefs: { F1: brief('partial'), N1: brief('no-match'), F5: brief('complete') },
    tool_call_cap: 24,
    claude_version: '2.1.288 (Claude Code)',
    heldout_sha256: sha256(HELDOUT_LABELS),
    stage1_replicates: 3,
    latency: { warm_p50_max_ms: 200, cold_max_ms: 400 },
    preflight: { pass: true },
    pre_run_gates: { pass: true, failures: [] },
    package_dirty: false,
  };
}

async function scoreSynthetic(harness, dir, manifest) {
  const all = await harness.collectRows(manifest, { stage: null, dir });
  const stage1 = harness.screenRows((await harness.collectRows(manifest, { stage: 1, dir })).rows);
  return harness.summarize(all.rows, manifest, all.agreement, all.costs, stage1);
}

test('scoring refuses incomplete grading: a missing tie-break or a missing grade is never a negative verdict (review R2)', async (t) => {
  const { harness, dir } = await loadHarness(t);
  const manifest = await syntheticEval(dir);
  assert.equal((await scoreSynthetic(harness, dir, manifest)).go, true, 'complete, agreeing grades score');

  // A split brief verdict with no g3 stops scoring instead of reading as "no violation".
  const g2 = path.join(dir, 'grading', 'F1-brief-g2.json');
  const record = JSON.parse(await readFile(g2, 'utf8'));
  record.graded.forbidden[0].violated = true;
  await writeFile(g2, JSON.stringify(record));
  await assert.rejects(() => harness.collectRows(manifest, { stage: null, dir }), /grading is incomplete: F1-brief-g3 is missing/);

  // With the tie-break, the majority decides.
  await writeFile(path.join(dir, 'grading', 'F1-brief-g3.json'), JSON.stringify({ ...record, grader: 'g3' }));
  const summary = await scoreSynthetic(harness, dir, manifest);
  assert.equal(summary.gates.brief_forbidden_claims.pass, false);
  assert.equal(summary.go, false);

  await rm(path.join(dir, 'grading', 'F5-r2-reports-g1.json'));
  await assert.rejects(() => harness.collectRows(manifest, { stage: null, dir }), /F5-r2-reports-g1 is missing/);
});

test('recorded preflight failures gate go: dirty source, a body that differs from --json, or replicate briefs that differ (review R4)', async (t) => {
  const { harness, dir } = await loadHarness(t);
  const manifest = await syntheticEval(dir);
  assert.equal((await scoreSynthetic(harness, dir, manifest)).go, true);
  for (const [name, mutate] of [
    ['dirty', (copy) => { copy.package_dirty = true; }],
    ['body', (copy) => { copy.briefs.F1.body_matches_json = false; }],
    ['replicates', (copy) => { copy.briefs.F5.replicates[1].normalized_sha256 = 'other'; }],
    ['pre-run', (copy) => { copy.pre_run_gates = { pass: false, failures: ['latency'] }; }],
  ]) {
    const copy = structuredClone(manifest);
    mutate(copy);
    assert.equal((await scoreSynthetic(harness, dir, copy)).go, false, `${name} must block go`);
  }
});

// --------------------------------------------------------------- R6

test('the pre-registered screen flags baseline-majority clause drops of two and task drops; confirmation needs six replicates (review R6)', async (t) => {
  const { harness } = await loadHarness(t);
  const row = (clauseCounts, baseline = 0.9, brief = 0.9, n = 3) => ({ id: 'T', positive: true, replicates: n, recall: { baseline: { mean: baseline }, brief: { mean: brief } }, clause_counts: clauseCounts.map(([b, r], index) => ({ clause: `M${index + 1}`, n, baseline: b, brief: r })) });
  assert.equal(harness.screenRows([row([[2, 0]])]).flagged.length, 1, '2/3 → 0/3 is flagged (the reviewer\'s case)');
  assert.equal(harness.screenRows([row([[3, 1]])]).flagged.length, 1);
  assert.equal(harness.screenRows([row([[3, 2]])]).flagged.length, 0, 'a one-replicate drop is reported as weakened, not flagged');
  assert.equal(harness.screenRows([row([[1, 0]])]).flagged.length, 0);
  assert.equal(harness.screenRows([row([], 0.933, 0.8)]).flagged.length, 0, 'a 0.133 task drop alone stays under the 0.15 screen');
  assert.equal(harness.screenRows([row([], 0.95, 0.75)]).flagged.length, 1);
  assert.equal(harness.screenRows(Array.from({ length: 6 }, () => row([[3, 0]]))).systematic, true, 'more than five flagged tasks is systematic');

  assert.deepEqual(harness.confirmedLoss(row([[5, 2]], 0.9, 0.85, 6)), []);
  assert.equal(harness.confirmedLoss(row([[5, 1]], 0.9, 0.85, 6)).length, 1);
  assert.equal(harness.confirmedLoss(row([], 0.95, 0.75, 6)).length, 1);
});

test('confirmed losses and split drops fail no-regression in the summary', async (t) => {
  const { harness, dir } = await loadHarness(t);
  // F1 M2: baseline states it in all six replicates, the brief arm never.
  const statedBy = (taskId, arm, replicate, key) => !(taskId === 'F1' && key === 'M2' && arm === 'brief');
  const manifest = await syntheticEval(dir, { statedBy, replicates: 6 });
  const all = await harness.collectRows(manifest, { stage: null, dir });
  const stage1 = harness.screenRows((await harness.collectRows(manifest, { stage: 1, dir })).rows);
  assert.deepEqual(stage1.flagged.map((entry) => entry.id), ['F1']);
  const summary = harness.summarize(all.rows, manifest, all.agreement, all.costs, stage1);
  assert.equal(summary.gates.no_regression.pass, false);
  assert.equal(summary.gates.no_regression.confirmed_losses[0].id, 'F1');
});
