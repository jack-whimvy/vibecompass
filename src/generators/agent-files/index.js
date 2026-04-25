import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSimpleYaml } from '../../simple-yaml.js';
import { loadProjectReadModel } from '../../read-model.js';
import { applyManagedBlock } from './markers.js';
import { buildAgentContext } from './template.js';
import { claudeMdFormat } from './claude-md.js';
import { agentsMdFormat } from './agents-md.js';
import { cursorRulesFormat } from './cursor-rules.js';
import { copilotInstructionsFormat } from './copilot-instructions.js';

const FORMATS = [
  claudeMdFormat,
  agentsMdFormat,
  cursorRulesFormat,
  copilotInstructionsFormat,
];

const FORMAT_MAP = new Map(FORMATS.map((format) => [format.name, format]));

export async function syncAgentInstructionFiles(options = {}) {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const rootDir = path.resolve(cwd, options.rootDir ?? '.compass');
  const toolingRootDir = options.toolingRootDir
    ? path.resolve(cwd, options.toolingRootDir)
    : cwd;
  const requestedFormat = normalizeOptionalString(options.format);
  const dryRun = Boolean(options.dryRun);

  const projectConfig = await readProjectConfig(rootDir);
  const selection = resolveEnabledFormats(projectConfig, requestedFormat);

  if (selection.disabledFormat) {
    const outputPath = path.join(toolingRootDir, selection.disabledFormat.path);
    return {
      rootDir,
      toolingRootDir,
      dryRun,
      results: [
        {
          format: selection.disabledFormat.name,
          path: outputPath,
          relativePath: toPosix(path.relative(toolingRootDir, outputPath)),
          status: 'disabled',
          warning: `Format "${selection.disabledFormat.name}" is disabled in metadata.agent_files; left untouched.`,
          changed: false,
        },
      ],
    };
  }

  const readModel = await loadProjectReadModel(rootDir);
  const context = buildAgentContext(readModel);
  const results = [];

  for (const format of selection.formats) {
    const outputPath = path.join(toolingRootDir, format.path);
    const existingContent = await readExistingFile(outputPath);
    const generatedContent = format.render(context);
    const applied = applyManagedBlock(existingContent, generatedContent);

    if (!dryRun && applied.warning === null && applied.content !== existingContent) {
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, applied.content, 'utf8');
    }

    results.push({
      format: format.name,
      path: outputPath,
      relativePath: toPosix(path.relative(toolingRootDir, outputPath)),
      status: dryRun && applied.warning === null ? `dry-run-${applied.status}` : applied.status,
      warning: applied.warning,
      changed: applied.warning === null && applied.content !== existingContent,
    });
  }

  return {
    rootDir,
    toolingRootDir,
    dryRun,
    results,
  };
}

export function getSupportedAgentFormats() {
  return FORMATS.map((format) => format.name);
}

async function readProjectConfig(rootDir) {
  const source = await readFile(path.join(rootDir, 'project.yaml'), 'utf8');
  return parseSimpleYaml(source, { sourceName: 'project.yaml' });
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

function resolveEnabledFormats(projectConfig, requestedFormat) {
  const configured = projectConfig?.metadata?.agent_files;
  const enabledNames = FORMATS
    .filter((format) => configured?.[format.name] !== false)
    .map((format) => format.name);

  if (requestedFormat) {
    if (!FORMAT_MAP.has(requestedFormat)) {
      throw new Error(`Unknown agent file format "${requestedFormat}". Supported formats: ${getSupportedAgentFormats().join(', ')}.`);
    }

    if (!enabledNames.includes(requestedFormat)) {
      return {
        formats: [],
        disabledFormat: FORMAT_MAP.get(requestedFormat),
      };
    }

    return {
      formats: [FORMAT_MAP.get(requestedFormat)],
      disabledFormat: null,
    };
  }

  return {
    formats: enabledNames.map((name) => FORMAT_MAP.get(name)),
    disabledFormat: null,
  };
}

function normalizeOptionalString(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}
