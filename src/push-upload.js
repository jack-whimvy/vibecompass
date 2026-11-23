import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

// The hosted push's large path: a push body over 4,000,000 bytes goes
// gzip-compressed to the app in parts, and a commit applies it at most once.
// Smaller pushes keep the single request.

export const INLINE_PUSH_MAX_BYTES = 4_000_000;
/** What an older app's single-request route accepted (its own body cap). */
export const LEGACY_SINGLE_MAX_BYTES = 5_000_000;
export const UPLOAD_MAX_DOCUMENT_BYTES = 4_000_000;
export const UPLOAD_MAX_PACKED_BYTES = 25_000_000;
export const UPLOAD_MAX_UNPACKED_BYTES = 50_000_000;
/** Every response on the push path is read under this cap. */
export const RESPONSE_READ_CAP_BYTES = 16_000_000;
const POLL_INTERVAL_MS = 15_000;
const POLL_BUDGET_MS = 6 * 60 * 1000;
const POLL_MAX_REQUESTS = 24;
const DETAILS_BUDGET_MS = 60_000;

/**
 * A push that ended without applying, or whose outcome is unknown. `outcome`
 * says which: `refused_before_upload` (nothing was sent), `refused` (the
 * hosted memory didn't change), or `unknown`.
 */
export class PushOutcomeError extends Error {
  constructor(message, { outcome, status = null, code = null } = {}) {
    super(message);
    this.name = 'PushOutcomeError';
    this.outcome = outcome;
    this.status = status;
    this.code = code;
  }
}

function megabytes(bytes) {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * Which way a push goes, by its serialized UTF-8 bytes: the single request up
 * to 4,000,000 bytes; the single request too for a body up to 5,000,000 bytes
 * that holds a document over 4,000,000 bytes (what was sent before, so
 * nothing an older route accepted is refused); otherwise the upload.
 */
export function choosePushTransport(bodyBytes, documents) {
  if (bodyBytes <= INLINE_PUSH_MAX_BYTES) return 'single';
  if (
    bodyBytes <= LEGACY_SINGLE_MAX_BYTES &&
    documents.some((document) => Buffer.byteLength(document.raw_text, 'utf8') > UPLOAD_MAX_DOCUMENT_BYTES)
  ) {
    return 'single-large';
  }
  return 'upload';
}

function endpoint(context, route) {
  const base = context.apiUrl.endsWith('/') ? context.apiUrl : `${context.apiUrl}/`;
  return new URL(`api/sync/projects/${encodeURIComponent(context.projectId)}/${route}`, base).href;
}

/** Reads a response body under a byte cap; a longer body is an error, never buffered whole. */
export async function readResponseText(response, cap = RESPONSE_READ_CAP_BYTES) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = typeof response.text === 'function' ? await response.text() : '';
    if (Buffer.byteLength(text, 'utf8') > cap) throw new Error(`The hosted app's answer was larger than ${cap} bytes.`);
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new Error(`The hosted app's answer was larger than ${cap} bytes.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString('utf8');
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

/** A fetch on the push path that never follows a redirect, so no body goes to another address. */
async function send(context, url, init) {
  try {
    return await context.fetch(url, { ...init, redirect: 'error' });
  } catch (error) {
    if (isRedirectRefusal(error)) {
      throw new PushOutcomeError(
        `The hosted app at ${context.apiUrl} answered with a redirect, which a push never follows. Set sync.api_url to the app's final address.`,
        { outcome: 'unknown', code: 'redirect_refused' },
      );
    }
    throw error;
  }
}

function isRedirectRefusal(error) {
  const text = `${error?.message ?? ''} ${error?.cause?.message ?? ''}`;
  return /redirect/i.test(text);
}

function authHeaders(context, extra = {}) {
  return { accept: 'application/json', authorization: `Bearer ${context.credential}`, ...extra };
}

function serverReason(body, text) {
  if (typeof body.error === 'string' && body.error) return body.error;
  return text ? text.slice(0, 500) : 'no reason given';
}

/**
 * The single request for a large body (over 4,000,000 bytes), with redirects
 * refused. Vercel's own 413 becomes the too-large message.
 */
export async function sendLargeSinglePush(context, bodyText, documents) {
  const response = await send(context, endpoint(context, 'push'), {
    method: 'POST',
    headers: authHeaders(context, { 'content-type': 'application/json' }),
    body: bodyText,
  });
  const text = await readResponseText(response);
  const body = parseJson(text);
  if (response.ok) return body;
  if (response.status === 413) {
    const largest = documents.reduce(
      (max, document) => {
        const bytes = Buffer.byteLength(document.raw_text, 'utf8');
        return bytes > max.bytes ? { path: document.path, bytes } : max;
      },
      { path: null, bytes: 0 },
    );
    throw new PushOutcomeError(
      `Push refused: this push is ${megabytes(Buffer.byteLength(bodyText, 'utf8'))}, over what the hosted app takes in one request`
        + (largest.bytes > UPLOAD_MAX_DOCUMENT_BYTES
          ? `, and it holds a document over ${megabytes(UPLOAD_MAX_DOCUMENT_BYTES)} (${largest.path}, ${megabytes(largest.bytes)}), which a large push doesn't accept. Split that document.`
          : '.')
        + ' The hosted memory didn\'t change.',
      { outcome: 'refused', status: 413, code: 'push_too_large' },
    );
  }
  throw new PushOutcomeError(`Hosted push failed with ${response.status}: ${serverReason(body, text)}`, {
    outcome: response.status >= 500 ? 'unknown' : 'refused',
    status: response.status,
    code: body.code ?? null,
  });
}

function sleeper(context) {
  return context.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

function retryAfterMs(response, fallback) {
  const header = response.headers?.get?.('retry-after');
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallback;
}

/**
 * The upload path: compress, begin, send the parts in order, and commit.
 * Returns the commit's 202 body. Throws PushOutcomeError for every other end,
 * worded by outcome.
 */
export async function uploadPush(context, bodyText, documentCount) {
  const unpackedBytes = Buffer.byteLength(bodyText, 'utf8');
  if (unpackedBytes > UPLOAD_MAX_UNPACKED_BYTES) {
    throw new PushOutcomeError(
      `Push refused before upload: this push is ${megabytes(unpackedBytes)}, and the hosted app accepts at most ${megabytes(UPLOAD_MAX_UNPACKED_BYTES)}. Nothing was uploaded.`,
      { outcome: 'refused_before_upload', code: 'push_too_large' },
    );
  }
  const packed = gzipSync(Buffer.from(bodyText, 'utf8'), { level: 9 });
  if (packed.length > UPLOAD_MAX_PACKED_BYTES) {
    throw new PushOutcomeError(
      `Push refused before upload: this push is ${megabytes(unpackedBytes)} (${megabytes(packed.length)} compressed), and the hosted app accepts at most ${megabytes(UPLOAD_MAX_PACKED_BYTES)} compressed. Nothing was uploaded.`,
      { outcome: 'refused_before_upload', code: 'push_too_large' },
    );
  }
  const packedSha256 = createHash('sha256').update(packed).digest('hex');

  // Begin.
  const beginResponse = await send(context, endpoint(context, 'push-uploads'), {
    method: 'POST',
    headers: authHeaders(context, { 'content-type': 'application/json' }),
    body: JSON.stringify({
      packed_bytes: packed.length,
      packed_sha256: packedSha256,
      unpacked_bytes: unpackedBytes,
      document_count: documentCount,
    }),
  });
  const beginText = await readResponseText(beginResponse);
  const begun = parseJson(beginText);
  if (beginResponse.status === 404) return { olderApp: true };
  if (beginResponse.status !== 201) {
    throw new PushOutcomeError(
      `Push refused before upload (${beginResponse.status}): ${serverReason(begun, beginText)} Nothing was uploaded.`,
      { outcome: beginResponse.status >= 500 ? 'unknown' : 'refused_before_upload', status: beginResponse.status, code: begun.code ?? null },
    );
  }
  const uploadId = String(begun.upload_id);
  const partBytes = Number(begun.part_bytes);
  const partCount = Number(begun.part_count);
  if (!uploadId || !Number.isSafeInteger(partBytes) || partBytes <= 0 || partCount !== Math.ceil(packed.length / partBytes)) {
    throw new PushOutcomeError('The hosted app answered begin with an unexpected shape. Nothing was applied.', { outcome: 'refused' });
  }

  // Parts, in order, each retried once on a network error or 5xx.
  for (let index = 0; index < partCount; index += 1) {
    const part = packed.subarray(index * partBytes, (index + 1) * partBytes);
    let response = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await send(context, endpoint(context, `push-uploads/${encodeURIComponent(uploadId)}/parts/${index}`), {
          method: 'PUT',
          headers: authHeaders(context, { 'content-type': 'application/octet-stream' }),
          body: part,
        });
      } catch (error) {
        if (error instanceof PushOutcomeError || attempt === 1) {
          throw error instanceof PushOutcomeError
            ? error
            : new PushOutcomeError(`Push upload failed: part ${index + 1} of ${partCount} couldn't be sent. The hosted memory didn't change; push again.`, { outcome: 'refused' });
        }
        continue;
      }
      await readResponseText(response);
      if (response.status < 500) break;
    }
    if (response.status !== 200) {
      throw new PushOutcomeError(
        `Push upload failed: part ${index + 1} of ${partCount} answered ${response.status}. The hosted memory didn't change; push again.`,
        { outcome: 'refused', status: response.status },
      );
    }
  }

  return commitUpload(context, uploadId, packedSha256);
}

async function commitUpload(context, uploadId, packedSha256) {
  const sleep = sleeper(context);
  const url = endpoint(context, `push-uploads/${encodeURIComponent(uploadId)}/commit`);
  const init = {
    method: 'POST',
    headers: authHeaders(context, { 'content-type': 'application/json' }),
    body: JSON.stringify({ packed_sha256: packedSha256 }),
  };
  const started = Date.now();
  let networkRetries = 0;
  let polls = 0;
  let lastProblem = 'no answer';
  for (;;) {
    let response;
    try {
      response = await send(context, url, init);
    } catch (error) {
      if (error instanceof PushOutcomeError) throw error;
      lastProblem = 'a network error';
      if (networkRetries < 1) {
        networkRetries += 1;
        continue;
      }
      break;
    }
    const text = await readResponseText(response);
    const body = parseJson(text);
    if (response.status === 202) return { answer: body };
    // A definitive refusal: the recorded answer, the first time or replayed.
    if (response.status >= 400 && response.status < 500 && response.status !== 409 && response.status !== 429) {
      throw refusalError(response.status, body, text);
    }
    if (response.status === 409 && body.code !== 'upload_in_progress') {
      throw refusalError(response.status, body, text);
    }
    if (response.status >= 500 && networkRetries < 1 && body.code !== 'push_outcome_unknown') {
      networkRetries += 1;
      lastProblem = `status ${response.status}`;
      continue;
    }
    // In progress, rate-limited, or unsettled: none of these says what an
    // earlier attempt did. Ask again within the budget.
    lastProblem = body.code ? `${body.code} (${response.status})` : `status ${response.status}`;
    const wait = retryAfterMs(response, POLL_INTERVAL_MS);
    if (polls >= POLL_MAX_REQUESTS || Date.now() - started + wait > POLL_BUDGET_MS) break;
    polls += 1;
    await sleep(wait);
  }
  throw new PushOutcomeError(
    `The push's outcome is unknown (last answer: ${lastProblem}). Run vibecompass status, or push again: a push that already applied answers already current.`,
    { outcome: 'unknown' },
  );
}

function refusalError(status, body, text) {
  const reason = serverReason(body, text);
  const detail = [
    body.code ? `code ${body.code}` : null,
    typeof body.path === 'string' ? `path ${body.path}` : null,
    typeof body.target_remote_revision_id === 'string' ? `hosted head ${body.target_remote_revision_id}` : null,
  ].filter(Boolean).join(', ');
  const error = new PushOutcomeError(
    `Push refused (${status}): ${reason}${detail ? ` (${detail})` : ''}. The hosted memory didn't change.`,
    { outcome: 'refused', status, code: body.code ?? (body.status === 'needs_rebase' ? 'needs_rebase' : null) },
  );
  error.responseBody = body;
  return error;
}

/**
 * After a valid 202: fetch what the answer left out (omitted warnings and
 * ids, and the full text of each cut warning) within 60 seconds and the
 * request windows. Never undoes the push; reports what it couldn't fetch.
 */
export async function completePushDetails(context, answer) {
  const projection = answer.projection ?? {};
  const warnings = Array.isArray(projection.warnings) ? [...projection.warnings] : [];
  const lists = {
    applied_proposal_ids: Array.isArray(answer.applied_proposal_ids) ? [...answer.applied_proposal_ids] : [],
    stale_proposal_ids: Array.isArray(answer.stale_proposal_ids) ? [...answer.stale_proposal_ids] : [],
  };
  const totals = {
    warnings: Number.isInteger(projection.warnings_total) ? projection.warnings_total : warnings.length,
    applied_proposal_ids: Number.isInteger(answer.applied_proposal_ids_total) ? answer.applied_proposal_ids_total : lists.applied_proposal_ids.length,
    stale_proposal_ids: Number.isInteger(answer.stale_proposal_ids_total) ? answer.stale_proposal_ids_total : lists.stale_proposal_ids.length,
  };
  const needsWork = () =>
    warnings.length < totals.warnings ||
    lists.applied_proposal_ids.length < totals.applied_proposal_ids ||
    lists.stale_proposal_ids.length < totals.stale_proposal_ids ||
    warnings.some((warning) => warning?.message_truncated);
  if (!answer.details_truncated && !needsWork()) {
    return { warnings, lists, totals, incomplete: null };
  }

  const deadline = Date.now() + DETAILS_BUDGET_MS;
  const sleep = sleeper(context);
  const runId = String(answer.run_id);
  async function getJson(query) {
    for (;;) {
      if (Date.now() > deadline) throw new Error('details budget spent');
      const response = await send(context, `${endpoint(context, `runs/${encodeURIComponent(runId)}/push-details`)}?${query}`, {
        method: 'GET',
        headers: authHeaders(context),
      });
      const text = await readResponseText(response);
      if (response.status === 429) {
        const wait = retryAfterMs(response, 5_000);
        if (Date.now() + wait > deadline) throw new Error('details budget spent');
        await sleep(wait);
        continue;
      }
      if (response.status !== 200) throw new Error(`push-details answered ${response.status}`);
      return parseJson(text);
    }
  }

  try {
    for (const name of ['applied_proposal_ids', 'stale_proposal_ids']) {
      let offset = lists[name].length;
      while (offset < totals[name]) {
        const page = await getJson(`list=${name}&offset=${offset}`);
        if (!Array.isArray(page.items) || page.items.length === 0) break;
        lists[name].push(...page.items);
        offset = page.next_offset ?? totals[name];
      }
    }
    let offset = warnings.length;
    while (offset < totals.warnings) {
      const page = await getJson(`list=warnings&offset=${offset}`);
      if (!Array.isArray(page.items) || page.items.length === 0) break;
      for (const item of page.items) {
        const { index: _index, ...warning } = item;
        warnings.push(warning);
      }
      offset = page.next_offset ?? totals.warnings;
    }
    for (let index = 0; index < warnings.length; index += 1) {
      if (!warnings[index]?.message_truncated) continue;
      let messageOffset = 0;
      const pieces = [];
      while (messageOffset !== null) {
        const chunk = await getJson(`list=warnings&item=${index}&message_offset=${messageOffset}`);
        pieces.push(String(chunk.text ?? ''));
        messageOffset = chunk.next_message_offset ?? null;
      }
      const { message_truncated: _cut, message_bytes: _bytes, ...rest } = warnings[index];
      warnings[index] = { ...rest, message: pieces.join('') };
    }
  } catch {
    // Fall through: report what is still missing.
  }

  const missing = {
    warnings: Math.max(0, totals.warnings - warnings.length),
    cutWarnings: warnings.filter((warning) => warning?.message_truncated).length,
    applied_proposal_ids: Math.max(0, totals.applied_proposal_ids - lists.applied_proposal_ids.length),
    stale_proposal_ids: Math.max(0, totals.stale_proposal_ids - lists.stale_proposal_ids.length),
  };
  const incomplete = Object.values(missing).some((count) => count > 0) ? { runId, ...missing } : null;
  return { warnings, lists, totals, incomplete };
}
