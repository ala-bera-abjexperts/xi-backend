import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { UpdaterClientService } from '../on-prem-updates/updater-client.service';
import { OnPremConfigService } from './on-prem-config.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const user = { organizationId: ORG, userId: 'user-1' } as RequestUser;

function build(env: Record<string, string | undefined>) {
  const updater = { getConfig: jest.fn(), applyConfig: jest.fn() };
  const logActionForRequest = jest.fn();
  const service = new OnPremConfigService(
    updater as unknown as UpdaterClientService,
    { get: jest.fn((k: string) => env[k]) } as unknown as ConfigService,
    { logActionForRequest } as unknown as AuditLogsService,
  );
  return { service, updater, logActionForRequest };
}

const compose = { 'onPrem.updaterUrl': 'http://xisuite-updater:8080' };

describe('OnPremConfigService.getConfig', () => {
  it('short-circuits on Kubernetes without calling the sidecar', async () => {
    const { service, updater } = build({
      ...compose,
      'onPrem.deployPlatform': 'kubernetes',
    });
    await expect(service.getConfig()).resolves.toEqual({
      available: false,
      reason: 'kubernetes',
    });
    expect(updater.getConfig).not.toHaveBeenCalled();
  });

  it('reports updater_disabled when no UPDATE_AGENT_URL is set', async () => {
    const { service, updater } = build({});
    await expect(service.getConfig()).resolves.toEqual({
      available: false,
      reason: 'updater_disabled',
    });
    expect(updater.getConfig).not.toHaveBeenCalled();
  });

  it('reports updater_unreachable on a network error', async () => {
    const { service, updater } = build(compose);
    updater.getConfig.mockRejectedValue(new TypeError('fetch failed'));
    await expect(service.getConfig()).resolves.toEqual({
      available: false,
      reason: 'updater_unreachable',
    });
  });

  it.each([401, 500, 503])(
    'reports updater_unreachable for sidecar status %s',
    async (status) => {
      const { service, updater } = build(compose);
      updater.getConfig.mockResolvedValue({ status, body: {} });
      await expect(service.getConfig()).resolves.toEqual({
        available: false,
        reason: 'updater_unreachable',
      });
    },
  );

  it('passes the sidecar body through on 200', async () => {
    const { service, updater } = build(compose);
    const body = { available: true, revision: 'abc', groups: [] };
    updater.getConfig.mockResolvedValue({ status: 200, body: { ...body } });
    await expect(service.getConfig()).resolves.toEqual(body);
  });
});

describe('OnPremConfigService.apply', () => {
  const dto = {
    revision: 'rev-1',
    set: { SMTP_HOST: 'smtp.acme.com', SMTP_PASS: 'hunter2-secret' },
    reset: ['SMTP_USER'],
  };

  it('passes the body through, audits key names only, returns the job', async () => {
    const { service, updater, logActionForRequest } = build(compose);
    updater.applyConfig.mockResolvedValue({
      status: 202,
      body: {
        accepted: true,
        action: 'apply-config',
        keys: ['SMTP_HOST', 'SMTP_PASS', 'SMTP_USER'],
      },
    });

    await expect(service.apply(user, dto)).resolves.toEqual({
      accepted: true,
      action: 'apply-config',
      keys: ['SMTP_HOST', 'SMTP_PASS', 'SMTP_USER'],
    });
    expect(updater.applyConfig).toHaveBeenCalledWith(dto);
    expect(logActionForRequest).toHaveBeenCalledWith(
      user,
      'server_config',
      ORG,
      'update',
      { keys: ['SMTP_HOST', 'SMTP_PASS'], reset: ['SMTP_USER'] },
    );
    const logged = JSON.stringify(logActionForRequest.mock.calls[0]);
    expect(logged).not.toContain('smtp.acme.com');
    expect(logged).not.toContain('hunter2-secret');
  });

  it('defaults missing set/reset to empty', async () => {
    const { service, updater } = build(compose);
    updater.applyConfig.mockResolvedValue({ status: 202, body: {} });
    await service.apply(user, { revision: 'r' });
    expect(updater.applyConfig).toHaveBeenCalledWith({
      revision: 'r',
      set: {},
      reset: [],
    });
  });

  it('maps 400 to BadRequest and keeps error and fields', async () => {
    const { service, updater, logActionForRequest } = build(compose);
    updater.applyConfig.mockResolvedValue({
      status: 400,
      body: {
        error: 'invalid',
        message: 'Invalid values',
        fields: { SMTP_PORT: 'must be between 1 and 65535' },
      },
    });

    const err = (await service
      .apply(user, dto)
      .catch((e: unknown) => e)) as BadRequestException;
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toEqual({
      message: 'Invalid values',
      code: 'invalid',
      data: {
        error: 'invalid',
        fields: { SMTP_PORT: 'must be between 1 and 65535' },
      },
    });
    expect(logActionForRequest).not.toHaveBeenCalled();
  });

  it.each(['stale_revision', 'busy'])(
    'maps 409 %s to Conflict and keeps the error',
    async (error) => {
      const { service, updater, logActionForRequest } = build(compose);
      updater.applyConfig.mockResolvedValue({ status: 409, body: { error } });

      const err = (await service
        .apply(user, dto)
        .catch((e: unknown) => e)) as ConflictException;
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({ code: error, data: { error } });
      expect(logActionForRequest).not.toHaveBeenCalled();
    },
  );

  it.each([401, 404, 500])('maps sidecar status %s to 503', async (status) => {
    const { service, updater } = build(compose);
    updater.applyConfig.mockResolvedValue({ status, body: {} });
    await expect(service.apply(user, dto)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});
