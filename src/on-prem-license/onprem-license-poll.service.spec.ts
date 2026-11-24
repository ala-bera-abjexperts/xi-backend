/**
 * @fileoverview The connected check-in records WHY it failed, and never
 * clobbers an exported offline request.
 * @module on-prem-license/onprem-license-poll.service.spec
 */

import type { ConfigService } from '@nestjs/config';
import type { EntitlementsService } from '../licensing/entitlements.service';
import * as crypto from '../licensing/artifact/license-artifact.crypto';
import type { LicenseArtifactPayload } from '../licensing/artifact/license-artifact.types';
import { OnpremLicensePollService } from './onprem-license-poll.service';
import type { OnpremLicenseStateRepository } from './onprem-license-state.repository';
import type { OnpremLicenseStateService } from './onprem-license.service';

const ENV: Record<string, string> = {
  'onPrem.licenseApiUrl': 'https://vendor.example/api/v1/onprem/license/check',
  'onPrem.licenseActivationCode': 'CODE-1234',
};

function build() {
  const repo = {
    get: jest
      .fn()
      .mockResolvedValue({ pending_nonce: 'offline-request-nonce' }),
    patch: jest.fn().mockResolvedValue(undefined),
    countUsage: jest.fn().mockResolvedValue({ activeUsers: 1, totalUsers: 1 }),
  };
  const state = {
    identity: jest
      .fn()
      .mockResolvedValue({ fingerprint: 'fp', publicKey: 'pk' }),
    identityMismatch: jest.fn().mockReturnValue(null),
    invalidate: jest.fn(),
  };
  const svc = new OnpremLicensePollService(
    repo as unknown as OnpremLicenseStateRepository,
    { get: (k: string) => ENV[k] ?? '' } as unknown as ConfigService,
    { bustAll: jest.fn() } as unknown as EntitlementsService,
    state as unknown as OnpremLicenseStateService,
  );

  return { svc, repo };
}

const patched = (
  repo: ReturnType<typeof build>['repo'],
): Record<string, unknown> =>
  Object.assign(
    {},
    ...(repo.patch.mock.calls as Array<[Record<string, unknown>]>).map(
      ([fields]) => fields,
    ),
  ) as Record<string, unknown>;

afterEach(() => jest.restoreAllMocks());

describe('connected licence check-in', () => {
  it('says the vendor issued nothing (signing key missing) instead of "malformed"', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ statusCode: 201, hasError: false, data: null }),
    } as Response);
    const { svc, repo } = build();

    await expect(svc.poll()).resolves.toEqual({
      outcome: 'rejected',
      detail: 'vendor_not_configured',
    });
    expect(patched(repo)).toMatchObject({
      last_error: 'vendor_not_configured',
    });
  });

  it('records the network cause code, not just "fetch failed"', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'ENOTFOUND' },
      }),
    );
    const { svc, repo } = build();

    await expect(svc.poll()).resolves.toMatchObject({ outcome: 'unreachable' });
    expect(patched(repo).last_error).toBe('fetch failed (ENOTFOUND)');
  });

  it('never overwrites the nonce of an exported offline request', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: false, status: 503 } as Response);
    const { svc, repo } = build();

    await svc.poll();

    expect(patched(repo)).not.toHaveProperty('pending_nonce');
    expect(patched(repo)).toMatchObject({ last_error: 'HTTP 503' });
    expect(patched(repo).last_attempt_at).toEqual(expect.any(String));
  });

  it('refuses a licence issued before the one already stored (no downgrade)', async () => {
    const { svc, repo } = build();

    repo.get.mockResolvedValue({
      artifact: { enc: 'stored' },
      issued_at: '2026-11-24T10:00:00.000Z',
    });
    jest.spyOn(crypto, 'verifyLicenseArtifact').mockReturnValue({
      ok: true,
      payload: {
        status: 'active',
        issuedAt: '2026-11-01T10:00:00.000Z',
        expiresAt: '2027-01-30T10:00:00.000Z',
      } as LicenseArtifactPayload,
    });

    await expect(
      svc.acceptArtifact({ enc: 'old-file' }, null, 'import'),
    ).resolves.toEqual({
      outcome: 'rejected',
      detail: 'superseded',
    });
    expect(patched(repo)).not.toHaveProperty('artifact');
    // A refused import does not pose as a failed check-in.
    expect(patched(repo)).not.toHaveProperty('last_error');
  });
});
