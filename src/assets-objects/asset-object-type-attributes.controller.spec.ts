/**
 * @fileoverview Smoke tests for AssetObjectTypeAttributesController.
 * @module src/assets-objects/asset-object-type-attributes.controller.spec
 */
import { AssetObjectTypeAttributesController } from './asset-object-type-attributes.controller';

const mockUser = { userId: 'user-1', organizationId: 'org-1' };

const mockAttr = {
  id: 'attr-1',
  object_type_id: 'type-1',
  name: 'IP Address',
  field_key: 'ip_address',
  data_type: 'text',
  is_required: false,
  sort_order: 0,
  created_at: '',
  updated_at: '',
};

function createController() {
  const service = {
    list: jest.fn().mockResolvedValue([mockAttr]),
    create: jest.fn().mockResolvedValue(mockAttr),
    update: jest.fn().mockResolvedValue(mockAttr),
    delete: jest.fn().mockResolvedValue(undefined),
  };

  return {
    controller: new AssetObjectTypeAttributesController(service as never),
    service,
  };
}

describe('AssetObjectTypeAttributesController', () => {
  it('list() returns data array', async () => {
    const { controller } = createController();
    const result = await controller.list(
      'space-1',
      'type-1',
      mockUser as never,
    );

    expect(result).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(result[0].field_key).toBe('ip_address');
  });

  it('create() merges objectTypeId into dto and returns attribute', async () => {
    const { controller, service } = createController();
    const dto = {
      name: 'IP Address',
      field_key: 'ip_address',
      data_type: 'text',
    } as never;
    const result = await controller.create(
      'space-1',
      'type-1',
      dto,
      mockUser as never,
    );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(result.id).toBe('attr-1');
    expect(service.create).toHaveBeenCalledWith(
      { ...dto, object_type_id: 'type-1' },
      'space-1',
      'org-1',
      'user-1',
    );
  });

  it('update() returns updated attribute', async () => {
    const { controller, service } = createController();
    const dto = { name: 'Updated IP' } as never;
    const result = await controller.update(
      'space-1',
      'attr-1',
      dto,
      mockUser as never,
    );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(result.id).toBe('attr-1');
    expect(service.update).toHaveBeenCalledWith(
      'attr-1',
      dto,
      'space-1',
      'org-1',
      'user-1',
    );
  });

  it('delete() delegates to service', async () => {
    const { controller, service } = createController();
    await controller.delete('space-1', 'attr-1', mockUser as never);

    expect(service.delete).toHaveBeenCalledWith('attr-1', 'space-1', 'org-1');
  });

  it('list() propagates service errors', async () => {
    const { controller, service } = createController();
    service.list.mockRejectedValue(new Error('Not found'));

    await expect(
      controller.list('space-1', 'type-1', mockUser as never),
    ).rejects.toThrow('Not found');
  });

  it('create() propagates service errors for duplicate field_key', async () => {
    const { controller, service } = createController();
    service.create.mockRejectedValue(new Error('field_key already exists'));

    await expect(
      controller.create('space-1', 'type-1', {} as never, mockUser as never),
    ).rejects.toThrow('field_key already exists');
  });
});
