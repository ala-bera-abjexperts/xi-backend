import { LinksStage } from './links.stage';
import type { StageContext, MigrationRunItemRow } from './stage.interface';
import type { TasksService } from '../../../tasks/tasks.service';
import type { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import type { RelationTypesService } from '../../../relation-types/relation-types.service';

function setup(status: string | null, bothMapped = false) {
  const query = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest
      .fn()
      .mockResolvedValue({ data: status ? { status } : null, error: null }),
  };
  const db = { from: jest.fn().mockReturnValue(query) };
  const ctx = {
    orgId: 'org',
    job: { connection_id: 'conn' },
    run: { id: 'run' },
    dryRun: true,
    log: jest.fn(),
    entityMap: {
      getTarget: jest.fn(async (_o, _c, type, id) =>
        type === 'issue' && (id === '1' || bothMapped)
          ? { status: 'mapped', target_id: `target-${id}` }
          : null,
      ),
      recordMapping: jest.fn(),
    },
  } as unknown as StageContext;
  const stage = new LinksStage(
    {} as TasksService,
    { getClient: () => db } as unknown as SupabaseAdminService,
    {} as RelationTypesService,
  );
  const item = {
    source_ref: '1:Blocks:2',
    payload: {
      issueSourceId: '1',
      link: { otherIssueSourceId: '2', type: 'Blocks' },
    },
  } as unknown as MigrationRunItemRow;
  return { query, db, ctx, stage, item };
}
describe('scoped link endpoints', () => {
  it('reports an absent inventory endpoint without expanding scope and retains references', async () => {
    const { stage, ctx, item, query } = setup(null);
    expect(await stage.processItem(ctx, item)).toMatchObject({
      kind: 'skipped',
      reason: expect.stringContaining('absent from this run'),
    });
    expect(ctx.log).toHaveBeenCalledWith(
      'warn',
      expect.any(String),
      expect.objectContaining({
        sourceRef: '1:Blocks:2',
        endpointSourceId: '2',
        reason: 'endpoint_absent_from_run_inventory',
      }),
    );
    expect(query.eq).toHaveBeenCalledWith('run_id', 'run');
    expect(item.payload?.link).toEqual({
      otherIssueSourceId: '2',
      type: 'Blocks',
    });
  });
  it('distinguishes a failed selected endpoint', async () => {
    const { stage, ctx, item } = setup('failed');
    await expect(stage.processItem(ctx, item)).rejects.toThrow(
      'Selected link endpoint 2 did not import (failed)',
    );
  });
  it('blocks while selected endpoint can still finish', async () => {
    const { stage, ctx, item } = setup('pending');
    expect(await stage.processItem(ctx, item)).toEqual({
      kind: 'blocked',
      waitingFor: { entityType: 'issue', sourceId: '2' },
    });
  });
  it('links existing mapped endpoints even if absent from current inventory', async () => {
    const { stage, ctx, item, db } = setup(null, true);
    jest
      .spyOn(stage as any, 'resolveRelationType')
      .mockResolvedValue('relation');
    expect(await stage.processItem(ctx, item)).toEqual({ kind: 'planned' });
    expect(db.from).not.toHaveBeenCalled();
    expect(ctx.entityMap.recordMapping).toHaveBeenCalled();
  });
});
