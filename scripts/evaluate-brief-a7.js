#!/usr/bin/env node
// A7 evaluation for the session brief (recall plan task A7; protocol
// pre-registered in canonical memory at
// architecture/platform/project-memory/recall-evaluation.md › A7 protocol).
// Development tool; not shipped in the npm package.
//
//   node scripts/evaluate-brief-a7.js prepare --corpus <dir> --docs-repo <dir> --labels <dir> --heldout-sha256 <hex> --out <dir> [--warm-runs 10]
//   node scripts/evaluate-brief-a7.js run     --out <dir> --max-cost-usd <n> [--concurrency 4] [--only r001,r002]
//   node scripts/evaluate-brief-a7.js grade   --out <dir> --max-cost-usd <n> [--concurrency 4] [--only F1,T2]
//   node scripts/evaluate-brief-a7.js screen  --out <dir>        (stage 1: which tasks need confirmation runs)
//   node scripts/evaluate-brief-a7.js confirm --out <dir>        (stage 2: adds replicates 4–6 for the flagged tasks)
//   node scripts/evaluate-brief-a7.js score   --out <dir>
//   node scripts/evaluate-brief-a7.js smoke   --corpus <dir> --labels <dir> --out <dir> --task <id> [--cap 3] [--stated-cap 24]
//   node scripts/evaluate-brief-a7.js describe
//
// What A7 changes from A5 (scripts/evaluate-brief-a5.js):
// - Startup order is enforced by construction: the harness reads the
//   prescribed startup files from the run copy and supplies them in the
//   prompt, in order, identically to both arms (the brief arm adds the lane
//   brief.md after handoff.md). No startup read costs a tool call.
// - The tool-call allowance is enforced at the report: the harness counts
//   tool calls in the live stream and stops the research session once call
//   TOOL_CALL_CAP + 1 appears. The harness only observes the stream, so that
//   session may already have run the call; everything from the excess
//   tool-use block onward is discarded. A stopped run's report is written by
//   a fresh session with no tools, from the transcript up to that boundary, so
//   no result beyond the cap reaches the session that writes the report.
// - Run-to-run noise: three replicates per task × arm (stage 1), and three
//   more for tasks the pre-registered screen flags (stage 2).
// - Grader noise: two independent graders per report pair and per brief (the
//   second sees the reports in reversed order); every disagreement goes to a
//   third grader, and the majority stands. Grades must cover the label's
//   checklist exactly; incomplete grading stops scoring.
// - Integrity: preparation stops on any integrity failure; every later stage
//   checks the frozen package, harness, labels, manifest, run copies, briefs,
//   prompts, and transcripts; every grade is bound to its exact inputs and its
//   own session record; every paid call is in an append-only spend ledger.
//
// Isolation is A5's: headless Claude Code (`claude -p`) with --safe-mode,
// --restricted, Read/Grep/Glob only, --strict-mcp-config, --permission-mode
// dontAsk, --no-session-persistence; cwd = the run copy; no CLAUDE.md
// auto-discovery, memory, MCP, hooks, settings, network, or command tools.
// Every session — research, report turn, and grader — is checked for the
// model, the recorded Claude Code version, the permission mode, no MCP
// server, its tool set, and success.
//
// Label isolation: `prepare`, `confirm`, and `run` read only each task's Task
// and Files lines. Only `grade`, `screen`, and `score` read labels, and only
// graders see them.

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { appendFile, copyFile, cp, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
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
export const STAGE1_REPLICATES = 3;
export const STAGE2_REPLICATES = 3;
const LANE_SESSION_DATE = '2026-10-02';
const CORPUS_TAG = 'recall-eval-corpus-v2';
const CORPUS_EXCLUDED = (file) => /^architecture\/platform\/project-memory\/recall-evaluation[^/]*\.md$/.test(file) || file.startsWith('sessions/active/');
const LABEL_FILES = ['recall-evaluation.md', 'recall-evaluation-heldout-v2.md'];
const LANE_FILES = ['sessions/active/index.yaml', 'sessions/active/eval/session.yaml', 'sessions/active/eval/wip.md', 'sessions/active/eval/handoff.md'];
// Reserves the cost cap holds back before starting a paid call, and the cost
// counted for an attempt whose cost cannot be established.
export const RUN_RESERVE_USD = 1.5;
export const GRADE_RESERVE_USD = 0.5;
export const MAX_GRADE_ATTEMPTS = 3;
const RESEARCH_TOOLS = ['Glob', 'Grep', 'Read'];
// --json-schema runs the built-in structured-output tool even with --tools "".
const GRADER_TOOLS = ['StructuredOutput'];

// Pre-registered no-regression thresholds (recall-evaluation.md › A7 protocol).
export const REGRESSION = Object.freeze({
  screenTaskDrop: 0.15, // stage 1: flag a task whose brief mean recall is more than this below the baseline's
  maxFlagged: 5, // more flagged tasks than this is a systematic regression
  confirmTaskDrop: 0.15, // stage 2 (six replicates): a confirmed task-level loss
  confirmBaselineMin: 5, // stage 2: a clause the baseline states in at least 5 of 6 …
  confirmBriefMax: 1, // … and the brief arm in at most 1 of 6 is a confirmed loss
  splitDrop: 0.05, // brief macro may not fall more than this below the baseline macro, per split
});

const PROMPT_TEMPLATE = [
  'You are starting a builder session in this project-memory root. Task: {task} Files: {files}. Do not write code. Using project memory, produce a context report with four sections: (1) Relevant memory — `path › heading` and why it matters; (2) Facts I will rely on — each with its source passage and its status (current, superseded, partially superseded, or disputed); (3) Conflicts or uncertainty; (4) No governing memory — say so if nothing in memory governs this task.',
  '',
  'Startup files: the startup read order is already done for you. The files below are the prescribed startup reads, in order, with their full contents. Then read any architecture, decision, or session files you choose.',
  '',
  '{startup}',
  '',
  `Rules: this root is your only source — no code repositories, network, or web. File paths in the task are context for choosing memory, not files to open. Read-only. You may make at most ${TOOL_CALL_CAP} tool calls; every tool invocation counts as one call. The harness enforces this: when you make call ${TOOL_CALL_CAP + 1}, it stops your session and discards everything from that call on, and you then write the report, without tools, from your first ${TOOL_CALL_CAP} calls and their results. Your final message is the context report.`,
].join('\n');

const REPORT_TURN_TEMPLATE = [
  '{prompt}',
  '',
  `Your research so far — your own messages, your first ${TOOL_CALL_CAP} tool calls, and their results, in order:`,
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
// Tests point this at a mock child; an evaluation run records it, and the
// audit requires the recorded Claude Code version in every session.
const CLAUDE_BIN = process.env.A7_CLAUDE_BIN ?? 'claude';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const harnessPath = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------- prepare

/**
 * Prepares stage 1 in an empty or new directory. `opts`: corpus, docsRepo,
 * labelsDir, heldoutSha, warmRuns, expectTasks (20 for A7).
 */
export async function prepare(ctx, opts) {
  const { dir } = ctx;
  if (await nonEmptyDirectory(dir)) throw new Error(`Refusing to prepare into ${dir}: it already holds files. Use a new, empty directory for each evaluation.`);
  const corpus = path.resolve(opts.corpus);
  const failures = [];

  const identity = (ctx.identity ?? packageIdentity)();
  if (identity.package_dirty) failures.push(`package src/ or scripts/ has uncommitted changes: ${identity.package_dirty}`);
  await mkdir(path.join(dir, 'labels'), { recursive: true });
  const labelHashes = {};
  for (const file of LABEL_FILES) {
    await copyFile(path.join(opts.labelsDir, file), path.join(dir, 'labels', file));
    labelHashes[file] = sha256(await readFile(path.join(dir, 'labels', file), 'utf8'));
  }
  if (labelHashes['recall-evaluation-heldout-v2.md'] !== opts.heldoutSha) failures.push('recall-evaluation-heldout-v2.md does not match --heldout-sha256; the held-out set changed since its handback');
  failures.push(...(await verifyCorpus(corpus, path.resolve(opts.docsRepo))));

  const labelsText = Object.fromEntries(await Promise.all(LABEL_FILES.map(async (file) => [file, await readFile(path.join(dir, 'labels', file), 'utf8')])));
  const tasks = [...parseTasks(labelsText['recall-evaluation.md'], 'tuning'), ...parseTasks(labelsText['recall-evaluation-heldout-v2.md'], 'held-out')];
  const expectTasks = opts.expectTasks ?? 20;
  if (tasks.length !== expectTasks) failures.push(`expected ${expectTasks} tasks, found ${tasks.length}`);
  for (const task of tasks) if (!task.task) failures.push(`${task.id}: no task text`);
  if (failures.length > 0) throw new Error(`Preflight failed; nothing prepared:\n- ${failures.join('\n- ')}`);

  await mkdir(path.join(dir, 'briefs'), { recursive: true });
  await mkdir(path.join(dir, 'prompts'), { recursive: true });
  const relations = (await loadProjectReadModel(corpus)).decision_lineage.relations;
  const corpusHashes = await hashTree(corpus);

  // Arms alternate by task and replicate; run ids follow launch order.
  const runs = [];
  tasks.forEach((task, taskIndex) => {
    for (let replicate = 1; replicate <= STAGE1_REPLICATES; replicate += 1) runs.push(...armPair(runs, task, taskIndex, replicate, 1));
  });
  const briefs = {};
  for (const entry of runs) failures.push(...(await prepareRun(dir, entry, tasks, corpus, corpusHashes, relations, briefs)));

  const latency = await measureLatency(dir, corpus, tasks, opts.warmRuns ?? 10);
  // Pre-run gates (A7 protocol): a failure here is the outcome — no-go — and no paid run starts.
  const preRunGateFailures = [
    ...Object.entries(briefs).flatMap(([id, brief]) => brief.safe_overflow.map((problem) => `${id}: ${problem}`)),
    ...(latency.warm_p50_max_ms > 300 ? [`warm p50 ${latency.warm_p50_max_ms} ms > 300 ms`] : []),
    ...(latency.cold_max_ms > 1500 ? [`cold CLI ${latency.cold_max_ms} ms > 1,500 ms`] : []),
  ];
  if (failures.length > 0) throw new Error(`Preflight failed; nothing prepared:\n- ${failures.join('\n- ')}`);

  const claudeVersion = spawnSync(CLAUDE_BIN, ['--version'], { encoding: 'utf8' }).stdout.trim();
  if (!parseVersion(claudeVersion)) throw new Error(`cannot read the Claude Code version (got "${claudeVersion}")`);
  const manifest = {
    prepared_at: new Date().toISOString(),
    ...identity,
    node: process.version,
    claude_bin: CLAUDE_BIN,
    claude_version: claudeVersion,
    harness: `Claude Code ${claudeVersion} headless (claude ${[...CLAUDE_ARGS, ...AGENT_TOOLS, ...STREAM].join(' ')}), cwd = run copy, prompt on stdin, stopped when tool call ${TOOL_CALL_CAP + 1} appears`,
    report_turn_harness: `Claude Code ${claudeVersion} headless (claude ${[...CLAUDE_ARGS, '--tools', '""', ...STREAM].join(' ')}), cwd = run copy, prompt on stdin`,
    grader_harness: `Claude Code ${claudeVersion} headless (claude ${[...CLAUDE_ARGS, '--tools', '""', ...STREAM, '--json-schema', '<schema>'].join(' ')}), empty cwd, prompt on stdin`,
    model: MODEL,
    effort: EFFORT,
    tool_call_cap: TOOL_CALL_CAP,
    stage1_replicates: STAGE1_REPLICATES,
    stage2_replicates: STAGE2_REPLICATES,
    regression: REGRESSION,
    prompt_template_version: PROMPT_TEMPLATE_VERSION,
    prompt_template_sha256: templateSha(),
    corpus,
    corpus_tag: CORPUS_TAG,
    corpus_sha256: treeDigest(corpusHashes),
    label_sha256: labelHashes,
    heldout_sha256: opts.heldoutSha,
    tasks: tasks.map(({ id, split, task, files }) => ({ id, split, task, files })),
    runs,
    briefs,
    latency,
    preflight: { pass: true },
    pre_run_gates: { pass: preRunGateFailures.length === 0, failures: preRunGateFailures },
  };
  await writeManifest(dir, manifest, 'prepare');
  log(ctx, `Prepared ${runs.length} stage-1 runs (${tasks.length} tasks × 2 arms × ${STAGE1_REPLICATES}) in ${dir}; package ${manifest.package_commit}`);
  for (const [id, brief] of Object.entries(briefs)) {
    log(ctx, `- ${id}: ${brief.status}${brief.topic_absent ? ' (topic absent)' : ''}; body ${brief.body_tokens} / whole file ${brief.whole_file_tokens} est. tokens; safe overflow ${brief.safe_overflow.length === 0 ? 'yes' : brief.safe_overflow.join('; ')}`);
  }
  log(ctx, `Latency: cold CLI first ${latency.cold_first_ms} ms, max ${latency.cold_max_ms} ms; warm p50 max ${latency.warm_p50_max_ms} ms`);
  if (!manifest.pre_run_gates.pass) log(ctx, `PRE-RUN GATES FAILED — the outcome is no-go and \`run\` will refuse:\n- ${preRunGateFailures.join('\n- ')}`);
  return manifest;
}

function armPair(existing, task, taskIndex, replicate, stage) {
  const arms = (taskIndex + replicate) % 2 === 1 ? ['baseline', 'brief'] : ['brief', 'baseline'];
  return arms.map((arm, index) => ({ id: `r${String(existing.length + index + 1).padStart(3, '0')}`, task: task.id, arm, replicate, stage }));
}

/** Builds one run copy, its brief (brief arm), and its prompt, and records their identities; returns preflight failures. */
async function prepareRun(dir, entry, tasks, corpus, corpusHashes, relations, briefs) {
  const failures = [];
  const task = tasks.find((candidate) => candidate.id === entry.task);
  const root = await makeRunCopy(corpus, path.join(dir, 'runs', entry.id), task);
  entry.root = root;

  if (entry.arm === 'brief') {
    const brief = await writeLaneBrief(root, task, relations);
    if (!brief.summary.body_matches_json) failures.push(`${entry.id} (${task.id}): brief body differs from --json markdown`);
    const normalized = normalizeRunLocation(brief.file, root, await realpath(root));
    const replicateIdentity = { run: entry.id, file_sha256: sha256(brief.file), normalized_sha256: sha256(normalized) };
    entry.brief_sha256 = replicateIdentity.file_sha256;
    if (!briefs[task.id]) {
      await writeFile(path.join(dir, 'briefs', `${task.id}.md`), brief.file);
      await writeFile(path.join(dir, 'briefs', `${task.id}.json`), `${JSON.stringify(brief.result, null, 2)}\n`);
      briefs[task.id] = { ...brief.summary, graded_file_sha256: sha256(brief.file), replicates: [replicateIdentity] };
    } else {
      briefs[task.id].replicates.push(replicateIdentity);
      if (briefs[task.id].replicates[0].normalized_sha256 !== replicateIdentity.normalized_sha256) {
        failures.push(`${entry.id} (${task.id}): brief.md differs from replicate ${briefs[task.id].replicates[0].run} beyond the run-copy path and generation time`);
      }
    }
  }

  const startup = await readStartupFiles(root, entry.arm);
  const prompt = renderPrompt(task, startup);
  entry.startup_files = startup.map((file) => ({ path: file.path, sha256: sha256(file.content) }));
  entry.prompt_sha256 = sha256(prompt);
  await writeFile(path.join(dir, 'prompts', `${entry.id}.txt`), prompt);

  // The copy must equal the corpus byte for byte, plus the eval lane (and brief.md).
  const expectedExtra = new Set([...LANE_FILES, ...(entry.arm === 'brief' ? ['sessions/active/eval/brief.md'] : [])]);
  const copyHashes = await hashTree(root);
  for (const [file, hash] of copyHashes) {
    if (expectedExtra.has(file)) continue;
    if (corpusHashes.get(file) !== hash) failures.push(`${entry.id}: run copy file ${file} ${corpusHashes.has(file) ? 'differs from' : 'is not in'} the corpus`);
  }
  for (const file of [...corpusHashes.keys(), ...expectedExtra]) if (!copyHashes.has(file)) failures.push(`${entry.id}: run copy is missing ${file}`);
  // Every later stage re-hashes the copy against this digest.
  entry.tree_sha256 = treeDigest(copyHashes);
  return failures;
}

/**
 * Replicate identity (A7 protocol): two lane briefs for the same task differ
 * only in where the run copy lives and when the brief was generated. Only
 * that declared location metadata is replaced — the run-copy path wherever
 * it appears (header roots and commands, the body's Root line, elided or not)
 * and the header's generated_at — so every other byte must match.
 */
export function normalizeRunLocation(text, root, realRoot = root) {
  const variants = [...new Set([realRoot, root, realRoot.replace(/^\/private(?=\/)/, ''), `/private${root}`])].sort((left, right) => right.length - left.length);
  let out = String(text);
  for (const value of variants) out = out.split(value).join('<run-copy>');
  return out.replace(/^generated_at: .*$/m, 'generated_at: <time>').replace(/(· Root: `)[^`]*(`)/g, '$1<run-copy>$2');
}

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

/** Every corpus file must be a file of the tag with the same git blob hash, and every tag file not excluded must be present. */
async function verifyCorpus(corpus, docsRepo) {
  const failures = [];
  const listing = spawnSync('git', ['-C', docsRepo, 'ls-tree', '-r', CORPUS_TAG], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (listing.status !== 0) return [`cannot list ${CORPUS_TAG} in ${docsRepo}: ${listing.stderr.trim()}`];
  const expected = new Map(
    listing.stdout
      .trim()
      .split('\n')
      .map((line) => line.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/))
      .filter(Boolean)
      .map((match) => [match[2], match[1]])
      .filter(([file]) => !CORPUS_EXCLUDED(file)),
  );
  const actual = await listFiles(corpus);
  for (const file of actual) {
    if (!expected.has(file)) {
      failures.push(`corpus file ${file} is not in ${CORPUS_TAG} (or is excluded)`);
      continue;
    }
    if (gitBlobHash(await readFile(path.join(corpus, file))) !== expected.get(file)) failures.push(`corpus file ${file} differs from ${CORPUS_TAG}`);
  }
  for (const file of expected.keys()) if (!actual.includes(file)) failures.push(`corpus is missing ${file} from ${CORPUS_TAG}`);
  return failures;
}

/** Cold: a fresh CLI process per task. Warm: the engine in-process, p50 of N runs after one warm-up. */
async function measureLatency(dir, corpus, tasks, warmRuns) {
  const perTask = [];
  for (const task of tasks) {
    const root = await makeRunCopy(corpus, path.join(dir, 'latency', task.id), task);
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
    perTask.push({ id: task.id, cold_ms: Math.round(coldMs), warm_p50_ms: Math.round(warm[Math.floor(warm.length / 2)] ?? 0) });
  }
  await rm(path.join(dir, 'latency'), { recursive: true, force: true });
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
export function safeOverflow(result, relations) {
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

export async function run(ctx) {
  const { dir } = ctx;
  const manifest = await readManifest(dir);
  await assertFrozenIdentity(ctx, manifest);
  if (!manifest.pre_run_gates.pass) throw new Error(`Pre-run gates failed; the outcome is no-go and no run starts:\n- ${manifest.pre_run_gates.failures.join('\n- ')}`);
  const cap = requireCap(ctx);
  await mkdir(path.join(dir, 'transcripts'), { recursive: true });
  // Every paid session — research or report turn — starts only within the cap.
  const guard = async (reserve) => (await ledgerSpend(dir)).total + reserve <= cap;
  const pending = [];
  for (const entry of manifest.runs.filter((candidate) => !ctx.only || ctx.only.has(candidate.id))) {
    const base = path.join(dir, 'transcripts', entry.id);
    let meta = await readMeta(base);
    // A run whose research the ledger records as finished is never run again;
    // missing metadata is rebuilt from the ledger and the attempt streams.
    if (!meta && (await finishedAttempts(dir, `run:${entry.id}`)).length > 0) meta = await recoverMeta(dir, entry, manifest.tool_call_cap);
    if (meta?.state !== 'complete') pending.push(entry);
  }
  const skipped = [];
  await pool(pending, ctx.concurrency ?? 4, async (entry) => {
    const treeProblems = await verifyRunTree(entry);
    if (treeProblems.length > 0) throw new Error(`${entry.id}: ${treeProblems.join('; ')}`);
    const prompt = await readFile(path.join(dir, 'prompts', `${entry.id}.txt`), 'utf8');
    if (sha256(prompt) !== entry.prompt_sha256) throw new Error(`${entry.id}: prompt changed since prepare.`);
    const meta = await runAgent(prompt, entry.root, path.join(dir, 'transcripts', entry.id), manifest.tool_call_cap, { ledgerDir: dir, runId: entry.id, guard });
    if (meta.state !== 'complete') {
      skipped.push(`${entry.id}${meta.state === 'report-pending' ? ' (report turn pending)' : ''}`);
      return;
    }
    const metrics = await auditRun(dir, entry, manifest.tool_call_cap, manifest);
    log(ctx, `${entry.id} ${entry.task} ${entry.arm} #${entry.replicate}: ${metrics.tool_calls} calls${metrics.stopped_at_cap ? ' (stopped at the cap; report turn)' : ''}, ${Math.round(metrics.duration_ms / 1000)} s, $${metrics.cost_usd?.toFixed(3) ?? '?'}${metrics.violations.length > 0 ? `, VIOLATIONS: ${metrics.violations.join('; ')}` : ''}`);
  });
  const spend = await ledgerSpend(dir);
  log(ctx, `Spent so far: $${spend.total.toFixed(2)} of the $${cap} cap${spend.unresolved.length > 0 ? ` (includes $${spend.reserved_unresolved.toFixed(2)} reserved for ${spend.unresolved.length} attempt(s) of unknown cost)` : ''}.`);
  if (skipped.length > 0) {
    log(ctx, `Stopped at the cost cap: ${skipped.length} run(s) not finished (${skipped.join(', ')}). Resume with a cap the founder approves.`);
    process.exitCode = 3;
  }
  return { skipped };
}

/**
 * One evaluated run, in two steps that each start only when `guard(reserve)`
 * allows. Research streams; the harness stops it once tool call cap + 1
 * appears. A run with more than `cap` calls in its stream is stopped whether
 * or not the kill landed first; its state is then `report-pending` until a
 * fresh session with no tools writes the report from the transcript up to the
 * boundary. A pending report resumes later without repeating research. With
 * `ledgerDir`, every session is a ledger attempt whose stream is written to
 * its own file as it arrives.
 */
export async function runAgent(prompt, cwd, transcriptBase, cap, { ledgerDir = null, runId = path.basename(transcriptBase), guard = async () => true } = {}) {
  let meta = await readMeta(transcriptBase);
  if (meta?.state === 'complete') return meta;
  let researchEvents;
  if (meta?.state === 'report-pending') {
    const researchText = await readFile(`${transcriptBase}.jsonl`, 'utf8');
    if (sha256(researchText) !== meta.research_sha256) throw new Error(`${runId}: the research transcript changed while its report turn was pending.`);
    researchEvents = parseEvents(researchText);
  } else {
    if (!(await guard(RUN_RESERVE_USD))) return { state: 'not-started' };
    const started = Date.now();
    const research = await paidCall(ledgerDir, 'research', `run:${runId}`, RUN_RESERVE_USD, (attempt) => `${transcriptBase}.attempt-${attempt}.jsonl`, (streamFile) =>
      spawnClaudeStream([...CLAUDE_ARGS, ...AGENT_TOOLS, ...STREAM], prompt, cwd, cap, { streamFile }),
    );
    researchEvents = research.events;
    const stopped = research.killed || collectToolUses(research.events).length > cap;
    meta = {
      state: stopped ? 'report-pending' : 'complete',
      killed: research.killed,
      stopped,
      research_attempt: research.attempt,
      research_sha256: research.sha256,
      research_wall_ms: Date.now() - started,
      report_attempt: null,
      report_sha256: null,
      report_wall_ms: null,
      report_prompt_sha256: null,
    };
    await writeFile(`${transcriptBase}.jsonl`, research.stdout);
    if (research.stderr.trim()) await writeFile(`${transcriptBase}.stderr`, research.stderr);
    await writeMeta(transcriptBase, meta);
  }
  if (meta.state === 'report-pending') {
    if (!(await guard(RUN_RESERVE_USD))) return meta;
    const reportPrompt = renderReportTurn(prompt, researchEvents, cap);
    meta.report_prompt_sha256 = sha256(reportPrompt);
    await writeFile(`${transcriptBase}.report-prompt.txt`, reportPrompt);
    const reportStarted = Date.now();
    const report = await paidCall(ledgerDir, 'report', `report:${runId}`, RUN_RESERVE_USD, (attempt) => `${transcriptBase}.report.attempt-${attempt}.jsonl`, (streamFile) =>
      spawnClaudeStream([...CLAUDE_ARGS, ...NO_TOOLS, ...STREAM], reportPrompt, cwd, 0, { streamFile }),
    );
    meta.report_attempt = report.attempt;
    meta.report_sha256 = report.sha256;
    meta.report_wall_ms = Date.now() - reportStarted;
    meta.state = 'complete';
    await writeFile(`${transcriptBase}.report.jsonl`, report.stdout);
    if (report.stderr.trim()) await writeFile(`${transcriptBase}.report.stderr`, report.stderr);
    await writeMeta(transcriptBase, meta);
  }
  return meta;
}

async function readMeta(transcriptBase) {
  return readFile(`${transcriptBase}.meta.json`, 'utf8').then(JSON.parse, () => null);
}

async function writeMeta(transcriptBase, meta) {
  await writeFile(`${transcriptBase}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`);
}

/** Finished ledger attempts for a job, each with its start record (file, attempt). */
async function finishedAttempts(dir, job) {
  const ledger = await readLedger(dir);
  const starts = new Map(ledger.filter((record) => record.event === 'start' && record.job === job).map((record) => [record.call, record]));
  return ledger.filter((record) => record.event === 'finish' && starts.has(record.call)).map((finish) => ({ ...starts.get(finish.call), finish }));
}

/**
 * Rebuilds a run's metadata from the ledger when it is missing (for example
 * after an interruption between a session's finish and the metadata write).
 * The transcripts are copied from the immutable attempt streams, whose hashes
 * the ledger holds; nothing is re-run.
 */
async function recoverMeta(dir, entry, cap) {
  const base = path.join(dir, 'transcripts', entry.id);
  const restore = async (job, target) => {
    const attempts = await finishedAttempts(dir, job);
    if (attempts.length === 0) return null;
    if (attempts.length > 1) throw new Error(`${entry.id}: ${attempts.length} finished attempts for ${job}; refusing to choose one.`);
    const [attempt] = attempts;
    const text = await readFile(attempt.file, 'utf8');
    if (sha256(text) !== attempt.finish.stream_sha256) throw new Error(`${entry.id}: the attempt stream for ${job} does not match the ledger.`);
    await writeFile(target, text);
    return { attempt: attempt.attempt, sha256: attempt.finish.stream_sha256, text };
  };
  const research = await restore(`run:${entry.id}`, `${base}.jsonl`);
  const stopped = collectToolUses(parseEvents(research.text)).length > cap;
  const report = stopped ? await restore(`report:${entry.id}`, `${base}.report.jsonl`) : null;
  const meta = {
    state: !stopped || report ? 'complete' : 'report-pending',
    recovered: true,
    stopped,
    research_attempt: research.attempt,
    research_sha256: research.sha256,
    report_attempt: report?.attempt ?? null,
    report_sha256: report?.sha256 ?? null,
  };
  await writeMeta(base, meta);
  return meta;
}

export function renderReportTurn(prompt, events, cap) {
  return REPORT_TURN_TEMPLATE.replace('{prompt}', prompt).replace('{transcript}', renderResearchTranscript(events, cap));
}

/**
 * The boundary of a research stream: the first event that issues a tool call
 * beyond `cap` (distinct tool_use ids), and the index of that call's block.
 * Null when the stream never exceeds the cap.
 */
export function findBoundary(events, cap) {
  const seen = new Set();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.type !== 'assistant') continue;
    const blocks = event.message?.content ?? [];
    for (let block = 0; block < blocks.length; block += 1) {
      if (blocks[block].type !== 'tool_use' || seen.has(blocks[block].id)) continue;
      if (seen.size === cap) return { event: index, block, allowed: new Set(seen) };
      seen.add(blocks[block].id);
    }
  }
  return null;
}

/**
 * The agent's text, its first `cap` tool calls, and their delivered results,
 * truncated at the boundary: assistant content from the excess tool-use block
 * onward is dropped (it may already reflect a result beyond the cap), as is
 * every result of an excess call. Results of allowed calls delivered after the
 * boundary are kept: they answer calls issued within the allowance.
 */
export function renderResearchTranscript(events, cap) {
  const boundary = findBoundary(events, cap);
  const allowed = boundary?.allowed ?? new Set(collectToolUses(events).map((use) => use.id));
  const results = collectToolResults(events);
  const parts = [];
  const seenText = new Set();
  const shown = new Set();
  const last = boundary ? boundary.event : events.length - 1;
  for (let index = 0; index <= last; index += 1) {
    const event = events[index];
    if (event.type !== 'assistant') continue;
    const blocks = event.message?.content ?? [];
    const end = boundary && index === boundary.event ? boundary.block : blocks.length;
    for (const block of blocks.slice(0, end)) {
      if (block.type === 'text' && block.text.trim() && !seenText.has(block.text)) {
        seenText.add(block.text);
        parts.push(`<assistant-text>\n${block.text.trim()}\n</assistant-text>`);
      } else if (block.type === 'tool_use' && allowed.has(block.id) && !shown.has(block.id)) {
        shown.add(block.id);
        const result = results.get(block.id);
        parts.push(
          `<tool-call name="${block.name}">\n${JSON.stringify(block.input)}\n</tool-call>\n<tool-result>\n${result ?? '(no result delivered: the session was stopped before this result arrived)'}\n</tool-result>`,
        );
      }
    }
  }
  return parts.join('\n\n');
}

/**
 * The checks every session must pass: an init event with the model, the
 * recorded Claude Code version (exact), permission mode dontAsk, no MCP
 * server, and exactly the expected tools; and, when a result is required, a
 * successful result with no permission denial whose model usage is only the
 * evaluation model.
 */
export function sessionProblems(events, { label, tools, version, requireResult }) {
  const problems = [];
  const init = events.find((event) => event.type === 'system' && event.subtype === 'init');
  const result = [...events].reverse().find((event) => event.type === 'result') ?? null;
  if (!init) return [`${label}: no init event`];
  if (init.model !== MODEL) problems.push(`${label}: model ${init.model}`);
  if (version && init.claude_code_version !== version) problems.push(`${label}: Claude Code ${init.claude_code_version}, prepared with ${version}`);
  if (init.permissionMode !== 'dontAsk') problems.push(`${label}: permission mode ${init.permissionMode}`);
  if ((init.mcp_servers ?? []).length > 0) problems.push(`${label}: MCP servers ${JSON.stringify(init.mcp_servers)}`);
  if (JSON.stringify([...(init.tools ?? [])].sort()) !== JSON.stringify([...tools].sort())) problems.push(`${label}: tools ${JSON.stringify(init.tools)}, expected ${JSON.stringify(tools)}`);
  if (requireResult) {
    if (!result || result.is_error || result.subtype !== 'success') problems.push(`${label}: did not complete (${result?.subtype ?? 'no result'}${result?.is_error ? ', is_error' : ''})`);
    const models = Object.keys(result?.modelUsage ?? {});
    if (models.length !== 1 || models[0] !== MODEL) problems.push(`${label}: model usage ${JSON.stringify(models)}`);
  }
  if ((result?.permission_denials ?? []).length > 0) problems.push(`${label}: ${result.permission_denials.length} permission denials`);
  return problems;
}

// Effective list prices per token, fitted exactly to A5's 32 run results
// (claude-opus-5-5): used only to estimate a session that emitted no
// total_cost_usd (stopped or interrupted).
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

/** Tool calls, tokens read, wall time, cost, the final report, the boundary audit, artifact integrity, and session checks for one run. */
export async function auditRun(dir, entry, cap, manifest = null) {
  const base = path.join(dir, 'transcripts', entry.id);
  const researchText = await readFile(`${base}.jsonl`, 'utf8');
  const research = parseEvents(researchText);
  const reportText = await readFile(`${base}.report.jsonl`, 'utf8').catch(() => null);
  const reportEvents = reportText === null ? null : parseEvents(reportText);
  const meta = await readFile(`${base}.meta.json`, 'utf8').then(JSON.parse, () => ({}));
  const version = manifest ? parseVersion(manifest.claude_version) : null;
  const realRoot = await realpath(entry.root);
  const researchResult = research.find((event) => event.type === 'result') ?? null;
  const reportResult = reportEvents?.find((event) => event.type === 'result') ?? null;
  const calls = collectToolUses(research);
  const stopped = calls.length > cap;
  const boundary = findBoundary(research, cap);
  const counted = calls.filter((use) => !boundary || boundary.allowed.has(use.id));
  const results = collectToolResults(research);
  const violations = [];

  // Artifact integrity. With a ledger, the expected transcripts come from it —
  // the single finished attempt of each session and its immutable stream —
  // never from the metadata alone; missing or partial metadata is a finding,
  // not a reason to skip verification.
  const ledger = await readLedger(dir);
  if (ledger.length > 0) {
    const expect = async (kind, job, current, metaAttempt, metaHash) => {
      const attempts = await finishedAttempts(dir, job);
      if (attempts.length !== 1) return [`${attempts.length} finished ${kind} attempts in the ledger`];
      const [attempt] = attempts;
      const out = [];
      if (current === null || sha256(current) !== attempt.finish.stream_sha256) out.push(`${kind} transcript differs from the ledger record`);
      const streamed = await readFile(attempt.file, 'utf8').catch(() => null);
      if (streamed === null || sha256(streamed) !== attempt.finish.stream_sha256) out.push(`${kind} attempt stream is missing or differs from the ledger record`);
      if (metaAttempt !== attempt.attempt || metaHash !== attempt.finish.stream_sha256) out.push(`run metadata is missing or does not match the ledger for the ${kind} session`);
      return out;
    };
    violations.push(...(await expect('research', `run:${entry.id}`, researchText, meta.research_attempt, meta.research_sha256)));
    if (stopped) violations.push(...(await expect('report-turn', `report:${entry.id}`, reportText, meta.report_attempt, meta.report_sha256)));
    else if ((await finishedAttempts(dir, `report:${entry.id}`)).length > 0) violations.push('report turn recorded for a run that was not stopped');
  } else {
    if (!meta.research_sha256 || sha256(researchText) !== meta.research_sha256) violations.push('research transcript has no matching run metadata');
    if (stopped && (!meta.report_sha256 || sha256(reportText ?? '') !== meta.report_sha256)) violations.push('report-turn transcript has no matching run metadata');
  }
  if (meta.state !== undefined && meta.state !== 'complete') violations.push(`run state is ${meta.state}`);
  if (entry.prompt_sha256) {
    const prompt = await readFile(path.join(dir, 'prompts', `${entry.id}.txt`), 'utf8').catch(() => null);
    if (prompt === null || sha256(prompt) !== entry.prompt_sha256) violations.push('prompt changed since prepare');
  }

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
  violations.push(...sessionProblems(research, { label: 'research', tools: RESEARCH_TOOLS, version, requireResult: !stopped }));
  const excessIds = new Set(calls.filter((use) => boundary && !boundary.allowed.has(use.id)).map((use) => use.id));
  const resultChars = counted.reduce((sum, use) => sum + [...(results.get(use.id) ?? '')].length, 0);
  let report = '';
  if (stopped) {
    if (!boundary) violations.push('stopped run without an identifiable boundary');
    const reportPrompt = await readFile(`${base}.report-prompt.txt`, 'utf8').catch(() => null);
    const prompt = await readFile(path.join(dir, 'prompts', `${entry.id}.txt`), 'utf8').catch(() => null);
    // The report turn's input must be exactly the boundary-truncated replay of the saved stream.
    if (!reportPrompt || prompt === null || reportPrompt !== renderReportTurn(prompt, research, cap)) violations.push('report-turn prompt is not the boundary-truncated replay of the research stream');
    if (!reportEvents) violations.push('stopped run has no report turn');
    else {
      violations.push(...sessionProblems(reportEvents, { label: 'report turn', tools: [], version, requireResult: true }));
      if (collectToolUses(reportEvents).length > 0) violations.push('report turn used tools');
    }
    report = reportResult?.result ?? '';
  } else {
    report = researchResult?.result ?? '';
  }
  const researchUsage = researchResult?.usage ?? streamUsage(research);
  const researchCost = researchResult?.total_cost_usd ?? estimateCost(researchUsage);
  return {
    model: research.find((event) => event.type === 'system')?.model ?? null,
    tool_calls: counted.length,
    stopped_at_cap: stopped,
    calls_issued: calls.length,
    // Observed beyond the boundary in the research stream; none of it reaches
    // the report turn (checked above).
    excess_results_observed: [...results.keys()].filter((id) => excessIds.has(id)).length,
    tool_calls_by_name: counted.reduce((counts, use) => ({ ...counts, [use.name]: (counts[use.name] ?? 0) + 1 }), {}),
    reads,
    tool_result_chars: resultChars,
    tool_result_tokens_est: Math.ceil(resultChars / 4),
    duration_ms: (researchResult?.duration_ms ?? meta.research_wall_ms ?? 0) + (reportResult?.duration_ms ?? meta.report_wall_ms ?? 0),
    usage: sumUsage([researchUsage, reportResult?.usage]),
    cost_usd: (researchCost ?? 0) + (reportResult?.total_cost_usd ?? 0) || null,
    cost_estimated: !researchResult,
    report,
    violations,
  };
}

/** The run copy must still hash to its prepared digest. */
async function verifyRunTree(entry) {
  if (!entry.tree_sha256) return ['no prepared tree digest'];
  return treeDigest(await hashTree(entry.root)) === entry.tree_sha256 ? [] : ['run copy changed since prepare'];
}

export function parseEvents(stdout) {
  return String(stdout)
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

// ----------------------------------------------------------------- ledger

/**
 * The spend ledger (append-only, `ledger.jsonl`): one `start` record before
 * every paid call — its job, attempt number (counted across invocations), and
 * the file its stream is written to as it arrives — and one `finish` record
 * with its cost and stream hash. Manifest writes are recorded too.
 */
export async function readLedger(dir) {
  const text = await readFile(path.join(dir, 'ledger.jsonl'), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function appendLedger(dir, record) {
  await appendFile(path.join(dir, 'ledger.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
}

/** Attempts already started for a job, across every invocation. */
export async function attemptsOf(dir, job) {
  return (await readLedger(dir)).filter((record) => record.event === 'start' && record.job === job).length;
}

/**
 * One paid session as a ledger attempt. Without a ledger (unit use) the
 * attempt is 1 and nothing is recorded.
 */
async function paidCall(ledgerDir, kind, job, reserve, fileFor, invoke) {
  const attempt = ledgerDir ? (await attemptsOf(ledgerDir, job)) + 1 : 1;
  const file = fileFor(attempt);
  const call = `${job}#${attempt}`;
  if (ledgerDir) await appendLedger(ledgerDir, { event: 'start', call, kind, job, attempt, reserve_usd: reserve, file });
  const output = await invoke(file);
  const events = parseEvents(output.stdout);
  const result = [...events].reverse().find((event) => event.type === 'result');
  const reported = typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : null;
  const estimated = reported === null ? estimateCost(streamUsage(events)) : null;
  const cost = reported ?? (estimated && estimated > 0 ? estimated : null);
  const hash = sha256(output.stdout);
  if (ledgerDir) {
    await appendLedger(ledgerDir, { event: 'finish', call, cost_usd: cost, cost_source: reported !== null ? 'reported' : cost !== null ? 'estimated' : 'unknown', stream_sha256: hash });
  }
  return { ...output, events, attempt, call, file, sha256: hash, killed: output.stopped, cost };
}

/**
 * Spend from the ledger alone — the one source for the cap and the report.
 * An attempt counts its reported cost, else its cost estimated from the usage
 * in its stream file (stopped or interrupted sessions), else its reserve,
 * listed as unresolved. Nothing counts as zero for lack of a number.
 */
export async function ledgerSpend(dir) {
  const entries = await readLedger(dir);
  const finishes = new Map(entries.filter((record) => record.event === 'finish').map((record) => [record.call, record]));
  const spend = { total: 0, by_kind: { research: 0, report: 0, grader: 0 }, attempts: 0, estimated: [], unresolved: [], reserved_unresolved: 0 };
  for (const start of entries.filter((record) => record.event === 'start')) {
    spend.attempts += 1;
    const finish = finishes.get(start.call);
    let cost = typeof finish?.cost_usd === 'number' ? finish.cost_usd : null;
    if (finish?.cost_source === 'estimated') spend.estimated.push(start.call);
    if (cost === null) {
      const streamed = start.file ? await readFile(start.file, 'utf8').catch(() => '') : '';
      const estimate = estimateCost(streamUsage(parseEvents(streamed)));
      if (estimate && estimate > 0) {
        cost = estimate;
        spend.estimated.push(start.call);
      } else {
        cost = start.reserve_usd;
        spend.unresolved.push(start.call);
        spend.reserved_unresolved += start.reserve_usd;
      }
    }
    spend.total += cost;
    spend.by_kind[start.kind] = (spend.by_kind[start.kind] ?? 0) + cost;
  }
  return spend;
}

// ------------------------------------------------------------------ smoke

/**
 * Mechanics check before any evaluation run: one tuning task, baseline arm,
 * with a tiny cap, to show the stop and the report turn work. Results are not
 * evaluation data and are never graded.
 */
async function smoke(ctx, opts) {
  const { dir } = ctx;
  const task = parseTasks(await readFile(path.join(opts.labelsDir, 'recall-evaluation.md'), 'utf8'), 'tuning').find((entry) => entry.id === opts.task);
  if (!task) throw new Error(`smoke: no tuning task ${opts.task}.`);
  await mkdir(path.join(dir, 'transcripts'), { recursive: true });
  await mkdir(path.join(dir, 'prompts'), { recursive: true });
  const root = await makeRunCopy(path.resolve(opts.corpus), path.join(dir, 'runs', 'smoke'), task);
  const prompt = renderPrompt(task, await readStartupFiles(root, 'baseline'))
    .replaceAll(`at most ${TOOL_CALL_CAP} tool calls`, `at most ${opts.statedCap} tool calls`)
    .replaceAll(`when you make call ${TOOL_CALL_CAP + 1}`, `when you make call ${opts.statedCap + 1}`)
    .replaceAll(`from your first ${TOOL_CALL_CAP} calls`, `from your first ${opts.statedCap} calls`);
  await writeFile(path.join(dir, 'prompts', 'smoke.txt'), prompt);
  const outcome = await runAgent(prompt, root, path.join(dir, 'transcripts', 'smoke'), opts.cap, { ledgerDir: dir, runId: 'smoke' });
  const metrics = await auditRun(dir, { id: 'smoke', root }, opts.cap);
  log(ctx, JSON.stringify({ ...outcome, ...metrics, report: `${metrics.report.slice(0, 400)}…` }, null, 2));
}

// ------------------------------------------------------------------ grade

export async function grade(ctx) {
  const { dir } = ctx;
  const manifest = await readManifest(dir);
  await assertFrozenIdentity(ctx, manifest);
  const cap = requireCap(ctx);
  const labels = await loadLabels(dir, manifest);
  const gradingDir = path.join(dir, 'grading');
  await mkdir(path.join(gradingDir, 'empty-cwd'), { recursive: true });
  const tasks = manifest.tasks.filter((candidate) => !ctx.only || ctx.only.has(candidate.id));

  // Pass 1: two independent graders per report pair and per brief.
  const jobs = [];
  for (const task of tasks) {
    const label = labels.get(task.id);
    if (!label) throw new Error(`${task.id}: no label block.`);
    for (const replicate of replicatesOf(manifest, task.id)) {
      const reportJobs = reportJobsFor(task, label, replicate, await reportsFor(dir, manifest, task.id, replicate));
      jobs.push(reportJobs.g1, reportJobs.g2);
    }
    const briefJobs = briefJobsFor(task, label, await readFile(path.join(dir, 'briefs', `${task.id}.md`), 'utf8'));
    jobs.push(briefJobs.g1, briefJobs.g2);
  }
  const first = await runGraders(ctx, jobs, manifest, cap);

  // Pass 2: a third grader wherever the first two disagree on any verdict.
  const tiebreaks = [];
  if (first.skipped.length === 0) {
    for (const task of tasks) {
      const label = labels.get(task.id);
      for (const replicate of replicatesOf(manifest, task.id)) {
        const reportJobs = reportJobsFor(task, label, replicate, await reportsFor(dir, manifest, task.id, replicate));
        const pair = await Promise.all(['g1', 'g2'].map((grader) => requireGrade(dir, reportJobs[grader], manifest)));
        if (reportDisagreements(label, ...pair).length > 0) tiebreaks.push(reportJobs.g3);
      }
      const briefJobs = briefJobsFor(task, label, await readFile(path.join(dir, 'briefs', `${task.id}.md`), 'utf8'));
      const pair = await Promise.all(['g1', 'g2'].map((grader) => requireGrade(dir, briefJobs[grader], manifest)));
      if (briefDisagreements(label, ...pair).length > 0) tiebreaks.push(briefJobs.g3);
    }
  }
  const second = await runGraders(ctx, tiebreaks, manifest, cap);
  const spend = await ledgerSpend(dir);
  log(ctx, `graded: ${jobs.length} first-pass jobs, ${tiebreaks.length} tie-breaks; spent so far $${spend.total.toFixed(2)} of the $${cap} cap`);
  return { skipped: [...first.skipped, ...second.skipped], tiebreaks: tiebreaks.length };
}

async function reportsFor(dir, manifest, taskId, replicate) {
  const reports = {};
  for (const arm of ['baseline', 'brief']) {
    const entry = manifest.runs.find((candidate) => candidate.task === taskId && candidate.arm === arm && candidate.replicate === replicate);
    reports[arm] = (await auditRun(dir, entry, manifest.tool_call_cap, manifest)).report;
  }
  return reports;
}

function blindOrder(seed) {
  return Number.parseInt(sha256(seed).slice(0, 2), 16) % 2 === 1 ? { P: 'brief', Q: 'baseline' } : { P: 'baseline', Q: 'brief' };
}

/** The three report-grading jobs for one pair, with their deterministic orders. */
export function reportJobsFor(task, label, replicate, reports) {
  const firstOrder = blindOrder(`a7-blind:${task.id}:${replicate}`);
  const orders = { g1: firstOrder, g2: { P: firstOrder.Q, Q: firstOrder.P }, g3: blindOrder(`a7-tiebreak:${task.id}:${replicate}`) };
  return Object.fromEntries(Object.entries(orders).map(([grader, order]) => [grader, reportJob(task, label, replicate, grader, order, reports)]));
}

export function briefJobsFor(task, label, brief) {
  return Object.fromEntries(['g1', 'g2', 'g3'].map((grader) => [grader, { kind: 'brief', name: `${task.id}-brief-${grader}`, task, label, grader, prompt: briefGraderPrompt(label, brief), schema: briefSchema(label) }]));
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
  return { kind: 'reports', name: `${task.id}-r${replicate}-reports-${grader}`, task, label, replicate, grader, order, redactions, prompt: reportGraderPrompt(label, redacted), schema: reportSchema(label) };
}

/**
 * Runs grader jobs. A cached grade is reused only when it is bound to this
 * job's exact inputs and its own valid session record; otherwise the stage
 * stops. Attempts are counted across invocations (MAX_GRADE_ATTEMPTS in all),
 * every attempt's stream is kept under its own number, and an invalid grade
 * is kept but never scored.
 */
async function runGraders(ctx, jobs, manifest, cap) {
  const { dir } = ctx;
  const gradingDir = path.join(dir, 'grading');
  const workDir = path.join(gradingDir, 'empty-cwd');
  const skipped = [];
  await pool(jobs, ctx.concurrency ?? 4, async (job) => {
    const target = path.join(gradingDir, `${job.name}.json`);
    if (await exists(target)) {
      const problems = await gradeProblems(dir, JSON.parse(await readFile(target, 'utf8')), job, manifest);
      if (problems.length > 0) throw new Error(`${job.name}: the saved grade does not match its inputs or its session (${problems.join('; ')}); refusing to reuse it.`);
      return;
    }
    await writeFile(path.join(gradingDir, `${job.name}.prompt.txt`), job.prompt);
    for (;;) {
      if ((await attemptsOf(dir, `grade:${job.name}`)) >= MAX_GRADE_ATTEMPTS) throw new Error(`${job.name}: no valid grade after ${MAX_GRADE_ATTEMPTS} attempts; grading is incomplete.`);
      if ((await ledgerSpend(dir)).total + GRADE_RESERVE_USD > cap) {
        skipped.push(job.name);
        return;
      }
      const call = await paidCall(dir, 'grader', `grade:${job.name}`, GRADE_RESERVE_USD, (attempt) => path.join(gradingDir, `${job.name}.attempt-${attempt}.stdout.jsonl`), (streamFile) =>
        spawnClaudeStream([...CLAUDE_ARGS, ...NO_TOOLS, ...STREAM, '--json-schema', JSON.stringify(job.schema)], job.prompt, workDir, Infinity, { streamFile }),
      );
      const result = [...call.events].reverse().find((event) => event.type === 'result');
      const graded = result?.structured_output ?? null;
      const record = gradeRecord(job, call, graded);
      const problems = [
        ...sessionProblems(call.events, { label: 'grader', tools: GRADER_TOOLS, version: parseVersion(manifest.claude_version), requireResult: true }),
        ...(graded ? (job.kind === 'reports' ? validateReportGrade(job.label, graded) : validateBriefGrade(job.label, graded)) : ['no structured output']),
      ];
      if (problems.length === 0) {
        await writeFile(target, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
        log(ctx, `graded ${job.name} (attempt ${call.attempt})`);
        return;
      }
      await writeFile(path.join(gradingDir, `${job.name}.attempt-${call.attempt}.invalid.json`), `${JSON.stringify({ ...record, problems }, null, 2)}\n`, { flag: 'wx' });
    }
  });
  if (skipped.length > 0) {
    log(ctx, `Stopped at the cost cap: ${skipped.length} grading job(s) not started. Resume with a cap the founder approves.`);
    process.exitCode = 3;
  }
  return { skipped };
}

/** A grade bound to its exact inputs (prompt, schema, arm order) and to its session record (stream file and ledger attempt). */
function gradeRecord(job, call, graded) {
  const init = call.events.find((event) => event.type === 'system' && event.subtype === 'init') ?? {};
  const result = [...call.events].reverse().find((event) => event.type === 'result') ?? {};
  return {
    task: job.task.id,
    kind: job.kind,
    replicate: job.replicate ?? null,
    grader: job.grader,
    order: job.order ?? null,
    redactions: job.redactions ?? null,
    attempt: call.attempt,
    call: call.call,
    prompt_sha256: sha256(job.prompt),
    schema_sha256: sha256(JSON.stringify(job.schema)),
    stream_file: path.basename(call.file),
    stream_sha256: call.sha256,
    provenance: {
      session_id: init.session_id ?? null,
      model: init.model ?? null,
      claude_code_version: init.claude_code_version ?? null,
      permission_mode: init.permissionMode ?? null,
      tools: init.tools ?? null,
      mcp_servers: init.mcp_servers ?? null,
      result_subtype: result.subtype ?? null,
      is_error: result.is_error ?? null,
      model_usage: Object.keys(result.modelUsage ?? {}),
    },
    cost_usd: call.cost,
    graded,
  };
}

/**
 * Why a saved grade cannot be used for `job`: its inputs differ (prompt,
 * schema, order), its stream file is missing or changed, its session fails
 * the session checks, its structured output differs from the record, the
 * ledger does not hold its attempt, or its verdicts do not cover the checklist.
 */
export async function gradeProblems(dir, record, job, manifest) {
  const problems = [];
  if (record.prompt_sha256 !== sha256(job.prompt)) problems.push('graded a different input (stale grade)');
  if (record.schema_sha256 !== sha256(JSON.stringify(job.schema))) problems.push('graded under a different schema');
  if (job.order && JSON.stringify(record.order) !== JSON.stringify(job.order)) problems.push('arm order differs');
  const stream = record.stream_file ? await readFile(path.join(dir, 'grading', record.stream_file), 'utf8').catch(() => null) : null;
  if (stream === null) return [...problems, 'session stream is missing'];
  if (sha256(stream) !== record.stream_sha256) problems.push('session stream changed');
  const events = parseEvents(stream);
  problems.push(...sessionProblems(events, { label: 'grader', tools: GRADER_TOOLS, version: parseVersion(manifest.claude_version), requireResult: true }));
  const output = [...events].reverse().find((event) => event.type === 'result')?.structured_output ?? null;
  if (JSON.stringify(output) !== JSON.stringify(record.graded)) problems.push('recorded verdicts differ from the session output');
  const finish = (await readLedger(dir)).find((entry) => entry.event === 'finish' && entry.call === record.call);
  if (!finish || finish.stream_sha256 !== record.stream_sha256) problems.push('the ledger does not record this attempt');
  problems.push(...(job.kind === 'reports' ? validateReportGrade(job.label, record.graded) : validateBriefGrade(job.label, record.graded)));
  return problems;
}

/** The saved grade for `job`, verified; scoring stops on a missing or unusable grade. */
async function requireGrade(dir, job, manifest) {
  const record = await readFile(path.join(dir, 'grading', `${job.name}.json`), 'utf8').then(JSON.parse, () => null);
  if (!record) throw new Error(`grading is incomplete: ${job.name} is missing (run \`grade\`).`);
  const problems = await gradeProblems(dir, record, job, manifest);
  if (problems.length > 0) throw new Error(`${job.name}: ${problems.join('; ')}`);
  return record;
}

/** Display keys of a label's checklist: `M1(a)` for a lettered clause, `M3` for a single-clause item. */
export function checklistKeys(label) {
  return label.clauses.map((clause) => (clause.clause === '-' ? clause.item : `${clause.item}(${clause.clause})`));
}

/**
 * A report grade must give, for each of P and Q, exactly one verdict per
 * checklist key and per forbidden claim — no missing, extra, or duplicate
 * key — with boolean verdicts.
 */
export function validateReportGrade(label, graded) {
  const problems = [];
  for (const name of ['P', 'Q']) {
    const report = graded?.[name];
    if (!report || !Array.isArray(report.clauses) || !Array.isArray(report.forbidden) || typeof report.states_no_governing_memory !== 'boolean') {
      problems.push(`${name}: malformed grade`);
      continue;
    }
    problems.push(...exactKeys(`${name} clauses`, report.clauses.map((entry) => entry?.key), checklistKeys(label)));
    problems.push(...exactKeys(`${name} forbidden`, report.forbidden.map((entry) => entry?.id), label.forbidden));
    if (report.clauses.some((entry) => typeof entry?.stated !== 'boolean' || typeof entry?.attributed !== 'boolean')) problems.push(`${name}: non-boolean clause verdict`);
    if (report.forbidden.some((entry) => typeof entry?.violated !== 'boolean')) problems.push(`${name}: non-boolean forbidden verdict`);
  }
  return problems;
}

/** A brief grade must give exactly one verdict per forbidden claim, plus the governing-memory verdict. */
export function validateBriefGrade(label, graded) {
  if (!graded || !Array.isArray(graded.forbidden) || typeof graded.presents_governing_memory_for_no_match !== 'boolean') return ['malformed grade'];
  const problems = exactKeys('forbidden', graded.forbidden.map((entry) => entry?.id), label.forbidden);
  if (graded.forbidden.some((entry) => typeof entry?.violated !== 'boolean')) problems.push('non-boolean forbidden verdict');
  return problems;
}

function exactKeys(what, actual, expected) {
  const problems = [];
  const counts = new Map();
  for (const key of actual) counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const key of expected) if (!counts.has(key)) problems.push(`${what}: missing ${key}`);
  for (const [key, count] of counts) {
    if (!expected.includes(key)) problems.push(`${what}: unexpected ${key}`);
    else if (count > 1) problems.push(`${what}: duplicate ${key}`);
  }
  return problems;
}

/** Every verdict the two report graders disagree on: clause stated/attributed, forbidden claims, no-governing. */
export function reportDisagreements(label, first, second) {
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

/** Every verdict the two brief graders disagree on: forbidden claims and the governing-memory verdict. */
export function briefDisagreements(label, first, second) {
  const a = briefVerdicts(label, first);
  const b = briefVerdicts(label, second);
  const out = label.forbidden.filter((id) => a.forbidden[id] !== b.forbidden[id]);
  if (a.governing !== b.governing) out.push('governing');
  return out;
}

/** One grader's verdicts for one arm, keyed like the label (`M1:a`); the grade must be valid. */
export function armVerdicts(label, grade, arm) {
  const problems = validateReportGrade(label, grade.graded);
  if (problems.length > 0) throw new Error(`invalid report grade (${grade.task} r${grade.replicate} ${grade.grader}): ${problems.join('; ')}`);
  const name = Object.entries(grade.order).find(([, value]) => value === arm)[0];
  const graded = grade.graded[name];
  const byKey = new Map(graded.clauses.map((entry) => [entry.key, entry]));
  const keys = checklistKeys(label);
  const clauses = Object.fromEntries(
    label.clauses.map((clause, index) => {
      const found = byKey.get(keys[index]);
      // The rubric makes attributed false whenever stated is false.
      return [`${clause.item}:${clause.clause}`, { stated: found.stated, attributed: found.stated && found.attributed }];
    }),
  );
  const forbidden = Object.fromEntries(label.forbidden.map((id) => [id, graded.forbidden.find((entry) => entry.id === id).violated]));
  return { clauses, forbidden, noGoverning: graded.states_no_governing_memory };
}

export function briefVerdicts(label, grade) {
  const problems = validateBriefGrade(label, grade.graded);
  if (problems.length > 0) throw new Error(`invalid brief grade (${grade.task} ${grade.grader}): ${problems.join('; ')}`);
  return {
    forbidden: Object.fromEntries(label.forbidden.map((id) => [id, grade.graded.forbidden.find((entry) => entry.id === id).violated])),
    governing: grade.graded.presents_governing_memory_for_no_match,
  };
}

/**
 * Removes only the brief arm's own startup-file path, as A5 did after its
 * redaction fix. Blinding is partial: reports may mention "the brief".
 */
function redactArm(text) {
  let count = 0;
  const redacted = String(text).replace(/sessions\/active\/eval\/brief\.md/g, () => {
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
  '- Give exactly one entry per checklist key and per forbidden claim, using the keys exactly as listed.',
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
    `Checklist keys (grade exactly these, once each, for each report): ${checklistKeys(label).join(', ') || 'none (no-match task)'}`,
    `Forbidden claims (once each, for each report): ${label.forbidden.join(', ')}`,
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
  '- `presents_governing_memory_for_no_match`: for a no-match label, whether the brief presents any decision or doc as governing, planning, or authorizing the task; false for a positive label.',
  '- Give exactly one entry per forbidden claim, using the IDs exactly as listed.',
  '- Evidence: a short verbatim quote (at most 200 characters) for every violation, and for the closest call.',
].join('\n');

function briefGraderPrompt(label, brief) {
  return [BRIEF_RUBRIC, '', 'Label:', '<<<', label.block, '>>>', '', `Forbidden claims (once each): ${label.forbidden.join(', ')}`, '', 'Brief:', '<<<', brief, '>>>'].join('\n');
}

export function reportSchema(label) {
  const keys = checklistKeys(label);
  const report = {
    type: 'object',
    properties: {
      clauses: {
        type: 'array',
        minItems: keys.length,
        maxItems: keys.length,
        items: {
          type: 'object',
          properties: { key: keys.length > 0 ? { type: 'string', enum: keys } : { type: 'string' }, stated: { type: 'boolean' }, attributed: { type: 'boolean' }, evidence: { type: 'string' } },
          required: ['key', 'stated', 'attributed', 'evidence'],
          additionalProperties: false,
        },
      },
      forbidden: forbiddenSchema(label),
      states_no_governing_memory: { type: 'boolean' },
      notes: { type: 'string' },
    },
    required: ['clauses', 'forbidden', 'states_no_governing_memory', 'notes'],
    additionalProperties: false,
  };
  return { type: 'object', properties: { P: report, Q: report }, required: ['P', 'Q'], additionalProperties: false };
}

export function briefSchema(label) {
  return {
    type: 'object',
    properties: {
      forbidden: forbiddenSchema(label),
      presents_governing_memory_for_no_match: { type: 'boolean' },
      closest_call: { type: 'string' },
      notes: { type: 'string' },
    },
    required: ['forbidden', 'presents_governing_memory_for_no_match', 'closest_call', 'notes'],
    additionalProperties: false,
  };
}

function forbiddenSchema(label) {
  return {
    type: 'array',
    minItems: label.forbidden.length,
    maxItems: label.forbidden.length,
    items: {
      type: 'object',
      properties: { id: { type: 'string', enum: label.forbidden }, violated: { type: 'boolean' }, evidence: { type: 'string' }, reasoning: { type: 'string' } },
      required: ['id', 'violated', 'evidence', 'reasoning'],
      additionalProperties: false,
    },
  };
}

// ---------------------------------------------------- screen and confirm

/** Stage 1 screen: score stage-1 replicates and write which tasks need confirmation runs. */
export async function screen(ctx) {
  const manifest = await readManifest(ctx.dir);
  await assertFrozenIdentity(ctx, manifest);
  const { rows } = await collectRows(ctx.dir, manifest, { stage: 1 });
  const result = screenRows(rows);
  await writeFile(path.join(ctx.dir, 'screen.json'), `${JSON.stringify(result, null, 2)}\n`);
  log(ctx, JSON.stringify(result, null, 2));
  return result;
}

/**
 * Pre-registered stage-1 screen (A7 protocol › No-regression). A positive task
 * is flagged when its brief mean recall is more than `screenTaskDrop` below
 * the baseline's, or when any clause the baseline states in at least two of
 * three replicates is stated by the brief arm at least two times fewer.
 */
export function screenRows(rows) {
  const flagged = [];
  for (const row of rows.filter((candidate) => candidate.positive)) {
    const reasons = [];
    const drop = row.recall.baseline.mean - row.recall.brief.mean;
    if (drop > REGRESSION.screenTaskDrop + 1e-9) reasons.push(`task recall ${row.recall.brief.mean.toFixed(3)} vs ${row.recall.baseline.mean.toFixed(3)}`);
    for (const entry of row.clause_counts) {
      if (entry.baseline >= 2 && entry.baseline - entry.brief >= 2) reasons.push(`${entry.clause} ${entry.baseline}/${entry.n} → ${entry.brief}/${entry.n}`);
    }
    if (reasons.length > 0) flagged.push({ id: row.id, reasons });
  }
  return { flagged, systematic: flagged.length > REGRESSION.maxFlagged };
}

/** Stage 2: replicates 4–6 for the flagged tasks, prepared and checked exactly as stage 1. */
export async function confirm(ctx) {
  const { dir } = ctx;
  const manifest = await readManifest(dir);
  await assertFrozenIdentity(ctx, manifest);
  const screened = JSON.parse(await readFile(path.join(dir, 'screen.json'), 'utf8'));
  const current = screenRows((await collectRows(dir, manifest, { stage: 1 })).rows);
  if (JSON.stringify(screened) !== JSON.stringify(current)) throw new Error('screen.json does not match the stage-1 grades; rerun `screen`.');
  if (screened.systematic) {
    log(ctx, `${screened.flagged.length} tasks flagged (more than ${REGRESSION.maxFlagged}): a systematic regression. No confirmation runs; score directly.`);
    return { added: 0 };
  }
  if (manifest.runs.some((entry) => entry.stage === 2)) throw new Error('confirmation runs are already prepared.');
  const relations = (await loadProjectReadModel(manifest.corpus)).decision_lineage.relations;
  const corpusHashes = await hashTree(manifest.corpus);
  if (treeDigest(corpusHashes) !== manifest.corpus_sha256) throw new Error('the corpus changed since prepare.');
  const failures = [];
  const added = [];
  for (const { id } of screened.flagged) {
    const task = manifest.tasks.find((candidate) => candidate.id === id);
    const taskIndex = manifest.tasks.indexOf(task);
    for (let replicate = STAGE1_REPLICATES + 1; replicate <= STAGE1_REPLICATES + STAGE2_REPLICATES; replicate += 1) {
      for (const entry of armPair(manifest.runs, task, taskIndex, replicate, 2)) {
        manifest.runs.push(entry);
        added.push(entry);
        failures.push(...(await prepareRun(dir, entry, manifest.tasks, manifest.corpus, corpusHashes, relations, manifest.briefs)));
      }
    }
  }
  if (failures.length > 0) throw new Error(`Confirmation preflight failed; nothing added:\n- ${failures.join('\n- ')}`);
  await writeManifest(dir, manifest, 'confirm');
  log(ctx, `Prepared ${added.length} confirmation runs for ${screened.flagged.map((entry) => entry.id).join(', ') || 'no task'}.`);
  return { added: added.length };
}

// ------------------------------------------------------------------ score

export async function score(ctx) {
  const { dir } = ctx;
  const manifest = await readManifest(dir);
  await assertFrozenIdentity(ctx, manifest);
  // Every run copy must still match its prepared digest.
  const treeFailures = [];
  for (const entry of manifest.runs) for (const problem of await verifyRunTree(entry)) treeFailures.push(`${entry.id}: ${problem}`);
  if (treeFailures.length > 0) throw new Error(`Run copies changed since prepare:\n- ${treeFailures.join('\n- ')}`);
  const { rows, agreement } = await collectRows(dir, manifest, { stage: null });
  const screened = await readFile(path.join(dir, 'screen.json'), 'utf8').then(JSON.parse, () => null);
  const stage1 = screenRows((await collectRows(dir, manifest, { stage: 1 })).rows);
  if (!screened || JSON.stringify(screened) !== JSON.stringify(stage1)) throw new Error('screen.json is missing or does not match the stage-1 grades; run `screen` (and `confirm`, `run`, `grade`) first.');
  for (const { id } of stage1.systematic ? [] : stage1.flagged) {
    if (replicatesOf(manifest, id).length < STAGE1_REPLICATES + STAGE2_REPLICATES) throw new Error(`${id} is flagged but its confirmation runs are missing.`);
  }
  const summary = summarize(rows, manifest, agreement, await ledgerSpend(dir), stage1);
  await writeFile(path.join(dir, 'results.json'), `${JSON.stringify({ summary, rows }, null, 2)}\n`);
  await writeFile(path.join(dir, 'report.md'), renderReport(summary, rows, manifest));
  log(ctx, renderReport(summary, rows, manifest));
  return summary;
}

/** Rows per task from complete, verified grading; throws on any missing, unusable, or unresolved grade. */
export async function collectRows(dir, manifest, { stage }) {
  const labels = await loadLabels(dir, manifest);
  const rows = [];
  const agreement = { clause_stated: [], forbidden: [], no_governing: [], brief_forbidden: [], brief_governing: [] };
  for (const task of manifest.tasks) {
    const label = labels.get(task.id);
    const replicates = replicatesOf(manifest, task.id).filter((replicate) => stage !== 1 || replicate <= STAGE1_REPLICATES);
    const runs = { baseline: [], brief: [] };
    for (const replicate of replicates) {
      const reports = await reportsFor(dir, manifest, task.id, replicate);
      const jobs = reportJobsFor(task, label, replicate, reports);
      const [first, second] = await Promise.all(['g1', 'g2'].map((grader) => requireGrade(dir, jobs[grader], manifest)));
      const third = reportDisagreements(label, first, second).length > 0 ? await requireGrade(dir, jobs.g3, manifest) : null;
      for (const arm of ['baseline', 'brief']) {
        const entry = manifest.runs.find((candidate) => candidate.task === task.id && candidate.arm === arm && candidate.replicate === replicate);
        const metrics = await auditRun(dir, entry, manifest.tool_call_cap, manifest);
        const verdicts = [first, second, third].filter(Boolean).map((grade) => armVerdicts(label, grade, arm));
        for (const key of Object.keys(verdicts[0].clauses)) agreement.clause_stated.push([verdicts[0].clauses[key].stated, verdicts[1].clauses[key].stated]);
        for (const id of label.forbidden) agreement.forbidden.push([verdicts[0].forbidden[id], verdicts[1].forbidden[id]]);
        agreement.no_governing.push([verdicts[0].noGoverning, verdicts[1].noGoverning]);
        const decided = majority(verdicts, label);
        runs[arm].push({ run: entry.id, replicate, metrics: { ...metrics, report: undefined }, ...decided, items: scoreItems(label, decided.clauses) });
      }
    }
    const briefJobs = briefJobsFor(task, label, await readFile(path.join(dir, 'briefs', `${task.id}.md`), 'utf8'));
    const briefPair = await Promise.all(['g1', 'g2'].map((grader) => requireGrade(dir, briefJobs[grader], manifest)));
    const briefThird = briefDisagreements(label, ...briefPair).length > 0 ? await requireGrade(dir, briefJobs.g3, manifest) : null;
    const briefGrades = [...briefPair, ...(briefThird ? [briefThird] : [])];
    const briefSets = briefGrades.map((grade) => briefVerdicts(label, grade));
    for (const id of label.forbidden) agreement.brief_forbidden.push([briefSets[0].forbidden[id], briefSets[1].forbidden[id]]);
    agreement.brief_governing.push([briefSets[0].governing, briefSets[1].governing]);
    const briefViolations = label.forbidden.filter((id) => pickMajority(briefSets.map((set) => set.forbidden[id])));
    const briefGoverning = pickMajority(briefSets.map((set) => set.governing));

    const positive = label.clauses.length > 0;
    const n = replicates.length;
    const clauseCounts = label.clauses.map((clause) => {
      const key = `${clause.item}:${clause.clause}`;
      return {
        clause: `${clause.item}${clause.clause === '-' ? '' : `(${clause.clause})`}`,
        n,
        baseline: runs.baseline.filter((entry) => entry.clauses[key].stated).length,
        brief: runs.brief.filter((entry) => entry.clauses[key].stated).length,
      };
    });
    rows.push({
      id: task.id,
      split: task.split,
      positive,
      replicates: n,
      runs,
      recall: positive ? Object.fromEntries(['baseline', 'brief'].map((arm) => [arm, recallStats(runs[arm])])) : null,
      clause_counts: clauseCounts,
      weakened: clauseCounts.filter((entry) => entry.baseline * 2 > n && entry.baseline - entry.brief === 1).map((entry) => entry.clause),
      gained: clauseCounts.filter((entry) => entry.brief - entry.baseline >= 2).map((entry) => entry.clause),
      baseline_unstable: clauseCounts.filter((entry) => entry.baseline > 0 && entry.baseline < n).map((entry) => entry.clause),
      no_match: positive
        ? null
        : Object.fromEntries(['baseline', 'brief'].map((arm) => [arm, runs[arm].filter((entry) => entry.noGoverning && (arm === 'baseline' || manifest.briefs[task.id].status === 'no-match')).length])),
      brief: manifest.briefs[task.id],
      brief_violations: briefViolations,
      brief_presents_governing: !positive && briefGoverning,
      brief_grades: briefGrades.map((grade) => grade.graded),
    });
  }
  return { rows, agreement };
}

/** Strict majority; with two verdicts they must agree, or a third verdict was required. */
function pickMajority(values) {
  if (values.length === 2 && values[0] !== values[1]) throw new Error('a disagreement has no tie-break grade');
  return values.filter(Boolean).length * 2 > values.length;
}

export function majority(verdicts, label) {
  const clauses = Object.fromEntries(
    Object.keys(verdicts[0].clauses).map((key) => {
      const stated = pickMajority(verdicts.map((verdict) => verdict.clauses[key].stated));
      const attributed = stated && pickMajority(verdicts.map((verdict) => verdict.clauses[key].attributed));
      return [key, { stated, attributed }];
    }),
  );
  return {
    clauses,
    forbidden: label.forbidden.filter((id) => pickMajority(verdicts.map((verdict) => verdict.forbidden[id]))),
    noGoverning: pickMajority(verdicts.map((verdict) => verdict.noGoverning)),
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
  const perRun = runs.map((entry) => mean(entry.items.map((item) => item.score)));
  return { mean: mean(perRun), min: Math.min(...perRun), max: Math.max(...perRun), per_run: perRun };
}

/**
 * Confirmation (six replicates) for one flagged task: a clause the baseline
 * states in at least `confirmBaselineMin` of six and the brief arm in at most
 * `confirmBriefMax`, or a task mean drop beyond `confirmTaskDrop`.
 */
export function confirmedLoss(row) {
  const reasons = [];
  const drop = row.recall.baseline.mean - row.recall.brief.mean;
  if (drop > REGRESSION.confirmTaskDrop + 1e-9) reasons.push(`task recall ${row.recall.brief.mean.toFixed(3)} vs ${row.recall.baseline.mean.toFixed(3)} over ${row.replicates}`);
  for (const entry of row.clause_counts) {
    if (entry.baseline >= REGRESSION.confirmBaselineMin && entry.brief <= REGRESSION.confirmBriefMax) reasons.push(`${entry.clause} ${entry.baseline}/${entry.n} → ${entry.brief}/${entry.n}`);
  }
  return reasons;
}

export function summarize(rows, manifest, agreement, spend, stage1) {
  const splits = { tuning: rows.filter((row) => row.positive && row.split === 'tuning'), heldout: rows.filter((row) => row.positive && row.split !== 'tuning') };
  const recall = {};
  for (const [split, subset] of Object.entries(splits)) {
    recall[split] = {};
    for (const arm of ['baseline', 'brief']) {
      // Macro over tasks of the per-task mean; spread across the stage-1 replicate indices.
      const perReplicate = Array.from({ length: manifest.stage1_replicates }, (_, index) => mean(subset.map((row) => row.recall[arm].per_run[index])));
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
  const runViolations = rows.flatMap((row) => ['baseline', 'brief'].flatMap((arm) => row.runs[arm].filter((entry) => entry.metrics.violations.length > 0).map((entry) => `${entry.run} (${row.id} ${arm}): ${entry.metrics.violations.join('; ')}`)));
  const briefFailures = Object.entries(manifest.briefs).flatMap(([id, brief]) => [
    ...brief.safe_overflow.map((problem) => `${id}: ${problem}`),
    ...(brief.body_matches_json ? [] : [`${id}: body differs from --json markdown`]),
    ...(new Set(brief.replicates.map((replicate) => replicate.normalized_sha256)).size === 1 ? [] : [`${id}: replicate briefs differ beyond location metadata`]),
  ]);
  const perCase = (split, threshold) => Object.entries(recall[split].brief.per_task).filter(([, stats]) => stats.mean < threshold).map(([id, stats]) => `${id} ${stats.mean.toFixed(3)}`);
  const reportViolations = (arm) => rows.flatMap((row) => row.runs[arm].filter((entry) => entry.forbidden.length > 0).map((entry) => `${entry.run} (${row.id}): ${entry.forbidden.join(', ')}`));
  const flaggedRows = stage1.systematic ? [] : stage1.flagged.map((entry) => rows.find((row) => row.id === entry.id));
  const confirmed = flaggedRows.map((row) => ({ id: row.id, reasons: confirmedLoss(row) })).filter((entry) => entry.reasons.length > 0);
  const splitDrops = Object.fromEntries(Object.entries(recall).map(([split, data]) => [split, data.baseline.macro - data.brief.macro]));
  const conformance = [
    ...(manifest.preflight?.pass ? [] : ['preflight did not pass']),
    ...(manifest.pre_run_gates?.pass ? [] : manifest.pre_run_gates?.failures ?? ['pre-run gates missing']),
    ...(manifest.package_dirty ? ['package was dirty at prepare'] : []),
    ...runViolations,
  ];
  const gates = {
    conformance: { pass: conformance.length === 0, findings: conformance },
    brief_forbidden_claims: { pass: rows.every((row) => row.brief_violations.length === 0 && !row.brief_presents_governing), findings: rows.filter((row) => row.brief_violations.length > 0 || row.brief_presents_governing).map((row) => `${row.id}: ${[...row.brief_violations, ...(row.brief_presents_governing ? ['presents governing memory'] : [])].join(', ')}`) },
    brief_arm_report_forbidden_claims: { pass: reportViolations('brief').length === 0, findings: reportViolations('brief') },
    baseline_report_forbidden_claims_reported: reportViolations('baseline'),
    safe_overflow_and_status: { pass: briefFailures.length === 0, findings: briefFailures },
    tuning_recall: { target: 0.8, macro: recall.tuning.brief.macro, cases_below: perCase('tuning', 0.8), pass: recall.tuning.brief.macro >= 0.8 && perCase('tuning', 0.8).length === 0 },
    heldout_recall: { target: 0.75, macro: recall.heldout.brief.macro, cases_below: perCase('heldout', 0.75), pass: recall.heldout.brief.macro >= 0.75 && perCase('heldout', 0.75).length === 0 },
    no_regression: {
      pass: !stage1.systematic && confirmed.length === 0 && Object.values(splitDrops).every((drop) => drop <= REGRESSION.splitDrop + 1e-9),
      flagged_stage1: stage1.flagged,
      systematic: stage1.systematic,
      confirmed_losses: confirmed,
      split_drops: splitDrops,
    },
    latency: { warm_p50_max_ms: manifest.latency.warm_p50_max_ms, cold_max_ms: manifest.latency.cold_max_ms, pass: manifest.latency.warm_p50_max_ms <= 300 && manifest.latency.cold_max_ms <= 1500 },
  };
  return {
    recall,
    no_match: Object.fromEntries(['baseline', 'brief'].map((arm) => [arm, { correct_runs: noMatchRows.reduce((sum, row) => sum + row.no_match[arm], 0), total_runs: noMatchRows.reduce((sum, row) => sum + row.replicates, 0), per_task: Object.fromEntries(noMatchRows.map((row) => [row.id, row.no_match[arm]])) }])),
    brief_no_match_status: Object.fromEntries(noMatchRows.map((row) => [row.id, row.brief.status])),
    grader_agreement: Object.fromEntries(Object.entries(agreement).map(([key, pairs]) => [key, agreementStats(pairs)])),
    stopped_at_cap: Object.fromEntries(['baseline', 'brief'].map((arm) => [arm, rows.reduce((sum, row) => sum + row.runs[arm].filter((entry) => entry.metrics.stopped_at_cap).length, 0)])),
    cost_usd: { total: spend.total, by_kind: spend.by_kind, attempts: spend.attempts, estimated: spend.estimated.length, unresolved: spend.unresolved, reserved_unresolved: spend.reserved_unresolved },
    gates,
    go: Object.values(gates).filter((gate) => gate && typeof gate === 'object' && 'pass' in gate).every((gate) => gate.pass),
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
  const lines = [`# A7 results (${manifest.prompt_template_version}, ${manifest.model}, effort ${manifest.effort}, cap ${manifest.tool_call_cap})`, ''];
  lines.push(`Harness: ${manifest.harness}`, `Package: ${manifest.package_commit}; harness sha256 ${manifest.harness_sha256}; Node ${manifest.node}`, '');
  lines.push('| Task | Split | n | Baseline recall mean (min–max) | Brief recall mean (min–max) | Weakened | Gained | Baseline unstable | Brief status / body / file | Brief X | Calls b / r (* stopped) |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const row of rows) {
    const stats = (arm) => (row.recall ? `${f3(row.recall[arm].mean)} (${f3(row.recall[arm].min)}–${f3(row.recall[arm].max)})` : `no governing: ${row.no_match[arm]}/${row.replicates}`);
    const calls = (arm) => row.runs[arm].map((entry) => `${entry.metrics.tool_calls}${entry.metrics.stopped_at_cap ? '*' : ''}`).join(',');
    lines.push(
      `| ${row.id} | ${row.split} | ${row.replicates} | ${stats('baseline')} | ${stats('brief')} | ${row.weakened.join(', ') || '—'} | ${row.gained.join(', ') || '—'} | ${row.baseline_unstable.join(', ') || '—'} | ${row.brief.status}${row.brief.topic_absent ? ' (topic absent)' : ''} / ${row.brief.body_tokens} / ${row.brief.whole_file_tokens} | ${row.brief_violations.join(', ') || 'none'} | ${calls('baseline')} / ${calls('brief')} |`,
    );
  }
  lines.push('');
  for (const split of ['tuning', 'heldout']) {
    for (const arm of ['baseline', 'brief']) {
      const data = summary.recall[split][arm];
      lines.push(`- ${split} positives, ${arm}: macro ${f3(data.macro)}; stage-1 replicate macros ${data.replicate_macros.map(f3).join(', ')} (sd ${f3(data.sd)})`);
    }
  }
  lines.push(`- No-match: ${JSON.stringify(summary.no_match)}; brief statuses ${JSON.stringify(summary.brief_no_match_status)}`);
  lines.push(`- Grader agreement: ${JSON.stringify(summary.grader_agreement)}`);
  lines.push(`- Stopped at the cap: ${JSON.stringify(summary.stopped_at_cap)}; cost (ledger) ${JSON.stringify(summary.cost_usd)}`);
  lines.push('', '## Gates', '```json', JSON.stringify(summary.gates, null, 2), '```', '', `Go for default-on under the pre-registered rule: ${summary.go}`);
  return `${lines.join('\n')}\n`;
}

// ------------------------------------------------- identity and manifest

/** Package identity at prepare: commit, uncommitted changes under src/ and scripts/, and the src tree. */
function packageIdentity() {
  const git = (...gitArgs) => spawnSync('git', gitArgs, { cwd: packageDir, encoding: 'utf8' }).stdout.trim();
  return {
    package_commit: git('rev-parse', 'HEAD'),
    package_dirty: git('status', '--porcelain', '--', 'src', 'scripts'),
    package_src_tree: git('rev-parse', 'HEAD:src'),
  };
}

/** Every stage after prepare runs only on the frozen package, harness, labels, briefs, and prompts. */
async function assertFrozenIdentity(ctx, manifest) {
  const { dir } = ctx;
  const problems = [];
  const identity = (ctx.identity ?? packageIdentity)();
  if (identity.package_commit !== manifest.package_commit) problems.push(`package HEAD ${identity.package_commit} is not the prepared ${manifest.package_commit}`);
  if (identity.package_dirty) problems.push(`package src/ or scripts/ has uncommitted changes: ${identity.package_dirty}`);
  if (sha256(await readFile(harnessPath, 'utf8')) !== manifest.harness_sha256) problems.push('the harness changed since prepare');
  for (const [file, hash] of Object.entries(manifest.label_sha256)) {
    if (sha256(await readFile(path.join(dir, 'labels', file), 'utf8').catch(() => '')) !== hash) problems.push(`labels/${file} changed since prepare`);
  }
  for (const [id, brief] of Object.entries(manifest.briefs)) {
    if (sha256(await readFile(path.join(dir, 'briefs', `${id}.md`), 'utf8').catch(() => '')) !== brief.graded_file_sha256) problems.push(`briefs/${id}.md changed since prepare`);
  }
  for (const entry of manifest.runs) {
    if (sha256(await readFile(path.join(dir, 'prompts', `${entry.id}.txt`), 'utf8').catch(() => '')) !== entry.prompt_sha256) problems.push(`prompts/${entry.id}.txt changed since prepare`);
  }
  if (problems.length > 0) throw new Error(`Frozen identity check failed:\n- ${problems.join('\n- ')}`);
}

/** Writes the manifest and records its hash in the ledger; only `prepare` and `confirm` write it. */
async function writeManifest(dir, manifest, reason) {
  const record = { ...manifest, package_dirty: Boolean(manifest.package_dirty), harness_sha256: sha256(await readFile(harnessPath, 'utf8')) };
  const text = `${JSON.stringify(record, null, 2)}\n`;
  await writeFile(path.join(dir, 'manifest.json'), text);
  await appendLedger(dir, { event: 'manifest', reason, manifest_sha256: sha256(text) });
}

/** The manifest, refused if it differs from the last one the harness wrote. */
async function readManifest(dir) {
  const text = await readFile(path.join(dir, 'manifest.json'), 'utf8');
  const recorded = (await readLedger(dir)).filter((record) => record.event === 'manifest').at(-1);
  if (!recorded || recorded.manifest_sha256 !== sha256(text)) throw new Error('manifest.json differs from the last manifest the harness wrote.');
  return JSON.parse(text);
}

function requireCap(ctx) {
  if (!Number.isFinite(ctx.cap) || ctx.cap <= 0) throw new Error('this stage requires --max-cost-usd <amount> (the founder-approved spending cap).');
  return ctx.cap;
}

// ----------------------------------------------------------------- labels

/**
 * Grading labels: the 12 tuning blocks with the reviewer-confirmed corpus v2
 * revisions merged (recall-evaluation.md › A7 protocol › Merged v2 tuning
 * labels), then the 8 held-out blocks.
 */
async function loadLabels(dir, manifest) {
  const tuningText = await readFile(path.join(dir, 'labels', 'recall-evaluation.md'), 'utf8');
  const heldoutText = await readFile(path.join(dir, 'labels', 'recall-evaluation-heldout-v2.md'), 'utf8');
  if (sha256(heldoutText) !== manifest.heldout_sha256) throw new Error('recall-evaluation-heldout-v2.md changed since prepare.');
  return mergeLabels(tuningText, heldoutText);
}

export function mergeLabels(tuningText, heldoutText) {
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

export function parseTasks(markdown, split) {
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
export function parseLabels(markdown, level = 4) {
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

// ----------------------------------------------------------------- shared

/**
 * Spawns `claude`, streaming stdout (to `streamFile` as it arrives, when
 * given). With a finite `cap`, kills the process as soon as the stream shows
 * tool call cap + 1 (distinct tool_use ids). The kill only bounds wasted
 * work: what reaches the report is decided by the boundary-truncated replay.
 */
export function spawnClaudeStream(claudeArgs, prompt, cwd, cap, { streamFile = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, claudeArgs, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const sink = streamFile ? createWriteStream(streamFile, { flags: 'wx' }) : null;
    let stdout = '';
    let stderr = '';
    let buffer = '';
    let stopped = false;
    const seen = new Set();
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      sink?.write(chunk);
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
        for (const block of event.message?.content ?? []) if (block.type === 'tool_use') seen.add(block.id);
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
    child.on('close', (code) => {
      const done = () => resolve({ code, stdout, stderr, stopped });
      if (sink) sink.end(done);
      else done();
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

function replicatesOf(manifest, taskId) {
  return [...new Set(manifest.runs.filter((entry) => entry.task === taskId).map((entry) => entry.replicate))].sort((left, right) => left - right);
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
        }
      }
    }),
  );
  if (failures.length > 0) throw new Error(`${failures.length} job(s) failed:\n- ${failures.map((error) => error.message).join('\n- ')}`);
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

async function hashTree(root) {
  const hashes = new Map();
  for (const file of await listFiles(root)) hashes.set(file, createHash('sha256').update(await readFile(path.join(root, file))).digest('hex'));
  return hashes;
}

function treeDigest(hashes) {
  return sha256(JSON.stringify([...hashes].sort(([left], [right]) => left.localeCompare(right))));
}

function gitBlobHash(buffer) {
  return createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');
}

/** "2.1.288 (Claude Code)" → "2.1.288"; null when no complete version is present. */
export function parseVersion(text) {
  return String(text ?? '').match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null;
}

async function nonEmptyDirectory(dir) {
  const info = await stat(dir).catch(() => null);
  if (!info) return false;
  if (!info.isDirectory()) return true;
  return (await readdir(dir)).length > 0;
}

async function safeRealpath(target) {
  try {
    return await realpath(target);
  } catch {
    return path.resolve(target);
  }
}

async function exists(target) {
  return readFile(target).then(
    () => true,
    () => false,
  );
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function templateSha() {
  return sha256(`${PROMPT_TEMPLATE}\n${REPORT_TURN_TEMPLATE}`);
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

function log(ctx, message) {
  if (!ctx.quiet) console.log(message);
}

function describe() {
  console.log(
    JSON.stringify(
      {
        prompt_template_version: PROMPT_TEMPLATE_VERSION,
        prompt_template_sha256: templateSha(),
        model: MODEL,
        effort: EFFORT,
        tool_call_cap: TOOL_CALL_CAP,
        stage1_replicates: STAGE1_REPLICATES,
        stage2_replicates: STAGE2_REPLICATES,
        regression: REGRESSION,
        reserves_usd: { run: RUN_RESERVE_USD, grader: GRADE_RESERVE_USD },
        max_grade_attempts: MAX_GRADE_ATTEMPTS,
        agent_args: [...CLAUDE_ARGS, ...AGENT_TOOLS, ...STREAM],
        report_turn_args: [...CLAUDE_ARGS, ...NO_TOOLS, ...STREAM],
        grader_args: [...CLAUDE_ARGS, ...NO_TOOLS, ...STREAM, '--json-schema', '<schema>'],
      },
      null,
      2,
    ),
  );
}

// Dispatch only when run as a script, so tests can import the functions above.
if (process.argv[1] && path.resolve(process.argv[1]) === harnessPath) {
  const [command, ...args] = process.argv.slice(2);
  const option = (name, fallback = null) => {
    const index = args.indexOf(name);
    return index === -1 ? fallback : args[index + 1];
  };
  const required = (name) => {
    const value = option(name);
    if (!value) throw new Error(`${command} requires ${name}.`);
    return value;
  };
  const ctx = {
    dir: option('--out') ? path.resolve(option('--out')) : null,
    cap: option('--max-cost-usd') === null ? null : Number(option('--max-cost-usd')),
    concurrency: Number(option('--concurrency', '4')),
    only: option('--only') ? new Set(option('--only').split(',')) : null,
  };
  const commands = {
    prepare: () => prepare(ctx, { corpus: required('--corpus'), docsRepo: required('--docs-repo'), labelsDir: required('--labels'), heldoutSha: required('--heldout-sha256'), warmRuns: Number(option('--warm-runs', '10')) }),
    run: () => run(ctx),
    grade: () => grade(ctx),
    screen: () => screen(ctx),
    confirm: () => confirm(ctx),
    score: () => score(ctx),
    smoke: () => smoke(ctx, { corpus: required('--corpus'), labelsDir: required('--labels'), task: required('--task'), cap: Number(option('--cap', '3')), statedCap: Number(option('--stated-cap', option('--cap', '3'))) }),
  };
  if (command === 'describe') {
    describe();
  } else if (!commands[command] || !ctx.dir) {
    console.error('Usage: node scripts/evaluate-brief-a7.js <prepare|run|grade|screen|confirm|score|smoke|describe> --out <dir> [...]');
    process.exit(2);
  } else {
    await commands[command]();
  }
}
