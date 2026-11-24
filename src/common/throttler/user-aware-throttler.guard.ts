/**
 * @fileoverview Throttler guard that keys rate-limit buckets by authenticated user when
 * possible, falling back to client IP for anonymous traffic. Replaces the stock
 * ThrottlerGuard's pure IP-based bucketing, which collapses all users behind a
 * reverse proxy into one shared bucket.
 *
 * The user identity is extracted by **decoding the JWT without verifying its
 * signature**. This is safe for tracking purposes:
 *   - The `sub` claim is just a bucket key; an attacker forging a fake JWT
 *     routes their traffic into the fake user's bucket, filling their own quota.
 *   - The downstream SupabaseAuthGuard performs the real signature verification
 *     before any handler runs, so forged tokens never reach business logic.
 *
 * That reasoning holds ONLY on authenticated routes. On a `@Public()` route
 * SupabaseAuthGuard short-circuits and returns true regardless of the token, so
 * nothing downstream ever rejects a forgery — an attacker sending an unsigned
 * JWT with a fresh random `sub` per request would mint a brand-new bucket every
 * time and the limit would stop existing. Public routes are therefore keyed on
 * IP only; see `handleRequest` below.
 *
 * Decoding is intentionally tolerant — any failure mode falls back to IP-based
 * tracking. This guard must never throw or block a request from reaching its
 * handler (failing closed here would convert a partial outage into a total one).
 *
 * @module src/common/throttler/user-aware-throttler.guard
 */

import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerRequest } from '@nestjs/throttler';
import { createHash } from 'crypto';
import type { Request } from 'express';
import { decodeJwt } from 'jose';
import { IS_PUBLIC_KEY } from '../../auth/decorators/public.decorator';
import { readTmAccessToken } from '../../auth/tm-access-token';

/**
 * Marker stamped on the request by {@link UserAwareThrottlerGuard.handleRequest}
 * when the resolved route is `@Public()`. A symbol keeps it off any serialized
 * shape and cannot collide with an Express or user-land property.
 */
const PUBLIC_ROUTE = Symbol.for('throttler.publicRoute');

/**
 * Drop-in replacement for the stock {@link ThrottlerGuard} that buckets
 * authenticated requests by `sub` (Supabase user id) and anonymous requests by
 * client IP.
 *
 * Bucket key format:
 *   - `user:<uuid>` when an `Authorization: Bearer …` header or `access_token`
 *     cookie contains a decodable JWT with a `sub` claim.
 *   - `ip:<address>` otherwise. The address is derived from Express's `req.ip`,
 *     which respects the `trust proxy` setting configured in main.ts.
 *
 * The `user:` / `ip:` prefixes prevent cross-class bucket collisions (e.g., a
 * user id that happens to match an IP string format).
 */
@Injectable()
export class UserAwareThrottlerGuard extends ThrottlerGuard {
  /**
   * Flags `@Public()` routes before delegating to the stock implementation.
   *
   * `getTracker` receives only the request, not the {@link ExecutionContext},
   * so the public/authenticated distinction has to be resolved here — this is
   * the first override in the chain that can see both.
   *
   * @param requestProps Throttler context supplied by the parent guard.
   * @returns Whatever the parent decides; this override only adds the marker.
   */
  protected handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const { context } = requestProps;

    // `reflector` is injected by Nest in production. Guard the lookup anyway so
    // a directly-constructed instance (as in the unit spec) cannot throw here.
    const isPublic =
      this.reflector?.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true;

    if (isPublic) {
      const { req } = this.getRequestResponse(context);

      (req as Record<symbol, unknown>)[PUBLIC_ROUTE] = true;
    }

    return super.handleRequest(requestProps);
  }

  /**
   * Resolves the bucket tracker for the incoming request.
   *
   * Order of resolution:
   *   1. Read JWT from `Authorization: Bearer …` header (preferred — most
   *      explicit signal of an authenticated request).
   *   2. Read JWT from `access_token` cookie (when the frontend uses
   *      `credentials: 'include'`).
   *   3. Read JWT from `X-MCP-S2S-Authorization: Bearer ...` header (S2S calls
   *      from the MCP server, which carry neither of the above).
   *   4. Decode the JWT with no signature check. Return `user:<sub>` on success.
   *   5. Fall back to `ip:<req.ip>` on any failure (missing token, malformed,
   *      no `sub` claim, unexpected exception).
   *
   * @param req The Express request. Cast to a permissive shape because
   *   `@nestjs/throttler` types `getTracker` as accepting `Record<string, any>`.
   * @returns A bucket key string. Never throws.
   */
  // Parent ThrottlerGuard types `getTracker` as `Promise<string>`, so we keep
  // an async signature even though our implementation is synchronous.
  // eslint-disable-next-line @typescript-eslint/require-await
  protected async getTracker(req: Record<string, any>): Promise<string> {
    // Public routes: IP only. A token presented here is never verified by
    // anything downstream, so honouring its `sub` would let a caller choose
    // their own bucket and rotate it at will.
    if ((req as Record<symbol, unknown>)[PUBLIC_ROUTE] === true) {
      return `ip:${(req as Request).ip || 'unknown'}`;
    }

    try {
      const request = req as Request;
      const token = this.extractToken(request);

      // Test Management API keys are not JWTs; each key gets its own bucket, never the shared IP one.
      if (token?.startsWith('xis_tm_')) {
        return `tmkey:${readTmAccessToken(token)?.keyId ?? createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
      }

      if (token) {
        const payload = decodeJwt(token);
        const sub = typeof payload.sub === 'string' ? payload.sub : undefined;

        if (sub) {
          return `user:${sub}`;
        }
      }
    } catch {
      // Decode failed (malformed JWT, unexpected payload shape, etc.). Fall
      // through to IP tracking — never block a request from this guard.
    }

    // `req.ip` respects Express's `trust proxy` setting. In dev with
    // `TRUST_PROXY_HOPS=0`, this is the real socket peer. With a numeric hop
    // count N, `proxy-addr` walks N entries in from the socket peer — i.e. the
    // RIGHTMOST X-Forwarded-For entry for N=1, not the leftmost. The two
    // coincide only when XFF carries exactly one address, so tune
    // TRUST_PROXY_HOPS against the real proxy depth, never against the leftmost
    // value (which is fully client-supplied and therefore forgeable).
    const ip = (req as Request).ip || 'unknown';

    return `ip:${ip}`;
  }

  /**
   * Extracts a candidate JWT from the request. No validation — pure parsing.
   *
   * @returns The raw JWT string, or `undefined` if no candidate exists.
   */
  private extractToken(request: Request): string | undefined {
    const authHeader = request.headers?.authorization;

    if (
      typeof authHeader === 'string' &&
      authHeader.toLowerCase().startsWith('bearer ')
    ) {
      const token = authHeader.slice(7).trim();

      if (token) return token;
    }

    // Parse the access_token from the raw Cookie header. Reading directly from
    // headers (rather than `req.cookies`) sidesteps the `any`-typed shape that
    // `cookie-parser` populates on the request object.
    const cookieHeader = request.headers?.cookie;

    if (typeof cookieHeader === 'string' && cookieHeader.length > 0) {
      // Naive but safe parser: `name=value; name2=value2`. We only need the
      // access_token; full parsing is not required.
      const match = /(?:^|;\s*)access_token=([^;]+)/.exec(cookieHeader);

      if (match && match[1]) {
        return decodeURIComponent(match[1]);
      }
    }

    // S2S requests from the MCP server carry no Authorization header or cookie;
    // they present a dedicated `X-MCP-S2S-Authorization: Bearer <jwt>` whose
    // `sub` is the acting user's auth id. Reading it here buckets each S2S user
    // under `user:<sub>` instead of collapsing all S2S traffic into one shared
    // `ip:` bucket (which would 429 under concurrent multi-user load). Same
    // tracking-only safety as the other sources: the value is decoded but never
    // verified; the McpServiceTokenGuard performs the real signature check.
    const s2sHeader = request.headers?.['x-mcp-s2s-authorization'];

    if (
      typeof s2sHeader === 'string' &&
      s2sHeader.toLowerCase().startsWith('bearer ')
    ) {
      const token = s2sHeader.slice(7).trim();

      if (token) return token;
    }

    return undefined;
  }
}
