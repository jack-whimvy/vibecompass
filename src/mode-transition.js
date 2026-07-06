import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSimpleYaml } from './simple-yaml.js';
import { resolveSyncBinding } from './sync-binding.js';
import { withMemoryRootLock } from './serialization.js';
import { adoptRemoteHead, pushProjectMemory } from './sync.js';

const PROMOTED_MARKER = ['state', 'promoted-root.json'];

/**
 * D-288 promote: local-primary -> hosted-only as a crash-safe, resumable
 * two-phase transition. Fresh verified push baseline -> server records the
 * intent (with a completeness report) -> local changes (project.yaml mode,
 * promoted-root marker, agent guidance) -> server confirm. `--resume`
 * continues an interrupted run from whatever state it reached; `--abort`
 * backs the whole thing out on both sides.
 */
export async function promoteHosted(options = {}, environment = {}) {
  const cwd = environment.cwd ? path.resolve(environment.cwd) : process.cwd();
  const rootDir = path.resolve(cwd, options.rootDir ?? '.compass');
  return withMemoryRootLock(rootDir, 'promote-hosted', () =>
    promoteHostedLocked(options, environment, rootDir),
  );
}

async function promoteHostedLocked(options, environment, rootDir) {
  const context = await loadModeAgnosticSyncContext(rootDir, options, environment);
  const server = await getJson(context, 'status');
  const localMode = context.project.mode;
  const notes = [];

  if (options.abort === true) {
    // A confirmed promotion cannot be aborted: the server is already
    // hosted-only, and rewriting only the local record would create exactly
    // the split-brain the two-phase flow exists to prevent. Reversing a
    // finished cutover is demote-hosted's job.
    if (server.mode === 'hosted-only' && !server.pending_mode_transition) {
      throw new Error(
        'This promotion was already confirmed — the hosted project is hosted-only. '
        + 'Aborting now would only rewrite the local record and split the two mode records. '
        + 'Use vibecompass demote-hosted to reverse the cutover on both sides.',
      );
    }
    await postJson(context, 'mode-transition', { action: 'abort' });
    if (localMode === 'hosted-only') {
      await writeProjectMode(rootDir, 'local-primary');
      await removePromotedMarker(rootDir);
      notes.push('Restored local project.yaml to local-primary and removed the promoted-root marker.');
    }
    return {
      status: 'aborted',
      rootDir,
      warnings: notes,
      message: 'Promotion aborted; the project remains local-primary on both sides.',
    };
  }

  if (server.mode === 'hosted-only' && localMode === 'hosted-only' && !server.pending_mode_transition) {
    await ensurePromotedMarker(rootDir, context);
    return {
      status: 'already-promoted',
      rootDir,
      warnings: [],
      message: 'This project is already hosted-only on both sides.',
    };
  }

  const resuming = options.resume === true || Boolean(server.pending_mode_transition) || localMode === 'hosted-only';
  let completeness = null;

  if (localMode === 'local-primary') {
    // Phase 1: fresh verified baseline. Idempotent push makes retries safe.
    const pushResult = await pushProjectMemory(
      { rootDir, syncTarget: options.syncTarget ?? null },
      environment,
    );
    notes.push(`Baseline push: ${pushResult.status} (${pushResult.remoteRevisionId}).`);

    const manifest = JSON.parse(await readFile(path.join(rootDir, 'state', 'manifest.json'), 'utf8'));
    const begin = await postJson(context, 'mode-transition', {
      action: 'begin',
      target_mode: 'hosted-only',
      expected_manifest_hash: manifest.canonical.manifest_hash,
    });
    completeness = begin.completeness ?? null;

    // Phase 2: local changes.
    await writeProjectMode(rootDir, 'hosted-only');
    await ensurePromotedMarker(rootDir, context);
  } else if (resuming) {
    // Crash-window repair: the mode flipped locally but the marker (or the
    // confirm) may be missing.
    await ensurePromotedMarker(rootDir, context);
  } else {
    throw new Error(`promote-hosted requires a local-primary root (found mode: ${localMode ?? 'unknown'}).`);
  }

  // Phase 3: confirm (safe to retry; the server treats a repeated confirm as done).
  await postJson(context, 'mode-transition', { action: 'confirm', target_mode: 'hosted-only' });

  notes.push(
    'Agent re-pointing: hosted context is now canonical. In your MCP configuration set VIBECOMPASS_API_KEY '
    + '(create a key on the hosted Setup page), remove VIBECOMPASS_ROOT, and restart your MCP server. '
    + 'Agent instruction files keep working for reading; canonical writes belong on the hosted dashboard.',
  );
  notes.push(
    'This root is now a promoted working copy: canonical write commands refuse by default '
    + '(vibecompass demote-hosted reverses the cutover; VIBECOMPASS_ALLOW_PROMOTED_ROOT_WRITES=1 overrides deliberately).',
  );

  return {
    status: resuming && localMode !== 'local-primary' ? 'resumed-and-promoted' : 'promoted',
    rootDir,
    completeness,
    warnings: notes,
    message: 'Promotion complete: the hosted app is now this project\'s source of truth (both mode records agree).',
  };
}

/**
 * D-289 demote: hosted-only -> local-primary. Run from a local root that
 * holds the hosted content (freshly bootstrapped from the export bundle, or
 * the original promoted root). Flips both records via the same two-phase
 * endpoint, then adopts the hosted head as the sync cursor so the first push
 * works immediately.
 */
export async function demoteHosted(options = {}, environment = {}) {
  const cwd = environment.cwd ? path.resolve(environment.cwd) : process.cwd();
  const rootDir = path.resolve(cwd, options.rootDir ?? '.compass');
  return withMemoryRootLock(rootDir, 'demote-hosted', () =>
    demoteHostedLocked(options, environment, rootDir),
  );
}

async function demoteHostedLocked(options, environment, rootDir) {
  const context = await loadModeAgnosticSyncContext(rootDir, options, environment);
  const server = await getJson(context, 'status');
  const notes = [];

  if (server.mode === 'local-primary' && context.project.mode === 'local-primary') {
    return {
      status: 'already-local-primary',
      rootDir,
      warnings: [],
      message: 'This project is already local-primary on both sides.',
    };
  }

  if (server.mode === 'hosted-only') {
    await postJson(context, 'mode-transition', { action: 'begin', target_mode: 'local-primary' });
  }
  if (context.project.mode !== 'local-primary') {
    await writeProjectMode(rootDir, 'local-primary');
    notes.push('Local project.yaml mode set to local-primary.');
  }
  await removePromotedMarker(rootDir);
  await postJson(context, 'mode-transition', { action: 'confirm', target_mode: 'local-primary' });

  // Adopt the hosted head as this root's baseline so the first push has the
  // correct parent (bundle-restored roots already carry it; this makes the
  // flow correct for any root).
  const adoption = await adoptRemoteHead(
    {
      rootDir,
      syncTarget: options.syncTarget ?? null,
      acceptDivergence: options.acceptDivergence === true,
    },
    environment,
  );
  notes.push(adoption.message);

  return {
    status: 'demoted',
    rootDir,
    warnings: notes,
    message: 'Demotion complete: this local root is canonical again (local-primary on both sides). Local files win; push to publish changes.',
  };
}

async function loadModeAgnosticSyncContext(rootDir, options, environment) {
  const projectFilePath = path.join(rootDir, 'project.yaml');
  const project = parseSimpleYaml(await readFile(projectFilePath, 'utf8'), {
    sourceName: projectFilePath,
  });
  const binding = resolveSyncBinding(project, options.syncTarget ?? null);
  if (!binding) {
    throw new Error('Mode transitions require a sync binding in project.yaml (run connect-hosted first).');
  }
  const credential = ((environment.env ?? process.env)[binding.credentialEnvVar] ?? '').trim();
  if (!credential) {
    throw new Error(`Mode transitions require ${binding.credentialEnvVar} to be set.`);
  }
  const fetchImpl = environment.runtime?.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Mode transitions require a fetch implementation.');
  }
  return { rootDir, project, binding, credential, fetch: fetchImpl };
}

function endpointUrl(context, routeName) {
  const base = context.binding.apiUrl.endsWith('/')
    ? context.binding.apiUrl
    : `${context.binding.apiUrl}/`;
  return new URL(
    `api/sync/projects/${encodeURIComponent(context.binding.projectId)}/${routeName}`,
    base,
  ).href;
}

async function getJson(context, routeName) {
  const response = await context.fetch(endpointUrl(context, routeName), {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${context.credential}`,
    },
  });
  if (!response.ok) {
    const text = typeof response.text === 'function' ? await response.text() : '';
    throw new Error(`Hosted ${routeName} failed with ${response.status}${text ? `: ${text}` : ''}`);
  }
  return typeof response.json === 'function' ? response.json() : {};
}

async function postJson(context, routeName, body) {
  const response = await context.fetch(endpointUrl(context, routeName), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${context.credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = typeof response.text === 'function' ? await response.text() : '';
    throw new Error(`Hosted ${routeName} failed with ${response.status}${text ? `: ${text}` : ''}`);
  }
  return typeof response.json === 'function' ? response.json() : {};
}

async function writeProjectMode(rootDir, mode) {
  const projectFilePath = path.join(rootDir, 'project.yaml');
  const raw = await readFile(projectFilePath, 'utf8');
  const next = raw.replace(/^mode:\s*\S+\s*$/m, `mode: ${mode}`);
  if (next === raw && !new RegExp(`^mode:\\s*${mode}\\s*$`, 'm').test(raw)) {
    throw new Error(`Could not update the mode line in ${projectFilePath}; edit it to "mode: ${mode}" and re-run with --resume.`);
  }
  await writeFile(projectFilePath, next, 'utf8');
}

async function ensurePromotedMarker(rootDir, context) {
  const markerPath = path.join(rootDir, ...PROMOTED_MARKER);
  await mkdir(path.dirname(markerPath), { recursive: true });
  const marker = {
    promoted_at: new Date().toISOString(),
    api_url: context.binding.apiUrl,
    project_id: context.binding.projectId,
    note: 'This root was promoted to hosted-only (D-288). The hosted app is canonical; local canonical writes refuse by default.',
  };
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
}

async function removePromotedMarker(rootDir) {
  await rm(path.join(rootDir, ...PROMOTED_MARKER), { force: true });
}
