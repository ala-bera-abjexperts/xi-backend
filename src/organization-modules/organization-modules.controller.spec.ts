import { runControllerContractSuite } from '../test/controller-contract.helper';
import { OrganizationModulesController } from './organization-modules.controller';
import { OrganizationModulesService } from './organization-modules.service';

runControllerContractSuite({
  controller: OrganizationModulesController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});

describe('OrganizationModulesController manual behavior', () => {
  let controller: OrganizationModulesController;
  let service: jest.Mocked<OrganizationModulesService>;

  const user = {
    authUserId: 'auth-user-1',
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'user@example.com',
  };

  beforeEach(() => {
    service = {
      listForOrg: jest.fn().mockResolvedValue([]),
      setEnabled: jest.fn().mockResolvedValue({ id: 'module-1' }),
    } as unknown as jest.Mocked<OrganizationModulesService>;
    controller = new OrganizationModulesController(service);
  });

  it('lists modules for the current user organization', async () => {
    await controller.list(user);

    const svc = service as unknown as Record<string, jest.Mock>;
    expect(svc['listForOrg']).toHaveBeenCalledWith('org-1');
  });

  it('patches only the requested module type for the current organization', async () => {
    await controller.setEnabled(user, 'portfolio', { is_enabled: true });

    const svc = service as unknown as Record<string, jest.Mock>;
    expect(svc['setEnabled']).toHaveBeenCalledWith(
      'org-1',
      'portfolio',
      true,
      'user-1',
    );
  });
});
