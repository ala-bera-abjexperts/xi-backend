/**
 * @fileoverview REST controller for backup schemes.
 * @module src/backup/controllers/backup-schemes.controller
 *
 * Same three gates as the targets controller. Managing a scheme needs can_manage_backups; replacing
 * the archive passphrase is a credential change, so it needs can_manage_backup_credentials.
 *
 * Creating a scheme that includes the identity tier needs only can_manage_backups — backing identity
 * up is not an escalation. Restoring it is, and that is gated separately.
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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequireFeature } from '../../auth/decorators/require-feature.decorator';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import { CreateBackupSchemeDto } from '../dto/create-backup-scheme.dto';
import { RotateSchemePassphraseDto } from '../dto/rotate-scheme-passphrase.dto';
import { StartBackupRunDto } from '../dto/start-backup-run.dto';
import { UpdateBackupSchemeDto } from '../dto/update-backup-scheme.dto';
import { BackupRunsService } from '../services/backup-runs.service';
import { BackupSchemesService } from '../services/backup-schemes.service';

@ApiTags('Backup')
@ApiBearerAuth()
@RequireFeature('module_backup')
@Controller('backup/schemes')
@UseGuards(PermissionsGuard)
export class BackupSchemesController {
  constructor(
    private readonly schemesService: BackupSchemesService,
    private readonly organizationModulesService: OrganizationModulesService,
    private readonly runsService: BackupRunsService,
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
  @ApiOperation({ summary: 'List backup schemes' })
  async list(@CurrentUser() user: RequestUser) {
    await this.assertModuleEnabled(user.organizationId);

    return this.schemesService.list(user.organizationId);
  }

  @Get(':id')
  @RequirePermissions('can_manage_backups')
  @ApiOperation({ summary: 'Get one backup scheme' })
  async get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.assertModuleEnabled(user.organizationId);

    return this.schemesService.get(user.organizationId, id);
  }

  @Post()
  @RequirePermissions('can_manage_backups')
  @ApiOperation({ summary: 'Create a backup scheme' })
  async create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateBackupSchemeDto,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    return this.schemesService.create(user.organizationId, user.userId, dto);
  }

  @Patch(':id')
  @RequirePermissions('can_manage_backups')
  @ApiOperation({
    summary:
      'Update a scheme. Changing selection or options bumps scheme_version.',
  })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: UpdateBackupSchemeDto,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    return this.schemesService.update(
      user.organizationId,
      id,
      user.userId,
      dto,
    );
  }

  @Post(':id/runs')
  @RequirePermissions('can_run_backups')
  @ApiOperation({
    summary:
      'Start a run now. 409 when one is already in flight for this scheme.',
  })
  async startRun(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: StartBackupRunDto,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    // Enqueues only. The worker executes it, exactly as it does for a scheduled run — one code
    // path, so a manual run cannot behave differently from the one that runs at 02:00.
    return this.runsService.createRun({
      organizationId: user.organizationId,
      schemeId: id,
      triggerSource: 'manual',
      userId: user.userId,
      // Absent means "use whatever the scheme is configured for", which is also what a scheduled
      // run does. The dialog always sends a list; the API does not require one, and the deprecated
      // single field is promoted to a one-element list so existing callers keep working.
      fileFormats:
        dto.file_formats ?? (dto.file_format ? [dto.file_format] : undefined),
    });
  }

  @Post(':id/activate')
  @RequirePermissions('can_manage_backups')
  @ApiOperation({
    summary:
      'Put a scheme on its schedule. 409 when it is not in a runnable state.',
  })
  async activate(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.assertModuleEnabled(user.organizationId);

    return this.schemesService.setStatus(
      user.organizationId,
      id,
      user.userId,
      'active',
    );
  }

  @Post(':id/pause')
  @RequirePermissions('can_manage_backups')
  @ApiOperation({
    summary:
      'Stop scheduling a scheme. A run already in flight is left to finish.',
  })
  async pause(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.assertModuleEnabled(user.organizationId);

    return this.schemesService.setStatus(
      user.organizationId,
      id,
      user.userId,
      'paused',
    );
  }

  @Post(':id/passphrase')
  @RequirePermissions('can_manage_backup_credentials')
  @ApiOperation({ summary: 'Replace the archive passphrase' })
  async rotatePassphrase(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: RotateSchemePassphraseDto,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    return this.schemesService.rotatePassphrase(
      user.organizationId,
      id,
      user.userId,
      dto.passphrase,
    );
  }

  @Delete(':id')
  @RequirePermissions('can_manage_backups')
  @ApiOperation({
    summary: 'Delete a scheme. 409 once it has runs — archive it instead.',
  })
  async remove(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.assertModuleEnabled(user.organizationId);

    return this.schemesService.remove(user.organizationId, id, user.userId);
  }
}
