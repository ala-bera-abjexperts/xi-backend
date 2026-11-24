/**
 * @fileoverview Unit tests for GithubAppClient: app JWT signature, installation token caching,
 * pagination and error mapping. `fetch` is mocked.
 * @module src/git-integrations/github/github-app.client.spec
 */

import { createVerify, generateKeyPairSync } from 'node:crypto';

import type { IGitApp } from '../git-integrations.types';
import {
  GithubApiError,
  GithubAppClient,
  githubAuthorizeUrl,
  githubInstallUrl,
} from './github-app.client';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});

const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

/** The built-in XISUITE App on github.com. */
const app: IGitApp = {
  serverId: null,
  provider: 'github',
  host: 'github.com',
  webUrl: 'https://github.com',
  apiUrl: 'https://api.github.com',
  appId: '123',
  appSlug: 'xisuite',
  privateKey: pem,
  clientId: 'cid',
  clientSecret: 'csecret',
  webhookSecret: 'whsec',
};

/** An organization's own App on a GitHub Enterprise Server (ticket 11). */
const ghes: IGitApp = {
  ...app,
  serverId: '11111111-1111-1111-1111-111111111111',
  host: 'ghe.local',
  webUrl: 'https://ghe.local',
  apiUrl: 'https://ghe.local/api/v3',
};

function makeClient() {
  return new GithubAppClient();
}

function json(body: unknown, status = 200) {
  return { ok: status < 400, status, json: () => Promise.resolve(body) };
}

describe('GithubAppClient', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('signs an RS256 app JWT verifiable with the public key', () => {
    const jwt = makeClient().appJwt(app);
    const [header, payload, signature] = jwt.split('.');

    const ok = createVerify('RSA-SHA256')
      .update(`${header}.${payload}`)
      .verify(publicKey, signature, 'base64url');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const now = Math.floor(Date.now() / 1000);

    expect(ok).toBe(true);
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(claims.iss).toBe('123');
    expect(claims.iat).toBeLessThanOrEqual(now - 59);
    expect(claims.exp).toBeLessThanOrEqual(now + 540);
  });

  it('caches installation tokens until 5 minutes before expiry', async () => {
    const client = makeClient();

    fetchMock.mockResolvedValue(
      json({
        token: 'inst-token',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    );

    expect(await client.installationToken(app, '42')).toBe('inst-token');
    expect(await client.installationToken(app, '42')).toBe('inst-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.github.com/app/installations/42/access_tokens',
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'xisuite',
      }),
    });
  });

  it('re-mints a token that is about to expire', async () => {
    const client = makeClient();

    fetchMock.mockResolvedValue(
      json({
        token: 't',
        expires_at: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
      }),
    );

    await client.installationToken(app, '42');
    await client.installationToken(app, '42');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws GithubApiError with the HTTP status', async () => {
    fetchMock.mockResolvedValue(json({ message: 'Not Found' }, 404));

    await expect(makeClient().getInstallation(app, '9')).rejects.toMatchObject({
      name: 'GithubApiError',
      status: 404,
    });
    await expect(makeClient().getInstallation(app, '9')).rejects.toBeInstanceOf(
      GithubApiError,
    );
  });

  it('paginates installation repositories', async () => {
    const client = makeClient();
    const page = (n: number, start: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: start + i,
        full_name: `o/r${start + i}`,
      }));

    fetchMock
      .mockResolvedValueOnce(
        json({
          token: 't',
          expires_at: new Date(Date.now() + 3600e3).toISOString(),
        }),
      )
      .mockResolvedValueOnce(json({ repositories: page(100, 0) }))
      .mockResolvedValueOnce(json({ repositories: page(5, 100) }));

    const repos = await client.listInstallationRepositories(app, '42');

    expect(repos).toHaveLength(105);
    expect(fetchMock.mock.calls[2][0]).toBe(
      'https://api.github.com/installation/repositories?per_page=100&page=2',
    );
  });

  it('exchangeCode throws when GitHub returns an error field', async () => {
    fetchMock.mockResolvedValue(json({ error: 'bad_verification_code' }));

    await expect(
      makeClient().exchangeCode(app, 'c', 'https://x/cb'),
    ).rejects.toBeInstanceOf(GithubApiError);
  });

  it('exchangeCode returns the access token', async () => {
    fetchMock.mockResolvedValue(json({ access_token: 'user-token' }));

    expect(await makeClient().exchangeCode(app, 'c', 'https://x/cb')).toBe(
      'user-token',
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      client_id: 'cid',
      client_secret: 'csecret',
      code: 'c',
      redirect_uri: 'https://x/cb',
    });
  });

  it('getOrgMembership calls the user membership endpoint with the user token', async () => {
    fetchMock.mockResolvedValue(json({ state: 'active', role: 'admin' }));

    expect(await makeClient().getOrgMembership(app, 'ut', 'acme')).toEqual({
      state: 'active',
      role: 'admin',
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.github.com/user/memberships/orgs/acme',
    );
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer ut');
  });
  it('follows redirects for the built-in App only', async () => {
    fetchMock.mockResolvedValue(json({ state: 'active', role: 'admin' }));

    await makeClient().getOrgMembership(app, 'ut', 'acme');
    await makeClient().getOrgMembership(ghes, 'ut', 'acme');

    expect(fetchMock.mock.calls[0][1].redirect).toBe('follow');
    expect(fetchMock.mock.calls[1][1].redirect).toBe('manual');
  });

  describe('GitHub Enterprise Server app (ticket 11)', () => {
    it('calls the server API and OAuth addresses', async () => {
      fetchMock
        .mockResolvedValueOnce(json({ access_token: 'user-token' }))
        .mockResolvedValueOnce(json({ id: 1, login: 'dev' }));

      await makeClient().exchangeCode(ghes, 'c', 'https://x/cb');
      await makeClient().getUser(ghes, 'user-token');

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://ghe.local/login/oauth/access_token',
      );
      expect(fetchMock.mock.calls[1][0]).toBe('https://ghe.local/api/v3/user');
    });

    it('keys the token cache per app: the same installation id on two apps mints twice', async () => {
      const client = makeClient();

      fetchMock.mockResolvedValue(
        json({
          token: 't',
          expires_at: new Date(Date.now() + 3600e3).toISOString(),
        }),
      );

      await client.installationToken(app, '42');
      await client.installationToken(ghes, '42');
      await client.installationToken(ghes, '42');

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toBe(
        'https://ghe.local/api/v3/app/installations/42/access_tokens',
      );
    });

    it('reports a redirect instead of following it', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 302,
        headers: new Headers({ location: 'http://169.254.169.254/' }),
        json: () => Promise.resolve({}),
      });

      await expect(
        makeClient().getInstallation(ghes, '9'),
      ).rejects.toMatchObject({
        status: 302,
        message: 'redirected (302) to http://169.254.169.254/',
      });
    });

    it('builds the authorize and install addresses per server', () => {
      expect(githubAuthorizeUrl(app)).toBe(
        'https://github.com/login/oauth/authorize',
      );
      expect(githubInstallUrl(app)).toBe(
        'https://github.com/apps/xisuite/installations/new',
      );
      expect(githubAuthorizeUrl(ghes)).toBe(
        'https://ghe.local/login/oauth/authorize',
      );
      expect(githubInstallUrl(ghes)).toBe(
        'https://ghe.local/github-apps/xisuite/installations/new',
      );
    });

    it('checkOAuthClient tells a wrong client from a right one', async () => {
      fetchMock
        .mockResolvedValueOnce(json({ error: 'incorrect_client_credentials' }))
        .mockResolvedValueOnce(json({ error: 'bad_verification_code' }));

      expect(await makeClient().checkOAuthClient(ghes, 'https://x/cb')).toBe(
        'client_invalid',
      );
      expect(await makeClient().checkOAuthClient(ghes, 'https://x/cb')).toBe(
        'ok',
      );
    });
  });
});
