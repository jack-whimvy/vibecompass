import { resolveSyncBinding } from './sync-binding.js';

export const DEFAULT_REVIEWER_HANDBACK = 'handoff-file';
export const DEFAULT_GIT_REMOTE = 'origin';
export const DEFAULT_COMMIT_TEMPLATE = 'docs(session): YYYY-MM-DD-N — <summary>';

/**
 * Normalize workflow defaults from either a full project config object or a
 * bare metadata block.
 */
export function resolveWorkflowSettings(projectConfigOrMetadata) {
  const metadata = isPlainObject(projectConfigOrMetadata?.metadata)
    ? projectConfigOrMetadata.metadata
    : projectConfigOrMetadata;
  const workflow = isPlainObject(metadata?.workflow) ? metadata.workflow : {};
  const closeSession = isPlainObject(workflow.close_session) ? workflow.close_session : {};

  return {
    reviewerHandback: normalizeReviewerHandback(workflow.reviewer_handback),
    closeSession: {
      refreshArchitectureDocs: closeSession.refresh_architecture_docs !== false,
      refreshDecisionFiles: closeSession.refresh_decision_files !== false,
      gitPublish: closeSession.git_publish === true,
      gitRemote: normalizeOptionalString(closeSession.git_remote) ?? DEFAULT_GIT_REMOTE,
      commitTemplate: normalizeOptionalString(closeSession.commit_template) ?? DEFAULT_COMMIT_TEMPLATE,
    },
  };
}

export function buildWorkflowMetadata(existingMetadata, overrides = {}) {
  const metadata = isPlainObject(existingMetadata) ? existingMetadata : {};
  const existingWorkflow = isPlainObject(metadata.workflow) ? metadata.workflow : {};
  const existingCloseSession = isPlainObject(existingWorkflow.close_session)
    ? existingWorkflow.close_session
    : {};
  const resolved = resolveWorkflowSettings(metadata);

  const gitPublish =
    typeof overrides.gitPublish === 'boolean'
      ? overrides.gitPublish
      : resolved.closeSession.gitPublish;
  const gitRemote =
    normalizeOptionalString(overrides.gitRemote) ??
    normalizeOptionalString(existingCloseSession.git_remote) ??
    resolved.closeSession.gitRemote;
  const commitTemplate =
    normalizeOptionalString(overrides.commitTemplate) ??
    normalizeOptionalString(existingCloseSession.commit_template) ??
    resolved.closeSession.commitTemplate;

  return {
    ...metadata,
    workflow: {
      ...existingWorkflow,
      reviewer_handback:
        normalizeOptionalString(overrides.reviewerHandback) ??
        normalizeOptionalString(existingWorkflow.reviewer_handback) ??
        resolved.reviewerHandback,
      close_session: {
        ...existingCloseSession,
        refresh_architecture_docs:
          typeof overrides.refreshArchitectureDocs === 'boolean'
            ? overrides.refreshArchitectureDocs
            : resolved.closeSession.refreshArchitectureDocs,
        refresh_decision_files:
          typeof overrides.refreshDecisionFiles === 'boolean'
            ? overrides.refreshDecisionFiles
            : resolved.closeSession.refreshDecisionFiles,
        git_publish: gitPublish,
        ...(gitPublish || normalizeOptionalString(existingCloseSession.git_remote) || normalizeOptionalString(overrides.gitRemote)
          ? { git_remote: gitRemote }
          : {}),
        commit_template: commitTemplate,
      },
    },
  };
}

export function buildCloseSessionGuidance(workflowSettings, options = {}) {
  const guidance = [];
  const projectConfig = isPlainObject(options.projectConfig) ? options.projectConfig : null;
  const rootFlag = normalizeOptionalString(options.rootFlag) ?? '--root .compass';

  guidance.push('Reviewer handback stays in the selected sessions/active/<lane-id>/wip.md and handoff.md before close-session runs.');
  guidance.push('Close-session requires document-maintenance checkpoint statuses for architecture docs, decision log, and session handoff/scratch: updated, not-needed, or deferred.');

  if (workflowSettings.closeSession.refreshArchitectureDocs) {
    guidance.push('Refresh any relevant architecture docs before finalizing the session.');
  }

  if (workflowSettings.closeSession.refreshDecisionFiles) {
    guidance.push('Refresh any relevant decision files before finalizing the session.');
  }

  if (workflowSettings.closeSession.gitPublish) {
    guidance.push(
      `This workflow includes a Git publish step after close-session; review, commit, and push to ${workflowSettings.closeSession.gitRemote}.`,
    );
    guidance.push(`Use commit message format: ${workflowSettings.closeSession.commitTemplate}`);
  }

  guidance.push(...buildHostedProjectionGuidance(projectConfig, rootFlag));

  return guidance;
}

function buildHostedProjectionGuidance(projectConfig, rootFlag) {
  if (!projectConfig) {
    return [
      'Hosted projection freshness could not be determined because project.yaml was unavailable; if this root is connected to hosted, push or refresh hosted state explicitly after close-session.',
    ];
  }

  if (projectConfig.mode === 'local-primary') {
    const binding = resolveSyncBinding(projectConfig, null);
    if (!binding) {
      return [
        'Hosted projection freshness: no hosted sync binding is configured for this local-primary root, so no hosted push command is available.',
      ];
    }

    const targetFlag = binding.target ? ` --sync-target ${binding.target}` : '';
    return [
      `Hosted projection freshness: after local canonical files are finalized, run \`vibecompass push ${rootFlag}${targetFlag}\` when the hosted dashboard should reflect this session.`,
    ];
  }

  if (projectConfig.mode === 'hosted-only') {
    return [
      'Hosted projection freshness: this root is hosted-only, so there is no authoritative local push; confirm hosted dashboard/proposal/Understanding state was updated or record it as deferred.',
    ];
  }

  return [
    'Hosted projection freshness: local-only mode has no hosted push expectation unless the project is later connected with connect-hosted.',
  ];
}

function normalizeReviewerHandback(value) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return DEFAULT_REVIEWER_HANDBACK;
  }

  return normalized;
}

function normalizeOptionalString(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}
