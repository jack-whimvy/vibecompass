import { parseSimpleYaml } from './simple-yaml.js';

export function parseFrontmatter(source, options = {}) {
  const sourceName = options.sourceName ?? 'Markdown';
  const lines = source.split(/\r?\n/);

  if (lines[0]?.trim() !== '---') {
    return {
      hasFrontmatter: false,
      data: null,
      body: source,
    };
  }

  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (closingIndex === -1) {
    throw new Error(`${sourceName} starts with frontmatter but is missing the closing delimiter.`);
  }

  const frontmatterSource = lines.slice(1, closingIndex).join('\n');
  const body = lines.slice(closingIndex + 1).join('\n').replace(/^\n/, '');

  return {
    hasFrontmatter: true,
    data: parseSimpleYaml(frontmatterSource, { sourceName: `${sourceName} frontmatter` }),
    body,
  };
}
