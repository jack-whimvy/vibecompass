import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSessionBrief, continueProjectSession, renderBrief, scanProjectMemory, startProjectSession } from '../index.js';
import { generateLaneBrief, inspectLaneBrief, laneBriefPath } from '../brief-lifecycle.js';
import { compileBriefExclusions, validateBriefSettings, validateExcludePattern } from '../brief-settings.js';
import { runCli } from '../cli.js';
import { parseFrontmatter } from '../frontmatter.js';
import { initializeProjectMemory } from '../init.js';

const FIXTURE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'brief', 'root');
const CLI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
const TASK = 'Wire the ledger denial copy for refresh runs';
const CAN_LOCK_FILES = process.platform !== 'win32' && process.getuid?.() !== 0;

/**
 * A workspace holding a copy of the brief fixture corpus as `.compass`, a
 * CLAUDE.md, and lane temp dirs kept inside the workspace. `lock(path)` makes a
 * file or directory unreadable for the rest of the test (restored before
 * cleanup), so a read of it fails loudly.
 */
// Workspaces opt into the lifecycle brief (`brief.enabled: true`, D-368) unless
// a test passes its own `brief` settings, or `brief: null` for no block at all.
async function makeWorkspace(t, { prefix = 'vibecompass-brief-life-', brief = { enabled: true }, repos = null, laneTmp = true } = {}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), prefix));
  const locked = [];
  t.after(async () => {
    for (const target of locked.reverse()) await chmod(target, 0o755).catch(() => {});
    await rm(workspace, { recursive: true, force: true });
  });
  const rootDir = path.join(workspace, '.compass');
  await cp(FIXTURE_ROOT, rootDir, { recursive: true });
  await writeFile(path.join(workspace, 'CLAUDE.md'), '# Acme Widgets\n');
  // Lane temp dirs stay inside the workspace unless the test needs
  // byte-identical project.yaml files across workspaces.
  await writeProjectYaml(rootDir, { brief, repos, tmpBase: laneTmp ? path.join(workspace, 'lane-tmp') : null });
  return {
    workspace,
    rootDir,
    async lock(target) {
      await chmod(target, 0o000);
      locked.push(target);
    },
  };
}

async function writeProjectYaml(rootDir, { brief = null, repos = null, tmpBase = null, raw = null } = {}) {
  const repoList = repos ?? [
    { id: 'app', remote: 'https://github.com/example/acme-app.git' },
    { id: 'core', remote: 'https://github.com/example/acme-core.git' },
  ];
  const lines = [
    'format_version: 1',
    'name: Acme Widgets',
    'slug: acme-widgets',
    'mode: local-primary',
    'repos:',
    ...repoList.flatMap((repo) => [`  - id: ${repo.id}`, `    remote: ${repo.remote}`, '    default_branch: main']),
    ...(tmpBase ? ['runtime:', `  tmp_base: ${JSON.stringify(tmpBase)}`] : []),
    ...(raw ?? (brief ? renderBriefBlock(brief) : [])),
    '',
  ];
  await writeFile(path.join(rootDir, 'project.yaml'), lines.join('\n'));
}

function renderBriefBlock(brief) {
  const lines = ['brief:'];
  if (brief.enabled !== undefined) lines.push(`  enabled: ${brief.enabled}`);
  if (brief.exclude) lines.push('  exclude:', ...brief.exclude.map((pattern) => `    - ${JSON.stringify(pattern)}`));
  return lines;
}

async function startLane(workspace, rootDir, options = {}) {
  return startProjectSession({
    cwd: workspace,
    rootDir,
    sessionId: options.id ?? 'ledger',
    workingOn: options.workingOn ?? TASK,
    claims: options.claims ?? [],
    repos: options.repos ?? [],
    date: '2026-02-01',
    ...options.extra,
  });
}

async function readBriefFile(rootDir, laneId = 'ledger') {
  const content = await readFile(laneBriefPath(rootDir, laneId), 'utf8');
  const { data, body } = parseFrontmatter(content);
  return { content, header: data, body };
}

async function snapshotTree(dir) {
  const entries = [];
  async function walk(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(current, entry.name);
      const relative = path.relative(dir, full);
      const info = await stat(full);
      if (entry.isDirectory()) {
        entries.push(`dir ${relative} ${info.mode}`);
        await walk(full);
      } else {
        const hash = createHash('sha256').update(await readFile(full)).digest('hex');
        entries.push(`file ${relative} ${hash} ${info.mode} ${info.mtimeMs}`);
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
    reset: () => {
      out.length = 0;
      err.length = 0;
    },
  };
}

const EXCLUDED_DOC = `---
domain: Billing
feature: Ledger
component: Evaluation Labels
status: In progress
repos:
  - app
---

## Description
Quuxlabel evaluation answers for the ledger denial copy and refresh runs; expected sources D-105 and D-101.

## Retrieval guidance
Load before changing ledger denial copy for refresh runs.

## Involved files
- \`acme-app/src/lib/entitlements.ts\`
`;

const EXCLUDED_DECISIONS = `# Evaluation decisions

### D-190 — Quuxlabel ledger denial copy answers
**Timestamp:** 2026-01-05 10:00 PST
**Decision:** Quuxlabel answers for the ledger denial copy of refresh runs.
**Rationale:** Evaluation only.
`;

/** Normalizes a result for comparison across roots (only the root path differs). */
function comparable(result, rootDir) {
  return JSON.parse(JSON.stringify(result).split(rootDir).join('<root>'));
}

// ---------------------------------------------------------------------------
// Settings and exclusion
// ---------------------------------------------------------------------------

test('brief.exclude globs: validation and matching (D-364)', () => {
  for (const bad of ['', '/abs/x.md', 'C:/x.md', '../x.md', 'a/./b.md', 'a//b.md', 'a/**b/c.md', 'a/[ab].md', 'a/{x,y}.md', '!a.md', 'a\\b.md']) {
    assert.ok(validateExcludePattern(bad), `"${bad}" must be rejected`);
  }
  const exclusions = compileBriefExclusions([
    'architecture/platform/recall-evaluation.md',
    '**/recall-evaluation-heldout*.md',
    'decisions/eval-?.md',
    'sessions/*-eval.md',
  ]);
  assert.ok(exclusions.matches('architecture/platform/recall-evaluation.md'));
  assert.ok(exclusions.matches('Architecture/Platform/Recall-Evaluation.md'), 'matching ignores case, so a mis-cased pattern still excludes');
  assert.ok(exclusions.matches('recall-evaluation-heldout.md'), '** matches zero segments');
  assert.ok(exclusions.matches('architecture/a/b/recall-evaluation-heldout-v2.md'));
  assert.ok(exclusions.matches('decisions/eval-1.md'));
  assert.ok(!exclusions.matches('decisions/eval-12.md'), '? matches exactly one character');
  assert.ok(exclusions.matches('sessions/2026-01-01-eval.md'));
  assert.ok(!exclusions.matches('sessions/nested/2026-01-01-eval.md'), '* stays within one segment');
  assert.ok(!exclusions.matches('architecture/platform/recall-evaluation.md.bak'));

  assert.deepEqual(validateBriefSettings(undefined), { enabled: false, enabledDeclared: false, exclude: [], problems: [] }, 'the lifecycle brief is opt-in (D-368)');
  assert.deepEqual(validateBriefSettings({ exclude: ['a.md'] }), { enabled: false, enabledDeclared: false, exclude: ['a.md'], problems: [] });
  assert.deepEqual(validateBriefSettings({ enabled: true }), { enabled: true, enabledDeclared: true, exclude: [], problems: [] });
  assert.deepEqual(validateBriefSettings({ enabled: false, exclude: ['a.md', 'a.md'] }), { enabled: false, enabledDeclared: true, exclude: ['a.md'], problems: [] });
  assert.match(validateBriefSettings({ exclude: 'a.md' }).problems[0], /must be a list/);
  assert.match(validateBriefSettings({ excludes: ['a.md'] }).problems[0], /unknown field "brief\.excludes"/, 'a misspelled field fails closed instead of silently excluding nothing');
  assert.match(validateBriefSettings({ enabled: 'no' }).problems[0], /true or false/);
  assert.match(validateBriefSettings(['a.md']).problems[0], /must be a mapping/);
});

test('an excluded document is never opened and contributes nothing to selection, ranking, propagation, or output (D-364)', async (t) => {
  const exclude = ['architecture/**/eval-set.md', 'decisions/eval.md'];
  const inputs = { task: 'quuxlabel ledger denial copy for refresh runs', files: ['app:src/lib/entitlements.ts'] };

  // Excluded: both files present but unreadable.
  const excluded = await makeWorkspace(t, { brief: { enabled: true, exclude }, laneTmp: false });
  await writeFile(path.join(excluded.rootDir, 'architecture', 'billing', 'eval-set.md'), EXCLUDED_DOC);
  await writeFile(path.join(excluded.rootDir, 'decisions', 'eval.md'), EXCLUDED_DECISIONS);
  if (CAN_LOCK_FILES) {
    await excluded.lock(path.join(excluded.rootDir, 'architecture', 'billing', 'eval-set.md'));
    await excluded.lock(path.join(excluded.rootDir, 'decisions', 'eval.md'));
  }
  // Absent: the same settings, and the files do not exist at all.
  const absent = await makeWorkspace(t, { brief: { enabled: true, exclude }, laneTmp: false });
  // Included: the same files, readable, with no exclusion.
  const included = await makeWorkspace(t);
  await writeFile(path.join(included.rootDir, 'architecture', 'billing', 'eval-set.md'), EXCLUDED_DOC);
  await writeFile(path.join(included.rootDir, 'decisions', 'eval.md'), EXCLUDED_DECISIONS);

  const excludedResult = await buildSessionBrief({ rootDir: excluded.rootDir, ...inputs });
  const absentResult = await buildSessionBrief({ rootDir: absent.rootDir, ...inputs });
  const includedResult = await buildSessionBrief({ rootDir: included.rootDir, ...inputs });

  assert.notEqual(excludedResult.status, 'incomplete', 'an unreadable excluded file must not be opened');
  assert.deepEqual(comparable(excludedResult, excluded.rootDir), comparable(absentResult, absent.rootDir), 'excluding a file is indistinguishable from its absence, bindings included');
  assert.equal(excludedResult.source.corpus_digest, absentResult.source.corpus_digest);
  // Its unique word appears only where the task echoes it: no unit carries it,
  // and the keyword index reports it as unmatched although the file holds it.
  assert.ok(!/quuxlabel/i.test(JSON.stringify(excludedResult.units)));
  assert.ok(excludedResult.gaps.some((gap) => gap.code === 'unmatched-terms' && gap.terms.includes('quuxlabel')));
  assert.ok(!includedResult.gaps.some((gap) => gap.code === 'unmatched-terms' && gap.terms.includes('quuxlabel')));
  const emitted = JSON.stringify([excludedResult.units, excludedResult.omitted, excludedResult.follow_ups]);
  assert.ok(!emitted.includes('eval-set.md') && !emitted.includes('decisions/eval.md') && !emitted.includes('"decision_id":190'));

  // Controls: readable and not excluded, the same files would be selected and
  // ranked, and would pull their citations into the brief...
  assert.ok(includedResult.units.some((unit) => unit.path === 'architecture/billing/eval-set.md'));
  assert.ok([...includedResult.units, ...includedResult.omitted].some((unit) => unit.kind === 'lineage' && unit.members.some((member) => member.decision_id === 190)));
  // ...and, unreadable and not excluded, the brief would open them and fail.
  if (CAN_LOCK_FILES) {
    const unexcluded = await makeWorkspace(t);
    await writeFile(path.join(unexcluded.rootDir, 'architecture', 'billing', 'eval-set.md'), EXCLUDED_DOC);
    await unexcluded.lock(path.join(unexcluded.rootDir, 'architecture', 'billing', 'eval-set.md'));
    const failed = await buildSessionBrief({ rootDir: unexcluded.rootDir, ...inputs });
    assert.equal(failed.status, 'incomplete');
    assert.match(failed.status_reason, /EACCES|permission denied/i);
  }

  // The lane brief, its freshness check, and the CLI never open them either.
  const started = await startLane(excluded.workspace, excluded.rootDir, { claims: ['app:src/lib/entitlements.ts'] });
  t.after(() => rm(started.runtime.tmpDir, { recursive: true, force: true }));
  const { header, body } = await readBriefFile(excluded.rootDir);
  assert.equal(header.generation, 'ok');
  assert.deepEqual(header.exclude, exclude, 'the header records the patterns, never what they matched');
  assert.ok(!/quuxlabel|eval-set\.md|decisions\/eval\.md|D-190/i.test(body));
  assert.ok(!header.inputs.some((line) => /eval-set\.md|decisions\/eval\.md/.test(line)));
  const inspection = await inspectLaneBrief({ rootDir: excluded.rootDir, laneId: 'ledger' });
  assert.equal(inspection.stale, false, inspection.reasons.join('; '));
  const cli = captureIo();
  assert.equal(await runCli(['brief', '--root', excluded.rootDir, '--task', inputs.task, '--json'], cli.io, { cwd: excluded.workspace }), 0);
  assert.ok(!/quuxlabel/i.test(JSON.stringify(JSON.parse(cli.stdout()).units)));
});

test('invalid brief settings fail closed: no canonical document is read, and scans warn (D-364)', async (t) => {
  for (const raw of [
    ['brief:', '  exclude: "architecture/billing/ledger.md"'],
    ['brief:', '  excludes:', '    - "architecture/billing/ledger.md"'],
    ['brief:', '  exclude:', '    - "../outside.md"'],
  ]) {
    const { rootDir, lock } = await makeWorkspace(t);
    await writeProjectYaml(rootDir, { raw });
    const scan = await scanProjectMemory(rootDir);
    assert.ok(scan.warnings.some((warning) => warning.code === 'project-brief-invalid'), `scan warns for ${raw.join(' ')}`);
    if (CAN_LOCK_FILES) await lock(path.join(rootDir, 'architecture', 'billing', 'ledger.md'));

    const result = await buildSessionBrief({ rootDir, task: TASK });
    assert.equal(result.status, 'incomplete');
    assert.match(result.status_reason, /brief settings are invalid, so no canonical document was read/);
    assert.doesNotMatch(result.status_reason, /EACCES/, 'no canonical document was opened');
    assert.equal(result.units.length, 0);
  }

  // An unparseable project.yaml leaves the exclusions unknown: fail closed too.
  const { rootDir } = await makeWorkspace(t);
  await writeFile(path.join(rootDir, 'project.yaml'), 'format_version: 1\nname: [broken\n\tmode: x\n');
  const result = await buildSessionBrief({ rootDir, task: TASK });
  assert.equal(result.status, 'incomplete');
  assert.match(result.status_reason, /project\.yaml could not be read/);
});

// ---------------------------------------------------------------------------
// Lifecycle generation
// ---------------------------------------------------------------------------

test('start-session writes brief.md on an opted-in root: lane-derived inputs, header bindings, and the printed brief as its body (D-364, D-368)', async (t) => {
  const { workspace, rootDir } = await makeWorkspace(t);
  const started = await startLane(workspace, rootDir, { claims: ['app:src/lib/entitlements.ts'], repos: ['app'] });
  assert.equal(started.brief.state, 'written');
  assert.equal(started.brief.path, laneBriefPath(rootDir, 'ledger'));

  const { header, body } = await readBriefFile(rootDir);
  assert.equal(body, renderBrief(await buildSessionBrief({ rootDir, laneId: 'ledger' })), 'the body is exactly what `vibecompass brief` prints for the lane');
  assert.equal(header.brief_format, 1);
  assert.equal(header.generation, 'ok');
  assert.equal(header.status, started.brief.status);
  assert.equal(header.source_root, rootDir);
  assert.equal(header.destination_root, rootDir);
  assert.equal(header.source_lane, 'ledger');
  assert.equal(header.destination_lane, 'ledger');
  assert.equal(header.source_session, '2026-02-01-1');
  assert.match(header.corpus_digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(header.lane_bindings.session, /^[0-9a-f]{16}$/);
  assert.match(header.lane_bindings.handoff, /^[0-9a-f]{16}$/);
  assert.deepEqual(header.repo_aliases, ['app -> app', 'core -> core']);
  assert.ok(header.inputs.some((line) => /^[0-9a-f]{16} architecture\/billing\/ledger\.md$/.test(line)), 'the lane claim selected the covering doc');
  assert.ok(header.inputs.some((line) => /^[0-9a-f]{16} decisions\/cross-cutting\.md#D-\d{3}/.test(line)), 'decisions bind per entry');
  assert.match(body, /Task: Wire the ledger denial copy for refresh runs/);
  assert.match(body, /covers lane claim `app:src\/lib\/entitlements\.ts`/);
});

test('the lifecycle brief is opt-in; --no-brief and brief.enabled: false keep it off and leave the lifecycle exactly as before (D-364, D-368)', async (t) => {
  // No `brief:` block: lifecycle generation is off by default (D-368).
  const unset = await makeWorkspace(t, { brief: null });
  const startedUnset = await startLane(unset.workspace, unset.rootDir);
  assert.deepEqual(startedUnset.brief, { state: 'off', reason: 'opt-in; project.yaml does not set brief.enabled: true', path: laneBriefPath(unset.rootDir, 'ledger'), warnings: [] });
  assert.equal(startedUnset.warnings.some((warning) => /Session brief/.test(warning)), false);
  assert.deepEqual((await readdir(path.join(unset.rootDir, 'sessions', 'active', 'ledger'))).sort(), ['handoff.md', 'session.yaml', 'wip.md']);
  const resumedUnset = await continueProjectSession({ cwd: unset.workspace, rootDir: unset.rootDir, sessionId: 'ledger' });
  assert.equal(resumedUnset.brief.state, 'off');
  await assert.rejects(stat(laneBriefPath(unset.rootDir, 'ledger')), { code: 'ENOENT' });
  // A brief written on request is left in place, never regenerated, while generation is off.
  const unsetCli = captureIo();
  assert.equal(await runCli(['brief', '--root', unset.rootDir, '--session', 'ledger', '--write'], unsetCli.io, { cwd: unset.workspace }), 0);
  const requested = await readFile(laneBriefPath(unset.rootDir, 'ledger'), 'utf8');
  await writeFile(path.join(unset.rootDir, 'sessions', 'active', 'ledger', 'handoff.md'), '# Handoff\n\nChanged.\n');
  assert.equal((await continueProjectSession({ cwd: unset.workspace, rootDir: unset.rootDir, sessionId: 'ledger' })).brief.state, 'off');
  assert.equal(await readFile(laneBriefPath(unset.rootDir, 'ledger'), 'utf8'), requested);
  assert.equal((await inspectLaneBrief({ rootDir: unset.rootDir, laneId: 'ledger' })).stale, true, 'brief --check still reports it stale');

  const flag = await makeWorkspace(t);
  const started = await startLane(flag.workspace, flag.rootDir, { extra: { brief: false } });
  assert.deepEqual(started.brief, { state: 'off', reason: '--no-brief', path: laneBriefPath(flag.rootDir, 'ledger'), warnings: [] });
  assert.deepEqual((await readdir(path.join(flag.rootDir, 'sessions', 'active', 'ledger'))).sort(), ['handoff.md', 'session.yaml', 'wip.md']);
  const resumed = await continueProjectSession({ cwd: flag.workspace, rootDir: flag.rootDir, sessionId: 'ledger', brief: false });
  assert.equal(resumed.brief.state, 'off');
  assert.deepEqual((await readdir(path.join(flag.rootDir, 'sessions', 'active', 'ledger'))).sort(), ['handoff.md', 'session.yaml', 'wip.md']);

  const setting = await makeWorkspace(t, { brief: { enabled: false } });
  const startedOff = await startLane(setting.workspace, setting.rootDir);
  assert.equal(startedOff.brief.state, 'off');
  assert.equal(startedOff.brief.reason, 'project.yaml brief.enabled: false');
  assert.equal(startedOff.warnings.some((warning) => /Session brief/.test(warning)), false);
  const resumedOff = await continueProjectSession({ cwd: setting.workspace, rootDir: setting.rootDir, sessionId: 'ledger' });
  assert.equal(resumedOff.brief.state, 'off');
  await assert.rejects(stat(laneBriefPath(setting.rootDir, 'ledger')), { code: 'ENOENT' });

  // Explicit refresh still works with the setting off.
  const cli = captureIo();
  assert.equal(await runCli(['brief', '--root', setting.rootDir, '--session', 'ledger', '--write'], cli.io, { cwd: setting.workspace }), 0);
  assert.match(cli.stdout(), /^Brief: \w[\w-]* — wrote .*ledger\/brief\.md$/m);
});

test('a brief failure never overturns a successful start or resume; lifecycle refusals still fail (D-359, D-364)', async (t) => {
  // Engine failure: an incomplete brief names the reason; the start succeeds.
  const engine = await makeWorkspace(t);
  const started = await startLane(engine.workspace, engine.rootDir, {
    extra: { briefBuilder: async () => { throw new Error('synthetic engine failure'); } },
  });
  assert.equal(started.sessionId, 'ledger');
  assert.equal(started.brief.state, 'failed');
  assert.equal(started.brief.status, 'incomplete');
  assert.ok(started.warnings.some((warning) => /synthetic engine failure/.test(warning)));
  const failedBrief = await readBriefFile(engine.rootDir);
  assert.equal(failedBrief.header.generation, 'failed');
  assert.equal(failedBrief.header.status, 'incomplete');
  assert.match(failedBrief.body, /INCOMPLETE — the session brief could not be generated:.*synthetic engine failure/);
  assert.match(failedBrief.body, /sessions\/active\/ledger\/handoff\.md/);
  const inspection = await inspectLaneBrief({ rootDir: engine.rootDir, laneId: 'ledger' });
  assert.equal(inspection.stale, true, 'a failed generation is always stale');

  // The next resume retries and succeeds.
  const resumed = await continueProjectSession({ cwd: engine.workspace, rootDir: engine.rootDir, sessionId: 'ledger' });
  assert.equal(resumed.brief.state, 'regenerated');
  assert.equal((await readBriefFile(engine.rootDir)).header.generation, 'ok');

  // Write failure (brief.md cannot be replaced): a warning, no brief, and the
  // resume is still recorded.
  await rm(laneBriefPath(engine.rootDir, 'ledger'));
  await mkdir(path.join(laneBriefPath(engine.rootDir, 'ledger'), 'blocker'), { recursive: true });
  const blocked = await continueProjectSession({ cwd: engine.workspace, rootDir: engine.rootDir, sessionId: 'ledger' });
  assert.equal(blocked.resumeCount, 2);
  assert.equal(blocked.brief.state, 'failed');
  assert.equal(blocked.brief.status, null);
  assert.ok(blocked.warnings.some((warning) => /Session brief not written: .*The continue-session result is unaffected/.test(warning)));
  assert.match(await readFile(path.join(engine.rootDir, 'sessions', 'active', 'ledger', 'session.yaml'), 'utf8'), /^resume_count: 2$/m);

  // Existing lifecycle refusals still fail, and write no brief.
  await assert.rejects(startLane(engine.workspace, engine.rootDir), /already exists\. Resume it with `vibecompass continue-session ledger`/);
  await assert.rejects(continueProjectSession({ cwd: engine.workspace, rootDir: engine.rootDir, sessionId: 'nope' }), /is not an active lane/);
  await startLane(engine.workspace, engine.rootDir, { id: 'second', extra: { brief: false } });
  await assert.rejects(continueProjectSession({ cwd: engine.workspace, rootDir: engine.rootDir }), /Multiple active session lanes exist/);
  await assert.rejects(stat(laneBriefPath(engine.rootDir, 'nope')), { code: 'ENOENT' });
});

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

test('staleness is computed from the header bindings, and continue-session regenerates only a stale brief (D-364)', async (t) => {
  const { workspace, rootDir } = await makeWorkspace(t);
  await startLane(workspace, rootDir, { claims: ['app:src/lib/entitlements.ts'] });
  const check = () => inspectLaneBrief({ rootDir, laneId: 'ledger' });
  const resume = (extra = {}) => continueProjectSession({ cwd: workspace, rootDir, sessionId: 'ledger', ...extra });
  assert.deepEqual((await check()).reasons, []);

  // Resume bookkeeping (resumed_at, resume_count, the wip log) is not bound.
  const kept = await resume();
  assert.equal(kept.brief.state, 'kept');

  // Lane scratch: handoff.md bytes.
  const handoffPath = path.join(rootDir, 'sessions', 'active', 'ledger', 'handoff.md');
  await writeFile(handoffPath, `${await readFile(handoffPath, 'utf8')}\n- New reviewer note.\n`);
  assert.deepEqual((await check()).reasons, ['handoff.md changed']);
  const regenerated = await resume();
  assert.equal(regenerated.brief.state, 'regenerated');
  assert.deepEqual(regenerated.brief.staleReasons, ['handoff.md changed']);
  assert.equal((await check()).stale, false);

  // session.yaml fields the brief reads: a new working-on regenerates in the same resume.
  const refocused = await resume({ workingOn: 'Tax display for the Solo plan price' });
  assert.equal(refocused.brief.state, 'regenerated');
  assert.match(refocused.brief.staleReasons[0], /session\.yaml changed/);
  assert.match((await readBriefFile(rootDir)).body, /Task: Tax display for the Solo plan price/);

  // A bound canonical input changes: named.
  const { header } = await readBriefFile(rootDir);
  const boundDoc = header.inputs.map((line) => line.split(' ')[1]).find((key) => key.startsWith('architecture/'));
  assert.ok(boundDoc, 'the brief bound at least one architecture doc');
  await writeFile(path.join(rootDir, boundDoc), `${await readFile(path.join(rootDir, boundDoc), 'utf8')}\nOne more line.\n`);
  assert.match((await check()).reasons.join('\n'), new RegExp(`changed or removed input: ${boundDoc.replace(/[.]/g, '\\.')}`));
  await resume();

  // Unrelated canonical memory changes: the corpus digest catches it.
  await writeFile(path.join(rootDir, 'decisions', 'platform.md'), `${await readFile(path.join(rootDir, 'decisions', 'platform.md'), 'utf8')}\n### D-108 — Unrelated widget colors\n**Timestamp:** 2026-02-02 10:00 PST\n**Decision:** Widgets are teal.\n**Rationale:** Brand.\n`);
  const corpus = await check();
  assert.equal(corpus.stale, true);
  assert.ok(corpus.reasons.some((reason) => /other canonical memory changed|changed or removed input/.test(reason)));
  await resume();

  // project.yaml brief settings are canonical input too.
  await writeProjectYaml(rootDir, { brief: { enabled: true, exclude: ['architecture/sync/**'] }, tmpBase: path.join(workspace, 'lane-tmp') });
  assert.equal((await check()).stale, true);
  await resume();

  // Another lane opening changes this lane's watch-outs.
  await startLane(workspace, rootDir, { id: 'other', workingOn: 'Credential store', extra: { brief: false } });
  assert.deepEqual((await check()).reasons, ['the other active lanes changed']);

  // A hand-edited or foreign header is stale, never trusted.
  const briefFile = laneBriefPath(rootDir, 'ledger');
  await writeFile(briefFile, (await readFile(briefFile, 'utf8')).replace('brief_format: 1', 'brief_format: 99'));
  assert.match((await check()).reasons[0], /another format/);
  await writeFile(briefFile, '# no header\n');
  assert.match((await check()).reasons[0], /header is missing or unreadable/);
});

// ---------------------------------------------------------------------------
// Dual-root adapter
// ---------------------------------------------------------------------------

/**
 * A package-managed destination root (repo ids `acme-web` and `core`) and a
 * hand-maintained source root (the fixture corpus, repo ids `app` and
 * `core`) with the lane mirrored into it. `acme-web` shares `app`'s remote
 * but neither its id nor its remote basename, so only the adapter's
 * translation maps it.
 */
async function makeDualRoot(t, { destinationBrief = { enabled: true }, mirror = (session) => session, sourcePrefix = 'vibecompass-brief-src-' } = {}) {
  const destination = await makeWorkspace(t, {
    prefix: 'vibecompass-brief-dest-',
    brief: destinationBrief,
    repos: [
      { id: 'acme-web', remote: 'git@github.com:example/acme-app.git' },
      { id: 'core', remote: 'https://github.com/example/acme-core.git' },
    ],
  });
  // The destination's own corpus lacks the billing docs, so a brief that
  // shows them read the source; its remaining docs use its own repo ids.
  await rm(path.join(destination.rootDir, 'architecture', 'billing'), { recursive: true });
  for (const docPath of ['overview/project-shape.md', 'sync/credentials.md', 'sync/lanes.md']) {
    const full = path.join(destination.rootDir, 'architecture', docPath);
    await writeFile(full, (await readFile(full, 'utf8')).replace(/^  - app$/gm, '  - acme-web'));
  }
  const source = await makeWorkspace(t, { prefix: sourcePrefix });
  await startLane(destination.workspace, destination.rootDir, {
    claims: ['acme-web:src/lib/entitlements.ts'],
    repos: ['acme-web'],
    extra: { brief: false },
  });
  const laneDir = path.join(destination.rootDir, 'sessions', 'active', 'ledger');
  const mirrorDir = path.join(source.rootDir, 'sessions', 'active', 'ledger');
  await mkdir(mirrorDir, { recursive: true });
  for (const name of ['wip.md', 'handoff.md']) await cp(path.join(laneDir, name), path.join(mirrorDir, name));
  await writeFile(path.join(mirrorDir, 'session.yaml'), mirror(await readFile(path.join(laneDir, 'session.yaml'), 'utf8')));
  await cp(path.join(destination.rootDir, 'sessions', 'active', 'index.yaml'), path.join(source.rootDir, 'sessions', 'active', 'index.yaml'));
  return { destination, source };
}

test('the dual-root adapter reads the source root read-only, translates repo ids, and writes only the destination lane (D-255, D-364)', async (t) => {
  const { destination, source } = await makeDualRoot(t);
  const before = await snapshotTree(source.workspace);

  const resumed = await continueProjectSession({ cwd: destination.workspace, rootDir: destination.rootDir, sessionId: 'ledger', sourceRootDir: source.rootDir });
  assert.equal(resumed.brief.state, 'written');
  assert.equal(resumed.brief.source.adapter, true);
  const { header, body } = await readBriefFile(destination.rootDir);
  assert.equal(header.source_root, source.rootDir);
  assert.equal(header.destination_root, destination.rootDir);
  assert.equal(header.source_session, '2026-02-01-1');
  assert.deepEqual(header.repo_aliases, ['acme-web -> app', 'core -> core']);
  assert.match(body, /covers lane claim `acme-web:src\/lib\/entitlements\.ts` \(Involved files: `app:acme-app\/src\/lib\/entitlements\.ts`\)/, 'the destination repo id was translated to the source id');
  // Control: without the translation the claim matches nothing in the source.
  const untranslated = await buildSessionBrief({ rootDir: source.rootDir, laneId: 'ledger' });
  assert.ok(!renderBrief(untranslated).includes('covers lane claim'));

  // Explicit refresh and the freshness check against the same source.
  const cli = captureIo();
  assert.equal(await runCli(['brief', '--root', destination.rootDir, '--session', 'ledger', '--check', '--source-root', source.rootDir, '--json'], cli.io, { cwd: destination.workspace }), 0);
  assert.equal(JSON.parse(cli.stdout()).stale, false);
  cli.reset();
  assert.equal(await runCli(['brief', '--root', destination.rootDir, '--session', 'ledger', '--write', '--source-root', source.rootDir, '--source-session', 'ledger'], cli.io, { cwd: destination.workspace }), 0);
  assert.match(cli.stdout(), new RegExp(`^Brief: \\S+ — wrote .*ledger/brief\\.md from ${source.rootDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.equal((await continueProjectSession({ cwd: destination.workspace, rootDir: destination.rootDir, sessionId: 'ledger', sourceRootDir: source.rootDir })).brief.state, 'kept');

  // The source workspace is byte-identical: no lock, manifest, lane, stamp, or agent-file write.
  assert.deepEqual(await snapshotTree(source.workspace), before);

  // No implicit cross-root fallback: without --source-root the recorded source
  // is never read (it is unreadable here), and the brief is rebuilt from the
  // destination's own root.
  if (CAN_LOCK_FILES) await source.lock(source.rootDir);
  const own = await continueProjectSession({ cwd: destination.workspace, rootDir: destination.rootDir, sessionId: 'ledger' });
  assert.equal(own.brief.state, 'regenerated', JSON.stringify(own.brief));
  assert.match(own.brief.staleReasons[0], /the brief was built from .*, and this run reads/);
  const rebuilt = await readBriefFile(destination.rootDir);
  assert.equal(rebuilt.header.source_root, destination.rootDir);
  assert.equal(rebuilt.header.generation, 'ok');
});

test('the adapter refuses a source lane that does not correspond, without failing the resume (D-364)', async (t) => {
  // Different session number in the mirror.
  const renumbered = await makeDualRoot(t, { mirror: (session) => session.replace(/^session_number: 1$/m, 'session_number: 2') });
  const refused = await continueProjectSession({ cwd: renumbered.destination.workspace, rootDir: renumbered.destination.rootDir, sessionId: 'ledger', sourceRootDir: renumbered.source.rootDir });
  assert.equal(refused.resumeCount, 1, 'the resume itself succeeded');
  assert.equal(refused.brief.state, 'refused');
  assert.match(refused.brief.reason, /source lane is session ledger 2026-02-01-2 and the destination lane is session ledger 2026-02-01-1/);
  assert.ok(refused.warnings.some((warning) => /Session brief refused/.test(warning)));
  const { header, body } = await readBriefFile(renumbered.destination.rootDir);
  assert.equal(header.generation, 'failed');
  assert.match(body, /INCOMPLETE — the session brief could not be generated:\*\* the dual-root source was refused/);

  // A missing source lane, and a --source-session that names another lane.
  const { destination, source } = await makeDualRoot(t);
  await rm(path.join(source.rootDir, 'sessions', 'active', 'ledger'), { recursive: true });
  const missing = await continueProjectSession({ cwd: destination.workspace, rootDir: destination.rootDir, sessionId: 'ledger', sourceRootDir: source.rootDir });
  assert.equal(missing.brief.state, 'refused');
  assert.match(missing.brief.reason, /has no active lane "ledger"; mirror the lane there first/);
  const cli = captureIo();
  assert.equal(await runCli(['brief', '--root', destination.rootDir, '--session', 'ledger', '--write', '--source-root', source.rootDir, '--source-session', 'other'], cli.io, { cwd: destination.workspace }), 1);
  assert.match(cli.stdout(), /Brief: incomplete \(refused: .*--source-session "other" does not match the destination lane "ledger"/);
});

test('the adapter applies the union of both roots\' exclusions before reading the source (D-364)', async (t) => {
  const { destination, source } = await makeDualRoot(t, { destinationBrief: { enabled: true, exclude: ['architecture/billing/pricing.md'] } });
  if (CAN_LOCK_FILES) await source.lock(path.join(source.rootDir, 'architecture', 'billing', 'pricing.md'));
  const resumed = await continueProjectSession({ cwd: destination.workspace, rootDir: destination.rootDir, sessionId: 'ledger', sourceRootDir: source.rootDir });
  assert.equal(resumed.brief.state, 'written');
  const { header, body } = await readBriefFile(destination.rootDir);
  assert.deepEqual(header.exclude, ['architecture/billing/pricing.md']);
  assert.ok(!body.includes('pricing.md') && !header.inputs.some((line) => line.includes('pricing.md')));
  assert.equal((await inspectLaneBrief({ rootDir: destination.rootDir, laneId: 'ledger', sourceRootDir: source.rootDir })).stale, false);

  // A destination whose settings cannot be trusted fails closed before the source is read.
  await writeProjectYaml(destination.rootDir, { raw: ['brief:', '  exclude: "architecture/billing/pricing.md"'] });
  const generated = await generateLaneBrief({ rootDir: destination.rootDir, laneId: 'ledger', sourceRootDir: source.rootDir });
  assert.equal(generated.state, 'failed');
  assert.match(generated.reason, /destination root are invalid, so no canonical document was read/);
});

test('the recorded repo alias map and session identity are bindings: a change makes the brief stale (review R1)', async (t) => {
  const { destination, source } = await makeDualRoot(t);
  const resume = () => continueProjectSession({ cwd: destination.workspace, rootDir: destination.rootDir, sessionId: 'ledger', sourceRootDir: source.rootDir });
  const check = () => inspectLaneBrief({ rootDir: destination.rootDir, laneId: 'ledger', sourceRootDir: source.rootDir });
  await generateLaneBrief({ rootDir: destination.rootDir, laneId: 'ledger', sourceRootDir: source.rootDir });
  assert.match((await readBriefFile(destination.rootDir)).body, /covers lane claim `acme-web:/);
  assert.equal((await resume()).brief.state, 'kept', 'resume bookkeeping alone keeps the brief current');

  // A destination-only remote change removes the acme-web → app translation.
  // The source corpus is unchanged, so only the alias binding can see it.
  await writeProjectYaml(destination.rootDir, {
    brief: { enabled: true },
    repos: [
      { id: 'acme-web', remote: 'https://github.com/example/acme-web-v2.git' },
      { id: 'core', remote: 'https://github.com/example/acme-core.git' },
    ],
    tmpBase: path.join(destination.workspace, 'lane-tmp'),
  });
  assert.deepEqual((await check()).reasons, ['the repo alias map changed (a destination or source repo id or remote)']);
  const realiased = await resume();
  assert.equal(realiased.brief.state, 'regenerated');
  const { header, body } = await readBriefFile(destination.rootDir);
  assert.deepEqual(header.repo_aliases, ['acme-web -> (no match)', 'core -> core']);
  assert.doesNotMatch(body, /covers lane claim/, 'the claim no longer matches once the alias is gone');

  // Session identity: renumbering both lanes (correspondence still holds)
  // leaves every hashed field unchanged; only the identity binding sees it.
  for (const rootDir of [destination.rootDir, source.rootDir]) {
    const sessionPath = path.join(rootDir, 'sessions', 'active', 'ledger', 'session.yaml');
    await writeFile(sessionPath, (await readFile(sessionPath, 'utf8')).replace(/^session_number: 1$/m, 'session_number: 2'));
  }
  assert.deepEqual((await check()).reasons, ['the lane session identity changed (2026-02-01-1 → 2026-02-01-2)']);
  assert.equal((await resume()).brief.state, 'regenerated');
  assert.equal((await readBriefFile(destination.rootDir)).header.source_session, '2026-02-01-2');

  // An own-root lane with no usable identity is never current.
  const own = await makeWorkspace(t);
  await startLane(own.workspace, own.rootDir);
  const ownSession = path.join(own.rootDir, 'sessions', 'active', 'ledger', 'session.yaml');
  await writeFile(ownSession, (await readFile(ownSession, 'utf8')).replace(/^session_number: 1\n/m, ''));
  assert.ok((await inspectLaneBrief({ rootDir: own.rootDir, laneId: 'ledger' })).reasons.includes('the lane has no usable session identity (session_date and session_number)'));
});

test('a freshness check that cannot read the source replaces the old brief with a disclosed failure (review R2)', { skip: !CAN_LOCK_FILES }, async (t) => {
  const { destination, source } = await makeDualRoot(t);
  const resume = () => continueProjectSession({ cwd: destination.workspace, rootDir: destination.rootDir, sessionId: 'ledger', sourceRootDir: source.rootDir });
  await generateLaneBrief({ rootDir: destination.rootDir, laneId: 'ledger', sourceRootDir: source.rootDir });
  assert.equal((await readBriefFile(destination.rootDir)).header.generation, 'ok');

  const ledger = path.join(source.rootDir, 'architecture', 'billing', 'ledger.md');
  await chmod(ledger, 0o000);
  const inspection = await inspectLaneBrief({ rootDir: destination.rootDir, laneId: 'ledger', sourceRootDir: source.rootDir });
  assert.equal(inspection.stale, true);
  assert.match(inspection.reasons[0], /^freshness could not be checked: .*(EACCES|permission denied)/i);

  const blocked = await resume();
  assert.equal(blocked.resumeCount, 1, 'the resume still succeeds');
  assert.equal(blocked.brief.state, 'failed');
  assert.equal(blocked.brief.status, 'incomplete');
  const failed = await readBriefFile(destination.rootDir);
  assert.equal(failed.header.generation, 'failed', 'the old complete brief is replaced, not left looking usable');
  assert.equal(failed.header.status, 'incomplete');
  assert.match(failed.header.reason, /memory could not be read: .*(EACCES|permission denied)/i);
  assert.match(failed.body, /^\*\*INCOMPLETE — read these before planning:\*\*/m);

  await chmod(ledger, 0o644);
  const retried = await resume();
  assert.equal(retried.brief.state, 'regenerated');
  assert.equal((await readBriefFile(destination.rootDir)).header.generation, 'ok');

  // An unreadable source lane is refused through the same failure path.
  const sourceSession = path.join(source.rootDir, 'sessions', 'active', 'ledger', 'session.yaml');
  await chmod(sourceSession, 0o000);
  t.after(() => chmod(sourceSession, 0o644).catch(() => {}));
  const refused = await resume();
  assert.equal(refused.brief.state, 'refused');
  assert.match(refused.brief.reason, /the source could not be read: .*(EACCES|permission denied)/i);
  assert.equal((await readBriefFile(destination.rootDir)).header.generation, 'failed');
});

test('explicit refresh reports unreadable memory as a failed generation; budget overflow stays a successful incomplete brief (review R3)', async (t) => {
  // Invalid source settings under the adapter: exit 1, generation failed.
  const { destination, source } = await makeDualRoot(t);
  await writeProjectYaml(source.rootDir, { raw: ['brief:', '  excludes:', '    - "architecture/billing/pricing.md"'] });
  const cli = captureIo();
  assert.equal(await runCli(['brief', '--root', destination.rootDir, '--session', 'ledger', '--write', '--source-root', source.rootDir, '--json'], cli.io, { cwd: destination.workspace }), 1);
  const adapterResult = JSON.parse(cli.stdout());
  assert.equal(adapterResult.state, 'failed');
  assert.equal(adapterResult.status, 'incomplete');
  assert.match(adapterResult.reason, /memory could not be read: .*unknown field "brief\.excludes"/);
  const adapterBrief = await readBriefFile(destination.rootDir);
  assert.equal(adapterBrief.header.generation, 'failed');
  assert.match(adapterBrief.header.reason, /unknown field "brief\.excludes"/);

  // The same through the lifecycle: reported, never a failed resume.
  const resumed = await continueProjectSession({ cwd: destination.workspace, rootDir: destination.rootDir, sessionId: 'ledger', sourceRootDir: source.rootDir });
  assert.equal(resumed.resumeCount, 1);
  assert.equal(resumed.brief.state, 'failed');

  // Invalid settings in the lane's own root: exit 1 as well.
  const own = await makeWorkspace(t);
  await startLane(own.workspace, own.rootDir, { workingOn: 'Reconcile D-100, D-101, and D-104 before touching billing.' });
  cli.reset();
  assert.equal(await runCli(['brief', '--root', own.rootDir, '--session', 'ledger', '--write', '--budget', '800'], cli.io, { cwd: own.workspace }), 0);
  assert.match(cli.stdout(), /^Brief: incomplete — wrote /m, 'mandatory overflow is a successful generation with required reads');
  const overflow = await readBriefFile(own.rootDir);
  assert.equal(overflow.header.generation, 'ok');
  assert.equal(overflow.header.status, 'incomplete');
  assert.match(overflow.body, /^\*\*INCOMPLETE — read these before planning:\*\*/m);
  assert.equal((await inspectLaneBrief({ rootDir: own.rootDir, laneId: 'ledger' })).stale, false);

  await writeProjectYaml(own.rootDir, { raw: ['brief:', '  exclude: "architecture/billing/ledger.md"'], tmpBase: path.join(own.workspace, 'lane-tmp') });
  cli.reset();
  assert.equal(await runCli(['brief', '--root', own.rootDir, '--session', 'ledger', '--write'], cli.io, { cwd: own.workspace }), 1);
  assert.match(cli.stdout(), /^Brief: incomplete \(failed: memory could not be read: .*brief settings are invalid/m);
  assert.equal((await readBriefFile(own.rootDir)).header.generation, 'failed');
});

test('check and retry advice keeps the root, lane, and source explicit, quoted for the shell (review S2)', { skip: !CAN_LOCK_FILES || process.platform === 'win32' }, async (t) => {
  const { destination, source } = await makeDualRoot(t, { sourcePrefix: "vibecompass brief src o'q-" });
  await generateLaneBrief({ rootDir: destination.rootDir, laneId: 'ledger', sourceRootDir: source.rootDir });
  const quoted = `'${source.rootDir.replace(/'/g, `'\\''`)}'`;
  const { content } = await readBriefFile(destination.rootDir);
  assert.ok(content.includes(`# Check: vibecompass brief --root ${destination.rootDir} --session ledger --check --source-root ${quoted}\n`));
  assert.ok(content.includes(`# Refresh: vibecompass brief --root ${destination.rootDir} --session ledger --write --source-root ${quoted}\n`));

  // A refused source: the failure body, the warning, and the header all name the same command.
  const sourceSession = path.join(source.rootDir, 'sessions', 'active', 'ledger', 'session.yaml');
  await chmod(sourceSession, 0o000);
  t.after(() => chmod(sourceSession, 0o644).catch(() => {}));
  const resumed = await continueProjectSession({ cwd: destination.workspace, rootDir: destination.rootDir, sessionId: 'ledger', sourceRootDir: source.rootDir });
  const retry = `vibecompass brief --root ${destination.rootDir} --session ledger --write --source-root ${quoted}`;
  assert.ok(resumed.warnings.some((warning) => warning.includes(retry)), 'the lifecycle warning names the explicit retry');
  const failed = await readBriefFile(destination.rootDir);
  assert.ok(failed.body.includes(`Retry once the cause is fixed: \`${retry}\``));

  // The advice survives a real shell: it reaches the same lane and source.
  await chmod(sourceSession, 0o644);
  const command = retry.replace(/^vibecompass /, `'${process.execPath}' '${CLI_PATH}' `);
  const output = await new Promise((resolve, reject) => {
    execFile('/bin/sh', ['-c', command], { cwd: os.tmpdir() }, (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout)));
  });
  assert.match(output, /^Brief: \S+ — wrote .* from .*vibecompass brief src o'q-/m);
  assert.equal((await readBriefFile(destination.rootDir)).header.source_root, source.rootDir);
});

// ---------------------------------------------------------------------------
// CLI and read order
// ---------------------------------------------------------------------------

test('CLI: lifecycle brief lines, brief --write/--check, and flag validation (D-364)', async (t) => {
  const { workspace, rootDir } = await makeWorkspace(t);
  const cli = captureIo();
  assert.equal(await runCli(['start-session', '--root', rootDir, '--id', 'ledger', '--working-on', TASK, '--date', '2026-02-01'], cli.io, { cwd: workspace }), 0);
  assert.match(cli.stdout(), /^Brief: (complete|partial|incomplete|no-match) — .*sessions\/active\/ledger\/brief\.md$/m);
  cli.reset();
  assert.equal(await runCli(['start-session', '--root', rootDir, '--id', 'quiet', '--working-on', 'Quiet lane', '--date', '2026-02-01', '--no-brief'], cli.io, { cwd: workspace }), 0);
  assert.match(cli.stdout(), /^Brief: off \(--no-brief\)$/m);

  cli.reset();
  assert.equal(await runCli(['continue-session', '--root', rootDir, 'ledger'], cli.io, { cwd: workspace }), 0);
  assert.match(cli.stdout(), /^- .*ledger\/brief\.md \(session brief — read before planning\)$/m);
  assert.match(cli.stdout(), /^Brief: (current, kept|regenerated)/m);

  cli.reset();
  assert.equal(await runCli(['brief', '--root', rootDir, '--session', 'ledger', '--check'], cli.io, { cwd: workspace }), 0);
  assert.match(cli.stdout(), /^Brief: current \(status \S+, generated .*\) — .*ledger\/brief\.md$/m);
  cli.reset();
  assert.equal(await runCli(['brief', '--root', rootDir, '--session', 'quiet', '--check', '--json'], cli.io, { cwd: workspace }), 0);
  assert.deepEqual(
    (({ exists, stale, reasons }) => ({ exists, stale, reasons }))(JSON.parse(cli.stdout())),
    { exists: false, stale: true, reasons: ['no brief.md exists for this lane'] },
  );
  cli.reset();
  assert.equal(await runCli(['brief', '--root', rootDir, '--session', 'quiet', '--write', '--budget', '900', '--json'], cli.io, { cwd: workspace }), 0);
  assert.equal(JSON.parse(cli.stdout()).state, 'written');
  assert.equal((await readBriefFile(rootDir, 'quiet')).header.budget, 900);

  for (const [args, message] of [
    [['brief', '--write', '--check'], /Choose one of --write/],
    [['brief', '--write', '--task', 'x'], /--task cannot be combined with --write/],
    [['brief', '--check', '--budget', '900'], /--budget cannot be combined with --check/],
    [['brief', '--task', 'x', '--source-root', '../docs'], /apply only to --write or --check/],
    [['brief', '--write', '--source-session', 'ledger'], /--source-session requires --source-root/],
    [['continue-session', '--no-brief', '--source-root', '../docs'], /--no-brief cannot be combined/],
    [['brief', '--root', rootDir, '--write'], /Multiple active session lanes|needs an active lane/],
  ]) {
    await assert.rejects(runCli(args, captureIo().io, { cwd: workspace }), message);
  }
});

test('generated context.md, the managed agent block, and the wip template point at brief.md (D-359, D-364)', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-brief-readorder-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const rootDir = path.join(workspace, '.compass');
  await initializeProjectMemory({
    cwd: workspace,
    rootDir,
    name: 'Read Order',
    mode: 'local-only',
    repos: [{ id: 'docs', remote: 'https://github.com/example/docs.git' }],
    bootstrap: { workflow: true, claude: true },
  });
  const context = await readFile(path.join(rootDir, 'context.md'), 'utf8');
  assert.match(context, /^6\. If present, read `\.compass\/sessions\/active\/<lane-id>\/brief\.md` before planning/m);
  assert.match(context, /`\.compass\/sessions\/active\/<lane-id>\/brief\.md` — generated session brief/);
  assert.match(context, /## Reviewer input needed\n\n## Context used\n\n## Review log/);
  const claude = await readFile(path.join(workspace, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /^4\. If present, read the selected lane's `brief\.md` before planning/m);

  const started = await startProjectSession({ cwd: workspace, rootDir, sessionId: 'lane', workingOn: 'Read order', date: '2026-02-01', brief: false });
  const wip = await readFile(started.wipFilePath, 'utf8');
  assert.match(wip, /## Reviewer input needed\n- None yet\.\n\n## Context used\n- Optional: the docs and decisions this lane actually relied on/);
});
