#!/usr/bin/env node
// A7 evaluation for the session brief (recall plan task A7; protocol
// pre-registered in canonical memory at
// architecture/platform/project-memory/recall-evaluation.md › A7 protocol).
// Development tool; not shipped in the npm package.
//
//   node scripts/evaluate-brief-a7.js prepare --corpus <dir> --labels <dir> --heldout-sha256 <hex> --out <dir> [--replicates 3] [--warm-runs 10]
//   node scripts/evaluate-brief-a7.js run     --out <dir> [--concurrency 4] [--only r001,r002]
//   node scripts/evaluate-brief-a7.js grade   --out <dir> [--concurrency 4] [--only F1,T2]
//   node scripts/evaluate-brief-a7.js score   --out <dir>
//   node scripts/evaluate-brief-a7.js smoke   --corpus <dir> --labels <dir> --out <dir> --task <id> [--cap 3]
//
// What A7 changes from A5 (scripts/evaluate-brief-a5.js):
// - Startup order is enforced by construction: the harness reads the
//   prescribed startup files from the run copy and supplies them in the
//   prompt, in order, identically to both arms (the brief arm adds the lane
//   brief.md after handoff.md). No startup read costs a tool call.
// - The tool-call allowance is enforced, not audited: the harness counts
//   tool calls in the live stream and stops the session when the agent
//   issues call TOOL_CALL_CAP + 1, before that call's result can reach the
//   model. A stopped run then gets one report turn in a fresh session with no
//   tools, given the original prompt and the agent's own transcript of the
//   first TOOL_CALL_CAP calls. Results of calls beyond the cap are never shown.
// - Run-to-run noise: every task × arm runs REPLICATES times on fresh copies.
// - Grader noise: every report pair and every brief is graded by two
//   independent graders (the second sees the reports in reversed order); a
//   verdict on which they disagree goes to a third grader, and the majority
//   stands. Agreement is reported.
//
// Isolation is A5's: headless Claude Code (`claude -p`) with --safe-mode,
// --restricted, Read/Grep/Glob only, --strict-mcp-config, --permission-mode
// dontAsk, --no-session-persistence; cwd = the run copy; no CLAUDE.md
// auto-discovery, memory, MCP, hooks, settings, network, or command tools.
//
// Label isolation: `prepare` and `run` read only each task's Task and Files
// lines. Only `grade` and `score` read labels, and only graders see them.

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSessionBrief, estimateBriefTokens } from '../src/brief.js';
import { collectDeclaredSuccessors } from '../src/decision-lineage.js';
import { loadProjectReadModel } from '../src/read-model.js';

export const PROMPT_TEMPLATE_VERSION = 'a7-v1';
export const MODEL = 'claude-opus-5-5';
export const EFFORT = 'high';
// A5's allowance was 30 calls including the six prescribed startup reads; the
// harness now supplies those, so the search allowance is the remaining 24.
export const TOOL_CALL_CAP = 24;
export const DEFAULT_REPLICATES = 3;
const LANE_SESSION_DATE = '2026-10-02';

const PROMPT_TEMPLATE = [
  'You are starting a builder session in this project-memory root. Task: {task} Files: {files}. Do not write code. Using project memory, produce a context report with four sections: (1) Relevant memory — `path › heading` and why it matters; (2) Facts I will rely on — each with its source passage and its status (current, superseded, partially superseded, or disputed); (3) Conflicts or uncertainty; (4) No governing memory — say so if nothing in memory governs this task.',
  '',
  'Startup files: the startup read order is already done for you. The files below are the prescribed startup reads, in order, with their full contents. Then read any architecture, decision, or session files you choose.',
  '',
  '{startup}',
  '',
  `Rules: this root is your only source — no code repositories, network, or web. File paths in the task are context for choosing memory, not files to open. Read-only. You may make at most ${TOOL_CALL_CAP} tool calls; every tool invocation counts as one call. The harness enforces this: a call beyond ${TOOL_CALL_CAP} is not run, the session stops, and you then write the report from what you have read. Your final message is the context report.`,
].join('\n');

const REPORT_TURN_TEMPLATE = [
  '{prompt}',
  '',
  `Your research so far — your own messages, your ${TOOL_CALL_CAP} tool calls, and their results, in order:`,
  '',
  '{transcript}',
  '',
  `Your ${TOOL_CALL_CAP}-call allowance is used up and no tools are available. Write the final context report now, in the four required sections, from what you have read.`,
].join('\n');

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
const NO_TOOLS = ['--tools', ''];
const STREAM = ['--output-format', 'stream-json', '--verbose'];

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
  const heldoutSha = requireOption('--heldout-sha256');
  const replicates = Number(option('--replicates', String(DEFAULT_REPLICATES)));
  const warmRuns = Number(option('--warm-runs', '10'));
  if (!Number.isInteger(replicates) || replicates < 1) throw new Error('--replicates must be a positive integer.');

  const heldoutText = await readFile(path.join(labelsDir, 'recall-evaluation-heldout-v2.md'), 'utf8');
  if (sha256(heldoutText) !== heldoutSha) throw new Error('recall-evaluation-heldout-v2.md does not match --heldout-sha256; the held-out set changed since its handback.');
  const tasks = [...parseTasks(await readFile(path.join(labelsDir, 'recall-evaluation.md'), 'utf8'), 'tuning'), ...parseTasks(heldoutText, 'held-out')];
  if (tasks.length !== 20) throw new Error(`Expected 20 tasks (12 tuning, 8 held-out), found ${tasks.length}.`);
  for (const task of tasks) if (!task.task) throw new Error(`${task.id}: no task text.`);

  await rm(path.join(outDir, 'runs'), { recursive: true, force: true });
  await mkdir(path.join(outDir, 'briefs'), { recursive: true });
  await mkdir(path.join(outDir, 'prompts'), { recursive: true });
  const corpusFiles = await listFiles(corpus);
  const relations = (await loadProjectReadModel(corpus)).decision_lineage.relations;

  // Arms alternate by task and replicate; run ids follow launch order.
  const runs = [];
  tasks.forEach((task, taskIndex) => {
    for (let replicate = 1; replicate <= replicates; replicate += 1) {
      const arms = (taskIndex + replicate) % 2 === 1 ? ['baseline', 'brief'] : ['brief', 'baseline'];
      for (const arm of arms) runs.push({ id: `r${String(runs.length + 1).padStart(3, '0')}`, task: task.id, arm, replicate, order: runs.length + 1 });
    }
  });

  const briefs = {};
  for (const entry of runs) {
    const task = tasks.find((candidate) => candidate.id === entry.task);
    const root = await makeRunCopy(corpus, path.join(outDir, 'runs', entry.id), task);
    entry.root = root;

    if (entry.arm === 'brief') {
      const brief = await writeLaneBrief(root, task, relations);
      const body = brief.file.replace(/^---\n[\s\S]*?\n---\n/, '');
      if (!briefs[task.id]) {
        await writeFile(path.join(outDir, 'briefs', `${task.id}.md`), brief.file);
        await writeFile(path.join(outDir, 'briefs', `${task.id}.json`), `${JSON.stringify(brief.result, null, 2)}\n`);
        briefs[task.id] = { ...brief.summary, body_sha256: sha256(body), replicate_bodies_identical: true };
      } else if (briefs[task.id].body_sha256 !== sha256(body)) {
        briefs[task.id].replicate_bodies_identical = false;
      }
    }

    const startup = await readStartupFiles(root, entry.arm);
    const prompt = renderPrompt(task, startup);
    entry.startup_files = startup.map((file) => ({ path: file.path, sha256: sha256(file.content) }));
    entry.prompt_sha256 = sha256(prompt);
    await writeFile(path.join(outDir, 'prompts', `${entry.id}.txt`), prompt);

    // The copy must differ from the corpus only by the eval lane (and brief.md).
    const expected = new Set([...corpusFiles, ...LANE_FILES, ...(entry.arm === 'brief' ? ['sessions/active/eval/brief.md'] : [])]);
    const actual = await listFiles(root);
    const extra = actual.filter((file) => !expected.has(file));
    const missing = [...expected].filter((file) => !actual.includes(file));
    if (extra.length > 0 || missing.length > 0) {
      throw new Error(`${entry.id}: run copy differs from the corpus plus the eval lane: extra ${extra.join(', ') || 'none'}; missing ${missing.join(', ') || 'none'}`);
    }
  }

  const latency = await measureLatency(corpus, tasks, warmRuns);
  const claudeVersion = spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.trim();
  const manifest = {
    prepared_at: new Date().toISOString(),
    package_commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: packageDir, encoding: 'utf8' }).stdout.trim(),
    package_dirty: spawnSync('git', ['status', '--porcelain', '--', 'src'], { cwd: packageDir, encoding: 'utf8' }).stdout.trim() !== '',
    node: process.version,
    claude_version: claudeVersion,
    harness: `Claude Code ${claudeVersion} headless (claude ${[...CLAUDE_ARGS, ...AGENT_TOOLS, ...STREAM].join(' ')}), cwd = run copy, prompt on stdin, stopped at tool call ${TOOL_CALL_CAP + 1}`,
    report_turn_harness: `Claude Code ${claudeVersion} headless (claude ${[...CLAUDE_ARGS, '--tools', '""', ...STREAM].join(' ')}), cwd = run copy, prompt on stdin`,
    grader_harness: `Claude Code ${claudeVersion} headless (claude ${[...CLAUDE_ARGS, '--tools', '""', '--output-format', 'json', '--json-schema', '<schema>'].join(' ')}), empty cwd, prompt on stdin`,
    model: MODEL,
    effort: EFFORT,
    tool_call_cap: TOOL_CALL_CAP,
    replicates,
    prompt_template_version: PROMPT_TEMPLATE_VERSION,
    prompt_template_sha256: sha256(`${PROMPT_TEMPLATE}\n${REPORT_TURN_TEMPLATE}`),
    prompt_template: PROMPT_TEMPLATE,
    report_turn_template: REPORT_TURN_TEMPLATE,
    corpus,
    heldout_sha256: heldoutSha,
    tasks: tasks.map(({ id, split, task, files }) => ({ id, split, task, files })),
    runs,
    briefs,
    latency,
  };
  await writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Prepared ${runs.length} runs (${tasks.length} tasks × 2 arms × ${replicates}) in ${outDir}; package ${manifest.package_commit}${manifest.package_dirty ? ' (DIRTY src)' : ''}`);
  for (const [id, brief] of Object.entries(briefs)) {
    console.log(`- ${id}: ${brief.status}${brief.topic_absent ? ' (topic absent)' : ''}; body ${brief.body_tokens} / whole file ${brief.whole_file_tokens} est. tokens; safe overflow ${brief.safe_overflow.length === 0 ? 'yes' : brief.safe_overflow.join('; ')}; replicate bodies identical ${brief.replicate_bodies_identical}`);
  }
  console.log(`Latency: cold CLI first ${latency.cold_first_ms} ms, max ${latency.cold_max_ms} ms; warm p50 max ${latency.warm_p50_max_ms} ms`);
}

const LANE_FILES = ['sessions/active/index.yaml', 'sessions/active/eval/session.yaml', 'sessions/active/eval/wip.md', 'sessions/active/eval/handoff.md'];

async function writeLaneBrief(root, task, relations) {
  const briefCommand = ['node', 'src/cli.js', 'brief', '--root', root, '--session', 'eval', '--write'];
  const started = process.hrtime.bigint();
  const child = spawnSync(briefCommand[0], briefCommand.slice(1), { cwd: packageDir, encoding: 'utf8' });
  const writeMs = Number(process.hrtime.bigint() - started) / 1e6;
  if (child.status !== 0) throw new Error(`${task.id}: brief --write failed: ${child.stderr}`);
  const json = spawnSync('node', ['src/cli.js', 'brief', '--root', root, '--session', 'eval', '--json'], { cwd: packageDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (json.status !== 0) throw new Error(`${task.id}: brief --json failed: ${json.stderr}`);
  const result = JSON.parse(json.stdout);
  const file = await readFile(path.join(root, 'sessions', 'active', 'eval', 'brief.md'), 'utf8');
  const body = file.replace(/^---\n[\s\S]*?\n---\n/, '');
  const header = file.slice(0, file.length - body.length);
  return {
    file,
    result,
    summary: {
      command: briefCommand.join(' ').replace(root, '<run-copy>'),
      status: result.status,
      status_reason: result.status_reason,
      topic_absent: Boolean(result.selection?.topic_absent),
      search_terms: result.selection?.search_terms ?? [],
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
    },
  };
}

/** The prescribed startup reads, in order, from the run copy (recall-evaluation.md › Baseline protocol). */
async function readStartupFiles(root, arm) {
  const notes = (await readdir(path.join(root, 'sessions')))
    .map((name) => ({ name, match: name.match(/^(\d{4}-\d{2}-\d{2})-(\d+)-.*\.md$/) }))
    .filter((entry) => entry.match)
    .sort((left, right) => left.match[1].localeCompare(right.match[1]) || Number(left.match[2]) - Number(right.match[2]));
  const order = [
    'CLAUDE.md',
    'project.yaml',
    `sessions/${notes.at(-1).name}`,
    'sessions/active/index.yaml',
    'sessions/active/eval/wip.md',
    'sessions/active/eval/handoff.md',
    ...(arm === 'brief' ? ['sessions/active/eval/brief.md'] : []),
  ];
  return Promise.all(order.map(async (file) => ({ path: file, content: await readFile(path.join(root, file), 'utf8') })));
}

function renderPrompt(task, startup) {
  const files = task.files.length > 0 ? task.files.map((file) => `\`${file}\``).join(', ') : 'none';
  const text = /[.?!]$/.test(task.task) ? task.task : `${task.task}.`;
  const bundle = startup
    .map((file, index) => `<startup-file order="${index + 1}" path="${file.path}"${file.path.endsWith('/brief.md') ? ' note="the lane\'s generated session brief"' : ''}>\n${file.content.trimEnd()}\n</startup-file>`)
    .join('\n\n');
  return PROMPT_TEMPLATE.replace('{task}', text).replace('{files}', files).replace('{startup}', bundle);
}

async function makeRunCopy(corpus, root, task) {
  await rm(root, { recursive: true, force: true });
  await cp(corpus, root, { recursive: true });
  const laneDir = path.join(root, 'sessions', 'active', 'eval');
  await mkdir(laneDir, { recursive: true });
  const claimed = task.files.length > 0 ? `claimed_paths:\n${task.files.map((file) => `  - ${JSON.stringify(file)}`).join('\n')}` : 'claimed_paths: []';
  await writeFile(
    path.join(laneDir, 'session.yaml'),
    ['id: eval', 'status: active', `session_date: ${LANE_SESSION_DATE}`, 'session_number: 1', `working_on: ${JSON.stringify(task.task)}`, 'feature_slugs: []', 'repos: []', claimed, 'architecture_docs: []', 'decision_domain_files: []', ''].join('\n'),
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
    const root = await makeRunCopy(corpus, path.join(outDir, 'runs', `latency-${task.id}`), task);
    const started = process.hrtime.bigint();
    const child = spawnSync('node', ['src/cli.js', 'brief', '--root', root, '--session', 'eval', '--json'], { cwd: packageDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const coldMs = Number(process.hrtime.bigint() - started) / 1e6;
    if (child.status !== 0) throw new Error(`${task.id}: latency run failed: ${child.stderr}`);
    const warm = [];
    for (let attempt = 0; attempt < warmRuns + 1; attempt += 1) {
      const warmStart = process.hrtime.bigint();
      await buildSessionBrief({ rootDir: root, laneId: 'eval', task: task.task, files: task.files });
      if (attempt > 0) warm.push(Number(process.hrtime.bigint() - warmStart) / 1e6);
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

/** Status matches the packed contents, no predecessor lacks a successor, size within budget (session-brief.md › Statuses). */
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
  if (result.status === 'no-match') {
    if (result.units.some((unit) => unit.kind !== 'lane')) problems.push('no-match with units beyond the lane');
    if (result.follow_ups.some((entry) => entry.priority !== 'nearby')) problems.push('no-match with non-nearby follow-ups');
    if (result.follow_ups.length > 0 && !result.selection?.topic_absent) problems.push('nearby reads without an absent topic');
  }
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
    const outcome = await runAgent(prompt, entry.root, path.join(outDir, 'transcripts', entry.id), manifest.tool_call_cap);
    const metrics = await auditRun(outDir, entry, manifest.tool_call_cap);
    console.log(`${entry.id} ${entry.task} ${entry.arm} #${entry.replicate}: ${metrics.tool_calls} calls${outcome.stopped ? ' (stopped at the cap; report turn)' : ''}, ${Math.round((metrics.duration_ms ?? 0) / 1000)} s, $${metrics.cost_usd?.toFixed(3) ?? '?'}${metrics.violations.length > 0 ? `, VIOLATIONS: ${metrics.violations.join('; ')}` : ''}`);
  });
}

/**
 * One evaluated run. The research session streams; the harness counts tool
 * calls (distinct tool_use ids) and kills the session as soon as call
 * cap + 1 appears, before its result can reach the model. A stopped session
 * gets one report turn with no tools.
 */
async function runAgent(prompt, cwd, transcriptBase, cap) {
  const started = Date.now();
  const research = await spawnClaudeStream([...CLAUDE_ARGS, ...AGENT_TOOLS, ...STREAM], prompt, cwd, cap);
  const meta = { stopped: research.stopped, research_wall_ms: Date.now() - started, report_wall_ms: null };
  await writeFile(`${transcriptBase}.jsonl`, research.stdout);
  if (research.stderr.trim()) await writeFile(`${transcriptBase}.stderr`, research.stderr);
  if (research.stopped) {
    const reportPrompt = REPORT_TURN_TEMPLATE.replace('{prompt}', prompt).replace('{transcript}', renderResearchTranscript(parseEvents(research.stdout), cap));
    await writeFile(`${transcriptBase}.report-prompt.txt`, reportPrompt);
    const reportStarted = Date.now();
    const report = await spawnClaudeStream([...CLAUDE_ARGS, ...NO_TOOLS, ...STREAM], reportPrompt, cwd, 0);
    meta.report_wall_ms = Date.now() - reportStarted;
    await writeFile(`${transcriptBase}.report.jsonl`, report.stdout);
    if (report.stderr.trim()) await writeFile(`${transcriptBase}.report.stderr`, report.stderr);
  }
  await writeFile(`${transcriptBase}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

// Effective list prices per token, fitted exactly to A5's 32 run results
// (claude-opus-5-5): used only to estimate a stopped session, which emits no
// result event and so no total_cost_usd.
const PRICE = { input_tokens: 8e-6, cache_creation_input_tokens: 8e-6, cache_read_input_tokens: 0.2e-6, output_tokens: 20e-6 };

/** Usage summed over a stream's assistant messages (one count per message id). */
function streamUsage(events) {
  const byMessage = new Map();
  for (const event of events) {
    if (event.type === 'assistant' && event.message?.id && event.message.usage) byMessage.set(event.message.id, event.message.usage);
  }
  return sumUsage([...byMessage.values()]);
}

function estimateCost(usage) {
  return usage ? Object.entries(PRICE).reduce((sum, [key, price]) => sum + (usage[key] ?? 0) * price, 0) : null;
}

/** The agent's text, its first `cap` tool calls, and their delivered results, in stream order. */
function renderResearchTranscript(events, cap) {
  const calls = collectToolUses(events).slice(0, cap);
  const allowed = new Set(calls.map((call) => call.id));
  const results = collectToolResults(events);
  const parts = [];
  const seenText = new Set();
  for (const event of events) {
    if (event.type !== 'assistant') continue;
    for (const block of event.message?.content ?? []) {
      if (block.type === 'text' && block.text.trim() && !seenText.has(block.text)) {
        seenText.add(block.text);
        parts.push(`<assistant-text>\n${block.text.trim()}\n</assistant-text>`);
      } else if (block.type === 'tool_use' && allowed.has(block.id)) {
        allowed.delete(block.id);
        const result = results.get(block.id);
        parts.push(
          `<tool-call name="${block.name}">\n${JSON.stringify(block.input)}\n</tool-call>\n<tool-result>\n${result ?? '(no result delivered: the allowance was reached before this result arrived)'}\n</tool-result>`,
        );
      }
    }
  }
  return parts.join('\n\n');
}

/** Tool calls, tokens read, wall time, cost, the final report, and confinement checks for one run. */
async function auditRun(dir, entry, cap) {
  const base = path.join(dir, 'transcripts', entry.id);
  const research = parseEvents(await readFile(`${base}.jsonl`, 'utf8'));
  const reportEvents = await readFile(`${base}.report.jsonl`, 'utf8').then(parseEvents, () => null);
  const realRoot = await realpath(entry.root);
  const init = research.find((event) => event.type === 'system' && event.subtype === 'init');
  const researchResult = research.find((event) => event.type === 'result') ?? null;
  const reportResult = reportEvents?.find((event) => event.type === 'result') ?? null;
  const calls = collectToolUses(research);
  const stopped = calls.length > cap;
  const counted = calls.slice(0, cap);
  const results = collectToolResults(research);
  const violations = [];
  const reads = [];
  for (const use of counted) {
    const target = use.input?.file_path ?? use.input?.path ?? null;
    if (target) {
      const resolved = await safeRealpath(path.isAbsolute(target) ? target : path.join(realRoot, target));
      if (use.name === 'Read') reads.push(path.relative(realRoot, resolved));
      if (resolved !== realRoot && !resolved.startsWith(`${realRoot}${path.sep}`)) violations.push(`${use.name} outside the run copy: ${target}`);
    }
    if (/recall-evaluation/i.test(JSON.stringify(use.input))) violations.push(`${use.name} names an evaluation file`);
  }
  if (!init || init.tools?.some((tool) => !['Read', 'Grep', 'Glob'].includes(tool)) || !init.tools?.length) violations.push(`unexpected tools ${init?.tools?.join(',')}`);
  if (init?.model !== MODEL) violations.push(`model ${init?.model}`);
  if ((researchResult?.permission_denials ?? []).length > 0) violations.push(`${researchResult.permission_denials.length} permission denials`);
  const resultChars = counted.reduce((sum, use) => sum + [...(results.get(use.id) ?? '')].length, 0);
  let report = '';
  if (stopped) {
    const reportInit = reportEvents?.find((event) => event.type === 'system' && event.subtype === 'init');
    if (!reportResult || reportResult.is_error || reportResult.subtype !== 'success') violations.push(`report turn did not complete (${reportResult?.subtype ?? 'no result'})`);
    if (reportInit && (reportInit.tools ?? []).length > 0) violations.push(`report turn had tools ${reportInit.tools.join(',')}`);
    if (collectToolUses(reportEvents ?? []).length > 0) violations.push('report turn used tools');
    report = reportResult?.result ?? '';
  } else {
    if (!researchResult || researchResult.is_error || researchResult.subtype !== 'success') violations.push(`run did not complete (${researchResult?.subtype ?? 'no result'})`);
    report = researchResult?.result ?? '';
  }
  const meta = await readFile(`${base}.meta.json`, 'utf8').then(JSON.parse, () => ({}));
  const researchUsage = researchResult?.usage ?? streamUsage(research);
  const researchCost = researchResult?.total_cost_usd ?? estimateCost(researchUsage);
  const cost = (researchCost ?? 0) + (reportResult?.total_cost_usd ?? 0);
  return {
    model: init?.model ?? null,
    tools: init?.tools ?? [],
    tool_calls: counted.length,
    stopped_at_cap: stopped,
    calls_issued: calls.length,
    tool_calls_by_name: counted.reduce((counts, use) => ({ ...counts, [use.name]: (counts[use.name] ?? 0) + 1 }), {}),
    reads,
    tool_result_chars: resultChars,
    tool_result_tokens_est: Math.ceil(resultChars / 4),
    // A stopped session has no result event: the harness's wall clock is used.
    duration_ms: (researchResult?.duration_ms ?? meta.research_wall_ms ?? 0) + (reportResult?.duration_ms ?? meta.report_wall_ms ?? 0),
    usage: sumUsage([researchUsage, reportResult?.usage]),
    cost_usd: cost || null,
    cost_estimated: !researchResult,
    report,
    violations,
  };
}

function parseEvents(stdout) {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function collectToolUses(events) {
  const uses = [];
  const seen = new Set();
  for (const event of events) {
    if (event.type !== 'assistant') continue;
    for (const block of event.message?.content ?? []) {
      if (block.type === 'tool_use' && !seen.has(block.id)) {
        seen.add(block.id);
        uses.push({ id: block.id, name: block.name, input: block.input });
      }
    }
  }
  return uses;
}

function collectToolResults(events) {
  const results = new Map();
  for (const event of events) {
    if (event.type !== 'user') continue;
    for (const block of event.message?.content ?? []) {
      if (block?.type !== 'tool_result') continue;
      const text = typeof block.content === 'string' ? block.content : (block.content ?? []).map((part) => part.text ?? '').join('');
      results.set(block.tool_use_id, text);
    }
  }
  return results;
}

function sumUsage(usages) {
  const keys = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];
  const present = usages.filter(Boolean);
  if (present.length === 0) return null;
  return Object.fromEntries(keys.map((key) => [key, present.reduce((sum, usage) => sum + (usage[key] ?? 0), 0)]));
}

// ------------------------------------------------------------------ smoke

/**
 * Mechanics check before any evaluation run: one tuning task, baseline arm,
 * with a tiny cap, to show the stop and the report turn work. Results are
 * not evaluation data and are never graded.
 */
async function smoke() {
  const corpus = path.resolve(requireOption('--corpus'));
  const labelsDir = path.resolve(requireOption('--labels'));
  const cap = Number(option('--cap', '3'));
  // --stated-cap tells the agent a larger allowance than the harness enforces,
  // so the stop and the report turn are exercised.
  const statedCap = Number(option('--stated-cap', String(cap)));
  const taskId = requireOption('--task');
  const task = parseTasks(await readFile(path.join(labelsDir, 'recall-evaluation.md'), 'utf8'), 'tuning').find((entry) => entry.id === taskId);
  if (!task) throw new Error(`smoke: no tuning task ${taskId}.`);
  await mkdir(path.join(outDir, 'transcripts'), { recursive: true });
  const root = await makeRunCopy(corpus, path.join(outDir, 'runs', 'smoke'), task);
  const prompt = renderPrompt(task, await readStartupFiles(root, 'baseline')).replaceAll(`at most ${TOOL_CALL_CAP} tool calls`, `at most ${statedCap} tool calls`).replaceAll(`a call beyond ${TOOL_CALL_CAP}`, `a call beyond ${statedCap}`);
  await writeFile(path.join(outDir, 'smoke-prompt.txt'), prompt);
  const outcome = await runAgent(prompt, root, path.join(outDir, 'transcripts', 'smoke'), cap);
  const metrics = await auditRun(outDir, { id: 'smoke', root }, cap);
  console.log(JSON.stringify({ stopped: outcome.stopped, ...metrics, report: `${metrics.report.slice(0, 400)}…` }, null, 2));
}

// ------------------------------------------------------------------ grade

async function grade() {
  const manifest = await readManifest();
  const labels = await loadLabels(path.join(outDir, 'labels'), manifest.heldout_sha256);
  const gradingDir = path.join(outDir, 'grading');
  const workDir = path.join(gradingDir, 'empty-cwd');
  await mkdir(workDir, { recursive: true });

  // Pass 1: two independent graders per report pair and per brief.
  const jobs = [];
  for (const task of manifest.tasks) {
    if (only && !only.has(task.id)) continue;
    const label = labels.get(task.id);
    if (!label) throw new Error(`${task.id}: no label block.`);
    for (let replicate = 1; replicate <= manifest.replicates; replicate += 1) {
      const reports = {};
      for (const arm of ['baseline', 'brief']) {
        const entry = manifest.runs.find((candidate) => candidate.task === task.id && candidate.arm === arm && candidate.replicate === replicate);
        reports[arm] = (await auditRun(outDir, entry, manifest.tool_call_cap)).report;
      }
      const swap = Number.parseInt(sha256(`a7-blind:${task.id}:${replicate}`).slice(0, 2), 16) % 2 === 1;
      const firstOrder = swap ? { P: 'brief', Q: 'baseline' } : { P: 'baseline', Q: 'brief' };
      const secondOrder = { P: firstOrder.Q, Q: firstOrder.P };
      for (const [grader, order] of [['g1', firstOrder], ['g2', secondOrder]]) {
        jobs.push(reportJob(task, label, replicate, grader, order, reports));
      }
    }
    const brief = await readFile(path.join(outDir, 'briefs', `${task.id}.md`), 'utf8');
    for (const grader of ['g1', 'g2']) jobs.push({ kind: 'brief', name: `${task.id}-brief-${grader}`, task, label, grader, prompt: briefGraderPrompt(label, brief) });
  }
  await runGraders(jobs, gradingDir, workDir);

  // Pass 2: a third grader wherever the two disagree on any verdict.
  const tiebreaks = [];
  for (const task of manifest.tasks) {
    if (only && !only.has(task.id)) continue;
    const label = labels.get(task.id);
    for (let replicate = 1; replicate <= manifest.replicates; replicate += 1) {
      const [first, second] = await Promise.all(['g1', 'g2'].map((grader) => readGrade(gradingDir, `${task.id}-r${replicate}-reports-${grader}`)));
      if (reportDisagreements(label, first, second).length === 0) continue;
      const reports = {};
      for (const arm of ['baseline', 'brief']) {
        const entry = manifest.runs.find((candidate) => candidate.task === task.id && candidate.arm === arm && candidate.replicate === replicate);
        reports[arm] = (await auditRun(outDir, entry, manifest.tool_call_cap)).report;
      }
      const swap = Number.parseInt(sha256(`a7-tiebreak:${task.id}:${replicate}`).slice(0, 2), 16) % 2 === 1;
      tiebreaks.push(reportJob(task, label, replicate, 'g3', swap ? { P: 'brief', Q: 'baseline' } : { P: 'baseline', Q: 'brief' }, reports));
    }
    const [first, second] = await Promise.all(['g1', 'g2'].map((grader) => readGrade(gradingDir, `${task.id}-brief-${grader}`)));
    if (briefDisagreements(first, second).length > 0) {
      const brief = await readFile(path.join(outDir, 'briefs', `${task.id}.md`), 'utf8');
      tiebreaks.push({ kind: 'brief', name: `${task.id}-brief-g3`, task, label, grader: 'g3', prompt: briefGraderPrompt(label, brief) });
    }
  }
  await runGraders(tiebreaks, gradingDir, workDir);
  console.log(`graded: ${jobs.length} first-pass calls, ${tiebreaks.length} tie-breaks`);
}

function reportJob(task, label, replicate, grader, order, reports) {
  const redactions = {};
  const redacted = Object.fromEntries(
    Object.entries(order).map(([name, arm]) => {
      const { text, count } = redactArm(reports[arm]);
      redactions[name] = count;
      return [name, text];
    }),
  );
  return { kind: 'reports', name: `${task.id}-r${replicate}-reports-${grader}`, task, label, replicate, grader, order, redactions, prompt: reportGraderPrompt(label, redacted) };
}

async function runGraders(jobs, gradingDir, workDir) {
  await pool(jobs, concurrency, async (job) => {
    const target = path.join(gradingDir, `${job.name}.json`);
    if (await readFile(target).then(() => true, () => false)) return; // resumable: never regrade silently
    const schema = job.kind === 'reports' ? reportSchema(job.label) : briefSchema();
    await writeFile(path.join(gradingDir, `${job.name}.prompt.txt`), job.prompt);
    const output = await spawnClaudeStream([...CLAUDE_ARGS, ...NO_TOOLS, '--output-format', 'json', '--json-schema', JSON.stringify(schema)], job.prompt, workDir, Infinity);
    let parsed;
    try {
      parsed = JSON.parse(output.stdout);
    } catch {
      throw new Error(`${job.name}: grader output is not JSON: ${output.stdout.slice(0, 400)} ${output.stderr.slice(0, 400)}`);
    }
    const graded = parsed.structured_output ?? null;
    if (!graded) throw new Error(`${job.name}: grader returned no structured output: ${parsed.result?.slice(0, 400)}`);
    await writeFile(
      target,
      `${JSON.stringify({ task: job.task.id, kind: job.kind, replicate: job.replicate ?? null, grader: job.grader, order: job.order ?? null, redactions: job.redactions ?? null, model: Object.keys(parsed.modelUsage ?? {}), duration_ms: parsed.duration_ms, cost_usd: parsed.total_cost_usd ?? null, graded }, null, 2)}\n`,
    );
    console.log(`graded ${job.name} (${parsed.duration_ms} ms)`);
  });
}

/** Every verdict the two report graders disagree on: clause stated/attributed, forbidden claims, no-governing. */
function reportDisagreements(label, first, second) {
  const out = [];
  for (const arm of ['baseline', 'brief']) {
    const a = armVerdicts(label, first, arm);
    const b = armVerdicts(label, second, arm);
    for (const key of Object.keys(a.clauses)) {
      if (a.clauses[key].stated !== b.clauses[key].stated || a.clauses[key].attributed !== b.clauses[key].attributed) out.push(`${arm} ${key}`);
    }
    for (const id of label.forbidden) if (a.forbidden[id] !== b.forbidden[id]) out.push(`${arm} ${id}`);
    if (a.noGoverning !== b.noGoverning) out.push(`${arm} no-governing`);
  }
  return out;
}

function briefDisagreements(first, second) {
  const out = [];
  const violated = (grade) => new Set(grade.graded.forbidden.filter((entry) => entry.violated).map((entry) => entry.id));
  const a = violated(first);
  const b = violated(second);
  for (const id of new Set([...a, ...b])) if (a.has(id) !== b.has(id)) out.push(id);
  if (first.graded.presents_governing_memory_for_no_match !== second.graded.presents_governing_memory_for_no_match) out.push('governing');
  return out;
}

/** One grader's verdicts for one arm, keyed like the label (`M1:a`). */
function armVerdicts(label, grade, arm) {
  const name = Object.entries(grade.order).find(([, value]) => value === arm)[0];
  const graded = grade.graded[name];
  const clauseMap = gradedClauseMap(label, graded.clauses);
  const clauses = Object.fromEntries(
    label.clauses.map((clause) => {
      const found = clauseMap.get(`${clause.item}:${clause.clause}`);
      return [`${clause.item}:${clause.clause}`, { stated: Boolean(found?.stated), attributed: Boolean(found?.stated && found?.attributed) }];
    }),
  );
  const forbidden = Object.fromEntries(label.forbidden.map((id) => [id, Boolean(graded.forbidden.find((entry) => entry.id === id)?.violated)]));
  return { clauses, forbidden, noGoverning: Boolean(graded.states_no_governing_memory) };
}

/**
 * Removes only the brief arm's own startup-file path, as A5 did after its
 * redaction fix. Blinding is partial: reports may mention "the brief".
 */
function redactArm(text) {
  let count = 0;
  const redacted = text.replace(/sessions\/active\/eval\/brief\.md/g, () => {
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
  '- A placeholder "[lane startup file]" may replace a file path in the reports; ignore it.',
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
  '- Listing a path as a follow-up read or a nearby read never violates.',
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
  const labels = await loadLabels(path.join(outDir, 'labels'), manifest.heldout_sha256);
  const gradingDir = path.join(outDir, 'grading');
  const rows = [];
  const agreement = { clause_stated: [], forbidden: [], no_governing: [], brief_forbidden: [] };
  const costs = { runs: 0, graders: 0 };

  for (const task of manifest.tasks) {
    const label = labels.get(task.id);
    const positive = label.clauses.length > 0;
    const runs = { baseline: [], brief: [] };
    for (let replicate = 1; replicate <= manifest.replicates; replicate += 1) {
      const grades = await Promise.all(['g1', 'g2', 'g3'].map((grader) => readGrade(gradingDir, `${task.id}-r${replicate}-reports-${grader}`).catch(() => null)));
      for (const grade of grades.filter(Boolean)) costs.graders += grade.cost_usd ?? 0;
      for (const arm of ['baseline', 'brief']) {
        const entry = manifest.runs.find((candidate) => candidate.task === task.id && candidate.arm === arm && candidate.replicate === replicate);
        const metrics = await auditRun(outDir, entry, manifest.tool_call_cap);
        costs.runs += metrics.cost_usd ?? 0;
        const [first, second, third] = grades.map((grade) => (grade ? armVerdicts(label, grade, arm) : null));
        // Agreement between the two independent first-pass graders.
        for (const key of Object.keys(first.clauses)) agreement.clause_stated.push([first.clauses[key].stated, second.clauses[key].stated]);
        for (const id of label.forbidden) agreement.forbidden.push([first.forbidden[id], second.forbidden[id]]);
        agreement.no_governing.push([first.noGoverning, second.noGoverning]);
        const verdicts = majority(first, second, third, label);
        runs[arm].push({ run: entry.id, replicate, metrics: { ...metrics, report: undefined }, ...verdicts, items: scoreItems(label, verdicts.clauses) });
      }
    }

    const briefGrades = (await Promise.all(['g1', 'g2', 'g3'].map((grader) => readGrade(gradingDir, `${task.id}-brief-${grader}`).catch(() => null)))).filter(Boolean);
    for (const grade of briefGrades) costs.graders += grade.cost_usd ?? 0;
    const violatedBy = (grade) => new Set(grade.graded.forbidden.filter((entry) => entry.violated).map((entry) => entry.id));
    for (const id of label.forbidden) agreement.brief_forbidden.push([violatedBy(briefGrades[0]).has(id), violatedBy(briefGrades[1]).has(id)]);
    const briefViolations = label.forbidden.filter((id) => briefGrades.filter((grade) => violatedBy(grade).has(id)).length * 2 > briefGrades.length);

    // Per clause: how many of the replicates state it, per arm.
    const clauseCounts = label.clauses.map((clause) => {
      const key = `${clause.item}:${clause.clause}`;
      return {
        clause: `${clause.item}${clause.clause === '-' ? '' : `(${clause.clause})`}`,
        baseline: runs.baseline.filter((entry) => entry.clauses[key].stated).length,
        brief: runs.brief.filter((entry) => entry.clauses[key].stated).length,
      };
    });
    const n = manifest.replicates;
    rows.push({
      id: task.id,
      split: task.split,
      positive,
      runs,
      recall: Object.fromEntries(['baseline', 'brief'].map((arm) => [arm, recallStats(runs[arm])])),
      clause_counts: clauseCounts,
      // Pre-registered (recall-evaluation.md › A7 protocol › No-regression).
      lost: clauseCounts.filter((entry) => entry.baseline === n && entry.brief <= n - 2).map((entry) => entry.clause),
      weakened: clauseCounts.filter((entry) => entry.baseline === n && entry.brief === n - 1).map((entry) => entry.clause),
      gained: clauseCounts.filter((entry) => entry.brief === n && entry.baseline <= n - 2).map((entry) => entry.clause),
      baseline_unstable: clauseCounts.filter((entry) => entry.baseline > 0 && entry.baseline < n).map((entry) => entry.clause),
      no_match: positive
        ? null
        : Object.fromEntries(['baseline', 'brief'].map((arm) => [arm, runs[arm].filter((entry) => entry.noGoverning && (arm === 'baseline' || manifest.briefs[task.id].status === 'no-match')).length])),
      brief: manifest.briefs[task.id],
      brief_violations: briefViolations,
      brief_grades: briefGrades.map((grade) => grade.graded),
    });
  }
  const summary = summarize(rows, manifest, agreement, costs);
  await writeFile(path.join(outDir, 'results.json'), `${JSON.stringify({ summary, rows }, null, 2)}\n`);
  await writeFile(path.join(outDir, 'report.md'), renderReport(summary, rows, manifest));
  console.log(renderReport(summary, rows, manifest));
}

/** Majority of the graders available for a verdict (a third grader exists only where the first two disagreed). */
function majority(first, second, third, label) {
  const pick = (values) => {
    const present = values.filter((value) => value !== undefined);
    if (present.length === 2 && present[0] !== present[1]) throw new Error('a disagreement has no tie-break grade');
    return present.filter(Boolean).length * 2 > present.length;
  };
  const graders = [first, second, ...(third ? [third] : [])];
  const clauses = Object.fromEntries(
    Object.keys(first.clauses).map((key) => {
      const stated = pick(graders.map((grader) => grader.clauses[key].stated));
      const attributed = stated && pick(graders.map((grader) => grader.clauses[key].attributed));
      return [key, { stated, attributed }];
    }),
  );
  return {
    clauses,
    forbidden: label.forbidden.filter((id) => pick(graders.map((grader) => grader.forbidden[id]))),
    noGoverning: pick(graders.map((grader) => grader.noGoverning)),
  };
}

/**
 * Item score (recall-evaluation.md › Scoring › A5): 1 when all clauses are
 * stated, 0.5 when some are, 0 when none, times 1 when every stated clause is
 * attributed and 0.5 otherwise.
 */
function scoreItems(label, clauses) {
  const items = [...new Set(label.clauses.map((clause) => clause.item))];
  return items.map((item) => {
    const members = label.clauses.filter((clause) => clause.item === item).map((clause) => clauses[`${clause.item}:${clause.clause}`]);
    const stated = members.filter((clause) => clause.stated);
    const fraction = (count) => (count === members.length ? 1 : count > 0 ? 0.5 : 0);
    return { item, score: fraction(stated.length) * (stated.every((clause) => clause.attributed) ? 1 : 0.5) };
  });
}

function recallStats(runs) {
  const perRun = runs.map((entry) => (entry.items.length === 0 ? null : mean(entry.items.map((item) => item.score))));
  if (perRun.some((value) => value === null)) return null;
  return { mean: mean(perRun), min: Math.min(...perRun), max: Math.max(...perRun), per_run: perRun };
}

function summarize(rows, manifest, agreement, costs) {
  const n = manifest.replicates;
  const splits = { tuning: rows.filter((row) => row.positive && row.split === 'tuning'), heldout: rows.filter((row) => row.positive && row.split !== 'tuning') };
  const recall = {};
  for (const [split, subset] of Object.entries(splits)) {
    recall[split] = {};
    for (const arm of ['baseline', 'brief']) {
      // Macro over tasks of the per-task mean; spread across replicate indices.
      const perReplicate = Array.from({ length: n }, (_, index) => mean(subset.map((row) => row.recall[arm].per_run[index])));
      recall[split][arm] = {
        macro: mean(subset.map((row) => row.recall[arm].mean)),
        replicate_macros: perReplicate,
        spread: [Math.min(...perReplicate), Math.max(...perReplicate)],
        sd: sd(perReplicate),
        per_task: Object.fromEntries(subset.map((row) => [row.id, row.recall[arm]])),
      };
    }
  }
  const noMatchRows = rows.filter((row) => !row.positive);
  const unsafe = rows.filter((row) => row.brief.safe_overflow.length > 0).map((row) => `${row.id}: ${row.brief.safe_overflow.join('; ')}`);
  const runViolations = rows.flatMap((row) => ['baseline', 'brief'].flatMap((arm) => row.runs[arm].filter((entry) => entry.metrics.violations.length > 0).map((entry) => `${entry.run} (${row.id} ${arm}): ${entry.metrics.violations.join('; ')}`)));
  const perCase = (split, threshold) => Object.entries(recall[split].brief.per_task).filter(([, stats]) => stats.mean < threshold).map(([id, stats]) => `${id} ${stats.mean.toFixed(3)}`);
  const reportViolations = (arm) => rows.flatMap((row) => row.runs[arm].filter((entry) => entry.forbidden.length > 0).map((entry) => `${entry.run} (${row.id}): ${entry.forbidden.join(', ')}`));
  const gates = {
    brief_forbidden_claims: { pass: rows.every((row) => row.brief_violations.length === 0), findings: rows.filter((row) => row.brief_violations.length > 0).map((row) => `${row.id}: ${row.brief_violations.join(', ')}`) },
    brief_arm_report_forbidden_claims: { pass: reportViolations('brief').length === 0, findings: reportViolations('brief') },
    baseline_report_forbidden_claims_reported: reportViolations('baseline'),
    safe_overflow_and_status: { pass: unsafe.length === 0 && rows.every((row) => row.brief.replicate_bodies_identical), findings: unsafe },
    tuning_recall: { target: 0.8, macro: recall.tuning.brief.macro, cases_below: perCase('tuning', 0.8), pass: recall.tuning.brief.macro >= 0.8 && perCase('tuning', 0.8).length === 0 },
    heldout_recall: { target: 0.75, macro: recall.heldout.brief.macro, cases_below: perCase('heldout', 0.75), pass: recall.heldout.brief.macro >= 0.75 && perCase('heldout', 0.75).length === 0 },
    no_regression: { pass: rows.every((row) => row.lost.length === 0), lost: rows.filter((row) => row.lost.length > 0).map((row) => `${row.id}: ${row.lost.join(', ')}`) },
    latency: { warm_p50_max_ms: manifest.latency.warm_p50_max_ms, cold_max_ms: manifest.latency.cold_max_ms, pass: manifest.latency.warm_p50_max_ms <= 300 && manifest.latency.cold_max_ms <= 1500 },
    run_protocol: { pass: runViolations.length === 0, findings: runViolations },
  };
  return {
    recall,
    no_match: Object.fromEntries(['baseline', 'brief'].map((arm) => [arm, { correct_runs: noMatchRows.reduce((sum, row) => sum + row.no_match[arm], 0), total_runs: noMatchRows.length * n, per_task: Object.fromEntries(noMatchRows.map((row) => [row.id, row.no_match[arm]])) }])),
    brief_no_match_status: Object.fromEntries(noMatchRows.map((row) => [row.id, row.brief.status])),
    grader_agreement: Object.fromEntries(Object.entries(agreement).map(([key, pairs]) => [key, agreementStats(pairs)])),
    stopped_at_cap: Object.fromEntries(['baseline', 'brief'].map((arm) => [arm, rows.reduce((sum, row) => sum + row.runs[arm].filter((entry) => entry.metrics.stopped_at_cap).length, 0)])),
    cost_usd: { runs: costs.runs, graders: costs.graders, total: costs.runs + costs.graders },
    gates,
    go: Object.values(gates).filter((gate) => typeof gate === 'object' && 'pass' in gate).every((gate) => gate.pass),
  };
}

/** Percent agreement and Cohen's kappa for boolean verdict pairs. */
function agreementStats(pairs) {
  if (pairs.length === 0) return { n: 0 };
  const agree = pairs.filter(([a, b]) => a === b).length / pairs.length;
  const pa = pairs.filter(([a]) => a).length / pairs.length;
  const pb = pairs.filter(([, b]) => b).length / pairs.length;
  const expected = pa * pb + (1 - pa) * (1 - pb);
  return { n: pairs.length, agreement: agree, kappa: expected === 1 ? null : (agree - expected) / (1 - expected) };
}

function renderReport(summary, rows, manifest) {
  const f3 = (value) => (value === null || value === undefined ? '—' : value.toFixed(3));
  const lines = [`# A7 results (${manifest.prompt_template_version}, ${manifest.model}, effort ${manifest.effort}, ${manifest.replicates} replicates, cap ${manifest.tool_call_cap})`, ''];
  lines.push(`Harness: ${manifest.harness}`, `Package: ${manifest.package_commit}${manifest.package_dirty ? ' (DIRTY)' : ''}; Node ${manifest.node}`, '');
  lines.push('| Task | Split | Baseline recall mean (min–max) | Brief recall mean (min–max) | Lost | Weakened | Gained | Baseline unstable | Brief status / body / file | Brief X | Calls b / r (stopped) |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const row of rows) {
    const stats = (arm) => (row.recall[arm] ? `${f3(row.recall[arm].mean)} (${f3(row.recall[arm].min)}–${f3(row.recall[arm].max)})` : `no governing: ${row.no_match[arm]}/${manifest.replicates}`);
    const calls = (arm) => row.runs[arm].map((entry) => `${entry.metrics.tool_calls}${entry.metrics.stopped_at_cap ? '*' : ''}`).join(',');
    lines.push(
      `| ${row.id} | ${row.split} | ${stats('baseline')} | ${stats('brief')} | ${row.lost.join(', ') || '—'} | ${row.weakened.join(', ') || '—'} | ${row.gained.join(', ') || '—'} | ${row.baseline_unstable.join(', ') || '—'} | ${row.brief.status}${row.brief.topic_absent ? ' (topic absent)' : ''} / ${row.brief.body_tokens} / ${row.brief.whole_file_tokens} | ${row.brief_violations.join(', ') || 'none'} | ${calls('baseline')} / ${calls('brief')} |`,
    );
  }
  lines.push('');
  for (const split of ['tuning', 'heldout']) {
    for (const arm of ['baseline', 'brief']) {
      const data = summary.recall[split][arm];
      lines.push(`- ${split} positives, ${arm}: macro ${f3(data.macro)}; replicate macros ${data.replicate_macros.map(f3).join(', ')} (sd ${f3(data.sd)})`);
    }
  }
  lines.push(`- No-match: ${JSON.stringify(summary.no_match)}; brief statuses ${JSON.stringify(summary.brief_no_match_status)}`);
  lines.push(`- Grader agreement: ${JSON.stringify(summary.grader_agreement)}`);
  lines.push(`- Stopped at the cap: ${JSON.stringify(summary.stopped_at_cap)}; cost ${JSON.stringify(summary.cost_usd)}`);
  lines.push('', '## Gates', '```json', JSON.stringify(summary.gates, null, 2), '```', '', `Go for default-on under the pre-registered rule: ${summary.go}`);
  return `${lines.join('\n')}\n`;
}

// ----------------------------------------------------------------- labels

/**
 * Grading labels: the 12 tuning blocks with the reviewer-confirmed corpus v2
 * revisions merged (recall-evaluation.md › A7 protocol › Merged v2 tuning
 * labels), then the 8 held-out blocks (sha256-checked).
 */
async function loadLabels(labelsDir, heldoutSha) {
  const tuningText = await readFile(path.join(labelsDir, 'recall-evaluation.md'), 'utf8');
  const heldoutText = await readFile(path.join(labelsDir, 'recall-evaluation-heldout-v2.md'), 'utf8');
  if (sha256(heldoutText) !== heldoutSha) throw new Error('recall-evaluation-heldout-v2.md changed since prepare.');
  const tuningSection = tuningText.slice(tuningText.indexOf('### Tuning tasks'), tuningText.indexOf('### Corpus v2 tuning-label re-verification'));
  const mergedStart = tuningText.indexOf('#### Merged v2 tuning labels');
  if (mergedStart === -1) throw new Error('recall-evaluation.md has no merged v2 tuning labels.');
  const ends = ['\n## ', '\n### ', '\n#### '].map((marker) => tuningText.indexOf(marker, mergedStart + 1)).filter((index) => index !== -1);
  const mergedSection = tuningText.slice(mergedStart, ends.length > 0 ? Math.min(...ends) : undefined);
  const labels = new Map(parseLabels(tuningSection).map((label) => [label.id, label]));
  for (const merged of parseLabels(mergedSection, 5)) labels.set(merged.id, merged);
  for (const label of parseLabels(heldoutText)) labels.set(label.id, label);
  return labels;
}

function parseTasks(markdown, split) {
  return [...markdown.matchAll(/^#### ([FTCN]\d+) — [^\n]*· ([a-z-]+)\s*\n([\s\S]*?)(?=^#{2,4} |(?![\s\S]))/gm)]
    .filter((match) => (split === 'tuning' ? match[2] === 'tuning' : match[2] === 'held-out'))
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
function parseLabels(markdown, level = 4) {
  const hashes = '#'.repeat(level);
  const pattern = new RegExp(`^(${hashes} ([FTCN]\\d+) — [^\\n]*)\\n([\\s\\S]*?)(?=^#{2,${level}} |(?![\\s\\S]))`, 'gm');
  return [...markdown.matchAll(pattern)].map((match) => {
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

/**
 * Grader clauses keyed like the label (`M1:a`). Letters are normalized ("(a)",
 * "A"), and a single-clause item (`-`) takes the grader's entry for that item
 * whatever clause value it used.
 */
function gradedClauseMap(label, clauses) {
  const map = new Map();
  for (const expected of label.clauses) {
    const matches = clauses.filter((clause) => clause.item.trim().toUpperCase() === expected.item);
    const match = expected.clause === '-' ? matches[0] : matches.find((clause) => clause.clause.replace(/[^a-z]/gi, '').toLowerCase() === expected.clause);
    if (match) map.set(`${expected.item}:${expected.clause}`, match);
  }
  return map;
}

// ----------------------------------------------------------------- shared

/**
 * Spawns `claude`, streaming stdout. With a finite `cap`, stops the process
 * as soon as the stream shows tool call cap + 1 (distinct tool_use ids).
 */
function spawnClaudeStream(claudeArgs, prompt, cwd, cap) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', claudeArgs, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let buffer = '';
    let stopped = false;
    const seen = new Set();
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!Number.isFinite(cap) || stopped) return;
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('{')) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type !== 'assistant') continue;
        for (const block of event.message?.content ?? []) {
          if (block.type === 'tool_use') seen.add(block.id);
        }
        if (seen.size > cap) {
          stopped = true;
          child.kill('SIGKILL');
          return;
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, stopped }));
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

async function readGrade(gradingDir, name) {
  return JSON.parse(await readFile(path.join(gradingDir, `${name}.json`), 'utf8'));
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

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sd(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

// Dispatch last, so every module-level constant above is initialized.
const commands = { prepare, run, grade, score, smoke };
if (!commands[command] || !outDir) {
  console.error('Usage: node scripts/evaluate-brief-a7.js <prepare|run|grade|score|smoke> --out <dir> [...]');
  process.exit(2);
}
await commands[command]();
