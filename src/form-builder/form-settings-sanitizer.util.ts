/**
 * Schemes a post-submit browser redirect may use.
 *
 * Deliberately NOT the SSRF allowlist (`common/security/ssrf-guard.ts`), which
 * is https-only and blocks private ranges — correct for server-side fetches,
 * wrong here. This is a navigation the visitor's browser performs, and on-prem
 * deployments legitimately redirect to plain-http intranet hosts.
 */
const ALLOWED_REDIRECT_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * True when `value` is a browser-navigable absolute URL.
 *
 * Rejects `javascript:`, `data:`, `vbscript:`, `file:` and anything unparseable.
 * Relative URLs are rejected too: without a base they are ambiguous, and the
 * only caller wants an explicit destination.
 *
 * @param value Candidate redirect target.
 * @returns Whether the value is safe to hand to `window.location.href`.
 */
export function isSafeRedirectUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;

  try {
    // `new URL` lowercases and normalizes the scheme, so obfuscations like
    // `JaVaScRiPt:` and leading/trailing whitespace collapse to the real value
    // before the allowlist is consulted.
    return ALLOWED_REDIRECT_PROTOCOLS.has(new URL(value.trim()).protocol);
  } catch {
    return false;
  }
}

/**
 * Returns a copy of `settings` with unsafe values removed.
 *
 * Unknown keys pass through untouched — `settings` is an intentionally open
 * blob (`task_integration`, `styles`, `approval`, … all live here) and this
 * sanitizer must not become a whitelist that silently drops new features.
 *
 * @param settings The caller-supplied settings object.
 * @returns A sanitized shallow copy, or the input unchanged when it is not an
 *   object (the DB column has its own NOT NULL default).
 */
export function sanitizeFormSettings<T>(settings: T): T {
  if (
    settings === null ||
    typeof settings !== 'object' ||
    Array.isArray(settings)
  ) {
    return settings;
  }

  const source = settings as Record<string, unknown>;

  if (!('redirect_url' in source)) return settings;

  const candidate = source.redirect_url;

  // An explicitly cleared redirect (empty string / null) is a legitimate edit
  // meaning "show the success message instead" — preserve it as-is.
  if (candidate === null || candidate === undefined || candidate === '') {
    return settings;
  }

  if (isSafeRedirectUrl(candidate)) return settings;

  // Drop rather than throw: a rejected redirect must not block an otherwise
  // valid settings save, and the UI validates this field before submitting, so
  // reaching here means either a stale client or a hand-crafted request.
  const sanitized = { ...source };

  delete sanitized.redirect_url;

  return sanitized as T;
}
