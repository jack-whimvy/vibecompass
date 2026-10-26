import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { formatPlanTaskRef, parsePlanTaskLines, parsePlanTaskRef, resolvePlanTaskRefs, splitPlanTaskRef } from '../plan-tasks.js';

// D-393's task lines, read by PM6's validation (D-395).
const PLAN = [
  '---',
  'domain: Platform',
  '---',
  '',
  '## Description',
  '- [ ] XX1 — before the section, not a task',
  '',
  '## Next steps',
  '**Track A (bold labels are not tasks)**',
  '- [x] PM1 — Done, with a done line.',
  '  *Done 2026-10-21 (session 37).*',
  '- [ ] PM2 — Open:',
  '  - [ ] PM9 — a nested checkbox is a subtask, not a task',
  '  - a nested bullet',
  '- plain bullet, no checkbox',
  '- [ ] Keep the docs current (no ID, not a task)',
  '- [ ] pm3 — lowercase is not an ID',
  '- [ ] PM4 - a hyphen is not the em dash',
  '- [X] PM5 — an uppercase X is not D-393\'s tick',
  '```md',
  '- [ ] PM8 — inside a fence, not a task',
  '## Involved files',
  '```',
  '- [ ] DOC12 — after the fence, still in the section',
  '',
  '### A level-3 heading stays inside the section',
  '- [ ] ABCDEF123 — the longest ID shape',
  '',
  '## Involved files',
  '- [ ] PM7 — after the section, not a task',
  '',
  '## Next steps',
  '- [ ] PM6 — a second Next steps section is ignored; the first wins',
  '',
].join('\n');

test('parsePlanTaskLines reads only top-level D-393 task lines in the first ## Next steps, outside fences (D-393)', () => {
  const parsed = parsePlanTaskLines(PLAN);
  assert.equal(parsed.hasNextSteps, true);
  assert.deepEqual(
    parsed.tasks.map((task) => [task.id, task.ticked]),
    [['PM1', true], ['PM2', false], ['DOC12', false], ['ABCDEF123', false]],
  );
  assert.equal(parsed.tasks[1].scope, 'Open:');
  assert.equal(parsed.tasks[0].lineNumber, 10);

  // CRLF files parse the same way.
  assert.deepEqual(parsePlanTaskLines(PLAN.replace(/\n/g, '\r\n')).tasks.map((task) => task.id), ['PM1', 'PM2', 'DOC12', 'ABCDEF123']);

  assert.deepEqual(parsePlanTaskLines('## Description\n- [ ] PM1 — no Next steps here\n'), { hasNextSteps: false, tasks: [] });
  assert.deepEqual(parsePlanTaskLines('## Next steps\n- [ ] Keep it current\n'), { hasNextSteps: true, tasks: [] });
  // A ## Next steps heading inside a fence is content, not the section.
  assert.equal(parsePlanTaskLines('```\n## Next steps\n- [ ] PM1 — x\n```\n').hasNextSteps, false);
});

test('parsePlanTaskRef checks the ref shape and returns the canonical root-relative form (D-395)', () => {
  assert.deepEqual(parsePlanTaskRef('architecture/plans/plan.md#PM3'), { plan: 'architecture/plans/plan.md', id: 'PM3', ref: 'architecture/plans/plan.md#PM3' });
  // `.` segments, doubled slashes, backslashes, and surrounding spaces normalize away.
  assert.equal(parsePlanTaskRef(' ./architecture//plans\\plan.md#PM3 ').ref, 'architecture/plans/plan.md#PM3');

  const refusals = [
    ['', /--plan-task needs a reference/],
    ['architecture/plans/plan.md', /has no #<ID>/],
    ['#PM3', /names no plan before #PM3/],
    ['/root/architecture/plan.md#PM3', /must be relative to the project-memory root/],
    ['C:\\root\\architecture\\plan.md#PM3', /must be relative to the project-memory root/],
    ['architecture/../decisions/x.md#PM3', /must stay inside the project-memory root; "\.\." isn't allowed/],
    ['decisions/cross-cutting.md#PM3', /decisions\/cross-cutting\.md is outside architecture\//],
    ['architecture.md#PM3', /is outside architecture\//],
    ['architecture/plans/plan.txt#PM3', /is not a \.md file/],
    ['architecture/plans/plan.md#pm3', /"pm3" isn't a task ID/],
    ['architecture/plans/plan.md#PM-3', /"PM-3" isn't a task ID/],
    ['architecture/plans/plan.md#R1.1', /"R1\.1" isn't a task ID/],
    ['architecture/plans/plan.md#ABCDEFG1', /"ABCDEFG1" isn't a task ID/],
    ['architecture/plans/plan.md#PM1234', /"PM1234" isn't a task ID/],
    ['architecture/plans/plan.md#', /"" isn't a task ID/],
  ];
  for (const [value, pattern] of refusals) {
    assert.throws(() => parsePlanTaskRef(value), pattern, value);
  }
});

test('splitPlanTaskRef and formatPlanTaskRef round-trip a stored ref, and keep a hand-edited value without # (D-395)', () => {
  assert.deepEqual(splitPlanTaskRef('architecture/a.md#PM3'), { plan: 'architecture/a.md', id: 'PM3' });
  assert.equal(formatPlanTaskRef(splitPlanTaskRef('architecture/a.md#PM3')), 'architecture/a.md#PM3');
  assert.deepEqual(splitPlanTaskRef('hand-edited'), { plan: 'hand-edited', id: null });
  assert.equal(formatPlanTaskRef(splitPlanTaskRef('hand-edited')), 'hand-edited');
});

test('resolvePlanTaskRefs validates against the root: the file, its ## Next steps, and the task line (D-395)', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-plan-tasks-'));

  try {
    await mkdir(path.join(rootDir, 'architecture/plans/folder.md'), { recursive: true });
    await writeFile(path.join(rootDir, 'architecture/plans/plan.md'), PLAN, 'utf8');
    await writeFile(path.join(rootDir, 'architecture/plans/prose.md'), '## Description\nTasks in prose only.\n', 'utf8');
    await writeFile(path.join(rootDir, 'architecture/plans/dup.md'), '## Next steps\n- [ ] PM1 — one\n- [x] PM1 — two\n', 'utf8');
    await mkdir(path.join(rootDir, 'outside'), { recursive: true });
    await writeFile(path.join(rootDir, 'outside/plan.md'), PLAN, 'utf8');
    await symlink(path.join(rootDir, 'outside/plan.md'), path.join(rootDir, 'architecture/plans/linked.md'));

    const resolved = await resolvePlanTaskRefs({
      rootDir,
      refs: ['architecture/plans/plan.md#PM2', 'architecture/plans/plan.md#PM1', './architecture/plans/plan.md#PM2'],
    });
    assert.deepEqual(resolved.tasks.map((task) => [task.ref, task.ticked]), [
      ['architecture/plans/plan.md#PM2', false],
      ['architecture/plans/plan.md#PM1', true],
    ]);
    assert.equal(resolved.warnings.length, 1);
    assert.match(resolved.warnings[0], /^--plan-task "architecture\/plans\/plan\.md#PM1" names a ticked task: PM1 is marked done in architecture\/plans\/plan\.md\. The link is kept/);

    assert.deepEqual(await resolvePlanTaskRefs({ rootDir, refs: [] }), { tasks: [], warnings: [] });

    const duplicate = await resolvePlanTaskRefs({ rootDir, refs: ['architecture/plans/dup.md#PM1'] });
    assert.equal(duplicate.tasks[0].ticked, false, 'the first task line wins');
    assert.match(duplicate.warnings[0], /has 2 task lines for PM1 \(lines 2, 3\); an ID is unique within its plan/);

    const refusals = [
      ['architecture/plans/missing.md#PM1', /architecture\/plans\/missing\.md doesn't exist in the project-memory root/],
      ['architecture/plans/plan.md/x.md#PM1', /doesn't exist in the project-memory root/],
      ['architecture/plans/folder.md#PM1', /architecture\/plans\/folder\.md is not a file/],
      ['architecture/plans/prose.md#PM1', /architecture\/plans\/prose\.md has no ## Next steps section, so it holds no task lines/],
      ['architecture/plans/plan.md#PM9', /has no task line for PM9 under ## Next steps\. Its task IDs: PM1, PM2, DOC12, ABCDEF123\./],
      ['architecture/plans/plan.md#PM7', /has no task line for PM7 under ## Next steps/],
      ['architecture/plans/linked.md#PM1', /architecture\/plans\/linked\.md resolves outside the root's architecture\//],
    ];
    for (const [ref, pattern] of refusals) {
      await assert.rejects(resolvePlanTaskRefs({ rootDir, refs: ['architecture/plans/plan.md#PM2', ref] }), pattern, ref);
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
