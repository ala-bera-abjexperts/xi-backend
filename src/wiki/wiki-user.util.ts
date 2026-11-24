/** Columns the wiki UI shows for a person (comment author, page creator/updater). */
export const WIKI_USER_COLUMNS = 'id,first_name,last_name,email,avatar_url';

interface WikiUserRow {
  first_name?: string | null;
  last_name?: string | null;
  [key: string]: unknown;
}

/**
 * `public.users` has no `full_name` column, but the wiki UI renders
 * `full_name || email`. Derive it so the name shows instead of the email.
 */
export function withFullName(
  user: WikiUserRow | null | undefined,
): (WikiUserRow & { full_name: string | null }) | null {
  if (!user) return null;

  const fullName = [user.first_name, user.last_name]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(' ');

  return { ...user, full_name: fullName || null };
}
