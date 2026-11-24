import {
  ConflictException,
  ForbiddenException,
  HttpStatus,
  RequestMethod,
} from '@nestjs/common';
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
import { BulkDeleteTestCasesDto } from '../dto/test-case.dto';
import { notFound } from '../test-management-errors';
import { TestCasesController } from './test-cases.controller';
import { TestCasesService } from './test-cases.service';

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
  const service = new TestCasesService(
    { getClient: () => chain } as unknown as SupabaseAdminService,
    access as unknown as TestManagementAccessService,
    {
      logActionForRequest: jest.fn(),
    } as unknown as AuditLogsService,
  );
  const remove = jest.spyOn(service, 'remove');

  return { service, remove, access, calls };
}

const deleted = { deleted: true, has_runs: false, counts: {} };

describe('TestCasesService.bulkRemove', () => {
  it('deletes every case through remove()', async () => {
    const { service, remove } = setup([
      { id: A, key: 'P-T1' },
      { id: B, key: 'P-T2' },
    ]);

    remove.mockResolvedValue(deleted);

    await expect(
      service.bulkRemove(USER, SPACE, { case_ids: [A, B] }),
    ).resolves.toEqual({
      changed: true,
      deleted: [
        { case_id: A, key: 'P-T1' },
        { case_id: B, key: 'P-T2' },
      ],
      skipped: [],
    });
    expect(remove).toHaveBeenCalledWith(USER, SPACE, A, false);
    expect(remove).toHaveBeenCalledWith(USER, SPACE, B, false);
  });

  it('reads keys only from this space and organization', async () => {
    const { service, remove, access, calls } = setup([]);

    await service.bulkRemove(USER, SPACE, { case_ids: [OTHER] });

    expect(access.assertAvailable).toHaveBeenCalledWith(ORG, SPACE, {
      write: true,
    });
    expect(calls).toContainEqual({ method: 'from', args: ['test_cases'] });
    expect(calls).toContainEqual({ method: 'in', args: ['id', [OTHER]] });
    expect(calls).toContainEqual({ method: 'eq', args: ['space_id', SPACE] });
    expect(calls).toContainEqual({
      method: 'eq',
      args: ['organization_id', ORG],
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it('skips cases with runs, unknown ids and cases gone meanwhile', async () => {
    const { service, remove } = setup([
      { id: A, key: 'P-T1' },
      { id: B, key: 'P-T2' },
      { id: C, key: 'P-T3' },
    ]);

    remove
      .mockRejectedValueOnce(
        new ConflictException({ code: 'CASE_HAS_RUNS', message: 'runs' }),
      )
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce({ deleted: false, has_runs: true, counts: {} });

    const result = await service.bulkRemove(USER, SPACE, {
      case_ids: [A, OTHER, B, C],
    });

    expect(result).toEqual({
      changed: false,
      deleted: [],
      skipped: [
        { case_id: A, key: 'P-T1', reason: 'has_runs' },
        { case_id: OTHER, key: '', reason: 'not_found' },
        { case_id: B, key: 'P-T2', reason: 'not_found' },
        { case_id: C, key: 'P-T3', reason: 'has_runs' },
      ],
    });
  });

  it('marks other errors as failed and goes on with the next case', async () => {
    const { service, remove } = setup([
      { id: A, key: 'P-T1' },
      { id: B, key: 'P-T2' },
    ]);

    remove
      .mockRejectedValueOnce(
        new ConflictException({ code: 'TM001', message: 'changed' }),
      )
      .mockResolvedValueOnce(deleted);

    const result = await service.bulkRemove(USER, SPACE, { case_ids: [A, B] });

    expect(result.skipped).toEqual([
      { case_id: A, key: 'P-T1', reason: 'failed' },
    ]);
    expect(result.deleted).toEqual([{ case_id: B, key: 'P-T2' }]);
    expect(result.changed).toBe(true);
  });

  it('stops at a refused ticket delete and marks the rest as failed', async () => {
    const { service, remove } = setup([
      { id: A, key: 'P-T1' },
      { id: B, key: 'P-T2' },
      { id: C, key: 'P-T3' },
    ]);

    remove
      .mockResolvedValueOnce(deleted)
      .mockRejectedValueOnce(new ForbiddenException('no'));

    const result = await service.bulkRemove(USER, SPACE, {
      case_ids: [A, B, C],
    });

    expect(remove).toHaveBeenCalledTimes(2);
    expect(result.deleted).toEqual([{ case_id: A, key: 'P-T1' }]);
    expect(result.skipped).toEqual([
      { case_id: B, key: 'P-T2', reason: 'failed' },
      { case_id: C, key: 'P-T3', reason: 'failed' },
    ]);
  });

  it('deletes nothing when the module is not available', async () => {
    const { service, remove, access } = setup([{ id: A, key: 'P-T1' }]);

    access.assertAvailable.mockRejectedValue(notFound());

    await expect(
      service.bulkRemove(USER, SPACE, { case_ids: [A] }),
    ).rejects.toThrow();
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('BulkDeleteTestCasesDto', () => {
  const errorsOf = async (plain: Record<string, unknown>) =>
    (await validate(plainToInstance(BulkDeleteTestCasesDto, plain))).map(
      (error) => error.property,
    );

  it('accepts 1 to 100 distinct uuids', async () => {
    await expect(errorsOf({ case_ids: [A] })).resolves.toEqual([]);
    await expect(
      errorsOf({
        case_ids: Array.from(
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
    await expect(errorsOf({ case_ids: ids })).resolves.toEqual(['case_ids']);
  });
});

describe('POST cases/bulk-delete', () => {
  const handler = Object.getOwnPropertyDescriptor(
    TestCasesController.prototype,
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
    const controller = new TestCasesController({
      bulkRemove,
    } as unknown as TestCasesService);

    await controller.bulkRemove(SPACE, { case_ids: [A] }, USER);

    expect(bulkRemove).toHaveBeenCalledWith(USER, SPACE, { case_ids: [A] });
  });
});
