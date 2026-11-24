/**
 * @fileoverview Unit tests for SavedFiltersService — list scoping (owner +
 * org-visible + permission-granted), CRUD with owner/edit-permission gates,
 * favorite ownership, getDefaults, permissions delete-then-insert flow,
 * subscription upsert + ownership-scoped delete.
 *
 * Note: filter execution (executeAdHoc / executeFilter / exportToCSV) and
 * field-discovery helpers are covered separately because they depend on the
 * FilterQueryEngine subsystem; this spec keeps the scope to direct DB-backed
 * service methods.
 *
 * @module src/saved-filters/saved-filters.service.spec
 * @author Prince Jadiya
 */

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { SavedFiltersService } from './saved-filters.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { PermissionsService } from '../permissions/permissions.service';
import { EntitlementsService } from '../licensing/entitlements.service';

// The Development gate is an RPC and a table with their own tests: here every task and space is in, and every
// repository is assigned, because these specs are about what happens behind it.
jest.mock('../git-integrations/git-integrations.util', () => ({
  ...jest.requireActual('../git-integrations/git-integrations.util'),
  developmentTaskIds: jest.fn((_db: unknown, _org: string, ids: string[]) =>
    Promise.resolve(new Set(ids)),
  ),
  developmentSpaceIds: jest.fn((_db: unknown, ids: string[]) =>
    Promise.resolve(ids),
  ),
  spaceRepositoryIds: jest.fn(() =>
    Promise.resolve({ get: () => ({ has: () => true }) }),
  ),
}));

describe('SavedFiltersService', () => {
  let service: SavedFiltersService;
  let mockFrom: jest.Mock;
  let mockRpc: jest.Mock;
  let mockPermissions: {
    getUserSpacePermissions: jest.Mock;
    isAdminOrOwner: jest.Mock;
  };
  let gitEntitled: boolean;

  const ORG = 'org-1';
  const USER = 'user-1';

  const mockFilter = {
    id: 'flt-1',
    organization_id: ORG,
    owner_id: USER,
    name: 'My open tasks',
    description: null,
    query: { combinator: 'and', rules: [] },
    source_type: 'tasks',
    source_space_ids: [],
    source_entity_types: ['task'],
    source_filter_id: null,
    columns: [],
    sort_config: null,
    visibility: 'private',
    is_default: false,
    is_favorite: false,
  };
  const validQuery = { combinator: 'and', rules: [] };

  function buildChain(resolved: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.or = jest.fn().mockImplementation(self);
    chain.ilike = jest.fn().mockImplementation(self);
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
    mockRpc = jest.fn().mockResolvedValue({ data: mockFilter, error: null });
    const supa = {
      getClient: () => ({ from: mockFrom, rpc: mockRpc }),
    } as unknown as SupabaseAdminService;
    mockPermissions = {
      getUserSpacePermissions: jest.fn().mockResolvedValue({
        isMember: true,
        permissions: {
          view_processes: true,
          view_tasks: true,
          view_lists: true,
        },
      }),
      isAdminOrOwner: jest.fn().mockResolvedValue(false),
    };
    gitEntitled = false;
    service = new SavedFiltersService(
      supa,
      mockPermissions as unknown as PermissionsService,
      {
        getEffectiveEntitlements: jest.fn(() =>
          Promise.resolve({
            has: (key: string) =>
              gitEntitled && key === 'feature_external_integrations',
          }),
        ),
      } as unknown as EntitlementsService,
    );
  });

  function mockShareLookups(permissionRows: unknown[] = []) {
    mockFrom
      .mockReturnValueOnce(buildChain({ data: [], error: null })) // group memberships
      .mockReturnValueOnce(buildChain({ data: [], error: null })) // role assignments
      .mockReturnValueOnce(buildChain({ data: [], error: null })) // direct space memberships
      .mockReturnValueOnce(buildChain({ data: permissionRows, error: null })); // saved_filter_permissions
  }

  // ── getAll ─────────────────────────────────────────────────────────────

  describe('getAll', () => {
    it('returns owned + org-visible filters when user has no permissions', async () => {
      const orChain = buildChain({ data: [mockFilter], error: null });
      mockShareLookups();
      mockFrom.mockReturnValueOnce(orChain); // filters query
      const r = await service.getAll(ORG, USER);
      expect(r.data).toHaveLength(1);
      // The .or clause must include both owner_id and visibility filters
      const orCall = (
        (orChain.or as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0] as string;
      expect(orCall).toContain('owner_id.eq.user-1');
      expect(orCall).toContain('visibility.eq.organization');
    });

    it('extends the OR clause with permission-granted filter ids', async () => {
      const orChain = buildChain({ data: [mockFilter], error: null });
      mockShareLookups([{ filter_id: 'flt-shared' }]);
      mockFrom.mockReturnValueOnce(orChain); // filters query
      await service.getAll(ORG, USER);
      const orCall = (
        (orChain.or as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0] as string;
      expect(orCall).toContain('id.in.(flt-shared)');
    });

    it('applies search/visibility/is_favorite filters when supplied', async () => {
      const orChain = buildChain({ data: [], error: null });
      mockShareLookups();
      mockFrom.mockReturnValueOnce(orChain);
      await service.getAll(ORG, USER, {
        search: 'open',
        visibility: 'private',
        is_favorite: true,
      });
      const eqCalls = (orChain.eq as jest.Mock).mock.calls.map(
        (c) => (c as unknown[])[0],
      );
      expect(eqCalls).toEqual(
        expect.arrayContaining([
          'organization_id',
          'visibility',
          'is_favorite',
          'owner_id',
        ]),
      );
      expect(orChain.ilike).toHaveBeenCalledWith('name', '%open%');
    });

    it('throws BadRequest when filters query errors', async () => {
      mockShareLookups();
      mockFrom.mockReturnValueOnce(
        buildChain({ data: null, error: { message: 'fail' } }),
      );
      await expect(service.getAll(ORG, USER)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── getById ────────────────────────────────────────────────────────────

  describe('getById', () => {
    it('returns the filter when found', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockFilter, error: null }),
      );
      const r = await service.getById('flt-1', ORG, USER);
      expect(r.data).toEqual(mockFilter);
    });

    it('throws NotFound when missing', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(service.getById('missing', ORG, USER)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── getDefaults ────────────────────────────────────────────────────────

  describe('getDefaults', () => {
    it('returns rows where is_default=true', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: [{ ...mockFilter, is_default: true }],
          error: null,
        }),
      );
      const r = await service.getDefaults(ORG);
      expect(r.count).toBe(1);
      expect((r.data[0] as { is_default: boolean }).is_default).toBe(true);
    });
  });

  // ── create ─────────────────────────────────────────────────────────────

  describe('create', () => {
    it('inserts a new filter under the supplied owner', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockFilter, error: null }),
      );
      const r = await service.create(ORG, USER, {
        name: 'My open tasks',
        query: validQuery,
        source_type: 'tasks',
      } as never);
      expect((r.data as { id: string }).id).toBe('flt-1');
      expect(mockRpc).toHaveBeenCalledWith(
        'create_saved_filter_with_space_permissions',
        expect.objectContaining({
          p_organization_id: ORG,
          p_owner_id: USER,
          p_visibility: 'private',
        }),
      );
    });

    it('throws BadRequest on insert failure', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'fk fail' },
      });
      await expect(
        service.create(ORG, USER, {
          name: 'X',
          query: validQuery,
          source_type: 'tasks',
        } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects malformed query payloads before insert', async () => {
      await expect(
        service.create(ORG, USER, {
          name: 'X',
          query: {},
          source_type: 'tasks',
        } as never),
      ).rejects.toThrow(/Invalid query/);
      expect(mockFrom).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('requires source_filter_id when source_type is filter', async () => {
      await expect(
        service.create(ORG, USER, {
          name: 'Sub filter',
          query: validQuery,
          source_type: 'filter',
        } as never),
      ).rejects.toThrow(/source_filter_id is required/);
      expect(mockFrom).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('rejects unknown custom-field query fields before insert', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: [], error: null }));

      await expect(
        service.create(ORG, USER, {
          name: 'X',
          query: {
            combinator: 'and',
            rules: [
              {
                field: 'cf_risk),id.neq.injected',
                operator: 'contains',
                value: 'open',
              },
            ],
          },
          source_type: 'tasks',
        } as never),
      ).rejects.toThrow(/Invalid custom filter field/);

      expect(mockRpc).not.toHaveBeenCalled();
    });
  });

  // ── update ─────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates the filter when caller is the owner', async () => {
      const updated = { ...mockFilter, name: 'Renamed' };
      mockRpc.mockResolvedValueOnce({ data: updated, error: null });
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockFilter, error: null }),
      ); // getById
      const r = await service.update('flt-1', ORG, USER, {
        name: 'Renamed',
      } as never);
      expect((r.data as { name: string }).name).toBe('Renamed');
    });

    it('rejects when patch is empty', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockFilter, error: null }),
      );
      await expect(
        service.update('flt-1', ORG, USER, {} as never),
      ).rejects.toThrow(/At least one field/);
    });

    it('allows non-owners with can_edit permission', async () => {
      const otherFilter = {
        ...mockFilter,
        owner_id: 'other-user',
        visibility: 'organization',
      };
      const updated = { ...otherFilter, name: 'Edited' };
      mockRpc.mockResolvedValueOnce({ data: updated, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: otherFilter, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // group memberships
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // role assignments
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // direct space memberships
        .mockReturnValueOnce(
          buildChain({ data: [{ filter_id: 'flt-1' }], error: null }),
        );
      const r = await service.update('flt-1', ORG, USER, {
        name: 'Edited',
      } as never);
      expect((r.data as { name: string }).name).toBe('Edited');
    });

    it('forbids non-owners without can_edit permission', async () => {
      const otherFilter = {
        ...mockFilter,
        owner_id: 'other-user',
        visibility: 'organization',
      };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: otherFilter, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // group memberships
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // role assignments
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // direct space memberships
        .mockReturnValueOnce(buildChain({ data: [], error: null })); // checkPermission → false
      await expect(
        service.update('flt-1', ORG, USER, { name: 'X' } as never),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ── delete ─────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('deletes a non-default owned filter', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockFilter, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // delete
      const r = await service.delete('flt-1', ORG, USER);
      expect(r.success).toBe(true);
    });

    it('refuses to delete system default filters', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { ...mockFilter, is_default: true }, error: null }),
      );
      await expect(service.delete('flt-1', ORG, USER)).rejects.toThrow(
        /default filters/,
      );
    });

    it('allows non-owners with can_delete permission', async () => {
      const otherFilter = {
        ...mockFilter,
        owner_id: 'other-user',
        visibility: 'organization',
      };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: otherFilter, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // group memberships
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // role assignments
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // direct space memberships
        .mockReturnValueOnce(
          buildChain({ data: [{ filter_id: 'flt-1' }], error: null }),
        )
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // delete
      const r = await service.delete('flt-1', ORG, USER);
      expect(r.success).toBe(true);
    });

    it('forbids non-owners without can_delete permission', async () => {
      const otherFilter = {
        ...mockFilter,
        owner_id: 'other-user',
        visibility: 'organization',
      };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: otherFilter, error: null }))
        .mockReturnValueOnce(buildChain({ data: [], error: null }))
        .mockReturnValueOnce(buildChain({ data: [], error: null }))
        .mockReturnValueOnce(buildChain({ data: [], error: null }))
        .mockReturnValueOnce(buildChain({ data: [], error: null }));
      await expect(service.delete('flt-1', ORG, USER)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // ── toggleFavorite ─────────────────────────────────────────────────────

  describe('toggleFavorite', () => {
    it('flips is_favorite for the owner', async () => {
      const updated = { ...mockFilter, is_favorite: true };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockFilter, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: updated, error: null })); // update
      const r = await service.toggleFavorite('flt-1', ORG, USER);
      expect((r.data as { is_favorite: boolean }).is_favorite).toBe(true);
    });

    it('forbids non-owners from toggling favorites', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: {
            ...mockFilter,
            owner_id: 'other',
            visibility: 'organization',
          },
          error: null,
        }),
      );
      await expect(service.toggleFavorite('flt-1', ORG, USER)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // ── Permissions ────────────────────────────────────────────────────────

  describe('getPermissions', () => {
    it('returns existing permissions when caller is the owner', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockFilter, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({
            data: [{ id: 'p-1', filter_id: 'flt-1', target_type: 'user' }],
            error: null,
          }),
        );
      const r = await service.getPermissions('flt-1', ORG, USER);
      expect(r.data).toHaveLength(1);
    });

    it('forbids non-owners', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: {
            ...mockFilter,
            owner_id: 'other',
            visibility: 'organization',
          },
          error: null,
        }),
      );
      await expect(service.getPermissions('flt-1', ORG, USER)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('setPermissions', () => {
    it('deletes existing then inserts new permission rows', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockFilter, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // existing permissions
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // upsert new
      const r = await service.setPermissions('flt-1', ORG, USER, {
        permissions: [
          {
            target_type: 'user',
            target_id: 'u-2',
            can_view: true,
            can_edit: false,
          },
        ],
      } as never);
      expect(r.success).toBe(true);
    });

    it('returns success without inserting when permissions array is empty', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockFilter, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // delete only
      const r = await service.setPermissions('flt-1', ORG, USER, {
        permissions: [],
      } as never);
      expect(r.success).toBe(true);
    });

    it('forbids non-owners', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: {
            ...mockFilter,
            owner_id: 'other',
            visibility: 'organization',
          },
          error: null,
        }),
      );
      await expect(
        service.setPermissions('flt-1', ORG, USER, {
          permissions: [],
        } as never),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequest when the new-row insert fails (perms wiped warning)', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'fail' },
      });
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockFilter, error: null }),
      );
      await expect(
        service.setPermissions('flt-1', ORG, USER, {
          permissions: [
            { target_type: 'user', target_id: 'u-2', can_view: true } as never,
          ],
        } as never),
      ).rejects.toThrow(/Failed to set permissions/);
    });
  });

  // ── Subscriptions ──────────────────────────────────────────────────────

  describe('getSubscriptions', () => {
    it('returns every subscription for a filter owner', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockFilter, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({
            data: [{ id: 's-1', filter_id: 'flt-1', user_id: USER }],
            error: null,
          }),
        );
      const r = await service.getSubscriptions('flt-1', ORG, USER);
      expect(r.data).toHaveLength(1);
      expect(mockPermissions.isAdminOrOwner).not.toHaveBeenCalled();
    });

    it('only returns the caller subscription for a shared filter viewer', async () => {
      const subscriptionChain = buildChain({
        data: [{ id: 's-1', filter_id: 'flt-1', user_id: USER }],
        error: null,
      });
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: {
              ...mockFilter,
              owner_id: 'owner-2',
              visibility: 'organization',
            },
            error: null,
          }),
        ) // getById
        .mockReturnValueOnce(subscriptionChain);

      const r = await service.getSubscriptions('flt-1', ORG, USER);
      expect(r.data).toHaveLength(1);
      expect(mockPermissions.isAdminOrOwner).toHaveBeenCalledWith(USER, ORG);
      expect(subscriptionChain.eq).toHaveBeenCalledWith('user_id', USER);
    });
  });

  describe('createSubscription', () => {
    it('upserts a subscription for the user', async () => {
      const created = {
        id: 's-1',
        filter_id: 'flt-1',
        user_id: USER,
        schedule_cron: '0 9 * * *',
      };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockFilter, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: created, error: null })); // upsert
      const r = await service.createSubscription('flt-1', ORG, USER, {
        schedule_cron: '0 9 * * *',
      } as never);
      expect((r.data as { id: string }).id).toBe('s-1');
    });
  });

  // ── Execute source filters ─────────────────────────────────────────────

  describe('executeAdHoc', () => {
    it('normalizes legacy singular entity type names before permission scoping', async () => {
      const execute = jest.fn().mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        pageSize: 50,
        hasMore: false,
        executedAt: '2026-05-10T00:00:00.000Z',
      });

      (
        service as unknown as { queryEngine: { execute: jest.Mock } }
      ).queryEngine = {
        execute,
      };

      mockFrom
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // buildFieldTypeMap
        .mockReturnValueOnce(
          buildChain({ data: [{ id: 'space-1' }], error: null }),
        ); // org spaces
      mockShareLookups();
      mockFrom.mockReturnValueOnce(
        buildChain({ data: [{ id: 'flt-1' }], error: null }),
      ); // accessible filter ids

      await service.executeAdHoc(
        {
          query: validQuery,
          source_type: 'spaces',
          source_entity_types: ['task', 'process', 'list_item'],
        } as never,
        ORG,
        USER,
      );

      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          permittedSpaceIdsByEntity: {
            processes: ['space-1'],
            tasks: ['space-1'],
            lists: ['space-1'],
          },
        }),
      );
    });

    it('computes permission scopes for every entity type when source_type is filter', async () => {
      const execute = jest.fn().mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        pageSize: 50,
        hasMore: false,
        executedAt: '2026-05-10T00:00:00.000Z',
      });

      (
        service as unknown as { queryEngine: { execute: jest.Mock } }
      ).queryEngine = {
        execute,
      };

      // A 'filter' source fans out over wiki too, so the space grant must
      // include the wiki view permission for its scope to resolve.
      mockPermissions.getUserSpacePermissions.mockResolvedValue({
        isMember: true,
        permissions: {
          view_processes: true,
          view_tasks: true,
          view_lists: true,
          view_wiki_pages: true,
        },
      });

      mockFrom
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // buildFieldTypeMap
        .mockReturnValueOnce(
          buildChain({ data: [{ id: 'space-1' }], error: null }),
        ) // org spaces
        .mockReturnValueOnce(
          buildChain({
            data: {
              ...mockFilter,
              id: 'source-filter',
              visibility: 'organization',
            },
            error: null,
          }),
        ); // source filter visibility check

      mockShareLookups(['source-filter'].map((filter_id) => ({ filter_id })));
      mockFrom.mockReturnValueOnce(
        buildChain({ data: [{ id: 'source-filter' }], error: null }),
      ); // accessible filter ids

      await service.executeAdHoc(
        {
          query: validQuery,
          source_type: 'filter',
          source_filter_id: 'source-filter',
          source_entity_types: ['tasks'],
        } as never,
        ORG,
        USER,
      );

      expect(mockPermissions.getUserSpacePermissions).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          source_space_ids: [],
          permittedSpaceIdsByEntity: {
            processes: ['space-1'],
            tasks: ['space-1'],
            lists: ['space-1'],
            wiki: ['space-1'],
          },
        }),
      );
    });
  });

  describe('executeFilter', () => {
    it('writes an audit entry after a saved filter execution succeeds', async () => {
      const executionResult = {
        data: [{ entity_type: 'task', id: 'task-1', title: 'Open risk' }],
        total: 1,
        page: 2,
        pageSize: 25,
        hasMore: false,
        executedAt: '2026-05-10T00:00:00.000Z',
      };
      const execute = jest.fn().mockResolvedValue(executionResult);
      const logAudit = jest
        .spyOn(service as unknown as { logAudit: jest.Mock }, 'logAudit')
        .mockResolvedValue(undefined);

      (
        service as unknown as { queryEngine: { execute: jest.Mock } }
      ).queryEngine = {
        execute,
      };

      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockFilter, error: null })) // filter visibility check
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // execution stats update
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // buildFieldTypeMap
        .mockReturnValueOnce(
          buildChain({ data: [{ id: 'space-1' }], error: null }),
        ); // org spaces
      mockShareLookups([{ filter_id: 'flt-1' }]);
      mockFrom.mockReturnValueOnce(
        buildChain({ data: [{ id: 'flt-1' }], error: null }),
      ); // accessible filters

      const result = await service.executeFilter('flt-1', ORG, USER, {
        page: 2,
        pageSize: 25,
      });

      expect(result.data).toEqual(executionResult);
      expect(logAudit).toHaveBeenCalledWith(
        ORG,
        USER,
        'saved_filter',
        'flt-1',
        'execute',
        expect.objectContaining({
          page: 2,
          page_size: 25,
          row_count: 1,
          total: 1,
        }),
      );
    });
  });

  describe('deleteSubscription', () => {
    it('removes a subscription owned by the caller', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockFilter, error: null })) // getById org/visibility check
        .mockReturnValueOnce(
          buildChain({
            data: { filter_id: 'flt-1', user_id: USER },
            error: null,
          }),
        ) // existence
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // delete
      const r = await service.deleteSubscription('flt-1', 's-1', ORG, USER);
      expect(r.success).toBe(true);
    });

    it('allows filter owners to remove another user subscription shown in the dialog', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockFilter, error: null })) // getById org/visibility check
        .mockReturnValueOnce(
          buildChain({
            data: { filter_id: 'flt-1', user_id: 'other-user' },
            error: null,
          }),
        ) // existence
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // delete

      const r = await service.deleteSubscription('flt-1', 's-1', ORG, USER);

      expect(r.success).toBe(true);
    });

    it('throws NotFound when subscription is missing', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockFilter, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.deleteSubscription('flt-1', 'missing', ORG, USER),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFound when subscription belongs to a different filter path', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockFilter, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.deleteSubscription('flt-1', 's-1', ORG, USER),
      ).rejects.toThrow(NotFoundException);
    });

    it('forbids deletion when subscription belongs to another user', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: {
              ...mockFilter,
              owner_id: 'owner-2',
              visibility: 'organization',
            },
            error: null,
          }),
        )
        .mockReturnValueOnce(
          buildChain({
            data: { filter_id: 'flt-1', user_id: 'other' },
            error: null,
          }),
        );
      await expect(
        service.deleteSubscription('flt-1', 's-1', ORG, USER),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('exportToCSV', () => {
    it('writes an audit entry after generating a CSV export', async () => {
      jest.spyOn(service, 'executeFilter').mockResolvedValue({
        data: {
          data: [
            {
              entity_type: 'task',
              key: 'TS-T1',
              title: 'Open risk',
              status: 'open',
              priority: 'high',
              assigned_to: '',
              space_name: 'Default',
              created_at: '2026-01-01',
              updated_at: '2026-01-02',
            },
          ],
          total: 1,
          page: 1,
          pageSize: 10000,
          hasMore: false,
          executedAt: '2026-05-10T00:00:00.000Z',
        },
      } as never);
      const requireAudit = jest
        .spyOn(
          service as unknown as { requireAudit: jest.Mock },
          'requireAudit',
        )
        .mockResolvedValue(undefined);

      const csv = await service.exportToCSV('flt-1', ORG, USER);

      expect(csv).toContain('"task","TS-T1","Open risk"');
      const executeFilter = (service as unknown as Record<string, jest.Mock>)[
        'executeFilter'
      ];
      expect(executeFilter).toHaveBeenCalledWith(
        'flt-1',
        ORG,
        USER,
        {
          page: 1,
          pageSize: 1000,
          sort: { column: 'created_at', direction: 'asc' },
        },
        { audit: false },
      );
      expect(requireAudit).toHaveBeenCalledWith(
        ORG,
        USER,
        'saved_filter',
        'flt-1',
        'export',
        expect.objectContaining({ scope: 'csv' }),
      );
    });

    it('fails closed when the required CSV export audit write fails', async () => {
      jest.spyOn(service, 'executeFilter').mockResolvedValue({
        data: {
          data: [],
          total: 0,
          page: 1,
          pageSize: 10000,
          hasMore: false,
          executedAt: '2026-05-10T00:00:00.000Z',
        },
      } as never);
      jest
        .spyOn(
          service as unknown as { requireAudit: jest.Mock },
          'requireAudit',
        )
        .mockRejectedValue(
          new BadRequestException('Failed to write audit log'),
        );

      await expect(service.exportToCSV('flt-1', ORG, USER)).rejects.toThrow(
        BadRequestException,
      );
    });

    // Ticket 10 (D5): paging past PostgREST's 1000-row cap, assignee name, git columns.
    const task = (n: number, extra: Record<string, unknown> = {}) => ({
      id: `t-${n}`,
      entity_type: 'task',
      key: `TS-T${n}`,
      title: `Task ${n}`,
      status: 'open',
      priority: null,
      assigned_to: null,
      space_name: 'Default',
      created_at: '2026-01-01',
      updated_at: '2026-01-02',
      _entity: {},
      ...extra,
    });
    const pages = (...data: unknown[][]) => {
      const spy = jest.spyOn(service, 'executeFilter');
      data.forEach((rows, i) =>
        spy.mockResolvedValueOnce({
          data: {
            data: rows,
            total: data.flat().length,
            page: i + 1,
            pageSize: 1000,
            hasMore: i < data.length - 1,
            executedAt: '2026-05-10T00:00:00.000Z',
          },
        } as never),
      );
      return spy;
    };
    const auditSpy = () =>
      jest
        .spyOn(
          service as unknown as { requireAudit: jest.Mock },
          'requireAudit',
        )
        .mockResolvedValue(undefined);

    it('pages past 1000 rows and audits the exported row count', async () => {
      const first = Array.from({ length: 1000 }, (_, i) => task(i));
      const spy = pages(first, [task(1000), task(1001)]);
      const requireAudit = auditSpy();

      const csv = await service.exportToCSV('flt-1', ORG, USER);

      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[1][3]).toMatchObject({ page: 2, pageSize: 1000 });
      expect(csv.split('\n')).toHaveLength(1 + 1002);
      expect(csv).toContain('"TS-T1001"');
      expect(requireAudit).toHaveBeenCalledWith(
        ORG,
        USER,
        'saved_filter',
        'flt-1',
        'export',
        { scope: 'csv', row_count: 1002 },
      );
    });

    it('prints the assignee name, else the email', async () => {
      pages([
        task(1, { assigned_to: { first_name: 'Ada', last_name: 'Lovelace' } }),
        task(2, { assigned_to: { first_name: null, email: 'b@x.io' } }),
      ]);
      auditSpy();

      const csv = await service.exportToCSV('flt-1', ORG, USER);

      expect(csv).toContain('"Ada Lovelace"');
      expect(csv).toContain('"b@x.io"');
      expect(csv).not.toContain('[object Object]');
    });

    it('has no git columns without the integrations entitlement', async () => {
      pages([task(1, { _entity: { git_build_state: 'failed' } })]);
      auditSpy();

      const csv = await service.exportToCSV('flt-1', ORG, USER);

      expect(csv.split('\n')[0]).toBe(
        '"Type","Key","Title","Status","Priority","Assigned To","Space","Created","Updated","AI label"',
      );
      expect(mockFrom).not.toHaveBeenCalledWith('git_pull_request_tasks');
    });

    it('adds the AI label in the last column, from one lookup, empty on what a person made', async () => {
      pages([task(1), task(2)]);
      auditSpy();
      const labels = jest.fn().mockResolvedValue(new Map([['t-1', { confirmedBy: 'Carl', createdAt: '2026-11-05T10:00:00Z' }]]));
      (service as unknown as { origins: unknown }).origins = { labels };

      const rows = (await service.exportToCSV('flt-1', ORG, USER)).split('\n');

      expect(labels).toHaveBeenCalledTimes(1);
      expect(rows[1].endsWith('"Drafted by Robert · reviewed by Carl · 2026-11-05"')).toBe(true);
      expect(rows[2].endsWith('""')).toBe(true);
      (service as unknown as { origins: unknown }).origins = undefined;
    });

    it('appends Pull requests (one quoted multi-line cell) and Build status when entitled', async () => {
      gitEntitled = true;
      pages([
        task(1, { _entity: { git_build_state: 'failed' } }),
        { ...task(2), entity_type: 'process', _entity: {} },
      ]);
      auditSpy();
      const links = buildChain({
        data: [
          {
            task_id: 't-1',
            task: { space_id: 'space-1' },
            pull_request: {
              url: 'https://gh/x/pull/2',
              state: 'merged',
              opened_at: '2026-02-01',
            },
          },
          {
            task_id: 't-1',
            task: { space_id: 'space-1' },
            pull_request: {
              url: 'https://gh/x/pull/1',
              state: 'open',
              opened_at: '2026-01-01',
            },
          },
        ],
        error: null,
      });
      mockFrom.mockReturnValueOnce(links);

      const csv = await service.exportToCSV('flt-1', ORG, USER);

      expect(csv.split('\n')[0]).toContain(
        '"Updated","Pull requests","Build status"',
      );
      expect(csv).toContain(
        '"https://gh/x/pull/1 (open)\nhttps://gh/x/pull/2 (merged)","failed"',
      );
      // Non-task rows get empty git cells.
      expect(csv).toMatch(/"process",.*,"",""$/);
      expect(mockFrom).toHaveBeenCalledWith('git_pull_request_tasks');
      expect(links.eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(links.eq).toHaveBeenCalledWith('state', 'linked');
      expect(links.in).toHaveBeenCalledWith('task_id', ['t-1']);
    });

    it('still fails closed on the audit write when entitled', async () => {
      gitEntitled = true;
      pages([]);
      jest
        .spyOn(
          service as unknown as { requireAudit: jest.Mock },
          'requireAudit',
        )
        .mockRejectedValue(new BadRequestException('audit down'));

      await expect(service.exportToCSV('flt-1', ORG, USER)).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});

describe('SavedFiltersService.getStandardFields linked_to (XE-T532)', () => {
  let gitLicensed = true;
  const service = new SavedFiltersService(
    { getClient: () => ({}) } as unknown as SupabaseAdminService,
    {} as unknown as PermissionsService,
    {
      getEffectiveEntitlements: jest.fn(async () => ({
        has: (key: string) =>
          gitLicensed && key === 'feature_external_integrations',
      })),
    } as unknown as EntitlementsService,
  );

  beforeEach(() => {
    gitLicensed = true;
  });
  const fieldsFor = async (entityTypes: string[]) => {
    for (const fetcher of [
      'fetchStatusValues',
      'fetchPriorityValues',
      'fetchUserValues',
      'fetchRequestTypeValues',
      'fetchTaskTypeValues',
    ]) {
      jest
        .spyOn(service as never, fetcher as never)
        .mockResolvedValue([] as never);
    }
    return (
      service as unknown as {
        getStandardFields: (
          org: string,
          types: string[],
          spaces: string[],
        ) => Promise<{ name: string; [k: string]: unknown }[]>;
      }
    ).getStandardFields('org-1', entityTypes, []);
  };

  it('offers linked_to for tasks only, with exactly in / notIn', async () => {
    const field = (await fieldsFor(['tasks'])).find(
      (f) => f.name === 'linked_to',
    );

    expect(field).toEqual({
      name: 'linked_to',
      label: 'Linked to',
      inputType: 'entity-key',
      operators: [
        { name: 'in', label: 'is linked to any of' },
        { name: 'notIn', label: 'is not linked to any of' },
      ],
      entityTypes: ['tasks'],
    });
    expect((await fieldsFor([])).some((f) => f.name === 'linked_to')).toBe(
      true,
    );
  });

  it('is absent when tasks are not a source', async () => {
    expect(
      (await fieldsFor(['processes'])).some((f) => f.name === 'linked_to'),
    ).toBe(false);
  });

  it('offers the development select for tasks only (ticket 10)', async () => {
    const field = (await fieldsFor(['tasks'])).find(
      (f) => f.name === 'development',
    );

    expect(field).toEqual({
      name: 'development',
      label: 'Development',
      inputType: 'select',
      operators: [
        { name: 'eq', label: 'equals' },
        { name: 'neq', label: 'not equals' },
        { name: 'in', label: 'is one of' },
        { name: 'notIn', label: 'is not one of' },
      ],
      entityTypes: ['tasks'],
      values: [
        { name: 'has_pr', label: 'Has pull request' },
        { name: 'pr_open', label: 'Pull request open' },
        { name: 'pr_merged', label: 'Pull request merged' },
        { name: 'build_failing', label: 'Build failing' },
        { name: 'no_pr', label: 'No pull request' },
      ],
    });
    expect(
      (await fieldsFor(['processes'])).some((f) => f.name === 'development'),
    ).toBe(false);
  });

  it('does not offer the development select without the Git integration licence', async () => {
    gitLicensed = false;

    expect(
      (await fieldsFor(['tasks'])).some((f) => f.name === 'development'),
    ).toBe(false);
    expect(
      (await fieldsFor(['tasks'])).some((f) => f.name === 'linked_to'),
    ).toBe(true);
  });
});

// XE-T532 #4: the relationship picker is org-wide now, so each option carries
// its space key for the cross-space chip; spaces the viewer cannot see stay out.
describe('SavedFiltersService.getParentOptions space_key (XE-T532)', () => {
  it('maps space_key and excludes spaces the viewer cannot view tasks in', async () => {
    const chains: Record<string, Record<string, jest.Mock>[]> = {};
    const queues: Record<string, unknown[]> = {
      spaces: [
        [{ id: 's-ops' }, { id: 's-hidden' }], // org spaces
        [{ id: 's-ops', key: 'OPS' }], // key lookup
      ],
      tasks: [
        [{ id: 't-1', key: 'OPS-T1', summary: 'VPN down', space_id: 's-ops' }],
        [], // summary match
      ],
    };
    const from = jest.fn((table: string) => {
      const resolved = { data: queues[table]?.shift() ?? [], error: null };
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'not', 'ilike', 'order', 'limit'])
        chain[m] = jest.fn(() => chain);
      chain.then = (ok: (v: unknown) => unknown) =>
        Promise.resolve(resolved).then(ok);
      (chains[table] ??= []).push(chain as Record<string, jest.Mock>);
      return chain;
    });
    const permissions = {
      getUserSpacePermissions: jest.fn(
        (_user: string, _org: string, spaceId: string) =>
          Promise.resolve({
            isMember: spaceId === 's-ops',
            permissions: { view_tasks: true },
          }),
      ),
    };
    const service = new SavedFiltersService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      permissions as unknown as PermissionsService,
      {} as unknown as EntitlementsService,
    );

    const { data } = await service.getParentOptions(
      'org-1',
      'user-1',
      'OPS',
      ['tasks'],
      [],
      20,
    );

    expect(data).toEqual([
      {
        entity_type: 'tasks',
        id: 't-1',
        key: 'OPS-T1',
        title: 'VPN down',
        space_id: 's-ops',
        space_key: 'OPS',
      },
    ]);
    for (const chain of chains.tasks) {
      expect(chain.in).toHaveBeenCalledWith('space_id', ['s-ops']);
    }
    expect(chains.spaces[1].in).toHaveBeenCalledWith('id', ['s-ops']);
    expect(chains.spaces[1].eq).toHaveBeenCalledWith(
      'organization_id',
      'org-1',
    );
  });
});

describe('SavedFiltersService.collectFilterExportItems', () => {
  /**
   * Mimics the single-entity engine path: each call reads one raw window (PostgREST caps it at
   * 1000 rows), the wiki ACL post-filter drops hidden rows AFTER counting, and the count only
   * subtracts the hidden rows of that window. `hasMore` is derived exactly like the engine does.
   */
  function fakeEngine(rawIds: string[], hidden: Set<string>) {
    return jest.fn((dto: { page: number; pageSize: number }) => {
      const start = (dto.page - 1) * dto.pageSize;
      const window = rawIds.slice(start, start + Math.min(dto.pageSize, 1000));
      const visible = window.filter((id) => !hidden.has(id));
      const count = rawIds.length - (window.length - visible.length);
      return Promise.resolve({
        data: {
          data: visible.map((id) => ({ id, entity_type: 'wiki' })),
          total: count,
          hasMore: start + visible.length < count,
        },
      });
    });
  }

  function build(rawIds: string[], hidden = new Set<string>()) {
    const service = new SavedFiltersService(
      {} as SupabaseAdminService,
      {} as PermissionsService,
      {
        getEffectiveEntitlements: () => Promise.resolve({ has: () => false }),
      } as unknown as EntitlementsService,
    );
    jest
      .spyOn(service as any, 'assertCanViewFilter')
      .mockResolvedValue(undefined);
    const engine = fakeEngine(rawIds, hidden);
    jest.spyOn(service, 'executeAdHoc').mockImplementation(engine as any);
    const collect = () =>
      service.collectFilterExportItems(
        'flt-1',
        { query: { combinator: 'and', rules: [] } } as any,
        'org-1',
        'user-1',
        10_000,
        new AbortController().signal,
      );
    return { collect, engine };
  }

  const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);

  it('exports the visible wiki pages when some matching pages are restricted', async () => {
    // Regression: total is inflated by restricted pages, which used to throw 409 INCOMPLETE.
    const { collect } = build(ids(6), new Set(['p1', 'p4']));

    const { items } = await collect();

    expect(items.map((i) => i.id)).toEqual(['p0', 'p2', 'p3', 'p5']);
  });

  it('reads past the 1000-row PostgREST cap without skipping rows', async () => {
    const { collect } = build(ids(2500));

    const { items } = await collect();

    expect(items).toHaveLength(2500);
    expect(new Set(items.map((i) => i.id)).size).toBe(2500);
  });

  it('keeps reading when a whole raw window is restricted', async () => {
    const raw = ids(2100);
    const hidden = new Set(raw.slice(0, 1000));
    const { collect } = build(raw, hidden);

    const { items } = await collect();

    expect(items).toHaveLength(1100);
    expect(items[0].id).toBe('p1000');
  });
});
