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

  // Pre-validate EVERY operation before writing anything, and classify
  // operations whose target already matches the after-state as
  // already-applied. This makes a retry after a partial failure converge
  // instead of failing forever on the ops that succeeded last time.
  const plan = [];
  for (const operation of operations) {
    const relativePath = normalizeCanonicalPath(operation.path);
    const targetPath = path.join(rootDir, relativePath);
    const currentHash = await readCurrentHash(targetPath);
    const expectedBefore = operation.before_content_hash ?? null;

    if (operation.op === 'delete') {
      if (currentHash === null) {
        plan.push({ relativePath, targetPath, action: 'skip', status: 'already-deleted' });
        continue;
      }
      if (currentHash !== expectedBefore) {
        throw new Error(
          `Cannot apply ${relativePath}: local content hash ${currentHash} does not match expected ${expectedBefore ?? 'missing'}. Run pull-preview again or resolve locally.`,
        );
      }
      plan.push({ relativePath, targetPath, action: 'delete' });
      continue;
    }

    if (operation.op !== 'write' || typeof operation.raw_text !== 'string') {
      throw new Error(`Unsupported operation for ${relativePath}.`);
    }
    const afterHash = sha256Text(operation.raw_text);
    if (afterHash !== operation.after_content_hash) {
      throw new Error(`Exported content hash does not match raw_text for ${relativePath}.`);
    }
    if (currentHash === afterHash) {
      plan.push({ relativePath, targetPath, action: 'skip', status: 'already-applied' });
      continue;
    }
    if (currentHash !== expectedBefore) {
      throw new Error(
        `Cannot apply ${relativePath}: local content hash ${currentHash ?? 'missing'} does not match expected ${expectedBefore ?? 'missing'}. Run pull-preview again or resolve locally.`,
      );
    }
    plan.push({ relativePath, targetPath, action: 'write', rawText: operation.raw_text });
  }

  const applied = [];
  for (const step of plan) {
    if (step.action === 'skip') {
      applied.push({ path: step.relativePath, status: step.status });
      continue;
    }
    if (step.action === 'delete') {
      await unlink(step.targetPath);
      applied.push({ path: step.relativePath, status: 'deleted' });
      continue;
    }
    await mkdir(path.dirname(step.targetPath), { recursive: true });
    await writeFile(step.targetPath, ensureTrailingNewline(step.rawText), 'utf8');
    applied.push({ path: step.relativePath, status: 'written' });
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

/**
 * Re-baselines this root's sync cursor onto the hosted head (D-287 sync
 * trust): the recovery path for a fresh clone or second device whose
 * gitignored cursor is missing, which previously hit a permanent 409
 * needs_rebase. Preserves D-215's inspect-then-choose workflow: a pull
 * preview always runs first, and pending hosted proposals or conflicts
 * refuse the adopt unless --accept-divergence is passed.
 */
export async function adoptRemoteHead(options = {}, environment = {}) {
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
    include_pending_proposals: true,
  });

  const targetRemoteRevisionId = normalizeUuid(response.target_remote_revision_id);
  if (!targetRemoteRevisionId) {
    throw new Error('The hosted project has no baseline revision to adopt yet. Run vibecompass push first.');
  }

  const proposals = Array.isArray(response.proposals) ? response.proposals : [];
  const conflicts = Array.isArray(response.conflicts) ? response.conflicts : [];
  if ((proposals.length > 0 || conflicts.length > 0) && options.acceptDivergence !== true) {
    throw new Error(
      `Refusing to adopt the hosted head: ${proposals.length} pending proposal${proposals.length === 1 ? '' : 's'} and ${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'} exist for this project (D-215: inspect divergence before choosing a baseline). Review with vibecompass pull-preview, then re-run sync-adopt --accept-divergence to adopt anyway.`,
    );
  }

  const sync = buildSyncStateWithCursor(manifest.sync, context.binding, {
    ...cursor,
    last_successful_remote_revision: targetRemoteRevisionId,
    last_successful_local_root_revision: manifest.canonical.local_root_revision,
    last_successful_manifest_hash: manifest.canonical.manifest_hash,
    last_sync_direction: 'adopt',
    last_sync_at: new Date().toISOString(),
    pending_previews: [],
  });
  const updatedManifest = await writeStateManifest(context.rootDir, { sync });

  return {
    status: 'adopted',
    rootDir: context.rootDir,
    manifestPath: updatedManifest.manifestPath,
    remoteRevisionId: targetRemoteRevisionId,
    proposalCount: proposals.length,
    conflictCount: conflicts.length,
    warnings: [
      'The next push will record this root\'s content as a new revision on top of the adopted head. If local files differ from the hosted head, the hosted content is replaced (visibly, as a new revision).',
    ],
    message: `Adopted hosted head ${targetRemoteRevisionId} as this root's sync baseline.`,
  };
}

/**
 * Materializes a complete local memory root from a hosted bootstrap bundle
 * (D-289): the escape hatch, disaster-recovery, and second-device path. All
 * document hashes are verified before anything is written (fail closed). For
 * local-primary bundles with a resolvable sync binding, the bundle's server
 * head is seeded as the sync cursor so the first push has the correct parent;
 * hosted-only bundles materialize a fully usable offline root (the server
 * rejects hosted-only push until the project is demoted).
 */
export async function bootstrapFromBundle(options = {}, environment = {}) {
  const cwd = environment.cwd ? path.resolve(environment.cwd) : process.cwd();
  const rootDir = path.resolve(cwd, options.rootDir ?? '.compass');
  if (!options.bundlePath) {
    throw new Error('bootstrap requires --bundle <file> (download it from the hosted Setup page).');
  }
  const bundlePath = path.resolve(cwd, options.bundlePath);
  return withMemoryRootLock(rootDir, 'bootstrap', () =>
    bootstrapFromBundleLocked(options, rootDir, bundlePath),
  );
}

async function bootstrapFromBundleLocked(options, rootDir, bundlePath) {
  const bundle = await readJsonRequired(bundlePath, 'bootstrap bundle');
  if (bundle.bundle_kind !== 'bootstrap_export') {
    throw new Error(
      `File at ${bundlePath} is not a bootstrap bundle (bundle_kind: ${bundle.bundle_kind ?? 'missing'}).`,
    );
  }
  const documents = Array.isArray(bundle.documents) ? bundle.documents : [];
  if (documents.length === 0) {
    throw new Error(`Bootstrap bundle at ${bundlePath} has no documents.`);
  }

  const projectFilePath = path.join(rootDir, 'project.yaml');
  let existingProjectFile = false;
  try {
    await readFile(projectFilePath, 'utf8');
    existingProjectFile = true;
  } catch {
    existingProjectFile = false;
  }
  if (existingProjectFile) {
    throw new Error(
      `${rootDir} already contains project.yaml. Bootstrap only materializes fresh roots — pick an empty --root or move the existing one aside.`,
    );
  }

  // Fail closed BEFORE writing anything: verify every document's hash and
  // path, and require the bundle to carry project.yaml.
  let hasProjectFile = false;
  const validated = documents.map((document) => {
    const relativePath = normalizeCanonicalPath(document.path);
    if (document.op !== 'write' || typeof document.raw_text !== 'string') {
      throw new Error(`Unsupported bootstrap operation for ${relativePath}.`);
    }
    const hash = sha256Text(document.raw_text);
    if (hash !== document.after_content_hash) {
      throw new Error(
        `Bootstrap bundle content hash does not match raw_text for ${relativePath}. The bundle is corrupt — download it again.`,
      );
    }
    if (relativePath === 'project.yaml') hasProjectFile = true;
    return { relativePath, rawText: document.raw_text };
  });
  if (!hasProjectFile) {
    throw new Error('Bootstrap bundle does not include project.yaml.');
  }

  // Content is written verbatim (no newline normalization) so the local root
  // byte-matches the hosted head the bundle's cursor points at.
  const written = [];
  for (const document of validated) {
    const targetPath = path.join(rootDir, document.relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, document.rawText, 'utf8');
    written.push(document.relativePath);
  }

  const warnings = [];
  let manifestPath = null;
  let cursorSeeded = false;
  let projectMode = null;
  try {
    const project = parseSimpleYaml(await readFile(projectFilePath, 'utf8'), {
      sourceName: projectFilePath,
    });
    projectMode = typeof project.mode === 'string' ? project.mode : null;

    let sync;
    const serverHead = bundle.server_head ?? null;
    if (projectMode === 'local-primary' && serverHead?.remote_revision_id) {
      const binding = resolveSyncBinding(project, options.syncTarget ?? null);
      if (binding) {
        const manifestResult = await writeStateManifest(rootDir);
        sync = buildSyncStateWithCursor(manifestResult.manifest.sync, binding, {
          last_successful_remote_revision: serverHead.remote_revision_id,
          last_successful_local_root_revision:
            manifestResult.manifest.canonical.local_root_revision,
          last_successful_manifest_hash:
            manifestResult.manifest.canonical.manifest_hash,
          last_sync_direction: 'bootstrap',
          last_sync_at: new Date().toISOString(),
          pending_previews: [],
        });
        cursorSeeded = true;
      } else {
        warnings.push(
          'No sync binding found in the bundled project.yaml; run connect-hosted before pushing.',
        );
      }
    }
    const manifestResult = await writeStateManifest(rootDir, sync ? { sync } : undefined);
    manifestPath = manifestResult.manifestPath;
  } catch (error) {
    warnings.push(
      `Documents were written, but the state manifest could not be generated: ${error.message}`,
    );
  }

  if (projectMode === 'hosted-only') {
    warnings.push(
      'This is a hosted-only project: the root is fully usable offline, but hosted sync rejects local push until the project is demoted to local-primary.',
    );
  }

  return {
    status: 'bootstrapped',
    rootDir,
    manifestPath,
    documentCount: written.length,
    mode: projectMode,
    cursorSeeded,
    warnings,
    message: `Materialized ${written.length} document${written.length === 1 ? '' : 's'} into ${rootDir}${cursorSeeded ? ' and seeded the sync cursor from the bundle head' : ''}.`,
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
    throw new Error(
      `Hosted sync commands require project.yaml mode: local-primary (this root says "${project.mode}"). `
      + 'Mode is recorded twice — locally in project.yaml and on the hosted project — and they must agree. '
      + 'Run vibecompass status to compare both records; use promote-hosted/demote-hosted to change modes on both sides together instead of hand-editing.',
    );
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
