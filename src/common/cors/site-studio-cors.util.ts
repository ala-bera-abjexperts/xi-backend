type SupabaseQuery = {
  eq(column: string, value: unknown): SupabaseQuery;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
};

export type SupabaseLookupClient = {
  from(table: string): {
    select(columns: string): SupabaseQuery;
  };
};

export interface OriginCacheEntry {
  allowed: boolean;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const PUBLIC_SITE_STUDIO_CORS_PATHS = [
  '/api/v1/public/site-studio',

  // Standalone published form pages (/forms/{slug}). Matching is by literal
  // prefix, not path segment, so this is NOT covered by the site-studio entry
  // above and must be listed separately. Without it the only CORS layer is the
  // global `enableCors`, whose allowlist covers configured origins and their
  // subdomains but never a customer's verified custom domain — and the failure
  // is invisible in development, where the Next proxy makes these requests
  // same-origin so CORS is never evaluated at all.
  '/api/v1/public/forms',

  '/api/v1/stripe/create-checkout-session',
  '/api/v1/stripe/checkout-status',
];

export function isPublicSiteStudioCorsPath(path: string): boolean {
  const normalizedPath = path.split('?')[0] ?? path;

  return PUBLIC_SITE_STUDIO_CORS_PATHS.some((allowedPath) => {
    return (
      normalizedPath === allowedPath ||
      normalizedPath.startsWith(`${allowedPath}/`)
    );
  });
}

export function isAllowedConfiguredOrSubdomainOrigin(
  origin: string,
  allowedOrigins: string[],
): boolean {
  let requested: URL;

  try {
    requested = new URL(origin);
  } catch {
    return false;
  }

  return allowedOrigins.some((allowedOrigin) => {
    try {
      const allowed = new URL(allowedOrigin);

      if (requested.origin === allowed.origin) return true;

      return (
        requested.protocol === allowed.protocol &&
        requested.host.endsWith(`.${allowed.host}`)
      );
    } catch {
      return false;
    }
  });
}

export function isExactConfiguredOrigin(
  origin: string,
  allowedOrigins: string[],
): boolean {
  let requested: URL;

  try {
    requested = new URL(origin);
  } catch {
    return false;
  }

  return allowedOrigins.some((allowedOrigin) => {
    try {
      return requested.origin === new URL(allowedOrigin).origin;
    } catch {
      return false;
    }
  });
}

export async function isVerifiedSiteStudioCustomDomainOrigin(
  origin: string,
  client: SupabaseLookupClient,
  cache = new Map<string, OriginCacheEntry>(),
  now = Date.now(),
  organizationId?: string,
  allowInsecureOrigin = false,
): Promise<boolean> {
  let url: URL;

  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  // Cloud is https-only. On-prem legitimately is not always: an operator may run the
  // edge on plain HTTP behind a TLS-terminating corporate load balancer, or during
  // bring-up before certificates exist. Rejecting those outright blocked every public
  // SiteStudio XHR with an opaque CORS error and no clue why, so the caller may opt in.
  if (
    url.protocol !== 'https:' &&
    !(allowInsecureOrigin && url.protocol === 'http:')
  ) {
    return false;
  }

  // `url.host` INCLUDES the port, while `site_studio_domains.domain` stores a bare
  // hostname — so on any edge not listening on 443 (a very common on-prem case; see
  // ports.sh's 8443 fallback) the lookup could never match and CORS silently failed.
  const host = url.hostname.toLowerCase();
  const cacheKey = organizationId ? `${host}:${organizationId}` : host;
  const cached = cache.get(cacheKey);

  if (cached && cached.expiresAt > now) return cached.allowed;

  let query = client
    .from('site_studio_domains')
    .select('id')
    .eq('domain', host)
    .eq('verified', true);

  if (organizationId) {
    query = query.eq('organization_id', organizationId);
  }

  const { data, error } = await query.maybeSingle();

  const allowed = !error && Boolean(data);

  if (allowed) {
    cache.set(cacheKey, {
      allowed,
      expiresAt: now + CACHE_TTL_MS,
    });
  }

  return allowed;
}
