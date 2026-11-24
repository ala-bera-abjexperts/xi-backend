/**
 * @fileoverview Unit tests for DashboardsService — dashboard CRUD with
 * soft-delete + default-flag handling, widget CRUD, layout updates,
 * permission grant/update/revoke (with XOR target validation), and the
 * risk-summary / heatmap analytics aggregations.
 * @module src/dashboards/dashboards.service.spec
 * @author Prince Jadiya
 */

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DashboardsService } from './dashboards.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

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

describe('DashboardsService', () => {
  let service: DashboardsService;
  let mockFrom: jest.Mock;
  let mockPermissionsService: {
    isAdminOrOwner: jest.Mock;
    checkPermission: jest.Mock;
    getUserSpacePermissions: jest.Mock;
  };
  let mockResourcePlanningReportService: { getReport: jest.Mock };
  let mockSavedFiltersService: { getPermittedTaskSpaceIds: jest.Mock };
  let mockEntitlementsService: { getEffectiveEntitlements: jest.Mock };
  let mockSprintsService: { getSprints: jest.Mock };

  const ORG = 'org-1';
  const SPACE = 'space-1';
  const USER = 'user-1';

  const mockDashboard = {
    id: 'dash-1',
    organization_id: ORG,
    space_id: null,
    name: 'Risk Overview',
    description: null,
    status: 'active',
    visibility: 'public',
    is_default: false,
    layout_config: {},
    deleted_at: null,
    deleted_by: null,
    created_by: USER,
    updated_by: USER,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };

  const mockWidget = {
    id: 'wid-1',
    dashboard_id: 'dash-1',
    widget_type: 'kpi',
    title: 'Open Risks',
    config: {},
    data_source: { mode: 'simple' },
    position: { x: 0, y: 0, w: 4, h: 3 },
    sort_order: 0,
    deleted_at: null,
  };

  function buildChain(resolved: {
    data: unknown;
    error: unknown;
    count?: number;
  }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.neq = jest.fn().mockImplementation(self);
    chain.gte = jest.fn().mockImplementation(self);
    chain.is = jest.fn().mockImplementation(self);
    chain.or = jest.fn().mockImplementation(self);
    chain.ilike = jest.fn().mockImplementation(self);
    chain.in = jest.fn().mockImplementation(self);
    chain.not = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.range = jest.fn().mockImplementation(self);
    chain.limit = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.update = jest.fn().mockImplementation(self);
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
    mockPermissionsService = {
      isAdminOrOwner: jest.fn().mockResolvedValue(true),
      checkPermission: jest.fn().mockResolvedValue(true),
      getUserSpacePermissions: jest.fn().mockResolvedValue({
        isMember: true,
        permissions: {
          view_dashboards: true,
          create_dashboards: true,
          edit_dashboards: true,
          delete_dashboards: true,
        },
      }),
    };
    mockResourcePlanningReportService = {
      getReport: jest.fn(),
    };
    mockSavedFiltersService = {
      getPermittedTaskSpaceIds: jest.fn().mockResolvedValue([SPACE]),
    };
    mockEntitlementsService = {
      getEffectiveEntitlements: jest
        .fn()
        .mockResolvedValue(new Set(['feature_external_integrations'])),
    };
    mockSprintsService = { getSprints: jest.fn() };
    service = new DashboardsService(
      supa,
      mockSavedFiltersService as never,
      mockPermissionsService as never,
      mockResourcePlanningReportService as never,
      { report: jest.fn() } as never,
      mockEntitlementsService as never,
      mockSprintsService as never,
    );
  });

  // ── Dashboard CRUD ─────────────────────────────────────────────────────

  describe('getAll', () => {
    it('returns paginated dashboards', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: [mockDashboard], error: null, count: 1 }),
      );

      const r = await service.getAll(ORG, {});

      expect(r.data).toHaveLength(1);
      expect(r.total).toBe(1);
      expect(r.page).toBe(1);
      expect(r.pageSize).toBe(500);
    });

    it('combines org-level + space-level when includeOrgLevel=true', async () => {
      const chain = buildChain({ data: [], error: null, count: 0 });
      mockFrom.mockReturnValue(chain);

      await service.getAll(ORG, { spaceId: SPACE, includeOrgLevel: true });

      expect(chain.or).toHaveBeenCalledWith(
        `space_id.eq.${SPACE},space_id.is.null`,
      );
    });

    it('filters by status / visibility / is_default', async () => {
      const chain = buildChain({ data: [], error: null, count: 0 });
      mockFrom.mockReturnValue(chain);

      await service.getAll(ORG, {
        status: 'archived',
        visibility: 'private',
        is_default: true,
      });

      const eqArgs = (
        (chain.eq as jest.Mock).mock.calls as [string, unknown][]
      ).map((c) => c[0]);
      expect(eqArgs).toEqual(
        expect.arrayContaining([
          'organization_id',
          'status',
          'visibility',
          'is_default',
        ]),
      );
    });

    it('throws when underlying query errors', async () => {
      mockFrom.mockReturnValue(
        buildChain({
          data: null,
          error: { message: 'db down' },
          count: 0,
        }),
      );
      await expect(service.getAll(ORG, {})).rejects.toThrow(
        BadRequestException,
      );
    });

    it('filters access before paginating authenticated dashboard lists', async () => {
      const firstDashboard = { ...mockDashboard, id: 'dash-1', name: 'A' };
      const secondDashboard = { ...mockDashboard, id: 'dash-2', name: 'B' };
      const chain = buildChain({
        data: [firstDashboard, secondDashboard],
        error: null,
        count: 2,
      });
      mockFrom
        .mockReturnValueOnce(chain) // dashboard list
        .mockReturnValueOnce(
          buildChain({ data: { role: 'member' }, error: null }),
        ) // org membership
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // direct roles
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // groups
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // first explicit permission
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // second explicit permission
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // visible page row can_view
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // visible page row can_edit
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // visible page row can_manage
        .mockReturnValueOnce(buildChain({ data: [], error: null })); // visible page row can_delete
      mockPermissionsService.isAdminOrOwner.mockResolvedValue(false);
      mockPermissionsService.checkPermission.mockResolvedValue(true);

      const r = await service.getAll(
        ORG,
        { page: 2, pageSize: 1 },
        'other-user',
      );

      expect(chain.range).not.toHaveBeenCalled();
      expect(r.data).toEqual([
        {
          ...secondDashboard,
          user_permissions: {
            can_view: true,
            can_edit: true,
            can_manage: true,
            can_delete: true,
          },
        },
      ]);
      expect(r.total).toBe(2);
      expect(r.count).toBe(2);
    });
  });

  describe('getById', () => {
    it('returns the dashboard when found', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockDashboard, error: null }),
      );
      const r = await service.getById('dash-1', ORG);
      expect(r).toEqual(mockDashboard);
    });

    it('throws NotFound when missing', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(service.getById('missing', ORG)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('create', () => {
    it('inserts a new dashboard and logs activity', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null })) // insert
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // logActivity
      const r = (await service.create(ORG, USER, {
        name: 'Risk Overview',
      } as never)) as Record<string, unknown>;
      expect(r['id']).toBe('dash-1');
    });
  });

  describe('update', () => {
    it('verifies the dashboard exists then updates fields', async () => {
      const updated = { ...mockDashboard, name: 'Updated' };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: updated, error: null })) // update
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // logActivity
      const r = (await service.update('dash-1', ORG, USER, {
        name: 'Updated',
      } as never)) as Record<string, unknown>;
      expect(r['name']).toBe('Updated');
    });
  });

  describe('setAsDefault', () => {
    it('unsets siblings then marks the chosen dashboard as default', async () => {
      const updated = { ...mockDashboard, is_default: true };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // unset siblings
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null })) // getById in update()
        .mockReturnValueOnce(buildChain({ data: updated, error: null })) // update
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // logActivity
      const r = (await service.setAsDefault('dash-1', ORG, USER)) as Record<
        string,
        unknown
      >;
      expect(r['is_default']).toBe(true);
    });

    it('scopes the unset to the same space when dashboard has space_id', async () => {
      const spaceDash = { ...mockDashboard, space_id: SPACE };
      const updated = { ...spaceDash, is_default: true };
      const unsetChain = buildChain({ data: null, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: spaceDash, error: null })) // getById
        .mockReturnValueOnce(unsetChain) // unset siblings
        .mockReturnValueOnce(buildChain({ data: spaceDash, error: null })) // getById in update()
        .mockReturnValueOnce(buildChain({ data: updated, error: null })) // update
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // logActivity

      await service.setAsDefault('dash-1', ORG, USER);

      const eqArgs = (
        (unsetChain.eq as jest.Mock).mock.calls as [string, unknown][]
      ).map((c) => c[0]);
      expect(eqArgs).toContain('space_id');
    });
  });

  describe('archive', () => {
    it('archives an active dashboard', async () => {
      const archived = { ...mockDashboard, status: 'archived' };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null })) // getById in update()
        .mockReturnValueOnce(buildChain({ data: archived, error: null })) // update
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // logActivity

      const r = (await service.archive('dash-1', ORG, USER)) as Record<
        string,
        unknown
      >;
      expect(r['status']).toBe('archived');
    });

    it('rejects when already archived', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: { ...mockDashboard, status: 'archived' },
          error: null,
        }),
      );

      await expect(service.archive('dash-1', ORG, USER)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('delete', () => {
    it('soft-deletes the dashboard', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // soft delete update
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // logActivity

      await expect(
        service.delete('dash-1', ORG, USER),
      ).resolves.toBeUndefined();
    });

    it('refuses to delete the default dashboard', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: { ...mockDashboard, is_default: true },
          error: null,
        }),
      );

      await expect(service.delete('dash-1', ORG, USER)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── Widgets ────────────────────────────────────────────────────────────

  describe('getWidgets', () => {
    it('returns ordered widgets for the dashboard', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: [mockWidget], error: null })); // widgets
      const r = await service.getWidgets('dash-1', ORG);
      expect(r).toHaveLength(1);
    });
  });

  describe('getWidgetById', () => {
    it('returns the widget when found', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null }))
        .mockReturnValueOnce(buildChain({ data: mockWidget, error: null }));
      const r = await service.getWidgetById('dash-1', 'wid-1', ORG);
      expect(r).toEqual(mockWidget);
    });

    it('throws NotFound when missing', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.getWidgetById('dash-1', 'missing', ORG),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('createWidget', () => {
    it('inserts a new widget', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: mockWidget, error: null })) // insert
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // logActivity

      const r = (await service.createWidget('dash-1', ORG, USER, {
        widget_type: 'kpi',
        title: 'Open Risks',
      } as never)) as Record<string, unknown>;
      expect(r['id']).toBe('wid-1');
    });
  });

  describe('updateWidget', () => {
    it('updates an existing widget', async () => {
      const updated = { ...mockWidget, title: 'New title' };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null })) // getById in getWidgetById
        .mockReturnValueOnce(buildChain({ data: mockWidget, error: null })) // widget fetch
        .mockReturnValueOnce(buildChain({ data: updated, error: null })) // update
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // logActivity
      const r = (await service.updateWidget('dash-1', 'wid-1', ORG, USER, {
        title: 'New title',
      } as never)) as Record<string, unknown>;
      expect(r['title']).toBe('New title');
    });
  });

  describe('deleteWidget', () => {
    it('soft-deletes the widget', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null })) // getById in getWidgetById
        .mockReturnValueOnce(buildChain({ data: mockWidget, error: null })) // widget fetch
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // soft delete
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // logActivity
      await expect(
        service.deleteWidget('dash-1', 'wid-1', ORG, USER),
      ).resolves.toBeUndefined();
    });
  });

  describe('getLayout / updateLayout', () => {
    it('returns positional info from widgets', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: [mockWidget], error: null })); // widgets
      const r = (await service.getLayout('dash-1', ORG)) as Array<
        Record<string, unknown>
      >;
      expect(r[0]).toMatchObject({ id: 'wid-1', x: 0, y: 0, w: 4, h: 3 });
    });

    it('updates layout in parallel for all items', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({
            data: [{ id: 'wid-1' }, { id: 'wid-2' }],
            error: null,
          }),
        ) // existing widgets preflight
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // first update
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // second update
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // logActivity

      await expect(
        service.updateLayout('dash-1', ORG, USER, {
          items: [
            { id: 'wid-1', x: 0, y: 0, w: 6, h: 4 },
            { id: 'wid-2', x: 6, y: 0, w: 6, h: 4 },
          ] as never,
        } as never),
      ).resolves.toBeUndefined();
    });

    it('accepts frontend positions payloads when updating layout', async () => {
      const updateChain = buildChain({ data: null, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({ data: [{ id: 'wid-1' }], error: null }),
        ) // existing widgets preflight
        .mockReturnValueOnce(updateChain)
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // logActivity

      await expect(
        service.updateLayout('dash-1', ORG, USER, {
          positions: [{ id: 'wid-1', x: 0, y: 0, w: 6, h: 4 }],
        } as never),
      ).resolves.toBeUndefined();

      expect(updateChain.update).toHaveBeenCalledWith(
        expect.objectContaining({
          position: { x: 0, y: 0, w: 6, h: 4 },
          updated_by: USER,
        }),
      );
      expect(updateChain.eq).toHaveBeenCalledWith('id', 'wid-1');
    });

    it('rejects layout updates containing widgets outside the dashboard', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: [], error: null })); // existing widgets preflight

      await expect(
        service.updateLayout('dash-1', ORG, USER, {
          items: [{ id: 'wid-elsewhere', x: 0, y: 0, w: 6, h: 4 }],
        } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects layout updates without items or positions arrays', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockDashboard, error: null }),
      );

      await expect(
        service.updateLayout('dash-1', ORG, USER, {} as never),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getWidgetData', () => {
    it('delegates resource planning widgets to the shared report service', async () => {
      const resourceWidget = {
        ...mockWidget,
        widget_type: 'resource_planning',
        config: {
          dateFrom: '2026-08-01',
          dateTo: '2026-08-31',
          bucket: 'month',
          groupBy: 'unit',
          groupId: '11111111-1111-4111-8111-111111111111',
          includeArchived: true,
        },
      };
      const report = { rows: [], totals_by_currency: [], exceptions: {} };

      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null }))
        .mockReturnValueOnce(buildChain({ data: resourceWidget, error: null }))
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null }));
      mockResourcePlanningReportService.getReport.mockResolvedValue(report);

      await expect(
        service.getWidgetData('dash-1', 'wid-1', ORG, USER),
      ).resolves.toEqual({
        data: report,
        widget_type: 'resource_planning',
      });
      expect(mockPermissionsService.checkPermission).toHaveBeenCalledWith(
        USER,
        ORG,
        'can_view_resource_planning',
      );
      expect(mockResourcePlanningReportService.getReport).toHaveBeenCalledWith(
        ORG,
        {
          from: '2026-08-01',
          to: '2026-08-31',
          bucket: 'month',
          group_by: 'unit',
          group_id: '11111111-1111-4111-8111-111111111111',
          include_archived: true,
        },
        USER,
      );
    });

    it('returns an empty report instead of throwing when the widget targets a portfolio that no longer exists', async () => {
      const resourceWidget = {
        ...mockWidget,
        widget_type: 'resource_planning',
        config: {
          dateFrom: '2026-08-01',
          dateTo: '2026-08-31',
          bucket: 'month',
          groupBy: 'portfolio',
          groupId: '11111111-1111-4111-8111-111111111111',
        },
      };

      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null }))
        .mockReturnValueOnce(buildChain({ data: resourceWidget, error: null }))
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null }));
      mockResourcePlanningReportService.getReport.mockRejectedValue(
        new NotFoundException('Portfolio not found'),
      );

      await expect(
        service.getWidgetData('dash-1', 'wid-1', ORG, USER),
      ).resolves.toEqual({
        data: {
          range: {
            from: '2026-08-01',
            to: '2026-08-31',
            bucket: 'month',
            group_by: 'portfolio',
          },
          rows: [],
          totals_by_currency: [],
          exceptions: {
            ambiguous_time_entry_count: 0,
            unallocated_time_entry_count: 0,
            ambiguous_actual_hours: 0,
            unallocated_actual_hours: 0,
            missing_rate_hours: 0,
            undated_allocation_count: 0,
          },
        },
        widget_type: 'resource_planning',
      });
    });

    it('rejects resource planning widget data without its view permission', async () => {
      const resourceWidget = {
        ...mockWidget,
        widget_type: 'resource_planning',
        config: {},
      };

      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null }))
        .mockReturnValueOnce(buildChain({ data: resourceWidget, error: null }))
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null }));
      mockPermissionsService.checkPermission.mockResolvedValue(false);

      await expect(
        service.getWidgetData('dash-1', 'wid-1', ORG, USER),
      ).rejects.toThrow(ForbiddenException);
      expect(
        mockResourcePlanningReportService.getReport,
      ).not.toHaveBeenCalled();
    });

    it('rejects invalid persisted resource planning widget filters', async () => {
      const resourceWidget = {
        ...mockWidget,
        widget_type: 'resource_planning',
        config: { groupBy: 'organization', includeArchived: 'yes' },
      };

      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null }))
        .mockReturnValueOnce(buildChain({ data: resourceWidget, error: null }))
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null }));

      await expect(
        service.getWidgetData('dash-1', 'wid-1', ORG, USER),
      ).rejects.toThrow(BadRequestException);
      expect(
        mockResourcePlanningReportService.getReport,
      ).not.toHaveBeenCalled();
    });

    it('returns task widget rows without applying a missing deleted_at filter', async () => {
      const taskWidget = {
        ...mockWidget,
        widget_type: 'table',
        data_source_type: 'task',
        config: {},
      };
      const tasks = [{ id: 'task-1', summary: 'Review risk' }];
      const taskQuery = buildChain({ data: tasks, error: null, count: 1 });

      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null })) // getWidgetById -> getById
        .mockReturnValueOnce(buildChain({ data: taskWidget, error: null })) // getWidgetById
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null })) // resolve dashboard space
        .mockReturnValueOnce(taskQuery); // task data

      const result = await service.getWidgetData('dash-1', 'wid-1', ORG, USER);

      expect(result).toEqual({ data: tasks, widget_type: 'table' });
      expect(taskQuery.is).not.toHaveBeenCalledWith('deleted_at', null);
    });

    it('still applies an optional space filter to task widget rows', async () => {
      const taskWidget = {
        ...mockWidget,
        widget_type: 'table',
        data_source_type: 'task',
        config: {},
      };
      const taskQuery = buildChain({ data: [], error: null, count: 0 });

      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null })) // getWidgetById -> getById
        .mockReturnValueOnce(buildChain({ data: taskWidget, error: null })) // getWidgetById
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null })) // resolve dashboard space
        .mockReturnValueOnce(taskQuery); // task data

      await service.getWidgetData('dash-1', 'wid-1', ORG, USER, SPACE);

      expect(taskQuery.eq).toHaveBeenCalledWith('space_id', SPACE);
      expect(taskQuery.is).not.toHaveBeenCalledWith('deleted_at', null);
    });

    it('rejects widget data queries scoped outside the dashboard space', async () => {
      const taskWidget = {
        ...mockWidget,
        widget_type: 'table',
        data_source_type: 'task',
        config: {},
      };
      const spacedDashboard = { ...mockDashboard, space_id: SPACE };

      mockFrom
        .mockReturnValueOnce(buildChain({ data: spacedDashboard, error: null }))
        .mockReturnValueOnce(buildChain({ data: taskWidget, error: null }))
        .mockReturnValueOnce(
          buildChain({ data: spacedDashboard, error: null }),
        );

      await expect(
        service.getWidgetData('dash-1', 'wid-1', ORG, USER, 'other-space'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('propagates task widget query errors as BadRequestException', async () => {
      const taskWidget = {
        ...mockWidget,
        widget_type: 'table',
        data_source_type: 'task',
        config: {},
      };

      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null })) // getWidgetById -> getById
        .mockReturnValueOnce(buildChain({ data: taskWidget, error: null })) // getWidgetById
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null })) // resolve dashboard space
        .mockReturnValueOnce(
          buildChain({ data: null, error: { message: 'db failed' } }),
        ); // task data

      await expect(
        service.getWidgetData('dash-1', 'wid-1', ORG, USER),
      ).rejects.toThrow(BadRequestException);
    });

    it('aggregates task widget rows when chart mode is configured', async () => {
      const taskWidget = {
        ...mockWidget,
        widget_type: 'chart',
        data_source_type: 'task',
        config: { xAxis: 'status' },
      };
      const tasks = [
        { id: 'task-1', status: 'open' },
        { id: 'task-2', status: 'open' },
        { id: 'task-3', status: 'done' },
      ];

      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null })) // getWidgetById -> getById
        .mockReturnValueOnce(buildChain({ data: taskWidget, error: null })) // getWidgetById
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null })) // resolve dashboard space
        .mockReturnValueOnce(
          buildChain({ data: tasks, error: null, count: 3 }),
        ); // task data

      const result = await service.getWidgetData('dash-1', 'wid-1', ORG, USER);

      expect(result).toEqual({
        data: [
          { name: 'open', value: 2 },
          { name: 'done', value: 1 },
        ],
        widget_type: 'chart',
      });
    });
  });

  describe('getWidgetData (velocity_chart)', () => {
    const CONFIG = { boardId: 'board-1', storyPointsField: 'story_points' };
    const sprint = (id: string, status: string, completed_at: string | null) => ({
      id,
      name: `Sprint ${id}`,
      status,
      completed_at,
      start_date: completed_at ?? '2026-02-01T00:00:00Z',
      created_at: '2026-01-01T00:00:00Z',
    });
    const SPRINTS = [
      sprint('s1', 'completed', '2026-01-10T00:00:00Z'),
      sprint('s2', 'completed', '2026-01-20T00:00:00Z'),
      sprint('s3', 'active', null),
      sprint('s4', 'planning', null),
    ];

    function mockVelocityWidget(config: Record<string, unknown> = CONFIG) {
      const widget = { ...mockWidget, widget_type: 'velocity_chart', config };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null }))
        .mockReturnValueOnce(buildChain({ data: widget, error: null }))
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null }));
    }

    const load = (sprintId?: string) =>
      service.getWidgetData(
        'dash-1',
        'wid-1',
        ORG,
        USER,
        undefined,
        0,
        sprintId,
      ) as Promise<{ data: Record<string, unknown> }>;

    function mockVelocityRows(
      rows: { sprint_id: string; task: unknown }[],
      field: unknown = { name: 'Story Points' },
    ) {
      const rankingQuery = buildChain({ data: rows, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: field, error: null }))
        .mockReturnValueOnce(
          buildChain({ data: [{ id: 'done-col' }], error: null }),
        )
        .mockReturnValueOnce(rankingQuery);
      return rankingQuery;
    }

    it('asks for configuration before touching the board', async () => {
      mockVelocityWidget({ boardId: 'board-1' });

      await expect(load()).resolves.toMatchObject({
        data: { status: 'not_configured' },
      });
      expect(mockSprintsService.getSprints).not.toHaveBeenCalled();
    });

    it('checks board access as the viewer, in the viewer organization', async () => {
      mockVelocityWidget();
      mockSprintsService.getSprints.mockRejectedValue(
        new ForbiddenException(),
      );

      await expect(load()).resolves.toMatchObject({
        data: { status: 'no_access' },
      });
      expect(mockSprintsService.getSprints).toHaveBeenCalledWith(
        'board-1',
        ORG,
        USER,
        true,
      );
    });

    it('reports a deleted board and rethrows anything else', async () => {
      mockVelocityWidget();
      mockSprintsService.getSprints.mockRejectedValueOnce(
        new NotFoundException(),
      );
      await expect(load()).resolves.toMatchObject({
        data: { status: 'board_unavailable' },
      });

      mockVelocityWidget();
      mockSprintsService.getSprints.mockRejectedValueOnce(new Error('boom'));
      await expect(load()).rejects.toThrow('boom');
    });

    it('reports a deleted story points field', async () => {
      mockVelocityWidget();
      mockSprintsService.getSprints.mockResolvedValue({ data: SPRINTS });
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));

      await expect(load()).resolves.toMatchObject({
        data: { status: 'field_unavailable' },
      });
    });

    it('reports a board with only planning sprints', async () => {
      mockVelocityWidget();
      mockSprintsService.getSprints.mockResolvedValue({
        data: [sprint('s4', 'planning', null)],
      });
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { name: 'Story Points' }, error: null }),
      );

      await expect(load()).resolves.toMatchObject({
        data: { status: 'no_sprints' },
      });
    });

    it('defaults to the latest completed sprint and sums its estimates', async () => {
      mockVelocityWidget();
      mockSprintsService.getSprints.mockResolvedValue({ data: SPRINTS });
      const rankingQuery = mockVelocityRows([
        { sprint_id: 's1', task: { custom_field_values: { story_points: 10 } } },
        { sprint_id: 's2', task: { custom_field_values: { story_points: 3 } } },
        { sprint_id: 's2', task: { custom_field_values: { story_points: '5' } } },
        { sprint_id: 's2', task: { custom_field_values: {} } },
      ]);

      const { data } = await load();

      expect(data).toMatchObject({
        status: 'ok',
        fieldName: 'Story Points',
        selectedSprintId: 's2',
        previousAverage: 10,
        bars: [
          { id: 's1', points: 10, completedTasks: 1, unestimatedTasks: 0 },
          { id: 's2', points: 8, completedTasks: 3, unestimatedTasks: 1 },
        ],
      });
      // Newest first, planning left out, later sprints still selectable.
      expect((data.sprints as { id: string }[]).map((s) => s.id)).toEqual([
        's3',
        's2',
        's1',
      ]);
      expect(rankingQuery.eq).toHaveBeenCalledWith('board_id', 'board-1');
      expect(rankingQuery.in).toHaveBeenCalledWith('column_id', ['done-col']);
    });

    it('uses the requested sprint, and ignores one from another board', async () => {
      mockVelocityWidget();
      mockSprintsService.getSprints.mockResolvedValue({ data: SPRINTS });
      mockVelocityRows([]);
      await expect(load('s3')).resolves.toMatchObject({
        data: { selectedSprintId: 's3' },
      });

      mockVelocityWidget();
      mockVelocityRows([]);
      await expect(load('other-board-sprint')).resolves.toMatchObject({
        data: { selectedSprintId: 's2' },
      });
    });
  });

  describe('getWidgetData (git_development)', () => {
    function mockGitWidget(
      config: Record<string, unknown>,
      dashboard: Record<string, unknown> = mockDashboard,
    ) {
      const widget = { ...mockWidget, widget_type: 'git_development', config };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: dashboard, error: null })) // getWidgetById -> getById
        .mockReturnValueOnce(buildChain({ data: widget, error: null })) // getWidgetById
        .mockReturnValueOnce(buildChain({ data: dashboard, error: null })); // resolve dashboard space
    }

    it('lists in-progress tasks without a pull request (default metric) in permitted spaces', async () => {
      mockGitWidget({});
      // The seeded `in_progress` status sits in To Do (auto-category trigger); `doing` is categorised.
      const statusQuery = buildChain({
        data: [
          { id: 'st-seeded', key: 'in_progress', category: { key: 'todo' } },
          { id: 'st-doing', key: 'doing', category: { key: 'in_progress' } },
          { id: 'st-open', key: 'open', category: { key: 'todo' } },
        ],
        error: null,
      });
      const taskQuery = buildChain({
        data: [
          {
            id: 't1',
            key: 'ABC-1',
            summary: 'Do it',
            space: { id: SPACE, key: 'ABC', name: 'Alpha' },
            status_config: { name: 'Doing', color: '#00f' },
          },
          {
            id: 't2',
            key: 'ABC-2',
            summary: 'Legacy',
            space: { id: SPACE, key: 'ABC', name: 'Alpha' },
            status_config: null,
          },
        ],
        error: null,
        count: 7,
      });
      mockFrom.mockReturnValueOnce(statusQuery).mockReturnValueOnce(taskQuery);

      await expect(
        service.getWidgetData('dash-1', 'wid-1', ORG, USER),
      ).resolves.toEqual({
        data: {
          metric: 'in_progress_without_pr',
          total: 7,
          tasks: [
            {
              id: 't1',
              key: 'ABC-1',
              summary: 'Do it',
              space: { id: SPACE, key: 'ABC', name: 'Alpha' },
              status: { name: 'Doing', color: '#00f' },
            },
            {
              id: 't2',
              key: 'ABC-2',
              summary: 'Legacy',
              space: { id: SPACE, key: 'ABC', name: 'Alpha' },
              status: { name: 'In Progress', color: null },
            },
          ],
        },
        widget_type: 'git_development',
      });
      expect(
        mockSavedFiltersService.getPermittedTaskSpaceIds,
      ).toHaveBeenCalledWith(USER, ORG);
      expect(statusQuery.eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(taskQuery.eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(taskQuery.in).toHaveBeenCalledWith('space_id', [SPACE]);
      expect(taskQuery.or).toHaveBeenCalledWith(
        'status_id.in.(st-seeded,st-doing),and(status_id.is.null,status.eq.in_progress)',
      );
      expect(taskQuery.eq).toHaveBeenCalledWith('git_pr_count', 0);
      expect(taskQuery.limit).toHaveBeenCalledWith(50);
    });

    it('groups failing builds by space, largest first', async () => {
      mockGitWidget({ metric: 'failing_builds_by_space' });
      const a = { id: 's-a', key: 'A', name: 'Alpha' };
      const b = { id: 's-b', key: 'B', name: 'Beta' };
      mockSavedFiltersService.getPermittedTaskSpaceIds.mockResolvedValue([
        a.id,
        b.id,
      ]);
      const taskQuery = buildChain({
        data: [{ space: a }, { space: b }, { space: b }],
        error: null,
      });
      mockFrom.mockReturnValueOnce(taskQuery);

      const result = (await service.getWidgetData(
        'dash-1',
        'wid-1',
        ORG,
        USER,
      )) as { data: unknown };

      expect(result.data).toEqual({
        metric: 'failing_builds_by_space',
        total: 3,
        groups: [
          { key: 's-b', label: 'Beta', spaceKey: 'B', count: 2 },
          { key: 's-a', label: 'Alpha', spaceKey: 'A', count: 1 },
        ],
      });
      expect(taskQuery.eq).toHaveBeenCalledWith('git_build_state', 'failed');
      expect(taskQuery.in).toHaveBeenCalledWith('space_id', [a.id, b.id]);
    });

    it('lists pull requests merged in the last 7 days, newest first, counting distinct PRs', async () => {
      mockGitWidget({ metric: 'merged_this_week' });
      const pr = (id: string, mergedAt: string) => ({
        id,
        number: Number(id.slice(-1)),
        title: `PR ${id}`,
        url: `https://git.example/${id}`,
        merged_at: mergedAt,
        repository: { full_name: 'acme/app' },
      });
      const linkQuery = buildChain({
        data: [
          {
            pull_request: pr('pr-1', '2026-10-20T10:00:00+00:00'),
            task: { id: 't1', key: 'ABC-1', summary: 'One' },
          },
          {
            pull_request: pr('pr-2', '2026-10-21T10:00:00+00:00'),
            task: { id: 't2', key: 'ABC-2', summary: 'Two' },
          },
          {
            pull_request: pr('pr-1', '2026-10-20T10:00:00+00:00'),
            task: { id: 't3', key: 'ABC-3', summary: 'Three' },
          },
        ],
        error: null,
      });
      mockFrom.mockReturnValueOnce(linkQuery);

      const result = (await service.getWidgetData(
        'dash-1',
        'wid-1',
        ORG,
        USER,
      )) as {
        data: {
          total: number;
          since: string;
          items: Array<{ task: { key: string }; pullRequest: unknown }>;
        };
      };

      expect(result.data.total).toBe(2);
      expect(result.data.items.map((i) => i.task.key)).toEqual([
        'ABC-2',
        'ABC-1',
        'ABC-3',
      ]);
      expect(result.data.items[0].pullRequest).toEqual({
        number: 2,
        title: 'PR pr-2',
        url: 'https://git.example/pr-2',
        mergedAt: '2026-10-21T10:00:00+00:00',
        repository: 'acme/app',
      });
      const sinceMs = Date.parse(result.data.since);
      expect(Date.now() - sinceMs).toBeGreaterThanOrEqual(
        7 * 24 * 60 * 60 * 1000,
      );
      expect(linkQuery.eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(linkQuery.eq).toHaveBeenCalledWith('state', 'linked');
      expect(linkQuery.in).toHaveBeenCalledWith('task.space_id', [SPACE]);
    });

    it('narrows a space dashboard to that space only when the viewer may see it', async () => {
      mockGitWidget(
        { metric: 'in_progress_without_pr' },
        { ...mockDashboard, space_id: 'space-2' },
      );
      mockSavedFiltersService.getPermittedTaskSpaceIds.mockResolvedValue([
        SPACE,
      ]);

      const result = (await service.getWidgetData(
        'dash-1',
        'wid-1',
        ORG,
        USER,
      )) as { data: unknown };

      expect(result.data).toEqual({
        metric: 'in_progress_without_pr',
        total: 0,
        tasks: [],
      });
      expect(mockFrom).toHaveBeenCalledTimes(3); // no task query
    });

    it('returns an empty result, not org-wide data, when no space is permitted', async () => {
      mockGitWidget({ metric: 'failing_builds_by_space' });
      mockSavedFiltersService.getPermittedTaskSpaceIds.mockResolvedValue([]);

      const result = (await service.getWidgetData(
        'dash-1',
        'wid-1',
        ORG,
        USER,
      )) as { data: unknown };

      expect(result.data).toEqual({
        metric: 'failing_builds_by_space',
        total: 0,
        groups: [],
      });
      expect(mockFrom).toHaveBeenCalledTimes(3);
    });

    it('rejects an unknown metric with 400', async () => {
      mockGitWidget({ metric: 'bogus' });

      await expect(
        service.getWidgetData('dash-1', 'wid-1', ORG, USER),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects with 403 when the organization lacks external integrations', async () => {
      mockGitWidget({});
      mockEntitlementsService.getEffectiveEntitlements.mockResolvedValue(
        new Set(),
      );

      await expect(
        service.getWidgetData('dash-1', 'wid-1', ORG, USER),
      ).rejects.toThrow(ForbiddenException);
      expect(
        mockSavedFiltersService.getPermittedTaskSpaceIds,
      ).not.toHaveBeenCalled();
    });
  });

  // ── Permissions ────────────────────────────────────────────────────────

  describe('getPermissions', () => {
    it('returns active permissions', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null }))
        .mockReturnValueOnce(
          buildChain({
            data: [
              {
                id: 'perm-1',
                target_type: 'user',
                target_id: 'u-1',
                permission_level: 'view',
                is_active: true,
              },
            ],
            error: null,
          }),
        );
      const r = await service.getPermissions('dash-1', ORG);
      expect(r).toHaveLength(1);
    });
  });

  describe('grantPermission', () => {
    it('rejects base_role payloads that include target_id', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockDashboard, error: null }),
      );
      await expect(
        service.grantPermission('dash-1', ORG, USER, {
          target_type: 'base_role',
          base_role: 'admin',
          target_id: 'should-not-be-here',
          permission_level: 'view',
        } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects user/group/role payloads that include base_role', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockDashboard, error: null }),
      );
      await expect(
        service.grantPermission('dash-1', ORG, USER, {
          target_type: 'user',
          base_role: 'should-not-be-here',
          target_id: 'u-1',
          permission_level: 'view',
        } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('inserts a new permission for a user target', async () => {
      const created = {
        id: 'perm-1',
        target_type: 'user',
        target_id: 'u-1',
        permission_level: 'view',
      };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // existing permission lookup
        .mockReturnValueOnce(buildChain({ data: created, error: null })) // insert
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // logActivity
      const r = (await service.grantPermission('dash-1', ORG, USER, {
        target_type: 'user',
        target_id: 'u-1',
        permission_level: 'view',
      } as never)) as Record<string, unknown>;
      expect(r['id']).toBe('perm-1');
    });
  });

  describe('updatePermission', () => {
    it('updates the permission_level', async () => {
      const updated = {
        id: 'perm-1',
        permission_level: 'edit',
      };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: updated, error: null })) // update
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // logActivity
      const r = (await service.updatePermission('dash-1', 'perm-1', ORG, USER, {
        permission_level: 'edit',
      } as never)) as Record<string, unknown>;
      expect(r['permission_level']).toBe('edit');
    });

    it('throws NotFound when permission does not exist', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // update returns no row
      await expect(
        service.updatePermission('dash-1', 'missing', ORG, USER, {
          permission_level: 'edit',
        } as never),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('revokePermission', () => {
    it('marks the permission inactive', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({ data: { id: 'perm-1' }, error: null }),
        ) // update is_active=false
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // logActivity
      await expect(
        service.revokePermission('dash-1', 'perm-1', ORG, USER),
      ).resolves.toBeUndefined();
    });

    it('throws NotFound when revoke does not match a permission', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockDashboard, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // update matched no rows

      await expect(
        service.revokePermission('dash-1', 'missing', ORG, USER),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── Analytics ──────────────────────────────────────────────────────────

  describe('getRiskSummary', () => {
    it('aggregates high/medium/low risk counts and average score', async () => {
      const processes = [
        { id: 'p-1', status: 'open', level_c_i: 5, level_i_i: 5, level_a_i: 5 }, // 15 → high
        { id: 'p-2', status: 'open', level_c_i: 3, level_i_i: 3, level_a_i: 3 }, // 9 → medium
        { id: 'p-3', status: 'open', level_c_i: 1, level_i_i: 1, level_a_i: 1 }, // 3 → low
        {
          id: 'p-4',
          status: 'closed',
          level_c_i: 5,
          level_i_i: 5,
          level_a_i: 5,
        }, // closed
      ];
      mockFrom
        .mockReturnValueOnce(buildChain({ data: processes, error: null })) // risiko query
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 7 })); // action count

      const r = (await service.getRiskSummary(ORG)) as Record<string, unknown>;

      expect(r['total_processes']).toBe(4);
      expect(r['open_processes']).toBe(3);
      expect(r['high_risk']).toBe(2);
      expect(r['medium_risk']).toBe(1);
      expect(r['low_risk']).toBe(1);
      expect(r['total_actions']).toBe(7);
    });

    it('handles empty datasets gracefully', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: [], error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 0 }));

      const r = (await service.getRiskSummary(ORG)) as Record<string, unknown>;
      expect(r['avg_risk_score']).toBe(0);
    });
  });

  describe('getHeatmapData', () => {
    it('groups processes into a probability×impact matrix', async () => {
      const processes = [
        {
          id: 'p-1',
          vuln_c_p: 5,
          vuln_i_p: 5,
          vuln_a_p: 5,
          vuln_c_i: 5,
          vuln_i_i: 5,
          vuln_a_i: 5,
          status: 'open',
        },
        {
          id: 'p-2',
          vuln_c_p: 1,
          vuln_i_p: 1,
          vuln_a_p: 1,
          vuln_c_i: 1,
          vuln_i_i: 1,
          vuln_a_i: 1,
          status: 'open',
        },
      ];
      mockFrom.mockReturnValueOnce(
        buildChain({ data: processes, error: null }),
      );

      const r = (await service.getHeatmapData(ORG)) as {
        cells: Array<{
          probability: number;
          impact: number;
          count: number;
          process_ids: string[];
        }>;
      };

      const cell55 = r.cells.find((c) => c.probability === 5 && c.impact === 5);
      const cell11 = r.cells.find((c) => c.probability === 1 && c.impact === 1);
      expect(cell55?.count).toBe(1);
      expect(cell11?.count).toBe(1);
    });
  });
});
