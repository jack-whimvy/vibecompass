import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
    assert.match(projectYaml, /reviewer_handback: handoff-file/);
    assert.match(projectYaml, /refresh_architecture_docs: true/);
    assert.match(projectYaml, /refresh_decision_files: true/);
    assert.match(projectYaml, /commit_template: "docs\(session\): YYYY-MM-DD-N — <summary>"/);
    assert.equal(gitignore, 'state/\n');
    assert.equal(manifest.generated_at, '2026-04-19T10:00:00.000Z');
    assert.equal(manifest.canonical.document_count, 1);
    assert.deepEqual(Object.keys(manifest.documents), ['project.yaml']);
    assert.equal(result.contextFilePath, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('initializeProjectMemory can scaffold workflow guides and starter tool files', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-init-bootstrap-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    const result = await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Workflow Project',
      mode: 'local-only',
      repos: [{ id: 'docs', remote: 'https://github.com/example/docs.git' }],
      closeSessionGitPublish: true,
      closeSessionGitRemote: 'origin',
      bootstrap: {
        workflow: true,
        claude: true,
        agents: true,
      },
    });

    const context = await readFile(path.join(rootDir, 'context.md'), 'utf8');
    const architectureGuide = await readFile(path.join(rootDir, 'architecture/README.md'), 'utf8');
    const decisionsGuide = await readFile(path.join(rootDir, 'decisions/README.md'), 'utf8');
    const sessionsGuide = await readFile(path.join(rootDir, 'sessions/README.md'), 'utf8');
    const claude = await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8');
    const agents = await readFile(path.join(tempDir, 'AGENTS.md'), 'utf8');

    assert.match(context, /\.compass\/project\.yaml/);
    assert.match(context, /sessions\/wip\.md/);
    assert.match(context, /include a Git publish step after finalization using remote `origin`/);
    assert.match(context, /use commit message format `docs\(session\): YYYY-MM-DD-N — <summary>`/);
    assert.match(architectureGuide, /Recommended layout/);
    assert.match(decisionsGuide, /Append-only decision log/);
    assert.match(sessionsGuide, /Finalized session notes/);
    assert.match(claude, /Read `\.compass\/context\.md` before doing substantive work/);
    assert.match(agents, /Before doing substantive work/);
    assert.equal(result.contextFilePath, path.join(rootDir, 'context.md'));
    assert.ok(result.scaffoldCreatedFiles.includes(path.join(tempDir, 'CLAUDE.md')));
    assert.ok(result.scaffoldCreatedFiles.includes(path.join(tempDir, 'AGENTS.md')));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('initializeProjectMemory supports dedicated-memory-repo placement defaults', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-init-dedicated-root-'));
  const docsRepoDir = path.join(tempDir, 'vibecompass-docs');

  try {
    await mkdir(docsRepoDir, { recursive: true });

    const result = await initializeProjectMemory({
      cwd: tempDir,
      toolingRootDir: 'vibecompass-docs',
      placementPattern: 'dedicated-memory-repo',
      name: 'Dedicated Memory Project',
      mode: 'local-only',
      repos: [{ id: 'docs', remote: 'https://github.com/example/docs.git' }],
      bootstrap: {
        workflow: true,
        claude: true,
      },
    });

    const projectYaml = await readFile(path.join(docsRepoDir, 'project.yaml'), 'utf8');
    const context = await readFile(path.join(docsRepoDir, 'context.md'), 'utf8');
    const claude = await readFile(path.join(docsRepoDir, 'CLAUDE.md'), 'utf8');

    assert.equal(result.rootDir, docsRepoDir);
    assert.equal(result.contextFilePath, path.join(docsRepoDir, 'context.md'));
    assert.match(projectYaml, /placement_pattern: dedicated-memory-repo/);
    assert.match(context, /project\.yaml/);
    assert.match(claude, /Read `context\.md` before doing substantive work/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('initializeProjectMemory supports workspace-root placement defaults', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-init-workspace-root-'));
  const workspaceDir = path.join(tempDir, 'workspace');

  try {
    await mkdir(workspaceDir, { recursive: true });

    const result = await initializeProjectMemory({
      cwd: tempDir,
      toolingRootDir: 'workspace',
      placementPattern: 'workspace-root',
      name: 'Workspace Root Project',
      mode: 'local-only',
      repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
      bootstrap: {
        workflow: true,
        claude: true,
      },
    });

    const projectYaml = await readFile(path.join(workspaceDir, '.compass/project.yaml'), 'utf8');
    const context = await readFile(path.join(workspaceDir, '.compass/context.md'), 'utf8');
    const claude = await readFile(path.join(workspaceDir, 'CLAUDE.md'), 'utf8');

    assert.equal(result.rootDir, path.join(workspaceDir, '.compass'));
    assert.equal(result.contextFilePath, path.join(workspaceDir, '.compass/context.md'));
    assert.match(projectYaml, /placement_pattern: workspace-root/);
    assert.match(context, /\.compass\/project\.yaml/);
    assert.match(claude, /Read `\.compass\/context\.md` before doing substantive work/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runCli sync-agents creates and updates managed agent instruction files', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-sync-agents-'));
  const rootDir = path.join(tempDir, '.compass');
  const stdout = [];
  const stderr = [];

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Agent File Project',
      description: 'Keeps agent files generated from project memory.',
      mode: 'local-only',
      repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
    });

    const dryRunExitCode = await runCli(
      ['sync-agents', '--root', '.compass', '--dry-run'],
      {
        stdout: {
          write(chunk) {
            stdout.push(chunk);
          },
        },
        stderr: {
          write() {},
        },
      },
      { cwd: tempDir },
    );

    await assert.rejects(() => access(path.join(tempDir, 'CLAUDE.md')));
    assert.equal(dryRunExitCode, 0);
    assert.match(stdout.join(''), /CLAUDE\.md: dry-run-create/);

    stdout.length = 0;
    const exitCode = await runCli(
      ['sync-agents', '--root', '.compass'],
      {
        stdout: {
          write(chunk) {
            stdout.push(chunk);
          },
        },
        stderr: {
          write() {},
        },
      },
      { cwd: tempDir },
    );

    const claude = await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8');
    const cursorRules = await readFile(path.join(tempDir, '.cursorrules'), 'utf8');
    const copilot = await readFile(path.join(tempDir, '.github/copilot-instructions.md'), 'utf8');

    assert.equal(exitCode, 0);
    assert.match(claude, /vibecompass:start - managed by VibeCompass/);
    assert.match(claude, /Agent File Project Claude Instructions/);
    assert.match(cursorRules, /Agent File Project Cursor Rules/);
    assert.match(copilot, /Agent File Project Copilot Instructions/);

    await writeFile(
      path.join(tempDir, 'CLAUDE.md'),
      `User header\n\n${claude}\nUser footer\n`,
      'utf8',
    );

    await runCli(
      ['sync-agents', '--root', '.compass', '--format', 'claude_md'],
      {
        stdout: {
          write() {},
        },
        stderr: {
          write() {},
        },
      },
      { cwd: tempDir },
    );

    const updatedClaude = await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8');
    assert.match(updatedClaude, /^User header/);
    assert.match(updatedClaude, /User footer\s*$/);

    await writeFile(path.join(tempDir, 'AGENTS.md'), 'Hand-written agents file\n', 'utf8');
    stdout.length = 0;
    await runCli(
      ['sync-agents', '--root', '.compass', '--format', 'agents_md'],
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
      { cwd: tempDir },
    );

    assert.match(stderr.join(''), /AGENTS\.md: warning/);
    assert.equal(await readFile(path.join(tempDir, 'AGENTS.md'), 'utf8'), 'Hand-written agents file\n');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runCli sync-agents reports disabled requested formats explicitly', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-sync-disabled-'));
  const rootDir = path.join(tempDir, '.compass');
  const stdout = [];
  const stderr = [];

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Disabled Agent File Project',
      mode: 'local-only',
      repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
      metadata: {
        agent_files: {
          agents_md: false,
        },
      },
    });

    const exitCode = await runCli(
      ['sync-agents', '--root', '.compass', '--format', 'agents_md'],
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
      { cwd: tempDir },
    );

    assert.equal(exitCode, 0);
    assert.match(stdout.join(''), /Agent instruction files:/);
    assert.match(stderr.join(''), /AGENTS\.md: disabled/);
    assert.match(stderr.join(''), /Format "agents_md" is disabled/);
    await assert.rejects(() => access(path.join(tempDir, 'AGENTS.md')));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runCli sync-agents validates format arguments', async () => {
  assert.throws(
    () => parseCliArgs(['sync-agents', '--format']),
    /requires a value/,
  );

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-sync-validation-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Validation Agent File Project',
      mode: 'local-only',
      repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
    });

    await assert.rejects(
      () =>
        runCli(
          ['sync-agents', '--root', '.compass', '--format', 'unknown'],
          {
            stdout: { write() {} },
            stderr: { write() {} },
          },
          { cwd: tempDir },
        ),
      /Unknown agent file format "unknown"/,
    );
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
      '--with-workflow',
      '--with-claude',
      '--close-session-git-publish',
      '--close-session-git-remote',
      'upstream',
    ]);

    assert.equal(parsed.command, 'init');
    assert.equal(parsed.options.repos[0].defaultBranch, 'main');
    assert.equal(parsed.options.bootstrap.workflow, true);
    assert.equal(parsed.options.bootstrap.claude, true);
    assert.equal(parsed.options.closeSessionGitPublish, true);
    assert.equal(parsed.options.closeSessionGitRemote, 'upstream');

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
        '--with-workflow',
        '--with-claude',
        '--close-session-git-publish',
        '--close-session-git-remote',
        'upstream',
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
      {
        cwd: tempDir,
      },
    );

    assert.equal(exitCode, 0);
    assert.equal(stderr.length, 0);
    assert.ok(stdout.join('').includes('Initialized VibeCompass project memory'));
    assert.ok(stdout.join('').includes('Generated'));
    assert.ok(stdout.join('').includes('context.md'));
    assert.ok(stdout.join('').includes(path.join(tempDir, 'CLAUDE.md')));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runCli can chain init directly into the first builder session', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-cli-init-session-'));
  const stdout = [];
  const stderr = [];

  try {
    const exitCode = await runCli(
      [
        'init',
        '--name',
        'CLI Session Bootstrap',
        '--mode',
        'local-only',
        '--repo',
        'docs=https://github.com/example/docs.git',
        '--start-session',
        '--session-working-on',
        'Kick off the first builder session from init.',
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
      {
        cwd: tempDir,
      },
    );

    const claude = await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8');
    const wip = await readFile(path.join(tempDir, '.compass/sessions/wip.md'), 'utf8');
    const handoff = await readFile(path.join(tempDir, '.compass/sessions/handoff.md'), 'utf8');

    assert.equal(exitCode, 0);
    assert.equal(stderr.length, 0);
    assert.ok(stdout.join('').includes('Generated'));
    assert.ok(stdout.join('').includes('Started session'));
    assert.match(claude, /Working on: Kick off the first builder session from init\./);
    assert.match(wip, /Kick off the first builder session from init\./);
    assert.match(handoff, /Kick off the first builder session from init\./);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runCli supports guided init with placement recommendation and first-session bootstrap', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-cli-guided-'));
  const stdout = [];
  const stderr = [];
  const prompts = [];
  const answers = new Map([
    ['Project name', 'Guided Project'],
    ['Project mode', 'local-only'],
    ['How many repos belong to this logical project?', '1'],
    ['Repo 1 id', 'app'],
    ['Repo 1 remote', 'https://github.com/example/app.git'],
    ['Repo 1 default branch', 'main'],
    ['Use primary-repo?', ''],
    ['Directory of the designated primary repo', '.'],
    ['Scaffold workflow files (context.md plus guide READMEs)?', ''],
    ['Create a starter CLAUDE.md if missing?', ''],
    ['Create a starter AGENTS.md if missing?', 'no'],
    ['Open the first builder session immediately after init?', 'yes'],
    ['What are you working on?', 'Bootstrap the guided init flow.'],
    ['Should close-session include a Git publish step?', 'yes'],
    ['Git remote for the close-session publish step', ''],
  ]);

  try {
    const exitCode = await runCli(
      ['init', '--guided'],
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
      {
        cwd: tempDir,
        async prompt(spec) {
          prompts.push(spec.message);
          if (!answers.has(spec.message)) {
            throw new Error(`Unexpected guided prompt: ${spec.message}`);
          }

          return answers.get(spec.message);
        },
      },
    );

    const projectYaml = await readFile(path.join(tempDir, '.compass/project.yaml'), 'utf8');
    const claude = await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8');
    const wip = await readFile(path.join(tempDir, '.compass/sessions/wip.md'), 'utf8');

    await assert.rejects(() => access(path.join(tempDir, 'AGENTS.md')));

    assert.equal(exitCode, 0);
    assert.equal(stderr.length, 0);
    assert.deepEqual(prompts, [
      'Project name',
      'Project mode',
      'How many repos belong to this logical project?',
      'Repo 1 id',
      'Repo 1 remote',
      'Repo 1 default branch',
      'Use primary-repo?',
      'Directory of the designated primary repo',
      'Scaffold workflow files (context.md plus guide READMEs)?',
      'Create a starter CLAUDE.md if missing?',
      'Create a starter AGENTS.md if missing?',
      'Open the first builder session immediately after init?',
      'What are you working on?',
      'Should close-session include a Git publish step?',
      'Git remote for the close-session publish step',
    ]);
    assert.ok(stdout.join('').includes('Placement: primary-repo'));
    assert.ok(stdout.join('').includes('Started session'));
    assert.match(projectYaml, /placement_pattern: primary-repo/);
    assert.match(projectYaml, /default_branch: main/);
    assert.match(projectYaml, /git_publish: true/);
    assert.match(projectYaml, /git_remote: origin/);
    assert.match(claude, /Working on: Bootstrap the guided init flow\./);
    assert.match(wip, /Bootstrap the guided init flow\./);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runCli guided init defaults a single primary repo to the matching child directory', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-cli-guided-child-repo-'));
  const stdout = [];
  const stderr = [];
  const prompts = [];
  const answers = new Map([
    ['Project name', 'Child Repo Project'],
    ['Project mode', 'local-only'],
    ['How many repos belong to this logical project?', '1'],
    ['Repo 1 id', 'app'],
    ['Repo 1 remote', 'https://github.com/example/app.git'],
    ['Repo 1 default branch', ''],
    ['Use primary-repo?', ''],
    ['Directory of the designated primary repo', ''],
    ['Scaffold workflow files (context.md plus guide READMEs)?', 'no'],
    ['Open the first builder session immediately after init?', 'no'],
  ]);

  try {
    await mkdir(path.join(tempDir, 'app'), { recursive: true });

    const exitCode = await runCli(
      ['init', '--guided'],
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
      {
        cwd: tempDir,
        async prompt(spec) {
          prompts.push(spec.message);
          if (!answers.has(spec.message)) {
            throw new Error(`Unexpected guided prompt: ${spec.message}`);
          }

          return answers.get(spec.message);
        },
      },
    );

    const projectYaml = await readFile(path.join(tempDir, 'app/.compass/project.yaml'), 'utf8');

    await assert.rejects(() => access(path.join(tempDir, '.compass/project.yaml')));

    assert.equal(exitCode, 0);
    assert.equal(stderr.length, 0);
    assert.deepEqual(prompts, [
      'Project name',
      'Project mode',
      'How many repos belong to this logical project?',
      'Repo 1 id',
      'Repo 1 remote',
      'Repo 1 default branch',
      'Use primary-repo?',
      'Directory of the designated primary repo',
      'Scaffold workflow files (context.md plus guide READMEs)?',
      'Open the first builder session immediately after init?',
    ]);
    assert.ok(stdout.join('').includes(path.join(tempDir, 'app/.compass')));
    assert.match(projectYaml, /placement_pattern: primary-repo/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('initializeProjectMemory regenerates context.md on rerun with force and workflow scaffolding', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-init-context-rewrite-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'First Name',
      mode: 'local-only',
      repos: [{ id: 'docs', remote: 'https://github.com/example/docs.git' }],
      bootstrap: {
        workflow: true,
      },
    });

    const contextPath = path.join(rootDir, 'context.md');
    await writeFile(contextPath, '# User edited context\n', 'utf8');

    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      force: true,
      name: 'Second Name',
      mode: 'local-only',
      repos: [{ id: 'docs', remote: 'https://github.com/example/docs.git' }],
      bootstrap: {
        workflow: true,
      },
    });

    const context = await readFile(contextPath, 'utf8');
    assert.match(context, /Project Context — Second Name/);
    assert.doesNotMatch(context, /User edited context/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('initializeProjectMemory never overwrites an existing tool bootstrap file', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-init-existing-tool-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    await writeFile(path.join(tempDir, 'AGENTS.md'), '# Existing AGENTS\n', 'utf8');

    const result = await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Existing Tool Project',
      mode: 'local-only',
      repos: [{ id: 'docs', remote: 'https://github.com/example/docs.git' }],
      bootstrap: {
        agents: true,
      },
    });

    const agents = await readFile(path.join(tempDir, 'AGENTS.md'), 'utf8');
    assert.equal(agents, '# Existing AGENTS\n');
    assert.ok(result.scaffoldSkippedFiles.includes(path.join(tempDir, 'AGENTS.md')));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('initializeProjectMemory rejects sync configuration outside local-primary mode', async () => {
  await assert.rejects(
    () =>
      initializeProjectMemory({
        rootDir: '/tmp/vibecompass-invalid-sync',
        name: 'Invalid Sync Project',
        mode: 'local-only',
        repos: [{ id: 'docs', remote: 'https://github.com/example/docs.git' }],
        sync: {
          apiUrl: 'https://vibecompass.dev',
          projectId: 'vc_proj_invalid',
          credentialEnvVar: 'VIBECOMPASS_SYNC_TOKEN',
        },
      }),
    /sync configuration is only supported when mode is local-primary/i,
  );
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
