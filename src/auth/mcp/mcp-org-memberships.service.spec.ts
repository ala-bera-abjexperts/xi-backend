import { McpOrgMembershipsService } from './mcp-org-memberships.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { RequestUser } from '../interfaces/request-user.interface';

describe('McpOrgMembershipsService', () => {
  let mockIn: jest.Mock;
  let service: McpOrgMembershipsService;

  // Underlying org rows carry extra columns that must not leak.
  const orgRows = [
    {
      id: 'org-1',
      name: 'Acme Inc',
      slug: 'acme',
      is_active: true,
      size: '50-100',
      default_space_id: 'space-1',
    },
    {
      id: 'org-2',
      name: 'Globex',
      slug: 'globex',
      is_active: false, // deactivated, so it must be dropped
      size: '10-50',
      default_space_id: 'space-2',
    },
  ];

  const userWithTwoOrgs: RequestUser = {
    authUserId: 'auth-user-uuid',
    userId: 'public-user-id',
    email: 'user@example.com',
    organizationId: 'org-1',
    memberships: [
      { organizationId: 'org-1', organizationSlug: 'acme', role: 'admin' },
      { organizationId: 'org-2', organizationSlug: 'globex', role: 'member' },
    ],
    role: 'member',
    isActive: true,
    appMetadata: {},
  };

  function setRows(result: { data: unknown; error: unknown }) {
    mockIn = jest.fn().mockResolvedValue(result);
    const supabaseAdmin = {
      getClient: () => ({
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({ in: mockIn }),
        }),
      }),
    } as unknown as SupabaseAdminService;
    service = new McpOrgMembershipsService(supabaseAdmin);
  }

  it('returns own orgs with name + role, ONLY whitelisted fields', async () => {
    setRows({ data: orgRows, error: null });

    const result = await service.listOrgMemberships(userWithTwoOrgs);

    // org-2 is deactivated and dropped; org-1 returned with whitelisted fields.
    expect(result).toEqual([
      { id: 'org-1', slug: 'acme', name: 'Acme Inc', role: 'admin' },
    ]);
    expect(Object.keys(result[0]).sort()).toEqual([
      'id',
      'name',
      'role',
      'slug',
    ]);
  });

  it('drops deactivated orgs', async () => {
    setRows({
      data: [{ ...orgRows[0], is_active: false }, orgRows[1]],
      error: null,
    });

    const result = await service.listOrgMemberships(userWithTwoOrgs);

    expect(result).toEqual([]);
  });

  it('keeps all active orgs the caller belongs to', async () => {
    setRows({
      data: [orgRows[0], { ...orgRows[1], is_active: true }],
      error: null,
    });

    const result = await service.listOrgMemberships(userWithTwoOrgs);

    expect(result.map((o) => o.id)).toEqual(['org-1', 'org-2']);
    expect(result.map((o) => o.role)).toEqual(['admin', 'member']);
  });

  it('returns an empty list (never null) when the caller has no memberships', async () => {
    setRows({ data: [], error: null });

    const result = await service.listOrgMemberships({
      ...userWithTwoOrgs,
      memberships: [],
    });

    expect(result).toEqual([]);
    // no orgs to resolve, so the batched read is skipped
    expect(mockIn).not.toHaveBeenCalled();
  });

  it('fails closed (empty list) on a read error', async () => {
    setRows({ data: null, error: { message: 'boom' } });

    const result = await service.listOrgMemberships(userWithTwoOrgs);

    expect(result).toEqual([]);
  });

  it('drops a membership whose org row is missing', async () => {
    // only org-1 row returned; org-2 has no row, so it is dropped.
    setRows({ data: [orgRows[0]], error: null });

    const result = await service.listOrgMemberships(userWithTwoOrgs);

    expect(result.map((o) => o.id)).toEqual(['org-1']);
  });
});
