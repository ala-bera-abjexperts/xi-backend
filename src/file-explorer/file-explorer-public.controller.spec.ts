import { HttpStatus } from '@nestjs/common';
import { FileExplorerPublicController } from './file-explorer-public.controller';

describe('FileExplorerPublicController', () => {
  let service: {
    getPublicShareAccessCookieName: jest.Mock;
    verifyPublicPassword: jest.Mock;
    getPublicPreviewUrl: jest.Mock;
    getPublicFolderContents: jest.Mock;
    getPublicDownloadInfo: jest.Mock;
  };
  let archive: {
    streamZip: jest.Mock;
  };
  let configService: {
    get: jest.Mock;
  };
  let controller: FileExplorerPublicController;

  function response() {
    return {
      cookie: jest.fn(),
      redirect: jest.fn(),
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };
  }

  beforeEach(() => {
    service = {
      getPublicShareAccessCookieName: jest
        .fn()
        .mockReturnValue('fe_share_cookie'),
      verifyPublicPassword: jest.fn(),
      getPublicPreviewUrl: jest.fn(),
      getPublicFolderContents: jest.fn(),
      getPublicDownloadInfo: jest.fn(),
    };
    archive = {
      streamZip: jest.fn().mockResolvedValue(undefined),
    };
    configService = {
      get: jest.fn((key: string) => {
        const values: Record<string, unknown> = {
          'cookies.domain': '.xisuite.cloud',
          'cookies.secure': true,
          'cookies.sameSite': 'none',
        };

        return values[key];
      }),
    };
    controller = new FileExplorerPublicController(
      service as never,
      archive as never,
      configService as never,
    );
  });

  it('sets the protected-share access cookie after password verification', async () => {
    const res = response();

    service.verifyPublicPassword.mockResolvedValue({
      valid: true,
      accessCookie: {
        name: 'fe_share_cookie',
        value: 'signed-cookie',
        maxAgeSeconds: 1800,
      },
    });

    await expect(
      controller.verifyPassword(
        'token-1',
        { password: 'secret' },
        res as never,
      ),
    ).resolves.toEqual({ valid: true });
    expect(res.cookie).toHaveBeenCalledWith(
      'fe_share_cookie',
      'signed-cookie',
      {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        path: '/api/v1/public/file-explorer',
        maxAge: 1800 * 1000,
        domain: '.xisuite.cloud',
      },
    );
  });

  it('passes the protected-share cookie to preview requests', async () => {
    service.getPublicPreviewUrl.mockResolvedValue({
      url: 'https://storage.test/view',
    });

    await expect(
      controller.getPublicPreview('token-1', {
        cookies: { fe_share_cookie: 'signed-cookie' },
      } as never),
    ).resolves.toEqual({ url: 'https://storage.test/view' });
    expect(service.getPublicShareAccessCookieName).toHaveBeenCalledWith(
      'token-1',
    );
    expect(service.getPublicPreviewUrl).toHaveBeenCalledWith(
      'token-1',
      'signed-cookie',
    );
  });

  it('passes the protected-share cookie to folder contents requests', async () => {
    service.getPublicFolderContents.mockResolvedValue({
      root: {
        id: 'folder-1',
        name: 'Shared Folder',
        nodeType: 'folder',
        mimeType: null,
        fileSize: null,
        updatedAt: '2026-01-01T00:00:00Z',
      },
      items: [],
      totalItems: 0,
      totalFiles: 0,
      totalFolders: 0,
      totalBytes: 0,
    });

    await expect(
      controller.getPublicFolderContents('token-1', {
        cookies: { fe_share_cookie: 'signed-cookie' },
      } as never),
    ).resolves.toEqual({
      root: {
        id: 'folder-1',
        name: 'Shared Folder',
        nodeType: 'folder',
        mimeType: null,
        fileSize: null,
        updatedAt: '2026-01-01T00:00:00Z',
      },
      items: [],
      totalItems: 0,
      totalFiles: 0,
      totalFolders: 0,
      totalBytes: 0,
    });
    expect(service.getPublicShareAccessCookieName).toHaveBeenCalledWith(
      'token-1',
    );
    expect(service.getPublicFolderContents).toHaveBeenCalledWith(
      'token-1',
      'signed-cookie',
    );
  });

  it('keeps file public downloads as 302 redirects', async () => {
    const res = response();

    service.getPublicDownloadInfo.mockResolvedValue({
      type: 'file',
      signedUrl: 'https://storage.test/signed',
    });

    await controller.download(
      'token-1',
      undefined,
      { cookies: {} } as never,
      res as never,
    );

    expect(service.getPublicDownloadInfo).toHaveBeenCalledWith(
      'token-1',
      undefined,
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

  it('streams public folder downloads as ZIP archives', async () => {
    const res = response();
    const entries = [
      {
        archivePath: 'Readme.txt',
        storagePath: 'files/readme.txt',
        size: 12,
      },
    ];

    service.getPublicDownloadInfo.mockResolvedValue({
      type: 'zip',
      fileName: 'Anleitungen.zip',
      entries,
      totalBytes: 12,
    });

    await controller.download(
      'token-1',
      undefined,
      { cookies: { fe_share_cookie: 'signed-cookie' } } as never,
      res as never,
    );

    expect(service.getPublicDownloadInfo).toHaveBeenCalledWith(
      'token-1',
      undefined,
      'signed-cookie',
    );
    expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'application/zip',
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="Anleitungen.zip"; filename*=UTF-8\'\'Anleitungen.zip',
    );
    expect(archive.streamZip).toHaveBeenCalledWith(entries, res);
    expect(res.redirect).not.toHaveBeenCalled();
  });
});
