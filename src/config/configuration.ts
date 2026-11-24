/**
 * @fileoverview Application configuration factory that maps environment variables into a typed
 * configuration object consumed by NestJS ConfigModule. Centralizes all runtime settings.
 * @module src/config/configuration
 * @author Prince Jadiya
 */

/**
 * Configuration factory function registered with `ConfigModule.forRoot({ load: [configuration] })`.
 *
 * Returns a nested configuration object with the following sections:
 * - `port` -- HTTP server port (default: 3001)
 * - `nodeEnv` -- Current environment (`development` | `production` | `test`)
 * - `frontendUrl` -- Allowed CORS origin for the frontend
 * - `appUrl` -- Base URL used in email links (invitation, password reset)
 * - `supabase` -- Supabase project URL, anon key, service role key, and JWT secret
 * - `smtp` -- SMTP mail transport settings (host, port, from address, password)
 *
 * @returns {object} The application configuration object
 */
import { tmpdir } from 'node:os';

/**
 * Positive integer from an env var, or `fallback` when unset or malformed.
 * @nestjs/throttler 6.7+ throws on a NaN limit/ttl (every guarded request 500s), where older
 * versions silently disabled throttling — so a typo must degrade to the default, not an outage.
 */
const positiveIntEnv = (
  value: string | undefined,
  fallback: number,
): number => {
  const parsed = parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export default () => ({
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  /**
   * Base URL for auth-subdomain deep-links in transactional emails (invitation,
   * password reset). In production this should be `https://auth.xisuite.cloud`.
   * Falls back to FRONTEND_URL so existing single-domain deployments are unaffected.
   */
  authUrl:
    process.env.AUTH_URL || process.env.FRONTEND_URL || 'http://localhost:3000',
  /** CORS allowlist (comma-separated env). credentials:true requires explicit origins. */
  allowedOrigins: (
    process.env.ALLOWED_ORIGINS ||
    process.env.FRONTEND_URL ||
    'http://localhost:3000'
  )
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  supabase: {
    /** @property {string} url - Supabase project URL */
    url: process.env.SUPABASE_URL,
    /** @property {string} anonKey - Supabase anonymous/public API key */
    anonKey: process.env.SUPABASE_ANON_KEY,
    /** @property {string} serviceRoleKey - Supabase service role key for admin operations */
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    /** @property {string} jwtSecret - Secret used to verify Supabase JWTs locally */
    jwtSecret: process.env.SUPABASE_JWT_SECRET,
  },
  cookies: {
    /** Cookie domain — empty string => host-only cookie (good for localhost dev). */
    domain: process.env.COOKIE_DOMAIN || '',
    /** Whether cookies require HTTPS. False for http://localhost dev. */
    secure: (process.env.COOKIE_SECURE || 'false').toLowerCase() === 'true',
    /** SameSite policy — lax is correct for first-party / same-site cross-port. */
    sameSite: (process.env.COOKIE_SAMESITE || 'lax') as
      | 'lax'
      | 'strict'
      | 'none',
    /** Access-token cookie max-age (seconds). Default 1h matches Supabase. */
    accessMaxAge: parseInt(process.env.COOKIE_ACCESS_MAXAGE || '3600', 10),
    /** Refresh-token cookie max-age (seconds). Default 7d. */
    refreshMaxAge: parseInt(process.env.COOKIE_REFRESH_MAXAGE || '604800', 10),
    /**
     * Active-organization cookie max-age (seconds). Matches refresh lifetime so
     * a returning user lands back on their last-active tenant for the full
     * session window. Default 7d.
     */
    activeOrgMaxAge: parseInt(
      process.env.COOKIE_ACTIVE_ORG_MAXAGE || '604800',
      10,
    ),
    /**
     * Secret used to HMAC-sign the active_org_id cookie value. Falls back to
     * SUPABASE_JWT_SECRET when COOKIE_SIGNING_SECRET is not set. The fallback
     * works but couples cookie integrity to JWT signing; setting a dedicated
     * secret is recommended in production. The AuthModule logs a one-time
     * warning at boot when the fallback is in use.
     */
    signingSecret:
      process.env.COOKIE_SIGNING_SECRET || process.env.SUPABASE_JWT_SECRET,
    /** True when COOKIE_SIGNING_SECRET was not set and we fell back. */
    signingSecretIsFallback: !process.env.COOKIE_SIGNING_SECRET,
  },
  /**
   * Secret used to sign OAuth state cookies. REQUIRED — env validation rejects
   * boot when missing. No hardcoded fallback because a known shared secret
   * means anyone can forge a valid `oauth_state` cookie.
   */
  sessionSigningSecret: process.env.SESSION_SIGNING_SECRET,
  /** Public URL of this NestJS instance — used to build OAuth callback URLs. */
  publicApiUrl:
    process.env.PUBLIC_API_URL ||
    `http://localhost:${parseInt(process.env.PORT || '3001', 10)}/api/v1`,
  /** Where GitLab project webhooks call this instance; falls back to `publicApiUrl`. */
  gitWebhookPublicUrl: process.env.GIT_WEBHOOK_PUBLIC_URL,
  saml: {
    /**
     * Base of the SAML SP URLs (Entity ID, ACS, metadata). Must be a
     * browser-facing host under COOKIE_DOMAIN so the ACS can set cookies.
     * Falls back to `publicApiUrl` when unset.
     */
    spBaseUrl: process.env.SAML_SP_BASE_URL,
  },
  /**
   * Throttler (rate-limit) configuration. Consumed by ThrottlerModule.forRootAsync
   * in app.module.ts. The tracker key is supplied by UserAwareThrottlerGuard:
   * per-user for authenticated requests, per-IP for anonymous. Per-route
   * `@Throttle` decorators override the global default.
   *
   * `TRUST_PROXY_HOPS` (read in main.ts, not here) controls how many proxy hops
   * to trust when resolving the client IP — critical for correct per-IP keys
   * behind Vercel/Nginx/ALB.
   */
  throttle: {
    /** Window in milliseconds. Default 60_000 (1 minute). */
    ttl: positiveIntEnv(process.env.THROTTLE_TTL, 60000),
    /** Max requests per window per tracker key. Default 100. */
    limit: positiveIntEnv(process.env.THROTTLE_LIMIT, 100),
  },
  passkeys: {
    /** Feature flag. Keep disabled until Supabase RP settings are deployed. */
    enabled:
      (process.env.PASSKEY_AUTH_ENABLED || 'false').toLowerCase() === 'true',
    /** Exact browser origin allowed to run WebAuthn ceremonies. */
    origin: process.env.PASSKEY_ORIGIN || '',
    /** Proxy-owned country header; absent geo data is deliberately neutral. */
    countryHeader: process.env.PASSKEY_COUNTRY_HEADER || '',
    /** Dedicated HMAC secret for opaque trusted-device tokens. */
    trustedDeviceSecret: process.env.PASSKEY_TRUSTED_DEVICE_SECRET || '',
    /** Fixed trusted-device lifetime. Expiry requires a fresh TOTP step-up. */
    trustedDeviceTtlDays: parseInt(
      process.env.PASSKEY_TRUSTED_DEVICE_TTL_DAYS || '90',
      10,
    ),
    /** Maximum age of the TOTP AMR used for passkey credential management. */
    recentTotpSeconds: parseInt(
      process.env.PASSKEY_RECENT_TOTP_SECONDS || '600',
      10,
    ),
    /** Server-side credential cap per account; the UI shows the same number. */
    maxPerUser: parseInt(process.env.PASSKEY_MAX_PER_USER || '10', 10),
  },
  smtp: {
    /**
     * Explicit mail delivery switch. Defaults to true only in production so
     * local/dev QA can keep real SMTP credentials in env without sending mail.
     */
    enabled:
      (
        process.env.SMTP_ENABLED ||
        (process.env.NODE_ENV === 'production' ? 'true' : 'false')
      ).toLowerCase() === 'true',
    /** @property {string} host - SMTP server hostname (default: smtp.office365.com) */
    host: process.env.SMTP_HOST || 'smtp.office365.com',
    /** @property {number} port - SMTP server port (default: 587) */
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    /** @property {string} from - Sender email address */
    from: process.env.EMAIL_FROM,
    /**
     * SMTP authentication username. Defaults to EMAIL_FROM (office365-style
     * relays authenticate with the mailbox address); set it when the relay's
     * login user differs from the sender address.
     */
    user: process.env.SMTP_USER || process.env.EMAIL_FROM,
    /** @property {string} pass - SMTP authentication password */
    pass: process.env.EMAIL_PASS,
    /**
     * Verify the relay's TLS certificate chain. Defaults to true in production
     * (matching the previous NODE_ENV-based behavior). Setting
     * SMTP_TLS_REJECT_UNAUTHORIZED=false is a LAST-RESORT escape hatch for
     * appliances whose CA cannot be exported — prefer trusting the CA via
     * NODE_EXTRA_CA_CERTS (on-prem: the deploy repo's ./certs/extra-ca.pem).
     */
    tlsRejectUnauthorized:
      (
        process.env.SMTP_TLS_REJECT_UNAUTHORIZED ||
        (process.env.NODE_ENV === 'production' ? 'true' : 'false')
      ).toLowerCase() === 'true',
  },
  /**
   * Git integrations (Tenant Configuration > Integrations). All OPTIONAL: a provider whose
   * values are missing reports `configured: false` and its Connect button is disabled.
   */
  git: {
    github: {
      appId: process.env.GITHUB_APP_ID,
      /** URL slug of the App (github.com/apps/<slug>). */
      appSlug: process.env.GITHUB_APP_SLUG,
      /** PEM. Literal "\n" sequences are accepted so it fits in a one-line env value. */
      privateKey: process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientId: process.env.GITHUB_APP_CLIENT_ID,
      clientSecret: process.env.GITHUB_APP_CLIENT_SECRET,
      webhookSecret: process.env.GITHUB_APP_WEBHOOK_SECRET,
    },
    gitlab: {
      clientId: process.env.GITLAB_OAUTH_CLIENT_ID,
      clientSecret: process.env.GITLAB_OAUTH_CLIENT_SECRET,
      baseUrl: (process.env.GITLAB_BASE_URL || 'https://gitlab.com').replace(
        /\/$/,
        '',
      ),
    },
    /** A multi-tenant Microsoft Entra app (read scopes only). */
    azureDevops: {
      clientId: process.env.AZURE_DEVOPS_CLIENT_ID,
      clientSecret: process.env.AZURE_DEVOPS_CLIENT_SECRET,
    },
  },
  stripe: {
    /** Secret API key used by backend-only checkout/product endpoints. */
    secretKey: process.env.STRIPE_SECRET_KEY,
    /** Webhook secret is intentionally optional until webhook routing moves to Nest. */
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  },
  /**
   * Vercel API config for Site Studio custom-domain TLS provisioning. All
   * OPTIONAL — when `token`/`projectId` are unset (dev, on-prem, local) the
   * VercelDomainsService no-ops, so domain verification still succeeds and only
   * the automatic certificate provisioning is skipped. `teamId` is required only
   * for team-scoped Vercel projects (omit for a personal account).
   */
  vercel: {
    /** Vercel API bearer token (scoped to the project's team). */
    token: process.env.VERCEL_TOKEN,
    /** Vercel project id that serves `*.xisuite.cloud` + custom domains. */
    projectId: process.env.VERCEL_PROJECT_ID,
    /** Team id for team-scoped projects (omit for personal accounts). */
    teamId: process.env.VERCEL_TEAM_ID,
  },
  /**
   * Site Studio custom-domain SERVING DNS target — where a customer points their
   * custom domain so it serves the published site + gets TLS. OPTIONAL overrides:
   * when unset, DomainsService resolves the default per deployment — Vercel
   * (`cname.vercel-dns.com` / `76.76.21.21`) on cloud, this deployment's own app
   * host (derived from `appUrl`) on-prem. Mirrored on the frontend by
   * `NEXT_PUBLIC_SITE_STUDIO_SERVING_TARGET` / `_APEX_IP`.
   */
  siteStudio: {
    /** CNAME target override for subdomain custom domains. */
    servingTarget: process.env.SITE_STUDIO_SERVING_TARGET,
    /** A-record target override for apex custom domains. */
    servingApexIp: process.env.SITE_STUDIO_SERVING_APEX_IP,
    /**
     * ON-PREM ONLY. Host:port of this deployment's own reverse proxy, as reachable
     * from inside the container network (the proxy registers APP_DOMAIN as a network
     * alias). Used to probe whether a customer's custom domain is genuinely served
     * here before the UI calls it "Live" — the check whose absence let a domain show
     * a green Live chip while every visitor got ERR_SSL_PROTOCOL_ERROR.
     * Rendered by the deploy script; absent on cloud, where Vercel owns serving.
     */
    edgeHost: process.env.SITE_STUDIO_EDGE_HOST,
    edgePort: Number(process.env.SITE_STUDIO_EDGE_PORT ?? 443),
    /**
     * ON-PREM ONLY. The custom domains the edge was actually configured to serve
     * (deploy renders the normalized list). Lets the API tell an operator the
     * difference between "DNS hasn't propagated" and "you never declared it in
     * client.conf" instead of guessing.
     */
    customDomains: (process.env.SITE_STUDIO_CUSTOM_DOMAINS ?? '')
      .split(/[\s,;]+/)
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
    /**
     * ON-PREM ONLY. `true` when the edge serves ANY verified custom domain automatically
     * (on-demand ACME, or a catch-all vhost on the local certificate). There is then no
     * per-domain list to be absent from, so the API must not tell an operator to declare
     * a domain — it reports only what the reachability probe found.
     */
    autoDomains: ['true', '1', 'yes'].includes(
      (process.env.SITE_STUDIO_AUTO_DOMAINS ?? '').trim().toLowerCase(),
    ),
    /**
     * ON-PREM ONLY. `true` when an EXTERNAL edge (an upstream load balancer) owns TLS
     * for custom domains — i.e. EDGE_MODE=behind-proxy, or the operator said so. We
     * then cannot meaningfully probe an edge we do not control, so a verified domain
     * is reported live on the operator's word. Defaults to false, which is what makes
     * the status evidence-based rather than assumed.
     */
    assumeExternalTls: ['true', '1', 'yes'].includes(
      (process.env.SITE_STUDIO_ASSUME_EXTERNAL_TLS ?? '').trim().toLowerCase(),
    ),
    /** ON-PREM ONLY. Published-URL shape: 'path' (default) or 'subdomain'. */
    urlMode:
      process.env.SITE_STUDIO_URL_MODE === 'subdomain' ? 'subdomain' : 'path',
  },
  // MCP service-to-service (S2S) verification config. The MCP server mints a
  // short-lived HS256 JWT and presents it in `X-MCP-S2S-Authorization`; the
  // McpServiceTokenGuard verifies it with this secret. `signingSecret` is
  // dedicated (never SUPABASE_JWT_SECRET) and absent in dev when the MCP path
  // is unused, in which case the guard fail-closes any S2S token at runtime.
  mcpS2s: {
    /** Shared HMAC-SHA256 secret (must match xisuite-mcp's MCP_S2S_SIGNING_SECRET). */
    signingSecret: process.env.MCP_S2S_SIGNING_SECRET,
    /** Pinned token issuer (default `xisuite-mcp`). */
    issuer: process.env.MCP_S2S_ISSUER || 'xisuite-mcp',
    /** Pinned token audience (default `xisuite-backend`). */
    audience: process.env.MCP_S2S_AUDIENCE || 'xisuite-backend',
    /** Clock skew (seconds) tolerated on exp/nbf during verification. */
    clockSkewSeconds: parseInt(
      process.env.MCP_S2S_CLOCK_SKEW_SECONDS || '5',
      10,
    ),
  },
  /**
   * On-premise deployment mode + the in-product update sidecar. `enabled` gates
   * the entire OnPremUpdatesModule: when false (the SaaS default), the module is
   * never imported, so none of its routes are registered. Set only by the on-prem
   * deployer (render-env.sh writes IS_ON_PREMISE=true + the updater coordinates).
   */
  onPrem: {
    /** True only on a self-hosted on-prem stack. Accepts true/1/yes. */
    enabled: ['true', '1', 'yes'].includes(
      (process.env.IS_ON_PREMISE || '').trim().toLowerCase(),
    ),
    /** Internal URL of the update sidecar (e.g. http://xisuite-updater:9000). */
    updaterUrl: process.env.UPDATE_AGENT_URL || '',
    /** Shared secret presented to the sidecar (X-Update-Secret). */
    updaterSecret: process.env.UPDATE_AGENT_SECRET || '',
    /** The release this stack was deployed at — shown as the current version. */
    release: process.env.APP_RELEASE || '',
    /** `kubernetes` when the cluster (Helm/GitOps) owns upgrades; empty for Docker Compose. */
    deployPlatform: (process.env.DEPLOY_PLATFORM || '').toLowerCase(),
    /**
     * The single organization this install serves. On-prem is single-tenant, so
     * these pin which org a newly authenticated user is attached to instead of
     * being sent to onboarding. Either may be set; the id wins when both are.
     * Both empty is valid — a fresh install has no org yet and the first user
     * creates it through onboarding.
     */
    orgId: process.env.ON_PREMISE_ORG_ID || '',
    orgSlug: process.env.ON_PREMISE_ORG_SLUG || '',
    /**
     * Role given to auto-joined users. Defaults to `member` — self-service signup
     * must never confer ownership of the tenant. Must be one of
     * owner|admin|member|viewer (the organization_members CHECK constraint).
     */
    defaultRole: process.env.ON_PREMISE_DEFAULT_ROLE || '',

    /**
     * Vendor endpoint this box polls for its licence, e.g.
     * https://api.xisuite.cloud/api/v1/onprem/license/check
     *
     * Deliberately NOT reused from UPDATE_MANIFEST_URL: that variable is read
     * only by the updater sidecar and never reaches backend.env. Empty disables
     * polling entirely, which is the correct state for a fully air-gapped box
     * that activates from an imported file instead.
     */
    licenseApiUrl: process.env.LICENSE_API_URL || '',

    /**
     * Per-installation activation code, minted SaaS-side. This is the box's
     * only credential and the only thing that maps it to a tenant.
     */
    licenseActivationCode: process.env.LICENSE_ACTIVATION_CODE || '',
  },

  /**
   * SaaS-side signing material for on-prem licence artifacts. Present only on
   * the vendor's own deployment; an on-prem image never carries a private key.
   *
   * The matching PUBLIC key is compiled into the image
   * (licensing/artifact/license-artifact.crypto.ts) rather than read from env,
   * because an env-supplied public key could be swapped by the customer for one
   * whose private half they hold.
   */
  onPremLicense: {
    /** PKCS#8 PEM, from the SaaS secret store. Never shipped to a customer. */
    signingKeyPem: process.env.ONPREM_LICENSE_SIGNING_KEY || '',
    /** Key id embedded in issued artifacts, so keys can be rotated. */
    signingKeyId: process.env.ONPREM_LICENSE_SIGNING_KEY_ID || 'v1',
  },

  /**
   * Backup & Restore scheduler.
   *
   * Defaults live here rather than in envSchema because validateEnv returns the raw config, so a
   * Zod `.default()` never reaches ConfigService (same reason MCP_S2S_ISSUER is defaulted twice).
   */
  backup: {
    /**
     * Off unless explicitly enabled. Dev machines and production replicas share one Supabase
     * project here, so an on-by-default scheduler would let a laptop export a customer's tenant to
     * their real SFTP server.
     */
    schedulerEnabled: ['true', '1', 'yes'].includes(
      (process.env.BACKUP_SCHEDULER_ENABLED || '').trim().toLowerCase(),
    ),

    /**
     * Where a table's alternate-format export is spooled before being added to the archive.
     *
     * Spooling is unavoidable: archiver processes one entry at a time, so writing two members
     * concurrently deadlocks, and SheetJS cannot stream at all. Nothing else in this codebase
     * touches the filesystem, which is exactly why the directory is configurable and probed at the
     * start of every run rather than assumed.
     */
    spoolDir: (process.env.BACKUP_SPOOL_DIR || '').trim() || tmpdir(),

    /**
     * Ceiling on one table's spooled export. Reached means the run fails naming the table, rather
     * than filling the disk of whatever else shares this host.
     */
    spoolMaxBytes: Number(process.env.BACKUP_SPOOL_MAX_BYTES) || 2_147_483_648,

    /**
     * Whether a restore may read its archive from the Supabase Storage cache instead of pulling it
     * from the backup target again.
     *
     * ON by default, unlike `schedulerEnabled`: this one cannot reach a customer's SFTP server or
     * write anything outside this project, and off means every restore re-downloads a file it
     * already has. Turning it off makes a restore behave exactly as it did before the cache existed
     * — nothing is read from storage and nothing is written there — which is the rollback that does
     * not need a deploy.
     */
    restoreCacheEnabled: !['false', '0', 'no'].includes(
      (process.env.BACKUP_RESTORE_CACHE_ENABLED || '').trim().toLowerCase(),
    ),
  },
});
