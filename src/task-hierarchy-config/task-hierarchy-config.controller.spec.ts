import { BadRequestException } from '@nestjs/common';
import { TaskHierarchyConfigController } from './task-hierarchy-config.controller';

const user = {
  userId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
};
const spaceId = '33333333-3333-4333-8333-333333333333';

const taskType = {
  id: 'task',
  name: 'Task',
  name_i18n: {},
  description_i18n: {},
  color: '#6B7280',
  text_color: '#FFFFFF',
  parent_level_id: null,
  allowed_parent_types: [],
  allowed_child_types: [],
  max_depth: 10,
  default_status: 'open',
  default_priority: 'medium',
  field_group_ids: [],
  allowed_statuses: ['open'],
  sort_order: 0,
  is_active: true,
};
const config = { version: '1.0', levels: [taskType] };

function createController() {
  const service = {
    getConfig: jest.fn().mockResolvedValue({ config }),
    getActiveTypes: jest.fn().mockResolvedValue([taskType]),
    getRootTypes: jest.fn().mockResolvedValue([taskType]),
    getTypeById: jest.fn().mockResolvedValue(taskType),
    getValidParentTypesFor: jest.fn().mockResolvedValue([]),
    getValidChildTypesFor: jest.fn().mockResolvedValue([]),
    saveConfig: jest.fn().mockResolvedValue({ id: 'config-1' }),
    assertNoReservedTypeNames: jest.fn().mockResolvedValue(undefined),
    validateConfig: jest.fn().mockReturnValue({ isValid: true, errors: [] }),
    resetToDefault: jest.fn().mockResolvedValue({ id: 'config-1' }),
    addTaskType: jest.fn().mockResolvedValue({ id: 'config-1' }),
    updateTaskType: jest.fn().mockResolvedValue({ id: 'config-1' }),
    removeTaskType: jest.fn().mockResolvedValue({ id: 'config-1' }),
    reorder: jest.fn().mockResolvedValue({ id: 'config-1' }),
  };
  const permissionsService = {
    isAdminOrOwner: jest.fn().mockResolvedValue(true),
    getEffectivePermissions: jest.fn().mockResolvedValue({
      effective_permissions: { can_edit_hierarchy: true },
    }),
  };

  return {
    controller: new TaskHierarchyConfigController(
      service as never,
      permissionsService as never,
    ),
    service,
    permissionsService,
  };
}

describe('TaskHierarchyConfigController', () => {
  it('dispatches get query variants to the matching service methods', async () => {
    const { controller, service } = createController();

    await controller.get(user as never, spaceId, 'true');
    await controller.get(user as never, spaceId, undefined, 'true');
    await controller.get(user as never, spaceId, undefined, undefined, 'task');
    await controller.get(
      user as never,
      spaceId,
      undefined,
      undefined,
      undefined,
      'task',
    );
    await controller.get(
      user as never,
      spaceId,
      undefined,
      undefined,
      undefined,
      undefined,
      'task',
    );
    await controller.get(user as never, spaceId);

    expect(service.getActiveTypes).toHaveBeenCalledWith(
      user.organizationId,
      spaceId,
    );
    expect(service.getRootTypes).toHaveBeenCalledWith(
      user.organizationId,
      spaceId,
    );
    expect(service.getValidParentTypesFor).toHaveBeenCalledWith(
      user.organizationId,
      spaceId,
      'task',
    );
    expect(service.getValidChildTypesFor).toHaveBeenCalledWith(
      user.organizationId,
      spaceId,
      'task',
    );
    expect(service.getTypeById).toHaveBeenCalledWith(
      user.organizationId,
      spaceId,
      'task',
    );
    expect(service.getConfig).toHaveBeenCalledWith(
      user.organizationId,
      spaceId,
    );
  });

  it('saves full config and wraps service response', async () => {
    const { controller, service } = createController();

    await expect(
      controller.save(user as never, { spaceId, config } as never),
    ).resolves.toEqual({ data: { id: 'config-1' }, success: true });
    expect(service.saveConfig).toHaveBeenCalledWith(
      user.organizationId,
      spaceId,
      config,
      user.userId,
    );
  });

  it('checks reserved task type names before a full save', async () => {
    const { controller, service } = createController();
    service.assertNoReservedTypeNames.mockRejectedValueOnce(
      new Error('reserved'),
    );

    await expect(
      controller.save(user as never, { spaceId, config } as never),
    ).rejects.toThrow('reserved');
    expect(service.assertNoReservedTypeNames).toHaveBeenCalledWith(
      user.organizationId,
      spaceId,
      config,
    );
    expect(service.saveConfig).not.toHaveBeenCalled();
  });

  it('dispatches valid post actions and rejects invalid action bodies', async () => {
    const { controller, service } = createController();

    await expect(
      controller.dispatch(
        user as never,
        {
          action: 'validate',
          config,
        } as never,
      ),
    ).resolves.toEqual({ data: { isValid: true, errors: [] } });
    await expect(
      controller.dispatch(user as never, { action: 'reset', spaceId } as never),
    ).resolves.toMatchObject({ success: true });
    await expect(
      controller.dispatch(
        user as never,
        {
          action: 'add_task_type',
          spaceId,
          taskType,
        } as never,
      ),
    ).resolves.toMatchObject({ success: true });
    await expect(
      controller.dispatch(
        user as never,
        {
          action: 'update_task_type',
          spaceId,
          taskTypeId: 'task',
          updates: { name: 'Task renamed' },
        } as never,
      ),
    ).resolves.toMatchObject({ success: true });
    await expect(
      controller.dispatch(
        user as never,
        {
          action: 'remove_task_type',
          spaceId,
          taskTypeId: 'task',
        } as never,
      ),
    ).resolves.toMatchObject({ success: true });
    await expect(
      controller.dispatch(
        user as never,
        {
          action: 'reorder',
          spaceId,
          orderedIds: ['task'],
        } as never,
      ),
    ).resolves.toMatchObject({ success: true });

    expect(service.validateConfig).toHaveBeenCalledWith(config);
    expect(service.resetToDefault).toHaveBeenCalledWith(
      user.organizationId,
      spaceId,
      user.userId,
    );
    expect(service.addTaskType).toHaveBeenCalledWith(
      user.organizationId,
      spaceId,
      taskType,
      user.userId,
    );
    expect(service.updateTaskType).toHaveBeenCalledWith(
      user.organizationId,
      spaceId,
      'task',
      expect.objectContaining({ name: 'Task renamed' }),
      user.userId,
    );
    expect(service.removeTaskType).toHaveBeenCalledWith(
      user.organizationId,
      spaceId,
      'task',
      user.userId,
    );
    expect(service.reorder).toHaveBeenCalledWith(
      user.organizationId,
      spaceId,
      ['task'],
      user.userId,
    );

    await expect(
      controller.dispatch(user as never, {} as never),
    ).rejects.toThrow(BadRequestException);
    await expect(
      controller.dispatch(
        user as never,
        {
          action: 'reset',
          spaceId: 'not-a-uuid',
        } as never,
      ),
    ).rejects.toThrow(BadRequestException);
  });
});
