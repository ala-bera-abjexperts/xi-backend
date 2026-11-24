import { BadRequestException } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  PortfolioManagementLetterRepository,
  type PortfolioManagementLetterRow,
} from './portfolio-management-letter.repository';

describe('PortfolioManagementLetterRepository', () => {
  let repository: PortfolioManagementLetterRepository;
  let mockFrom: jest.Mock;

  const letter: PortfolioManagementLetterRow = {
    id: 'letter-1',
    organization_id: 'org-1',
    portfolio_id: 'portfolio-1',
    plan_id: 'plan-1',
    reporting_period_start: '2026-05-01',
    reporting_period_end: '2026-05-31',
    status: 'draft',
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
    assigned_to_user_id: 'user-1',
    due_date: '2026-06-07',
    linked_task_id: null,
    rejection_reason: null,
    submitted_at: null,
    submitted_by: null,
    approved_at: null,
    approved_by: null,
    rejected_at: null,
    rejected_by: null,
    created_by: 'user-1',
    updated_by: 'user-1',
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
  };

  function buildChain(resolved: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.update = jest.fn().mockImplementation(self);
    chain.delete = jest.fn().mockImplementation(self);
    chain.single = jest.fn().mockResolvedValue(resolved);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled);
    return chain;
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    const supabase = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;
    repository = new PortfolioManagementLetterRepository(supabase);
  });

  it('finds a letter by id', async () => {
    mockFrom.mockReturnValueOnce(buildChain({ data: letter, error: null }));

    await expect(repository.findById('letter-1')).resolves.toBe(letter);
  });

  it('lists portfolio letters with optional status filter', async () => {
    const chain = buildChain({ data: [letter], error: null });
    mockFrom.mockReturnValueOnce(chain);

    const result = await repository.findByPortfolio('portfolio-1', 'draft');

    expect(result).toEqual([letter]);
    expect(chain.eq).toHaveBeenCalledWith('portfolio_id', 'portfolio-1');
    expect(chain.eq).toHaveBeenCalledWith('status', 'draft');
  });

  it('finds an existing letter for the same plan and reporting period', async () => {
    const chain = buildChain({ data: letter, error: null });
    mockFrom.mockReturnValueOnce(chain);

    await repository.findByPlanAndPeriod(
      'portfolio-1',
      'plan-1',
      '2026-05-01',
      '2026-05-31',
    );

    expect(chain.eq).toHaveBeenCalledWith(
      'reporting_period_start',
      '2026-05-01',
    );
    expect(chain.eq).toHaveBeenCalledWith('reporting_period_end', '2026-05-31');
  });

  it('creates, updates, transitions, and deletes letters', async () => {
    const createChain = buildChain({ data: letter, error: null });
    const updateChain = buildChain({
      data: { ...letter, key_message: 'Updated' },
      error: null,
    });
    const transitionChain = buildChain({
      data: { ...letter, status: 'submitted' },
      error: null,
    });
    const deleteChain = buildChain({ data: null, error: null });
    mockFrom
      .mockReturnValueOnce(createChain)
      .mockReturnValueOnce(updateChain)
      .mockReturnValueOnce(transitionChain)
      .mockReturnValueOnce(deleteChain);

    await repository.create({ portfolio_id: 'portfolio-1' });
    await repository.update('letter-1', { key_message: 'Updated' });
    await repository.transitionStatus('letter-1', 'draft', {
      status: 'submitted',
    });
    await repository.delete('letter-1');

    expect(createChain.insert).toHaveBeenCalledWith({
      portfolio_id: 'portfolio-1',
    });
    expect(updateChain.update).toHaveBeenCalledWith({ key_message: 'Updated' });
    expect(transitionChain.eq).toHaveBeenCalledWith('status', 'draft');
    expect(deleteChain.delete).toHaveBeenCalled();
  });

  it('maps Supabase errors to BadRequestException', async () => {
    mockFrom.mockReturnValueOnce(
      buildChain({ data: null, error: { message: 'bad query' } }),
    );

    await expect(repository.findById('letter-1')).rejects.toThrow(
      BadRequestException,
    );
  });
});
