/**
 * @fileoverview Public File Explorer controller — anonymous access via share token.
 * All routes are decorated with @Public() to bypass SupabaseAuthGuard.
 * Authorization is derived solely from the token (node from token, not from client).
 * @module src/file-explorer/file-explorer-public.controller
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { contentDispositionAttachment } from '../common/content-disposition';
import { readCookieConfig } from '../auth/cookies.util';
import { FileExplorerService } from './file-explorer.service';
import { FileExplorerArchiveService } from './file-explorer-archive.service';
import { VerifySharePasswordDto } from './dto/verify-share-password.dto';
import type { IPublicShareAccessCookie } from './interfaces/public-download.interface';

const PUBLIC_SHARE_COOKIE_PATH = '/api/v1/public/file-explorer';

@ApiTags('File Explorer (public)')
@Controller('public/file-explorer')
export class FileExplorerPublicController {
  constructor(
    private readonly service: FileExplorerService,
    private readonly archive: FileExplorerArchiveService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Get metadata for a public link share.
   * Returns the node name and whether a password is required.
   * Returns 404 for invalid, revoked, or expired tokens.
   */
  @Public()
  @Get(':token')
  getShareMeta(@Param('token') token: string) {
    return this.service.getPublicShareMeta(token);
  }

  /**
   * Verify the password for a password-protected link share.
   * Rate-limited by the global throttler.
   * Returns { valid: true } on success; 401 on wrong password; 404 on invalid/expired token.
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post(':token/verify')
  verifyPassword(
    @Param('token') token: string,
    @Body() dto: VerifySharePasswordDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.service
      .verifyPublicPassword(token, dto.password)
      .then((result) => {
        if (result.accessCookie) {
          this.setPublicShareAccessCookie(res, result.accessCookie);
        }

        return { valid: result.valid };
      });
  }

  /**
   * Return a signed inline-view URL for a public link share.
   * Returns { url: null } for unsupported MIME types or folders.
   */
  @Public()
  @Get(':token/preview')
  getPublicPreview(
    @Param('token') token: string,
    @Req() req: Request,
  ): Promise<{ url: string | null }> {
    return this.service.getPublicPreviewUrl(
      token,
      this.getPublicShareAccessCookie(req, token),
    );
  }

  /**
   * Return recursive contents for a public folder link share.
   * Uses the same protected-share cookie as preview/download when a password is set.
   */
  @Public()
  @Get(':token/contents')
  getPublicFolderContents(@Param('token') token: string, @Req() req: Request) {
    return this.service.getPublicFolderContents(
      token,
      this.getPublicShareAccessCookie(req, token),
    );
  }

  /**
   * Download a file via a public link share.
   * Returns a 302 redirect to a short-TTL signed URL with Content-Disposition: attachment.
   * For folder shares, nodeId may specify a descendant (validated via ancestor_ids).
   * @Res() bypasses the global ResponseInterceptor — MUST stay.
   */
  @Public()
  @Get(':token/download')
  async download(
    @Param('token') token: string,
    @Query('nodeId') nodeId: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const download = await this.service.getPublicDownloadInfo(
      token,
      nodeId,
      this.getPublicShareAccessCookie(req, token),
    );

    res.setHeader('Cache-Control', 'no-store, private');

    if (download.type === 'file') {
      res.redirect(HttpStatus.FOUND, download.signedUrl);

      return;
    }

    res.status(HttpStatus.OK);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Archive-File-Count', String(download.entries.length));
    res.setHeader('X-Archive-Total-Bytes', String(download.totalBytes));
    res.setHeader(
      'Content-Disposition',
      contentDispositionAttachment(download.fileName),
    );

    await this.archive.streamZip(download.entries, res);
  }

  private getPublicShareAccessCookie(
    req: Request,
    token: string,
  ): string | undefined {
    const requestWithCookies = req as unknown as {
      cookies?: Record<string, unknown>;
    };
    const cookieName = this.service.getPublicShareAccessCookieName(token);
    const cookieValue: unknown = requestWithCookies.cookies?.[cookieName];

    return typeof cookieValue === 'string' ? cookieValue : undefined;
  }

  private setPublicShareAccessCookie(
    res: Response,
    cookie: IPublicShareAccessCookie,
  ): void {
    const cookieConfig = readCookieConfig(this.configService);

    res.cookie(cookie.name, cookie.value, {
      httpOnly: true,
      secure: cookieConfig.secure,
      sameSite: cookieConfig.sameSite,
      path: PUBLIC_SHARE_COOKIE_PATH,
      maxAge: cookie.maxAgeSeconds * 1000,
      ...(cookieConfig.domain ? { domain: cookieConfig.domain } : {}),
    });
  }
}
