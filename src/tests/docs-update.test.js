import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../cli.js';
import { planDocsUpdate, renderDocsUpdatePlan } from '../docs-update.js';
import { initializeProjectMemory } from '../init.js';
import { startProjectSession } from '../session.js';

test('planDocsUpdate maps session-delta files to affected architecture docs', async () => {
  const fixture = await createDocsUpdateFixture();

  try {
    const plan = await planDocsUpdate({
      cwd: fixture.tempDir,
      rootDir: fixture.rootDir,
      sessionId: 'auth-flow',
      changedFiles: ['app:src/auth/login.ts'],
    });

    assert.equal(plan.session.id, 'auth-flow');
    assert.deepEqual(plan.delta.changedFiles, ['app:src/auth/login.ts']);
    assert.deepEqual(plan.delta.claimedPaths, ['app:src/auth']);
    assert.equal(plan.architecture.needsNewDoc, false);
    assert.deepEqual(
      plan.architecture.affected.map((doc) => doc.path),
      ['architecture/product/auth/login.md'],
    );
    assert.ok(plan.architecture.affected[0].reasons.some((reason) => reason.includes('matches changed file')));
    assert.deepEqual(plan.architecture.affected[0].qualityWarnings, []);
    assert.match(renderDocsUpdatePlan(plan), /Docs update plan:/);
    assert.match(renderDocsUpdatePlan(plan), /Review and update the affected architecture docs listed above/);
  } finally {
    await fixture.cleanup();
  }
});

test('planDocsUpdate does not treat repo scope alone as an affected-doc match', async () => {
  const fixture = await createDocsUpdateFixture({
    features: [],
    claims: [],
  });

  try {
    const plan = await planDocsUpdate({
      cwd: fixture.tempDir,
      rootDir: fixture.rootDir,
      sessionId: 'auth-flow',
      changedFiles: ['app:src/billing/checkout.ts'],
    });

    assert.deepEqual(plan.delta.sessionRepos, ['app']);
    assert.deepEqual(plan.delta.changedFiles, ['app:src/billing/checkout.ts']);
    assert.deepEqual(plan.architecture.affected, []);
    assert.equal(plan.architecture.needsNewDoc, true);
  } finally {
    await fixture.cleanup();
  }
});

test('planDocsUpdate identifies package-owned generated and state surfaces', async () => {
  const fixture = await createDocsUpdateFixture();

  try {
    const plan = await planDocsUpdate({
      cwd: fixture.tempDir,
      rootDir: fixture.rootDir,
      sessionId: 'auth-flow',
      changedFiles: [
        '.compass/state/manifest.json',
        '.compass/context.md',
        'AGENTS.md',
      ],
    });

    assert.deepEqual(plan.packageOwnedChanges, [
      '.compass/state/manifest.json',
      '.compass/context.md',
      'AGENTS.md',
    ]);
    assert.ok(plan.recommendations.some((item) => item.includes('Do not hand-edit package-owned state/generated surfaces')));
  } finally {
    await fixture.cleanup();
  }
});

test('planDocsUpdate treats repo-prefixed architecture paths as documentation changes', async () => {
  const fixture = await createDocsUpdateFixture();

  try {
    const plan = await planDocsUpdate({
      cwd: fixture.tempDir,
      rootDir: fixture.rootDir,
      sessionId: 'auth-flow',
      changedFiles: ['app:architecture/product/auth/login.md'],
    });

    assert.equal(plan.architecture.needsNewDoc, false);
    assert.deepEqual(
      plan.architecture.affected.map((doc) => doc.path),
      ['architecture/product/auth/login.md'],
    );
  } finally {
    await fixture.cleanup();
  }
});

test('runCli prints a targeted docs-update plan', async () => {
  const fixture = await createDocsUpdateFixture();
  const stdout = [];
  const stderr = [];

  try {
    const exitCode = await runCli(
      [
        'docs-update',
        '--root',
        fixture.rootDir,
        '--session',
        'auth-flow',
        '--changed',
        'app:src/auth/login.ts',
      ],
      {
        stdout: { write: (chunk) => stdout.push(chunk) },
        stderr: { write: (chunk) => stderr.push(chunk) },
      },
      { cwd: fixture.tempDir },
    );

    assert.equal(exitCode, 0);
    assert.equal(stderr.length, 0);
    assert.match(stdout.join(''), /Docs update plan:/);
    assert.match(stdout.join(''), /architecture\/product\/auth\/login\.md/);
    assert.match(stdout.join(''), /matches changed file app:src\/auth\/login\.ts/);
  } finally {
    await fixture.cleanup();
  }
});

test('planDocsUpdate reads git status from declared nested repo folders', async (t) => {
  if (spawnSync('git', ['--version']).status !== 0) {
    t.skip('git is required for nested repo status detection.');
    return;
  }

  const fixture = await createDocsUpdateFixture();
  const repoDir = path.join(fixture.tempDir, 'app');

  try {
    await mkdir(path.join(repoDir, 'src/auth'), { recursive: true });
    assert.equal(spawnSync('git', ['init'], { cwd: repoDir }).status, 0);
    await writeFile(path.join(repoDir, 'src/auth/login.ts'), 'export const login = true;\n', 'utf8');

    const plan = await planDocsUpdate({
      cwd: fixture.tempDir,
      rootDir: fixture.rootDir,
      sessionId: 'auth-flow',
    });

    assert.ok(plan.delta.changedFiles.includes('app:src/auth/login.ts'));
    assert.deepEqual(
      plan.architecture.affected.map((doc) => doc.path),
      ['architecture/product/auth/login.md'],
    );
  } finally {
    await fixture.cleanup();
  }
});

async function createDocsUpdateFixture(options = {}) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-docs-update-'));
  const rootDir = path.join(tempDir, '.compass');
  const features = options.features ?? ['auth'];
  const claims = options.claims ?? ['app:src/auth'];

  await initializeProjectMemory({
    cwd: tempDir,
    rootDir,
    name: 'Docs Update Project',
    mode: 'local-only',
    repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
    bootstrap: {
      workflow: true,
      claude: true,
    },
  });

  await mkdir(path.join(rootDir, 'architecture/product/auth'), { recursive: true });
  await writeFile(
    path.join(rootDir, 'architecture/product/auth/login.md'),
    [
      '---',
      'domain: Product',
      'feature: Auth',
      'component: Login',
      'status: In progress',
      'repo: app',
      '---',
      '',
      '## Description',
      'Login flow docs.',
      '',
      '## Review metadata',
      '- Evidence: `app:src/auth/login.ts`',
      '- Blindspots: None identified for this fixture.',
      '',
      '## Details',
      'The login flow lives under `app:src/auth/login.ts`.',
      '',
      '## Retrieval guidance',
      '- Use this doc when changing login flow implementation.',
      '- It does not cover signup or account recovery.',
      '',
      '## Next steps',
      '- Keep this doc aligned with login changes.',
      '',
      '## Involved files',
      '- `app:src/auth/login.ts`',
      '',
    ].join('\n'),
    'utf8',
  );

  await startProjectSession({
    cwd: tempDir,
    rootDir,
    sessionId: 'auth-flow',
    workingOn: 'Update auth flow behavior.',
    date: '2026-06-21',
    features,
    repos: ['app'],
    claims,
  });

  return {
    tempDir,
    rootDir,
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  };
}
