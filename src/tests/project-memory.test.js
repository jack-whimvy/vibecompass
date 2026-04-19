import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  generateStateManifest,
  scanProjectMemory,
  writeStateManifest,
} from '../index.js';

test('scanProjectMemory parses canonical files and excludes derived scratch files', async () => {
  const fixture = await createFixture({
    'project.yaml': `
format_version: 1
name: VibeCompass
mode: local-primary
repos:
  - id: app
    remote: https://github.com/example/app.git
  - id: docs
    remote: https://github.com/example/docs.git
sync:
  provider: vibecompass
  api_url: https://vibecompass.dev
  project_id: vc_proj_test
  credential_source: env
  credential_env_var: VIBECOMPASS_SYNC_TOKEN
`,
    'architecture/README.md': '# Architecture Index\n',
    'architecture/platform/project-memory/backend.md': `
---
domain: Platform
feature: Project Memory
component: Backend
status: In progress
repos:
  - app
  - docs
---

## Description
Parser implementation details.

## Details
More detail.

## Next steps
- Ship it.

## Involved files
- \`app:src/project-memory.js\`
`,
    'decisions/cross-cutting.md': `
### D-124 — Local-first project memory becomes the primary product direction
**Timestamp:** 2026-04-19 00:01 PDT
**Decision:** Canonical project memory lives locally.
**Rationale:** Local ownership is the point.
`,
    'decisions/INDEX.md': '# Decision Index\n',
    'sessions/2026-04-19-1-local-first-bootstrap.md': `
# Session — 2026-04-19-1 — Local First Bootstrap

## What we worked on
Started the parser.

## Completed
- Added the parser.

## Decisions made
- D-124

## Models used
- Codex

## Blockers / open questions
- None.

## Next session should start with
- Generate the manifest.
`,
    'sessions/wip.md': '# WIP\n',
    'sessions/handoff.md': '# Handoff\n',
  });

  try {
    const result = await scanProjectMemory(fixture.rootDir);

    assert.deepEqual(
      result.documents.map((document) => document.path),
      [
        'architecture/platform/project-memory/backend.md',
        'decisions/cross-cutting.md',
        'project.yaml',
        'sessions/2026-04-19-1-local-first-bootstrap.md',
      ],
    );
    assert.equal(result.errors.length, 0);
    assert.equal(result.project.extracted.mode, 'local-primary');
    assert.deepEqual(result.project.extracted.repo_ids, ['app', 'docs']);
  } finally {
    await fixture.cleanup();
  }
});

test('generateStateManifest produces the canonical summary and document inventory', async () => {
  const fixture = await createFixture({
    'project.yaml': `
format_version: 1
name: VibeCompass
mode: local-only
repos:
  - id: docs
    remote: https://github.com/example/docs.git
`,
    'architecture/platform/project-memory/file-schema.md': `
---
domain: Platform
feature: Project Memory
component: File Schema
status: Complete
repo: docs
---

## Description
Contract.

## Details
Details.

## Next steps
- None.

## Involved files
- \`docs:architecture/platform/project-memory/file-schema.md\`
`,
    'decisions/platform.md': `
### D-130 — project.yaml uses format_version for the full file contract
**Timestamp:** 2026-04-19 00:15 PDT
**Decision:** The root contract is versioned by format_version.
**Rationale:** Compatibility checks need one obvious version number.
`,
    'sessions/2026-04-19-2-parser-bootstrap.md': `
# Session — 2026-04-19-2 — Parser Bootstrap

## What we worked on
Manifest generation.

## Completed
- Added the manifest.

## Decisions made
- D-130

## Models used
- Codex

## Blockers / open questions
- None.

## Next session should start with
- Wire it into CLI commands.
`,
  });

  try {
    const scanResult = await scanProjectMemory(fixture.rootDir);
    const manifest = generateStateManifest(scanResult, {
      generatedAt: new Date('2026-04-19T08:30:00Z'),
    });

    assert.equal(manifest.state_version, 1);
    assert.equal(manifest.generated_at, '2026-04-19T08:30:00.000Z');
    assert.equal(manifest.canonical.format_version, 1);
    assert.equal(manifest.canonical.mode, 'local-only');
    assert.equal(manifest.canonical.document_count, 4);
    assert.equal(manifest.canonical.warning_count, 0);
    assert.match(manifest.canonical.manifest_hash, /^sha256:[a-f0-9]{64}$/);
    assert.match(manifest.canonical.local_root_revision, /^loc_[a-f0-9]{24}$/);
    assert.deepEqual(Object.keys(manifest.documents), [
      'architecture/platform/project-memory/file-schema.md',
      'decisions/platform.md',
      'project.yaml',
      'sessions/2026-04-19-2-parser-bootstrap.md',
    ]);

    const written = await writeStateManifest(fixture.rootDir, {
      generatedAt: new Date('2026-04-19T08:30:00Z'),
    });
    const fileContent = JSON.parse(await readFile(written.manifestPath, 'utf8'));

    assert.deepEqual(fileContent, manifest);
  } finally {
    await fixture.cleanup();
  }
});

test('scanProjectMemory rejects duplicate decisions and invalid env credential bindings', async () => {
  const fixture = await createFixture({
    'project.yaml': `
format_version: 1
name: Broken Root
mode: local-primary
repos:
  - id: docs
    remote: https://github.com/example/docs.git
sync:
  provider: vibecompass
  credential_source: env
`,
    'decisions/cross-cutting.md': `
### D-124 — First copy
**Timestamp:** 2026-04-19 00:01 PDT
**Decision:** First decision body.
**Rationale:** One.
`,
    'decisions/platform.md': `
### D-124 — Second copy
**Timestamp:** 2026-04-19 00:02 PDT
**Decision:** Second decision body.
**Rationale:** Two.
`,
  });

  try {
    const result = await scanProjectMemory(fixture.rootDir);

    assert.ok(result.errors.some((error) => error.code === 'project-missing-credential-env-var'));
    assert.ok(result.errors.some((error) => error.code === 'duplicate-decision-id'));
    assert.throws(() => generateStateManifest(result), /canonical parse errors/i);
  } finally {
    await fixture.cleanup();
  }
});

test('scanProjectMemory supports singular repo, warns on unknown status, and accepts session heading fallback', async () => {
  const fixture = await createFixture({
    'project.yaml': `
format_version: 1
name: Mixed Root
mode: local-only
repos:
  - id: docs
    remote: https://github.com/example/docs.git
`,
    'architecture/platform/project-memory/frontend.md': `
---
domain: Platform
feature: Project Memory
component: Frontend
status: Experimental
repo: docs
---

## Description
UI notes.

## Details
Details.

## Next steps
- Later.

## Involved files
- \`docs:architecture/platform/project-memory/frontend.md\`
`,
    'sessions/custom-name.md': `
# Session — Parser Fallback Title

## What we worked on
Test the fallback.

## Completed
- Verified recognition.

## Decisions made
- None.

## Models used
- Codex

## Blockers / open questions
- None.

## Next session should start with
- Keep moving.
`,
  });

  try {
    const result = await scanProjectMemory(fixture.rootDir);
    const architectureDocument = result.documents.find(
      (document) => document.path === 'architecture/platform/project-memory/frontend.md',
    );
    const sessionDocument = result.documents.find(
      (document) => document.path === 'sessions/custom-name.md',
    );

    assert.equal(result.errors.length, 0);
    assert.deepEqual(architectureDocument.extracted.repo_ids, ['docs']);
    assert.ok(
      architectureDocument.warnings.some((warning) => warning.code === 'architecture-unknown-status'),
    );
    assert.equal(sessionDocument.extracted.title, 'Parser Fallback Title');
    assert.ok(
      sessionDocument.warnings.some((warning) => warning.code === 'session-filename-mismatch'),
    );
  } finally {
    await fixture.cleanup();
  }
});

test('scanProjectMemory rejects secret-bearing sync fields in project.yaml', async () => {
  const fixture = await createFixture({
    'project.yaml': `
format_version: 1
name: Secret Root
mode: local-primary
repos:
  - id: docs
    remote: https://github.com/example/docs.git
sync:
  provider: vibecompass
  api_url: https://vibecompass.dev
  project_id: vc_proj_secret
  credential_source: env
  credential_env_var: VIBECOMPASS_SYNC_TOKEN
  token: hardcoded-secret
`,
  });

  try {
    const result = await scanProjectMemory(fixture.rootDir);

    assert.ok(result.errors.some((error) => error.code === 'project-inline-secret'));
    assert.ok(
      result.project.warnings.some((warning) => warning.code === 'project-unknown-sync-field'),
    );
  } finally {
    await fixture.cleanup();
  }
});

async function createFixture(files) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-core-'));

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(rootDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, normalize(content), 'utf8');
  }

  return {
    rootDir,
    cleanup: () => rm(rootDir, { recursive: true, force: true }),
  };
}

function normalize(value) {
  return value.replace(/^\n/, '');
}
