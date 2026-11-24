/**
 * @fileoverview Minimal glob → RegExp matcher for git branch patterns.
 * Supports `*` (any run of chars, including `/`) and `?` (a single char). Every
 * other character is treated literally (all regex metacharacters are escaped),
 * so patterns like `feature/*`, `feature/test-demo*`, and `release/v*` behave
 * intuitively. Matching is case-sensitive (git branch names are case-sensitive).
 * @module src/git-triggers/glob-match.util
 */

/**
 * Compile a glob pattern into an anchored, case-sensitive RegExp.
 *
 * Escapes every regex metacharacter FIRST (so a literal `.` in the pattern
 * stays literal), then restores the two glob wildcards: `*` → `.*`, `?` → `.`.
 * Only bounded `.*`/`.` are produced, so there is no ReDoS surface.
 */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = escaped.replace(/\\\*/g, '.*').replace(/\\\?/g, '.');

  return new RegExp(`^${body}$`);
}

/** True when `branch` matches the glob `pattern`. Invalid patterns → false. */
export function globMatch(pattern: string, branch: string): boolean {
  try {
    return globToRegExp(pattern).test(branch);
  } catch {
    return false;
  }
}
