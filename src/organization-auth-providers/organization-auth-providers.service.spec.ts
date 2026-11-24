import { ForbiddenException } from '@nestjs/common';
import { OrganizationAuthProvidersService } from './organization-auth-providers.service';

// NOTE: IS_ON_PREMISE is evaluated at module-eval from process.env, which is
// unset in the test runner — so these assertions exercise the SaaS (cloud)
// branch, i.e. the cloud-safety guarantees (Keycloak never available, writes
// rejected). That is the security-critical path.
describe('OrganizationAuthProvidersService (cloud/SaaS mode)', () => {
  function make(rows: Array<{ provider: string; is_enabled: boolean }> = []) {
    const repository = {
      getProvider: jest.fn((_org: string, provider: string) =>
        Promise.resolve(rows.find((r) => r.provider === provider) ?? null),
      ),
      listForOrg: jest.fn().mockResolvedValue(rows),
      upsert: jest.fn().mockResolvedValue({ id: 'row-1' }),
    };
    const auditLogs = { createLog: jest.fn().mockResolvedValue(undefined) };
    const permissionsService = {
      isAdminOrOwner: jest.fn().mockResolvedValue(true),
    };
    const supabaseAdmin = { getClient: jest.fn() };
    const service = new OrganizationAuthProvidersService(
      repository as never,
      auditLogs as never,
      permissionsService as never,
      supabaseAdmin as never,
    );

    return { service, repository, auditLogs, permissionsService };
  }

  it('reports isOnPremise=false in the SaaS build', () => {
    expect(make().service.isOnPremise).toBe(false);
  });

  it('rejects writes off-premise before touching the repository', async () => {
    const { service, repository } = make();

    await expect(
      service.setEnabled('org-1', 'azure', true, 'user-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.upsert).not.toHaveBeenCalled();
  });

  it('never reports Keycloak as available off-premise, even if its row is enabled', async () => {
    const { service } = make([{ provider: 'keycloak', is_enabled: true }]);

    expect(await service.isAvailable('org-1', 'keycloak')).toBe(false);
    expect(await service.getAvailableProviders('org-1')).not.toContain(
      'keycloak',
    );
  });

  it('surfaces Azure when its row is enabled', async () => {
    const { service } = make([{ provider: 'azure', is_enabled: true }]);

    expect(await service.getAvailableProviders('org-1')).toEqual(['azure']);
  });

  it('treats an absent row as disabled (default OFF)', async () => {
    const { service } = make([]);

    expect(await service.isEnabled('org-1', 'azure')).toBe(false);
    expect(await service.getAvailableProvidersForOnPremise()).toEqual([]);
  });
});
