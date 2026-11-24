import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

jest.mock('../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (value: string | null | undefined) => value ?? null,
}));

import { TasksController } from './tasks.controller';
import { CreateCommentDto } from './dto/create-comment.dto';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';

const user = {
  userId: 'user-1',
  organizationId: 'org-1',
  email: 'user@example.com',
};
const TASK_UUID = 'be926ee2-8182-4635-8f21-9261e2be1336';

function createController({ gitLicensed = true } = {}) {
  const service = {
    getByKey: jest.fn().mockResolvedValue({ id: 'task-1' }),
    getByKeyForViewer: jest.fn().mockResolvedValue({ id: 'task-1' }),
    getTree: jest.fn().mockResolvedValue([{ id: 'task-1', children: [] }]),
    getAll: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    create: jest.fn().mockResolvedValue({ id: 'task-1' }),
    getById: jest.fn().mockResolvedValue({ id: 'task-1', title: 'Task' }),
    getRelationships: jest.fn().mockResolvedValue([{ id: 'rel-1' }]),
    createRelationship: jest.fn().mockResolvedValue({ id: 'rel-1' }),
    deleteRelationship: jest.fn().mockResolvedValue(undefined),
    getComments: jest.fn().mockResolvedValue([{ id: 'comment-1' }]),
    getCommentPermissions: jest.fn().mockResolvedValue({
      can_edit_own: true,
      can_delete_own: true,
      can_edit_others: false,
      can_delete_others: false,
    }),
    createComment: jest.fn().mockResolvedValue({ id: 'comment-1' }),
    updateComment: jest.fn().mockResolvedValue({ id: 'comment-1' }),
    deleteComment: jest.fn().mockResolvedValue(undefined),
    getSubtasks: jest.fn().mockResolvedValue([{ id: 'task-child' }]),
    getParentChain: jest.fn().mockResolvedValue([{ id: 'parent-1' }]),
    getHistory: jest.fn().mockResolvedValue([{ id: 'history-1' }]),
    update: jest.fn().mockResolvedValue({ id: 'task-1' }),
    delete: jest.fn().mockResolvedValue(undefined),
    searchMyTasks: jest.fn().mockResolvedValue({ tasks: [] }),
    getMyTask: jest.fn().mockResolvedValue({ task: { id: 'task-1' } }),
  };
  const attachmentsService = {
    getAttachments: jest.fn().mockResolvedValue([{ id: 'attachment-1' }]),
    uploadAttachment: jest.fn().mockResolvedValue({ id: 'attachment-1' }),
    getDownloadUrl: jest.fn().mockResolvedValue({ data: { url: 'url' } }),
    deleteAttachment: jest.fn().mockResolvedValue({ success: true }),
  };
  const remindersService = {
    getReminders: jest.fn().mockResolvedValue([{ id: 'reminder-1' }]),
    createReminder: jest.fn().mockResolvedValue({ id: 'reminder-1' }),
    updateReminder: jest.fn().mockResolvedValue({ id: 'reminder-1' }),
    deleteReminder: jest.fn().mockResolvedValue({ success: true }),
  };
  const wikiGenerationService = {
    generateFromTask: jest.fn().mockResolvedValue({
      wiki_page: {
        id: 'wiki-1',
        title: 'Generated Wiki',
        slug: 'generated-wiki',
      },
    }),
  };
  const permissionsService = {
    checkPermission: jest.fn().mockResolvedValue(true),
    getUserSpacePermissions: jest.fn().mockResolvedValue({
      isMember: true,
      permissions: { edit_tasks: true, assign_tasks: true },
    }),
  };
  const engine = {
    getAvailableTransitions: jest.fn().mockResolvedValue({
      workflow_assigned: true,
      transitions: [
        {
          transition: {
            id: 'tx-1',
            name: 'Start',
            kind: 'global',
            to_node_id: 'node-1',
            to_status_id: 'status-1',
            screen_field_group_id: null,
            sort_order: 0,
          },
          has_screen: false,
          has_conditions: false,
          has_validators: false,
          has_post_functions: false,
          from_status_id: 'status-0',
          can_execute: true,
        },
      ],
    }),
    executeTransition: jest
      .fn()
      .mockResolvedValue({ id: 'task-1', status_id: 'status-done' }),
  };
  const watchers = {
    getTaskWatchState: jest.fn().mockResolvedValue({ watching: false }),
    setTaskWatch: jest.fn(
      (_: string, __: string, ___: string, watching: boolean) =>
        Promise.resolve({ watching }),
    ),
  };

  return {
    controller: new TasksController(
      service as never,
      attachmentsService as never,
      remindersService as never,
      wikiGenerationService as never,
      permissionsService as never,
      engine as never,
      watchers as never,
      undefined as never,
      {
        getEffectiveEntitlements: jest.fn().mockResolvedValue({
          has: (key: string) =>
            gitLicensed && key === 'feature_external_integrations',
        }),
      } as never,
    ),
    service,
    attachmentsService,
    remindersService,
    wikiGenerationService,
    permissionsService,
    engine,
    watchers,
  };
}

describe('TasksController', () => {
  it('exposes self-only task watch state after the existing access gate', async () => {
    const { controller, service, watchers } = createController();

    await expect(
      controller.getWatchState(user as never, TASK_UUID),
    ).resolves.toEqual({
      watching: false,
    });
    await expect(controller.watch(user as never, TASK_UUID)).resolves.toEqual({
      watching: true,
    });
    await expect(controller.unwatch(user as never, TASK_UUID)).resolves.toEqual(
      {
        watching: false,
      },
    );

    expect(service.getMyTask).toHaveBeenCalledTimes(3);
    expect(watchers.setTaskWatch).toHaveBeenNthCalledWith(
      1,
      'org-1',
      'user-1',
      TASK_UUID,
      true,
    );
    expect(watchers.setTaskWatch).toHaveBeenNthCalledWith(
      2,
      'org-1',
      'user-1',
      TASK_UUID,
      false,
    );
  });
  it('gets tasks by key and tree with scoped params', async () => {
    const { controller, service } = createController();

    await controller.getByKey(user as never, 'TASK-1');
    await controller.getTree(
      user as never,
      'process-1',
      'space-1',
      'root-task-1',
    );

    expect(service.getByKeyForViewer).toHaveBeenCalledWith(user, 'TASK-1');
    expect(service.getTree).toHaveBeenCalledWith(
      'org-1',
      'process-1',
      'space-1',
      'root-task-1',
    );
  });

  it('maps list query strings to service filters and numeric pagination', async () => {
    const { controller, service } = createController();

    await controller.list(
      user as never,
      'space-1',
      'process-1',
      undefined,
      'parent-1',
      undefined,
      'type-1',
      undefined,
      'open',
      'open,done',
      'status-1',
      'status-1,status-2',
      'high',
      'high,low',
      'priority-1',
      'priority-1,priority-2',
      'task-1,task-2',
      'assignee-1',
      undefined,
      'reporter-1',
      'search',
      'true',
      undefined,
      '2026-06-01',
      undefined,
      '2026-05-01',
      undefined,
      '2026-04-01',
      '2026-05-10',
      'true',
      '3',
      '25',
      undefined,
    );

    expect(service.getAll).toHaveBeenCalledWith('org-1', {
      space_id: 'space-1',
      process_id: 'process-1',
      parent_task_id: 'parent-1',
      task_type_id: 'type-1',
      status: 'open',
      statuses: 'open,done',
      status_id: 'status-1',
      status_ids: 'status-1,status-2',
      priority: 'high',
      priorities: 'high,low',
      priority_id: 'priority-1',
      priority_ids: 'priority-1,priority-2',
      ids: 'task-1,task-2',
      assigned_to: 'assignee-1',
      reporter: 'reporter-1',
      search: 'search',
      is_overdue: 'true',
      due_before: '2026-06-01',
      due_after: '2026-05-01',
      created_after: '2026-04-01',
      created_before: '2026-05-10',
      withRelations: true,
      page: 3,
      pageSize: 25,
      withDevelopment: true,
    });
  });

  it('passes a development filter through and rejects an unknown one', async () => {
    const { controller, service } = createController();
    const listWith = (development: string) =>
      controller.list(
        user as never,
        ...(Array.from({ length: 34 }, () => undefined) as []),
        development,
      );

    await listWith('build_failing');

    expect(service.getAll).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({
        development: 'build_failing',
        withDevelopment: true,
      }),
    );

    service.getAll.mockClear();
    await expect(listWith('bogus')).rejects.toBeInstanceOf(BadRequestException);
    expect(service.getAll).not.toHaveBeenCalled();
  });

  it('lists without the git fields and refuses the development filter without the licence', async () => {
    const { controller, service } = createController({ gitLicensed: false });
    const listWith = (development?: string) =>
      controller.list(
        user as never,
        ...(Array.from({ length: 34 }, () => undefined) as []),
        development,
      );

    await listWith();

    expect(service.getAll).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ withDevelopment: false }),
    );

    service.getAll.mockClear();
    await expect(listWith('has_pr')).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.getAll).not.toHaveBeenCalled();
  });

  it('creates, updates, and deletes tasks with scoped context and success message', async () => {
    const { controller, service } = createController();
    const createDto = { summary: 'New task' };
    const updateDto = { summary: 'Updated task' };

    await controller.create(user as never, createDto as never);
    await controller.update(user as never, 'task-1', updateDto as never);
    await expect(controller.remove(user as never, 'task-1')).resolves.toEqual({
      success: true,
      message: 'Task deleted',
    });

    expect(service.create).toHaveBeenCalledWith('org-1', 'user-1', createDto);
    expect(service.update).toHaveBeenCalledWith(
      'task-1',
      'org-1',
      'user-1',
      updateDto,
    );
    expect(service.delete).toHaveBeenCalledWith('task-1', 'org-1', 'user-1');
  });

  it('delegates relation-enriched task detail requests to the service', async () => {
    const { controller, service } = createController();

    await expect(
      controller.getById(user as never, TASK_UUID, 'true'),
    ).resolves.toEqual({
      id: 'task-1',
      title: 'Task',
    });

    expect(service.getById).toHaveBeenCalledWith(TASK_UUID, 'org-1', {
      withRelations: true,
    });
    expect(service.getRelationships).not.toHaveBeenCalled();
    expect(service.getComments).not.toHaveBeenCalled();
  });

  it('keeps legacy task-key lookup compatibility on the detail route', async () => {
    const { controller, service } = createController();

    await expect(
      controller.getById(user as never, 'DEFAULT-T29', 'true'),
    ).resolves.toEqual({ id: 'task-1' });

    expect(service.getByKeyForViewer).toHaveBeenCalledWith(
      user,
      'DEFAULT-T29',
    );
    expect(service.getById).not.toHaveBeenCalled();
  });

  it('dispatches patch actions to the expected update payloads', async () => {
    const { controller, service, permissionsService } = createController();

    await controller.patch(user as never, 'task-1', {
      action: 'update_status',
      status: 'done',
      status_id: 'status-1',
    } as never);
    await controller.patch(user as never, 'task-1', {
      action: 'assign',
      assigned_to: 'user-2',
    } as never);
    await controller.patch(user as never, 'task-1', {
      action: 'partial_update',
      title: 'Renamed',
    } as never);

    expect(service.update).toHaveBeenNthCalledWith(
      1,
      'task-1',
      'org-1',
      'user-1',
      { status: 'done', status_id: 'status-1' },
    );
    expect(service.update).toHaveBeenNthCalledWith(
      2,
      'task-1',
      'org-1',
      'user-1',
      { assigned_to: 'user-2' },
    );
    expect(service.update).toHaveBeenNthCalledWith(
      3,
      'task-1',
      'org-1',
      'user-1',
      { title: 'Renamed' },
    );
    expect(permissionsService.checkPermission).toHaveBeenNthCalledWith(
      1,
      'user-1',
      'org-1',
      'can_edit_tasks',
    );
    expect(permissionsService.checkPermission).toHaveBeenNthCalledWith(
      2,
      'user-1',
      'org-1',
      'can_assign_tasks',
    );
  });

  it('requires can_edit_tasks (not can_assign_tasks) and forwards resolution_id for a resolution-only PATCH', async () => {
    const { controller, service, permissionsService } = createController();

    await controller.patch(user as never, 'task-1', {
      resolution_id: 'res-1',
    } as never);

    expect(permissionsService.checkPermission).toHaveBeenCalledWith(
      'user-1',
      'org-1',
      'can_edit_tasks',
    );
    expect(permissionsService.checkPermission).not.toHaveBeenCalledWith(
      'user-1',
      'org-1',
      'can_assign_tasks',
    );
    expect(service.update).toHaveBeenCalledWith('task-1', 'org-1', 'user-1', {
      resolution_id: 'res-1',
    });
  });

  it('rejects unknown patch actions', async () => {
    const { controller } = createController();

    await expect(
      controller.patch(user as never, 'task-1', { action: 'mystery' } as never),
    ).rejects.toThrow(BadRequestException);
  });

  it('delegates comment endpoints with content and controller success messages', async () => {
    const { controller, service } = createController();

    await expect(
      controller.listComments(user as never, 'task-1'),
    ).resolves.toEqual({
      data: [{ id: 'comment-1' }],
      count: 1,
      permissions: {
        can_edit_own: true,
        can_delete_own: true,
        can_edit_others: false,
        can_delete_others: false,
      },
    });
    await controller.createComment(user as never, 'task-1', {
      content: 'hello',
    } as never);
    await controller.updateComment(user as never, 'task-1', 'comment-1', {
      content: 'updated',
    } as never);
    await expect(
      controller.deleteComment(user as never, 'task-1', 'comment-1'),
    ).resolves.toEqual({ success: true, message: 'Comment deleted' });

    expect(service.getComments).toHaveBeenCalledWith('task-1', 'org-1');
    expect(service.getCommentPermissions).toHaveBeenCalledWith(
      'task-1',
      'org-1',
      'user-1',
    );
    expect(service.createComment).toHaveBeenCalledWith(
      'task-1',
      'org-1',
      'user-1',
      'hello',
    );
    expect(service.updateComment).toHaveBeenCalledWith(
      'task-1',
      'comment-1',
      'org-1',
      'user-1',
      'updated',
    );
    expect(service.deleteComment).toHaveBeenCalledWith(
      'task-1',
      'comment-1',
      'org-1',
      'user-1',
    );
  });

  it('keeps legacy task/comment payload extras valid under whitelist validation', async () => {
    const validationOptions = { whitelist: true, forbidNonWhitelisted: true };

    await expect(
      validate(
        plainToInstance(CreateTaskDto, {
          organizationId: '11111111-1111-4111-8111-111111111111',
          space_id: '22222222-2222-4222-8222-222222222222',
          summary: 'Task with duration',
          task_type_id: 'task',
          duration: 45,
        }),
        validationOptions,
      ),
    ).resolves.toHaveLength(0);
    await expect(
      validate(
        plainToInstance(CreateCommentDto, {
          organizationId: '11111111-1111-4111-8111-111111111111',
          task_id: '33333333-3333-4333-8333-333333333333',
          content: 'Legacy comment payload',
        }),
        validationOptions,
      ),
    ).resolves.toHaveLength(0);
    await expect(
      validate(
        plainToInstance(UpdateCommentDto, {
          organizationId: '11111111-1111-4111-8111-111111111111',
          content: 'Updated legacy comment payload',
        }),
        validationOptions,
      ),
    ).resolves.toHaveLength(0);
  });

  it('delegates relationship endpoints with dto and controller success messages', async () => {
    const { controller, service } = createController();
    const dto = { target_id: 'task-2', relation_type_id: 'blocks' };

    await controller.listRelationships(user as never, 'task-1');
    await controller.createRelationship(user as never, 'task-1', dto as never);
    await expect(
      controller.deleteRelationship(user as never, 'task-1', 'rel-1'),
    ).resolves.toEqual({ success: true, message: 'Relationship deleted' });

    expect(service.getRelationships).toHaveBeenCalledWith(
      'task-1',
      'org-1',
      'user-1',
    );
    expect(service.createRelationship).toHaveBeenCalledWith(
      'task-1',
      'org-1',
      'user-1',
      dto,
    );
    expect(service.deleteRelationship).toHaveBeenCalledWith(
      'task-1',
      'rel-1',
      'org-1',
      'user-1',
    );
  });

  it('delegates hierarchy and history endpoints with organization scope', async () => {
    const { controller, service } = createController();

    await controller.listSubtasks(user as never, 'task-1');
    await controller.getParentChain(user as never, 'task-1');
    await controller.getHistory(user as never, 'task-1');

    expect(service.getSubtasks).toHaveBeenCalledWith('task-1', 'org-1');
    expect(service.getParentChain).toHaveBeenCalledWith('task-1', 'org-1');
    expect(service.getHistory).toHaveBeenCalledWith('task-1', 'org-1');
  });

  it('delegates attachment endpoints and validates missing upload files', async () => {
    const { controller, attachmentsService } = createController();
    const file = {
      originalname: 'evidence.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('file'),
    } as Express.Multer.File;

    await controller.listAttachments(user as never, 'task-1');
    await controller.uploadAttachment(user as never, 'task-1', file);
    await controller.getAttachmentDownloadUrl(
      user as never,
      'task-1',
      'attachment-1',
    );
    await controller.deleteAttachment(user as never, 'task-1', 'attachment-1');

    expect(attachmentsService.getAttachments).toHaveBeenCalledWith(
      'task-1',
      'org-1',
    );
    expect(attachmentsService.uploadAttachment).toHaveBeenCalledWith(
      'task-1',
      'org-1',
      'user-1',
      file,
    );
    expect(attachmentsService.getDownloadUrl).toHaveBeenCalledWith(
      'task-1',
      'attachment-1',
      'org-1',
    );
    expect(attachmentsService.deleteAttachment).toHaveBeenCalledWith(
      'task-1',
      'attachment-1',
      'org-1',
      'user-1',
    );
    await expect(
      controller.uploadAttachment(user as never, 'task-1', undefined as never),
    ).rejects.toThrow(BadRequestException);
  });

  it('delegates reminder endpoints with task, reminder, user, and dto context', async () => {
    const { controller, remindersService, service } = createController();
    const createDto = { remind_at: '2026-06-01T00:00:00Z' };
    const updateDto = { is_completed: true };

    await controller.listReminders(user as never, 'task-1');
    await controller.createReminder(
      user as never,
      'task-1',
      createDto as never,
    );
    await controller.updateReminder(
      user as never,
      'task-1',
      'reminder-1',
      updateDto as never,
    );
    await controller.deleteReminder(user as never, 'task-1', 'reminder-1');

    // Every reminder endpoint first proves the task belongs to the caller's org
    // before touching the task_id-scoped reminder service.
    expect(service.getById).toHaveBeenCalledTimes(4);
    expect(service.getById).toHaveBeenCalledWith('task-1', 'org-1');
    expect(remindersService.getReminders).toHaveBeenCalledWith('task-1');
    expect(remindersService.createReminder).toHaveBeenCalledWith(
      'task-1',
      'user-1',
      createDto,
    );
    expect(remindersService.updateReminder).toHaveBeenCalledWith(
      'reminder-1',
      'task-1',
      updateDto,
    );
    expect(remindersService.deleteReminder).toHaveBeenCalledWith(
      'reminder-1',
      'task-1',
    );
  });

  it('lists available workflow transitions via the engine', async () => {
    const { controller, engine } = createController();

    const result = await controller.availableTransitions(
      user as never,
      TASK_UUID,
    );

    expect(engine.getAvailableTransitions).toHaveBeenCalledWith(
      TASK_UUID,
      user,
    );
    expect(result).toEqual({
      workflow_assigned: true,
      data: [
        {
          transition: {
            id: 'tx-1',
            name: 'Start',
            kind: 'global',
            to_node_id: 'node-1',
            to_status_id: 'status-1',
            screen_field_group_id: null,
            sort_order: 0,
          },
          has_screen: false,
          has_conditions: false,
          has_validators: false,
          has_post_functions: false,
          from_status_id: 'status-0',
          can_execute: true,
        },
      ],
    });
  });

  it('maps mine/search query strings to service options and delegates', async () => {
    const { controller, service } = createController();

    const result = await controller.searchMyTasks(
      user as never,
      'login',
      'ENG',
      'open,done',
      'high,low',
      'me',
      '2026-06-01',
      '2026-05-01',
      'dueDate',
      '99',
      'cursor-1',
    );

    expect(result).toEqual({ tasks: [] });
    expect(service.searchMyTasks).toHaveBeenCalledWith(user, {
      query: 'login',
      spaceIdOrKey: 'ENG',
      statuses: ['open', 'done'],
      priorities: ['high', 'low'],
      assignedTo: 'me',
      dueBefore: '2026-06-01',
      dueAfter: '2026-05-01',
      sortBy: 'dueDate',
      limit: 99,
      cursor: 'cursor-1',
    });
  });

  it('passes the My Work page-mode params only when they are sent', async () => {
    const { controller, service } = createController();

    await controller.searchMyTasks(
      user as never,
      undefined,
      undefined,
      'open',
      undefined,
      'me',
      undefined,
      undefined,
      'key',
      undefined,
      undefined,
      '2',
      '25',
      'true',
      'true',
    );

    expect(service.searchMyTasks).toHaveBeenLastCalledWith(user, {
      query: undefined,
      spaceIdOrKey: undefined,
      statuses: ['open'],
      priorities: undefined,
      assignedTo: 'me',
      dueBefore: undefined,
      dueAfter: undefined,
      sortBy: 'key',
      limit: undefined,
      cursor: undefined,
      page: 2,
      pageSize: 25,
      withDetails: true,
      overdue: true,
    });
  });

  it('delegates mine/:taskIdOrKey to the service with comment options', async () => {
    const { controller, service } = createController();

    const result = await controller.getMyTask(
      user as never,
      'ENG-1',
      'true',
      '10',
    );

    expect(result).toEqual({ task: { id: 'task-1' } });
    expect(service.getMyTask).toHaveBeenCalledWith(user, 'ENG-1', {
      includeComments: true,
      commentLimit: 10,
    });
  });

  it('executes a specific workflow transition via the engine', async () => {
    const { controller, engine } = createController();
    const transitionUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const dto = {
      screen_input: { resolution: 'Done' },
      expected_version: 3,
      execution_id: 'idem-1',
    };

    const result = await controller.executeTransition(
      user as never,
      TASK_UUID,
      transitionUuid,
      dto as never,
    );

    expect(engine.executeTransition).toHaveBeenCalledWith({
      taskId: TASK_UUID,
      transitionId: transitionUuid,
      screenInput: dto.screen_input,
      user,
      executionId: dto.execution_id,
      expectedVersion: dto.expected_version,
    });
    expect(result).toEqual({
      data: { id: 'task-1', status_id: 'status-done' },
      success: true,
    });
  });
});
