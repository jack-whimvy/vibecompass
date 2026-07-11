import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../cli.js';
import { initializeProjectMemory } from '../init.js';
import {
  SCANNED_UNACCOUNTED_WARNING_CODE,
  SOURCE_INVENTORY_SCANNER_VERSION,
  SOURCE_UNAVAILABLE_WARNING_CODE,
  buildDocsReviewSourceInventory,
  reconcileCoverageWithSourceInventory,
} from '../source-inventory.js';

test('source inventory scans local roots and records deterministic subsystem items', async () => {
  const tempDir = await makeFixtureRoot('source-inventory');
  const rootDir = path.join(tempDir, '.compass');
  const appDir = path.join(tempDir, 'app');
  const sharedDir = path.join(appDir, 'shared-source');
  const outsideDir = path.join(tempDir, 'outside-source');

  try {
    await writeFixtureFiles(appDir, {
      'package.json': '{"scripts":{"dev":"next dev"}}\n',
      'vercel.json': '{"framework":"nextjs"}\n',
      'src/app/page.tsx': 'export default function Home() { return null; }\n',
      'src/app/trips/page.tsx': 'export default function Trips() { return null; }\n',
      'src/app/trips/[tripId]/page.tsx': 'export default function Trip() { return null; }\n',
      'src/app/api/trips/route.ts': 'export async function GET() {}\n',
      'src/app/api/trips/[tripId]/route.ts': 'export async function GET() {}\n',
      'src/app/api/.DS_Store': 'metadata\n',
      'src/app/api/trips/.DS_Store': 'metadata\n',
      'src/app/api/auth/[...nextauth]/route.ts': 'export async function GET() {}\n',
      'src/db/schema.ts': 'export const schema = {};\n',
      'src/jobs/syncTrips.ts': 'export async function syncTrips() {}\n',
      'src/integrations/stripe.ts': 'export const stripe = {};\n',
      'src/auth/session.ts': 'export const session = {};\n',
      'src/config/fonts/categories/condensed.ts': 'export const condensed = [];\n',
      'src/config/fonts/categories/display.ts': 'export const display = [];\n',
      'src/config/fonts/options.ts': 'export const options = [];\n',
      'src/config/themes/dark.ts': 'export const dark = {};\n',
      'src/config/themes/light.ts': 'export const light = {};\n',
      'src/config/i18n/en.ts': 'export const en = {};\n',
      'src/config/i18n/es.ts': 'export const es = {};\n',
      'src/config/tailwind.ts': 'export const tailwind = {};\n',
      'mobile/screens/trips/ListScreen.tsx': 'export function ListScreen() { return null; }\n',
      'mobile/screens/trips/DetailScreen.tsx': 'export function DetailScreen() { return null; }\n',
      'node_modules/pkg/index.ts': 'ignored();\n',
      'public/logo.png': 'not really a png\n',
      'src/fixtures/large.txt': `${'x'.repeat(80)}\n`,
    });
    await writeFixtureFiles(sharedDir, {
      'src/app/reports/page.tsx': 'export default function Reports() { return null; }\n',
    });
    await writeFixtureFiles(outsideDir, {
      'src/app/admin/page.tsx': 'export default function Admin() { return null; }\n',
      'src/integrations/google.ts': 'export const google = {};\n',
    });
    await symlink(sharedDir, path.join(appDir, 'linked-shared'));
    await symlink(path.join(appDir, 'src'), path.join(appDir, 'linked-src'));
    await symlink(outsideDir, path.join(appDir, 'outside-link'));

    const inventory = await buildDocsReviewSourceInventory(
      {
        repos: [
          { id: 'app', source: 'local', path: 'app' },
          { id: 'remote', remote: 'https://github.com/example/remote.git' },
        ],
      },
      {
        rootDir,
        cwd: tempDir,
        maxFileBytes: 64,
        generatedAt: new Date('2026-06-18T08:00:00Z'),
      },
    );

    assert.deepEqual(
      inventory.items.map((item) => item.id),
      [
        'app:api_surface:auth',
        'app:api_surface:trips',
        'app:auth_session:auth-session',
        'app:data_boundary:database-schema',
        'app:integration:stripe',
        'app:job_task:synctrips',
        'app:platform_subsystem:font-configuration',
        'app:platform_subsystem:i18n-configuration',
        'app:platform_subsystem:tailwind',
        'app:platform_subsystem:themes-configuration',
        'app:route_group:reports',
        'app:route_group:root',
        'app:route_group:trips',
        'app:runtime_surface:package-runtime',
        'app:runtime_surface:vercel-runtime',
        'app:screen_group:trips',
      ],
    );
    assert.equal(inventory.summary.item_count, 16);
    assert.equal(inventory.producer.scanner_version, SOURCE_INVENTORY_SCANNER_VERSION);
    const itemsById = new Map(inventory.items.map((item) => [item.id, item]));
    assert.equal(itemsById.get('app:route_group:trips').evidence.length, 2);
    assert.equal(itemsById.get('app:api_surface:trips').evidence.length, 2);
    assert.equal(itemsById.get('app:screen_group:trips').evidence.length, 2);
    assert.equal(itemsById.get('app:platform_subsystem:font-configuration').evidence.length, 3);
    assert.equal(itemsById.get('app:platform_subsystem:themes-configuration').evidence.length, 2);
    assert.equal(itemsById.get('app:platform_subsystem:i18n-configuration').evidence.length, 2);
    assert.equal(itemsById.get('app:platform_subsystem:tailwind').evidence.length, 1);
    assert.ok(!itemsById.has('app:platform_subsystem:condensed'));
    assert.ok(!itemsById.has('app:platform_subsystem:display'));
    assert.ok(!itemsById.has('app:platform_subsystem:options'));
    assert.ok(!itemsById.has('app:platform_subsystem:dark'));
    assert.ok(!itemsById.has('app:platform_subsystem:light'));
    assert.ok(!itemsById.has('app:platform_subsystem:en'));
    assert.ok(!itemsById.has('app:platform_subsystem:es'));
    assert.deepEqual(itemsById.get('app:api_surface:auth').tags, ['auth_session']);
    assert.deepEqual(itemsById.get('app:api_surface:auth').evidence[0].tags, ['auth_session']);
    assert.ok(!itemsById.has('app:api_surface:api'));
    assert.ok(!inventory.items.some((item) => item.evidence.some((entry) => entry.path.includes('.DS_Store'))));
    assert.match(itemsById.get('app:route_group:reports').evidence[0].path, /^app:shared-source\//);
    assert.ok(!itemsById.has('app:route_group:admin'));
    assert.ok(!itemsById.has('app:integration:google'));
    assert.equal(inventory.source_roots[0].status, 'scanned');
    assert.equal(inventory.source_roots[1].status, 'source_unavailable');
    assert.ok(inventory.warnings.some((warning) => warning.code === SOURCE_UNAVAILABLE_WARNING_CODE));
    assert.ok(inventory.warnings.some((warning) => warning.code === 'binary_file_skipped'));
    assert.ok(inventory.warnings.some((warning) => warning.code === 'large_file_skipped'));
    assert.ok(!inventory.warnings.some((warning) => warning.code === 'symlink_skipped' && warning.path === 'linked-src'));
    assert.ok(inventory.warnings.some((warning) => warning.code === 'symlink_escapes_root' && warning.path === 'outside-link'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('source-root overrides scan Git-backed repos and ids distinguish moves from renames', async () => {
  const tempDir = await makeFixtureRoot('source-overrides');
  const rootDir = path.join(tempDir, '.compass');
  const movedRoot = path.join(tempDir, 'moved');
  const renamedRoot = path.join(tempDir, 'renamed');

  try {
    await writeFixtureFiles(path.join(tempDir, 'checkout'), {
      'src/app/billing/page.tsx': 'export default function Billing() { return null; }\n',
    });
    await writeFixtureFiles(movedRoot, {
      'src/app/(account)/billing/page.tsx': 'export default function Billing() { return null; }\n',
    });
    await writeFixtureFiles(renamedRoot, {
      'src/app/payments/page.tsx': 'export default function Payments() { return null; }\n',
    });

    const project = {
      repos: [{ id: 'app', remote: 'https://github.com/example/app.git' }],
    };
    const initial = await buildDocsReviewSourceInventory(project, {
      rootDir,
      cwd: tempDir,
      sourceRootOverrides: [{ repoId: 'app', path: 'checkout' }],
    });
    const moved = await buildDocsReviewSourceInventory(project, {
      rootDir,
      cwd: tempDir,
      sourceRootOverrides: [{ repoId: 'app', path: movedRoot }],
    });
    const renamed = await buildDocsReviewSourceInventory(project, {
      rootDir,
      cwd: tempDir,
      sourceRootOverrides: [{ repoId: 'app', path: renamedRoot }],
    });

    assert.equal(initial.source_roots[0].kind, 'source_root_override');
    assert.deepEqual(initial.items.map((item) => item.id), ['app:route_group:billing']);
    assert.deepEqual(moved.items.map((item) => item.id), ['app:route_group:billing']);
    assert.deepEqual(renamed.items.map((item) => item.id), ['app:route_group:payments']);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('docs-review preflight writes source inventory and apply-output records reconciliation warnings', async () => {
  const tempDir = await makeFixtureRoot('source-cli');
  const rootDir = path.join(tempDir, '.compass');

  try {
    await writeFixtureFiles(path.join(tempDir, 'app'), {
      'src/app/dashboard/page.tsx': 'export default function Dashboard() { return null; }\n',
      'src/app/api/dashboard/route.ts': 'export async function GET() {}\n',
    });
    await initializeProjectMemory({
      cwd: tempDir,
      rootDir,
      name: 'Source CLI',
      mode: 'local-only',
      repos: [{ id: 'app', source: 'local', path: 'app' }],
    });

    const stdout = [];
    await runCli(
      ['docs-review', '--root', rootDir, '--guided', '--llm', 'codex', '--model', 'gpt-5'],
      {
        stdout: { write(chunk) { stdout.push(chunk); } },
        stderr: { write() {} },
      },
      { cwd: tempDir, env: {} },
    );

    const sourceInventory = JSON.parse(await readFile(path.join(rootDir, 'state/docs-review-source-inventory.json'), 'utf8'));
    assert.match(stdout.join(''), /Package Source Inventory/);
    assert.match(stdout.join(''), /Source inventory: 2 items/);
    assert.equal(sourceInventory.summary.item_count, 2);
    assert.equal(sourceInventory.producer.scanner_version, SOURCE_INVENTORY_SCANNER_VERSION);

    await writeFile(
      path.join(rootDir, 'state/docs-review-output.md'),
      [
        '```vibecompass-coverage-plan version=1',
        JSON.stringify({
          summary: 'Partial plan',
          areas: [
            {
              id: 'dashboard-route',
              domain: 'Web',
              feature: 'Dashboard',
              component: 'Route',
              title: 'Dashboard route baseline',
              purpose: 'Explain the dashboard route and its backing API surface.',
              parent: 'Feature inventory',
              run_scope: 'baseline',
              status: 'accepted',
              coverage: 'partial',
              proposed_path: 'architecture/web/dashboard/route.md',
              linked_inventory_ids: ['app:route_group:dashboard'],
              anchor_action: 'new',
            },
          ],
          completeness_inventory: [
            {
              id: 'app:route_group:dashboard',
              status: 'accepted',
              coverage_area_ids: ['dashboard-route'],
            },
          ],
        }),
        '```',
        '',
      ].join('\n'),
      'utf8',
    );

    const applyStderr = [];
    await runCli(
      ['docs-review', '--root', rootDir, '--apply-output'],
      {
        stdout: { write() {} },
        stderr: { write(chunk) { applyStderr.push(chunk); } },
      },
      { cwd: tempDir, env: {} },
    );

    const coverage = JSON.parse(await readFile(path.join(rootDir, 'state/docs-review-coverage.json'), 'utf8'));
    assert.equal(coverage.score_basis, 'model_declared_inventory');
    assert.equal(coverage.producer.scanner_version, SOURCE_INVENTORY_SCANNER_VERSION);
    assert.equal(coverage.producer.parser_version, 'docs-review-parser-v2');
    assert.equal(coverage.producer.coverage_projection_version, 1);
    assert.equal(coverage.source_inventory_summary.item_count, 2);
    assert.equal(coverage.documentation_plan_summary.item_count, 1);
    assert.deepEqual(coverage.documentation_plan_summary.by_run_scope, { baseline: 1 });
    assert.deepEqual(coverage.reconciliation_summary.unaccounted_ids, ['app:api_surface:dashboard']);
    assert.equal(coverage.warnings[0].code, SCANNED_UNACCOUNTED_WARNING_CODE);
    assert.match(applyStderr.join(''), /scanned_unaccounted/);
    const documentationPlan = JSON.parse(await readFile(path.join(rootDir, 'state/docs-review-documentation-plan.json'), 'utf8'));
    assert.equal(documentationPlan.summary.item_count, 1);
    assert.equal(documentationPlan.items[0].title, 'Dashboard route baseline');
    assert.equal(documentationPlan.items[0].target_path, 'architecture/web/dashboard/route.md');
    assert.equal(documentationPlan.items[0].purpose, 'Explain the dashboard route and its backing API surface.');
    assert.deepEqual(documentationPlan.items[0].linked_inventory_ids, ['app:route_group:dashboard']);
    assert.equal(documentationPlan.items[0].run_scope, 'baseline');

    await writeFile(
      path.join(rootDir, 'state/docs-review-output.md'),
      [
        '```vibecompass-coverage-plan version=1',
        JSON.stringify({
          summary: 'Legacy area-only plan',
          areas: [
            {
              id: 'dashboard-route',
              domain: 'Web',
              feature: 'Dashboard',
              component: 'Route',
              status: 'accepted',
              coverage: 'comprehensive',
            },
          ],
        }),
        '```',
        '',
      ].join('\n'),
      'utf8',
    );

    await runCli(
      ['docs-review', '--root', rootDir, '--apply-output'],
      {
        stdout: { write() {} },
        stderr: { write() {} },
      },
      { cwd: tempDir, env: {} },
    );

    const legacyCoverage = JSON.parse(await readFile(path.join(rootDir, 'state/docs-review-coverage.json'), 'utf8'));
    assert.equal(legacyCoverage.score_basis, 'area_statuses');
    assert.equal(legacyCoverage.coverage_score, 1);
    assert.equal(legacyCoverage.producer.scanner_version, SOURCE_INVENTORY_SCANNER_VERSION);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('coverage reconciliation reports scanned and declared inventory deltas', () => {
  const reconciliation = reconcileCoverageWithSourceInventory(
    {
      completeness_inventory: [
        { id: 'app:route_group:dashboard' },
        { id: 'app:api_surface:unknown' },
      ],
    },
    {
      source_roots: [{ repo_id: 'api', status: 'source_unavailable' }],
      items: [
        { id: 'app:route_group:dashboard' },
        { id: 'app:api_surface:dashboard' },
      ],
    },
  );

  assert.equal(reconciliation.scanned_count, 2);
  assert.equal(reconciliation.accounted_count, 1);
  assert.deepEqual(reconciliation.unaccounted_ids, ['app:api_surface:dashboard']);
  assert.deepEqual(reconciliation.unknown_declared_ids, ['app:api_surface:unknown']);
  assert.ok(reconciliation.warnings.some((warning) => warning.code === SCANNED_UNACCOUNTED_WARNING_CODE));
  assert.ok(reconciliation.warnings.some((warning) => warning.code === SOURCE_UNAVAILABLE_WARNING_CODE));
});

async function writeFixtureFiles(rootDir, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(rootDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');
  }
}

async function makeFixtureRoot(label) {
  return mkdtemp(path.join(os.tmpdir(), `vibecompass-${process.pid}-${label}-`));
}
