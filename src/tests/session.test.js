import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeProjectMemory } from '../init.js';
import { runCli } from '../cli.js';
import { closeProjectSession, startProjectSession } from '../session.js';

test('startProjectSession creates scratch files and updates CLAUDE.md', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-session-start-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Session Project',
      mode: 'local-only',
      repos: [{ id: 'docs', remote: 'https://github.com/example/docs.git' }],
      closeSessionGitPublish: true,
      closeSessionGitRemote: 'origin',
      bootstrap: {
        workflow: true,
        claude: true,
      },
    });

    const result = await startProjectSession({
      cwd: tempDir,
      rootDir,
      workingOn: 'Close the workflow parity gap.',
      date: '2026-04-20',
    });

    const claude = await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8');
    const wip = await readFile(path.join(rootDir, 'sessions/wip.md'), 'utf8');
    const handoff = await readFile(path.join(rootDir, 'sessions/handoff.md'), 'utf8');

    assert.equal(result.sessionNumber, 1);
    assert.match(claude, /Date: 2026-04-20 \(session 1\)/);
    assert.match(claude, /Working on: Close the workflow parity gap\./);
    assert.match(wip, /# WIP — 2026-04-20 \(session 1\)/);
    assert.match(wip, /## Working on\nClose the workflow parity gap\./);
    assert.match(handoff, /# Handoff — 2026-04-20 \(session 1\)/);
    assert.match(handoff, /Close the workflow parity gap\./);

    await assert.rejects(
      () =>
        startProjectSession({
          cwd: tempDir,
          rootDir,
          workingOn: 'Try to reopen the same session.',
          date: '2026-04-20',
        }),
      /active session scratch file already exists/i,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('startProjectSession finds the current-session fence even if another code block appears first', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-session-fence-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Session Project',
      mode: 'local-only',
      repos: [{ id: 'docs', remote: 'https://github.com/example/docs.git' }],
      closeSessionGitPublish: true,
      closeSessionGitRemote: 'origin',
      bootstrap: {
        workflow: true,
        claude: true,
      },
    });

    const claudePath = path.join(tempDir, 'CLAUDE.md');
    const originalClaude = await readFile(claudePath, 'utf8');
    const mutatedClaude = originalClaude.replace(
      '## Current session\n\n**Update this block at the start and end of every session.**\n\n',
      [
        '## Current session',
        '',
        '**Update this block at the start and end of every session.**',
        '',
        '```text',
        'Example note: this extra code fence should be ignored.',
        '```',
        '',
      ].join('\n'),
    );
    await writeFile(claudePath, mutatedClaude, 'utf8');

    await startProjectSession({
      cwd: tempDir,
      rootDir,
      workingOn: 'Exercise the session fence parser.',
      date: '2026-04-20',
    });

    const updatedClaude = await readFile(claudePath, 'utf8');
    assert.match(updatedClaude, /Date: 2026-04-20 \(session 1\)/);
    assert.match(updatedClaude, /Working on: Exercise the session fence parser\./);
    assert.match(updatedClaude, /Example note: this extra code fence should be ignored\./);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('closeProjectSession finalizes the session note and removes scratch files', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-session-close-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Session Project',
      mode: 'local-only',
      repos: [{ id: 'docs', remote: 'https://github.com/example/docs.git' }],
      closeSessionGitPublish: true,
      closeSessionGitRemote: 'origin',
      bootstrap: {
        workflow: true,
        claude: true,
      },
    });

    await startProjectSession({
      cwd: tempDir,
      rootDir,
      workingOn: 'Bring session lifecycle into the package.',
      date: '2026-04-20',
    });

    const result = await closeProjectSession({
      cwd: tempDir,
      rootDir,
      title: 'Workflow Parity Commands',
      completed: [
        'Added explicit session open and close helpers.',
        'Updated the package scaffolding to mention the new commands.',
      ],
      decisions: ['D-161 — `vibecompass` owns explicit session open/close helpers.'],
      models: ['Codex (GPT-5) — implemented the session lifecycle commands and tests.'],
      nextSteps: [
        'Verify the updated package docs and public docs copy.',
        'Decide whether to publish the new workflow slice immediately.',
      ],
    });

    const sessionNote = await readFile(result.sessionFilePath, 'utf8');
    const claude = await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8');

    assert.match(result.sessionFilePath, /2026-04-20-1-workflow-parity-commands\.md$/);
    assert.match(sessionNote, /# Session — 2026-04-20-1 — Workflow Parity Commands/);
    assert.match(sessionNote, /## What we worked on\nBring session lifecycle into the package\./);
    assert.match(sessionNote, /## Completed\n- Added explicit session open and close helpers\./);
    assert.match(sessionNote, /## Decisions made\n- D-161/);
    assert.match(sessionNote, /## Models used\n- Codex \(GPT-5\) — implemented the session lifecycle commands and tests\./);
    assert.match(sessionNote, /1\. Verify the updated package docs and public docs copy\./);
    assert.match(claude, /Working on: Session closed\. Ready for the next builder session\./);
    assert.match(claude, /Last thing completed: Closed session 1 and wrote `sessions\/2026-04-20-1-workflow-parity-commands\.md`\./);
    assert.ok(result.workflowGuidance.includes('Refresh any relevant architecture docs before finalizing the session.'));
    assert.ok(result.workflowGuidance.includes('Refresh any relevant decision files before finalizing the session.'));
    assert.ok(result.workflowGuidance.includes('This workflow includes a Git publish step after close-session; review, commit, and push to origin.'));
    assert.ok(result.workflowGuidance.includes('Use commit message format: docs(session): YYYY-MM-DD-N — <summary>'));
    assert.equal(result.agentFileSync.results.find((item) => item.format === 'claude_md')?.status, 'warning');
    assert.equal(result.agentFileSync.results.find((item) => item.format === 'agents_md')?.status, 'create');
    assert.match(await readFile(path.join(tempDir, 'AGENTS.md'), 'utf8'), /Session Project Agent Instructions/);

    await assert.rejects(() => access(path.join(rootDir, 'sessions/wip.md')));
    await assert.rejects(() => access(path.join(rootDir, 'sessions/handoff.md')));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('closeProjectSession falls back to default workflow guidance when project.yaml is unavailable', async () => {
  for (const scenario of ['missing', 'malformed']) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), `vibecompass-session-workflow-${scenario}-`));
    const rootDir = path.join(tempDir, '.compass');

    try {
      await initializeProjectMemory({
        cwd: tempDir,
        rootDir,
        name: 'Session Project',
        mode: 'local-only',
        repos: [{ id: 'docs', remote: 'https://github.com/example/docs.git' }],
        closeSessionGitPublish: true,
        closeSessionGitRemote: 'origin',
        bootstrap: {
          workflow: true,
          claude: true,
        },
      });

      await startProjectSession({
        cwd: tempDir,
        rootDir,
        workingOn: `Close a session after the workflow file becomes ${scenario}.`,
        date: '2026-04-20',
      });

      const projectFilePath = path.join(rootDir, 'project.yaml');
      if (scenario === 'missing') {
        await rm(projectFilePath, { force: true });
      } else {
        await writeFile(projectFilePath, 'metadata:\n  workflow:\n    close_session: [\n', 'utf8');
      }

      const result = await closeProjectSession({
        cwd: tempDir,
        rootDir,
        title: `Workflow Fallback ${scenario}`,
        completed: ['Closed the session even though the workflow file was unavailable.'],
        nextSteps: ['Restore or regenerate project.yaml before the next session.'],
      });

      assert.ok(
        result.workflowGuidance.includes('Refresh any relevant architecture docs before finalizing the session.'),
      );
      assert.ok(
        result.workflowGuidance.includes('Refresh any relevant decision files before finalizing the session.'),
      );
      assert.equal(
        result.workflowGuidance.some((line) => line.includes('Git publish step')),
        false,
      );
      assert.equal(
        result.workflowGuidance.some((line) => line.includes('commit message format')),
        false,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
});

test('closeProjectSession allows sessions without recorded models', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-session-no-models-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Session Project',
      mode: 'local-only',
      repos: [{ id: 'docs', remote: 'https://github.com/example/docs.git' }],
      bootstrap: {
        workflow: true,
        claude: true,
      },
    });

    await startProjectSession({
      cwd: tempDir,
      rootDir,
      workingOn: 'Close a human-led session without model metadata.',
      date: '2026-04-20',
    });

    const result = await closeProjectSession({
      cwd: tempDir,
      rootDir,
      title: 'Human Session Close',
      completed: ['Closed a manual session without AI metadata.'],
      nextSteps: ['Start the next session as usual.'],
    });

    const sessionNote = await readFile(result.sessionFilePath, 'utf8');
    assert.match(sessionNote, /## Models used\n- Not recorded\./);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runCli supports start-session and close-session', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-session-cli-'));
  const rootDir = path.join(tempDir, '.compass');
  const stdout = [];
  const stderr = [];

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'CLI Session Project',
      mode: 'local-only',
      repos: [{ id: 'docs', remote: 'https://github.com/example/docs.git' }],
      bootstrap: {
        workflow: true,
        claude: true,
      },
    });

    const startExitCode = await runCli(
      [
        'start-session',
        '--root',
        rootDir,
        '--working-on',
        'Exercise the CLI session commands.',
        '--date',
        '2026-04-20',
      ],
      {
        stdout: { write(chunk) { stdout.push(chunk); } },
        stderr: { write(chunk) { stderr.push(chunk); } },
      },
      {
        cwd: tempDir,
      },
    );

    const closeExitCode = await runCli(
      [
        'close-session',
        '--root',
        rootDir,
        '--title',
        'CLI Session Flow',
        '--completed',
        'Exercised the CLI start-session path.',
        '--next-step',
        'Run the package test suite.',
      ],
      {
        stdout: { write(chunk) { stdout.push(chunk); } },
        stderr: { write(chunk) { stderr.push(chunk); } },
      },
      {
        cwd: tempDir,
      },
    );

    assert.equal(startExitCode, 0);
    assert.equal(closeExitCode, 0);
    assert.match(stderr.join(''), /CLAUDE\.md: warning/);
    assert.ok(stdout.join('').includes('Started session 2026-04-20-1'));
    assert.ok(stdout.join('').includes('Closed session 2026-04-20-1'));
    assert.ok(stdout.join('').includes('2026-04-20-1-cli-session-flow.md'));
    assert.ok(stdout.join('').includes('Workflow guidance:'));
    assert.ok(stdout.join('').includes('Refresh any relevant architecture docs before finalizing the session.'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
