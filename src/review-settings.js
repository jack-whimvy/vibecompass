import { readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { serializeProjectConfig } from './project-yaml.js';
import { parseSimpleYaml } from './simple-yaml.js';
import { resolveReviewSettings, MIN_ROUND_CAP, MAX_ROUND_CAP, DEFAULT_ROUND_CAP } from './review-log.js';
import { withMemoryRootLock } from './serialization.js';
import { resolveLaneMarkerContext } from './lane-marker.js';

// D-420: a project chooses its review cap at setup (`init --review-round-cap`,
// guided setup's question) or later with `review-settings --round-cap`. The
// check reads the key as before (D-394 item 7); refresh still writes no
// `review:` block.

/**
 * A cap given on the command line or at the guided prompt: a whole number from
 * 1 to 10, refused before anything is written. Returns the number or throws.
 */
export function parseRoundCapValue(raw, source = '--round-cap') {
  const text = typeof raw === 'number' ? String(raw) : String(raw ?? '').trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`${source} must be a whole number from ${MIN_ROUND_CAP} to ${MAX_ROUND_CAP}; got ${JSON.stringify(raw ?? '')}.`); // D-420 item 3
  }
  const value = Number(text);
  if (!Number.isInteger(value) || value < MIN_ROUND_CAP || value > MAX_ROUND_CAP) {
    throw new Error(`${source} must be a whole number from ${MIN_ROUND_CAP} to ${MAX_ROUND_CAP}; got ${text}.`); // D-420 item 3
  }
  return value;
}

/**
 * Sets `metadata.workflow.review.round_cap` on a parsed project config and
 * returns a new config; every other key is kept as it was.
 */
export function withRoundCap(projectConfig, roundCap) {
  const config = isPlainObject(projectConfig) ? projectConfig : {};
  const metadata = isPlainObject(config.metadata) ? config.metadata : {};
  const workflow = isPlainObject(metadata.workflow) ? metadata.workflow : {};
  const review = isPlainObject(workflow.review) ? workflow.review : {};
  return {
    ...config,
    metadata: {
      ...metadata,
      workflow: {
        ...workflow,
        review: { ...review, round_cap: roundCap },
      },
    },
  };
}

function describeEffective(projectConfig) {
  const rawReview = projectConfig?.metadata?.workflow?.review;
  const settings = resolveReviewSettings(rawReview);
  const rawCap = isPlainObject(rawReview) && Object.hasOwn(rawReview, 'round_cap') ? rawReview.round_cap : undefined;
  return {
    check: settings.check,
    roundCap: settings.roundCap,
    roundCapSource: rawCap === undefined ? 'default' : settings.roundCap === rawCap ? 'project.yaml' : 'default (invalid value ignored)',
    warnings: settings.warnings,
  };
}

/**
 * `vibecompass review-settings [--round-cap <n>] [--json]`. Without a cap it
 * prints the effective settings and writes nothing. With one it writes the key
 * under the memory-root lock, re-reading project.yaml inside the lock.
 */
export async function runReviewSettings(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const markerContext = await resolveLaneMarkerContext({ cwd, explicitRootDir: options.rootDir ?? null });
  const rootDir = markerContext.rootDir;
  const projectFilePath = path.join(rootDir, 'project.yaml');
  const requestedCap = options.roundCap === undefined ? null : parseRoundCapValue(options.roundCap);

  const read = async () => {
    let source;
    try {
      source = await readFile(projectFilePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`No project.yaml was found at ${projectFilePath}. Run "vibecompass init" first.`);
      }
      throw error;
    }
    return { source, config: parseSimpleYaml(source, { sourceName: projectFilePath }) };
  };

  if (requestedCap === null) {
    const { config } = await read();
    const effective = describeEffective(config);
    return {
      rootDir,
      projectFilePath,
      changed: false,
      ...effective,
      warnings: [...markerContext.warnings, ...effective.warnings],
    };
  }

  return withMemoryRootLock(rootDir, 'review-settings', async () => {
    const { config } = await read();
    const before = describeEffective(config);
    const next = withRoundCap(config, requestedCap);
    const serialized = serializeProjectConfig(next);
    // Keep every other key: refuse rather than write a file whose re-read
    // differs anywhere but the cap.
    const reparsed = parseSimpleYaml(serialized, { sourceName: projectFilePath });
    if (JSON.stringify(withRoundCap(reparsed, requestedCap)) !== JSON.stringify(next)) {
      throw new Error(`project.yaml at ${projectFilePath} has values this command can't rewrite without changing them; set metadata.workflow.review.round_cap by hand.`);
    }
    const changed = before.roundCapSource !== 'project.yaml' || before.roundCap !== requestedCap;
    if (changed) {
      const tempPath = path.join(path.dirname(projectFilePath), `.project.yaml.${randomUUID()}.tmp`);
      await writeFile(tempPath, serialized, 'utf8');
      await rename(tempPath, projectFilePath);
    }
    const after = describeEffective(next);
    return {
      rootDir,
      projectFilePath,
      changed,
      previousRoundCap: before.roundCap,
      ...after,
      warnings: [...markerContext.warnings, ...after.warnings],
    };
  });
}

export { DEFAULT_ROUND_CAP, MIN_ROUND_CAP, MAX_ROUND_CAP };

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
