import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BRIEF_FOLLOW_UP_CAP,
  BRIEF_MIN_BUDGET,
  buildSessionBrief,
  estimateBriefTokens,
  renderBrief,
} from '../index.js';
import { queryTerms, stemWord } from '../brief-keywords.js';
import { runCli } from '../cli.js';

const FIXTURE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'brief', 'root');

async function makeRoot(t, { lane = 'eval', laneFields = {}, extraLanes = [] } = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-brief-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const rootDir = path.join(parent, 'root');
  await cp(FIXTURE_ROOT, rootDir, { recursive: true });
  for (const id of [lane, ...extraLanes].filter(Boolean)) {
    await writeLane(rootDir, id, id === lane ? laneFields : {});
  }
  return { parent, rootDir };
}

async function writeLane(rootDir, id, fields = {}) {
  const laneDir = path.join(rootDir, 'sessions', 'active', id);
  await mkdir(laneDir, { recursive: true });
  const list = (key, values = []) => (values.length > 0 ? `${key}:\n${values.map((value) => `  - "${value}"`).join('\n')}` : `${key}: []`);
  await writeFile(
    path.join(laneDir, 'session.yaml'),
    [
      `id: ${id}`,
      'status: active',
      'session_date: 2026-02-01',
      'session_number: 1',
      `working_on: ${JSON.stringify(fields.workingOn ?? `Work in lane ${id}`)}`,
      list('feature_slugs', fields.features),
      'repos: []',
      list('claimed_paths', fields.claims),
      list('architecture_docs', fields.architectureDocs),
      'decision_domain_files: []',
      ...(fields.snapshot ? ['decision_snapshot:', `  highest_decision_id: ${fields.snapshot}`] : []),
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(laneDir, 'handoff.md'),
    [
      `# Handoff — ${id}`,
      '',
      '## Builder → Reviewer',
      '',
      "### What's next",
      '- Wire the ledger denial copy.',
      '',
      '## Reviewer → Builder',
      '',
      '### Findings summary',
      '- Review not requested yet.',
      '',
    ].join('\n'),
  );
}

async function snapshotTree(dir) {
  const entries = [];
  async function walk(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(current, entry.name);
      const relative = path.relative(dir, full);
      if (entry.isDirectory()) {
        entries.push(`dir ${relative}`);
        await walk(full);
      } else {
        const hash = createHash('sha256').update(await readFile(full)).digest('hex');
        entries.push(`file ${relative} ${hash} ${(await stat(full)).mode}`);
      }
    }
  }
  await walk(dir);
  return entries;
}

function captureIo() {
  const out = [];
  const err = [];
  return {
    io: { stdout: { write: (chunk) => out.push(chunk) }, stderr: { write: (chunk) => err.push(chunk) } },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

function emittedDecisionIds(result) {
  return new Set(result.units.filter((unit) => unit.kind === 'lineage').flatMap((unit) => unit.members.map((member) => member.decision_id)));
}

test('stemming and query terms are deterministic and drop framing words', () => {
  assert.equal(stemWord('translations'), stemWord('translate'));
  assert.equal(stemWord('connecting'), 'connect');
  assert.equal(stemWord('paid'), 'pay');
  assert.deepEqual(queryTerms('Add a Windows backend to the credential store'), ['window', 'backend', 'credential', 'stor']);
});

test('a file-scoped brief selects covering docs through workspace-path Involved files and packs lineage whole', async (t) => {
  const { rootDir } = await makeRoot(t, { laneFields: { workingOn: 'Rewrite the refused refresh message' } });
  const result = await buildSessionBrief({
    rootDir,
    laneId: 'eval',
    task: 'Rewrite the message a user sees when a hosted refresh run is refused.',
    files: ['app:src/lib/entitlements.ts'],
  });

  assert.equal(result.status, 'complete');
  const ledger = result.units.find((unit) => unit.id === 'doc:architecture/billing/ledger.md');
  assert.ok(ledger, 'the ledger doc covering the file is included');
  assert.match(ledger.reasons.join(' '), /covers file `app:src\/lib\/entitlements\.ts` \(Involved files: `app:acme-app\/src\/lib\/entitlements\.ts`\)/);
  assert.equal(ledger.relations[0].relation, 'covers');
  assert.equal(ledger.relations[0].evidence, 'explicit');

  // D-101 is cited by the ledger's emitted Description (cross-cutting) → a
  // mandatory companion, emitted with its declared successor D-102.
  const d101 = result.units.find((unit) => unit.kind === 'lineage' && unit.root_decision_id === 101);
  assert.equal(d101.tier, 'mandatory');
  assert.equal(d101.companion_of, ledger.id);
  assert.deepEqual(d101.members.map((member) => member.decision_id), [101, 102]);
  assert.equal(d101.members[1].declared_relations[0].relation, 'amends');

  // Uncertified "refines" wording from D-105 is a follow-up read, never status.
  const unknown = result.follow_ups.find((entry) => entry.priority === 'lineage');
  assert.equal(unknown.heading, 'D-105');
  assert.match(unknown.reason, /uncertified lineage wording \(refines\) about D-101/);

  const markdown = renderBrief(result);
  assert.match(markdown, /^## Lane `eval`$/m);
  assert.match(markdown, /Required read: `sessions\/active\/eval\/handoff\.md` \(full\)/);
  assert.match(markdown, /\*\*D-102\*\* \(declared: amends D-101 \(scoped: the metering window\)\)/);
  assert.equal(result.budget.estimated_tokens, estimateBriefTokens(markdown));
});

test('a partial-supersession chain and a transitive supersede/amend chain are emitted whole', async (t) => {
  const { rootDir } = await makeRoot(t);
  const result = await buildSessionBrief({ rootDir, laneId: 'eval', task: 'Change the Free plan credit balance and the Solo plan price.' });

  const byRoot = new Map(result.units.filter((unit) => unit.kind === 'lineage').map((unit) => [unit.root_decision_id, unit]));
  assert.deepEqual(byRoot.get(100).members.map((member) => member.decision_id), [100, 103]);
  assert.equal(byRoot.get(100).members[1].declared_relations[0].extent, 'partial');
  assert.deepEqual(byRoot.get(104).members.map((member) => member.decision_id), [104, 107, 106]);

  const markdown = renderBrief(result);
  assert.match(markdown, /\*\*D-103\*\* \(declared: partially supersedes D-100 \(part: the credit balance\)\)/);
  assert.match(markdown, /\*\*D-106\*\* \(declared: supersedes D-104\)/);
  assert.match(markdown, /\*\*D-107\*\* \(declared: amends D-106 \(scoped: tax display\)\)/);
});

test('mandatory lineage alone over the budget is incomplete, emits no predecessor without its successors, and caps prioritized reads', async (t) => {
  const { rootDir } = await makeRoot(t);
  const result = await buildSessionBrief({
    rootDir,
    laneId: 'eval',
    task: 'Reconcile D-100, D-101, and D-104 before touching billing.',
    budget: BRIEF_MIN_BUDGET,
  });

  assert.equal(result.status, 'incomplete');
  assert.match(result.status_reason, /mandatory unit/);
  assert.ok(result.budget.estimated_tokens <= BRIEF_MIN_BUDGET);

  const emitted = emittedDecisionIds(result);
  const successors = { 100: [103], 101: [102], 104: [106, 107], 106: [107] };
  for (const id of emitted) {
    for (const successor of successors[id] ?? []) assert.ok(emitted.has(successor), `D-${id} emitted without D-${successor}`);
  }

  const required = result.follow_ups.filter((entry) => entry.priority === 'required');
  assert.ok(required.length > 0);
  const ids = required.map((entry) => Number(entry.heading.slice(2)));
  assert.deepEqual(ids, [...ids].sort((left, right) => right - left), 'required reads list the newest declared successor first');
  assert.ok(result.follow_ups.indexOf(required[0]) === 0, 'required reads lead the follow-up list');

  const markdown = renderBrief(result);
  assert.ok(markdown.startsWith('# Session brief\n\n**INCOMPLETE — read these before planning:**\n1. '));
  assert.ok(markdown.split('\n').filter((line) => /^\d+\. `/.test(line)).length <= BRIEF_FOLLOW_UP_CAP);
});

test('optional overflow yields partial with only optional units omitted', async (t) => {
  const { rootDir } = await makeRoot(t, { laneFields: { snapshot: 101 } });
  const options = { rootDir, laneId: 'eval', task: 'Change hosted refresh run metering for the run ledger, the Free plan credit balance, and the Solo plan price.' };
  const full = await buildSessionBrief({ ...options, budget: 6000 });
  assert.equal(full.status, 'complete');
  assert.ok(full.budget.estimated_tokens > 900);
  const optional = full.units.filter((unit) => unit.tier === 'optional');
  assert.ok(optional.length > 0, 'the full brief has optional units (note and newer-decision watch-out)');

  // One token short of the complete brief: optional units pack last, so they go first.
  const result = await buildSessionBrief({ ...options, budget: full.budget.estimated_tokens - 1 });

  assert.equal(result.status, 'partial');
  assert.ok(result.omitted.length > 0);
  assert.ok(result.omitted.every((unit) => unit.tier === 'optional'));
  assert.ok(result.follow_ups.some((entry) => entry.priority === 'optional'));
  assert.ok(result.budget.estimated_tokens <= result.budget.limit);
});

test('strong topic matches survive unfamiliar modifiers; absent words are disclosed, not abstained on (review R1)', async (t) => {
  const { rootDir } = await makeRoot(t);
  const clearer = await buildSessionBrief({ rootDir, laneId: 'eval', task: 'Make hosted refresh run denial messages clearer and friendlier.' });
  assert.notEqual(clearer.status, 'no-match');
  assert.ok(clearer.units.some((unit) => unit.id === 'doc:architecture/billing/ledger.md'));
  const unmatched = clearer.gaps.find((gap) => gap.code === 'unmatched-terms');
  assert.deepEqual(unmatched.terms, ['clearer', 'friendlier']);
  assert.match(renderBrief(clearer), /^- Gap: No keyword match for "clearer", "friendlier" in the fields the brief searches \(titles, Description, Retrieval guidance, Decision text\); other text may mention them\.$/m);
  // Mostly-unknown distinctive words keep the match narrow: few units are packed, the rest are reads.
  assert.equal(clearer.selection.narrowed, true);
  assert.ok(clearer.units.filter((candidate) => candidate.tier === 'ranked').length <= 4);

  const sporadic = await buildSessionBrief({ rootDir, laneId: 'eval', task: 'Can you carefully investigate a sporadic failure in session lane selection?' });
  assert.notEqual(sporadic.status, 'no-match');
  assert.ok(sporadic.units.some((unit) => unit.id === 'doc:architecture/sync/lanes.md'));

  const klingon = await buildSessionBrief({ rootDir, laneId: 'eval', task: 'Add Klingon subtitles and a karaoke kiosk mode.' });
  assert.equal(klingon.status, 'no-match');
  assert.match(renderBrief(klingon), /^- Gap: No keyword match for "Klingon", "subtitles", "karaoke", "kiosk", "mode" in the fields the brief searches/m);
});

test('a narrow match keeps the top-scoring topic and lists the rest as reads (review R5)', async (t) => {
  const { rootDir } = await makeRoot(t);
  // An incidental decision shares three task words in its body; the real
  // topic (the lanes doc) shares two, in its title and guidance.
  await writeFile(
    path.join(rootDir, 'decisions', 'incidental.md'),
    '### D-300 — Credential cache\n**Timestamp:** 2026-01-10 10:00 UTC\n**Decision:** The credential cache makes the lookup and backend selection faster on repeat use.\n**Rationale:** Fixture.\n',
  );
  const result = await buildSessionBrief({ rootDir, laneId: 'eval', task: 'Make the lane selection lookup noticeably faster and sturdier.' });
  assert.notEqual(result.status, 'no-match');
  assert.equal(result.selection.narrowed, true);
  assert.ok(result.units.some((unit) => unit.id === 'doc:architecture/sync/lanes.md'), 'the lanes doc is packed');
  const ranked = result.units.filter((unit) => unit.tier === 'ranked');
  assert.ok(ranked.length <= 4);
  if (result.omitted.some((unit) => unit.omitted_reason === 'narrow-match')) {
    assert.match(renderBrief(result), /every match is low-confidence: the top \d+ are shown for orientation/);
  }
  for (const unit of result.omitted.filter((candidate) => candidate.omitted_reason === 'narrow-match')) {
    assert.ok(result.follow_ups.some((entry) => entry.path === (unit.path ?? unit.members?.[0]?.path)), `${unit.id} is listed as a read`);
  }
});

test('the unmatched-words gap reports the search, not absence from memory (review R6)', async (t) => {
  const { rootDir } = await makeRoot(t);
  const result = await buildSessionBrief({ rootDir, laneId: 'eval', task: 'Explain D-106 tax display.' });
  const markdown = renderBrief(result);
  assert.match(markdown, /\*\*D-107\*\* \(declared: amends D-106 \(scoped: tax display\)\)/);
  assert.doesNotMatch(markdown, /No memory unit mentions/);
  assert.match(markdown, /^- Gap: No keyword match for "Explain", "display" in the fields the brief searches \(titles, Description, Retrieval guidance, Decision text\); other text may mention them\.$/m);
});

test('a structured-only partial supersession keeps its named part (review R2)', async (t) => {
  const { rootDir } = await makeRoot(t);
  const decisions = path.join(rootDir, 'decisions', 'cross-cutting.md');
  await writeFile(
    decisions,
    `${await readFile(decisions, 'utf8')}\n---\n\n### D-201 — Replacement policy\n**Timestamp:** 2026-01-09 10:00 UTC\n**Decision:** The replacement follows the updated policy.\n**Partially supersedes:** D-100 — the top-up packs\n**Rationale:** Fixture.\n`,
  );
  const result = await buildSessionBrief({ rootDir, laneId: 'eval', task: 'Review D-100.' });
  const unit = result.units.find((candidate) => candidate.kind === 'lineage' && candidate.root_decision_id === 100);
  assert.deepEqual(unit.members.map((member) => member.decision_id), [100, 201, 103]);
  assert.equal(unit.members[1].impact, null);
  assert.match(renderBrief(result), /\*\*D-201\*\* \(declared: partially supersedes D-100 \(part: the top-up packs\)\)/);
});

test('uncertified wording from a declared successor stays a follow-up read (review R3)', async (t) => {
  const { rootDir } = await makeRoot(t);
  const decisions = path.join(rootDir, 'decisions', 'cross-cutting.md');
  await writeFile(
    decisions,
    `${await readFile(decisions, 'utf8')}\n---\n\n### D-200 — Updated handling\n**Timestamp:** 2026-01-09 10:00 UTC\n**Decision:** Apply the updated handling.\n**Amends:** D-100 — the monthly grant\n**Rationale:** Refines D-100's top-up rules.\n`,
  );
  const result = await buildSessionBrief({ rootDir, laneId: 'eval', task: 'Review D-100.' });
  const unit = result.units.find((candidate) => candidate.kind === 'lineage' && candidate.root_decision_id === 100);
  assert.ok(unit.members.some((member) => member.decision_id === 200));
  assert.ok(unit.unknown_incoming.some((relation) => relation.source_decision_id === 200 && relation.target_decision_id === 100));
  const read = result.follow_ups.find((entry) => entry.priority === 'lineage' && entry.heading === 'D-200');
  assert.match(read.reason, /uncertified lineage wording \(refines\) about D-100/);
  assert.notEqual(result.status, 'incomplete');
});

test('every accepted input renders within budget, including retrieval failures with long inputs (review R4)', async (t) => {
  const longTask = 'Change the credential store backend. '.repeat(8);
  const longFiles = [1, 2, 3, 4].map((index) => `app:src/${'component-name/'.repeat(34)}${index}.ts`);

  const { rootDir: broken } = await makeRoot(t);
  await writeFile(path.join(broken, 'decisions', 'extra.md'), '### D-101 — Duplicate entry\n**Timestamp:** 2026-01-09 10:00 UTC\n**Decision:** Duplicate.\n**Rationale:** Broken on purpose.\n');
  const failure = await buildSessionBrief({ rootDir: broken, laneId: 'eval', task: longTask, files: longFiles, budget: BRIEF_MIN_BUDGET });
  assert.equal(failure.status, 'incomplete');
  assert.match(failure.status_reason, /^retrieval failed/);
  assert.ok(failure.budget.estimated_tokens <= BRIEF_MIN_BUDGET, `estimated ${failure.budget.estimated_tokens}`);
  assert.equal(failure.budget.estimated_tokens, estimateBriefTokens(renderBrief(failure)));
  assert.deepEqual(failure.inputs.files, longFiles, 'full inputs stay in the JSON result');

  const { rootDir } = await makeRoot(t);
  for (const budget of [BRIEF_MIN_BUDGET, 900]) {
    const result = await buildSessionBrief({ rootDir, laneId: 'eval', task: `${longTask} Also the Free plan credit balance, D-100, D-101, D-104, and hosted refresh metering.`, files: longFiles, budget });
    assert.ok(result.budget.estimated_tokens <= budget, `budget ${budget}: estimated ${result.budget.estimated_tokens}`);
    assert.equal(result.budget.estimated_tokens, estimateBriefTokens(renderBrief(result)));
  }
});

test('no-match returns only the lane unit with no filler', async (t) => {
  const { rootDir } = await makeRoot(t);
  const result = await buildSessionBrief({ rootDir, laneId: 'eval', task: 'Add Klingon subtitles and a karaoke kiosk mode.' });

  assert.equal(result.status, 'no-match');
  assert.deepEqual(result.units.map((unit) => unit.kind), ['lane']);
  assert.deepEqual(result.follow_ups, []);
  const markdown = renderBrief(result);
  assert.doesNotMatch(markdown, /## Decisions|## Architecture docs|## Session notes|## Follow-up reads/);
  assert.match(markdown, /\*\*Status: no-match\*\*/);
});

test('follow-ups above the cap render the first twelve and "+N more"; --json keeps the full list', async (t) => {
  const { rootDir } = await makeRoot(t);
  for (let index = 1; index <= 20; index += 1) {
    await writeFile(
      path.join(rootDir, 'architecture', 'billing', `widget-${String(index).padStart(2, '0')}.md`),
      [
        '---',
        'domain: Billing',
        `feature: Widget ${index}`,
        `component: Widget Gizmo ${index}`,
        'status: In progress',
        '---',
        '',
        '## Description',
        `Widget gizmo number ${index} explains the gizmo sprocket flange for widget sprocket work. ${'Sprocket flange detail. '.repeat(12)}`,
        '',
        '## Retrieval guidance',
        'Load before changing widget gizmo sprockets.',
        '',
      ].join('\n'),
    );
  }

  await writeFile(
    path.join(rootDir, 'decisions', 'widgets.md'),
    Array.from({ length: 16 }, (_, index) => {
      const id = 200 + index;
      return [
        `### D-${id} — Widget gizmo sprocket rule ${index + 1}`,
        '**Timestamp:** 2026-01-10 10:00 UTC',
        `**Decision:** Widget gizmo sprocket flanges follow rule ${index + 1}. ${'The flange keeps its sprocket. '.repeat(6)}`,
        '**Rationale:** Fixture.',
        '',
      ].join('\n');
    }).join('\n'),
  );

  const result = await buildSessionBrief({ rootDir, laneId: 'eval', task: 'Change the widget gizmo sprocket flange.', budget: 1200 });
  assert.equal(result.status, 'partial');
  assert.ok(result.follow_ups.length > BRIEF_FOLLOW_UP_CAP);
  const markdown = renderBrief(result);
  const listed = markdown.split('\n').filter((line) => /^\d+\. `/.test(line));
  assert.equal(listed.length, BRIEF_FOLLOW_UP_CAP);
  assert.match(markdown, new RegExp(`^\\+${result.follow_ups.length - BRIEF_FOLLOW_UP_CAP} more \\(full list in \`--json\`\\)$`, 'm'));
  assert.ok(result.budget.estimated_tokens <= 1200);
});

test('a missing overview is a disclosed gap', async (t) => {
  const { rootDir } = await makeRoot(t);
  await rm(path.join(rootDir, 'architecture', 'overview'), { recursive: true });
  const result = await buildSessionBrief({ rootDir, laneId: 'eval', task: 'Change hosted refresh run metering.' });

  assert.deepEqual(result.gaps.map((gap) => gap.code), ['missing-overview']);
  assert.equal(result.orientation.exists, false);
  assert.match(renderBrief(result), /^- Gap: No orientation overview at `architecture\/overview\/project-shape\.md`/m);
});

test('a retrieval error is incomplete with a reason and prioritized reads', async (t) => {
  const { rootDir } = await makeRoot(t);
  await writeFile(path.join(rootDir, 'decisions', 'extra.md'), '### D-101 — Duplicate entry\n**Timestamp:** 2026-01-09 10:00 UTC\n**Decision:** Duplicate.\n**Rationale:** Broken on purpose.\n');
  const result = await buildSessionBrief({ rootDir, laneId: 'eval', task: 'Change hosted refresh run metering.' });

  assert.equal(result.status, 'incomplete');
  assert.match(result.status_reason, /^retrieval failed — the read model could not be built: .*duplicated/);
  assert.deepEqual(result.units.map((unit) => unit.kind), ['lane']);
  assert.deepEqual(result.follow_ups.map((entry) => entry.path), ['architecture/overview/project-shape.md', 'decisions/INDEX.md']);
  assert.ok(renderBrief(result).startsWith('# Session brief\n\n**INCOMPLETE — read these before planning:**'));
});

test('budgets are honored exactly and invalid budgets are rejected', async (t) => {
  const { rootDir } = await makeRoot(t);
  for (const budget of [800, 950, 1500, 3000, 6000]) {
    const result = await buildSessionBrief({ rootDir, laneId: 'eval', task: 'Change the Free plan credit balance, hosted refresh metering, and the Solo plan price.', budget });
    const markdown = renderBrief(result);
    assert.equal(result.budget.estimated_tokens, estimateBriefTokens(markdown));
    assert.ok(result.budget.estimated_tokens <= budget, `budget ${budget}: estimated ${result.budget.estimated_tokens}`);
    assert.match(markdown, new RegExp(`Estimated size: ~${result.budget.estimated_tokens.toLocaleString('en-US')} of`));
  }
  await assert.rejects(buildSessionBrief({ rootDir, task: 'x', budget: 799 }), /at least 800/);
  await assert.rejects(buildSessionBrief({ rootDir, task: 'x', budget: 1000.5 }), /whole number/);
});

test('briefs are deterministic and never use certifying wording', async (t) => {
  const { rootDir } = await makeRoot(t, { laneFields: { snapshot: 103 }, extraLanes: ['other-lane'] });
  const options = { rootDir, laneId: 'eval', task: 'Change the Free plan credit balance and hosted refresh metering.' };
  const first = await buildSessionBrief(options);
  const second = await buildSessionBrief(options);
  assert.deepEqual(first, second);

  const markdown = renderBrief(first);
  assert.doesNotMatch(markdown, /\bgoverns?\b|\bgoverning\b|currently valid|in force/i);
  assert.match(markdown, /^- Other active lanes: `other-lane`/m);
  assert.match(markdown, /^- Decisions appended after this lane's snapshot D-103: D-107/m);
});

test('doc sections are read fence-aware, and missing sections surface a maintenance action', async (t) => {
  const { rootDir } = await makeRoot(t);
  const result = await buildSessionBrief({ rootDir, laneId: 'eval', task: 'Change session lane selection and the credential store backend.' });
  const lanes = result.units.find((unit) => unit.id === 'doc:architecture/sync/lanes.md');
  assert.match(lanes.description, /^Session lanes let several builder sessions run in parallel/);
  const credentials = result.units.find((unit) => unit.id === 'doc:architecture/sync/credentials.md');
  assert.deepEqual(credentials.missing_sections, ['Retrieval guidance']);
  assert.match(renderBrief(result), /Maintenance: missing `## Retrieval guidance` \(`architecture-missing-section`\)/);
});

test('vibecompass brief is strictly read-only against the root', async (t) => {
  const { parent, rootDir } = await makeRoot(t);
  const before = await snapshotTree(rootDir);

  const markdownRun = captureIo();
  assert.equal(await runCli(['brief', '--root', rootDir, '--task', 'Change hosted refresh run metering.', '--files', 'app:src/lib/entitlements.ts', 'core:src/session.js'], markdownRun.io, { cwd: parent }), 0);
  assert.match(markdownRun.stdout(), /^# Session brief/);

  const jsonRun = captureIo();
  assert.equal(await runCli(['brief', '--root', rootDir, '--task', 'Change hosted refresh run metering.', '--json', '--budget', '900'], jsonRun.io, { cwd: parent }), 0);
  const parsed = JSON.parse(jsonRun.stdout());
  assert.equal(parsed.lane_source, 'single-lane');
  assert.equal(parsed.markdown, renderBrief(parsed));
  assert.ok(parsed.budget.estimated_tokens <= 900);

  assert.deepEqual(await snapshotTree(rootDir), before);
});

test('vibecompass brief resolves lanes like other lane-scoped commands', async (t) => {
  const { parent, rootDir } = await makeRoot(t, { extraLanes: ['second-lane'] });

  const ambiguous = captureIo();
  await assert.rejects(runCli(['brief', '--root', rootDir, '--task', 'Change metering.'], ambiguous.io, { cwd: parent }), /Multiple active session lanes exist/);

  const chosen = captureIo();
  assert.equal(await runCli(['brief', '--root', rootDir, '--session', 'second-lane', '--json'], chosen.io, { cwd: parent }), 0);
  const parsed = JSON.parse(chosen.stdout());
  assert.equal(parsed.source.lane_id, 'second-lane');
  assert.equal(parsed.task, 'Work in lane second-lane', 'the lane working-on stands in for a missing --task');

  await assert.rejects(runCli(['brief', '--root', rootDir, '--session', 'eval', '--budget', 'lots'], captureIo().io, { cwd: parent }), /--budget must be a whole number/);
});
