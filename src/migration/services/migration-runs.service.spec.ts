/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- mock-heavy Supabase chain doubles are intentionally typed loosely in this spec */
import { MigrationRunsService } from './migration-runs.service';
import type { MigrationRunRow } from '../engine/stages/stage.interface';

const ORG = 'org-1';
const USER = 'user-1';
const SOURCE_RUN = 'source-run-1';

function run(overrides: Partial<MigrationRunRow> = {}): MigrationRunRow {
  return {
    id: SOURCE_RUN,
    organization_id: ORG,
    job_id: 'job-1',
    connection_id: 'connection-1',
    mode: 'live',
    status: 'partially_completed',
    current_stage: null,
    stage_index: 0,
    config_snapshot: {},
    totals: {},
    correlation_id: null,
    started_at: '2026-08-27T00:00:00.000Z',
    finished_at: '2026-08-27T01:00:00.000Z',
    duration_ms: 3_600_000,
    error_message: null,
    created_by: USER,
    created_at: '2026-08-27T00:00:00.000Z',
    ...overrides,
  };
}

describe('MigrationRunsService.repair', () => {
  it('rejects a Jira profile-only repair before creating a run', async () => {
    const chain: any = { select: () => chain, eq: () => chain, in: () => chain, limit: async () => ({ data: [], error: null }) };
    const service = new MigrationRunsService({ getClient: () => ({ from: () => chain }) } as never, {} as never, {} as never, { get: async () => ({ id: 'job', source_kind: 'jira_project' }) } as never);
    jest.spyOn(service, 'get').mockResolvedValue(run());
    jest.spyOn(service as any, 'prepareCloudAdmission').mockResolvedValue({});
    await expect(service.repair(ORG, USER, SOURCE_RUN, 'profile_macros')).rejects.toThrow('requires a Confluence space');
  });
  it('starts a full Jira repair and records unavailable stages', async () => {
    const child = run({
      id: 'repair-run-1',
      status: 'running',
      current_stage: 'users',
      finished_at: null,
    });
    let inserted: Record<string, unknown> | null = null;
    const chain = {
      select: jest.fn(),
      eq: jest.fn(),
      in: jest.fn(),
      limit: jest.fn(),
      insert: jest.fn(),
    };
    chain.select.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    chain.in.mockReturnValue(chain);
    chain.limit.mockResolvedValue({ data: [], error: null });
    chain.maybeSingle = jest.fn().mockResolvedValue({
      data: {
        ...cloudConnection(),
        deployment: 'server',
        base_url: 'https://jira.example.com',
      },
      error: null,
    });
    chain.insert.mockImplementation((row: Record<string, unknown>) => {
      inserted = row;

      return {
        select: () => ({ single: async () => ({ data: child, error: null }) }),
      };
    });
    const db = {
      from: jest.fn(() => chain),
    };
    const queue = {
      seedCollectionItem: jest.fn().mockResolvedValue(undefined),
      log: jest.fn().mockResolvedValue(undefined),
    };
    const registry = {
      repairPlanFor: jest
        .fn()
        .mockReturnValue(['users', 'priorities', 'issues']),
      missingFor: jest.fn().mockReturnValue(['history']),
    };
    const jobs = {
      get: jest.fn().mockResolvedValue({
        id: 'job-1',
        connection_id: 'connection-1',
        source_kind: 'jira_project',
        source_ref: 'INF',
        scope: { include_comments: true },
        options: { mode: 'live' },
      }),
    };
    const service = new MigrationRunsService(
      { getClient: () => db } as never,
      queue as never,
      registry as never,
      jobs as never,
    );
    jest.spyOn(service, 'get').mockResolvedValue(run());

    await expect(service.repair(ORG, USER, SOURCE_RUN)).resolves.toEqual(child);

    expect(inserted).toEqual(
      expect.objectContaining({
        mode: 'live',
        config_snapshot: expect.objectContaining({
          stage_plan: ['users', 'priorities', 'issues'],
          unimplemented_stages: ['history'],
          repair_of_run_id: SOURCE_RUN,
        }),
      }),
    );
    expect(queue.seedCollectionItem).toHaveBeenCalledWith(child, 'users', 0);
    expect(queue.log).toHaveBeenCalledWith(
      ORG,
      child.id,
      null,
      'warn',
      'users',
      null,
      null,
      expect.stringContaining('history'),
    );
  });  it.each([undefined, 'original-import'])('starts profile-only repair without provisioning and keeps original inventory %s', async ancestor => {
    const child = run({
      id: 'repair-run-1',
      status: 'running',
      current_stage: 'users',
      finished_at: null,
    });
    let inserted: Record<string, unknown> | null = null;
    const chain = {
      select: jest.fn(),
      eq: jest.fn(),
      in: jest.fn(),
      limit: jest.fn(),
      insert: jest.fn(),
    };
    chain.select.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    chain.in.mockReturnValue(chain);
    chain.limit.mockResolvedValue({ data: [], error: null });
    chain.maybeSingle = jest.fn().mockResolvedValue({
      data: {
        ...cloudConnection(),
        deployment: 'server',
        base_url: 'https://jira.example.com',
      },
      error: null,
    });
    chain.insert.mockImplementation((row: Record<string, unknown>) => {
      inserted = row;

      return {
        select: () => ({ single: async () => ({ data: child, error: null }) }),
      };
    });
    const db = {
      from: jest.fn(() => chain),
    };
    const queue = {
      seedCollectionItem: jest.fn().mockResolvedValue(undefined),
      log: jest.fn().mockResolvedValue(undefined),
    };
    const registry = {
      repairPlanFor: jest
        .fn()
        .mockReturnValue(['users', 'priorities', 'issues']),
      missingFor: jest.fn().mockReturnValue(['history']),
    };
    const jobs = {
      get: jest.fn().mockResolvedValue({
        id: 'job-1',
        connection_id: 'connection-1',
        source_kind: 'confluence_space',
        source_ref: 'INF',
        scope: { include_comments: true },
        options: { mode: 'live' },
      }),
    };
    const service = new MigrationRunsService(
      { getClient: () => db } as never,
      queue as never,
      registry as never,
      jobs as never,
    );
    jest.spyOn(service, 'get').mockResolvedValue(run({ config_snapshot: ancestor ? { repair_of_run_id: ancestor } : {} }));

    await expect(service.repair(ORG, USER, SOURCE_RUN, 'profile_macros')).resolves.toEqual(child);

    expect(inserted).toEqual(
      expect.objectContaining({
        mode: 'live',
        config_snapshot: expect.objectContaining({
          stage_plan: ['confluence_page_repair', 'verify'],
          repair_scope: 'profile_macros',
          unimplemented_stages: ['history'],
          repair_of_run_id: ancestor ?? SOURCE_RUN,
        }),
      }),
    );
    expect(queue.seedCollectionItem).toHaveBeenCalledWith(child, 'confluence_page_repair', 0);
    expect(queue.log).toHaveBeenCalledWith(
      ORG,
      child.id,
      null,
      'warn',
      'confluence_page_repair',
      null,
      null,
      expect.stringContaining('history'),
    );
  });
});

function fluentChain(): any {
  const chain: any = {};

  for (const method of ['select', 'eq', 'in', 'filter', 'order', 'update']) {
    chain[method] = jest.fn(() => chain);
  }

  return chain;
}

function cloudConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'connection-1',
    organization_id: ORG,
    product: 'jira',
    deployment: 'cloud',
    base_url: 'https://example.atlassian.net',
    auth_type: 'basic',
    auth_username: 'migration@example.com',
    encrypted_secret: 'ciphertext-must-not-leak',
    encryption_iv: 'iv-must-not-leak',
    encryption_tag: 'tag-must-not-leak',
    metadata: {},
    ...overrides,
  };
}

function cloudJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    connection_id: 'connection-1',
    source_kind: 'jira_project',
    source_ref: 'ADT',
    target_space_id: null,
    scope: { include_comments: true, jql: 'labels = migrate' },
    options: { mode: 'dry_run', batch_size: 50 },
    ...overrides,
  };
}

function startHarness(options: {
  mode: 'dry_run' | 'live';
  dryRun?: MigrationRunRow | null;
  connection?: Record<string, unknown>;
  job?: Record<string, unknown>;
  badItemCount?: number;
}) {
  const connectionRow = options.connection ?? cloudConnection();
  const jobRow = options.job ?? cloudJob();
  const cloudAdmission =
    jobRow.source_kind === 'jira_project' &&
    (connectionRow.deployment === 'cloud' ||
      String(connectionRow.base_url).endsWith('.atlassian.net'));
  const active = fluentChain();
  active.limit = jest.fn().mockResolvedValue({ data: [], error: null });

  const connection = fluentChain();
  connection.maybeSingle = jest.fn().mockResolvedValue({
    data: connectionRow,
    error: null,
  });

  const candidate = fluentChain();
  candidate.limit = jest.fn(() => candidate);
  candidate.maybeSingle = jest.fn().mockResolvedValue({
    data: options.dryRun ?? null,
    error: null,
  });

  const badItems = fluentChain();
  badItems.select = jest.fn().mockReturnValue(badItems);
  badItems.in = jest
    .fn()
    .mockResolvedValue({ count: options.badItemCount ?? 0, error: null });

  const collectionItems = fluentChain();
  collectionItems.eq = jest.fn(() => collectionItems);
  collectionItems.select = jest.fn().mockReturnValue(collectionItems);
  collectionItems.in = jest.fn().mockResolvedValue({
    data: [
      { stage: 'issues', status: 'succeeded' },
      { stage: 'verify', status: 'succeeded' },
    ],
    error: null,
  });

  let inserted: Record<string, unknown> | null = null;
  const started = run({
    id: 'started-run',
    mode: options.mode,
    status: 'running',
    current_stage: 'issues',
    finished_at: null,
  });
  const insert = fluentChain();
  insert.insert = jest.fn((row: Record<string, unknown>) => {
    inserted = row;

    return {
      select: () => ({
        single: async () => ({ data: started, error: null }),
      }),
    };
  });

  let runReads = 0;
  let itemReads = 0;
  const db = {
    from: jest.fn((table: string) => {
      if (table === 'migration_connections') return connection;
      if (table === 'migration_run_items') {
        itemReads += 1;

        return itemReads === 1 ? badItems : collectionItems;
      }
      if (table === 'migration_runs') {
        runReads += 1;

        if (runReads === 1) return active;
        if (options.mode === 'live' && cloudAdmission && runReads === 2)
          return candidate;

        return insert;
      }

      throw new Error(`unexpected table ${table}`);
    }),
  };
  const queue = {
    seedCollectionItem: jest.fn().mockResolvedValue(undefined),
    log: jest.fn().mockResolvedValue(undefined),
  };
  const registry = {
    planFor: jest.fn().mockReturnValue(['issues', 'verify']),
    missingFor: jest.fn().mockReturnValue([]),
  };
  const jobs = { get: jest.fn().mockResolvedValue(jobRow) };
  const service = new MigrationRunsService(
    { getClient: () => db } as never,
    queue as never,
    registry as never,
    jobs as never,
  );

  return { service, queue, candidate, getInserted: () => inserted };
}

describe('MigrationRunsService Jira Cloud admission', () => {
  it('allows a Cloud dry run and stores only a non-secret readiness fingerprint', async () => {
    const harness = startHarness({ mode: 'dry_run' });

    await expect(
      harness.service.start(ORG, USER, 'job-1', 'dry_run'),
    ).resolves.toEqual(expect.objectContaining({ id: 'started-run' }));

    const snapshot = harness.getInserted()?.config_snapshot as Record<
      string,
      unknown
    >;

    expect(snapshot).toEqual(
      expect.objectContaining({
        cloud_adapter_contract: expect.any(String),
        cloud_readiness_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(JSON.stringify(snapshot)).not.toContain('must-not-leak');
  });

  it('treats an atlassian.net Jira connection as Cloud even before deployment is stamped', async () => {
    const harness = startHarness({
      mode: 'dry_run',
      connection: cloudConnection({ deployment: null }),
    });

    await harness.service.start(ORG, USER, 'job-1', 'dry_run');

    expect(harness.getInserted()?.config_snapshot).toEqual(
      expect.objectContaining({
        cloud_readiness_fingerprint: expect.any(String),
      }),
    );
  });

  it('keeps the fingerprint stable when a Cloud hostname is later stamped as Cloud', async () => {
    const unstamped = startHarness({
      mode: 'dry_run',
      connection: cloudConnection({ deployment: null }),
    });
    const stamped = startHarness({ mode: 'dry_run' });

    await unstamped.service.start(ORG, USER, 'job-1', 'dry_run');
    await stamped.service.start(ORG, USER, 'job-1', 'dry_run');

    const left = unstamped.getInserted()?.config_snapshot as Record<
      string,
      unknown
    >;
    const right = stamped.getInserted()?.config_snapshot as Record<
      string,
      unknown
    >;

    expect(left.cloud_readiness_fingerprint).toBe(
      right.cloud_readiness_fingerprint,
    );
  });

  it('invalidates the fingerprint when the encrypted credential changes', async () => {
    const before = startHarness({ mode: 'dry_run' });
    const after = startHarness({
      mode: 'dry_run',
      connection: cloudConnection({ encrypted_secret: 'rotated-ciphertext' }),
    });

    await before.service.start(ORG, USER, 'job-1', 'dry_run');
    await after.service.start(ORG, USER, 'job-1', 'dry_run');

    const left = before.getInserted()?.config_snapshot as Record<
      string,
      unknown
    >;
    const right = after.getInserted()?.config_snapshot as Record<
      string,
      unknown
    >;

    expect(left.cloud_readiness_fingerprint).not.toBe(
      right.cloud_readiness_fingerprint,
    );
  });

  it('invalidates the fingerprint when the frozen migration configuration changes', async () => {
    const before = startHarness({ mode: 'dry_run' });
    const after = startHarness({
      mode: 'dry_run',
      job: cloudJob({ scope: { include_comments: false } }),
    });

    await before.service.start(ORG, USER, 'job-1', 'dry_run');
    await after.service.start(ORG, USER, 'job-1', 'dry_run');

    const left = before.getInserted()?.config_snapshot as Record<
      string,
      unknown
    >;
    const right = after.getInserted()?.config_snapshot as Record<
      string,
      unknown
    >;

    expect(left.cloud_readiness_fingerprint).not.toBe(
      right.cloud_readiness_fingerprint,
    );
  });

  it('blocks Cloud live runs when no matching successful dry run exists', async () => {
    const harness = startHarness({ mode: 'live' });

    await expect(
      harness.service.start(ORG, USER, 'job-1', 'live'),
    ).rejects.toThrow(/matching.*dry run/i);
    expect(harness.getInserted()).toBeNull();
  });

  it('allows Cloud live only after a complete and exactly reconciled matching dry run', async () => {
    const dryRun = run({
      id: 'verified-dry-run',
      mode: 'dry_run',
      status: 'succeeded',
      current_stage: 'verify',
      stage_index: 1,
      config_snapshot: {
        stage_plan: ['issues', 'verify'],
        unimplemented_stages: [],
      },
      totals: {
        verification: {
          reconciliations: [
            {
              entityType: 'issue',
              sourceCount: 2,
              targetCount: 2,
              shortfall: 0,
            },
          ],
        },
      },
    });
    const harness = startHarness({ mode: 'live', dryRun });

    await expect(
      harness.service.start(ORG, USER, 'job-1', 'live'),
    ).resolves.toEqual(expect.objectContaining({ id: 'started-run' }));
    expect(harness.getInserted()?.config_snapshot).toEqual(
      expect.objectContaining({
        cloud_verified_dry_run_id: 'verified-dry-run',
      }),
    );
    expect(harness.candidate.eq).toHaveBeenCalledWith('organization_id', ORG);
  });

  it('rejects a matching dry run with a reconciliation shortfall', async () => {
    const dryRun = run({
      id: 'short-dry-run',
      mode: 'dry_run',
      status: 'succeeded',
      config_snapshot: {
        stage_plan: ['issues', 'verify'],
        unimplemented_stages: [],
      },
      totals: {
        verification: {
          reconciliations: [
            {
              entityType: 'issue',
              sourceCount: 2,
              targetCount: 1,
              shortfall: 1,
            },
          ],
        },
      },
    });
    const harness = startHarness({ mode: 'live', dryRun });

    await expect(
      harness.service.start(ORG, USER, 'job-1', 'live'),
    ).rejects.toThrow(/exact zero-shortfall/i);
  });

  it('rejects a matching dry run containing failed, dead, or blocked items', async () => {
    const dryRun = run({
      id: 'failed-item-dry-run',
      mode: 'dry_run',
      status: 'succeeded',
      config_snapshot: {
        stage_plan: ['issues', 'verify'],
        unimplemented_stages: [],
      },
      totals: {
        verification: {
          reconciliations: [
            {
              entityType: 'issue',
              sourceCount: 2,
              targetCount: 2,
              shortfall: 0,
            },
          ],
        },
      },
    });
    const harness = startHarness({
      mode: 'live',
      dryRun,
      badItemCount: 1,
    });

    await expect(
      harness.service.start(ORG, USER, 'job-1', 'live'),
    ).rejects.toThrow(/matching.*dry run/i);
  });

  it('leaves Jira Server and Confluence live admission unchanged', async () => {
    const server = startHarness({
      mode: 'live',
      connection: cloudConnection({
        deployment: 'server',
        base_url: 'https://jira.example.com',
      }),
    });
    const confluence = startHarness({
      mode: 'live',
      connection: cloudConnection({
        product: 'confluence',
        deployment: 'cloud',
      }),
      job: cloudJob({ source_kind: 'confluence_space' }),
    });

    await expect(
      server.service.start(ORG, USER, 'job-1', 'live'),
    ).resolves.toEqual(expect.objectContaining({ id: 'started-run' }));
    await expect(
      confluence.service.start(ORG, USER, 'job-1', 'live'),
    ).resolves.toEqual(expect.objectContaining({ id: 'started-run' }));
  });
});

describe('MigrationRunsService.retryFailed', () => {
  it('reopens only this run terminal items with the extended retry budget', async () => {
    const chain: any = {
      update: jest.fn(() => chain),
      eq: jest.fn(() => chain),
      in: jest.fn(() => chain),
      neq: jest.fn(() => chain),
      then: (resolve: any) =>
        Promise.resolve({
          data: [{ id: 'item-1' }],
          count: 1,
          error: null,
        }).then(resolve),
      select: jest.fn(() => chain),
    };
    const db = {
      from: jest.fn(() => chain),
      rpc: jest.fn().mockResolvedValue({ error: null }),
    };
    const queue = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new MigrationRunsService(
      { getClient: () => db } as never,
      queue as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(service, 'get').mockResolvedValue(run({ status: 'running' }));

    await service.retryFailed(ORG, SOURCE_RUN);

    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'pending',
        retry_count: 0,
        max_attempts: 8,
      }),
    );
    expect(chain.eq).toHaveBeenCalledWith('organization_id', ORG);
    expect(chain.eq).toHaveBeenCalledWith('run_id', SOURCE_RUN);
    expect(chain.in).toHaveBeenCalledWith('status', ['failed', 'dead']);
    expect(chain.neq).toHaveBeenCalledWith('stage', 'verify');
    expect(db.rpc).toHaveBeenCalledWith(
      'migration_merge_run_totals',
      expect.objectContaining({
        p_patch: {
          verification: { stale: true, generation: expect.any(String) },
        },
      }),
    );
    expect(db.rpc.mock.invocationCallOrder[0]).toBeLessThan(
      chain.update.mock.invocationCallOrder[1],
    );
  });

  it('resets the execution clock when reopening a terminal run', async () => {
    const itemChain: any = {
      update: jest.fn(() => itemChain),
      eq: jest.fn(() => itemChain),
      in: jest.fn(() => itemChain),
      neq: jest.fn(() => itemChain),
      then: (resolve: any) =>
        Promise.resolve({
          data: [{ id: 'item-1' }],
          count: 1,
          error: null,
        }).then(resolve),
      select: jest.fn(() => itemChain),
    };
    const reopened = run({
      status: 'running',
      finished_at: null,
      duration_ms: null,
      started_at: '2026-09-01T12:00:00.000Z',
    });
    const runChain: any = {
      update: jest.fn(() => runChain),
      eq: jest.fn(() => runChain),
      select: jest.fn().mockResolvedValue({ data: [reopened], error: null }),
    };
    const db = {
      rpc: jest.fn().mockResolvedValue({ error: null }),
      from: jest.fn((table: string) =>
        table === 'migration_run_items' ? itemChain : runChain,
      ),
    };
    const queue = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new MigrationRunsService(
      { getClient: () => db } as never,
      queue as never,
      {} as never,
      {} as never,
    );
    const terminalRun = run({
      status: 'partially_completed',
      started_at: '2026-08-01T00:00:00.000Z',
    });
    jest.spyOn(service, 'get').mockResolvedValue(terminalRun);
    jest.useFakeTimers().setSystemTime(Date.parse('2026-09-01T12:00:00.000Z'));

    try {
      await expect(service.retryFailed(ORG, SOURCE_RUN)).resolves.toEqual(
        reopened,
      );
    } finally {
      jest.useRealTimers();
    }

    expect(itemChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'pending',
        retry_count: 0,
        max_attempts: 8,
        next_retry_at: null,
        wakeup_at: null,
        error_class: null,
        error_message: null,
        started_at: null,
        finished_at: null,
        duration_ms: null,
      }),
    );
    expect(runChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'running',
        started_at: '2026-09-01T12:00:00.000Z',
        finished_at: null,
        duration_ms: null,
        error_message: null,
      }),
    );
  });
});

describe('MigrationRunsService.cancel', () => {
  it('skips leased running items so a worker cannot release them after cancellation', async () => {
    const chain: any = {
      update: jest.fn(() => chain),
      eq: jest.fn(() => chain),
      in: jest.fn().mockResolvedValue({ error: null }),
    };
    const db = { from: jest.fn(() => chain) };
    const queue = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new MigrationRunsService(
      { getClient: () => db } as never,
      queue as never,
      {} as never,
      {} as never,
    );
    jest
      .spyOn(service as any, 'transition')
      .mockResolvedValue(run({ status: 'cancelled' }));

    await service.cancel(ORG, SOURCE_RUN);

    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'skipped',
        error_message: 'Run cancelled',
        lease_until: null,
        worker_id: null,
      }),
    );
    expect(chain.in).toHaveBeenCalledWith('status', [
      'pending',
      'running',
      'sleeping',
      'blocked',
      'paused',
    ]);
  });
});
