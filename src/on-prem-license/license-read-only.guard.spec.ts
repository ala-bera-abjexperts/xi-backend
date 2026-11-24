import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { LicenseReadOnlyGuard } from './license-read-only.guard';
import type { OnpremLicenseStateService } from './onprem-license.service';

const ctx = (method: string, originalUrl: string) =>
  ({
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ method, originalUrl }) }),
  }) as unknown as ExecutionContext;

describe('LicenseReadOnlyGuard in read-only mode', () => {
  const guard = new LicenseReadOnlyGuard({
    current: jest.fn().mockResolvedValue({ readOnly: true }),
  } as unknown as OnpremLicenseStateService);

  it('keeps Server configuration writable', async () => {
    await expect(
      guard.canActivate(ctx('POST', '/api/v1/system-config/apply')),
    ).resolves.toBe(true);
  });

  it('still blocks other writes', async () => {
    await expect(
      guard.canActivate(ctx('POST', '/api/v1/tasks')),
    ).rejects.toThrow(ForbiddenException);
  });
});
