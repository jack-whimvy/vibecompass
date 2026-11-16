import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeProjectMemory } from '../init.js';
import { runCli } from '../cli.js';
import { buildSessionNoteSlug, closeProjectSession, SESSION_NOTE_SLUG_MAX_LENGTH, startProjectSession } from '../session.js';

// A long title shortens the note's file name to 80 slug characters while the
// note's heading keeps the whole title (D-411 item 2).

const CLOSE_DEFAULTS = {
  completed: ['Did the work'],
  nextSteps: ['Continue'],
  documentMaintenance: { architectureDocs: 'not-needed', decisionLog: 'not-needed', sessionMaintenance: 'not-needed' },
};

async function createRoot(prefix) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const rootDir = path.join(tempDir, '.compass');
  await initializeProjectMemory({
    cwd: tempDir,
    rootDir,
    name: 'Note Name Test',
    mode: 'local-only',
    repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
    bootstrap: { workflow: true, claude: true },
  });
  return { tempDir, rootDir };
}

// A title whose slug is `words` five-letter words joined by hyphens.
function titleOfWords(words, last = 'final') {
  return [...Array.from({ length: words - 1 }, (_, index) => `w${String(index).padStart(3, '0')}x`), last].join(' ');
}

async function noteNames(rootDir) {
  return (await readdir(path.join(rootDir, 'sessions'))).filter((name) => /^\d{4}-\d{2}-\d{2}-\d+-/.test(name) && !name.includes('project-memory-initialized'));
}

test('the slug cap is 80 characters, cut at the last hyphen at or before it, or at 80 when no hyphen comes earlier', () => {
  assert.equal(SESSION_NOTE_SLUG_MAX_LENGTH, 80);

  const exact = 'a'.repeat(80);
  assert.deepEqual(buildSessionNoteSlug(exact), { slug: exact, shortened: false });

  // 16 five-letter words: 16 * 5 + 15 hyphens = 95 characters.
  const long = buildSessionNoteSlug(titleOfWords(16));
  assert.equal(long.shortened, true);
  assert.ok(long.slug.length <= 80);
  assert.equal(long.slug, titleOfWords(16).toLowerCase().split(' ').slice(0, 13).join('-'));
  assert.ok(!long.slug.endsWith('-'));

  const oneWord = buildSessionNoteSlug('x'.repeat(120));
  assert.deepEqual(oneWord, { slug: 'x'.repeat(80), shortened: true });

  // Punctuation runs become one hyphen before the cut, and a cut never leaves one at the end.
  const punctuated = buildSessionNoteSlug(`${'abcd, '.repeat(20)}end`);
  assert.equal(punctuated.shortened, true);
  assert.match(punctuated.slug, /^(abcd-)*abcd$/);
  assert.ok(punctuated.slug.length <= 80);

  assert.deepEqual(buildSessionNoteSlug('Short Title'), { slug: 'short-title', shortened: false });
});

test('close-session shortens a long title in the file name, keeps the whole title in the heading, and says so', async () => {
  const { tempDir, rootDir } = await createRoot('vibecompass-note-long-');
  try {
    // 300 characters of title: today's 255-byte name limit would refuse it.
    const title = `${titleOfWords(49)} ${'z'.repeat(50)}`;
    await startProjectSession({ cwd: tempDir, sessionId: 'lane-a', workingOn: 'Long title' });
    const result = await closeProjectSession({ cwd: tempDir, sessionId: 'lane-a', title, ...CLOSE_DEFAULTS });

    assert.equal(result.sessionFileNameShortened, true);
    const fileName = path.basename(result.sessionFilePath);
    const slug = fileName.replace(/^\d{4}-\d{2}-\d{2}-\d+-/, '').replace(/\.md$/, '');
    assert.ok(slug.length <= 80, `slug is ${slug.length} characters`);
    assert.ok(Buffer.byteLength(fileName) < 255);
    const note = await readFile(result.sessionFilePath, 'utf8');
    assert.equal(note.split('\n')[0], `# Session — ${result.sessionDate}-${result.sessionNumber} — ${title}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('a title at the cap keeps its whole slug and prints no shortening line', async () => {
  const { tempDir, rootDir } = await createRoot('vibecompass-note-cap-');
  try {
    const title = 'q'.repeat(80);
    await startProjectSession({ cwd: tempDir, sessionId: 'lane-a', workingOn: 'At the cap' });
    const out = [];
    const io = { stdout: { write: (chunk) => out.push(chunk) }, stderr: { write() {} } };
    const code = await runCli([
      'close-session', '--root', rootDir, '--session', 'lane-a', '--title', title, '--completed', 'Done', '--next-step', 'Next',
      '--architecture-docs', 'not-needed', '--decision-log', 'not-needed', '--session-maintenance', 'not-needed',
    ], io, { cwd: tempDir });
    assert.equal(code, 0);
    assert.deepEqual(await noteNames(rootDir), [`${out.join('').match(/Closed session (\S+)/)[1]}-${title}.md`]);
    assert.doesNotMatch(out.join(''), /shortened/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('the CLI prints that it shortened the file name', async () => {
  const { tempDir, rootDir } = await createRoot('vibecompass-note-cli-');
  try {
    await startProjectSession({ cwd: tempDir, sessionId: 'lane-a', workingOn: 'CLI' });
    const out = [];
    const io = { stdout: { write: (chunk) => out.push(chunk) }, stderr: { write() {} } };
    const code = await runCli([
      'close-session', '--root', rootDir, '--session', 'lane-a', '--title', titleOfWords(30), '--completed', 'Done', '--next-step', 'Next',
      '--architecture-docs', 'not-needed', '--decision-log', 'not-needed', '--session-maintenance', 'not-needed',
    ], io, { cwd: tempDir });
    assert.equal(code, 0);
    assert.match(out.join(''), /The title was shortened to 80 characters in the note's file name; the note's heading keeps the whole title\./);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('two long titles that differ only at the end get distinct note names through their session numbers', async () => {
  const { tempDir, rootDir } = await createRoot('vibecompass-note-distinct-');
  try {
    const first = titleOfWords(30, 'alpha');
    const second = titleOfWords(30, 'omega');
    await startProjectSession({ cwd: tempDir, sessionId: 'lane-a', workingOn: 'First' });
    await startProjectSession({ cwd: tempDir, sessionId: 'lane-b', workingOn: 'Second' });
    const a = await closeProjectSession({ cwd: tempDir, sessionId: 'lane-a', title: first, ...CLOSE_DEFAULTS });
    const b = await closeProjectSession({ cwd: tempDir, sessionId: 'lane-b', title: second, ...CLOSE_DEFAULTS });

    const slugOf = (filePath) => path.basename(filePath).replace(/^\d{4}-\d{2}-\d{2}-\d+-/, '');
    assert.equal(slugOf(a.sessionFilePath), slugOf(b.sessionFilePath), 'the shortened slugs are the same');
    assert.notEqual(a.sessionFilePath, b.sessionFilePath, 'the session numbers keep the names apart');
    assert.equal((await noteNames(rootDir)).length, 2);
    assert.match((await readFile(a.sessionFilePath, 'utf8')).split('\n')[0], / — w000x .* alpha$/);
    assert.match((await readFile(b.sessionFilePath, 'utf8')).split('\n')[0], / — w000x .* omega$/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
