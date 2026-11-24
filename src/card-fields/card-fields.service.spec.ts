/**
 * @fileoverview Unit tests for CardFieldsService — board ownership check,
 * ordered listing, and the delete-then-replace setCardFields flow.
 * @module src/card-fields/card-fields.service.spec
 * @author Prince Jadiya
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CardFieldsService } from './card-fields.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('CardFieldsService', () => {
  let service: CardFieldsService;
  let mockFrom: jest.Mock;

  const ORG = 'org-1';
  const BOARD = 'board-1';

  const mockField = {
    id: 'cf-1',
    board_id: BOARD,
    custom_field_id: 'field-1',
    position: 0,
    width: 'auto',
    color: null,
  };

  function buildChain(resolved: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
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
    service = new CardFieldsService(supa);
  });

  // ── getCardFields ──────────────────────────────────────────────────────

  describe('getCardFields', () => {
    it('returns ordered card fields for the board', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null })) // verifyBoard
        .mockReturnValueOnce(buildChain({ data: [mockField], error: null }));
      const r = await service.getCardFields(BOARD, ORG);
      expect(r.data).toHaveLength(1);
    });

    it('throws NotFound when the board belongs to a different org', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(service.getCardFields(BOARD, ORG)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws BadRequest when the listing query errors', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null }))
        .mockReturnValueOnce(
          buildChain({ data: null, error: { message: 'boom' } }),
        );
      await expect(service.getCardFields(BOARD, ORG)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── setCardFields ──────────────────────────────────────────────────────

  describe('setCardFields', () => {
    it('returns an empty result early when fields=[]', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null })) // verifyBoard
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // delete
      const r = await service.setCardFields(BOARD, ORG, { fields: [] });
      expect(r).toEqual({ data: [], success: true });
    });

    it('replaces card fields by deleting then inserting', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null })) // verifyBoard
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // delete
        .mockReturnValueOnce(buildChain({ data: [mockField], error: null })); // insert
      const r = await service.setCardFields(BOARD, ORG, {
        fields: [{ custom_field_id: 'field-1', position: 0 } as never],
      });
      expect(r.success).toBe(true);
      expect(r.data).toHaveLength(1);
    });

    it('applies default width=auto when not specified', async () => {
      const insertChain = buildChain({ data: [mockField], error: null });
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(insertChain);
      await service.setCardFields(BOARD, ORG, {
        fields: [{ custom_field_id: 'field-1', position: 0 } as never],
      });
      const insertedRows = (
        (insertChain.insert as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0] as Record<string, unknown>[];
      expect(insertedRows[0].width).toBe('auto');
      expect(insertedRows[0].color).toBeNull();
    });

    it('throws BadRequest when delete step fails', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null }))
        .mockReturnValueOnce(
          buildChain({ data: null, error: { message: 'fk' } }),
        );
      await expect(
        service.setCardFields(BOARD, ORG, {
          fields: [{ custom_field_id: 'f', position: 0 } as never],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequest when insert step fails', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: BOARD }, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(
          buildChain({ data: null, error: { message: 'fk' } }),
        );
      await expect(
        service.setCardFields(BOARD, ORG, {
          fields: [{ custom_field_id: 'f', position: 0 } as never],
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
