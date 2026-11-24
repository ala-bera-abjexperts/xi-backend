/**
 * @fileoverview Unit tests for the GitLab HTTP client with a mocked global `fetch`.
 * @module src/git-integrations/gitlab/gitlab.client.spec
 */

import type { IGitApp } from '../git-integrations.types';
import { GitlabApiError, GitlabClient } from './gitlab.client';

function respond(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
  };
}

/** The built-in app (the env base URL): redirects followed, as before ticket 11. */
const APP: IGitApp = {
  serverId: null,
  provider: 'gitlab',
  host: 'gitlab.example.com',
  webUrl: 'https://gitlab.example.com',
  apiUrl: 'https://gitlab.example.com/api/v4',
  clientId: 'cid',
  clientSecret: 'secret',
};
/** An organization's own self-managed GitLab under a relative URL root (ticket 11). */
const OWN: IGitApp = {
  serverId: '33333333-3333-4333-8333-333333333333',
  provider: 'gitlab',
  host: 'company.local',
  webUrl: 'https://company.local/gitlab',
  apiUrl: 'https://company.local/gitlab/api/v4',
  clientId: 'own-cid',
  clientSecret: 'own-secret',
};
const client = new GitlabClient();
const fetchMock = () => global.fetch as jest.Mock;

describe('GitlabClient', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('exchanges a code and derives expiresAt from created_at + expires_in', async () => {
    fetchMock().mockResolvedValue(
      respond(200, {
        access_token: 'at',
        refresh_token: 'rt',
        created_at: 1_900_000_000,
        expires_in: 7200,
      }),
    );

    const tokens = await client.exchangeCode(APP, 'code', 'https://api/cb');

    expect(tokens).toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: new Date((1_900_000_000 + 7200) * 1000).toISOString(),
    });
    const [url, init] = fetchMock().mock.calls[0];
    expect(url).toBe('https://gitlab.example.com/oauth/token');
    expect(String(init.body)).toContain('grant_type=authorization_code');
    expect(init.redirect).toBe('follow');
  });

  it('a refused refresh carries status and oauthError', async () => {
    fetchMock().mockResolvedValue(
      respond(400, { error: 'invalid_grant', error_description: 'revoked' }),
    );

    const error = await client
      .refresh(APP, 'rt', 'https://api/cb')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitlabApiError);
    expect(error).toMatchObject({ status: 400, oauthError: 'invalid_grant' });
  });

  it('api: Bearer token, error status, DELETE 204 -> undefined', async () => {
    fetchMock()
      .mockResolvedValueOnce(respond(403, { message: '403 Forbidden' }))
      .mockResolvedValueOnce(respond(204, null));

    await expect(
      client.api(APP, '/projects/1/hooks', 'tok', { method: 'POST', body: {} }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      client.api(APP, '/projects/1/hooks/2', 'tok', { method: 'DELETE' }),
    ).resolves.toBeUndefined();
    expect(fetchMock().mock.calls[0][1].headers.authorization).toBe(
      'Bearer tok',
    );
    expect(fetchMock().mock.calls[0][0]).toBe(
      'https://gitlab.example.com/api/v4/projects/1/hooks',
    );
  });

  it('paginate follows x-next-page up to maxPages', async () => {
    fetchMock()
      .mockResolvedValueOnce(respond(200, [1, 2], { 'x-next-page': '2' }))
      .mockResolvedValueOnce(respond(200, [3], { 'x-next-page': '3' }))
      .mockResolvedValueOnce(respond(200, [4], { 'x-next-page': '' }));

    expect(await client.paginate(APP, '/groups?a=1', 'tok', 2)).toEqual([
      1, 2, 3,
    ]);
    expect(fetchMock().mock.calls[1][0]).toBe(
      'https://gitlab.example.com/api/v4/groups?a=1&per_page=100&page=2',
    );
    expect(await client.paginate(APP, '/groups', 'tok', 5)).toEqual([4]);
  });

  describe('own self-managed server (ticket 11)', () => {
    it('uses the relative root for the API and OAuth and never follows redirects', async () => {
      fetchMock()
        .mockResolvedValueOnce(respond(200, { id: 1 }))
        .mockResolvedValueOnce(
          respond(200, { access_token: 'at', expires_in: 60 }),
        );

      await client.api(OWN, '/user', 'tok');
      await client.exchangeCode(OWN, 'code', 'https://api/cb');

      const [[apiUrl, apiInit], [tokenUrl, tokenInit]] = fetchMock().mock.calls;
      expect(apiUrl).toBe('https://company.local/gitlab/api/v4/user');
      expect(apiInit.redirect).toBe('manual');
      expect(tokenUrl).toBe('https://company.local/gitlab/oauth/token');
      expect(tokenInit.redirect).toBe('manual');
      expect(String(tokenInit.body)).toContain('client_id=own-cid');
    });

    it('a redirect answer is an error, not followed', async () => {
      fetchMock().mockResolvedValue(
        respond(302, null, { location: 'http://169.254.169.254/' }),
      );

      await expect(client.api(OWN, '/user', 'tok')).rejects.toMatchObject({
        status: 302,
      });
    });

    describe('probeVersion', () => {
      it("401 with GitLab's body proves a GitLab without a token", async () => {
        fetchMock().mockResolvedValue(
          respond(401, { message: '401 Unauthorized' }),
        );

        expect(await client.probeVersion(OWN)).toEqual({
          status: 401,
          version: null,
          isGitlab: true,
        });
        const [url, init] = fetchMock().mock.calls[0];
        expect(url).toBe('https://company.local/gitlab/api/v4/version');
        expect(init.redirect).toBe('manual');
        expect(init.headers.authorization).toBeUndefined();
      });

      it('200 with a version (token given)', async () => {
        fetchMock().mockResolvedValue(
          respond(200, { version: '17.5.1-ee', revision: 'abc' }),
        );

        expect(await client.probeVersion(OWN, 'tok')).toEqual({
          status: 200,
          version: '17.5.1-ee',
          isGitlab: true,
        });
        expect(fetchMock().mock.calls[0][1].headers.authorization).toBe(
          'Bearer tok',
        );
      });

      it('some other web server is not GitLab', async () => {
        fetchMock().mockResolvedValue(respond(404, null));

        expect((await client.probeVersion(OWN)).isGitlab).toBe(false);
      });

      it('a redirect throws GitlabApiError "redirected"', async () => {
        fetchMock().mockResolvedValue(
          respond(301, null, { location: 'https://sso.company.local/login' }),
        );

        const error = await client.probeVersion(OWN).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(GitlabApiError);
        expect((error as GitlabApiError).message).toContain(
          'redirected (301) to https://sso.company.local/login',
        );
      });
    });

    describe('checkOAuthClient', () => {
      it.each([
        ['invalid_client', 401, 'client_invalid'],
        ['invalid_grant', 400, 'ok'],
        ['server_error', 500, 'unknown'],
      ])('%s -> %s', async (error, status, expected) => {
        fetchMock().mockResolvedValue(respond(status, { error }));

        expect(await client.checkOAuthClient(OWN, 'https://api/cb')).toBe(
          expected,
        );
      });
    });
  });
});
