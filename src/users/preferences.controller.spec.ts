import { BadRequestException } from '@nestjs/common';
import { runControllerContractSuite } from '../test/controller-contract.helper';
import { PreferencesController } from './preferences.controller';

runControllerContractSuite({
  controller: PreferencesController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});

describe('PreferencesController manual behavior', () => {
  const user = {
    userId: 'user-1',
    organizationId: 'org-1',
  };

  function setup() {
    const service = {
      getRecentItems: jest.fn(),
      trackAccess: jest.fn(),
      clearAllRecentItems: jest.fn(),
      deleteRecentItem: jest.fn(),
      getSidebarPreferences: jest.fn(),
      updateSidebarPreferences: jest.fn(),
      resetSidebarPreferences: jest.fn(),
      getStarredSpaces: jest.fn(),
      toggleStar: jest.fn(),
      getColumnPreferences: jest.fn(),
      saveColumnPreferences: jest.fn(),
      resetColumnPreferences: jest.fn(),
    };
    const controller = new PreferencesController(service as any);
    return { controller, service };
  }

  it('converts recent item limit and forwards the item type filter', async () => {
    const { controller, service } = setup();
    service.getRecentItems.mockResolvedValue([{ id: 'recent-1' }]);

    await controller.getRecentItems(user as any, 25 as any, 'task');

    expect(service.getRecentItems).toHaveBeenCalledWith(
      'user-1',
      'org-1',
      25,
      'task',
    );
  });

  it('tracks access with user and organization context', async () => {
    const { controller, service } = setup();
    const dto = { item_id: 'item-1', item_type: 'task' };

    await controller.trackAccess(user as any, dto as any);

    expect(service.trackAccess).toHaveBeenCalledWith('user-1', 'org-1', dto);
  });

  it('toggles starred spaces using the DTO space_id', async () => {
    const { controller, service } = setup();
    service.toggleStar.mockResolvedValue({
      is_starred: true,
      space_id: 'space-1',
    });

    await expect(
      controller.toggleStar(user as any, { space_id: 'space-1' }),
    ).resolves.toEqual({ is_starred: true, space_id: 'space-1' });
    expect(service.toggleStar).toHaveBeenCalledWith(
      'user-1',
      'org-1',
      'space-1',
    );
  });

  it('requires viewId for reading and resetting column preferences', async () => {
    const { controller, service } = setup();

    await expect(
      controller.getColumnPreferences(user as any, undefined),
    ).rejects.toThrow(BadRequestException);
    await expect(
      controller.resetColumnPreferences(user as any, undefined),
    ).rejects.toThrow(BadRequestException);
    expect(service.getColumnPreferences).not.toHaveBeenCalled();
    expect(service.resetColumnPreferences).not.toHaveBeenCalled();
  });

  it('passes organization context when listing scoped preference resources', async () => {
    const { controller, service } = setup();
    service.getRecentItems.mockResolvedValue([]);
    service.getSidebarPreferences.mockResolvedValue({ config: {} });
    service.getStarredSpaces.mockResolvedValue([]);

    await controller.getRecentItems(user as any);
    await controller.getSidebarPreferences(user as any);
    await controller.getStarredSpaces(user as any);

    expect(service.getRecentItems).toHaveBeenCalledWith(
      'user-1',
      'org-1',
      undefined,
      undefined,
    );
    expect(service.getSidebarPreferences).toHaveBeenCalledWith(
      'user-1',
      'org-1',
    );
    expect(service.getStarredSpaces).toHaveBeenCalledWith('user-1', 'org-1');
  });
});
