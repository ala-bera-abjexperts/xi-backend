/**
 * @fileoverview Preserves a board filter's ORIGINAL source query where a human can still find it.
 *
 * Pure and dependency-free ON PURPOSE — `boards.stage.ts` imports NestJS services.
 *
 * WHY THIS EXISTS. `board_swimlanes.query` and `board_quick_filters.query` are TEXT columns whose
 * schema comment says "JQL/filter query string", but the running application does not treat them as
 * JQL: the board configuration screens parse them as a serialised react-querybuilder RuleGroup and
 * fall back to an EMPTY rule set for anything that is not valid JSON.
 *
 * Two consequences, both of which this file exists to soften:
 *
 *  1. Migrated JQL does not evaluate. The filter appears with the right name and the right stored
 *     text, but it does not select cards.
 *  2. Worse, it is destructible. An administrator who opens a migrated swimlane in the board config
 *     screen and presses Save writes back whatever the rule builder is showing, which for
 *     unparseable text is nothing. The original expression is then gone with no record.
 *
 * Copying the source query into `description` costs nothing, is not touched by that save path, and
 * means the customer can always see what the filter was SUPPOSED to do even after someone has
 * saved over it. It converts a silent, unrecoverable loss into a visible, recoverable one.
 *
 * @module src/migration/mappers/board-query.util
 */

/** Marker so the provenance of the text is unambiguous to a reader who was not part of the import. */
const PREFIX = 'Migrated from Jira. Original JQL:';

/** `board_quick_filters.description` and `board_swimlanes.description` are text, but stay sane. */
const MAX_DESCRIPTION = 1000;

/**
 * Build the description that carries a migrated filter's original source query.
 *
 * @param query           The source query (JQL) as the board reported it.
 * @param sourceDescription  The source's own description, kept ahead of the JQL when present —
 *                           losing the human explanation to make room for the machine one would be
 *                           the wrong trade.
 * @returns The description to store, or `undefined` when there is nothing worth recording.
 */
export function describeMigratedQuery(
  query: string | null | undefined,
  sourceDescription?: string | null,
): string | undefined {
  const jql = (query ?? '').trim();
  const own = (sourceDescription ?? '').trim();

  if (!jql && !own) return undefined;
  if (!jql) return own.slice(0, MAX_DESCRIPTION);

  const combined = own ? `${own}\n\n${PREFIX} ${jql}` : `${PREFIX} ${jql}`;

  return combined.slice(0, MAX_DESCRIPTION);
}
