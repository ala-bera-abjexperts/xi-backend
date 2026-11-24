import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { runControllerContractSuite } from '../test/controller-contract.helper';
import { PermissionsController } from './permissions.controller';

runControllerContractSuite({
  controller: PermissionsController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});

describe('PermissionsController manual behavior', () => {
  const user = {
    userId: 'user-1',
    organizationId: 'org-1',
  };

  function setup() {
    const service = {
      getUserEffectivePermissions: jest.fn(),
      getEffectiveSpaceSlice: jest.fn(),
      checkPermission: jest.fn(),
      hasAnyPermission: jest.fn(),
      hasAllPermissions: jest.fn(),
      getMenuPermissions: jest.fn(),
      getAllMenuPermissions: jest.fn(),
      isAdminOrOwner: jest.fn(),
      saveMenuPermission: jest.fn(),
      saveMenuPermissions: jest.fn(),
      deleteMenuPermission: jest.fn(),
      getSpaceOverrides: jest.fn(),
      assertCanManageSpacePermissions: jest.fn(),
      bulkSaveSpaceOverrides: jest.fn(),
      getLevelPermissions: jest.fn(),
      getAllLevelPermissions: jest.fn(),
      saveLevelPermission: jest.fn(),
      deleteLevelPermission: jest.fn(),
    };
    const controller = new PermissionsController(service as any);
    return { controller, service };
  }

  it('returns the effective permissions unchanged when no space param is given', async () => {
    const { controller, service } = setup();
    service.getUserEffectivePermissions.mockResolvedValue({
      base_role: 'admin',
    });

    await expect(controller.getEffective(user as any)).resolves.toEqual({
      data: { base_role: 'admin' },
      success: true,
    });
    // No space param, so the slice resolver isn't called and the response is unchanged.
    expect(service.getEffectiveSpaceSlice).not.toHaveBeenCalled();
  });

  it('appends the space slice when a spaceId is supplied', async () => {
    const { controller, service } = setup();
    service.getUserEffectivePermissions.mockResolvedValue({
      base_role: 'admin',
    });
    service.getEffectiveSpaceSlice.mockResolvedValue({
      id: 'space-1',
      key: 'ENG',
      role: 'admin',
      permissions: { view_space: true },
    });

    await expect(
      controller.getEffective(user as any, 'space-1'),
    ).resolves.toEqual({
      data: { base_role: 'admin' },
      space: {
        id: 'space-1',
        key: 'ENG',
        role: 'admin',
        permissions: { view_space: true },
      },
      success: true,
    });
    expect(service.getEffectiveSpaceSlice).toHaveBeenCalledWith(
      'user-1',
      'org-1',
      { spaceId: 'space-1', spaceKey: undefined },
    );
  });

  it('returns space:null for a non-member/cross-org space (no leak)', async () => {
    const { controller, service } = setup();
    service.getUserEffectivePermissions.mockResolvedValue({
      base_role: 'admin',
    });
    service.getEffectiveSpaceSlice.mockResolvedValue(null);

    await expect(
      controller.getEffective(user as any, undefined, 'SECRET'),
    ).resolves.toEqual({
      data: { base_role: 'admin' },
      space: null,
      success: true,
    });
    expect(service.getEffectiveSpaceSlice).toHaveBeenCalledWith(
      'user-1',
      'org-1',
      { spaceId: undefined, spaceKey: 'SECRET' },
    );
  });

  it('requires either permission or permissions for permission checks', async () => {
    const { controller, service } = setup();

    await expect(controller.check(user as any, {} as any)).rejects.toThrow(
      BadRequestException,
    );
    expect(service.checkPermission).not.toHaveBeenCalled();
  });

  it('checks a single permission and wraps the boolean result', async () => {
    const { controller, service } = setup();
    service.checkPermission.mockResolvedValue(true);

    await expect(
      controller.check(user as any, { permission: 'can_view_boards' } as any),
    ).resolves.toEqual({ data: true, success: true });
    expect(service.checkPermission).toHaveBeenCalledWith(
      'user-1',
      'org-1',
      'can_view_boards',
    );
  });

  it('supports any-mode multi-permission checks', async () => {
    const { controller, service } = setup();
    service.hasAnyPermission.mockResolvedValue(true);

    await expect(
      controller.check(
        user as any,
        {
          permissions: ['can_view_boards', 'can_edit_boards'],
          mode: 'any',
        } as any,
      ),
    ).resolves.toEqual({
      data: {
        allowed: true,
        mode: 'any',
        permissions: ['can_view_boards', 'can_edit_boards'],
      },
      success: true,
    });
    expect(service.hasAnyPermission).toHaveBeenCalledWith('user-1', 'org-1', [
      'can_view_boards',
      'can_edit_boards',
    ]);
  });

  it('blocks menu writes when the user is not an admin or owner', async () => {
    const { controller, service } = setup();
    service.isAdminOrOwner.mockResolvedValue(false);

    await expect(
      controller.saveMenu(user as any, { menuKey: 'boards' } as any),
    ).rejects.toThrow(ForbiddenException);
    expect(service.saveMenuPermission).not.toHaveBeenCalled();
  });

  it('returns the bulk space update count message', async () => {
    const { controller, service } = setup();
    service.bulkSaveSpaceOverrides.mockResolvedValue({
      roleCount: 2,
      baseRoleCount: 1,
      groupCount: 3,
    });

    await expect(
      controller.updateSpaces(user as any, { permissions: [] } as any),
    ).resolves.toEqual({
      success: true,
      message: 'Updated 2 role(s), 1 base role(s), 3 group(s)',
    });
    expect(service.assertCanManageSpacePermissions).toHaveBeenCalledWith(
      'user-1',
      'org-1',
    );
  });

  it('splits level permission identity fields from permission flags', async () => {
    const { controller, service } = setup();
    service.isAdminOrOwner.mockResolvedValue(true);
    service.saveLevelPermission.mockResolvedValue({ id: 'level-perm-1' });

    await controller.saveLevel(
      user as any,
      {
        hierarchyLevelId: 'level-1',
        entityType: 'task',
        targetType: 'role',
        targetId: 'role-1',
        canView: true,
      } as any,
    );

    expect(service.saveLevelPermission).toHaveBeenCalledWith(
      'org-1',
      'level-1',
      'task',
      'role',
      'role-1',
      null,
      { canView: true },
      'user-1',
    );
  });
});
