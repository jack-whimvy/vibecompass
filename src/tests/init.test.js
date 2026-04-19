import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeProjectMemory } from '../init.js';
import { scanProjectMemory } from '../project-memory.js';
import { fileURLToPath } from 'node:url';
import { parseCliArgs, runCli, isDirectExecution } from '../cli.js';

test('initializeProjectMemory scaffolds a new root and writes a manifest', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-init-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    const result = await initializeProjectMemory({
      rootDir,
      name: 'Example Project',
      slug: 'example-project',
      mode: 'local-only',
      repos: [
        {
          id: 'docs',
          remote: 'https://github.com/example/docs.git',
          defaultBranch: 'main',
        },
      ],
      generatedAt: new Date('2026-04-19T10:00:00Z'),
    });

    const projectYaml = await readFile(path.join(rootDir, 'project.yaml'), 'utf8');
    const gitignore = await readFile(path.join(rootDir, '.gitignore'), 'utf8');
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));

    assert.match(projectYaml, /name: Example Project/);
    assert.match(projectYaml, /slug: example-project/);
    assert.match(projectYaml, /default_branch: main/);
    assert.equal(gitignore, 'state/\n');
    assert.equal(manifest.generated_at, '2026-04-19T10:00:00.000Z');
    assert.equal(manifest.canonical.document_count, 1);
    assert.deepEqual(Object.keys(manifest.documents), ['project.yaml']);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('initializeProjectMemory supports an existing docs-style root and preserves .gitignore content', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-init-existing-'));

  try {
    await mkdir(path.join(tempDir, 'architecture/platform/project-memory'), { recursive: true });
    await mkdir(path.join(tempDir, 'decisions'), { recursive: true });
    await mkdir(path.join(tempDir, 'sessions'), { recursive: true });
    await writeFile(
      path.join(tempDir, 'architecture/platform/project-memory/backend.md'),
      [
        '---',
        'domain: Platform',
        'feature: Project Memory',
        'component: Backend',
        'status: In progress',
        'repo: docs',
        '---',
        '',
        '## Description',
        'Existing backend notes.',
        '',
        '## Details',
        'Details.',
        '',
        '## Next steps',
        '- Later.',
        '',
        '## Involved files',
        '- `docs:architecture/platform/project-memory/backend.md`',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      path.join(tempDir, 'decisions/cross-cutting.md'),
      [
        '### D-124 — Existing decision',
        '**Timestamp:** 2026-04-19 00:01 PDT',
        '**Decision:** Existing decision text.',
        '**Rationale:** Existing rationale.',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      path.join(tempDir, 'sessions/2026-04-19-1-existing.md'),
      [
        '# Session — 2026-04-19-1 — Existing',
        '',
        '## What we worked on',
        'Existing work.',
        '',
        '## Completed',
        '- Done.',
        '',
        '## Decisions made',
        '- D-124',
        '',
        '## Models used',
        '- Codex',
        '',
        '## Blockers / open questions',
        '- None.',
        '',
        '## Next session should start with',
        '- Continue.',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(path.join(tempDir, '.gitignore'), 'node_modules/\n', 'utf8');

    const result = await initializeProjectMemory({
      rootDir: tempDir,
      name: 'Dogfood',
      mode: 'local-primary',
      repos: [
        {
          id: 'docs',
          remote: 'https://github.com/example/docs.git',
          defaultBranch: 'main',
        },
      ],
      sync: {
        apiUrl: 'https://vibecompass.dev',
        projectId: 'vc_proj_dogfood',
        credentialEnvVar: 'VIBECOMPASS_SYNC_TOKEN',
      },
      generatedAt: new Date('2026-04-19T10:05:00Z'),
    });

    const gitignore = await readFile(path.join(tempDir, '.gitignore'), 'utf8');
    const projectYaml = await readFile(path.join(tempDir, 'project.yaml'), 'utf8');
    const liveScan = await scanProjectMemory(tempDir);

    assert.match(gitignore, /node_modules\//);
    assert.match(gitignore, /state\//);
    assert.match(projectYaml, /mode: local-primary/);
    assert.match(projectYaml, /credential_env_var: VIBECOMPASS_SYNC_TOKEN/);
    assert.equal(result.manifest.canonical.document_count, 4);
    assert.equal(liveScan.errors.length, 0);
    assert.equal(result.syncEnvVar, 'VIBECOMPASS_SYNC_TOKEN');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runCli parses init arguments and creates the root', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-cli-'));
  const rootDir = path.join(tempDir, '.compass');
  const stdout = [];
  const stderr = [];

  try {
    const parsed = parseCliArgs([
      'init',
      '--root',
      rootDir,
      '--name',
      'CLI Project',
      '--mode',
      'local-only',
      '--repo',
      'docs=https://github.com/example/docs.git',
      '--repo-branch',
      'docs=main',
    ]);

    assert.equal(parsed.command, 'init');
    assert.equal(parsed.options.repos[0].defaultBranch, 'main');

    const exitCode = await runCli(
      [
        'init',
        '--root',
        rootDir,
        '--name',
        'CLI Project',
        '--mode',
        'local-only',
        '--repo',
        'docs=https://github.com/example/docs.git',
        '--repo-branch',
        'docs=main',
      ],
      {
        stdout: {
          write(chunk) {
            stdout.push(chunk);
          },
        },
        stderr: {
          write(chunk) {
            stderr.push(chunk);
          },
        },
      },
    );

    assert.equal(exitCode, 0);
    assert.equal(stderr.length, 0);
    assert.ok(stdout.join('').includes('Initialized VibeCompass project memory'));
    assert.ok(stdout.join('').includes('Generated'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('isDirectExecution resolves symlinked bin entry paths', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-bin-'));
  const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));
  const symlinkPath = path.join(tempDir, 'vibecompass');

  try {
    await writeFile(symlinkPath, '', 'utf8');
    await rm(symlinkPath, { force: true });
    await import('node:fs/promises').then(({ symlink }) => symlink(cliPath, symlinkPath));

    assert.equal(isDirectExecution(symlinkPath, new URL('../cli.js', import.meta.url).href), true);

    const result = spawnSync(process.execPath, [symlinkPath, '--help'], {
      encoding: 'utf8',
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage:/);
    assert.equal(result.stderr, '');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
