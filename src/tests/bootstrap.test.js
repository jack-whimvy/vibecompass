import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { runCli } from '../cli.js';
import { initializeProjectMemory } from '../init.js';
import { sha256Text } from '../hash.js';
import { parseSimpleYaml } from '../simple-yaml.js';

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

async function collectCanonicalDocuments(rootDir) {
  const documents = [];
  const projectText = await readFile(path.join(rootDir, 'project.yaml'), 'utf8');
  documents.push({ path: 'project.yaml', kind: 'project', rawText: projectText });

  for (const [dir, kind] of [
    ['architecture', 'architecture'],
    ['decisions', 'decision'],
    ['sessions', 'session'],
  ]) {
    const base = path.join(rootDir, dir);
    let entries = [];
    try {
      entries = await readdir(base, { recursive: true, withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const absolute = path.join(entry.parentPath ?? entry.path, entry.name);
      const relative = path.relative(rootDir, absolute).split(path.sep).join('/');
      if (relative.startsWith('sessions/active/')) continue;
      documents.push({ path: relative, kind, rawText: await readFile(absolute, 'utf8') });
    }
  }
  return documents;
}

function buildBundle(documents, { mode, remoteRevisionId }) {
  return {
    bundle_kind: 'bootstrap_export',
    format_version: 1,
    base_remote_revision: null,
    mode,
    generated_at: '2026-07-06T00:00:00.000Z',
    server_head: {
      remote_revision_id: remoteRevisionId,
      remote_revision: 'rr-test-1',
      manifest_hash: 'sha256:test-server-manifest',
    },
    documents: documents.map((document) => ({
      op: 'write',
      path: document.path,
      kind: document.kind,
      before_content_hash: null,
      after_content_hash: sha256Text(document.rawText),
      byte_length: Buffer.byteLength(document.rawText, 'utf8'),
      raw_text: document.rawText,
    })),
  };
}

const REMOTE_REVISION_ID = '11111111-2222-4333-8444-555555555555';

test('bootstrap materializes a local-primary root and seeds the sync cursor from the bundle head', async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-bootstrap-src-'));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-bootstrap-dst-'));

  try {
    await initializeProjectMemory({
      cwd: sourceDir,
      rootDir: '.compass',
      name: 'Bootstrap Fixture',
      mode: 'local-primary',
      repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
    });
    const connectIo = createIo([], []);
    const connectExit = await runCli(
      [
        'connect-hosted',
        '--root',
        path.join(sourceDir, '.compass'),
        '--sync-api-url',
        'https://vibecompass.example',
        '--sync-project-id',
        'proj-bootstrap',
        '--sync-credential-env-var',
        'VIBECOMPASS_SYNC_TOKEN',
      ],
      connectIo,
      { cwd: sourceDir, env: {} },
    );
    assert.equal(connectExit, 0);

    const documents = await collectCanonicalDocuments(path.join(sourceDir, '.compass'));
    assert.ok(documents.length >= 1);
    const bundlePath = path.join(targetDir, 'bundle.json');
    await writeFile(
      bundlePath,
      JSON.stringify(
        buildBundle(documents, { mode: 'local-primary', remoteRevisionId: REMOTE_REVISION_ID }),
        null,
        2,
      ),
      'utf8',
    );

    const stdout = [];
    const exitCode = await runCli(
      ['bootstrap', '--bundle', bundlePath, '--root', '.compass'],
      createIo(stdout, []),
      { cwd: targetDir, env: {} },
    );
    assert.equal(exitCode, 0);
    const output = stdout.join('');
    assert.match(output, /Bootstrap: bootstrapped/);
    assert.match(output, /seeded the sync cursor/);

    // Files are written verbatim.
    const restoredProject = await readFile(
      path.join(targetDir, '.compass/project.yaml'),
      'utf8',
    );
    assert.equal(restoredProject, documents[0].rawText);

    // Cursor points at the bundle's server head so the first push has the
    // correct parent (no permanent 409 needs_rebase on restored roots).
    const manifest = JSON.parse(
      await readFile(path.join(targetDir, '.compass/state/manifest.json'), 'utf8'),
    );
    const project = parseSimpleYaml(restoredProject, { sourceName: 'project.yaml' });
    const target = project.sync?.default_target;
    const cursor = target ? manifest.sync?.targets?.[target] : manifest.sync;
    assert.equal(cursor?.last_successful_remote_revision, REMOTE_REVISION_ID);
    assert.equal(cursor?.last_sync_direction, 'bootstrap');

    // A root that already has project.yaml refuses a second bootstrap.
    await assert.rejects(
      () =>
        runCli(
          ['bootstrap', '--bundle', bundlePath, '--root', '.compass'],
          createIo([], []),
          { cwd: targetDir, env: {} },
        ),
      /already contains project.yaml/,
    );
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test('bootstrap fails closed on a corrupt bundle without writing any files', async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-bootstrap-src-'));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-bootstrap-dst-'));

  try {
    await initializeProjectMemory({
      cwd: sourceDir,
      rootDir: '.compass',
      name: 'Bootstrap Corrupt Fixture',
      mode: 'local-primary',
      repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
    });
    const documents = await collectCanonicalDocuments(path.join(sourceDir, '.compass'));
    const bundle = buildBundle(documents, {
      mode: 'local-primary',
      remoteRevisionId: REMOTE_REVISION_ID,
    });
    // Corrupt one document after hashing.
    bundle.documents[bundle.documents.length - 1].raw_text += '\ntampered\n';
    const bundlePath = path.join(targetDir, 'bundle.json');
    await writeFile(bundlePath, JSON.stringify(bundle, null, 2), 'utf8');

    await assert.rejects(
      () =>
        runCli(
          ['bootstrap', '--bundle', bundlePath, '--root', '.compass'],
          createIo([], []),
          { cwd: targetDir, env: {} },
        ),
      /content hash does not match/,
    );

    // Fail closed: nothing was materialized.
    await assert.rejects(() =>
      readFile(path.join(targetDir, '.compass/project.yaml'), 'utf8'),
    );
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test('bootstrap of a hosted-only bundle warns about sync and does not seed a cursor', async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-bootstrap-src-'));
  const targetDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-bootstrap-dst-'));

  try {
    await initializeProjectMemory({
      cwd: sourceDir,
      rootDir: '.compass',
      name: 'Bootstrap Hosted Fixture',
      mode: 'hosted-only',
      repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
      sync: {
        apiUrl: 'https://vibecompass.example',
        projectId: 'proj-hosted',
        credentialEnvVar: 'VIBECOMPASS_SYNC_TOKEN',
      },
    });
    const documents = await collectCanonicalDocuments(path.join(sourceDir, '.compass'));
    const bundlePath = path.join(targetDir, 'bundle.json');
    await writeFile(
      bundlePath,
      JSON.stringify(
        buildBundle(documents, { mode: 'hosted-only', remoteRevisionId: REMOTE_REVISION_ID }),
        null,
        2,
      ),
      'utf8',
    );

    const stdout = [];
    const exitCode = await runCli(
      ['bootstrap', '--bundle', bundlePath, '--root', '.compass'],
      createIo(stdout, []),
      { cwd: targetDir, env: {} },
    );
    assert.equal(exitCode, 0);
    const output = stdout.join('');
    assert.match(output, /hosted-only project/);
    assert.doesNotMatch(output, /seeded the sync cursor/);
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});
