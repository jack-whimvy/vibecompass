import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { stepFence } from './markdown-sections.js';

// D-393's task-ID syntax: capital letters for the track, then a number.
export const PLAN_TASK_ID_PATTERN = /^[A-Z]{1,6}[0-9]{1,3}$/;

// A task line is a top-level item under `## Next steps`: `- [ ] <ID> — <scope>`,
// ticked `- [x] <ID> — <scope>` (D-393). Column 0 only, so nested subtasks
// never count, and bold group labels have no checkbox.
const TASK_LINE_PATTERN = /^- \[( |x)\] ([A-Z]{1,6}[0-9]{1,3}) — (.*)$/;
const LEVEL_TWO_OR_HIGHER_HEADING = /^#{1,2}\s/;
const LEVEL_TWO_HEADING = /^##\s+(.+?)\s*$/;
const NEXT_STEPS_TITLE = 'Next steps';
// The not-found message lists the plan's IDs so a mistyped one is easy to
// spot; a very long plan is cut rather than flooding the terminal.
const LISTED_TASK_ID_LIMIT = 40;

/**
 * Reads D-393 task lines from a plan's markdown. Fence-aware with the rules
 * the read model and the brief use (`markdown-sections.js`): the first
 * `## Next steps` outside a fence is the section, and a heading at level 2 or
 * above outside a fence ends it. Lines inside fenced code are never tasks.
 */
export function parsePlanTaskLines(content) {
  const lines = String(content ?? '').split(/\r?\n/);
  const tasks = [];
  let hasNextSteps = false;
  let inSection = false;
  let fence = null;

  for (const [index, line] of lines.entries()) {
    const step = stepFence(fence, line);
    const fenced = fence !== null || step.delimiter;
    fence = step.fence;
    if (fenced) {
      continue;
    }

    if (LEVEL_TWO_OR_HIGHER_HEADING.test(line)) {
      if (inSection) {
        break;
      }
      if (line.match(LEVEL_TWO_HEADING)?.[1] === NEXT_STEPS_TITLE) {
        hasNextSteps = true;
        inSection = true;
      }
      continue;
    }

    if (!inSection) {
      continue;
    }

    const match = line.match(TASK_LINE_PATTERN);
    if (match) {
      tasks.push({ id: match[2], ticked: match[1] === 'x', scope: match[3], lineNumber: index + 1 });
    }
  }

  return { hasNextSteps, tasks };
}

/**
 * Parses a `--plan-task` value, `<plan-path>#<ID>` (D-395), into its
 * canonical root-relative form. Only the shape is checked here; whether the
 * plan exists and holds the task is `resolvePlanTaskRefs`'s job.
 */
export function parsePlanTaskRef(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    throw new Error('--plan-task needs a reference, "<plan-path>#<ID>" (D-395).');
  }

  const hashIndex = raw.lastIndexOf('#');
  if (hashIndex === -1) {
    throw new Error(
      `--plan-task "${raw}" has no #<ID>. Use "<plan-path>#<ID>", such as "architecture/<domain>/<feature>/<plan>.md#PM3" (D-395).`,
    );
  }

  const rawPath = raw.slice(0, hashIndex).trim();
  const id = raw.slice(hashIndex + 1).trim();
  if (!rawPath) {
    throw new Error(`--plan-task "${raw}" names no plan before #${id}. Use "<plan-path>#<ID>" (D-395).`);
  }
  if (rawPath.startsWith('/') || rawPath.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(rawPath)) {
    throw new Error(
      `--plan-task "${raw}": the plan path must be relative to the project-memory root, such as "architecture/<domain>/<feature>/<plan>.md" (D-395).`,
    );
  }

  const segments = rawPath.replace(/\\/g, '/').split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) {
    throw new Error(`--plan-task "${raw}": the plan path must stay inside the project-memory root; ".." isn't allowed (D-395).`);
  }
  const plan = segments.join('/');
  if (segments[0] !== 'architecture' || segments.length < 2) {
    throw new Error(`--plan-task "${raw}": ${plan} is outside architecture/. A plan is an architecture doc (D-393, D-395).`);
  }
  if (!plan.endsWith('.md')) {
    throw new Error(`--plan-task "${raw}": ${plan} is not a .md file. A plan is an architecture doc (D-393, D-395).`);
  }
  if (!PLAN_TASK_ID_PATTERN.test(id)) {
    throw new Error(
      `--plan-task "${raw}": "${id}" isn't a task ID. An ID is 1–6 capital letters, then 1–3 digits, such as PM3 or DOC2, with no dot, hyphen, space, or lowercase letter (D-393).`,
    );
  }

  return { plan, id, ref: `${plan}#${id}` };
}

/**
 * Splits a stored ref for display and JSON. Readers never fail on a lane's
 * links (D-395): a hand-edited value without `#` keeps its text as the plan
 * and has no id.
 */
export function splitPlanTaskRef(ref) {
  const hashIndex = ref.lastIndexOf('#');
  return hashIndex === -1
    ? { plan: ref, id: null }
    : { plan: ref.slice(0, hashIndex), id: ref.slice(hashIndex + 1) };
}

/** The inverse of `splitPlanTaskRef`: the ref as stored. */
export function formatPlanTaskRef(task) {
  return task.id === null ? task.plan : `${task.plan}#${task.id}`;
}

/**
 * Validates `--plan-task` values against the root before a lifecycle command
 * writes anything (D-395): each plan is an existing `.md` file under
 * `architecture/`, and each ID names a task line in its `## Next steps`. A
 * failure throws with the problem named. A ticked task warns and is kept,
 * since a follow-up lane on a done task is legitimate, and a repeated ref is
 * returned once.
 */
export async function resolvePlanTaskRefs({ rootDir, refs }) {
  const resolved = [];
  const warnings = [];
  const seen = new Set();
  const plans = new Map();

  for (const value of refs ?? []) {
    const { plan, id, ref } = parsePlanTaskRef(value);
    if (seen.has(ref)) {
      continue;
    }
    seen.add(ref);

    if (!plans.has(plan)) {
      plans.set(plan, await readPlanTasks(rootDir, plan, ref));
    }
    const parsed = plans.get(plan);
    if (!parsed.hasNextSteps) {
      throw new Error(`--plan-task "${ref}": ${plan} has no ## Next steps section, so it holds no task lines (D-393).`);
    }

    const matches = parsed.tasks.filter((task) => task.id === id);
    if (matches.length === 0) {
      throw new Error(`--plan-task "${ref}": ${plan} has no task line for ${id} under ## Next steps. ${describeTaskIds(parsed.tasks)}`);
    }
    if (matches.length > 1) {
      warnings.push(
        `--plan-task "${ref}": ${plan} has ${matches.length} task lines for ${id} (lines ${matches.map((task) => task.lineNumber).join(', ')}); an ID is unique within its plan (D-393). The link is kept.`,
      );
    }
    if (matches[0].ticked) {
      warnings.push(`--plan-task "${ref}" names a ticked task: ${id} is marked done in ${plan}. The link is kept, since a follow-up lane on a done task is fine (D-395).`);
    }

    resolved.push({ ref, plan, id, ticked: matches[0].ticked });
  }

  return { tasks: resolved, warnings };
}

async function readPlanTasks(rootDir, plan, ref) {
  const filePath = path.join(rootDir, plan);
  const stats = await stat(filePath).catch((error) => {
    if (error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return null;
    }
    throw error;
  });
  if (!stats) {
    throw new Error(`--plan-task "${ref}": ${plan} doesn't exist in the project-memory root ${rootDir} (D-395).`);
  }
  if (!stats.isFile()) {
    throw new Error(`--plan-task "${ref}": ${plan} is not a file (D-395).`);
  }

  // The lexical check in parsePlanTaskRef can't see symlinks; the plan must
  // really live under the root's architecture/.
  const architectureDir = await realpath(path.join(rootDir, 'architecture'));
  const relative = path.relative(architectureDir, await realpath(filePath));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`--plan-task "${ref}": ${plan} resolves outside the root's architecture/ (D-395).`);
  }

  return parsePlanTaskLines(await readFile(filePath, 'utf8'));
}

function describeTaskIds(tasks) {
  if (tasks.length === 0) {
    return 'It has no task lines: a task line is a top-level `- [ ] <ID> — <scope>` item (D-393).';
  }

  const ids = tasks.map((task) => task.id);
  const listed = ids.slice(0, LISTED_TASK_ID_LIMIT).join(', ');
  return `Its task IDs: ${listed}${ids.length > LISTED_TASK_ID_LIMIT ? `, and ${ids.length - LISTED_TASK_ID_LIMIT} more` : ''}.`;
}
