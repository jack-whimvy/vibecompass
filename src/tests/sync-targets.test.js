import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { runCli } from '../cli.js';
import { initializeProjectMemory } from '../init.js';
import { parseSimpleYaml } from '../simple-yaml.js';
import {
  buildSyncSectionWithTargets,
  resolveSyncBinding,
} from '../sync-binding.js';

function createIo(stdout, stderr) {
  return {
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
  };
}

async function createLocalPrimaryProject(tempDir) {
  await initializeProjectMemory({
    cwd: tempDir,
    rootDir: '.compass',
    name: 'Sync Targets Project',
    mode: 'local-primary',
    repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
  });
}

async function connectTarget(tempDir, target, apiUrl, projectId, envVar) {
  const stdout = [];
  const stderr = [];
  const exitCode = await runCli(
    [
      'connect-hosted',
      '--target',
      target,
      '--sync-api-url',
      apiUrl,
      '--sync-project-id',
      projectId,
      '--sync-credential-env-var',
      envVar,
    ],
    createIo(stdout, stderr),
    { cwd: tempDir },
  );
  return { exitCode, stdout: stdout.join(''), stderr: stderr.join('') };
}

test('resolveSyncBinding resolves named, default, and legacy flat bindings', () => {
  const flatOnly = {
    sync: {
      provider: 'vibecompass',
      api_url: 'https://vibecompass.dev',
      project_id: 'proj-flat',
      credential_source: 'env',
      credential_env_var: 'VIBECOMPASS_SYNC_TOKEN',
    },
  };
  assert.deepEqual(resolveSyncBinding(flatOnly, null), {
    target: null,
    isDefault: true,
    apiUrl: 'https://vibecompass.dev',
    projectId: 'proj-flat',
    credentialEnvVar: 'VIBECOMPASS_SYNC_TOKEN',
  });

  const targets = {
    dev: {
      api_url: 'http://localhost:3000',
      project_id: 'proj-dev',
      credential_env_var: 'VIBECOMPASS_SYNC_TOKEN_DEV',
    },
    prod: {
      api_url: 'https://vibecompass.dev',
      project_id: 'proj-prod',
      credential_env_var: 'VIBECOMPASS_SYNC_TOKEN_PROD',
    },
  };
  const named = { sync: buildSyncSectionWithTargets(targets, 'dev') };

  assert.equal(resolveSyncBinding(named, null).target, 'dev');
  assert.equal(resolveSyncBinding(named, null).apiUrl, 'http://localhost:3000');
  assert.equal(resolveSyncBinding(named, 'prod').projectId, 'proj-prod');
  assert.equal(resolveSyncBinding(named, 'prod').credentialEnvVar, 'VIBECOMPASS_SYNC_TOKEN_PROD');
  assert.throws(() => resolveSyncBinding(named, 'staging'), /Unknown sync target "staging".*Available targets: dev, prod/);
  assert.throws(() => resolveSyncBinding({}, 'dev'), /requires a sync section/);
});

test('connect-hosted --target accumulates named targets and mirrors the default into flat fields', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-sync-targets-'));

  try {
    await createLocalPrimaryProject(tempDir);

    const dev = await connectTarget(
      tempDir,
      'dev',
      'http://localhost:3000',
      'proj-dev',
      'VIBECOMPASS_SYNC_TOKEN_DEV',
    );
    assert.equal(dev.exitCode, 0, dev.stderr);
    assert.match(dev.stdout, /Sync target: dev \(default: dev\)/);

    const prod = await connectTarget(
      tempDir,
      'prod',
      'https://vibecompass.dev',
      'proj-prod',
      'VIBECOMPASS_SYNC_TOKEN_PROD',
    );
    assert.equal(prod.exitCode, 0, prod.stderr);
    assert.match(prod.stdout, /Sync target: prod \(default: dev\)/);

    const projectConfig = parseSimpleYaml(
      await readFile(path.join(tempDir, '.compass/project.yaml'), 'utf8'),
    );
    assert.equal(projectConfig.sync.default_target, 'dev');
    assert.equal(projectConfig.sync.targets.dev.project_id, 'proj-dev');
    assert.equal(projectConfig.sync.targets.prod.project_id, 'proj-prod');
    // Flat fields mirror the default target for older CLIs.
    assert.equal(projectConfig.sync.api_url, 'http://localhost:3000');
    assert.equal(projectConfig.sync.project_id, 'proj-dev');
    assert.equal(projectConfig.sync.credential_env_var, 'VIBECOMPASS_SYNC_TOKEN_DEV');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('connect-hosted without --target refuses to clobber existing named targets', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-sync-targets-clobber-'));
  const stdout = [];
  const stderr = [];

  try {
    await createLocalPrimaryProject(tempDir);
    await connectTarget(tempDir, 'dev', 'http://localhost:3000', 'proj-dev', 'VIBECOMPASS_SYNC_TOKEN_DEV');

    await assert.rejects(
      () =>
        runCli(
          [
            'connect-hosted',
            '--sync-api-url',
            'https://vibecompass.dev',
            '--sync-project-id',
            'proj-prod',
            '--sync-credential-env-var',
            'VIBECOMPASS_SYNC_TOKEN_PROD',
          ],
          createIo(stdout, stderr),
          { cwd: tempDir },
        ),
      /named sync targets \(dev\)\. Pass --target <name>/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('sync-target lists targets and switches the default with flat re-mirroring', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-sync-targets-switch-'));

  try {
    await createLocalPrimaryProject(tempDir);
    await connectTarget(tempDir, 'dev', 'http://localhost:3000', 'proj-dev', 'VIBECOMPASS_SYNC_TOKEN_DEV');
    await connectTarget(tempDir, 'prod', 'https://vibecompass.dev', 'proj-prod', 'VIBECOMPASS_SYNC_TOKEN_PROD');

    const listOut = [];
    const listErr = [];
    const listExit = await runCli(['sync-target'], createIo(listOut, listErr), { cwd: tempDir });
    assert.equal(listExit, 0, listErr.join(''));
    const listing = listOut.join('');
    assert.match(listing, /Default sync target: dev/);
    assert.match(listing, /\* dev: http:\/\/localhost:3000/);
    assert.match(listing, /  prod: https:\/\/vibecompass.dev/);

    const switchOut = [];
    const switchErr = [];
    const switchExit = await runCli(['sync-target', 'prod'], createIo(switchOut, switchErr), {
      cwd: tempDir,
    });
    assert.equal(switchExit, 0, switchErr.join(''));
    assert.match(switchOut.join(''), /Default sync target set to prod/);

    const projectConfig = parseSimpleYaml(
      await readFile(path.join(tempDir, '.compass/project.yaml'), 'utf8'),
    );
    assert.equal(projectConfig.sync.default_target, 'prod');
    assert.equal(projectConfig.sync.api_url, 'https://vibecompass.dev');
    assert.equal(projectConfig.sync.project_id, 'proj-prod');
    assert.equal(projectConfig.sync.credential_env_var, 'VIBECOMPASS_SYNC_TOKEN_PROD');

    await assert.rejects(
      () => runCli(['sync-target', 'staging'], createIo([], []), { cwd: tempDir }),
      /Unknown sync target "staging"/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('push resolves the default target and honors --sync-target per invocation', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-sync-targets-push-'));

  try {
    await createLocalPrimaryProject(tempDir);
    await connectTarget(tempDir, 'dev', 'http://localhost:3000', 'proj-dev', 'VIBECOMPASS_SYNC_TOKEN_DEV');
    await connectTarget(tempDir, 'prod', 'https://vibecompass.dev', 'proj-prod', 'VIBECOMPASS_SYNC_TOKEN_PROD');

    const requests = [];
    const fetchMock = async (url, request) => {
      requests.push({ url, authorization: request.headers.authorization });
      return {
        ok: true,
        async json() {
          return {
            status: 'completed',
            run_id: 'run-test',
            remote_revision_id: '6f9619ff-8b86-4d01-b42d-00cf4fc964ff',
            applied_proposal_ids: [],
            stale_proposal_ids: [],
          };
        },
      };
    };
    const env = {
      VIBECOMPASS_SYNC_TOKEN_DEV: 'vcsync_dev_token',
      VIBECOMPASS_SYNC_TOKEN_PROD: 'vcsync_prod_token',
    };

    const defaultExit = await runCli(['push'], createIo([], []), {
      cwd: tempDir,
      env,
      fetch: fetchMock,
    });
    assert.equal(defaultExit, 0);
    assert.match(requests[0].url, /^http:\/\/localhost:3000\/api\/sync\/projects\/proj-dev\/push$/);
    assert.equal(requests[0].authorization, 'Bearer vcsync_dev_token');

    const prodExit = await runCli(['push', '--sync-target', 'prod'], createIo([], []), {
      cwd: tempDir,
      env,
      fetch: fetchMock,
    });
    assert.equal(prodExit, 0);
    assert.match(requests[1].url, /^https:\/\/vibecompass.dev\/api\/sync\/projects\/proj-prod\/push$/);
    assert.equal(requests[1].authorization, 'Bearer vcsync_prod_token');

    await assert.rejects(
      () =>
        runCli(['push', '--sync-target', 'staging'], createIo([], []), {
          cwd: tempDir,
          env,
          fetch: fetchMock,
        }),
      /Unknown sync target "staging"/,
    );
    assert.equal(requests.length, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('legacy flat sync bindings keep working without named targets', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-sync-targets-legacy-'));

  try {
    await createLocalPrimaryProject(tempDir);
    const stdout = [];
    const stderr = [];
    const exitCode = await runCli(
      [
        'connect-hosted',
        '--sync-api-url',
        'https://vibecompass.dev',
        '--sync-project-id',
        'proj-legacy',
        '--sync-credential-env-var',
        'VIBECOMPASS_SYNC_TOKEN',
      ],
      createIo(stdout, stderr),
      { cwd: tempDir },
    );
    assert.equal(exitCode, 0, stderr.join(''));

    const projectConfig = parseSimpleYaml(
      await readFile(path.join(tempDir, '.compass/project.yaml'), 'utf8'),
    );
    assert.equal(projectConfig.sync.project_id, 'proj-legacy');
    assert.equal(projectConfig.sync.targets, undefined);
    assert.equal(projectConfig.sync.default_target, undefined);

    const requests = [];
    const pushExit = await runCli(['push'], createIo([], []), {
      cwd: tempDir,
      env: { VIBECOMPASS_SYNC_TOKEN: 'vcsync_legacy' },
      fetch: async (url, request) => {
        requests.push({ url, authorization: request.headers.authorization });
        return {
          ok: true,
          async json() {
            return {
              status: 'completed',
              run_id: 'run-legacy',
              remote_revision_id: '6f9619ff-8b86-4d01-b42d-00cf4fc964ff',
              applied_proposal_ids: [],
              stale_proposal_ids: [],
            };
          },
        };
      },
    });
    assert.equal(pushExit, 0);
    assert.match(requests[0].url, /proj-legacy\/push$/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('sync cursors are isolated per target (D-237): a dev push never becomes a prod baseline', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-sync-targets-cursor-'));

  try {
    await createLocalPrimaryProject(tempDir);
    await connectTarget(tempDir, 'dev', 'http://localhost:3000', 'proj-dev', 'VIBECOMPASS_SYNC_TOKEN_DEV');
    await connectTarget(tempDir, 'prod', 'https://vibecompass.dev', 'proj-prod', 'VIBECOMPASS_SYNC_TOKEN_PROD');

    const requests = [];
    const devRevision = '11111111-1111-4111-8111-111111111111';
    const prodRevision = '22222222-2222-4222-8222-222222222222';
    const fetchMock = async (url, request) => {
      requests.push({ url, body: JSON.parse(request.body) });
      return {
        ok: true,
        async json() {
          return {
            status: 'completed',
            run_id: 'run-cursor-test',
            remote_revision_id: url.includes('proj-dev') ? devRevision : prodRevision,
            applied_proposal_ids: [],
            stale_proposal_ids: [],
          };
        },
      };
    };
    const env = {
      VIBECOMPASS_SYNC_TOKEN_DEV: 'vcsync_dev',
      VIBECOMPASS_SYNC_TOKEN_PROD: 'vcsync_prod',
    };

    // First dev push establishes the dev cursor.
    assert.equal(await runCli(['push'], createIo([], []), { cwd: tempDir, env, fetch: fetchMock }), 0);
    assert.equal(requests[0].body.base_remote_revision_id, undefined);

    // Prod push must NOT reuse the dev cursor as its baseline.
    assert.equal(
      await runCli(['push', '--sync-target', 'prod'], createIo([], []), { cwd: tempDir, env, fetch: fetchMock }),
      0,
    );
    assert.equal(requests[1].body.base_remote_revision_id, undefined);

    // Second dev push resumes from the dev cursor.
    assert.equal(await runCli(['push'], createIo([], []), { cwd: tempDir, env, fetch: fetchMock }), 0);
    assert.equal(requests[2].body.base_remote_revision_id, devRevision);

    // Second prod push resumes from the prod cursor.
    assert.equal(
      await runCli(['push', '--sync-target', 'prod'], createIo([], []), { cwd: tempDir, env, fetch: fetchMock }),
      0,
    );
    assert.equal(requests[3].body.base_remote_revision_id, prodRevision);

    const manifest = JSON.parse(
      await readFile(path.join(tempDir, '.compass/state/manifest.json'), 'utf8'),
    );
    assert.equal(manifest.sync.targets.dev.last_successful_remote_revision, devRevision);
    assert.equal(manifest.sync.targets.dev.api_url, 'http://localhost:3000');
    assert.equal(manifest.sync.targets.prod.last_successful_remote_revision, prodRevision);
    // Flat cursor mirrors the default target (dev) for older CLIs.
    assert.equal(manifest.sync.last_successful_remote_revision, devRevision);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('switching the default target re-mirrors the flat cursor (D-237)', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-sync-targets-remirror-'));

  try {
    await createLocalPrimaryProject(tempDir);
    await connectTarget(tempDir, 'dev', 'http://localhost:3000', 'proj-dev', 'VIBECOMPASS_SYNC_TOKEN_DEV');
    await connectTarget(tempDir, 'prod', 'https://vibecompass.dev', 'proj-prod', 'VIBECOMPASS_SYNC_TOKEN_PROD');

    const devRevision = '33333333-3333-4333-8333-333333333333';
    const env = { VIBECOMPASS_SYNC_TOKEN_DEV: 'vcsync_dev' };
    const fetchMock = async () => ({
      ok: true,
      async json() {
        return {
          status: 'completed',
          run_id: 'run-remirror',
          remote_revision_id: devRevision,
          applied_proposal_ids: [],
          stale_proposal_ids: [],
        };
      },
    });
    assert.equal(await runCli(['push'], createIo([], []), { cwd: tempDir, env, fetch: fetchMock }), 0);

    // Switching default to prod (no prod cursor yet) must clear the flat cursor.
    assert.equal(await runCli(['sync-target', 'prod'], createIo([], []), { cwd: tempDir }), 0);
    let manifest = JSON.parse(
      await readFile(path.join(tempDir, '.compass/state/manifest.json'), 'utf8'),
    );
    assert.equal(manifest.sync.last_successful_remote_revision, undefined);
    assert.equal(manifest.sync.targets.dev.last_successful_remote_revision, devRevision);

    // Switching back to dev restores the flat mirror from dev's cursor.
    assert.equal(await runCli(['sync-target', 'dev'], createIo([], []), { cwd: tempDir }), 0);
    manifest = JSON.parse(
      await readFile(path.join(tempDir, '.compass/state/manifest.json'), 'utf8'),
    );
    assert.equal(manifest.sync.last_successful_remote_revision, devRevision);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('converting a flat binding to its first named target carries the cursor over (D-237)', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-sync-targets-migrate-'));

  try {
    await createLocalPrimaryProject(tempDir);
    const flatRevision = '44444444-4444-4444-8444-444444444444';
    const stdout = [];
    await runCli(
      [
        'connect-hosted',
        '--sync-api-url',
        'http://localhost:3000',
        '--sync-project-id',
        'proj-flat',
        '--sync-credential-env-var',
        'VIBECOMPASS_SYNC_TOKEN',
      ],
      createIo(stdout, []),
      { cwd: tempDir },
    );
    const env = { VIBECOMPASS_SYNC_TOKEN: 'vcsync_flat' };
    const fetchMock = async (url, request) => ({
      ok: true,
      async json() {
        return {
          status: 'completed',
          run_id: 'run-migrate',
          remote_revision_id: flatRevision,
          applied_proposal_ids: [],
          stale_proposal_ids: [],
        };
      },
    });
    assert.equal(await runCli(['push'], createIo([], []), { cwd: tempDir, env, fetch: fetchMock }), 0);

    // Convert the same binding into named target "dev" — cursor carries over.
    await connectTarget(tempDir, 'dev', 'http://localhost:3000', 'proj-flat', 'VIBECOMPASS_SYNC_TOKEN');
    const manifest = JSON.parse(
      await readFile(path.join(tempDir, '.compass/state/manifest.json'), 'utf8'),
    );
    assert.equal(manifest.sync.targets.dev.last_successful_remote_revision, flatRevision);
    assert.equal(manifest.sync.targets.dev.project_id, 'proj-flat');

    // Next dev push resumes from the migrated cursor.
    const requests = [];
    const fetchCapture = async (url, request) => {
      requests.push(JSON.parse(request.body));
      return fetchMock(url, request);
    };
    assert.equal(await runCli(['push'], createIo([], []), { cwd: tempDir, env, fetch: fetchCapture }), 0);
    assert.equal(requests[0].base_remote_revision_id, flatRevision);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('docs-review --sync-target submits and polls against the named target (D-236/D-237)', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-sync-targets-review-'));

  try {
    await createLocalPrimaryProject(tempDir);
    await connectTarget(tempDir, 'dev', 'http://localhost:3000', 'proj-dev', 'VIBECOMPASS_SYNC_TOKEN_DEV');
    await connectTarget(tempDir, 'prod', 'https://vibecompass.dev', 'proj-prod', 'VIBECOMPASS_SYNC_TOKEN_PROD');

    const env = {
      VIBECOMPASS_SYNC_TOKEN_DEV: 'vcsync_dev',
      VIBECOMPASS_SYNC_TOKEN_PROD: 'vcsync_prod',
    };
    const requests = [];
    const fetchMock = async (url, request) => {
      requests.push({ url, authorization: request.headers.authorization, method: request.method ?? 'POST' });
      if (url.endsWith('/docs-review')) {
        return {
          ok: true,
          async json() {
            return { run_id: 'run-review-prod', status: 'accepted' };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return { run_id: 'run-review-prod', status: 'running', phase: 'reviewing' };
        },
      };
    };

    const submitExit = await runCli(
      ['docs-review', '--submit-hosted', '--sync-target', 'prod'],
      createIo([], []),
      { cwd: tempDir, env, fetch: fetchMock },
    );
    assert.equal(submitExit, 0);
    assert.match(requests[0].url, /^https:\/\/vibecompass.dev\/api\/sync\/projects\/proj-prod\/docs-review$/);
    assert.equal(requests[0].authorization, 'Bearer vcsync_prod');

    const marker = JSON.parse(
      await readFile(path.join(tempDir, '.compass/state/docs-review.json'), 'utf8'),
    );
    assert.equal(marker.runtime.sync_target, 'prod');
    assert.equal(marker.runtime.api_url, 'https://vibecompass.dev');
    assert.equal(marker.runtime.credential_env_var, 'VIBECOMPASS_SYNC_TOKEN_PROD');

    // Poll pins to the submitted target's binding even though dev is default.
    const pollExit = await runCli(['docs-review', '--poll-hosted'], createIo([], []), {
      cwd: tempDir,
      env,
      fetch: fetchMock,
    });
    assert.equal(pollExit, 0);
    assert.match(requests[1].url, /^https:\/\/vibecompass.dev\/api\/sync\/projects\/proj-prod\/runs\/run-review-prod$/);
    assert.equal(requests[1].authorization, 'Bearer vcsync_prod');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('rebinding the default target to a new project clears stale cursors (D-237)', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-sync-targets-rebind-'));

  try {
    await createLocalPrimaryProject(tempDir);
    await connectTarget(tempDir, 'dev', 'http://localhost:3000', 'proj-dev', 'VIBECOMPASS_SYNC_TOKEN_DEV');

    const devRevision = '55555555-5555-4555-8555-555555555555';
    const env = { VIBECOMPASS_SYNC_TOKEN_DEV: 'vcsync_dev' };
    const fetchMock = async () => ({
      ok: true,
      async json() {
        return {
          status: 'completed',
          run_id: 'run-rebind',
          remote_revision_id: devRevision,
          applied_proposal_ids: [],
          stale_proposal_ids: [],
        };
      },
    });
    assert.equal(await runCli(['push'], createIo([], []), { cwd: tempDir, env, fetch: fetchMock }), 0);

    let manifest = JSON.parse(
      await readFile(path.join(tempDir, '.compass/state/manifest.json'), 'utf8'),
    );
    assert.equal(manifest.sync.last_successful_remote_revision, devRevision);
    assert.equal(manifest.sync.targets.dev.last_successful_remote_revision, devRevision);

    // Rebind the default target "dev" to a DIFFERENT hosted project: both the
    // per-target cursor and the flat mirror must clear, so neither a 0.8.0 nor
    // a <=0.7.0 CLI can send the old revision as the new project's baseline.
    await connectTarget(tempDir, 'dev', 'http://localhost:3000', 'proj-dev-2', 'VIBECOMPASS_SYNC_TOKEN_DEV');
    manifest = JSON.parse(
      await readFile(path.join(tempDir, '.compass/state/manifest.json'), 'utf8'),
    );
    assert.equal(manifest.sync.last_successful_remote_revision, undefined);
    assert.equal(manifest.sync.targets.dev, undefined);

    // Next push to the rebound target starts without a baseline.
    const requests = [];
    const fetchCapture = async (url, request) => {
      requests.push(JSON.parse(request.body));
      return fetchMock(url, request);
    };
    assert.equal(await runCli(['push'], createIo([], []), { cwd: tempDir, env, fetch: fetchCapture }), 0);
    assert.equal(requests[0].base_remote_revision_id, undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('rebinding a target with unchanged values keeps its cursor (D-237)', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-sync-targets-rebind-same-'));

  try {
    await createLocalPrimaryProject(tempDir);
    await connectTarget(tempDir, 'dev', 'http://localhost:3000', 'proj-dev', 'VIBECOMPASS_SYNC_TOKEN_DEV');

    const devRevision = '66666666-6666-4666-8666-666666666666';
    const env = { VIBECOMPASS_SYNC_TOKEN_DEV: 'vcsync_dev' };
    const fetchMock = async () => ({
      ok: true,
      async json() {
        return {
          status: 'completed',
          run_id: 'run-rebind-same',
          remote_revision_id: devRevision,
          applied_proposal_ids: [],
          stale_proposal_ids: [],
        };
      },
    });
    assert.equal(await runCli(['push'], createIo([], []), { cwd: tempDir, env, fetch: fetchMock }), 0);

    // Re-running connect-hosted with identical url/project values must keep
    // baseline continuity (rotating only the env var name is not identity).
    await connectTarget(tempDir, 'dev', 'http://localhost:3000', 'proj-dev', 'VIBECOMPASS_SYNC_TOKEN_DEV');
    const manifest = JSON.parse(
      await readFile(path.join(tempDir, '.compass/state/manifest.json'), 'utf8'),
    );
    assert.equal(manifest.sync.targets.dev.last_successful_remote_revision, devRevision);
    assert.equal(manifest.sync.last_successful_remote_revision, devRevision);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
