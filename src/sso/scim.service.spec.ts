import { ConflictException, HttpException } from '@nestjs/common';
import { ScimService } from './scim.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const GROUP = '33333333-3333-4333-8333-333333333333';
const CREATOR = '44444444-4444-4444-8444-444444444444';

type Result = {
  data?: unknown;
  error?: { code?: string; message: string } | null;
  count?: number | null;
};
type Call = { table: string; method: string; args: unknown[] };

const CHAIN = [
  'select',
  'insert',
  'update',
  'upsert',
  'delete',
  'eq',
  'neq',
  'ilike',
  'is',
  'in',
  'order',
  'range',
  'limit',
  'maybeSingle',
];

/** Chainable PostgREST mock: each awaited query on a table takes that table's next result. */
function createClient(results: Record<string, Result[]>) {
  const calls: Call[] = [];
  const from = jest.fn((table: string) => {
    const builder: Record<string, unknown> = {};

    for (const method of CHAIN) {
      builder[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });

        return builder;
      };
    }

    builder.then = (
      resolve: (value: unknown) => unknown,
      reject: (reason: unknown) => unknown,
    ) =>
      Promise.resolve({
        data: null,
        error: null,
        count: null,
        ...(results[table]?.shift() ?? {}),
      }).then(resolve, reject);

    return builder;
  });

  return { client: { from }, calls };
}

function userLink(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link-1',
    local_user_id: USER,
    user_name: 'ada@example.com',
    external_id: 'ext-1',
    prior_role: null,
    deactivated_space_member_ids: [],
    is_active: true,
    deleted_at: null,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    user: {
      id: USER,
      email: 'ada@example.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
      is_active: true,
    },
    ...overrides,
  };
}

async function expectScimError(
  promise: Promise<unknown>,
  status: number,
  scimType?: string,
) {
  const error = await promise.then(
    () => {
      throw new Error('expected a SCIM error');
    },
    (reason: unknown) => reason,
  );

  expect(error).toBeInstanceOf(HttpException);
  expect((error as HttpException).getStatus()).toBe(status);

  if (scimType) {
    expect((error as HttpException).getResponse()).toMatchObject({ scimType });
  }
}

describe('ScimService', () => {
  const ctx = {
    orgId: ORG,
    tokenId: 'token-1',
    creatorUserId: CREATOR,
    actorUserId: CREATOR,
  };
  let accounts: Record<string, jest.Mock>;
  let userGroups: Record<string, jest.Mock>;
  let permissions: { bustUser: jest.Mock; bustOrg: jest.Mock };
  let auditLogs: { logSystemAction: jest.Mock };

  function build(results: Record<string, Result[]>) {
    const { client, calls } = createClient(results);
    const service = new ScimService(
      { getClient: () => client } as any,
      { get: jest.fn().mockReturnValue('https://api.test/api/v1') } as any,
      accounts as any,
      userGroups as any,
      permissions as any,
      auditLogs as any,
    );

    return { service, calls };
  }

  const updatesOf = (calls: Call[], table: string) =>
    calls
      .filter((call) => call.table === table && call.method === 'update')
      .map((call) => call.args[0]);

  beforeEach(() => {
    accounts = {
      findUserByEmail: jest.fn().mockResolvedValue(null),
      isDomainVerifiedForOrg: jest.fn().mockResolvedValue(true),
      createAccount: jest.fn(),
      fillBlankNames: jest.fn().mockResolvedValue(undefined),
      getMemberRole: jest.fn().mockResolvedValue('member'),
      isCurrentOwner: jest.fn().mockResolvedValue(true),
      attachMember: jest.fn().mockResolvedValue(undefined),
      expirePendingInvitations: jest.fn().mockResolvedValue(undefined),
    };
    userGroups = {
      addMembers: jest.fn().mockResolvedValue({ data: [] }),
      removeMembers: jest.fn().mockResolvedValue({ success: true }),
      getMembershipsForUsers: jest.fn().mockResolvedValue({}),
      create: jest.fn(),
      delete: jest.fn().mockResolvedValue({ success: true }),
    };
    permissions = { bustUser: jest.fn(), bustOrg: jest.fn() };
    auditLogs = { logSystemAction: jest.fn().mockResolvedValue(undefined) };
  });

  describe('lookups', () => {
    it('returns 404 for an id not linked in the token org', async () => {
      const { service, calls } = build({ scim_links: [{ data: null }] });

      await expectScimError(service.getUser(ctx, USER), 404);
      expect(calls).toContainEqual({
        table: 'scim_links',
        method: 'eq',
        args: ['organization_id', ORG],
      });
    });

    it('returns 404 for a non-uuid or tombstoned user and a foreign group', async () => {
      const { service } = build({
        scim_links: [
          { data: userLink({ deleted_at: '2026-09-02T00:00:00Z' }) },
          { data: null },
        ],
      });

      await expectScimError(service.getUser(ctx, 'not-a-uuid'), 404);
      await expectScimError(service.getUser(ctx, USER), 404);
      await expectScimError(service.getGroup(ctx, GROUP, {}), 404);
    });

    it('still lists a deactivated user, with active false', async () => {
      const { service } = build({
        scim_links: [{ data: [userLink({ is_active: false })], count: 1 }],
      });

      const list = await service.listUsers(ctx, {
        filter: 'userName eq "ADA@example.com"',
      });

      expect(list.totalResults).toBe(1);
      expect(list.Resources[0]).toMatchObject({
        id: USER,
        userName: 'ada@example.com',
        active: false,
        meta: {
          location: expect.stringContaining(`/Users/${USER}`) as unknown,
        },
      });
    });
  });

  describe('createUser', () => {
    const body = {
      userName: 'Ada@Example.com',
      name: { givenName: 'Ada', familyName: 'Lovelace' },
    };

    it('returns 409 uniqueness when the userName is already linked', async () => {
      const { service } = build({ scim_links: [{ data: userLink() }] });

      await expectScimError(service.createUser(ctx, body), 409, 'uniqueness');
      expect(accounts.attachMember).not.toHaveBeenCalled();
    });

    it('refuses an existing account on a domain this org has not verified', async () => {
      accounts.findUserByEmail.mockResolvedValue({
        id: USER,
        email: 'ada@example.com',
        is_active: true,
      });
      accounts.isDomainVerifiedForOrg.mockResolvedValue(false);
      const { service } = build({ scim_links: [{ data: null }] });

      await expectScimError(service.createUser(ctx, body), 409, 'uniqueness');
      expect(accounts.attachMember).not.toHaveBeenCalled();
    });

    it('refuses an orphan auth user (account_conflict) with 409', async () => {
      accounts.createAccount.mockRejectedValue(
        new ConflictException('account_conflict'),
      );
      const { service } = build({ scim_links: [{ data: null }] });

      await expectScimError(service.createUser(ctx, body), 409, 'uniqueness');
    });

    it('creates the account, attaches it as member and links it', async () => {
      accounts.createAccount.mockResolvedValue({
        id: USER,
        email: 'ada@example.com',
      });
      const { service, calls } = build({
        scim_links: [{ data: null }, { data: null }, {}, { data: userLink() }],
      });

      const resource = await service.createUser(ctx, body);

      expect(accounts.createAccount).toHaveBeenCalledWith('ada@example.com', {
        firstName: 'Ada',
        lastName: 'Lovelace',
      });
      expect(accounts.attachMember).toHaveBeenCalledWith(
        ORG,
        USER,
        'ada@example.com',
        'member',
      );
      expect(
        calls.find(
          (call) => call.table === 'scim_links' && call.method === 'insert',
        )?.args[0],
      ).toMatchObject({
        organization_id: ORG,
        resource_type: 'User',
        local_user_id: USER,
        user_name: 'ada@example.com',
      });
      expect(resource).toMatchObject({ id: USER, active: true });
    });

    it('revives a tombstoned link and restores membership and spaces', async () => {
      const tombstone = userLink({
        deleted_at: '2026-09-02T00:00:00Z',
        is_active: false,
        prior_role: 'member',
        deactivated_space_member_ids: ['sm-1'],
      });
      const { service, calls } = build({
        scim_links: [{ data: tombstone }, {}, {}, { data: userLink() }],
        space_members: [{}],
      });

      await service.createUser(ctx, body);

      expect(updatesOf(calls, 'scim_links')[0]).toEqual({
        deleted_at: null,
        user_name: 'ada@example.com',
        external_id: null,
      });
      expect(accounts.attachMember).toHaveBeenCalledWith(
        ORG,
        USER,
        'ada@example.com',
        'member',
      );
      expect(calls).toContainEqual({
        table: 'space_members',
        method: 'in',
        args: ['id', ['sm-1']],
      });
      expect(updatesOf(calls, 'scim_links')[1]).toEqual({
        is_active: true,
        deactivated_space_member_ids: [],
      });
    });
  });

  describe('deactivate / reactivate', () => {
    const deactivateBody = {
      Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
    };

    it('notes the spaces they alone owned, and deactivates them all the same', async () => {
      const { service, calls } = build({
        scim_links: [
          { data: userLink() },
          { data: userLink() },
          {},
          { data: userLink({ is_active: false }) },
        ],
        organization_members: [{}],
        spaces: [{ data: [{ id: 'space-1' }] }],
        space_members: [
          { data: [{ space_id: 'space-1' }] },
          { data: [] },
          { data: [{ id: 'sm-1' }] },
        ],
      });

      await service.patchUser(ctx, USER, deactivateBody);

      expect(calls).toContainEqual({ table: 'organization_members', method: 'delete', args: [] });
      expect(auditLogs.logSystemAction.mock.calls[0][4]).toMatchObject({
        spaces_left_without_owner: ['space-1'],
      });
    });

    it('removes the membership, deactivates spaces and records prior state', async () => {
      const { service, calls } = build({
        scim_links: [
          { data: userLink() },
          { data: userLink() },
          {},
          { data: userLink({ is_active: false }) },
        ],
        organization_members: [{}],
        spaces: [{ data: [{ id: 'space-1' }] }],
        // First the check for spaces only they own, then the rows to deactivate.
        space_members: [{ data: [] }, { data: [{ id: 'sm-1' }] }],
      });

      const resource = await service.patchUser(ctx, USER, deactivateBody);

      expect(calls).toContainEqual({
        table: 'organization_members',
        method: 'delete',
        args: [],
      });
      expect(updatesOf(calls, 'space_members')[0]).toEqual({
        is_active: false,
      });
      expect(updatesOf(calls, 'scim_links')[0]).toEqual({
        is_active: false,
        prior_role: 'member',
        deactivated_space_member_ids: ['sm-1'],
      });
      expect(accounts.expirePendingInvitations).toHaveBeenCalledWith(
        ORG,
        'ada@example.com',
      );
      expect(permissions.bustUser).toHaveBeenCalledWith(USER, ORG);
      expect(auditLogs.logSystemAction).toHaveBeenCalledWith(
        ORG,
        'organization_member',
        USER,
        'update',
        { source: 'scim', token_id: 'token-1', active: false },
      );
      expect(resource).toMatchObject({ active: false });
    });

    it('maps the sole-owner trigger (23514) to 400 mutability', async () => {
      accounts.getMemberRole.mockResolvedValue('owner');
      const { service, calls } = build({
        scim_links: [{ data: userLink() }],
        organization_members: [
          { error: { code: '23514', message: 'sole owner' } },
        ],
      });

      await expectScimError(
        service.patchUser(ctx, USER, deactivateBody),
        400,
        'mutability',
      );
      expect(updatesOf(calls, 'space_members')).toHaveLength(0);
    });

    it('refuses to deactivate an owner with a token not created by an owner', async () => {
      accounts.getMemberRole.mockResolvedValue('owner');
      accounts.isCurrentOwner.mockResolvedValue(false);
      const { service, calls } = build({ scim_links: [{ data: userLink() }] });

      await expectScimError(service.deleteUser(ctx, USER), 400, 'mutability');
      expect(accounts.isCurrentOwner).toHaveBeenCalledWith(ORG, CREATOR);
      expect(calls.some((call) => call.table === 'organization_members')).toBe(
        false,
      );
    });

    it('refuses to restore an owner with a non-owner token, and restores with an owner token', async () => {
      const inactiveOwner = userLink({
        is_active: false,
        prior_role: 'owner',
        deactivated_space_member_ids: ['sm-1'],
      });
      const reactivateBody = {
        Operations: [{ op: 'replace', value: { active: true } }],
      };

      accounts.isCurrentOwner.mockResolvedValueOnce(false);
      const refused = build({ scim_links: [{ data: inactiveOwner }] });

      await expectScimError(
        refused.service.patchUser(ctx, USER, reactivateBody),
        400,
        'mutability',
      );
      expect(accounts.attachMember).not.toHaveBeenCalled();

      const allowed = build({
        scim_links: [{ data: inactiveOwner }, {}, { data: userLink() }],
        space_members: [{}],
      });

      await allowed.service.patchUser(ctx, USER, reactivateBody);
      expect(accounts.attachMember).toHaveBeenCalledWith(
        ORG,
        USER,
        'ada@example.com',
        'owner',
      );
      expect(updatesOf(allowed.calls, 'space_members')[0]).toEqual({
        is_active: true,
      });
    });

    it('DELETE deactivates, leaves this org’s groups and tombstones the link', async () => {
      userGroups.getMembershipsForUsers.mockResolvedValue({
        [USER]: [{ id: GROUP, name: 'Sales' }],
      });
      const { service, calls } = build({
        scim_links: [{ data: userLink() }, { data: userLink() }, {}, {}],
        organization_members: [{}],
        spaces: [{ data: [] }],
        user_group_members: [{}],
      });

      await service.deleteUser(ctx, USER);

      const groupCalls = calls.filter(
        (call) => call.table === 'user_group_members',
      );

      expect(groupCalls).toEqual([
        { table: 'user_group_members', method: 'delete', args: [] },
        { table: 'user_group_members', method: 'eq', args: ['user_id', USER] },
        {
          table: 'user_group_members',
          method: 'in',
          args: ['group_id', [GROUP]],
        },
      ]);
      expect(userGroups.removeMembers).not.toHaveBeenCalled();
      expect(permissions.bustOrg).toHaveBeenCalledTimes(1);
      expect(permissions.bustOrg).toHaveBeenCalledWith(ORG);
      expect(auditLogs.logSystemAction).toHaveBeenCalledWith(
        ORG,
        'organization_member',
        USER,
        'delete',
        expect.objectContaining({ removed_group_ids: [GROUP] }),
      );
      expect(updatesOf(calls, 'scim_links')[1]).toEqual({
        deleted_at: expect.any(String) as unknown,
      });
    });

    it('re-deactivating an inactive link after an out-of-band re-add stores the role actually removed', async () => {
      accounts.getMemberRole.mockResolvedValue('member');
      const inactive = userLink({
        is_active: false,
        prior_role: 'admin',
        deactivated_space_member_ids: ['sm-old'],
      });
      const { service, calls } = build({
        scim_links: [
          { data: inactive },
          { data: inactive },
          {},
          { data: inactive },
        ],
        organization_members: [{}],
        spaces: [{ data: [] }],
      });

      await service.patchUser(ctx, USER, deactivateBody);

      expect(updatesOf(calls, 'scim_links')[0]).toEqual({
        is_active: false,
        prior_role: 'member',
        deactivated_space_member_ids: ['sm-old'],
      });
    });

    it('an overlapping deactivation that finds no membership keeps the saved state', async () => {
      accounts.getMemberRole.mockResolvedValue(null);
      const saved = userLink({
        is_active: false,
        prior_role: 'admin',
        deactivated_space_member_ids: ['sm-1', 'sm-2'],
      });
      const { service, calls } = build({
        // Stale snapshot (still active), then the fresh re-read.
        scim_links: [
          { data: userLink() },
          { data: saved },
          {},
          { data: saved },
        ],
        spaces: [{ data: [{ id: 'space-1' }] }],
        space_members: [{ data: [] }],
      });

      await service.patchUser(ctx, USER, deactivateBody);

      expect(updatesOf(calls, 'scim_links')[0]).toEqual({
        is_active: false,
        prior_role: 'admin',
        deactivated_space_member_ids: ['sm-1', 'sm-2'],
      });
    });
  });

  describe('owner userName protection', () => {
    const renameBody = {
      Operations: [
        { op: 'replace', path: 'userName', value: 'eve@example.com' },
      ],
    };

    it('refuses to re-point an owner link with a non-owner token', async () => {
      accounts.getMemberRole.mockResolvedValue('owner');
      accounts.isCurrentOwner.mockResolvedValue(false);
      const { service, calls } = build({ scim_links: [{ data: userLink() }] });

      await expectScimError(
        service.patchUser(ctx, USER, renameBody),
        400,
        'mutability',
      );
      expect(updatesOf(calls, 'scim_links')).toHaveLength(0);
    });

    it('refuses for an inactive former owner (prior_role) with a non-owner token', async () => {
      accounts.getMemberRole.mockResolvedValue(null);
      accounts.isCurrentOwner.mockResolvedValue(false);
      const { service, calls } = build({
        scim_links: [
          { data: userLink({ is_active: false, prior_role: 'owner' }) },
        ],
      });

      await expectScimError(
        service.patchUser(ctx, USER, renameBody),
        400,
        'mutability',
      );
      expect(updatesOf(calls, 'scim_links')).toHaveLength(0);
    });

    it('allows an owner token to rename an owner', async () => {
      accounts.getMemberRole.mockResolvedValue('owner');
      const { service, calls } = build({
        scim_links: [{ data: userLink() }, {}, { data: userLink() }],
      });

      await service.patchUser(ctx, USER, renameBody);

      expect(updatesOf(calls, 'scim_links')[0]).toEqual({
        user_name: 'eve@example.com',
      });
    });

    it('lets a non-owner token rename a non-owner', async () => {
      accounts.isCurrentOwner.mockResolvedValue(false);
      const { service, calls } = build({
        scim_links: [{ data: userLink() }, {}, { data: userLink() }],
      });

      await service.patchUser(ctx, USER, renameBody);

      expect(accounts.isCurrentOwner).not.toHaveBeenCalled();
      expect(updatesOf(calls, 'scim_links')[0]).toEqual({
        user_name: 'eve@example.com',
      });
    });
  });

  describe('groups', () => {
    const groupLink = {
      id: 'glink-1',
      local_group_id: GROUP,
      external_id: null,
      group: {
        id: GROUP,
        name: 'Sales',
        created_at: null,
        updated_at: null,
      },
    };
    const addBody = {
      Operations: [
        {
          op: 'Add',
          path: 'members',
          value: [{ value: USER }, { value: CREATOR }],
        },
      ],
    };

    it('adds only org members and treats a concurrent duplicate add as success', async () => {
      userGroups.addMembers.mockRejectedValue(new Error('duplicate key'));
      const { service } = build({
        scim_links: [{ data: groupLink }],
        organization_members: [{ data: [{ user_id: USER }] }],
        user_group_members: [{ data: [{ user_id: USER }] }],
      });

      await expect(
        service.patchGroup(ctx, GROUP, addBody),
      ).resolves.toBeUndefined();
      expect(userGroups.addMembers).toHaveBeenCalledWith(
        GROUP,
        ORG,
        [USER],
        null,
        CREATOR,
      );
    });

    it('rethrows a failed member add when the rows do not exist', async () => {
      userGroups.addMembers.mockRejectedValue(new Error('boom'));
      const { service } = build({
        scim_links: [{ data: groupLink }],
        organization_members: [{ data: [{ user_id: USER }] }],
        user_group_members: [{ data: [] }],
      });

      await expect(service.patchGroup(ctx, GROUP, addBody)).rejects.toThrow(
        'boom',
      );
    });

    it('deleteGroup clears members with one group_id-filtered delete', async () => {
      const { service, calls } = build({
        scim_links: [{ data: groupLink }, {}],
        user_group_members: [{}],
      });

      await service.deleteGroup(ctx, GROUP);

      expect(
        calls.filter((call) => call.table === 'user_group_members'),
      ).toEqual([
        { table: 'user_group_members', method: 'delete', args: [] },
        {
          table: 'user_group_members',
          method: 'eq',
          args: ['group_id', GROUP],
        },
      ]);
      expect(userGroups.removeMembers).not.toHaveBeenCalled();
      expect(userGroups.delete).toHaveBeenCalledWith(GROUP, ORG, CREATOR);
    });

    it('renders more than one page (1000) of members', async () => {
      const page = Array.from({ length: 1000 }, () => ({
        group_id: GROUP,
        user_id: USER,
      }));
      const { service, calls } = build({
        scim_links: [{ data: groupLink }],
        user_group_members: [
          { data: page },
          { data: [{ group_id: GROUP, user_id: CREATOR }] },
        ],
      });

      const group = await service.getGroup(ctx, GROUP, {});

      expect(group.members).toHaveLength(1001);
      expect(
        calls
          .filter((call) => call.method === 'range')
          .map((call) => call.args),
      ).toEqual([
        [0, 999],
        [1000, 1999],
      ]);
    });

    it('POST adopts an existing group whose name differs only in case', async () => {
      const { service, calls } = build({
        user_groups: [{ data: [{ id: GROUP, is_deleted: false }] }],
        scim_links: [{ data: null }, {}, { data: groupLink }],
        user_group_members: [{ data: [] }],
      });

      await service.createGroup(ctx, { displayName: 'Engineering' });

      expect(calls).toContainEqual({
        table: 'user_groups',
        method: 'ilike',
        args: ['name', 'Engineering'],
      });
      expect(userGroups.create).not.toHaveBeenCalled();
      expect(
        calls.find(
          (call) => call.table === 'scim_links' && call.method === 'upsert',
        )?.args[0],
      ).toMatchObject({ local_group_id: GROUP });
    });

    it('maps a name conflict from group create to 409 uniqueness', async () => {
      userGroups.create.mockRejectedValue(
        new ConflictException('A group named "Engineering" already exists'),
      );
      const { service } = build({ user_groups: [{ data: [] }] });

      await expectScimError(
        service.createGroup(ctx, { displayName: 'Engineering' }),
        409,
        'uniqueness',
      );
    });

    it('escapes LIKE metacharacters in the displayName filter', async () => {
      const { service, calls } = build({
        scim_links: [{ data: [groupLink], count: 1 }],
        user_group_members: [{ data: [] }],
      });

      await service.listGroups(ctx, { filter: 'displayName eq "Ops_100%"' });

      expect(calls).toContainEqual({
        table: 'scim_links',
        method: 'ilike',
        args: ['group.name', 'Ops\\_100\\%'],
      });
    });
  });
});
