/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- test doubles are typed as `any`; the type-checked unsafe rules add no value in mock assertions */
import { UPLOAD_LIMITS } from '../common/upload-limits';
import { BadRequestException } from '@nestjs/common';
import { FormBuilderUploadsService } from './form-builder-uploads.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

const BUCKET = 'form_builder_submission_attachments';

describe('FormBuilderUploadsService', () => {
  let service: FormBuilderUploadsService;
  let storageFrom: jest.Mock;
  let mockUpload: jest.Mock;
  let mockRemove: jest.Mock;
  let mockGetPublicUrl: jest.Mock;

  const SPACE = 'space-1';
  const FORM = 'form-1';
  const FIELD = 'field-1';

  function makeFile(
    overrides: Partial<Express.Multer.File> = {},
  ): Express.Multer.File {
    return {
      buffer: Buffer.from('hello'),
      originalname: 'photo.png',
      mimetype: 'image/png',
      size: 1024,
      ...overrides,
    } as unknown as Express.Multer.File;
  }

  beforeEach(() => {
    mockUpload = jest
      .fn()
      .mockResolvedValue({ data: { path: 'stored/path.png' }, error: null });
    mockRemove = jest.fn().mockResolvedValue({ error: null });
    mockGetPublicUrl = jest.fn().mockReturnValue({
      data: { publicUrl: 'https://cdn.test/stored/path.png' },
    });
    storageFrom = jest.fn().mockReturnValue({
      upload: mockUpload,
      remove: mockRemove,
      getPublicUrl: mockGetPublicUrl,
    });

    const supabase = {
      getClient: () => ({
        storage: { from: storageFrom },
      }),
    } as unknown as SupabaseAdminService;

    service = new FormBuilderUploadsService(supabase);
  });

  // ── upload ───────────────────────────────────────────────────────────────

  describe('upload', () => {
    it('uploads to the submission bucket and returns public url + storage path', async () => {
      const result = await service.upload(SPACE, FORM, FIELD, makeFile());

      expect(result).toEqual({
        publicUrl: 'https://cdn.test/stored/path.png',
        path: 'stored/path.png',
      });
      expect(storageFrom).toHaveBeenCalledWith(BUCKET);

      const [storagePath, buffer, opts] = mockUpload.mock.calls[0];

      expect(storagePath).toEqual(
        expect.stringContaining(`${SPACE}/${FORM}/${FIELD}/`),
      );
      expect(buffer).toBeInstanceOf(Buffer);
      expect(opts).toEqual({ contentType: 'image/png', upsert: false });
      expect(mockGetPublicUrl).toHaveBeenCalledWith('stored/path.png');
    });

    it('sanitizes the original filename in the storage path', async () => {
      await service.upload(
        SPACE,
        FORM,
        FIELD,
        makeFile({ originalname: 'my file (v2)!.png' }),
      );

      const [storagePath] = mockUpload.mock.calls[0];

      // storageSafeFileName trims trailing separators from the base: no dangling '_'.
      expect(storagePath).toEqual(expect.stringContaining('my_file_v2.png'));
    });

    it('falls back to application/octet-stream when mimetype is missing', async () => {
      await service.upload(
        SPACE,
        FORM,
        FIELD,
        makeFile({ mimetype: '' as unknown as string }),
      );

      const [, , opts] = mockUpload.mock.calls[0];

      expect(opts.contentType).toBe('application/octet-stream');
    });

    it('rejects files over the attachment limit without touching storage', async () => {
      const big = makeFile({ size: UPLOAD_LIMITS.ATTACHMENT + 1 });

      await expect(service.upload(SPACE, FORM, FIELD, big)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.upload(SPACE, FORM, FIELD, big)).rejects.toThrow(
        /File exceeds the maximum allowed size/,
      );
      expect(mockUpload).not.toHaveBeenCalled();
    });

    it('throws BadRequest when storage upload fails', async () => {
      mockUpload.mockResolvedValueOnce({
        data: null,
        error: { message: 'bucket offline' },
      });

      await expect(
        service.upload(SPACE, FORM, FIELD, makeFile()),
      ).rejects.toThrow(/Upload failed: bucket offline/);
      expect(mockGetPublicUrl).not.toHaveBeenCalled();
    });
  });

  // ── uploadDesignAsset ──────────────────────────────────────────────────────

  describe('uploadDesignAsset', () => {
    it('uploads into the /design/ path and returns url + path', async () => {
      const result = await service.uploadDesignAsset(SPACE, FORM, makeFile());

      expect(result).toEqual({
        publicUrl: 'https://cdn.test/stored/path.png',
        path: 'stored/path.png',
      });

      const [storagePath] = mockUpload.mock.calls[0];

      expect(storagePath).toEqual(
        expect.stringContaining(`${SPACE}/${FORM}/design/`),
      );
    });

    it('rejects oversized design assets', async () => {
      await expect(
        service.uploadDesignAsset(
          SPACE,
          FORM,
          makeFile({ size: UPLOAD_LIMITS.ATTACHMENT + 1 }),
        ),
      ).rejects.toThrow(/File exceeds the maximum allowed size/);
      expect(mockUpload).not.toHaveBeenCalled();
    });

    it('throws BadRequest when the design upload fails', async () => {
      mockUpload.mockResolvedValueOnce({
        data: null,
        error: { message: 'denied' },
      });

      await expect(
        service.uploadDesignAsset(SPACE, FORM, makeFile()),
      ).rejects.toThrow(/Upload failed: denied/);
    });
  });

  // ── remove ─────────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('removes the object from the bucket and returns success', async () => {
      const result = await service.remove('space-1/form-1/field-1/file.png');

      expect(storageFrom).toHaveBeenCalledWith(BUCKET);
      expect(mockRemove).toHaveBeenCalledWith([
        'space-1/form-1/field-1/file.png',
      ]);
      expect(result).toEqual({ success: true });
    });

    it('throws BadRequest when storage removal fails', async () => {
      mockRemove.mockResolvedValueOnce({ error: { message: 'not found' } });

      await expect(service.remove('missing/file.png')).rejects.toThrow(
        /Delete failed: not found/,
      );
    });
  });
});
