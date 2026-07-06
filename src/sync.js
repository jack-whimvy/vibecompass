import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256Text } from './hash.js';
import { writeStateManifest } from './manifest.js';
import { withMemoryRootLock } from './serialization.js';
import { parseSimpleYaml } from './simple-yaml.js';
import {
  buildSyncStateWithCursor,
  readSyncCursor,
  resolveSyncBinding,
} from './sync-binding.js';

const DEFAULT_EXPORT_PATH = 'state/pull-export.json';

export async function pushProjectMemory(options = {}, environment = {}) {
  const context = await loadSyncContext(options, environment);
  const existingManifest = await readJsonIfPresent(context.manifestPath);
  const manifestResult = await writeStateManifest(context.rootDir, {
    sync: existingManifest?.sync,
  });
  const manifest = manifestResult.manifest;
  const documents = await readPushDocuments(context.rootDir, manifest.documents);
  const cursor = readSyncCursor(manifest.sync, context.binding);
  const baseRemoteRevisionId = normalizeUuid(cursor.last_successful_remote_revision);
  const body = {
    ...(baseRemoteRevisionId ? { base_remote_revision_id: baseRemoteRevisionId } : {}),
    local_root_revision: manifest.canonical.local_root_revision,
    manifest_hash: manifest.canonical.manifest_hash,
    format_version: manifest.canonical.format_version,
    documents,
  };

  const response = await postJson(context, 'push', body);
  const now = new Date().toISOString();
  const sync = buildSyncStateWithCursor(manifest.sync, context.binding, {
    ...cursor,
    last_successful_remote_revision: response.remote_revision_id,
    last_successful_local_root_revision: manifest.canonical.local_root_revision,
    last_successful_manifest_hash: manifest.canonical.manifest_hash,
    last_sync_direction: 'push',
    last_sync_at: now,
    pending_previews: [],
  });
  const updatedManifest = await writeStateManifest(context.rootDir, { sync });

  return {
    status: response.status ?? 'completed',
    rootDir: context.rootDir,
    manifestPath: updatedManifest.manifestPath,
    runId: response.run_id,
    remoteRevisionId: response.remote_revision_id,
    appliedProposalIds: response.applied_proposal_ids ?? [],
    staleProposalIds: response.stale_proposal_ids ?? [],
    message: `Pushed ${documents.length} canonical document${documents.length === 1 ? '' : 's'} to hosted project memory.`,
  };
}

export async function pullPreviewProjectMemory(options = {}, environment = {}) {
  const context = await loadSyncContext(options, environment);
  const existingManifest = await readJsonIfPresent(context.manifestPath);
  const manifestResult = await writeStateManifest(context.rootDir, {
    sync: existingManifest?.sync,
  });
  const manifest = manifestResult.manifest;
  const cursor = readSyncCursor(manifest.sync, context.binding);

  const response = await postJson(context, 'pull-preview', {
    state_version: manifest.state_version,
    base_remote_revision_id: normalizeUuid(cursor.last_successful_remote_revision),
    local_root_revision: manifest.canonical.local_root_revision,
    local_manifest_hash: manifest.canonical.manifest_hash,
    local_documents: buildLocalDocumentSummaries(manifest.documents),
    include_pending_proposals: options.includePendingProposals !== false,
  });

  const previewRecord = {
    preview_token: response.preview_token,
    base_remote_revision: response.base_remote_revision_id,
    target_remote_revision: response.target_remote_revision_id,
    local_root_revision: manifest.canonical.local_root_revision,
    local_manifest_hash: manifest.canonical.manifest_hash,
    state_version: manifest.state_version,
    authoritative_change_set_hash: response.authoritative_change_set_hash,
    include_pending_proposals: options.includePendingProposals !== false,
    available_proposal_ids: Array.isArray(response.proposals)
      ? response.proposals.map((proposal) => proposal.proposal_id)
      : [],
    conflicts: Array.isArray(response.conflicts) ? response.conflicts : [],
    created_at: response.created_at ?? new Date().toISOString(),
    expires_at: response.expires_at,
  };
  const sync = buildSyncStateWithCursor(manifest.sync, context.binding, {
    ...cursor,
    pending_previews: [
      ...(Array.isArray(cursor.pending_previews) ? cursor.pending_previews : []),
      previewRecord,
    ].slice(-5),
  });
  const updatedManifest = await writeStateManifest(context.rootDir, { sync });

  return {
    status: 'preview-created',
    rootDir: context.rootDir,
    manifestPath: updatedManifest.manifestPath,
    previewToken: response.preview_token,
    proposals: response.proposals ?? [],
    conflicts: response.conflicts ?? [],
    warnings: response.warnings ?? [],
    message: `Created pull preview with ${(response.proposals ?? []).length} pending proposal${(response.proposals ?? []).length === 1 ? '' : 's'}.`,
  };
}

export async function pullExportProjectMemory(options = {}, environment = {}) {
  const context = await loadSyncContext(options, environment);
  const manifest = await readRequiredManifest(context.manifestPath);
  const preview = resolvePreview(manifest, options.previewToken, context.binding);
  const proposalIds = options.proposalIds?.length
    ? options.proposalIds
    : preview.available_proposal_ids ?? [];

  if (proposalIds.length === 0) {
    throw new Error('pull-export requires at least one --proposal or a preview with available proposals.');
  }

  const response = await postJson(context, 'pull-export', {
    preview_token: preview.preview_token,
    proposal_ids: proposalIds,
  });
  const outputPath = path.resolve(context.rootDir, options.outputPath ?? DEFAULT_EXPORT_PATH);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(response, null, 2)}\n`, 'utf8');

  return {
    status: 'exported',
    rootDir: context.rootDir,
    outputPath,
    runId: response.run_id,
    operationCount: Array.isArray(response.operations) ? response.operations.length : 0,
    proposalIds: response.proposal_ids ?? proposalIds,
    message: `Exported ${response.operations?.length ?? 0} proposal operation${(response.operations?.length ?? 0) === 1 ? '' : 's'} to ${outputPath}.`,
  };
}

export async function applyPullExport(options = {}, environment = {}) {
  const cwd = environment.cwd ? path.resolve(environment.cwd) : process.cwd();
  const rootDir = path.resolve(cwd, options.rootDir ?? '.compass');
  return withMemoryRootLock(rootDir, 'apply-export', () => applyPullExportLocked(options, rootDir));
}

async function applyPullExportLocked(options, rootDir) {
  const outputPath = path.resolve(rootDir, options.outputPath ?? DEFAULT_EXPORT_PATH);
  const bundle = await readJsonRequired(outputPath, 'pull-export bundle');
  const operations = Array.isArray(bundle.operations) ? bundle.operations : [];
  if (operations.length === 0) {
    throw new Error(`Pull-export bundle at ${outputPath} has no operations.`);
  }

  const applied = [];
  for (const operation of operations) {
    const relativePath = normalizeCanonicalPath(operation.path);
    const targetPath = path.join(rootDir, relativePath);
    const currentHash = await readCurrentHash(targetPath);
    const expectedBefore = operation.before_content_hash ?? null;
    if (currentHash !== expectedBefore) {
      throw new Error(
        `Cannot apply ${relativePath}: local content hash ${currentHash ?? 'missing'} does not match expected ${expectedBefore ?? 'missing'}. Run pull-preview again or resolve locally.`,
      );
    }

    if (operation.op === 'delete') {
      await unlink(targetPath);
      applied.push({ path: relativePath, status: 'deleted' });
      continue;
    }

    if (operation.op !== 'write' || typeof operation.raw_text !== 'string') {
      throw new Error(`Unsupported operation for ${relativePath}.`);
    }
    const afterHash = sha256Text(operation.raw_text);
    if (afterHash !== operation.after_content_hash) {
      throw new Error(`Exported content hash does not match raw_text for ${relativePath}.`);
    }

    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, ensureTrailingNewline(operation.raw_text), 'utf8');
    applied.push({ path: relativePath, status: 'written' });
  }

  bundle.applied_at = new Date().toISOString();
  bundle.applied = applied;
  await writeFile(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');

  return {
    status: 'applied',
    rootDir,
    outputPath,
    applied,
    proposalIds: bundle.proposal_ids ?? [],
    message: `Applied ${applied.length} exported proposal operation${applied.length === 1 ? '' : 's'}. Run vibecompass push to confirm applied proposals.`,
  };
}

async function loadSyncContext(options, environment) {
  const cwd = environment.cwd ? path.resolve(environment.cwd) : process.cwd();
  const rootDir = path.resolve(cwd, options.rootDir ?? '.compass');
  const projectFilePath = path.join(rootDir, 'project.yaml');
  const manifestPath = path.join(rootDir, 'state', 'manifest.json');
  const project = parseSimpleYaml(await readFile(projectFilePath, 'utf8'), {
    sourceName: projectFilePath,
  });

  if (project.mode !== 'local-primary') {
    throw new Error('Hosted sync commands require project.yaml mode: local-primary.');
  }

  const binding = resolveSyncBinding(project, options.syncTarget ?? null);
  if (!binding) {
    throw new Error('Hosted sync commands require sync.api_url, sync.project_id, and sync.credential_env_var in project.yaml (or a named target under sync.targets).');
  }

  const credential = normalizeOptionalString((environment.env ?? process.env)[binding.credentialEnvVar]);
  if (!credential) {
    throw new Error(
      `Hosted sync command requires ${binding.credentialEnvVar}. New terminals do not inherit one-off exports: `
      + `re-export it (export ${binding.credentialEnvVar}="<sync token>") or persist it in your shell profile (~/.zshenv or ~/.bashrc). `
      + 'Lost the token? Rotate it on the hosted dashboard under Setup -> Hosted sync, then export the new value.',
    );
  }

  const fetchImpl = environment.runtime?.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Hosted sync command requires a fetch implementation.');
  }

  return {
    rootDir,
    project,
    manifestPath,
    fetch: fetchImpl,
    credential,
    apiUrl: binding.apiUrl,
    projectId: binding.projectId,
    syncTarget: binding.target,
    binding,
  };
}

async function postJson(context, routeName, body) {
  const endpoint = new URL(
    `api/sync/projects/${encodeURIComponent(context.projectId)}/${routeName}`,
    ensureTrailingSlash(context.apiUrl),
  );
  const response = await context.fetch(endpoint.href, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${context.credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const responseText = typeof response.text === 'function' ? await response.text() : '';
    throw new Error(`Hosted ${routeName} failed with ${response.status}${responseText ? `: ${responseText}` : ''}`);
  }

  return typeof response.json === 'function' ? response.json() : {};
}

async function readPushDocuments(rootDir, documents) {
  const result = [];
  for (const [relativePath, metadata] of Object.entries(documents)) {
    const normalizedPath = normalizeCanonicalPath(relativePath);
    const rawText = await readFile(path.join(rootDir, normalizedPath), 'utf8');
    result.push({
      path: normalizedPath,
      kind: metadata.kind,
      content_hash: metadata.content_hash,
      byte_length: metadata.byte_length,
      raw_text: rawText,
    });
  }

  result.sort((left, right) => left.path.localeCompare(right.path));
  return result;
}

function buildLocalDocumentSummaries(documents) {
  return Object.entries(documents ?? {}).map(([relativePath, metadata]) => ({
    path: normalizeCanonicalPath(relativePath),
    kind: metadata.kind,
    content_hash: metadata.content_hash,
    extracted: buildLocalDocumentExtractedSummary(metadata.kind, metadata.extracted),
  }));
}

function buildLocalDocumentExtractedSummary(kind, extracted = {}) {
  if (!extracted || typeof extracted !== 'object') return {};

  if (kind === 'session') {
    return {
      ...(typeof extracted.title === 'string' ? { title: extracted.title } : {}),
      ...(typeof extracted.session_date === 'string' ? { session_date: extracted.session_date } : {}),
      ...(Number.isInteger(extracted.session_number)
        ? { session_number: extracted.session_number }
        : {}),
    };
  }

  if (kind === 'decision') {
    return {
      ...(Array.isArray(extracted.decision_ids)
        ? {
          decision_ids: extracted.decision_ids.filter(
            (value) => Number.isInteger(value) && value > 0,
          ),
        }
        : {}),
    };
  }

  return {};
}

function resolvePreview(manifest, previewToken, binding) {
  const cursor = readSyncCursor(manifest.sync, binding);
  const previews = Array.isArray(cursor.pending_previews)
    ? cursor.pending_previews
    : [];
  if (previewToken) {
    const match = previews.find((preview) => preview.preview_token === previewToken);
    if (!match) {
      throw new Error(`Preview token ${previewToken} was not found in state/manifest.json.`);
    }
    return match;
  }

  const latest = previews[previews.length - 1];
  if (!latest) {
    throw new Error('pull-export requires a pending preview. Run vibecompass pull-preview first.');
  }
  return latest;
}

async function readRequiredManifest(manifestPath) {
  return readJsonRequired(manifestPath, 'state manifest');
}

async function readJsonRequired(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read ${label} at ${filePath}: ${error.message}`);
  }
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readCurrentHash(filePath) {
  try {
    return sha256Text(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function normalizeCanonicalPath(value) {
  if (
    typeof value !== 'string' ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some((part) => part === '..' || part === '') ||
    value.startsWith('state/') ||
    value.startsWith('sessions/active/')
  ) {
    throw new Error(`Invalid canonical path: ${value}`);
  }

  return value;
}

function ensureTrailingNewline(value) {
  return value.endsWith('\n') ? value : `${value}\n`;
}

function normalizeOptionalString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeUuid(value) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
    ? normalized
    : null;
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}
