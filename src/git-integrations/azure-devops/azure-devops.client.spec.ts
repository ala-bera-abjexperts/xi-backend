/**
 * @fileoverview Unit tests for the Azure DevOps client. `fetch` is stubbed.
 * @module src/git-integrations/azure-devops/azure-devops.client.spec
 */

import {
  AZURE_CONNECT_SCOPE,
  AZURE_IDENTITY_SCOPE,
  AzureDevopsApiError,
  AzureDevopsClient,
  pkceChallenge,
} from './azure-devops.client';

const APP = {
  serverId: null,
  provider: 'azure_devops' as const,
  host: 'dev.azure.com',
  webUrl: 'https://dev.azure.com',
  apiUrl: 'https://dev.azure.com',
  clientId: 'cid',
  clientSecret: 'csecret',
};

function respond(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('AzureDevopsClient', () => {
  const client = new AzureDevopsClient();
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => jest.restoreAllMocks());

  describe('never writes to a repository', () => {
    it('asks for no write scope', () => {
      for (const scope of [AZURE_CONNECT_SCOPE, AZURE_IDENTITY_SCOPE]) {
        expect(scope).not.toMatch(/write|manage/i);
      }
    });

    it.each([
      ['POST', '/_apis/git/repositories/r/pushes'],
      ['POST', '/_apis/git/repositories/r/refs'],
      ['POST', '/_apis/git/repositories/r/pullrequests'],
      ['PATCH', '/_apis/git/repositories/r/pullrequests/1'],
      ['PUT', '/_apis/git/repositories/r/items'],
      ['DELETE', '/_apis/git/repositories/r'],
      ['POST', '/_apis/hooks/subscriptionsX'],
      ['POST', '/project/_apis/hooks/subscriptions/../../git/repositories'],
    ])('refuses %s %s without calling Azure', (method, path) => {
      expect(() => client.orgPage('acme', path, 't', { method })).toThrow(
        /Refused write/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ['POST', '/_apis/hooks/subscriptions'],
      ['DELETE', '/_apis/hooks/subscriptions/abc'],
    ])('allows %s %s, which are project settings', async (method, path) => {
      fetchMock.mockResolvedValue(respond(200, { id: 's1' }));

      await expect(client.org('acme', path, 't', { method })).resolves.toEqual({
        id: 's1',
      });
    });
  });

  describe('requests', () => {
    it('encodes the organization and always pins the API version', async () => {
      fetchMock.mockImplementation(async () => respond(200, { value: [] }));

      await client.org('my org', '/_apis/git/repositories', 'tok');
      await client.org('acme', '/_apis/x?a=1', 'tok');

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://dev.azure.com/my%20org/_apis/git/repositories?api-version=7.1',
      );
      expect(fetchMock.mock.calls[0][1].headers.authorization).toBe(
        'Bearer tok',
      );
      expect(fetchMock.mock.calls[1][0]).toBe(
        'https://dev.azure.com/acme/_apis/x?a=1&api-version=7.1',
      );
    });

    it.each([
      [203, 'the sign-in page'],
      [302, 'a redirect to sign-in'],
    ])('treats %i (%s) as a refused token', async (status) => {
      fetchMock.mockResolvedValue(new Response('<html>', { status }));

      await expect(client.org('acme', '/_apis/x', 't')).rejects.toMatchObject({
        status: 401,
      });
    });

    it('reports the status and message of a failure', async () => {
      fetchMock.mockResolvedValue(respond(429, { message: 'TF400733' }));

      const error = await client.org('acme', '/_apis/x', 't').catch((e) => e);

      expect(error).toBeInstanceOf(AzureDevopsApiError);
      expect(error).toMatchObject({ status: 429, message: 'TF400733' });
    });

    it('returns nothing for a 204', async () => {
      fetchMock.mockResolvedValue(respond(204));

      await expect(
        client.org('acme', '/_apis/hooks/subscriptions/s', 't', {
          method: 'DELETE',
        }),
      ).resolves.toBeUndefined();
    });

    it('reads the accounts of a member', async () => {
      fetchMock.mockResolvedValue(
        respond(200, { value: [{ accountId: 'a', accountName: 'acme' }] }),
      );

      await expect(client.accounts('t', 'me/1')).resolves.toEqual([
        { accountId: 'a', accountName: 'acme' },
      ]);
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://app.vssps.visualstudio.com/_apis/accounts?memberId=me%2F1&api-version=7.1',
      );
    });
  });

  describe('sign-in', () => {
    it('builds an Entra address for organizational accounts, with PKCE', () => {
      const url = new URL(
        client.authorizeUrl(APP, {
          redirectUri: 'https://api/callback',
          scope: AZURE_CONNECT_SCOPE,
          state: 'st',
          codeVerifier: 'verifier',
        }),
      );

      expect(url.origin + url.pathname).toBe(
        'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
      );
      expect(url.searchParams.get('client_id')).toBe('cid');
      expect(url.searchParams.get('code_challenge')).toBe(
        pkceChallenge('verifier'),
      );
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('scope')).toBe(AZURE_CONNECT_SCOPE);
    });

    it('exchanges a code with the verifier and computes the expiry', async () => {
      fetchMock.mockResolvedValue(
        respond(200, {
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 3599,
        }),
      );

      const before = Date.now();
      const tokens = await client.exchangeCode(APP, {
        code: 'c',
        redirectUri: 'https://api/callback',
        scope: AZURE_CONNECT_SCOPE,
        codeVerifier: 'v',
      });
      const body = fetchMock.mock.calls[0][1].body as URLSearchParams;

      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code_verifier')).toBe('v');
      expect(body.get('client_secret')).toBe('csecret');
      expect(tokens).toMatchObject({ accessToken: 'at', refreshToken: 'rt' });
      expect(Date.parse(tokens.expiresAt)).toBeGreaterThanOrEqual(
        before + 3599_000,
      );
    });

    it('keeps the old refresh token when Microsoft sends no new one', async () => {
      fetchMock.mockResolvedValue(respond(200, { access_token: 'at' }));

      await expect(client.refresh(APP, 'old')).resolves.toMatchObject({
        refreshToken: 'old',
      });
    });

    it('carries the OAuth error code, which decides whether the grant is lost', async () => {
      fetchMock.mockResolvedValue(
        respond(400, {
          error: 'invalid_grant',
          error_description: 'AADSTS70008',
        }),
      );

      await expect(client.refresh(APP, 'old')).rejects.toMatchObject({
        status: 400,
        oauthError: 'invalid_grant',
        message: 'AADSTS70008',
      });
    });

    it('sends the secret in the body, never in the address', async () => {
      fetchMock.mockResolvedValue(
        respond(200, { access_token: 'at', refresh_token: 'rt' }),
      );

      await client.refresh(APP, 'old');

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

      expect(url).not.toContain('csecret');
      expect(String(init.body)).toContain('client_secret=csecret');
    });

    it('an unusual state survives the address', () => {
      const url = new URL(
        client.authorizeUrl(APP, {
          redirectUri: 'https://api.example.com/cb',
          scope: AZURE_CONNECT_SCOPE,
          state: 'a b&c=d+e',
          codeVerifier: 'v',
        }),
      );

      expect(url.searchParams.get('state')).toBe('a b&c=d+e');
      expect(url.searchParams.get('client_secret')).toBeNull();
    });

    it('an answer that is not JSON has no OAuth code, so the grant is kept', async () => {
      fetchMock.mockResolvedValue(
        new Response('<html>Service unavailable</html>', { status: 503 }),
      );

      await expect(client.refresh(APP, 'old')).rejects.toMatchObject({
        status: 503,
        oauthError: null,
      });
    });

    it('a 200 without an access token is an error, not an empty sign-in', async () => {
      fetchMock.mockResolvedValue(respond(200, { token_type: 'Bearer' }));

      await expect(
        client.exchangeCode(APP, {
          code: 'c',
          redirectUri: 'https://api.example.com/cb',
          scope: AZURE_CONNECT_SCOPE,
          codeVerifier: 'v',
        }),
      ).rejects.toMatchObject({ status: 502 });
    });

    it('assumes one hour when Microsoft sends no lifetime', async () => {
      fetchMock.mockResolvedValue(respond(200, { access_token: 'at' }));

      const { expiresAt } = await client.refresh(APP, 'old');
      const minutes = (Date.parse(expiresAt) - Date.now()) / 60_000;

      expect(minutes).toBeGreaterThan(59);
      expect(minutes).toBeLessThanOrEqual(60);
    });

    it('a network failure is not mistaken for a refusal', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      const error: unknown = await client.refresh(APP, 'old').catch((e) => e);

      expect(error).not.toBeInstanceOf(AzureDevopsApiError);
    });

    it('a profile answer with the sign-in page is a refused token', async () => {
      fetchMock.mockResolvedValue(new Response('<html>', { status: 203 }));

      await expect(client.profile('t')).rejects.toMatchObject({ status: 401 });
    });
  });
});
