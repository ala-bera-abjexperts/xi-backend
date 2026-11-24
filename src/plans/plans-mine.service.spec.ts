// Unit tests for PlansMineService (MCP `plan.search` backing service).
//
// PlansService.listPlans is mocked — its authorization semantics (admin/owner
// bypass → space membership + view_plans → per-plan ACL) are covered by
// plans.service.spec.ts; these tests pin the WRAPPER contract: whitelisted
// projection (no internal/PII/financial fields), anti-probing empty results
// (never a 403), owner/space/status input hardening, opaque page cursor, and
// clamped limits.

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PlansMineService } from './plans-mine.service';
import type { PlansService } from './plans.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';

const ORG_ID = 'org-id';
const USER_ID = 'public-user-id';
const SPACE_ID = '4ed4e189-d8ba-440f-b07a-907e961b3bd8';
const OWNER_UUID = '267b6a1d-6a5e-4d63-b544-d869f85ee906';

const user: RequestUser = {
  authUserId: 'auth-user-uuid',
  userId: USER_ID,
  email: 'user@example.com',
  organizationId: ORG_ID,
  memberships: [
    { organizationId: ORG_ID, organizationSlug: 'acme', role: 'member' },
  ],
  role: 'member',
  isActive: true,
  appMetadata: {},
};

// A raw row exactly as PlansService.listPlans returns it (select('*') + joins)
// including every internal field that must NOT survive projection.
const rawPlanRow = {
  id: 'plan-1',
  organization_id: ORG_ID,
  space_id: SPACE_ID,
  plan_key: 'CURLTEST-P1',
  name: 'SOC2 readiness',
  description: 'd'.repeat(500),
  plan_type: 'waterfall',
  status: 'active',
  start_date: '2026-01-01',
  end_date: '2026-12-31',
  budget: 100000,
  currency: 'EUR',
  progress: 40,
  owner_id: OWNER_UUID,
  created_by: 'creator-id',
  sort_order: 3,
  settings: { rag_override: true },
  is_archived: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-06-01T00:00:00Z',
  filter_id: 'filter-1',
  rag_status: 'amber',
  rag_set_manually: true,
  rag_set_at: '2026-05-01T00:00:00Z',
  rag_set_by: 'someone',
  custom_field_values: { secretField: 'x' },
  owner: {
    id: OWNER_UUID,
    first_name: 'Prince',
    last_name: 'Jadiya',
    avatar_url: 'https://cdn/x.png',
  },
  creator: {
    id: 'creator-id',
    first_name: 'C',
    last_name: 'R',
    email: 'creator@example.com',
  },
};

describe('PlansMineService', () => {
  let listPlans: jest.Mock;
  let getPlan: jest.Mock;
  let maybeSingleResult: { data: unknown; error: unknown };
  let inResult: { data: unknown; error: unknown };
  let limitResult: { data: unknown; error: unknown };
  let service: PlansMineService;

  // A PostgREST-builder-like mock: every chain method returns the builder,
  // `maybeSingle`/`limit` resolve their configured results, and the builder
  // itself is thenable (awaiting after `.in(...)` resolves `inResult`, as
  // fetchSpaceRefs does).
  const buildService = () => {
    const query: Record<string, unknown> = {};

    Object.assign(query, {
      select: jest.fn().mockReturnValue(query),
      eq: jest.fn().mockReturnValue(query),
      in: jest.fn().mockReturnValue(query),
      limit: jest.fn().mockImplementation(() => Promise.resolve(limitResult)),
      maybeSingle: jest
        .fn()
        .mockImplementation(() => Promise.resolve(maybeSingleResult)),
      then: (
        resolve: (v: unknown) => unknown,
        reject: (e: unknown) => unknown,
      ) => Promise.resolve(inResult).then(resolve, reject),
    });
    const supabaseAdmin = {
      getClient: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue(query),
      }),
    } as unknown as SupabaseAdminService;

    const plansService = { listPlans, getPlan } as unknown as PlansService;

    return new PlansMineService(supabaseAdmin, plansService);
  };

  const listedPage = (
    rows: Record<string, unknown>[],
    overrides: Partial<{
      total: number;
      page: number;
      pageSize: number;
      hasMore: boolean;
    }> = {},
  ) => ({
    data: rows,
    total: overrides.total ?? rows.length,
    page: overrides.page ?? 1,
    pageSize: overrides.pageSize ?? 20,
    hasMore: overrides.hasMore ?? false,
  });

  // A raw getPlan detail exactly as PlansService.getPlan returns it, including
  // the heavy/leaky parts the wrapper must drop.
  const rawPlanDetail = {
    data: {
      ...rawPlanRow,
      items: [
        {
          id: 'item-1',
          task: { assignee: { email: 'member@example.com' } },
          estimated_cost: 500,
        },
      ],
      item_count: 7,
      stakeholder_count: 3,
      risk_count: 2,
      active_baseline: { id: 'b-1', snapshot_data: { huge: true } },
    },
  };

  beforeEach(() => {
    listPlans = jest.fn().mockResolvedValue(listedPage([rawPlanRow]));
    getPlan = jest.fn().mockResolvedValue(rawPlanDetail);
    maybeSingleResult = { data: { id: SPACE_ID }, error: null };
    inResult = {
      data: [{ id: SPACE_ID, key: 'CURLTEST', name: 'CurlTest' }],
      error: null,
    };
    limitResult = { data: [{ id: 'plan-1' }], error: null };
    service = buildService();
  });

  it('projects rows to the whitelisted shape and NEVER leaks internal fields', async () => {
    const result = await service.searchMyPlans(user, { query: 'SOC2' });

    expect(result.plans).toHaveLength(1);
    const item = result.plans[0];

    expect(item).toEqual({
      id: 'plan-1',
      planKey: 'CURLTEST-P1',
      name: 'SOC2 readiness',
      snippet: 'd'.repeat(200),
      planType: 'waterfall',
      status: 'active',
      ragStatus: 'amber',
      progress: 40,
      owner: { id: OWNER_UUID, name: 'Prince Jadiya' },
      space: { id: SPACE_ID, key: 'CURLTEST', name: 'CurlTest' },
      isArchived: false,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      updatedAt: '2026-06-01T00:00:00Z',
    });

    // Belt and braces: assert the leak-prone fields are truly absent.
    const serialized = JSON.stringify(result);

    for (const leaked of [
      'settings',
      'custom_field_values',
      'filter_id',
      'rag_set_by',
      'budget',
      'currency',
      'created_by',
      'creator@example.com',
      'avatar_url',
      'organization_id',
      'sort_order',
    ]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it('an absent query lists accessible plans (search undefined, not empty string)', async () => {
    await service.searchMyPlans(user, {});

    expect(listPlans).toHaveBeenCalledWith(
      ORG_ID,
      USER_ID,
      expect.objectContaining({ search: undefined, is_archived: false }),
    );
  });

  it('sanitizes the query exactly like the product search (strips ,.()"\'\\)', async () => {
    await service.searchMyPlans(user, { query: `SO"C2',().\\` });

    expect(listPlans).toHaveBeenCalledWith(
      ORG_ID,
      USER_ID,
      expect.objectContaining({ search: 'SOC2' }),
    );
  });

  it('a query that sanitizes to nothing behaves as no query', async () => {
    await service.searchMyPlans(user, { query: `"'()` });

    expect(listPlans).toHaveBeenCalledWith(
      ORG_ID,
      USER_ID,
      expect.objectContaining({ search: undefined }),
    );
  });

  it('resolves spaceIdOrKey as a key (uppercased) and passes the space id through', async () => {
    await service.searchMyPlans(user, { spaceIdOrKey: 'curltest' });

    expect(listPlans).toHaveBeenCalledWith(
      ORG_ID,
      USER_ID,
      expect.objectContaining({ space_id: SPACE_ID }),
    );
  });

  it('an unknown spaceIdOrKey yields empty (anti-probing), listPlans never called', async () => {
    maybeSingleResult = { data: null, error: null };

    const result = await service.searchMyPlans(user, {
      spaceIdOrKey: 'NOPE',
    });

    expect(result).toEqual({ plans: [] });
    expect(listPlans).not.toHaveBeenCalled();
  });

  it('a ForbiddenException from listPlans (non-member space) collapses to empty', async () => {
    listPlans.mockRejectedValueOnce(new ForbiddenException('denied'));

    const result = await service.searchMyPlans(user, {
      spaceIdOrKey: SPACE_ID,
    });

    expect(result).toEqual({ plans: [] });
  });

  it('any other listPlans failure degrades to empty (never leaks the error)', async () => {
    listPlans.mockRejectedValueOnce(new Error('pg exploded'));

    const result = await service.searchMyPlans(user, { query: 'x' });

    expect(result).toEqual({ plans: [] });
  });

  it("ownerId 'me' aliases the caller's user id", async () => {
    await service.searchMyPlans(user, { ownerId: 'me' });

    expect(listPlans).toHaveBeenCalledWith(
      ORG_ID,
      USER_ID,
      expect.objectContaining({ owner_id: USER_ID }),
    );
  });

  it('a non-uuid ownerId yields empty without querying', async () => {
    const result = await service.searchMyPlans(user, { ownerId: 'alice' });

    expect(result).toEqual({ plans: [] });
    expect(listPlans).not.toHaveBeenCalled();
  });

  it('an unknown status value (incl. archived) yields empty without querying', async () => {
    for (const status of ['archived', 'bogus']) {
      const result = await service.searchMyPlans(user, { status });

      expect(result).toEqual({ plans: [] });
    }

    expect(listPlans).not.toHaveBeenCalled();
  });

  it('clamps the limit into [1, 50] and defaults to 20', async () => {
    await service.searchMyPlans(user, {});
    await service.searchMyPlans(user, { limit: 999 });
    await service.searchMyPlans(user, { limit: -5 });

    expect(listPlans).toHaveBeenNthCalledWith(
      1,
      ORG_ID,
      USER_ID,
      expect.objectContaining({ pageSize: 20 }),
    );
    expect(listPlans).toHaveBeenNthCalledWith(
      2,
      ORG_ID,
      USER_ID,
      expect.objectContaining({ pageSize: 50 }),
    );
    expect(listPlans).toHaveBeenNthCalledWith(
      3,
      ORG_ID,
      USER_ID,
      expect.objectContaining({ pageSize: 1 }),
    );
  });

  it('decodes the opaque cursor to a page and emits nextCursor only when hasMore', async () => {
    listPlans.mockResolvedValueOnce(
      listedPage([rawPlanRow], { hasMore: true, total: 41 }),
    );

    const first = await service.searchMyPlans(user, {});

    expect(first.nextCursor).toBeDefined();
    expect(first.total).toBe(41);

    await service.searchMyPlans(user, { cursor: first.nextCursor });

    expect(listPlans).toHaveBeenLastCalledWith(
      ORG_ID,
      USER_ID,
      expect.objectContaining({ page: 2 }),
    );
  });

  it('a malformed, foreign, or zero cursor falls back to page 1', async () => {
    for (const cursor of [
      '!!!not-base64url!!!',
      Buffer.from('x:9').toString('base64url'),
      Buffer.from('p:0').toString('base64url'),
      Buffer.from('p:NaN').toString('base64url'),
    ]) {
      await service.searchMyPlans(user, { cursor });

      expect(listPlans).toHaveBeenLastCalledWith(
        ORG_ID,
        USER_ID,
        expect.objectContaining({ page: 1 }),
      );
    }
  });

  it('includeArchived=true is passed through and archived rows are flagged', async () => {
    listPlans.mockResolvedValueOnce(
      listedPage([{ ...rawPlanRow, is_archived: true }]),
    );

    const result = await service.searchMyPlans(user, {
      includeArchived: true,
    });

    expect(listPlans).toHaveBeenCalledWith(
      ORG_ID,
      USER_ID,
      expect.objectContaining({ is_archived: true }),
    );
    expect(result.plans[0].isArchived).toBe(true);
  });

  it('returns a safe empty shape for onboarding callers (no active org)', async () => {
    const result = await service.searchMyPlans(
      { ...user, organizationId: '' },
      { query: 'x' },
    );

    expect(result).toEqual({ plans: [] });
    expect(listPlans).not.toHaveBeenCalled();
  });

  it('handles a missing owner join and an unknown space ref as nulls', async () => {
    listPlans.mockResolvedValueOnce(
      listedPage([{ ...rawPlanRow, owner: null, space_id: 'other-space' }]),
    );
    inResult = { data: [], error: null };

    const result = await service.searchMyPlans(user, {});

    expect(result.plans[0].owner).toBeNull();
    expect(result.plans[0].space).toBeNull();
  });

  describe('getMyPlan', () => {
    const PLAN_UUID = 'dcb25e82-402e-41c3-bb05-ce67a0d18a0a';

    it('resolves a UUID directly and returns the whitelisted detail (no items/baseline/emails)', async () => {
      const result = await service.getMyPlan(user, PLAN_UUID);

      expect(getPlan).toHaveBeenCalledWith(PLAN_UUID, ORG_ID, USER_ID);
      expect(result.plan).toEqual({
        id: 'plan-1',
        planKey: 'CURLTEST-P1',
        name: 'SOC2 readiness',
        description: 'd'.repeat(500),
        planType: 'waterfall',
        status: 'active',
        ragStatus: 'amber',
        progress: 40,
        owner: { id: OWNER_UUID, name: 'Prince Jadiya' },
        space: { id: SPACE_ID, key: 'CURLTEST', name: 'CurlTest' },
        isArchived: false,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-06-01T00:00:00Z',
        itemCount: 7,
        riskCount: 2,
        stakeholderCount: 3,
      });

      const serialized = JSON.stringify(result);

      for (const leaked of [
        'items',
        'active_baseline',
        'snapshot_data',
        'member@example.com',
        'estimated_cost',
        'settings',
        'custom_field_values',
        'filter_id',
        'budget',
        'creator@example.com',
        'avatar_url',
        'organization_id',
      ]) {
        expect(serialized).not.toContain(leaked);
      }
    });

    it('resolves a plan key org-scoped (raw + uppercased candidates) before delegating', async () => {
      await service.getMyPlan(user, 'curltest-p1');

      expect(getPlan).toHaveBeenCalledWith('plan-1', ORG_ID, USER_ID);
    });

    it('an AMBIGUOUS plan key (2+ org matches) throws the uniform 404 without delegating', async () => {
      limitResult = {
        data: [{ id: 'plan-1' }, { id: 'plan-other-space' }],
        error: null,
      };

      await expect(service.getMyPlan(user, 'P1')).rejects.toThrow(
        'Plan not found',
      );
      expect(getPlan).not.toHaveBeenCalled();
    });

    it('an unknown plan key throws the uniform 404 without delegating', async () => {
      limitResult = { data: [], error: null };

      await expect(service.getMyPlan(user, 'NOPE-P9')).rejects.toThrow(
        'Plan not found',
      );
      expect(getPlan).not.toHaveBeenCalled();
    });

    it('a ForbiddenException from getPlan collapses to the IDENTICAL 404 (403 leak fixed)', async () => {
      getPlan.mockRejectedValueOnce(
        new ForbiddenException('Insufficient plan permissions'),
      );

      await expect(service.getMyPlan(user, PLAN_UUID)).rejects.toThrow(
        'Plan not found',
      );
    });

    it('a NotFoundException and ANY other getPlan failure collapse to the same 404', async () => {
      getPlan.mockRejectedValueOnce(new NotFoundException('Plan not found'));
      await expect(service.getMyPlan(user, PLAN_UUID)).rejects.toThrow(
        'Plan not found',
      );

      getPlan.mockRejectedValueOnce(new Error('pg exploded'));
      await expect(service.getMyPlan(user, PLAN_UUID)).rejects.toThrow(
        'Plan not found',
      );
    });

    it('empty, whitespace, and oversized identifiers throw the uniform 404 without querying', async () => {
      for (const bad of ['', '   ', 'x'.repeat(256)]) {
        await expect(service.getMyPlan(user, bad)).rejects.toThrow(
          'Plan not found',
        );
      }

      expect(getPlan).not.toHaveBeenCalled();
    });

    it('an onboarding caller (no active org) gets the uniform 404', async () => {
      await expect(
        service.getMyPlan({ ...user, organizationId: '' }, PLAN_UUID),
      ).rejects.toThrow('Plan not found');
      expect(getPlan).not.toHaveBeenCalled();
    });

    it('an archived plan is returned flagged (mirrors wiki.get)', async () => {
      getPlan.mockResolvedValueOnce({
        data: { ...rawPlanDetail.data, is_archived: true },
      });

      const result = await service.getMyPlan(user, PLAN_UUID);

      expect(result.plan.isArchived).toBe(true);
    });

    it('caps the description at 50 KB with a descriptionTruncated flag', async () => {
      getPlan.mockResolvedValueOnce({
        data: { ...rawPlanDetail.data, description: 'x'.repeat(51 * 1024) },
      });

      const result = await service.getMyPlan(user, PLAN_UUID);

      expect(result.plan.description.length).toBe(50 * 1024);
      expect(result.plan.descriptionTruncated).toBe(true);
    });

    it('handles a null owner, unknown space ref, and missing counts safely', async () => {
      getPlan.mockResolvedValueOnce({
        data: {
          ...rawPlanDetail.data,
          owner: null,
          space_id: 'other-space',
          item_count: undefined,
          risk_count: undefined,
          stakeholder_count: undefined,
        },
      });
      inResult = { data: [], error: null };

      const result = await service.getMyPlan(user, PLAN_UUID);

      expect(result.plan.owner).toBeNull();
      expect(result.plan.space).toBeNull();
      expect(result.plan.itemCount).toBe(0);
      expect(result.plan.riskCount).toBe(0);
      expect(result.plan.stakeholderCount).toBe(0);
    });
  });
});
