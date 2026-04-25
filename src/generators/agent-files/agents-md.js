import { renderSharedInstructionBody } from './template.js';

export const agentsMdFormat = {
  name: 'agents_md',
  path: 'AGENTS.md',
  render(context) {
    return renderSharedInstructionBody(context, {
      heading: `${context.projectName} Agent Instructions`,
      intro:
        'Agents should use VibeCompass project memory as the source of truth before planning, editing, or reviewing code.',
    });
  },
};
