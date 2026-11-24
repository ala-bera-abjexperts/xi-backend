import { HttpStatus } from '@nestjs/common';
import { FileExplorerNodeController } from './file-explorer-node.controller';
import type { RequestUser } from '../auth/interfaces/request-user.interface';

describe('FileExplorerNodeController downloads', () => {
  const user = {
    authUserId: 'auth-user-1',
    userId: 'user-1',
    email: 'user@example.com',
    organizationId: 'org-1',
    memberships: [],
  } satisfies RequestUser;

  let service: {
    getDownloadInfo: jest.Mock;
  };
  let archive: {
    streamZip: jest.Mock;
  };
  let controller: FileExplorerNodeController;

  function response() {
    return {
      redirect: jest.fn(),
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };
  }

  beforeEach(() => {
    service = {
      getDownloadInfo: jest.fn(),
    };
    archive = {
      streamZip: jest.fn().mockResolvedValue(undefined),
    };
    controller = new FileExplorerNodeController(
      service as never,
      archive as never,
    );
  });

  it('keeps file downloads as 302 redirects', async () => {
    const res = response();

    service.getDownloadInfo.mockResolvedValue({
      type: 'file',
      signedUrl: 'https://storage.test/signed',
    });

    await controller.download(user, 'node-1', undefined, res as never);

    expect(service.getDownloadInfo).toHaveBeenCalledWith(
      user,
      'node-1',
      undefined,
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store, private',
    );
    expect(res.redirect).toHaveBeenCalledWith(
      HttpStatus.FOUND,
      'https://storage.test/signed',
    );
    expect(archive.streamZip).not.toHaveBeenCalled();
  });

  it('streams folder downloads as ZIP archives', async () => {
    const res = response();
    const entries = [
      {
        archivePath: 'Readme.txt',
        storagePath: 'files/readme.txt',
        size: 12,
      },
    ];

    service.getDownloadInfo.mockResolvedValue({
      type: 'zip',
      fileName: 'Client Docs.zip',
      entries,
      totalBytes: 12,
    });

    await controller.download(user, 'folder-1', undefined, res as never);

    expect(service.getDownloadInfo).toHaveBeenCalledWith(
      user,
      'folder-1',
      undefined,
    );
    expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'application/zip',
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="Client Docs.zip"; filename*=UTF-8\'\'Client%20Docs.zip',
    );
    expect(archive.streamZip).toHaveBeenCalledWith(entries, res);
    expect(res.redirect).not.toHaveBeenCalled();
  });
});
