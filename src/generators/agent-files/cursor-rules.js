import { renderSharedInstructionBody } from './template.js';

export const cursorRulesFormat = {
  name: 'cursor_rules',
  path: '.cursorrules',
  render(context) {
    return renderSharedInstructionBody(context, {
      heading: `${context.projectName} Cursor Rules`,
      intro:
        'Cursor should use VibeCompass project memory as the source of truth before suggesting or applying code changes.',
    });
  },
};
