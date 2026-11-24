import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { DEFAULT_PERMISSIONS_BY_ROLE } from '../permissions/models/access-control.model';
import { PermissionsService } from '../permissions/permissions.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  CHAT_PERMISSION_KEYS,
  ChatPermissionGuard,
  RequireChatPermission,
} from './chat-permission.guard';

/** Thenable query double: every builder call returns itself. */
function chain(result: { data: unknown; error?: unknown }) {
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === 'then') {
          return (
            resolve: (v: unknown) => unknown,
            reject: (e: unknown) => unknown,
          ) =>
            Promise.resolve({ error: null, ...result }).then(resolve, reject);
        }
        return () => proxy;
      },
    },
  );
  return proxy;
}

@RequireChatPermission('can_use_chat')
class Fixture {
  read() {}

  @RequireChatPermission('can_create_chat_groups')
  createGroup() {}
}

describe('ChatPermissionGuard', () => {
  const SPACE = '99999999-9999-4999-8999-999999999999';
  let from: jest.Mock;

  /**
   * The guard on top of the REAL PermissionsService, fed by a database double:
   * the caller's base role plus an optional override of that role's defaults,
   * and the permissions of the custom roles assigned to the caller.
   */
  const guardFor = (
    role: string,
    override: Record<string, boolean> | null = null,
    customRoles: Record<string, boolean>[] = [],
  ) => {
    const tables: Record<string, unknown> = {
      organization_members: { role },
      user_role_assignments: customRoles.map((permissions) => ({
        role: {
          base_role: 'admin',
          permissions,
          is_active: true,
          is_deleted: false,
        },
      })),
      user_group_members: [],
      base_role_permission_overrides: override && { permissions: override },
    };
    from = jest.fn((table: string) => {
      if (!(table in tables)) throw new Error(`unexpected query on ${table}`);
      return chain({ data: tables[table] });
    });

    return new ChatPermissionGuard(
      new Reflector(),
      new PermissionsService({
        getClient: () => ({ from }),
      } as unknown as SupabaseAdminService),
    );
  };

  const context = (
    handler: keyof Fixture,
    request: Record<string, unknown> = {},
  ) =>
    ({
      getClass: () => Fixture,
      getHandler: () => Fixture.prototype[handler],
      switchToHttp: () => ({
        getRequest: () => ({
          user: { userId: 'user-1', organizationId: 'org-1' },
          ...request,
        }),
      }),
    }) as unknown as ExecutionContext;

  it.each(['owner', 'admin', 'member', 'viewer'])(
    'lets a %s with the default permissions through',
    async (role) => {
      const guard = guardFor(role);

      await expect(guard.canActivate(context('read'))).resolves.toBe(true);
      await expect(guard.canActivate(context('createGroup'))).resolves.toBe(
        true,
      );
    },
  );

  it('answers 403 without the key', async () => {
    const guard = guardFor('member', { can_use_chat: false });

    await expect(guard.canActivate(context('read'))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('a custom role does not hand a removed key back, unless it holds the key itself (ADM-08)', async () => {
    const removed = { can_use_chat: false };

    // An admin-based custom role: its base-role defaults include can_use_chat.
    await expect(
      guardFor('member', removed, [{ can_edit_tasks: true }]).canActivate(
        context('read'),
      ),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      guardFor('member', removed, [{}, { can_use_chat: true }]).canActivate(
        context('read'),
      ),
    ).resolves.toBe(true);
  });

  it('requires the class key AND the handler key (neither replaces the other)', async () => {
    // Holds the handler key only: the shared guard would let this through.
    await expect(
      guardFor('member', { can_use_chat: false }).canActivate(
        context('createGroup'),
      ),
    ).rejects.toThrow(ForbiddenException);

    // Holds the class key only.
    const guard = guardFor('member', { can_create_chat_groups: false });
    await expect(guard.canActivate(context('createGroup'))).rejects.toThrow(
      ForbiddenException,
    );
    await expect(guard.canActivate(context('read'))).resolves.toBe(true);
  });

  it('ignores a spaceId in query, params and body (no space-level fallback)', async () => {
    const guard = guardFor('member', { can_use_chat: false });

    await expect(
      guard.canActivate(
        context('read', {
          query: { spaceId: SPACE },
          params: { spaceId: SPACE },
          body: { spaceId: SPACE, space_id: SPACE },
        }),
      ),
    ).rejects.toThrow(ForbiddenException);

    // Only the organization-level tables were read; `from` throws on any other.
    expect(from.mock.calls.map(([table]) => table as string).sort()).toEqual([
      'base_role_permission_overrides',
      'organization_members',
      'user_group_members',
      'user_role_assignments',
    ]);
  });

  it('answers 403 when the request carries no user', async () => {
    await expect(
      guardFor('owner').canActivate(context('read', { user: undefined })),
    ).rejects.toThrow(ForbiddenException);
  });

  it('the decorator attaches the guard itself, on a class and on a handler', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, Fixture)).toEqual([
      ChatPermissionGuard,
    ]);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, context('createGroup').getHandler()),
    ).toEqual([ChatPermissionGuard]);
  });

  it('gives every key the base-role defaults of the contract', () => {
    const everyone = [
      'can_use_chat',
      'can_create_chat_groups',
      'can_use_robert',
    ];
    const table = Object.fromEntries(
      Object.entries(DEFAULT_PERMISSIONS_BY_ROLE).map(([role, preset]) => [
        role,
        CHAT_PERMISSION_KEYS.filter((key) => preset[key] === true),
      ]),
    );

    expect(table).toEqual({
      owner: [...CHAT_PERMISSION_KEYS],
      admin: [...CHAT_PERMISSION_KEYS],
      member: CHAT_PERMISSION_KEYS.filter((key) => everyone.includes(key)),
      viewer: CHAT_PERMISSION_KEYS.filter((key) => everyone.includes(key)),
    });

    // false, never undefined: an undeclared key could not be told from a typo.
    for (const preset of Object.values(DEFAULT_PERMISSIONS_BY_ROLE)) {
      for (const key of CHAT_PERMISSION_KEYS) {
        expect(typeof preset[key]).toBe('boolean');
      }
    }
  });
});
