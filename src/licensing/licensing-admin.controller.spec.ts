import { LicensingAdminController } from './licensing-admin.controller';

const superAdminUser = {
  userId: 'super-1',
  authUserId: 'auth-super-1',
  email: 'darkwiki786@gmail.com',
  organizationId: '00000000-0000-0000-0000-000000000000',
  role: 'SUPER_ADMIN',
  isActive: true,
  appMetadata: { role: 'SUPER_ADMIN', is_super_admin: true },
};

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const PLAN_ID = '22222222-2222-2222-2222-222222222222';
const FEATURE_ID = '33333333-3333-3333-3333-333333333333';
const REQUEST_ID = '44444444-4444-4444-4444-444444444444';

function createController() {
  const service = {
    listPlans: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    createPlan: jest.fn().mockResolvedValue({
      id: PLAN_ID,
      plan_key: 'enterprise',
      status: 'draft',
    }),
    getPlan: jest
      .fn()
      .mockResolvedValue({ id: PLAN_ID, plan_key: 'enterprise' }),
    updatePlan: jest.fn().mockResolvedValue({ id: PLAN_ID, status: 'active' }),
    archivePlan: jest
      .fn()
      .mockResolvedValue({ id: PLAN_ID, status: 'archived' }),
    listPlanFeatures: jest.fn().mockResolvedValue([{ id: FEATURE_ID }]),
    createPlanFeature: jest.fn().mockResolvedValue({ id: FEATURE_ID }),
    updatePlanFeature: jest
      .fn()
      .mockResolvedValue({ id: FEATURE_ID, feature_name: 'updated' }),
    deletePlanFeature: jest.fn().mockResolvedValue({ success: true }),
    getCurrentLicense: jest.fn().mockResolvedValue({ id: 'lic-1' }),
    upsertOrganizationLicense: jest
      .fn()
      .mockResolvedValue({ id: 'lic-1', status: 'active' }),
    updateOrganizationLicense: jest
      .fn()
      .mockResolvedValue({ id: 'lic-1', seats_purchased: 75 }),
    listOverrides: jest.fn().mockResolvedValue([]),
    upsertOverride: jest.fn().mockResolvedValue({ id: 'ovr-1' }),
    listUsage: jest.fn().mockResolvedValue([]),
    upsertUsage: jest.fn().mockResolvedValue({ id: 'usg-1', quantity: 100 }),
    listChangeRequests: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    reviewChangeRequest: jest
      .fn()
      .mockResolvedValue({ id: REQUEST_ID, status: 'approved' }),
    listAuditEvents: jest.fn().mockResolvedValue({ items: [], total: 0 }),
  };

  return {
    controller: new LicensingAdminController(service as never),
    service,
  };
}

describe('LicensingAdminController — Plans', () => {
  it('lists all plans (forActiveOnly=false to include drafts + archived)', async () => {
    const { controller, service } = createController();
    const query = { page: 1, pageSize: 20 };

    await controller.listPlans(query as never);

    expect(service.listPlans).toHaveBeenCalledWith(query, false);
  });

  it('creates a plan and passes the caller user for audit logging', async () => {
    const { controller, service } = createController();
    const dto = {
      plan_key: 'enterprise',
      name: 'Enterprise',
      status: 'draft' as const,
      billing_period: 'yearly' as const,
      currency: 'EUR',
      price_cents: 199900,
      included_seats: 25,
    };

    await controller.createPlan(superAdminUser as never, dto as never);

    expect(service.createPlan).toHaveBeenCalledWith(dto, superAdminUser);
  });

  it('gets a single plan by id', async () => {
    const { controller, service } = createController();

    await controller.getPlan(PLAN_ID);

    expect(service.getPlan).toHaveBeenCalledWith(PLAN_ID);
  });

  it('updates a plan with planId, dto, and audit user', async () => {
    const { controller, service } = createController();
    const dto = { name: 'Updated', status: 'active' };

    await controller.updatePlan(superAdminUser as never, PLAN_ID, dto as never);

    expect(service.updatePlan).toHaveBeenCalledWith(
      PLAN_ID,
      dto,
      superAdminUser,
    );
  });

  it('archives a plan', async () => {
    const { controller, service } = createController();

    await controller.archivePlan(superAdminUser as never, PLAN_ID);

    expect(service.archivePlan).toHaveBeenCalledWith(PLAN_ID, superAdminUser);
  });
});

describe('LicensingAdminController — Plan Features', () => {
  it('lists features scoped to a plan', async () => {
    const { controller, service } = createController();

    await controller.listPlanFeatures(PLAN_ID);

    expect(service.listPlanFeatures).toHaveBeenCalledWith(PLAN_ID);
  });

  it('creates a feature on a plan', async () => {
    const { controller, service } = createController();
    const dto = {
      feature_key: 'advanced_reports',
      feature_name: 'Advanced Reports',
      feature_type: 'boolean' as const,
      entitlement_value: true,
    };

    await controller.createPlanFeature(
      superAdminUser as never,
      PLAN_ID,
      dto as never,
    );

    expect(service.createPlanFeature).toHaveBeenCalledWith(
      PLAN_ID,
      dto,
      superAdminUser,
    );
  });

  it('updates a feature with both ids and dto', async () => {
    const { controller, service } = createController();
    const dto = { feature_name: 'Renamed', entitlement_value: false };

    await controller.updatePlanFeature(
      superAdminUser as never,
      PLAN_ID,
      FEATURE_ID,
      dto as never,
    );

    expect(service.updatePlanFeature).toHaveBeenCalledWith(
      PLAN_ID,
      FEATURE_ID,
      dto,
      superAdminUser,
    );
  });

  it('deletes a feature', async () => {
    const { controller, service } = createController();

    await controller.deletePlanFeature(
      superAdminUser as never,
      PLAN_ID,
      FEATURE_ID,
    );

    expect(service.deletePlanFeature).toHaveBeenCalledWith(
      PLAN_ID,
      FEATURE_ID,
      superAdminUser,
    );
  });
});

describe('LicensingAdminController — Tenant License', () => {
  it('reads a tenant license by organizationId', async () => {
    const { controller, service } = createController();

    await controller.getTenantLicense(ORG_ID);

    expect(service.getCurrentLicense).toHaveBeenCalledWith(ORG_ID);
  });

  it('upserts a tenant license (PUT) with plan_id from body', async () => {
    const { controller, service } = createController();
    const dto = {
      plan_id: PLAN_ID,
      status: 'active' as const,
      seats_purchased: 50,
      starts_at: '2026-05-11T00:00:00Z',
    };

    await controller.upsertTenantLicense(
      superAdminUser as never,
      ORG_ID,
      dto as never,
    );

    expect(service.upsertOrganizationLicense).toHaveBeenCalledWith(
      ORG_ID,
      dto,
      superAdminUser,
    );
  });

  it('patches a tenant license (PATCH) — partial fields', async () => {
    const { controller, service } = createController();
    const dto = { seats_purchased: 75 };

    await controller.updateTenantLicense(
      superAdminUser as never,
      ORG_ID,
      dto as never,
    );

    expect(service.updateOrganizationLicense).toHaveBeenCalledWith(
      ORG_ID,
      dto,
      superAdminUser,
    );
  });
});

describe('LicensingAdminController — Overrides & Usage', () => {
  it('lists overrides for an organization', async () => {
    const { controller, service } = createController();

    await controller.listOverrides(ORG_ID);

    expect(service.listOverrides).toHaveBeenCalledWith(ORG_ID);
  });

  it('upserts an override with feature_key + entitlement_value', async () => {
    const { controller, service } = createController();
    const dto = {
      organization_license_id: 'lic-1',
      feature_key: 'advanced_reports',
      entitlement_value: true,
      reason: 'VIP bundle',
    };

    await controller.upsertOverride(
      superAdminUser as never,
      ORG_ID,
      dto as never,
    );

    expect(service.upsertOverride).toHaveBeenCalledWith(
      ORG_ID,
      dto,
      superAdminUser,
    );
  });

  it('lists usage counters with optional filter query', async () => {
    const { controller, service } = createController();
    const query = { feature_key: 'api_calls' };

    await controller.listUsage(ORG_ID, query as never);

    expect(service.listUsage).toHaveBeenCalledWith(ORG_ID, query);
  });

  it('upserts a usage counter for a billing period', async () => {
    const { controller, service } = createController();
    const dto = {
      organization_license_id: 'lic-1',
      feature_key: 'api_calls',
      period_start: '2026-05-01T00:00:00Z',
      period_end: '2026-05-31T23:59:59Z',
      quantity: 12450,
      hard_limit: 100000,
      unit: 'count',
    };

    await controller.upsertUsage(superAdminUser as never, ORG_ID, dto as never);

    expect(service.upsertUsage).toHaveBeenCalledWith(
      ORG_ID,
      dto,
      superAdminUser,
    );
  });
});

describe('LicensingAdminController — Change Requests & Audit', () => {
  it('lists change requests across all orgs (admin view)', async () => {
    const { controller, service } = createController();
    const query = { page: 1, pageSize: 20, status: 'pending' };

    await controller.listChangeRequests(query as never);

    expect(service.listChangeRequests).toHaveBeenCalledWith(query);
  });

  it('reviews a change request (approve)', async () => {
    const { controller, service } = createController();
    const dto = { status: 'approved' as const, review_note: 'OK' };

    await controller.reviewChangeRequest(
      superAdminUser as never,
      REQUEST_ID,
      dto as never,
    );

    expect(service.reviewChangeRequest).toHaveBeenCalledWith(
      REQUEST_ID,
      dto,
      superAdminUser,
    );
  });

  it('reviews a change request (reject)', async () => {
    const { controller, service } = createController();
    const dto = {
      status: 'rejected' as const,
      review_note: 'Insufficient justification',
    };

    await controller.reviewChangeRequest(
      superAdminUser as never,
      REQUEST_ID,
      dto as never,
    );

    expect(service.reviewChangeRequest).toHaveBeenCalledWith(
      REQUEST_ID,
      { status: 'rejected', review_note: 'Insufficient justification' },
      superAdminUser,
    );
  });

  it('lists audit events with filter query', async () => {
    const { controller, service } = createController();
    const query = {
      page: 1,
      pageSize: 50,
      organization_id: ORG_ID,
      event_type: 'organization_license_created',
    };

    await controller.listAuditEvents(query as never);

    expect(service.listAuditEvents).toHaveBeenCalledWith(query);
  });
});

describe('LicensingAdminController — security invariants', () => {
  it('admin-side endpoints accept organizationId from URL path, NOT from body', async () => {
    // The path-param value is what the service should receive, even if the
    // body tries to inject a different organization_id.
    const { controller, service } = createController();
    const dto = {
      plan_id: PLAN_ID,
      status: 'active' as const,
      // attacker-injected:
      organization_id: 'attacker-org',
      organizationId: 'another-org',
    };

    await controller.upsertTenantLicense(
      superAdminUser as never,
      ORG_ID,
      dto as never,
    );

    // First arg is the path param, NOT a body field.
    expect(
      (service.upsertOrganizationLicense.mock.calls as unknown[][])[0]?.[0],
    ).toBe(ORG_ID);
  });
});
