import { runControllerContractSuite } from '../test/controller-contract.helper';
import { BoardPermissionsController } from './board-permissions.controller';

runControllerContractSuite({
  controller: BoardPermissionsController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});

describe('BoardPermissionsController manual behavior', () => {
  const user = {
    userId: 'user-1',
    organizationId: 'org-1',
  };

  function setup() {
    const service = {
      getAll: jest.fn(),
      grant: jest.fn(),
      update: jest.fn(),
      revoke: jest.fn(),
    };
    const controller = new BoardPermissionsController(service as any);
    return { controller, service };
  }

  it('lists board permissions scoped to the current organization', () => {
    const { controller, service } = setup();

    controller.getAll(user as any, 'board-1');

    expect(service.getAll).toHaveBeenCalledWith('board-1', 'org-1', 'user-1');
  });

  it('updates by permission id, board id, organization id, and DTO', () => {
    const { controller, service } = setup();
    const dto = { permission_level: 'edit' };

    controller.update(user as any, 'board-1', 'permission-1', dto as any);

    expect(service.update).toHaveBeenCalledWith(
      'permission-1',
      'board-1',
      'org-1',
      dto,
      'user-1',
    );
  });
});
