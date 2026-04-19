import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  getDecisionLog,
  getFeatureContext,
  getFileContext,
  getProjectContext,
  loadProjectReadModel,
} from '../index.js';
import { initializeProjectMemory } from '../init.js';

test('loadProjectReadModel builds grouped feature, decision, session, and file ownership views', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-read-model-'));

  try {
    await mkdir(path.join(rootDir, 'architecture/platform/project-memory'), { recursive: true });
    await mkdir(path.join(rootDir, 'decisions'), { recursive: true });
    await mkdir(path.join(rootDir, 'sessions'), { recursive: true });

    await initializeProjectMemory({
      rootDir,
      force: true,
      name: 'Read Model Project',
      mode: 'local-primary',
      repos: [
        { id: 'app', remote: 'https://github.com/example/vibecompass-app.git', defaultBranch: 'main' },
        { id: 'mcp', remote: 'https://github.com/example/vibecompass-mcp.git', defaultBranch: 'main' },
      ],
      generatedAt: new Date('2026-04-19T11:00:00Z'),
    });

    await writeFile(
      path.join(rootDir, 'architecture/platform/project-memory/backend.md'),
      [
        '---',
        'domain: Platform',
        'feature: Project Memory',
        'component: Backend',
        'status: In progress',
        'repos:',
        '  - app',
        '  - mcp',
        '---',
        '',
        '## Description',
        'Backend summary.',
        '',
        '## Details',
        'Detailed notes.',
        '',
        '## Next steps',
        '- Build local reads.',
        '',
        '## Involved files',
        '',
        '**vibecompass-app:**',
        '- `src/app/api/mcp/context/route.ts` — local mode summary route',
        '',
        '**mcp:**',
        '- `src/tools/read.ts` — MCP read tools',
        '',
      ].join('\n'),
      'utf8',
    );

    await writeFile(
      path.join(rootDir, 'architecture/platform/project-memory/frontend.md'),
      [
        '---',
        'domain: Platform',
        'feature: Project Memory',
        'component: Frontend',
        'status: Complete',
        'repo: app',
        '---',
        '',
        '## Description',
        'Frontend summary.',
        '',
        '## Details',
        'More detail.',
        '',
        '## Next steps',
        '- Done.',
        '',
        '## Involved files',
        '- `src/app/(dashboard)/p/[projectId]/docs/page.tsx`',
        '',
      ].join('\n'),
      'utf8',
    );

    await writeFile(
      path.join(rootDir, 'decisions/cross-cutting.md'),
      [
        '### D-124 — Local-first project memory becomes the primary product direction',
        '**Timestamp:** 2026-04-19 00:19 PDT',
        '**Decision:** Local files are canonical.',
        '**Rationale:** Local ownership matters.',
        '',
        '### D-159 — First local read model exists',
        '**Timestamp:** 2026-04-19 11:30 PDT',
        '**Decision:** Build local query helpers in the core package.',
        '**Rationale:** MCP needs a local backend.',
        '',
      ].join('\n'),
      'utf8',
    );

    await writeFile(
      path.join(rootDir, 'sessions/2026-04-19-3-local-read-model.md'),
      [
        '# Session — 2026-04-19-3 — Local Read Model',
        '',
        '## What we worked on',
        'Built local reads.',
        '',
        '## Completed',
        '- Added the read model.',
        '',
        '## Decisions made',
        '- D-159',
        '',
        '## Models used',
        '- Codex',
        '',
        '## Blockers / open questions',
        '- None.',
        '',
        '## Next session should start with',
        '- Integrate MCP.',
        '',
      ].join('\n'),
      'utf8',
    );

    const readModel = await loadProjectReadModel(rootDir);
    const projectContext = getProjectContext(readModel, { decisionLimit: 1, sessionLimit: 1 });
    const featureContext = getFeatureContext(readModel, { domain: 'Platform', feature: 'Project Memory' });
    const decisionLog = getDecisionLog(readModel, { limit: 2 });
    const fileContext = getFileContext(readModel, 'vibecompass-app:src/app/api/mcp/context/route.ts');

    assert.equal(readModel.project.name, 'Read Model Project');
    assert.equal(readModel.project.mode, 'local-primary');
    assert.equal(readModel.manifest_state.exists, true);
    assert.equal(readModel.manifest_state.current, false);
    assert.equal(readModel.domains.length, 1);
    assert.equal(readModel.features.length, 1);
    assert.equal(readModel.features[0].feature_key, 'platform--project-memory');
    assert.equal(readModel.features[0].component_count, 2);
    assert.deepEqual(readModel.features[0].repo_ids, ['app', 'mcp']);
    assert.deepEqual(readModel.features[0].involved_files, [
      'app:src/app/(dashboard)/p/[projectId]/docs/page.tsx',
      'app:src/app/api/mcp/context/route.ts',
      'mcp:src/tools/read.ts',
    ]);
    assert.equal(projectContext.recent_decisions[0].decision_id, 159);
    assert.equal(projectContext.recent_sessions[0].title, 'Local Read Model');
    assert.equal(featureContext.feature.components[0].component, 'Backend');
    assert.equal(decisionLog.decisions[0].title, 'First local read model exists');
    assert.equal(fileContext.path, 'app:src/app/api/mcp/context/route.ts');
    assert.equal(fileContext.owners.length, 1);
    assert.equal(fileContext.owners[0].component, 'Backend');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
