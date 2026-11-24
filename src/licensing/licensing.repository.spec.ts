import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { LicensingRepository } from './licensing.repository';

describe('LicensingRepository', () => {
  let repository: LicensingRepository;
  let mockFrom: jest.Mock;

  const ORG = '11111111-1111-4111-8111-111111111111';
  const LICENSE = '22222222-2222-4222-8222-222222222222';
  const PLAN = {
    id: '33333333-3333-4333-8333-333333333333',
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

  function buildChain(resolved: {
    data?: unknown;
    error?: unknown;
    count?: number | null;
  }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;

    for (const method of [
      'select',
      'eq',
      'in',
      'or',
      'order',
      'range',
      'limit',
      'insert',
      'update',
      'upsert',
      'delete',
    ]) {
      chain[method] = jest.fn().mockImplementation(self);
    }

    chain.single = jest.fn().mockResolvedValue(resolved);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
    chain.then = (onFulfilled: (value: unknown) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled);
    return chain;
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    const supabase = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;
    repository = new LicensingRepository(supabase);
  });

  it('lists active plans with sanitized search and pagination', async () => {
    const countChain = buildChain({ data: null, error: null, count: 2 });
    const dataChain = buildChain({ data: [PLAN], error: null });
    mockFrom.mockReturnValueOnce(countChain).mockReturnValueOnce(dataChain);

    const result = await repository.listPlans({
      activeOnly: true,
      search: 'enterprise,',
      page: 2,
      pageSize: 5,
    });

    expect(result).toEqual({ data: [PLAN], totalCount: 2 });
    expect(mockFrom).toHaveBeenNthCalledWith(1, 'license_plans');
    expect(mockFrom).toHaveBeenNthCalledWith(2, 'license_plans');
    expect(countChain.eq).toHaveBeenCalledWith('status', 'active');
    expect(dataChain.eq).toHaveBeenCalledWith('status', 'active');
    expect(countChain.or).toHaveBeenCalledWith(
      'name.ilike.%enterprise%,plan_key.ilike.%enterprise%',
    );
    expect(dataChain.range).toHaveBeenCalledWith(5, 9);
  });

  it('loads only a live organization license for the requested organization', async () => {
    const chain = buildChain({
      data: { id: LICENSE, organization_id: ORG, status: 'active' },
      error: null,
    });
    mockFrom.mockReturnValueOnce(chain);

    const result = await repository.getLiveOrganizationLicense(ORG);

    expect(result).toMatchObject({ id: LICENSE, organization_id: ORG });
    expect(mockFrom).toHaveBeenCalledWith('organization_licenses');
    expect(chain.eq).toHaveBeenCalledWith('organization_id', ORG);
    expect(chain.in).toHaveBeenCalledWith('status', [
      'trialing',
      'active',
      'past_due',
      'suspended',
    ]);
    expect(chain.limit).toHaveBeenCalledWith(1);
  });

  it('updates organization licenses with explicit tenant and license filters', async () => {
    const chain = buildChain({
      data: { id: LICENSE, organization_id: ORG, seats_purchased: 20 },
      error: null,
    });
    mockFrom.mockReturnValueOnce(chain);

    await repository.updateOrganizationLicense(ORG, LICENSE, {
      seats_purchased: 20,
    });

    expect(mockFrom).toHaveBeenCalledWith('organization_licenses');
    expect(chain.update).toHaveBeenCalledWith({ seats_purchased: 20 });
    expect(chain.eq).toHaveBeenCalledWith('organization_id', ORG);
    expect(chain.eq).toHaveBeenCalledWith('id', LICENSE);
  });

  it('returns NotFoundException when an update affects no tenant license row', async () => {
    mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));

    await expect(
      repository.updateOrganizationLicense(ORG, LICENSE, { status: 'active' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('lists every override for an organization regardless of license state', async () => {
    // The admin/management view deliberately has no status or window filter —
    // an override on a cancelled license must stay visible so it can be managed.
    const chain = buildChain({ data: [], error: null });
    mockFrom.mockReturnValueOnce(chain);

    await repository.listOverrides(ORG);

    expect(mockFrom).toHaveBeenCalledWith(
      'organization_license_feature_overrides',
    );
    expect(chain.eq).toHaveBeenCalledWith(
      'organization_licenses.organization_id',
      ORG,
    );
    expect(chain.in).not.toHaveBeenCalled();
  });

  it('scopes resolver override reads to both the tenant and the given licenses', async () => {
    const chain = buildChain({ data: [], error: null });
    mockFrom.mockReturnValueOnce(chain);

    await repository.listOverridesForLicenses(ORG, [LICENSE]);

    expect(mockFrom).toHaveBeenCalledWith(
      'organization_license_feature_overrides',
    );
    // organization_id scoping is mandatory: the service-role client bypasses RLS.
    expect(chain.eq).toHaveBeenCalledWith(
      'organization_licenses.organization_id',
      ORG,
    );
    expect(chain.in).toHaveBeenCalledWith('organization_license_id', [LICENSE]);
  });

  it('does not query at all when no licenses are in scope', async () => {
    await expect(repository.listOverridesForLicenses(ORG, [])).resolves.toEqual(
      [],
    );

    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('upserts usage counters using the database uniqueness key', async () => {
    const chain = buildChain({
      data: { id: 'usage-1', organization_id: ORG },
      error: null,
    });
    mockFrom.mockReturnValueOnce(chain);

    await repository.upsertUsageCounter({
      organization_id: ORG,
      feature_key: 'users',
      period_start: '2026-05-01T00:00:00Z',
      period_end: '2026-06-01T00:00:00Z',
      quantity: 2,
    });

    expect(mockFrom).toHaveBeenCalledWith(
      'organization_license_usage_counters',
    );
    expect(chain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: ORG,
        feature_key: 'users',
      }),
      { onConflict: 'organization_id,feature_key,period_start,period_end' },
    );
  });

  it('maps Supabase errors to BadRequestException', async () => {
    mockFrom.mockReturnValueOnce(
      buildChain({ data: null, error: { message: 'database unavailable' } }),
    );

    await expect(repository.organizationExists(ORG)).rejects.toThrow(
      BadRequestException,
    );
  });
});
