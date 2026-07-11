import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCli } from '../cli.js';
import { initializeProjectMemory } from '../init.js';
import { detectChangelogShapedLines, scanProjectMemory } from '../index.js';
import { buildCloseSessionGuidance, resolveWorkflowSettings } from '../workflow.js';

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/changelog-calibration');
const UNCONDITIONAL_CLOSE_LINE =
  'Architecture docs keep current behavior plus the durable plan, unresolved next steps, and material rollout state — fold changes in place, never dated session sections; session notes keep work chronology and close-out next steps; decisions keep accepted choices and rationale; transient lane scratch drains into the session note at close (D-292, D-293).';

test('changelog-calibration fixture matrix: six smelly docs warn once each, controls stay quiet', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-calibration-'));

  try {
    await writeFile(
      path.join(tempDir, 'project.yaml'),
      [
        'format_version: 1',
        'name: Calibration Root',
        'mode: local-only',
        'repos:',
        '  - id: app',
        '    remote: https://github.com/example/app.git',
        '',
      ].join('\n'),
      'utf8',
    );
    const architectureDir = path.join(tempDir, 'architecture/product/calibration');
    await mkdir(architectureDir, { recursive: true });
    for (const name of await readdir(FIXTURE_DIR)) {
      await writeFile(path.join(architectureDir, name), await readFile(path.join(FIXTURE_DIR, name), 'utf8'), 'utf8');
    }

    const scan = await scanProjectMemory(tempDir);
    const architectureDocs = scan.documents.filter((document) => document.kind === 'architecture');
    const byName = new Map(
      architectureDocs.map((document) => [
        path.basename(document.path),
        document.warnings.filter((warning) => warning.code === 'architecture-changelog-smell'),
      ]),
    );

    assert.equal(scan.errors.length, 0);
    assert.equal(architectureDocs.length, 9);
    const flagged = Array.from(byName.entries()).filter(([, warnings]) => warnings.length > 0);
    assert.deepEqual(
      flagged.map(([name]) => name).sort(),
      [
        'smelly-audit-deepening.md',
        'smelly-dated-fixes-heading.md',
        'smelly-mixed-signals.md',
        'smelly-track-phase-shipped.md',
        'smelly-updated-lead-in.md',
        'smelly-updated-parenthetical.md',
      ],
    );
    for (const [name, warnings] of flagged) {
      assert.equal(warnings.length, 1, `${name} must aggregate to exactly one warning`);
    }
    assert.match(byName.get('smelly-mixed-signals.md')[0].message, /3 changelog-shaped line\(s\)/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('detectChangelogShapedLines masks Markdown correctly', () => {
  const fourBacktickOuterFence = [
    '````md',
    '## Audit deepening — 2026-07-07 (verified)',
    '```',
    'Updated 2026-07-08 (inner fence line, still inside the outer fence):',
    '```',
    '````',
    '## Audit deepening — 2026-07-09 (verified)',
  ].join('\n');
  assert.deepEqual(detectChangelogShapedLines(fourBacktickOuterFence), [
    '## Audit deepening — 2026-07-09 (verified)',
  ]);

  const tildeFenceWithBacktickContent = [
    '~~~',
    '``` (a backtick fence marker as tilde-fence content must not toggle)',
    '## Audit deepening — 2026-07-07 (verified)',
    '~~~',
  ].join('\n');
  assert.deepEqual(detectChangelogShapedLines(tildeFenceWithBacktickContent), []);

  const doubleBacktickInline = 'Header note ``Updated 2026-07-08 with a ` tick`` reference:';
  assert.deepEqual(detectChangelogShapedLines(doubleBacktickInline), []);

  const blockquotedLeadIn = '> Updated 2026-07-08 (lane `hotfixes`, D-004):';
  assert.deepEqual(detectChangelogShapedLines(blockquotedLeadIn), []);

  // A same-character run with a trailing info string is fence CONTENT, not a
  // closer — only a whitespace-only remainder closes (CommonMark).
  const sameRunWithInfo = [
    '```',
    '````md',
    '## Audit deepening — 2026-07-07 (verified)',
    '```',
    '## Audit deepening — 2026-07-09 (verified)',
  ].join('\n');
  assert.deepEqual(detectChangelogShapedLines(sameRunWithInfo), [
    '## Audit deepening — 2026-07-09 (verified)',
  ]);

  // Indented code lines are literal content.
  const indentedCode = [
    '    ## Audit deepening — 2026-07-07 (verified)',
    '\tUpdated 2026-07-08 (lane `hotfixes`, D-004):',
  ].join('\n');
  assert.deepEqual(detectChangelogShapedLines(indentedCode), []);

  // An ATX heading interrupts a paragraph (CommonMark), so a stray backtick
  // in the preceding paragraph can never mask a real heading.
  const headingInterruptsParagraph = [
    'Paragraph with a stray ` backtick that never closes',
    '## Audit deepening — 2026-07-07 (verified)',
  ].join('\n');
  assert.deepEqual(detectChangelogShapedLines(headingInterruptsParagraph), [
    '## Audit deepening — 2026-07-07 (verified)',
  ]);

  // A code span that spans lines WITHIN one paragraph masks a dated-updated
  // continuation line.
  const sameParagraphMultilineSpan = [
    'Config example: `span opens here',
    'Updated 2026-07-08 still inside the span` trailing text:',
  ].join('\n');
  assert.deepEqual(detectChangelogShapedLines(sameParagraphMultilineSpan), []);

  // Code spans take precedence over comment tokens: a literal `<!--` in
  // inline code must not leak comment state and hide later headings.
  const literalCommentToken = [
    'Inline `<!--` stays code, not a comment opener.',
    '## Audit deepening — 2026-07-07 (verified)',
  ].join('\n');
  assert.deepEqual(detectChangelogShapedLines(literalCommentToken), [
    '## Audit deepening — 2026-07-07 (verified)',
  ]);

  // A fence opener's info string is never inline-parsed: a `<!--` there must
  // not open comment state; the fence itself still masks its content.
  const fenceInfoCommentToken = [
    '~~~ info <!-- not a comment opener',
    '## Audit deepening — 2026-07-07 (verified)',
    '~~~',
    '## Audit deepening — 2026-07-09 (verified)',
  ].join('\n');
  assert.deepEqual(detectChangelogShapedLines(fenceInfoCommentToken), [
    '## Audit deepening — 2026-07-09 (verified)',
  ]);

  // Tabs advance to 4-column stops: a tab-indented pseudo-closer is fence
  // content (closers allow at most 3 columns), not a close.
  const tabIndentedPseudoCloser = [
    '```',
    '\t```',
    '## Audit deepening — 2026-07-07 (verified)',
    '```',
    '## Audit deepening — 2026-07-09 (verified)',
  ].join('\n');
  assert.deepEqual(detectChangelogShapedLines(tabIndentedPseudoCloser), [
    '## Audit deepening — 2026-07-09 (verified)',
  ]);

  // Space-plus-tab reaches 4 columns: indented code, whether it looks like a
  // dated heading or a fence marker.
  assert.deepEqual(detectChangelogShapedLines(' \t## Audit deepening — 2026-07-07 (verified)'), []);
  const spaceTabFenceMarker = [
    ' \t```',
    '## Audit deepening — 2026-07-07 (verified)',
  ].join('\n');
  assert.deepEqual(detectChangelogShapedLines(spaceTabFenceMarker), [
    '## Audit deepening — 2026-07-07 (verified)',
  ]);

  // A fence opened as the first content of a list item masks its content.
  const listContainedFence = [
    '- ```',
    '  ## Audit deepening — 2026-07-07 (verified)',
    '  ```',
    '## Audit deepening — 2026-07-09 (verified)',
  ].join('\n');
  assert.deepEqual(detectChangelogShapedLines(listContainedFence), [
    '## Audit deepening — 2026-07-09 (verified)',
  ]);

  // An unclosed list-child fence ends with its enclosing item; the exiting
  // root heading is real.
  const unclosedListFence = [
    '- ```',
    '  fence content without a closer',
    '## Audit deepening — 2026-07-07 (verified)',
  ].join('\n');
  assert.deepEqual(detectChangelogShapedLines(unclosedListFence), [
    '## Audit deepening — 2026-07-07 (verified)',
  ]);

  // Content indent derives from marker width + padding: a nine-digit ordered
  // marker gives an eleven-column content indent, so an eleven-space closer
  // is zero relative columns and valid.
  const wideOrderedMarkerFence = [
    '123456789. ```',
    '           ## Audit deepening — 2026-07-07 (verified)',
    '           ```',
    '## Audit deepening — 2026-07-09 (verified)',
  ].join('\n');
  assert.deepEqual(detectChangelogShapedLines(wideOrderedMarkerFence), [
    '## Audit deepening — 2026-07-09 (verified)',
  ]);

  // A seven-space pseudo-closer under a simple bullet is five RELATIVE
  // columns in — fence content, not a close.
  const relativeCloserBound = [
    '- ```',
    '       ```',
    '  ## Audit deepening — 2026-07-07 (verified)',
    '  ```',
    '## Audit deepening — 2026-07-09 (verified)',
  ].join('\n');
  assert.deepEqual(detectChangelogShapedLines(relativeCloserBound), [
    '## Audit deepening — 2026-07-09 (verified)',
  ]);

  // An outdented fence marker after an unclosed list-child fence exits the
  // container and is reprocessed as a NEW root fence, not consumed as the
  // child's closer.
  const outdentedFenceReprocessed = [
    '- ```',
    '```',
    '## Audit deepening — 2026-07-07 (verified)',
    '```',
    '## Audit deepening — 2026-07-09 (verified)',
  ].join('\n');
  assert.deepEqual(detectChangelogShapedLines(outdentedFenceReprocessed), [
    '## Audit deepening — 2026-07-09 (verified)',
  ]);

  // A list-contained HTML comment masks its lines until -->.
  const listContainedComment = [
    '- <!--',
    '  ## Audit deepening — 2026-07-07 (verified)',
    '  -->',
    '## Audit deepening — 2026-07-09 (verified)',
  ].join('\n');
  assert.deepEqual(detectChangelogShapedLines(listContainedComment), [
    '## Audit deepening — 2026-07-09 (verified)',
  ]);

  // An ordered marker other than 1 does not interrupt an open paragraph: its
  // backticks pair within the paragraph and mask the dated lead-in.
  const orderedNonOneContinuation = [
    'Plain prose line opening a paragraph',
    '2. has a tick `',
    'Updated 2026-07-08 (lane x) trailing:',
    'closing tick ` end.',
  ].join('\n');
  assert.deepEqual(detectChangelogShapedLines(orderedNonOneContinuation), []);

  // A bullet DOES interrupt the prose paragraph, but the unindented lines
  // after it are lazy continuations of the item's own paragraph — item text
  // is non-signal, so nothing warns.
  const bulletLazyAfterInterrupt = [
    'Plain prose line opening a paragraph',
    '- has a tick `',
    'Updated 2026-07-08 (lane x) trailing:',
    'closing tick ` end.',
  ].join('\n');
  assert.deepEqual(detectChangelogShapedLines(bulletLazyAfterInterrupt), []);

  // Direct lazy continuation: an unindented dated update line immediately
  // after a list item stays inside that item's paragraph.
  assert.deepEqual(
    detectChangelogShapedLines(['- item text', 'Updated 2026-07-08 (lane x) trailing:'].join('\n')),
    [],
  );
  assert.deepEqual(
    detectChangelogShapedLines(['1. item text', 'Updated 2026-07-08 (lane x) trailing:'].join('\n')),
    [],
  );

  // A blank line ends the item paragraph, so laziness stops and the next
  // under-indented dated line is a real root paragraph.
  const blankEndsLaziness = [
    'Plain prose',
    '- item',
    '',
    'Updated 2026-07-08 (lane x) trailing:',
  ].join('\n');
  assert.deepEqual(detectChangelogShapedLines(blankEndsLaziness), [
    'Updated 2026-07-08 (lane x) trailing:',
  ]);

  // An EMPTY marker cannot interrupt an open paragraph: `-` alone is
  // paragraph text, so the backticks around it pair and mask the lead-in.
  const emptyMarkerNoInterrupt = [
    'Prose ` tick',
    '-',
    'Updated 2026-07-08 ` trailing:',
  ].join('\n');
  assert.deepEqual(detectChangelogShapedLines(emptyMarkerNoInterrupt), []);

  // Ordered interruption is by start VALUE: `01.` is start 1 and interrupts,
  // so its backtick belongs to the new item, not the old paragraph, and the
  // following dated line is the item's lazy continuation (non-signal).
  const leadingZeroInterrupts = [
    'Prose ` tick',
    '01. closes ` here',
    'Updated 2026-07-08 (lane x) trailing:',
  ].join('\n');
  assert.deepEqual(detectChangelogShapedLines(leadingZeroInterrupts), []);

  // A heading inside a list item is a non-persistent child block: it closes
  // the item paragraph, so the following under-indented dated line exits the
  // container and is a real root lead-in.
  const headingClosesItemParagraph = [
    '- item text',
    '  ## Item heading',
    'Updated 2026-07-08 (lane x) trailing:',
  ].join('\n');
  assert.deepEqual(detectChangelogShapedLines(headingClosesItemParagraph), [
    'Updated 2026-07-08 (lane x) trailing:',
  ]);

  // A complete one-line HTML comment inside a list item likewise leaves no
  // open paragraph for lazy continuation.
  const oneLineCommentClosesItemParagraph = [
    '- item text',
    '  <!-- note -->',
    'Updated 2026-07-08 (lane x) trailing:',
  ].join('\n');
  assert.deepEqual(detectChangelogShapedLines(oneLineCommentClosesItemParagraph), [
    'Updated 2026-07-08 (lane x) trailing:',
  ]);

  // An EMPTY sibling marker inside an open list is a new (empty) item, not a
  // lazy continuation — it ends the previous item's paragraph, so the next
  // under-indented dated line is a real root lead-in. Bullet and ordered.
  const emptySiblingItem = [
    '- item text',
    '-',
    'Updated 2026-07-08 (lane x) trailing:',
  ].join('\n');
  assert.deepEqual(detectChangelogShapedLines(emptySiblingItem), [
    'Updated 2026-07-08 (lane x) trailing:',
  ]);
  const emptyOrderedSibling = [
    '1. item text',
    '2.',
    'Updated 2026-07-08 (lane x) trailing:',
  ].join('\n');
  assert.deepEqual(detectChangelogShapedLines(emptyOrderedSibling), [
    'Updated 2026-07-08 (lane x) trailing:',
  ]);

  // A heading as the marker line's own content also leaves no open item
  // paragraph.
  const markerLineHeading = [
    '- ## Item heading',
    'Updated 2026-07-08 (lane x) trailing:',
  ].join('\n');
  assert.deepEqual(detectChangelogShapedLines(markerLineHeading), [
    'Updated 2026-07-08 (lane x) trailing:',
  ]);

  // BARE ATX headings (hashes followed by end of line) are valid headings at
  // every paragraph boundary: root paragraphs, marker lines, and container
  // content all close on them.
  const bareHeadingRootBoundary = [
    'Prose ` tick',
    '##',
    'Updated 2026-07-08 ` trailing:',
  ].join('\n');
  assert.deepEqual(detectChangelogShapedLines(bareHeadingRootBoundary), [
    'Updated 2026-07-08 ` trailing:',
  ]);
  assert.deepEqual(
    detectChangelogShapedLines(['- ##', 'Updated 2026-07-08 (lane x) trailing:'].join('\n')),
    ['Updated 2026-07-08 (lane x) trailing:'],
  );
  assert.deepEqual(
    detectChangelogShapedLines(['- item', '  ##', 'Updated 2026-07-08 (lane x) trailing:'].join('\n')),
    ['Updated 2026-07-08 (lane x) trailing:'],
  );

  // More than four padding columns after a marker means the item starts with
  // child INDENTED CODE (one column is list padding): no item paragraph
  // opens, so the following outdented update is a real root lead-in.
  assert.deepEqual(
    detectChangelogShapedLines(['-     code', 'Updated 2026-07-08 (lane x) trailing:'].join('\n')),
    ['Updated 2026-07-08 (lane x) trailing:'],
  );
  assert.deepEqual(
    detectChangelogShapedLines(['1.     code', 'Updated 2026-07-08 (lane x) trailing:'].join('\n')),
    ['Updated 2026-07-08 (lane x) trailing:'],
  );
  assert.deepEqual(
    detectChangelogShapedLines(['-\t\tcode', 'Updated 2026-07-08 (lane x) trailing:'].join('\n')),
    ['Updated 2026-07-08 (lane x) trailing:'],
  );

  // Any valid marker at root position (columns 0-3) closes the current item
  // — even empty markers of a DIFFERENT type; type only decides old list vs
  // new list (CommonMark reference behavior). The following update is
  // therefore a real root paragraph in all three cross-type shapes.
  assert.deepEqual(
    detectChangelogShapedLines(['- item', '2.', 'Updated 2026-07-08 (lane x) trailing:'].join('\n')),
    ['Updated 2026-07-08 (lane x) trailing:'],
  );
  assert.deepEqual(
    detectChangelogShapedLines(['- item', '+', 'Updated 2026-07-08 (lane x) trailing:'].join('\n')),
    ['Updated 2026-07-08 (lane x) trailing:'],
  );
  assert.deepEqual(
    detectChangelogShapedLines(['1. item', '2)', 'Updated 2026-07-08 (lane x) trailing:'].join('\n')),
    ['Updated 2026-07-08 (lane x) trailing:'],
  );

  // Under a padded or wide marker, a candidate below the content indent but
  // at 4+ absolute columns cannot start any root block — it stays lazy item
  // text while the item paragraph is open (ATX, list, fence, comment, and
  // blockquote lookalikes alike).
  for (const lookalike of ['    ##', '    2.', '    ```', '    <!--', '    > quote']) {
    assert.deepEqual(
      detectChangelogShapedLines(['-    item', lookalike, 'Updated 2026-07-08 (lane x) trailing:'].join('\n')),
      [],
      `expected lazy retention for ${JSON.stringify(lookalike)}`,
    );
  }
  assert.deepEqual(
    detectChangelogShapedLines(['123456789. item', '    2.', 'Updated 2026-07-08 (lane x) trailing:'].join('\n')),
    [],
  );

  // CRLF and lone-CR input must behave identically to LF input for the
  // exported helper: bare-ATX boundaries still split paragraphs, fences
  // still mask their dated content, and list laziness still holds.
  assert.deepEqual(
    detectChangelogShapedLines(['Prose ` tick', '##', 'Updated 2026-07-08 ` trailing:'].join('\r\n')),
    ['Updated 2026-07-08 ` trailing:'],
  );
  assert.deepEqual(
    detectChangelogShapedLines(['```', '## Audit deepening — 2026-07-07 (verified)', '```'].join('\r\n')),
    [],
  );
  assert.deepEqual(
    detectChangelogShapedLines(['- item text', 'Updated 2026-07-08 (lane x) trailing:'].join('\r\n')),
    [],
  );
  assert.deepEqual(
    detectChangelogShapedLines(['- item text', 'Updated 2026-07-08 (lane x) trailing:'].join('\r')),
    [],
  );

  // Indented code cannot interrupt an open paragraph: a 4-space or
  // tab-indented dated update line after prose is paragraph continuation and
  // stays visible to the line-local grammar.
  assert.deepEqual(
    detectChangelogShapedLines(['Ordinary prose line', '    Updated 2026-07-08 (lane x) trailing:'].join('\n')),
    ['Updated 2026-07-08 (lane x) trailing:'],
  );
  assert.deepEqual(
    detectChangelogShapedLines(['Ordinary prose line', '\tUpdated 2026-07-08 (lane x) trailing:'].join('\n')),
    ['Updated 2026-07-08 (lane x) trailing:'],
  );

  // Source-ordered inline masking: a comment containing a backtick masks
  // FIRST, so that backtick cannot pair with later code and hide the date.
  const commentBeforeCode = '## Audit deepening <!-- ` --> — 2026-07-07 shipped `x`';
  assert.deepEqual(detectChangelogShapedLines(commentBeforeCode), [commentBeforeCode]);

  // A backslash-escaped backtick is not a code delimiter: the dated cue text
  // after it stays visible.
  const escapedBacktick = '## Audit \\` updated 2026-07-07 ` done';
  assert.deepEqual(detectChangelogShapedLines(escapedBacktick), [escapedBacktick]);

  // A fence marker inside a multiline HTML comment must not open fence state
  // and hide real content after the comment.
  const fenceMarkerInsideComment = [
    '<!--',
    '```',
    '-->',
    '## Audit deepening — 2026-07-07 (verified)',
  ].join('\n');
  assert.deepEqual(detectChangelogShapedLines(fenceMarkerInsideComment), [
    '## Audit deepening — 2026-07-07 (verified)',
  ]);

  // A backtick opener whose info string contains a backtick is not a fence
  // opener at all (CommonMark), so the following line stays visible.
  const invalidBacktickOpener = [
    '``` has `backtick` info',
    '## Audit deepening — 2026-07-07 (verified)',
  ].join('\n');
  assert.deepEqual(detectChangelogShapedLines(invalidBacktickOpener), [
    '## Audit deepening — 2026-07-07 (verified)',
  ]);
});

test('inline masking stays bounded on adversarial unmatched backtick runs', () => {
  // Strictly increasing run lengths never pair, forcing a closer scan per
  // run. ~450 runs over ~100 KB must complete quickly; this guards the
  // helper's complexity before hosted/untrusted input consumes it.
  const parts = [];
  for (let length = 1; parts.join('').length < 100_000; length += 1) {
    parts.push('`'.repeat(length), ' x ');
  }
  const adversarial = parts.join('');
  const startedAt = process.hrtime.bigint();
  detectChangelogShapedLines(adversarial);
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  assert.ok(elapsedMs < 1500, `adversarial masking took ${elapsedMs}ms`);
});

test('explicit non-string or empty content_mode warns instead of silently passing', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-content-mode-'));

  try {
    await writeFile(
      path.join(tempDir, 'project.yaml'),
      [
        'format_version: 1',
        'name: Content Mode Edge Root',
        'mode: local-only',
        'repos:',
        '  - id: app',
        '    remote: https://github.com/example/app.git',
        '',
      ].join('\n'),
      'utf8',
    );
    const architectureDir = path.join(tempDir, 'architecture/product/edge');
    await mkdir(architectureDir, { recursive: true });
    const docWithContentMode = (component, contentModeLine, detailsLines) => [
      '---',
      'domain: Product',
      'feature: Edge',
      `component: ${component}`,
      'status: In progress',
      'repo: app',
      contentModeLine,
      '---',
      '',
      '## Description',
      'Edge fixture.',
      '',
      '## Review metadata',
      '- Evidence: `app:src/edge/index.ts`',
      '- Blindspots: None identified for this fixture.',
      '',
      '## Details',
      ...detailsLines,
      '',
      '## Retrieval guidance',
      '- Use only for content_mode validation tests.',
      '- It does not describe runtime behavior.',
      '',
      '## Next steps',
      '- None.',
      '',
      '## Involved files',
      '- `app:src/edge/index.ts`',
      '',
    ].join('\n');

    await writeFile(
      path.join(architectureDir, 'boolean-mode.md'),
      docWithContentMode('Boolean Mode', 'content_mode: true', [
        'Current prose plus a smell line that must still fire:',
        '',
        '## Audit deepening — 2026-07-07 (verified)',
        'Narrative.',
      ]),
      'utf8',
    );
    await writeFile(
      path.join(architectureDir, 'empty-mode.md'),
      docWithContentMode('Empty Mode', 'content_mode:', ['Current prose only.']),
      'utf8',
    );

    const scan = await scanProjectMemory(tempDir);
    const booleanDoc = scan.documents.find((document) => document.path.endsWith('boolean-mode.md'));
    const emptyDoc = scan.documents.find((document) => document.path.endsWith('empty-mode.md'));

    assert.ok(booleanDoc.warnings.some((warning) => warning.code === 'architecture-unknown-content-mode'));
    assert.ok(
      booleanDoc.warnings.some((warning) => warning.code === 'architecture-changelog-smell'),
      'an invalid content_mode value must not suppress the smell advisory',
    );
    assert.ok(emptyDoc.warnings.some((warning) => warning.code === 'architecture-unknown-content-mode'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('docs-review --apply-output surfaces smell, suppression, and unknown content_mode warnings', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-apply-advisory-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Apply Advisory Root',
      mode: 'local-only',
      repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
    });
    await mkdir(path.join(rootDir, 'state'), { recursive: true });
    await writeFile(
      path.join(rootDir, 'state/docs-review.json'),
      `${JSON.stringify({ status: 'local-review-generated', llm: 'codex', model: 'gpt-5' }, null, 2)}\n`,
      'utf8',
    );

    const architectureBlock = (docPath, component, contentModeLine, detailsLines) => [
      `\`\`\`vibecompass-architecture-doc path=${docPath}`,
      '---',
      'domain: Product',
      'feature: Advisory',
      `component: ${component}`,
      'status: In progress',
      'repo: app',
      ...(contentModeLine ? [contentModeLine] : []),
      '---',
      '',
      '## Description',
      'Apply advisory fixture.',
      '',
      '## Review metadata',
      '- Evidence: `app:src/advisory/index.ts`',
      '- Blindspots: None identified for this fixture.',
      '',
      '## Details',
      ...detailsLines,
      '',
      '## Retrieval guidance',
      '- Use only for apply advisory tests.',
      '- It does not describe runtime behavior.',
      '',
      '## Next steps',
      '- None.',
      '',
      '## Involved files',
      '- `app:src/advisory/index.ts`',
      '```',
    ].join('\n');

    await writeFile(
      path.join(rootDir, 'state/docs-review-output.md'),
      [
        architectureBlock('architecture/product/advisory/smelly.md', 'Smelly', null, [
          '## Audit deepening — 2026-07-07 (verified)',
          'Dated audit narrative.',
        ]),
        '',
        architectureBlock(
          'architecture/product/advisory/ledger.md',
          'Ledger',
          'content_mode: chronological-ledger',
          ['## Audit deepening — 2026-07-07 (verified)', 'Intentionally dated ledger content.'],
        ),
        '',
        architectureBlock('architecture/product/advisory/unknown-mode.md', 'Unknown Mode', 'content_mode: weekly-log', [
          'Current prose only.',
        ]),
        '',
        architectureBlock('architecture/product/advisory/boolean-mode.md', 'Boolean Mode', 'content_mode: true', [
          '## Audit deepening — 2026-07-07 (verified)',
          'A non-string content_mode must warn and must not suppress this smell.',
        ]),
        '',
      ].join('\n'),
      'utf8',
    );

    const stderr = [];
    const exitCode = await runCli(
      ['docs-review', '--root', rootDir, '--apply-output'],
      {
        stdout: { write() {} },
        stderr: { write(chunk) { stderr.push(chunk); } },
      },
      { cwd: tempDir, env: {} },
    );
    assert.equal(exitCode, 0, stderr.join(''));

    const marker = JSON.parse(await readFile(path.join(rootDir, 'state/docs-review.json'), 'utf8'));
    const warnings = marker.applied.warnings ?? [];

    const smellWarnings = warnings.filter((warning) => warning.startsWith('changelog_shaped_architecture_doc:'));
    assert.equal(smellWarnings.length, 2);
    assert.ok(smellWarnings.some((warning) => warning.includes('architecture/product/advisory/smelly.md')));
    assert.ok(
      smellWarnings.some((warning) => warning.includes('architecture/product/advisory/boolean-mode.md')),
      'a non-string content_mode must not suppress the apply-time smell warning',
    );
    assert.equal(
      warnings.some((warning) => warning.includes('advisory/ledger.md') && warning.startsWith('changelog_shaped')),
      false,
      'content_mode: chronological-ledger must suppress the apply-time smell warning',
    );
    const unknownModeWarnings = warnings.filter((warning) => warning.startsWith('unknown_content_mode:'));
    assert.equal(unknownModeWarnings.length, 2);
    assert.ok(unknownModeWarnings.some((warning) => /unknown-mode\.md declares content_mode "weekly-log"/.test(warning)));
    assert.ok(
      unknownModeWarnings.some((warning) => /boolean-mode\.md declares content_mode true/.test(warning)),
      'explicit non-string content_mode must surface in apply warnings',
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('generated guidance surfaces carry the D-292/D-293 authorship rules', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-guidance-'));
  const rootDir = path.join(tempDir, '.compass');

  try {
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Guidance Root',
      mode: 'local-only',
      repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
      bootstrap: { workflow: true },
    });

    const context = await readFile(path.join(rootDir, 'context.md'), 'utf8');
    assert.match(context, /mutable current-state layer, rewritten in place as contracts change \(D-292\)/);
    assert.match(context, /Work\/ship chronology belongs in finalized session notes/);
    assert.match(context, /fold the changes into the doc's current-state sections/);
    assert.match(context, /architecture docs keep current behavior plus the durable plan, unresolved next steps, and material rollout state; session notes keep work chronology and close-out next steps; decisions keep accepted choices and rationale \(D-292, D-293\)/);
    assert.match(context, /distill anything still pending from lane scratch into the session note's next steps and, when durable, into the docs \(D-292, D-293\)/);

    const architectureGuide = await readFile(path.join(rootDir, 'architecture/README.md'), 'utf8');
    assert.match(architectureGuide, /Docs are mutable current-state contracts \(D-292\)/);
    assert.match(architectureGuide, /content_mode: chronological-ledger/);

    const docsReviewWorkflow = await readFile(path.join(rootDir, 'workflows/docs-review.md'), 'utf8');
    assert.match(docsReviewWorkflow, /Write every doc as a current-state contract \(D-292\)/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('the close-session authorship line is unconditional even when doc refresh is disabled', () => {
  const settings = resolveWorkflowSettings({
    metadata: {
      workflow: {
        close_session: {
          refresh_architecture_docs: false,
          refresh_decision_files: false,
          git_publish: false,
        },
      },
    },
  });
  const guidance = buildCloseSessionGuidance(settings, { projectConfig: { mode: 'local-only' } });

  assert.ok(guidance.includes(UNCONDITIONAL_CLOSE_LINE));
  assert.equal(
    guidance.includes('Refresh any relevant architecture docs before finalizing the session.'),
    false,
  );
});
