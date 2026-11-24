/**
 * Reserved subdomain slugs — cannot be used as tenant slugs.
 *
 * MUST stay in lockstep with the frontend env var
 * `NEXT_PUBLIC_RESERVED_SUBDOMAINS` (see `.env.example` at the repo root).
 *
 * If you add/remove an entry here, also update the frontend env so the
 * onboarding-form validation rejects the same set the backend rejects.
 */
export const RESERVED_SLUGS = [
  'www',
  'api',
  'app',
  'auth',
  'admin',
  'status',
  'blog',
  'mail',
  'static',
  'assets',
  'cdn',
  'help',
  'support',
  'files',
  'public',
  'login',
  'signup',
  'billing',
  'marketing',
  'staging',
  'dev',
  'test',
] as const;

export const RESERVED_SLUG_SET: ReadonlySet<string> = new Set(RESERVED_SLUGS);

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUG_SET.has(slug.toLowerCase());
}
