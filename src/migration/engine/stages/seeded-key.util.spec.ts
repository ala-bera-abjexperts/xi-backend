/**
 * Unit tests for the localized-name → seeded-key aliases (pure — no DI, no DB).
 *
 * These aliases are what let a German instance ADOPT the seeded org-level rows instead of minting a
 * duplicate beside each one. A real customer run created four duplicate resolutions and would have
 * created duplicate statuses and priorities too, because every adopt ladder in the engine is
 * key-first and a German name never slugs to the English seeded key.
 *
 * Inputs here are `asciiSlug` output (which transliterates `ö → oe`), NOT raw display names.
 */

import { asciiSlug } from '../../util/slug.util';
import { seededPriorityKey, seededStatusKey } from './seeded-key.util';

describe('seededStatusKey', () => {
  it.each([
    ['Zu erledigen', 'open'],
    ['Offen', 'open'],
    ['In Arbeit', 'in_progress'],
    ['In Bearbeitung', 'in_progress'],
    ['Fertig', 'done'],
    ['Erledigt', 'done'],
    ['Geschlossen', 'closed'],
  ])('German "%s" adopts the seeded %s', (name, expected) => {
    expect(seededStatusKey(asciiSlug(name, 'status', '1'))).toBe(expected);
  });

  it('English "To Do" also adopts `open` — the one entry that changes English behaviour', () => {
    // Without this, `To Do` slugs to `to_do` and duplicates the seeded `open` on every import.
    expect(asciiSlug('To Do', 'status', '1')).toBe('to_do');
    expect(seededStatusKey('to_do')).toBe('open');
  });

  it('returns null for anything unknown so the caller derives its own key', () => {
    expect(seededStatusKey('warte_auf_genehmigung')).toBeNull();
    expect(seededStatusKey('in_pruefung')).toBeNull();
    expect(seededStatusKey('')).toBeNull();
  });
});

describe('seededPriorityKey', () => {
  it.each([
    ['Höchste', 'highest'],
    ['Hoch', 'high'],
    ['Mittel', 'medium'],
    ['Niedrig', 'low'],
    ['Niedrigste', 'lowest'],
  ])('German "%s" adopts the seeded %s', (name, expected) => {
    expect(seededPriorityKey(asciiSlug(name, 'priority', '1'))).toBe(expected);
  });

  it('depends on asciiSlug transliterating the umlaut, not stripping it', () => {
    // NFKD alone would give `hochste`, which is in no table. This is why resolutions keep a
    // separate alias table from this one.
    expect(asciiSlug('Höchste', 'priority', '1')).toBe('hoechste');
  });

  it.each([
    ['Blocker', 'highest'],
    ['Critical', 'highest'],
    ['Major', 'high'],
    ['Minor', 'low'],
    ['Trivial', 'lowest'],
  ])('English/legacy Jira "%s" adopts the seeded %s', (name, expected) => {
    // None of these slug onto the seeded ladder (`blocker` ≠ `highest`), so without the alias every
    // import mints a generated key beside the seeded row — the German-name defect, in English.
    expect(asciiSlug(name, 'priority', '1')).not.toBe(expected);
    expect(seededPriorityKey(asciiSlug(name, 'priority', '1'))).toBe(expected);
  });

  it('maps `critical` onto `highest` — the seeded ladder has no `critical` rung', () => {
    expect(seededPriorityKey('critical')).toBe('highest');
  });

  it('returns null for anything unknown so the caller derives its own key', () => {
    expect(seededPriorityKey('kritisch')).toBeNull();
    expect(seededPriorityKey('p1')).toBeNull();
    expect(seededPriorityKey('')).toBeNull();
  });

  it('leaves the English defaults alone — they already slug onto the seeded keys', () => {
    for (const name of ['Highest', 'High', 'Medium', 'Low', 'Lowest']) {
      const slug = asciiSlug(name, 'priority', '1');

      expect(seededPriorityKey(slug)).toBeNull();
      expect(slug).toBe(name.toLowerCase());
    }
  });
});
