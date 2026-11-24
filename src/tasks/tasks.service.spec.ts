/**
 * @fileoverview Unit tests for TasksService — core CRUD, key generation,
 * parent validation, status transitions, cascade delete, comments,
 * relationships, hierarchy navigation.
 * @module src/tasks/tasks.service.spec
 * @author Prince Jadiya
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

// Identity-ish stub (jsdom is heavy and the real allow-list is covered by
// common/utils/sanitize-rich-text.spec.ts). It is a jest.fn so this suite can assert the POLICY
// each call site asks for — which is the part TasksService actually owns.
jest.mock('../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: jest.fn(
    (value: string | null | undefined) =>
      value?.replace(/<script[\s\S]*?<\/script>/gi, '') ?? null,
  ),
}));

import { sanitizeRichText } from '../common/utils/sanitize-rich-text';
import { checkTestTicketFields } from './test-ticket-events';
import { TasksService } from './tasks.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('TasksService', () => {
  let service: TasksService;
  let mockFrom: jest.Mock;
  let mockRpc: jest.Mock;
  let storageRemove: jest.Mock;
  let mockTaskHierarchyConfig: {
    getTypeById: jest.Mock;
  };

  const ORG = 'org-1';
  const SPACE = 'space-1';

  const mockTask = {
    id: 'task-1',
    organization_id: ORG,
    space_id: SPACE,
    process_id: null,
    parent_task_id: null,
    task_type_id: 'task',
    key: 'S1-T1',
    summary: 'Fix login bug',
    description: null,
    status: 'open',
    status_id: null,
    priority: 'medium',
    priority_id: null,
    resolution_id: null,
    resolved_at: null,
    due_date: null,
    start_date: null,
    end_date: null,
    completed_at: null,
    assigned_to: null,
    reporter: null,
    estimated_time: null,
    actual_time: null,
    duration: null,
    progress: 0,
    estimated_cost: null,
    actual_cost: null,
    custom_field_values: {},
    labels: [],
    sort_order: 0,
    created_by: null,
    updated_by: null,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };

  const defaultTaskType = {
    id: 'task',
    name: 'Task',
    name_i18n: {},
    description: null,
    description_i18n: {},
    icon: null,
    color: '#6B7280',
    text_color: '#FFFFFF',
    parent_level_id: null,
    allowed_parent_types: [],
    allowed_child_types: [],
    max_depth: 10,
    default_status: 'open',
    default_priority: 'medium',
    field_group_ids: [],
    allowed_statuses: [
      'open',
      'in_progress',
      'review',
      'done',
      'closed',
      'blocked',
    ],
    sort_order: 0,
    is_active: true,
  };

  function buildChain(resolved: {
    data: unknown;
    error: unknown;
    count?: number;
  }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.neq = jest.fn().mockImplementation(self);
    chain.is = jest.fn().mockImplementation(self);
    chain.in = jest.fn().mockImplementation(self);
    chain.or = jest.fn().mockImplementation(self);
    chain.ilike = jest.fn().mockImplementation(self);
    chain.gte = jest.fn().mockImplementation(self);
    chain.lte = jest.fn().mockImplementation(self);
    chain.lt = jest.fn().mockImplementation(self);
    chain.not = jest.fn().mockImplementation(self);
    chain.limit = jest.fn().mockImplementation(self);
    chain.range = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.update = jest.fn().mockImplementation(self);
    chain.delete = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.single = jest.fn().mockResolvedValue(resolved);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled);
    return chain;
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    mockRpc = jest.fn().mockResolvedValue({
      data: null,
      error: { message: 'RPC unavailable in unit tests' },
    });
    storageRemove = jest.fn().mockResolvedValue({ error: null });
    const supa = {
      getClient: () => ({
        from: mockFrom,
        rpc: mockRpc,
        storage: { from: jest.fn().mockReturnValue({ remove: storageRemove }) },
      }),
    } as unknown as SupabaseAdminService;
    mockTaskHierarchyConfig = {
      getTypeById: jest.fn().mockResolvedValue(defaultTaskType),
    };
    service = new TasksService(supa, mockTaskHierarchyConfig as never);
  });

  // Comment edit/delete authorize through PermissionsService; the default service has none.
  function withCommentPermissions(granted: string[]): jest.Mock {
    const hasOrgOrSpacePermission = jest.fn(
      (_userId: string, _orgId: string, key: string) =>
        Promise.resolve(granted.includes(key)),
    );
    service = new TasksService(
      {
        getClient: () => ({ from: mockFrom, rpc: mockRpc }),
      } as unknown as SupabaseAdminService,
      mockTaskHierarchyConfig as never,
      undefined,
      undefined,
      undefined,
      { hasOrgOrSpacePermission } as never,
    );
    return hasOrgOrSpacePermission;
  }

  // ---- getById ----------------------------------------------------------

  describe('getById', () => {
    it('returns a task by id + org', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: mockTask, error: null }));
      const r = await service.getById('task-1', ORG);
      expect(r.key).toBe('S1-T1');
    });

    it('throws 404 on missing', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(service.getById('nope', ORG)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('counts both legacy and centralized task attachments in relations', async () => {
      const taskRead = buildChain({
        data: {
          ...mockTask,
          status_id: 'custom-status',
          status_config: {
            id: 'custom-status',
            key: 'selected_for_development',
            name: 'Selected for Development',
            color: '#123456',
          },
        },
        error: null,
      });
      mockFrom
        .mockReturnValueOnce(taskRead) // getById
        .mockReturnValueOnce(
          buildChain({
            data: [
              {
                id: 'task',
                name: 'Task',
                color: '#fff',
                text_color: '#111',
                icon: null,
              },
            ],
            error: null,
          }),
        ) // task_types
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 2 })) // subtasks
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 3 })) // comments
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 4 })) // legacy attachments
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 5 })); // central attachments

      const task = await service.getById('task-1', ORG, {
        withRelations: true,
      });

      expect(task.attachment_count).toBe(9);
      expect(taskRead.select).toHaveBeenCalledWith(
        expect.stringContaining(
          'status_config:task_statuses!tasks_status_id_fkey',
        ),
      );
      expect(task.status_config).toMatchObject({
        id: 'custom-status',
        name: 'Selected for Development',
      });
    });
  });

  // ---- getByKey ---------------------------------------------------------

  describe('getByKey', () => {
    it('returns a task by key + org', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: mockTask, error: null }));
      const r = await service.getByKey('S1-T1', ORG);
      expect(r.id).toBe('task-1');
    });

    it('throws 404 on unknown key', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(service.getByKey('X-T999', ORG)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ---- getAll -----------------------------------------------------------

  describe('getAll', () => {
    it('returns paginated tasks', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: [mockTask], error: null, count: 1 }),
      );
      const r = await service.getAll(ORG, { space_id: SPACE });
      expect(r.data).toHaveLength(1);
      expect(r.total).toBe(1);
    });

    it('filters by development state and selects the git fields', async () => {
      const chain = buildChain({ data: [mockTask], error: null, count: 1 });
      mockFrom.mockReturnValueOnce(chain);
      await service.getAll(ORG, {
        development: 'build_failing',
        withDevelopment: true,
      });
      expect(chain.select).toHaveBeenCalledWith(
        '*, git_pr_count, git_open_pr_count, git_merged_pr_count, git_build_state',
        { count: 'exact' },
      );
      // One query carries both the rows and the exact count, so they agree.
      expect(chain.or).toHaveBeenCalledWith('git_build_state.eq.failed');
    });

    it('adds no development filter or git fields by default', async () => {
      const chain = buildChain({ data: [mockTask], error: null, count: 1 });
      mockFrom.mockReturnValueOnce(chain);
      await service.getAll(ORG, { space_id: SPACE });
      expect(chain.select).toHaveBeenCalledWith('*', { count: 'exact' });
      expect(chain.or).not.toHaveBeenCalled();
    });
  });

  // ---- create -----------------------------------------------------------

  describe('create', () => {
    it('persists a reserved support request identity in the initial insert', async () => {
      const insertChain = buildChain({ data: mockTask, error: null });
      mockFrom
        .mockReturnValueOnce(
          buildChain({ data: { id: 'status-open' }, error: null }),
        )
        .mockReturnValueOnce(
          buildChain({
            data: [{ id: 'priority-medium', key: 'medium', space_id: null }],
            error: null,
          }),
        )
        .mockReturnValueOnce(insertChain);
      await service.create(
        ORG,
        'user-1',
        { space_id: SPACE, task_type_id: 'task', summary: 'Ticket' },
        { supportRequestId: 'request-1', taskId: 'reserved-task' } as never,
      );
      expect(insertChain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'reserved-task',
          support_request_origin_id: 'request-1',
        }),
      );
    });

    it('keeps new imported tasks ineligible until import completion', async () => {
      const insertChain = buildChain({ data: mockTask, error: null });
      mockFrom
        .mockReturnValueOnce(
          buildChain({ data: { id: 'status-open' }, error: null }),
        )
        .mockReturnValueOnce(
          buildChain({
            data: [{ id: 'priority-medium', key: 'medium', space_id: null }],
            error: null,
          }),
        )
        .mockReturnValueOnce(insertChain);
      await service.create(
        ORG,
        'user-1',
        { space_id: SPACE, task_type_id: 'task', summary: 'Import' },
        { awaitImportCompletion: true } as never,
      );
      expect(insertChain.insert).toHaveBeenCalledWith(
        expect.objectContaining({ sla_ready: false }),
      );
    });

    it('creates a task with auto-generated key', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({ data: { id: 'status-open' }, error: null }),
        ) // status id lookup by key
        .mockReturnValueOnce(
          buildChain({
            data: [{ id: 'priority-medium', key: 'medium', space_id: null }],
            error: null,
          }),
        ) // priority id lookup by key
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null })); // insert
      const r = await service.create(ORG, 'user-1', {
        space_id: SPACE,
        task_type_id: 'task',
        summary: 'Fix login bug',
      });
      expect(r.id).toBe('task-1');
    });

    it('persists duration during task creation', async () => {
      const insertChain = buildChain({ data: mockTask, error: null });
      mockFrom
        .mockReturnValueOnce(
          buildChain({ data: { id: 'status-open' }, error: null }),
        )
        .mockReturnValueOnce(
          buildChain({
            data: [{ id: 'priority-medium', key: 'medium', space_id: null }],
            error: null,
          }),
        )
        .mockReturnValueOnce(insertChain);

      await service.create(ORG, 'user-1', {
        space_id: SPACE,
        task_type_id: 'task',
        summary: 'Task with duration',
        duration: 45,
      } as never);

      expect(insertChain.insert).toHaveBeenCalledWith(
        expect.objectContaining({ duration: 45 }),
      );
    });

    it('persists configured status and priority ids when creating from legacy keys', async () => {
      const insertChain = buildChain({
        data: {
          ...mockTask,
          status: 'in_progress',
          status_id: 'status-in-progress',
          priority: 'high',
          priority_id: 'priority-high',
        },
        error: null,
      });

      mockFrom
        .mockReturnValueOnce(
          buildChain({ data: { id: 'status-in-progress' }, error: null }),
        )
        .mockReturnValueOnce(
          buildChain({
            data: [{ id: 'priority-high', key: 'high', space_id: null }],
            error: null,
          }),
        )
        .mockReturnValueOnce(insertChain);

      await service.create(ORG, 'user-1', {
        space_id: SPACE,
        task_type_id: 'task',
        summary: 'Task with configured status',
        status: 'in_progress',
        priority: 'high',
      } as never);

      expect(insertChain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'in_progress',
          status_id: 'status-in-progress',
          priority: 'high',
          priority_id: 'priority-high',
        }),
      );
    });

    it('persists a localized priority selected by id in a legal legacy bucket', async () => {
      const insertChain = buildChain({
        data: {
          ...mockTask,
          priority: 'highest',
          priority_id: 'priority-hoechste',
        },
        error: null,
      });

      mockFrom
        .mockReturnValueOnce(
          buildChain({ data: { id: 'status-open' }, error: null }),
        )
        .mockReturnValueOnce(
          buildChain({
            data: [
              {
                id: 'priority-niedrigste',
                key: 'niedrigste',
                space_id: SPACE,
              },
              { id: 'priority-niedrig', key: 'niedrig', space_id: SPACE },
              { id: 'priority-mittel', key: 'mittel', space_id: SPACE },
              { id: 'priority-hoch', key: 'hoch', space_id: SPACE },
              {
                id: 'priority-hoechste',
                key: 'hoechste',
                space_id: SPACE,
              },
            ],
            error: null,
          }),
        )
        .mockReturnValueOnce(insertChain);

      await service.create(ORG, 'user-1', {
        space_id: SPACE,
        task_type_id: 'task',
        summary: 'Localized Jira priority',
        priority_id: 'priority-hoechste',
      });

      expect(insertChain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          priority: 'highest',
          priority_id: 'priority-hoechste',
        }),
      );
    });
  });

  // ---- update -----------------------------------------------------------

  describe('update', () => {
    it('partial-updates a task', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({
            data: { ...mockTask, summary: 'Updated' },
            error: null,
          }),
        ); // update
      const r = await service.update('task-1', ORG, 'user-1', {
        summary: 'Updated',
      });
      expect(r.summary).toBe('Updated');
    });

    it('does not block simple field edits when old task type config is missing', async () => {
      mockTaskHierarchyConfig.getTypeById.mockResolvedValueOnce(null);
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null }))
        .mockReturnValueOnce(
          buildChain({
            data: { ...mockTask, summary: 'Updated' },
            error: null,
          }),
        );

      const r = await service.update('task-1', ORG, 'user-1', {
        summary: 'Updated',
      });

      expect(r.summary).toBe('Updated');
      expect(mockTaskHierarchyConfig.getTypeById).not.toHaveBeenCalled();
    });

    it('rejects invalid legacy status transitions', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: mockTask, error: null }));

      await expect(
        service.update('task-1', ORG, 'user-1', {
          status: 'done',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('maps legacy title updates onto summary', async () => {
      const historyChain = buildChain({ data: null, error: null });
      const updateChain = buildChain({
        data: { ...mockTask, summary: 'Renamed' },
        error: null,
      });
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: { ...mockTask, status: 'in_progress' },
            error: null,
          }),
        )
        .mockReturnValueOnce(updateChain)
        .mockReturnValueOnce(historyChain);

      await service.update('task-1', ORG, 'user-1', {
        title: 'Renamed',
      } as never);

      expect(updateChain.update).toHaveBeenCalledWith(
        expect.objectContaining({ summary: 'Renamed' }),
      );
      expect(historyChain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          task_id: 'task-1',
          organization_id: ORG,
          action: 'update',
          field_name: 'summary',
          old_value: 'Fix login bug',
          new_value: 'Renamed',
          changed_by: 'user-1',
        }),
      );
    });

    it('sets completed_at when a status_id-only update resolves to done', async () => {
      const updateChain = buildChain({
        data: { ...mockTask, status: 'done', status_id: 'status-done' },
        error: null,
      });
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: { ...mockTask, status: 'in_progress' },
            error: null,
          }),
        )
        .mockReturnValueOnce(buildChain({ data: { key: 'done' }, error: null }))
        .mockReturnValueOnce(updateChain);

      await service.update('task-1', ORG, 'user-1', {
        status_id: 'status-done',
      });

      expect(updateChain.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'done',
          status_id: 'status-done',
          completed_at: expect.any(String) as unknown,
        }),
      );
    });

    it('records duration changes in task history', async () => {
      const historyChain = buildChain({ data: null, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null }))
        .mockReturnValueOnce(
          buildChain({ data: { ...mockTask, duration: 45 }, error: null }),
        )
        .mockReturnValueOnce(historyChain);

      await service.update('task-1', ORG, 'user-1', {
        duration: 45,
      } as never);

      expect(historyChain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          task_id: 'task-1',
          organization_id: ORG,
          action: 'update',
          field_name: 'duration',
          old_value: null,
          new_value: 45,
          changed_by: 'user-1',
        }),
      );
    });

    // ---- resolution_id (XE-T532 Slice D) --------------------------------

    it('sets resolution_id after an org + is_active check and stamps resolved_at', async () => {
      const resolutionChain = buildChain({
        data: { id: 'res-1', is_active: true },
        error: null,
      });
      const updateChain = buildChain({
        data: {
          ...mockTask,
          resolution_id: 'res-1',
          resolved_at: '2025-06-01T00:00:00Z',
        },
        error: null,
      });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null })) // getById
        .mockReturnValueOnce(resolutionChain) // resolutions lookup
        .mockReturnValueOnce(updateChain); // update

      const r = await service.update('task-1', ORG, 'user-1', {
        resolution_id: 'res-1',
      } as never);

      expect(resolutionChain.eq).toHaveBeenCalledWith('id', 'res-1');
      expect(resolutionChain.eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(updateChain.update).toHaveBeenCalledWith(
        expect.objectContaining({
          resolution_id: 'res-1',
          resolved_at: expect.any(String) as unknown,
        }),
      );
      expect(r.resolution_id).toBe('res-1');
    });

    it('rejects a resolution_id not found in the caller org with 400', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // resolutions lookup: none in this org

      await expect(
        service.update('task-1', ORG, 'user-1', {
          resolution_id: 'other-org-res',
        } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an inactive resolution_id with 400', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({
            data: { id: 'res-inactive', is_active: false },
            error: null,
          }),
        ); // resolutions lookup: inactive

      await expect(
        service.update('task-1', ORG, 'user-1', {
          resolution_id: 'res-inactive',
        } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('clears resolution_id and resolved_at without a resolutions lookup', async () => {
      const before = {
        ...mockTask,
        resolution_id: 'res-1',
        resolved_at: '2025-06-01T00:00:00Z',
      };
      const updateChain = buildChain({
        data: { ...before, resolution_id: null, resolved_at: null },
        error: null,
      });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: before, error: null })) // getById
        .mockReturnValueOnce(updateChain); // update — no resolutions lookup for null

      const r = await service.update('task-1', ORG, 'user-1', {
        resolution_id: null,
      } as never);

      expect(updateChain.update).toHaveBeenCalledWith(
        expect.objectContaining({ resolution_id: null, resolved_at: null }),
      );
      expect(r.resolution_id).toBeNull();
    });

    it('leaves resolution_id untouched when absent from the patch', async () => {
      const before = {
        ...mockTask,
        resolution_id: 'res-1',
        resolved_at: '2025-06-01T00:00:00Z',
      };
      const updateChain = buildChain({
        data: { ...before, summary: 'Updated' },
        error: null,
      });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: before, error: null })) // getById
        .mockReturnValueOnce(updateChain); // update

      await service.update('task-1', ORG, 'user-1', { summary: 'Updated' });

      const updateMock = updateChain.update as jest.Mock;
      const patchArg = (updateMock.mock.calls[0] as unknown[])[0] as Record<
        string,
        unknown
      >;
      expect(patchArg).not.toHaveProperty('resolution_id');
      expect(patchArg).not.toHaveProperty('resolved_at');
    });

    it('does no validation and leaves resolved_at alone when resolution_id is resent unchanged', async () => {
      const before = {
        ...mockTask,
        resolution_id: 'res-1',
        resolved_at: '2025-06-01T00:00:00Z',
      };
      const updateChain = buildChain({ data: before, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: before, error: null })) // getById
        .mockReturnValueOnce(updateChain); // update only — no resolutions lookup

      await service.update('task-1', ORG, 'user-1', {
        resolution_id: 'res-1',
      } as never);

      const updateMock = updateChain.update as jest.Mock;
      const patchArg = (updateMock.mock.calls[0] as unknown[])[0] as Record<
        string,
        unknown
      >;
      expect(patchArg.resolution_id).toBe('res-1');
      expect(patchArg).not.toHaveProperty('resolved_at');
    });

    it('logs task history for a resolution_id change', async () => {
      const before = { ...mockTask, resolution_id: null };
      const resolutionChain = buildChain({
        data: { id: 'res-1', is_active: true },
        error: null,
      });
      const updateChain = buildChain({
        data: { ...before, resolution_id: 'res-1' },
        error: null,
      });
      const historyChain = buildChain({ data: null, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: before, error: null })) // getById
        .mockReturnValueOnce(resolutionChain) // resolutions lookup
        .mockReturnValueOnce(updateChain) // update
        .mockReturnValueOnce(historyChain); // task_history insert

      await service.update('task-1', ORG, 'user-1', {
        resolution_id: 'res-1',
      } as never);

      expect(historyChain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          task_id: 'task-1',
          organization_id: ORG,
          action: 'update',
          field_name: 'resolution_id',
          old_value: null,
          new_value: 'res-1',
          changed_by: 'user-1',
        }),
      );
    });

    it('rejects resolution_id combined with a status change (with or without a workflow)', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: { ...mockTask, status: 'in_progress' },
            error: null,
          }),
        ) // getById
        .mockReturnValueOnce(
          buildChain({ data: { key: 'done' }, error: null }),
        ); // status row lookup

      await expect(
        service.update('task-1', ORG, 'user-1', {
          status_id: 'status-done',
          resolution_id: 'res-1',
        } as never),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ---- delete -----------------------------------------------------------

  describe('delete', () => {
    it('deletes task data through a single cascade RPC before storage cleanup', async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          deleted: true,
          storage_paths: [
            'org/task/task-1/file-attachment-1/v1/a.pdf',
            'org/task/task-1/file-attachment-2/v1/b.pdf',
          ],
        },
        error: null,
      });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // audit insert

      await expect(service.delete('task-1', ORG)).resolves.toBeUndefined();
      expect(mockRpc).toHaveBeenCalledWith('delete_task_cascade', {
        p_task_id: 'task-1',
        p_organization_id: ORG,
      });
      expect(storageRemove).toHaveBeenCalledWith([
        'org/task/task-1/file-attachment-1/v1/a.pdf',
        'org/task/task-1/file-attachment-2/v1/b.pdf',
      ]);
    });

    it('does not remove storage objects when the cascade RPC fails', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'relationship delete failed' },
      });
      mockFrom.mockReturnValueOnce(buildChain({ data: mockTask, error: null }));

      await expect(service.delete('task-1', ORG)).rejects.toThrow(
        BadRequestException,
      );
      expect(storageRemove).not.toHaveBeenCalled();
    });

    it('answers 409 when a linked test case with execution results blocks the delete', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: {
          code: '23503',
          message:
            'update or delete on table "test_cases" violates foreign key constraint "test_runs_case_id_fkey" on table "test_runs"',
        },
      });
      mockFrom.mockReturnValueOnce(buildChain({ data: mockTask, error: null }));

      await expect(service.delete('task-1', ORG)).rejects.toThrow(
        ConflictException,
      );
      expect(storageRemove).not.toHaveBeenCalled();
    });

    it('keeps 400 for any other foreign key failure', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: {
          code: '23503',
          message:
            'update or delete on table "tasks" violates foreign key constraint "x_fkey" on table "other"',
        },
      });
      mockFrom.mockReturnValueOnce(buildChain({ data: mockTask, error: null }));

      await expect(service.delete('task-1', ORG)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('delete with a linked test plan', () => {
    const withEmitter = () => {
      const emitAsync = jest.fn().mockResolvedValue([]);

      Object.assign(service, { eventEmitter: { emitAsync } });

      return emitAsync;
    };

    it('lets Test Management check the ticket before the cascade delete', async () => {
      const emitAsync = withEmitter();

      mockRpc.mockResolvedValueOnce({ data: { deleted: true }, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }));

      await service.delete('task-1', ORG, 'user-1');

      expect(emitAsync).toHaveBeenCalledWith('tasks.test_ticket.deleting', {
        organizationId: ORG,
        taskId: 'task-1',
        userId: 'user-1',
      });
      expect(emitAsync.mock.invocationCallOrder[0]).toBeLessThan(
        mockRpc.mock.invocationCallOrder[0],
      );
    });

    it('deletes nothing when Test Management refuses', async () => {
      const emitAsync = withEmitter();

      emitAsync.mockRejectedValueOnce(new ConflictException('has results'));
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }));

      await expect(service.delete('task-1', ORG, 'user-1')).rejects.toThrow(
        ConflictException,
      );
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('refuses deleting a test ticket without the delete right', async () => {
      const emitAsync = withEmitter();
      const hasSpacePermission = jest.fn().mockResolvedValue(false);
      const assertAvailable = jest.fn();

      Object.assign(service, {
        permissionsService: { hasSpacePermission },
        testManagementAccess: { assertAvailable },
      });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null }))
        .mockReturnValueOnce(
          buildChain({ data: { plan_task_type_id: 'task' }, error: null }),
        );

      await expect(service.delete('task-1', ORG, 'user-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(hasSpacePermission).toHaveBeenCalledWith(
        'user-1',
        ORG,
        SPACE,
        'delete_tests',
      );
      // Delete works while the module is off, so availability is not asked.
      expect(assertAvailable).not.toHaveBeenCalled();
      expect(emitAsync).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('sends no check when Test Management itself deletes the record', async () => {
      const emitAsync = withEmitter();

      mockRpc.mockResolvedValueOnce({ data: { deleted: true }, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }));

      await service.delete('task-1', ORG, 'user-1', {
        testRecordDeleted: true,
      });

      expect(emitAsync).not.toHaveBeenCalled();
      expect(mockRpc).toHaveBeenCalled();
    });
  });

  describe('update of a Test Management ticket', () => {
    const updatedEvent = 'tasks.test_ticket.updated';

    // Answers by table, so the test does not depend on the order of the reads.
    const ticketOfType = (typeId: string, linkedTable: string) => {
      const emitAsync = jest.fn().mockResolvedValue([]);
      const before = { ...mockTask, task_type_id: typeId };

      Object.assign(service, {
        eventEmitter: { emitAsync },
        testManagementAccess: { assertAvailable: jest.fn() },
        permissionsService: {
          hasSpacePermission: jest.fn().mockResolvedValue(true),
        },
      });
      mockFrom.mockImplementation((table: string) => {
        if (table === 'tasks') {
          return buildChain({ data: before, error: null });
        }

        if (table === 'test_management_space_settings') {
          return buildChain({
            data: {
              execution_task_type_id: 'tm-execution',
              precondition_task_type_id: 'tm-precondition',
              case_task_type_id: 'tm-case',
            },
            error: null,
          });
        }

        return buildChain({
          data: table === linkedTable ? { id: 'record-1' } : null,
          error: null,
        });
      });

      return emitAsync;
    };

    it('sends the old summary along with a changed summary', async () => {
      const emitAsync = ticketOfType('tm-case', 'test_cases');

      await service.update('task-1', ORG, 'user-1', { summary: 'Renamed' });

      expect(emitAsync).toHaveBeenCalledWith(updatedEvent, {
        organizationId: ORG,
        spaceId: SPACE,
        taskId: 'task-1',
        kind: 'case_task_type_id',
        userId: 'user-1',
        changes: { summary: 'Renamed', previousSummary: 'Fix login bug' },
      });
    });

    it('sends on the description change of an execution ticket', async () => {
      const emitAsync = ticketOfType('tm-execution', 'test_executions');

      await service.update('task-1', ORG, 'user-1', {
        description: '<p>More</p>',
      });

      expect(emitAsync).toHaveBeenCalledWith(
        updatedEvent,
        expect.objectContaining({
          kind: 'execution_task_type_id',
          changes: { description: '<p>More</p>' },
        }),
      );
    });

    it('drops the description change of a precondition ticket', async () => {
      const emitAsync = ticketOfType('tm-precondition', 'test_preconditions');

      await service.update('task-1', ORG, 'user-1', {
        summary: 'Renamed',
        description: '<p>More</p>',
      });

      expect(emitAsync).toHaveBeenCalledWith(
        updatedEvent,
        expect.objectContaining({
          kind: 'precondition_task_type_id',
          changes: { summary: 'Renamed', previousSummary: 'Fix login bug' },
        }),
      );
    });

    it('refuses a shared-field edit of a test case ticket without the edit right', async () => {
      ticketOfType('tm-case', 'test_cases');
      const hasSpacePermission = jest.fn().mockResolvedValue(false);

      Object.assign(service, { permissionsService: { hasSpacePermission } });

      await expect(
        service.update('task-1', ORG, 'user-1', { summary: 'Renamed' }),
      ).rejects.toThrow(ForbiddenException);
      expect(hasSpacePermission).toHaveBeenCalledWith(
        'user-1',
        ORG,
        SPACE,
        'edit_tests',
      );
    });

    it('asks the run right for an execution ticket', async () => {
      ticketOfType('tm-execution', 'test_executions');
      const hasSpacePermission = jest.fn().mockResolvedValue(false);

      Object.assign(service, { permissionsService: { hasSpacePermission } });

      await expect(
        service.update('task-1', ORG, 'user-1', { summary: 'Renamed' }),
      ).rejects.toThrow(ForbiddenException);
      expect(hasSpacePermission).toHaveBeenCalledWith(
        'user-1',
        ORG,
        SPACE,
        'manage_test_runs',
      );
    });

    it('skips the right when Test Management already checked it', async () => {
      const emitAsync = ticketOfType('tm-case', 'test_cases');
      const hasSpacePermission = jest.fn().mockResolvedValue(false);

      Object.assign(service, { permissionsService: { hasSpacePermission } });

      await service.update(
        'task-1',
        ORG,
        'user-1',
        { summary: 'Renamed' },
        { testRightChecked: true },
      );

      expect(hasSpacePermission).not.toHaveBeenCalled();
      expect(emitAsync).toHaveBeenCalledWith(
        updatedEvent,
        expect.objectContaining({ kind: 'case_task_type_id' }),
      );
    });

    it('asks no Test Management right when the ticket is not a test type', async () => {
      ticketOfType('task', 'test_cases');
      const hasSpacePermission = jest.fn().mockResolvedValue(false);

      Object.assign(service, { permissionsService: { hasSpacePermission } });

      await service.update('task-1', ORG, 'user-1', { summary: 'Renamed' });

      expect(hasSpacePermission).not.toHaveBeenCalled();
    });

    it('counts plain text for execution and case descriptions, and the raw text for others', () => {
      const fits = `<p>${'a'.repeat(10000)}</p>`;
      const tooLong = `<p>${'a'.repeat(10001)}</p>`;

      for (const kind of [
        'execution_task_type_id',
        'case_task_type_id',
      ] as const) {
        expect(() =>
          checkTestTicketFields(kind, { description: fits }),
        ).not.toThrow();
        expect(() =>
          checkTestTicketFields(kind, { description: tooLong }),
        ).toThrow(BadRequestException);
      }

      expect(() =>
        checkTestTicketFields('set_task_type_id', { description: fits }),
      ).toThrow(BadRequestException);
    });
  });

  describe('Test Management create right', () => {
    type RightCheck = (
      organizationId: string,
      userId: string | undefined,
      spaceId: string,
      kind: string,
      action: 'create' | 'edit' | 'delete',
      rightChecked?: boolean,
    ) => Promise<void>;

    const rightCheck = (...args: Parameters<RightCheck>) =>
      (
        service as unknown as { assertTestTicketRight: RightCheck }
      ).assertTestTicketRight(...args);
    const wire = (allowed: boolean) => {
      const hasSpacePermission = jest.fn().mockResolvedValue(allowed);
      const assertAvailable = jest.fn();

      Object.assign(service, {
        permissionsService: { hasSpacePermission },
        testManagementAccess: { assertAvailable },
      });

      return { hasSpacePermission, assertAvailable };
    };

    it.each([
      ['case_task_type_id', 'create_tests'],
      ['set_task_type_id', 'create_tests'],
      ['precondition_task_type_id', 'create_tests'],
      ['plan_task_type_id', 'manage_test_runs'],
      ['execution_task_type_id', 'manage_test_runs'],
    ])('creating a %s ticket needs %s', async (kind, permission) => {
      const { hasSpacePermission, assertAvailable } = wire(false);

      await expect(
        rightCheck(ORG, 'user-1', SPACE, kind, 'create'),
      ).rejects.toThrow(ForbiddenException);
      expect(assertAvailable).toHaveBeenCalledWith(ORG, SPACE, { write: true });
      expect(hasSpacePermission).toHaveBeenCalledWith(
        'user-1',
        ORG,
        SPACE,
        permission,
      );
    });

    it('still checks availability but not the right when Test Management checked it', async () => {
      const { hasSpacePermission, assertAvailable } = wire(false);

      await rightCheck(
        ORG,
        'user-1',
        SPACE,
        'execution_task_type_id',
        'create',
        true,
      );

      expect(assertAvailable).toHaveBeenCalled();
      expect(hasSpacePermission).not.toHaveBeenCalled();
    });

    it('refuses a delete without a user', async () => {
      wire(true);

      await expect(
        rightCheck(ORG, undefined, SPACE, 'case_task_type_id', 'delete'),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('bulkDeleteTasks', () => {
    it('reports tickets kept because their test case has execution results', async () => {
      const remove = jest
        .spyOn(service, 'delete')
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new ConflictException('has results'))
        .mockRejectedValueOnce(new NotFoundException('gone'));

      await expect(
        service.bulkDeleteTasks(ORG, 'user-1', ['t1', 't2', 't3']),
      ).resolves.toEqual({ deleted: 1, blocked: ['t2'], forbidden: [] });
      expect(remove).toHaveBeenCalledTimes(3);
    });

    it('reports test tickets the user may not delete', async () => {
      jest
        .spyOn(service, 'delete')
        .mockRejectedValueOnce(new ForbiddenException('no right'))
        .mockResolvedValueOnce(undefined);

      await expect(
        service.bulkDeleteTasks(ORG, 'user-1', ['t1', 't2']),
      ).resolves.toEqual({ deleted: 1, blocked: [], forbidden: ['t1'] });
    });

    it('returns an empty result for no ids', async () => {
      await expect(service.bulkDeleteTasks(ORG, 'user-1', [])).resolves.toEqual(
        { deleted: 0, blocked: [], forbidden: [] },
      );
    });
  });

  describe('onTestRecordDeleted', () => {
    const allowDelete = (allowed: boolean) => {
      const checkPermission = jest.fn().mockResolvedValue(allowed);

      Object.assign(service, { permissionsService: { checkPermission } });

      return checkPermission;
    };

    it('deletes the ticket of a deleted test record', async () => {
      allowDelete(true);
      const remove = jest
        .spyOn(service, 'delete')
        .mockResolvedValueOnce(undefined);

      await service.onTestRecordDeleted({
        organizationId: ORG,
        taskId: 'task-1',
        userId: 'user-1',
      });

      expect(remove).toHaveBeenCalledWith('task-1', ORG, 'user-1', {
        testRecordDeleted: true,
      });
    });

    it('passes a failed ticket delete back to Test Management', async () => {
      allowDelete(true);
      jest
        .spyOn(service, 'delete')
        .mockRejectedValueOnce(new NotFoundException('Task not found'));

      await expect(
        service.onTestRecordDeleted({
          organizationId: ORG,
          taskId: 'task-1',
          userId: 'user-1',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('refuses without the task delete right and deletes nothing', async () => {
      const checkPermission = allowDelete(false);
      const remove = jest.spyOn(service, 'delete');

      await expect(
        service.onTestRecordDeleted({
          organizationId: ORG,
          taskId: 'task-1',
          userId: 'user-1',
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(checkPermission).toHaveBeenCalledWith(
        'user-1',
        ORG,
        'can_delete_tasks',
      );
      expect(remove).not.toHaveBeenCalled();
    });
  });

  // ---- Comments ---------------------------------------------------------

  describe('getComments', () => {
    it('returns comments for a task, excluding customer portal comments', async () => {
      const commentsChain = buildChain({
        data: [{ id: 'c-1', content: 'Hello' }],
        error: null,
      });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null })) // getById
        .mockReturnValueOnce(commentsChain);
      const r = await service.getComments('task-1', ORG);
      expect(r).toHaveLength(1);
      expect(commentsChain.is).toHaveBeenCalledWith('support_request_id', null);
      expect(commentsChain.select).toHaveBeenCalledWith(
        expect.stringContaining(
          'editor:users!edited_by(id, first_name, last_name)',
        ),
      );
    });
  });

  describe('getCommentPermissions', () => {
    it('resolves own and others rights against the task space', async () => {
      const has = withCommentPermissions([
        'can_add_comments_tasks',
        'can_edit_others_comments_tasks',
      ]);
      mockFrom.mockReturnValueOnce(buildChain({ data: mockTask, error: null }));

      await expect(
        service.getCommentPermissions('task-1', ORG, 'user-1'),
      ).resolves.toEqual({
        can_edit_own: true,
        can_delete_own: false,
        can_edit_others: true,
        can_delete_others: false,
      });
      expect(has).toHaveBeenCalledWith(
        'user-1',
        ORG,
        'can_delete_others_comments_tasks',
        SPACE,
      );
    });

    it('throws 404 for a task of another organization', async () => {
      const has = withCommentPermissions(['can_add_comments_tasks']);
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));

      await expect(
        service.getCommentPermissions('task-1', ORG, 'user-1'),
      ).rejects.toThrow(NotFoundException);
      expect(has).not.toHaveBeenCalled();
    });
  });

  describe('createComment', () => {
    it('creates a comment', async () => {
      const insertChain = buildChain({
        data: { id: 'c-1', content: '<p>Hello</p>', created_by: 'user-1' },
        error: null,
      });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null })) // getById
        .mockReturnValueOnce(insertChain); // insert
      // createComment is typed Promise<unknown>; narrow it for the assertion.
      const r = (await service.createComment(
        'task-1',
        ORG,
        'user-1',
        '<p>Hello</p><script>alert(1)</script>',
      )) as { id: string };
      expect(r.id).toBe('c-1');
      expect(insertChain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '<p>Hello</p>',
        }),
      );
    });

    it('omits support_request_id from the insert payload when extra is not passed', async () => {
      const insertChain = buildChain({
        data: { id: 'c-1', content: '<p>Hello</p>', created_by: 'user-1' },
        error: null,
      });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null })) // getById
        .mockReturnValueOnce(insertChain); // insert

      await service.createComment('task-1', ORG, 'user-1', '<p>Hello</p>');

      expect(insertChain.insert).toHaveBeenCalledWith(
        expect.not.objectContaining({
          support_request_id: expect.anything() as unknown,
        }),
      );
    });

    it('includes support_request_id in the insert payload when extra is passed', async () => {
      const insertChain = buildChain({
        data: { id: 'c-1', content: '<p>Hello</p>', created_by: 'user-1' },
        error: null,
      });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null })) // getById
        .mockReturnValueOnce(insertChain); // insert

      await service.createComment('task-1', ORG, 'user-1', '<p>Hello</p>', {
        support_request_id: 'req-1',
      });

      expect(insertChain.insert).toHaveBeenCalledWith(
        expect.objectContaining({ support_request_id: 'req-1' }),
      );
    });

    it('sanitizes edited comments before persisting', async () => {
      withCommentPermissions(['can_add_comments_tasks']);
      const updateChain = buildChain({
        data: { id: 'c-1', content: '<p>Updated</p>', created_by: 'user-1' },
        error: null,
      });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({
            data: { id: 'c-1', content: '<p>Old</p>', created_by: 'user-1' },
            error: null,
          }),
        ) // existing comment
        .mockReturnValueOnce(updateChain); // update

      await service.updateComment(
        'task-1',
        'c-1',
        ORG,
        'user-1',
        '<p>Updated</p><script>alert(1)</script>',
      );

      expect(updateChain.update).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '<p>Updated</p>',
          edited_by: 'user-1',
        }),
      );
    });
  });

  describe('updateComment authorization', () => {
    const othersComment = {
      id: 'c-1',
      content: '<p>Old</p>',
      created_by: 'user-2',
    };

    it('lets a non-author with the edit-others right edit and records the editor', async () => {
      const has = withCommentPermissions(['can_edit_others_comments_tasks']);
      const updateChain = buildChain({
        data: { ...othersComment, content: '<p>New</p>' },
        error: null,
      });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: othersComment, error: null })) // existing comment
        .mockReturnValueOnce(updateChain); // update

      await service.updateComment('task-1', 'c-1', ORG, 'user-1', '<p>New</p>');

      expect(has).toHaveBeenCalledWith(
        'user-1',
        ORG,
        'can_edit_others_comments_tasks',
        SPACE,
      );
      expect(updateChain.update).toHaveBeenCalledWith(
        expect.objectContaining({ content: '<p>New</p>', edited_by: 'user-1' }),
      );
    });

    it('denies a non-author without the edit-others right and writes nothing', async () => {
      withCommentPermissions(['can_add_comments_tasks']);
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null }))
        .mockReturnValueOnce(buildChain({ data: othersComment, error: null }));

      await expect(
        service.updateComment('task-1', 'c-1', ORG, 'user-1', '<p>New</p>'),
      ).rejects.toThrow(ForbiddenException);
      expect(mockFrom).toHaveBeenCalledTimes(2);
    });

    it('denies the author without the add-comments right', async () => {
      withCommentPermissions(['can_edit_others_comments_tasks']);
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null }))
        .mockReturnValueOnce(
          buildChain({
            data: { ...othersComment, created_by: 'user-1' },
            error: null,
          }),
        );

      await expect(
        service.updateComment('task-1', 'c-1', ORG, 'user-1', '<p>New</p>'),
      ).rejects.toThrow(ForbiddenException);
      expect(mockFrom).toHaveBeenCalledTimes(2);
    });
  });

  describe('deleteComment', () => {
    it('deletes author own comment', async () => {
      const has = withCommentPermissions(['can_delete_comments_tasks']);
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null })) // getById task
        .mockReturnValueOnce(
          buildChain({
            data: { id: 'c-1', task_id: 'task-1', created_by: 'user-1' },
            error: null,
          }),
        ) // getById comment
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // delete
      await expect(
        service.deleteComment('task-1', 'c-1', ORG, 'user-1'),
      ).resolves.toBeUndefined();
      expect(has).toHaveBeenCalledWith(
        'user-1',
        ORG,
        'can_delete_comments_tasks',
        SPACE,
      );
    });

    it('lets a non-author with the delete-others right delete', async () => {
      const has = withCommentPermissions(['can_delete_others_comments_tasks']);
      const deleteChain = buildChain({ data: null, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null }))
        .mockReturnValueOnce(
          buildChain({
            data: { id: 'c-1', task_id: 'task-1', created_by: 'user-2' },
            error: null,
          }),
        )
        .mockReturnValueOnce(deleteChain);

      await expect(
        service.deleteComment('task-1', 'c-1', ORG, 'user-1'),
      ).resolves.toBeUndefined();
      expect(has).toHaveBeenCalledWith(
        'user-1',
        ORG,
        'can_delete_others_comments_tasks',
        SPACE,
      );
      expect(deleteChain.delete).toHaveBeenCalled();
    });

    it('denies a non-author without the delete-others right and deletes nothing', async () => {
      withCommentPermissions(['can_delete_comments_tasks']);
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null }))
        .mockReturnValueOnce(
          buildChain({
            data: { id: 'c-1', task_id: 'task-1', created_by: null },
            error: null,
          }),
        );

      await expect(
        service.deleteComment('task-1', 'c-1', ORG, 'user-1'),
      ).rejects.toThrow(ForbiddenException);
      expect(mockFrom).toHaveBeenCalledTimes(2);
    });
  });

  // ---- Relationships ----------------------------------------------------

  describe('rich-text sanitization policy', () => {
    const sanitizeMock = sanitizeRichText as unknown as jest.Mock;

    beforeEach(() => sanitizeMock.mockClear());

    // Tables are opt-in per call site. All four task write paths must ask for the SAME policy:
    // if create allowed tables and update did not, a user's first edit would silently delete the
    // table they just saved. Asserting the argument is what keeps the four in lockstep.
    it('creates a task description with tables allowed', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({ data: { id: 'status-open' }, error: null }),
        )
        .mockReturnValueOnce(
          buildChain({
            data: [{ id: 'priority-medium', key: 'medium', space_id: null }],
            error: null,
          }),
        )
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null }));

      await service.create(ORG, 'user-1', {
        space_id: SPACE,
        task_type_id: 'task',
        summary: 'x',
        description: '<table><tr><td>a</td></tr></table>',
      });

      expect(sanitizeMock).toHaveBeenCalledWith(
        '<table><tr><td>a</td></tr></table>',
        { allowTables: true },
      );
    });

    it('updates a task description with tables allowed', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null }))
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null }));

      await service.update('task-1', ORG, 'user-1', {
        description: '<table><tr><td>b</td></tr></table>',
      });

      expect(sanitizeMock).toHaveBeenCalledWith(
        '<table><tr><td>b</td></tr></table>',
        { allowTables: true },
      );
    });

    it('creates a comment with tables allowed', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null }))
        .mockReturnValueOnce(
          buildChain({
            data: { id: 'c-1', created_by: 'user-1' },
            error: null,
          }),
        );

      await service.createComment(
        'task-1',
        ORG,
        'user-1',
        '<table><tr><td>c</td></tr></table>',
      );

      expect(sanitizeMock).toHaveBeenCalledWith(
        '<table><tr><td>c</td></tr></table>',
        { allowTables: true },
      );
    });

    it('updates a comment with tables allowed', async () => {
      withCommentPermissions(['can_add_comments_tasks']);
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null }))
        .mockReturnValueOnce(
          buildChain({
            data: { id: 'c-1', content: '<p>Old</p>', created_by: 'user-1' },
            error: null,
          }),
        )
        .mockReturnValueOnce(
          buildChain({
            data: { id: 'c-1', created_by: 'user-1' },
            error: null,
          }),
        );

      await service.updateComment(
        'task-1',
        'c-1',
        ORG,
        'user-1',
        '<table><tr><td>d</td></tr></table>',
      );

      expect(sanitizeMock).toHaveBeenCalledWith(
        '<table><tr><td>d</td></tr></table>',
        { allowTables: true },
      );
    });
  });

  describe('getRelationships', () => {
    it('returns relationships for a task', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({
            data: [{ id: 'rel-1', relation_type_id: 'rt-1' }],
            error: null,
          }),
        );
      const r = await service.getRelationships('task-1', ORG);
      expect(r).toHaveLength(1);
    });
  });

  describe('createRelationship', () => {
    // The target must be viewable (XE-T532 #4); these cases are about the
    // insert, so the viewer may see every space.
    beforeEach(() => {
      const supa = {
        getClient: () => ({ from: mockFrom, rpc: mockRpc }),
      } as unknown as SupabaseAdminService;
      service = new TasksService(
        supa,
        mockTaskHierarchyConfig as never,
        undefined,
        undefined,
        undefined,
        {
          getUserSpacePermissions: jest.fn().mockResolvedValue({
            isMember: true,
            permissions: { view_tasks: true },
          }),
        } as never,
      );
    });

    it('creates a relationship', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null })) // getById (source)
        .mockReturnValueOnce(
          buildChain({ data: { id: 'rt-1', name: 'blocks' }, error: null }),
        ) // relation_types org check (before the insert)
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null })) // getById (target) — exists check
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // duplicate check
        .mockReturnValueOnce(
          buildChain({
            data: {
              id: 'rel-1',
              source_id: 'task-1',
              target_id: 'task-2',
            },
            error: null,
          }),
        ) // insert
        .mockReturnValueOnce(
          buildChain({
            data: { key: 'S1-T2', summary: 'Target task' },
            error: null,
          }),
        ) // target task lookup
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // history insert (fire-and-forget)
      const r = (await service.createRelationship('task-1', ORG, 'user-1', {
        target_id: 'task-2',
        relation_type_id: 'rt-1',
      })) as { id: string };
      expect(r.id).toBe('rel-1');
    });

    it('prevents self-referencing', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: mockTask, error: null })); // getById (source)
      await expect(
        service.createRelationship('task-1', ORG, 'user-1', {
          target_id: 'task-1',
          relation_type_id: 'rt-1',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('prevents duplicate relationship', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null })) // source
        .mockReturnValueOnce(
          buildChain({ data: { id: 'rt-1', name: 'blocks' }, error: null }),
        ) // relation type
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null })) // target
        .mockReturnValueOnce(
          buildChain({ data: { id: 'existing' }, error: null }),
        ); // dup check
      await expect(
        service.createRelationship('task-1', ORG, 'user-1', {
          target_id: 'task-2',
          relation_type_id: 'rt-1',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // XE-T532 #3/#6: typed ticket→wiki-page links, and the relation-type org
  // check (a cross-tenant or trashed type used to be accepted, then rendered).
  describe('typed relationship targets', () => {
    const PAGE = 'page-1';
    const WIKI_SPACE = 'wiki-space-1';
    const wikiPerms = {
      assertPageAccess: jest.fn(),
      filterAccessiblePages: jest.fn(),
    };
    const outbox = { write: jest.fn() };
    const perms = {
      getUserSpacePermissions: jest.fn(),
      getUserEffectivePermissions: jest.fn(),
    };
    let svc: TasksService;
    let chains: Record<string, Record<string, jest.Mock>[]>;

    type Resolved = { data: unknown; error: unknown };

    // Route by table so each test states only the reads it cares about;
    // anything unlisted resolves to { data: null }.
    function route(queues: Record<string, Resolved[]>) {
      chains = {};
      mockFrom.mockImplementation((table: string) => {
        const chain = buildChain(
          queues[table]?.shift() ?? { data: null, error: null },
        ) as Record<string, jest.Mock>;
        (chains[table] ??= []).push(chain);
        return chain;
      });
    }

    const page = {
      id: PAGE,
      space_id: WIKI_SPACE,
      organization_id: ORG,
      is_archived: false,
    };
    const hydratedPage = {
      id: PAGE,
      title: 'VPN known error',
      slug: 'vpn-known-error',
      space_id: WIKI_SPACE,
      is_archived: false,
      created_by: 'someone',
      path: [],
      space: { key: 'KB' },
    };
    const wikiRow = {
      id: 'rel-w',
      organization_id: ORG,
      source_type: 'task',
      source_id: 'task-1',
      target_type: 'wiki_page',
      target_id: PAGE,
      relation_type_id: 'rt-1',
    };

    function wikiCreateQueues(overrides: Record<string, Resolved[]> = {}) {
      return {
        tasks: [{ data: mockTask, error: null }],
        relation_types: [
          { data: { id: 'rt-1', name: 'Documents' }, error: null },
        ],
        wiki_pages: [
          { data: page, error: null }, // target validation
          { data: { title: 'VPN known error' }, error: null }, // history title
          { data: [hydratedPage], error: null }, // enrich
        ],
        task_relationships: [
          { data: null, error: null }, // duplicate check
          { data: wikiRow, error: null }, // insert
        ],
        ...overrides,
      };
    }

    const createWiki = () =>
      svc.createRelationship('task-1', ORG, 'user-1', {
        target_id: PAGE,
        target_type: 'wiki_page',
        relation_type_id: 'rt-1',
      });

    beforeEach(() => {
      wikiPerms.assertPageAccess.mockReset().mockResolvedValue(undefined);
      wikiPerms.filterAccessiblePages
        .mockReset()
        .mockImplementation((pages: unknown[]) => Promise.resolve(pages));
      outbox.write.mockReset();
      perms.getUserSpacePermissions.mockReset().mockResolvedValue({
        isMember: true,
        permissions: { view_tasks: true, view_processes: true },
      });
      perms.getUserEffectivePermissions
        .mockReset()
        .mockResolvedValue({ effective_permissions: { can_view_tasks: true } });
      const supa = {
        getClient: () => ({ from: mockFrom, rpc: mockRpc }),
      } as unknown as SupabaseAdminService;
      svc = new TasksService(
        supa,
        mockTaskHierarchyConfig as never,
        undefined,
        undefined,
        outbox as never,
        perms as never,
        undefined,
        undefined,
        wikiPerms as never,
      );
    });

    describe('createRelationship', () => {
      it('links a wiki page the viewer can see, and returns it hydrated', async () => {
        route(wikiCreateQueues());

        const r = (await createWiki()) as Record<string, unknown>;

        expect(wikiPerms.assertPageAccess).toHaveBeenCalledWith(
          PAGE,
          'user-1',
          WIKI_SPACE,
          'can_view',
        );
        expect(chains.wiki_pages[0].eq).toHaveBeenCalledWith(
          'organization_id',
          ORG,
        );
        expect(chains.task_relationships[1].insert).toHaveBeenCalledWith(
          expect.objectContaining({
            target_type: 'wiki_page',
            target_id: PAGE,
          }),
        );
        expect(r.target_wiki_page).toEqual({
          id: PAGE,
          title: 'VPN known error',
          slug: 'vpn-known-error',
          space_id: WIKI_SPACE,
          space_key: 'KB',
          is_archived: false,
        });
      });

      it('404s a page outside the org, without inserting', async () => {
        route(wikiCreateQueues({ wiki_pages: [{ data: null, error: null }] }));

        await expect(createWiki()).rejects.toThrow(NotFoundException);
        expect(chains.task_relationships).toBeUndefined();
      });

      it('400s an archived page', async () => {
        route(
          wikiCreateQueues({
            wiki_pages: [{ data: { ...page, is_archived: true }, error: null }],
          }),
        );

        await expect(createWiki()).rejects.toThrow(
          new BadRequestException('Cannot link an archived wiki page'),
        );
        expect(chains.task_relationships).toBeUndefined();
      });

      // Permission runs before the archived check, so a hidden page never
      // answers "archived" and confirms it exists.
      it('404s an archived page the viewer cannot see', async () => {
        route(
          wikiCreateQueues({
            wiki_pages: [{ data: { ...page, is_archived: true }, error: null }],
          }),
        );
        wikiPerms.assertPageAccess.mockRejectedValue(
          new ForbiddenException('nope'),
        );

        await expect(createWiki()).rejects.toThrow(NotFoundException);
        expect(chains.task_relationships).toBeUndefined();
      });

      it('404s (not 403s) a page the viewer cannot see', async () => {
        route(wikiCreateQueues());
        wikiPerms.assertPageAccess.mockRejectedValue(
          new ForbiddenException('nope'),
        );

        await expect(createWiki()).rejects.toThrow(NotFoundException);
        expect(chains.task_relationships).toBeUndefined();
      });

      it('fails closed when the wiki permission service is absent', async () => {
        route(wikiCreateQueues());

        await expect(
          service.createRelationship('task-1', ORG, 'user-1', {
            target_id: PAGE,
            target_type: 'wiki_page',
            relation_type_id: 'rt-1',
          }),
        ).rejects.toThrow(NotFoundException);
        expect(chains.task_relationships).toBeUndefined();
      });

      it.each([
        ['task', 'task-2'],
        ['wiki_page', PAGE],
      ])(
        '400s a relation type from another org or the trash (%s target)',
        async (targetType, targetId) => {
          route(
            wikiCreateQueues({ relation_types: [{ data: null, error: null }] }),
          );

          await expect(
            svc.createRelationship('task-1', ORG, 'user-1', {
              target_id: targetId,
              target_type: targetType,
              relation_type_id: 'rt-foreign',
            }),
          ).rejects.toThrow(new BadRequestException('Unknown relation type'));

          const rt = chains.relation_types[0];
          expect(rt.eq).toHaveBeenCalledWith('id', 'rt-foreign');
          expect(rt.eq).toHaveBeenCalledWith('organization_id', ORG);
          expect(rt.eq).toHaveBeenCalledWith('is_deleted', false);
          expect(chains.task_relationships).toBeUndefined();
        },
      );

      it('409s a duplicate wiki link', async () => {
        route(
          wikiCreateQueues({
            task_relationships: [{ data: { id: 'existing' }, error: null }],
          }),
        );

        await expect(createWiki()).rejects.toThrow(ConflictException);
        expect(chains.task_relationships[0].eq).toHaveBeenCalledWith(
          'target_type',
          'wiki_page',
        );
      });

      it('emits targetType + relatedWikiPageId, and a null relatedTaskId, for a wiki target', async () => {
        route(wikiCreateQueues());

        await createWiki();

        expect(outbox.write).toHaveBeenCalledWith(
          ORG,
          SPACE,
          'app.task.relation_added',
          expect.objectContaining({
            task_id: 'task-1',
            targetType: 'wiki_page',
            relatedTaskId: null,
            relatedWikiPageId: PAGE,
            relationType: 'Documents',
          }),
        );
      });

      it('keeps relatedTaskId for a task target', async () => {
        route({
          tasks: [
            { data: mockTask, error: null },
            { data: { ...mockTask, id: 'task-2' }, error: null },
          ],
          relation_types: [
            { data: { id: 'rt-1', name: 'Blocks' }, error: null },
          ],
          task_relationships: [
            { data: null, error: null },
            {
              data: { ...wikiRow, target_type: 'task', target_id: 'task-2' },
              error: null,
            },
          ],
        });

        await svc.createRelationship('task-1', ORG, 'user-1', {
          target_id: 'task-2',
          relation_type_id: 'rt-1',
        });

        expect(outbox.write).toHaveBeenCalledWith(
          ORG,
          SPACE,
          'app.task.relation_added',
          expect.objectContaining({
            targetType: 'task',
            relatedTaskId: 'task-2',
            relatedWikiPageId: null,
            relationType: 'Blocks',
          }),
        );
      });

      // XE-T532 #4: the picker is org-wide, so the target's own space is
      // checked, and a hidden target answers exactly like a missing one.
      const createQueues = (target: Record<string, unknown>) => ({
        tasks: [
          { data: mockTask, error: null },
          { data: { ...mockTask, id: 'task-2', ...target }, error: null },
        ],
        relation_types: [{ data: { id: 'rt-1', name: 'Blocks' }, error: null }],
      });

      it('404s a task target the viewer cannot see, without inserting', async () => {
        route(createQueues({ space_id: 'space-hidden' }));
        perms.getUserSpacePermissions.mockResolvedValue({
          isMember: true,
          permissions: { view_tasks: false },
        });

        await expect(
          svc.createRelationship('task-1', ORG, 'user-1', {
            target_id: 'task-2',
            relation_type_id: 'rt-1',
          }),
        ).rejects.toThrow(new NotFoundException('Task not found'));
        expect(perms.getUserSpacePermissions).toHaveBeenCalledWith(
          'user-1',
          ORG,
          'space-hidden',
        );
        expect(chains.task_relationships).toBeUndefined();
      });

      it('404s an org-level task target without org can_view_tasks', async () => {
        route(createQueues({ space_id: null }));
        perms.getUserEffectivePermissions.mockResolvedValue({
          effective_permissions: { can_view_tasks: false },
        });

        await expect(
          svc.createRelationship('task-1', ORG, 'user-1', {
            target_id: 'task-2',
            relation_type_id: 'rt-1',
          }),
        ).rejects.toThrow(new NotFoundException('Task not found'));
        expect(chains.task_relationships).toBeUndefined();
      });

      it('404s a process target the viewer cannot see', async () => {
        route({
          ...createQueues({}),
          business_processes: [
            { data: { id: 'proc-1', space_id: 'space-hidden' }, error: null },
          ],
        });
        perms.getUserSpacePermissions.mockResolvedValue({
          isMember: true,
          permissions: { view_tasks: true, view_processes: false },
        });

        await expect(
          svc.createRelationship('task-1', ORG, 'user-1', {
            target_id: 'proc-1',
            target_type: 'process',
            relation_type_id: 'rt-1',
          }),
        ).rejects.toThrow(new NotFoundException('Target process not found'));
        expect(chains.task_relationships).toBeUndefined();
      });
    });

    describe('getRelationships', () => {
      const rows = [
        {
          id: 'rel-t',
          source_type: 'task',
          source_id: 'task-1',
          target_type: 'task',
          target_id: 'task-2',
        },
        { ...wikiRow, id: 'rel-visible', target_id: 'p-visible' },
        { ...wikiRow, id: 'rel-hidden', target_id: 'p-hidden' },
        { ...wikiRow, id: 'rel-deleted', target_id: 'p-deleted' },
      ];
      const pages = [
        { ...hydratedPage, id: 'p-visible' },
        { ...hydratedPage, id: 'p-hidden', title: 'Secret' },
      ];
      const task2 = {
        id: 'task-2',
        key: 'S1-T2',
        summary: 'Target',
        status: 'open',
        priority: 'high',
        space_id: SPACE,
        space: { key: 'S1' },
      };
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { space: _space, ...visibleTask2 } = task2;

      function routeRead() {
        route({
          tasks: [
            { data: mockTask, error: null }, // getById
            { data: [task2], error: null }, // enrich task sides
          ],
          task_relationships: [{ data: rows, error: null }],
          wiki_pages: [{ data: pages, error: null }],
        });
      }

      const byId = (list: unknown[]) =>
        Object.fromEntries(
          (list as Record<string, unknown>[]).map((r) => [r.id as string, r]),
        );

      it('hydrates visible pages, stubs restricted ones, nulls deleted ones', async () => {
        routeRead();
        wikiPerms.filterAccessiblePages.mockImplementation(
          (list: { id: string }[]) =>
            Promise.resolve(list.filter((p) => p.id === 'p-visible')),
        );

        const out = byId(await svc.getRelationships('task-1', ORG, 'user-1'));

        expect(out['rel-visible'].target_wiki_page).toEqual({
          id: 'p-visible',
          title: 'VPN known error',
          slug: 'vpn-known-error',
          space_id: WIKI_SPACE,
          space_key: 'KB',
          is_archived: false,
        });
        expect(out['rel-hidden'].target_wiki_page).toEqual({
          id: 'p-hidden',
          restricted: true,
        });
        expect(out['rel-deleted'].target_wiki_page).toBeNull();
        expect(wikiPerms.filterAccessiblePages).toHaveBeenCalledTimes(1);
        expect(wikiPerms.filterAccessiblePages).toHaveBeenCalledWith(
          pages,
          'user-1',
          WIKI_SPACE,
        );
        expect(chains.wiki_pages[0].eq).toHaveBeenCalledWith(
          'organization_id',
          ORG,
        );
      });

      it('keeps visible task rows, adding their space_key', async () => {
        routeRead();

        const out = byId(await svc.getRelationships('task-1', ORG, 'user-1'));

        expect(out['rel-t']).toEqual({
          ...rows[0],
          source_task: null,
          target_task: { ...visibleTask2, space_key: 'S1' },
        });
      });

      // XE-T532 #4: an org-wide picker makes any org task linkable, so the
      // read must not hand out another space's key or summary.
      it('stubs task and process sides the viewer cannot see', async () => {
        const HIDDEN = 'space-hidden';
        const link = (id: string, over: Record<string, unknown>) => ({
          ...rows[0],
          id,
          ...over,
        });
        route({
          tasks: [
            { data: mockTask, error: null },
            {
              data: [
                task2,
                {
                  ...task2,
                  id: 'task-3',
                  summary: 'Hidden',
                  space_id: HIDDEN,
                  space: { key: 'H' },
                },
                { ...task2, id: 'task-4', space_id: null, space: null },
              ],
              error: null,
            },
          ],
          business_processes: [
            {
              data: [
                { id: 'proc-1', key: 'P-1', title: 'Hidden', space_id: HIDDEN },
                {
                  id: 'proc-2',
                  key: 'P-2',
                  title: 'Visible process',
                  space_id: SPACE,
                  space: { key: 'S1' },
                },
              ],
              error: null,
            },
          ],
          task_relationships: [
            {
              data: [
                link('rel-visible', { target_id: 'task-2' }),
                link('rel-hidden', { target_id: 'task-3' }),
                link('rel-org', { target_id: 'task-4' }),
                link('rel-proc-hidden', {
                  source_type: 'process',
                  source_id: 'proc-1',
                  target_id: 'task-1',
                }),
                link('rel-proc-visible', {
                  target_type: 'process',
                  target_id: 'proc-2',
                }),
              ],
              error: null,
            },
          ],
        });
        perms.getUserSpacePermissions.mockImplementation(
          (_user: string, _org: string, spaceId: string) =>
            Promise.resolve(
              spaceId === SPACE
                ? {
                    isMember: true,
                    permissions: { view_tasks: true, view_processes: true },
                  }
                : { isMember: false, permissions: {} },
            ),
        );
        perms.getUserEffectivePermissions.mockResolvedValue({
          effective_permissions: { can_view_tasks: false },
        });

        const out = byId(await svc.getRelationships('task-1', ORG, 'user-1'));

        expect(out['rel-visible'].target_task).toEqual({
          ...visibleTask2,
          space_key: 'S1',
        });
        expect(out['rel-hidden'].target_task).toEqual({
          id: 'task-3',
          restricted: true,
        });
        expect(out['rel-org'].target_task).toEqual({
          id: 'task-4',
          restricted: true,
        });
        expect(out['rel-proc-hidden'].source_process).toEqual({
          id: 'proc-1',
          restricted: true,
        });
        expect(out['rel-proc-visible'].target_process).toEqual({
          id: 'proc-2',
          key: 'P-2',
          title: 'Visible process',
          space_id: SPACE,
          space_key: 'S1',
        });
        // One permission lookup per space, not per row.
        expect(perms.getUserSpacePermissions).toHaveBeenCalledTimes(2);
        expect(chains.tasks[1].eq).toHaveBeenCalledWith('organization_id', ORG);
        expect(chains.business_processes[0].eq).toHaveBeenCalledWith(
          'organization_id',
          ORG,
        );
      });

      // A read error must not look like a deleted page (null), which would
      // invite unlinking a valid link.
      it('restricts every wiki target when the page read fails', async () => {
        route({
          tasks: [
            { data: mockTask, error: null },
            { data: [task2], error: null },
          ],
          task_relationships: [{ data: rows, error: null }],
          wiki_pages: [{ data: null, error: { message: 'boom' } }],
        });

        const out = byId(await svc.getRelationships('task-1', ORG, 'user-1'));

        for (const [rel, pageId] of [
          ['rel-visible', 'p-visible'],
          ['rel-hidden', 'p-hidden'],
          ['rel-deleted', 'p-deleted'],
        ]) {
          expect(out[rel].target_wiki_page).toEqual({
            id: pageId,
            restricted: true,
          });
        }
        expect(wikiPerms.filterAccessiblePages).not.toHaveBeenCalled();
      });

      it('restricts every wiki page when no viewer is known', async () => {
        routeRead();

        const out = byId(await svc.getRelationships('task-1', ORG));

        expect(out['rel-visible'].target_wiki_page).toEqual({
          id: 'p-visible',
          restricted: true,
        });
        expect(wikiPerms.filterAccessiblePages).not.toHaveBeenCalled();
      });
    });
  });

  // ---- Hierarchy --------------------------------------------------------

  describe('getSubtasks', () => {
    it('returns child tasks', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({
            data: [{ ...mockTask, id: 'task-child', parent_task_id: 'task-1' }],
            error: null,
          }),
        )
        .mockReturnValueOnce(buildChain({ data: [], error: null })); // child counts
      const r = await service.getSubtasks('task-1', ORG);
      expect(r).toHaveLength(1);
    });

    it('returns each subtask status row, so the list chip matches the detail view (XE-T637)', async () => {
      const inReview = {
        id: 'st-review',
        name: 'In Review',
        key: 'review',
        color: '#F59E0B',
        icon: 'lucide:eye',
        is_completed: false,
        sort_order: 3,
      };
      const child = {
        summary: 'Child',
        priority: 'medium',
        task_type_id: null,
        children_count: 0,
      };
      mockRpc.mockResolvedValueOnce({
        data: [
          { ...child, id: 'child-1', key: 'T-2', status: 'review' },
          { ...child, id: 'child-2', key: 'T-3', status: 'open' },
        ],
        error: null,
      });
      const extra = buildChain({
        data: [
          {
            id: 'child-1',
            created_at: '2026-10-16T00:00:00Z',
            status_config: inReview,
          },
          { id: 'child-2', created_at: null, status_config: null },
        ],
        error: null,
      });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null })) // getById
        .mockReturnValueOnce(extra); // created_at + status row

      const r = await service.getSubtasks('task-1', ORG);

      expect(extra.select).toHaveBeenCalledWith(
        expect.stringContaining(
          'status_config:task_statuses!tasks_status_id_fkey(',
        ),
      );
      expect(r.map((s) => s.status_config)).toEqual([inReview, null]);
      expect(r[0].created_at).toBe('2026-10-16T00:00:00Z');
    });
  });

  describe('getParentChain', () => {
    it('returns empty for root task', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: mockTask, error: null }));
      const r = await service.getParentChain('task-1', ORG);
      expect(r).toHaveLength(0);
    });

    it('returns chain for nested task', async () => {
      const child = {
        ...mockTask,
        id: 'task-child',
        parent_task_id: 'task-1',
      };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: child, error: null })) // getById child
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null })); // getById parent
      const r = await service.getParentChain('task-child', ORG);
      expect(r).toHaveLength(1);
      expect(r[0].id).toBe('task-1');
    });
  });

  // ---- History ----------------------------------------------------------

  describe('getHistory', () => {
    it('returns history entries', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({
            data: [{ id: 'h-1', action: 'created' }],
            error: null,
          }),
        );
      const r = await service.getHistory('task-1', ORG);
      expect(r).toHaveLength(1);
    });
  });

  // ---- reorderTasks -----------------------------------------------------

  describe('reorderTasks', () => {
    it('batch updates sort_order for tasks in a space', async () => {
      mockRpc.mockResolvedValueOnce({ data: 2, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: SPACE }, error: null })) // space check
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null })) // task-1 lookup
        .mockReturnValueOnce(
          buildChain({
            data: { ...mockTask, id: 'task-2', sort_order: 1 },
            error: null,
          }),
        ); // task-2 lookup

      const r = await service.reorderTasks(SPACE, ORG, null, [
        { id: 'task-1', sort_order: 0 },
        { id: 'task-2', sort_order: 1 },
      ]);
      expect(r.updated).toBe(2);
      expect(mockRpc).toHaveBeenCalledWith('reorder_space_tasks', {
        p_space_id: SPACE,
        p_organization_id: ORG,
        p_items: [
          { id: 'task-1', sort_order: 0 },
          { id: 'task-2', sort_order: 1 },
        ],
      });
    });

    it('also updates parent_task_id when provided', async () => {
      mockRpc.mockResolvedValueOnce({ data: 1, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: SPACE }, error: null }))
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null }))
        .mockReturnValueOnce(
          buildChain({
            data: {
              ...mockTask,
              id: 'parent-1',
              parent_task_id: null,
              task_type_id: 'task',
            },
            error: null,
          }),
        )
        .mockReturnValueOnce(buildChain({ data: [], error: null }));

      const r = await service.reorderTasks(SPACE, ORG, null, [
        { id: 'task-1', sort_order: 0, parent_task_id: 'parent-1' },
      ]);
      expect(r.updated).toBe(1);
      expect(mockRpc).toHaveBeenCalledWith('reorder_space_tasks', {
        p_space_id: SPACE,
        p_organization_id: ORG,
        p_items: [{ id: 'task-1', sort_order: 0, parent_task_id: 'parent-1' }],
      });
    });

    it('throws NotFoundException if space not found', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.reorderTasks('bad-space', ORG, null, [
          { id: 'task-1', sort_order: 0 },
        ]),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException if the atomic reorder RPC fails', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'DB error' },
      });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: SPACE }, error: null }))
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null }));
      await expect(
        service.reorderTasks(SPACE, ORG, null, [
          { id: 'task-1', sort_order: 0 },
        ]),
      ).rejects.toThrow(BadRequestException);
    });

    it('does not call the database for an empty reorder', async () => {
      const r = await service.reorderTasks(SPACE, ORG, null, []);

      expect(r.updated).toBe(0);
      expect(mockFrom).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('rejects reparenting a task under its descendant', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: SPACE }, error: null }))
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null }))
        .mockReturnValueOnce(
          buildChain({
            data: {
              ...mockTask,
              id: 'child-1',
              parent_task_id: 'task-1',
              task_type_id: 'task',
            },
            error: null,
          }),
        )
        .mockReturnValueOnce(
          buildChain({
            data: [{ ...mockTask, id: 'child-1', parent_task_id: 'task-1' }],
            error: null,
          }),
        )
        .mockReturnValueOnce(buildChain({ data: [], error: null }));

      await expect(
        service.reorderTasks(SPACE, ORG, null, [
          { id: 'task-1', sort_order: 0, parent_task_id: 'child-1' },
        ]),
      ).rejects.toThrow(/circular dependency/);
    });
  });

  // ---- engine routing (Prompt 6) ---------------------------------------

  describe('engine routing (Prompt 6)', () => {
    let engineService: TasksService;
    let mockEngine: {
      resolveTransitionByStatusChange: jest.Mock;
      executeTransition: jest.Mock;
      getAvailableTransitions: jest.Mock;
      runInitialPostFunctions: jest.Mock;
    };
    let mockAssignments: {
      findActiveAssignmentForType: jest.Mock;
    };
    let mockAutomationOutbox: {
      emitTaskStatusChanged: jest.Mock;
      write: jest.Mock;
    };

    beforeEach(() => {
      mockEngine = {
        resolveTransitionByStatusChange: jest.fn(),
        executeTransition: jest.fn().mockResolvedValue({ id: 'task-1' }),
        getAvailableTransitions: jest.fn(),
        runInitialPostFunctions: jest.fn().mockResolvedValue(undefined),
      };
      mockAssignments = {
        findActiveAssignmentForType: jest.fn(),
      };
      mockAutomationOutbox = {
        emitTaskStatusChanged: jest.fn(),
        write: jest.fn(),
      };
      const supa = {
        getClient: () => ({
          from: mockFrom,
          rpc: mockRpc,
          storage: {
            from: jest.fn().mockReturnValue({ remove: storageRemove }),
          },
        }),
      } as unknown as SupabaseAdminService;

      engineService = new TasksService(
        supa,
        mockTaskHierarchyConfig as never,
        mockEngine as never,
        mockAssignments as never,
        mockAutomationOutbox as never,
      );
    });

    it('routes a status_id change through the engine when an assignment exists', async () => {
      const before = {
        ...mockTask,
        status: 'in_progress',
        status_id: 'status-in-progress',
      };
      const after = {
        ...mockTask,
        status: 'review',
        status_id: 'status-review',
      };
      mockAssignments.findActiveAssignmentForType.mockResolvedValueOnce({
        id: 'assign-1',
        workflow_id: 'wf-1',
        organization_id: ORG,
        space_id: SPACE,
        task_type_level_id: 'task',
        is_active: true,
      });
      mockEngine.resolveTransitionByStatusChange.mockResolvedValueOnce({
        transition: { id: 'tx-7', name: 'Submit for review' },
      });

      mockFrom
        .mockReturnValueOnce(buildChain({ data: before, error: null })) // getById (initial)
        .mockReturnValueOnce(
          buildChain({ data: { key: 'review' }, error: null }),
        ) // resolveStatusKeyById in validateUpdateTaskPatch
        .mockReturnValueOnce(
          buildChain({
            data: { email: 'real@example.com', auth_user_id: 'auth-1' },
            error: null,
          }),
        ) // H1 — buildEngineUser users SELECT
        .mockReturnValueOnce(buildChain({ data: after, error: null })); // final getById after engine

      const r = await engineService.update('task-1', ORG, 'user-1', {
        status_id: 'status-review',
      });

      expect(mockAssignments.findActiveAssignmentForType).toHaveBeenCalledWith(
        ORG,
        SPACE,
        'task',
      );
      expect(mockEngine.resolveTransitionByStatusChange).toHaveBeenCalledWith(
        'task-1',
        'status-review',
        // H1: engineUser now carries the real email loaded from users.
        expect.objectContaining({
          userId: 'user-1',
          organizationId: ORG,
          email: 'real@example.com',
        }),
      );
      expect(mockEngine.executeTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-1',
          transitionId: 'tx-7',
          screenInput: {},
          notifyWatchers: false,
        }),
      );
      expect(r.status_id).toBe('status-review');
      expect(mockAutomationOutbox.emitTaskStatusChanged).not.toHaveBeenCalled();
    });

    it('XE-T588 — gates a status_id change whose legacy bucket is unchanged (abgelehnt → geschlossen, both "done")', async () => {
      const before = {
        ...mockTask,
        status: 'done',
        status_id: 'status-abgelehnt',
      };

      mockAssignments.findActiveAssignmentForType.mockResolvedValueOnce({
        id: 'assign-1',
        workflow_id: 'wf-1',
        organization_id: ORG,
        space_id: SPACE,
        task_type_level_id: 'task',
        is_active: true,
      });
      mockEngine.resolveTransitionByStatusChange.mockResolvedValueOnce({
        error: 'no_path',
      });

      const updateChain = buildChain({ data: null, error: null });

      mockFrom
        .mockReturnValueOnce(buildChain({ data: before, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: { key: 'done' }, error: null })) // resolveStatusKeyById → same legacy bucket as before.status
        .mockReturnValueOnce(
          buildChain({
            data: { email: 'real@example.com', auth_user_id: 'auth-1' },
            error: null,
          }),
        ) // buildEngineUser users SELECT
        .mockReturnValueOnce(updateChain); // must never be reached

      await expect(
        engineService.update('task-1', ORG, 'user-1', {
          status_id: 'status-geschlossen',
        }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);

      expect(mockAssignments.findActiveAssignmentForType).toHaveBeenCalledWith(
        ORG,
        SPACE,
        'task',
      );
      expect(mockEngine.executeTransition).not.toHaveBeenCalled();
      expect(updateChain.update).not.toHaveBeenCalled();
    });

    it('B5 — routes custom_field_values to engine.screenInput (not otherPatch)', async () => {
      const before = {
        ...mockTask,
        status: 'in_progress',
        status_id: 'status-in-progress',
      };
      const after = {
        ...mockTask,
        status: 'review',
        status_id: 'status-review',
      };

      mockAssignments.findActiveAssignmentForType.mockResolvedValueOnce({
        id: 'assign-1',
        workflow_id: 'wf-1',
        organization_id: ORG,
        space_id: SPACE,
        task_type_level_id: 'task',
        is_active: true,
      });
      mockEngine.resolveTransitionByStatusChange.mockResolvedValueOnce({
        transition: { id: 'tx-7', name: 'Submit for review' },
      });

      mockFrom
        .mockReturnValueOnce(buildChain({ data: before, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // issue group fields of the space
        .mockReturnValueOnce(
          buildChain({ data: { key: 'review' }, error: null }),
        ) // resolveStatusKeyById
        .mockReturnValueOnce(
          buildChain({
            data: { email: 'real@example.com', auth_user_id: 'auth-1' },
            error: null,
          }),
        ) // H1 — buildEngineUser users SELECT
        .mockReturnValueOnce(buildChain({ data: after, error: null })); // final getById

      await engineService.update('task-1', ORG, 'user-1', {
        status_id: 'status-review',
        custom_field_values: { 'fld-severity': 'high', 'fld-note': 'urgent' },
      });

      // The engine call must receive the CFV map as screenInput so validators
      // see the fresh values, NOT a secondary UPDATE that lands after engine
      // post-functions have already run.
      expect(mockEngine.executeTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-1',
          transitionId: 'tx-7',
          screenInput: { 'fld-severity': 'high', 'fld-note': 'urgent' },
        }),
      );
    });

    it('falls back to the legacy update flow when there is no workflow assignment', async () => {
      mockAssignments.findActiveAssignmentForType.mockResolvedValueOnce(null);

      const before = {
        ...mockTask,
        status: 'in_progress',
        status_id: 'status-in-progress',
      };
      const updateChain = buildChain({
        data: { ...before, status: 'review', status_id: 'status-review' },
        error: null,
      });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: before, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({ data: { key: 'review' }, error: null }),
        ) // resolveStatusKeyById
        .mockReturnValueOnce(updateChain); // legacy UPDATE

      await engineService.update('task-1', ORG, 'user-1', {
        status_id: 'status-review',
      });

      expect(mockAssignments.findActiveAssignmentForType).toHaveBeenCalledWith(
        ORG,
        SPACE,
        'task',
      );
      expect(mockEngine.resolveTransitionByStatusChange).not.toHaveBeenCalled();
      expect(mockEngine.executeTransition).not.toHaveBeenCalled();
      expect(updateChain.update).toHaveBeenCalled();
    });

    it('skips the engine when the update has no status change', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTask, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({
            data: { ...mockTask, summary: 'Updated' },
            error: null,
          }),
        ); // legacy UPDATE

      await engineService.update('task-1', ORG, 'user-1', {
        summary: 'Updated',
      });

      expect(
        mockAssignments.findActiveAssignmentForType,
      ).not.toHaveBeenCalled();
      expect(mockEngine.resolveTransitionByStatusChange).not.toHaveBeenCalled();
      expect(mockEngine.executeTransition).not.toHaveBeenCalled();
    });

    it('overrides the initial status with the workflow assignment on create and runs initial post-functions', async () => {
      mockAssignments.findActiveAssignmentForType.mockResolvedValueOnce({
        id: 'assign-1',
        workflow_id: 'wf-1',
        organization_id: ORG,
        space_id: SPACE,
        task_type_level_id: 'task',
        is_active: true,
      });

      const insertChain = buildChain({
        data: {
          ...mockTask,
          status: 'todo',
          status_id: 'status-wf-initial',
        },
        error: null,
      });

      mockFrom
        .mockReturnValueOnce(
          buildChain({ data: { id: 'status-default' }, error: null }),
        ) // resolveStatusIdByKey('open') in resolveTaskStatusForWrite
        .mockReturnValueOnce(
          buildChain({
            data: [{ id: 'priority-medium', key: 'medium', space_id: null }],
            error: null,
          }),
        ) // resolvePriorityIdByKey('medium') in resolveTaskPriorityForWrite
        .mockReturnValueOnce(
          buildChain({
            data: {
              id: 'wf-1',
              initial_status_id: 'status-wf-initial',
            },
            error: null,
          }),
        ) // workflows lookup
        .mockReturnValueOnce(
          buildChain({
            data: {
              key: 'todo',
              is_completed: false,
              status_categories: { key: 'todo' },
            },
            error: null,
          }),
        ) // resolveStatusRowById for initial_status_id — a CUSTOM key ('todo' is not one of the six)
        .mockReturnValueOnce(insertChain) // INSERT
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // audit_logs insert (fire-and-forget)
        .mockReturnValueOnce(
          buildChain({ data: { id: 'tx-initial' }, error: null }),
        ); // workflow_transitions lookup

      await engineService.create(ORG, 'user-1', {
        space_id: SPACE,
        task_type_id: 'task',
        summary: 'New workflow task',
      });

      expect(mockAssignments.findActiveAssignmentForType).toHaveBeenCalledWith(
        ORG,
        SPACE,
        'task',
      );
      // The workflow's initial status has the CUSTOM key 'todo'. `status_id` carries it faithfully,
      // but the legacy `tasks.status` column is NOT NULL with
      // CHECK (open|in_progress|review|done|closed|blocked) — so 'todo' is bucketed to 'open' via
      // its category. This assertion previously expected `status: 'todo'`, which passed only
      // because the DB is mocked here: against the real schema that INSERT raises 23514, so no
      // task could ever be created under a workflow whose initial status was custom.
      expect(insertChain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'open',
          status_id: 'status-wf-initial',
        }),
      );
      expect(mockEngine.runInitialPostFunctions).toHaveBeenCalledWith(
        'task-1',
        'tx-initial',
        expect.any(Object),
      );
    });
  });

  // MCP-facing member-space reads.

  // ---- bulk status change: workflow condition gating -------------------

  describe('bulkUpdateTasks — condition gating', () => {
    let bulkService: TasksService;
    let mockEngine: {
      resolveTransitionByStatusChange: jest.Mock;
      executeTransition: jest.Mock;
      getAvailableTransitions: jest.Mock;
      runInitialPostFunctions: jest.Mock;
    };
    let mockAssignments: { findActiveAssignmentForType: jest.Mock };

    beforeEach(() => {
      mockEngine = {
        resolveTransitionByStatusChange: jest.fn(),
        executeTransition: jest.fn().mockResolvedValue({ id: 't1' }),
        getAvailableTransitions: jest.fn(),
        runInitialPostFunctions: jest.fn().mockResolvedValue(undefined),
      };
      mockAssignments = { findActiveAssignmentForType: jest.fn() };
      const supa = {
        getClient: () => ({
          from: mockFrom,
          rpc: mockRpc,
          storage: {
            from: jest.fn().mockReturnValue({ remove: storageRemove }),
          },
        }),
      } as unknown as SupabaseAdminService;

      bulkService = new TasksService(
        supa,
        mockTaskHierarchyConfig as never,
        mockEngine as never,
        mockAssignments as never,
      );
    });

    // buildEngineUser runs one users SELECT before the per-task loop.
    function mockBuildEngineUser() {
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: { email: 'real@example.com', auth_user_id: 'auth-1' },
          error: null,
        }),
      );
    }

    // The scope read (id, space_id, task_type_id) runs once before the loop.
    function mockScopeRows(rows: Array<{ id: string; space_id?: string }>) {
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: rows.map((r) => ({
            id: r.id,
            space_id: r.space_id ?? 'space-1',
            task_type_id: 'level-1',
          })),
          error: null,
        }),
      );
    }

    // Phase 2 direct status write: key lookup, before-snapshot, update.
    function mockDirectStatusWrite() {
      mockFrom
        .mockReturnValueOnce(
          buildChain({ data: { key: 'review' }, error: null }),
        ) // status key lookup
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // before-status snapshot for the automation event
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // direct update
    }

    const noSkips = { skipped: 0, skipped_reasons: [] };

    it('blocks a condition-refused status change instead of direct-writing it', async () => {
      mockEngine.resolveTransitionByStatusChange.mockResolvedValue({
        error: 'condition_failed',
        blockedTransition: { id: 'tx-1', name: 'Start' },
      });
      mockAssignments.findActiveAssignmentForType.mockResolvedValue({
        workflow_id: 'wf-1',
      });
      mockBuildEngineUser();
      mockScopeRows([{ id: 't1' }, { id: 't2' }]);

      const r = await bulkService.bulkUpdateTasks(ORG, 'user-1', ['t1', 't2'], {
        status_id: 'status-review',
      });

      expect(mockEngine.executeTransition).not.toHaveBeenCalled();
      // Only buildEngineUser + the scope read touched the DB — no status write.
      expect(mockFrom).toHaveBeenCalledTimes(2);
      expect(r).toEqual({ success: true, updated: 0, blocked: 2, ...noSkips });
    });

    it('blocks when executeTransition throws ForbiddenException on execute (condition re-check)', async () => {
      mockEngine.resolveTransitionByStatusChange.mockResolvedValue({
        transition: { id: 'tx-1', name: 'Start' },
      });
      mockEngine.executeTransition.mockRejectedValue(
        new ForbiddenException('Condition failed: parent_status_is'),
      );
      mockAssignments.findActiveAssignmentForType.mockResolvedValue({
        workflow_id: 'wf-1',
      });
      mockBuildEngineUser();
      mockScopeRows([{ id: 't1' }]);

      const r = await bulkService.bulkUpdateTasks(ORG, 'user-1', ['t1'], {
        status_id: 'status-review',
      });

      expect(mockFrom).toHaveBeenCalledTimes(2); // no direct write
      expect(r).toEqual({ success: true, updated: 0, blocked: 1, ...noSkips });
    });

    it('still direct-writes a no_path status change for a task WITHOUT a workflow assignment (non-regression)', async () => {
      mockEngine.resolveTransitionByStatusChange.mockResolvedValue({
        error: 'no_path',
      });
      mockAssignments.findActiveAssignmentForType.mockResolvedValue(null);
      mockBuildEngineUser();
      mockScopeRows([{ id: 't1' }]);
      mockDirectStatusWrite();

      const r = await bulkService.bulkUpdateTasks(ORG, 'user-1', ['t1'], {
        status_id: 'status-review',
      });

      expect(mockEngine.executeTransition).not.toHaveBeenCalled();
      expect(mockFrom).toHaveBeenCalledTimes(5);
      expect(r).toEqual({ success: true, updated: 1, blocked: 0, ...noSkips });
    });

    it('skips (never direct-writes) a no_path status change for a task under a workflow (XE-T588)', async () => {
      mockEngine.resolveTransitionByStatusChange.mockResolvedValue({
        error: 'no_path',
      });
      mockAssignments.findActiveAssignmentForType.mockResolvedValue({
        workflow_id: 'wf-1',
      });
      mockBuildEngineUser();
      mockScopeRows([{ id: 't1' }]);

      const r = await bulkService.bulkUpdateTasks(ORG, 'user-1', ['t1'], {
        status_id: 'status-review',
      });

      expect(mockEngine.executeTransition).not.toHaveBeenCalled();
      expect(mockFrom).toHaveBeenCalledTimes(2); // no direct write
      expect(r).toEqual({
        success: true,
        updated: 0,
        blocked: 0,
        skipped: 1,
        skipped_reasons: [{ task_id: 't1', reason: 'no_path' }],
      });
    });

    it('skips multiple_paths, validator, conflict and resolver failures under a workflow with reasons', async () => {
      mockEngine.resolveTransitionByStatusChange.mockImplementation(
        (taskId: string) => {
          if (taskId === 't1')
            return Promise.resolve({ error: 'multiple_paths', candidates: [] });
          if (taskId === 't4') return Promise.reject(new Error('infra down'));

          return Promise.resolve({ transition: { id: `tx-${taskId}` } });
        },
      );
      mockEngine.executeTransition.mockImplementation(
        ({ taskId }: { taskId: string }) =>
          Promise.reject(
            taskId === 't2'
              ? new UnprocessableEntityException('Validation failed')
              : new ConflictException('Task version mismatch'),
          ),
      );
      mockAssignments.findActiveAssignmentForType.mockResolvedValue({
        workflow_id: 'wf-1',
      });
      mockBuildEngineUser();
      mockScopeRows([{ id: 't1' }, { id: 't2' }, { id: 't3' }, { id: 't4' }]);

      const r = await bulkService.bulkUpdateTasks(
        ORG,
        'user-1',
        ['t1', 't2', 't3', 't4'],
        { status_id: 'status-review' },
      );

      expect(mockFrom).toHaveBeenCalledTimes(2); // no direct write
      // Same space/type for all four → one assignment lookup.
      expect(mockAssignments.findActiveAssignmentForType).toHaveBeenCalledTimes(
        1,
      );
      expect(r).toEqual({
        success: true,
        updated: 0,
        blocked: 0,
        skipped: 4,
        skipped_reasons: [
          { task_id: 't1', reason: 'multiple_paths' },
          { task_id: 't2', reason: 'validation_failed' },
          { task_id: 't3', reason: 'conflict' },
          { task_id: 't4', reason: 'error' },
        ],
      });
    });

    it('handles a mixed selection: skips the workflow task, direct-writes the non-workflow task, transitions the valid one', async () => {
      mockEngine.resolveTransitionByStatusChange.mockImplementation(
        (taskId: string) =>
          Promise.resolve(
            taskId === 't3'
              ? { transition: { id: 'tx-valid' } }
              : { error: 'no_path' },
          ),
      );
      mockAssignments.findActiveAssignmentForType.mockImplementation(
        (_org: string, spaceId: string) =>
          Promise.resolve(
            spaceId === 'space-legacy' ? null : { workflow_id: 'wf-1' },
          ),
      );
      mockBuildEngineUser();
      mockScopeRows([
        { id: 't1' },
        { id: 't2', space_id: 'space-legacy' },
        { id: 't3' },
      ]);
      mockDirectStatusWrite();

      const r = await bulkService.bulkUpdateTasks(
        ORG,
        'user-1',
        ['t1', 't2', 't3'],
        { status_id: 'status-review' },
      );

      expect(mockEngine.executeTransition).toHaveBeenCalledTimes(1);
      expect(mockEngine.executeTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 't3',
          transitionId: 'tx-valid',
          notifyWatchers: false,
        }),
      );
      expect(mockAssignments.findActiveAssignmentForType).toHaveBeenCalledTimes(
        2,
      );
      expect(r).toEqual({
        success: true,
        updated: 2,
        blocked: 0,
        skipped: 1,
        skipped_reasons: [{ task_id: 't1', reason: 'no_path' }],
      });
    });

    it('notifies each successfully bulk-updated task once after the write', async () => {
      const watchers = { notifyTaskWatchers: jest.fn() };
      const supa = {
        getClient: () => ({
          from: mockFrom,
          rpc: mockRpc,
          storage: {
            from: jest.fn().mockReturnValue({ remove: storageRemove }),
          },
        }),
      } as unknown as SupabaseAdminService;
      const serviceWithWatchers = new TasksService(
        supa,
        mockTaskHierarchyConfig as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        watchers as never,
      );
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(
          buildChain({
            data: [
              {
                id: 't1',
                key: 'OPS-1',
                summary: 'One',
                space_id: SPACE,
              },
              {
                id: 't2',
                key: 'OPS-2',
                summary: 'Two',
                space_id: SPACE,
              },
            ],
            error: null,
          }),
        );

      await serviceWithWatchers.bulkUpdateTasks(ORG, 'user-1', ['t1', 't2'], {
        due_date: '2026-10-01',
      });

      expect(watchers.notifyTaskWatchers).toHaveBeenCalledTimes(2);
      expect(watchers.notifyTaskWatchers).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG,
          taskId: 't1',
          actorUserId: 'user-1',
          changeKind: 'bulk_updated',
        }),
      );
    });
  });

  describe('MCP-facing member-space task reads', () => {
    let mcpService: TasksService;
    let mcpFrom: jest.Mock;
    let permissionsService: {
      isAdminOrOwner: jest.Mock;
      getUserSpacePermissions: jest.Mock;
      getUserEffectivePermissions: jest.Mock;
    };

    const userOf = (overrides: Record<string, unknown> = {}) =>
      ({
        authUserId: 'auth-1',
        userId: 'user-1',
        email: 'user@example.com',
        organizationId: ORG,
        memberships: [],
        ...overrides,
      }) as unknown as import('../auth/interfaces/request-user.interface').RequestUser;

    // A chain whose terminal `await` resolves to the given value and that
    // supports the operators used by the MCP wrappers (or/in/lt/gt/limit).
    const chainOf = (resolved: {
      data: unknown;
      error: unknown;
      count?: number;
    }) => {
      const chain: Record<string, jest.Mock> = {};
      const self = () => chain;
      chain.select = jest.fn().mockImplementation(self);
      chain.eq = jest.fn().mockImplementation(self);
      chain.in = jest.fn().mockImplementation(self);
      chain.or = jest.fn().mockImplementation(self);
      chain.gt = jest.fn().mockImplementation(self);
      chain.lt = jest.fn().mockImplementation(self);
      chain.gte = jest.fn().mockImplementation(self);
      chain.lte = jest.fn().mockImplementation(self);
      chain.order = jest.fn().mockImplementation(self);
      chain.limit = jest.fn().mockImplementation(self);
      chain.range = jest.fn().mockImplementation(self);
      chain.not = jest.fn().mockImplementation(self);
      chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
      chain.single = jest.fn().mockResolvedValue(resolved);
      (
        chain as unknown as {
          then: (cb: (v: unknown) => unknown) => Promise<unknown>;
        }
      ).then = (cb: (v: unknown) => unknown) =>
        Promise.resolve(resolved).then(cb);

      return chain;
    };

    // Reads the first argument passed to a chain's `.or(...)` (the space-id
    // constraint) as a string, avoiding unsafe `any` member access in tests.
    const firstOrArg = (chain: Record<string, jest.Mock>): string => {
      const calls = chain.or.mock.calls as unknown as unknown[][];

      return (calls[0]?.[0] as string) ?? '';
    };

    const memberPerms = {
      isMember: true,
      spaceRole: 'member',
      globalRole: 'member',
      permissions: { view_tasks: true },
    };
    const nonMemberPerms = {
      isMember: false,
      spaceRole: null,
      globalRole: 'member',
      permissions: {},
    };

    const candidateSpacesChain = () =>
      chainOf({
        data: [
          { id: 'space-1', key: 'ENG', name: 'Engineering' },
          { id: 'space-2', key: 'SEC', name: 'Secret' },
        ],
        error: null,
      });

    const effectiveOf = (canViewTasks: boolean) => ({
      user_id: 'user-1',
      base_role: 'member',
      custom_roles: [],
      groups: [],
      effective_permissions: { can_view_tasks: canViewTasks },
    });

    beforeEach(() => {
      mcpFrom = jest.fn();
      const supa = {
        getClient: () => ({
          from: mcpFrom,
          rpc: jest.fn(),
          storage: { from: jest.fn() },
        }),
      } as unknown as SupabaseAdminService;

      permissionsService = {
        isAdminOrOwner: jest.fn().mockResolvedValue(false),
        getUserSpacePermissions: jest.fn(),
        getUserEffectivePermissions: jest
          .fn()
          .mockResolvedValue(effectiveOf(false)),
      };

      mcpService = new TasksService(
        supa,
        mockTaskHierarchyConfig as never,
        undefined,
        undefined,
        undefined,
        permissionsService as never,
      );
    });

    // searchMyTasks

    describe('searchMyTasks', () => {
      it('returns { tasks: [] } (never null) for the onboarding org', async () => {
        const result = await mcpService.searchMyTasks(
          userOf({ organizationId: '' }),
        );

        expect(result).toEqual({ tasks: [] });
        expect(mcpFrom).not.toHaveBeenCalled();
      });

      it('member sees only member-space tasks; non-member space hidden', async () => {
        permissionsService.getUserSpacePermissions
          .mockResolvedValueOnce(memberPerms) // space-1 member
          .mockResolvedValueOnce(nonMemberPerms); // space-2 not member

        const tasksChain = chainOf({
          data: [
            {
              id: 'task-1',
              key: 'ENG-1',
              summary: 'A',
              status: 'open',
              priority: 'medium',
              due_date: null,
              space_id: 'space-1',
              updated_at: '2025-01-02T00:00:00Z',
              assigned_to: null,
              assignee: null,
            },
          ],
          error: null,
          count: 1,
        });

        mcpFrom
          .mockReturnValueOnce(candidateSpacesChain()) // resolveAccessible: spaces
          .mockReturnValueOnce(tasksChain); // task search

        const result = await mcpService.searchMyTasks(userOf());

        expect(result.tasks).toHaveLength(1);
        expect(result.tasks[0].space).toEqual({
          id: 'space-1',
          key: 'ENG',
          name: 'Engineering',
        });
        // the .or() constraint includes only the member space id, not space-2
        const orArg = firstOrArg(tasksChain);

        expect(orArg).toContain('space-1');
        expect(orArg).not.toContain('space-2');
      });

      it('admin/owner sees all non-archived org spaces without per-space checks', async () => {
        permissionsService.isAdminOrOwner.mockResolvedValue(true);

        const tasksChain = chainOf({ data: [], error: null, count: 0 });

        mcpFrom
          .mockReturnValueOnce(candidateSpacesChain())
          .mockReturnValueOnce(tasksChain);

        const result = await mcpService.searchMyTasks(userOf());

        expect(result.tasks).toEqual([]);
        expect(
          permissionsService.getUserSpacePermissions,
        ).not.toHaveBeenCalled();
        const orArg = firstOrArg(tasksChain);

        expect(orArg).toContain('space-1');
        expect(orArg).toContain('space-2');
      });

      it('matches the free-text query against the task key too (e.g. "XE-T353")', async () => {
        permissionsService.isAdminOrOwner.mockResolvedValue(true);

        const tasksChain = chainOf({ data: [], error: null, count: 0 });

        mcpFrom
          .mockReturnValueOnce(candidateSpacesChain())
          .mockReturnValueOnce(tasksChain);

        await mcpService.searchMyTasks(userOf(), { query: 'XE-T353' });

        const orArgs = tasksChain.or.mock.calls.map((call: unknown[]) =>
          String(call[0]),
        );

        expect(orArgs).toContain(
          'key.ilike.%XE-T353%,summary.ilike.%XE-T353%,description.ilike.%XE-T353%',
        );
      });

      it('excludes org-level (NULL) tasks unless org can_view_tasks is set', async () => {
        permissionsService.getUserSpacePermissions
          .mockResolvedValueOnce(memberPerms)
          .mockResolvedValueOnce(nonMemberPerms);
        // no org can_view_tasks, so effectiveOf(false) from beforeEach
        const tasksChain = chainOf({ data: [], error: null, count: 0 });

        mcpFrom
          .mockReturnValueOnce(candidateSpacesChain())
          .mockReturnValueOnce(tasksChain);

        await mcpService.searchMyTasks(userOf());

        const orArg = firstOrArg(tasksChain);

        expect(orArg).not.toContain('space_id.is.null');
      });

      it('includes org-level (NULL) tasks when org can_view_tasks is true', async () => {
        permissionsService.getUserEffectivePermissions.mockResolvedValue(
          effectiveOf(true),
        );
        permissionsService.getUserSpacePermissions
          .mockResolvedValueOnce(memberPerms)
          .mockResolvedValueOnce(nonMemberPerms);
        const tasksChain = chainOf({ data: [], error: null, count: 0 });

        mcpFrom
          .mockReturnValueOnce(candidateSpacesChain())
          .mockReturnValueOnce(tasksChain);

        await mcpService.searchMyTasks(userOf());

        const orArg = firstOrArg(tasksChain);

        expect(orArg).toContain('space_id.is.null');
      });

      it('returns empty for a non-member spaceIdOrKey (no existence leak)', async () => {
        permissionsService.getUserSpacePermissions
          .mockResolvedValueOnce(memberPerms)
          .mockResolvedValueOnce(nonMemberPerms);

        mcpFrom
          .mockReturnValueOnce(candidateSpacesChain()) // resolveAccessible
          .mockReturnValueOnce(
            chainOf({ data: { id: 'space-2' }, error: null }),
          ); // resolveSpaceIdOrKey

        const result = await mcpService.searchMyTasks(userOf(), {
          spaceIdOrKey: 'SEC',
        });

        expect(result).toEqual({ tasks: [] });
      });

      it('maps assignee="me" to the caller userId', async () => {
        permissionsService.getUserSpacePermissions.mockResolvedValueOnce(
          memberPerms,
        );
        const oneSpace = chainOf({
          data: [{ id: 'space-1', key: 'ENG', name: 'Engineering' }],
          error: null,
        });
        const tasksChain = chainOf({ data: [], error: null, count: 0 });

        mcpFrom.mockReturnValueOnce(oneSpace).mockReturnValueOnce(tasksChain);

        await mcpService.searchMyTasks(userOf(), { assignedTo: 'me' });

        expect(tasksChain.eq).toHaveBeenCalledWith('assigned_to', 'user-1');
      });

      it('clamps limit to a maximum of 50', async () => {
        permissionsService.isAdminOrOwner.mockResolvedValue(true);
        const tasksChain = chainOf({ data: [], error: null, count: 0 });

        mcpFrom
          .mockReturnValueOnce(candidateSpacesChain())
          .mockReturnValueOnce(tasksChain);

        await mcpService.searchMyTasks(userOf(), { limit: 999 });

        // limit + 1 fetched; 50 clamp gives 51
        expect(tasksChain.limit).toHaveBeenCalledWith(51);
      });

      // Page mode + details back the web My Work list (XE-T717); the cursor mode above is untouched.
      describe('page mode (web My Work list)', () => {
        const row = {
          id: 'task-1',
          key: 'ENG-1',
          summary: 'A',
          status: 'open',
          priority: 'medium',
          due_date: null,
          space_id: 'space-1',
          updated_at: '2025-01-02T00:00:00Z',
          assigned_to: 'user-1',
          assignee: null,
          task_type_id: 'story',
          version: 7,
          status_config: {
            id: 'st-1',
            name: 'To Do',
            key: 'todo',
            color: '#888',
            is_completed: false,
          },
          priority_config: {
            id: 'pr-1',
            name: 'Medium',
            key: 'medium',
            color: '#f90',
          },
          process: { id: 'proc-1', title: 'ISO 27001' },
        };

        it('pages by offset with an exact total and a stable id tie-break, without a cursor', async () => {
          permissionsService.isAdminOrOwner.mockResolvedValue(true);
          // Last page of 23 at 10 per page: rows 21-23.
          const lastPage = ['task-21', 'task-22', 'task-23'].map((id) => ({
            ...row,
            id,
          }));
          const tasksChain = chainOf({
            data: lastPage,
            error: null,
            count: 23,
          });

          mcpFrom
            .mockReturnValueOnce(candidateSpacesChain())
            .mockReturnValueOnce(tasksChain);

          const result = await mcpService.searchMyTasks(userOf(), {
            page: 3,
            pageSize: 10,
            sortBy: 'dueDate',
          });

          expect(tasksChain.range).toHaveBeenCalledWith(20, 29);
          expect(tasksChain.limit).not.toHaveBeenCalled();
          expect(tasksChain.order).toHaveBeenCalledWith('due_date', {
            ascending: true,
            nullsFirst: false,
          });
          expect(tasksChain.order).toHaveBeenLastCalledWith('id', {
            ascending: true,
          });
          expect(result).toMatchObject({
            total: 23,
            page: 3,
            pageSize: 10,
            hasMore: false,
          });
          expect(result.nextCursor).toBeUndefined();
          // No details asked for: the item keeps the MCP-safe shape exactly.
          expect(Object.keys(result.tasks[0]).sort()).toEqual(
            [
              'assignee',
              'dueDate',
              'id',
              'key',
              'priority',
              'space',
              'status',
              'summary',
              'updatedAt',
            ].sort(),
          );
        });

        it('reports more pages while the total is not reached', async () => {
          permissionsService.isAdminOrOwner.mockResolvedValue(true);
          const firstPage = Array.from({ length: 10 }, (_, i) => ({
            ...row,
            id: `task-${i}`,
          }));
          const tasksChain = chainOf({
            data: firstPage,
            error: null,
            count: 23,
          });

          mcpFrom
            .mockReturnValueOnce(candidateSpacesChain())
            .mockReturnValueOnce(tasksChain);

          const result = await mcpService.searchMyTasks(userOf(), {
            page: 1,
            pageSize: 10,
          });

          expect(tasksChain.range).toHaveBeenCalledWith(0, 9);
          expect(result).toMatchObject({ total: 23, page: 1, hasMore: true });
          expect(result.tasks).toHaveLength(10);
        });

        it('clamps the page size to 100 and the page to at least 1', async () => {
          permissionsService.isAdminOrOwner.mockResolvedValue(true);
          const tasksChain = chainOf({ data: [], error: null, count: 0 });

          mcpFrom
            .mockReturnValueOnce(candidateSpacesChain())
            .mockReturnValueOnce(tasksChain);

          const result = await mcpService.searchMyTasks(userOf(), {
            page: 0,
            pageSize: 500,
          });

          expect(tasksChain.range).toHaveBeenCalledWith(0, 99);
          expect(result).toMatchObject({
            total: 0,
            page: 1,
            pageSize: 100,
            hasMore: false,
          });
        });

        it('withDetails adds status/priority config, process, version and the task type', async () => {
          permissionsService.isAdminOrOwner.mockResolvedValue(true);
          const tasksChain = chainOf({ data: [row], error: null, count: 1 });
          const hierarchyChain = chainOf({
            data: [
              {
                space_id: 'space-1',
                config: {
                  levels: [
                    {
                      id: 'story',
                      name: 'Story',
                      color: '#22c55e',
                      icon: 'bx-book',
                    },
                  ],
                },
              },
            ],
            error: null,
          });

          mcpFrom
            .mockReturnValueOnce(candidateSpacesChain())
            .mockReturnValueOnce(tasksChain)
            .mockReturnValueOnce(hierarchyChain);

          const result = await mcpService.searchMyTasks(userOf(), {
            page: 1,
            pageSize: 10,
            withDetails: true,
          });

          const select = String(
            (tasksChain.select.mock.calls as unknown[][])[0][0],
          );

          expect(select).toContain(
            'status_config:task_statuses!tasks_status_id_fkey',
          );
          expect(select).toContain(
            'priority_config:task_priorities!tasks_priority_id_fkey',
          );
          expect(select).toContain(
            'process:business_processes!tasks_process_id_fkey',
          );
          expect(result.tasks[0]).toMatchObject({
            statusConfig: { name: 'To Do' },
            priorityConfig: { name: 'Medium' },
            process: { id: 'proc-1', title: 'ISO 27001' },
            taskType: {
              id: 'story',
              name: 'Story',
              color: '#22c55e',
              icon: 'bx-book',
            },
            version: 7,
          });
        });

        it('overdue keeps only tasks due before now that are not done or closed', async () => {
          permissionsService.isAdminOrOwner.mockResolvedValue(true);
          const tasksChain = chainOf({ data: [], error: null, count: 0 });

          mcpFrom
            .mockReturnValueOnce(candidateSpacesChain())
            .mockReturnValueOnce(tasksChain);

          await mcpService.searchMyTasks(userOf(), { page: 1, overdue: true });

          expect(tasksChain.lt).toHaveBeenCalledWith(
            'due_date',
            expect.any(String),
          );
          expect(tasksChain.not).toHaveBeenCalledWith(
            'status',
            'in',
            '("done","closed")',
          );
        });
      });

      it('returns empty when the caller has no accessible spaces and no org view', async () => {
        permissionsService.getUserSpacePermissions
          .mockResolvedValueOnce(nonMemberPerms)
          .mockResolvedValueOnce(nonMemberPerms);

        mcpFrom.mockReturnValueOnce(candidateSpacesChain());

        const result = await mcpService.searchMyTasks(userOf());

        expect(result).toEqual({ tasks: [] });
      });

      it('flags truncated: true when the candidate scan hits TASK_SPACE_SCAN_CAP (FIX 2)', async () => {
        // Admin/owner fast-path so we do not have to mock 200 membership checks;
        // a full candidate prefix (== cap) is what trips truncation.
        permissionsService.isAdminOrOwner.mockResolvedValue(true);

        const CAP = 200; // mirrors TASK_SPACE_SCAN_CAP in the service
        const cappedSpaces = Array.from({ length: CAP }, (_unused, i) => ({
          id: `space-${i}`,
          key: `K${i}`,
          name: `Space ${i}`,
        }));
        const capChain = chainOf({ data: cappedSpaces, error: null });
        const tasksChain = chainOf({ data: [], error: null, count: 0 });

        mcpFrom.mockReturnValueOnce(capChain).mockReturnValueOnce(tasksChain);

        const result = await mcpService.searchMyTasks(userOf());

        expect(result.truncated).toBe(true);
      });

      it('does NOT set truncated when the scan is below the cap', async () => {
        permissionsService.isAdminOrOwner.mockResolvedValue(true);
        const tasksChain = chainOf({ data: [], error: null, count: 0 });

        mcpFrom
          .mockReturnValueOnce(candidateSpacesChain()) // 2 spaces << cap
          .mockReturnValueOnce(tasksChain);

        const result = await mcpService.searchMyTasks(userOf());

        expect(result.truncated).toBeUndefined();
      });

      it('NaN limit falls back to the default (no NaN to PostgREST) (FIX 3)', async () => {
        permissionsService.isAdminOrOwner.mockResolvedValue(true);
        const tasksChain = chainOf({ data: [], error: null, count: 0 });

        mcpFrom
          .mockReturnValueOnce(candidateSpacesChain())
          .mockReturnValueOnce(tasksChain);

        await mcpService.searchMyTasks(userOf(), { limit: Number.NaN });

        // default 25 + 1 fetched; NaN must never reach .limit()
        expect(tasksChain.limit).toHaveBeenCalledWith(26);
      });
    });

    // getMyTask

    describe('getMyTask', () => {
      const taskInSpace1 = {
        ...mockTask,
        id: 'task-1',
        space_id: 'space-1',
        version: 3,
        description: 'hello',
      };

      // getMyTask checks the task's specific space directly (no accessible-set
      // scan, no cap). The space-decision `from()` is an org-scoped +
      // archived-excluded `spaces` lookup; for a member space it resolves to
      // {id,key,name} and serves both the gate and enrichment.
      const spaceRowChain = (
        row: { id: string; key: string; name: string } | null,
        error: unknown = null,
      ) => chainOf({ data: row, error });

      const ENG_ROW = { id: 'space-1', key: 'ENG', name: 'Engineering' };

      it('returns a whitelisted task for a member space (direct check)', async () => {
        permissionsService.getUserSpacePermissions.mockResolvedValueOnce(
          memberPerms,
        );

        mcpFrom
          .mockReturnValueOnce(chainOf({ data: taskInSpace1, error: null })) // getById
          .mockReturnValueOnce(spaceRowChain(ENG_ROW)); // direct space lookup

        const { task } = await mcpService.getMyTask(
          userOf(),
          '11111111-1111-1111-1111-111111111111',
        );

        expect(task.id).toBe('task-1');
        expect(task.version).toBe(3);
        expect(task.space).toEqual({
          id: 'space-1',
          key: 'ENG',
          name: 'Engineering',
        });
        // the direct space check targets the task's own space, no scan/cap.
        expect(permissionsService.getUserSpacePermissions).toHaveBeenCalledWith(
          'user-1',
          ORG,
          'space-1',
        );
        // whitelist: no custom_field_values leaked
        expect(
          (task as unknown as Record<string, unknown>).custom_field_values,
        ).toBeUndefined();
      });

      it('member can get their OWN task in a space that would sort BEYOND the scan cap (FIX 1: no false 404)', async () => {
        // The space would never appear in a capped candidate prefix, but the
        // direct check resolves it and the membership passes, so the owner can
        // read their own task. This is exactly the silent-miss the direct check
        // closes.
        const beyondCapTask = {
          ...mockTask,
          id: 'task-beyond',
          space_id: 'space-zzz',
        };
        const BEYOND_ROW = {
          id: 'space-zzz',
          key: 'ZZZ',
          name: 'Beyond Cap',
        };

        permissionsService.getUserSpacePermissions.mockResolvedValueOnce(
          memberPerms,
        );

        mcpFrom
          .mockReturnValueOnce(chainOf({ data: beyondCapTask, error: null })) // getById
          .mockReturnValueOnce(spaceRowChain(BEYOND_ROW)); // direct space lookup

        const { task } = await mcpService.getMyTask(
          userOf(),
          '55555555-5555-5555-5555-555555555555',
        );

        expect(task.id).toBe('task-beyond');
        expect(task.space).toEqual(BEYOND_ROW);
        expect(permissionsService.getUserSpacePermissions).toHaveBeenCalledWith(
          'user-1',
          ORG,
          'space-zzz',
        );
        // no full candidate scan happened
        expect(
          permissionsService.getUserSpacePermissions,
        ).toHaveBeenCalledTimes(1);
      });

      it('throws a uniform 404 for a non-member space task', async () => {
        const taskInSpace2 = { ...mockTask, id: 'task-2', space_id: 'space-2' };

        permissionsService.getUserSpacePermissions.mockResolvedValueOnce(
          nonMemberPerms,
        );

        mcpFrom
          .mockReturnValueOnce(chainOf({ data: taskInSpace2, error: null }))
          .mockReturnValueOnce(
            spaceRowChain({ id: 'space-2', key: 'SEC', name: 'Secret' }),
          );

        await expect(
          mcpService.getMyTask(
            userOf(),
            '22222222-2222-2222-2222-222222222222',
          ),
        ).rejects.toThrow(NotFoundException);
      });

      it('throws a uniform 404 for an archived space task (FIX 4)', async () => {
        const taskInArchived = {
          ...mockTask,
          id: 'task-arc',
          space_id: 'space-arc',
        };

        // The archived-excluded lookup returns null, giving a uniform 404, and
        // we never even check membership.
        mcpFrom
          .mockReturnValueOnce(chainOf({ data: taskInArchived, error: null }))
          .mockReturnValueOnce(spaceRowChain(null));

        await expect(
          mcpService.getMyTask(
            userOf(),
            '66666666-6666-6666-6666-666666666666',
          ),
        ).rejects.toThrow(NotFoundException);
        expect(
          permissionsService.getUserSpacePermissions,
        ).not.toHaveBeenCalled();
      });

      it('throws a uniform 404 for a nonexistent / cross-org task (identical)', async () => {
        // getById throws NotFound (collapsed to uniform notFound)
        mcpFrom.mockReturnValueOnce(chainOf({ data: null, error: null }));

        await expect(
          mcpService.getMyTask(
            userOf(),
            '33333333-3333-3333-3333-333333333333',
          ),
        ).rejects.toThrow(NotFoundException);
      });

      it('admin/owner can read a space task (isMember via getUserSpacePermissions)', async () => {
        const taskInSpace2 = { ...mockTask, id: 'task-2', space_id: 'space-2' };

        // admin/owner is reflected by getUserSpacePermissions granting
        // isMember + view_tasks for any org space.
        permissionsService.getUserSpacePermissions.mockResolvedValueOnce(
          memberPerms,
        );

        mcpFrom
          .mockReturnValueOnce(chainOf({ data: taskInSpace2, error: null }))
          .mockReturnValueOnce(
            spaceRowChain({ id: 'space-2', key: 'SEC', name: 'Secret' }),
          );

        const { task } = await mcpService.getMyTask(
          userOf(),
          '22222222-2222-2222-2222-222222222222',
        );

        expect(task.id).toBe('task-2');
        expect(task.space).toEqual({
          id: 'space-2',
          key: 'SEC',
          name: 'Secret',
        });
      });

      it('org-level (NULL) task is visible only with org can_view_tasks', async () => {
        const orgTask = { ...mockTask, id: 'task-org', space_id: null };

        // No org can_view_tasks (effectiveOf(false) from beforeEach) gives 404.
        mcpFrom.mockReturnValueOnce(chainOf({ data: orgTask, error: null }));

        await expect(
          mcpService.getMyTask(
            userOf(),
            '44444444-4444-4444-4444-444444444444',
          ),
        ).rejects.toThrow(NotFoundException);
        // org-level decision uses effective perms, never a space membership.
        expect(
          permissionsService.getUserSpacePermissions,
        ).not.toHaveBeenCalled();
      });

      it('org-level (NULL) task IS visible when org can_view_tasks is true', async () => {
        const orgTask = {
          ...mockTask,
          id: 'task-org',
          space_id: null,
          version: 1,
        };

        permissionsService.getUserEffectivePermissions.mockResolvedValue(
          effectiveOf(true),
        );

        mcpFrom.mockReturnValueOnce(chainOf({ data: orgTask, error: null }));

        const { task } = await mcpService.getMyTask(
          userOf(),
          '44444444-4444-4444-4444-444444444444',
        );

        expect(task.id).toBe('task-org');
        expect(task.space).toBeNull();
      });

      it('truncates an oversized description and sets the flag', async () => {
        const big = 'x'.repeat(60 * 1024);
        const bigTask = { ...taskInSpace1, description: big };

        permissionsService.getUserSpacePermissions.mockResolvedValueOnce(
          memberPerms,
        );

        mcpFrom
          .mockReturnValueOnce(chainOf({ data: bigTask, error: null }))
          .mockReturnValueOnce(spaceRowChain(ENG_ROW));

        const { task } = await mcpService.getMyTask(
          userOf(),
          '11111111-1111-1111-1111-111111111111',
        );

        expect(task.description).toBe(big);
        expect(task.descriptionTruncated).toBeUndefined();
      });

      it('excludes comments when includeComments is false', async () => {
        permissionsService.getUserSpacePermissions.mockResolvedValueOnce(
          memberPerms,
        );

        mcpFrom
          .mockReturnValueOnce(chainOf({ data: taskInSpace1, error: null }))
          .mockReturnValueOnce(spaceRowChain(ENG_ROW));

        const result = await mcpService.getMyTask(
          userOf(),
          '11111111-1111-1111-1111-111111111111',
        );

        expect(result.comments).toBeUndefined();
      });

      it('includes capped + whitelisted comments when includeComments is true', async () => {
        permissionsService.getUserSpacePermissions.mockResolvedValueOnce(
          memberPerms,
        );

        const commentsChain = chainOf({
          data: [
            {
              id: 'c-1',
              content: 'Hi',
              created_at: '2025-01-03T00:00:00Z',
              author: {
                id: 'user-9',
                first_name: 'Ann',
                last_name: 'Lee',
                email: 'ann@example.com',
                avatar_url: 'secret',
              },
            },
          ],
          error: null,
        });

        mcpFrom
          .mockReturnValueOnce(chainOf({ data: taskInSpace1, error: null })) // getById
          .mockReturnValueOnce(spaceRowChain(ENG_ROW)) // direct space lookup
          .mockReturnValueOnce(commentsChain); // comments

        const result = await mcpService.getMyTask(
          userOf(),
          '11111111-1111-1111-1111-111111111111',
          { includeComments: true, commentLimit: 999 },
        );

        expect(result.comments).toHaveLength(1);
        expect(result.comments?.[0]).toEqual({
          id: 'c-1',
          author: { id: 'user-9', name: 'Ann Lee' },
          content: 'Hi',
          createdAt: '2025-01-03T00:00:00Z',
        });
        // commentLimit clamped to 25
        expect(commentsChain.limit).toHaveBeenCalledWith(25);
      });

      it('falls back to { comments: [] } (not 400) when the comments fetch errors (FIX 5)', async () => {
        permissionsService.getUserSpacePermissions.mockResolvedValueOnce(
          memberPerms,
        );

        const failingComments = chainOf({
          data: null,
          error: { message: 'comments boom' },
        });

        mcpFrom
          .mockReturnValueOnce(chainOf({ data: taskInSpace1, error: null })) // getById
          .mockReturnValueOnce(spaceRowChain(ENG_ROW)) // direct space lookup
          .mockReturnValueOnce(failingComments); // comments error

        const result = await mcpService.getMyTask(
          userOf(),
          '11111111-1111-1111-1111-111111111111',
          { includeComments: true },
        );

        expect(result.task.id).toBe('task-1');
        expect(result.comments).toEqual([]);
      });

      it('NaN commentLimit falls back to the default cap (no NaN to PostgREST) (FIX 3)', async () => {
        permissionsService.getUserSpacePermissions.mockResolvedValueOnce(
          memberPerms,
        );

        const commentsChain = chainOf({ data: [], error: null });

        mcpFrom
          .mockReturnValueOnce(chainOf({ data: taskInSpace1, error: null }))
          .mockReturnValueOnce(spaceRowChain(ENG_ROW))
          .mockReturnValueOnce(commentsChain);

        await mcpService.getMyTask(
          userOf(),
          '11111111-1111-1111-1111-111111111111',
          { includeComments: true, commentLimit: Number.NaN },
        );

        // NaN must not reach .limit(); it falls back to the 25 cap.
        expect(commentsChain.limit).toHaveBeenCalledWith(25);
      });
    });

    describe('getByKeyForViewer', () => {
      const asMember = (isMember: boolean, viewTasks: boolean) =>
        permissionsService.getUserSpacePermissions.mockResolvedValue({
          isMember,
          permissions: { view_tasks: viewTasks },
        });

      beforeEach(() => {
        jest
          .spyOn(mcpService, 'getByKey')
          .mockResolvedValue({ id: 'task-1', space_id: 'space-1' } as never);
      });

      it('returns the task to a space member with view_tasks', async () => {
        asMember(true, true);
        await expect(
          mcpService.getByKeyForViewer(userOf(), 'AMBER-T1'),
        ).resolves.toEqual({ id: 'task-1', space_id: 'space-1' });
      });

      it('hides a task in a space the reader cannot see (wiki task cards)', async () => {
        asMember(false, false);
        await expect(
          mcpService.getByKeyForViewer(userOf(), 'AMBER-T1'),
        ).rejects.toThrow('Task not found');
      });

      it('hides it from a member without view_tasks', async () => {
        asMember(true, false);
        await expect(
          mcpService.getByKeyForViewer(userOf(), 'AMBER-T1'),
        ).rejects.toThrow('Task not found');
      });

      it('keeps org-level tasks on the guard check alone', async () => {
        jest
          .spyOn(mcpService, 'getByKey')
          .mockResolvedValue({ id: 'task-2', space_id: null } as never);
        await expect(
          mcpService.getByKeyForViewer(userOf(), 'ORG-T2'),
        ).resolves.toEqual({ id: 'task-2', space_id: null });
        expect(permissionsService.getUserSpacePermissions).not.toHaveBeenCalled();
      });
    });
  });
});
