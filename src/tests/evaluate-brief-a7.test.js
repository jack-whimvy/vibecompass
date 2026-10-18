// Offline checks for the A7 evaluation harness (scripts/evaluate-brief-a7.js):
// no model calls. A mock `claude` child stands in for the CLI — research
// sessions, report turns, and graders — and the whole pipeline runs against a
// tiny tagged corpus. The later attempt adds the isolation fixtures (leaked
// content without markers, harmless marker-like corpus text) and the
// interruption tests, which signal a real harness process with live mock
// children.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { appendFile, chmod, cp, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, '..', '..');
const FIXTURE_ROOT = path.join(here, 'fixtures', 'brief', 'root');

// The mock CLI. Modes come from its arguments; failure switches from env:
// MOCK_SCENARIO=excess (research stream with an excess call), MOCK_CALLS=N,
// MOCK_TOOL_INPUTS / MOCK_TOOL_RESULTS / MOCK_TOOL_ERRORS (JSON, per call),
// MOCK_REPORT_TURN=bad, MOCK_GRADER=invalid|error|wrongmodel.
// MOCK_SCENARIO=slow: a research session that streams its first message and
// then waits, with a grandchild process in its group, recording both pids in
// MOCK_PID_DIR; MOCK_IGNORE_TERM=1 ignores SIGTERM; MOCK_NO_USAGE=1 streams no
// usage. MOCK_DELAY_MS delays a normal session's output.
const MOCK = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (process.env.MOCK_IGNORE_TERM === '1') process.on('SIGTERM', () => {});
// The version is read once, at start, as a real binary has one version for its whole life.
const VERSION = (() => { try { return require('node:fs').readFileSync(process.env.MOCK_VERSION_FILE, 'utf8').trim(); } catch { return '2.1.288'; } })();
if (process.env.MOCK_STARTED_DIR && args[0] !== '--version') require('node:fs').writeFileSync(require('node:path').join(process.env.MOCK_STARTED_DIR, process.pid + '.started'), VERSION);
if (process.env.MOCK_ENV_DUMP_DIR) require('node:fs').writeFileSync(require('node:path').join(process.env.MOCK_ENV_DUMP_DIR, process.pid + '.json'), JSON.stringify(Object.keys(process.env)));
if (args[0] === '--version') { console.log(VERSION + ' (Claude Code)'); process.exit(0); }
const toolsIndex = args.indexOf('--tools');
const noTools = toolsIndex !== -1 && args[toolsIndex + 1] === '';
const grader = args.includes('--json-schema');
const env = process.env;
const init = (tools, overrides = {}) => ({ type: 'system', subtype: 'init', session_id: 's-' + Math.random().toString(16).slice(2), model: 'claude-opus-5-5', tools, permissionMode: 'dontAsk', mcp_servers: [], claude_code_version: VERSION, ...overrides });
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
    const graded = [init(['StructuredOutput']), { type: 'result', subtype: error ? 'error_max_turns' : 'success', is_error: error, structured_output: structured, total_cost_usd: 0.1, modelUsage: env.MOCK_GRADER === 'wrongmodel' ? { 'claude-haiku-4-5': { costUSD: 0.1 } } : usage }];
    if (env.MOCK_GRADER_DELAY_MS) setTimeout(() => out(graded), Number(env.MOCK_GRADER_DELAY_MS));
    else out(graded);
    return;
  }
  if (noTools) {
    const bad = env.MOCK_REPORT_TURN === 'bad';
    const turn = [init([], bad ? { model: 'claude-haiku-4-5', claude_code_version: '0.0.0', permissionMode: 'default', mcp_servers: [{ name: 'x' }] } : {}), { type: 'result', subtype: 'success', is_error: false, result: 'REPORT from the transcript', total_cost_usd: 0.1, modelUsage: usage }];
    if (env.MOCK_REPORT_DELAY_MS) setTimeout(() => out(turn), Number(env.MOCK_REPORT_DELAY_MS));
    else out(turn);
    return;
  }
  if (env.MOCK_SCENARIO === 'slow') {
    const usage = env.MOCK_NO_USAGE === '1' ? undefined : { input_tokens: 10, cache_creation_input_tokens: 2000, cache_read_input_tokens: 5000, output_tokens: 300 };
    out([init(['Glob', 'Grep', 'Read']), { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'project.yaml' } }], ...(usage ? { usage } : {}) } }]);
    const { spawn } = require('node:child_process');
    const sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
    require('node:fs').writeFileSync(require('node:path').join(env.MOCK_PID_DIR, process.pid + '.json'), JSON.stringify({ pid: process.pid, grandchild: sleeper.pid }));
    setInterval(() => {}, 1000);
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
  const custom = env.MOCK_TOOL_INPUTS ? JSON.parse(env.MOCK_TOOL_INPUTS) : [];
  const results = env.MOCK_TOOL_RESULTS ? JSON.parse(env.MOCK_TOOL_RESULTS) : [];
  const errors = env.MOCK_TOOL_ERRORS ? JSON.parse(env.MOCK_TOOL_ERRORS) : [];
  for (let index = 1; index <= calls; index += 1) {
    const use = custom[index - 1] ?? { name: 'Read', input: { file_path: 'project.yaml' } };
    events.push({ type: 'assistant', message: { id: 'm' + index, content: [{ type: 'tool_use', id: 'c' + index, name: use.name, input: use.input }], usage: { input_tokens: 1, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 5 } } });
    events.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c' + index, content: results[index - 1] ?? 'read ' + index, ...(errors.includes(index) ? { is_error: true } : {}) }] } });
  }
  events.push({ type: 'result', subtype: 'success', is_error: false, result: 'REPORT ' + (env.MOCK_REPORT ?? 'ok'), total_cost_usd: 0.3, modelUsage: usage });
  if (env.MOCK_DELAY_MS) setTimeout(() => out(events), Number(env.MOCK_DELAY_MS));
  else out(events);
});
`;

const MOCK_ENV = ['MOCK_SCENARIO', 'MOCK_CALLS', 'MOCK_REPORT_TURN', 'MOCK_GRADER', 'MOCK_REPORT', 'MOCK_TOOL_INPUTS', 'MOCK_TOOL_RESULTS', 'MOCK_TOOL_ERRORS', 'MOCK_PID_DIR', 'MOCK_IGNORE_TERM', 'MOCK_NO_USAGE', 'MOCK_DELAY_MS', 'MOCK_VERSION_FILE', 'MOCK_ENV_DUMP_DIR', 'MOCK_STARTED_DIR', 'MOCK_REPORT_DELAY_MS', 'MOCK_GRADER_DELAY_MS'];

async function loadHarness(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'a7-harness-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mock = path.join(dir, 'mock-claude');
  await writeFile(mock, MOCK);
  await chmod(mock, 0o755);
  process.env.A7_CLAUDE_BIN = mock;
  for (const key of MOCK_ENV) delete process.env[key];
  t.after(() => {
    for (const key of MOCK_ENV) delete process.env[key];
  });
  const harness = await import(`../../scripts/evaluate-brief-a7.js?mock=${Date.now()}-${Math.random()}`);
  return { harness, dir, mock };
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

// Synthetic labels in the v3 layout: the harness grades the merged v3 blocks.
// F1 quotes a corpus passage (shared with the corpus, so never forbidden) and
// holds label-only prose; F5's label-only prose stands in for held-out content.
const LABEL_ONLY_TUNING = 'The quarterly audit freezes the plum ledger before the vendor reconciliation window closes.';
const LABEL_ONLY_HELDOUT = 'Zebra invoices settle only after the copper review board signs the quarterly attestation.';
const QUOTED_CORPUS = 'Each account has a metered allowance of refresh runs per period under D-101';
// A long corpus path the labels cite with a heading, as real labels do
// (`path › heading`), and a quote of A5's prompt template with its
// "{files or 'none'}": both are label text that a tool or the prompt frame
// can compose from the run copy, so neither may be forbidden there.
const LONG_DOC_PATH = 'architecture/platform/project-memory/recall-and-plain-language-build-plan.md';
const LONG_DOC = `---
domain: Platform
feature: Project Memory
component: Build Plan
status: In progress
---

## Description
The build plan for the recall program.

## Current state that motivates the plan
Pushed notes reach the dashboard as Activity rows.
`;
const TUNING_LABELS = `### Tuning tasks
Prompt template: "You are starting a builder session in this project-memory root. Task: {task}. Files: {files or 'none'}. Do not write code. Using project memory, produce a context report."
Cited: \`docs:${LONG_DOC_PATH}\` › Current state that motivates the plan

#### F1 — file-scoped · tuning
- **Task:** Superseded v1 block; the harness never reads it.

### A7 later attempt

#### Merged v3 tuning labels (the harness grades these)
Every tuning block in full.

##### F1 — file-scoped · tuning · v3
- **Task:** Rewrite the message a user sees when a hosted refresh run is refused.
- **Files:** \`app:src/lib/entitlements.ts\`
- **Must-have facts:**
  - M1 (a) ${QUOTED_CORPUS}; (b) two.
  - M2 ${LABEL_ONLY_TUNING}
- **Forbidden authority claims:**
  - X1 Bad.
  - X2 Worse.
- **Tags:** —

##### N1 — no-match · tuning · v3
- **Task:** Add Klingon subtitles and a karaoke kiosk mode.
- **Forbidden authority claims:**
  - X1 Bad.
- **Tags:** no-match

## Results
`;
const HELDOUT_LABELS = `#### F5 — task-only · held-out
- **Task:** Change the Free plan credit balance and the Solo plan price.
- **Must-have facts:**
  - M1 ${LABEL_ONLY_HELDOUT}
- **Forbidden authority claims:**
  - X1 Bad.
- **Tags:** —
`;
// Corpus text that looks like evaluation material but is ordinary memory.
const MARKER_DOC = `---
domain: Sync
feature: Lanes
component: Evaluation Notes
status: In progress
---

## Description
Evaluation files such as recall-evaluation-heldout-v3.md hold labels; this note is not one. A label lists - **Must-have facts:** and - **Forbidden authority claims:** with items like M1 (a) and X1.
`;
const STARTUP_ROOT = {
  'context.md': '# Project Context — Acme Widgets\n\nThe generated session protocol.\n',
  'architecture/overview/project-status.md': '---\ndomain: Overview\nfeature: Project Shape\ncomponent: Status and Working Agreements\nstatus: In progress\n---\n\n## Description\nAcme status and working agreements.\n',
};

/** A tagged docs repo, its corpus export, label copies, and a prepared evaluation directory. */
async function prepared(harness, dir, { link = null, heldout = HELDOUT_LABELS } = {}) {
  const repo = path.join(dir, 'docs');
  const corpus = path.join(dir, 'corpus');
  const addLink = async (root) => {
    if (!link) return;
    await mkdir(path.dirname(path.join(root, link.path)), { recursive: true });
    await symlink(link.target, path.join(root, link.path));
  };
  for (const root of [repo, corpus]) {
    await cp(FIXTURE_ROOT, root, { recursive: true });
    for (const [file, text] of Object.entries(STARTUP_ROOT)) await writeFile(path.join(root, file), text);
    await writeFile(path.join(root, 'architecture', 'sync', 'evaluation-notes.md'), MARKER_DOC);
    await mkdir(path.dirname(path.join(root, LONG_DOC_PATH)), { recursive: true });
    await writeFile(path.join(root, LONG_DOC_PATH), LONG_DOC);
    await addLink(root);
  }
  await writeFile(path.join(repo, 'architecture', 'platform', 'project-memory', 'recall-evaluation.md'), TUNING_LABELS);
  const git = (...args) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-q', '-m', 'corpus'], ['tag', 'recall-eval-corpus-v3']]) assert.equal(git(...args).status, 0);
  const labelsDir = path.join(dir, 'labels-in');
  await mkdir(labelsDir, { recursive: true });
  await writeFile(path.join(labelsDir, 'recall-evaluation.md'), TUNING_LABELS);
  // The held-out file lives outside every repo, under any name.
  await writeFile(path.join(labelsDir, 'held-out-set.md'), heldout);
  const ctx = { dir: path.join(dir, 'eval'), cap: 100, concurrency: 4, quiet: true, graceMs: 300, identity: () => ({ package_commit: 'test', package_dirty: '', package_src_tree: 'test' }) };
  // A quiet machine, whatever the test runner's real load.
  const opts = { corpus, docsRepo: repo, tuningLabels: path.join(labelsDir, 'recall-evaluation.md'), heldout: path.join(labelsDir, 'held-out-set.md'), heldoutSha: sha256(heldout), warmRuns: 1, expectTasks: 3, tuningTasks: 2, cores: 16, loadavg: () => [1, 1, 1] };
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

  // The next run records that attempt as aborted (a killed harness left it
  // open): an aborted evaluated session ends the entry, so nothing more
  // starts, for any run (reviewer pass 1, R1).
  delete process.env.MOCK_GRADER;
  const startsBefore = (await harness.readLedger(ctx.dir)).filter((record) => record.event === 'start').length;
  await assert.rejects(() => harness.run({ ...ctx, cap: 6, only: new Set(['r002']) }), /can no longer conform[\s\S]*run:r001#1 was aborted \(left open by a killed harness\)/);
  assert.equal((await harness.readLedger(ctx.dir)).filter((record) => record.event === 'start').length, startsBefore, 'no paid session started');
  const closed = await harness.ledgerSpend(ctx.dir);
  assert.deepEqual(closed.aborted, ['run:r001#1']);
  assert.deepEqual(closed.unresolved, ['run:r001#1'], 'still unresolved: no stream, so its reserve is held');
  assert.deepEqual(closed.open, []);
  assert.equal(await harness.attemptsOf(ctx.dir, 'run:r001'), 1, 'never retried');
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
  assert.equal(JSON.parse(await readFile(metaFile, 'utf8')).reconciled, true);
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

// --------------------------------------------------------- pass 5

test('an interruption between a session finishing and its metadata write never repeats the paid session (review pass 5, R12)', async (t) => {
  const { harness, dir } = await loadHarness(t);
  const { ctx } = await prepared(harness, dir);
  const manifest = JSON.parse(await readFile(path.join(ctx.dir, 'manifest.json'), 'utf8'));
  const base = (id) => path.join(ctx.dir, 'transcripts', id);
  const attempts = async (id) => [await harness.attemptsOf(ctx.dir, `run:${id}`), await harness.attemptsOf(ctx.dir, `report:${id}`)];
  const clean = async (id) => (await harness.auditRun(ctx.dir, manifest.runs.find((entry) => entry.id === id), manifest.tool_call_cap, manifest)).violations;

  // r001: a stopped run whose report turn finished in the ledger, interrupted
  // before the report copy and the final metadata write.
  process.env.MOCK_CALLS = '25';
  await harness.run({ ...ctx, only: new Set(['r001']) });
  const done = JSON.parse(await readFile(`${base('r001')}.meta.json`, 'utf8'));
  await writeFile(`${base('r001')}.meta.json`, JSON.stringify({ ...done, state: 'report-pending', report_attempt: null, report_sha256: null, report_wall_ms: null }));
  await rm(`${base('r001')}.report.jsonl`);
  await harness.run({ ...ctx, only: new Set(['r001']) });
  assert.deepEqual(await attempts('r001'), [1, 1], 'the finished report is reconciled, not paid for again');
  const reconciled = JSON.parse(await readFile(`${base('r001')}.meta.json`, 'utf8'));
  assert.equal(reconciled.state, 'complete');
  assert.equal(reconciled.reconciled, true);
  assert.deepEqual(await clean('r001'), []);

  // r002: research finished in the ledger, interrupted before the transcript copy and metadata.
  delete process.env.MOCK_CALLS;
  await harness.run({ ...ctx, only: new Set(['r002']) });
  await rm(`${base('r002')}.meta.json`);
  await rm(`${base('r002')}.jsonl`);
  await harness.run({ ...ctx, only: new Set(['r002']) });
  assert.deepEqual(await attempts('r002'), [1, 0]);
  assert.deepEqual(await clean('r002'), []);

  // Empty and partial metadata on resume: reconciled, never re-run.
  await writeFile(`${base('r002')}.meta.json`, '{}');
  await harness.run({ ...ctx, only: new Set(['r002']) });
  const partial = JSON.parse(await readFile(`${base('r002')}.meta.json`, 'utf8'));
  delete partial.research_sha256;
  partial.state = 'report-pending';
  await writeFile(`${base('r002')}.meta.json`, JSON.stringify(partial));
  await harness.run({ ...ctx, only: new Set(['r002']) });
  assert.deepEqual(await attempts('r002'), [1, 0]);
  assert.deepEqual(await clean('r002'), []);

  // Direct dispatch of a finished session is refused too.
  const r003 = manifest.runs.find((entry) => entry.id === 'r003');
  await harness.run({ ...ctx, only: new Set(['r003']) });
  await rm(`${base('r003')}.meta.json`);
  await assert.rejects(() => harness.runAgent('PROMPT', r003.root, base('r003'), 24, { ledgerDir: ctx.dir, runId: 'r003' }), /already finished in the ledger/);

  // Two finished research attempts: the run stops without spending.
  const ledger = await harness.readLedger(ctx.dir);
  const start = ledger.find((record) => record.event === 'start' && record.job === 'run:r002');
  const finish = ledger.find((record) => record.event === 'finish' && record.call === start.call);
  await appendFile(path.join(ctx.dir, 'ledger.jsonl'), `${JSON.stringify({ ...start, call: 'run:r002#2', attempt: 2 })}\n${JSON.stringify({ ...finish, call: 'run:r002#2' })}\n`);
  const before = (await harness.readLedger(ctx.dir)).length;
  await assert.rejects(() => harness.run({ ...ctx, only: new Set(['r002']) }), /2 finished attempts for run:r002; refusing/);
  assert.equal((await harness.readLedger(ctx.dir)).length, before, 'nothing was spent');

});

// --------------------------------------------------------- Phase 2 preflight

test('corpus symlinks are verified by their link text and copied verbatim; changed, replaced, or escaping links stop preparation', async (t) => {
  const { harness, dir } = await loadHarness(t);
  // As in recall-eval-corpus-v2 and v3: a relative link whose target is not in the corpus.
  const link = { path: '.agent/skills/postgres', target: '../../.agents/skills/postgres' };
  const { ctx, opts } = await prepared(harness, dir, { link });
  const manifest = JSON.parse(await readFile(path.join(ctx.dir, 'manifest.json'), 'utf8'));
  for (const entry of manifest.runs) assert.equal(await readlink(path.join(entry.root, link.path)), link.target, 'copied verbatim');
  await harness.run({ ...ctx, only: new Set(['r001']) });

  const corpusLink = path.join(opts.corpus, link.path);
  const prepareAgain = (name) => harness.prepare({ ...ctx, dir: path.join(dir, name) }, opts);
  await rm(corpusLink);
  await symlink('../../.agents/skills/other', corpusLink);
  await assert.rejects(() => prepareAgain('changed'), /corpus file \.agent\/skills\/postgres differs from recall-eval-corpus-v3/);
  await rm(corpusLink);
  await writeFile(corpusLink, link.target);
  await assert.rejects(() => prepareAgain('replaced'), /is not a symlink but is one in recall-eval-corpus-v3/);
  await rm(corpusLink);
  await symlink('../../../outside', corpusLink);
  await assert.rejects(() => prepareAgain('escaping'), /corpus symlink \.agent\/skills\/postgres points outside the corpus/);
});

// --------------------------------------------------------- pre-run amendment 2, as observations

test('naming an evaluation file is an observation: exclusions, unsuccessful searches, and mentions are counted, never deviations (later attempt; amendment 2 and the 2026-10-03 r061 shape)', async (t) => {
  const { harness, dir } = await loadHarness(t);
  // Inputs from the aborted Phase 2 attempt's r001 (F1 baseline #1); its fourth repeats the second's glob.
  const observed = [
    { pattern: 'entitlements\\.ts|billing/errors\\.ts', output_mode: 'content', glob: '!**/recall-evaluation*' },
    { pattern: 'allowance_exhausted', output_mode: 'content', glob: '!**/{recall-evaluation*,research/*.json}', '-n': true },
    { pattern: '(?i)denial', path: 'architecture', output_mode: 'content', '-n': true, glob: '!**/{recall-evaluation*,research/*.json}' },
  ];
  for (const input of observed) assert.equal(harness.isEvaluationExclusion({ name: 'Grep', input }), true, JSON.stringify(input));
  assert.equal(harness.isEvaluationExclusion({ name: 'Grep', input: { pattern: 'x', glob: '*.md !recall-evaluation*' } }), true);
  for (const use of [
    { name: 'Grep', input: { pattern: 'recall-evaluation' } },
    { name: 'Grep', input: { pattern: 'x', glob: '**/recall-evaluation*' } },
    { name: 'Glob', input: { pattern: '!**/recall-evaluation*' } },
  ]) assert.equal(harness.isEvaluationExclusion(use), false, JSON.stringify(use));

  const { ctx } = await prepared(harness, dir);
  const manifest = JSON.parse(await readFile(path.join(ctx.dir, 'manifest.json'), 'utf8'));
  // One research session: an exclusion, r061's positive Glob that found nothing,
  // a Read of an absent evaluation file, and a Grep whose corpus results name one.
  process.env.MOCK_CALLS = '4';
  process.env.MOCK_TOOL_INPUTS = JSON.stringify([
    { name: 'Grep', input: observed[1] },
    { name: 'Glob', input: { pattern: 'architecture/**/recall-evaluation*.md' } },
    { name: 'Read', input: { file_path: 'architecture/platform/project-memory/recall-evaluation-heldout-v3.md' } },
    { name: 'Grep', input: { pattern: 'recall-evaluation', output_mode: 'content', '-n': true } },
  ]);
  process.env.MOCK_TOOL_RESULTS = JSON.stringify(['No matches found', 'No files found', 'File does not exist.', 'architecture/sync/evaluation-notes.md:9:Evaluation files such as recall-evaluation-heldout-v3.md hold labels; this note is not one. A label lists - **Must-have facts:** and - **Forbidden authority claims:** with items like M1 (a) and X1.']);
  process.env.MOCK_TOOL_ERRORS = JSON.stringify([3]);
  await harness.run({ ...ctx, only: new Set(['r001']) });
  const audit = await harness.auditRun(ctx.dir, manifest.runs.find((entry) => entry.id === 'r001'), manifest.tool_call_cap, manifest);
  assert.deepEqual(audit.violations, [], 'no evaluation content reached the session');
  assert.deepEqual(audit.isolation_observations, { exclusions: 1, unsuccessful_searches: 2, mentions: 1 });
  assert.equal(audit.evaluation_exclusions, 1);
});

// ------------------------------------------------------------- isolation rule

test('the isolation index holds label-only content: corpus text, quoted passages, and marker-like text are never forbidden (later attempt › isolation rule)', async (t) => {
  const { harness, dir } = await loadHarness(t);
  const { ctx } = await prepared(harness, dir);
  const index = JSON.parse(await readFile(path.join(ctx.dir, 'isolation.json'), 'utf8'));
  const forbidden = new Set(index.fingerprints);
  assert.ok(index.fingerprints.length > 0);
  assert.ok(index.shared_with_corpus > 0, 'the label quotes a corpus passage');
  // Leaked content with no markers at all is caught, in any framing.
  assert.ok(harness.countFingerprintHits(LABEL_ONLY_HELDOUT, forbidden) > 0);
  // Read and Grep deliver lines intact: a label line among corpus lines is caught in every framing.
  const corpusLine = 'Accepted runs stay consumed. The ledger records every accepted run.';
  assert.ok(harness.countFingerprintHits(`    12\u2192${corpusLine}\n    13\u2192  - M1 ${LABEL_ONLY_HELDOUT}\n    14\u2192`, forbidden, { toolOutput: true }) > 0, 'arrow-framed Read lines');
  assert.ok(harness.countFingerprintHits(`    12\t${corpusLine}\n    13\t${LABEL_ONLY_HELDOUT}`, forbidden, { toolOutput: true }) > 0, 'tab-framed Read lines');
  assert.equal(harness.countFingerprintHits(`    12\u2192${corpusLine}`, forbidden, { toolOutput: true }), 0);
  // Each line is fingerprinted alone: a line under eight words carries no fingerprint (a disclosed bound).
  assert.equal(harness.countFingerprintHits('Zebra invoices settle only after the copper', forbidden), 0);
  assert.ok(harness.countFingerprintHits(`docs/notes.md:4:${LABEL_ONLY_HELDOUT.toUpperCase()}`, forbidden, { toolOutput: true }) > 0, 'Grep framing, any case');
  assert.ok(harness.countFingerprintHits(LABEL_ONLY_TUNING, forbidden) > 0, 'tuning-label-only text too');
  // Corpus text is never forbidden: a quoted passage, and marker-like strings.
  assert.equal(harness.countFingerprintHits(QUOTED_CORPUS, forbidden), 0);
  assert.equal(harness.countFingerprintHits(MARKER_DOC, forbidden), 0);
  // Every corpus file, delivered whole, carries nothing forbidden.
  for (const file of ['architecture/billing/ledger.md', 'architecture/billing/pricing.md', 'architecture/sync/evaluation-notes.md', 'context.md', 'project.yaml']) {
    assert.equal(harness.countFingerprintHits(await readFile(path.join(dir, 'corpus', file), 'utf8'), forbidden, { toolOutput: true }), 0, file);
  }
  // Markers alone never decide: a marker-only line is too short and too generic to fingerprint.
  assert.equal(harness.fingerprints('- **Must-have facts:** M1 (a) X1 X2 D-101 D-102').size, 0);
  // Changing the index after prepare stops every later stage.
  await writeFile(path.join(ctx.dir, 'isolation.json'), JSON.stringify({ ...index, fingerprints: [] }));
  await assert.rejects(() => harness.run(ctx), /isolation\.json changed since prepare/);
});

test('forbidden content delivered through a tool result is a deviation; designed deliveries and corpus content are not; escaping patterns are (later attempt › isolation rule)', async (t) => {
  const { harness, dir } = await loadHarness(t);
  const { ctx, opts } = await prepared(harness, dir);
  const manifest = JSON.parse(await readFile(path.join(ctx.dir, 'manifest.json'), 'utf8'));
  const f1Baseline = manifest.runs.filter((entry) => entry.task === 'F1' && entry.arm === 'baseline').map((entry) => entry.id);
  // A deviation ends an entry (R1), so each session runs in its own freshly prepared evaluation directory.
  let fresh = 0;
  const session = async (id, inputs, results) => {
    fresh += 1;
    const own = { ...ctx, dir: path.join(dir, `eval-${fresh}`) };
    await harness.prepare(own, opts);
    const ownManifest = JSON.parse(await readFile(path.join(own.dir, 'manifest.json'), 'utf8'));
    process.env.MOCK_CALLS = String(inputs.length);
    process.env.MOCK_TOOL_INPUTS = JSON.stringify(inputs);
    process.env.MOCK_TOOL_RESULTS = JSON.stringify(results);
    await harness.run({ ...own, only: new Set([id]) });
    process.exitCode = 0;
    return harness.auditRun(own.dir, ownManifest.runs.find((entry) => entry.id === id), ownManifest.tool_call_cap, ownManifest);
  };
  const read = (file) => ({ name: 'Read', input: { file_path: file } });

  // Designed deliveries: the run's own task line (in its lane files and brief) and corpus files.
  const lane = await readFile(path.join(manifest.runs.find((entry) => entry.id === f1Baseline[0]).root, 'sessions/active/eval/wip.md'), 'utf8');
  const clean = await session(f1Baseline[0], [read('sessions/active/eval/wip.md'), read('architecture/billing/ledger.md')], [lane, await readFile(path.join(dir, 'corpus', 'architecture/billing/ledger.md'), 'utf8')]);
  assert.deepEqual(clean.violations, []);
  // The brief arm reads its own brief: run-copy content, including its own Task line and its `path › heading` references.
  const f1BriefRun = manifest.runs.find((entry) => entry.task === 'F1' && entry.arm === 'brief');
  const ownBrief = await session(f1BriefRun.id, [read('sessions/active/eval/brief.md')], [await readFile(path.join(f1BriefRun.root, 'sessions/active/eval/brief.md'), 'utf8')]);
  assert.deepEqual(ownBrief.violations, []);

  // Leaked held-out content with no markers, framed as an ordinary Read result.
  const leaked = await session(f1Baseline[1], [read('architecture/billing/ledger.md')], [`     3\u2192${LABEL_ONLY_HELDOUT}`]);
  assert.equal(leaked.violations.length, 1, leaked.violations.join(' | '));
  assert.match(leaked.violations[0], /^forbidden content delivered: \d+ isolation fingerprint\(s\) in the result of call 1 \(Read\)$/);
  assert.doesNotMatch(leaked.violations[0], /zebra/i, 'the finding names no forbidden content');

  // Another task's text is not a designed delivery for this run.
  const crossTask = await session(f1Baseline[2], [{ name: 'Grep', input: { pattern: 'plan price', output_mode: 'content' } }], ['docs/x.md:Task: Change the Free plan credit balance and the Solo plan price.']);
  assert.ok(crossTask.violations.some((entry) => /forbidden content delivered/.test(entry)), crossTask.violations.join(' | '));

  // Path confinement covers glob patterns, even when nothing was found.
  const f1Brief = manifest.runs.filter((entry) => entry.task === 'F1' && entry.arm === 'brief').map((entry) => entry.id);
  const escaping = await session(f1Brief[1], [
    { name: 'Glob', input: { pattern: '../../labels/*.md' } },
    { name: 'Grep', input: { pattern: 'x', glob: '{*.md,/etc/*}' } },
    { name: 'Read', input: { file_path: '/etc/hosts' } },
  ], ['No files found', 'No matches found', 'File does not exist.']);
  for (const expected of [/Glob pattern reaches outside the run copy: \.\.\/\.\.\/labels\/\*\.md/, /Grep pattern reaches outside the run copy: \/etc\/\*/, /Read outside the run copy: \/etc\/hosts/]) {
    assert.ok(escaping.violations.some((entry) => expected.test(entry)), `${expected} in ${escaping.violations.join(' | ')}`);
  }
  assert.deepEqual(await harness.confinementProblems({ name: 'Glob', input: { pattern: 'architecture/**/*.md' } }, '/tmp/x'), []);
});

test('a brace group followed by a path is one relative pattern; an escape inside or after a group, behind an escape, or past the bounds is still caught (attempt 1 r027 and r030; Change 7; reviewer pass 4, R6 and R7)', async (t) => {
  const { harness, dir } = await loadHarness(t);
  const problems = async (name, glob) => harness.confinementProblems({ name, input: name === 'Glob' ? { pattern: glob } : { pattern: 'x', glob } }, '/tmp/x');
  assert.deepEqual(harness.expandBraces('{architecture,sessions}/**/*.md'), ['architecture/**/*.md', 'sessions/**/*.md']);
  assert.deepEqual(harness.expandBraces('{a,{b,c}}/x{1,2}'), ['a/x1', 'a/x2', 'b/x1', 'b/x2', 'c/x1', 'c/x2']);
  // Ripgrep's grammar (checked with `rg --debug`): escaped braces and braces or commas in a class are literal.
  assert.deepEqual(harness.expandBraces(String.raw`{\{foo,/etc\},x}`), [String.raw`\{foo`, String.raw`/etc\}`, 'x']);
  assert.deepEqual(harness.expandBraces('{a,[,]/etc}'), ['a', '[,]/etc']);
  assert.deepEqual(harness.expandBraces('[]{]x'), ['[]{]x']);
  for (const unbalanced of ['{a,/b', 'a}/{b,c}', '{a,b}[x', '{/etc']) assert.ok(!Array.isArray(harness.expandBraces(unbalanced)), unbalanced);

  for (const glob of ['{architecture,sessions}/**/*.md', '{architecture,decisions}/**/*.md', '**/{a,b}/*.md', '{a,{b,c}}/x', 'docs/{a,b}.md', '!{recall-evaluation*,x}', '*.md,*.yaml', '*.[jt]s', String.raw`\{literal\}/*.md`, String.raw`{docs,notes}/\{draft\}.md`, '{a,[,]/etc}', '[]{]x', '{a,b}'.repeat(12)]) {
    for (const name of ['Grep', 'Glob']) assert.deepEqual(await problems(name, glob), [], `${name} ${glob}`);
  }
  const dots = (count) => `{${Array(count).fill('.').join(',')}}.`;
  for (const [glob, finding] of [
    ['{/etc,docs}/*.md', 'reaches outside the run copy: /etc/*.md'],
    ['docs/{..,x}/*', 'reaches outside the run copy: docs/../*'],
    ['{a,b}/../x', 'reaches outside the run copy: a/../x'],
    ['~/{a,b}', 'reaches outside the run copy: ~/a'],
    ['!{/etc,x}', 'reaches outside the run copy: /etc'],
    ['{a,{b,/c}}', 'reaches outside the run copy: /c'],
    ['/{a,b}', 'reaches outside the run copy: /a'],
    ['x/{a,b} /etc/*', 'reaches outside the run copy: /etc/*'],
    // Unbalanced (ripgrep rejects these): read with literal braces and token by token; either finding counts.
    ['{a,/b', 'reaches outside the run copy: /b'],
    ['{/etc', 'reaches outside the run copy: /etc'],
    ['{.,.}./x{', 'reaches outside the run copy: ../x{'],
    // R6: an escaped brace does not delimit a group, and an escaped slash is a slash.
    [String.raw`{\{foo,/etc\},x}`, String.raw`reaches outside the run copy: /etc\}`],
    [String.raw`\/etc/*`, String.raw`reaches outside the run copy: \/etc/*`],
    [String.raw`\.\./x`, String.raw`reaches outside the run copy: \.\./x`],
    // R7: a composed `..` at, below, and beyond the expansion bound.
    [dots(257), 'reaches outside the run copy: ..'],
    [dots(2000), 'reaches outside the run copy: ..'],
    ['{a,b}'.repeat(13), 'cannot be checked (more than 4096 brace expansions)'],
    [dots(2100), 'cannot be checked (longer than 4096 characters)'],
    [`${'{'.repeat(65)}a${'}'.repeat(65)}`, 'cannot be checked (brace groups nested deeper than 64)'],
    [`${'{'.repeat(65)}a`, 'cannot be checked (brace groups nested deeper than 64)'],
  ]) {
    for (const name of ['Grep', 'Glob']) {
      const found = await problems(name, glob);
      assert.ok(found.some((entry) => entry.startsWith(`${name} pattern ${finding}`)), `${name} ${glob.slice(0, 40)}: ${found.join(' | ').slice(0, 300)}`);
    }
  }

  // Attempt 1's shape end to end: a Grep over the run copy with a brace-group glob passes the audit.
  const { ctx } = await prepared(harness, dir);
  const manifest = JSON.parse(await readFile(path.join(ctx.dir, 'manifest.json'), 'utf8'));
  const entry = manifest.runs.find((candidate) => candidate.task === 'F1' && candidate.arm === 'brief');
  process.env.MOCK_CALLS = '1';
  process.env.MOCK_TOOL_INPUTS = JSON.stringify([{ name: 'Grep', input: { pattern: 'ledger', path: entry.root, output_mode: 'content', '-n': true, glob: '{architecture,sessions}/**/*.md', head_limit: 20 } }]);
  process.env.MOCK_TOOL_RESULTS = JSON.stringify(['architecture/billing/ledger.md:1:# Ledger']);
  await harness.run({ ...ctx, only: new Set([entry.id]) });
  assert.notEqual(process.exitCode, 4);
  process.exitCode = 0;
  const metrics = await harness.auditRun(ctx.dir, entry, manifest.tool_call_cap, manifest);
  assert.deepEqual(metrics.violations, []);
});

test("a run's own location is a designed delivery: an oversized-output notice naming it carries no forbidden content, while label content beside it still does (attempt 2; Change 8)", async (t) => {
  const { harness, dir } = await loadHarness(t);
  const { ctx } = await prepared(harness, dir);
  const manifest = JSON.parse(await readFile(path.join(ctx.dir, 'manifest.json'), 'utf8'));
  const entry = manifest.runs[0];
  // The run copy at a location shaped like attempt 2's (H17): its own words
  // form fingerprints under any TMPDIR, so the precondition never depends on
  // how long the test runner's temp path is.
  const root = path.join(dir, 'vibecompass-eval.noindex', 'brief-a7-later-attempt', 'runs', entry.id);
  await cp(entry.root, root, { recursive: true });
  // A label copy that names the run's location, as recall-evaluation.md did for attempt 2.
  const labelLine = `- the evaluation directory is \`${root}\`, outside every repo and memory root, beside the corpus export.`;
  const forbidden = new Set([...harness.fingerprints(labelLine), ...harness.fingerprints(LABEL_ONLY_HELDOUT)]);
  const own = await harness.runForbidden(forbidden, root);
  const notice = [
    '<persisted-output>',
    `Output too large (33.3KB). Full output saved to: ${harness.claudeProjectDir(root)}/0ea7ac03-81c2-49d8-94e0-e2d9dc7426fc/tool-results/toolu_01NLrMkjPANtnycKyawVSgFj.txt`,
    '',
    'Preview (first 2KB):',
    'architecture/billing/ledger.md:1:# Ledger',
    '...',
    '</persisted-output>',
  ].join('\n');
  assert.ok(harness.countFingerprintHits(notice, forbidden, { toolOutput: true }) > 0, 'precondition: without the location rule the notice hits');
  assert.equal(harness.countFingerprintHits(notice, own, { toolOutput: true }), 0);
  assert.equal(harness.countFingerprintHits(`${root}/architecture/billing/ledger.md\n${await realpath(root)}/architecture/billing/ledger.md`, own, { toolOutput: true }), 0, 'absolute run-copy listings');
  assert.ok(harness.countFingerprintHits(labelLine, own) > 0, 'label words joined to location words stay forbidden');
  assert.ok(harness.countFingerprintHits(`${notice}\n${LABEL_ONLY_HELDOUT}`, own, { toolOutput: true }) > 0, 'label-only content beside a notice still hits');
});

test("the isolation method names the run's own-location rule, and the fingerprint list is what 255cb79 built from the same inputs (A7 review S1)", async (t) => {
  const { harness, dir } = await loadHarness(t);
  const { ctx } = await prepared(harness, dir);
  const index = JSON.parse(await readFile(path.join(ctx.dir, 'isolation.json'), 'utf8'));
  // Text only: the frozen harness (255cb79) built these from the same labels and corpus.
  assert.deepEqual(
    { label: index.label_fingerprints, shared: index.shared_with_corpus, forbidden: index.fingerprints.length, digest: sha256(index.fingerprints.join('\n')) },
    { label: 77, shared: 17, forbidden: 60, digest: '37559ebe5c841063014bc6aefb52f1ed45152d1cea320c2a99db7eaaa9d92b10' },
  );
  assert.match(index.method.forbidden, /per run also minus its lane files, its brief, and its own location \(Change 8: its root as given and resolved, each run-copy file's absolute path, and Claude Code's project-store directory for that root\);/);
});

test('what a tool or the prompt frame can compose from the run copy is never forbidden: path › heading references, unstripped Grep prefixes, path listings, the brief, and the no-files template (later attempt › isolation rule)', async (t) => {
  const { harness, dir } = await loadHarness(t);
  const { ctx } = await prepared(harness, dir);
  const manifest = JSON.parse(await readFile(path.join(ctx.dir, 'manifest.json'), 'utf8'));
  const raw = new Set(JSON.parse(await readFile(path.join(ctx.dir, 'isolation.json'), 'utf8')).fingerprints);
  const baseline = manifest.runs.find((entry) => entry.task === 'N1' && entry.arm === 'baseline');
  const forbidden = await harness.runForbidden(raw, baseline.root);
  // The label's reference is label text; delivered alone it would be caught, were the corpus not able to compose it.
  const reference = `\`${LONG_DOC_PATH}\` › Current state that motivates the plan`;
  assert.ok(harness.fingerprints(reference).size > 0);
  assert.equal(harness.countFingerprintHits(reference, raw), 0, 'the index already knows a tool can compose it');
  for (const delivered of [
    `${LONG_DOC_PATH}:11:## Current state that motivates the plan`,
    `/tmp/Private Backups/eval/runs/r001/${LONG_DOC_PATH}:## Current state that motivates the plan`,
    `/tmp/Private Backups/eval/runs/r001/${LONG_DOC_PATH}-11-## Current state that motivates the plan`,
    `/tmp/Private Backups/eval/runs/r001/${LONG_DOC_PATH}`,
  ]) assert.equal(harness.countFingerprintHits(delivered, forbidden, { toolOutput: true }), 0, delivered);
  // The prompt frame: a no-files task renders "Files: none. Do not write code. Using project memory", which the label quotes.
  const prompt = await readFile(path.join(ctx.dir, 'prompts', `${baseline.id}.txt`), 'utf8');
  assert.ok(harness.countFingerprintHits(prompt, forbidden) > 0, 'without the frame the template quote collides');
  assert.equal(harness.countFingerprintHits(prompt, harness.withoutPromptFrame(forbidden, manifest.tasks.find((task) => task.id === 'N1'), baseline.startup_files.map((file) => file.path))), 0);
  // A brief line that composes a path with a heading is run-copy content of the brief arm.
  const briefRoot = path.join(dir, 'brief-root');
  await mkdir(path.join(briefRoot, 'sessions', 'active', 'eval'), { recursive: true });
  const briefLine = `- cited by ${reference}`;
  await writeFile(path.join(briefRoot, 'sessions', 'active', 'eval', 'brief.md'), `${briefLine}\n`);
  const withBrief = await harness.runForbidden(raw, briefRoot);
  assert.equal(harness.countFingerprintHits(briefLine, withBrief), 0);
  // Label-only text is still caught under every one of these subtractions.
  assert.ok(harness.countFingerprintHits(LABEL_ONLY_HELDOUT, withBrief) > 0);
  assert.ok(harness.countFingerprintHits(`/tmp/Private Backups/x.md:${LABEL_ONLY_HELDOUT}`, forbidden, { toolOutput: true }) > 0);
});

test('latency is measured only on a quiet machine: a busy one prepares nothing and records no outcome (later attempt, J8)', async (t) => {
  const { harness, dir } = await loadHarness(t);
  const { ctx, opts } = await prepared(harness, dir);
  const manifest = JSON.parse(await readFile(path.join(ctx.dir, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.latency.load_average, { before: [1, 1, 1], after: [1, 1, 1], limit: 8, logical_cores: 16 });
  const busy = { ...ctx, dir: path.join(dir, 'busy') };
  await assert.rejects(() => harness.prepare(busy, { ...opts, loadavg: () => [8.5, 4, 2] }), /Machine busy; nothing prepared: the one-minute load average is 8\.50, above 8/);
  await assert.rejects(() => readFile(path.join(busy.dir, 'manifest.json')), /ENOENT/, 'no manifest, so no pre-run gate outcome');
  await assert.rejects(() => harness.prepare(busy, opts), /Refusing to prepare/, 'the next try uses a new, empty directory');
});

// ------------------------------------------------------- session environment and version

test('a Claude Code update stops dispatch before any session runs on the new version; a resume on the prepared version continues (later attempt)', async (t) => {
  const { harness, dir } = await loadHarness(t);
  const versionFile = path.join(dir, 'version');
  await writeFile(versionFile, '2.1.288');
  process.env.MOCK_VERSION_FILE = versionFile;
  const { ctx } = await prepared(harness, dir);
  // Changed before the stage: nothing starts.
  await writeFile(versionFile, '2.1.289');
  await assert.rejects(() => harness.run(ctx), /Claude Code is 2\.1\.289, but this evaluation was prepared with 2\.1\.288/);
  assert.equal((await harness.readLedger(ctx.dir)).filter((record) => record.event === 'start').length, 0);
  // Changed while a session runs: that session finishes on 2.1.288, and no other starts.
  await writeFile(versionFile, '2.1.288');
  process.env.MOCK_DELAY_MS = '600';
  const startedDir = path.join(dir, 'started');
  await mkdir(startedDir, { recursive: true });
  process.env.MOCK_STARTED_DIR = startedDir;
  const running = harness.run({ ...ctx, concurrency: 1 });
  // Wait until the session itself has read its version, not just until it was spawned.
  await until(async () => (await readdir(startedDir)).length > 0, 8000, 'a live session on 2.1.288');
  await writeFile(versionFile, '2.1.289');
  const outcome = await running;
  assert.equal(process.exitCode, 5);
  process.exitCode = 0;
  assert.equal(outcome.version_changed, '2.1.289');
  assert.deepEqual(outcome.deviations, [], 'the finished session ran on the prepared version');
  const ledger = await harness.readLedger(ctx.dir);
  assert.equal(ledger.filter((record) => record.event === 'start').length, 1);
  assert.deepEqual(ledger.filter((record) => record.event === 'stopped').map((record) => [record.reason, record.expected, record.found]), [['claude-version', '2.1.288', '2.1.289']]);
  // Reinstalled: the evaluation resumes, and nothing ran twice.
  await writeFile(versionFile, '2.1.288');
  delete process.env.MOCK_DELAY_MS;
  const resumed = await harness.run(ctx);
  assert.deepEqual(resumed.skipped, []);
  assert.equal((await harness.readLedger(ctx.dir)).filter((record) => record.event === 'finish').length, 18);
});

test('child sessions never inherit the parent Claude Code session or VibeCompass credentials; auth and config pass through (later attempt)', async (t) => {
  const { harness, dir } = await loadHarness(t);
  const { ctx } = await prepared(harness, dir);
  const planted = { CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/socket', CLAUDE_CODE_MESSAGING_TOKEN: 'token', CLAUDE_CODE_SESSION_ID: 'parent', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_EFFORT: 'low', CLAUDECODE: '1', AI_AGENT: 'claude', VIBECOMPASS_SYNC_TOKEN: 'secret', CLAUDE_CONFIG_DIR: '/tmp/claude-config', ANTHROPIC_BASE_URL: 'https://example.invalid' };
  const saved = Object.fromEntries(Object.keys(planted).map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  Object.assign(process.env, planted);
  const dumpDir = path.join(dir, 'env-dump');
  await mkdir(dumpDir, { recursive: true });
  process.env.MOCK_ENV_DUMP_DIR = dumpDir;
  await harness.run({ ...ctx, only: new Set(['r001']) });
  const dumps = await Promise.all((await readdir(dumpDir)).map(async (file) => JSON.parse(await readFile(path.join(dumpDir, file), 'utf8'))));
  assert.ok(dumps.length >= 2, 'the version check and the session both ran');
  for (const names of dumps) {
    for (const dropped of ['CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_EFFORT', 'CLAUDECODE', 'AI_AGENT', 'VIBECOMPASS_SYNC_TOKEN']) assert.ok(!names.includes(dropped), dropped);
    for (const kept of ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL', 'MOCK_ENV_DUMP_DIR', 'PATH']) assert.ok(names.includes(kept), kept);
  }
  assert.deepEqual(Object.keys(harness.childEnv({ CLAUDE_CODE_X: '1', CLAUDE_CONFIG_DIR: 'c', VIBECOMPASS_ROOT: 'r', HOME: 'h' })).sort(), ['CLAUDE_CONFIG_DIR', 'HOME']);
});

// ------------------------------------------------------------- abort handling (S12)

const ALIVE_MS = 3000;
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
async function until(check, ms = 8000, what = 'condition') {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
async function mockPids(pidDir) {
  const files = await readdir(pidDir).catch(() => []);
  return Promise.all(files.map(async (file) => JSON.parse(await readFile(path.join(pidDir, file), 'utf8'))));
}

/** A real harness process (`run`, via `main`) whose children are live mock sessions. */
async function startHarnessProcess(t, dir, mock, ctx, env = {}) {
  const driver = path.join(dir, 'driver.mjs');
  await writeFile(driver, `const { main } = await import(process.env.A7_HARNESS_URL);\nawait main(process.argv.slice(2), { identity: () => ({ package_commit: 'test', package_dirty: '', package_src_tree: 'test' }), graceMs: Number(process.env.A7_GRACE_MS) });\n`);
  const pidDir = path.join(dir, 'pids');
  await mkdir(pidDir, { recursive: true });
  const child = spawn(process.execPath, [driver, 'run', '--out', ctx.dir, '--max-cost-usd', '100', '--concurrency', '2'], {
    env: { ...process.env, A7_CLAUDE_BIN: mock, A7_HARNESS_URL: pathToFileURL(path.join(packageDir, 'scripts', 'evaluate-brief-a7.js')).href, A7_GRACE_MS: '300', MOCK_SCENARIO: 'slow', MOCK_PID_DIR: pidDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    for (const entry of await mockPids(pidDir)) {
      for (const pid of [entry.pid, entry.grandchild]) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // gone
        }
      }
    }
  });
  return { child, exited, pidDir, output: () => output };
}

/** Waits until both sessions are live: spawned in the ledger, pids recorded, and their streams on disk. */
async function twoLiveSessions(harness, ctx, pidDir) {
  await until(async () => (await harness.readLedger(ctx.dir)).filter((record) => record.event === 'spawned').length === 2 && (await mockPids(pidDir)).length === 2, 8000, 'two live sessions');
  const starts = (await harness.readLedger(ctx.dir)).filter((record) => record.event === 'start');
  await until(async () => (await Promise.all(starts.map((record) => stat(record.file).then((info) => info.size > 0, () => false)))).every(Boolean), 4000, 'streams on disk');
  return starts;
}

test('an abort stops dispatch, terminates and awaits live child sessions and their process groups, drains their streams, and keeps estimated costs explicit (S12)', async (t) => {
  const { harness, dir, mock } = await loadHarness(t);
  const { ctx } = await prepared(harness, dir);
  const proc = await startHarnessProcess(t, dir, mock, ctx);
  const starts = await twoLiveSessions(harness, ctx, proc.pidDir);
  const pids = await mockPids(proc.pidDir);
  // A second invocation on the same directory is refused while this one lives.
  await assert.rejects(() => harness.run(ctx), /another harness invocation \(pid \d+\) holds/);

  proc.child.kill('SIGINT');
  const exit = await proc.exited;
  assert.equal(exit.code, 130, proc.output());
  for (const entry of pids) {
    await until(() => !alive(entry.pid) && !alive(entry.grandchild), ALIVE_MS, `pids ${entry.pid}/${entry.grandchild} gone`);
  }
  const ledger = await harness.readLedger(ctx.dir);
  assert.equal(ledger.filter((record) => record.event === 'start').length, 2, 'no session started after the abort');
  const aborted = ledger.filter((record) => record.event === 'aborted');
  assert.deepEqual(aborted.map((record) => record.call).sort(), starts.map((record) => record.call).sort());
  // Each stream holds its usage, so its cost is estimated from it, never zero or missing.
  const expected = (10 + 2000) * 8e-6 + 5000 * 0.2e-6 + 300 * 20e-6;
  for (const record of aborted) {
    assert.equal(record.cost_source, 'estimated');
    assert.ok(Math.abs(record.cost_usd - expected) < 1e-9, String(record.cost_usd));
    assert.equal(record.reason, 'SIGINT');
    const start = starts.find((entry) => entry.call === record.call);
    assert.match(await readFile(start.file, 'utf8'), /"type":"assistant"/, 'the stream was drained to its file');
  }
  const summary = ledger.find((record) => record.event === 'abort');
  assert.deepEqual(summary.terminated.sort(), starts.map((record) => record.call).sort());
  assert.deepEqual(summary.unresolved, []);
  const spend = await harness.ledgerSpend(ctx.dir);
  assert.ok(Math.abs(spend.total - 2 * expected) < 1e-9);
  assert.deepEqual(spend.open, []);
  assert.deepEqual(spend.estimated.sort(), starts.map((record) => record.call).sort());

  // Resume: an aborted evaluated session ends the entry; no paid session starts, for any run (reviewer pass 1, R1).
  delete process.env.MOCK_SCENARIO;
  await assert.rejects(() => harness.run(ctx), /can no longer conform/);
  await assert.rejects(() => harness.grade(ctx), /can no longer conform/, 'grading refuses too');
  assert.equal((await harness.readLedger(ctx.dir)).filter((record) => record.event === 'start').length, 2, 'zero new paid starts');
});

test('a child that ignores SIGTERM is killed after the grace period, and a stream without usage stays unresolved at its reserve (S12)', async (t) => {
  const { harness, dir, mock } = await loadHarness(t);
  const { ctx } = await prepared(harness, dir);
  const proc = await startHarnessProcess(t, dir, mock, ctx, { MOCK_IGNORE_TERM: '1', MOCK_NO_USAGE: '1' });
  await twoLiveSessions(harness, ctx, proc.pidDir);
  const pids = await mockPids(proc.pidDir);
  proc.child.kill('SIGTERM');
  const exit = await proc.exited;
  assert.equal(exit.code, 130, proc.output());
  for (const entry of pids) assert.ok(!alive(entry.pid), `pid ${entry.pid} was awaited before the harness exited`);
  for (const entry of pids) await until(() => !alive(entry.grandchild), ALIVE_MS, `grandchild ${entry.grandchild} gone`);
  const ledger = await harness.readLedger(ctx.dir);
  const aborted = ledger.filter((record) => record.event === 'aborted');
  assert.equal(aborted.length, 2);
  for (const record of aborted) {
    assert.equal(record.cost_source, 'unknown');
    assert.equal(record.exit.signal, 'SIGKILL', 'escalated after the grace period');
  }
  const spend = await harness.ledgerSpend(ctx.dir);
  assert.equal(spend.unresolved.length, 2);
  assert.equal(spend.reserved_unresolved, 3);
  assert.equal(spend.total, 3);
  assert.equal(ledger.find((record) => record.event === 'abort').unresolved.length, 2);
});

test('sessions a killed harness leaves running are terminated and recorded before the next dispatch, and never retried (S12)', async (t) => {
  const { harness, dir, mock } = await loadHarness(t);
  const { ctx } = await prepared(harness, dir);
  const proc = await startHarnessProcess(t, dir, mock, ctx);
  const starts = await twoLiveSessions(harness, ctx, proc.pidDir);
  const pids = await mockPids(proc.pidDir);
  // An uncatchable kill: the harness cannot clean up, and its children survive it (as on 2026-10-03).
  proc.child.kill('SIGKILL');
  await proc.exited;
  await new Promise((resolve) => setTimeout(resolve, 200));
  for (const entry of pids) assert.ok(alive(entry.pid), 'the orphan outlived its harness');
  assert.deepEqual((await harness.ledgerSpend(ctx.dir)).open.sort(), starts.map((record) => record.call).sort());

  delete process.env.MOCK_SCENARIO;
  // The next run terminates and records the orphans first, then refuses: they were aborted evaluated sessions (R1).
  await assert.rejects(() => harness.run(ctx), /can no longer conform[\s\S]*left open by a killed harness/);
  for (const entry of pids) await until(() => !alive(entry.pid) && !alive(entry.grandchild), ALIVE_MS, `orphan ${entry.pid} gone`);
  const recovered = (await harness.readLedger(ctx.dir)).filter((record) => record.event === 'aborted');
  assert.equal(recovered.length, 2);
  for (const record of recovered) {
    assert.equal(record.recovered, true);
    assert.equal(record.reason, 'left running by a killed harness; terminated');
    assert.equal(record.cost_source, 'estimated');
  }
  assert.equal((await harness.readLedger(ctx.dir)).filter((record) => record.event === 'start').length, 2, 'zero new paid starts');
  assert.deepEqual((await harness.ledgerSpend(ctx.dir)).open, []);
});

test('a STOP file stops dispatch gracefully: running sessions finish, nothing is aborted, and a resume continues (S12)', async (t) => {
  const { harness, dir } = await loadHarness(t);
  const { ctx } = await prepared(harness, dir);
  process.env.MOCK_DELAY_MS = '400';
  const running = harness.run({ ...ctx, concurrency: 2 });
  await until(async () => (await harness.readLedger(ctx.dir)).filter((record) => record.event === 'spawned').length === 2, 4000, 'two sessions');
  await writeFile(path.join(ctx.dir, 'STOP'), '');
  const stopped = await running;
  process.exitCode = 0;
  const ledger = await harness.readLedger(ctx.dir);
  assert.equal(ledger.filter((record) => record.event === 'finish').length, 2, 'the running sessions finished');
  assert.equal(ledger.filter((record) => record.event === 'aborted').length, 0);
  assert.equal(stopped.skipped.length, 16);
  await rm(path.join(ctx.dir, 'STOP'));
  delete process.env.MOCK_DELAY_MS;
  const resumed = await harness.run(ctx);
  assert.deepEqual(resumed.skipped, []);
  assert.equal((await harness.readLedger(ctx.dir)).filter((record) => record.event === 'finish').length, 18);
});

test('a run with a deviation stops dispatch; running sessions finish (later attempt: stop as the protocol says)', async (t) => {
  const { harness, dir } = await loadHarness(t);
  const { ctx } = await prepared(harness, dir);
  process.env.MOCK_TOOL_INPUTS = JSON.stringify([{ name: 'Read', input: { file_path: '/etc/hosts' } }]);
  const outcome = await harness.run({ ...ctx, concurrency: 1 });
  assert.equal(process.exitCode, 4);
  process.exitCode = 0;
  assert.deepEqual(outcome.deviations, ['r001']);
  assert.equal(outcome.skipped.length, 17);
  const ledger = await harness.readLedger(ctx.dir);
  assert.deepEqual(ledger.find((record) => record.event === 'stopped').runs, ['r001']);
  assert.equal(ledger.filter((record) => record.event === 'start').length, 1);
  // A resume, with any --only, spends nothing more (reviewer pass 1, R1).
  delete process.env.MOCK_TOOL_INPUTS;
  await assert.rejects(() => harness.run({ ...ctx, only: new Set(['r002']) }), /can no longer conform[\s\S]*a deviation stopped dispatch/);
  // Even when the harness died before it recorded the stop, auditing the finished run finds it.
  const ledgerFile = path.join(ctx.dir, 'ledger.jsonl');
  const lines = (await readFile(ledgerFile, 'utf8')).split('\n').filter((line) => line && !/"event":"(stopped|refused)"/.test(line));
  await writeFile(ledgerFile, `${lines.join('\n')}\n`);
  await assert.rejects(() => harness.run(ctx), /can no longer conform[\s\S]*r001: Read outside the run copy: \/etc\/hosts/);
  await assert.rejects(() => harness.grade(ctx), /can no longer conform/);
  assert.equal((await harness.readLedger(ctx.dir)).filter((record) => record.event === 'start').length, 1, 'zero new paid starts');
});

test('an aborted report turn ends the entry; a deviation in research whose report turn is pending is found before the report turn is paid for (reviewer pass 1, R1)', async (t) => {
  const { harness, dir } = await loadHarness(t);
  const { ctx } = await prepared(harness, dir);
  // r001 stops at the cap; its report turn is live when the abort lands.
  process.env.MOCK_CALLS = '25';
  process.env.MOCK_REPORT_DELAY_MS = '3000';
  const controller = new AbortController();
  const running = harness.run({ ...ctx, concurrency: 1, only: new Set(['r001']), signal: controller.signal });
  await until(async () => (await harness.readLedger(ctx.dir)).some((record) => record.event === 'spawned' && record.call === 'report:r001#1'), 8000, 'a live report turn');
  controller.abort('SIGINT');
  await running;
  process.exitCode = 0;
  assert.ok((await harness.readLedger(ctx.dir)).some((record) => record.event === 'aborted' && record.call === 'report:r001#1'));
  delete process.env.MOCK_REPORT_DELAY_MS;
  const starts = (await harness.readLedger(ctx.dir)).filter((record) => record.event === 'start').length;
  await assert.rejects(() => harness.run(ctx), /can no longer conform[\s\S]*report:r001#1 was aborted/);
  assert.equal((await harness.readLedger(ctx.dir)).filter((record) => record.event === 'start').length, starts, 'zero new paid starts');

  // A second entry: r001's research reads outside the copy and stops at the cap, but the cap cannot fund its report turn.
  const second = { ...ctx, dir: path.join(dir, 'eval-2') };
  const { opts } = await prepared(harness, path.join(dir, 'second'));
  await harness.prepare(second, opts);
  process.env.MOCK_TOOL_INPUTS = JSON.stringify([{ name: 'Read', input: { file_path: '/etc/hosts' } }]);
  const pending = await harness.run({ ...second, cap: 1.51, concurrency: 1, only: new Set(['r001']) });
  process.exitCode = 0;
  assert.deepEqual(pending.deviations, ['r001'], 'audited as soon as its research finished');
  delete process.env.MOCK_TOOL_INPUTS;
  delete process.env.MOCK_CALLS;
  await assert.rejects(() => harness.run({ ...second, cap: 10 }), /can no longer conform/);
  assert.equal(await harness.attemptsOf(second.dir, 'report:r001'), 0, 'its report turn was never paid for');
});

test('capped research is audited before its funded report turn is paid for; valid capped research still gets its report (reviewer pass 2, R4)', async (t) => {
  const { harness, dir } = await loadHarness(t);
  const { ctx, opts } = await prepared(harness, dir);
  process.env.MOCK_CALLS = '25';
  process.env.MOCK_TOOL_INPUTS = JSON.stringify([{ name: 'Read', input: { file_path: '/etc/hosts' } }]);
  const outcome = await harness.run({ ...ctx, cap: 10, concurrency: 1, only: new Set(['r001']) });
  assert.equal(process.exitCode, 4);
  process.exitCode = 0;
  assert.deepEqual(outcome.deviations, ['r001']);
  assert.deepEqual((await harness.readLedger(ctx.dir)).filter((record) => record.event === 'start').map((record) => record.job), ['run:r001'], 'no report turn for research that already deviates');
  // Valid capped research, funded: its report turn runs.
  delete process.env.MOCK_TOOL_INPUTS;
  const valid = { ...ctx, dir: path.join(dir, 'eval-valid') };
  await harness.prepare(valid, opts);
  const clean = await harness.run({ ...valid, cap: 10, concurrency: 1, only: new Set(['r001']) });
  assert.deepEqual(clean.deviations, []);
  assert.deepEqual((await harness.readLedger(valid.dir)).filter((record) => record.event === 'start').map((record) => record.job), ['run:r001', 'report:r001']);
});

test('every finished run is reconciled before the terminal audit, whatever --only selects; a real deviation outside --only still blocks (reviewer pass 2, R5)', async (t) => {
  const { harness, dir } = await loadHarness(t);
  const { ctx, opts } = await prepared(harness, dir);
  await harness.run({ ...ctx, concurrency: 1, only: new Set(['r001']) });
  const base = path.join(ctx.dir, 'transcripts', 'r001');
  // The supported crash window: the finish is in the ledger, the metadata and transcript copies are not.
  await rm(`${base}.meta.json`);
  await rm(`${base}.jsonl`);
  await harness.run({ ...ctx, concurrency: 1, only: new Set(['r002']) });
  assert.equal(await harness.attemptsOf(ctx.dir, 'run:r001'), 1, 'finished research is not retried');
  assert.equal(await harness.attemptsOf(ctx.dir, 'run:r002'), 1, 'the selected run proceeds');
  assert.equal(JSON.parse(await readFile(`${base}.meta.json`, 'utf8')).state, 'complete', 'restored from the ledger');
  // A genuinely inconsistent stream outside --only still stops everything.
  const ledger = await harness.readLedger(ctx.dir);
  const start = ledger.find((record) => record.event === 'start' && record.job === 'run:r001');
  await writeFile(start.file, 'tampered\n');
  await rm(`${base}.meta.json`);
  await assert.rejects(() => harness.run({ ...ctx, only: new Set(['r003']) }), /attempt stream for run:r001 is missing or does not match the ledger/);
  assert.equal(await harness.attemptsOf(ctx.dir, 'run:r003'), 0);
  // And an excluded run with a real deviation blocks all spending, after its metadata is restored.
  const second = { ...ctx, dir: path.join(dir, 'eval-2') };
  await harness.prepare(second, opts);
  process.env.MOCK_TOOL_INPUTS = JSON.stringify([{ name: 'Read', input: { file_path: '/etc/hosts' } }]);
  await harness.run({ ...second, concurrency: 1, only: new Set(['r001']) });
  process.exitCode = 0;
  delete process.env.MOCK_TOOL_INPUTS;
  await rm(path.join(second.dir, 'transcripts', 'r001.meta.json'));
  const ledgerFile = path.join(second.dir, 'ledger.jsonl');
  await writeFile(ledgerFile, `${(await readFile(ledgerFile, 'utf8')).split('\n').filter((line) => line && !line.includes('"event":"stopped"')).join('\n')}\n`);
  await assert.rejects(() => harness.run({ ...second, only: new Set(['r002']) }), /can no longer conform[\s\S]*r001: Read outside the run copy/);
  assert.equal(await harness.attemptsOf(second.dir, 'run:r002'), 0);
});

test('STOP guards every paid session: a capped research session leaves its report turn pending, and a grader does not retry (reviewer pass 1, R2)', async (t) => {
  const { harness, dir } = await loadHarness(t);
  const { ctx } = await prepared(harness, dir);
  process.env.MOCK_CALLS = '25';
  process.env.MOCK_DELAY_MS = '400';
  const running = harness.run({ ...ctx, concurrency: 1, only: new Set(['r001']) });
  await until(async () => (await harness.readLedger(ctx.dir)).some((record) => record.event === 'spawned'), 4000, 'live research');
  await writeFile(path.join(ctx.dir, 'STOP'), '');
  const stopped = await running;
  process.exitCode = 0;
  assert.deepEqual(stopped.skipped, ['r001 (report turn pending)']);
  assert.deepEqual((await harness.readLedger(ctx.dir)).filter((record) => record.event === 'start').map((record) => record.job), ['run:r001'], 'no report turn after STOP');
  // Resumable: after STOP is removed the report turn runs, and research is not repeated.
  await rm(path.join(ctx.dir, 'STOP'));
  delete process.env.MOCK_DELAY_MS;
  await harness.run({ ...ctx, only: new Set(['r001']) });
  assert.deepEqual([await harness.attemptsOf(ctx.dir, 'run:r001'), await harness.attemptsOf(ctx.dir, 'report:r001')], [1, 1]);

  // Grading: an invalid grade would be retried, but not after STOP.
  delete process.env.MOCK_CALLS;
  await harness.run(ctx);
  process.env.MOCK_GRADER = 'invalid';
  process.env.MOCK_GRADER_DELAY_MS = '400';
  const grading = harness.grade({ ...ctx, concurrency: 1, only: new Set(['F5']) });
  await until(async () => (await harness.readLedger(ctx.dir)).some((record) => record.event === 'spawned' && record.call.startsWith('grade:')), 4000, 'a live grader');
  await writeFile(path.join(ctx.dir, 'STOP'), '');
  await grading;
  process.exitCode = 0;
  assert.equal((await harness.readLedger(ctx.dir)).filter((record) => record.event === 'start' && record.kind === 'grader').length, 1, 'no retry and no new job after STOP');
});

test('a recovered attempt keeps the cost its stream reports, zero included; else its usage estimate; else its reserve (reviewer pass 1, R3)', async (t) => {
  const { harness, dir } = await loadHarness(t);
  const stream = async (name, events) => {
    const file = path.join(dir, `${name}.jsonl`);
    await writeFile(file, events.map((event) => `${JSON.stringify(event)}\n`).join(''));
    return file;
  };
  const usage = { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } } };
  const cases = {
    'grade:reported': await stream('reported', [usage, { type: 'result', subtype: 'success', total_cost_usd: 0.75 }]),
    'grade:zero': await stream('zero', [usage, { type: 'result', subtype: 'success', total_cost_usd: 0 }]),
    'grade:partial': await stream('partial', [usage]),
    'grade:empty': await stream('empty', []),
  };
  for (const [job, file] of Object.entries(cases)) await appendFile(path.join(dir, 'ledger.jsonl'), `${JSON.stringify({ event: 'start', call: `${job}#1`, job, kind: 'grader', attempt: 1, reserve_usd: 0.5, file })}\n`);
  await harness.reapOrphans({ dir, quiet: true });
  const recorded = Object.fromEntries((await harness.readLedger(dir)).filter((record) => record.event === 'aborted').map((record) => [record.call, [record.cost_usd, record.cost_source]]));
  assert.deepEqual(recorded, { 'grade:reported#1': [0.75, 'reported'], 'grade:zero#1': [0, 'reported'], 'grade:partial#1': [10 * 8e-6, 'estimated'], 'grade:empty#1': [null, 'unknown'] });
  const spend = await harness.ledgerSpend(dir);
  assert.ok(Math.abs(spend.total - (0.75 + 0 + 10 * 8e-6 + 0.5)) < 1e-12);
  assert.deepEqual(spend.unresolved, ['grade:empty#1']);
  assert.deepEqual(spend.estimated, ['grade:partial#1']);
  // The same order for an attempt still open in the ledger.
  const openDir = path.join(dir, 'open');
  await mkdir(openDir);
  await appendFile(path.join(openDir, 'ledger.jsonl'), `${JSON.stringify({ event: 'start', call: 'grade:x#1', job: 'grade:x', kind: 'grader', attempt: 1, reserve_usd: 0.5, file: cases['grade:reported'] })}\n`);
  assert.equal((await harness.ledgerSpend(openDir)).total, 0.75);
});
