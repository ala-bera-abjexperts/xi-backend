import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SsoEnforcementGuard } from './sso-enforcement.guard';
import { Public } from '../decorators/public.decorator';
import { AllowWithoutSso } from '../decorators/allow-without-sso.decorator';
import { SsoEnforcementService } from '../sso-enforcement.service';
import { SUPER_ADMIN_ROLE } from './super-admin.guard';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type {
  ImpersonationContext,
  RequestUser,
} from '../interfaces/request-user.interface';

class RoutesController {
  plain() {}

  @Public()
  open() {}

  @AllowWithoutSso()
  exempt() {}
}

@AllowWithoutSso()
class ExemptController {
  plain() {}
}

const ORG = 'org-1';
const SESSION = '11111111-1111-4111-8111-111111111111';
const CONNECTION = 'conn-1';

/** Unsigned JWT-shaped token; the guard only decodes the payload. */
function tokenWith(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');

  return `e30.${body}.sig`;
}

function memberUser(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    authUserId: 'auth-1',
    userId: 'user-1',
    email: 'member@example.com',
    organizationId: ORG,
    memberships: [
      { organizationId: ORG, organizationSlug: 'acme', role: 'member' },
    ],
    role: 'user',
    isActive: true,
    appMetadata: {},
    ...overrides,
  };
}

describe('SsoEnforcementGuard', () => {
  let service: SsoEnforcementService;
  let guard: SsoEnforcementGuard;
  let requiresSso: jest.SpyInstance;
  let hasBinding: jest.SpyInstance;

  const context = (
    request: Record<string, unknown>,
    cls: new () => object = RoutesController,
    handler: keyof RoutesController = 'plain',
  ): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => (cls.prototype as Record<string, unknown>)[handler],
      getClass: () => cls,
    }) as unknown as ExecutionContext;

  const withToken = (
    user: RequestUser,
    extra: Record<string, unknown> = {},
  ) => ({
    user,
    headers: {
      authorization: `Bearer ${tokenWith({ session_id: SESSION })}`,
    },
    ...extra,
  });

  const expectSsoRequired = async (ctx: ExecutionContext) => {
    const err = await guard.canActivate(ctx).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toEqual({
      code: 'SSO_REQUIRED',
      message: 'This workspace requires single sign-on',
      data: { connectionId: CONNECTION },
    });
  };

  beforeEach(() => {
    service = new SsoEnforcementService({} as SupabaseAdminService);
    guard = new SsoEnforcementGuard(new Reflector(), service);
    requiresSso = jest.spyOn(service, 'requiresSso').mockResolvedValue(true);
    hasBinding = jest.spyOn(service, 'hasBinding').mockResolvedValue(false);
    jest
      .spyOn(service, 'firstEnabledConnectionId')
      .mockResolvedValue(CONNECTION);
  });

  it('skips @Public routes', async () => {
    await expect(
      guard.canActivate(context({ headers: {} }, RoutesController, 'open')),
    ).resolves.toBe(true);
    expect(requiresSso).not.toHaveBeenCalled();
  });

  it('skips @AllowWithoutSso handlers and controllers', async () => {
    const request = { user: memberUser(), headers: {} };

    await expect(
      guard.canActivate(context(request, RoutesController, 'exempt')),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(context(request, ExemptController)),
    ).resolves.toBe(true);
    expect(requiresSso).not.toHaveBeenCalled();
  });

  it('allows a request without a user or active organization', async () => {
    await expect(guard.canActivate(context({ headers: {} }))).resolves.toBe(
      true,
    );
    await expect(
      guard.canActivate(
        context({
          user: memberUser({ organizationId: '', memberships: [] }),
          headers: {},
        }),
      ),
    ).resolves.toBe(true);
    expect(requiresSso).not.toHaveBeenCalled();
  });

  it('exempts an impersonation overlay', async () => {
    const impersonation = { sessionId: 's' } as ImpersonationContext;

    await expect(
      guard.canActivate(
        context({ user: memberUser({ impersonation }), headers: {} }),
      ),
    ).resolves.toBe(true);
  });

  it('exempts a real super-admin', async () => {
    const user = memberUser({
      role: SUPER_ADMIN_ROLE,
      appMetadata: { role: SUPER_ADMIN_ROLE },
    });

    await expect(
      guard.canActivate(context({ user, headers: {} })),
    ).resolves.toBe(true);
  });

  it('does not exempt a super-admin claim without the matching users.role', async () => {
    const user = memberUser({ appMetadata: { is_super_admin: true } });

    await expectSsoRequired(context({ user, headers: {} }));
  });

  it.each(['owner', 'admin'] as const)(
    'exempts an org %s, read from memberships',
    async (role) => {
      const user = memberUser({
        memberships: [{ organizationId: ORG, organizationSlug: 'acme', role }],
      });

      await expect(
        guard.canActivate(context({ user, headers: {} })),
      ).resolves.toBe(true);
      expect(requiresSso).not.toHaveBeenCalled();
    },
  );

  it('allows members of an org without require_sso', async () => {
    requiresSso.mockResolvedValue(false);

    await expect(
      guard.canActivate(context({ user: memberUser(), headers: {} })),
    ).resolves.toBe(true);
    expect(requiresSso).toHaveBeenCalledWith(ORG);
  });

  it('allows a member whose session is SSO-bound', async () => {
    hasBinding.mockResolvedValue(true);

    await expect(
      guard.canActivate(context(withToken(memberUser()))),
    ).resolves.toBe(true);
  });

  it('reads the access_token cookie when there is no Bearer header', async () => {
    hasBinding.mockResolvedValue(true);

    await expect(
      guard.canActivate(
        context({
          user: memberUser(),
          headers: {},
          cookies: { access_token: tokenWith({ session_id: SESSION }) },
        }),
      ),
    ).resolves.toBe(true);
    expect(hasBinding).toHaveBeenCalledWith(SESSION, ORG, 'auth-1');
  });

  it('rejects a member without a binding with 403 SSO_REQUIRED', async () => {
    await expectSsoRequired(context(withToken(memberUser())));
  });

  it('rejects a member whose token has no session_id', async () => {
    await expectSsoRequired(
      context({
        user: memberUser(),
        headers: { authorization: `Bearer ${tokenWith({ sub: 'auth-1' })}` },
      }),
    );
    expect(hasBinding).not.toHaveBeenCalled();
  });

  it('rejects an MCP S2S member without looking for a binding', async () => {
    hasBinding.mockResolvedValue(true);

    await expectSsoRequired(
      context(withToken(memberUser(), { _mcpS2s: true })),
    );
    expect(hasBinding).not.toHaveBeenCalled();
  });

  it("does not accept another auth user's binding", async () => {
    hasBinding.mockImplementation(
      (_session: string, _org: string, authUserId: string) =>
        Promise.resolve(authUserId === 'someone-else'),
    );

    await expectSsoRequired(context(withToken(memberUser())));
    expect(hasBinding).toHaveBeenCalledWith(SESSION, ORG, 'auth-1');
  });
});
