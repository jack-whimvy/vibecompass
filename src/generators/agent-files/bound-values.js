import { END_MARKER, START_MARKER } from './markers.js';

// D-411 item 3: what a lifecycle command writes in an existing managed block.
// A block holds two kinds of text. Its bound values are facts read from the
// root: the memory root's path wherever the block names it, the project name
// in its heading, and the `## Project Snapshot` section. Everything else is
// the package's instructions, which only `refresh-workflow --apply` and
// `sync-agents` rewrite (the whole-block writer in markers.js).

const SNAPSHOT_HEADING = '## Project Snapshot';
const ROOT_LINE_PATTERN = /^- Project memory root: `([^`\r\n]+)`\r?$/m;

/**
 * Writes the bound values from `generatedContent` (the running package's whole
 * block body) into the existing file's managed block and keeps every other
 * byte. Returns the same shape as applyManagedBlock, plus
 * `instructionsCurrent`: whether the block, once its bound values are written,
 * equals the running package's whole block.
 */
export function applyBoundValues(existingContent, generatedContent, options = {}) {
  const startIndex = existingContent.indexOf(START_MARKER);
  const endIndex = existingContent.indexOf(END_MARKER);

  if (startIndex === -1 && endIndex === -1) {
    return {
      status: 'warning',
      content: existingContent,
      warning: 'Existing file has no VibeCompass managed markers; left untouched.',
      instructionsCurrent: null,
    };
  }

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return {
      status: 'warning',
      content: existingContent,
      warning: 'Existing file has incomplete VibeCompass managed markers; left untouched.',
      instructionsCurrent: null,
    };
  }

  const innerStart = startIndex + START_MARKER.length;
  const inner = existingContent.slice(innerStart, endIndex);
  const generated = generatedContent.trim();
  const eol = inner.includes('\r\n') ? '\r\n' : '\n';

  let updated = replaceRootPath(inner, readRootPath(inner), readRootPath(generated));
  updated = replaceHeadingName(updated, generated, options.projectName);
  updated = replaceSnapshotSection(updated, generated, eol);

  return {
    status: 'update',
    content: `${existingContent.slice(0, innerStart)}${updated}${existingContent.slice(endIndex)}`,
    warning: null,
    instructionsCurrent: updated.replace(/\r\n/g, '\n').trim() === generated,
  };
}

function readRootPath(text) {
  const match = text.match(ROOT_LINE_PATTERN);
  return match ? match[1] : null;
}

// Each backticked occurrence of the old root, as the whole path or as a path's
// start, becomes the new root.
function replaceRootPath(text, oldRoot, newRoot) {
  if (!oldRoot || !newRoot || oldRoot === newRoot) {
    return text;
  }

  const pattern = new RegExp(`\`${escapeRegExp(oldRoot)}(?=[\`/\\\\])`, 'g');
  return text.replace(pattern, () => `\`${newRoot}`);
}

// The heading takes the current project name when it ends with the same words
// the running package puts after the name.
function replaceHeadingName(text, generated, projectName) {
  const generatedHeading = generated.split('\n')[0];
  const namePrefix = `# ${projectName}`;
  if (typeof projectName !== 'string' || !generatedHeading.startsWith(namePrefix)) {
    return text;
  }
  const suffix = generatedHeading.slice(namePrefix.length);

  const lines = splitLinesKeepingEnds(text);
  const index = lines.findIndex((line) => stripLineEnd(line).trim() !== '');
  if (index === -1) {
    return text;
  }
  const existingHeading = stripLineEnd(lines[index]);
  if (!existingHeading.startsWith('# ') || !existingHeading.endsWith(suffix) || existingHeading === generatedHeading) {
    return text;
  }

  lines[index] = `${generatedHeading}${lines[index].slice(existingHeading.length)}`;
  return lines.join('');
}

// The snapshot section runs from its heading up to the next `## ` heading.
function replaceSnapshotSection(text, generated, eol) {
  const generatedLines = generated.split('\n');
  const generatedRange = findSectionRange(generatedLines);
  if (!generatedRange) {
    return text;
  }

  const lines = splitLinesKeepingEnds(text);
  const existingRange = findSectionRange(lines.map(stripLineEnd));
  if (!existingRange) {
    return text;
  }

  const replacement = generatedLines
    .slice(generatedRange.start, generatedRange.end)
    .map((line) => `${line}${eol}`);
  lines.splice(existingRange.start, existingRange.end - existingRange.start, ...replacement);
  return lines.join('');
}

function findSectionRange(lines) {
  const start = lines.findIndex((line) => line === SNAPSHOT_HEADING);
  if (start === -1) {
    return null;
  }
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('## ')) {
    end += 1;
  }
  if (end === lines.length) {
    // No heading after the snapshot: it isn't the block's middle section, so
    // its end can't be told apart from what follows it.
    return null;
  }
  return { start, end };
}

function splitLinesKeepingEnds(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function stripLineEnd(line) {
  return line.replace(/\r?\n$/, '');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
