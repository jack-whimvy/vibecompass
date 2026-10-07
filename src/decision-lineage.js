import { sha256Text } from './hash.js';

/**
 * Typed decision references and declared decision lineage (plan task A2;
 * D-357, D-359, D-363). Contract: `architecture/platform/project-memory/
 * decision-lineage.md`.
 *
 * Relations are typed by evidence strength. Mechanical relations record that
 * a D-number appears in a source (`cites` from architecture docs,
 * `references` from session notes and decision entries, `made` for a note's
 * "Decisions made" listing). Declared relations (`supersedes`, `amends`,
 * `preserves`) come only from a later decision's own wording — its structured
 * lineage fields (D-363) or conservatively parsed prose. Lineage-like wording
 * the parser does not certify becomes `unknown`; a bare mention is only a
 * reference. Nothing here derives "governs" or "currently valid".
 *
 * The extractors are pure (path + content in, relations out) so the app can
 * port them against the shared fixtures in `src/tests/fixtures/decision-lineage/`.
 */

export const DECISION_LINEAGE_CONTRACT_VERSION = 1;
export const DECISION_RELATION_TYPES = Object.freeze([
  'cites',
  'references',
  'made',
  'supersedes',
  'amends',
  'preserves',
  'unknown',
]);
export const DECLARED_LINEAGE_RELATIONS = Object.freeze(['supersedes', 'amends', 'preserves']);

// The claim (field + target span) a prose relation came from; internal,
// never serialized. Coordinated verbs share one span, so one claim.
const CLAIM_OF = new WeakMap();
const RELATION_ORDER = new Map(DECISION_RELATION_TYPES.map((relation, index) => [relation, index]));
const MAX_RANGE_SPAN = 50;
const EXCERPT_LIMIT = 280;
const SCOPE_LIMIT = 200;

// A D-number is `D-` plus digits, not glued to a surrounding word, and not the
// head of a hyphenated identifier such as `D-298-founder-ack`.
const REFERENCE_PATTERN = /(?<![A-Za-z0-9_])D-(\d+)(?![A-Za-z0-9_])(?!-(?!D-\d)[A-Za-z])/g;
const RANGE_TAIL_PATTERN = /^(?:[ \t]*–[ \t]*|-|[ \t]+through[ \t]+)D-(\d+)(?![A-Za-z0-9_])/;
const DECISION_HEADING_PATTERN = /^###[ \t]+D-(\d{3,})\b([^\n]*)$/gm;
const FIELD_LABEL_PATTERN = /^\*\*([^*\n]+?):\*\*[ \t]*/gm;
const FRONTMATTER_PATTERN = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const STRUCTURED_FIELDS = new Map([
  ['supersedes', { relation: 'supersedes', bare: 'full', partial: false }],
  ['partially supersedes', { relation: 'supersedes', bare: 'partial', partial: true }],
  ['amends', { relation: 'amends', bare: 'unqualified', partial: false }],
  ['preserves', { relation: 'preserves', bare: 'unqualified', partial: false }],
]);
const SKIPPED_FIELDS = new Set(['timestamp']);

// Word edges that also refuse hyphen compounds ("structure-preserving",
// "reverse-proxy") so a compound adjective is never read as a lineage verb.
const L = '(?<![\\w-])';
const R = '(?![\\w-])';
const cue = (body) => new RegExp(`${L}${body}${R}`, 'gi');

// Ordered cue table. Overlapping matches resolve to the longer match, so the
// negated and agent forms win over the bare verbs they contain.
const CUE_DEFINITIONS = [
  {
    id: 'agent-passive',
    form: 'agent',
    pattern: cue(
      '(?:(?:is|are|was|were|be|been|being|as)\\s+)?(?:(?:now|also|partially|partly|narrowly|fully|later|since|subsequently|thereby|explicitly)\\s+)*(superseded|amended|refined|narrowed|replaced|overridden|withdrawn)\\s+by(?=\\s+D-\\d)',
    ),
  },
  {
    id: 'negated-verb',
    form: 'object',
    family: 'negated',
    pattern: cue(
      '(?:(?:does|do|did|will|shall|should|must|can|could|would)\\s+)?(?:not|never)\\s+(?:(?:explicitly|materially|otherwise)\\s+)?(?:supersede|supersedes|amend|amends|change|changes|alter|alters|replace|replaces|reverse|reverses|override|overrides|weaken|weakens|waive|waives|affect|affects|modify|modifies|disturb|disturbs)',
    ),
  },
  {
    id: 'without-change',
    form: 'object',
    family: 'negated',
    pattern: cue('without\\s+(?:superseding|amending|changing|altering|replacing|reversing|overriding|weakening|modifying|disturbing|affecting)'),
  },
  { id: 'no-change', form: 'object', family: 'negated', pattern: cue('no\\s+(?:[a-z][\\w-]*\\s+){0,2}changes?\\s+(?:to|in)') },
  {
    id: 'negated-passive',
    form: 'subject',
    family: 'negated',
    pattern: cue(
      '(?:is|are|was|were|be|been)\\s+not\\s+(?:(?:being|partially|fully|otherwise)\\s+)?(?:superseded|amended|changed|altered|replaced|reversed|overridden)',
    ),
  },
  {
    id: 'supersede-passive',
    form: 'subject',
    family: 'supersede',
    pattern: cue(
      '(?:is|are|was|were|be|been|being)\\s+(?:(?:now|also|thereby|hereby|explicitly|hence|therefore|effectively|partially|partly|narrowly|fully)\\s+)*superseded',
    ),
  },
  { id: 'supersede-active', form: 'object', family: 'supersede', pattern: cue('(?:(?:partially|partly|narrowly|fully)\\s+)?(?:supersedes|supersede|superseding)') },
  { id: 'supersession-of', form: 'object', family: 'supersede', pattern: cue('(?:([A-Za-z][\\w-]*)\\s+)?supersession\\s+of') },
  {
    id: 'amend-passive',
    form: 'subject',
    family: 'amend',
    pattern: cue(
      '(?:is|are|was|were|be|been|being)\\s+(?:(?:now|also|thereby|hereby|explicitly|narrowly|partially|partly|comprehensively|further)\\s+)*amended',
    ),
  },
  {
    id: 'amend-active',
    form: 'object',
    family: 'amend',
    pattern: cue('(?:(?:narrowly|partially|partly|comprehensively|fully|further|also)\\s+)?(?:amends|amend|amending)'),
  },
  { id: 'amendment-to', form: 'object', family: 'amend', pattern: cue('amendments?\\s+(?:to|of)') },
  { id: 'preserve-active', form: 'object', family: 'preserve', pattern: cue('(?:preserves|preserve|preserving|keeps|keep|keeping|retains|retain|retaining)') },
  { id: 'leaves', form: 'leaves', family: 'preserve', pattern: cue('(?:leaves|leave|leaving)') },
  {
    id: 'remain-predicate',
    form: 'subject',
    family: 'preserve',
    pattern: cue(
      '(?:remains|remain|remained|stays|stay|stayed)\\s+(?:(?:fully|still|also|otherwise|equally)\\s+)?(?:unchanged|intact|valid|in\\s+force|in\\s+effect|in\\s+place|binding|untouched|authoritative|mandatory|required|governing|applicable)',
    ),
  },
  {
    id: 'governs-predicate',
    form: 'subject',
    family: 'preserve',
    pattern: cue('(?:still\\s+(?:governs|govern|applies|apply|holds|hold|stands|stand)|continues?\\s+to\\s+(?:govern|apply|hold|stand))'),
  },
  { id: 'stands', form: 'subject', family: 'preserve', pattern: /(?<![\w-])(?:stands|stand)(?![\w-])(?=\s*(?:[.;,:)]|$))/gi },
  {
    id: 'is-preserved',
    form: 'subject',
    family: 'preserve',
    pattern: cue(
      '(?:is|are|was|were)\\s+(?:(?:still|also|fully|otherwise|explicitly)\\s+)?(?:preserved|retained|kept|unchanged|untouched|intact|left\\s+(?:intact|untouched|unchanged|in\\s+place))',
    ),
  },
  {
    id: 'lineage-verb',
    form: 'verb',
    family: 'unknown',
    pattern: cue(
      '(?:replaces|replace|replacing|replaced|refines|refine|refining|refined|narrows|narrow|narrowing|narrowed|withdraws|withdraw|withdrawing|withdrawn|overrides|override|overriding|overridden|corrects|correcting|corrected|retires|retire|retiring|retired|reverses|reversing|reversed|revokes|revoke|revoking|revoked|obsoletes|obsoleted|rescinds|rescind|rescinded|invalidates|invalidated|deprecates|deprecated)',
    ),
  },
];

// Object terminators: clause punctuation, subordinating words, a manner
// "by <verb>", and a comma that opens a new verb phrase (", matches the …",
// ", and avoids a …") rather than continuing a list.
const OBJECT_TERMINATOR_PATTERN =
  /(?:[:;]|\s[—–]\s|\s-\s|,?\s+(?:while|whereas|but|except|without|rather\s+than|so\s+that|because|since|although|though|unless|until|with|via|which|whose|instead|in\s+exchange)(?![\w-])|,?\s+by\s+(?!D-\d|this\b)(?=[A-Za-z])|,\s+(?:and\s+)?(?=[a-z][a-z-]*s\s+(?:the|a|an|its|their|this|that|these|those|no|every|all|each|any|[a-z-]+ed|[a-z-]+ing)(?![\w-]))|\s+and\s+(?=[a-z][a-z-]*s\s+(?:(?:the|a|an|its|their|this|that|these|those|no|every|all|each|any)(?![\w-])|D-\d)))/g;
const SUBJECT_BOUNDARY_PATTERN =
  /(?:[:;]|\s[—–]\s|,?\s+(?:but|while|whereas|although|though|because|since|yet|so\s+that|where|when|if|unless|until)\s+)/gi;
const LEAVES_TERMINAL_PATTERN = /(?<![\w-])(?:intact|untouched|unchanged|in\s+place|as\s+is|in\s+force)(?![\w-])/gi;
// Polarity is separate from modality: "cannot preserve" and "D-010 cannot
// remain unchanged" negate a preservation; they are not a requirement.
const NEGATION_WINDOW_PATTERN = /(?<![\w-])(?:not|never|no\s+longer|cannot|[a-z]+n['’]t)\s+(?:[\w-]+\s+)?$/i;
const MODAL_ADVERBS = '(?:(?:not|never|explicitly|also|later|eventually|first|then|each|now|only|still|ever|thereby)\\s+){0,2}';
const HYPOTHETICAL_AUXILIARY_PATTERN = new RegExp(
  `(?<![\\w-])(?:may|might|could|would|can|should|to)\\s+${MODAL_ADVERBS}(?:be\\s+|have\\s+been\\s+)?$`,
  'i',
);
const REQUIREMENT_AUXILIARY_PATTERN = new RegExp(`(?<![\\w-])(?:must|shall|will)\\s+${MODAL_ADVERBS}(?:be\\s+)?$`, 'i');
const HYPOTHETICAL_CUE_PATTERN = /^(?:may|might|could|would|can|should)\s/i;
const REQUIREMENT_CUE_PATTERN = /^(?:must|shall|will)\s/i;
const CONDITIONAL_BEFORE_PATTERN = /(?<![\w-])(?:if|unless|whether|provided\s+that|assuming|in\s+case)(?![\w-])/i;
const CONDITIONAL_OPENING_PATTERN = /^\s*(?:when|whenever|once|until|should|were)(?![\w-])/i;
const CONDITIONAL_AFTER_PATTERN = /(?<![\w-])(?:if|unless|provided\s+that)(?![\w-])/i;
const CONDITIONAL_TAIL_PATTERN = /^\s*,?\s*(?:unless|if|provided\s+that|only\s+if)(?![\w-])/i;
// Verbs that open an implicit-subject sentence in decision prose ("Confirms
// D-246 … and preserves D-004"): IDs after them are their objects and the
// entry is the actor. Closed on purpose — an actor phrase that names another
// decision without one of these openings is left uncertified.
const IMPLICIT_SUBJECT_VERB_PATTERN = new RegExp(
  `^\\s*(?:(?:and|also|then)\\s+)?(?:[a-z]+ly\\s+)?(?:${[
    'adds', 'aligns', 'amends', 'applies', 'avoids', 'builds', 'carries', 'clarifies', 'closes', 'complements',
    'completes', 'confirms', 'corrects', 'covers', 'creates', 'defers', 'delivers', 'documents', 'extends',
    'follows', 'generalizes', 'implements', 'keeps', 'leaves', 'matches', 'moves', 'narrows', 'operationalizes',
    'preserves', 'qualifies', 'reaffirms', 'records', 'reduces', 'refines', 'replaces', 'resolves', 'retains',
    'reuses', 'scopes', 'simplifies', 'supersedes', 'supplies', 'supports', 'treats', 'updates', 'uses',
  ].join('|')})(?![\\w-])`,
  'i',
);
// The shared-actor shape behind the implicit-subject exception: the phrase
// opens with one of those verbs, carries no complement clause of its own
// ("Documents how D-020 supersedes …", "Confirms that D-020 …"), and the cue
// is coordinated with the opening predicate ("… and preserves", "… by
// keeping", "… while preserving", or a "without changing …" phrase).
const COMPLEMENT_CLAUSE_PATTERN = /(?<![\w-])(?:that|how|whether|why|where|when|which|who|whom|whose|what|if)(?![\w-])/i;
const COORDINATED_TAIL_PATTERN = /(?:(?<![\w-])(?:and|or|then|also|by|while)|,)\s*$/i;

function sharesImplicitActor(actorPhrase, current) {
  if (!IMPLICIT_SUBJECT_VERB_PATTERN.test(actorPhrase)) return false;
  const afterOpening = actorPhrase.replace(IMPLICIT_SUBJECT_VERB_PATTERN, '');
  if (COMPLEMENT_CLAUSE_PATTERN.test(afterOpening)) return false;
  return current.id === 'without-change' || COORDINATED_TAIL_PATTERN.test(actorPhrase);
}

const OBJECT_PRONOUN_PATTERN = /^\s*(?:this|that|it|them|these|those|which|what|itself|themselves|such)(?![\w-])/i;
const OBJECT_RELATIONAL_PATTERN =
  /(?<![\w-])(?:separate|separately|apart|distinct|independent|independently|different|differently|unlike|like|consistent|aligned|compatible|comparable|similar|relative|than|alongside|versus|vs)(?![\w-])/i;
const HISTORICAL_RETENTION_PATTERN =
  /(?<![\w-])(?:kept|retained|preserved)\s+(?:only\s+)?(?:for|as)\s+(?:a\s+|the\s+)?historical\s+(?:reference|record|context)(?![\w-])/i;
const FULL_EXTENT_PATTERN = /^(?:in\s+full|entirely|completely|wholly|comprehensively|in\s+(?:its|their)\s+entirety|in\s+whole)(?![\w-])/i;
const PARTIAL_EXTENT_PATTERN = /(?<![\w-])(?:partially|partly|in\s+part)(?![\w-])/i;
const TIGHT_SEPARATOR_PATTERN = /^\s*(?:\/|&|and\/or|and|or|plus)\s*$/i;
const LIST_SEPARATOR_PATTERN = /(?:;\s*(?:and\/or|and|or|plus)?\s*|,\s*(?:and\/or|and|or|plus)?\s*|\s+(?:and\/or|and|or|plus|&)\s+|\/)/gi;
const MADE_NEGATION_PATTERN =
  /(?<![\w-])(?:no\s+new\s+decisions?|no\s+decisions?\s+(?:were\s+|was\s+)?(?:appended|logged|made|recorded)|not\s+(?:yet\s+)?(?:appended|logged|made|recorded))(?![\w-])/i;

// ---------------------------------------------------------------------------
// Public extractors
// ---------------------------------------------------------------------------

/**
 * Finds canonical D-number mentions. Ranges (`D-314–D-317`, `D-124 through
 * D-130`, `D-124-D-130`, at most 50 apart) expand: endpoints stay explicit
 * mentions, interior IDs are inferred by range expansion. Malformed tokens
 * (`D-12`, `D-0070`) are returned separately and never become relations.
 */
export function scanDecisionReferences(text) {
  const refs = [];
  const malformed = [];
  const pattern = new RegExp(REFERENCE_PATTERN.source, 'g');
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const digits = match[1];
    const start = match.index;
    const end = start + match[0].length;

    const id = toDecisionId(digits);
    if (id === null) {
      malformed.push({ token: match[0], start, end });
      continue;
    }

    const tail = RANGE_TAIL_PATTERN.exec(text.slice(end));
    const last = tail ? toDecisionId(tail[1]) : null;
    if (last !== null) {
      const span = last - id;
      if (span > 0 && span <= MAX_RANGE_SPAN) {
        const rangeEnd = end + tail[0].length;
        const range = { start, end: rangeEnd };
        refs.push({ id, start, end, evidence: 'explicit', basis: 'mention', range });
        // Counted loop: bounded by MAX_RANGE_SPAN regardless of ID magnitude.
        for (let offset = 1; offset < span; offset += 1) {
          refs.push({ id: id + offset, start, end: rangeEnd, evidence: 'inferred', basis: 'range-expansion', range });
        }
        refs.push({ id: last, start: rangeEnd - `D-${tail[1]}`.length, end: rangeEnd, evidence: 'explicit', basis: 'mention', range });
        pattern.lastIndex = rangeEnd;
        continue;
      }
    }

    refs.push({ id, start, end, evidence: 'explicit', basis: 'mention' });
  }

  return { refs, malformed };
}

/** Architecture doc → `cites` relations, one per (section, decision). */
export function extractArchitectureDocCitations({ path, content }) {
  return extractMentionRelations({ path, content, sourceKind: 'architecture', relation: 'cites' });
}

/**
 * Session note → `references` for every mention (one per section and
 * decision) plus `made` only for D-numbers that open a top-level bullet under
 * the note's "Decisions made" section.
 */
export function extractSessionNoteRelations({ path, content }) {
  const base = extractMentionRelations({ path, content, sourceKind: 'session', relation: 'references' });
  const made = extractMadeRelations({ path, content, context: base.context });
  return {
    relations: sortRelations([...base.relations, ...made]),
    diagnostics: base.diagnostics,
  };
}

/**
 * Decision domain file → declared lineage (`supersedes` / `amends` /
 * `preserves`), `unknown` lineage-like wording, and `references` for every
 * other mention, per entry.
 */
export function extractDecisionFileRelations({ path, content }) {
  const relations = [];
  const diagnostics = [];
  const sourceHash = sha256Text(content);
  const lineStarts = buildLineStarts(content);

  for (const entry of parseDecisionEntries(content)) {
    const result = extractEntryRelations({ entry, path, content, sourceHash, lineStarts });
    relations.push(...result.relations);
    diagnostics.push(...result.diagnostics);
  }

  return { relations: sortRelations(relations), diagnostics: sortDiagnostics(diagnostics) };
}

/**
 * Builds the corpus-wide lineage view over scanned canonical documents
 * (`{ path, kind, content }`): every relation plus `target_exists`, the
 * diagnostics, and per-relation counts, with `status: 'available'`.
 *
 * D-371: each lineage source is extracted inside its own guard, which holds
 * only that source's pure extraction (entry parse and relation extraction;
 * no I/O). When any source throws, lineage is unavailable as a whole — a
 * missing decision file can hide a declared successor of any decision — so
 * the model carries `status: 'unavailable'`, the failed sources, and their
 * `lineage-extraction-failed` diagnostics, with null relations and counts.
 * Unavailable lineage is never returned as empty lineage.
 */
export function buildDecisionLineageModel(documents) {
  const knownIds = new Set();
  const relations = [];
  const diagnostics = [];
  const failures = [];
  for (const document of documents) {
    if (!LINEAGE_SOURCE_KINDS.has(document.kind)) continue;
    let extracted;
    try {
      extracted = extractLineageSource(document);
    } catch (error) {
      failures.push({ path: document.path, kind: document.kind, error: describeExtractionError(error) });
      continue;
    }
    for (const id of extracted.decisionIds) knownIds.add(id);
    relations.push(...extracted.relations);
    diagnostics.push(...extracted.diagnostics);
  }

  if (failures.length > 0) {
    return buildUnavailableLineageModel(failures);
  }

  const unresolved = new Set();
  const withExistence = relations.map((relation) => {
    const exists = knownIds.has(relation.target_decision_id);
    const key = `${relation.source_path}\u0000${relation.target_decision_id}`;
    if (!exists && !unresolved.has(key)) {
      unresolved.add(key);
      diagnostics.push({
        code: 'unresolved-decision-reference',
        path: relation.source_path,
        line: relation.source_line,
        message: `D-${pad(relation.target_decision_id)} is referenced but no canonical decision entry defines it.`,
      });
    }
    return { ...relation, target_exists: exists };
  });

  const relationCounts = Object.fromEntries(DECISION_RELATION_TYPES.map((relation) => [relation, 0]));
  for (const relation of withExistence) relationCounts[relation.relation] += 1;

  return {
    contract_version: DECISION_LINEAGE_CONTRACT_VERSION,
    status: 'available',
    decision_count: knownIds.size,
    relation_counts: relationCounts,
    relations: sortRelations(withExistence),
    unavailable_sources: [],
    diagnostics: sortDiagnostics(diagnostics),
  };
}

function buildUnavailableLineageModel(failures) {
  const sources = [...failures].sort((left, right) => left.path.localeCompare(right.path));
  return {
    contract_version: DECISION_LINEAGE_CONTRACT_VERSION,
    status: 'unavailable',
    decision_count: null,
    relation_counts: null,
    relations: null,
    unavailable_sources: sources.map(({ path, kind, error }) => ({ path, kind, error })),
    diagnostics: sources.map(({ path, error }) => ({
      code: 'lineage-extraction-failed',
      path,
      line: null,
      message: `Decision lineage could not be extracted from this file (${error}), so lineage is unavailable for the whole root until the file changes or the extractor is fixed.`,
    })),
  };
}

// ---------------------------------------------------------------------------
// Per-source extraction (D-371)
// ---------------------------------------------------------------------------

const LINEAGE_SOURCE_KINDS = new Set(['architecture', 'session', 'decision']);
const EXTRACTION_ERROR_LIMIT = 200;

/** The relations of one canonical document, by kind. */
function extractDocumentRelations({ path, kind, content }) {
  if (kind === 'architecture') return extractArchitectureDocCitations({ path, content });
  if (kind === 'session') return extractSessionNoteRelations({ path, content });
  return extractDecisionFileRelations({ path, content });
}

const DEFAULT_LINEAGE_PHASES = Object.freeze({
  parseEntries: parseDecisionEntries,
  extractRelations: extractDocumentRelations,
});
let lineagePhases = DEFAULT_LINEAGE_PHASES;

/**
 * Internal fault-injection seam for degraded-lineage tests (D-371): replaces
 * the entry-parse and/or relation-extraction phase of per-source extraction
 * and returns a function that restores the previous phases. It is not
 * exported from `index.js`, so the package's `exports` map keeps it out of
 * reach of consumers. Tests restore it in `finally`.
 */
export function setLineagePhasesForTesting(overrides = {}) {
  const previous = lineagePhases;
  lineagePhases = Object.freeze({ ...DEFAULT_LINEAGE_PHASES, ...overrides });
  return () => {
    lineagePhases = previous;
  };
}

// One source's extraction: pure, synchronous, and the only code inside the
// D-371 guard. A decision file contributes its entry IDs (known targets) and
// its relations; a doc or note contributes relations.
function extractLineageSource(document) {
  const decisionIds =
    document.kind === 'decision' ? lineagePhases.parseEntries(document.content).map((entry) => entry.decision_id) : [];
  const result = lineagePhases.extractRelations({ path: document.path, kind: document.kind, content: document.content });
  return { decisionIds, relations: result.relations, diagnostics: result.diagnostics };
}

/**
 * The error class (or a thrown non-Error value's type) and the first line of
 * its message, at most 200 code points; never a stack trace. The source path
 * is recorded separately, so cutting this text never hides which source failed.
 */
function describeExtractionError(error) {
  let text;
  try {
    if (error instanceof Error) {
      const name = typeof error.name === 'string' && error.name ? error.name : 'Error';
      const message = typeof error.message === 'string' ? error.message.split(/\r?\n/, 1)[0].trim() : '';
      text = message ? `${name}: ${message}` : name;
    } else {
      const type = error === null ? 'null' : typeof error;
      const value = typeof error === 'string' ? error.split(/\r?\n/, 1)[0].trim() : '';
      text = value ? `thrown ${type}: ${value}` : `thrown ${type}`;
    }
  } catch {
    text = 'unreadable thrown value';
  }
  return boundText(collapse(text), EXTRACTION_ERROR_LIMIT);
}

/**
 * Declared successors of a decision, transitively: later decisions whose own
 * text (or structured fields) declares `supersedes` or `amends` for it, and
 * their declared successors in turn. Newest first. Never inferred.
 */
export function collectDeclaredSuccessors(relations, decisionId) {
  const incoming = new Map();
  for (const relation of relations) {
    if (relation.source_kind !== 'decision') continue;
    if (relation.relation !== 'supersedes' && relation.relation !== 'amends') continue;
    if (!incoming.has(relation.target_decision_id)) incoming.set(relation.target_decision_id, []);
    incoming.get(relation.target_decision_id).push(relation);
  }

  const successors = new Map();
  const queue = [{ id: decisionId, via: [] }];
  while (queue.length > 0) {
    const { id, via } = queue.shift();
    for (const relation of incoming.get(id) ?? []) {
      const successorId = relation.source_decision_id;
      if (successorId === decisionId) continue;
      const existing = successors.get(successorId);
      if (existing) {
        if (!existing.relations.includes(relation.relation)) existing.relations.push(relation.relation);
        continue;
      }
      const path = [...via, id];
      successors.set(successorId, { decision_id: successorId, relations: [relation.relation], via: path });
      queue.push({ id: successorId, via: path });
    }
  }

  return [...successors.values()]
    .map((successor) => ({ ...successor, relations: successor.relations.sort() }))
    .sort((left, right) => right.decision_id - left.decision_id);
}

/** Splits a decision domain file into entries and labeled fields. */
export function parseDecisionEntries(content) {
  // Headings and field labels inside fenced code are examples, not structure.
  const fenced = findFencedRanges(content);
  const headings = [...content.matchAll(new RegExp(DECISION_HEADING_PATTERN.source, 'gm'))].filter(
    (heading) => !insideRanges(heading.index, fenced) && toDecisionId(heading[1]) !== null,
  );

  return headings.map((heading, index) => {
    const start = heading.index;
    const headingEnd = start + heading[0].length;
    const rawEnd = headings[index + 1]?.index ?? content.length;
    const text = content
      .slice(start, rawEnd)
      .replace(/\s+$/, '')
      .replace(/\n[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/, '')
      .replace(/\s+$/, '');
    const end = start + text.length;
    const titleMatch = heading[2].match(/^\s*(?:[—–-]\s*)?(.*?)\s*$/);
    const title = titleMatch[1];
    const titleStart = headingEnd - heading[2].length + heading[2].indexOf(title);
    const fields = [{ name: 'Title', start: titleStart, text: title }];

    const labels = [...content.slice(headingEnd, end).matchAll(new RegExp(FIELD_LABEL_PATTERN.source, 'gm'))].filter(
      (label) => !insideRanges(headingEnd + label.index, fenced),
    );
    const bodyLead = labels.length > 0 ? labels[0].index : end - headingEnd;
    const leading = content.slice(headingEnd, headingEnd + bodyLead);
    if (leading.trim()) {
      fields.push({ name: 'Body', start: headingEnd, text: leading.replace(/\s+$/, '') });
    }

    labels.forEach((label, labelIndex) => {
      const valueStart = headingEnd + label.index + label[0].length;
      const valueEnd = headingEnd + (labels[labelIndex + 1]?.index ?? end - headingEnd);
      fields.push({
        name: label[1].trim(),
        start: valueStart,
        text: content.slice(valueStart, valueEnd).replace(/\s+$/, ''),
      });
    });

    return {
      decision_id: Number(heading[1]),
      title,
      heading: heading[0].replace(/^###[ \t]+/, '').trim(),
      start,
      end,
      text,
      fields,
    };
  });
}

// ---------------------------------------------------------------------------
// Mentions, sections, and "made"
// ---------------------------------------------------------------------------

function extractMentionRelations({ path, content, sourceKind, relation }) {
  const sourceHash = sha256Text(content);
  const bodyStart = content.match(FRONTMATTER_PATTERN)?.[0].length ?? 0;
  const lineStarts = buildLineStarts(content);
  const sections = buildSectionIndex(content, bodyStart);
  const { refs, malformed } = scanDecisionReferences(content.slice(bodyStart));
  const grouped = new Map();

  for (const ref of refs) {
    const offset = bodyStart + ref.start;
    const section = sectionAt(sections, offset);
    const key = `${section.start ?? -1}\u0000${ref.id}`; // position, so repeated headings stay distinct
    const existing = grouped.get(key);
    if (existing) {
      existing.occurrences += 1;
      if (ref.evidence === 'explicit' && existing.evidence !== 'explicit') {
        existing.evidence = 'explicit';
        existing.basis = 'mention';
        existing.source_line = lineAt(lineStarts, offset);
      }
      continue;
    }

    grouped.set(key, createRelation({
      relation,
      source_kind: sourceKind,
      source_path: path,
      source_section: section.path,
      source_line: lineAt(lineStarts, offset),
      source_hash: sourceHash,
      section_hash: section.hash,
      target_decision_id: ref.id,
      evidence: ref.evidence,
      basis: ref.basis,
    }));
  }

  const diagnostics = malformed.map((token) => ({
    code: 'malformed-decision-reference',
    path,
    line: lineAt(lineStarts, bodyStart + token.start),
    message: `"${token.token}" is not a canonical decision ID (D-NNN, zero-padded to three digits); it was not treated as a reference.`,
  }));

  return {
    relations: sortRelations([...grouped.values()]),
    diagnostics: sortDiagnostics(diagnostics),
    context: { sourceHash, bodyStart, lineStarts, sections },
  };
}

function extractMadeRelations({ path, content, context }) {
  const section = context.sections.headings.find(
    (heading) => heading.level === 2 && /^decisions(?:\s+made)?$/i.test(heading.text),
  );
  if (!section) {
    return [];
  }

  const relations = [];
  const seen = new Set();
  const sectionText = content.slice(section.start, section.end);
  const fenced = findFencedRanges(sectionText);
  const lines = sectionText.split('\n');
  let offset = section.start;
  let item = null;
  const flush = () => {
    if (!item) return;
    collectMadeFromItem({ item, path, context, section, relations, seen });
    item = null;
  };

  for (const [index, line] of lines.entries()) {
    const lineOffset = offset;
    offset += line.length + 1;
    if (index === 0) continue; // the heading line
    if (insideRanges(lineOffset - section.start, fenced)) {
      flush(); // fenced examples never list decisions
      continue;
    }

    const topLevel = line.match(/^[-*+][ \t]+(.*)$/);
    if (topLevel) {
      flush();
      item = { text: topLevel[1], start: lineOffset + line.indexOf(topLevel[1]), firstLine: line };
      continue;
    }

    if (item && /^[ \t]+\S/.test(line) && !/^[ \t]+(?:[-*+]|\d+[.)])[ \t]+/.test(line)) {
      item.text += `\n${line}`;
      continue;
    }

    flush();
  }
  flush();

  return relations;
}

function collectMadeFromItem({ item, path, context, section, relations, seen }) {
  if (MADE_NEGATION_PATTERN.test(item.text)) {
    return;
  }

  for (const segment of splitAtDepthZero(item.text, ';')) {
    const leading = segment.text.match(/^\s*(?:and\s+)?(?:\*\*|__|`)?/)[0].length;
    const body = segment.text.slice(leading);
    const { refs } = scanDecisionReferences(body);
    if (refs.length === 0 || refs[0].start !== 0) {
      continue;
    }

    // Consume the leading ID group: D-refs joined by commas, slashes, "and",
    // "or", or ranges, optionally wrapped in bold/code markers.
    const group = [];
    let cursor = 0;
    for (const ref of refs) {
      if (ref.start < cursor) {
        group.push(ref); // interior or end of a range already consumed
        cursor = Math.max(cursor, ref.end);
        continue;
      }
      const between = body.slice(cursor, ref.start);
      if (group.length > 0 && !/^(?:\*\*|__|`)?\s*(?:,|\/|&|and|or|–|-|through)?\s*(?:\*\*|__|`)?$/i.test(between)) {
        break;
      }
      group.push(ref);
      cursor = ref.end;
    }

    for (const ref of group) {
      if (seen.has(ref.id)) continue;
      seen.add(ref.id);
      const absolute = item.start + segment.start + leading + ref.start;
      relations.push(createRelation({
        relation: 'made',
        source_kind: 'session',
        source_path: path,
        source_section: section.path,
        source_line: lineAt(context.lineStarts, absolute),
        source_hash: context.sourceHash,
        section_hash: section.hash,
        target_decision_id: ref.id,
        evidence: ref.evidence,
        basis: ref.basis === 'range-expansion' ? 'range-expansion' : 'listing',
        excerpt: boundText(item.firstLine.replace(/^[-*+][ \t]+/, ''), EXCERPT_LIMIT),
      }));
    }
  }
}

// ---------------------------------------------------------------------------
// Decision entries
// ---------------------------------------------------------------------------

function extractEntryRelations({ entry, path, content, sourceHash, lineStarts }) {
  const diagnostics = [];
  const sourceId = entry.decision_id;
  const entryHash = sha256Text(entry.text);
  const base = {
    source_kind: 'decision',
    source_path: path,
    source_decision_id: sourceId,
    source_section: entry.heading,
    source_hash: sourceHash,
    section_hash: entryHash,
  };

  const structured = [];
  const prose = [];

  for (const field of entry.fields) {
    const key = field.name.toLowerCase();
    if (SKIPPED_FIELDS.has(key)) continue;

    if (STRUCTURED_FIELDS.has(key)) {
      structured.push(...parseStructuredField({ field, spec: STRUCTURED_FIELDS.get(key), base, lineStarts, diagnostics }));
      continue;
    }

    prose.push(...parseProseField({ field, sourceId, base, lineStarts }));
  }

  // Forward references cannot be lineage in an append-only log.
  const lineage = [];
  for (const relation of [...structured, ...prose]) {
    if (relation.relation !== 'unknown' && relation.target_decision_id >= sourceId) {
      diagnostics.push({
        code: 'lineage-forward-reference',
        path,
        line: relation.source_line,
        decision_id: sourceId,
        message: `D-${pad(sourceId)} declares "${relation.relation}" for later decision D-${pad(relation.target_decision_id)}; recorded as unknown.`,
      });
      const moved = { ...relation, relation: 'unknown', extent: null, scope: null, cue: `forward-reference:${relation.cue}` };
      if (CLAIM_OF.has(relation)) CLAIM_OF.set(moved, CLAIM_OF.get(relation));
      lineage.push(moved);
      continue;
    }
    lineage.push(relation);
  }

  // D-363: a structured field is authoritative for the targets it names;
  // prose `unknown` wording about them is still kept as a follow-up read.
  const structuredTargets = new Map();
  for (const relation of lineage.filter((candidate) => candidate.basis === 'structured-field')) {
    if (!structuredTargets.has(relation.target_decision_id)) structuredTargets.set(relation.target_decision_id, new Set());
    structuredTargets.get(relation.target_decision_id).add(relation.relation);
  }

  const kept = [];
  for (const relation of lineage) {
    const named = structuredTargets.get(relation.target_decision_id);
    if (relation.basis !== 'structured-field' && named && relation.relation !== 'unknown') {
      if (DECLARED_LINEAGE_RELATIONS.includes(relation.relation) && !named.has(relation.relation)) {
        diagnostics.push({
          code: 'lineage-structured-prose-conflict',
          path,
          line: relation.source_line,
          decision_id: sourceId,
          message: `D-${pad(sourceId)} prose reads "${relation.relation}" for D-${pad(relation.target_decision_id)}, which its structured lineage fields do not declare; the structured fields win.`,
        });
      }
      continue;
    }
    kept.push(relation);
  }

  // An `unknown` is dropped only when a certified relation for the same
  // target comes from the same claim — coordinated verbs sharing one object
  // ("partially supersedes and refines D-015"). A change and a preservation
  // with separate objects ("Refines D-010's X while preserving D-010's Y")
  // are independent claims, so the `unknown` stays as a follow-up read.
  const claimTarget = (relation) => `${CLAIM_OF.get(relation) ?? ''}\u0000${relation.target_decision_id}`;
  const certifiedClaims = new Set(
    kept
      .filter((relation) => DECLARED_LINEAGE_RELATIONS.includes(relation.relation) && CLAIM_OF.has(relation))
      .map(claimTarget),
  );
  const unknownSeen = new Set();
  const relations = [];
  for (const relation of kept) {
    if (relation.relation === 'unknown') {
      if (CLAIM_OF.has(relation) && certifiedClaims.has(claimTarget(relation))) continue;
      const key = `${claimTarget(relation)}\u0000${relation.cue}`;
      if (unknownSeen.has(key)) continue;
      unknownSeen.add(key);
    }
    relations.push(relation);
  }

  // Every other mention (quoted, code, restated, or plain) is a reference.
  const linked = new Set(relations.map((relation) => relation.target_decision_id));
  const references = new Map();
  for (const field of entry.fields) {
    const { refs, malformed } = scanDecisionReferences(field.text);
    for (const token of malformed) {
      diagnostics.push({
        code: 'malformed-decision-reference',
        path,
        line: lineAt(lineStarts, field.start + token.start),
        decision_id: sourceId,
        message: `"${token.token}" in D-${pad(sourceId)} is not a canonical decision ID; it was not treated as a reference.`,
      });
    }
    for (const ref of refs) {
      if (ref.id === sourceId || linked.has(ref.id)) continue;
      const existing = references.get(ref.id);
      if (existing) {
        existing.occurrences += 1;
        if (ref.evidence === 'explicit') {
          existing.evidence = 'explicit';
          existing.basis = 'mention';
        }
        continue;
      }
      references.set(ref.id, createRelation({
        ...base,
        relation: 'references',
        source_field: field.name,
        source_line: lineAt(lineStarts, field.start + ref.start),
        target_decision_id: ref.id,
        evidence: ref.evidence,
        basis: ref.basis,
      }));
    }
  }

  return { relations: [...relations, ...references.values()], diagnostics };
}

function parseStructuredField({ field, spec, base, lineStarts, diagnostics }) {
  const value = field.text.trim();
  const relations = [];
  if (/^none\.?$/i.test(value)) {
    return relations;
  }

  const items = splitAtDepthZero(field.text, ';');
  for (const item of items) {
    const raw = item.text;
    if (!raw.trim()) continue;
    const dash = raw.match(/\s+[—–-]\s+(?!D-\d)/);
    const idPart = dash ? raw.slice(0, dash.index) : raw;
    const part = dash ? collapse(raw.slice(dash.index + dash[0].length)).replace(/[.\s]+$/, '') : '';
    const { refs, malformed } = scanDecisionReferences(idPart);
    const leftover = idPart
      .replace(new RegExp(REFERENCE_PATTERN.source, 'g'), ' ')
      .replace(/[,/&–]|\b(?:and|through)\b/gi, ' ')
      .replace(/[`*_.]/g, ' ')
      .trim();
    const line = lineAt(lineStarts, field.start + item.start);

    if (refs.length === 0 || malformed.length > 0 || leftover) {
      diagnostics.push({
        code: 'lineage-field-invalid',
        path: base.source_path,
        line,
        decision_id: base.source_decision_id,
        message: `D-${pad(base.source_decision_id)} "**${field.name}:**" item "${collapse(raw)}" must be decision IDs optionally followed by " — <part>"; it was ignored.`,
      });
      continue;
    }

    const seen = new Set();
    for (const ref of refs) {
      if (seen.has(ref.id) || ref.id === base.source_decision_id) continue;
      seen.add(ref.id);
      relations.push(createRelation({
        ...base,
        relation: spec.relation,
        source_field: field.name,
        source_line: line,
        target_decision_id: ref.id,
        evidence: ref.evidence,
        basis: 'structured-field',
        extent: part ? (spec.partial ? 'partial' : 'scoped') : spec.bare,
        scope: part ? boundText(part, SCOPE_LIMIT) : null,
        cue: field.name.toLowerCase(),
        excerpt: boundText(collapse(raw), EXCERPT_LIMIT),
      }));
    }
  }

  return relations;
}

// ---------------------------------------------------------------------------
// Prose lineage parser
// ---------------------------------------------------------------------------

function parseProseField({ field, sourceId, base, lineStarts }) {
  const original = field.text;
  if (!/D-\d/.test(original)) {
    return []; // no possible target
  }
  const masked = maskForLineage(original);
  const depth = computeParenDepth(masked, original);
  const { refs } = scanDecisionReferences(masked);
  const clauses = splitClauses(masked, depth, original);
  const relations = [];

  for (const [clauseIndex, clause] of clauses.entries()) {
    // A clause without a D-number can only matter as the tail of a
    // semicolon list whose subject is carried back ("…; and X remain intact").
    const clauseText = masked.slice(clause.start, clause.end);
    if (!/D-\d/.test(clauseText) && !/^\s*and\s/i.test(clauseText)) continue;
    const cues = detectCues(masked, clause, depth, sourceId);
    if (cues.length === 0) continue;

    const restatements = cues.filter((entry) => entry.restatement);
    const excludedRefs = new Set();
    for (const restatement of restatements) {
      for (const ref of refs) {
        if (ref.start >= restatement.start && ref.end <= restatement.end) excludedRefs.add(ref);
      }
    }
    const refsIn = (start, end) =>
      refs.filter((ref) => ref.start >= start && ref.end <= end && !excludedRefs.has(ref) && ref.id !== sourceId);

    const spans = new Map();
    for (const current of cues) {
      if (current.restatement) continue;
      const qualifier = objectSpan(current, clause, masked, depth, cues);
      spans.set(current, qualifier);
    }

    // Coordinated verbs ("partially supersedes and refines D-015") share the
    // next verb's object when their own object is only a conjunction.
    const ordered = cues.filter((entry) => !entry.restatement);
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const current = ordered[index];
      if (current.form === 'subject') continue;
      const span = spans.get(current);
      const next = ordered[index + 1];
      // Judge by the text between the two verbs, not by where this verb's own
      // object stopped (a terminator may already have cut it at " and").
      const between = next ? masked.slice(span.start, next.start) : null;
      if (next && next.form !== 'subject' && next.start >= span.start && /^\s*(?:and\/or|and|or|\/|,)?\s*$/i.test(between)) {
        spans.set(current, { ...spans.get(next), shared: true });
      }
    }

    let previousEnd = clause.start;
    for (const current of ordered) {
      const span = spans.get(current);
      let targetSpan;
      let qualifier = null;

      if (current.form === 'subject' || (current.form === 'verb' && current.passive) || current.form === 'agent-self') {
        const subjectStart = subjectBoundary(current, clause, masked, depth, previousEnd, clauses, clauseIndex, cues, sourceId);
        targetSpan = { start: subjectStart, end: current.start };
        qualifier = span;
      } else if (current.form === 'leaves') {
        const terminal = findLeavesTerminal(current, span, masked, depth);
        if (!terminal) {
          previousEnd = Math.max(previousEnd, current.end);
          continue;
        }
        targetSpan = { start: current.end, end: terminal };
      } else {
        targetSpan = span;
      }

      const actorStart = previousEnd;
      previousEnd = Math.max(previousEnd, span.shared ? current.end : span.end);
      const targets = refsIn(targetSpan.start, targetSpan.end);
      if (targets.length === 0) continue;

      const objectForm = !(current.form === 'subject' || (current.form === 'verb' && current.passive) || current.form === 'agent-self');
      if (objectForm) {
        // The actor is the phrase before the verb, after any introductory
        // prose ending in a comma ("According to D-020, D-020 supersedes …").
        // If it names another decision ("D-020 supersedes D-010", "As D-020
        // supersedes D-010, …"), the claim is that decision's, restated here,
        // or its actor is uncertain: never certified. Targets stay references.
        const actorFrom = subjectBoundary(current, clause, masked, depth, actorStart, clauses, clauseIndex, cues, sourceId);
        let phraseFrom = actorFrom;
        for (let index = current.start - 1; index >= actorFrom; index -= 1) {
          if (masked[index] === ',' && depth[index] === current.depth) {
            phraseFrom = index + 1;
            break;
          }
        }
        const actorPhrase = masked.slice(phraseFrom, current.start);
        if (scanDecisionReferences(actorPhrase).refs.some((ref) => ref.id !== sourceId) && !sharesImplicitActor(actorPhrase, current)) {
          continue;
        }
        // The object must name the decision or a part of it, not a contrast or
        // comparison around it ("Keeping this separate from D-169 …").
        const lead = masked.slice(targetSpan.start, Math.min(...targets.map((target) => target.start)));
        if (OBJECT_PRONOUN_PATTERN.test(lead) || OBJECT_RELATIONAL_PATTERN.test(lead)) continue;
      }

      const classification = classifyCue(current, masked, clause, Math.max(span.end, targetSpan.end));
      if (!classification) continue;

      const excerptStart = Math.min(clause.start, targetSpan.start);
      const excerpt = boundText(collapse(original.slice(excerptStart, clause.end)), EXCERPT_LIMIT);
      const scopes = computeScopes({
        targets,
        span: targetSpan,
        masked,
        original,
        restatements,
        qualifier: qualifier ? { start: qualifier.start, end: qualifier.end } : null,
      });
      const clauseAfterCue = masked.slice(current.end, clause.end);

      const emitted = new Set();
      for (const target of targets) {
        if (emitted.has(target.id)) continue;
        emitted.add(target.id);
        const scopeInfo = scopes.get(target);
        const extent =
          classification.relation === 'unknown'
            ? null
            : resolveExtent({ classification, scopeInfo, clauseAfterCue, current });
        const relation = createRelation({
          ...base,
          relation: classification.relation,
          source_field: field.name,
          source_line: lineAt(lineStarts, field.start + target.start),
          target_decision_id: target.id,
          evidence: target.evidence,
          basis: 'prose',
          extent,
          scope: extent === 'scoped' || extent === 'partial' ? scopeInfo.text : null,
          cue: classification.cue,
          excerpt,
        });
        CLAIM_OF.set(relation, `${field.name}\u0000${targetSpan.start}:${targetSpan.end}`);
        relations.push(relation);
      }
    }
  }

  return relations;
}

function detectCues(masked, clause, depth, sourceId) {
  const text = masked.slice(clause.start, clause.end);
  const found = [];

  for (const definition of CUE_DEFINITIONS) {
    const pattern = definition.pattern; // compiled once; global, so reset
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      found.push({
        definition,
        id: definition.id,
        form: definition.form,
        family: definition.family,
        start: clause.start + match.index,
        end: clause.start + match.index + match[0].length,
        text: match[0],
        modifier: match[1] ?? null,
      });
    }
  }

  found.sort((left, right) => left.start - right.start || right.end - right.start - (left.end - left.start));
  const resolved = [];
  for (const candidate of found) {
    const previous = resolved[resolved.length - 1];
    if (previous && candidate.start < previous.end) {
      if (candidate.end - candidate.start > previous.end - previous.start) resolved[resolved.length - 1] = candidate;
      continue;
    }
    resolved.push(candidate);
  }

  for (const current of resolved) {
    current.depth = depth[current.start];
    if (current.form === 'agent') {
      const agent = readAgentRefs(masked, current.end);
      current.agentIds = agent.ids;
      current.agentEnd = agent.end;
      const verb = current.text.match(/(superseded|amended|refined|narrowed|replaced|overridden|withdrawn)\s+by$/i)?.[1].toLowerCase();
      current.verb = verb;
      current.end = agent.end;
      if (agent.ids.length > 0 && agent.ids.every((id) => id === sourceId)) {
        current.form = 'agent-self';
      } else {
        current.restatement = true;
      }
    }
    if (current.form === 'verb') {
      const before = masked.slice(clause.start, current.start);
      current.passive = /(?:ed|en|drawn)$/i.test(current.text) && /(?<![\w-])(?:is|are|was|were|be|been|being)\s+(?:[\w-]+ly\s+)?$/i.test(before);
    }
  }

  return resolved;
}

function readAgentRefs(masked, from) {
  const tail = masked.slice(from);
  // Agents joined by "/" or a bare "and"; ", and D-…" continues the enclosing list.
  const match = tail.match(/^\s+(D-\d+(?:(?:\s*\/\s*|\s+and\s+)D-\d+)*)/);
  if (!match) return { ids: [], end: from };
  const ids = [...match[1].matchAll(/D-(\d+)/g)].map((entry) => Number(entry[1]));
  return { ids, end: from + match[0].length };
}

// Modality decides what a cue may certify. Hypothetical wording (may, might,
// could, would, can, should, to, or a conditional) certifies nothing. A
// requirement (must, shall, will) certifies preservation — the entry requires
// the earlier rule to hold — but not a supersession or amendment, which would
// be a future act. Negation (not, never, cannot, …) is polarity, handled in
// classifyCue.
function cueModality(current, masked, clause, spanEnd) {
  const before = masked.slice(clause.start, current.start);
  // A trailing condition only counts inside the cue's own object or qualifier
  // ("supersedes D-010 if approved"), not in a later coordinated verb phrase.
  const after = masked.slice(current.end, spanEnd ?? clause.end);
  // …or opening the text right after it, where the object boundary stopped
  // ("supersedes D-010 unless the proposal is rejected").
  const tail = masked.slice(spanEnd ?? clause.end, clause.end);
  if (
    CONDITIONAL_TAIL_PATTERN.test(tail) ||
    CONDITIONAL_BEFORE_PATTERN.test(before) ||
    CONDITIONAL_OPENING_PATTERN.test(before) ||
    CONDITIONAL_AFTER_PATTERN.test(after) ||
    HYPOTHETICAL_AUXILIARY_PATTERN.test(before) ||
    HYPOTHETICAL_CUE_PATTERN.test(current.text)
  ) {
    return 'hypothetical';
  }
  if (REQUIREMENT_AUXILIARY_PATTERN.test(before) || REQUIREMENT_CUE_PATTERN.test(current.text)) {
    return 'requirement';
  }
  return 'asserted';
}

function classifyCue(current, masked, clause, spanEnd) {
  const before = masked.slice(clause.start, current.start);
  const negatedWindow = NEGATION_WINDOW_PATTERN.test(before);
  const modality = cueModality(current, masked, clause, spanEnd);
  const verb = normalizeCueVerb(current);
  const uncertified = (prefix) => ({ relation: 'unknown', cue: `${prefix}:${verb}` });

  if (current.family === 'negated') {
    return modality === 'hypothetical' ? uncertified('modal') : { relation: 'preserves', cue: verb };
  }

  if (current.form === 'agent-self') {
    const relation = current.verb === 'superseded' ? 'supersedes' : current.verb === 'amended' ? 'amends' : 'unknown';
    if (relation === 'unknown') return { relation, cue: verb };
    // Same polarity as the active form: "D-010 cannot be superseded by
    // D-030" is prohibited change, so preservation, never a successor.
    if (negatedWindow) return modality === 'hypothetical' ? uncertified('modal') : { relation: 'preserves', cue: `negated:${verb}` };
    if (modality !== 'asserted') return uncertified('modal');
    return { relation, cue: verb };
  }

  if (current.family === 'supersede' || current.family === 'amend') {
    const relation = current.family === 'supersede' ? 'supersedes' : 'amends';
    if (negatedWindow) return modality === 'hypothetical' ? uncertified('modal') : { relation: 'preserves', cue: `negated:${verb}` };
    if (modality !== 'asserted') return uncertified('modal');
    return { relation, cue: verb };
  }

  if (current.family === 'preserve') {
    if (negatedWindow) return uncertified('negated');
    if (modality === 'hypothetical') return uncertified('modal');
    return { relation: 'preserves', cue: verb };
  }

  if (current.family === 'unknown') {
    return modality === 'asserted' ? { relation: 'unknown', cue: verb } : uncertified('modal');
  }

  return null;
}

function normalizeCueVerb(current) {
  return collapse(current.text).toLowerCase();
}

function objectSpan(current, clause, masked, depth, cues) {
  const level = current.depth;
  let stop = clause.end;

  for (const other of cues) {
    if (other === current || other.restatement) continue;
    if (other.start >= current.end && other.start < stop && depth[other.start] === level) {
      stop = other.start;
      break;
    }
  }

  for (let index = current.end; index < stop; index += 1) {
    if (depth[index] < level) {
      stop = index > current.end && masked[index - 1] === ')' ? index - 1 : index;
      break;
    }
  }

  // Match against the rest of the clause so a terminator's lookahead can see
  // past the next cue ("… and D-125 by keeping …"); accept only matches that
  // start before the stop.
  const terminator = new RegExp(OBJECT_TERMINATOR_PATTERN.source, 'gi');
  const window = masked.slice(current.end, clause.end);
  let match;
  while ((match = terminator.exec(window)) !== null) {
    const at = current.end + match.index;
    if (at >= stop) break;
    if (depth[at] !== level) continue;
    if (insideRestatement(at, cues)) continue;
    stop = at;
    break;
  }

  return { start: current.end, end: stop };
}

function insideRestatement(offset, cues) {
  return cues.some((entry) => entry.restatement && offset >= entry.start && offset < entry.end);
}

function subjectBoundary(current, clause, masked, depth, previousEnd, clauses, clauseIndex, cues, sourceId) {
  const level = current.depth;
  let start = Math.max(clause.start, previousEnd);

  for (let index = current.start - 1; index >= start; index -= 1) {
    if (depth[index] < level) {
      start = index + 1;
      break;
    }
  }

  const boundary = new RegExp(SUBJECT_BOUNDARY_PATTERN.source, 'gi');
  const window = masked.slice(start, current.start);
  let match;
  let cut = start;
  while ((match = boundary.exec(window)) !== null) {
    const at = start + match.index;
    if (depth[at] !== level || insideRestatement(at, cues)) continue;
    cut = at + match[0].length;
  }

  // A list whose last item opens with "and" after semicolons ("D-300's …;
  // D-301's …; and D-305's … remain intact") carries its subject back across
  // the earlier cue-free list items.
  if (cut === clause.start && /^\s*and\s/i.test(masked.slice(clause.start, clause.end))) {
    let walk = clauseIndex - 1;
    while (walk >= 0) {
      const previous = clauses[walk];
      const separator = masked.slice(previous.end, previous.end + 1);
      if (separator !== ';' || detectCues(masked, previous, depth, sourceId).length > 0) break;
      cut = previous.start;
      walk -= 1;
    }
  }

  return cut;
}

function findLeavesTerminal(current, span, masked, depth) {
  const pattern = new RegExp(LEAVES_TERMINAL_PATTERN.source, 'gi');
  const window = masked.slice(current.end, span.end + 40);
  let match;
  while ((match = pattern.exec(window)) !== null) {
    const at = current.end + match.index;
    if (at > span.end + 1) break;
    if (depth[at] === current.depth) return at;
  }
  return null;
}

// Scope: each target's own prefix/suffix inside the target span, with tightly
// coordinated targets ("D-138's and D-194's …", "D-225/D-226", "D-191 and
// D-193 …") sharing one scope. Parenthetical glosses are not scope.
function computeScopes({ targets, span, masked, original, restatements, qualifier }) {
  // One unit per distinct target; a range (D-314–D-317) is a single unit
  // whose members share its scope.
  const unique = [];
  const seen = new Set();
  const members = new Map();
  for (const target of targets) {
    if (seen.has(target.id)) continue;
    seen.add(target.id);
    const unitKey = target.range ? `range:${target.range.start}` : `id:${target.id}`;
    if (!members.has(unitKey)) {
      members.set(unitKey, []);
      unique.push(target.range ? { ...target, id: unitKey, start: target.range.start, end: target.range.end } : { ...target, id: unitKey });
    }
    members.get(unitKey).push(target);
  }

  const cutAtRestatement = (start, end) => {
    for (const restatement of restatements) {
      if (restatement.start >= start && restatement.start < end) {
        return { head: { start, end: restatement.start }, tail: { start: Math.min(restatement.end, end), end } };
      }
    }
    return { head: { start, end }, tail: null };
  };

  const pieces = unique.map((target) => ({ target, prefix: null, suffix: null, tightNext: false }));
  const firstGap = { start: span.start, end: unique[0].start };
  pieces[0].prefix = lastListItem(firstGap, masked);

  for (let index = 0; index < unique.length; index += 1) {
    const current = unique[index];
    const next = unique[index + 1];
    const gapEnd = next ? next.start : span.end;
    // Skip over repeated mentions of the same target ("D-315 only where D-315 …").
    const { head, tail } = cutAtRestatement(current.end, gapEnd);

    if (!next) {
      pieces[index].suffix = head;
      continue;
    }

    const region = tail ?? head;
    const separator = lastSeparator(region, masked);
    if (tail) {
      pieces[index].suffix = head;
      pieces[index + 1].prefix = separator ? { start: separator.end, end: region.end } : region;
      continue;
    }

    if (!separator) {
      pieces[index].suffix = head;
      pieces[index + 1].prefix = { start: head.end, end: head.end };
      continue;
    }

    pieces[index].suffix = { start: head.start, end: separator.start };
    pieces[index + 1].prefix = { start: separator.end, end: region.end };
    const ownSuffix = masked.slice(head.start, separator.start);
    const separatorText = masked.slice(separator.start, separator.end);
    pieces[index].tightNext =
      TIGHT_SEPARATOR_PATTERN.test(separatorText) && /^\s*(?:['’]s)?\s*$/.test(ownSuffix);
  }

  // A bare ID list ("D-300, D-301, and D-306 controls") shares the words
  // around the whole list when no member carries its own prefix or suffix.
  // A trailing possessive ("…, and D-015's X") binds only its own ID.
  const lastSuffix = pieces[pieces.length - 1].suffix;
  const bareList =
    pieces.length > 1 &&
    !/^\s*['’]s(?![\w-])/.test(masked.slice(lastSuffix.start, lastSuffix.end)) &&
    pieces.slice(0, -1).every((piece) => /^\s*$/.test(masked.slice(piece.suffix.start, piece.suffix.end))) &&
    pieces.slice(1).every((piece) => /^\s*$/.test(masked.slice(piece.prefix.start, piece.prefix.end)));
  if (bareList) {
    for (const piece of pieces.slice(0, -1)) piece.tightNext = true;
  }

  // Group tightly coordinated targets.
  const groups = [];
  let group = [];
  for (const piece of pieces) {
    group.push(piece);
    if (!piece.tightNext) {
      groups.push(group);
      group = [];
    }
  }
  if (group.length) groups.push(group);

  const result = new Map();
  for (const grouped of groups) {
    const prefix = grouped[0].prefix;
    const suffix = grouped[grouped.length - 1].suffix;
    const scope = describeScope({ prefix, suffix, masked, original, qualifier });
    for (const piece of grouped) {
      const ids = new Set(members.get(piece.target.id).map((target) => target.id));
      for (const target of targets) {
        if (ids.has(target.id)) result.set(target, scope);
      }
    }
  }

  return result;
}

function lastListItem(range, masked) {
  const separator = lastSeparator(range, masked);
  return separator ? { start: separator.end, end: range.end } : range;
}

function lastSeparator(range, masked) {
  const text = masked.slice(range.start, range.end);
  const pattern = new RegExp(LIST_SEPARATOR_PATTERN.source, 'gi');
  let match;
  let last = null;
  let depthLevel = 0;
  const depthAt = [];
  for (let index = 0; index < text.length; index += 1) {
    depthAt.push(depthLevel);
    if (text[index] === '(') depthLevel += 1;
    else if (text[index] === ')') depthLevel = Math.max(0, depthLevel - 1);
  }
  while ((match = pattern.exec(text)) !== null) {
    if (depthAt[match.index] !== 0) continue;
    last = { start: range.start + match.index, end: range.start + match.index + match[0].length };
  }
  return last;
}

function describeScope({ prefix, suffix, masked, original, qualifier }) {
  const prefixRange = trimScopeRange(prefix, masked, 'prefix');
  const suffixRange = trimScopeRange(suffix, masked, 'suffix');
  const possessive = suffix ? /^\s*['’]s\b/.test(masked.slice(suffix.start, suffix.end)) : false;
  const qualifierRange = qualifier ? trimScopeRange(qualifier, masked, 'qualifier') : null;
  const parts = [prefixRange, suffixRange.range, qualifierRange?.range]
    .filter((range) => range && range.end > range.start)
    .map((range) => collapse(original.slice(range.start, range.end)))
    .filter(Boolean);
  const text = parts.length ? boundText(parts.join(' '), SCOPE_LIMIT) : null;
  const suffixText = suffixRange.range ? masked.slice(suffixRange.range.start, suffixRange.range.end) : '';
  const qualifierText = qualifierRange?.range ? masked.slice(qualifierRange.range.start, qualifierRange.range.end) : '';

  return {
    text,
    possessive,
    fullWording: FULL_EXTENT_PATTERN.test(suffixText.trim()) || FULL_EXTENT_PATTERN.test(qualifierText.trim()),
    partialWording:
      PARTIAL_EXTENT_PATTERN.test(suffixText) ||
      PARTIAL_EXTENT_PATTERN.test(qualifierText) ||
      (prefixRange ? PARTIAL_EXTENT_PATTERN.test(masked.slice(prefixRange.start, prefixRange.end)) : false),
  };
}

function trimScopeRange(range, masked, kind) {
  const empty = kind === 'prefix' ? null : { range: null };
  if (!range || range.end <= range.start) {
    return empty;
  }

  let { start, end } = range;
  const text = () => masked.slice(start, end);
  const skipLeading = (pattern) => {
    const match = text().match(pattern);
    if (match) start += match[0].length;
  };
  const skipTrailing = (pattern) => {
    const match = text().match(pattern);
    if (match) end -= match[0].length;
  };
  const trimEdges = () => {
    skipLeading(/^[\s,.:;)]+/);
    skipTrailing(/[\s,.:;(]+$/);
  };

  if (kind !== 'prefix') {
    // A leading possessive and a parenthetical gloss right after the ID are
    // not scope ("D-291 (in-transaction projection)" names the decision).
    skipLeading(/^\s*['’]s(?![\w-])/);
    skipLeading(/^\s*\([^)]*\)/);
  }
  trimEdges();

  if (kind === 'prefix') {
    skipLeading(/^(?:the|a|an|its|this|these|those|only)(?:\s+|$)/i);
    skipTrailing(/(?:^|\s+)(?:of|in|from|under|for|to)$/i);
  } else {
    // Keep "only where …" qualifiers; drop a bare "only" and a manner "by
    // this decision".
    if (!/^only\s+(?:where|insofar|to|for|in|as|when)(?![\w-])/i.test(text())) skipLeading(/^only(?:\s+|$)/i);
    skipLeading(/^by\s+this\s+(?:decision|entry)(?![\w-])/i);
    skipLeading(/^(?:(?:and|but)\s+)?(?:(?:is|are)\s+)?(?:kept|retained|preserved)\s+(?:only\s+)?(?:for|as)\s+(?:a\s+|the\s+)?historical\s+(?:reference|record|context)(?![\w-])/i);
    // "keeps D-321 and D-322 intact": the state word is the verb's complement, not a part.
    skipTrailing(/(?:^|\s+)(?:intact|untouched|unchanged|in\s+place|as\s+is)$/i);
    // "D-040 cannot be superseded": auxiliaries and negators before a passive
    // or predicate verb belong to the verb, not to the subject's scope.
    let previousEnd;
    do {
      previousEnd = end;
      skipTrailing(/(?:^|\s+)(?:cannot|[a-z]+n['’]t|not|never|longer|no|may|might|must|will|shall|should|would|could|can|also|still|now|is|are|was|were|be|been|being)$/i);
    } while (end !== previousEnd && end > start);
    skipTrailing(/(?:^|\s+)(?:and|or|plus|also)$/i);
  }
  trimEdges();

  if (end <= start) return empty;
  return kind === 'prefix' ? { start, end } : { range: { start, end } };
}

// Explicit wording wins: partial, then full, then a named part. Keeping a
// superseded entry "for historical reference" only upgrades an otherwise
// unqualified supersession to full; it never overrides a partial or scoped
// qualifier (retention is the append-only norm, not an extent claim).
function resolveExtent({ classification, scopeInfo, clauseAfterCue, current }) {
  const modifier = current.text.toLowerCase();
  if (/(?<![\w-])(?:partially|partly)(?![\w-])/.test(modifier) || scopeInfo.partialWording) {
    return 'partial';
  }
  if (/(?<![\w-])(?:fully|comprehensively)(?![\w-])/.test(modifier) || scopeInfo.fullWording) {
    return 'full';
  }
  if (current.id === 'supersession-of' && current.modifier && !/^(?:a|an|the|its|this|full)$/i.test(current.modifier)) {
    scopeInfo.text = scopeInfo.text ?? current.modifier;
    return 'scoped';
  }
  if (scopeInfo.text) {
    return 'scoped';
  }
  if (classification.relation === 'supersedes' && HISTORICAL_RETENTION_PATTERN.test(clauseAfterCue)) {
    return 'full';
  }
  return 'unqualified';
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/**
 * Blanks (same length, newlines kept) text whose wording must never become a
 * lineage declaration: fenced code, blockquotes, code spans, double-quoted
 * prose, and link targets.
 */
export function maskForLineage(text) {
  const chars = text.split(''); // UTF-16 units, so offsets stay aligned with the original
  const blank = (start, end) => {
    for (let index = start; index < end; index += 1) {
      if (chars[index] !== '\n') chars[index] = ' ';
    }
  };
  const current = () => chars.join('');

  for (const [start, end] of findFencedRanges(text)) blank(start, end);
  for (const match of current().matchAll(/^[ \t]*>.*$/gm)) blank(match.index, match.index + match[0].length);
  for (const match of current().matchAll(/``[^\n]*?``|`[^`\n]*`/g)) blank(match.index, match.index + match[0].length);
  for (const match of current().matchAll(/\]\(([^)\s]*)\)/g)) blank(match.index + 2, match.index + match[0].length - 1);
  for (const match of current().matchAll(/"[^"\n]{0,400}"|“[^”\n]{0,400}”/g)) blank(match.index, match.index + match[0].length);

  return current();
}

// Blank-line checks read the original text: a line that is blank only after
// masking (a line-leading code span) is not a paragraph break.
function nextLineOf(text, newlineIndex) {
  const end = text.indexOf('\n', newlineIndex + 1);
  return end === -1 ? null : text.slice(newlineIndex + 1, end);
}

// [start, end) offsets of fenced code blocks (``` or ~~~, CommonMark-style
// closing rule), fence lines included; an unclosed fence runs to the end.
export function findFencedRanges(text) {
  const ranges = [];
  let fence = null;
  let offset = 0;
  for (const line of text.split('\n')) {
    const lineStart = offset;
    offset += line.length + 1;
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (closesFence(fence, marker, line)) {
        ranges.push([fence.start, Math.min(offset - 1, text.length)]);
        fence = null;
      }
      continue;
    }
    if (marker && !(marker[1][0] === '`' && line.slice(line.indexOf(marker[1]) + marker[1].length).includes('`'))) {
      fence = { char: marker[1][0], length: marker[1].length, start: lineStart };
    }
  }
  if (fence) ranges.push([fence.start, text.length]);
  return ranges;
}

// A closing fence holds only the opener's character, at least as many times,
// so ```~~~ never closes. Shared by masking and the section index.
function closesFence(fence, marker, line) {
  return Boolean(marker) && marker[1][0] === fence.char && marker[1].length >= fence.length &&
    (fence.char === '`' ? /^ {0,3}`+\s*$/ : /^ {0,3}~+\s*$/).test(line);
}

function insideRanges(offset, ranges) {
  return ranges.some(([start, end]) => offset >= start && offset < end);
}

function computeParenDepth(text, original) {
  const depth = new Array(text.length + 1).fill(0);
  let level = 0;
  for (let index = 0; index < text.length; index += 1) {
    depth[index] = level;
    const char = text[index];
    if (char === '(') level += 1;
    else if (char === ')') level = Math.max(0, level - 1);
    else if (char === '\n' && nextLineOf(original, index)?.trim() === '') level = 0;
  }
  depth[text.length] = level;
  return depth;
}

function splitClauses(masked, depth, original) {
  const clauses = [];
  let start = 0;
  const push = (end) => {
    let from = start;
    while (from < end && /\s/.test(masked[from])) from += 1;
    if (end > from) clauses.push({ start: from, end });
  };

  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index];
    if (char === '\n') {
      const nextLine = nextLineOf(original, index) ?? original.slice(index + 1);
      if (nextLine.trim() === '' || /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/.test(nextLine)) {
        push(index);
        start = index + 1;
      }
      continue;
    }
    if (depth[index] > 0) continue;
    if (char === ';') {
      push(index);
      start = index + 1;
      continue;
    }
    if (char === '.' || char === '!' || char === '?') {
      const rest = masked.slice(index + 1, index + 8);
      if (rest.trim() === '' && index + 1 + rest.length >= masked.length) {
        push(index);
        start = index + 1;
      } else if (/^\s+(?:[A-Z0-9(*"“`[]|D-)/.test(rest)) {
        push(index);
        start = index + 1;
      }
    }
  }
  push(masked.length);
  return clauses;
}

function splitAtDepthZero(text, separator) {
  const segments = [];
  let level = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(') level += 1;
    else if (char === ')') level = Math.max(0, level - 1);
    else if (char === separator && level === 0) {
      segments.push({ start, text: text.slice(start, index) });
      start = index + 1;
    }
  }
  segments.push({ start, text: text.slice(start) });
  return segments;
}

function buildSectionIndex(content, bodyStart) {
  const headings = [];
  let fence = null;
  let offset = 0;
  let lineNumber = 0;

  for (const line of content.split('\n')) {
    const lineStart = offset;
    offset += line.length + 1;
    lineNumber += 1;
    if (lineStart < bodyStart) continue;

    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (closesFence(fence, fenceMatch, line)) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
      continue;
    }

    const heading = line.match(/^(#{2,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*\r?$/);
    if (heading) {
      headings.push({ level: heading[1].length, text: heading[2].trim(), start: lineStart, line: lineNumber });
    }
  }

  const stack = [];
  for (const [index, heading] of headings.entries()) {
    while (stack.length && stack[stack.length - 1].level >= heading.level) stack.pop();
    heading.path = [...stack.map((entry) => entry.text), heading.text].join(' > ');
    stack.push(heading);
    heading.end = content.length;
    for (let next = index + 1; next < headings.length; next += 1) {
      if (headings[next].level <= heading.level) {
        heading.end = headings[next].start;
        break;
      }
    }
    heading.hash = sha256Text(content.slice(heading.start, heading.end).trimEnd());
  }

  const preambleEnd = headings[0]?.start ?? content.length;
  return {
    headings,
    preamble: { path: null, hash: sha256Text(content.slice(bodyStart, preambleEnd).trimEnd()) },
  };
}

function sectionAt(sections, offset) {
  let low = 0;
  let high = sections.headings.length - 1;
  let found = null;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (sections.headings[middle].start <= offset) {
      found = sections.headings[middle];
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found ?? sections.preamble;
}

function buildLineStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function lineAt(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

function createRelation(fields) {
  return {
    relation: fields.relation,
    source_kind: fields.source_kind,
    source_path: fields.source_path,
    source_decision_id: fields.source_decision_id ?? null,
    source_section: fields.source_section ?? null,
    source_field: fields.source_field ?? null,
    source_line: fields.source_line,
    source_hash: fields.source_hash,
    section_hash: fields.section_hash,
    target_decision_id: fields.target_decision_id,
    evidence: fields.evidence,
    basis: fields.basis,
    extent: fields.extent ?? null,
    scope: fields.scope ?? null,
    cue: fields.cue ?? null,
    excerpt: fields.excerpt ?? null,
    occurrences: fields.occurrences ?? 1,
  };
}

export function sortRelations(relations) {
  return [...relations].sort(
    (left, right) =>
      left.source_path.localeCompare(right.source_path) ||
      (left.source_decision_id ?? 0) - (right.source_decision_id ?? 0) ||
      left.source_line - right.source_line ||
      left.target_decision_id - right.target_decision_id ||
      RELATION_ORDER.get(left.relation) - RELATION_ORDER.get(right.relation) ||
      String(left.cue ?? '').localeCompare(String(right.cue ?? '')),
  );
}

function sortDiagnostics(diagnostics) {
  return [...diagnostics].sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.line - right.line || left.code.localeCompare(right.code),
  );
}

// Canonical decision IDs: three or more digits, no extra leading zero, and a
// positive safe integer (so range arithmetic stays exact).
function toDecisionId(digits) {
  if (digits.length < 3 || (digits.length > 3 && digits[0] === '0')) {
    return null;
  }
  const id = Number(digits);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function collapse(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function boundText(value, limit) {
  const points = Array.from(value);
  return points.length <= limit ? value : `${points.slice(0, limit - 1).join('')}…`;
}

function pad(id) {
  return String(id).padStart(3, '0');
}
