import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { OnPremUpdatesService } from './on-prem-updates.service';
import type { UpdaterClientService } from './updater-client.service';

describe('OnPremUpdatesService reinstall', () => {
  const trigger = jest.fn();
  const service = new OnPremUpdatesService(
    { trigger } as unknown as UpdaterClientService,
    { get: jest.fn() } as unknown as ConfigService,
  );

  beforeEach(() => trigger.mockReset());

  it('requests a reinstall without accepting a client-selected version', async () => {
    trigger.mockResolvedValue({
      status: 202,
      body: { accepted: true, action: 'reinstall' },
    });

    await expect(service.reinstall()).resolves.toEqual({ accepted: true });
    expect(trigger).toHaveBeenCalledWith('reinstall');
  });

  it('rejects an unsafe reinstall configuration reported by the updater', async () => {
    trigger.mockResolvedValue({
      status: 400,
      body: { message: 'The running version could not be determined safely.' },
    });

    await expect(service.reinstall()).rejects.toThrow(BadRequestException);
  });

  it('rejects a reinstall while another operation is active', async () => {
    trigger.mockResolvedValue({
      status: 409,
      body: { message: 'An update or rollback is already running.' },
    });

    await expect(service.reinstall()).rejects.toThrow(ConflictException);
  });

  it.each([401, 404, 500])(
    'reports sidecar status %s as unavailable instead of accepting it',
    async (status) => {
      trigger.mockResolvedValue({ status, body: {} });

      await expect(service.reinstall()).rejects.toThrow(
        ServiceUnavailableException,
      );
    },
  );
});

describe('OnPremUpdatesService on Kubernetes (DEPLOY_PLATFORM=kubernetes)', () => {
  const updater = { getStatus: jest.fn(), trigger: jest.fn() };
  const config = {
    get: jest.fn(
      (key: string) =>
        ({ 'onPrem.deployPlatform': 'kubernetes', 'onPrem.release': '1.2.31' })[
          key
        ],
    ),
  };
  const service = new OnPremUpdatesService(
    updater as unknown as UpdaterClientService,
    config as unknown as ConfigService,
  );

  it('reports managed_externally without calling the updater', async () => {
    await expect(service.getStatus()).resolves.toEqual({
      status: 'managed_externally',
      updaterReachable: false,
      release: '1.2.31',
    });
    expect(updater.getStatus).not.toHaveBeenCalled();
  });

  it('does not warn about a missing updater at boot', () => {
    const warn = jest.spyOn(
      (service as unknown as { logger: { warn: () => void } }).logger,
      'warn',
    );

    service.onModuleInit();

    expect(warn).not.toHaveBeenCalled();
  });
});
