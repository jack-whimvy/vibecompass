import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeProjectMemory } from '../init.js';
import { runCli } from '../cli.js';
import { closeProjectSession, listProjectSessions, startProjectSession, switchProjectSession } from '../session.js';

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
      sessionId: 'workflow-parity',
      workingOn: 'Close the workflow parity gap.',
      date: '2026-04-20',
    });

    const claude = await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8');
    const wip = await readFile(path.join(rootDir, 'sessions/active/workflow-parity/wip.md'), 'utf8');
    const handoff = await readFile(path.join(rootDir, 'sessions/active/workflow-parity/handoff.md'), 'utf8');
    const laneMetadata = await readFile(path.join(rootDir, 'sessions/active/workflow-parity/session.yaml'), 'utf8');
    const activeIndex = await readFile(path.join(rootDir, 'sessions/active/index.yaml'), 'utf8');

    assert.equal(result.sessionNumber, 1);
    assert.equal(result.sessionId, 'workflow-parity');
    assert.match(result.warnings.join('\n'), /No docs-review marker found/);
    assert.match(claude, /Date: 2026-04-20 \(session 1, lane workflow-parity\)/);
    assert.match(claude, /Working on: Close the workflow parity gap\. \[workflow-parity\]/);
    assert.match(wip, /# WIP — 2026-04-20 \(session 1\)/);
    assert.match(wip, /Session lane: workflow-parity/);
    assert.match(wip, /## Working on\nClose the workflow parity gap\./);
    assert.match(handoff, /# Handoff — 2026-04-20 \(session 1\)/);
    assert.match(handoff, /Close the workflow parity gap\./);
    assert.match(laneMetadata, /id: workflow-parity/);
    assert.match(laneMetadata, /session_number: 1/);
    assert.match(activeIndex, /current: workflow-parity/);

    await assert.rejects(
      () =>
        startProjectSession({
          cwd: tempDir,
          rootDir,
          workingOn: 'Try to reopen the same session.',
          date: '2026-04-20',
        }),
      /requires --id/i,
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
      sessionId: 'fence-parser',
      workingOn: 'Exercise the session fence parser.',
      date: '2026-04-20',
    });

    const updatedClaude = await readFile(claudePath, 'utf8');
    assert.match(updatedClaude, /Date: 2026-04-20 \(session 1, lane fence-parser\)/);
    assert.match(updatedClaude, /Working on: Exercise the session fence parser\. \[fence-parser\]/);
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
      sessionId: 'workflow-parity',
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
    assert.equal(result.agentFileSync.results.find((item) => item.format === 'agents_md')?.status, 'update');
    assert.match(await readFile(path.join(tempDir, 'AGENTS.md'), 'utf8'), /Session Project Agent Instructions/);

    await assert.rejects(() => access(path.join(rootDir, 'sessions/active/workflow-parity/wip.md')));
    await assert.rejects(() => access(path.join(rootDir, 'sessions/active/workflow-parity/handoff.md')));
    await assert.rejects(() => access(path.join(rootDir, 'sessions/active/workflow-parity/session.yaml')));
    await assert.rejects(() => access(path.join(rootDir, 'sessions/active/index.yaml')));
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
        sessionId: `workflow-${scenario}`,
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
      sessionId: 'human-session',
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

test('session lanes can run concurrently and switch current lane', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-session-lanes-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Lane Project',
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
      sessionId: 'billing-plans',
      workingOn: 'Build the billing plans lane.',
      features: ['billing'],
      repos: ['app'],
      claims: ['vibecompass-app/src/app/billing'],
      date: '2026-04-20',
    });
    await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'marketing-copy',
      workingOn: 'Build the marketing copy lane.',
      features: ['marketing'],
      repos: ['docs'],
      claims: ['vibecompass-docs/product'],
      date: '2026-04-20',
    });

    const listed = await listProjectSessions({ cwd: tempDir, rootDir });
    assert.equal(listed.current, 'marketing-copy');
    assert.deepEqual(listed.lanes.map((lane) => lane.id), ['billing-plans', 'marketing-copy']);
    assert.deepEqual(listed.lanes.map((lane) => lane.sessionNumber), [1, 2]);

    const switched = await switchProjectSession({ cwd: tempDir, rootDir, sessionId: 'billing-plans' });
    assert.equal(switched.current, 'billing-plans');

    const index = await readFile(path.join(rootDir, 'sessions/active/index.yaml'), 'utf8');
    const claude = await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8');
    const billingMetadata = await readFile(path.join(rootDir, 'sessions/active/billing-plans/session.yaml'), 'utf8');
    assert.match(index, /current: billing-plans/);
    assert.match(claude, /Date: 2026-04-20 \(session 1, lane billing-plans\)/);
    assert.match(claude, /Working on: Build the billing plans lane\. \[billing-plans\]/);
    assert.match(claude, /Last thing completed: Switched current lane to billing-plans\./);
    assert.match(billingMetadata, /id: billing-plans/);
    assert.match(billingMetadata, /session_date: 2026-04-20/);
    assert.match(billingMetadata, /session_number: 1/);
    assert.match(billingMetadata, /working_on: "Build the billing plans lane\."/);
    assert.match(billingMetadata, /feature_slugs:\n  - "billing"/);
    assert.match(billingMetadata, /repos:\n  - "app"/);
    assert.match(billingMetadata, /claimed_paths:\n  - "vibecompass-app\/src\/app\/billing"/);

    await assert.rejects(
      () =>
        startProjectSession({
          cwd: tempDir,
          rootDir,
          sessionId: 'billing-plans',
          workingOn: 'Duplicate the billing lane.',
          date: '2026-04-20',
        }),
      /already exists/i,
    );
    await assert.rejects(
      () =>
        startProjectSession({
          cwd: tempDir,
          rootDir,
          sessionId: 'active',
          workingOn: 'Use a reserved lane.',
          date: '2026-04-20',
        }),
      /reserved/i,
    );
    await assert.rejects(
      () =>
        startProjectSession({
          cwd: tempDir,
          rootDir,
          sessionId: 'default',
          workingOn: 'Use a reserved lane name explicitly.',
          date: '2026-04-20',
        }),
      /reserved/i,
    );
    await assert.rejects(
      () =>
        startProjectSession({
          cwd: tempDir,
          rootDir,
          sessionId: 'null',
          workingOn: 'Use a YAML keyword lane.',
          date: '2026-04-20',
        }),
      /reserved/i,
    );
    await assert.rejects(
      () =>
        startProjectSession({
          cwd: tempDir,
          rootDir,
          sessionId: 'Billing',
          workingOn: 'Use an invalid lane.',
          date: '2026-04-20',
        }),
      /lowercase slug/i,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('closeProjectSession requires --session when multiple lanes are active', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-session-close-multiple-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Multiple Lane Project',
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
      sessionId: 'billing-plans',
      workingOn: 'Build billing plans.',
      date: '2026-04-20',
    });
    await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'marketing-copy',
      workingOn: 'Build marketing copy.',
      date: '2026-04-20',
    });

    await assert.rejects(
      () =>
        closeProjectSession({
          cwd: tempDir,
          rootDir,
          title: 'Ambiguous Lane Close',
          completed: ['Tried to close without selecting a lane.'],
          nextSteps: ['Pass --session before closing.'],
        }),
      /Multiple active session lanes exist/i,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('closeProjectSession still supports legacy root scratch files during migration', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-session-close-legacy-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Legacy Session Project',
      mode: 'local-only',
      repos: [{ id: 'docs', remote: 'https://github.com/example/docs.git' }],
      bootstrap: {
        workflow: true,
        claude: true,
      },
    });
    await mkdir(path.join(rootDir, 'sessions'), { recursive: true });
    await writeFile(
      path.join(rootDir, 'sessions/wip.md'),
      [
        '# WIP — 2026-04-20 (session 1)',
        '',
        '## Working on',
        'Close the legacy scratch files.',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(path.join(rootDir, 'sessions/handoff.md'), '# Handoff — 2026-04-20 (session 1)\n', 'utf8');

    const result = await closeProjectSession({
      cwd: tempDir,
      rootDir,
      title: 'Legacy Scratch Close',
      completed: ['Closed a legacy root-level scratch session.'],
      nextSteps: ['Start a lane-aware session next.'],
    });

    assert.equal(result.sessionId, null);
    assert.match(result.sessionFilePath, /2026-04-20-1-legacy-scratch-close\.md$/);
    await assert.rejects(() => access(path.join(rootDir, 'sessions/wip.md')));
    await assert.rejects(() => access(path.join(rootDir, 'sessions/handoff.md')));
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
        '--id',
        'cli-session',
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

test('runCli supports list-sessions, switch-session, and close-session --session', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-session-cli-lanes-'));
  const rootDir = path.join(tempDir, '.compass');
  const stdout = [];
  const stderr = [];

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'CLI Lane Project',
      mode: 'local-only',
      repos: [{ id: 'docs', remote: 'https://github.com/example/docs.git' }],
      bootstrap: {
        workflow: true,
        claude: true,
      },
    });

    const io = {
      stdout: { write(chunk) { stdout.push(chunk); } },
      stderr: { write(chunk) { stderr.push(chunk); } },
    };

    assert.equal(
      await runCli(
        [
          'start-session',
          '--root',
          rootDir,
          '--id',
          'billing-plans',
          '--working-on',
          'Build billing plans.',
          '--date',
          '2026-04-20',
        ],
        io,
        { cwd: tempDir },
      ),
      0,
    );
    assert.equal(
      await runCli(
        [
          'start-session',
          '--root',
          rootDir,
          '--id',
          'marketing-copy',
          '--working-on',
          'Build marketing copy.',
          '--date',
          '2026-04-20',
        ],
        io,
        { cwd: tempDir },
      ),
      0,
    );
    assert.equal(await runCli(['list-sessions', '--root', rootDir], io, { cwd: tempDir }), 0);
    assert.equal(await runCli(['switch-session', '--root', rootDir, 'billing-plans'], io, { cwd: tempDir }), 0);
    assert.equal(
      await runCli(
        [
          'close-session',
          '--root',
          rootDir,
          '--session',
          'billing-plans',
          '--title',
          'Billing Lane',
          '--completed',
          'Closed the billing lane.',
          '--blocker',
          'Stripe API rate limit belongs to billing only.',
          '--next-session-should',
          'Resolve billing provider retries before reopening billing.',
          '--next-step',
          'Continue the marketing lane.',
        ],
        io,
        { cwd: tempDir },
      ),
      0,
    );

    const output = stdout.join('');
    assert.match(stderr.join(''), /CLAUDE\.md: warning/);
    assert.match(output, /Active session lanes \(current: marketing-copy\):/);
    assert.match(output, /\* marketing-copy: Build marketing copy\./);
    assert.match(output, /- billing-plans: Build billing plans\./);
    assert.match(output, /Current session lane: billing-plans/);
    assert.match(output, /Closed session 2026-04-20-1/);

    const claude = await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8');
    const indexAfterClose = await readFile(path.join(rootDir, 'sessions/active/index.yaml'), 'utf8');
    assert.match(indexAfterClose, /current: marketing-copy/);
    assert.match(claude, /Date: 2026-04-20 \(session 2, lane marketing-copy\)/);
    assert.match(claude, /Working on: Build marketing copy\. \[marketing-copy\]/);
    assert.match(claude, /Last thing completed: Closed session 1 and wrote `sessions\/2026-04-20-1-billing-lane\.md`\./);
    assert.match(claude, /Blockers: No blocker recorded for the selected lane\./);
    assert.match(claude, /Next session should: Continue the selected active lane from `sessions\/active\/index\.yaml`\./);
    assert.doesNotMatch(claude, /Session closed\. Ready for the next builder session\./);
    assert.doesNotMatch(claude, /Stripe API rate limit belongs to billing only\./);
    assert.doesNotMatch(claude, /Resolve billing provider retries before reopening billing\./);

    await assert.rejects(() => access(path.join(rootDir, 'sessions/active/billing-plans/wip.md')));
    await assert.rejects(() => access(path.join(rootDir, 'sessions/active/billing-plans/session.yaml')));
    await access(path.join(rootDir, 'sessions/active/marketing-copy/wip.md'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runCli supports end-session as a close-session alias', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-session-end-alias-'));
  const rootDir = path.join(tempDir, '.compass');
  const stdout = [];

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'End Alias Project',
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
      sessionId: 'end-alias',
      workingOn: 'Verify the end-session alias.',
      date: '2026-04-27',
    });

    const exitCode = await runCli(
      [
        'end-session',
        '--root',
        rootDir,
        '--title',
        'End Alias Flow',
        '--completed',
        'Closed the session through the end-session alias.',
        '--next-step',
        'Continue with normal start-session flow.',
      ],
      {
        stdout: {
          write(chunk) {
            stdout.push(chunk);
          },
        },
        stderr: { write() {} },
      },
      {
        cwd: tempDir,
      },
    );

    assert.equal(exitCode, 0);
    assert.ok(stdout.join('').includes('Closed session 2026-04-27-1'));
    assert.ok(stdout.join('').includes('2026-04-27-1-end-alias-flow.md'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
