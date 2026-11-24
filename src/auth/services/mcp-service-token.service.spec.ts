import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createSign, generateKeyPairSync } from 'crypto';
import { McpServiceTokenService } from './mcp-service-token.service';

const SECRET = 'test-mcp-s2s-signing-secret-at-least-32-chars';
const ISSUER = 'xisuite-mcp';
const AUDIENCE = 'xisuite-backend';
const SKEW = 5;

describe('McpServiceTokenService', () => {
  let jwtService: JwtService;
  let configService: ConfigService;
  let service: McpServiceTokenService;

  const nowSec = () => Math.floor(Date.now() / 1000);

  const baseClaims = (overrides: Record<string, unknown> = {}) => {
    const iat = nowSec();

    return {
      iss: ISSUER,
      aud: AUDIENCE,
      sub: 'auth-user-uuid',
      userId: 'public-user-id',
      organizationId: 'org-id',
      grantId: 'grant-id',
      clientId: 'client-id',
      scopes: ['profile'],
      aal: null,
      jti: 'jti-123',
      iat,
      exp: iat + 60,
      ...overrides,
    };
  };

  // Signs an HS256 token with the configured secret using @nestjs/jwt directly,
  // bypassing the service's verify so the test owns the exact claim set.
  const signHs256 = (claims: Record<string, unknown>) =>
    jwtService.sign(claims, { secret: SECRET, algorithm: 'HS256' });

  beforeEach(() => {
    jwtService = new JwtService({});
    configService = {
      get: jest.fn((key: string) => {
        switch (key) {
          case 'mcpS2s.signingSecret':
            return SECRET;
          case 'mcpS2s.issuer':
            return ISSUER;
          case 'mcpS2s.audience':
            return AUDIENCE;
          case 'mcpS2s.clockSkewSeconds':
            return SKEW;
          default:
            return undefined;
        }
      }),
    } as unknown as ConfigService;
    service = new McpServiceTokenService(jwtService, configService);
  });

  it('accepts a valid HS256 token and returns the validated claims', async () => {
    const token = signHs256(baseClaims());

    const claims = await service.verify(token);

    expect(claims).toMatchObject({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: 'auth-user-uuid',
      userId: 'public-user-id',
      organizationId: 'org-id',
      grantId: 'grant-id',
      clientId: 'client-id',
      scopes: ['profile'],
      aal: null,
      jti: 'jti-123',
    });
  });

  it('rejects a token with a bad signature', async () => {
    // Signed with a different secret than the verifier is configured with.
    const token = jwtService.sign(baseClaims(), {
      secret: 'a-completely-different-secret-also-32-chars-long',
      algorithm: 'HS256',
    });

    await expect(service.verify(token)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an alg:none token (downgrade attack)', async () => {
    const header = Buffer.from(
      JSON.stringify({ alg: 'none', typ: 'JWT' }),
    ).toString('base64url');
    const payload = Buffer.from(JSON.stringify(baseClaims())).toString(
      'base64url',
    );
    // Unsecured JWT: header.payload. (empty signature)
    const token = `${header}.${payload}.`;

    await expect(service.verify(token)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an RS256 token (asymmetric downgrade attack)', async () => {
    // Hand-craft a genuine RS256-signed JWT with Node crypto (jose is ESM-only
    // and not transformed by ts-jest). The verifier must reject it because its
    // algorithms allowlist is hardcoded to ['HS256'].
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', typ: 'JWT' }),
    ).toString('base64url');
    const payload = Buffer.from(JSON.stringify(baseClaims())).toString(
      'base64url',
    );
    const signingInput = `${header}.${payload}`;
    const signature = createSign('RSA-SHA256')
      .update(signingInput)
      .sign(privateKey)
      .toString('base64url');
    const token = `${signingInput}.${signature}`;

    await expect(service.verify(token)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a token with the wrong issuer', async () => {
    const token = signHs256(baseClaims({ iss: 'evil-issuer' }));

    await expect(service.verify(token)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a token with the wrong audience', async () => {
    const token = signHs256(baseClaims({ aud: 'some-other-service' }));

    await expect(service.verify(token)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an expired token', async () => {
    const iat = nowSec() - 120;
    const token = signHs256(baseClaims({ iat, exp: iat + 60 }));

    await expect(service.verify(token)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a token whose (exp - iat) exceeds the 60s TTL (long expiry)', async () => {
    const iat = nowSec();
    // 1 hour window, well past the 60s + skew allowance.
    const token = signHs256(baseClaims({ iat, exp: iat + 3600 }));

    await expect(service.verify(token)).rejects.toThrow(
      'S2S token has an invalid (long) expiry',
    );
  });

  it('rejects a token with a missing jti', async () => {
    const claims = baseClaims();

    delete (claims as Record<string, unknown>).jti;
    const token = signHs256(claims);

    await expect(service.verify(token)).rejects.toThrow(
      'S2S token missing jti',
    );
  });

  it('rejects a token with an empty jti', async () => {
    const token = signHs256(baseClaims({ jti: '   ' }));

    await expect(service.verify(token)).rejects.toThrow(
      'S2S token missing jti',
    );
  });

  it('fail-closes when no signing secret is configured', async () => {
    (configService.get as jest.Mock).mockImplementation((key: string) =>
      key === 'mcpS2s.signingSecret' ? undefined : undefined,
    );
    const token = signHs256(baseClaims());

    await expect(service.verify(token)).rejects.toThrow(
      'S2S authentication is not configured',
    );
  });
});
