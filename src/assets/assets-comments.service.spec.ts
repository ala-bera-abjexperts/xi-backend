/**
 * @fileoverview Unit tests for AssetsCommentsService — list with author join,
 * create with history side-effect, update/delete with author-only enforcement,
 * NotFound on missing comments. The fire-and-forget history logger is mocked
 * so its failures cannot affect the main outcome.
 * @module src/assets/assets-comments.service.spec
 * @author Prince Jadiya
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AssetsCommentsService } from './assets-comments.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AssetsHistoryService } from './assets-history.service';

describe('AssetsCommentsService', () => {
  let service: AssetsCommentsService;
  let mockFrom: jest.Mock;
  let mockLogChange: jest.Mock;

  const ITEM = 'item-1';
  const ORG = 'org-1';
  const USER = 'user-1';
  const COMMENT = 'c-1';

  const mockComment = {
    id: COMMENT,
    item_id: ITEM,
    organization_id: ORG,
    content: 'Hello',
    created_by: USER,
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
    mockLogChange = jest.fn().mockResolvedValue(undefined);
    const supa = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;
    const history = {
      logChange: mockLogChange,
    } as unknown as AssetsHistoryService;
    service = new AssetsCommentsService(supa, history);
  });

  // ── getAll ─────────────────────────────────────────────────────────────

  describe('getAll', () => {
    it('returns comments for the item', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: [mockComment], error: null }),
      );
      const r = await service.getAll(ITEM, ORG);
      expect(r.data).toHaveLength(1);
      expect(r.count).toBe(1);
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
    it('inserts the comment and logs a history entry', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockComment, error: null })) // insert
        .mockReturnValueOnce(
          buildChain({ data: { schema_id: 'schema-1' }, error: null }),
        ); // resolveSchemaId
      const r = await service.create(ITEM, ORG, USER, {
        content: 'Hello',
      } as never);
      expect(r['id']).toBe(COMMENT);
      expect(mockLogChange).toHaveBeenCalledWith(
        ITEM,
        'schema-1',
        ORG,
        'description_update',
        USER,
        expect.objectContaining({
          metadata: { action: 'comment_added' },
        }),
      );
    });

    it('skips history logging when schema cannot be resolved', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockComment, error: null })) // insert
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // schema lookup → null
      await service.create(ITEM, ORG, USER, {
        content: 'Hello',
      } as never);
      expect(mockLogChange).not.toHaveBeenCalled();
    });

    it('swallows history logger errors so the main flow succeeds', async () => {
      mockLogChange.mockRejectedValueOnce(new Error('history down'));
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockComment, error: null }))
        .mockReturnValueOnce(
          buildChain({ data: { schema_id: 'schema-1' }, error: null }),
        );
      await expect(
        service.create(ITEM, ORG, USER, { content: 'Hello' } as never),
      ).resolves.toBeDefined();
    });

    it('throws BadRequest when insert fails', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: null, error: { message: 'fail' } }),
      );
      await expect(
        service.create(ITEM, ORG, USER, { content: 'Hello' } as never),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── update ─────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates the comment when caller is the author', async () => {
      const updated = { ...mockComment, content: 'edited' };
      mockFrom
        .mockReturnValueOnce(
          buildChain({ data: { created_by: USER }, error: null }),
        ) // existence
        .mockReturnValueOnce(buildChain({ data: updated, error: null })) // update
        .mockReturnValueOnce(
          buildChain({ data: { schema_id: 'schema-1' }, error: null }),
        ); // resolveSchemaId
      const r = await service.update(COMMENT, ITEM, ORG, USER, {
        content: 'edited',
      } as never);
      expect((r.data as { content: string }).content).toBe('edited');
    });

    it('rejects non-authors', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { created_by: 'other' }, error: null }),
      );
      await expect(
        service.update(COMMENT, ITEM, ORG, USER, {
          content: 'edited',
        } as never),
      ).rejects.toThrow(/comment author/);
    });

    it('throws NotFound when the comment does not exist', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.update(COMMENT, ITEM, ORG, USER, {
          content: 'edited',
        } as never),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── delete ─────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('deletes the comment when caller is the author', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({ data: { created_by: USER }, error: null }),
        ) // existence
        .mockReturnValueOnce(
          buildChain({ data: { schema_id: 'schema-1' }, error: null }),
        ) // resolveSchemaId
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // delete
      const r = await service.delete(COMMENT, ITEM, ORG, USER);
      expect(r.success).toBe(true);
    });

    it('rejects non-authors', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { created_by: 'other' }, error: null }),
      );
      await expect(service.delete(COMMENT, ITEM, ORG, USER)).rejects.toThrow(
        /comment author/,
      );
    });

    it('throws NotFound when missing', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(service.delete('missing', ITEM, ORG, USER)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
