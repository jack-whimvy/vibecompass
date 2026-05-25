import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseFrontmatter } from './frontmatter.js';
import { writeStateManifest } from './manifest.js';
import { parseSimpleYaml } from './simple-yaml.js';

export async function preflightDocsReview(options = {}, environment = {}) {
  validateDocsReviewMode(options);
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const rootDir = path.resolve(cwd, options.rootDir ?? '.compass');
  const statePath = path.join(rootDir, 'state', 'docs-review.json');

  if (options.applyOutput) {
    return applyDocsReviewOutput({
      rootDir,
      statePath,
      outputPath: options.outputPath,
      llm: options.llm,
      model: options.model,
    });
  }

  if (options.applyDecisionArtifact) {
    return applyDecisionArtifact({
      rootDir,
      statePath,
      artifactId: options.artifactId,
      refreshIndex: options.refreshIndex,
    });
  }

  if (options.complete) {
    return completeDocsReview({
      rootDir,
      statePath,
      llm: options.llm,
      model: options.model,
    });
  }

  if (options.pollHosted) {
    return pollHostedDocsReview({
      rootDir,
      statePath,
      env: environment.env ?? process.env,
      fetch: environment.runtime?.fetch ?? globalThis.fetch,
    });
  }

  const projectFilePath = path.join(rootDir, 'project.yaml');
  const project = parseSimpleYaml(await readFile(projectFilePath, 'utf8'), {
    sourceName: projectFilePath,
  });
  const reviewConfig = options.guided
    ? await promptForReviewConfig(options, environment)
    : normalizeReviewConfig(options);
  const env = environment.env ?? process.env;
  const localProvider = resolveLocalProvider(options);
  const runtime = resolveDocsReviewRuntime(project, {
    env,
    guided: Boolean(options.guided),
    localProvider,
    runLocal: shouldRunLocal(options),
    anthropicEnvVar: options.anthropicEnvVar ?? 'ANTHROPIC_API_KEY',
  });
  const reviewPrompt = renderReviewPrompt({
    project,
    rootDir,
    llm: reviewConfig.llm,
    model: reviewConfig.model,
  });

  const status = options.submitHosted
    ? 'hosted-review-requested'
    : shouldRunLocal(options)
      ? 'local-review-generated'
      : 'external-review-requested';
  const hosted = options.submitHosted
    ? await submitHostedDocsReview({
      env,
      project,
      reviewConfig,
      reviewPrompt,
      rootDir,
      runtime,
      manifest: await writeStateManifest(rootDir),
      fetch: environment.runtime?.fetch ?? globalThis.fetch,
    })
    : null;
  const localReview = shouldRunLocal(options)
    ? await runLocalDocsReview({
      env,
      maxTokens: options.maxTokens,
      model: reviewConfig.model,
      reviewPrompt,
      rootDir,
      statePath,
      runtime,
      fetch: environment.runtime?.fetch ?? globalThis.fetch,
    })
    : null;

  await writeDocsReviewMarker(statePath, {
    status,
    requested_at: new Date().toISOString(),
    llm: reviewConfig.llm,
    model: reviewConfig.model,
    runtime,
    ...(hosted ? { hosted } : {}),
    ...(localReview ? { local_review: localReview } : {}),
    completed_at: null,
  });

  return {
    rootDir,
    projectFilePath,
    statePath,
    mode: project.mode,
    llm: reviewConfig.llm,
    model: reviewConfig.model,
    runtime,
    status,
    hosted,
    localReview,
    reviewPrompt,
    warnings: [
      ...(localReview?.truncated ? [`Local ${localReview.provider} docs-review stopped at max_tokens; saved output may be partial.`] : []),
    ],
    message: renderDocsReviewMessage(options),
  };
}

async function completeDocsReview(options) {
  let current = {};
  try {
    current = JSON.parse(await readFile(options.statePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`No docs-review marker found at ${options.statePath}. Run docs-review before marking it complete.`);
    }

    if (error?.code !== 'ENOENT') {
      throw new Error(`Could not read docs-review marker at ${options.statePath}: ${error.message}`);
    }
  }

  const llm = normalizeOptionalString(options.llm) ?? current.llm ?? null;
  const model = normalizeOptionalString(options.model) ?? current.model ?? null;
  const marker = {
    ...current,
    status: 'completed',
    ...(llm ? { llm } : {}),
    ...(model ? { model } : {}),
    completed_at: new Date().toISOString(),
  };

  await writeDocsReviewMarker(options.statePath, marker);

  return {
    rootDir: options.rootDir,
    statePath: options.statePath,
    status: 'completed',
    llm,
    model,
    runtime: current.runtime ?? null,
    hosted: current.hosted ?? null,
    applied: current.applied ?? null,
    appliedDecisionArtifact: current.applied_decision_artifact ?? null,
    reviewPrompt: null,
    warnings: [],
    message: 'Docs-review marker completed. Future start-session warnings can treat this root as reviewed.',
  };
}

async function applyDocsReviewOutput(options) {
  const current = await readDocsReviewMarker(options.statePath);
  const outputPath = options.outputPath
    ? path.resolve(options.rootDir, options.outputPath)
    : path.join(path.dirname(options.statePath), 'docs-review-output.md');
  const source = await readFile(outputPath, 'utf8');
  const blocks = parseArchitectureDocBlocks(source);

  if (blocks.length === 0) {
    const malformedFenceCount = countMalformedArchitectureDocFences(source);
    if (malformedFenceCount > 0) {
      throw new Error(
        `Malformed architecture doc fence found in ${outputPath}. Expected fence openings like \`\`\`vibecompass-architecture-doc path=architecture/domain/feature/component.md\` with exactly one path attribute and no extra attributes.`,
      );
    }

    throw new Error(
      `No accepted architecture doc blocks found in ${outputPath}. Expected fenced blocks like \`\`\`vibecompass-architecture-doc path=architecture/domain/feature/component.md\`.`,
    );
  }

  validateArchitectureDocBlocks(blocks);

  const applied = [];
  for (const block of blocks) {
    const absoluteTargetPath = path.join(options.rootDir, block.path);
    await mkdir(path.dirname(absoluteTargetPath), { recursive: true });
    const existed = await pathExists(absoluteTargetPath);
    await writeFile(absoluteTargetPath, ensureTrailingNewline(block.content), 'utf8');
    applied.push({ path: block.path, status: existed ? 'overwritten' : 'created' });
  }

  const llm = normalizeOptionalString(options.llm) ?? current.llm ?? null;
  const model = normalizeOptionalString(options.model) ?? current.model ?? null;
  const marker = {
    ...current,
    status: 'completed',
    ...(llm ? { llm } : {}),
    ...(model ? { model } : {}),
    applied: {
      output_path: outputPath,
      architecture_docs: applied,
      applied_at: new Date().toISOString(),
    },
    completed_at: new Date().toISOString(),
  };

  await writeDocsReviewMarker(options.statePath, marker);

  return {
    rootDir: options.rootDir,
    statePath: options.statePath,
    status: 'completed',
    llm,
    model,
    runtime: current.runtime ?? null,
    hosted: current.hosted ?? null,
    applied: marker.applied,
    reviewPrompt: null,
    warnings: [],
    message: `Applied ${applied.length} accepted architecture doc${applied.length === 1 ? '' : 's'} and completed the docs-review marker.`,
  };
}

async function applyDecisionArtifact(options) {
  const current = await readDocsReviewMarker(options.statePath);
  const artifactId = normalizeOptionalString(options.artifactId);
  if (!artifactId) {
    throw new Error('docs-review --apply-decision-artifact requires --artifact <artifact-id>.');
  }

  const artifact = (current.hosted?.artifacts ?? []).find(
    (item) => item?.artifact_id === artifactId,
  );
  if (!artifact) {
    throw new Error(`Decision artifact ${artifactId} was not found in ${options.statePath}. Run docs-review --poll-hosted first.`);
  }
  if (artifact.artifact_type !== 'decision_recommendation') {
    throw new Error(`Artifact ${artifactId} is ${artifact.artifact_type}, not decision_recommendation.`);
  }

  const content = artifact.content ?? {};
  const targetPath = normalizeDecisionTargetPath(
    content.target_path ?? artifact.target_path ?? 'decisions/cross-cutting.md',
  );
  const title = normalizeOptionalString(content.title ?? artifact.title);
  const decision = normalizeOptionalString(content.decision ?? artifact.summary);
  const rationale = normalizeOptionalString(content.rationale);
  const context = normalizeOptionalString(content.context);

  if (!title || !decision) {
    throw new Error(`Decision artifact ${artifactId} must include title and decision content.`);
  }
  if (!rationale) {
    throw new Error(`Decision artifact ${artifactId} must include a non-empty rationale before it can be appended locally.`);
  }

  const nextDecisionId = await readNextDecisionId(options.rootDir);
  const targetFilePath = path.join(options.rootDir, targetPath);
  await mkdir(path.dirname(targetFilePath), { recursive: true });

  let existingContent = '';
  try {
    existingContent = await readFile(targetFilePath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    existingContent = `# ${path.basename(targetPath, '.md')} decisions\n`;
  }

  const entry = renderDecisionEntry({
    decisionId: nextDecisionId,
    title,
    decision,
    rationale,
    context,
    artifactId,
  });
  await writeFile(targetFilePath, `${existingContent.trimEnd()}\n\n${entry}`, 'utf8');
  const indexResult = options.refreshIndex
    ? await refreshDecisionIndex(options.rootDir)
    : {
      refreshed: false,
      warnings: [
        'decisions/INDEX.md was not refreshed. Run again with --refresh-index if this root uses the package-generated flat index, or update the project-specific index manually.',
      ],
    };

  const appliedDecisionArtifact = {
    artifact_id: artifactId,
    decision_id: nextDecisionId,
    target_path: targetPath,
    applied_at: new Date().toISOString(),
    refreshed_index: indexResult.refreshed,
  };
  await writeDocsReviewMarker(options.statePath, {
    ...current,
    applied_decision_artifact: appliedDecisionArtifact,
    hosted: {
      ...current.hosted,
      artifacts: (current.hosted?.artifacts ?? []).map((item) =>
        item?.artifact_id === artifactId
          ? { ...item, local_status: 'applied', local_decision_id: nextDecisionId }
          : item,
      ),
    },
  });

  return {
    rootDir: options.rootDir,
    statePath: options.statePath,
    status: current.status ?? 'hosted-review-completed',
    llm: current.llm ?? null,
    model: current.model ?? null,
    runtime: current.runtime ?? null,
    hosted: current.hosted ?? null,
    appliedDecisionArtifact,
    reviewPrompt: null,
    warnings: indexResult.warnings,
    message: `Applied decision artifact ${artifactId} as D-${String(nextDecisionId).padStart(3, '0')} in ${targetPath}.`,
  };
}

async function readDocsReviewMarker(statePath) {
  try {
    return JSON.parse(await readFile(statePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`No docs-review marker found at ${statePath}. Run docs-review before applying output.`);
    }

    throw new Error(`Could not read docs-review marker at ${statePath}: ${error.message}`);
  }
}

function validateDocsReviewMode(options) {
  const enabled = [
    options.submitHosted ? '--submit-hosted' : null,
    options.pollHosted ? '--poll-hosted' : null,
    options.runLocal ? '--run-local' : null,
    options.runLocalAnthropic ? '--run-local-anthropic' : null,
    options.applyOutput ? '--apply-output' : null,
    options.applyDecisionArtifact ? '--apply-decision-artifact' : null,
    options.complete ? '--complete' : null,
  ].filter(Boolean);

  if (enabled.length > 1) {
    throw new Error(`docs-review accepts only one execution mode at a time. Conflicting flags: ${enabled.join(', ')}.`);
  }
}

async function promptForReviewConfig(options, environment) {
  if (options.llm && options.model) {
    return normalizeReviewConfig({
      llm: options.llm,
      model: options.model,
    });
  }

  const prompter = createPrompter(environment.io, environment.runtime);
  try {
    if (!options.llm) {
      prompter.write('Common choices: claude, codex, gemini. Custom provider names are allowed.\n');
    }
    const llm = options.llm ?? await askInput(prompter, 'Preferred LLM for architecture review', {
      defaultValue: 'claude',
    });
    const model = options.model ?? await askInput(prompter, 'Model name to record', {
      defaultValue: defaultModelForLlm(llm),
    });

    return normalizeReviewConfig({ llm, model });
  } finally {
    await prompter.close();
  }
}

function normalizeReviewConfig(options) {
  const llm = String(options.llm ?? options.provider ?? 'claude').trim();
  if (!llm) {
    throw new Error('docs-review requires a non-empty LLM provider name.');
  }

  const model = String(options.model ?? defaultModelForLlm(llm)).trim();
  if (!model) {
    throw new Error('docs-review requires a non-empty model name.');
  }

  return { llm, model };
}

function shouldRunLocal(options) {
  return Boolean(options.runLocal || options.runLocalAnthropic);
}

function resolveLocalProvider(options) {
  if (options.runLocalAnthropic) {
    return {
      provider: 'anthropic',
      credentialEnvVar: options.anthropicEnvVar ?? 'ANTHROPIC_API_KEY',
    };
  }

  const provider = normalizeOptionalString(options.provider);
  if (!provider) {
    return null;
  }

  if (provider !== 'anthropic') {
    throw new Error(`Unsupported local docs-review provider "${provider}". Supported providers: anthropic.`);
  }

  return {
    provider,
    credentialEnvVar: options.anthropicEnvVar ?? 'ANTHROPIC_API_KEY',
  };
}

function resolveDocsReviewRuntime(project, options) {
  const mode = project?.mode;
  const localProvider = options.localProvider;
  const hasLocalKey =
    localProvider &&
    typeof options.env?.[localProvider.credentialEnvVar] === 'string' &&
    options.env[localProvider.credentialEnvVar].trim() !== '';
  const hasHostedBinding =
    project?.sync &&
    typeof project.sync === 'object' &&
    typeof project.sync.api_url === 'string' &&
    typeof project.sync.project_id === 'string';

  if (mode === 'local-only') {
    if (options.runLocal && !localProvider) {
      throw new Error('docs-review --run-local requires --provider <name>. Supported providers: anthropic.');
    }

    if (options.runLocal && !hasLocalKey) {
      throw new Error(
        `docs-review --run-local --provider ${localProvider.provider} requires ${localProvider.credentialEnvVar}.`,
      );
    }

    return localProvider
      ? {
        provider: 'local',
        local_provider: localProvider.provider,
        credential_env_var: localProvider.credentialEnvVar,
      }
      : { provider: 'external' };
  }

  if (mode === 'local-primary') {
    if (options.runLocal) {
      if (!localProvider) {
        throw new Error('docs-review --run-local requires --provider <name>. Supported providers: anthropic.');
      }

      if (!hasLocalKey) {
        throw new Error(`docs-review --run-local --provider ${localProvider.provider} requires ${localProvider.credentialEnvVar}.`);
      }

      return {
        provider: 'local',
        local_provider: localProvider.provider,
        credential_env_var: localProvider.credentialEnvVar,
      };
    }

    if (hasHostedBinding) {
      return {
        provider: 'hosted',
        api_url: project.sync.api_url,
        project_id: project.sync.project_id,
        ...(typeof project.sync.credential_env_var === 'string'
          ? { credential_env_var: project.sync.credential_env_var }
        : {}),
      };
    }

    if (hasLocalKey) {
      return {
        provider: 'local',
        local_provider: localProvider.provider,
        credential_env_var: localProvider.credentialEnvVar,
      };
    }

    if (options.guided) {
      return { provider: 'external' };
    }

    throw new Error(
      `docs-review for local-primary projects requires a hosted sync binding or ${options.anthropicEnvVar}.`,
    );
  }

  if (mode === 'hosted-only') {
    if (options.runLocal) {
      throw new Error('docs-review --run-local is not supported for hosted-only projects. Use --submit-hosted, or switch the project to local-only/local-primary mode for direct local execution.');
    }

    if (!hasHostedBinding) {
      throw new Error('docs-review for hosted-only projects requires a hosted sync binding in project.yaml.');
    }

    return {
      provider: 'hosted',
      api_url: project.sync.api_url,
      project_id: project.sync.project_id,
      ...(typeof project.sync.credential_env_var === 'string'
        ? { credential_env_var: project.sync.credential_env_var }
        : {}),
    };
  }

  throw new Error('docs-review requires project.yaml mode to be local-only, local-primary, or hosted-only.');
}

async function runLocalDocsReview(options) {
  if (options.runtime.provider !== 'local') {
    throw new Error('docs-review --run-local requires local runtime.');
  }

  if (options.runtime.local_provider !== 'anthropic') {
    throw new Error(`Unsupported local docs-review provider "${options.runtime.local_provider}". Supported providers: anthropic.`);
  }

  return runLocalAnthropicDocsReview(options);
}

async function runLocalAnthropicDocsReview(options) {
  if (typeof options.fetch !== 'function') {
    throw new Error('docs-review --run-local --provider anthropic requires a fetch implementation.');
  }

  const credential = normalizeOptionalString(options.env?.[options.runtime.credential_env_var]);
  if (!credential) {
    throw new Error(`docs-review --run-local --provider anthropic requires ${options.runtime.credential_env_var}.`);
  }

  const response = await options.fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'x-api-key': credential,
    },
    body: JSON.stringify({
      model: options.model,
      max_tokens: normalizeMaxTokens(options.maxTokens),
      messages: [
        {
          role: 'user',
          content: options.reviewPrompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = typeof response.text === 'function' ? await response.text() : '';
    throw new Error(`Local Anthropic docs-review failed with ${response.status}${body ? `: ${body}` : ''}`);
  }

  const body = typeof response.json === 'function' ? await response.json() : {};
  const text = extractAnthropicText(body);
  if (!text) {
    throw new Error('Local Anthropic docs-review response did not include text content.');
  }

  const outputPath = path.join(path.dirname(options.statePath), 'docs-review-output.md');
  await writeFile(outputPath, `${text.trim()}\n`, 'utf8');

  return {
    provider: 'anthropic',
    output_path: outputPath,
    truncated: body.stop_reason === 'max_tokens',
  };
}

function extractAnthropicText(body) {
  if (!Array.isArray(body?.content)) {
    return null;
  }

  return body.content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n\n')
    .trim() || null;
}

function parseArchitectureDocBlocks(source) {
  const blocks = [];
  const pattern = /^```vibecompass-architecture-doc\s+path=([^\s`]+)\s*\n([\s\S]*?)^```[ \t]*$/gm;
  let match;

  while ((match = pattern.exec(source)) !== null) {
    blocks.push({
      path: normalizeBlockPath(match[1]),
      content: match[2].replace(/\n$/, ''),
    });
  }

  return blocks;
}

function countMalformedArchitectureDocFences(source) {
  const fencePattern = /^```vibecompass-architecture-doc\b.*$/gm;
  const acceptedOpeningPattern = /^```vibecompass-architecture-doc\s+path=[^\s`]+\s*$/;
  let count = 0;
  let match;

  while ((match = fencePattern.exec(source)) !== null) {
    if (!acceptedOpeningPattern.test(match[0])) {
      count += 1;
    }
  }

  return count;
}

function validateArchitectureDocBlocks(blocks) {
  const seenPaths = new Set();
  for (const block of blocks) {
    if (seenPaths.has(block.path)) {
      throw new Error(`Accepted docs-review output contains duplicate architecture doc path: ${block.path}`);
    }
    seenPaths.add(block.path);
    validateArchitectureDocBlock(block);
  }
}

function normalizeBlockPath(value) {
  return String(value ?? '').trim().replaceAll('\\', '/');
}

function validateArchitectureDocBlock(block) {
  if (!block.path.startsWith('architecture/') || !block.path.endsWith('.md')) {
    throw new Error(`Accepted docs-review output can only write architecture/*.md files. Invalid path: ${block.path}`);
  }

  if (path.posix.isAbsolute(block.path) || block.path.split('/').includes('..')) {
    throw new Error(`Accepted docs-review output path must stay inside architecture/. Invalid path: ${block.path}`);
  }

  if (block.path.split('/').length < 3) {
    throw new Error(
      `Accepted docs-review output path must include at least one subdirectory under architecture/. Invalid path: ${block.path}`,
    );
  }

  const frontmatter = parseFrontmatter(block.content, { sourceName: block.path });
  if (!frontmatter.hasFrontmatter || !frontmatter.data) {
    throw new Error(`Accepted architecture doc ${block.path} must include frontmatter.`);
  }

  const requiredFields = block.path === 'architecture/overview/project-shape.md'
    ? ['status']
    : ['domain', 'feature', 'component', 'status'];
  for (const field of requiredFields) {
    if (typeof frontmatter.data[field] !== 'string' || frontmatter.data[field].trim() === '') {
      throw new Error(`Accepted architecture doc ${block.path} requires non-empty frontmatter field "${field}".`);
    }
  }
}

async function submitHostedDocsReview(options) {
  if (options.runtime.provider !== 'hosted') {
    throw new Error('docs-review --submit-hosted requires a hosted sync binding in project.yaml.');
  }

  if (typeof options.fetch !== 'function') {
    throw new Error('docs-review --submit-hosted requires a fetch implementation.');
  }

  const credentialEnvVar = options.runtime.credential_env_var;
  if (!credentialEnvVar) {
    throw new Error('docs-review --submit-hosted requires sync.credential_env_var in project.yaml.');
  }

  const credential = normalizeOptionalString(options.env?.[credentialEnvVar]);
  if (!credential) {
    throw new Error(`docs-review --submit-hosted requires ${credentialEnvVar}.`);
  }

  const endpoint = new URL(
    `api/sync/projects/${encodeURIComponent(options.runtime.project_id)}/docs-review`,
    ensureTrailingSlash(options.runtime.api_url),
  );
  const baselineRemoteRevisionId = normalizeUuid(
    options.manifest?.manifest?.sync?.last_successful_remote_revision,
  );
  const response = await options.fetch(endpoint.href, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      llm: options.reviewConfig.llm,
      model: options.reviewConfig.model,
      prompt: options.reviewPrompt,
      project: {
        name: options.project.name,
        mode: options.project.mode,
        repos: Array.isArray(options.project.repos) ? options.project.repos : [],
      },
      ...(baselineRemoteRevisionId
        ? { baseline_remote_revision_id: baselineRemoteRevisionId }
        : {}),
      local_root_revision: options.manifest?.manifest?.canonical?.local_root_revision,
      evidence_scope: {
        manifest_hash: options.manifest?.manifest?.canonical?.manifest_hash,
        document_count: options.manifest?.manifest?.canonical?.document_count,
        warning_count: options.manifest?.manifest?.canonical?.warning_count,
      },
    }),
  });

  if (!response.ok) {
    const body = typeof response.text === 'function' ? await response.text() : '';
    const details = parseJsonObject(body);
    if (details?.error) {
      const nextStep = details.next_step ? ` Next step: ${details.next_step}` : '';
      throw new Error(
        `Hosted docs-review request failed with ${response.status}: ${details.error}${nextStep}`,
      );
    }

    throw new Error(`Hosted docs-review request failed with ${response.status}${body ? `: ${body}` : ''}`);
  }

  const body = typeof response.json === 'function' ? await response.json() : {};
  const runId = normalizeOptionalString(body.run_id ?? body.runId);

  if (!runId) {
    throw new Error('Hosted docs-review response did not include run_id.');
  }

  return {
    endpoint: endpoint.href,
    run_id: runId,
    status: normalizeOptionalString(body.status) ?? 'accepted',
    phase: normalizeOptionalString(body.phase),
  };
}

function parseJsonObject(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function pollHostedDocsReview(options) {
  const marker = await readDocsReviewMarker(options.statePath);
  const runtime = marker.runtime;
  const hosted = marker.hosted;

  if (runtime?.provider !== 'hosted' || !runtime.api_url || !runtime.project_id) {
    throw new Error('docs-review --poll-hosted requires a hosted docs-review marker.');
  }

  const runId = normalizeOptionalString(hosted?.run_id);
  if (!runId) {
    throw new Error('docs-review --poll-hosted requires hosted.run_id in state/docs-review.json.');
  }

  const credentialEnvVar = runtime.credential_env_var;
  if (!credentialEnvVar) {
    throw new Error('docs-review --poll-hosted requires runtime.credential_env_var in state/docs-review.json.');
  }

  const credential = normalizeOptionalString(options.env?.[credentialEnvVar]);
  if (!credential) {
    throw new Error(`docs-review --poll-hosted requires ${credentialEnvVar}.`);
  }

  const endpoint = new URL(
    `api/sync/projects/${encodeURIComponent(runtime.project_id)}/runs/${encodeURIComponent(runId)}`,
    ensureTrailingSlash(runtime.api_url),
  );
  const response = await options.fetch(endpoint.href, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${credential}`,
    },
  });

  if (!response.ok) {
    const body = typeof response.text === 'function' ? await response.text() : '';
    throw new Error(`Hosted docs-review poll failed with ${response.status}${body ? `: ${body}` : ''}`);
  }

  const body = typeof response.json === 'function' ? await response.json() : {};
  const {
    phase: _oldPhase,
    prompt_version: _oldPromptVersion,
    parser_version: _oldParserVersion,
    proposal_ids: _oldProposalIds,
    artifact_ids: _oldArtifactIds,
    artifacts: _oldArtifacts,
    warnings: _oldWarnings,
    error_code: _oldErrorCode,
    error_message: _oldErrorMessage,
    ...hostedBase
  } = hosted;
  const hostedStatus = normalizeOptionalString(body.status) ?? hosted.status ?? 'accepted';
  const hostedErrorMessage = normalizeOptionalString(body.error_message);
  const updatedHosted = {
    ...hostedBase,
    endpoint: hosted.endpoint,
    run_id: runId,
    status: hostedStatus,
    ...(normalizeOptionalString(body.phase) ? { phase: normalizeOptionalString(body.phase) } : {}),
    ...(normalizeOptionalString(body.prompt_version) ? { prompt_version: normalizeOptionalString(body.prompt_version) } : {}),
    ...(normalizeOptionalString(body.parser_version) ? { parser_version: normalizeOptionalString(body.parser_version) } : {}),
    ...(Array.isArray(body.proposal_ids) ? { proposal_ids: body.proposal_ids } : {}),
    ...(Array.isArray(body.artifact_ids) ? { artifact_ids: body.artifact_ids } : {}),
    ...(Array.isArray(body.artifacts) ? { artifacts: body.artifacts } : {}),
    ...(Array.isArray(body.warnings) ? { warnings: body.warnings } : {}),
    ...(normalizeOptionalString(body.error_code) ? { error_code: normalizeOptionalString(body.error_code) } : {}),
    ...(hostedErrorMessage ? { error_message: hostedErrorMessage } : {}),
  };
  const markerStatus = markerStatusForHostedRunStatus(hostedStatus);
  const message = hostedStatus === 'failed' && hostedErrorMessage
    ? `Hosted docs-review run ${runId} is failed: ${hostedErrorMessage}`
    : `Hosted docs-review run ${runId} is ${updatedHosted.status}.`;

  const updatedMarker = {
    ...marker,
    status: markerStatus,
    hosted: updatedHosted,
  };
  await writeDocsReviewMarker(options.statePath, updatedMarker);

  return {
    rootDir: options.rootDir,
    statePath: options.statePath,
    status: markerStatus,
    llm: marker.llm ?? null,
    model: marker.model ?? null,
    runtime,
    hosted: updatedHosted,
    reviewPrompt: null,
    warnings: (updatedHosted.warnings ?? []).map((warning) =>
      warning?.message ? `${warning.code ?? 'hosted_warning'}: ${warning.message}` : String(warning),
    ),
    message,
  };
}

async function writeDocsReviewMarker(statePath, marker) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function normalizeOptionalString(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeUuid(value) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return null;
  }

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
    ? normalized
    : null;
}

function normalizeDecisionTargetPath(value) {
  const normalized = normalizeBlockPath(value);
  if (
    !normalized.startsWith('decisions/') ||
    !normalized.endsWith('.md') ||
    normalized.split('/').length !== 2 ||
    normalized.split('/').some((part) => part === '..' || part === '') ||
    ['decisions/INDEX.md', 'decisions/README.md', 'decisions/EXAMPLE.md'].includes(normalized)
  ) {
    throw new Error(`Decision artifact target must be a decisions/*.md domain file. Invalid path: ${value}`);
  }

  return normalized;
}

async function readNextDecisionId(rootDir) {
  const decisionsDir = path.join(rootDir, 'decisions');
  let max = 0;

  for (const fileName of await listDecisionFileNames(decisionsDir)) {
    const content = await readFile(path.join(decisionsDir, fileName), 'utf8');
    for (const match of content.matchAll(/^###\s+D-(\d+)\b/gm)) {
      max = Math.max(max, Number(match[1]));
    }
  }

  return max + 1;
}

async function listDecisionFileNames(decisionsDir) {
  try {
    return (await readdir(decisionsDir))
      .filter((fileName) =>
        fileName.endsWith('.md') &&
        !['INDEX.md', 'README.md', 'EXAMPLE.md'].includes(fileName),
      )
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function renderDecisionEntry(options) {
  const decisionNumber = `D-${String(options.decisionId).padStart(3, '0')}`;
  return [
    `### ${decisionNumber} — ${options.title}`,
    '',
    `**Timestamp:** ${formatDecisionTimestamp(new Date())}`,
    `**Decision:** ${options.decision}`,
    `**Rationale:** ${options.rationale}`,
    ...(options.context ? [`**Context:** ${options.context}`] : []),
    '',
  ].join('\n');
}

function formatDecisionTimestamp(date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absoluteOffset / 60)).padStart(2, '0');
  const offsetRemainder = String(absoluteOffset % 60).padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');

  return `${yyyy}-${mm}-${dd} ${hh}:${min} ${formatTimeZoneAbbreviation(date) ?? `UTC${sign}${offsetHours}:${offsetRemainder}`}`;
}

function formatTimeZoneAbbreviation(date) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZoneName: 'short',
    }).formatToParts(date);
    const zone = parts.find((part) => part.type === 'timeZoneName')?.value;
    return zone && !/^GMT[+-]/.test(zone) ? zone : null;
  } catch {
    return null;
  }
}

async function refreshDecisionIndex(rootDir) {
  const decisionsDir = path.join(rootDir, 'decisions');
  const indexPath = path.join(decisionsDir, 'INDEX.md');
  const warnings = [];
  const rows = [];

  for (const fileName of await listDecisionFileNames(decisionsDir)) {
    const relativePath = `decisions/${fileName}`;
    const content = await readFile(path.join(decisionsDir, fileName), 'utf8');
    for (const match of content.matchAll(/^###\s+D-(\d+)\s+—\s+(.+)$/gm)) {
      rows.push({
        id: Number(match[1]),
        title: match[2].trim(),
        domainFile: fileName,
      });
    }
    if (!content.match(/^###\s+D-(\d+)\s+—\s+(.+)$/m)) {
      warnings.push(`No indexable decisions found in ${relativePath}.`);
    }
  }

  rows.sort((left, right) => left.id - right.id);
  await mkdir(decisionsDir, { recursive: true });
  await writeFile(indexPath, renderDecisionIndex(rows), 'utf8');
  return { refreshed: true, warnings };
}

function renderDecisionIndex(rows) {
  return [
    '# Decision Index',
    '',
    'All decisions in chronological order. Each entry links to its domain file.',
    '',
    '> **Rule:** Decisions are append-only — never modify existing entries.',
    '',
    '| # | Decision | Domain |',
    '|---|----------|--------|',
    ...rows.map((row) => {
      const decisionNumber = `D-${String(row.id).padStart(3, '0')}`;
      const domain = path.basename(row.domainFile, '.md');
      return `| ${decisionNumber} | ${row.title} | [${domain}](${row.domainFile}) |`;
    }),
    '',
  ].join('\n');
}

function markerStatusForHostedRunStatus(status) {
  if (status === 'completed') {
    return 'hosted-review-completed';
  }

  if (status === 'failed') {
    return 'hosted-review-failed';
  }

  if (status === 'needs_rebase') {
    return 'hosted-review-needs-rebase';
  }

  return 'hosted-review-requested';
}

function normalizeMaxTokens(value) {
  if (value === undefined || value === null) {
    return 16000;
  }

  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < 1024 || number > 32000) {
    throw new Error('docs-review --max-tokens must be an integer from 1024 to 32000.');
  }

  return number;
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function renderDocsReviewMessage(options) {
  if (options.submitHosted) {
    return 'Hosted docs-review request submitted. Poll the hosted run, apply accepted docs changes locally, then run docs-review --complete.';
  }

  if (shouldRunLocal(options)) {
    const provider = options.provider ?? 'anthropic';
    return `Local ${provider} docs-review completed. Review the generated output, then run docs-review --apply-output after accepting the architecture docs.`;
  }

  return 'Docs-review preflight passed. Run the generated architecture-review prompt in the selected LLM, then record completion after applying accepted docs changes.';
}

function renderReviewPrompt(options) {
  return [
    '# VibeCompass Docs Review Prompt v1',
    '',
    'Run a comprehensive VibeCompass architecture documentation review for the project-memory root below. Follow this prompt exactly; do not invent a different document structure.',
    '',
    '## Review Context',
    `- Project memory root: ${options.rootDir}`,
    `- Project: ${options.project.name}`,
    `- Project mode: ${options.project.mode}`,
    `- Review provider to record: ${options.llm}`,
    `- Review model/version to record: ${options.model}`,
    '',
    '## Required Inputs',
    '1. Read `project.yaml`.',
    '2. Read `context.md` if present.',
    '3. Read all canonical files under `architecture/`, `decisions/`, and finalized `sessions/`.',
    '4. Inspect the declared repositories and cite concrete source, config, and test files before making implementation claims.',
    '',
    '## Architecture Doc Contract',
    'When creating or updating architecture docs, use the existing VibeCompass structure:',
    '- path: `architecture/<domain-slug>/<feature-slug>/<component-slug>.md` for component docs',
    '- frontmatter fields: `domain`, `feature`, `component`, `status`, plus `repo` or `repos` when implementation-scoped',
    '- body sections: `## Description`, `## Review metadata`, `## Details`, `## Next steps`, `## Involved files`',
    '',
    'Use this exact Review metadata sub-header in every generated architecture doc:',
    '',
    '## Review metadata',
    `- Review provider: ${options.llm}`,
    `- Review model/version: ${options.model}`,
    `- Project mode: ${options.project.mode}`,
    '- Confidence: high | medium | low',
    '- Coverage: comprehensive | partial | initial',
    '- Evidence: repo:path references inspected before making implementation claims',
    '- Blindspots: explicit list, or "None identified" only when evidence is comprehensive',
    '',
    '## Review Rules',
    '1. Do not delete `architecture/overview/project-shape.md`.',
    '2. Add evidence-backed component docs alongside the overview.',
    '3. Update `architecture/overview/project-shape.md` coverage and blindspot sections to summarize what has now been mapped.',
    '4. Keep all implementation claims source-backed with `repo:path` evidence.',
    '5. Use only the exact confidence and coverage enum values listed above.',
    '6. Put uncertainty in `Blindspots`; do not fill gaps with guesses.',
    '7. Do not append real `D-NNN` decisions without explicit user acceptance. Propose candidate decisions separately.',
    '8. Do not edit `decisions/INDEX.md` directly unless a canonical decision file was explicitly accepted and appended.',
    '',
    '## Output Contract',
    'First provide a concise findings summary with:',
    '- mapped areas',
    '- gaps/blindspots',
    '- proposed architecture docs',
    '- proposed decisions, if any',
    '',
    'Then, for each architecture doc the user accepts, output one fenced block exactly like this:',
    '',
    '```vibecompass-architecture-doc path=architecture/domain/feature/component.md',
    '<complete markdown file content>',
    '```',
    '',
    'Only include docs the user has accepted in fenced `vibecompass-architecture-doc` blocks. After accepted docs are applied, `vibecompass docs-review --apply-output` records completion in `state/docs-review.json`.',
  ].join('\n');
}

function ensureTrailingNewline(value) {
  return value.endsWith('\n') ? value : `${value}\n`;
}

function defaultModelForLlm(llm) {
  const normalized = String(llm ?? '').trim().toLowerCase();

  if (normalized === 'codex') {
    return 'gpt-5-codex';
  }

  if (normalized === 'gemini') {
    return 'gemini-2.5-pro';
  }

  if (normalized === 'claude') {
    return 'claude-sonnet-4-6';
  }

  return 'record-the-model-version';
}

function createPrompter(io = {}, runtime = {}) {
  if (typeof runtime?.prompt === 'function') {
    return {
      async ask(spec) {
        return runtime.prompt(spec);
      },
      write(text) {
        (io.stdout ?? process.stdout).write(text);
      },
      async close() {},
    };
  }

  const input = runtime?.stdin ?? io.stdin ?? process.stdin;
  const output = io.stdout ?? process.stdout;

  if (!input?.isTTY) {
    throw new Error('Guided docs-review requires an interactive TTY or a custom prompt adapter.');
  }

  const rl = createInterface({ input, output });
  return {
    async ask(spec) {
      return rl.question(`${spec.message}${renderPromptSuffix(spec)}: `);
    },
    write(text) {
      output.write(text);
    },
    async close() {
      rl.close();
    },
  };
}

async function askInput(prompter, message, options = {}) {
  while (true) {
    const raw = await prompter.ask({
      type: 'input',
      message,
      defaultValue: options.defaultValue ?? null,
    });
    const value = normalizePromptAnswer(raw, options.defaultValue ?? null);
    if (value) {
      return value;
    }

    prompter.write('A value is required.\n');
  }
}

async function askChoice(prompter, message, choices, options = {}) {
  const defaultValue = options.defaultValue ?? choices[0]?.value ?? null;
  prompter.write(
    `${choices
      .map((choice, index) => `${index + 1}. ${choice.value} — ${choice.description}`)
      .join('\n')}\n`,
  );

  while (true) {
    const raw = await prompter.ask({
      type: 'choice',
      message,
      defaultValue,
      choices,
    });
    const normalized = normalizePromptAnswer(raw, defaultValue)?.toLowerCase();

    const byIndex = Number.parseInt(normalized, 10);
    if (!Number.isNaN(byIndex) && choices[byIndex - 1]) {
      return choices[byIndex - 1].value;
    }

    const byValue = choices.find((choice) => choice.value === normalized);
    if (byValue) {
      return byValue.value;
    }

    prompter.write('Please choose one of the listed options.\n');
  }
}

function renderPromptSuffix(spec) {
  if (spec.defaultValue) {
    return ` [${spec.defaultValue}]`;
  }

  return '';
}

function normalizePromptAnswer(raw, defaultValue) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) {
    if (defaultValue === null || defaultValue === undefined) {
      return null;
    }

    return String(defaultValue);
  }

  return trimmed;
}
