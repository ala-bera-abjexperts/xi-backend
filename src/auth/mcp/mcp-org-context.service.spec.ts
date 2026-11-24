import { McpOrgContextService } from './mcp-org-context.service';
import { OrganizationsService } from '../../organizations/organizations.service';
import {
  ALLOWED_ORGANIZATION_MODULES,
  OrganizationModulesService,
} from '../../organization-modules/organization-modules.service';
import type { RequestUser } from '../interfaces/request-user.interface';

describe('McpOrgContextService', () => {
  let organizationsService: jest.Mocked<
    Pick<OrganizationsService, 'getOrganizationById'>
  >;
  let organizationModulesService: jest.Mocked<
    Pick<OrganizationModulesService, 'isEnabled'>
  >;
  let service: McpOrgContextService;

  // Underlying org row carries extra columns that must not leak.
  const orgRow = {
    id: 'org-id',
    name: 'Acme Inc',
    slug: 'acme',
    size: '50-100',
    is_active: true,
    default_space_id: 'space-1',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };

  const userWithOrg: RequestUser = {
    authUserId: 'auth-user-uuid',
    userId: 'public-user-id',
    email: 'user@example.com',
    organizationId: 'org-id',
    memberships: [
      { organizationId: 'org-id', organizationSlug: 'acme', role: 'admin' },
    ],
    role: 'member',
    isActive: true,
    appMetadata: {},
  };

  beforeEach(() => {
    organizationsService = {
      getOrganizationById: jest.fn().mockResolvedValue(orgRow),
    };
    organizationModulesService = {
      // portfolio enabled, resource_planning disabled.
      isEnabled: jest
        .fn()
        .mockImplementation((_org: string, moduleType: string) =>
          Promise.resolve(moduleType === 'portfolio'),
        ),
    };
    service = new McpOrgContextService(
      organizationsService as unknown as OrganizationsService,
      organizationModulesService as unknown as OrganizationModulesService,
    );
  });

  it('returns ONLY the whitelisted fields (no extra org columns leak)', async () => {
    const result = await service.getOrgContext(userWithOrg);

    expect(result).toEqual({
      organization: { id: 'org-id', slug: 'acme', name: 'Acme Inc' },
      role: 'admin',
      modules: ['portfolio'],
    });
    // None of the extra row columns should be present.
    expect(Object.keys(result.organization).sort()).toEqual([
      'id',
      'name',
      'slug',
    ]);
  });

  it('derives role from the caller membership for the active org', async () => {
    const result = await service.getOrgContext({
      ...userWithOrg,
      memberships: [
        { organizationId: 'org-id', organizationSlug: 'acme', role: 'viewer' },
      ],
    });

    expect(result.role).toBe('viewer');
  });

  it('lists every enabled org module and drops disabled ones', async () => {
    // Everything in the allowed catalog is enabled except resource_planning.
    organizationModulesService.isEnabled.mockImplementation(
      (_org: string, moduleType: string) =>
        Promise.resolve(moduleType !== 'resource_planning'),
    );

    const result = await service.getOrgContext(userWithOrg);

    expect(result.modules).toEqual(
      ALLOWED_ORGANIZATION_MODULES.filter((m) => m !== 'resource_planning'),
    );
  });

  it('returns a safe empty shape for onboarding (no active org)', async () => {
    const result = await service.getOrgContext({
      ...userWithOrg,
      organizationId: '',
      memberships: [],
    });

    expect(result).toEqual({
      organization: { id: '', slug: '', name: '' },
      role: null,
      modules: [],
    });
    expect(organizationsService.getOrganizationById).not.toHaveBeenCalled();
    expect(organizationModulesService.isEnabled).not.toHaveBeenCalled();
  });

  it('returns role null when the caller has no membership for the active org', async () => {
    const result = await service.getOrgContext({
      ...userWithOrg,
      memberships: [
        { organizationId: 'other', organizationSlug: 'x', role: 'owner' },
      ],
    });

    expect(result.role).toBeNull();
    // slug falls back to the resolved org row when no membership slug is present.
    expect(result.organization.slug).toBe('acme');
  });
});
