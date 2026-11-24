import { BadRequestException } from '@nestjs/common';
import { FieldGroupsController } from './field-groups.controller';

const user = {
  userId: 'user-1',
  organizationId: 'org-1',
};

describe('FieldGroupsController', () => {
  let service: Record<string, jest.Mock>;
  let controller: FieldGroupsController;

  beforeEach(() => {
    service = {
      getAll: jest.fn().mockResolvedValue([{ id: 'group-1' }]),
      getBySpace: jest.fn().mockResolvedValue([{ id: 'group-1' }]),
      create: jest.fn().mockResolvedValue({ id: 'group-1' }),
      getLevelFieldsConfiguration: jest.fn().mockResolvedValue({ groups: [] }),
      getLevelAssignments: jest.fn().mockResolvedValue([]),
      assignGroupToLevel: jest.fn().mockResolvedValue({ id: 'assignment-1' }),
      assignFieldToLevel: jest.fn().mockResolvedValue({ id: 'assignment-2' }),
      unassignGroupFromLevel: jest.fn().mockResolvedValue(undefined),
      unassignFieldFromLevel: jest.fn().mockResolvedValue(undefined),
      getById: jest.fn().mockResolvedValue({ id: 'group-1' }),
      getByIdWithFields: jest.fn().mockResolvedValue({
        id: 'group-1',
        fields: [],
      }),
      update: jest.fn().mockResolvedValue({ id: 'group-1' }),
      softDelete: jest.fn().mockResolvedValue(undefined),
      restore: jest.fn().mockResolvedValue({ id: 'group-1' }),
      permanentDelete: jest.fn().mockResolvedValue(undefined),
      duplicate: jest.fn().mockResolvedValue({ id: 'group-2' }),
      getFieldsInGroup: jest.fn().mockResolvedValue([{ id: 'field-1' }]),
      addFieldToGroup: jest.fn().mockResolvedValue({ id: 'field-1' }),
      addFieldsToGroupBatch: jest.fn().mockResolvedValue([{ id: 'field-1' }]),
      reorderFields: jest.fn().mockResolvedValue(undefined),
      updateFieldInGroup: jest.fn().mockResolvedValue({ id: 'field-1' }),
      removeFieldFromGroup: jest.fn().mockResolvedValue(undefined),
      getGroupAssignmentPermissions: jest.fn().mockResolvedValue([]),
      bulkSetGroupAssignmentPermissions: jest.fn().mockResolvedValue(undefined),
    };
    controller = new FieldGroupsController(service as any);
  });

  it('lists organization groups and parses is_deleted flags', async () => {
    await controller.list(user as any, undefined, 'risk', 'false');

    expect(service.getAll).toHaveBeenCalledWith('org-1', {
      search: 'risk',
      is_deleted: false,
    });
  });

  it('lists space-specific groups when spaceId is provided', async () => {
    await controller.list(user as any, 'space-1', 'risk');

    expect(service.getBySpace).toHaveBeenCalledWith('org-1', 'space-1', {
      search: 'risk',
      is_deleted: undefined,
    });
  });

  it('creates field groups with organization and actor context', async () => {
    const dto = { name: 'Risk fields' };

    await controller.create(user as any, dto as any);

    expect(service.create).toHaveBeenCalledWith('org-1', 'user-1', dto);
  });

  it('requires level configuration query values', async () => {
    await expect(
      controller.getForLevel(user as any, '', 'task' as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('lists level assignments with a default group type', async () => {
    await controller.listLevelAssignments(
      user as any,
      'level-1',
      'task' as any,
    );

    expect(service.getLevelAssignments).toHaveBeenCalledWith(
      'org-1',
      'level-1',
      'task',
      'groups',
      undefined,
    );
  });

  it('assigns groups and fields to hierarchy levels through the right service methods', async () => {
    await controller.createLevelAssignment(
      user as any,
      {
        type: 'group',
        hierarchy_level_id: 'level-1',
        entity_type: 'task',
        field_group_id: 'group-1',
        section: 'main',
      } as any,
    );
    await controller.createLevelAssignment(
      user as any,
      {
        type: 'field',
        hierarchy_level_id: 'level-1',
        entity_type: 'task',
        custom_field_id: 'field-1',
        is_required: true,
      } as any,
    );

    expect(service.assignGroupToLevel).toHaveBeenCalledWith(
      'org-1',
      {
        type: 'group',
        hierarchy_level_id: 'level-1',
        entity_type: 'task',
        field_group_id: 'group-1',
        section: 'main',
        sort_order: undefined,
        is_collapsed_default: undefined,
      },
      'user-1',
    );
    expect(service.assignFieldToLevel).toHaveBeenCalledWith(
      'org-1',
      {
        type: 'field',
        hierarchy_level_id: 'level-1',
        entity_type: 'task',
        custom_field_id: 'field-1',
        section: undefined,
        sort_order: undefined,
        is_required: true,
        is_hidden: undefined,
        column_span: undefined,
      },
      'user-1',
    );
  });

  it('rejects level assignments without a valid discriminator', async () => {
    await expect(
      controller.createLevelAssignment(
        user as any,
        {
          type: 'other',
        } as any,
      ),
    ).rejects.toThrow('type must be "group" or "field"');
  });

  it('unassigns field groups and returns controller-level success payload', async () => {
    await expect(
      controller.deleteLevelAssignment(
        user as any,
        {
          type: 'group',
          hierarchy_level_id: 'level-1',
          entity_type: 'task',
          field_group_id: 'group-1',
        } as any,
      ),
    ).resolves.toEqual({
      success: true,
      message: 'Field group unassigned from level successfully',
    });
    expect(service.unassignGroupFromLevel).toHaveBeenCalledWith(
      'org-1',
      'level-1',
      'task',
      'group-1',
      'user-1',
    );
  });

  it('gets field groups with or without embedded fields based on query flag', async () => {
    await controller.getById(user as any, 'group-1');
    await controller.getById(user as any, 'group-1', 'false');

    expect(service.getByIdWithFields).toHaveBeenCalledWith(
      'group-1',
      'org-1',
      undefined,
    );
    expect(service.getById).toHaveBeenCalledWith('group-1', 'org-1');
  });

  it('updates and soft deletes field groups with organization and actor context', async () => {
    const dto = { name: 'Updated' };

    await controller.update(user as any, 'group-1', dto as any);
    await expect(controller.remove(user as any, 'group-1')).resolves.toEqual({
      success: true,
    });

    expect(service.update).toHaveBeenCalledWith(
      'group-1',
      'user-1',
      dto,
      'org-1',
    );
    expect(service.softDelete).toHaveBeenCalledWith(
      'group-1',
      'user-1',
      'org-1',
    );
  });

  it('dispatches patch actions and validates duplicate names', async () => {
    await expect(
      controller.patch(user as any, 'group-1', {
        action: 'permanent_delete',
      } as any),
    ).resolves.toEqual({ success: true });
    await expect(
      controller.patch(user as any, 'group-1', { action: 'duplicate' } as any),
    ).rejects.toThrow('newName is required for action=duplicate');

    expect(service.permanentDelete).toHaveBeenCalledWith(
      'group-1',
      'org-1',
      'user-1',
    );
  });

  it('reorders fields when body requests reorder', async () => {
    await expect(
      controller.updateFields(user as any, 'group-1', {
        reorder: true,
        fields: [{ custom_field_id: 'field-1', sort_order: 1 }],
      } as any),
    ).resolves.toEqual({ success: true });

    expect(service.reorderFields).toHaveBeenCalledWith(
      'group-1',
      [{ custom_field_id: 'field-1', sort_order: 1 }],
      'org-1',
      'user-1',
    );
  });

  it('lists and adds fields in a group with organization scope', async () => {
    await controller.listFields(user as any, 'group-1');
    await controller.addField(user as any, 'group-1', {
      custom_field_id: 'field-1',
      sort_order: 1,
    } as any);
    await controller.addField(user as any, 'group-1', {
      fields: [{ custom_field_id: 'field-2' }],
      is_required: true,
    } as any);

    expect(service.getFieldsInGroup).toHaveBeenCalledWith('group-1', 'org-1');
    expect(service.addFieldToGroup).toHaveBeenCalledWith(
      'group-1',
      { custom_field_id: 'field-1', sort_order: 1 },
      'org-1',
      'user-1',
    );
    expect(service.addFieldsToGroupBatch).toHaveBeenCalledWith(
      'group-1',
      [
        {
          custom_field_id: 'field-2',
          is_required: true,
          is_hidden: undefined,
          column_span: undefined,
        },
      ],
      'org-1',
      'user-1',
    );
  });

  it('requires custom_field_id before updating a field in a group', async () => {
    await expect(
      controller.updateFields(user as any, 'group-1', {
        is_required: true,
      } as any),
    ).rejects.toThrow('custom_field_id is required');
  });

  it('removes a field only when the required query value is present', async () => {
    await expect(
      controller.removeField(user as any, 'group-1', ''),
    ).rejects.toThrow('custom_field_id is required');

    await expect(
      controller.removeField(user as any, 'group-1', 'field-1'),
    ).resolves.toEqual({
      success: true,
      message: 'Field removed from group successfully',
    });
    expect(service.removeFieldFromGroup).toHaveBeenCalledWith(
      'group-1',
      'field-1',
      'org-1',
      'user-1',
    );
  });

  it('gets and replaces assignment permissions with controller success payloads', async () => {
    const dto = { permissions: [{ permission: 'can_view', enabled: true }] };

    await controller.getAssignmentPermissions(user as any, 'assignment-1');
    await expect(
      controller.setAssignmentPermissions(
        user as any,
        'assignment-1',
        dto as any,
      ),
    ).resolves.toEqual({
      success: true,
      message: 'Permissions updated successfully',
    });

    expect(service.getGroupAssignmentPermissions).toHaveBeenCalledWith(
      'assignment-1',
      'org-1',
    );
    expect(service.bulkSetGroupAssignmentPermissions).toHaveBeenCalledWith(
      'assignment-1',
      dto.permissions,
      'org-1',
      'user-1',
    );
  });
});
