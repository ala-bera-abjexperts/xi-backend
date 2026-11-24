import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';

import type { PermissionsService } from '../../permissions/permissions.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import {
  chunk,
  TesterEligibilityService,
  userDisplayName,
} from './tester-eligibility.service';

const ORG = 'org-1';
const SPACE = 'space-1';

interface Resolved {
  data: unknown;
  error: { code?: string; message: string } | null;
}

type Chain = Record<string, jest.Mock> & PromiseLike<Resolved>;

function buildChain(resolved: Resolved): Chain {
  const chain = {} as Chain;

  for (const name of ['select', 'eq', 'in', 'not']) {
    chain[name] = jest.fn(() => chain);
  }

  Object.assign(chain, {
    then: (onFulfilled: (value: Resolved) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled),
  });

  return chain;
}

function rows(data: unknown): Resolved {
  return { data, error: null };
}

function user(
  id: string,
  first: string | null,
  last: string | null,
  isActive: boolean | null = true,
) {
  return {
    id,
    first_name: first,
    last_name: last,
    email: `${id}@example.com`,
    avatar_url: null,
    is_active: isActive,
  };
}

describe('userDisplayName', () => {
  it('joins first and last name', () => {
    expect(
      userDisplayName({
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'a@x.io',
      }),
    ).toBe('Ada Lovelace');
  });

  it('falls back to the email, then to an empty string', () => {
    expect(
      userDisplayName({ first_name: ' ', last_name: null, email: 'a@x.io' }),
    ).toBe('a@x.io');
    expect(
      userDisplayName({ first_name: null, last_name: null, email: null }),
    ).toBe('');
  });
});

describe('chunk', () => {
  it('splits a list into parts of the given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('uses parts of 100 by default and returns nothing for an empty list', () => {
    expect(
      chunk(Array.from({ length: 250 }, (_, i) => i)).map(
        (part) => part.length,
      ),
    ).toEqual([100, 100, 50]);
    expect(chunk([])).toEqual([]);
  });
});

describe('TesterEligibilityService', () => {
  let service: TesterEligibilityService;
  let from: jest.Mock;
  let hasSpacePermission: jest.Mock;
  let resolveTestManagementPermissions: jest.Mock;
  let queues: Record<string, Resolved[]>;

  beforeEach(() => {
    queues = {};
    from = jest.fn((table: string) =>
      buildChain(queues[table]?.shift() ?? rows([])),
    );
    hasSpacePermission = jest.fn().mockResolvedValue(false);
    // Group-only members may hold execute_tests but have no own row.
    resolveTestManagementPermissions = jest.fn().mockResolvedValue({
      isMember: true,
      hasOwnRow: false,
      permissions: { execute_tests: true },
    });

    service = new TesterEligibilityService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      {
        hasSpacePermission,
        resolveTestManagementPermissions,
      } as unknown as PermissionsService,
    );
  });

  // Role defaults here lack execute_tests: only admins, explicit grants and passing group or role members qualify.
  function seedSpace() {
    queues.organization_members = [
      rows([{ user_id: 'admin' }]),
      rows([
        { user_id: 'member-granted' },
        { user_id: 'viewer-granted' },
        { user_id: 'inactive' },
        { user_id: 'via-group' },
      ]),
    ];
    queues.space_members = [
      rows([
        { user_id: 'member-plain', space_role: 'member', permissions: null },
        {
          user_id: 'member-granted',
          space_role: 'member',
          permissions: { execute_tests: true },
        },
        {
          user_id: 'viewer-granted',
          space_role: 'viewer',
          permissions: { execute_tests: true },
        },
        {
          user_id: 'outsider',
          space_role: 'member',
          permissions: { execute_tests: true },
        },
        {
          user_id: 'inactive',
          space_role: 'member',
          permissions: { execute_tests: true },
        },
      ]),
      rows([
        { group_id: 'group-1', role_id: null },
        { group_id: null, role_id: 'role-1' },
      ]),
    ];
    queues.user_group_members = [
      rows([{ user_id: 'via-group' }, { user_id: 'member-plain' }]),
    ];
    queues.user_role_assignments = [rows([{ user_id: 'via-role' }])];
    queues.users = [
      rows([
        user('admin', 'Zed', 'Admin'),
        { ...user('member-granted', null, null), email: 'm@example.com' },
        user('viewer-granted', 'Amy', 'Viewer'),
        user('via-group', 'Bob', 'Group'),
        user('inactive', 'Ian', 'Inactive', false),
      ]),
    ];
    hasSpacePermission.mockImplementation((userId: string) =>
      Promise.resolve(userId === 'via-group'),
    );
  }

  it('decides eligibility for admins, explicit grants and group or role members', async () => {
    seedSpace();

    const ids = await service.eligibleUserIds(ORG, SPACE);

    expect([...ids].sort()).toEqual([
      'admin',
      'member-granted',
      'via-group',
      'viewer-granted',
    ]);
  });

  it('asks the per-space permission check for every member with their own row', async () => {
    seedSpace();

    await service.eligibleUserIds(ORG, SPACE);

    const checked = (hasSpacePermission.mock.calls as unknown[][]).map(
      (call) => call[0],
    );

    expect(checked.sort()).toEqual([
      'inactive',
      'member-granted',
      'member-plain',
      'outsider',
      'viewer-granted',
    ]);
    expect(hasSpacePermission).toHaveBeenCalledWith(
      'member-granted',
      ORG,
      SPACE,
      'execute_tests',
    );
  });

  it('does not offer members who reach the space only through a group or role', async () => {
    seedSpace();

    await service.eligibleUserIds(ORG, SPACE);

    const checked = (
      resolveTestManagementPermissions.mock.calls as unknown[][]
    ).map((call) => call[0]);

    // member-plain has its own row, so only the two group-only users are asked.
    expect(checked.sort()).toEqual(['via-group', 'via-role']);

    const orgChecks = (from.mock.calls as unknown[][]).filter(
      (call) => call[0] === 'organization_members',
    );

    // Nobody was granted besides the admin, so the org member lookup is skipped.
    expect(orgChecks).toHaveLength(1);
  });

  it('lists eligible testers sorted by name, with the email when there is no name', async () => {
    seedSpace();

    const testers = await service.listEligible(ORG, SPACE);

    expect(testers.map((tester) => tester.name)).toEqual([
      'Amy Viewer',
      'Bob Group',
      'm@example.com',
      'Zed Admin',
    ]);
    expect(testers[0]).toEqual({
      id: 'viewer-granted',
      name: 'Amy Viewer',
      email: 'viewer-granted@example.com',
      avatar_url: null,
    });
  });

  it('skips the organization member check when only admins are granted', async () => {
    queues.organization_members = [rows([{ user_id: 'admin' }])];
    queues.users = [rows([user('admin', 'Zed', 'Admin')])];

    await expect(service.eligibleUserIds(ORG, SPACE)).resolves.toEqual(
      new Set(['admin']),
    );
    expect(
      (from.mock.calls as unknown[][]).filter(
        (call) => call[0] === 'organization_members',
      ),
    ).toHaveLength(1);
  });

  describe('assertEligible', () => {
    it('passes for an eligible user', async () => {
      seedSpace();

      await expect(
        service.assertEligible(ORG, SPACE, 'via-group'),
      ).resolves.toBeUndefined();
    });

    it.each(['member-plain', 'outsider', 'inactive', 'unknown'])(
      'answers %s with the same generic 400',
      async (userId) => {
        seedSpace();

        const error = await service.assertEligible(ORG, SPACE, userId).then(
          () => undefined,
          (caught: unknown) => caught,
        );

        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getResponse()).toEqual({
          code: 'VALIDATION_FAILED',
          message: 'The user cannot be assigned',
        });
      },
    );
  });

  it('turns a database error into a 500', async () => {
    queues.organization_members = [
      { data: null, error: { code: 'XX000', message: 'boom' } },
    ];

    await expect(service.eligibleUserIds(ORG, SPACE)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});
