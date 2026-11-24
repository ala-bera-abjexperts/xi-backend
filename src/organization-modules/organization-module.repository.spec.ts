import { BadRequestException } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { OrganizationModuleRepository } from './organization-module.repository';

describe('OrganizationModuleRepository', () => {
  let repository: OrganizationModuleRepository;
  let mockFrom: jest.Mock;

  const ORG = 'org-1';
  const USER = 'user-1';
  const row = {
    id: 'module-1',
    organization_id: ORG,
    module_type: 'portfolio',
    is_enabled: true,
    settings: {},
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
    chain.order = jest.fn().mockImplementation(self);
    chain.upsert = jest.fn().mockImplementation(self);
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
    repository = new OrganizationModuleRepository(supabase);
  });

  it('lists module rows for the current organization', async () => {
    const chain = buildChain({ data: [row], error: null });
    mockFrom.mockReturnValueOnce(chain);

    const result = await repository.listForOrg(ORG);

    expect(result).toEqual([row]);
    expect(mockFrom).toHaveBeenCalledWith('organization_modules');
    expect(chain.eq).toHaveBeenCalledWith('organization_id', ORG);
    expect(chain.order).toHaveBeenCalledWith('module_type', {
      ascending: true,
    });
  });

  it('returns null when a module row does not exist', async () => {
    mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));

    await expect(repository.getModule(ORG, 'portfolio')).resolves.toBeNull();
  });

  it('upserts module state with audit user fields', async () => {
    const chain = buildChain({ data: row, error: null });
    mockFrom.mockReturnValueOnce(chain);

    const result = await repository.upsert(ORG, 'portfolio', true, USER);

    expect(result).toBe(row);
    expect(chain.upsert).toHaveBeenCalledWith(
      {
        organization_id: ORG,
        module_type: 'portfolio',
        is_enabled: true,
        created_by: USER,
        updated_by: USER,
      },
      { onConflict: 'organization_id,module_type' },
    );
  });

  it('maps Supabase errors to BadRequestException', async () => {
    mockFrom.mockReturnValueOnce(
      buildChain({ data: null, error: { message: 'database unavailable' } }),
    );

    await expect(repository.listForOrg(ORG)).rejects.toThrow(
      BadRequestException,
    );
  });
});
