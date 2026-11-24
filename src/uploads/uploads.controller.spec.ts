import { UPLOAD_LIMITS } from '../common/upload-limits';
import { BadRequestException } from '@nestjs/common';
import { UploadsController } from './uploads.controller';

const user = {
  userId: 'user-1',
};

function file(overrides: Partial<Express.Multer.File> = {}) {
  return {
    originalname: 'my image.png',
    mimetype: 'image/png',
    size: 1024,
    buffer: Buffer.from('image'),
    fieldname: 'file',
    encoding: '7bit',
    destination: '',
    filename: '',
    path: '',
    stream: undefined as unknown as import('stream').Readable,
    ...overrides,
  } as Express.Multer.File;
}

describe('UploadsController', () => {
  let bucket: Record<string, jest.Mock>;
  let supabaseAdmin: Record<string, jest.Mock>;
  let controller: UploadsController;

  beforeEach(() => {
    bucket = {
      upload: jest.fn().mockResolvedValue({ data: {}, error: null }),
      getPublicUrl: jest.fn().mockReturnValue({
        data: { publicUrl: 'https://example.test/image.png' },
      }),
    };
    supabaseAdmin = {
      getClient: jest.fn().mockReturnValue({
        storage: {
          from: jest.fn().mockReturnValue(bucket),
        },
      }),
    };
    controller = new UploadsController(supabaseAdmin as any);
    jest.spyOn(Date, 'now').mockReturnValue(1234567890);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uploads valid editor images and returns public URL metadata', async () => {
    await expect(controller.uploadImage(user as any, file())).resolves.toEqual({
      url: 'https://example.test/image.png',
      fileName: 'my image.png',
      fileSize: 1024,
      fileType: 'image/png',
    });

    expect(bucket.upload).toHaveBeenCalledWith(
      'editor-images/user-1/1234567890-my_image.png',
      Buffer.from('image'),
      { contentType: 'image/png', upsert: false },
    );
    expect(bucket.getPublicUrl).toHaveBeenCalledWith(
      'editor-images/user-1/1234567890-my_image.png',
    );
  });

  it('rejects missing, oversized, and unsupported files before storage access', async () => {
    await expect(
      controller.uploadImage(user as any, undefined as any),
    ).rejects.toThrow(BadRequestException);
    await expect(
      controller.uploadImage(
        user as any,
        file({ size: UPLOAD_LIMITS.CONTENT_IMAGE + 1 }),
      ),
    ).rejects.toThrow('Image exceeds maximum size of');
    await expect(
      controller.uploadImage(user as any, file({ mimetype: 'text/plain' })),
    ).rejects.toThrow('is not allowed');
  });

  it('propagates storage failures as bad requests', async () => {
    bucket.upload.mockResolvedValueOnce({
      data: null,
      error: { message: 'bucket denied' },
    });

    await expect(controller.uploadImage(user as any, file())).rejects.toThrow(
      'Storage upload failed: bucket denied',
    );
  });
});
