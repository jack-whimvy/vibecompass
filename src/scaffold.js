import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function scaffoldInitFiles(options) {
  const createdFiles = [];
  const skippedFiles = [];

  if (!options.workflow) {
    return {
      contextFilePath: null,
      createdFiles,
      skippedFiles,
    };
  }

  await mkdir(path.join(options.rootDir, 'architecture'), { recursive: true });
  await mkdir(path.join(options.rootDir, 'decisions'), { recursive: true });
  await mkdir(path.join(options.rootDir, 'sessions'), { recursive: true });

  const contextFilePath = path.join(options.rootDir, 'context.md');
  // context.md is a derived artifact owned by the package; regenerate it on rerun.
  await writeFile(contextFilePath, generateContextMarkdown(options), 'utf8');
  createdFiles.push(contextFilePath);

  const workflowFiles = [
    {
      path: path.join(options.rootDir, 'architecture', 'README.md'),
      content: generateArchitectureGuide(options.projectConfig),
    },
    {
      path: path.join(options.rootDir, 'decisions', 'README.md'),
      content: generateDecisionsGuide(options.projectConfig),
    },
    {
      path: path.join(options.rootDir, 'sessions', 'README.md'),
      content: generateSessionsGuide(options.projectConfig),
    },
  ];

  for (const file of workflowFiles) {
    const outcome = await writeIfMissing(file.path, file.content);
    if (outcome.created) {
      createdFiles.push(file.path);
    } else {
      skippedFiles.push(file.path);
    }
  }

  const bootstrapFiles = [];
  if (options.claude) {
    bootstrapFiles.push({
      path: path.join(options.toolingRootDir, 'CLAUDE.md'),
      content: generateClaudeTemplate(options),
    });
  }

  if (options.agents) {
    bootstrapFiles.push({
      path: path.join(options.toolingRootDir, 'AGENTS.md'),
      content: generateAgentsTemplate(options),
    });
  }

  for (const file of bootstrapFiles) {
    const outcome = await writeIfMissing(file.path, file.content);
    if (outcome.created) {
      createdFiles.push(file.path);
    } else {
      skippedFiles.push(file.path);
    }
  }

  return {
    contextFilePath,
    createdFiles,
    skippedFiles,
  };
}

async function writeIfMissing(filePath, content) {
  if (await fileExists(filePath)) {
    return { created: false };
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  return { created: true };
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function generateContextMarkdown(options) {
  const projectName = options.projectConfig.name;
  const rootRelativePath = options.rootRelativePath;
  const repos = options.projectConfig.repos
    .map((repo) => `- \`${repo.id}\` → ${repo.remote}`)
    .join('\n');

  return `# Project Context — ${projectName}

This workspace uses VibeCompass project memory rooted at \`${rootRelativePath}\`.

## Canonical files
- \`${rootRelativePath}/project.yaml\` — machine-oriented project metadata
- \`${rootRelativePath}/architecture/\` — canonical architecture docs
- \`${rootRelativePath}/decisions/\` — canonical decision log
- \`${rootRelativePath}/sessions/\` — finalized session notes

## Derived and scratch files
- \`${rootRelativePath}/context.md\` — generated AI-facing workflow context
- \`${rootRelativePath}/state/manifest.json\` — machine-owned local state; do not hand-edit
- \`${rootRelativePath}/sessions/wip.md\` — active builder scratchpad during a session
- \`${rootRelativePath}/sessions/handoff.md\` — builder/reviewer relay during a session

## Repos in scope
${repos}

## Session roles
| Trigger | Role | Owns session lifecycle? |
|---|---|---|
| "start session" | Builder | Yes — opens the session, keeps scratch files current, and writes the final session note |
| "join as reviewer" | Reviewer | No — reviews the builder's work, appends findings, and updates handoff guidance |

## Session prompt commands
- \`start session\` — builder role trigger
- \`join as reviewer\` — reviewer role trigger
- \`review handoff\` — reviewer reads the latest finalized note, \`wip.md\`, \`handoff.md\`, and relevant diffs before appending findings
- \`address review\` — builder reads reviewer feedback in \`wip.md\` / \`handoff.md\`, responds inline, applies accepted changes, and refreshes the builder handoff

These are prompt commands for agent behavior, not \`vibecompass\` CLI subcommands.

## Session startup
1. Read \`${rootRelativePath}/project.yaml\`.
2. Read the latest finalized session note in \`${rootRelativePath}/sessions/\`.
3. If present, read \`${rootRelativePath}/sessions/wip.md\`.
4. If present, read \`${rootRelativePath}/sessions/handoff.md\`.
5. Read the relevant docs under \`${rootRelativePath}/architecture/\` and \`${rootRelativePath}/decisions/\`.

## Builder workflow
At session start, prefer running \`vibecompass start-session --working-on "..." \`.
If you manage files manually, create \`${rootRelativePath}/sessions/wip.md\` if it does not exist:

\`\`\`md
# WIP — YYYY-MM-DD (session N)

## Working on

## Log

## Reviewer input needed

## Review log
\`\`\`

Also create \`${rootRelativePath}/sessions/handoff.md\` if it does not exist:

\`\`\`md
# Handoff — YYYY-MM-DD (session N)

## Builder → Reviewer

### What changed

### What needs review

### What's next

## Reviewer → Builder

### Findings summary

### Recommended next step
\`\`\`

During the session:
- append short summaries to \`wip.md\` after meaningful exchanges
- keep \`handoff.md\` current after substantive work blocks
- use \`address review\` when reviewer feedback lands so the builder resolves it from the latest \`wip.md\` / \`handoff.md\`
- record architectural decisions in \`${rootRelativePath}/decisions/\` before implementing them

At session close:
- prefer running \`vibecompass close-session --title "..." --completed "..." --model "..." --next-step "..."\`
- finalize \`wip.md\` into \`${rootRelativePath}/sessions/YYYY-MM-DD-N-title.md\`
- delete \`wip.md\` and \`handoff.md\`
- refresh any affected architecture/decision docs

## Reviewer workflow
- use \`review handoff\` when you want the reviewer to run the next review pass
- read the latest finalized session note, then \`wip.md\`, then \`handoff.md\`
- inspect the relevant code/docs diffs
- append findings under \`## Review log\` in \`wip.md\`
- write a concise baton-pass summary into \`handoff.md\`

## Tooling note
\`CLAUDE.md\` and \`AGENTS.md\` are developer-owned starter files. If they exist,
they should point back to this context file and should not be overwritten
automatically by package commands.
`;
}

function generateArchitectureGuide(projectConfig) {
  return `# Architecture

This directory holds canonical architecture docs for ${projectConfig.name}.

## Recommended layout

\`\`\`text
architecture/<domain-slug>/<feature-slug>/<component>.md
\`\`\`

## Required frontmatter
- \`domain\`
- \`feature\`
- \`component\`
- \`status\`
- optional \`repo\` or \`repos\`

## Recommended sections
- \`## Description\`
- \`## Details\`
- \`## Next steps\`
- \`## Involved files\`

Each component doc is canonical. This README is only a convenience guide.
`;
}

function generateDecisionsGuide(projectConfig) {
  return `# Decisions

Append-only decision log for ${projectConfig.name}.

## Conventions
- store canonical decision entries in domain-grouped files such as \`cross-cutting.md\`
- never edit or delete prior decision entries
- use headings in the form \`### D-<number> — Title\`
- include \`**Timestamp:**\`, \`**Decision:**\`, and \`**Rationale:**\`

## Example

\`\`\`md
### D-001 — Example decision
**Timestamp:** YYYY-MM-DD HH:MM TZ
**Decision:** What was decided.
**Rationale:** Why this was the correct tradeoff.
\`\`\`

This README is guidance only; canonical decision content lives in the domain files.
`;
}

function generateSessionsGuide(projectConfig) {
  return `# Sessions

Finalized session notes for ${projectConfig.name} live here.

## Finalized session note format
- recommended filename: \`YYYY-MM-DD-N-title.md\`
- recommended H1: \`# Session — YYYY-MM-DD-N — Title\`

## Recommended sections
- \`## What we worked on\`
- \`## Completed\`
- \`## Decisions made\`
- \`## Models used\`
- \`## Blockers / open questions\`
- \`## Next session should start with\`

## Active-session scratch files
- \`wip.md\` — builder scratchpad during an active session
- \`handoff.md\` — reviewer/builder baton-pass during an active session

Those scratch files are session-scoped working artifacts, not finalized history.
`;
}

function generateClaudeTemplate(options) {
  return `# ${options.projectConfig.name} Workspace

Read \`${options.contextRelativeToToolingRoot}\` before doing substantive work.

## Session roles

| Trigger | Role | Owns session lifecycle? |
|---|---|---|
| "start session" | Builder | Yes |
| "join as reviewer" | Reviewer | No |

## Prompt commands

- \`start session\` — builder role trigger
- \`join as reviewer\` — reviewer role trigger
- \`review handoff\` — reviewer reads the latest finalized note, \`wip.md\`, \`handoff.md\`, and relevant diffs before appending findings
- \`address review\` — builder reads reviewer feedback in \`wip.md\` / \`handoff.md\`, responds inline, applies accepted changes, and refreshes the builder handoff

These are prompt commands for agent behavior, not \`vibecompass\` CLI subcommands.

## Current session

**Update this block at the start and end of every session.**

\`\`\`
Date: not started
Working on: Session not started yet.
Last thing completed: Project memory bootstrap completed.
Blockers: None recorded.
Next session should: Read \`${options.contextRelativeToToolingRoot}\`, then open the first builder or reviewer session.
\`\`\`

## Startup
- Read \`${options.contextRelativeToToolingRoot}\`
- Follow the builder/reviewer protocol defined there
- Use \`vibecompass start-session\` and \`vibecompass close-session\` to manage the active-session files when possible
- Keep \`${options.rootRelativePath}/sessions/wip.md\` and \`${options.rootRelativePath}/sessions/handoff.md\` current during an active session
`;
}

function generateAgentsTemplate(options) {
  return `# ${options.projectConfig.name} Workspace

This workspace uses VibeCompass project memory rooted at \`${options.rootRelativePath}\`.

## Session roles

| Trigger | Role | Owns session lifecycle? |
|---|---|---|
| "start session" | Builder | Yes — opens and closes the session lifecycle |
| "join as reviewer" | Reviewer | No — reviews the builder's work and updates the handoff |

## Prompt commands

- \`start session\` — builder role trigger
- \`join as reviewer\` — reviewer role trigger
- \`review handoff\` — reviewer reads the latest finalized note, \`wip.md\`, \`handoff.md\`, and relevant diffs before appending findings
- \`address review\` — builder reads reviewer feedback in \`wip.md\` / \`handoff.md\`, responds inline, applies accepted changes, and refreshes the builder handoff

These are prompt commands for agent behavior, not \`vibecompass\` CLI subcommands.

## Startup
Before doing substantive work:
1. Read \`${options.contextRelativeToToolingRoot}\`.
2. Read the latest finalized session note under \`${options.rootRelativePath}/sessions/\`.
3. If present, read \`${options.rootRelativePath}/sessions/wip.md\`.
4. If present, read \`${options.rootRelativePath}/sessions/handoff.md\`.
5. Read the relevant docs under \`${options.rootRelativePath}/architecture/\` and \`${options.rootRelativePath}/decisions/\`.

## Working rule
Treat \`${options.contextRelativeToToolingRoot}\` as the local workflow source of truth for the builder/reviewer protocol and session scratch-file structure. When the package provides \`start-session\` / \`close-session\`, prefer those commands over hand-editing boilerplate.
`;
}
