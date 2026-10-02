#!/usr/bin/env node
// A3 tuning run for the session brief (recall plan task A3; protocol in
// canonical memory at architecture/platform/project-memory/recall-evaluation.md).
// Development tool; not shipped in the npm package.
//
//   node scripts/evaluate-brief-tuning.js --corpus <dir> --labels <recall-evaluation.md> --out <dir> [--warm-runs 10] [--label-version v2|v1]
//
// --label-version (default v2) picks the grading key: v1 is the A3 key over
// recall-eval-corpus-v1; v2 applies the reviewer-confirmed revisions in
// recall-evaluation.md › Corpus v2 tuning-label re-verification (A7) for
// recall-eval-corpus-v2 (T3, C1, and C3 change; F2's changes add no doc or
// decision source).
//
// <corpus> is a read-only export of the frozen corpus with both evaluation
// files and sessions/active/ removed, for example:
//   git -C vibecompass-docs archive recall-eval-corpus-v1 | tar -x -C <dir> \
//     --exclude=architecture/platform/project-memory/recall-evaluation.md \
//     --exclude=architecture/platform/project-memory/recall-evaluation-heldout.md
//   rm -rf <dir>/sessions/active
// <labels> is recall-evaluation.md, read only for the 12 tuning tasks' text and
// files. The held-out file is never read.
//
// Per task the harness copies the corpus to <out>/runs/<id>, creates the
// protocol's evaluation lane (sessions/active/eval with session.yaml, wip.md,
// handoff.md, and an index.yaml listing only it), runs
//   node src/cli.js brief --root <copy> --task <task> [--files <file>...] --json
// in a fresh process (cold), then the engine in-process (warm p50), and writes
// <out>/briefs/<id>.md and <id>.json. Grading follows recall-evaluation.md ›
// Scoring › A3: a must-have item is covered when a supporting passage is an
// included unit (`coverage_included`) or an included unit or rendered
// follow-up read (`coverage_any`). SUPPORT below is the grading key: for each
// must-have item, the expected passages and acceptable alternatives from the
// labels that support it (A: architecture doc, D: decision).

import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectDeclaredSuccessors } from '../src/decision-lineage.js';
import { buildSessionBrief } from '../src/brief.js';
import { loadProjectReadModel } from '../src/read-model.js';

const SUPPORT = {
  F1: {
    M1: ['A:platform/billing/entitlements-and-usage-ledger.md', 'D:318'],
    M2: ['A:platform/billing/entitlements-and-usage-ledger.md', 'A:platform/billing/subscription-offer-and-ledger.md', 'D:318'],
    M3: ['D:318', 'A:platform/billing/entitlements-and-usage-ledger.md', 'A:platform/billing/subscription-offer-and-ledger.md', 'A:platform/billing/subscription-build-plan.md'],
    M4: ['A:platform/billing/entitlements-and-usage-ledger.md'],
  },
  F2: {
    M1: ['D:277', 'A:platform/project-memory/multi-session-lanes.md'],
    M2: ['D:277', 'D:353', 'D:280', 'A:platform/project-memory/multi-session-lanes.md'],
    M3: ['D:353', 'A:platform/project-memory/multi-session-lanes.md'],
    M4: ['D:277'],
  },
  F3: {
    M1: ['A:platform/project-memory/sync-credentials.md', 'D:355'],
    M2: ['A:platform/project-memory/sync-credentials.md', 'D:355'],
    M3: ['A:platform/project-memory/sync-credentials.md', 'D:355'],
    M4: ['A:platform/project-memory/sync-credentials.md'],
  },
  T1: {
    M1: ['D:318', 'D:138', 'D:294'],
    M2: ['D:318', 'A:platform/billing/subscription-offer-and-ledger.md', 'A:platform/billing/subscription-build-plan.md'],
    M3: ['D:318', 'A:platform/billing/subscription-offer-and-ledger.md', 'A:platform/billing/subscription-build-plan.md'],
    M4: ['D:318', 'A:platform/billing/subscription-offer-and-ledger.md'],
    M5: ['D:318', 'A:platform/billing/subscription-offer-and-ledger.md', 'A:platform/billing/entitlements-and-usage-ledger.md'],
  },
  T2: {
    M1: ['D:356', 'A:platform/project-memory/sync-credentials.md'],
    M2: ['D:356', 'A:platform/project-memory/sync-credentials.md'],
    M3: ['D:355', 'A:platform/project-memory/sync-credentials.md'],
    M4: ['A:platform/project-memory/sync-credentials.md', 'D:151'],
  },
  T3: {
    M1: ['D:238', 'A:platform/project-memory/hosted-schema.md'],
    M2: ['D:239', 'D:291', 'A:platform/project-memory/hosted-schema.md'],
    M3: ['D:240', 'A:platform/project-memory/hosted-schema.md'],
    M4: ['D:243', 'A:platform/project-memory/hosted-schema.md'],
    M5: ['A:platform/project-memory/hosted-schema.md', 'A:platform/project-memory/recall-and-plain-language-build-plan.md'],
  },
  C1: {
    M1: ['D:361', 'D:298', 'D:299', 'A:platform/billing/entitlements-and-usage-ledger.md', 'A:platform/project-memory/recall-and-plain-language-build-plan.md'],
    M2: ['D:361'],
    M3: ['D:361'],
    M4: ['D:360'],
    M5: ['D:357', 'D:360', 'D:361'],
    M6: ['A:platform/infrastructure/ci-cd.md'],
  },
  C2: {
    M1: ['D:074', 'D:070', 'D:001'],
    M2: ['D:318'],
    M3: ['D:318', 'A:platform/billing/subscription-offer-and-ledger.md'],
    M4: ['D:318', 'A:platform/billing/entitlements-and-usage-ledger.md', 'A:github-integration/repo-sync/initial-scan.md'],
  },
  C3: {
    M1: ['D:359'],
    M2: ['D:359', 'A:platform/project-memory/recall-and-plain-language-build-plan.md'],
    M3: ['A:platform/project-memory/recall-and-plain-language-build-plan.md', 'D:159'],
    M4: ['D:278', 'D:359'],
    M5: ['A:platform/project-memory/recall-and-plain-language-build-plan.md', 'A:mcp-server/context-delivery/read-tools.md'],
  },
};

// Expected passages only (not alternatives), per label.
const EXPECTED = {
  F1: ['A:platform/billing/entitlements-and-usage-ledger.md', 'A:platform/billing/subscription-offer-and-ledger.md', 'D:318'],
  F2: ['D:277', 'D:353', 'A:platform/project-memory/multi-session-lanes.md'],
  F3: ['A:platform/project-memory/sync-credentials.md', 'D:355'],
  T1: ['D:318', 'D:294', 'D:138', 'A:platform/billing/subscription-offer-and-ledger.md', 'A:platform/billing/subscription-build-plan.md'],
  T2: ['A:platform/project-memory/sync-credentials.md', 'D:356', 'D:355'],
  T3: ['A:platform/project-memory/hosted-schema.md', 'D:238', 'D:239', 'D:240', 'D:243', 'A:platform/project-memory/recall-and-plain-language-build-plan.md'],
  C1: ['D:361', 'D:360', 'D:357', 'D:298', 'D:299', 'A:platform/billing/entitlements-and-usage-ledger.md', 'A:platform/project-memory/recall-and-plain-language-build-plan.md', 'A:platform/infrastructure/ci-cd.md'],
  C2: ['D:074', 'D:070', 'D:001', 'D:318', 'D:294', 'A:platform/billing/subscription-offer-and-ledger.md', 'A:platform/billing/entitlements-and-usage-ledger.md', 'A:github-integration/repo-sync/initial-scan.md'],
  C3: ['D:359', 'D:159', 'D:278', 'A:platform/project-memory/recall-and-plain-language-build-plan.md'],
};

// Corpus v2 revisions (A7): per task, the items and expected passages that
// replace the v1 key above; tasks not listed keep their v1 entries.
const SUPPORT_V2 = {
  T3: {
    M1: ['D:238', 'A:platform/project-memory/hosted-schema.md'],
    M2: ['D:239', 'D:291', 'A:platform/project-memory/hosted-schema.md', 'A:platform/project-memory/hosted-docs-review.md'],
    M3: ['D:240', 'A:platform/project-memory/hosted-schema.md', 'A:platform/project-memory/hosted-docs-review.md'],
    M4: ['D:243', 'A:platform/project-memory/hosted-schema.md'],
    M5: ['A:platform/project-memory/hosted-schema.md', 'A:dashboard/project-management/frontend.md', 'A:platform/project-memory/recall-and-plain-language-build-plan.md'],
  },
  C1: {
    M1: ['D:361', 'D:298', 'D:299', 'D:366', 'A:platform/billing/entitlements-and-usage-ledger.md', 'A:platform/project-memory/plain-language-views.md', 'A:platform/project-memory/recall-and-plain-language-build-plan.md'],
    M2: ['D:361'],
    M3: ['D:361', 'D:366', 'A:platform/project-memory/plain-language-views.md', 'A:platform/billing/entitlements-and-usage-ledger.md'],
    M4: ['D:360', 'D:367', 'A:platform/project-memory/plain-language-views.md'],
    M5: ['D:357', 'D:360', 'D:361'],
    M6: ['A:platform/infrastructure/ci-cd.md'],
    M7: ['A:platform/project-memory/plain-language-views.md', 'A:platform/project-memory/recall-and-plain-language-build-plan.md'],
  },
  C3: {
    M1: ['D:359', 'A:platform/project-memory/session-brief.md'],
    M2: ['D:359', 'D:368', 'A:platform/project-memory/recall-and-plain-language-build-plan.md', 'A:platform/project-memory/session-brief.md'],
    M3: ['A:platform/project-memory/recall-and-plain-language-build-plan.md', 'D:159', 'A:platform/project-memory/session-brief.md'],
    M4: ['D:278', 'D:359', 'D:364', 'A:platform/project-memory/session-brief.md'],
    M5: ['A:platform/project-memory/recall-and-plain-language-build-plan.md', 'A:mcp-server/context-delivery/read-tools.md'],
  },
};
const EXPECTED_V2 = {
  T3: ['A:platform/project-memory/hosted-schema.md', 'D:238', 'D:239', 'D:240', 'D:243'],
  C1: ['D:361', 'D:366', 'D:360', 'D:357', 'D:298', 'D:299', 'A:platform/project-memory/plain-language-views.md', 'A:platform/billing/entitlements-and-usage-ledger.md', 'A:platform/project-memory/recall-and-plain-language-build-plan.md', 'A:platform/infrastructure/ci-cd.md'],
  C3: ['D:359', 'D:368', 'D:159', 'D:278', 'A:platform/project-memory/recall-and-plain-language-build-plan.md', 'A:platform/project-memory/session-brief.md'],
};

// Unlabeled paraphrases run after the 12 tasks and are reported separately
// (review passes 1 and 2). `match` cases name a topic memory covers, phrased
// with unfamiliar modifiers: each must not come back `no-match` AND must
// surface at least one of the builder-expected sources (A: doc, D: decision)
// as a unit or rendered follow-up read. These expectations are the builder's
// judgment, not evaluation labels. `report` cases are unlabeled probes.
const EXTRA_CASES = [
  ['R1a', 'match', 'Make hosted refresh allowance error messages clearer and friendlier.', ['A:platform/billing/entitlements-and-usage-ledger.md', 'A:platform/billing/subscription-offer-and-ledger.md', 'D:318']],
  ['R1b', 'match', 'Can you carefully investigate a sporadic failure in session lane selection?', ['D:277', 'D:353', 'A:platform/project-memory/multi-session-lanes.md']],
  ['P1', 'match', 'Tidy up the confusing wording in the docs-review output parser errors.', ['A:platform/project-memory/docs-review-output-contract.md']],
  ['P2', 'match', 'Why does the MCP read tool sometimes time out so slowly?', ['A:mcp-server/context-delivery/read-tools.md', 'A:mcp-server/context-delivery/resilience.md']],
  ['P3', 'match', 'Explain the Solo plan price to a skeptical customer in simple words.', ['D:318', 'A:platform/billing/subscription-offer-and-ledger.md', 'A:platform/billing/subscription-build-plan.md']],
  ['P4', 'match', 'Make the lane marker lookup noticeably faster and sturdier.', ['D:280', 'A:platform/project-memory/multi-session-lanes.md']],
  ['P5', 'match', 'Honestly the credential store feels flaky on Windows laptops.', ['D:355', 'A:platform/project-memory/sync-credentials.md']],
  ['X1', 'report', 'Add dark mode to the marketing homepage with a toggle.', []],
  ['X2', 'report', 'Send Slack notifications whenever a new decision is appended.', []],
  ['X3', 'report', 'Rewrite the vibecompass CLI in Rust for faster startup.', []],
  ['X4', 'report', 'Add SAML single sign-on for enterprise customers.', []],
];

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const corpus = option('--corpus');
const labelsPath = option('--labels');
const outDir = option('--out');
const warmRuns = Number(option('--warm-runs', '10'));
const labelVersion = option('--label-version', 'v2');
if (!['v1', 'v2'].includes(labelVersion)) {
  console.error('--label-version must be v1 or v2');
  process.exit(2);
}
const supportKey = labelVersion === 'v2' ? { ...SUPPORT, ...SUPPORT_V2 } : SUPPORT;
const expectedKey = labelVersion === 'v2' ? { ...EXPECTED, ...EXPECTED_V2 } : EXPECTED;
if (!corpus || !labelsPath || !outDir || /heldout/i.test(labelsPath)) {
  console.error('Usage: node scripts/evaluate-brief-tuning.js --corpus <dir> --labels <recall-evaluation.md> --out <dir> [--warm-runs 10]');
  process.exit(2);
}

const tasks = parseTuningTasks(await readFile(labelsPath, 'utf8'));
if (tasks.length !== 12) throw new Error(`Expected 12 tuning tasks, found ${tasks.length}.`);
await mkdir(path.join(outDir, 'briefs'), { recursive: true });
const relations = (await loadProjectReadModel(path.resolve(corpus))).decision_lineage.relations;

const rows = [];
for (const task of tasks) {
  const root = await makeRunCopy(task);
  const command = [
    'node',
    'src/cli.js',
    'brief',
    '--root',
    root,
    '--task',
    task.task,
    ...(task.files.length > 0 ? ['--files', ...task.files] : []),
    '--json',
  ];
  const started = process.hrtime.bigint();
  const child = spawnSync(command[0], command.slice(1), { cwd: packageDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const coldMs = Number(process.hrtime.bigint() - started) / 1e6;
  if (child.status !== 0) throw new Error(`${task.id}: brief failed: ${child.stderr}`);
  const result = JSON.parse(child.stdout);

  const warm = [];
  for (let run = 0; run < warmRuns + 1; run += 1) {
    const warmStart = process.hrtime.bigint();
    await buildSessionBrief({ rootDir: root, laneId: 'eval', task: task.task, files: task.files });
    if (run > 0) warm.push(Number(process.hrtime.bigint() - warmStart) / 1e6);
  }
  warm.sort((left, right) => left - right);

  await writeFile(path.join(outDir, 'briefs', `${task.id}.md`), result.markdown);
  await writeFile(path.join(outDir, 'briefs', `${task.id}.json`), `${JSON.stringify(result, null, 2)}\n`);
  rows.push({ task, result, coldMs, warmP50: warm[Math.floor(warm.length / 2)], ...grade(task.id, result) });
}

printReport(rows);
await writeFile(
  path.join(outDir, 'results.json'),
  `${JSON.stringify(
    {
      label_version: labelVersion,
      tasks: rows.map((row) => ({
        id: row.task.id,
        status: row.result.status,
        topic_absent: row.result.selection.topic_absent,
        coverage_any: row.coverageAny ?? null,
        coverage_included: row.coverageIncluded ?? null,
        items: row.items ?? null,
        no_match_correct: row.noMatchCorrect ?? null,
        expected: row.expected ?? null,
        estimated_tokens: row.result.budget.estimated_tokens,
        units: row.result.units.length,
        omitted: row.result.omitted.length,
        follow_ups: row.result.follow_ups.length,
        cold_ms: Math.round(row.coldMs),
        warm_p50_ms: Math.round(row.warmP50),
        safe_overflow: row.safe,
      })),
    },
    null,
    2,
  )}\n`,
);

console.log('');
console.log('Paraphrase probes (unlabeled; reported separately):');
for (const [id, expectation, taskText, expected] of EXTRA_CASES) {
  const root = await makeRunCopy({ id: `extra-${id}`, task: taskText, files: [] });
  const result = await buildSessionBrief({ rootDir: root, laneId: 'eval', task: taskText });
  const gap = result.gaps.find((entry) => entry.code === 'unmatched-terms');
  const found = expected.map((passage) => ({ passage, where: locate(result, passage) })).filter((entry) => entry.where !== 'missing');
  const verdict =
    expectation !== 'match'
      ? 'report'
      : result.status === 'no-match'
        ? 'FAIL (no-match)'
        : found.length === 0
          ? 'FAIL (expected source missing)'
          : `ok (${found.map((entry) => `${entry.passage.replace(/^A:.*\//, '').replace(/^D:/, 'D-')} ${entry.where}`).join(', ')})`;
  const firstUnits = result.units.filter((unit) => unit.kind !== 'lane').slice(0, 3).map((unit) => unit.path ?? unit.id).join(', ');
  console.log(`- ${id} [${expectation}] ${result.status}${result.selection.topic_absent ? ' (topic absent)' : ''} — ${verdict}; unmatched: ${gap ? gap.terms.join(', ') : 'none'}; first units: ${firstUnits || 'none'}`);
}

function parseTuningTasks(markdown) {
  const section = markdown.slice(markdown.indexOf('### Tuning tasks'), markdown.indexOf('## Results'));
  return [...section.matchAll(/^#### ([FTCN]\d) — [^\n]*· tuning\n([\s\S]*?)(?=^#### |(?![\s\S]))/gm)].map((match) => {
    const body = match[2];
    const taskText = body.match(/^- \*\*Task:\*\* (.+)$/m)?.[1]?.trim();
    const filesLine = body.match(/^- \*\*Files:\*\* (.+)$/m)?.[1] ?? '';
    return { id: match[1], task: taskText, files: [...filesLine.matchAll(/`([^`]+)`/g)].map((file) => file[1]) };
  });
}

async function makeRunCopy(task) {
  const root = path.resolve(outDir, 'runs', task.id);
  await rm(root, { recursive: true, force: true });
  await cp(path.resolve(corpus), root, { recursive: true });
  const laneDir = path.join(root, 'sessions', 'active', 'eval');
  await mkdir(laneDir, { recursive: true });
  const claimed = task.files.length > 0 ? `claimed_paths:\n${task.files.map((file) => `  - ${JSON.stringify(file)}`).join('\n')}` : 'claimed_paths: []';
  await writeFile(
    path.join(laneDir, 'session.yaml'),
    ['id: eval', 'status: active', `working_on: ${JSON.stringify(task.task)}`, 'feature_slugs: []', 'repos: []', claimed, 'architecture_docs: []', 'decision_domain_files: []', ''].join('\n'),
  );
  await writeFile(path.join(laneDir, 'wip.md'), `# WIP — eval\n\nSession lane: eval\n\n## Working on\n${task.task}\n\n## Log\n\n## Reviewer input needed\n\n## Review log\n`);
  await writeFile(
    path.join(laneDir, 'handoff.md'),
    '# Handoff — eval\n\nSession lane: eval\n\n## Builder → Reviewer\n\n### What changed\n\n### What needs review\n\n### What\'s next\n\n## Reviewer → Builder\n\n### Findings summary\n\n### Recommended next step\n',
  );
  await writeFile(path.join(root, 'sessions', 'active', 'index.yaml'), 'current: eval\nlanes:\n  - id: eval\n    status: active\n    working_on: "eval"\n');
  return root;
}

function locate(result, passage) {
  const [kind, value] = passage.split(':');
  const shown = result.follow_ups.slice(0, result.render?.follow_ups_shown ?? result.follow_up_cap);
  if (kind === 'A') {
    const docPath = `architecture/${value}`;
    if (result.units.some((unit) => unit.kind === 'doc' && unit.path === docPath)) return 'included';
    return shown.some((entry) => entry.path === docPath) ? 'follow-up' : 'missing';
  }
  const id = Number(value);
  if (result.units.some((unit) => unit.kind === 'lineage' && unit.members.some((member) => member.decision_id === id))) return 'included';
  const tag = `D-${String(id).padStart(3, '0')}`;
  return shown.some((entry) => entry.path.startsWith('decisions/') && (entry.heading ?? '').split(/,\s*/).includes(tag)) ? 'follow-up' : 'missing';
}

function grade(id, result) {
  const safe = safeOverflow(result);
  if (id.startsWith('N')) {
    return { noMatchCorrect: result.status === 'no-match' && result.units.every((unit) => unit.kind === 'lane'), safe };
  }
  const items = Object.entries(supportKey[id]).map(([item, passages]) => {
    const where = passages.map((passage) => locate(result, passage));
    return { item, any: where.some((entry) => entry !== 'missing'), included: where.includes('included') };
  });
  return {
    safe,
    coverageAny: items.filter((entry) => entry.any).length / items.length,
    coverageIncluded: items.filter((entry) => entry.included).length / items.length,
    items,
    expected: expectedKey[id].map((passage) => ({ passage, where: locate(result, passage) })),
  };
}

/** Status matches the packed contents, no predecessor lacks a successor, size within budget. */
function safeOverflow(result) {
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
  const emitted = new Set(result.units.filter((unit) => unit.kind === 'lineage').flatMap((unit) => unit.members.map((member) => member.decision_id)));
  for (const id of emitted) {
    for (const successor of collectDeclaredSuccessors(relations, id)) {
      if (!emitted.has(successor.decision_id)) problems.push(`D-${id} without successor D-${successor.decision_id}`);
    }
  }
  if (result.budget.estimated_tokens > result.budget.limit) problems.push('over budget');
  return problems;
}

function printReport(rows) {
  const positive = rows.filter((row) => !row.task.id.startsWith('N'));
  const noMatch = rows.filter((row) => row.task.id.startsWith('N'));
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  console.log('| Task | Status | coverage_any | coverage_included | Items (I included, F follow-up, - missing) | Est. tokens | Units / omitted / follow-ups | Cold CLI ms | Warm p50 ms | Safe overflow |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const row of rows) {
    const { result } = row;
    const items = row.items ? row.items.map((entry) => `${entry.item}:${entry.included ? 'I' : entry.any ? 'F' : '-'}`).join(' ') : row.noMatchCorrect ? 'no-match correct' : 'no-match MISSED';
    console.log(
      `| ${row.task.id} | ${result.status} | ${row.coverageAny?.toFixed(2) ?? '—'} | ${row.coverageIncluded?.toFixed(2) ?? '—'} | ${items} | ${result.budget.estimated_tokens} | ${result.units.length} / ${result.omitted.length} / ${result.follow_ups.length} | ${row.coldMs.toFixed(0)} | ${row.warmP50.toFixed(0)} | ${row.safe.length === 0 ? 'yes' : row.safe.join('; ')} |`,
    );
  }
  console.log('');
  console.log(`Macro coverage_any ${mean(positive.map((row) => row.coverageAny)).toFixed(3)}; macro coverage_included ${mean(positive.map((row) => row.coverageIncluded)).toFixed(3)} (positive tasks: ${positive.length})`);
  console.log(`No-match accuracy ${noMatch.filter((row) => row.noMatchCorrect).length}/${noMatch.length}`);
  const colds = rows.map((row) => row.coldMs).sort((left, right) => left - right);
  const warms = rows.map((row) => row.warmP50).sort((left, right) => left - right);
  console.log(`Cold CLI: first ${rows[0].coldMs.toFixed(0)} ms, max ${colds.at(-1).toFixed(0)} ms, median ${colds[Math.floor(colds.length / 2)].toFixed(0)} ms; warm in-process p50 across tasks: median ${warms[Math.floor(warms.length / 2)].toFixed(0)} ms, max ${warms.at(-1).toFixed(0)} ms`);
  console.log('');
  console.log('Expected-passage coverage:');
  for (const row of positive) {
    console.log(`- ${row.task.id}: ${row.expected.map((entry) => `${entry.passage.replace(/^A:/, '').replace(/^D:/, 'D-')} ${entry.where}`).join('; ')}`);
  }
}
