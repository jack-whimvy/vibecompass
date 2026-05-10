import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { localRevisionFromManifestHash, stableHash } from './hash.js';
import { scanProjectMemory } from './project-memory.js';
import { listProjectSessions } from './session.js';

export const STATE_VERSION = 1;

export function generateStateManifest(scanResult, options = {}) {
  if (scanResult.errors.length > 0) {
    const details = scanResult.errors.map((error) => `${error.path}: ${error.message}`).join('\n');
    throw new Error(`Cannot generate state manifest with canonical parse errors.\n${details}`);
  }

  const generatedAt = toIsoString(options.generatedAt ?? new Date());
  const manifestDocuments = {};
  const manifestInventory = [];
  let warningCount = 0;

  for (const document of scanResult.documents) {
    manifestInventory.push({
      path: document.path,
      kind: document.kind,
      content_hash: document.contentHash,
      byte_length: document.byteLength,
    });

    warningCount += document.warnings.length;

    manifestDocuments[document.path] = {
      kind: document.kind,
      content_hash: document.contentHash,
      byte_length: document.byteLength,
      warnings: document.warnings,
      extracted: document.extracted,
    };
  }

  const manifestHash = stableHash(manifestInventory);
  const projectExtracted = scanResult.project.extracted ?? {};

  return {
    state_version: STATE_VERSION,
    generated_at: generatedAt,
    canonical: {
      format_version: projectExtracted.format_version,
      mode: projectExtracted.mode,
      local_root_revision: localRevisionFromManifestHash(manifestHash),
      manifest_hash: manifestHash,
      document_count: manifestInventory.length,
      warning_count: warningCount,
    },
    documents: manifestDocuments,
    ...(options.activeSessions ? { active_sessions: options.activeSessions } : {}),
    ...(options.sync ? { sync: options.sync } : {}),
  };
}

export async function writeStateManifest(rootDir, options = {}) {
  const scanResult = await scanProjectMemory(rootDir);
  const activeSessions = await readActiveSessionsForManifest(rootDir);
  const existingSync = Object.hasOwn(options, 'sync')
    ? options.sync
    : await readExistingSyncState(rootDir);
  const manifest = generateStateManifest(scanResult, {
    ...options,
    ...(existingSync ? { sync: existingSync } : {}),
    ...(activeSessions ? { activeSessions } : {}),
  });
  const stateDir = path.join(rootDir, 'state');
  const manifestPath = path.join(stateDir, 'manifest.json');

  await mkdir(stateDir, { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return {
    manifest,
    manifestPath,
    scanResult,
  };
}

async function readExistingSyncState(rootDir) {
  try {
    const existing = JSON.parse(
      await readFile(path.join(rootDir, 'state', 'manifest.json'), 'utf8'),
    );
    return existing?.sync && typeof existing.sync === 'object'
      ? existing.sync
      : null;
  } catch {
    return null;
  }
}

async function readActiveSessionsForManifest(rootDir) {
  const sessions = await listProjectSessions({ rootDir });
  if (sessions.lanes.length === 0 && !sessions.current) {
    return null;
  }

  return {
    current: sessions.current,
    lanes: sessions.lanes.map((lane) => ({
      id: lane.id,
      status: lane.status ?? 'active',
      working_on: lane.workingOn,
      feature_slugs: lane.features ?? [],
      repos: lane.repos ?? [],
      claimed_paths: lane.claims ?? [],
      started_at: lane.startedAt ?? null,
      ...(lane.decisionSnapshot
        ? {
          decision_snapshot: {
            highest_decision_id: lane.decisionSnapshot.highestDecisionId ?? null,
          },
        }
        : {}),
    })),
  };
}

function toIsoString(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
