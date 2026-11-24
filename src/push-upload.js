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
/** The app's run and revision ids are UUIDs (gen_random_uuid). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACKNOWLEDGED_STATUSES = new Set(['completed', 'already_current']);
const UNKNOWN_NEXT_STEP = 'Run vibecompass status, or push again: a push that already applied answers already current.';

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

/**
 * Reads a response body under a byte cap; a longer body is an error, never
 * buffered whole. With `signal`, the read gives up when it aborts, even if the
 * body stalls after its headers.
 */
export async function readResponseText(response, cap = RESPONSE_READ_CAP_BYTES, { signal = null } = {}) {
  if (signal?.aborted) throw abortError(signal);
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = typeof response.text === 'function' ? await raceAbort(response.text(), signal) : '';
    if (Buffer.byteLength(text, 'utf8') > cap) throw new Error(`The hosted app's answer was larger than ${cap} bytes.`);
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await raceAbort(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > cap) throw new Error(`The hosted app's answer was larger than ${cap} bytes.`);
      chunks.push(value);
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString('utf8');
}

function abortError(signal) {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error('The request ran past its time budget.');
}

/** `promise`, or a rejection as soon as `signal` aborts. */
function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** A signal that aborts when `deadline` (epoch ms) passes. */
function deadlineSignal(deadline) {
  return AbortSignal.timeout(Math.max(1, deadline - Date.now()));
}

/** The parsed JSON value, or undefined when `text` isn't JSON. */
function tryParseJson(text) {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

/** An object to read an error's fields from: the parsed body, or {}. Never used to accept a success. */
function parseJson(text) {
  const value = tryParseJson(text);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * A push acknowledgement the package may record: a known success status, the
 * run id, and the hosted revision it produced or found, both UUIDs.
 */
export function isValidPushAnswer(answer) {
  return (
    Boolean(answer) &&
    typeof answer === 'object' &&
    !Array.isArray(answer) &&
    ACKNOWLEDGED_STATUSES.has(answer.status) &&
    typeof answer.run_id === 'string' &&
    UUID_PATTERN.test(answer.run_id) &&
    typeof answer.remote_revision_id === 'string' &&
    UUID_PATTERN.test(answer.remote_revision_id)
  );
}

/** The error for a success status whose answer the package can't record. */
export function invalidAnswerError(status) {
  return new PushOutcomeError(
    `The push's outcome is unknown: the hosted app answered${status ? ` ${status}` : ''} without a valid acknowledgement (a run id, the hosted revision, and a success status). Nothing was recorded locally. ${UNKNOWN_NEXT_STEP}`,
    { outcome: 'unknown', status, code: 'invalid_answer' },
  );
}

const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

/** The system error codes behind a fetch failure: its cause chain and any AggregateError members. */
function errorCodes(error, depth = 0) {
  if (!error || typeof error !== 'object' || depth > 4) return [];
  const own = typeof error.code === 'string' ? [error.code] : [];
  const members = Array.isArray(error.errors) ? error.errors.flatMap((member) => errorCodes(member, depth + 1)) : [];
  return [...own, ...members, ...errorCodes(error.cause, depth + 1)];
}

/**
 * A single request's connection failure, worded by what it proves. A
 * connection that was never made (refused, or a name that doesn't resolve)
 * sent nothing. Any other failure while sending or while reading the answer
 * may have followed an applied push, so its outcome is unknown, and the
 * request is never sent again without a receipt.
 */
export function singleRequestFailure(context, error, phase) {
  if (error instanceof PushOutcomeError) return error;
  const codes = [...new Set(errorCodes(error))];
  if (phase === 'send' && codes.length > 0 && codes.every((code) => UNREACHABLE_CODES.has(code))) {
    return new PushOutcomeError(
      `Push failed before upload: the hosted app at ${context.apiUrl} couldn't be reached (${codes.join(', ')}). Nothing was sent.`,
      { outcome: 'refused_before_upload', code: 'app_unreachable' },
    );
  }
  const cause = codes.length > 0 ? codes.join(', ') : String(error?.message ?? error);
  return new PushOutcomeError(
    `The push's outcome is unknown: the connection to the hosted app failed ${phase === 'send' ? 'before its answer arrived' : 'while its answer was read'} (${cause}). Nothing was recorded locally. ${UNKNOWN_NEXT_STEP}`,
    { outcome: 'unknown', code: 'connection_failed' },
  );
}

/** The statuses fetch follows as redirects; another 3xx (300, 304) is an ordinary answer. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * A fetch on the push path that never follows a redirect, so no body goes to
 * another address. Fetch's manual mode hands back the redirect itself, so a
 * redirect is known by its status, the five fetch would follow, never by an
 * error's text: a failure before any answer (a name that doesn't resolve,
 * say) keeps its own error, and any other answer goes to its caller's
 * handling. The app received the redirected request, so the outcome is
 * unknown.
 */
async function send(context, url, init) {
  const response = await context.fetch(url, { ...init, redirect: 'manual' });
  if (REDIRECT_STATUSES.has(response.status)) {
    try {
      await response.body?.cancel?.();
    } catch {
      // The answer is refused either way.
    }
    throw new PushOutcomeError(
      `The push's outcome is unknown: the hosted app at ${context.apiUrl} answered ${response.status}, a redirect, which a push never follows. Nothing was recorded locally. Set sync.api_url to the app's final address, then run vibecompass status, or push again: a push that already applied answers already current.`,
      { outcome: 'unknown', code: 'redirect_refused', status: response.status },
    );
  }
  return response;
}

/** The same fetch for the push of 4,000,000 bytes or less, sent by sync.js. */
export const sendWithoutRedirect = send;

function authHeaders(context, extra = {}) {
  return { accept: 'application/json', authorization: `Bearer ${context.credential}`, ...extra };
}

function serverReason(body, text) {
  if (typeof body.error === 'string' && body.error) return body.error;
  return text ? text.slice(0, 500) : 'no reason given';
}

/**
 * The single request for a large body (over 4,000,000 bytes), with redirects
 * refused. Only a 202 with a valid acknowledgement counts as applied; any
 * other success status, a malformed 202, or a reply cut off mid-body leaves
 * the outcome unknown. Vercel's own 413 becomes the too-large message.
 */
export async function sendLargeSinglePush(context, bodyText, documents) {
  let response;
  try {
    response = await send(context, endpoint(context, 'push'), {
      method: 'POST',
      headers: authHeaders(context, { 'content-type': 'application/json' }),
      body: bodyText,
    });
  } catch (error) {
    throw singleRequestFailure(context, error, 'send');
  }
  let text;
  try {
    text = await readResponseText(response);
  } catch {
    throw new PushOutcomeError(
      `The push's outcome is unknown: the hosted app's answer (${response.status}) was cut off. Nothing was recorded locally. ${UNKNOWN_NEXT_STEP}`,
      { outcome: 'unknown', status: response.status, code: 'answer_unreadable' },
    );
  }
  if (response.ok) {
    const answer = tryParseJson(text);
    if (response.status === 202 && isValidPushAnswer(answer)) return answer;
    throw invalidAnswerError(response.status);
  }
  const body = parseJson(text);
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
  if (response.status >= 400 && response.status < 500) throw refusalError(response.status, body, text);
  throw new PushOutcomeError(`Hosted push failed with ${response.status}: ${serverReason(body, text)}`, {
    outcome: 'unknown',
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

/**
 * The commit, retried once on a network error, a reply cut off mid-body, or a
 * 5xx, then polled within the budget while the answer says nothing definitive
 * (in progress, rate-limited, unsettled, or a 202 that isn't a valid
 * acknowledgement). Every request and body read is bounded by the budget.
 *
 * Once any attempt was ambiguous (it may have reached the app), a refusal
 * counts only when it is this upload's recorded answer (it names the upload
 * id): a 401 after a lost reply, say, says nothing about the earlier attempt.
 */
async function commitUpload(context, uploadId, packedSha256) {
  const sleep = sleeper(context);
  const url = endpoint(context, `push-uploads/${encodeURIComponent(uploadId)}/commit`);
  const init = {
    method: 'POST',
    headers: authHeaders(context, { 'content-type': 'application/json' }),
    body: JSON.stringify({ packed_sha256: packedSha256 }),
  };
  const deadline = Date.now() + (context.pushBudgets?.commitMs ?? POLL_BUDGET_MS);
  let networkRetries = 0;
  let polls = 0;
  let ambiguous = false;
  let lastProblem = 'no answer';
  while (Date.now() < deadline) {
    const signal = deadlineSignal(deadline);
    let response;
    let text;
    try {
      response = await send(context, url, { ...init, signal });
      text = await readResponseText(response, RESPONSE_READ_CAP_BYTES, { signal });
    } catch (error) {
      if (error instanceof PushOutcomeError) throw error;
      ambiguous = true;
      lastProblem = signal.aborted
        ? 'no answer within the time budget'
        : response
          ? `an answer (${response.status}) cut off mid-body`
          : 'a network error';
      if (signal.aborted || networkRetries >= 1) break;
      networkRetries += 1;
      continue;
    }
    if (response.status === 202) {
      const answer = tryParseJson(text);
      if (isValidPushAnswer(answer)) return { answer };
      ambiguous = true;
      lastProblem = 'a 202 without a valid acknowledgement';
    } else {
      const body = parseJson(text);
      const definitive =
        (response.status >= 400 && response.status < 500 && response.status !== 409 && response.status !== 429) ||
        (response.status === 409 && body.code !== 'upload_in_progress');
      if (definitive) {
        // The recorded answer, the first time or replayed.
        if (!ambiguous || body.upload_id === uploadId) throw refusalError(response.status, body, text);
        throw new PushOutcomeError(
          `The push's outcome is unknown: an earlier commit attempt got no definitive answer, and the hosted app then answered ${response.status} (${serverReason(body, text)}), which doesn't say what the earlier attempt did. Nothing was recorded locally. ${UNKNOWN_NEXT_STEP}`,
          { outcome: 'unknown', status: response.status, code: body.code ?? null },
        );
      }
      ambiguous = true;
      if (response.status >= 500 && networkRetries < 1 && body.code !== 'push_outcome_unknown') {
        networkRetries += 1;
        lastProblem = `status ${response.status}`;
        continue;
      }
      // In progress, rate-limited, or unsettled: none of these says what an
      // earlier attempt did. Ask again within the budget.
      lastProblem = body.code ? `${body.code} (${response.status})` : `status ${response.status}`;
    }
    const wait = retryAfterMs(response, POLL_INTERVAL_MS);
    if (polls >= POLL_MAX_REQUESTS || Date.now() + wait >= deadline) break;
    polls += 1;
    await sleep(wait);
  }
  throw new PushOutcomeError(
    `The push's outcome is unknown (last answer: ${lastProblem}). ${UNKNOWN_NEXT_STEP}`,
    { outcome: 'unknown' },
  );
}

/**
 * A definitive refusal, worded with the receipt's fields: the reason and
 * code, the path, the hosted head, the run (a needs_rebase audit run), every
 * schema issue the answer carries (a stored receipt is at most 16,384 bytes),
 * then how many more the hosted app counted but didn't keep.
 */
function refusalError(status, body, text) {
  const reason = serverReason(body, text).replace(/\.$/, '');
  const detail = [
    typeof body.code === 'string' ? `code ${body.code}` : typeof body.status === 'string' ? body.status : null,
    typeof body.path === 'string' ? `path ${body.path}` : null,
    typeof body.target_remote_revision_id === 'string' ? `hosted head ${body.target_remote_revision_id}` : null,
    typeof body.run_id === 'string' ? `run ${body.run_id}` : null,
  ].filter(Boolean).join(', ');
  const lines = [`Push refused (${status}): ${reason}${detail ? ` (${detail})` : ''}. The hosted memory didn't change.`];
  const issues = Array.isArray(body.issues) ? body.issues.filter((issue) => issue && typeof issue === 'object') : [];
  for (const issue of issues) {
    const where = typeof issue.path === 'string' && issue.path ? `${issue.path}: ` : '';
    lines.push(`  - ${where}${typeof issue.message === 'string' ? issue.message : 'invalid'}`);
  }
  const omitted = Number.isInteger(body.issues_omitted) && body.issues_omitted > 0
    ? body.issues_omitted
    : Number.isInteger(body.issues_total) ? Math.max(0, body.issues_total - issues.length) : 0;
  if (omitted > 0) {
    const total = Number.isInteger(body.issues_total) ? body.issues_total : issues.length + omitted;
    lines.push(`  - and ${omitted} more the hosted app counted but didn't keep (${total} in all)`);
  }
  const error = new PushOutcomeError(lines.join('\n'), {
    outcome: 'refused',
    status,
    code: body.code ?? (body.status === 'needs_rebase' ? 'needs_rebase' : null),
  });
  error.responseBody = body;
  return error;
}

/**
 * After a valid 202: fetch what the answer left out (omitted warnings and
 * ids, and the full text of each cut warning) within 60 seconds and the
 * request windows; every request and body read is bounded by that budget.
 * Each page and chunk is checked before it's used: it must name this run (and
 * a page its list), and a cut warning's full text replaces its preview only
 * when its chunks account for every byte the app declared. Never undoes the push; reports what it couldn't fetch.
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

  const deadline = Date.now() + (context.pushBudgets?.detailsMs ?? DETAILS_BUDGET_MS);
  const sleep = sleeper(context);
  const runId = String(answer.run_id);
  async function getJson(query) {
    for (;;) {
      if (Date.now() >= deadline) throw new Error('details budget spent');
      const signal = deadlineSignal(deadline);
      const response = await send(context, `${endpoint(context, `runs/${encodeURIComponent(runId)}/push-details`)}?${query}`, {
        method: 'GET',
        headers: authHeaders(context),
        signal,
      });
      const text = await readResponseText(response, RESPONSE_READ_CAP_BYTES, { signal });
      if (response.status === 429) {
        const wait = retryAfterMs(response, 5_000);
        if (Date.now() + wait > deadline) throw new Error('details budget spent');
        await sleep(wait);
        continue;
      }
      if (response.status !== 200) throw new Error(`push-details answered ${response.status}`);
      const value = tryParseJson(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('push-details answered malformed JSON');
      return value;
    }
  }

  /** The whole message of cut warning `index`, or null when the chunks don't agree. */
  async function readWholeMessage(index, declaredBytes) {
    const pieces = [];
    let messageOffset = 0;
    let messageBytes = null;
    for (;;) {
      const chunk = await getJson(`list=warnings&item=${index}&message_offset=${messageOffset}`);
      if (
        chunk.run_id !== runId ||
        chunk.item !== index ||
        chunk.message_offset !== messageOffset ||
        typeof chunk.text !== 'string' ||
        !Number.isInteger(chunk.message_bytes)
      ) {
        return null;
      }
      if (messageBytes === null) messageBytes = chunk.message_bytes;
      if (chunk.message_bytes !== messageBytes || (declaredBytes !== null && messageBytes !== declaredBytes)) return null;
      const end = messageOffset + Buffer.byteLength(chunk.text, 'utf8');
      if (end > messageBytes) return null;
      pieces.push(chunk.text);
      if (chunk.next_message_offset === null) return end === messageBytes ? pieces.join('') : null;
      if (chunk.next_message_offset !== end || end <= messageOffset || end >= messageBytes) return null;
      messageOffset = end;
    }
  }

  try {
    for (const name of ['applied_proposal_ids', 'stale_proposal_ids']) {
      let offset = lists[name].length;
      while (offset < totals[name]) {
        const page = await getJson(`list=${name}&offset=${offset}`);
        if (
          page.run_id !== runId ||
          page.list !== name ||
          page.offset !== offset ||
          !Array.isArray(page.items) ||
          page.items.length === 0 ||
          !page.items.every((item) => typeof item === 'string')
        ) {
          break;
        }
        lists[name].push(...page.items.slice(0, totals[name] - offset));
        offset = lists[name].length;
      }
    }
    let offset = warnings.length;
    pages: while (offset < totals.warnings) {
      const page = await getJson(`list=warnings&offset=${offset}`);
      if (
        page.run_id !== runId ||
        page.list !== 'warnings' ||
        page.offset !== offset ||
        !Array.isArray(page.items) ||
        page.items.length === 0
      ) {
        break;
      }
      for (const item of page.items) {
        // Each item must be the next warning in order.
        if (
          !item ||
          typeof item !== 'object' ||
          item.index !== warnings.length ||
          warnings.length >= totals.warnings ||
          typeof item.message !== 'string'
        ) {
          break pages;
        }
        const { index: _index, ...warning } = item;
        warnings.push(warning);
      }
      offset = warnings.length;
    }
    for (let index = 0; index < warnings.length; index += 1) {
      const entry = warnings[index];
      if (!entry?.message_truncated) continue;
      const message = await readWholeMessage(index, Number.isInteger(entry.message_bytes) ? entry.message_bytes : null);
      if (message === null) continue; // keeps the preview and its marks
      const { message_truncated: _cut, message_bytes: _bytes, ...rest } = entry;
      warnings[index] = { ...rest, message };
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
