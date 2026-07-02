import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeProjectMemory } from '../init.js';
import { runCli } from '../cli.js';
import { closeProjectSession, rebuildActiveSessionIndex, startProjectSession } from '../session.js';
import { appendDecisionEntry, findDuplicateDecisionIds, readNextDecisionId } from '../decisions.js';
import { MemoryRootLockError, memoryRootLockPath, withMemoryRootLock } from '../serialization.js';

const DOCUMENT_MAINTENANCE_UPDATED = {
  architectureDocs: 'updated',
  decisionLog: 'updated',
  sessionMaintenance: 'updated',
};

async function createInitializedRoot(prefix) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const rootDir = path.join(tempDir, '.compass');
  await initializeProjectMemory({
    cwd: tempDir,
    rootDir,
    name: 'Serialization Test',
    mode: 'local-only',
    repos: [{ id: 'docs', remote: 'https://github.com/example/docs.git' }],
    bootstrap: {
      workflow: true,
      claude: true,
    },
  });
  await writeFile(
    path.join(rootDir, 'decisions', 'cross-cutting.md'),
    '# Cross-cutting decisions\n\n### D-001 — Seed decision\n**Timestamp:** 2026-04-20 09:00 PDT\n**Decision:** Seed the domain file for tests.\n**Rationale:** Allocation scans need at least one canonical entry.\n',
    'utf8',
  );
  return { tempDir, rootDir };
}

function stagedEntry(title) {
  return [
    `### D-NEXT — ${title}`,
    '**Timestamp:** 2026-07-02 00:00 PDT',
    `**Decision:** ${title}.`,
    '**Rationale:** Racing test entry.',
  ].join('\n');
}

test('withMemoryRootLock serializes concurrent same-process writers', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-lock-serial-');

  try {
    const order = [];
    await Promise.all([
      withMemoryRootLock(rootDir, 'test-a', async () => {
        order.push('a-start');
        await new Promise((resolve) => setTimeout(resolve, 40));
        order.push('a-end');
      }),
      withMemoryRootLock(rootDir, 'test-b', async () => {
        order.push('b-start');
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push('b-end');
      }),
    ]);

    const first = order[0][0];
    const expected = first === 'a'
      ? ['a-start', 'a-end', 'b-start', 'b-end']
      : ['b-start', 'b-end', 'a-start', 'a-end'];
    assert.deepEqual(order, expected);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('withMemoryRootLock is reentrant for nested calls', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-lock-reentrant-');

  try {
    const result = await withMemoryRootLock(rootDir, 'outer', () =>
      withMemoryRootLock(rootDir, 'inner', async () => 'nested-ok'),
    );
    assert.equal(result, 'nested-ok');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('withMemoryRootLock recovers a stale lock left by a dead process', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-lock-stale-');

  try {
    const lockDir = memoryRootLockPath(rootDir);
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      path.join(lockDir, 'owner.json'),
      `${JSON.stringify({ pid: 999999999, label: 'dead-process', acquired_at: '2026-01-01T00:00:00.000Z' })}\n`,
      'utf8',
    );

    const result = await withMemoryRootLock(rootDir, 'recovering', async () => 'recovered');
    assert.equal(result, 'recovered');
    await assert.rejects(stat(lockDir), { code: 'ENOENT' });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('withMemoryRootLock times out with an actionable error while the lock is held live', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-lock-timeout-');

  try {
    const lockDir = memoryRootLockPath(rootDir);
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      path.join(lockDir, 'owner.json'),
      `${JSON.stringify({ pid: process.pid, label: 'live-holder', acquired_at: new Date().toISOString() })}\n`,
      'utf8',
    );

    await assert.rejects(
      withMemoryRootLock(rootDir, 'blocked', async () => 'unreachable', { attempts: 2, staleMs: 60_000 }),
      (error) => {
        assert.ok(error instanceof MemoryRootLockError);
        assert.match(error.message, /live-holder/);
        assert.match(error.message, /remove the lock directory/);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('concurrent start-session calls leave a consistent index and uncorrupted managed files', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-race-start-');

  try {
    await Promise.all([
      startProjectSession({
        cwd: tempDir,
        rootDir,
        sessionId: 'lane-alpha',
        workingOn: 'Alpha work.',
        date: '2026-04-20',
      }),
      startProjectSession({
        cwd: tempDir,
        rootDir,
        sessionId: 'lane-beta',
        workingOn: 'Beta work.',
        date: '2026-04-20',
      }),
    ]);

    const index = await readFile(path.join(rootDir, 'sessions', 'active', 'index.yaml'), 'utf8');
    assert.match(index, /lane-alpha/);
    assert.match(index, /lane-beta/);
    assert.match(index, /^current: lane-(alpha|beta)$/m);

    const claude = await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8');
    const currentBlocks = claude.match(/^Date: /gm) ?? [];
    assert.equal(currentBlocks.length, 1, 'CLAUDE.md must contain exactly one Current-session date line');

    const manifest = JSON.parse(await readFile(path.join(rootDir, 'state', 'manifest.json'), 'utf8'));
    assert.equal(manifest.active_sessions.lanes.length, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('concurrent appendDecisionEntry calls allocate unique sequential D-numbers', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-race-decisions-');

  try {
    const before = await readNextDecisionId(rootDir);
    const results = await Promise.all([
      appendDecisionEntry({ rootDir, target: 'cross-cutting.md', entryContent: stagedEntry('Racing decision one') }),
      appendDecisionEntry({ rootDir, target: 'cross-cutting.md', entryContent: stagedEntry('Racing decision two') }),
      appendDecisionEntry({ rootDir, target: 'cross-cutting.md', entryContent: stagedEntry('Racing decision three') }),
      appendDecisionEntry({ rootDir, target: 'cross-cutting.md', entryContent: stagedEntry('Racing decision four') }),
    ]);

    const ids = results.map((result) => result.decisionId).sort((left, right) => left - right);
    assert.deepEqual(ids, [before, before + 1, before + 2, before + 3]);

    const duplicates = await findDuplicateDecisionIds(rootDir);
    assert.deepEqual(duplicates, []);

    const content = await readFile(path.join(rootDir, 'decisions', 'cross-cutting.md'), 'utf8');
    for (const id of ids) {
      assert.match(content, new RegExp(`^### D-${String(id).padStart(3, '0')} — Racing decision`, 'm'));
    }
    assert.doesNotMatch(content, /D-NEXT/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('appendDecisionEntry allocates after a hand-appended decision (write-time allocation)', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-hand-append-');

  try {
    const handId = await readNextDecisionId(rootDir);
    const targetPath = path.join(rootDir, 'decisions', 'cross-cutting.md');
    const existing = await readFile(targetPath, 'utf8');
    await writeFile(
      targetPath,
      `${existing}\n---\n\n### D-${String(handId).padStart(3, '0')} — Hand-appended decision\n**Timestamp:** 2026-07-02 00:00 PDT\n**Decision:** Hand write.\n**Rationale:** Transition path.\n`,
      'utf8',
    );

    const result = await appendDecisionEntry({
      rootDir,
      target: 'cross-cutting.md',
      entryContent: stagedEntry('Mediated after hand append'),
    });
    assert.equal(result.decisionId, handId + 1);
    assert.deepEqual(await findDuplicateDecisionIds(rootDir), []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('appendDecisionEntry rejects entries without the D-NEXT placeholder and bad targets', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-append-validation-');

  try {
    await assert.rejects(
      appendDecisionEntry({ rootDir, target: 'cross-cutting.md', entryContent: '### D-300 — Pre-assigned' }),
      /D-NEXT/,
    );
    await assert.rejects(
      appendDecisionEntry({ rootDir, target: 'INDEX.md', entryContent: stagedEntry('Bad target') }),
      /Invalid decision target/,
    );
    await assert.rejects(
      appendDecisionEntry({ rootDir, target: 'missing-domain.md', entryContent: stagedEntry('Missing domain') }),
      /does not exist/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('closeProjectSession fails closed on duplicate decision IDs', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-dup-block-');

  try {
    await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'dup-lane',
      workingOn: 'Duplicate detection.',
      date: '2026-04-20',
    });

    const targetPath = path.join(rootDir, 'decisions', 'cross-cutting.md');
    const existing = await readFile(targetPath, 'utf8');
    const dupId = (await readNextDecisionId(rootDir)) - 1 || 1;
    await writeFile(
      targetPath,
      `${existing}\n---\n\n### D-${String(dupId).padStart(3, '0')} — Duplicate entry\n**Decision:** Collision.\n`,
      'utf8',
    );

    await assert.rejects(
      closeProjectSession({
        cwd: tempDir,
        rootDir,
        title: 'Duplicate Block',
        completed: ['Attempted close with duplicates.'],
        documentMaintenance: DOCUMENT_MAINTENANCE_UPDATED,
        nextSteps: ['Repair duplicates.'],
      }),
      (error) => {
        assert.match(error.message, /duplicate decision IDs/i);
        assert.match(error.message, new RegExp(`D-${String(dupId).padStart(3, '0')}`));
        assert.match(error.message, /never auto-renumbered/);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('rebuildActiveSessionIndex restores a deleted index and validates current selection', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-rebuild-index-');

  try {
    await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'lane-one',
      workingOn: 'First lane.',
      date: '2026-04-20',
    });
    await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'lane-two',
      workingOn: 'Second lane.',
      date: '2026-04-20',
    });

    const indexPath = path.join(rootDir, 'sessions', 'active', 'index.yaml');
    await rm(indexPath, { force: true });

    await assert.rejects(
      rebuildActiveSessionIndex({ cwd: tempDir, rootDir }),
      /explicit --current/,
    );

    await assert.rejects(
      rebuildActiveSessionIndex({ cwd: tempDir, rootDir, current: 'lane-missing' }),
      /does not exist/,
    );

    const rebuilt = await rebuildActiveSessionIndex({ cwd: tempDir, rootDir, current: 'lane-two' });
    assert.equal(rebuilt.current, 'lane-two');
    assert.equal(rebuilt.lanes.length, 2);

    const index = await readFile(indexPath, 'utf8');
    assert.match(index, /^current: lane-two$/m);
    assert.match(index, /lane-one/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('withMemoryRootLock never steals a lock held by a live process, regardless of age', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-lock-nosteal-');

  try {
    const lockDir = memoryRootLockPath(rootDir);
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      path.join(lockDir, 'owner.json'),
      `${JSON.stringify({ pid: process.pid, token: 'foreign-token', label: 'long-runner', acquired_at: '2026-01-01T00:00:00.000Z' })}\n`,
      'utf8',
    );

    await assert.rejects(
      withMemoryRootLock(rootDir, 'blocked', async () => 'unreachable', { attempts: 3, staleMs: 1 }),
      (error) => {
        assert.ok(error instanceof MemoryRootLockError);
        assert.match(error.message, /live pid/);
        assert.match(error.message, /never stolen/);
        return true;
      },
    );

    const owner = JSON.parse(await readFile(path.join(lockDir, 'owner.json'), 'utf8'));
    assert.equal(owner.token, 'foreign-token', 'the live holder lock must remain untouched');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('release leaves a foreign lock in place (token compare)', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-lock-foreign-release-');

  try {
    const lockDir = memoryRootLockPath(rootDir);
    await withMemoryRootLock(rootDir, 'swapper', async () => {
      await rm(lockDir, { recursive: true, force: true });
      await mkdir(lockDir, { recursive: true });
      await writeFile(
        path.join(lockDir, 'owner.json'),
        `${JSON.stringify({ pid: process.pid, token: 'someone-else', label: 'foreign', acquired_at: new Date().toISOString() })}\n`,
        'utf8',
      );
    });

    const owner = JSON.parse(await readFile(path.join(lockDir, 'owner.json'), 'utf8'));
    assert.equal(owner.token, 'someone-else', 'release must not delete a lock it does not own');
    await rm(lockDir, { recursive: true, force: true });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('cross-process waiters reclaim an abandoned lock without double-holding', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-lock-xproc-');

  try {
    const lockDir = memoryRootLockPath(rootDir);
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      path.join(lockDir, 'owner.json'),
      `${JSON.stringify({ pid: 999999999, token: 'dead', label: 'crashed', acquired_at: '2026-01-01T00:00:00.000Z' })}\n`,
      'utf8',
    );

    const serializationUrl = new URL('../serialization.js', import.meta.url).href;
    const logPath = path.join(tempDir, 'race-log.txt');
    const childScript = (name) => `
      import { appendFile } from 'node:fs/promises';
      const { withMemoryRootLock } = await import(${JSON.stringify(serializationUrl)});
      await withMemoryRootLock(${JSON.stringify(rootDir)}, ${JSON.stringify(name)}, async () => {
        await appendFile(${JSON.stringify(logPath)}, 'start-${name}' + '\\n');
        await new Promise((resolve) => setTimeout(resolve, 60));
        await appendFile(${JSON.stringify(logPath)}, 'end-${name}' + '\\n');
      });
    `;

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    await Promise.all([
      execFileAsync(process.execPath, ['--input-type=module', '-e', childScript('a')]),
      execFileAsync(process.execPath, ['--input-type=module', '-e', childScript('b')]),
    ]);

    const events = (await readFile(logPath, 'utf8')).trim().split('\n');
    assert.equal(events.length, 4, 'both children must run');
    for (let index = 0; index < events.length; index += 2) {
      const name = events[index].split('-')[1];
      assert.equal(events[index], `start-${name}`);
      assert.equal(events[index + 1], `end-${name}`, 'critical sections must not interleave');
    }
    await assert.rejects(stat(lockDir), { code: 'ENOENT' });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('CLI smoke: next-decision-id, append-decision, rebuild-active-index', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-cli-smoke-');
  const stdout = [];
  const io = {
    stdout: { write(chunk) { stdout.push(chunk); } },
    stderr: { write(chunk) { stdout.push(chunk); } },
  };

  try {
    const previewExit = await runCli(['next-decision-id', '--root', rootDir], io, { cwd: tempDir });
    assert.equal(previewExit, 0);
    assert.match(stdout.join(''), /Advisory next decision ID: D-002/);
    assert.match(stdout.join(''), /advisory|write time/i);

    const entryPath = path.join(tempDir, 'staged-entry.md');
    await writeFile(entryPath, stagedEntry('CLI smoke decision'), 'utf8');
    stdout.length = 0;
    const appendExit = await runCli(
      ['append-decision', '--root', rootDir, '--target', 'cross-cutting.md', '--entry', entryPath],
      io,
      { cwd: tempDir },
    );
    assert.equal(appendExit, 0);
    assert.match(stdout.join(''), /Appended D-002 to /);
    assert.match(stdout.join(''), /INDEX\.md is derived/);
    const content = await readFile(path.join(rootDir, 'decisions', 'cross-cutting.md'), 'utf8');
    assert.match(content, /^### D-002 — CLI smoke decision$/m);

    await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'smoke-a', workingOn: 'A.', date: '2026-04-20' });
    await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'smoke-b', workingOn: 'B.', date: '2026-04-20' });
    await rm(path.join(rootDir, 'sessions', 'active', 'index.yaml'), { force: true });

    stdout.length = 0;
    const rebuildExit = await runCli(
      ['rebuild-active-index', '--root', rootDir, '--current', 'smoke-b'],
      io,
      { cwd: tempDir },
    );
    assert.equal(rebuildExit, 0);
    assert.match(stdout.join(''), /Current lane: smoke-b/);
    const index = await readFile(path.join(rootDir, 'sessions', 'active', 'index.yaml'), 'utf8');
    assert.match(index, /^current: smoke-b$/m);
    assert.match(index, /smoke-a/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
