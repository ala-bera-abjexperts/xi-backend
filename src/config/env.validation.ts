/**
 * @fileoverview Zod-based environment variable validation schema and validator function.
 * Ensures all required environment variables are present and well-formed at startup,
 * throwing in production and logging warnings in development/test.
 * @module src/config/env.validation
 * @author Prince Jadiya
 */

import { z } from 'zod';

/**
 * Zod schema that defines every expected environment variable, its type, and default value.
 *
 * Required variables (no default):
 * - `SUPABASE_URL` -- Supabase project URL
 * - `SUPABASE_ANON_KEY` -- Supabase anonymous key
 * - `SUPABASE_SERVICE_ROLE_KEY` -- Supabase service role key
 * - `SUPABASE_JWT_SECRET` -- JWT signing secret
 *
 * Optional variables with defaults:
 * - `PORT` (default `"3001"`)
 * - `NODE_ENV` (default `"development"`)
 * - `FRONTEND_URL` / `APP_URL` (default `"http://localhost:3000"`)
 * - `SMTP_HOST`, `SMTP_PORT`, `EMAIL_FROM`, `EMAIL_PASS` (all optional)
 */
export const envSchema = z
  .object({
    PORT: z.string().default('3001'),
    NODE_ENV: z
      .enum(['development', 'production', 'test'])
      .default('development'),
    FRONTEND_URL: z.string().url().default('http://localhost:3000'),
    APP_URL: z.string().url().default('http://localhost:3000'),
    SUPABASE_URL: z.string().min(1, 'SUPABASE_URL is required'),
    SUPABASE_ANON_KEY: z.string().min(1, 'SUPABASE_ANON_KEY is required'),
    SUPABASE_SERVICE_ROLE_KEY: z
      .string()
      .min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
    // Reject the placeholder explicitly. Without this, a misconfigured prod boot
    // silently degrades the auth guard to per-request network verification.
    // Min length raised to 32 — Supabase issues 64-char secrets; anything shorter
    // is almost certainly a misconfiguration that will produce silent 401 cascades
    // (Next.js middleware can't verify JWTs signed with the real key).
    SUPABASE_JWT_SECRET: z
      .string()
      .min(32, 'SUPABASE_JWT_SECRET must be at least 32 chars')
      .refine((s) => !s.includes('__SET_ME'), {
        message:
          'SUPABASE_JWT_SECRET is still a placeholder — set it from the Supabase dashboard',
      }),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.string().optional(),
    SMTP_ENABLED: z.enum(['true', 'false']).optional(),
    // Auth username when the relay's login differs from EMAIL_FROM (defaults to EMAIL_FROM).
    SMTP_USER: z.string().optional(),
    // LAST-RESORT: disable relay TLS chain verification. Prefer NODE_EXTRA_CA_CERTS /
    // the on-prem deploy's ./certs/extra-ca.pem; 'false' logs a prominent boot warning.
    SMTP_TLS_REJECT_UNAUTHORIZED: z.enum(['true', 'false']).optional(),
    EMAIL_FROM: z.string().optional(),
    EMAIL_PASS: z.string().optional(),
    // Cookie config (auth migration — Phase 1)
    COOKIE_DOMAIN: z.string().optional(),
    COOKIE_SECURE: z.string().optional(),
    COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).optional(),
    COOKIE_ACCESS_MAXAGE: z.string().optional(),
    COOKIE_REFRESH_MAXAGE: z.string().optional(),
    COOKIE_ACTIVE_ORG_MAXAGE: z.string().optional(),
    // Signs the value side of the active_org_id cookie (HMAC-SHA256). Optional —
    // when absent, the active-org cookie helpers fall back to SUPABASE_JWT_SECRET
    // and the AuthModule logs a one-time boot warning advising operators to set
    // a dedicated secret. Required to be ≥32 chars when present.
    COOKIE_SIGNING_SECRET: z
      .string()
      .min(32, 'COOKIE_SIGNING_SECRET must be at least 32 chars')
      .optional(),
    ALLOWED_ORIGINS: z.string().optional(),
    // Throttler tuning (rate limits applied per-user when authenticated, per-IP
    // when anonymous via UserAwareThrottlerGuard). All optional — defaults are
    // 100/60s in configuration.ts.
    THROTTLE_TTL: z.string().optional(),
    THROTTLE_LIMIT: z.string().optional(),
    // Number of reverse-proxy hops to trust when resolving req.ip. 0 = never
    // trust X-Forwarded-For (local dev). 1 = trust a single proxy (typical prod).
    // Read in main.ts. Setting too high lets clients spoof their IP.
    TRUST_PROXY_HOPS: z.string().optional(),
    PASSKEY_AUTH_ENABLED: z.enum(['true', 'false']).default('false'),
    PASSKEY_ORIGIN: z.string().url().optional(),
    PASSKEY_TRUSTED_DEVICE_SECRET: z
      .string()
      .min(32, 'PASSKEY_TRUSTED_DEVICE_SECRET must be at least 32 chars')
      .optional(),
    PASSKEY_COUNTRY_HEADER: z
      .string()
      .regex(
        /^[a-z0-9-]+$/,
        'PASSKEY_COUNTRY_HEADER must be a lowercase HTTP header name',
      )
      .optional(),
    PASSKEY_TRUSTED_DEVICE_TTL_DAYS: z
      .string()
      .regex(/^\d+$/, 'PASSKEY_TRUSTED_DEVICE_TTL_DAYS must be an integer')
      .optional(),
    PASSKEY_RECENT_TOTP_SECONDS: z
      .string()
      .regex(/^\d+$/, 'PASSKEY_RECENT_TOTP_SECONDS must be an integer')
      .optional(),
    // Treat an empty string as unset. `.optional()` alone does NOT: a deploy
    // template like `PASSKEY_MAX_PER_USER=${PASSKEY_MAX_PER_USER}` with the
    // outer variable unset yields '', the regex fails, and in production
    // validateEnv throws -- the app never boots and EVERY auth path dies at
    // once. An unset optional tuning knob must never be able to do that.
    PASSKEY_MAX_PER_USER: z
      .string()
      .transform((value) => (value.trim() === '' ? undefined : value))
      .refine(
        (value) => value === undefined || /^\d+$/.test(value),
        'PASSKEY_MAX_PER_USER must be an integer',
      )
      .optional(),
    // Required: signs OAuth state JWTs. A weak/known fallback would let any
    // attacker forge a valid `oauth_state` cookie and pivot OAuth callbacks.
    SESSION_SIGNING_SECRET: z
      .string()
      .min(32, 'SESSION_SIGNING_SECRET must be at least 32 chars'),
    // Public origin of this NestJS instance. Used to register the OAuth callback
    // URL with Supabase. Optional in dev (falls back to localhost), required in prod.
    PUBLIC_API_URL: z.string().url().optional(),
    // Public /api/v1 address GitLab webhooks call, when PUBLIC_API_URL is not reachable from GitLab (local dev).
    GIT_WEBHOOK_PUBLIC_URL: z.string().url().optional(),
    // Base of the SAML SP URLs (Entity ID, ACS, metadata). Optional, falls back
    // to PUBLIC_API_URL. Must be a browser-facing host under COOKIE_DOMAIN.
    SAML_SP_BASE_URL: z.string().url().optional(),
    // Stripe checkout integration. Optional so local/dev environments without
    // billing configured can still boot; Stripe endpoints return clean errors.
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    // On-prem installs keep their SFTP backup server on an RFC1918 address, which the shared SSRF
    // guard blocks unconditionally. Setting this widens the allowance to RFC1918 and IPv6 unique-local
    // ONLY — loopback, link-local (including the cloud metadata endpoint), 0/8, CGNAT and multicast
    // stay blocked either way.
    //
    // Server-side and optional by design: it must never become a tenant-settable field, because a
    // tenant admin able to tick "allow private networks" would have a one-click internal port scanner
    // with a credential prompt. Optional so its absence cannot kill the boot.
    BACKUP_SFTP_ALLOW_PRIVATE_NETWORKS: z.enum(['true', 'false']).optional(),
    // MCP service-to-service (S2S) auth.
    // Shared HMAC secret used to verify the short-lived S2S JWT minted by the MCP
    // server (`xisuite-mcp`). It is dedicated; never reuse SUPABASE_JWT_SECRET.
    // Mirrors the SUPABASE_JWT_SECRET validation: >= 32 chars, placeholder rejected.
    // Optional in both dev and prod so a backend without the MCP path configured
    // still boots (validateEnv below only emits a non-fatal warning when it is
    // absent in production); the S2S guard then fail-closes any S2S token at
    // runtime (see McpServiceTokenService).
    MCP_S2S_SIGNING_SECRET: z
      .string()
      .min(32, 'MCP_S2S_SIGNING_SECRET must be at least 32 chars')
      .refine((s) => !s.includes('__SET_ME'), {
        message:
          'MCP_S2S_SIGNING_SECRET is still a placeholder — set a dedicated ≥32 char secret shared with xisuite-mcp',
      })
      .optional(),
    // Pinned issuer/audience for the S2S JWT. Defaults match the MCP signer.
    MCP_S2S_ISSUER: z.string().default('xisuite-mcp'),
    MCP_S2S_AUDIENCE: z.string().default('xisuite-backend'),
    // Clock skew (seconds) tolerated when verifying the S2S JWT's exp/nbf.
    MCP_S2S_CLOCK_SKEW_SECONDS: z.string().default('5'),
    // On-premise deployment mode. ALL optional so the SaaS build (which never sets
    // them) boots unaffected. When IS_ON_PREMISE is truthy, the deployer also
    // renders UPDATE_AGENT_URL + UPDATE_AGENT_SECRET so the in-product update UI can
    // reach the sidecar; OnPremUpdatesModule additionally fail-closes at runtime if
    // they are missing.
    IS_ON_PREMISE: z.string().optional(),
    // Per-install heavy-file upload ceiling in BYTES (see common/upload-limits.ts). Unset or
    // invalid falls back to 5 GB. Only meaningful when IS_ON_PREMISE is truthy.
    ON_PREM_MAX_UPLOAD_BYTES: z.string().optional(),
    // Optional pin for the single on-premise org whose Tenant-Config auth-provider
    // toggles drive the (pre-auth) login page. When unset, the sole organization
    // is used; ambiguous multi-org installs surface no SSO providers until pinned.
    ON_PREMISE_ORG_ID: z.string().optional(),
    // Slug form of the same pin. Operators commonly set only this, so the
    // single-tenant auto-join resolves by slug when the id is absent.
    ON_PREMISE_ORG_SLUG: z.string().optional(),
    // Role given to users auto-joined to the on-premise org (owner|admin|member|viewer).
    // Unset means `member` — self-service signup must not confer tenant ownership.
    ON_PREMISE_DEFAULT_ROLE: z.string().optional(),
    UPDATE_AGENT_URL: z.string().optional(),
    UPDATE_AGENT_SECRET: z.string().optional(),
    APP_RELEASE: z.string().optional(),
    // Vendor licence endpoint this box polls, and its per-installation credential.
    // Both optional: a fully air-gapped install leaves them unset and activates
    // from an imported artifact file instead of polling.
    LICENSE_API_URL: z.string().optional(),
    LICENSE_ACTIVATION_CODE: z.string().optional(),
    // SaaS-side signing material. Present only on the vendor deployment; an
    // on-prem image never carries a private key. The matching PUBLIC key is
    // compiled into the image, deliberately NOT read from env, so a customer
    // cannot substitute a keypair they control.
    ONPREM_LICENSE_SIGNING_KEY: z.string().optional(),
    ONPREM_LICENSE_SIGNING_KEY_ID: z.string().optional(),
  })
  .superRefine((env, context) => {
    if (env.PASSKEY_AUTH_ENABLED !== 'true') return;

    if (!env.PASSKEY_ORIGIN) {
      context.addIssue({
        code: 'custom',
        path: ['PASSKEY_ORIGIN'],
        message: 'PASSKEY_ORIGIN is required when passkeys are enabled',
      });
    }

    if (env.PASSKEY_ORIGIN) {
      const parsedOrigin = new URL(env.PASSKEY_ORIGIN);
      if (parsedOrigin.origin !== env.PASSKEY_ORIGIN) {
        context.addIssue({
          code: 'custom',
          path: ['PASSKEY_ORIGIN'],
          message:
            'PASSKEY_ORIGIN must be an exact origin without a path or trailing slash',
        });
      }
      if (env.NODE_ENV === 'production' && parsedOrigin.protocol !== 'https:') {
        context.addIssue({
          code: 'custom',
          path: ['PASSKEY_ORIGIN'],
          message: 'PASSKEY_ORIGIN must use HTTPS in production',
        });
      }
    }

    if (!env.PASSKEY_TRUSTED_DEVICE_SECRET) {
      context.addIssue({
        code: 'custom',
        path: ['PASSKEY_TRUSTED_DEVICE_SECRET'],
        message:
          'PASSKEY_TRUSTED_DEVICE_SECRET is required when passkeys are enabled',
      });
    } else if (env.PASSKEY_TRUSTED_DEVICE_SECRET.includes('__SET_ME')) {
      context.addIssue({
        code: 'custom',
        path: ['PASSKEY_TRUSTED_DEVICE_SECRET'],
        message: 'PASSKEY_TRUSTED_DEVICE_SECRET is still a placeholder',
      });
    }

    const trustedDeviceTtl = Number(
      env.PASSKEY_TRUSTED_DEVICE_TTL_DAYS ?? '90',
    );
    if (trustedDeviceTtl < 1 || trustedDeviceTtl > 365) {
      context.addIssue({
        code: 'custom',
        path: ['PASSKEY_TRUSTED_DEVICE_TTL_DAYS'],
        message: 'PASSKEY_TRUSTED_DEVICE_TTL_DAYS must be between 1 and 365',
      });
    }

    const recentTotpSeconds = Number(env.PASSKEY_RECENT_TOTP_SECONDS ?? '600');
    if (recentTotpSeconds < 60 || recentTotpSeconds > 3600) {
      context.addIssue({
        code: 'custom',
        path: ['PASSKEY_RECENT_TOTP_SECONDS'],
        message: 'PASSKEY_RECENT_TOTP_SECONDS must be between 60 and 3600',
      });
    }

    const maxPasskeysPerUser = Number(env.PASSKEY_MAX_PER_USER ?? '10');
    if (maxPasskeysPerUser < 1 || maxPasskeysPerUser > 50) {
      context.addIssue({
        code: 'custom',
        path: ['PASSKEY_MAX_PER_USER'],
        message: 'PASSKEY_MAX_PER_USER must be between 1 and 50',
      });
    }
  });

/**
 * TypeScript type inferred from {@link envSchema}, representing the validated environment shape.
 */
export type EnvConfig = z.infer<typeof envSchema>;

/**
 * Validates the raw environment configuration object against {@link envSchema}.
 *
 * In production, validation failures throw an `Error` with details of every missing/invalid variable.
 * In development or test, failures are logged as console warnings but do not halt startup.
 *
 * @param {Record<string, unknown>} config - The raw `process.env` object passed by ConfigModule
 * @returns {Record<string, unknown>} The original config object (pass-through)
 * @throws {Error} When `NODE_ENV` is `"production"` and validation fails
 */
export function validateEnv(config: Record<string, unknown>) {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const missing = result.error.issues.map(
      (i) => `${i.path.join('.')}: ${i.message}`,
    );
    if (config.NODE_ENV === 'production') {
      throw new Error(`Environment validation failed:\n${missing.join('\n')}`);
    }
    console.warn(`Environment validation warnings:\n${missing.join('\n')}`);
  }

  // Non-fatal warning: MCP_S2S_SIGNING_SECRET is optional in the schema so
  // dev/test (and non-MCP prod deployments) boot without it. A prod deployment
  // that intends to accept S2S/MCP calls must set it, but its absence must not
  // block boot, because the runtime fail-closed in McpServiceTokenService.verify()
  // already returns 401 for any S2S token when the secret is missing. Throwing
  // here would break the boot of every existing non-MCP production deployment.
  if (config.NODE_ENV === 'production' && !config.MCP_S2S_SIGNING_SECRET) {
    console.warn(
      'MCP_S2S_SIGNING_SECRET is not set in production — S2S/MCP calls will be rejected (401) until it is set (dedicated ≥32 char secret shared with xisuite-mcp).',
    );
  }

  return config;
}
