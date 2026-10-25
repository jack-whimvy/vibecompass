import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeProjectMemory } from '../init.js';
import { runCli } from '../cli.js';
import { closeProjectSession, continueProjectSession, listProjectSessions, readLaneEnvironment, startProjectSession, switchProjectSession, writeLaneMarkerForSession } from '../session.js';

const DOCUMENT_MAINTENANCE_UPDATED = {
  architectureDocs: 'updated',
  decisionLog: 'updated',
  sessionMaintenance: 'updated',
};
const CLI_DOCUMENT_MAINTENANCE_UPDATED = [
  '--architecture-docs',
  'updated',
  '--decision-log',
  'updated',
  '--session-maintenance',
  'updated',
];

async function appendWorktreeContainer(rootDir, laneId, containerDir) {
  const sessionFilePath = path.join(rootDir, 'sessions/active', laneId, 'session.yaml');
  const content = await readFile(sessionFilePath, 'utf8');
  await writeFile(sessionFilePath, `${content}worktree_container: ${JSON.stringify(containerDir)}\n`, 'utf8');
}

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
    assert.equal(result.manifest.manifest.active_sessions.current, 'workflow-parity');

    const startManifest = JSON.parse(await readFile(path.join(rootDir, 'state/manifest.json'), 'utf8'));
    assert.equal(startManifest.active_sessions.current, 'workflow-parity');
    assert.deepEqual(startManifest.active_sessions.lanes.map((lane) => lane.id), ['workflow-parity']);

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

test('startProjectSession does not count an unnumbered recovery checkpoint as close-session chronology', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-session-recovery-checkpoint-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Recovery Checkpoint Session Project',
      mode: 'local-only',
      repos: [{ id: 'docs', remote: 'https://github.com/example/docs.git' }],
      bootstrap: {
        workflow: true,
        claude: true,
      },
    });
    await writeFile(
      path.join(rootDir, 'sessions/2026-07-12.md'),
      [
        '# Recovery checkpoint — 2026-07-12 — Billing B1 production attestation and collision evidence',
        '',
        '## What we worked on',
        'Billing B1 recovery.',
        '',
        '## Completed',
        '- Captured evidence.',
        '',
        '## Decisions made',
        '- None.',
        '',
        '## Models used',
        '- Codex.',
        '',
        '## Blockers / open questions',
        '- The active lane continues.',
        '',
        '## Next session should start with',
        '- Resume the active lane.',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'post-checkpoint-work',
      workingOn: 'Continue after the recovery checkpoint.',
      date: '2026-07-12',
    });

    assert.equal(result.sessionNumber, 1);
    assert.equal(result.manifest.manifest.documents['sessions/2026-07-12.md'].extracted.session_number, null);
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

test('startProjectSession creates a current-session block for adopted existing CLAUDE.md files', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-session-adopted-claude-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Adopted Session Project',
      mode: 'local-only',
      repos: [{ id: 'docs', remote: 'https://github.com/example/docs.git' }],
      bootstrap: {
        workflow: true,
        claude: false,
        agents: true,
      },
    });

    await writeFile(
      path.join(tempDir, 'CLAUDE.md'),
      [
        '# Existing Claude Instructions',
        '',
        'Keep these project-specific instructions.',
        '',
        '<!-- vibecompass:start - managed by VibeCompass, do not edit -->',
        '# Adopted Session Project Claude Instructions',
        '',
        'Read `.compass/context.md`.',
        '<!-- vibecompass:end -->',
        '',
      ].join('\n'),
      'utf8',
    );

    await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'adopted-claude',
      workingOn: 'Open a lane from an adopted existing CLAUDE file.',
      date: '2026-04-20',
    });

    const claude = await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8');
    const currentSessionIndex = claude.indexOf('## Current session');
    const managedBlockIndex = claude.indexOf('<!-- vibecompass:start');
    assert.ok(currentSessionIndex > 0);
    assert.ok(managedBlockIndex > currentSessionIndex);
    assert.match(claude, /Keep these project-specific instructions\./);
    assert.match(claude, /Date: 2026-04-20 \(session 1, lane adopted-claude\)/);
    assert.match(claude, /Working on: Open a lane from an adopted existing CLAUDE file\. \[adopted-claude\]/);
    assert.match(await readFile(path.join(rootDir, 'sessions/active/adopted-claude/wip.md'), 'utf8'), /Session lane: adopted-claude/);

    await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'second-adopted-claude',
      workingOn: 'Open a second lane from the inserted Current session block.',
      date: '2026-04-20',
    });

    const updatedClaude = await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8');
    assert.equal((updatedClaude.match(/## Current session/g) ?? []).length, 1);
    assert.match(updatedClaude, /Date: 2026-04-20 \(session 2, lane second-adopted-claude\)/);
    assert.match(updatedClaude, /Working on: Open a second lane from the inserted Current session block\. \[second-adopted-claude\]/);
    assert.match(await readFile(path.join(rootDir, 'sessions/active/second-adopted-claude/wip.md'), 'utf8'), /Session lane: second-adopted-claude/);
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
      documentMaintenance: DOCUMENT_MAINTENANCE_UPDATED,
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
    assert.match(sessionNote, /## Document maintenance checkpoint\n- Architecture docs: updated\n- Decision log: updated\n- Session handoff\/scratch: updated/);
    assert.match(sessionNote, /1\. Verify the updated package docs and public docs copy\./);
    assert.match(claude, /Working on: Session closed\. Ready for the next builder session\./);
    assert.match(claude, /Last thing completed: Closed session 1 and wrote `sessions\/2026-04-20-1-workflow-parity-commands\.md`\./);
    assert.ok(result.workflowGuidance.includes('Refresh any relevant architecture docs before finalizing the session.'));
    assert.ok(result.workflowGuidance.includes('Architecture docs keep current behavior plus the durable plan, unresolved next steps, and material rollout state — fold changes in place, never dated session sections; session notes keep work chronology and close-out next steps; decisions keep accepted choices and rationale; transient lane scratch drains into the session note at close (D-292, D-293).'));
    assert.ok(result.workflowGuidance.includes('Refresh any relevant decision files before finalizing the session.'));
    assert.ok(result.workflowGuidance.includes('This workflow includes a Git publish step after close-session; review, commit, and push to origin.'));
    assert.ok(result.workflowGuidance.includes('Use commit message format: docs(session): YYYY-MM-DD-N — <summary>'));
    assert.equal(result.docsUpdatePlan.session.id, 'workflow-parity');
    assert.deepEqual(result.docsUpdatePlan.delta.changedFiles, []);
    assert.equal(result.agentFileSync.results.find((item) => item.format === 'claude_md')?.status, 'unchanged');
    assert.equal(result.agentFileSync.results.find((item) => item.format === 'agents_md')?.status, 'unchanged');
    assert.match(await readFile(path.join(tempDir, 'AGENTS.md'), 'utf8'), /Session Project Agent Instructions/);
    assert.equal(result.manifest.manifest.active_sessions, undefined);

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
        documentMaintenance: DOCUMENT_MAINTENANCE_UPDATED,
        nextSteps: ['Restore or regenerate project.yaml before the next session.'],
      });

      assert.ok(
        result.workflowGuidance.includes('Refresh any relevant architecture docs before finalizing the session.'),
      );
      assert.ok(
        result.workflowGuidance.includes('Architecture docs keep current behavior plus the durable plan, unresolved next steps, and material rollout state — fold changes in place, never dated session sections; session notes keep work chronology and close-out next steps; decisions keep accepted choices and rationale; transient lane scratch drains into the session note at close (D-292, D-293).'),
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

test('closeProjectSession prints mode-aware hosted projection guidance', async () => {
  for (const scenario of [
    {
      mode: 'local-primary',
      sync: {
        apiUrl: 'https://vibecompass.dev',
        projectId: 'vc_proj_test',
        credentialEnvVar: 'VIBECOMPASS_SYNC_TOKEN',
      },
      expected: /vibecompass push --root \.compass/,
    },
    {
      mode: 'local-primary',
      sync: undefined,
      expected: /no hosted sync binding is configured/,
    },
    {
      mode: 'hosted-only',
      sync: {
        apiUrl: 'https://vibecompass.dev',
        projectId: 'vc_proj_hosted',
        credentialEnvVar: 'VIBECOMPASS_SYNC_TOKEN',
      },
      expected: /there is no authoritative local push/,
    },
    {
      mode: 'local-only',
      sync: undefined,
      expected: /no hosted push expectation/,
    },
  ]) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), `vibecompass-session-hosted-${scenario.mode}-`));
    const rootDir = path.join(tempDir, '.compass');

    try {
      await initializeProjectMemory({
        cwd: tempDir,
        rootDir,
        name: `Hosted Guidance ${scenario.mode}`,
        mode: scenario.mode,
        repos: [{ id: 'docs', remote: 'https://github.com/example/docs.git' }],
        sync: scenario.sync,
        bootstrap: {
          workflow: true,
          claude: true,
        },
      });

      await startProjectSession({
        cwd: tempDir,
        rootDir,
        sessionId: 'hosted-guidance',
        workingOn: 'Check hosted projection guidance.',
        date: '2026-04-20',
      });

      const result = await closeProjectSession({
        cwd: tempDir,
        rootDir,
        title: 'Hosted Guidance',
        completed: ['Checked hosted projection guidance.'],
        documentMaintenance: DOCUMENT_MAINTENANCE_UPDATED,
        nextSteps: ['Continue hosted sync testing.'],
      });

      assert.match(result.workflowGuidance.join('\n'), scenario.expected);
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
      documentMaintenance: DOCUMENT_MAINTENANCE_UPDATED,
      nextSteps: ['Start the next session as usual.'],
    });

    const sessionNote = await readFile(result.sessionFilePath, 'utf8');
    assert.match(sessionNote, /## Models used\n- Not recorded\./);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('closeProjectSession degrades gracefully when docs-update planning fails', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-session-docs-update-degrade-'));
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
      sessionId: 'planning-degrade',
      workingOn: 'Close even when docs-update planning cannot inspect docs.',
      date: '2026-04-20',
    });

    const result = await closeProjectSession({
      cwd: tempDir,
      rootDir,
      title: 'Planning Degrade',
      completed: ['Closed the session even though docs-update planning failed.'],
      documentMaintenance: DOCUMENT_MAINTENANCE_UPDATED,
      nextSteps: ['Investigate the docs-update planner failure before relying on docs-update output.'],
      docsUpdatePlanner: async () => {
        throw new Error('Injected docs-update planner failure.');
      },
    });

    assert.equal(result.docsUpdatePlan, null);
    assert.match(result.warnings.join('\n'), /Docs-update plan skipped: Injected docs-update planner failure\./);
    assert.match(result.sessionFilePath, /2026-04-20-1-planning-degrade\.md$/);
    assert.match(await readFile(result.sessionFilePath, 'utf8'), /Closed the session even though docs-update planning failed\./);
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
    await writeFile(
      path.join(rootDir, 'decisions/cross-cutting.md'),
      [
        '### D-124 — Local-first project memory becomes the primary product direction',
        '**Timestamp:** 2026-04-19 00:01 PDT',
        '**Decision:** Canonical project memory lives locally.',
        '**Rationale:** Local ownership is the point.',
        '',
      ].join('\n'),
      'utf8',
    );

    await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'billing-plans',
      workingOn: 'Build the billing plans lane.',
      features: ['billing'],
      repos: ['app'],
      claims: ['app:src/app/billing'],
      date: '2026-04-20',
    });
    const marketingResult = await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'marketing-copy',
      workingOn: 'Build the marketing copy lane.',
      features: ['billing'],
      repos: ['app'],
      claims: ['app:src/app/billing/copy'],
      date: '2026-04-20',
    });

    assert.match(marketingResult.warnings.join('\n'), /overlaps "billing-plans" on feature\(s\): billing/);
    assert.match(marketingResult.warnings.join('\n'), /overlaps "billing-plans" on claimed path app:src\/app\/billing/);

    const listed = await listProjectSessions({ cwd: tempDir, rootDir });
    assert.equal(listed.current, 'marketing-copy');
    assert.deepEqual(listed.lanes.map((lane) => lane.id), ['billing-plans', 'marketing-copy']);
    assert.deepEqual(listed.lanes.map((lane) => lane.sessionNumber), [1, 2]);
    assert.deepEqual(listed.lanes.map((lane) => lane.claims), [
      ['app:src/app/billing'],
      ['app:src/app/billing/copy'],
    ]);

    const switched = await switchProjectSession({ cwd: tempDir, rootDir, sessionId: 'billing-plans' });
    assert.equal(switched.current, 'billing-plans');

    const manifestAfterSwitch = JSON.parse(await readFile(path.join(rootDir, 'state/manifest.json'), 'utf8'));
    assert.equal(manifestAfterSwitch.active_sessions.current, 'billing-plans');
    assert.deepEqual(
      manifestAfterSwitch.active_sessions.lanes.map((lane) => ({
        id: lane.id,
        feature_slugs: lane.feature_slugs,
        claimed_paths: lane.claimed_paths,
        highest: lane.decision_snapshot.highest_decision_id,
      })),
      [
        {
          id: 'billing-plans',
          feature_slugs: ['billing'],
          claimed_paths: ['app:src/app/billing'],
          highest: 124,
        },
        {
          id: 'marketing-copy',
          feature_slugs: ['billing'],
          claimed_paths: ['app:src/app/billing/copy'],
          highest: 124,
        },
      ],
    );

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
    assert.match(billingMetadata, /claimed_paths:\n  - "app:src\/app\/billing"/);
    assert.match(billingMetadata, /started_at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/);
    assert.match(billingMetadata, /decision_snapshot:\n  highest_decision_id: 124/);

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

test('unbound same-repo lanes warn that worktrees are the runnable isolation boundary', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-session-shared-checkout-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Shared Checkout Project',
      mode: 'local-only',
      repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
      bootstrap: {
        workflow: true,
        claude: true,
      },
    });

    await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'lane-a',
      workingOn: 'A.',
      repos: ['app'],
      claims: ['app:src/a'],
      date: '2026-04-20',
    });
    const laneB = await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'lane-b',
      workingOn: 'B.',
      repos: ['app'],
      claims: ['app:src/b'],
      date: '2026-04-20',
    });

    assert.match(laneB.warnings.join('\n'), /--worktree/);
    assert.match(laneB.warnings.join('\n'), /independent files or dev servers/);
    assert.doesNotMatch(laneB.warnings.join('\n'), /without path claims/);

    const env = await readLaneEnvironment({ cwd: tempDir, rootDir, sessionId: 'lane-b' });
    assert.match(env.warnings.join('\n'), /exported PORT is a runtime assignment/);
    assert.match(env.warnings.join('\n'), /worktrees are the isolation boundary/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('worktree-bound same-repo lanes suppress shared-checkout warnings', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-session-bound-checkout-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Bound Checkout Project',
      mode: 'local-only',
      repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
      bootstrap: {
        workflow: true,
        claude: true,
      },
    });

    await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'lane-a',
      workingOn: 'A.',
      repos: ['app'],
      claims: ['app:src/a'],
      date: '2026-04-20',
    });
    await appendWorktreeContainer(rootDir, 'lane-a', path.join(tempDir, 'worktrees/lane-a'));

    const laneB = await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'lane-b',
      workingOn: 'B.',
      repos: ['app'],
      claims: ['app:src/b'],
      date: '2026-04-20',
    });

    assert.doesNotMatch(laneB.warnings.join('\n'), /--worktree/);
    assert.doesNotMatch(laneB.warnings.join('\n'), /same checkout/);

    const unboundEnv = await readLaneEnvironment({ cwd: tempDir, rootDir, sessionId: 'lane-b' });
    assert.doesNotMatch(unboundEnv.warnings.join('\n'), /exported PORT is a runtime assignment/);
    assert.doesNotMatch(unboundEnv.warnings.join('\n'), /same checkout/);

    await appendWorktreeContainer(rootDir, 'lane-b', path.join(tempDir, 'worktrees/lane-b'));
    const boundEnv = await readLaneEnvironment({ cwd: tempDir, rootDir, sessionId: 'lane-b' });
    assert.doesNotMatch(boundEnv.warnings.join('\n'), /--worktree/);
    assert.doesNotMatch(boundEnv.warnings.join('\n'), /worktrees are the isolation boundary/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('worktree-bound same-repo lanes without claims warn once for missing ownership', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-session-bound-unclaimed-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Bound Checkout Project',
      mode: 'local-only',
      repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
      bootstrap: {
        workflow: true,
        claude: true,
      },
    });

    await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'lane-a',
      workingOn: 'A.',
      repos: ['app'],
      date: '2026-04-20',
    });
    await appendWorktreeContainer(rootDir, 'lane-a', path.join(tempDir, 'worktrees/lane-a'));

    const laneB = await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'lane-b',
      workingOn: 'B.',
      repos: ['app'],
      date: '2026-04-20',
    });
    const warnings = laneB.warnings.join('\n');

    assert.match(warnings, /without path claims/);
    assert.doesNotMatch(warnings, /ownership is ambiguous/);
    assert.doesNotMatch(warnings, /same checkout/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('start-session warns on architecture doc and decision domain file overlap', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-session-doc-overlap-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Lane Project',
      mode: 'local-only',
      repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
      bootstrap: {
        workflow: true,
        claude: true,
      },
    });

    const cliStdout = [];
    const cliStderr = [];
    const startExitCode = await runCli(
      [
        'start-session',
        '--root',
        rootDir,
        '--id',
        'auth-docs',
        '--working-on',
        'Update auth architecture.',
        '--repo',
        'app',
        '--architecture-doc',
        './architecture//product/auth/./login.md',
        '--decision-domain-file',
        './decisions/./cross-cutting.md',
        '--date',
        '2026-04-20',
      ],
      {
        stdout: { write(chunk) { cliStdout.push(chunk); } },
        stderr: { write(chunk) { cliStderr.push(chunk); } },
      },
      {
        cwd: tempDir,
      },
    );
    assert.equal(startExitCode, 0);
    assert.match(cliStdout.join(''), /Started session 2026-04-20-1/);
    const result = await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'auth-decisions',
      workingOn: 'Update auth decision docs.',
      repos: ['app'],
      architectureDocs: ['architecture/product/auth/login.md'],
      decisionDomainFiles: ['decisions/cross-cutting.md'],
      date: '2026-04-20',
    });

    assert.match(
      result.warnings.join('\n'),
      /overlaps "auth-docs" on architecture doc\(s\): architecture\/product\/auth\/login\.md/,
    );
    assert.match(
      result.warnings.join('\n'),
      /overlaps "auth-docs" on decision domain file\(s\): decisions\/cross-cutting\.md/,
    );

    const metadata = await readFile(path.join(rootDir, 'sessions/active/auth-docs/session.yaml'), 'utf8');
    assert.match(metadata, /architecture_docs:\n  - "architecture\/product\/auth\/login\.md"/);
    assert.match(metadata, /decision_domain_files:\n  - "decisions\/cross-cutting\.md"/);
    assert.doesNotMatch(metadata, /\/\.\//);
    assert.doesNotMatch(metadata, /decisions\/\.\/decisions/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('start-session warns when same-repo path ownership is ambiguous', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-session-unknown-owner-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Lane Project',
      mode: 'local-only',
      repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
      bootstrap: {
        workflow: true,
        claude: true,
      },
    });

    await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'repo-wide',
      workingOn: 'Touch app repo broadly.',
      repos: ['app'],
      date: '2026-04-20',
    });
    const result = await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'billing-path',
      workingOn: 'Touch billing path.',
      repos: ['app'],
      claims: ['src/app/billing'],
      date: '2026-04-20',
    });

    assert.match(result.warnings.join('\n'), /ownership is ambiguous/);
    assert.match(result.warnings.join('\n'), /Add --claim paths or --feature slugs to both lanes/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('start-session treats disjoint feature slugs as same-repo ownership disambiguation', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-session-feature-owner-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Lane Project',
      mode: 'local-only',
      repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
      bootstrap: {
        workflow: true,
        claude: true,
      },
    });

    await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'auth-feature',
      workingOn: 'Touch auth broadly.',
      features: ['auth'],
      repos: ['app'],
      date: '2026-04-20',
    });
    const result = await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'billing-feature',
      workingOn: 'Touch billing broadly.',
      features: ['billing'],
      repos: ['app'],
      date: '2026-04-20',
    });

    assert.doesNotMatch(result.warnings.join('\n'), /ownership is ambiguous/);
    assert.match(result.warnings.join('\n'), /--worktree/);
    assert.match(result.warnings.join('\n'), /worktrees are the isolation boundary/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('start-session does not let overlapping feature slugs suppress ambiguous ownership', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-session-shared-feature-owner-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Lane Project',
      mode: 'local-only',
      repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
      bootstrap: {
        workflow: true,
        claude: true,
      },
    });

    await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'auth-one',
      workingOn: 'Touch auth broadly.',
      features: ['auth'],
      repos: ['app'],
      date: '2026-04-20',
    });
    const result = await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'auth-two',
      workingOn: 'Touch auth again.',
      features: ['auth'],
      repos: ['app'],
      date: '2026-04-20',
    });

    assert.match(result.warnings.join('\n'), /overlaps "auth-one" on feature\(s\): auth/);
    assert.match(result.warnings.join('\n'), /ownership is ambiguous/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('start-session treats unprefixed single-repo claims as non-overlapping ownership', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-session-unprefixed-claim-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Lane Project',
      mode: 'local-only',
      repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
      bootstrap: {
        workflow: true,
        claude: true,
      },
    });

    await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'auth-path',
      workingOn: 'Touch auth path.',
      repos: ['app'],
      claims: ['src/app/auth'],
      date: '2026-04-20',
    });
    const result = await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'billing-path',
      workingOn: 'Touch billing path.',
      repos: ['app'],
      claims: ['src/app/billing'],
      date: '2026-04-20',
    });

    assert.doesNotMatch(result.warnings.join('\n'), /ownership is ambiguous/);
    assert.doesNotMatch(result.warnings.join('\n'), /overlaps "auth-path" on claimed path/);
    assert.match(result.warnings.join('\n'), /--worktree/);
    assert.match(result.warnings.join('\n'), /worktrees are the isolation boundary/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('start-session warns when multi-repo claims only disambiguate part of the shared repo set', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-session-partial-claim-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Lane Project',
      mode: 'local-only',
      repos: [
        { id: 'app', remote: 'https://github.com/example/app.git' },
        { id: 'docs', remote: 'https://github.com/example/docs.git' },
      ],
      bootstrap: {
        workflow: true,
        claude: true,
      },
    });

    await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'auth-app',
      workingOn: 'Touch auth app paths.',
      repos: ['app', 'docs'],
      claims: ['app:src/app/auth'],
      date: '2026-04-20',
    });
    const result = await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'billing-app',
      workingOn: 'Touch billing app paths.',
      repos: ['app', 'docs'],
      claims: ['app:src/app/billing'],
      date: '2026-04-20',
    });

    assert.match(result.warnings.join('\n'), /shares repo\(s\) app, docs with "auth-app"/);
    assert.match(result.warnings.join('\n'), /ownership is ambiguous/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('start-session treats Windows drive-letter claims as unprefixed paths', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-session-windows-claim-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Lane Project',
      mode: 'local-only',
      repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
      bootstrap: {
        workflow: true,
        claude: true,
      },
    });

    await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'windows-claim',
      workingOn: 'Touch a Windows-looking path.',
      repos: ['app'],
      claims: ['C:\\Users\\dev\\project\\auth'],
      date: '2026-04-20',
    });
    const result = await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'billing-path',
      workingOn: 'Touch billing path.',
      repos: ['app'],
      claims: ['src/app/billing'],
      date: '2026-04-20',
    });

    assert.doesNotMatch(result.warnings.join('\n'), /ownership is ambiguous/);
    assert.doesNotMatch(result.warnings.join('\n'), /overlaps "windows-claim" on claimed path/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('start-session treats declared single-letter repo prefixes as repo claims', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-session-single-letter-repo-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Lane Project',
      mode: 'local-only',
      repos: [
        { id: 'a', remote: 'https://github.com/example/a.git' },
        { id: 'b', remote: 'https://github.com/example/b.git' },
      ],
      bootstrap: {
        workflow: true,
        claude: true,
      },
    });

    await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'repo-a',
      workingOn: 'Touch repo a.',
      repos: ['a', 'b'],
      claims: ['a:/src/auth'],
      date: '2026-04-20',
    });
    const result = await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'repo-b',
      workingOn: 'Touch repo b.',
      repos: ['a', 'b'],
      claims: ['b:/src/billing'],
      date: '2026-04-20',
    });

    assert.match(result.warnings.join('\n'), /ownership is ambiguous/);
    assert.doesNotMatch(result.warnings.join('\n'), /overlaps "repo-a" on claimed path/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('session lifecycle manifest refresh preserves sync cursor state', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-session-sync-preserve-'));
  const rootDir = path.join(tempDir, '.compass');
  const manifestPath = path.join(rootDir, 'state/manifest.json');

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Sync Cursor Project',
      mode: 'local-primary',
      repos: [{ id: 'docs', remote: 'https://github.com/example/docs.git' }],
      bootstrap: {
        workflow: true,
        claude: true,
      },
    });

    const syncState = {
      last_successful_remote_revision: 'rem_dev_001',
      last_successful_local_root_revision: 'loc_dev_001',
      last_successful_manifest_hash: 'sha256:dev0000000000000000000000000000000000000000000000000000000000000',
      last_sync_direction: 'push',
      last_sync_at: '2026-04-20T10:00:00.000Z',
      pending_previews: [],
      targets: {
        dev: {
          api_url: 'http://localhost:3000',
          project_id: 'proj-dev',
          last_successful_remote_revision: 'rem_dev_001',
          last_successful_local_root_revision: 'loc_dev_001',
          last_successful_manifest_hash: 'sha256:dev0000000000000000000000000000000000000000000000000000000000000',
          last_sync_direction: 'push',
          last_sync_at: '2026-04-20T10:00:00.000Z',
          pending_previews: [],
        },
        prod: {
          api_url: 'https://api.vibecompass.example',
          project_id: 'proj-prod',
          last_successful_remote_revision: 'rem_prod_001',
          last_successful_local_root_revision: 'loc_prod_001',
          last_successful_manifest_hash: 'sha256:prod000000000000000000000000000000000000000000000000000000000000',
          last_sync_direction: 'pull_export',
          last_sync_at: '2026-04-20T11:00:00.000Z',
          pending_previews: [
            {
              preview_token: 'preview-prod',
              base_remote_revision: 'rem_prod_001',
              target_remote_revision: 'rem_prod_002',
              local_root_revision: 'loc_prod_001',
              local_manifest_hash: 'sha256:prod000000000000000000000000000000000000000000000000000000000000',
              authoritative_change_set_hash: 'sha256:change0000000000000000000000000000000000000000000000000000000000',
              include_pending_proposals: true,
              available_proposal_ids: ['proposal-1'],
              created_at: '2026-04-20T11:05:00.000Z',
              expires_at: '2026-04-20T11:20:00.000Z',
            },
          ],
        },
      },
    };
    const seededManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...seededManifest, sync: syncState }, null, 2)}\n`,
      'utf8',
    );

    await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'sync-preserve',
      workingOn: 'Preserve sync cursors after start.',
      date: '2026-04-20',
    });
    assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')).sync, syncState);

    await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'second-lane',
      workingOn: 'Keep a second lane open for close.',
      date: '2026-04-20',
    });
    await switchProjectSession({ cwd: tempDir, rootDir, sessionId: 'sync-preserve' });
    assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')).sync, syncState);

    await closeProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'sync-preserve',
      title: 'Sync Preserve Lane',
      completed: ['Closed one lane without losing sync cursors.'],
      documentMaintenance: DOCUMENT_MAINTENANCE_UPDATED,
      nextSteps: ['Continue the second lane.'],
    });
    const manifestAfterClose = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.deepEqual(manifestAfterClose.sync, syncState);
    assert.equal(manifestAfterClose.active_sessions.current, 'second-lane');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('startProjectSession warns and falls back when an existing lane has corrupt metadata', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-session-corrupt-lane-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Corrupt Lane Project',
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
      sessionId: 'first-lane',
      workingOn: 'Create the first lane.',
      date: '2026-04-20',
    });
    await writeFile(
      path.join(rootDir, 'sessions/active/first-lane/session.yaml'),
      'id: first-lane\n  broken: true\n',
      'utf8',
    );

    const result = await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'second-lane',
      workingOn: 'Open a lane after corrupt metadata.',
      date: '2026-04-20',
    });
    const listed = await listProjectSessions({ cwd: tempDir, rootDir });

    assert.match(result.warnings.join('\n'), /Could not parse .*first-lane\/session\.yaml/);
    assert.deepEqual(listed.lanes.map((lane) => lane.id), ['first-lane', 'second-lane']);
    assert.equal(listed.lanes.find((lane) => lane.id === 'first-lane').sessionNumber, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('closeProjectSession requires document-maintenance checkpoint statuses', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-session-close-checkpoint-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Checkpoint Project',
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
      sessionId: 'checkpoint-lane',
      workingOn: 'Verify close-session checkpoint validation.',
      date: '2026-04-20',
    });

    await assert.rejects(
      () =>
        closeProjectSession({
          cwd: tempDir,
          rootDir,
          title: 'Missing Checkpoint',
          completed: ['Tried to close without checkpoint statuses.'],
          nextSteps: ['Add checkpoint statuses.'],
        }),
      /Missing document-maintenance checkpoint status/i,
    );
    await assert.rejects(
      () =>
        closeProjectSession({
          cwd: tempDir,
          rootDir,
          title: 'Invalid Checkpoint',
          completed: ['Tried to close with an invalid checkpoint status.'],
          documentMaintenance: {
            architectureDocs: 'updated',
            decisionLog: 'skipped',
            sessionMaintenance: 'not-needed',
          },
          nextSteps: ['Use valid checkpoint statuses.'],
        }),
      /Invalid document-maintenance checkpoint status/i,
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
          documentMaintenance: DOCUMENT_MAINTENANCE_UPDATED,
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
      documentMaintenance: DOCUMENT_MAINTENANCE_UPDATED,
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
        ...CLI_DOCUMENT_MAINTENANCE_UPDATED,
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
    assert.doesNotMatch(stderr.join(''), /CLAUDE\.md: warning/);
    assert.ok(stdout.join('').includes('Started session 2026-04-20-1'));
    assert.ok(stdout.join('').includes('Closed session 2026-04-20-1'));
    assert.ok(stdout.join('').includes('2026-04-20-1-cli-session-flow.md'));
    assert.ok(stdout.join('').includes('Docs update plan:'));
    assert.ok(stdout.join('').includes('Document maintenance checkpoint:'));
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
          ...CLI_DOCUMENT_MAINTENANCE_UPDATED,
        ],
        io,
        { cwd: tempDir },
      ),
      0,
    );

    const output = stdout.join('');
    assert.doesNotMatch(stderr.join(''), /CLAUDE\.md: warning/);
    assert.match(output, /Active session lanes \(current hint: marketing-copy\):/);
    assert.match(output, /\* marketing-copy: Build marketing copy\. \[current hint\]/);
    assert.match(output, /- billing-plans: Build billing plans\./);
    assert.match(output, /opened 2026-04-20 \(session 1\); port 3100/);
    assert.match(output, /resume one with `vibecompass continue-session <lane-id>`/);
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

    const manifestAfterClose = JSON.parse(await readFile(path.join(rootDir, 'state/manifest.json'), 'utf8'));
    assert.equal(manifestAfterClose.active_sessions.current, 'marketing-copy');
    assert.deepEqual(manifestAfterClose.active_sessions.lanes.map((lane) => lane.id), ['marketing-copy']);

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
        ...CLI_DOCUMENT_MAINTENANCE_UPDATED,
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

async function createContinueSessionRoot(prefix) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const rootDir = path.join(tempDir, '.compass');
  await initializeProjectMemory({
    cwd: tempDir,
    rootDir,
    name: 'Continue Project',
    mode: 'local-only',
    repos: [{ id: 'docs', remote: 'https://github.com/example/docs.git' }],
    bootstrap: {
      workflow: true,
      claude: true,
    },
  });
  return { tempDir, rootDir };
}

function currentSessionBlock(claudeContent) {
  const start = claudeContent.indexOf('## Current session');
  const fenceStart = claudeContent.indexOf('```', start);
  const fenceEnd = claudeContent.indexOf('```', fenceStart + 3);
  return claudeContent.slice(fenceStart + 3, fenceEnd);
}

test('continueProjectSession resumes the single active lane without renumbering or re-dating it (D-353)', async () => {
  const { tempDir, rootDir } = await createContinueSessionRoot('vibecompass-continue-single-');

  try {
    await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'billing-plans',
      workingOn: 'Build the billing plans lane.',
      date: '2026-04-20',
    });

    const first = await continueProjectSession({ cwd: tempDir, rootDir, date: '2026-04-22' });
    assert.equal(first.sessionId, 'billing-plans');
    assert.equal(first.selectionSource, 'single-lane');
    assert.equal(first.sessionDate, '2026-04-20');
    assert.equal(first.sessionNumber, 1);
    assert.equal(first.resumeDate, '2026-04-22');
    assert.equal(first.resumeCount, 1);
    assert.equal(first.laneAgeDays, 2);
    assert.equal(first.workingOn, 'Build the billing plans lane.');
    assert.equal(first.workingOnUpdated, false);
    assert.equal(first.runtime.port, 3100);
    assert.deepEqual(first.otherLanes, []);
    assert.ok(first.latestFinalizedSessionPath, 'the init note is reported as the latest finalized note');

    const sessionYaml = await readFile(path.join(rootDir, 'sessions/active/billing-plans/session.yaml'), 'utf8');
    assert.match(sessionYaml, /^session_date: 2026-04-20$/m);
    assert.match(sessionYaml, /^session_number: 1$/m);
    assert.match(sessionYaml, /^resumed_at: \d{4}-\d{2}-\d{2}T/m);
    assert.match(sessionYaml, /^resume_count: 1$/m);
    assert.equal((sessionYaml.match(/^resume_count:/gm) ?? []).length, 1);

    const wip = await readFile(path.join(rootDir, 'sessions/active/billing-plans/wip.md'), 'utf8');
    assert.match(wip, /^# WIP — 2026-04-20 \(session 1\)$/m);
    assert.match(wip, /^- Opened session 1\. Working on: Build the billing plans lane\.\n- Resumed lane on 2026-04-22 \(continue-session #1\)\n\n## Reviewer input needed/m);

    const claude = await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8');
    const block = currentSessionBlock(claude);
    assert.match(block, /^Date: 2026-04-20 \(session 1, lane billing-plans; resumed 2026-04-22\)$/m);
    assert.match(block, /^Working on: Build the billing plans lane\. \[billing-plans\]$/m);
    assert.match(block, /^Last thing completed: Project memory bootstrap completed\.$/m);

    const index = await readFile(path.join(rootDir, 'sessions/active/index.yaml'), 'utf8');
    assert.match(index, /^current: billing-plans$/m);

    // Second resume with a scope refresh: counter increments, working_on moves
    // through session.yaml, the index, wip.md, and CLAUDE.md; the block's
    // completed/blockers/next fields survive because they describe this lane.
    const second = await continueProjectSession({
      cwd: tempDir,
      rootDir,
      date: '2026-04-23',
      workingOn: 'Build the billing plans lane, phase 2.',
    });
    assert.equal(second.resumeCount, 2);
    assert.equal(second.workingOnUpdated, true);
    const sessionYamlAfter = await readFile(path.join(rootDir, 'sessions/active/billing-plans/session.yaml'), 'utf8');
    assert.match(sessionYamlAfter, /^working_on: "Build the billing plans lane, phase 2\."$/m);
    assert.match(sessionYamlAfter, /^resume_count: 2$/m);
    assert.equal((sessionYamlAfter.match(/^resumed_at:/gm) ?? []).length, 1);
    const wipAfter = await readFile(path.join(rootDir, 'sessions/active/billing-plans/wip.md'), 'utf8');
    assert.match(wipAfter, /^## Working on\nBuild the billing plans lane, phase 2\.\n\n## Log/m);
    assert.match(wipAfter, /^- Resumed lane on 2026-04-23 \(continue-session #2\)\. Working on updated: Build the billing plans lane, phase 2\.$/m);
    const listed = await listProjectSessions({ cwd: tempDir, rootDir });
    assert.equal(listed.lanes[0].workingOn, 'Build the billing plans lane, phase 2.');
    assert.equal(listed.lanes[0].resumeCount, 2);
    assert.match(listed.lanes[0].lastLogEntry, /^- Resumed lane on 2026-04-23/);
    assert.equal(listed.inventory.current, 'billing-plans');
    assert.equal(listed.inventory.lanes[0].isCurrentHint, true);
    const blockAfter = currentSessionBlock(await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8'));
    assert.match(blockAfter, /^Working on: Build the billing plans lane, phase 2\. \[billing-plans\]$/m);
    assert.match(blockAfter, /^Last thing completed: Project memory bootstrap completed\.$/m);

    // Closing still finalizes under the opening date and number.
    const closed = await closeProjectSession({
      cwd: tempDir,
      rootDir,
      title: 'Billing lane',
      completed: ['Done'],
      nextSteps: ['None'],
      documentMaintenance: DOCUMENT_MAINTENANCE_UPDATED,
    });
    assert.equal(closed.sessionDate, '2026-04-20');
    assert.equal(closed.sessionNumber, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('continueProjectSession fails closed with the lane inventory when multiple lanes are active', async () => {
  const { tempDir, rootDir } = await createContinueSessionRoot('vibecompass-continue-multi-');

  try {
    await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'billing-plans', workingOn: 'Build billing plans.', date: '2026-04-20' });
    await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'marketing-copy', workingOn: 'Build marketing copy.', date: '2026-04-21' });

    await assert.rejects(
      continueProjectSession({ cwd: tempDir, rootDir, date: '2026-04-22' }),
      (error) => {
        assert.match(error.message, /Multiple active session lanes exist; continue-session will not guess/);
        assert.match(error.message, /Active session lanes \(current hint: marketing-copy\):/);
        assert.match(error.message, /^- billing-plans: Build billing plans\.$/m);
        assert.match(error.message, /^\* marketing-copy: Build marketing copy\. \[current hint\]$/m);
        assert.match(error.message, /opened 2026-04-20 \(session 1\); port 3100/);
        assert.match(error.message, /last log: - Opened session 1\. Working on: Build marketing copy\./);
        assert.match(error.message, /`vibecompass continue-session <lane-id>`/);
        assert.match(error.message, /continuity hint, not a selection/);
        return true;
      },
    );
    // The refusal wrote nothing: no resume bookkeeping on either lane.
    for (const laneId of ['billing-plans', 'marketing-copy']) {
      const sessionYaml = await readFile(path.join(rootDir, `sessions/active/${laneId}/session.yaml`), 'utf8');
      assert.doesNotMatch(sessionYaml, /resume_count/);
    }

    await assert.rejects(
      continueProjectSession({ cwd: tempDir, rootDir, sessionId: 'unknown-lane' }),
      /Session lane "unknown-lane" is not an active lane/,
    );

    const resumed = await continueProjectSession({ cwd: tempDir, rootDir, sessionId: 'billing-plans', date: '2026-04-22' });
    assert.equal(resumed.sessionId, 'billing-plans');
    assert.equal(resumed.selectionSource, 'flag');
    assert.deepEqual(resumed.otherLanes.map((lane) => lane.id), ['marketing-copy']);
    const wip = await readFile(path.join(rootDir, 'sessions/active/billing-plans/wip.md'), 'utf8');
    assert.match(wip, /^- Resumed lane on 2026-04-22 \(continue-session #1; 1 other active lane: marketing-copy\)$/m);
    const index = await readFile(path.join(rootDir, 'sessions/active/index.yaml'), 'utf8');
    assert.match(index, /^current: billing-plans$/m);
    const block = currentSessionBlock(await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8'));
    assert.match(block, /^Active lanes:$/m);
    assert.match(block, /^- billing-plans — Build billing plans\. \[selected\]$/m);
    assert.match(block, /^Date: 2026-04-20 \(session 1, lane billing-plans; resumed 2026-04-22\)$/m);
    // The block previously described marketing-copy, so its fields are not carried over.
    assert.match(block, /^Last thing completed: Resumed lane billing-plans \(continue-session #1\)\.$/m);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('continueProjectSession follows a worktree lane marker and errors when nothing is active', async () => {
  const { tempDir, rootDir } = await createContinueSessionRoot('vibecompass-continue-marker-');

  try {
    await assert.rejects(
      continueProjectSession({ cwd: tempDir, rootDir }),
      /No active session lane exists to continue\. Open one with `vibecompass start-session/,
    );

    await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'lane-a', workingOn: 'Lane A.', date: '2026-04-20' });
    await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'lane-b', workingOn: 'Lane B.', date: '2026-04-20' });
    const worktreeDir = path.join(tempDir, 'worktrees', 'lane-a', 'docs');
    await mkdir(worktreeDir, { recursive: true });
    await writeLaneMarkerForSession({ cwd: tempDir, sessionId: 'lane-a', dir: worktreeDir });

    // Neither --root nor --session: the marker supplies both.
    const resumed = await continueProjectSession({ cwd: worktreeDir, date: '2026-04-21' });
    assert.equal(resumed.sessionId, 'lane-a');
    assert.equal(resumed.selectionSource, 'marker');
    assert.equal(resumed.rootDir, rootDir);
    assert.equal(resumed.claudePath, path.join(tempDir, 'CLAUDE.md'));

    // An explicit id still wins over the marker, with the D-277 override warning.
    const overridden = await continueProjectSession({ cwd: worktreeDir, sessionId: 'lane-b', date: '2026-04-21' });
    assert.equal(overridden.sessionId, 'lane-b');
    assert.match(overridden.warnings.join('\n'), /--session lane-b overrides the lane marker/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('startProjectSession fails closed on an existing lane id and points at continue-session', async () => {
  const { tempDir, rootDir } = await createContinueSessionRoot('vibecompass-continue-dup-');

  try {
    await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'lane-a', workingOn: 'Lane A.', date: '2026-04-20' });
    const indexBefore = await readFile(path.join(rootDir, 'sessions/active/index.yaml'), 'utf8');
    const claudeBefore = await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8');

    await assert.rejects(
      startProjectSession({ cwd: tempDir, rootDir, sessionId: 'lane-a', workingOn: 'Lane A again.', date: '2026-04-21' }),
      /Active session lane "lane-a" already exists\. Resume it with `vibecompass continue-session lane-a`/,
    );
    assert.equal(await readFile(path.join(rootDir, 'sessions/active/index.yaml'), 'utf8'), indexBefore);
    assert.equal(await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8'), claudeBefore);
    const wip = await readFile(path.join(rootDir, 'sessions/active/lane-a/wip.md'), 'utf8');
    assert.match(wip, /Working on: Lane A\.$/m);

    const second = await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'lane-b', workingOn: 'Lane B.', date: '2026-04-21' });
    assert.match(second.warnings.join('\n'), /1 lane is already active \(lane-a\)\. Opening a second lane is fine for new work; to resume existing work instead, run `vibecompass continue-session <lane-id>`/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runCli supports continue-session (text and --json) and list-sessions --json', async () => {
  const { tempDir, rootDir } = await createContinueSessionRoot('vibecompass-continue-cli-');
  const stdout = [];
  const stderr = [];
  const io = {
    stdout: { write(chunk) { stdout.push(chunk); } },
    stderr: { write(chunk) { stderr.push(chunk); } },
  };

  try {
    assert.equal(await runCli(['start-session', '--root', rootDir, '--id', 'lane-a', '--working-on', 'Lane A.', '--date', '2026-04-20'], io, { cwd: tempDir }), 0);
    assert.equal(await runCli(['start-session', '--root', rootDir, '--id', 'lane-b', '--working-on', 'Lane B.', '--date', '2026-04-20'], io, { cwd: tempDir }), 0);
    assert.match(stderr.join(''), /Warning: 1 lane is already active \(lane-a\)/);
    // The lifecycle brief is opt-in (D-368): an init'd root starts with it off.
    assert.match(stdout.join(''), /^Brief: off \(opt-in; project\.yaml does not set brief\.enabled: true\)$/m);
    await writeFile(path.join(rootDir, 'project.yaml'), `${await readFile(path.join(rootDir, 'project.yaml'), 'utf8')}brief:\n  enabled: true\n`);

    await assert.rejects(
      runCli(['continue-session', '--root', rootDir], io, { cwd: tempDir }),
      /Multiple active session lanes exist[\s\S]*\* lane-b: Lane B\. \[current hint\]/,
    );
    await assert.rejects(
      runCli(['continue-session', '--root', rootDir, 'lane-a', '--session', 'lane-b'], io, { cwd: tempDir }),
      /Conflicting lane IDs/,
    );

    stdout.length = 0;
    assert.equal(await runCli(['continue-session', '--root', rootDir, 'lane-a', '--date', '2026-04-22'], io, { cwd: tempDir }), 0);
    const text = stdout.join('');
    assert.match(text, /^Continued lane lane-a \(session 2026-04-20-1, resume #1, opened 2 days ago; selected via flag\)$/m);
    assert.match(text, /^Read next:\n- .*lane-a\/wip\.md\n- .*lane-a\/handoff\.md\n- .*lane-a\/brief\.md \(session brief — read before planning\)\n- .*\(latest finalized note\)$/m);
    assert.match(text, /eval "\$\(vibecompass lane-env --session lane-a\)"/);
    assert.match(text, /^Other active lanes \(1\) — pass --session lane-a to lane-scoped commands.*\n- lane-b: Lane B\.$/m);

    // With the brief off, the resume output keeps its pre-brief shape (D-364).
    stdout.length = 0;
    assert.equal(await runCli(['continue-session', '--root', rootDir, 'lane-b', '--date', '2026-04-22', '--no-brief'], io, { cwd: tempDir }), 0);
    const quiet = stdout.join('');
    assert.match(quiet, /^Read next:\n- .*lane-b\/wip\.md\n- .*lane-b\/handoff\.md\n- .*\(latest finalized note\)$/m);
    assert.match(quiet, /^Brief: off \(--no-brief\)$/m);

    stdout.length = 0;
    assert.equal(await runCli(['continue-session', '--root', rootDir, '--session', 'lane-a', '--date', '2026-04-23', '--json'], io, { cwd: tempDir }), 0);
    const json = JSON.parse(stdout.join(''));
    assert.equal(json.sessionId, 'lane-a');
    assert.equal(json.resumeCount, 2);
    assert.equal(json.sessionDate, '2026-04-20');
    assert.deepEqual(json.otherLanes.map((lane) => lane.id), ['lane-b']);
    assert.equal(json.brief.state, 'kept', 'resume bookkeeping (its own and lane-b\'s) does not make lane-a\'s brief stale');
    assert.equal('manifest' in json, false);
    assert.ok(Array.isArray(json.agentFileSync), 'JSON mode carries the agent-file sync results instead of printing them');

    stdout.length = 0;
    assert.equal(await runCli(['list-sessions', '--root', rootDir, '--json'], io, { cwd: tempDir }), 0);
    const inventory = JSON.parse(stdout.join(''));
    assert.equal(inventory.current, 'lane-a');
    assert.deepEqual(inventory.lanes.map((lane) => [lane.id, lane.resumeCount, lane.isCurrentHint]), [['lane-a', 2, true], ['lane-b', 1, false]]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('continueProjectSession writes --working-on literally even when it contains replacement tokens (review R1)', async () => {
  const { tempDir, rootDir } = await createContinueSessionRoot('vibecompass-continue-r1-');

  try {
    await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'lane-a', workingOn: 'Lane A.', date: '2026-04-20' });
    const scope = "Fix replacement $& $` $' $$ $1 handling";
    const result = await continueProjectSession({ cwd: tempDir, rootDir, date: '2026-04-21', workingOn: scope });
    assert.equal(result.workingOn, scope);

    const sessionYaml = await readFile(path.join(rootDir, 'sessions/active/lane-a/session.yaml'), 'utf8');
    assert.equal((sessionYaml.match(/^working_on/gm) ?? []).length, 1);
    assert.match(sessionYaml, /^working_on: "Fix replacement \$& \$` \$' \$\$ \$1 handling"$/m);
    const listed = await listProjectSessions({ cwd: tempDir, rootDir });
    assert.deepEqual(listed.lanes[0].warnings, []);
    assert.equal(listed.lanes[0].workingOn, scope);
    const wip = await readFile(path.join(rootDir, 'sessions/active/lane-a/wip.md'), 'utf8');
    assert.match(wip, /^## Working on\nFix replacement \$& \$` \$' \$\$ \$1 handling\n/m);
    const index = await readFile(path.join(rootDir, 'sessions/active/index.yaml'), 'utf8');
    assert.match(index, /working_on: "Fix replacement \$& \$` \$' \$\$ \$1 handling"/);
    const block = currentSessionBlock(await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8'));
    assert.match(block, /^Working on: Fix replacement \$& \$` \$' \$\$ \$1 handling \[lane-a\]$/m);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('continueProjectSession replaces spaced YAML keys in CRLF metadata instead of duplicating them (review R2)', async () => {
  const { tempDir, rootDir } = await createContinueSessionRoot('vibecompass-continue-r2-');

  try {
    await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'lane-a', workingOn: 'Lane A.', date: '2026-04-20' });
    const sessionFilePath = path.join(rootDir, 'sessions/active/lane-a/session.yaml');
    const original = await readFile(sessionFilePath, 'utf8');
    // Hand-edited shape the reader accepts: spaced keys, CRLF line endings, a
    // prior resume with spaced bookkeeping keys, and an unrelated custom key.
    const edited = `${original
      .replace(/^working_on: /m, 'working_on : ')
      .replace(/\n/g, '\r\n')}resume_count : 1\r\nresumed_at : 2026-04-20T10:00:00-07:00\r\ncustom_note : "keep me"\r\n`;
    await writeFile(sessionFilePath, edited, 'utf8');
    const before = await listProjectSessions({ cwd: tempDir, rootDir });
    assert.deepEqual(before.lanes[0].warnings, []);
    assert.equal(before.lanes[0].resumeCount, 1);

    const result = await continueProjectSession({ cwd: tempDir, rootDir, date: '2026-04-21', workingOn: 'Lane A, phase 2.' });
    assert.equal(result.resumeCount, 2);
    const sessionYaml = await readFile(sessionFilePath, 'utf8');
    for (const key of ['working_on', 'resume_count', 'resumed_at']) {
      assert.equal((sessionYaml.match(new RegExp(`^${key}[ \\t]*:`, 'gm')) ?? []).length, 1, `${key} must appear once`);
    }
    assert.match(sessionYaml, /^working_on: "Lane A, phase 2\."$/m);
    assert.match(sessionYaml, /^resume_count: 2$/m);
    assert.match(sessionYaml, /^custom_note : "keep me"\r?$/m);
    const after = await listProjectSessions({ cwd: tempDir, rootDir });
    assert.deepEqual(after.lanes[0].warnings, []);
    assert.equal(after.lanes[0].workingOn, 'Lane A, phase 2.');
    assert.equal(after.lanes[0].resumeCount, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('continueProjectSession carries Current-session fields only for the exact same lane id (review R3)', async () => {
  const { tempDir, rootDir } = await createContinueSessionRoot('vibecompass-continue-r3-');

  try {
    await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'billing', workingOn: 'Billing.', date: '2026-04-20' });
    await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'billing-tax',
      workingOn: 'Billing tax.',
      date: '2026-04-20',
      lastThingCompleted: 'Tax completed item.',
      blockers: 'Tax blocker.',
      nextSessionShould: 'Tax next step.',
    });
    const blockBefore = currentSessionBlock(await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8'));
    assert.match(blockBefore, /lane billing-tax\)/);

    const first = await continueProjectSession({ cwd: tempDir, rootDir, sessionId: 'billing', date: '2026-04-21' });
    assert.equal(first.sessionId, 'billing');
    const blockAfterFirst = currentSessionBlock(await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8'));
    assert.match(blockAfterFirst, /^Date: 2026-04-20 \(session 1, lane billing; resumed 2026-04-21\)$/m);
    assert.match(blockAfterFirst, /^Last thing completed: Resumed lane billing \(continue-session #1\)\.$/m);
    assert.match(blockAfterFirst, /^Blockers: No blocker recorded for the selected lane\.$/m);
    assert.doesNotMatch(blockAfterFirst, /Tax completed item|Tax blocker|Tax next step/);

    // A repeated resume of the same lane carries its own fields forward.
    await continueProjectSession({ cwd: tempDir, rootDir, sessionId: 'billing', date: '2026-04-22', blockers: 'Billing blocker.' });
    const blockAfterSecond = currentSessionBlock(await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8'));
    assert.match(blockAfterSecond, /^Last thing completed: Resumed lane billing \(continue-session #1\)\.$/m);
    assert.match(blockAfterSecond, /^Blockers: Billing blocker\.$/m);
    await continueProjectSession({ cwd: tempDir, rootDir, sessionId: 'billing', date: '2026-04-23' });
    const blockAfterThird = currentSessionBlock(await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8'));
    assert.match(blockAfterThird, /^Blockers: Billing blocker\.$/m);
    assert.match(blockAfterThird, /^Date: 2026-04-20 \(session 1, lane billing; resumed 2026-04-23\)$/m);

    // And resuming the prefix-sharing lane afterwards does not inherit billing's fields.
    await continueProjectSession({ cwd: tempDir, rootDir, sessionId: 'billing-tax', date: '2026-04-23' });
    const blockTax = currentSessionBlock(await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8'));
    assert.match(blockTax, /^Last thing completed: Resumed lane billing-tax \(continue-session #1\)\.$/m);
    assert.doesNotMatch(blockTax, /Billing blocker/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('continueProjectSession refuses before any write when CLAUDE.md is missing (review R4)', async () => {
  const { tempDir, rootDir } = await createContinueSessionRoot('vibecompass-continue-r4-');

  try {
    await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'lane-a', workingOn: 'Lane A.', date: '2026-04-20' });
    await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'lane-b', workingOn: 'Lane B.', date: '2026-04-20' });
    const paths = [
      path.join(rootDir, 'sessions/active/lane-a/session.yaml'),
      path.join(rootDir, 'sessions/active/lane-a/wip.md'),
      path.join(rootDir, 'sessions/active/lane-a/handoff.md'),
      path.join(rootDir, 'sessions/active/lane-b/session.yaml'),
      path.join(rootDir, 'sessions/active/index.yaml'),
    ];
    const snapshot = await Promise.all(paths.map((file) => readFile(file, 'utf8')));
    await rm(path.join(tempDir, 'CLAUDE.md'));

    await assert.rejects(
      continueProjectSession({ cwd: tempDir, rootDir, sessionId: 'lane-a', date: '2026-04-21', workingOn: 'Lane A, phase 2.' }),
      /CLAUDE\.md/,
    );
    const after = await Promise.all(paths.map((file) => readFile(file, 'utf8')));
    assert.deepEqual(after, snapshot, 'a refusal leaves every lane and index byte unchanged');
    assert.match(after[4], /^current: lane-b$/m);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('continueProjectSession returns the post-resume inventory that list-sessions reports (review S1)', async () => {
  const { tempDir, rootDir } = await createContinueSessionRoot('vibecompass-continue-s1-');

  try {
    await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'billing', workingOn: 'Billing.', date: '2026-04-20' });
    await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'billing-tax', workingOn: 'Billing tax.', date: '2026-04-20' });

    const result = await continueProjectSession({ cwd: tempDir, rootDir, sessionId: 'billing', date: '2026-04-21', workingOn: 'Billing, phase 2.' });
    assert.equal(result.inventory.current, 'billing');
    const entry = result.inventory.lanes.find((lane) => lane.id === 'billing');
    assert.equal(entry.resumeCount, 1);
    assert.equal(entry.workingOn, 'Billing, phase 2.');
    assert.equal(entry.isCurrentHint, true);
    assert.match(entry.lastLogEntry, /^- Resumed lane on 2026-04-21 \(continue-session #1; 1 other active lane: billing-tax\)/);
    assert.equal(typeof entry.resumedAt, 'string');
    assert.deepEqual(result.otherLanes.map((lane) => [lane.id, lane.isCurrentHint]), [['billing-tax', false]]);

    const listed = await listProjectSessions({ cwd: tempDir, rootDir });
    assert.deepEqual(result.inventory, listed.inventory);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('unknown-id refusal and start-session resume warning both render the lane inventory (review S2)', async () => {
  const { tempDir, rootDir } = await createContinueSessionRoot('vibecompass-continue-s2-');

  try {
    await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'lane-a', workingOn: 'Lane A.', date: '2026-04-20' });
    await assert.rejects(
      continueProjectSession({ cwd: tempDir, rootDir, sessionId: 'lane-zzz' }),
      (error) => {
        assert.match(error.message, /^Session lane "lane-zzz" is not an active lane in /);
        assert.match(error.message, /Active session lanes \(current hint: lane-a\):/);
        assert.match(error.message, /^\* lane-a: Lane A\. \[current hint\]$/m);
        assert.match(error.message, /opened 2026-04-20 \(session 1\); port 3100/);
        return true;
      },
    );

    const second = await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'lane-b', workingOn: 'Lane B.', date: '2026-04-20' });
    const warning = second.warnings.find((item) => /already active/.test(item));
    assert.ok(warning, 'start-session warns about the already-active lane');
    assert.match(warning, /^1 lane is already active \(lane-a\)\./);
    assert.match(warning, /\n {2}Active session lanes \(current hint: lane-a\):\n {2}\* lane-a: Lane A\. \[current hint\]\n {6}opened 2026-04-20 \(session 1\); port 3100/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('start-session --role records the lane role in session.yaml; builder is the default (D-392)', async () => {
  const { tempDir, rootDir } = await createContinueSessionRoot('vibecompass-role-start-');

  try {
    const builder = await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'build-lane', workingOn: 'Build.', date: '2026-04-20' });
    assert.equal(builder.role, 'builder');
    const builderYaml = await readFile(path.join(rootDir, 'sessions/active/build-lane/session.yaml'), 'utf8');
    assert.match(builderYaml, /^role: "builder"$/m);

    const manager = await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'plan-refresh',
      workingOn: 'Refresh the plan.',
      role: 'project-manager',
      date: '2026-04-20',
    });
    assert.equal(manager.role, 'project-manager');
    const managerYaml = await readFile(path.join(rootDir, 'sessions/active/plan-refresh/session.yaml'), 'utf8');
    assert.match(managerYaml, /^role: "project-manager"$/m);
    assert.equal((managerYaml.match(/^role:/gm) ?? []).length, 1);

    const listed = await listProjectSessions({ cwd: tempDir, rootDir });
    assert.deepEqual(listed.lanes.map((lane) => [lane.id, lane.role]), [['build-lane', 'builder'], ['plan-refresh', 'project-manager']]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('start-session refuses an unknown --role before any write (D-392)', async () => {
  const { tempDir, rootDir } = await createContinueSessionRoot('vibecompass-role-invalid-');

  try {
    await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'lane-a', workingOn: 'Lane A.', date: '2026-04-20' });
    const indexBefore = await readFile(path.join(rootDir, 'sessions/active/index.yaml'), 'utf8');
    const claudeBefore = await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8');

    for (const role of ['reviewer', 'Project-Manager', '']) {
      await assert.rejects(
        startProjectSession({ cwd: tempDir, rootDir, sessionId: 'lane-b', workingOn: 'Lane B.', role, date: '2026-04-20' }),
        /Unknown lane role .*--role takes builder or project-manager \(default builder; D-392\)/,
      );
    }
    await assert.rejects(() => access(path.join(rootDir, 'sessions/active/lane-b')));
    assert.equal(await readFile(path.join(rootDir, 'sessions/active/index.yaml'), 'utf8'), indexBefore);
    assert.equal(await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8'), claudeBefore);

    const stderr = [];
    await assert.rejects(
      runCli(
        ['start-session', '--root', rootDir, '--id', 'lane-c', '--working-on', 'Lane C.', '--role', 'owner'],
        { stdout: { write() {} }, stderr: { write(chunk) { stderr.push(chunk); } } },
        { cwd: tempDir },
      ),
      /Unknown lane role "owner"/,
    );
    await assert.rejects(() => access(path.join(rootDir, 'sessions/active/lane-c')));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('a lane without a role field is a builder lane in the inventory and on resume (D-392)', async () => {
  const { tempDir, rootDir } = await createContinueSessionRoot('vibecompass-role-legacy-');

  try {
    await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'legacy-lane', workingOn: 'Opened before roles.', date: '2026-04-20' });
    const sessionFilePath = path.join(rootDir, 'sessions/active/legacy-lane/session.yaml');
    await writeFile(sessionFilePath, (await readFile(sessionFilePath, 'utf8')).replace(/^role: .*\n/m, ''), 'utf8');
    assert.doesNotMatch(await readFile(sessionFilePath, 'utf8'), /^role:/m);

    const listed = await listProjectSessions({ cwd: tempDir, rootDir });
    assert.equal(listed.lanes[0].role, 'builder');
    assert.equal(listed.inventory.lanes[0].role, 'builder');

    const resumed = await continueProjectSession({ cwd: tempDir, rootDir, date: '2026-04-21' });
    assert.equal(resumed.role, 'builder');
    // Resume writes its bookkeeping and never adds or changes a role.
    assert.doesNotMatch(await readFile(sessionFilePath, 'utf8'), /^role:/m);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('list-sessions names a project-manager lane\'s role in text and gives every lane a role in JSON (D-392)', async () => {
  const { tempDir, rootDir } = await createContinueSessionRoot('vibecompass-role-inventory-');
  const stdout = [];
  const io = {
    stdout: { write(chunk) { stdout.push(chunk); } },
    stderr: { write() {} },
  };

  try {
    assert.equal(await runCli(['start-session', '--root', rootDir, '--id', 'build-lane', '--working-on', 'Build.', '--date', '2026-04-20'], io, { cwd: tempDir }), 0);
    assert.match(stdout.join(''), /^Role: builder$/m);
    stdout.length = 0;
    assert.equal(await runCli(['start-session', '--root', rootDir, '--id', 'plan-refresh', '--working-on', 'Refresh the plan.', '--role', 'project-manager', '--date', '2026-04-20'], io, { cwd: tempDir }), 0);
    assert.match(stdout.join(''), /^Role: project-manager$/m);

    stdout.length = 0;
    assert.equal(await runCli(['list-sessions', '--root', rootDir], io, { cwd: tempDir }), 0);
    const text = stdout.join('');
    assert.match(text, /^- build-lane: Build\.\n {4}opened 2026-04-20 \(session 1\); port 3100$/m);
    assert.match(text, /^\* plan-refresh: Refresh the plan\. \[current hint\]\n {4}role project-manager; opened 2026-04-20 \(session 2\); port 3101$/m);

    stdout.length = 0;
    assert.equal(await runCli(['list-sessions', '--root', rootDir, '--json'], io, { cwd: tempDir }), 0);
    const inventory = JSON.parse(stdout.join(''));
    assert.deepEqual(inventory.lanes.map((lane) => [lane.id, lane.role]), [['build-lane', 'builder'], ['plan-refresh', 'project-manager']]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('continue-session prints the role it resumed and takes no --role (D-392)', async () => {
  const { tempDir, rootDir } = await createContinueSessionRoot('vibecompass-role-resume-');
  const stdout = [];
  const io = {
    stdout: { write(chunk) { stdout.push(chunk); } },
    stderr: { write() {} },
  };

  try {
    await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'plan-refresh', workingOn: 'Refresh the plan.', role: 'project-manager', date: '2026-04-20' });
    const sessionFilePath = path.join(rootDir, 'sessions/active/plan-refresh/session.yaml');

    assert.equal(await runCli(['continue-session', '--root', rootDir, '--date', '2026-04-21'], io, { cwd: tempDir }), 0);
    assert.match(stdout.join(''), /^Role: project-manager — resume as project manager: change canonical memory only in this lane, write no product code, and leave other lanes' scratch alone \(D-392\)\.$/m);

    stdout.length = 0;
    assert.equal(await runCli(['continue-session', '--root', rootDir, '--date', '2026-04-22', '--json'], io, { cwd: tempDir }), 0);
    assert.equal(JSON.parse(stdout.join('')).role, 'project-manager');

    await assert.rejects(
      runCli(['continue-session', '--root', rootDir, '--role', 'builder'], io, { cwd: tempDir }),
      /continue-session takes no --role: a lane keeps the role it was opened with, and no command changes it \(D-392\)/,
    );
    const sessionYaml = await readFile(sessionFilePath, 'utf8');
    assert.match(sessionYaml, /^role: "project-manager"$/m);
    assert.match(sessionYaml, /^resume_count: 2$/m);

    await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'build-lane', workingOn: 'Build.', date: '2026-04-21' });
    stdout.length = 0;
    assert.equal(await runCli(['continue-session', '--root', rootDir, 'build-lane', '--date', '2026-04-22'], io, { cwd: tempDir }), 0);
    assert.match(stdout.join(''), /^Role: builder$/m);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('resume selects a lane by --session or worktree marker whatever its role, and refuses without a selection (D-392, D-277)', async () => {
  const { tempDir, rootDir } = await createContinueSessionRoot('vibecompass-role-selection-');

  try {
    await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'build-lane', workingOn: 'Build.', date: '2026-04-20' });
    await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'plan-refresh', workingOn: 'Refresh the plan.', role: 'project-manager', date: '2026-04-20' });

    // One builder lane and one project-manager lane, nothing selected: the
    // command refuses and prints the inventory with the manager lane's role.
    await assert.rejects(
      continueProjectSession({ cwd: tempDir, rootDir, date: '2026-04-21' }),
      (error) => {
        assert.match(error.message, /Multiple active session lanes exist; continue-session will not guess/);
        assert.match(error.message, /^- build-lane: Build\.\n {4}opened 2026-04-20 \(session 1\); port 3100$/m);
        assert.match(error.message, /^\* plan-refresh: Refresh the plan\. \[current hint\]\n {4}role project-manager; opened 2026-04-20 \(session 2\); port 3101$/m);
        return true;
      },
    );
    for (const laneId of ['build-lane', 'plan-refresh']) {
      const sessionYaml = await readFile(path.join(rootDir, `sessions/active/${laneId}/session.yaml`), 'utf8');
      assert.doesNotMatch(sessionYaml, /resume_count/, 'the refusal wrote nothing');
    }

    // An explicit --session selects either lane, in its recorded role.
    const manager = await continueProjectSession({ cwd: tempDir, rootDir, sessionId: 'plan-refresh', date: '2026-04-21' });
    assert.deepEqual([manager.sessionId, manager.role, manager.selectionSource], ['plan-refresh', 'project-manager', 'flag']);
    const builder = await continueProjectSession({ cwd: tempDir, rootDir, sessionId: 'build-lane', date: '2026-04-21' });
    assert.deepEqual([builder.sessionId, builder.role, builder.selectionSource], ['build-lane', 'builder', 'flag']);

    // A worktree marker selects the lane it binds, whatever its role.
    for (const [laneId, role] of [['plan-refresh', 'project-manager'], ['build-lane', 'builder']]) {
      const markedDir = path.join(tempDir, 'worktrees', laneId, 'docs');
      await mkdir(markedDir, { recursive: true });
      await writeLaneMarkerForSession({ cwd: tempDir, rootDir, sessionId: laneId, dir: markedDir });
      const resumed = await continueProjectSession({ cwd: markedDir, date: '2026-04-22' });
      assert.deepEqual([resumed.sessionId, resumed.role, resumed.selectionSource], [laneId, role, 'marker']);
    }

    // The explicit flag still wins over the marker.
    const markedManagerDir = path.join(tempDir, 'worktrees', 'plan-refresh', 'docs');
    const overridden = await continueProjectSession({ cwd: markedManagerDir, sessionId: 'build-lane', date: '2026-04-22' });
    assert.deepEqual([overridden.sessionId, overridden.role, overridden.selectionSource], ['build-lane', 'builder', 'flag']);
    assert.match(overridden.warnings.join('\n'), /--session build-lane overrides the lane marker/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// D-395: the lane–task link. A plan is an architecture doc whose ## Next steps
// holds D-393 task lines.
const PLAN_TASK_PLAN = 'architecture/platform/plan.md';
const PLAN_TASK_OTHER_PLAN = 'architecture/platform/other-plan.md';

async function createPlanTaskRoot(prefix) {
  const root = await createContinueSessionRoot(prefix);
  await mkdir(path.join(root.rootDir, 'architecture/platform'), { recursive: true });
  await writeFile(path.join(root.rootDir, PLAN_TASK_PLAN), [
    '---',
    'domain: Platform',
    'feature: Plans',
    'component: Plan',
    'status: In progress',
    '---',
    '',
    '## Description',
    'A plan.',
    '',
    '## Next steps',
    '**Track (a bold label)**',
    '- [x] PM1 — Done.',
    '  *Done 2026-10-21.*',
    '- [ ] PM2 — Open:',
    '  - [ ] PM9 — a nested subtask',
    '- [ ] PM3 — Also open.',
    '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(root.rootDir, PLAN_TASK_OTHER_PLAN), [
    '---',
    'domain: Platform',
    'feature: Plans',
    'component: Other plan',
    'status: In progress',
    '---',
    '',
    '## Description',
    'Another plan whose IDs collide with the first.',
    '',
    '## Next steps',
    '- [ ] PM2 — The other plan\'s PM2.',
    '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(root.rootDir, 'decisions/plan.md'), '## Next steps\n- [ ] PM2 — not under architecture/\n', 'utf8');
  return root;
}

function captureIo() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    io: { stdout: { write(chunk) { stdout.push(chunk); } }, stderr: { write(chunk) { stderr.push(chunk); } } },
  };
}

test('start-session --plan-task links plan tasks: plan_tasks in session.yaml, the plan joins architecture_docs, a repeat is stored once (D-395)', async () => {
  const { tempDir, rootDir } = await createPlanTaskRoot('vibecompass-plan-task-start-');

  try {
    const result = await startProjectSession({
      cwd: tempDir,
      rootDir,
      sessionId: 'pm-lane',
      workingOn: 'Build PM2 and PM3.',
      planTasks: [`${PLAN_TASK_PLAN}#PM2`, `${PLAN_TASK_PLAN}#PM3`, `./${PLAN_TASK_PLAN}#PM2`, `${PLAN_TASK_OTHER_PLAN}#PM2`],
      architectureDocs: [PLAN_TASK_PLAN],
      date: '2026-04-20',
    });
    assert.deepEqual(result.planTasks, [`${PLAN_TASK_PLAN}#PM2`, `${PLAN_TASK_PLAN}#PM3`, `${PLAN_TASK_OTHER_PLAN}#PM2`]);
    assert.ok(!result.warnings.some((warning) => /--plan-task/.test(warning)), 'no ticked task, no warning');

    const yaml = await readFile(path.join(rootDir, 'sessions/active/pm-lane/session.yaml'), 'utf8');
    assert.match(yaml, new RegExp(`^plan_tasks:\\n  - "${PLAN_TASK_PLAN}#PM2"\\n  - "${PLAN_TASK_PLAN}#PM3"\\n  - "${PLAN_TASK_OTHER_PLAN}#PM2"\\n`, 'm'));
    // The plan named with --architecture-doc isn't repeated; the other plan joins.
    assert.match(yaml, new RegExp(`^architecture_docs:\\n  - "${PLAN_TASK_PLAN}"\\n  - "${PLAN_TASK_OTHER_PLAN}"\\n`, 'm'));

    // A lane with no links records an empty list, and the brief's inputs and
    // the overlap warnings see the plan through architecture_docs.
    const second = await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'docs-lane', workingOn: 'Docs.', planTasks: [`${PLAN_TASK_PLAN}#PM3`], date: '2026-04-20' });
    assert.ok(second.warnings.some((warning) => warning.includes(PLAN_TASK_PLAN) && /pm-lane/.test(warning)), 'the plan overlaps the first lane');
    const plain = await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'plain-lane', workingOn: 'No links.', date: '2026-04-20' });
    assert.deepEqual(plain.planTasks, []);
    assert.match(await readFile(path.join(rootDir, 'sessions/active/plain-lane/session.yaml'), 'utf8'), /^plan_tasks: \[\]$/m);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('start-session --plan-task on a ticked task warns and keeps the link (D-395)', async () => {
  const { tempDir, rootDir } = await createPlanTaskRoot('vibecompass-plan-task-ticked-');
  const { stdout, stderr, io } = captureIo();

  try {
    assert.equal(await runCli(['start-session', '--root', rootDir, '--id', 'follow-up', '--working-on', 'Follow up PM1.', '--plan-task', `${PLAN_TASK_PLAN}#PM1`, '--date', '2026-04-20'], io, { cwd: tempDir }), 0);
    const text = stdout.join('');
    assert.match(text, new RegExp(`^Plan tasks: ${PLAN_TASK_PLAN}#PM1$`, 'm'));
    assert.match(stderr.join(''), new RegExp(`^Warning: --plan-task "${PLAN_TASK_PLAN}#PM1" names a ticked task: PM1 is marked done in ${PLAN_TASK_PLAN}\\. The link is kept, since a follow-up lane on a done task is fine \\(D-395\\)\\.$`, 'm'));
    assert.match(await readFile(path.join(rootDir, 'sessions/active/follow-up/session.yaml'), 'utf8'), new RegExp(`^plan_tasks:\\n  - "${PLAN_TASK_PLAN}#PM1"$`, 'm'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('start-session refuses a bad --plan-task before any write and names the problem (D-395)', async () => {
  const { tempDir, rootDir } = await createPlanTaskRoot('vibecompass-plan-task-refuse-');
  const { io } = captureIo();

  try {
    await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'lane-a', workingOn: 'Lane A.', date: '2026-04-20' });
    const indexBefore = await readFile(path.join(rootDir, 'sessions/active/index.yaml'), 'utf8');
    const claudeBefore = await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8');

    const refusals = [
      ['an unknown path', 'architecture/platform/missing.md#PM2', /architecture\/platform\/missing\.md doesn't exist in the project-memory root/],
      ['a path outside architecture/', 'decisions/plan.md#PM2', /decisions\/plan\.md is outside architecture\/\. A plan is an architecture doc \(D-393, D-395\)/],
      ['an unknown ID', `${PLAN_TASK_PLAN}#PM7`, /has no task line for PM7 under ## Next steps\. Its task IDs: PM1, PM2, PM3\./],
      ['a nested subtask', `${PLAN_TASK_PLAN}#PM9`, /has no task line for PM9 under ## Next steps/],
      ['an ID with a bad shape', `${PLAN_TASK_PLAN}#pm2`, /"pm2" isn't a task ID\. An ID is 1–6 capital letters, then 1–3 digits/],
      ['no ID', PLAN_TASK_PLAN, /has no #<ID>/],
    ];
    for (const [label, ref, pattern] of refusals) {
      await assert.rejects(
        startProjectSession({ cwd: tempDir, rootDir, sessionId: 'lane-b', workingOn: 'Lane B.', planTasks: [`${PLAN_TASK_PLAN}#PM2`, ref], date: '2026-04-20' }),
        pattern,
        label,
      );
      await assert.rejects(
        runCli(['start-session', '--root', rootDir, '--id', 'lane-c', '--working-on', 'Lane C.', '--plan-task', ref], io, { cwd: tempDir }),
        pattern,
        `${label} (CLI)`,
      );
    }
    for (const laneId of ['lane-b', 'lane-c']) {
      await assert.rejects(() => access(path.join(rootDir, 'sessions/active', laneId)), `${laneId} was not created`);
    }
    assert.equal(await readFile(path.join(rootDir, 'sessions/active/index.yaml'), 'utf8'), indexBefore);
    assert.equal(await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8'), claudeBefore);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('continue-session --plan-task adds links in place, keeps every other field, and refuses a bad ref before any write (D-395)', async () => {
  const { tempDir, rootDir } = await createPlanTaskRoot('vibecompass-plan-task-resume-');
  const { stdout, io } = captureIo();

  try {
    await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'pm-lane', workingOn: 'Build PM2.', planTasks: [`${PLAN_TASK_PLAN}#PM2`], date: '2026-04-20' });
    const sessionFilePath = path.join(rootDir, 'sessions/active/pm-lane/session.yaml');
    const wipFilePath = path.join(rootDir, 'sessions/active/pm-lane/wip.md');
    // A key this package doesn't know, which the in-place update must keep.
    await writeFile(sessionFilePath, `${await readFile(sessionFilePath, 'utf8')}future_field: "kept"\n`, 'utf8');
    const yamlBefore = await readFile(sessionFilePath, 'utf8');
    const wipBefore = await readFile(wipFilePath, 'utf8');
    const indexBefore = await readFile(path.join(rootDir, 'sessions/active/index.yaml'), 'utf8');

    await assert.rejects(
      runCli(['continue-session', '--root', rootDir, '--plan-task', `${PLAN_TASK_PLAN}#PM3`, '--plan-task', `${PLAN_TASK_PLAN}#PM8`], io, { cwd: tempDir }),
      /has no task line for PM8 under ## Next steps/,
    );
    assert.equal(await readFile(sessionFilePath, 'utf8'), yamlBefore, 'the refusal wrote nothing to session.yaml');
    assert.equal(await readFile(wipFilePath, 'utf8'), wipBefore, 'or wip.md');
    assert.equal(await readFile(path.join(rootDir, 'sessions/active/index.yaml'), 'utf8'), indexBefore, 'or the index');

    stdout.length = 0;
    assert.equal(await runCli(['continue-session', '--root', rootDir, '--plan-task', `${PLAN_TASK_PLAN}#PM2`, '--plan-task', `${PLAN_TASK_OTHER_PLAN}#PM2`, '--date', '2026-04-21'], io, { cwd: tempDir }), 0);
    assert.match(stdout.join(''), new RegExp(`^Plan tasks: ${PLAN_TASK_PLAN}#PM2, ${PLAN_TASK_OTHER_PLAN}#PM2 \\(added\\)$`, 'm'));

    const yamlAfter = await readFile(sessionFilePath, 'utf8');
    assert.match(yamlAfter, new RegExp(`^plan_tasks:\\n  - "${PLAN_TASK_PLAN}#PM2"\\n  - "${PLAN_TASK_OTHER_PLAN}#PM2"\\n`, 'm'));
    assert.match(yamlAfter, new RegExp(`^architecture_docs:\\n  - "${PLAN_TASK_PLAN}"\\n  - "${PLAN_TASK_OTHER_PLAN}"\\n`, 'm'));
    // Every other line is as it was, in order, apart from the resume bookkeeping.
    const withoutChanges = (content) => content
      .split('\n')
      .filter((line) => !line.includes(PLAN_TASK_OTHER_PLAN) && !/^(resumed_at|resume_count):/.test(line));
    assert.deepEqual(withoutChanges(yamlAfter), withoutChanges(yamlBefore));
    assert.match(yamlAfter, /^future_field: "kept"$/m);
    assert.match(await readFile(wipFilePath, 'utf8'), new RegExp(`^- Resumed lane on 2026-04-21 \\(continue-session #1\\)\\. Plan tasks linked: ${PLAN_TASK_OTHER_PLAN}#PM2$`, 'm'));

    // A resume with nothing new rewrites neither list.
    const json = await continueProjectSession({ cwd: tempDir, rootDir, planTasks: [`${PLAN_TASK_OTHER_PLAN}#PM2`], date: '2026-04-22' });
    assert.deepEqual(json.planTasks, [`${PLAN_TASK_PLAN}#PM2`, `${PLAN_TASK_OTHER_PLAN}#PM2`]);
    assert.deepEqual(json.planTasksAdded, []);
    assert.deepEqual(withoutChanges(await readFile(sessionFilePath, 'utf8')), withoutChanges(yamlAfter));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('continue-session --plan-task keeps a CRLF session.yaml\'s line endings (D-395)', async () => {
  const { tempDir, rootDir } = await createPlanTaskRoot('vibecompass-plan-task-crlf-');

  try {
    await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'crlf-lane', workingOn: 'CRLF.', date: '2026-04-20' });
    const sessionFilePath = path.join(rootDir, 'sessions/active/crlf-lane/session.yaml');
    await writeFile(sessionFilePath, (await readFile(sessionFilePath, 'utf8')).replace(/\n/g, '\r\n'), 'utf8');

    const resumed = await continueProjectSession({ cwd: tempDir, rootDir, planTasks: [`${PLAN_TASK_PLAN}#PM3`], date: '2026-04-21' });
    assert.deepEqual(resumed.planTasksAdded, [`${PLAN_TASK_PLAN}#PM3`]);
    const yaml = await readFile(sessionFilePath, 'utf8');
    assert.doesNotMatch(yaml, /[^\r]\n/, 'every line ends in CRLF');
    assert.match(yaml, new RegExp(`plan_tasks:\\r\\n  - "${PLAN_TASK_PLAN}#PM3"\\r\\n`));
    assert.match(yaml, new RegExp(`architecture_docs:\\r\\n  - "${PLAN_TASK_PLAN}"\\r\\n`));
    const listed = await listProjectSessions({ cwd: tempDir, rootDir });
    assert.deepEqual(listed.lanes[0].planTasks, [`${PLAN_TASK_PLAN}#PM3`]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('a lane whose session.yaml has no plan_tasks has no links, and a resume can add the first (D-395)', async () => {
  const { tempDir, rootDir } = await createPlanTaskRoot('vibecompass-plan-task-legacy-');

  try {
    await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'older-lane', workingOn: 'Opened before PM6.', date: '2026-04-20' });
    const sessionFilePath = path.join(rootDir, 'sessions/active/older-lane/session.yaml');
    await writeFile(sessionFilePath, (await readFile(sessionFilePath, 'utf8')).replace(/^plan_tasks: \[\]\n/m, ''), 'utf8');
    assert.doesNotMatch(await readFile(sessionFilePath, 'utf8'), /^plan_tasks:/m);

    const listed = await listProjectSessions({ cwd: tempDir, rootDir });
    assert.deepEqual(listed.lanes[0].planTasks, []);
    assert.deepEqual(listed.inventory.lanes[0].planTasks, []);

    const resumed = await continueProjectSession({ cwd: tempDir, rootDir, date: '2026-04-21' });
    assert.deepEqual(resumed.planTasks, []);
    assert.doesNotMatch(await readFile(sessionFilePath, 'utf8'), /^plan_tasks:/m, 'a resume without --plan-task adds no field');

    const linked = await continueProjectSession({ cwd: tempDir, rootDir, planTasks: [`${PLAN_TASK_PLAN}#PM2`], date: '2026-04-22' });
    assert.deepEqual(linked.planTasksAdded, [`${PLAN_TASK_PLAN}#PM2`]);
    assert.match(await readFile(sessionFilePath, 'utf8'), new RegExp(`^plan_tasks:\\n  - "${PLAN_TASK_PLAN}#PM2"$`, 'm'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('list-sessions and continue-session\'s inventory print a tasks line under a linked lane; --json gives every lane planTasks (D-395)', async () => {
  const { tempDir, rootDir } = await createPlanTaskRoot('vibecompass-plan-task-inventory-');
  const { stdout, io } = captureIo();

  try {
    await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'linked-lane', workingOn: 'Linked.', planTasks: [`${PLAN_TASK_PLAN}#PM2`, `${PLAN_TASK_OTHER_PLAN}#PM2`], date: '2026-04-20' });
    await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'plain-lane', workingOn: 'Plain.', date: '2026-04-20' });

    assert.equal(await runCli(['list-sessions', '--root', rootDir], io, { cwd: tempDir }), 0);
    const text = stdout.join('');
    assert.match(text, new RegExp(`^- linked-lane: Linked\\.\\n {4}opened 2026-04-20 \\(session 1\\); port 3100\\n {4}tasks: ${PLAN_TASK_PLAN}#PM2, ${PLAN_TASK_OTHER_PLAN}#PM2\\n`, 'm'));
    assert.match(text, /^\* plain-lane: Plain\. \[current hint\]\n {4}opened 2026-04-20 \(session 2\); port 3101$/m);
    assert.equal((text.match(/tasks:/g) ?? []).length, 1, 'an unlinked lane has no tasks line');

    stdout.length = 0;
    assert.equal(await runCli(['list-sessions', '--root', rootDir, '--json'], io, { cwd: tempDir }), 0);
    const inventory = JSON.parse(stdout.join(''));
    assert.deepEqual(inventory.lanes.map((lane) => [lane.id, lane.planTasks]), [
      ['linked-lane', [{ plan: PLAN_TASK_PLAN, id: 'PM2' }, { plan: PLAN_TASK_OTHER_PLAN, id: 'PM2' }]],
      ['plain-lane', []],
    ]);

    // The inventory continue-session prints when it won't guess carries the line too.
    await assert.rejects(
      continueProjectSession({ cwd: tempDir, rootDir, date: '2026-04-21' }),
      (error) => {
        assert.match(error.message, new RegExp(`^ {4}tasks: ${PLAN_TASK_PLAN}#PM2, ${PLAN_TASK_OTHER_PLAN}#PM2$`, 'm'));
        return true;
      },
    );
    stdout.length = 0;
    assert.equal(await runCli(['continue-session', '--root', rootDir, 'plain-lane', '--json', '--date', '2026-04-21'], io, { cwd: tempDir }), 0);
    const resumed = JSON.parse(stdout.join(''));
    assert.deepEqual(resumed.planTasks, []);
    assert.deepEqual(resumed.otherLanes[0].planTasks, [{ plan: PLAN_TASK_PLAN, id: 'PM2' }, { plan: PLAN_TASK_OTHER_PLAN, id: 'PM2' }]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('close-session writes ## Plan tasks after ## What we worked on, prints the tick reminder, and ticks nothing (D-395)', async () => {
  const { tempDir, rootDir } = await createPlanTaskRoot('vibecompass-plan-task-close-');
  const { stdout, io } = captureIo();
  const closeArgs = (laneId, title) => ['close-session', '--root', rootDir, '--session', laneId, '--title', title, '--completed', 'Done.', '--next-step', 'Next.', ...CLI_DOCUMENT_MAINTENANCE_UPDATED];

  try {
    await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'linked-lane', workingOn: 'Build PM2.', planTasks: [`${PLAN_TASK_PLAN}#PM2`], date: '2026-04-20' });
    await continueProjectSession({ cwd: tempDir, rootDir, sessionId: 'linked-lane', planTasks: [`${PLAN_TASK_PLAN}#PM1`], date: '2026-04-20' });
    await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'plain-lane', workingOn: 'No links.', date: '2026-04-20' });
    const planBefore = await readFile(path.join(rootDir, PLAN_TASK_PLAN), 'utf8');

    assert.equal(await runCli(closeArgs('linked-lane', 'Linked Lane'), io, { cwd: tempDir }), 0);
    const text = stdout.join('');
    assert.match(text, new RegExp(`^Plan tasks \\(D-395\\): the note's ## Plan tasks lists the tasks this lane linked\\. close-session ticks nothing: tick each one in its plan once its work is merged and verified, or annotate it:\\n- ${PLAN_TASK_PLAN}#PM2\\n- ${PLAN_TASK_PLAN}#PM1\\n`, 'm'));
    const note = await readFile(path.join(rootDir, 'sessions/2026-04-20-1-linked-lane.md'), 'utf8');
    assert.match(note, new RegExp(`\\n## What we worked on\\nBuild PM2\\.\\n\\n## Plan tasks\\n- ${PLAN_TASK_PLAN}#PM2\\n- ${PLAN_TASK_PLAN}#PM1\\n\\n## Completed\\n`));
    assert.equal(await readFile(path.join(rootDir, PLAN_TASK_PLAN), 'utf8'), planBefore, 'close-session ticks nothing');

    stdout.length = 0;
    assert.equal(await runCli(closeArgs('plain-lane', 'Plain Lane'), io, { cwd: tempDir }), 0);
    assert.doesNotMatch(stdout.join(''), /Plan tasks/);
    const plainNote = await readFile(path.join(rootDir, 'sessions/2026-04-20-2-plain-lane.md'), 'utf8');
    assert.doesNotMatch(plainNote, /## Plan tasks/);
    assert.match(plainNote, /\n## What we worked on\nNo links\.\n\n## Completed\n/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('help lists --plan-task for start-session and continue-session, and append-decision\'s --session (D-395)', async () => {
  const { stdout, io } = captureIo();
  assert.equal(await runCli(['--help'], io, {}), 0);
  const help = stdout.join('');
  assert.match(help, /vibecompass start-session --id <lane-id> --working-on <text> \[--role <builder\|project-manager>\] \[--plan-task "<plan-path>#<ID>"\.\.\.\]/);
  assert.match(help, /vibecompass continue-session \[<lane-id>\] \[--session <lane-id>\] \[--working-on <text>\] \[--plan-task "<plan-path>#<ID>"\.\.\.\]/);
  assert.match(help, /^ {2}--plan-task "<plan-path>#<ID>" {7}Repeatable plan task the lane works on \(D-395\).*quote it, since # is a glob character in zsh$/m);
  assert.match(help, /^ {2}--plan-task "<plan-path>#<ID>" {7}Repeatable: link another plan task, validated as start-session does \(D-395\); links are only added, never removed$/m);
  assert.match(help, /planTasks, a list of \{ plan, id \}, D-395/);
  const decisionLog = help.slice(help.indexOf('Decision-log options'), help.indexOf('Refresh-decision-index options'));
  assert.match(decisionLog, /^ {2}--session <lane-id> {18}append-decision: lane whose date\/session\/id labels the index group/m);
});
