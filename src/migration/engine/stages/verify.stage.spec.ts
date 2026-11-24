import type { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import { VerifyStage } from './verify.stage';
import type { StageContext } from './stage.interface';

describe('VerifyStage stale crosswalk reconciliation', () => {
  it('counts only mapped issues whose physical task still exists', async () => {
    const updates: Record<string, unknown>[] = [];
    const db = {
      rpc: jest.fn(
        (_name: string, args?: { p_patch?: Record<string, unknown> }) => {
          // Only the totals RPC carries p_patch; sla_mark_import_run_ready must
          // not push an undefined entry ahead of it (updates[0] is asserted).
          if (args?.p_patch) updates.push({ totals: args.p_patch });
          return Promise.resolve({ data: 1, error: null });
        },
      ),
      from: (table: string) => {
        if (table === 'migration_run_items') {
          const query = {
            select: () => query,
            eq: () => query,
            in: () => query,
            order: () => query,
            range: () => query,
            then: (resolve: (value: unknown) => unknown) =>
              Promise.resolve({
                data: [
                  { target_id: 'task-live' },
                  { target_id: 'task-deleted' },
                ],
                count: 2,
                error: null,
              }).then(resolve),
          };
          return query;
        }

        if (table === 'tasks') {
          const query = {
            select: () => query,
            eq: () => query,
            in: () => query,
            order: () => query,
            range: () => query,
            then: (resolve: (value: unknown) => unknown) =>
              Promise.resolve({
                data: [{ id: 'task-live' }],
                error: null,
              }).then(resolve),
          };
          return query;
        }

        if (table === 'migration_runs') {
          return {
            update: (value: Record<string, unknown>) => {
              updates.push(value);
              const query = {
                eq: () => query,
                then: (resolve: (result: unknown) => unknown) =>
                  Promise.resolve({ error: null }).then(resolve),
              };
              return query;
            },
          };
        }

        throw new Error(`unexpected table ${table}`);
      },
    };
    const ctx = {
      orgId: 'org-1',
      dryRun: false,
      job: { connection_id: 'conn-1', source_ref: 'PROJ' },
      run: { id: 'run-1', config_snapshot: {}, totals: {} },
      getAdapter: jest.fn().mockResolvedValue({
        product: 'jira',
        listProjects: jest.fn(),
        countIssues: jest.fn().mockResolvedValue(2),
      }),
      entityMap: { recordMapping: jest.fn().mockResolvedValue(undefined) },
      log: jest.fn().mockResolvedValue(undefined),
    } as unknown as StageContext;
    const stage = new VerifyStage({
      getClient: () => db,
    } as unknown as SupabaseAdminService);

    await stage.processItem(ctx, { source_ref: 'verify:PROJ' } as never);
    expect(db.rpc).toHaveBeenCalledWith('sla_mark_import_run_ready', {
      p_organization_id: 'org-1', p_run_id: 'run-1',
    });

    const totals = updates[0].totals as {
      verification: { reconciliations: unknown };
    };
    expect(totals.verification.reconciliations).toEqual([
      {
        entityType: 'issue',
        sourceCount: 2,
        targetCount: 1,
        shortfall: 1,
      },
    ]);
  });

  it('scopes dry-run issue counts to this run instead of shared connection plans', async () => {
    const updates: Record<string, unknown>[] = [];
    const db = {
      rpc: (_name: string, args?: { p_patch?: Record<string, unknown> }) => {
        if (args?.p_patch) updates.push({ totals: args.p_patch });
        return Promise.resolve({ data: 1, error: null });
      },
      from: (table: string) => {
        if (table === 'migration_run_items') {
          const query = {
            select: () => query,
            eq: () => query,
            in: () => query,
            order: () => query,
            range: () => query,
            then: (resolve: (value: unknown) => unknown) =>
              Promise.resolve({
                data: [{ target_id: null }],
                error: null,
              }).then(resolve),
          };
          return query;
        }

        if (table === 'migration_runs') {
          return {
            update: (value: Record<string, unknown>) => {
              updates.push(value);
              const query = {
                eq: () => query,
                then: (resolve: (result: unknown) => unknown) =>
                  Promise.resolve({ error: null }).then(resolve),
              };
              return query;
            },
          };
        }

        throw new Error(`unexpected table ${table}`);
      },
    };
    const ctx = {
      orgId: 'org-1',
      dryRun: true,
      job: { connection_id: 'shared-conn', source_ref: 'KAN' },
      run: { id: 'dry-run-1', config_snapshot: {}, totals: {} },
      getAdapter: jest.fn().mockResolvedValue({
        product: 'jira',
        listProjects: jest.fn(),
        countIssues: jest.fn().mockResolvedValue(1),
      }),
      entityMap: { recordMapping: jest.fn().mockResolvedValue(undefined) },
      log: jest.fn().mockResolvedValue(undefined),
    } as unknown as StageContext;
    const stage = new VerifyStage({
      getClient: () => db,
    } as unknown as SupabaseAdminService);

    await stage.processItem(ctx, { source_ref: 'verify:KAN' } as never);

    const totals = updates[0].totals as {
      verification: { reconciliations: unknown };
    };
    expect(totals.verification.reconciliations).toEqual([
      {
        entityType: 'issue',
        sourceCount: 1,
        targetCount: 1,
        shortfall: 0,
      },
    ]);
  });

  it("counts only this run's live Confluence pages in the resolved space", async () => {
    const updates: Record<string, unknown>[] = [];
    const db = {
      rpc: (_name: string, args?: { p_patch?: Record<string, unknown> }) => {
        if (args?.p_patch) updates.push({ totals: args.p_patch });
        return Promise.resolve({ data: 1, error: null });
      },
      from: (table: string) => {
        if (table === 'migration_run_items') {
          const query = {
            select: () => query,
            eq: () => query,
            in: () => query,
            order: () => query,
            range: () => query,
            then: (resolve: (value: unknown) => unknown) =>
              Promise.resolve({
                data: [
                  { target_id: 'page-live' },
                  { target_id: 'page-deleted' },
                ],
                error: null,
              }).then(resolve),
          };
          return query;
        }

        if (table === 'wiki_pages') {
          const query = {
            select: () => query,
            eq: () => query,
            in: () => query,
            order: () => query,
            range: () => query,
            then: (resolve: (value: unknown) => unknown) =>
              Promise.resolve({
                data: [{ id: 'page-live' }],
                error: null,
              }).then(resolve),
          };
          return query;
        }

        if (table === 'migration_runs') {
          return {
            update: (value: Record<string, unknown>) => {
              updates.push(value);
              const query = {
                eq: () => query,
                then: (resolve: (result: unknown) => unknown) =>
                  Promise.resolve({ error: null }).then(resolve),
              };
              return query;
            },
          };
        }

        throw new Error(`unexpected table ${table}`);
      },
    };
    const getTarget = jest.fn().mockResolvedValue({
      status: 'mapped',
      target_id: 'space-live',
    });
    const ctx = {
      orgId: 'org-1',
      dryRun: false,
      job: { connection_id: 'conn-1', source_ref: 'DOCS' },
      run: { id: 'run-1', config_snapshot: {}, totals: {} },
      getAdapter: jest.fn().mockResolvedValue({
        product: 'confluence',
        iteratePages: async function* () {
          await Promise.resolve();
          yield { items: [{ sourceId: '1' }, { sourceId: '2' }] };
        },
      }),
      entityMap: {
        getTarget,
        recordMapping: jest.fn().mockResolvedValue(undefined),
      },
      log: jest.fn().mockResolvedValue(undefined),
    } as unknown as StageContext;
    const stage = new VerifyStage({
      getClient: () => db,
    } as unknown as SupabaseAdminService);

    await stage.processItem(ctx, { source_ref: 'verify:DOCS' } as never);

    const totals = updates[0].totals as {
      verification: { reconciliations: unknown };
    };
    expect(totals.verification.reconciliations).toEqual([
      {
        entityType: 'page',
        sourceCount: 2,
        targetCount: 1,
        shortfall: 1,
      },
    ]);
    expect(getTarget).toHaveBeenCalledWith('org-1', 'conn-1', 'space', 'DOCS');
  });
});

describe('VerifyStage Confluence repair inventory', () => {
  it.each([false, true])(
    'reconciles only the child repair inventory and checks target existence (missing=%s)',
    async (missing) => {
      const inventory = [
        {
          organization_id: 'org',
          run_id: 'repair-run',
          entity_type: 'confluence_page_repair',
          item_kind: 'entity',
          status: 'succeeded',
          target_id: 'page-1',
          payload: { targetId: 'page-1' },
          repair_target_id: 'page-1',
        },
        {
          organization_id: 'org',
          run_id: 'repair-run',
          entity_type: 'confluence_page_repair',
          item_kind: 'entity',
          status: 'skipped',
          target_id: null,
          payload: { targetId: 'page-2' },
          repair_target_id: 'page-2',
        },
        {
          organization_id: 'org',
          run_id: 'other-run',
          entity_type: 'page',
          item_kind: 'entity',
          status: 'succeeded',
          target_id: 'other-page',
        },
      ];
      const rpc = jest.fn().mockResolvedValue({ error: null });
      const iteratePages = jest.fn(() => {
        throw new Error('repair must not enumerate the whole source space');
      });
      const db = {
        rpc,
        from: (table: string) => {
          const filters: Record<string, unknown> = {};
          const q = {
            select: () => q,
            order: () => q,
            range: () => q,
            eq: (key: string, value: unknown) => {
              filters[key] = value;
              return q;
            },
            in: (key: string, value: unknown[]) => {
              filters[key] = value;
              return q;
            },
            then: (resolve: (value: unknown) => unknown) => {
              const source =
                table === 'migration_run_items'
                  ? inventory
                  : [
                      {
                        id: 'page-1',
                        organization_id: 'org',
                        space_id: 'space',
                        is_archived: false,
                      },
                      ...(!missing
                        ? [
                            {
                              id: 'page-2',
                              organization_id: 'org',
                              space_id: 'space',
                              is_archived: false,
                            },
                          ]
                        : []),
                    ];
              const data = source.filter((row) =>
                Object.entries(filters).every(([key, value]) =>
                  Array.isArray(value)
                    ? value.includes((row as Record<string, unknown>)[key])
                    : (row as Record<string, unknown>)[key] === value,
                ),
              );
              return Promise.resolve({
                data,
                count: data.length,
                error: null,
              }).then(resolve);
            },
          };
          return q;
        },
      };
      const ctx = {
        orgId: 'org',
        dryRun: false,
        job: { connection_id: 'conn', source_ref: 'DOCS' },
        run: {
          id: 'repair-run',
          config_snapshot: { repair_of_run_id: 'source-run' },
          totals: {},
        },
        getAdapter: async () => ({ product: 'confluence', iteratePages }),
        entityMap: {
          getTarget: async () => ({ status: 'mapped', target_id: 'space' }),
          recordMapping: jest.fn(),
        },
        log: jest.fn(),
      } as unknown as StageContext;
      await new VerifyStage({ getClient: () => db } as never).processItem(ctx, {
        source_ref: 'verify:DOCS',
      } as never);
      expect(iteratePages).not.toHaveBeenCalled();
      expect(rpc).toHaveBeenCalledWith(
        'migration_merge_run_totals',
        expect.objectContaining({
          p_patch: {
            verification: expect.objectContaining({
              reconciliations: [
                {
                  entityType: 'page',
                  sourceCount: 2,
                  targetCount: missing ? 1 : 2,
                  shortfall: missing ? 1 : 0,
                },
              ],
            }),
          },
        }),
      );
    },
  );
});
