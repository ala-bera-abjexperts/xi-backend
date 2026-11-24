import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { runControllerContractSuite } from '../../test/controller-contract.helper';
import { VerifyMfaDto } from './dto/enroll-mfa.dto';
import { MfaController } from './mfa.controller';

runControllerContractSuite({
  controller: MfaController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});

describe('MfaController manual behavior', () => {
  const tokenResult = {
    access_token: 'aal2-access',
    refresh_token: 'aal2-refresh',
    expires_in: 3600,
    token_type: 'bearer',
  };

  function setup() {
    const mfaService = {
      enroll: jest.fn(),
      challenge: jest.fn(),
      verify: jest.fn(),
      unenroll: jest.fn(),
      listFactors: jest.fn(),
      getAal: jest.fn(),
    };
    const configService = { get: jest.fn() };
    const passkeysService = {
      getPendingTrustedDeviceCookieName: jest
        .fn()
        .mockReturnValue('auth_passkey_pending_device'),
      getTrustedDeviceCookieName: jest
        .fn()
        .mockReturnValue('auth_passkey_trusted_device'),
      getTrustedDeviceMaxAgeSeconds: jest.fn().mockReturnValue(7776000),
      getPendingTrustedDeviceMaxAgeSeconds: jest.fn().mockReturnValue(600),
      getAssuranceCookieName: jest.fn().mockReturnValue('auth_assurance'),
      getAssuranceCookieMaxAgeSeconds: jest.fn().mockReturnValue(900),
      finalizeTrustedDevice: jest.fn(),
      dropPendingTrustedDevice: jest.fn().mockReturnValue(null),
    };
    const res = {
      cookie: jest.fn().mockReturnThis(),
      clearCookie: jest.fn().mockReturnThis(),
    };
    const controller = new MfaController(
      mfaService as any,
      configService as any,
      passkeysService as any,
    );
    return { controller, mfaService, passkeysService, res };
  }

  it('prefers a bearer token over the access_token cookie', async () => {
    const { controller, mfaService } = setup();
    mfaService.enroll.mockResolvedValue({ id: 'factor-1' });

    await controller.enroll(
      {
        headers: { authorization: 'Bearer header-token' },
        cookies: { access_token: 'cookie-token' },
      } as any,
      { friendlyName: 'Phone' } as any,
    );

    expect(mfaService.enroll).toHaveBeenCalledWith('header-token', 'Phone');
  });

  it('falls back to the access_token cookie', async () => {
    const { controller, mfaService } = setup();
    mfaService.challenge.mockResolvedValue({ id: 'challenge-1' });

    await controller.challenge(
      { headers: {}, cookies: { access_token: 'cookie-token' } } as any,
      { factorId: 'factor-1' } as any,
    );

    expect(mfaService.challenge).toHaveBeenCalledWith(
      'cookie-token',
      'factor-1',
    );
  });

  it('rejects requests without any access token', async () => {
    const { controller, mfaService } = setup();

    await expect(
      controller.factors({ headers: {}, cookies: {} } as any),
    ).rejects.toThrow(BadRequestException);
    expect(mfaService.listFactors).not.toHaveBeenCalled();
  });

  it('sets rotated auth cookies after verify', async () => {
    const { controller, mfaService, res } = setup();
    mfaService.verify.mockResolvedValue(tokenResult);

    await expect(
      controller.verify(
        { headers: { authorization: 'Bearer access-token' } } as any,
        {
          factorId: 'factor-1',
          challengeId: 'challenge-1',
          code: '123456',
        } as any,
        res as any,
      ),
    ).resolves.toBe(tokenResult);
    expect(mfaService.verify).toHaveBeenCalledWith(
      'access-token',
      'factor-1',
      'challenge-1',
      '123456',
    );
    expect(res.cookie).toHaveBeenCalledWith(
      'access_token',
      tokenResult.access_token,
      expect.any(Object),
    );
    expect(res.clearCookie).toHaveBeenCalledWith(
      'mfa_pending',
      expect.objectContaining({ path: '/' }),
    );
  });

  it('finalizes a pending passkey device after the high-risk TOTP step-up', async () => {
    const { controller, mfaService, passkeysService, res } = setup();
    mfaService.verify.mockResolvedValue(tokenResult);
    passkeysService.finalizeTrustedDevice.mockResolvedValue({
      trustedDeviceValue: 'trusted-device-token',
      pendingTrustedDeviceValue: 'pending-state-for-the-other-account',
      assuranceValue: 'signed-assurance',
    });

    await controller.verify(
      {
        headers: { authorization: 'Bearer access-token' },
        cookies: {
          auth_passkey_pending_device: 'signed-pending-device',
          auth_passkey_trusted_device: 'trusted-device-map',
        },
      } as any,
      {
        factorId: 'factor-1',
        challengeId: 'challenge-1',
        code: '123456',
      } as any,
      res as any,
    );

    expect(passkeysService.finalizeTrustedDevice).toHaveBeenCalledWith(
      tokenResult.access_token,
      'signed-pending-device',
      'trusted-device-map',
    );
    expect(res.cookie).toHaveBeenCalledWith(
      'auth_passkey_trusted_device',
      'trusted-device-token',
      expect.any(Object),
    );
    expect(res.cookie).toHaveBeenCalledWith(
      'auth_passkey_pending_device',
      'pending-state-for-the-other-account',
      expect.any(Object),
    );
  });

  it('still completes MFA verify when trusted-device finalization fails', async () => {
    const { controller, mfaService, passkeysService, res } = setup();
    mfaService.verify.mockResolvedValue(tokenResult);
    passkeysService.finalizeTrustedDevice.mockRejectedValue(
      new UnauthorizedException('Trusted device does not belong to this user'),
    );
    passkeysService.dropPendingTrustedDevice.mockReturnValue(
      'pending-state-for-the-other-account',
    );

    await expect(
      controller.verify(
        {
          headers: { authorization: 'Bearer access-token' },
          cookies: { auth_passkey_pending_device: 'stale-pending-device' },
        } as any,
        {
          factorId: 'factor-1',
          challengeId: 'challenge-1',
          code: '123456',
        } as any,
        res as any,
      ),
    ).resolves.toBe(tokenResult);

    expect(res.cookie).toHaveBeenCalledWith(
      'access_token',
      tokenResult.access_token,
      expect.any(Object),
    );
    expect(res.cookie).toHaveBeenCalledWith(
      'refresh_token',
      tokenResult.refresh_token,
      expect.any(Object),
    );
    // Only the poisoned entry is dropped; a second account's pending step-up
    // is written back so the next verify does not retry the same failure.
    expect(passkeysService.dropPendingTrustedDevice).toHaveBeenCalledWith(
      'stale-pending-device',
      tokenResult.access_token,
    );
    expect(res.cookie).toHaveBeenCalledWith(
      'auth_passkey_pending_device',
      'pending-state-for-the-other-account',
      expect.objectContaining({ path: '/' }),
    );
    expect(res.cookie).not.toHaveBeenCalledWith(
      'auth_passkey_trusted_device',
      expect.anything(),
      expect.anything(),
    );
  });

  it('validates MFA code as exactly six numeric digits after trimming', async () => {
    const valid = plainToInstance(VerifyMfaDto, {
      factorId: 'factor-1',
      challengeId: 'challenge-1',
      code: ' 123456 ',
    });
    const tooShort = plainToInstance(VerifyMfaDto, {
      factorId: 'factor-1',
      challengeId: 'challenge-1',
      code: '12345',
    });
    const nonNumeric = plainToInstance(VerifyMfaDto, {
      factorId: 'factor-1',
      challengeId: 'challenge-1',
      code: '12a456',
    });

    await expect(validate(valid)).resolves.toHaveLength(0);
    expect(valid.code).toBe('123456');
    await expect(validate(tooShort)).resolves.not.toHaveLength(0);
    await expect(validate(nonNumeric)).resolves.not.toHaveLength(0);
  });

  it('returns a stable success body after unenroll', async () => {
    const { controller, mfaService } = setup();

    await expect(
      controller.unenroll(
        { headers: { authorization: 'Bearer access-token' } } as any,
        { factorId: 'factor-1' } as any,
      ),
    ).resolves.toEqual({ success: true });
    expect(mfaService.unenroll).toHaveBeenCalledWith(
      'access-token',
      'factor-1',
    );
  });
});
