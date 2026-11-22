import { access } from 'node:fs/promises';
import path from 'node:path';
import { READY_FILE, RELAY_LOCK_FILE, RELAY_STATE_FILE, compareMark, readReadyMark, shortRound } from './relay-mark.js';
import { extractReviewLogLines, parseReviewLog } from './review-log.js';

// D-419 item 11: the lane's stage in `list-sessions`, for a lane with a mark
// or relay state: `building` (no current mark), `ready for review`,
// `reviewing`, `builder answering`, `waiting for the owner` with the stop's
// reason, or `review clean`. A lane with neither shows nothing new.

export const LANE_STAGES = ['building', 'ready for review', 'reviewing', 'builder answering', 'waiting for the owner', 'review clean'];

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Whether the lane has a mark or relay state, the only lanes that get a stage. */
export async function laneHasRelayFiles(laneDir) {
  for (const name of [READY_FILE, RELAY_STATE_FILE, RELAY_LOCK_FILE]) {
    if (await exists(path.join(laneDir, name))) return true;
  }
  return false;
}

/** A clean review: the last record is a pass with no findings, and nothing is open or waiting. */
export function isReviewClean(parsed) {
  if (!parsed?.ok || parsed.passCount === 0) return false;
  const last = parsed.records.at(-1);
  if (last?.kind !== 'pass' || last.outcome !== 'no findings') return false;
  return parsed.findings.every((finding) => finding.resolved);
}

/**
 * Whether the log already holds a pass on this round: a relayed pass's scope
 * names `round <12 hex>` (D-419 item 6).
 */
export function passOnRound(parsed, roundId) {
  if (!parsed?.ok || !roundId) return null;
  const needle = `round ${shortRound(roundId)}`;
  return parsed.passes.find((pass) => pass.scope.includes(needle)) ?? null;
}

/**
 * The stage, or null for a lane with no mark or relay state. `relay` is the
 * relay's state view (`readRelayView`), passed in once the relay exists.
 */
export async function computeLaneStage({ rootDir, laneDir, wipContent, worktrees = {}, projectRepos = [], env = process.env, relay = null }) {
  if (!(await laneHasRelayFiles(laneDir))) {
    return null;
  }

  if (relay?.live) {
    return relay.step === 'builder-turn'
      ? { stage: 'builder answering', reason: null }
      : { stage: 'reviewing', reason: null };
  }
  if (relay?.unfinished) {
    return { stage: 'waiting for the owner', reason: relay.unfinished };
  }

  const parsed = wipContent ? parseReviewLog(extractReviewLogLines(wipContent).lines) : null;
  if (isReviewClean(parsed)) {
    return { stage: 'review clean', reason: null };
  }

  let mark = null;
  try {
    mark = await readReadyMark(laneDir);
  } catch {
    mark = null;
  }

  const stopAfterMark = relay?.lastStop && (!mark || Date.parse(relay.lastStop.at) >= Date.parse(mark.marked_at));
  if (stopAfterMark && relay.lastStop.kind !== 'clean') {
    return { stage: 'waiting for the owner', reason: relay.lastStop.reason };
  }

  if (mark) {
    try {
      const comparison = await compareMark(mark, { rootDir, laneDir, worktrees, projectRepos, env });
      if (comparison.current && !passOnRound(parsed, comparison.roundId)) {
        return { stage: 'ready for review', reason: null };
      }
    } catch {
      // A mark that can't be compared isn't current.
    }
  }
  return { stage: 'building', reason: null };
}

export function renderStage(stage) {
  if (!stage) return null;
  return stage.reason ? `${stage.stage} (${stage.reason})` : stage.stage;
}
