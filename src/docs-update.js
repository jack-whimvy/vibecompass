import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseFrontmatter } from './frontmatter.js';
import { scanProjectMemory } from './project-memory.js';
import { parseSimpleYaml } from './simple-yaml.js';

const execFileAsync = promisify(execFile);
const PACKAGE_OWNED_PATH_PATTERNS = [
  /^state\//,
  /^context\.md$/,
  /^workflows\//,
  /^CLAUDE\.md$/,
  /^AGENTS\.md$/,
  /^\.cursorrules$/,
  /^\.github\/copilot-instructions\.md$/,
];

export async function planDocsUpdate(options = {}) {
  const normalized = normalizeDocsUpdateOptions(options);
  const scan = await scanProjectMemory(normalized.rootDir);
  const project = scan.project?.extracted ?? {};
  const activeSession = await readActiveSession(normalized.rootDir, normalized.sessionId);
  const changedFiles = await resolveChangedFiles({
    cwd: normalized.cwd,
    explicitChangedFiles: normalized.changedFiles,
    repos: project.repos ?? [],
  });
  const architectureDocs = scan.documents
    .filter((document) => document.kind === 'architecture')
    .map((document) => summarizeArchitectureDocument(document));
  const delta = {
    changedFiles,
    claimedPaths: activeSession?.claimedPaths ?? [],
    sessionRepos: activeSession?.repos ?? [],
    featureSlugs: activeSession?.featureSlugs ?? [],
  };
  const affectedArchitectureDocs = findAffectedArchitectureDocs(architectureDocs, delta);
  const packageOwnedChanges = changedFiles
    .filter((file) => isPackageOwnedPath(file.normalizedPath))
    .map((file) => file.raw);
  const decisionStatus = summarizeDecisionStatus(scan, activeSession);
  const recommendations = buildRecommendations({
    changedFiles,
    affectedArchitectureDocs,
    packageOwnedChanges,
    decisionStatus,
    activeSession,
  });

  return {
    rootDir: normalized.rootDir,
    cwd: normalized.cwd,
    session: activeSession
      ? {
          id: activeSession.id,
          workingOn: activeSession.workingOn,
          decisionSnapshotHighestId: activeSession.decisionSnapshotHighestId,
        }
      : null,
    delta: {
      changedFiles: changedFiles.map((file) => file.raw),
      claimedPaths: delta.claimedPaths,
      sessionRepos: delta.sessionRepos,
      featureSlugs: delta.featureSlugs,
    },
    architecture: {
      affected: affectedArchitectureDocs,
      needsNewDoc: changedFiles.some((file) => isImplementationLikePath(file.normalizedPath)) && affectedArchitectureDocs.length === 0,
    },
    decisions: decisionStatus,
    packageOwnedChanges,
    recommendations,
  };
}

export function renderDocsUpdatePlan(plan) {
  const lines = [
    'Docs update plan:',
    `- Session: ${plan.session?.id ?? '(none selected)'}`,
    `- Changed files: ${plan.delta.changedFiles.length > 0 ? plan.delta.changedFiles.join(', ') : 'none detected'}`,
    `- Claimed paths: ${plan.delta.claimedPaths.length > 0 ? plan.delta.claimedPaths.join(', ') : 'none recorded'}`,
  ];

  lines.push('Affected architecture docs:');
  if (plan.architecture.affected.length === 0) {
    lines.push(plan.architecture.needsNewDoc
      ? '- No matching architecture doc found for implementation-like changes; create a focused component doc or defer explicitly.'
      : '- None detected from the current session delta.');
  } else {
    for (const doc of plan.architecture.affected) {
      lines.push(`- ${doc.path}`);
      for (const reason of doc.reasons) {
        lines.push(`  - ${reason}`);
      }
      if (doc.qualityWarnings.length > 0) {
        lines.push(`  - quality warnings: ${doc.qualityWarnings.map((warning) => warning.code).join(', ')}`);
      }
    }
  }

  lines.push('Decision log:');
  if (plan.decisions.newDecisionIds.length > 0) {
    lines.push(`- New decisions since lane start: ${plan.decisions.newDecisionIds.map((id) => `D-${id}`).join(', ')}`);
  } else if (plan.decisions.decisionSnapshotHighestId === null) {
    lines.push('- No lane decision snapshot available.');
  } else {
    lines.push('- No new decisions detected since lane start.');
  }

  if (plan.packageOwnedChanges.length > 0) {
    lines.push('Package-owned generated/state surfaces:');
    for (const filePath of plan.packageOwnedChanges) {
      lines.push(`- ${filePath}`);
    }
  }

  lines.push('Recommended next actions:');
  for (const recommendation of plan.recommendations) {
    lines.push(`- ${recommendation}`);
  }

  return `${lines.join('\n')}\n`;
}

function normalizeDocsUpdateOptions(options) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  return {
    cwd,
    rootDir: path.resolve(cwd, options.rootDir ?? '.compass'),
    sessionId: normalizeOptionalString(options.sessionId),
    changedFiles: Array.isArray(options.changedFiles) ? options.changedFiles : [],
  };
}

async function readActiveSession(rootDir, requestedSessionId) {
  const activeRoot = path.join(rootDir, 'sessions', 'active');
  const indexPath = path.join(activeRoot, 'index.yaml');
  let sessionId = normalizeOptionalString(requestedSessionId);

  if (!sessionId) {
    try {
      const indexData = parseSimpleYaml(await readFile(indexPath, 'utf8'), { sourceName: indexPath });
      sessionId = normalizeOptionalString(indexData.current);
    } catch {
      sessionId = null;
    }
  }

  if (!sessionId) {
    return null;
  }

  const sessionPath = path.join(activeRoot, sessionId, 'session.yaml');
  try {
    const data = parseSimpleYaml(await readFile(sessionPath, 'utf8'), { sourceName: sessionPath });
    return {
      id: sessionId,
      workingOn: normalizeOptionalString(data.working_on),
      repos: normalizeStringArray(data.repos),
      claimedPaths: normalizeStringArray(data.claimed_paths),
      featureSlugs: normalizeStringArray(data.feature_slugs),
      decisionSnapshotHighestId: Number.isInteger(data.decision_snapshot?.highest_decision_id)
        ? data.decision_snapshot.highest_decision_id
        : null,
    };
  } catch {
    return {
      id: sessionId,
      workingOn: null,
      repos: [],
      claimedPaths: [],
      featureSlugs: [],
      decisionSnapshotHighestId: null,
    };
  }
}

async function resolveChangedFiles(options) {
  if (options.explicitChangedFiles.length > 0) {
    return normalizeChangedFiles(options.explicitChangedFiles, options.repos);
  }

  const changedPaths = new Set();
  for (const filePath of await readGitStatusPaths(options.cwd)) {
    changedPaths.add(filePath);
  }

  const repoStatusResults = await Promise.all(
    options.repos.map(async (repo) => {
      const repoDir = resolveRepoWorkingDirectory(options.cwd, repo);
      if (!repo?.id || !repoDir || repoDir === options.cwd) {
        return [];
      }

      return (await readGitStatusPaths(repoDir)).map((filePath) => `${repo.id}:${filePath}`);
    }),
  );

  for (const filePath of repoStatusResults.flat()) {
    changedPaths.add(filePath);
  }

  return normalizeChangedFiles(Array.from(changedPaths).sort((left, right) => left.localeCompare(right)), options.repos);
}

async function readGitStatusPaths(cwd) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'status', '--porcelain=v1', '--untracked-files=all'], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return parseGitStatusPaths(stdout);
  } catch {
    return [];
  }
}

function resolveRepoWorkingDirectory(cwd, repo) {
  if (!repo?.id) {
    return null;
  }

  if (repo.path) {
    return path.resolve(cwd, repo.path);
  }

  return path.resolve(cwd, repo.id);
}

function parseGitStatusPaths(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const rawPath = line.slice(3).trim();
      const renameIndex = rawPath.indexOf(' -> ');
      return renameIndex >= 0 ? rawPath.slice(renameIndex + 4) : rawPath;
    });
}

function normalizeChangedFiles(paths, repos) {
  return paths
    .map((raw) => normalizeOptionalString(raw))
    .filter(Boolean)
    .map((raw) => {
      const normalizedPath = normalizePath(raw);
      return {
        raw,
        normalizedPath,
        repoPathCandidates: buildRepoPathCandidates(normalizedPath, repos),
      };
    });
}

function buildRepoPathCandidates(filePath, repos) {
  const candidates = new Set([filePath]);
  const explicitRepoMatch = filePath.match(/^([^:/]+):(.+)$/);
  if (explicitRepoMatch) {
    const repoRelativePath = normalizePath(explicitRepoMatch[2]);
    candidates.add(`${explicitRepoMatch[1]}:${repoRelativePath}`);
    candidates.add(repoRelativePath);
  }

  if (!explicitRepoMatch && repos.length === 1 && repos[0]?.id) {
    candidates.add(`${repos[0].id}:${filePath}`);
  }

  for (const repo of repos) {
    if (!repo?.id) {
      continue;
    }
    if (filePath.startsWith(`${repo.id}/`)) {
      candidates.add(`${repo.id}:${filePath.slice(repo.id.length + 1)}`);
    }
    if (repo.path) {
      const repoPath = normalizePath(repo.path).replace(/^\.\//, '');
      if (repoPath && filePath.startsWith(`${repoPath}/`)) {
        candidates.add(`${repo.id}:${filePath.slice(repoPath.length + 1)}`);
      }
    }
  }

  return Array.from(candidates);
}

function summarizeArchitectureDocument(document) {
  const frontmatter = parseFrontmatter(document.content, { sourceName: document.path });
  const data = frontmatter.data ?? {};
  return {
    path: document.path,
    repoIds: [
      ...(typeof data.repo === 'string' ? [data.repo] : []),
      ...(Array.isArray(data.repos) ? data.repos.filter((repo) => typeof repo === 'string') : []),
    ],
    domain: normalizeOptionalString(data.domain),
    feature: normalizeOptionalString(data.feature),
    component: normalizeOptionalString(data.component),
    involvedFiles: extractInvolvedFiles(frontmatter.body),
    warnings: document.warnings,
  };
}

function extractInvolvedFiles(body) {
  return Array.from(body.matchAll(/`([^`\n]+:[^`\n]+)`/g))
    .map((match) => normalizePath(match[1]))
    .filter(Boolean);
}

function findAffectedArchitectureDocs(docs, delta) {
  return docs
    .map((doc) => {
      const reasons = [];

      for (const changedFile of delta.changedFiles) {
        if (pathMatchesDocument(changedFile, doc)) {
          reasons.push(`matches changed file ${changedFile.raw}`);
        }
      }

      for (const claimedPath of delta.claimedPaths) {
        const normalizedClaim = normalizePath(claimedPath);
        if (doc.involvedFiles.some((involvedFile) => pathsOverlap(involvedFile, normalizedClaim))) {
          reasons.push(`matches lane claim ${claimedPath}`);
        }
      }

      if (delta.featureSlugs.some((feature) => slugify(doc.feature ?? '') === feature)) {
        reasons.push(`matches lane feature ${delta.featureSlugs.filter((feature) => slugify(doc.feature ?? '') === feature).join(', ')}`);
      }

      return {
        path: doc.path,
        reasons: Array.from(new Set(reasons)),
        qualityWarnings: doc.warnings,
      };
    })
    .filter((doc) => doc.reasons.length > 0)
    .sort((left, right) => left.path.localeCompare(right.path));
}

function pathMatchesDocument(changedFile, doc) {
  if (changedFile.normalizedPath === doc.path) {
    return true;
  }

  return changedFile.repoPathCandidates.some((candidate) =>
    doc.involvedFiles.some((involvedFile) => pathsOverlap(involvedFile, candidate)),
  );
}

function pathsOverlap(left, right) {
  const normalizedLeft = normalizePath(left);
  const normalizedRight = normalizePath(right);
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`) ||
    normalizedLeft.endsWith(`/${normalizedRight}`) ||
    normalizedRight.endsWith(`/${normalizedLeft}`)
  );
}

function summarizeDecisionStatus(scan, activeSession) {
  const decisionIds = scan.documents
    .filter((document) => document.kind === 'decision')
    .flatMap((document) => document.extracted?.decision_ids ?? [])
    .sort((left, right) => left - right);
  const highestDecisionId = decisionIds.length > 0 ? decisionIds[decisionIds.length - 1] : null;
  const snapshot = activeSession?.decisionSnapshotHighestId ?? null;

  return {
    highestDecisionId,
    decisionSnapshotHighestId: snapshot,
    newDecisionIds: snapshot === null ? [] : decisionIds.filter((id) => id > snapshot),
  };
}

function buildRecommendations(options) {
  const recommendations = [];

  if (options.affectedArchitectureDocs.length > 0) {
    recommendations.push('Review and update the affected architecture docs listed above, then close with --architecture-docs updated.');
  } else if (options.changedFiles.length > 0 && options.affectedArchitectureDocs.length === 0) {
    recommendations.push('No matching architecture doc was found for the session delta; create a focused doc, mark docs not-needed with evidence, or defer explicitly.');
  } else {
    recommendations.push('No architecture doc update is indicated by the current delta; close with --architecture-docs not-needed if that remains true.');
  }

  if (options.decisionStatus.newDecisionIds.length > 0) {
    recommendations.push('Ensure affected architecture docs reference the new decisions where they change contracts or ownership.');
  } else {
    recommendations.push('Append a decision only if this session accepted a real architectural/product/process choice.');
  }

  if (options.packageOwnedChanges.length > 0) {
    recommendations.push('Do not hand-edit package-owned state/generated surfaces; use refresh-workflow --dry-run/--apply or sync-agents as appropriate.');
  }

  if (options.activeSession) {
    recommendations.push('Keep the active lane wip.md/handoff.md current; close-session will distill them into the finalized note.');
  }

  return recommendations;
}

function isPackageOwnedPath(filePath) {
  const normalized = normalizePath(filePath).replace(/^\.compass\//, '');
  return PACKAGE_OWNED_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isImplementationLikePath(filePath) {
  const normalized = stripRepoPrefix(filePath);
  return !(
    normalized.startsWith('architecture/') ||
    normalized.startsWith('decisions/') ||
    normalized.startsWith('sessions/') ||
    isPackageOwnedPath(normalized)
  );
}

function stripRepoPrefix(filePath) {
  const normalized = normalizePath(filePath);
  const repoMatch = normalized.match(/^[^:/]+:(.+)$/);
  return repoMatch ? normalizePath(repoMatch[1]) : normalized;
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value.map((item) => normalizeOptionalString(item)).filter(Boolean)
    : [];
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function normalizePath(value) {
  return String(value).replace(/\\/g, '/').replace(/^\.\//, '');
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
