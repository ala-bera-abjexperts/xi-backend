/**
 * @fileoverview Unit tests for AssetsAttachmentsService — list join, upload
 * with size + mime validation and DB insert + history side-effect, signed
 * URL generation with NotFound, delete with storage cleanup + history
 * side-effect (always swallowed when history fails).
 * @module src/assets/assets-attachments.service.spec
 * @author Prince Jadiya
 */

import { UPLOAD_LIMITS } from '../common/upload-limits';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AssetsAttachmentsService } from './assets-attachments.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AssetsHistoryService } from './assets-history.service';

describe('AssetsAttachmentsService', () => {
  let service: AssetsAttachmentsService;
  let mockFrom: jest.Mock;
  let mockStorageFrom: jest.Mock;
  let mockUpload: jest.Mock;
  let mockRemove: jest.Mock;
  let mockCreateSignedUrl: jest.Mock;
  let mockLogChange: jest.Mock;

  const ITEM = 'item-1';
  const SCHEMA = 'schema-1';
  const ORG = 'org-1';
  const USER = 'user-1';

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
    mockUpload = jest.fn().mockResolvedValue({ error: null });
    mockRemove = jest.fn().mockResolvedValue({ error: null });
    mockCreateSignedUrl = jest
      .fn()
      .mockResolvedValue({ data: { signedUrl: 'https://signed.test/url' } });
    mockStorageFrom = jest.fn().mockReturnValue({
      upload: mockUpload,
      remove: mockRemove,
      createSignedUrl: mockCreateSignedUrl,
    });
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
    service = new AssetsAttachmentsService(supa, history);
  });

  // ── getAll ─────────────────────────────────────────────────────────────

  describe('getAll', () => {
    it('returns attachments for the item', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: [{ id: 'att-1', file_name: 'doc.pdf' }],
          error: null,
        }),
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

  // ── upload ─────────────────────────────────────────────────────────────

  describe('upload', () => {
    const validFile = {
      buffer: Buffer.from('data'),
      originalname: 'doc.pdf',
      mimetype: 'application/pdf',
      size: 1024,
    } as unknown as Express.Multer.File;

    it('rejects when no file is provided', async () => {
      await expect(
        service.upload(
          ITEM,
          SCHEMA,
          ORG,
          USER,
          undefined as unknown as Express.Multer.File,
        ),
      ).rejects.toThrow(/File is required/);
    });

    it('rejects files exceeding the attachment limit', async () => {
      const big = {
        ...validFile,
        size: UPLOAD_LIMITS.ATTACHMENT + 1,
      } as unknown as Express.Multer.File;
      await expect(
        service.upload(ITEM, SCHEMA, ORG, USER, big),
      ).rejects.toThrow(/maximum allowed size of/);
    });

    // Attachments intentionally accept EVERY mime type — the size cap is the only control. This
    // asserts the absence of a type gate so a future allow-list cannot be reintroduced silently.
    it('accepts an arbitrary mime type', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { id: 'att-1' }, error: null }),
      );
      const unusual = {
        ...validFile,
        mimetype: 'application/x-7z-compressed',
      } as unknown as Express.Multer.File;
      await expect(
        service.upload(ITEM, SCHEMA, ORG, USER, unusual),
      ).resolves.toBeDefined();
    });

    it('uploads file, inserts metadata row, and logs history', async () => {
      const inserted = {
        id: 'att-1',
        file_name: 'doc.pdf',
        file_path: 'org/item/file',
      };
      mockFrom.mockReturnValueOnce(buildChain({ data: inserted, error: null }));

      const r = await service.upload(ITEM, SCHEMA, ORG, USER, validFile);
      expect(r.success).toBe(true);
      expect(mockUpload).toHaveBeenCalled();
      expect(mockLogChange).toHaveBeenCalled();
    });

    it('throws when storage upload fails (no DB insert)', async () => {
      mockUpload.mockResolvedValueOnce({ error: { message: 'storage down' } });
      await expect(
        service.upload(ITEM, SCHEMA, ORG, USER, validFile),
      ).rejects.toThrow(/Upload failed/);
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('throws BadRequest when DB insert fails', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: null, error: { message: 'fk fail' } }),
      );
      await expect(
        service.upload(ITEM, SCHEMA, ORG, USER, validFile),
      ).rejects.toThrow(BadRequestException);
    });

    it('swallows history logger errors so the main flow succeeds', async () => {
      mockLogChange.mockRejectedValueOnce(new Error('history down'));
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { id: 'att-1' }, error: null }),
      );
      await expect(
        service.upload(ITEM, SCHEMA, ORG, USER, validFile),
      ).resolves.toBeDefined();
    });
  });

  // ── getSignedUrl ───────────────────────────────────────────────────────

  describe('getSignedUrl', () => {
    it('returns the signed URL when attachment exists', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { file_path: 'p/file' }, error: null }),
      );
      const r = await service.getSignedUrl('att-1', ITEM, ORG);
      expect(r.data.url).toBe('https://signed.test/url');
    });

    it('throws NotFound when attachment is missing', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(service.getSignedUrl('missing', ITEM, ORG)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws BadRequest when storage signing fails', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { file_path: 'p/file' }, error: null }),
      );
      mockCreateSignedUrl.mockResolvedValueOnce({
        data: null,
        error: { message: 'sign fail' },
      });
      await expect(service.getSignedUrl('att-1', ITEM, ORG)).rejects.toThrow(
        /Failed to generate download URL/,
      );
    });
  });

  // ── delete ─────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('removes the storage object, the row, and logs history', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: { file_path: 'p/file', file_name: 'doc.pdf' },
            error: null,
          }),
        ) // existence
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // delete

      const r = await service.delete('att-1', ITEM, SCHEMA, ORG, USER);
      expect(r.success).toBe(true);
      expect(mockRemove).toHaveBeenCalledWith(['p/file']);
      expect(mockLogChange).toHaveBeenCalled();
    });

    it('throws NotFound when attachment does not exist', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.delete('missing', ITEM, SCHEMA, ORG, USER),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequest when DB delete errors', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: { file_path: 'p/file', file_name: 'doc.pdf' },
            error: null,
          }),
        )
        .mockReturnValueOnce(
          buildChain({ data: null, error: { message: 'fk fail' } }),
        );
      await expect(
        service.delete('att-1', ITEM, SCHEMA, ORG, USER),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
