/**
 * @fileoverview Space-key derivation. `spaces.key` is short (≤ 8 chars) and unique
 * per organization; Jira project keys can be longer and can collide with existing
 * spaces — derive, truncate, and suffix deterministically. The caller's `isTaken`
 * must check BOTH existing org spaces AND keys already derived in this run.
 */

export interface DerivedSpaceKey {
  key: string;
  truncated: boolean;
  suffixed: boolean;
}

const MAX_KEY_LENGTH = 8;

export async function deriveSpaceKey(
  jiraKey: string,
  isTaken: (candidate: string) => Promise<boolean>,
): Promise<DerivedSpaceKey> {
  const normalized = jiraKey.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const base = normalized.slice(0, MAX_KEY_LENGTH) || 'PROJ';
  const truncated = base.length < normalized.length;

  if (!(await isTaken(base))) return { key: base, truncated, suffixed: false };

  // Collision → shrink the stem to make room for a numeric suffix, total ≤ 8.
  for (let n = 1; n < 1000; n++) {
    const suffix = String(n);
    const stem = base.slice(0, MAX_KEY_LENGTH - suffix.length);
    const candidate = `${stem}${suffix}`;

    if (!(await isTaken(candidate))) {
      return { key: candidate, truncated, suffixed: true };
    }
  }

  throw new Error(`Could not derive a unique space key from "${jiraKey}"`);
}
