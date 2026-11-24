import { BadRequestException, NotFoundException } from '@nestjs/common';
import { databaseBadRequest } from '../../../common/utils/database-error';
import { IssuesStage } from './issues.stage';
import { migrationTaskIdentity } from './migration-task-identity.util';
import type { MigrationRunItemRow, StageContext } from './stage.interface';

jest.mock('../../../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (value: unknown) => value,
}));
const identity = migrationTaskIdentity('org', 'connection', '100');
function setup(
  history: any = { data: [], error: null },
  liveTasks: any = { data: [], error: null },
) {
  const create = jest.fn().mockResolvedValue({ id: identity.targetId });
  const chain: any = {};
  for (const method of ['select', 'eq', 'is', 'not', 'in'])
    chain[method] = jest.fn(() => chain);
  chain.limit = jest
    .fn()
    .mockResolvedValueOnce(history)
    .mockResolvedValue(liveTasks);
  const stage = new IssuesStage(
    { create } as never,
    { getClient: () => ({ from: () => chain }) } as never,
  );
  const ctx = {
    orgId: 'org',
    dryRun: false,
    job: {
      id: 'new-job',
      connection_id: 'connection',
      source_ref: 'PRJ',
      options: {},
      scope: {},
    },
    run: { id: 'new-run', created_by: 'user', config_snapshot: {} },
    log: jest.fn(),
    entityMap: {
      getExistingTarget: jest.fn().mockResolvedValue(null),
      getTarget: jest
        .fn()
        .mockResolvedValue({ status: 'mapped', target_id: 'target' }),
      recordMapping: jest.fn().mockResolvedValue(undefined),
    },
  } as unknown as StageContext;
  const item = {
    payload: {
      sourceId: '100',
      key: 'PRJ-1',
      summary: 'source',
      issueTypeSourceId: 'type',
      statusSourceId: 'status',
      description: null,
      customFields: {},
      labels: [],
      migrationIdentity: identity,
    },
  } as unknown as MigrationRunItemRow;
  return { stage, ctx, item, create, chain };
}
describe('issue durable identity and error classification', () => {
  it.each([
    [503, 'transient'],
    [429, 'rate_limited'],
    [0, 'transient'],
    [400, 'permanent'],
  ])('classifies target response %s', async (status, errorClass) => {
    const { stage, ctx, item, create } = setup();
    create.mockRejectedValue(
      databaseBadRequest({ message: 'target rejected' }, status as number),
    );
    await expect(stage.processItem(ctx, item)).rejects.toMatchObject({
      errorClass,
    });
  });
  it.each([
    new BadRequestException('Invalid status_id'),
    new NotFoundException('Task not found'),
  ])('keeps ordinary validation permanent %s', async (error) => {
    const { stage, ctx, item, create } = setup();
    create.mockRejectedValue(error);
    await expect(stage.processItem(ctx, item)).rejects.toMatchObject({
      errorClass: 'permanent',
    });
  });
  it('requires reconciliation of legacy payloads', async () => {
    const { stage, ctx, item, create } = setup();
    const { migrationIdentity: _, ...payload } = item.payload!;
    await expect(
      stage.processItem(ctx, { ...item, payload }),
    ).rejects.toMatchObject({ errorClass: 'conflict' });
    expect(create).not.toHaveBeenCalled();
  });
  it('does not bypass an unknown historical insert in a fresh repair job/run', async () => {
    const { stage, ctx, item, create, chain } = setup({
      data: [{ id: 'legacy-item' }],
      error: null,
    });
    await expect(stage.processItem(ctx, item)).rejects.toMatchObject({
      errorClass: 'conflict',
    });
    expect(create).not.toHaveBeenCalled();
    expect(chain.eq).toHaveBeenCalledWith(
      'migration_runs.connection_id',
      'connection',
    );
    expect(chain.eq).not.toHaveBeenCalledWith('run_id', 'new-run');
    expect(chain.not).not.toHaveBeenCalledWith('started_at', 'is', null);
  });
  it('never creates during a history lookup outage', async () => {
    const { stage, ctx, item, create } = setup({
      data: null,
      error: { message: 'outage' },
      status: 503,
    });
    await expect(stage.processItem(ctx, item)).rejects.toMatchObject({
      errorClass: 'transient',
    });
    expect(create).not.toHaveBeenCalled();
  });
  it('uses the same identity after a failed mapping and records uncertain effects on adoption', async () => {
    const { stage, ctx, item, create } = setup();
    (ctx.entityMap.recordMapping as jest.Mock).mockRejectedValueOnce(
      new Error('mapping unavailable'),
    );
    await expect(stage.processItem(ctx, item)).rejects.toThrow(
      'mapping unavailable',
    );
    create.mockImplementationOnce(async (_org, _user, _dto, opts) => {
      opts.migrationIdentity.onAdopt();
      return { id: identity.targetId };
    });
    await expect(stage.processItem(ctx, item)).resolves.toMatchObject({
      targetId: identity.targetId,
    });
    expect(
      create.mock.calls.map((call) => call[3].migrationIdentity.targetId),
    ).toEqual([identity.targetId, identity.targetId]);
    expect(ctx.entityMap.recordMapping).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ creation_effects: 'unknown' }),
      }),
    );
    expect(ctx.log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('side effects'),
      expect.anything(),
    );
  });
  it('persists the identity when producing a new issue snapshot', async () => {
    const { stage, ctx, item } = setup();
    const { migrationIdentity: _, ...source } = item.payload!;
    const adapter = {
      product: 'jira',
      listProjects: jest.fn(),
      iterateIssues: async function* () {
        yield { items: [source], nextCursor: null };
      },
    };
    ctx.getAdapter = jest.fn().mockResolvedValue(adapter);
    (ctx.entityMap as any).listMappedCustomFieldSourceIds = jest
      .fn()
      .mockResolvedValue([]);
    const produced = await stage.produce(ctx, { checkpoint: {} } as never);
    expect(produced.items[0].payload?.migrationIdentity).toEqual(identity);
  });
  it('keeps identity stable and separates organizations, connections and source ids', () => {
    expect(migrationTaskIdentity('org', 'connection', '100')).toEqual({
      version: 1,
      targetId: '7241cc63-a672-8523-a193-2e32cba90b5a',
    });
    expect(
      new Set([
        identity.targetId,
        migrationTaskIdentity('other', 'connection', '100').targetId,
        migrationTaskIdentity('org', 'other', '100').targetId,
        migrationTaskIdentity('org', 'connection', '101').targetId,
      ]).size,
    ).toBe(4);
  });
  describe('legacy (pre-identity) attempts', () => {
    const TASK = '11111111-2222-4333-8444-555555555555';
    const attempt = (over: Record<string, unknown>) => ({
      data: [
        {
          run_id: 'adc4f3e3-legacy',
          status: 'failed',
          error_class: 'permanent',
          target_id: null,
          ...over,
        },
      ],
      error: null,
    });

    it.each([
      ['failed before any write', {}],
      ['skipped', { status: 'skipped', error_class: null }],
    ])('creates when the legacy attempt %s', async (_label, over) => {
      const { stage, ctx, item, create } = setup(attempt(over));
      await expect(stage.processItem(ctx, item)).resolves.toMatchObject({
        kind: 'created',
      });
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('creates when the legacy target was deleted since', async () => {
      const { stage, ctx, item, create } = setup(
        attempt({ status: 'succeeded', error_class: null, target_id: TASK }),
        { data: [], error: null },
      );
      await expect(stage.processItem(ctx, item)).resolves.toMatchObject({
        kind: 'created',
      });
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('adopts a legacy target still live in the target space instead of duplicating it', async () => {
      const { stage, ctx, item, create } = setup(
        attempt({ status: 'succeeded', error_class: null, target_id: TASK }),
        { data: [{ id: TASK, space_id: 'target' }], error: null },
      );
      await expect(stage.processItem(ctx, item)).resolves.toMatchObject({
        kind: 'skipped',
        targetId: TASK,
      });
      expect(create).not.toHaveBeenCalled();
      expect(ctx.entityMap.recordMapping).toHaveBeenCalledWith(
        expect.objectContaining({ targetId: TASK, status: 'mapped' }),
      );
    });

    it.each([
      [
        'a live target in another space',
        attempt({ status: 'succeeded', error_class: null, target_id: TASK }),
        { data: [{ id: TASK, space_id: 'elsewhere' }], error: null },
      ],
      [
        'a transient failure',
        attempt({ error_class: 'transient' }),
        undefined,
      ],
      ['a dead attempt', attempt({ status: 'dead' }), undefined],
      [
        'a success without a target',
        attempt({ status: 'succeeded', error_class: null }),
        undefined,
      ],
    ])('stays a conflict for %s', async (_label, history, live) => {
      const { stage, ctx, item, create } = setup(history, live);
      await expect(stage.processItem(ctx, item)).rejects.toMatchObject({
        errorClass: 'conflict',
        message: expect.stringContaining('adc4f3e3'),
      });
      expect(create).not.toHaveBeenCalled();
    });

    it('lets a dry run predict the conflict a live run would hit', async () => {
      const { stage, ctx, item } = setup(attempt({ status: 'dead' }));
      (ctx as { dryRun: boolean }).dryRun = true;
      await expect(stage.processItem(ctx, item)).rejects.toMatchObject({
        errorClass: 'conflict',
      });
    });

    it('still plans in a dry run when the legacy attempt is safe', async () => {
      const { stage, ctx, item } = setup(attempt({}));
      (ctx as { dryRun: boolean }).dryRun = true;
      await expect(stage.processItem(ctx, item)).resolves.toMatchObject({
        kind: 'planned',
      });
    });
  });
});
