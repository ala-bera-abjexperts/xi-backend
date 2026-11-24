import {
  calculateEffectivePermissions,
  hasPermission,
  mergePermissions,
  DEFAULT_ON_CHAT_KEYS,
  DEFAULT_PERMISSIONS_BY_ROLE,
  ICustomRole,
  IBaseRole,
  IPermissionsObject,
} from './access-control.model';

/**
 * calculateEffectivePermissions as it was BEFORE the default-on chat rule, kept
 * here on purpose: comparing against it proves the rule moved nothing else.
 */
function legacyEffectivePermissions(
  baseRole: IBaseRole,
  customRoles: ICustomRole[],
  baseRoleOverrides?: IPermissionsObject,
): IPermissionsObject {
  const permissive = (a: IPermissionsObject, b: IPermissionsObject) => {
    const result: IPermissionsObject = { ...a };
    for (const [key, value] of Object.entries(b)) {
      if (value === true) {
        result[key] = true;
      } else if (result[key] === undefined) {
        result[key] = value;
      }
    }
    return result;
  };
  const safeBaseRole = DEFAULT_PERMISSIONS_BY_ROLE[baseRole]
    ? baseRole
    : 'viewer';
  let effective: IPermissionsObject = {
    ...DEFAULT_PERMISSIONS_BY_ROLE[safeBaseRole],
  };

  if (baseRoleOverrides) {
    effective = {
      ...effective,
      ...Object.fromEntries(
        Object.entries(baseRoleOverrides).filter(([, v]) => v !== undefined),
      ),
    };
  }

  for (const role of customRoles ?? []) {
    if (role.is_active && !role.is_deleted) {
      const safeRoleBase = DEFAULT_PERMISSIONS_BY_ROLE[role.base_role]
        ? role.base_role
        : 'viewer';
      effective = permissive(
        effective,
        DEFAULT_PERMISSIONS_BY_ROLE[safeRoleBase],
      );
      effective = permissive(effective, role.permissions);
    }
  }

  return effective;
}

const customRole = (overrides: Partial<ICustomRole> = {}): ICustomRole => ({
  id: 'role-1',
  organization_id: 'org-1',
  name: 'Custom',
  color: '#000',
  base_role: 'member',
  permissions: {},
  is_system: false,
  is_active: true,
  is_deleted: false,
  ...overrides,
});

describe('Access Control Model', () => {
  describe('DEFAULT_PERMISSIONS_BY_ROLE', () => {
    it('should give owner all permissions', () => {
      const ownerPerms = DEFAULT_PERMISSIONS_BY_ROLE.owner;
      expect(ownerPerms.can_view_processes).toBe(true);
      expect(ownerPerms.can_delete_spaces).toBe(true);
      expect(ownerPerms.can_remove_users).toBe(true);
      expect(ownerPerms.can_manage_roles).toBe(true);
    });

    it('should restrict admin from delete_spaces and remove_users', () => {
      const adminPerms = DEFAULT_PERMISSIONS_BY_ROLE.admin;
      expect(adminPerms.can_view_processes).toBe(true);
      expect(adminPerms.can_delete_spaces).toBe(false);
      expect(adminPerms.can_remove_users).toBe(false);
    });

    it('should restrict member from admin actions', () => {
      const memberPerms = DEFAULT_PERMISSIONS_BY_ROLE.member;
      expect(memberPerms.can_view_processes).toBe(true);
      expect(memberPerms.can_create_processes).toBe(true);
      expect(memberPerms.can_delete_processes).toBe(false);
      expect(memberPerms.can_invite_users).toBe(false);
      expect(memberPerms.can_manage_roles).toBe(false);
    });

    it('should give viewer read-only access', () => {
      const viewerPerms = DEFAULT_PERMISSIONS_BY_ROLE.viewer;
      expect(viewerPerms.can_view_processes).toBe(true);
      expect(viewerPerms.can_create_processes).toBe(false);
      expect(viewerPerms.can_edit_processes).toBe(false);
      expect(viewerPerms.can_delete_processes).toBe(false);
      expect(viewerPerms.can_view_settings).toBe(false);
    });
  });

  describe('hasPermission', () => {
    it('should return true for granted permissions', () => {
      expect(
        hasPermission(DEFAULT_PERMISSIONS_BY_ROLE.owner, 'can_view_tasks'),
      ).toBe(true);
    });

    it('should return false for denied permissions', () => {
      expect(
        hasPermission(DEFAULT_PERMISSIONS_BY_ROLE.viewer, 'can_create_tasks'),
      ).toBe(false);
    });

    it('should return false for undefined permissions', () => {
      expect(hasPermission({}, 'can_view_tasks')).toBe(false);
    });
  });

  describe('mergePermissions', () => {
    it('should override base with custom values', () => {
      const base = { can_view_tasks: true, can_edit_tasks: false };
      const custom = { can_edit_tasks: true };
      const result = mergePermissions(base, custom);
      expect(result.can_view_tasks).toBe(true);
      expect(result.can_edit_tasks).toBe(true);
    });

    it('should not override with undefined', () => {
      const base = { can_view_tasks: true };
      const custom = { can_view_tasks: undefined };
      const result = mergePermissions(base, custom);
      expect(result.can_view_tasks).toBe(true);
    });
  });

  describe('calculateEffectivePermissions', () => {
    it('should return base role defaults when no custom roles', () => {
      const result = calculateEffectivePermissions('member', []);
      expect(result.can_view_processes).toBe(true);
      expect(result.can_delete_processes).toBe(false);
    });

    it('should fall back to viewer for unknown base role', () => {
      const result = calculateEffectivePermissions('unknown' as IBaseRole, []);
      expect(result.can_view_processes).toBe(true);
      expect(result.can_create_processes).toBe(false);
    });

    it('should merge custom role permissions permissively', () => {
      const customRole: ICustomRole = {
        id: 'role-1',
        organization_id: 'org-1',
        name: 'Custom',
        color: '#000',
        base_role: 'viewer',
        permissions: { can_create_tasks: true },
        is_system: false,
        is_active: true,
        is_deleted: false,
      };

      // Member base + custom role that grants can_create_tasks
      const result = calculateEffectivePermissions('viewer', [customRole]);
      expect(result.can_view_tasks).toBe(true); // from viewer base
      expect(result.can_create_tasks).toBe(true); // from custom role
    });

    it('should skip inactive custom roles', () => {
      const inactiveRole: ICustomRole = {
        id: 'role-1',
        organization_id: 'org-1',
        name: 'Inactive',
        color: '#000',
        base_role: 'owner',
        permissions: { can_delete_spaces: true },
        is_system: false,
        is_active: false,
        is_deleted: false,
      };

      const result = calculateEffectivePermissions('viewer', [inactiveRole]);
      expect(result.can_delete_spaces).toBe(false); // inactive role ignored
    });

    it('should apply base role overrides', () => {
      const overrides = { can_invite_users: true };
      const result = calculateEffectivePermissions('member', [], overrides);
      expect(result.can_invite_users).toBe(true); // overridden from false to true
    });
  });

  describe('default-on chat keys (ADM-08): a custom role does not hand them back', () => {
    const removed = Object.fromEntries(
      DEFAULT_ON_CHAT_KEYS.map((key) => [key, false]),
    );

    it('are exactly the three keys every base role holds by default', () => {
      expect([...DEFAULT_ON_CHAT_KEYS]).toEqual([
        'can_use_chat',
        'can_create_chat_groups',
        'can_use_robert',
      ]);
      for (const preset of Object.values(DEFAULT_PERMISSIONS_BY_ROLE)) {
        for (const key of DEFAULT_ON_CHAT_KEYS) {
          expect(preset[key]).toBe(true);
        }
      }
    });

    it.each(DEFAULT_ON_CHAT_KEYS)(
      '%s: stays removed for someone whose custom role does not hold it',
      (key) => {
        // An admin-based role: its base-role defaults used to give the key back.
        const roles = [
          customRole({ base_role: 'admin' }),
          customRole({ id: 'role-2', permissions: { [key]: false } }),
        ];

        expect(legacyEffectivePermissions('member', roles, removed)[key]).toBe(
          true,
        );
        expect(
          calculateEffectivePermissions('member', roles, removed)[key],
        ).toBe(false);
      },
    );

    it.each(DEFAULT_ON_CHAT_KEYS)(
      '%s: an active custom role that holds it explicitly gives it back',
      (key) => {
        const result = calculateEffectivePermissions(
          'member',
          [
            customRole({ base_role: 'admin' }),
            customRole({ id: 'role-2', permissions: { [key]: true } }),
          ],
          removed,
        );

        expect(result[key]).toBe(true);
        // Only that key: the other two stay removed.
        expect(DEFAULT_ON_CHAT_KEYS.filter((k) => result[k] === true)).toEqual([
          key,
        ]);
      },
    );

    it.each([
      ['inactive', { is_active: false }],
      ['deleted', { is_deleted: true }],
    ])('ignores the grant of an %s role', (_name, state) => {
      const result = calculateEffectivePermissions(
        'member',
        [
          customRole({ base_role: 'admin' }),
          customRole({
            id: 'role-2',
            permissions: { can_use_robert: true },
            ...state,
          }),
        ],
        removed,
      );

      expect(result.can_use_robert).toBe(false);
    });

    it.each([
      ['absent', undefined],
      ['empty', {}],
      ['true', { can_use_robert: true }],
    ])('changes nothing when the override is %s', (_name, overrides) => {
      for (const roles of [[], [customRole({ base_role: 'viewer' })]]) {
        const result = calculateEffectivePermissions(
          'member',
          roles,
          overrides,
        );

        expect(result.can_use_robert).toBe(true);
        expect(result).toEqual(
          legacyEffectivePermissions('member', roles, overrides),
        );
      }
    });

    it('gives every other key, and all keys without custom roles, exactly the old result', () => {
      const baseRoles = [
        'owner',
        'admin',
        'member',
        'viewer',
        'unknown',
      ] as IBaseRole[];
      const overrideSets: (IPermissionsObject | undefined)[] = [
        undefined,
        {},
        removed,
        { can_use_chat: false, can_use_robert: true },
        {
          ...removed,
          can_invite_users: true,
          can_view_tasks: false,
          can_view_space: false,
          can_delete_any_chat_message: false,
          can_manage_robert: true,
          can_view_space_settings_general: false,
          can_some_future_key: true,
        },
      ];
      const roleSets: ICustomRole[][] = [
        [],
        [customRole({ base_role: 'viewer' })],
        [
          customRole({
            base_role: 'owner',
            permissions: { can_use_chat: true },
          }),
        ],
        [
          customRole({ base_role: 'admin' }),
          customRole({
            id: 'role-2',
            base_role: 'viewer',
            permissions: {
              can_create_tasks: true,
              can_view_tasks: false,
              can_use_robert: true,
              can_view_partner_leads: true,
            },
          }),
          customRole({
            id: 'role-3',
            base_role: 'owner',
            is_active: false,
            permissions: { can_delete_spaces: true, can_use_chat: true },
          }),
          customRole({
            id: 'role-4',
            base_role: 'owner',
            is_deleted: true,
            permissions: { can_remove_users: true },
          }),
          customRole({
            id: 'role-5',
            base_role: 'unknown' as IBaseRole,
            permissions: { can_create_chat_groups: false },
          }),
        ],
      ];
      const chatKeys: readonly string[] = DEFAULT_ON_CHAT_KEYS;
      const others = (permissions: IPermissionsObject) =>
        JSON.stringify(
          Object.entries(permissions).filter(
            ([key]) => !chatKeys.includes(key),
          ),
        );
      let compared = 0;

      for (const baseRole of baseRoles) {
        for (const overrides of overrideSets) {
          for (const roles of roleSets) {
            const now = calculateEffectivePermissions(
              baseRole,
              roles,
              overrides,
            );
            const before = legacyEffectivePermissions(
              baseRole,
              roles,
              overrides,
            );

            // Same keys, same values, same order.
            expect(others(now)).toBe(others(before));
            if (roles.length === 0) {
              expect(JSON.stringify(now)).toBe(JSON.stringify(before));
            }
            // The three keys move in one direction only, and only by the rule.
            for (const key of DEFAULT_ON_CHAT_KEYS) {
              const held = roles.some(
                (role) =>
                  role.is_active &&
                  !role.is_deleted &&
                  role.permissions[key] === true,
              );

              expect(now[key]).toBe(
                overrides?.[key] === false && !held ? false : before[key],
              );
            }
            compared += 1;
          }
        }
      }

      expect(compared).toBe(100);
    });
  });
});
