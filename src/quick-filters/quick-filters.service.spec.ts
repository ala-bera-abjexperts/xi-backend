/**
 * @fileoverview Unit tests for QuickFiltersService — board ownership check,
 * sort_order auto-increment, partial updates, sequential reorder, and
 * per-user enable/disable state via upsert.
 * @module src/quick-filters/quick-filters.service.spec
 * @author Prince Jadiya
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { QuickFiltersService } from './quick-filters.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('QuickFiltersService', () => {
  let service: QuickFiltersService;
  let mockFrom: jest.Mock;
  let mockRpc: jest.Mock;

  const ORG = 'org-1';
  const BOARD = 'board-1';
  const USER = 'user-1';

  const mockFilter = {
    id: 'qf-1',
    board_id: BOARD,
    name: 'My open tasks',
    query: 'assignee:me',
    description: null,
    sort_order: 0,
    is_enabled: true,
    created_by: USER,
  };

  function buildChain(resolved: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.in = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.limit = jest.fn().mockImplementation(self);
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
    mockRpc = jest.fn().mockResolvedValue({ data: 0, error: null });
    const supa = {
      getClient: () => ({ from: mockFrom, rpc: mockRpc }),
    } as unknown as SupabaseAdminService;
    service = new QuickFiltersService(supa);
  });

  // ── create ─────────────────────────────────────────────────────────────

  describe('create', () => {
    it('uses 0 as sort_order when no filters exist', async () => {
      const insertChain = buildChain({ data: mockFilter, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null })) // verifyBoard
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // max sort_order (none)
        .mockReturnValueOnce(insertChain); // insert

      const r = await service.create(BOARD, ORG, USER, {
        name: 'Mine',
        query: 'q',
      } as never);

      expect(r.success).toBe(true);
      const inserted = (
        (insertChain.insert as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0] as Record<string, unknown>;
      expect(inserted['sort_order']).toBe(0);
    });

    it('auto-increments sort_order from existing max', async () => {
      const insertChain = buildChain({ data: mockFilter, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null }))
        .mockReturnValueOnce(
          buildChain({ data: { sort_order: 5 }, error: null }),
        )
        .mockReturnValueOnce(insertChain);

      await service.create(BOARD, ORG, USER, {
        name: 'X',
        query: 'q',
      } as never);

      const inserted2 = (
        (insertChain.insert as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0] as Record<string, unknown>;
      expect(inserted2['sort_order']).toBe(6);
    });

    it('honours explicit sort_order in payload (skips lookup)', async () => {
      const insertChain = buildChain({ data: mockFilter, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null }))
        .mockReturnValueOnce(insertChain);
      await service.create(BOARD, ORG, USER, {
        name: 'Pinned',
        query: 'q',
        sort_order: 99,
      } as never);

      const inserted3 = (
        (insertChain.insert as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0] as Record<string, unknown>;
      expect(inserted3['sort_order']).toBe(99);
    });

    it('throws NotFound when board belongs to another org', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.create(BOARD, ORG, USER, {
          name: 'X',
          query: 'q',
        } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequest when insert errors', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(
          buildChain({ data: null, error: { message: 'fail' } }),
        );
      await expect(
        service.create(BOARD, ORG, USER, {
          name: 'X',
          query: 'q',
        } as never),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── update ─────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates the requested fields', async () => {
      const updated = { ...mockFilter, name: 'Renamed' };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null })) // verifyBoard
        .mockReturnValueOnce(buildChain({ data: mockFilter, error: null })) // existence check
        .mockReturnValueOnce(buildChain({ data: updated, error: null })); // update
      const r = await service.update('qf-1', BOARD, ORG, USER, {
        name: 'Renamed',
      } as never);
      expect((r.data as { name: string }).name).toBe('Renamed');
    });

    it('returns the existing row unchanged when patch is empty', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null }))
        .mockReturnValueOnce(buildChain({ data: mockFilter, error: null }));
      const r = await service.update('qf-1', BOARD, ORG, USER, {} as never);
      expect((r.data as { id: string }).id).toBe('qf-1');
    });

    it('throws NotFound when filter does not exist on the board', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.update('qf-1', BOARD, ORG, USER, { name: 'X' } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequest when DB update errors', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null }))
        .mockReturnValueOnce(buildChain({ data: mockFilter, error: null }))
        .mockReturnValueOnce(
          buildChain({ data: null, error: { message: 'fail' } }),
        );
      await expect(
        service.update('qf-1', BOARD, ORG, USER, { name: 'X' } as never),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── delete ─────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('deletes the filter when found', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null })) // verifyBoard
        .mockReturnValueOnce(buildChain({ data: { id: 'qf-1' }, error: null })) // existence
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // delete
      const r = await service.delete('qf-1', BOARD, ORG, USER);
      expect(r).toEqual({ success: true, message: 'Quick filter deleted' });
    });

    it('throws NotFound when filter does not exist', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(service.delete('missing', BOARD, ORG, USER)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── reorder ────────────────────────────────────────────────────────────

  describe('reorder', () => {
    it('returns immediately for an empty payload', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { id: BOARD }, error: null }),
      );
      const r = await service.reorder(BOARD, ORG, USER, { quick_filters: [] });
      expect(r).toEqual({ success: true });
    });

    it('updates each filter sequentially', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null }))
        .mockReturnValueOnce(
          buildChain({
            data: [{ id: 'qf-1' }, { id: 'qf-2' }],
            error: null,
          }),
        )
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(buildChain({ data: { id: 'qf-2' }, error: null }));
      const r = await service.reorder(BOARD, ORG, USER, {
        quick_filters: [
          { id: 'qf-1', sort_order: 0 },
          { id: 'qf-2', sort_order: 1 },
        ],
      });
      expect(r.success).toBe(true);
    });

    it('throws BadRequest when any update fails', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'fail' },
      });
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { id: BOARD }, error: null }),
      );
      await expect(
        service.reorder(BOARD, ORG, USER, {
          quick_filters: [{ id: 'qf-1', sort_order: 0 }],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFound when any filter id is stale', async () => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'One or more quick filters were not found' },
      });
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { id: BOARD }, error: null }),
      );

      await expect(
        service.reorder(BOARD, ORG, USER, {
          quick_filters: [{ id: 'qf-missing', sort_order: 0 }],
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── setUserState ───────────────────────────────────────────────────────

  describe('setUserState', () => {
    it('upserts active state for the user', async () => {
      const upsertChain = buildChain({ data: null, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null }))
        .mockReturnValueOnce(buildChain({ data: mockFilter, error: null }))
        .mockReturnValueOnce(upsertChain);
      const r = await service.setUserState(BOARD, 'qf-1', ORG, USER, true);
      expect(r).toEqual({ success: true });
      expect(upsertChain.upsert).toHaveBeenCalled();
    });

    it('throws BadRequest when upsert errors', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null }))
        .mockReturnValueOnce(buildChain({ data: mockFilter, error: null }))
        .mockReturnValueOnce(
          buildChain({ data: null, error: { message: 'fail' } }),
        );
      await expect(
        service.setUserState(BOARD, 'qf-1', ORG, USER, false),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
