import { BadRequestException } from '@nestjs/common';
import { TasksService } from './tasks.service';

jest.mock('../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (v: unknown) => v ?? null,
}));

const targetId = '7bb7ad64-e0e6-8674-9788-c4ff9eac80ad';
const dto = { space_id: 'space', task_type_id: 'task', summary: 'source' };
const task = {
  id: targetId,
  organization_id: 'org',
  space_id: 'space',
  task_type_id: 'task',
  parent_task_id: null,
  summary: 'user edited',
  description: null,
};
function setup(results: unknown[]) {
  const insert = jest.fn();
  const from = jest.fn(() => {
    const result = results.shift();
    const chain: any = {};
    for (const method of ['select', 'eq']) chain[method] = jest.fn(() => chain);
    chain.insert = jest.fn((row) => {
      insert(row);
      return chain;
    });
    chain.maybeSingle = chain.single = jest.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    });
    return chain;
  });
  const service = new TasksService({ getClient: () => ({ from }) } as never);
  for (const [method, value] of Object.entries({
    resolveCreateSpaceId: 'space',
    validateCreateTaskInput: { id: 'task' },
    resolveTaskStatusForWrite: { legacyKey: 'open', id: null },
    resolveTaskPriorityForWrite: { legacyKey: 'medium', id: null },
  }))
    jest.spyOn(service as any, method).mockResolvedValue(value);
  const audit = jest
    .spyOn(service as any, 'logAudit')
    .mockResolvedValue(undefined);
  return { service, insert, audit };
}
describe('migration-only task identity', () => {
  it.each([
    { message: 'upstream unavailable', code: '', status: 503 },
    { message: 'duplicate', code: '23505' },
  ])(
    'adopts committed insert after an ambiguous response or race %j',
    async (error) => {
      const { service, insert, audit } = setup([
        { data: null, error: null },
        { data: null, error },
        { data: task, error: null },
      ]);
      const onAdopt = jest.fn();
      expect(
        await service.create('org', 'user', dto, {
          migrationIdentity: { targetId, onAdopt },
        } as never),
      ).toEqual(task);
      expect(insert).toHaveBeenCalledWith(
        expect.objectContaining({ id: targetId }),
      );
      expect(insert.mock.calls[0][0]).not.toHaveProperty('key');
      expect(audit).not.toHaveBeenCalled();
      expect(onAdopt).toHaveBeenCalled();
    },
  );
  it('adopts after an insert commits but fetch rejects', async () => {
    const { service, audit } = setup([
      { data: null, error: null },
      new TypeError('fetch failed'),
      { data: task, error: null },
    ]);
    await expect(
      service.create('org', 'user', dto, { migrationIdentity: { targetId } }),
    ).resolves.toEqual(task);
    expect(audit).not.toHaveBeenCalled();
  });
  it('does not retry or adopt an insert constraint validation failure', async () => {
    const { service, insert } = setup([
      { data: null, error: null },
      {
        data: null,
        error: { message: 'constraint violation', code: '23514' },
        status: 400,
      },
    ]);
    await expect(
      service.create('org', 'user', dto, { migrationIdentity: { targetId } }),
    ).rejects.toThrow('constraint violation');
    expect(insert).toHaveBeenCalledTimes(1);
  });
  it('does not treat lookup failure as absence', async () => {
    const { service, insert } = setup([
      { data: null, error: { message: 'outage' }, status: 503 },
    ]);
    await expect(
      service.create('org', 'user', dto, {
        migrationIdentity: { targetId },
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(insert).not.toHaveBeenCalled();
  });
  it('adopts without replaying writes or creation effects after mapping failure', async () => {
    const { service, insert, audit } = setup([{ data: task, error: null }]);
    expect(
      await service.create('org', 'user', dto, {
        migrationIdentity: { targetId },
      } as never),
    ).toEqual(task);
    expect(insert).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
  it.each(['organization_id', 'space_id', 'task_type_id', 'parent_task_id'])(
    'rejects mismatching %s',
    async (field) => {
      const { service, insert } = setup([
        { data: { ...task, [field]: 'other' }, error: null },
      ]);
      await expect(
        service.create('org', 'user', dto, {
          migrationIdentity: { targetId },
        } as never),
      ).rejects.toThrow('identity');
      expect(insert).not.toHaveBeenCalled();
    },
  );
  it('keeps ordinary API status and body, retaining DB cause privately', async () => {
    const error = { message: 'outage', code: '08006' };
    const { service } = setup([{ data: null, error, status: 503 }]);
    try {
      await service.create('org', 'user', dto);
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toEqual({
        message: 'outage',
        error: 'Bad Request',
        statusCode: 400,
      });
      expect((err as any).cause).toMatchObject({ code: '08006', status: 503 });
    }
  });
});
