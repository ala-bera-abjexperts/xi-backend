import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ImpersonationBlockedGuard } from './impersonation-blocked.guard';
import type { ImpersonationContext } from '../interfaces/request-user.interface';

describe('ImpersonationBlockedGuard', () => {
  let guard: ImpersonationBlockedGuard;
  let reflector: Reflector;

  const impersonation = {
    sessionId: 'session-1',
  } as unknown as ImpersonationContext;

  const mockContext = (request: Record<string, unknown>): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new ImpersonationBlockedGuard(reflector);
  });

  it('allows a normal (non-blocked, non-impersonating) request', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const context = mockContext({ user: { userId: 'u1' } });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('blocks a @ImpersonationBlocked route while impersonating', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const context = mockContext({ user: { userId: 'u1', impersonation } });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('CANARY: rejects an S2S request that somehow carries an impersonation overlay', () => {
    // Not a @ImpersonationBlocked route, but the canary must fire regardless of
    // the decorator, because S2S plus impersonation is a privilege-escalation bug.
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const context = mockContext({
      _mcpS2s: true,
      user: { userId: 'u1', impersonation },
    });

    expect(() => guard.canActivate(context)).toThrow(
      'Impersonation is not permitted on service-to-service requests.',
    );
  });

  it('allows a clean S2S request (no impersonation overlay)', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const context = mockContext({
      _mcpS2s: true,
      user: { userId: 'u1' },
    });

    expect(guard.canActivate(context)).toBe(true);
  });
});
