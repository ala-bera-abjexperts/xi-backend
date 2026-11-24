import { BadRequestException } from '@nestjs/common';
import { runControllerContractSuite } from '../test/controller-contract.helper';
import {
  CustomRolesController,
  UserRoleAssignmentsController,
} from './custom-roles.controller';

runControllerContractSuite({
  controller: CustomRolesController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
runControllerContractSuite({
  controller: UserRoleAssignmentsController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});

describe('CustomRolesController manual behavior', () => {
  const user = {
    userId: 'user-1',
    organizationId: 'org-1',
  };

  function setup() {
    const service = {
      getAll: jest.fn(),
      create: jest.fn(),
      getById: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
      toggleActive: jest.fn(),
      restore: jest.fn(),
      permanentDelete: jest.fn(),
      duplicate: jest.fn(),
      checkUsage: jest.fn(),
      getAssignments: jest.fn(),
      assignRole: jest.fn(),
      unassignRole: jest.fn(),
      getAssignmentById: jest.fn(),
      deleteAssignmentById: jest.fn(),
    };
    return {
      rolesController: new CustomRolesController(service as any),
      assignmentsController: new UserRoleAssignmentsController(service as any),
      service,
    };
  }

  it('parses role list boolean filters', async () => {
    const { rolesController, service } = setup();

    await rolesController.list(user as any, 'member', 'true', 'false', 'risk');

    expect(service.getAll).toHaveBeenCalledWith('org-1', {
      base_role: 'member',
      is_active: true,
      is_deleted: false,
      search: 'risk',
    });
  });

  it('requires is_active for toggle_active role patches', async () => {
    const { rolesController, service } = setup();

    await expect(
      rolesController.patch(user as any, 'role-1', {
        action: 'toggle_active',
      } as any),
    ).rejects.toThrow(BadRequestException);
    expect(service.toggleActive).not.toHaveBeenCalled();
  });

  it('requires newName for duplicate role patches', async () => {
    const { rolesController, service } = setup();

    await expect(
      rolesController.patch(user as any, 'role-1', {
        action: 'duplicate',
      } as any),
    ).rejects.toThrow(BadRequestException);
    expect(service.duplicate).not.toHaveBeenCalled();
  });

  it('routes supported role patch actions to the matching service method', async () => {
    const { rolesController, service } = setup();
    service.checkUsage.mockResolvedValue({ inUse: false });

    await expect(
      rolesController.patch(user as any, 'role-1', {
        action: 'check_usage',
      } as any),
    ).resolves.toEqual({ inUse: false });
    expect(service.checkUsage).toHaveBeenCalledWith('role-1', 'org-1');
  });

  it('rejects unknown role patch actions', async () => {
    const { rolesController } = setup();

    await expect(
      rolesController.patch(user as any, 'role-1', {
        action: 'mystery',
      } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('forwards role assignment create and delete bodies', async () => {
    const { assignmentsController, service } = setup();

    await assignmentsController.assign(
      user as any,
      {
        user_id: 'target-user',
        role_id: 'role-1',
      } as any,
    );
    await assignmentsController.unassign(
      user as any,
      {
        user_id: 'target-user',
      } as any,
    );

    expect(service.assignRole).toHaveBeenCalledWith(
      'org-1',
      'target-user',
      'role-1',
      'user-1',
    );
    expect(service.unassignRole).toHaveBeenCalledWith(
      'org-1',
      'target-user',
      undefined,
      'user-1',
    );
  });
});
