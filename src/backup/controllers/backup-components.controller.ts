/**
 * @fileoverview Read-only projection of the component registry for the selection UI.
 * @module src/backup/controllers/backup-components.controller
 *
 * The registry is a checked-in constant, so this endpoint takes no tenant data and returns the same
 * tree for everyone. It is still gated: knowing the table inventory is not something an unentitled
 * or unpermissioned caller needs.
 */

import { Controller, ForbiddenException, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequireFeature } from '../../auth/decorators/require-feature.decorator';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import { buildRestoreComponentTree } from '../engine/restore-component-tree';

@ApiTags('Backup')
@ApiBearerAuth()
@RequireFeature('module_backup')
@Controller('backup/components')
@UseGuards(PermissionsGuard)
export class BackupComponentsController {
  constructor(
    private readonly organizationModulesService: OrganizationModulesService,
  ) {}

  /** Same per-request gate as the other backup controllers. Never cached. */
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
  // Either permission opens this, because BOTH need it. The restore wizard's own endpoints are gated
  // on `can_restore_backups`, but its table picker cannot render without this tree — so gating it on
  // `can_manage_backups` alone hands a restore-only operator a permission error in place of step 3,
  // permanently, since the hook that fetches it runs with `retry: false`.
  //
  // Safe to widen: it returns the component registry, which is a checked-in constant. No tenant data,
  // no archive bytes, nothing to mutate. The module gate below is still enforced per request.
  @RequirePermissions(['can_manage_backups', 'can_restore_backups'], {
    any: true,
  })
  @ApiOperation({
    summary: 'The component registry as a tier -> component -> tables tree',
  })
  async list(@CurrentUser() user: RequestUser) {
    await this.assertModuleEnabled(user.organizationId);

    return buildRestoreComponentTree();
  }
}
