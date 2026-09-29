import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DECISION_LINEAGE_CONTRACT_VERSION,
  buildDecisionLineageModel,
  collectDeclaredSuccessors,
  extractArchitectureDocCitations,
  extractDecisionFileRelations,
  extractSessionNoteRelations,
  getDecisionLineage,
  getDecisionLog,
  getFeatureContext,
  loadProjectReadModel,
  scanDecisionReferences,
} from '../index.js';
import { initializeProjectMemory } from '../init.js';

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/decision-lineage');
const UPDATE_FIXTURES = process.env.VIBECOMPASS_UPDATE_LINEAGE_FIXTURES === '1';

// Fixture kind and logical source path follow the file-name prefix, so the
// app mirror (plan task B3) can run the same inputs without extra metadata.
function fixtureInput(name) {
  const stem = name.replace(/\.md$/, '');
  if (stem.startsWith('decisions-')) return { kind: 'decision', path: `decisions/${stem.slice('decisions-'.length)}.md` };
  if (stem.startsWith('note-')) return { kind: 'session', path: `sessions/${stem.slice('note-'.length)}.md` };
  if (stem.startsWith('doc-')) return { kind: 'architecture', path: `architecture/fixtures/${stem.slice('doc-'.length)}.md` };
  throw new Error(`Unrecognized decision-lineage fixture prefix: ${name}`);
}

function runExtractor(input, content) {
  if (input.kind === 'decision') return extractDecisionFileRelations({ path: input.path, content });
  if (input.kind === 'session') return extractSessionNoteRelations({ path: input.path, content });
  return extractArchitectureDocCitations({ path: input.path, content });
}

function decisionFile(entries) {
  return ['# Decision Log', '', ...entries.flatMap((entry) => [entry.trim(), '', '---', ''])].join('\n');
}

function entry(id, body, title = `Fixture decision ${id}`) {
  return [`### D-${String(id).padStart(3, '0')} — ${title}`, '**Timestamp:** 2026-01-01 10:00 UTC', body].join('\n');
}

function lineageOf(content, sourceId) {
  return extractDecisionFileRelations({ path: 'decisions/fixture.md', content }).relations.filter(
    (relation) => relation.source_decision_id === sourceId,
  );
}

function pick(relations, targetId, relation) {
  return relations.filter((candidate) => candidate.target_decision_id === targetId && (!relation || candidate.relation === relation));
}

test('decision-lineage golden fixtures match their expected outputs', async () => {
  const names = (await readdir(FIXTURE_DIR)).filter((name) => name.endsWith('.md')).sort();
  assert.ok(names.length >= 5, 'expected the decision-lineage fixture set');

  for (const name of names) {
    const input = fixtureInput(name);
    const content = await readFile(path.join(FIXTURE_DIR, name), 'utf8');
    const actual = { contract_version: DECISION_LINEAGE_CONTRACT_VERSION, input, ...runExtractor(input, content) };
    const expectedPath = path.join(FIXTURE_DIR, name.replace(/\.md$/, '.expected.json'));

    if (UPDATE_FIXTURES) {
      await writeFile(expectedPath, `${JSON.stringify(actual, null, 2)}\n`, 'utf8');
      continue;
    }

    const expected = JSON.parse(await readFile(expectedPath, 'utf8'));
    assert.deepEqual(actual, expected, `${name} drifted from ${path.basename(expectedPath)}`);
  }
});

test('scanDecisionReferences keeps canonical IDs, expands bounded ranges, and rejects malformed tokens', () => {
  const { refs, malformed } = scanDecisionReferences(
    'D-070, D-307/D-308, D-314–D-317, D-124 through D-126, D-200-D-201, D-001–D-200, D-12, D-0070, D-298-founder-ack, XD-100, D-100a',
  );
  const ids = refs.map((ref) => `${ref.id}:${ref.evidence}`);

  assert.deepEqual(ids, [
    '70:explicit',
    '307:explicit',
    '308:explicit',
    '314:explicit',
    '315:inferred',
    '316:inferred',
    '317:explicit',
    '124:explicit',
    '125:inferred',
    '126:explicit',
    '200:explicit',
    '201:explicit',
    // D-001–D-200 spans more than 50 IDs: two plain mentions, no expansion.
    '1:explicit',
    '200:explicit',
  ]);
  assert.deepEqual(malformed.map((token) => token.token), ['D-12', 'D-0070']);
});

test('full, unqualified, partial, and scoped supersession are typed from declared wording', () => {
  const content = decisionFile([
    entry(10, '**Decision:** Base.'),
    entry(11, '**Decision:** Base.'),
    entry(12, '**Decision:** Base.'),
    entry(13, '**Decision:** Base.'),
    entry(
      20,
      [
        '**Decision:** Supersedes D-010 in full. Supersedes D-011.',
        "**Impact on prior decisions:** Partially supersedes D-012's paid-only framing. Supersedes the manual-maintenance portion of D-013.",
      ].join('\n'),
    ),
  ]);
  const relations = lineageOf(content, 20);

  assert.equal(pick(relations, 10, 'supersedes')[0].extent, 'full');
  assert.equal(pick(relations, 11, 'supersedes')[0].extent, 'unqualified');
  assert.deepEqual(
    [pick(relations, 12, 'supersedes')[0].extent, pick(relations, 12, 'supersedes')[0].scope],
    ['partial', 'paid-only framing'],
  );
  assert.deepEqual(
    [pick(relations, 13, 'supersedes')[0].extent, pick(relations, 13, 'supersedes')[0].scope],
    ['scoped', 'manual-maintenance portion'],
  );
  for (const relation of relations) {
    assert.equal(relation.evidence, 'explicit');
    assert.equal(relation.basis, 'prose');
    assert.match(relation.source_hash, /^sha256:[0-9a-f]{64}$/);
    assert.match(relation.section_hash, /^sha256:[0-9a-f]{64}$/);
  }
});

test('passive supersession reads its subject; explicit extent wording beats historical retention', () => {
  const content = decisionFile([
    ...[1, 2, 3, 4].map((id) => entry(id, '**Decision:** Base.')),
    entry(
      70,
      [
        '**Decision:** D-001 ("one project = one GitHub repo") is superseded for implementation but kept for historical reference. D-002 is superseded for hosted onboarding structure.',
        '**Impact on prior decisions:** D-003 is superseded but kept for historical reference. D-004 is partially superseded for billing but kept for historical reference.',
      ].join('\n'),
    ),
  ]);
  const relations = lineageOf(content, 70);
  const extentOf = (id) => {
    const [relation] = pick(relations, id, 'supersedes');
    return [relation.extent, relation.scope];
  };

  assert.deepEqual(extentOf(1), ['scoped', 'for implementation']);
  assert.deepEqual(extentOf(2), ['scoped', 'for hosted onboarding structure']);
  assert.deepEqual(extentOf(3), ['full', null]);
  assert.deepEqual(extentOf(4), ['partial', 'for billing']);
});

test('amends, preserves, and negated change are declared relations; other lineage verbs are unknown', () => {
  const content = decisionFile([
    ...[30, 31, 32, 33, 34, 35, 36, 37].map((id) => entry(id, '**Decision:** Base.')),
    entry(
      40,
      [
        "**Decision:** Amends D-030's priority wording only. D-031 is narrowly amended to allow a back step.",
        '**Impact on prior decisions:** Preserves D-032 (append-only entries), D-033, and D-034. Everything else in D-030 stands. Leaves D-035 authority untouched. Does not supersede D-036. Refines D-037 by replacing its cadence.',
      ].join('\n'),
    ),
  ]);
  const relations = lineageOf(content, 40);

  assert.equal(pick(relations, 30, 'amends')[0].scope, 'priority wording only');
  assert.equal(pick(relations, 31, 'amends').length, 1);
  assert.deepEqual(
    [32, 33, 34].map((id) => pick(relations, id, 'preserves')[0].extent),
    ['unqualified', 'unqualified', 'unqualified'],
  );
  assert.equal(pick(relations, 30, 'preserves')[0].scope, 'Everything else');
  assert.equal(pick(relations, 35, 'preserves')[0].scope, 'authority');
  assert.equal(pick(relations, 36, 'preserves')[0].cue, 'does not supersede');
  assert.equal(pick(relations, 36, 'supersedes').length, 0, 'negation must never yield supersedes');
  assert.deepEqual(
    pick(relations, 37).map((relation) => [relation.relation, relation.cue]),
    [['unknown', 'refines']],
  );
});

test('quoted prose, code spans, blockquotes, and modal wording never declare lineage', () => {
  const content = decisionFile([
    ...[50, 51, 52, 53].map((id) => entry(id, '**Decision:** Base.')),
    entry(
      60,
      [
        '**Decision:** The old README said "Supersedes D-050 in full", which was wrong; `supersedes D-051` is a code sample.',
        '**Rationale:** A later decision may supersede D-053 once teams ship.',
        '',
        '> Supersedes D-052 — a quoted proposal.',
      ].join('\n'),
    ),
  ]);
  const relations = lineageOf(content, 60);

  for (const id of [50, 51, 52]) {
    assert.deepEqual(pick(relations, id).map((relation) => relation.relation), ['references'], `D-0${id}`);
  }
  assert.deepEqual(
    pick(relations, 53).map((relation) => [relation.relation, relation.cue]),
    [['unknown', 'modal:supersede']],
  );
});

test('restated lineage from a third decision is not a declaration by the citing entry', () => {
  const content = decisionFile([
    entry(138, '**Decision:** Local is free; hosting is paid.'),
    entry(294, '**Impact on prior decisions:** Partially supersedes D-138\'s paid-only framing.'),
    entry(318, '**Decision:** Launch billing.'),
    entry(358, '**Impact on prior decisions:** Preserves the local-free posture of D-138 as partially superseded by D-294, and D-318.'),
  ]);
  const relations = lineageOf(content, 358);

  assert.equal(pick(relations, 138, 'preserves')[0].scope, 'local-free posture');
  assert.equal(pick(relations, 318, 'preserves').length, 1);
  assert.deepEqual(pick(relations, 294).map((relation) => relation.relation), ['references']);
  assert.equal(pick(relations, 138, 'supersedes').length, 0);
});

test('forward, self, and malformed references never become lineage', () => {
  const content = decisionFile([
    entry(70, '**Decision:** Supersedes D-071\'s draft. D-070 supersedes nothing. D-7 and D-0069 are typos.'),
    entry(71, '**Decision:** Later draft.'),
  ]);
  const { relations, diagnostics } = extractDecisionFileRelations({ path: 'decisions/fixture.md', content });
  const own = relations.filter((relation) => relation.source_decision_id === 70);

  assert.deepEqual(own.map((relation) => [relation.target_decision_id, relation.relation]), [[71, 'unknown']]);
  assert.equal(own[0].cue, 'forward-reference:supersedes');
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.code).sort(),
    ['lineage-forward-reference', 'malformed-decision-reference', 'malformed-decision-reference'],
  );
});

test('an entry without an Impact section still parses its Decision and Rationale fields', () => {
  const content = decisionFile([entry(26, '**Decision:** Base.'), entry(30, '**Decision:** Schema split.\n**Rationale:** Supersedes D-026.')]);
  const relations = lineageOf(content, 30);

  assert.deepEqual(relations.map((relation) => [relation.target_decision_id, relation.relation, relation.source_field]), [
    [26, 'supersedes', 'Rationale'],
  ]);
  assert.deepEqual(extractDecisionFileRelations({ path: 'decisions/empty.md', content: '# Decision Log\n\nNo entries yet.\n' }), {
    relations: [],
    diagnostics: [],
  });
});

test('structured lineage fields (D-363) are authoritative for the targets they name', () => {
  const content = decisionFile([
    ...[20, 21, 22].map((id) => entry(id, '**Decision:** Base.')),
    entry(
      30,
      [
        '**Decision:** Replace A.',
        '**Supersedes:** D-020',
        '**Amends:** D-021 — reporting cadence; part of D-022',
        '**Impact on prior decisions:** Preserves D-020. Supersedes D-022.',
      ].join('\n'),
    ),
  ]);
  const { relations, diagnostics } = extractDecisionFileRelations({ path: 'decisions/fixture.md', content });
  const own = relations.filter((relation) => relation.source_decision_id === 30);

  assert.deepEqual(pick(own, 20).map((relation) => [relation.relation, relation.extent, relation.basis]), [
    ['supersedes', 'full', 'structured-field'],
  ]);
  assert.deepEqual(pick(own, 21).map((relation) => [relation.relation, relation.extent, relation.scope]), [
    ['amends', 'scoped', 'reporting cadence'],
  ]);
  // The invalid structured item is ignored, so prose still speaks for D-022.
  assert.deepEqual(pick(own, 22).map((relation) => [relation.relation, relation.basis]), [['supersedes', 'prose']]);
  assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.code).sort(), [
    'lineage-field-invalid',
    'lineage-structured-prose-conflict',
  ]);
});

test('unsafe or zero decision IDs are malformed and ranges terminate (review R1)', () => {
  // Run in a child process: a regression here is an infinite loop that would
  // otherwise hang the test runner.
  const probe = [
    `const m = await import(${JSON.stringify(new URL('../decision-lineage.js', import.meta.url).href)});`,
    "const r = m.scanDecisionReferences('D-9007199254740992–D-9007199254740994, D-000, D-9007199254740991, D-999–D-1001');",
    'console.log(JSON.stringify({ ids: r.refs.map((ref) => ref.id), malformed: r.malformed.map((token) => token.token) }));',
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', timeout: 10000 });

  assert.equal(result.error, undefined, 'probe must terminate');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ids: [9007199254740991, 999, 1000, 1001],
    malformed: ['D-9007199254740992', 'D-9007199254740994', 'D-000'],
  });
});

test('fenced examples never declare lineage, fields, entries, or made listings (review R2)', () => {
  const content = decisionFile([
    entry(10, '**Decision:** Base.'),
    entry(11, '**Decision:** Base.'),
    entry(
      30,
      [
        '**Decision:** Illustration only:',
        '',
        '```md',
        'Supersedes D-010.',
        '**Supersedes:** D-010',
        '**Rationale:** Example only.',
        '### D-099 — Fenced heading',
        '```',
        '',
        '~~~',
        'Amends D-011.',
        '~~~',
        '**Rationale:** Real rationale.',
      ].join('\n'),
    ),
  ]);
  const { relations, diagnostics } = extractDecisionFileRelations({ path: 'decisions/fixture.md', content });

  assert.deepEqual(
    relations.filter((relation) => relation.source_decision_id === 30).map((relation) => [relation.target_decision_id, relation.relation]),
    [
      [10, 'references'],
      [99, 'references'],
      [11, 'references'],
    ],
  );
  assert.deepEqual(diagnostics, []);

  const note = [
    '# Session — 2026-06-12-1 — Fenced',
    '',
    '## Decisions made',
    '- D-030 — Real.',
    '',
    '```md',
    '- D-031 — Example only.',
    '```',
    '',
    '~~~',
    '- D-032 — Example only.',
    '~~~',
  ].join('\n');
  const made = extractSessionNoteRelations({ path: 'sessions/2026-06-12-1-fenced.md', content: note }).relations.filter(
    (relation) => relation.relation === 'made',
  );
  assert.deepEqual(made.map((relation) => relation.target_decision_id), [30]);
});

test('an unknown change survives beside a preservation of another part (review R3)', () => {
  const content = decisionFile([
    entry(10, '**Decision:** Base.'),
    entry(15, '**Decision:** Base.'),
    entry(
      30,
      "**Impact on prior decisions:** Preserves D-010's storage rule. Narrows D-010's audience rule. Partially supersedes and refines D-015's pricing clause.",
    ),
  ]);
  const relations = lineageOf(content, 30);

  assert.deepEqual(pick(relations, 10).map((relation) => [relation.relation, relation.cue]), [
    ['preserves', 'preserves'],
    ['unknown', 'narrows'],
  ]);
  // Coordinated verbs in one clause make one claim: the certified relation stands alone.
  assert.deepEqual(pick(relations, 15).map((relation) => [relation.relation, relation.extent]), [['supersedes', 'partial']]);
});

test('another decision as the explicit subject is a restatement, not a declaration (review R4)', () => {
  const content = decisionFile([
    entry(10, '**Decision:** Base.'),
    entry(11, '**Decision:** Base.'),
    entry(20, '**Decision:** Supersedes D-010.'),
    entry(30, '**Rationale:** D-020 supersedes D-010. D-030 supersedes D-011. D-020 does not change D-011.'),
  ]);
  const relations = lineageOf(content, 30);

  assert.deepEqual(pick(relations, 10).map((relation) => relation.relation), ['references']);
  assert.deepEqual(pick(relations, 11).map((relation) => relation.relation), ['supersedes']);
  assert.deepEqual(pick(relations, 20).map((relation) => relation.relation), ['references']);
  assert.deepEqual(
    buildDecisionLineageModel([{ kind: 'decision', path: 'decisions/fixture.md', content }]).relations
      .filter((relation) => relation.target_decision_id === 10 && relation.relation === 'supersedes')
      .map((relation) => relation.source_decision_id),
    [20],
  );
});

test('a contrast or comparison around an ID is not the preserved object (review R5, real D-170)', () => {
  const content = decisionFile([
    entry(169, '**Decision:** Hero copy.'),
    entry(
      170,
      '**Rationale:** Keeping this separate from D-169 allows the eyebrow framing to be changed independently from the profanity-led hero if either performs poorly.',
    ),
  ]);

  assert.deepEqual(lineageOf(content, 170).map((relation) => relation.relation), ['references']);
});

test('hypothetical wording is uncertified in every cue form; a requirement still preserves (review R6)', () => {
  const content = decisionFile([
    ...[10, 11, 12, 13, 14, 15].map((id) => entry(id, '**Decision:** Base.')),
    entry(
      30,
      [
        '**Decision:** If approved, this may preserve D-010. If adopted, this would not supersede D-011. D-012 may be superseded by D-030.',
        'If the team approves the proposal next quarter, this supersedes D-013. It must retain D-014\'s audit trail. This will supersede D-015 once teams ship.',
      ].join(' '),
    ),
  ]);
  const relations = lineageOf(content, 30);
  const summary = (id) => pick(relations, id).map((relation) => [relation.relation, relation.cue]);

  assert.deepEqual(summary(10), [['unknown', 'modal:preserve']]);
  assert.deepEqual(summary(11), [['unknown', 'modal:would not supersede']]);
  assert.deepEqual(summary(12), [['unknown', 'modal:be superseded by']]);
  assert.deepEqual(summary(13), [['unknown', 'modal:supersedes']]);
  assert.deepEqual(summary(14), [['preserves', 'retain']]);
  assert.deepEqual(summary(15), [['unknown', 'modal:supersede']]);
  assert.equal(collectDeclaredSuccessors(buildDecisionLineageModel([{ kind: 'decision', path: 'd.md', content }]).relations, 12).length, 0);
});

test('session notes: every mention is a reference; only leading top-level Decisions made listings are made', () => {
  const note = [
    '# Session — 2026-06-10-1 — Fixture',
    '',
    '## What we worked on',
    'Reviewed D-011.',
    '',
    '## Decisions made',
    '- D-030 — New.',
    '- **D-031** — Bold.',
    '- D-032 through D-034: range.',
    '- D-015 implemented; no new decision appended.',
    '- Proposed D-038 remains a draft.',
    '- Existing:',
    '  - D-016 — nested.',
    '',
    '## Next session should start with',
    'Read D-030.',
  ].join('\n');
  const { relations } = extractSessionNoteRelations({ path: 'sessions/2026-06-10-1-fixture.md', content: note });
  const made = relations.filter((relation) => relation.relation === 'made');

  assert.deepEqual(made.map((relation) => [relation.target_decision_id, relation.evidence]), [
    [30, 'explicit'],
    [31, 'explicit'],
    [32, 'explicit'],
    [33, 'inferred'],
    [34, 'explicit'],
  ]);
  assert.deepEqual(
    relations.filter((relation) => relation.target_decision_id === 30 && relation.relation === 'references').map((relation) => relation.source_section),
    ['Decisions made', 'Next session should start with'],
  );

  const withoutSection = extractSessionNoteRelations({
    path: 'sessions/2026-06-11-1-no-section.md',
    content: '# Session — 2026-06-11-1 — X\n\n## What we worked on\nChecked D-013.\n',
  });
  assert.deepEqual(withoutSection.relations.map((relation) => relation.relation), ['references']);
});

test('architecture docs cite decisions per section with heading path, line, and section hash', () => {
  const doc = [
    '---',
    'domain: Platform',
    'feature: Fixture',
    'component: Citations',
    'status: In progress',
    '---',
    '',
    '## Details',
    '',
    '### Storage',
    'Follows D-010 and D-010 again.',
    '',
    '```md',
    '## Not a heading D-011',
    '```',
    '',
    '## Retrieval guidance',
    'Load for D-013.',
  ].join('\n');
  const { relations } = extractArchitectureDocCitations({ path: 'architecture/fixture.md', content: doc });

  assert.deepEqual(
    relations.map((relation) => [relation.relation, relation.target_decision_id, relation.source_section, relation.source_line, relation.occurrences]),
    [
      ['cites', 10, 'Details > Storage', 11, 2],
      ['cites', 11, 'Details > Storage', 14, 1],
      ['cites', 13, 'Retrieval guidance', 18, 1],
    ],
  );
  assert.notEqual(relations[0].section_hash, relations[2].section_hash);
});

test('collectDeclaredSuccessors follows declared supersedes and amends transitively, newest first', () => {
  const relations = [
    { source_kind: 'decision', source_decision_id: 294, target_decision_id: 138, relation: 'supersedes' },
    { source_kind: 'decision', source_decision_id: 318, target_decision_id: 294, relation: 'supersedes' },
    { source_kind: 'decision', source_decision_id: 327, target_decision_id: 318, relation: 'amends' },
    { source_kind: 'decision', source_decision_id: 359, target_decision_id: 138, relation: 'preserves' },
    { source_kind: 'decision', source_decision_id: 360, target_decision_id: 138, relation: 'references' },
  ];

  assert.deepEqual(collectDeclaredSuccessors(relations, 138), [
    { decision_id: 327, relations: ['amends'], via: [138, 294, 318] },
    { decision_id: 318, relations: ['supersedes'], via: [138, 294] },
    { decision_id: 294, relations: ['supersedes'], via: [138] },
  ]);
});

test('read model exposes retrieval fields and decision lineage additively', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-lineage-read-model-'));

  try {
    await initializeProjectMemory({
      rootDir,
      force: true,
      name: 'Lineage Project',
      mode: 'local-only',
      repos: [{ id: 'core', remote: 'https://github.com/example/core.git', defaultBranch: 'main' }],
      generatedAt: new Date('2026-06-01T00:00:00Z'),
    });
    await rm(path.join(rootDir, 'architecture/overview'), { recursive: true, force: true });
    await mkdir(path.join(rootDir, 'architecture/platform/memory'), { recursive: true });

    const doc = (component, extra) =>
      [
        '---',
        'domain: Platform',
        'feature: Memory',
        `component: ${component}`,
        'status: In progress',
        'repo: core',
        '---',
        '',
        '## Description',
        `${component} summary citing D-001.`,
        '',
        ...extra,
        '## Details',
        'Details.',
        '',
        '## Next steps',
        '- Next.',
        '',
        '## Involved files',
        '- `src/memory.js`',
        '',
      ].join('\n');

    await writeFile(
      path.join(rootDir, 'architecture/platform/memory/with-retrieval.md'),
      doc('With Retrieval', [
        '## Review metadata',
        '- Review provider: fixture',
        '- Retrieval scope: load before memory work',
        '  that touches lineage',
        '- Coverage: focused',
        '',
        '## Retrieval guidance',
        'Load when changing lineage.',
        '',
      ]),
      'utf8',
    );
    await writeFile(path.join(rootDir, 'architecture/platform/memory/without-retrieval.md'), doc('Without Retrieval', []), 'utf8');
    await writeFile(
      path.join(rootDir, 'decisions/cross-cutting.md'),
      decisionFile([
        entry(1, '**Decision:** One repo.\n**Rationale:** Simple.'),
        entry(2, '**Decision:** D-001 is superseded.\n**Rationale:** Multi-repo.'),
      ]),
      'utf8',
    );
    await writeFile(
      path.join(rootDir, 'sessions/2026-06-01-1-lineage.md'),
      [
        '# Session — 2026-06-01-1 — Lineage',
        '',
        '## What we worked on',
        'Lineage.',
        '',
        '## Completed',
        '- Done.',
        '',
        '## Decisions made',
        '- D-002 — Multi-repo.',
        '',
        '## Models used',
        '- Fixture.',
        '',
        '## Blockers / open questions',
        '- None.',
        '',
        '## Next session should start with',
        'Nothing.',
        '',
      ].join('\n'),
      'utf8',
    );

    const readModel = await loadProjectReadModel(rootDir);
    const feature = getFeatureContext(readModel, 'platform--memory').feature;
    const withRetrieval = feature.components.find((component) => component.component === 'With Retrieval');
    const withoutRetrieval = feature.components.find((component) => component.component === 'Without Retrieval');

    assert.equal(withRetrieval.retrieval_guidance, 'Load when changing lineage.');
    assert.equal(withRetrieval.retrieval_scope, 'load before memory work that touches lineage');
    assert.equal(withoutRetrieval.retrieval_guidance, null);
    assert.equal(withoutRetrieval.retrieval_scope, null);
    assert.deepEqual(Object.keys(withoutRetrieval), [
      'component_key',
      'component',
      'status',
      'path',
      'repo_ids',
      'description',
      'details',
      'next_steps',
      'retrieval_guidance',
      'retrieval_scope',
      'involved_files',
      'warnings',
      'warning_count',
    ]);

    // Existing decision-log entries keep their shape.
    assert.deepEqual(Object.keys(getDecisionLog(readModel).decisions[0]), [
      'decision_id',
      'title',
      'timestamp',
      'decision',
      'rationale',
      'path',
      'domain_file',
    ]);

    assert.equal(readModel.decision_lineage.contract_version, DECISION_LINEAGE_CONTRACT_VERSION);
    const lineage = getDecisionLineage(readModel, 'D-001');
    assert.equal(lineage.exists, true);
    assert.deepEqual(lineage.declared_successors, [{ decision_id: 2, relations: ['supersedes'], via: [1] }]);
    assert.deepEqual(lineage.incoming.map((relation) => [relation.source_decision_id, relation.relation, relation.extent]), [
      [2, 'supersedes', 'unqualified'],
    ]);
    assert.deepEqual(getDecisionLineage(readModel, 2).made_in, ['sessions/2026-06-01-1-lineage.md']);
    assert.ok(lineage.cited_by.some((relation) => relation.relation === 'cites' && relation.target_exists));
    assert.equal(getDecisionLineage(readModel, 'nonsense'), null);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('buildDecisionLineageModel marks unresolved targets and counts every relation type', () => {
  const model = buildDecisionLineageModel([
    { kind: 'decision', path: 'decisions/a.md', content: decisionFile([entry(1, '**Decision:** Base.')]) },
    { kind: 'architecture', path: 'architecture/a.md', content: '## Description\nCites D-001 and D-999.\n' },
    { kind: 'project', path: 'project.yaml', content: 'name: x' },
  ]);

  assert.equal(model.decision_count, 1);
  assert.equal(model.relation_counts.cites, 2);
  assert.deepEqual(model.relations.map((relation) => [relation.target_decision_id, relation.target_exists]), [
    [1, true],
    [999, false],
  ]);
  assert.deepEqual(model.diagnostics.map((diagnostic) => diagnostic.code), ['unresolved-decision-reference']);
});
