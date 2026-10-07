/**
 * The one markdown section reader shared by the read model's component fields
 * (D-372) and the session brief (D-359): fence-aware, first section of a title
 * wins. The lineage extractor keeps its own section index
 * (`decision-lineage.js`), whose fence opener differs (`decision-lineage.md`).
 */

/**
 * One line of fenced-code tracking, with the rules of `findFencedRanges` in
 * `decision-lineage.js`. A fence opens on three or more backticks or tildes
 * indented at most three spaces; a backtick fence's info string has no
 * backtick. It closes only on a line holding the same character at least as
 * many times and nothing else (no other character, so ```~~~ never closes), so
 * a ``` line inside a ```` example stays code.
 */
export function stepFence(fence, line) {
  const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
  if (fence) {
    const closes = marker && marker[1][0] === fence.char && marker[1].length >= fence.length && closingFence(fence.char).test(line);
    return { fence: closes ? null : fence, delimiter: Boolean(closes) };
  }
  if (marker && !(marker[1][0] === '`' && line.slice(line.indexOf(marker[1]) + marker[1].length).includes('`'))) {
    return { fence: { char: marker[1][0], length: marker[1].length }, delimiter: true };
  }
  return { fence: null, delimiter: false };
}

/** A closing fence line: only the opener's character (three or more), then whitespace — never mixed delimiters. */
function closingFence(char) {
  return char === '`' ? /^ {0,3}`{3,}\s*$/ : /^ {0,3}~{3,}\s*$/;
}

/**
 * Sections of a markdown body at `level` (default 2), fence-aware: headings
 * inside fenced code are content, the first section with a given title wins
 * (docs such as `file-schema.md` show example `## Description` blocks in
 * fences), and a heading at that level or above ends the current section.
 */
export function splitSections(content, level = 2) {
  const sections = new Map();
  if (!content) return sections;
  const lines = content.split(/\r?\n/);
  const heading = new RegExp(`^#{1,${level}}\\s`);
  const exact = new RegExp(`^#{${level}}\\s+(.+?)\\s*$`);
  let fence = null;
  let current = null;
  for (const line of lines) {
    const step = stepFence(fence, line);
    const fenced = fence !== null || step.delimiter;
    fence = step.fence;
    if (!fenced && heading.test(line)) {
      const match = line.match(exact);
      current = match && !sections.has(match[1]) ? { title: match[1], lines: [] } : null;
      if (current) sections.set(current.title, current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return new Map([...sections].map(([title, section]) => [title, section.lines.join('\n').trim() || null]));
}

/** Body of a level-2 section (`## Title`), trimmed; null when absent. */
export function extractSection(content, title) {
  return splitSections(content, 2).get(title) ?? null;
}
