/**
 * @fileoverview Unit tests for AssetsItemsService — paginated listing with
 * sortable-column allow-list, getById with NotFound, create with row_order
 * auto-increment + history side-effect, update with optimistic-lock + audit
 * fan-out, delete with storage cleanup, bulkUpdate/bulkDelete/bulkArchive,
 * reorder, history listing, and custom-field-values update.
 * @module src/assets/assets-items.service.spec
 * @author Prince Jadiya
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AssetsItemsService } from './assets-items.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AssetsHistoryService } from './assets-history.service';

describe('AssetsItemsService', () => {
  let service: AssetsItemsService;
  let mockFrom: jest.Mock;
  let mockStorageFrom: jest.Mock;
  let mockRemove: jest.Mock;
  let mockLogChange: jest.Mock;

  const ORG = 'org-1';
  const SPACE = 'space-1';
  const SCHEMA = 'schema-1';
  const USER = 'user-1';
  const ITEM = 'item-1';

  const mockItem = {
    id: ITEM,
    organization_id: ORG,
    space_id: SPACE,
    schema_id: SCHEMA,
    title: 'Laptop',
    description: null,
    fields_data: { name: 'Original' },
    custom_field_values: {},
    row_order: 1,
    is_archived: false,
    version: 1,
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
    chain.ilike = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.limit = jest.fn().mockImplementation(self);
    chain.range = jest.fn().mockImplementation(self);
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
    mockRemove = jest.fn().mockResolvedValue({ error: null });
    mockStorageFrom = jest.fn().mockReturnValue({ remove: mockRemove });
    mockLogChange = jest.fn().mockResolvedValue(undefined);

    const supa = {
      getClient: () => ({
        from: mockFrom,
        storage: { from: mockStorageFrom },
      }),
    } as unknown as SupabaseAdminService;
    const history = {
      logChange: mockLogChange,
    } as unknown as AssetsHistoryService;
    service = new AssetsItemsService(supa, history);
  });

  // ── getAll ─────────────────────────────────────────────────────────────

  describe('getAll', () => {
    it('returns paginated items with default page/pageSize', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: [mockItem], error: null, count: 1 }),
      );
      const r = await service.getAll(SPACE, ORG, { schemaId: SCHEMA });
      expect(r.data).toHaveLength(1);
      expect(r.total).toBe(1);
      expect(r.page).toBe(1);
      expect(r.page_size).toBe(25);
    });

    it('caps page_size at 100 and clamps page to 1', async () => {
      const chain = buildChain({ data: [], error: null, count: 0 });
      mockFrom.mockReturnValueOnce(chain);

      const r = await service.getAll(SPACE, ORG, {
        schemaId: SCHEMA,
        page: -3,
        page_size: 999,
      });
      expect(r.page).toBe(1);
      expect(r.page_size).toBe(100);
    });

    it('falls back to row_order when sort_column is not allowed', async () => {
      const chain = buildChain({ data: [], error: null, count: 0 });
      mockFrom.mockReturnValueOnce(chain);

      await service.getAll(SPACE, ORG, {
        schemaId: SCHEMA,
        sort_column: 'evil; DROP TABLE',
      });
      const orderArg = (
        (chain.order as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0];
      expect(orderArg).toBe('row_order');
    });

    it('honours allow-listed sort_column with descending direction', async () => {
      const chain = buildChain({ data: [], error: null, count: 0 });
      mockFrom.mockReturnValueOnce(chain);

      await service.getAll(SPACE, ORG, {
        schemaId: SCHEMA,
        sort_column: 'title',
        sort_direction: 'desc',
      });
      const [col, opts] = (chain.order as jest.Mock).mock.calls[0] as [
        string,
        { ascending: boolean },
      ];
      expect(col).toBe('title');
      expect(opts.ascending).toBe(false);
    });

    it('escapes percent/underscore in search', async () => {
      const chain = buildChain({ data: [], error: null, count: 0 });
      mockFrom.mockReturnValueOnce(chain);
      await service.getAll(SPACE, ORG, {
        schemaId: SCHEMA,
        search: '50%_off',
      });
      expect(chain.ilike).toHaveBeenCalledWith('title', '%50\\%\\_off%');
    });

    it('throws BadRequest on DB error', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: null,
          error: { message: 'fail' },
          count: 0,
        }),
      );
      await expect(
        service.getAll(SPACE, ORG, { schemaId: SCHEMA }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── getById ────────────────────────────────────────────────────────────

  describe('getById', () => {
    it('returns the item when found', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: mockItem, error: null }));
      const r = await service.getById(ITEM, ORG);
      expect(r['id']).toBe(ITEM);
    });

    it('throws NotFound when missing', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(service.getById('missing', ORG)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── create ─────────────────────────────────────────────────────────────

  describe('create', () => {
    it('auto-increments row_order from the max existing value', async () => {
      const insertChain = buildChain({
        data: { ...mockItem, row_order: 5 },
        error: null,
      });
      mockFrom
        .mockReturnValueOnce(
          buildChain({ data: { row_order: 4 }, error: null }),
        ) // max lookup
        .mockReturnValueOnce(insertChain);
      await service.create(SPACE, ORG, USER, {
        schema_id: SCHEMA,
        title: 'Laptop',
      } as never);
      const inserted = (
        (insertChain.insert as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0] as { row_order: number };
      expect(inserted.row_order).toBe(5);
      expect(mockLogChange).toHaveBeenCalled();
    });

    it('uses 1 as row_order when no items exist yet', async () => {
      const insertChain = buildChain({ data: mockItem, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // no max
        .mockReturnValueOnce(insertChain);
      await service.create(SPACE, ORG, USER, {
        schema_id: SCHEMA,
        title: 'X',
      } as never);
      const inserted = (
        (insertChain.insert as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0] as { row_order: number };
      expect(inserted.row_order).toBe(1);
    });
  });

  // ── update ─────────────────────────────────────────────────────────────

  describe('update', () => {
    it('rejects on version mismatch', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { ...mockItem, version: 5 }, error: null }),
      );
      await expect(
        service.update(ITEM, ORG, USER, {
          version: 1,
          title: 'X',
        } as never),
      ).rejects.toThrow(/modified by another user/);
    });

    it('updates and bumps version when versions match', async () => {
      const updated = { ...mockItem, title: 'Renamed', version: 2 };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockItem, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: updated, error: null })); // update

      const r = await service.update(ITEM, ORG, USER, {
        version: 1,
        title: 'Renamed',
      } as never);

      expect((r.data as { version: number }).version).toBe(2);
      // Title diff triggers history log
      expect(mockLogChange).toHaveBeenCalled();
    });

    it('writes archived_at + archived_by when archiving', async () => {
      const archived = { ...mockItem, is_archived: true, version: 2 };
      const updateChain = buildChain({ data: archived, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockItem, error: null }))
        .mockReturnValueOnce(updateChain);

      await service.update(ITEM, ORG, USER, {
        version: 1,
        is_archived: true,
      } as never);
      const patch = (
        (updateChain.update as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0] as { archived_at: unknown; archived_by: unknown };
      expect(patch.archived_at).toBeDefined();
      expect(patch.archived_by).toBe(USER);
    });

    it('clears archived_at when unarchiving', async () => {
      const archivedItem = { ...mockItem, is_archived: true };
      const updated = { ...archivedItem, is_archived: false, version: 2 };
      const updateChain = buildChain({ data: updated, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: archivedItem, error: null }))
        .mockReturnValueOnce(updateChain);

      await service.update(ITEM, ORG, USER, {
        version: 1,
        is_archived: false,
      } as never);
      const patch = (
        (updateChain.update as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0] as { archived_at: unknown; archived_by: unknown };
      expect(patch.archived_at).toBeNull();
      expect(patch.archived_by).toBeNull();
    });

    it('logs cell_update entries for changed fields_data values only', async () => {
      const updated = {
        ...mockItem,
        fields_data: { name: 'New', other: 'unchanged' },
        version: 2,
      };
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: {
              ...mockItem,
              fields_data: { name: 'Original', other: 'unchanged' },
            },
            error: null,
          }),
        )
        .mockReturnValueOnce(buildChain({ data: updated, error: null }));

      await service.update(ITEM, ORG, USER, {
        version: 1,
        fields_data: { name: 'New', other: 'unchanged' },
      } as never);

      // Only name changed → exactly one cell_update call
      const cellCalls = (mockLogChange.mock.calls as unknown[][]).filter(
        (c) => c[3] === 'cell_update',
      );
      expect(cellCalls).toHaveLength(1);
      expect((cellCalls[0]?.[5] as { columnId: string }).columnId).toBe('name');
    });
  });

  // ── delete ─────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('removes attachments from storage then deletes the item', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockItem, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({
            data: [{ file_path: 'p/file' }],
            error: null,
          }),
        ) // attachments
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // delete

      await expect(service.delete(ITEM, ORG, USER)).resolves.toEqual({
        success: true,
        message: 'Item deleted',
      });
      expect(mockRemove).toHaveBeenCalledWith(['p/file']);
    });

    it('deletes the item even when no attachments exist', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockItem, error: null }))
        .mockReturnValueOnce(buildChain({ data: [], error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }));
      await service.delete(ITEM, ORG, USER);
      expect(mockRemove).not.toHaveBeenCalled();
    });
  });

  // ── bulkUpdate ─────────────────────────────────────────────────────────

  describe('bulkUpdate', () => {
    it('rejects when versions in the same item disagree', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: mockItem, error: null }));
      await expect(
        service.bulkUpdate(SPACE, ORG, USER, {
          updates: [
            { item_id: ITEM, column_id: 'a', value: 1, version: 1 },
            { item_id: ITEM, column_id: 'b', value: 2, version: 2 },
          ],
        } as never),
      ).rejects.toThrow(/conflicting versions/);
    });

    it('rejects when stored version is stale', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { ...mockItem, version: 5 }, error: null }),
      );
      await expect(
        service.bulkUpdate(SPACE, ORG, USER, {
          updates: [{ item_id: ITEM, column_id: 'a', value: 'X', version: 1 }],
        } as never),
      ).rejects.toThrow(/modified by another user/);
    });

    it('groups updates per item and bumps version once', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockItem, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({
            data: { ...mockItem, version: 2 },
            error: null,
          }),
        );

      const r = await service.bulkUpdate(SPACE, ORG, USER, {
        updates: [
          { item_id: ITEM, column_id: 'a', value: 1, version: 1 },
          { item_id: ITEM, column_id: 'b', value: 2, version: 1 },
        ],
      } as never);
      expect(r.data).toHaveLength(1);
    });
  });

  // ── bulkDelete ─────────────────────────────────────────────────────────

  describe('bulkDelete', () => {
    it('deletes all listed items and logs each', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockItem, error: null })) // getById for ITEM
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // delete in()

      const r = await service.bulkDelete(ORG, USER, {
        ids: [ITEM],
      });
      expect(r.success).toBe(true);
      expect(mockLogChange).toHaveBeenCalled();
    });

    it('throws BadRequest when DB delete fails', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockItem, error: null }))
        .mockReturnValueOnce(
          buildChain({ data: null, error: { message: 'fk' } }),
        );
      await expect(
        service.bulkDelete(ORG, USER, { ids: [ITEM] }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── bulkArchive ────────────────────────────────────────────────────────

  describe('bulkArchive', () => {
    it('marks all listed items as archived', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockItem, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }));
      const r = await service.bulkArchive(ORG, USER, { ids: [ITEM] });
      expect(r.success).toBe(true);
    });
  });

  // ── reorder ────────────────────────────────────────────────────────────

  describe('reorder', () => {
    it('issues sequential row_order updates', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }));
      const r = await service.reorder(ORG, USER, {
        orders: [
          { item_id: ITEM, row_order: 0 },
          { item_id: 'item-2', row_order: 1 },
        ],
      });
      expect(r.success).toBe(true);
    });

    it('throws BadRequest when an update fails', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: null, error: { message: 'fail' } }),
      );
      await expect(
        service.reorder(ORG, USER, {
          orders: [{ item_id: ITEM, row_order: 0 }],
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── getHistory ─────────────────────────────────────────────────────────

  describe('getHistory', () => {
    it('returns paginated history rows', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: [{ id: 'h-1', change_type: 'cell_update' }],
          error: null,
          count: 1,
        }),
      );
      const r = await service.getHistory(ITEM, ORG);
      expect(r.data).toHaveLength(1);
      expect(r.total).toBe(1);
    });

    it('throws BadRequest on DB error', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: null,
          error: { message: 'fail' },
          count: 0,
        }),
      );
      await expect(service.getHistory(ITEM, ORG)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── Custom field values ────────────────────────────────────────────────

  describe('getCustomFieldValues', () => {
    it('returns values + version envelope', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: {
            ...mockItem,
            custom_field_values: { color: 'red' },
            version: 3,
          },
          error: null,
        }),
      );
      const r = await service.getCustomFieldValues(ITEM, ORG);
      expect(r.data).toEqual({ color: 'red' });
      expect(r.version).toBe(3);
    });
  });

  describe('updateCustomFieldValues', () => {
    it('rejects on version mismatch', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { ...mockItem, version: 5 }, error: null }),
      );
      await expect(
        service.updateCustomFieldValues(ITEM, ORG, USER, {
          version: 1,
          customFieldValues: { color: 'red' },
        } as never),
      ).rejects.toThrow(/modified by another user/);
    });

    it('updates values and logs each changed field', async () => {
      const updated = {
        ...mockItem,
        custom_field_values: { color: 'blue', shape: 'round' },
        version: 2,
      };
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: {
              ...mockItem,
              custom_field_values: { color: 'red', shape: 'round' },
            },
            error: null,
          }),
        )
        .mockReturnValueOnce(buildChain({ data: updated, error: null }));

      await service.updateCustomFieldValues(ITEM, ORG, USER, {
        version: 1,
        customFieldValues: { color: 'blue', shape: 'round' },
      } as never);
      // Only 'color' changed → one history call
      const cellCalls = (mockLogChange.mock.calls as unknown[][]).filter(
        (c) => c[3] === 'cell_update',
      );
      expect(cellCalls).toHaveLength(1);
      expect((cellCalls[0]?.[5] as { columnId: string }).columnId).toBe(
        'color',
      );
    });
  });
});
