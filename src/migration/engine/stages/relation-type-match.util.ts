/**
 * @fileoverview Matches a Jira issue-link type name onto this org's `relation_types` rows.
 *
 * Pure and dependency-free ON PURPOSE — `links.stage.ts` imports NestJS services, so keeping the
 * matching ladder here makes it directly testable.
 *
 * WHY THIS EXISTS. The original ladder ended with `(relates ?? rows[0]).id`. That reads like a safe
 * default and is not: an unrecognised Jira link type does not get DROPPED, it gets silently
 * RELABELLED. A "Causes" link arrives in XISUITE as "Relates", or worse as whatever row happened to
 * sort first. The edge survives, so nothing looks broken, but its meaning is gone and no log says
 * so. Losing the link outright would at least be visible.
 *
 * So the fallbacks are demoted to genuine last resort and an adopt-or-create rung goes ahead of
 * them: if Jira has a link type we cannot match, create it rather than pretend it is something else.
 *
 * The split between this file and the stage is deliberate. Matching is a pure decision over rows;
 * creating is a racing database write (link items are processed in PARALLEL, so N items missing the
 * same type will race N creates). The decision is tested here; the race handling lives in the stage.
 *
 * @module src/migration/engine/stages/relation-type-match.util
 */

/**
 * Jira link-type name (lowercased) → XISUITE `relation_types.name` candidates, in preference order.
 *
 * These cover the spelling drift between Jira's defaults and XISUITE's seeded set: Jira ships
 * "Cloners" and "Duplicate" where XISUITE seeds "Clones" and "Duplicates". Without the hints these
 * would fall through to the create rung and mint near-duplicate types on every org.
 */
const NAME_HINTS: Readonly<Record<string, readonly string[]>> = {
  cloners: ['clones', 'duplicates'],
  duplicate: ['duplicates'],
  blocks: ['blocks'],
  relates: ['relates'],
};

export interface RelationTypeRow {
  id: string;
  name: string;
}

export type RelationTypeMatch =
  /** A row whose name equals the Jira type name. */
  | { action: 'exact'; id: string; reason: string }
  /** A row reached through {@link NAME_HINTS} — a known spelling difference, not a guess. */
  | { action: 'hint'; id: string; reason: string }
  /** Nothing matched. The caller should try to CREATE the type before falling back. */
  | { action: 'none'; reason: string };

/** Case- and whitespace-insensitive comparison key for a type name. */
function key(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Find the relation type that genuinely corresponds to this Jira link type.
 *
 * Deliberately returns `none` rather than a generic type when nothing matches: choosing the fallback
 * is the CALLER's decision, made only after the create rung has been tried and failed. Folding the
 * fallback in here is what made the original silent relabelling invisible.
 *
 * @param jiraTypeName  Jira's `issuelinks[].type.name`, e.g. `Blocks`, `Cloners`.
 * @param rows          This org's live `relation_types` rows.
 */
export function matchRelationType(
  jiraTypeName: string,
  rows: readonly RelationTypeRow[],
): RelationTypeMatch {
  const wanted = key(jiraTypeName);

  if (!wanted) {
    return { action: 'none', reason: 'Jira link type has no name' };
  }

  const exact = rows.find((r) => key(r.name) === wanted);

  if (exact) {
    return {
      action: 'exact',
      id: exact.id,
      reason: `exact name match on "${exact.name}"`,
    };
  }

  for (const hint of NAME_HINTS[wanted] ?? []) {
    const hit = rows.find((r) => key(r.name) === hint);

    if (hit) {
      return {
        action: 'hint',
        id: hit.id,
        reason: `"${jiraTypeName}" mapped to "${hit.name}" by known spelling hint`,
      };
    }
  }

  return {
    action: 'none',
    reason: `no relation type corresponds to Jira link type "${jiraTypeName}"`,
  };
}

/**
 * Last-resort type to use when matching found nothing AND creating the type failed.
 *
 * This is the lossy path: the edge keeps its endpoints but loses its meaning. Callers MUST log when
 * they reach it, which is why it returns the row rather than just an id — the name belongs in the
 * log line so the loss is auditable rather than merely mentioned.
 *
 * @returns The generic "Relates" row, else any row, else `null` when the org has no types at all.
 */
export function fallbackRelationType(
  rows: readonly RelationTypeRow[],
): RelationTypeRow | null {
  if (rows.length === 0) return null;

  return rows.find((r) => key(r.name) === 'relates') ?? rows[0];
}
