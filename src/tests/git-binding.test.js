import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeProjectMemory } from '../init.js';
import { planDocsUpdate } from '../docs-update.js';
import {
  captureBaseRevisions,
  normalizeBranchName,
  preflightGitBinding,
  provisionGitBinding,
  rollbackGitBinding,
} from '../git-binding.js';
import { inspectProjectCompatibility } from '../compatibility.js';
import { getProjectStatus } from '../status.js';
import { writeStateManifest } from '../manifest.js';
import { scanProjectMemory } from '../project-memory.js';
import { runCli } from '../cli.js';
import { closeProjectSession, listProjectSessions, startProjectSession, writeLaneMarkerForSession } from '../session.js';
import { isSimpleYamlKeySafe, parseSimpleYaml } from '../simple-yaml.js';

const DOCUMENT_MAINTENANCE_UPDATED = {
  architectureDocs: 'updated',
  decisionLog: 'updated',
  sessionMaintenance: 'updated',
};
const CLOSE_DEFAULTS = {
  title: 'Lane Close',
  completed: ['Did the work'],
  nextSteps: ['Continue'],
  documentMaintenance: DOCUMENT_MAINTENANCE_UPDATED,
};

function hasGit() {
  return spawnSync('git', ['--version']).status === 0;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.toString().trim();
}

async function createGitRepoWithCommit(repoDir) {
  await mkdir(repoDir, { recursive: true });
  git(repoDir, ['init']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  await writeFile(path.join(repoDir, 'README.md'), 'hello\n', 'utf8');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'initial']);
  return git(repoDir, ['rev-parse', 'HEAD']);
}

async function createInitializedRoot(prefix, repos = [{ id: 'app', remote: 'https://github.com/example/app.git' }]) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const rootDir = path.join(tempDir, '.compass');
  await initializeProjectMemory({
    cwd: tempDir,
    rootDir,
    name: 'Git Binding Test',
    mode: 'local-only',
    repos,
    bootstrap: { workflow: true, claude: true },
  });
  return { tempDir, rootDir };
}

test('quoted scalars with backslashes and quotes round-trip symmetrically (S3-1)', () => {
  const parsed = parseSimpleYaml([
    'windows_path: "C:\\\\Users\\\\dev\\\\repo"',
    'quoted: "say \\"hi\\""',
    'legacy: "plain value"',
  ].join('\n'));
  assert.equal(parsed.windows_path, 'C:\\Users\\dev\\repo');
  assert.equal(parsed.quoted, 'say "hi"');
  assert.equal(parsed.legacy, 'plain value');
});

test('isSimpleYamlKeySafe accepts slug ids and rejects digit-leading or exotic ids', () => {
  assert.equal(isSimpleYamlKeySafe('app'), true);
  assert.equal(isSimpleYamlKeySafe('my-repo_2'), true);
  assert.equal(isSimpleYamlKeySafe('9lives'), false);
  assert.equal(isSimpleYamlKeySafe('a b'), false);
  assert.equal(isSimpleYamlKeySafe(''), false);
});

test('start-session captures base_revisions for claimed git repos (D-281)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-baserev-');

  try {
    const sha = await createGitRepoWithCommit(path.join(tempDir, 'app'));
    await startProjectSession({ cwd: tempDir, sessionId: 'lane-a', workingOn: 'Work', repos: ['app'] });

    const sessionYaml = await readFile(path.join(rootDir, 'sessions/active/lane-a/session.yaml'), 'utf8');
    assert.match(sessionYaml, /^base_revisions:$/m);
    assert.ok(sessionYaml.includes(`  app: "${sha}"`));

    const sessions = await listProjectSessions({ rootDir });
    assert.deepEqual(sessions.lanes[0].baseRevisions, { app: sha });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('base_revisions skips non-git dirs silently, warns on unborn HEAD and unsafe ids (D-281)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-baserev-skip-', [
    { id: 'app', remote: 'https://github.com/example/app.git' },
    { id: 'plain', remote: 'https://github.com/example/plain.git' },
  ]);

  try {
    // `app` is a git repo with no commits; `plain` is a plain directory.
    await mkdir(path.join(tempDir, 'app'), { recursive: true });
    git(path.join(tempDir, 'app'), ['init']);
    await mkdir(path.join(tempDir, 'plain'), { recursive: true });

    const result = await startProjectSession({
      cwd: tempDir,
      sessionId: 'lane-a',
      workingOn: 'Work',
      repos: ['app', 'plain'],
    });
    assert.ok(result.warnings.some((warning) => /base_revisions skipped for repo "app": .*no commits yet/.test(warning)));
    assert.ok(!result.warnings.some((warning) => warning.includes('"plain"')), 'non-git dirs skip silently');

    const sessionYaml = await readFile(path.join(rootDir, 'sessions/active/lane-a/session.yaml'), 'utf8');
    assert.ok(!/^base_revisions:$/m.test(sessionYaml), 'no base_revisions block when nothing was captured');

    // Unsafe map keys fail closed with a warning (no parser relaxation).
    const capture = await captureBaseRevisions({ workspaceDir: tempDir, repoIds: ['9lives'], projectRepos: [] });
    assert.deepEqual(capture.baseRevisions, {});
    assert.ok(capture.warnings.some((warning) => /not a safe session\.yaml map key/.test(warning)));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('git-binding session.yaml fields round-trip, survive rebuild-active-index, and reach the manifest', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-binding-roundtrip-');

  try {
    await startProjectSession({ cwd: tempDir, sessionId: 'lane-a', workingOn: 'Bound work', repos: ['app'] });
    await startProjectSession({ cwd: tempDir, sessionId: 'lane-b', workingOn: 'Unbound work' });

    const container = path.join(tempDir, 'worktrees', 'lane-a');
    await appendFile(
      path.join(rootDir, 'sessions/active/lane-a/session.yaml'),
      [
        'branch: "feature-x"',
        `worktree_container: ${JSON.stringify(container)}`,
        'worktrees:',
        `  app: ${JSON.stringify(path.join(container, 'app'))}`,
        'worktree_sources:',
        `  app: ${JSON.stringify(path.join(tempDir, 'app'))}`,
        'base_revisions:',
        '  app: 12345',
        '',
      ].join('\n'),
      'utf8',
    );

    const sessions = await listProjectSessions({ rootDir });
    const bound = sessions.lanes.find((lane) => lane.id === 'lane-a');
    assert.equal(bound.branch, 'feature-x');
    assert.equal(bound.worktreeContainer, container);
    assert.deepEqual(bound.worktrees, { app: path.join(container, 'app') });
    assert.deepEqual(bound.worktreeSources, { app: path.join(tempDir, 'app') });
    // Unquoted numeric revisions normalize back to strings.
    assert.deepEqual(bound.baseRevisions, { app: '12345' });

    // rebuild-active-index re-enumerates lane dirs without corrupting fields.
    const io = { stdout: { write() {} }, stderr: { write() {} } };
    await runCli(['rebuild-active-index', '--root', rootDir, '--current', 'lane-a'], io, { cwd: tempDir });
    const rebuilt = await listProjectSessions({ rootDir });
    assert.equal(rebuilt.lanes.find((lane) => lane.id === 'lane-a').branch, 'feature-x');

    const { manifest } = await writeStateManifest(rootDir);
    const manifestLaneA = manifest.active_sessions.lanes.find((lane) => lane.id === 'lane-a');
    const manifestLaneB = manifest.active_sessions.lanes.find((lane) => lane.id === 'lane-b');
    assert.equal(manifestLaneA.branch, 'feature-x');
    assert.equal(manifestLaneA.worktree_container, container);
    assert.ok(!('branch' in manifestLaneB), 'unbound lanes keep the pre-S3 manifest shape');
    assert.ok(!('worktree_container' in manifestLaneB));

    // D-278 regression: lane metadata never becomes a scanned/pushable
    // document, and a stray lane-local markdown file (live-dogfood finding:
    // a lane plan.md previously failed the whole scan as a malformed session
    // note) neither errors nor appears.
    await writeFile(path.join(rootDir, 'sessions/active/lane-a/plan.md'), '# Lane plan\nNot a session note.\n', 'utf8');
    const scan = await scanProjectMemory(rootDir);
    assert.equal(scan.errors.length, 0, 'lane-local files must not fail-close the scan');
    assert.ok(
      scan.documents.every((document) => !document.path.startsWith('sessions/active/')),
      'sessions/active/** must stay out of canonical document scans',
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('docs-update scans recorded lane worktrees with repo prefixes and skips the unprefixed cwd scan inside them (D-281)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-binding-docsupdate-');

  try {
    // Clean source checkout for `app`.
    await createGitRepoWithCommit(path.join(tempDir, 'app'));
    // Recorded "worktree" with a dirty file (docs-update only needs a git
    // status surface there, not a real linked worktree).
    const worktreeDir = path.join(tempDir, 'worktrees', 'lane-a', 'app');
    await createGitRepoWithCommit(worktreeDir);
    await writeFile(path.join(worktreeDir, 'src.ts'), 'export const x = 1;\n', 'utf8');

    await startProjectSession({ cwd: tempDir, sessionId: 'lane-a', workingOn: 'Bound work', repos: ['app'] });
    await appendFile(
      path.join(rootDir, 'sessions/active/lane-a/session.yaml'),
      ['worktrees:', `  app: ${JSON.stringify(worktreeDir)}`, ''].join('\n'),
      'utf8',
    );

    // From inside the recorded worktree: prefixed delta, no unprefixed twin.
    const fromInside = await planDocsUpdate({ cwd: path.join(worktreeDir), rootDir, sessionId: 'lane-a' });
    assert.ok(fromInside.delta.changedFiles.includes('app:src.ts'));
    assert.ok(!fromInside.delta.changedFiles.includes('src.ts'), 'no unprefixed duplicate from the cwd scan');

    // From the container root: same prefixed delta.
    const fromContainer = await planDocsUpdate({ cwd: path.join(tempDir, 'worktrees', 'lane-a'), rootDir, sessionId: 'lane-a' });
    assert.ok(fromContainer.delta.changedFiles.includes('app:src.ts'));

    // Source checkout stays clean: nothing else reported for `app`.
    assert.ok(!fromInside.delta.changedFiles.some((file) => file.startsWith('app:README')), 'clean source not scanned into the delta');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('pre-S3 lanes without git-binding fields parse with empty defaults everywhere', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-binding-pre-s3-');

  try {
    await startProjectSession({ cwd: tempDir, sessionId: 'lane-a', workingOn: 'Plain work' });

    const sessions = await listProjectSessions({ rootDir });
    const lane = sessions.lanes[0];
    assert.equal(lane.branch, null);
    assert.equal(lane.worktreeContainer, null);
    assert.deepEqual(lane.worktrees, {});
    assert.deepEqual(lane.worktreeSources, {});
    assert.deepEqual(lane.baseRevisions, {});

    const { manifest } = await writeStateManifest(rootDir);
    assert.ok(!('branch' in manifest.active_sessions.lanes[0]));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------- S3-2: branch normalization + preflight (unit level) ----------

test('normalizeBranchName validates via git and rejects @{ shorthand', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  assert.equal(await normalizeBranchName('feature/login '), 'feature/login');
  await assert.rejects(normalizeBranchName('@{-1}'), /contains "@\{"/);
  await assert.rejects(normalizeBranchName('-bad'), /not a valid git branch name/);
  await assert.rejects(normalizeBranchName(''), /non-empty/);
});

test('preflightGitBinding fails closed across the D-266/D-279 matrix', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-preflight-'));
  const rootDir = path.join(tempDir, '.compass');
  const containerDir = path.join(tempDir, 'worktrees', 'lane-a');
  const projectRepos = [{ id: 'app', remote: 'https://github.com/example/app.git' }];
  const base = { workspaceDir: tempDir, rootDir, branch: 'feat', worktree: false, projectRepos, existingLanes: [], containerDir };

  try {
    await mkdir(rootDir, { recursive: true });

    // No repos bound.
    await assert.rejects(preflightGitBinding({ ...base, repoIds: [] }), /requires at least one --repo/);
    // Undeclared repo.
    await assert.rejects(preflightGitBinding({ ...base, repoIds: ['ghost'] }), /not declared in project\.yaml/);
    // Not a git repository.
    await mkdir(path.join(tempDir, 'app'), { recursive: true });
    await assert.rejects(preflightGitBinding({ ...base, repoIds: ['app'] }), /git could not resolve a work tree/);
    // Unborn HEAD.
    git(path.join(tempDir, 'app'), ['init']);
    await assert.rejects(preflightGitBinding({ ...base, repoIds: ['app'] }), /at least one commit/);
    // Subdirectory of a repo, not its root.
    await createGitRepoWithCommit(path.join(tempDir, 'outer'));
    await mkdir(path.join(tempDir, 'outer', 'inner'), { recursive: true });
    await assert.rejects(
      preflightGitBinding({
        ...base,
        repoIds: ['inner'],
        projectRepos: [{ id: 'inner', remote: 'https://github.com/example/inner.git', path: 'outer/inner' }],
      }),
      /sits inside the git repository rooted at/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('preflightGitBinding enforces the D-266 memory-fork guard in both directions', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-d266-'));

  try {
    // Primary-repo layout: the memory root sits inside the repo work tree.
    const repoDir = path.join(tempDir, 'primary');
    await createGitRepoWithCommit(repoDir);
    await mkdir(path.join(repoDir, '.compass'), { recursive: true });
    await assert.rejects(
      preflightGitBinding({
        workspaceDir: repoDir,
        rootDir: path.join(repoDir, '.compass'),
        branch: 'feat',
        worktree: false,
        repoIds: ['primary'],
        projectRepos: [{ id: 'primary', remote: 'https://github.com/example/primary.git', path: '.' }],
        existingLanes: [],
        containerDir: path.join(repoDir, 'worktrees', 'lane-a'),
      }),
      /would fork shared memory \(D-266\)/,
    );

    // Inverse: a repo work tree inside the memory root.
    const rootDir = path.join(tempDir, 'root', '.compass');
    const insideRepo = path.join(rootDir, 'code');
    await createGitRepoWithCommit(insideRepo);
    await assert.rejects(
      preflightGitBinding({
        workspaceDir: path.join(tempDir, 'root'),
        rootDir,
        branch: 'feat',
        worktree: false,
        repoIds: ['code'],
        projectRepos: [{ id: 'code', remote: 'https://github.com/example/code.git', path: '.compass/code' }],
        existingLanes: [],
        containerDir: path.join(tempDir, 'root', 'worktrees', 'lane-a'),
      }),
      /code never lives in package memory \(D-278\)/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('preflightGitBinding placement guard refuses a workspace inside a git work tree (--worktree)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-placement-'));

  try {
    const repoDir = path.join(tempDir, 'primary');
    await createGitRepoWithCommit(repoDir);
    await assert.rejects(
      preflightGitBinding({
        workspaceDir: repoDir,
        rootDir: path.join(repoDir, '.compass'),
        branch: 'feat',
        worktree: true,
        repoIds: ['primary'],
        projectRepos: [{ id: 'primary', remote: 'https://github.com/example/primary.git', path: '.' }],
        existingLanes: [],
        containerDir: path.join(repoDir, 'worktrees', 'lane-a'),
      }),
      /sits inside the git work tree at .*Run without --worktree/s,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('preflightGitBinding branch-state probes: checked-out fails worktree mode, warns branch-only; reuse records the tip', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-branchstate-'));
  const rootDir = path.join(tempDir, '.compass');
  const projectRepos = [{ id: 'app', remote: 'https://github.com/example/app.git' }];
  const base = { workspaceDir: tempDir, rootDir, projectRepos, existingLanes: [], containerDir: path.join(tempDir, 'worktrees', 'lane-a'), repoIds: ['app'] };

  try {
    await mkdir(rootDir, { recursive: true });
    const appDir = path.join(tempDir, 'app');
    const headSha = await createGitRepoWithCommit(appDir);
    const mainBranch = git(appDir, ['branch', '--show-current']);

    // The currently checked-out branch: worktree mode fails with prune hint,
    // branch-only warns and reuses.
    await assert.rejects(
      preflightGitBinding({ ...base, branch: mainBranch, worktree: true }),
      /already checked out at .*worktree prune/s,
    );
    const branchOnly = await preflightGitBinding({ ...base, branch: mainBranch, worktree: false });
    assert.ok(branchOnly.warnings.some((warning) => /already checked out/.test(warning)));
    assert.equal(branchOnly.repoPlans[0].mode, 'reuse');

    // An existing unchecked-out branch with a divergent tip: reuse mode bases
    // on the branch tip, not source HEAD.
    git(appDir, ['branch', 'side']);
    await writeFile(path.join(appDir, 'second.txt'), 'x\n', 'utf8');
    git(appDir, ['add', '.']);
    git(appDir, ['commit', '-m', 'second']);
    const preflight = await preflightGitBinding({ ...base, branch: 'side', worktree: true });
    assert.equal(preflight.repoPlans[0].mode, 'reuse');
    assert.equal(preflight.repoPlans[0].baseRevision, headSha);
    assert.notEqual(preflight.repoPlans[0].baseRevision, git(appDir, ['rev-parse', 'HEAD']));
    assert.ok(preflight.warnings.some((warning) => /already exists in repo "app"; reusing it/.test(warning)));

    // Absent branch: create mode from source HEAD; dirty source warns.
    await writeFile(path.join(appDir, 'dirty.txt'), 'uncommitted\n', 'utf8');
    const createPlan = await preflightGitBinding({ ...base, branch: 'feat', worktree: true });
    assert.equal(createPlan.repoPlans[0].mode, 'create');
    assert.equal(createPlan.repoPlans[0].baseRevision, git(appDir, ['rev-parse', 'HEAD']));
    assert.ok(createPlan.warnings.some((warning) => /uncommitted changes/.test(warning)));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('preflightGitBinding cross-lane checks: same branch errors, divergent branch warns', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-crosslane-'));
  const rootDir = path.join(tempDir, '.compass');
  const projectRepos = [{ id: 'app', remote: 'https://github.com/example/app.git' }];

  try {
    await mkdir(rootDir, { recursive: true });
    await createGitRepoWithCommit(path.join(tempDir, 'app'));
    const base = {
      workspaceDir: tempDir,
      rootDir,
      worktree: false,
      repoIds: ['app'],
      projectRepos,
      containerDir: path.join(tempDir, 'worktrees', 'lane-b'),
    };

    await assert.rejects(
      preflightGitBinding({ ...base, branch: 'feat', existingLanes: [{ id: 'lane-a', branch: 'feat', repos: ['app'] }] }),
      /already binds branch "feat" in shared repo/,
    );
    const divergent = await preflightGitBinding({ ...base, branch: 'feat', existingLanes: [{ id: 'lane-a', branch: 'other', repos: ['app'] }] });
    assert.ok(divergent.warnings.some((warning) => /binds branch "other" in shared repo/.test(warning)));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------- S3-2: provisioning integration ----------

test('start-session --branch --worktree provisions worktrees, marker, and records the full binding (D-281)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-provision-', [
    { id: 'app', remote: 'https://github.com/example/app.git' },
    { id: 'lib', remote: 'https://github.com/example/lib.git' },
  ]);

  try {
    const appSha = await createGitRepoWithCommit(path.join(tempDir, 'app'));
    const libSha = await createGitRepoWithCommit(path.join(tempDir, 'lib'));

    const result = await startProjectSession({
      cwd: tempDir,
      sessionId: 'lane-a',
      workingOn: 'Bound work',
      repos: ['app', 'lib'],
      branch: 'feat',
      worktree: true,
    });

    const container = path.join(tempDir, 'worktrees', 'lane-a');
    assert.equal(result.gitBinding.branch, 'feat');
    assert.equal(result.gitBinding.worktreeContainer, container);
    assert.equal(result.gitBinding.markerPath, path.join(container, '.vibecompass-lane.yaml'));
    assert.deepEqual(
      result.gitBinding.repos.map((repo) => [repo.repoId, repo.mode, repo.baseRevision]),
      [['app', 'create', appSha], ['lib', 'create', libSha]],
    );

    // Real worktrees checked out ON the branch (not detached).
    for (const repoId of ['app', 'lib']) {
      const worktreePath = path.join(container, repoId);
      assert.equal(git(worktreePath, ['symbolic-ref', 'HEAD']), 'refs/heads/feat');
    }

    // session.yaml records the whole plan; marker resolves from worktree cwds
    // AND from the container root itself.
    const sessions = await listProjectSessions({ rootDir });
    const lane = sessions.lanes[0];
    assert.equal(lane.branch, 'feat');
    assert.equal(lane.worktreeContainer, container);
    assert.deepEqual(lane.worktrees, { app: path.join(container, 'app'), lib: path.join(container, 'lib') });
    assert.deepEqual(lane.worktreeSources, { app: path.join(tempDir, 'app'), lib: path.join(tempDir, 'lib') });
    assert.deepEqual(lane.baseRevisions, { app: appSha, lib: libSha });

    const fromWorktree = await listProjectSessions({ cwd: path.join(container, 'app') });
    assert.equal(fromWorktree.rootDir, rootDir);
    const fromContainer = await listProjectSessions({ cwd: container });
    assert.equal(fromContainer.rootDir, rootDir);

    // The manifest projection carries the binding.
    const { manifest } = await writeStateManifest(rootDir);
    assert.equal(manifest.active_sessions.lanes[0].branch, 'feat');
    assert.equal(manifest.active_sessions.lanes[0].worktree_container, container);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('start-session --branch without --worktree creates refs only; --worktree without --branch is refused', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-branchonly-');

  try {
    await createGitRepoWithCommit(path.join(tempDir, 'app'));

    await assert.rejects(
      startProjectSession({ cwd: tempDir, sessionId: 'lane-x', workingOn: 'W', worktree: true }),
      /--worktree requires --branch/,
    );

    const result = await startProjectSession({
      cwd: tempDir,
      sessionId: 'lane-a',
      workingOn: 'Branch-only work',
      repos: ['app'],
      branch: 'feat',
    });
    assert.equal(result.gitBinding.branch, 'feat');
    assert.equal(result.gitBinding.worktreeContainer, null);
    assert.equal(result.gitBinding.markerPath, null);
    // Ref created without touching the checkout.
    assert.equal(git(path.join(tempDir, 'app'), ['rev-parse', '--verify', 'refs/heads/feat']).length > 0, true);
    assert.notEqual(git(path.join(tempDir, 'app'), ['branch', '--show-current']), 'feat');
    // No container, no marker, no worktrees recorded.
    const lane = (await listProjectSessions({ rootDir })).lanes[0];
    assert.equal(lane.branch, 'feat');
    assert.equal(lane.worktreeContainer, null);
    assert.deepEqual(lane.worktrees, {});
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('a mid-provision failure rolls the whole start back: no lane, no worktrees, no created branches (D-281)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-rollback-', [
    { id: 'app', remote: 'https://github.com/example/app.git' },
    { id: 'lib', remote: 'https://github.com/example/lib.git' },
  ]);

  try {
    await createGitRepoWithCommit(path.join(tempDir, 'app'));
    await createGitRepoWithCommit(path.join(tempDir, 'lib'));
    // Inject a deterministic failure into repo B's worktree add: a failing
    // post-checkout hook makes `git worktree add` exit 1 AFTER creating the
    // worktree and branch — the registered-but-partial state.
    const hookPath = path.join(tempDir, 'lib', '.git', 'hooks', 'post-checkout');
    await writeFile(hookPath, '#!/bin/sh\nexit 1\n', 'utf8');
    await chmod(hookPath, 0o755);

    const claudeBefore = await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8');
    await assert.rejects(
      startProjectSession({
        cwd: tempDir,
        sessionId: 'lane-a',
        workingOn: 'Doomed work',
        repos: ['app', 'lib'],
        branch: 'feat',
        worktree: true,
      }),
      /rolled back and lane "lane-a" was not created/,
    );

    // Nothing survives: lane dir, container, worktrees, branches, CLAUDE.md
    // block, index.
    assert.equal(existsSync(path.join(rootDir, 'sessions/active/lane-a')), false);
    assert.equal(existsSync(path.join(tempDir, 'worktrees', 'lane-a')), false);
    assert.equal(spawnSync('git', ['-C', path.join(tempDir, 'app'), 'rev-parse', '--verify', '--quiet', 'refs/heads/feat']).status !== 0, true, 'created branch removed from app');
    assert.equal(spawnSync('git', ['-C', path.join(tempDir, 'lib'), 'rev-parse', '--verify', '--quiet', 'refs/heads/feat']).status !== 0, true, 'partial branch removed from lib');
    assert.equal(git(path.join(tempDir, 'app'), ['worktree', 'list', '--porcelain']).split('worktree ').length, 2, 'no lingering worktree registration in app');
    assert.equal(await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8'), claudeBefore);
    assert.deepEqual((await listProjectSessions({ rootDir })).lanes, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('write-lane-marker refuses to rebind a lane with a provisioned worktree container (D-281)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir } = await createInitializedRoot('vibecompass-rebind-refuse-');

  try {
    await createGitRepoWithCommit(path.join(tempDir, 'app'));
    await startProjectSession({
      cwd: tempDir,
      sessionId: 'lane-a',
      workingOn: 'Bound work',
      repos: ['app'],
      branch: 'feat',
      worktree: true,
    });

    const elsewhere = path.join(tempDir, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    await assert.rejects(
      writeLaneMarkerForSession({ cwd: tempDir, sessionId: 'lane-a', dir: elsewhere }),
      /provisioned worktree container .*orphan the worktree-removal guard \(D-281\)/s,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('CLI: --worktree parses as boolean, --worktree= is rejected, init refuses --branch', async () => {
  const io = { stdout: { write() {} }, stderr: { write() {} } };

  await assert.rejects(
    runCli(['start-session', '--id', 'lane-a', '--working-on', 'W', '--worktree=../x'], io, {}),
    /--worktree" takes no value/,
  );
  await assert.rejects(
    runCli(['init', '--branch', 'feat'], io, {}),
    /Unknown flag "--branch"/,
  );
});

// ---------- Fleet-finding regression tests ----------

test('close-session refuses while provisioned worktrees survive, then closes cleanly after manual removal (D-281 interim guard)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-close-guard-');

  try {
    await createGitRepoWithCommit(path.join(tempDir, 'app'));
    await startProjectSession({
      cwd: tempDir,
      sessionId: 'lane-a',
      workingOn: 'Bound work',
      repos: ['app'],
      branch: 'feat',
      worktree: true,
    });
    const container = path.join(tempDir, 'worktrees', 'lane-a');
    const markerPath = path.join(container, '.vibecompass-lane.yaml');

    // Refusal lists the worktree and the manual cleanup command; nothing is
    // destroyed (marker + lane records intact).
    await assert.rejects(
      closeProjectSession({ cwd: tempDir, sessionId: 'lane-a', ...CLOSE_DEFAULTS }),
      /still has provisioned worktrees on disk[\s\S]*git -C .* worktree remove/,
    );
    assert.equal(existsSync(markerPath), true, 'marker must survive a refused close');
    assert.equal(existsSync(path.join(rootDir, 'sessions/active/lane-a/session.yaml')), true);

    // After manual worktree removal, recorded-but-missing is benign and the
    // close proceeds, removing the container marker token-matched.
    git(path.join(tempDir, 'app'), ['worktree', 'remove', path.join(container, 'app')]);
    const result = await closeProjectSession({ cwd: tempDir, sessionId: 'lane-a', ...CLOSE_DEFAULTS });
    assert.equal(result.sessionId, 'lane-a');
    assert.equal(existsSync(markerPath), false, 'marker removed token-matched at close');
    assert.deepEqual((await listProjectSessions({ rootDir })).lanes, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('rollback preserves a branch created externally between preflight and provisioning (TOCTOU, D-281)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-toctou-'));

  try {
    const repoDir = path.join(tempDir, 'app');
    await createGitRepoWithCommit(repoDir);
    const preflight = await preflightGitBinding({
      workspaceDir: tempDir,
      rootDir: path.join(tempDir, '.compass'),
      branch: 'feat',
      worktree: true,
      repoIds: ['app'],
      projectRepos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
      existingLanes: [],
      containerDir: path.join(tempDir, 'worktrees', 'lane-a'),
    });
    assert.equal(preflight.repoPlans[0].mode, 'create');

    // External actor creates the branch at a commit only reachable through it.
    const mainBranch = git(repoDir, ['branch', '--show-current']);
    git(repoDir, ['checkout', '-b', 'feat']);
    await writeFile(path.join(repoDir, 'user-work.txt'), 'precious\n', 'utf8');
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-m', 'user work']);
    const userTip = git(repoDir, ['rev-parse', 'HEAD']);
    git(repoDir, ['checkout', mainBranch]);

    const progress = { worktrees: [], createdBranches: [] };
    await assert.rejects(
      provisionGitBinding({ branch: 'feat', repoPlans: preflight.repoPlans }, progress),
      /already exists/,
    );
    // Ownership is recorded only after a successful create, so the failed
    // create leaves no record and rollback cannot touch the external ref.
    assert.deepEqual(progress.createdBranches, []);
    await rollbackGitBinding(progress, 'feat');
    assert.equal(git(repoDir, ['rev-parse', 'refs/heads/feat']), userTip, 'external branch must survive rollback');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('rollback preserves a SAME-TIP externally created branch in both branch-only and worktree modes (D-281)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-toctou-sametip-'));

  try {
    const repoDir = path.join(tempDir, 'app');
    const headSha = await createGitRepoWithCommit(repoDir);
    const base = {
      workspaceDir: tempDir,
      rootDir: path.join(tempDir, '.compass'),
      branch: 'feat',
      repoIds: ['app'],
      projectRepos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
      existingLanes: [],
      containerDir: path.join(tempDir, 'worktrees', 'lane-a'),
    };

    // Branch-only mode: external actor creates the branch at the SAME start
    // commit after preflight — indistinguishable from an in-call create by
    // tip alone, which is exactly why ownership must come from the create
    // command's success, not tip equality.
    const branchOnly = await preflightGitBinding({ ...base, worktree: false });
    assert.equal(branchOnly.repoPlans[0].mode, 'create');
    git(repoDir, ['branch', 'feat', headSha]);
    const progressA = { worktrees: [], createdBranches: [] };
    await assert.rejects(
      provisionGitBinding({ branch: 'feat', repoPlans: branchOnly.repoPlans }, progressA),
      /already exists/,
    );
    assert.deepEqual(progressA.createdBranches, []);
    await rollbackGitBinding(progressA, 'feat');
    assert.equal(git(repoDir, ['rev-parse', 'refs/heads/feat']), headSha, 'same-tip external branch survives branch-only rollback');
    git(repoDir, ['branch', '-D', 'feat']);

    // Worktree mode: the split create fails the same way BEFORE any checkout,
    // so no worktree or registration exists either.
    const worktreeMode = await preflightGitBinding({ ...base, worktree: true });
    assert.equal(worktreeMode.repoPlans[0].mode, 'create');
    git(repoDir, ['branch', 'feat', headSha]);
    const progressB = { worktrees: [], createdBranches: [] };
    await assert.rejects(
      provisionGitBinding({ branch: 'feat', repoPlans: worktreeMode.repoPlans }, progressB),
      /already exists/,
    );
    assert.deepEqual(progressB.createdBranches, []);
    await rollbackGitBinding(progressB, 'feat');
    assert.equal(git(repoDir, ['rev-parse', 'refs/heads/feat']), headSha, 'same-tip external branch survives worktree-mode rollback');
    assert.equal(existsSync(path.join(base.containerDir, 'app')), false, 'no worktree was created');
    assert.equal(git(repoDir, ['worktree', 'list', '--porcelain']).split('worktree ').length, 2, 'no lingering registration');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('reuse-mode provisioning checks out the existing branch and bases on its tip, and rollback preserves reused branches', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-reuse-', [
    { id: 'appa', remote: 'https://github.com/example/appa.git' },
    { id: 'appb', remote: 'https://github.com/example/appb.git' },
  ]);

  try {
    // appa: branch `feat` exists at commit1 while HEAD advances to commit2.
    const appaDir = path.join(tempDir, 'appa');
    const commit1 = await createGitRepoWithCommit(appaDir);
    git(appaDir, ['branch', 'feat']);
    await writeFile(path.join(appaDir, 'second.txt'), 'x\n', 'utf8');
    git(appaDir, ['add', '.']);
    git(appaDir, ['commit', '-m', 'second']);
    await createGitRepoWithCommit(path.join(tempDir, 'appb'));

    const result = await startProjectSession({
      cwd: tempDir,
      sessionId: 'lane-a',
      workingOn: 'Reuse work',
      repos: ['appa', 'appb'],
      branch: 'feat',
      worktree: true,
    });
    const appaWorktree = path.join(tempDir, 'worktrees', 'lane-a', 'appa');
    assert.equal(git(appaWorktree, ['symbolic-ref', 'HEAD']), 'refs/heads/feat', 'reuse mode must check the branch out, not detach');
    assert.equal(git(appaWorktree, ['rev-parse', 'HEAD']), commit1, 'worktree sits at the reused branch tip');
    const lane = (await listProjectSessions({ rootDir })).lanes[0];
    assert.equal(lane.baseRevisions.appa, commit1, 'reuse-mode base is the branch tip, not source HEAD');
    assert.deepEqual(result.gitBinding.repos.map((repo) => repo.mode), ['reuse', 'create']);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('a failed provision with a sibling lane restores the pre-existing index and CLAUDE.md block, and reused branches survive', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-rollback-index-', [
    { id: 'appa', remote: 'https://github.com/example/appa.git' },
    { id: 'appb', remote: 'https://github.com/example/appb.git' },
  ]);

  try {
    const appaDir = path.join(tempDir, 'appa');
    await createGitRepoWithCommit(appaDir);
    git(appaDir, ['branch', 'feat']);
    await createGitRepoWithCommit(path.join(tempDir, 'appb'));
    // Fail appb's worktree add after appa (reuse mode) succeeds.
    const hookPath = path.join(tempDir, 'appb', '.git', 'hooks', 'post-checkout');
    await writeFile(hookPath, '#!/bin/sh\nexit 1\n', 'utf8');
    await chmod(hookPath, 0o755);

    await startProjectSession({ cwd: tempDir, sessionId: 'lane-prior', workingOn: 'Prior work' });
    const indexBefore = await readFile(path.join(rootDir, 'sessions/active/index.yaml'), 'utf8');
    const claudeBefore = await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8');

    await assert.rejects(
      startProjectSession({
        cwd: tempDir,
        sessionId: 'lane-b',
        workingOn: 'Doomed',
        repos: ['appa', 'appb'],
        branch: 'feat',
        worktree: true,
      }),
      /rolled back/,
    );

    assert.equal(await readFile(path.join(rootDir, 'sessions/active/index.yaml'), 'utf8'), indexBefore, 'pre-existing index restored');
    assert.equal(await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8'), claudeBefore, 'CLAUDE.md block restored');
    assert.deepEqual((await listProjectSessions({ rootDir })).lanes.map((lane) => lane.id), ['lane-prior']);
    assert.equal(git(appaDir, ['rev-parse', '--verify', 'refs/heads/feat']).length > 0, true, 'reused branch survives rollback');
    assert.equal(existsSync(path.join(tempDir, 'worktrees', 'lane-b')), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('provisioning works for declared repo.path ≠ id and under an existing worktrees/ parent', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-pathid-', [
    { id: 'app', path: 'code/app' },
  ]);

  try {
    await createGitRepoWithCommit(path.join(tempDir, 'code', 'app'));
    // Existing container parent from another lane.
    await mkdir(path.join(tempDir, 'worktrees', 'other-lane'), { recursive: true });

    await startProjectSession({
      cwd: tempDir,
      sessionId: 'lane-a',
      workingOn: 'Pathed work',
      repos: ['app'],
      branch: 'feat',
      worktree: true,
    });
    const lane = (await listProjectSessions({ rootDir })).lanes[0];
    assert.equal(lane.worktreeSources.app, path.join(tempDir, 'code', 'app'));
    assert.equal(git(path.join(tempDir, 'worktrees', 'lane-a', 'app'), ['symbolic-ref', 'HEAD']), 'refs/heads/feat');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('docs-update does not double-report when cwd sits inside a declared source repo', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-docsdup-');

  try {
    const appDir = path.join(tempDir, 'app');
    await createGitRepoWithCommit(appDir);
    await mkdir(path.join(appDir, 'src'), { recursive: true });
    await writeFile(path.join(appDir, 'src', 'x.ts'), 'export const x = 1;\n', 'utf8');
    await startProjectSession({ cwd: tempDir, sessionId: 'lane-a', workingOn: 'W' });

    const plan = await planDocsUpdate({ cwd: path.join(appDir, 'src'), rootDir, sessionId: 'lane-a' });
    assert.ok(plan.delta.changedFiles.includes('src/x.ts'), 'cwd scan reports the toplevel-relative path');
    assert.ok(!plan.delta.changedFiles.includes('app:src/x.ts'), 'no prefixed duplicate of the same file');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('docs-update falls back to the source checkout with a warning when a recorded worktree is missing', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-missing-wt-');

  try {
    const appDir = path.join(tempDir, 'app');
    await createGitRepoWithCommit(appDir);
    await writeFile(path.join(appDir, 'pending.ts'), 'export const p = 1;\n', 'utf8');
    await startProjectSession({ cwd: tempDir, sessionId: 'lane-a', workingOn: 'W', repos: ['app'] });
    await appendFile(
      path.join(rootDir, 'sessions/active/lane-a/session.yaml'),
      ['worktrees:', `  app: ${JSON.stringify(path.join(tempDir, 'worktrees', 'lane-a', 'app'))}`, ''].join('\n'),
      'utf8',
    );

    const plan = await planDocsUpdate({ cwd: tempDir, rootDir, sessionId: 'lane-a' });
    assert.ok(plan.delta.changedFiles.includes('app:pending.ts'), 'source fallback keeps the repo delta visible');
    assert.ok(plan.warnings.some((warning) => /Recorded worktree .* does not exist/.test(warning)));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('compatibility preflight and status surface a warning when a marker cannot be resolved', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-marker-warn-'));

  try {
    await writeFile(path.join(tempDir, '.vibecompass-lane.yaml'), 'format_version: 99\n', 'utf8');

    const compatibility = await inspectProjectCompatibility({ cwd: tempDir });
    assert.equal(compatibility.rootDir, path.join(tempDir, '.compass'));
    assert.ok(compatibility.warnings.some((warning) => warning.code === 'lane-marker-unreadable'));

    const status = await getProjectStatus({ cwd: tempDir });
    assert.ok(status.compatibility.warnings.some((warning) => warning.code === 'lane-marker-unreadable'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('write-lane-marker fails closed when the lane session.yaml is unparseable', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-rebind-parse-');

  try {
    await startProjectSession({ cwd: tempDir, sessionId: 'lane-a', workingOn: 'W' });
    await writeFile(path.join(rootDir, 'sessions/active/lane-a/session.yaml'), '\tbroken: yaml\n', 'utf8');

    const target = path.join(tempDir, 'target');
    await mkdir(target, { recursive: true });
    await assert.rejects(
      writeLaneMarkerForSession({ cwd: tempDir, sessionId: 'lane-a', dir: target }),
      /could not be parsed .*refusing to rebind/s,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('captureBaseRevisions skips a claimed dir that is not a repository root (enclosing repo)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-nested-baserev-'));

  try {
    const outerDir = path.join(tempDir, 'outer');
    await createGitRepoWithCommit(outerDir);
    await mkdir(path.join(outerDir, 'nested'), { recursive: true });

    const capture = await captureBaseRevisions({
      workspaceDir: outerDir,
      repoIds: ['nested'],
      projectRepos: [],
    });
    assert.deepEqual(capture.baseRevisions, {}, 'must not record the enclosing repo head for a nested dir');
    assert.deepEqual(capture.warnings, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('two concurrent git-bound starts on disjoint repos serialize cleanly under the root lock', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-race-', [
    { id: 'appa', remote: 'https://github.com/example/appa.git' },
    { id: 'appb', remote: 'https://github.com/example/appb.git' },
  ]);

  try {
    await createGitRepoWithCommit(path.join(tempDir, 'appa'));
    await createGitRepoWithCommit(path.join(tempDir, 'appb'));

    await Promise.all([
      startProjectSession({ cwd: tempDir, sessionId: 'lane-x', workingOn: 'X', repos: ['appa'], branch: 'feat-x', worktree: true }),
      startProjectSession({ cwd: tempDir, sessionId: 'lane-y', workingOn: 'Y', repos: ['appb'], branch: 'feat-y', worktree: true }),
    ]);

    const sessions = await listProjectSessions({ rootDir });
    assert.deepEqual(sessions.lanes.map((lane) => lane.id).sort(), ['lane-x', 'lane-y']);
    assert.equal(git(path.join(tempDir, 'worktrees', 'lane-x', 'appa'), ['symbolic-ref', 'HEAD']), 'refs/heads/feat-x');
    assert.equal(git(path.join(tempDir, 'worktrees', 'lane-y', 'appb'), ['symbolic-ref', 'HEAD']), 'refs/heads/feat-y');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
