/**
 * @fileoverview Smoke tests for AssetObjectSchemasController.
 * @module src/assets-objects/asset-object-schemas.controller.spec
 */
import { AssetObjectSchemasController } from './asset-object-schemas.controller';

const mockUser = { userId: 'user-1', organizationId: 'org-1' };

const mockSchema = {
  id: 'schema-1',
  space_id: 'space-1',
  organization_id: 'org-1',
  name: 'IT Infrastructure',
  object_key: 'CMDB',
  description: null,
  icon: null,
  color: null,
  is_archived: false,
  version: 1,
  created_at: '',
  updated_at: '',
};

function createController() {
  const service = {
    list: jest.fn().mockResolvedValue([mockSchema]),
    getOne: jest.fn().mockResolvedValue(mockSchema),
    create: jest.fn().mockResolvedValue(mockSchema),
    update: jest.fn().mockResolvedValue(mockSchema),
    archive: jest.fn().mockResolvedValue({ ...mockSchema, is_archived: true }),
    delete: jest.fn().mockResolvedValue(undefined),
  };

  return {
    controller: new AssetObjectSchemasController(service as never),
    service,
  };
}

describe('AssetObjectSchemasController', () => {
  it('list() returns data array', async () => {
    const { controller } = createController();
    const result = await controller.list('space-1', mockUser as never);

    expect(result).toHaveLength(1);
    expect(result[0].object_key).toBe('CMDB');
  });

  it('create() delegates to service and returns schema', async () => {
    const { controller, service } = createController();
    const dto = { name: 'IT Infrastructure', object_key: 'CMDB' } as never;
    const result = await controller.create('space-1', dto, mockUser as never);

    expect(result.id).toBe('schema-1');
    expect(service.create).toHaveBeenCalledWith(
      dto,
      'space-1',
      'org-1',
      'user-1',
    );
  });

  it('getOne() returns single schema', async () => {
    const { controller } = createController();
    const result = await controller.getOne(
      'space-1',
      'schema-1',
      mockUser as never,
    );

    expect(result.id).toBe('schema-1');
  });

  it('update() calls service with correct args', async () => {
    const { controller, service } = createController();
    const dto = { name: 'Updated', version: 1 } as never;
    const result = await controller.update(
      'space-1',
      'schema-1',
      dto,
      mockUser as never,
    );

    expect(result.id).toBe('schema-1');
    expect(service.update).toHaveBeenCalledWith(
      'schema-1',
      dto,
      'space-1',
      'org-1',
      'user-1',
    );
  });

  it('archive() delegates to service', async () => {
    const { controller, service } = createController();
    await controller.archive('space-1', 'schema-1', mockUser as never);

    expect(service.archive).toHaveBeenCalledWith(
      'schema-1',
      'space-1',
      'org-1',
      'user-1',
    );
  });

  it('delete() delegates to service', async () => {
    const { controller, service } = createController();
    await controller.delete('space-1', 'schema-1', mockUser as never);

    expect(service.delete).toHaveBeenCalledWith('schema-1', 'space-1', 'org-1');
  });

  it('list() propagates service errors', async () => {
    const { controller, service } = createController();
    service.list.mockRejectedValue(new Error('DB error'));

    await expect(controller.list('space-1', mockUser as never)).rejects.toThrow(
      'DB error',
    );
  });

  it('create() propagates service errors', async () => {
    const { controller, service } = createController();
    service.create.mockRejectedValue(new Error('Duplicate key'));

    await expect(
      controller.create('space-1', {} as never, mockUser as never),
    ).rejects.toThrow('Duplicate key');
  });

  it('delete() propagates service errors when schema has types', async () => {
    const { controller, service } = createController();
    service.delete.mockRejectedValue(new Error('Schema has object types'));

    await expect(
      controller.delete('space-1', 'schema-1', mockUser as never),
    ).rejects.toThrow('Schema has object types');
  });
});
