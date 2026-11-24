/**
 * @fileoverview Unit tests for AssetsRelationsService — bidirectional listing
 * with embedded item/relation_type joins, self-relation guard, duplicate
 * detection, id-scoped delete with NotFound.
 * @module src/assets/assets-relations.service.spec
 * @author Prince Jadiya
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AssetsRelationsService } from './assets-relations.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('AssetsRelationsService', () => {
  let service: AssetsRelationsService;
  let mockFrom: jest.Mock;

  const ITEM = 'item-1';
  const ORG = 'org-1';
  const USER = 'user-1';

  function buildChain(resolved: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.or = jest.fn().mockImplementation(self);
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
    // The real Supabase client returns a chainable builder from EVERY .from()
    // call, so the mock must too. Tests queue specific results with
    // mockReturnValueOnce; any additional call (e.g. the fire-and-forget
    // `asset_items` lookup that create() makes to emit the automation event)
    // falls through to this default empty-result chain instead of undefined.
    mockFrom = jest.fn(() => buildChain({ data: null, error: null }));
    const supa = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;
    service = new AssetsRelationsService(supa);
  });

  // ── getAll ─────────────────────────────────────────────────────────────

  describe('getAll', () => {
    it('returns relations where the item is source or target', async () => {
      const chain = buildChain({
        data: [{ id: 'r-1', source_item_id: ITEM, target_item_id: 'other' }],
        error: null,
      });
      mockFrom.mockReturnValueOnce(chain);

      const r = await service.getAll(ITEM, ORG);

      expect(r).toHaveLength(1);
      expect(chain.or).toHaveBeenCalledWith(
        `source_item_id.eq.${ITEM},target_item_id.eq.${ITEM}`,
      );
    });

    it('throws BadRequest on DB error', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: null, error: { message: 'fail' } }),
      );
      await expect(service.getAll(ITEM, ORG)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── create ─────────────────────────────────────────────────────────────

  describe('create', () => {
    it('inserts a new relation', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // duplicate check
        .mockReturnValueOnce(
          buildChain({
            data: {
              id: 'r-1',
              source_item_id: ITEM,
              target_item_id: 'other',
              relation_type_id: 'rt-1',
            },
            error: null,
          }),
        );
      const r = await service.create(ITEM, ORG, USER, {
        target_item_id: 'other',
        relation_type_id: 'rt-1',
      } as never);
      expect(r['id']).toBe('r-1');
    });

    it('rejects self-referencing relations', async () => {
      await expect(
        service.create(ITEM, ORG, USER, {
          target_item_id: ITEM,
          relation_type_id: 'rt-1',
        } as never),
      ).rejects.toThrow(/itself/);
    });

    it('rejects duplicate relation', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { id: 'existing' }, error: null }),
      );
      await expect(
        service.create(ITEM, ORG, USER, {
          target_item_id: 'other',
          relation_type_id: 'rt-1',
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
        service.create(ITEM, ORG, USER, {
          target_item_id: 'other',
          relation_type_id: 'rt-1',
        } as never),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── delete ─────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('removes the relation when found', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: 'r-1' }, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null }));
      const r = await service.delete('r-1', ORG);
      expect(r.success).toBe(true);
    });

    it('throws NotFound when relation does not exist', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(service.delete('missing', ORG)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws BadRequest when delete errors', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: 'r-1' }, error: null }))
        .mockReturnValueOnce(
          buildChain({ data: null, error: { message: 'fail' } }),
        );
      await expect(service.delete('r-1', ORG)).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
