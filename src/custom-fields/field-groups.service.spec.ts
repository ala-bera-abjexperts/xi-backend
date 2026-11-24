/**
 * @fileoverview Unit tests for FieldGroupsService — CRUD, membership,
 * cascade soft-delete, duplicate, reorder, level assignments, and
 * permission bulk-set.
 * @module src/custom-fields/field-groups.service.spec
 * @author Prince Jadiya
 */

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { FieldGroupsService } from './field-groups.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('FieldGroupsService', () => {
  let service: FieldGroupsService;
  let mockFrom: jest.Mock;

  const mockGroup = {
    id: 'fg-1',
    organization_id: 'org-1',
    space_id: null,
    name: 'General',
    description: null,
    name_i18n: {},
    description_i18n: {},
    sort_order: 0,
    is_collapsed_default: false,
    color: null,
    icon: null,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    is_deleted: false,
    deleted_at: null,
    deleted_by: null,
  };

  const mockMembership = {
    id: 'fgf-1',
    field_group_id: 'fg-1',
    custom_field_id: 'cf-1',
    sort_order: 0,
    is_required: false,
    is_hidden: false,
    column_span: 12,
    default_value_override: null,
    created_at: '2025-01-01T00:00:00Z',
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
    chain.in = jest.fn().mockImplementation(self);
    chain.or = jest.fn().mockImplementation(self);
    chain.ilike = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.update = jest.fn().mockImplementation(self);
    chain.delete = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.limit = jest.fn().mockImplementation(self);
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
    service = new FieldGroupsService(supa);
  });

  // -----------------------------------------------------------------
  // Phase 3: CRUD
  // -----------------------------------------------------------------

  describe('getAll', () => {
    it('returns groups for the org', async () => {
      mockFrom.mockReturnValue(buildChain({ data: [mockGroup], error: null }));
      const r = await service.getAll('org-1');
      expect(r.data).toHaveLength(1);
      expect(r.count).toBe(1);
    });
    it('respects is_deleted filter', async () => {
      mockFrom.mockReturnValue(buildChain({ data: [], error: null }));
      const r = await service.getAll('org-1', { is_deleted: true });
      expect(r.data).toHaveLength(0);
      expect(r.count).toBe(0);
    });
    it('throws BadRequest on db error', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: null, error: { message: 'boom' } }),
      );
      await expect(service.getAll('org-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('getBySpace', () => {
    it('returns combined org + space groups', async () => {
      mockFrom.mockReturnValue(buildChain({ data: [mockGroup], error: null }));
      const r = await service.getBySpace('org-1', 'sp-1');
      expect(r.data).toHaveLength(1);
      expect(r.count).toBe(1);
    });
  });

  describe('getById', () => {
    it('returns the group when found', async () => {
      mockFrom.mockReturnValue(buildChain({ data: mockGroup, error: null }));
      const r = await service.getById('fg-1');
      expect(r.id).toBe('fg-1');
    });
    it('throws NotFound when missing', async () => {
      mockFrom.mockReturnValue(buildChain({ data: null, error: null }));
      await expect(service.getById('x')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getByIdWithFields', () => {
    it('returns group with embedded fields', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockGroup, error: null })) // getById (outer)
        .mockReturnValueOnce(buildChain({ data: mockGroup, error: null })) // getById inside getFieldsInGroup
        .mockReturnValueOnce(
          buildChain({ data: [mockMembership], error: null }),
        );
      const r = await service.getByIdWithFields('fg-1', 'org-1');
      expect(r.fields).toHaveLength(1);
    });
  });

  describe('create', () => {
    it('creates the group', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockGroup, error: null }),
      );
      const r = await service.create('org-1', 'user-1', {
        name: 'General',
        color: '#fff',
        icon: 'star',
        is_collapsed_default: true,
      });
      expect(r.id).toBe('fg-1');
    });
  });

  describe('update', () => {
    it('updates the group', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockGroup, error: null }))
        .mockReturnValueOnce(
          buildChain({ data: { ...mockGroup, name: 'X' }, error: null }),
        );
      const r = await service.update('fg-1', 'user-1', { name: 'X' });
      expect(r.name).toBe('X');
    });
    it('throws NotFound when group missing', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.update('x', 'user-1', { name: 'X' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('softDelete (cascade)', () => {
    it('cascades through assignments, permissions, memberships', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockGroup, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: [{ id: 'a-1' }], error: null })) // fetch assignments
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // del level_field_group_field_permissions
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // del level_field_group_permissions
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // del level_field_group_assignments
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // del field_group_permissions
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // del field_group_fields
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // mark deleted
      await expect(
        service.softDelete('fg-1', 'user-1'),
      ).resolves.toBeUndefined();
      expect(mockFrom).toHaveBeenCalledTimes(8);
    });
  });

  describe('restore', () => {
    it('restores a deleted group', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: { ...mockGroup, is_deleted: true },
            error: null,
          }),
        )
        .mockReturnValueOnce(buildChain({ data: mockGroup, error: null }));
      const r = await service.restore('fg-1');
      expect(r.id).toBe('fg-1');
    });
    it('rejects an active group', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockGroup, error: null }),
      );
      await expect(service.restore('fg-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('permanentDelete', () => {
    it('hard-deletes the row when soft-deleted', async () => {
      const deletedGroup = { ...mockGroup, is_deleted: true };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: deletedGroup, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(service.permanentDelete('fg-1')).resolves.toBeUndefined();
    });
    it('throws BadRequest when group is not soft-deleted', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockGroup, error: null }),
      );
      await expect(service.permanentDelete('fg-1')).rejects.toThrow(
        /soft-deleted/,
      );
    });
  });

  describe('duplicate', () => {
    it('copies the group WITHOUT fields when copyFields=false', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockGroup, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({ data: { ...mockGroup, id: 'fg-2' }, error: null }),
        ); // create
      const r = await service.duplicate('fg-1', 'user-1', 'Copy', false);
      expect(r.id).toBe('fg-2');
    });
    it('copies the group WITH fields when copyFields=true', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockGroup, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({ data: { ...mockGroup, id: 'fg-2' }, error: null }),
        ) // create
        .mockReturnValueOnce(
          buildChain({ data: [mockMembership], error: null }),
        ) // getFieldsInGroup
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // insert copied
      const r = await service.duplicate('fg-1', 'user-1', 'Copy', true);
      expect(r.id).toBe('fg-2');
    });
  });

  // -----------------------------------------------------------------
  // Phase 3: Field membership
  // -----------------------------------------------------------------

  describe('addFieldToGroup', () => {
    it('adds a field', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockGroup, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: { id: 'cf-1' }, error: null })) // field exists
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // no dup
        .mockReturnValueOnce(buildChain({ data: mockMembership, error: null })); // insert
      const r = await service.addFieldToGroup('fg-1', {
        custom_field_id: 'cf-1',
        sort_order: 1,
        column_span: 6,
      });
      expect(r.id).toBe('fgf-1');
    });
    it('throws Conflict on duplicate', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockGroup, error: null }))
        .mockReturnValueOnce(buildChain({ data: { id: 'cf-1' }, error: null }))
        .mockReturnValueOnce(
          buildChain({ data: { id: 'existing' }, error: null }),
        );
      await expect(
        service.addFieldToGroup('fg-1', { custom_field_id: 'cf-1' }),
      ).rejects.toThrow(ConflictException);
    });
    it('throws NotFound when custom field missing', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockGroup, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.addFieldToGroup('fg-1', { custom_field_id: 'x' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('addFieldsToGroupBatch', () => {
    it('validates all fields exist before inserting', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockGroup, error: null }))
        .mockReturnValueOnce(
          buildChain({ data: [{ id: 'cf-1' }], error: null }),
        ); // only one exists
      await expect(
        service.addFieldsToGroupBatch('fg-1', [
          { custom_field_id: 'cf-1' },
          { custom_field_id: 'cf-2' },
        ]),
      ).rejects.toThrow(/not found/);
    });
    it('inserts on success', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockGroup, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({
            data: [{ id: 'cf-1' }, { id: 'cf-2' }],
            error: null,
          }),
        ) // existing custom fields check
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // existing in group
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // max sort_order
        .mockReturnValueOnce(
          buildChain({
            data: [mockMembership, { ...mockMembership, id: 'fgf-2' }],
            error: null,
          }),
        ); // insert
      const r = await service.addFieldsToGroupBatch('fg-1', [
        { custom_field_id: 'cf-1' },
        { custom_field_id: 'cf-2' },
      ]);
      expect(r).toHaveLength(2);
    });
  });

  describe('removeFieldFromGroup', () => {
    it('removes', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockGroup, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: { id: 'fgf-1' }, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.removeFieldFromGroup('fg-1', 'cf-1', 'org-1'),
      ).resolves.toBeUndefined();
    });
    it('throws NotFound when membership missing', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockGroup, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.removeFieldFromGroup('fg-1', 'cf-1', 'org-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateFieldInGroup', () => {
    it('updates settings', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockGroup, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({
            data: { ...mockMembership, is_required: true },
            error: null,
          }),
        );
      const r = await service.updateFieldInGroup(
        'fg-1',
        'cf-1',
        { is_required: true },
        'org-1',
      );
      expect(r.is_required).toBe(true);
    });
  });

  describe('reorderFields', () => {
    it('updates sort_order for each', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockGroup, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.reorderFields(
          'fg-1',
          [
            { custom_field_id: 'cf-1', sort_order: 1 },
            { custom_field_id: 'cf-2', sort_order: 2 },
          ],
          'org-1',
        ),
      ).resolves.toBeUndefined();
      expect(mockFrom).toHaveBeenCalledTimes(3);
    });
  });

  // -----------------------------------------------------------------
  // Phase 4: Level Assignments
  // -----------------------------------------------------------------

  describe('assignGroupToLevel', () => {
    it('inserts an assignment', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: {
              id: 'fg-1',
              organization_id: 'org-1',
              is_deleted: false,
            },
            error: null,
          }),
        ) // group check
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // no dup
        .mockReturnValueOnce(buildChain({ data: { id: 'a-1' }, error: null })); // insert
      const r = await service.assignGroupToLevel('org-1', {
        type: 'group',
        hierarchy_level_id: 'lvl-1',
        entity_type: 'process',
        field_group_id: 'fg-1',
        section: 'main',
      } as never);
      expect((r.data as { id: string }).id).toBe('a-1');
      expect(r.success).toBe(true);
    });
    it('throws Conflict on duplicate', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: {
              id: 'fg-1',
              organization_id: 'org-1',
              is_deleted: false,
            },
            error: null,
          }),
        )
        .mockReturnValueOnce(
          buildChain({ data: { id: 'existing' }, error: null }),
        );
      await expect(
        service.assignGroupToLevel('org-1', {
          type: 'group',
          hierarchy_level_id: 'lvl-1',
          entity_type: 'process',
          field_group_id: 'fg-1',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('unassignGroupFromLevel', () => {
    it('cascades permissions then deletes the assignment', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: 'a-1' }, error: null })) // find
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // del field perms
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // del group perms
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // del assignment
      await expect(
        service.unassignGroupFromLevel('lvl-1', 'process', 'fg-1'),
      ).resolves.toBeUndefined();
    });
    it('throws NotFound when missing', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.unassignGroupFromLevel('lvl-1', 'process', 'fg-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('assignFieldToLevel', () => {
    it('inserts a field assignment', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: {
              id: 'cf-1',
              organization_id: 'org-1',
              is_deleted: false,
            },
            error: null,
          }),
        ) // custom field check
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // no duplicate
        .mockReturnValueOnce(buildChain({ data: { id: 'b-1' }, error: null })); // insert
      const r = await service.assignFieldToLevel('org-1', {
        type: 'field',
        hierarchy_level_id: 'lvl-1',
        entity_type: 'process',
        custom_field_id: 'cf-1',
      } as never);
      expect((r.data as { id: string }).id).toBe('b-1');
      expect(r.success).toBe(true);
    });
    it('throws Conflict on duplicate field assignment', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: {
              id: 'cf-1',
              organization_id: 'org-1',
              is_deleted: false,
            },
            error: null,
          }),
        )
        .mockReturnValueOnce(
          buildChain({ data: { id: 'existing' }, error: null }),
        );
      await expect(
        service.assignFieldToLevel('org-1', {
          type: 'field',
          hierarchy_level_id: 'lvl-1',
          entity_type: 'process',
          custom_field_id: 'cf-1',
        }),
      ).rejects.toThrow(ConflictException);
    });
    it('throws NotFound when custom field missing', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.assignFieldToLevel('org-1', {
          type: 'field',
          hierarchy_level_id: 'lvl-1',
          entity_type: 'process',
          custom_field_id: 'cf-nope',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('unassignFieldFromLevel', () => {
    it('cascades perms then deletes', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: 'b-1' }, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.unassignFieldFromLevel('lvl-1', 'process', 'cf-1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('getLevelAssignments', () => {
    it('returns group assignments by default (wrapped in {data, count})', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: [
              {
                id: 'a-1',
                field_group: { id: 'fg-1', is_deleted: false, fields: [] },
              },
            ],
            error: null,
          }),
        ) // group assignments query
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // group permissions
        .mockReturnValueOnce(buildChain({ data: [], error: null })); // field-level permissions within group
      const r = await service.getLevelAssignments('org-1', 'lvl-1', 'process');
      expect(r.data).toHaveLength(1);
      expect(r.count).toBe(1);
    });
    it('returns group assignments when type="groups"', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: [
              {
                id: 'a-1',
                field_group: { id: 'fg-1', is_deleted: false, fields: [] },
              },
            ],
            error: null,
          }),
        )
        .mockReturnValueOnce(buildChain({ data: [], error: null }))
        .mockReturnValueOnce(buildChain({ data: [], error: null }));
      const r = await service.getLevelAssignments(
        'org-1',
        'lvl-1',
        'process',
        'groups',
      );
      expect(r.data).toHaveLength(1);
      expect(r.count).toBe(1);
    });
    it('returns field assignments when type="fields"', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: [{ id: 'b-1' }], error: null })) // field assignments query
        .mockReturnValueOnce(buildChain({ data: [], error: null })); // permissions for the assignment
      const r = await service.getLevelAssignments(
        'org-1',
        'lvl-1',
        'process',
        'fields',
      );
      expect(r.data).toHaveLength(1);
      expect(r.count).toBe(1);
    });
    it('filters space-disabled custom fields out of group assignment field counts', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: [{ custom_field_id: 'cf-disabled', is_enabled: false }],
            error: null,
          }),
        ) // disabled space overrides
        .mockReturnValueOnce(
          buildChain({
            data: [
              {
                id: 'a-1',
                field_group: {
                  id: 'fg-1',
                  is_deleted: false,
                  fields: [
                    {
                      id: 'fgf-1',
                      custom_field: {
                        id: 'cf-disabled',
                        is_active: true,
                        space_id: null,
                      },
                    },
                    {
                      id: 'fgf-2',
                      custom_field: {
                        id: 'cf-enabled',
                        is_active: true,
                        space_id: null,
                      },
                    },
                  ],
                },
              },
            ],
            error: null,
          }),
        ) // group assignments query
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // group permissions
        .mockReturnValueOnce(buildChain({ data: [], error: null })); // field-level permissions within group

      const r = await service.getLevelAssignments(
        'org-1',
        'lvl-1',
        'process',
        'groups',
        'space-1',
      );

      const assignment = r.data[0] as {
        field_group: { field_count: number; fields: unknown[] };
      };

      expect(assignment.field_group.field_count).toBe(1);
      expect(assignment.field_group.fields).toHaveLength(1);
    });
    it('filters space-disabled standalone field assignments', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: [{ custom_field_id: 'cf-disabled', is_enabled: false }],
            error: null,
          }),
        ) // disabled space overrides
        .mockReturnValueOnce(
          buildChain({
            data: [
              {
                id: 'a-1',
                custom_field: {
                  id: 'cf-disabled',
                  is_active: true,
                  space_id: null,
                },
              },
              {
                id: 'a-2',
                custom_field: {
                  id: 'cf-enabled',
                  is_active: true,
                  space_id: null,
                },
              },
            ],
            error: null,
          }),
        ) // field assignments query
        .mockReturnValueOnce(buildChain({ data: [], error: null })); // permissions for enabled assignment

      const r = await service.getLevelAssignments(
        'org-1',
        'lvl-1',
        'process',
        'fields',
        'space-1',
      );

      expect(r.count).toBe(1);
      expect((r.data[0] as { id: string }).id).toBe('a-2');
    });
  });

  describe('getLevelFieldsConfiguration', () => {
    it('flat structure when bySection=false', async () => {
      // Two parallel calls to getLevelAssignments (groups + fields). With
      // empty results no permission queries are issued.
      mockFrom
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // groups assignments
        .mockReturnValueOnce(buildChain({ data: [], error: null })); // fields assignments
      const r = (await service.getLevelFieldsConfiguration(
        'org-1',
        'lvl-1',
        'process',
        false,
      )) as { groups: unknown[]; standalone_fields: unknown[] };
      expect(r.groups).toBeDefined();
      expect(r.standalone_fields).toBeDefined();
    });
    it('grouped by section when bySection=true', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: [
              {
                id: 'a-1',
                section: 'header',
                field_group: { id: 'fg-1', is_deleted: false, fields: [] },
              },
            ],
            error: null,
          }),
        ) // groups assignments
        .mockReturnValueOnce(
          buildChain({
            data: [{ id: 'b-1', section: 'sidebar' }],
            error: null,
          }),
        ) // fields assignments
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // group perms
        .mockReturnValueOnce(buildChain({ data: [], error: null })) // group field perms
        .mockReturnValueOnce(buildChain({ data: [], error: null })); // field perms
      const r = (await service.getLevelFieldsConfiguration(
        'org-1',
        'lvl-1',
        'process',
        true,
      )) as {
        sections: Record<
          string,
          { groups: unknown[]; standalone_fields: unknown[] }
        >;
      };
      expect(r.sections.header.groups).toHaveLength(1);
      expect(r.sections.sidebar.standalone_fields).toHaveLength(1);
      expect(r.sections.main.groups).toHaveLength(0);
    });
  });

  describe('getGroupAssignmentPermissions', () => {
    it('lists permissions', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: { id: 'a-1', organization_id: 'org-1' },
            error: null,
          }),
        )
        .mockReturnValueOnce(
          buildChain({
            data: [{ id: 'p-1', target_type: 'user', can_view: true }],
            error: null,
          }),
        );
      const r = await service.getGroupAssignmentPermissions('a-1', 'org-1');
      expect(r).toHaveLength(1);
    });
  });

  describe('bulkSetGroupAssignmentPermissions', () => {
    it('deletes existing and inserts new atomically', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: { id: 'a-1', organization_id: 'org-1' },
            error: null,
          }),
        ) // verifyAssignmentOrg
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // delete
        .mockReturnValueOnce(
          buildChain({
            data: [
              {
                id: 'p-1',
                target_type: 'user',
                user_id: 'u-1',
                can_view: true,
                can_edit: false,
              },
            ],
            error: null,
          }),
        );
      const r = await service.bulkSetGroupAssignmentPermissions(
        'a-1',
        [
          {
            target_type: 'user',
            user_id: 'u-1',
            can_view: true,
            can_edit: false,
          },
        ],
        'org-1',
      );
      expect(r).toHaveLength(1);
    });
    it('validates target_type matches id fields', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: { id: 'a-1', organization_id: 'org-1' },
          error: null,
        }),
      );
      await expect(
        service.bulkSetGroupAssignmentPermissions(
          'a-1',
          [{ target_type: 'user', can_view: true, can_edit: false }],
          'org-1',
        ),
      ).rejects.toThrow(/user_id is required/);
    });
    it('empty permissions array clears', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: { id: 'a-1', organization_id: 'org-1' },
            error: null,
          }),
        )
        .mockReturnValueOnce(buildChain({ data: null, error: null }));
      const r = await service.bulkSetGroupAssignmentPermissions(
        'a-1',
        [],
        'org-1',
      );
      expect(r).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------
  // getFieldsInGroup — the embed-alias filter
  // -----------------------------------------------------------------

  describe('getFieldsInGroup', () => {
    it('filters soft-deleted fields on the embed ALIAS, not the table name', async () => {
      const fieldsChain = buildChain({ data: [mockMembership], error: null });

      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockGroup, error: null })) // getById
        .mockReturnValueOnce(fieldsChain);

      const r = await service.getFieldsInGroup('fg-1', 'org-1');

      expect(r).toHaveLength(1);
      // `custom_fields.is_deleted` cannot bind to the `custom_field:` embed;
      // combined with `!inner` it excluded every row and returned [].
      expect(fieldsChain.eq).toHaveBeenCalledWith(
        'custom_field.is_deleted',
        false,
      );
      expect(fieldsChain.eq).not.toHaveBeenCalledWith(
        'custom_fields.is_deleted',
        false,
      );
    });
  });
});
