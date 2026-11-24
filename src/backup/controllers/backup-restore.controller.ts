/**
 * @fileoverview Previewing and applying a restore.
 * @module src/backup/controllers/backup-restore.controller
 *
 * Same three gates as the rest of the module: the feature flag on the class, a permission per
 * method, and `assertModuleEnabled()` re-checked on every request rather than cached — an admin who
 * disables the module mid-session must lose access immediately.
 *
 * Writing is gated harder than reading. Previewing or applying puts archived data back into the
 * tenant, so both need `can_restore_backups`; merely watching the history needs only
 * `can_manage_backups`. Both write paths are `@ImpersonationBlocked()`: an admin impersonating a
 * tenant user must not be able to rewrite that tenant's data while wearing their face.
 *
 * Every response body uses `detail`, never `message` — the global ResponseInterceptor destructively
 * hoists a `message` key out of any payload it wraps.
 */

import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { ImpersonationBlocked } from '../../auth/decorators/impersonation-blocked.decorator';
import { RequireFeature } from '../../auth/decorators/require-feature.decorator';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import { PermissionsService } from '../../permissions/permissions.service';
import {
  ApplyRestoreDto,
  StartRestoreDryRunDto,
} from '../dto/start-restore.dto';
import { BackupRestoreService } from '../services/backup-restore.service';

@ApiTags('Backup')
@ApiBearerAuth()
@RequireFeature('module_backup')
@Controller('backup/restore')
@UseGuards(PermissionsGuard)
export class BackupRestoreController {
  constructor(
    private readonly restore: BackupRestoreService,
    private readonly organizationModulesService: OrganizationModulesService,
    private readonly auditLogs: AuditLogsService,
    private readonly permissions: PermissionsService,
  ) {}

  /**
   * Whether this caller may restore identity-tier data — roles, memberships, invitations, groups,
   * service principals and user preferences.
   *
   * A second permission on top of `can_restore_backups`, because putting archived roles and
   * memberships back can hand somebody access they do not have now. `can_restore_identity` is
   * owner-only by default for that reason.
   *
   * Resolved per request rather than read off the session, for the same reason
   * `assertModuleEnabled` is: a permission revoked mid-session has to take effect on the next
   * request, not the next login.
   */
  private async mayRestoreIdentity(user: RequestUser): Promise<boolean> {
    return this.permissions.checkPermission(
      user.userId,
      user.organizationId,
      'can_restore_identity',
    );
  }

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
  @ApiOperation({ summary: 'Restores for this organization, newest first.' })
  async list(@CurrentUser() user: RequestUser, @Query('limit') limit?: string) {
    await this.assertModuleEnabled(user.organizationId);

    const parsed = Number(limit);

    return this.restore.list(
      user.organizationId,
      Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50,
    );
  }

  @Get(':id')
  @RequirePermissions('can_manage_backups')
  @ApiOperation({
    summary: 'One restore with its per-table progress and recorded conflicts.',
  })
  async detail(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    return this.restore.detail(user.organizationId, id);
  }

  /**
   * The per-row report: what happened to each individual record.
   *
   * `can_manage_backups`, deliberately NOT `can_restore_backups`. Reading a report is watching
   * history, and the header above already establishes that watching needs only the weaker
   * permission — `GET /` and `GET :id` both use it. Gating this one more strictly would put a tab
   * in front of every `can_manage_backups` user and then 403 it, and because the frontend disables
   * retries on these queries that lands as a permanent error rather than a hidden feature.
   *
   * Paged because a single run can hold tens of thousands of records. `pageSize` is clamped rather
   * than trusted: an unbounded page is a way to ask the database for a table scan over jsonb.
   */
  @Get(':id/records')
  @RequirePermissions('can_manage_backups')
  @ApiOperation({
    summary:
      'Per-row restore results: what was restored, skipped or failed, and why.',
  })
  async records(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('table') table?: string,
    @Query('tables') tables?: string,
    @Query('outcome') outcome?: string,
    @Query('reason') reason?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    const parsedPage = Number(page);
    const parsedSize = Number(pageSize);

    // Comma-separated so the Results screen can ask for one outcome GROUP of tables rather than
    // one table. Deduplicated and emptied of blanks here so `a,,b,a` cannot become three filter
    // terms; the service ignores an empty list rather than matching nothing on it.
    const tableList = tables
      ? [
          ...new Set(
            tables
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean),
          ),
        ]
      : [];

    return this.restore.listRecords(user.organizationId, id, {
      table: table || undefined,
      tables: tableList.length ? tableList : undefined,
      outcome: outcome || undefined,
      reason: reason || undefined,
      search: search || undefined,
      page: Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1,
      pageSize:
        Number.isFinite(parsedSize) && parsedSize > 0
          ? Math.min(parsedSize, 200)
          : 50,
    });
  }

  /**
   * Starts a preview. Writes nothing to tenant data.
   *
   * Returns as soon as the run row exists; the work continues in the background and the caller polls
   * `GET :id`. An SFTP download plus a full archive read does not fit inside an HTTP request.
   */
  @Post('dry-run')
  @RequirePermissions('can_restore_backups')
  @ImpersonationBlocked()
  // Each attempt costs a scrypt derivation, so this is both a brute-force limit and a guard against
  // a handful of requests pinning the CPU.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Preview a restore. Returns a run id to poll; nothing is written to your data.',
  })
  async dryRun(
    @CurrentUser() user: RequestUser,
    @Body() dto: StartRestoreDryRunDto,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    // Asked only when the flag is set, so an ordinary restore costs no extra permission lookup and
    // behaves exactly as it did before identity could be requested at all.
    if (dto.include_identity && !(await this.mayRestoreIdentity(user))) {
      throw new ForbiddenException(
        'Restoring roles, memberships and other identity data needs the "restore identity" ' +
          'permission. Ask an owner to run this restore, or leave the identity areas unticked.',
      );
    }

    const { id } = await this.restore.createDryRun(
      user.organizationId,
      user.userId,
      {
        targetId: dto.target_id,
        artifactId: dto.artifact_id,
        tables: dto.tables,
        passphrase: dto.passphrase,
        destinationId: dto.destination_id,
        expectedOrganizationId: dto.expected_organization_id,
        spaceId: dto.space_id,
        destinationSpaceId: dto.destination_space_id,
        includeIdentity: dto.include_identity,
        replaceExistingConfig: dto.replace_existing_config,
      },
    );

    return {
      id,
      detail:
        'The preview has started. Poll this run to see what it would restore.',
    };
  }

  /**
   * Throws away a preview so another can be started.
   *
   * A preview holds the organization's single restore slot until it is applied. Without a way to
   * give that up, closing the wizard left every later restore answering 409.
   */
  @Post(':id/discard')
  @RequirePermissions('can_restore_backups')
  @ImpersonationBlocked()
  @ApiOperation({
    summary: 'Discard a preview. Writes nothing; frees the restore slot.',
  })
  async discard(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    return this.restore.discardDryRun(user.organizationId, id);
  }

  /**
   * Stops a restore that is still working, and frees the organization's restore slot.
   *
   * Separate from `discard`, which only ever applied to a preview waiting on a decision. This is for
   * a run that is genuinely running — or one that has stopped running without saying so, which is
   * what an operator meets when a restore hangs and every later attempt is refused with a 409.
   *
   * Audited like `apply` rather than like `discard`: cancelling a restore that has begun writing
   * leaves the destination in a state somebody may later have to explain, and who stopped it is part
   * of that explanation. Discarding a preview changes nothing, so it needs no such entry.
   */
  @Post(':id/cancel')
  @RequirePermissions('can_restore_backups')
  @ImpersonationBlocked()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Cancel a running restore. Stops further writing; does not undo what was written.',
  })
  async cancel(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    const result = await this.restore.cancelRun(user.organizationId, id);

    await this.auditLogs.logAction(
      user.organizationId,
      user.userId,
      'restore_run',
      id,
      // `update`, not `restore`: the audit action vocabulary has no `cancel`, and logging this as a
      // `restore` would put "this person restored data" in the trail for someone who stopped a
      // restore. The status in the metadata says what the change actually was.
      'update',
      { status: result.status, cancelled: true },
    );

    return result;
  }

  /**
   * A short-lived download link for the archive this restore read.
   *
   * The archive was fetched from the backup target once and cached so the apply need not fetch it
   * again; while it is still there, it can also be handed to the operator. Answers `{ url: null }`
   * rather than 404 when nothing is cached — "there is no link" is an ordinary state of a run, not a
   * missing resource, and the UI simply shows nothing.
   *
   * `can_restore_backups`, deliberately NOT the weaker `can_manage_backups` the other reads use:
   * this hands over the decrypted archive itself, which is the same thing downloading a backup does.
   */
  @Get(':id/archive-url')
  @RequirePermissions('can_restore_backups')
  @ApiOperation({
    summary:
      'A time-limited link to the archive this restore read, if still cached.',
  })
  async archiveUrl(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    return this.restore.archiveUrl(user.organizationId, id);
  }

  /**
   * Applies a preview that reached `awaiting_confirmation`.
   *
   * The passphrase is required again because it is never stored — the same contract as downloading.
   */
  @Post(':id/apply')
  @RequirePermissions('can_restore_backups')
  @ImpersonationBlocked()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Apply a preview. Inserts only — an existing row is never changed.',
  })
  async apply(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApplyRestoreDto,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    // Re-asked at apply, like the cross-organization approval below it, because a preview is
    // confirmed by a person minutes or hours after it was planned — and `can_restore_identity` can
    // be taken away in between. The service compares this against what the preview recorded and
    // refuses the apply rather than quietly dropping the identity tables from it.
    const { id: runId } = await this.restore.apply(
      user.organizationId,
      user.userId,
      id,
      dto.passphrase,
      await this.mayRestoreIdentity(user),
    );

    // Logged after the run row exists, so the audit trail cannot claim a restore that was refused
    // before it started. Failures inside the run are on the run itself.
    await this.auditLogs.logAction(
      user.organizationId,
      user.userId,
      'restore_run',
      runId,
      'restore',
      { dry_run_of_id: id },
    );

    return {
      id: runId,
      detail: 'The restore has started. Poll this run to follow it.',
    };
  }
}
