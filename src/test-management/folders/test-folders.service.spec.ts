import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import type { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { TestManagementAccessService } from '../access/test-management-access.service';
import {
  CreateTestFolderDto,
  UpdateTestFolderDto,
} from '../dto/test-folder.dto';
import { TestFoldersService } from './test-folders.service';

const ORG = 'org-1';
const SPACE = 'space-1';
const FOLDER = 'folder-1';
const user = { userId: 'user-1', organizationId: ORG } as RequestUser;

interface Result {
  data: unknown;
  error: unknown;
}

function chain(result: Result) {
  const query: Record<string, unknown> = {};
  const self = () => query;

  query.select = jest.fn(self);
  query.eq = jest.fn(self);
  query.not = jest.fn(self);
  query.order = jest.fn(self);
  query.range = jest.fn(self);
  query.maybeSingle = jest.fn(() => Promise.resolve(result));
  query.then = (resolve: (value: Result) => unknown) =>
    Promise.resolve(result).then(resolve);

  return query;
}

function row(id: string, name: string, parentId: string | null, count = 0) {
  return {
    id,
    parent_id: parentId,
    name,
    created_at: 't',
    updated_at: 't',
    test_cases: [{ count }],
  };
}

describe('TestFoldersService', () => {
  let service: TestFoldersService;
  let from: jest.Mock;
  let rpc: jest.Mock;
  let log: jest.Mock;

  beforeEach(() => {
    // Queued answers still come first; anything after them (the execution count) gets an empty list.
    from = jest.fn(() => chain({ data: [], error: null }));
    rpc = jest.fn();
    log = jest.fn().mockResolvedValue(undefined);

    service = new TestFoldersService(
      {
        getClient: () => ({ from, rpc }),
      } as unknown as SupabaseAdminService,
      {
        assertAvailable: jest.fn().mockResolvedValue(undefined),
      } as unknown as TestManagementAccessService,
      { logActionForRequest: log } as unknown as AuditLogsService,
    );
  });

  it('lists folders with active case counts, sorted by name ignoring case', async () => {
    const query = chain({
      data: [
        row('b', 'beta', null, 2),
        row('a', 'Alpha', null),
        { ...row('c', 'alpine', 'a'), test_cases: null },
      ],
      error: null,
    });

    from.mockReturnValueOnce(query);

    const folders = await service.list(ORG, SPACE);

    expect(folders.map((f) => [f.name, f.case_count])).toEqual([
      ['Alpha', 0],
      ['alpine', 0],
      ['beta', 2],
    ]);
    expect(folders[0]).not.toHaveProperty('test_cases');
    expect(query.eq).toHaveBeenCalledWith('organization_id', ORG);
    expect(query.eq).toHaveBeenCalledWith('test_cases.is_archived', false);
  });

  it('lists active set and plan counts beside the case count', async () => {
    const query = chain({
      data: [
        {
          ...row('a', 'Alpha', null, 4),
          test_sets: [{ count: 2 }],
          test_plans: [{ count: 1 }],
        },
        { ...row('b', 'Beta', null), test_sets: null, test_plans: null },
      ],
      error: null,
    });

    from.mockReturnValueOnce(query);

    const folders = await service.list(ORG, SPACE);

    expect(
      folders.map((f) => [f.name, f.case_count, f.set_count, f.plan_count]),
    ).toEqual([
      ['Alpha', 4, 2, 1],
      ['Beta', 0, 0, 0],
    ]);
    expect(folders[0]).not.toHaveProperty('test_sets');
    expect(query.eq).toHaveBeenCalledWith('test_sets.is_archived', false);
    expect(query.eq).toHaveBeenCalledWith('test_plans.is_archived', false);
  });

  it('reads every page so a space can hold more than 1000 folders', async () => {
    const full = Array.from({ length: 1000 }, (_, i) =>
      row(`f${i}`, `Folder ${i}`, null),
    );
    const first = chain({ data: full, error: null });
    const second = chain({ data: [row('x', 'Extra', 'f0')], error: null });

    from.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const folders = await service.list(ORG, SPACE);

    expect(folders).toHaveLength(1001);
    expect(first.order).toHaveBeenCalledWith('id');
    expect(first.range).toHaveBeenCalledWith(0, 999);
    expect(second.range).toHaveBeenCalledWith(1000, 1999);
  });

  it('creates at the root when parent_id is omitted', async () => {
    rpc.mockResolvedValueOnce({ data: { id: FOLDER }, error: null });
    from.mockReturnValueOnce(
      chain({ data: row(FOLDER, 'New', null), error: null }),
    );

    const folder = await service.create(user, SPACE, { name: 'New' });

    expect(rpc).toHaveBeenCalledWith(
      'tm_save_folder',
      expect.objectContaining({
        p_folder_id: null,
        p_parent_id: null,
        p_name: 'New',
      }),
    );
    expect(folder.id).toBe(FOLDER);
    expect(log).toHaveBeenCalledWith(user, 'test_folder', FOLDER, 'create', {
      name: 'New',
      parent_id: null,
      space_id: SPACE,
    });
  });

  it('rename only keeps the current parent', async () => {
    // The first read also counts the folder's executions.
    from
      .mockReturnValueOnce(
        chain({ data: row(FOLDER, 'Old', 'parent-1'), error: null }),
      )
      .mockReturnValueOnce(chain({ data: [], error: null }))
      .mockReturnValueOnce(
        chain({ data: row(FOLDER, 'New', 'parent-1'), error: null }),
      );
    rpc.mockResolvedValueOnce({ data: { changed: true }, error: null });

    await service.update(user, SPACE, FOLDER, { name: 'New' });

    expect(rpc).toHaveBeenCalledWith(
      'tm_save_folder',
      expect.objectContaining({
        p_folder_id: FOLDER,
        p_parent_id: 'parent-1',
        p_name: 'New',
      }),
    );
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('parent_id null moves to the root without reading the folder first', async () => {
    rpc.mockResolvedValueOnce({ data: { changed: false }, error: null });
    from.mockReturnValueOnce(
      chain({ data: row(FOLDER, 'Old', null), error: null }),
    );

    await service.update(user, SPACE, FOLDER, { parent_id: null });

    // The folder read plus its execution count.
    expect(from).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith(
      'tm_save_folder',
      expect.objectContaining({ p_parent_id: null, p_name: null }),
    );
    expect(log).not.toHaveBeenCalled();
  });

  it('rejects an empty patch', async () => {
    await expect(service.update(user, SPACE, FOLDER, {})).rejects.toThrow(
      BadRequestException,
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it('answers 404 when renaming a folder of another space', async () => {
    from.mockReturnValueOnce(chain({ data: null, error: null }));

    await expect(
      service.update(user, SPACE, FOLDER, { name: 'New' }),
    ).rejects.toThrow(NotFoundException);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['TM006', 'tm: cycle', null, 'FOLDER_CYCLE'],
    [
      '23505',
      'duplicate key value violates unique constraint "test_folders_sibling_name_key"',
      null,
      'DUPLICATE_NAME',
    ],
  ])('maps %s on save to 409', async (code, message, details, apiCode) => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code, message, details },
    });

    const error: unknown = await service
      .update(user, SPACE, FOLDER, { parent_id: 'other' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: apiCode,
    });
  });

  it('refuses to delete a non-empty folder with its counts', async () => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: 'TM007',
        message: 'tm: folder is not empty',
        details:
          '{"subfolders": 1, "cases": 3, "archived_cases": 1, "sets": 2, "archived_sets": 0, "plans": 1, "archived_plans": 1}',
      },
    });

    const error: unknown = await service
      .remove(user, SPACE, FOLDER)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toEqual({
      code: 'FOLDER_NOT_EMPTY',
      message:
        'The folder still contains sub-folders, test cases, test sets or test plans',
      data: {
        subfolders: 1,
        cases: 3,
        archived_cases: 1,
        sets: 2,
        archived_sets: 0,
        plans: 1,
        archived_plans: 1,
      },
    });
    expect(log).not.toHaveBeenCalled();
  });

  it('deletes an empty folder and audits it', async () => {
    rpc.mockResolvedValueOnce({ data: { changed: true }, error: null });

    await expect(service.remove(user, SPACE, FOLDER)).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledWith('tm_delete_folder', {
      p_organization_id: ORG,
      p_space_id: SPACE,
      p_actor_id: 'user-1',
      p_folder_id: FOLDER,
    });
    expect(log).toHaveBeenCalledWith(user, 'test_folder', FOLDER, 'delete', {
      space_id: SPACE,
    });
  });
});

describe('test folder DTOs', () => {
  const errors = (
    cls: typeof CreateTestFolderDto | typeof UpdateTestFolderDto,
    body: object,
  ) =>
    validateSync(plainToInstance(cls, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    }).map((e) => e.property);

  it('trims the name', () => {
    expect(
      plainToInstance(CreateTestFolderDto, { name: '  Smoke  ' }).name,
    ).toBe('Smoke');
  });

  it.each([[''], ['   '], ['a/b'], ['x'.repeat(256)]])(
    'rejects the name %j',
    (name) => {
      expect(errors(CreateTestFolderDto, { name })).toEqual(['name']);
    },
  );

  it('accepts a null or omitted parent_id and rejects a non-uuid one', () => {
    expect(errors(CreateTestFolderDto, { name: 'a', parent_id: null })).toEqual(
      [],
    );
    expect(errors(UpdateTestFolderDto, { parent_id: null })).toEqual([]);
    expect(errors(UpdateTestFolderDto, { parent_id: 'nope' })).toEqual([
      'parent_id',
    ]);
  });

  it('rejects a null name on update', () => {
    expect(errors(UpdateTestFolderDto, { name: null })).toEqual(['name']);
  });
});

describe('TestFoldersService execution counts', () => {
  let service: TestFoldersService;
  let from: jest.Mock;
  let rpc: jest.Mock;
  let queries: Record<string, Record<string, jest.Mock>[]>;

  // Answers each table from its own queue; the chain also supports not().
  function answer(replies: Record<string, Result[]>) {
    from.mockImplementation((table: string) => {
      const result = replies[table]?.shift() ?? { data: [], error: null };
      const query: Record<string, jest.Mock> = {};

      for (const name of ['select', 'eq', 'not', 'order', 'range']) {
        query[name] = jest.fn(() => query);
      }

      query.maybeSingle = jest.fn(() => Promise.resolve(result));
      Object.assign(query, {
        then: (resolve: (value: Result) => unknown) =>
          Promise.resolve(result).then(resolve),
      });
      (queries[table] ??= []).push(query);

      return query;
    });
  }

  beforeEach(() => {
    from = jest.fn();
    rpc = jest.fn();
    queries = {};

    service = new TestFoldersService(
      {
        getClient: () => ({ from, rpc }),
      } as unknown as SupabaseAdminService,
      {
        assertAvailable: jest.fn().mockResolvedValue(undefined),
      } as unknown as TestManagementAccessService,
      {
        logActionForRequest: jest.fn().mockResolvedValue(undefined),
      } as unknown as AuditLogsService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('counts active executions per folder', async () => {
    answer({
      test_folders: [
        {
          data: [row('a', 'Alpha', null), row('b', 'Beta', null)],
          error: null,
        },
      ],
      test_executions: [
        {
          data: [{ folder_id: 'a' }, { folder_id: 'a' }, { folder_id: 'b' }],
          error: null,
        },
      ],
    });

    const folders = await service.list(ORG, SPACE);

    expect(folders.map((f) => [f.name, f.execution_count])).toEqual([
      ['Alpha', 2],
      ['Beta', 1],
    ]);

    const executions = queries.test_executions[0];

    expect(executions.eq).toHaveBeenCalledWith('space_id', SPACE);
    expect(executions.eq).toHaveBeenCalledWith('organization_id', ORG);
    expect(executions.eq).toHaveBeenCalledWith('is_archived', false);
    expect(executions.not).toHaveBeenCalledWith('folder_id', 'is', null);
  });

  it.each(['42703', 'PGRST204'])(
    'lists folders with zero executions when the column is missing (%s)',
    async (code) => {
      answer({
        test_folders: [{ data: [row('a', 'Alpha', null, 3)], error: null }],
        test_executions: [{ data: null, error: { code, message: 'missing' } }],
      });

      const folders = await service.list(ORG, SPACE);

      expect(folders.map((f) => [f.case_count, f.execution_count])).toEqual([
        [3, 0],
      ]);
    },
  );

  it('fails the list on any other execution count error', async () => {
    jest
      .spyOn(
        (service as unknown as { logger: { error: () => void } }).logger,
        'error',
      )
      .mockImplementation(() => undefined);
    answer({
      test_folders: [{ data: [row('a', 'Alpha', null)], error: null }],
      test_executions: [
        { data: null, error: { code: 'XX000', message: 'down' } },
      ],
    });

    await expect(service.list(ORG, SPACE)).rejects.toMatchObject({
      status: 500,
    });
  });

  it('counts only the loaded folder after a create', async () => {
    rpc.mockResolvedValueOnce({ data: { id: FOLDER }, error: null });
    answer({
      test_folders: [{ data: row(FOLDER, 'New', null), error: null }],
      test_executions: [{ data: [{ folder_id: FOLDER }], error: null }],
    });

    const folder = await service.create(user, SPACE, { name: 'New' });

    expect(folder.execution_count).toBe(1);
    expect(queries.test_executions[0].eq).toHaveBeenCalledWith(
      'folder_id',
      FOLDER,
    );
  });
});

describe('TestFoldersService folder order', () => {
  let service: TestFoldersService;
  let from: jest.Mock;
  let rpc: jest.Mock;
  let log: jest.Mock;

  beforeEach(() => {
    from = jest.fn(() => chain({ data: [], error: null }));
    rpc = jest.fn();
    log = jest.fn().mockResolvedValue(undefined);

    service = new TestFoldersService(
      {
        getClient: () => ({ from, rpc }),
      } as unknown as SupabaseAdminService,
      {
        assertAvailable: jest.fn().mockResolvedValue(undefined),
      } as unknown as TestManagementAccessService,
      { logActionForRequest: log } as unknown as AuditLogsService,
    );
  });

  it('lists placed folders in their order before the others, which stay in name order', async () => {
    from.mockReturnValueOnce(
      chain({
        data: [
          { ...row('a', 'Alpha', null), position: null },
          { ...row('z', 'Zulu', null), position: 1 },
          { ...row('m', 'Mike', null), position: 2 },
          { ...row('b', 'bravo', null), position: null },
        ],
        error: null,
      }),
    );

    const folders = await service.list(ORG, SPACE);

    expect(folders.map((f) => [f.name, f.position])).toEqual([
      ['Zulu', 1],
      ['Mike', 2],
      ['Alpha', null],
      ['bravo', null],
    ]);
  });

  it('reads the folders without the position column before the order migration', async () => {
    const missing = chain({
      data: null,
      error: {
        code: '42703',
        message: 'column test_folders.position does not exist',
      },
    });
    const legacy = chain({ data: [row('a', 'Alpha', null)], error: null });

    from.mockReturnValueOnce(missing).mockReturnValueOnce(legacy);

    const folders = await service.list(ORG, SPACE);

    expect(folders).toEqual([
      expect.objectContaining({ id: 'a', position: null }),
    ]);
    expect(missing.select).toHaveBeenCalledWith(
      expect.stringContaining('position'),
    );
    expect(legacy.select).toHaveBeenCalledWith(
      expect.not.stringContaining('position'),
    );
  });

  it('places a folder through tm_place_folder with the full sister order', async () => {
    rpc.mockResolvedValueOnce({ data: { changed: true }, error: null });
    from.mockReturnValueOnce(
      chain({
        data: { ...row(FOLDER, 'Old', 'parent-1'), position: 2 },
        error: null,
      }),
    );

    const folder = await service.update(user, SPACE, FOLDER, {
      parent_id: 'parent-1',
      sibling_order: ['other-1', FOLDER],
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('tm_place_folder', {
      p_organization_id: ORG,
      p_space_id: SPACE,
      p_actor_id: 'user-1',
      p_folder_id: FOLDER,
      p_parent_id: 'parent-1',
      p_order: ['other-1', FOLDER],
    });
    expect(folder.position).toBe(2);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('keeps the current parent when only the order is sent', async () => {
    from.mockReturnValueOnce(
      chain({ data: row(FOLDER, 'Old', 'parent-1'), error: null }),
    );
    rpc.mockResolvedValueOnce({ data: { changed: true }, error: null });

    await service.update(user, SPACE, FOLDER, { sibling_order: [FOLDER] });

    expect(rpc).toHaveBeenCalledWith(
      'tm_place_folder',
      expect.objectContaining({ p_parent_id: 'parent-1', p_order: [FOLDER] }),
    );
  });

  it('refuses a rename together with an order', async () => {
    await expect(
      service.update(user, SPACE, FOLDER, {
        name: 'New',
        sibling_order: [FOLDER],
      }),
    ).rejects.toThrow(BadRequestException);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('answers 409 ORDER_CONFLICT when the sister folders changed meanwhile', async () => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'TM014', message: 'tm: the folder order is out of date' },
    });

    const error = await service
      .update(user, SPACE, FOLDER, { parent_id: null, sibling_order: [FOLDER] })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toEqual(
      expect.objectContaining({ code: 'ORDER_CONFLICT' }),
    );
    expect(log).not.toHaveBeenCalled();
  });
});

describe('test folder order DTO', () => {
  const errors = (body: object) =>
    validateSync(plainToInstance(UpdateTestFolderDto, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    }).map((e) => e.property);

  const id = '3a77676c-1b5f-4d5e-9c39-1f2a3b4c5d6e';

  it('accepts a list of folder ids', () => {
    expect(errors({ sibling_order: [id] })).toEqual([]);
  });

  it.each([[[]], [['nope']], ['not-a-list']])(
    'rejects the order %j',
    (sibling_order) => {
      expect(errors({ sibling_order })).toEqual(['sibling_order']);
    },
  );
});
