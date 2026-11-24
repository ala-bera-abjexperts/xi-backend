import { MigrationTickService } from './migration-tick.service';

function fixture(
  verification: Record<string, unknown>,
  generation?: string,
  status = 'running',
  concurrentRetry = false,
  relink?: Record<string, unknown>,
) {
  const guards: { key: string; value: unknown; kind: string }[] = [];
  const updates: {
    table: string;
    value: Record<string, unknown>;
    filters: Record<string, unknown>;
  }[] = [];
  const queue = {
    seedCollectionItem: jest.fn(),
    log: jest.fn(),
    wakeSleepers: jest.fn().mockResolvedValue(0),
    unblockReadyItems: jest.fn().mockResolvedValue(0),
  };
  const run = {
    id: 'run',
    organization_id: 'org',
    stage_index: relink ? 2 : 1,
    status: 'running',
    config_snapshot: {
      stage_plan: relink
        ? ['issues', 'jira_attachment_relink', 'verify']
        : ['issues', 'verify'],
    },
    totals: { verification: { reconciliations: [{ shortfall: 99 }] } },
  };
  const rpc = jest.fn().mockResolvedValue({ error: null });
  const db = {
    rpc,
    from: (table: string) => {
      let update = false;
      let generationGuard = false;
      const filters: Record<string, unknown> = {};
      const q = {
        select: () => q,
        limit: () => q,
        eq: (key: string, value: unknown) => {
          guards.push({ key, value, kind: 'eq' });
          filters[key] = value;
          if (key === 'totals->verification->>generation')
            generationGuard = true;
          return q;
        },
        is: (key: string, value: unknown) => {
          guards.push({ key, value, kind: 'is' });
          if (key === 'totals->verification->>generation')
            generationGuard = true;
          return q;
        },
        in: () => q,
        update: (value: Record<string, unknown>) => {
          updates.push({ table, value, filters });
          update = true;
          return q;
        },
        single: () =>
          Promise.resolve({
            data: { totals: { verification }, status },
            error: null,
          }),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({
            data: update
              ? concurrentRetry && generationGuard
                ? []
                : [{ id: 'run' }]
              : table === 'migration_runs'
                ? [run]
                : filters.stage === 'jira_attachment_relink'
                  ? [{ id: 'relink-collection', payload: relink }]
                  : [
                      {
                        id: 'verify-item',
                        payload: generation
                          ? { verification_generation: generation }
                          : {},
                      },
                    ],
            error: null,
          }).then(resolve),
      };
      return q;
    },
  };
  const tick = new MigrationTickService(
    { getClient: () => db } as never,
    queue as never,
  );
  return { tick, run, updates, rpc, queue, guards };
}

describe('retry verification finalization', () => {
  it('requeues verification at the final stage after work drains', async () => {
    const { tick, run, updates } = fixture({ stale: true, generation: 'new' });
    expect(await tick['advanceOrFinish'](run as never, new Map())).toBe(
      'advanced',
    );
    expect(updates).toEqual([
      expect.objectContaining({
        table: 'migration_run_items',
        value: expect.objectContaining({
          status: 'pending',
          payload: { verification_generation: 'new' },
        }),
      }),
    ]);
    expect(run.stage_index).toBe(1);
  });
  it('finalizes the first verification with its empty generation token', async () => {
    const { tick, run, guards } = fixture({
      generation: '',
      stale: false,
      reconciliations: [{ shortfall: 0 }],
    });
    expect(await tick['advanceOrFinish'](run as never, new Map())).toBe(
      'finished',
    );
    expect(guards).toContainEqual({
      kind: 'eq',
      key: 'totals->verification->>generation',
      value: '',
    });
  });
  it('uses fresh verification, not the old shortfall snapshot', async () => {
    const { tick, run, updates } = fixture({
      stale: false,
      reconciliations: [{ shortfall: 0 }],
    });
    await tick['advanceOrFinish'](run as never, new Map());
    expect(updates[0].value.status).toBe('succeeded');
  });
  it.each([
    { stale: false, reconciliations: [{ shortfall: 1 }] },
    { stale: true, generation: 'new' },
  ])(
    'does not succeed with missing or stale targets: %j',
    async (verification) => {
      const { tick, run, updates } = fixture(verification, 'new');
      await tick['advanceOrFinish'](run as never, new Map());
      expect(updates[0].value.status).toBe('partially_completed');
    },
  );
  it('does not resurrect a run stopped by authorization', async () => {
    const { tick, run, updates } = fixture({}, undefined, 'failed');
    expect(await tick['advanceOrFinish'](run as never, new Map())).toBe('noop');
    expect(updates).toEqual([]);
  });
  it('does not finalize a concurrent retry with a different generation', async () => {
    const { tick, run, queue } = fixture(
      { stale: false, generation: 'old' },
      undefined,
      'running',
      true,
    );
    expect(await tick['advanceOrFinish'](run as never, new Map())).toBe('noop');
    expect(queue.log).not.toHaveBeenCalled();
  });
  it('does not schedule verification while a retried item is still running', async () => {
    const { tick } = fixture({ stale: true, generation: 'new' });
    jest
      .spyOn(tick as never, 'countItems' as never)
      .mockResolvedValue(new Map([['running', 1]]) as never);
    const advance = jest.spyOn(tick as never, 'advanceOrFinish' as never);
    await tick.runTick();
    expect(advance).not.toHaveBeenCalled();
  });
  it('re-runs attachment relink once per retry generation before verify', async () => {
    const { tick, run, updates } = fixture(
      { stale: true, generation: 'g1' },
      undefined,
      'running',
      false,
      {},
    );
    expect(await tick['advanceOrFinish'](run as never, new Map())).toBe(
      'advanced',
    );
    expect(updates).toHaveLength(2);
    expect(updates[0].filters).toMatchObject({
      stage: 'jira_attachment_relink',
      item_kind: 'entity',
    });
    expect(updates[0].value).toMatchObject({ status: 'pending' });
    expect(updates[0].value).not.toHaveProperty('payload');
    expect(updates[1].filters).toMatchObject({ id: 'relink-collection' });
    expect(updates[1].value).toMatchObject({
      status: 'pending',
      checkpoint: null,
      payload: { relink_generation: 'g1' },
    });
  });
  it('falls through to verify once relink carries the generation', async () => {
    const { tick, run, updates } = fixture(
      { stale: true, generation: 'g1' },
      undefined,
      'running',
      false,
      { relink_generation: 'g1' },
    );
    expect(await tick['advanceOrFinish'](run as never, new Map())).toBe(
      'advanced',
    );
    expect(updates).toEqual([
      expect.objectContaining({
        filters: expect.objectContaining({ stage: 'verify' }),
        value: expect.objectContaining({
          payload: { verification_generation: 'g1' },
        }),
      }),
    ]);
  });
  it('re-runs relink after a mid-run retry that verify already cleared', async () => {
    const { tick, run, updates } = fixture(
      { stale: false, generation: 'g1' },
      undefined,
      'running',
      false,
      {},
    );
    expect(await tick['advanceOrFinish'](run as never, new Map())).toBe(
      'advanced',
    );
    expect(updates[1].value.payload).toEqual({ relink_generation: 'g1' });
  });
  it.each(['', undefined])(
    'does not re-run relink for a never-retried run (generation %p)',
    async (generation) => {
      const { tick, run, updates } = fixture(
        { stale: false, generation, reconciliations: [{ shortfall: 0 }] },
        undefined,
        'running',
        false,
        {},
      );
      expect(await tick['advanceOrFinish'](run as never, new Map())).toBe(
        'finished',
      );
      expect(updates).toEqual([
        expect.objectContaining({
          table: 'migration_runs',
          value: expect.objectContaining({ status: 'succeeded' }),
        }),
      ]);
    },
  );
  it('rolls up only by_status with an atomic patch', async () => {
    const { tick, run, rpc } = fixture({});
    await tick['rollupTotals'](run as never, new Map([['succeeded', 4]]));
    expect(rpc).toHaveBeenCalledWith('migration_merge_run_totals', {
      p_org_id: 'org',
      p_run_id: 'run',
      p_patch: { by_status: { succeeded: 4 } },
    });
  });
});
