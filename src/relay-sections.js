import { createHash } from 'node:crypto';
import { stepFence } from './markdown-sections.js';

// The lane files the review relay reads and writes by section: `wip.md` ›
// `## Review log` and `handoff.md` › `## Builder → Reviewer` and
// `## Reviewer → Builder` (D-419 items 4 and 6). A section runs from its
// level-2 heading to the next level-1 or level-2 heading outside a fence, the
// rule the review log's parser uses, and the first heading with the title wins.

export const REVIEW_LOG_HEADING = '## Review log';
export const BUILDER_TO_REVIEWER_HEADING = '## Builder → Reviewer';
export const REVIEWER_TO_BUILDER_HEADING = '## Reviewer → Builder';

export function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Where a section sits in `content`: the heading's line index, and the body's
 * first and past-the-end line indexes. Null when the heading is absent.
 */
export function locateSection(content, heading) {
  const lines = content.split('\n');
  const wanted = heading.trim().toLowerCase();
  let fence = null;
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/, '');
    const wasInFence = Boolean(fence);
    fence = stepFence(fence, line).fence;
    if (wasInFence || !/^#{1,2}\s/.test(line)) {
      continue;
    }
    if (start >= 0) {
      return { lines, headingIndex: start, bodyStart: start + 1, bodyEnd: index };
    }
    if (line.trim().toLowerCase() === wanted) {
      start = index;
    }
  }
  return start >= 0 ? { lines, headingIndex: start, bodyStart: start + 1, bodyEnd: lines.length } : null;
}

/**
 * A section's body as the fingerprints read it: its lines without carriage
 * returns, trailing blank lines dropped, so a file's final newline doesn't
 * count. A missing section reads as null.
 */
export function readSectionBody(content, heading) {
  const located = locateSection(content, heading);
  if (!located) {
    return null;
  }
  const body = located.lines.slice(located.bodyStart, located.bodyEnd).map((line) => line.replace(/\r$/, ''));
  while (body.length > 0 && body.at(-1).trim() === '') {
    body.pop();
  }
  return body.join('\n');
}

/** SHA-256 of a section's body; a missing section hashes a fixed marker. */
export function fingerprintSection(content, heading) {
  const body = readSectionBody(content, heading);
  return sha256Hex(body === null ? `\u0000missing ${heading}` : `${heading}\n${body}`);
}

/**
 * `content` with one section's body replaced by `bodyLines`, every other line
 * kept byte for byte. A missing section is appended at the end. The body is
 * followed by one blank line when another section comes after it.
 */
export function replaceSectionBody(content, heading, bodyLines) {
  const located = locateSection(content, heading);
  if (!located) {
    const trimmed = content.replace(/\n*$/, '');
    return `${trimmed}\n\n${heading}\n${bodyLines.join('\n')}\n`;
  }
  const { lines, bodyStart, bodyEnd } = located;
  const before = lines.slice(0, bodyStart);
  const after = lines.slice(bodyEnd);
  const middle = after.length > 0 ? [...bodyLines, ''] : bodyLines;
  const tail = after.length > 0 ? after : [''];
  return [...before, ...middle, ...tail].join('\n');
}
