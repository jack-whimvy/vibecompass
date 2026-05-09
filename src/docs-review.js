import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseSimpleYaml } from './simple-yaml.js';

export async function preflightDocsReview(options = {}, environment = {}) {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const rootDir = path.resolve(cwd, options.rootDir ?? '.compass');
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
  });
  const statePath = path.join(rootDir, 'state', 'docs-review.json');
  const reviewPrompt = renderReviewPrompt({
    project,
    rootDir,
    llm: reviewConfig.llm,
    model: reviewConfig.model,
  });

  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(
    statePath,
    `${JSON.stringify({
      status: 'external-review-requested',
      requested_at: new Date().toISOString(),
      llm: reviewConfig.llm,
      model: reviewConfig.model,
      runtime,
      completed_at: null,
    }, null, 2)}\n`,
    'utf8',
  );

  return {
    rootDir,
    projectFilePath,
    statePath,
    mode: project.mode,
    llm: reviewConfig.llm,
    model: reviewConfig.model,
    runtime,
    status: 'external-review-requested',
    reviewPrompt,
    message:
      'Docs-review preflight passed. Run the generated architecture-review prompt in the selected LLM, then record completion after applying accepted docs changes.',
  };
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
    if (hasHostedBinding) {
      return {
        provider: 'hosted',
        api_url: project.sync.api_url,
        project_id: project.sync.project_id,
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
    };
  }

  throw new Error('docs-review requires project.yaml mode to be local-only, local-primary, or hosted-only.');
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
    '- Evidence standard: cite repo:path files inspected before making implementation claims',
    '- Coverage status: initial/comprehensive/partial plus known blindspots',
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
    '5. Keep architecture docs honest: include confidence/coverage, blindspots, and involved repo:path evidence.',
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
