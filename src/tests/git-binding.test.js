import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
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
  removeLaneWorktreesAtClose,
  rollbackGitBinding,
} from '../git-binding.js';
import { renderLaneMarker } from '../lane-marker.js';
import { PACKAGE_VERSION } from '../version.js';
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

// ---------- S3-3: close-side guarded worktree removal (D-281) ----------

async function startBoundLane(tempDir, laneId = 'lane-a', branch = 'feat') {
  await startProjectSession({
    cwd: tempDir,
    sessionId: laneId,
    workingOn: 'Bound work',
    repos: ['app'],
    branch,
    worktree: true,
  });
  const container = path.join(tempDir, 'worktrees', laneId);
  return {
    container,
    markerPath: path.join(container, '.vibecompass-lane.yaml'),
    worktreePath: path.join(container, 'app'),
  };
}

test('close-session removes recorded clean worktrees, the marker, and the empty container; branches survive (D-281 S3-3)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-close-clean-');

  try {
    const appDir = path.join(tempDir, 'app');
    await createGitRepoWithCommit(appDir);
    const { container, markerPath, worktreePath } = await startBoundLane(tempDir);

    const result = await closeProjectSession({ cwd: tempDir, sessionId: 'lane-a', ...CLOSE_DEFAULTS });
    assert.equal(result.sessionId, 'lane-a');
    assert.deepEqual(result.worktreeCleanup.removed, [{ repoId: 'app', worktreePath, sourceDir: appDir }]);
    assert.deepEqual(result.worktreeCleanup.surviving, []);
    assert.equal(result.worktreeCleanup.markerRemoved, true);
    assert.equal(result.worktreeCleanup.containerRemoved, true);
    assert.equal(result.worktreeCleanup.branch, 'feat');

    assert.equal(existsSync(worktreePath), false, 'worktree removed at close');
    assert.equal(existsSync(markerPath), false, 'marker removed token-matched at close');
    assert.equal(existsSync(container), false, 'empty container removed at close');
    assert.equal(git(appDir, ['rev-parse', '--verify', '--quiet', 'refs/heads/feat']).length > 0, true, 'branch is never deleted at close');
    assert.equal(git(appDir, ['worktree', 'list', '--porcelain']).split('worktree ').filter(Boolean).length, 1, 'no lingering worktree registration');
    assert.deepEqual((await listProjectSessions({ rootDir })).lanes, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('close-session CLI renders the worktree cleanup summary (D-281 S3-3)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-close-cli-');

  try {
    await createGitRepoWithCommit(path.join(tempDir, 'app'));
    const { worktreePath } = await startBoundLane(tempDir);

    const stdout = [];
    const io = { stdout: { write(chunk) { stdout.push(chunk); } }, stderr: { write() {} } };
    const exitCode = await runCli([
      'close-session', '--root', rootDir, '--session', 'lane-a',
      '--title', 'Lane Close', '--completed', 'Did the work', '--next-step', 'Continue',
      '--architecture-docs', 'updated', '--decision-log', 'updated', '--session-maintenance', 'updated',
    ], io, { cwd: tempDir });
    assert.equal(exitCode, 0);
    const output = stdout.join('');
    assert.match(output, /Worktree cleanup:/);
    assert.ok(output.includes(`- app: removed ${worktreePath}`));
    assert.match(output, /- lane marker removed \(token-matched\)/);
    assert.match(output, /- container removed \(empty\)/);
    assert.match(output, /- branch "feat" left in place \(close-session never deletes branches; D-281\)/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('close-session keeps dirty worktrees, the marker, and the container, with guidance (D-281 S3-3)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-close-dirty-');

  try {
    const appDir = path.join(tempDir, 'app');
    await createGitRepoWithCommit(appDir);
    const { container, markerPath, worktreePath } = await startBoundLane(tempDir);
    await writeFile(path.join(worktreePath, 'uncommitted.txt'), 'work in progress\n', 'utf8');

    const result = await closeProjectSession({ cwd: tempDir, sessionId: 'lane-a', ...CLOSE_DEFAULTS });
    assert.equal(result.sessionId, 'lane-a', 'close completes; removal is conservative, not blocking');
    assert.deepEqual(result.worktreeCleanup.removed, []);
    assert.equal(result.worktreeCleanup.surviving.length, 1);
    assert.equal(result.worktreeCleanup.surviving[0].reason, 'dirty');
    assert.equal(result.worktreeCleanup.markerRemoved, false);
    assert.equal(result.worktreeCleanup.containerRemoved, false);

    assert.equal(existsSync(worktreePath), true, 'dirty worktree survives — removal is never forced');
    assert.equal(existsSync(path.join(worktreePath, 'uncommitted.txt')), true, 'uncommitted work survives');
    assert.equal(existsSync(markerPath), true, 'marker kept while a recorded worktree survives');
    assert.equal(existsSync(container), true);
    assert.ok(result.warnings.some((warning) => /uncommitted changes/.test(warning) && warning.includes(`git -C ${appDir} worktree remove ${worktreePath}`)));
    assert.ok(result.warnings.some((warning) => /kept as a breadcrumb \(D-281\)/.test(warning)));
    assert.equal(existsSync(path.join(rootDir, 'sessions/active/lane-a')), false, 'lane scratch is still finalized');
    assert.deepEqual((await listProjectSessions({ rootDir })).lanes, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('close-session skips removal with guidance when the cwd sits inside the target worktree (D-281 S3-3)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir } = await createInitializedRoot('vibecompass-close-cwd-');

  try {
    await createGitRepoWithCommit(path.join(tempDir, 'app'));
    const { markerPath, worktreePath } = await startBoundLane(tempDir);

    const result = await closeProjectSession({ cwd: worktreePath, sessionId: 'lane-a', ...CLOSE_DEFAULTS });
    assert.equal(result.sessionId, 'lane-a');
    assert.equal(result.worktreeCleanup.surviving.length, 1);
    assert.equal(result.worktreeCleanup.surviving[0].reason, 'cwd-inside');
    assert.equal(existsSync(worktreePath), true, 'the worktree the cwd sits in survives');
    assert.equal(existsSync(markerPath), true, 'marker kept while a recorded worktree survives');
    assert.ok(result.warnings.some((warning) => /current working directory is inside it/.test(warning)));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('close-session treats recorded-but-missing worktrees as benign and still cleans marker + container (D-281 S3-3)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-close-missing-');

  try {
    const appDir = path.join(tempDir, 'app');
    await createGitRepoWithCommit(appDir);
    const { container, markerPath, worktreePath } = await startBoundLane(tempDir);
    git(appDir, ['worktree', 'remove', worktreePath]);

    const result = await closeProjectSession({ cwd: tempDir, sessionId: 'lane-a', ...CLOSE_DEFAULTS });
    assert.equal(result.sessionId, 'lane-a');
    assert.deepEqual(result.worktreeCleanup.removed, []);
    assert.deepEqual(result.worktreeCleanup.surviving, []);
    assert.equal(result.worktreeCleanup.markerRemoved, true);
    assert.equal(result.worktreeCleanup.containerRemoved, true);
    assert.equal(existsSync(markerPath), false);
    assert.equal(existsSync(container), false);
    assert.ok(!result.warnings.some((warning) => /worktree/i.test(warning)), 'recorded-but-missing produces no worktree warning');
    assert.deepEqual((await listProjectSessions({ rootDir })).lanes, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('close-session refuses removal when the container marker token does not match (D-280/D-281 S3-3)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-close-token-');

  try {
    await createGitRepoWithCommit(path.join(tempDir, 'app'));
    const { markerPath, worktreePath } = await startBoundLane(tempDir);
    const originalMarker = await readFile(markerPath, 'utf8');
    await writeFile(markerPath, originalMarker.replace(/^token: ".*"$/m, 'token: "00000000-0000-0000-0000-000000000000"'), 'utf8');

    const result = await closeProjectSession({ cwd: tempDir, sessionId: 'lane-a', ...CLOSE_DEFAULTS });
    assert.equal(result.worktreeCleanup.surviving.length, 1);
    assert.equal(result.worktreeCleanup.surviving[0].reason, 'container-unverified');
    assert.equal(existsSync(worktreePath), true, 'an unverified container is never touched');
    assert.equal(existsSync(markerPath), true);
    assert.ok(result.warnings.some((warning) => /does not match the lane's recorded token/.test(warning)));
    assert.equal(git(path.join(tempDir, 'app'), ['rev-parse', '--verify', '--quiet', 'refs/heads/feat']).length > 0, true);
    assert.deepEqual((await listProjectSessions({ rootDir })).lanes, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('close-session refuses removal of a recorded path outside the lane container (D-279 S3-3)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-close-outside-');

  try {
    await createGitRepoWithCommit(path.join(tempDir, 'app'));
    const externalDir = path.join(tempDir, 'external-target');
    await createGitRepoWithCommit(externalDir);
    const { worktreePath, markerPath } = await startBoundLane(tempDir);

    const sessionFilePath = path.join(rootDir, 'sessions/active/lane-a/session.yaml');
    const sessionYaml = await readFile(sessionFilePath, 'utf8');
    await writeFile(sessionFilePath, sessionYaml.replace(JSON.stringify(worktreePath), JSON.stringify(externalDir)), 'utf8');

    const result = await closeProjectSession({ cwd: tempDir, sessionId: 'lane-a', ...CLOSE_DEFAULTS });
    assert.equal(result.worktreeCleanup.surviving.length, 1);
    assert.equal(result.worktreeCleanup.surviving[0].reason, 'outside-container');
    assert.equal(existsSync(externalDir), true, 'arbitrary path removal is refused');
    assert.equal(existsSync(markerPath), true, 'marker kept while a recorded worktree survives');
    assert.ok(result.warnings.some((warning) => /arbitrary path removal is refused/.test(warning)));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('close-session leaves a non-empty container in place with a note (D-281 S3-3 rmdir-if-empty)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir } = await createInitializedRoot('vibecompass-close-stray-');

  try {
    await createGitRepoWithCommit(path.join(tempDir, 'app'));
    const { container, markerPath, worktreePath } = await startBoundLane(tempDir);
    await writeFile(path.join(container, 'stray-notes.txt'), 'user file\n', 'utf8');

    const result = await closeProjectSession({ cwd: tempDir, sessionId: 'lane-a', ...CLOSE_DEFAULTS });
    assert.deepEqual(result.worktreeCleanup.surviving, []);
    assert.equal(result.worktreeCleanup.markerRemoved, true);
    assert.equal(result.worktreeCleanup.containerRemoved, false);
    assert.equal(existsSync(worktreePath), false, 'clean worktree removed');
    assert.equal(existsSync(markerPath), false, 'marker removed');
    assert.equal(existsSync(container), true, 'non-empty container survives');
    assert.equal(existsSync(path.join(container, 'stray-notes.txt')), true, 'stray user file survives');
    assert.ok(result.warnings.some((warning) => /it is not empty/.test(warning)));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('close-session counts a failed cleanliness probe as unknown, not clean (D-281 S3-3)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir } = await createInitializedRoot('vibecompass-close-unknown-');

  try {
    await createGitRepoWithCommit(path.join(tempDir, 'app'));
    const { markerPath, worktreePath } = await startBoundLane(tempDir);
    // Breaking the worktree's gitdir link makes `git status` fail there.
    await rm(path.join(worktreePath, '.git'), { force: true });

    const result = await closeProjectSession({ cwd: tempDir, sessionId: 'lane-a', ...CLOSE_DEFAULTS });
    assert.equal(result.worktreeCleanup.surviving.length, 1);
    assert.equal(result.worktreeCleanup.surviving[0].reason, 'status-unknown');
    assert.equal(existsSync(worktreePath), true);
    assert.equal(existsSync(markerPath), true);
    assert.ok(result.warnings.some((warning) => /could not be determined/.test(warning)));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('close-session removes clean worktrees while keeping dirty ones in a multi-repo lane (D-281 S3-3)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-close-partial-', [
    { id: 'app', remote: 'https://github.com/example/app.git' },
    { id: 'lib', remote: 'https://github.com/example/lib.git' },
  ]);

  try {
    const appDir = path.join(tempDir, 'app');
    const libDir = path.join(tempDir, 'lib');
    await createGitRepoWithCommit(appDir);
    await createGitRepoWithCommit(libDir);
    await startProjectSession({
      cwd: tempDir,
      sessionId: 'lane-a',
      workingOn: 'Bound work',
      repos: ['app', 'lib'],
      branch: 'feat',
      worktree: true,
    });
    const container = path.join(tempDir, 'worktrees', 'lane-a');
    const markerPath = path.join(container, '.vibecompass-lane.yaml');
    await writeFile(path.join(container, 'lib', 'uncommitted.txt'), 'wip\n', 'utf8');

    const result = await closeProjectSession({ cwd: tempDir, sessionId: 'lane-a', ...CLOSE_DEFAULTS });
    assert.deepEqual(result.worktreeCleanup.removed.map((entry) => entry.repoId), ['app']);
    assert.deepEqual(result.worktreeCleanup.surviving.map((entry) => entry.repoId), ['lib']);
    assert.equal(existsSync(path.join(container, 'app')), false);
    assert.equal(existsSync(path.join(container, 'lib')), true);
    assert.equal(existsSync(markerPath), true, 'marker kept while any recorded worktree survives');
    assert.equal(git(appDir, ['rev-parse', '--verify', '--quiet', 'refs/heads/feat']).length > 0, true);
    assert.equal(git(libDir, ['rev-parse', '--verify', '--quiet', 'refs/heads/feat']).length > 0, true);
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

// ---------- S3-4: pre-close staleness set (A:192, D-281) ----------

test('docs-update surfaces the pre-close staleness set and close-session re-emits it (A:192 S3-4)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-staleness-', [
    { id: 'app', remote: 'https://github.com/example/app.git' },
    { id: 'lib', remote: 'https://github.com/example/lib.git' },
  ]);

  try {
    const appDir = path.join(tempDir, 'app');
    await createGitRepoWithCommit(appDir);
    await writeFile(
      path.join(rootDir, 'decisions', 'cross-cutting.md'),
      [
        '# Cross-cutting decisions',
        '',
        '### D-001 — Seed decision',
        '**Timestamp:** 2026-01-01 09:00 PST',
        '**Decision:** Seed.',
        '**Rationale:** Seed.',
        '',
      ].join('\n'),
      'utf8',
    );

    await startProjectSession({
      cwd: tempDir,
      sessionId: 'lane-a',
      workingOn: 'Staleness lane',
      repos: ['app'],
      claims: ['src/feature.js'],
    });
    await startProjectSession({
      cwd: tempDir,
      sessionId: 'lane-b',
      workingOn: 'Overlapping lane',
      repos: ['app'],
      claims: ['src/'],
    });
    // Shares repo `app` with lane-a, but its claim is explicitly scoped to
    // `lib` while lane-a's unprefixed claim scopes to lane-a's repos ({app})
    // — disjoint scopes must NOT cross-flag (fleet F8).
    await startProjectSession({
      cwd: tempDir,
      sessionId: 'lane-c',
      workingOn: 'Disjoint-scope lane',
      repos: ['app', 'lib'],
      claims: ['lib:src/feature.js'],
    });

    // 1. A canonical decision appended after lane-a's snapshot.
    await appendFile(
      path.join(rootDir, 'decisions', 'cross-cutting.md'),
      [
        '### D-002 — Later decision',
        '**Timestamp:** 2026-01-02 09:00 PST',
        '**Decision:** Later.',
        '**Rationale:** Later.',
        '',
      ].join('\n'),
      'utf8',
    );

    // 2. The source repo head moves past the lane's captured base revision.
    await writeFile(path.join(appDir, 'later.txt'), 'later\n', 'utf8');
    git(appDir, ['add', '.']);
    git(appDir, ['commit', '-m', 'later']);

    // 3. Finalized notes: one materialized after lane start that mentions the
    //    lane's claim, one backdated before lane start (must not flag).
    const now = Date.now();
    const newNotePath = path.join(rootDir, 'sessions', '2026-01-02-1-overlapping-work.md');
    await writeFile(newNotePath, '# Session — 2026-01-02-1 — Overlapping Work\n\nTouched `src/feature.js` heavily.\n', 'utf8');
    await utimes(newNotePath, new Date(now + 60_000), new Date(now + 60_000));
    const oldNotePath = path.join(rootDir, 'sessions', '2026-01-01-1-old-work.md');
    await writeFile(oldNotePath, '# Session — 2026-01-01-1 — Old Work\n\nAlso touched `src/feature.js` back then.\n', 'utf8');
    await utimes(oldNotePath, new Date(now - 3_600_000), new Date(now - 3_600_000));

    const plan = await planDocsUpdate({ cwd: tempDir, sessionId: 'lane-a' });
    assert.ok(plan.staleness, 'a selected lane gets a staleness set');
    assert.ok(plan.staleness.newDecisions.some((decision) => decision.id === 2 && decision.path === 'decisions/cross-cutting.md'));
    assert.equal(plan.staleness.staleBaseRevisions.length, 1);
    assert.equal(plan.staleness.staleBaseRevisions[0].repoId, 'app');
    assert.deepEqual(plan.staleness.newSessionNotes.map((note) => note.path), ['sessions/2026-01-02-1-overlapping-work.md']);
    assert.ok(plan.staleness.newSessionNotes[0].reasons.some((reason) => reason.includes('src/feature.js')));
    assert.deepEqual(plan.staleness.laneOverlaps.map((overlap) => overlap.laneId), ['lane-b']);
    assert.ok(plan.staleness.entries.length >= 4);

    // CLI docs-update renders the section.
    const stdout = [];
    const io = { stdout: { write(chunk) { stdout.push(chunk); } }, stderr: { write() {} } };
    assert.equal(await runCli(['docs-update', '--root', rootDir, '--session', 'lane-a'], io, { cwd: tempDir }), 0);
    assert.match(stdout.join(''), /Pre-close staleness set:\n- New decision D-2 since lane start/);

    // close-session re-emits every staleness entry as a warning (A:192).
    const result = await closeProjectSession({ cwd: tempDir, sessionId: 'lane-a', ...CLOSE_DEFAULTS });
    assert.ok(result.warnings.some((warning) => /^Pre-close staleness: New decision D-2 since lane start \(decisions\/cross-cutting\.md\)/.test(warning)));
    assert.ok(result.warnings.some((warning) => /^Pre-close staleness: Base revision for repo "app" is stale/.test(warning)));
    assert.ok(result.warnings.some((warning) => /^Pre-close staleness: Finalized session note sessions\/2026-01-02-1-overlapping-work\.md/.test(warning)));
    assert.ok(result.warnings.some((warning) => /^Pre-close staleness: Active lane "lane-b" overlaps/.test(warning)));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('a fresh lane reports an empty staleness set and close-session emits no staleness warnings (S3-4)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-staleness-none-');

  try {
    await createGitRepoWithCommit(path.join(tempDir, 'app'));
    await startProjectSession({
      cwd: tempDir,
      sessionId: 'lane-a',
      workingOn: 'Quiet lane',
      repos: ['app'],
      claims: ['src/feature.js'],
    });

    const plan = await planDocsUpdate({ cwd: tempDir, sessionId: 'lane-a' });
    assert.deepEqual(plan.staleness.entries, []);

    const stdout = [];
    const io = { stdout: { write(chunk) { stdout.push(chunk); } }, stderr: { write() {} } };
    assert.equal(await runCli(['docs-update', '--root', rootDir, '--session', 'lane-a'], io, { cwd: tempDir }), 0);
    assert.match(stdout.join(''), /Pre-close staleness set:\n- none detected/);

    const result = await closeProjectSession({ cwd: tempDir, sessionId: 'lane-a', ...CLOSE_DEFAULTS });
    assert.ok(!result.warnings.some((warning) => warning.startsWith('Pre-close staleness:')));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------- Deferred S3 start-side test follow-ups ----------

test('provisioned container markers are byte-identical to write-lane-marker output for the same fields (D-280/D-281)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-marker-parity-');

  try {
    await createGitRepoWithCommit(path.join(tempDir, 'app'));
    const { markerPath } = await startBoundLane(tempDir);

    // The provisioned container marker must be exactly renderLaneMarker
    // output for the recorded fields — the same renderer write-lane-marker
    // uses (D-280's two producers share one format).
    const laneYaml = parseSimpleYaml(
      await readFile(path.join(rootDir, 'sessions/active/lane-a/session.yaml'), 'utf8'),
      { sourceName: 'session.yaml' },
    );
    const provisionedMarker = await readFile(markerPath, 'utf8');
    assert.equal(provisionedMarker, renderLaneMarker({
      laneId: 'lane-a',
      memoryRoot: rootDir,
      token: laneYaml.lane_marker.token,
      createdAt: laneYaml.lane_marker.created_at,
      createdBy: PACKAGE_VERSION,
    }));

    // And the explicit write-lane-marker producer emits the identical shape.
    await startProjectSession({ cwd: tempDir, sessionId: 'lane-b', workingOn: 'Unbound lane' });
    const manualDir = path.join(tempDir, 'manual-marker-target');
    await mkdir(manualDir, { recursive: true });
    const manualResult = await writeLaneMarkerForSession({ cwd: tempDir, sessionId: 'lane-b', dir: manualDir });
    const manualYaml = parseSimpleYaml(
      await readFile(path.join(rootDir, 'sessions/active/lane-b/session.yaml'), 'utf8'),
      { sourceName: 'session.yaml' },
    );
    assert.equal(await readFile(manualResult.markerPath, 'utf8'), renderLaneMarker({
      laneId: 'lane-b',
      memoryRoot: rootDir,
      token: manualYaml.lane_marker.token,
      createdAt: manualYaml.lane_marker.created_at,
      createdBy: PACKAGE_VERSION,
    }));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('rollback falls back to rm when a worktree registration refuses removal (D-281 rm+prune fallback)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-rollback-fallback-', [
    { id: 'app', remote: 'https://github.com/example/app.git' },
    { id: 'lib', remote: 'https://github.com/example/lib.git' },
  ]);

  try {
    const appDir = path.join(tempDir, 'app');
    const libDir = path.join(tempDir, 'lib');
    await createGitRepoWithCommit(appDir);
    await createGitRepoWithCommit(libDir);

    // app's checkout succeeds but locks its own worktree, so the rollback's
    // `worktree remove --force` fails (a locked worktree needs -f -f) and the
    // rm fallback must delete the directory; lib's checkout fails to trigger
    // the rollback.
    const appHookPath = path.join(appDir, '.git', 'hooks', 'post-checkout');
    await writeFile(appHookPath, '#!/bin/sh\ngit worktree lock "$PWD"\nexit 0\n', 'utf8');
    await chmod(appHookPath, 0o755);
    const libHookPath = path.join(libDir, '.git', 'hooks', 'post-checkout');
    await writeFile(libHookPath, '#!/bin/sh\nexit 1\n', 'utf8');
    await chmod(libHookPath, 0o755);

    await assert.rejects(
      startProjectSession({
        cwd: tempDir,
        sessionId: 'lane-a',
        workingOn: 'Bound work',
        repos: ['app', 'lib'],
        branch: 'feat',
        worktree: true,
      }),
      /rolled back and lane "lane-a" was not created/,
    );

    const worktreePath = path.join(tempDir, 'worktrees', 'lane-a', 'app');
    assert.equal(existsSync(worktreePath), false, 'the rm fallback deleted the locked worktree directory');
    assert.equal(existsSync(path.join(tempDir, 'worktrees', 'lane-a')), false, 'the container rollback removed the container');
    assert.deepEqual((await listProjectSessions({ rootDir })).lanes, [], 'the lane was not created');
    // The locked registration survives the prune (locks exist to protect
    // registrations), which in turn protects the branch from deletion — the
    // conservative degradation D-281 accepts for a broken registration.
    const registrations = git(appDir, ['worktree', 'list', '--porcelain']).split('worktree ').filter(Boolean);
    assert.equal(registrations.length, 2, 'the locked registration survives — proof the git removal failed and rm ran');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('two bound lanes on one repo warn about divergence at start and close independently (D-281 cross-lane wiring)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-cross-lane-');

  try {
    const appDir = path.join(tempDir, 'app');
    await createGitRepoWithCommit(appDir);
    await startProjectSession({
      cwd: tempDir,
      sessionId: 'lane-a',
      workingOn: 'First bound lane',
      repos: ['app'],
      branch: 'feat-a',
      worktree: true,
    });
    const second = await startProjectSession({
      cwd: tempDir,
      sessionId: 'lane-b',
      workingOn: 'Second bound lane',
      repos: ['app'],
      branch: 'feat-b',
      worktree: true,
    });
    assert.ok(second.warnings.some((warning) => /binds branch "feat-a" in shared repo\(s\) app/.test(warning)));

    const laneAWorktree = path.join(tempDir, 'worktrees', 'lane-a', 'app');
    const laneBWorktree = path.join(tempDir, 'worktrees', 'lane-b', 'app');
    assert.equal(git(laneAWorktree, ['symbolic-ref', 'HEAD']), 'refs/heads/feat-a');
    assert.equal(git(laneBWorktree, ['symbolic-ref', 'HEAD']), 'refs/heads/feat-b');

    const firstClose = await closeProjectSession({ cwd: tempDir, sessionId: 'lane-a', ...CLOSE_DEFAULTS });
    assert.deepEqual(firstClose.worktreeCleanup.removed.map((entry) => entry.repoId), ['app']);
    assert.equal(existsSync(laneAWorktree), false, 'lane-a cleanup removed only its own worktree');
    assert.equal(existsSync(laneBWorktree), true, 'lane-b worktree is untouched by lane-a close');
    assert.equal(existsSync(path.join(tempDir, 'worktrees', 'lane-b', '.vibecompass-lane.yaml')), true);
    assert.deepEqual((await listProjectSessions({ rootDir })).lanes.map((lane) => lane.id), ['lane-b']);

    const secondClose = await closeProjectSession({ cwd: tempDir, sessionId: 'lane-b', ...CLOSE_DEFAULTS });
    assert.deepEqual(secondClose.worktreeCleanup.removed.map((entry) => entry.repoId), ['app']);
    assert.equal(existsSync(path.join(tempDir, 'worktrees', 'lane-b')), false);
    assert.equal(git(appDir, ['rev-parse', '--verify', '--quiet', 'refs/heads/feat-a']).length > 0, true, 'branches survive every close');
    assert.equal(git(appDir, ['rev-parse', '--verify', '--quiet', 'refs/heads/feat-b']).length > 0, true);
    assert.deepEqual((await listProjectSessions({ rootDir })).lanes, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------- Review-fleet regression tests (S3 close side) ----------

test('close-session fails closed when the lane session.yaml is unparseable (D-281 fleet F1)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-close-corrupt-');

  try {
    await createGitRepoWithCommit(path.join(tempDir, 'app'));
    const { markerPath, worktreePath } = await startBoundLane(tempDir);
    const sessionFilePath = path.join(rootDir, 'sessions/active/lane-a/session.yaml');
    await writeFile(sessionFilePath, '\tbroken: yaml\n', 'utf8');

    // A null-degraded parse reads as "no worktrees recorded"; closing would
    // destroy the removal-guard records while the worktrees survive.
    await assert.rejects(
      closeProjectSession({ cwd: tempDir, sessionId: 'lane-a', ...CLOSE_DEFAULTS }),
      /could not be parsed[\s\S]*refusing to close[\s\S]*removal-guard records/,
    );
    assert.equal(existsSync(worktreePath), true, 'worktree untouched by the refused close');
    assert.equal(existsSync(markerPath), true, 'marker untouched by the refused close');
    assert.equal(existsSync(sessionFilePath), true, 'lane records untouched by the refused close');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('close-session never rmdirs a container the cwd sits inside (D-281 fleet F2)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir } = await createInitializedRoot('vibecompass-close-cwd-container-');

  try {
    await createGitRepoWithCommit(path.join(tempDir, 'app'));
    const { container, markerPath, worktreePath } = await startBoundLane(tempDir);

    const result = await closeProjectSession({ cwd: container, sessionId: 'lane-a', ...CLOSE_DEFAULTS });
    assert.deepEqual(result.worktreeCleanup.surviving, []);
    assert.equal(result.worktreeCleanup.markerRemoved, true);
    assert.equal(result.worktreeCleanup.containerRemoved, false, 'the cwd container is never rmdirred');
    assert.equal(existsSync(worktreePath), false, 'clean worktree still removed');
    assert.equal(existsSync(markerPath), false, 'marker still removed token-matched');
    assert.equal(existsSync(container), true, 'container survives while it is the cwd');
    assert.ok(result.warnings.some((warning) => /container .* left in place: the current working directory is inside it/.test(warning)));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('close-session refuses removal when the container marker names a different lane (D-281 fleet F13)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir } = await createInitializedRoot('vibecompass-close-laneid-');

  try {
    await createGitRepoWithCommit(path.join(tempDir, 'app'));
    const { markerPath, worktreePath } = await startBoundLane(tempDir);
    const marker = await readFile(markerPath, 'utf8');
    await writeFile(markerPath, marker.replace(/^lane_id: .*$/m, 'lane_id: lane-zz'), 'utf8');

    const result = await closeProjectSession({ cwd: tempDir, sessionId: 'lane-a', ...CLOSE_DEFAULTS });
    assert.equal(result.worktreeCleanup.surviving[0].reason, 'container-unverified');
    assert.equal(existsSync(worktreePath), true);
    assert.ok(result.warnings.some((warning) => /belongs to lane "lane-zz", not "lane-a"/.test(warning)));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('close-session refuses removal when the container marker file is missing, without a phantom breadcrumb warning (D-281 fleet F13/F12)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir } = await createInitializedRoot('vibecompass-close-marker-gone-');

  try {
    await createGitRepoWithCommit(path.join(tempDir, 'app'));
    const { markerPath, worktreePath } = await startBoundLane(tempDir);
    await rm(markerPath, { force: true });

    const result = await closeProjectSession({ cwd: tempDir, sessionId: 'lane-a', ...CLOSE_DEFAULTS });
    assert.equal(result.worktreeCleanup.surviving[0].reason, 'container-unverified');
    assert.equal(existsSync(worktreePath), true, 'an unverifiable container is never touched');
    assert.ok(result.warnings.some((warning) => /could not be verified/.test(warning)));
    assert.ok(!result.warnings.some((warning) => /kept as a breadcrumb/.test(warning)), 'no breadcrumb claim for a marker that does not exist');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('close-session refuses removal when the recorded marker path sits outside the container (D-281 fleet F13)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-close-marker-outside-');

  try {
    await createGitRepoWithCommit(path.join(tempDir, 'app'));
    const { markerPath, worktreePath } = await startBoundLane(tempDir);
    const sessionFilePath = path.join(rootDir, 'sessions/active/lane-a/session.yaml');
    const sessionYaml = await readFile(sessionFilePath, 'utf8');
    const foreignMarkerPath = path.join(tempDir, 'elsewhere', '.vibecompass-lane.yaml');
    await writeFile(sessionFilePath, sessionYaml.replace(JSON.stringify(markerPath), JSON.stringify(foreignMarkerPath)), 'utf8');

    const result = await closeProjectSession({ cwd: tempDir, sessionId: 'lane-a', ...CLOSE_DEFAULTS });
    assert.equal(result.worktreeCleanup.surviving[0].reason, 'container-unverified');
    assert.equal(existsSync(worktreePath), true);
    assert.ok(result.warnings.some((warning) => /does not sit in the recorded container/.test(warning)));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('close-session keeps a worktree whose lane recorded no source repo (D-281 fleet F13)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-close-no-source-');

  try {
    await createGitRepoWithCommit(path.join(tempDir, 'app'));
    const { worktreePath, markerPath } = await startBoundLane(tempDir);
    const sessionFilePath = path.join(rootDir, 'sessions/active/lane-a/session.yaml');
    const sessionYaml = await readFile(sessionFilePath, 'utf8');
    await writeFile(sessionFilePath, sessionYaml.replace(/^worktree_sources:\r?\n(?: {2}.*\r?\n?)*/m, ''), 'utf8');

    const result = await closeProjectSession({ cwd: tempDir, sessionId: 'lane-a', ...CLOSE_DEFAULTS });
    assert.equal(result.worktreeCleanup.surviving[0].reason, 'no-source-recorded');
    assert.equal(existsSync(worktreePath), true);
    assert.equal(existsSync(markerPath), true, 'marker kept while the worktree survives');
    assert.ok(result.warnings.some((warning) => /recorded no source repository/.test(warning)));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('close-session refuses a relative recorded worktree path outright (D-279 fleet F6)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-close-relative-');

  try {
    await createGitRepoWithCommit(path.join(tempDir, 'app'));
    const { worktreePath, markerPath } = await startBoundLane(tempDir);
    const sessionFilePath = path.join(rootDir, 'sessions/active/lane-a/session.yaml');
    const sessionYaml = await readFile(sessionFilePath, 'utf8');
    await writeFile(sessionFilePath, sessionYaml.replace(JSON.stringify(worktreePath), '"relative-target"'), 'utf8');

    const result = await closeProjectSession({ cwd: tempDir, sessionId: 'lane-a', ...CLOSE_DEFAULTS });
    assert.equal(result.worktreeCleanup.surviving[0].reason, 'not-absolute');
    assert.equal(existsSync(markerPath), true, 'marker kept while a recorded entry survives');
    assert.ok(result.warnings.some((warning) => /is not absolute/.test(warning)));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('close-session CLI renders surviving worktree entries and the kept marker (D-281 fleet F14)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-close-cli-kept-');

  try {
    await createGitRepoWithCommit(path.join(tempDir, 'app'));
    const { worktreePath } = await startBoundLane(tempDir);
    await writeFile(path.join(worktreePath, 'uncommitted.txt'), 'wip\n', 'utf8');

    const stdout = [];
    const io = { stdout: { write(chunk) { stdout.push(chunk); } }, stderr: { write() {} } };
    const exitCode = await runCli([
      'close-session', '--root', rootDir, '--session', 'lane-a',
      '--title', 'Lane Close', '--completed', 'Did the work', '--next-step', 'Continue',
      '--architecture-docs', 'updated', '--decision-log', 'updated', '--session-maintenance', 'updated',
    ], io, { cwd: tempDir });
    assert.equal(exitCode, 0);
    const output = stdout.join('');
    assert.ok(output.includes(`- app: kept ${worktreePath} (uncommitted changes)`));
    assert.match(output, /- lane marker kept while worktrees survive \(D-281\)/);
    assert.match(output, /- branch "feat" left in place/);
    assert.doesNotMatch(output, /container removed/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------- Reviewer-pass regression tests (S3 close side) ----------

test('close-session CLI prints no marker line at all when the marker file is missing (reviewer pass)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-close-cli-no-marker-');

  try {
    await createGitRepoWithCommit(path.join(tempDir, 'app'));
    const { markerPath, worktreePath } = await startBoundLane(tempDir);
    await rm(markerPath, { force: true });

    const stdout = [];
    const io = { stdout: { write(chunk) { stdout.push(chunk); } }, stderr: { write() {} } };
    const exitCode = await runCli([
      'close-session', '--root', rootDir, '--session', 'lane-a',
      '--title', 'Lane Close', '--completed', 'Did the work', '--next-step', 'Continue',
      '--architecture-docs', 'updated', '--decision-log', 'updated', '--session-maintenance', 'updated',
    ], io, { cwd: tempDir });
    assert.equal(exitCode, 0);
    const output = stdout.join('');
    assert.ok(output.includes(`- app: kept ${worktreePath} (container marker unverified)`));
    assert.doesNotMatch(output, /lane marker kept/, 'no phantom kept-marker line for a missing marker');
    assert.doesNotMatch(output, /lane marker removed/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('pre-close staleness names a recorded base revision whose current head is unreadable (reviewer pass)', async (t) => {
  if (!hasGit()) {
    t.skip('git is required.');
    return;
  }

  const { tempDir } = await createInitializedRoot('vibecompass-staleness-unreadable-');

  try {
    const appDir = path.join(tempDir, 'app');
    await createGitRepoWithCommit(appDir);
    await startProjectSession({
      cwd: tempDir,
      sessionId: 'lane-a',
      workingOn: 'Unreadable head lane',
      repos: ['app'],
      claims: ['src/feature.js'],
    });
    // The lane recorded a base revision for app at start; the source
    // disappearing afterwards must be named, not silently skipped.
    await rm(appDir, { recursive: true, force: true });

    const plan = await planDocsUpdate({ cwd: tempDir, sessionId: 'lane-a' });
    assert.deepEqual(plan.staleness.staleBaseRevisions, []);
    assert.ok(plan.staleness.notEvaluated.some((entry) =>
      entry.includes('base-revision staleness for repo "app"') && entry.includes('could not be read')));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
