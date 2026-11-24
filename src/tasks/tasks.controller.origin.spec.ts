import { TasksController } from './tasks.controller';
import { ProcessesController } from '../processes/processes.controller';
import { WikiController } from '../wiki/wiki.controller';
import { PlansController } from '../plans/plans.controller';
import { PublicSiteStudioService } from '../site-studio/public/public-site-studio.service';

const USER = { userId: 'me', organizationId: 'org-1' };
const ORIGIN = { confirmedBy: 'Carl' };

const make = <T>(type: { prototype: object }, fields: Record<string, unknown>): T =>
  Object.assign(Object.create(type.prototype), fields) as T;

describe('the label on the routes (SEC-06)', () => {
  const origins = () => ({ forObject: jest.fn().mockResolvedValue(ORIGIN), addedToPlans: jest.fn().mockResolvedValue([]) });

  describe('tasks', () => {
    const build = () => {
      const o = origins();
      const c = make<TasksController>(TasksController, {
        service: { getByKeyForViewer: jest.fn().mockResolvedValue({ id: 't1', organization_id: 'org-1' }) },
        origins: o,
      });
      return { c, o };
    };

    it('adds it only when the screen asks', async () => {
      const { c, o } = build();
      expect(await c.getByKey(USER as never, 'A-T1')).not.toHaveProperty('robert_origin');
      expect(o.forObject).not.toHaveBeenCalled();
      expect(await c.getByKey(USER as never, 'A-T1', 'true')).toHaveProperty('robert_origin', ORIGIN);
    });

    it('stays out of the answer when the object has none', async () => {
      const { c, o } = build();
      o.forObject.mockResolvedValue(null);
      expect(await c.getByKey(USER as never, 'A-T1', 'true')).not.toHaveProperty('robert_origin');
    });

    it('adds one line per plan Robert added the task to, only when asked and only when there is one (1.22.1)', async () => {
      const { c, o } = build();
      const line = { planId: 'p1', planKey: 'A-P1', planName: 'Q4', createdAt: 'x', confirmedBy: 'Anna', source: { kind: 'private' } };
      expect(await c.getByKey(USER as never, 'A-T1', 'true')).not.toHaveProperty('robert_plan_links');
      o.addedToPlans.mockResolvedValue([line]);
      expect(await c.getByKey(USER as never, 'A-T1', 'true')).toHaveProperty('robert_plan_links', [line]);
      o.addedToPlans.mockClear();
      await c.getByKey(USER as never, 'A-T1');
      expect(o.addedToPlans).not.toHaveBeenCalled();
    });
  });

  it('processes: only when asked', async () => {
    const o = origins();
    const c = make<ProcessesController>(ProcessesController, {
      service: { getByKey: jest.fn().mockResolvedValue({ id: 'p1', organization_id: 'org-1' }) },
      origins: o,
    });
    expect(await c.getByKey(USER as never, 'A-P1')).not.toHaveProperty('robert_origin');
    expect(o.forObject).not.toHaveBeenCalled();
    expect(await c.getByKey(USER as never, 'A-P1', 'true')).toHaveProperty('robert_origin', ORIGIN);
  });

  // 1.22: the plan summary, inside the plan's data envelope; lists and MCP never ask.
  it('plans: only when asked, inside data', async () => {
    const o = origins();
    const plan = { data: { id: 'pl1', organization_id: 'org-1', name: 'Q4' } };
    const c = make<PlansController>(PlansController, {
      service: { getPlan: jest.fn().mockResolvedValue(plan) },
      origins: o,
    });
    expect(await c.getPlan(USER as never, 'pl1')).toEqual(plan);
    expect(o.forObject).not.toHaveBeenCalled();
    expect(await c.getPlan(USER as never, 'pl1', 'true')).toEqual({ data: { ...plan.data, robert_origin: ORIGIN } });
    expect(o.forObject).toHaveBeenCalledWith(USER, 'plan', plan.data);
  });

  it('wiki: only when asked', async () => {
    const o = origins();
    const c = make<WikiController>(WikiController, {
      origins: o,
      permissionsService: { assertPageAccessWithTrace: jest.fn().mockResolvedValue({}) },
      wikiService: { getPageById: jest.fn().mockResolvedValue({ id: 'w1', organization_id: 'org-1' }) },
      workflowService: { getSettings: jest.fn().mockResolvedValue({}), computeCapabilities: jest.fn().mockReturnValue({}) },
      resolvePageId: jest.fn().mockResolvedValue('w1'),
    });
    expect(await c.getById(USER as never, 's1', 'w1', {})).not.toHaveProperty('robert_origin');
    expect(o.forObject).not.toHaveBeenCalled();
    expect(await c.getById(USER as never, 's1', 'w1', { withOrigin: 'true' })).toHaveProperty('robert_origin', ORIGIN);
  });

  it('a published page says Robert drafted it and nothing about who or where', async () => {
    const isDraftedByRobert = jest.fn().mockResolvedValue(true);
    const s = make<PublicSiteStudioService>(PublicSiteStudioService, {
      origins: { isDraftedByRobert },
      getPublicSpaceContext: jest.fn().mockResolvedValue({}),
      filterAccessibleWikiPages: jest.fn(async (_u, _c, pages: unknown[]) => pages),
      assertUuid: jest.fn(),
      wikiService: {
        getPageById: jest.fn().mockResolvedValue({ id: 'w1', organization_id: 'org-from-the-page', is_published: true, title: 'T', slug: 's' }),
      },
    });
    const page = await s.getWikiPage(null, 's1', 'w1');
    expect(isDraftedByRobert).toHaveBeenCalledWith('org-from-the-page', 'wiki_page', 'w1');
    expect(page).toHaveProperty('drafted_by_robert', true);
    expect(Object.keys(page).sort()).toEqual(['content', 'content_format', 'drafted_by_robert', 'id', 'slug', 'title', 'updated_at']);
  });
});
