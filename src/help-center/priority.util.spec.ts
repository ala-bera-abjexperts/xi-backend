/**
 * @fileoverview Unit tests for support-request priority bucketing + ladder resolution.
 * @module src/help-center/priority.util.spec
 */

import {
  priorityBucketForLadderRow,
  priorityBucketMatchesKey,
  resolvePriorityIdFromLadder,
  resolvePriorityKeyFromLadder,
  SUPPORT_REQUEST_PRIORITY_KEYS,
  toSupportRequestPriorityBucket,
  type PriorityLadderRow,
} from './priority.util';

// The seeded org ladder, in order. `space_id: null` = org-wide.
const ORG_LADDER: PriorityLadderRow[] = [
  { id: 'p-lowest', key: 'lowest', space_id: null },
  { id: 'p-low', key: 'low', space_id: null },
  { id: 'p-medium', key: 'medium', space_id: null },
  { id: 'p-high', key: 'high', space_id: null },
  { id: 'p-highest', key: 'highest', space_id: null },
  { id: 'p-critical', key: 'critical', space_id: null },
];

describe('toSupportRequestPriorityBucket', () => {
  it('returns a legal key unchanged', () => {
    for (const key of SUPPORT_REQUEST_PRIORITY_KEYS) {
      expect(toSupportRequestPriorityBucket(key)).toBe(key);
    }
  });

  it('maps the finer seeded ladder onto the four legal buckets', () => {
    expect(toSupportRequestPriorityBucket('lowest')).toBe('low');
    expect(toSupportRequestPriorityBucket('low')).toBe('low');
    expect(toSupportRequestPriorityBucket('medium')).toBe('medium');
    expect(toSupportRequestPriorityBucket('high')).toBe('high');
    expect(toSupportRequestPriorityBucket('highest')).toBe('critical');
    expect(toSupportRequestPriorityBucket('critical')).toBe('critical');
  });

  it('maps known scheme words semantically', () => {
    expect(toSupportRequestPriorityBucket('blocker')).toBe('critical');
    expect(toSupportRequestPriorityBucket('major')).toBe('high');
    expect(toSupportRequestPriorityBucket('minor')).toBe('low');
    expect(toSupportRequestPriorityBucket('trivial')).toBe('low');
    expect(toSupportRequestPriorityBucket('hoechste')).toBe('critical');
  });

  it('buckets a custom key positionally, preserving order', () => {
    // Four-step custom ladder p1..p4 → low, medium, high, critical.
    expect(toSupportRequestPriorityBucket('p1', 0, 4)).toBe('low');
    expect(toSupportRequestPriorityBucket('p2', 1, 4)).toBe('medium');
    expect(toSupportRequestPriorityBucket('p3', 2, 4)).toBe('high');
    expect(toSupportRequestPriorityBucket('p4', 3, 4)).toBe('critical');
  });

  it('never returns a value the CHECK constraint would reject, for any input', () => {
    const inputs = [
      '',
      'nonsense',
      'SEV_1',
      'hoechste',
      'p1',
      'lowest',
      'highest',
      'critical',
    ];

    for (const key of inputs) {
      expect(SUPPORT_REQUEST_PRIORITY_KEYS.has(toSupportRequestPriorityBucket(key))).toBe(true);
    }
  });
});

describe('priorityBucketMatchesKey', () => {
  it('matches a custom key to the same bucket', () => {
    expect(priorityBucketMatchesKey('low', 'lowest')).toBe(true);
    expect(priorityBucketMatchesKey('critical', 'highest')).toBe(true);
    expect(priorityBucketMatchesKey('medium', 'high')).toBe(false);
  });
});

describe('priorityBucketForLadderRow', () => {
  it('buckets by the row OWN ladder, not the merged one', () => {
    // A space ladder of two custom rows must not be interleaved with the org rows.
    const merged: PriorityLadderRow[] = [
      ...ORG_LADDER,
      { id: 's-a', key: 'p1', space_id: 'space-1' },
      { id: 's-b', key: 'p2', space_id: 'space-1' },
    ];

    expect(priorityBucketForLadderRow(merged, merged[6])).toBe('low');
    expect(priorityBucketForLadderRow(merged, merged[7])).toBe('critical');
  });

  it('uses the semantic alias for a single-entry custom ladder', () => {
    const ladder: PriorityLadderRow[] = [
      { id: 's-blocker', key: 'blocker', space_id: 'space-1' },
    ];

    expect(priorityBucketForLadderRow(ladder, ladder[0])).toBe('critical');
  });
});

describe('resolvePriorityIdFromLadder', () => {
  it('resolves a known id to its key + bucket', () => {
    expect(resolvePriorityIdFromLadder(ORG_LADDER, 'p-highest')).toEqual({
      key: 'highest',
      bucket: 'critical',
    });
  });

  it('returns null for an id outside the ladder', () => {
    expect(resolvePriorityIdFromLadder(ORG_LADDER, 'not-in-ladder')).toBeNull();
  });
});

describe('resolvePriorityKeyFromLadder', () => {
  it('prefers a space-scoped row over an org-wide row with the same key', () => {
    const ladder: PriorityLadderRow[] = [
      { id: 'org-medium', key: 'medium', space_id: null },
      { id: 'space-medium', key: 'medium', space_id: 'space-1' },
    ];

    expect(resolvePriorityKeyFromLadder(ladder, 'medium')?.id).toBe('space-medium');
  });

  it('falls back to the org-wide row when the space has none', () => {
    const ladder: PriorityLadderRow[] = [
      { id: 'org-high', key: 'high', space_id: null },
    ];

    expect(resolvePriorityKeyFromLadder(ladder, 'high')?.id).toBe('org-high');
  });

  it('returns null for an unknown key', () => {
    expect(resolvePriorityKeyFromLadder(ORG_LADDER, 'nope')).toBeNull();
  });
});
