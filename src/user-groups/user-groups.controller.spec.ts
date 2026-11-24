import { BadRequestException } from '@nestjs/common';
import { runControllerContractSuite } from '../test/controller-contract.helper';
import { UserGroupsController } from './user-groups.controller';

runControllerContractSuite({
  controller: UserGroupsController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});

describe('UserGroupsController manual behavior', () => {
  const user = {
    userId: 'user-1',
    organizationId: 'org-1',
  };

  function setup() {
    const service = {
      getAll: jest.fn(),
      create: jest.fn(),
      getByIdWithMembers: jest.fn(),
      getById: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      restore: jest.fn(),
      permanentDelete: jest.fn(),
      duplicate: jest.fn(),
      getMembers: jest.fn(),
      addMembers: jest.fn(),
      addMember: jest.fn(),
      removeMembers: jest.fn(),
      removeMember: jest.fn(),
      updateMemberRole: jest.fn(),
    };
    const controller = new UserGroupsController(service as any);
    return { controller, service };
  }

  it('parses list deleted filters and forwards search', async () => {
    const { controller, service } = setup();

    await controller.list(user as any, 'false', 'risk');

    expect(service.getAll).toHaveBeenCalledWith('org-1', {
      is_deleted: false,
      search: 'risk',
    });
  });

  it('switches getById to the with-members service when requested', async () => {
    const { controller, service } = setup();
    service.getByIdWithMembers.mockResolvedValue({
      id: 'group-1',
      members: [],
    });

    await expect(
      controller.getById(user as any, 'group-1', 'true'),
    ).resolves.toEqual({
      data: { id: 'group-1', members: [] },
      success: true,
    });
    expect(service.getByIdWithMembers).toHaveBeenCalledWith('group-1', 'org-1');
    expect(service.getById).not.toHaveBeenCalled();
  });

  it('requires newName for duplicate group patches', async () => {
    const { controller, service } = setup();

    await expect(
      controller.patch(user as any, 'group-1', { action: 'duplicate' } as any),
    ).rejects.toThrow(BadRequestException);
    expect(service.duplicate).not.toHaveBeenCalled();
  });

  it('rejects unknown group patch actions', async () => {
    const { controller } = setup();

    await expect(
      controller.patch(user as any, 'group-1', { action: 'mystery' } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('chooses bulk member add when user_ids are present', async () => {
    const { controller, service } = setup();

    await controller.addMembers(user as any, 'group-1', {
      user_ids: ['user-2', 'user-3'],
      role_id: 'role-1',
    } as any);

    expect(service.addMembers).toHaveBeenCalledWith(
      'group-1',
      'org-1',
      ['user-2', 'user-3'],
      'role-1',
      'user-1',
    );
    expect(service.addMember).not.toHaveBeenCalled();
  });

  it('requires either user_id or user_ids for member removal', async () => {
    const { controller, service } = setup();

    await expect(
      controller.removeMembers(user as any, 'group-1', {} as any),
    ).rejects.toThrow(BadRequestException);
    expect(service.removeMember).not.toHaveBeenCalled();
    expect(service.removeMembers).not.toHaveBeenCalled();
  });
});
