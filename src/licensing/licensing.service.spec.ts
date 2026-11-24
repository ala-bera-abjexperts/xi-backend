import { BadRequestException, ConflictException } from '@nestjs/common';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { EntitlementsService } from './entitlements.service';
import {
  LicenseChangeRequestRow,
  LicensePlanRow,
  LicensingRepository,
  OrganizationLicenseRow,
} from './licensing.repository';
import { LicensingService } from './licensing.service';

const repoMock = (
  repo: jest.Mocked<LicensingRepository>,
  method: keyof LicensingRepository,
): jest.Mock => repo[method] as jest.Mock;

describe('LicensingService', () => {
  let service: LicensingService;
  let repository: jest.Mocked<LicensingRepository>;
  let entitlements: jest.Mocked<Pick<EntitlementsService, 'bust'>>;

  const ORG = '11111111-1111-4111-8111-111111111111';
  const USER = '22222222-2222-4222-8222-222222222222';
  const PLAN_ID = '33333333-3333-4333-8333-333333333333';
  const LICENSE_ID = '44444444-4444-4444-8444-444444444444';

  const actor: RequestUser = {
    authUserId: 'auth-user-1',
    userId: USER,
    email: 'admin@example.com',
    organizationId: ORG,
    memberships: [
      { organizationId: ORG, organizationSlug: 'acme', role: 'owner' },
    ],
    role: 'SUPER_ADMIN',
    isActive: true,
    appMetadata: { role: 'SUPER_ADMIN' },
  };

  const plan: LicensePlanRow = {
    id: PLAN_ID,
    plan_key: 'enterprise',
    name: 'Enterprise',
    description: null,
    status: 'active',
    billing_period: 'monthly',
    currency: 'EUR',
    price_cents: 10000,
    trial_days: 0,
    included_seats: 10,
    max_seats: 100,
    limits: {},
    metadata: {},
    created_by: null,
    updated_by: null,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
  };

  const license: OrganizationLicenseRow = {
    id: LICENSE_ID,
    organization_id: ORG,
    plan_id: PLAN_ID,
    status: 'active',
    seats_purchased: 10,
    seats_used: 3,
    starts_at: '2026-05-01T00:00:00Z',
    trial_ends_at: null,
    current_period_start: null,
    current_period_end: null,
    cancelled_at: null,
    suspension_reason: null,
    external_provider: null,
    external_customer_id: null,
    external_subscription_id: null,
    metadata: {},
    created_by: USER,
    updated_by: USER,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
  };

  const pendingRequest: LicenseChangeRequestRow = {
    id: '55555555-5555-4555-8555-555555555555',
    organization_id: ORG,
    current_license_id: LICENSE_ID,
    requested_plan_id: PLAN_ID,
    requested_seats: 20,
    request_type: 'seat_change',
    status: 'pending',
    request_note: null,
    review_note: null,
    requested_by: USER,
    reviewed_by: null,
    reviewed_at: null,
    metadata: {},
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
  };

  beforeEach(() => {
    repository = {
      organizationExists: jest.fn().mockResolvedValue(true),
      listPlans: jest.fn(),
      getPlanById: jest.fn().mockResolvedValue(plan),
      findPlanByKey: jest.fn().mockResolvedValue(null),
      createPlan: jest.fn().mockResolvedValue(plan),
      updatePlan: jest.fn().mockResolvedValue(plan),
      listPlanFeatures: jest.fn().mockResolvedValue([]),
      getPlanFeature: jest.fn(),
      getPlanFeatureByKey: jest.fn(),
      createPlanFeature: jest.fn(),
      updatePlanFeature: jest.fn(),
      deletePlanFeature: jest.fn(),
      getLiveOrganizationLicense: jest.fn().mockResolvedValue(null),
      getOrganizationLicenseById: jest.fn().mockResolvedValue(license),
      createOrganizationLicense: jest.fn().mockResolvedValue(license),
      updateOrganizationLicense: jest.fn().mockResolvedValue(license),
      listOverrides: jest.fn().mockResolvedValue([]),
      upsertOverride: jest.fn(),
      listUsageCounters: jest.fn().mockResolvedValue([]),
      upsertUsageCounter: jest.fn(),
      listChangeRequests: jest.fn(),
      getChangeRequest: jest.fn(),
      createChangeRequest: jest.fn(),
      updateChangeRequest: jest.fn(),
      createAuditEvent: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      listAuditEvents: jest.fn(),
      findOrgIdsForPlan: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<LicensingRepository>;
    entitlements = { bust: jest.fn() };
    service = new LicensingService(
      repository,
      entitlements as unknown as EntitlementsService,
    );
  });

  it('normalizes plan keys, creates a plan, and writes an audit event', async () => {
    repository.createPlan.mockResolvedValue({
      ...plan,
      plan_key: 'enterprise',
    });

    const result = await service.createPlan(
      {
        plan_key: 'Enterprise',
        name: 'Enterprise',
        included_seats: 5,
        max_seats: 10,
      },
      actor,
    );

    expect(result.plan_key).toBe('enterprise');
    expect(repoMock(repository, 'findPlanByKey')).toHaveBeenCalledWith(
      'enterprise',
    );
    expect(repoMock(repository, 'createPlan')).toHaveBeenCalledWith(
      expect.objectContaining({
        plan_key: 'enterprise',
        created_by: USER,
        updated_by: USER,
      }),
    );
    expect(repoMock(repository, 'createAuditEvent')).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'license_plan_created',
        actor_user_id: USER,
      }),
    );
  });

  it('rejects duplicate plan keys before writing', async () => {
    repository.findPlanByKey.mockResolvedValue(plan);

    await expect(
      service.createPlan({ plan_key: 'enterprise', name: 'Enterprise' }, actor),
    ).rejects.toThrow(ConflictException);
    expect(repoMock(repository, 'createPlan')).not.toHaveBeenCalled();
    expect(repoMock(repository, 'createAuditEvent')).not.toHaveBeenCalled();
  });

  it('rejects invalid plan seat bounds before writing', async () => {
    await expect(
      service.createPlan(
        {
          plan_key: 'starter',
          name: 'Starter',
          included_seats: 20,
          max_seats: 10,
        },
        actor,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(repoMock(repository, 'createPlan')).not.toHaveBeenCalled();
  });

  it('rejects assigning archived plans to organizations', async () => {
    repository.getPlanById.mockResolvedValue({ ...plan, status: 'archived' });

    await expect(
      service.upsertOrganizationLicense(
        ORG,
        { plan_id: PLAN_ID, seats_purchased: 10, seats_used: 0 },
        actor,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(
      repoMock(repository, 'createOrganizationLicense'),
    ).not.toHaveBeenCalled();
  });

  it('creates a new organization license and expands related licensing data', async () => {
    repository.getLiveOrganizationLicense.mockResolvedValue(null);
    repository.createOrganizationLicense.mockResolvedValue(license);

    const result = await service.upsertOrganizationLicense(
      ORG,
      { plan_id: PLAN_ID, seats_used: 2 },
      actor,
    );

    expect(
      repoMock(repository, 'createOrganizationLicense'),
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: ORG,
        plan_id: PLAN_ID,
        status: 'active',
        seats_purchased: 10,
        seats_used: 2,
        created_by: USER,
        updated_by: USER,
      }),
    );
    expect(result).toMatchObject({ license, plan });
    expect(repoMock(repository, 'listPlanFeatures')).toHaveBeenCalledWith(
      PLAN_ID,
    );
    expect(repoMock(repository, 'listOverrides')).toHaveBeenCalledWith(ORG);
    expect(repoMock(repository, 'listUsageCounters')).toHaveBeenCalledWith(
      ORG,
      {
        organization_license_id: LICENSE_ID,
      },
    );
    expect(entitlements.bust).toHaveBeenCalledWith(ORG);
  });

  it('rejects license updates where used seats exceed purchased seats', async () => {
    repository.getLiveOrganizationLicense.mockResolvedValue(license);

    await expect(
      service.updateOrganizationLicense(
        ORG,
        { seats_purchased: 2, seats_used: 3 },
        actor,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(
      repoMock(repository, 'updateOrganizationLicense'),
    ).not.toHaveBeenCalled();
  });

  it('lets a licence on an archived plan be edited when plan_id is unchanged', async () => {
    repository.getLiveOrganizationLicense.mockResolvedValue(license);
    repository.getPlanById.mockResolvedValue({ ...plan, status: 'archived' });

    await service.updateOrganizationLicense(
      ORG,
      { plan_id: PLAN_ID, status: 'suspended' },
      actor,
    );

    expect(
      repoMock(repository, 'updateOrganizationLicense'),
    ).toHaveBeenCalled();
  });

  it('still refuses to MOVE a licence onto an archived plan', async () => {
    const otherPlan = '99999999-9999-4999-8999-999999999999';
    repository.getLiveOrganizationLicense.mockResolvedValue(license);
    repository.getPlanById.mockResolvedValue({
      ...plan,
      id: otherPlan,
      status: 'archived',
    });

    await expect(
      service.updateOrganizationLicense(ORG, { plan_id: otherPlan }, actor),
    ).rejects.toThrow(BadRequestException);
    expect(
      repoMock(repository, 'updateOrganizationLicense'),
    ).not.toHaveBeenCalled();
  });

  it('creates tenant change requests using only the caller organization', async () => {
    repository.getLiveOrganizationLicense.mockResolvedValue(license);
    repository.createChangeRequest.mockResolvedValue(pendingRequest);

    const result = await service.createTenantChangeRequest(
      ORG,
      {
        request_type: 'seat_change',
        requested_seats: 20,
      },
      actor,
    );

    expect(result).toBe(pendingRequest);
    expect(repoMock(repository, 'createChangeRequest')).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: ORG,
        current_license_id: LICENSE_ID,
        requested_seats: 20,
        requested_by: USER,
        status: 'pending',
      }),
    );
    expect(entitlements.bust).toHaveBeenCalledWith(ORG);
  });

  it('requires requested_plan_id for plan change requests', async () => {
    await expect(
      service.createTenantChangeRequest(
        ORG,
        {
          request_type: 'plan_change',
        },
        actor,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(repoMock(repository, 'createChangeRequest')).not.toHaveBeenCalled();
  });

  it('cancels only pending tenant change requests', async () => {
    repository.getChangeRequest.mockResolvedValue({
      ...pendingRequest,
      status: 'approved',
    });

    await expect(
      service.cancelTenantChangeRequest(ORG, pendingRequest.id, actor),
    ).rejects.toThrow(BadRequestException);
    expect(repoMock(repository, 'updateChangeRequest')).not.toHaveBeenCalled();
  });

  it('approves a seat-change request by updating the scoped license and review row', async () => {
    repository.getChangeRequest.mockResolvedValue(pendingRequest);
    repository.getOrganizationLicenseById.mockResolvedValue(license);
    repository.updateOrganizationLicense.mockResolvedValue({
      ...license,
      seats_purchased: 20,
    });
    repository.updateChangeRequest
      .mockResolvedValueOnce({ ...pendingRequest, status: 'approved' })
      .mockResolvedValueOnce({
        ...pendingRequest,
        status: 'approved',
        current_license_id: LICENSE_ID,
        reviewed_by: USER,
      });

    const result = await service.reviewChangeRequest(
      pendingRequest.id,
      { status: 'approved', review_note: 'Approved' },
      actor,
    );

    expect(
      repoMock(repository, 'updateOrganizationLicense'),
    ).toHaveBeenCalledWith(
      ORG,
      LICENSE_ID,
      expect.objectContaining({
        seats_purchased: 20,
        updated_by: USER,
      }),
    );
    expect(repoMock(repository, 'updateChangeRequest')).toHaveBeenCalledWith(
      pendingRequest.id,
      expect.objectContaining({
        status: 'approved',
        reviewed_by: USER,
        review_note: 'Approved',
      }),
    );
    expect(result.status).toBe('approved');
    expect(repoMock(repository, 'createAuditEvent')).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: ORG,
        event_type: 'license_change_request_approved',
      }),
    );
    expect(entitlements.bust).toHaveBeenCalledWith(ORG);
  });
});
