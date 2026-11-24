import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { TaskStatusesController } from './task-statuses.controller';
import { CreateTaskStatusDto } from './dto/create-task-status.dto';
import { PatchTaskStatusDto } from './dto/patch-task-status.dto';
import { UpdateTaskStatusDto } from './dto/update-task-status.dto';

const user = { userId: 'user-1', organizationId: 'org-1' };

function createController() {
  const service = {
    getAll: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: 'status-1' }),
    getById: jest.fn().mockResolvedValue({ id: 'status-1' }),
    getByIdWithTransitions: jest.fn().mockResolvedValue({
      id: 'status-1',
      transitions: ['status-2'],
    }),
    update: jest.fn().mockResolvedValue({ id: 'status-1' }),
    toggleActive: jest.fn().mockResolvedValue({ id: 'status-1' }),
    setDefault: jest.fn().mockResolvedValue({ id: 'status-1' }),
    reorder: jest.fn().mockResolvedValue(undefined),
    duplicate: jest.fn().mockResolvedValue({ id: 'status-copy' }),
    delete: jest.fn().mockResolvedValue(undefined),
    getTransitions: jest.fn().mockResolvedValue(['status-2']),
    setTransitions: jest.fn().mockResolvedValue(undefined),
    addTransition: jest.fn().mockResolvedValue(undefined),
    removeTransition: jest.fn().mockResolvedValue(undefined),
  };

  return {
    controller: new TaskStatusesController(service as never),
    service,
  };
}

describe('TaskStatusesController', () => {
  it('accepts legacy organizationId in create payload validation', () => {
    const dto = plainToInstance(CreateTaskStatusDto, {
      organizationId: 'd31e8f83-2f0c-4008-9e59-fbbb53eb646d',
      name: 'Ready',
      key: 'ready',
      color: '#10B981',
      icon: null,
      sort_order: 0,
      is_default: false,
      is_completed: false,
      is_active: true,
      space_id: '53f4d965-0eff-43c1-9f4e-0cd28acbd189',
    });

    const errors = validateSync(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    expect(errors).toEqual([]);
  });

  describe.each([
    ['UpdateTaskStatusDto', UpdateTaskStatusDto],
    ['PatchTaskStatusDto', PatchTaskStatusDto],
  ] as const)('%s key validation', (_name, Dto) => {
    const validate = (body: Record<string, unknown>) =>
      validateSync(plainToInstance(Dto, body), {
        whitelist: true,
        forbidNonWhitelisted: true,
      });

    it('accepts key', () => {
      expect(validate({ name: 'Ready', key: 'ready' })).toEqual([]);
    });

    it('rejects a malformed key', () => {
      const errors = validate({ key: 'Bad Key' });
      expect(errors.map((e) => e.property)).toEqual(['key']);
    });

    it('still rejects unknown properties', () => {
      const errors = validate({ key: 'ready', foo: 'bar' });
      expect(errors.map((e) => e.property)).toEqual(['foo']);
      expect(errors[0].constraints).toHaveProperty('whitelistValidation');
    });
  });

  it('delegates list filters without coercing string flags', async () => {
    const { controller, service } = createController();

    await controller.list(user as never, 'space-1', 'true', 'false', 'open');

    expect(service.getAll).toHaveBeenCalledWith('org-1', 'space-1', {
      is_active: 'true',
      is_completed: 'false',
      search: 'open',
    });
  });

  it('creates statuses with organization scope', async () => {
    const { controller, service } = createController();
    const dto = { name: 'Open' };

    await controller.create(user as never, dto as never);

    expect(service.create).toHaveBeenCalledWith('org-1', dto, 'user-1');
  });

  it('uses the transition-aware getter only when requested', async () => {
    const { controller, service } = createController();

    await expect(
      controller.getById(user as never, 'status-1', 'true'),
    ).resolves.toEqual({
      data: { id: 'status-1', transitions: ['status-2'] },
    });
    await expect(
      controller.getById(user as never, 'status-1'),
    ).resolves.toEqual({ data: { id: 'status-1' } });

    expect(service.getByIdWithTransitions).toHaveBeenCalledWith(
      'status-1',
      'org-1',
    );
    expect(service.getById).toHaveBeenCalledWith('status-1', 'org-1');
  });

  it('updates statuses by id with organization scope', async () => {
    const { controller, service } = createController();
    const dto = { name: 'In progress' };

    await controller.update(user as never, 'status-1', dto as never);

    expect(service.update).toHaveBeenCalledWith(
      'status-1',
      'org-1',
      dto,
      'user-1',
    );
  });

  it('preserves legacy PATCH partial update behavior when action is omitted', async () => {
    const { controller, service } = createController();
    const dto = { name: 'In QA' };

    await expect(
      controller.patch(user as never, 'status-1', dto as never),
    ).resolves.toEqual({ data: { id: 'status-1' }, success: true });

    expect(service.update).toHaveBeenCalledWith(
      'status-1',
      'org-1',
      dto,
      'user-1',
    );
  });

  it('dispatches supported patch actions and validates required fields', async () => {
    const { controller, service } = createController();
    const items = [{ id: 'status-1', sort_order: 0 }];

    await controller.patch(user as never, 'status-1', {
      action: 'toggle_active',
      is_active: true,
    } as never);
    await controller.patch(user as never, 'status-1', {
      action: 'set_default',
    } as never);
    await expect(
      controller.patch(user as never, 'status-1', {
        action: 'reorder',
        items,
      } as never),
    ).resolves.toEqual({ success: true, message: 'Statuses reordered' });
    await controller.patch(user as never, 'status-1', {
      action: 'duplicate',
      new_name: 'Copy',
    } as never);

    expect(service.toggleActive).toHaveBeenCalledWith(
      'status-1',
      true,
      'org-1',
      'user-1',
    );
    expect(service.setDefault).toHaveBeenCalledWith(
      'status-1',
      'org-1',
      'user-1',
    );
    expect(service.reorder).toHaveBeenCalledWith(items, 'org-1', 'user-1');
    expect(service.duplicate).toHaveBeenCalledWith(
      'status-1',
      'org-1',
      'Copy',
      'user-1',
    );

    await expect(
      controller.patch(user as never, 'status-1', {
        action: 'toggle_active',
      } as never),
    ).rejects.toThrow(BadRequestException);
    await expect(
      controller.patch(user as never, 'status-1', {
        action: 'duplicate',
      } as never),
    ).rejects.toThrow(BadRequestException);
  });

  it('wraps transition reads and validates transition mutation bodies', async () => {
    const { controller, service } = createController();

    await expect(
      controller.getTransitions(user as never, 'status-1'),
    ).resolves.toEqual({
      data: {
        status_id: 'status-1',
        allowed_transitions: ['status-2'],
      },
    });
    await expect(
      controller.setTransitions(user as never, 'status-1', {
        transition_to_ids: ['status-2'],
      }),
    ).resolves.toEqual({ success: true, message: 'Transitions updated' });
    await expect(
      controller.addTransition(user as never, 'status-1', {
        to_status_id: 'status-2',
      }),
    ).resolves.toEqual({ success: true, message: 'Transition added' });
    await expect(
      controller.removeTransition(user as never, 'status-1', {
        to_status_id: 'status-2',
      }),
    ).resolves.toEqual({ success: true, message: 'Transition removed' });

    expect(service.setTransitions).toHaveBeenCalledWith(
      'status-1',
      ['status-2'],
      'org-1',
      'user-1',
    );
    expect(service.addTransition).toHaveBeenCalledWith(
      'status-1',
      'status-2',
      'org-1',
      'user-1',
    );
    expect(service.removeTransition).toHaveBeenCalledWith(
      'status-1',
      'status-2',
      'org-1',
      'user-1',
    );

    await expect(
      controller.setTransitions(user as never, 'status-1', {
        transition_to_ids: 'status-2',
      } as never),
    ).rejects.toThrow(BadRequestException);
    await expect(
      controller.addTransition(user as never, 'status-1', {} as never),
    ).rejects.toThrow(BadRequestException);
    await expect(
      controller.removeTransition(user as never, 'status-1', {} as never),
    ).rejects.toThrow(BadRequestException);
  });

  it('deletes statuses and returns the controller success message', async () => {
    const { controller, service } = createController();

    await expect(controller.remove(user as never, 'status-1')).resolves.toEqual(
      { success: true, message: 'Status deleted' },
    );
    expect(service.delete).toHaveBeenCalledWith('status-1', 'org-1', 'user-1');
  });
});
