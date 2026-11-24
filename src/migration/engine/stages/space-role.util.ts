/**
 * @fileoverview Jira project role name → canonical XISUITE space role.
 *
 * Extracted from `roles.stage` so it is directly testable: the stage itself needs a full
 * `StageContext`, while the decision that actually matters is one pure string comparison.
 *
 * This was `/^administrators?$/i`, which silently demoted EVERY project administrator on a German
 * instance — Jira ships the role as `Administratoren`, the regex missed, and the fallthrough to
 * `member` logged nothing. A whole customer's admins arrived as ordinary members.
 *
 * Matching stays on the NAME rather than the role id. Jira's ids look stable (`Administrators` is
 * 10002 on a fresh bootstrap) but are not: an instance whose roles were deleted and recreated, or
 * upgraded across major versions, numbers them differently. The failure modes are asymmetric — the
 * bug this fixes UNDER-privileges, whereas a wrong id rung would silently GRANT admin to a role
 * nobody meant. Under-privileging is the safer way to be wrong, so the ladder reports what it could
 * not match instead of guessing.
 *
 * @module src/migration/engine/stages/space-role.util
 */

/**
 * Role names that mean "project administrator", normalized (trimmed, lowercased).
 * en: `administrators` / `administrator` · de: `administratoren`.
 */
const ADMIN_ROLE_NAMES: ReadonlySet<string> = new Set([
  'administrators',
  'administrator',
  'administratoren',
]);

/**
 * @param roleName the source role's display name, in whatever language the instance runs.
 * @returns the canonical space role, plus whether the name was actually recognized. `matched:false`
 *          with `role:'member'` is the correct outcome for `Entwickler`/`Developers`/`Benutzer` — it
 *          is reported so an unrecognized ADMIN name in a new locale surfaces in the run log rather
 *          than as a support ticket months later.
 */
export function mapSpaceRole(roleName: string): {
  role: 'admin' | 'member';
  matched: boolean;
} {
  const normalized = (roleName ?? '').trim().toLowerCase();

  return ADMIN_ROLE_NAMES.has(normalized)
    ? { role: 'admin', matched: true }
    : { role: 'member', matched: false };
}
