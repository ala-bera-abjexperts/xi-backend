import { AtlassianRequestError } from '../../adapters/http/atlassian-http-client';
import { TaskStatusStage } from './task-status.stage';
import type { StageContext, MigrationRunItemRow } from './stage.interface';
import type { TaskStatusesService } from '../../../task-statuses/task-statuses.service';

describe('board status prerequisites', () => {
  const projectStatus = {
    sourceId: '1',
    name: 'Open',
    statusCategory: 'new',
    issueTypeSourceIds: ['bug', 'task'],
  };
  function setup() {
    const adapter = {
      product: 'jira',
      listProjects: jest.fn(),
      getStatuses: jest.fn().mockResolvedValue([projectStatus]),
      getBoards: jest.fn().mockResolvedValue([
        {
          sourceId: '7',
          name: 'Selected board',
          columns: [{ statusSourceIds: ['1', '2', '2'] }],
        },
      ]),
      getStatus: jest.fn().mockResolvedValue({
        sourceId: '2',
        name: 'Board only',
        statusCategory: 'done',
      }),
    };
    const ctx = {
      getAdapter: async () => adapter,
      job: { source_ref: 'DEMO', scope: {} },
      run: { config_snapshot: {} },
      log: jest.fn(),
    } as unknown as StageContext;
    return {
      adapter,
      ctx,
      stage: new TaskStatusStage({} as TaskStatusesService),
    };
  }
  it('unions board-only statuses without losing project issue-type associations', async () => {
    const { adapter, ctx, stage } = setup();
    const result = await stage.produce(ctx);
    expect(result.items.map((i) => i.sourceRef)).toEqual(['1', '2']);
    expect(result.items[0].payload?.issueTypeSourceIds).toEqual([
      'bug',
      'task',
    ]);
    expect(adapter.getStatus).toHaveBeenCalledTimes(1);
    expect(adapter.getStatus).toHaveBeenCalledWith('2');
  });
  it('keeps inaccessible board statuses as actionable failed prerequisites', async () => {
    const { adapter, ctx, stage } = setup();
    adapter.getStatus.mockRejectedValue(
      new AtlassianRequestError('HTTP 403', 403),
    );
    const result = await stage.produce(ctx);
    const failed = result.items[1];
    expect(failed.sourceRef).toBe('2');
    await expect(
      stage.processItem(ctx, {
        source_ref: failed.sourceRef,
        payload: failed.payload,
      } as MigrationRunItemRow),
    ).rejects.toThrow('Board 7 (Selected board) requires status 2: HTTP 403');
  });
  it('re-discovers a previously inaccessible prerequisite on repair', async () => {
    const { adapter, ctx, stage } = setup();
    adapter.getStatus.mockRejectedValueOnce(
      new AtlassianRequestError('HTTP 403', 403),
    );
    const failed = (await stage.produce(ctx)).items[1];
    ctx.entityMap = {
      getExistingTarget: jest
        .fn()
        .mockResolvedValue({ status: 'mapped', target_id: 'existing' }),
    } as unknown as StageContext['entityMap'];
    expect(
      await stage.processItem(ctx, {
        source_ref: failed.sourceRef,
        payload: failed.payload,
      } as MigrationRunItemRow),
    ).toMatchObject({ kind: 'skipped', targetId: 'existing' });
    expect(adapter.getStatus).toHaveBeenCalledTimes(2);
  });
  it.each([429, 503])(
    'preserves status-detail HTTP %s for worker retry/cooldown',
    async (status) => {
      const { adapter, ctx, stage } = setup();
      const error = new AtlassianRequestError('retry source', status);
      adapter.getStatus.mockRejectedValue(error);
      await expect(stage.produce(ctx)).rejects.toBe(error);
    },
  );
  it('retains and maps project statuses when one board configuration is inaccessible', async () => {
    const { adapter, ctx, stage } = setup();
    adapter.getBoards.mockResolvedValue([
      {
        sourceId: 'blocked',
        name: 'Blocked board',
        columns: [],
        configurationError: 'Board blocked HTTP 403',
      },
      {
        sourceId: 'accessible',
        name: 'Accessible board',
        columns: [{ statusSourceIds: ['2'] }],
      },
    ]);
    const produced = await stage.produce(ctx);
    expect(produced.items.map((item) => item.sourceRef)).toEqual(['1', '2']);
    ctx.entityMap = {
      getExistingTarget: jest
        .fn()
        .mockResolvedValue({ status: 'mapped', target_id: 'project-status' }),
    } as unknown as StageContext['entityMap'];
    expect(
      await stage.processItem(ctx, {
        payload: produced.items[0].payload,
      } as MigrationRunItemRow),
    ).toMatchObject({ kind: 'skipped', targetId: 'project-status' });
    expect(ctx.log).toHaveBeenCalledWith('error', 'Board blocked HTTP 403', {
      boardSourceId: 'blocked',
    });
  });
  it('does not discover boards when excluded', async () => {
    const { adapter, ctx, stage } = setup();
    ctx.run.config_snapshot = { scope: { include_boards: false } };
    expect((await stage.produce(ctx)).items).toHaveLength(1);
    expect(adapter.getBoards).not.toHaveBeenCalled();
  });
});
