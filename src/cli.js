#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { initializeProjectMemory } from './init.js';
import { preflightDocsReview } from './docs-review.js';
import { resolveInitCliOptions } from './setup.js';
import { closeProjectSession, listProjectSessions, startProjectSession, switchProjectSession } from './session.js';
import { syncAgentInstructionFiles } from './generators/agent-files/index.js';
import {
  applyPullExport,
  pullExportProjectMemory,
  pullPreviewProjectMemory,
  pushProjectMemory,
} from './sync.js';

export async function runCli(argv, io = createDefaultIo(), runtime = {}) {
  const parsed = parseCliArgs(argv);

  if (parsed.command === 'help') {
    io.stdout.write(`${usageText()}\n`);
    return 0;
  }

  if (parsed.command === 'init') {
    const initPlan = await resolveInitCliOptions(parsed.options, {
      cwd: runtime.cwd,
      io,
      runtime,
    });
    const result = await initializeProjectMemory({
      ...initPlan.initOptions,
      ...(runtime.cwd ? { cwd: runtime.cwd } : {}),
    });
    io.stdout.write(`Initialized VibeCompass project memory at ${result.rootDir}\n`);
    if (initPlan.placementPattern) {
      io.stdout.write(`Placement: ${initPlan.placementPattern}\n`);
    }
    io.stdout.write(`Wrote ${result.projectFilePath}\n`);
    if (result.gitignoreUpdated) {
      io.stdout.write(`Updated ${result.gitignorePath} to ignore state/\n`);
    } else {
      io.stdout.write(`${result.gitignorePath} already ignored state/\n`);
    }
    io.stdout.write(
      `Generated ${result.manifestPath} (${result.manifest.canonical.document_count} canonical docs, ${result.manifest.canonical.warning_count} warnings)\n`,
    );

    if (result.syncEnvVar) {
      io.stdout.write(`Next step: set ${result.syncEnvVar} locally before your first sync.\n`);
    }

    if (result.contextFilePath) {
      io.stdout.write(`Generated ${result.contextFilePath}\n`);
    }

    for (const filePath of result.scaffoldCreatedFiles) {
      if (filePath === result.contextFilePath) {
        continue;
      }
      io.stdout.write(`Created ${filePath}\n`);
    }

    for (const filePath of result.scaffoldSkippedFiles) {
      io.stdout.write(`Left existing ${filePath} untouched\n`);
    }

    if (initPlan.sessionPlan) {
      const sessionResult = await startProjectSession({
        rootDir: initPlan.initOptions.rootDir,
        toolingRootDir: initPlan.initOptions.toolingRootDir,
        sessionId: initPlan.sessionPlan.sessionId,
        workingOn: initPlan.sessionPlan.workingOn,
        ...(runtime.cwd ? { cwd: runtime.cwd } : {}),
      });
      io.stdout.write(`Started session ${sessionResult.sessionDate}-${sessionResult.sessionNumber}\n`);
      io.stdout.write(`Updated ${sessionResult.claudePath}\n`);
      io.stdout.write(`Created ${sessionResult.wipFilePath}\n`);
      io.stdout.write(`Created ${sessionResult.handoffFilePath}\n`);
      writeWarnings(io, sessionResult.warnings);
      writeAgentFileSyncResult(io, sessionResult.agentFileSync);
    }

    return 0;
  }

  if (parsed.command === 'start-session') {
    const result = await startProjectSession({
      ...parsed.options,
      ...(runtime.cwd ? { cwd: runtime.cwd } : {}),
    });
    io.stdout.write(`Started session ${result.sessionDate}-${result.sessionNumber}\n`);
    io.stdout.write(`Updated ${result.claudePath}\n`);
    io.stdout.write(`Created ${result.wipFilePath}\n`);
    io.stdout.write(`Created ${result.handoffFilePath}\n`);
    writeWarnings(io, result.warnings);
    writeAgentFileSyncResult(io, result.agentFileSync);
    return 0;
  }

  if (parsed.command === 'close-session' || parsed.command === 'end-session') {
    const result = await closeProjectSession({
      ...parsed.options,
      ...(runtime.cwd ? { cwd: runtime.cwd } : {}),
    });
    io.stdout.write(`Closed session ${result.sessionDate}-${result.sessionNumber}\n`);
    io.stdout.write(`Wrote ${result.sessionFilePath}\n`);
    io.stdout.write(`Updated ${result.claudePath}\n`);
    if (result.workflowGuidance.length > 0) {
      io.stdout.write('Workflow guidance:\n');
      for (const item of result.workflowGuidance) {
        io.stdout.write(`- ${item}\n`);
      }
    }
    writeAgentFileSyncResult(io, result.agentFileSync);
    return 0;
  }

  if (parsed.command === 'list-sessions') {
    const result = await listProjectSessions({
      ...parsed.options,
      ...(runtime.cwd ? { cwd: runtime.cwd } : {}),
    });
    io.stdout.write(`Active session lanes${result.current ? ` (current: ${result.current})` : ''}:\n`);
    if (result.lanes.length === 0) {
      io.stdout.write('- None\n');
    } else {
      for (const lane of result.lanes) {
        const marker = lane.id === result.current ? '*' : '-';
        io.stdout.write(`${marker} ${lane.id}: ${lane.workingOn ?? 'No summary recorded'}\n`);
      }
    }
    return 0;
  }

  if (parsed.command === 'switch-session') {
    const result = await switchProjectSession({
      ...parsed.options,
      ...(runtime.cwd ? { cwd: runtime.cwd } : {}),
    });
    io.stdout.write(`Current session lane: ${result.current}\n`);
    io.stdout.write(`Updated ${result.claudePath}\n`);
    writeAgentFileSyncResult(io, result.agentFileSync);
    return 0;
  }

  if (parsed.command === 'sync-agents') {
    const result = await syncAgentInstructionFiles({
      ...parsed.options,
      ...(runtime.cwd ? { cwd: runtime.cwd } : {}),
    });
    writeAgentFileSyncResult(io, result);
    return 0;
  }

  if (parsed.command === 'docs-review') {
    const result = await preflightDocsReview({
      ...parsed.options,
      ...(runtime.cwd ? { cwd: runtime.cwd } : {}),
    }, {
      io,
      env: runtime.env,
      runtime,
    });
    io.stdout.write(`Docs-review: ${result.status}\n`);
    if (result.llm) {
      io.stdout.write(`LLM: ${result.llm}\n`);
    }
    if (result.model) {
      io.stdout.write(`Model: ${result.model}\n`);
    }
    if (result.runtime) {
      io.stdout.write(`Runtime: ${result.runtime.provider}\n`);
    }
    if (result.hosted) {
      io.stdout.write(`Hosted run: ${result.hosted.run_id}\n`);
      if (result.hosted.phase) {
        io.stdout.write(`Hosted phase: ${result.hosted.phase}\n`);
      }
    }
    if (result.localReview) {
      io.stdout.write(`Local review output: ${result.localReview.output_path}\n`);
    }
    if (result.applied) {
      io.stdout.write(`Applied architecture docs: ${result.applied.architecture_docs.length}\n`);
      for (const entry of result.applied.architecture_docs) {
        io.stdout.write(`- ${entry.path} (${entry.status})\n`);
      }
    }
    writeWarnings(io, result.warnings);
    io.stdout.write(`Recorded ${result.statePath}\n`);
    io.stdout.write(`${result.message}\n`);
    if (result.reviewPrompt) {
      io.stdout.write('Architecture review prompt:\n');
      io.stdout.write(`${result.reviewPrompt}\n`);
    }
    return 0;
  }

  if (parsed.command === 'push') {
    const result = await pushProjectMemory(parsed.options, {
      cwd: runtime.cwd,
      env: runtime.env,
      runtime,
    });
    io.stdout.write(`Push: ${result.status}\n`);
    io.stdout.write(`Remote revision: ${result.remoteRevisionId}\n`);
    io.stdout.write(`Run: ${result.runId}\n`);
    if (result.appliedProposalIds.length > 0) {
      io.stdout.write(`Applied proposals: ${result.appliedProposalIds.join(', ')}\n`);
    }
    if (result.staleProposalIds.length > 0) {
      io.stdout.write(`Stale proposals: ${result.staleProposalIds.join(', ')}\n`);
    }
    io.stdout.write(`Recorded ${result.manifestPath}\n`);
    io.stdout.write(`${result.message}\n`);
    return 0;
  }

  if (parsed.command === 'pull-preview') {
    const result = await pullPreviewProjectMemory(parsed.options, {
      cwd: runtime.cwd,
      env: runtime.env,
      runtime,
    });
    io.stdout.write(`Pull-preview: ${result.status}\n`);
    io.stdout.write(`Preview token: ${result.previewToken}\n`);
    io.stdout.write(`Pending proposals: ${result.proposals.length}\n`);
    for (const proposal of result.proposals) {
      io.stdout.write(`- ${proposal.proposal_id}: ${proposal.summary}\n`);
    }
    writeWarnings(io, result.warnings.map((warning) => `${warning.code}: ${warning.message}`));
    io.stdout.write(`Recorded ${result.manifestPath}\n`);
    io.stdout.write(`${result.message}\n`);
    return 0;
  }

  if (parsed.command === 'pull-export') {
    const result = await pullExportProjectMemory(parsed.options, {
      cwd: runtime.cwd,
      env: runtime.env,
      runtime,
    });
    io.stdout.write(`Pull-export: ${result.status}\n`);
    io.stdout.write(`Run: ${result.runId}\n`);
    io.stdout.write(`Proposal IDs: ${result.proposalIds.join(', ')}\n`);
    io.stdout.write(`Operations: ${result.operationCount}\n`);
    io.stdout.write(`Wrote ${result.outputPath}\n`);
    io.stdout.write(`${result.message}\n`);
    return 0;
  }

  if (parsed.command === 'apply-export') {
    const result = await applyPullExport(parsed.options, {
      cwd: runtime.cwd,
      env: runtime.env,
      runtime,
    });
    io.stdout.write(`Apply-export: ${result.status}\n`);
    for (const entry of result.applied) {
      io.stdout.write(`- ${entry.path} (${entry.status})\n`);
    }
    io.stdout.write(`Recorded ${result.outputPath}\n`);
    io.stdout.write(`${result.message}\n`);
    return 0;
  }

  throw new Error(`Unknown command "${parsed.command}".`);
}

export function parseCliArgs(argv) {
  const [command, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help' };
  }

  if (command !== 'init') {
    if (command === 'start-session') {
      return parseStartSessionArgs(rest);
    }

    if (command === 'close-session' || command === 'end-session') {
      return parseCloseSessionArgs(rest);
    }

    if (command === 'list-sessions') {
      return parseListSessionsArgs(rest);
    }

    if (command === 'switch-session') {
      return parseSwitchSessionArgs(rest);
    }

    if (command === 'sync-agents') {
      return parseSyncAgentsArgs(rest);
    }

    if (command === 'docs-review') {
      return parseDocsReviewArgs(rest);
    }

    if (command === 'push') {
      return parsePushArgs(rest);
    }

    if (command === 'pull-preview') {
      return parsePullPreviewArgs(rest);
    }

    if (command === 'pull-export') {
      return parsePullExportArgs(rest);
    }

    if (command === 'apply-export') {
      return parseApplyExportArgs(rest);
    }

    return { command };
  }

  const parsed = {
    repos: [],
    repoBranches: new Map(),
  };

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (token === '--force') {
      parsed.force = true;
      continue;
    }

    if (token === '--guided') {
      parsed.guided = true;
      continue;
    }

    if (token === '--with-workflow') {
      parsed.withWorkflow = true;
      continue;
    }

    if (token === '--with-claude') {
      parsed.withClaude = true;
      continue;
    }

    if (token === '--with-agents') {
      parsed.withAgents = true;
      continue;
    }

    if (token === '--start-session') {
      parsed.startSession = true;
      continue;
    }

    if (token === '--close-session-git-publish') {
      parsed.closeSessionGitPublish = true;
      continue;
    }

    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument "${token}".`);
    }

    const value = rest[index + 1];
    if (value === undefined) {
      throw new Error(`Flag "${token}" requires a value.`);
    }
    index += 1;

    switch (token) {
      case '--root':
        parsed.rootDir = value;
        break;
      case '--tooling-root':
        parsed.toolingRootDir = value;
        break;
      case '--name':
        parsed.name = value;
        break;
      case '--slug':
        parsed.slug = value;
        break;
      case '--description':
        parsed.description = value;
        break;
      case '--placement':
        parsed.placementPattern = value;
        break;
      case '--mode':
        parsed.mode = value;
        break;
      case '--repo': {
        const [id, remote] = splitAssignment(value, '--repo');
        parsed.repos.push({ id, remote });
        break;
      }
      case '--repo-branch': {
        const [id, defaultBranch] = splitAssignment(value, '--repo-branch');
        parsed.repoBranches.set(id, defaultBranch);
        break;
      }
      case '--sync-api-url':
        parsed.syncApiUrl = value;
        break;
      case '--sync-project-id':
        parsed.syncProjectId = value;
        break;
      case '--sync-credential-env-var':
        parsed.syncCredentialEnvVar = value;
        break;
      case '--session-working-on':
        parsed.sessionWorkingOn = value;
        break;
      case '--session-id':
        parsed.sessionId = value;
        break;
      case '--close-session-git-remote':
        parsed.closeSessionGitRemote = value;
        break;
      default:
        throw new Error(`Unknown flag "${token}".`);
    }
  }

  for (const repo of parsed.repos) {
    const defaultBranch = parsed.repoBranches.get(repo.id);
    if (defaultBranch) {
      repo.defaultBranch = defaultBranch;
    }
  }

  const syncValues = [
    parsed.syncApiUrl,
    parsed.syncProjectId,
    parsed.syncCredentialEnvVar,
  ].filter(Boolean);

  return {
    command: 'init',
    options: {
      guided: parsed.guided,
      rootDir: parsed.rootDir,
      toolingRootDir: parsed.toolingRootDir,
      name: parsed.name,
      slug: parsed.slug,
      description: parsed.description,
      placementPattern: parsed.placementPattern,
      mode: parsed.mode,
      repos: parsed.repos,
      force: parsed.force,
      startSession: parsed.startSession,
      sessionWorkingOn: parsed.sessionWorkingOn,
      sessionId: parsed.sessionId,
      closeSessionGitPublish: parsed.closeSessionGitPublish,
      closeSessionGitRemote: parsed.closeSessionGitRemote,
      ...(parsed.withWorkflow || parsed.withClaude || parsed.withAgents
        ? {
            bootstrap: {
              workflow: parsed.withWorkflow,
              claude: parsed.withClaude,
              agents: parsed.withAgents,
            },
          }
        : {}),
      ...(syncValues.length > 0
        ? {
            sync: {
              apiUrl: parsed.syncApiUrl,
              projectId: parsed.syncProjectId,
              credentialEnvVar: parsed.syncCredentialEnvVar,
            },
          }
        : {}),
    },
  };
}

function parseStartSessionArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument "${token}".`);
    }

    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`Flag "${token}" requires a value.`);
    }
    index += 1;

    switch (token) {
      case '--root':
        parsed.rootDir = value;
        break;
      case '--tooling-root':
        parsed.toolingRootDir = value;
        break;
      case '--working-on':
        parsed.workingOn = value;
        break;
      case '--id':
        parsed.sessionId = value;
        break;
      case '--feature':
        parsed.features = [...(parsed.features ?? []), value];
        break;
      case '--repo':
        parsed.repos = [...(parsed.repos ?? []), value];
        break;
      case '--claim':
        parsed.claims = [...(parsed.claims ?? []), value];
        break;
      case '--date':
        parsed.date = value;
        break;
      case '--last-thing-completed':
        parsed.lastThingCompleted = value;
        break;
      case '--blockers':
        parsed.blockers = value;
        break;
      case '--next-session-should':
        parsed.nextSessionShould = value;
        break;
      default:
        throw new Error(`Unknown flag "${token}".`);
    }
  }

  return {
    command: 'start-session',
    options: parsed,
  };
}

function parseCloseSessionArgs(argv) {
  const parsed = {
    completed: [],
    decisions: [],
    models: [],
    blockers: [],
    nextSteps: [],
  };
  // Repeatable CLI flags stay singular for readability, but map to plural arrays in the JS API.

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument "${token}".`);
    }

    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`Flag "${token}" requires a value.`);
    }
    index += 1;

    switch (token) {
      case '--root':
        parsed.rootDir = value;
        break;
      case '--tooling-root':
        parsed.toolingRootDir = value;
        break;
      case '--title':
        parsed.title = value;
        break;
      case '--worked-on':
        parsed.workedOn = value;
        break;
      case '--session':
        parsed.sessionId = value;
        break;
      case '--completed':
        parsed.completed.push(value);
        break;
      case '--decision':
        parsed.decisions.push(value);
        break;
      case '--model':
        parsed.models.push(value);
        break;
      case '--blocker':
        parsed.blockers.push(value);
        break;
      case '--next-step':
        parsed.nextSteps.push(value);
        break;
      case '--last-thing-completed':
        parsed.lastThingCompleted = value;
        break;
      case '--next-session-should':
        parsed.nextSessionShould = value;
        break;
      default:
        throw new Error(`Unknown flag "${token}".`);
    }
  }

  return {
    command: 'close-session',
    options: parsed,
  };
}

function parseListSessionsArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument "${token}".`);
    }

    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`Flag "${token}" requires a value.`);
    }
    index += 1;

    switch (token) {
      case '--root':
        parsed.rootDir = value;
        break;
      default:
        throw new Error(`Unknown flag "${token}".`);
    }
  }

  return {
    command: 'list-sessions',
    options: parsed,
  };
}

function parseSwitchSessionArgs(argv) {
  const parsed = {};
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`Flag "${token}" requires a value.`);
    }
    index += 1;

    switch (token) {
      case '--root':
        parsed.rootDir = value;
        break;
      case '--session':
        parsed.sessionId = value;
        break;
      default:
        throw new Error(`Unknown flag "${token}".`);
    }
  }

  if (positional.length > 1) {
    throw new Error(`Unexpected argument "${positional[1]}".`);
  }

  if (!parsed.sessionId && positional[0]) {
    parsed.sessionId = positional[0];
  }

  return {
    command: 'switch-session',
    options: parsed,
  };
}

function parseSyncAgentsArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }

    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument "${token}".`);
    }

    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`Flag "${token}" requires a value.`);
    }
    index += 1;

    switch (token) {
      case '--root':
        parsed.rootDir = value;
        break;
      case '--tooling-root':
        parsed.toolingRootDir = value;
        break;
      case '--format':
        parsed.format = value;
        break;
      default:
        throw new Error(`Unknown flag "${token}".`);
    }
  }

  return {
    command: 'sync-agents',
    options: parsed,
  };
}

function parseDocsReviewArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--guided') {
      parsed.guided = true;
      continue;
    }

    if (token === '--submit-hosted') {
      parsed.submitHosted = true;
      continue;
    }

    if (token === '--poll-hosted') {
      parsed.pollHosted = true;
      continue;
    }

    if (token === '--complete') {
      parsed.complete = true;
      continue;
    }

    if (token === '--run-local-anthropic') {
      parsed.runLocalAnthropic = true;
      continue;
    }

    if (token === '--run-local') {
      parsed.runLocal = true;
      continue;
    }

    if (token === '--apply-output') {
      parsed.applyOutput = true;
      continue;
    }

    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument "${token}".`);
    }

    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`Flag "${token}" requires a value.`);
    }
    index += 1;

    switch (token) {
      case '--root':
        parsed.rootDir = value;
        break;
      case '--llm':
        parsed.llm = value;
        break;
      case '--model':
        parsed.model = value;
        break;
      case '--anthropic-env-var':
        parsed.anthropicEnvVar = value;
        break;
      case '--provider':
        parsed.provider = value;
        break;
      case '--output':
        parsed.outputPath = value;
        break;
      case '--max-tokens':
        parsed.maxTokens = value;
        break;
      default:
        throw new Error(`Unknown flag "${token}".`);
    }
  }

  return {
    command: 'docs-review',
    options: parsed,
  };
}

function parsePushArgs(argv) {
  return {
    command: 'push',
    options: parseRootOnlyArgs(argv, 'push'),
  };
}

function parsePullPreviewArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--no-pending-proposals') {
      parsed.includePendingProposals = false;
      continue;
    }

    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument "${token}".`);
    }

    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`Flag "${token}" requires a value.`);
    }
    index += 1;

    switch (token) {
      case '--root':
        parsed.rootDir = value;
        break;
      default:
        throw new Error(`Unknown flag "${token}".`);
    }
  }

  return {
    command: 'pull-preview',
    options: parsed,
  };
}

function parsePullExportArgs(argv) {
  const parsed = {
    proposalIds: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument "${token}".`);
    }

    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`Flag "${token}" requires a value.`);
    }
    index += 1;

    switch (token) {
      case '--root':
        parsed.rootDir = value;
        break;
      case '--preview-token':
        parsed.previewToken = value;
        break;
      case '--proposal':
        parsed.proposalIds.push(value);
        break;
      case '--output':
        parsed.outputPath = value;
        break;
      default:
        throw new Error(`Unknown flag "${token}".`);
    }
  }

  return {
    command: 'pull-export',
    options: parsed,
  };
}

function parseApplyExportArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument "${token}".`);
    }

    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`Flag "${token}" requires a value.`);
    }
    index += 1;

    switch (token) {
      case '--root':
        parsed.rootDir = value;
        break;
      case '--output':
        parsed.outputPath = value;
        break;
      default:
        throw new Error(`Unknown flag "${token}".`);
    }
  }

  return {
    command: 'apply-export',
    options: parsed,
  };
}

function parseRootOnlyArgs(argv, commandName) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument "${token}".`);
    }

    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`Flag "${token}" requires a value.`);
    }
    index += 1;

    switch (token) {
      case '--root':
        parsed.rootDir = value;
        break;
      default:
        throw new Error(`Unknown flag "${token}" for ${commandName}.`);
    }
  }

  return parsed;
}

function writeAgentFileSyncResult(io, result) {
  if (!result) {
    return;
  }

  io.stdout.write('Agent instruction files:\n');
  for (const item of result.results) {
    const suffix = item.warning ? ` — ${item.warning}` : '';
    const stream = item.warning ? io.stderr : io.stdout;
    stream.write(`- ${item.relativePath}: ${item.status}${suffix}\n`);
  }
}

function writeWarnings(io, warnings = []) {
  for (const warning of warnings) {
    io.stderr.write(`Warning: ${warning}\n`);
  }
}

function splitAssignment(value, flagName) {
  const separatorIndex = value.indexOf('=');
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    throw new Error(`${flagName} expects id=value.`);
  }

  return [value.slice(0, separatorIndex), value.slice(separatorIndex + 1)];
}

function usageText() {
  return [
    'Usage:',
    '  vibecompass init --name <project-name> --mode <local-only|local-primary|hosted-only> --repo <id=remote> [options]',
    '  vibecompass start-session --id <lane-id> --working-on <text> [options]',
    '  vibecompass close-session --title <text> --completed <text> --next-step <text> [options]',
    '  vibecompass end-session --title <text> --completed <text> --next-step <text> [options]  # alias',
    '  vibecompass list-sessions [options]',
    '  vibecompass switch-session <id> [options]',
    '  vibecompass sync-agents [options]',
    '  vibecompass push [options]',
    '  vibecompass pull-preview [options]',
    '  vibecompass pull-export [options]',
    '  vibecompass apply-export [options]',
    '  vibecompass docs-review --guided [options]',
    '',
    'Init options:',
    '  --root <path>                        Project-memory root. Defaults to .compass',
    '  --tooling-root <path>                Owner directory for workflow files and placement defaults',
    '  --slug <slug>                        Optional project slug',
    '  --description <text>                 Optional short project description',
    '  --placement <workspace-root|dedicated-memory-repo|primary-repo>',
    '                                        Optional explicit placement pattern',
    '  --guided                             Ask placement and setup questions interactively',
    '  --repo <id=remote>                   Repeatable repo descriptor',
    '  --repo-branch <id=branch>            Optional per-repo default branch',
    '  --sync-api-url <url>                 Optional hosted sync api_url',
    '  --sync-project-id <id>               Optional hosted sync project_id',
    '  --sync-credential-env-var <name>     Optional hosted sync env var reference',
    '  --with-workflow                      Scaffold context.md and workflow guide files',
    '  --with-claude                        Create a starter CLAUDE.md if missing',
    '  --with-agents                        Create a starter AGENTS.md if missing',
    '  --start-session                      Open the first builder session after init',
    '  --session-working-on <text>          Required with --start-session outside guided mode',
    '  --session-id <lane-id>                Required with --start-session; names the first builder lane',
    '  --close-session-git-publish          Include a Git publish step in the stored close-session workflow',
    '  --close-session-git-remote <name>    Default Git remote name for that close-session publish step',
    '  --force                              Overwrite an existing project.yaml',
    '',
    'Start-session options:',
    '  --root <path>                        Project-memory root. Defaults to .compass',
    '  --tooling-root <path>                Tooling root that contains CLAUDE.md. Defaults to cwd',
    '  --working-on <text>                  Required active-session summary',
    '  --id <lane-id>                       Required active session lane ID',
    '  --feature <slug>                     Repeatable feature slug for the lane',
    '  --repo <id>                          Repeatable repo ID for the lane',
    '  --claim <path>                       Repeatable path claim for overlap warnings',
    '  --date <YYYY-MM-DD>                  Optional explicit session date',
    '  --last-thing-completed <text>        Optional override for the CLAUDE.md current-session block',
    '  --blockers <text>                    Optional current blockers summary',
    '  --next-session-should <text>         Optional current-session handoff summary',
    '',
    'Close-session options (also accepted by end-session):',
    '  --root <path>                        Project-memory root. Defaults to .compass',
    '  --tooling-root <path>                Tooling root that contains CLAUDE.md. Defaults to cwd',
    '  --title <text>                       Required display title for the finalized session note',
    '  --worked-on <text>                   Optional override for "What we worked on"',
    '  --session <lane-id>                  Active session lane to close',
    '  --completed <text>                   Repeatable completed item',
    '  --decision <text>                    Repeatable decision reference or summary',
    '  --model <text>                       Optional repeatable model contribution entry',
    '  --blocker <text>                     Repeatable blocker or open question',
    '  --next-step <text>                   Repeatable next-session step',
    '  --last-thing-completed <text>        Optional override for the CLAUDE.md completed summary',
    '  --next-session-should <text>         Optional override for the CLAUDE.md next-session summary',
    '',
    'List/switch-session options:',
    '  --root <path>                        Project-memory root. Defaults to .compass',
    '  --session <lane-id>                  Lane ID for switch-session; positional ID is also accepted',
    '',
    'Sync-agents options:',
    '  --root <path>                        Project-memory root. Defaults to .compass',
    '  --tooling-root <path>                Directory where agent files are written. Defaults to cwd',
    '  --format <name>                      Optional format: claude_md, agents_md, cursor_rules, copilot_instructions',
    '  --dry-run                            Show planned writes without changing files',
    '',
    'Sync transport options:',
    '  push --root <path>                   Push canonical local project memory to hosted',
    '  pull-preview --root <path>           Preview hosted proposals and remote state',
    '  pull-preview --no-pending-proposals  Exclude pending proposals from preview',
    '  pull-export --proposal <id>          Export a selected proposal; repeatable',
    '  pull-export --preview-token <token>  Export from a specific preview token',
    '  pull-export --output <path>          Output path under root; defaults to state/pull-export.json',
    '  apply-export --output <path>         Apply exported bundle; defaults to state/pull-export.json',
    '',
    'Docs-review options:',
    '  --root <path>                        Project-memory root. Defaults to .compass',
    '  --guided                             Accepted for the explicit comprehensive-review workflow',
    '  --submit-hosted                      Submit the generated review request to hosted sync',
    '  --poll-hosted                        Poll hosted docs-review run status and update state/docs-review.json',
    '  --complete                           Mark accepted docs-review changes as completed locally',
    '  --run-local                          Run the generated review request with a local provider',
    '  --provider <name>                    Local provider for --run-local. Currently: anthropic',
    '  --run-local-anthropic                Compatibility alias for --run-local --provider anthropic',
    '  --apply-output                       Apply accepted architecture doc blocks from review output',
    '  --output <path>                      Review output path for --apply-output; defaults to state/docs-review-output.md',
    '  --llm <name>                         Preferred LLM/provider to run the external architecture review',
    '  --model <name>                       Model name to record for the review',
    '  --anthropic-env-var <name>           Env var to use for local Anthropic docs-review runtime',
    '  --max-tokens <number>                Local Anthropic max_tokens, 1024-32000. Defaults to 16000',
  ].join('\n');
}

function createDefaultIo() {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

async function main() {
  try {
    const exitCode = await runCli(process.argv.slice(2));
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (isDirectExecution(process.argv[1], import.meta.url)) {
  main();
}

export function isDirectExecution(entryPath, moduleUrl = import.meta.url) {
  if (!entryPath) {
    return false;
  }

  try {
    return moduleUrl === pathToFileURL(realpathSync(entryPath)).href;
  } catch {
    return false;
  }
}
