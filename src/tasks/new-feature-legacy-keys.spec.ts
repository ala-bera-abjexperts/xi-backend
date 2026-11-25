import {
  LEGACY_PRIORITY_KEYS,
  toLegacyPriorityText,
} from './legacy-priority.util';
import { LEGACY_STATUS_KEYS, toLegacyStatusText } from './legacy-status.util';

describe('legacy keys the database accepts', () => {
  it('lists the six priorities', () => {
    expect([...LEGACY_PRIORITY_KEYS]).toEqual([
      'lowest',
      'low',
      'medium',
      'high',
      'highest',
      'critical',
    ]);
  });

  it('lists the six statuses', () => {
    expect([...LEGACY_STATUS_KEYS]).toEqual([
      'open',
      'in_progress',
      'review',
      'done',
      'closed',
      'blocked',
    ]);
  });

  it('always returns a priority the database accepts', () => {
    for (const key of ['hoch', 'p1', 'sev_2', 'custom', 'critical']) {
      expect(LEGACY_PRIORITY_KEYS.has(toLegacyPriorityText(key, 1, 4))).toBe(
        true,
      );
    }
  });

  it('always returns a status the database accepts', () => {
    for (const key of ['todo', 'in_review', 'warte', 'blocked']) {
      expect(LEGACY_STATUS_KEYS.has(toLegacyStatusText(key, false, null))).toBe(
        true,
      );
    }
  });
});
