import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';

import { SpaceMemberRulesService, spacesOnlyOwnedBy } from './space-member-rules.service';

type Row = Record<string, unknown>;

function fakeClient(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    const filters: ((row: Row) => boolean)[] = [];
    const run = () => (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (col: string, value: unknown) => {
        if (col.includes('.')) return q;
        filters.push((row) => row[col] === value);
        return q;
      },
      neq: (col: string, value: unknown) => (filters.push((row) => row[col] !== value), q),
      in: (col: string, values: unknown[]) => (filters.push((row) => values.includes(row[col])), q),
      not: (col: string) => (filters.push((row) => row[col] != null), q),
      maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: run(), error: null }).then(resolve),
    };
    return q;
  };
  return { from };
}

const ORG = 'org-1';
const SPACE = 'space-1';
const held: Record<string, Record<string, boolean>> = {
  owner: { manage_members: true, invite_members: true, manage_sla: true },
  admin: { manage_members: true, invite_members: true, create_tasks: true },
  mgr: { manage_members: true, invite_members: true },
  orgkey: { manage_members: true },
};
const member = (id: string, user_id: string | null, space_role: string, over: Row = {}): Row => ({
  id,
  space_id: SPACE,
  user_id,
  space_role,
  is_active: true,
  member_type: user_id ? 'user' : 'group',
  ...over,
});

function build() {
  const tables: Record<string, Row[]> = {
    spaces: [{ id: SPACE, organization_id: ORG }],
    organization_members: [
      ...['owner', 'admin', 'mgr', 'target', 'orgadmin', 'orgkey', 'gone', 'lower'].map((user_id) => ({
        organization_id: ORG,
        user_id,
        role: user_id === 'orgadmin' || user_id === 'lower' ? 'admin' : 'member',
      })),
    ],
    users: [{ id: 'target', is_active: true }, { id: 'gone', is_active: false }],
    user_groups: [{ id: 'g1', organization_id: ORG }],
    custom_roles: [
      { id: 'r-small', organization_id: ORG, permissions: { create_tasks: true } },
      { id: 'r-big', organization_id: ORG, permissions: { manage_sla: true, create_tasks: false } },
    ],
    space_members: [
      member('m-owner', 'owner', 'owner'),
      member('m-admin', 'admin', 'admin'),
      member('m-mgr', 'mgr', 'member'),
      member('m-target', 'target', 'member'),
      member('m-orgkey', 'orgkey', 'viewer'),
      member('m-lower', 'lower', 'viewer'),
      member('m-group', null, 'admin', { group_id: 'g1' }),
    ],
  };
  const permissions = {
    hasSpacePermission: jest.fn((user: string, _o: string, _s: string, key: string) => Promise.resolve(!!held[user]?.[key])),
    orgGrantsSpacePermission: jest.fn((user: string) => Promise.resolve(user === 'orgkey')),
  };
  const service = new SpaceMemberRulesService({ getClient: () => fakeClient(tables) } as never, permissions as never);
  return { service, tables, permissions };
}
const as = (userId: string, organizationId = ORG) => ({ userId, organizationId });
const add = (over: Row = {}) => ({ member_type: 'user', user_id: 'target', space_role: 'member', ...over });

describe('SpaceMemberRulesService on the human routes', () => {
  describe('rank', () => {
    it.each([
      ['admin', 'owner'],
      ['mgr', 'admin'],
      ['mgr', 'owner'],
      ['orgkey', 'owner'],
    ])('%s cannot give %s', async (who, role) => {
      const { service } = build();
      await expect(service.assertCanAdd(as(who), SPACE, add({ space_role: role }))).rejects.toThrow(ForbiddenException);
    });

    it.each([
      ['owner', 'owner'],
      ['orgadmin', 'owner'],
      ['lower', 'owner'],
      ['admin', 'admin'],
      ['mgr', 'member'],
      ['orgkey', 'admin'],
    ])('%s can give %s', async (who, role) => {
      const { service } = build();
      await expect(service.assertCanAdd(as(who), SPACE, add({ space_role: role }))).resolves.toBeUndefined();
    });

    it('caps the role on a change as well', async () => {
      const { service } = build();
      await expect(service.assertCanChangeRole(as('admin'), SPACE, 'm-target', 'owner')).rejects.toThrow(ForbiddenException);
      await expect(service.assertCanChangeRole(as('admin'), SPACE, 'm-target', 'admin')).resolves.toBeUndefined();
    });

    it('protects whoever ranks above, on a role change and on a removal', async () => {
      const { service } = build();
      await expect(service.assertCanChangeRole(as('mgr'), SPACE, 'm-admin', 'viewer')).rejects.toThrow(ForbiddenException);
      await expect(service.assertCanRemove(as('mgr'), SPACE, 'm-owner')).rejects.toThrow(ForbiddenException);
      await expect(service.assertCanRemove(as('admin'), SPACE, 'm-owner')).rejects.toThrow(ForbiddenException);
      await expect(service.assertCanRemove(as('admin'), SPACE, 'm-target')).resolves.toBeUndefined();
      // An org admin with a lower space role counts as an owner, and is out of a member's reach.
      await expect(service.assertCanRemove(as('admin'), SPACE, 'm-lower')).rejects.toThrow(ForbiddenException);
    });

    it('treats a group row by its stored role', async () => {
      const { service } = build();
      await expect(service.assertCanRemove(as('mgr'), SPACE, 'm-group')).rejects.toThrow(ForbiddenException);
      await expect(service.assertCanRemove(as('admin'), SPACE, 'm-group')).resolves.toBeUndefined();
    });

  });

  describe('flags and custom roles', () => {
    it('refuses a flag the person does not hold', async () => {
      const { service } = build();
      await expect(service.assertCanAdd(as('admin'), SPACE, add({ permissions: { manage_sla: true } }))).rejects.toThrow(ForbiddenException);
      await expect(service.assertCanAdd(as('admin'), SPACE, add({ permissions: { can_manage_sla: true } }))).rejects.toThrow(ForbiddenException);
      await expect(service.assertCanAdd(as('admin'), SPACE, add({ permissions: { create_tasks: true, manage_sla: false } }))).resolves.toBeUndefined();
    });

    it('lets an owner give anything', async () => {
      const { service } = build();
      await expect(service.assertCanAdd(as('orgadmin'), SPACE, add({ permissions: { anything_at_all: true } }))).resolves.toBeUndefined();
    });

    it('refuses a custom role holding what the person lacks', async () => {
      const { service } = build();
      const role = (role_id: string) => ({ member_type: 'role', role_id, user_id: undefined });
      await expect(service.assertCanAdd(as('admin'), SPACE, role('r-big'))).rejects.toThrow(ForbiddenException);
      await expect(service.assertCanAdd(as('admin'), SPACE, role('r-small'))).resolves.toBeUndefined();
      await expect(service.assertCanAdd(as('orgadmin'), SPACE, role('r-big'))).resolves.toBeUndefined();
    });
  });

  describe('tenant and target', () => {
    it('answers 404 for a space of another organization, on every route', async () => {
      const { service } = build();
      const other = as('orgadmin', 'org-2');
      await expect(service.assertCanAdd(other, SPACE, add())).rejects.toThrow(NotFoundException);
      await expect(service.assertCanChangeRole(other, SPACE, 'm-target', 'viewer')).rejects.toThrow(NotFoundException);
      await expect(service.assertCanRemove(other, SPACE, 'm-target')).rejects.toThrow(NotFoundException);
      await expect(service.assertCanInvite(other, SPACE, [{ space_role: 'member' }])).rejects.toThrow(NotFoundException);
      await expect(service.assertSpaceInOrg('org-2', SPACE)).rejects.toThrow(NotFoundException);
    });

    it('refuses a person, a group or a role that is not in the organization', async () => {
      const { service } = build();
      await expect(service.assertCanAdd(as('owner'), SPACE, add({ user_id: 'stranger' }))).rejects.toThrow(NotFoundException);
      await expect(service.assertCanAdd(as('owner'), SPACE, { member_type: 'group', group_id: 'nope' })).rejects.toThrow(NotFoundException);
      await expect(service.assertCanAdd(as('owner'), SPACE, { member_type: 'role', role_id: 'nope' })).rejects.toThrow(NotFoundException);
    });

    it('refuses a deactivated person', async () => {
      const { service } = build();
      await expect(service.assertCanAdd(as('owner'), SPACE, add({ user_id: 'gone' }))).rejects.toThrow(BadRequestException);
    });

    it('refuses what is no space role instead of failing in the database', async () => {
      const { service } = build();
      await expect(service.assertCanAdd(as('owner'), SPACE, add({ space_role: 'god' }))).rejects.toThrow(BadRequestException);
      await expect(service.assertCanChangeRole(as('owner'), SPACE, 'm-target', '17ee8419-0d4f-4450-838a-54c075adc8c4')).rejects.toThrow(BadRequestException);
    });

    it('answers 404 for a member of another space', async () => {
      const { service, tables } = build();
      tables.spaces.push({ id: 'space-2', organization_id: ORG });
      await expect(service.assertCanRemove(as('owner'), 'space-2', 'm-target')).rejects.toThrow(NotFoundException);
    });
  });

  describe('invitations', () => {
    it('caps the role, the flags and the custom role like an add', async () => {
      const { service } = build();
      await expect(service.assertCanInvite(as('admin'), SPACE, [{ space_role: 'owner' }])).rejects.toThrow(ForbiddenException);
      await expect(service.assertCanInvite(as('admin'), SPACE, [{ space_role: 'member' }, { space_role: 'admin' }])).resolves.toBeUndefined();
      await expect(service.assertCanInvite(as('admin'), SPACE, [{ space_role: 'member', permissions: { manage_sla: true } }])).rejects.toThrow(ForbiddenException);
      await expect(service.assertCanInvite(as('admin'), SPACE, [{ space_role: 'member', custom_role_id: 'r-big' }])).rejects.toThrow(ForbiddenException);
      await expect(service.assertCanInvite(as('orgadmin'), SPACE, [{ space_role: 'owner' }])).resolves.toBeUndefined();
    });
  });

  describe('another organization', () => {
    it('refuses its group and its custom role', async () => {
      const { service, tables } = build();
      tables.user_groups.push({ id: 'g-other', organization_id: 'org-2' });
      tables.custom_roles.push({ id: 'r-other', organization_id: 'org-2', permissions: {} });
      await expect(
        service.assertCanAdd(as('owner'), SPACE, { member_type: 'group', group_id: 'g-other' }),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.assertCanAdd(as('owner'), SPACE, { member_type: 'role', role_id: 'r-other' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('invitations with a role that does not exist', () => {
    it('refuses it', async () => {
      const { service } = build();
      await expect(service.assertCanInvite(as('owner'), SPACE, [{ space_role: 'superman' }])).rejects.toThrow(BadRequestException);
    });
  });

  describe('who is left in charge', () => {
    it('does not count an owner who left the organization or was deactivated', async () => {
      const { service, tables } = build();
      tables.space_members.push(member('m-out', 'stranger', 'owner'), member('m-gone', 'gone', 'owner'));
      await expect(service.isLastInCharge(ORG, SPACE, 'owner', 'owner')).resolves.toBe(true);
    });

    it('lets another owner take over', async () => {
      const { service, tables } = build();
      tables.space_members.push(member('m-two', 'orgadmin', 'owner'));
      await expect(service.isLastInCharge(ORG, SPACE, 'owner', 'owner')).resolves.toBe(false);
    });

    it('counts another admin for an admin, but never for an owner', async () => {
      const { service, tables } = build();
      tables.space_members = [member('m-a', 'admin', 'admin'), member('m-b', 'target', 'admin')];
      await expect(service.isLastInCharge(ORG, SPACE, 'admin', 'admin')).resolves.toBe(false);
      await expect(service.isLastInCharge(ORG, SPACE, 'admin', 'owner')).resolves.toBe(true);
    });
  });

  it('keeps the error classes the screens read', async () => {
    const { service } = build();
    expect(ConflictException).toBeDefined();
    const err = await service.assertCanAdd(as('admin'), SPACE, add({ space_role: 'owner' })).catch((e: Error) => e);
    expect((err as ForbiddenException).getResponse()).toMatchObject({ code: 'role_above_yours' });
  });
});

describe('spacesOnlyOwnedBy', () => {
  it('names the spaces where nobody else is owner, and never throws', async () => {
    const client = fakeClient({
      space_members: [
        { space_id: 'a', user_id: 'me', space_role: 'owner', is_active: true },
        { space_id: 'b', user_id: 'me', space_role: 'owner', is_active: true },
        { space_id: 'b', user_id: 'you', space_role: 'owner', is_active: true },
        { space_id: 'c', user_id: 'me', space_role: 'admin', is_active: true },
      ],
    });
    await expect(spacesOnlyOwnedBy(client as never, ORG, 'me')).resolves.toEqual(['a']);
    await expect(spacesOnlyOwnedBy({ from: () => { throw new Error('down'); } } as never, ORG, 'me')).resolves.toEqual([]);
  });
});
