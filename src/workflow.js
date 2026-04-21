export const DEFAULT_REVIEWER_HANDBACK = 'handoff-file';
export const DEFAULT_GIT_REMOTE = 'origin';

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
      },
    },
  };
}

export function buildCloseSessionGuidance(workflowSettings) {
  const guidance = [];

  guidance.push('Reviewer handback stays in sessions/wip.md and sessions/handoff.md before close-session runs.');

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
  }

  return guidance;
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
