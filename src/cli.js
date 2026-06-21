#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { connectHostedProjectMemory, initializeProjectMemory, setDefaultSyncTarget } from './init.js';
import { preflightDocsReview } from './docs-review.js';
import { planDocsUpdate, renderDocsUpdatePlan } from './docs-update.js';
import { resolveConnectHostedCliOptions, resolveInitCliOptions } from './setup.js';
import { closeProjectSession, listProjectSessions, startProjectSession, switchProjectSession } from './session.js';
import { syncAgentInstructionFiles } from './generators/agent-files/index.js';
import { getProjectStatus, renderStatusText, toStatusJson } from './status.js';
import { refreshWorkflow } from './refresh-workflow.js';
import { inspectProjectCompatibility, formatCompatibilityWarnings } from './compatibility.js';
import { PACKAGE_VERSION } from './version.js';
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

  if (parsed.command === 'version') {
    io.stdout.write(`${PACKAGE_VERSION}\n`);
    return 0;
  }

  if (parsed.command === 'init') {
    const initPlan = await resolveInitCliOptions(parsed.options, {
      cwd: runtime.cwd,
      io,
      runtime,
    });
    if (initPlan.existingProject) {
      return writeExistingInitProjectResult(io, initPlan.existingProject);
    }

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
      const rootFlag = formatOptionalRootFlag(initPlan.initOptions.rootDir);
      io.stdout.write(`Hosted binding: configured for ${initPlan.initOptions.mode}\n`);
      io.stdout.write(`Next step: set ${result.syncEnvVar} locally before your first hosted command.\n`);
      if (initPlan.initOptions.mode === 'local-primary') {
        io.stdout.write(`Then run: vibecompass push${rootFlag}\n`);
        io.stdout.write(`Hosted docs-review: vibecompass docs-review --submit-hosted${rootFlag}\n`);
      } else if (initPlan.initOptions.mode === 'hosted-only') {
        io.stdout.write(`Hosted docs-review: vibecompass docs-review --submit-hosted${rootFlag}\n`);
      }
    } else if (initPlan.initOptions.mode === 'hosted-only') {
      io.stdout.write('Hosted-only projects need a hosted sync binding before hosted commands.\n');
      io.stdout.write('After creating a sync credential, rerun init with --force and --sync-api-url/--sync-project-id/--sync-credential-env-var, or add project.yaml.sync manually.\n');
    } else if (initPlan.initOptions.mode === 'local-primary') {
      io.stdout.write('Optional hosted setup later: vibecompass connect-hosted\n');
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

    if (initPlan.agentFileSyncPlan) {
      const agentFileSync = await syncAgentInstructionFiles({
        ...initPlan.agentFileSyncPlan,
        ...(runtime.cwd ? { cwd: runtime.cwd } : {}),
      });
      writeAgentFileSyncResult(io, agentFileSync);
    }

    if (initPlan.sessionPlan) {
      const sessionResult = await startProjectSession({
        rootDir: initPlan.initOptions.rootDir,
        toolingRootDir: initPlan.initOptions.toolingRootDir,
        sessionId: initPlan.sessionPlan.sessionId,
        workingOn: initPlan.sessionPlan.workingOn,
        repos: initPlan.sessionPlan.repos,
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
    await writeCompatibilityPreflightWarnings(io, parsed.options, runtime);
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

  if (parsed.command === 'connect-hosted') {
    await writeCompatibilityPreflightWarnings(io, parsed.options, runtime);
    const connectPlan = await resolveConnectHostedCliOptions(parsed.options, {
      cwd: runtime.cwd,
      io,
      runtime,
    });
    const result = await connectHostedProjectMemory({
      ...connectPlan,
      ...(runtime.cwd ? { cwd: runtime.cwd } : {}),
    });
    io.stdout.write(`Connected hosted VibeCompass for ${result.mode}\n`);
    io.stdout.write(`Updated ${result.projectFilePath}\n`);
    if (result.syncTarget) {
      io.stdout.write(`Sync target: ${result.syncTarget.name} (default: ${result.syncTarget.defaultTarget})\n`);
      io.stdout.write(`Select per command with --sync-target ${result.syncTarget.name}, or switch the default with: vibecompass sync-target ${result.syncTarget.name}\n`);
    }
    io.stdout.write(`Next step: set ${result.syncEnvVar} locally before your first hosted command.\n`);
    if (result.mode === 'local-primary') {
      io.stdout.write('Then run: vibecompass push\n');
      io.stdout.write('Hosted docs-review: vibecompass docs-review --submit-hosted\n');
    } else {
      io.stdout.write('Hosted docs-review: vibecompass docs-review --submit-hosted\n');
    }
    return 0;
  }

  if (parsed.command === 'sync-target') {
    const result = await setDefaultSyncTarget({
      ...parsed.options,
      ...(runtime.cwd ? { cwd: runtime.cwd } : {}),
    });
    if (parsed.options.targetName) {
      io.stdout.write(
        result.changed
          ? `Default sync target set to ${result.defaultTarget}\n`
          : `Default sync target already ${result.defaultTarget}\n`,
      );
      io.stdout.write(`Updated ${result.projectFilePath}\n`);
    } else {
      io.stdout.write(`Default sync target: ${result.defaultTarget ?? '(none)'}\n`);
    }
    for (const [name, target] of Object.entries(result.targets)) {
      const marker = name === result.defaultTarget ? '*' : ' ';
      io.stdout.write(`${marker} ${name}: ${target.api_url} (project ${target.project_id}, env ${target.credential_env_var})\n`);
    }
    return 0;
  }

  if (parsed.command === 'status') {
    const result = await getProjectStatus({
      ...parsed.options,
      ...(runtime.cwd ? { cwd: runtime.cwd } : {}),
    });
    if (parsed.options.json) {
      io.stdout.write(`${JSON.stringify(toStatusJson(result), null, 2)}\n`);
    } else {
      io.stdout.write(renderStatusText(result));
    }
    return 0;
  }

  if (parsed.command === 'refresh-workflow') {
    const result = await refreshWorkflow({
      ...parsed.options,
      ...(runtime.cwd ? { cwd: runtime.cwd } : {}),
    });
    writeRefreshWorkflowResult(io, result);
    return 0;
  }

  if (parsed.command === 'docs-update') {
    await writeCompatibilityPreflightWarnings(io, parsed.options, runtime);
    const result = await planDocsUpdate({
      ...parsed.options,
      ...(runtime.cwd ? { cwd: runtime.cwd } : {}),
    });
    if (parsed.options.json) {
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      io.stdout.write(renderDocsUpdatePlan(result));
    }
    return 0;
  }

  if (parsed.command === 'close-session' || parsed.command === 'end-session') {
    await writeCompatibilityPreflightWarnings(io, parsed.options, runtime);
    const result = await closeProjectSession({
      ...parsed.options,
      ...(runtime.cwd ? { cwd: runtime.cwd } : {}),
    });
    io.stdout.write(`Closed session ${result.sessionDate}-${result.sessionNumber}\n`);
    io.stdout.write(`Wrote ${result.sessionFilePath}\n`);
    io.stdout.write(`Updated ${result.claudePath}\n`);
    if (result.docsUpdatePlan) {
      io.stdout.write(renderDocsUpdatePlan(result.docsUpdatePlan));
    }
    writeDocumentMaintenanceCheckpoint(io, result.documentMaintenance);
    if (result.workflowGuidance.length > 0) {
      io.stdout.write('Workflow guidance:\n');
      for (const item of result.workflowGuidance) {
        io.stdout.write(`- ${item}\n`);
      }
    }
    writeWarnings(io, result.warnings);
    writeAgentFileSyncResult(io, result.agentFileSync);
    return 0;
  }

  if (parsed.command === 'list-sessions') {
    await writeCompatibilityPreflightWarnings(io, parsed.options, runtime);
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
    await writeCompatibilityPreflightWarnings(io, parsed.options, runtime);
    const result = await switchProjectSession({
      ...parsed.options,
      ...(runtime.cwd ? { cwd: runtime.cwd } : {}),
    });
    io.stdout.write(`Current session lane: ${result.current}\n`);
    io.stdout.write(`Updated ${result.claudePath}\n`);
    writeWarnings(io, result.warnings);
    writeAgentFileSyncResult(io, result.agentFileSync);
    return 0;
  }

  if (parsed.command === 'sync-agents') {
    await writeCompatibilityPreflightWarnings(io, parsed.options, runtime);
    const result = await syncAgentInstructionFiles({
      ...parsed.options,
      ...(runtime.cwd ? { cwd: runtime.cwd } : {}),
    });
    writeAgentFileSyncResult(io, result);
    return 0;
  }

  if (parsed.command === 'docs-review') {
    await writeCompatibilityPreflightWarnings(io, parsed.options, runtime);
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
    if (result.sourceInventory) {
      io.stdout.write(`Source inventory: ${result.sourceInventory.summary.item_count} items`);
      if (result.sourceInventory.summary.warning_count > 0) {
        io.stdout.write(` (${result.sourceInventory.summary.warning_count} warnings)`);
      }
      io.stdout.write('\n');
    }
    if (result.rebuild) {
      io.stdout.write(`Rebuild scope: ${result.rebuild.scope_path}\n`);
      io.stdout.write(`Stale policy: ${result.rebuild.stale_policy}\n`);
      io.stdout.write(`Architecture docs: ${result.rebuild.architecture_doc_count}\n`);
      for (const entry of result.rebuild.architecture_docs) {
        io.stdout.write(`- ${entry.path} (${entry.action}${entry.archive_path ? ` -> ${entry.archive_path}` : ''})\n`);
      }
    }
    if (result.applied) {
      io.stdout.write(`Applied architecture docs: ${result.applied.architecture_docs.length}\n`);
      for (const entry of result.applied.architecture_docs) {
        io.stdout.write(`- ${entry.path} (${entry.status})\n`);
      }
      if (result.applied.coverage) {
        io.stdout.write(`Applied coverage plan: ${result.applied.coverage.area_count} areas`);
        if (typeof result.applied.coverage.coverage_score === 'number') {
          io.stdout.write(` (${Math.round(result.applied.coverage.coverage_score * 100)}% accepted)`);
        }
        io.stdout.write('\n');
      }
      if (Array.isArray(result.applied.decision_candidates) && result.applied.decision_candidates.length > 0) {
        io.stdout.write(`Applied decision recommendations: ${result.applied.decision_candidates.length}\n`);
        for (const entry of result.applied.decision_candidates) {
          io.stdout.write(`- D-${String(entry.decision_id).padStart(3, '0')}: ${entry.title} (${entry.target_path})\n`);
        }
      }
    }
    if (result.appliedDecisionArtifact) {
      io.stdout.write(`Applied decision artifact: ${result.appliedDecisionArtifact.artifact_id}\n`);
      io.stdout.write(`Decision: D-${String(result.appliedDecisionArtifact.decision_id).padStart(3, '0')}\n`);
      io.stdout.write(`Target: ${result.appliedDecisionArtifact.target_path}\n`);
    }
    writeWarnings(io, result.warnings);
    if (result.recorded !== false) {
      io.stdout.write(`Recorded ${result.statePath}\n`);
    }
    io.stdout.write(`${result.message}\n`);
    if (result.reviewPrompt) {
      io.stdout.write('Architecture review prompt:\n');
      io.stdout.write(`${result.reviewPrompt}\n`);
    }
    return 0;
  }

  if (parsed.command === 'push') {
    await writeCompatibilityPreflightWarnings(io, parsed.options, runtime);
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
    await writeCompatibilityPreflightWarnings(io, parsed.options, runtime);
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
    if (result.conflicts.length > 0) {
      io.stdout.write(`Conflicts: ${result.conflicts.length}\n`);
      for (const conflict of result.conflicts) {
        io.stdout.write(`- ${conflict.code}: ${conflict.message}\n`);
      }
    }
    writeWarnings(io, result.warnings.map((warning) => `${warning.code}: ${warning.message}`));
    io.stdout.write(`Recorded ${result.manifestPath}\n`);
    io.stdout.write(`${result.message}\n`);
    return 0;
  }

  if (parsed.command === 'pull-export') {
    await writeCompatibilityPreflightWarnings(io, parsed.options, runtime);
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
    await writeCompatibilityPreflightWarnings(io, parsed.options, runtime);
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

  if (command === 'version' || command === '--version' || command === '-v') {
    return { command: 'version' };
  }

  if (command !== 'init') {
    if (command === 'start-session') {
      return parseStartSessionArgs(rest);
    }

    if (command === 'connect-hosted') {
      return parseConnectHostedArgs(rest);
    }

    if (command === 'sync-target') {
      return parseSyncTargetArgs(rest);
    }

    if (command === 'status') {
      return parseStatusArgs(rest);
    }

    if (command === 'refresh-workflow') {
      return parseRefreshWorkflowArgs(rest);
    }

    if (command === 'docs-update') {
      return parseDocsUpdateArgs(rest);
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

    if (token === '--replace-active-lanes') {
      parsed.replaceActiveLanes = true;
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

    if (token === '--adopt-existing-agent-files') {
      parsed.adoptExistingAgentFiles = true;
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
      case '--repo-local': {
        const [id, repoPath] = splitAssignment(value, '--repo-local');
        parsed.repos.push({ id, source: 'local', path: repoPath });
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
      replaceActiveLanes: parsed.replaceActiveLanes,
      startSession: parsed.startSession,
      sessionWorkingOn: parsed.sessionWorkingOn,
      sessionId: parsed.sessionId,
      closeSessionGitPublish: parsed.closeSessionGitPublish,
      closeSessionGitRemote: parsed.closeSessionGitRemote,
      adoptExistingAgentFiles: parsed.adoptExistingAgentFiles,
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

function parseConnectHostedArgs(argv) {
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
      case '--target':
        parsed.targetName = value;
        break;
      case '--sync-api-url':
        parsed.syncApiUrl = value;
        break;
      case '--sync-project-id':
        parsed.syncProjectId = value;
        break;
      case '--sync-credential-env-var':
        parsed.syncCredentialEnvVar = value;
        break;
      default:
        throw new Error(`Unknown flag "${token}".`);
    }
  }

  const syncValues = [
    parsed.syncApiUrl,
    parsed.syncProjectId,
    parsed.syncCredentialEnvVar,
  ].filter(Boolean);

  return {
    command: 'connect-hosted',
    options: {
      rootDir: parsed.rootDir,
      ...(parsed.targetName ? { targetName: parsed.targetName } : {}),
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

function parseStatusArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--json') {
      parsed.json = true;
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
      default:
        throw new Error(`Unknown flag "${token}".`);
    }
  }

  return {
    command: 'status',
    options: parsed,
  };
}

function parseRefreshWorkflowArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--dry-run') {
      parsed.apply = false;
      continue;
    }

    if (token === '--apply') {
      parsed.apply = true;
      continue;
    }

    if (token === '--update-package-stamp') {
      parsed.updatePackageStamp = true;
      continue;
    }

    if (token === '--allow-downgrade-templates') {
      parsed.allowDowngradeTemplates = true;
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
      default:
        throw new Error(`Unknown flag "${token}".`);
    }
  }

  return {
    command: 'refresh-workflow',
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
    documentMaintenance: {},
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
      case '--architecture-docs':
        parsed.documentMaintenance.architectureDocs = value;
        break;
      case '--decision-log':
        parsed.documentMaintenance.decisionLog = value;
        break;
      case '--session-maintenance':
        parsed.documentMaintenance.sessionMaintenance = value;
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

function parseDocsUpdateArgs(argv) {
  const parsed = {
    changedFiles: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--json') {
      parsed.json = true;
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
      case '--session':
        parsed.sessionId = value;
        break;
      case '--changed':
        parsed.changedFiles.push(value);
        break;
      default:
        throw new Error(`Unknown flag "${token}".`);
    }
  }

  return {
    command: 'docs-update',
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

    if (token === '--adopt-existing') {
      parsed.adoptExisting = true;
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

    if (token === '--rebuild') {
      parsed.rebuild = true;
      continue;
    }

    if (token === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }

    if (token === '--apply') {
      parsed.apply = true;
      continue;
    }

    if (token === '--apply-decision-artifact') {
      parsed.applyDecisionArtifact = true;
      continue;
    }

    if (token === '--refresh-index') {
      parsed.refreshIndex = true;
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
      case '--path':
        parsed.scopePath = value;
        break;
      case '--stale-policy':
        parsed.stalePolicy = value;
        break;
      case '--artifact':
        parsed.artifactId = value;
        break;
      case '--sync-target':
        parsed.syncTarget = value;
        break;
      case '--source-root': {
        const [repoId, sourceRootPath] = splitAssignment(value, '--source-root');
        parsed.sourceRootOverrides = [
          ...(parsed.sourceRootOverrides ?? []),
          { repoId, path: sourceRootPath },
        ];
        break;
      }
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
    options: parseRootAndSyncTargetArgs(argv, 'push'),
  };
}

function parseRootAndSyncTargetArgs(argv, commandName) {
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
      case '--sync-target':
        parsed.syncTarget = value;
        break;
      default:
        throw new Error(`Unknown flag "${token}" for ${commandName}.`);
    }
  }

  return parsed;
}

function parseSyncTargetArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith('--')) {
      if (parsed.targetName !== undefined) {
        throw new Error(`Unexpected argument "${token}".`);
      }
      parsed.targetName = token;
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
      default:
        throw new Error(`Unknown flag "${token}" for sync-target.`);
    }
  }

  return {
    command: 'sync-target',
    options: parsed,
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
      case '--sync-target':
        parsed.syncTarget = value;
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
      case '--sync-target':
        parsed.syncTarget = value;
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
    if (item.conflicts?.length > 0) {
      const lineNumbers = item.conflicts.map((conflict) => conflict.line).join(', ');
      io.stderr.write(`  possible workflow overlap on lines ${lineNumbers}; review existing instructions if behavior conflicts.\n`);
    }
  }
}

function writeRefreshWorkflowResult(io, result) {
  io.stdout.write(`${result.dryRun ? 'Planned' : 'Applied'} workflow refresh for ${result.rootDir}\n`);
  writeCompatibilityWarnings(io, result.compatibility);
  io.stdout.write('Project package stamp:\n');
  const projectSuffix = result.projectFile.warning ? ` — ${result.projectFile.warning}` : '';
  const projectStatus = result.dryRun && result.projectFile.changed
    ? `dry-run-${result.projectFile.status}`
    : result.projectFile.status;
  io.stdout.write(`- project.yaml: ${projectStatus}${projectSuffix}\n`);

  io.stdout.write('Workflow files:\n');
  for (const file of result.workflowFiles) {
    const suffix = file.warning ? ` — ${file.warning}` : '';
    io.stdout.write(`- ${file.relativePath}: ${result.dryRun && file.changed ? `dry-run-${file.status}` : file.status}${suffix}\n`);
  }

  io.stdout.write('State manifest:\n');
  io.stdout.write(`- ${result.manifest.path}: ${result.manifest.status} (${result.manifest.documentCount} canonical docs, ${result.manifest.warningCount} warnings)\n`);
  writeAgentFileSyncResult(io, result.agentFileSync);
}

function writeDocumentMaintenanceCheckpoint(io, documentMaintenance) {
  if (!documentMaintenance) {
    return;
  }

  io.stdout.write('Document maintenance checkpoint:\n');
  io.stdout.write(`- Architecture docs: ${documentMaintenance.architectureDocs}\n`);
  io.stdout.write(`- Decision log: ${documentMaintenance.decisionLog}\n`);
  io.stdout.write(`- Session handoff/scratch: ${documentMaintenance.sessionMaintenance}\n`);
}

async function writeCompatibilityPreflightWarnings(io, options = {}, runtime = {}) {
  const result = await inspectProjectCompatibility({
    ...options,
    ...(runtime.cwd ? { cwd: runtime.cwd } : {}),
  });
  writeCompatibilityWarnings(io, result);
}

function writeCompatibilityWarnings(io, result) {
  const warnings = formatCompatibilityWarnings(result);
  if (warnings.length === 0) {
    return;
  }

  io.stderr.write('Compatibility warnings:\n');
  writeWarnings(io, warnings);
  io.stderr.write('Run `vibecompass status` for detail.\n');
}

function writeWarnings(io, warnings = []) {
  for (const warning of warnings) {
    io.stderr.write(`Warning: ${warning}\n`);
  }
}

function splitAssignment(value, flagName) {
  const separatorIndex = value.indexOf('=');
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    if (flagName === '--repo' && separatorIndex > 0 && separatorIndex === value.length - 1) {
      throw new Error(
        '--repo remote resolved to empty. For a non-Git folder, use --repo-local <id=path> instead of --repo <id=remote>.',
      );
    }
    throw new Error(`${flagName} expects id=value.`);
  }

  return [value.slice(0, separatorIndex), value.slice(separatorIndex + 1)];
}

function usageText() {
  return [
    'Usage:',
    '  vibecompass --version',
    '  vibecompass version',
    '  vibecompass init --name <project-name> --mode <local-only|local-primary|hosted-only> --repo <id=remote> [options]',
    '  vibecompass connect-hosted [options]',
    '  vibecompass sync-target [<name>] [options]',
    '  vibecompass status [options]',
    '  vibecompass refresh-workflow [--dry-run|--apply] [options]',
    '  vibecompass docs-update [--session <lane-id>] [options]',
    '  vibecompass start-session --id <lane-id> --working-on <text> [options]',
    '  vibecompass close-session --title <text> --completed <text> --architecture-docs <status> --decision-log <status> --session-maintenance <status> [options]',
    '  vibecompass end-session --title <text> --completed <text> --architecture-docs <status> --decision-log <status> --session-maintenance <status> [options]  # alias',
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
    '  --repo <id=remote>                   Repeatable Git-backed repo descriptor',
    '  --repo-local <id=path>               Repeatable local folder source for non-Git projects',
    '  --repo-branch <id=branch>            Optional per-repo default branch',
    '  --sync-api-url <url>                 Optional hosted sync api_url',
    '  --sync-project-id <id>               Optional hosted sync project_id',
    '  --sync-credential-env-var <name>     Optional hosted sync env var reference',
    '  --with-workflow                      Scaffold context.md and workflow guide files',
    '  --with-claude                        Create a starter CLAUDE.md if missing',
    '  --with-agents                        Create a starter AGENTS.md if missing',
    '  --adopt-existing-agent-files         Adopt existing unmarked agent files after init',
    '  --start-session                      Open the first builder session after init',
    '  --session-working-on <text>          Required with --start-session outside guided mode',
    '  --session-id <lane-id>                Required with --start-session; names the first builder lane',
    '  --close-session-git-publish          Include a Git publish step in the stored close-session workflow',
    '  --close-session-git-remote <name>    Default Git remote name for that close-session publish step',
    '  --force                              Overwrite an existing project.yaml',
    '  --replace-active-lanes               Allow --force to replace a root that has active session lanes',
    '',
    'Connect-hosted options:',
    '  --root <path>                        Project-memory root. Defaults to .compass',
    '  --target <name>                      Add or update a named sync target (e.g. dev, prod)',
    '                                        First named target becomes the default; flat sync fields mirror the default target',
    '  --sync-api-url <url>                 Hosted sync api_url',
    '  --sync-project-id <id>               Hosted sync project_id',
    '  --sync-credential-env-var <name>     Hosted sync env var reference',
    '                                        Without --target, replaces any existing flat project.yaml sync binding',
    '',
    'Sync-target options:',
    '  vibecompass sync-target              List named sync targets and the current default',
    '  vibecompass sync-target <name>       Switch the default sync target (re-mirrors flat sync fields)',
    '  --root <path>                        Project-memory root. Defaults to .compass',
    '',
    'Status options:',
    '  --root <path>                        Project-memory root. Defaults to .compass',
    '  --tooling-root <path>                Directory where agent files are inspected. Defaults to cwd',
    '  --json                               Print the typed status model as JSON',
    '',
    'Refresh-workflow options:',
    '  --root <path>                        Project-memory root. Defaults to .compass',
    '  --tooling-root <path>                Directory where agent files are refreshed. Defaults to cwd',
    '  --dry-run                            Show planned refresh without changing files (default)',
    '  --apply                              Apply the planned workflow refresh',
    '  --update-package-stamp               Update an existing project.yaml package_version stamp',
    '  --allow-downgrade-templates          Allow applying templates with a CLI older than the root stamp',
    '',
    'Docs-update options:',
    '  --root <path>                        Project-memory root. Defaults to .compass',
    '  --session <lane-id>                  Active session lane to inspect; defaults to current lane',
    '  --changed <repo:path|path>           Repeatable explicit changed path; defaults to git status when omitted',
    '  --json                               Print the typed docs-update plan as JSON',
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
    '  --architecture-docs <status>         Required checkpoint: updated|not-needed|deferred',
    '  --decision-log <status>              Required checkpoint: updated|not-needed|deferred',
    '  --session-maintenance <status>       Required checkpoint: updated|not-needed|deferred',
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
    '  --adopt-existing                     Append managed blocks to existing unmarked files',
    '  --dry-run                            Show planned writes without changing files',
    '',
    'Sync transport options:',
    '  push --root <path>                   Push canonical local project memory to hosted',
    '  --sync-target <name>                 Use a named sync target for this command (push, pull-preview, pull-export, docs-review)',
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
    '  --source-root <id=path>              Repeatable run-local source root override for Git-backed repos',
    '  --provider <name>                    Local provider for --run-local. Currently: anthropic',
    '  --run-local-anthropic                Compatibility alias for --run-local --provider anthropic',
    '  --apply-output                       Apply accepted architecture doc blocks from review output',
    '  --output <path>                      Review output path for --apply-output; defaults to state/docs-review-output.md',
    '  --rebuild                            Preview or prepare an explicit architecture-doc rebuild',
    '  --dry-run                            Preview docs-review rebuild changes; default with --rebuild',
    '  --apply                              Apply docs-review rebuild preparation; only valid with --rebuild',
    '  --path <architecture/path>           Scope --rebuild to an architecture directory',
    '  --stale-policy <keep|archive>        Rebuild stale-doc handling; defaults to keep',
    '  --apply-decision-artifact            Append an accepted hosted decision artifact locally',
    '  --artifact <id>                      Artifact ID for --apply-decision-artifact',
    '  --refresh-index                      Also regenerate decisions/INDEX.md after applying a decision artifact',
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

function formatOptionalRootFlag(rootDir) {
  if (!rootDir || rootDir === '.compass') {
    return '';
  }

  return ` --root ${rootDir}`;
}

function writeExistingInitProjectResult(io, existingProject) {
  const rootFlag = formatOptionalRootFlag(existingProject.displayPath);
  const active = existingProject.activeSummary ?? { count: 0, current: null };

  if (existingProject.status === 'ambiguous') {
    (io.stderr ?? process.stderr).write(
      [
        'Multiple VibeCompass project memory roots found:',
        ...existingProject.candidates.map((candidate) => `- ${candidate.displayPath}`),
        'Pass --root explicitly to choose one.',
        '',
      ].join('\n'),
    );
    return 1;
  }

  if (existingProject.status === 'unreadable') {
    (io.stderr ?? process.stderr).write('VibeCompass project memory already exists, but project.yaml is unreadable.\n');
    (io.stderr ?? process.stderr).write(`Root: ${existingProject.displayPath}\n`);
    (io.stderr ?? process.stderr).write(`Project file: ${existingProject.projectFilePath}\n`);
    (io.stderr ?? process.stderr).write(`Error: ${existingProject.errorMessage}\n`);
    if (active.count > 0) {
      (io.stderr ?? process.stderr).write(`Active lanes: ${formatActiveLaneSummary(active)}\n`);
      (io.stderr ?? process.stderr).write('Close active lanes before replacing this root, or pass --force --replace-active-lanes if replacement is intentional.\n');
    } else {
      (io.stderr ?? process.stderr).write('Fix project.yaml manually, or rerun with --force if replacement is intentional.\n');
    }
    return 1;
  }

  const config = existingProject.projectConfig;
  const repos = Array.isArray(config.repos)
    ? config.repos.map((repo) => repo.id).filter(Boolean)
    : [];
  io.stdout.write('VibeCompass is already initialized — here is how to continue.\n');
  io.stdout.write(`Project: ${config.name ?? 'Unknown'}\n`);
  io.stdout.write(`Mode: ${config.mode ?? 'Unknown'}\n`);
  io.stdout.write(`Root: ${existingProject.displayPath}\n`);
  io.stdout.write(`Repos: ${repos.length > 0 ? repos.join(', ') : 'None recorded'}\n`);
  io.stdout.write(`Active lanes: ${formatActiveLaneSummary(active)}\n`);
  io.stdout.write('Next commands:\n');
  io.stdout.write(`- vibecompass status${rootFlag}\n`);
  io.stdout.write(`- vibecompass list-sessions${rootFlag}\n`);
  io.stdout.write(`- vibecompass start-session${rootFlag} --id LANE_ID --working-on "TASK"\n`);
  io.stdout.write(`- vibecompass docs-review${rootFlag} --guided\n`);
  io.stdout.write(`- vibecompass sync-agents${rootFlag}\n`);
  if (['local-primary', 'hosted-only'].includes(config.mode)) {
    io.stdout.write(`- vibecompass connect-hosted${rootFlag}\n`);
  }
  return 0;
}

function formatActiveLaneSummary(activeSummary) {
  if (!activeSummary || activeSummary.count === 0) {
    return 'none';
  }

  return `${activeSummary.count}${activeSummary.current ? ` (current: ${activeSummary.current})` : ''}`;
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
