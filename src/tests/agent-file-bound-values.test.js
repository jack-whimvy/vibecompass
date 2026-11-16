import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeProjectMemory } from '../init.js';
import { runCli } from '../cli.js';
import { refreshWorkflow } from '../refresh-workflow.js';
import { syncAgentInstructionFiles } from '../generators/agent-files/index.js';
import { applyBoundValues } from '../generators/agent-files/bound-values.js';
import { END_MARKER, START_MARKER } from '../generators/agent-files/markers.js';
import { closeProjectSession, continueProjectSession, startProjectSession, switchProjectSession } from '../session.js';

// Lifecycle commands write an agent file's bound values (the memory root's
// path, the project name, the Project Snapshot) and create a missing file, but
// change no other line of an existing managed block; refresh-workflow and
// sync-agents still write the whole block (D-411 item 3).

const AGENT_FILES = ['CLAUDE.md', 'AGENTS.md', '.cursorrules', '.github/copilot-instructions.md'];
const CURRENT_LINE = '- Keep the selected lane `wip.md` and `handoff.md` current during active builder/reviewer work.';
const OLDER_LINE = '- An instruction line as an older package wrote it.';
const CLOSE_DEFAULTS = {
  completed: ['Did the work'],
  nextSteps: ['Continue'],
  documentMaintenance: { architectureDocs: 'not-needed', decisionLog: 'not-needed', sessionMaintenance: 'not-needed' },
};

async function createWorkspace(parentDir, name = 'Bound Values Test') {
  await mkdir(parentDir, { recursive: true });
  const rootDir = path.join(parentDir, '.compass');
  await initializeProjectMemory({
    cwd: parentDir,
    rootDir,
    name,
    mode: 'local-only',
    repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
    bootstrap: { workflow: true, claude: true },
  });
  return rootDir;
}

// Stand-in for a block an older package installed: one instruction line differs.
async function ageBlocks(workspaceDir, files = AGENT_FILES) {
  for (const file of files) {
    const filePath = path.join(workspaceDir, file);
    const content = await readFile(filePath, 'utf8');
    assert.ok(content.includes(CURRENT_LINE), `${file} carries the current line`);
    await writeFile(filePath, content.replace(CURRENT_LINE, OLDER_LINE), 'utf8');
  }
}

async function readBlock(workspaceDir, file) {
  const content = await readFile(path.join(workspaceDir, file), 'utf8');
  return content.slice(content.indexOf(START_MARKER), content.indexOf(END_MARKER) + END_MARKER.length);
}

function byFile(result) {
  return Object.fromEntries(result.agentFileSync.results.map((item) => [item.relativePath, item]));
}

test('start, continue, switch, and close keep an existing block\'s instructions and write only its bound values', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-bound-lifecycle-'));
  try {
    const rootDir = await createWorkspace(tempDir);
    await startProjectSession({ cwd: tempDir, sessionId: 'lane-a', workingOn: 'A' });
    await startProjectSession({ cwd: tempDir, sessionId: 'lane-b', workingOn: 'B' });
    await ageBlocks(tempDir);

    const continued = await continueProjectSession({ cwd: tempDir, rootDir, sessionId: 'lane-a' });
    const switched = await switchProjectSession({ cwd: tempDir, rootDir, sessionId: 'lane-b' });
    const started = await startProjectSession({ cwd: tempDir, sessionId: 'lane-c', workingOn: 'C' });
    for (const result of [continued, switched, started]) {
      for (const file of AGENT_FILES) {
        assert.equal(byFile(result)[file].status, 'unchanged', `${file} after a lifecycle command`);
        assert.equal(byFile(result)[file].instructionsCurrent, false, `${file} reports instructions that differ`);
      }
    }

    const closed = await closeProjectSession({ cwd: tempDir, sessionId: 'lane-c', title: 'Bound Values Close', ...CLOSE_DEFAULTS });
    for (const file of AGENT_FILES) {
      const block = await readBlock(tempDir, file);
      assert.ok(block.includes(OLDER_LINE), `${file} keeps the older instruction line`);
      assert.ok(!block.includes(CURRENT_LINE), `${file} did not get the running package's line`);
      assert.ok(block.includes('- Latest session: Bound Values Close'), `${file} got the new latest session`);
      assert.equal(byFile(closed)[file].status, 'update');
      assert.equal(byFile(closed)[file].instructionsCurrent, false);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('the CLI says when a block\'s instructions differ and names the explicit refresh', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-bound-cli-'));
  try {
    const rootDir = await createWorkspace(tempDir);
    await startProjectSession({ cwd: tempDir, sessionId: 'lane-a', workingOn: 'A' });
    await ageBlocks(tempDir, ['CLAUDE.md']);
    const out = [];
    const io = { stdout: { write: (chunk) => out.push(chunk) }, stderr: { write() {} } };
    assert.equal(await runCli(['continue-session', '--root', rootDir, 'lane-a'], io, { cwd: tempDir }), 0);
    const text = out.join('');
    assert.match(text, /- CLAUDE\.md: unchanged\n {2}its managed instructions differ from this package's; they change only through `vibecompass refresh-workflow` \(run --dry-run first, then --apply\) or `vibecompass sync-agents`\.\n/);
    assert.match(text, /- AGENTS\.md: unchanged\n- /, 'a current block gets no note');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('refresh-workflow --apply and sync-agents still write the whole block', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-bound-refresh-'));
  try {
    const rootDir = await createWorkspace(tempDir);
    await startProjectSession({ cwd: tempDir, sessionId: 'lane-a', workingOn: 'A' });

    await ageBlocks(tempDir);
    const dryRun = await refreshWorkflow({ cwd: tempDir, rootDir });
    assert.ok(dryRun.agentFileSync.results.every((item) => item.status === 'dry-run-update'), 'the dry run previews each block');
    assert.ok((await readBlock(tempDir, 'CLAUDE.md')).includes(OLDER_LINE), 'the dry run wrote nothing');
    await refreshWorkflow({ cwd: tempDir, rootDir, apply: true });
    for (const file of AGENT_FILES) {
      assert.ok((await readBlock(tempDir, file)).includes(CURRENT_LINE), `${file} after refresh-workflow --apply`);
    }

    await ageBlocks(tempDir);
    const io = { stdout: { write() {} }, stderr: { write() {} } };
    assert.equal(await runCli(['sync-agents', '--root', rootDir], io, { cwd: tempDir }), 0);
    for (const file of AGENT_FILES) {
      assert.ok((await readBlock(tempDir, file)).includes(CURRENT_LINE), `${file} after sync-agents`);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('a moved root and a renamed project update the block\'s paths and heading at the next lifecycle command, and nothing else', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-bound-move-'));
  try {
    const oldWorkspace = path.join(tempDir, 'old-place');
    const oldRoot = await createWorkspace(oldWorkspace, 'Before Rename');
    await startProjectSession({ cwd: oldWorkspace, sessionId: 'lane-a', workingOn: 'A' });
    await ageBlocks(oldWorkspace, ['AGENTS.md']);
    assert.ok((await readBlock(oldWorkspace, 'CLAUDE.md')).includes(`\`${oldRoot}/context.md\``));

    const newWorkspace = path.join(tempDir, 'new-place');
    await rename(oldWorkspace, newWorkspace);
    const newRoot = path.join(newWorkspace, '.compass');
    const projectFile = path.join(newRoot, 'project.yaml');
    const projectYaml = await readFile(projectFile, 'utf8');
    assert.match(projectYaml, /^name: "?Before Rename"?$/m);
    await writeFile(projectFile, projectYaml.replace(/^name: .*$/m, 'name: "After Rename"'), 'utf8');

    const continued = await continueProjectSession({ cwd: newWorkspace, rootDir: newRoot, sessionId: 'lane-a' });

    for (const file of AGENT_FILES) {
      const block = await readBlock(newWorkspace, file);
      assert.ok(!block.includes(oldWorkspace), `${file} names no old path`);
      assert.ok(block.includes(`\`${newRoot}/context.md\``), `${file} reads context.md from the new root`);
      assert.ok(block.includes(`- Project memory root: \`${newRoot}\``), `${file} snapshot names the new root`);
      assert.ok(block.includes('# After Rename '), `${file} heading carries the new name`);
      assert.ok(!block.includes('Before Rename'), `${file} keeps no old name`);
    }
    assert.ok((await readBlock(newWorkspace, 'AGENTS.md')).includes(OLDER_LINE), 'the older instruction line stays');
    assert.equal(byFile(continued)['AGENTS.md'].instructionsCurrent, false);
    assert.equal(byFile(continued)['CLAUDE.md'].instructionsCurrent, true, 'only bound values differed, so the block now matches');

    // The whole-block writer finds nothing left to change in a block whose
    // only difference was its bound values.
    const inspect = await syncAgentInstructionFiles({ cwd: newWorkspace, rootDir: newRoot, dryRun: true });
    const status = Object.fromEntries(inspect.results.map((item) => [item.relativePath, item.status]));
    assert.equal(status['CLAUDE.md'], 'unchanged');
    assert.equal(status['AGENTS.md'], 'dry-run-update');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('a missing enabled file is created whole, and a file without markers is left alone with a warning', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-bound-missing-'));
  try {
    const rootDir = await createWorkspace(tempDir);
    await startProjectSession({ cwd: tempDir, sessionId: 'lane-a', workingOn: 'A' });
    await rm(path.join(tempDir, 'AGENTS.md'));
    await writeFile(path.join(tempDir, '.cursorrules'), 'My own rules.\n', 'utf8');

    const continued = await continueProjectSession({ cwd: tempDir, rootDir, sessionId: 'lane-a' });

    assert.equal(byFile(continued)['AGENTS.md'].status, 'create');
    assert.ok((await readBlock(tempDir, 'AGENTS.md')).includes(CURRENT_LINE));
    assert.equal(byFile(continued)['.cursorrules'].status, 'warning');
    assert.match(byFile(continued)['.cursorrules'].warning, /no VibeCompass managed markers/);
    assert.equal(await readFile(path.join(tempDir, '.cursorrules'), 'utf8'), 'My own rules.\n');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('applyBoundValues keeps every byte outside the bound values, CRLF endings included, and leaves a block with no snapshot section to the refresh', () => {
  const generated = [
    '# New Name Claude Instructions',
    '',
    'Read `/new/root/context.md`.',
    '',
    '## Project Snapshot',
    '- Project memory root: `/new/root`',
    '- Latest session: Two',
    '',
    '## Read Order',
    '1. Read `/new/root/context.md`.',
  ].join('\n');
  const before = 'Preface kept.\r\n\r\n';
  const after = '\r\nTrailer kept.\r\n';
  const block = [
    '',
    '# Old Name Claude Instructions',
    '',
    'Read `/old/root/context.md`. Older wording; `/old/rooted` is another path.',
    '',
    '## Project Snapshot',
    '- Project memory root: `/old/root`',
    '- Latest session: One',
    '',
    '## Read Order',
    '1. Read `/old/root/context.md`.',
    '',
  ].join('\r\n');
  const existing = `${before}${START_MARKER}${block}${END_MARKER}${after}`;

  const applied = applyBoundValues(existing, generated, { projectName: 'New Name' });

  assert.equal(applied.content, `${before}${START_MARKER}${[
    '',
    '# New Name Claude Instructions',
    '',
    'Read `/new/root/context.md`. Older wording; `/old/rooted` is another path.',
    '',
    '## Project Snapshot',
    '- Project memory root: `/new/root`',
    '- Latest session: Two',
    '',
    '## Read Order',
    '1. Read `/new/root/context.md`.',
    '',
  ].join('\r\n')}${END_MARKER}${after}`);
  assert.equal(applied.instructionsCurrent, false);

  const noSnapshot = `${START_MARKER}\n# Old Name Claude Instructions\n\nNo snapshot here.\n${END_MARKER}\n`;
  const kept = applyBoundValues(noSnapshot, generated, { projectName: 'New Name' });
  assert.equal(kept.content, `${START_MARKER}\n# New Name Claude Instructions\n\nNo snapshot here.\n${END_MARKER}\n`);
  assert.equal(kept.instructionsCurrent, false);

  const otherHeading = `${START_MARKER}\n# Old Name Agent Rules\n\n## Project Snapshot\n- Latest session: One\n\n## Read Order\n${END_MARKER}\n`;
  assert.ok(applyBoundValues(otherHeading, generated, { projectName: 'New Name' }).content.includes('# Old Name Agent Rules'), 'a heading with other words is the refresh\'s');
});
