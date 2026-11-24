import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { OrganizationModulesService } from '../organization-modules/organization-modules.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { BudgetEntryType } from './dto/budget-entry.dto';
import { CURRENCY_REQUIRED_FOR_RATE_MESSAGE } from './dto/capacity-period.dto';
import { ResourcePlanningCoreService } from './resource-planning-core.service';
import { ResourcePlanningService } from './resource-planning.service';

describe('ResourcePlanningCoreService', () => {
  let service: ResourcePlanningCoreService;
  let from: jest.Mock;
  let resourcePlanning: {
    assertOrganizationMember: jest.Mock;
    assertPlanAccess: jest.Mock;
    assertTaskAccess: jest.Mock;
    resolveSpaceScope: jest.Mock;
  };

  function chain(result: { data: unknown; error: unknown }) {
    const value: Record<string, unknown> = {};
    const self = jest.fn(() => value);
    for (const method of [
      'select',
      'eq',
      'neq',
      'or',
      'lte',
      'gte',
      'order',
      'limit',
      'insert',
      'update',
      'delete',
    ]) {
      value[method] = self;
    }
    value.single = jest.fn().mockResolvedValue(result);
    value.maybeSingle = jest.fn().mockResolvedValue(result);
    value.then = (
      onFulfilled: (response: { data: unknown; error: unknown }) => unknown,
    ) => Promise.resolve(result).then(onFulfilled);
    return value;
  }

  beforeEach(() => {
    from = jest.fn();
    resourcePlanning = {
      assertOrganizationMember: jest.fn().mockResolvedValue(undefined),
      assertPlanAccess: jest.fn().mockResolvedValue(undefined),
      assertTaskAccess: jest.fn().mockResolvedValue(undefined),
      resolveSpaceScope: jest.fn().mockResolvedValue({
        allowedSpaceIds: new Set(['space-a']),
        allowsNullSpace: true,
      }),
    };
    service = new ResourcePlanningCoreService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      {
        isEnabled: jest.fn().mockResolvedValue(true),
      } as unknown as OrganizationModulesService,
      resourcePlanning as unknown as ResourcePlanningService,
    );
  });

  it('requires exactly one budget target', async () => {
    await expect(
      service.createBudgetEntry('org-1', 'actor-1', {
        plan_id: 'plan-1',
        task_id: 'task-1',
        entry_type: BudgetEntryType.PLANNED,
        name: 'Hosting',
        currency: 'EUR',
        effective_date: '2026-08-14',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(from).not.toHaveBeenCalled();
  });

  it('normalizes budget text and currency and checks target edit access', async () => {
    const inserted = {
      id: 'entry-1',
      plan_id: 'plan-1',
      currency: 'EUR',
    };
    const query = chain({ data: inserted, error: null });
    from.mockReturnValue(query);

    await expect(
      service.createBudgetEntry('org-1', 'actor-1', {
        plan_id: 'plan-1',
        entry_type: BudgetEntryType.PLANNED,
        name: '  Hosting  ',
        category: ' Infrastructure ',
        currency: ' eur ',
        effective_date: '2026-08-14',
      }),
    ).resolves.toEqual(inserted);

    expect(resourcePlanning.assertPlanAccess).toHaveBeenCalledWith(
      'plan-1',
      'org-1',
      'actor-1',
      'edit',
    );
    expect(query.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Hosting',
        category: 'Infrastructure',
        currency: 'EUR',
      }),
    );
  });

  it('rejects overlapping active capacity periods before inserting', async () => {
    from.mockReturnValue(chain({ data: [{ id: 'period-1' }], error: null }));

    await expect(
      service.createCapacityPeriod('org-1', 'actor-1', {
        user_id: 'user-1',
        effective_from: '2026-08-01',
        effective_to: '2026-08-31',
        weekly_capacity_hours: 40,
      }),
    ).rejects.toThrow(ConflictException);

    expect(resourcePlanning.assertOrganizationMember).toHaveBeenCalledWith(
      'org-1',
      'user-1',
    );
    expect(from).toHaveBeenCalledTimes(1);
  });

  describe('updateCapacityPeriod currency rule', () => {
    const legacyPeriod = {
      id: 'period-1',
      organization_id: 'org-1',
      user_id: 'user-1',
      effective_from: '2026-08-01',
      effective_to: null,
      weekly_capacity_hours: 40,
      cost_rate: 50,
      currency: null,
      is_active: true,
    };

    it('rejects setting a rate on a period with no currency before writing', async () => {
      const query = chain({
        data: { ...legacyPeriod, cost_rate: null },
        error: null,
      });
      from.mockReturnValue(query);

      await expect(
        service.updateCapacityPeriod('period-1', 'org-1', 'actor-1', {
          cost_rate: 50,
        }),
      ).rejects.toThrow(CURRENCY_REQUIRED_FOR_RATE_MESSAGE);

      // chain() shares one mock across methods, so count `from` calls: only the read ran.
      expect(from).toHaveBeenCalledTimes(1);
      expect(resourcePlanning.assertOrganizationMember).not.toHaveBeenCalled();
    });

    it('still lets an is_active-only PATCH through on a legacy rate without currency', async () => {
      from.mockReturnValue(chain({ data: legacyPeriod, error: null }));

      await expect(
        service.updateCapacityPeriod('period-1', 'org-1', 'actor-1', {
          is_active: false,
        }),
      ).resolves.toEqual(legacyPeriod);
    });
  });

  it('scopes an unfiltered budget-entry list to allowed spaces plus null-space rows', async () => {
    from.mockReturnValue(
      chain({
        data: [
          {
            id: 'in-space',
            plan_id: 'plan-a',
            task_id: null,
            plan: { space_id: 'space-a' },
            task: null,
          },
          {
            id: 'other-space',
            plan_id: null,
            task_id: 'task-b',
            plan: null,
            task: { space_id: 'space-b' },
          },
          {
            id: 'no-space',
            plan_id: null,
            task_id: 'task-n',
            plan: null,
            task: { space_id: null },
          },
        ],
        error: null,
      }),
    );

    const rows = await service.listBudgetEntries('org-1', 'user-1', {});

    expect(rows.map((row) => row.id)).toEqual(['in-space', 'no-space']);
    expect(rows[0]).not.toHaveProperty('plan');
    expect(resourcePlanning.resolveSpaceScope).toHaveBeenCalledWith(
      'org-1',
      'user-1',
    );
  });

  it('404s a space_id that does not match the task, and 400s one with no target', async () => {
    resourcePlanning.assertTaskAccess.mockResolvedValue({
      id: 'task-1',
      space_id: 'space-b',
    });

    await expect(
      service.listBudgetEntries('org-1', 'user-1', {
        task_id: 'task-1',
        space_id: 'space-a',
      }),
    ).rejects.toThrow(NotFoundException);
    await expect(
      service.listBudgetEntries('org-1', 'user-1', { space_id: 'space-a' }),
    ).rejects.toThrow(BadRequestException);
    expect(from).not.toHaveBeenCalled();
  });
});
