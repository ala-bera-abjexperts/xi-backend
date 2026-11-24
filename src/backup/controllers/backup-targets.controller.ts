/**
 * @fileoverview REST controller for backup targets.
 * @module src/backup/controllers/backup-targets.controller
 *
 * Three gates, all of which must pass:
 *   1. @RequireFeature('module_backup') — licence entitlement. The frontend feature guard fails open,
 *      so this is the real boundary.
 *   2. @RequirePermissions — org permission. Reading a target needs can_manage_backups; touching a
 *      credential needs can_manage_backup_credentials.
 *   3. assertModuleEnabled() — checked per request, never cached, so disabling the module revokes
 *      access immediately.
 *
 * Responses never contain a plaintext secret; they carry masked_secret only.
 */

import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
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
import { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import { CreateBackupTargetDto } from '../dto/create-backup-target.dto';
import { RotateTargetSecretDto } from '../dto/rotate-target-secret.dto';
import { UpdateBackupTargetDto } from '../dto/update-backup-target.dto';
import { BackupTargetsService } from '../services/backup-targets.service';

@ApiTags('Backup')
@ApiBearerAuth()
@RequireFeature('module_backup')
@Controller('backup/targets')
@UseGuards(PermissionsGuard)
export class BackupTargetsController {
  constructor(
    private readonly targetsService: BackupTargetsService,
    private readonly organizationModulesService: OrganizationModulesService,
  ) {}

  /** Throws 403 unless an org admin has the Backup module toggled on. Checked per request. */
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
  @ApiOperation({ summary: 'List backup targets (secrets masked)' })
  async list(@CurrentUser() user: RequestUser) {
    await this.assertModuleEnabled(user.organizationId);

    return this.targetsService.list(user.organizationId);
  }

  @Get(':id')
  @RequirePermissions('can_manage_backups')
  @ApiOperation({ summary: 'Get one backup target (secret masked)' })
  async get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.assertModuleEnabled(user.organizationId);

    return this.targetsService.get(user.organizationId, id);
  }

  @Post()
  @RequirePermissions('can_manage_backup_credentials')
  @ApiOperation({
    summary: 'Create a backup target (credentials encrypted at rest)',
  })
  async create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateBackupTargetDto,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    return this.targetsService.create(user.organizationId, user.userId, dto);
  }

  @Patch(':id')
  @RequirePermissions('can_manage_backup_credentials')
  @ApiOperation({
    summary:
      'Update a target. Cannot change credentials — use POST :id/secret.',
  })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: UpdateBackupTargetDto,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    return this.targetsService.update(
      user.organizationId,
      id,
      user.userId,
      dto,
    );
  }

  @Post(':id/secret')
  @RequirePermissions('can_manage_backup_credentials')
  @ApiOperation({
    summary: 'Replace the stored credentials (the only way to change them)',
  })
  async rotateSecret(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: RotateTargetSecretDto,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    return this.targetsService.rotateSecret(
      user.organizationId,
      id,
      user.userId,
      dto,
    );
  }

  /**
   * Impersonation-blocked and rate-limited because this is an outbound-connection primitive: it
   * decrypts the stored credential and opens a socket to an admin-supplied host.
   */
  @Post(':id/test')
  @RequirePermissions('can_manage_backup_credentials')
  @ImpersonationBlocked()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Connect to the target and prove its directory is writable',
  })
  async test(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.assertModuleEnabled(user.organizationId);

    return this.targetsService.testConnection(
      user.organizationId,
      user.userId,
      id,
    );
  }

  @Delete(':id')
  @RequirePermissions('can_manage_backup_credentials')
  @ApiOperation({
    summary: 'Delete a target. 409 while a scheme still references it.',
  })
  async remove(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.assertModuleEnabled(user.organizationId);

    return this.targetsService.remove(user.organizationId, id, user.userId);
  }
}
