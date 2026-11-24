/**
 * @fileoverview Browsing and downloading the archives on a target.
 * @module src/backup/controllers/backup-archives.controller
 *
 * Same three gates as the rest of the module: the feature flag on the class, a permission per
 * method, and `assertModuleEnabled()` re-checked on every request rather than cached.
 *
 * Downloading is gated harder than listing. A decrypted archive is every table, every user row and
 * every uploaded file — holding it is equivalent to restore-level access, so it needs
 * `can_restore_backups` rather than the `can_manage_backups` that merely shows the list. It is also
 * `@ImpersonationBlocked()`: an admin impersonating a tenant user must not be able to walk out with
 * the whole tenant.
 */

import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { contentDispositionAttachment } from '../../common/content-disposition';
import { ImpersonationBlocked } from '../../auth/decorators/impersonation-blocked.decorator';
import { RequireFeature } from '../../auth/decorators/require-feature.decorator';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import { DownloadArchiveDto } from '../dto/download-archive.dto';
import { BackupArchivesService } from '../services/backup-archives.service';

@ApiTags('Backup')
@ApiBearerAuth()
@RequireFeature('module_backup')
@Controller('backup/targets/:targetId/archives')
@UseGuards(PermissionsGuard)
export class BackupArchivesController {
  constructor(
    private readonly archives: BackupArchivesService,
    private readonly organizationModulesService: OrganizationModulesService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  private async assertModuleEnabled(organizationId: string): Promise<void> {
    const enabled = await this.organizationModulesService.isEnabled(
      organizationId,
      'backup',
    );

    if (!enabled) {
      throw new ForbiddenException(
        'The Backup & Restore module is disabled for this organization',
      );
    }
  }

  @Get()
  @RequirePermissions('can_manage_backups')
  @ApiOperation({
    summary:
      'List the archives on a target. `verify=1` also checks the target itself.',
  })
  async list(
    @CurrentUser() user: RequestUser,
    @Param('targetId', ParseUUIDPipe) targetId: string,
    @Query('verify') verify?: string,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    return this.archives.list(user.organizationId, targetId, verify === '1');
  }

  /**
   * Says whether a passphrase opens an archive, without transferring it.
   *
   * The restore wizard collects the passphrase three steps before anything uses it, so a typo used
   * to surface only when the preview failed — after tables had been chosen and, for a
   * cross-organization restore, after somebody else had already approved it.
   *
   * A wrong passphrase answers 200 with `valid: false` rather than throwing: it is an ordinary
   * outcome the wizard renders against the field, not a failed request.
   */
  @Post(':artifactId/verify-passphrase')
  @RequirePermissions('can_restore_backups')
  @ImpersonationBlocked()
  // Same limit as download, and for a stronger reason: this endpoint answers "is this passphrase
  // right?" directly, so it is a guessing oracle. The scrypt derivation is the other half of the
  // defence — each attempt costs ~100 ms of CPU.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Check an archive passphrase. Transfers nothing and writes nothing.',
  })
  async verifyPassphrase(
    @CurrentUser() user: RequestUser,
    @Param('targetId', ParseUUIDPipe) targetId: string,
    @Param('artifactId', ParseUUIDPipe) artifactId: string,
    @Body() dto: DownloadArchiveDto,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    return this.archives.verifyPassphrase(
      user.organizationId,
      targetId,
      artifactId,
      dto.passphrase,
    );
  }

  /**
   * Streams one archive, decrypting it when the supplied passphrase opens it.
   *
   * `@Res()` WITHOUT `passthrough` is the only way to bypass the global ResponseInterceptor, which
   * has no skip logic and would otherwise wrap the body in `{statusCode, hasError, data, message}`.
   * `@Res({ passthrough: true })` does NOT work — `migration-runs.controller.ts` proves it: its
   * exported CSV contains a JSON envelope today. `StreamableFile` fails the same way.
   */
  @Post(':artifactId/download')
  @RequirePermissions('can_restore_backups')
  @ImpersonationBlocked()
  // Each attempt costs a scrypt derivation, so this is both a brute-force limit and a guard against
  // a handful of requests pinning the CPU.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Download one archive, decrypted. 400 on a wrong passphrase, before any bytes are sent.',
  })
  async download(
    @CurrentUser() user: RequestUser,
    @Param('targetId', ParseUUIDPipe) targetId: string,
    @Param('artifactId', ParseUUIDPipe) artifactId: string,
    @Body() dto: DownloadArchiveDto,
    @Res() res: Response,
  ): Promise<void> {
    await this.assertModuleEnabled(user.organizationId);

    // Everything that can fail — permissions, a missing file, a wrong passphrase — fails here,
    // before a single header is written, so the normal error envelope still reaches the client.
    const opened = await this.archives.openForDownload(
      user.organizationId,
      targetId,
      artifactId,
      dto.passphrase,
    );

    await this.writeAudit(user, artifactId, opened.decrypted);

    res.status(HttpStatus.OK);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      contentDispositionAttachment(opened.fileName),
    );

    // No Content-Length: decryption strips the per-frame framing, so the plaintext is smaller than
    // the stored byte_size. Declaring the stored size would truncate the download at the client.
    try {
      await pipeline(opened.stream, res);
    } catch (err) {
      this.failMidStream(res, err as Error);
    }
  }

  /**
   * Ends a transfer that broke after it started.
   *
   * The global AllExceptionsFilter has no `headersSent` check and would call `response.json()`
   * unconditionally, throwing ERR_HTTP_HEADERS_SENT as an unhandled rejection — while the client
   * keeps a truncated file that looks complete. Destroying the socket makes the failure visible as
   * a broken transfer, which is the honest outcome.
   */
  private failMidStream(res: Response, err: Error): void {
    if (res.headersSent) {
      res.destroy(err);

      return;
    }

    throw err;
  }

  /** A whole-tenant export is worth a row of its own. Never records the passphrase. */
  private async writeAudit(
    user: RequestUser,
    artifactId: string,
    decrypted: boolean,
  ): Promise<void> {
    try {
      await this.auditLogs.logAction(
        user.organizationId,
        user.userId,
        'backup_artifact',
        artifactId,
        'backup',
        { archive_downloaded: true, decrypted },
      );
    } catch {
      // Never block a recovery on the audit writer. The download is the point.
    }
  }
}
