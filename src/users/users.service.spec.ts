import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { UsersService, PublicUser } from './users.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';

/** Minimal PermissionsService stand-in; only `bustOrg` is reached from this service. */
function mockPermissionsService(): PermissionsService {
  return { bustOrg: jest.fn() } as unknown as PermissionsService;
}

describe('UsersService', () => {
  let service: UsersService;
  let mockMaybeSingle: jest.Mock;

  const mockUser: PublicUser = {
    id: 'user-1',
    email: 'test@example.com',
    first_name: 'Test',
    last_name: 'User',
    auth_user_id: 'auth-1',
    organization_id: 'org-1',
    avatar_url: null,
    avatar_path: null,
    mobile: null,
    role: null,
    country: null,
    language: null,
    date_of_birth: null,
    cover_image_url: null,
    cover_image_path: null,
    is_active: true,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };

  beforeEach(() => {
    mockMaybeSingle = jest.fn();
    const supabaseAdmin = {
      getClient: () => ({
        from: () => ({
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: mockMaybeSingle,
        }),
      }),
    } as unknown as SupabaseAdminService;

    service = new UsersService(supabaseAdmin, mockPermissionsService());
  });

  describe('getUserByAuthUserId', () => {
    it('should return user when found', async () => {
      mockMaybeSingle.mockResolvedValue({ data: mockUser, error: null });
      const result = await service.getUserByAuthUserId('auth-1');
      expect(result).toEqual(mockUser);
    });

    it('should return null when not found', async () => {
      mockMaybeSingle.mockResolvedValue({ data: null, error: null });
      const result = await service.getUserByAuthUserId('nonexistent');
      expect(result).toBeNull();
    });

    it('throws 503 on a query error instead of reporting "not found"', async () => {
      mockMaybeSingle.mockResolvedValue({
        data: null,
        error: { message: 'DB error' },
      });
      await expect(service.getUserByAuthUserId('auth-1')).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });

  describe('getUserByEmail', () => {
    it('should return user when found', async () => {
      mockMaybeSingle.mockResolvedValue({ data: mockUser, error: null });
      const result = await service.getUserByEmail('test@example.com');
      expect(result).toEqual(mockUser);
    });

    it('should return null when not found', async () => {
      mockMaybeSingle.mockResolvedValue({ data: null, error: null });
      const result = await service.getUserByEmail('nonexistent@example.com');
      expect(result).toBeNull();
    });
  });

  describe('getUserById', () => {
    it('should return user when found', async () => {
      mockMaybeSingle.mockResolvedValue({ data: mockUser, error: null });
      const result = await service.getUserById('user-1');
      expect(result).toEqual(mockUser);
    });

    it('should return null when not found', async () => {
      mockMaybeSingle.mockResolvedValue({ data: null, error: null });
      const result = await service.getUserById('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('searchUsers', () => {
    /**
     * Builds a Supabase client mock that dispatches per table:
     *   - `organization_members` resolves with the configured members rows
     *   - `users` returns a thenable builder that captures `.in/.limit/.or`
     *
     * Returned `spies` lets each test assert on call shape.
     */
    function buildSearchService(opts: {
      members: { data: unknown; error: unknown };
      users: { data: unknown; error: unknown };
    }): {
      service: UsersService;
      spies: {
        usersIn: jest.Mock;
        usersLimit: jest.Mock;
        usersOr: jest.Mock;
        usersSelect: jest.Mock;
      };
    } {
      const usersIn = jest.fn();
      const usersLimit = jest.fn();
      const usersOr = jest.fn();
      const usersSelect = jest.fn();

      // The users query builder is thenable so `await query` resolves it.
      const usersBuilder: Record<string, jest.Mock> & {
        then?: (resolve: (r: unknown) => void) => void;
      } = {
        select: usersSelect,
        in: usersIn,
        limit: usersLimit,
        or: usersOr,
      };
      usersSelect.mockReturnValue(usersBuilder);
      usersIn.mockReturnValue(usersBuilder);
      usersLimit.mockReturnValue(usersBuilder);
      usersOr.mockReturnValue(usersBuilder);
      usersBuilder.then = (resolve) => resolve(opts.users);

      const supabaseAdmin = {
        getClient: () => ({
          from: (table: string) => {
            if (table === 'organization_members') {
              return {
                select: jest.fn().mockReturnThis(),
                eq: jest.fn().mockResolvedValue(opts.members),
              };
            }
            if (table === 'users') return usersBuilder;
            throw new Error(`unexpected table: ${table}`);
          },
        }),
      } as unknown as SupabaseAdminService;

      return {
        service: new UsersService(supabaseAdmin, mockPermissionsService()),
        spies: { usersIn, usersLimit, usersOr, usersSelect },
      };
    }

    it('returns mapped picker rows for members matching the query', async () => {
      const { service: svc, spies } = buildSearchService({
        members: {
          data: [{ user_id: 'u1' }, { user_id: 'u2' }],
          error: null,
        },
        users: {
          data: [
            {
              id: 'u1',
              first_name: 'Alice',
              last_name: 'Smith',
              email: 'alice@example.com',
              avatar_url: 'https://example.com/a.png',
            },
            {
              id: 'u2',
              first_name: null,
              last_name: null,
              email: 'bob@example.com',
              avatar_url: null,
            },
          ],
          error: null,
        },
      });

      const result = await svc.searchUsers('org-1', 'ali', 20);

      expect(result).toEqual([
        {
          id: 'u1',
          name: 'Alice Smith',
          email: 'alice@example.com',
          avatar_url: 'https://example.com/a.png',
        },
        {
          // Falls back to email when no name parts are set
          id: 'u2',
          name: 'bob@example.com',
          email: 'bob@example.com',
          avatar_url: null,
        },
      ]);

      // ilike applied across first_name, last_name, email
      expect(spies.usersOr).toHaveBeenCalledWith(
        'first_name.ilike.%ali%,last_name.ilike.%ali%,email.ilike.%ali%',
      );
      // Org scoping passes the resolved user ids
      expect(spies.usersIn).toHaveBeenCalledWith('id', ['u1', 'u2']);
      // limit honored
      expect(spies.usersLimit).toHaveBeenCalledWith(20);
    });

    it('short-circuits with empty array when the org has no members', async () => {
      const { service: svc, spies } = buildSearchService({
        members: { data: [], error: null },
        users: { data: [], error: null },
      });

      const result = await svc.searchUsers('empty-org', 'anything', 20);

      expect(result).toEqual([]);
      // No follow-up query against `users` when there are no member ids
      expect(spies.usersSelect).not.toHaveBeenCalled();
    });

    it('skips the ilike clause when q is empty or whitespace', async () => {
      const { service: svc, spies } = buildSearchService({
        members: { data: [{ user_id: 'u1' }], error: null },
        users: {
          data: [
            {
              id: 'u1',
              first_name: 'Carol',
              last_name: 'Lee',
              email: 'carol@example.com',
              avatar_url: null,
            },
          ],
          error: null,
        },
      });

      const result = await svc.searchUsers('org-1', '   ', 20);

      expect(result).toHaveLength(1);
      expect(spies.usersOr).not.toHaveBeenCalled();
    });
  });

  describe('updateOrganizationMemberRole', () => {
    interface RoleChangeOpts {
      /** Row returned for the tenant-scoped member lookup, or null for "absent". */
      member?: { role: string } | null;
      /** Error surfaced by the UPDATE, e.g. the last-owner trigger. */
      updateError?: { message: string; code?: string } | null;
    }

    function buildService(opts: RoleChangeOpts = {}) {
      const bustOrg = jest.fn();
      const logActionForRequest = jest.fn().mockResolvedValue(undefined);
      const update = jest.fn();

      /** Every `.eq()` argument pair seen on the member lookup. */
      const lookupFilters: Array<[string, unknown]> = [];

      const maybeSingle = jest.fn().mockResolvedValue({
        data: opts.member === undefined ? { role: 'member' } : opts.member,
        error: null,
      });

      // Annotated explicitly: `chain.eq` returns `chain`, and an inferred type
      // for a self-referential object literal collapses to `any`.
      interface LookupChain {
        eq: jest.Mock;
        maybeSingle: jest.Mock;
      }

      function lookupChain(): LookupChain {
        const chain: LookupChain = {
          eq: jest.fn((column: string, value: unknown) => {
            lookupFilters.push([column, value]);

            return chain;
          }),
          maybeSingle,
        };

        return chain;
      }

      function updateChain() {
        const chain: Record<string, unknown> = {};
        chain.eq = jest.fn(() => chain);
        chain.then = (resolve: (value: unknown) => unknown) =>
          resolve({ error: opts.updateError ?? null });

        return chain;
      }

      update.mockImplementation(() => updateChain());

      const supabaseAdmin = {
        getClient: () => ({
          from: () => ({
            select: jest.fn(() => lookupChain()),
            update,
          }),
        }),
      } as unknown as SupabaseAdminService;

      const service = new UsersService(
        supabaseAdmin,
        { bustOrg } as unknown as PermissionsService,
        { logActionForRequest } as unknown as AuditLogsService,
      );

      return { service, bustOrg, logActionForRequest, update, lookupFilters };
    }

    /** Builds an actor whose role in the active org (`org-1`) is `role`. */
    function actor(role: string, userId = 'actor-1'): RequestUser {
      return {
        authUserId: 'auth-actor',
        userId,
        email: 'actor@example.com',
        organizationId: 'org-1',
        memberships: [
          { organizationId: 'org-1', organizationSlug: 'org', role },
        ],
      } as RequestUser;
    }

    it('refuses to change the actor own role', async () => {
      const { service: svc, update } = buildService();

      await expect(
        svc.updateOrganizationMemberRole(actor('owner'), 'actor-1', 'viewer'),
      ).rejects.toThrow(ForbiddenException);
      expect(update).not.toHaveBeenCalled();
    });

    it('refuses to grant owner when the actor is not an owner', async () => {
      const { service: svc, update } = buildService();

      await expect(
        svc.updateOrganizationMemberRole(actor('admin'), 'target-1', 'owner'),
      ).rejects.toThrow(ForbiddenException);
      expect(update).not.toHaveBeenCalled();
    });

    it('refuses to modify an existing owner when the actor is not an owner', async () => {
      const { service: svc, update } = buildService({
        member: { role: 'owner' },
      });

      await expect(
        svc.updateOrganizationMemberRole(actor('admin'), 'target-1', 'member'),
      ).rejects.toThrow(ForbiddenException);
      expect(update).not.toHaveBeenCalled();
    });

    it('lets an owner grant owner', async () => {
      const { service: svc, update } = buildService();

      await expect(
        svc.updateOrganizationMemberRole(actor('owner'), 'target-1', 'owner'),
      ).resolves.toEqual({ user_id: 'target-1', role: 'owner' });
      expect(update).toHaveBeenCalledWith({ role: 'owner' });
    });

    it('scopes the member lookup to the actor organization', async () => {
      const { service: svc, lookupFilters } = buildService();

      await svc.updateOrganizationMemberRole(
        actor('admin'),
        'target-1',
        'viewer',
      );

      expect(lookupFilters).toEqual([
        ['user_id', 'target-1'],
        ['organization_id', 'org-1'],
      ]);
    });

    it('rejects a target outside the actor organization as not found', async () => {
      const { service: svc, update } = buildService({ member: null });

      await expect(
        svc.updateOrganizationMemberRole(actor('admin'), 'other-org', 'viewer'),
      ).rejects.toThrow(NotFoundException);
      expect(update).not.toHaveBeenCalled();
    });

    it('busts the org permission cache after a successful change', async () => {
      const { service: svc, bustOrg, logActionForRequest } = buildService();

      await svc.updateOrganizationMemberRole(
        actor('admin'),
        'target-1',
        'viewer',
      );

      expect(bustOrg).toHaveBeenCalledWith('org-1');
      expect(logActionForRequest).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'actor-1' }),
        'organization_member',
        'target-1',
        'update',
        { event: 'update_role', before: 'member', after: 'viewer' },
      );
    });

    it('does not bust the cache when the change is refused', async () => {
      const { service: svc, bustOrg } = buildService({ member: null });

      await expect(
        svc.updateOrganizationMemberRole(actor('admin'), 'target-1', 'viewer'),
      ).rejects.toThrow(NotFoundException);
      expect(bustOrg).not.toHaveBeenCalled();
    });

    it('maps the last-owner trigger violation to a bad request', async () => {
      const { service: svc } = buildService({
        member: { role: 'owner' },
        updateError: {
          code: '23514',
          message: 'Cannot demote the sole owner of organization org-1',
        },
      });

      await expect(
        svc.updateOrganizationMemberRole(actor('owner'), 'target-1', 'member'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('bulkUpdateOrganizationMemberRole', () => {
    /** Actor is an owner so only the per-user stubs decide each outcome. */
    const owner = {
      authUserId: 'auth-actor',
      userId: 'actor-1',
      email: 'actor@example.com',
      organizationId: 'org-1',
      memberships: [
        { organizationId: 'org-1', organizationSlug: 'org', role: 'owner' },
      ],
    } as RequestUser;

    function buildService() {
      const supabaseAdmin = {
        getClient: () => ({ from: () => ({}) }),
      } as unknown as SupabaseAdminService;

      return new UsersService(supabaseAdmin, {
        bustOrg: jest.fn(),
      } as unknown as PermissionsService);
    }

    it('reports partial success instead of aborting on the first failure', async () => {
      const svc = buildService();
      const single = jest
        .spyOn(svc, 'updateOrganizationMemberRole')
        .mockImplementation((_actor, targetUserId) => {
          if (targetUserId === 'bad-1') {
            return Promise.reject(new NotFoundException('nope'));
          }

          return Promise.resolve({
            user_id: targetUserId,
            role: 'viewer' as const,
          });
        });

      const result = await svc.bulkUpdateOrganizationMemberRole(
        owner,
        ['ok-1', 'bad-1', 'ok-2'],
        'viewer',
      );

      expect(result.updated).toEqual(['ok-1', 'ok-2']);
      expect(result.errors).toEqual([{ user_id: 'bad-1', message: 'nope' }]);
      expect(single).toHaveBeenCalledTimes(3);
    });

    it('de-duplicates repeated user ids', async () => {
      const svc = buildService();
      const single = jest
        .spyOn(svc, 'updateOrganizationMemberRole')
        .mockResolvedValue({ user_id: 'ok-1', role: 'viewer' });

      const result = await svc.bulkUpdateOrganizationMemberRole(
        owner,
        ['ok-1', 'ok-1'],
        'viewer',
      );

      expect(single).toHaveBeenCalledTimes(1);
      expect(result.updated).toEqual(['ok-1']);
    });
  });

  describe('getOrganizationMembers', () => {
    it('flags migration placeholders without a login as is_placeholder', async () => {
      const members = [
        { role: 'owner', user: { ...mockUser, id: 'real-1' } },
        {
          role: 'viewer',
          user: { ...mockUser, id: 'ph-1', auth_user_id: null },
        },
        // Still in the crosswalk but has since signed up: no longer mergeable.
        { role: 'viewer', user: { ...mockUser, id: 'ph-2' } },
        // Crosswalk gone (its migration connection was deleted) but the synthetic address remains.
        {
          role: 'viewer',
          user: {
            ...mockUser,
            id: 'ph-3',
            auth_user_id: null,
            email: 'mig-1-2@Placeholder.Invalid',
          },
        },
        // No login, no crosswalk, real address: not provably a placeholder.
        {
          role: 'viewer',
          user: { ...mockUser, id: 'u-4', auth_user_id: null },
        },
      ];
      const placeholders = [{ target_id: 'ph-1' }, { target_id: 'ph-2' }];
      // The member list ends in .order(); the placeholder lookup is awaited after its last .eq().
      const from = jest.fn((table: string) => {
        const result =
          table === 'organization_members'
            ? { data: members, error: null }
            : { data: placeholders, error: null };
        const chain = {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          order: jest.fn().mockResolvedValue(result),
          then: (resolve: (v: unknown) => unknown) => resolve(result),
        };
        return chain;
      });
      const svc = new UsersService(
        { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
        mockPermissionsService(),
      );

      const result = await svc.getOrganizationMembers('org-1');

      expect(result.map((m) => [m.id, m.is_placeholder])).toEqual([
        ['real-1', false],
        ['ph-1', true],
        ['ph-2', false],
        ['ph-3', true],
        ['u-4', false],
      ]);
      expect(from).toHaveBeenCalledWith('migration_entity_map');
    });
  });

  describe('mergePlaceholderUser', () => {
    const actor = {
      authUserId: 'auth-1',
      userId: 'user-1',
      email: 'admin@example.com',
      organizationId: 'org-1',
    } as RequestUser;

    function buildService(rpcResult: { data?: unknown; error?: unknown }) {
      const rpc = jest
        .fn()
        .mockResolvedValue({ data: null, error: null, ...rpcResult });
      const bustOrg = jest.fn();
      const logActionForRequest = jest.fn().mockResolvedValue(undefined);
      const svc = new UsersService(
        { getClient: () => ({ rpc }) } as unknown as SupabaseAdminService,
        { bustOrg } as unknown as PermissionsService,
        { logActionForRequest } as unknown as AuditLogsService,
      );
      return { svc, rpc, bustOrg, logActionForRequest };
    }

    it('merges inside the caller organization, audits and busts permissions', async () => {
      const counts = { 'tasks.assigned_to': { moved: 2, dropped: 0 } };
      const { svc, rpc, bustOrg, logActionForRequest } = buildService({
        data: { dry_run: false, counts },
      });

      const result = await svc.mergePlaceholderUser(actor, 'ph-1', 'real-1');

      expect(rpc).toHaveBeenCalledWith('merge_placeholder_user', {
        p_org_id: 'org-1',
        p_source: 'ph-1',
        p_target: 'real-1',
        p_dry_run: false,
      });
      expect(result.counts).toEqual(counts);
      expect(bustOrg).toHaveBeenCalledWith('org-1');
      expect(logActionForRequest).toHaveBeenCalledWith(
        actor,
        'organization_member',
        'real-1',
        'update',
        { event: 'merge_placeholder', placeholder_id: 'ph-1', counts },
      );
    });

    it('a dry run neither audits nor busts permissions', async () => {
      const { svc, rpc, bustOrg, logActionForRequest } = buildService({
        data: { dry_run: true, counts: {} },
      });

      await svc.mergePlaceholderUser(actor, 'ph-1', 'real-1', true);

      expect(rpc).toHaveBeenCalledWith(
        'merge_placeholder_user',
        expect.objectContaining({ p_dry_run: true }),
      );
      expect(bustOrg).not.toHaveBeenCalled();
      expect(logActionForRequest).not.toHaveBeenCalled();
    });

    it.each([
      ['SAME_USER', BadRequestException],
      ['NOT_PLACEHOLDER', NotFoundException],
      ['TARGET_INVALID', BadRequestException],
      ['PLACEHOLDER_IN_OTHER_ORG', ConflictException],
      ['Task has a fenced SLA workflow', ConflictException],
      ['something else broke', InternalServerErrorException],
    ])('maps "%s" to %p and changes nothing', async (message, exception) => {
      const { svc, bustOrg } = buildService({ error: { message } });

      await expect(
        svc.mergePlaceholderUser(actor, 'ph-1', 'real-1'),
      ).rejects.toBeInstanceOf(exception);
      expect(bustOrg).not.toHaveBeenCalled();
    });
  });

  describe('removeOrganizationMember', () => {
    const admin = {
      authUserId: 'auth-1',
      userId: 'user-1',
      email: 'admin@example.com',
      organizationId: 'org-1',
      memberships: [{ organizationId: 'org-1', role: 'admin' }],
    } as unknown as RequestUser;
    const owner = {
      ...admin,
      memberships: [{ organizationId: 'org-1', role: 'owner' }],
    } as unknown as RequestUser;

    function buildService(rpcResult: { data?: unknown; error?: unknown }) {
      const rpc = jest
        .fn()
        .mockResolvedValue({ data: null, error: null, ...rpcResult });
      const bustOrg = jest.fn();
      const logActionForRequest = jest.fn().mockResolvedValue(undefined);
      const svc = new UsersService(
        { getClient: () => ({ rpc }) } as unknown as SupabaseAdminService,
        { bustOrg } as unknown as PermissionsService,
        { logActionForRequest } as unknown as AuditLogsService,
      );
      return { svc, rpc, bustOrg, logActionForRequest };
    }

    it('removes inside the caller organization, audits and busts permissions', async () => {
      const counts = { space_members: 3, user_group_members: 1 };
      const { svc, rpc, bustOrg, logActionForRequest } = buildService({
        data: { role: 'member', counts },
      });

      const result = await svc.removeOrganizationMember(admin, 'user-2');

      expect(rpc).toHaveBeenCalledWith('remove_organization_member', {
        p_org_id: 'org-1',
        p_user_id: 'user-2',
        p_allow_owner: false,
      });
      expect(result).toEqual({ user_id: 'user-2', role: 'member', counts });
      expect(bustOrg).toHaveBeenCalledWith('org-1');
      expect(logActionForRequest).toHaveBeenCalledWith(
        admin,
        'organization_member',
        'user-2',
        'delete',
        { event: 'remove_member', before: 'member', counts },
      );
    });

    it('notes the spaces they alone owned, and removes them all the same', async () => {
      const rows = [{ data: [{ space_id: 'space-1' }] }, { data: [] }];
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'neq']) chain[m] = () => chain;
      chain.then = (done: (r: unknown) => unknown) => Promise.resolve(rows.shift()).then(done);
      const rpc = jest.fn().mockResolvedValue({ data: { role: 'member', counts: {} }, error: null });
      const logActionForRequest = jest.fn().mockResolvedValue(undefined);
      const svc = new UsersService(
        { getClient: () => ({ rpc, from: () => chain }) } as unknown as SupabaseAdminService,
        { bustOrg: jest.fn() } as unknown as PermissionsService,
        { logActionForRequest } as unknown as AuditLogsService,
      );

      await svc.removeOrganizationMember(admin, 'user-2');

      expect(rpc).toHaveBeenCalledWith('remove_organization_member', expect.anything());
      expect(logActionForRequest.mock.calls[0][4]).toMatchObject({ spaces_left_without_owner: ['space-1'] });
    });

    it('lets an owner remove owners', async () => {
      const { svc, rpc } = buildService({
        data: { role: 'owner', counts: {} },
      });

      await svc.removeOrganizationMember(owner, 'user-2');

      expect(rpc).toHaveBeenCalledWith(
        'remove_organization_member',
        expect.objectContaining({ p_allow_owner: true }),
      );
    });

    it('refuses self-removal without calling the database', async () => {
      const { svc, rpc } = buildService({});

      await expect(
        svc.removeOrganizationMember(admin, 'user-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(rpc).not.toHaveBeenCalled();
    });

    it.each([
      [{ message: 'NOT_MEMBER' }, NotFoundException],
      [{ message: 'OWNER_FORBIDDEN' }, ForbiddenException],
      [{ message: 'LAST_ACTIVE_OWNER' }, BadRequestException],
      [
        { code: '23514', message: 'Cannot remove the sole owner' },
        BadRequestException,
      ],
      [{ message: 'something else broke' }, InternalServerErrorException],
    ])('maps %p to %p and changes nothing', async (error, exception) => {
      const { svc, bustOrg, logActionForRequest } = buildService({ error });

      await expect(
        svc.removeOrganizationMember(admin, 'user-2'),
      ).rejects.toBeInstanceOf(exception);
      expect(bustOrg).not.toHaveBeenCalled();
      expect(logActionForRequest).not.toHaveBeenCalled();
    });

    it('bulk: removes each unique id once and collects failures, including self', async () => {
      const { svc, rpc } = buildService({
        data: { role: 'member', counts: {} },
      });
      rpc.mockImplementation((_fn: string, args: { p_user_id: string }) =>
        Promise.resolve(
          args.p_user_id === 'gone'
            ? { data: null, error: { message: 'NOT_MEMBER' } }
            : { data: { role: 'member', counts: {} }, error: null },
        ),
      );

      const result = await svc.bulkRemoveOrganizationMembers(admin, [
        'user-2',
        'gone',
        'user-1',
        'user-2',
      ]);

      expect(result.removed).toEqual(['user-2']);
      expect(result.errors).toEqual([
        { user_id: 'gone', message: 'Organization member not found' },
        { user_id: 'user-1', message: 'You cannot remove yourself' },
      ]);
      // Self is rejected before the RPC; the duplicate is not retried.
      expect(rpc).toHaveBeenCalledTimes(2);
    });
  });
});
