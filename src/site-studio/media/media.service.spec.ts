import { MediaService } from './media.service';

function createQuery(result: { data?: unknown; error?: unknown }) {
  const query: Record<string, jest.Mock> = {
    select: jest.fn(() => query),
    eq: jest.fn(() => query),
    maybeSingle: jest.fn(() => Promise.resolve(result)),
  };

  return query;
}

describe('MediaService', () => {
  it('uses the funnel id as the UUID audit target for media uploads', async () => {
    const upload = jest.fn().mockResolvedValue({ error: null });
    const getPublicUrl = jest.fn().mockReturnValue({
      data: { publicUrl: 'https://assets.example/hero.png' },
    });
    const client = {
      from: jest
        .fn()
        .mockReturnValue(
          createQuery({ data: { id: 'funnel-1' }, error: null }),
        ),
      storage: {
        from: jest.fn().mockReturnValue({
          upload,
          getPublicUrl,
        }),
      },
    };
    const auditLogsService = {
      logAction: jest.fn().mockResolvedValue(undefined),
    };
    const service = new MediaService(
      { getClient: () => client } as never,
      auditLogsService as never,
    );

    await service.uploadFile('funnel-1', 'org-1', 'user-1', {
      originalname: 'hero image.png',
      mimetype: 'image/png',
      size: 1234,
      buffer: Buffer.from('image'),
    } as Express.Multer.File);

    expect(auditLogsService.logAction).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      'site_studio_media',
      'funnel-1',
      'create',
      expect.objectContaining({
        file_name: expect.stringContaining('hero_image.png') as unknown,
        file_path: expect.stringContaining('/funnel-1/') as unknown,
      }),
    );
  });
});
