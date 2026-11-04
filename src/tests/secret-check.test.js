import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../cli.js';
import { initializeProjectMemory } from '../init.js';
import { buildWorkflowScaffoldFiles } from '../scaffold.js';
import {
  allowSecretMatch,
  checkProjectMemorySecrets,
  evaluateSecretMatches,
  findSecretMatches,
  parseSecretAllowList,
  resolveSecretCheckSettings,
  SECRET_CHECK_ALLOW_FILE,
  SECRET_RULE_NAMES,
} from '../secret-check.js';
import { closeProjectSession, startProjectSession } from '../session.js';
import { pushProjectMemory } from '../sync.js';

// D-406. Every key-shaped fixture, and every text the check matches, is joined
// from parts at runtime, so no committed line is one the check (or a public
// secret scanner) would report. The key cases mirror the app's
// src/lib/github/secret-guard.test.ts (D-406 item 2).
const join = (...parts) => parts.join('');
const run = (seed, length) => seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
const mixed = (length) => run('a1B2c3D4e5F6g7H8', length);
const upper = (length) => run('Q7W2E9R4T6Y1U8I3', length);

const keys = {
  githubClassic: [join('gh', 'p_', mixed(36)), 'token-legacy'],
  githubFineGrained: [join('github', '_pat_', mixed(60)), 'token-legacy'],
  gitlab: [join('gl', 'pat-', mixed(20)), 'token-legacy'],
  modelProvider: [join('s', 'k-', 'proj-', mixed(40)), 'token-legacy'],
  stripeSecret: [join('s', 'k_', 'live_', mixed(24)), 'token-legacy'],
  stripePublishable: [join('p', 'k_', 'test_', mixed(24)), 'token-legacy'],
  slack: [join('xo', 'xb-', '1234567890-', mixed(24)), 'token-legacy'],
  githubInstallation: [join('gh', 's_', mixed(36)), 'token-github'],
  githubOauth: [join('gh', 'o_', mixed(36)), 'token-github'],
  stripeRestricted: [join('r', 'k_', 'live_', mixed(24)), 'token-stripe'],
  stripeWebhook: [join('wh', 'sec_', mixed(32)), 'token-stripe'],
  supabaseSecret: [join('sb_', 'secret_', mixed(32)), 'token-supabase'],
  npm: [join('np', 'm_', mixed(36)), 'token-npm'],
  awsAccessKey: [join('AK', 'IA', upper(16)), 'token-aws'],
  awsSessionKey: [join('AS', 'IA', upper(16)), 'token-aws'],
  google: [join('AI', 'za', mixed(33), '-_'), 'token-google'],
  jwt: [
    [
      Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
      Buffer.from(`{"role":"service_role","ref":"${mixed(20)}"}`).toString('base64url'),
      mixed(43),
    ].join('.'),
    'token-jwt',
  ],
};

const keyLines = [mixed(64), mixed(64), mixed(40)];
const privateKey = (label = 'RSA PRIVATE KEY', separator = '\n', prefix = '') =>
  [join('-----BEGIN ', label, '-----'), ...keyLines, join('-----END ', label, '-----')]
    .map((line) => `${prefix}${line}`)
    .join(separator);

const rulesOf = (text) => findSecretMatches(text, 'doc.md').map((match) => match.rule);

function assertNoValue(output, values) {
  for (const value of values) {
    assert.ok(!output.includes(value), 'the output holds no matched text');
    // Nor a recognizable piece of it.
    if (value.length >= 12) assert.ok(!output.includes(value.slice(4, 16)), 'the output holds no part of a match');
  }
}

function createIo(stdout, stderr) {
  return {
    stdout: { write(chunk) { stdout.push(chunk); } },
    stderr: { write(chunk) { stderr.push(chunk); } },
  };
}

async function createRoot(options = {}) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-secret-check-'));
  const rootDir = path.join(tempDir, '.compass');
  await initializeProjectMemory({
    cwd: tempDir,
    rootDir,
    name: 'Secret Check Project',
    mode: options.mode ?? 'local-primary',
    repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
    bootstrap: { workflow: true, claude: true },
  });
  let project = await readFile(path.join(rootDir, 'project.yaml'), 'utf8');
  if (options.secretCheck !== undefined) {
    project = project.replace('  workflow:\n', `  workflow:\n    secret_check: ${options.secretCheck}\n`);
  }
  if (options.sync !== false) {
    project += [
      'sync:',
      '  provider: vibecompass',
      '  api_url: https://sync.example.test',
      '  project_id: proj-secret-check',
      '  credential_source: env',
      '  credential_env_var: SECRET_CHECK_TEST_TOKEN',
      '',
    ].join('\n');
  }
  await writeFile(path.join(rootDir, 'project.yaml'), project, 'utf8');
  return { tempDir, rootDir };
}

const DOC = 'architecture/overview/project-shape.md';

async function appendToDoc(rootDir, text, relativePath = DOC) {
  const filePath = path.join(rootDir, relativePath);
  const current = await readFile(filePath, 'utf8');
  await writeFile(filePath, `${current.trimEnd()}\n\n${text}\n`, 'utf8');
  const lines = (await readFile(filePath, 'utf8')).split('\n');
  return lines.findIndex((line) => line.includes(text.split('\n')[0])) + 1;
}

function pushEnvironment(tempDir, calls) {
  return {
    cwd: tempDir,
    env: { SECRET_CHECK_TEST_TOKEN: join('test-', 'credential') },
    runtime: {
      fetch: async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return {
          ok: true,
          async json() {
            return { run_id: 'run-1', status: 'completed', remote_revision_id: '7d2f4c1e-3b5a-4c6d-8e9f-0a1b2c3d4e5f' };
          },
        };
      },
    },
  };
}

test('each key format is reported once, under its rule, on its line', () => {
  for (const [name, [key, rule]] of Object.entries(keys)) {
    const matches = findSecretMatches(`intro\nconst value = ${key}; // ${name}\n`, 'doc.md');
    assert.deepEqual(matches.map((match) => [match.rule, match.line, match.column]), [[rule, 2, 15]], name);
    assert.match(matches[0].fingerprint, /^sha256:[0-9a-f]{16}$/);
  }
  assert.deepEqual(SECRET_RULE_NAMES, [
    'private-key', 'token-legacy', 'token-github', 'token-stripe', 'token-supabase', 'token-npm',
    'token-aws', 'token-google', 'token-jwt', 'url-password', 'secret-named-assignment',
  ]);
});

test('a private-key block is one match in every form, including a complete block both private-key patterns match', () => {
  for (const block of [
    privateKey(),
    privateKey('PRIVATE KEY', '\n', '+'),
    privateKey('EC PRIVATE KEY', '\\n'),
    privateKey('OPENSSH PRIVATE KEY'),
    privateKey('ENCRYPTED PRIVATE KEY'),
    privateKey('PGP PRIVATE KEY BLOCK'),
  ]) {
    assert.deepEqual(rulesOf(`before\n${block}\nafter`), ['private-key']);
  }
  const orphan = [join('-----BEGIN ', 'RSA PRIVATE KEY', '-----'), 'Proc-Type: 4,ENCRYPTED', 'DEK-Info: AES-128-CBC,00112233', '', ...keyLines].join('\n');
  assert.deepEqual(rulesOf(`${orphan}\nconst next = 1;`), ['private-key']);
  assert.deepEqual(rulesOf(JSON.stringify({ key: orphan })), ['private-key']);
  const longBlock = [
    join('-----BEGIN ', 'PGP PRIVATE KEY BLOCK', '-----'), 'Version: GnuPG v2', '',
    ...Array.from({ length: 340 }, () => mixed(64)), '=Ab1c', join('-----END ', 'PGP PRIVATE KEY BLOCK', '-----'),
  ].join('\n');
  assert.ok(longBlock.length > 20_000);
  assert.deepEqual(rulesOf(`before\n${longBlock}\nafter`), ['private-key']);
  // A public key or certificate is kept.
  assert.deepEqual(rulesOf(join('-----BEGIN ', 'PUBLIC KEY', '-----\n', mixed(64), '\n-----END ', 'PUBLIC KEY', '-----')), []);
  assert.deepEqual(rulesOf(join('-----BEGIN ', 'CERTIFICATE', '-----\n', mixed(64), '\n-----END ', 'CERTIFICATE', '-----')), []);
});

test('URL passwords and secret-named values are reported; the app markers and Actions references are not', () => {
  const password = mixed(16);
  assert.deepEqual(rulesOf(join('DATABASE_URL=postgresql://postgres:', password, '@db.example.supabase.co:5432/postgres')), ['url-password']);
  assert.deepEqual(rulesOf(join('redis://:', password, '@cache:6379')), ['url-password']);

  const value = mixed(20);
  for (const line of [
    join('DB_PASS', 'WORD=', value),
    join('+API_', 'KEY=', value),
    join('-SECRET_', 'KEY = ', value),
    join('api', 'Key: "', value, '"'),
    join('client_', "secret = '", value, "'"),
    join('"api-', 'key": "', value, '"'),
    join('  pass', 'word: ', value),
    join('AWS_SECRET_ACCESS_', 'KEY=', mixed(40)),
    join('{\\"pass', 'phrase\\": \\"', value, '\\"}'),
    join('fn(to', 'ken=', value, ')'),
    JSON.stringify(join('API_', 'KEY=', value, '\nNEXT=1')),
  ]) {
    assert.deepEqual(rulesOf(line), ['secret-named-assignment'], line.slice(0, 8));
  }

  // The app's own markers are not matches (D-406 item 1).
  for (const text of [
    join('scheme://user:', '[redacted]', '@host'),
    join('pass', 'word: "', '[redacted]', '"'),
    join('{\\"to', 'ken\\": \\"', '[redacted]', '\\"}'),
    'const value = [redacted token];',
  ]) {
    assert.deepEqual(rulesOf(text), [], text);
  }
  // An Actions secret reference names a secret and holds no value.
  for (const text of [join('key: $', '{{ secrets.PROD_DEPLOY_KEY }}'), join('to', 'ken: $', '{{ secrets.X }}')]) {
    assert.deepEqual(rulesOf(text), [], text);
  }
});

test('the accepted false positives are reported, as D-405 accepts them', () => {
  assert.deepEqual(rulesOf(join('"pass', 'word": "Pass', 'word"')), ['secret-named-assignment']);
  assert.deepEqual(rulesOf(join('pass', 'word: hashed', '12')), ['secret-named-assignment']);
  assert.deepEqual(rulesOf(join('an identifier such as s', 'k_learn_pipeline_config')), ['token-legacy']);
  assert.deepEqual(rulesOf(join('postgresql://postgres:', 'example', '@localhost:5432/app')), ['url-password']);
  assert.deepEqual(rulesOf(join('sample: ', keys.jwt[0])), ['token-jwt']);
});

test('quoted values: the other quote and escapes stay inside, and the bound is 8 to 256, raw and escaped once as JSON', () => {
  for (const quote of ['"', "'"]) {
    for (const prefix of ['Zq7', 'Zq7abcdefg']) {
      const raw = join('pass', 'word: ', quote, prefix, '\\', quote, 'Wx9', 'suffix42', quote);
      for (const text of [raw, JSON.stringify(raw), JSON.stringify({ description: raw }, null, 2)]) {
        assert.deepEqual(rulesOf(text), ['secret-named-assignment'], text.slice(0, 12));
      }
    }
  }
  for (const text of [join('pass', 'word: "short" + "nextpart"'), join('pass', "word: 'short' + 'nextpart'")]) {
    assert.deepEqual(rulesOf(text), []);
    assert.deepEqual(rulesOf(JSON.stringify(text)), []);
  }
  for (const length of [7, 8, 255, 256, 257]) {
    const reported = length >= 8 && length <= 256;
    for (const line of [join('API_', 'KEY=', mixed(length)), join('api_', 'key: "', mixed(length), '"')]) {
      assert.equal(rulesOf(line).length === 1, reported, `${length}`);
    }
  }
});

test('ordinary text near each pattern is left alone', () => {
  const ordinary = [
    'password: string',
    'apiKey: process.env.API_KEY',
    'const MAX_TOKENS = 32000;',
    'tokenEndpoint: "https://auth.example.com/oauth/token"',
    'if (password == "correct-horse") {}',
    'const check = (token) => token.length > 8;',
    'items.map((token => token.trim()))',
    'passwordHash: hashed12345',
    'type Token = { secret: SecretValue };',
    'secret: process.env.NEXTAUTH_SECRET!,',
    'password: ${PASSWORD}',
    'token: z.string().min(1),',
    'TOKEN_LIMIT=12000',
    'password: "short"',
    'password: "has a space in it"',
    'const task_scheduler_configuration = 1;',
    'const desk_organizer_component_name = "x";',
    join('gh', 'p_', 'short'),
    join('AK', 'IA', upper(15)),
    join('AI', 'za', mixed(30)),
    'eyJhbGciOiJIUzI1NiJ9',
    join('sb_', 'publishable_', mixed(32)),
    'https://example.com/path?query=1',
    'postgres://localhost:5432/app',
    'git@github.com:owner/repo.git',
    'user@example.com',
    'npm_config_registry=https://registry.npmjs.org/',
    'whsec is the prefix Stripe uses for webhook secrets.',
    'The `.env` file and `.env.local` hold local settings; `id_rsa.pub` is kept.',
    // Inline code ends a bare value at the backtick, so a sample there is not reported.
    join('`pass', 'word: hashed', '12`'),
  ];
  for (const text of ordinary) assert.deepEqual(rulesOf(text), [], text);
});

test('R1.1: a match inside a longer one is not reported alone, and allowing the shorter never passes a change outside it', () => {
  const host = '@db.internal/app';
  const v1 = join('DATABASE_URL=postgres://u:', 'example', host);
  const [shorter] = findSecretMatches(v1, DOC);
  assert.equal(shorter.rule, 'url-password');
  const records = [{ path: DOC, rule: shorter.rule, fingerprint: shorter.fingerprint, reason: 'example URL' }];
  assert.equal(evaluateSecretMatches([{ path: DOC, text: v1 }], records).ok, true);

  // The URL now sits inside a quoted secret-named value: the longer match is
  // reported, and the URL's record doesn't cover it.
  const v2 = join('api_', 'key: "postgres://u:', 'example', host, '-', 'Zq7abcdefg', '"');
  const v2Matches = findSecretMatches(v2, DOC);
  assert.deepEqual(v2Matches.map((match) => match.rule), ['secret-named-assignment']);
  const v2Result = evaluateSecretMatches([{ path: DOC, text: v2 }], records);
  assert.equal(v2Result.ok, false);
  assert.deepEqual(v2Result.unusedAllows.map((record) => record.rule), ['url-password']);

  // Allow the longer match; a change outside the URL but inside the value is refused again.
  const longer = [...records, { path: DOC, rule: 'secret-named-assignment', fingerprint: v2Matches[0].fingerprint, reason: 'sample' }];
  assert.equal(evaluateSecretMatches([{ path: DOC, text: v2 }], longer).ok, true);
  const v3 = join('api_', 'key: "postgres://u:', 'example', host, '-', 'Wx9changed', '"');
  assert.equal(evaluateSecretMatches([{ path: DOC, text: v3 }], longer).ok, false);
});

test('R1.2: two matches on one line need --fingerprint, and allowing one leaves the other refused', async () => {
  const { tempDir, rootDir } = await createRoot();
  try {
    const first = join('Zq7', 'abcdefgh');
    const second = join('Wx9', 'suffix42');
    const line = await appendToDoc(rootDir, join('{"pass', 'word": "', first, '", "to', 'ken": "', second, '"}'));

    const before = await checkProjectMemorySecrets({ rootDir });
    const onLine = before.unallowed.filter((match) => match.path === DOC && match.line === line);
    assert.deepEqual(onLine.map((match) => match.rule), ['secret-named-assignment', 'secret-named-assignment']);
    assert.notEqual(onLine[0].fingerprint, onLine[1].fingerprint);

    await assert.rejects(
      allowSecretMatch({ rootDir, target: `${DOC}:${line}`, reason: 'sample JSON' }),
      (error) => {
        assert.match(error.message, /has 2 matches, and one command records one; nothing was recorded/);
        assert.match(error.message, /- column \d+: secret-named-assignment sha256:[0-9a-f]{16}/);
        assertNoValue(error.message, [first, second]);
        return true;
      },
    );
    await assert.rejects(readFile(path.join(rootDir, SECRET_CHECK_ALLOW_FILE), 'utf8'), { code: 'ENOENT' });

    const allowed = await allowSecretMatch({ rootDir, target: `${DOC}:${line}`, reason: 'sample JSON', fingerprint: onLine[0].fingerprint });
    assert.equal(allowed.status, 'allowed');
    const after = await checkProjectMemorySecrets({ rootDir });
    assert.deepEqual(
      after.unallowed.filter((match) => match.path === DOC).map((match) => match.fingerprint),
      [onLine[1].fingerprint],
    );
    assert.equal(after.allowedCount, 1);
    await assert.rejects(
      allowSecretMatch({ rootDir, target: `${DOC}:${line}`, reason: 'x', fingerprint: 'sha256:0000000000000000' }),
      /No match on .* has fingerprint sha256:0000000000000000; nothing was recorded/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('an allow record survives edits elsewhere, a moved document needs a new one, and an unused record is listed', async () => {
  const { tempDir, rootDir } = await createRoot();
  try {
    const sample = join('pass', 'word: hashed', '12');
    const line = await appendToDoc(rootDir, sample);
    const allowed = await allowSecretMatch({ rootDir, target: `${DOC}:${line}`, reason: 'a documented false positive' });
    assert.equal(allowed.record.rule, 'secret-named-assignment');
    const again = await allowSecretMatch({ rootDir, target: `${DOC}:${line}`, reason: 'twice' });
    assert.equal(again.status, 'already-allowed');

    const file = await readFile(path.join(rootDir, SECRET_CHECK_ALLOW_FILE), 'utf8');
    assert.match(file, /^# Matches the VibeCompass secret check reported that are not secrets\./);
    assert.ok(file.includes(`  - path: "${DOC}"\n    rule: secret-named-assignment\n    fingerprint: "${allowed.record.fingerprint}"\n    reason: "a documented false positive"\n`));
    assertNoValue(file, [sample, 'hashed12']);
    assert.equal(parseSecretAllowList(file).records.length, 1);

    // Lines inserted above the match: the record still applies, and a second
    // copy of the same match in the document is covered too.
    const docPath = path.join(rootDir, DOC);
    const text = await readFile(docPath, 'utf8');
    await writeFile(docPath, `${text.replace('## Description', '## Description\n\nOne more line.\n\nAnd another.')}\n${sample}\n`, 'utf8');
    const shifted = await checkProjectMemorySecrets({ rootDir });
    assert.equal(shifted.ok, true);
    assert.equal(shifted.allowedCount, 2);

    // The document moves: the match is refused again and the old record is unused.
    await mkdir(path.join(rootDir, 'architecture/moved'), { recursive: true });
    await rename(docPath, path.join(rootDir, 'architecture/moved/project-shape.md'));
    const moved = await checkProjectMemorySecrets({ rootDir });
    assert.equal(moved.ok, false);
    assert.deepEqual(moved.unallowed.map((match) => match.path), ['architecture/moved/project-shape.md', 'architecture/moved/project-shape.md']);
    assert.deepEqual(moved.unusedAllows, [{ path: DOC, rule: 'secret-named-assignment', fingerprint: allowed.record.fingerprint }]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('--allow refuses a line with no match, a missing, long, multi-line, or key-shaped reason, and a path outside the root', async () => {
  const { tempDir, rootDir } = await createRoot();
  try {
    const line = await appendToDoc(rootDir, join('pass', 'word: hashed', '12'));
    await assert.rejects(allowSecretMatch({ rootDir, target: `${DOC}:1`, reason: 'x' }), /found no match on .*:1; nothing was recorded/);
    await assert.rejects(allowSecretMatch({ rootDir, target: `${DOC}:${line}` }), /--allow needs --reason/);
    await assert.rejects(allowSecretMatch({ rootDir, target: `${DOC}:${line}`, reason: 'a\nb' }), /one line/);
    await assert.rejects(allowSecretMatch({ rootDir, target: `${DOC}:${line}`, reason: 'x'.repeat(301) }), /at most 300/);
    await assert.rejects(
      allowSecretMatch({ rootDir, target: `${DOC}:${line}`, reason: `pasted ${keys.npm[0]}` }),
      (error) => {
        assert.match(error.message, /--reason matches a secret-check rule itself/);
        assertNoValue(error.message, [keys.npm[0]]);
        return true;
      },
    );
    await assert.rejects(allowSecretMatch({ rootDir, target: 'notes/elsewhere.md:1', reason: 'x' }), /is not a canonical document/);
    await assert.rejects(allowSecretMatch({ rootDir, target: DOC, reason: 'x' }), /--allow expects <path>:<line>/);
    await assert.rejects(readFile(path.join(rootDir, SECRET_CHECK_ALLOW_FILE), 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('the allow list fails closed on a malformed record and warns on an unknown key', () => {
  const record = (fields) => `allow:\n  - ${Object.entries(fields).map(([key, value]) => `${key}: "${value}"`).join('\n    ')}\n`;
  const valid = { path: DOC, rule: 'token-npm', fingerprint: 'sha256:0123456789abcdef', reason: 'sample' };
  assert.equal(parseSecretAllowList(record(valid)).records.length, 1);
  assert.throws(() => parseSecretAllowList(record({ ...valid, fingerprint: 'sha256:0123' })), /malformed fingerprint/);
  assert.throws(() => parseSecretAllowList(record({ ...valid, rule: 'actions-secret-reference' })), /unknown rule/);
  assert.throws(() => parseSecretAllowList(record({ path: DOC, rule: 'token-npm', fingerprint: valid.fingerprint })), /needs a non-empty reason/);
  assert.throws(() => parseSecretAllowList('allow: nope\n'), /allow must be a list/);
  assert.deepEqual(parseSecretAllowList(`${record({ ...valid, note: 'x' })}extra: 1\n`).warnings.length, 2);
  assert.deepEqual(parseSecretAllowList('').records, []);
});

test('the setting: block by default, warn and off as set, anything else warns and falls back to block', () => {
  assert.deepEqual(resolveSecretCheckSettings(undefined), { mode: 'block', warnings: [] });
  assert.deepEqual(resolveSecretCheckSettings('warn'), { mode: 'warn', warnings: [] });
  assert.deepEqual(resolveSecretCheckSettings('off'), { mode: 'off', warnings: [] });
  const invalid = resolveSecretCheckSettings('refuse');
  assert.equal(invalid.mode, 'block');
  assert.match(invalid.warnings[0], /metadata\.workflow\.secret_check is "refuse", not block, warn, or off; using block\./);
});

test('push on block: a match no record allows refuses before anything is sent, and the message holds no matched text', async () => {
  const { tempDir, rootDir } = await createRoot();
  try {
    const calls = [];
    const clean = await pushProjectMemory({ rootDir: '.compass' }, pushEnvironment(tempDir, calls));
    assert.equal(calls.length, 1, 'a root with no match pushes');
    assert.equal(clean.secretCheck.ok, true);
    assert.equal(clean.secretCheck.mode, 'block');

    const key = keys.stripeSecret[0];
    const line = await appendToDoc(rootDir, `Paste: ${key}`);
    const manifestBefore = await readFile(path.join(rootDir, 'state/manifest.json'), 'utf8');
    await assert.rejects(
      pushProjectMemory({ rootDir: '.compass' }, pushEnvironment(tempDir, calls)),
      (error) => {
        assert.equal(error.name, 'SecretCheckRefusal');
        assert.match(error.message, /^Secret check: 1 possible secret in 1 document, so nothing was pushed\./);
        assert.ok(error.message.includes(`- ${DOC}:${line} token-legacy`));
        assert.match(error.message, /vibecompass secret-check --allow <path>:<line> --reason "<why>"/);
        assertNoValue(error.message, [key]);
        assertNoValue(JSON.stringify(error.result), [key]);
        return true;
      },
    );
    assert.equal(calls.length, 1, 'nothing was sent');
    const manifestAfter = JSON.parse(await readFile(path.join(rootDir, 'state/manifest.json'), 'utf8'));
    assert.deepEqual(manifestAfter.sync, JSON.parse(manifestBefore).sync, 'the sync cursor did not move');

    // The CLI prints the same refusal through its error path and sends nothing.
    await assert.rejects(
      runCli(['push'], createIo([], []), { cwd: tempDir, env: { SECRET_CHECK_TEST_TOKEN: 't' }, fetch: async () => { throw new Error('unreachable'); } }),
      /nothing was pushed/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('a refused push shows the warning for an invalid setting, which falls back to block', async () => {
  const { tempDir, rootDir } = await createRoot({ secretCheck: 'warning' });
  try {
    await appendToDoc(rootDir, `token note ${keys.npm[0]}`);
    const calls = [];
    await assert.rejects(
      pushProjectMemory({ rootDir: '.compass' }, pushEnvironment(tempDir, calls)),
      /nothing was pushed\.[\s\S]*metadata\.workflow\.secret_check is "warning", not block, warn, or off; using block\./,
    );
    assert.equal(calls.length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('push past an allowed false positive, on warn, and on off', async () => {
  const sample = join('"pass', 'word": "Pass', 'word"');
  {
    const { tempDir, rootDir } = await createRoot();
    try {
      const line = await appendToDoc(rootDir, sample);
      await allowSecretMatch({ rootDir, target: `${DOC}:${line}`, reason: 'a translation label' });
      const calls = [];
      const stdout = [];
      const exitCode = await runCli(['push'], createIo(stdout, []), { cwd: tempDir, env: { SECRET_CHECK_TEST_TOKEN: 't' }, fetch: pushEnvironment(tempDir, calls).runtime.fetch });
      assert.equal(exitCode, 0);
      assert.equal(calls.length, 1);
      assert.ok(calls[0].body.documents.every((document) => document.path !== SECRET_CHECK_ALLOW_FILE), 'the allow file is never pushed');
      assert.match(stdout.join(''), /^Secret check: passed \(\d+ documents; 1 match allowed by secret-check-allow\.yaml\)\nPush: completed/m);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
  {
    const { tempDir, rootDir } = await createRoot({ secretCheck: 'warn' });
    try {
      const key = keys.npm[0];
      const line = await appendToDoc(rootDir, `token note ${key}`);
      const calls = [];
      const stdout = [];
      assert.equal(await runCli(['push'], createIo(stdout, []), { cwd: tempDir, env: { SECRET_CHECK_TEST_TOKEN: 't' }, fetch: pushEnvironment(tempDir, calls).runtime.fetch }), 0);
      assert.equal(calls.length, 1, 'warn uploads anyway');
      const output = stdout.join('');
      assert.match(output, /Secret check \(warn\): 1 possible secret in 1 document; pushed anyway because metadata\.workflow\.secret_check is warn\./);
      assert.ok(output.includes(`- ${DOC}:${line} token-npm`));
      assertNoValue(output, [key]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
  {
    const { tempDir, rootDir } = await createRoot({ secretCheck: 'off' });
    try {
      await appendToDoc(rootDir, `token note ${keys.npm[0]}`);
      const calls = [];
      const stdout = [];
      assert.equal(await runCli(['push'], createIo(stdout, []), { cwd: tempDir, env: { SECRET_CHECK_TEST_TOKEN: 't' }, fetch: pushEnvironment(tempDir, calls).runtime.fetch }), 0);
      assert.equal(calls.length, 1);
      assert.match(stdout.join(''), /^Secret check: off \(metadata\.workflow\.secret_check\)$/m);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
});

test('push on block refuses on an allow list it cannot read; warn pushes and says so', async () => {
  for (const [secretCheck, refuses] of [[undefined, true], ['warn', false]]) {
    const { tempDir, rootDir } = await createRoot(secretCheck ? { secretCheck } : {});
    try {
      await writeFile(path.join(rootDir, SECRET_CHECK_ALLOW_FILE), 'allow:\n  - path: "x.md"\n    rule: nope\n    fingerprint: "sha256:0123456789abcdef"\n    reason: "r"\n', 'utf8');
      const calls = [];
      if (refuses) {
        await assert.rejects(pushProjectMemory({ rootDir: '.compass' }, pushEnvironment(tempDir, calls)), /Secret check: .*unknown rule "nope".* Nothing was pushed\./);
        assert.equal(calls.length, 0);
      } else {
        const result = await pushProjectMemory({ rootDir: '.compass' }, pushEnvironment(tempDir, calls));
        assert.equal(calls.length, 1);
        assert.match(result.secretCheck.warnings.join('\n'), /Secret check \(warn\): .*unknown rule "nope"/);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
});

test('vibecompass secret-check: text and JSON name paths, lines, and rules, exit 1 on a match, and hold no matched text', async () => {
  const { tempDir, rootDir } = await createRoot({ sync: false });
  try {
    const key = keys.google[0];
    const line = await appendToDoc(rootDir, `maps key ${key}`);
    const stdout = [];
    const stderr = [];
    assert.equal(await runCli(['secret-check', '--root', '.compass'], createIo(stdout, stderr), { cwd: tempDir }), 1);
    const text = stdout.join('');
    assert.match(text, /^Secret check: 1 possible secret in 1 document\n/);
    assert.ok(text.includes(`- ${DOC}:${line} token-google\n`));
    assert.match(text, /By rule: token-google 1\n/);
    assert.match(text, /Push setting: metadata\.workflow\.secret_check is block \(the default when unset\)/);
    assertNoValue(text + stderr.join(''), [key]);

    const json = [];
    assert.equal(await runCli(['secret-check', '--root', '.compass', '--json'], createIo(json, []), { cwd: tempDir }), 1);
    const parsed = JSON.parse(json.join(''));
    assert.equal(parsed.ok, false);
    assert.equal(parsed.setting, 'block');
    assert.deepEqual(Object.keys(parsed.matches[0]), ['path', 'line', 'column', 'rule', 'fingerprint', 'allowed']);
    assert.deepEqual(parsed.counts, { 'token-google': { matches: 1, allowed: 0 } });
    assertNoValue(json.join(''), [key]);

    const allowOut = [];
    assert.equal(await runCli(['secret-check', '--root', '.compass', '--allow', `${DOC}:${line}`, '--reason', 'a sample in a doc'], createIo(allowOut, []), { cwd: tempDir }), 0);
    assert.match(allowOut.join(''), new RegExp(`^Allowed ${DOC.replaceAll('.', '\\.')}:${line} token-google sha256:[0-9a-f]{16} in `));
    assertNoValue(allowOut.join(''), [key]);
    const after = [];
    assert.equal(await runCli(['secret-check', '--root', '.compass'], createIo(after, []), { cwd: tempDir }), 0);
    assert.match(after.join(''), /^Secret check: passed \(\d+ documents; 1 match allowed by secret-check-allow\.yaml\)/);

    await assert.rejects(runCli(['secret-check', '--reason', 'x'], createIo([], []), { cwd: tempDir }), /--reason and --fingerprint go with --allow/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('close-session checks the whole root after writing the note and only warns; off skips it', async () => {
  for (const secretCheck of [undefined, 'warn', 'off']) {
    const { tempDir, rootDir } = await createRoot({ sync: false, ...(secretCheck ? { secretCheck } : {}) });
    try {
      await startProjectSession({ cwd: tempDir, rootDir, sessionId: 'pasted-key', workingOn: 'Paste a key by mistake.', date: '2026-11-03' });
      const key = keys.githubInstallation[0];
      const result = await closeProjectSession({
        cwd: tempDir,
        rootDir,
        sessionId: 'pasted-key',
        title: 'Pasted key',
        completed: [`Deployed with ${key}`],
        documentMaintenance: { architectureDocs: 'not-needed', decisionLog: 'not-needed', sessionMaintenance: 'updated' },
        nextSteps: ['Rotate it.'],
        reviewOverride: 'test: no review in this fixture',
      });
      const note = await readFile(result.sessionFilePath, 'utf8');
      assert.ok(note.includes(key), 'close writes the note as given; the check never changes it');
      if (secretCheck === 'off') {
        assert.deepEqual(result.secretCheck, { ran: false, mode: 'off' });
        assert.ok(!result.warnings.some((warning) => warning.startsWith('Secret check')));
      } else {
        assert.equal(result.secretCheck.ok, false);
        assert.equal(result.secretCheck.line, '1 possible secret in 1 document');
        const warnings = result.warnings.filter((warning) => warning.startsWith('Secret check: '));
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], new RegExp(`^Secret check: ${result.sessionRelativePath.replaceAll('.', '\\.')}:\\d+ token-github; `));
        assert.ok(warnings[0].includes(secretCheck === 'warn'
          ? 'push will upload it and report it, because metadata.workflow.secret_check is warn'
          : 'push will refuse until it is removed or allowed'));
        assertNoValue(JSON.stringify({ summary: result.secretCheck, warnings: result.warnings }), [key]);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
});

test('context.md states the secret check, its setting, and the allow command, without decision numbers', () => {
  const render = (secretCheck) => buildWorkflowScaffoldFiles({
    rootDir: '/tmp/unused-root',
    rootRelativePath: '.compass',
    projectConfig: {
      name: 'P',
      mode: 'local-primary',
      repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
      metadata: { workflow: secretCheck ? { secret_check: secretCheck } : {} },
    },
  }).context.content;
  const defaults = render();
  assert.ok(defaults.includes('- secret check: `metadata.workflow.secret_check` is `block` (the default); before `push` uploads anything it checks every canonical document for common key formats'));
  assert.ok(defaults.includes('`vibecompass secret-check --allow <path>:<line> --reason "<why>"`'));
  assert.ok(defaults.includes('`.compass/secret-check-allow.yaml`'));
  assert.ok(render('warn').includes('- secret check: `metadata.workflow.secret_check` is `warn`; before'));
  const secretLines = defaults.split('\n').filter((line) => /secret[ -]check/.test(line));
  assert.equal(secretLines.length, 2);
  for (const line of secretLines) assert.doesNotMatch(line, /\bD-\d{3}\b/);
});
