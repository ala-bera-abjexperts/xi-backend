/**
 * @fileoverview Unit tests for the provider-neutral Git integrations core: connections, status
 * changes, repository selection and sync, deliveries, the page read models, and tenant isolation
 * (every org-scoped query must filter on organization_id, since the admin client bypasses RLS).
 * The Supabase admin client is a hand-written recording mock.
 * @module src/git-integrations/git-integrations.service.spec
 */

import {
  ConflictException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import {
  GIT_ATTENTION_NOTIFICATION,
  GitIntegrationsService,
} from './git-integrations.service';
import type {
  IGitConnectionRow,
  IGitRepositoryRow,
  IProviderAccount,
} from './git-integrations.types';

const ORG = 'org-1';
const USER = 'user-1';
const CONNECTIONS = 'git_connections';
const REPOSITORIES = 'git_repositories';
const SETTINGS = 'git_integration_settings';
const TENANT_TABLES = [CONNECTIONS, REPOSITORIES, SETTINGS];

// ---------------------------------------------------------------------------
// Recording Supabase mock
// ---------------------------------------------------------------------------

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
  /** For `select(..., { count: 'exact', head: true })` chains. */
  count?: number | null;
}

const CHAIN_METHODS = [
  'select',
  'insert',
  'update',
  'upsert',
  'delete',
  'eq',
  'neq',
  'in',
  'is',
  'or',
  'order',
  'limit',
  'lt',
  'range',
];

function makeDb() {
  const chains: IChain[] = [];
  const queues = new Map<string, IResult[]>();

  const next = (table: string) => {
    const result = queues.get(table)?.shift() ?? {};

    return {
      data: result.data ?? null,
      error: result.error ?? null,
      count: result.count ?? null,
    };
  };

  const from = (table: string) => {
    const chain: IChain = { table, calls: [] };
    let resolved: { data: unknown; error: unknown; count: unknown } | undefined;
    const resolve = () => (resolved ??= next(table));
    const builder: Record<string, unknown> = {};

    chains.push(chain);

    for (const method of CHAIN_METHODS) {
      builder[method] = (...args: unknown[]) => {
        chain.calls.push({ method, args });

        return builder;
      };
    }

    for (const method of ['maybeSingle', 'single']) {
      builder[method] = (...args: unknown[]) => {
        chain.calls.push({ method, args });

        return Promise.resolve(resolve());
      };
    }

    builder.then = (
      onF: (v: unknown) => unknown,
      onR?: (e: unknown) => unknown,
    ) => {
      chain.calls.push({ method: 'then', args: [] });

      return Promise.resolve(resolve()).then(onF, onR);
    };

    return builder;
  };

  return {
    client: { from },
    chains,
    /** Queues results for `table`, consumed one per chain in the order the chains resolve. */
    queue(table: string, ...results: IResult[]) {
      queues.set(table, [...(queues.get(table) ?? []), ...results]);
    },
    on(table: string) {
      return chains.filter((chain) => chain.table === table);
    },
  };
}

type Db = ReturnType<typeof makeDb>;

function calls(chain: IChain, method: string) {
  return chain.calls.filter((call) => call.method === method);
}

function eqValue(chain: IChain, column: string): unknown {
  return calls(chain, 'eq').find((call) => call.args[0] === column)?.args[1];
}

function hasEq(chain: IChain, column: string, value: unknown) {
  return calls(chain, 'eq').some(
    (call) => call.args[0] === column && call.args[1] === value,
  );
}

function payload(
  chain: IChain,
  method: 'insert' | 'update' | 'upsert',
): unknown {
  return calls(chain, method)[0]?.args[0];
}

function hasOrgFilter(chain: IChain, organizationId: string): boolean {
  if (hasEq(chain, 'organization_id', organizationId)) return true;

  return ['insert', 'upsert'].some((method) =>
    calls(chain, method).some((call) => {
      const rows = Array.isArray(call.args[0]) ? call.args[0] : [call.args[0]];

      return (
        rows.length > 0 &&
        rows.every(
          (row) =>
            (row as Record<string, unknown>)?.organization_id ===
            organizationId,
        )
      );
    }),
  );
}

function makeService(db: Db) {
  const audit = {
    logAction: jest.fn().mockResolvedValue(undefined),
    logSystemAction: jest.fn().mockResolvedValue(undefined),
  };
  const broadcast = {
    broadcastNotification: jest.fn().mockResolvedValue(undefined),
  };
  const service = new GitIntegrationsService(
    { getClient: () => db.client } as never,
    audit as never,
    broadcast as never,
  );

  return { service, audit, broadcast };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function conn(overrides: Partial<IGitConnectionRow> = {}): IGitConnectionRow {
  return {
    id: 'conn-1',
    organization_id: ORG,
    provider: 'github',
    host: 'github.com',
    external_account_id: 'acct-1',
    installation_id: 'inst-1',
    account_login: 'acme',
    account_name: 'Acme',
    account_type: 'Organization',
    avatar_url: null,
    account_url: null,
    credential_id: null,
    repository_selection: 'selected',
    status: 'active',
    status_reason: null,
    status_changed_at: '2026-10-01T00:00:00Z',
    created_by: USER,
    disconnected_by: null,
    disconnected_at: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

function repo(overrides: Partial<IGitRepositoryRow> = {}): IGitRepositoryRow {
  return {
    id: 'repo-1',
    organization_id: ORG,
    connection_id: 'conn-1',
    provider: 'github',
    host: 'github.com',
    external_id: 'ext-1',
    full_name: 'acme/one',
    web_url: null,
    default_branch: 'main',
    is_private: false,
    is_archived: false,
    is_enabled: false,
    removed_at: null,
    webhook_id: null,
    webhook_secret_encrypted: null,
    webhook_secret_iv: null,
    webhook_secret_tag: null,
    webhook_error: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

const ACCOUNT: IProviderAccount = {
  externalAccountId: 'acct-1',
  installationId: 'inst-1',
  login: 'acme',
  name: 'Acme',
  type: 'Organization',
  avatarUrl: null,
  url: null,
};

function providerRepo(externalId: string) {
  return {
    externalId,
    fullName: `acme/${externalId}`,
    webUrl: null,
    defaultBranch: 'main',
    isPrivate: true,
    isArchived: false,
  };
}

// ---------------------------------------------------------------------------

describe('GitIntegrationsService', () => {
  let db: Db;
  let service: GitIntegrationsService;
  let audit: ReturnType<typeof makeService>['audit'];
  let broadcast: ReturnType<typeof makeService>['broadcast'];

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    db = makeDb();
    ({ service, audit, broadcast } = makeService(db));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('upsertConnection', () => {
    const input = {
      organizationId: ORG,
      provider: 'github' as const,
      host: 'github.com',
      account: ACCOUNT,
      userId: USER,
    };

    it('inserts a new connection and audits a connect', async () => {
      db.queue(CONNECTIONS, { data: null }, { data: conn({ id: 'conn-new' }) });

      const result = await service.upsertConnection({
        ...input,
        credentialId: 'cred-1',
      });

      expect(result).toEqual({
        connection: expect.objectContaining({ id: 'conn-new' }),
        created: true,
      });

      const [lookup, insert] = db.on(CONNECTIONS);

      expect(eqValue(lookup, 'organization_id')).toBe(ORG);
      expect(eqValue(lookup, 'provider')).toBe('github');
      expect(eqValue(lookup, 'host')).toBe('github.com');
      expect(eqValue(lookup, 'external_account_id')).toBe('acct-1');
      expect(payload(insert, 'insert')).toEqual(
        expect.objectContaining({
          organization_id: ORG,
          provider: 'github',
          external_account_id: 'acct-1',
          installation_id: 'inst-1',
          account_login: 'acme',
          credential_id: 'cred-1',
          created_by: USER,
        }),
      );
      expect(audit.logAction).toHaveBeenCalledWith(
        ORG,
        USER,
        'git_connection',
        'conn-new',
        'create',
        expect.objectContaining({
          event: 'connect',
          provider: 'github',
          account: 'acme',
        }),
      );
    });

    it('omits credential_id when none is given', async () => {
      db.queue(CONNECTIONS, { data: null }, { data: conn() });

      await service.upsertConnection(input);

      expect(payload(db.on(CONNECTIONS)[1], 'insert')).not.toHaveProperty(
        'credential_id',
      );
    });

    it.each(['disconnected', 'needs_attention'] as const)(
      'reactivates an existing %s row',
      async (status) => {
        db.queue(
          CONNECTIONS,
          {
            data: conn({
              status,
              status_reason:
                status === 'needs_attention' ? 'app_removed' : null,
              disconnected_by: status === 'disconnected' ? 'someone' : null,
              disconnected_at:
                status === 'disconnected' ? '2026-10-02T00:00:00Z' : null,
            }),
          },
          { data: conn({ status: 'active' }) },
        );

        const result = await service.upsertConnection(input);

        expect(result.created).toBe(false);
        expect(result.connection.status).toBe('active');

        const chains = db.on(CONNECTIONS);

        expect(chains).toHaveLength(2);
        expect(calls(chains[1], 'insert')).toHaveLength(0);
        expect(payload(chains[1], 'update')).toEqual(
          expect.objectContaining({
            status: 'active',
            status_reason: null,
            disconnected_by: null,
            disconnected_at: null,
            account_login: 'acme',
          }),
        );
        expect(eqValue(chains[1], 'id')).toBe('conn-1');
        expect(eqValue(chains[1], 'organization_id')).toBe(ORG);
        expect(audit.logAction).toHaveBeenCalledWith(
          ORG,
          USER,
          'git_connection',
          'conn-1',
          'update',
          expect.objectContaining({
            event: 'reconnect',
            previous_status: status,
          }),
        );
      },
    );

    it('loses a concurrent reactivation race with already_connected and no audit', async () => {
      db.queue(
        CONNECTIONS,
        { data: conn({ status: 'disconnected' }) },
        { data: null },
      );

      const error = await service
        .upsertConnection(input)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual(
        expect.objectContaining({ code: 'already_connected' }),
      );

      const update = db.on(CONNECTIONS)[1];

      expect(calls(update, 'neq')[0].args).toEqual(['status', 'active']);
      expect(calls(update, 'maybeSingle')).toHaveLength(1);
      expect(audit.logAction).not.toHaveBeenCalled();
    });

    it('rejects an account that is already active here with already_connected', async () => {
      db.queue(CONNECTIONS, { data: conn({ status: 'active' }) });

      const error = await service
        .upsertConnection(input)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual(
        expect.objectContaining({ code: 'already_connected' }),
      );
      expect(db.on(CONNECTIONS)).toHaveLength(1);
      expect(audit.logAction).not.toHaveBeenCalled();
    });

    it('maps a concurrent insert (23505) to already_connected', async () => {
      db.queue(
        CONNECTIONS,
        { data: null },
        { error: { message: 'dup', code: '23505' } },
      );

      const error = await service
        .upsertConnection(input)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual(
        expect.objectContaining({ code: 'already_connected' }),
      );
      expect(audit.logAction).not.toHaveBeenCalled();
    });

    it('surfaces any other insert error as a 500', async () => {
      db.queue(
        CONNECTIONS,
        { data: null },
        { error: { message: 'boom', code: 'XX000' } },
      );

      await expect(service.upsertConnection(input)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });

  describe('setStatus', () => {
    it('updates conditionally on id, organization and current status', async () => {
      db.queue(CONNECTIONS, { data: [] });

      const changed = await service.setStatus(
        conn(),
        'needs_attention',
        'app_removed',
      );

      expect(changed).toBe(false);

      const [chain] = db.on(CONNECTIONS);

      expect(payload(chain, 'update')).toEqual(
        expect.objectContaining({
          status: 'needs_attention',
          status_reason: 'app_removed',
        }),
      );
      expect(eqValue(chain, 'id')).toBe('conn-1');
      expect(eqValue(chain, 'organization_id')).toBe(ORG);
      expect(eqValue(chain, 'status')).toBe('active');
      expect(eqValue(chain, 'status_reason')).toBeUndefined();
    });

    it('audits and notifies nothing when another caller already changed it', async () => {
      db.queue(CONNECTIONS, { data: [] });

      await service.setStatus(conn(), 'needs_attention', 'app_removed');

      expect(audit.logAction).not.toHaveBeenCalled();
      expect(audit.logSystemAction).not.toHaveBeenCalled();
      expect(db.on('organization_members')).toHaveLength(0);
      expect(db.on('notifications')).toHaveLength(0);
      expect(broadcast.broadcastNotification).not.toHaveBeenCalled();
    });

    it('returns false (and audits nothing) when the update fails', async () => {
      db.queue(CONNECTIONS, { error: { message: 'boom' } });

      await expect(
        service.setStatus(conn(), 'needs_attention', 'suspended'),
      ).resolves.toBe(false);
      expect(audit.logSystemAction).not.toHaveBeenCalled();
    });

    it('notifies every owner/admin and broadcasts each notification on needs_attention', async () => {
      db.queue(CONNECTIONS, { data: [{ id: 'conn-1' }] });
      db.queue('organization_members', {
        data: [{ user_id: 'a1' }, { user_id: 'a2' }],
      });
      db.queue('notifications', { data: [{ id: 'n1' }, { id: 'n2' }] });

      await expect(
        service.setStatus(conn(), 'needs_attention', 'app_removed'),
      ).resolves.toBe(true);

      const [members] = db.on('organization_members');

      expect(eqValue(members, 'organization_id')).toBe(ORG);
      expect(calls(members, 'in')[0].args).toEqual([
        'role',
        ['owner', 'admin'],
      ]);

      const [notifications] = db.on('notifications');
      const rows = payload(notifications, 'insert') as Record<
        string,
        unknown
      >[];

      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.user_id)).toEqual(['a1', 'a2']);
      for (const row of rows) {
        expect(row).toEqual(
          expect.objectContaining({
            organization_id: ORG,
            type: GIT_ATTENTION_NOTIFICATION,
            reference_type: 'git_connection',
            reference_id: 'conn-1',
            is_read: false,
          }),
        );
      }

      expect(broadcast.broadcastNotification).toHaveBeenCalledTimes(2);
      expect(broadcast.broadcastNotification).toHaveBeenNthCalledWith(1, {
        id: 'n1',
      });
      expect(broadcast.broadcastNotification).toHaveBeenNthCalledWith(2, {
        id: 'n2',
      });

      expect(audit.logSystemAction).toHaveBeenCalledWith(
        ORG,
        'git_connection',
        'conn-1',
        'update',
        expect.objectContaining({
          event: 'status_change',
          from: 'active',
          to: 'needs_attention',
          reason: 'app_removed',
        }),
      );
      expect(audit.logAction).not.toHaveBeenCalled();
    });

    it('audits as the actor when one is given', async () => {
      db.queue(CONNECTIONS, { data: [{ id: 'conn-1' }] });
      db.queue('organization_members', { data: [] });

      await service.setStatus(
        conn(),
        'needs_attention',
        'suspended',
        'actor-1',
      );

      expect(audit.logAction).toHaveBeenCalledWith(
        ORG,
        'actor-1',
        'git_connection',
        'conn-1',
        'update',
        expect.objectContaining({ to: 'needs_attention', reason: 'suspended' }),
      );
      expect(audit.logSystemAction).not.toHaveBeenCalled();
      expect(db.on('notifications')).toHaveLength(0);
    });

    it('recovering to active with a reason only clears that reason', async () => {
      db.queue(CONNECTIONS, { data: [{ id: 'conn-1' }] });

      const connection = conn({
        status: 'needs_attention',
        status_reason: 'suspended',
      });

      await expect(
        service.setStatus(connection, 'active', 'suspended'),
      ).resolves.toBe(true);

      const [chain] = db.on(CONNECTIONS);

      expect(payload(chain, 'update')).toEqual(
        expect.objectContaining({ status: 'active', status_reason: null }),
      );
      expect(eqValue(chain, 'status')).toBe('needs_attention');
      expect(eqValue(chain, 'status_reason')).toBe('suspended');
      expect(db.on('organization_members')).toHaveLength(0);
      expect(audit.logSystemAction).toHaveBeenCalledTimes(1);
    });

    it('recovering to active without a reason does not filter on status_reason', async () => {
      db.queue(CONNECTIONS, { data: [{ id: 'conn-1' }] });

      await service.setStatus(
        conn({ status: 'needs_attention' }),
        'active',
        null,
      );

      expect(eqValue(db.on(CONNECTIONS)[0], 'status_reason')).toBeUndefined();
    });
  });

  describe('updateSelection', () => {
    it("'all' enables every non-removed disabled row and keeps removed rows disabled", async () => {
      const rows = [
        repo({ id: 'r1', full_name: 'acme/r1', is_enabled: false }),
        repo({
          id: 'r2',
          full_name: 'acme/r2',
          is_enabled: false,
          removed_at: '2026-10-02T00:00:00Z',
        }),
        repo({
          id: 'r3',
          full_name: 'acme/r3',
          is_enabled: true,
          removed_at: '2026-10-02T00:00:00Z',
        }),
        repo({ id: 'r4', full_name: 'acme/r4', is_enabled: true }),
      ];

      db.queue(
        CONNECTIONS,
        { data: conn({ repository_selection: 'selected' }) },
        {},
      );
      db.queue(REPOSITORIES, { data: rows }, {}, {});

      const result = await service.updateSelection(
        ORG,
        'conn-1',
        'all',
        [],
        USER,
      );

      expect(result.connection.repository_selection).toBe('all');
      expect(result.enabled.map((row) => row.id)).toEqual(['r1']);
      expect(result.enabled[0].is_enabled).toBe(true);
      expect(result.disabled.map((row) => row.id)).toEqual(['r3']);
      expect(result.disabled[0].is_enabled).toBe(false);

      // Rows are written before the connection's mode, so a failed row write never leaves the mode changed.
      const writes = db.chains.filter((chain) => calls(chain, 'update').length);

      expect(writes.map((chain) => chain.table)).toEqual([
        REPOSITORIES,
        REPOSITORIES,
        CONNECTIONS,
      ]);

      const selectionUpdate = db.on(CONNECTIONS)[1];

      expect(payload(selectionUpdate, 'update')).toEqual({
        repository_selection: 'all',
      });

      const [, enableChain, disableChain] = db.on(REPOSITORIES);

      expect(payload(enableChain, 'update')).toEqual({ is_enabled: true });
      expect(calls(enableChain, 'in')[0].args).toEqual(['id', ['r1']]);
      expect(payload(disableChain, 'update')).toEqual({ is_enabled: false });
      expect(calls(disableChain, 'in')[0].args).toEqual(['id', ['r3']]);
      for (const chain of [enableChain, disableChain]) {
        expect(eqValue(chain, 'connection_id')).toBe('conn-1');
      }

      expect(audit.logAction).toHaveBeenCalledWith(
        ORG,
        USER,
        'git_repository_selection',
        'conn-1',
        'update',
        expect.objectContaining({
          selection: 'all',
          previous_selection: 'selected',
          enabled: ['acme/r1'],
          disabled: ['acme/r3'],
        }),
      );
    });

    it("'selected' enables exactly the given ids, disables the rest, and ignores foreign ids", async () => {
      const rows = [
        repo({ id: 'r1', is_enabled: false }),
        repo({ id: 'r2', is_enabled: true }),
        repo({ id: 'r3', is_enabled: false }),
        repo({ id: 'r4', is_enabled: true }),
      ];

      db.queue(CONNECTIONS, {
        data: conn({ repository_selection: 'selected' }),
      });
      db.queue(REPOSITORIES, { data: rows }, {}, {});

      const result = await service.updateSelection(
        ORG,
        'conn-1',
        'selected',
        ['r1', 'r4', 'foreign-repo'],
        USER,
      );

      expect(result.enabled.map((row) => row.id)).toEqual(['r1']);
      expect(result.disabled.map((row) => row.id)).toEqual(['r2']);

      // Selection unchanged: no connection update.
      expect(db.on(CONNECTIONS)).toHaveLength(1);

      const updates = db.on(REPOSITORIES).slice(1);
      const touchedIds = updates.flatMap(
        (chain) => calls(chain, 'in')[0].args[1] as string[],
      );

      expect(touchedIds).toEqual(['r1', 'r2']);
      expect(touchedIds).not.toContain('foreign-repo');
      expect(audit.logAction).toHaveBeenCalledTimes(1);
    });

    it("'selected' keeps a removed row disabled even when its id is requested", async () => {
      const rows = [
        repo({
          id: 'r1',
          is_enabled: false,
          removed_at: '2026-10-02T00:00:00Z',
        }),
        repo({ id: 'r2', is_enabled: false }),
      ];

      db.queue(CONNECTIONS, {
        data: conn({ repository_selection: 'selected' }),
      });
      db.queue(REPOSITORIES, { data: rows }, {});

      const result = await service.updateSelection(
        ORG,
        'conn-1',
        'selected',
        ['r1', 'r2'],
        USER,
      );

      expect(result.enabled.map((row) => row.id)).toEqual(['r2']);
      expect(result.disabled).toEqual([]);

      const touchedIds = db
        .on(REPOSITORIES)
        .slice(1)
        .flatMap((chain) => calls(chain, 'in')[0].args[1] as string[]);

      expect(touchedIds).toEqual(['r2']);
    });

    it('refuses a disconnected connection', async () => {
      db.queue(CONNECTIONS, { data: conn({ status: 'disconnected' }) });

      await expect(
        service.updateSelection(ORG, 'conn-1', 'all', [], USER),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(db.on(REPOSITORIES)).toHaveLength(0);
    });

    it('refuses a connection of another organization (not found)', async () => {
      db.queue(CONNECTIONS, { data: null });

      await expect(
        service.updateSelection(ORG, 'conn-x', 'all', [], USER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('audits nothing when nothing changed', async () => {
      db.queue(CONNECTIONS, {
        data: conn({ repository_selection: 'selected' }),
      });
      db.queue(REPOSITORIES, {
        data: [
          repo({ id: 'r1', is_enabled: true }),
          repo({ id: 'r2', is_enabled: false }),
        ],
      });

      const result = await service.updateSelection(
        ORG,
        'conn-1',
        'selected',
        ['r1'],
        USER,
      );

      expect(result.enabled).toEqual([]);
      expect(result.disabled).toEqual([]);
      expect(db.on(CONNECTIONS)).toHaveLength(1);
      expect(db.on(REPOSITORIES)).toHaveLength(1);
      expect(audit.logAction).not.toHaveBeenCalled();
    });

    it('audits a selection-only change', async () => {
      db.queue(
        CONNECTIONS,
        { data: conn({ repository_selection: 'all' }) },
        {},
      );
      db.queue(REPOSITORIES, { data: [repo({ id: 'r1', is_enabled: true })] });

      await service.updateSelection(ORG, 'conn-1', 'selected', ['r1'], USER);

      expect(audit.logAction).toHaveBeenCalledTimes(1);
    });
  });

  describe('upsertRepositories', () => {
    const existing = [
      { id: 'e1', external_id: 'x1', connection_id: 'conn-other' },
      { id: 'e2', external_id: 'x2', connection_id: 'conn-1' },
      { id: 'e3', external_id: 'x3', connection_id: 'conn-1' },
      { id: 'e4', external_id: 'x4', connection_id: 'conn-other' },
    ];

    it('inserts new rows enabled under "all", updates and re-points existing ones, marks unlisted ones removed', async () => {
      db.queue(REPOSITORIES, { data: existing }, {}, {}, {}, {});

      await service.upsertRepositories(
        conn({ repository_selection: 'all' }),
        [providerRepo('x1'), providerRepo('x2'), providerRepo('x5')],
        true,
      );

      const [lookup, updateE1, updateE2, insert, removal] = db.on(REPOSITORIES);

      expect(eqValue(lookup, 'organization_id')).toBe(ORG);
      expect(eqValue(lookup, 'provider')).toBe('github');
      expect(eqValue(lookup, 'host')).toBe('github.com');

      for (const [chain, id] of [
        [updateE1, 'e1'],
        [updateE2, 'e2'],
      ] as const) {
        expect(eqValue(chain, 'id')).toBe(id);
        expect(payload(chain, 'update')).toEqual(
          expect.objectContaining({
            connection_id: 'conn-1',
            removed_at: null,
          }),
        );
        expect(payload(chain, 'update')).not.toHaveProperty('is_enabled');
      }

      expect(payload(insert, 'insert')).toEqual([
        expect.objectContaining({
          external_id: 'x5',
          organization_id: ORG,
          connection_id: 'conn-1',
          provider: 'github',
          host: 'github.com',
          is_enabled: true,
        }),
      ]);

      // Only x3: x4 belongs to another connection of this organization.
      expect(payload(removal, 'update')).toEqual({
        removed_at: expect.any(String),
      });
      expect(calls(removal, 'in')[0].args).toEqual(['external_id', ['x3']]);
      expect(eqValue(removal, 'connection_id')).toBe('conn-1');
      expect(db.on(REPOSITORIES)).toHaveLength(5);
    });

    it('inserts new rows disabled under "selected" and skips removal without fullSync', async () => {
      db.queue(REPOSITORIES, { data: existing }, {}, {});

      await service.upsertRepositories(
        conn({ repository_selection: 'selected' }),
        [providerRepo('x2'), providerRepo('x9')],
        false,
      );

      const chains = db.on(REPOSITORIES);

      expect(chains).toHaveLength(3);
      expect(payload(chains[2], 'insert')).toEqual([
        expect.objectContaining({ external_id: 'x9', is_enabled: false }),
      ]);
    });

    it('an unknown default branch (undefined) never blanks the stored one; null and a value are written', async () => {
      db.queue(REPOSITORIES, { data: existing }, {}, {});

      await service.upsertRepositories(
        conn(),
        [
          { ...providerRepo('x2'), defaultBranch: undefined },
          { ...providerRepo('x3'), defaultBranch: 'main' },
        ],
        false,
      );

      const [, updateE2, updateE3] = db.on(REPOSITORIES);

      expect(payload(updateE2, 'update')).not.toHaveProperty('default_branch');
      expect(payload(updateE3, 'update')).toEqual(
        expect.objectContaining({ default_branch: 'main' }),
      );
    });

    it('issues no insert when every repository is known', async () => {
      db.queue(REPOSITORIES, { data: existing }, {});

      await service.upsertRepositories(conn(), [providerRepo('x2')], false);

      expect(
        db.on(REPOSITORIES).some((chain) => calls(chain, 'insert').length),
      ).toBe(false);
    });
  });

  describe('paging', () => {
    it('listRepositories reads a second page when the first returns exactly 1000 rows', async () => {
      const page1 = Array.from({ length: 1000 }, (_, i) =>
        repo({ id: `p1-${i}` }),
      );
      const page2 = [repo({ id: 'p2-0' }), repo({ id: 'p2-1' })];

      db.queue(REPOSITORIES, { data: page1 }, { data: page2 });

      const rows = await service.listRepositories(ORG, 'conn-1');

      expect(rows).toHaveLength(1002);

      const chains = db.on(REPOSITORIES);

      expect(chains.map((chain) => calls(chain, 'range')[0].args)).toEqual([
        [0, 999],
        [1000, 1999],
      ]);
      for (const chain of chains) {
        expect(eqValue(chain, 'organization_id')).toBe(ORG);
        expect(calls(chain, 'order').map((call) => call.args[0])).toEqual([
          'full_name',
          'id',
        ]);
      }
    });

    it('stops after a single short page', async () => {
      db.queue(REPOSITORIES, { data: [repo()] });

      await service.listRepositories(ORG, 'conn-1');

      expect(db.on(REPOSITORIES)).toHaveLength(1);
    });

    it('upsertRepositories pages the existing-rows read too', async () => {
      const page1 = Array.from({ length: 1000 }, (_, i) => ({
        id: `e${i}`,
        external_id: `x${i}`,
        connection_id: 'conn-1',
      }));

      db.queue(REPOSITORIES, { data: page1 }, { data: [] });

      await service.upsertRepositories(conn(), [], false);

      expect(
        db.on(REPOSITORIES).map((chain) => calls(chain, 'range')[0]?.args),
      ).toEqual([
        [0, 999],
        [1000, 1999],
      ]);
    });
  });

  describe('chunking', () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);

    it('markRepositoriesRemoved sends 250 ids as .in chunks of 100/100/50', async () => {
      await service.markRepositoriesRemoved(
        conn(),
        ids,
        '2026-10-16T00:00:00Z',
      );

      const chains = db.on(REPOSITORIES);

      expect(
        chains.map(
          (chain) => (calls(chain, 'in')[0].args[1] as string[]).length,
        ),
      ).toEqual([100, 100, 50]);
      expect(
        chains.flatMap((chain) => calls(chain, 'in')[0].args[1] as string[]),
      ).toEqual(ids);
      for (const chain of chains) {
        expect(eqValue(chain, 'organization_id')).toBe(ORG);
        expect(eqValue(chain, 'connection_id')).toBe('conn-1');
      }
    });

    it('updateSelection sends 250 ids as .in chunks of 100/100/50', async () => {
      db.queue(CONNECTIONS, { data: conn({ repository_selection: 'all' }) });
      db.queue(REPOSITORIES, {
        data: ids.map((id) => repo({ id, is_enabled: false })),
      });

      await service.updateSelection(ORG, 'conn-1', 'all', [], USER);

      const updates = db.on(REPOSITORIES).slice(1);

      expect(
        updates.map(
          (chain) => (calls(chain, 'in')[0].args[1] as string[]).length,
        ),
      ).toEqual([100, 100, 50]);
      for (const chain of updates) {
        expect(payload(chain, 'update')).toEqual({ is_enabled: true });
        expect(eqValue(chain, 'organization_id')).toBe(ORG);
      }
    });

    it('upsertRepositories inserts in chunks of 500', async () => {
      db.queue(REPOSITORIES, { data: [] });

      await service.upsertRepositories(
        conn(),
        Array.from({ length: 1200 }, (_, i) => providerRepo(`n${i}`)),
        false,
      );

      const inserts = db
        .on(REPOSITORIES)
        .filter((chain) => calls(chain, 'insert').length);

      expect(
        inserts.map((chain) => (payload(chain, 'insert') as unknown[]).length),
      ).toEqual([500, 500, 200]);
    });
  });

  describe('markRepositoriesRemoved', () => {
    it('only marks rows still attached to this connection and not yet removed', async () => {
      db.queue(REPOSITORIES, {});

      await service.markRepositoriesRemoved(
        conn(),
        ['x1', 'x2'],
        '2026-10-16T00:00:00Z',
      );

      const [chain] = db.on(REPOSITORIES);

      expect(payload(chain, 'update')).toEqual({
        removed_at: '2026-10-16T00:00:00Z',
      });
      expect(eqValue(chain, 'organization_id')).toBe(ORG);
      expect(eqValue(chain, 'connection_id')).toBe('conn-1');
      expect(calls(chain, 'in')[0].args).toEqual(['external_id', ['x1', 'x2']]);
      expect(calls(chain, 'is')[0].args).toEqual(['removed_at', null]);
    });

    it('is a no-op for an empty list', async () => {
      await service.markRepositoriesRemoved(conn(), []);

      expect(db.chains).toHaveLength(0);
    });
  });

  describe('recordDelivery', () => {
    it('returns true when the delivery is new', async () => {
      db.queue('git_webhook_deliveries', {});

      await expect(
        service.recordDelivery('github', 'd-1', 'push'),
      ).resolves.toBe(true);
      expect(payload(db.on('git_webhook_deliveries')[0], 'insert')).toEqual({
        provider: 'github',
        delivery_id: 'd-1',
        event: 'push',
      });
    });

    it('returns false for a redelivery (23505) that is in flight or finished', async () => {
      db.queue(
        'git_webhook_deliveries',
        { error: { message: 'dup', code: '23505' } },
        { data: [] },
      );

      await expect(
        service.recordDelivery('github', 'd-1', 'push'),
      ).resolves.toBe(false);
    });

    it('takes over a duplicate whose first attempt never recorded an outcome (older than 5 minutes)', async () => {
      db.queue(
        'git_webhook_deliveries',
        { error: { message: 'dup', code: '23505' } },
        { data: [{ delivery_id: 'd-1' }] },
      );

      await expect(
        service.recordDelivery('github', 'd-1', 'push'),
      ).resolves.toBe(true);

      const [, reclaim] = db.on('git_webhook_deliveries');

      expect(calls(reclaim, 'is')[0].args).toEqual(['outcome', null]);
      expect(calls(reclaim, 'lt')[0].args[0]).toBe('received_at');
      expect(eqValue(reclaim, 'delivery_id')).toBe('d-1');
    });

    it('a failing takeover check counts as a duplicate (never processes twice by accident)', async () => {
      db.queue(
        'git_webhook_deliveries',
        { error: { message: 'dup', code: '23505' } },
        { error: { message: 'boom' } },
      );

      await expect(
        service.recordDelivery('github', 'd-1', 'push'),
      ).resolves.toBe(false);
    });

    it('returns true (and logs) on any other error so the event is not dropped', async () => {
      db.queue('git_webhook_deliveries', {
        error: { message: 'boom', code: 'XX000' },
      });

      await expect(
        service.recordDelivery('gitlab', 'd-1', 'push'),
      ).resolves.toBe(true);
      expect(Logger.prototype.warn).toHaveBeenCalled();
    });
  });

  describe('everConnected (ticket 5)', () => {
    it('counts every connection of the organization, disconnected included', async () => {
      db.queue('git_connections', { count: 1 });

      await expect(service.everConnected('org-1')).resolves.toBe(true);

      const [chain] = db.on('git_connections');

      expect(eqValue(chain, 'organization_id')).toBe('org-1');
      expect(calls(chain, 'neq')).toHaveLength(0);
    });

    it('false when there was never one', async () => {
      db.queue('git_connections', { count: 0 });

      await expect(service.everConnected('org-1')).resolves.toBe(false);
    });
  });

  describe('forgetDelivery', () => {
    it('deletes the delivery row filtered by provider and delivery_id', async () => {
      db.queue('git_webhook_deliveries', {});

      await service.forgetDelivery('gitlab', 'd-42');

      const [chain] = db.on('git_webhook_deliveries');

      expect(calls(chain, 'delete')).toHaveLength(1);
      expect(eqValue(chain, 'provider')).toBe('gitlab');
      expect(eqValue(chain, 'delivery_id')).toBe('d-42');
    });

    it('only logs when the delete fails', async () => {
      db.queue('git_webhook_deliveries', { error: { message: 'boom' } });

      await expect(
        service.forgetDelivery('github', 'd-1'),
      ).resolves.toBeUndefined();
      expect(Logger.prototype.warn).toHaveBeenCalled();
    });
  });

  describe('getOverview', () => {
    it('reports not_connected / connected / needs_attention per provider', async () => {
      db.queue(CONNECTIONS, {
        data: [
          conn({ id: 'g1', provider: 'github', status: 'active' }),
          conn({ id: 'l1', provider: 'gitlab', status: 'active' }),
          conn({ id: 'l2', provider: 'gitlab', status: 'needs_attention' }),
        ],
      });

      const overview = await service.getOverview(ORG, {
        github: true,
        gitlab: false,
        azure_devops: true,
      });

      expect(overview).toEqual([
        {
          provider: 'github',
          configured: true,
          status: 'connected',
          connectionCount: 1,
        },
        {
          provider: 'gitlab',
          configured: false,
          status: 'needs_attention',
          connectionCount: 2,
        },
        {
          provider: 'azure_devops',
          configured: true,
          status: 'not_connected',
          connectionCount: 0,
        },
      ]);
    });

    it('reports not_connected when there are no live connections', async () => {
      db.queue(CONNECTIONS, { data: [] });

      const overview = await service.getOverview(ORG, {
        github: true,
        gitlab: true,
        azure_devops: true,
      });

      expect(overview.map((row) => row.status)).toEqual([
        'not_connected',
        'not_connected',
        'not_connected',
      ]);
      expect(eqValue(db.on(CONNECTIONS)[0], 'organization_id')).toBe(ORG);
      expect(calls(db.on(CONNECTIONS)[0], 'neq')[0].args).toEqual([
        'status',
        'disconnected',
      ]);
    });
  });

  describe('getDetail', () => {
    const users = [
      { id: 'u1', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@x.io' },
      { id: 'u2', first_name: null, last_name: null, email: 'bob@x.io' },
      { id: 'u3', first_name: 'Cy', last_name: null, email: null },
    ];

    function queueDetail(legacy: IResult) {
      db.queue(CONNECTIONS, {
        data: [
          conn({
            id: 'c1',
            created_by: 'u1',
            created_at: '2026-10-01T00:00:00Z',
          }),
          conn({
            id: 'c2',
            created_by: 'u2',
            created_at: '2026-10-05T00:00:00Z',
          }),
        ],
      });
      db.queue(SETTINGS, { data: null });
      db.queue('workflow_github_connections', legacy);
      // One head count per connection, resolved in connection order.
      db.queue(REPOSITORIES, { count: 2 }, { count: 1 });
      db.queue('users', { data: users });
    }

    it('builds the github detail with enabledBy, counts and legacy connections', async () => {
      queueDetail({
        data: [
          {
            id: 'l1',
            space_id: 's1',
            display_name: 'PAT',
            external_account_id: 'octocat',
            created_by: 'u3',
            created_at: '2026-09-01T00:00:00Z',
            spaces: { name: 'Space One' },
          },
        ],
      });

      const detail = await service.getDetail(
        ORG,
        'github',
        true,
        (c) => `https://manage/${c.id}`,
      );

      expect(detail.enabledBy).toEqual({ id: 'u1', name: 'Ada Lovelace' });
      expect(detail.enabledAt).toBe('2026-10-01T00:00:00Z');
      expect(detail.settings).toEqual({
        linkCommits: false,
        showBuildStatus: true,
      });
      expect(
        detail.connections.map((c) => [
          c.id,
          c.repositoryCount,
          c.createdBy,
          c.manageUrl,
        ]),
      ).toEqual([
        ['c1', 2, { id: 'u1', name: 'Ada Lovelace' }, 'https://manage/c1'],
        ['c2', 1, { id: 'u2', name: 'bob@x.io' }, 'https://manage/c2'],
      ]);
      expect(detail.legacyConnections).toEqual([
        {
          id: 'l1',
          scope: 'space',
          spaceId: 's1',
          spaceName: 'Space One',
          githubLogin: 'octocat',
          createdBy: { id: 'u3', name: 'Cy' },
          createdAt: '2026-09-01T00:00:00Z',
        },
      ]);

      const countChains = db.on(REPOSITORIES);

      expect(
        countChains.map((chain) => eqValue(chain, 'connection_id')),
      ).toEqual(['c1', 'c2']);
      for (const count of countChains) {
        expect(calls(count, 'select')[0].args).toEqual([
          'id',
          { count: 'exact', head: true },
        ]);
        expect(eqValue(count, 'organization_id')).toBe(ORG);
        expect(eqValue(count, 'is_enabled')).toBe(true);
        expect(calls(count, 'is')[0].args).toEqual(['removed_at', null]);
      }
      expect(
        eqValue(db.on('workflow_github_connections')[0], 'organization_id'),
      ).toBe(ORG);
    });

    it('yields an empty legacy list instead of failing when that query errors', async () => {
      queueDetail({ error: { message: 'relation does not exist' } });

      const detail = await service.getDetail(ORG, 'github', true, () => null);

      expect(detail.legacyConnections).toEqual([]);
      expect(detail.connections).toHaveLength(2);
    });

    it('does not query or return legacy connections for gitlab', async () => {
      db.queue(CONNECTIONS, { data: [] });
      db.queue(SETTINGS, {
        data: {
          link_commits: false,
          show_build_status: true,
        },
      });

      const detail = await service.getDetail(ORG, 'gitlab', false, () => null);

      expect(detail).not.toHaveProperty('legacyConnections');
      expect(detail.enabledBy).toBeNull();
      expect(detail.enabledAt).toBeNull();
      expect(detail.settings).toEqual({
        linkCommits: false,
        showBuildStatus: true,
      });
      expect(db.on('workflow_github_connections')).toHaveLength(0);
      expect(db.on(REPOSITORIES)).toHaveLength(0);
      expect(eqValue(db.on(CONNECTIONS)[0], 'provider')).toBe('gitlab');
    });
  });

  describe('tenant isolation', () => {
    const scenarios: [
      string,
      (s: GitIntegrationsService, d: Db) => Promise<unknown>,
    ][] = [
      [
        'listConnections',
        (s, d) => (
          d.queue(CONNECTIONS, { data: [] }),
          s.listConnections(ORG, 'github')
        ),
      ],
      [
        'getConnection',
        (s, d) => (
          d.queue(CONNECTIONS, { data: conn() }),
          s.getConnection(ORG, 'conn-1')
        ),
      ],
      [
        'upsertConnection (insert)',
        (s, d) => (
          d.queue(CONNECTIONS, { data: null }, { data: conn() }),
          s.upsertConnection({
            organizationId: ORG,
            provider: 'github',
            host: 'github.com',
            account: ACCOUNT,
            userId: USER,
          })
        ),
      ],
      [
        'upsertConnection (reactivate)',
        (s, d) => (
          d.queue(
            CONNECTIONS,
            { data: conn({ status: 'disconnected' }) },
            { data: conn() },
          ),
          s.upsertConnection({
            organizationId: ORG,
            provider: 'github',
            host: 'github.com',
            account: ACCOUNT,
            userId: USER,
          })
        ),
      ],
      [
        'setStatus',
        (s, d) => (
          d.queue(CONNECTIONS, { data: [{ id: 'conn-1' }] }),
          d.queue('organization_members', { data: [{ user_id: 'a1' }] }),
          d.queue('notifications', { data: [{ id: 'n1' }] }),
          s.setStatus(conn(), 'needs_attention', 'app_removed')
        ),
      ],
      [
        'disconnect',
        (s, d) => (
          d.queue(CONNECTIONS, { data: conn() }, {}),
          s.disconnect(ORG, 'conn-1', USER)
        ),
      ],
      [
        'listRepositories',
        (s, d) => (
          d.queue(REPOSITORIES, { data: [] }),
          s.listRepositories(ORG, 'conn-1')
        ),
      ],
      [
        'updateSelection',
        (s, d) => (
          d.queue(
            CONNECTIONS,
            { data: conn({ repository_selection: 'selected' }) },
            {},
          ),
          d.queue(
            REPOSITORIES,
            {
              data: [
                repo({ id: 'r1', is_enabled: false }),
                repo({ id: 'r2', is_enabled: true, removed_at: 'x' }),
              ],
            },
            {},
            {},
          ),
          s.updateSelection(ORG, 'conn-1', 'all', [], USER)
        ),
      ],
      [
        'upsertRepositories',
        (s, d) => (
          d.queue(
            REPOSITORIES,
            {
              data: [
                { id: 'e1', external_id: 'x1', connection_id: 'conn-1' },
                { id: 'e2', external_id: 'x2', connection_id: 'conn-1' },
              ],
            },
            {},
            {},
            {},
          ),
          s.upsertRepositories(
            conn(),
            [providerRepo('x1'), providerRepo('x3')],
            true,
          )
        ),
      ],
      [
        'markRepositoriesRemoved',
        (s) => s.markRepositoriesRemoved(conn(), ['x1']),
      ],
      [
        'patchRepository',
        (s) => s.patchRepository(conn(), 'x1', { full_name: 'acme/renamed' }),
      ],
      [
        'updateRepositoryWebhook',
        (s) => s.updateRepositoryWebhook(repo(), { webhook_error: 'nope' }),
      ],
      ['getSettings', (s) => s.getSettings(ORG, 'github')],
      [
        'updateSettings',
        (s) =>
          s.updateSettings(
            ORG,
            'github',
            {
              linkCommits: false,
              showBuildStatus: false,
            },
            USER,
          ),
      ],
    ];

    it.each(scenarios)(
      '%s scopes every tenant-table query to the organization',
      async (_name, run) => {
        await run(service, db);

        const tenantChains = db.chains.filter((chain) =>
          TENANT_TABLES.includes(chain.table),
        );

        expect(tenantChains.length).toBeGreaterThan(0);
        for (const chain of tenantChains) {
          expect({
            table: chain.table,
            calls: chain.calls,
            scoped: hasOrgFilter(chain, ORG),
          }).toEqual(expect.objectContaining({ scoped: true }));
        }
      },
    );

    it('updateSettings upserts on (organization_id, provider)', async () => {
      await service.updateSettings(
        ORG,
        'gitlab',
        { linkCommits: true, showBuildStatus: false },
        USER,
      );

      const upsert = db
        .on(SETTINGS)
        .find((chain) => calls(chain, 'upsert').length)!;

      expect(calls(upsert, 'upsert')[0].args).toEqual([
        expect.objectContaining({
          organization_id: ORG,
          provider: 'gitlab',
          link_commits: true,
          show_build_status: false,
        }),
        { onConflict: 'organization_id,provider' },
      ]);
      expect(audit.logAction).toHaveBeenCalledWith(
        ORG,
        USER,
        'git_integration_settings',
        ORG,
        'update',
        expect.objectContaining({ provider: 'gitlab' }),
      );
    });
  });
  describe('branch settings (ticket 3)', () => {
    const BRANCH = 'git_branch_settings';

    it('getBranchSettings returns defaults when no row exists', async () => {
      db.queue(BRANCH, { data: null });

      await expect(service.getBranchSettings(ORG)).resolves.toEqual({
        prefix: '',
        keyCase: 'upper',
      });
      expect(eqValue(db.on(BRANCH)[0], 'organization_id')).toBe(ORG);
    });

    it('getBranchSettings maps the stored row', async () => {
      db.queue(BRANCH, { data: { prefix: 'feature/', key_case: 'lower' } });

      await expect(service.getBranchSettings(ORG)).resolves.toEqual({
        prefix: 'feature/',
        keyCase: 'lower',
      });
      expect(hasOrgFilter(db.on(BRANCH)[0], ORG)).toBe(true);
    });

    it('getBranchSettings throws on a DB error', async () => {
      db.queue(BRANCH, { error: { message: 'boom' } });

      await expect(service.getBranchSettings(ORG)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });

    it('updateBranchSettings upserts on organization_id and audits before/after', async () => {
      db.queue(BRANCH, { data: { prefix: 'old/', key_case: 'upper' } }, {});

      const after = { prefix: '{username}/', keyCase: 'lower' as const };

      await expect(
        service.updateBranchSettings(ORG, after, USER),
      ).resolves.toEqual(after);

      const upsert = db
        .on(BRANCH)
        .find((chain) => calls(chain, 'upsert').length)!;

      expect(calls(upsert, 'upsert')[0].args).toEqual([
        {
          organization_id: ORG,
          prefix: '{username}/',
          key_case: 'lower',
          updated_by: USER,
        },
        { onConflict: 'organization_id' },
      ]);
      expect(audit.logAction).toHaveBeenCalledWith(
        ORG,
        USER,
        'git_branch_settings',
        ORG,
        'update',
        {
          before: { prefix: 'old/', keyCase: 'upper' },
          after,
        },
      );
    });

    it('updateBranchSettings throws and does not audit on a DB error', async () => {
      db.queue(
        BRANCH,
        { data: null },
        { error: { message: 'check violation' } },
      );

      await expect(
        service.updateBranchSettings(
          ORG,
          { prefix: 'x/', keyCase: 'upper' },
          USER,
        ),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(audit.logAction).not.toHaveBeenCalled();
    });
  });

  describe('connectedProviders', () => {
    it('returns distinct providers of live connections, scoped to the org', async () => {
      db.queue(CONNECTIONS, {
        data: [
          conn({ id: 'a', provider: 'github' }),
          conn({ id: 'b', provider: 'github' }),
          conn({ id: 'c', provider: 'gitlab' }),
        ],
      });

      await expect(service.connectedProviders(ORG)).resolves.toEqual([
        'github',
        'gitlab',
      ]);

      const [list] = db.on(CONNECTIONS);

      expect(eqValue(list, 'organization_id')).toBe(ORG);
      expect(calls(list, 'neq')).toEqual([
        { method: 'neq', args: ['status', 'disconnected'] },
      ]);
    });

    it('returns [] when there are no live connections', async () => {
      db.queue(CONNECTIONS, { data: [] });

      await expect(service.connectedProviders(ORG)).resolves.toEqual([]);
    });
  });
});
