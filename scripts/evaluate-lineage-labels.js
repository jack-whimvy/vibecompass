#!/usr/bin/env node
// Scores declared decision-lineage extraction against the hand-labeled set in
// canonical memory (plan task A2). Development tool; not shipped in the npm
// package.
//
//   node scripts/evaluate-lineage-labels.js <memory-root> [labels-doc]
//
// <memory-root> is a project-memory root with a decisions/ folder (for
// example ../vibecompass-docs). The labels doc defaults to
// <memory-root>/architecture/platform/project-memory/decision-lineage-labels.md.
// Label tables are read from its "Tuning set" and "Validation set" sections;
// rows whose Wording column is `ambiguous` are excluded from scoring, and a
// source decision listed under a set's "Sources with no declared lineage" line
// still counts toward precision.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { extractDecisionFileRelations } from '../src/decision-lineage.js';

const DECLARED = new Set(['supersedes', 'amends', 'preserves']);
const EXCLUDED_FILES = new Set(['INDEX.md', 'README.md', 'EXAMPLE.md']);

const [rootArg, labelsArg] = process.argv.slice(2);
if (!rootArg) {
  console.error('Usage: node scripts/evaluate-lineage-labels.js <memory-root> [labels-doc]');
  process.exit(2);
}

const root = path.resolve(rootArg);
const labelsPath = path.resolve(labelsArg ?? path.join(root, 'architecture/platform/project-memory/decision-lineage-labels.md'));
const sets = parseLabelSets(await readFile(labelsPath, 'utf8'));
const relations = await extractCorpus(root);

for (const set of sets) {
  report(set, relations);
}

function parseLabelSets(markdown) {
  const result = [];
  let current = null;

  for (const line of markdown.split('\n')) {
    const heading = line.match(/^###\s+(Tuning set|Validation set)\b/);
    if (heading) {
      current = { name: heading[1], labels: [], ambiguous: [], extraSources: [] };
      result.push(current);
      continue;
    }
    if (/^#{2,3}\s/.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;

    const extra = line.match(/^Sources with no declared lineage:\s*(.+)$/);
    if (extra) {
      current.extraSources.push(...[...extra[1].matchAll(/D-(\d{3,})/g)].map((match) => Number(match[1])));
      continue;
    }

    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 7 || !/^D-\d{3,}$/.test(cells[1] ?? '')) continue;
    const row = {
      source: Number(cells[1].slice(2)),
      target: Number(cells[2].slice(2)),
      relation: cells[3],
      extent: cells[4],
      wording: cells[5],
    };
    if (!DECLARED.has(row.relation)) throw new Error(`Unknown relation "${row.relation}" in ${labelsPath}`);
    (row.wording === 'ambiguous' ? current.ambiguous : current.labels).push(row);
  }

  if (result.length === 0) throw new Error(`No "Tuning set" or "Validation set" tables found in ${labelsPath}`);
  return result;
}

async function extractCorpus(rootDir) {
  const decisionsDir = path.join(rootDir, 'decisions');
  const all = [];
  for (const name of (await readdir(decisionsDir)).sort()) {
    if (!name.endsWith('.md') || EXCLUDED_FILES.has(name)) continue;
    const content = await readFile(path.join(decisionsDir, name), 'utf8');
    all.push(...extractDecisionFileRelations({ path: `decisions/${name}`, content }).relations);
  }
  return all;
}

function report(set, allRelations) {
  const key = (source, target, relation) => `D-${pad(source)} → D-${pad(target)} ${relation}`;
  const sources = new Set([...set.labels.map((label) => label.source), ...set.extraSources]);
  const ambiguous = new Set(set.ambiguous.map((label) => key(label.source, label.target, label.relation)));
  const gold = new Map(set.labels.map((label) => [key(label.source, label.target, label.relation), label]));
  const predicted = new Map();

  for (const relation of allRelations) {
    if (!sources.has(relation.source_decision_id) || !DECLARED.has(relation.relation)) continue;
    const id = key(relation.source_decision_id, relation.target_decision_id, relation.relation);
    if (!predicted.has(id)) predicted.set(id, []);
    predicted.get(id).push(relation);
  }

  const scored = [...predicted.keys()].filter((id) => !ambiguous.has(id));
  const truePositives = scored.filter((id) => gold.has(id));
  const falsePositives = scored.filter((id) => !gold.has(id));
  const misses = [...gold.keys()].filter((id) => !predicted.has(id));
  const inVocabulary = set.labels.filter((label) => label.wording === 'in');
  const inVocabularyHits = inVocabulary.filter((label) => predicted.has(key(label.source, label.target, label.relation)));
  const extentMisses = truePositives.filter((id) => !predicted.get(id).some((relation) => relation.extent === gold.get(id).extent));

  console.log(`\n${set.name}: ${sources.size} source decisions, ${set.labels.length} labeled relations (${inVocabulary.length} in-vocabulary), ${set.ambiguous.length} ambiguous (unscored)`);
  console.log(`  precision ${ratio(truePositives.length, scored.length)}`);
  console.log(`  recall    ${ratio(truePositives.length, gold.size)}`);
  console.log(`  in-vocabulary recall ${ratio(inVocabularyHits.length, inVocabulary.length)}`);
  console.log(`  extent agreement on hits ${ratio(truePositives.length - extentMisses.length, truePositives.length)}`);

  console.log('  misses:');
  for (const id of misses) {
    const label = gold.get(id);
    const got = allRelations
      .filter((relation) => relation.source_decision_id === label.source && relation.target_decision_id === label.target)
      .map((relation) => (relation.relation === 'unknown' ? `unknown(${relation.cue})` : relation.relation));
    console.log(`    ${id} [${label.wording}] → extracted: ${[...new Set(got)].join(', ') || 'nothing'}`);
  }
  if (misses.length === 0) console.log('    none');

  console.log('  false positives:');
  for (const id of falsePositives) console.log(`    ${id} — ${predicted.get(id)[0].excerpt}`);
  if (falsePositives.length === 0) console.log('    none');

  console.log('  extent disagreements:');
  for (const id of extentMisses) {
    console.log(`    ${id}: labeled ${gold.get(id).extent}, extracted ${predicted.get(id).map((relation) => relation.extent).join('/')}`);
  }
  if (extentMisses.length === 0) console.log('    none');
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 'n/a' : `${(numerator / denominator).toFixed(3)} (${numerator}/${denominator})`;
}

function pad(id) {
  return String(id).padStart(3, '0');
}
