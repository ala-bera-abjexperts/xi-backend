import { MediaController } from './media.controller';
import { PERMISSIONS_KEY } from '../../auth/decorators/require-permissions.decorator';

const user = {
  userId: 'user-1',
  organizationId: 'org-1',
};

const file = {
  originalname: 'hero.png',
  mimetype: 'image/png',
  size: 1234,
  buffer: Buffer.from('image'),
} as Express.Multer.File;

describe('MediaController', () => {
  let service: Record<string, jest.Mock>;
  let controller: MediaController;

  beforeEach(() => {
    service = {
      listFiles: jest.fn().mockResolvedValue([{ name: 'hero.png' }]),
      uploadFile: jest
        .fn()
        .mockResolvedValue({ url: 'https://example.test/hero.png' }),
      deleteFile: jest.fn().mockResolvedValue(undefined),
    };
    controller = new MediaController(service as any);
  });

  it('wraps media file lists in a data envelope', async () => {
    await expect(
      controller.listFiles(user as any, 'funnel-1'),
    ).resolves.toEqual({
      data: [{ name: 'hero.png' }],
    });
    expect(service.listFiles).toHaveBeenCalledWith('funnel-1', 'org-1');
  });

  it('uploads files with funnel and organization scope', async () => {
    await expect(
      controller.uploadFile(user as any, 'funnel-1', file),
    ).resolves.toEqual({ data: { url: 'https://example.test/hero.png' } });
    expect(service.uploadFile).toHaveBeenCalledWith(
      'funnel-1',
      'org-1',
      'user-1',
      file,
    );
  });

  it('returns undefined for no-content delete after delegating', async () => {
    await expect(
      controller.deleteFile(user as any, 'funnel-1', 'hero.png'),
    ).resolves.toBeUndefined();
    expect(service.deleteFile).toHaveBeenCalledWith(
      'funnel-1',
      'org-1',
      'user-1',
      'hero.png',
    );
  });

  it('requires delete permission to remove media files', () => {
    const deleteFile = Object.getOwnPropertyDescriptor(
      MediaController.prototype,
      'deleteFile',
    )?.value as unknown;
    expect(Reflect.getMetadata(PERMISSIONS_KEY, deleteFile)).toEqual({
      permissions: ['can_delete_site_studio'],
      any: false,
    });
  });
});
