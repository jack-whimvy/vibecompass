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
    assert.match(renderDocsUpdatePlan(plan), /Fold the session changes into the affected architecture docs as current-state contracts/);
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

test('runCli prints docs-update --json as a typed plan', async () => {
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
        '--json',
      ],
      {
        stdout: { write: (chunk) => stdout.push(chunk) },
        stderr: { write: (chunk) => stderr.push(chunk) },
      },
      { cwd: fixture.tempDir },
    );

    assert.equal(exitCode, 0);
    assert.equal(stderr.length, 0);
    const plan = JSON.parse(stdout.join(''));
    assert.equal(plan.session.id, 'auth-flow');
    assert.deepEqual(plan.delta.changedFiles, ['app:src/auth/login.ts']);
    assert.equal(plan.architecture.affected[0].path, 'architecture/product/auth/login.md');
    assert.deepEqual(plan.packageOwnedChanges, []);
  } finally {
    await fixture.cleanup();
  }
});

test('planDocsUpdate carries architecture quality warnings from the scanner', async () => {
  const fixture = await createDocsUpdateFixture();

  try {
    await writeFile(
      path.join(fixture.rootDir, 'architecture/product/auth/login.md'),
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
        '## Involved files',
        '- `app:src/auth/login.ts`',
        '',
      ].join('\n'),
      'utf8',
    );

    const plan = await planDocsUpdate({
      cwd: fixture.tempDir,
      rootDir: fixture.rootDir,
      sessionId: 'auth-flow',
      changedFiles: ['app:src/auth/login.ts'],
    });

    const warningCodes = plan.architecture.affected[0].qualityWarnings.map((warning) => warning.code);
    assert.ok(warningCodes.includes('architecture-missing-section'));
    assert.ok(warningCodes.includes('architecture-missing-evidence-metadata'));
    assert.ok(warningCodes.includes('architecture-missing-blindspots-metadata'));
    assert.match(renderDocsUpdatePlan(plan), /quality warnings:/);
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

test('planDocsUpdate unquotes git porcelain paths from declared nested repo folders', async (t) => {
  if (spawnSync('git', ['--version']).status !== 0) {
    t.skip('git is required for nested repo status detection.');
    return;
  }

  const fixture = await createDocsUpdateFixture({
    involvedFile: 'app:src/auth/login flow.ts',
  });
  const repoDir = path.join(fixture.tempDir, 'app');

  try {
    await mkdir(path.join(repoDir, 'src/auth'), { recursive: true });
    assert.equal(spawnSync('git', ['init'], { cwd: repoDir }).status, 0);
    assert.equal(spawnSync('git', ['config', 'core.quotePath', 'true'], { cwd: repoDir }).status, 0);
    await writeFile(path.join(repoDir, 'src/auth/login flow.ts'), 'export const login = true;\n', 'utf8');

    const plan = await planDocsUpdate({
      cwd: fixture.tempDir,
      rootDir: fixture.rootDir,
      sessionId: 'auth-flow',
    });

    assert.ok(plan.delta.changedFiles.includes('app:src/auth/login flow.ts'));
    assert.deepEqual(
      plan.architecture.affected.map((doc) => doc.path),
      ['architecture/product/auth/login.md'],
    );
  } finally {
    await fixture.cleanup();
  }
});

test('planDocsUpdate decodes UTF-8 octal escapes from quoted git porcelain paths', async (t) => {
  if (spawnSync('git', ['--version']).status !== 0) {
    t.skip('git is required for nested repo status detection.');
    return;
  }

  const fixture = await createDocsUpdateFixture({
    involvedFile: 'app:src/auth/café.ts',
  });
  const repoDir = path.join(fixture.tempDir, 'app');

  try {
    await mkdir(path.join(repoDir, 'src/auth'), { recursive: true });
    assert.equal(spawnSync('git', ['init'], { cwd: repoDir }).status, 0);
    assert.equal(spawnSync('git', ['config', 'core.quotePath', 'true'], { cwd: repoDir }).status, 0);
    await writeFile(path.join(repoDir, 'src/auth/café.ts'), 'export const login = true;\n', 'utf8');

    const plan = await planDocsUpdate({
      cwd: fixture.tempDir,
      rootDir: fixture.rootDir,
      sessionId: 'auth-flow',
    });

    assert.ok(plan.delta.changedFiles.includes('app:src/auth/café.ts'));
    assert.deepEqual(
      plan.architecture.affected.map((doc) => doc.path),
      ['architecture/product/auth/login.md'],
    );
  } finally {
    await fixture.cleanup();
  }
});

test('planDocsUpdate uses the destination path for quoted git porcelain renames', async (t) => {
  if (spawnSync('git', ['--version']).status !== 0) {
    t.skip('git is required for nested repo status detection.');
    return;
  }

  const fixture = await createDocsUpdateFixture({
    involvedFile: 'app:src/auth/login flow.ts',
  });
  const repoDir = path.join(fixture.tempDir, 'app');

  try {
    await mkdir(path.join(repoDir, 'src/auth'), { recursive: true });
    assert.equal(spawnSync('git', ['init'], { cwd: repoDir }).status, 0);
    assert.equal(spawnSync('git', ['config', 'core.quotePath', 'true'], { cwd: repoDir }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.name', 'VibeCompass Test'], { cwd: repoDir }).status, 0);
    await writeFile(path.join(repoDir, 'src/auth/login -> old.ts'), 'export const login = true;\n', 'utf8');
    assert.equal(spawnSync('git', ['add', 'src/auth/login -> old.ts'], { cwd: repoDir }).status, 0);
    assert.equal(spawnSync('git', ['commit', '-m', 'Add old login path'], { cwd: repoDir }).status, 0);
    assert.equal(spawnSync('git', ['mv', 'src/auth/login -> old.ts', 'src/auth/login flow.ts'], { cwd: repoDir }).status, 0);

    const plan = await planDocsUpdate({
      cwd: fixture.tempDir,
      rootDir: fixture.rootDir,
      sessionId: 'auth-flow',
    });

    assert.ok(plan.delta.changedFiles.includes('app:src/auth/login flow.ts'));
    assert.equal(plan.delta.changedFiles.some((filePath) => filePath.includes('login -> old.ts')), false);
    assert.deepEqual(
      plan.architecture.affected.map((doc) => doc.path),
      ['architecture/product/auth/login.md'],
    );
  } finally {
    await fixture.cleanup();
  }
});

test('planDocsUpdate adds a session-scoped size advisory for oversized affected docs', async () => {
  const fixture = await createDocsUpdateFixture();

  try {
    const padding = 'The login contract line is repeated to exceed the soft size budget. '.repeat(200);
    await writeFile(
      path.join(fixture.rootDir, 'architecture/product/auth/login.md'),
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
        padding,
        '',
        '## Retrieval guidance',
        '- Use this doc when changing login flow implementation.',
        '- It does not cover signup.',
        '',
        '## Next steps',
        '- None.',
        '',
        '## Involved files',
        '- `app:src/auth/login.ts`',
        '',
      ].join('\n'),
      'utf8',
    );

    const plan = await planDocsUpdate({
      cwd: fixture.tempDir,
      rootDir: fixture.rootDir,
      sessionId: 'auth-flow',
      changedFiles: ['app:src/auth/login.ts'],
    });

    const affected = plan.architecture.affected[0];
    assert.equal(affected.path, 'architecture/product/auth/login.md');
    assert.equal(affected.size.exceedsSoftLimit, true);
    assert.equal(affected.size.softLimitBytes, 12000);
    assert.ok(affected.size.byteLength > 12000);
    // Text renderer reads the same self-describing size object the JSON plan
    // exposes — assert the rendered numbers match the plan values.
    assert.match(
      renderDocsUpdatePlan(plan),
      new RegExp(`size advisory: ${affected.size.byteLength} bytes exceeds the ${affected.size.softLimitBytes}-byte soft budget`),
    );

    const stdout = [];
    const exitCode = await runCli(
      ['docs-update', '--root', fixture.rootDir, '--session', 'auth-flow', '--changed', 'app:src/auth/login.ts', '--json'],
      { stdout: { write: (chunk) => stdout.push(chunk) }, stderr: { write() {} } },
      { cwd: fixture.tempDir },
    );
    assert.equal(exitCode, 0);
    const jsonPlan = JSON.parse(stdout.join(''));
    assert.deepEqual(jsonPlan.architecture.affected[0].size, {
      byteLength: affected.size.byteLength,
      softLimitBytes: affected.size.softLimitBytes,
      exceedsSoftLimit: true,
    });
  } finally {
    await fixture.cleanup();
  }
});

test('planDocsUpdate keeps the size advisory out of plans for docs within budget', async () => {
  const fixture = await createDocsUpdateFixture();

  try {
    const plan = await planDocsUpdate({
      cwd: fixture.tempDir,
      rootDir: fixture.rootDir,
      sessionId: 'auth-flow',
      changedFiles: ['app:src/auth/login.ts'],
    });

    assert.equal(plan.architecture.affected[0].size.exceedsSoftLimit, false);
    assert.equal(plan.architecture.affected[0].size.softLimitBytes, 12000);
    assert.doesNotMatch(renderDocsUpdatePlan(plan), /size advisory:/);
  } finally {
    await fixture.cleanup();
  }
});

test('planDocsUpdate surfaces the changelog-smell advisory on affected docs', async () => {
  const fixture = await createDocsUpdateFixture();

  try {
    await writeFile(
      path.join(fixture.rootDir, 'architecture/product/auth/login.md'),
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
        'Current contract prose.',
        '',
        '## Audit deepening — 2026-07-07 (verified)',
        'Dated audit narrative appended by a session.',
        '',
        '## Retrieval guidance',
        '- Use this doc when changing login flow implementation.',
        '- It does not cover signup.',
        '',
        '## Next steps',
        '- None.',
        '',
        '## Involved files',
        '- `app:src/auth/login.ts`',
        '',
      ].join('\n'),
      'utf8',
    );

    const plan = await planDocsUpdate({
      cwd: fixture.tempDir,
      rootDir: fixture.rootDir,
      sessionId: 'auth-flow',
      changedFiles: ['app:src/auth/login.ts'],
    });

    const warningCodes = plan.architecture.affected[0].qualityWarnings.map((warning) => warning.code);
    assert.ok(warningCodes.includes('architecture-changelog-smell'));
    assert.match(renderDocsUpdatePlan(plan), /architecture-changelog-smell/);
  } finally {
    await fixture.cleanup();
  }
});

async function createDocsUpdateFixture(options = {}) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-docs-update-'));
  const rootDir = path.join(tempDir, '.compass');
  const features = options.features ?? ['auth'];
  const claims = options.claims ?? ['app:src/auth'];
  const involvedFile = options.involvedFile ?? 'app:src/auth/login.ts';

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
      `- Evidence: \`${involvedFile}\``,
      '- Blindspots: None identified for this fixture.',
      '',
      '## Details',
      `The login flow lives under \`${involvedFile}\`.`,
      '',
      '## Retrieval guidance',
      '- Use this doc when changing login flow implementation.',
      '- It does not cover signup or account recovery.',
      '',
      '## Next steps',
      '- Keep this doc aligned with login changes.',
      '',
      '## Involved files',
      `- \`${involvedFile}\``,
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

test('planDocsUpdate resolves declared repo folders against the workspace, not the invoking cwd (S3-0)', async (t) => {
  if (spawnSync('git', ['--version']).status !== 0) {
    t.skip('git is required for nested repo status detection.');
    return;
  }

  const fixture = await createDocsUpdateFixture();
  const repoDir = path.join(fixture.tempDir, 'app');
  const nestedCwd = path.join(fixture.tempDir, 'notes');

  try {
    await mkdir(path.join(repoDir, 'src/auth'), { recursive: true });
    await mkdir(nestedCwd, { recursive: true });
    assert.equal(spawnSync('git', ['init'], { cwd: repoDir }).status, 0);
    await writeFile(path.join(repoDir, 'src/auth/login.ts'), 'export const login = true;\n', 'utf8');

    // From a nested non-repo cwd the old cwd-relative resolution pointed the
    // repo scan at <cwd>/app (nonexistent, errors swallowed); the workspace
    // base (dirname of the memory root) finds the real checkout.
    const plan = await planDocsUpdate({
      cwd: nestedCwd,
      rootDir: fixture.rootDir,
      sessionId: 'auth-flow',
    });

    assert.ok(plan.delta.changedFiles.includes('app:src/auth/login.ts'));
  } finally {
    await fixture.cleanup();
  }
});
