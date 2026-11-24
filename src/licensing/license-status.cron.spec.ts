/**
 * @fileoverview The daily licence status sweep: expires lapsed live licences,
 * audits each, survives one bad row, and is skipped on on-prem.
 */

import { LicenseStatusCron } from './license-status.cron';
import { LicensingService } from './licensing.service';

jest.mock('../common/utils/cron-claim', () => ({
  claimCronSlot: jest.fn().mockResolvedValue('stamp'),
}));

function buildService(lapsed: Array<Record<string, unknown>>) {
  const repository = {
    listLapsedLiveLicenses: jest.fn().mockResolvedValue(lapsed),
    updateOrganizationLicense: jest
      .fn()
      .mockImplementation(
        (_org: string, id: string, patch: { status: string }) =>
          id === 'bad'
            ? Promise.reject(new Error('boom'))
            : Promise.resolve({ id, status: patch.status }),
      ),
    createAuditEvent: jest.fn().mockResolvedValue({ id: 'a' }),
  };
  const entitlements = { bust: jest.fn() };
  const service = new LicensingService(
    repository as never,
    entitlements as never,
  );

  return { service, repository, entitlements };
}

describe('LicensingService.expireLapsedLicenses', () => {
  it('expires each lapsed licence, audits it as system, and busts the cache', async () => {
    const { service, repository, entitlements } = buildService([
      {
        id: 'l1',
        organization_id: 'o1',
        status: 'active',
        ends_at: '2026-01-01',
      },
      { id: 'l2', organization_id: 'o2', status: 'trialing', ends_at: null },
    ]);

    await expect(service.expireLapsedLicenses()).resolves.toBe(2);

    expect(repository.updateOrganizationLicense).toHaveBeenCalledWith(
      'o1',
      'l1',
      expect.objectContaining({ status: 'expired' }),
    );
    expect(repository.createAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'license_expired',
        event_source: 'system',
        organization_id: 'o1',
      }),
    );
    expect(entitlements.bust).toHaveBeenCalledWith('o2');
  });

  it('keeps going when one licence fails', async () => {
    const { service } = buildService([
      { id: 'bad', organization_id: 'o1', status: 'active' },
      { id: 'l2', organization_id: 'o2', status: 'active' },
    ]);

    await expect(service.expireLapsedLicenses()).resolves.toBe(1);
  });
});

describe('LicenseStatusCron', () => {
  const build = (onPrem: boolean) => {
    const licensing = { expireLapsedLicenses: jest.fn().mockResolvedValue(0) };
    const cron = new LicenseStatusCron(
      licensing as never,
      { getClient: () => ({}) } as never,
      { get: () => onPrem } as never,
    );

    return { cron, licensing };
  };

  it('runs the sweep on SaaS', async () => {
    const { cron, licensing } = build(false);
    await cron.sweep();
    expect(licensing.expireLapsedLicenses).toHaveBeenCalled();
  });

  it('is skipped on an on-prem box', async () => {
    const { cron, licensing } = build(true);
    await cron.sweep();
    expect(licensing.expireLapsedLicenses).not.toHaveBeenCalled();
  });
});
