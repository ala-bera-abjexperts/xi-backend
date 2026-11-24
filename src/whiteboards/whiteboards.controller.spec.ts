import { ConflictException } from '@nestjs/common';

import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { runControllerContractSuite } from '../test/controller-contract.helper';
import { WhiteboardsController } from './whiteboards.controller';

runControllerContractSuite({
  controller: WhiteboardsController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});

describe('WhiteboardsController scene_changed broadcasts', () => {
  const user = { userId: 'u-1', organizationId: 'org-1' } as RequestUser;
  let service: Record<string, jest.Mock>;
  let live: { broadcast: jest.Mock };
  let controller: WhiteboardsController;

  beforeEach(() => {
    service = {
      assertBoardAccess: jest.fn().mockResolvedValue(undefined),
      saveScene: jest
        .fn()
        .mockResolvedValue({ revision: 5, updated_at: '2026-10-09' }),
      restoreVersion: jest
        .fn()
        .mockResolvedValue({ id: 'board-1', revision: 9 }),
    };
    live = { broadcast: jest.fn().mockResolvedValue(undefined) };
    controller = new WhiteboardsController(service as never, live as never);
  });

  it('after a save, with the new revision', async () => {
    await expect(
      controller.saveScene('space-1', 'board-1', {} as never, user),
    ).resolves.toEqual({ revision: 5, updated_at: '2026-10-09' });
    expect(live.broadcast).toHaveBeenCalledWith('board-1', 'scene_changed', {
      revision: 5,
    });
  });

  it('after a restore, with the new revision', async () => {
    await controller.restoreVersion('space-1', 'board-1', 3, user);

    expect(live.broadcast).toHaveBeenCalledWith('board-1', 'scene_changed', {
      revision: 9,
    });
  });

  it('not when the save fails', async () => {
    service.saveScene.mockRejectedValue(new ConflictException('conflict'));

    await expect(
      controller.saveScene('space-1', 'board-1', {} as never, user),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(live.broadcast).not.toHaveBeenCalled();
  });

  it('not when the restore fails', async () => {
    service.restoreVersion.mockRejectedValue(new ConflictException('archived'));

    await expect(
      controller.restoreVersion('space-1', 'board-1', 3, user),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(live.broadcast).not.toHaveBeenCalled();
  });
});
