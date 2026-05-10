import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { generateStateManifest } from './manifest.js';
import { scanProjectMemory } from './project-memory.js';

const SECTION_PATTERN = /^##\s+(.+)$/gm;
const DECISION_HEADING_PATTERN = /^###\s+D-(\d{3,})\s+—\s+(.+)$/gm;

export async function loadProjectReadModel(rootDir) {
  const scanResult = await scanProjectMemory(rootDir);
  if (scanResult.errors.length > 0) {
    const details = scanResult.errors.map((error) => `${error.path}: ${error.message}`).join('\n');
    throw new Error(`Cannot build read model with canonical parse errors.\n${details}`);
  }

  const existingManifest = await readManifestIfPresent(rootDir);
  const currentManifest = generateStateManifest(scanResult, {
    generatedAt: existingManifest?.generated_at ?? new Date(),
    sync: existingManifest?.sync,
  });

  const freshness = existingManifest?.canonical?.manifest_hash === currentManifest.canonical.manifest_hash
    ? existingManifest.generated_at
    : new Date().toISOString();

  const warningSummary = summarizeWarnings(scanResult.warnings);
  const project = buildProjectSummary(scanResult, currentManifest, freshness, existingManifest);
  const repoAliases = buildRepoAliasMap(project.repos);
  const featureMap = buildFeatureMap(scanResult, repoAliases, project.repos);
  const features = [...featureMap.values()].sort((left, right) =>
    left.feature_key.localeCompare(right.feature_key),
  );
  const domains = buildDomainSummaries(features);
  const decisions = buildDecisionList(scanResult);
  const sessions = buildSessionList(scanResult);
  const fileOwners = buildFileOwnershipIndex(features);

  return {
    freshness,
    repo_aliases: repoAliases,
    manifest_state: {
      exists: Boolean(existingManifest),
      current: Boolean(existingManifest) && existingManifest.canonical.manifest_hash === currentManifest.canonical.manifest_hash,
      manifest_hash: currentManifest.canonical.manifest_hash,
    },
    project,
    warning_summary: warningSummary,
    domains,
    features,
    decisions,
    sessions,
    file_owners: fileOwners,
  };
}

export function getProjectContext(readModel, options = {}) {
  const decisionLimit = options.decisionLimit ?? 10;
  const sessionLimit = options.sessionLimit ?? 5;

  return {
    freshness: readModel.freshness,
    manifest_state: readModel.manifest_state,
    project: readModel.project,
    warning_summary: readModel.warning_summary,
    domains: readModel.domains,
    recent_decisions: readModel.decisions.slice(0, decisionLimit),
    recent_sessions: readModel.sessions.slice(0, sessionLimit),
  };
}

export function getFeatureContext(readModel, lookup) {
  const feature = findFeature(readModel.features, lookup);
  if (!feature) {
    return null;
  }

  return {
    freshness: readModel.freshness,
    feature,
  };
}

export function getDecisionLog(readModel, options = {}) {
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));

  return {
    freshness: readModel.freshness,
    decisions: readModel.decisions.slice(0, limit),
  };
}

export function getFileContext(readModel, filepath) {
  const normalizedPath = normalizeLookupPath(filepath, readModel.repo_aliases, readModel.project.repos);
  const owners = readModel.file_owners.get(normalizedPath) ?? [];

  return {
    freshness: readModel.freshness,
    path: normalizedPath,
    owners,
  };
}

function buildProjectSummary(scanResult, currentManifest, freshness, existingManifest) {
  const extracted = scanResult.project.extracted ?? {};
  const repos = (extracted.repos ?? []).map((repo) => ({
    id: repo.id,
    remote: repo.remote,
    default_branch: repo.default_branch,
  }));

  return {
    name: extracted.name,
    slug: extracted.slug,
    description: extracted.description,
    mode: extracted.mode,
    format_version: extracted.format_version,
    root_dir: scanResult.rootDir,
    repos,
    document_count: currentManifest.canonical.document_count,
    warning_count: currentManifest.canonical.warning_count,
    local_root_revision: currentManifest.canonical.local_root_revision,
    manifest_hash: currentManifest.canonical.manifest_hash,
    last_manifest_generated_at: existingManifest?.generated_at ?? null,
    freshness,
  };
}

function buildFeatureMap(scanResult, repoAliases, projectRepos) {
  const featureMap = new Map();

  for (const document of scanResult.documents) {
    if (document.kind !== 'architecture' || !document.extracted) {
      continue;
    }

    const featureKey = createFeatureKey(document.extracted.domain, document.extracted.feature);
    const component = buildComponentRecord(document, repoAliases, projectRepos);
    const existing = featureMap.get(featureKey);

    if (existing) {
      existing.components.push(component);
      existing.repo_ids = uniqueSorted([...existing.repo_ids, ...component.repo_ids]);
      existing.involved_files = uniqueSorted([...existing.involved_files, ...component.involved_files]);
      existing.component_count = existing.components.length;
      existing.overall_status = summarizeStatuses(existing.components.map((entry) => entry.status));
      existing.component_status_counts = summarizeStatusCounts(existing.components.map((entry) => entry.status));
      continue;
    }

    featureMap.set(featureKey, {
      feature_key: featureKey,
      domain: document.extracted.domain,
      domain_key: slugify(document.extracted.domain),
      feature: document.extracted.feature,
      feature_slug: slugify(document.extracted.feature),
      overall_status: summarizeStatuses([component.status]),
      component_count: 1,
      component_status_counts: summarizeStatusCounts([component.status]),
      repo_ids: component.repo_ids,
      involved_files: component.involved_files,
      components: [component],
      warnings: document.warnings,
      warning_count: document.warnings.length,
    });
  }

  for (const feature of featureMap.values()) {
    feature.components.sort((left, right) => left.component.localeCompare(right.component));
  }

  return featureMap;
}

function buildComponentRecord(document, repoAliases, projectRepos) {
  const frontmatter = parseFrontmatter(document.content, { sourceName: document.path });
  const sections = splitMarkdownSections(frontmatter.body);
  const repoIds = uniqueSorted(document.extracted.repo_ids ?? []);
  const involvedFiles = parseInvolvedFiles({
    rawSection: sections.get('Involved files') ?? '',
    defaultRepoIds: repoIds,
    repoAliases,
    projectRepos,
  });

  return {
    component_key: slugify(document.extracted.component),
    component: document.extracted.component,
    status: document.extracted.status,
    path: document.path,
    repo_ids: repoIds,
    description: normalizeSectionText(sections.get('Description')),
    details: normalizeSectionText(sections.get('Details')),
    next_steps: normalizeSectionText(sections.get('Next steps')),
    involved_files: involvedFiles,
    warnings: document.warnings,
    warning_count: document.warnings.length,
  };
}

function buildDomainSummaries(features) {
  const map = new Map();

  for (const feature of features) {
    const key = feature.domain_key;
    const existing = map.get(key);
    const featureSummary = {
      feature_key: feature.feature_key,
      feature: feature.feature,
      feature_slug: feature.feature_slug,
      overall_status: feature.overall_status,
      component_count: feature.component_count,
      repo_ids: feature.repo_ids,
    };

    if (existing) {
      existing.features.push(featureSummary);
      existing.feature_count += 1;
      continue;
    }

    map.set(key, {
      domain: feature.domain,
      domain_key: key,
      feature_count: 1,
      features: [featureSummary],
    });
  }

  return [...map.values()]
    .sort((left, right) => left.domain.localeCompare(right.domain))
    .map((domain) => ({
      ...domain,
      features: domain.features.sort((left, right) => left.feature.localeCompare(right.feature)),
    }));
}

function buildDecisionList(scanResult) {
  const decisions = [];

  for (const document of scanResult.documents) {
    if (document.kind !== 'decision') {
      continue;
    }

    const fileLabel = path.basename(document.path, '.md');
    for (const entry of extractDecisionEntries(document.content, document.path)) {
      decisions.push({
        decision_id: entry.decision_id,
        title: entry.title,
        timestamp: entry.timestamp,
        decision: entry.decision,
        rationale: entry.rationale,
        path: document.path,
        domain_file: fileLabel,
      });
    }
  }

  return decisions.sort((left, right) => right.decision_id - left.decision_id);
}

function buildSessionList(scanResult) {
  return scanResult.documents
    .filter((document) => document.kind === 'session' && document.extracted)
    .map((document) => ({
      title: document.extracted.title,
      session_date: document.extracted.session_date,
      session_number: document.extracted.session_number,
      path: document.path,
    }))
    .sort(compareSessionsDescending);
}

function buildFileOwnershipIndex(features) {
  const index = new Map();

  for (const feature of features) {
    for (const component of feature.components) {
      for (const involvedFile of component.involved_files) {
        if (!index.has(involvedFile)) {
          index.set(involvedFile, []);
        }

        index.get(involvedFile).push({
          feature_key: feature.feature_key,
          domain: feature.domain,
          feature: feature.feature,
          component: component.component,
          component_key: component.component_key,
          component_path: component.path,
          repo_ids: component.repo_ids,
          matched_file: involvedFile,
        });
      }
    }
  }

  for (const owners of index.values()) {
    owners.sort((left, right) => {
      const featureComparison = left.feature_key.localeCompare(right.feature_key);
      if (featureComparison !== 0) {
        return featureComparison;
      }
      return left.component.localeCompare(right.component);
    });
  }

  return index;
}

function findFeature(features, lookup) {
  if (!lookup) {
    return null;
  }

  if (typeof lookup === 'string') {
    return features.find((feature) => feature.feature_key === lookup) ?? null;
  }

  if (lookup.featureKey) {
    return features.find((feature) => feature.feature_key === lookup.featureKey) ?? null;
  }

  if (lookup.domain && lookup.feature) {
    return (
      features.find(
        (feature) => feature.domain === lookup.domain && feature.feature === lookup.feature,
      ) ?? null
    );
  }

  return null;
}

function extractDecisionEntries(content, sourcePath) {
  const matches = [...content.matchAll(DECISION_HEADING_PATTERN)];

  return matches.map((match, index) => {
    const bodyStart = (match.index ?? 0) + match[0].length;
    const nextMatch = matches[index + 1];
    const bodyEnd = nextMatch?.index ?? content.length;
    const body = content.slice(bodyStart, bodyEnd);

    return {
      decision_id: Number(match[1]),
      title: match[2].trim(),
      timestamp: extractLabeledValue(body, 'Timestamp'),
      decision: extractLabeledValue(body, 'Decision'),
      rationale: extractLabeledValue(body, 'Rationale'),
      path: sourcePath,
    };
  });
}

function splitMarkdownSections(body) {
  const sections = new Map();
  const matches = [...body.matchAll(SECTION_PATTERN)];

  for (const [index, match] of matches.entries()) {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? body.length;
    sections.set(match[1].trim(), body.slice(start, end).trim());
  }

  return sections;
}

function parseInvolvedFiles({ rawSection, defaultRepoIds, repoAliases, projectRepos }) {
  if (!rawSection) {
    return [];
  }

  const lines = rawSection.split(/\r?\n/);
  const fallbackRepoId = defaultRepoIds.length === 1 ? defaultRepoIds[0] : null;
  let currentRepoId = fallbackRepoId;
  const normalized = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const repoHeading = trimmed.match(/^\*\*([^*]+):\*\*$/);
    if (repoHeading) {
      currentRepoId = normalizeRepoLabel(repoHeading[1], repoAliases) ?? currentRepoId;
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (!bullet) {
      continue;
    }

    const candidate = extractPathCandidate(bullet[1]);
    if (!candidate) {
      continue;
    }

    const value = normalizeLookupPath(candidate, repoAliases, projectRepos, currentRepoId ?? fallbackRepoId);
    normalized.push(value);
  }

  return uniqueSorted(normalized);
}

function extractPathCandidate(text) {
  const codeSpan = text.match(/`([^`]+)`/);
  if (codeSpan) {
    return codeSpan[1].trim();
  }

  const cleaned = text
    .replace(/\s+—.*$/, '')
    .replace(/\s+\(.*$/, '')
    .trim();

  return cleaned || null;
}

function normalizeLookupPath(filepath, repoAliases, projectRepos, fallbackRepoId = null) {
  const trimmed = filepath.trim();
  const repoCount = projectRepos.length;
  const repoPathMatch = trimmed.match(/^([^:]+):(.+)$/);

  if (repoPathMatch) {
    const canonicalRepoId = normalizeRepoLabel(repoPathMatch[1], repoAliases) ?? repoPathMatch[1];
    return `${canonicalRepoId}:${repoPathMatch[2]}`;
  }

  if (fallbackRepoId) {
    return `${fallbackRepoId}:${trimmed}`;
  }

  if (repoCount === 1) {
    return `${projectRepos[0].id}:${trimmed}`;
  }

  return trimmed;
}

function normalizeRepoLabel(label, repoAliases) {
  return repoAliases.get(label.trim()) ?? repoAliases.get(label.trim().toLowerCase()) ?? null;
}

function buildRepoAliasMap(repos) {
  const aliases = new Map();

  for (const repo of repos) {
    aliases.set(repo.id, repo.id);
    aliases.set(repo.id.toLowerCase(), repo.id);

    const remoteName = repo.remote
      .replace(/\.git$/, '')
      .split('/')
      .pop();

    if (remoteName) {
      aliases.set(remoteName, repo.id);
      aliases.set(remoteName.toLowerCase(), repo.id);
    }
  }

  return aliases;
}

function summarizeWarnings(warnings) {
  const counts = new Map();

  for (const warning of warnings) {
    counts.set(warning.code, (counts.get(warning.code) ?? 0) + 1);
  }

  return {
    total: warnings.length,
    by_code: [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([code, count]) => ({ code, count })),
  };
}

function summarizeStatuses(statuses) {
  if (statuses.includes('Blocked')) {
    return 'Blocked';
  }

  if (statuses.includes('In progress')) {
    return 'In progress';
  }

  if (statuses.length > 0 && statuses.every((status) => status === 'Complete')) {
    return 'Complete';
  }

  if (statuses.length > 0 && statuses.every((status) => status === 'Not started')) {
    return 'Not started';
  }

  return statuses[0] ?? null;
}

function summarizeStatusCounts(statuses) {
  const counts = {};

  for (const status of statuses) {
    counts[status] = (counts[status] ?? 0) + 1;
  }

  return counts;
}

function createFeatureKey(domain, feature) {
  return `${slugify(domain)}--${slugify(feature)}`;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeSectionText(value) {
  return value ? value.trim() : null;
}

function extractLabeledValue(body, label) {
  const pattern = new RegExp(`\\*\\*${label}:\\*\\*\\s+(.+)`);
  return body.match(pattern)?.[1]?.trim() ?? null;
}

function compareSessionsDescending(left, right) {
  const leftDate = left.session_date ?? '';
  const rightDate = right.session_date ?? '';

  if (leftDate !== rightDate) {
    return rightDate.localeCompare(leftDate);
  }

  return (right.session_number ?? 0) - (left.session_number ?? 0);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

async function readManifestIfPresent(rootDir) {
  const manifestPath = path.join(rootDir, 'state/manifest.json');

  try {
    const content = await readFile(manifestPath, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}
