/**
 * @fileoverview Smoke tests for StatusCategoriesController.
 * @module src/status-categories/status-categories.controller.spec
 * @author Rajbha Manek
 */
import { ConflictException } from '@nestjs/common';
import { StatusCategoriesController } from './status-categories.controller';

const mockUser = { userId: 'user-1', organizationId: 'org-1' };
const mockCategory = {
  id: 'cat-1',
  organization_id: 'org-1',
  space_id: null,
  name: 'To Do',
  key: 'todo',
  color: '#6B7280',
  text_color: '#FFFFFF',
  sort_order: 1,
  is_system: false,
  is_done_like: false,
  created_at: '',
  updated_at: '',
};

function createController() {
  const service = {
    getAll: jest.fn().mockResolvedValue([mockCategory]),
    getById: jest.fn().mockResolvedValue(mockCategory),
    create: jest.fn().mockResolvedValue(mockCategory),
    update: jest.fn().mockResolvedValue(mockCategory),
    delete: jest.fn().mockResolvedValue(undefined),
    reorder: jest.fn().mockResolvedValue(undefined),
  };

  return {
    controller: new StatusCategoriesController(service as never),
    service,
  };
}

describe('StatusCategoriesController', () => {
  it('list() returns data array and count', async () => {
    const { controller } = createController();
    const result = await controller.list(mockUser as never);

    expect(result.data).toHaveLength(1);
    expect(result.count).toBe(1);
  });

  it('create() calls service.create and returns data', async () => {
    const { controller, service } = createController();
    const dto = { name: 'To Do', key: 'todo', color: '#6B7280' };
    const result = await controller.create(mockUser as never, dto as never);

    expect(result.data).toEqual(mockCategory);
    expect(result.success).toBe(true);
    expect(service.create).toHaveBeenCalledWith('org-1', dto, 'user-1');
  });

  it('remove() throws ConflictException when service rejects with system category error', async () => {
    const { controller, service } = createController();
    service.delete.mockRejectedValue(
      new ConflictException('Cannot delete a system status category'),
    );

    await expect(controller.remove(mockUser as never, 'cat-1')).rejects.toThrow(
      ConflictException,
    );
  });

  it('reorder() delegates to service.reorder', async () => {
    const { controller, service } = createController();
    const dto = { items: [{ id: 'cat-1', sort_order: 0 }] };
    const result = await controller.reorder(mockUser as never, dto as never);

    expect(result.success).toBe(true);
    expect(service.reorder).toHaveBeenCalledWith(dto.items, 'org-1', 'user-1');
  });
});
