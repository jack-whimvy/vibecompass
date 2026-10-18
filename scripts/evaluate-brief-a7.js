#!/usr/bin/env node
// A7 evaluation for the session brief (recall plan task A7; protocol
// pre-registered in canonical memory at
// architecture/platform/project-memory/recall-evaluation.md › A7 protocol).
// Development tool; not shipped in the npm package.
//
//   node scripts/evaluate-brief-a7.js prepare --corpus <dir> --docs-repo <dir> --tuning-labels <file> --heldout <file> --heldout-sha256 <hex> --out <dir> [--warm-runs 10]
//   node scripts/evaluate-brief-a7.js run     --out <dir> --max-cost-usd <n> [--concurrency 4] [--only r001,r002]
//   node scripts/evaluate-brief-a7.js grade   --out <dir> --max-cost-usd <n> [--concurrency 4] [--only F1,T2]
//   node scripts/evaluate-brief-a7.js screen  --out <dir>        (stage 1: which tasks need confirmation runs)
//   node scripts/evaluate-brief-a7.js confirm --out <dir>        (stage 2: adds replicates 4–6 for the flagged tasks)
//   node scripts/evaluate-brief-a7.js score   --out <dir>
//   node scripts/evaluate-brief-a7.js smoke   --corpus <dir> --tuning-labels <file> --out <dir> --task <id> [--cap 3] [--stated-cap 24]
//   node scripts/evaluate-brief-a7.js describe
//
// The later attempt (recall-evaluation.md › A7 later attempt) keeps the
// frozen protocol and changes the harness only: corpus v3 (the single root,
// D-382), whose startup files replace the former primer `CLAUDE.md` with
// `context.md` and `architecture/overview/project-status.md`; a new held-out
// set authored outside every repo; a provenance-based isolation rule (below);
// and abort handling (below).
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
// graders see them. `prepare` also fingerprints the label copies for the
// isolation audit, and records only hashes.
//
// Evaluation isolation is judged by provenance, not by markers. The forbidden
// artifact set is the label copies and everything the harness writes outside
// a run copy. The controls: the corpus and every run copy are verified
// against the tag entry by entry (symlinks by link text, resolving inside);
// every tool input must stay inside the run copy, glob patterns included; and
// every session passes the session checks. On top of that, every input an
// evaluated session receives — its prompt, every tool result, and a report
// turn's replay — is scanned for content fingerprints that occur in the label
// copies but nowhere in the run copy. Only delivered forbidden content is a
// deviation. Naming an evaluation file is an observation, counted as an
// exclusion, an unsuccessful search, or a mention.
//
// Abort handling: SIGINT, SIGTERM, or SIGHUP during `run`, `grade`, or
// `smoke` stops dispatch, terminates every live child session's process group
// (SIGTERM, then SIGKILL after a grace period; a second signal kills at
// once), awaits them, keeps their streams, and records each as an `aborted`
// ledger attempt costed from its streamed usage, or by its reserve as
// unresolved. An aborted evaluated session is never retried. A `STOP` file in
// the evaluation directory stops dispatch gracefully instead: running
// sessions finish. The next `run` or `grade` first terminates and records any
// session a killed harness left behind, from the pids the ledger records.

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { appendFile, copyFile, cp, lstat, mkdir, readdir, readFile, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
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
const LANE_SESSION_DATE = '2026-10-14';
const CORPUS_TAG = 'recall-eval-corpus-v3';
const CORPUS_EXCLUDED = (file) => /^architecture\/platform\/project-memory\/recall-evaluation[^/]*\.md$/.test(file) || file.startsWith('sessions/active/');
const TUNING_LABEL_FILE = 'recall-evaluation.md';
const HELDOUT_LABEL_FILE = 'recall-evaluation-heldout-v3.md';
const LABEL_FILES = [TUNING_LABEL_FILE, HELDOUT_LABEL_FILE];
const MERGED_TUNING_HEADING = '#### Merged v3 tuning labels';
export const TUNING_TASKS = 12;
// The root's own startup files before the session note (D-382: the single
// root has no `CLAUDE.md`; its protocol is `context.md` and its primer is
// `project-status.md`, read in that order by the workspace startup).
const STARTUP_ROOT_FILES = ['context.md', 'architecture/overview/project-status.md', 'project.yaml'];
const LANE_FILES = ['sessions/active/index.yaml', 'sessions/active/eval/session.yaml', 'sessions/active/eval/wip.md', 'sessions/active/eval/handoff.md'];
// Reserves the cost cap holds back before starting a paid call, and the cost
// counted for an attempt whose cost cannot be established.
export const RUN_RESERVE_USD = 1.5;
export const GRADE_RESERVE_USD = 0.5;
export const MAX_GRADE_ATTEMPTS = 3;
// Latency is measured only on a quiet machine: prepare refuses, preparing
// nothing, when the one-minute load average exceeds this share of the logical
// cores as measurement starts (the rehearsal measured warm p50 274 ms at load
// 3.8 and 841 ms at load 31.8 on 16 cores, for the same code and corpus).
export const LATENCY_MAX_LOAD_PER_CORE = 0.5;
// Abort: how long a child session gets after SIGTERM before SIGKILL.
export const ABORT_GRACE_MS = 5000;
// Isolation fingerprints: word 8-grams of normalized text with at least five
// words of three or more letters, so runs of numbers, IDs, or punctuation
// never count.
export const FINGERPRINT = Object.freeze({ words: 8, min_long_words: 5, long_word_letters: 3 });
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
// Variables a child session must not inherit: the parent Claude Code
// session's own (its messaging socket and token, session ids, entry point,
// effort), and VibeCompass credentials. Auth and config (CLAUDE_CONFIG_DIR,
// ANTHROPIC_*) pass through.
const CHILD_ENV_DROPPED = (name) => (/^CLAUDE/.test(name) && name !== 'CLAUDE_CONFIG_DIR') || name === 'AI_AGENT' || /^VIBECOMPASS_/.test(name);

/** The environment every child session gets: the harness's, without the dropped variables. */
export function childEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !CHILD_ENV_DROPPED(name)));
}

/** The Claude Code version a session would run now ("2.1.301"), or null. */
export function currentClaudeVersion() {
  return parseVersion(spawnSync(CLAUDE_BIN, ['--version'], { encoding: 'utf8', env: childEnv() }).stdout);
}

/**
 * Claude Code updates itself in place, and every session must run exactly
 * the version recorded at prepare. Each paid stage checks the version before
 * it starts and again before every session; a change stops dispatch before
 * anything runs on the new version.
 */
function versionGuard(manifest) {
  const expected = parseVersion(manifest.claude_version);
  const guard = {
    expected,
    found: null,
    check: () => {
      const now = currentClaudeVersion();
      if (now !== expected) guard.found = now ?? 'unreadable';
      return guard.found === null;
    },
  };
  return guard;
}

function versionChangedError(guard) {
  return `Claude Code is ${guard.found}, but this evaluation was prepared with ${guard.expected}; reinstall exactly ${guard.expected} (and keep auto-update off) before resuming. No session started on ${guard.found}.`;
}

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const harnessPath = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------- prepare

/**
 * Prepares stage 1 in an empty or new directory. `opts`: corpus, docsRepo,
 * tuningLabels (recall-evaluation.md), heldout (the held-out file, outside
 * every repo), heldoutSha, warmRuns, expectTasks (20 for A7), tuningTasks
 * (12 for A7).
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
  for (const [file, source] of [[TUNING_LABEL_FILE, opts.tuningLabels], [HELDOUT_LABEL_FILE, opts.heldout]]) {
    await copyFile(path.resolve(source), path.join(dir, 'labels', file));
    labelHashes[file] = sha256(await readFile(path.join(dir, 'labels', file), 'utf8'));
  }
  if (labelHashes[HELDOUT_LABEL_FILE] !== opts.heldoutSha) failures.push(`the held-out file does not match --heldout-sha256; the held-out set changed since its handback`);
  failures.push(...(await verifyCorpus(corpus, path.resolve(opts.docsRepo))));

  const labelsText = Object.fromEntries(await Promise.all(LABEL_FILES.map(async (file) => [file, await readFile(path.join(dir, 'labels', file), 'utf8')])));
  let tuning = [];
  try {
    tuning = parseTasks(mergedTuningSection(labelsText[TUNING_LABEL_FILE]), 'tuning', 5);
  } catch (error) {
    failures.push(error.message);
  }
  const tasks = [...tuning, ...parseTasks(labelsText[HELDOUT_LABEL_FILE], 'held-out')];
  const expectTasks = opts.expectTasks ?? 20;
  if (tuning.length !== (opts.tuningTasks ?? TUNING_TASKS)) failures.push(`expected ${opts.tuningTasks ?? TUNING_TASKS} tuning tasks in the merged v3 labels, found ${tuning.length}`);
  if (tasks.length !== expectTasks) failures.push(`expected ${expectTasks} tasks, found ${tasks.length}`);
  const ids = tasks.map((task) => task.id);
  for (const id of new Set(ids.filter((value, index) => ids.indexOf(value) !== index))) failures.push(`task ID ${id} appears more than once`);
  for (const task of tasks) if (!task.task) failures.push(`${task.id}: no task text`);
  if (failures.length > 0) throw new Error(`Preflight failed; nothing prepared:\n- ${failures.join('\n- ')}`);

  await mkdir(path.join(dir, 'briefs'), { recursive: true });
  await mkdir(path.join(dir, 'prompts'), { recursive: true });
  const relations = (await loadProjectReadModel(corpus)).decision_lineage.relations;
  const corpusHashes = await hashTree(corpus);
  // The isolation fingerprints: label-copy content that occurs nowhere in the corpus.
  const isolation = await buildIsolationIndex(Object.values(labelsText), corpus);
  const isolationText = `${JSON.stringify(isolation, null, 2)}\n`;
  await writeFile(path.join(dir, 'isolation.json'), isolationText);
  const forbidden = new Set(isolation.fingerprints);

  // Arms alternate by task and replicate; run ids follow launch order.
  const runs = [];
  tasks.forEach((task, taskIndex) => {
    for (let replicate = 1; replicate <= STAGE1_REPLICATES; replicate += 1) runs.push(...armPair(runs, task, taskIndex, replicate, 1));
  });
  const briefs = {};
  for (const entry of runs) failures.push(...(await prepareRun(dir, entry, tasks, corpus, corpusHashes, relations, briefs, forbidden)));

  const loadLimit = (opts.cores ?? os.availableParallelism()) * LATENCY_MAX_LOAD_PER_CORE;
  const loadBefore = (opts.loadavg ?? os.loadavg)();
  if (loadBefore[0] > loadLimit) throw new Error(`Machine busy; nothing prepared: the one-minute load average is ${loadBefore[0].toFixed(2)}, above ${loadLimit} (${LATENCY_MAX_LOAD_PER_CORE} per logical core), so latency cannot be measured fairly. Stop other work (other lanes' tests and builds) and prepare again into a new, empty directory.`);
  const latency = await measureLatency(dir, corpus, tasks, opts.warmRuns ?? 10);
  latency.load_average = { before: loadBefore.map((value) => Math.round(value * 100) / 100), after: (opts.loadavg ?? os.loadavg)().map((value) => Math.round(value * 100) / 100), limit: loadLimit, logical_cores: opts.cores ?? os.availableParallelism() };
  // Pre-run gates (A7 protocol): a failure here is the outcome — no-go — and no paid run starts.
  const preRunGateFailures = [
    ...Object.entries(briefs).flatMap(([id, brief]) => brief.safe_overflow.map((problem) => `${id}: ${problem}`)),
    ...(latency.warm_p50_max_ms > 300 ? [`warm p50 ${latency.warm_p50_max_ms} ms > 300 ms`] : []),
    ...(latency.cold_max_ms > 1500 ? [`cold CLI ${latency.cold_max_ms} ms > 1,500 ms`] : []),
  ];
  if (failures.length > 0) throw new Error(`Preflight failed; nothing prepared:\n- ${failures.join('\n- ')}`);

  const claudeVersion = spawnSync(CLAUDE_BIN, ['--version'], { encoding: 'utf8', env: childEnv() }).stdout.trim();
  if (!parseVersion(claudeVersion)) throw new Error(`cannot read the Claude Code version (got "${claudeVersion}")`);
  const manifest = {
    prepared_at: new Date().toISOString(),
    ...identity,
    node: process.version,
    claude_bin: CLAUDE_BIN,
    claude_version: claudeVersion,
    child_env_removed: Object.keys(process.env).filter(CHILD_ENV_DROPPED).sort(),
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
    startup_root_files: STARTUP_ROOT_FILES,
    label_sha256: labelHashes,
    heldout_sha256: opts.heldoutSha,
    isolation: { sha256: sha256(isolationText), fingerprints: isolation.fingerprints.length, method: isolation.method },
    tasks: tasks.map(({ id, split, task, files }) => ({ id, split, task, files })),
    runs,
    briefs,
    latency,
    preflight: { pass: true },
    pre_run_gates: { pass: preRunGateFailures.length === 0, failures: preRunGateFailures },
  };
  await writeManifest(dir, manifest, 'prepare');
  log(ctx, `Prepared ${runs.length} stage-1 runs (${tasks.length} tasks × 2 arms × ${STAGE1_REPLICATES}) in ${dir}; package ${manifest.package_commit}; ${isolation.fingerprints.length} isolation fingerprints`);
  // Held-out briefs are summarized, not listed, so preparing exposes no per-task held-out detail.
  const heldoutIds = new Set(tasks.filter((task) => task.split === 'held-out').map((task) => task.id));
  for (const [id, brief] of Object.entries(briefs)) {
    if (heldoutIds.has(id)) continue;
    log(ctx, `- ${id}: ${brief.status}${brief.topic_absent ? ' (topic absent)' : ''}; body ${brief.body_tokens} / whole file ${brief.whole_file_tokens} est. tokens; safe overflow ${brief.safe_overflow.length === 0 ? 'yes' : brief.safe_overflow.join('; ')}`);
  }
  const heldoutBriefs = Object.entries(briefs).filter(([id]) => heldoutIds.has(id));
  log(ctx, `- held-out: ${heldoutBriefs.length} briefs, safe overflow on ${heldoutBriefs.filter(([, brief]) => brief.safe_overflow.length === 0).length}`);
  log(ctx, `Latency: cold CLI first ${latency.cold_first_ms} ms, max ${latency.cold_max_ms} ms; warm p50 max ${latency.warm_p50_max_ms} ms; load average ${latency.load_average.before.join(' ')} before, ${latency.load_average.after.join(' ')} after`);
  if (!manifest.pre_run_gates.pass) log(ctx, `PRE-RUN GATES FAILED — the outcome is no-go and \`run\` will refuse:\n- ${preRunGateFailures.join('\n- ')}`);
  return manifest;
}

function armPair(existing, task, taskIndex, replicate, stage) {
  const arms = (taskIndex + replicate) % 2 === 1 ? ['baseline', 'brief'] : ['brief', 'baseline'];
  return arms.map((arm, index) => ({ id: `r${String(existing.length + index + 1).padStart(3, '0')}`, task: task.id, arm, replicate, stage }));
}

/**
 * Builds one run copy, its brief (brief arm), and its prompt, and records
 * their identities; returns preflight failures. The prompt must carry no
 * isolation fingerprint beyond its own run copy and the templates.
 */
async function prepareRun(dir, entry, tasks, corpus, corpusHashes, relations, briefs, forbidden) {
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
  const promptHits = countFingerprintHits(prompt, withoutPromptFrame(await runForbidden(forbidden, root), task, startup.map((file) => file.path)));
  if (promptHits > 0) failures.push(`${entry.id} (${task.id}): the prompt carries ${promptHits} isolation fingerprint(s) from the label copies`);

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

/**
 * The prescribed startup reads, in order, from the run copy
 * (recall-evaluation.md › Baseline protocol, with the later attempt's v3
 * startup set: `context.md` and `project-status.md` where corpus v2 had the
 * primer `CLAUDE.md`).
 */
async function readStartupFiles(root, arm) {
  const notes = (await readdir(path.join(root, 'sessions')))
    .map((name) => ({ name, match: name.match(/^(\d{4}-\d{2}-\d{2})-(\d+)-.*\.md$/) }))
    .filter((entry) => entry.match)
    .sort((left, right) => left.match[1].localeCompare(right.match[1]) || Number(left.match[2]) - Number(right.match[2]));
  const order = [
    ...STARTUP_ROOT_FILES,
    `sessions/${notes.at(-1).name}`,
    'sessions/active/index.yaml',
    'sessions/active/eval/wip.md',
    'sessions/active/eval/handoff.md',
    ...(arm === 'brief' ? ['sessions/active/eval/brief.md'] : []),
  ];
  return Promise.all(order.map(async (file) => ({ path: file, content: await readFile(path.join(root, file), 'utf8') })));
}

function renderFiles(task) {
  return task.files.length > 0 ? task.files.map((file) => `\`${file}\``).join(', ') : 'none';
}

function renderPrompt(task, startup) {
  const files = renderFiles(task);
  const text = /[.?!]$/.test(task.task) ? task.task : `${task.task}.`;
  const bundle = startup
    .map((file, index) => `<startup-file order="${index + 1}" path="${file.path}"${file.path.endsWith('/brief.md') ? ' note="the lane\'s generated session brief"' : ''}>\n${file.content.trimEnd()}\n</startup-file>`)
    .join('\n\n');
  return PROMPT_TEMPLATE.replace('{task}', text).replace('{files}', files).replace('{startup}', bundle);
}

async function makeRunCopy(corpus, root, task) {
  await rm(root, { recursive: true, force: true });
  // Symlinks are copied verbatim, so a copy's link text equals the corpus's (and git's).
  await cp(corpus, root, { recursive: true, verbatimSymlinks: true });
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

/**
 * Every corpus entry must be an entry of the tag with the same git blob hash
 * and kind (a symlink exactly where the tag has one, compared by its link
 * text as git stores it, and resolving inside the corpus), and every tag
 * entry not excluded must be present.
 */
async function verifyCorpus(corpus, docsRepo) {
  const failures = [];
  const listing = spawnSync('git', ['-C', docsRepo, 'ls-tree', '-r', CORPUS_TAG], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (listing.status !== 0) return [`cannot list ${CORPUS_TAG} in ${docsRepo}: ${listing.stderr.trim()}`];
  const expected = new Map(
    listing.stdout
      .trim()
      .split('\n')
      .map((line) => line.match(/^(\d+) blob ([0-9a-f]+)\t(.+)$/))
      .filter(Boolean)
      .map((match) => [match[3], { blob: match[2], symlink: match[1] === '120000' }])
      .filter(([file]) => !CORPUS_EXCLUDED(file)),
  );
  const actual = await listFiles(corpus);
  for (const file of actual) {
    if (!expected.has(file)) {
      failures.push(`corpus file ${file} is not in ${CORPUS_TAG} (or is excluded)`);
      continue;
    }
    const symlink = (await lstat(path.join(corpus, file))).isSymbolicLink();
    if (symlink !== expected.get(file).symlink) {
      failures.push(`corpus file ${file} ${symlink ? 'is a symlink but is not one' : 'is not a symlink but is one'} in ${CORPUS_TAG}`);
      continue;
    }
    if (gitBlobHash(await entryBytes(corpus, file)) !== expected.get(file).blob) failures.push(`corpus file ${file} differs from ${CORPUS_TAG}`);
    if (symlink) {
      const resolved = path.resolve(path.dirname(path.join(corpus, file)), await readlink(path.join(corpus, file)));
      if (!resolved.startsWith(`${corpus}${path.sep}`)) failures.push(`corpus symlink ${file} points outside the corpus`);
    }
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
  return withHarnessLock(ctx, async () => {
    // Sessions a killed harness left behind are terminated and recorded before anything else.
    await reapOrphans(ctx);
    const version = versionGuard(manifest);
    if (!version.check()) throw new Error(versionChangedError(version));
    // Every paid session — research or report turn — starts only within the cap.
    const guard = async (reserve) => (await ledgerSpend(dir)).total + reserve <= cap;
    const pending = [];
    for (const entry of manifest.runs) {
      const base = path.join(dir, 'transcripts', entry.id);
      // The ledger, not the metadata, says which sessions finished: every run
      // with a finished session is reconciled before anything is scheduled, so a
      // finished session is never paid for twice. All runs, not only --only's:
      // the terminal audit below reads every run's evidence, and a missing
      // metadata or transcript file is recoverable state, not a deviation
      // (reviewer pass 2, R5). --only decides scheduling alone.
      const meta = (await ledgerHasFinished(dir, entry.id)) ? await reconcileRun(dir, entry, manifest.tool_call_cap) : await readMeta(base);
      if ((!ctx.only || ctx.only.has(entry.id)) && meta?.state !== 'complete') pending.push(entry);
    }
    // Before anything is spent, whatever --only selects: an entry that can no longer conform stops here.
    await refuseTerminal(ctx, manifest, 'run');
    const skipped = [];
    const aborted = [];
    const deviations = [];
    const dispatched = new Set();
    // A run with a deviation makes the entry nonconforming, so dispatch stops there (A7 protocol › Residual risk).
    const stop = async () => deviations.length > 0 || version.found !== null || (await stopRequested(dir));
    // The one guard before every paid session, research and report turns alike (reviewer pass 1, R2).
    const dispatchAllowed = async () => !ctx.signal?.aborted && !(await stop()) && version.check();
    await pool(pending, ctx.concurrency ?? 4, async (entry) => {
      dispatched.add(entry.id);
      const treeProblems = await verifyRunTree(entry);
      if (treeProblems.length > 0) throw new Error(`${entry.id}: ${treeProblems.join('; ')}`);
      const prompt = await readFile(path.join(dir, 'prompts', `${entry.id}.txt`), 'utf8');
      if (sha256(prompt) !== entry.prompt_sha256) throw new Error(`${entry.id}: prompt changed since prepare.`);
      // A capped run's research is evidence before its report turn exists: audit it at that boundary,
      // so a deviation there stops the report turn and all other dispatch (reviewer pass 2, R4).
      const beforeReport = async () => {
        const researchAudit = await auditRun(dir, entry, manifest.tool_call_cap, manifest, { researchOnly: true });
        if (researchAudit.violations.length === 0) return true;
        deviations.push(entry.id);
        log(ctx, `${entry.id} ${entry.task} ${entry.arm} #${entry.replicate}: research finished at the call cap; its report turn is not started; DEVIATIONS: ${researchAudit.violations.join('; ')}`);
        return false;
      };
      const meta = await runAgent(prompt, entry.root, path.join(dir, 'transcripts', entry.id), manifest.tool_call_cap, { ledgerDir: dir, runId: entry.id, guard, signal: ctx.signal, graceMs: ctx.graceMs, beforeSpawn: dispatchAllowed, beforeReport });
      if (meta.state === 'aborted') {
        aborted.push(entry.id);
        return;
      }
      if (meta.state !== 'complete') {
        skipped.push(`${entry.id}${meta.state === 'report-pending' ? ' (report turn pending)' : ''}`);
        return;
      }
      const metrics = await auditRun(dir, entry, manifest.tool_call_cap, manifest);
      if (metrics.violations.length > 0) deviations.push(entry.id);
      log(ctx, `${entry.id} ${entry.task} ${entry.arm} #${entry.replicate}: ${metrics.tool_calls} calls${metrics.stopped_at_cap ? ' (stopped at the cap; report turn)' : ''}, ${Math.round(metrics.duration_ms / 1000)} s, $${metrics.cost_usd?.toFixed(3) ?? '?'}${metrics.violations.length > 0 ? `, DEVIATIONS: ${metrics.violations.join('; ')}` : ''}`);
    }, { signal: ctx.signal, stop });
    skipped.push(...pending.filter((entry) => !dispatched.has(entry.id)).map((entry) => `${entry.id} (not started)`));
    const spend = await ledgerSpend(dir);
    log(ctx, `Spent so far: $${spend.total.toFixed(2)} of the $${cap} cap${spend.estimated.length > 0 ? `; ${spend.estimated.length} attempt(s) estimated from streamed usage` : ''}${spend.unresolved.length > 0 ? `; includes $${spend.reserved_unresolved.toFixed(2)} reserved for ${spend.unresolved.length} attempt(s) of unknown cost (${spend.unresolved.join(', ')})` : ''}.`);
    if (ctx.signal?.aborted) {
      await recordAbort(ctx, 'run', aborted);
    } else if (deviations.length > 0) {
      await appendLedger(dir, { event: 'stopped', stage: 'run', reason: 'deviation', runs: deviations });
      log(ctx, `Stopped dispatch at a deviation (${deviations.join(', ')}): the entry cannot be conforming. Running sessions finished; nothing else starts.`);
      process.exitCode = 4;
    } else if (version.found !== null) {
      await appendLedger(dir, { event: 'stopped', stage: 'run', reason: 'claude-version', expected: version.expected, found: version.found });
      log(ctx, `Stopped dispatch: ${versionChangedError(version)} Running sessions finished on ${version.expected}.`);
      process.exitCode = 5;
    } else if (skipped.length > 0) {
      const why = (await stopRequested(dir)) ? 'at the STOP file' : 'at the cost cap';
      log(ctx, `Stopped ${why}: ${skipped.length} run(s) not finished (${skipped.join(', ')}). Resume with a cap the founder approves${why === 'at the STOP file' ? ', after removing STOP' : ''}.`);
      process.exitCode = 3;
    }
    if (aborted.length > 0 && !ctx.signal?.aborted) log(ctx, `${aborted.length} run(s) have an aborted session and are never retried: ${aborted.join(', ')}.`);
    return { skipped, aborted, deviations, version_changed: version.found };
  });
}

/**
 * Why the entry can no longer conform, from the evidence on disk (reviewer
 * pass 1, R1): an earlier deviation stop; an aborted research or report-turn
 * session, including one a killed harness left behind; or a deviation in any
 * run whose research finished, found by auditing it again, since a harness
 * can die before it records its stop. An aborted grader attempt is not
 * terminal; it counts toward the grade's attempts. Empty when the entry can
 * still conform. Run after `reapOrphans` and the ledger reconciliation.
 */
export async function terminalFindings(dir, manifest) {
  const ledger = await readLedger(dir);
  const findings = [];
  for (const record of ledger.filter((entry) => entry.event === 'stopped' && entry.reason === 'deviation')) findings.push(`a deviation stopped dispatch on ${record.at} (${(record.runs ?? []).join(', ')})`);
  const starts = new Map(ledger.filter((entry) => entry.event === 'start').map((entry) => [entry.call, entry]));
  for (const record of ledger.filter((entry) => entry.event === 'aborted')) {
    const start = starts.get(record.call);
    if (start && (start.kind === 'research' || start.kind === 'report')) findings.push(`${record.call} was aborted${record.recovered ? ' (left open by a killed harness)' : ''}`);
  }
  for (const entry of manifest.runs) {
    if ((await finishedAttempts(dir, `run:${entry.id}`)).length === 0) continue;
    const meta = await readMeta(path.join(dir, 'transcripts', entry.id));
    if (meta?.state === 'aborted') continue;
    const metrics = await auditRun(dir, entry, manifest.tool_call_cap, manifest, { researchOnly: meta?.state !== 'complete' });
    if (metrics.violations.length > 0) findings.push(`${entry.id}: ${metrics.violations.join('; ')}`);
  }
  return findings;
}

/** Refuses a paid stage for an entry that can no longer conform; nothing is spent. */
async function refuseTerminal(ctx, manifest, stage) {
  const findings = await terminalFindings(ctx.dir, manifest);
  if (findings.length === 0) return;
  await appendLedger(ctx.dir, { event: 'refused', stage, findings });
  throw new Error(`The entry can no longer conform, so no paid session starts (${stage}):\n- ${findings.join('\n- ')}`);
}

/** A `STOP` file in the evaluation directory stops dispatch; running sessions finish. */
async function stopRequested(dir) {
  return exists(path.join(dir, 'STOP'));
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
export async function runAgent(prompt, cwd, transcriptBase, cap, { ledgerDir = null, runId = path.basename(transcriptBase), guard = async () => true, signal = null, graceMs = ABORT_GRACE_MS, beforeSpawn = () => true, beforeReport = async () => true } = {}) {
  let meta = await readMeta(transcriptBase);
  if (meta?.state === 'complete') return meta;
  // Never pay twice for a session the ledger records as finished, and never
  // retry an evaluated session that was aborted (or left behind by a killed
  // harness): its partial output exists, so a retry could be selective.
  const refuseFinished = async (job) => {
    if (ledgerDir && (await finishedAttempts(ledgerDir, job)).length > 0) throw new Error(`${runId}: ${job} already finished in the ledger; reconcile the run instead of starting it again.`);
  };
  const wasAborted = async (job) => Boolean(ledgerDir) && (await abortedAttempts(ledgerDir, job)).length > 0;
  const abortedMeta = async (extra) => {
    const out = { ...(meta ?? {}), ...extra, state: 'aborted' };
    await writeMeta(transcriptBase, out);
    return out;
  };
  let researchEvents;
  if (meta?.state === 'report-pending') {
    const researchText = await readFile(`${transcriptBase}.jsonl`, 'utf8');
    if (sha256(researchText) !== meta.research_sha256) throw new Error(`${runId}: the research transcript changed while its report turn was pending.`);
    researchEvents = parseEvents(researchText);
  } else {
    if (await wasAborted(`run:${runId}`)) return { ...(meta ?? {}), state: 'aborted' };
    if (signal?.aborted) return { state: 'not-started' };
    if (!(await guard(RUN_RESERVE_USD))) return { state: 'not-started' };
    if (!(await beforeSpawn())) return { state: 'not-started' };
    await refuseFinished(`run:${runId}`);
    const started = Date.now();
    const research = await paidCall(ledgerDir, 'research', `run:${runId}`, RUN_RESERVE_USD, (attempt) => `${transcriptBase}.attempt-${attempt}.jsonl`, (streamFile, onSpawn) =>
      spawnClaudeStream([...CLAUDE_ARGS, ...AGENT_TOOLS, ...STREAM], prompt, cwd, cap, { streamFile, signal, graceMs, onSpawn }),
    );
    if (research.aborted) return abortedMeta({ research_attempt: research.attempt, research_wall_ms: Date.now() - started });
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
    if (await wasAborted(`report:${runId}`)) return { ...meta, state: 'aborted' };
    if (signal?.aborted) return meta;
    // The finished research is audited before its report turn is paid for (reviewer pass 2, R4).
    if (!(await beforeReport())) return meta;
    if (!(await guard(RUN_RESERVE_USD))) return meta;
    if (!(await beforeSpawn())) return meta;
    await refuseFinished(`report:${runId}`);
    const reportPrompt = renderReportTurn(prompt, researchEvents, cap);
    meta.report_prompt_sha256 = sha256(reportPrompt);
    await writeFile(`${transcriptBase}.report-prompt.txt`, reportPrompt);
    const reportStarted = Date.now();
    const report = await paidCall(ledgerDir, 'report', `report:${runId}`, RUN_RESERVE_USD, (attempt) => `${transcriptBase}.report.attempt-${attempt}.jsonl`, (streamFile, onSpawn) =>
      spawnClaudeStream([...CLAUDE_ARGS, ...NO_TOOLS, ...STREAM], reportPrompt, cwd, 0, { streamFile, signal, graceMs, onSpawn }),
    );
    if (report.aborted) return abortedMeta({ report_attempt: report.attempt, report_wall_ms: Date.now() - reportStarted });
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

async function ledgerHasFinished(dir, runId) {
  return (await finishedAttempts(dir, `run:${runId}`)).length > 0 || (await finishedAttempts(dir, `report:${runId}`)).length > 0;
}

/**
 * Reconciles a run with the ledger before anything is scheduled, whatever its
 * metadata says (it may be missing, empty, partial, or one step behind after
 * an interruption between a session's finish and the metadata write). Each
 * session must have at most one finished attempt; its transcript is restored
 * from that attempt's immutable stream, whose hash the ledger holds; the
 * metadata is rewritten from the ledger. An inconsistency stops the run
 * without spending. Nothing finished is ever re-run.
 */
export async function reconcileRun(dir, entry, cap) {
  const base = path.join(dir, 'transcripts', entry.id);
  const settle = async (job, target) => {
    const attempts = await finishedAttempts(dir, job);
    if (attempts.length === 0) return null;
    if (attempts.length > 1) throw new Error(`${entry.id}: ${attempts.length} finished attempts for ${job}; refusing to choose one or to spend again.`);
    const [attempt] = attempts;
    const text = await readFile(attempt.file, 'utf8').catch(() => null);
    if (text === null || sha256(text) !== attempt.finish.stream_sha256) throw new Error(`${entry.id}: the attempt stream for ${job} is missing or does not match the ledger.`);
    const current = await readFile(target, 'utf8').catch(() => null);
    if (current !== text) await writeFile(target, text);
    return { attempt: attempt.attempt, sha256: attempt.finish.stream_sha256, text, restored: current !== text };
  };
  const research = await settle(`run:${entry.id}`, `${base}.jsonl`);
  if (!research) throw new Error(`${entry.id}: a report turn finished in the ledger without a finished research session.`);
  const stopped = collectToolUses(parseEvents(research.text)).length > cap;
  if (!stopped && (await finishedAttempts(dir, `report:${entry.id}`)).length > 0) throw new Error(`${entry.id}: a report turn finished for a run that was not stopped.`);
  const report = stopped ? await settle(`report:${entry.id}`, `${base}.report.jsonl`) : null;
  const previous = await readMeta(base);
  const reportAborted = stopped && !report && (await abortedAttempts(dir, `report:${entry.id}`)).length > 0;
  const meta = {
    ...(previous && typeof previous === 'object' ? previous : {}),
    state: !stopped || report ? 'complete' : reportAborted ? 'aborted' : 'report-pending',
    stopped,
    research_attempt: research.attempt,
    research_sha256: research.sha256,
    report_attempt: report?.attempt ?? null,
    report_sha256: report?.sha256 ?? null,
  };
  const changed = JSON.stringify(previous) !== JSON.stringify(meta) || research.restored || Boolean(report?.restored);
  if (changed) {
    meta.reconciled = true;
    await writeMeta(base, meta);
  }
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
/**
 * `researchOnly` audits a run whose report turn has not run yet (a STOP, the
 * cap, or a version pause left it pending): everything except the report
 * turn's own evidence, so a deviation in its research is found before any
 * more is spent (reviewer pass 1, R1).
 */
export async function auditRun(dir, entry, cap, manifest = null, { researchOnly = false } = {}) {
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
    if (stopped && !researchOnly) violations.push(...(await expect('report-turn', `report:${entry.id}`, reportText, meta.report_attempt, meta.report_sha256)));
    else if ((await finishedAttempts(dir, `report:${entry.id}`)).length > 0) violations.push('report turn recorded for a run that was not stopped');
  } else {
    if (!meta.research_sha256 || sha256(researchText) !== meta.research_sha256) violations.push('research transcript has no matching run metadata');
    if (stopped && !researchOnly && (!meta.report_sha256 || sha256(reportText ?? '') !== meta.report_sha256)) violations.push('report-turn transcript has no matching run metadata');
  }
  if (!researchOnly && meta.state !== undefined && meta.state !== 'complete') violations.push(`run state is ${meta.state}`);
  if (entry.prompt_sha256) {
    const prompt = await readFile(path.join(dir, 'prompts', `${entry.id}.txt`), 'utf8').catch(() => null);
    if (prompt === null || sha256(prompt) !== entry.prompt_sha256) violations.push('prompt changed since prepare');
  }

  const reads = [];
  const errors = collectToolResultErrors(research);
  // Path confinement covers every call issued, beyond the allowance too.
  for (const use of calls) violations.push(...(await confinementProblems(use, realRoot)));
  for (const use of counted) {
    const target = use.input?.file_path ?? use.input?.path ?? null;
    if (target && use.name === 'Read') reads.push(path.relative(realRoot, await safeRealpath(path.isAbsolute(target) ? target : path.join(realRoot, target))));
  }
  // Naming an evaluation file is an observation, never a deviation by itself.
  const observations = isolationObservations(counted, results, errors);

  // Provenance: no input the evaluated sessions received may carry label-copy
  // content that the run copy does not hold.
  const isolation = await isolationFor(dir, manifest, entry);
  if (isolation.problem) violations.push(isolation.problem);
  if (isolation.forbidden) {
    const prompt = await readFile(path.join(dir, 'prompts', `${entry.id}.txt`), 'utf8').catch(() => null);
    const promptHits = prompt === null ? 0 : countFingerprintHits(prompt, isolation.prompt);
    if (promptHits > 0) violations.push(`forbidden content delivered: ${promptHits} isolation fingerprint(s) in the prompt`);
    calls.forEach((use, index) => {
      const hits = results.has(use.id) ? countFingerprintHits(results.get(use.id), isolation.forbidden, { toolOutput: true }) : 0;
      if (hits > 0) violations.push(`forbidden content delivered: ${hits} isolation fingerprint(s) in the result of call ${index + 1} (${use.name})`);
    });
    // A report turn's input must equal the replay (checked below): the prompt
    // and the allowed calls' results, both scanned here, plus the agent's own
    // text, which is not a delivery and is not scanned.
  }
  violations.push(...sessionProblems(research, { label: 'research', tools: RESEARCH_TOOLS, version, requireResult: !stopped }));
  const excessIds = new Set(calls.filter((use) => boundary && !boundary.allowed.has(use.id)).map((use) => use.id));
  const resultChars = counted.reduce((sum, use) => sum + [...(results.get(use.id) ?? '')].length, 0);
  let report = '';
  if (stopped && researchOnly) {
    if (!boundary) violations.push('stopped run without an identifiable boundary');
  } else if (stopped) {
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
    evaluation_exclusions: observations.exclusions,
    isolation_observations: observations,
    violations,
  };
}

const EVALUATION_NAME = /recall-evaluation/i;

/**
 * Observations, not deviations (later attempt › isolation rule): counted calls
 * whose input names an evaluation file, split into exclusions (a Grep's
 * negated glob, amendment 2), unsuccessful searches (the result delivered
 * nothing: an error, an empty result, or "No files found" and the like), and
 * other mentions (the result delivered run-copy content). The split of the
 * last two reads the tool's result text and is for reporting only.
 */
export function isolationObservations(uses, results, errors = new Set()) {
  const counts = { exclusions: 0, unsuccessful_searches: 0, mentions: 0 };
  for (const use of uses) {
    if (!EVALUATION_NAME.test(JSON.stringify(use.input ?? {}))) continue;
    if (isEvaluationExclusion(use)) counts.exclusions += 1;
    else if (unsuccessfulResult(results.get(use.id), errors.has(use.id))) counts.unsuccessful_searches += 1;
    else counts.mentions += 1;
  }
  return counts;
}

function unsuccessfulResult(text, isError) {
  if (isError || text === undefined) return true;
  const trimmed = String(text).trim();
  return trimmed === '' || /^(?:no files found|no matches found|found 0\b|file does not exist|<tool_use_error>)/i.test(trimmed);
}

/**
 * Path confinement: a call's path must resolve inside the run copy, and a
 * Glob pattern or Grep glob may name no absolute path, home path, or `..`
 * segment. A pattern is read as ripgrep's glob grammar reads it (Change 7):
 * brace groups are expanded first, nested ones included, so a group followed
 * by a path is one relative pattern (attempt 1 stopped on
 * `{architecture,sessions}/**\/*.md` read as `/**\/*.md`); a backslash
 * escapes the next character, and inside a character class braces and commas
 * are literal (reviewer pass 4, R6). Each expansion is split on whitespace
 * and commas, loses a leading `!`, and is checked as written and unescaped.
 * Ripgrep rejects unbalanced braces; such a pattern is read both with its
 * stray braces as literals and token by token as before, and a finding in
 * either counts. A pattern the check cannot read within its bounds is itself
 * a finding, never a clean result (R7).
 */
export async function confinementProblems(use, realRoot) {
  const problems = [];
  const target = use.input?.file_path ?? use.input?.path ?? null;
  if (typeof target === 'string' && target) {
    const resolved = await safeRealpath(path.isAbsolute(target) ? target : path.join(realRoot, target));
    if (resolved !== realRoot && !resolved.startsWith(`${realRoot}${path.sep}`)) problems.push(`${use.name} outside the run copy: ${target}`);
  }
  const patterns = [use.name === 'Glob' ? use.input?.pattern : null, use.name === 'Grep' ? use.input?.glob : null].filter((value) => typeof value === 'string');
  for (const pattern of patterns) {
    const reading = readGlob(pattern);
    if (reading.unchecked) {
      problems.push(`${use.name} pattern cannot be checked (${reading.unchecked}): ${pattern.slice(0, 200)}`);
      continue;
    }
    for (const token of reading.tokens) {
      if ([token, token.replace(/\\(.)/gs, '$1')].some(escapesRunCopy)) problems.push(`${use.name} pattern reaches outside the run copy: ${token}`);
    }
  }
  return problems;
}

function escapesRunCopy(token) {
  return token.startsWith('/') || token.startsWith('~') || /(^|[\\/])\.\.([\\/]|$)/.test(token);
}

const GLOB_EXPANSION_LIMIT = 4096;
const GLOB_LENGTH_LIMIT = 4096;
const GLOB_NESTING_LIMIT = 64;

/**
 * The tokens a glob names, as `confinementProblems` checks them, or
 * `{ unchecked: reason }` when it is longer than GLOB_LENGTH_LIMIT, nests
 * groups deeper than GLOB_NESTING_LIMIT, or has more than
 * GLOB_EXPANSION_LIMIT expansions.
 */
export function readGlob(pattern) {
  if (pattern.length > GLOB_LENGTH_LIMIT) return { unchecked: `longer than ${GLOB_LENGTH_LIMIT} characters` };
  let expansions = expandBraces(pattern);
  let fragments = [];
  if (expansions === UNBALANCED) {
    expansions = expandBraces(pattern, { lenient: true });
    fragments = pattern.split(/[\s,{}]+/);
  }
  if (expansions === TOO_DEEP) return { unchecked: `brace groups nested deeper than ${GLOB_NESTING_LIMIT}` };
  if (expansions === null) return { unchecked: `more than ${GLOB_EXPANSION_LIMIT} brace expansions` };
  const tokens = [...expansions.flatMap((expansion) => expansion.split(/[\s,]+/)), ...fragments];
  return { tokens: [...new Set(tokens.map((value) => value.replace(/^!+/, '')).filter(Boolean))] };
}

const UNBALANCED = Symbol('unbalanced braces');
const TOO_DEEP = Symbol('brace groups nested too deep');

/**
 * Every expansion of a glob's brace groups, nested groups included
 * (`{a,{b,c}}/x` → `a/x`, `b/x`, `c/x`), following ripgrep's grammar: a
 * backslash escapes the next character, and a character class (`[...]`,
 * where a `]` right after `[`, `[!`, or `[^` is a member) is literal.
 * Escapes and classes stay in the expansions as written. Returns null past
 * GLOB_EXPANSION_LIMIT expansions, TOO_DEEP past GLOB_NESTING_LIMIT nested
 * groups, and UNBALANCED for an unclosed group, stray `}`, or unclosed
 * class, unless `lenient`, which reads those as literal characters, as a
 * shell does.
 */
export function expandBraces(pattern, { lenient = false } = {}) {
  try {
    const matches = matchBraces(pattern, lenient);
    return expandGlobNodes(parseGlobRange(pattern, 0, pattern.length, matches));
  } catch (error) {
    if (error === UNBALANCED || error === TOO_DEEP) return error;
    throw error;
  }
}

/**
 * One left-to-right pass pairs each `{` with its `}`, skipping escapes and
 * classes, so parsing never backtracks. Unpaired braces and unclosed classes
 * are UNBALANCED, or literal when `lenient` (a `}` closes the latest open
 * `{`, as in a shell).
 */
function matchBraces(pattern, lenient) {
  const matches = new Map();
  const open = [];
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '\\') {
      index += 1;
    } else if (char === '[') {
      const close = classClose(pattern, index);
      if (close === -1 && !lenient) throw UNBALANCED;
      if (close !== -1) index = close;
    } else if (char === '{') {
      open.push(index);
      if (open.length > GLOB_NESTING_LIMIT) throw TOO_DEEP;
    } else if (char === '}') {
      if (open.length > 0) matches.set(open.pop(), index);
      else if (!lenient) throw UNBALANCED;
    }
  }
  if (open.length > 0 && !lenient) throw UNBALANCED;
  return matches;
}

/** Literal text and brace groups (each a list of alternatives) in pattern[start, end). */
function parseGlobRange(pattern, start, end, matches) {
  const nodes = [];
  let literal = '';
  let index = start;
  while (index < end) {
    const char = pattern[index];
    const close = char === '[' ? classClose(pattern, index) : -1;
    if (char === '\\') {
      literal += pattern.slice(index, index + 2);
      index += 2;
    } else if (close !== -1 && close < end) {
      literal += pattern.slice(index, close + 1);
      index = close + 1;
    } else if (char === '{' && matches.has(index)) {
      const groupEnd = matches.get(index);
      const alternatives = [];
      let alternativeStart = index + 1;
      for (let cursor = index + 1; cursor <= groupEnd; cursor += 1) {
        const inner = pattern[cursor];
        const innerClose = inner === '[' ? classClose(pattern, cursor) : -1;
        if (inner === '\\') cursor += 1;
        else if (innerClose !== -1 && innerClose < groupEnd) cursor = innerClose;
        else if (inner === '{' && matches.has(cursor)) cursor = matches.get(cursor);
        else if (inner === ',' || cursor === groupEnd) {
          alternatives.push(parseGlobRange(pattern, alternativeStart, cursor, matches));
          alternativeStart = cursor + 1;
        }
      }
      nodes.push(literal, { alternatives });
      literal = '';
      index = groupEnd + 1;
    } else {
      literal += char;
      index += 1;
    }
  }
  nodes.push(literal);
  return nodes;
}

function classClose(pattern, open) {
  let index = open + 1;
  if (pattern[index] === '!' || pattern[index] === '^') index += 1;
  if (pattern[index] === ']') index += 1;
  return pattern.indexOf(']', index);
}

function expandGlobNodes(nodes) {
  let expansions = [''];
  for (const node of nodes) {
    if (typeof node === 'string') {
      expansions = expansions.map((expansion) => expansion + node);
      continue;
    }
    const alternatives = [];
    for (const alternative of node.alternatives) {
      const expanded = expandGlobNodes(alternative);
      if (expanded === null || alternatives.length + expanded.length > GLOB_EXPANSION_LIMIT) return null;
      alternatives.push(...expanded);
    }
    if (expansions.length * alternatives.length > GLOB_EXPANSION_LIMIT) return null;
    expansions = expansions.flatMap((expansion) => alternatives.map((alternative) => expansion + alternative));
  }
  return expansions;
}

/**
 * A7 pre-run amendment 2: a Grep whose only mention of an evaluation file is
 * a negated glob (such as `!recall-evaluation*`, alone or in a brace list)
 * excludes those files from its search; it is counted, not a deviation. Any
 * other input naming one — a path, a search pattern, a positive or mixed
 * glob, or another tool — remains a deviation. Globs are split on whitespace
 * only, so a token that does not itself start with `!` counts as positive.
 */
export function isEvaluationExclusion(use) {
  if (use?.name !== 'Grep' || typeof use.input?.glob !== 'string') return false;
  const { glob, ...rest } = use.input;
  if (EVALUATION_NAME.test(JSON.stringify(rest))) return false;
  const naming = glob.trim().split(/\s+/).filter((token) => EVALUATION_NAME.test(token));
  return naming.length > 0 && naming.every((token) => token.startsWith('!'));
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

/** Ids of tool results the stream marks as errors. */
function collectToolResultErrors(events) {
  const ids = new Set();
  for (const event of events) {
    if (event.type !== 'user') continue;
    for (const block of event.message?.content ?? []) if (block?.type === 'tool_result' && block.is_error) ids.add(block.tool_use_id);
  }
  return ids;
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

// -------------------------------------------------------------- isolation

/**
 * Text as fingerprints see it: NFKC, lower case, and every run of characters
 * other than ASCII letters and digits as one space, so markup, punctuation,
 * and line breaks never matter.
 */
export function normalizeText(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * A tool result without its per-line framing: Read's line numbers, and a
 * Grep line's `path:line:` (or `path-line-`, or `path:`) prefix, where the
 * path may hold spaces. Stripping only removes words, so it can never create
 * a fingerprint; a prefix it misses is covered by the run copy's composed
 * fingerprints (`runCopyFingerprints`).
 */
export function stripToolPrefixes(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\d+(?:→|\t)/, '').replace(/^.*?\.[A-Za-z0-9]{1,8}(?::\d+)?[:-]/, ''))
    .join('\n');
}

function tokensOf(text) {
  return normalizeText(text).split(' ').filter(Boolean);
}

/** Adds the eligible 8-grams of a token run (at least five words of three or more letters); `crossing` keeps only those that include index `crossing`. */
function addGrams(tokens, out, { crossing = null, only = null } = {}) {
  const { words, min_long_words: minLong, long_word_letters: letters } = FINGERPRINT;
  if (tokens.length < words) return;
  const long = tokens.map((token) => token.length >= letters && /^[a-z]+$/.test(token));
  let longCount = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    if (long[index]) longCount += 1;
    if (index >= words && long[index - words]) longCount -= 1;
    if (index < words - 1 || longCount < minLong) continue;
    const first = index - words + 1;
    if (crossing !== null && (first >= crossing || index < crossing)) continue;
    const print = sha256(tokens.slice(first, index + 1).join(' ')).slice(0, 16);
    if (!only || only.has(print)) out.add(print);
  }
}

/** The 8-grams that span the join of two token runs (the last seven of `left`, the first seven of `right`). */
function addJoinGrams(left, right, out, only = null) {
  const tail = left.slice(-(FINGERPRINT.words - 1));
  const head = right.slice(0, FINGERPRINT.words - 1);
  if (tail.length === 0 || head.length === 0) return;
  addGrams([...tail, ...head], out, { crossing: tail.length, only });
}

/**
 * The fingerprints of a text: hashes of its normalized word 8-grams that
 * hold at least five words of three or more letters, taken within each line,
 * never across a line break. Read and Grep deliver whole lines, so a
 * delivered run-copy line carries only fingerprints its file has, which the
 * index never forbids; an 8-gram joined across two lines of a Grep result
 * could otherwise match a label line by chance.
 */
export function fingerprints(text, { toolOutput = false } = {}) {
  const out = new Set();
  for (const line of String(toolOutput ? stripToolPrefixes(text) : text ?? '').split(/\r?\n/)) addGrams(tokensOf(line), out);
  return out;
}

/**
 * Everything a tool can derive from one run-copy file without any other
 * input: its lines, its path (a Glob or Grep listing), and a line composed
 * with its path or its line number in any framing (`path:12:line`,
 * `path:line`, `12→line`). Composition matters because label text cites
 * passages as `path › heading`, which no single corpus line holds.
 */
export function runCopyFingerprints(relativePath, text, only = null) {
  const out = new Set();
  const pathTokens = tokensOf(relativePath);
  addGrams(pathTokens, out, { only });
  if (text === null) return out;
  String(text)
    .split(/\r?\n/)
    .forEach((line, index) => {
      const tokens = tokensOf(line);
      const number = [String(index + 1)];
      addGrams(tokens, out, { only });
      addJoinGrams(pathTokens, tokens, out, only);
      addJoinGrams([...pathTokens, ...number], tokens, out, only);
      addJoinGrams(pathTokens, number, out, only);
      addJoinGrams(number, tokens, out, only);
    });
  return out;
}

/** How many distinct forbidden fingerprints a delivered text carries. */
export function countFingerprintHits(text, forbidden, options = {}) {
  if (!forbidden || forbidden.size === 0) return 0;
  let hits = 0;
  for (const print of fingerprints(text, options)) if (forbidden.has(print)) hits += 1;
  return hits;
}

/** `forbidden` without the fingerprints of designed deliveries. */
export function subtractFingerprints(forbidden, texts) {
  const out = new Set(forbidden);
  for (const text of texts) for (const print of fingerprints(text)) out.delete(print);
  return out;
}

/**
 * The prompt channel also carries the harness's own frame: the prompt
 * template rendered with this run's task, files, and startup-file wrappers
 * (contents left out), and the report-turn template.
 */
export function withoutPromptFrame(forbidden, task, startupPaths = []) {
  const frame = task ? renderPrompt(task, startupPaths.map((file) => ({ path: file, content: '' }))) : PROMPT_TEMPLATE;
  return subtractFingerprints(forbidden, [frame, REPORT_TURN_TEMPLATE.replace('{prompt}', '\n').replace('{transcript}', '\n')]);
}

/**
 * The isolation index (later attempt › isolation rule): the fingerprints of
 * the label copies that no corpus file can deliver (`runCopyFingerprints`).
 * Content shared with the corpus — its disclosed historical tuning
 * contamination, quoted passages, marker-like text, path and heading
 * references a tool can compose — is never forbidden; label-only content
 * always is, whatever markers it carries or lacks.
 */
export async function buildIsolationIndex(labelTexts, corpusDir) {
  const label = new Set();
  for (const text of labelTexts) for (const print of fingerprints(text)) label.add(print);
  const shared = new Set();
  for (const file of await listFiles(corpusDir)) {
    const symlink = (await lstat(path.join(corpusDir, file))).isSymbolicLink();
    const text = symlink ? null : await readFile(path.join(corpusDir, file), 'utf8');
    for (const print of runCopyFingerprints(file, text, label)) shared.add(print);
  }
  return {
    method: {
      ...FINGERPRINT,
      hash: 'sha256 of the space-joined 8-gram, first 16 hex characters',
      scope: 'within one line; never across a line break',
      normalization: 'NFKC, lower case, runs of characters other than a-z and 0-9 as one space; tool results first lose Read line numbers and Grep path:line: prefixes',
      forbidden: "label-copy fingerprints minus every corpus file's run-copy fingerprints (its lines, its path, and each line joined with its path or line number); per run also minus its lane files, its brief, and its own location (Change 8: its root as given and resolved, each run-copy file's absolute path, and Claude Code's project-store directory for that root); in the prompt channel also minus the prompt frame rendered for the run's own task, files, and startup files",
    },
    label_fingerprints: label.size,
    shared_with_corpus: shared.size,
    fingerprints: [...label].filter((print) => !shared.has(print)).sort(),
  };
}

const RUN_COPY_EXTRAS = [...LANE_FILES, 'sessions/active/eval/brief.md'];

/**
 * The forbidden set for one run: the index minus the run copy's own files
 * beyond the corpus (lane files and, in the brief arm, its brief), and minus
 * its own location (Change 8): its root as given and resolved, every run-copy
 * file's absolute path, and Claude Code's project-store directory for that
 * working directory, which an oversized-output notice names. Attempt 2
 * stopped on that notice matching the evaluation folder's path in the label
 * copy. An 8-gram joining label words to location words stays forbidden.
 */
export async function runForbidden(forbidden, root) {
  const out = new Set(forbidden);
  for (const file of RUN_COPY_EXTRAS) {
    const text = await readFile(path.join(root, file), 'utf8').catch(() => null);
    if (text === null) continue;
    for (const print of runCopyFingerprints(file, text, out)) out.delete(print);
  }
  const roots = [...new Set([root, await realpath(root).catch(() => root)])];
  const files = await listFiles(root).catch(() => []);
  const locations = roots.flatMap((value) => [value, claudeProjectDir(value), ...files.map((file) => path.join(value, file))]);
  for (const location of locations) for (const print of fingerprints(location)) out.delete(print);
  return out;
}

/** Where Claude Code keeps a working directory's session files, including oversized tool results. */
export function claudeProjectDir(cwd) {
  return path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

const ISOLATION_CACHE = new Map();

/**
 * The run's forbidden set, from `isolation.json` verified against the
 * manifest, and its prompt-channel set. A manifest without an isolation
 * index (unit use) skips the scan; a missing or changed index is a deviation.
 */
async function isolationFor(dir, manifest, entry) {
  if (!manifest?.isolation) return { forbidden: null };
  const text = await readFile(path.join(dir, 'isolation.json'), 'utf8').catch(() => null);
  if (text === null || sha256(text) !== manifest.isolation.sha256) return { problem: 'the isolation index is missing or changed since prepare' };
  const key = `${dir}\0${manifest.isolation.sha256}`;
  if (!ISOLATION_CACHE.has(key)) ISOLATION_CACHE.set(key, new Set(JSON.parse(text).fingerprints));
  const task = (manifest.tasks ?? []).find((candidate) => candidate.id === entry.task) ?? null;
  const forbidden = await runForbidden(ISOLATION_CACHE.get(key), entry.root);
  return { forbidden, prompt: withoutPromptFrame(forbidden, task, (entry.startup_files ?? []).map((file) => file.path)) };
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
 * One paid session as a ledger attempt: a `start` record before it is
 * spawned, a `spawned` record with its process id, and then a `finish`
 * record, or an `aborted` record when an abort terminated it. Without a
 * ledger (unit use) the attempt is 1 and nothing is recorded.
 */
async function paidCall(ledgerDir, kind, job, reserve, fileFor, invoke) {
  const attempt = ledgerDir ? (await attemptsOf(ledgerDir, job)) + 1 : 1;
  const file = fileFor(attempt);
  const call = `${job}#${attempt}`;
  if (ledgerDir) await appendLedger(ledgerDir, { event: 'start', call, kind, job, attempt, reserve_usd: reserve, file });
  let spawned = Promise.resolve();
  const onSpawn = (pid) => {
    if (ledgerDir) spawned = appendLedger(ledgerDir, { event: 'spawned', call, pid });
  };
  const output = await invoke(file, onSpawn);
  await spawned;
  const events = parseEvents(output.stdout);
  const { cost, source: costSource } = streamCost(events);
  const hash = sha256(output.stdout);
  if (ledgerDir) {
    if (output.aborted) {
      await appendLedger(ledgerDir, { event: 'aborted', call, cost_usd: cost, cost_source: costSource, stream_sha256: hash, reason: output.abortReason, exit: { code: output.code, signal: output.signal } });
    } else {
      await appendLedger(ledgerDir, { event: 'finish', call, cost_usd: cost, cost_source: costSource, stream_sha256: hash });
    }
  }
  return { ...output, events, attempt, call, file, sha256: hash, killed: output.stopped, cost };
}

/**
 * One session's cost from its stream, in the spending contract's order: the
 * result's reported cost (zero included), else the estimate from its
 * per-message usage, else unknown (the ledger then holds its reserve).
 */
export function streamCost(events) {
  const result = [...events].reverse().find((event) => event.type === 'result');
  if (typeof result?.total_cost_usd === 'number' && Number.isFinite(result.total_cost_usd)) return { cost: result.total_cost_usd, source: 'reported' };
  const estimate = estimateCost(streamUsage(events));
  return estimate && estimate > 0 ? { cost: estimate, source: 'estimated' } : { cost: null, source: 'unknown' };
}

/** Aborted ledger attempts for a job: terminated by an abort, or left behind by a killed harness and recorded at the next start. */
async function abortedAttempts(dir, job) {
  const ledger = await readLedger(dir);
  const calls = new Set(ledger.filter((record) => record.event === 'start' && record.job === job).map((record) => record.call));
  return ledger.filter((record) => record.event === 'aborted' && calls.has(record.call));
}

/**
 * Spend from the ledger alone — the one source for the cap and the report.
 * An attempt counts its reported cost, else its cost estimated from the usage
 * in its stream file (stopped or interrupted sessions), else its reserve,
 * listed as unresolved. Nothing counts as zero for lack of a number.
 */
export async function ledgerSpend(dir) {
  const entries = await readLedger(dir);
  // An aborted attempt is closed by its `aborted` record, costed the same way.
  const finishes = new Map(entries.filter((record) => record.event === 'finish' || record.event === 'aborted').map((record) => [record.call, record]));
  const spend = { total: 0, by_kind: { research: 0, report: 0, grader: 0 }, attempts: 0, estimated: [], unresolved: [], reserved_unresolved: 0, aborted: [], open: [] };
  for (const start of entries.filter((record) => record.event === 'start')) {
    spend.attempts += 1;
    const finish = finishes.get(start.call);
    if (finish?.event === 'aborted') spend.aborted.push(start.call);
    if (!finish) spend.open.push(start.call);
    let cost = typeof finish?.cost_usd === 'number' ? finish.cost_usd : null;
    if (finish?.cost_source === 'estimated') spend.estimated.push(start.call);
    if (cost === null) {
      const streamed = start.file ? await readFile(start.file, 'utf8').catch(() => '') : '';
      const fromStream = streamCost(parseEvents(streamed));
      if (fromStream.cost !== null) {
        cost = fromStream.cost;
        if (fromStream.source === 'estimated') spend.estimated.push(start.call);
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
  const task = parseTasks(mergedTuningSection(await readFile(path.resolve(opts.tuningLabels), 'utf8')), 'tuning', 5).find((entry) => entry.id === opts.task);
  if (!task) throw new Error(`smoke: no tuning task ${opts.task}.`);
  await mkdir(path.join(dir, 'transcripts'), { recursive: true });
  await mkdir(path.join(dir, 'prompts'), { recursive: true });
  const root = await makeRunCopy(path.resolve(opts.corpus), path.join(dir, 'runs', 'smoke'), task);
  const prompt = renderPrompt(task, await readStartupFiles(root, 'baseline'))
    .replaceAll(`at most ${TOOL_CALL_CAP} tool calls`, `at most ${opts.statedCap} tool calls`)
    .replaceAll(`when you make call ${TOOL_CALL_CAP + 1}`, `when you make call ${opts.statedCap + 1}`)
    .replaceAll(`from your first ${TOOL_CALL_CAP} calls`, `from your first ${opts.statedCap} calls`);
  await writeFile(path.join(dir, 'prompts', 'smoke.txt'), prompt);
  await withHarnessLock(ctx, async () => {
    await reapOrphans(ctx);
    const outcome = await runAgent(prompt, root, path.join(dir, 'transcripts', 'smoke'), opts.cap, { ledgerDir: dir, runId: 'smoke', signal: ctx.signal, graceMs: ctx.graceMs });
    if (outcome.state !== 'complete') {
      if (ctx.signal?.aborted) await recordAbort(ctx, 'smoke', ['smoke']);
      log(ctx, `smoke: ${outcome.state}`);
      return;
    }
    const metrics = await auditRun(dir, { id: 'smoke', root }, opts.cap);
    log(ctx, JSON.stringify({ ...outcome, ...metrics, report: `${metrics.report.slice(0, 400)}…` }, null, 2));
  });
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
  return withHarnessLock(ctx, async () => {
    await reapOrphans(ctx);
    for (const entry of manifest.runs) if (await ledgerHasFinished(ctx.dir, entry.id)) await reconcileRun(ctx.dir, entry, manifest.tool_call_cap);
    await refuseTerminal(ctx, manifest, 'grade');
    const version = versionGuard(manifest);
    if (!version.check()) throw new Error(versionChangedError(version));
    const outcome = await gradeTasks({ ...ctx, version }, manifest, labels, tasks, cap);
    if (ctx.signal?.aborted) await recordAbort(ctx, 'grade', []);
    else if (version.found !== null) {
      await appendLedger(ctx.dir, { event: 'stopped', stage: 'grade', reason: 'claude-version', expected: version.expected, found: version.found });
      log(ctx, `Stopped grading: ${versionChangedError(version)}`);
      process.exitCode = 5;
    }
    return outcome;
  });
}

async function gradeTasks(ctx, manifest, labels, tasks, cap) {
  const { dir } = ctx;

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
  if (first.skipped.length === 0 && !ctx.signal?.aborted && !ctx.version?.found) {
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
  const dispatched = new Set();
  await pool(jobs, ctx.concurrency ?? 4, async (job) => {
    dispatched.add(job.name);
    const target = path.join(gradingDir, `${job.name}.json`);
    if (ctx.signal?.aborted) {
      skipped.push(job.name);
      return;
    }
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
      // The same guard as research sessions, before every grader attempt (reviewer pass 1, R2).
      if (ctx.signal?.aborted || (await stopRequested(dir)) || (ctx.version && !ctx.version.check())) {
        skipped.push(job.name);
        return;
      }
      const call = await paidCall(dir, 'grader', `grade:${job.name}`, GRADE_RESERVE_USD, (attempt) => path.join(gradingDir, `${job.name}.attempt-${attempt}.stdout.jsonl`), (streamFile, onSpawn) =>
        spawnClaudeStream([...CLAUDE_ARGS, ...NO_TOOLS, ...STREAM, '--json-schema', JSON.stringify(job.schema)], job.prompt, workDir, Infinity, { streamFile, signal: ctx.signal, graceMs: ctx.graceMs, onSpawn }),
      );
      // An aborted grader attempt counts toward the attempt limit; a later invocation may try again within it.
      if (call.aborted) {
        skipped.push(job.name);
        return;
      }
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
  }, { signal: ctx.signal, stop: async () => Boolean(ctx.version?.found) || (await stopRequested(dir)) });
  skipped.push(...jobs.filter((job) => !dispatched.has(job.name)).map((job) => job.name));
  if (skipped.length > 0 && !ctx.signal?.aborted && !ctx.version?.found) {
    log(ctx, `Stopped at the cost cap or the STOP file: ${skipped.length} grading job(s) not started. Resume with a cap the founder approves.`);
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
  const forbidden = new Set(JSON.parse(await readFile(path.join(dir, 'isolation.json'), 'utf8')).fingerprints);
  const failures = [];
  const added = [];
  for (const { id } of screened.flagged) {
    const task = manifest.tasks.find((candidate) => candidate.id === id);
    const taskIndex = manifest.tasks.indexOf(task);
    for (let replicate = STAGE1_REPLICATES + 1; replicate <= STAGE1_REPLICATES + STAGE2_REPLICATES; replicate += 1) {
      for (const entry of armPair(manifest.runs, task, taskIndex, replicate, 2)) {
        manifest.runs.push(entry);
        added.push(entry);
        failures.push(...(await prepareRun(dir, entry, manifest.tasks, manifest.corpus, corpusHashes, relations, manifest.briefs, forbidden)));
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
    // Later attempt › isolation rule: calls naming an evaluation file (observations, not deviations), and the runs that made them.
    isolation_observations: Object.fromEntries(
      ['baseline', 'brief'].map((arm) => [
        arm,
        Object.fromEntries(
          ['exclusions', 'unsuccessful_searches', 'mentions'].map((kind) => [
            kind,
            {
              calls: rows.reduce((sum, row) => sum + row.runs[arm].reduce((runs, entry) => runs + (entry.metrics.isolation_observations?.[kind] ?? 0), 0), 0),
              runs: rows.reduce((sum, row) => sum + row.runs[arm].filter((entry) => (entry.metrics.isolation_observations?.[kind] ?? 0) > 0).length, 0),
            },
          ]),
        ),
      ]),
    ),
    cost_usd: { total: spend.total, by_kind: spend.by_kind, attempts: spend.attempts, estimated: spend.estimated.length, unresolved: spend.unresolved, reserved_unresolved: spend.reserved_unresolved, aborted: spend.aborted, open: spend.open },
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
  if (manifest.isolation && sha256(await readFile(path.join(dir, 'isolation.json'), 'utf8').catch(() => '')) !== manifest.isolation.sha256) problems.push('isolation.json changed since prepare');
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
 * Grading labels: the 12 tuning blocks as re-verified for corpus v3
 * (recall-evaluation.md › A7 later attempt › Merged v3 tuning labels, every
 * tuning block in full), then the held-out blocks.
 */
async function loadLabels(dir, manifest) {
  const tuningText = await readFile(path.join(dir, 'labels', TUNING_LABEL_FILE), 'utf8');
  const heldoutText = await readFile(path.join(dir, 'labels', HELDOUT_LABEL_FILE), 'utf8');
  if (sha256(heldoutText) !== manifest.heldout_sha256) throw new Error(`${HELDOUT_LABEL_FILE} changed since prepare.`);
  return mergeLabels(tuningText, heldoutText);
}

/** The merged v3 tuning section: from its heading to the next heading of level 2–4. */
export function mergedTuningSection(tuningText) {
  const start = tuningText.indexOf(`${MERGED_TUNING_HEADING}`);
  if (start === -1) throw new Error(`${TUNING_LABEL_FILE} has no "${MERGED_TUNING_HEADING.replace(/^#+ /, '')}" section.`);
  const rest = tuningText.slice(start + MERGED_TUNING_HEADING.length);
  const end = rest.search(/\n#{2,4} /);
  return `${MERGED_TUNING_HEADING}${end === -1 ? rest : rest.slice(0, end)}`;
}

export function mergeLabels(tuningText, heldoutText) {
  const labels = new Map(parseLabels(mergedTuningSection(tuningText), 5).map((label) => [label.id, label]));
  for (const label of parseLabels(heldoutText)) {
    if (labels.has(label.id)) throw new Error(`label ${label.id} is both a tuning and a held-out task.`);
    labels.set(label.id, label);
  }
  return labels;
}

export function parseTasks(markdown, split, level = 4) {
  const hashes = '#'.repeat(level);
  const pattern = new RegExp(`^${hashes} ([FTCN]\\d+) — [^\\n]*?· (tuning|held-out)\\b[^\\n]*\\n([\\s\\S]*?)(?=^#{2,${level}} |(?![\\s\\S]))`, 'gm');
  return [...markdown.matchAll(pattern)]
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
 *
 * The child runs in its own process group, so a kill reaches everything it
 * started. When `signal` aborts, the group gets SIGTERM, then SIGKILL after
 * `graceMs`; the promise still waits for the child to close, so its stream
 * is complete as far as it got, and resolves with `aborted: true`.
 */
export function spawnClaudeStream(claudeArgs, prompt, cwd, cap, { streamFile = null, signal = null, graceMs = ABORT_GRACE_MS, onSpawn = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, claudeArgs, { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: childEnv() });
    const sink = streamFile ? createWriteStream(streamFile, { flags: 'wx' }) : null;
    let stdout = '';
    let stderr = '';
    let buffer = '';
    let stopped = false;
    let aborted = false;
    let abortReason = null;
    let escalation = null;
    const seen = new Set();
    if (child.pid) {
      LIVE_CHILDREN.set(child.pid, child);
      onSpawn?.(child.pid);
    }
    const onAbort = () => {
      if (aborted || child.exitCode !== null || child.signalCode !== null) return;
      aborted = true;
      abortReason = String(signal.reason ?? 'aborted');
      killGroup(child.pid, 'SIGTERM');
      escalation = setTimeout(() => killGroup(child.pid, 'SIGKILL'), graceMs);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
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
          killGroup(child.pid, 'SIGKILL');
          return;
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      LIVE_CHILDREN.delete(child.pid);
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code, exitSignal) => {
      clearTimeout(escalation);
      LIVE_CHILDREN.delete(child.pid);
      signal?.removeEventListener('abort', onAbort);
      // The group may still hold processes the child started; none may outlive it.
      if (aborted || stopped) killGroup(child.pid, 'SIGKILL');
      const done = () => resolve({ code, signal: exitSignal, stdout, stderr, stopped, aborted, abortReason, pid: child.pid });
      if (sink) sink.end(done);
      else done();
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

// Live child sessions by pid, so a second signal can kill them all at once.
const LIVE_CHILDREN = new Map();

/** Kills a child's whole process group (it leads one); falls back to the process alone. */
function killGroup(pid, signalName) {
  if (!pid) return;
  try {
    process.kill(-pid, signalName);
  } catch {
    try {
      process.kill(pid, signalName);
    } catch {
      // Already gone.
    }
  }
}

/** A second abort signal: SIGKILL every live child group without waiting for the grace period. */
export function killAllLiveChildren() {
  for (const pid of LIVE_CHILDREN.keys()) killGroup(pid, 'SIGKILL');
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Whether a live pid is a session this harness would have started (guards
 * against pid reuse): true, false, or null when the process cannot be
 * inspected (no `ps`, or no permission).
 */
function isHarnessChild(pid) {
  const listing = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  const command = String(listing.stdout ?? '').trim();
  if (listing.error || (listing.status !== 0 && command === '')) return processAlive(pid) ? null : false;
  return command.length > 0 && command.includes(path.basename(CLAUDE_BIN));
}

async function waitUntilGone(pid, ms) {
  const deadline = Date.now() + ms;
  while (processAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  return !processAlive(pid);
}

/**
 * Before any dispatch: every ledger attempt that started but never finished
 * or aborted belongs to a harness that was killed. A session still running
 * from it is terminated (its group, SIGTERM then SIGKILL) and awaited; each
 * such attempt is then recorded as aborted, costed from its stream when it
 * has usage, else held at its reserve as unresolved. It is never retried.
 */
export async function reapOrphans(ctx) {
  const { dir } = ctx;
  const graceMs = ctx.graceMs ?? ABORT_GRACE_MS;
  const ledger = await readLedger(dir);
  const closed = new Set(ledger.filter((record) => record.event === 'finish' || record.event === 'aborted').map((record) => record.call));
  const pids = new Map(ledger.filter((record) => record.event === 'spawned').map((record) => [record.call, record.pid]));
  const reaped = [];
  for (const start of ledger.filter((record) => record.event === 'start' && !closed.has(record.call))) {
    const pid = pids.get(start.call) ?? null;
    let reason = pid ? 'left by a killed harness; not running' : 'left by a killed harness before it spawned';
    const ours = pid && processAlive(pid) ? isHarnessChild(pid) : false;
    if (ours === null) throw new Error(`${start.call}: pid ${pid} is alive but cannot be inspected, so it may still be this harness's session; check it, stop it if so, and run again. Nothing was dispatched.`);
    if (ours) {
      killGroup(pid, 'SIGTERM');
      if (!(await waitUntilGone(pid, graceMs))) {
        killGroup(pid, 'SIGKILL');
        if (!(await waitUntilGone(pid, 5000))) throw new Error(`${start.call}: its session (pid ${pid}) survived SIGKILL; nothing is dispatched until it is gone.`);
      }
      killGroup(pid, 'SIGKILL');
      reason = 'left running by a killed harness; terminated';
    }
    const streamed = start.file ? await readFile(start.file, 'utf8').catch(() => '') : '';
    const { cost, source } = streamCost(parseEvents(streamed));
    await appendLedger(dir, { event: 'aborted', call: start.call, recovered: true, reason, pid, cost_usd: cost, cost_source: source, stream_sha256: sha256(streamed) });
    reaped.push(`${start.call} (${reason}; ${cost === null ? `unresolved, $${(start.reserve_usd ?? 0).toFixed(2)} reserved` : `${source} $${cost.toFixed(3)}`})`);
  }
  if (reaped.length > 0) log(ctx, `Recorded ${reaped.length} attempt(s) a killed harness left open, never retried:\n- ${reaped.join('\n- ')}`);
  return reaped;
}

/**
 * One harness invocation per evaluation directory at a time, so reaping can
 * never mistake another live invocation's sessions for orphans.
 */
async function withHarnessLock(ctx, work) {
  const lock = path.join(ctx.dir, 'harness.lock');
  const record = `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`;
  try {
    await writeFile(lock, record, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const holder = await readFile(lock, 'utf8').then(JSON.parse, () => null);
    if (holder?.pid && holder.pid !== process.pid && processAlive(holder.pid)) throw new Error(`another harness invocation (pid ${holder.pid}) holds ${lock}; wait for it, or stop it, first.`);
    log(ctx, `Taking over a stale harness lock${holder?.pid ? ` from pid ${holder.pid}` : ''}.`);
    await writeFile(lock, record);
  }
  ctx.startedAt = Date.now();
  try {
    return await work();
  } finally {
    await rm(lock, { force: true });
  }
}

/** After an abort: one ledger record and a summary that keeps estimated and unresolved costs explicit. */
async function recordAbort(ctx, stage, abortedJobs) {
  const { dir } = ctx;
  const ledger = await readLedger(dir);
  const startedAt = ctx.startedAt ?? 0;
  const mine = ledger.filter((record) => record.event === 'aborted' && !record.recovered && Date.parse(record.at) >= startedAt);
  const estimated = mine.filter((record) => record.cost_source === 'estimated').map((record) => record.call);
  const unresolved = mine.filter((record) => record.cost_source === 'unknown').map((record) => record.call);
  const spend = await ledgerSpend(dir);
  await appendLedger(dir, { event: 'abort', stage, reason: String(ctx.signal?.reason ?? 'aborted'), terminated: mine.map((record) => record.call), estimated, unresolved, open_attempts: spend.open, ledger_total_usd: spend.total });
  log(ctx, `Aborted (${ctx.signal?.reason ?? 'signal'}): dispatch stopped; ${mine.length} running session(s) terminated and awaited${abortedJobs.length > 0 ? ` (${abortedJobs.join(', ')})` : ''}. Costs: ${estimated.length} estimated from streamed usage${unresolved.length > 0 ? `, ${unresolved.length} unresolved and held at their reserve (${unresolved.join(', ')})` : ''}; ledger total $${spend.total.toFixed(2)}. Aborted evaluated sessions are never retried.`);
  if (spend.open.length > 0) log(ctx, `Still open in the ledger (no finish or abort record): ${spend.open.join(', ')}.`);
  process.exitCode = 130;
}

function replicatesOf(manifest, taskId) {
  return [...new Set(manifest.runs.filter((entry) => entry.task === taskId).map((entry) => entry.replicate))].sort((left, right) => left - right);
}

/** Runs `worker` over `items`, `size` at a time; no new item starts once `signal` aborts or `stop()` says so. */
async function pool(items, size, worker, { signal = null, stop = async () => false } = {}) {
  const queue = [...items];
  const failures = [];
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      while (queue.length > 0 && !signal?.aborted && !(await stop())) {
        if (signal?.aborted || queue.length === 0) break;
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

/** A tree entry's bytes: a file's contents, or a symlink's link text (what git stores for it). Links are never followed. */
async function entryBytes(root, file) {
  const target = path.join(root, file);
  return (await lstat(target)).isSymbolicLink() ? Buffer.from(await readlink(target)) : readFile(target);
}

async function hashTree(root) {
  const hashes = new Map();
  for (const file of await listFiles(root)) {
    const symlink = (await lstat(path.join(root, file))).isSymbolicLink();
    hashes.set(file, createHash('sha256').update(symlink ? 'symlink\0' : '').update(await entryBytes(root, file)).digest('hex'));
  }
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
        corpus_tag: CORPUS_TAG,
        startup_root_files: STARTUP_ROOT_FILES,
        label_files: LABEL_FILES,
        isolation_fingerprint: FINGERPRINT,
        abort_grace_ms: ABORT_GRACE_MS,
        latency_max_load_per_core: LATENCY_MAX_LOAD_PER_CORE,
        child_env_dropped: 'CLAUDE* except CLAUDE_CONFIG_DIR, AI_AGENT, VIBECOMPASS_*',
        claude_version_now: currentClaudeVersion(),
        agent_args: [...CLAUDE_ARGS, ...AGENT_TOOLS, ...STREAM],
        report_turn_args: [...CLAUDE_ARGS, ...NO_TOOLS, ...STREAM],
        grader_args: [...CLAUDE_ARGS, ...NO_TOOLS, ...STREAM, '--json-schema', '<schema>'],
      },
      null,
      2,
    ),
  );
}

/**
 * The command line. `overrides` is for offline tests only: a package
 * identity, a shorter abort grace, quiet logs. SIGINT, SIGTERM, and SIGHUP
 * abort `run`, `grade`, and `smoke` (a second signal kills every live
 * session at once); the process exits only after every child is awaited.
 */
export async function main(argv, overrides = {}) {
  const [command, ...args] = argv;
  const option = (name, fallback = null) => {
    const index = args.indexOf(name);
    return index === -1 ? fallback : args[index + 1];
  };
  const required = (name) => {
    const value = option(name);
    if (!value) throw new Error(`${command} requires ${name}.`);
    return value;
  };
  const controller = new AbortController();
  const ctx = {
    dir: option('--out') ? path.resolve(option('--out')) : null,
    cap: option('--max-cost-usd') === null ? null : Number(option('--max-cost-usd')),
    concurrency: Number(option('--concurrency', '4')),
    only: option('--only') ? new Set(option('--only').split(',')) : null,
    signal: controller.signal,
    ...overrides,
  };
  const commands = {
    prepare: () => prepare(ctx, { corpus: required('--corpus'), docsRepo: required('--docs-repo'), tuningLabels: required('--tuning-labels'), heldout: required('--heldout'), heldoutSha: required('--heldout-sha256'), warmRuns: Number(option('--warm-runs', '10')) }),
    run: () => run(ctx),
    grade: () => grade(ctx),
    screen: () => screen(ctx),
    confirm: () => confirm(ctx),
    score: () => score(ctx),
    smoke: () => smoke(ctx, { corpus: required('--corpus'), tuningLabels: required('--tuning-labels'), task: required('--task'), cap: Number(option('--cap', '3')), statedCap: Number(option('--stated-cap', option('--cap', '3'))) }),
  };
  if (command === 'describe') return describe();
  if (!commands[command] || !ctx.dir) {
    console.error('Usage: node scripts/evaluate-brief-a7.js <prepare|run|grade|screen|confirm|score|smoke|describe> --out <dir> [...]');
    process.exitCode = 2;
    return undefined;
  }
  const paid = ['run', 'grade', 'smoke'].includes(command);
  let received = 0;
  const onSignal = (name) => {
    received += 1;
    if (received === 1) {
      log(ctx, `${name}: aborting — no new session starts; running sessions get SIGTERM, then SIGKILL after ${ctx.graceMs ?? ABORT_GRACE_MS} ms. Send it again to kill them now.`);
      controller.abort(name);
    } else {
      killAllLiveChildren();
    }
  };
  const signals = paid ? ['SIGINT', 'SIGTERM', 'SIGHUP'] : [];
  for (const name of signals) process.on(name, onSignal);
  try {
    return await commands[command]();
  } finally {
    for (const name of signals) process.off(name, onSignal);
  }
}

// Dispatch only when run as a script, so tests can import the functions above.
if (process.argv[1] && path.resolve(process.argv[1]) === harnessPath) {
  await main(process.argv.slice(2));
}
