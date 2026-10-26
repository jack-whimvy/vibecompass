import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { initializeProjectMemory } from '../init.js';
import { runCli } from '../cli.js';

// D-399: text the package installs or prints names none of the package's own
// decisions by number. A number names a decision only in the root that
// allocated it (D-276), so in another project it points at that project's own
// log. Each citation lives in a code comment at the text instead (comments
// aren't scanned here), and format examples that show the install's own
// numbering, such as the `### D-001 — Example decision` headings, are allowed.
const ALLOWED_EXAMPLES = new Set(['D-001']);
const CITATION = /D-\d{3,}/g;
const PACKAGE_DIR = fileURLToPath(new URL('../../', import.meta.url));
const FIRST_UNNUMBERED_RELEASE = [0, 18, 0];

function citationsIn(text) {
  return (text.match(CITATION) ?? []).filter((id) => !ALLOWED_EXAMPLES.has(id));
}

function captureIo() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (chunk) => stdout.push(chunk) },
      stderr: { write: (chunk) => stderr.push(chunk) },
    },
  };
}

const REGEX_AFTER_WORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await',
]);

/**
 * The text of every string and template literal in a JavaScript source, with
 * its line: comments, regular expression literals, and code are skipped, and a
 * template's `${…}` expressions are read as code (nested templates included).
 */
function stringLiterals(source) {
  const literals = [];
  const braceDepths = [];
  let i = 0;
  let previous = null;

  const lineAt = (index) => source.slice(0, index).split('\n').length;
  const regexMayStart = () => {
    if (!previous) return true;
    if (previous.kind === 'punct') return ![')', ']', '}'].includes(previous.value);
    if (previous.kind === 'word') return REGEX_AFTER_WORD.has(previous.value);
    return false;
  };
  const readTemplate = (start) => {
    while (i < source.length) {
      const char = source[i];
      if (char === '\\') {
        i += 2;
      } else if (char === '`') {
        literals.push({ text: source.slice(start, i), line: lineAt(start) });
        i += 1;
        previous = { kind: 'literal' };
        return;
      } else if (char === '$' && source[i + 1] === '{') {
        literals.push({ text: source.slice(start, i), line: lineAt(start) });
        i += 2;
        braceDepths.push(0);
        previous = { kind: 'punct', value: '{' };
        return;
      } else {
        i += 1;
      }
    }
    literals.push({ text: source.slice(start), line: lineAt(start) });
  };

  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
    } else if (char === '#' && next === '!' && i === 0) {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (char === '"' || char === "'") {
      const start = i + 1;
      i += 1;
      while (i < source.length && source[i] !== char && source[i] !== '\n') {
        i += source[i] === '\\' ? 2 : 1;
      }
      literals.push({ text: source.slice(start, i), line: lineAt(start) });
      i += 1;
      previous = { kind: 'literal' };
    } else if (char === '`') {
      i += 1;
      readTemplate(i);
    } else if (char === '/' && regexMayStart()) {
      let inClass = false;
      i += 1;
      while (i < source.length && source[i] !== '\n' && (inClass || source[i] !== '/')) {
        if (source[i] === '\\') i += 1;
        else if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        i += 1;
      }
      i += 1;
      while (i < source.length && /[a-z]/i.test(source[i])) i += 1;
      previous = { kind: 'literal' };
    } else if (char === '{') {
      if (braceDepths.length > 0) braceDepths[braceDepths.length - 1] += 1;
      previous = { kind: 'punct', value: char };
      i += 1;
    } else if (char === '}') {
      if (braceDepths.length > 0 && braceDepths[braceDepths.length - 1] === 0) {
        braceDepths.pop();
        i += 1;
        readTemplate(i);
        continue;
      }
      if (braceDepths.length > 0) braceDepths[braceDepths.length - 1] -= 1;
      previous = { kind: 'punct', value: char };
      i += 1;
    } else if (/\s/.test(char)) {
      i += 1;
    } else if (/[A-Za-z_$]/.test(char)) {
      const start = i;
      while (i < source.length && /[\w$]/.test(source[i])) i += 1;
      previous = { kind: 'word', value: source.slice(start, i) };
    } else if (/[0-9]/.test(char)) {
      while (i < source.length && /[\w.]/.test(source[i])) i += 1;
      previous = { kind: 'number' };
    } else {
      previous = { kind: 'punct', value: char };
      i += 1;
    }
  }
  return literals;
}

function citationsInSource(source) {
  return stringLiterals(source).flatMap(({ text, line }) => citationsIn(text).map((id) => ({ id, line })));
}

async function listJsFiles(directory, recursive) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory() && recursive) files.push(...await listJsFiles(entryPath, true));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(entryPath);
  }
  return files;
}

/** The shipped JavaScript files, from package.json "files". */
async function shippedSourceFiles() {
  const manifest = JSON.parse(await readFile(path.join(PACKAGE_DIR, 'package.json'), 'utf8'));
  const files = new Set();
  for (const pattern of manifest.files) {
    if (!pattern.endsWith('.js')) continue;
    const match = /^(.*?)\/(\*\*\/)?\*\.js$/.exec(pattern);
    assert.ok(match, `package.json "files" pattern ${pattern} has a shape this test can't expand`);
    for (const file of await listJsFiles(path.join(PACKAGE_DIR, match[1]), Boolean(match[2]))) {
      files.add(path.relative(PACKAGE_DIR, file));
    }
  }
  return [...files].sort();
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

test('the citation check catches a number planted in a string or template literal, and skips comments and regexes', () => {
  const planted = [
    "const refusal = 'Multiple lanes are active (D-277).'; // D-353",
    '/* D-392 */ const hint = `resume ${laneId} (D-282) or ${`nested D-395`}`;',
    'const pattern = /D-\\d{3}/;',
    "const example = '### D-001 — Example decision';",
  ].join('\n');
  assert.deepEqual(citationsInSource(planted), [
    { id: 'D-277', line: 1 },
    { id: 'D-282', line: 2 },
    { id: 'D-395', line: 2 },
  ]);
  assert.deepEqual(citationsIn('Lane selection follows D-277.\n### D-001 — Example decision'), ['D-277']);
});

test('rendered installed text names no package decision number: context.md, the guides, the READMEs, and every managed block', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-citations-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Citation Project',
      mode: 'local-only',
      repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
      closeSessionGitPublish: true,
      closeSessionGitRemote: 'origin',
      generatedAt: new Date('2026-10-25T08:00:00Z'),
      bootstrap: { workflow: true, claude: true, agents: true },
    });
    const { io } = captureIo();
    assert.equal(await runCli(['sync-agents', '--root', '.compass'], io, { cwd: tempDir }), 0);

    const rendered = [
      '.compass/context.md',
      '.compass/workflows/project-manager.md',
      '.compass/workflows/docs-review.md',
      '.compass/architecture/README.md',
      '.compass/decisions/README.md',
      '.compass/sessions/README.md',
      '.compass/decisions/EXAMPLE.md',
      'CLAUDE.md',
      'AGENTS.md',
      '.cursorrules',
      '.github/copilot-instructions.md',
    ];
    for (const relativePath of rendered) {
      const text = await readFile(path.join(tempDir, relativePath), 'utf8');
      assert.deepEqual(citationsIn(text), [], `${relativePath} names a package decision by number`);
    }

    // The allowed example is the install's own numbering, and it is still shown.
    const decisionsGuide = await readFile(path.join(rootDir, 'decisions/README.md'), 'utf8');
    assert.match(decisionsGuide, /^### D-001 — Example decision$/m);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('help names no package decision number', async () => {
  const { stdout, io } = captureIo();
  assert.equal(await runCli(['--help'], io, {}), 0);
  assert.deepEqual(citationsIn(stdout.join('')), []);
});

test('string literals in the shipped source name no package decision number', async () => {
  const files = await shippedSourceFiles();
  assert.ok(files.includes('src/cli.js') && files.includes('src/workflows/registry.js') && files.includes('src/generators/agent-files/template.js'));
  const found = [];
  for (const file of files) {
    const source = await readFile(path.join(PACKAGE_DIR, file), 'utf8');
    for (const { id, line } of citationsInSource(source)) found.push(`${file}:${line} ${id}`);
  }
  assert.deepEqual(found, [], 'move each citation into a code comment at its text and state the rule');
});

test('the README and CHANGELOG entries from 0.18.0 name no package decision number; older entries keep theirs under the note', async () => {
  const readme = await readFile(path.join(PACKAGE_DIR, 'README.md'), 'utf8');
  assert.deepEqual(citationsIn(readme), [], 'README.md names a package decision by number');

  const changelog = await readFile(path.join(PACKAGE_DIR, 'CHANGELOG.md'), 'utf8');
  const [preamble, ...sections] = changelog.split(/^(?=## )/m);
  assert.match(preamble.replace(/\s+/g, ' '), /Entries before 0\.18\.0 cite decisions by number\. Those decisions are in the VibeCompass project's own decision log, which is private, not in your project's log\./);
  for (const section of sections) {
    const heading = section.slice(0, section.indexOf('\n'));
    const version = /^## (\d+)\.(\d+)\.(\d+)\b/.exec(heading);
    if (version && compareVersions(version.slice(1).map(Number), FIRST_UNNUMBERED_RELEASE) < 0) continue;
    assert.deepEqual(citationsIn(section), [], `CHANGELOG.md "${heading}" names a package decision by number`);
  }
});
