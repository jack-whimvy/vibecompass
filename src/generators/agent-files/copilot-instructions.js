import { renderSharedInstructionBody } from './template.js';

export const copilotInstructionsFormat = {
  name: 'copilot_instructions',
  path: '.github/copilot-instructions.md',
  render(context) {
    return renderSharedInstructionBody(context, {
      heading: `${context.projectName} Copilot Instructions`,
      intro:
        'GitHub Copilot should use VibeCompass project memory as the source of truth before suggesting code changes.',
    });
  },
};
