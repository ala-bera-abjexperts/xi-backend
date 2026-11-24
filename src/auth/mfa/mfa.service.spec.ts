import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
import { MfaService } from './mfa.service';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(),
}));

describe('MfaService', () => {
  const verifyMock = jest.fn();
  const getUserMock = jest.fn();
  const enrollMock = jest.fn();
  const unenrollMock = jest.fn();
  const listFactorsMock = jest.fn();
  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'supabase.url') return 'http://127.0.0.1:54321';
      if (key === 'supabase.anonKey') return 'anon-key';
      return undefined;
    }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (createClient as jest.Mock).mockReturnValue({
      auth: {
        getUser: getUserMock,
        mfa: {
          enroll: enrollMock,
          unenroll: unenrollMock,
          listFactors: listFactorsMock,
          verify: verifyMock,
        },
      },
    });
  });

  it('maps invalid TOTP verification to BadRequestException', async () => {
    verifyMock.mockResolvedValue({
      data: null,
      error: {
        message: 'Invalid TOTP code entered',
        code: 'mfa_verification_failed',
      },
    });

    const service = new MfaService(configService as any);

    await expect(
      service.verify('access-token', 'factor-id', 'challenge-id', '123456'),
    ).rejects.toThrow(BadRequestException);
  });

  it('keeps auth/session failures as UnauthorizedException', async () => {
    verifyMock.mockResolvedValue({
      data: null,
      error: {
        message: 'Invalid or expired JWT',
        code: 'invalid_jwt',
      },
    });

    const service = new MfaService(configService as any);

    await expect(
      service.verify('access-token', 'factor-id', 'challenge-id', '123456'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('returns aal2 as next level when the user has a verified factor', async () => {
    getUserMock.mockResolvedValue({
      data: {
        user: {
          id: 'auth-user-id',
          factors: [
            { id: 'factor-id', factor_type: 'totp', status: 'verified' },
          ],
        },
      },
      error: null,
    });

    const service = new MfaService(configService as any);
    const result = await service.getAal(jwtWithPayload({ aal: 'aal1' }));

    expect(result.currentLevel).toBe('aal1');
    expect(result.nextLevel).toBe('aal2');
  });

  it('returns aal1 as next level when the user has no verified factors', async () => {
    getUserMock.mockResolvedValue({
      data: {
        user: {
          id: 'auth-user-id',
          factors: [
            { id: 'factor-id', factor_type: 'totp', status: 'unverified' },
          ],
        },
      },
      error: null,
    });

    const service = new MfaService(configService as any);
    const result = await service.getAal(jwtWithPayload({ aal: 'aal1' }));

    expect(result.currentLevel).toBe('aal1');
    expect(result.nextLevel).toBe('aal1');
  });

  it('allows first-factor TOTP enrollment without requiring aal2', async () => {
    getUserMock.mockResolvedValue({
      data: {
        user: {
          id: 'auth-user-id',
          factors: [],
        },
      },
      error: null,
    });
    enrollMock.mockResolvedValue({
      data: {
        id: 'factor-id',
        friendly_name: 'Phone',
        totp: {
          qr_code: '<svg />',
          secret: 'SECRET',
          uri: 'otpauth://totp/X',
        },
      },
      error: null,
    });

    const service = new MfaService(configService as any);

    await expect(
      service.enroll(jwtWithPayload({ aal: 'aal1' }), 'Phone'),
    ).resolves.toMatchObject({ factorId: 'factor-id' });
  });

  it('requires aal2 to manage authenticator app factors once a verified TOTP exists', async () => {
    getUserMock.mockResolvedValue({
      data: {
        user: {
          id: 'auth-user-id',
          factors: [
            { id: 'factor-id', factor_type: 'totp', status: 'verified' },
          ],
        },
      },
      error: null,
    });

    const service = new MfaService(configService as any);

    await expect(
      service.enroll(jwtWithPayload({ aal: 'aal1' }), 'Backup device'),
    ).rejects.toThrow(UnauthorizedException);
    expect(enrollMock).not.toHaveBeenCalled();
  });

  it('requires aal2 before removing the last verified TOTP factor', async () => {
    getUserMock.mockResolvedValue({
      data: {
        user: {
          id: 'auth-user-id',
          factors: [
            { id: 'factor-id', factor_type: 'totp', status: 'verified' },
          ],
        },
      },
      error: null,
    });
    listFactorsMock.mockResolvedValue({
      data: {
        totp: [
          {
            id: 'factor-id',
            factor_type: 'totp',
            friendly_name: 'Phone',
            status: 'verified',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
        ],
        all: [],
      },
      error: null,
    });

    const service = new MfaService(configService as any);

    await expect(
      service.unenroll(jwtWithPayload({ aal: 'aal1' }), 'factor-id'),
    ).rejects.toThrow(UnauthorizedException);
    expect(unenrollMock).not.toHaveBeenCalled();
  });
});

function jwtWithPayload(payload: Record<string, unknown>) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');

  return `header.${encoded}.signature`;
}
