/**
 * @fileoverview Unit tests for AssetsSchemaCfService — schema-scoped custom
 * field assignments: list, assign with duplicate guard, partial update,
 * remove, reorder, and the delete-then-insert sync flow with a wiped-state
 * warning when the insert fails.
 * @module src/assets/assets-schema-cf.service.spec
 * @author Prince Jadiya
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AssetsSchemaCfService } from './assets-schema-cf.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('AssetsSchemaCfService', () => {
  let service: AssetsSchemaCfService;
  let mockFrom: jest.Mock;

  const SCHEMA = 'schema-1';
  const ORG = 'org-1';
  const USER = 'user-1';

  const mockAssignment = {
    id: 'a-1',
    schema_id: SCHEMA,
    organization_id: ORG,
    custom_field_id: 'cf-1',
    sort_order: 0,
    is_required: false,
    is_hidden: false,
    column_span: 1,
    default_value_override: null,
  };

  function buildChain(resolved: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
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
    service = new AssetsSchemaCfService(supa);
  });

  // ── getAll ─────────────────────────────────────────────────────────────

  describe('getAll', () => {
    it('returns assignments ordered by sort_order', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: [mockAssignment], error: null }),
      );
      const r = await service.getAll(SCHEMA, ORG);
      expect(r).toHaveLength(1);
    });

    it('throws BadRequest on DB error', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: null, error: { message: 'fail' } }),
      );
      await expect(service.getAll(SCHEMA, ORG)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── assign ─────────────────────────────────────────────────────────────

  describe('assign', () => {
    it('inserts a new assignment when no duplicate exists', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // duplicate check
        .mockReturnValueOnce(buildChain({ data: mockAssignment, error: null })); // insert

      const r = await service.assign(SCHEMA, ORG, USER, {
        custom_field_id: 'cf-1',
      } as never);
      expect(r['id']).toBe('a-1');
    });

    it('rejects when the custom field is already assigned', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { id: 'existing' }, error: null }),
      );
      await expect(
        service.assign(SCHEMA, ORG, USER, {
          custom_field_id: 'cf-1',
        } as never),
      ).rejects.toThrow(/already assigned/);
    });

    it('applies sensible defaults when only the field id is provided', async () => {
      const insertChain = buildChain({
        data: mockAssignment,
        error: null,
      });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(insertChain);
      await service.assign(SCHEMA, ORG, USER, {
        custom_field_id: 'cf-1',
      } as never);
      const inserted = (
        (insertChain.insert as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0] as {
        sort_order: number;
        is_required: boolean;
        is_hidden: boolean;
        column_span: number;
        default_value_override: unknown;
      };
      expect(inserted.sort_order).toBe(0);
      expect(inserted.is_required).toBe(false);
      expect(inserted.is_hidden).toBe(false);
      expect(inserted.column_span).toBe(1);
      expect(inserted.default_value_override).toBeNull();
    });
  });

  // ── updateAssignment ───────────────────────────────────────────────────

  describe('updateAssignment', () => {
    it('updates the requested fields', async () => {
      const updated = { ...mockAssignment, is_required: true };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: 'a-1' }, error: null })) // existence
        .mockReturnValueOnce(buildChain({ data: updated, error: null })); // update
      const r = await service.updateAssignment('a-1', SCHEMA, ORG, USER, {
        is_required: true,
      } as never);
      expect(r['is_required']).toBe(true);
    });

    it('throws NotFound when assignment is missing', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.updateAssignment('missing', SCHEMA, ORG, USER, {
          is_required: true,
        } as never),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── removeAssignment ───────────────────────────────────────────────────

  describe('removeAssignment', () => {
    it('deletes the assignment when found', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: 'a-1' }, error: null })) // existence
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // delete
      const r = await service.removeAssignment('a-1', SCHEMA, ORG);
      expect(r.success).toBe(true);
    });

    it('throws NotFound when missing', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.removeAssignment('missing', SCHEMA, ORG),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── reorder ────────────────────────────────────────────────────────────

  describe('reorder', () => {
    it('updates sort_order for each entry sequentially', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }));
      const r = await service.reorder(SCHEMA, ORG, {
        field_orders: [
          { assignment_id: 'a-1', sort_order: 0 },
          { assignment_id: 'a-2', sort_order: 1 },
        ],
      });
      expect(r.success).toBe(true);
    });

    it('throws BadRequest when any update fails', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: null, error: { message: 'fail' } }),
      );
      await expect(
        service.reorder(SCHEMA, ORG, {
          field_orders: [{ assignment_id: 'a-1', sort_order: 0 }],
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── sync ───────────────────────────────────────────────────────────────

  describe('sync', () => {
    it('returns [] when target ids list is empty (delete only)', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null })); // delete
      const r = await service.sync(SCHEMA, ORG, USER, {
        custom_field_ids: [],
      });
      expect(r).toEqual([]);
    });

    it('deletes all then inserts new rows in order', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // delete
        .mockReturnValueOnce(
          buildChain({
            data: [
              { ...mockAssignment, custom_field_id: 'cf-a', sort_order: 0 },
              { ...mockAssignment, custom_field_id: 'cf-b', sort_order: 1 },
            ],
            error: null,
          }),
        );
      const r = await service.sync(SCHEMA, ORG, USER, {
        custom_field_ids: ['cf-a', 'cf-b'],
      });
      expect(r).toHaveLength(2);
    });

    it('throws BadRequest with wiped-state warning when insert fails', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // delete
        .mockReturnValueOnce(
          buildChain({ data: null, error: { message: 'fk fail' } }),
        );
      await expect(
        service.sync(SCHEMA, ORG, USER, { custom_field_ids: ['cf-a'] }),
      ).rejects.toThrow(/assignments were cleared/);
    });
  });
});
