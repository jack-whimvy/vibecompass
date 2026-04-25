import { renderSharedInstructionBody } from './template.js';

export const claudeMdFormat = {
  name: 'claude_md',
  path: 'CLAUDE.md',
  render(context) {
    return renderSharedInstructionBody(context, {
      heading: `${context.projectName} Claude Instructions`,
      intro:
        'Claude should use VibeCompass project memory as the source of truth before planning, editing, or reviewing code.',
    });
  },
};
