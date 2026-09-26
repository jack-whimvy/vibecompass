import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { chmod, mkdtemp, readFile, rm, stat, unlink, utimes } from 'node:fs/promises';
import { execFile, spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runCli } from '../cli.js';
import { initializeProjectMemory } from '../init.js';
import { getProjectStatus, renderStatusText } from '../status.js';
import { pushProjectMemory } from '../sync.js';
import { parseSimpleYaml } from '../simple-yaml.js';
import {
  credentialStoreKey,
  detectKeychainBackend,
  formatMissingCredentialError,
  keychainAccountFor,
  keychainLabelFor,
  normalizeApiUrl,
  listSyncCredentials,
  readCredentialIndex,
  removeSyncCredential,
  resolveCredentialStoreDir,
  resolveSyncCredential,
  storeSyncCredential,
  withCredentialStoreLock,
} from '../credential-store.js';

const API_URL = 'https://hosted.example';
const PROJECT_ID = 'proj-store';
const TOKEN = 'vcsync_0123456789abcdef0123456789abcdef';

function createIo(stdout = [], stderr = []) {
  return {
    stdout: { write: (chunk) => stdout.push(chunk) },
    stderr: { write: (chunk) => stderr.push(chunk) },
  };
}

function createFakeKeychain() {
  const items = new Map();
  return {
    name: 'keychain',
    description: 'fake keychain',
    items,
    async available() {
      return true;
    },
    async get(account) {
      return items.get(account) ?? null;
    },
    async set(account, secret) {
      items.set(account, secret);
    },
    async remove(account) {
      return items.delete(account);
    },
  };
}

async function createTempWorkspace() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-credential-store-'));
  const storeDir = path.join(tempDir, 'config');
  const env = { VIBECOMPASS_CONFIG_DIR: storeDir, VIBECOMPASS_CREDENTIAL_STORE: 'file' };
  return { tempDir, storeDir, env };
}

async function createBoundRoot(tempDir, env, options = {}) {
  await initializeProjectMemory({
    cwd: tempDir,
    rootDir: '.compass',
    name: 'Credential Store Project',
    mode: 'local-primary',
    repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
  });
  const stdout = [];
  const exitCode = await runCli(
    [
      'connect-hosted',
      '--root', '.compass',
      ...(options.target ? ['--target', options.target] : []),
      '--sync-api-url', options.apiUrl ?? API_URL,
      '--sync-project-id', options.projectId ?? PROJECT_ID,
      '--sync-credential-env-var', options.envVar ?? 'VIBECOMPASS_SYNC_TOKEN',
      ...(options.extraArgs ?? []),
    ],
    createIo(stdout),
    { cwd: tempDir, env, ...(options.runtime ?? {}) },
  );
  return { exitCode, stdout: stdout.join('') };
}

test('resolveCredentialStoreDir honours the explicit dir, XDG, and platform defaults', () => {
  assert.equal(
    resolveCredentialStoreDir({ env: { VIBECOMPASS_CONFIG_DIR: '/tmp/explicit' }, platform: 'darwin', homeDir: '/home/u' }),
    path.resolve('/tmp/explicit'),
  );
  assert.equal(
    resolveCredentialStoreDir({ env: { XDG_CONFIG_HOME: '/xdg' }, platform: 'linux', homeDir: '/home/u' }),
    path.join(path.resolve('/xdg'), 'vibecompass'),
  );
  assert.equal(
    resolveCredentialStoreDir({ env: {}, platform: 'darwin', homeDir: '/home/u' }),
    path.join('/home/u', '.config', 'vibecompass'),
  );
  assert.equal(
    resolveCredentialStoreDir({ env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, platform: 'win32', homeDir: 'C:\\Users\\u' }),
    path.join(path.resolve('C:\\Users\\u\\AppData\\Roaming'), 'vibecompass'),
  );
  assert.equal(credentialStoreKey('HTTPS://Hosted.Example/', 'p1'), 'https://hosted.example|p1');
  assert.equal(credentialStoreKey('http://localhost:3000', 'p1'), 'http://localhost:3000|p1');
});

test('file backend stores a private index and the resolver prefers the env override (D-355)', async () => {
  const { tempDir, storeDir, env } = await createTempWorkspace();
  try {
    const binding = { apiUrl: API_URL, projectId: PROJECT_ID, credentialEnvVar: 'VIBECOMPASS_SYNC_TOKEN', target: null };

    const missing = await resolveSyncCredential(binding, { env });
    assert.equal(missing.credential, null);
    assert.equal(missing.source, 'missing');
    assert.match(formatMissingCredentialError(binding, { detail: missing.detail }), /vibecompass login/);
    assert.match(formatMissingCredentialError(binding), /sync-credential set --token-stdin/);
    assert.match(formatMissingCredentialError(binding), /export VIBECOMPASS_SYNC_TOKEN/);

    const stored = await storeSyncCredential(
      { apiUrl: API_URL, projectId: PROJECT_ID, token: TOKEN, source: 'connect-hosted' },
      { env },
    );
    assert.equal(stored.backend, 'file');
    assert.equal(stored.tokenPrefix, TOKEN.slice(0, 14));
    assert.equal(stored.replaced, false);

    const indexInfo = await stat(stored.storePath);
    assert.equal(indexInfo.mode & 0o777, 0o600);
    assert.equal((await stat(storeDir)).mode & 0o777, 0o700);
    const raw = JSON.parse(await readFile(stored.storePath, 'utf8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.entries[credentialStoreKey(API_URL, PROJECT_ID)].token, TOKEN);
    assert.equal(raw.entries[credentialStoreKey(API_URL, PROJECT_ID)].source, 'connect-hosted');

    const fromFile = await resolveSyncCredential(binding, { env });
    assert.equal(fromFile.credential, TOKEN);
    assert.equal(fromFile.source, 'file');

    const fromEnv = await resolveSyncCredential(binding, { env: { ...env, VIBECOMPASS_SYNC_TOKEN: 'shell-override' } });
    assert.equal(fromEnv.credential, 'shell-override');
    assert.equal(fromEnv.source, 'env');

    const listing = await listSyncCredentials({ env });
    assert.equal(listing.entries.length, 1);
    assert.equal(listing.entries[0].backend, 'file');
    assert.equal(Object.hasOwn(listing.entries[0], 'token'), false);

    const replaced = await storeSyncCredential({ apiUrl: API_URL, projectId: PROJECT_ID, token: `${TOKEN}2` }, { env });
    assert.equal(replaced.replaced, true);

    const removed = await removeSyncCredential({ apiUrl: API_URL, projectId: PROJECT_ID }, { env });
    assert.equal(removed.removed, true);
    assert.equal((await resolveSyncCredential(binding, { env })).source, 'missing');
    assert.equal((await removeSyncCredential({ apiUrl: API_URL, projectId: PROJECT_ID }, { env })).removed, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('store rejects whitespace tokens and refuses a world-readable index file', async () => {
  const { tempDir, env } = await createTempWorkspace();
  try {
    await assert.rejects(
      storeSyncCredential({ apiUrl: API_URL, projectId: PROJECT_ID, token: 'bad token' }, { env }),
      /cannot contain whitespace/,
    );
    const stored = await storeSyncCredential({ apiUrl: API_URL, projectId: PROJECT_ID, token: TOKEN }, { env });
    await chmod(stored.storePath, 0o644);
    await assert.rejects(readCredentialIndex({ env }), /chmod 600/);
    await assert.rejects(
      resolveSyncCredential({ apiUrl: API_URL, projectId: PROJECT_ID, credentialEnvVar: 'X' }, { env }),
      /readable by other users/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('keychain backend keeps the secret out of the index and is the auto default when available', async () => {
  const { tempDir, env } = await createTempWorkspace();
  const keychain = createFakeKeychain();
  const options = { env: { VIBECOMPASS_CONFIG_DIR: env.VIBECOMPASS_CONFIG_DIR }, keychainBackend: keychain };
  try {
    const stored = await storeSyncCredential({ apiUrl: API_URL, projectId: PROJECT_ID, token: TOKEN, source: 'login' }, options);
    assert.equal(stored.backend, 'keychain');
    assert.equal(stored.backendDescription, 'fake keychain');
    const key = credentialStoreKey(API_URL, PROJECT_ID);
    assert.equal(keychain.items.get(key), TOKEN);
    const raw = JSON.parse(await readFile(stored.storePath, 'utf8'));
    assert.equal(raw.entries[key].backend, 'keychain');
    assert.equal(Object.hasOwn(raw.entries[key], 'token'), false);
    assert.equal(raw.entries[key].token_prefix, TOKEN.slice(0, 14));

    const binding = { apiUrl: API_URL, projectId: PROJECT_ID, credentialEnvVar: 'VIBECOMPASS_SYNC_TOKEN' };
    const resolved = await resolveSyncCredential(binding, options);
    assert.equal(resolved.credential, TOKEN);
    assert.equal(resolved.source, 'keychain');

    // Index says keychain but the item vanished: report missing with a detail.
    keychain.items.delete(key);
    const gone = await resolveSyncCredential(binding, options);
    assert.equal(gone.source, 'missing');
    assert.match(gone.detail, /keychain item that no longer exists/);

    // Explicit file backend retires the keychain entry.
    keychain.items.set(key, TOKEN);
    const moved = await storeSyncCredential({ apiUrl: API_URL, projectId: PROJECT_ID, token: TOKEN, backend: 'file' }, options);
    assert.equal(moved.backend, 'file');
    assert.equal(keychain.items.has(key), false);

    // keychain requested but unavailable fails closed.
    await assert.rejects(
      storeSyncCredential({ apiUrl: API_URL, projectId: PROJECT_ID, token: TOKEN, backend: 'keychain' }, { ...options, keychainBackend: false }),
      /No OS keychain backend is available/,
    );
    await assert.rejects(
      storeSyncCredential({ apiUrl: API_URL, projectId: PROJECT_ID, token: TOKEN, backend: 'vault' }, options),
      /Unknown credential store backend/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('connect-hosted without a token or TTY points at login and stores nothing', async () => {
  const { tempDir, storeDir, env } = await createTempWorkspace();
  try {
    const result = await createBoundRoot(tempDir, env);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Next step: sign in with "vibecompass login"/);
    assert.match(result.stdout, /Then run: vibecompass push/);
    await assert.rejects(stat(path.join(storeDir, 'credentials.json')));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('connect-hosted --token-stdin stores the token and push sends it as the bearer credential', async () => {
  const { tempDir, env } = await createTempWorkspace();
  try {
    const result = await createBoundRoot(tempDir, env, {
      extraArgs: ['--token-stdin'],
      runtime: { stdin: Readable.from([`${TOKEN}\n`]) },
    });
    assert.equal(result.exitCode, 0, result.stdout);
    assert.match(result.stdout, /Stored the sync token for https:\/\/hosted\.example \(project proj-store\) in .*credentials\.json/);
    assert.match(result.stdout, /VIBECOMPASS_SYNC_TOKEN still overrides it per shell/);

    const seen = [];
    const fetch = async (url, init) => {
      seen.push({ url, authorization: init?.headers?.authorization });
      return { ok: false, status: 401, async json() { return { error: 'nope' }; }, async text() { return 'nope'; } };
    };
    await assert.rejects(
      pushProjectMemory({ rootDir: '.compass' }, { cwd: tempDir, env, runtime: { fetch } }),
    );
    assert.equal(seen.length > 0, true);
    assert.equal(seen[0].authorization, `Bearer ${TOKEN}`);

    // A shell override still wins over the stored value.
    seen.length = 0;
    await assert.rejects(
      pushProjectMemory({ rootDir: '.compass' }, { cwd: tempDir, env: { ...env, VIBECOMPASS_SYNC_TOKEN: 'override' }, runtime: { fetch } }),
    );
    assert.equal(seen[0].authorization, 'Bearer override');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('connect-hosted uses the hidden prompt adapter and --no-store keeps the env-only path', async () => {
  const { tempDir, env } = await createTempWorkspace();
  try {
    const prompts = [];
    const prompted = await createBoundRoot(tempDir, env, {
      runtime: {
        prompt(spec) {
          prompts.push(spec);
          return spec.type === 'password' ? TOKEN : '';
        },
      },
    });
    assert.equal(prompted.exitCode, 0, prompted.stdout);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].type, 'password');
    assert.match(prompted.stdout, /Stored the sync token/);
    assert.doesNotMatch(prompted.stdout, new RegExp(TOKEN));

    const listing = await listSyncCredentials({ env });
    assert.equal(listing.entries[0].source, 'connect-hosted');

    const skipped = await runCli(
      ['connect-hosted', '--root', '.compass', '--sync-api-url', API_URL, '--sync-project-id', PROJECT_ID, '--sync-credential-env-var', 'VIBECOMPASS_SYNC_TOKEN', '--no-store'],
      createIo([]),
      { cwd: tempDir, env, prompt: () => { throw new Error('must not prompt'); } },
    );
    assert.equal(skipped, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('connect-hosted on a terminal starts the browser sign-in when Enter is pressed at the token prompt (D-356)', async () => {
  const { tempDir, env } = await createTempWorkspace();
  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir: '.compass',
      name: 'Enter To Login Project',
      mode: 'local-primary',
      repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
    });
    const mock = createDeviceAuthMock();
    const opened = [];
    const stdout = [];
    const exitCode = await runCli(
      ['connect-hosted', '--root', '.compass', '--sync-api-url', API_URL, '--sync-project-id', PROJECT_ID, '--sync-credential-env-var', 'VIBECOMPASS_SYNC_TOKEN'],
      createIo(stdout),
      {
        cwd: tempDir,
        env,
        fetch: mock.fetch,
        sleep: async () => {},
        execFile: (file, args, _options, callback) => { opened.push(file); callback(null); },
        platform: 'darwin',
        prompt(spec) {
          return spec.type === 'password' ? '' : '';
        },
      },
    );
    const output = stdout.join('');
    assert.equal(exitCode, 0, output);
    assert.match(output, /Connected hosted VibeCompass for local-primary/);
    assert.match(output, /Code: BCDF-2345/);
    assert.match(output, /Signed in to https:\/\/hosted\.example for project Hosted Project \(proj-store\)/);
    assert.match(output, /Then run: vibecompass push/);
    assert.doesNotMatch(output, /No token stored/);
    assert.deepEqual(opened, ['open']);
    // The already-written binding is sent as the approval hint and kept as is.
    assert.equal(mock.calls[0].body.project_id, PROJECT_ID);
    const project = parseSimpleYaml(await readFile(path.join(tempDir, '.compass', 'project.yaml'), 'utf8'));
    assert.equal(project.sync.project_id, PROJECT_ID);
    assert.equal((await listSyncCredentials({ env })).entries[0].source, 'login');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('push fails closed with login-first guidance when nothing holds a token', async () => {
  const { tempDir, env } = await createTempWorkspace();
  try {
    await createBoundRoot(tempDir, env);
    await assert.rejects(
      pushProjectMemory({ rootDir: '.compass' }, { cwd: tempDir, env, runtime: { fetch: async () => { throw new Error('unreachable'); } } }),
      (error) => {
        assert.match(error.message, /This hosted sync command needs a hosted sync token for https:\/\/hosted\.example \(project proj-store\)/);
        assert.match(error.message, /"vibecompass login"/);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('sync-credential set/list/remove manage the bound target, including --from-env and named targets', async () => {
  const { tempDir, env } = await createTempWorkspace();
  try {
    await createBoundRoot(tempDir, env, { target: 'dev', apiUrl: 'http://localhost:3000', projectId: 'proj-dev' });
    await runCli(
      ['connect-hosted', '--root', '.compass', '--target', 'prod', '--sync-api-url', API_URL, '--sync-project-id', PROJECT_ID, '--sync-credential-env-var', 'VIBECOMPASS_SYNC_TOKEN_PROD'],
      createIo([]),
      { cwd: tempDir, env },
    );

    const setStdout = [];
    const setExit = await runCli(
      ['sync-credential', 'set', '--root', '.compass', '--sync-target', 'prod', '--from-env'],
      createIo(setStdout),
      { cwd: tempDir, env: { ...env, VIBECOMPASS_SYNC_TOKEN_PROD: TOKEN } },
    );
    assert.equal(setExit, 0, setStdout.join(''));
    assert.match(setStdout.join(''), /Stored the sync token for https:\/\/hosted\.example \(project proj-store\)/);

    const stdinStdout = [];
    const stdinExit = await runCli(
      ['sync-credential', 'set', '--root', '.compass', '--sync-target', 'dev', '--token-stdin', '--label', 'laptop'],
      createIo(stdinStdout),
      { cwd: tempDir, env, stdin: Readable.from(['\n', `${TOKEN}dev\n`]) },
    );
    assert.equal(stdinExit, 0, stdinStdout.join(''));

    const listStdout = [];
    assert.equal(await runCli(['sync-credential', 'list', '--root', '.compass'], createIo(listStdout), { cwd: tempDir, env }), 0);
    const listing = listStdout.join('');
    assert.match(listing, /Credential store: .*credentials\.json \(2 entries\)/);
    assert.match(listing, /http:\/\/localhost:3000 project proj-dev: file, prefix vcsync_0123456, .* via sync-credential — bound here as target dev/);
    assert.match(listing, /https:\/\/hosted\.example project proj-store: file, .* — bound here as target prod/);
    assert.doesNotMatch(listing, new RegExp(TOKEN));

    const jsonStdout = [];
    await runCli(['sync-credential', 'list', '--root', '.compass', '--json'], createIo(jsonStdout), { cwd: tempDir, env });
    const parsed = JSON.parse(jsonStdout.join(''));
    assert.equal(parsed.entries.length, 2);
    assert.equal(parsed.entries.some((entry) => 'token' in entry), false);

    // Non-interactive set without a source fails with guidance.
    await assert.rejects(
      runCli(['sync-credential', 'set', '--root', '.compass', '--sync-target', 'dev'], createIo([]), { cwd: tempDir, env }),
      /needs a token/,
    );
    await assert.rejects(
      runCli(['sync-credential', 'set', '--root', '.compass', '--sync-target', 'dev', '--from-env'], createIo([]), { cwd: tempDir, env }),
      /--from-env requires VIBECOMPASS_SYNC_TOKEN to be set/,
    );
    await assert.rejects(
      runCli(['sync-credential', 'set', '--root', '.compass', '--sync-target', 'nope', '--from-env'], createIo([]), { cwd: tempDir, env }),
      /Unknown sync target "nope"/,
    );

    const removeStdout = [];
    assert.equal(
      await runCli(['sync-credential', 'remove', '--root', '.compass', '--sync-target', 'prod'], createIo(removeStdout), { cwd: tempDir, env }),
      0,
    );
    assert.match(removeStdout.join(''), /Removed the stored sync token for https:\/\/hosted\.example/);
    assert.equal((await listSyncCredentials({ env })).entries.length, 1);

    // Addressing a hosted project without a bound root.
    const direct = await runCli(
      ['sync-credential', 'set', '--api-url', 'https://other.example', '--project-id', 'p9', '--token-stdin'],
      createIo([]),
      { cwd: tempDir, env, stdin: Readable.from([`${TOKEN}\n`]) },
    );
    assert.equal(direct, 0);
    assert.equal((await listSyncCredentials({ env })).entries.length, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('sync-credential argument validation', async () => {
  await assert.rejects(runCli(['sync-credential'], createIo([]), {}), /requires an action/);
  await assert.rejects(runCli(['sync-credential', 'rotate'], createIo([]), {}), /Unknown sync-credential action/);
  await assert.rejects(runCli(['sync-credential', 'set', '--api-url', 'x'], createIo([]), {}), /must be given together/);
  await assert.rejects(runCli(['login', '--poll-timeout', '-1'], createIo([]), {}), /positive number of seconds/);
  await assert.rejects(runCli(['login', 'extra'], createIo([]), {}), /Unexpected argument/);
});

test('status reports the credential source without the value and recommends login when missing', async () => {
  const { tempDir, env } = await createTempWorkspace();
  try {
    await createBoundRoot(tempDir, env);
    const fetch = async () => ({ ok: true, status: 200, async json() { return { mode: 'local-primary' }; } });

    const missing = await getProjectStatus({ cwd: tempDir, rootDir: '.compass', env, fetch });
    assert.equal(missing.hostedSync.status, 'no-credential');
    assert.equal(missing.hostedSync.credentialSource, 'missing');
    assert.deepEqual(missing.hostedSync.binding, { apiUrl: API_URL, projectId: PROJECT_ID, target: null, credentialEnvVar: 'VIBECOMPASS_SYNC_TOKEN' });
    assert.equal(missing.recommendations.includes('vibecompass login'), true);
    const missingText = renderStatusText(missing);
    assert.match(missingText, /Hosted sync: https:\/\/hosted\.example \(project proj-store\)/);
    assert.match(missingText, /Sync credential: missing — run `vibecompass login`/);

    await storeSyncCredential({ apiUrl: API_URL, projectId: PROJECT_ID, token: TOKEN }, { env });
    const stored = await getProjectStatus({ cwd: tempDir, rootDir: '.compass', env, fetch });
    assert.equal(stored.hostedSync.status, 'ok');
    assert.equal(stored.hostedSync.credentialSource, 'file');
    assert.doesNotMatch(JSON.stringify(stored), new RegExp(TOKEN));
    assert.match(renderStatusText(stored), /Sync credential: credential store file/);

    const viaEnv = await getProjectStatus({ cwd: tempDir, rootDir: '.compass', env: { ...env, VIBECOMPASS_SYNC_TOKEN: 'x' }, fetch });
    assert.equal(viaEnv.hostedSync.credentialSource, 'env');
    assert.match(renderStatusText(viaEnv), /Sync credential: environment variable VIBECOMPASS_SYNC_TOKEN/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function createDeviceAuthMock(options = {}) {
  const calls = [];
  let polls = 0;
  const pendingPolls = options.pendingPolls ?? 1;
  const fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ url, body });
    if (url.endsWith('/api/cli/device-auth')) {
      return {
        ok: true,
        status: 201,
        async json() {
          return {
            device_code: 'device-secret',
            user_code: 'BCDF-2345',
            verification_uri: 'https://hosted.example/device',
            verification_uri_complete: 'https://hosted.example/device?code=BCDF-2345',
            expires_in: 600,
            interval: 1,
          };
        },
      };
    }
    if (url.endsWith('/api/cli/device-auth/token')) {
      polls += 1;
      if (options.outcome === 'expired') {
        return { ok: false, status: 400, async json() { return { error: 'expired_token' }; } };
      }
      if (polls === 1 && options.slowDown) {
        return { ok: false, status: 400, async json() { return { error: 'slow_down' }; } };
      }
      if (polls <= pendingPolls) {
        return { ok: false, status: 400, async json() { return { error: 'authorization_pending' }; } };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            status: 'approved',
            token: TOKEN,
            api_url: API_URL,
            project: { id: options.projectId ?? PROJECT_ID, name: 'Hosted Project' },
            credential: { id: 'cred-1', label: 'my-laptop', token_prefix: TOKEN.slice(0, 14) },
          };
        },
      };
    }
    throw new Error(`unexpected url ${url}`);
  };
  return { fetch, calls, sleeps: [] };
}

test('login binds an unbound root, stores the token, and opens the browser (D-355)', async () => {
  const { tempDir, env } = await createTempWorkspace();
  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir: '.compass',
      name: 'Login Project',
      mode: 'local-only',
      repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
    });
    const mock = createDeviceAuthMock({ pendingPolls: 2, slowDown: true });
    const opened = [];
    const sleeps = [];
    const stdout = [];
    const exitCode = await runCli(
      ['login', '--root', '.compass', '--api-url', API_URL, '--label', 'my-laptop'],
      createIo(stdout),
      {
        cwd: tempDir,
        env,
        fetch: mock.fetch,
        sleep: async (ms) => { sleeps.push(ms); },
        execFile: (file, args, _options, callback) => { opened.push([file, ...args]); callback(null); },
        platform: 'darwin',
      },
    );
    const output = stdout.join('');
    assert.equal(exitCode, 0, output);
    assert.match(output, /Open: https:\/\/hosted\.example\/device\?code=BCDF-2345/);
    assert.match(output, /Code: BCDF-2345/);
    assert.match(output, /Opening your browser/);
    assert.match(output, /Signed in to https:\/\/hosted\.example for project Hosted Project \(proj-store\)/);
    assert.match(output, /Stored the sync token .* in .*credentials\.json/);
    assert.match(output, /Connected hosted VibeCompass for local-primary/);
    assert.match(output, /Project mode: local-only -> local-primary/);
    assert.match(output, /Then run: vibecompass push/);
    assert.doesNotMatch(output, new RegExp(TOKEN));
    assert.doesNotMatch(output, /device-secret/);
    assert.deepEqual(opened, [['open', 'https://hosted.example/device?code=BCDF-2345']]);
    // slow_down adds five seconds to the interval.
    assert.deepEqual(sleeps, [1000, 6000, 6000]);
    assert.deepEqual(mock.calls[0].body, { label: 'my-laptop', package_version: mock.calls[0].body.package_version });
    assert.equal(mock.calls.at(-1).body.device_code, 'device-secret');

    const project = parseSimpleYaml(await readFile(path.join(tempDir, '.compass', 'project.yaml'), 'utf8'));
    assert.equal(project.mode, 'local-primary');
    assert.equal(project.sync.api_url, API_URL);
    assert.equal(project.sync.project_id, PROJECT_ID);
    assert.equal(project.sync.credential_env_var, 'VIBECOMPASS_SYNC_TOKEN');

    const resolved = await resolveSyncCredential(
      { apiUrl: API_URL, projectId: PROJECT_ID, credentialEnvVar: 'VIBECOMPASS_SYNC_TOKEN' },
      { env },
    );
    assert.equal(resolved.credential, TOKEN);
    assert.equal((await listSyncCredentials({ env })).entries[0].source, 'login');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('login on a bound root sends the project hint, keeps the binding, and warns on a different approval', async () => {
  const { tempDir, env } = await createTempWorkspace();
  try {
    await createBoundRoot(tempDir, env);
    const same = createDeviceAuthMock();
    const stdout = [];
    const exitCode = await runCli(
      ['login', '--root', '.compass', '--no-browser'],
      createIo(stdout),
      { cwd: tempDir, env, fetch: same.fetch, sleep: async () => {}, execFile: () => { throw new Error('must not open'); } },
    );
    assert.equal(exitCode, 0, stdout.join(''));
    assert.equal(same.calls[0].body.project_id, PROJECT_ID);
    assert.doesNotMatch(stdout.join(''), /Opening your browser|Connected hosted/);

    const other = createDeviceAuthMock({ projectId: 'proj-other' });
    const warnStdout = [];
    await runCli(
      ['login', '--root', '.compass', '--no-browser'],
      createIo(warnStdout),
      { cwd: tempDir, env, fetch: other.fetch, sleep: async () => {} },
    );
    assert.match(warnStdout.join(''), /WARNING: This root is bound to project proj-store, but you approved Hosted Project \(proj-other\)/);
    const project = parseSimpleYaml(await readFile(path.join(tempDir, '.compass', 'project.yaml'), 'utf8'));
    assert.equal(project.sync.project_id, PROJECT_ID);
    assert.equal((await listSyncCredentials({ env })).entries.length, 2);

    await assert.rejects(
      runCli(['login', '--root', '.compass', '--api-url', 'https://elsewhere.example', '--no-browser'], createIo([]), { cwd: tempDir, env, fetch: same.fetch }),
      /does not match the bound hosted URL/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('login surfaces expiry, denial, unknown targets, and missing roots', async () => {
  const { tempDir, env } = await createTempWorkspace();
  try {
    await assert.rejects(
      runCli(['login', '--root', '.compass'], createIo([]), { cwd: tempDir, env, fetch: async () => { throw new Error('no'); } }),
      /No project\.yaml found/,
    );
    await createBoundRoot(tempDir, env, { target: 'dev', apiUrl: 'http://localhost:3000', projectId: 'proj-dev' });

    const expired = createDeviceAuthMock({ outcome: 'expired' });
    await assert.rejects(
      runCli(['login', '--root', '.compass', '--sync-target', 'dev', '--no-browser'], createIo([]), { cwd: tempDir, env, fetch: expired.fetch, sleep: async () => {} }),
      /sign-in code expired/,
    );

    await assert.rejects(
      runCli(['login', '--root', '.compass', '--sync-target', 'prod', '--no-browser'], createIo([]), { cwd: tempDir, env, fetch: expired.fetch, sleep: async () => {} }),
      /Unknown sync target "prod".*add --api-url/,
    );

    const created = createDeviceAuthMock();
    const stdout = [];
    const exitCode = await runCli(
      ['login', '--root', '.compass', '--sync-target', 'prod', '--api-url', API_URL, '--no-browser'],
      createIo(stdout),
      { cwd: tempDir, env, fetch: created.fetch, sleep: async () => {} },
    );
    assert.equal(exitCode, 0, stdout.join(''));
    assert.match(stdout.join(''), /Sync target: prod \(default: dev\)/);
    assert.match(stdout.join(''), /Then run: vibecompass push --sync-target prod/);
    const project = parseSimpleYaml(await readFile(path.join(tempDir, '.compass', 'project.yaml'), 'utf8'));
    assert.equal(project.sync.targets.prod.project_id, PROJECT_ID);
    assert.equal(project.sync.default_target, 'dev');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('R3: target identity preserves path case and lowercases only scheme and host', async () => {
  const { tempDir, env } = await createTempWorkspace();
  try {
    assert.equal(normalizeApiUrl('HTTPS://Review.Invalid/TeamA/'), 'https://review.invalid/TeamA');
    assert.notEqual(credentialStoreKey('https://review.invalid/TeamA', 'p1'), credentialStoreKey('https://review.invalid/teama', 'p1'));
    await storeSyncCredential({ apiUrl: 'https://review.invalid/TeamA', projectId: 'p1', token: `${TOKEN}A` }, { env });
    await storeSyncCredential({ apiUrl: 'https://review.invalid/teama', projectId: 'p1', token: `${TOKEN}B` }, { env });
    const upper = await resolveSyncCredential({ apiUrl: 'https://review.invalid/TeamA', projectId: 'p1', credentialEnvVar: 'X' }, { env });
    const lower = await resolveSyncCredential({ apiUrl: 'https://review.invalid/teama', projectId: 'p1', credentialEnvVar: 'X' }, { env });
    assert.equal(upper.credential, `${TOKEN}A`);
    assert.equal(lower.credential, `${TOKEN}B`);
    assert.equal((await listSyncCredentials({ env })).entries.length, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('R2: concurrent same-process writes to different targets all survive and set/remove interleave safely', async () => {
  const { tempDir, env } = await createTempWorkspace();
  try {
    const writes = Array.from({ length: 8 }, (_, index) =>
      storeSyncCredential({ apiUrl: API_URL, projectId: `proj-${index}`, token: `${TOKEN}${index}` }, { env }),
    );
    const results = await Promise.all(writes);
    assert.equal(results.every((result) => result.backend === 'file'), true);
    const listing = await listSyncCredentials({ env });
    assert.deepEqual(
      listing.entries.map((entry) => entry.projectId).sort(),
      Array.from({ length: 8 }, (_, index) => `proj-${index}`).sort(),
    );

    await Promise.all([
      removeSyncCredential({ apiUrl: API_URL, projectId: 'proj-0' }, { env }),
      storeSyncCredential({ apiUrl: API_URL, projectId: 'proj-8', token: `${TOKEN}8` }, { env }),
      removeSyncCredential({ apiUrl: API_URL, projectId: 'proj-1' }, { env }),
      storeSyncCredential({ apiUrl: API_URL, projectId: 'proj-2', token: `${TOKEN}22` }, { env }),
    ]);
    const after = await listSyncCredentials({ env });
    assert.deepEqual(after.entries.map((entry) => entry.projectId).sort(), ['proj-2', 'proj-3', 'proj-4', 'proj-5', 'proj-6', 'proj-7', 'proj-8']);
    assert.equal((await resolveSyncCredential({ apiUrl: API_URL, projectId: 'proj-2', credentialEnvVar: 'X' }, { env })).credential, `${TOKEN}22`);
    await assert.rejects(stat(path.join(env.VIBECOMPASS_CONFIG_DIR, 'credentials.json.lock')));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('R2: concurrent writes from independent processes all survive', async () => {
  const { tempDir, env } = await createTempWorkspace();
  try {
    const modulePath = fileURLToPath(new URL('../credential-store.js', import.meta.url));
    const script = `import { storeSyncCredential } from ${JSON.stringify(modulePath)};\n`
      + `await storeSyncCredential({ apiUrl: ${JSON.stringify(API_URL)}, projectId: process.argv[1], token: 'vcsync_' + process.argv[1].padEnd(32, '0') }, {});\n`;
    const children = Array.from({ length: 12 }, (_, index) => new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        ['--input-type=module', '-e', script, `child-${index}`],
        { env: { ...process.env, ...env, VIBECOMPASS_CREDENTIAL_STORE: 'file' } },
        (error, _stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve()),
      );
    }));
    await Promise.all(children);
    const listing = await listSyncCredentials({ env });
    assert.equal(listing.entries.length, 12);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('R2: a live lock blocks writers until released and a stale lock is reclaimed', async () => {
  const { tempDir, env } = await createTempWorkspace();
  try {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const holder = withCredentialStoreLock({ env }, () => held);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(
      storeSyncCredential({ apiUrl: API_URL, projectId: 'p', token: TOKEN }, { env, lockTimeoutMs: 80, sleep: async () => {} }),
      /locked by another vibecompass process \(pid \d+/,
    );
    release();
    await holder;
    const stored = await storeSyncCredential({ apiUrl: API_URL, projectId: 'p', token: TOKEN }, { env });
    assert.equal(stored.backend, 'file');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function ageLock(lockPath, seconds) {
  const old = new Date(Date.now() - seconds * 1000);
  return utimes(lockPath, old, old);
}

function deadPid() {
  return spawnSync(process.execPath, ['-e', '0']).pid;
}

function sharedKeychain(items = new Map()) {
  return {
    name: 'keychain',
    description: 'fake keychain',
    items,
    async available() { return true; },
    async get(account) { return items.get(account) ?? null; },
    async set(account, secret) { items.set(account, secret); },
    async remove(account) { return items.delete(account); },
  };
}

function pausedKeychain(items = new Map()) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const backend = {
    ...sharedKeychain(items),
    async set(account, secret) { await gate; items.set(account, secret); },
  };
  return { backend, release: () => release() };
}

test('R2 (schedule 1): a live writer paused inside the keychain keeps its lock however old it looks; the same project is never overwritten underneath it', async () => {
  const { tempDir, env } = await createTempWorkspace();
  try {
    const dir = env.VIBECOMPASS_CONFIG_DIR;
    const lockPath = path.join(dir, 'credentials.json.lock');
    const items = new Map();
    const paused = pausedKeychain(items);
    const instant = sharedKeychain(items);
    const base = { env: { VIBECOMPASS_CONFIG_DIR: dir } };

    const writerA = storeSyncCredential({ apiUrl: API_URL, projectId: PROJECT_ID, token: `${TOKEN}A` }, { ...base, keychainBackend: paused.backend });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await ageLock(lockPath, 3600); // an hour of "missed heartbeats" changes nothing: the owner is alive

    await assert.rejects(
      storeSyncCredential({ apiUrl: API_URL, projectId: PROJECT_ID, token: `${TOKEN}B` }, { ...base, keychainBackend: instant, lockTimeoutMs: 150, sleep: async () => {} }),
      /locked by another vibecompass process \(pid \d+ on /,
    );
    assert.equal(items.size, 0, 'B never reached the keychain');

    paused.release();
    const storedA = await writerA;
    assert.equal(storedA.backend, 'keychain');
    const key = credentialStoreKey(API_URL, PROJECT_ID);
    assert.equal(items.get(key), `${TOKEN}A`);
    assert.equal((await listSyncCredentials(base)).entries[0].tokenPrefix, `${TOKEN}A`.slice(0, 14));
    await assert.rejects(stat(lockPath));

    const storedB = await storeSyncCredential({ apiUrl: API_URL, projectId: PROJECT_ID, token: `${TOKEN}B` }, { ...base, keychainBackend: instant });
    assert.equal(storedB.replaced, true);
    assert.equal(items.get(key), `${TOKEN}B`);
    const resolved = await resolveSyncCredential({ apiUrl: API_URL, projectId: PROJECT_ID, credentialEnvVar: 'X' }, { ...base, keychainBackend: instant });
    assert.equal(resolved.credential, `${TOKEN}B`);
    assert.equal((await listSyncCredentials(base)).entries[0].tokenPrefix, `${TOKEN}B`.slice(0, 14));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('R2 (schedule 2): a writer paused between its ownership check and the index rename still excludes other writers', async () => {
  const { tempDir, env } = await createTempWorkspace();
  try {
    const dir = env.VIBECOMPASS_CONFIG_DIR;
    const lockPath = path.join(dir, 'credentials.json.lock');
    let resume;
    const gate = new Promise((resolve) => { resume = resolve; });
    const writerA = storeSyncCredential(
      { apiUrl: API_URL, projectId: 'proj-a', token: `${TOKEN}A` },
      { env, testHooks: { beforeIndexRename: () => gate } },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await ageLock(lockPath, 3600);

    await assert.rejects(
      storeSyncCredential({ apiUrl: API_URL, projectId: 'proj-b', token: `${TOKEN}B` }, { env, lockTimeoutMs: 150, sleep: async () => {} }),
      /locked by another vibecompass process/,
    );
    resume();
    await writerA;
    assert.deepEqual((await listSyncCredentials({ env })).entries.map((entry) => entry.projectId), ['proj-a']);
    await storeSyncCredential({ apiUrl: API_URL, projectId: 'proj-b', token: `${TOKEN}B` }, { env });
    assert.deepEqual((await listSyncCredentials({ env })).entries.map((entry) => entry.projectId).sort(), ['proj-a', 'proj-b']);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('R2: a lock whose owner process is gone is recovered exactly once under concurrent reclaimers (same process and across processes)', async () => {
  const { tempDir, env } = await createTempWorkspace();
  try {
    const dir = env.VIBECOMPASS_CONFIG_DIR;
    const lockPath = path.join(dir, 'credentials.json.lock');
    await storeSyncCredential({ apiUrl: API_URL, projectId: 'seed', token: TOKEN }, { env });
    const hostname = (await import('node:os')).default.hostname();

    await writeFile(lockPath, JSON.stringify({ id: 'dead-owner', pid: deadPid(), host: hostname, acquired_at: new Date().toISOString() }), { mode: 0o600 });
    const sameProcess = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        storeSyncCredential({ apiUrl: API_URL, projectId: `same-${index}`, token: `${TOKEN}${index}` }, { env, lockTimeoutMs: 5000 }),
      ),
    );
    assert.equal(sameProcess.length, 8);
    await assert.rejects(stat(lockPath));
    await assert.rejects(stat(`${lockPath}.reclaim`));

    await writeFile(lockPath, JSON.stringify({ id: 'dead-owner-2', pid: deadPid(), host: hostname, acquired_at: new Date().toISOString() }), { mode: 0o600 });
    const modulePath = fileURLToPath(new URL('../credential-store.js', import.meta.url));
    const script = `import { storeSyncCredential } from ${JSON.stringify(modulePath)};\n`
      + `await storeSyncCredential({ apiUrl: ${JSON.stringify(API_URL)}, projectId: process.argv[1], token: 'vcsync_' + process.argv[1].padEnd(32, '0') }, { lockTimeoutMs: 5000 });\n`;
    await Promise.all(Array.from({ length: 6 }, (_, index) => new Promise((resolve, reject) => {
      execFile(process.execPath, ['--input-type=module', '-e', script, `cross-${index}`],
        { env: { ...process.env, ...env, VIBECOMPASS_CREDENTIAL_STORE: 'file' } },
        (error, _stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve()));
    })));
    const listing = await listSyncCredentials({ env });
    assert.equal(listing.entries.length, 1 + 8 + 6);
    await assert.rejects(stat(lockPath));
    await assert.rejects(stat(`${lockPath}.reclaim`));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('R2: locks from another host, unreadable locks, and a dead reclaimer are never removed automatically and are named in the error', async () => {
  const { tempDir, env } = await createTempWorkspace();
  try {
    const dir = env.VIBECOMPASS_CONFIG_DIR;
    const lockPath = path.join(dir, 'credentials.json.lock');
    const hostname = (await import('node:os')).default.hostname();
    const quick = { env, lockTimeoutMs: 60, sleep: async () => {} };
    await (await import('node:fs/promises')).mkdir(dir, { recursive: true, mode: 0o700 });

    await writeFile(lockPath, JSON.stringify({ id: 'elsewhere', pid: deadPid(), host: 'other-machine', acquired_at: new Date().toISOString() }), { mode: 0o600 });
    await assert.rejects(storeSyncCredential({ apiUrl: API_URL, projectId: 'p', token: TOKEN }, quick), /pid \d+ on other-machine/);
    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).id, 'elsewhere');
    await unlink(lockPath);

    await writeFile(lockPath, 'not json', { mode: 0o600 });
    await assert.rejects(storeSyncCredential({ apiUrl: API_URL, projectId: 'p', token: TOKEN }, quick), /an unreadable lock file/);
    assert.equal(await readFile(lockPath, 'utf8'), 'not json');
    await unlink(lockPath);

    await writeFile(lockPath, JSON.stringify({ id: 'dead', pid: deadPid(), host: hostname, acquired_at: new Date().toISOString() }), { mode: 0o600 });
    await writeFile(`${lockPath}.reclaim`, JSON.stringify({ id: 'dead-reclaimer', pid: deadPid(), host: hostname, acquired_at: new Date().toISOString() }), { mode: 0o600 });
    await assert.rejects(storeSyncCredential({ apiUrl: API_URL, projectId: 'p', token: TOKEN }, quick), /A reclaim lock \(.*credentials\.json\.lock\.reclaim, pid \d+ on /);
    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).id, 'dead');
    await unlink(`${lockPath}.reclaim`);
    await unlink(lockPath);
    const stored = await storeSyncCredential({ apiUrl: API_URL, projectId: 'p', token: TOKEN }, { env });
    assert.equal(stored.backend, 'file');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('defense in depth: a lock file removed by hand while a writer runs makes that writer abort before publishing', async () => {
  const { tempDir, env } = await createTempWorkspace();
  try {
    const dir = env.VIBECOMPASS_CONFIG_DIR;
    const lockPath = path.join(dir, 'credentials.json.lock');
    await storeSyncCredential({ apiUrl: API_URL, projectId: 'seed', token: TOKEN }, { env });
    const paused = pausedKeychain();
    const loser = storeSyncCredential(
      { apiUrl: API_URL, projectId: 'loser', token: `${TOKEN}L` },
      { env: { VIBECOMPASS_CONFIG_DIR: dir }, keychainBackend: paused.backend },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await unlink(lockPath);
    await writeFile(lockPath, JSON.stringify({ id: 'successor', pid: process.pid, host: 'x', acquired_at: new Date().toISOString() }), { mode: 0o600 });
    paused.release();
    await assert.rejects(loser, /lock file was removed while this command was running; nothing was written/);
    assert.deepEqual((await listSyncCredentials({ env })).entries.map((entry) => entry.projectId), ['seed']);
    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).id, 'successor', 'successor lock left in place');
    assert.equal((await readdirTemp(dir)).length, 0, 'no temp file left behind');
    await unlink(lockPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function readdirTemp(dir) {
  const { readdir } = await import('node:fs/promises');
  return (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
}

test('S3: sync-credential list annotates the bound target by exact key, preserving path case', async () => {
  const { tempDir, env } = await createTempWorkspace();
  try {
    await createBoundRoot(tempDir, env, { apiUrl: 'https://review.invalid/TeamA', projectId: 'p1' });
    await storeSyncCredential({ apiUrl: 'https://review.invalid/TeamA', projectId: 'p1', token: `${TOKEN}A` }, { env });
    await storeSyncCredential({ apiUrl: 'https://review.invalid/teama', projectId: 'p1', token: `${TOKEN}B` }, { env });
    const stdout = [];
    assert.equal(await runCli(['sync-credential', 'list', '--root', '.compass'], createIo(stdout), { cwd: tempDir, env }), 0);
    const lines = stdout.join('').split('\n');
    const upper = lines.find((line) => line.includes('https://review.invalid/TeamA project p1'));
    const lower = lines.find((line) => line.includes('https://review.invalid/teama project p1'));
    assert.match(upper, /— bound here$/);
    assert.doesNotMatch(lower, /bound here/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('R4: keychain labels are sanitized and unsafe keys map to a digest account', async () => {
  assert.equal(keychainLabelFor('VibeCompass sync token (My "App" \\ team)'), 'VibeCompass sync token (My App team)');
  assert.equal(keychainLabelFor('\u0000\n'), 'VibeCompass sync token');
  assert.equal(keychainLabelFor('x'.repeat(200)).length, 120);
  assert.equal(keychainAccountFor('https://hosted.example|proj'), 'https://hosted.example|proj');
  assert.match(keychainAccountFor('https://hosted.example/team%20a|proj'), /^k:[a-f0-9]{64}$/);

  // macOS adapter with a fake `security`: the label with quotes and a
  // backslash must be written through stdin cleanly and read back.
  const items = new Map();
  const commands = [];
  const execFileMock = (file, args, _options, callback) => {
    assert.equal(file, 'security');
    const stdin = { chunks: [], on() {}, end(input) { if (input !== undefined) this.chunks.push(String(input)); } };
    setImmediate(() => {
      if (args[0] === '-i') {
        const line = stdin.chunks.join('');
        commands.push(line);
        const match = line.match(/^add-generic-password -a "([^"]+)" -s "vibecompass-sync" -l "([^"]*)" -j "[^"]*" -U -w "([^"]+)"$/m);
        if (!match) { const error = new Error('bad command'); error.code = 1; callback(error, '', 'parse'); return; }
        items.set(match[1], match[3]);
        callback(null, '', '');
      } else if (args[0] === 'find-generic-password') {
        const account = args[args.indexOf('-a') + 1];
        if (!items.has(account)) { const error = new Error('nf'); error.code = 44; callback(error, '', 'not found'); return; }
        callback(null, `${items.get(account)}\n`, '');
      } else {
        callback(null, '', '');
      }
    });
    return { stdin };
  };
  const backend = await detectKeychainBackend({ platform: 'darwin', execFile: execFileMock });
  const { tempDir, env } = await createTempWorkspace();
  try {
    const options = { env: { VIBECOMPASS_CONFIG_DIR: env.VIBECOMPASS_CONFIG_DIR }, keychainBackend: backend };
    const stored = await storeSyncCredential(
      { apiUrl: API_URL, projectId: PROJECT_ID, token: TOKEN, label: 'VibeCompass sync token (My "App" \\ team)', source: 'login' },
      options,
    );
    assert.equal(stored.backend, 'keychain');
    assert.deepEqual(stored.warnings, []);
    assert.match(commands[0], /-l "VibeCompass sync token \(My App team\)"/);
    assert.doesNotMatch(commands[0], /\\/);
    const resolved = await resolveSyncCredential({ apiUrl: API_URL, projectId: PROJECT_ID, credentialEnvVar: 'X' }, options);
    assert.equal(resolved.credential, TOKEN);
    assert.equal(resolved.source, 'keychain');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('auto policy falls back to the file store with a warning when the keychain write fails', async () => {
  const { tempDir, env } = await createTempWorkspace();
  try {
    const broken = { ...createFakeKeychain(), async set() { throw new Error('no Secret Service session'); } };
    const options = { env: { VIBECOMPASS_CONFIG_DIR: env.VIBECOMPASS_CONFIG_DIR }, keychainBackend: broken };
    const stored = await storeSyncCredential({ apiUrl: API_URL, projectId: PROJECT_ID, token: TOKEN }, options);
    assert.equal(stored.backend, 'file');
    assert.match(stored.warnings[0], /OS keychain write failed \(no Secret Service session\); the token was stored in the credential store file instead/);
    const resolved = await resolveSyncCredential({ apiUrl: API_URL, projectId: PROJECT_ID, credentialEnvVar: 'X' }, options);
    assert.equal(resolved.credential, TOKEN);
    assert.equal(resolved.source, 'file');
    await assert.rejects(
      storeSyncCredential({ apiUrl: API_URL, projectId: PROJECT_ID, token: TOKEN, backend: 'keychain' }, options),
      /no Secret Service session/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('S1: a stalled hosted response is aborted by the login deadline', async () => {
  const { tempDir, env } = await createTempWorkspace();
  try {
    await createBoundRoot(tempDir, env);
    const stalled = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const startedAt = Date.now();
    await assert.rejects(
      runCli(['login', '--root', '.compass', '--no-browser', '--poll-timeout', '0.3'], createIo([]), { cwd: tempDir, env, fetch: stalled, sleep: async () => {} }),
      /timed out/i,
    );
    assert.ok(Date.now() - startedAt < 5000);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
