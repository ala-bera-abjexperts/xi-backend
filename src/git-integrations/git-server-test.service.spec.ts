/**
 * @fileoverview Unit tests for "Test connection" and the server health check (ticket 11): every check's
 * code for the typical failures (TLS, DNS, refused, redirect, wrong credentials, webhook settings, events
 * not arriving, GitLab blocking the local network), the order / skipping, the rate limit, and the
 * conditional status changes of the health check. Clients and services are mocked.
 * @module src/git-integrations/git-server-test.service.spec
 */

import { HttpException } from '@nestjs/common';

import { GithubApiError } from './github/github-app.client';
import { GitlabApiError } from './gitlab/gitlab.client';
import type { IGitApp, IGitServerRow } from './git-integrations.types';
import { resetServerAddressChecks } from './git-server-address.util';
import {
  GitServerTestService,
  classifyReachError,
  meetsVersion,
} from './git-server-test.service';

const ORG = 'org-1';
const ID = '11111111-1111-4111-8111-111111111111';

function fetchError(code: string): Error {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error(code), { code }),
  });
}

function row(over: Partial<IGitServerRow> = {}): IGitServerRow {
  return {
    id: ID,
    organization_id: ORG,
    provider: 'github',
    host: '10.0.0.9',
    base_url: 'https://10.0.0.9',
    previous_base_urls: [],
    name: 'GHES',
    app_id: '7',
    app_slug: 'xisuite',
    client_id: 'cid',
    encrypted_secret: null,
    encryption_iv: null,
    encryption_tag: null,
    status: 'active',
    status_reason: null,
    status_detail: null,
    status_changed_at: '',
    last_webhook_at: null,
    last_test: null,
    last_test_at: null,
    created_by: 'u',
    updated_by: 'u',
    created_at: '',
    updated_at: '',
    ...over,
  };
}

function appOf(server: IGitServerRow, over: Partial<IGitApp> = {}): IGitApp {
  return {
    serverId: server.id,
    provider: server.provider,
    host: server.host,
    webUrl: server.base_url,
    apiUrl:
      server.provider === 'github'
        ? `${server.base_url}/api/v3`
        : `${server.base_url}/api/v4`,
    appId: '7',
    appSlug: 'xisuite',
    privateKey: 'PEM',
    clientId: 'cid',
    clientSecret: 'secret',
    webhookSecret: 'wh',
    ...over,
  };
}

function setup(
  server: IGitServerRow = row(),
  appOver: Partial<IGitApp> = {},
  options: { onPremise?: boolean; publicApiUrl?: string } = {},
) {
  const servers = {
    onPremise: options.onPremise ?? true,
    publicApiUrl: options.publicApiUrl ?? 'https://203.0.113.10/api/v1',
    get: jest.fn().mockResolvedValue(server),
    toApp: jest.fn((s: IGitServerRow) => appOf(s, appOver)),
    listAll: jest.fn().mockResolvedValue([server]),
    saveSlug: jest.fn().mockResolvedValue(undefined),
    saveTest: jest.fn().mockResolvedValue(undefined),
    setStatus: jest.fn().mockResolvedValue(undefined),
    resetWebhookTouch: jest.fn().mockResolvedValue(undefined),
    lastWebhookAt: jest.fn().mockResolvedValue('2026-10-22T10:00:00Z'),
    githubWebhookUrl: (id: string) =>
      `https://203.0.113.10/api/v1/git-integrations/github/webhook/${id}`,
  };
  const github = {
    getMeta: jest.fn().mockResolvedValue({ installed_version: '3.14.2' }),
    appJwt: jest.fn().mockReturnValue('jwt'),
    getApp: jest.fn().mockResolvedValue({ id: 7, slug: 'xisuite-ghes' }),
    checkOAuthClient: jest.fn().mockResolvedValue('ok'),
    getHookConfig: jest.fn().mockResolvedValue({
      url: `https://203.0.113.10/api/v1/git-integrations/github/webhook/${ID}`,
      content_type: 'json',
      secret: '********',
    }),
    listHookDeliveries: jest
      .fn()
      .mockResolvedValue([{ id: 99, status: 'OK', status_code: 200 }]),
    redeliver: jest.fn().mockResolvedValue(undefined),
  };
  const gitlab = {
    probeVersion: jest
      .fn()
      .mockResolvedValue({ status: 401, version: null, isGitlab: true }),
    checkOAuthClient: jest.fn().mockResolvedValue('ok'),
  };
  const gitlabIntegration = {
    testInboundHook: jest.fn().mockResolvedValue({ result: 'sent' }),
    checkHookAlerts: jest
      .fn()
      .mockResolvedValue({ failing: [], failingTotal: 0, checked: 1 }),
  };
  const service = new GitServerTestService(
    servers as never,
    github as never,
    gitlab as never,
    gitlabIntegration as never,
  );

  return { service, servers, github, gitlab, gitlabIntegration };
}

const byKey = (result: { checks: { key: string }[] }, key: string) =>
  result.checks.find((check) => check.key === key);

beforeEach(() => {
  resetServerAddressChecks();
  jest.useFakeTimers({ advanceTimers: true });
});
afterEach(() => jest.useRealTimers());

/** The inbound wait polls once a second; advance fake time while the test runs. */
async function run<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  const settled = promise.finally(() => {
    done = true;
  });

  while (!done) await jest.advanceTimersByTimeAsync(1000);

  return settled;
}

describe('classifyReachError / meetsVersion', () => {
  it.each([
    [fetchError('SELF_SIGNED_CERT_IN_CHAIN'), 'tls_untrusted'],
    [fetchError('UNABLE_TO_VERIFY_LEAF_SIGNATURE'), 'tls_untrusted'],
    [fetchError('DEPTH_ZERO_SELF_SIGNED_CERT'), 'tls_untrusted'],
    [fetchError('CERT_HAS_EXPIRED'), 'tls_expired'],
    [fetchError('ERR_TLS_CERT_ALTNAME_INVALID'), 'tls_name_mismatch'],
    [fetchError('ENOTFOUND'), 'dns_not_found'],
    [fetchError('ECONNREFUSED'), 'connection_refused'],
    [fetchError('UND_ERR_CONNECT_TIMEOUT'), 'timeout'],
    [Object.assign(new Error('t'), { name: 'TimeoutError' }), 'timeout'],
    [new GithubApiError(302, 'redirected'), 'redirected'],
    [new GitlabApiError(500, 'x'), 'unexpected_response'],
    [new Error('other'), 'unreachable'],
  ])('%s → %s', (error, code) => {
    expect(classifyReachError(error)).toBe(code);
  });

  it('meetsVersion compares major.minor; unknown counts as supported', () => {
    expect(meetsVersion('3.14.2', '3.12')).toBe(true);
    expect(meetsVersion('3.9.0', '3.12')).toBe(false);
    expect(meetsVersion('16.0.1-ee', '16.0')).toBe(true);
    expect(meetsVersion('15.11.3', '16.0')).toBe(false);
    expect(meetsVersion(null, '16.0')).toBe(true);
  });
});

describe('test: GitHub Enterprise Server', () => {
  it('all good: every check ok, slug read from GitHub, the newest delivery redelivered and received', async () => {
    const { service, servers, github } = setup();

    const result = await run(service.test(ORG, ID));

    expect(result.ok).toBe(true);
    expect(result.version).toBe('3.14.2');
    expect(result.checks.map((c) => [c.key, c.result])).toEqual([
      ['address', 'ok'],
      ['reach', 'ok'],
      ['version', 'ok'],
      ['credentials', 'ok'],
      ['webhook_settings', 'ok'],
      ['inbound', 'ok'],
      ['public_url', 'ok'],
    ]);
    expect(servers.saveSlug).toHaveBeenCalledWith(
      expect.anything(),
      'xisuite-ghes',
    );
    expect(servers.resetWebhookTouch).toHaveBeenCalled();
    expect(github.redeliver).toHaveBeenCalledWith(expect.anything(), 99);
    expect(servers.saveTest).toHaveBeenCalledWith(expect.anything(), result);
    expect(servers.setStatus).toHaveBeenCalledWith(
      expect.anything(),
      'active',
      null,
      null,
    );
  });

  it('an untrusted certificate stops at reach (remedy: extra-ca.pem) and skips the rest', async () => {
    const { service, github, servers } = setup();

    github.getMeta.mockRejectedValue(fetchError('SELF_SIGNED_CERT_IN_CHAIN'));

    const result = await run(service.test(ORG, ID));

    expect(result.ok).toBe(false);
    expect(byKey(result, 'reach')).toMatchObject({
      result: 'error',
      code: 'tls_untrusted',
      detail: expect.stringContaining('extra-ca.pem'),
    });
    expect(byKey(result, 'credentials')).toMatchObject({ result: 'skipped' });
    expect(byKey(result, 'inbound')).toMatchObject({ result: 'skipped' });
    expect(servers.setStatus).not.toHaveBeenCalled();
  });

  it('a private address in SaaS fails the address check without contacting the server', async () => {
    const { service, github } = setup(row(), {}, { onPremise: false });

    const result = await run(service.test(ORG, ID));

    expect(byKey(result, 'address')).toMatchObject({
      result: 'error',
      code: 'private_address_blocked',
    });
    expect(github.getMeta).not.toHaveBeenCalled();
  });

  it('an old GHES is a warning, not a failure', async () => {
    const { service, github } = setup();

    github.getMeta.mockResolvedValue({ installed_version: '3.9.1' });

    const result = await run(service.test(ORG, ID));

    expect(byKey(result, 'version')).toMatchObject({
      result: 'warning',
      code: 'version_unsupported',
    });
    expect(result.ok).toBe(true);
  });

  it('a private key that does not sign → private_key_invalid; a rejected JWT → app_id_or_key_invalid', async () => {
    const one = setup();

    one.github.appJwt.mockImplementation(() => {
      throw new Error('error:1E08010C:DECODER routines::unsupported');
    });
    expect(
      byKey(await run(one.service.test(ORG, ID)), 'credentials'),
    ).toMatchObject({ result: 'error', code: 'private_key_invalid' });

    const two = setup();

    two.github.getApp.mockRejectedValue(new GithubApiError(401, 'bad jwt'));
    expect(
      byKey(await run(two.service.test(ORG, ID)), 'credentials'),
    ).toMatchObject({ result: 'error', code: 'app_id_or_key_invalid' });
  });

  it('a wrong client secret → client_invalid; missing values are named', async () => {
    const one = setup();

    one.github.checkOAuthClient.mockResolvedValue('client_invalid');
    expect(
      byKey(await run(one.service.test(ORG, ID)), 'credentials'),
    ).toMatchObject({ code: 'client_invalid' });

    const two = setup(row(), { clientSecret: undefined });

    expect(
      byKey(await run(two.service.test(ORG, ID)), 'credentials'),
    ).toMatchObject({ code: 'missing_client' });
  });

  it('webhook URL typed wrong in the App → webhook_url_mismatch with both addresses', async () => {
    const { service, github } = setup();

    github.getHookConfig.mockResolvedValue({
      url: 'https://typo.example/hook',
      content_type: 'json',
      secret: '********',
    });

    expect(
      byKey(await run(service.test(ORG, ID)), 'webhook_settings'),
    ).toMatchObject({
      result: 'error',
      code: 'webhook_url_mismatch',
      detail: expect.stringContaining('https://typo.example/hook'),
    });
  });

  it("the server cannot reach XISUITE → webhook_not_received with GitHub's own delivery status", async () => {
    const { service, servers, github } = setup();

    servers.lastWebhookAt.mockResolvedValue(null);
    github.listHookDeliveries
      .mockResolvedValueOnce([{ id: 99, status: 'OK', status_code: 200 }])
      .mockResolvedValueOnce([
        { id: 100, status: "Couldn't connect to server", status_code: 0 },
      ]);

    const result = await run(service.test(ORG, ID));

    expect(byKey(result, 'inbound')).toMatchObject({
      result: 'error',
      code: 'webhook_not_received',
      detail: "Couldn't connect to server (0)",
    });
    expect(servers.lastWebhookAt).toHaveBeenCalledTimes(10);
  });

  it('no delivery yet → warning, nothing redelivered', async () => {
    const { service, github } = setup();

    github.listHookDeliveries.mockResolvedValue([]);

    expect(byKey(await run(service.test(ORG, ID)), 'inbound')).toMatchObject({
      result: 'warning',
      code: 'no_delivery_yet',
    });
    expect(github.redeliver).not.toHaveBeenCalled();
  });

  it('a second test within 10 seconds is refused (429)', async () => {
    const { service } = setup();

    await run(service.test(ORG, ID));
    await expect(service.test(ORG, ID)).rejects.toBeInstanceOf(HttpException);
  });

  it('XISUITE on localhost in SaaS → public_url_unreachable', async () => {
    const { service } = setup(
      row({ base_url: 'https://140.82.112.3', host: '140.82.112.3' }),
      {},
      { onPremise: false, publicApiUrl: 'http://127.0.0.1:3001/api/v1' },
    );

    expect(byKey(await run(service.test(ORG, ID)), 'public_url')).toMatchObject(
      { result: 'warning', code: 'public_url_unreachable' },
    );
  });
});

describe('test: self-managed GitLab', () => {
  const gitlabRow = row({
    provider: 'gitlab',
    base_url: 'https://10.0.0.20/gitlab',
    host: '10.0.0.20',
    app_id: null,
  });

  it('a 401 from /version proves GitLab; the project hook test arrives → ok', async () => {
    const { service, gitlabIntegration } = setup(gitlabRow);

    const result = await run(service.test(ORG, ID));

    expect(result.checks.map((c) => [c.key, c.result])).toEqual([
      ['address', 'ok'],
      ['reach', 'ok'],
      ['version', 'skipped'],
      ['credentials', 'ok'],
      ['inbound', 'ok'],
      ['public_url', 'ok'],
    ]);
    expect(gitlabIntegration.testInboundHook).toHaveBeenCalledWith(
      ORG,
      '10.0.0.20',
    );
  });

  it('something else on that address → not_gitlab', async () => {
    const { service, gitlab } = setup(gitlabRow);

    gitlab.probeVersion.mockResolvedValue({
      status: 404,
      version: null,
      isGitlab: false,
    });

    expect(byKey(await run(service.test(ORG, ID)), 'reach')).toMatchObject({
      result: 'error',
      code: 'not_gitlab',
    });
  });

  it('GitLab blocks requests to the local network → local_network_blocked with its message', async () => {
    const { service, gitlabIntegration } = setup(gitlabRow);

    gitlabIntegration.testInboundHook.mockResolvedValue({
      result: 'blocked',
      detail: 'URL is blocked: Requests to the local network are not allowed',
    });

    expect(byKey(await run(service.test(ORG, ID)), 'inbound')).toMatchObject({
      result: 'error',
      code: 'local_network_blocked',
      detail: expect.stringContaining('local network'),
    });
  });

  it('no connected project yet → warning (connect a group first)', async () => {
    const { service, gitlabIntegration } = setup(gitlabRow);

    gitlabIntegration.testInboundHook.mockResolvedValue({
      result: 'no_project',
    });

    const result = await run(service.test(ORG, ID));

    expect(byKey(result, 'inbound')).toMatchObject({
      result: 'warning',
      code: 'no_project_yet',
    });
    expect(result.ok).toBe(true);
  });

  it('XISUITE on a private address → the GitLab local-network hint', async () => {
    const { service } = setup(
      gitlabRow,
      {},
      {
        publicApiUrl: 'https://10.0.0.5/api/v1',
      },
    );

    expect(byKey(await run(service.test(ORG, ID)), 'public_url')).toMatchObject(
      { result: 'warning', code: 'gitlab_local_network_needed' },
    );
  });
});

describe('checkServers (health)', () => {
  it('unreachable → needs attention with the reason and the raw detail', async () => {
    const { service, servers, github } = setup();

    github.getMeta.mockRejectedValue(fetchError('ECONNREFUSED'));

    await service.checkServers();

    expect(servers.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: ID }),
      'needs_attention',
      'connection_refused',
      expect.stringContaining('ECONNREFUSED'),
    );
  });

  it("GitHub's newest 3 deliveries all failed → webhook_failing; mixed → active", async () => {
    const one = setup();

    one.github.listHookDeliveries.mockResolvedValue([
      { status: 'Invalid HTTP Response: 401', status_code: 401 },
      { status: "Couldn't connect to server", status_code: 0 },
      { status: "Couldn't connect to server", status_code: 0 },
    ]);
    await one.service.checkServers();
    expect(one.servers.setStatus).toHaveBeenCalledWith(
      expect.anything(),
      'needs_attention',
      'webhook_failing',
      'Invalid HTTP Response: 401 (401)',
    );

    const two = setup();

    two.github.listHookDeliveries.mockResolvedValue([
      { status: 'OK', status_code: 200 },
      { status: "Couldn't connect to server", status_code: 0 },
      { status: "Couldn't connect to server", status_code: 0 },
    ]);
    await two.service.checkServers();
    expect(two.servers.setStatus).toHaveBeenCalledWith(
      expect.anything(),
      'active',
      null,
      null,
    );
  });

  it('GitLab hooks disabled by GitLab → webhook_failing naming the projects', async () => {
    const { service, servers, gitlabIntegration } = setup(
      row({
        provider: 'gitlab',
        host: '10.0.0.20',
        base_url: 'https://10.0.0.20',
      }),
    );

    gitlabIntegration.checkHookAlerts.mockResolvedValue({
      failing: [
        { repositoryId: 'r', fullName: 'grp/app', alertStatus: 'disabled' },
      ],
      failingTotal: 1,
      checked: 1,
    });

    await service.checkServers();

    expect(servers.setStatus).toHaveBeenCalledWith(
      expect.anything(),
      'needs_attention',
      'webhook_failing',
      'grp/app: disabled',
    );
  });

  it('GitLab: more failing hooks than listed are counted in the detail', async () => {
    const { service, servers, gitlabIntegration } = setup(
      row({
        provider: 'gitlab',
        host: '10.0.0.20',
        base_url: 'https://10.0.0.20',
      }),
    );

    gitlabIntegration.checkHookAlerts.mockResolvedValue({
      failing: Array.from({ length: 5 }, (_, i) => ({
        repositoryId: `r${i}`,
        fullName: `grp/app${i}`,
        alertStatus: 'disabled',
      })),
      failingTotal: 8,
      checked: 25,
    });

    await service.checkServers();

    expect(servers.setStatus).toHaveBeenCalledWith(
      expect.anything(),
      'needs_attention',
      'webhook_failing',
      expect.stringMatching(/grp\/app4: disabled \(\+3\)$/),
    );
  });

  it('a half-registered server is not watched', async () => {
    const { service, servers, github } = setup(row(), { appSlug: undefined });

    await service.checkServers();

    expect(github.getMeta).not.toHaveBeenCalled();
    expect(servers.setStatus).not.toHaveBeenCalled();
  });
});
