/**
 * Robert 1.22: who may use which plan, and the writes of a Confirm. The rules are the human plan
 * routes' own; the writes go through PlansService under the reserved id.
 */
import type { PermissionsService } from '../permissions/permissions.service';
import type { PlansService } from '../plans/plans.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AgentGovernanceError } from './agent-governance.service';
import {
  AgentPlansService,
  fitPlanItemText,
  planItemHtml,
  type ProductPlanRow,
} from './agent-plans.service';

type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>) {
  const calls: { table: string; op: string; payload?: unknown }[] = [];
  const from = (table: string) => {
    const filters: ((row: Row) => boolean)[] = [];
    const run = () =>
      (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (col: string, value: unknown) => {
        if (!col.includes('.')) filters.push((row) => row[col] === value);
        return q;
      },
      in: (col: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[col]));
        return q;
      },
      order: () => q,
      limit: () => q,
      upsert: (payload: unknown) => {
        calls.push({ table, op: 'upsert', payload });
        return Promise.resolve({ error: null });
      },
      delete: () => {
        calls.push({ table, op: 'delete' });
        return q;
      },
      maybeSingle: () =>
        Promise.resolve({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: run(), error: null }).then(resolve),
    };
    return q;
  };
  return { from, calls };
}

const S_A = '5a000000-0000-4000-8000-00000000000a';
const PHASE = '7a000000-0000-4000-8000-000000000001';
const ANNA = '0a000000-0000-4000-8000-000000000002';
const ME = { userId: 'u-me', organizationId: 'org-1' };
const plan = (over: Partial<ProductPlanRow>): ProductPlanRow => ({
  id: 'p1',
  plan_key: 'A-P1',
  name: 'Q4',
  space_id: S_A,
  status: 'active',
  is_archived: false,
  start_date: null,
  end_date: null,
  currency: 'EUR',
  ...over,
});

describe('AgentPlansService', () => {
  let tables: Record<string, Row[]>;
  let db: ReturnType<typeof fakeDb>;
  let perms: Record<string, jest.Mock>;
  let plans: Record<string, jest.Mock>;
  let rpc: jest.Mock;
  let service: AgentPlansService;

  beforeEach(() => {
    tables = {
      plans: [
        { ...plan({}), organization_id: 'org-1' },
        {
          ...plan({ id: 'p2', space_id: 's-b', plan_key: 'B-P1' }),
          organization_id: 'org-1',
        },
        {
          ...plan({ id: 'p3', space_id: 's-c', plan_key: 'C-P1' }),
          organization_id: 'org-1',
        },
      ],
      plan_permissions: [
        { plan_id: 'p3', user_id: 'u-me', permission_level: 'edit' },
      ],
      tasks: [],
    };
    db = fakeDb(tables);
    perms = {
      isAdminOrOwner: jest.fn().mockResolvedValue(false),
      getUserSpacePermissions: jest.fn(
        (_u: string, _o: string, spaceId: string) =>
          Promise.resolve({
            isMember: spaceId !== 's-c',
            permissions: {
              edit_plans: spaceId === S_A,
              create_plans: spaceId === S_A,
              delete_plans: false,
            },
          }),
      ),
    };
    plans = {
      assertCanEditPlan: jest.fn().mockResolvedValue({
        id: 'p1',
        space_id: S_A,
        status: 'active',
        is_archived: false,
      }),
      insertPlanItemTask: jest.fn().mockResolvedValue('t-new'),
      createPlan: jest.fn().mockResolvedValue({ data: {}, success: true }),
      auditPlanItemCreated: jest.fn().mockResolvedValue(undefined),
      recalculateWbs: jest.fn().mockResolvedValue(undefined),
    };
    rpc = jest.fn().mockResolvedValue({
      data: { linked: true, adopted: false },
      error: null,
    });
    service = new AgentPlansService(
      {
        getClient: () => ({ from: db.from, rpc }),
      } as unknown as SupabaseAdminService,
      perms as unknown as PermissionsService,
      plans as unknown as PlansService,
    );
  });

  describe('who may use a plan', () => {
    it('the human edit rule: edit_plans in the space, or an explicit edit row; viewing is not enough', async () => {
      const ids = (await service.editablePlans(ME)).map((p) => p.id);
      expect(ids).toEqual(['p1', 'p3']);
    });

    it('an org owner or admin may edit every plan', async () => {
      perms.isAdminOrOwner.mockResolvedValue(true);
      expect((await service.editablePlans(ME)).map((p) => p.id)).toEqual([
        'p1',
        'p2',
        'p3',
      ]);
    });

    it('delete needs the admin level: delete_plans or an admin row', async () => {
      expect(
        await service.canDelete(ME, plan({ id: 'p3', space_id: 's-c' })),
      ).toBe(false);
      tables.plan_permissions[0].permission_level = 'admin';
      expect(
        await service.canDelete(ME, plan({ id: 'p3', space_id: 's-c' })),
      ).toBe(true);
    });

    it('creating needs create_plans as a member, with no admin shortcut (createPlan has none)', async () => {
      perms.isAdminOrOwner.mockResolvedValue(true);
      expect(await service.canCreateIn(ME, S_A)).toBe(true);
      expect(await service.canCreateIn(ME, 's-b')).toBe(false);
    });
  });

  describe('a new plan', () => {
    const input = {
      spaceId: S_A,
      name: 'Q4',
      description: null,
      planType: 'agile' as const,
      startDate: '2026-10-01',
      endDate: '2026-12-31',
      ownerId: null,
    };

    it('goes through createPlan under the reserved id, as the person', async () => {
      expect(await service.createPlan(ME, 'p-new', input)).toEqual({
        adopted: false,
      });
      expect(plans.createPlan).toHaveBeenCalledWith(
        'org-1',
        'u-me',
        expect.objectContaining({
          space_id: S_A,
          name: 'Q4',
          plan_type: 'agile',
          start_date: '2026-10-01',
        }),
        { id: 'p-new' },
      );
      // Never a status, a budget or a currency of Robert's.
      const dto = plans.createPlan.mock.calls[0][2] as Row;
      expect([dto.status, dto.budget, dto.currency]).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
    });

    it('a plan already under that id is adopted, with its creator admin row kept', async () => {
      tables.plans.push({ ...plan({ id: 'p-new' }), organization_id: 'org-1' });
      expect(await service.createPlan(ME, 'p-new', input)).toEqual({
        adopted: true,
      });
      expect(plans.createPlan).not.toHaveBeenCalled();
      expect(db.calls).toContainEqual(
        expect.objectContaining({
          table: 'plan_permissions',
          op: 'upsert',
          payload: {
            plan_id: 'p-new',
            user_id: 'u-me',
            permission_level: 'admin',
          },
        }),
      );
    });

    it('refuses without create_plans in that space', async () => {
      await expect(
        service.createPlan(ME, 'p-new', { ...input, spaceId: 's-b' }),
      ).rejects.toEqual(new AgentGovernanceError('no_create_plan'));
      expect(plans.createPlan).not.toHaveBeenCalled();
    });
  });

  describe('a new plan item', () => {
    const item = {
      name: 'Pen test done',
      description: 'Check <all>',
      itemType: 'milestone' as const,
      startDate: '2026-10-15',
      endDate: '2026-10-15',
      ownerId: ANNA,
      priority: 'high',
      estimatedHours: 4,
      estimatedCost: null,
      progress: null,
    };

    it('fractional hours are stored as whole minutes; the human call keeps its own rule (audit 2026-11-10)', async () => {
      await service.addItem(ME, 't-new', 'p1', PHASE, { ...item, itemType: 'task', estimatedHours: 1.01 });
      // 1.01 h is 60.6 minutes: estimated_time is an integer, so 61.
      expect(plans.insertPlanItemTask.mock.calls[0][5]).toEqual({ taskId: 't-new', estimatedMinutes: 61 });
    });

    it('a description is cut so its stored HTML fits the 10,000 the DTO allows', () => {
      const long = '&'.repeat(9_000);
      const fitted = fitPlanItemText(long);
      expect((planItemHtml(fitted) ?? '').length).toBeLessThanOrEqual(10_000);
      expect(fitted.length).toBeGreaterThan(1_500);
      expect(fitPlanItemText('short & sweet')).toBe('short & sweet');
    });

    it('a dated item gets its day span as duration, as the human edit does, so the Gantt bar is right', async () => {
      const dto = async (over: object) => {
        plans.insertPlanItemTask.mockClear();
        await service.addItem(ME, 't-new', 'p1', PHASE, {
          ...item,
          itemType: 'phase',
          ...over,
        });
        return plans.insertPlanItemTask.mock.calls[0][4] as Record<
          string,
          unknown
        >;
      };
      expect(
        (await dto({ startDate: '2026-12-01', endDate: '2026-12-18' }))
          .duration_days,
      ).toBe(17);
      expect(
        await dto({ startDate: '2026-12-01', endDate: null }),
      ).not.toHaveProperty('duration_days', expect.anything());
    });

    it("writes the task as a person's addItem does, then links it under the plan lock", async () => {
      expect(await service.addItem(ME, 't-new', 'p1', PHASE, item)).toEqual({
        adopted: false,
      });
      expect(plans.insertPlanItemTask).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ id: 'p1' }),
        'org-1',
        'u-me',
        expect.objectContaining({
          name: 'Pen test done',
          item_type: 'milestone',
          parent_id: PHASE,
          start_date: '2026-10-15',
          end_date: '2026-10-15',
          duration_days: 0,
          assigned_to: ANNA,
          priority: 'high',
          estimated_hours: 4,
          description: '<p>Check &lt;all&gt;</p>',
        }),
        { taskId: 't-new', estimatedMinutes: 240 },
      );
      expect(rpc).toHaveBeenCalledWith('agent_plan_item_link', {
        p_organization_id: 'org-1',
        p_plan_id: 'p1',
        p_task_id: 't-new',
        p_item_type: 'milestone',
        p_color: null,
      });
      expect(plans.auditPlanItemCreated).toHaveBeenCalledWith(
        'org-1',
        'u-me',
        't-new',
        'p1',
        'milestone',
      );
    });

    it('checks plan edit access first, and an archived plan takes nothing', async () => {
      plans.assertCanEditPlan.mockResolvedValue({
        id: 'p1',
        is_archived: true,
        status: 'archived',
      });
      await expect(
        service.addItem(ME, 't-new', 'p1', null, item),
      ).rejects.toEqual(new AgentGovernanceError('plan_archived'));
      expect(plans.insertPlanItemTask).not.toHaveBeenCalled();
      plans.assertCanEditPlan.mockRejectedValue(
        new Error('Insufficient plan permissions'),
      );
      await expect(
        service.addItem(ME, 't-new', 'p1', null, item),
      ).rejects.toThrow('Insufficient');
    });

    it('a retry adopts both halves: no second task, no second audit', async () => {
      tables.tasks.push({ id: 't-new', organization_id: 'org-1' });
      rpc.mockResolvedValue({
        data: { linked: true, adopted: true },
        error: null,
      });
      expect(await service.addItem(ME, 't-new', 'p1', null, item)).toEqual({
        adopted: true,
      });
      expect(plans.insertPlanItemTask).not.toHaveBeenCalled();
      expect(plans.auditPlanItemCreated).not.toHaveBeenCalled();
    });

    it('a task from a crashed try is linked now, the link is audited once', async () => {
      tables.tasks.push({ id: 't-new', organization_id: 'org-1' });
      await service.addItem(ME, 't-new', 'p1', null, item);
      expect(plans.insertPlanItemTask).not.toHaveBeenCalled();
      expect(rpc).toHaveBeenCalled();
      expect(plans.auditPlanItemCreated).toHaveBeenCalledTimes(1);
    });

    it("when the link fails, the new task goes again (as a person's addItem does)", async () => {
      rpc.mockResolvedValue({
        data: null,
        error: { message: 'chat: plan archived' },
      });
      await expect(
        service.addItem(ME, 't-new', 'p1', null, item),
      ).rejects.toEqual(new AgentGovernanceError('plan_archived'));
      expect(db.calls).toContainEqual(
        expect.objectContaining({ table: 'tasks', op: 'delete' }),
      );
    });
  });

  it('renumbers each plan once, and never throws', async () => {
    plans.recalculateWbs.mockRejectedValueOnce(new Error('down'));
    await service.recalculate(['p1', 'p1', 'p2']);
    expect(plans.recalculateWbs).toHaveBeenCalledTimes(2);
  });
});
