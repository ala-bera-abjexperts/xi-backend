/**
 * @fileoverview How org-wide custom roles and groups combine with a user's space role.
 * Roles and groups only add rights; restrictions for one space come from that
 * space's own settings (membership permissions, space_permissions rows).
 * @module src/permissions/permissions-space-merge.spec
 * @author Prince Jadiya
 */

import { PermissionsService } from './permissions.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

const ORG = 'org-1';
const SPACE = 'space-1';
const USER = 'user-1';

/** Thenable supabase-js builder stub resolving to `data`. */
function chain(data: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in']) c[m] = jest.fn(() => c);
  c.maybeSingle = jest.fn(() => Promise.resolve({ data, error: null }));
  c.then = (ok: (v: unknown) => unknown) =>
    Promise.resolve({ data, error: null }).then(ok);
  return c;
}

const DENY_ALL_ROLE = {
  id: 'role-deny',
  is_active: true,
  is_deleted: false,
  permissions: {
    can_add_attachments_tasks: false,
    can_edit_tasks: false,
    can_view_tasks: false,
  },
};

function service(opts: {
  orgRole: string;
  spaceRole: string;
  rolePerms?: Record<string, unknown>;
  groupPerms?: Record<string, unknown> | null;
  userSpacePermRows?: Record<string, unknown>[];
}) {
  const tables: Record<string, unknown> = {
    spaces: { id: SPACE },
    organization_members: { role: opts.orgRole },
    user_group_members: [
      {
        group_id: 'group-1',
        role_id: DENY_ALL_ROLE.id,
        group: {
          id: 'group-1',
          organization_id: ORG,
          permissions: opts.groupPerms ?? null,
          is_deleted: false,
        },
      },
    ],
    user_role_assignments: [],
    custom_roles: [
      {
        ...DENY_ALL_ROLE,
        permissions: opts.rolePerms ?? DENY_ALL_ROLE.permissions,
      },
    ],
    space_permissions: opts.userSpacePermRows ?? [],
    space_module_permissions: [],
  };
  const from = jest.fn((table: string) => {
    if (table === 'space_members') {
      // Only the direct user membership row; group/role rows empty.
      let isUser = false;
      const c = chain([]);
      (c.eq as jest.Mock).mockImplementation((col: string, val: unknown) => {
        if (col === 'member_type' && val === 'user') isUser = true;
        return c;
      });
      c.then = (ok: (v: unknown) => unknown) =>
        Promise.resolve({
          data: isUser
            ? [
                {
                  space_role: opts.spaceRole,
                  permissions: {},
                  member_type: 'user',
                  user_id: USER,
                },
              ]
            : [],
          error: null,
        }).then(ok);
      return c;
    }
    return chain(tables[table] ?? []);
  });
  return new PermissionsService({
    getClient: () => ({ from }),
  } as unknown as SupabaseAdminService);
}

describe('space permissions: roles and groups add, never remove', () => {
  it('owner in a deny-only group role keeps owner rights (the reported case)', async () => {
    const r = await service({
      orgRole: 'owner',
      spaceRole: 'owner',
    }).getUserSpacePermissions(USER, ORG, SPACE);
    expect(r.isMember).toBe(true);
    expect(r.permissions.add_attachments_tasks).toBe(true);
    expect(r.permissions.edit_tasks).toBe(true);
    expect(r.permissions.view_tasks).toBe(true);
  });

  it('a group-level false does not remove a space-role right either', async () => {
    const r = await service({
      orgRole: 'member',
      spaceRole: 'owner',
      rolePerms: {},
      groupPerms: { can_add_attachments_tasks: false },
    }).getUserSpacePermissions(USER, ORG, SPACE);
    expect(r.permissions.add_attachments_tasks).toBe(true);
  });

  it('a custom role still grants extra rights to a viewer', async () => {
    const r = await service({
      orgRole: 'member',
      spaceRole: 'viewer',
      rolePerms: { can_add_attachments_tasks: true },
    }).getUserSpacePermissions(USER, ORG, SPACE);
    expect(r.permissions.add_attachments_tasks).toBe(true);
  });

  it('a per-space user restriction still applies', async () => {
    const r = await service({
      orgRole: 'owner',
      spaceRole: 'owner',
      userSpacePermRows: [
        {
          target_type: 'user',
          user_id: USER,
          target_id: USER,
          can_edit_tasks: false,
        },
      ],
    }).getUserSpacePermissions(USER, ORG, SPACE);
    expect(r.permissions.edit_tasks).toBe(false);
    expect(r.permissions.add_attachments_tasks).toBe(true);
  });
});
