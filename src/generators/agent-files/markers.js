export const START_MARKER = '<!-- vibecompass:start - managed by VibeCompass, do not edit -->';
export const END_MARKER = '<!-- vibecompass:end -->';

export function renderManagedBlock(content) {
  const trimmed = content.trim();
  return `${START_MARKER}\n${trimmed}\n${END_MARKER}\n`;
}

export function applyManagedBlock(existingContent, generatedContent, options = {}) {
  const block = renderManagedBlock(generatedContent);

  if (existingContent === null) {
    return {
      status: 'create',
      content: block,
      warning: null,
    };
  }

  const startIndex = existingContent.indexOf(START_MARKER);
  const endIndex = existingContent.indexOf(END_MARKER);

  if (startIndex === -1 && endIndex === -1) {
    if (options.adoptExisting) {
      const separator = existingContent === '' || existingContent.endsWith('\n') ? '' : '\n';
      return {
        status: 'adopt',
        content: `${existingContent}${separator}${block}`,
        warning: null,
      };
    }

    return {
      status: 'warning',
      content: existingContent,
      warning: 'Existing file has no VibeCompass managed markers; left untouched.',
    };
  }

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return {
      status: 'warning',
      content: existingContent,
      warning: 'Existing file has incomplete VibeCompass managed markers; left untouched.',
    };
  }

  const before = existingContent.slice(0, startIndex);
  const after = existingContent.slice(endIndex + END_MARKER.length);
  const beforeSeparator = before === '' || before.endsWith('\n') ? '' : '\n';
  const afterSeparator = after === '' || after.startsWith('\n') ? '' : '\n';

  return {
    status: 'update',
    content: `${before}${beforeSeparator}${block}${afterSeparator}${after}`,
    warning: null,
  };
}
