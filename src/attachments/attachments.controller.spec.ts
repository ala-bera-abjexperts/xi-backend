import { BadRequestException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { AttachmentsController } from './attachments.controller';

describe('AttachmentsController download', () => {
  const user = {
    authUserId: 'auth-user-1',
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'user@example.com',
    memberships: [],
  } as RequestUser;
  const attachmentId = '9cf82c81-e12a-4bea-aec7-fdcb7e4fb381';

  function setup() {
    const getDownloadInfo = jest.fn().mockResolvedValue({
      signedUrl: 'https://signed.example/image.png',
      fileName: 'image.png',
      mimeType: 'image/png',
      versionNumber: 1,
    });
    const service = {
      getDownloadInfo,
    };
    const controller = new AttachmentsController(service as never, {} as never);
    const setHeader = jest.fn();
    const redirect = jest.fn();
    const response = {
      setHeader,
      redirect,
    } as unknown as Response;

    return { controller, getDownloadInfo, redirect, response, setHeader };
  }

  async function callDownload(
    controller: AttachmentsController,
    version: string | undefined,
    inline: string | undefined,
    response: Response,
  ) {
    return (
      controller.download as unknown as (
        user: RequestUser,
        id: string,
        version: string | undefined,
        inline: string | undefined,
        response: Response,
      ) => Promise<void>
    )(user, attachmentId, version, inline, response);
  }

  it('requests an inline version and sets the route-specific resource policy', async () => {
    const { controller, getDownloadInfo, redirect, response, setHeader } =
      setup();

    await callDownload(controller, '2', '1', response);

    expect(getDownloadInfo).toHaveBeenCalledWith({
      attachmentId,
      versionNumber: 2,
      inline: true,
      user,
    });
    expect(setHeader).toHaveBeenCalledWith(
      'Cross-Origin-Resource-Policy',
      'cross-origin',
    );
    expect(setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store, private',
    );
    expect(redirect).toHaveBeenCalledWith(
      HttpStatus.FOUND,
      'https://signed.example/image.png',
    );
  });

  it('leaves ordinary downloads unchanged', async () => {
    const { controller, getDownloadInfo, response, setHeader } = setup();

    await callDownload(controller, undefined, undefined, response);

    expect(getDownloadInfo).toHaveBeenCalledWith({
      attachmentId,
      versionNumber: undefined,
      inline: undefined,
      user,
    });
    expect(setHeader).not.toHaveBeenCalledWith(
      'Cross-Origin-Resource-Policy',
      expect.anything(),
    );
  });

  it.each(['', '0', 'true', '01'])(
    'rejects inline=%j without generating a signed URL',
    async (inline) => {
      const { controller, getDownloadInfo, redirect, response } = setup();

      await expect(
        callDownload(controller, undefined, inline, response),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(getDownloadInfo).not.toHaveBeenCalled();
      expect(redirect).not.toHaveBeenCalled();
    },
  );
});
