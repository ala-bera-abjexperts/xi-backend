// Pure verifier for the service-to-service (S2S) JWT minted by the MCP server
// (xisuite-mcp) when it calls this backend on behalf of a real user. This does
// only crypto and claim validation; it never touches the database. All freshness
// checks (user active, membership, org active) are done by McpServiceTokenGuard
// after this verifier returns, which keeps this class trivially unit-testable.
//
// Security invariants enforced here (encoded as tests): HS256 is hardcoded, so
// alg:none and any asymmetric downgrade (RS256/ES256) are rejected by
// @nestjs/jwt's `algorithms: ['HS256']` allowlist. iss and aud are pinned to the
// configured values. A non-empty jti is required (forensics plus future replay
// defense). exp is enforced with a small clock skew, and a "long expiry" guard
// rejects any token whose (exp - iat) exceeds 60s: the S2S TTL is deliberately
// tiny, so a longer-lived token is treated as forged or misconfigured.

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

// Maximum allowed (exp - iat) window for an S2S token, in seconds. The MCP
// server mints these with a default TTL of 60s; anything claiming a longer life
// is rejected as a "long expiry" forgery/misconfiguration regardless of whether
// it is currently within `exp`.
const MAX_S2S_TTL_SECONDS = 60;

// The validated S2S claim set. Mirrors what xisuite-mcp's S2S signer emits. All
// identity fields are treated as untrusted hints by the guard, which re-resolves
// user/membership/org freshly from the database; the verifier only guarantees
// the token is authentic and well-formed.
export interface McpServiceTokenClaims {
  /** Token issuer — pinned to `MCP_S2S_ISSUER` (default `xisuite-mcp`). */
  iss: string;

  /** Token audience — pinned to `MCP_S2S_AUDIENCE` (default `xisuite-backend`). */
  aud: string;

  /** `auth.users.id` of the real user the MCP client is acting as. */
  sub: string;

  /** `public.users.id` of the real user (hint; re-resolved from `sub` in the guard). */
  userId: string;

  /** Organization bound to the originating OAuth grant. */
  organizationId: string;

  /** MCP OAuth grant id (audit only). */
  grantId: string;

  /** Public client_id string of the MCP OAuth client (audit only). */
  clientId: string;

  /** OAuth scopes granted to this MCP connection. */
  scopes: string[];

  /** Best-effort AAL captured on the grant, or null when not stored. */
  aal: string | null;

  /** Unique token id — required, non-empty. */
  jti: string;

  /** Issued-at (epoch seconds). */
  iat: number;

  /** Expiry (epoch seconds). */
  exp: number;
}

// Verifies the S2S JWT presented by the MCP server. Throws
// UnauthorizedException on any failure; returns the validated claims on success.
@Injectable()
export class McpServiceTokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  // Verifies a raw S2S JWT and returns its validated claims. Throws on a missing
  // secret, bad signature, wrong algorithm, wrong iss/aud, missing jti, expired
  // token, or a TTL > 60s.
  async verify(token: string): Promise<McpServiceTokenClaims> {
    const secret = this.configService.get<string>('mcpS2s.signingSecret');

    // Fail-closed: with no secret configured, treat all S2S tokens as invalid
    // rather than silently accepting or crashing. Env validation already blocks
    // a placeholder secret in production; this is the runtime backstop.
    if (!secret) {
      throw new UnauthorizedException('S2S authentication is not configured');
    }

    const issuer =
      this.configService.get<string>('mcpS2s.issuer') ?? 'xisuite-mcp';
    const audience =
      this.configService.get<string>('mcpS2s.audience') ?? 'xisuite-backend';
    const rawClockSkew = this.configService.get<number>(
      'mcpS2s.clockSkewSeconds',
    );
    // Guard against a non-numeric env value (parseInt yields NaN): NaN is not
    // caught by `?? 5`, and would silently disable the long-TTL forgery guard
    // below.
    const clockSkew = Number.isFinite(rawClockSkew)
      ? (rawClockSkew as number)
      : 5;

    let payload: Record<string, unknown>;

    try {
      // algorithms: ['HS256'] is hardcoded; this is the single most important
      // line. It rejects alg:none and any asymmetric-key downgrade attack. We
      // also let @nestjs/jwt pin iss/aud and apply the skew on exp/nbf.
      payload = await this.jwtService.verifyAsync<Record<string, unknown>>(
        token,
        {
          secret,
          algorithms: ['HS256'],
          issuer,
          audience,
          clockTolerance: clockSkew,
        },
      );
    } catch {
      // Never leak the underlying jose/jwt error detail to the caller.
      throw new UnauthorizedException('Invalid S2S token');
    }

    // jti is required and must be a non-empty string.
    const jti = payload.jti;

    if (typeof jti !== 'string' || jti.trim() === '') {
      throw new UnauthorizedException('S2S token missing jti');
    }

    const iat = payload.iat;
    const exp = payload.exp;

    if (typeof iat !== 'number' || typeof exp !== 'number') {
      throw new UnauthorizedException('S2S token missing iat/exp');
    }

    // Long-expiry guard: the S2S TTL is tiny by design. A token claiming a
    // window larger than MAX_S2S_TTL_SECONDS is rejected even if it is still
    // within `exp`, since it indicates a forged or misconfigured signer. The
    // skew is added so a signer running slightly fast on `exp` is not falsely
    // rejected.
    if (exp - iat > MAX_S2S_TTL_SECONDS + clockSkew) {
      throw new UnauthorizedException('S2S token has an invalid (long) expiry');
    }

    const sub = payload.sub;
    const userId = payload.userId;
    const organizationId = payload.organizationId;

    if (
      typeof sub !== 'string' ||
      sub === '' ||
      typeof userId !== 'string' ||
      userId === '' ||
      typeof organizationId !== 'string' ||
      organizationId === ''
    ) {
      throw new UnauthorizedException('S2S token missing identity claims');
    }

    const scopes = Array.isArray(payload.scopes)
      ? payload.scopes.filter((s): s is string => typeof s === 'string')
      : [];

    return {
      iss: issuer,
      aud: audience,
      sub,
      userId,
      organizationId,
      grantId: typeof payload.grantId === 'string' ? payload.grantId : '',
      clientId: typeof payload.clientId === 'string' ? payload.clientId : '',
      scopes,
      aal: typeof payload.aal === 'string' ? payload.aal : null,
      jti,
      iat,
      exp,
    };
  }
}
