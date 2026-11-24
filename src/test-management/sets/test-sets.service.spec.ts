import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  type HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';

import type { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import type { PermissionsService } from '../../permissions/permissions.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { TasksService } from '../../tasks/tasks.service';
import type { TestManagementAccessService } from '../access/test-management-access.service';
import { TestSetsService } from './test-sets.service';

const ORG = 'org-1';
const SPACE = 'space-1';
const SET = 'set-1';
const user = { userId: 'user-1', organizationId: ORG } as RequestUser;

interface Resolved {
  data: unknown;
  error: { code?: string; message: string; details?: string } | null;
  count?: number | null;
}

type Chain = Record<string, jest.Mock> & PromiseLike<Resolved>;

function buildChain(resolved: Resolved): Chain {
  const chain = {} as Chain;

  for (const name of [
    'select',
    'eq',
    'or',
    'in',
    'is',
    'limit',
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

describe('TestSetsService', () => {
  let service: TestSetsService;
  let from: jest.Mock;
  let rpc: jest.Mock;
  let log: jest.Mock;
  let emitAsync: jest.Mock;
  let tasks: { create: jest.Mock; delete: jest.Mock };
  let permissions: { checkPermission: jest.Mock };

  beforeEach(() => {
    from = jest.fn();
    rpc = jest.fn();
    log = jest.fn().mockResolvedValue(undefined);
    emitAsync = jest.fn().mockResolvedValue([]);
    tasks = {
      create: jest.fn().mockResolvedValue({ id: 'task-1', key: 'P-T1' }),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    permissions = { checkPermission: jest.fn().mockResolvedValue(true) };

    service = new TestSetsService(
      {
        getClient: () => ({ from, rpc }),
      } as unknown as SupabaseAdminService,
      {
        assertAvailable: jest.fn().mockResolvedValue(undefined),
      } as unknown as TestManagementAccessService,
      { logActionForRequest: log } as unknown as AuditLogsService,
      { emitAsync } as unknown as EventEmitter2,
      tasks as unknown as TasksService,
      permissions as unknown as PermissionsService,
    );
  });

  describe('list', () => {
    it('returns the page shape with member_count flattened', async () => {
      const chain = buildChain({
        data: [
          {
            id: 'a',
            task: { key: 'P-TS1', summary: 'Smoke', description: null },
            member_count: [{ count: 3 }],
          },
          {
            id: 'b',
            task: { key: 'P-TS2', summary: 'Full', description: '<p>All</p>' },
            member_count: [],
          },
        ],
        error: null,
        count: 2,
      });

      from.mockReturnValueOnce(chain);

      const result = await service.list(ORG, SPACE, { q: '50%' });

      expect(result).toEqual({
        items: [
          {
            id: 'a',
            key: 'P-TS1',
            key_number: 1,
            task_key: 'P-TS1',
            name: 'Smoke',
            description: null,
            member_count: 3,
          },
          {
            id: 'b',
            key: 'P-TS2',
            key_number: 2,
            task_key: 'P-TS2',
            name: 'Full',
            description: '<p>All</p>',
            member_count: 0,
          },
        ],
        total: 2,
        page: 1,
        pageSize: 50,
      });
      expect(firstArg(chain.select)).toContain(
        'member_count:test_set_members(count)',
      );
      expect(firstArg(chain.select)).toContain(
        'task:tasks!test_sets_task_id_fkey!inner(key, summary, description)',
      );
      expect(chain.or).toHaveBeenCalledWith(
        'key.ilike."%50\\\\%%",summary.ilike."%50\\\\%%"',
        { referencedTable: 'task' },
      );
      expect(chain.range).toHaveBeenCalledWith(0, 49);
    });

    it('also finds sets by their ticket key', async () => {
      const chain = buildChain({ data: [], error: null, count: 0 });

      from.mockReturnValueOnce(chain);

      await service.list(ORG, SPACE, { q: 'T9' });

      // The ticket is part of the list query, so no separate key lookup runs.
      expect(from).toHaveBeenCalledTimes(1);
      expect(chain.or).toHaveBeenCalledWith(
        'key.ilike."%T9%",summary.ilike."%T9%"',
        { referencedTable: 'task' },
      );
    });

    it.each([
      ['key:desc', 'created_at', false],
      ['name', 'task(summary)', true],
      ['unknown:desc', 'created_at', true],
    ])('sorts %s by %s', async (sort, column, ascending) => {
      const chain = buildChain({ data: [], error: null, count: 0 });

      from.mockReturnValueOnce(chain);

      await service.list(ORG, SPACE, { sort });

      expect(chain.order).toHaveBeenCalledWith(column, { ascending });
    });

    it('reads who last changed each set and passes it on', async () => {
      const updater = {
        id: 'user-2',
        first_name: 'Ada',
        last_name: 'Lee',
        email: 'ada@example.com',
        avatar_url: null,
      };
      const chain = buildChain({
        data: [
          {
            id: 'a',
            task: { key: 'P-TS1', summary: 'Smoke', description: null },
            member_count: [],
            updater,
          },
        ],
        error: null,
        count: 1,
      });

      from.mockReturnValueOnce(chain);

      const result = await service.list(ORG, SPACE, {});

      expect(firstArg(chain.select)).toContain(
        'updater:users!test_sets_updated_by_fkey(id, first_name, last_name, email, avatar_url)',
      );
      expect(result.items[0].updater).toEqual(updater);
    });

    it('narrows the list to the set of one ticket when taskId is given', async () => {
      const chain = buildChain({ data: [], error: null, count: 0 });

      from.mockReturnValueOnce(chain);

      await service.list(ORG, SPACE, { taskId: 'task-1' });

      expect(chain.eq).toHaveBeenCalledWith('task_id', 'task-1');
    });

    it('does not filter by ticket when taskId is absent', async () => {
      const chain = buildChain({ data: [], error: null, count: 0 });

      from.mockReturnValueOnce(chain);

      await service.list(ORG, SPACE, {});

      expect(chain.eq).not.toHaveBeenCalledWith('task_id', expect.anything());
    });

    it('lists only the sets directly in a folder when folderId is given', async () => {
      const chain = buildChain({ data: [], error: null, count: 0 });

      from.mockReturnValueOnce(chain);

      await service.list(ORG, SPACE, { folderId: 'folder-1' });

      expect(chain.eq).toHaveBeenCalledWith('folder_id', 'folder-1');
    });

    it('answers a page past the end with an empty page and the real total', async () => {
      from
        .mockReturnValueOnce(
          buildChain({
            data: null,
            error: { code: 'PGRST103', message: 'range' },
          }),
        )
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 7 }));

      const result = await service.list(ORG, SPACE, { page: 9, pageSize: 10 });

      expect(result).toEqual({ items: [], total: 7, page: 9, pageSize: 10 });
    });
  });

  describe('get', () => {
    it('reads the key, name and description from the ticket', async () => {
      from.mockReturnValueOnce(
        buildChain({
          data: {
            id: SET,
            task_id: 'task-1',
            task: { key: 'P-T7', summary: ' Smoke ', description: '<p></p>' },
            member_count: [{ count: 2 }],
          },
          error: null,
        }),
      );

      await expect(service.get(ORG, SPACE, SET)).resolves.toEqual({
        id: SET,
        task_id: 'task-1',
        key: 'P-T7',
        key_number: 7,
        task_key: 'P-T7',
        name: 'Smoke',
        description: null,
        member_count: 2,
      });
    });
  });

  describe('create', () => {
    const folderRow = () =>
      buildChain({ data: { id: 'folder-1' }, error: null });
    const settings = () =>
      buildChain({ data: { set_task_type_id: 'type-set' }, error: null });
    const newSet = () => buildChain({ data: { id: SET }, error: null });
    const loaded = () =>
      buildChain({
        data: {
          id: SET,
          folder_id: 'folder-1',
          task: { key: 'P-T1', summary: 'Smoke', description: '<p>All</p>' },
          member_count: [],
        },
        error: null,
      });

    it('makes the ticket first, then sets the folder', async () => {
      const update = buildChain({ data: null, error: null });
      const lookup = newSet();

      from
        .mockReturnValueOnce(folderRow())
        .mockReturnValueOnce(settings())
        .mockReturnValueOnce(lookup)
        .mockReturnValueOnce(update)
        .mockReturnValueOnce(loaded());

      const result = await service.create(user, SPACE, {
        name: 'Smoke',
        description: '<p>All</p>',
        folder_id: 'folder-1',
      });

      expect(from).toHaveBeenNthCalledWith(1, 'test_folders');
      expect(tasks.create).toHaveBeenCalledWith(
        ORG,
        'user-1',
        {
          summary: 'Smoke',
          description: '<p>All</p>',
          space_id: SPACE,
          task_type_id: 'type-set',
        },
        { testRightChecked: true },
      );
      expect(lookup.eq).toHaveBeenCalledWith('task_id', 'task-1');
      expect(firstArg(update.update)).toEqual({
        folder_id: 'folder-1',
        updated_by: 'user-1',
      });
      expect(result).toMatchObject({
        id: SET,
        key: 'P-T1',
        name: 'Smoke',
        member_count: 0,
      });
      expect(tasks.delete).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(user, 'test_set', SET, 'create', {
        key: 'P-T1',
        name: 'Smoke',
        space_id: SPACE,
      });
    });

    it('updates nothing when no folder is given', async () => {
      from
        .mockReturnValueOnce(settings())
        .mockReturnValueOnce(newSet())
        .mockReturnValueOnce(loaded());

      await service.create(user, SPACE, { name: 'Smoke' });

      expect(from).toHaveBeenCalledTimes(3);
    });

    it('makes no ticket when the folder is missing', async () => {
      from.mockReturnValueOnce(buildChain({ data: null, error: null }));

      await expect(
        service.create(user, SPACE, { name: 'Smoke', folder_id: 'folder-9' }),
      ).rejects.toThrow(NotFoundException);
      expect(tasks.create).not.toHaveBeenCalled();
    });

    it('refuses a user who cannot create tasks', async () => {
      permissions.checkPermission.mockResolvedValue(false);

      const error: unknown = await service
        .create(user, SPACE, { name: 'Smoke' })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: 'TICKET_CREATE_FORBIDDEN',
      });
      expect(tasks.create).not.toHaveBeenCalled();
    });

    it('refuses a space with no task type for test sets', async () => {
      from.mockReturnValueOnce(
        buildChain({ data: { case_task_type_id: 'type-case' }, error: null }),
      );

      const error: unknown = await service
        .create(user, SPACE, { name: 'Smoke' })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'TICKET_TYPE_MISSING',
      });
      expect(tasks.create).not.toHaveBeenCalled();
    });

    it('removes the ticket when the listener made no set', async () => {
      from
        .mockReturnValueOnce(settings())
        .mockReturnValueOnce(buildChain({ data: null, error: null }));

      const error: unknown = await service
        .create(user, SPACE, { name: 'Smoke' })
        .catch((e: unknown) => e);

      expect((error as HttpException).getResponse()).toMatchObject({
        code: 'RECORD_NOT_CREATED',
      });
      expect(tasks.delete).toHaveBeenCalledWith('task-1', ORG, 'user-1', {
        testRecordDeleted: true,
      });
      expect(log).not.toHaveBeenCalled();
    });

    it('removes the ticket when setting the folder fails', async () => {
      from
        .mockReturnValueOnce(folderRow())
        .mockReturnValueOnce(settings())
        .mockReturnValueOnce(newSet())
        .mockReturnValueOnce(
          buildChain({ data: null, error: { code: '23503', message: 'fk' } }),
        );

      await expect(
        service.create(user, SPACE, { name: 'Smoke', folder_id: 'folder-1' }),
      ).rejects.toThrow(NotFoundException);
      expect(tasks.delete).toHaveBeenCalledWith('task-1', ORG, 'user-1', {
        testRecordDeleted: true,
      });
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('rejects a body with nothing to change', async () => {
      await expect(service.update(user, SPACE, SET, {})).rejects.toThrow(
        BadRequestException,
      );
    });

    it('moves a set to the top level with a folder-only change', async () => {
      const chain = buildChain({
        data: {
          id: SET,
          task_id: 'task-1',
          folder_id: null,
          task: { key: 'S-1', summary: 'Set', description: null },
          member_count: [{ count: 0 }],
        },
        error: null,
      });

      from.mockReturnValueOnce(chain);

      await service.update(user, SPACE, SET, { folder_id: null });

      expect(firstArg(chain.update)).toEqual({
        folder_id: null,
        updated_by: user.userId,
      });
      expect(emitAsync).not.toHaveBeenCalled();
    });

    describe('fields held on the ticket', () => {
      const row = (summary: string, description: string | null) => ({
        data: {
          id: SET,
          task_id: 'task-1',
          task: { key: 'S-1', summary, description },
          member_count: [],
        },
        error: null,
      });

      it('sends a changed name and description to the ticket, then reloads', async () => {
        const chain = buildChain(row('Old', null));

        from
          .mockReturnValueOnce(chain)
          .mockReturnValueOnce(buildChain(row('New', '<p>Text</p>')));

        const result = await service.update(user, SPACE, SET, {
          name: 'New',
          description: '<p>Text</p>',
        });

        expect(firstArg(chain.update)).toEqual({ updated_by: user.userId });
        expect(chain.eq).toHaveBeenCalledWith('is_archived', false);
        expect(emitAsync).toHaveBeenCalledWith('tasks.test_record.updated', {
          organizationId: ORG,
          taskId: 'task-1',
          userId: 'user-1',
          changes: { summary: 'New', description: '<p>Text</p>' },
        });
        expect(result).toMatchObject({
          name: 'New',
          description: '<p>Text</p>',
        });
      });

      it('sends nothing when the ticket already holds the same values', async () => {
        from.mockReturnValueOnce(buildChain(row('Same', null)));

        const result = await service.update(user, SPACE, SET, {
          name: ' Same ',
          description: '<p></p>',
        });

        expect(emitAsync).not.toHaveBeenCalled();
        expect(from).toHaveBeenCalledTimes(1);
        expect(result.name).toBe('Same');
      });

      it('passes on a ticket refusal without another write', async () => {
        from.mockReturnValueOnce(buildChain(row('Old', null)));
        emitAsync.mockRejectedValue(new Error('refused'));

        await expect(
          service.update(user, SPACE, SET, { name: 'New' }),
        ).rejects.toThrow('refused');
        expect(from).toHaveBeenCalledTimes(1);
      });
    });

    it('answers a move into a missing folder with 404 naming the folder', async () => {
      from.mockReturnValueOnce(
        buildChain({ data: null, error: { code: '23503', message: 'fk' } }),
      );

      const error: unknown = await service
        .update(user, SPACE, SET, { folder_id: 'folder-9' })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).getResponse()).toMatchObject({
        data: { folder_id: 'folder-9' },
      });
    });

    it('returns 409 ARCHIVED for an archived set', async () => {
      from
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(buildChain({ data: { id: SET }, error: null }));

      const error: unknown = await service
        .update(user, SPACE, SET, { name: 'New' })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'ARCHIVED',
      });
      expect(log).not.toHaveBeenCalled();
    });

    it('returns 404 when the set is not in this space', async () => {
      from
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }));

      await expect(
        service.update(user, SPACE, SET, { description: null }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('members', () => {
    it('returns the key, title and assignee of each case from its ticket', async () => {
      const assignee = {
        id: 'user-2',
        first_name: 'Ada',
        last_name: 'Lee',
        email: 'ada@example.com',
        avatar_url: null,
      };
      const load = buildChain({ data: { id: SET }, error: null });
      const page = buildChain({
        data: [
          {
            id: 'c1',
            readiness: 'ready',
            test_type: 'manual',
            is_archived: false,
            task: { key: 'P-T7', summary: ' Login ', assignee },
            test_set_members: [{ set_id: SET }],
          },
          {
            id: 'c2',
            readiness: 'draft',
            test_type: 'manual',
            is_archived: false,
            task: { key: 'P-T8', summary: 'Logout', assignee: null },
            test_set_members: [{ set_id: SET }],
          },
        ],
        error: null,
        count: 2,
      });

      from.mockReturnValueOnce(load).mockReturnValueOnce(page);

      const result = await service.members(ORG, SPACE, SET, {});

      expect(firstArg(page.select)).toContain(
        'task:tasks!test_cases_task_id_fkey!inner(key, summary, assignee:users!tasks_assigned_to_fkey(',
      );
      expect(result.items).toEqual([
        {
          id: 'c1',
          key: 'P-T7',
          task_key: 'P-T7',
          title: 'Login',
          readiness: 'ready',
          test_type: 'manual',
          is_archived: false,
          assignee,
        },
        {
          id: 'c2',
          key: 'P-T8',
          task_key: 'P-T8',
          title: 'Logout',
          readiness: 'draft',
          test_type: 'manual',
          is_archived: false,
          assignee: null,
        },
      ]);
    });

    const membersPage = () => {
      const load = buildChain({ data: { id: SET }, error: null });
      const page = buildChain({ data: [], error: null, count: 0 });

      from.mockReturnValueOnce(load).mockReturnValueOnce(page);

      return page;
    };

    it('applies no filter and keeps the added order when none is sent', async () => {
      const page = membersPage();

      await service.members(ORG, SPACE, SET, {});

      expect(page.in).not.toHaveBeenCalled();
      expect(page.is).not.toHaveBeenCalled();
      expect(page.or).not.toHaveBeenCalled();
      expect(page.order).toHaveBeenNthCalledWith(1, 'created_at', {
        ascending: true,
      });
      expect(page.order).toHaveBeenNthCalledWith(2, 'id', { ascending: true });
    });

    it('filters by search, readiness, test type and assignee', async () => {
      const page = membersPage();

      await service.members(ORG, SPACE, SET, {
        q: 'log,in',
        readiness: ['ready'],
        testType: 'manual',
        assignee: 'user-2',
      });

      expect(page.in).toHaveBeenCalledWith('readiness', ['ready']);
      expect(page.eq).toHaveBeenCalledWith('test_type', 'manual');
      expect(page.eq).toHaveBeenCalledWith('task.assigned_to', 'user-2');
      expect(page.or).toHaveBeenCalledWith(
        'key.ilike."%log,in%",summary.ilike."%log,in%"',
        { referencedTable: 'task' },
      );
    });

    it('finds cases whose ticket has no assignee', async () => {
      const page = membersPage();

      await service.members(ORG, SPACE, SET, { assignee: 'unassigned' });

      expect(page.is).toHaveBeenCalledWith('task.assigned_to', null);
      expect(page.eq).not.toHaveBeenCalledWith(
        'task.assigned_to',
        expect.anything(),
      );
    });

    it.each([
      ['key', 'created_at', true],
      ['key:desc', 'created_at', false],
      ['title', 'task(summary)', true],
      ['title:desc', 'task(summary)', false],
      ['readiness', 'readiness', true],
      ['readiness:desc', 'readiness', false],
      ['test_type', 'test_type', true],
      ['test_type:desc', 'test_type', false],
    ])('sorts by %s', async (sort, column, ascending) => {
      const page = membersPage();

      await service.members(ORG, SPACE, SET, { sort });

      expect(page.order).toHaveBeenNthCalledWith(1, column, { ascending });
      expect(page.order).toHaveBeenNthCalledWith(2, 'id', { ascending: true });
    });

    it('counts a page past the end with the same filters, joining the ticket', async () => {
      const load = buildChain({ data: { id: SET }, error: null });
      const page = buildChain({
        data: null,
        error: { code: 'PGRST103', message: 'range' },
      });
      const count = buildChain({ data: null, error: null, count: 4 });

      from
        .mockReturnValueOnce(load)
        .mockReturnValueOnce(page)
        .mockReturnValueOnce(count);

      const result = await service.members(ORG, SPACE, SET, {
        page: 5,
        pageSize: 10,
        assignee: 'unassigned',
      });

      expect(firstArg(count.select)).toContain(
        'task:tasks!test_cases_task_id_fkey!inner(key, assigned_to)',
      );
      expect(count.is).toHaveBeenCalledWith('task.assigned_to', null);
      expect(result).toEqual({ items: [], total: 4, page: 5, pageSize: 10 });
    });
  });

  describe('remove', () => {
    const linkedSet = () =>
      buildChain({
        data: {
          task_id: 'task-1',
          task: { key: 'P-TS1', summary: ' Smoke ' },
        },
        error: null,
      });

    it('audits a delete scoped by org and space', async () => {
      const chain = linkedSet();

      from.mockReturnValueOnce(chain);

      await service.remove(user, SPACE, SET);

      expect(chain.eq).toHaveBeenCalledWith('space_id', SPACE);
      expect(chain.eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(log).toHaveBeenCalledWith(user, 'test_set', SET, 'delete', {
        space_id: SPACE,
        key: 'P-TS1',
        name: 'Smoke',
      });
    });

    it('asks the task module to delete the linked ticket', async () => {
      const chain = linkedSet();

      from.mockReturnValueOnce(chain);

      await service.remove(user, SPACE, SET);

      expect(emitAsync).toHaveBeenCalledTimes(1);
      expect(emitAsync).toHaveBeenCalledWith('tasks.test_record.deleted', {
        organizationId: ORG,
        taskId: 'task-1',
        userId: 'user-1',
      });
      // The database removes the set with its ticket.
      expect(from).toHaveBeenCalledTimes(1);
      expect(chain.delete).not.toHaveBeenCalled();
    });

    it('answers 404 and sends nothing for a set not in this space', async () => {
      from.mockReturnValueOnce(buildChain({ data: null, error: null }));

      await expect(service.remove(user, SPACE, SET)).rejects.toThrow(
        NotFoundException,
      );
      expect(emitAsync).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    });

    it('audits nothing when the ticket refuses the delete', async () => {
      from.mockReturnValueOnce(linkedSet());
      emitAsync.mockRejectedValue(new Error('refused'));

      await expect(service.remove(user, SPACE, SET)).rejects.toThrow('refused');
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('changeMembers', () => {
    const change = {
      changed: true,
      added: ['c1'],
      already_present: [],
      removed: [],
      skipped: [],
    };

    it('shows the ticket key the function reports in the skipped list', async () => {
      rpc.mockResolvedValueOnce({
        data: {
          ...change,
          skipped: [
            { case_id: 'c2', key: 'P-T9', reason: 'archived' },
            { case_id: 'c3', key: 'P-T10', reason: 'archived' },
          ],
        },
        error: null,
      });

      const result = await service.changeMembers(
        user,
        SPACE,
        SET,
        ['c2', 'c3'],
        'add',
      );

      expect(result.skipped.map((item) => item.key)).toEqual(['P-T9', 'P-T10']);
      expect(from).not.toHaveBeenCalled();
    });

    it('passes the ids as p_add_ids when adding', async () => {
      rpc.mockResolvedValueOnce({ data: change, error: null });

      const result = await service.changeMembers(
        user,
        SPACE,
        SET,
        ['c1'],
        'add',
      );

      expect(result).toEqual(change);
      expect(rpc).toHaveBeenCalledWith('tm_change_set_members', {
        p_organization_id: ORG,
        p_space_id: SPACE,
        p_actor_id: 'user-1',
        p_set_id: SET,
        p_add_ids: ['c1'],
        p_remove_ids: [],
      });
      expect(log).toHaveBeenCalledWith(user, 'test_set', SET, 'update', {
        space_id: SPACE,
        added: ['c1'],
        removed: [],
      });
    });

    it('passes the ids as p_remove_ids when removing', async () => {
      rpc.mockResolvedValueOnce({
        data: { ...change, changed: false, added: [] },
        error: null,
      });

      await service.changeMembers(user, SPACE, SET, ['c2'], 'remove');

      expect(rpc).toHaveBeenCalledWith(
        'tm_change_set_members',
        expect.objectContaining({ p_add_ids: [], p_remove_ids: ['c2'] }),
      );
      expect(log).not.toHaveBeenCalled();
    });

    it.each([
      ['P0002', NotFoundException, 'NOT_FOUND'],
      ['TM004', ConflictException, 'ARCHIVED'],
      ['TM013', BadRequestException, 'LIMIT_EXCEEDED'],
    ])('maps %s from the function', async (code, type, apiCode) => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: { code, message: 'tm: failed', details: null },
      });

      const error: unknown = await service
        .changeMembers(user, SPACE, SET, ['c1'], 'add')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(type);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: apiCode,
      });
    });
  });
});
