import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { sha256Text } from './hash.js';
import { parseSimpleYaml } from './simple-yaml.js';

const PROJECT_FILE = 'project.yaml';
const NON_CANONICAL_DECISION_FILES = new Set(['EXAMPLE.md', 'INDEX.md', 'README.md']);
const NON_CANONICAL_SESSION_FILES = new Set(['wip.md', 'handoff.md', 'README.md']);
const NON_CANONICAL_ARCHITECTURE_FILES = new Set(['README.md']);
const VALID_MODES = new Set(['local-only', 'local-primary', 'hosted-only']);
const RECOMMENDED_ARCHITECTURE_SECTIONS = [
  'Description',
  'Details',
  'Next steps',
  'Involved files',
];
const RECOMMENDED_SESSION_SECTIONS = [
  'What we worked on',
  'Completed',
  'Decisions made',
  'Models used',
  'Blockers / open questions',
  'Next session should start with',
];
const KNOWN_PROJECT_FIELDS = new Set([
  'format_version',
  'name',
  'slug',
  'description',
  'mode',
  'repos',
  'default_branch',
  'sync',
  'metadata',
]);
const KNOWN_REPO_FIELDS = new Set(['id', 'source', 'remote', 'path', 'default_branch']);
const KNOWN_SYNC_FIELDS = new Set([
  'provider',
  'api_url',
  'project_id',
  'credential_source',
  'credential_env_var',
]);
const KNOWN_ARCHITECTURE_STATUSES = new Set([
  'Not started',
  'In progress',
  'Complete',
  'Blocked',
]);
const SECRET_BEARING_SYNC_FIELDS = [
  'token',
  'secret',
  'api_key',
  'apikey',
  'credential',
  'credential_value',
  'access_token',
];

export async function scanProjectMemory(rootDir) {
  const errors = [];
  const documents = [];

  const projectPath = path.join(rootDir, PROJECT_FILE);
  const projectDocument = await parseProjectDocument(rootDir, projectPath);
  documents.push(projectDocument);
  errors.push(...projectDocument.errors);

  const declaredRepoIds = new Set(projectDocument.extracted?.repo_ids ?? []);

  const architectureDocuments = await parseMarkdownTree({
    rootDir,
    directoryName: 'architecture',
    shouldInclude: (filename) => !NON_CANONICAL_ARCHITECTURE_FILES.has(filename),
    parseDocument: (documentPath, relativePath, content) =>
      parseArchitectureDocument({
        content,
        relativePath,
        repoIds: declaredRepoIds,
      }),
  });

  const decisionDocuments = await parseMarkdownTree({
    rootDir,
    directoryName: 'decisions',
    shouldInclude: (filename) => !NON_CANONICAL_DECISION_FILES.has(filename),
    parseDocument: (documentPath, relativePath, content) =>
      parseDecisionDocument({
        content,
        relativePath,
      }),
  });

  const sessionDocuments = await parseMarkdownTree({
    rootDir,
    directoryName: 'sessions',
    shouldInclude: (filename) => !NON_CANONICAL_SESSION_FILES.has(filename),
    parseDocument: (documentPath, relativePath, content) =>
      parseSessionDocument({
        content,
        relativePath,
      }),
  });

  for (const document of [...architectureDocuments, ...decisionDocuments, ...sessionDocuments]) {
    documents.push(document);
    errors.push(...document.errors);
  }

  errors.push(...findDuplicateDecisionErrors(decisionDocuments));

  documents.sort((left, right) => left.path.localeCompare(right.path));

  return {
    rootDir,
    documents,
    errors,
    warnings: documents.flatMap((document) => document.warnings.map((warning) => ({ ...warning, path: document.path }))),
    project: projectDocument,
  };
}

async function parseProjectDocument(rootDir, filePath) {
  const relativePath = PROJECT_FILE;

  try {
    const content = await readFile(filePath, 'utf8');
    const data = parseSimpleYaml(content, { sourceName: relativePath });
    return finalizeDocument({
      path: relativePath,
      kind: 'project',
      content,
      ...validateProjectData(data, relativePath),
    });
  } catch (error) {
    return finalizeDocument({
      path: relativePath,
      kind: 'project',
      content: '',
      extracted: null,
      warnings: [],
      errors: [
        createError(
          relativePath,
          'project-parse-failed',
          error instanceof Error ? error.message : 'Failed to read project.yaml.',
        ),
      ],
    });
  }
}

async function parseMarkdownTree(options) {
  const directoryPath = path.join(options.rootDir, options.directoryName);
  const relativePaths = await listMarkdownFiles(directoryPath, options.directoryName, options.shouldInclude);
  const documents = [];

  for (const relativePath of relativePaths) {
    const documentPath = path.join(options.rootDir, relativePath);
    const content = await readFile(documentPath, 'utf8');
    const parsed = options.parseDocument(documentPath, relativePath, content);

    documents.push(
      finalizeDocument({
        path: relativePath,
        kind: parsed.kind,
        content,
        extracted: parsed.extracted,
        warnings: parsed.warnings,
        errors: parsed.errors,
      }),
    );
  }

  return documents;
}

async function listMarkdownFiles(directoryPath, relativeRoot, shouldInclude) {
  try {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    const paths = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }

      const absoluteChildPath = path.join(directoryPath, entry.name);
      const relativeChildPath = toPosix(path.join(relativeRoot, entry.name));

      if (entry.isDirectory()) {
        paths.push(...(await listMarkdownFiles(absoluteChildPath, relativeChildPath, shouldInclude)));
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith('.md')) {
        continue;
      }

      if (!shouldInclude(entry.name, relativeChildPath)) {
        continue;
      }

      paths.push(relativeChildPath);
    }

    return paths.sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

function validateProjectData(data, relativePath) {
  const warnings = [];
  const errors = [];

  if (!isPlainObject(data)) {
    return {
      extracted: null,
      warnings,
      errors: [createError(relativePath, 'project-invalid-root', 'project.yaml must contain a top-level mapping.')],
    };
  }

  for (const key of Object.keys(data)) {
    if (!KNOWN_PROJECT_FIELDS.has(key)) {
      warnings.push(createWarning('project-unknown-field', `Unknown project.yaml field "${key}".`));
    }
  }

  if (!Number.isInteger(data.format_version)) {
    errors.push(createError(relativePath, 'project-missing-format-version', 'project.yaml requires integer field "format_version".'));
  }

  if (typeof data.name !== 'string' || data.name.trim() === '') {
    errors.push(createError(relativePath, 'project-missing-name', 'project.yaml requires non-empty field "name".'));
  }

  if (typeof data.mode !== 'string' || !VALID_MODES.has(data.mode)) {
    errors.push(
      createError(
        relativePath,
        'project-invalid-mode',
        'project.yaml requires "mode" to be one of local-only, local-primary, or hosted-only.',
      ),
    );
  }

  if (!Array.isArray(data.repos) || data.repos.length === 0) {
    errors.push(createError(relativePath, 'project-invalid-repos', 'project.yaml requires a non-empty repos array.'));
  }

  const repoIds = [];
  if (Array.isArray(data.repos)) {
    for (const [index, repo] of data.repos.entries()) {
      const prefix = `repos[${index}]`;
      if (!isPlainObject(repo)) {
        errors.push(createError(relativePath, 'project-invalid-repo', `${prefix} must be a mapping.`));
        continue;
      }

      for (const key of Object.keys(repo)) {
        if (!KNOWN_REPO_FIELDS.has(key)) {
          warnings.push(createWarning('project-unknown-repo-field', `Unknown repo field "${prefix}.${key}".`));
        }
      }

      if (typeof repo.id !== 'string' || repo.id.trim() === '') {
        errors.push(createError(relativePath, 'project-invalid-repo-id', `${prefix}.id must be a non-empty string.`));
      } else if (repoIds.includes(repo.id)) {
        errors.push(createError(relativePath, 'project-duplicate-repo-id', `Duplicate repo id "${repo.id}" in project.yaml.`));
      } else {
        repoIds.push(repo.id);
      }

      const source = typeof repo.source === 'string' && repo.source.trim() !== ''
        ? repo.source.trim()
        : null;
      const remote = typeof repo.remote === 'string' ? repo.remote.trim() : '';
      const sourcePath = typeof repo.path === 'string' ? repo.path.trim() : '';

      if (source && !['git', 'local'].includes(source)) {
        errors.push(createError(relativePath, 'project-invalid-repo-source', `${prefix}.source must be git or local.`));
      }

      if (source === 'local' || (!source && !remote && sourcePath)) {
        if (!['local-only', 'local-primary'].includes(data.mode)) {
          errors.push(createError(relativePath, 'project-invalid-repo-source', `${prefix}.source local is supported only when mode is local-only or local-primary.`));
        }
        if (!sourcePath) {
          errors.push(createError(relativePath, 'project-invalid-repo-path', `${prefix}.path must be a non-empty string for local sources.`));
        }
      } else if (!remote) {
        errors.push(createError(relativePath, 'project-invalid-repo-remote', `${prefix}.remote must be a non-empty string for Git-backed sources.`));
      }
    }
  }

  if (data.sync !== undefined) {
    if (!isPlainObject(data.sync)) {
      errors.push(createError(relativePath, 'project-invalid-sync', 'project.yaml field "sync" must be a mapping when present.'));
    } else {
      for (const key of Object.keys(data.sync)) {
        if (!KNOWN_SYNC_FIELDS.has(key)) {
          warnings.push(createWarning('project-unknown-sync-field', `Unknown sync field "sync.${key}".`));
        }

        const normalizedKey = key.toLowerCase();
        if (SECRET_BEARING_SYNC_FIELDS.includes(normalizedKey)) {
          errors.push(
            createError(
              relativePath,
              'project-inline-secret',
              `sync.${key} looks like a secret-bearing field and must not be stored in project.yaml.`,
            ),
          );
        }
      }

      if (data.sync.credential_source === 'env' && typeof data.sync.credential_env_var !== 'string') {
        errors.push(
          createError(
            relativePath,
            'project-missing-credential-env-var',
            'sync.credential_source "env" requires sync.credential_env_var.',
          ),
        );
      }
    }
  }

  if (data.metadata !== undefined && JSON.stringify(data.metadata).length > 500) {
    warnings.push(
      createWarning(
        'project-metadata-too-large',
        'project.yaml metadata is unusually large and may be drifting into narrative content.',
      ),
    );
  }

  return {
    extracted: {
      format_version: Number.isInteger(data.format_version) ? data.format_version : null,
      name: typeof data.name === 'string' ? data.name : null,
      slug: typeof data.slug === 'string' ? data.slug : null,
      description: typeof data.description === 'string' ? data.description : null,
      mode: typeof data.mode === 'string' ? data.mode : null,
      repo_ids: repoIds,
      repos: Array.isArray(data.repos)
        ? data.repos
            .filter((repo) => isPlainObject(repo) && typeof repo.id === 'string')
            .map((repo) => ({
              id: repo.id,
              source: typeof repo.source === 'string' ? repo.source : (typeof repo.remote === 'string' ? 'git' : 'local'),
              remote: typeof repo.remote === 'string' ? repo.remote : null,
              path: typeof repo.path === 'string' ? repo.path : null,
              default_branch: typeof repo.default_branch === 'string' ? repo.default_branch : null,
            }))
        : [],
    },
    warnings,
    errors,
  };
}

function parseArchitectureDocument(options) {
  const warnings = [];
  const errors = [];

  try {
    const frontmatter = parseFrontmatter(options.content, { sourceName: options.relativePath });

    if (!frontmatter.hasFrontmatter || !isPlainObject(frontmatter.data)) {
      errors.push(
        createError(options.relativePath, 'architecture-missing-frontmatter', 'Architecture docs require YAML frontmatter.'),
      );
      return { kind: 'architecture', extracted: null, warnings, errors };
    }

    const data = frontmatter.data;
    const requiredFields = options.relativePath === 'architecture/overview/project-shape.md'
      ? ['status']
      : ['domain', 'feature', 'component', 'status'];

    for (const field of requiredFields) {
      if (typeof data[field] !== 'string' || data[field].trim() === '') {
        errors.push(
          createError(
            options.relativePath,
            'architecture-missing-field',
            `Architecture doc frontmatter requires non-empty field "${field}".`,
          ),
        );
      }
    }

    if (data.repo !== undefined && data.repos !== undefined) {
      errors.push(
        createError(options.relativePath, 'architecture-repo-and-repos', 'Use either repo or repos, not both.'),
      );
    }

    const repoIds = [];
    if (typeof data.repo === 'string' && data.repo.trim() !== '') {
      repoIds.push(data.repo);
    } else if (Array.isArray(data.repos)) {
      for (const repoId of data.repos) {
        if (typeof repoId === 'string' && repoId.trim() !== '') {
          repoIds.push(repoId);
        }
      }
    }

    for (const repoId of repoIds) {
      if (!options.repoIds.has(repoId)) {
        errors.push(
          createError(
            options.relativePath,
            'architecture-unknown-repo',
            `Architecture doc references repo "${repoId}" which is not declared in project.yaml.`,
          ),
        );
      }
    }

    if (typeof data.status === 'string' && !KNOWN_ARCHITECTURE_STATUSES.has(data.status)) {
      warnings.push(
        createWarning('architecture-unknown-status', `Unknown architecture status "${data.status}".`),
      );
    }

    const sections = extractLevelTwoSections(frontmatter.body);
    for (const section of RECOMMENDED_ARCHITECTURE_SECTIONS) {
      if (!sections.has(section.toLowerCase())) {
        warnings.push(
          createWarning(
            'architecture-missing-section',
            `Architecture doc is missing recommended section "## ${section}".`,
          ),
        );
      }
    }

    if (repoIds.length === 0 && /##\s+Involved files/i.test(frontmatter.body) && /`[^`]+\/[^`]+`/.test(frontmatter.body)) {
      warnings.push(
        createWarning(
          'architecture-missing-repo-scope',
          'Architecture doc appears to describe implementation files but does not declare repo or repos.',
        ),
      );
    }

    return {
      kind: 'architecture',
      extracted: {
        domain: typeof data.domain === 'string' ? data.domain : null,
        feature: typeof data.feature === 'string' ? data.feature : null,
        component: typeof data.component === 'string' ? data.component : null,
        status: typeof data.status === 'string' ? data.status : null,
        repo_ids: repoIds,
      },
      warnings,
      errors,
    };
  } catch (error) {
    errors.push(
      createError(
        options.relativePath,
        'architecture-parse-failed',
        error instanceof Error ? error.message : 'Failed to parse architecture document.',
      ),
    );

    return {
      kind: 'architecture',
      extracted: null,
      warnings,
      errors,
    };
  }
}

function parseDecisionDocument(options) {
  const warnings = [];
  const errors = [];
  const entries = extractDecisionEntries(options.content);
  const malformedHeadings = extractMalformedDecisionHeadings(options.content);

  for (const heading of malformedHeadings) {
    errors.push(
      createError(
        options.relativePath,
        'decision-invalid-id',
        `Decision heading "${heading}" must use zero-padded D-NNN or higher.`,
      ),
    );
  }

  if (entries.length === 0) {
    if (malformedHeadings.length > 0) {
      return { kind: 'decision', extracted: null, warnings, errors };
    }

    errors.push(
      createError(options.relativePath, 'decision-missing-entries', 'Decision files must contain at least one resolvable decision entry.'),
    );
    return { kind: 'decision', extracted: null, warnings, errors };
  }

  const decisionIds = [];
  for (const entry of entries) {
    if (!entry.decisionId || entry.decisionId <= 0) {
      errors.push(createError(options.relativePath, 'decision-invalid-id', 'Decision heading must include zero-padded D-<NNN>.'));
      continue;
    }

    decisionIds.push(entry.decisionId);

    if (!/\*\*Timestamp:\*\*\s+.+/m.test(entry.body)) {
      errors.push(
        createError(
          options.relativePath,
          'decision-missing-timestamp',
          `Decision D-${entry.decisionId} is missing "**Timestamp:**".`,
        ),
      );
    }

    if (!/\*\*Decision:\*\*\s+.+/m.test(entry.body)) {
      errors.push(
        createError(
          options.relativePath,
          'decision-missing-decision',
          `Decision D-${entry.decisionId} is missing "**Decision:**".`,
        ),
      );
    }

    if (!/\*\*Rationale:\*\*\s+.+/m.test(entry.body)) {
      warnings.push(
        createWarning('decision-missing-rationale', `Decision D-${entry.decisionId} is missing "**Rationale:**".`),
      );
    }
  }

  decisionIds.sort((left, right) => left - right);

  return {
    kind: 'decision',
    extracted: {
      decision_ids: decisionIds,
    },
    warnings,
    errors,
  };
}

function parseSessionDocument(options) {
  const warnings = [];
  const errors = [];
  const filenameMatch = options.relativePath.match(
    /^sessions\/(\d{4}-\d{2}-\d{2})-(\d+)-([a-z0-9-]+)\.md$/i,
  );
  const h1Match = options.content.match(/^#\s+Session(?:\s+—\s+(.+))?$/m);

  if (!filenameMatch && !h1Match) {
    errors.push(
      createError(
        options.relativePath,
        'session-unrecognized',
        'Session note must use the session filename pattern or a "# Session" heading.',
      ),
    );
    return { kind: 'session', extracted: null, warnings, errors };
  }

  if (!filenameMatch) {
    warnings.push(
      createWarning(
        'session-filename-mismatch',
        'Session note filename does not match the recommended YYYY-MM-DD-N-display-title.md pattern.',
      ),
    );
  }

  const sections = extractLevelTwoSections(options.content);
  for (const section of RECOMMENDED_SESSION_SECTIONS) {
    if (!sections.has(section.toLowerCase())) {
      warnings.push(
        createWarning('session-missing-section', `Session note is missing recommended section "## ${section}".`),
      );
    }
  }

  const title = extractSessionTitle(options.content, filenameMatch);

  return {
    kind: 'session',
    extracted: {
      title,
      session_date: filenameMatch ? filenameMatch[1] : null,
      session_number: filenameMatch ? Number(filenameMatch[2]) : null,
    },
    warnings,
    errors,
  };
}

function extractDecisionEntries(content) {
  const matches = [...content.matchAll(/^###\s+D-(\d{3,})\b.*$/gm)];

  return matches.map((match, index) => {
    const bodyStart = match.index ?? 0;
    const nextMatch = matches[index + 1];
    const bodyEnd = nextMatch?.index ?? content.length;

    return {
      decisionId: Number(match[1]),
      body: content.slice(bodyStart, bodyEnd),
    };
  });
}

function extractMalformedDecisionHeadings(content) {
  return [...content.matchAll(/^###\s+(D-\d{1,2})\b.*$/gm)].map((match) => match[1]);
}

function findDuplicateDecisionErrors(documents) {
  const seen = new Map();
  const errors = [];

  for (const document of documents) {
    const decisionIds = document.extracted?.decision_ids ?? [];
    for (const decisionId of decisionIds) {
      const firstPath = seen.get(decisionId);
      if (!firstPath) {
        seen.set(decisionId, document.path);
        continue;
      }

      errors.push(
        createError(
          document.path,
          'duplicate-decision-id',
          `Decision D-${decisionId} is duplicated in both ${firstPath} and ${document.path}.`,
        ),
      );
    }
  }

  return errors;
}

function extractLevelTwoSections(content) {
  const sections = new Set();
  for (const match of content.matchAll(/^##\s+(.+)$/gm)) {
    sections.add(match[1].trim().toLowerCase());
  }
  return sections;
}

function extractSessionTitle(content, filenameMatch) {
  const h1WithNumber = content.match(/^#\s+Session\s+—\s+\d{4}-\d{2}-\d{2}-\d+\s+—\s+(.+)$/m);
  if (h1WithNumber) {
    return h1WithNumber[1].trim();
  }

  const simpleH1 = content.match(/^#\s+Session\s+—\s+(.+)$/m);
  if (simpleH1) {
    return simpleH1[1].trim();
  }

  if (!filenameMatch) {
    return null;
  }

  return filenameMatch[3]
    .split('-')
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function finalizeDocument(document) {
  const byteLength = Buffer.byteLength(document.content, 'utf8');

  return {
    path: document.path,
    kind: document.kind,
    content: document.content,
    contentHash: sha256Text(document.content),
    byteLength,
    extracted: document.extracted,
    warnings: document.warnings,
    errors: document.errors,
  };
}

function createWarning(code, message) {
  return { code, message, severity: 'warning' };
}

function createError(path, code, message) {
  return { path, code, message, severity: 'error' };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}
