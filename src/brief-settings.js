import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSimpleYaml } from './simple-yaml.js';

/**
 * `project.yaml` `brief:` settings (D-364, D-368): `enabled: true` opts a root
 * into lifecycle generation (it is off by default), and `exclude` names
 * canonical documents the session brief must never read. Exclusion fails closed: a malformed or unknown setting is a
 * problem that stops the brief from reading any canonical document, because a
 * silent fallback would expose exactly the files the setting exists to hide.
 */

const KNOWN_BRIEF_FIELDS = new Set(['enabled', 'exclude']);
const UNSUPPORTED_GLOB_CHARACTERS = /[[\]{}\\]/;

/**
 * Validates a `brief:` value from `project.yaml`. Returns the effective
 * settings plus `problems`; any problem means the settings must not be used.
 */
export function validateBriefSettings(value) {
  const settings = { enabled: false, enabledDeclared: false, exclude: [], problems: [] };
  if (value === undefined || value === null) {
    return settings;
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    settings.problems.push('"brief" must be a mapping with optional "enabled" and "exclude" fields');
    return settings;
  }

  for (const key of Object.keys(value)) {
    if (!KNOWN_BRIEF_FIELDS.has(key)) {
      settings.problems.push(`unknown field "brief.${key}" (known: enabled, exclude)`);
    }
  }

  if (value.enabled !== undefined) {
    if (typeof value.enabled === 'boolean') {
      settings.enabled = value.enabled;
      settings.enabledDeclared = true;
    } else {
      settings.problems.push('"brief.enabled" must be true or false');
    }
  }

  if (value.exclude !== undefined) {
    if (!Array.isArray(value.exclude)) {
      settings.problems.push('"brief.exclude" must be a list of root-relative glob patterns');
    } else {
      for (const [index, pattern] of value.exclude.entries()) {
        const problem = validateExcludePattern(pattern);
        if (problem) {
          settings.problems.push(`brief.exclude[${index}] ${problem}`);
        } else {
          settings.exclude.push(pattern.trim());
        }
      }
    }
  }

  settings.exclude = [...new Set(settings.exclude)];
  return settings;
}

/**
 * A pattern is a memory-root-relative POSIX path glob: `*` matches within one
 * path segment, `**` (a whole segment) matches any number of segments, and
 * `?` matches one character. Returns a problem string, or null when valid.
 */
export function validateExcludePattern(pattern) {
  if (typeof pattern !== 'string' || pattern.trim() === '') {
    return 'must be a non-empty string';
  }

  const trimmed = pattern.trim();
  if (trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) {
    return `"${trimmed}" must be relative to the memory root`;
  }
  if (UNSUPPORTED_GLOB_CHARACTERS.test(trimmed) || trimmed.startsWith('!')) {
    return `"${trimmed}" uses unsupported syntax (only *, **, and ? are supported, with no negation; separate segments with /)`;
  }

  const segments = trimmed.split('/');
  for (const segment of segments) {
    if (segment === '') {
      return `"${trimmed}" has an empty path segment`;
    }
    if (segment === '.' || segment === '..') {
      return `"${trimmed}" must not contain "." or ".." segments`;
    }
    if (segment.includes('**') && segment !== '**') {
      return `"${trimmed}" uses "**" inside a segment; "**" must be a whole segment`;
    }
  }

  return null;
}

/**
 * Compiles validated patterns into a path predicate over root-relative POSIX
 * paths. Matching ignores case: on a case-insensitive filesystem a mis-cased
 * pattern must still exclude, and over-exclusion is the safe failure.
 */
export function compileBriefExclusions(patterns = []) {
  const expressions = patterns.map((pattern) => new RegExp(globToRegexSource(pattern), 'i'));
  return {
    patterns: [...patterns],
    matches(relativePath) {
      const normalized = String(relativePath).split(path.sep).join('/');
      return expressions.some((expression) => expression.test(normalized));
    },
  };
}

/**
 * Reads the `brief:` settings of a memory root before any canonical document
 * is read. An unreadable or unparseable `project.yaml` is a problem: without
 * it the brief cannot know what it must not read.
 */
export async function readBriefSettingsForRoot(rootDir) {
  const projectPath = path.join(rootDir, 'project.yaml');
  let data;
  try {
    data = parseSimpleYaml(await readFile(projectPath, 'utf8'), { sourceName: 'project.yaml' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      enabled: false,
      enabledDeclared: false,
      exclude: [],
      problems: [`project.yaml could not be read (${message.replace(/\s+/g, ' ').slice(0, 200)})`],
      repos: [],
    };
  }

  const settings = validateBriefSettings(data && typeof data === 'object' ? data.brief : undefined);
  return { ...settings, repos: Array.isArray(data?.repos) ? data.repos : [] };
}

function globToRegexSource(pattern) {
  const segments = pattern.split('/');
  let source = '^';
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    if (segment === '**') {
      source += last ? '(?:[^/]+/)*[^/]+' : '(?:[^/]+/)*';
      continue;
    }
    source += segment
      .split('')
      .map((character) => {
        if (character === '*') return '[^/]*';
        if (character === '?') return '[^/]';
        return character.replace(/[.+^$()|]/g, '\\$&');
      })
      .join('');
    if (!last) source += '/';
  }
  return `${source}$`;
}
