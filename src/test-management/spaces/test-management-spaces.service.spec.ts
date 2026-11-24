import {
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';

import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import type { PermissionsService } from '../../permissions/permissions.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { TestManagementAccessService } from '../access/test-management-access.service';
import { TestManagementSpacesService } from './test-management-spaces.service';

const ORG = 'org-1';
const user = { userId: 'user-1', organizationId: ORG } as RequestUser;

interface Resolved {
  data: unknown;
  error: { code?: string; message: string } | null;
}

type Chain = Record<string, jest.Mock> & PromiseLike<Resolved>;

function buildChain(resolved: Resolved): Chain {
  const chain = {} as Chain;

  for (const name of ['select', 'eq', 'not']) {
    chain[name] = jest.fn(() => chain);
  }

  Object.assign(chain, {
    then: (onFulfilled: (value: Resolved) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled),
  });

  return chain;
}

/** Decision with view_tests set; hasOwnRow false for group-only members. */
function grant(view: boolean, hasOwnRow = true) {
  return { isMember: true, hasOwnRow, permissions: { view_tests: view } };
}

function spaceRow(id: string, name: string, deletingAt: string | null = null) {
  return {
    spaces: { id, key: id.toUpperCase(), name, deleting_at: deletingAt },
  };
}

describe('TestManagementSpacesService', () => {
  let service: TestManagementSpacesService;
  let from: jest.Mock;
  let assertTenantEnabled: jest.Mock;
  let resolveTestManagementPermissions: jest.Mock;

  beforeEach(() => {
    from = jest.fn();
    assertTenantEnabled = jest.fn().mockResolvedValue(undefined);
    resolveTestManagementPermissions = jest.fn().mockResolvedValue(grant(true));

    service = new TestManagementSpacesService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      { assertTenantEnabled } as unknown as TestManagementAccessService,
      { resolveTestManagementPermissions } as unknown as PermissionsService,
    );
  });

  it('lists enabled spaces of the org, sorted by name, with id, key and name only', async () => {
    const chain = buildChain({
      data: [spaceRow('s-2', 'Zeta'), spaceRow('s-1', 'Alpha')],
      error: null,
    });

    from.mockReturnValueOnce(chain);

    await expect(service.listForUser(user)).resolves.toEqual([
      { id: 's-1', key: 'S-1', name: 'Alpha' },
      { id: 's-2', key: 'S-2', name: 'Zeta' },
    ]);
    expect(assertTenantEnabled).toHaveBeenCalledWith(ORG);
    expect(from).toHaveBeenCalledWith('space_modules');
    expect(chain.eq).toHaveBeenCalledWith('module_type', 'test_management');
    expect(chain.eq).toHaveBeenCalledWith('is_enabled', true);
    expect(chain.eq).toHaveBeenCalledWith('spaces.organization_id', ORG);
    expect(chain.not).toHaveBeenCalledWith('spaces.is_archived', 'is', true);
  });

  it('leaves out spaces being deleted and rows without a space', async () => {
    from.mockReturnValueOnce(
      buildChain({
        data: [
          spaceRow('s-1', 'Alpha'),
          spaceRow('s-2', 'Beta', '2026-10-20T10:00:00Z'),
          { spaces: null },
        ],
        error: null,
      }),
    );

    await expect(service.listForUser(user)).resolves.toEqual([
      { id: 's-1', key: 'S-1', name: 'Alpha' },
    ]);
    expect(resolveTestManagementPermissions).toHaveBeenCalledTimes(1);
  });

  it('keeps only spaces where the user holds view_tests', async () => {
    from.mockReturnValueOnce(
      buildChain({
        data: [spaceRow('s-1', 'Alpha'), spaceRow('s-2', 'Beta')],
        error: null,
      }),
    );
    resolveTestManagementPermissions.mockImplementation(
      (_user: string, _org: string, spaceId: string) =>
        Promise.resolve(grant(spaceId === 's-2')),
    );

    await expect(service.listForUser(user)).resolves.toEqual([
      { id: 's-2', key: 'S-2', name: 'Beta' },
    ]);
    expect(resolveTestManagementPermissions).toHaveBeenCalledWith(
      'user-1',
      ORG,
      's-1',
    );
  });

  it('leaves out spaces the user reaches only through a group or role', async () => {
    from.mockReturnValueOnce(
      buildChain({ data: [spaceRow('s-1', 'Alpha')], error: null }),
    );
    resolveTestManagementPermissions.mockResolvedValueOnce(grant(true, false));

    await expect(service.listForUser(user)).resolves.toEqual([]);
  });

  it('returns an empty list when no space has the module on', async () => {
    from.mockReturnValueOnce(buildChain({ data: null, error: null }));

    await expect(service.listForUser(user)).resolves.toEqual([]);
  });

  it('does not query when the tenant module is off', async () => {
    assertTenantEnabled.mockRejectedValueOnce(new ForbiddenException());

    await expect(service.listForUser(user)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(from).not.toHaveBeenCalled();
  });

  it('turns a database error into a 500', async () => {
    from.mockReturnValueOnce(
      buildChain({ data: null, error: { code: 'XX000', message: 'boom' } }),
    );

    await expect(service.listForUser(user)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});
