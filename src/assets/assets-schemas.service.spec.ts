/**
 * @fileoverview Unit tests for AssetsSchemasService — schema CRUD with key
 * uniqueness, soft delete (is_active=false), CSV export with proper escape
 * + header ordering, column add (default-fill + dup guard), reorder,
 * rename, remove with order re-indexing.
 * @module src/assets/assets-schemas.service.spec
 * @author Prince Jadiya
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AssetsSchemasService } from './assets-schemas.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('AssetsSchemasService', () => {
  let service: AssetsSchemasService;
  let mockFrom: jest.Mock;

  const ORG = 'org-1';
  const SPACE = 'space-1';
  const USER = 'user-1';
  const SCHEMA = 'schema-1';

  const mockSchema = {
    id: SCHEMA,
    organization_id: ORG,
    space_id: SPACE,
    name: 'Asset Register',
    key: 'AR',
    description: null,
    icon: null,
    fields_definition: [],
    column_config: [
      { columnId: 'name', label: 'Name', order: 0, cellType: 'text' },
      { columnId: 'value', label: 'Value', order: 1, cellType: 'number' },
    ],
    settings: {},
    permissions: {},
    field_group_ids: [],
    status: 'active',
    is_active: true,
    version: 1,
  };

  function buildChain(resolved: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
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
    service = new AssetsSchemasService(supa);
  });

  // ── getAll ─────────────────────────────────────────────────────────────

  describe('getAll', () => {
    it('returns active schemas in the space', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: [mockSchema], error: null }),
      );
      const r = await service.getAll(SPACE, ORG);
      expect(r.data).toHaveLength(1);
      expect(r.count).toBe(1);
    });

    it('throws BadRequest on DB error', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: null, error: { message: 'fail' } }),
      );
      await expect(service.getAll(SPACE, ORG)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── getById / getByKey ─────────────────────────────────────────────────

  describe('getById', () => {
    it('returns the schema when found', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockSchema, error: null }),
      );
      const r = await service.getById(SCHEMA, SPACE, ORG);
      expect(r['id']).toBe(SCHEMA);
    });

    it('throws NotFound when missing', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(service.getById('missing', SPACE, ORG)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getByKey', () => {
    it('returns active schemas only', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockSchema, error: null }),
      );
      const r = await service.getByKey('AR', SPACE, ORG);
      expect(r['key']).toBe('AR');
    });

    it('throws NotFound when key not found', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(service.getByKey('missing', SPACE, ORG)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── create ─────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates the schema when key is available', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // dup check
        .mockReturnValueOnce(buildChain({ data: mockSchema, error: null })); // insert
      const r = await service.create(SPACE, ORG, USER, {
        name: 'Asset Register',
        key: 'AR',
      } as never);
      expect(r['id']).toBe(SCHEMA);
    });

    it('rejects when key already exists in the space', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { id: 'existing' }, error: null }),
      );
      await expect(
        service.create(SPACE, ORG, USER, {
          name: 'Dupe',
          key: 'AR',
        } as never),
      ).rejects.toThrow(/already exists/);
    });

    it('throws BadRequest when insert fails', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(
          buildChain({ data: null, error: { message: 'fail' } }),
        );
      await expect(
        service.create(SPACE, ORG, USER, {
          name: 'X',
          key: 'X',
        } as never),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── update ─────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates the schema fields', async () => {
      const updated = { ...mockSchema, name: 'Renamed' };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockSchema, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: updated, error: null })); // update
      const r = await service.update(SCHEMA, SPACE, ORG, USER, {
        name: 'Renamed',
      } as never);
      expect((r.data as { name: string }).name).toBe('Renamed');
    });

    it('throws NotFound when schema does not exist', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.update('missing', SPACE, ORG, USER, {
          name: 'X',
        } as never),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── softDelete ─────────────────────────────────────────────────────────

  describe('softDelete', () => {
    it('marks the schema is_active=false', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockSchema, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // update
      const r = await service.softDelete(SCHEMA, SPACE, ORG, USER);
      expect(r.success).toBe(true);
    });
  });

  // ── exportCsv ──────────────────────────────────────────────────────────

  describe('exportCsv', () => {
    it('uses configured columns and escapes quoted/comma values', async () => {
      const items = [
        {
          id: 'i-1',
          title: 'Laptop, with comma',
          fields_data: { name: 'A "quoted"', value: 1000 },
          row_order: 0,
          is_archived: false,
        },
      ];
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockSchema, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: items, error: null })); // items query

      const csv = await service.exportCsv(SCHEMA, SPACE, ORG);
      const lines = csv.split('\n');
      expect(lines[0]).toBe('"Title","Name","Value"');
      expect(lines[1]).toContain('"Laptop, with comma"');
      // Embedded double quotes are doubled per RFC 4180
      expect(lines[1]).toContain('A ""quoted""');
    });

    it('still produces a header row when there are no items', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockSchema, error: null }))
        .mockReturnValueOnce(buildChain({ data: [], error: null }));
      const csv = await service.exportCsv(SCHEMA, SPACE, ORG);
      expect(csv).toBe('"Title","Name","Value"');
    });
  });

  // ── Column ops ─────────────────────────────────────────────────────────

  describe('addColumn', () => {
    it('appends a new column with default fields', async () => {
      const updateChain = buildChain({
        data: { ...mockSchema, column_config: [] },
        error: null,
      });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockSchema, error: null })) // getById
        .mockReturnValueOnce(updateChain); // update

      await service.addColumn(SCHEMA, SPACE, ORG, USER, {
        column: { columnId: 'new', label: 'New' },
      } as never);

      const updateArg = (
        (updateChain.update as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0] as { column_config: Record<string, unknown>[] };
      const cfg = updateArg.column_config;
      const added = cfg.find((c) => c.columnId === 'new')!;
      expect(added.width).toBe(150);
      expect(added.cellType).toBe('text');
      expect(added.required).toBe(false);
      expect(added.resizable).toBe(true);
      expect(added.reorderable).toBe(true);
    });

    it('rejects when columnId already exists', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockSchema, error: null }),
      );
      await expect(
        service.addColumn(SCHEMA, SPACE, ORG, USER, {
          column: { columnId: 'name', label: 'Dup' },
        } as never),
      ).rejects.toThrow(/already exists/);
    });
  });

  describe('reorderColumns', () => {
    it('updates the order field for each affected column', async () => {
      const updateChain = buildChain({ data: mockSchema, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockSchema, error: null }))
        .mockReturnValueOnce(updateChain);

      await service.reorderColumns(SCHEMA, SPACE, ORG, USER, {
        column_order: [
          { columnId: 'name', order: 1 },
          { columnId: 'value', order: 0 },
        ],
      } as never);

      const updateArg = (
        (updateChain.update as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0] as { column_config: Record<string, number>[] };
      const cfg = updateArg.column_config;
      expect(
        cfg.find(
          (c) => (c as unknown as { columnId: string }).columnId === 'name',
        )?.order,
      ).toBe(1);
      expect(
        cfg.find(
          (c) => (c as unknown as { columnId: string }).columnId === 'value',
        )?.order,
      ).toBe(0);
    });
  });

  describe('renameColumn', () => {
    it('updates the label of an existing column', async () => {
      const updateChain = buildChain({ data: mockSchema, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockSchema, error: null }))
        .mockReturnValueOnce(updateChain);

      await service.renameColumn(SCHEMA, 'name', SPACE, ORG, USER, {
        new_label: 'Renamed',
      } as never);

      const updateArg = (
        (updateChain.update as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0] as { column_config: Record<string, unknown>[] };
      const cfg = updateArg.column_config;
      const col = cfg.find((c) => c.columnId === 'name')!;
      expect(col.label).toBe('Renamed');
    });

    it('throws NotFound when the column does not exist', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockSchema, error: null }),
      );
      await expect(
        service.renameColumn(SCHEMA, 'missing', SPACE, ORG, USER, {
          new_label: 'X',
        } as never),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('removeColumn', () => {
    it('removes the column and re-indexes order', async () => {
      const updateChain = buildChain({ data: mockSchema, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockSchema, error: null }))
        .mockReturnValueOnce(updateChain);

      await service.removeColumn(SCHEMA, 'name', SPACE, ORG, USER);

      const updateArg = (
        (updateChain.update as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0] as { column_config: Record<string, unknown>[] };
      const cfg = updateArg.column_config;
      expect(cfg).toHaveLength(1);
      expect(cfg[0]?.order).toBe(0);
      expect(cfg[0]?.columnId).toBe('value');
    });

    it('throws NotFound when column missing', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockSchema, error: null }),
      );
      await expect(
        service.removeColumn(SCHEMA, 'missing', SPACE, ORG, USER),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
