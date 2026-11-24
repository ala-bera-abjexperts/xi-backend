/**
 * Robert 1.22: the small rules that put plans and plan items in the right place and order, and who
 * may undo a plan. Each line here is a rule a card or a Confirm depends on.
 */
import { AgentGovernanceService } from './agent-governance.service';
import { AgentUndoRulesService } from './agent-undo-rules.service';
import {
  parentsFirst,
  planHomes,
  oneLinkPerTask,
  planNotes,
  processOwner,
  proposalLine,
  withoutEarlierTasks,
} from './agent-run-worker.service';
import {
  entityOf,
  isContainerKind,
  permOf,
  rankOf,
  tableOf,
} from './pipeline/agent-kinds';
import { agentPlanSchema } from './pipeline/agent-schemas';

type Item = Parameters<typeof planHomes>[0][number];
const person = { said: null, participant: null, is_requester: false };
const it0 = (ref: string, kind: string, over: Partial<Item> = {}) =>
  ({
    ref,
    kind,
    title: ref,
    space: null,
    plan: null,
    plan_ref: null,
    parent: { item: null, key: null, said: null },
    assignee: person,
    owner: person,
    ...over,
  }) as unknown as Item;

describe('plans and plan items: wiring (1.22)', () => {
  it('kinds: a plan is its own object and a container; an item is a task', () => {
    expect([entityOf('plan'), tableOf('plan'), permOf('plan')]).toEqual([
      'plan',
      'plans',
      'create_plans',
    ]);
    expect([entityOf('plan_link'), tableOf('plan_link'), permOf('plan_link')]).toEqual(['plan_link', 'plan_tasks', 'edit_plans']);
    expect([entityOf('plan_item'), tableOf('plan_item')]).toEqual([
      'task',
      'tasks',
    ]);
    expect(isContainerKind('plan')).toBe(true);
    expect(rankOf('plan')).toBeLessThan(rankOf('plan_item'));
  });

  it('an item goes in the plan of this answer it names, or the only one; never in another', () => {
    const homes = planHomes([
      it0('i1', 'plan'),
      it0('i2', 'plan_item'),
      it0('i3', 'plan_item', { plan: 'Existing plan' }),
    ]);
    expect(homes.get('i2')).toBe('i1');
    expect(homes.has('i3')).toBe(false);

    const two = planHomes([
      it0('i1', 'plan'),
      it0('i2', 'plan'),
      it0('i3', 'plan_item', { plan_ref: 'i2' }),
      it0('i4', 'plan_item'),
    ]);
    expect(two.get('i3')).toBe('i2');
    expect(two.has('i4')).toBe(false);
  });

  it('a new space with a plan of the same request gets its plans module switched on', async () => {
    const spaces = {
      createSpace: jest.fn().mockResolvedValue({}),
      updateSpaceModules: jest.fn().mockResolvedValue({}),
    };
    const governance = Object.assign(
      Object.create(AgentGovernanceService.prototype),
      {
        spaces,
        permissions: { bustOrg: jest.fn() },
        logger: { warn: jest.fn() },
        rowExists: jest.fn().mockResolvedValue(false),
        canCreateSpaces: jest.fn().mockResolvedValue(true),
      },
    );
    await governance.createSpace(
      { userId: 'me', organizationId: 'org-1' },
      'sp1',
      {
        name: 'Launch',
        key: 'LAUNCH',
        description: null,
        enableWiki: false,
        enablePlans: true,
      },
    );
    expect(spaces.updateSpaceModules).toHaveBeenCalledWith(
      'sp1',
      'me',
      'org-1',
      [{ module_type: 'plans', is_enabled: true }],
    );
  });

  it('a space adopted after a crash gets what the crash left out: its owner and its modules (audit 2026-11-10)', async () => {
    const spaces = { createSpace: jest.fn(), updateSpaceModules: jest.fn().mockResolvedValue({}) };
    const inserted: unknown[] = [];
    const from = (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) q[m] = () => q;
      q.maybeSingle = () => Promise.resolve({ data: null, error: null });
      q.insert = (row: unknown) => (inserted.push([table, row]), Promise.resolve({ error: null }));
      return q;
    };
    const governance = Object.assign(Object.create(AgentGovernanceService.prototype), {
      supabaseAdmin: { getClient: () => ({ from }) },
      spaces,
      permissions: { bustOrg: jest.fn() },
      logger: { warn: jest.fn() },
      rowExists: jest.fn().mockResolvedValue(true),
      canCreateSpaces: jest.fn().mockResolvedValue(true),
    });
    const out = await governance.createSpace({ userId: 'me', organizationId: 'org-1' }, 'sp1', {
      name: 'Launch',
      key: 'LAUNCH',
      description: null,
      enableWiki: true,
      enablePlans: true,
    });
    expect(out).toEqual({ adopted: true });
    expect(spaces.createSpace).not.toHaveBeenCalled();
    expect(inserted).toEqual([
      ['space_members', expect.objectContaining({ space_id: 'sp1', user_id: 'me', space_role: 'owner', is_active: true })],
    ]);
    expect(spaces.updateSpaceModules).toHaveBeenCalledWith('sp1', 'me', 'org-1', [
      { module_type: 'wiki', is_enabled: true },
      { module_type: 'plans', is_enabled: true },
    ]);
  });

  it('a plan and its items in a new space all go in that space', () => {
    const homes = planHomes([
      it0('i1', 'space'),
      it0('i2', 'plan'),
      it0('i3', 'plan_item'),
    ]);
    expect(homes.get('i2')).toBe('i1');
    expect(homes.get('space:i3')).toBe('i1');
  });

  it('items are created parents first, whatever order the model wrote them in', () => {
    const out = parentsFirst([
      it0('i3', 'plan_item', { parent: { item: 'i2', key: null, said: null } }),
      it0('i2', 'plan_item', { parent: { item: 'i1', key: null, said: null } }),
      it0('i1', 'plan_item'),
    ]);
    expect(out.map((i) => i.ref)).toEqual(['i1', 'i2', 'i3']);
  });

  it('any child is placed after its parent: a subtask the model listed first keeps its task (audit 2026-11-10)', () => {
    const out = parentsFirst([
      it0('i2', 'subtask', { parent: { item: 'i1', key: null, said: null } }),
      it0('i3', 'task'),
      it0('i1', 'task'),
    ]);
    expect(out.map((i) => i.ref)).toEqual(['i1', 'i2', 'i3']);
    // A parent that is not in the answer, or a loop, changes nothing.
    expect(
      parentsFirst([
        it0('a', 'subtask', { parent: { item: 'b', key: null, said: null } }),
        it0('b', 'subtask', { parent: { item: 'a', key: null, said: null } }),
        it0('c', 'subtask', { parent: { item: 'zz', key: null, said: null } }),
      ]).map((i) => i.ref),
    ).toEqual(['b', 'a', 'c']);
  });

  it('the owner of a plan or an item is its assignee on the card', () => {
    const owner = { said: 'Krishna', participant: null, is_requester: false };
    expect(processOwner(it0('i1', 'plan', { owner }))).toBe(owner);
    expect(processOwner(it0('i1', 'plan_item', { owner }))).toBe(owner);
  });

  it('says plainly what stays out (1.22.1): removing dependencies, lag days, moving between plans', () => {
    // Dependencies and existing tasks are what 1.22.1 does: no "can't" line for them any more.
    expect(planNotes('add Pentest, it starts after Hardening', 'en')).toEqual([]);
    expect(planNotes('add AMBER-T12 to the Q4 plan', 'en')).toEqual([]);
    expect(planNotes('remove the dependency between Build and Test', 'en')[0]).toMatch(/don't remove existing dependencies/);
    expect(planNotes('Test starts 3 days lag after Build', 'en')[0]).toMatch(/lag or lead days/);
    expect(planNotes('verschiebe AMBER-T3 in den Q4 Plan', 'de')[0]).toMatch(/verschiebe ich nicht/);
  });

  it('one card per existing task and plan, however often it is named (1.22.1)', () => {
    const l = (ref: string, key: string, plan: string | null = 'Q4') => ({ ref, kind: 'plan_link', task: { key, said: null }, plan, plan_ref: null });
    const out = oneLinkPerTask([l('i1', 'AMBER-T9'), l('i2', 'amber-t9'), l('i3', 'AMBER-T9', 'Other'), l('i4', 'AMBER-T10')]);
    expect(out.intents.map((i) => i.ref)).toEqual(['i1', 'i3', 'i4']);
    expect(out.dropped).toBe(1);
  });

  it('a link goes in the plan of this answer, and waits for it', () => {
    const homes = planHomes([it0('i1', 'plan'), it0('i2', 'plan_link')]);
    expect(homes.get('i2')).toBe('i1');
  });

  it('the lead-in never calls plan cards tasks', () => {
    expect(proposalLine(['plan', 'plan_item', 'plan_item'], 'en')).toBe(
      'Here are my proposals, please check and confirm them.',
    );
  });

  it('"create the rest" leaves out the items already proposed or created', () => {
    const plan = agentPlanSchema.parse({
      reply: '',
      reply_language: 'en',
      object_language: 'en',
      context: { action: 'ok', n: null, since: null },
      intents: [
        {
          ...it0('i1', 'plan_item'),
          title: 'Build',
          description: null,
          sources: [],
          type: null,
          status: null,
          priority: { said: null, level: 'none' },
          due: { said: null, iso: null },
          labels: [],
          asset_type: [],
          facts: [],
          parent_page: null,
          body: [],
          milestone: false,
          start: { said: null, iso: null },
          end: { said: null, iso: null },
        },
        {
          ...it0('i2', 'plan_item'),
          title: 'Test',
          description: null,
          sources: [],
          type: null,
          status: null,
          priority: { said: null, level: 'none' },
          due: { said: null, iso: null },
          labels: [],
          asset_type: [],
          facts: [],
          parent_page: null,
          body: [],
          milestone: false,
          start: { said: null, iso: null },
          end: { said: null, iso: null },
        },
      ],
      more_items: false,
      unsupported: 'none',
    });
    const out = withoutEarlierTasks(plan, 'create the rest', [
      { title: 'Build' },
    ]);
    expect(out.intents.map((i) => i.title)).toEqual(['Test']);
  });

  it('the schema reads the new fields, and old answers without them still parse', () => {
    const base = {
      ref: 'i1',
      kind: 'plan_item',
      title: 'x',
      description: null,
      sources: [],
      space: null,
      type: null,
      status: null,
      priority: { said: null, level: 'none' },
      assignee: person,
      due: { said: null, iso: null },
      labels: [],
      parent: { item: null, key: null, said: null },
      asset_type: [],
      facts: [],
      owner: person,
      parent_page: null,
      body: [],
      plan: 'Q4',
      milestone: false,
      start: { said: null, iso: null },
      end: { said: null, iso: null },
    };
    const wrap = (intent: object) =>
      agentPlanSchema.parse({
        reply: '',
        reply_language: 'en',
        object_language: 'en',
        context: { action: 'ok', n: null, since: null },
        intents: [intent],
        more_items: false,
        unsupported: 'none',
      });
    expect(
      wrap({
        ...base,
        item_type: 'phase',
        estimated_hours: 3,
        progress: 'lots',
      }).intents[0],
    ).toMatchObject({
      item_type: 'phase',
      estimated_hours: 3,
      progress: null,
    });
    expect(wrap(base).intents[0].plan).toBe('Q4');
  });

  it('who may undo a plan: the human delete level, asked now', async () => {
    const from = () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.maybeSingle = () =>
        Promise.resolve({ data: { space_id: 's1' }, error: null });
      return q;
    };
    const plans = {
      planById: jest.fn().mockResolvedValue({ id: 'p1' }),
      canDelete: jest.fn().mockResolvedValue(false),
    };
    const rules = new AgentUndoRulesService(
      { getClient: () => ({ from }) } as never,
      {} as never,
      undefined,
      plans as never,
    );
    const me = { userId: 'me', organizationId: 'org-1' } as never;
    await expect(
      rules.mayDelete(me, {
        kind: 'plan',
        entity_id: 'p1',
        organization_id: 'org-1',
      }),
    ).resolves.toBe(false);
    plans.canDelete.mockResolvedValue(true);
    await expect(
      rules.mayDelete(me, {
        kind: 'plan',
        entity_id: 'p1',
        organization_id: 'org-1',
      }),
    ).resolves.toBe(true);
    expect(plans.canDelete).toHaveBeenCalledWith(me, { id: 'p1' });
  });
});
