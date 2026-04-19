#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { initializeProjectMemory } from './init.js';

export async function runCli(argv, io = createDefaultIo()) {
  const parsed = parseCliArgs(argv);

  if (parsed.command === 'help') {
    io.stdout.write(`${usageText()}\n`);
    return 0;
  }

  if (parsed.command !== 'init') {
    throw new Error(`Unknown command "${parsed.command}".`);
  }

  const result = await initializeProjectMemory(parsed.options);
  io.stdout.write(`Initialized VibeCompass project memory at ${result.rootDir}\n`);
  io.stdout.write(`Wrote ${result.projectFilePath}\n`);
  if (result.gitignoreUpdated) {
    io.stdout.write(`Updated ${result.gitignorePath} to ignore state/\n`);
  } else {
    io.stdout.write(`${result.gitignorePath} already ignored state/\n`);
  }
  io.stdout.write(
    `Generated ${result.manifestPath} (${result.manifest.canonical.document_count} canonical docs, ${result.manifest.canonical.warning_count} warnings)\n`,
  );

  if (result.syncEnvVar) {
    io.stdout.write(`Next step: set ${result.syncEnvVar} locally before your first sync.\n`);
  }

  return 0;
}

export function parseCliArgs(argv) {
  const [command, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help' };
  }

  if (command !== 'init') {
    return { command };
  }

  const parsed = {
    repos: [],
    repoBranches: new Map(),
  };

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (token === '--force') {
      parsed.force = true;
      continue;
    }

    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument "${token}".`);
    }

    const value = rest[index + 1];
    if (value === undefined) {
      throw new Error(`Flag "${token}" requires a value.`);
    }
    index += 1;

    switch (token) {
      case '--root':
        parsed.rootDir = value;
        break;
      case '--name':
        parsed.name = value;
        break;
      case '--slug':
        parsed.slug = value;
        break;
      case '--description':
        parsed.description = value;
        break;
      case '--mode':
        parsed.mode = value;
        break;
      case '--repo': {
        const [id, remote] = splitAssignment(value, '--repo');
        parsed.repos.push({ id, remote });
        break;
      }
      case '--repo-branch': {
        const [id, defaultBranch] = splitAssignment(value, '--repo-branch');
        parsed.repoBranches.set(id, defaultBranch);
        break;
      }
      case '--sync-api-url':
        parsed.syncApiUrl = value;
        break;
      case '--sync-project-id':
        parsed.syncProjectId = value;
        break;
      case '--sync-credential-env-var':
        parsed.syncCredentialEnvVar = value;
        break;
      default:
        throw new Error(`Unknown flag "${token}".`);
    }
  }

  for (const repo of parsed.repos) {
    const defaultBranch = parsed.repoBranches.get(repo.id);
    if (defaultBranch) {
      repo.defaultBranch = defaultBranch;
    }
  }

  const syncValues = [
    parsed.syncApiUrl,
    parsed.syncProjectId,
    parsed.syncCredentialEnvVar,
  ].filter(Boolean);

  return {
    command: 'init',
    options: {
      rootDir: parsed.rootDir,
      name: parsed.name,
      slug: parsed.slug,
      description: parsed.description,
      mode: parsed.mode,
      repos: parsed.repos,
      force: parsed.force,
      ...(syncValues.length > 0
        ? {
            sync: {
              apiUrl: parsed.syncApiUrl,
              projectId: parsed.syncProjectId,
              credentialEnvVar: parsed.syncCredentialEnvVar,
            },
          }
        : {}),
    },
  };
}

function splitAssignment(value, flagName) {
  const separatorIndex = value.indexOf('=');
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    throw new Error(`${flagName} expects id=value.`);
  }

  return [value.slice(0, separatorIndex), value.slice(separatorIndex + 1)];
}

function usageText() {
  return [
    'Usage:',
    '  vibecompass init --name <project-name> --mode <local-only|local-primary|hosted-only> --repo <id=remote> [options]',
    '',
    'Options:',
    '  --root <path>                        Project-memory root. Defaults to .compass',
    '  --slug <slug>                        Optional project slug',
    '  --description <text>                 Optional short project description',
    '  --repo <id=remote>                   Repeatable repo descriptor',
    '  --repo-branch <id=branch>            Optional per-repo default branch',
    '  --sync-api-url <url>                 Optional hosted sync api_url',
    '  --sync-project-id <id>               Optional hosted sync project_id',
    '  --sync-credential-env-var <name>     Optional hosted sync env var reference',
    '  --force                              Overwrite an existing project.yaml',
  ].join('\n');
}

function createDefaultIo() {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

async function main() {
  try {
    const exitCode = await runCli(process.argv.slice(2));
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (isDirectExecution(process.argv[1], import.meta.url)) {
  main();
}

export function isDirectExecution(entryPath, moduleUrl = import.meta.url) {
  if (!entryPath) {
    return false;
  }

  try {
    return moduleUrl === pathToFileURL(realpathSync(entryPath)).href;
  } catch {
    return false;
  }
}
