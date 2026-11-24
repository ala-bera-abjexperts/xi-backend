/**
 * Tests for relation-type matching (pure — no DI, no jsdom).
 *
 * The bug being fixed: the original ladder ended `(relates ?? rows[0]).id`, so a Jira link type with
 * no XISUITE counterpart was silently RELABELLED rather than dropped. A "Causes" link showed up as
 * "Relates" and nothing in the run said so. These tests pin the ladder that replaces it, and
 * specifically that unmatched types now report `none` so the caller can create them.
 */

import {
  fallbackRelationType,
  matchRelationType,
  type RelationTypeRow,
} from './relation-type-match.util';

/** The seeded XISUITE set, as it exists in the live test org. */
const XISUITE: RelationTypeRow[] = [
  { id: 'blocks-id', name: 'Blocks' },
  { id: 'clones-id', name: 'Clones' },
  { id: 'depends-id', name: 'Depends' },
  { id: 'duplicates-id', name: 'Duplicates' },
  { id: 'relates-id', name: 'Relates' },
];

describe('matchRelationType', () => {
  describe('the four live Jira types all resolve without creating anything', () => {
    // Verified against http://167.233.94.130:8080/rest/api/2/issueLinkType.
    it.each([
      ['Blocks', 'blocks-id', 'exact'],
      ['Relates', 'relates-id', 'exact'],
      ['Cloners', 'clones-id', 'hint'],
      ['Duplicate', 'duplicates-id', 'hint'],
    ])(
      'maps Jira "%s" to %s via %s',
      (jiraName, expectedId, expectedAction) => {
        const result = matchRelationType(jiraName, XISUITE);

        expect(result.action).toBe(expectedAction);
        expect(result.action === 'none' ? null : result.id).toBe(expectedId);
      },
    );
  });

  describe('exact match', () => {
    it('ignores case', () => {
      expect(matchRelationType('BLOCKS', XISUITE)).toMatchObject({
        action: 'exact',
        id: 'blocks-id',
      });
    });

    it('ignores surrounding whitespace on both sides', () => {
      const rows = [{ id: 'x', name: '  Blocks  ' }];

      expect(matchRelationType(' blocks ', rows)).toMatchObject({
        action: 'exact',
        id: 'x',
      });
    });

    it('prefers an exact match over a hint', () => {
      // "Duplicate" exists exactly AND hints to "Duplicates"; exact must win.
      const rows = [
        { id: 'exact-id', name: 'Duplicate' },
        { id: 'hinted-id', name: 'Duplicates' },
      ];

      expect(matchRelationType('Duplicate', rows)).toMatchObject({
        action: 'exact',
        id: 'exact-id',
      });
    });
  });

  describe('hints cover Jira/XISUITE spelling drift, not arbitrary guessing', () => {
    it('maps Cloners to Clones', () => {
      expect(matchRelationType('Cloners', XISUITE)).toMatchObject({
        action: 'hint',
        id: 'clones-id',
      });
    });

    it('falls to Duplicates when Clones is absent', () => {
      const rows = [
        { id: 'dup-id', name: 'Duplicates' },
        { id: 'rel-id', name: 'Relates' },
      ];

      expect(matchRelationType('Cloners', rows)).toMatchObject({
        action: 'hint',
        id: 'dup-id',
      });
    });

    it('does NOT hint an unrelated type through to Relates (the regression)', () => {
      // The old NAME_HINTS listed 'relates' as a final hint for cloners/duplicate, which meant a
      // missing Clones row quietly turned a clone link into a generic one. Now it reports `none`
      // so the caller creates the real type instead.
      const rows = [{ id: 'rel-id', name: 'Relates' }];

      expect(matchRelationType('Cloners', rows).action).toBe('none');
    });
  });

  describe('unmatched types report none so the caller can CREATE them', () => {
    it('reports none for a Jira type with no counterpart', () => {
      const result = matchRelationType('Causes', XISUITE);

      expect(result.action).toBe('none');
      expect(result.reason).toContain('Causes');
    });

    it('never silently returns a generic type', () => {
      // This is the whole point of the change.
      const result = matchRelationType('Supersedes', XISUITE);

      expect(result.action).toBe('none');
      expect(result).not.toHaveProperty('id');
    });

    it('reports none when the org has no relation types at all', () => {
      expect(matchRelationType('Blocks', []).action).toBe('none');
    });

    it.each([
      ['an empty name', ''],
      ['whitespace only', '   '],
    ])('reports none for %s', (_label, name) => {
      expect(matchRelationType(name, XISUITE).action).toBe('none');
    });
  });
});

describe('fallbackRelationType', () => {
  it('prefers Relates', () => {
    expect(fallbackRelationType(XISUITE)).toEqual({
      id: 'relates-id',
      name: 'Relates',
    });
  });

  it('matches Relates case-insensitively', () => {
    const rows = [
      { id: 'a', name: 'Blocks' },
      { id: 'b', name: 'RELATES' },
    ];

    expect(fallbackRelationType(rows)?.id).toBe('b');
  });

  it('falls back to the first row when there is no Relates', () => {
    const rows = [
      { id: 'a', name: 'Blocks' },
      { id: 'b', name: 'Depends' },
    ];

    expect(fallbackRelationType(rows)?.id).toBe('a');
  });

  it('returns null when the org has no relation types', () => {
    expect(fallbackRelationType([])).toBeNull();
  });

  it('returns the whole row, so the caller can name the loss in its log', () => {
    // The fallback is lossy and must be auditable; an id alone cannot be logged usefully.
    expect(fallbackRelationType(XISUITE)).toHaveProperty('name');
  });
});
