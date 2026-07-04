import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { initializeProjectMemory } from '../init.js';
import { runCli } from '../cli.js';
import { startProjectSession } from '../session.js';
import {
  checkGroupedDecisionIndex,
  collectCanonicalDecisions,
  looksLikeGroupedDecisionIndex,
  parseGroupedDecisionIndex,
  refreshGroupedDecisionIndex,
  resolveDefaultIndexGroupLabel,
} from '../decision-index.js';

const docsReviewFixtureDir = fileURLToPath(new URL('fixtures/docs-review-output/', import.meta.url));

const GROUPED_INDEX = [
  '# Decision Index',
  '',
  'All decisions in chronological order. Each entry links to its domain file',
  'where the full rationale, context, and alternatives are documented.',
  '',
  '> **Rule:** Decisions are append-only — never modify existing entries.',
  '',
  '---',
  '',
  '## 2026-07-01 — Session 1 (alpha lane)',
  '',
  '| # | Decision | Domain |',
  '|---|----------|--------|',
  '| D-001 | First decision | [cross-cutting](cross-cutting.md) |',
  '| D-002 | Second decision | [cross-cutting](cross-cutting.md) |',
  '',
  '## 2026-07-02 — Session 2 (beta lane)',
  '',
  '| # | Decision | Domain |',
  '|---|----------|--------|',
  '| D-003 | Third decision | [cross-cutting](cross-cutting.md) |',
  '| D-004 | Platform decision | [platform](platform.md) |',
  '',
].join('\n');

function decisionEntry(id, title) {
  return [
    `### D-${String(id).padStart(3, '0')} — ${title}`,
    `**Timestamp:** 2026-07-0${Math.min(id, 3)} 00:00 PDT`,
    `**Decision:** Decision text for ${title}.`,
    `**Rationale:** Rationale for ${title}.`,
    '',
  ].join('\n');
}

async function createIndexedRoot(prefix = 'vibecompass-decision-index-') {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const rootDir = path.join(tempDir, '.compass');
  await initializeProjectMemory({
    cwd: tempDir,
    rootDir,
    name: 'Decision Index Test',
    mode: 'local-only',
    repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
    bootstrap: { workflow: true, claude: true },
  });
  await mkdir(path.join(rootDir, 'decisions'), { recursive: true });
  await writeFile(
    path.join(rootDir, 'decisions/cross-cutting.md'),
    ['# Cross-cutting decisions', '', decisionEntry(1, 'First decision'), '---', '', decisionEntry(2, 'Second decision'), '---', '', decisionEntry(3, 'Third decision')].join('\n'),
    'utf8',
  );
  await writeFile(
    path.join(rootDir, 'decisions/platform.md'),
    ['# Platform decisions', '', decisionEntry(4, 'Platform decision')].join('\n'),
    'utf8',
  );
  await writeFile(path.join(rootDir, 'decisions/INDEX.md'), GROUPED_INDEX, 'utf8');
  return { tempDir, rootDir, indexPath: path.join(rootDir, 'decisions/INDEX.md') };
}

function createCaptureIo() {
  const stdout = [];
  const stderr = [];
  return {
    io: {
      stdout: { write(chunk) { stdout.push(chunk); } },
      stderr: { write(chunk) { stderr.push(chunk); } },
    },
    stdout,
    stderr,
  };
}

test('parseGroupedDecisionIndex round-trips the grouped shape (D-283)', () => {
  const parsed = parseGroupedDecisionIndex(GROUPED_INDEX);
  assert.equal(parsed.ok, true, parsed.problems.join('; '));
  assert.equal(parsed.groups.length, 2);
  assert.deepEqual(parsed.groups.map((group) => group.label), [
    '2026-07-01 — Session 1 (alpha lane)',
    '2026-07-02 — Session 2 (beta lane)',
  ]);
  assert.deepEqual(parsed.groups[1].rows.map((row) => row.id), [3, 4]);
  assert.equal(parsed.lines.join('\n'), GROUPED_INDEX, 'parse preserves every byte');
});

test('parseGroupedDecisionIndex fails closed on foreign structure', () => {
  const withProse = GROUPED_INDEX.replace('## 2026-07-02', 'A stray prose line.\n\n## 2026-07-02');
  const parsed = parseGroupedDecisionIndex(withProse);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.problems.some((problem) => problem.includes('stray prose line')));

  const flat = GROUPED_INDEX.split('\n').filter((line) => !line.startsWith('## ')).join('\n');
  assert.equal(parseGroupedDecisionIndex(flat).ok, false, 'flat-shaped content is not a grouped index');

  assert.equal(parseGroupedDecisionIndex('# Decision Index\r\n').ok, false, 'CRLF fails closed');
  assert.equal(looksLikeGroupedDecisionIndex(GROUPED_INDEX), true);
  assert.equal(looksLikeGroupedDecisionIndex(flat), false);
});

test('check passes on a clean root and names every divergence otherwise (D-283)', async () => {
  const { tempDir, rootDir, indexPath } = await createIndexedRoot();

  try {
    const clean = await checkGroupedDecisionIndex({ rootDir });
    assert.equal(clean.ok, true, clean.problems.join('; '));
    assert.deepEqual(clean.stats, { groupCount: 2, rowCount: 4, decisionCount: 4 });

    // Missing canonical decision in the index.
    await writeFile(
      path.join(rootDir, 'decisions/platform.md'),
      ['# Platform decisions', '', decisionEntry(4, 'Platform decision'), '---', '', decisionEntry(5, 'Unindexed decision')].join('\n'),
      'utf8',
    );
    const missing = await checkGroupedDecisionIndex({ rootDir });
    assert.equal(missing.ok, false);
    assert.ok(missing.problems.some((problem) => problem.includes('D-005') && problem.includes('missing from the index')));

    // Orphan row + title drift.
    const drifted = `${GROUPED_INDEX}\n## 2026-07-03 — Session 3 (gamma lane)\n\n| # | Decision | Domain |\n|---|----------|--------|\n| D-099 | Ghost decision | [platform](platform.md) |\n`;
    await writeFile(indexPath, drifted.replace('| D-002 | Second decision |', '| D-002 | Renamed decision |'), 'utf8');
    const diverged = await checkGroupedDecisionIndex({ rootDir });
    assert.equal(diverged.ok, false);
    assert.ok(diverged.problems.some((problem) => problem.includes('D-099') && problem.includes('no canonical decision entry')));
    assert.ok(diverged.problems.some((problem) => problem.includes('D-002') && problem.includes('does not match the canonical heading')));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('refresh is byte-idempotent when nothing is missing (D-283)', async () => {
  const { tempDir, rootDir, indexPath } = await createIndexedRoot();

  try {
    const result = await refreshGroupedDecisionIndex({ rootDir, groupLabel: 'ignored — nothing missing' });
    assert.equal(result.upToDate, true);
    assert.equal(result.refreshed, false);
    assert.equal(await readFile(indexPath, 'utf8'), GROUPED_INDEX, 'file untouched byte for byte');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('refresh appends a missing decision to an existing group verbatim (D-283)', async () => {
  const { tempDir, rootDir, indexPath } = await createIndexedRoot();

  try {
    await writeFile(
      path.join(rootDir, 'decisions/platform.md'),
      ['# Platform decisions', '', decisionEntry(4, 'Platform decision'), '---', '', decisionEntry(5, 'Uses | pipes in the title')].join('\n'),
      'utf8',
    );
    const result = await refreshGroupedDecisionIndex({ rootDir, groupLabel: '2026-07-02 — Session 2 (beta lane)' });
    assert.equal(result.refreshed, true);
    assert.deepEqual(result.added.map((decision) => decision.id), [5]);

    const expected = GROUPED_INDEX.replace(
      '| D-004 | Platform decision | [platform](platform.md) |',
      '| D-004 | Platform decision | [platform](platform.md) |\n| D-005 | Uses \\| pipes in the title | [platform](platform.md) |',
    );
    assert.equal(await readFile(indexPath, 'utf8'), expected, 'only the new row was inserted');

    const check = await checkGroupedDecisionIndex({ rootDir });
    assert.equal(check.ok, true, check.problems.join('; '));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('refresh creates a new trailing group and stays idempotent (D-283)', async () => {
  const { tempDir, rootDir, indexPath } = await createIndexedRoot();

  try {
    await writeFile(
      path.join(rootDir, 'decisions/platform.md'),
      ['# Platform decisions', '', decisionEntry(4, 'Platform decision'), '---', '', decisionEntry(5, 'Fifth decision'), '---', '', decisionEntry(6, 'Sixth decision')].join('\n'),
      'utf8',
    );
    const label = '2026-07-03 — Session 3 (gamma lane)';
    const first = await refreshGroupedDecisionIndex({ rootDir, groupLabel: label });
    assert.equal(first.refreshed, true);
    assert.deepEqual(first.added.map((decision) => decision.id), [5, 6]);

    const content = await readFile(indexPath, 'utf8');
    assert.ok(content.startsWith(GROUPED_INDEX.trimEnd()), 'existing content preserved verbatim');
    assert.ok(content.includes(`\n## ${label}\n\n| # | Decision | Domain |\n|---|----------|--------|\n| D-005 | Fifth decision | [platform](platform.md) |\n| D-006 | Sixth decision | [platform](platform.md) |\n`));
    assert.ok(content.endsWith('\n'), 'trailing newline preserved');

    const second = await refreshGroupedDecisionIndex({ rootDir, groupLabel: label });
    assert.equal(second.upToDate, true);
    assert.equal(await readFile(indexPath, 'utf8'), content, 'second refresh is byte-idempotent');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('refresh refuses foreign structure and mismatched rows without touching the file (D-283)', async () => {
  const { tempDir, rootDir, indexPath } = await createIndexedRoot();

  try {
    // Foreign structure.
    const withProse = GROUPED_INDEX.replace('## 2026-07-02', 'Editorial note kept by hand.\n\n## 2026-07-02');
    await writeFile(indexPath, withProse, 'utf8');
    const refusedStructure = await refreshGroupedDecisionIndex({ rootDir, groupLabel: 'any' });
    assert.equal(refusedStructure.refreshed, false);
    assert.ok(refusedStructure.problems.length > 0);
    assert.equal(await readFile(indexPath, 'utf8'), withProse, 'unparseable file untouched');

    // Row that no longer matches its canonical entry — never "repaired".
    await writeFile(indexPath, GROUPED_INDEX.replace('| D-002 | Second decision |', '| D-002 | Renamed decision |'), 'utf8');
    const refusedMismatch = await refreshGroupedDecisionIndex({ rootDir, groupLabel: 'any' });
    assert.equal(refusedMismatch.refreshed, false);
    assert.ok(refusedMismatch.problems.some((problem) => problem.includes('D-002')));

    // Missing rows with no label.
    await writeFile(indexPath, GROUPED_INDEX, 'utf8');
    await writeFile(
      path.join(rootDir, 'decisions/platform.md'),
      ['# Platform decisions', '', decisionEntry(4, 'Platform decision'), '---', '', decisionEntry(5, 'Fifth decision')].join('\n'),
      'utf8',
    );
    const noLabel = await refreshGroupedDecisionIndex({ rootDir, groupLabel: null });
    assert.equal(noLabel.refreshed, false);
    assert.ok(noLabel.problems.some((problem) => problem.includes('no group label')));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('hyphen-only decision headings are reported, never silently dropped (D-283)', async () => {
  const { tempDir, rootDir } = await createIndexedRoot();

  try {
    await writeFile(
      path.join(rootDir, 'decisions/platform.md'),
      ['# Platform decisions', '', decisionEntry(4, 'Platform decision'), '---', '', '### D-005 - Hyphen heading', '**Timestamp:** 2026-07-03 00:00 PDT', '**Decision:** x.', '**Rationale:** y.', ''].join('\n'),
      'utf8',
    );
    const canonical = await collectCanonicalDecisions(rootDir);
    assert.ok(canonical.problems.some((problem) => problem.includes('D-005') && problem.includes('cannot be indexed')));

    const refresh = await refreshGroupedDecisionIndex({ rootDir, groupLabel: 'unused' });
    assert.equal(refresh.upToDate, true, 'hyphen heading is not treated as missing');
    assert.ok(refresh.warnings.some((warning) => warning.includes('D-005')));

    const check = await checkGroupedDecisionIndex({ rootDir });
    assert.equal(check.ok, false, 'check fails while an unindexable heading exists');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('append-decision refreshes the grouped index with --group and via lane context (D-283)', async () => {
  const { tempDir, rootDir, indexPath } = await createIndexedRoot();

  try {
    const stagedPath = path.join(tempDir, 'staged-entry.md');
    await writeFile(
      stagedPath,
      ['### D-NEXT — Fifth decision', '**Timestamp:** 2026-07-03 00:00 PDT', '**Decision:** Fifth decision text.', '**Rationale:** Because.', ''].join('\n'),
      'utf8',
    );
    const { io, stdout } = createCaptureIo();
    const exitCode = await runCli(
      ['append-decision', '--root', rootDir, '--target', 'cross-cutting.md', '--entry', stagedPath, '--group', '2026-07-03 — Session 3 (gamma lane)'],
      io,
      { cwd: tempDir },
    );
    assert.equal(exitCode, 0);
    assert.match(stdout.join(''), /decisions\/INDEX\.md refreshed \(structure-preserving, D-283\): added D-005/);
    const content = await readFile(indexPath, 'utf8');
    assert.ok(content.includes('## 2026-07-03 — Session 3 (gamma lane)'));
    assert.ok(content.includes('| D-005 | Fifth decision | [cross-cutting](cross-cutting.md) |'));

    // Lane-context labeling: one active lane, no --group.
    const started = await startProjectSession({ cwd: tempDir, sessionId: 'gamma', workingOn: 'Gamma work' });
    await writeFile(
      stagedPath,
      ['### D-NEXT — Sixth decision', '**Timestamp:** 2026-07-03 00:10 PDT', '**Decision:** Sixth decision text.', '**Rationale:** Because.', ''].join('\n'),
      'utf8',
    );
    const { io: laneIo, stdout: laneStdout } = createCaptureIo();
    await runCli(['append-decision', '--root', rootDir, '--target', 'cross-cutting.md', '--entry', stagedPath], laneIo, { cwd: tempDir });
    assert.match(laneStdout.join(''), /refreshed \(structure-preserving, D-283\): added D-006/);
    const laneLabel = `## ${started.sessionDate} — Session ${started.sessionNumber} (gamma lane)`;
    assert.ok((await readFile(indexPath, 'utf8')).includes(laneLabel), `expected group "${laneLabel}"`);

    const resolved = await resolveDefaultIndexGroupLabel({ rootDir, cwd: tempDir });
    assert.equal(resolved.label, `${started.sessionDate} — Session ${started.sessionNumber} (gamma lane)`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('append-decision keeps the hand reminder when no group label is determinable (D-283)', async () => {
  const { tempDir, rootDir, indexPath } = await createIndexedRoot();

  try {
    const stagedPath = path.join(tempDir, 'staged-entry.md');
    await writeFile(
      stagedPath,
      ['### D-NEXT — Fifth decision', '**Timestamp:** 2026-07-03 00:00 PDT', '**Decision:** x.', '**Rationale:** y.', ''].join('\n'),
      'utf8',
    );
    const { io, stdout } = createCaptureIo();
    await runCli(['append-decision', '--root', rootDir, '--target', 'cross-cutting.md', '--entry', stagedPath], io, { cwd: tempDir });
    assert.match(stdout.join(''), /add the grouped index row for this entry by hand/);
    assert.equal(await readFile(indexPath, 'utf8'), GROUPED_INDEX, 'index untouched without a label');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('the flat --refresh-index generator refuses a grouped index (D-283/D-255 quarantine)', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-flat-refusal-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    await initializeProjectMemory({
      rootDir,
      name: 'Flat Refusal Test',
      mode: 'local-only',
      repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
    });
    await mkdir(path.join(rootDir, 'decisions'), { recursive: true });
    await writeFile(
      path.join(rootDir, 'decisions/cross-cutting.md'),
      ['# Cross-cutting decisions', '', decisionEntry(124, 'Existing local decision')].join('\n'),
      'utf8',
    );
    const groupedIndex = [
      '# Decision Index',
      '',
      'All decisions in chronological order.',
      '',
      '> **Rule:** Decisions are append-only — never modify existing entries.',
      '',
      '---',
      '',
      '## 2026-07-01 — Session 1 (alpha lane)',
      '',
      '| # | Decision | Domain |',
      '|---|----------|--------|',
      '| D-124 | Existing local decision | [cross-cutting](cross-cutting.md) |',
      '',
    ].join('\n');
    await writeFile(path.join(rootDir, 'decisions/INDEX.md'), groupedIndex, 'utf8');
    await mkdir(path.join(rootDir, 'state'), { recursive: true });
    await writeFile(
      path.join(rootDir, 'state/docs-review.json'),
      `${JSON.stringify({ status: 'local-review-generated', llm: 'codex', model: 'gpt-5' }, null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      path.join(rootDir, 'state/docs-review-output.md'),
      [
        await readFile(path.join(docsReviewFixtureDir, 'coverage-plan-valid.md'), 'utf8'),
        await readFile(path.join(docsReviewFixtureDir, 'decision-recommendation-valid.md'), 'utf8'),
      ].join('\n'),
      'utf8',
    );

    const { io, stderr } = createCaptureIo();
    await runCli(['docs-review', '--root', rootDir, '--apply-output', '--refresh-index'], io, { cwd: tempDir, env: {} });

    assert.equal(await readFile(path.join(rootDir, 'decisions/INDEX.md'), 'utf8'), groupedIndex, 'grouped index untouched by the flat generator');
    assert.match(await readFile(path.join(rootDir, 'decisions/cross-cutting.md'), 'utf8'), /### D-125 —/, 'the decision append itself still happened');
    assert.match(stderr.join(''), /refuses to overwrite it/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
