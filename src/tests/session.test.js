import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeProjectMemory } from '../init.js';
import { runCli } from '../cli.js';
import { closeProjectSession, listProjectSessions, startProjectSession, switchProjectSession } from '../session.js';

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
    assert.ok(result.workflowGuidance.includes('Refresh any relevant decision files before finalizing the session.'));
    assert.ok(result.workflowGuidance.includes('This workflow includes a Git publish step after close-session; review, commit, and push to origin.'));
    assert.ok(result.workflowGuidance.includes('Use commit message format: docs(session): YYYY-MM-DD-N — <summary>'));
    assert.equal(result.docsUpdatePlan.session.id, 'workflow-parity');
    assert.deepEqual(result.docsUpdatePlan.delta.changedFiles, []);
    assert.equal(result.agentFileSync.results.find((item) => item.format === 'claude_md')?.status, 'update');
    assert.equal(result.agentFileSync.results.find((item) => item.format === 'agents_md')?.status, 'update');
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
