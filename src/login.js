import { execFile as nodeExecFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connectHostedProjectMemory } from './init.js';
import { parseSimpleYaml } from './simple-yaml.js';
import { resolveSyncBinding } from './sync-binding.js';
import {
  credentialStoreOptionsFrom,
  normalizeApiUrl,
  storeSyncCredential,
} from './credential-store.js';
import { PACKAGE_VERSION } from './version.js';

/**
 * Browser device-code sign-in for hosted sync (D-355).
 *
 * The CLI asks the hosted app for a device code, shows (and opens) the
 * verification link plus a short user code, and polls until the signed-in
 * project owner approves the code in the dashboard. The claim response is the
 * only place the plaintext token ever exists: the CLI stores it in the local
 * credential store and, when the root has no sync binding yet, writes the
 * non-secret binding into project.yaml exactly as `connect-hosted` would.
 */

export const DEFAULT_HOSTED_API_URL = 'https://vibecompass.dev';
export const DEFAULT_SYNC_CREDENTIAL_ENV_VAR = 'VIBECOMPASS_SYNC_TOKEN';
export const DEVICE_AUTH_START_ROUTE = 'api/cli/device-auth';
export const DEVICE_AUTH_TOKEN_ROUTE = 'api/cli/device-auth/token';
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_POLL_TIMEOUT_SECONDS = 600;
const REQUEST_TIMEOUT_MS = 15_000;
const VALID_MODES = new Set(['local-only', 'local-primary', 'hosted-only']);

export async function loginHosted(options = {}, environment = {}) {
  const cwd = environment.cwd ? path.resolve(environment.cwd) : process.cwd();
  const rootDir = path.resolve(cwd, options.rootDir ?? '.compass');
  const projectFilePath = path.join(rootDir, 'project.yaml');
  const io = environment.io ?? {};
  const write = (text) => (io.stdout ?? process.stdout).write(text);
  const fetchImpl = environment.runtime?.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('login requires a fetch implementation.');
  }
  const sleep = environment.runtime?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = environment.runtime?.now ?? (() => Date.now());

  let project;
  try {
    project = parseSimpleYaml(await readFile(projectFilePath, 'utf8'), { sourceName: projectFilePath });
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(`No project.yaml found in ${rootDir}. Run "vibecompass init" first, then "vibecompass login".`);
    }
    throw error;
  }
  if (!VALID_MODES.has(project.mode)) {
    throw new Error('login requires project.yaml mode to be local-only, local-primary, or hosted-only.');
  }

  const binding = resolveLoginBinding(project, options);
  const apiUrl = binding?.apiUrl ?? options.apiUrl ?? DEFAULT_HOSTED_API_URL;
  if (binding && options.apiUrl && normalizeApiUrl(options.apiUrl) !== normalizeApiUrl(binding.apiUrl)) {
    throw new Error(
      `--api-url ${options.apiUrl} does not match the bound hosted URL ${binding.apiUrl}${binding.target ? ` for target ${binding.target}` : ''}. `
      + 'Pass --sync-target <name> to sign in to a different environment, or rebind with connect-hosted.',
    );
  }
  const projectHint = binding?.projectId ?? options.projectId ?? null;
  const credentialEnvVar = binding?.credentialEnvVar ?? options.credentialEnvVar ?? DEFAULT_SYNC_CREDENTIAL_ENV_VAR;

  // Every network wait (start, each poll, and body reads) is bounded by the
  // overall deadline so a stalled server can never outlive --poll-timeout.
  const requestedTimeoutSeconds = positiveNumber(options.pollTimeoutSeconds, DEFAULT_POLL_TIMEOUT_SECONDS);
  let deadline = now() + requestedTimeoutSeconds * 1000;
  const timing = { now, deadline: () => deadline };

  const start = await postJson(fetchImpl, apiUrl, DEVICE_AUTH_START_ROUTE, {
    ...(projectHint ? { project_id: projectHint } : {}),
    label: options.label ?? os.hostname(),
    package_version: PACKAGE_VERSION,
  }, timing);
  if (!start.ok) {
    throw new Error(`Hosted sign-in could not start (HTTP ${start.status}${start.body?.error ? `: ${start.body.error}` : ''}). Check the hosted URL ${apiUrl} and try again.`);
  }
  const deviceCode = requireString(start.body, 'device_code');
  const userCode = requireString(start.body, 'user_code');
  const verificationUri = requireString(start.body, 'verification_uri_complete', 'verification_uri');
  const expiresIn = positiveNumber(start.body.expires_in, DEFAULT_POLL_TIMEOUT_SECONDS);
  let intervalMs = positiveNumber(start.body.interval, DEFAULT_POLL_INTERVAL_SECONDS) * 1000;

  write('Sign in to VibeCompass\n');
  write(`Open: ${verificationUri}\n`);
  write(`Code: ${userCode}\n`);
  if (!options.noBrowser) {
    const opened = await openBrowser(verificationUri, environment);
    write(opened ? 'Opening your browser…\n' : 'Could not open a browser automatically; paste the link into any browser.\n');
  }
  write(`Waiting for approval in the dashboard (expires in ${Math.round(expiresIn / 60)} minutes)…\n`);

  deadline = Math.min(deadline, now() + expiresIn * 1000);
  let claim = null;
  while (!claim) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error('Timed out waiting for the sign-in to be approved. Run "vibecompass login" again.');
    }
    await sleep(Math.min(intervalMs, remaining));
    const poll = await postJson(fetchImpl, apiUrl, DEVICE_AUTH_TOKEN_ROUTE, { device_code: deviceCode }, timing);
    if (poll.ok && poll.body?.status === 'approved') {
      claim = poll.body;
      break;
    }
    const code = typeof poll.body?.error === 'string' ? poll.body.error : null;
    if (code === 'authorization_pending') {
      continue;
    }
    if (code === 'slow_down') {
      intervalMs += 5000;
      continue;
    }
    if (code === 'expired_token') {
      throw new Error('The sign-in code expired before it was approved. Run "vibecompass login" again.');
    }
    if (code === 'access_denied') {
      throw new Error('The sign-in request was denied in the dashboard.');
    }
    throw new Error(`Hosted sign-in failed (HTTP ${poll.status}${code ? `: ${code}` : ''}).`);
  }

  const token = requireString(claim, 'token');
  const approvedProject = claim.project && typeof claim.project === 'object' ? claim.project : {};
  const projectId = requireString(approvedProject, 'id');
  const projectName = typeof approvedProject.name === 'string' ? approvedProject.name : projectId;

  const stored = await storeSyncCredential(
    {
      apiUrl,
      projectId,
      token,
      label: `VibeCompass sync token (${projectName})`,
      source: 'login',
      backend: options.credentialStore,
    },
    credentialStoreOptionsFrom(environment),
  );

  const warnings = [];
  let bindingWritten = null;
  if (!binding) {
    bindingWritten = await connectHostedProjectMemory({
      cwd,
      rootDir: options.rootDir ?? '.compass',
      ...(options.syncTarget ? { targetName: options.syncTarget } : {}),
      sync: { apiUrl, projectId, credentialEnvVar },
    });
  } else if (binding.projectId !== projectId) {
    warnings.push(
      `This root is bound to project ${binding.projectId}${binding.target ? ` (target ${binding.target})` : ''}, but you approved ${projectName} (${projectId}). `
      + `The token is stored for the approved project; rebind with "vibecompass connect-hosted${binding.target ? ` --target ${binding.target}` : ''} --sync-api-url ${apiUrl} --sync-project-id ${projectId} --sync-credential-env-var ${credentialEnvVar}" if that was intended.`,
    );
  }

  return {
    apiUrl,
    project: { id: projectId, name: projectName },
    credential: claim.credential && typeof claim.credential === 'object' ? claim.credential : null,
    stored,
    binding: bindingWritten,
    previousBinding: binding,
    mode: bindingWritten?.mode ?? project.mode,
    warnings,
  };
}

function resolveLoginBinding(project, options) {
  try {
    return resolveSyncBinding(project, options.syncTarget ?? null);
  } catch (error) {
    // An unknown --sync-target may be created by login only when the caller
    // is explicit about which hosted environment it points at (D-236: a typo
    // must never silently land in another environment).
    if (options.syncTarget && options.apiUrl) {
      return null;
    }
    throw new Error(`${error.message} To create it through login, add --api-url <hosted url>.`);
  }
}

async function postJson(fetchImpl, apiUrl, routeName, body, timing) {
  const endpoint = new URL(routeName, apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`);
  const remaining = timing ? timing.deadline() - timing.now() : REQUEST_TIMEOUT_MS;
  if (remaining <= 0) {
    throw new Error('Timed out waiting for the sign-in to be approved. Run "vibecompass login" again.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, remaining));
  try {
    let response;
    try {
      response = await fetchImpl(endpoint.href, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Hosted sign-in request to ${endpoint.origin} timed out. Check the connection and run "vibecompass login" again.`);
      }
      throw new Error(`Could not reach ${endpoint.origin} (${error?.message ?? 'network error'}).`);
    }
    let parsed = null;
    try {
      parsed = typeof response.json === 'function' ? await response.json() : null;
    } catch {
      if (controller.signal.aborted) {
        throw new Error(`Hosted sign-in response from ${endpoint.origin} stalled. Check the connection and run "vibecompass login" again.`);
      }
      parsed = null;
    }
    return { ok: Boolean(response.ok), status: response.status, body: parsed && typeof parsed === 'object' ? parsed : {} };
  } finally {
    clearTimeout(timer);
  }
}

async function openBrowser(url, environment) {
  const platform = environment.runtime?.platform ?? process.platform;
  const execFileImpl = environment.runtime?.execFile ?? nodeExecFile;
  const [file, args] = platform === 'darwin'
    ? ['open', [url]]
    : platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  return new Promise((resolve) => {
    try {
      execFileImpl(file, args, { windowsHide: true }, (error) => resolve(!error));
    } catch {
      resolve(false);
    }
  });
}

function requireString(source, ...keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  throw new Error(`Hosted sign-in response is missing ${keys[0]}.`);
}

function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
