/**
 * @fileoverview Localized status/priority names → the key XISUITE already seeds.
 *
 * Every adopt ladder in this engine is KEY-first, and the derived key is an ASCII slug of the
 * source's display name. On a German instance that slug is `fertig`, never `done`, so adoption can
 * never fire and each run mints a duplicate beside the seeded row. The same holds for Jira's classic
 * English priority scheme (`Blocker`/`Critical`/`Major`/`Minor`/`Trivial`), none of which slug onto
 * the seeded `highest`/`high`/`low`/`lowest`. Aliasing at key-derivation time fixes both without
 * touching a single adopt/conflict/re-read path.
 *
 * A NAME rung would not have worked: the seeded row is named "Done" and the Jira row "Fertig", so a
 * name comparison misses too. Only a key alias can bridge them.
 *
 * Keyed on `asciiSlug` output (which transliterates `ö → oe`), NOT on `normalizeResolutionKey`
 * output (NFKD, which yields `o`). The two normalizers disagree — `Höchste` is `hoechste` here and
 * `hochste` there — which is why resolutions keep their own table in `resolution-key.util`.
 *
 * Deliberately short, same doctrine as that file: inventing a correspondence is worse than creating
 * an extra row. A wrong alias silently rewrites what the customer's data MEANS; an extra row merely
 * clutters a list. Nothing speculative goes in here.
 *
 * @module src/migration/engine/stages/seeded-key.util
 */

/** German (de_DE) Jira status names → the status key XISUITE seeds at organization level. */
const SEEDED_STATUS_ALIASES: Readonly<Record<string, string>> = {
  // English "To Do" slugs to `to_do` and duplicates the seeded `open` — the same defect, and the
  // only entry here that is not a no-op for an English instance.
  to_do: 'open',
  offen: 'open',
  zu_erledigen: 'open',
  in_arbeit: 'in_progress',
  in_bearbeitung: 'in_progress',
  fertig: 'done',
  erledigt: 'done',
  geschlossen: 'closed',
};

/**
 * Localized/legacy Jira priority names → the priority key XISUITE seeds.
 *
 * German (de_DE) Jira names plus the classic English/legacy Jira scheme words. The English scheme
 * is the one a real instance actually ships (`Blocker`, `Critical`, `Major`, `Minor`, `Trivial`),
 * and none of those slug onto the seeded ladder (`blocker` ≠ `highest`), so without these every
 * import minted a generated key beside the seeded row — the exact German-name defect, in English.
 * `critical` maps to `highest`, not a `critical` row: the seeded ladder is
 * lowest/low/medium/high/highest, and `critical` is Jira's top urgency step.
 */
const SEEDED_PRIORITY_ALIASES: Readonly<Record<string, string>> = {
  hoechste: 'highest',
  hoch: 'high',
  mittel: 'medium',
  niedrig: 'low',
  niedrigste: 'lowest',
  blocker: 'highest',
  critical: 'highest',
  major: 'high',
  minor: 'low',
  trivial: 'lowest',
};

/**
 * @param slug `asciiSlug(status.name, …)` output.
 * @returns the seeded key to adopt, or `null` to fall through to the caller's own derivation.
 */
export function seededStatusKey(slug: string): string | null {
  return SEEDED_STATUS_ALIASES[slug] ?? null;
}

/**
 * @param slug `asciiSlug(priority.name, …)` output.
 * @returns the seeded key to adopt, or `null` to fall through to the caller's own derivation.
 */
export function seededPriorityKey(slug: string): string | null {
  return SEEDED_PRIORITY_ALIASES[slug] ?? null;
}
