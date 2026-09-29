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
  task: 300,
  description: 600,
  guidance: 450,
  decision: 650,
  impact: 450,
  successorDecision: 450,
  successorImpact: 300,
  next: 350,
  handoff: 350,
  reasons: 240,
  followUp: 170,
  files: 4,
  watchItems: 5,
};

const EVIDENCE_NOTE =
  '_Evidence: "covers" and "cites" are mechanical (the doc lists the file or mentions the decision); "supersedes" and "amends" come only from the later decision\'s own text. The brief infers no other relation and does not decide which decision applies to this task._';

export function renderBrief(result) {
  const lines = ['# Session brief', ''];
  const followUps = renderFollowUpList(result);

  if (result.status === 'incomplete') {
    lines.push('**INCOMPLETE — read these before planning:**', ...followUps, '');
  }

  lines.push(`**Status: ${result.status}** — ${statusSentence(result)}`, '');
  lines.push(...renderHeader(result), '');

  if (result.status !== 'no-match') lines.push(EVIDENCE_NOTE, '');

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

function statusSentence(result) {
  const omittedCount = result.omitted.length;
  switch (result.status) {
    case 'complete':
      return 'every selected unit fits the budget.';
    case 'partial':
      return `${omittedCount} lower-tier unit${omittedCount === 1 ? '' : 's'} did not fit; ${omittedCount === 1 ? 'it is' : 'they are'} listed under Follow-up reads.`;
    case 'no-match':
      return 'no architecture doc or decision matched this task. Nothing in memory is presented as relevant; say so in your plan, and read the orientation overview if the task needs broader context.';
    default:
      return `${result.status_reason}.`;
  }
}

function renderHeader(result) {
  const files = result.inputs.files;
  const fileText =
    files.length === 0
      ? 'none'
      : `${files.slice(0, LIMITS.files).map((file) => `\`${file}\``).join(', ')}${files.length > LIMITS.files ? ` (+${files.length - LIMITS.files} more)` : ''}`;
  const lines = [
    `- Task: ${excerpt(result.task, LIMITS.task) || '(none)'}`,
    `- Files: ${fileText}`,
    `- Lane: ${result.source.lane_id ? `\`${result.source.lane_id}\`` : 'none'} · Root: \`${result.source.root_dir}\``,
    `- Estimated size: ~${groupDigits(result.budget.estimated_tokens)} of ${groupDigits(result.budget.limit)} tokens (Unicode code points ÷ 4 over this whole brief)`,
  ];
  if (result.orientation.exists) {
    lines.push(`- Orientation: \`${result.orientation.path}\` — the whole-project overview; read it first when orienting.`);
  }
  for (const gap of result.gaps) lines.push(`- Gap: ${gap.message}`);
  return lines;
}

function renderFollowUpList(result) {
  const shown = result.follow_ups.slice(0, result.follow_up_cap);
  const lines = shown.map((entry) => {
    const location = `\`${entry.path}\`${entry.heading ? ` › ${entry.heading}` : ''}`;
    return `${entry.rank}. ${location} — ${excerpt(entry.reason, LIMITS.followUp)}`;
  });
  const hidden = result.follow_ups.length - shown.length;
  if (hidden > 0) lines.push(`+${hidden} more (full list in \`--json\`)`);
  return lines;
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
    const scope = relation.extent === 'scoped' && relation.scope ? ` (scoped: ${excerpt(relation.scope, 80)})` : '';
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
        const overlap = item.overlapping_claims.length > 0 ? `; claims overlapping this lane: ${item.overlapping_claims.map((claim) => `\`${claim}\``).join(', ')}` : '';
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
  return `- Lane bindings missing on disk: ${items.map((item) => `worktree for \`${item.repo}\` at \`${item.path}\``).join('; ')}${suffix}`;
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
