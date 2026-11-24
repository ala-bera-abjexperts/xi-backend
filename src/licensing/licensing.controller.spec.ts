import { LicensingController } from './licensing.controller';

const user = {
  userId: 'user-1',
  authUserId: 'auth-1',
  email: 'owner@example.com',
  organizationId: 'org-1',
  role: 'owner',
  isActive: true,
};

function createController() {
  const service = {
    listPlans: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    getCurrentLicense: jest
      .fn()
      .mockResolvedValue({ id: 'lic-1', plan_id: 'plan-1' }),
    listUsage: jest
      .fn()
      .mockResolvedValue([{ feature_key: 'api_calls', quantity: 100 }]),
    listTenantChangeRequests: jest
      .fn()
      .mockResolvedValue({ items: [], total: 0 }),
    createTenantChangeRequest: jest
      .fn()
      .mockResolvedValue({ id: 'req-1', status: 'pending' }),
    cancelTenantChangeRequest: jest
      .fn()
      .mockResolvedValue({ id: 'req-1', status: 'cancelled' }),
  };

  return {
    controller: new LicensingController(service as never),
    service,
  };
}

describe('LicensingController (tenant owner routes)', () => {
  it('lists active plans only (forActiveOnly=true)', async () => {
    const { controller, service } = createController();
    const query = { page: 1, pageSize: 20 };

    await controller.listPlans(query as never);

    expect(service.listPlans).toHaveBeenCalledWith(query, true);
  });

  it('reads current license scoped to the caller organization', async () => {
    const { controller, service } = createController();

    const result = await controller.getCurrent(user as never);

    expect(service.getCurrentLicense).toHaveBeenCalledWith('org-1');
    expect(result).toEqual({ id: 'lic-1', plan_id: 'plan-1' });
  });

  it('lists usage counters for the caller organization', async () => {
    const { controller, service } = createController();
    const query = { feature_key: 'api_calls' };

    await controller.listUsage(user as never, query as never);

    expect(service.listUsage).toHaveBeenCalledWith('org-1', query);
  });

  it('lists own change requests scoped to the caller organization', async () => {
    const { controller, service } = createController();
    const query = { page: 1, pageSize: 20 };

    await controller.listChangeRequests(user as never, query as never);

    expect(service.listTenantChangeRequests).toHaveBeenCalledWith(
      'org-1',
      query,
    );
  });

  it('creates a change request with the caller organization and user', async () => {
    const { controller, service } = createController();
    const dto = {
      request_type: 'plan_change',
      requested_plan_id: 'plan-2',
      requested_seats: 100,
      request_note: 'Upgrade for Q3',
    };

    const result = await controller.createChangeRequest(
      user as never,
      dto as never,
    );

    expect(service.createTenantChangeRequest).toHaveBeenCalledWith(
      'org-1',
      dto,
      user,
    );
    expect(result).toEqual({ id: 'req-1', status: 'pending' });
  });

  it('cancels a change request scoped to the caller organization', async () => {
    const { controller, service } = createController();

    await controller.cancelChangeRequest(user as never, 'req-1');

    expect(service.cancelTenantChangeRequest).toHaveBeenCalledWith(
      'org-1',
      'req-1',
      user,
    );
  });

  it('NEVER trusts request body for organizationId — always reads user.organizationId', async () => {
    // Sanity invariant for the post-migration architecture: the controller
    // must derive org from the guard-resolved user, never accept it from the
    // body (which would let a malicious owner cross-tenant).
    const { controller, service } = createController();
    const maliciousDto = {
      request_type: 'plan_change',
      requested_plan_id: 'plan-2',
      // attacker-injected:
      organization_id: 'different-org',
      organizationId: 'another-org',
    };

    await controller.createChangeRequest(user as never, maliciousDto as never);

    // The first arg must be the user's org, NOT anything from the body.
    expect(
      (service.createTenantChangeRequest.mock.calls as unknown[][])[0]?.[0],
    ).toBe('org-1');
  });
});
