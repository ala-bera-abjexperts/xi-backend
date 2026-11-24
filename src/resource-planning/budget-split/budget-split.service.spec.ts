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
import type { ResourcePlanningService } from '../resource-planning.service';
import { BudgetSplitService } from './budget-split.service';
import type { CreateBudgetSplitDto } from './dto/budget-split.dto';

type Row = Record<string, unknown>;

const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const SPACE = 'space-1';
const OTHER_SPACE = 'space-2';

describe('BudgetSplitService', () => {
  const user = { userId: 'actor-1', organizationId: ORG } as RequestUser;

  let service: BudgetSplitService;
  let db: Record<string, Row[]>;
  /** Every executed query, for asserting writes and their org scoping. */
  let calls: { table: string; op: string; eq: [string, unknown][] }[];
  let from: jest.Mock;
  let isEnabled: jest.Mock;
  let resolveSpaceScope: jest.Mock;
  let logActionForRequest: jest.Mock;

  /** In-memory stand-in for the PostgREST chains the service uses. */
  function fakeFrom(table: string) {
    const eq: [string, unknown][] = [];
    const notNull: string[] = [];
    let inFilter: [string, unknown[]] | undefined;
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let columns = '*';
    let payload: Row = {};
    let orderBy: [string, boolean] | undefined;
    let limit: number | undefined;

    const matches = (r: Row) =>
      eq.every(([k, v]) => r[k] === v) &&
      notNull.every((k) => r[k] !== null && r[k] !== undefined) &&
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
        // budget_splits_budget_task_uq
        if (
          rows.some(
            (r) =>
              r.overall_budget_id === payload.overall_budget_id &&
              r.task_id === payload.task_id,
          )
        ) {
          return {
            data: null,
            error: { code: '23505', message: 'duplicate key' },
          };
        }
        const row = { id: 'split-new', ...payload };
        rows.push(row);
        return { data: [project(row)], error: null };
      }
      if (op === 'update') {
        const hits = rows.filter(matches);
        hits.forEach((r) => Object.assign(r, payload));
        return { data: hits.map(project), error: null };
      }
      if (op === 'delete') {
        db[table] = rows.filter((r) => !matches(r));
        return { data: null, error: null };
      }
      let hits = rows.filter(matches);
      const count = hits.length;
      if (orderBy) {
        const [key, ascending] = orderBy;
        hits = [...hits].sort(
          (a, b) => (Number(a[key]) - Number(b[key])) * (ascending ? 1 : -1),
        );
      }
      if (limit !== undefined) hits = hits.slice(0, limit);
      return { data: hits.map(project), error: null, count };
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
      not: (k: string) => {
        notNull.push(k);
        return query;
      },
      order: (k: string, o?: { ascending?: boolean }) => {
        orderBy = [k, o?.ascending !== false];
        return query;
      },
      limit: (n: number) => {
        limit = n;
        return query;
      },
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
    ...values,
  });
  const task = (
    id: string,
    parent_task_id: string | null,
    values: Row = {},
  ): Row => ({
    id,
    organization_id: ORG,
    parent_task_id,
    space_id: SPACE,
    key: id.toUpperCase(),
    summary: `Task ${id}`,
    ...values,
  });
  const split = (id: string, values: Row = {}): Row => ({
    id,
    organization_id: ORG,
    overall_budget_id: 'b1',
    task_id: 'epic',
    amount: '400.00',
    note: null,
    created_by: 'creator-1',
    updated_by: 'creator-1',
    ...values,
  });

  const writes = (op: string) =>
    calls.filter((c) => c.table === 'budget_splits' && c.op === op);

  beforeEach(() => {
    db = {
      overall_budgets: [
        budget('b1'),
        budget('b-other-space', { space_id: OTHER_SPACE }),
        budget('b-foreign', { organization_id: OTHER_ORG }),
      ],
      tasks: [
        task('epic', null),
        task('story', 'epic'),
        task('sub', 'story'),
        task('t-other-space', null, { space_id: OTHER_SPACE }),
        task('t-no-space', null, { space_id: null }),
        task('t-foreign', null, { organization_id: OTHER_ORG }),
      ],
      budget_splits: [
        split('s-epic'),
        split('s-other-space', {
          overall_budget_id: 'b-other-space',
          task_id: 't-other-space',
        }),
        split('s-foreign', { organization_id: OTHER_ORG }),
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
    service = new BudgetSplitService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      { isEnabled } as unknown as OrganizationModulesService,
      { resolveSpaceScope } as unknown as ResourcePlanningService,
      { logActionForRequest } as unknown as AuditLogsService,
    );
  });

  it('rejects every method when the module is disabled', async () => {
    isEnabled.mockResolvedValue(false);
    const dto = { overall_budget_id: 'b1', task_id: 'story', amount: 1 };

    await expect(service.create(user, dto)).rejects.toThrow(ForbiddenException);
    await expect(service.update(user, 's-epic', { amount: 2 })).rejects.toThrow(
      ForbiddenException,
    );
    await expect(service.remove(user, 's-epic')).rejects.toThrow(
      ForbiddenException,
    );
    expect(isEnabled).toHaveBeenCalledWith(ORG, 'resource_planning');
    expect(from).not.toHaveBeenCalled();
  });

  describe('create', () => {
    const dto: CreateBudgetSplitDto = {
      overall_budget_id: 'b1',
      task_id: 'story',
      amount: 150,
    };

    it('inserts with the actor, audits, and returns the split with its currency', async () => {
      const result = await service.create(user, { ...dto, note: 'Phase 1' });

      const inserted = db.budget_splits.find((s) => s.id === 'split-new');
      expect(inserted).toEqual({
        id: 'split-new',
        organization_id: ORG,
        overall_budget_id: 'b1',
        task_id: 'story',
        amount: 150,
        note: 'Phase 1',
        created_by: 'actor-1',
        updated_by: 'actor-1',
      });
      expect(result).toEqual({ ...inserted, currency: 'EUR' });
      expect(logActionForRequest).toHaveBeenCalledWith(
        user,
        'budget_split',
        'split-new',
        'create',
        { space_id: SPACE, after: inserted },
      );
    });

    it('returns 404 for a budget or task of another organization', async () => {
      await expect(
        service.create(user, { ...dto, overall_budget_id: 'b-foreign' }),
      ).rejects.toThrow(new NotFoundException('Overall budget not found'));
      await expect(
        service.create(user, { ...dto, task_id: 't-foreign' }),
      ).rejects.toThrow(new NotFoundException('Task not found'));
      expect(writes('insert')).toHaveLength(0);
    });

    it('rejects a budget whose space is out of scope before reading the task', async () => {
      await expect(
        service.create(user, { ...dto, overall_budget_id: 'b-other-space' }),
      ).rejects.toThrow(
        new ForbiddenException(
          'Resource Planning is not available in this space',
        ),
      );
      expect(calls.map((c) => c.table)).toEqual(['overall_budgets']);
    });

    it.each(['t-other-space', 't-no-space'])(
      'rejects task %s outside the budget space',
      async (task_id) => {
        await expect(service.create(user, { ...dto, task_id })).rejects.toThrow(
          new BadRequestException(
            'The task must be in the same space as the budget',
          ),
        );
        expect(writes('insert')).toHaveLength(0);
      },
    );

    it('returns 409 for a second split from the same budget on a task', async () => {
      await expect(
        service.create(user, { ...dto, task_id: 'epic' }),
      ).rejects.toThrow(
        new ConflictException('This task already has a split from this budget'),
      );
      expect(logActionForRequest).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('rejects a null amount and an empty body before reading', async () => {
      await expect(
        service.update(user, 's-epic', { amount: null } as unknown as {
          amount: number;
        }),
      ).rejects.toThrow(new BadRequestException('amount cannot be null'));
      await expect(service.update(user, 's-epic', {})).rejects.toThrow(
        new BadRequestException('Nothing to update'),
      );
      expect(from).not.toHaveBeenCalled();
    });

    it('returns 404 for a split of another organization', async () => {
      await expect(
        service.update(user, 's-foreign', { amount: 5 }),
      ).rejects.toThrow(new NotFoundException('Budget split not found'));
      expect(writes('update')).toHaveLength(0);
    });

    it('rejects a split whose budget space is out of scope', async () => {
      await expect(
        service.update(user, 's-other-space', { amount: 5 }),
      ).rejects.toThrow(ForbiddenException);
      expect(writes('update')).toHaveLength(0);
    });

    it('updates only the given fields, org-scoped, and audits before/after', async () => {
      const result = await service.update(user, 's-epic', {
        amount: 250.5,
        note: null,
      });

      expect(writes('update')).toEqual([
        {
          table: 'budget_splits',
          op: 'update',
          eq: [
            ['id', 's-epic'],
            ['organization_id', ORG],
          ],
        },
      ]);
      expect(logActionForRequest).toHaveBeenCalledWith(
        user,
        'budget_split',
        's-epic',
        'update',
        {
          space_id: SPACE,
          before: expect.objectContaining({
            amount: '400.00',
            updated_by: 'creator-1',
          }) as unknown,
          after: expect.objectContaining({
            amount: 250.5,
            note: null,
            task_id: 'epic',
            updated_by: 'actor-1',
          }) as unknown,
        },
      );
      expect(result).toMatchObject({ amount: 250.5, currency: 'EUR' });
    });
  });

  describe('remove', () => {
    it('deletes org-scoped and audits the removed row', async () => {
      await expect(service.remove(user, 's-epic')).resolves.toEqual({
        success: true,
      });

      expect(writes('delete')).toEqual([
        {
          table: 'budget_splits',
          op: 'delete',
          eq: [
            ['id', 's-epic'],
            ['organization_id', ORG],
          ],
        },
      ]);
      expect(db.budget_splits.map((s) => s.id)).not.toContain('s-epic');
      expect(logActionForRequest).toHaveBeenCalledWith(
        user,
        'budget_split',
        's-epic',
        'delete',
        {
          space_id: SPACE,
          before: expect.objectContaining({
            id: 's-epic',
            amount: '400.00',
          }) as unknown,
        },
      );
    });

    it('returns 404 for another org and 403 for an out-of-scope space', async () => {
      await expect(service.remove(user, 's-foreign')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.remove(user, 's-other-space')).rejects.toThrow(
        ForbiddenException,
      );
      expect(writes('delete')).toHaveLength(0);
      expect(logActionForRequest).not.toHaveBeenCalled();
    });
  });

  describe('helpers', () => {
    it('listByTaskIds returns org-scoped rows with numeric amounts', async () => {
      db.budget_splits.push(
        split('s-foreign-story', {
          organization_id: OTHER_ORG,
          task_id: 'story',
        }),
      );

      await expect(
        service.listByTaskIds(ORG, ['epic', 'story', 'epic']),
      ).resolves.toEqual([
        {
          id: 's-epic',
          overall_budget_id: 'b1',
          task_id: 'epic',
          amount: 400,
          note: null,
        },
      ]);
    });

    it('analyzeBudgets nests through ancestors fetched from tasks', async () => {
      db.budget_splits.push(
        split('s-sub', { task_id: 'sub', amount: '90.00' }),
        split('s-story-b2', {
          overall_budget_id: 'b2',
          task_id: 'story',
          amount: '10.00',
        }),
      );

      const { rows, analysis } = await service.analyzeBudgets(ORG, [
        { id: 'b1', amount: 300 },
      ]);

      expect(rows.map((r) => r.id)).toEqual(['s-epic', 's-sub']);
      expect(analysis.splits.get('s-sub')?.parent_split_id).toBe('s-epic');
      expect(analysis.splits.get('s-epic')).toEqual({
        parent_split_id: null,
        children_amount: 90,
        children_exceed_by: 0,
      });
      expect(analysis.budgets.get('b1')).toEqual({
        allocated_amount: 400,
        over_allocated_by: 100,
      });
      // epic + sub, then story (epic is already known): one read per level, org-scoped.
      const taskReads = calls.filter((c) => c.table === 'tasks');
      expect(taskReads).toHaveLength(2);
      expect(
        taskReads.every((c) =>
          c.eq.some(([k, v]) => k === 'organization_id' && v === ORG),
        ),
      ).toBe(true);
    });

    it('analyzeBudgets runs no query for no budgets', async () => {
      const { rows, analysis } = await service.analyzeBudgets(ORG, []);

      expect(rows).toEqual([]);
      expect(analysis.budgets.size).toBe(0);
      expect(from).not.toHaveBeenCalled();
    });

    it('linkedSplits lists the funded tasks, largest first, with the total', async () => {
      db.budget_splits.push(
        split('s-story', { task_id: 'story', amount: '12000.00' }),
        split('s-sub', { task_id: 'sub', amount: '5.00' }),
      );

      await expect(service.linkedSplits(ORG, 'b1', 2)).resolves.toEqual({
        total: 3,
        items: [
          { task_key: 'STORY', task_summary: 'Task story', amount: 12000 },
          { task_key: 'EPIC', task_summary: 'Task epic', amount: 400 },
        ],
      });
      await expect(service.linkedSplits(ORG, 'b-foreign')).resolves.toEqual({
        total: 0,
        items: [],
      });
    });
  });
});
