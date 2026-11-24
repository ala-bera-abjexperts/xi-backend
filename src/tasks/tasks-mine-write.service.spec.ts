/**
 * @fileoverview Unit tests for TasksMineWriteService — the MCP-facing,
 * space-membership + space-permission constrained task write path. Covers the
 * space gate (admin/owner bypass, member-with-permission allow, non-member
 * deny), the create-default task-type resolution, the optimistic-version claim
 * + conflict shape, and the uniform 404 anti-probing behaviour.
 * @module src/tasks/tasks-mine-write.service.spec
 * @author Prince Jadiya
 */

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

// TasksService transitively imports sanitize-rich-text → jsdom (ESM), which
// Jest cannot transform. We only need the TasksService *type* (it is mocked),
// so stub the sanitizer to keep the import chain CommonJS, exactly as the
// existing tasks.service.spec does.
jest.mock('../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (value: string | null | undefined) => value ?? null,
}));

import { TasksMineWriteService } from './tasks-mine-write.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { PermissionsService } from '../permissions/permissions.service';
import { TasksService } from './tasks.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';

const ORG = '11111111-1111-1111-1111-111111111111';
const SPACE = '22222222-2222-2222-2222-222222222222';
const TASK = '33333333-3333-3333-3333-333333333333';
const USER = '44444444-4444-4444-4444-444444444444';
const ASSIGNEE = '55555555-5555-5555-5555-555555555555';

const user: RequestUser = {
  authUserId: 'auth-1',
  userId: USER,
  email: 'caller@example.com',
  organizationId: ORG,
  memberships: [],
};

// A minimal PostgREST query-chain double: every builder method returns `this`,
// and the terminal `maybeSingle`/`single`/thenable resolve to `resolved`.
function buildChain(resolved: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = jest.fn().mockImplementation(self);
  chain.eq = jest.fn().mockImplementation(self);
  chain.in = jest.fn().mockImplementation(self);
  chain.or = jest.fn().mockImplementation(self);
  chain.limit = jest.fn().mockImplementation(self);
  chain.update = jest.fn().mockImplementation(self);
  chain.insert = jest.fn().mockImplementation(self);
  chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
  chain.single = jest.fn().mockResolvedValue(resolved);
  chain.then = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve(resolved).then(onFulfilled);
  return chain;
}

const defaultTaskType = {
  id: 'task',
  name: 'Task',
  parent_level_id: null,
  allowed_parent_types: [],
  allowed_child_types: [],
  default_status: 'open',
  default_priority: 'medium',
  is_active: true,
};

const createdTaskRow = {
  id: TASK,
  key: 'SP-T1',
  space_id: SPACE,
  summary: 'Fix login bug',
  description: null,
  status: 'open',
  priority: 'medium',
  assigned_to: null,
  reporter: USER,
  due_date: null,
  labels: [],
  version: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

describe('TasksMineWriteService', () => {
  let service: TasksMineWriteService;
  let mockFrom: jest.Mock;
  let permissions: {
    isAdminOrOwner: jest.Mock;
    getUserSpacePermissions: jest.Mock;
  };
  let tasks: {
    create: jest.Mock;
    update: jest.Mock;
    createComment: jest.Mock;
    getActiveTaskTypesForSpace: jest.Mock;
  };

  beforeEach(() => {
    mockFrom = jest.fn();
    const supa = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;

    permissions = {
      isAdminOrOwner: jest.fn().mockResolvedValue(false),
      getUserSpacePermissions: jest.fn(),
    };

    tasks = {
      create: jest.fn().mockResolvedValue(createdTaskRow),
      update: jest.fn().mockResolvedValue({ ...createdTaskRow, version: 2 }),
      createComment: jest.fn(),
      getActiveTaskTypesForSpace: jest
        .fn()
        .mockResolvedValue([defaultTaskType]),
    };

    service = new TasksMineWriteService(
      supa,
      permissions as unknown as PermissionsService,
      tasks as unknown as TasksService,
    );
  });

  // Allow a member with the given short space permission.
  function grantSpacePermission(key: string) {
    permissions.getUserSpacePermissions.mockResolvedValue({
      isMember: true,
      spaceRole: 'member',
      globalRole: 'member',
      permissions: { [key]: true },
    });
  }

  // ---- create ------------------------------------------------------------

  describe('createTask', () => {
    it('creates a task in an accessible (member + create_tasks) space', async () => {
      grantSpacePermission('create_tasks');
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: SPACE }, error: null })) // resolveSpaceIdOrKey
        .mockReturnValueOnce(
          buildChain({
            data: { id: SPACE, key: 'SP', name: 'Space' },
            error: null,
          }),
        ) // toSafeTask space lookup
        .mockReturnValueOnce(
          buildChain({
            data: [{ id: USER, first_name: 'A', last_name: 'B' }],
            error: null,
          }),
        ); // toSafeTask users lookup (reporter)

      const result = await service.createTask(user, {
        spaceIdOrKey: 'SP',
        summary: 'Fix login bug',
      });

      expect(tasks.create).toHaveBeenCalledWith(
        ORG,
        USER,
        expect.objectContaining({
          space_id: SPACE,
          summary: 'Fix login bug',
          task_type_id: 'task',
        }),
      );
      expect(result.task.id).toBe(TASK);
      expect(result.task.space).toEqual({
        id: SPACE,
        key: 'SP',
        name: 'Space',
      });
    });

    it('derives the default task_type_id from the space hierarchy config', async () => {
      grantSpacePermission('create_tasks');
      // No `task` level present → first active root type is chosen.
      tasks.getActiveTaskTypesForSpace.mockResolvedValue([
        { id: 'epic', parent_level_id: null, is_active: true },
        { id: 'subtask', parent_level_id: 'epic', is_active: true },
      ]);
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: SPACE }, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(buildChain({ data: [], error: null }));

      await service.createTask(user, { spaceIdOrKey: SPACE, summary: 'x' });

      expect(tasks.create).toHaveBeenCalledWith(
        ORG,
        USER,
        expect.objectContaining({ task_type_id: 'epic' }),
      );
    });

    it('lets an org admin/owner create without space membership', async () => {
      permissions.isAdminOrOwner.mockResolvedValue(true);
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: SPACE }, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(buildChain({ data: [], error: null }));

      await service.createTask(user, { spaceIdOrKey: SPACE, summary: 'x' });

      expect(permissions.getUserSpacePermissions).not.toHaveBeenCalled();
      expect(tasks.create).toHaveBeenCalled();
    });

    it('returns 404 for a non-member space (anti-probing)', async () => {
      permissions.getUserSpacePermissions.mockResolvedValue({
        isMember: false,
        spaceRole: null,
        globalRole: null,
        permissions: {},
      });
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { id: SPACE }, error: null }),
      ); // space resolves, but caller is not a member

      await expect(
        service.createTask(user, { spaceIdOrKey: SPACE, summary: 'x' }),
      ).rejects.toThrow(NotFoundException);
      expect(tasks.create).not.toHaveBeenCalled();
    });

    it('returns 404 for a cross-org / nonexistent space', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null })); // org-scoped lookup misses

      await expect(
        service.createTask(user, { spaceIdOrKey: SPACE, summary: 'x' }),
      ).rejects.toThrow(NotFoundException);
      expect(tasks.create).not.toHaveBeenCalled();
    });

    it('returns 404 (safe error) when the assignee is not in the org', async () => {
      grantSpacePermission('create_tasks');
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: SPACE }, error: null })) // space
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // org-member miss

      await expect(
        service.createTask(user, {
          spaceIdOrKey: SPACE,
          summary: 'x',
          assigneeId: ASSIGNEE,
        }),
      ).rejects.toThrow(NotFoundException);
      expect(tasks.create).not.toHaveBeenCalled();
    });

    it('accepts a priority that resolves to a configured task_priorities key', async () => {
      grantSpacePermission('create_tasks');
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: SPACE }, error: null })) // space
        .mockReturnValueOnce(buildChain({ data: { id: 'pri-1' }, error: null })) // task_priorities (valid)
        .mockReturnValueOnce(
          buildChain({
            data: { id: SPACE, key: 'SP', name: 'Space' },
            error: null,
          }),
        ) // toSafeTask space
        .mockReturnValueOnce(buildChain({ data: [], error: null })); // toSafeTask users

      await service.createTask(user, {
        spaceIdOrKey: SPACE,
        summary: 'x',
        priority: 'high',
      });

      expect(tasks.create).toHaveBeenCalledWith(
        ORG,
        USER,
        expect.objectContaining({ priority: 'high' }),
      );
    });

    it('rejects an unknown priority (BadRequest) without creating', async () => {
      grantSpacePermission('create_tasks');
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: SPACE }, error: null })) // space
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // task_priorities miss

      await expect(
        service.createTask(user, {
          spaceIdOrKey: SPACE,
          summary: 'x',
          priority: 'urgent',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(tasks.create).not.toHaveBeenCalled();
    });

    // ---- trusted third argument (Robert's Confirm, XE-T353 1.14) ----------

    const safeTaskLookups = () =>
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: { id: SPACE, key: 'SP', name: 'Space' },
            error: null,
          }),
        ) // toSafeTask space
        .mockReturnValueOnce(buildChain({ data: [], error: null })); // toSafeTask users

    it('keeps the two-argument (MCP) call exactly as before: three arguments to TasksService.create, no id, status or custom values', async () => {
      grantSpacePermission('create_tasks');
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { id: SPACE }, error: null }),
      );
      safeTaskLookups();

      await service.createTask(user, { spaceIdOrKey: SPACE, summary: 'x' });

      expect(tasks.create).toHaveBeenCalledTimes(1);
      const args = tasks.create.mock.calls[0] as unknown[];
      expect(args).toHaveLength(3);
      expect(args[2]).toEqual({
        space_id: SPACE,
        summary: 'x',
        description: undefined,
        task_type_id: 'task',
        parent_task_id: undefined,
        priority: undefined,
        assigned_to: undefined,
        due_date: undefined,
        labels: undefined,
      });
    });

    describe('a parent without a chosen type', () => {
      const levels = [
        { id: 'task', is_active: true, allowed_child_types: ['subtask'], allowed_parent_types: [] },
        { id: 'bug', is_active: true, allowed_child_types: ['subtask'], allowed_parent_types: [] },
        { id: 'subtask', is_active: true, allowed_child_types: [], allowed_parent_types: ['task', 'bug'] },
      ];
      const arrange = () => {
        grantSpacePermission('create_tasks');
        tasks.getActiveTaskTypesForSpace.mockResolvedValue(levels);
        mockFrom
          .mockReturnValueOnce(buildChain({ data: { id: SPACE }, error: null }))
          .mockReturnValueOnce(buildChain({ data: { id: TASK, space_id: SPACE, version: 1, task_type_id: 'task' }, error: null }));
        safeTaskLookups();
      };

      it('gives a trusted caller a type that may sit under the parent', async () => {
        arrange();
        await service.createTask(user, { spaceIdOrKey: SPACE, summary: 'x' }, { parentTaskId: TASK });
        expect(tasks.create.mock.calls[0][2 as never]).toMatchObject({ task_type_id: 'subtask', parent_task_id: TASK });
      });

      it('leaves other callers as they were', async () => {
        arrange();
        await service.createTask(user, { spaceIdOrKey: SPACE, summary: 'x', parentTaskId: TASK });
        expect(JSON.stringify(tasks.create.mock.calls[0])).toContain('"task_type_id":"task"');
      });
    });

    it('passes the reserved id, the status and the checked custom values of a trusted caller', async () => {
      grantSpacePermission('create_tasks');
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: SPACE }, error: null })) // space
        .mockReturnValueOnce(
          buildChain({
            data: [
              {
                field_key: 'severity',
                field_type: 'select',
                name: 'Severity',
                validation_rules: {},
                options: [{ value: 'high', label: 'High' }],
              },
            ],
            error: null,
          }),
        ); // custom_fields
      safeTaskLookups();

      await service.createTask(
        user,
        { spaceIdOrKey: SPACE, summary: 'x' },
        {
          taskId: TASK,
          status: 'status-1',
          customFieldValues: { severity: 'high' },
        },
      );

      expect(tasks.create).toHaveBeenCalledWith(
        ORG,
        USER,
        expect.objectContaining({
          space_id: SPACE,
          status_id: 'status-1',
          custom_field_values: { severity: 'high' },
        }),
        { taskId: TASK },
      );
    });

    it('takes a trusted parent through the same org and same-space checks', async () => {
      grantSpacePermission('create_tasks');
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: SPACE }, error: null })) // space
        .mockReturnValueOnce(
          buildChain({
            data: { id: TASK, space_id: 'other-space', version: 1 },
            error: null,
          }),
        ); // parent in another space

      await expect(
        service.createTask(
          user,
          { spaceIdOrKey: SPACE, summary: 'x' },
          { taskId: ASSIGNEE, parentTaskId: TASK },
        ),
      ).rejects.toThrow(BadRequestException);
      expect(tasks.create).not.toHaveBeenCalled();
    });

    it('refuses a trusted custom value that does not fit its field, or an unknown field', async () => {
      grantSpacePermission('create_tasks');
      const field = {
        field_key: 'severity',
        field_type: 'select',
        name: 'Severity',
        validation_rules: {},
        options: [{ value: 'high', label: 'High' }],
      };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: SPACE }, error: null }))
        .mockReturnValueOnce(buildChain({ data: [field], error: null }));

      await expect(
        service.createTask(
          user,
          { spaceIdOrKey: SPACE, summary: 'x' },
          { customFieldValues: { severity: 'blocker' } },
        ),
      ).rejects.toThrow(BadRequestException);

      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: SPACE }, error: null }))
        .mockReturnValueOnce(buildChain({ data: [field], error: null }));
      await expect(
        service.createTask(
          user,
          { spaceIdOrKey: SPACE, summary: 'x' },
          { customFieldValues: { unknown_key: 1 } },
        ),
      ).rejects.toThrow(BadRequestException);
      expect(tasks.create).not.toHaveBeenCalled();
    });
  });

  // ---- update ------------------------------------------------------------

  describe('updateTask', () => {
    it('updates with the correct expectedVersion and bumps the version', async () => {
      grantSpacePermission('edit_tasks');
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: { id: TASK, space_id: SPACE, version: 1 },
            error: null,
          }),
        ) // resolveTaskRef
        .mockReturnValueOnce(buildChain({ data: { id: TASK }, error: null })) // guarded claim succeeds
        .mockReturnValueOnce(
          buildChain({
            data: { id: SPACE, key: 'SP', name: 'Space' },
            error: null,
          }),
        ) // toSafeTask space
        .mockReturnValueOnce(buildChain({ data: [], error: null })); // toSafeTask users

      const result = await service.updateTask(user, TASK, {
        expectedVersion: 1,
        summary: 'Updated',
      });

      // The guarded claim sets version = expectedVersion + 1.
      const claimChain = mockFrom.mock.results[1].value as Record<
        string,
        jest.Mock
      >;
      expect(claimChain.update).toHaveBeenCalledWith(
        expect.objectContaining({ version: 2 }),
      );
      expect(tasks.update).toHaveBeenCalledWith(
        TASK,
        ORG,
        USER,
        expect.objectContaining({ summary: 'Updated' }),
      );
      expect(result.task.version).toBe(2);
    });

    it('returns 409 with only the current version on a stale expectedVersion', async () => {
      grantSpacePermission('edit_tasks');
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: { id: TASK, space_id: SPACE, version: 5 },
            error: null,
          }),
        ) // resolveTaskRef
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // guarded claim loses (no row)
        .mockReturnValueOnce(buildChain({ data: { version: 5 }, error: null })); // readCurrentVersion

      let caught: unknown;
      try {
        await service.updateTask(user, TASK, {
          expectedVersion: 1,
          summary: 'stale',
        });
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(ConflictException);
      // currentVersion is nested under `data` so the global exception filter
      // preserves it for the MCP client (which reads data.currentVersion).
      const body = (caught as ConflictException).getResponse() as {
        data: { currentVersion: number };
      };
      expect(body.data.currentVersion).toBe(5);
      // No field update is attempted after a lost claim.
      expect(tasks.update).not.toHaveBeenCalled();
    });

    it('returns 404 when the caller lacks edit_tasks in the task space', async () => {
      permissions.getUserSpacePermissions.mockResolvedValue({
        isMember: true,
        spaceRole: 'member',
        globalRole: 'member',
        permissions: { view_tasks: true },
      });
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: { id: TASK, space_id: SPACE, version: 1 },
          error: null,
        }),
      );

      await expect(
        service.updateTask(user, TASK, { expectedVersion: 1, summary: 'x' }),
      ).rejects.toThrow(NotFoundException);
      expect(tasks.update).not.toHaveBeenCalled();
    });

    it('returns 404 for a nonexistent / cross-org task', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));

      await expect(
        service.updateTask(user, TASK, { expectedVersion: 1, summary: 'x' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects an unknown priority before the version claim (no bump)', async () => {
      grantSpacePermission('edit_tasks');
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: { id: TASK, space_id: SPACE, version: 1 },
            error: null,
          }),
        ) // resolveTaskRef
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // task_priorities miss

      await expect(
        service.updateTask(user, TASK, {
          expectedVersion: 1,
          priority: 'urgent',
        }),
      ).rejects.toThrow(BadRequestException);
      // The version claim (the 3rd from()) is never reached, so no bump.
      expect(mockFrom).toHaveBeenCalledTimes(2);
      expect(tasks.update).not.toHaveBeenCalled();
    });
  });

  // ---- comment -----------------------------------------------------------

  describe('addComment', () => {
    it('comments in an accessible (member + add_comments_tasks) space', async () => {
      grantSpacePermission('add_comments_tasks');
      tasks.createComment.mockResolvedValue({
        id: 'comment-1',
        created_by: USER,
        created_at: '2026-01-02T00:00:00Z',
      });
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: { id: TASK, space_id: SPACE, version: 1 },
            error: null,
          }),
        ) // resolveTaskRef
        .mockReturnValueOnce(
          buildChain({
            data: { id: USER, first_name: 'A', last_name: 'B' },
            error: null,
          }),
        ); // lookupActor

      const result = await service.addComment(user, TASK, 'Looks good');

      expect(tasks.createComment).toHaveBeenCalledWith(
        TASK,
        ORG,
        USER,
        'Looks good',
      );
      expect(result.comment).toEqual({
        id: 'comment-1',
        taskId: TASK,
        author: { id: USER, name: 'A B' },
        createdAt: '2026-01-02T00:00:00Z',
      });
    });

    it('returns 404 for a non-member space (anti-probing)', async () => {
      permissions.getUserSpacePermissions.mockResolvedValue({
        isMember: false,
        spaceRole: null,
        globalRole: null,
        permissions: {},
      });
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: { id: TASK, space_id: SPACE, version: 1 },
          error: null,
        }),
      );

      await expect(service.addComment(user, TASK, 'hi')).rejects.toThrow(
        NotFoundException,
      );
      expect(tasks.createComment).not.toHaveBeenCalled();
    });
  });
});

describe('TasksMineWriteService — create with parent + explicit type', () => {
  let service: TasksMineWriteService;
  let mockFrom: jest.Mock;
  let permissions: {
    isAdminOrOwner: jest.Mock;
    getUserSpacePermissions: jest.Mock;
  };
  let tasks: {
    create: jest.Mock;
    update: jest.Mock;
    createComment: jest.Mock;
    getActiveTaskTypesForSpace: jest.Mock;
  };

  beforeEach(() => {
    mockFrom = jest.fn();
    const supa = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;

    permissions = {
      isAdminOrOwner: jest.fn().mockResolvedValue(false),
      getUserSpacePermissions: jest.fn(),
    };

    tasks = {
      create: jest.fn().mockResolvedValue(createdTaskRow),
      update: jest.fn().mockResolvedValue({ ...createdTaskRow, version: 2 }),
      createComment: jest.fn(),
      getActiveTaskTypesForSpace: jest
        .fn()
        .mockResolvedValue([defaultTaskType]),
    };

    service = new TasksMineWriteService(
      supa,
      permissions as unknown as PermissionsService,
      tasks as unknown as TasksService,
    );

    permissions.getUserSpacePermissions.mockResolvedValue({
      isMember: true,
      spaceRole: 'member',
      globalRole: 'member',
      permissions: { create_tasks: true },
    });
  });

  function happyCreateChain(parentRow: {
    id: string;
    space_id: string | null;
  }) {
    mockFrom
      .mockReturnValueOnce(buildChain({ data: { id: SPACE }, error: null })) // resolveSpaceIdOrKey
      .mockReturnValueOnce(buildChain({ data: parentRow, error: null })) // parent resolveTaskRef
      .mockReturnValueOnce(
        buildChain({
          data: { id: SPACE, key: 'SP', name: 'Space' },
          error: null,
        }),
      ) // toSafeTask space lookup
      .mockReturnValueOnce(buildChain({ data: [], error: null })); // toSafeTask users
  }

  it('resolves the parent (by key) and forwards parent_task_id + explicit type', async () => {
    happyCreateChain({ id: TASK, space_id: SPACE });

    await service.createTask(user, {
      spaceIdOrKey: 'SP',
      summary: 'Child task',
      parentTaskId: 'SP-99',
      taskTypeId: 'sub_task',
    });

    expect(tasks.create).toHaveBeenCalledWith(
      ORG,
      USER,
      expect.objectContaining({
        space_id: SPACE,
        parent_task_id: TASK,
        task_type_id: 'sub_task',
      }),
    );
    // Explicit type given → the default resolver is never consulted.
    expect(tasks.getActiveTaskTypesForSpace).not.toHaveBeenCalled();
  });

  it('falls back to the default task type when no explicit type is given', async () => {
    happyCreateChain({ id: TASK, space_id: SPACE });

    await service.createTask(user, {
      spaceIdOrKey: 'SP',
      summary: 'Child task',
      parentTaskId: TASK,
    });

    expect(tasks.create).toHaveBeenCalledWith(
      ORG,
      USER,
      expect.objectContaining({
        parent_task_id: TASK,
        task_type_id: 'task',
      }),
    );
    expect(tasks.getActiveTaskTypesForSpace).toHaveBeenCalled();
  });

  it('uniform 404 when the parent does not exist / is cross-org', async () => {
    mockFrom
      .mockReturnValueOnce(buildChain({ data: { id: SPACE }, error: null }))
      .mockReturnValueOnce(buildChain({ data: null, error: null })); // parent resolveTaskRef

    await expect(
      service.createTask(user, {
        spaceIdOrKey: 'SP',
        summary: 'x',
        parentTaskId: 'NOPE-1',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tasks.create).not.toHaveBeenCalled();
  });

  it('400 when the parent belongs to a different space', async () => {
    mockFrom
      .mockReturnValueOnce(buildChain({ data: { id: SPACE }, error: null }))
      .mockReturnValueOnce(
        buildChain({
          data: { id: TASK, space_id: '99999999-9999-9999-9999-999999999999' },
          error: null,
        }),
      );

    await expect(
      service.createTask(user, {
        spaceIdOrKey: 'SP',
        summary: 'x',
        parentTaskId: TASK,
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: 'parent task must be in the same space',
    });
    expect(tasks.create).not.toHaveBeenCalled();
  });
});
