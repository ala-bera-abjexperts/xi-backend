const mockExchangeCodeForSession = jest.fn();
const mockStorageInstances: Array<{
  getItem: (key: string) => Promise<string | null> | string | null;
  setItem: (key: string, value: string) => Promise<void> | void;
  removeItem: (key: string) => Promise<void> | void;
}> = [];

jest.mock('jose', () => ({
  SignJWT: jest.fn().mockImplementation((payload: Record<string, unknown>) => ({
    setProtectedHeader: jest.fn().mockReturnThis(),
    setIssuedAt: jest.fn().mockReturnThis(),
    setExpirationTime: jest.fn().mockReturnThis(),
    sign: jest.fn().mockResolvedValue(JSON.stringify(payload)),
  })),
  jwtVerify: jest.fn((state: string) => ({
    payload: JSON.parse(state) as Record<string, unknown>,
  })),
}));

// createClient is only used by completeCallback now (beginAuthorize builds the
// URL manually with node:crypto). The mock records the storage instance the
// service passes in so we can assert the verifier was hydrated correctly.
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(
    (
      _url: string,
      _key: string,
      options: {
        auth: {
          storage: {
            getItem: (key: string) => Promise<string | null> | string | null;
            setItem: (key: string, value: string) => Promise<void> | void;
            removeItem: (key: string) => Promise<void> | void;
          };
        };
      },
    ) => {
      mockStorageInstances.push(options.auth.storage);
      return {
        auth: {
          exchangeCodeForSession: mockExchangeCodeForSession,
        },
      };
    },
  ),
}));

import { createHash } from 'node:crypto';
import { OauthService } from './oauth.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { ConfigService } from '@nestjs/config';

describe('OauthService PKCE flow', () => {
  function setup() {
    const configService = {
      get: jest.fn((key: string) => {
        const values: Record<string, unknown> = {
          allowedOrigins: ['https://app.test'],
          publicApiUrl: 'https://api.test/api/v1',
          sessionSigningSecret: 'test-secret-with-at-least-32-bytes',
          'supabase.url': 'https://supabase.test',
          'supabase.anonKey': 'anon-key',
        };

        return values[key];
      }),
    };

    return new OauthService(
      { getClient: jest.fn() } as unknown as SupabaseAdminService,
      configService as unknown as ConfigService,
    );
  }

  beforeEach(() => {
    mockExchangeCodeForSession.mockReset();
    mockStorageInstances.length = 0;
  });

  it('builds a Supabase authorize URL with RFC 7636 PKCE locally (no SDK dependency)', async () => {
    const service = setup();
    const started = await service.beginAuthorize(
      'azure',
      'https://app.test/dashboard',
    );

    const url = new URL(started.authorizeUrl);
    expect(url.origin).toBe('https://supabase.test');
    expect(url.pathname).toBe('/auth/v1/authorize');
    expect(url.searchParams.get('provider')).toBe('azure');
    expect(url.searchParams.get('redirect_to')).toBe(
      'https://api.test/api/v1/auth/oauth/callback',
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('s256');
    expect(url.searchParams.get('scopes')).toBe('email openid profile');

    const challenge = url.searchParams.get('code_challenge');
    // base64url: 43 chars from a 32-byte SHA-256 digest, no padding.
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // State JWT (mocked-jose returns the JSON payload) carries the verifier.
    const statePayload = JSON.parse(started.state) as {
      provider: string;
      redirectTo: string;
      codeVerifier: string;
      n: string;
    };
    expect(statePayload.provider).toBe('azure');
    expect(statePayload.redirectTo).toBe('https://app.test/dashboard');
    expect(statePayload.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The challenge in the URL must equal SHA-256(verifier) in base64url —
    // the heart of PKCE. If this assertion ever fails, Supabase Auth will
    // reject the code exchange on callback.
    const expectedChallenge = createHash('sha256')
      .update(statePayload.codeVerifier)
      .digest('base64url');
    expect(challenge).toBe(expectedChallenge);

    // createClient should NOT have been called yet — beginAuthorize is
    // pure manual URL construction now.
    expect(mockStorageInstances).toHaveLength(0);
  });

  it('asks the provider for prompt=none and marks the state silent only on a silent attempt', async () => {
    const service = setup();

    const silent = await service.beginAuthorize(
      'keycloak',
      'https://app.test/dashboard',
      { silent: true },
    );
    expect(new URL(silent.authorizeUrl).searchParams.get('prompt')).toBe(
      'none',
    );
    expect(JSON.parse(silent.state)).toEqual(
      expect.objectContaining({ silent: true }),
    );

    const interactive = await service.beginAuthorize(
      'keycloak',
      'https://app.test/dashboard',
    );
    expect(new URL(interactive.authorizeUrl).searchParams.has('prompt')).toBe(
      false,
    );
    expect(JSON.parse(interactive.state)).not.toHaveProperty('silent');
  });

  it('resolves the redirect for a silent state only, and never throws', async () => {
    const service = setup();
    const silent = await service.beginAuthorize(
      'keycloak',
      'https://app.test/dashboard',
      { silent: true },
    );
    const interactive = await service.beginAuthorize(
      'keycloak',
      'https://app.test/dashboard',
    );

    await expect(service.silentRedirectFor(silent.state)).resolves.toBe(
      'https://app.test/dashboard',
    );
    await expect(
      service.silentRedirectFor(interactive.state),
    ).resolves.toBeNull();
    // Forged / unverifiable state: not silent, so the normal error path runs.
    await expect(service.silentRedirectFor('not-a-jwt')).resolves.toBeNull();
  });

  it('rejects redirectTo not in the allowlist', async () => {
    const service = setup();
    await expect(
      service.beginAuthorize('azure', 'https://attacker.test/steal'),
    ).rejects.toThrow(/not in the allowed frontend list/);
  });

  it('allows a tenant subdomain of an allowlisted host', async () => {
    // Tenant slugs are dynamic, so `{slug}.app.test` can never be enumerated in
    // ALLOWED_ORIGINS. An exact-origin check rejected every tenant-scoped
    // redirect, which is exactly what a user carries after logging out of a
    // tenant dashboard -- Azure sign-in 400'd for them in production.
    const service = setup();

    await expect(
      service.beginAuthorize('azure', 'https://acme.app.test/'),
    ).resolves.toEqual(
      expect.objectContaining({ authorizeUrl: expect.any(String) }),
    );
  });

  it('does not treat a lookalike host or a downgraded scheme as ours', async () => {
    // The leading dot in the suffix match is load-bearing: without it
    // `evilapp.test` would satisfy endsWith('app.test').
    const service = setup();

    await expect(
      service.beginAuthorize('azure', 'https://evilapp.test/'),
    ).rejects.toThrow(/not in the allowed frontend list/);

    await expect(
      service.beginAuthorize('azure', 'http://acme.app.test/'),
    ).rejects.toThrow(/not in the allowed frontend list/);
  });

  it('stores the PKCE verifier so a JSON-parsing reader can recover it', async () => {
    // Regression: auth-js <=2.101 returned the raw string when JSON.parse threw,
    // so seeding a bare verifier happened to work. 2.109 returns null instead,
    // making the verifier read as ABSENT and breaking every OAuth exchange.
    // This models the 2.109 reader, so a bare-string seed fails here.
    const readLikeAuthJs2109 = (raw: string | null): string | null => {
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as string;
      } catch {
        return null;
      }
    };

    mockExchangeCodeForSession.mockImplementation(async () => {
      const stored = await mockStorageInstances[0].getItem(
        'xisuite-oauth-code-verifier',
      );
      const verifier = readLikeAuthJs2109(stored);

      return verifier
        ? {
            data: {
              session: {
                access_token: 'access-token',
                refresh_token: 'refresh-token',
                expires_in: 3600,
              },
            },
            error: null,
          }
        : {
            data: {},
            error: { message: 'PKCE code verifier not found in storage.' },
          };
    });

    const service = setup();
    const started = await service.beginAuthorize('azure', 'https://app.test/');

    await expect(
      service.completeCallback('oauth-code', started.state),
    ).resolves.toEqual(
      expect.objectContaining({
        tokens: expect.objectContaining({ access_token: 'access-token' }),
      }),
    );
  });

  it('hydrates the PKCE verifier into the SDK storage on callback and exchanges the code', async () => {
    mockExchangeCodeForSession.mockImplementation(async () => {
      // SDK reads `${storageKey}-code-verifier` via getItemAsync (which
      // JSON.parses the value, falling back to raw string on parse error).
      // Our hydration stores the raw verifier string — works either way.
      const verifier = await mockStorageInstances[0].getItem(
        'xisuite-oauth-code-verifier',
      );

      return verifier
        ? {
            data: {
              session: {
                access_token: 'access-token',
                refresh_token: 'refresh-token',
                expires_in: 3600,
              },
            },
            error: null,
          }
        : { data: {}, error: { message: 'missing verifier' } };
    });

    const service = setup();
    const started = await service.beginAuthorize(
      'azure',
      'https://app.test/dashboard',
    );
    const completed = await service.completeCallback(
      'oauth-code',
      started.state,
    );

    expect(mockExchangeCodeForSession).toHaveBeenCalledWith('oauth-code');
    expect(completed.tokens.access_token).toBe('access-token');
    expect(completed.tokens.refresh_token).toBe('refresh-token');
    expect(completed.redirectTo).toBe('https://app.test/dashboard');
  });
});
