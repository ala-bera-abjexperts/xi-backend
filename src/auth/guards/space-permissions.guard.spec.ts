/**
 * @fileoverview Unit tests for SpacePermissionsGuard — the app-wide gate for every
 * `@RequireSpacePermission` route. Pins the CURRENT resolution rule so it can be
 * refactored onto a shared helper without silently changing who is allowed in:
 * metadata short-circuit, spaceId extraction order, org admin/owner bypass,
 * membership requirement, explicit-permission grant, and base-role fallback.
 *
 * The base-role fallback case matters most: a `false` stored on the membership row
 * must NOT deny, because the row is only consulted for explicit `true` grants.
 * @module src/auth/guards/space-permissions.guard.spec
 * @author Prince Jadiya
 */

import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SpacePermissionsGuard } from './space-permissions.guard';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { PermissionsService } from '../../permissions/permissions.service';

describe('SpacePermissionsGuard', () => {
  let guard: SpacePermissionsGuard;
  let reflector: Reflector;
  let mockFrom: jest.Mock;
  let isAdminOrOwner: jest.Mock;

  const USER = 'user-1';
  const ORG = 'org-1';
  const SPACE = 'space-1';

  function buildChain(resolved: { data: unknown; error?: unknown }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;

    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled);

    return chain;
  }

  const mockContext = (request: Record<string, unknown>): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    }) as unknown as ExecutionContext;

  const requestFor = (over: Record<string, unknown> = {}) => ({
    user: { userId: USER, organizationId: ORG },
    params: { spaceId: SPACE },
    query: {},
    ...over,
  });

  /** Stub the space_members lookup with a single row (or null for non-member). */
  const withMember = (row: unknown) =>
    mockFrom.mockReturnValueOnce(buildChain({ data: row, error: null }));

  beforeEach(() => {
    reflector = new Reflector();
    mockFrom = jest.fn();

    const supa = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;

    // A REAL PermissionsService, so these cases exercise the guard together with
    // resolveSpaceBaseGrant — the rule under test spans both. Only isAdminOrOwner is
    // stubbed, so `mockFrom` is consumed solely by the space_members lookup.
    const perms = new PermissionsService(supa);

    isAdminOrOwner = jest
      .spyOn(perms, 'isAdminOrOwner')
      .mockResolvedValue(false) as unknown as jest.Mock;

    guard = new SpacePermissionsGuard(reflector, perms);
  });

  const requirePermission = (permission: string | undefined) =>
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(permission);

  // ── Metadata short-circuit ────────────────────────────────────────────────

  it('allows a route with no @RequireSpacePermission without touching the DB', async () => {
    requirePermission(undefined);

    await expect(guard.canActivate(mockContext({}))).resolves.toBe(true);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(isAdminOrOwner).not.toHaveBeenCalled();
  });

  // ── Request preconditions ─────────────────────────────────────────────────

  it('rejects a request with no authenticated user', async () => {
    requirePermission('view_file_explorer');

    await expect(
      guard.canActivate(mockContext({ params: { spaceId: SPACE } })),
    ).rejects.toThrow(new ForbiddenException('No user context found'));
  });

  it('rejects a request that carries no space id', async () => {
    requirePermission('view_file_explorer');

    await expect(
      guard.canActivate(
        mockContext(requestFor({ params: {}, query: {}, body: {} })),
      ),
    ).rejects.toThrow(new BadRequestException('spaceId is required'));
  });

  it.each([
    ['params.spaceId', { params: { spaceId: SPACE } }],
    ['params.id', { params: { id: SPACE } }],
    ['query.spaceId', { params: {}, query: { spaceId: SPACE } }],
    ['body.spaceId', { params: {}, query: {}, body: { spaceId: SPACE } }],
    ['body.space_id', { params: {}, query: {}, body: { space_id: SPACE } }],
  ])('resolves the space id from %s', async (_label, over) => {
    requirePermission('view_file_explorer');
    isAdminOrOwner.mockResolvedValue(true);

    await expect(
      guard.canActivate(mockContext(requestFor(over))),
    ).resolves.toBe(true);
  });

  // ── Org admin/owner bypass ────────────────────────────────────────────────

  it('lets an org admin/owner through without a space_members row', async () => {
    requirePermission('delete_file_explorer');
    isAdminOrOwner.mockResolvedValue(true);

    await expect(guard.canActivate(mockContext(requestFor()))).resolves.toBe(
      true,
    );
    expect(mockFrom).not.toHaveBeenCalled();
  });

  // ── Membership requirement ────────────────────────────────────────────────

  it('rejects a non-member', async () => {
    requirePermission('view_file_explorer');
    withMember(null);

    await expect(guard.canActivate(mockContext(requestFor()))).rejects.toThrow(
      new ForbiddenException('Not a member of this space'),
    );
  });

  // ── Explicit grant on the membership row ──────────────────────────────────

  it('grants when the membership row explicitly sets the flat key true', async () => {
    requirePermission('share_file_explorer');
    withMember({
      space_role: 'viewer',
      permissions: { share_file_explorer: true },
    });

    await expect(guard.canActivate(mockContext(requestFor()))).resolves.toBe(
      true,
    );
  });

  it('strips the can_ prefix before the flat-key lookup', async () => {
    requirePermission('can_edit_tasks');
    withMember({ space_role: 'viewer', permissions: { edit_tasks: true } });

    await expect(guard.canActivate(mockContext(requestFor()))).resolves.toBe(
      true,
    );
  });

  // ── Base-role fallback ────────────────────────────────────────────────────

  it('falls back to the base space role when the row grants nothing', async () => {
    requirePermission('view_file_explorer');
    withMember({ space_role: 'viewer', permissions: {} });

    await expect(guard.canActivate(mockContext(requestFor()))).resolves.toBe(
      true,
    );
  });

  it('tolerates a null permissions column', async () => {
    requirePermission('view_file_explorer');
    withMember({ space_role: 'member', permissions: null });

    await expect(guard.canActivate(mockContext(requestFor()))).resolves.toBe(
      true,
    );
  });

  it('REGRESSION: an explicit false on the row does not deny when the base role grants it', async () => {
    // The row is consulted only for `=== true`; a stored false falls through to the
    // base role. This is what keeps File Explorer listing working for users whose
    // space_permissions/space_members rows carry backfilled false values.
    requirePermission('view_file_explorer');
    withMember({
      space_role: 'admin',
      permissions: { view_file_explorer: false },
    });

    await expect(guard.canActivate(mockContext(requestFor()))).resolves.toBe(
      true,
    );
  });

  it('denies when neither the row nor the base role grants the permission', async () => {
    requirePermission('delete_file_explorer');
    withMember({ space_role: 'viewer', permissions: {} });

    await expect(guard.canActivate(mockContext(requestFor()))).rejects.toThrow(
      new ForbiddenException('Insufficient space permissions'),
    );
  });

  it('denies when the space_role is not a known base role', async () => {
    // Unknown roles are looked up verbatim — no normalisation — so they grant nothing.
    requirePermission('view_file_explorer');
    withMember({ space_role: 'Guest', permissions: {} });

    await expect(guard.canActivate(mockContext(requestFor()))).rejects.toThrow(
      new ForbiddenException('Insufficient space permissions'),
    );
  });

  it('scopes the admin check to the caller and their active organization', async () => {
    requirePermission('view_file_explorer');
    isAdminOrOwner.mockResolvedValue(true);

    await guard.canActivate(mockContext(requestFor()));

    expect(isAdminOrOwner).toHaveBeenCalledWith(USER, ORG);
  });

  describe('Test Management keys follow the per-space overrides', () => {
    type Result = { data: unknown; error: { message: string } | null };

    let calls: { table: string; chain: Record<string, jest.Mock> }[];

    /** Queues one result per read, in the order resolveTestManagementPermissions reads them. */
    const seed = (over: {
      space?: unknown;
      own?: unknown[];
      groups?: unknown[];
      roles?: unknown[];
      shared?: unknown[];
      overrides?: unknown[];
      overrideError?: { message: string };
    }) => {
      const queue: Result[] = [
        { data: 'space' in over ? over.space : { id: SPACE }, error: null },
        { data: over.own ?? [], error: null },
        { data: over.groups ?? [], error: null },
        { data: over.roles ?? [], error: null },
        { data: over.shared ?? [], error: null },
        { data: over.overrides ?? [], error: over.overrideError ?? null },
      ];

      calls = [];
      mockFrom.mockImplementation((table: string) => {
        const result = queue.shift() ?? { data: [], error: null };
        const chain: Record<string, jest.Mock> = {};

        for (const name of ['select', 'eq', 'in']) {
          chain[name] = jest.fn(() => chain);
        }
        chain.maybeSingle = jest.fn().mockResolvedValue(result);
        (chain as unknown as PromiseLike<Result>).then = ((
          onFulfilled: (value: Result) => unknown,
        ) =>
          Promise.resolve(result).then(
            onFulfilled,
          )) as unknown as PromiseLike<Result>['then'];
        calls.push({ table, chain });

        return chain;
      });
    };
    const member = { space_role: 'member', permissions: null };
    const inGroup = (id: string) => ({
      group_id: id,
      role_id: null,
      group: { organization_id: ORG, is_deleted: false },
    });
    const groupMembership = (id: string) => ({
      space_role: 'member',
      member_type: 'group',
      group_id: id,
      role_id: null,
    });
    const row = (
      target_type: string,
      target_id: string,
      permissions: Record<string, boolean>,
    ) => ({ target_type, target_id, permissions });
    const insufficient = new ForbiddenException(
      'Insufficient space permissions',
    );

    it('gives a member the role defaults: create allowed, delete refused', async () => {
      seed({ own: [member] });
      requirePermission('create_tests');

      await expect(guard.canActivate(mockContext(requestFor()))).resolves.toBe(
        true,
      );

      seed({ own: [member] });
      requirePermission('delete_tests');

      await expect(
        guard.canActivate(mockContext(requestFor())),
      ).rejects.toThrow(insufficient);
    });

    it('denies when the base-role row switches the module off', async () => {
      const off = {
        can_view_tests: false,
        can_create_tests: false,
        can_edit_tests: false,
        can_delete_tests: false,
        can_manage_test_runs: false,
        can_execute_tests: false,
      };

      seed({ own: [member], overrides: [row('base_role', 'member', off)] });
      requirePermission('view_tests');

      await expect(
        guard.canActivate(mockContext(requestFor())),
      ).rejects.toThrow(insufficient);
    });

    it('lets a user row win over the base-role row', async () => {
      seed({
        own: [member],
        overrides: [
          row('base_role', 'member', { can_delete_tests: false }),
          row('user', USER, { can_delete_tests: true }),
        ],
      });
      requirePermission('delete_tests');

      await expect(guard.canActivate(mockContext(requestFor()))).resolves.toBe(
        true,
      );
    });

    it('lets an explicit false win when two groups at the same level disagree', async () => {
      seed({
        own: [member],
        groups: [inGroup('g-1'), inGroup('g-2')],
        shared: [groupMembership('g-1'), groupMembership('g-2')],
        overrides: [
          row('group', 'g-1', { can_execute_tests: true }),
          row('group', 'g-2', { can_execute_tests: false }),
        ],
      });
      requirePermission('execute_tests');

      await expect(
        guard.canActivate(mockContext(requestFor())),
      ).rejects.toThrow(insufficient);
    });

    it('ignores override rows of a group that is not a member of the space', async () => {
      seed({
        own: [member],
        groups: [inGroup('g-old')],
        overrides: [row('group', 'g-old', { can_execute_tests: false })],
      });
      requirePermission('execute_tests');

      await expect(guard.canActivate(mockContext(requestFor()))).resolves.toBe(
        true,
      );
    });

    it('admits a member who reaches the space only through a group', async () => {
      seed({ groups: [inGroup('g-1')], shared: [groupMembership('g-1')] });
      requirePermission('view_tests');

      await expect(guard.canActivate(mockContext(requestFor()))).resolves.toBe(
        true,
      );
    });

    it('reads the own row without a member_type filter, so legacy rows count', async () => {
      seed({ own: [member] });
      requirePermission('view_tests');

      await guard.canActivate(mockContext(requestFor()));

      const ownRead = calls.filter((call) => call.table === 'space_members')[0];

      expect(ownRead.chain.eq).not.toHaveBeenCalledWith('member_type', 'user');
    });

    it('treats an action as implying view, so screen and API agree', async () => {
      seed({
        own: [{ space_role: 'viewer', permissions: null }],
        overrides: [
          row('base_role', 'viewer', {
            can_view_tests: false,
            can_execute_tests: true,
          }),
        ],
      });
      requirePermission('view_tests');

      await expect(guard.canActivate(mockContext(requestFor()))).resolves.toBe(
        true,
      );
    });

    it('refuses a user who is no member at all', async () => {
      seed({});
      requirePermission('can_view_tests');

      await expect(
        guard.canActivate(mockContext(requestFor())),
      ).rejects.toThrow(new ForbiddenException('Not a member of this space'));
    });

    it('refuses a space of another organization, even for an org admin', async () => {
      seed({ space: null });
      isAdminOrOwner.mockResolvedValue(true);
      requirePermission('view_tests');

      await expect(
        guard.canActivate(mockContext(requestFor())),
      ).rejects.toThrow(new ForbiddenException('Not a member of this space'));
    });

    it('ignores a stored owner row, so space owners keep every key', async () => {
      seed({
        own: [{ space_role: 'owner', permissions: null }],
        overrides: [row('base_role', 'owner', { can_delete_tests: false })],
      });
      requirePermission('delete_tests');

      await expect(guard.canActivate(mockContext(requestFor()))).resolves.toBe(
        true,
      );
    });

    it('gives an org admin every key in a space of their organization', async () => {
      seed({});
      isAdminOrOwner.mockResolvedValue(true);
      requirePermission('delete_tests');

      await expect(guard.canActivate(mockContext(requestFor()))).resolves.toBe(
        true,
      );
    });

    it('fails closed with a 500 when the overrides cannot be read', async () => {
      seed({ own: [member], overrideError: { message: 'boom' } });
      requirePermission('view_tests');

      await expect(
        guard.canActivate(mockContext(requestFor())),
      ).rejects.toThrow(
        new InternalServerErrorException(
          'Test Management permissions could not be read',
        ),
      );
    });
  });
});
