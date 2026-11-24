import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { TaskPrioritiesController } from './task-priorities.controller';
import { CreateTaskPriorityDto } from './dto/create-task-priority.dto';

const user = { userId: 'user-1', organizationId: 'org-1' };

function createController() {
  const service = {
    getAll: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: 'priority-1' }),
    getById: jest.fn().mockResolvedValue({ id: 'priority-1' }),
    update: jest.fn().mockResolvedValue({ id: 'priority-1' }),
    toggleActive: jest.fn().mockResolvedValue({ id: 'priority-1' }),
    setDefault: jest.fn().mockResolvedValue({ id: 'priority-1' }),
    reorder: jest.fn().mockResolvedValue(undefined),
    duplicate: jest.fn().mockResolvedValue({ id: 'priority-copy' }),
    delete: jest.fn().mockResolvedValue(undefined),
  };

  return {
    controller: new TaskPrioritiesController(service as never),
    service,
  };
}

describe('TaskPrioritiesController', () => {
  it('accepts legacy organizationId in create payload validation', () => {
    const dto = plainToInstance(CreateTaskPriorityDto, {
      organizationId: 'd31e8f83-2f0c-4008-9e59-fbbb53eb646d',
      name: 'Urgent',
      key: 'urgent',
      color: '#EF4444',
      icon: null,
      sort_order: 0,
      is_default: false,
      is_active: true,
      space_id: '53f4d965-0eff-43c1-9f4e-0cd28acbd189',
    });

    const errors = validateSync(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    expect(errors).toEqual([]);
  });

  it('delegates list filters without coercing string flags', async () => {
    const { controller, service } = createController();

    await controller.list(user as never, 'space-1', 'true', 'urgent');

    expect(service.getAll).toHaveBeenCalledWith('org-1', 'space-1', {
      is_active: 'true',
      search: 'urgent',
    });
  });

  it('creates priorities with organization scope', async () => {
    const { controller, service } = createController();
    const dto = { name: 'Critical' };

    await controller.create(user as never, dto as never);

    expect(service.create).toHaveBeenCalledWith('org-1', dto, 'user-1');
  });

  it('gets priorities by id with organization scope', async () => {
    const { controller, service } = createController();

    await controller.getById(user as never, 'priority-1');

    expect(service.getById).toHaveBeenCalledWith('priority-1', 'org-1');
  });

  it('updates priorities by id with organization scope', async () => {
    const { controller, service } = createController();
    const dto = { name: 'High' };

    await controller.update(user as never, 'priority-1', dto as never);

    expect(service.update).toHaveBeenCalledWith(
      'priority-1',
      'org-1',
      dto,
      'user-1',
    );
  });

  it('preserves legacy PATCH partial update behavior when action is omitted', async () => {
    const { controller, service } = createController();
    const dto = { name: 'Very high' };

    await expect(
      controller.patch(user as never, 'priority-1', dto as never),
    ).resolves.toEqual({ data: { id: 'priority-1' }, success: true });

    expect(service.update).toHaveBeenCalledWith(
      'priority-1',
      'org-1',
      dto,
      'user-1',
    );
  });

  it('dispatches each supported patch action', async () => {
    const { controller, service } = createController();
    const items = [{ id: 'priority-1', sort_order: 0 }];

    await controller.patch(user as never, 'priority-1', {
      action: 'toggle_active',
      is_active: false,
    } as never);
    await controller.patch(user as never, 'priority-1', {
      action: 'set_default',
    } as never);
    await expect(
      controller.patch(user as never, 'priority-1', {
        action: 'reorder',
        items,
      } as never),
    ).resolves.toEqual({ success: true, message: 'Priorities reordered' });
    await controller.patch(user as never, 'priority-1', {
      action: 'duplicate',
      new_name: 'Copy',
    } as never);

    expect(service.toggleActive).toHaveBeenCalledWith(
      'priority-1',
      false,
      'org-1',
      'user-1',
    );
    expect(service.setDefault).toHaveBeenCalledWith(
      'priority-1',
      'org-1',
      'user-1',
    );
    expect(service.reorder).toHaveBeenCalledWith(items, 'org-1', 'user-1');
    expect(service.duplicate).toHaveBeenCalledWith(
      'priority-1',
      'org-1',
      'Copy',
      'user-1',
    );
  });

  it('rejects patch actions missing required body values', async () => {
    const { controller } = createController();

    await expect(
      controller.patch(user as never, 'priority-1', {
        action: 'toggle_active',
      } as never),
    ).rejects.toThrow(BadRequestException);
    await expect(
      controller.patch(user as never, 'priority-1', {
        action: 'reorder',
        items: [],
      } as never),
    ).rejects.toThrow(BadRequestException);
    await expect(
      controller.patch(user as never, 'priority-1', {
        action: 'duplicate',
      } as never),
    ).rejects.toThrow(BadRequestException);
  });

  it('deletes priorities and returns the controller success message', async () => {
    const { controller, service } = createController();

    await expect(
      controller.remove(user as never, 'priority-1'),
    ).resolves.toEqual({ success: true, message: 'Priority deleted' });
    expect(service.delete).toHaveBeenCalledWith(
      'priority-1',
      'org-1',
      'user-1',
    );
  });
});
