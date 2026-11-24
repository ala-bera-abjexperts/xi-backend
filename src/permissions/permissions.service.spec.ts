/**
 * @fileoverview Unit tests for PermissionsService — effective-permission
 * resolution combining base role + custom roles + base-role overrides + groups,
 * permission predicate helpers, isAdminOrOwner, menu/level CRUD with target
 * filtering, space override aggregation, bulkSaveSpaceOverrides routing into
 * roles/base_role/groups, and the assertCanManageSpacePermissions guard.
 * @module src/permissions/permissions.service.spec
 * @author Prince Jadiya
 */

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PermissionsService } from './permissions.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('PermissionsService', () => {
  let service: PermissionsService;
  let mockFrom: jest.Mock;

  const ORG = 'org-1';
  const USER = 'user-1';

  function buildChain(resolved: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.neq = jest.fn().mockImplementation(self);
    chain.is = jest.fn().mockImplementation(self);
    chain.not = jest.fn().mockImplementation(self);
    chain.in = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.update = jest.fn().mockImplementation(self);
    chain.upsert = jest.fn().mockImplementation(self);
    chain.delete = jest.fn().mockImplementation(self);
    chain.single = jest.fn().mockResolvedValue(resolved);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled);
    return chain;
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    const supa = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;
    service = new PermissionsService(supa);
  });

  // ── getUserEffectivePermissions ────────────────────────────────────────

  describe('getUserEffectivePermissions', () => {
    it('returns viewer defaults when membership is missing', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: null,
          error: { message: 'no row', code: 'PGRST116' },
        }),
      );
      const r = await service.getUserEffectivePermissions(USER, ORG);
      expect(r.base_role).toBe('viewer');
      expect(r.custom_roles).toEqual([]);
      expect(r.groups).toEqual([]);
    });

    it('combines base role + custom roles + groups + base role override', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({ data: { role: 'admin' }, error: null }),
        ) // membership
        .mockReturnValueOnce(
          buildChain({
            data: [
              {
                role: {
                  id: 'role-1',
                  name: 'Reviewer',
                  permissions: {},
                  base_role: 'member',
                  is_active: true,
                  is_deleted: false,
                },
              },
            ],
            error: null,
          }),
        ) // role assignments
        .mockReturnValueOnce(
          buildChain({
            data: [
              {
                group: { id: 'g-1', name: 'Engineers', permissions: null },
              },
            ],
            error: null,
          }),
        ) // group memberships
        .mockReturnValueOnce(
          buildChain({
            data: { permissions: { can_manage_space_permissions: true } },
            error: null,
          }),
        ); // base role override

      const r = await service.getUserEffectivePermissions(USER, ORG);
      expect(r.base_role).toBe('admin');
      expect(r.custom_roles).toHaveLength(1);
      expect(r.groups).toHaveLength(1);
    });
  });

  // ── checkPermission / hasAny / hasAll ──────────────────────────────────

  describe('permission predicate helpers', () => {
    function mockEffectiveAdmin(): void {
      mockFrom
        .mockReturnValueOnce(
          buildChain({ data: { role: 'admin' }, error: null }),
        )
        .mockReturnValueOnce(buildChain({ data: [], error: null }))
        .mockReturnValueOnce(buildChain({ data: [], error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }));
    }

    it('checkPermission returns true for admins on broad perms', async () => {
      mockEffectiveAdmin();
      const r = await service.checkPermission(
        USER,
        ORG,
        'can_manage_space_permissions',
      );
      expect(typeof r).toBe('boolean');
    });

    it('hasAnyPermission returns true when any single check passes', async () => {
      mockEffectiveAdmin();
      const r = await service.hasAnyPermission(USER, ORG, [
        'never_a_real_perm',
        'can_view_dashboard',
      ]);
      expect(typeof r).toBe('boolean');
    });

    it('hasAllPermissions returns false when one perm is missing', async () => {
      mockEffectiveAdmin();
      const r = await service.hasAllPermissions(USER, ORG, [
        'never_a_real_perm',
      ]);
      expect(r).toBe(false);
    });
  });

  // ── hasOrgOrSpacePermission ────────────────────────────────────────────

  describe('hasOrgOrSpacePermission', () => {
    const KEY = 'can_edit_others_comments_tasks';
    const member = (permissions: Record<string, boolean>) => ({
      isMember: true,
      spaceRole: 'member',
      globalRole: 'member',
      permissions,
    });

    it('returns true on the org key without a space lookup', async () => {
      jest.spyOn(service, 'checkPermission').mockResolvedValue(true);
      const space = jest.spyOn(service, 'getUserSpacePermissions');

      await expect(
        service.hasOrgOrSpacePermission(USER, ORG, KEY, 'space-1'),
      ).resolves.toBe(true);
      expect(space).not.toHaveBeenCalled();
    });

    it('falls back to the unprefixed key in the resolved space permissions', async () => {
      jest.spyOn(service, 'checkPermission').mockResolvedValue(false);
      const space = jest
        .spyOn(service, 'getUserSpacePermissions')
        .mockResolvedValue(member({ edit_others_comments_tasks: true }));

      await expect(
        service.hasOrgOrSpacePermission(USER, ORG, KEY, 'space-1'),
      ).resolves.toBe(true);
      expect(space).toHaveBeenCalledWith(USER, ORG, 'space-1');
    });

    it('denies a non-member even when the key is set', async () => {
      jest.spyOn(service, 'checkPermission').mockResolvedValue(false);
      jest.spyOn(service, 'getUserSpacePermissions').mockResolvedValue({
        ...member({ edit_others_comments_tasks: true }),
        isMember: false,
      });

      await expect(
        service.hasOrgOrSpacePermission(USER, ORG, KEY, 'space-1'),
      ).resolves.toBe(false);
    });

    it('denies when the space key is missing or false', async () => {
      jest.spyOn(service, 'checkPermission').mockResolvedValue(false);
      jest
        .spyOn(service, 'getUserSpacePermissions')
        .mockResolvedValue(member({ edit_others_comments_tasks: false }));

      await expect(
        service.hasOrgOrSpacePermission(USER, ORG, KEY, 'space-1'),
      ).resolves.toBe(false);
    });

    it('denies without a space and never looks one up', async () => {
      jest.spyOn(service, 'checkPermission').mockResolvedValue(false);
      const space = jest.spyOn(service, 'getUserSpacePermissions');

      await expect(
        service.hasOrgOrSpacePermission(USER, ORG, KEY, null),
      ).resolves.toBe(false);
      expect(space).not.toHaveBeenCalled();
    });
  });

  // ── isAdminOrOwner ─────────────────────────────────────────────────────

  describe('isAdminOrOwner', () => {
    it('returns true when membership.role === owner', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { role: 'owner' }, error: null }),
      );
      const r = await service.isAdminOrOwner(USER, ORG);
      expect(r).toBe(true);
    });

    it('returns true when membership.role === admin', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { role: 'admin' }, error: null }),
      );
      const r = await service.isAdminOrOwner(USER, ORG);
      expect(r).toBe(true);
    });

    it('returns false for non-admins', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { role: 'member' }, error: null }),
      );
      const r = await service.isAdminOrOwner(USER, ORG);
      expect(r).toBe(false);
    });
  });

  // ── Menu permissions ───────────────────────────────────────────────────

  describe('getMenuPermissions', () => {
    it('filters rows by user_id / base_role / role_id / group_id', async () => {
      const rows = [
        {
          id: '1',
          user_id: USER,
          base_role: null,
          role_id: null,
          group_id: null,
          can_view: true,
        },
        {
          id: '2',
          base_role: 'admin',
          user_id: null,
          role_id: null,
          group_id: null,
          can_view: true,
        },
        {
          id: '3',
          role_id: 'role-1',
          base_role: null,
          user_id: null,
          group_id: null,
          can_view: false,
        },
        {
          id: '4',
          group_id: 'g-1',
          base_role: null,
          user_id: null,
          role_id: null,
          can_view: true,
        },
        {
          id: '5',
          base_role: 'viewer',
          user_id: null,
          role_id: null,
          group_id: null,
          can_view: false,
        }, // not user
      ];
      mockFrom
        .mockReturnValueOnce(
          buildChain({ data: { role: 'admin' }, error: null }),
        ) // membership
        .mockReturnValueOnce(
          buildChain({ data: [{ role_id: 'role-1' }], error: null }),
        ) // role assignments
        .mockReturnValueOnce(
          buildChain({ data: [{ group_id: 'g-1' }], error: null }),
        ) // groups
        .mockReturnValueOnce(buildChain({ data: rows, error: null })); // menu_permissions

      const r = await service.getMenuPermissions(USER, ORG);
      const ids = r.map((p) => p.id);
      expect(ids).toEqual(expect.arrayContaining(['1', '2', '3', '4']));
      expect(ids).not.toContain('5');
    });

    it('throws BadRequest when menu query errors', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({ data: { role: 'admin' }, error: null }),
        )
        .mockReturnValueOnce(buildChain({ data: [], error: null }))
        .mockReturnValueOnce(buildChain({ data: [], error: null }))
        .mockReturnValueOnce(
          buildChain({ data: null, error: { message: 'fail' } }),
        );
      await expect(service.getMenuPermissions(USER, ORG)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('saveMenuPermission', () => {
    it('deletes any existing row for the same key+target then inserts a new row', async () => {
      const inserted = {
        id: 'mp-1',
        organization_id: ORG,
        menu_key: 'tasks',
        target_type: 'user',
        user_id: USER,
        can_view: true,
      };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // delete
        .mockReturnValueOnce(buildChain({ data: inserted, error: null })); // insert
      const r = await service.saveMenuPermission(
        ORG,
        'tasks',
        'user',
        USER,
        null,
        true,
      );
      expect(r.id).toBe('mp-1');
    });

    it('routes target_type=base_role into the base_role column', async () => {
      const inserted = {
        id: 'mp-2',
        organization_id: ORG,
        menu_key: 'tasks',
        target_type: 'base_role',
        base_role: 'admin',
        can_view: true,
      };
      const insertChain = buildChain({ data: inserted, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // delete
        .mockReturnValueOnce(insertChain); // insert
      await service.saveMenuPermission(
        ORG,
        'tasks',
        'base_role',
        null,
        'admin',
        true,
      );
      const inserted0 = (
        (insertChain.insert as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0] as Record<string, unknown>;
      expect(inserted0['base_role']).toBe('admin');
    });

    it('throws BadRequest on insert failure', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(
          buildChain({ data: null, error: { message: 'fail' } }),
        );
      await expect(
        service.saveMenuPermission(ORG, 'tasks', 'user', USER, null, true),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('saveMenuPermissions (bulk)', () => {
    it('delegates each item to saveMenuPermission sequentially', async () => {
      // 2 items × 2 mocks (delete + insert) each
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // delete 1
        .mockReturnValueOnce(buildChain({ data: { id: 'a' }, error: null })) // insert 1
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // delete 2
        .mockReturnValueOnce(buildChain({ data: { id: 'b' }, error: null })); // insert 2
      await service.saveMenuPermissions(ORG, [
        { menuKey: 'tasks', targetType: 'user', targetId: USER, canView: true },
        {
          menuKey: 'risks',
          targetType: 'user',
          targetId: USER,
          canView: false,
        },
      ]);
      expect(mockFrom).toHaveBeenCalledTimes(4);
    });
  });

  describe('deleteMenuPermission', () => {
    it('removes the row by id', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.deleteMenuPermission('mp-1'),
      ).resolves.toBeUndefined();
    });

    it('throws BadRequest when DB errors', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: null, error: { message: 'fail' } }),
      );
      await expect(service.deleteMenuPermission('mp-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── Level permissions ──────────────────────────────────────────────────

  describe('getLevelPermissions', () => {
    it('filters rows by user / base_role / role / group ownership', async () => {
      const rows = [
        { id: '1', user_id: USER, can_view: true },
        { id: '2', base_role: 'member', can_view: true },
        { id: '3', role_id: 'role-1', can_view: true },
        { id: '4', group_id: 'g-1', can_view: true },
        { id: '5', base_role: 'admin', can_view: true }, // not user's base role
      ];
      mockFrom
        .mockReturnValueOnce(
          buildChain({ data: { role: 'member' }, error: null }),
        )
        .mockReturnValueOnce(
          buildChain({ data: [{ role_id: 'role-1' }], error: null }),
        )
        .mockReturnValueOnce(
          buildChain({ data: [{ group_id: 'g-1' }], error: null }),
        )
        .mockReturnValueOnce(buildChain({ data: rows, error: null }));

      const r = await service.getLevelPermissions(USER, ORG, 'lvl-1', 'task');
      const ids = r.map((p) => p.id);
      expect(ids).toEqual(expect.arrayContaining(['1', '2', '3', '4']));
      expect(ids).not.toContain('5');
    });
  });

  describe('saveLevelPermission', () => {
    it('inserts a level permission row for a role target', async () => {
      const created = {
        id: 'lp-1',
        organization_id: ORG,
        hierarchy_level_id: 'lvl-1',
        entity_type: 'task',
        target_type: 'role',
        role_id: 'role-1',
        can_view: true,
      };
      mockFrom.mockReturnValueOnce(buildChain({ data: created, error: null }));
      const r = await service.saveLevelPermission(
        ORG,
        'lvl-1',
        'task',
        'role',
        'role-1',
        null,
        { can_view: true },
      );
      expect(r.id).toBe('lp-1');
    });

    it('throws BadRequest on insert failure', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: null, error: { message: 'fail' } }),
      );
      await expect(
        service.saveLevelPermission(ORG, 'lvl-1', 'task', 'user', USER, null, {
          can_view: true,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('deleteLevelPermission', () => {
    it('deletes by id', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.deleteLevelPermission('lp-1'),
      ).resolves.toBeUndefined();
    });
  });

  // ── Space overrides ────────────────────────────────────────────────────

  describe('getSpaceOverrides', () => {
    it('returns overrides keyed by base_role and groupOverrides keyed by group id', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: [
              { base_role: 'admin', permissions: { can_manage: true } },
              { base_role: 'member', permissions: { can_view: true } },
            ],
            error: null,
          }),
        )
        .mockReturnValueOnce(
          buildChain({
            data: [{ id: 'g-1', permissions: { can_view: true } }],
            error: null,
          }),
        );
      const r = await service.getSpaceOverrides(ORG);
      expect(r.overrides).toEqual({
        admin: { can_manage: true },
        member: { can_view: true },
      });
      expect(r.groupOverrides).toEqual({
        'g-1': { can_view: true },
      });
    });

    it('throws BadRequest when base_role query errors', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: null, error: { message: 'fail' } }),
      );
      await expect(service.getSpaceOverrides(ORG)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('bulkSaveSpaceOverrides', () => {
    it('routes role/base_role/group changes into separate writes', async () => {
      // Inputs: 1 role change, 1 base_role change, 1 group change
      mockFrom
        .mockReturnValueOnce(
          buildChain({ data: { permissions: {} }, error: null }),
        ) // custom_roles fetch
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // custom_roles update
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // base_role fetch
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // base_role upsert
        .mockReturnValueOnce(
          buildChain({ data: { permissions: {} }, error: null }),
        ) // user_groups fetch
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // user_groups update

      const r = await service.bulkSaveSpaceOverrides(ORG, [
        {
          permKey: 'can_view',
          targetType: 'role',
          targetId: 'role-1',
          value: true,
        },
        {
          permKey: 'can_view',
          targetType: 'base_role',
          baseRole: 'admin',
          value: true,
        },
        {
          permKey: 'can_view',
          targetType: 'group',
          targetId: 'g-1',
          value: true,
        },
      ]);

      expect(r.roleCount).toBe(1);
      expect(r.baseRoleCount).toBe(1);
      expect(r.groupCount).toBe(1);
    });

    it('ignores invalid base_role values', async () => {
      const r = await service.bulkSaveSpaceOverrides(ORG, [
        {
          permKey: 'can_view',
          targetType: 'base_role',
          baseRole: 'phantom',
          value: true,
        },
      ]);
      expect(r.baseRoleCount).toBe(0);
    });
  });

  // ── assertCanManageSpacePermissions ───────────────────────────────────

  describe('assertCanManageSpacePermissions', () => {
    it('returns silently for admin/owner users', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { role: 'admin' }, error: null }),
      );
      await expect(
        service.assertCanManageSpacePermissions(USER, ORG),
      ).resolves.toBeUndefined();
    });

    it('throws Forbidden when non-admin lacks the permission', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({ data: { role: 'viewer' }, error: null }),
        ) // isAdminOrOwner → false
        .mockReturnValueOnce(
          buildChain({ data: { role: 'viewer' }, error: null }),
        ) // membership in getUserEffectivePermissions
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // role assignments
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // groups
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // base_role override (none)

      await expect(
        service.assertCanManageSpacePermissions(USER, ORG),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // getEffectiveSpaceSlice (/permissions/effective?space)

  describe('getEffectiveSpaceSlice', () => {
    it('returns null when no space param is supplied', async () => {
      const result = await service.getEffectiveSpaceSlice(USER, ORG, {});

      expect(result).toBeNull();
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('returns null for the onboarding org', async () => {
      const result = await service.getEffectiveSpaceSlice(USER, '', {
        spaceId: 'space-1',
      });

      expect(result).toBeNull();
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('resolves by spaceId and returns the member space slice', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { id: 'space-1', key: 'ENG' }, error: null }),
      );
      jest.spyOn(service, 'getUserSpacePermissions').mockResolvedValue({
        isMember: true,
        spaceRole: 'admin',
        globalRole: 'admin',
        permissions: { view_space: true },
      });

      const result = await service.getEffectiveSpaceSlice(USER, ORG, {
        spaceId: 'space-1',
      });

      expect(result).toEqual({
        id: 'space-1',
        key: 'ENG',
        role: 'admin',
        permissions: { view_space: true },
      });
    });

    it('resolves by spaceKey (upper-cased) and returns the slice', async () => {
      const chain = buildChain({
        data: { id: 'space-1', key: 'ENG' },
        error: null,
      });
      mockFrom.mockReturnValueOnce(chain);
      jest.spyOn(service, 'getUserSpacePermissions').mockResolvedValue({
        isMember: true,
        spaceRole: 'member',
        globalRole: 'member',
        permissions: {},
      });

      const result = await service.getEffectiveSpaceSlice(USER, ORG, {
        spaceKey: 'eng',
      });

      expect(result?.key).toBe('ENG');
      expect(chain.eq).toHaveBeenCalledWith('key', 'ENG');
    });

    it('returns null for a non-member space (no existence leak)', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { id: 'space-1', key: 'ENG' }, error: null }),
      );
      jest.spyOn(service, 'getUserSpacePermissions').mockResolvedValue({
        isMember: false,
        spaceRole: null,
        globalRole: 'member',
        permissions: {},
      });

      const result = await service.getEffectiveSpaceSlice(USER, ORG, {
        spaceId: 'space-1',
      });

      expect(result).toBeNull();
    });

    it('returns null for a nonexistent / cross-org space (uniform)', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      const spy = jest.spyOn(service, 'getUserSpacePermissions');

      const result = await service.getEffectiveSpaceSlice(USER, ORG, {
        spaceId: 'space-x',
      });

      expect(result).toBeNull();
      // a missing/cross-org space never reaches the membership computation
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
