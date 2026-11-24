/**
 * @fileoverview Smoke tests for AssetObjectReferencesController.
 * @module src/assets-objects/asset-object-references.controller.spec
 */
import { AssetObjectReferencesController } from './asset-object-references.controller';

const mockUser = { userId: 'user-1', organizationId: 'org-1' };

const mockRef = {
  id: 'ref-1',
  source_object_id: 'obj-1',
  target_object_id: 'obj-2',
  relation_type_id: null,
  attribute_id: null,
  created_by: 'user-1',
  created_at: '',
};

const mockGrouped = {
  outbound: [mockRef],
  inbound: [],
};

function createController() {
  const service = {
    getGrouped: jest.fn().mockResolvedValue(mockGrouped),
    create: jest.fn().mockResolvedValue(mockRef),
    delete: jest.fn().mockResolvedValue(undefined),
  };

  return {
    controller: new AssetObjectReferencesController(service as never),
    service,
  };
}

describe('AssetObjectReferencesController', () => {
  it('getGrouped() returns inbound and outbound arrays', async () => {
    const { controller } = createController();
    const result = await controller.getGrouped(
      'space-1',
      'obj-1',
      mockUser as never,
    );

    expect(result.outbound).toHaveLength(1);
    expect(result.inbound).toHaveLength(0);
  });

  it('create() delegates with correct args and returns reference', async () => {
    const { controller, service } = createController();
    const dto = { target_object_id: 'obj-2' } as never;
    const result = await controller.create(
      'space-1',
      'obj-1',
      dto,
      mockUser as never,
    );

    expect(result.id).toBe('ref-1');
    expect(service.create).toHaveBeenCalledWith(
      'space-1',
      'org-1',
      'user-1',
      'obj-1',
      dto,
    );
  });

  it('delete() delegates with correct args', async () => {
    const { controller, service } = createController();
    await controller.delete('space-1', 'obj-1', 'ref-1', mockUser as never);

    expect(service.delete).toHaveBeenCalledWith(
      'space-1',
      'org-1',
      'user-1',
      'obj-1',
      'ref-1',
    );
  });

  it('create() propagates self-reference error from service', async () => {
    const { controller, service } = createController();
    service.create.mockRejectedValue(
      new Error('Self-references are not allowed'),
    );

    await expect(
      controller.create('space-1', 'obj-1', {} as never, mockUser as never),
    ).rejects.toThrow('Self-references are not allowed');
  });

  it('create() propagates duplicate reference error', async () => {
    const { controller, service } = createController();
    service.create.mockRejectedValue(new Error('Reference already exists'));

    await expect(
      controller.create('space-1', 'obj-1', {} as never, mockUser as never),
    ).rejects.toThrow('Reference already exists');
  });

  it('delete() propagates not-found errors', async () => {
    const { controller, service } = createController();
    service.delete.mockRejectedValue(new Error('Reference not found'));

    await expect(
      controller.delete('space-1', 'obj-1', 'ref-99', mockUser as never),
    ).rejects.toThrow('Reference not found');
  });
});
