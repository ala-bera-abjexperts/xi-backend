import { BadRequestException, ConflictException } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  PortfolioPlanRepository,
  type PortfolioPlanRow,
} from './portfolio-plan.repository';

describe('PortfolioPlanRepository', () => {
  let repository: PortfolioPlanRepository;
  let mockFrom: jest.Mock;

  const row: PortfolioPlanRow = {
    id: 'portfolio-plan-1',
    portfolio_id: 'portfolio-1',
    plan_id: 'plan-1',
    sort_order: 0,
    included_at: '2026-05-01T00:00:00Z',
    included_by: 'user-1',
  };

  function buildChain(resolved: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
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
    repository = new PortfolioPlanRepository(supabase);
  });

  it('adds a plan to a portfolio and returns the junction row', async () => {
    const chain = buildChain({ data: row, error: null });
    mockFrom.mockReturnValueOnce(chain);

    const result = await repository.addPlan('portfolio-1', 'plan-1', 'user-1');

    expect(result).toBe(row);
    expect(chain.insert).toHaveBeenCalledWith({
      portfolio_id: 'portfolio-1',
      plan_id: 'plan-1',
      included_by: 'user-1',
    });
  });

  it('maps unique-constraint errors to ConflictException', async () => {
    mockFrom.mockReturnValueOnce(
      buildChain({
        data: null,
        error: { code: '23505', message: 'duplicate' },
      }),
    );

    await expect(
      repository.addPlan('portfolio-1', 'plan-1', 'user-1'),
    ).rejects.toThrow(ConflictException);
  });

  it('returns the real junction uuid when removing a plan', async () => {
    const findChain = buildChain({ data: row, error: null });
    const deleteChain = buildChain({ data: null, error: null });
    mockFrom.mockReturnValueOnce(findChain).mockReturnValueOnce(deleteChain);

    const removed = await repository.removePlan('portfolio-1', 'plan-1');

    expect(removed.id).toBe('portfolio-plan-1');
    expect(deleteChain.delete).toHaveBeenCalled();
    expect(deleteChain.eq).toHaveBeenCalledWith('portfolio_id', 'portfolio-1');
    expect(deleteChain.eq).toHaveBeenCalledWith('plan_id', 'plan-1');
  });

  it('rejects removal when the plan is not in the portfolio', async () => {
    mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));

    await expect(
      repository.removePlan('portfolio-1', 'plan-1'),
    ).rejects.toThrow(BadRequestException);
  });

  it('filters out orphaned plan joins when listing portfolio plans', async () => {
    mockFrom.mockReturnValueOnce(
      buildChain({
        data: [
          {
            ...row,
            plan: {
              id: 'plan-1',
              organization_id: 'org-1',
              space_id: 'space-1',
              plan_key: 'P1',
              name: 'Plan',
            },
          },
          { ...row, id: 'orphan', plan: null },
        ],
        error: null,
      }),
    );

    const result = await repository.findByPortfolio('portfolio-1');

    expect(result).toHaveLength(1);
    expect(result[0].junction.id).toBe('portfolio-plan-1');
  });

  it('checks whether a plan already exists in a portfolio', async () => {
    mockFrom.mockReturnValueOnce(
      buildChain({ data: { id: row.id }, error: null }),
    );

    await expect(repository.exists('portfolio-1', 'plan-1')).resolves.toBe(
      true,
    );
  });
});
