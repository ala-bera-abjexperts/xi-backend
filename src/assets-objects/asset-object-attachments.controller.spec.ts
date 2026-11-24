/**
 * @fileoverview Smoke tests for AssetObjectAttachmentsController.
 * @module src/assets-objects/asset-object-attachments.controller.spec
 */
import { AssetObjectAttachmentsController } from './asset-object-attachments.controller';

const mockUser = { userId: 'user-1', organizationId: 'org-1' };

const mockAttachment = {
  id: 'att-1',
  object_id: 'obj-1',
  schema_id: 'schema-1',
  file_name: 'rack-photo.jpg',
  file_size: 102400,
  mime_type: 'image/jpeg',
  storage_path: 'asset-object-attachments/org-1/att-1',
  created_by: 'user-1',
  created_at: '',
};

const mockFile = {
  originalname: 'rack-photo.jpg',
  size: 102400,
  mimetype: 'image/jpeg',
  buffer: Buffer.from(''),
} as Express.Multer.File;

function createController() {
  const service = {
    getAll: jest.fn().mockResolvedValue([mockAttachment]),
    upload: jest.fn().mockResolvedValue(mockAttachment),
    getSignedUrl: jest
      .fn()
      .mockResolvedValue({ url: 'https://example.com/signed' }),
    delete: jest.fn().mockResolvedValue(undefined),
  };

  return {
    controller: new AssetObjectAttachmentsController(service as never),
    service,
  };
}

describe('AssetObjectAttachmentsController', () => {
  it('getAll() returns attachments list', async () => {
    const { controller } = createController();
    const result = await controller.getAll(
      'space-1',
      'obj-1',
      mockUser as never,
    );

    expect(result).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(result[0].file_name).toBe('rack-photo.jpg');
  });

  it('upload() delegates with correct args', async () => {
    const { controller, service } = createController();
    const result = await controller.upload(
      'space-1',
      'obj-1',
      'schema-1',
      mockFile,
      mockUser as never,
    );

    expect(result.id).toBe('att-1');
    expect(service.upload).toHaveBeenCalledWith(
      'obj-1',
      'schema-1',
      'space-1',
      'org-1',
      'user-1',
      mockFile,
    );
  });

  it('getSignedUrl() returns signed URL from service', async () => {
    const { controller, service } = createController();
    const result = await controller.getSignedUrl(
      'space-1',
      'obj-1',
      'att-1',
      mockUser as never,
    );

    expect(result.url).toBe('https://example.com/signed');
    expect(service.getSignedUrl).toHaveBeenCalledWith(
      'att-1',
      'obj-1',
      'space-1',
      'org-1',
    );
  });

  it('delete() delegates with correct args', async () => {
    const { controller, service } = createController();
    await controller.delete('space-1', 'obj-1', 'att-1', mockUser as never);

    expect(service.delete).toHaveBeenCalledWith(
      'att-1',
      'obj-1',
      'space-1',
      'org-1',
      'user-1',
    );
  });

  it('upload() propagates file-too-large errors', async () => {
    const { controller, service } = createController();
    service.upload.mockRejectedValue(new Error('File exceeds 50 MB limit'));

    await expect(
      controller.upload(
        'space-1',
        'obj-1',
        'schema-1',
        mockFile,
        mockUser as never,
      ),
    ).rejects.toThrow('File exceeds 50 MB limit');
  });

  it('delete() propagates not-found errors', async () => {
    const { controller, service } = createController();
    service.delete.mockRejectedValue(new Error('Attachment not found'));

    await expect(
      controller.delete('space-1', 'obj-1', 'att-99', mockUser as never),
    ).rejects.toThrow('Attachment not found');
  });
});
