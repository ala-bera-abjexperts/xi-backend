import { runControllerContractSuite } from '../test/controller-contract.helper';
import { BoardsController } from './boards.controller';

runControllerContractSuite({
  controller: BoardsController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});

describe('BoardsController card move contract', () => {
  it('returns the service move-card wrapper without adding another data layer', async () => {
    const response = {
      data: {
        id: 'ranking-1',
        task_id: 'task-1',
        column_id: 'column-2',
        version: 2,
      },
      success: true,
    };
    const service = {
      moveCard: jest.fn().mockResolvedValue(response),
    };
    const controller = new BoardsController(service as never);
    const user = {
      userId: 'user-1',
      organizationId: 'org-1',
    };
    const dto = {
      task_id: 'task-1',
      source_column_id: 'column-1',
      target_column_id: 'column-2',
      new_position: 1000,
      expected_version: 1,
    };

    await expect(
      controller.moveCard(user as never, 'board-1', dto as never),
    ).resolves.toBe(response);

    expect(service.moveCard).toHaveBeenCalledWith(
      'board-1',
      'org-1',
      'user-1',
      dto,
    );
  });
});
