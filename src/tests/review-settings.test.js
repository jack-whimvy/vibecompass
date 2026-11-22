import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../cli.js';
import { initializeProjectMemory } from '../init.js';
import { parseSimpleYaml } from '../simple-yaml.js';
import { serializeProjectConfig } from '../project-yaml.js';
import { REVIEW_ROUND_CAP_PROMPT } from '../setup.js';
import { parseRoundCapValue } from '../review-settings.js';
import { resolveWorkflowSettings } from '../workflow.js';

// D-420 item 5: init with the flag; guided setup with an answer and with the
// default; review-settings with a valid value, each kind of invalid value, and
// no flag; and refresh keeping the block.

function captureIo() {
  const out = [];
  const err = [];
  return {
    io: { stdout: { write: (chunk) => out.push(chunk) }, stderr: { write: (chunk) => err.push(chunk) } },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

async function tempWorkspace(t, prefix) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  return tempDir;
}

async function readProject(rootDir) {
  const source = await readFile(path.join(rootDir, 'project.yaml'), 'utf8');
  return { source, config: parseSimpleYaml(source) };
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

const INIT_ARGS = ['init', '--name', 'Cap Project', '--mode', 'local-only', '--repo', 'app=https://github.com/example/app.git', '--root', '.compass'];

test('init --review-round-cap writes metadata.workflow.review.round_cap', async (t) => {
  const tempDir = await tempWorkspace(t, 'vibecompass-cap-init-');
  const capture = captureIo();
  const exitCode = await runCli([...INIT_ARGS, '--review-round-cap', '5'], capture.io, { cwd: tempDir });
  assert.equal(exitCode, 0);
  const { config } = await readProject(path.join(tempDir, '.compass'));
  assert.deepEqual(config.metadata.workflow.review, { round_cap: 5 });
  assert.equal(resolveWorkflowSettings(config).review.roundCap, 5);
  assert.equal(resolveWorkflowSettings(config).review.check, 'warn');
});

test('init without the flag writes no review block, as before', async (t) => {
  const tempDir = await tempWorkspace(t, 'vibecompass-cap-init-none-');
  const exitCode = await runCli(INIT_ARGS, captureIo().io, { cwd: tempDir });
  assert.equal(exitCode, 0);
  const { source, config } = await readProject(path.join(tempDir, '.compass'));
  assert.equal(config.metadata.workflow.review, undefined);
  assert.doesNotMatch(source, /review:/);
});

test('init refuses an invalid --review-round-cap before anything is written', async (t) => {
  for (const value of ['0', '11', '2.5', 'three', '-1', '']) {
    const tempDir = await tempWorkspace(t, 'vibecompass-cap-init-bad-');
    await assert.rejects(
      runCli([...INIT_ARGS, '--review-round-cap', value], captureIo().io, { cwd: tempDir }),
      /--review-round-cap must be a whole number from 1 to 10/,
    );
    assert.equal(await exists(path.join(tempDir, '.compass')), false, `nothing is written for ${JSON.stringify(value)}`);
  }
});

async function guidedInit(t, capAnswers) {
  const tempDir = await tempWorkspace(t, 'vibecompass-cap-guided-');
  const capture = captureIo();
  const prompts = [];
  const answers = new Map([
    ['Project name', 'Guided Cap'],
    ['What should VibeCompass set up?', 'local-only'],
    ['How many repos belong to this logical project?', '1'],
    ['Repo 1 id', 'app'],
    ['Repo 1 remote (blank for local folder)', 'https://github.com/example/app.git'],
    ['Repo 1 default branch', 'main'],
    ['Use primary-repo?', ''],
    ['Directory of the designated primary repo', '.'],
    ['Scaffold workflow files (context.md plus guide READMEs)?', 'no'],
    ['Open the first builder session immediately after init?', 'no'],
  ]);
  const queue = [...capAnswers];
  const exitCode = await runCli(['init', '--guided'], capture.io, {
    cwd: tempDir,
    async prompt(spec) {
      prompts.push(spec.message);
      if (spec.message === REVIEW_ROUND_CAP_PROMPT) {
        assert.equal(spec.defaultValue, '3');
        return queue.shift();
      }
      if (!answers.has(spec.message)) {
        throw new Error(`Unexpected guided prompt: ${spec.message}`);
      }
      return answers.get(spec.message);
    },
  });
  assert.equal(exitCode, 0);
  assert.equal(queue.length, 0, 'every cap answer was asked for');
  return { tempDir, capture, prompts, ...(await readProject(path.join(tempDir, '.compass'))) };
}

test('guided setup asks for the cap, and an answer writes it', async (t) => {
  const result = await guidedInit(t, ['7']);
  assert.ok(result.prompts.includes(REVIEW_ROUND_CAP_PROMPT));
  assert.equal(REVIEW_ROUND_CAP_PROMPT, 'How many review passes run before the builder stops and asks the owner? (1 to 10)');
  assert.deepEqual(result.config.metadata.workflow.review, { round_cap: 7 });
});

test('guided setup: accepting the default writes nothing', async (t) => {
  const result = await guidedInit(t, ['']);
  assert.equal(result.config.metadata.workflow.review, undefined);
  assert.doesNotMatch(result.source, /review:/);
  assert.equal(resolveWorkflowSettings(result.config).review.roundCap, 3);
});

test('guided setup asks again after an invalid answer', async (t) => {
  const result = await guidedInit(t, ['12', 'two', '3']);
  assert.match(result.capture.stdout(), /The review cap must be a whole number from 1 to 10; got 12\./);
  assert.match(result.capture.stdout(), /The review cap must be a whole number from 1 to 10; got "two"\./);
  // An explicit 3 is an answer, so it is written.
  assert.deepEqual(result.config.metadata.workflow.review, { round_cap: 3 });
});

test('guided setup skips the question when --review-round-cap is given', async (t) => {
  const tempDir = await tempWorkspace(t, 'vibecompass-cap-guided-flag-');
  const prompts = [];
  const answers = new Map([
    ['Project name', 'Guided Cap'],
    ['What should VibeCompass set up?', 'local-only'],
    ['How many repos belong to this logical project?', '1'],
    ['Repo 1 id', 'app'],
    ['Repo 1 remote (blank for local folder)', 'https://github.com/example/app.git'],
    ['Repo 1 default branch', 'main'],
    ['Use primary-repo?', ''],
    ['Directory of the designated primary repo', '.'],
    ['Scaffold workflow files (context.md plus guide READMEs)?', 'no'],
    ['Open the first builder session immediately after init?', 'no'],
  ]);
  const exitCode = await runCli(['init', '--guided', '--review-round-cap', '4'], captureIo().io, {
    cwd: tempDir,
    async prompt(spec) {
      prompts.push(spec.message);
      if (!answers.has(spec.message)) {
        throw new Error(`Unexpected guided prompt: ${spec.message}`);
      }
      return answers.get(spec.message);
    },
  });
  assert.equal(exitCode, 0);
  assert.ok(!prompts.includes(REVIEW_ROUND_CAP_PROMPT));
  const { config } = await readProject(path.join(tempDir, '.compass'));
  assert.deepEqual(config.metadata.workflow.review, { round_cap: 4 });
});

async function initRoot(t, { review } = {}) {
  const tempDir = await tempWorkspace(t, 'vibecompass-review-settings-');
  const rootDir = path.join(tempDir, '.compass');
  await initializeProjectMemory({
    cwd: tempDir,
    rootDir,
    name: 'Review Settings Project',
    mode: 'local-only',
    repos: [{ id: 'docs', remote: 'https://github.com/example/docs.git' }],
    bootstrap: { workflow: true, claude: true },
  });
  if (review) {
    const projectPath = path.join(rootDir, 'project.yaml');
    const source = await readFile(projectPath, 'utf8');
    await writeFile(projectPath, source.replace('\n  workflow:\n', `\n  workflow:\n    review:\n${review.map((line) => `      ${line}`).join('\n')}\n`), 'utf8');
  }
  return { tempDir, rootDir };
}

test('review-settings with no flag prints the effective settings and writes nothing', async (t) => {
  const { tempDir, rootDir } = await initRoot(t);
  const before = await readFile(path.join(rootDir, 'project.yaml'), 'utf8');
  const capture = captureIo();
  assert.equal(await runCli(['review-settings', '--root', '.compass'], capture.io, { cwd: tempDir }), 0);
  assert.equal(capture.stdout(), 'Review check: warn\nReview round cap: 3 (default)\n');
  const json = captureIo();
  assert.equal(await runCli(['review-settings', '--root', '.compass', '--json'], json.io, { cwd: tempDir }), 0);
  const parsed = JSON.parse(json.stdout());
  assert.equal(parsed.check, 'warn');
  assert.equal(parsed.round_cap, 3);
  assert.equal(parsed.round_cap_source, 'default');
  assert.equal(parsed.changed, false);
  assert.equal(await readFile(path.join(rootDir, 'project.yaml'), 'utf8'), before);
});

test('review-settings with no flag reports a hand-edited invalid cap with its warning', async (t) => {
  const { tempDir } = await initRoot(t, { review: ['check: block', 'round_cap: 12'] });
  const capture = captureIo();
  assert.equal(await runCli(['review-settings', '--root', '.compass'], capture.io, { cwd: tempDir }), 0);
  assert.match(capture.stdout(), /Review check: block\nReview round cap: 3 \(default \(invalid value ignored\)\)/);
  assert.match(capture.stderr(), /round_cap is 12, not a whole number from 1 to 10; using 3\./);
});

test('review-settings --round-cap writes the key and keeps every other key', async (t) => {
  const { tempDir, rootDir } = await initRoot(t, { review: ['check: block'] });
  const before = (await readProject(rootDir)).config;
  const capture = captureIo();
  assert.equal(await runCli(['review-settings', '--root', '.compass', '--round-cap', '6'], capture.io, { cwd: tempDir }), 0);
  assert.match(capture.stdout(), /Set metadata\.workflow\.review\.round_cap to 6 .* \(was 3\)\./);
  assert.match(capture.stdout(), /The review check uses the new cap at once\. context\.md's Workflow defaults line shows it after the next `vibecompass refresh-workflow --apply`\./);
  const after = (await readProject(rootDir)).config;
  assert.deepEqual(after.metadata.workflow.review, { check: 'block', round_cap: 6 });
  const expected = structuredClone(before);
  expected.metadata.workflow.review.round_cap = 6;
  assert.deepEqual(after, expected);
  assert.equal(resolveWorkflowSettings(after).review.roundCap, 6);
  // No lock directory is left behind.
  assert.equal(await exists(path.join(rootDir, 'state', 'memory-root.lock')), false);

  const again = captureIo();
  assert.equal(await runCli(['review-settings', '--root', '.compass', '--round-cap', '6'], again.io, { cwd: tempDir }), 0);
  assert.match(again.stdout(), /already 6 .*nothing written/);
});

test('review-settings keeps a quoted value that reads like a number, a boolean, or null', async (t) => {
  const { tempDir, rootDir } = await initRoot(t);
  const projectPath = path.join(rootDir, 'project.yaml');
  const source = await readFile(projectPath, 'utf8');
  await writeFile(projectPath, source.replace(/^name: .*$/m, 'name: "2026"\nlabel: "true"'), 'utf8');
  const before = (await readProject(rootDir)).config;
  assert.equal(before.name, '2026');
  assert.equal(before.label, 'true');
  const capture = captureIo();
  assert.equal(await runCli(['review-settings', '--root', '.compass', '--round-cap', '4'], capture.io, { cwd: tempDir }), 0, capture.stderr());
  const after = (await readProject(rootDir));
  assert.equal(after.config.name, '2026');
  assert.equal(after.config.label, 'true');
  assert.match(after.source, /^name: "2026"$/m);
  assert.match(after.source, /^label: "true"$/m);
  const expected = structuredClone(before);
  expected.metadata.workflow.review = { round_cap: 4 };
  assert.deepEqual(after.config, expected);
});

test('the project.yaml writer quotes a string the reader would take for another type', () => {
  const config = { a: '2026', b: 'true', c: 'null', d: '~', e: '-12', f: 'false', g: 7, h: true, i: null, j: 'plain' };
  const written = serializeProjectConfig(config);
  assert.equal(written, 'a: "2026"\nb: "true"\nc: "null"\nd: "~"\ne: "-12"\nf: "false"\ng: 7\nh: true\ni: null\nj: plain\n');
  assert.deepEqual(parseSimpleYaml(written), config);
});

test('review-settings refuses each kind of invalid value and writes nothing', async (t) => {
  const { tempDir, rootDir } = await initRoot(t);
  const before = await readFile(path.join(rootDir, 'project.yaml'), 'utf8');
  for (const value of ['0', '11', '100', '-3', '2.5', '1e1', 'three', ' ', '']) {
    await assert.rejects(
      runCli(['review-settings', '--root', '.compass', '--round-cap', value], captureIo().io, { cwd: tempDir }),
      /--round-cap must be a whole number from 1 to 10/,
      `refuses ${JSON.stringify(value)}`,
    );
  }
  await assert.rejects(runCli(['review-settings', '--root', '.compass', '--round-cap'], captureIo().io, { cwd: tempDir }), /requires a value/);
  assert.equal(await readFile(path.join(rootDir, 'project.yaml'), 'utf8'), before);
});

test('parseRoundCapValue takes whole numbers 1 to 10 only', () => {
  assert.equal(parseRoundCapValue('1'), 1);
  assert.equal(parseRoundCapValue('10'), 10);
  assert.equal(parseRoundCapValue(' 4 '), 4);
  assert.equal(parseRoundCapValue(5), 5);
  assert.throws(() => parseRoundCapValue('010x'), /whole number/);
});

test('refresh-workflow keeps a review block review-settings wrote, and writes none itself', async (t) => {
  const { tempDir, rootDir } = await initRoot(t);
  assert.equal(await runCli(['review-settings', '--root', '.compass', '--round-cap', '5'], captureIo().io, { cwd: tempDir }), 0);
  const projectPath = path.join(rootDir, 'project.yaml');
  // An older stamp makes --update-package-stamp rewrite project.yaml.
  await writeFile(projectPath, (await readFile(projectPath, 'utf8')).replace(/package_version: .*/, 'package_version: 0.1.0'), 'utf8');
  const capture = captureIo();
  assert.equal(await runCli(['refresh-workflow', '--root', '.compass', '--apply', '--update-package-stamp'], capture.io, { cwd: tempDir }), 0);
  assert.match(capture.stdout(), /project\.yaml: stamp-update/);
  const { config } = await readProject(rootDir);
  assert.deepEqual(config.metadata.workflow.review, { round_cap: 5 });
  const context = await readFile(path.join(rootDir, 'context.md'), 'utf8');
  assert.match(context, /review round cap: `metadata\.workflow\.review\.round_cap` is 5/);

  // A root without the block stays without one through a refresh.
  const bare = await initRoot(t);
  const bareProject = path.join(bare.rootDir, 'project.yaml');
  await writeFile(bareProject, (await readFile(bareProject, 'utf8')).replace(/package_version: .*/, 'package_version: 0.1.0'), 'utf8');
  assert.equal(await runCli(['refresh-workflow', '--root', '.compass', '--apply', '--update-package-stamp'], captureIo().io, { cwd: bare.tempDir }), 0);
  assert.doesNotMatch(await readFile(bareProject, 'utf8'), /review:/);
});
