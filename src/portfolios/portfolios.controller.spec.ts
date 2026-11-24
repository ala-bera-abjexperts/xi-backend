jest.mock('../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (value: string | null | undefined) => value ?? null,
}));

import { runControllerContractSuite } from '../test/controller-contract.helper';
import { PortfoliosController } from './portfolios.controller';
import { PortfoliosService } from './portfolios.service';

runControllerContractSuite({
  controller: PortfoliosController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});

describe('PortfoliosController manual behavior', () => {
  let controller: PortfoliosController;
  let service: jest.Mocked<PortfoliosService>;

  const user = {
    authUserId: 'auth-user-1',
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'user@example.com',
  };

  beforeEach(() => {
    service = {
      list: jest.fn(),
      create: jest.fn(),
      getById: jest.fn(),
      getByKey: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      listPlans: jest.fn(),
      addPlan: jest.fn(),
      removePlan: jest.fn(),
      getKpis: jest.fn(),
      getGanttView: jest.fn(),
      getSchedule: jest.fn(),
      setSchedule: jest.fn(),
      listLetters: jest.fn(),
      createLetter: jest.fn(),
      getLetter: jest.fn(),
      updateLetter: jest.fn(),
      deleteLetter: jest.fn(),
      submitLetter: jest.fn(),
      approveLetter: jest.fn(),
      rejectLetter: jest.fn(),
    } as unknown as jest.Mocked<PortfoliosService>;
    controller = new PortfoliosController(service);
  });

  it('lists portfolios with normalized query filters', async () => {
    await controller.list(user, 'active', 'Executive', true, 2, 25);

    const list = (service as unknown as Record<string, jest.Mock>)['list'];
    expect(list).toHaveBeenCalledWith('org-1', {
      status: 'active',
      search: 'Executive',
      include_archived: true,
      page: 2,
      pageSize: 25,
    });
  });

  it('creates portfolios with organization and user context', async () => {
    const dto = { name: 'Executive Portfolio', status: 'active' as const };

    await controller.create(user, dto);

    const create = (service as unknown as Record<string, jest.Mock>)['create'];
    expect(create).toHaveBeenCalledWith('org-1', 'user-1', dto);
  });

  it('passes route identifiers to plan membership methods', async () => {
    await controller.addPlan(user, 'portfolio-1', { plan_id: 'plan-1' });
    await controller.removePlan(user, 'portfolio-1', 'plan-1');

    const addPlan = (service as unknown as Record<string, jest.Mock>)[
      'addPlan'
    ];
    const removePlan = (service as unknown as Record<string, jest.Mock>)[
      'removePlan'
    ];
    expect(addPlan).toHaveBeenCalledWith('org-1', 'user-1', 'portfolio-1', {
      plan_id: 'plan-1',
    });
    expect(removePlan).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      'portfolio-1',
      'plan-1',
    );
  });

  it('routes dashboard and gantt requests through the user context', async () => {
    await controller.getDashboard(user, 'portfolio-1');
    await controller.getGantt(user, 'portfolio-1');

    const getKpis = (service as unknown as Record<string, jest.Mock>)[
      'getKpis'
    ];
    const getGanttView = (service as unknown as Record<string, jest.Mock>)[
      'getGanttView'
    ];
    expect(getKpis).toHaveBeenCalledWith('org-1', 'user-1', 'portfolio-1');
    expect(getGanttView).toHaveBeenCalledWith('org-1', 'user-1', 'portfolio-1');
  });

  it('passes management-letter workflow actions to the service', async () => {
    await controller.createLetter(user, 'portfolio-1', {
      plan_id: 'plan-1',
      reporting_period_start: '2026-05-01',
      reporting_period_end: '2026-05-31',
    });
    await controller.updateLetter(user, 'portfolio-1', 'letter-1', {
      key_message: 'Updated',
    });
    await controller.submitLetter(user, 'portfolio-1', 'letter-1');
    await controller.approveLetter(user, 'portfolio-1', 'letter-1');
    await controller.rejectLetter(user, 'portfolio-1', 'letter-1', {
      reason: 'Needs owner',
    });

    const svcMock = service as unknown as Record<string, jest.Mock>;
    expect(svcMock['createLetter']).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      'portfolio-1',
      expect.objectContaining({ plan_id: 'plan-1' }),
    );
    expect(svcMock['updateLetter']).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      'portfolio-1',
      'letter-1',
      { key_message: 'Updated' },
    );
    expect(svcMock['submitLetter']).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      'portfolio-1',
      'letter-1',
    );
    expect(svcMock['approveLetter']).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      'portfolio-1',
      'letter-1',
    );
    expect(svcMock['rejectLetter']).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      'portfolio-1',
      'letter-1',
      { reason: 'Needs owner' },
    );
  });
});
