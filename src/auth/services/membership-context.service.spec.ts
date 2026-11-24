import { ServiceUnavailableException } from '@nestjs/common';
import { MembershipContextService } from './membership-context.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';

describe('MembershipContextService', () => {
  let service: MembershipContextService;
  let orderMock: jest.Mock;
  let supabaseAdmin: SupabaseAdminService;

  // Builds the chainable Supabase query mock whose terminal `.order(...)`
  // resolves to the given { data, error }.
  const wireQuery = (result: { data: unknown; error: unknown }) => {
    orderMock = jest.fn().mockResolvedValue(result);
    const eq = jest.fn().mockReturnValue({ order: orderMock });
    const select = jest.fn().mockReturnValue({ eq });
    const from = jest.fn().mockReturnValue({ select });

    supabaseAdmin = {
      getClient: jest.fn().mockReturnValue({ from }),
    } as unknown as SupabaseAdminService;

    return { from, select, eq };
  };

  it('maps rows and denormalises the org slug (single-object join)', async () => {
    wireQuery({
      data: [
        {
          organization_id: 'org-1',
          role: 'owner',
          organizations: { slug: 'acme', is_active: true },
        },
      ],
      error: null,
    });
    service = new MembershipContextService(supabaseAdmin);

    const result = await service.loadMemberships('user-1');

    expect(result).toEqual([
      { organizationId: 'org-1', organizationSlug: 'acme', role: 'owner' },
    ]);
  });

  it('handles the array-shaped join and preserves order', async () => {
    wireQuery({
      data: [
        {
          organization_id: 'org-1',
          role: 'member',
          organizations: [{ slug: 'first', is_active: true }],
        },
        {
          organization_id: 'org-2',
          role: 'viewer',
          organizations: [{ slug: 'second', is_active: true }],
        },
      ],
      error: null,
    });
    service = new MembershipContextService(supabaseAdmin);

    const result = await service.loadMemberships('user-1');

    expect(result).toEqual([
      { organizationId: 'org-1', organizationSlug: 'first', role: 'member' },
      { organizationId: 'org-2', organizationSlug: 'second', role: 'viewer' },
    ]);
  });

  it('drops deactivated organizations', async () => {
    wireQuery({
      data: [
        {
          organization_id: 'org-active',
          role: 'admin',
          organizations: { slug: 'active', is_active: true },
        },
        {
          organization_id: 'org-dead',
          role: 'admin',
          organizations: { slug: 'dead', is_active: false },
        },
      ],
      error: null,
    });
    service = new MembershipContextService(supabaseAdmin);

    const result = await service.loadMemberships('user-1');

    expect(result).toEqual([
      {
        organizationId: 'org-active',
        organizationSlug: 'active',
        role: 'admin',
      },
    ]);
  });

  it('drops rows with an unexpected role value', async () => {
    wireQuery({
      data: [
        {
          organization_id: 'org-1',
          role: 'superuser',
          organizations: { slug: 'acme', is_active: true },
        },
      ],
      error: null,
    });
    service = new MembershipContextService(supabaseAdmin);

    const result = await service.loadMemberships('user-1');

    expect(result).toEqual([]);
  });

  it('returns [] for a user with no memberships (onboarding)', async () => {
    wireQuery({ data: [], error: null });
    service = new MembershipContextService(supabaseAdmin);

    const result = await service.loadMemberships('user-1');

    expect(result).toEqual([]);
  });

  it('throws ServiceUnavailableException on a real DB error', async () => {
    wireQuery({ data: null, error: { message: 'connection refused' } });
    service = new MembershipContextService(supabaseAdmin);

    await expect(service.loadMemberships('user-1')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('queries organization_members filtered by user_id, ordered by created_at ASC', async () => {
    const { from, select, eq } = wireQuery({ data: [], error: null });
    service = new MembershipContextService(supabaseAdmin);

    await service.loadMemberships('user-42');

    expect(from).toHaveBeenCalledWith('organization_members');
    expect(select).toHaveBeenCalledWith(
      'organization_id, role, organizations:organizations(slug, is_active)',
    );
    expect(eq).toHaveBeenCalledWith('user_id', 'user-42');
    expect(orderMock).toHaveBeenCalledWith('created_at', { ascending: true });
  });
});
