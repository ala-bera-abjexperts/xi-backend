/**
 * @fileoverview The gate that decides whether a source user's email may become a real account.
 *
 * Kept pure and separate from `user.mapper` so it is directly testable: this is the one decision in
 * the migration that creates a login and sends mail to a real person, and getting it wrong is not
 * something a migration can take back.
 *
 * Two failure modes it exists to prevent:
 *  - **Masked addresses.** Jira returns `c***@e***.com` when the instance hides email visibility,
 *    and the adapter passes `emailAddress` through unvalidated. Creating an account for that gives
 *    someone a login nobody can reach.
 *  - **Shared mailboxes.** A real migration roster is full of service accounts — `administrator`,
 *    `b2b`, `service-1`, `ASPNET`. Mailing a set-password link to a role address is worse than
 *    leaving a placeholder, because it hands a login to whoever reads that inbox.
 *
 * @module src/migration/mappers/provisionable-email.util
 */

/** Non-routable domain used for synthetic placeholder addresses. */
export const PLACEHOLDER_DOMAIN = 'placeholder.invalid';

/** Local-parts that belong to a shared mailbox or a service account rather than to a person. */
const NON_PERSONAL_LOCAL_PARTS: ReadonlySet<string> = new Set([
  'admin',
  'administrator',
  'administratoren',
  'jira',
  'confluence',
  'system',
  'service',
  'support',
  'info',
  'office',
  'noreply',
  'no-reply',
  'test',
  'guest',
  'root',
  'postmaster',
]);

/**
 * @param email the source actor's address, already trimmed.
 * @returns whether an account may be created for it. Deliberately strict rather than
 *          RFC-complete — anything uncertain falls back to a placeholder, which loses nothing but
 *          a convenience.
 */
export function isProvisionableEmail(email: string): boolean {
  if (!email) return false;

  // A masked address (`c***@e***.com`) or any whitespace means we are not looking at a real inbox.
  if (email.includes('*') || /\s/.test(email)) return false;

  if (!/^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(email)) return false;

  if (email.toLowerCase().endsWith(`@${PLACEHOLDER_DOMAIN}`)) return false;

  const localPart = email.slice(0, email.indexOf('@')).toLowerCase();

  return !NON_PERSONAL_LOCAL_PARTS.has(localPart);
}
