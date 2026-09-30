/**
 * Markdown rendering for the session brief (plan task A3). Pure functions of
 * the selection result from `brief.js`: the engine measures units with
 * `renderBriefUnit` while packing and the whole brief with `renderBrief`, so
 * the estimated size always describes exactly the text a reader gets.
 *
 * Wording rule (D-359): relations are named by their evidence — "covers" and
 * "cites" are mechanical, "supersedes" and "amends" are declared by the later
 * entry. The brief's own text never says that a decision governs something
 * or is currently valid.
 */

const LIMITS = {
  description: 600,
  guidance: 450,
  decision: 650,
  impact: 450,
  successorDecision: 450,
  successorImpact: 300,
  next: 350,
  handoff: 350,
  reasons: 240,
  watchItems: 5,
};

const EVIDENCE_NOTE =
  '_Evidence: "covers" and "cites" are mechanical (the doc lists the file or mentions the decision); "supersedes" and "amends" come only from the later decision\'s own text. The brief infers no other relation and does not decide which decision applies to this task._';
const EVIDENCE_NOTE_SHORT = '_Evidence: covers/cites are mechanical; supersedes/amends are declared by the later decision. Nothing else is inferred._';

/**
 * Frame limits (header, status, follow-ups) per compaction level. Level 0 is
 * normal; the engine raises the level only when the frame itself would not
 * fit the budget, so every accepted input renders within budget. Every
 * field is bounded at every level; units render the same at every level.
 */
const FRAME_LIMITS = [
  { task: 300, file: 120, files: 4, root: 160, reason: 300, gap: 240, followUpPath: 120, followUpHeading: 60, followUpReason: 170, followUps: Infinity, evidence: EVIDENCE_NOTE },
  { task: 160, file: 60, files: 2, root: 60, reason: 200, gap: 160, followUpPath: 100, followUpHeading: 40, followUpReason: 80, followUps: Infinity, evidence: EVIDENCE_NOTE_SHORT },
  { task: 120, file: 50, files: 1, root: 40, reason: 160, gap: 110, followUpPath: 80, followUpHeading: 30, followUpReason: 40, followUps: Infinity, evidence: EVIDENCE_NOTE_SHORT },
  { task: 100, file: 40, files: 1, root: 30, reason: 120, gap: 90, followUpPath: 70, followUpHeading: 24, followUpReason: 30, followUps: 6, evidence: EVIDENCE_NOTE_SHORT },
];
export const BRIEF_MAX_COMPACTION = FRAME_LIMITS.length - 1;

export function renderBrief(result) {
  const frame = FRAME_LIMITS[Math.min(result.render?.compaction ?? 0, BRIEF_MAX_COMPACTION)];
  const lines = ['# Session brief', ''];
  const followUps = renderFollowUpList(result, frame);

  if (result.status === 'incomplete') {
    lines.push('**INCOMPLETE — read these before planning:**', ...followUps, '');
  }

  lines.push(`**Status: ${result.status}** — ${statusSentence(result, frame)}`, '');
  lines.push(...renderHeader(result, frame), '');

  if (result.status !== 'no-match') lines.push(frame.evidence, '');

  const byKind = (kind) => result.units.filter((unit) => unit.kind === kind);
  const emitted = new Set();

  for (const unit of byKind('lane')) lines.push(renderBriefUnit(unit, { emittedDecisions: emitted }), '');

  const lineage = byKind('lineage');
  if (lineage.length > 0) {
    lines.push('## Decisions', '');
    for (const unit of lineage) {
      lines.push(renderBriefUnit(unit, { emittedDecisions: emitted }), '');
      for (const member of unit.members) emitted.add(member.decision_id);
    }
  }

  const docs = byKind('doc');
  if (docs.length > 0) {
    lines.push('## Architecture docs', '');
    for (const unit of docs) lines.push(renderBriefUnit(unit), '');
  }

  const notes = byKind('note');
  if (notes.length > 0) {
    lines.push('## Session notes', '');
    for (const unit of notes) lines.push(renderBriefUnit(unit), '');
  }

  const watchOuts = byKind('watch-out');
  if (watchOuts.length > 0) {
    lines.push('## Watch-outs', '');
    for (const unit of watchOuts) lines.push(renderBriefUnit(unit));
    lines.push('');
  }

  if (result.status !== 'incomplete' && followUps.length > 0) {
    lines.push('## Follow-up reads', '', ...followUps, '');
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** One unit's markdown; `emittedDecisions` holds decisions shown by earlier units. */
export function renderBriefUnit(unit, options = {}) {
  switch (unit.kind) {
    case 'lane':
      return renderLane(unit);
    case 'lineage':
      return renderLineage(unit, options.emittedDecisions ?? new Set());
    case 'doc':
      return renderDoc(unit);
    case 'note':
      return renderNote(unit);
    case 'watch-out':
      return renderWatchOut(unit);
    default:
      throw new Error(`Unknown brief unit kind "${unit.kind}".`);
  }
}

function statusSentence(result, frame) {
  const withheld = result.omitted.filter((unit) => unit.omitted_reason === 'narrow-match').length;
  const overflow = result.omitted.length - withheld;
  switch (result.status) {
    case 'complete':
      return 'every selected unit fits the budget.';
    case 'partial': {
      const parts = [];
      if (overflow > 0) parts.push(`${overflow} lower-tier unit${overflow === 1 ? '' : 's'} did not fit`);
      if (withheld > 0) parts.push(`${withheld} lower-confidence match${withheld === 1 ? '' : 'es'} ${withheld === 1 ? 'is' : 'are'} shown as reads only, because most of the task's distinctive words had no keyword match`);
      return `${parts.join('; ')}; see Follow-up reads.`;
    }
    case 'no-match':
      return 'no architecture doc or decision matched this task. Nothing in memory is presented as relevant; say so in your plan, and read the orientation overview if the task needs broader context.';
    default:
      return `${excerpt(result.status_reason, frame.reason)}.`;
  }
}

function renderHeader(result, frame) {
  const files = result.inputs.files;
  const fileText =
    files.length === 0
      ? 'none'
      : `${files.slice(0, frame.files).map((file) => `\`${elide(file, frame.file)}\``).join(', ')}${files.length > frame.files ? ` (+${files.length - frame.files} more)` : ''}`;
  const lines = [
    `- Task: ${excerpt(result.task, frame.task) || '(none)'}`,
    `- Files: ${fileText}`,
    `- Lane: ${result.source.lane_id ? `\`${result.source.lane_id}\`` : 'none'} · Root: \`${elide(result.source.root_dir, frame.root)}\``,
    `- Estimated size: ~${groupDigits(result.budget.estimated_tokens)} of ${groupDigits(result.budget.limit)} tokens (Unicode code points ÷ 4 over this whole brief)`,
  ];
  if (result.orientation.exists) {
    lines.push(`- Orientation: \`${result.orientation.path}\` — the whole-project overview; read it first when orienting.`);
  }
  for (const gap of result.gaps) lines.push(`- Gap: ${excerpt(gap.message, frame.gap)}`);
  const headerElided =
    files.slice(0, frame.files).some((file) => elide(file, frame.file) !== file) || elide(result.source.root_dir, frame.root) !== result.source.root_dir;
  if (headerElided) lines.push('- Shortened values (…) are exact in `--json` (`inputs`, `source`).');
  return lines;
}

/** How many follow-up reads the rendered brief lists (the cap, tightened by the frame level). */
export function renderedFollowUpCount(result) {
  const frame = FRAME_LIMITS[Math.min(result.render?.compaction ?? 0, BRIEF_MAX_COMPACTION)];
  return Math.min(result.follow_ups.length, result.follow_up_cap, frame.followUps);
}

function renderFollowUpList(result, frame) {
  const shown = result.follow_ups.slice(0, renderedFollowUpCount(result));
  let elided = false;
  const lines = shown.map((entry) => {
    const heading = entry.heading ? ` › ${excerpt(entry.heading, frame.followUpHeading)}` : '';
    const shownPath = elide(entry.path, frame.followUpPath);
    if (shownPath !== entry.path) elided = true;
    return `${entry.rank}. \`${shownPath}\`${heading} — ${excerpt(entry.reason, frame.followUpReason)}`;
  });
  const hidden = result.follow_ups.length - shown.length;
  if (hidden > 0) lines.push(`+${hidden} more (full list in \`--json\`)`);
  if (elided) lines.push('_Paths shortened with … are exact in `--json` (`follow_ups[].path`)._');
  return lines;
}

/** Middle-elided text (paths): keeps both ends within `limit` code points. */
function elide(value, limit) {
  const points = [...String(value ?? '')];
  if (points.length <= limit) return points.join('');
  const head = Math.ceil((limit - 1) / 3);
  const tail = limit - 1 - head;
  return `${points.slice(0, head).join('')}…${points.slice(points.length - tail).join('')}`;
}

function renderLane(unit) {
  const lines = [`## Lane \`${unit.lane_id}\``];
  lines.push(`- Working on: ${excerpt(unit.working_on, LIMITS.handoff) || 'not recorded'}`);
  if (unit.handoff_exists) {
    lines.push(`- Handoff, what's next: ${excerpt(flattenList(unit.handoff_next), LIMITS.handoff) || 'not recorded'}`);
    lines.push(`- Handoff, open review: ${excerpt(flattenList(unit.open_review), LIMITS.handoff) || 'none recorded'}`);
    lines.push(`- Required read: \`${unit.handoff_path}\` (full)`);
  } else {
    lines.push(`- Handoff: none at \`${unit.handoff_path}\``);
  }
  return lines.join('\n');
}

function renderLineage(unit, emittedDecisions) {
  const [root, ...successors] = unit.members;
  const lines = [];
  if (emittedDecisions.has(root.decision_id)) {
    lines.push(`### ${formatId(root.decision_id)} — shown above`);
  } else {
    lines.push(`### ${formatId(root.decision_id)} — ${root.title ?? 'untitled'}`);
    lines.push(`\`${root.path}\`${root.date ? ` · ${root.date}` : ''}${reasonText(unit.reasons)}`);
    lines.push(`- Decision: ${excerpt(root.decision, LIMITS.decision) || 'not recorded'}`);
    if (root.impact) lines.push(`- Impact on prior decisions: ${excerpt(root.impact, LIMITS.impact)}`);
  }

  if (successors.length > 0) {
    lines.push('- Declared successors (transitive), newest first:');
    for (const member of successors) {
      const declared = describeDeclared(member);
      if (emittedDecisions.has(member.decision_id)) {
        lines.push(`  - ${formatId(member.decision_id)} ${declared} — shown above`);
        continue;
      }
      lines.push(`  - **${formatId(member.decision_id)}** ${declared} — ${member.title ?? 'untitled'} (\`${member.path}\`${member.date ? `, ${member.date}` : ''})`);
      lines.push(`    - Decision: ${excerpt(member.decision, LIMITS.successorDecision) || 'not recorded'}`);
      if (member.impact) lines.push(`    - Impact on prior decisions: ${excerpt(member.impact, LIMITS.successorImpact)}`);
    }
  }

  const byPath = new Map();
  for (const member of unit.members) {
    if (!byPath.has(member.path)) byPath.set(member.path, []);
    byPath.get(member.path).push(formatId(member.decision_id));
  }
  lines.push(`- Full entries and rationale: ${[...byPath].map(([entryPath, ids]) => `\`${entryPath}\` › ${ids.join(', ')}`).join('; ')}`);
  return lines.join('\n');
}

function describeDeclared(member) {
  if (member.declared_relations.length === 0) {
    return `(declared ${member.successor_relations.join(', ')})`;
  }
  const parts = member.declared_relations.map((relation) => {
    const verb =
      relation.relation === 'supersedes' && relation.extent === 'partial'
        ? 'partially supersedes'
        : relation.relation;
    // A partial or scoped relation keeps the part it names: a structured
    // `**Partially supersedes:** D-100 — the credit balance` may be the only
    // place that part is stated (D-363).
    const scope = relation.scope && (relation.extent === 'scoped' || relation.extent === 'partial')
      ? ` (${relation.extent === 'partial' ? 'part' : 'scoped'}: ${excerpt(relation.scope, 80)})`
      : '';
    return `${verb} ${formatId(relation.target_decision_id)}${scope}`;
  });
  return `(declared: ${[...new Set(parts)].join('; ')})`;
}

function renderDoc(unit) {
  const lines = [`### \`${unit.path}\``];
  lines.push(`${unit.domain} › ${unit.feature} › ${unit.component} · frontmatter status: ${unit.status ?? 'unknown'}${reasonText(unit.reasons)}`);
  lines.push(`- Description: ${excerpt(unit.description, LIMITS.description) || 'missing'}`);
  if (unit.retrieval_guidance) {
    lines.push(`- Retrieval guidance: ${excerpt(unit.retrieval_guidance, LIMITS.guidance)}`);
  } else if (unit.retrieval_scope) {
    lines.push(`- Retrieval scope: ${excerpt(unit.retrieval_scope, LIMITS.guidance)}`);
  }
  if (unit.missing_sections.length > 0) {
    lines.push(
      `- Maintenance: missing ${unit.missing_sections.map((section) => `\`## ${section}\``).join(', ')} (\`architecture-missing-section\`) — add ${unit.missing_sections.length === 1 ? 'it' : 'them'} so briefs can route to this doc precisely.`,
    );
  }
  return lines.join('\n');
}

function renderNote(unit) {
  const lines = [`### \`${unit.path}\` — ${unit.title ?? 'untitled'}${unit.date ? ` (${unit.date})` : ''}`];
  lines.push(`selected: ${unit.reasons.join('; ')}`);
  lines.push(`- Next session should start with: ${excerpt(unit.next_session, LIMITS.next) || 'not recorded'}`);
  return lines.join('\n');
}

function renderWatchOut(unit) {
  const items = unit.items.slice(0, LIMITS.watchItems);
  const more = unit.items.length - items.length;
  const suffix = more > 0 ? `; +${more} more` : '';
  if (unit.category === 'other-lanes') {
    const text = items
      .map((item) => {
        const shown = item.overlapping_claims.slice(0, 3).map((claim) => `\`${elide(claim, 80)}\``).join(', ');
        const extra = item.overlapping_claims.length > 3 ? ` (+${item.overlapping_claims.length - 3} more)` : '';
        const overlap = item.overlapping_claims.length > 0 ? `; claims overlapping this lane: ${shown}${extra}` : '';
        return `\`${item.lane_id}\` (${excerpt(item.working_on, 90) || 'no summary'}${overlap})`;
      })
      .join('; ');
    return `- Other active lanes: ${text}${suffix}`;
  }
  if (unit.category === 'newer-decisions') {
    return `- Decisions appended after this lane's snapshot ${formatId(unit.snapshot)}: ${items
      .map((item) => `${formatId(item.decision_id)} — ${excerpt(item.title, 90)} (\`${item.path}\`)`)
      .join('; ')}${suffix}`;
  }
  return `- Lane bindings missing on disk: ${items.map((item) => `worktree for \`${item.repo}\` at \`${elide(item.path, 100)}\``).join('; ')}${suffix}`;
}

/** "- a\n- b" → "a; b": list items read inline. */
function flattenList(value) {
  if (!value) return value;
  return String(value)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '').trim())
    .filter(Boolean)
    .reduce((joined, item) => (joined ? `${joined}${/[.!?]$/.test(joined) ? ' ' : '; '}${item}` : item), '');
}

function reasonText(reasons) {
  if (!reasons || reasons.length === 0) return '';
  return ` · selected: ${excerpt(reasons.join('; '), LIMITS.reasons)}`;
}

/** Whitespace-collapsed text cut to `limit` code points at a sentence or word edge. */
export function excerpt(value, limit) {
  if (value === null || value === undefined) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  const points = [...text];
  if (points.length <= limit) return text;
  const marker = ' …[cut]';
  const room = limit - [...marker].length;
  const head = points.slice(0, room).join('');
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('; '));
  const word = head.lastIndexOf(' ');
  const cut = sentence >= room * 0.6 ? sentence + 1 : word > room * 0.5 ? word : room;
  return `${head.slice(0, cut).trimEnd()}${marker}`;
}

function groupDigits(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatId(id) {
  return `D-${String(id).padStart(3, '0')}`;
}
