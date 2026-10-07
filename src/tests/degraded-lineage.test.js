import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectLaneBrief, laneBriefPath } from '../brief-lifecycle.js';
import {
  buildDecisionLineageModel,
  extractArchitectureDocCitations,
  extractDecisionFileRelations,
  extractSessionNoteRelations,
  parseDecisionEntries,
  setLineagePhasesForTesting,
} from '../decision-lineage.js';
import { parseFrontmatter } from '../frontmatter.js';
import {
  buildSessionBrief,
  continueProjectSession,
  getDecisionLineage,
  getProjectContext,
  loadProjectReadModel,
  renderBrief,
  startProjectSession,
} from '../index.js';

// Degraded lineage (D-371). These tests replace extraction phases through the
// internal seam, so they live in their own file (their own process) and run
// one at a time; every replacement is restored in `finally`.

const FIXTURE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'brief', 'root');
const TASK = 'Change the Free plan credit balance and the Solo plan price.';
const FAILING_DECISIONS = 'decisions/platform.md';
const FAILING_DOC = 'architecture/billing/ledger.md';

async function makeWorkspace(t, { brief = true } = {}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-degraded-lineage-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const rootDir = path.join(workspace, '.compass');
  await cp(FIXTURE_ROOT, rootDir, { recursive: true });
  await writeFile(path.join(workspace, 'CLAUDE.md'), '# Acme Widgets\n');
  const projectYaml = await readFile(path.join(rootDir, 'project.yaml'), 'utf8');
  const runtime = `runtime:\n  tmp_base: ${JSON.stringify(path.join(workspace, 'lane-tmp'))}\n`;
  await writeFile(path.join(rootDir, 'project.yaml'), `${projectYaml}${runtime}${brief ? 'brief:\n  enabled: true\n' : ''}`);
  return { workspace, rootDir };
}

async function withPhases(overrides, run) {
  const restore = setLineagePhasesForTesting(overrides);
  try {
    return await run();
  } finally {
    restore();
  }
}

// Entry parse of one decision file throws (the parse receives content only).
const failingEntryParse = {
  parseEntries(content) {
    if (content.includes('### D-104 ')) throw new Error('injected entry-parse fault');
    return parseDecisionEntries(content);
  },
};

// The package's own dispatch, through the exported extractors.
function defaultRelations({ path: sourcePath, kind, content }) {
  if (kind === 'architecture') return extractArchitectureDocCitations({ path: sourcePath, content });
  if (kind === 'session') return extractSessionNoteRelations({ path: sourcePath, content });
  return extractDecisionFileRelations({ path: sourcePath, content });
}

// Relation extraction of one architecture doc throws.
function failingRelations(error) {
  return {
    extractRelations(document) {
      if (document.path === FAILING_DOC) throw error;
      return defaultRelations(document);
    },
  };
}

test('an available model carries status available and no unavailable sources (D-371)', () => {
  const model = buildDecisionLineageModel([
    { kind: 'decision', path: 'decisions/a.md', content: '### D-100 — A\n**Timestamp:** 2026-01-01 10:00 UTC\n**Decision:** Text.\n' },
    { kind: 'architecture', path: 'architecture/a.md', content: '## Description\nCites D-100.\n' },
  ]);
  assert.equal(model.status, 'available');
  assert.deepEqual(model.unavailable_sources, []);
  assert.equal(model.decision_count, 1);
  assert.equal(model.relation_counts.cites, 1);
  assert.ok(Array.isArray(model.relations));
});

test('a real parser exception from one source makes lineage unavailable, never empty (D-371)', () => {
  // No seam: the real entry parser throws on content that is not text.
  const model = buildDecisionLineageModel([
    { kind: 'decision', path: 'decisions/broken.md', content: null },
    { kind: 'architecture', path: 'architecture/a.md', content: '## Description\nCites D-100.\n' },
  ]);
  assert.equal(model.status, 'unavailable');
  assert.equal(model.relations, null);
  assert.equal(model.relation_counts, null);
  assert.equal(model.decision_count, null);
  assert.equal(model.unavailable_sources.length, 1);
  assert.equal(model.unavailable_sources[0].path, 'decisions/broken.md');
  assert.equal(model.unavailable_sources[0].kind, 'decision');
  assert.match(model.unavailable_sources[0].error, /^TypeError: /);
  assert.deepEqual(
    model.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.path, diagnostic.line]),
    [['lineage-extraction-failed', 'decisions/broken.md', null]],
  );
});

test('extraction errors are bounded to 200 code points, first line only, with no stack (D-371 R4)', () => {
  const describe = (thrown) => {
    const restore = setLineagePhasesForTesting({
      extractRelations() {
        throw thrown;
      },
    });
    try {
      return buildDecisionLineageModel([{ kind: 'architecture', path: 'architecture/a.md', content: '## Description\nText.\n' }])
        .unavailable_sources[0].error;
    } finally {
      restore();
    }
  };

  const long = describe(new TypeError(`${'é'.repeat(1000)}`));
  assert.equal(Array.from(long).length, 200);
  assert.ok(long.startsWith('TypeError: éé'));
  assert.ok(long.endsWith('…'));

  const multiline = new Error('first line\nsecond line');
  assert.equal(describe(multiline), 'Error: first line');
  assert.ok(!describe(multiline).includes(' at '));

  assert.equal(describe('plain string\nsecond'), 'thrown string: plain string');
  assert.equal(describe(undefined), 'thrown undefined');
  assert.equal(describe(null), 'thrown null');
  assert.equal(describe(42), 'thrown number');
  assert.equal(
    describe({
      toString() {
        throw new Error('hostile');
      },
    }),
    'thrown object',
  );
  const hostile = new Error('x');
  Object.defineProperty(hostile, 'name', {
    get() {
      throw new Error('hostile name');
    },
  });
  assert.equal(describe(hostile), 'unreadable thrown value');
});

test('an entry-parse failure leaves the read model, decision dates, and other passes intact; lineage is unavailable (D-371)', async (t) => {
  const { rootDir } = await makeWorkspace(t);
  const baseline = await loadProjectReadModel(rootDir);
  assert.equal(baseline.decision_lineage.status, 'available');

  const degraded = await withPhases(failingEntryParse, () => loadProjectReadModel(rootDir));
  const lineage = degraded.decision_lineage;
  assert.equal(lineage.status, 'unavailable');
  assert.equal(lineage.relations, null);
  assert.equal(lineage.relation_counts, null);
  assert.equal(lineage.decision_count, null);
  assert.deepEqual(lineage.unavailable_sources, [{ path: FAILING_DECISIONS, kind: 'decision', error: 'Error: injected entry-parse fault' }]);
  assert.deepEqual(lineage.diagnostics.map((diagnostic) => diagnostic.code), ['lineage-extraction-failed']);

  // The decision list (titles and authored timestamps) comes from its own pass.
  assert.deepEqual(degraded.decisions, baseline.decisions);
  assert.ok(degraded.decisions.every((decision) => typeof decision.timestamp === 'string' && decision.timestamp.length > 0));
  assert.deepEqual(degraded.features, baseline.features);
  assert.deepEqual(degraded.sessions, baseline.sessions);
  assert.deepEqual([...degraded.file_owners], [...baseline.file_owners]);

  assert.deepEqual(getProjectContext(degraded).decision_lineage, {
    status: 'unavailable',
    unavailable_sources: lineage.unavailable_sources,
  });
  assert.deepEqual(getProjectContext(baseline).decision_lineage, { status: 'available', unavailable_sources: [] });

  const decision = getDecisionLineage(degraded, 'D-100');
  assert.equal(decision.exists, true);
  assert.equal(decision.lineage_status, 'unavailable');
  for (const field of ['outgoing', 'incoming', 'declared_successors', 'made_in', 'cited_by', 'cited_by_total']) {
    assert.equal(decision[field], null, field);
  }
  assert.equal(getDecisionLineage(baseline, 'D-100').lineage_status, 'available');
});

test('a relation-extraction failure of a doc makes lineage unavailable as a whole, and lineage recovers once extraction succeeds (D-371)', async (t) => {
  const { rootDir } = await makeWorkspace(t);
  const before = await loadProjectReadModel(rootDir);

  const degraded = await withPhases(failingRelations(new RangeError('injected relation fault')), () => loadProjectReadModel(rootDir));
  assert.equal(degraded.decision_lineage.status, 'unavailable');
  assert.deepEqual(degraded.decision_lineage.unavailable_sources, [
    { path: FAILING_DOC, kind: 'architecture', error: 'RangeError: injected relation fault' },
  ]);
  assert.equal(degraded.decision_lineage.relations, null);

  // Success → unavailable → success in one process: nothing is persisted.
  const after = await loadProjectReadModel(rootDir);
  assert.equal(after.decision_lineage.status, 'available');
  assert.deepEqual(after.decision_lineage, before.decision_lineage);
});

test('the lineage guard never swallows a scan failure (D-371 item 1)', async (t) => {
  const { rootDir } = await makeWorkspace(t);
  await writeFile(
    path.join(rootDir, 'decisions', 'duplicate.md'),
    '# Duplicate\n\n### D-104 — A second D-104\n**Timestamp:** 2026-01-09 10:00 UTC\n**Decision:** Duplicate.\n',
  );
  await withPhases(failingEntryParse, () =>
    assert.rejects(loadProjectReadModel(rootDir), /Cannot build read model with canonical parse errors/),
  );
});

test('with lineage unavailable the brief abstains: incomplete, no units, the failed source as the first required read (D-371)', async (t) => {
  const { rootDir } = await makeWorkspace(t);
  const healthy = await buildSessionBrief({ rootDir, task: TASK });
  assert.notEqual(healthy.status, 'incomplete');
  assert.ok(healthy.units.length > 0);

  const result = await withPhases(failingEntryParse, () => buildSessionBrief({ rootDir, task: TASK }));
  assert.equal(result.status, 'incomplete');
  assert.match(result.retrieval_error, /decision lineage is unavailable \(D-371\)/);
  assert.match(result.retrieval_error, /decisions\/platform\.md/);
  assert.deepEqual(result.units, []);
  assert.deepEqual(
    result.follow_ups.slice(0, 3).map((entry) => [entry.priority, entry.path]),
    [
      ['required', FAILING_DECISIONS],
      ['required', 'architecture/overview/project-shape.md'],
      ['required', 'decisions/INDEX.md'],
    ],
  );
  assert.ok(result.budget.estimated_tokens <= result.budget.limit);
  assert.match(renderBrief(result), /INCOMPLETE/);
});

test('a lane brief written while lineage is unavailable records a failed generation, stays stale, and is regenerated on resume (D-371)', async (t) => {
  const { workspace, rootDir } = await makeWorkspace(t);
  const started = await withPhases(failingEntryParse, () =>
    startProjectSession({ cwd: workspace, rootDir, sessionId: 'ledger', workingOn: TASK, claims: [], repos: [], date: '2026-02-01' }),
  );
  assert.equal(started.brief.state, 'failed');
  assert.equal(started.brief.status, 'incomplete');
  // Agent instruction files still sync: the read model no longer fails, so
  // the sync is not skipped (its other per-file results are unchanged).
  assert.ok(
    started.agentFileSync.results.every((entry) => !/sync skipped/.test(entry.warning ?? '')),
    JSON.stringify(started.agentFileSync.results),
  );
  assert.ok(started.agentFileSync.results.some((entry) => entry.format === 'agents_md' && entry.changed));

  const { data, body } = parseFrontmatter(await readFile(laneBriefPath(rootDir, 'ledger'), 'utf8'));
  assert.equal(data.generation, 'failed');
  assert.equal(data.status, 'incomplete');
  assert.match(String(data.reason), /decision lineage is unavailable/);
  assert.match(body, /INCOMPLETE/);
  assert.match(body, /decisions\/platform\.md/);

  const check = await inspectLaneBrief({ rootDir, laneId: 'ledger' });
  assert.equal(check.stale, true);

  // Lineage is readable again: resume regenerates the brief.
  const resumed = await continueProjectSession({ cwd: workspace, rootDir, sessionId: 'ledger' });
  assert.equal(resumed.brief.state, 'regenerated');
  assert.notEqual(resumed.brief.status, 'incomplete');
  assert.equal(parseFrontmatter(await readFile(laneBriefPath(rootDir, 'ledger'), 'utf8')).data.generation, 'ok');
  assert.equal((await inspectLaneBrief({ rootDir, laneId: 'ledger' })).stale, false);
});
