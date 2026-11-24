/**
 * @fileoverview Unit tests for SwimlanesService — board ownership verification,
 * CRUD with auto-incrementing sort_order, default-swimlane delete guard,
 * and sequential reorder updates.
 * @module src/swimlanes/swimlanes.service.spec
 * @author Prince Jadiya
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SwimlanesService } from './swimlanes.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('SwimlanesService', () => {
  let service: SwimlanesService;
  let mockFrom: jest.Mock;

  const ORG = 'org-1';
  const BOARD = 'board-1';

  const mockSwimlane = {
    id: 'sl-1',
    board_id: BOARD,
    name: 'Backlog',
    query: null,
    description: null,
    sort_order: 0,
    is_default: false,
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
    service = new SwimlanesService(supa);
  });

  // ── verifyBoard (via getAll) ───────────────────────────────────────────

  describe('board verification', () => {
    it('throws NotFound when board does not belong to org', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(service.getAll(BOARD, ORG)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws BadRequest when board lookup errors', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: null, error: { message: 'db down' } }),
      );
      await expect(service.getAll(BOARD, ORG)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── getAll ─────────────────────────────────────────────────────────────

  describe('getAll', () => {
    it('returns swimlanes ordered by sort_order', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null })) // verifyBoard
        .mockReturnValueOnce(buildChain({ data: [mockSwimlane], error: null }));
      const r = await service.getAll(BOARD, ORG);
      expect(r.data).toHaveLength(1);
      expect(r.count).toBe(1);
    });

    it('throws BadRequest when query errors', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null }))
        .mockReturnValueOnce(
          buildChain({ data: null, error: { message: 'fail' } }),
        );
      await expect(service.getAll(BOARD, ORG)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── create ─────────────────────────────────────────────────────────────

  describe('create', () => {
    it('auto-increments sort_order from the existing max', async () => {
      const insertChain = buildChain({ data: mockSwimlane, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null })) // verifyBoard
        .mockReturnValueOnce(
          buildChain({ data: { sort_order: 4 }, error: null }),
        ) // max sort_order
        .mockReturnValueOnce(insertChain); // insert
      const r = await service.create(BOARD, ORG, {
        name: 'Backlog',
      } as never);
      expect((r.data as { id: string }).id).toBe('sl-1');
      const inserted = (
        (insertChain.insert as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0] as Record<string, unknown>;
      expect(inserted['sort_order']).toBe(5);
    });

    it('uses 0 as sort_order when no swimlanes exist yet', async () => {
      const insertChain = buildChain({ data: mockSwimlane, error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(insertChain);

      await service.create(BOARD, ORG, { name: 'First' } as never);
      const inserted2 = (
        (insertChain.insert as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0] as Record<string, unknown>;
      expect(inserted2['sort_order']).toBe(0);
    });

    it('throws BadRequest when insert fails', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(
          buildChain({ data: null, error: { message: 'fk fail' } }),
        );
      await expect(
        service.create(BOARD, ORG, { name: 'X' } as never),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── update ─────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates the swimlane fields', async () => {
      const updated = { ...mockSwimlane, name: 'Renamed' };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null })) // verifyBoard
        .mockReturnValueOnce(buildChain({ data: { id: 'sl-1' }, error: null })) // existence check
        .mockReturnValueOnce(buildChain({ data: updated, error: null })); // update
      const r = await service.update('sl-1', BOARD, ORG, {
        name: 'Renamed',
      } as never);
      expect((r.data as { name: string }).name).toBe('Renamed');
    });

    it('returns current row unchanged when patch is empty', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null }))
        .mockReturnValueOnce(buildChain({ data: { id: 'sl-1' }, error: null })) // existence check
        .mockReturnValueOnce(buildChain({ data: mockSwimlane, error: null })); // re-fetch current
      const r = await service.update('sl-1', BOARD, ORG, {} as never);
      expect(r.success).toBe(true);
      expect((r.data as { id: string }).id).toBe('sl-1');
    });

    it('throws NotFound when swimlane does not exist on board', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.update('missing', BOARD, ORG, { name: 'X' } as never),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── delete ─────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('deletes a non-default swimlane', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null })) // verifyBoard
        .mockReturnValueOnce(
          buildChain({
            data: { id: 'sl-1', is_default: false },
            error: null,
          }),
        )
        .mockReturnValueOnce(buildChain({ data: null, error: null }));
      const r = await service.delete('sl-1', BOARD, ORG);
      expect(r).toEqual({ success: true, message: 'Swimlane deleted' });
    });

    it('refuses to delete the default swimlane', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null }))
        .mockReturnValueOnce(
          buildChain({
            data: { id: 'sl-1', is_default: true },
            error: null,
          }),
        );
      await expect(service.delete('sl-1', BOARD, ORG)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws NotFound when swimlane is missing', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(service.delete('missing', BOARD, ORG)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── reorder ────────────────────────────────────────────────────────────

  describe('reorder', () => {
    it('returns immediately for an empty payload', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { id: BOARD }, error: null }),
      ); // verifyBoard only
      const r = await service.reorder(BOARD, ORG, { swimlanes: [] });
      expect(r).toEqual({ success: true });
    });

    it('issues sequential updates for each swimlane', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null })) // verifyBoard
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // update 1
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // update 2
      const r = await service.reorder(BOARD, ORG, {
        swimlanes: [
          { id: 'sl-1', sort_order: 0 },
          { id: 'sl-2', sort_order: 1 },
        ],
      });
      expect(r.success).toBe(true);
    });

    it('throws BadRequest when any update errors', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null }))
        .mockReturnValueOnce(
          buildChain({ data: null, error: { message: 'fail' } }),
        );
      await expect(
        service.reorder(BOARD, ORG, {
          swimlanes: [{ id: 'sl-1', sort_order: 0 }],
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
