import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseFrontmatter } from './frontmatter.js';
import { sha256Text } from './hash.js';
import { writeStateManifest } from './manifest.js';
import { scanProjectMemory } from './project-memory.js';
import { parseSimpleYaml } from './simple-yaml.js';
import {
  buildDocsReviewSourceInventory,
  docsReviewSourceInventoryPath,
  readDocsReviewSourceInventory,
  reconcileCoverageWithSourceInventory,
  summarizeSourceInventory,
  writeDocsReviewSourceInventory,
} from './source-inventory.js';
import { readSyncCursor, resolveSyncBinding } from './sync-binding.js';
import { PACKAGE_VERSION } from './version.js';
import { withMemoryRootLock } from './serialization.js';
import { listDecisionFileNames, readNextDecisionId } from './decisions.js';
import { looksLikeGroupedDecisionIndex } from './decision-index.js';

const DOCS_REVIEW_PROMPT_VERSION = 'VibeCompass Docs Review Prompt v7';
const DOCS_REVIEW_PARSER_VERSION = 'docs-review-parser-v1';
const DOCS_REVIEW_ACCEPTED_OUTPUT_CONTRACT_VERSION = 'docs-review-accepted-output-v7';
const DOCS_REVIEW_DOCUMENTATION_PLAN_PROJECTION_VERSION = 'docs-review-documentation-plan-v1';
const DOCUMENTATION_PLAN_STATE_VERSION = 1;
const ARCHITECTURE_DOC_SOFT_SIZE_LIMIT_BYTES = 12000;
const COVERAGE_PLAN_OUTPUT_VERSION = 1;
const COVERAGE_PLAN_STATUSES = new Set(['accepted', 'deferred', 'missing']);
const COVERAGE_LEVELS = new Set(['comprehensive', 'partial', 'initial', 'missing']);
const ANCHOR_ACTIONS = new Set(['reuse', 'update', 'split', 'merge', 'defer', 'replace', 'new']);
const SOURCE_CONFIDENCE_LEVELS = new Set(['high', 'medium', 'low']);
const DOCUMENTATION_PLAN_RUN_SCOPES = new Set(['baseline', 'deepening']);
const REBUILD_STALE_POLICIES = new Set(['keep', 'archive']);
const PROJECT_MAP_PATH = 'architecture/overview/project-shape.md';

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
      refreshIndex: options.refreshIndex,
    });
  }

  if (options.rebuild) {
    return rebuildDocsReview({
      rootDir,
      statePath,
      apply: options.apply,
      dryRun: options.dryRun,
      scopePath: options.scopePath,
      stalePolicy: options.stalePolicy,
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
  const promptExecutionMode = options.submitHosted || shouldRunLocal(options)
    ? 'single-turn'
    : 'interactive';
  const runtime = resolveDocsReviewRuntime(project, {
    env,
    guided: Boolean(options.guided),
    localProvider,
    runLocal: shouldRunLocal(options),
    anthropicEnvVar: options.anthropicEnvVar ?? 'ANTHROPIC_API_KEY',
    syncTarget: options.syncTarget ?? null,
  });
  const sourceInventory = await buildDocsReviewSourceInventory(project, {
    rootDir,
    cwd,
    sourceRootOverrides: options.sourceRootOverrides,
  });
  await writeDocsReviewSourceInventory(rootDir, sourceInventory);
  const reviewPrompt = renderReviewPrompt({
    project,
    rootDir,
    llm: reviewConfig.llm,
    model: reviewConfig.model,
    executionMode: promptExecutionMode,
    anchors: await buildDocsReviewAnchorContext(rootDir),
    sourceInventory,
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
    source_inventory: summarizeSourceInventory(sourceInventory),
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
    sourceInventory,
    reviewPrompt,
    warnings: [
      ...(sourceInventory.warnings ?? []).map((warning) => warning.message ?? `${warning.code}: ${warning.repo_id ?? warning.path ?? ''}`.trim()),
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
  return withMemoryRootLock(options.rootDir, 'docs-review-apply-output', () => applyDocsReviewOutputLocked(options));
}

async function applyDocsReviewOutputLocked(options) {
  const current = await readDocsReviewMarker(options.statePath);
  const outputPath = options.outputPath
    ? path.resolve(options.rootDir, options.outputPath)
    : path.join(path.dirname(options.statePath), 'docs-review-output.md');
  const source = await readFile(outputPath, 'utf8');
  const blocks = parseArchitectureDocBlocks(source);
  const coverageBlocks = parseCoveragePlanBlocks(source);
  const decisionRecommendationBlocks = parseDecisionRecommendationBlocks(source);

  if (blocks.length === 0 && coverageBlocks.length === 0 && decisionRecommendationBlocks.length === 0) {
    const malformedFenceCount = countMalformedArchitectureDocFences(source);
    if (malformedFenceCount > 0) {
      throw new Error(
        `Malformed architecture doc fence found in ${outputPath}. Expected fence openings like \`\`\`vibecompass-architecture-doc path=architecture/domain/feature/component.md\` with exactly one path attribute and no extra attributes.`,
      );
    }

    const malformedCoveragePlanFenceCount = countMalformedCoveragePlanFences(source);
    if (malformedCoveragePlanFenceCount > 0) {
      throw new Error(
        `Malformed coverage-plan fence found in ${outputPath}. Expected fence openings like \`\`\`vibecompass-coverage-plan version=1\`.`,
      );
    }

    const malformedDecisionRecommendationFenceCount = countMalformedDecisionRecommendationFences(source);
    if (malformedDecisionRecommendationFenceCount > 0) {
      throw new Error(
        `Malformed decision recommendation fence found in ${outputPath}. Expected fence openings like \`\`\`vibecompass-decision-recommendation target=decisions/domain.md\`.`,
      );
    }

    throw new Error(
      `No accepted docs-review output blocks found in ${outputPath}. Expected fenced blocks like \`\`\`vibecompass-architecture-doc path=architecture/domain/feature/component.md\`, \`\`\`vibecompass-coverage-plan version=1\`, or \`\`\`vibecompass-decision-recommendation target=decisions/domain.md\`.`,
    );
  }

  validateArchitectureDocBlocks(blocks);
  const sourceInventory = await readDocsReviewSourceInventory(options.rootDir);
  const coverageProjection = buildCoverageProjection(coverageBlocks, {
    outputPath,
    outputHash: sha256Text(source),
    sourceInventory,
  });
  const anchorContext = coverageProjection ? await buildDocsReviewAnchorContext(options.rootDir) : null;
  const sourceInventoryReconciliation = reconcileCoverageWithSourceInventory(coverageProjection, sourceInventory);
  if (coverageProjection && sourceInventory) {
    coverageProjection.source_inventory_summary = summarizeSourceInventory(sourceInventory);
    coverageProjection.reconciliation_summary = sourceInventoryReconciliation
      ? {
        scanned_count: sourceInventoryReconciliation.scanned_count,
        declared_count: sourceInventoryReconciliation.declared_count,
        accounted_count: sourceInventoryReconciliation.accounted_count,
        unaccounted_ids: sourceInventoryReconciliation.unaccounted_ids,
        unknown_declared_ids: sourceInventoryReconciliation.unknown_declared_ids,
        source_unavailable_repo_ids: sourceInventoryReconciliation.source_unavailable_repo_ids,
      }
      : null;
    coverageProjection.warnings = sourceInventoryReconciliation?.warnings ?? [];
  }
  const documentationPlanProjection = coverageProjection
    ? buildDocumentationPlanProjection(coverageProjection, sourceInventory, {
      generatedAt: options.generatedAt,
    })
    : null;
  if (coverageProjection && documentationPlanProjection) {
    coverageProjection.documentation_plan_summary = summarizeDocumentationPlan(documentationPlanProjection);
  }
  const decisionRecommendations = validateDecisionRecommendationBlocks(decisionRecommendationBlocks);
  const warnings = [
    ...createCoveragePlanQualityWarnings(coverageProjection, anchorContext),
    ...(sourceInventoryReconciliation?.warnings ?? []).map((warning) => `${warning.code}: ${warning.message}`),
    ...createArchitectureDocSizeWarnings(blocks),
    ...createArchitectureDocQualityWarnings(blocks),
  ];

  const applied = [];
  for (const block of blocks) {
    const absoluteTargetPath = path.join(options.rootDir, block.path);
    await mkdir(path.dirname(absoluteTargetPath), { recursive: true });
    const existed = await pathExists(absoluteTargetPath);
    await writeFile(absoluteTargetPath, ensureTrailingNewline(block.content), 'utf8');
    applied.push({ path: block.path, status: existed ? 'overwritten' : 'created' });
  }

  let appliedCoverage = null;
  let appliedDocumentationPlan = null;
  if (coverageProjection) {
    const coveragePath = path.join(path.dirname(options.statePath), 'docs-review-coverage.json');
    await writeFile(coveragePath, `${JSON.stringify(coverageProjection, null, 2)}\n`, 'utf8');
    appliedCoverage = {
      path: coveragePath,
      area_count: coverageProjection.area_count,
      coverage_score: coverageProjection.coverage_score,
      statuses: coverageProjection.statuses,
    };
  }
  if (documentationPlanProjection) {
    const documentationPlanPath = path.join(path.dirname(options.statePath), 'docs-review-documentation-plan.json');
    await writeFile(documentationPlanPath, `${JSON.stringify(documentationPlanProjection, null, 2)}\n`, 'utf8');
    appliedDocumentationPlan = {
      path: documentationPlanPath,
      item_count: documentationPlanProjection.summary.item_count,
      by_status: documentationPlanProjection.summary.by_status,
      by_run_scope: documentationPlanProjection.summary.by_run_scope,
    };
  }

  const appliedDecisionCandidates = decisionRecommendations.length > 0
    ? await applyDecisionRecommendations({
      rootDir: options.rootDir,
      recommendations: decisionRecommendations,
      refreshIndex: options.refreshIndex,
    })
    : { applied: [], warnings: [] };
  warnings.push(...appliedDecisionCandidates.warnings);

  const manifestResult = await writeStateManifest(options.rootDir);
  const llm = normalizeOptionalString(options.llm) ?? current.llm ?? null;
  const model = normalizeOptionalString(options.model) ?? current.model ?? null;
  const appliedAt = new Date().toISOString();
  const marker = {
    ...current,
    status: 'completed',
    ...(llm ? { llm } : {}),
    ...(model ? { model } : {}),
    applied: {
      output_path: outputPath,
      output_hash: sha256Text(source),
      local_root_revision: manifestResult.manifest.canonical.local_root_revision,
      manifest_hash: manifestResult.manifest.canonical.manifest_hash,
      architecture_docs: applied,
      ...(appliedCoverage ? { coverage: appliedCoverage } : {}),
      ...(appliedDocumentationPlan ? { documentation_plan: appliedDocumentationPlan } : {}),
      ...(appliedDecisionCandidates.applied.length > 0 ? { decision_candidates: appliedDecisionCandidates.applied } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      applied_at: appliedAt,
    },
    completed_at: appliedAt,
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
    warnings,
    message: renderApplyOutputMessage({
      architectureCount: applied.length,
      coverageApplied: Boolean(appliedCoverage),
      decisionCount: appliedDecisionCandidates.applied.length,
    }),
  };
}

async function applyDecisionArtifact(options) {
  return withMemoryRootLock(options.rootDir, 'docs-review-apply-decision-artifact', () => applyDecisionArtifactLocked(options));
}

async function applyDecisionArtifactLocked(options) {
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

async function rebuildDocsReview(options) {
  const scopePath = normalizeRebuildScopePath(options.scopePath);
  const stalePolicy = normalizeRebuildStalePolicy(options.stalePolicy);
  const apply = Boolean(options.apply);
  const architectureDocs = await listArchitectureDocs(options.rootDir, scopePath);
  const requestedAt = new Date();
  const archiveRoot = stalePolicy === 'archive'
    ? `state/docs-review-archive/${formatArchiveTimestamp(requestedAt)}`
    : null;
  const rebuildEntries = architectureDocs.map((docPath) => ({
    path: docPath,
    action: stalePolicy === 'archive' ? 'archive' : 'keep',
    ...(archiveRoot ? { archive_path: `${archiveRoot}/${docPath}` } : {}),
  }));

  if (!apply) {
    return {
      rootDir: options.rootDir,
      statePath: options.statePath,
      status: 'rebuild-preview',
      recorded: false,
      runtime: null,
      hosted: null,
      applied: null,
      reviewPrompt: null,
      rebuild: {
        scope_path: scopePath,
        stale_policy: stalePolicy,
        anchor_reconcile_required: true,
        architecture_docs: rebuildEntries,
        architecture_doc_count: rebuildEntries.length,
        archive_root: archiveRoot,
      },
      warnings: [],
      message: 'Docs-review rebuild preview complete. Re-run with --apply to record the rebuild marker and perform the selected stale-doc action. The next docs-review run must anchor to the prior tree and reconcile taxonomy changes instead of cold-regenerating from a blank slate.',
    };
  }

  for (const entry of rebuildEntries) {
    if (entry.action !== 'archive') {
      continue;
    }
    const sourcePath = path.join(options.rootDir, entry.path);
    const targetPath = path.join(options.rootDir, entry.archive_path);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await rename(sourcePath, targetPath);
  }

  const manifestResult = await writeStateManifest(options.rootDir);
  const appliedAt = new Date().toISOString();
  const marker = {
    status: 'rebuild-ready',
    requested_at: requestedAt.toISOString(),
    runtime: {
      provider: 'local',
      operation: 'rebuild',
    },
    rebuild: {
      scope_path: scopePath,
      stale_policy: stalePolicy,
      anchor_reconcile_required: true,
      architecture_docs: rebuildEntries,
      architecture_doc_count: rebuildEntries.length,
      ...(archiveRoot ? { archive_root: path.join(options.rootDir, archiveRoot) } : {}),
      local_root_revision: manifestResult.manifest.canonical.local_root_revision,
      manifest_hash: manifestResult.manifest.canonical.manifest_hash,
      applied_at: appliedAt,
    },
    completed_at: null,
  };
  await writeDocsReviewMarker(options.statePath, marker);

  return {
    rootDir: options.rootDir,
    statePath: options.statePath,
    status: 'rebuild-ready',
    runtime: marker.runtime,
    hosted: null,
    applied: null,
    reviewPrompt: null,
    rebuild: marker.rebuild,
    warnings: [],
    message: stalePolicy === 'archive'
      ? 'Archived selected architecture docs and recorded a rebuild marker. Run docs-review again; the next coverage plan must reconcile against the prior tree and explain reuse/update/split/merge/defer/replace actions.'
      : 'Recorded a rebuild marker without moving architecture docs. Run docs-review again; the next coverage plan must reconcile against the prior tree and explain reuse/update/split/merge/defer/replace actions.',
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
    options.rebuild ? '--rebuild' : null,
    options.complete ? '--complete' : null,
  ].filter(Boolean);

  if (enabled.length > 1) {
    throw new Error(`docs-review accepts only one execution mode at a time. Conflicting flags: ${enabled.join(', ')}.`);
  }
  if (options.apply && !options.rebuild) {
    throw new Error('docs-review --apply is only valid with --rebuild.');
  }
  if (options.dryRun && !options.rebuild) {
    throw new Error('docs-review --dry-run is only valid with --rebuild.');
  }
  if (options.stalePolicy && !options.rebuild) {
    throw new Error('docs-review --stale-policy is only valid with --rebuild.');
  }
  if (options.scopePath && !options.rebuild) {
    throw new Error('docs-review --path is only valid with --rebuild.');
  }
  if (options.apply && options.dryRun) {
    throw new Error('docs-review --rebuild accepts only one of --dry-run or --apply.');
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
  // Throws on an explicitly requested unknown/incomplete --sync-target so a
  // typo can never fall back to a different environment (D-236).
  const hostedBinding = resolveSyncBinding(project, options.syncTarget ?? null);
  const hasHostedBinding = Boolean(hostedBinding);

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
        api_url: hostedBinding.apiUrl,
        project_id: hostedBinding.projectId,
        credential_env_var: hostedBinding.credentialEnvVar,
        ...(hostedBinding.target ? { sync_target: hostedBinding.target } : {}),
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
      api_url: hostedBinding.apiUrl,
      project_id: hostedBinding.projectId,
      credential_env_var: hostedBinding.credentialEnvVar,
      ...(hostedBinding.target ? { sync_target: hostedBinding.target } : {}),
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
  const pattern = /^(`{3,})vibecompass-architecture-doc\s+path=([^\s`]+)\s*\n([\s\S]*?)^\1[ \t]*$/gm;
  let match;

  while ((match = pattern.exec(source)) !== null) {
    blocks.push({
      path: normalizeBlockPath(match[2]),
      content: match[3].replace(/\n$/, ''),
    });
  }

  return blocks;
}

function parseCoveragePlanBlocks(source) {
  const blocks = [];
  const pattern = /^```vibecompass-coverage-plan\s+version=1\s*\n([\s\S]*?)^```[ \t]*$/gm;
  let match;

  while ((match = pattern.exec(source)) !== null) {
    blocks.push({
      version: COVERAGE_PLAN_OUTPUT_VERSION,
      content: match[1].replace(/\n$/, ''),
    });
  }

  return blocks;
}

function parseDecisionRecommendationBlocks(source) {
  const blocks = [];
  const pattern = /^```vibecompass-decision-recommendation\s+target=([^\s`]+)\s*\n([\s\S]*?)^```[ \t]*$/gm;
  let match;

  while ((match = pattern.exec(source)) !== null) {
    blocks.push({
      targetPath: normalizeDecisionTargetPath(match[1]),
      content: match[2].replace(/\n$/, ''),
    });
  }

  return blocks;
}

function countMalformedArchitectureDocFences(source) {
  const fencePattern = /^`{3,}vibecompass-architecture-doc\b.*$/gm;
  const acceptedOpeningPattern = /^`{3,}vibecompass-architecture-doc\s+path=[^\s`]+\s*$/;
  let count = 0;
  let match;

  while ((match = fencePattern.exec(source)) !== null) {
    if (!acceptedOpeningPattern.test(match[0])) {
      count += 1;
    }
  }

  return count;
}

function countMalformedCoveragePlanFences(source) {
  const fencePattern = /^```vibecompass-coverage-plan\b.*$/gm;
  const acceptedOpeningPattern = /^```vibecompass-coverage-plan\s+version=1\s*$/;
  let count = 0;
  let match;

  while ((match = fencePattern.exec(source)) !== null) {
    if (!acceptedOpeningPattern.test(match[0])) {
      count += 1;
    }
  }

  return count;
}

function countMalformedDecisionRecommendationFences(source) {
  const fencePattern = /^```vibecompass-decision-recommendation\b.*$/gm;
  const acceptedOpeningPattern = /^```vibecompass-decision-recommendation\s+target=[^\s`]+\s*$/;
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

function buildCoverageProjection(blocks, options) {
  if (blocks.length === 0) {
    return null;
  }
  if (blocks.length > 1) {
    throw new Error('Accepted docs-review output contains multiple coverage-plan blocks. Include at most one `vibecompass-coverage-plan version=1` block.');
  }

  let plan;
  try {
    plan = JSON.parse(blocks[0].content);
  } catch (error) {
    throw new Error(`Accepted coverage plan must contain valid JSON. ${error instanceof Error ? error.message : ''}`.trim());
  }

  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('Accepted coverage plan must contain a JSON object.');
  }
  if (!Array.isArray(plan.areas)) {
    throw new Error('Accepted coverage plan requires an "areas" array.');
  }

  const ids = new Set();
  const areas = plan.areas.map((area, index) => normalizeCoverageArea(area, index, ids));
  const areaById = new Map(areas.map((area) => [area.id, area]));
  const hasCompletenessInventory = Object.prototype.hasOwnProperty.call(plan, 'completeness_inventory');
  const completenessInventory = normalizeCompletenessInventory(plan.completeness_inventory, areaById);
  validateCoverageAreaInventoryLinks(areas, completenessInventory);
  const statuses = countBy(areas, 'status');
  const coverage_levels = countBy(areas, 'coverage');
  const inventory_statuses = countBy(completenessInventory, 'status');

  return {
    version: COVERAGE_PLAN_OUTPUT_VERSION,
    producer: {
      package_version: PACKAGE_VERSION,
      prompt_version: DOCS_REVIEW_PROMPT_VERSION,
      parser_version: DOCS_REVIEW_PARSER_VERSION,
      accepted_output_contract: DOCS_REVIEW_ACCEPTED_OUTPUT_CONTRACT_VERSION,
      coverage_projection_version: COVERAGE_PLAN_OUTPUT_VERSION,
      ...(options.sourceInventory?.producer?.scanner_version
        ? { scanner_version: options.sourceInventory.producer.scanner_version }
        : {}),
    },
    source: {
      output_path: options.outputPath,
      output_hash: options.outputHash,
    },
    projected_at: new Date().toISOString(),
    summary: normalizeOptionalString(plan.summary),
    ...(normalizeOptionalString(plan.topology) ? { topology: normalizeOptionalString(plan.topology) } : {}),
    ...(normalizeCoverageTaxonomy(plan.taxonomy) ? { taxonomy: normalizeCoverageTaxonomy(plan.taxonomy) } : {}),
    area_count: areas.length,
    ...(hasCompletenessInventory ? {
      completeness_inventory: completenessInventory,
      inventory_count: completenessInventory.length,
      inventory_statuses,
    } : {}),
    score_basis: hasCompletenessInventory ? 'model_declared_inventory' : 'area_statuses',
    coverage_score: calculateCoverageScore({ areas, statuses, completenessInventory, hasCompletenessInventory }),
    statuses,
    coverage_levels,
    areas,
  };
}

function buildDocumentationPlanProjection(coverageProjection, sourceInventory, options = {}) {
  const generatedAt = options.generatedAt instanceof Date ? options.generatedAt : new Date();
  const inventoryIdsByArea = new Map();
  for (const item of coverageProjection.completeness_inventory ?? []) {
    for (const areaId of item.coverage_area_ids ?? []) {
      const ids = inventoryIdsByArea.get(areaId) ?? [];
      ids.push(item.id);
      inventoryIdsByArea.set(areaId, ids);
    }
  }

  const items = coverageProjection.areas.map((area) => {
    const linkedInventoryIds = uniqueStrings([
      ...(area.linked_inventory_ids ?? []),
      ...(inventoryIdsByArea.get(area.id) ?? []),
    ]);
    return {
      id: area.id,
      title: area.title ?? buildCoverageAreaTitle(area),
      status: area.status,
      run_scope: area.run_scope ?? 'baseline',
      expected_coverage: area.coverage,
      ...(area.proposed_path ? { target_path: area.proposed_path } : {}),
      ...(area.purpose ? { purpose: area.purpose } : {}),
      ...(area.parent ? { parent: area.parent } : {}),
      ...(linkedInventoryIds.length > 0 ? { linked_inventory_ids: linkedInventoryIds } : {}),
      evidence: area.evidence ?? [],
      blindspots: area.blindspots ?? [],
      ...(area.anchor_action ? { anchor_action: area.anchor_action } : {}),
      ...(area.anchor_paths?.length > 0 ? { anchor_paths: area.anchor_paths } : {}),
      ...(area.anchor_reason ? { anchor_reason: area.anchor_reason } : {}),
    };
  });

  return {
    version: DOCUMENTATION_PLAN_STATE_VERSION,
    producer: {
      package_version: PACKAGE_VERSION,
      prompt_version: DOCS_REVIEW_PROMPT_VERSION,
      parser_version: DOCS_REVIEW_PARSER_VERSION,
      accepted_output_contract: DOCS_REVIEW_ACCEPTED_OUTPUT_CONTRACT_VERSION,
      documentation_plan_projection_version: DOCS_REVIEW_DOCUMENTATION_PLAN_PROJECTION_VERSION,
      coverage_projection_version: coverageProjection.version,
      ...(sourceInventory?.producer?.scanner_version
        ? { scanner_version: sourceInventory.producer.scanner_version }
        : {}),
      generated_at: generatedAt.toISOString(),
    },
    source: coverageProjection.source,
    summary: {
      item_count: items.length,
      by_status: countBy(items, 'status'),
      by_run_scope: countBy(items, 'run_scope'),
      linked_inventory_item_count: new Set(items.flatMap((item) => item.linked_inventory_ids ?? [])).size,
      unlinked_item_count: items.filter((item) => !item.linked_inventory_ids || item.linked_inventory_ids.length === 0).length,
    },
    ...(sourceInventory ? { source_inventory_summary: summarizeSourceInventory(sourceInventory) } : {}),
    items,
  };
}

function summarizeDocumentationPlan(documentationPlan) {
  return {
    path: 'state/docs-review-documentation-plan.json',
    projection_version: documentationPlan.producer.documentation_plan_projection_version,
    item_count: documentationPlan.summary.item_count,
    by_status: documentationPlan.summary.by_status,
    by_run_scope: documentationPlan.summary.by_run_scope,
    linked_inventory_item_count: documentationPlan.summary.linked_inventory_item_count,
    unlinked_item_count: documentationPlan.summary.unlinked_item_count,
  };
}

function buildCoverageAreaTitle(area) {
  return [area.domain, area.feature, area.component].filter(Boolean).join(' / ') || area.id;
}

function calculateCoverageScore({ areas, statuses, completenessInventory, hasCompletenessInventory }) {
  if (hasCompletenessInventory) {
    const denominator = completenessInventory.length;
    const acceptedCount = completenessInventory.filter((item) => item.status === 'accepted').length;
    return denominator === 0 ? null : Number((acceptedCount / denominator).toFixed(4));
  }

  const denominator = areas.length;
  const acceptedCount = statuses.accepted ?? 0;
  return denominator === 0 ? null : Number((acceptedCount / denominator).toFixed(4));
}

function normalizeCoverageTaxonomy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const primaryAxis = normalizeOptionalString(value.primary_axis);
  const rationale = normalizeOptionalString(value.rationale);
  if (!primaryAxis && !rationale) {
    return null;
  }

  return {
    ...(primaryAxis ? { primary_axis: primaryAxis } : {}),
    ...(rationale ? { rationale } : {}),
  };
}

function normalizeCompletenessInventory(value, areaById) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('Coverage plan completeness_inventory must be an array when present.');
  }

  const ids = new Set();
  const unknownCoverageAreaReferences = [];
  const normalized = value.map((item, index) => normalizeCompletenessInventoryItem(
    item,
    index,
    ids,
    areaById,
    unknownCoverageAreaReferences,
  ));
  if (unknownCoverageAreaReferences.length > 0) {
    throw new Error(formatUnknownCoverageAreaReferences(unknownCoverageAreaReferences));
  }
  return normalized;
}

function normalizeCompletenessInventoryItem(item, index, ids, areaById, unknownCoverageAreaReferences) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`Coverage plan completeness_inventory item at index ${index} must be an object.`);
  }

  const id = normalizeOptionalString(item.id);
  if (!id) {
    throw new Error(`Coverage plan completeness_inventory item at index ${index} requires non-empty "id".`);
  }
  if (ids.has(id)) {
    throw new Error(`Coverage plan completeness_inventory contains duplicate item id: ${id}`);
  }
  ids.add(id);

  const status = normalizeOptionalString(item.status);
  if (!COVERAGE_PLAN_STATUSES.has(status)) {
    throw new Error(`Coverage plan completeness_inventory item "${id}" requires status to be accepted, deferred, or missing.`);
  }

  const coverageAreaIds = normalizeStringArray(item.coverage_area_ids);
  for (const areaId of coverageAreaIds) {
    if (!areaById.has(areaId)) {
      unknownCoverageAreaReferences.push({ inventoryId: id, areaId });
    }
  }

  return {
    id,
    ...(normalizeOptionalString(item.repo_id) ? { repo_id: normalizeOptionalString(item.repo_id) } : {}),
    ...(normalizeOptionalString(item.kind) ? { kind: normalizeOptionalString(item.kind) } : {}),
    ...(normalizeOptionalString(item.label) ? { label: normalizeOptionalString(item.label) } : {}),
    ...(SOURCE_CONFIDENCE_LEVELS.has(normalizeOptionalString(item.confidence) ?? '')
      ? { confidence: normalizeOptionalString(item.confidence) }
      : {}),
    status,
    ...(coverageAreaIds.length > 0 ? { coverage_area_ids: coverageAreaIds } : {}),
    evidence: normalizeStringArray(item.evidence),
    blindspots: normalizeStringArray(item.blindspots),
  };
}

function formatUnknownCoverageAreaReferences(references) {
  const formatted = references
    .map((reference) => `"${reference.inventoryId}" -> "${reference.areaId}"`)
    .join(', ');
  return `Coverage plan completeness_inventory references unknown coverage area ids: ${formatted}`;
}

function validateCoverageAreaInventoryLinks(areas, completenessInventory) {
  const inventoryIds = new Set(completenessInventory.map((item) => item.id));
  const unknownInventoryReferences = [];
  for (const area of areas) {
    for (const inventoryId of area.linked_inventory_ids ?? []) {
      if (!inventoryIds.has(inventoryId)) {
        unknownInventoryReferences.push({ areaId: area.id, inventoryId });
      }
    }
  }
  if (unknownInventoryReferences.length > 0) {
    throw new Error(formatUnknownLinkedInventoryReferences(unknownInventoryReferences));
  }
}

function formatUnknownLinkedInventoryReferences(references) {
  const formatted = references
    .map((reference) => `"${reference.areaId}" -> "${reference.inventoryId}"`)
    .join(', ');
  return `Coverage plan areas reference unknown linked_inventory_ids: ${formatted}`;
}

function normalizeCoverageArea(area, index, ids) {
  if (!area || typeof area !== 'object' || Array.isArray(area)) {
    throw new Error(`Coverage plan area at index ${index} must be an object.`);
  }

  const id = normalizeOptionalString(area.id);
  if (!id) {
    throw new Error(`Coverage plan area at index ${index} requires non-empty "id".`);
  }
  if (ids.has(id)) {
    throw new Error(`Coverage plan contains duplicate area id: ${id}`);
  }
  ids.add(id);

  const status = normalizeOptionalString(area.status);
  if (!COVERAGE_PLAN_STATUSES.has(status)) {
    throw new Error(`Coverage plan area "${id}" requires status to be accepted, deferred, or missing.`);
  }

  const coverage = normalizeOptionalString(area.coverage);
  if (!COVERAGE_LEVELS.has(coverage)) {
    throw new Error(`Coverage plan area "${id}" requires coverage to be comprehensive, partial, initial, or missing.`);
  }

  const proposedPath = normalizeOptionalString(area.proposed_path);
  if (proposedPath) {
    const normalizedPath = normalizeBlockPath(proposedPath);
    if (
      !normalizedPath.startsWith('architecture/') ||
      !normalizedPath.endsWith('.md') ||
      path.posix.isAbsolute(normalizedPath) ||
      normalizedPath.split('/').includes('..')
    ) {
      throw new Error(`Coverage plan area "${id}" has invalid proposed_path: ${proposedPath}`);
    }
  }

  const anchorAction = normalizeOptionalString(area.anchor_action);
  if (anchorAction && !ANCHOR_ACTIONS.has(anchorAction)) {
    throw new Error(`Coverage plan area "${id}" has invalid anchor_action: ${anchorAction}`);
  }
  const runScope = normalizeOptionalString(area.run_scope);
  if (runScope && !DOCUMENTATION_PLAN_RUN_SCOPES.has(runScope)) {
    throw new Error(`Coverage plan area "${id}" has invalid run_scope: ${runScope}`);
  }
  const anchorPaths = normalizeStringArray(area.anchor_paths).map(normalizeBlockPath);
  for (const anchorPath of anchorPaths) {
    if (
      !anchorPath.startsWith('architecture/') ||
      !anchorPath.endsWith('.md') ||
      path.posix.isAbsolute(anchorPath) ||
      anchorPath.split('/').includes('..')
    ) {
      throw new Error(`Coverage plan area "${id}" has invalid anchor_paths entry: ${anchorPath}`);
    }
  }

  return {
    id,
    domain: normalizeOptionalString(area.domain),
    feature: normalizeOptionalString(area.feature),
    component: normalizeOptionalString(area.component),
    status,
    coverage,
    ...(normalizeOptionalString(area.title) ? { title: normalizeOptionalString(area.title) } : {}),
    ...(normalizeOptionalString(area.purpose) ? { purpose: normalizeOptionalString(area.purpose) } : {}),
    ...(normalizeOptionalString(area.parent) ? { parent: normalizeOptionalString(area.parent) } : {}),
    ...(runScope ? { run_scope: runScope } : {}),
    ...(proposedPath ? { proposed_path: normalizeBlockPath(proposedPath) } : {}),
    ...(normalizeStringArray(area.linked_inventory_ids).length > 0
      ? { linked_inventory_ids: normalizeStringArray(area.linked_inventory_ids) }
      : {}),
    evidence: normalizeStringArray(area.evidence),
    blindspots: normalizeStringArray(area.blindspots),
    ...(normalizeOptionalString(area.reason) ? { reason: normalizeOptionalString(area.reason) } : {}),
    ...(anchorAction ? { anchor_action: anchorAction } : {}),
    ...(normalizeOptionalString(area.anchor_reason) ? { anchor_reason: normalizeOptionalString(area.anchor_reason) } : {}),
    ...(anchorPaths.length > 0 ? { anchor_paths: anchorPaths } : {}),
  };
}

function countBy(items, key) {
  return items.reduce((counts, item) => {
    counts[item[key]] = (counts[item[key]] ?? 0) + 1;
    return counts;
  }, {});
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim() !== '').map((value) => value.trim()))];
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

function createArchitectureDocSizeWarnings(blocks) {
  return blocks
    .map((block) => {
      const byteLength = Buffer.byteLength(ensureTrailingNewline(block.content), 'utf8');
      if (byteLength <= ARCHITECTURE_DOC_SOFT_SIZE_LIMIT_BYTES) {
        return null;
      }

      return `oversized_architecture_doc: ${block.path} is ${byteLength} bytes; soft budget is ${ARCHITECTURE_DOC_SOFT_SIZE_LIMIT_BYTES} bytes. Consider compacting the doc to preserve future LLM context budget.`;
    })
    .filter(Boolean);
}

function createArchitectureDocQualityWarnings(blocks) {
  const warnings = [];

  for (const block of blocks) {
    const frontmatter = parseFrontmatter(block.content, { sourceName: block.path });
    const body = frontmatter.body ?? '';
    const sections = extractLevelTwoSections(body);
    const data = frontmatter.data ?? {};

    if (!sections.has('review metadata')) {
      warnings.push(`missing_review_metadata: ${block.path} is missing "## Review metadata".`);
    }
    if (!/^\s*-\s*Evidence:\s+\S/im.test(body)) {
      warnings.push(`missing_evidence_metadata: ${block.path} is missing review metadata "Evidence".`);
    } else if (/^\s*-\s*Evidence:\s*repo:path references inspected before making implementation claims\s*$/im.test(body)) {
      warnings.push(`generic_evidence_metadata: ${block.path} uses generic evidence text; list concrete repo:path references instead.`);
    }
    if (!/^\s*-\s*Blindspots:\s+\S/im.test(body)) {
      warnings.push(`missing_blindspots_metadata: ${block.path} is missing review metadata "Blindspots".`);
    }
    if (!sections.has('retrieval guidance')) {
      warnings.push(`missing_retrieval_guidance: ${block.path} is missing "## Retrieval guidance".`);
    }
    if (!sections.has('involved files')) {
      warnings.push(`missing_involved_files: ${block.path} is missing "## Involved files".`);
    }
    if (
      block.path !== 'architecture/overview/project-shape.md' &&
      data.repo === undefined &&
      data.repos === undefined
    ) {
      warnings.push(`missing_repo_scope: ${block.path} should declare repo or repos in frontmatter when implementation-scoped.`);
    }
  }

  return warnings;
}

function createCoveragePlanQualityWarnings(coverageProjection, anchors) {
  if (!coverageProjection) {
    return [];
  }

  const warnings = [];
  const hasModernCoverageMetadata = Boolean(coverageProjection.topology || coverageProjection.taxonomy);
  const hasCompletenessInventory = Array.isArray(coverageProjection.completeness_inventory);
  if (hasModernCoverageMetadata && !hasCompletenessInventory) {
    warnings.push('missing_completeness_inventory: coverage plan should enumerate discovered subsystems so deferred or missing areas cannot be silently omitted.');
  } else if (hasCompletenessInventory) {
    for (const item of coverageProjection.completeness_inventory) {
      if (item.status === 'accepted' && (!Array.isArray(item.coverage_area_ids) || item.coverage_area_ids.length === 0)) {
        warnings.push(`accepted_inventory_without_area: completeness_inventory item "${item.id}" is accepted but does not reference coverage_area_ids.`);
      }
      if (item.status !== 'accepted' && (!Array.isArray(item.blindspots) || item.blindspots.length === 0)) {
        warnings.push(`incomplete_inventory_blindspot: completeness_inventory item "${item.id}" is ${item.status} but does not explain the gap in blindspots.`);
      }
    }
  }

  const hasPriorAnchors =
    (anchors?.architectureDocs?.length ?? 0) > 0 ||
    (anchors?.projectMapFeatures?.length ?? 0) > 0 ||
    Boolean(anchors?.coverage);
  if (!hasPriorAnchors) {
    return warnings;
  }

  for (const area of coverageProjection.areas) {
    if (!area.anchor_action) {
      warnings.push(`missing_anchor_action: coverage area "${area.id}" should classify prior docs or project-map identities when re-review anchors exist.`);
      continue;
    }
    if (['split', 'merge', 'replace'].includes(area.anchor_action) && !area.anchor_reason) {
      warnings.push(`missing_anchor_reason: coverage area "${area.id}" uses anchor_action "${area.anchor_action}" without an evidence-backed anchor_reason.`);
    }
    if (area.anchor_action !== 'new' && (!Array.isArray(area.anchor_paths) || area.anchor_paths.length === 0)) {
      warnings.push(`missing_anchor_paths: coverage area "${area.id}" uses anchor_action "${area.anchor_action}" without anchor_paths.`);
    }
  }

  return warnings;
}

function extractLevelTwoSections(markdown) {
  return new Set(
    [...String(markdown ?? '').matchAll(/^##\s+(.+)$/gm)]
      .map((match) => match[1].trim().toLowerCase()),
  );
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
  // D-237: the baseline must come from the submitted target's own cursor so a
  // dev revision can never be sent as another environment's baseline.
  const submitCursor = readSyncCursor(options.manifest?.manifest?.sync, {
    target: options.runtime.sync_target ?? null,
    apiUrl: options.runtime.api_url,
    projectId: options.runtime.project_id,
  });
  const baselineRemoteRevisionId = normalizeUuid(
    submitCursor.last_successful_remote_revision,
  );
  const evidenceScope = await buildHostedDocsReviewEvidenceScope(options);
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
      evidence_scope: evidenceScope,
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

async function buildHostedDocsReviewEvidenceScope(options) {
  const rootDir = options.rootDir;
  const coverage = rootDir
    ? await readJsonOptional(path.join(rootDir, 'state', 'docs-review-coverage.json'))
    : null;
  const sourceInventory = rootDir
    ? await readJsonOptional(docsReviewSourceInventoryPath(rootDir))
    : null;
  const documentationPlan = rootDir
    ? await readJsonOptional(path.join(rootDir, 'state', 'docs-review-documentation-plan.json'))
    : null;
  const warnings = Array.isArray(coverage?.warnings) ? coverage.warnings : [];

  return {
    manifest_hash: options.manifest?.manifest?.canonical?.manifest_hash,
    document_count: options.manifest?.manifest?.canonical?.document_count,
    warning_count: options.manifest?.manifest?.canonical?.warning_count,
    ...(coverage?.producer ? { producer: coverage.producer } : {}),
    ...(coverage ? { coverage_summary: summarizeHostedCoverage(coverage) } : {}),
    ...(coverage?.source_inventory_summary
      ? { source_inventory_summary: coverage.source_inventory_summary }
      : sourceInventory
        ? { source_inventory_summary: summarizeSourceInventory(sourceInventory) }
        : {}),
    ...(coverage?.documentation_plan_summary
      ? { documentation_plan_summary: coverage.documentation_plan_summary }
      : documentationPlan
        ? { documentation_plan_summary: summarizeDocumentationPlan(documentationPlan) }
        : {}),
    ...(coverage?.reconciliation_summary ? { reconciliation_summary: coverage.reconciliation_summary } : {}),
    ...(warnings.length > 0 ? { warning_provenance: summarizeWarningProvenance(warnings) } : {}),
  };
}

async function readJsonOptional(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function summarizeHostedCoverage(coverage) {
  return {
    path: 'state/docs-review-coverage.json',
    ...(coverage.score_basis ? { score_basis: coverage.score_basis } : {}),
    ...(typeof coverage.area_count === 'number' ? { area_count: coverage.area_count } : {}),
    ...(typeof coverage.coverage_score === 'number' || coverage.coverage_score === null
      ? { coverage_score: coverage.coverage_score }
      : {}),
    ...(coverage.statuses ? { statuses: coverage.statuses } : {}),
    ...(coverage.coverage_levels ? { coverage_levels: coverage.coverage_levels } : {}),
    ...(typeof coverage.inventory_count === 'number' ? { inventory_count: coverage.inventory_count } : {}),
    ...(coverage.inventory_statuses ? { inventory_statuses: coverage.inventory_statuses } : {}),
    ...(coverage.topology ? { topology: coverage.topology } : {}),
    ...(coverage.taxonomy?.primary_axis ? { taxonomy_primary_axis: coverage.taxonomy.primary_axis } : {}),
  };
}

function summarizeWarningProvenance(warnings) {
  return {
    warning_count: warnings.length,
    codes: countBy(warnings, 'code'),
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

async function listArchitectureDocs(rootDir, scopePath) {
  const scopeAbsolutePath = path.join(rootDir, scopePath);

  if (!await pathExists(scopeAbsolutePath)) {
    return [];
  }

  const docs = [];
  await collectArchitectureDocs({
    rootDir,
    currentPath: scopeAbsolutePath,
    docs,
  });
  return docs.sort();
}

async function collectArchitectureDocs(options) {
  const entries = await readdir(options.currentPath, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(options.currentPath, entry.name);
    if (entry.isDirectory()) {
      await collectArchitectureDocs({
        rootDir: options.rootDir,
        currentPath: absolutePath,
        docs: options.docs,
      });
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }

    const relativePath = normalizeBlockPath(path.relative(options.rootDir, absolutePath));
    if (isProtectedArchitectureDoc(relativePath)) {
      continue;
    }
    options.docs.push(relativePath);
  }
}

function isProtectedArchitectureDoc(relativePath) {
  return relativePath === 'architecture/README.md' ||
    relativePath === 'architecture/overview/project-shape.md';
}

function normalizeRebuildScopePath(value) {
  const normalized = normalizeBlockPath(value ?? 'architecture');
  if (
    normalized !== 'architecture' &&
    !normalized.startsWith('architecture/')
  ) {
    throw new Error(`docs-review --rebuild --path must point under architecture/. Invalid path: ${value}`);
  }
  if (
    path.posix.isAbsolute(normalized) ||
    normalized.split('/').some((part) => part === '..' || part === '') ||
    normalized.endsWith('.md')
  ) {
    throw new Error(`docs-review --rebuild --path must be a relative architecture directory. Invalid path: ${value}`);
  }

  return normalized;
}

function normalizeRebuildStalePolicy(value) {
  const normalized = normalizeOptionalString(value) ?? 'keep';
  if (!REBUILD_STALE_POLICIES.has(normalized)) {
    throw new Error('docs-review --rebuild --stale-policy must be keep or archive.');
  }

  return normalized;
}

function formatArchiveTimestamp(date) {
  return date.toISOString().replaceAll(':', '-').replaceAll('.', '-');
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

function validateDecisionRecommendationBlocks(blocks) {
  return blocks.map((block, index) => {
    const fields = parseDecisionRecommendationFields(block.content);
    const title = normalizeOptionalString(fields.title);
    const decision = normalizeOptionalString(fields.decision);
    const rationale = normalizeOptionalString(fields.rationale);
    const context = normalizeOptionalString(fields.context);

    if (!title) {
      throw new Error(`Decision recommendation ${index + 1} must include a non-empty Title.`);
    }
    if (!decision) {
      throw new Error(`Decision recommendation ${index + 1} must include non-empty Decision content.`);
    }
    if (!rationale) {
      throw new Error(`Decision recommendation ${index + 1} must include a non-empty Rationale.`);
    }

    return {
      targetPath: block.targetPath,
      title,
      decision,
      rationale,
      context,
    };
  });
}

function parseDecisionRecommendationFields(content) {
  const fields = {};
  let currentKey = null;

  for (const line of String(content ?? '').split(/\r?\n/)) {
    const labelMatch = line.match(/^\*\*(Title|Decision|Rationale|Context):\*\*\s*(.*)$/i);
    if (labelMatch) {
      currentKey = labelMatch[1].toLowerCase();
      fields[currentKey] = labelMatch[2].trim();
      continue;
    }

    if (currentKey && line.trim()) {
      fields[currentKey] = `${fields[currentKey] ? `${fields[currentKey]}\n` : ''}${line.trim()}`;
    }
  }

  return fields;
}

async function applyDecisionRecommendations(options) {
  const applied = [];
  for (const recommendation of options.recommendations) {
    const nextDecisionId = await readNextDecisionId(options.rootDir);
    const targetFilePath = path.join(options.rootDir, recommendation.targetPath);
    await mkdir(path.dirname(targetFilePath), { recursive: true });

    let existingContent = '';
    try {
      existingContent = await readFile(targetFilePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      existingContent = `# ${path.basename(recommendation.targetPath, '.md')} decisions\n`;
    }

    const entry = renderDecisionEntry({
      decisionId: nextDecisionId,
      title: recommendation.title,
      decision: recommendation.decision,
      rationale: recommendation.rationale,
      context: recommendation.context,
    });
    await writeFile(targetFilePath, `${existingContent.trimEnd()}\n\n${entry}`, 'utf8');
    applied.push({
      decision_id: nextDecisionId,
      target_path: recommendation.targetPath,
      title: recommendation.title,
    });
  }

  if (applied.length === 0) {
    return { applied, warnings: [] };
  }

  const indexResult = options.refreshIndex
    ? await refreshDecisionIndex(options.rootDir)
    : {
      refreshed: false,
      warnings: [
        'decisions/INDEX.md was not refreshed after applying docs-review decision recommendations. Run again with --refresh-index if this root uses the package-generated flat index, or update the project-specific index manually.',
      ],
    };

  return {
    applied: applied.map((item) => ({
      ...item,
      refreshed_index: indexResult.refreshed,
    })),
    warnings: indexResult.warnings,
  };
}

// readNextDecisionId and listDecisionFileNames moved to decisions.js so the
// atomic append path (D-276) and these apply paths share one allocation scan.

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

  // D-283/D-255 quarantine: the flat generator must never be pointed at a
  // grouped index — a wholesale rewrite would destroy the hand-authored
  // session group headings. Any "## " heading counts as grouped-shaped, so a
  // malformed grouped index survives too.
  const existingIndex = await readFile(indexPath, 'utf8').catch(() => null);
  if (existingIndex !== null && looksLikeGroupedDecisionIndex(existingIndex)) {
    return {
      refreshed: false,
      warnings: [
        'decisions/INDEX.md uses the grouped session shape; --refresh-index (the flat D-209 generator) refuses to overwrite it. Use `vibecompass refresh-decision-index` (D-283) instead.',
      ],
    };
  }

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

function renderApplyOutputMessage(options) {
  const parts = [];
  if (options.architectureCount > 0) {
    parts.push(`${options.architectureCount} accepted architecture doc${options.architectureCount === 1 ? '' : 's'}`);
  }
  if (options.coverageApplied) {
    parts.push('coverage plan');
  }
  if (options.decisionCount > 0) {
    parts.push(`${options.decisionCount} decision recommendation${options.decisionCount === 1 ? '' : 's'}`);
  }

  return `Applied ${parts.length > 0 ? parts.join(', ') : 'accepted docs-review output'} and completed the docs-review marker.`;
}

export async function buildDocsReviewAnchorContext(rootDir) {
  const context = {
    architectureDocs: [],
    projectMapFeatures: [],
    projectMapRelationshipCount: 0,
    coverage: null,
    warnings: [],
  };

  try {
    const scanned = await scanProjectMemory(rootDir);
    context.architectureDocs = scanned.documents
      .filter((document) => document.kind === 'architecture' && document.path !== PROJECT_MAP_PATH && document.extracted)
      .map((document) => ({
        path: document.path,
        domain: document.extracted.domain,
        feature: document.extracted.feature,
        component: document.extracted.component,
        status: document.extracted.status,
        repos: document.extracted.repo_ids ?? [],
      }))
      .sort((left, right) => left.path.localeCompare(right.path));

    if (scanned.errors.length > 0) {
      context.warnings.push(`${scanned.errors.length} project-memory parse error(s) found while building anchors; inspect status before trusting prior docs.`);
    }
  } catch (error) {
    context.warnings.push(`Could not scan existing project memory for anchors: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const projectMap = await readProjectMapAnchor(rootDir);
    context.projectMapFeatures = projectMap.features;
    context.projectMapRelationshipCount = projectMap.relationshipCount;
  } catch (error) {
    context.warnings.push(`Could not read existing project-map anchors: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    context.coverage = await readCoverageAnchor(rootDir);
  } catch (error) {
    context.warnings.push(`Could not read docs-review coverage anchors: ${error instanceof Error ? error.message : String(error)}`);
  }

  return context;
}

async function readProjectMapAnchor(rootDir) {
  const projectShapePath = path.join(rootDir, PROJECT_MAP_PATH);
  let content;
  try {
    content = await readFile(projectShapePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { features: [], relationshipCount: 0 };
    }
    throw error;
  }

  const match = content.match(/^```vibecompass-project-map\s+version=1\s*\n([\s\S]*?)^```[ \t]*$/m);
  if (!match) {
    return { features: [], relationshipCount: 0 };
  }

  const parsed = JSON.parse(match[1]);
  const features = Array.isArray(parsed.features)
    ? parsed.features
      .map((feature) => ({
        domain: normalizeOptionalString(feature?.domain),
        feature: normalizeOptionalString(feature?.feature),
        isEntryPoint: Boolean(feature?.is_entry_point),
      }))
      .filter((feature) => feature.domain && feature.feature)
    : [];

  return {
    features,
    relationshipCount: Array.isArray(parsed.relationships) ? parsed.relationships.length : 0,
  };
}

async function readCoverageAnchor(rootDir) {
  const coveragePath = path.join(rootDir, 'state', 'docs-review-coverage.json');
  let content;
  try {
    content = await readFile(coveragePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  const parsed = JSON.parse(content);
  return {
    summary: normalizeOptionalString(parsed.summary),
    areaCount: Number.isInteger(parsed.area_count) ? parsed.area_count : null,
    coverageScore: typeof parsed.coverage_score === 'number' ? parsed.coverage_score : null,
    statuses: parsed.statuses && typeof parsed.statuses === 'object' && !Array.isArray(parsed.statuses)
      ? parsed.statuses
      : null,
    areas: Array.isArray(parsed.areas)
      ? parsed.areas
        .map((area) => ({
          id: normalizeOptionalString(area?.id),
          path: normalizeOptionalString(area?.proposed_path),
          status: normalizeOptionalString(area?.status),
          coverage: normalizeOptionalString(area?.coverage),
        }))
        .filter((area) => area.id)
      : [],
  };
}

function renderAnchorContext(anchors) {
  const lines = [
    '## Re-review Anchors',
    'Use these anchors to prevent taxonomy churn. Reuse prior slugs and doc identities when current evidence still supports them.',
    'If you propose a taxonomy change, explain the evidence and classify the prior doc/slug action before writing prose.',
    '',
    'Required prior-doc classifications for Stage 2:',
    '- `reuse`: keep path/frontmatter identity and update only if needed',
    '- `update`: keep path/frontmatter identity but refresh content or coverage',
    '- `split`: replace one broad prior doc with multiple focused docs',
    '- `merge`: combine overlapping prior docs',
    '- `defer`: leave prior area documented but out of the accepted generation scope',
    '- `replace`: rename or move only when evidence strongly justifies it',
    '- `new`: add a new area not represented by the prior tree',
    '',
  ];

  if (anchors?.warnings?.length > 0) {
    lines.push('Anchor warnings:');
    for (const warning of anchors.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push('');
  }

  if (anchors?.architectureDocs?.length > 0) {
    lines.push(`Existing architecture docs (${anchors.architectureDocs.length}):`);
    for (const doc of anchors.architectureDocs.slice(0, 40)) {
      const identity = [doc.domain, doc.feature, doc.component].filter(Boolean).join(' / ');
      const repos = doc.repos.length > 0 ? ` repos=${doc.repos.join(',')}` : '';
      lines.push(`- ${doc.path} -> ${identity || 'unmapped'}; status=${doc.status ?? 'unknown'}${repos}`);
    }
    if (anchors.architectureDocs.length > 40) {
      lines.push(`- ... ${anchors.architectureDocs.length - 40} additional architecture docs omitted from prompt anchor summary; still classify broad prior taxonomy before changing it.`);
    }
  } else {
    lines.push('Existing architecture docs: none beyond the starter overview or none readable.');
  }
  lines.push('');

  if (anchors?.projectMapFeatures?.length > 0) {
    lines.push(`Existing project-map feature identities (${anchors.projectMapFeatures.length}; relationships=${anchors.projectMapRelationshipCount}):`);
    for (const feature of anchors.projectMapFeatures.slice(0, 40)) {
      lines.push(`- ${feature.domain} / ${feature.feature}${feature.isEntryPoint ? ' (entry point)' : ''}`);
    }
    if (anchors.projectMapFeatures.length > 40) {
      lines.push(`- ... ${anchors.projectMapFeatures.length - 40} additional project-map features omitted from prompt anchor summary.`);
    }
  } else {
    lines.push('Existing project-map feature identities: none found.');
  }
  lines.push('');

  if (anchors?.coverage) {
    const score = typeof anchors.coverage.coverageScore === 'number'
      ? `${Math.round(anchors.coverage.coverageScore * 100)}% accepted`
      : 'unscored';
    lines.push(`Existing coverage projection: ${anchors.coverage.areaCount ?? anchors.coverage.areas.length} areas, ${score}.`);
    if (anchors.coverage.summary) {
      lines.push(`Coverage summary: ${anchors.coverage.summary}`);
    }
    for (const area of anchors.coverage.areas.slice(0, 20)) {
      lines.push(`- ${area.id}: ${area.status || 'unknown'} / ${area.coverage || 'unknown'}${area.path ? ` -> ${area.path}` : ''}`);
    }
  } else {
    lines.push('Existing coverage projection: none found.');
  }

  return lines.join('\n');
}

function renderSourceInventoryContext(inventory) {
  const lines = [
    '## Package Source Inventory',
    'Use this package-scanned inventory as the source-evidence denominator for coverage planning. Account for each scanned item as accepted, deferred, or missing in `completeness_inventory` when evidence is sufficient.',
    '',
  ];

  if (!inventory) {
    lines.push('No package source inventory was available.');
    return lines.join('\n');
  }

  const itemCount = Array.isArray(inventory.items) ? inventory.items.length : 0;
  lines.push(`Scanner: ${inventory.producer?.scanner_version ?? 'unknown'}; items=${itemCount}; warnings=${inventory.warnings?.length ?? 0}.`);
  if (Array.isArray(inventory.source_roots) && inventory.source_roots.length > 0) {
    lines.push('Source roots:');
    for (const sourceRoot of inventory.source_roots) {
      const details = [
        `kind=${sourceRoot.kind}`,
        `status=${sourceRoot.status}`,
        sourceRoot.repo_root_path ? `repo_root_path=${sourceRoot.repo_root_path}` : null,
      ].filter(Boolean).join('; ');
      lines.push(`- ${sourceRoot.repo_id}: ${details}`);
    }
  }

  if (Array.isArray(inventory.warnings) && inventory.warnings.length > 0) {
    lines.push('Source inventory warnings:');
    for (const warning of inventory.warnings.slice(0, 20)) {
      lines.push(`- ${warning.code}: ${warning.message}`);
    }
  }

  if (itemCount > 0) {
    lines.push('Scanned inventory items:');
    for (const item of inventory.items.slice(0, 80)) {
      const evidence = item.evidence?.slice(0, 3).map((entry) => entry.path).join(', ');
      lines.push(`- ${item.id} (${item.kind}, ${item.confidence}): ${item.label}${evidence ? `; evidence=${evidence}` : ''}`);
    }
    if (itemCount > 80) {
      lines.push(`- ... ${itemCount - 80} additional scanned inventory items omitted from prompt summary.`);
    }
  } else {
    lines.push('Scanned inventory items: none. If source roots are unavailable, say coverage is not source-backed for those repos.');
  }

  return lines.join('\n');
}

function renderReviewPrompt(options) {
  const outputPath = path.join(options.rootDir, 'state', 'docs-review-output.md');
  const applyCommand = `vibecompass docs-review --root ${shellQuote(options.rootDir)} --apply-output --output ${shellQuote(outputPath)}`;
  const npxApplyCommand = `npx -y @vibecompass/vibecompass@${PACKAGE_VERSION} docs-review --root ${shellQuote(options.rootDir)} --apply-output --output ${shellQuote(outputPath)}`;
  const isSingleTurn = options.executionMode === 'single-turn';
  const coveragePlanStageLines = isSingleTurn
    ? [
      '- This is a single-turn execution mode: there is no mid-review user approval turn.',
      '- Treat the coverage plan you emit in this response as accepted proposal material, then emit the planned `vibecompass-coverage-plan`, architecture-doc, and decision-recommendation fences in the same response.',
      '- Human review happens later at the local apply-output step or hosted proposal surface; generated output is not canonical until accepted and applied.',
    ]
    : [
      '- Before user approval, present the coverage plan as human-readable proposed scope. Do not label proposed areas `accepted` and do not emit the `vibecompass-coverage-plan` fence yet.',
      '- Ask for user acceptance before emitting fenced coverage-plan or architecture-doc blocks. When you stop for acceptance, state plainly that no architecture docs have been applied yet.',
      '- After approval, emit the accepted plan as one `vibecompass-coverage-plan version=1` JSON fence before architecture-doc blocks.',
    ];
  const outputContractIntroLines = isSingleTurn
    ? [
      'Because this is a single-turn execution mode, output the machine-readable coverage-plan block in this response before architecture-doc blocks.',
    ]
    : [
      'If you are stopping for user approval, do not output the machine-readable fence below yet; show the plan as proposed scope and ask the user to approve or revise it.',
      '',
      'After the user accepts the plan, output one machine-readable coverage-plan block for the accepted plan:',
    ];
  const stage4WriteLine = isSingleTurn
    ? `- The package will save the model response to \`${outputPath}\`; local users or hosted proposal reviewers decide what becomes canonical later.`
    : `- After the user accepts Stage 2, write the complete accepted fenced output verbatim to \`${outputPath}\`.`;
  const applyCommandLabel = isSingleTurn ? 'Apply command after acceptance' : 'Apply command after user acceptance';
  const stage4ApplyLines = isSingleTurn
    ? [
      '- Do not claim docs-review is applied in this response; generated output is proposal material until local apply or hosted proposal acceptance succeeds.',
      `- Local apply command after acceptance: \`${applyCommand}\`.`,
      `- If \`vibecompass\` is not installed on PATH, the local user can run \`${npxApplyCommand}\` instead.`,
    ]
    : [
      `- Then run \`${applyCommand}\` to validate and apply the accepted blocks.`,
      `- If \`vibecompass\` is not installed on PATH, run \`${npxApplyCommand}\` instead.`,
      '- Only report docs-review as applied after the apply command succeeds. Surface any parser warnings, especially oversized docs, so the user can decide whether to compact or accept the output.',
    ];
  const finalOutputLine = isSingleTurn
    ? `Only include accepted proposal-material blocks for coverage, architecture, and decision recommendations. The package or hosted worker saves the response to \`${outputPath}\`; report that generated output still requires local apply or hosted proposal acceptance before it is canonical.`
    : `Only include accepted coverage, architecture, and decision-recommendation blocks. After user acceptance, save the final accepted output to \`${outputPath}\`, run \`${applyCommand}\` or \`${npxApplyCommand}\`, and report applied paths plus parser warnings.`;
  const architectureDocBlockIntro = isSingleTurn
    ? 'Then, for each planned architecture doc in this single-turn response, output one fenced block exactly like this:'
    : 'Then, for each architecture doc the user accepts, output one fenced block exactly like this:';

  return [
    `# ${DOCS_REVIEW_PROMPT_VERSION}`,
    '',
    'Run a staged VibeCompass architecture documentation review for the project-memory root below. Follow this prompt exactly; do not invent a different document structure.',
    '',
    '## Review Context',
    `- Project memory root: ${options.rootDir}`,
    `- Project: ${options.project.name}`,
    `- Project mode: ${options.project.mode}`,
    `- Review provider to record: ${options.llm}`,
    `- Review model/version to record: ${options.model}`,
    `- Execution mode: ${isSingleTurn ? 'single-turn (emit accepted proposal output now)' : 'interactive (stop at coverage-plan approval gate)'}`,
    `- Accepted output file: ${outputPath}`,
    `- ${applyCommandLabel}: ${applyCommand}`,
    `- Apply command if the CLI is not installed on PATH: ${npxApplyCommand}`,
    '',
    '## Required Inputs',
    '1. Read `project.yaml`.',
    '2. Read `context.md` if present.',
    '3. Read all canonical files under `architecture/`, `decisions/`, and finalized `sessions/`.',
    '4. Inspect declared repositories before making implementation claims.',
    '',
    renderAnchorContext(options.anchors),
    '',
    renderSourceInventoryContext(options.sourceInventory),
    '',
    '## Staged Review Protocol',
    'Stage 1 — Evidence inventory:',
    '- Build a compact repo inventory from file paths, manifests/config files, route/job/test directories, and existing architecture frontmatter before reading large file bodies.',
    '- Identify the project topology before choosing docs: single-repo/monolith, multi-repo, multi-surface, package/CLI, workers/services, mobile app, or mixed. State the topology in the coverage plan.',
    '- Build a completeness inventory of discovered apps/repos, routes/screens, API endpoints, tables/storage, jobs/cron/tasks, auth/session flows, external integrations, platform surfaces, and product features. Keep it subsystem-level, not a raw file dump.',
    '- Mine finalized session notes for decision candidates and product constraints, but cap proposed decisions to the five highest-value architecture choices.',
    '- Identify candidate domains, features, components, ownership boundaries, user journey entry points, feature-to-feature relationships, and system-layer connections with concrete `repo:path` evidence.',
    '- Separate product features from runtime surfaces. Web, mobile, backend/API, database/storage, jobs, external integrations, and deployment/runtime are surfaces or systems that participate in features; do not treat them as competing feature categories unless the project itself is a platform/tooling project.',
    '- Do not fetch or summarize broad source bodies until the coverage plan says a file is needed.',
    '',
    'Stage 2 — Coverage plan:',
    '- Propose the smallest useful architecture-doc set that will let future agents understand the project and retrieve targeted context.',
    '- The minimum useful set must cover: user journey, project/system map (frontend/backend/API/data/integration structure and connections), and summaries of the core journey-facing features.',
    '- Treat Stage 2 as a documentation-plan gate: each proposed doc needs a title, target path, purpose, parent/backbone grouping, linked inventory ids, evidence set, expected coverage level, prior-anchor action, and `baseline` or `deepening` run scope.',
    '- Keep baseline docs breadth-first and compact. Use `deepening` only for scoped follow-up docs that should not block the first project-understanding baseline.',
    '- Prioritize entry points, user-flow/gating relationships, data ownership, external integrations, jobs/async boundaries, auth/security boundaries, and test surfaces.',
    '- Account for each completeness-inventory item in the coverage plan as accepted, deferred, or missing. Do not inflate coverage by omitting large discovered subsystems; honest deferred/missing entries are expected when the first pass cannot cover everything.',
    '- Before generating prose, self-check that every `completeness_inventory[].coverage_area_ids[]` value points to an `areas[].id` in the same accepted plan. Fix all dangling ids together at the plan gate.',
    '- Before generating prose, self-check that every `areas[].linked_inventory_ids[]` value points to a `completeness_inventory[].id` in the same accepted plan. Fix all dangling ids together at the plan gate.',
    '- Choose one primary taxonomy axis from topology evidence and keep it stable: single-repo/monolith may default domain-first; multi-repo or multi-surface projects may use platform/repo-first or domain-first with per-surface components. Do not mix taxonomy axes at the same tier unless you explicitly propose and justify a restructuring.',
    '- For every prior architecture doc or project-map feature identity in Re-review Anchors, classify the plan action as `reuse`, `update`, `split`, `merge`, `defer`, or `replace`. Use `new` only for areas not represented by the prior tree.',
    '- Every `split`, `merge`, or `replace` action requires an evidence-backed anchor reason before prose generation. No unexplained slug rename is allowed.',
    '- Treat the accepted Stage-2 plan as the taxonomy and feature-list freeze for this docs-review run.',
    '- The user can revise the Stage-2 plan by merging, splitting, demoting, deferring, or requesting deepening before prose generation.',
    '- Mark each proposed doc as `comprehensive`, `partial`, or `initial`, with the reason and blindspots.',
    ...coveragePlanStageLines,
    '',
    'Stage 3 — Backbone output and bounded doc generation:',
    '- Generate only accepted docs, one complete fenced block per architecture path.',
    '- Ensure `architecture/overview/project-shape.md` includes compact backbone sections for topology, core feature inventory, user journey map, project systems map, and coverage/quality summary.',
    '- Ensure `architecture/overview/project-shape.md` includes exactly one `vibecompass-project-map version=1` JSON fence that lists journey-facing features, supported feature relationships, and minimal optional derived `systems[]` metadata.',
    '- Keep docs concise and retrieval-oriented: explain contracts, flows, invariants, and ownership; do not rewrite source code or produce file-by-file walkthroughs.',
    `- Soft size budget: keep each generated architecture doc under ${ARCHITECTURE_DOC_SOFT_SIZE_LIMIT_BYTES} bytes unless the extra detail is necessary and called out in Blindspots or Retrieval guidance.`,
    '- Include only the most important involved files; prefer representative entry points and owned contracts over exhaustive file lists.',
    '- Do not put transient apply-state instructions inside architecture docs, such as "this artifact has not been applied". Apply state belongs in the chat response and package marker, not canonical docs.',
    '',
    'Stage 4 — Apply and verify:',
    stage4WriteLine,
    ...stage4ApplyLines,
    '',
    '## Architecture Doc Contract',
    'When creating or updating architecture docs, use the existing VibeCompass structure:',
    '- path: `architecture/<domain-slug>/<feature-slug>/<component-slug>.md` for component docs',
    '- frontmatter fields: `domain`, `feature`, `component`, `status`, plus `repo` or `repos` when implementation-scoped',
    '- body sections: `## Description`, `## Review metadata`, `## Details`, `## Retrieval guidance`, `## Next steps`, `## Involved files`',
    '- overview docs may add compact peer sections for Stage 1 backbone outputs when useful: `## Topology`, `## Core feature inventory`, `## User journey map`, `## Project systems map`, and `## Coverage and quality summary`',
    '- feature docs may add a compact `## Surface matrix` prose table when multiple surfaces participate. Keep it evidence-sized: include participating surfaces with concrete `repo:path` evidence and explicit N/A rows only when an absence is important to retrieval. Do not emit a new machine-readable surface block.',
    '- surface/platform ownership docs should stay inside the existing contract, typically as `architecture/platform/<surface>/<component>.md`; do not introduce a top-level `systems/` tree.',
    '',
    'Use this exact Review metadata sub-header in every generated architecture doc:',
    '',
    '## Review metadata',
    `- Review provider: ${options.llm}`,
    `- Review model/version: ${options.model}`,
    `- Project mode: ${options.project.mode}`,
    '- Confidence: high | medium | low',
    '- Coverage: comprehensive | partial | initial',
    '- Evidence: concrete repo:path references inspected before making implementation claims',
    '- Retrieval scope: when future agents should load this doc',
    `- Token posture: compact unless the doc intentionally exceeds ${ARCHITECTURE_DOC_SOFT_SIZE_LIMIT_BYTES} bytes`,
    '- Blindspots: explicit list, or "None identified" only when evidence is comprehensive',
    '',
    '## Review Rules',
    '1. Do not delete `architecture/overview/project-shape.md`.',
    '2. Add or update `architecture/overview/project-shape.md` so it explains the topology, core feature inventory, user journey map, project systems map, coverage/quality summary, and accepted `vibecompass-project-map version=1` block.',
    '3. Add evidence-backed component docs alongside the overview for core journey-facing features and important supporting systems.',
    '4. Update `architecture/overview/project-shape.md` coverage and blindspot sections to summarize what has now been mapped.',
    '5. Keep all implementation claims source-backed with `repo:path` evidence.',
    '6. Use only the exact confidence and coverage enum values listed above.',
    '7. Put uncertainty in `Blindspots`; do not fill gaps with guesses.',
    '8. Do not append real `D-NNN` decisions without explicit user acceptance. Propose candidate decisions separately.',
    '9. Do not edit `decisions/INDEX.md` directly unless a canonical decision file was explicitly accepted and appended.',
    '10. Optimize for future retrieval: project-level docs stay compact; component docs carry focused context for a specific area.',
    '11. Evidence metadata must name concrete files such as `app:src/server.ts`; do not use generic placeholders like "repo:path references inspected before making implementation claims".',
    '',
    '## Project Map Block',
    'Include exactly one project-map block inside `architecture/overview/project-shape.md` when the user accepts journey/system mapping output:',
    '',
    '```vibecompass-project-map version=1',
    '{',
    '  "features": [',
    '    {',
    '      "domain": "Domain name matching architecture frontmatter",',
    '      "feature": "Feature name matching architecture frontmatter",',
    '      "is_entry_point": true,',
    '      "summary": "Short user-facing feature summary"',
    '    }',
    '  ],',
    '  "relationships": [',
    '    {',
    '      "from": { "domain": "Domain", "feature": "Feature" },',
    '      "to": { "domain": "Domain", "feature": "Feature" },',
    '      "kind": "gates | navigates_to | depends_on | writes_to",',
    '      "label": "Short evidence-backed relationship label"',
    '    }',
    '  ],',
    '  "systems": [',
    '    {',
    '      "id": "stable-system-id",',
    '      "name": "System or runtime surface name",',
    '      "kind": "frontend | backend | mobile | worker | cli | package | database | integration | mixed",',
    '      "repos": ["repo-id"],',
    '      "summary": "Short evidence-backed system summary",',
    '      "owns_features": [{ "domain": "Domain", "feature": "Feature" }]',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    'Only include relationships supported by evidence. Prefer `navigates_to` and `gates` for the main user journey; use `depends_on` and `writes_to` for supporting system relationships. If useful journey links cannot be inferred, state that as a coverage gap rather than inventing links.',
    '`systems[]` is optional derived overview metadata, not a new canonical taxonomy, relationship schema, or projection source. Include it only when evidence identifies runtime/deployable units or external systems; treat `owns_features` as documentation-only grouping, put user-journey links in `relationships[]`, and record uncertain systems or system-to-system connections as blindspots.',
    'Per-feature surface matrices are derived prose. `systems[].owns_features` remains the only machine-readable system-to-feature hint in this release; do not duplicate that graph in another parsed block.',
    '',
    '## Output Contract',
    'First provide a concise findings summary with:',
    '- mapped areas',
    '- backbone outputs: topology, core feature inventory, user journey map, project systems map, and coverage/quality summary',
    '- user journey and project/system map coverage',
    '- gaps/blindspots',
    '- evidence inventory summary',
    '- completeness inventory summary with accepted/deferred/missing accounting',
    '- topology and chosen taxonomy axis',
    '- coverage plan and proposed architecture docs',
    '- prior-doc anchor classifications and reasons',
    '- coverage/quality report, including missing/generic evidence, unmapped core features, oversized-doc candidates, unresolved blindspots, and a note that the score is over the evidence/completeness inventory when present, not the number of doc files',
    '- token-budget risks or oversized-doc candidates',
    '- proposed decisions, if any',
    '',
    ...outputContractIntroLines,
    '',
    '```vibecompass-coverage-plan version=1',
    '{',
    '  "summary": "Short coverage plan summary",',
    '  "topology": "single-repo | monolith | multi-repo | multi-surface | package-cli | mixed",',
    '  "taxonomy": {',
    '    "primary_axis": "domain-first | platform-first | repo-first | other",',
    '    "rationale": "Why this axis matches the evidence and how it avoids mixed tiers"',
    '  },',
    '  "completeness_inventory": [',
    '    {',
    '      "id": "stable-subsystem-id",',
    '      "kind": "feature | surface | route | screen | api | data | storage | job | integration | auth | deployment | other",',
    '      "label": "Short discovered subsystem label",',
    '      "status": "accepted | deferred | missing",',
    '      "coverage_area_ids": ["stable-area-id"],',
    '      "evidence": ["repo:path"],',
    '      "blindspots": ["explicit blindspot for deferred or missing items"]',
    '    }',
    '  ],',
    '  "areas": [',
    '    {',
    '      "id": "stable-area-id",',
    '      "domain": "Domain",',
    '      "feature": "Feature",',
    '      "component": "Component",',
    '      "title": "Human-readable planned doc title",',
    '      "purpose": "Why this doc exists and what future agents should load it for",',
    '      "parent": "Overview backbone | Feature inventory | Journey map | Systems map | Focused component docs | Deepening queue",',
    '      "run_scope": "baseline | deepening",',
    '      "status": "accepted | deferred | missing",',
    '      "coverage": "comprehensive | partial | initial | missing",',
    '      "proposed_path": "architecture/domain/feature/component.md",',
    '      "linked_inventory_ids": ["stable-subsystem-id"],',
    '      "anchor_action": "reuse | update | split | merge | defer | replace | new",',
    '      "anchor_paths": ["architecture/existing/domain/component.md"],',
    '      "anchor_reason": "Evidence-backed reason for changing or reusing the prior doc identity",',
    '      "evidence": ["repo:path"],',
    '      "blindspots": ["explicit blindspot"]',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    architectureDocBlockIntro,
    '',
    '```vibecompass-architecture-doc path=architecture/domain/feature/component.md',
    '<complete markdown file content>',
    '```',
    '',
    'If the complete markdown file content contains its own fenced block, such as `vibecompass-project-map version=1`, use a longer outer fence for the architecture-doc block (for example four backticks) so the inner fence stays inside the document body.',
    '',
    'If the review surfaced accepted decision candidates, output each candidate as a separate block without assigning a D-number:',
    '',
    '```vibecompass-decision-recommendation target=decisions/cross-cutting.md',
    '**Title:** Short decision title',
    '**Decision:** Accepted decision statement to append after local review.',
    '**Rationale:** Why this choice matters.',
    '**Context:** Optional supporting context.',
    '```',
    '',
    finalOutputLine,
  ].join('\n');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
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
