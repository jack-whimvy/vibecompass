import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeProjectMemory } from '../init.js';
import { runCli } from '../cli.js';
import {
  closeProjectSession,
  listProjectSessions,
  startProjectSession,
  switchProjectSession,
  writeLaneMarkerForSession,
} from '../session.js';
import { planDocsUpdate } from '../docs-update.js';
import { writeStateManifest } from '../manifest.js';
import { LANE_MARKER_FILENAME, readLaneMarker } from '../lane-marker.js';

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

async function createInitializedRoot(prefix) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const rootDir = path.join(tempDir, '.compass');
  await initializeProjectMemory({
    cwd: tempDir,
    rootDir,
    name: 'Lane Marker Test',
    mode: 'local-only',
    repos: [{ id: 'docs', remote: 'https://github.com/example/docs.git' }],
    bootstrap: {
      workflow: true,
      claude: true,
    },
  });
  return { tempDir, rootDir };
}

async function startLane(tempDir, id, workingOn = `Working on ${id}`) {
  return startProjectSession({ cwd: tempDir, sessionId: id, workingOn });
}

async function handWriteMarker(dir, fields) {
  const markerPath = path.join(dir, LANE_MARKER_FILENAME);
  await writeFile(
    markerPath,
    [
      `format_version: ${fields.formatVersion ?? 1}`,
      `lane_id: ${fields.laneId}`,
      `memory_root: ${JSON.stringify(fields.memoryRoot)}`,
      `token: ${JSON.stringify(fields.token ?? 'hand-token')}`,
      'created_at: 2026-07-02T20:00:00-07:00',
      'created_by: "test"',
      '',
    ].join('\n'),
    'utf8',
  );
  return markerPath;
}

test('write-lane-marker + close-session resolve root and lane from a worktree cwd with no --root or --session', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-marker-infer-');

  try {
    await startLane(tempDir, 'lane-a');
    await startLane(tempDir, 'lane-b');

    const worktreeDir = path.join(tempDir, 'worktrees', 'lane-a', 'docs');
    await mkdir(worktreeDir, { recursive: true });
    const markerResult = await writeLaneMarkerForSession({
      cwd: tempDir,
      sessionId: 'lane-a',
      dir: worktreeDir,
    });
    assert.equal(markerResult.markerPath, path.join(worktreeDir, LANE_MARKER_FILENAME));

    const sessionYaml = await readFile(path.join(rootDir, 'sessions/active/lane-a/session.yaml'), 'utf8');
    assert.match(sessionYaml, /^lane_marker:$/m);
    assert.match(sessionYaml, /^ {2}token: "/m);

    // Neither --root nor --session: the marker supplies both, from a cwd
    // where cwd/.compass does not exist.
    const result = await closeProjectSession({
      cwd: worktreeDir,
      ...CLOSE_DEFAULTS,
    });
    assert.equal(result.sessionId, 'lane-a');
    assert.equal(result.rootDir, rootDir);

    const remaining = await listProjectSessions({ rootDir });
    assert.deepEqual(remaining.lanes.map((lane) => lane.id), ['lane-b']);
    // Token-matched marker cleanup at close.
    assert.equal(existsSync(markerResult.markerPath), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('write-lane-marker refuses ancestor, equal, and inside-root targets; accepts a disjoint sibling', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-marker-guard-');

  try {
    await startLane(tempDir, 'lane-a');

    // Ancestor: the workspace root contains .compass.
    await assert.rejects(
      writeLaneMarkerForSession({ cwd: tempDir, sessionId: 'lane-a', dir: tempDir }),
      /contains the project-memory root/,
    );
    // Equal to the memory root.
    await assert.rejects(
      writeLaneMarkerForSession({ cwd: tempDir, sessionId: 'lane-a', dir: rootDir }),
      /equals the project-memory root/,
    );
    // Inside the memory root.
    await assert.rejects(
      writeLaneMarkerForSession({ cwd: tempDir, sessionId: 'lane-a', dir: path.join(rootDir, 'sessions') }),
      /inside the project-memory root/,
    );

    const sibling = path.join(tempDir, 'wt');
    await mkdir(sibling, { recursive: true });
    const result = await writeLaneMarkerForSession({ cwd: tempDir, sessionId: 'lane-a', dir: sibling });
    assert.equal(existsSync(result.markerPath), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('a stale marker fails closed even when a single-lane fallback would have succeeded', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-marker-stale-');

  try {
    await startLane(tempDir, 'lane-a');
    const staleDir = path.join(tempDir, 'wt');
    await mkdir(staleDir, { recursive: true });
    const markerPath = await handWriteMarker(staleDir, { laneId: 'ghost-lane', memoryRoot: rootDir });

    await assert.rejects(
      closeProjectSession({ cwd: staleDir, ...CLOSE_DEFAULTS }),
      (error) => {
        assert.match(error.message, /names lane "ghost-lane"/);
        assert.ok(error.message.includes(markerPath), 'stale-marker error must name the marker path');
        assert.match(error.message, /stale markers fail closed/);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('a marker bound to a different memory root is ignored with a warning under an explicit --root', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-marker-mismatch-');

  try {
    await startLane(tempDir, 'lane-a');
    const wtDir = path.join(tempDir, 'wt');
    await mkdir(wtDir, { recursive: true });
    await handWriteMarker(wtDir, { laneId: 'lane-a', memoryRoot: path.join(tempDir, 'elsewhere', '.compass') });

    // Explicit --root disagrees with the marker's memory_root: the marker is
    // ignored (warning) and the single-lane fallback resolves the lane. No
    // --tooling-root either — the CLAUDE.md-less worktree cwd recovers from
    // the explicit root's placement.
    const result = await closeProjectSession({
      cwd: wtDir,
      rootDir,
      ...CLOSE_DEFAULTS,
    });
    assert.equal(result.sessionId, 'lane-a');
    assert.ok(result.warnings.some((warning) => /binds to memory root/.test(warning)), 'expected a mismatched-root warning');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('an explicit --session overrides a resolvable marker with a warning naming both lanes', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-marker-override-');

  try {
    await startLane(tempDir, 'lane-a');
    await startLane(tempDir, 'lane-b');
    const wtDir = path.join(tempDir, 'wt');
    await mkdir(wtDir, { recursive: true });
    await writeLaneMarkerForSession({ cwd: tempDir, sessionId: 'lane-a', dir: wtDir });

    const result = await closeProjectSession({
      cwd: wtDir,
      sessionId: 'lane-b',
      ...CLOSE_DEFAULTS,
    });
    assert.equal(result.sessionId, 'lane-b');
    const overrideWarning = result.warnings.find((warning) => /overrides the lane marker/.test(warning));
    assert.ok(overrideWarning, 'expected a flag-vs-marker warning');
    assert.match(overrideWarning, /lane-b/);
    assert.match(overrideWarning, /marker lane: lane-a/);

    const remaining = await listProjectSessions({ rootDir });
    assert.deepEqual(remaining.lanes.map((lane) => lane.id), ['lane-a']);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('a stale index pointer is never reported as current with 2+ lanes and never cached into the manifest', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-stale-pointer-');

  try {
    await startLane(tempDir, 'lane-a');
    await startLane(tempDir, 'lane-b');
    const indexPath = path.join(rootDir, 'sessions/active/index.yaml');
    await writeFile(indexPath, 'current: ghost-lane\nlanes: []\n', 'utf8');

    const sessions = await listProjectSessions({ rootDir });
    assert.equal(sessions.current, null);
    assert.deepEqual(sessions.lanes.map((lane) => lane.id), ['lane-a', 'lane-b']);

    const { manifest } = await writeStateManifest(rootDir);
    assert.equal(manifest.active_sessions.current, null);
    assert.equal(manifest.active_sessions.lanes.length, 2);

    // With exactly one lane, a stale pointer degrades to the single lane.
    await closeProjectSession({ rootDir, cwd: tempDir, sessionId: 'lane-b', ...CLOSE_DEFAULTS });
    await writeFile(indexPath, 'current: ghost-lane\nlanes: []\n', 'utf8');
    const single = await listProjectSessions({ rootDir });
    assert.equal(single.current, 'lane-a');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('closing the current lane with 2+ survivors nulls the pointer and renders a neutral multi-lane block', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-close-survivors-');

  try {
    await startLane(tempDir, 'lane-a');
    await startLane(tempDir, 'lane-b');
    await startLane(tempDir, 'lane-c');

    // lane-c is current (started last). Close it: two survivors remain, so
    // no lane may be promoted implicitly (D-277).
    const result = await closeProjectSession({ cwd: tempDir, sessionId: 'lane-c', ...CLOSE_DEFAULTS });
    assert.equal(result.sessionId, 'lane-c');

    const index = await readFile(path.join(rootDir, 'sessions/active/index.yaml'), 'utf8');
    assert.match(index, /^current: null$/m);

    const claude = await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8');
    assert.match(claude, /Active lanes:/);
    assert.match(claude, /- lane-a — Working on lane-a/);
    assert.match(claude, /- lane-b — Working on lane-b/);
    assert.doesNotMatch(claude, /\[selected\]/);
    assert.match(claude, /Multiple lanes remain active/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('closing a non-current lane under a stale pointer repairs the pointer instead of crashing mid-close', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-close-stale-pointer-');

  try {
    await startLane(tempDir, 'lane-a');
    await startLane(tempDir, 'lane-b');
    await startLane(tempDir, 'lane-c');
    const indexPath = path.join(rootDir, 'sessions/active/index.yaml');
    const index = await readFile(indexPath, 'utf8');
    await writeFile(indexPath, index.replace(/^current: .*$/m, 'current: ghost-lane'), 'utf8');

    // Previously this threw AFTER deleting the lane directory (partial
    // close); now the stale pointer is repaired to null with 2+ survivors.
    const result = await closeProjectSession({ cwd: tempDir, sessionId: 'lane-b', ...CLOSE_DEFAULTS });
    assert.equal(result.sessionId, 'lane-b');

    const rewritten = await readFile(indexPath, 'utf8');
    assert.match(rewritten, /^current: null$/m);

    const remaining = await listProjectSessions({ rootDir });
    assert.deepEqual(remaining.lanes.map((lane) => lane.id), ['lane-a', 'lane-c']);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('closing the current lane with exactly one survivor still promotes the survivor', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-close-promote-');

  try {
    await startLane(tempDir, 'lane-a');
    await startLane(tempDir, 'lane-b');

    const result = await closeProjectSession({ cwd: tempDir, sessionId: 'lane-b', ...CLOSE_DEFAULTS });
    assert.equal(result.sessionId, 'lane-b');

    const index = await readFile(path.join(rootDir, 'sessions/active/index.yaml'), 'utf8');
    assert.match(index, /^current: lane-a$/m);

    const claude = await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8');
    assert.match(claude, /lane lane-a/);
    assert.doesNotMatch(claude, /Active lanes:/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('docs-update refuses the root-global pointer with 2+ lanes and resolves via a marker instead', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-docs-update-parity-');

  try {
    await startLane(tempDir, 'lane-a');
    await startLane(tempDir, 'lane-b');

    // No --session, no marker: parity with close-session (no silent index
    // fallback at 2+ lanes).
    await assert.rejects(
      planDocsUpdate({ cwd: tempDir, rootDir }),
      /Multiple active session lanes exist. Pass --session/,
    );

    const wtDir = path.join(tempDir, 'wt');
    await mkdir(wtDir, { recursive: true });
    await writeLaneMarkerForSession({ cwd: tempDir, sessionId: 'lane-b', dir: wtDir });

    const plan = await planDocsUpdate({ cwd: wtDir });
    assert.equal(plan.session?.id, 'lane-b');
    assert.equal(plan.rootDir, rootDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('starting a second lane renders the derived multi-lane block with the new lane selected', async () => {
  const { tempDir } = await createInitializedRoot('vibecompass-multi-lane-block-');

  try {
    await startLane(tempDir, 'lane-a');
    let claude = await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8');
    assert.doesNotMatch(claude, /Active lanes:/);

    await startLane(tempDir, 'lane-b');
    claude = await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8');
    assert.match(claude, /Active lanes:/);
    assert.match(claude, /- lane-a — Working on lane-a/);
    assert.match(claude, /- lane-b — Working on lane-b \[selected\]/);
    // The five-field parse contract stays intact in the multi-lane shape.
    for (const label of ['Date:', 'Working on:', 'Last thing completed:', 'Blockers:', 'Next session should:']) {
      assert.ok(claude.includes(label), `block must keep the "${label}" label`);
    }

    // Parse round-trip: starting a third lane re-parses the multi-lane block
    // (to carry lastThingCompleted forward) and must not corrupt or duplicate
    // the block, and the lane bullets must not pollute the parsed fields.
    await startLane(tempDir, 'lane-c');
    claude = await readFile(path.join(tempDir, 'CLAUDE.md'), 'utf8');
    assert.equal(claude.match(/Active lanes:/g)?.length, 1, 'exactly one Active lanes section');
    assert.equal(claude.match(/## Current session/g)?.length, 1, 'exactly one Current session heading');
    assert.match(claude, /- lane-c — Working on lane-c \[selected\]/);
    assert.match(claude, /^Working on: Working on lane-c \[lane-c\]$/m);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runCli write-lane-marker smoke: writes the marker, records it, and warns inside git work trees', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-marker-cli-');

  try {
    await startLane(tempDir, 'lane-a');
    const wtDir = path.join(tempDir, 'wt');
    await mkdir(path.join(wtDir, '.git'), { recursive: true });

    const stdout = [];
    const stderr = [];
    const io = {
      stdout: { write(chunk) { stdout.push(chunk); } },
      stderr: { write(chunk) { stderr.push(chunk); } },
    };
    const exitCode = await runCli(['write-lane-marker', '--session', 'lane-a', '--dir', wtDir], io, { cwd: tempDir });
    assert.equal(exitCode, 0);
    assert.match(stdout.join(''), /Wrote lane marker for "lane-a"/);
    assert.match(stderr.join(''), /git work tree/);
    assert.equal(existsSync(path.join(wtDir, LANE_MARKER_FILENAME)), true);

    const sessionYaml = await readFile(path.join(rootDir, 'sessions/active/lane-a/session.yaml'), 'utf8');
    assert.match(sessionYaml, /^lane_marker:$/m);

    await assert.rejects(
      runCli(['write-lane-marker', '--dir', wtDir], io, { cwd: tempDir }),
      /write-lane-marker requires --session/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('concurrent write-lane-marker calls for one lane serialize to a single recorded marker', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-marker-race-');

  try {
    await startLane(tempDir, 'lane-a');
    const dirOne = path.join(tempDir, 'wt-one');
    const dirTwo = path.join(tempDir, 'wt-two');
    await mkdir(dirOne, { recursive: true });
    await mkdir(dirTwo, { recursive: true });

    await Promise.all([
      writeLaneMarkerForSession({ cwd: tempDir, sessionId: 'lane-a', dir: dirOne }),
      writeLaneMarkerForSession({ cwd: tempDir, sessionId: 'lane-a', dir: dirTwo }),
    ]);

    const markerOneExists = existsSync(path.join(dirOne, LANE_MARKER_FILENAME));
    const markerTwoExists = existsSync(path.join(dirTwo, LANE_MARKER_FILENAME));
    assert.equal(markerOneExists !== markerTwoExists, true, 'exactly one marker file must survive (at most one live marker per lane)');

    const sessionYaml = await readFile(path.join(rootDir, 'sessions/active/lane-a/session.yaml'), 'utf8');
    const survivingDir = markerOneExists ? dirOne : dirTwo;
    assert.ok(
      sessionYaml.includes(JSON.stringify(path.join(survivingDir, LANE_MARKER_FILENAME))),
      'session.yaml must record the surviving marker path',
    );
    assert.equal(sessionYaml.match(/^lane_marker:$/gm)?.length, 1, 'exactly one lane_marker block');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('an explicit --session naming a non-active lane fails closed in docs-update and close-session', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-ghost-session-');

  try {
    await startLane(tempDir, 'lane-a');

    // Previously docs-update caught the missing session.yaml and planned for
    // a synthetic ghost session; now the shared resolver fails closed.
    await assert.rejects(
      planDocsUpdate({ cwd: tempDir, rootDir, sessionId: 'ghost-lane' }),
      /Session lane "ghost-lane" is not an active lane/,
    );
    await assert.rejects(
      closeProjectSession({ cwd: tempDir, sessionId: 'ghost-lane', ...CLOSE_DEFAULTS }),
      /Session lane "ghost-lane" is not an active lane/,
    );

    // The real lane still resolves.
    const plan = await planDocsUpdate({ cwd: tempDir, rootDir, sessionId: 'lane-a' });
    assert.equal(plan.session?.id, 'lane-a');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('write-lane-marker warns when an enclosing marker binds a different lane', async () => {
  const { tempDir } = await createInitializedRoot('vibecompass-marker-context-warn-');

  try {
    await startLane(tempDir, 'lane-a');
    await startLane(tempDir, 'lane-b');
    const laneADir = path.join(tempDir, 'wt-a');
    const laneBDir = path.join(tempDir, 'wt-b');
    await mkdir(laneADir, { recursive: true });
    await mkdir(laneBDir, { recursive: true });
    await writeLaneMarkerForSession({ cwd: tempDir, sessionId: 'lane-a', dir: laneADir });

    // Running from inside lane-a's marker context while binding lane-b: the
    // command proceeds but warns naming both lanes (D-280).
    const result = await writeLaneMarkerForSession({ cwd: laneADir, sessionId: 'lane-b', dir: laneBDir });
    const warning = result.warnings.find((entry) => /overrides the lane marker/.test(entry));
    assert.ok(warning, 'expected the flag-vs-marker disagreement warning');
    assert.match(warning, /--session lane-b/);
    assert.match(warning, /marker lane: lane-a/);

    // Both lanes keep their own markers: lane-a's context marker is not the
    // lane-b marker's recorded predecessor, so nothing is removed.
    assert.equal(existsSync(path.join(laneADir, LANE_MARKER_FILENAME)), true);
    assert.equal(existsSync(path.join(laneBDir, LANE_MARKER_FILENAME)), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('a corrupt marker fails closed, and passing both --root and --session bypasses it with a warning', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-marker-corrupt-');

  try {
    await startLane(tempDir, 'lane-a');
    const wtDir = path.join(tempDir, 'wt');
    await mkdir(wtDir, { recursive: true });
    await writeFile(path.join(wtDir, LANE_MARKER_FILENAME), 'lane_id: [broken\n\t:::\n', 'utf8');

    // Fail closed without flags, even though a single-lane fallback exists.
    await assert.rejects(
      closeProjectSession({ cwd: wtDir, ...CLOSE_DEFAULTS }),
      /not valid marker YAML/,
    );

    // Both flags are the documented escape hatch — and it must stand alone:
    // no --tooling-root, from a worktree cwd with no CLAUDE.md (the tooling
    // root recovers from the explicit root's placement).
    const result = await closeProjectSession({
      cwd: wtDir,
      rootDir,
      sessionId: 'lane-a',
      ...CLOSE_DEFAULTS,
    });
    assert.equal(result.sessionId, 'lane-a');
    assert.ok(
      result.warnings.some((warning) => /Ignored because --root and --session were provided/.test(warning)),
      'expected the corrupt-marker bypass warning',
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('readLaneMarker rejects unsupported format_version, relative memory_root, and missing token', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-marker-schema-');

  try {
    const wtDir = path.join(tempDir, 'wt');
    await mkdir(wtDir, { recursive: true });

    let markerPath = await handWriteMarker(wtDir, { laneId: 'lane-a', memoryRoot: rootDir, formatVersion: 2 });
    await assert.rejects(readLaneMarker(markerPath), /unsupported format_version 2/);

    markerPath = await handWriteMarker(wtDir, { laneId: 'lane-a', memoryRoot: 'relative/.compass' });
    await assert.rejects(readLaneMarker(markerPath), /memory_root as an absolute path/);

    await writeFile(
      markerPath,
      `format_version: 1\nlane_id: lane-a\nmemory_root: ${JSON.stringify(rootDir)}\n`,
      'utf8',
    );
    await assert.rejects(readLaneMarker(markerPath), /missing its token/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('close-session leaves a token-mismatched marker in place with a warning', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-marker-token-mismatch-');

  try {
    await startLane(tempDir, 'lane-a');
    const wtDir = path.join(tempDir, 'wt');
    await mkdir(wtDir, { recursive: true });
    const { markerPath } = await writeLaneMarkerForSession({ cwd: tempDir, sessionId: 'lane-a', dir: wtDir });

    // Hand-replace the marker with a different token: the recorded token no
    // longer matches, so guarded removal must leave it in place and report.
    await handWriteMarker(wtDir, { laneId: 'lane-a', memoryRoot: rootDir, token: 'foreign-token' });

    const result = await closeProjectSession({ cwd: tempDir, rootDir, sessionId: 'lane-a', ...CLOSE_DEFAULTS });
    assert.ok(
      result.warnings.some((warning) => /left in place: its token does not match/.test(warning)),
      'expected the token-mismatch warning',
    );
    assert.equal(existsSync(markerPath), true, 'non-matching marker must survive close');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('marker root inference targets the CLAUDE.md inside a dedicated-memory-repo root', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-dedicated-root-'));

  try {
    // Dedicated-memory-repo placement: the memory root IS the owner dir and
    // CLAUDE.md lives inside it, so dirname(root) holds no CLAUDE.md at all.
    const memoryRepoDir = path.join(tempDir, 'project-memory');
    await mkdir(memoryRepoDir, { recursive: true });
    await initializeProjectMemory({
      cwd: memoryRepoDir,
      rootDir: memoryRepoDir,
      name: 'Dedicated Root Test',
      mode: 'local-only',
      repos: [{ id: 'docs', remote: 'https://github.com/example/docs.git' }],
      bootstrap: { workflow: true, claude: true },
    });
    await startProjectSession({ cwd: memoryRepoDir, rootDir: memoryRepoDir, sessionId: 'lane-a', workingOn: 'Dedicated placement' });

    const wtDir = path.join(tempDir, 'wt');
    await mkdir(wtDir, { recursive: true });
    await writeLaneMarkerForSession({ cwd: memoryRepoDir, rootDir: memoryRepoDir, sessionId: 'lane-a', dir: wtDir });

    const result = await closeProjectSession({ cwd: wtDir, ...CLOSE_DEFAULTS });
    assert.equal(result.sessionId, 'lane-a');
    assert.equal(result.claudePath, path.join(memoryRepoDir, 'CLAUDE.md'));

    const claude = await readFile(path.join(memoryRepoDir, 'CLAUDE.md'), 'utf8');
    assert.match(claude, /Session closed\. Ready for the next builder session\./);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('switch-session warns when the enclosing marker binds a different lane', async () => {
  const { tempDir } = await createInitializedRoot('vibecompass-switch-marker-warn-');

  try {
    await startLane(tempDir, 'lane-a');
    await startLane(tempDir, 'lane-b');
    const wtDir = path.join(tempDir, 'wt');
    await mkdir(wtDir, { recursive: true });
    await writeLaneMarkerForSession({ cwd: tempDir, sessionId: 'lane-a', dir: wtDir });

    const result = await switchProjectSession({ cwd: wtDir, sessionId: 'lane-b' });
    assert.equal(result.current, 'lane-b');
    const warning = result.warnings.find((entry) => /overrides the lane marker/.test(entry));
    assert.ok(warning, 'expected the switch-session disagreement warning');
    assert.match(warning, /marker lane: lane-a/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('write-lane-marker replaces a foreign lane marker with a warning, and token-matching protects the foreign lane at close', async () => {
  const { tempDir, rootDir } = await createInitializedRoot('vibecompass-marker-replace-');

  try {
    await startLane(tempDir, 'lane-a');
    await startLane(tempDir, 'lane-b');
    const wtDir = path.join(tempDir, 'wt');
    await mkdir(wtDir, { recursive: true });
    await writeLaneMarkerForSession({ cwd: tempDir, sessionId: 'lane-a', dir: wtDir });

    // User-accepted semantics (2026-07-03): rebinding an already-marked
    // directory to another lane is warn-and-replace, not a --force gate.
    const rebind = await writeLaneMarkerForSession({ cwd: tempDir, rootDir, sessionId: 'lane-b', dir: wtDir });
    assert.ok(
      rebind.warnings.some((warning) => /Replaced the marker at .* previously bound to lane "lane-a"/.test(warning)),
      'expected the foreign-replacement warning',
    );
    const marker = await readLaneMarker(path.join(wtDir, LANE_MARKER_FILENAME));
    assert.equal(marker.laneId, 'lane-b');

    // Downstream protection: lane-a's recorded token no longer matches the
    // on-disk marker, so closing lane-a reports and leaves lane-b's marker.
    const closeResult = await closeProjectSession({ cwd: tempDir, rootDir, sessionId: 'lane-a', ...CLOSE_DEFAULTS });
    assert.ok(
      closeResult.warnings.some((warning) => /left in place: its token does not match/.test(warning)),
      'expected the token-mismatch report at close',
    );
    assert.equal((await readLaneMarker(path.join(wtDir, LANE_MARKER_FILENAME))).laneId, 'lane-b');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('close-session at 2+ lanes without a selection names both escape hatches', async () => {
  const { tempDir } = await createInitializedRoot('vibecompass-multi-lane-error-');

  try {
    await startLane(tempDir, 'lane-a');
    await startLane(tempDir, 'lane-b');

    await assert.rejects(
      closeProjectSession({ cwd: tempDir, ...CLOSE_DEFAULTS }),
      (error) => {
        assert.match(error.message, /Multiple active session lanes exist. Pass --session/);
        assert.match(error.message, /worktree lane marker/);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
