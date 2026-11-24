import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';

import type { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import type { PermissionsService } from '../../permissions/permissions.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { TasksService } from '../../tasks/tasks.service';
import {
  TEST_RECORD_DELETED_EVENT,
  TEST_RECORD_UPDATED_EVENT,
} from '../../tasks/test-ticket-events';
import type { TestManagementAccessService } from '../access/test-management-access.service';
import { containsPattern } from '../cases/test-cases.service';
import { TestPlansService } from './test-plans.service';

const ORG = 'org-1';
const SPACE = 'space-1';
const PLAN = 'plan-1';
const user = { userId: 'user-1', organizationId: ORG } as RequestUser;

interface Resolved {
  data: unknown;
  error: { code?: string; message: string } | null;
  count?: number | null;
}

type Chain = Record<string, jest.Mock> & PromiseLike<Resolved>;

function buildChain(resolved: Resolved): Chain {
  const chain = {} as Chain;

  for (const name of [
    'select',
    'eq',
    'neq',
    'or',
    'order',
    'range',
    'insert',
    'update',
    'delete',
  ]) {
    chain[name] = jest.fn(() => chain);
  }

  chain.single = jest.fn().mockResolvedValue(resolved);
  chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
  Object.assign(chain, {
    then: (onFulfilled: (value: Resolved) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled),
  });

  return chain;
}

function firstArg(mock: jest.Mock): unknown {
  return (mock.mock.calls as unknown[][])[0]?.[0];
}

function ticket(overrides: Record<string, unknown> = {}) {
  return {
    key: 'P-TP1',
    summary: 'Release',
    description: null,
    start_date: null,
    due_date: null,
    ...overrides,
  };
}

function planRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PLAN,
    task_id: 'task-1',
    is_archived: false,
    test_count: [{ count: 4 }],
    execution_count: [{ count: 2 }],
    task: ticket(),
    ...overrides,
  };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('Expected the call to fail');
}

function errorCode(error: unknown): unknown {
  return ((error as ConflictException).getResponse() as { code?: string }).code;
}

describe('TestPlansService', () => {
  let service: TestPlansService;
  let from: jest.Mock;
  let assertAvailable: jest.Mock;
  let log: jest.Mock;
  let emitAsync: jest.Mock;
  let createTask: jest.Mock;
  let deleteTask: jest.Mock;
  let checkPermission: jest.Mock;

  const next = (resolved: Resolved) => {
    const chain = buildChain(resolved);

    from.mockReturnValueOnce(chain);

    return chain;
  };

  beforeEach(() => {
    from = jest.fn();
    assertAvailable = jest.fn().mockResolvedValue(undefined);
    log = jest.fn().mockResolvedValue(undefined);
    emitAsync = jest.fn().mockResolvedValue([]);
    createTask = jest.fn().mockResolvedValue({ id: 'task-1', key: 'P-TP1' });
    deleteTask = jest.fn().mockResolvedValue(undefined);
    checkPermission = jest.fn().mockResolvedValue(true);

    service = new TestPlansService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      { assertAvailable } as unknown as TestManagementAccessService,
      { logActionForRequest: log } as unknown as AuditLogsService,
      { emitAsync } as unknown as EventEmitter2,
      { create: createTask, delete: deleteTask } as unknown as TasksService,
      { checkPermission } as unknown as PermissionsService,
    );
  });

  describe('list', () => {
    it('shows the key of the linked ticket', async () => {
      const chain = next({
        data: [planRow({ task: ticket({ key: 'NEWSPACE-T9' }) })],
        error: null,
        count: 1,
      });

      const page = await service.list(ORG, SPACE, {});

      expect(firstArg(chain.select)).toContain(
        'task:tasks!test_plans_task_id_fkey!inner(key, summary, description, start_date, due_date)',
      );
      expect(page.items[0]).toMatchObject({ task_key: 'NEWSPACE-T9' });
      expect(page.items[0]).not.toHaveProperty('task');
    });

    it('reads who last changed each plan and passes it on', async () => {
      const updater = {
        id: 'user-2',
        first_name: 'Ada',
        last_name: 'Lee',
        email: 'ada@example.com',
        avatar_url: null,
      };
      const chain = next({
        data: [planRow({ updater })],
        error: null,
        count: 1,
      });

      const page = await service.list(ORG, SPACE, {});

      expect(firstArg(chain.select)).toContain(
        'updater:users!test_plans_updated_by_fkey(id, first_name, last_name, email, avatar_url)',
      );
      expect(page.items[0].updater).toEqual(updater);
    });

    it('lists only the plan of a ticket when asked', async () => {
      const chain = next({ data: [planRow()], error: null, count: 1 });

      await service.list(ORG, SPACE, { taskId: 'task-1' });

      expect(chain.eq).toHaveBeenCalledWith('task_id', 'task-1');
    });

    it('lists only the plans directly in a folder when asked', async () => {
      const chain = next({ data: [planRow()], error: null, count: 1 });

      await service.list(ORG, SPACE, { folderId: 'folder-1' });

      expect(chain.eq).toHaveBeenCalledWith('folder_id', 'folder-1');
    });

    it('returns the page with counts flattened, oldest first by default', async () => {
      const chain = next({
        data: [
          planRow(),
          planRow({ id: 'plan-2', test_count: [], execution_count: null }),
        ],
        error: null,
        count: 2,
      });

      const page = await service.list(ORG, SPACE, {});

      expect(page.total).toBe(2);
      expect(page.page).toBe(1);
      expect(page.pageSize).toBe(50);
      expect(page.items.map((p) => [p.test_count, p.execution_count])).toEqual([
        [4, 2],
        [0, 0],
      ]);
      expect(chain.eq).toHaveBeenCalledWith('is_archived', false);
      expect(chain.order).toHaveBeenCalledWith('created_at', {
        ascending: true,
        nullsFirst: false,
      });
      expect(chain.range).toHaveBeenCalledWith(0, 49);
      expect(assertAvailable).toHaveBeenCalledWith(ORG, SPACE);
    });

    it('sorts by a known field and breaks ties on created_at and id', async () => {
      const chain = next({ data: [], error: null, count: 0 });

      await service.list(ORG, SPACE, {
        sort: 'end_date:desc',
        page: 2,
        pageSize: 10,
      });

      expect(chain.order).toHaveBeenNthCalledWith(1, 'task(due_date)', {
        ascending: false,
        nullsFirst: false,
      });
      expect(chain.order).toHaveBeenNthCalledWith(2, 'created_at', {
        ascending: true,
      });
      expect(chain.order).toHaveBeenNthCalledWith(3, 'id', { ascending: true });
      expect(chain.range).toHaveBeenCalledWith(10, 19);
    });

    it.each([
      ['name', 'task(summary)'],
      ['start_date', 'task(start_date)'],
      ['updated_at', 'updated_at'],
    ])('sorts %s by %s', async (field, column) => {
      const chain = next({ data: [], error: null, count: 0 });

      await service.list(ORG, SPACE, { sort: `${field}:asc` });

      expect(chain.order).toHaveBeenNthCalledWith(1, column, {
        ascending: true,
        nullsFirst: false,
      });
    });

    it('sorts the key by creation time, as ticket keys are text', async () => {
      const chain = next({ data: [], error: null, count: 0 });

      await service.list(ORG, SPACE, { sort: 'key:desc' });

      expect(chain.order).toHaveBeenCalledTimes(2);
      expect(chain.order).toHaveBeenNthCalledWith(1, 'created_at', {
        ascending: false,
        nullsFirst: false,
      });
      expect(chain.order).toHaveBeenNthCalledWith(2, 'id', { ascending: true });
    });

    it('falls back to creation order for an unknown sort field', async () => {
      const chain = next({ data: [], error: null, count: 0 });

      await service.list(ORG, SPACE, { sort: 'created_by:desc' });

      expect(chain.order).toHaveBeenCalledTimes(2);
      expect(chain.order).toHaveBeenNthCalledWith(1, 'created_at', {
        ascending: true,
        nullsFirst: false,
      });
      expect(chain.order).toHaveBeenNthCalledWith(2, 'id', { ascending: true });
    });

    it('searches key and name and lists archived plans when asked', async () => {
      const chain = next({ data: [], error: null, count: 0 });

      await service.list(ORG, SPACE, { q: '50%', archived: true });

      expect(chain.eq).toHaveBeenCalledWith('is_archived', true);
      const search = containsPattern('50%');

      expect(chain.or).toHaveBeenCalledWith(
        `key.ilike.${search},summary.ilike.${search}`,
        { referencedTable: 'task' },
      );
      expect(from).toHaveBeenCalledTimes(1);
    });

    it('answers a page past the end with an empty page and the real total', async () => {
      next({ data: null, error: { code: 'PGRST103', message: 'range' } });
      const countChain = next({ data: null, error: null, count: 7 });

      await expect(
        service.list(ORG, SPACE, { page: 5, pageSize: 10 }),
      ).resolves.toEqual({ items: [], total: 7, page: 5, pageSize: 10 });
      expect(countChain.select).toHaveBeenCalledWith(
        'id, task:tasks!test_plans_task_id_fkey!inner(key)',
        { count: 'exact', head: true },
      );
    });
  });

  describe('get', () => {
    it('returns the plan with its counts', async () => {
      next({ data: planRow(), error: null });

      await expect(service.get(ORG, SPACE, PLAN)).resolves.toMatchObject({
        id: PLAN,
        test_count: 4,
        execution_count: 2,
      });
    });

    it('answers a missing or foreign plan with 404', async () => {
      const chain = next({ data: null, error: null });

      await expect(service.get(ORG, SPACE, PLAN)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(chain.eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(chain.eq).toHaveBeenCalledWith('space_id', SPACE);
    });

    it('returns the key of the plan ticket flat', async () => {
      next({
        data: planRow({ task: ticket({ key: 'PRJ-7' }) }),
        error: null,
      });

      const plan = await service.get(ORG, SPACE, PLAN);

      expect(plan).toMatchObject({ id: PLAN, task_key: 'PRJ-7' });
      expect(plan).not.toHaveProperty('task');
    });

    it('reads the key, name, description and dates from the ticket', async () => {
      next({
        data: planRow({
          task: {
            key: 'NEWSPACE-T12',
            summary: ' Release ',
            description: '<p>Scope</p>',
            start_date: '2026-10-27T00:00:00.000Z',
            // Midnight saved from another time zone still shows its own day.
            due_date: '2026-10-30T22:00:00.000Z',
          },
        }),
        error: null,
      });

      await expect(service.get(ORG, SPACE, PLAN)).resolves.toMatchObject({
        key: 'NEWSPACE-T12',
        key_number: 12,
        task_key: 'NEWSPACE-T12',
        name: 'Release',
        description: '<p>Scope</p>',
        start_date: '2026-10-27',
        end_date: '2026-10-31',
      });
    });

    it.each([[null], [''], ['   '], ['<p></p>']])(
      'shows no description for a ticket holding %j, and no dates when it has none',
      async (description) => {
        next({
          data: planRow({ task: ticket({ description }) }),
          error: null,
        });

        await expect(service.get(ORG, SPACE, PLAN)).resolves.toMatchObject({
          description: null,
          start_date: null,
          end_date: null,
        });
      },
    );
  });

  describe('create', () => {
    const settings = { data: { plan_task_type_id: 'type-plan' }, error: null };
    const created = { data: { id: PLAN }, error: null };

    it('makes the ticket first, finds the plan by it and logs it', async () => {
      const settingsChain = next(settings);
      const createdChain = next(created);

      next({ data: planRow(), error: null });

      const plan = await service.create(user, SPACE, { name: 'Release' });

      expect(assertAvailable).toHaveBeenCalledWith(ORG, SPACE, { write: true });
      expect(checkPermission).toHaveBeenCalledWith(
        'user-1',
        ORG,
        'can_create_tasks',
      );
      expect(from).toHaveBeenNthCalledWith(1, 'test_management_space_settings');
      expect(settingsChain.eq).toHaveBeenCalledWith('space_id', SPACE);
      expect(createTask).toHaveBeenCalledWith(
        ORG,
        'user-1',
        {
          summary: 'Release',
          space_id: SPACE,
          task_type_id: 'type-plan',
        },
        { testRightChecked: true },
      );
      expect(createTask.mock.invocationCallOrder[0]).toBeLessThan(
        createdChain.maybeSingle.mock.invocationCallOrder[0],
      );
      expect(from).toHaveBeenNthCalledWith(2, 'test_plans');
      expect(createdChain.eq).toHaveBeenCalledWith('task_id', 'task-1');
      expect(createdChain.eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(createdChain.update).not.toHaveBeenCalled();
      expect(plan).toMatchObject({ id: PLAN, key: 'P-TP1', name: 'Release' });
      expect(deleteTask).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(user, 'test_plan', PLAN, 'create', {
        key: 'P-TP1',
        name: 'Release',
        space_id: SPACE,
      });
    });

    it('gives the ticket the description as paragraphs and the dates as midnight', async () => {
      next(settings);
      next(created);
      next({ data: planRow(), error: null });

      await service.create(user, SPACE, {
        name: 'Release',
        description: 'Scope <A>',
        start_date: '2026-10-27',
        end_date: '2026-10-31',
      });

      expect(createTask).toHaveBeenCalledWith(
        ORG,
        'user-1',
        {
          summary: 'Release',
          description: '<p>Scope &lt;A&gt;</p>',
          start_date: '2026-10-27T00:00:00.000Z',
          due_date: '2026-10-31T00:00:00.000Z',
          space_id: SPACE,
          task_type_id: 'type-plan',
        },
        { testRightChecked: true },
      );
    });

    it('checks the folder first and sets it on the new plan', async () => {
      const folderChain = next({ data: { id: 'folder-1' }, error: null });

      next(settings);
      next(created);
      const moveChain = next({ data: null, error: null });

      next({ data: planRow({ folder_id: 'folder-1' }), error: null });

      const plan = await service.create(user, SPACE, {
        name: 'Release',
        folder_id: 'folder-1',
      });

      expect(from).toHaveBeenNthCalledWith(1, 'test_folders');
      expect(folderChain.eq).toHaveBeenCalledWith('id', 'folder-1');
      expect(folderChain.eq).toHaveBeenCalledWith('space_id', SPACE);
      expect(folderChain.eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(firstArg(moveChain.update)).toEqual({
        folder_id: 'folder-1',
        updated_by: 'user-1',
      });
      expect(moveChain.eq).toHaveBeenCalledWith('id', PLAN);
      expect(moveChain.eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(plan.folder_id).toBe('folder-1');
    });

    it('answers a missing folder with 404 and makes no ticket', async () => {
      next({ data: null, error: null });

      const error = await caught(
        service.create(user, SPACE, { name: 'Release', folder_id: 'folder-9' }),
      );

      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).getResponse()).toMatchObject({
        data: { folder_id: 'folder-9' },
      });
      expect(checkPermission).not.toHaveBeenCalled();
      expect(createTask).not.toHaveBeenCalled();
    });

    it('answers a user who cannot create tasks with 403 TICKET_CREATE_FORBIDDEN', async () => {
      checkPermission.mockResolvedValueOnce(false);

      const error = await caught(
        service.create(user, SPACE, { name: 'Release' }),
      );

      expect(error).toBeInstanceOf(ForbiddenException);
      expect(errorCode(error)).toBe('TICKET_CREATE_FORBIDDEN');
      expect(from).not.toHaveBeenCalled();
      expect(createTask).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    });

    it('answers a space with no plan task type with 400 TICKET_TYPE_MISSING', async () => {
      next({ data: { plan_task_type_id: null }, error: null });

      const error = await caught(
        service.create(user, SPACE, { name: 'Release' }),
      );

      expect(error).toBeInstanceOf(BadRequestException);
      expect(errorCode(error)).toBe('TICKET_TYPE_MISSING');
      expect(createTask).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    });

    it('passes on a failed ticket create with nothing to clean up', async () => {
      const failed = new BadRequestException('no');

      next(settings);
      createTask.mockRejectedValueOnce(failed);

      await expect(
        service.create(user, SPACE, { name: 'Release' }),
      ).rejects.toBe(failed);
      expect(deleteTask).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    });

    it('removes the ticket when the listener made no plan', async () => {
      next(settings);
      next({ data: null, error: null });

      const error = await caught(
        service.create(user, SPACE, { name: 'Release' }),
      );

      expect(errorCode(error)).toBe('RECORD_NOT_CREATED');
      expect(deleteTask).toHaveBeenCalledWith('task-1', ORG, 'user-1', {
        testRecordDeleted: true,
      });
      expect(log).not.toHaveBeenCalled();
    });

    it('removes the ticket when setting the folder fails', async () => {
      next({ data: { id: 'folder-1' }, error: null });
      next(settings);
      next(created);
      next({ data: null, error: { code: '23503', message: 'fk' } });

      const error = await caught(
        service.create(user, SPACE, { name: 'Release', folder_id: 'folder-1' }),
      );

      expect(error).toBeInstanceOf(NotFoundException);
      expect(deleteTask).toHaveBeenCalledWith('task-1', ORG, 'user-1', {
        testRecordDeleted: true,
      });
      expect(log).not.toHaveBeenCalled();
    });

    it('keeps the first error when the ticket cannot be removed either', async () => {
      next(settings);
      next({ data: null, error: null });
      deleteTask.mockRejectedValueOnce(new Error('gone'));

      const error = await caught(
        service.create(user, SPACE, { name: 'Release' }),
      );

      expect(errorCode(error)).toBe('RECORD_NOT_CREATED');
    });
  });

  describe('update', () => {
    it('refuses an empty change before any check or query', async () => {
      await expect(
        service.update(user, SPACE, PLAN, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(assertAvailable).not.toHaveBeenCalled();
      expect(from).not.toHaveBeenCalled();
    });

    it('writes only the updater on an active plan, sends the fields to the ticket and logs them', async () => {
      const chain = next({
        data: planRow({
          task: ticket({ due_date: '2026-10-31T00:00:00.000Z' }),
        }),
        error: null,
      });

      next({
        data: planRow({ task: ticket({ summary: 'Renamed' }) }),
        error: null,
      });

      const plan = await service.update(user, SPACE, PLAN, {
        name: 'Renamed',
        end_date: null,
      });

      expect(firstArg(chain.update)).toEqual({ updated_by: 'user-1' });
      expect(chain.eq).toHaveBeenCalledWith('is_archived', false);
      expect(emitAsync).toHaveBeenCalledWith(TEST_RECORD_UPDATED_EVENT, {
        organizationId: ORG,
        taskId: 'task-1',
        userId: 'user-1',
        changes: { summary: 'Renamed', dueDate: null },
      });
      expect(plan.name).toBe('Renamed');
      expect(log).toHaveBeenCalledWith(user, 'test_plan', PLAN, 'update', {
        space_id: SPACE,
        changes: { name: 'Renamed', end_date: null },
      });
    });

    it('moves a plan to another folder with a folder-only change', async () => {
      const chain = next({
        data: planRow({ folder_id: 'folder-2' }),
        error: null,
      });

      const plan = await service.update(user, SPACE, PLAN, {
        folder_id: 'folder-2',
      });

      expect(firstArg(chain.update)).toEqual({
        folder_id: 'folder-2',
        updated_by: 'user-1',
      });
      expect(plan.folder_id).toBe('folder-2');
      expect(emitAsync).not.toHaveBeenCalled();
    });

    it('answers a move into a missing folder with 404 naming the folder', async () => {
      next({ data: null, error: { code: '23503', message: 'fk' } });

      const error = await caught(
        service.update(user, SPACE, PLAN, { folder_id: 'folder-9' }),
      );

      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).getResponse()).toMatchObject({
        code: 'NOT_FOUND',
        data: { folder_id: 'folder-9' },
      });
    });

    it('answers an archived plan with 409 ARCHIVED', async () => {
      next({ data: null, error: null });
      next({ data: { id: PLAN }, error: null });

      const error = await caught(
        service.update(user, SPACE, PLAN, { name: 'Renamed' }),
      );

      expect(errorCode(error)).toBe('ARCHIVED');
      expect(emitAsync).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    });

    it('answers a missing plan with 404', async () => {
      next({ data: null, error: null });
      next({ data: null, error: null });

      await expect(
        service.update(user, SPACE, PLAN, { name: 'Renamed' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('answers an end date before the start date with the ticket refusal and writes nothing back', async () => {
      const refused = new BadRequestException({
        code: 'TEST_DATES_ORDER',
        message: 'dates',
      });

      next({
        data: planRow({
          task: ticket({ start_date: '2026-10-27T00:00:00.000Z' }),
        }),
        error: null,
      });
      emitAsync.mockRejectedValueOnce(refused);

      await expect(
        service.update(user, SPACE, PLAN, { end_date: '2020-01-01' }),
      ).rejects.toBe(refused);
      expect(from).toHaveBeenCalledTimes(1);
    });

    it('logs nothing when the ticket refuses the change', async () => {
      next({ data: planRow(), error: null });
      emitAsync.mockRejectedValueOnce(new ForbiddenException('no'));

      await caught(service.update(user, SPACE, PLAN, { name: 'Renamed' }));

      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('setArchived', () => {
    it('archives an active plan and logs it', async () => {
      const chain = next({ data: planRow({ is_archived: true }), error: null });

      await service.setArchived(user, SPACE, PLAN, true);

      expect(firstArg(chain.update)).toMatchObject({
        is_archived: true,
        archived_by: 'user-1',
        updated_by: 'user-1',
      });
      expect(chain.eq).toHaveBeenCalledWith('is_archived', false);
      expect(log).toHaveBeenCalledWith(user, 'test_plan', PLAN, 'archive', {
        space_id: SPACE,
      });
    });

    it('restores and clears the archive fields', async () => {
      const chain = next({ data: planRow(), error: null });

      await service.setArchived(user, SPACE, PLAN, false);

      expect(firstArg(chain.update)).toEqual({
        is_archived: false,
        archived_at: null,
        archived_by: null,
        updated_by: 'user-1',
      });
      expect(chain.eq).toHaveBeenCalledWith('is_archived', true);
    });

    it('returns the plan unchanged when it is already in that state', async () => {
      next({ data: null, error: null });
      next({ data: planRow({ is_archived: true }), error: null });

      await expect(
        service.setArchived(user, SPACE, PLAN, true),
      ).resolves.toMatchObject({ id: PLAN, is_archived: true });
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('deletes the plan and reports how many executions were detached', async () => {
      const countChain = next({ data: null, error: null, count: 3 });
      next({ data: null, error: null, count: 0 });
      const readChain = next({ data: planRow(), error: null });

      await expect(service.remove(user, SPACE, PLAN)).resolves.toEqual({
        executions_detached: 3,
      });
      expect(from).toHaveBeenNthCalledWith(1, 'test_executions');
      expect(countChain.eq).toHaveBeenCalledWith('plan_id', PLAN);
      expect(readChain.delete).not.toHaveBeenCalled();
      expect(emitAsync).toHaveBeenCalledWith(TEST_RECORD_DELETED_EVENT, {
        organizationId: ORG,
        taskId: 'task-1',
        userId: 'user-1',
      });
      expect(log).toHaveBeenCalledWith(user, 'test_plan', PLAN, 'delete', {
        space_id: SPACE,
        key: 'P-TP1',
        name: 'Release',
        executions_detached: 3,
      });
    });

    it('answers a missing plan with 404 and logs nothing', async () => {
      next({ data: null, error: null, count: 0 });
      next({ data: null, error: null });

      await expect(service.remove(user, SPACE, PLAN)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(emitAsync).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('linked tickets and run results', () => {
    it('refuses to delete a plan whose executions have results', async () => {
      const countChain = next({ data: null, error: null, count: 2 });
      const resultsChain = next({ data: null, error: null, count: 5 });

      const error = await caught(service.remove(user, SPACE, PLAN));

      expect(errorCode(error)).toBe('HAS_RESULTS');
      expect(
        (
          (error as ConflictException).getResponse() as {
            data?: { results?: number };
          }
        ).data?.results,
      ).toBe(5);
      expect(from).toHaveBeenNthCalledWith(2, 'test_run_attempts');
      expect(resultsChain.neq).toHaveBeenCalledWith('status', 'TODO');
      expect(resultsChain.eq).toHaveBeenCalledWith(
        'run.execution.plan_id',
        PLAN,
      );
      expect(countChain.delete).not.toHaveBeenCalled();
      expect(resultsChain.delete).not.toHaveBeenCalled();
      expect(from).toHaveBeenCalledTimes(2);
      expect(emitAsync).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    });

    it('deletes a plan whose executions have no results through its ticket', async () => {
      next({ data: null, error: null, count: 1 });
      next({ data: null, error: null, count: 0 });
      const readChain = next({ data: planRow(), error: null });

      await expect(service.remove(user, SPACE, PLAN)).resolves.toEqual({
        executions_detached: 1,
      });
      expect(readChain.delete).not.toHaveBeenCalled();
      expect(emitAsync).toHaveBeenCalledTimes(1);
    });

    it('deletes a linked plan together with its ticket', async () => {
      next({ data: null, error: null, count: 0 });
      const readChain = next({ data: planRow(), error: null });

      await expect(service.remove(user, SPACE, PLAN)).resolves.toEqual({
        executions_detached: 0,
      });
      expect(firstArg(readChain.select)).toContain(
        'task:tasks!test_plans_task_id_fkey!inner(',
      );
      expect(readChain.eq).toHaveBeenCalledWith('id', PLAN);
      expect(emitAsync).toHaveBeenCalledTimes(1);
      expect(emitAsync).toHaveBeenCalledWith(TEST_RECORD_DELETED_EVENT, {
        organizationId: ORG,
        taskId: 'task-1',
        userId: 'user-1',
      });
      expect(from).toHaveBeenCalledTimes(2);
      expect(readChain.delete).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(user, 'test_plan', PLAN, 'delete', {
        space_id: SPACE,
        key: 'P-TP1',
        name: 'Release',
        executions_detached: 0,
      });
    });

    it('keeps a linked plan when its ticket delete is refused', async () => {
      const refused = new ForbiddenException('no');

      next({ data: null, error: null, count: 0 });
      next({ data: { task_id: 'task-1' }, error: null });
      emitAsync.mockRejectedValueOnce(refused);

      await expect(service.remove(user, SPACE, PLAN)).rejects.toBe(refused);
      expect(from).toHaveBeenCalledTimes(2);
      expect(from).toHaveBeenNthCalledWith(1, 'test_executions');
      expect(from).toHaveBeenNthCalledWith(2, 'test_plans');
      expect(log).not.toHaveBeenCalled();
    });

    it('sends the new name of a linked plan to its ticket', async () => {
      const updateChain = next({
        data: planRow({ task: ticket({ summary: 'Old' }) }),
        error: null,
      });
      const reloadChain = next({
        data: planRow({ task: ticket({ summary: 'New' }) }),
        error: null,
      });

      const plan = await service.update(user, SPACE, PLAN, { name: 'New' });

      expect(firstArg(updateChain.update)).toEqual({ updated_by: 'user-1' });
      expect(emitAsync).toHaveBeenCalledWith(TEST_RECORD_UPDATED_EVENT, {
        organizationId: ORG,
        taskId: 'task-1',
        userId: 'user-1',
        changes: { summary: 'New' },
      });
      expect(emitAsync.mock.invocationCallOrder[0]).toBeLessThan(
        reloadChain.maybeSingle.mock.invocationCallOrder[0],
      );
      expect(plan.name).toBe('New');
      expect(log).toHaveBeenCalled();
    });

    it('sends a new end date of a linked plan to its ticket due date', async () => {
      next({
        data: planRow({
          task: ticket({
            start_date: '2026-10-27T00:00:00.000Z',
            due_date: '2026-10-31T00:00:00.000Z',
          }),
        }),
        error: null,
      });
      next({ data: planRow(), error: null });

      await service.update(user, SPACE, PLAN, { end_date: '2026-11-02' });

      expect(emitAsync).toHaveBeenCalledWith(TEST_RECORD_UPDATED_EVENT, {
        organizationId: ORG,
        taskId: 'task-1',
        userId: 'user-1',
        changes: { dueDate: '2026-11-02T00:00:00.000Z' },
      });
    });

    it('sends a new description of a linked plan to its ticket as paragraphs', async () => {
      next({
        data: planRow({ task: ticket({ description: '<p>Old</p>' }) }),
        error: null,
      });
      next({ data: planRow(), error: null });

      await service.update(user, SPACE, PLAN, {
        description: 'Scope <A> & B\nRisks',
      });

      expect(emitAsync).toHaveBeenCalledWith(TEST_RECORD_UPDATED_EVENT, {
        organizationId: ORG,
        taskId: 'task-1',
        userId: 'user-1',
        changes: {
          description: '<p>Scope &lt;A&gt; &amp; B</p><p>Risks</p>',
        },
      });
    });

    it('sends nothing when the name is unchanged', async () => {
      next({ data: planRow(), error: null });

      await service.update(user, SPACE, PLAN, { name: ' Release ' });

      expect(from).toHaveBeenCalledTimes(1);
      expect(emitAsync).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledTimes(1);
    });

    it('sends nothing for an empty description and unchanged dates', async () => {
      next({
        data: planRow({
          task: ticket({
            description: '<p></p>',
            start_date: '2026-10-27T00:00:00.000Z',
          }),
        }),
        error: null,
      });

      await service.update(user, SPACE, PLAN, {
        description: '',
        start_date: '2026-10-27',
        end_date: null,
      });

      expect(from).toHaveBeenCalledTimes(1);
      expect(emitAsync).not.toHaveBeenCalled();
    });
  });

  describe('list by planned tester', () => {
    const TESTER = 'user-9';

    it('filters plans by planned tester in the same query', async () => {
      const plans = next({ data: [planRow()], error: null, count: 1 });

      const page = await service.list(ORG, SPACE, { testerId: TESTER });

      expect(from).toHaveBeenCalledTimes(1);
      expect(from).toHaveBeenCalledWith('test_plans');
      expect(firstArg(plans.select)).toContain(
        ', matched:test_plan_tests!test_plan_tests_plan_fkey!inner()',
      );
      expect(plans.eq).toHaveBeenCalledWith(
        'matched.planned_tester_id',
        TESTER,
      );
      expect(page.total).toBe(1);
    });

    it('filters plans by test type through the planned tests', async () => {
      const plans = next({ data: [planRow()], error: null, count: 1 });

      await service.list(ORG, SPACE, { testType: 'cucumber' });

      expect(firstArg(plans.select)).toContain(
        ', matched:test_plan_tests!test_plan_tests_plan_fkey!inner(test:test_cases!test_plan_tests_case_fkey!inner())',
      );
      expect(plans.eq).toHaveBeenCalledWith(
        'matched.test.test_type',
        'cucumber',
      );
      expect(plans.eq).not.toHaveBeenCalledWith(
        'matched.planned_tester_id',
        expect.anything(),
      );
    });

    it('matches tester and test type on the same planned test', async () => {
      const plans = next({ data: [], error: null, count: 0 });

      const page = await service.list(ORG, SPACE, {
        testerId: TESTER,
        testType: 'manual',
      });

      expect(plans.eq).toHaveBeenCalledWith(
        'matched.planned_tester_id',
        TESTER,
      );
      expect(plans.eq).toHaveBeenCalledWith('matched.test.test_type', 'manual');
      expect(page.total).toBe(0);
    });

    it('does not join planned tests when no filter is given', async () => {
      const plans = next({ data: [], error: null, count: 0 });

      await service.list(ORG, SPACE, {});

      expect(from).toHaveBeenCalledTimes(1);
      expect(from).toHaveBeenCalledWith('test_plans');
      expect(firstArg(plans.select)).not.toContain('matched');
    });
  });
});
