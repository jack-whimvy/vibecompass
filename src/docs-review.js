import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseSimpleYaml } from './simple-yaml.js';

export async function preflightDocsReview(options = {}, environment = {}) {
  validateDocsReviewMode(options);
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const rootDir = path.resolve(cwd, options.rootDir ?? '.compass');
  const statePath = path.join(rootDir, 'state', 'docs-review.json');

  if (options.complete) {
    return completeDocsReview({
      rootDir,
      statePath,
      llm: options.llm,
      model: options.model,
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
  const anthropicEnvVar = options.anthropicEnvVar ?? 'ANTHROPIC_API_KEY';
  const runtime = resolveDocsReviewRuntime(project, {
    env,
    anthropicEnvVar,
    preferLocalAnthropic: options.runLocalAnthropic,
  });
  const reviewPrompt = renderReviewPrompt({
    project,
    rootDir,
    llm: reviewConfig.llm,
    model: reviewConfig.model,
  });

  const status = options.submitHosted
    ? 'hosted-review-requested'
    : options.runLocalAnthropic
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
      fetch: environment.runtime?.fetch ?? globalThis.fetch,
    })
    : null;
  const localReview = options.runLocalAnthropic
    ? await runLocalAnthropicDocsReview({
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
      ...(localReview?.truncated ? ['Local Anthropic docs-review stopped at max_tokens; saved output may be partial.'] : []),
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
    reviewPrompt: null,
    warnings: [],
    message: 'Docs-review marker completed. Future start-session warnings can treat this root as reviewed.',
  };
}

function validateDocsReviewMode(options) {
  const enabled = [
    options.submitHosted ? '--submit-hosted' : null,
    options.runLocalAnthropic ? '--run-local-anthropic' : null,
    options.complete ? '--complete' : null,
  ].filter(Boolean);

  if (enabled.length > 1) {
    throw new Error(`docs-review accepts only one execution mode at a time. Conflicting flags: ${enabled.join(', ')}.`);
  }
}

async function promptForReviewConfig(options, environment) {
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
  const llm = String(options.llm ?? 'claude').trim();
  if (!llm) {
    throw new Error('docs-review requires a non-empty LLM provider name.');
  }

  const model = String(options.model ?? defaultModelForLlm(llm)).trim();
  if (!model) {
    throw new Error('docs-review requires a non-empty model name.');
  }

  return { llm, model };
}

function resolveDocsReviewRuntime(project, options) {
  const mode = project?.mode;
  const hasLocalKey = typeof options.env?.[options.anthropicEnvVar] === 'string' && options.env[options.anthropicEnvVar].trim() !== '';
  const hasHostedBinding =
    project?.sync &&
    typeof project.sync === 'object' &&
    typeof project.sync.api_url === 'string' &&
    typeof project.sync.project_id === 'string';

  if (mode === 'local-only') {
    if (!hasLocalKey) {
      throw new Error(
        `docs-review for local-only projects requires ${options.anthropicEnvVar}. Set that environment variable or use local-primary/hosted sync.`,
      );
    }

    return {
      provider: 'local-anthropic',
      credential_env_var: options.anthropicEnvVar,
    };
  }

  if (mode === 'local-primary') {
    if (options.preferLocalAnthropic && hasLocalKey) {
      return {
        provider: 'local-anthropic',
        credential_env_var: options.anthropicEnvVar,
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
        provider: 'local-anthropic',
        credential_env_var: options.anthropicEnvVar,
      };
    }

    throw new Error(
      `docs-review for local-primary projects requires a hosted sync binding or ${options.anthropicEnvVar}.`,
    );
  }

  if (mode === 'hosted-only') {
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

async function runLocalAnthropicDocsReview(options) {
  if (options.runtime.provider !== 'local-anthropic') {
    throw new Error('docs-review --run-local-anthropic requires local Anthropic runtime.');
  }

  if (typeof options.fetch !== 'function') {
    throw new Error('docs-review --run-local-anthropic requires a fetch implementation.');
  }

  const credential = normalizeOptionalString(options.env?.[options.runtime.credential_env_var]);
  if (!credential) {
    throw new Error(`docs-review --run-local-anthropic requires ${options.runtime.credential_env_var}.`);
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
    }),
  });

  if (!response.ok) {
    const body = typeof response.text === 'function' ? await response.text() : '';
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
  };
}

async function writeDocsReviewMarker(statePath, marker) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
}

function normalizeOptionalString(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
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

  if (options.runLocalAnthropic) {
    return 'Local Anthropic docs-review completed. Review the generated output, apply accepted docs changes locally, then run docs-review --complete.';
  }

  return 'Docs-review preflight passed. Run the generated architecture-review prompt in the selected LLM, then record completion after applying accepted docs changes.';
}

function renderReviewPrompt(options) {
  const createdAt = new Date().toISOString();

  return [
    'Run a comprehensive VibeCompass architecture documentation review.',
    '',
    'When creating or updating architecture docs, include this metadata sub-header near the top of every generated architecture doc:',
    '',
    '## Review metadata',
    `- Review created at: ${createdAt}`,
    `- Review provider: ${options.llm}`,
    `- Review model/version: ${options.model}`,
    `- Project memory root: ${options.rootDir}`,
    `- Project mode: ${options.project.mode}`,
    '- Confidence: high | medium | low',
    '- Coverage: comprehensive | partial | initial',
    '- Evidence: repo:path references inspected before making implementation claims',
    '- Blindspots: explicit list, or "None identified" only when evidence is comprehensive',
    '',
    `Project memory root: ${options.rootDir}`,
    `Project: ${options.project.name}`,
    `LLM/model recorded for review: ${options.llm} / ${options.model}`,
    '',
    'Instructions:',
    '1. Read project.yaml, context.md if present, and all canonical architecture/decision/session files.',
    '2. Inspect the declared repositories and key source/config/test files before making claims.',
    '3. Do not delete `architecture/overview/project-shape.md`. Add new `architecture/<domain>/<feature>/<component>.md` docs alongside it.',
    '4. Update `architecture/overview/project-shape.md` so its coverage/blindspot sections summarize what has now been mapped.',
    '5. Keep architecture docs honest: use only the exact confidence and coverage enums from Review metadata, include blindspots, and cite involved repo:path evidence.',
    '6. Do not append real D-NNN decisions without explicit user acceptance; propose candidate decisions separately.',
    '7. After accepted docs changes are applied, update state/docs-review.json to status "completed" with completed_at, llm, and model.',
  ].join('\n');
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
