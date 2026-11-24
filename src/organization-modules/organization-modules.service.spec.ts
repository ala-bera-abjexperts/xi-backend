import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  EntitlementsService,
  type EffectiveEntitlements,
} from '../licensing/entitlements.service';
import { PermissionsService } from '../permissions/permissions.service';
import {
  OrganizationModuleRepository,
  type OrganizationModuleRow,
} from './organization-module.repository';
import { OrganizationModulesService } from './organization-modules.service';

describe('OrganizationModulesService', () => {
  let service: OrganizationModulesService;
  let repository: jest.Mocked<OrganizationModuleRepository>;
  let auditLogs: jest.Mocked<AuditLogsService>;
  let permissions: jest.Mocked<PermissionsService>;
  let entitlements: jest.Mocked<EntitlementsService>;

  const ORG = 'org-1';
  const USER = 'user-1';

  /** Minimal EffectiveEntitlements stub granting exactly `featureKeys`. */
  const makeEntitlements = (featureKeys: string[]): EffectiveEntitlements => ({
    organizationId: ORG,
    grandfathered: false,
    licenseStatus: 'active',
    resolvedAt: '2026-05-01T00:00:00Z',
    has: (key: string) => featureKeys.includes(key),
    getLimit: () => null,
    getValue: () => undefined,
    raw: new Map(),
  });
  const row: OrganizationModuleRow = {
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

  beforeEach(() => {
    repository = {
      getModule: jest.fn(),
      listForOrg: jest.fn(),
      upsert: jest.fn(),
    } as unknown as jest.Mocked<OrganizationModuleRepository>;
    auditLogs = {
      createLog: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AuditLogsService>;
    permissions = {
      isAdminOrOwner: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<PermissionsService>;
    entitlements = {
      getEffectiveEntitlements: jest
        .fn()
        .mockResolvedValue(makeEntitlements(['module_portfolios'])),
    } as unknown as jest.Mocked<EntitlementsService>;
    service = new OrganizationModulesService(
      repository,
      auditLogs,
      permissions,
      entitlements,
    );
  });

  it('lists organization modules through the repository', async () => {
    const repo = repository as unknown as Record<string, jest.Mock>;
    repo['listForOrg'].mockResolvedValue([row]);

    await expect(service.listForOrg(ORG)).resolves.toEqual([row]);
    expect(repo['listForOrg']).toHaveBeenCalledWith(ORG);
  });

  it('resolves a missing module row against the entitlement layer', async () => {
    const repo = repository as unknown as Record<string, jest.Mock>;
    const ents = entitlements as unknown as Record<string, jest.Mock>;
    repo['getModule'].mockResolvedValue(null);

    // `resource_planning` used to be the example of the LEGACY path, because it
    // had no catalog feature key and so never consulted entitlements. It now has
    // one (`module_resource_planning`), and every allowed module type is mapped,
    // so the legacy branch is no longer reachable for any real module type. That
    // is the point of the change: the entitlement check in setEnabled() is
    // guarded by `if (featureKey)`, so an unmapped type silently opted out of
    // licensing entirely.
    await expect(service.isEnabled(ORG, 'resource_planning')).resolves.toBe(
      false,
    );
    expect(ents['getEffectiveEntitlements']).toHaveBeenCalledWith(ORG);

    ents['getEffectiveEntitlements'].mockClear();

    // Licensed path, not entitled: absent row => false.
    ents['getEffectiveEntitlements'].mockResolvedValue(makeEntitlements([]));
    await expect(service.isEnabled(ORG, 'portfolio')).resolves.toBe(false);
    expect(ents['getEffectiveEntitlements']).toHaveBeenCalledWith(ORG);

    // Licensed path, entitled: absent row defaults ON for entitled tenants.
    ents['getEffectiveEntitlements'].mockResolvedValue(
      makeEntitlements(['module_portfolios']),
    );
    await expect(service.isEnabled(ORG, 'portfolio')).resolves.toBe(true);
  });

  it('reads the raw stored toggle without consulting entitlements', async () => {
    const repo = repository as unknown as Record<string, jest.Mock>;
    const ents = entitlements as unknown as Record<string, jest.Mock>;
    repo['getModule'].mockResolvedValue(null);

    await expect(service.isLegacyEnabled(ORG, 'portfolio')).resolves.toBe(
      false,
    );
    expect(ents['getEffectiveEntitlements']).not.toHaveBeenCalled();
  });

  it('rejects unknown organization module keys before writing', async () => {
    const repo = repository as unknown as Record<string, jest.Mock>;
    await expect(
      service.setEnabled(ORG, 'billing', true, USER),
    ).rejects.toThrow(BadRequestException);
    expect(repo['upsert']).not.toHaveBeenCalled();
  });

  it('requires admin or owner to change module state', async () => {
    const repo = repository as unknown as Record<string, jest.Mock>;
    const perms = permissions as unknown as Record<string, jest.Mock>;
    perms['isAdminOrOwner'].mockResolvedValue(false);

    await expect(
      service.setEnabled(ORG, 'portfolio', true, USER),
    ).rejects.toThrow(ForbiddenException);
    expect(repo['upsert']).not.toHaveBeenCalled();
  });

  it('upserts portfolio module state and logs an audit entry', async () => {
    const repo = repository as unknown as Record<string, jest.Mock>;
    const logs = auditLogs as unknown as Record<string, jest.Mock>;
    repo['upsert'].mockResolvedValue(row);

    const result = await service.setEnabled(ORG, 'portfolio', true, USER);

    expect(result).toBe(row);
    expect(repo['upsert']).toHaveBeenCalledWith(ORG, 'portfolio', true, USER);
    expect(logs['createLog']).toHaveBeenCalledWith(ORG, USER, {
      entity_type: 'organization_module',
      entity_id: row.id,
      action: 'update',
      changes: { module_type: 'portfolio', is_enabled: true },
    });
  });

  it('supports repeated idempotent toggles via repository upsert', async () => {
    const repo = repository as unknown as Record<string, jest.Mock>;
    repo['upsert'].mockResolvedValue({ ...row, is_enabled: false });

    const result = await service.setEnabled(ORG, 'portfolio', false, USER);

    expect(result.is_enabled).toBe(false);
    expect(repo['upsert']).toHaveBeenCalledWith(ORG, 'portfolio', false, USER);
  });
});
