import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import type { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { BudgetSplitService } from '../budget-split/budget-split.service';
import type { ResourcePlanningService } from '../resource-planning.service';
import type { BudgetUsageService } from './budget-usage.service';
import type {
  CreateOverallBudgetDto,
  UpdateOverallBudgetDto,
} from './dto/overall-budget.dto';
import { OverallBudgetService } from './overall-budget.service';

type Row = Record<string, unknown>;

const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const SPACE = 'space-1';
const OTHER_SPACE = 'space-2';

describe('OverallBudgetService', () => {
  const user = { userId: 'actor-1', organizationId: ORG } as RequestUser;

  let service: OverallBudgetService;
  let db: Record<string, Row[]>;
  /** Every executed query, for asserting writes and their org scoping. */
  let calls: { table: string; op: string; eq: [string, unknown][] }[];
  let from: jest.Mock;
  let isEnabled: jest.Mock;
  let resolveSpaceScope: jest.Mock;
  let logActionForRequest: jest.Mock;
  let analyzeBudgets: jest.Mock;
  let linkedSplits: jest.Mock;
  let usedByBudget: jest.Mock;
  let deleteError: { code: string; message: string } | null;

  /** In-memory stand-in for the PostgREST chains the service uses. */
  function fakeFrom(table: string) {
    const eq: [string, unknown][] = [];
    let inFilter: [string, unknown[]] | undefined;
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let columns = '*';
    let payload: Row = {};

    const matches = (r: Row) =>
      eq.every(([k, v]) => r[k] === v) &&
      (!inFilter || inFilter[1].includes(r[inFilter[0]]));
    const project = (r: Row): Row =>
      columns === '*'
        ? { ...r }
        : Object.fromEntries(
            columns.split(',').map((c) => [c.trim(), r[c.trim()]]),
          );

    const run = () => {
      calls.push({ table, op, eq });
      const rows = (db[table] ??= []);
      if (op === 'insert') {
        const row = { id: 'budget-new', ...payload };
        rows.push(row);
        return { data: [project(row)], error: null };
      }
      if (op === 'update') {
        const hits = rows.filter(matches);
        hits.forEach((r) => Object.assign(r, payload));
        return { data: hits.map(project), error: null };
      }
      if (op === 'delete') {
        if (deleteError) return { data: null, error: deleteError };
        db[table] = rows.filter((r) => !matches(r));
        return { data: null, error: null };
      }
      return { data: rows.filter(matches).map(project), error: null };
    };

    const query: Record<string, unknown> = {
      select: (c = '*') => {
        columns = c;
        return query;
      },
      eq: (k: string, v: unknown) => {
        eq.push([k, v]);
        return query;
      },
      in: (k: string, v: unknown[]) => {
        inFilter = [k, v];
        return query;
      },
      order: () => query,
      insert: (p: Row) => {
        op = 'insert';
        payload = p;
        return query;
      },
      update: (p: Row) => {
        op = 'update';
        payload = p;
        return query;
      },
      delete: () => {
        op = 'delete';
        return query;
      },
      maybeSingle: () => {
        const r = run();
        return Promise.resolve({ ...r, data: r.data?.[0] ?? null });
      },
      then: (
        onFulfilled: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => Promise.resolve(run()).then(onFulfilled, onRejected),
    };
    query.single = query.maybeSingle;
    return query;
  }

  const budget = (id: string, values: Row = {}): Row => ({
    id,
    organization_id: ORG,
    space_id: SPACE,
    name: `Budget ${id}`,
    amount: '1000.00',
    currency: 'EUR',
    source: null,
    financial_year: null,
    responsible_user_id: null,
    cost_category_id: null,
    created_by: 'creator-1',
    updated_by: 'creator-1',
    ...values,
  });
  const category = (id: string, values: Row = {}): Row => ({
    id,
    organization_id: ORG,
    code: 'RC',
    label: 'RC',
    cost_group: 'RC',
    sort_order: 10,
    is_active: true,
    ...values,
  });
  const person = (id: string, is_active: boolean): Row => ({
    id,
    first_name: 'Ann',
    last_name: 'Lee',
    email: `${id}@example.com`,
    avatar_url: null,
    is_active,
  });

  const writes = (op: string) =>
    calls.filter((c) => c.table === 'overall_budgets' && c.op === op);

  beforeEach(() => {
    db = {
      overall_budgets: [
        budget('b1', {
          amount: '250000.50',
          responsible_user_id: 'u-active',
          cost_category_id: 'cat-1',
        }),
        budget('b2', { responsible_user_id: 'u-left' }),
        budget('b3', { space_id: OTHER_SPACE }),
        budget('b-foreign', { organization_id: OTHER_ORG }),
      ],
      users: [
        person('u-active', true),
        person('u-left', false),
        person('u-foreign', true),
      ],
      organization_members: [
        { organization_id: ORG, user_id: 'u-active' },
        { organization_id: OTHER_ORG, user_id: 'u-foreign' },
      ],
      budget_cost_categories: [
        category('cat-1'),
        category('cat-inactive', { is_active: false }),
        category('cat-foreign', { organization_id: OTHER_ORG }),
      ],
    };
    calls = [];
    from = jest.fn(fakeFrom);
    isEnabled = jest.fn().mockResolvedValue(true);
    resolveSpaceScope = jest.fn().mockResolvedValue({
      allowedSpaceIds: new Set([SPACE]),
      allowsNullSpace: true,
    });
    logActionForRequest = jest.fn().mockResolvedValue(undefined);
    analyzeBudgets = jest.fn((_org: string, budgets: { id: string }[]) =>
      Promise.resolve({
        rows: [],
        analysis: {
          splits: new Map(),
          budgets: new Map(
            budgets.map((b) => [
              b.id,
              { allocated_amount: 0, over_allocated_by: 0 },
            ]),
          ),
        },
      }),
    );
    linkedSplits = jest.fn().mockResolvedValue({ total: 0, items: [] });
    usedByBudget = jest.fn().mockResolvedValue(new Map());
    deleteError = null;
    service = new OverallBudgetService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      { isEnabled } as unknown as OrganizationModulesService,
      { resolveSpaceScope } as unknown as ResourcePlanningService,
      { logActionForRequest } as unknown as AuditLogsService,
      { analyzeBudgets, linkedSplits } as unknown as BudgetSplitService,
      { usedByBudget } as unknown as BudgetUsageService,
    );
  });

  it('rejects every method when the module is disabled', async () => {
    isEnabled.mockResolvedValue(false);
    const dto = { name: 'x', amount: 1, currency: 'EUR' };

    await expect(service.list(user, SPACE)).rejects.toThrow(ForbiddenException);
    await expect(service.create(user, SPACE, dto)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(service.update(user, 'b1', { name: 'y' })).rejects.toThrow(
      ForbiddenException,
    );
    await expect(service.remove(user, 'b1')).rejects.toThrow(
      ForbiddenException,
    );
    expect(isEnabled).toHaveBeenCalledWith(ORG, 'resource_planning');
    expect(from).not.toHaveBeenCalled();
  });

  describe('list', () => {
    it("returns the space's rows hydrated, with a zero status", async () => {
      const result = await service.list(user, SPACE);

      expect(resolveSpaceScope).toHaveBeenCalledWith(ORG, 'actor-1');
      expect(result.count).toBe(2);
      expect(result.data.map((b) => b.id)).toEqual(['b1', 'b2']);
      expect(result.data[0]).toMatchObject({
        amount: 250000.5,
        allocated_amount: 0,
        used_amount: 0,
        used_percent: 0,
        used_other_currencies: [],
        missing_rate_hours: 0,
        responsible: {
          ...person('u-active', true),
          is_member: true,
        },
        cost_category: {
          id: 'cat-1',
          code: 'RC',
          label: 'RC',
          cost_group: 'RC',
          is_active: true,
        },
      });
      expect(result.data[0].cost_category).not.toHaveProperty(
        'organization_id',
      );
      expect(result.data[1]).toMatchObject({
        amount: 1000,
        responsible: { id: 'u-left', is_active: false, is_member: false },
        cost_category: null,
        used_percent: 0,
      });
    });

    it('takes the allocated amount from the split analysis', async () => {
      analyzeBudgets.mockResolvedValue({
        rows: [],
        analysis: {
          splits: new Map(),
          budgets: new Map([
            ['b1', { allocated_amount: 1200.5, over_allocated_by: 0 }],
          ]),
        },
      });

      const result = await service.list(user, SPACE);

      expect(analyzeBudgets).toHaveBeenCalledTimes(1);
      expect(analyzeBudgets).toHaveBeenCalledWith(ORG, [
        { id: 'b1', amount: 250000.5 },
        { id: 'b2', amount: 1000 },
      ]);
      expect(result.data.map((b) => b.allocated_amount)).toEqual([1200.5, 0]);
      expect(result.data[0].used_amount).toBe(0);
    });

    it('takes the used figures from one batched usage call', async () => {
      usedByBudget.mockResolvedValue(
        new Map([
          [
            'b1',
            {
              used_amount: 500.25,
              used_percent: 0.2,
              used_other_currencies: [{ currency: 'USD', amount: 12.5 }],
              missing_rate_hours: 3,
            },
          ],
        ]),
      );

      const result = await service.list(user, SPACE);

      expect(usedByBudget).toHaveBeenCalledTimes(1);
      expect(usedByBudget).toHaveBeenCalledWith(ORG, ['b1', 'b2']);
      expect(result.data[0]).toMatchObject({
        used_amount: 500.25,
        used_percent: 0.2,
        used_other_currencies: [{ currency: 'USD', amount: 12.5 }],
        missing_rate_hours: 3,
      });
      expect(result.data[1]).toMatchObject({
        used_amount: 0,
        used_percent: 0,
        used_other_currencies: [],
        missing_rate_hours: 0,
      });
    });

    it('skips the usage call for a space without budgets', async () => {
      db.overall_budgets = [];

      await expect(service.list(user, SPACE)).resolves.toEqual({
        data: [],
        count: 0,
      });
      expect(usedByBudget).not.toHaveBeenCalled();
    });

    it('rejects a space outside the scope before any table read', async () => {
      await expect(service.list(user, OTHER_SPACE)).rejects.toThrow(
        new ForbiddenException(
          'Resource Planning is not available in this space',
        ),
      );
      expect(from).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    const dto: CreateOverallBudgetDto = {
      name: 'Capex',
      amount: 5000,
      currency: 'USD',
      financial_year: '2026/27',
    };

    it.each([
      ['a former or foreign member', { responsible_user_id: 'u-foreign' }],
      ['an unknown user', { responsible_user_id: 'u-missing' }],
    ])('rejects %s as responsible', async (_, extra) => {
      await expect(
        service.create(user, SPACE, { ...dto, ...extra }),
      ).rejects.toThrow(
        new BadRequestException(
          'Responsible user is not a member of this organization',
        ),
      );
      expect(writes('insert')).toHaveLength(0);
    });

    it.each(['cat-inactive', 'cat-foreign', 'cat-missing'])(
      'rejects category %s',
      async (cost_category_id) => {
        await expect(
          service.create(user, SPACE, { ...dto, cost_category_id }),
        ).rejects.toThrow(
          new BadRequestException('Budget category not found or inactive'),
        );
        expect(writes('insert')).toHaveLength(0);
      },
    );

    it('inserts with the actor, audits, and returns the hydrated row', async () => {
      const result = await service.create(user, SPACE, {
        ...dto,
        responsible_user_id: 'u-active',
        cost_category_id: 'cat-1',
      });

      const inserted = db.overall_budgets.find((b) => b.id === 'budget-new');
      expect(inserted).toEqual({
        id: 'budget-new',
        organization_id: ORG,
        space_id: SPACE,
        name: 'Capex',
        amount: 5000,
        currency: 'USD',
        source: null,
        financial_year: '2026/27',
        responsible_user_id: 'u-active',
        cost_category_id: 'cat-1',
        created_by: 'actor-1',
        updated_by: 'actor-1',
      });
      expect(result).toMatchObject({
        id: 'budget-new',
        responsible: { id: 'u-active', is_member: true },
        cost_category: { id: 'cat-1' },
        allocated_amount: 0,
      });
      expect(logActionForRequest).toHaveBeenCalledWith(
        user,
        'overall_budget',
        'budget-new',
        'create',
        { space_id: SPACE, after: inserted },
      );
    });
  });

  describe('update', () => {
    it('returns 404 for a budget of another organization', async () => {
      await expect(
        service.update(user, 'b-foreign', { name: 'Taken' }),
      ).rejects.toThrow(new NotFoundException('Overall budget not found'));
      expect(writes('update')).toHaveLength(0);
    });

    it.each(['name', 'amount', 'currency'])(
      'rejects a null %s before reading',
      async (field) => {
        await expect(
          service.update(user, 'b1', {
            [field]: null,
          } as UpdateOverallBudgetDto),
        ).rejects.toThrow(new BadRequestException(`${field} cannot be null`));
        expect(from).not.toHaveBeenCalled();
      },
    );

    it('rejects an empty body', async () => {
      await expect(service.update(user, 'b1', {})).rejects.toThrow(
        new BadRequestException('Nothing to update'),
      );
    });

    it('rejects a budget whose space is out of scope', async () => {
      await expect(
        service.update(user, 'b3', { name: 'Nope' }),
      ).rejects.toThrow(ForbiddenException);
      expect(writes('update')).toHaveLength(0);
    });

    it('updates only the given fields, org-scoped, and audits before/after', async () => {
      const result = await service.update(user, 'b1', {
        amount: 750,
        source: 'grant',
        responsible_user_id: null,
      });

      expect(writes('update')).toEqual([
        {
          table: 'overall_budgets',
          op: 'update',
          eq: [
            ['id', 'b1'],
            ['organization_id', ORG],
          ],
        },
      ]);
      const [, , , , changes] = logActionForRequest.mock.calls[0] as [
        unknown,
        string,
        string,
        string,
        { space_id: string; before: Row; after: Row },
      ];
      expect(
        (logActionForRequest.mock.calls[0] as unknown[]).slice(0, 4),
      ).toEqual([user, 'overall_budget', 'b1', 'update']);
      expect(changes.space_id).toBe(SPACE);
      expect(changes.before).toMatchObject({
        amount: '250000.50',
        source: null,
        responsible_user_id: 'u-active',
        updated_by: 'creator-1',
      });
      expect(changes.after).toMatchObject({
        name: 'Budget b1',
        amount: 750,
        source: 'grant',
        responsible_user_id: null,
        updated_by: 'actor-1',
      });
      expect(result).toMatchObject({ amount: 750, responsible: null });
    });

    it('keeps an unchanged inactive category but rejects switching to one', async () => {
      db.overall_budgets[0].cost_category_id = 'cat-inactive';

      await expect(
        service.update(user, 'b1', {
          name: 'Renamed',
          cost_category_id: 'cat-inactive',
        }),
      ).resolves.toMatchObject({
        name: 'Renamed',
        cost_category: { id: 'cat-inactive', is_active: false },
      });
      await expect(
        service.update(user, 'b2', { cost_category_id: 'cat-inactive' }),
      ).rejects.toThrow(
        new BadRequestException('Budget category not found or inactive'),
      );
    });

    it('blocks a currency change while splits use the budget', async () => {
      linkedSplits.mockResolvedValue({ total: 1, items: [] });

      await expect(
        service.update(user, 'b1', { currency: 'USD' }),
      ).rejects.toThrow(
        new ConflictException(
          'The currency cannot be changed while budget splits use this budget',
        ),
      );
      expect(linkedSplits).toHaveBeenCalledWith(ORG, 'b1', 1);
      expect(writes('update')).toHaveLength(0);
    });

    it('allows the same currency with splits, or a new one without', async () => {
      linkedSplits.mockResolvedValue({ total: 1, items: [] });
      await expect(
        service.update(user, 'b1', { currency: 'EUR', name: 'Same' }),
      ).resolves.toMatchObject({ currency: 'EUR', name: 'Same' });
      expect(linkedSplits).not.toHaveBeenCalled();

      linkedSplits.mockResolvedValue({ total: 0, items: [] });
      await expect(
        service.update(user, 'b2', { currency: 'USD' }),
      ).resolves.toMatchObject({ currency: 'USD' });
    });

    it('does not re-check an unchanged responsible who left the org', async () => {
      await expect(
        service.update(user, 'b2', {
          name: 'Kept',
          responsible_user_id: 'u-left',
        }),
      ).resolves.toMatchObject({
        responsible: { id: 'u-left', is_member: false },
      });
    });
  });

  describe('remove', () => {
    it('deletes org-scoped and audits the removed row', async () => {
      await expect(service.remove(user, 'b1')).resolves.toEqual({
        success: true,
      });

      expect(writes('delete')).toEqual([
        {
          table: 'overall_budgets',
          op: 'delete',
          eq: [
            ['id', 'b1'],
            ['organization_id', ORG],
          ],
        },
      ]);
      expect(db.overall_budgets.map((b) => b.id)).not.toContain('b1');
      expect(logActionForRequest).toHaveBeenCalledWith(
        user,
        'overall_budget',
        'b1',
        'delete',
        {
          space_id: SPACE,
          before: expect.objectContaining({
            id: 'b1',
            amount: '250000.50',
          }) as unknown,
        },
      );
    });

    it('blocks deleting a budget that funds tasks, naming them', async () => {
      linkedSplits.mockResolvedValue({
        total: 12,
        items: [
          { task_key: 'KEY-1', task_summary: 'Epic', amount: 12000 },
          { task_key: 'KEY-2', task_summary: 'Story', amount: 0.5 },
        ],
      });

      await expect(service.remove(user, 'b1')).rejects.toThrow(
        new ConflictException(
          'Cannot delete "Budget b1": it still funds 12 task(s): KEY-1 (12,000.00 EUR), KEY-2 (0.50 EUR), and 10 more. Remove these budget splits first.',
        ),
      );
      expect(linkedSplits).toHaveBeenCalledWith(ORG, 'b1');
      expect(writes('delete')).toHaveLength(0);
      expect(logActionForRequest).not.toHaveBeenCalled();
    });

    it('maps a split added after the check (23503) to 409', async () => {
      deleteError = { code: '23503', message: 'fk violation' };

      await expect(service.remove(user, 'b1')).rejects.toThrow(
        new ConflictException(
          'This budget still has budget splits. Remove them first.',
        ),
      );
      expect(logActionForRequest).not.toHaveBeenCalled();
    });

    it('returns 404 for another org and 403 for an out-of-scope space', async () => {
      await expect(service.remove(user, 'b-foreign')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.remove(user, 'b3')).rejects.toThrow(
        ForbiddenException,
      );
      expect(writes('delete')).toHaveLength(0);
      expect(logActionForRequest).not.toHaveBeenCalled();
    });
  });
});
