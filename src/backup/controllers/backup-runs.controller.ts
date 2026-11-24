/**
 * @fileoverview Read and cancel backup runs.
 * @module src/backup/controllers/backup-runs.controller
 *
 * Starting a run lives on the schemes controller, because a run is always started from a scheme.
 * This controller owns everything about runs that already exist.
 *
 * Same three gates as the rest of the module: the licence feature on the class, a permission per
 * handler, and a per-request module-enabled check that is never cached — an admin disabling Backup
 * mid-session must lose access immediately.
 */

import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequireFeature } from '../../auth/decorators/require-feature.decorator';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import { RunQueryDto } from '../dto/run-query.dto';
import { BackupRunsService } from '../services/backup-runs.service';

@ApiTags('Backup')
@ApiBearerAuth()
@RequireFeature('module_backup')
@Controller('backup/runs')
@UseGuards(PermissionsGuard)
export class BackupRunsController {
  constructor(
    private readonly runsService: BackupRunsService,
    private readonly organizationModulesService: OrganizationModulesService,
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
  @ApiOperation({ summary: 'List backup runs' })
  async list(@CurrentUser() user: RequestUser, @Query() query: RunQueryDto) {
    await this.assertModuleEnabled(user.organizationId);

    return this.runsService.list(user.organizationId, {
      schemeId: query.schemeId,
      status: query.status,
      limit: query.limit,
    });
  }

  @Get(':id')
  @RequirePermissions('can_manage_backups')
  @ApiOperation({ summary: 'Get one backup run' })
  async get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.assertModuleEnabled(user.organizationId);

    return this.runsService.get(user.organizationId, id);
  }

  @Get(':id/items')
  // Widened to either permission, and ONLY this endpoint on this controller. The restore wizard
  // builds its step-3 table list from these items, so a restore-only operator cannot get past the
  // archive step without them. Read-only, scoped to the caller's organization by `listItems`, and it
  // returns table names and row counts rather than any row content.
  //
  // The sibling routes above and below stay on their original single permission on purpose: listing
  // and cancelling RUNS is backup administration, not restoring.
  @RequirePermissions(['can_manage_backups', 'can_restore_backups'], {
    any: true,
  })
  @ApiOperation({ summary: 'Per-unit progress for a run' })
  async items(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.assertModuleEnabled(user.organizationId);

    return this.runsService.listItems(user.organizationId, id);
  }

  @Post(':id/cancel')
  @RequirePermissions('can_run_backups')
  @ApiOperation({
    summary: 'Cancel a run. 409 once it has already finished.',
  })
  async cancel(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.assertModuleEnabled(user.organizationId);

    return this.runsService.cancel(user.organizationId, id, user.userId);
  }
}
