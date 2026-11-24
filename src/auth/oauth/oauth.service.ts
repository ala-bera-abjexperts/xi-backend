/**
 * @fileoverview OAuth service. Wraps Supabase's `signInWithOAuth` (URL-only
 * mode) and `exchangeCodeForSession` to provide a full server-side OAuth
 * round-trip for Azure, Keycloak (and any other supported provider Supabase
 * exposes).
 *
 * Why server-side OAuth instead of letting the frontend call
 * `supabase.auth.signInWithOAuth(...)` directly:
 *   - The frontend would otherwise need the Supabase JS SDK loaded — defeats
 *     the migration goal.
 *   - State JWT signed by us prevents CSRF / replay.
 *   - The session ends up as HttpOnly cookies on `Domain=COOKIE_DOMAIN`,
 *     same as the password flow — uniform contract.
 *
 * @module src/auth/oauth/oauth.service
 * @author Prince Jadiya
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignJWT, jwtVerify } from 'jose';
import { createClient } from '@supabase/supabase-js';
import { randomBytes, createHash } from 'node:crypto';
import { isAllowedConfiguredOrSubdomainOrigin } from '../../common/cors/site-studio-cors.util';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { OnPremiseTenantService } from '../../on-premise/on-premise-tenant.service';
import { UsersService } from '../../users/users.service';
import type { TokenResponse } from '../interfaces/auth-response.interface';

/** Providers the frontend may use today. Extend as Supabase project enables more. */
export const SUPPORTED_PROVIDERS = [
  'azure',
  'google',
  'github',
  'keycloak',
] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

/** Cookie name for the signed OAuth state. */
export const OAUTH_STATE_COOKIE = 'oauth_state';
export const OAUTH_PKCE_STORAGE_KEY = 'xisuite-oauth';
const OAUTH_PKCE_VERIFIER_KEY = `${OAUTH_PKCE_STORAGE_KEY}-code-verifier`;

@Injectable()
export class OauthService {
  private readonly logger = new Logger(OauthService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly configService: ConfigService,
    private readonly onPremiseTenant: OnPremiseTenantService,
    private readonly usersService: UsersService,
  ) {}

  /**
   * Builds the Supabase-hosted OAuth URL for the given provider, plus a signed
   * state JWT to verify on callback.
   *
   * @param provider - OAuth provider ('azure', 'google', 'github', 'keycloak')
   * @param redirectTo - Frontend URL to redirect to AFTER the callback completes
   * @param options.silent - Ask the provider for `prompt=none` (reuse an existing session, never show a login screen)
   * @returns The OAuth URL to 302 the user to + the state JWT to set in a cookie
   */
  async beginAuthorize(
    provider: SupportedProvider,
    redirectTo: string,
    options: { silent?: boolean } = {},
  ): Promise<{ authorizeUrl: string; state: string }> {
    // Subdomain-aware on purpose: tenant slugs are dynamic, so
    // `{slug}.xisuite.cloud` can never appear in a fixed ALLOWED_ORIGINS list.
    // An exact-origin check rejected every tenant-scoped redirect, which is
    // what a user gets after logging out of a tenant dashboard. This is the
    // same helper CORS (main.ts) and /auth/refresh (auth.controller.ts)
    // already use, so all three now agree on what "our domain" means.
    const allowedHosts = this.frontendAllowlist();
    if (!isAllowedConfiguredOrSubdomainOrigin(redirectTo, allowedHosts)) {
      throw new BadRequestException(
        `redirectTo ${redirectTo} is not in the allowed frontend list`,
      );
    }

    const supabaseUrl = this.configService.get<string>('supabase.url');
    if (!supabaseUrl) {
      throw new Error(
        'Supabase URL is not configured (set SUPABASE_URL env var)',
      );
    }

    const callbackUrl = this.callbackUrl();

    // RFC 7636 PKCE — generate verifier + S256 challenge locally so we never
    // depend on the Supabase JS SDK's internal storage write happening
    // reliably server-side. The SDK's behavior on this point was fragile in
    // production (the verifier sometimes never landed in our in-memory
    // storage, surfacing as "OAuth PKCE verifier was not generated" 400).
    // 32 random bytes → 43-char base64url string, well within the
    // 43..128-char range required by RFC 7636.
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    const authorizeUrl = new URL(
      `${supabaseUrl.replace(/\/$/, '')}/auth/v1/authorize`,
    );
    authorizeUrl.searchParams.set('provider', provider);
    // `redirect_to` is the param Supabase Auth honors. After Supabase
    // completes the upstream OAuth handshake (Azure/Google/GitHub) it 302s
    // the browser here with `?code=...`.
    authorizeUrl.searchParams.set('redirect_to', callbackUrl);
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 's256');
    authorizeUrl.searchParams.set('scopes', 'email openid profile');
    // Supabase Auth forwards unrecognised authorize params to the provider.
    if (options.silent) authorizeUrl.searchParams.set('prompt', 'none');

    // Sign the state JWT (10-minute TTL). Carries provider + redirectTo so the
    // callback knows where to send the user after completing the exchange.
    // The codeVerifier rides inside the JWT — never exposed to the browser
    // beyond the HttpOnly state cookie, and signed so we can verify it on
    // callback before handing it to Supabase's token endpoint.
    const state = await new SignJWT({
      provider,
      redirectTo,
      codeVerifier,
      n: nonce(),
      ...(options.silent ? { silent: true } : {}),
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(this.stateSecret());

    return { authorizeUrl: authorizeUrl.toString(), state };
  }

  /**
   * Verifies the state JWT (presence + signature + expiry) and exchanges the
   * authorization code for a Supabase session.
   *
   * @param code - The OAuth authorization code from the provider
   * @param state - The signed state JWT from the cookie
   */
  async completeCallback(
    code: string,
    state: string,
  ): Promise<{ tokens: TokenResponse; redirectTo: string }> {
    const payload = await this.verifyState(state);

    if (!payload.codeVerifier) {
      throw new UnauthorizedException('Invalid OAuth state');
    }

    // MUST be JSON, not the raw string. auth-js writes via setItemAsync, which
    // always JSON.stringifies, and reads via getItemAsync. Up to 2.101 that
    // reader fell back to returning the raw value when JSON.parse threw, so
    // seeding a bare string happened to work. From 2.109 it returns null
    // instead, so the verifier reads as ABSENT and every OAuth exchange fails
    // with AuthPKCECodeVerifierMissingError. Stringifying restores the
    // read/write symmetry and is correct on both versions.
    const storage = createMemoryStorage({
      [OAUTH_PKCE_VERIFIER_KEY]: JSON.stringify(payload.codeVerifier),
    });
    const { data, error } =
      await this.createPkceClient(storage).auth.exchangeCodeForSession(code);

    if (error || !data.session) {
      const detail = error?.message ?? 'no session returned';

      this.logger.warn(`OAuth code exchange failed: ${detail}`);

      // Append detail to the message so the global exception filter surfaces it
      // (the filter only extracts `message` and `data` from the exception's response
      // object — any extra fields would be dropped). Keeping the prefix
      // "OAuth code exchange failed" preserves backward compat for any client
      // code that startsWith-matches on it.
      throw new BadRequestException(`OAuth code exchange failed: ${detail}`);
    }

    // On-premise single-tenant auto-join, mirroring verifyOtp()/signin().
    // An SSO login creates the auth user and (via handle_new_user) the profile,
    // but no organization_members row — so a Keycloak/Azure user would land on
    // "create your organization" exactly like a password signup did.
    //
    // Before the tokens are returned, so the membership exists by the time the
    // client makes its first authenticated request. No-op off-premise.
    try {
      const profile = await this.usersService.getUserByAuthUserId(
        data.session.user?.id ?? '',
      );

      if (profile?.id) {
        await this.onPremiseTenant.ensureDefaultMembership(
          profile.id,
          profile.email,
        );
      }
    } catch (err) {
      // Never fail an OAuth login over tenant plumbing — bootstrap()'s net
      // catches the user on their first page load.
      this.logger.warn(
        `OAuth auto-join skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {
      tokens: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_in: data.session.expires_in,
        token_type: 'bearer',
      },
      redirectTo: payload.redirectTo,
    };
  }

  /**
   * For a callback that came back without a code: the signed `redirectTo` when
   * the state belongs to a silent (`prompt=none`) attempt, else null. Never
   * throws — an invalid state simply isn't silent, and the normal error path runs.
   *
   * @param state - The signed state JWT from the cookie
   */
  async silentRedirectFor(state: string): Promise<string | null> {
    try {
      const payload = await this.verifyState(state);

      return payload.silent ? payload.redirectTo : null;
    } catch {
      return null;
    }
  }

  private async verifyState(state: string): Promise<{
    provider: string;
    redirectTo: string;
    codeVerifier: string;
    n: string;
    silent?: boolean;
  }> {
    try {
      const { payload } = await jwtVerify(state, this.stateSecret());

      return payload as unknown as {
        provider: string;
        redirectTo: string;
        codeVerifier: string;
        n: string;
        silent?: boolean;
      };
    } catch (err) {
      this.logger.warn(`OAuth state verification failed: ${String(err)}`);
      throw new UnauthorizedException('Invalid or expired OAuth state');
    }
  }

  /**
   * The fully-qualified callback URL on this NestJS instance. Must match the
   * URL registered in the Supabase project's "Redirect URLs" allowlist.
   *
   * Reads `publicApiUrl` from config (env: `PUBLIC_API_URL`). Defaults to the
   * local dev port. In production the env validator should enforce that this
   * is set to the public NestJS URL.
   */
  callbackUrl(): string {
    const url = this.configService.get<string>('publicApiUrl');

    if (!url) {
      throw new Error(
        'publicApiUrl is not configured (set PUBLIC_API_URL env var)',
      );
    }
    return `${url.replace(/\/$/, '')}/auth/oauth/callback`;
  }

  /**
   * Allowlist of acceptable `redirectTo` host origins. Pulled from the CORS
   * `allowedOrigins` config — same source of truth.
   */
  frontendAllowlist(): string[] {
    return this.configService.get<string[]>('allowedOrigins') ?? [];
  }

  /** HMAC secret for signing OAuth state. */
  private stateSecret(): Uint8Array {
    const raw = this.configService.get<string>('sessionSigningSecret') || '';
    return new TextEncoder().encode(raw);
  }

  private createPkceClient(storage: MemoryStorage) {
    const url = this.configService.get<string>('supabase.url');
    const anonKey = this.configService.get<string>('supabase.anonKey');

    if (!url || !anonKey) {
      throw new Error('Supabase URL/anonKey not configured');
    }

    return createClient(url, anonKey, {
      auth: {
        flowType: 'pkce',
        // MUST be true. When false, GoTrueClient silently ignores the `storage`
        // option and creates a fresh empty in-memory adapter — our pre-populated
        // PKCE verifier is discarded, causing exchangeCodeForSession to throw
        // "PKCE code verifier not found in storage".
        // Source: @supabase/auth-js/dist/main/GoTrueClient.js (lines ~165-185).
        // Our `storage` is a per-request Map that goes out of scope when this
        // function returns — there is no real persistence happening server-side.
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storageKey: OAUTH_PKCE_STORAGE_KEY,
        storage,
      },
    });
  }
}

interface MemoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function createMemoryStorage(
  initial: Record<string, string> = {},
): MemoryStorage {
  const store = new Map<string, string>(Object.entries(initial));

  return {
    getItem(key: string): string | null {
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      store.set(key, value);
    },
    removeItem(key: string): void {
      store.delete(key);
    },
  };
}

function nonce(): string {
  // 16 chars of url-safe random; not security-critical (the JWT signature is)
  // but useful as a one-time-use breadcrumb.
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
