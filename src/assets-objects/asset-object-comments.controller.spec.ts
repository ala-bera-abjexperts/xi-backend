/**
 * @fileoverview Smoke tests for AssetObjectCommentsController.
 * @module src/assets-objects/asset-object-comments.controller.spec
 */
import { AssetObjectCommentsController } from './asset-object-comments.controller';

const mockUser = { userId: 'user-1', organizationId: 'org-1' };

const mockComment = {
  id: 'comment-1',
  object_id: 'obj-1',
  content: 'Rebooted at 2:15 AM after memory spike.',
  created_by: 'user-1',
  created_at: '',
  updated_at: '',
};

function createController() {
  const service = {
    getAll: jest.fn().mockResolvedValue([mockComment]),
    create: jest.fn().mockResolvedValue(mockComment),
    update: jest.fn().mockResolvedValue({ ...mockComment, content: 'Edited.' }),
    delete: jest.fn().mockResolvedValue(undefined),
  };

  return {
    controller: new AssetObjectCommentsController(service as never),
    service,
  };
}

describe('AssetObjectCommentsController', () => {
  it('getAll() returns comments list from service', async () => {
    const { controller } = createController();
    const result = await controller.getAll(
      'space-1',
      'obj-1',
      mockUser as never,
    );

    expect(result).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(result[0].content).toBe('Rebooted at 2:15 AM after memory spike.');
  });

  it('create() delegates to service and returns comment', async () => {
    const { controller, service } = createController();
    const dto = { content: 'Rebooted at 2:15 AM after memory spike.' } as never;
    const result = await controller.create(
      'space-1',
      'obj-1',
      dto,
      mockUser as never,
    );

    expect(result.id).toBe('comment-1');
    expect(service.create).toHaveBeenCalledWith(
      'obj-1',
      'space-1',
      'org-1',
      'user-1',
      dto,
    );
  });

  it('update() delegates to service with correct args', async () => {
    const { controller, service } = createController();
    const dto = { content: 'Edited.' } as never;
    await controller.update(
      'space-1',
      'obj-1',
      'comment-1',
      dto,
      mockUser as never,
    );

    expect(service.update).toHaveBeenCalledWith(
      'comment-1',
      'obj-1',
      'space-1',
      'org-1',
      'user-1',
      dto,
    );
  });

  it('delete() delegates to service with correct args', async () => {
    const { controller, service } = createController();
    await controller.delete('space-1', 'obj-1', 'comment-1', mockUser as never);

    expect(service.delete).toHaveBeenCalledWith(
      'comment-1',
      'obj-1',
      'space-1',
      'org-1',
      'user-1',
    );
  });

  it('update() propagates forbidden error when user is not author', async () => {
    const { controller, service } = createController();
    service.update.mockRejectedValue(
      new Error('Forbidden: not the comment author'),
    );

    await expect(
      controller.update(
        'space-1',
        'obj-1',
        'comment-1',
        {} as never,
        mockUser as never,
      ),
    ).rejects.toThrow('Forbidden: not the comment author');
  });

  it('delete() propagates forbidden error when user is not author', async () => {
    const { controller, service } = createController();
    service.delete.mockRejectedValue(
      new Error('Forbidden: not the comment author'),
    );

    await expect(
      controller.delete('space-1', 'obj-1', 'comment-1', mockUser as never),
    ).rejects.toThrow('Forbidden: not the comment author');
  });

  it('create() propagates service errors', async () => {
    const { controller, service } = createController();
    service.create.mockRejectedValue(new Error('Object not found'));

    await expect(
      controller.create('space-1', 'obj-1', {} as never, mockUser as never),
    ).rejects.toThrow('Object not found');
  });
});
