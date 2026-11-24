import { runControllerContractSuite } from '../test/controller-contract.helper';
import { OrganizationAuthProvidersController } from './organization-auth-providers.controller';
import { OrganizationAuthProvidersService } from './organization-auth-providers.service';

runControllerContractSuite({
  controller: OrganizationAuthProvidersController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});

describe('OrganizationAuthProvidersController manual behavior', () => {
  let controller: OrganizationAuthProvidersController;
  let service: jest.Mocked<OrganizationAuthProvidersService>;

  const user = {
    authUserId: 'auth-user-1',
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'user@example.com',
  };

  beforeEach(() => {
    service = {
      listForOrg: jest.fn().mockResolvedValue([]),
      setEnabled: jest.fn().mockResolvedValue({ id: 'provider-1' }),
    } as unknown as jest.Mocked<OrganizationAuthProvidersService>;
    controller = new OrganizationAuthProvidersController(service);
  });

  it('lists auth providers for the current user organization', async () => {
    await controller.list(user as never);

    const svc = service as unknown as Record<string, jest.Mock>;
    expect(svc['listForOrg']).toHaveBeenCalledWith('org-1');
  });

  it('patches only the requested provider for the current organization', async () => {
    await controller.setEnabled(user as never, 'keycloak', {
      is_enabled: true,
    });

    const svc = service as unknown as Record<string, jest.Mock>;
    expect(svc['setEnabled']).toHaveBeenCalledWith(
      'org-1',
      'keycloak',
      true,
      'user-1',
    );
  });
});
