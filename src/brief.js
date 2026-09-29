import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createKeywordIndex, queryTerms } from './brief-keywords.js';
import { renderBrief, renderBriefUnit } from './brief-render.js';
import { collectDeclaredSuccessors, parseDecisionEntries, scanDecisionReferences } from './decision-lineage.js';
import { sha256Text } from './hash.js';
import { resolveLaneMarkerContext, resolveLaneSelection, validateLaneId } from './lane-marker.js';
import { loadProjectReadModelWithDocuments } from './read-model.js';
import { parseSimpleYaml } from './simple-yaml.js';

/**
 * Session brief engine (plan task A3; D-357, D-359). A read-only function from
 * a memory root plus task inputs to a selection result: which memory units a
 * session should read first, packed whole into an estimated token budget,
 * with an honest status and a prioritized follow-up list. It never writes;
 * rendering lives in `brief-render.js` and persistence (lane `brief.md`) is
 * plan task A4. Contract: `architecture/platform/project-memory/session-brief.md`.
 *
 * Relations stay evidence-typed: a doc *covers* a file it lists under
 * Involved files and *cites* a decision it mentions (mechanical); a decision
 * *supersedes* or *amends* another only where its own text declares it
 * (`decision-lineage.md`). Nothing here certifies that a decision governs a
 * doc, file, or task, or that one is currently valid.
 */

export const BRIEF_CONTRACT_VERSION = 1;
export const BRIEF_DEFAULT_BUDGET = 6000;
export const BRIEF_MIN_BUDGET = 800;
export const BRIEF_RESERVE_TOKENS = 600;
export const BRIEF_FOLLOW_UP_CAP = 12;
export const BRIEF_STATUSES = Object.freeze(['complete', 'partial', 'incomplete', 'no-match']);
export const BRIEF_OVERVIEW_PATH = 'architecture/overview/project-shape.md';

// Selection tuning (plan Track A: tunable without amending D-359).
const DOC_FIELDS = {
  title: { weight: 3, b: 0.3 },
  body: { weight: 1, b: 0.75 },
  guidance: { weight: 1.5, b: 0.75 },
};
const MAX_DOC_CANDIDATES = 10;
const MAX_DECISION_CANDIDATES = 14;
// A doc whose mandatory companions would take more than a quarter of the
// unit capacity (and never less than a quarter of the default capacity)
// becomes a follow-up read, so one citation-heavy doc cannot crowd out the
// rest of the brief.
const MAX_COMPANION_SHARE = 0.25;
const MIN_COMPANION_ALLOWANCE = Math.round(MAX_COMPANION_SHARE * (BRIEF_DEFAULT_BUDGET - BRIEF_RESERVE_TOKENS));
const MAX_NOTE_CANDIDATES = 2;
const RELATIVE_SCORE_FLOOR = 0.35;
const MIN_KEYWORD_SCORE = 1.5;
const FILE_MATCH_WEIGHT = 12;
const LANE_DOC_WEIGHT = 14;
const FEATURE_WEIGHT = 4;
const CITATION_WEIGHT = 6;
// Evidence lists and file inventories cite decisions without saying anything about them.
const NON_PROPAGATING_SECTIONS = new Set(['Review metadata', 'Involved files']);
const DISTINCTIVE_TERM_LIMIT = 3;
const DISTINCTIVE_MAX_DOCUMENT_SHARE = 0.02;

/**
 * Builds a session brief selection result. Options: `rootDir` (required),
 * `task`, `files` (`repo:path`), `featureSlugs`, `claims`, `laneId`, and
 * `budget` (estimated tokens, default 6,000, minimum 800). Invalid options
 * throw; retrieval failures return status `incomplete` with a reason.
 */
export async function buildSessionBrief(options = {}) {
  const input = normalizeBriefOptions(options);
  const gaps = [];
  const warnings = [];
  let retrievalError = null;

  let lane = null;
  if (input.laneId) {
    try {
      lane = await readLane(input.rootDir, input.laneId);
    } catch (error) {
      retrievalError = `lane "${input.laneId}" could not be read: ${errorMessage(error)}`;
    }
  }

  const task = input.task || lane?.workingOn || '';
  if (!task && !retrievalError) {
    throw new Error('A brief needs task text: pass a task, or a lane with a recorded working-on summary.');
  }

  let loaded = null;
  if (!retrievalError) {
    try {
      loaded = await loadProjectReadModelWithDocuments(input.rootDir);
    } catch (error) {
      retrievalError = `the read model could not be built: ${errorMessage(error)}`;
    }
  }

  const overviewExists = await pathExists(path.join(input.rootDir, BRIEF_OVERVIEW_PATH));
  if (!overviewExists) {
    gaps.push({
      code: 'missing-overview',
      path: BRIEF_OVERVIEW_PATH,
      message: `No orientation overview at \`${BRIEF_OVERVIEW_PATH}\`; whole-project orientation is not available from memory.`,
    });
  }
  if (lane && !lane.handoffExists) {
    gaps.push({
      code: 'missing-handoff',
      path: lane.handoffPath,
      message: `Lane \`${lane.id}\` has no \`handoff.md\`; its baton-pass state is not recorded.`,
    });
  }

  const context = {
    input: { ...input, task },
    lane,
    gaps,
    warnings,
    overview: { path: BRIEF_OVERVIEW_PATH, exists: overviewExists },
  };

  if (retrievalError) {
    return finalizeRetrievalFailure(context, retrievalError);
  }

  const selection = selectCandidates(context, loaded, task);
  return packBrief(context, selection);
}

/**
 * Sets `budget.estimated_tokens` to the size of the rendered brief, which
 * itself prints that number: iterate to the fixed point.
 */
function measureBrief(result) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const estimate = estimateBriefTokens(renderBrief(result));
    if (estimate === result.budget.estimated_tokens) return;
    result.budget.estimated_tokens = estimate;
  }
}

/** Estimated tokens: Unicode code points ÷ 4, rounded up. */
export function estimateBriefTokens(text) {
  let count = 0;
  for (const _ of String(text ?? '')) count += 1;
  return Math.ceil(count / 4);
}

/**
 * Root and lane resolution for `vibecompass brief`, shared with the other
 * lane-scoped commands and read-only: the root is `--root`, else the nearest
 * worktree lane marker's root, else `cwd/.compass` (D-280); the lane is
 * `--session`, else the marker's lane, else the single active lane, and two
 * or more active lanes without a selection fail closed (D-277, D-353).
 */
export async function resolveBriefRequest(options = {}) {
  const markerContext = await resolveLaneMarkerContext({
    cwd: options.cwd,
    explicitRootDir: options.rootDir ?? null,
    explicitSessionId: options.sessionId ?? null,
  });
  const selection = resolveLaneSelection({
    explicitSessionId: options.sessionId ?? null,
    marker: markerContext.marker,
    laneIds: await listLaneDirs(path.join(markerContext.rootDir, 'sessions', 'active')),
    rootDir: markerContext.rootDir,
    purpose: 'brief',
  });
  return {
    rootDir: markerContext.rootDir,
    laneId: selection.sessionId,
    laneSource: selection.source,
    warnings: [...markerContext.warnings, ...selection.warnings],
  };
}

// ---------------------------------------------------------------------------
// Inputs and retrieval
// ---------------------------------------------------------------------------

function normalizeBriefOptions(options) {
  if (typeof options.rootDir !== 'string' || options.rootDir.trim() === '') {
    throw new Error('A brief needs a project-memory root (rootDir).');
  }

  const budget = options.budget ?? BRIEF_DEFAULT_BUDGET;
  if (!Number.isInteger(budget) || budget < BRIEF_MIN_BUDGET) {
    throw new RangeError(`Brief budget must be a whole number of at least ${BRIEF_MIN_BUDGET} estimated tokens (got ${budget}).`);
  }

  return {
    rootDir: path.resolve(options.rootDir),
    task: typeof options.task === 'string' ? options.task.trim() : '',
    files: uniqueStrings(options.files),
    featureSlugs: uniqueStrings(options.featureSlugs).map((slug) => slug.toLowerCase()),
    claims: uniqueStrings(options.claims),
    laneId: options.laneId ? validateLaneId(String(options.laneId)) : null,
    budget,
  };
}

async function readLane(rootDir, laneId) {
  const activeRoot = path.join(rootDir, 'sessions', 'active');
  const laneDir = path.join(activeRoot, laneId);
  const sessionPath = path.join(laneDir, 'session.yaml');
  const data = parseSimpleYaml(await readFile(sessionPath, 'utf8'), { sourceName: sessionPath });
  if (!data || typeof data !== 'object') {
    throw new Error(`${relativeTo(rootDir, sessionPath)} is empty.`);
  }

  const handoffPath = path.join(laneDir, 'handoff.md');
  const handoff = await readOptional(handoffPath);
  const otherLanes = [];
  for (const otherId of await listLaneDirs(activeRoot)) {
    if (otherId === laneId) continue;
    const otherPath = path.join(activeRoot, otherId, 'session.yaml');
    try {
      const other = parseSimpleYaml(await readFile(otherPath, 'utf8'), { sourceName: otherPath });
      otherLanes.push({
        id: otherId,
        workingOn: optionalString(other?.working_on),
        claims: stringArray(other?.claimed_paths),
        repos: stringArray(other?.repos),
      });
    } catch {
      otherLanes.push({ id: otherId, workingOn: null, claims: [], repos: [], unreadable: true });
    }
  }

  const worktrees = data.worktrees && typeof data.worktrees === 'object' && !Array.isArray(data.worktrees) ? data.worktrees : {};
  const missingWorktrees = [];
  for (const [repoId, worktreePath] of Object.entries(worktrees).sort(([left], [right]) => left.localeCompare(right))) {
    if (typeof worktreePath === 'string' && !(await pathExists(worktreePath))) {
      missingWorktrees.push({ repo: repoId, path: worktreePath });
    }
  }

  return {
    id: laneId,
    sessionPath: relativeTo(rootDir, sessionPath),
    handoffPath: relativeTo(rootDir, handoffPath),
    handoffExists: handoff !== null,
    handoff,
    workingOn: optionalString(data.working_on),
    claims: stringArray(data.claimed_paths),
    featureSlugs: stringArray(data.feature_slugs).map((slug) => slug.toLowerCase()),
    architectureDocs: stringArray(data.architecture_docs),
    repos: stringArray(data.repos),
    decisionSnapshot: Number.isInteger(data.decision_snapshot?.highest_decision_id)
      ? data.decision_snapshot.highest_decision_id
      : null,
    otherLanes,
    missingWorktrees,
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function selectCandidates(context, loaded, task) {
  const { readModel, documents } = loaded;
  const { input, lane } = context;
  const aliases = buildAliasMap(readModel);
  const contentByPath = new Map(documents.map((document) => [document.path, document.content]));
  const relations = readModel.decision_lineage.relations;
  const decisionEntries = buildDecisionEntryMap(documents);

  const docs = readModel.features
    .flatMap((feature) => feature.components.map((component) => ({ feature, component })))
    .filter(({ component }) => component.path !== BRIEF_OVERVIEW_PATH)
    .map(({ feature, component }) => ({
      kind: 'doc',
      id: `doc:${component.path}`,
      path: component.path,
      domain: feature.domain,
      feature: feature.feature,
      featureSlug: feature.feature_slug,
      featureKey: feature.feature_key,
      component: component.component,
      status: component.status,
      // Section text is re-read fence-aware from the canonical file; the read
      // model's own section map lets fenced examples overwrite real sections.
      ...docSectionFields(contentByPath.get(component.path), component),
      involvedFiles: component.involved_files,
      warnings: component.warnings,
      sourceHash: contentByPath.has(component.path) ? sha256Text(contentByPath.get(component.path)) : null,
    }));

  const decisions = readModel.decisions
    .filter((decision) => decisionEntries.has(decision.decision_id))
    .map((decision) => ({
      kind: 'decision',
      id: `decision:${decision.decision_id}`,
      decisionId: decision.decision_id,
      title: decision.title,
      path: decision.path,
      domainFile: decision.domain_file,
      entry: decisionEntries.get(decision.decision_id),
    }));

  const index = createKeywordIndex(DOC_FIELDS, [
    ...docs.map((doc) => ({
      id: doc.id,
      fields: {
        title: `${doc.component} ${doc.feature} ${doc.domain} ${path.basename(doc.path, '.md')}`,
        body: doc.description ?? '',
        guidance: [doc.retrievalGuidance, doc.retrievalScope].filter(Boolean).join('\n'),
      },
    })),
    ...decisions.map((decision) => ({
      id: decision.id,
      fields: { title: decision.title, body: decision.entry.fields.Decision ?? '', guidance: '' },
    })),
  ]);

  // The project's own name carries no topic inside its own memory.
  const projectTerms = new Set(queryTerms(`${readModel.project.name ?? ''} ${readModel.project.slug ?? ''}`));
  // Input file names add topic words: `app:src/lib/entitlements.ts` → "entitlements", "lib".
  const pathWords = [...input.files, ...input.claims, ...(lane?.claims ?? [])].map(pathTopicText).join(' ');
  const terms = uniqueStrings([...queryTerms(task), ...queryTerms(pathWords)]).filter((term) => !projectTerms.has(term));
  const keywordScores = new Map(index.score(terms).map((result) => [result.id, result]));
  const distinctive = pickDistinctiveTerms(terms, index);

  // Mechanical evidence from the inputs: files and claims through the
  // file-owner index, lane-declared architecture docs, feature slugs.
  const pathInputs = [
    ...input.files.map((value) => ({ value, source: 'file' })),
    ...uniqueStrings([...input.claims, ...(lane?.claims ?? [])])
      .filter((value) => !input.files.includes(value))
      .map((value) => ({ value, source: 'claim' })),
  ];
  const ownerCounts = countOwners(docs, pathInputs, aliases);
  const featureSlugs = uniqueStrings([...input.featureSlugs, ...(lane?.featureSlugs ?? [])]);
  const laneDocs = new Set((lane?.architectureDocs ?? []).map((docPath) => docPath.replace(/^docs:/, '')));

  for (const doc of docs) {
    doc.reasons = [];
    doc.relations = [];
    let evidence = 0;

    for (const pathInput of pathInputs) {
      const match = matchPathInput(doc, pathInput.value, aliases);
      if (!match) continue;
      const owners = ownerCounts.get(pathInput.value) ?? 1;
      evidence += (FILE_MATCH_WEIGHT * match.strength) / Math.sqrt(owners);
      const label = pathInput.source === 'claim' ? 'lane claim' : 'file';
      doc.reasons.push(`covers ${label} \`${pathInput.value}\` (Involved files: \`${match.involved}\`)`);
      doc.relations.push({
        relation: 'covers',
        source_kind: 'architecture',
        source_path: doc.path,
        source_section: 'Involved files',
        source_hash: doc.sourceHash,
        evidence: 'explicit',
        basis: match.strength === 1 ? 'involved-file' : 'involved-directory',
        involved_file: match.involved,
        input: pathInput.value,
        input_kind: pathInput.source,
      });
    }

    if (laneDocs.has(doc.path)) {
      evidence += LANE_DOC_WEIGHT;
      doc.reasons.push('declared by the lane (`architecture_docs`)');
    }

    const matchedFeature = featureSlugs.find(
      (slug) => slug === doc.featureSlug || slug === doc.featureKey || slug === `${slugify(doc.domain)}/${doc.featureSlug}`,
    );
    if (matchedFeature) {
      evidence += FEATURE_WEIGHT;
      doc.reasons.push(`feature \`${matchedFeature}\``);
    }

    const keyword = keywordScores.get(doc.id);
    doc.matchedTerms = keyword?.matched ?? [];
    doc.keywordScore = keyword?.score ?? 0;
    doc.evidenceScore = evidence;
    doc.score = evidence + doc.keywordScore;
  }

  const decisionById = new Map(decisions.map((decision) => [decision.decisionId, decision]));
  const namedDecisionIds = new Set(
    scanDecisionReferences(task)
      .refs.map((ref) => ref.id)
      .filter((id) => decisionById.has(id)),
  );

  const topKeyword = Math.max(0, ...[...keywordScores.values()].map((result) => result.score));
  const noMatch =
    docs.every((doc) => doc.evidenceScore === 0) &&
    namedDecisionIds.size === 0 &&
    (terms.length === 0 || distinctiveTermsMostlyAbsent(distinctive, index) || topKeyword < MIN_KEYWORD_SCORE);

  if (noMatch) {
    return { noMatch: true, terms, distinctive, docs: [], namedDecisions: [], rankedDecisions: [], notes: [], relations, decisionById, decisionEntries, readModel };
  }

  // Docs with mechanical evidence (they cover an input file or claim, the lane
  // declares them, or they belong to a named feature) skip the relative floor.
  const selectedDocs = pickTop(
    docs.filter((doc) => doc.evidenceScore > 0 || doc.keywordScore >= MIN_KEYWORD_SCORE),
    MAX_DOC_CANDIDATES,
    (doc) => doc.evidenceScore > 0,
  );
  const topDocScore = Math.max(selectedDocs[0]?.score ?? 0, 1e-9);
  const selectedByPath = new Map(selectedDocs.map((doc) => [doc.path, doc]));

  // Mechanical propagation: each selected doc shares a boost among the
  // decisions it cites, weighted by the doc's relative score and diluted by
  // how many decisions it cites.
  const citedTargets = new Map();
  for (const relation of relations) {
    if (relation.relation !== 'cites' || !relation.target_exists || !selectedByPath.has(relation.source_path)) continue;
    if (NON_PROPAGATING_SECTIONS.has(String(relation.source_section ?? '').split(' > ')[0])) continue;
    if (!citedTargets.has(relation.source_path)) citedTargets.set(relation.source_path, new Map());
    const targets = citedTargets.get(relation.source_path);
    if (!targets.has(relation.target_decision_id)) targets.set(relation.target_decision_id, relation);
  }

  for (const decision of decisions) {
    const keyword = keywordScores.get(decision.id);
    decision.matchedTerms = keyword?.matched ?? [];
    decision.keywordScore = keyword?.score ?? 0;
    decision.citedBy = [];
    decision.citationBoost = 0;
  }
  for (const [docPath, targets] of citedTargets) {
    const doc = selectedByPath.get(docPath);
    const share = (CITATION_WEIGHT * (doc.score / topDocScore)) / Math.sqrt(targets.size);
    for (const [decisionId, relation] of targets) {
      const decision = decisionById.get(decisionId);
      if (!decision) continue;
      decision.citationBoost += share;
      decision.citedBy.push({ relation, docScore: doc.score });
    }
  }
  for (const decision of decisions) {
    decision.score = decision.keywordScore + decision.citationBoost;
    decision.citedBy.sort((left, right) => right.docScore - left.docScore || left.relation.source_path.localeCompare(right.relation.source_path));
    decision.reasons = [];
    if (namedDecisionIds.has(decision.decisionId)) decision.reasons.push('named in the task');
    if (decision.matchedTerms.length > 0) decision.reasons.push(`keywords: ${decision.matchedTerms.join(', ')}`);
    for (const citation of decision.citedBy.slice(0, 2)) {
      decision.reasons.push(`cited by \`${citation.relation.source_path}\` › ${citation.relation.source_section ?? 'preamble'}`);
    }
  }

  const namedDecisions = [...namedDecisionIds].map((id) => decisionById.get(id)).sort((left, right) => right.decisionId - left.decisionId);
  const rankedDecisions = pickTop(
    decisions.filter(
      (decision) =>
        !namedDecisionIds.has(decision.decisionId) &&
        (decision.keywordScore >= MIN_KEYWORD_SCORE || decision.citationBoost > 0),
    ),
    MAX_DECISION_CANDIDATES,
  );

  for (const doc of selectedDocs) {
    if (doc.matchedTerms.length > 0) doc.reasons.push(`keywords: ${doc.matchedTerms.join(', ')}`);
  }

  return {
    noMatch: false,
    terms,
    distinctive,
    docs: selectedDocs,
    namedDecisions,
    rankedDecisions,
    notes: selectNotes(readModel, relations, [...namedDecisions, ...rankedDecisions], documents),
    relations,
    decisionById,
    decisionEntries,
    readModel,
  };
}

/**
 * No-match signal: at least two of the task's most distinctive terms (the
 * rarest in the index, up to three) occur nowhere in the indexed memory, and
 * they are at least two thirds of that set.
 */
function distinctiveTermsMostlyAbsent(distinctive, index) {
  const absent = distinctive.filter((term) => index.documentFrequency(term) === 0).length;
  return absent >= 2 && absent * 3 >= distinctive.length * 2;
}

function pickDistinctiveTerms(terms, index) {
  const limit = Math.min(DISTINCTIVE_TERM_LIMIT, Math.ceil(terms.length / 3));
  return [...terms]
    .filter((term) => index.documentFrequency(term) <= Math.max(1, index.count * DISTINCTIVE_MAX_DOCUMENT_SHARE))
    .sort((left, right) => index.documentFrequency(left) - index.documentFrequency(right) || left.localeCompare(right))
    .slice(0, limit);
}

function pickTop(candidates, limit, bypassFloor = () => false) {
  const sorted = [...candidates].sort(compareByScore);
  const top = sorted[0]?.score ?? 0;
  return sorted.filter((candidate) => bypassFloor(candidate) || candidate.score >= top * RELATIVE_SCORE_FLOOR).slice(0, limit);
}

function compareByScore(left, right) {
  return right.score - left.score || left.id.localeCompare(right.id);
}

function selectNotes(readModel, relations, decisions, documents) {
  const rankById = new Map(decisions.map((decision, rank) => [decision.decisionId, rank]));
  const made = new Map();
  for (const relation of relations) {
    if (relation.relation !== 'made' || !rankById.has(relation.target_decision_id)) continue;
    const rank = rankById.get(relation.target_decision_id);
    const existing = made.get(relation.source_path);
    if (!existing || rank < existing.rank) {
      made.set(relation.source_path, { rank, decisionIds: [...(existing?.decisionIds ?? []), relation.target_decision_id] });
    } else {
      existing.decisionIds.push(relation.target_decision_id);
    }
  }

  const sessions = new Map(readModel.sessions.map((session) => [session.path, session]));
  const contentByPath = new Map(documents.map((document) => [document.path, document.content]));
  return [...made.entries()]
    .filter(([notePath]) => sessions.has(notePath))
    .sort(([leftPath, left], [rightPath, right]) => left.rank - right.rank || rightPath.localeCompare(leftPath))
    .slice(0, MAX_NOTE_CANDIDATES)
    .map(([notePath, info]) => {
      const session = sessions.get(notePath);
      const content = contentByPath.get(notePath) ?? '';
      return {
        kind: 'note',
        id: `note:${notePath}`,
        path: notePath,
        title: session.title,
        date: session.session_date,
        number: session.session_number,
        madeDecisionIds: [...new Set(info.decisionIds)].sort((left, right) => left - right),
        nextSession: extractSection(content, 'Next session should start with'),
        sourceHash: sha256Text(content),
      };
    });
}

// ---------------------------------------------------------------------------
// Units (serialized shape: what `--json` prints and the renderer reads)
// ---------------------------------------------------------------------------

function buildUnits(context, selection) {
  const units = [];
  const { lane, input } = context;

  if (lane) units.push(buildLaneUnit(lane));
  if (selection.noMatch) return units;

  // Mandatory: decisions the task names, with their declared successors.
  for (const decision of selection.namedDecisions) {
    units.push(buildLineageUnit(decision, 'mandatory', selection));
  }

  // Ranked: docs and lineage units interleave by score relative to the top of
  // their kind. A doc carries its mandatory companions — lineage units for the
  // decisions/cross-cutting.md entries its emitted text cites — and is packed
  // only together with them.
  const topDoc = Math.max(selection.docs[0]?.score ?? 0, 1e-9);
  const topDecision = Math.max(selection.rankedDecisions[0]?.score ?? 0, 1e-9);
  const ranked = [
    ...selection.docs.map((doc) => ({ unit: withCompanions(buildDocUnit(doc), selection), relative: doc.score / topDoc })),
    ...selection.rankedDecisions.map((decision) => ({
      unit: buildLineageUnit(decision, 'ranked', selection),
      relative: decision.score / topDecision,
    })),
  ].sort((left, right) => right.relative - left.relative || left.unit.id.localeCompare(right.unit.id));
  for (const [index, entry] of ranked.entries()) {
    units.push({ ...entry.unit, rank: index + 1 });
  }

  for (const note of selection.notes) units.push(buildNoteUnit(note));
  if (lane) units.push(...buildWatchOutUnits(lane, selection, input));
  return units;
}

function withCompanions(docUnit, selection) {
  const shown = scanDecisionReferences(renderBriefUnit(docUnit)).refs.map((ref) => ref.id);
  const companions = [];
  for (const id of [...new Set(shown)].sort((left, right) => right - left)) {
    const decision = selection.decisionById.get(id);
    if (!decision || decision.domainFile !== 'cross-cutting') continue;
    const citation = selection.relations.find(
      (relation) => relation.relation === 'cites' && relation.source_path === docUnit.path && relation.target_decision_id === id,
    );
    companions.push({
      ...buildLineageUnit(decision, 'mandatory', selection),
      id: `lineage:${formatId(id)}`,
      companion_of: docUnit.id,
      reasons: [`cross-cutting; cited by \`${docUnit.path}\`${citation?.source_section ? ` › ${citation.source_section}` : ''}`],
      cited_by: citation ? [citation] : [],
    });
  }
  return { ...docUnit, companions };
}

function buildLaneUnit(lane) {
  const openReview = [
    extractSubsection(lane.handoff, 'Reviewer → Builder', 'Findings summary'),
    extractSubsection(lane.handoff, 'Reviewer → Builder', 'Recommended next step'),
  ].filter(Boolean);
  return {
    id: `lane:${lane.id}`,
    kind: 'lane',
    tier: 'mandatory',
    reasons: ['the brief is for this lane'],
    lane_id: lane.id,
    working_on: lane.workingOn,
    handoff_path: lane.handoffPath,
    handoff_exists: lane.handoffExists,
    handoff_next: extractSubsection(lane.handoff, 'Builder → Reviewer', "What's next"),
    open_review: openReview.length > 0 ? openReview.join('\n') : null,
  };
}

function buildDocUnit(doc) {
  const missingSections = doc.warnings
    .filter((warning) => warning.code === 'architecture-missing-section')
    .map((warning) => warning.message.match(/"## ([^"]+)"/)?.[1])
    .filter(Boolean);
  return {
    id: doc.id,
    kind: 'doc',
    tier: 'ranked',
    reasons: doc.reasons,
    path: doc.path,
    domain: doc.domain,
    feature: doc.feature,
    component: doc.component,
    status: doc.status,
    description: doc.description,
    retrieval_guidance: doc.retrievalGuidance,
    retrieval_scope: doc.retrievalScope,
    missing_sections: missingSections,
    matched_terms: doc.matchedTerms,
    score: round(doc.score),
    source_hash: doc.sourceHash,
    relations: doc.relations,
  };
}

function buildLineageUnit(decision, tier, selection) {
  const successors = collectDeclaredSuccessors(selection.relations, decision.decisionId);
  const chain = [
    { role: 'root', decisionId: decision.decisionId, via: [], successorRelations: [] },
    ...successors.map((successor) => ({
      role: 'successor',
      decisionId: successor.decision_id,
      via: successor.via,
      successorRelations: successor.relations,
    })),
  ];
  const members = chain.map((member) => {
    const entry = selection.decisionEntries.get(member.decisionId);
    const record = selection.decisionById.get(member.decisionId);
    // Show every declared relation from this successor to another member of
    // the unit, not only the one along its `via` path.
    const earlier = new Set(chain.map((entry) => entry.decisionId).filter((id) => id !== member.decisionId));
    const declared =
      member.role === 'successor'
        ? selection.relations.filter(
            (relation) =>
              relation.source_kind === 'decision' &&
              relation.source_decision_id === member.decisionId &&
              (relation.relation === 'supersedes' || relation.relation === 'amends') &&
              earlier.has(relation.target_decision_id),
          )
        : [];
    return {
      role: member.role,
      decision_id: member.decisionId,
      title: record?.title ?? entry?.title ?? null,
      path: entry?.path ?? record?.path ?? null,
      date: entry?.timestamp ? entry.timestamp.slice(0, 10) : null,
      decision: entry?.fields.Decision ?? null,
      impact: entry?.fields['Impact on prior decisions'] ?? entry?.fields.Impact ?? null,
      via: member.via,
      successor_relations: member.successorRelations,
      declared_relations: declared,
      section_hash: entry?.sectionHash ?? null,
    };
  });

  const memberIds = new Set(members.map((member) => member.decision_id));
  const unknownIncoming = selection.relations.filter(
    (relation) =>
      relation.relation === 'unknown' &&
      relation.source_kind === 'decision' &&
      memberIds.has(relation.target_decision_id) &&
      !memberIds.has(relation.source_decision_id),
  );

  return {
    id: `lineage:${formatId(decision.decisionId)}`,
    kind: 'lineage',
    tier,
    reasons: decision.reasons,
    root_decision_id: decision.decisionId,
    members,
    unknown_incoming: unknownIncoming,
    cited_by: (decision.citedBy ?? []).map((citation) => citation.relation),
    matched_terms: decision.matchedTerms,
    score: round(decision.score),
  };
}

function buildNoteUnit(note) {
  return {
    id: note.id,
    kind: 'note',
    tier: 'optional',
    reasons: [`made ${note.madeDecisionIds.map(formatId).join(', ')} (Decisions made)`],
    path: note.path,
    title: note.title,
    date: note.date,
    number: note.number,
    made_decision_ids: note.madeDecisionIds,
    next_session: note.nextSession,
    source_hash: note.sourceHash,
  };
}

function buildWatchOutUnits(lane, selection, input) {
  const units = [];
  const laneClaims = uniqueStrings([...input.claims, ...lane.claims]);

  if (lane.otherLanes.length > 0) {
    units.push({
      id: 'watch-out:other-lanes',
      kind: 'watch-out',
      tier: 'optional',
      reasons: ['other active lanes'],
      category: 'other-lanes',
      snapshot: null,
      items: lane.otherLanes.map((other) => ({
        lane_id: other.id,
        working_on: other.workingOn,
        claims: other.claims,
        overlapping_claims: other.claims.filter((claim) => laneClaims.some((own) => claimsOverlap(own, claim))),
        unreadable: Boolean(other.unreadable),
      })),
    });
  }

  if (lane.decisionSnapshot !== null) {
    const newer = [...selection.decisionById.values()]
      .filter((decision) => decision.decisionId > lane.decisionSnapshot)
      .sort((left, right) => right.decisionId - left.decisionId)
      .map((decision) => ({ decision_id: decision.decisionId, title: decision.title, path: decision.path }));
    if (newer.length > 0) {
      units.push({
        id: 'watch-out:newer-decisions',
        kind: 'watch-out',
        tier: 'optional',
        reasons: [`decisions appended after the lane snapshot ${formatId(lane.decisionSnapshot)}`],
        category: 'newer-decisions',
        snapshot: lane.decisionSnapshot,
        items: newer,
      });
    }
  }

  if (lane.missingWorktrees.length > 0) {
    units.push({
      id: 'watch-out:stale-bindings',
      kind: 'watch-out',
      tier: 'optional',
      reasons: ['recorded lane worktree paths are missing'],
      category: 'stale-bindings',
      snapshot: null,
      items: lane.missingWorktrees,
    });
  }

  return units;
}

// ---------------------------------------------------------------------------
// Packing, status, follow-ups
// ---------------------------------------------------------------------------

function packBrief(context, selection) {
  const units = buildUnits(context, selection);
  const budget = context.input.budget;
  const fits = (candidate) => candidate.budget.estimated_tokens <= budget;

  // Pack whole units in tier order against a unit capacity. The header,
  // status, and follow-up list take about BRIEF_RESERVE_TOKENS; rather than
  // guess, search for the largest capacity whose whole rendered brief fits
  // the budget, repacking from scratch each time so no emitted unit ever
  // loses a successor it was rendered against.
  let result = assemble(context, selection, units, budget);
  if (!fits(result)) {
    let best = null;
    let low = 0;
    let high = budget - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = assemble(context, selection, units, middle);
      if (fits(candidate)) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    result = best ?? assemble(context, selection, units, 0);
  }

  if (!fits(result)) {
    throw new Error(`Brief packing could not fit the ${budget}-token budget (estimated ${result.budget.estimated_tokens}).`);
  }
  assertLineageSafety(result, selection.relations);
  return result;
}

function assemble(context, selection, units, capacity) {
  const emitted = new Set();
  const included = [];
  const omitted = [];
  const covered = [];
  let used = 0;

  for (const { companions = [], ...unit } of units) {
    if (unit.kind === 'lineage' && unit.members.every((member) => emitted.has(member.decision_id))) {
      covered.push(unit.id);
      continue;
    }

    // A doc and its mandatory companions pack atomically; companions already
    // shown by an earlier unit cost nothing.
    const group = [unit];
    const groupEmitted = new Set(emitted);
    let tokens = estimateBriefTokens(renderBriefUnit(unit, { emittedDecisions: groupEmitted }));
    if (unit.kind === 'lineage') for (const member of unit.members) groupEmitted.add(member.decision_id);
    const sizes = [tokens];
    for (const companion of companions) {
      if (companion.members.every((member) => groupEmitted.has(member.decision_id))) continue;
      const size = estimateBriefTokens(renderBriefUnit(companion, { emittedDecisions: groupEmitted }));
      for (const member of companion.members) groupEmitted.add(member.decision_id);
      group.push(companion);
      sizes.push(size);
      tokens += size;
    }

    const companionTokens = tokens - sizes[0];
    const companionAllowance = Math.max(MIN_COMPANION_ALLOWANCE, MAX_COMPANION_SHARE * (context.input.budget - BRIEF_RESERVE_TOKENS));
    const companionsTooHeavy = companionTokens > companionAllowance;
    if (!companionsTooHeavy && used + tokens <= capacity) {
      used += tokens;
      group.forEach((member, index) => included.push({ ...member, estimated_tokens: sizes[index] }));
      for (const id of groupEmitted) emitted.add(id);
    } else {
      omitted.push({
        ...unit,
        estimated_tokens: tokens,
        ...(group.length > 1 ? { companion_ids: group.slice(1).map((member) => member.id) } : {}),
        ...(companionsTooHeavy ? { omitted_reason: 'mandatory companions exceed the per-doc share of the budget' } : {}),
      });
    }
  }

  const status = decideStatus(selection, omitted);
  const result = baseResult(context, selection, {
    status,
    units: included,
    omitted,
    covered,
    followUps: buildFollowUps(included, omitted),
  });
  measureBrief(result);
  return result;
}

function baseResult(context, selection, { status, units, omitted, covered, followUps }) {
  return {
    contract_version: BRIEF_CONTRACT_VERSION,
    status: status.status,
    status_reason: status.reason,
    task: context.input.task,
    inputs: {
      files: context.input.files,
      feature_slugs: context.input.featureSlugs,
      claims: context.input.claims,
      lane_id: context.input.laneId,
    },
    source: {
      root_dir: context.input.rootDir,
      lane_id: context.lane?.id ?? null,
      manifest_hash: selection?.readModel?.manifest_state?.manifest_hash ?? null,
    },
    orientation: context.overview,
    budget: {
      limit: context.input.budget,
      reserve: BRIEF_RESERVE_TOKENS,
      method: 'unicode-code-points/4',
      estimated_tokens: 0,
    },
    selection: {
      query_terms: selection?.terms ?? [],
      distinctive_terms: selection?.distinctive ?? [],
    },
    units,
    omitted,
    covered_by_other_units: covered,
    follow_ups: followUps.map((entry, index) => ({ rank: index + 1, ...entry })),
    follow_up_cap: BRIEF_FOLLOW_UP_CAP,
    gaps: context.gaps,
    warnings: context.warnings,
  };
}

function decideStatus(selection, omitted) {
  if (selection.noMatch) {
    return omitted.some((unit) => unit.kind === 'lane')
      ? { status: 'incomplete', reason: 'no memory matched the task, and the lane unit did not fit the budget' }
      : { status: 'no-match', reason: 'no architecture doc or decision matched the task' };
  }

  const mandatoryOmitted = omitted.filter((unit) => unit.tier === 'mandatory');
  if (mandatoryOmitted.length > 0) {
    return {
      status: 'incomplete',
      reason: `${plural(mandatoryOmitted.length, 'mandatory unit')} did not fit the budget (${mandatoryOmitted.map((unit) => unit.id).join(', ')})`,
    };
  }
  if (omitted.length > 0) {
    return { status: 'partial', reason: `${plural(omitted.length, 'ranked or optional unit')} did not fit the budget` };
  }
  return { status: 'complete', reason: 'every selected unit fits the budget' };
}

function buildFollowUps(included, omitted) {
  const entries = [];

  // Required reads: omitted mandatory units — the lane handoff, then every
  // decision of the omitted lineage units, newest declared successor first.
  const requiredDecisions = [];
  for (const unit of omitted.filter((candidate) => candidate.tier === 'mandatory')) {
    if (unit.kind === 'lane') {
      entries.push({ priority: 'required', path: unit.handoff_path, heading: null, reason: `lane \`${unit.lane_id}\` handoff (the lane unit did not fit)` });
    } else {
      requiredDecisions.push(...lineageReads(unit, 'required'));
    }
  }
  entries.push(...requiredDecisions.sort((left, right) => right.decision_id - left.decision_id));

  for (const unit of omitted.filter((candidate) => candidate.tier === 'ranked')) {
    if (unit.kind === 'doc') {
      entries.push({ priority: 'ranked', path: unit.path, heading: null, reason: shortReason(unit.reasons[0] ?? 'ranked doc') });
    } else {
      entries.push(...lineageReads(unit, 'ranked'));
    }
  }

  // Uncertified lineage wording aimed at an emitted decision: a read, never
  // a status or a relation. Grouped per source file and target decision.
  const unknownGroups = new Map();
  for (const unit of included.filter((candidate) => candidate.kind === 'lineage')) {
    for (const relation of unit.unknown_incoming) {
      const key = `${relation.source_path}\u0000${relation.target_decision_id}`;
      if (!unknownGroups.has(key)) {
        unknownGroups.set(key, { path: relation.source_path, target: relation.target_decision_id, sources: new Set(), cues: new Set() });
      }
      const group = unknownGroups.get(key);
      group.sources.add(relation.source_decision_id);
      group.cues.add(relation.cue);
    }
  }
  for (const group of [...unknownGroups.values()].sort((left, right) => right.target - left.target || left.path.localeCompare(right.path))) {
    const target = formatId(group.target);
    entries.push({
      priority: 'lineage',
      path: group.path,
      heading: [...group.sources].sort((left, right) => right - left).map(formatId).join(', '),
      reason: `uncertified lineage wording (${[...group.cues].sort().join(', ')}) about ${target}; judge it before relying on ${target}`,
    });
  }

  for (const unit of omitted.filter((candidate) => candidate.tier === 'optional')) {
    if (unit.kind === 'note') {
      entries.push({ priority: 'optional', path: unit.path, heading: 'Next session should start with', reason: shortReason(unit.reasons[0]) });
    } else if (unit.kind === 'watch-out') {
      entries.push({ priority: 'optional', path: 'sessions/active/', heading: null, reason: `watch-out: ${unit.reasons[0]}` });
    }
  }

  const seen = new Set();
  return entries.filter((entry) => {
    const key = `${entry.path}\u0000${entry.heading ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function lineageReads(unit, priority) {
  return [...unit.members]
    .sort((left, right) => right.decision_id - left.decision_id)
    .map((member) => ({
      priority,
      decision_id: member.decision_id,
      path: member.path,
      heading: formatId(member.decision_id),
      reason:
        member.role === 'root'
          ? shortReason(unit.reasons[0] ? `${unit.tier}: ${unit.reasons[0]}` : `${unit.tier} decision`)
          : `declared successor of ${formatId(unit.root_decision_id)} (${member.successor_relations.join(', ')})`,
    }));
}

function finalizeRetrievalFailure(context, reason) {
  const units = context.lane ? [buildLaneUnit(context.lane)] : [];
  const included = [];
  const omitted = [];
  let used = 0;
  for (const unit of units) {
    const tokens = estimateBriefTokens(renderBriefUnit(unit, { emittedDecisions: new Set() }));
    if (used + tokens <= context.input.budget - BRIEF_RESERVE_TOKENS) {
      used += tokens;
      included.push({ ...unit, estimated_tokens: tokens });
    } else {
      omitted.push({ ...unit, estimated_tokens: tokens });
    }
  }

  const followUps = [];
  if (context.lane && omitted.length > 0) {
    followUps.push({ priority: 'required', path: context.lane.handoffPath, heading: null, reason: `lane \`${context.lane.id}\` handoff` });
  }
  if (context.overview.exists) {
    followUps.push({ priority: 'required', path: BRIEF_OVERVIEW_PATH, heading: null, reason: 'whole-project orientation' });
  }
  followUps.push({
    priority: 'required',
    path: 'decisions/INDEX.md',
    heading: null,
    reason: "decision index; read each entry's Impact on prior decisions before relying on it",
  });

  const result = baseResult(context, null, {
    status: { status: 'incomplete', reason: `retrieval failed — ${reason}` },
    units: included,
    omitted,
    covered: [],
    followUps,
  });
  measureBrief(result);
  return result;
}

/**
 * D-359 guard, checked independently of how units were built: every emitted
 * decision appears with every declared superseding or amending successor,
 * transitively.
 */
function assertLineageSafety(result, relations) {
  const emitted = new Set();
  for (const unit of result.units) {
    if (unit.kind === 'lineage') for (const member of unit.members) emitted.add(member.decision_id);
  }
  for (const id of emitted) {
    for (const successor of collectDeclaredSuccessors(relations, id)) {
      if (!emitted.has(successor.decision_id)) {
        throw new Error(`Brief lineage guard: ${formatId(id)} would be emitted without its declared successor ${formatId(successor.decision_id)}.`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDecisionEntryMap(documents) {
  const map = new Map();
  for (const document of documents) {
    if (document.kind !== 'decision') continue;
    for (const entry of parseDecisionEntries(document.content)) {
      const fields = {};
      for (const field of entry.fields) {
        if (!(field.name in fields)) fields[field.name] = collapse(field.text);
      }
      map.set(entry.decision_id, {
        decision_id: entry.decision_id,
        title: entry.title,
        path: document.path,
        timestamp: fields.Timestamp ?? null,
        fields,
        sectionHash: sha256Text(entry.text),
      });
    }
  }
  return map;
}

function buildAliasMap(readModel) {
  const aliases = new Map(readModel.repo_aliases);
  for (const repo of readModel.project.repos ?? []) {
    if (typeof repo.path === 'string' && repo.path.trim()) {
      const normalized = repo.path.trim().replace(/^\.\//, '').replace(/\/+$/, '');
      aliases.set(normalized, repo.id);
      aliases.set(normalized.toLowerCase(), repo.id);
    }
  }
  return aliases;
}

/**
 * `{ repo, paths }` for a `repo:path`, `<repo-dir>/path`, or bare path.
 * Involved files often use workspace paths (`vibecompass-app/src/x.ts`), and
 * the read model prefixes a single-repo doc's entries with its repo
 * (`app:vibecompass-app/src/x.ts`), so a leading repo-directory segment is
 * also tried stripped.
 */
function normalizeRepoPath(value, aliases) {
  const trimmed = String(value).trim().replace(/^\.\//, '');
  const prefixed = trimmed.match(/^([^:/\s]+):(.+)$/);
  let repo = null;
  let rest = trimmed;
  if (prefixed) {
    repo = aliases.get(prefixed[1]) ?? aliases.get(prefixed[1].toLowerCase()) ?? prefixed[1];
    rest = prefixed[2];
  }
  const cleaned = rest.replace(/^\.?\/+/, '').replace(/\/+$/, '');
  const paths = [cleaned];
  const slash = cleaned.indexOf('/');
  if (slash > 0) {
    const head = cleaned.slice(0, slash);
    const aliasRepo = aliases.get(head) ?? aliases.get(head.toLowerCase());
    if (aliasRepo && (!repo || repo === aliasRepo)) {
      repo = aliasRepo;
      paths.push(cleaned.slice(slash + 1));
    }
  }
  return { repo, paths: paths.filter(Boolean) };
}

function matchPathInput(doc, value, aliases) {
  const wanted = normalizeRepoPath(value, aliases);
  if (wanted.paths.length === 0) return null;
  let best = null;
  for (const involved of doc.involvedFiles) {
    if (/\s/.test(involved)) continue;
    const owned = normalizeRepoPath(involved, aliases);
    if (wanted.repo && owned.repo && wanted.repo !== owned.repo) continue;
    let strength = 0;
    for (const ownedPath of owned.paths) {
      for (const wantedPath of wanted.paths) {
        if (ownedPath === wantedPath) strength = Math.max(strength, 1);
        else if (wantedPath.startsWith(`${ownedPath}/`) || ownedPath.startsWith(`${wantedPath}/`)) strength = Math.max(strength, 0.5);
      }
    }
    if (strength > (best?.strength ?? 0)) best = { strength, involved };
  }
  return best;
}

function countOwners(docs, pathInputs, aliases) {
  const counts = new Map();
  for (const { value } of pathInputs) {
    counts.set(value, docs.filter((doc) => matchPathInput(doc, value, aliases)).length || 1);
  }
  return counts;
}

/** Basename (without extension) and parent directory of a `repo:path`. */
function pathTopicText(value) {
  const segments = String(value).replace(/^[^:/\s]+:/, '').replace(/\/+$/, '').split('/').filter(Boolean);
  const base = (segments.at(-1) ?? '').replace(/\.[a-z0-9]+$/i, '');
  const parent = segments.at(-2) ?? '';
  return [STRUCTURAL_DIRECTORIES.has(parent.toLowerCase()) ? '' : parent, base].join(' ');
}

const STRUCTURAL_DIRECTORIES = new Set(['src', 'lib', 'app', 'apps', 'packages', 'components', 'utils', 'tests', 'test', 'scripts', 'dist', 'public']);

function claimsOverlap(left, right) {
  const a = stripRepo(left);
  const b = stripRepo(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function stripRepo(value) {
  return String(value).replace(/^[^:/\s]+:/, '').replace(/\/+$/, '');
}

function docSectionFields(content, component) {
  if (typeof content !== 'string') {
    return {
      description: component.description,
      retrievalGuidance: component.retrieval_guidance,
      retrievalScope: component.retrieval_scope,
    };
  }
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
  const sections = splitSections(body, 2);
  return {
    description: sections.get('Description') ?? null,
    retrievalGuidance: sections.get('Retrieval guidance') ?? null,
    retrievalScope: reviewMetadataField(sections.get('Review metadata'), 'Retrieval scope'),
  };
}

/**
 * Level-2 sections of a markdown body, fence-aware: headings inside fenced
 * code are content, and the first section with a given title wins (docs such
 * as `file-schema.md` show example `## Description` blocks in fences).
 */
function splitSections(content, level = 2) {
  const sections = new Map();
  if (!content) return sections;
  const lines = content.split(/\r?\n/);
  const heading = new RegExp(`^#{1,${level}}\\s`);
  const exact = new RegExp(`^#{${level}}\\s+(.+?)\\s*$`);
  let fence = null;
  let current = null;
  for (const line of lines) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
    }
    if (!fence && !marker && heading.test(line)) {
      const match = line.match(exact);
      current = match && !sections.has(match[1]) ? { title: match[1], lines: [] } : null;
      if (current) sections.set(current.title, current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return new Map([...sections].map(([title, section]) => [title, section.lines.join('\n').trim() || null]));
}

/** Body of a level-2 section (`## Title`), trimmed; null when absent. */
export function extractSection(content, title) {
  return splitSections(content, 2).get(title) ?? null;
}

/** Body of `### sub` inside `## section`; null when absent. */
function extractSubsection(content, section, sub) {
  return splitSections(extractSection(content, section), 3).get(sub) ?? null;
}

/** One `- Label: value` bullet from a Review metadata section, continuation lines included. */
function reviewMetadataField(section, label) {
  if (!section) return null;
  const lines = section.split(/\r?\n/);
  const prefix = new RegExp(`^\\s*[-*]\\s+${label}:\\s*`, 'i');
  const start = lines.findIndex((line) => prefix.test(line));
  if (start === -1) return null;
  const parts = [lines[start].replace(prefix, '')];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+\S/.test(line) || /^\s*[-*]\s+/.test(line)) break;
    parts.push(line.trim());
  }
  return parts.join(' ').trim() || null;
}

async function listLaneDirs(activeRoot) {
  try {
    const entries = await readdir(activeRoot, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

async function readOptional(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function relativeTo(rootDir, filePath) {
  return path.relative(rootDir, filePath).split(path.sep).join('/');
}

function uniqueStrings(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value) => typeof value === 'string').map((value) => value.trim()).filter(Boolean))];
}

function stringArray(value) {
  return Array.isArray(value) ? uniqueStrings(value) : [];
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function collapse(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function shortReason(value) {
  const text = collapse(value);
  const points = [...text];
  return points.length <= 110 ? text : `${points.slice(0, 109).join('')}…`;
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function errorMessage(error) {
  return collapse(error instanceof Error ? error.message : String(error)).slice(0, 400);
}

export function formatId(id) {
  return `D-${String(id).padStart(3, '0')}`;
}
