/**
 * @fileoverview Unit tests for GitServersService (ticket 11): the app resolver (own server, built-in, none),
 * the SaaS / on-premise address policy, create / update (address change keeps the key and rewrites links)
 * / delete, secrets never leaving the service, conditional status changes, and tenant scoping.
 * The Supabase admin client is a small recording mock; addresses are IP literals, so no DNS is involved.
 * @module src/git-integrations/git-servers.service.spec
 */

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { decryptApiKey, encryptApiKey } from '../lib/crypto/encryption';
import type { IGitServerRow } from './git-integrations.types';
import { resetServerAddressChecks } from './git-server-address.util';
import {
  GitServersService,
  apiUrlOf,
  isAppComplete,
} from './git-servers.service';

const ORG = 'org-1';
const USER = 'user-1';
const SERVER_ID = '11111111-1111-4111-8111-111111111111';

process.env.AI_ENCRYPTION_SECRET ??= 'a'.repeat(64);

interface ICall {
  method: string;
  args: unknown[];
}
interface IChain {
  table: string;
  calls: ICall[];
}
interface IResult {
  data?: unknown;
  error?: { message: string; code?: string } | null;
  count?: number | null;
}

function makeDb() {
  const chains: IChain[] = [];
  const queues = new Map<string, IResult[]>();
  const rpc = jest.fn().mockResolvedValue({ data: 5, error: null });

  const from = (table: string) => {
    const chain: IChain = { table, calls: [] };
    let resolved: unknown;
    const resolve = () => {
      if (!resolved) {
        const result = queues.get(table)?.shift() ?? {};

        resolved = {
          data: result.data ?? null,
          error: result.error ?? null,
          count: result.count ?? null,
        };
      }

      return resolved;
    };
    const builder: Record<string, unknown> = {};

    chains.push(chain);

    for (const method of [
      'select',
      'insert',
      'update',
      'delete',
      'eq',
      'neq',
      'in',
      'or',
      'order',
      'match',
    ]) {
      builder[method] = (...args: unknown[]) => {
        chain.calls.push({ method, args });

        return builder;
      };
    }

    for (const method of ['maybeSingle', 'single']) {
      builder[method] = () => {
        chain.calls.push({ method, args: [] });

        return Promise.resolve(resolve());
      };
    }

    builder.then = (
      onF: (v: unknown) => unknown,
      onR?: (e: unknown) => unknown,
    ) => Promise.resolve(resolve()).then(onF, onR);

    return builder;
  };

  return {
    client: { from, rpc },
    rpc,
    queue(table: string, ...results: IResult[]) {
      queues.set(table, [...(queues.get(table) ?? []), ...results]);
    },
    of(table: string) {
      return chains.filter((chain) => chain.table === table);
    },
  };
}

const has = (chain: IChain, method: string, ...args: unknown[]) =>
  chain.calls.some(
    (call) =>
      call.method === method &&
      args.every((arg, index) => call.args[index] === arg),
  );

const callArg = (chain: IChain, method: string) =>
  chain.calls.find((call) => call.method === method)!.args[0] as Record<
    string,
    unknown
  >;

function secretsOf(row: Record<string, unknown>) {
  return JSON.parse(
    decryptApiKey(
      row.encrypted_secret as string,
      row.encryption_iv as string,
      row.encryption_tag as string,
    ),
  ) as Record<string, string>;
}

function serverRow(over: Partial<IGitServerRow> = {}): IGitServerRow {
  const encrypted = encryptApiKey(
    JSON.stringify({
      clientSecret: 'csecret',
      privateKey: 'PEM',
      webhookSecret: 'whsec',
    }),
  );

  return {
    id: SERVER_ID,
    organization_id: ORG,
    provider: 'github',
    host: 'ghe.example.com',
    base_url: 'https://ghe.example.com',
    previous_base_urls: [],
    name: 'Company GHES',
    app_id: '7',
    app_slug: 'xisuite',
    client_id: 'cid',
    encrypted_secret: encrypted.encrypted,
    encryption_iv: encrypted.iv,
    encryption_tag: encrypted.tag,
    status: 'active',
    status_reason: null,
    status_detail: null,
    status_changed_at: '2026-10-22T00:00:00Z',
    last_webhook_at: null,
    last_test: null,
    last_test_at: null,
    created_by: USER,
    updated_by: USER,
    created_at: '2026-10-22T00:00:00Z',
    updated_at: '2026-10-22T00:00:00Z',
    ...over,
  };
}

function setup(
  options: {
    onPremise?: boolean;
    github?: Record<string, string | undefined>;
  } = {},
) {
  const db = makeDb();
  const audit = { logAction: jest.fn().mockResolvedValue(undefined) };
  const broadcast = { broadcastNotification: jest.fn() };
  const values: Record<string, unknown> = {
    'onPrem.enabled': options.onPremise ?? false,
    publicApiUrl: 'https://api.xisuite.test/api/v1/',
    appUrl: 'https://app.xisuite.test',
    'git.github': options.github ?? {
      appId: '1',
      appSlug: 'xisuite',
      privateKey: 'PEM',
      clientId: 'gh-cid',
      clientSecret: 'gh-secret',
      webhookSecret: 'gh-wh',
    },
    'git.gitlab': {
      clientId: 'gl-cid',
      clientSecret: 'gl-secret',
      baseUrl: 'https://gitlab.com',
    },
  };
  const service = new GitServersService(
    { getClient: () => db.client } as never,
    audit as never,
    broadcast as never,
    { get: (key: string) => values[key] } as never,
  );

  return { service, db, audit, broadcast };
}

beforeEach(() => resetServerAddressChecks());

describe('helpers', () => {
  it('apiUrlOf: api.github.com for github.com, /api/v3 on GHES, /api/v4 on GitLab (relative root kept)', () => {
    expect(apiUrlOf('github', 'https://github.com')).toBe(
      'https://api.github.com',
    );
    expect(apiUrlOf('github', 'https://ghe.local')).toBe(
      'https://ghe.local/api/v3',
    );
    expect(apiUrlOf('gitlab', 'https://company.com/gitlab')).toBe(
      'https://company.com/gitlab/api/v4',
    );
  });

  it('isAppComplete: Azure DevOps needs only the OAuth client', () => {
    const app = {
      serverId: null,
      provider: 'azure_devops' as const,
      host: 'dev.azure.com',
      webUrl: 'https://dev.azure.com',
      apiUrl: 'https://dev.azure.com',
    };

    expect(isAppComplete(app)).toBe(false);
    expect(isAppComplete({ ...app, clientId: 'c' })).toBe(false);
    expect(isAppComplete({ ...app, clientId: 'c', clientSecret: 's' })).toBe(
      true,
    );
  });

  it('isAppComplete: GitHub needs the slug too; GitLab only the OAuth client', () => {
    const base = { serverId: 'x', host: 'h', webUrl: 'w', apiUrl: 'a' };

    expect(
      isAppComplete({
        ...base,
        provider: 'gitlab',
        clientId: 'a',
        clientSecret: 'b',
      }),
    ).toBe(true);
    expect(
      isAppComplete({
        ...base,
        provider: 'github',
        appId: '1',
        privateKey: 'k',
        clientId: 'a',
        clientSecret: 'b',
        webhookSecret: 'w',
      }),
    ).toBe(false);
  });
});

describe('appFor', () => {
  it("uses the organization's server row (secrets decrypted, GHES API base)", async () => {
    const { service, db } = setup({ onPremise: true });

    db.queue('git_servers', {
      data: serverRow({ base_url: 'https://10.0.0.9', host: '10.0.0.9' }),
    });

    const app = await service.appFor(ORG, 'github', '10.0.0.9');

    expect(app).toMatchObject({
      serverId: SERVER_ID,
      host: '10.0.0.9',
      webUrl: 'https://10.0.0.9',
      apiUrl: 'https://10.0.0.9/api/v3',
      appId: '7',
      clientSecret: 'csecret',
      privateKey: 'PEM',
      webhookSecret: 'whsec',
    });
    const [chain] = db.of('git_servers');

    expect(has(chain, 'eq', 'organization_id', ORG)).toBe(true);
    expect(has(chain, 'eq', 'host', '10.0.0.9')).toBe(true);
  });

  it('falls back to the built-in app for its own host only, and caches the answer', async () => {
    const { service, db } = setup();

    db.queue('git_servers', { data: null });

    expect(await service.appFor(ORG, 'github', 'github.com')).toMatchObject({
      serverId: null,
      apiUrl: 'https://api.github.com',
      appId: '1',
    });
    await service.appFor(ORG, 'github', 'github.com');
    expect(db.of('git_servers')).toHaveLength(1);
  });

  it('never uses the built-in app for a foreign host', async () => {
    const { service, db } = setup();

    db.queue('git_servers', { data: null });

    await expect(
      service.appFor(ORG, 'github', 'ghe.other.com'),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('refuses a server on a private address in SaaS', async () => {
    const { service, db } = setup();

    db.queue('git_servers', {
      data: serverRow({ base_url: 'https://10.0.0.9', host: '10.0.0.9' }),
    });

    await expect(
      service.appFor(ORG, 'github', '10.0.0.9'),
    ).rejects.toMatchObject({ code: 'private_address_blocked' });
  });
});

describe('create', () => {
  it('stores the normalized address as key + base, generates a GitHub webhook secret and audits', async () => {
    const { service, db, audit } = setup({ onPremise: true });

    db.queue('git_servers', {
      data: serverRow({ host: '10.0.0.9', base_url: 'https://10.0.0.9/ghe' }),
    });
    db.queue('git_connections', { data: [] });

    const dto = await service.create(ORG, USER, {
      provider: 'github',
      baseUrl: 'HTTPS://10.0.0.9/ghe/',
      name: ' Company GHES ',
    });
    const row = callArg(db.of('git_servers')[0], 'insert');

    expect(row).toMatchObject({
      organization_id: ORG,
      provider: 'github',
      host: '10.0.0.9',
      base_url: 'https://10.0.0.9/ghe',
      name: 'Company GHES',
    });
    expect(secretsOf(row).webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(dto).toMatchObject({ hasClientSecret: true, hasPrivateKey: true });
    expect(JSON.stringify(dto)).not.toMatch(/csecret|whsec|PEM|encrypt/);
    expect(audit.logAction).toHaveBeenCalledWith(
      ORG,
      USER,
      'git_server',
      SERVER_ID,
      'create',
      expect.objectContaining({ event: 'server_added' }),
    );
  });

  it.each([
    ['https://10.0.0.9', false, 'private_address_blocked'],
    ['http://gitlab.example.com', false, 'http_insecure'],
    ['not a url', true, 'invalid_url'],
  ])('refuses %s (on-premise %s) with %s', async (baseUrl, onPremise, code) => {
    const { service } = setup({ onPremise });

    await expect(
      service.create(ORG, USER, { provider: 'gitlab', baseUrl, name: 'x' }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code }) });
  });

  it('refuses an own app for the host the built-in app serves, allows it without the built-in app (on-premise)', async () => {
    const saas = setup({ onPremise: true });

    jest.spyOn(saas.service, 'builtinHost').mockReturnValue('10.0.0.1');
    await expect(
      saas.service.create(ORG, USER, {
        provider: 'github',
        baseUrl: 'https://10.0.0.1',
        name: 'x',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'builtin_available' }),
    });

    const onPrem = setup({ onPremise: true, github: {} });

    jest.spyOn(onPrem.service, 'builtinHost').mockReturnValue('10.0.0.1');
    onPrem.db.queue('git_servers', { data: serverRow({ host: '10.0.0.1' }) });
    await expect(
      onPrem.service.create(ORG, USER, {
        provider: 'github',
        baseUrl: 'https://10.0.0.1',
        name: 'x',
      }),
    ).resolves.toMatchObject({ id: SERVER_ID });
  });

  it('maps a duplicate (org, provider, host) to 409 server_exists', async () => {
    const { service, db } = setup({ onPremise: true });

    db.queue('git_servers', { error: { message: 'dup', code: '23505' } });

    await expect(
      service.create(ORG, USER, {
        provider: 'gitlab',
        baseUrl: 'https://10.0.0.9',
        name: 'x',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('update', () => {
  it('a new address keeps the host key, remembers the old address and rewrites the links', async () => {
    const { service, db, audit } = setup({ onPremise: true });
    const current = serverRow({
      host: '10.0.0.9',
      base_url: 'https://10.0.0.9',
      previous_base_urls: ['https://old.local'],
    });

    db.queue(
      'git_servers',
      { data: current },
      { data: { ...current, base_url: 'https://10.0.0.10/git' } },
    );
    db.queue('git_connections', { data: [] });

    await service.update(ORG, SERVER_ID, USER, {
      baseUrl: 'https://10.0.0.10/git/',
    });

    const update = db.of('git_servers')[1];
    const patch = callArg(update, 'update');

    expect(patch.base_url).toBe('https://10.0.0.10/git');
    expect(patch).not.toHaveProperty('host');
    expect(patch.previous_base_urls).toEqual([
      'https://10.0.0.9',
      'https://old.local',
    ]);
    expect(has(update, 'eq', 'organization_id', ORG)).toBe(true);
    expect(db.rpc).toHaveBeenCalledWith('git_server_rebase_urls', {
      p_org: ORG,
      p_provider: 'github',
      p_host: '10.0.0.9',
      p_old: 'https://10.0.0.9/',
      p_new: 'https://10.0.0.10/git/',
    });
    expect(audit.logAction).toHaveBeenCalledWith(
      ORG,
      USER,
      'git_server',
      SERVER_ID,
      'update',
      expect.objectContaining({
        event: 'server_address_changed',
        links_rewritten: 5,
      }),
    );
  });

  it('clears the stored test when address or app values change, not for a new name', async () => {
    const { service, db } = setup({ onPremise: true });
    const current = serverRow();

    db.queue(
      'git_servers',
      { data: current },
      { data: current },
      { data: current },
      { data: current },
    );
    db.queue('git_connections', { data: [] }, { data: [] });

    await service.update(ORG, SERVER_ID, USER, { clientId: 'new-client' });
    await service.update(ORG, SERVER_ID, USER, { name: 'Renamed' });

    const [, withValues, , renamed] = db.of('git_servers');

    expect(callArg(withValues, 'update')).toMatchObject({
      last_test: null,
      last_test_at: null,
    });
    expect(callArg(renamed, 'update')).not.toHaveProperty('last_test');
  });

  it('re-encrypts secrets: a new client secret keeps the private key and webhook secret', async () => {
    const { service, db } = setup({ onPremise: true });
    const current = serverRow();

    db.queue('git_servers', { data: current }, { data: current });
    db.queue('git_connections', { data: [] });

    await service.update(ORG, SERVER_ID, USER, { clientSecret: 'new-secret' });

    expect(secretsOf(callArg(db.of('git_servers')[1], 'update'))).toEqual({
      clientSecret: 'new-secret',
      privateKey: 'PEM',
      webhookSecret: 'whsec',
    });
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('refuses a private key that is not a PEM, and an App ID that is not a number', async () => {
    const { service, db } = setup();

    db.queue('git_servers', { data: serverRow() }, { data: serverRow() });

    await expect(
      service.update(ORG, SERVER_ID, USER, { privateKey: 'nope' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.update(ORG, SERVER_ID, USER, { appId: 'abc' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("404 for another organization's server", async () => {
    const { service, db } = setup();

    db.queue('git_servers', { data: null });

    await expect(
      service.update(ORG, SERVER_ID, USER, { name: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('remove', () => {
  it('409 server_in_use while a connection on its host is live', async () => {
    const { service, db } = setup();

    db.queue('git_servers', { data: serverRow() });
    db.queue('git_connections', { count: 1 });

    await expect(service.remove(ORG, SERVER_ID, USER)).rejects.toBeInstanceOf(
      ConflictException,
    );

    const [count] = db.of('git_connections');

    expect(has(count, 'eq', 'organization_id', ORG)).toBe(true);
    expect(has(count, 'eq', 'host', 'ghe.example.com')).toBe(true);
    expect(has(count, 'neq', 'status', 'disconnected')).toBe(true);
  });

  it('deletes scoped to the organization and audits', async () => {
    const { service, db, audit } = setup();

    db.queue('git_servers', { data: serverRow() }, { data: null });
    db.queue('git_connections', { count: 0 });

    await service.remove(ORG, SERVER_ID, USER);

    const del = db.of('git_servers')[1];

    expect(has(del, 'delete')).toBe(true);
    expect(has(del, 'eq', 'organization_id', ORG)).toBe(true);
    expect(audit.logAction).toHaveBeenCalledWith(
      ORG,
      USER,
      'git_server',
      SERVER_ID,
      'delete',
      expect.objectContaining({ event: 'server_removed' }),
    );
  });
});

describe('setStatus', () => {
  it('notifies owners and admins once, only when this instance flipped the row', async () => {
    const { service, db, broadcast } = setup();

    db.queue('git_servers', { data: [{ id: SERVER_ID }] });
    db.queue('organization_members', {
      data: [{ user_id: 'a' }, { user_id: 'b' }],
    });
    db.queue('notifications', { data: [{ id: 'n1' }, { id: 'n2' }] });

    await service.setStatus(
      serverRow(),
      'needs_attention',
      'tls_untrusted',
      'x'.repeat(900),
    );

    const flip = db.of('git_servers')[0];

    expect(has(flip, 'eq', 'status', 'active')).toBe(true);
    expect(callArg(flip, 'update').status_detail).toHaveLength(500);
    expect(callArg(db.of('notifications')[0], 'insert')).toEqual([
      expect.objectContaining({
        user_id: 'a',
        organization_id: ORG,
        reference_type: 'git_server',
        reference_id: SERVER_ID,
      }),
      expect.objectContaining({ user_id: 'b' }),
    ]);
    expect(
      has(db.of('organization_members')[0], 'eq', 'organization_id', ORG),
    ).toBe(true);
    expect(broadcast.broadcastNotification).toHaveBeenCalledTimes(2);
  });

  it('a second instance (row already flipped) only refreshes the text, no notification', async () => {
    const { service, db } = setup();

    db.queue('git_servers', { data: [] }, { data: null });

    await service.setStatus(
      serverRow({ status: 'needs_attention', status_reason: 'unreachable' }),
      'needs_attention',
      'tls_untrusted',
      null,
    );

    expect(db.of('notifications')).toHaveLength(0);
    expect(
      has(db.of('git_servers')[1], 'eq', 'status', 'needs_attention'),
    ).toBe(true);
  });

  it('recovery is conditional on needs_attention and never notifies', async () => {
    const { service, db } = setup();

    db.queue('git_servers', { data: [{ id: SERVER_ID }] });

    await service.setStatus(
      serverRow({ status: 'needs_attention' }),
      'active',
      null,
      null,
    );

    expect(
      has(db.of('git_servers')[0], 'eq', 'status', 'needs_attention'),
    ).toBe(true);
    expect(db.of('notifications')).toHaveLength(0);
  });
});

describe('setup values', () => {
  it('GitHub: callback, setup and per-server webhook URLs with the generated secret; audited', async () => {
    const { service, db, audit } = setup();

    db.queue('git_servers', { data: serverRow() });

    const values = await service.setup(ORG, SERVER_ID, USER);

    expect(values).toMatchObject({
      callbackUrl:
        'https://api.xisuite.test/api/v1/git-integrations/github/callback',
      setupUrl:
        'https://api.xisuite.test/api/v1/git-integrations/github/callback',
      webhookUrl: `https://api.xisuite.test/api/v1/git-integrations/github/webhook/${SERVER_ID}`,
      webhookSecret: 'whsec',
      homepageUrl: 'https://app.xisuite.test',
    });
    expect(values.registerUrls[0]).toBe(
      'https://ghe.example.com/settings/apps/new',
    );
    expect(audit.logAction).toHaveBeenCalledWith(
      ORG,
      USER,
      'git_server',
      SERVER_ID,
      'update',
      expect.objectContaining({ event: 'setup_values_viewed' }),
    );
  });

  it('GitLab: scopes api + read_user, no webhook secret', async () => {
    const { service, db } = setup();

    db.queue('git_servers', {
      data: serverRow({
        provider: 'gitlab',
        base_url: 'https://company.com/gitlab',
        host: 'company.com',
      }),
    });

    const values = await service.setup(ORG, SERVER_ID, USER);

    expect(values).toMatchObject({
      scopes: ['api', 'read_user'],
      webhookSecret: null,
      webhookUrl: null,
    });
    expect(values.registerUrls[0]).toBe(
      'https://company.com/gitlab/admin/applications/new',
    );
  });
});
