import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { SPACE_PERMISSION_KEY } from '../auth/decorators/require-space-permission.decorator';
import { SpacesController } from './spaces.controller';

jest.mock('../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (value: string | null | undefined) => value ?? null,
}));

const user = {
  userId: 'user-1',
  organizationId: 'org-1',
  email: 'user@example.com',
};

function createController() {
  const spacesService = {
    getSpaces: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    createSpace: jest.fn().mockResolvedValue({ id: 'space-1' }),
    getUserSpaces: jest.fn().mockResolvedValue([{ id: 'space-1' }]),
    getSpaceByKey: jest
      .fn()
      .mockResolvedValue({ available: false, space: { id: 'space-1' } }),
    getSpaceById: jest.fn().mockResolvedValue({ id: 'space-1' }),
    updateSpace: jest.fn().mockResolvedValue({ id: 'space-1' }),
    deleteSpace: jest.fn().mockResolvedValue(undefined),
    archiveSpace: jest.fn().mockResolvedValue(undefined),
    uploadIcon: jest.fn().mockResolvedValue({ id: 'space-1' }),
    deleteIcon: jest.fn().mockResolvedValue({ id: 'space-1', icon_url: null }),
    unarchiveSpace: jest.fn().mockResolvedValue({ id: 'space-1' }),
    getSpaceMembersWithDetails: jest
      .fn()
      .mockResolvedValue([{ id: 'member-1' }]),
    addSpaceMember: jest.fn().mockResolvedValue({ id: 'member-1' }),
    updateSpaceMember: jest.fn().mockResolvedValue({ id: 'member-1' }),
    removeSpaceMember: jest.fn().mockResolvedValue({ success: true }),
    getImplicitSpaceMembers: jest.fn().mockResolvedValue(['user-2']),
    getSpaceModules: jest.fn().mockResolvedValue([]),
    updateSpaceModules: jest.fn().mockResolvedValue([{ module: 'tasks' }]),
    getUserSpacePermissions: jest.fn().mockResolvedValue({ can_view: true }),
    listModulePermissions: jest.fn().mockResolvedValue([]),
    saveModulePermissions: jest.fn().mockResolvedValue(2),
    getSpaceInvitations: jest.fn().mockResolvedValue([{ id: 'invite-1' }]),
    createSpaceInvitations: jest.fn().mockResolvedValue({
      created: [],
      errors: [],
    }),
    resendSpaceInvitation: jest.fn().mockResolvedValue({ id: 'invite-1' }),
    revokeSpaceInvitation: jest.fn().mockResolvedValue({ id: 'invite-1' }),
    acceptSpaceInvitation: jest.fn().mockResolvedValue({
      success: true,
      message: 'Invitation accepted',
    }),
  };
  const categoriesService = {
    getCategories: jest.fn().mockResolvedValue([{ id: 'category-1' }]),
    createCategory: jest.fn().mockResolvedValue({ id: 'category-1' }),
    getCategoryById: jest.fn().mockResolvedValue({ id: 'category-1' }),
    updateCategory: jest.fn().mockResolvedValue({ id: 'category-1' }),
    deleteCategory: jest.fn().mockResolvedValue({ success: true }),
  };
  const tasksService = {
    reorderTasks: jest.fn().mockResolvedValue({ updated: 3 }),
  };

  const memberRules = {
    assertSpaceInOrg: jest.fn().mockResolvedValue(undefined),
    assertCanAdd: jest.fn().mockResolvedValue(undefined),
    assertCanChangeRole: jest.fn().mockResolvedValue(undefined),
    assertCanRemove: jest.fn().mockResolvedValue(undefined),
    assertCanInvite: jest.fn().mockResolvedValue(undefined),
  };

  return {
    controller: new SpacesController(
      spacesService as never,
      categoriesService as never,
      tasksService as never,
      memberRules as never,
    ),
    spacesService,
    categoriesService,
    tasksService,
    memberRules,
  };
}

describe('SpacesController', () => {
  it('builds list filters and pagination defaults from query strings', async () => {
    const { controller, spacesService } = createController();

    await controller.getSpaces(
      user as never,
      '4',
      '40',
      'false',
      'true',
      'engineering',
      'lead-1',
      'risk',
    );
    await controller.getSpaces(user as never);

    expect(spacesService.getSpaces).toHaveBeenNthCalledWith(
      1,
      'org-1',
      {
        is_active: false,
        is_archived: true,
        category: 'engineering',
        lead_id: 'lead-1',
        search: 'risk',
      },
      4,
      40,
    );
    expect(spacesService.getSpaces).toHaveBeenNthCalledWith(
      2,
      'org-1',
      {},
      1,
      20,
    );
  });

  it('wraps key availability in the legacy exists/data response', async () => {
    const { controller, spacesService } = createController();

    await expect(
      controller.getSpaceByKey(user as never, 'RISK'),
    ).resolves.toEqual({
      exists: true,
      data: { id: 'space-1' },
    });
    expect(spacesService.getSpaceByKey).toHaveBeenCalledWith('RISK', 'org-1');
  });

  it('creates, gets, and updates spaces with expected scoped arguments', async () => {
    const { controller, spacesService } = createController();
    const createDto = { name: 'Risk' };
    const updateDto = { description: 'Updated' };

    await controller.createSpace(user as never, createDto as never);
    await controller.getUserSpaces(user as never);
    await controller.getSpaceById(user as never, 'space-1');
    await controller.updateSpace(user as never, 'space-1', updateDto as never);

    expect(spacesService.createSpace).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      createDto,
    );
    // Must carry the caller's org: space_members has no organization_id, so an
    // unscoped lookup returned spaces from every org a multi-org user belongs to.
    // Every other assertion in this test already pins the org — this one is the
    // odd one out precisely because the scoping was missing.
    expect(spacesService.getUserSpaces).toHaveBeenCalledWith('user-1', 'org-1');
    expect(spacesService.getSpaceById).toHaveBeenCalledWith('space-1', 'org-1');
    expect(spacesService.updateSpace).toHaveBeenCalledWith(
      'space-1',
      'user-1',
      updateDto,
      'org-1',
    );
  });

  it('chooses archive or hard delete from query flags', async () => {
    const { controller, spacesService } = createController();

    await expect(
      controller.deleteSpace(user as never, 'space-1'),
    ).resolves.toEqual({ success: true });
    await expect(
      controller.deleteSpace(user as never, 'space-1', 'true'),
    ).resolves.toEqual({ success: true });

    expect(spacesService.archiveSpace).toHaveBeenCalledWith(
      'space-1',
      'user-1',
      'org-1',
    );
    expect(spacesService.deleteSpace).toHaveBeenCalledWith(
      'space-1',
      'user-1',
      'org-1',
    );
  });

  it('requires an icon file and delegates upload metadata', async () => {
    const { controller, spacesService } = createController();
    const file = {
      originalname: 'icon.svg',
      mimetype: 'image/svg+xml',
      buffer: Buffer.from('<svg />'),
    } as Express.Multer.File;

    await controller.uploadIcon(user as never, 'space-1', file);

    expect(spacesService.uploadIcon).toHaveBeenCalledWith(
      'space-1',
      'user-1',
      file.buffer,
      'icon.svg',
      'image/svg+xml',
    );
    await expect(
      controller.uploadIcon(user as never, 'space-1', undefined as never),
    ).rejects.toThrow(BadRequestException);
  });

  it('deletes icons and unarchives spaces with user context', async () => {
    const { controller, spacesService } = createController();

    await controller.deleteIcon(user as never, 'space-1');
    await controller.unarchiveSpace(user as never, 'space-1');

    expect(spacesService.deleteIcon).toHaveBeenCalledWith('space-1', 'user-1');
    expect(spacesService.unarchiveSpace).toHaveBeenCalledWith(
      'space-1',
      'user-1',
    );
  });

  it('asks the member rules first on every member route, and stops when they refuse', async () => {
    const { controller, memberRules, spacesService } = createController();
    const no = new ForbiddenException('no');
    const body = { member_id: 'member-1', space_role: 'owner' };
    memberRules.assertSpaceInOrg.mockRejectedValueOnce(no);
    memberRules.assertCanAdd.mockRejectedValueOnce(no);
    memberRules.assertCanChangeRole.mockRejectedValueOnce(no);
    memberRules.assertCanRemove.mockRejectedValueOnce(no);
    memberRules.assertCanInvite.mockRejectedValueOnce(no);

    await expect(controller.getSpaceMembers(user as never, 'space-1')).rejects.toThrow(no);
    await expect(controller.addSpaceMember(user as never, 'space-1', { user_id: 'u' } as never)).rejects.toThrow(no);
    await expect(controller.updateSpaceMember(user as never, body as never, 'space-1')).rejects.toThrow(no);
    await expect(controller.removeSpaceMember(user as never, 'space-1', 'member-1')).rejects.toThrow(no);
    await expect(controller.createSpaceInvitations(user as never, 'space-1', { users: [] } as never)).rejects.toThrow(no);

    expect(spacesService.getSpaceMembersWithDetails).not.toHaveBeenCalled();
    expect(spacesService.addSpaceMember).not.toHaveBeenCalled();
    expect(spacesService.updateSpaceMember).not.toHaveBeenCalled();
    expect(spacesService.removeSpaceMember).not.toHaveBeenCalled();
    expect(spacesService.createSpaceInvitations).not.toHaveBeenCalled();
  });

  it('answers 404 on the read and invitation routes for a space of another org', async () => {
    const { controller, memberRules, spacesService } = createController();
    memberRules.assertSpaceInOrg.mockRejectedValue(new NotFoundException('Space not found'));

    const calls = [
      () => controller.getImplicitMembers(user as never, 'space-9'),
      () => controller.getSpaceInvitations(user as never, 'space-9'),
      () => controller.resendSpaceInvitation(user as never, 'space-9', 'invite-1'),
      () => controller.revokeSpaceInvitation(user as never, 'space-9', 'invite-1'),
    ];
    for (const call of calls) await expect(call()).rejects.toThrow(NotFoundException);

    expect(spacesService.getImplicitSpaceMembers).not.toHaveBeenCalled();
    expect(spacesService.getSpaceInvitations).not.toHaveBeenCalled();
    expect(spacesService.resendSpaceInvitation).not.toHaveBeenCalled();
    expect(spacesService.revokeSpaceInvitation).not.toHaveBeenCalled();
  });

  it('delegates member list, add, update, and implicit member endpoints', async () => {
    const { controller, spacesService } = createController();
    const addDto = { user_id: 'user-2', role: 'member' };
    const updateDto = { member_id: 'member-1', role: 'admin' };

    await controller.getSpaceMembers(user as never, 'space-1');
    await controller.addSpaceMember(user as never, 'space-1', addDto as never);
    await controller.updateSpaceMember(user as never, updateDto as never);
    await expect(controller.getImplicitMembers(user as never, 'space-1')).resolves.toEqual({
      userIds: ['user-2'],
    });

    expect(spacesService.getSpaceMembersWithDetails).toHaveBeenCalledWith(
      'space-1',
      'org-1',
    );
    expect(spacesService.addSpaceMember).toHaveBeenCalledWith(
      'space-1',
      'org-1',
      'user-1',
      addDto,
    );
    expect(spacesService.updateSpaceMember).toHaveBeenCalledWith(
      'member-1',
      updateDto,
      'user-1',
    );
    expect(spacesService.getImplicitSpaceMembers).toHaveBeenCalledWith(
      'space-1',
    );
  });

  it('validates member removal and module permission bodies', async () => {
    const { controller, spacesService } = createController();

    await expect(
      controller.removeSpaceMember(user as never, 'space-1', ''),
    ).rejects.toThrow(BadRequestException);
    await expect(
      controller.removeSpaceMember(user as never, 'space-1', 'member-1'),
    ).resolves.toEqual({ success: true });
    expect(spacesService.removeSpaceMember).toHaveBeenCalledWith(
      'member-1',
      'space-1',
      'org-1',
      'user-1',
    );

    await expect(
      controller.saveModulePermissions(user as never, 'space-1', {}),
    ).rejects.toThrow(BadRequestException);
    await expect(
      controller.saveModulePermissions(user as never, 'space-1', {
        overrides: {
          'base_role:member': { can_view_tasks: true, can_edit_tasks: null },
        },
      }),
    ).resolves.toEqual({ success: true, updated: 2 });
  });

  it('coerces enabled_only when listing modules', async () => {
    const { controller, spacesService } = createController();

    await controller.getSpaceModules(user as never, 'space-1', 'true');
    await controller.getSpaceModules(user as never, 'space-1', 'false');

    expect(spacesService.getSpaceModules).toHaveBeenNthCalledWith(
      1,
      'space-1',
      'org-1',
      true,
    );
    expect(spacesService.getSpaceModules).toHaveBeenNthCalledWith(
      2,
      'space-1',
      'org-1',
      false,
    );
  });

  it('updates modules and reads current/module permissions with scoped inputs', async () => {
    const { controller, spacesService } = createController();
    const dto = { modules: [{ module: 'tasks', enabled: true }] };

    await controller.updateSpaceModules(user as never, 'space-1', dto as never);
    await controller.getMyPermissions(user as never, 'space-1');
    await controller.listModulePermissions(user as never, 'space-1');

    expect(spacesService.updateSpaceModules).toHaveBeenCalledWith(
      'space-1',
      'user-1',
      'org-1',
      dto.modules,
    );
    expect(spacesService.getUserSpacePermissions).toHaveBeenCalledWith(
      'user-1',
      'space-1',
      'org-1',
    );
    expect(spacesService.listModulePermissions).toHaveBeenCalledWith(
      'space-1',
      'org-1',
    );
  });

  it('passes organization and user context for invitations, categories, and task reorder', async () => {
    const { controller, spacesService, categoriesService, tasksService } =
      createController();

    await controller.createSpaceInvitations(user as never, 'space-1', {
      users: [{ email: 'new@example.com', role: 'member' }],
    } as never);
    await controller.getSpaceInvitations(user as never, 'space-1');
    await controller.resendSpaceInvitation(
      user as never,
      'space-1',
      'invite-1',
    );
    await controller.revokeSpaceInvitation(
      user as never,
      'space-1',
      'invite-1',
    );
    await controller.acceptSpaceInvitation(
      user as never,
      'space-1',
      'invite-1',
    );
    await controller.listCategories('space-1');
    await controller.createCategory(user as never, 'space-1', {
      name: 'Category',
    } as never);
    await controller.getCategoryById('space-1', 'category-1');
    await controller.updateCategory(user as never, 'space-1', 'category-1', {
      name: 'Updated',
    } as never);
    await controller.deleteCategory('space-1', 'category-1');
    await expect(
      controller.reorderTasks(user as never, 'space-1', {
        updates: [{ id: 'task-1', sort_order: 1 }],
      } as never),
    ).resolves.toEqual({ success: true, updated: 3 });

    expect(spacesService.createSpaceInvitations).toHaveBeenCalledWith(
      'space-1',
      'org-1',
      'user-1',
      [{ email: 'new@example.com', role: 'member' }],
    );
    expect(spacesService.getSpaceInvitations).toHaveBeenCalledWith('space-1');
    expect(spacesService.resendSpaceInvitation).toHaveBeenCalledWith(
      'space-1',
      'invite-1',
      'org-1',
    );
    expect(spacesService.revokeSpaceInvitation).toHaveBeenCalledWith(
      'space-1',
      'invite-1',
      'user-1',
    );
    expect(spacesService.acceptSpaceInvitation).toHaveBeenCalledWith(
      'space-1',
      'invite-1',
      'user-1',
      'user@example.com',
    );
    expect(categoriesService.getCategories).toHaveBeenCalledWith('space-1');
    expect(categoriesService.createCategory).toHaveBeenCalledWith(
      'space-1',
      'org-1',
      'user-1',
      { name: 'Category' },
    );
    expect(categoriesService.getCategoryById).toHaveBeenCalledWith(
      'category-1',
      'space-1',
    );
    expect(categoriesService.updateCategory).toHaveBeenCalledWith(
      'category-1',
      'space-1',
      'user-1',
      { name: 'Updated' },
    );
    expect(categoriesService.deleteCategory).toHaveBeenCalledWith(
      'category-1',
      'space-1',
    );
    expect(tasksService.reorderTasks).toHaveBeenCalledWith(
      'space-1',
      'org-1',
      'user-1',
      [{ id: 'task-1', sort_order: 1 }],
    );
  });

  it('requires invite_members for space invitation management endpoints', () => {
    const proto = SpacesController.prototype as Record<string, unknown>;
    expect(
      Reflect.getMetadata(SPACE_PERMISSION_KEY, proto['getSpaceInvitations']),
    ).toBe('invite_members');
    expect(
      Reflect.getMetadata(
        SPACE_PERMISSION_KEY,
        proto['createSpaceInvitations'],
      ),
    ).toBe('invite_members');
    expect(
      Reflect.getMetadata(SPACE_PERMISSION_KEY, proto['resendSpaceInvitation']),
    ).toBe('invite_members');
    expect(
      Reflect.getMetadata(SPACE_PERMISSION_KEY, proto['revokeSpaceInvitation']),
    ).toBe('invite_members');
    expect(
      Reflect.getMetadata(SPACE_PERMISSION_KEY, proto['acceptSpaceInvitation']),
    ).toBeUndefined();
  });

  it('requires space permissions for member management endpoints', () => {
    const proto = SpacesController.prototype as Record<string, unknown>;
    expect(
      Reflect.getMetadata(SPACE_PERMISSION_KEY, proto['getSpaceMembers']),
    ).toBe('view_space');
    expect(
      Reflect.getMetadata(SPACE_PERMISSION_KEY, proto['getImplicitMembers']),
    ).toBe('view_space');
    expect(
      Reflect.getMetadata(SPACE_PERMISSION_KEY, proto['addSpaceMember']),
    ).toBe('manage_members');
    expect(
      Reflect.getMetadata(SPACE_PERMISSION_KEY, proto['updateSpaceMember']),
    ).toBe('manage_members');
    expect(
      Reflect.getMetadata(SPACE_PERMISSION_KEY, proto['removeSpaceMember']),
    ).toBe('manage_members');
  });
});
