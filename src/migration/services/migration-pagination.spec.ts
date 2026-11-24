import { MigrationReportService } from './migration-report.service';
import { MigrationEntityMapService } from './migration-entity-map.service';
import { VerifyStage } from '../engine/stages/verify.stage';

function pagedDb(rows: unknown[], failSecond = false) {
  const orders: string[] = [];
  const ranges: number[] = [];
  return {
    orders,
    ranges,
    getClient: () => ({
      from: () => {
        let offset = 0;
        const q = {
          select: () => q,
          eq: () => q,
          in: () => q,
          limit: () => q,
          order: (key: string) => {
            orders.push(key);
            return q;
          },
          range: (start: number) => {
            offset = start;
            ranges.push(start);
            return q;
          },
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({
              data: rows.slice(offset, offset + 1000),
              error:
                failSecond && offset > 0
                  ? { message: 'later page failed' }
                  : null,
            }).then(resolve),
        };
        return q;
      },
    }),
  };
}

describe('complete migration pagination', () => {
  const rows = Array.from({ length: 6001 }, (_, id) => ({
    id: String(id),
    stage: 'pages',
    message: 'warning',
    created_at: 'same-time',
    context: {
      macroName: 'rss',
      reason: 'history skipped',
      internalNote: 'not exported',
    },
    source_ref: `page-${id}`,
  }));
  it('exports every fidelity log with stable id ordering and only safe diagnostics', async () => {
    const db = pagedDb(rows);
    const service = new MigrationReportService(db as never, {} as never);
    const result = await service['loadLossy']('org', 'run');
    expect(result).toHaveLength(6001);
    expect(db.orders).toContain('id');
    expect(result[6000]).toMatchObject({
      sourceRef: 'page-6000',
      macroName: 'rss',
      reason: 'history skipped',
    });
    expect(result[0]).not.toHaveProperty('internalNote');
  });
  it('uses the precise contextual source reference while redacting diagnostic secrets', async () => {
    const service = new MigrationReportService(
      pagedDb([
        {
          ...rows[0],
          source_ref: 'enclosing-page',
          context: {
            sourceRef: 'attachment:version-4',
            reason: 'token=secret https://private.example',
            macroName: 'rss',
          },
        },
      ]) as never,
      {} as never,
    );
    const [log] = await service['loadLossy']('org', 'run');
    expect(log.sourceRef).toBe('attachment:version-4');
    expect(log.reason).not.toContain('secret');
    expect(log.reason).not.toContain('private.example');
  });
  it('does not return a partial report when a later log page fails', async () => {
    const service = new MigrationReportService(
      pagedDb(rows, true) as never,
      {} as never,
    );
    await expect(service['loadLossy']('org', 'run')).rejects.toThrow(
      'later page failed',
    );
  });
  it('loads board crosswalk rows beyond the database cap', async () => {
    const db = pagedDb(rows.slice(0, 1001));
    const service = new MigrationEntityMapService(db as never);
    expect(
      await service.listByEntityType('org', 'connection', 'board'),
    ).toHaveLength(1001);
    expect(db.orders).toContain('id');
  });
  it('exports history skip diagnostics beyond the first page', async () => {
    const service = new MigrationReportService(
      pagedDb(rows) as never,
      {} as never,
    );
    const reasons = await service['loadHistorySkipReasons']('org', 'run');
    expect(reasons.size).toBe(6001);
    expect(reasons.get('page-6000')).toBe('history skipped');
  });
  it('rejects later-page crosswalk errors', async () => {
    const service = new MigrationEntityMapService(pagedDb(rows, true) as never);
    await expect(
      service.listByEntityType('org', 'conn', 'board'),
    ).rejects.toThrow('later page failed');
  });
  it.each(['issue', 'page'])(
    'rejects later-page %s verification errors',
    async (entity) => {
      const stage = new VerifyStage(pagedDb(rows, true) as never);
      await expect(
        stage['countCrosswalk'](
          { orgId: 'org', run: { id: 'run' }, dryRun: true } as never,
          entity,
        ),
      ).rejects.toThrow('later page failed');
    },
  );
  it.each(['issue', 'page'])(
    'checks physical %s targets across all pages and scopes target lookups',
    async (entity) => {
      const sourceRows = Array.from({ length: 1201 }, (_, id) => ({
        target_id: `target-${id}`,
      }));
      const paged = pagedDb(sourceRows).getClient();
      const scopes: unknown[][] = [];
      const stage = new VerifyStage({
        getClient: () => ({
          from: (table: string) => {
            if (table === 'migration_run_items') return paged.from();
            let ids: string[] = [];
            const q = {
              select: () => q,
              eq: (...args: unknown[]) => {
                scopes.push(args);
                return q;
              },
              in: (_: string, values: string[]) => {
                ids = values;
                return q;
              },
              then: (resolve: (value: unknown) => unknown) =>
                Promise.resolve({
                  data: ids
                    .filter((id) => id !== 'target-1200')
                    .map((id) => ({ id })),
                  error: null,
                }).then(resolve),
            };
            return q;
          },
        }),
      } as never);
      const count = await stage['countCrosswalk'](
        {
          orgId: 'org',
          run: {
            id: 'run',
            config_snapshot: { scope: { target_space_id: 'space' } },
          },
          job: { target_space_id: 'space' },
          entityMap: {
            getTarget: async () => ({ status: 'mapped', target_id: 'space' }),
          },
          dryRun: false,
        } as never,
        entity,
      );
      expect(count).toBe(1200);
      expect(scopes).toContainEqual(['organization_id', 'org']);
    },
  );
  it.each(['issue', 'page'])(
    'counts all run-scoped dry-run %s items',
    async (entity) => {
      const db = pagedDb(rows.slice(0, 1001));
      const stage = new VerifyStage(db as never);
      expect(
        await stage['countCrosswalk'](
          { orgId: 'org', run: { id: 'run' }, dryRun: true } as never,
          entity,
        ),
      ).toBe(1001);
      expect(db.orders).toContain('id');
    },
  );
});
