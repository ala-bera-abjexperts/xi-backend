jest.mock('../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (value: string | null | undefined) => value ?? null,
}));

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { PermissionsService } from '../permissions/permissions.service';
import { PlansService } from '../plans/plans.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { TasksService } from '../tasks/tasks.service';
import { PortfolioManagementLetterRepository } from './portfolio-management-letter.repository';
import {
  PortfolioPlanRepository,
  type PlanRow,
} from './portfolio-plan.repository';
import { PortfolioRepository, type PortfolioRow } from './portfolio.repository';
import { PortfoliosService } from './portfolios.service';

describe('PortfoliosService', () => {
  let service: PortfoliosService;
  let mockFrom: jest.Mock;
  let portfolioRepo: jest.Mocked<PortfolioRepository>;
  let portfolioPlanRepo: jest.Mocked<PortfolioPlanRepository>;
  let letterRepo: jest.Mocked<PortfolioManagementLetterRepository>;
  let auditLogs: jest.Mocked<AuditLogsService>;
  let plansService: jest.Mocked<PlansService>;
  let tasksService: jest.Mocked<TasksService>;
  let permissionsService: jest.Mocked<PermissionsService>;
  let configService: jest.Mocked<ConfigService>;

  const ORG = 'org-1';
  const USER = 'user-1';
  const SPACE = 'space-1';
  const PORTFOLIO = 'portfolio-1';
  const PLAN = 'plan-1';
  const LETTER = 'letter-1';

  const portfolio: PortfolioRow = {
    id: PORTFOLIO,
    organization_id: ORG,
    portfolio_key: 'PORT-1',
    name: 'Executive Portfolio',
    description: null,
    status: 'active',
    color: '#2563EB',
    owner_id: null,
    created_by: USER,
    updated_by: USER,
    sort_order: 0,
    settings: {},
    is_archived: false,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
  };

  const plan: PlanRow = {
    id: PLAN,
    organization_id: ORG,
    space_id: SPACE,
    plan_key: 'DEF-P1',
    name: 'Delivery Plan',
    owner_id: USER,
    created_by: USER,
    progress: 40,
    is_archived: false,
    rag_status: 'unknown',
    rag_set_manually: false,
    budget: 1000,
    currency: 'EUR',
  };

  const letter = {
    id: LETTER,
    organization_id: ORG,
    portfolio_id: PORTFOLIO,
    plan_id: PLAN,
    reporting_period_start: '2026-05-01',
    reporting_period_end: '2026-05-31',
    status: 'draft' as const,
    rag_schedule: 'amber',
    rag_budget: 'green',
    rag_quality: 'green',
    key_message: 'On track',
    milestones_achieved: [],
    success_factors: null,
    planned_vs_actual: {},
    next_steps: [],
    budget_consumption_percent: null,
    resource_availability: null,
    identified_risks: [],
    blockers: [],
    assigned_to_user_id: USER,
    due_date: '2026-06-07',
    linked_task_id: 'task-1',
    rejection_reason: null,
    submitted_at: null,
    submitted_by: null,
    approved_at: null,
    approved_by: null,
    rejected_at: null,
    rejected_by: null,
    created_by: USER,
    updated_by: USER,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
  };

  function buildChain(resolved: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled);
    return chain;
  }

  function moduleEnabled() {
    mockFrom.mockReturnValueOnce(
      buildChain({ data: { is_enabled: true }, error: null }),
    );
  }

  function orgOwner() {
    mockFrom.mockReturnValueOnce(
      buildChain({ data: { role: 'owner' }, error: null }),
    );
  }

  function planLookup() {
    mockFrom.mockReturnValueOnce(buildChain({ data: plan, error: null }));
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    const supabase = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;
    portfolioRepo = {
      findByOrganization: jest.fn(),
      create: jest.fn(),
      findById: jest.fn(),
      findByKey: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    } as unknown as jest.Mocked<PortfolioRepository>;
    portfolioPlanRepo = {
      findByPortfolio: jest.fn(),
      findByPortfolioWithSpaces: jest.fn(),
      addPlan: jest.fn(),
      removePlan: jest.fn(),
      exists: jest.fn(),
    } as unknown as jest.Mocked<PortfolioPlanRepository>;
    letterRepo = {
      findByPortfolio: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findById: jest.fn(),
      findByPlanAndPeriod: jest.fn(),
      transitionStatus: jest.fn(),
    } as unknown as jest.Mocked<PortfolioManagementLetterRepository>;
    auditLogs = {
      logAction: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AuditLogsService>;
    plansService = {
      getEvmMetrics: jest.fn().mockResolvedValue(null),
      // Letter derivation reads plan items/risks; empty by default.
      listItems: jest.fn().mockResolvedValue({ data: [] }),
      listRisks: jest.fn().mockResolvedValue([]),
      hydratePlanProgress: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<PlansService>;
    tasksService = {
      create: jest.fn().mockResolvedValue({ id: 'task-1' }),
      update: jest.fn().mockResolvedValue({ id: 'task-1' }),
      delete: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<TasksService>;
    permissionsService = {
      checkPermission: jest.fn().mockResolvedValue(false),
    } as unknown as jest.Mocked<PermissionsService>;
    configService = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as jest.Mocked<ConfigService>;
    service = new PortfoliosService(
      supabase,
      portfolioRepo,
      portfolioPlanRepo,
      letterRepo,
      auditLogs,
      plansService,
      tasksService,
      permissionsService,
      configService,
    );
  });

  it('blocks portfolio operations when the organization module is disabled', async () => {
    mockFrom.mockReturnValueOnce(
      buildChain({ data: { is_enabled: false }, error: null }),
    );

    await expect(service.list(ORG, {})).rejects.toThrow(ForbiddenException);
  });

  it('creates a portfolio with organization/user fields and logs audit', async () => {
    moduleEnabled();
    portfolioRepo.create.mockResolvedValue(portfolio);

    const result = await service.create(ORG, USER, {
      name: 'Executive Portfolio',
      status: 'active',
    });

    expect(result).toBe(portfolio);
    const _createMock = (portfolioRepo as unknown as Record<string, jest.Mock>)[
      'create'
    ];
    expect(_createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: ORG,
        created_by: USER,
        updated_by: USER,
        name: 'Executive Portfolio',
        status: 'active',
      }),
    );
    const _logActionMock = (auditLogs as unknown as Record<string, jest.Mock>)[
      'logAction'
    ];
    expect(_logActionMock).toHaveBeenCalledWith(
      ORG,
      USER,
      'portfolio',
      PORTFOLIO,
      'create',
      { name: portfolio.name, portfolio_key: portfolio.portfolio_key },
    );
  });

  it('enforces organization scope when getting a portfolio', async () => {
    moduleEnabled();
    portfolioRepo.findById.mockResolvedValue({
      ...portfolio,
      organization_id: 'other-org',
    });

    await expect(service.getById(ORG, PORTFOLIO)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('archives by default and hard deletes when requested', async () => {
    moduleEnabled();
    portfolioRepo.findById.mockResolvedValueOnce(portfolio);
    portfolioRepo.update.mockResolvedValueOnce({
      ...portfolio,
      is_archived: true,
    });

    await service.delete(ORG, USER, PORTFOLIO);

    const _updateMock = (portfolioRepo as unknown as Record<string, jest.Mock>)[
      'update'
    ];
    expect(_updateMock).toHaveBeenCalledWith(PORTFOLIO, {
      is_archived: true,
      updated_by: USER,
    });
    const _logActionMock = (auditLogs as unknown as Record<string, jest.Mock>)[
      'logAction'
    ];
    expect(_logActionMock).toHaveBeenCalledWith(
      ORG,
      USER,
      'portfolio',
      PORTFOLIO,
      'archive',
      { portfolio_key: portfolio.portfolio_key },
    );

    moduleEnabled();
    portfolioRepo.findById.mockResolvedValueOnce(portfolio);
    await service.delete(ORG, USER, PORTFOLIO, true);

    const _deleteMock = (portfolioRepo as unknown as Record<string, jest.Mock>)[
      'delete'
    ];
    expect(_deleteMock).toHaveBeenCalledWith(PORTFOLIO);
  });

  it('adds a plan only after organization and space access checks', async () => {
    moduleEnabled();
    portfolioRepo.findById.mockResolvedValue(portfolio);
    planLookup();
    orgOwner();
    portfolioPlanRepo.addPlan.mockResolvedValue({
      id: 'portfolio-plan-1',
      portfolio_id: PORTFOLIO,
      plan_id: PLAN,
      sort_order: 0,
      included_at: '2026-05-01T00:00:00Z',
      included_by: USER,
    });

    const result = await service.addPlan(ORG, USER, PORTFOLIO, {
      plan_id: PLAN,
    });

    expect(result.id).toBe('portfolio-plan-1');
    const _logActionMock = (auditLogs as unknown as Record<string, jest.Mock>)[
      'logAction'
    ];
    expect(_logActionMock).toHaveBeenCalledWith(
      ORG,
      USER,
      'portfolio_plan',
      'portfolio-plan-1',
      'create',
      { portfolio_id: PORTFOLIO, plan_id: PLAN },
    );
  });

  it('uses the real portfolio_plans UUID when auditing removePlan', async () => {
    moduleEnabled();
    portfolioRepo.findById.mockResolvedValue(portfolio);
    planLookup();
    orgOwner();
    portfolioPlanRepo.removePlan.mockResolvedValue({
      id: 'portfolio-plan-1',
      portfolio_id: PORTFOLIO,
      plan_id: PLAN,
      sort_order: 0,
      included_at: '2026-05-01T00:00:00Z',
      included_by: USER,
    });

    await service.removePlan(ORG, USER, PORTFOLIO, PLAN);

    const _logActionMock = (auditLogs as unknown as Record<string, jest.Mock>)[
      'logAction'
    ];
    expect(_logActionMock).toHaveBeenCalledWith(
      ORG,
      USER,
      'portfolio_plan',
      'portfolio-plan-1',
      'delete',
      { portfolio_id: PORTFOLIO, plan_id: PLAN },
    );
  });

  it('filters inaccessible and archived plans from KPI dashboard', async () => {
    moduleEnabled();
    portfolioRepo.findById.mockResolvedValue(portfolio);
    portfolioPlanRepo.findByPortfolio.mockResolvedValue([
      { junction: {} as never, plan },
      {
        junction: {} as never,
        plan: { ...plan, id: 'archived', is_archived: true },
      },
      {
        junction: {} as never,
        plan: { ...plan, id: 'other-org', organization_id: 'other' },
      },
    ]);
    orgOwner();
    plansService.getEvmMetrics.mockResolvedValueOnce({
      schedule_performance_index: 0.9,
      cost_performance_index: 0.8,
    });

    const result = await service.getKpis(ORG, USER, PORTFOLIO);

    expect(result.totalPlans).toBe(1);
    expect(result.red).toBe(1);
  });

  it('rejects invalid management-letter reporting periods', async () => {
    moduleEnabled();
    portfolioRepo.findById.mockResolvedValue(portfolio);

    await expect(
      service.createLetter(ORG, USER, PORTFOLIO, {
        plan_id: PLAN,
        reporting_period_start: '2026-05-31',
        reporting_period_end: '2026-05-01',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rolls back a draft letter if linked task creation fails', async () => {
    moduleEnabled();
    portfolioRepo.findById.mockResolvedValue(portfolio);
    planLookup();
    orgOwner();
    portfolioPlanRepo.exists.mockResolvedValue(true);
    mockFrom
      .mockReturnValueOnce(
        buildChain({ data: { is_enabled: true }, error: null }),
      )
      .mockReturnValueOnce(
        buildChain({
          data: { config: { levels: [{ id: 'task', is_active: true }] } },
          error: null,
        }),
      );
    letterRepo.findByPlanAndPeriod.mockResolvedValue(null);
    letterRepo.create.mockResolvedValue({ ...letter, linked_task_id: null });
    tasksService.create.mockRejectedValue(new Error('task create failed'));
    letterRepo.delete.mockResolvedValue(undefined);

    await expect(
      service.createLetter(ORG, USER, PORTFOLIO, {
        plan_id: PLAN,
        reporting_period_start: '2026-05-01',
        reporting_period_end: '2026-05-31',
      }),
    ).rejects.toThrow('task create failed');
    const _deleteMock = (letterRepo as unknown as Record<string, jest.Mock>)[
      'delete'
    ];
    expect(_deleteMock).toHaveBeenCalledWith(LETTER);
  });

  it('submits a draft letter only for the assignee and marks the linked task done', async () => {
    moduleEnabled();
    portfolioRepo.findById.mockResolvedValue(portfolio);
    letterRepo.findById.mockResolvedValue(letter);
    planLookup();
    orgOwner();
    letterRepo.transitionStatus.mockResolvedValue({
      ...letter,
      status: 'submitted',
    });

    const result = await service.submitLetter(ORG, USER, PORTFOLIO, LETTER);

    expect(result.status).toBe('submitted');
    const _updateMock = (tasksService as unknown as Record<string, jest.Mock>)[
      'update'
    ];
    expect(_updateMock).toHaveBeenCalledWith('task-1', ORG, USER, {
      status: 'done',
    });
  });

  it('blocks updates to approved letters', async () => {
    moduleEnabled();
    portfolioRepo.findById.mockResolvedValue(portfolio);
    letterRepo.findById.mockResolvedValue({ ...letter, status: 'approved' });
    planLookup();
    orgOwner();

    await expect(
      service.updateLetter(ORG, USER, PORTFOLIO, LETTER, {
        key_message: 'Nope',
      }),
    ).rejects.toThrow(BadRequestException);
  });
});
