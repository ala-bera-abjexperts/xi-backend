/**
 * @fileoverview Unit tests for FileExplorerAccessService — the single authorisation
 * choke-point for node-level File Explorer access.
 *
 * The central case is the production regression this service caused: a user the space
 * guard admits for listing was denied by this gate, so every node-level route
 * (download, preview-url, versions, rename, move, copy, delete) returned 404 while the
 * file was plainly visible in the list.
 * @module src/file-explorer/file-explorer-access.service.spec
 * @author Prince Jadiya
 */

import { FileExplorerAccessService } from './file-explorer-access.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { PermissionsService } from '../permissions/permissions.service';
import type { ISpaceBaseGrant } from '../permissions/models/space-permissions.model';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { IFeNode } from './interfaces/fe-node.interface';

describe('FileExplorerAccessService', () => {
  let service: FileExplorerAccessService;
  let mockFrom: jest.Mock;
  let getUserSpacePermissions: jest.Mock;
  let resolveSpaceBaseGrant: jest.Mock;

  const USER = 'user-1';
  const ORG = 'org-1';
  const SPACE = 'space-1';

  const user = { userId: USER, organizationId: ORG } as RequestUser;

  const node = (over: Partial<IFeNode> = {}) =>
    ({
      id: 'node-1',
      organization_id: ORG,
      space_id: SPACE,
      ancestor_ids: [],
      ...over,
    }) as IFeNode;

  /** Stub the fe_shares lookup with the given rows. */
  const withShares = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;

    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.in = jest.fn().mockResolvedValue({ data: rows, error: null });

    mockFrom.mockReturnValueOnce(chain);
  };

  /** A grant as resolveSpaceBaseGrant would return it. */
  const grant = (over: Partial<ISpaceBaseGrant> = {}): ISpaceBaseGrant => ({
    isAdmin: false,
    isMember: false,
    spaceRole: null,
    explicit: {},
    basePermissions: {},
    ...over,
  });

  beforeEach(() => {
    mockFrom = jest.fn();
    getUserSpacePermissions = jest.fn().mockResolvedValue(null);
    resolveSpaceBaseGrant = jest.fn().mockResolvedValue(grant());

    const supa = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;

    const perms = {
      getUserSpacePermissions,
      resolveSpaceBaseGrant,
    } as unknown as PermissionsService;

    service = new FileExplorerAccessService(supa, perms);
  });

  // ── Org gate ──────────────────────────────────────────────────────────────

  it('denies a node belonging to another organization before any lookup', async () => {
    const r = await service.resolveEffectivePermission(
      user,
      node({ organization_id: 'other-org' }),
    );

    expect(r).toEqual({ canView: false, canCreate: false, canDelete: false });
    expect(getUserSpacePermissions).not.toHaveBeenCalled();
    expect(resolveSpaceBaseGrant).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  // ── The production regression ─────────────────────────────────────────────

  it('REGRESSION: grants view when space_permissions carries a backfilled false but the base role allows it', async () => {
    // Exactly the production shape: the member IS resolved, but the merged
    // space_permissions row overwrote view_file_explorer with its DEFAULT false.
    getUserSpacePermissions.mockResolvedValue({
      isMember: true,
      spaceRole: 'admin',
      globalRole: 'admin',
      permissions: {
        view_file_explorer: false,
        create_file_explorer: false,
        delete_file_explorer: false,
      },
    });
    resolveSpaceBaseGrant.mockResolvedValue(
      grant({
        isMember: true,
        spaceRole: 'admin',
        basePermissions: {
          view_file_explorer: true,
          create_file_explorer: true,
          delete_file_explorer: true,
        },
      }),
    );

    const r = await service.resolveEffectivePermission(user, node());

    expect(r).toEqual({ canView: true, canCreate: true, canDelete: true });
    // Full access — the share lookup must be skipped.
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('grants an org admin/owner regardless of any stored space permission', async () => {
    getUserSpacePermissions.mockResolvedValue({
      isMember: true,
      spaceRole: 'viewer',
      globalRole: 'admin',
      permissions: { view_file_explorer: false },
    });
    resolveSpaceBaseGrant.mockResolvedValue(
      grant({ isAdmin: true, isMember: true }),
    );

    const r = await service.resolveEffectivePermission(user, node());

    expect(r).toEqual({ canView: true, canCreate: true, canDelete: true });
  });

  it('grants a member whose member_type is NULL (excluded by getUserSpacePermissions)', async () => {
    // getUserSpacePermissions filters member_type='user' and misses the row entirely;
    // the guard-equivalent grant does not filter, so access is preserved.
    getUserSpacePermissions.mockResolvedValue({
      isMember: false,
      spaceRole: null,
      globalRole: null,
      permissions: {},
    });
    resolveSpaceBaseGrant.mockResolvedValue(
      grant({
        isMember: true,
        spaceRole: 'member',
        basePermissions: {
          view_file_explorer: true,
          create_file_explorer: true,
          delete_file_explorer: false,
        },
      }),
    );
    withShares([]);

    const r = await service.resolveEffectivePermission(user, node());

    expect(r).toEqual({ canView: true, canCreate: true, canDelete: false });
  });

  // ── Denials that must still deny ──────────────────────────────────────────

  it('denies a non-member with no share', async () => {
    withShares([]);

    const r = await service.resolveEffectivePermission(user, node());

    expect(r).toEqual({ canView: false, canCreate: false, canDelete: false });
  });

  it('denies a member whose space role grants nothing for file explorer', async () => {
    resolveSpaceBaseGrant.mockResolvedValue(
      grant({ isMember: true, spaceRole: 'Guest', basePermissions: {} }),
    );
    withShares([]);

    const r = await service.resolveEffectivePermission(user, node());

    expect(r).toEqual({ canView: false, canCreate: false, canDelete: false });
  });

  // ── Shares still work for non-members ─────────────────────────────────────

  it('grants a non-member through a direct share', async () => {
    withShares([
      {
        can_view: true,
        can_create: false,
        can_delete: false,
        expires_at: null,
      },
    ]);

    const r = await service.resolveEffectivePermission(user, node());

    expect(r).toEqual({ canView: true, canCreate: false, canDelete: false });
  });

  it('ignores an expired share', async () => {
    withShares([
      {
        can_view: true,
        can_create: true,
        can_delete: true,
        expires_at: new Date(Date.now() - 1000).toISOString(),
      },
    ]);

    const r = await service.resolveEffectivePermission(user, node());

    expect(r).toEqual({ canView: false, canCreate: false, canDelete: false });
  });

  it('searches the node and all of its ancestors for inherited shares', async () => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;

    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.in = jest.fn().mockResolvedValue({ data: [], error: null });
    mockFrom.mockReturnValueOnce(chain);

    await service.resolveEffectivePermission(
      user,
      node({ ancestor_ids: ['folder-1', 'folder-2'] }),
    );

    expect(chain.in).toHaveBeenCalledWith('node_id', [
      'node-1',
      'folder-1',
      'folder-2',
    ]);
  });

  it('keeps an explicit space-permission grant that the base role does not give', async () => {
    // space_module_permissions can widen a viewer beyond the base role; that must survive.
    getUserSpacePermissions.mockResolvedValue({
      isMember: true,
      spaceRole: 'viewer',
      globalRole: null,
      permissions: {
        view_file_explorer: true,
        create_file_explorer: true,
        delete_file_explorer: true,
      },
    });

    const r = await service.resolveEffectivePermission(user, node());

    expect(r).toEqual({ canView: true, canCreate: true, canDelete: true });
    expect(resolveSpaceBaseGrant).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
