/**
 * @fileoverview Normalizes a Jira resolution name into a `resolutions.key`.
 *
 * Pure and dependency-free ON PURPOSE — the resolutions stage imports NestJS services, so keeping
 * the normalization here makes the one rule that matters directly testable.
 *
 * THE RULE THAT MATTERS: apostrophes are DELETED before separators are collapsed, and the order is
 * load-bearing. XISUITE seeds every organization with exactly four resolutions via the
 * `seed_default_workflow_config()` trigger: `done`, `wont_do`, `duplicate`, `cannot_reproduce`.
 * Jira ships "Done", "Won't Do", "Duplicate", "Cannot Reproduce". Collapse-first normalization
 * turns "Won't Do" into `won_t_do`, which does NOT match the seeded `wont_do` — so the stage would
 * mint a fifth resolution that duplicates a seeded one, on every org, forever. Delete-first yields
 * `wont_do` and the stage ADOPTS the seeded row instead.
 *
 * Target contract: `CreateResolutionDto` enforces `@Matches(/^[a-z][a-z0-9_]*$/)` `@MaxLength(50)`,
 * and `resolutions` carries `UNIQUE (organization_id, key)`.
 *
 * @module src/migration/engine/stages/resolution-key.util
 */

/** `resolutions.key` is varchar(50) and the DTO enforces the same cap. */
const MAX_KEY_LENGTH = 50;

/**
 * Post-normalization aliases for Jira resolution names that are semantically identical to a seeded
 * XISUITE resolution but lexically different. Applied AFTER normalization so the table stays tiny
 * and case/punctuation variants collapse into one entry.
 *
 * Deliberately short. Inventing correspondences is worse than creating an extra resolution: a wrong
 * alias silently rewrites what the customer's data MEANS, an extra row merely clutters a list.
 */
const RESOLUTION_KEY_ALIASES: Readonly<Record<string, string>> = {
  wont_fix: 'wont_do',
  fixed: 'done',
  resolved: 'done',
  incomplete: 'cannot_reproduce',
  // German (de_DE) defaults. Verified against a real customer run, whose log showed all four being
  // CREATED rather than adopted — the stage header's "creates NOTHING on a stock instance" claim
  // held only for English.
  fertig: 'done',
  erledigt: 'done',
  duplikat: 'duplicate',
  kann_nicht_reproduziert_werden: 'cannot_reproduce',
  reicht_nicht: 'wont_do',
};

/**
 * Normalize a Jira resolution name to a DTO-legal, seed-compatible key.
 *
 * Steps, in an order where each is load-bearing:
 *  1. Unicode NFKD + strip combining marks, so "Résolu" becomes "Resolu" not "r_solu".
 *  2. DELETE apostrophes/quotes entirely ("Won't Do" → "Wont Do"). See the fileoverview.
 *  3. Lowercase.
 *  4. Collapse every non-alphanumeric run into one underscore.
 *  5. Trim underscores, force a leading letter (`r_` prefix when the name starts with a digit or
 *     normalized to nothing), cap at 50 without leaving a trailing underscore.
 *  6. Apply the alias table.
 */
export function normalizeResolutionKey(name: string): string {
  const deAccented = name
    .normalize('NFKD')
    // Combining marks left behind by NFKD (the accent halves of accented letters).
    .replace(/[̀-ͯ]/g, '');

  let key = deAccented
    .replace(/['‘’`´"]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!key || !/^[a-z]/.test(key)) key = `r_${key}`;

  key = key.slice(0, MAX_KEY_LENGTH).replace(/_+$/g, '');

  return RESOLUTION_KEY_ALIASES[key] ?? key;
}
