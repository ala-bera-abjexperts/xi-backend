import { ForbiddenException, HttpStatus, RequestMethod } from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import type { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { SPACE_PERMISSION_KEY } from '../../auth/decorators/require-space-permission.decorator';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { TestManagementAccessService } from '../access/test-management-access.service';
import { BulkDeleteTestSetsDto } from '../dto/test-set.dto';
import { notFound } from '../test-management-errors';
import { TestSetsController } from './test-sets.controller';
import { TestSetsService } from './test-sets.service';

const ORG = 'org-1';
const SPACE = '11111111-1111-4111-8111-111111111111';
const A = '33333333-3333-4333-8333-333333333333';
const B = '44444444-4444-4444-8444-444444444444';
const C = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';
const USER = { organizationId: ORG, userId: 'user-1' } as RequestUser;

function setup(rows: { id: string; key: string }[]) {
  const calls: { method: string; args: unknown[] }[] = [];
  const chain: Record<string, unknown> = {};

  for (const method of ['from', 'select', 'in', 'eq']) {
    chain[method] = (...args: unknown[]) => {
      calls.push({ method, args });

      return chain;
    };
  }

  chain.then = (resolve: (value: unknown) => void) =>
    resolve({
      data: rows.map((row) => ({ id: row.id, task: { key: row.key } })),
      error: null,
    });

  const access = { assertAvailable: jest.fn().mockResolvedValue(undefined) };
  const service = new TestSetsService(
    { getClient: () => chain } as unknown as SupabaseAdminService,
    access as unknown as TestManagementAccessService,
    {
      logActionForRequest: jest.fn(),
    } as unknown as AuditLogsService,
  );
  const remove = jest.spyOn(service, 'remove');

  return { service, remove, access, calls };
}

describe('TestSetsService.bulkRemove', () => {
  it('deletes every set through remove()', async () => {
    const { service, remove } = setup([
      { id: A, key: 'P-T1' },
      { id: B, key: 'P-T2' },
    ]);

    remove.mockResolvedValue(undefined);

    await expect(
      service.bulkRemove(USER, SPACE, { set_ids: [A, B] }),
    ).resolves.toEqual({
      changed: true,
      deleted: [
        { set_id: A, key: 'P-T1' },
        { set_id: B, key: 'P-T2' },
      ],
      skipped: [],
    });
    expect(remove).toHaveBeenCalledWith(USER, SPACE, A);
    expect(remove).toHaveBeenCalledWith(USER, SPACE, B);
  });

  it('reads keys only from this space and organization', async () => {
    const { service, remove, access, calls } = setup([]);

    await service.bulkRemove(USER, SPACE, { set_ids: [OTHER] });

    expect(access.assertAvailable).toHaveBeenCalledWith(ORG, SPACE, {
      write: true,
    });
    expect(calls).toContainEqual({ method: 'from', args: ['test_sets'] });
    expect(calls).toContainEqual({ method: 'in', args: ['id', [OTHER]] });
    expect(calls).toContainEqual({ method: 'eq', args: ['space_id', SPACE] });
    expect(calls).toContainEqual({
      method: 'eq',
      args: ['organization_id', ORG],
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it('skips unknown ids, sets gone meanwhile and failed deletes, and goes on', async () => {
    const { service, remove } = setup([
      { id: A, key: 'P-T1' },
      { id: B, key: 'P-T2' },
      { id: C, key: 'P-T3' },
    ]);

    remove
      .mockRejectedValueOnce(notFound())
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);

    const result = await service.bulkRemove(USER, SPACE, {
      set_ids: [A, OTHER, B, C],
    });

    expect(result).toEqual({
      changed: true,
      deleted: [{ set_id: C, key: 'P-T3' }],
      skipped: [
        { set_id: A, key: 'P-T1', reason: 'not_found' },
        { set_id: OTHER, key: '', reason: 'not_found' },
        { set_id: B, key: 'P-T2', reason: 'failed' },
      ],
    });
  });

  it('stops at a refused ticket delete and marks the rest as failed', async () => {
    const { service, remove } = setup([
      { id: A, key: 'P-T1' },
      { id: B, key: 'P-T2' },
      { id: C, key: 'P-T3' },
    ]);

    remove
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ForbiddenException('no'));

    const result = await service.bulkRemove(USER, SPACE, {
      set_ids: [A, B, C],
    });

    expect(remove).toHaveBeenCalledTimes(2);
    expect(result.deleted).toEqual([{ set_id: A, key: 'P-T1' }]);
    expect(result.skipped).toEqual([
      { set_id: B, key: 'P-T2', reason: 'failed' },
      { set_id: C, key: 'P-T3', reason: 'failed' },
    ]);
  });

  it('deletes nothing when the module is not available', async () => {
    const { service, remove, access } = setup([{ id: A, key: 'P-T1' }]);

    access.assertAvailable.mockRejectedValue(notFound());

    await expect(
      service.bulkRemove(USER, SPACE, { set_ids: [A] }),
    ).rejects.toThrow();
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('BulkDeleteTestSetsDto', () => {
  const errorsOf = async (plain: Record<string, unknown>) =>
    (await validate(plainToInstance(BulkDeleteTestSetsDto, plain))).map(
      (error) => error.property,
    );

  it('accepts 1 to 100 distinct uuids', async () => {
    await expect(errorsOf({ set_ids: [A] })).resolves.toEqual([]);
    await expect(
      errorsOf({
        set_ids: Array.from(
          { length: 100 },
          (_, index) =>
            `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        ),
      }),
    ).resolves.toEqual([]);
  });

  it.each([
    ['no ids', []],
    ['101 ids', Array.from({ length: 101 }, () => A)],
    ['duplicates', [A, A]],
    ['not a uuid', ['nope']],
  ])('refuses %s', async (_, ids) => {
    await expect(errorsOf({ set_ids: ids })).resolves.toEqual(['set_ids']);
  });
});

describe('POST sets/bulk-delete', () => {
  const handler = Object.getOwnPropertyDescriptor(
    TestSetsController.prototype,
    'bulkRemove',
  )?.value as object;

  it('needs the delete right and answers 200', () => {
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('bulk-delete');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    );
    expect(Reflect.getMetadata(SPACE_PERMISSION_KEY, handler)).toEqual(
      'delete_tests',
    );
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(
      HttpStatus.OK,
    );
  });

  it('passes the request to the service', async () => {
    const bulkRemove = jest.fn().mockResolvedValue({ changed: false });
    const controller = new TestSetsController({
      bulkRemove,
    } as unknown as TestSetsService);

    await controller.bulkRemove(SPACE, { set_ids: [A] }, USER);

    expect(bulkRemove).toHaveBeenCalledWith(USER, SPACE, { set_ids: [A] });
  });
});
