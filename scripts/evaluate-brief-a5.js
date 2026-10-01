#!/usr/bin/env node
// A5 evaluation for the session brief (recall plan task A5; protocol in
// canonical memory at architecture/platform/project-memory/recall-evaluation.md
// › Baseline protocol and Scoring › A5). Development tool; not shipped in the
// npm package.
//
//   node scripts/evaluate-brief-a5.js prepare --corpus <dir> --labels <dir> --out <dir> [--warm-runs 10]
//   node scripts/evaluate-brief-a5.js run     --out <dir> [--concurrency 4] [--only r01,r02]
//   node scripts/evaluate-brief-a5.js grade   --out <dir> [--concurrency 4] [--only F1,T2]
//   node scripts/evaluate-brief-a5.js score   --out <dir>
//
// <corpus> is a read-only export of the frozen corpus with both evaluation
// files and sessions/active/ removed (see evaluate-brief-tuning.js). <labels>
// holds recall-evaluation.md and recall-evaluation-heldout.md as of the tag.
//
// Label isolation: `prepare` and `run` read only each task's Task and Files
// lines. Evaluated agents get the fixed prompt template below with the task
// text and files substituted, nothing else; they run as headless Claude Code
// sessions confined to their run copy (no CLAUDE.md auto-discovery, memory,
// MCP, hooks, settings, network, or tools beyond Read/Grep/Glob). Only `grade`
// reads the labels, and only the graders see them.
//
// Each run gets a fresh copy of the corpus under <out>/runs/rNN (neutral names;
// the task and arm mapping lives in <out>/manifest.json, outside the copies)
// with the protocol's `eval` lane. The brief arm's copy also gets
// sessions/active/eval/brief.md from `vibecompass brief --session eval --write`
// (the lifecycle lane brief, header included), so the agent reads exactly the
// file a live lane would.

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSessionBrief, estimateBriefTokens } from '../src/brief.js';
import { collectDeclaredSuccessors } from '../src/decision-lineage.js';
import { loadProjectReadModel } from '../src/read-model.js';

export const PROMPT_TEMPLATE_VERSION = 'a5-v1';
export const MODEL = 'claude-opus-5-5';
export const EFFORT = 'high';
export const TOOL_CALL_BUDGET = 30;

// The protocol's prompt template (recall-evaluation.md › Baseline protocol),
// followed by the startup read order and the search allowance. The arms differ
// only in the brief read after handoff.md.
const PROMPT_TEMPLATE = [
  'You are starting a builder session in this project-memory root. Task: {task} Files: {files}. Do not write code. Using project memory, produce a context report with four sections: (1) Relevant memory — `path › heading` and why it matters; (2) Facts I will rely on — each with its source passage and its status (current, superseded, partially superseded, or disputed); (3) Conflicts or uncertainty; (4) No governing memory — say so if nothing in memory governs this task.',
  '',
  'Startup read order — read these first, in this order: `CLAUDE.md`, `project.yaml`, the latest finalized session note in `sessions/` (highest date, then highest N), `sessions/active/index.yaml`, `sessions/active/eval/wip.md`, `sessions/active/eval/handoff.md`{brief}. Then read any architecture, decision, or session files you choose.',
  '',
  'Rules: this root is your only source — no code repositories, network, or web. File paths in the task are context for choosing memory, not files to open. Read-only. At most 30 tool calls in total, including the startup reads; every tool invocation counts as one call. Your final message is the context report.',
].join('\n');
const BRIEF_READ = ', then `sessions/active/eval/brief.md` (the lane\'s generated session brief)';

const CLAUDE_ARGS = [
  '-p',
  '--model', MODEL,
  '--effort', EFFORT,
  '--safe-mode',
  '--restricted',
  '--strict-mcp-config',
  '--no-session-persistence',
  '--permission-mode', 'dontAsk',
];
const AGENT_TOOLS = ['--tools', 'Read', 'Grep', 'Glob'];
const GRADER_TOOLS = ['--tools', ''];

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command, ...args] = process.argv.slice(2);
const option = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const outDir = option('--out') ? path.resolve(option('--out')) : null;
const concurrency = Number(option('--concurrency', '4'));
const only = option('--only') ? new Set(option('--only').split(',')) : null;


// ---------------------------------------------------------------- prepare

async function prepare() {
  const corpus = path.resolve(requireOption('--corpus'));
  const labelsDir = path.resolve(requireOption('--labels'));
  const warmRuns = Number(option('--warm-runs', '10'));
  const tasks = [
    ...parseTasks(await readFile(path.join(labelsDir, 'recall-evaluation.md'), 'utf8'), 'tuning'),
    ...parseTasks(await readFile(path.join(labelsDir, 'recall-evaluation-heldout.md'), 'utf8'), 'held-out'),
  ];
  if (tasks.length !== 16) throw new Error(`Expected 16 tasks, found ${tasks.length}.`);
  for (const task of tasks) {
    if (!task.task) throw new Error(`${task.id}: no task text.`);
  }

  await rm(path.join(outDir, 'runs'), { recursive: true, force: true });
  await mkdir(path.join(outDir, 'briefs'), { recursive: true });
  await mkdir(path.join(outDir, 'prompts'), { recursive: true });
  const corpusFiles = await listFiles(corpus);
  const relations = (await loadProjectReadModel(corpus)).decision_lineage.relations;

  // Arms alternate order by task; run ids are assigned in launch order.
  const runs = [];
  tasks.forEach((task, index) => {
    const arms = index % 2 === 0 ? ['baseline', 'brief'] : ['brief', 'baseline'];
    for (const arm of arms) runs.push({ id: `r${String(runs.length + 1).padStart(2, '0')}`, task: task.id, arm, order: runs.length + 1 });
  });

  const briefs = {};
  for (const run of runs) {
    const task = tasks.find((entry) => entry.id === run.task);
    const root = await makeRunCopy(corpus, run.id, task);
    const prompt = renderPrompt(task, run.arm);
    run.root = root;
    run.prompt_sha256 = sha256(prompt);
    await writeFile(path.join(outDir, 'prompts', `${run.id}.txt`), prompt);

    if (run.arm === 'brief') {
      const briefCommand = ['node', 'src/cli.js', 'brief', '--root', root, '--session', 'eval', '--write'];
      const started = process.hrtime.bigint();
      const child = spawnSync(briefCommand[0], briefCommand.slice(1), { cwd: packageDir, encoding: 'utf8' });
      const writeMs = Number(process.hrtime.bigint() - started) / 1e6;
      if (child.status !== 0) throw new Error(`${task.id}: brief --write failed: ${child.stderr}`);
      const json = spawnSync('node', ['src/cli.js', 'brief', '--root', root, '--session', 'eval', '--json'], {
        cwd: packageDir,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      if (json.status !== 0) throw new Error(`${task.id}: brief --json failed: ${json.stderr}`);
      const result = JSON.parse(json.stdout);
      const file = await readFile(path.join(root, 'sessions', 'active', 'eval', 'brief.md'), 'utf8');
      const body = file.replace(/^---\n[\s\S]*?\n---\n/, '');
      const header = file.slice(0, file.length - body.length);
      await writeFile(path.join(outDir, 'briefs', `${task.id}.md`), file);
      await writeFile(path.join(outDir, 'briefs', `${task.id}.json`), `${JSON.stringify(result, null, 2)}\n`);
      briefs[task.id] = {
        run: run.id,
        command: briefCommand.join(' ').replace(root, '<run-copy>'),
        status: result.status,
        status_reason: result.status_reason,
        narrowed: Boolean(result.selection?.narrowed),
        body_matches_json: body === result.markdown,
        body_tokens: result.budget.estimated_tokens,
        whole_file_tokens: estimateBriefTokens(file),
        header_tokens: estimateBriefTokens(header),
        whole_file_bytes: Buffer.byteLength(file),
        budget: result.budget.limit,
        units: result.units.length,
        omitted: result.omitted.length,
        follow_ups: result.follow_ups.length,
        follow_ups_shown: result.render?.follow_ups_shown ?? null,
        lifecycle_write_ms: Math.round(writeMs),
        safe_overflow: safeOverflow(result, relations),
      };
    }

    // The copy must differ from the corpus only by the eval lane (and brief.md).
    const expected = new Set([
      ...corpusFiles,
      'sessions/active/index.yaml',
      'sessions/active/eval/session.yaml',
      'sessions/active/eval/wip.md',
      'sessions/active/eval/handoff.md',
      ...(run.arm === 'brief' ? ['sessions/active/eval/brief.md'] : []),
    ]);
    const actual = await listFiles(root);
    const extra = actual.filter((file) => !expected.has(file));
    const missing = [...expected].filter((file) => !actual.includes(file));
    if (extra.length > 0 || missing.length > 0) {
      throw new Error(`${run.id}: run copy differs from the corpus plus the eval lane: extra ${extra.join(', ') || 'none'}; missing ${missing.join(', ') || 'none'}`);
    }
  }

  const latency = await measureLatency(corpus, tasks, warmRuns);
  const claudeVersion = spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.trim();
  const manifest = {
    prepared_at: new Date().toISOString(),
    package_commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: packageDir, encoding: 'utf8' }).stdout.trim(),
    node: process.version,
    harness: `Claude Code ${claudeVersion} headless (claude ${[...CLAUDE_ARGS, ...AGENT_TOOLS, '--output-format', 'stream-json', '--verbose'].join(' ')}), cwd = run copy, prompt on stdin`,
    grader_harness: `Claude Code ${claudeVersion} headless (claude ${[...CLAUDE_ARGS, '--tools', '""', '--output-format', 'json', '--json-schema', '<schema>'].join(' ')}), empty cwd, prompt on stdin`,
    model: MODEL,
    effort: EFFORT,
    prompt_template_version: PROMPT_TEMPLATE_VERSION,
    prompt_template_sha256: sha256(PROMPT_TEMPLATE + BRIEF_READ),
    prompt_template: PROMPT_TEMPLATE,
    brief_read: BRIEF_READ,
    corpus,
    tasks: tasks.map(({ id, split, task, files }) => ({ id, split, task, files })),
    runs,
    briefs,
    latency,
  };
  await writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Prepared ${runs.length} runs for ${tasks.length} tasks in ${outDir}`);
  for (const [id, brief] of Object.entries(briefs)) {
    console.log(`- ${id}: ${brief.status}${brief.narrowed ? ' (narrow)' : ''}; body ${brief.body_tokens} / whole file ${brief.whole_file_tokens} est. tokens (header ${brief.header_tokens}); safe overflow ${brief.safe_overflow.length === 0 ? 'yes' : brief.safe_overflow.join('; ')}; body = --json ${brief.body_matches_json}`);
  }
  console.log(`Latency: cold CLI first ${latency.cold_first_ms} ms, max ${latency.cold_max_ms} ms; warm p50 max ${latency.warm_p50_max_ms} ms`);
}

function renderPrompt(task, arm) {
  const files = task.files.length > 0 ? task.files.map((file) => `\`${file}\``).join(', ') : 'none';
  const text = /[.?!]$/.test(task.task) ? task.task : `${task.task}.`;
  return PROMPT_TEMPLATE.replace('{task}', text).replace('{files}', files).replace('{brief}', arm === 'brief' ? BRIEF_READ : '');
}

async function makeRunCopy(corpus, runId, task) {
  const root = path.join(outDir, 'runs', runId);
  await cp(corpus, root, { recursive: true });
  const laneDir = path.join(root, 'sessions', 'active', 'eval');
  await mkdir(laneDir, { recursive: true });
  const claimed = task.files.length > 0 ? `claimed_paths:\n${task.files.map((file) => `  - ${JSON.stringify(file)}`).join('\n')}` : 'claimed_paths: []';
  await writeFile(
    path.join(laneDir, 'session.yaml'),
    ['id: eval', 'status: active', 'session_date: 2026-09-30', 'session_number: 1', `working_on: ${JSON.stringify(task.task)}`, 'feature_slugs: []', 'repos: []', claimed, 'architecture_docs: []', 'decision_domain_files: []', ''].join('\n'),
  );
  await writeFile(path.join(laneDir, 'wip.md'), `# WIP — eval\n\nSession lane: eval\n\n## Working on\n${task.task}\n\n## Log\n\n## Reviewer input needed\n\n## Review log\n`);
  await writeFile(
    path.join(laneDir, 'handoff.md'),
    '# Handoff — eval\n\nSession lane: eval\n\n## Builder → Reviewer\n\n### What changed\n\n### What needs review\n\n### What\'s next\n\n## Reviewer → Builder\n\n### Findings summary\n\n### Recommended next step\n',
  );
  await writeFile(path.join(root, 'sessions', 'active', 'index.yaml'), `current: eval\nlanes:\n  - id: eval\n    status: active\n    working_on: ${JSON.stringify(task.task)}\n`);
  return root;
}

/** Cold: a fresh CLI process per task. Warm: the engine in-process, p50 of N runs after one warm-up. */
async function measureLatency(corpus, tasks, warmRuns) {
  const perTask = [];
  for (const task of tasks) {
    const root = await makeRunCopy(corpus, `latency-${task.id}`, task);
    const started = process.hrtime.bigint();
    const child = spawnSync('node', ['src/cli.js', 'brief', '--root', root, '--session', 'eval', '--json'], { cwd: packageDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const coldMs = Number(process.hrtime.bigint() - started) / 1e6;
    if (child.status !== 0) throw new Error(`${task.id}: latency run failed: ${child.stderr}`);
    const warm = [];
    for (let run = 0; run < warmRuns + 1; run += 1) {
      const warmStart = process.hrtime.bigint();
      await buildSessionBrief({ rootDir: root, laneId: 'eval', task: task.task, files: task.files });
      if (run > 0) warm.push(Number(process.hrtime.bigint() - warmStart) / 1e6);
    }
    warm.sort((left, right) => left - right);
    perTask.push({ id: task.id, cold_ms: Math.round(coldMs), warm_p50_ms: Math.round(warm[Math.floor(warm.length / 2)]) });
    await rm(root, { recursive: true, force: true });
  }
  return {
    method: `cold = fresh node process running \`brief --session eval --json\`; warm = buildSessionBrief in-process (read-model load included), p50 of ${warmRuns} runs after one warm-up; OS file cache not flushed`,
    per_task: perTask,
    cold_first_ms: perTask[0].cold_ms,
    cold_max_ms: Math.max(...perTask.map((entry) => entry.cold_ms)),
    warm_p50_max_ms: Math.max(...perTask.map((entry) => entry.warm_p50_ms)),
    warm_p50_median_ms: median(perTask.map((entry) => entry.warm_p50_ms)),
  };
}

/** Status matches the packed contents, no predecessor lacks a successor, size within budget. */
function safeOverflow(result, relations) {
  const problems = [];
  const mandatoryOmitted = result.omitted.some((unit) => unit.tier === 'mandatory');
  const expectedStatus = result.status === 'no-match'
    ? 'no-match'
    : /^retrieval failed/.test(result.status_reason) || mandatoryOmitted
      ? 'incomplete'
      : result.omitted.length > 0
        ? 'partial'
        : 'complete';
  if (result.status !== expectedStatus) problems.push(`status ${result.status}, contents imply ${expectedStatus}`);
  if (result.status === 'no-match' && (result.units.some((unit) => unit.kind !== 'lane') || result.follow_ups.length > 0)) problems.push('no-match with units or follow-ups');
  const emitted = new Set(result.units.filter((unit) => unit.kind === 'lineage').flatMap((unit) => unit.members.map((member) => member.decision_id)));
  for (const id of emitted) {
    for (const successor of collectDeclaredSuccessors(relations, id)) {
      if (!emitted.has(successor.decision_id)) problems.push(`D-${id} without successor D-${successor.decision_id}`);
    }
  }
  if (result.budget.estimated_tokens > result.budget.limit) problems.push('over budget');
  return problems;
}

// -------------------------------------------------------------------- run

async function run() {
  const manifest = await readManifest();
  await mkdir(path.join(outDir, 'transcripts'), { recursive: true });
  const queue = manifest.runs.filter((entry) => !only || only.has(entry.id));
  await pool(queue, concurrency, async (entry) => {
    const prompt = await readFile(path.join(outDir, 'prompts', `${entry.id}.txt`), 'utf8');
    if (sha256(prompt) !== entry.prompt_sha256) throw new Error(`${entry.id}: prompt changed since prepare.`);
    const transcript = path.join(outDir, 'transcripts', `${entry.id}.jsonl`);
    const started = Date.now();
    const output = await spawnClaude([...CLAUDE_ARGS, ...AGENT_TOOLS, '--output-format', 'stream-json', '--verbose'], prompt, entry.root);
    await writeFile(transcript, output.stdout);
    if (output.stderr.trim()) await writeFile(`${transcript}.stderr`, output.stderr);
    const metrics = await auditTranscript(output.stdout, entry.root);
    console.log(`${entry.id} ${entry.task} ${entry.arm}: exit ${output.code}, ${metrics.tool_calls} calls, ${metrics.duration_ms} ms, ~${metrics.tool_result_tokens_est} tokens read${metrics.violations.length > 0 ? `, VIOLATIONS: ${metrics.violations.join('; ')}` : ''} (external ${Date.now() - started} ms)`);
  });
}

/** Tool calls, tokens read, wall time, the final report, and confinement checks from a stream-json transcript. */
async function auditTranscript(stdout, root) {
  const realRoot = await realpath(root);
  const events = stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
  const init = events.find((event) => event.type === 'system' && event.subtype === 'init');
  const result = events.find((event) => event.type === 'result');
  const toolUses = [];
  let resultChars = 0;
  for (const event of events) {
    if (event.type === 'assistant') {
      for (const block of event.message.content) if (block.type === 'tool_use') toolUses.push({ name: block.name, input: block.input });
    } else if (event.type === 'user') {
      for (const block of event.message.content ?? []) {
        if (block?.type !== 'tool_result') continue;
        const text = typeof block.content === 'string' ? block.content : (block.content ?? []).map((part) => part.text ?? '').join('');
        resultChars += [...text].length;
      }
    }
  }
  const violations = [];
  const reads = [];
  for (const use of toolUses) {
    const target = use.input?.file_path ?? use.input?.path ?? null;
    if (use.name === 'Read' && target) reads.push(path.relative(realRoot, await safeRealpath(target)));
    if (target) {
      const resolved = await safeRealpath(path.isAbsolute(target) ? target : path.join(realRoot, target));
      if (resolved !== realRoot && !resolved.startsWith(`${realRoot}${path.sep}`)) violations.push(`${use.name} outside the run copy: ${target}`);
    }
    if (/recall-evaluation/i.test(JSON.stringify(use.input))) violations.push(`${use.name} names an evaluation file`);
  }
  if (!['Read', 'Grep', 'Glob'].includes(init?.tools?.[0]) || init.tools.some((tool) => !['Read', 'Grep', 'Glob'].includes(tool))) violations.push(`unexpected tools ${init?.tools?.join(',')}`);
  if (init?.model !== MODEL) violations.push(`model ${init?.model}`);
  if ((result?.permission_denials ?? []).length > 0) violations.push(`${result.permission_denials.length} permission denials`);
  if (toolUses.length > TOOL_CALL_BUDGET) violations.push(`${toolUses.length} tool calls over the ${TOOL_CALL_BUDGET}-call budget`);
  if (!result || result.is_error || result.subtype !== 'success') violations.push(`run did not complete (${result?.subtype ?? 'no result'})`);
  return {
    model: init?.model ?? null,
    tools: init?.tools ?? [],
    tool_calls: toolUses.length,
    tool_calls_by_name: toolUses.reduce((counts, use) => ({ ...counts, [use.name]: (counts[use.name] ?? 0) + 1 }), {}),
    reads,
    tool_result_chars: resultChars,
    tool_result_tokens_est: Math.ceil(resultChars / 4),
    duration_ms: result?.duration_ms ?? null,
    num_turns: result?.num_turns ?? null,
    usage: result?.usage
      ? {
          input_tokens: result.usage.input_tokens,
          cache_creation_input_tokens: result.usage.cache_creation_input_tokens,
          cache_read_input_tokens: result.usage.cache_read_input_tokens,
          output_tokens: result.usage.output_tokens,
        }
      : null,
    cost_usd: result?.total_cost_usd ?? null,
    report: result?.result ?? '',
    violations,
  };
}

// ------------------------------------------------------------------ grade

async function grade() {
  const manifest = await readManifest();
  const labelsDir = path.join(outDir, 'labels');
  const labels = [
    ...parseLabels(await readFile(path.join(labelsDir, 'recall-evaluation.md'), 'utf8')),
    ...parseLabels(await readFile(path.join(labelsDir, 'recall-evaluation-heldout.md'), 'utf8')),
  ];
  const gradingDir = path.join(outDir, 'grading');
  const workDir = path.join(gradingDir, 'empty-cwd');
  await mkdir(workDir, { recursive: true });

  const jobs = [];
  for (const task of manifest.tasks) {
    if (only && !only.has(task.id)) continue;
    const label = labels.find((entry) => entry.id === task.id);
    if (!label) throw new Error(`${task.id}: no label block.`);
    const reports = {};
    for (const arm of ['baseline', 'brief']) {
      const entry = manifest.runs.find((runEntry) => runEntry.task === task.id && runEntry.arm === arm);
      const metrics = await auditTranscript(await readFile(path.join(outDir, 'transcripts', `${entry.id}.jsonl`), 'utf8'), entry.root);
      reports[arm] = metrics.report;
    }
    // Blind order and neutral names; brief paths are redacted where they would name the arm.
    const swap = Number.parseInt(sha256(`a5-blind:${task.id}`).slice(0, 2), 16) % 2 === 1;
    const order = swap ? { P: 'brief', Q: 'baseline' } : { P: 'baseline', Q: 'brief' };
    const redactions = {};
    const redacted = Object.fromEntries(
      Object.entries(order).map(([name, arm]) => {
        const { text, count } = redactArm(reports[arm]);
        redactions[name] = count;
        return [name, text];
      }),
    );
    jobs.push({ kind: 'reports', task, label, order, redactions, prompt: reportGraderPrompt(label, redacted) });
    const brief = await readFile(path.join(outDir, 'briefs', `${task.id}.md`), 'utf8');
    jobs.push({ kind: 'brief', task, label, prompt: briefGraderPrompt(label, brief) });
  }

  await pool(jobs, concurrency, async (job) => {
    const schema = job.kind === 'reports' ? reportSchema(job.label) : briefSchema(job.label);
    const name = `${job.task.id}-${job.kind}`;
    await writeFile(path.join(gradingDir, `${name}.prompt.txt`), job.prompt);
    const output = await spawnClaude([...CLAUDE_ARGS, ...GRADER_TOOLS, '--output-format', 'json', '--json-schema', JSON.stringify(schema)], job.prompt, workDir);
    let parsed = null;
    try {
      parsed = JSON.parse(output.stdout);
    } catch {
      throw new Error(`${name}: grader output is not JSON: ${output.stdout.slice(0, 400)} ${output.stderr.slice(0, 400)}`);
    }
    const graded = parsed.structured_output ?? null;
    if (!graded) throw new Error(`${name}: grader returned no structured output: ${parsed.result?.slice(0, 400)}`);
    await writeFile(
      path.join(gradingDir, `${name}.json`),
      `${JSON.stringify({ task: job.task.id, kind: job.kind, order: job.order ?? null, redactions: job.redactions ?? null, model: Object.keys(parsed.modelUsage ?? {}), duration_ms: parsed.duration_ms, graded }, null, 2)}\n`,
    );
    console.log(`graded ${name} (${parsed.duration_ms} ms)`);
  });
}

function redactArm(text) {
  let count = 0;
  const redacted = text.replace(/(?:sessions\/active\/eval\/)?brief\.md/g, () => {
    count += 1;
    return '[lane startup file]';
  });
  return { text: redacted, count };
}

const REPORT_RUBRIC = [
  'You are grading two context reports that coding agents wrote for the same task, against a fixed label from an evaluation set. You see only the label and the two reports. Grade each report on its own text; do not let one report change how you read the other.',
  '',
  'Rules (from the evaluation protocol):',
  '- Must-have clauses. For each clause in the checklist, `stated` is true only when the report states that fact correctly; a paraphrase counts, a vaguer, partial, or wrong statement does not. `attributed` is true only when the report ties that stated fact to one of the label\'s expected passages or acceptable alternatives (its path, path › heading, or D-number). `attributed` is false whenever `stated` is false.',
  '- Forbidden authority claims. A report violates a forbidden claim when it asserts that claim as current. Quoting or mentioning it while marking it superseded, stale, or not current does not violate.',
  '- No governing memory. `states_no_governing_memory` is true when the report says that no decision or architecture doc governs the request, false when it presents some memory as governing it.',
  '- Evidence. Give a short verbatim quote from the report (at most 200 characters) for every clause marked stated and every violation; use an empty string otherwise.',
  '- A placeholder "[lane startup file]" replaces a file name in the reports; ignore it.',
].join('\n');

function reportGraderPrompt(label, reports) {
  return [
    REPORT_RUBRIC,
    '',
    'Label:',
    '<<<',
    label.block,
    '>>>',
    '',
    `Checklist (grade exactly these clauses for each report): ${label.clauses.length > 0 ? label.clauses.map((clause) => `${clause.item}${clause.clause === '-' ? '' : `(${clause.clause})`}`).join(', ') : 'none (no-match task)'}`,
    `Forbidden claims to check: ${label.forbidden.join(', ')}`,
    '',
    'Report P:',
    '<<<',
    reports.P,
    '>>>',
    '',
    'Report Q:',
    '<<<',
    reports.Q,
    '>>>',
  ].join('\n');
}

const BRIEF_RUBRIC = [
  'You are grading a generated session brief against a fixed label from an evaluation set. You see only the label and the brief (its YAML header and body). The brief selects project memory for a coding agent; it quotes passages from decisions and docs and lists follow-up reads.',
  '',
  'Rules (from the evaluation protocol):',
  '- A statement violates a forbidden claim when it asserts that claim as current; quoting it while marking it superseded or stale does not.',
  '- A brief also violates one when it emits a predecessor decision unit without its declared successors.',
  '- Listing a path as a follow-up read never violates.',
  '- Judge the brief\'s own text. A decision passage quoted inside a decision unit is the decision\'s recorded text, not the brief\'s assertion, unless the brief presents it as governing or current; a decision shown together with its declared superseding or amending successor is not presented as current.',
  '- For a no-match label, also say whether the brief presents any decision or doc as governing, planning, or authorizing the task.',
  '- Evidence: a short verbatim quote (at most 200 characters) for every violation, and for the closest call.',
].join('\n');

function briefGraderPrompt(label, brief) {
  return [BRIEF_RUBRIC, '', 'Label:', '<<<', label.block, '>>>', '', `Forbidden claims to check: ${label.forbidden.join(', ')}`, '', 'Brief:', '<<<', brief, '>>>'].join('\n');
}

function reportSchema(label) {
  const report = {
    type: 'object',
    properties: {
      clauses: {
        type: 'array',
        items: {
          type: 'object',
          properties: { item: { type: 'string' }, clause: { type: 'string' }, stated: { type: 'boolean' }, attributed: { type: 'boolean' }, evidence: { type: 'string' } },
          required: ['item', 'clause', 'stated', 'attributed', 'evidence'],
          additionalProperties: false,
        },
      },
      forbidden: forbiddenSchema(),
      states_no_governing_memory: { type: 'boolean' },
      notes: { type: 'string' },
    },
    required: ['clauses', 'forbidden', 'states_no_governing_memory', 'notes'],
    additionalProperties: false,
  };
  return { type: 'object', properties: { P: report, Q: report }, required: ['P', 'Q'], additionalProperties: false, description: `clause values: ${label.clauses.map((clause) => `${clause.item}:${clause.clause}`).join(' ') || 'none'}` };
}

function briefSchema() {
  return {
    type: 'object',
    properties: {
      forbidden: forbiddenSchema(),
      presents_governing_memory_for_no_match: { type: 'boolean' },
      closest_call: { type: 'string' },
      notes: { type: 'string' },
    },
    required: ['forbidden', 'presents_governing_memory_for_no_match', 'closest_call', 'notes'],
    additionalProperties: false,
  };
}

function forbiddenSchema() {
  return {
    type: 'array',
    items: {
      type: 'object',
      properties: { id: { type: 'string' }, violated: { type: 'boolean' }, evidence: { type: 'string' }, reasoning: { type: 'string' } },
      required: ['id', 'violated', 'evidence', 'reasoning'],
      additionalProperties: false,
    },
  };
}

// ------------------------------------------------------------------ score

async function score() {
  const manifest = await readManifest();
  const labels = [
    ...parseLabels(await readFile(path.join(outDir, 'labels', 'recall-evaluation.md'), 'utf8')),
    ...parseLabels(await readFile(path.join(outDir, 'labels', 'recall-evaluation-heldout.md'), 'utf8')),
  ];
  const rows = [];
  for (const task of manifest.tasks) {
    const label = labels.find((entry) => entry.id === task.id);
    const reportGrade = JSON.parse(await readFile(path.join(outDir, 'grading', `${task.id}-reports.json`), 'utf8'));
    const briefGrade = JSON.parse(await readFile(path.join(outDir, 'grading', `${task.id}-brief.json`), 'utf8'));
    const arms = {};
    for (const arm of ['baseline', 'brief']) {
      const entry = manifest.runs.find((runEntry) => runEntry.task === task.id && runEntry.arm === arm);
      const metrics = await auditTranscript(await readFile(path.join(outDir, 'transcripts', `${entry.id}.jsonl`), 'utf8'), entry.root);
      const name = Object.entries(reportGrade.order).find(([, value]) => value === arm)[0];
      const graded = reportGrade.graded[name];
      const clauseMap = gradedClauseMap(label, graded.clauses);
      const missingClauses = label.clauses.filter((clause) => !clauseMap.has(`${clause.item}:${clause.clause}`)).map((clause) => `${clause.item}:${clause.clause}`);
      arms[arm] = {
        run: entry.id,
        metrics: { ...metrics, report: undefined },
        clauses: label.clauses.map((clause) => ({ ...clause, ...(clauseMap.get(`${clause.item}:${clause.clause}`) ?? { stated: false, attributed: false, evidence: '' }) })),
        missing_clauses: missingClauses,
        items: scoreItems(label, clauseMap),
        forbidden: graded.forbidden,
        report_violations: graded.forbidden.filter((entry) => entry.violated).map((entry) => entry.id),
        states_no_governing_memory: graded.states_no_governing_memory,
        notes: graded.notes,
      };
    }
    const lost = label.clauses
      .filter((clause) => arms.baseline.clauses.find((entry) => entry.item === clause.item && entry.clause === clause.clause).stated)
      .filter((clause) => !arms.brief.clauses.find((entry) => entry.item === clause.item && entry.clause === clause.clause).stated)
      .map((clause) => `${clause.item}${clause.clause === '-' ? '' : `(${clause.clause})`}`);
    rows.push({
      id: task.id,
      split: task.split,
      positive: label.clauses.length > 0,
      arms,
      lost,
      brief: manifest.briefs[task.id],
      brief_grade: briefGrade.graded,
      brief_violations: briefGrade.graded.forbidden.filter((entry) => entry.violated).map((entry) => entry.id),
    });
  }
  const summary = summarize(rows, manifest);
  await writeFile(path.join(outDir, 'results.json'), `${JSON.stringify({ summary, rows }, null, 2)}\n`);
  await writeFile(path.join(outDir, 'report.md'), renderReport(summary, rows, manifest));
  console.log(renderReport(summary, rows, manifest));
}

/**
 * Grader clauses keyed like the label (`M1:a`). Letters are normalized ("(a)",
 * "A"), and a single-clause item (`-`) takes the grader's entry for that item
 * whatever clause value it used.
 */
function gradedClauseMap(label, clauses) {
  const map = new Map();
  for (const expected of label.clauses) {
    const matches = clauses.filter((clause) => clause.item.trim().toUpperCase() === expected.item);
    const match = expected.clause === '-'
      ? matches[0]
      : matches.find((clause) => clause.clause.replace(/[^a-z]/gi, '').toLowerCase() === expected.clause);
    if (match) map.set(`${expected.item}:${expected.clause}`, match);
  }
  return map;
}

/**
 * Item score (recall-evaluation.md › Scoring › A5): 1 when all clauses are
 * stated, 0.5 when some are, 0 when none, times 1 when every stated clause is
 * attributed and 0.5 otherwise. Sourced counts only attributed clauses as
 * stated; unweighted counts every stated clause and drops the multiplier.
 */
function scoreItems(label, clauseMap) {
  const items = [...new Set(label.clauses.map((clause) => clause.item))];
  return items.map((item) => {
    const clauses = label.clauses.filter((clause) => clause.item === item).map((clause) => clauseMap.get(`${clause.item}:${clause.clause}`) ?? { stated: false, attributed: false });
    const stated = clauses.filter((clause) => clause.stated);
    const sourced = clauses.filter((clause) => clause.stated && clause.attributed);
    const fraction = (count) => (count === clauses.length ? 1 : count > 0 ? 0.5 : 0);
    return {
      item,
      clauses: clauses.length,
      stated: stated.length,
      attributed: sourced.length,
      score: fraction(stated.length) * (stated.every((clause) => clause.attributed) ? 1 : 0.5),
      sourced: fraction(sourced.length),
      unweighted: fraction(stated.length),
    };
  });
}

function summarize(rows, manifest) {
  const mean = (values) => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);
  const recall = (subset, arm, key) => ({
    macro: mean(subset.map((row) => mean(row.arms[arm].items.map((item) => item[key])))),
    micro: mean(subset.flatMap((row) => row.arms[arm].items.map((item) => item[key]))),
  });
  const positives = { tuning: rows.filter((row) => row.positive && row.split === 'tuning'), heldout: rows.filter((row) => row.positive && row.split !== 'tuning') };
  const noMatch = rows.filter((row) => !row.positive);
  const result = { recall: {}, no_match: {}, gates: {} };
  for (const [split, subset] of Object.entries(positives)) {
    result.recall[split] = {};
    for (const arm of ['baseline', 'brief']) {
      result.recall[split][arm] = { score: recall(subset, arm, 'score'), sourced: recall(subset, arm, 'sourced'), unweighted: recall(subset, arm, 'unweighted') };
    }
  }
  for (const arm of ['baseline', 'brief']) {
    const correct = noMatch.filter((row) => row.arms[arm].states_no_governing_memory && (arm === 'baseline' || row.brief.status === 'no-match'));
    result.no_match[arm] = { correct: correct.map((row) => row.id), total: noMatch.length };
  }
  result.no_match.report_only_brief_arm = noMatch.filter((row) => row.arms.brief.states_no_governing_memory).map((row) => row.id);
  result.no_match.brief_status = Object.fromEntries(noMatch.map((row) => [row.id, row.brief.status]));
  const briefViolations = rows.filter((row) => row.brief_violations.length > 0).map((row) => `${row.id}: ${row.brief_violations.join(', ')}`);
  const unsafe = rows.filter((row) => row.brief.safe_overflow.length > 0).map((row) => `${row.id}: ${row.brief.safe_overflow.join('; ')}`);
  const runViolations = rows.flatMap((row) => ['baseline', 'brief'].filter((arm) => row.arms[arm].metrics.violations.length > 0).map((arm) => `${row.id} ${arm}: ${row.arms[arm].metrics.violations.join('; ')}`));
  result.gates = {
    brief_forbidden_claims: { pass: briefViolations.length === 0, findings: briefViolations },
    safe_overflow_and_status: { pass: unsafe.length === 0, findings: unsafe },
    report_forbidden_claims: Object.fromEntries(['baseline', 'brief'].map((arm) => [arm, rows.filter((row) => row.arms[arm].report_violations.length > 0).map((row) => `${row.id}: ${row.arms[arm].report_violations.join(', ')}`)])),
    tuning_recall: { target: 0.8, value: result.recall.tuning.brief.score.macro, pass: result.recall.tuning.brief.score.macro >= 0.8 },
    heldout_recall: { target: 0.75, value: result.recall.heldout.brief.score.macro, pass: result.recall.heldout.brief.score.macro >= 0.75, per_task: Object.fromEntries(positives.heldout.map((row) => [row.id, mean(row.arms.brief.items.map((item) => item.score))])) },
    no_regression: { pass: rows.every((row) => row.lost.length === 0), lost: rows.filter((row) => row.lost.length > 0).map((row) => `${row.id}: ${row.lost.join(', ')}`) },
    latency: { warm_p50_max_ms: manifest.latency.warm_p50_max_ms, cold_max_ms: manifest.latency.cold_max_ms, pass: manifest.latency.warm_p50_max_ms <= 300 && manifest.latency.cold_max_ms <= 1500 },
    run_protocol: { pass: runViolations.length === 0, findings: runViolations },
  };
  return result;
}

function renderReport(summary, rows, manifest) {
  const f2 = (value) => (value === null || value === undefined ? '—' : value.toFixed(3));
  const lines = [];
  lines.push(`# A5 results (${manifest.prompt_template_version}, ${manifest.model}, effort ${manifest.effort})`, '');
  lines.push(`Harness: ${manifest.harness}`, `Package: ${manifest.package_commit}; Node ${manifest.node}`, '');
  lines.push('| Task | Split | Arm | Item scores | Recall | Sourced | Unweighted | Lost clauses | Report X | Tool calls | Tokens read (est.) | Wall s | Brief status / body / whole file | Brief X |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const row of rows) {
    for (const arm of ['baseline', 'brief']) {
      const data = row.arms[arm];
      const mean = (key) => (data.items.length === 0 ? null : data.items.reduce((sum, item) => sum + item[key], 0) / data.items.length);
      const items = data.items.length === 0 ? (data.states_no_governing_memory ? 'no governing memory stated' : 'governing memory claimed') : data.items.map((item) => `${item.item} ${item.score}`).join(' · ');
      lines.push(
        `| ${row.id} | ${row.split} | ${arm} | ${items} | ${f2(mean('score'))} | ${f2(mean('sourced'))} | ${f2(mean('unweighted'))} | ${arm === 'brief' ? row.lost.join(', ') || 'none' : '—'} | ${data.report_violations.join(', ') || 'none'} | ${data.metrics.tool_calls} | ${data.metrics.tool_result_tokens_est} | ${(data.metrics.duration_ms / 1000).toFixed(0)} | ${arm === 'brief' ? `${row.brief.status}${row.brief.narrowed ? ' (narrow)' : ''} / ${row.brief.body_tokens} / ${row.brief.whole_file_tokens}` : '—'} | ${arm === 'brief' ? row.brief_violations.join(', ') || 'none' : '—'} |`,
      );
    }
  }
  lines.push('');
  for (const split of ['tuning', 'heldout']) {
    for (const arm of ['baseline', 'brief']) {
      const data = summary.recall[split][arm];
      lines.push(`- ${split} positives, ${arm}: recall macro ${f2(data.score.macro)} (micro ${f2(data.score.micro)}); sourced macro ${f2(data.sourced.macro)}; unweighted macro ${f2(data.unweighted.macro)}`);
    }
  }
  lines.push(`- No-match: baseline ${summary.no_match.baseline.correct.length}/${summary.no_match.baseline.total} (${summary.no_match.baseline.correct.join(', ') || 'none'}); brief arm ${summary.no_match.brief.correct.length}/${summary.no_match.brief.total} (${summary.no_match.brief.correct.join(', ') || 'none'}); brief statuses ${JSON.stringify(summary.no_match.brief_status)}`);
  lines.push('', '## Gates', '```json', JSON.stringify(summary.gates, null, 2), '```');
  return `${lines.join('\n')}\n`;
}

// ----------------------------------------------------------------- shared

function parseTasks(markdown, split) {
  return [...markdown.matchAll(/^#### ([FTCN]\d+) — [^\n]*· ([a-z-]+)\s*\n([\s\S]*?)(?=^#{2,4} |(?![\s\S]))/gm)]
    .filter((match) => (split === 'tuning' ? match[2] === 'tuning' : match[2] !== 'tuning'))
    .map((match) => {
      const body = match[3];
      const filesLine = body.match(/^- \*\*Files:\*\* (.+)$/m)?.[1] ?? '';
      return {
        id: match[1],
        split,
        task: body.match(/^- \*\*Task:\*\* (.+)$/m)?.[1]?.trim(),
        files: [...filesLine.matchAll(/`([^`]+)`/g)].map((file) => file[1]),
      };
    });
}

/** Grading only: the whole label block, its lettered must-have clauses, and its forbidden-claim IDs. */
function parseLabels(markdown) {
  return [...markdown.matchAll(/^(#### ([FTCN]\d+) — [^\n]*)\n([\s\S]*?)(?=^#{2,4} |(?![\s\S]))/gm)].map((match) => {
    const block = `${match[1]}\n${match[3]}`.trim();
    const section = (title) => {
      const start = block.indexOf(`- **${title}`);
      if (start === -1) return '';
      const rest = block.slice(start).split('\n').slice(1);
      const end = rest.findIndex((line) => /^- \*\*/.test(line));
      return (end === -1 ? rest : rest.slice(0, end)).join('\n');
    };
    const clauses = [];
    for (const line of section('Must-have facts:').split('\n')) {
      const item = line.match(/^\s+- (M\d+) (.*)$/);
      if (!item) continue;
      const letters = [...item[2].matchAll(/(?:^|\s)\(([a-z])\)\s/g)].map((letter) => letter[1]);
      for (const letter of letters.length > 0 ? letters : ['-']) clauses.push({ item: item[1], clause: letter });
    }
    const forbidden = [...section('Forbidden authority claims:').matchAll(/^\s+- (X\d+) /gm)].map((entry) => entry[1]);
    return { id: match[2], block, clauses, forbidden };
  });
}

function spawnClaude(claudeArgs, prompt, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', claudeArgs, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(prompt);
  });
}

async function pool(items, size, worker) {
  const queue = [...items];
  const failures = [];
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        try {
          await worker(item);
        } catch (error) {
          failures.push(error);
          console.error(error.message);
        }
      }
    }),
  );
  if (failures.length > 0) throw new Error(`${failures.length} job(s) failed.`);
}

async function listFiles(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(root, relative)));
    else files.push(relative);
  }
  return files.sort();
}

async function safeRealpath(target) {
  try {
    return await realpath(target);
  } catch {
    return path.resolve(target);
  }
}

async function readManifest() {
  return JSON.parse(await readFile(path.join(outDir, 'manifest.json'), 'utf8'));
}

function requireOption(name) {
  const value = option(name);
  if (!value) throw new Error(`${command} requires ${name}.`);
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

// Dispatch last, so every module-level constant above is initialized.
const commands = { prepare, run, grade, score };
if (!commands[command] || !outDir) {
  console.error('Usage: node scripts/evaluate-brief-a5.js <prepare|run|grade|score> --out <dir> [...]');
  process.exit(2);
}
await commands[command]();
