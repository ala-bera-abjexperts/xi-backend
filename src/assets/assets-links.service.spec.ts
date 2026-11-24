/**
 * @fileoverview Unit tests for AssetsLinksService — bidirectional listing
 * (source OR target), self-link guard, and id-scoped delete with NotFound.
 * @module src/assets/assets-links.service.spec
 * @author Prince Jadiya
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AssetsLinksService } from './assets-links.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('AssetsLinksService', () => {
  let service: AssetsLinksService;
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
    mockFrom = jest.fn();
    const supa = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;
    service = new AssetsLinksService(supa);
  });

  // ── getAll ─────────────────────────────────────────────────────────────

  describe('getAll', () => {
    it('returns rows where the item is either source or target', async () => {
      const chain = buildChain({
        data: [{ id: 'l-1', source_id: ITEM, target_id: 'other' }],
        error: null,
      });
      mockFrom.mockReturnValueOnce(chain);

      const r = await service.getAll(ITEM, ORG);

      expect(r.data).toHaveLength(1);
      expect(r.count).toBe(1);
      expect(chain.or).toHaveBeenCalledWith(
        `source_id.eq.${ITEM},target_id.eq.${ITEM}`,
      );
    });

    it('throws BadRequest when DB errors', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: null, error: { message: 'boom' } }),
      );
      await expect(service.getAll(ITEM, ORG)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── create ─────────────────────────────────────────────────────────────

  describe('create', () => {
    it('inserts a link with the supplied target', async () => {
      const created = {
        id: 'l-1',
        source_id: ITEM,
        target_id: 'other-item',
        target_type: 'asset_item',
        link_type: 'related',
      };
      mockFrom.mockReturnValueOnce(buildChain({ data: created, error: null }));

      const r = await service.create(ITEM, ORG, USER, {
        target_type: 'asset_item',
        target_id: 'other-item',
      } as never);
      expect(r['id']).toBe('l-1');
    });

    it('rejects self-linking when target_type=asset_item and ids match', async () => {
      await expect(
        service.create(ITEM, ORG, USER, {
          target_type: 'asset_item',
          target_id: ITEM,
        } as never),
      ).rejects.toThrow(/itself/);
    });

    it('defaults link_type to "related" when not provided', async () => {
      const insertChain = buildChain({
        data: { id: 'l-1' },
        error: null,
      });
      mockFrom.mockReturnValueOnce(insertChain);
      await service.create(ITEM, ORG, USER, {
        target_type: 'asset_item',
        target_id: 'other',
      } as never);
      const inserted = (
        (insertChain.insert as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0] as { link_type: string };
      expect(inserted.link_type).toBe('related');
    });

    it('throws BadRequest when insert fails', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: null, error: { message: 'fk fail' } }),
      );
      await expect(
        service.create(ITEM, ORG, USER, {
          target_type: 'asset_item',
          target_id: 'other',
        } as never),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── delete ─────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('removes the link when found', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: 'l-1' }, error: null })) // existence
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // delete
      const r = await service.delete('l-1', ORG);
      expect(r).toEqual({ success: true, message: 'Link deleted' });
    });

    it('throws NotFound when link does not exist', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(service.delete('missing', ORG)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws BadRequest when delete errors', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: 'l-1' }, error: null }))
        .mockReturnValueOnce(
          buildChain({ data: null, error: { message: 'fail' } }),
        );
      await expect(service.delete('l-1', ORG)).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
