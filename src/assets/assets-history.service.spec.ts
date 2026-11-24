/**
 * @fileoverview Unit tests for AssetsHistoryService — single-method service
 * that inserts an asset_item_changes row. Verifies field mapping, optional
 * payload defaults, and that fire-and-forget callers can rely on the row
 * shape exactly matching the DB schema.
 * @module src/assets/assets-history.service.spec
 * @author Prince Jadiya
 */

import { AssetsHistoryService } from './assets-history.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('AssetsHistoryService', () => {
  let service: AssetsHistoryService;
  let mockFrom: jest.Mock;

  const ITEM = 'item-1';
  const SCHEMA = 'schema-1';
  const ORG = 'org-1';
  const USER = 'user-1';

  function buildChain(resolved: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.insert = jest.fn().mockImplementation(self);
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled);
    return chain;
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    const supa = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;
    service = new AssetsHistoryService(supa);
  });

  describe('logChange', () => {
    it('inserts a row with full payload mapping', async () => {
      const chain = buildChain({ data: null, error: null });
      mockFrom.mockReturnValueOnce(chain);

      await service.logChange(ITEM, SCHEMA, ORG, 'cell_update', USER, {
        columnId: 'col-1',
        oldValue: 'old',
        newValue: 'new',
        metadata: { source: 'inline' },
      });

      expect(mockFrom).toHaveBeenCalledWith('asset_item_changes');
      const inserted = (
        (chain.insert as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0];
      expect(inserted).toEqual({
        item_id: ITEM,
        schema_id: SCHEMA,
        organization_id: ORG,
        change_type: 'cell_update',
        column_id: 'col-1',
        old_value: 'old',
        new_value: 'new',
        metadata: { source: 'inline' },
        changed_by: USER,
      });
    });

    it('defaults optional payload fields to null when omitted', async () => {
      const chain = buildChain({ data: null, error: null });
      mockFrom.mockReturnValueOnce(chain);

      await service.logChange(ITEM, SCHEMA, ORG, 'row_create', USER);

      const inserted = (
        (chain.insert as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0] as {
        column_id: unknown;
        old_value: unknown;
        new_value: unknown;
        metadata: unknown;
      };
      expect(inserted.column_id).toBeNull();
      expect(inserted.old_value).toBeNull();
      expect(inserted.new_value).toBeNull();
      expect(inserted.metadata).toBeNull();
    });

    it('accepts every change_type without massaging the value', async () => {
      const chain = buildChain({ data: null, error: null });
      mockFrom.mockReturnValue(chain);

      const types: Array<Parameters<typeof service.logChange>[3]> = [
        'cell_update',
        'row_create',
        'row_delete',
        'row_archive',
        'row_restore',
        'row_reorder',
        'bulk_update',
        'column_add',
        'column_remove',
        'column_rename',
        'column_reorder',
        'title_update',
        'description_update',
      ];

      for (const t of types) {
        await service.logChange(ITEM, SCHEMA, ORG, t, USER);
      }

      const calls = (
        (chain.insert as jest.Mock).mock.calls as Array<
          [{ change_type: string }]
        >
      ).map((c) => c[0].change_type);
      expect(calls).toEqual(types);
    });
  });
});
