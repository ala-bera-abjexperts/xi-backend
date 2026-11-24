import { ConflictException, ForbiddenException } from '@nestjs/common';

import { SPACE_PERMISSION_KEY } from '../auth/decorators/require-space-permission.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { runControllerContractSuite } from '../test/controller-contract.helper';
import { WhiteboardLiveController } from './whiteboard-live.controller';

runControllerContractSuite({
  controller: WhiteboardLiveController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});

/** The rights of docs/whiteboard-rail-features-plan.md §9, and a rate limit on every write. */
describe('WhiteboardLiveController rights and limits', () => {
  const proto = WhiteboardLiveController.prototype as unknown as Record<
    string,
    object
  >;
  const permission = (method: string): unknown =>
    Reflect.getMetadata(SPACE_PERMISSION_KEY, proto[method]);
  const limit = (method: string): unknown =>
    Reflect.getMetadata('THROTTLER:LIMITdefault', proto[method]);

  it.each(['token', 'getTimer', 'commandTimer', 'getPrivateMode'])(
    '%s: anyone who can view whiteboards',
    (method) => {
      expect(permission(method)).toBe('view_whiteboards');
    },
  );

  it.each(['startPrivateMode', 'endPrivateMode'])(
    '%s: editors only',
    (method) => {
      expect(permission(method)).toBe('edit_whiteboards');
    },
  );

  it.each([
    ['token', 30],
    ['commandTimer', 30],
    ['startPrivateMode', 10],
    ['endPrivateMode', 10],
  ])('%s is rate limited to %i/min', (method, max) => {
    expect(limit(method)).toBe(max);
  });
});

describe('WhiteboardLiveController.token scene rights', () => {
  const user = {
    userId: 'u-1',
    organizationId: 'org-1',
  } as RequestUser;
  let live: { resolveBoard: jest.Mock; mintToken: jest.Mock };
  let permissions: { hasSpacePermission: jest.Mock };
  let controller: WhiteboardLiveController;

  beforeEach(() => {
    live = {
      resolveBoard: jest.fn().mockResolvedValue(undefined),
      mintToken: jest.fn().mockResolvedValue({ token: 't' }),
    };
    permissions = { hasSpacePermission: jest.fn().mockResolvedValue(true) };
    controller = new WhiteboardLiveController(
      live as never,
      permissions as never,
    );
  });

  it('an editor gets a writable scene topic (same checks as a scene save)', async () => {
    await controller.token('space-1', 'board-1', user);

    expect(permissions.hasSpacePermission).toHaveBeenCalledWith(
      'u-1',
      'org-1',
      'space-1',
      'edit_whiteboards',
    );
    expect(live.resolveBoard).toHaveBeenLastCalledWith(
      user,
      'space-1',
      'board-1',
      'can_edit',
      true,
    );
    expect(live.mintToken).toHaveBeenCalledWith(user, 'board-1', true);
  });

  it('without edit_whiteboards: read-only, no board edit check', async () => {
    permissions.hasSpacePermission.mockResolvedValue(false);

    await controller.token('space-1', 'board-1', user);

    expect(live.resolveBoard).toHaveBeenCalledTimes(1);
    expect(live.mintToken).toHaveBeenCalledWith(user, 'board-1', false);
  });

  it.each([
    ['archived', new ConflictException('archived')],
    ['Share view only', new ForbiddenException()],
  ])('%s board: read-only, the token is still issued', async (_, err) => {
    live.resolveBoard
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(err);

    await expect(controller.token('space-1', 'board-1', user)).resolves.toEqual(
      { token: 't' },
    );
    expect(live.mintToken).toHaveBeenCalledWith(user, 'board-1', false);
  });

  it('a failing permission lookup only means read-only', async () => {
    permissions.hasSpacePermission.mockRejectedValue(new Error('db down'));

    await controller.token('space-1', 'board-1', user);

    expect(live.mintToken).toHaveBeenCalledWith(user, 'board-1', false);
  });

  it('a board the caller cannot view still fails the request', async () => {
    live.resolveBoard.mockRejectedValue(new ForbiddenException());

    await expect(
      controller.token('space-1', 'board-1', user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(live.mintToken).not.toHaveBeenCalled();
  });
});
