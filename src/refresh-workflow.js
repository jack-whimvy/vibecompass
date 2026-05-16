import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectProjectCompatibility } from './compatibility.js';
import { prepareStateManifest, writeStateManifest } from './manifest.js';
import { serializeProjectConfig } from './project-yaml.js';
import { buildWorkflowScaffoldFiles } from './scaffold.js';
import { parseSimpleYaml } from './simple-yaml.js';
import { syncAgentInstructionFiles } from './generators/agent-files/index.js';
import { PACKAGE_VERSION } from './version.js';

export async function refreshWorkflow(options = {}) {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const rootDir = path.resolve(cwd, options.rootDir ?? '.compass');
  const toolingRootDir = options.toolingRootDir
    ? path.resolve(cwd, options.toolingRootDir)
    : cwd;
  const apply = Boolean(options.apply);
  const dryRun = !apply;

  const compatibility = await inspectProjectCompatibility({ rootDir, cwd });
  if (apply && compatibility.package.status === 'ahead' && !options.allowDowngradeTemplates) {
    throw new Error(
      'This root was refreshed by a newer VibeCompass package. Pass --allow-downgrade-templates to apply older templates with this CLI.',
    );
  }

  const projectFilePath = path.join(rootDir, 'project.yaml');
  const projectConfig = await readProjectConfig(projectFilePath);
  const rootRelativePath = toPosix(path.relative(toolingRootDir, rootDir) || '.');
  const contextRelativeToToolingRoot = toPosix(
    path.relative(toolingRootDir, path.join(rootDir, 'context.md')) || 'context.md',
  );

  const workflowFiles = await planWorkflowFiles({
    rootDir,
    toolingRootDir,
    projectConfig,
    rootRelativePath,
    contextRelativeToToolingRoot,
  });

  if (apply) {
    await applyWorkflowFiles(workflowFiles);
  }

  const projectStamp = planProjectStamp(projectConfig, compatibility, {
    updatePackageStamp: Boolean(options.updatePackageStamp),
  });
  if (apply && projectStamp.changed) {
    await mkdir(path.dirname(projectFilePath), { recursive: true });
    await writeFile(projectFilePath, serializeProjectConfig(projectStamp.projectConfig), 'utf8');
  }

  const manifest = apply
    ? await writeStateManifest(rootDir)
    : await prepareStateManifest(rootDir);

  const agentFileSync = await syncAgentInstructionFiles({
    rootDir,
    toolingRootDir,
    dryRun,
  });

  return {
    rootDir,
    toolingRootDir,
    dryRun,
    applied: apply,
    compatibility,
    projectFile: {
      path: projectFilePath,
      status: projectStamp.status,
      changed: projectStamp.changed,
      packageVersion: projectStamp.packageVersion,
      warning: projectStamp.warning,
    },
    workflowFiles: workflowFiles.map((file) => ({
      kind: file.kind,
      path: file.path,
      relativePath: toPosix(path.relative(rootDir, file.path)),
      status: file.status,
      changed: file.changed,
      warning: file.warning,
    })),
    manifest: {
      path: manifest.manifestPath,
      status: apply ? 'updated' : 'planned-update',
      documentCount: manifest.manifest.canonical.document_count,
      warningCount: manifest.manifest.canonical.warning_count,
    },
    agentFileSync,
  };
}

async function readProjectConfig(projectFilePath) {
  try {
    return parseSimpleYaml(await readFile(projectFilePath, 'utf8'), {
      sourceName: projectFilePath,
    });
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(`No project.yaml found in ${path.dirname(projectFilePath)}. Run "vibecompass init" first.`);
    }

    throw error;
  }
}

async function planWorkflowFiles(options) {
  const scaffold = buildWorkflowScaffoldFiles(options);
  const files = [];

  for (const file of scaffold.files) {
    const existingContent = await readExistingFile(file.path);
    const safety = resolveWorkflowFileSafety(file, existingContent);
    const changed = safety.status !== 'skipped' && existingContent !== file.content;
    files.push({
      ...file,
      existingContent,
      status: changed ? (existingContent === null ? 'create' : 'update') : safety.status,
      changed,
      warning: safety.warning,
    });
  }

  return files;
}

function resolveWorkflowFileSafety(file, existingContent) {
  if (existingContent === null) {
    return { status: 'create', warning: null };
  }

  if (existingContent === file.content) {
    return { status: 'unchanged', warning: null };
  }

  if (file.kind === 'context') {
    return { status: 'update', warning: null };
  }

  if (isGeneratedWorkflowGuide(file.kind, existingContent)) {
    return { status: 'update', warning: null };
  }

  return {
    status: 'skipped',
    warning: 'Existing workflow guide does not match a VibeCompass-generated guide shape; left untouched.',
  };
}

function isGeneratedWorkflowGuide(kind, content) {
  // These sentinel strings are the safety boundary for refreshing guide files.
  // Keep them in lockstep with the scaffold guide templates.
  if (kind === 'architecture-guide') {
    return content.includes('Each component doc is canonical. This README is only a convenience guide.');
  }
  if (kind === 'decisions-guide') {
    return content.includes('This README is guidance only; canonical decision content lives in the domain files.');
  }
  if (kind === 'sessions-guide') {
    return content.includes('Those scratch files are session-scoped working artifacts, not finalized history.');
  }

  return false;
}

// Refresh writes are intentionally non-atomic, matching init/scaffold behavior.
async function applyWorkflowFiles(files) {
  for (const file of files) {
    if (!file.changed || file.status === 'skipped') {
      continue;
    }

    await mkdir(path.dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content, 'utf8');
  }
}

function planProjectStamp(projectConfig, compatibility, options) {
  const currentMetadata = projectConfig.metadata && typeof projectConfig.metadata === 'object'
    ? projectConfig.metadata
    : {};
  const currentStamp = currentMetadata.package_version;
  const hasStringStamp = typeof currentStamp === 'string' && currentStamp.trim() !== '';
  const missingStamp = currentStamp === undefined || currentStamp === null || currentStamp === '';
  const shouldStamp = missingStamp || Boolean(options.updatePackageStamp);

  if (!shouldStamp) {
    return {
      projectConfig,
      status: 'unchanged',
      changed: false,
      packageVersion: hasStringStamp ? currentStamp : null,
      warning: ['behind', 'invalid'].includes(compatibility.package.status)
        ? 'Existing package stamp left untouched; pass --update-package-stamp to update it.'
        : null,
    };
  }

  const nextConfig = {
    ...projectConfig,
    metadata: {
      ...currentMetadata,
      package_version: PACKAGE_VERSION,
    },
  };
  const changed = currentStamp !== PACKAGE_VERSION;

  return {
    projectConfig: nextConfig,
    status: changed ? (missingStamp ? 'stamp-create' : 'stamp-update') : 'unchanged',
    changed,
    packageVersion: PACKAGE_VERSION,
    warning: null,
  };
}

async function readExistingFile(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}
