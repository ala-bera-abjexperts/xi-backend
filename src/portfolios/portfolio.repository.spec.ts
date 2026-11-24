import { BadRequestException } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { PortfolioRepository, type PortfolioRow } from './portfolio.repository';

describe('PortfolioRepository', () => {
  let repository: PortfolioRepository;
  let mockFrom: jest.Mock;

  const ORG = 'org-1';
  const portfolio: PortfolioRow = {
    id: 'portfolio-1',
    organization_id: ORG,
    portfolio_key: 'PORT-1',
    name: 'Executive Portfolio',
    description: null,
    status: 'active',
    color: '#2563EB',
    owner_id: null,
    created_by: 'user-1',
    updated_by: 'user-1',
    sort_order: 0,
    settings: {},
    is_archived: false,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
  };

  function buildChain(resolved: {
    data: unknown;
    error: unknown;
    count?: number;
  }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.ilike = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.range = jest.fn().mockImplementation(self);
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
    repository = new PortfolioRepository(supabase);
  });

  it('finds a portfolio by id', async () => {
    mockFrom.mockReturnValueOnce(buildChain({ data: portfolio, error: null }));

    await expect(repository.findById('portfolio-1')).resolves.toBe(portfolio);
  });

  it('finds a portfolio by organization and friendly key', async () => {
    const chain = buildChain({ data: portfolio, error: null });
    mockFrom.mockReturnValueOnce(chain);

    await repository.findByKey(ORG, 'PORT-1');

    expect(chain.eq).toHaveBeenCalledWith('organization_id', ORG);
    expect(chain.eq).toHaveBeenCalledWith('portfolio_key', 'PORT-1');
  });

  it('lists portfolios with filters and maps plan counts', async () => {
    const countChain = buildChain({ data: null, error: null, count: 1 });
    const dataChain = buildChain({
      data: [{ ...portfolio, portfolio_plans: [{ count: 2 }] }],
      error: null,
    });
    mockFrom.mockReturnValueOnce(countChain).mockReturnValueOnce(dataChain);

    const result = await repository.findByOrganization(ORG, {
      status: 'active',
      search: 'Executive,',
      page: 2,
      pageSize: 5,
    });

    expect(result.totalCount).toBe(1);
    expect(result.data[0].plans_count).toBe(2);
    expect(countChain.eq).toHaveBeenCalledWith('is_archived', false);
    expect(countChain.eq).toHaveBeenCalledWith('status', 'active');
    expect(countChain.ilike).toHaveBeenCalledWith('name', '%Executive%');
    expect(dataChain.range).toHaveBeenCalledWith(5, 9);
  });

  it('creates and updates portfolio rows', async () => {
    const createChain = buildChain({ data: portfolio, error: null });
    const updateChain = buildChain({
      data: { ...portfolio, name: 'Updated' },
      error: null,
    });
    mockFrom.mockReturnValueOnce(createChain).mockReturnValueOnce(updateChain);

    await repository.create({ name: 'Executive Portfolio' });
    await repository.update('portfolio-1', { name: 'Updated' });

    expect(createChain.insert).toHaveBeenCalledWith({
      name: 'Executive Portfolio',
    });
    expect(updateChain.update).toHaveBeenCalledWith({ name: 'Updated' });
    expect(updateChain.eq).toHaveBeenCalledWith('id', 'portfolio-1');
  });

  it('maps Supabase errors to BadRequestException', async () => {
    mockFrom.mockReturnValueOnce(
      buildChain({ data: null, error: { message: 'boom' } }),
    );

    await expect(repository.findById('portfolio-1')).rejects.toThrow(
      BadRequestException,
    );
  });
});
