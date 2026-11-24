import { FileExplorerController } from './file-explorer.controller';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { SPACE_PERMISSION_KEY } from '../auth/decorators/require-space-permission.decorator';

describe('FileExplorerController', () => {
  const user = {
    authUserId: 'auth-user-1',
    userId: 'user-1',
    email: 'user@example.com',
    organizationId: 'org-1',
    memberships: [],
  } satisfies RequestUser;

  it('delegates space-scoped soft delete to the service with the expected space', async () => {
    const service = {
      getPreviewInfo: jest.fn().mockResolvedValue({ url: 'signed-url' }),
      rename: jest.fn().mockResolvedValue({ id: 'node-1' }),
      softDelete: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new FileExplorerController(service as never);

    await controller.softDelete(user, 'space-1', 'node-1');

    expect(service.softDelete).toHaveBeenCalledWith(user, 'node-1', 'space-1');
  });

  it('delegates space-scoped preview URL lookup to the service with the expected space', async () => {
    const service = {
      getPreviewInfo: jest.fn().mockResolvedValue({ url: 'signed-url' }),
      rename: jest.fn().mockResolvedValue({ id: 'node-1' }),
      softDelete: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new FileExplorerController(service as never);

    const result = await controller.previewUrl(user, 'space-1', 'node-1');

    expect(result).toEqual({ url: 'signed-url' });
    expect(service.getPreviewInfo).toHaveBeenCalledWith(
      user,
      'node-1',
      'space-1',
    );
  });

  it('delegates space-scoped rename to the service with the expected space', async () => {
    const dto = { name: 'Renamed.pdf' };
    const service = {
      getPreviewInfo: jest.fn().mockResolvedValue({ url: 'signed-url' }),
      rename: jest.fn().mockResolvedValue({ id: 'node-1' }),
      softDelete: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new FileExplorerController(service as never);

    await controller.rename(user, 'space-1', 'node-1', dto);

    expect(service.rename).toHaveBeenCalledWith(user, 'node-1', dto, 'space-1');
  });

  it('requires delete_file_explorer permission for space-scoped soft delete', () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      FileExplorerController.prototype,
      'softDelete',
    );

    expect(
      Reflect.getMetadata(SPACE_PERMISSION_KEY, descriptor?.value as object),
    ).toBe('delete_file_explorer');
  });

  it('requires view_file_explorer permission for space-scoped preview URL lookup', () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      FileExplorerController.prototype,
      'previewUrl',
    );

    expect(
      Reflect.getMetadata(SPACE_PERMISSION_KEY, descriptor?.value as object),
    ).toBe('view_file_explorer');
  });

  it('requires create_file_explorer permission for space-scoped rename', () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      FileExplorerController.prototype,
      'rename',
    );

    expect(
      Reflect.getMetadata(SPACE_PERMISSION_KEY, descriptor?.value as object),
    ).toBe('create_file_explorer');
  });

  it('delegates direct-upload init to the service with the expected space', async () => {
    const service = {
      initDirectUpload: jest.fn().mockResolvedValue({ signedUrl: 'https://s' }),
    };
    const controller = new FileExplorerController(service as never);
    const dto = { name: 'big.zip', size: 5_000_000 };

    await controller.initUpload(user, 'space-1', dto as never);

    expect(service.initDirectUpload).toHaveBeenCalledWith(user, 'space-1', dto);
  });

  // The direct-upload path bypasses Multer entirely, so it must carry the SAME write permission as
  // the proxied upload it replaces — otherwise it is a hole around `create_file_explorer`.
  it('requires create_file_explorer permission for direct-upload init', () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      FileExplorerController.prototype,
      'initUpload',
    );

    expect(
      Reflect.getMetadata(SPACE_PERMISSION_KEY, descriptor?.value as object),
    ).toBe('create_file_explorer');
  });
});
