import { BadRequestException } from '@nestjs/common';
import { RelationTypesController } from './relation-types.controller';

const user = { userId: 'user-1', organizationId: 'org-1' };

function createController() {
  const service = {
    getAll: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: 'relation-type-1' }),
    getById: jest.fn().mockResolvedValue({ id: 'relation-type-1' }),
    update: jest.fn().mockResolvedValue({ id: 'relation-type-1' }),
    toggleActive: jest.fn().mockResolvedValue({ id: 'relation-type-1' }),
    duplicate: jest.fn().mockResolvedValue({ id: 'relation-type-copy' }),
    delete: jest.fn().mockResolvedValue(undefined),
  };

  return {
    controller: new RelationTypesController(service as never),
    service,
  };
}

describe('RelationTypesController', () => {
  it('coerces includeInactive only for the literal true string', async () => {
    const { controller, service } = createController();

    await controller.list(user as never, 'true');
    await controller.list(user as never, 'false');

    expect(service.getAll).toHaveBeenNthCalledWith(1, 'org-1', true);
    expect(service.getAll).toHaveBeenNthCalledWith(2, 'org-1', false);
  });

  it('creates relation types with organization and actor context', async () => {
    const { controller, service } = createController();
    const dto = { name: 'Blocks' };

    await controller.create(user as never, dto as never);

    expect(service.create).toHaveBeenCalledWith('org-1', 'user-1', dto);
  });

  it('gets relation types by id with organization scope', async () => {
    const { controller, service } = createController();

    await controller.getById(user as never, 'relation-type-1');

    expect(service.getById).toHaveBeenCalledWith('relation-type-1', 'org-1');
  });

  it('updates relation types with organization and actor context', async () => {
    const { controller, service } = createController();
    const dto = { name: 'Depends on' };

    await controller.update(user as never, 'relation-type-1', dto as never);

    expect(service.update).toHaveBeenCalledWith(
      'relation-type-1',
      'org-1',
      'user-1',
      dto,
    );
  });

  it('dispatches patch actions and validates toggle_active payloads', async () => {
    const { controller, service } = createController();

    await controller.patch(user as never, 'relation-type-1', {
      action: 'toggle_active',
      is_active: false,
    } as never);
    await controller.patch(user as never, 'relation-type-1', {
      action: 'duplicate',
      organizationId: 'ignored-org',
      newName: 'Blocks copy',
    } as never);

    expect(service.toggleActive).toHaveBeenCalledWith(
      'relation-type-1',
      false,
      'org-1',
      'user-1',
    );
    expect(service.duplicate).toHaveBeenCalledWith(
      'relation-type-1',
      'org-1',
      'user-1',
      'Blocks copy',
    );
    await expect(
      controller.patch(user as never, 'relation-type-1', {
        action: 'toggle_active',
      } as never),
    ).rejects.toThrow(BadRequestException);
    await expect(
      controller.patch(user as never, 'relation-type-1', {
        action: 'unknown',
      } as never),
    ).rejects.toThrow(BadRequestException);
  });

  it('preserves legacy PATCH partial update behavior when action is omitted', async () => {
    const { controller, service } = createController();
    const dto = { name: 'Relates to' };

    await controller.patch(user as never, 'relation-type-1', dto as never);

    expect(service.update).toHaveBeenCalledWith(
      'relation-type-1',
      'org-1',
      'user-1',
      dto,
    );
  });

  it('deletes relation types and returns the controller success message', async () => {
    const { controller, service } = createController();

    await expect(
      controller.remove(user as never, 'relation-type-1'),
    ).resolves.toEqual({ success: true, message: 'Relation type deleted' });
    expect(service.delete).toHaveBeenCalledWith(
      'relation-type-1',
      'org-1',
      'user-1',
    );
  });
});
