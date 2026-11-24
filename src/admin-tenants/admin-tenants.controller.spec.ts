import { AdminTenantsController } from './admin-tenants.controller';

const user = {
  userId: 'user-1',
  authUserId: 'auth-user-1',
  email: 'admin@example.com',
  organizationId: 'org-1',
};

function createController() {
  const service = {
    listTenants: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    createTenant: jest.fn().mockResolvedValue({ data: { id: 'tenant-1' } }),
    listTenantSpaces: jest.fn().mockResolvedValue({ data: [] }),
    listTenantUsers: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    createTenantUser: jest.fn().mockResolvedValue({ data: { id: 'user-2' } }),
    getTenantUser: jest.fn().mockResolvedValue({ data: { id: 'user-2' } }),
    updateTenantUser: jest.fn().mockResolvedValue({ data: { id: 'user-2' } }),
    updateTenantUserStatus: jest
      .fn()
      .mockResolvedValue({ data: { id: 'user-2' } }),
    updateTenantUserRole: jest
      .fn()
      .mockResolvedValue({ data: { id: 'user-2' } }),
    deleteTenantUser: jest.fn().mockResolvedValue({ success: true }),
    updateTenantStatus: jest
      .fn()
      .mockResolvedValue({ data: { id: 'tenant-1' } }),
    getTenant: jest.fn().mockResolvedValue({ data: { id: 'tenant-1' } }),
    updateTenant: jest.fn().mockResolvedValue({ data: { id: 'tenant-1' } }),
    deleteTenant: jest.fn().mockResolvedValue({ data: { id: 'tenant-1' } }),
  };

  return {
    controller: new AdminTenantsController(service as never),
    service,
  };
}

describe('AdminTenantsController', () => {
  it('preserves legacy tenant list query parameters', async () => {
    const { controller, service } = createController();

    await expect(
      controller.listTenants({
        page: '2',
        limit: '150',
        search: '  acme  ',
        is_active: 'false',
      }),
    ).resolves.toEqual({ data: [], total: 0 });

    expect(service.listTenants).toHaveBeenCalledWith({
      page: 2,
      limit: 100,
      search: 'acme',
      is_active: false,
    });
  });

  it('passes actor context to tenant mutations', async () => {
    const { controller, service } = createController();
    const body = {
      name: 'Acme',
      slug: 'acme',
      size: 'medium',
      is_active: true,
    };

    await expect(controller.createTenant(body as never, user)).resolves.toEqual(
      { data: { id: 'tenant-1' } },
    );

    expect(service.createTenant).toHaveBeenCalledWith(body, 'user-1');
  });

  it('preserves tenant user list query parameters', async () => {
    const { controller, service } = createController();

    await expect(
      controller.listTenantUsers('tenant-1', {
        page: '3',
        limit: '10',
        search: '  prince  ',
        is_active: 'true',
      }),
    ).resolves.toEqual({ data: [], total: 0 });

    expect(service.listTenantUsers).toHaveBeenCalledWith('tenant-1', {
      page: 3,
      limit: 10,
      search: 'prince',
      is_active: true,
    });
  });

  it('delegates tenant user role/status/remove mutations with actor context', async () => {
    const { controller, service } = createController();

    await controller.updateTenantUserRole(
      'tenant-1',
      'user-2',
      { role: 'admin' },
      user,
    );
    await controller.updateTenantUserStatus(
      'tenant-1',
      'user-2',
      { is_active: false },
      user,
    );
    await controller.deleteTenantUser('tenant-1', 'user-2', user);

    expect(service.updateTenantUserRole).toHaveBeenCalledWith(
      'tenant-1',
      'user-2',
      'admin',
      'user-1',
    );
    expect(service.updateTenantUserStatus).toHaveBeenCalledWith(
      'tenant-1',
      'user-2',
      false,
      'user-1',
    );
    expect(service.deleteTenantUser).toHaveBeenCalledWith(
      'tenant-1',
      'user-2',
      'user-1',
    );
  });
});
