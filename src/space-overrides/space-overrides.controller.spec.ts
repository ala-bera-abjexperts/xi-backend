import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SpaceOverridesController } from './space-overrides.controller';

const user = { userId: 'user-1', organizationId: 'org-1' };

function createController() {
  const service = {
    getOverrides: jest.fn().mockResolvedValue({ entity1: true }),
    setOverride: jest.fn().mockResolvedValue(undefined),
  };
  const permissions = {
    checkPermission: jest.fn().mockResolvedValue(true),
    getUserSpacePermissions: jest.fn().mockResolvedValue({
      permissions: {},
    }),
  };

  return {
    controller: new SpaceOverridesController(
      service as never,
      permissions as never,
    ),
    service,
    permissions,
  };
}

describe('SpaceOverridesController', () => {
  it('requires a space and supported override type before listing overrides', async () => {
    const { controller, service } = createController();

    await expect(
      controller.getOverrides(user as never, 'space-1', 'priority'),
    ).resolves.toEqual({
      data: { entity1: true },
    });
    expect(service.getOverrides).toHaveBeenCalledWith(
      'org-1',
      'space-1',
      'priority',
    );

    await expect(
      controller.getOverrides(user as never, undefined, 'priority'),
    ).rejects.toThrow(BadRequestException);
    await expect(
      controller.getOverrides(user as never, 'space-1', 'invalid'),
    ).rejects.toThrow(BadRequestException);
  });

  it('passes organization context when setting an override', async () => {
    const { controller, service, permissions } = createController();
    const dto = {
      spaceId: 'space-1',
      type: 'status',
      entityId: 'status-1',
      isEnabled: true,
    };

    await expect(
      controller.setOverride(user as never, dto as never),
    ).resolves.toEqual({ success: true });
    expect(permissions.checkPermission).toHaveBeenCalledWith(
      'user-1',
      'org-1',
      'can_edit_statuses',
    );
    expect(service.setOverride).toHaveBeenCalledWith('org-1', 'user-1', dto);
  });

  it('falls back to type-specific space permissions', async () => {
    const { controller, service, permissions } = createController();
    permissions.checkPermission.mockResolvedValue(false);
    permissions.getUserSpacePermissions.mockResolvedValue({
      permissions: { edit_priorities: true },
    });
    const dto = {
      spaceId: 'space-1',
      type: 'priority',
      entityId: 'priority-1',
      isEnabled: false,
    };

    await expect(
      controller.setOverride(user as never, dto as never),
    ).resolves.toEqual({ success: true });
    expect(service.setOverride).toHaveBeenCalledWith('org-1', 'user-1', dto);
  });

  it('rejects writes without the permission for the requested override type', async () => {
    const { controller, service, permissions } = createController();
    permissions.checkPermission.mockResolvedValue(false);
    permissions.getUserSpacePermissions.mockResolvedValue({
      permissions: { edit_priorities: true },
    });

    await expect(
      controller.setOverride(
        user as never,
        {
          spaceId: 'space-1',
          type: 'status',
          entityId: 'status-1',
          isEnabled: true,
        } as never,
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(service.setOverride).not.toHaveBeenCalled();
  });
});
