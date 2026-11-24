/**
 * @fileoverview REST controller for source discovery on a saved migration
 * connection (list projects/spaces + partial-tolerant project preview).
 *
 * Access control (defence in depth) mirrors the connections controller:
 *   1. `@RequirePermissions('can_manage_migrations')` + `PermissionsGuard` — org-level permission.
 *   2. Per-request org-module toggle check (`assertModuleEnabled`) — admin can disable mid-session
 *      and revocation is immediate (not cached), per the migration-tool security model.
 */

import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import { MigrationDiscoveryService } from '../services/migration-discovery.service';
import {
  DiscoveryQueryDto,
  SpacePreviewQueryDto,
} from '../dto/discovery-query.dto';
import { RequireFeature } from '../../auth/decorators/require-feature.decorator';

@RequireFeature('module_migration')
@ApiTags('Migration')
@ApiBearerAuth()
@Controller('migration/connections/:connectionId/discovery')
@UseGuards(PermissionsGuard)
export class MigrationDiscoveryController {
  constructor(
    private readonly discoveryService: MigrationDiscoveryService,
    private readonly organizationModulesService: OrganizationModulesService,
  ) {}

  /** Throws 403 unless the org admin has the Migration module toggled on (checked per request). */
  private async assertModuleEnabled(organizationId: string): Promise<void> {
    const enabled = await this.organizationModulesService.isEnabled(
      organizationId,
      'migration',
    );

    if (!enabled) {
      throw new ForbiddenException(
        'The Migration module is disabled for this organization',
      );
    }
  }

  @Get('sources')
  @RequirePermissions('can_manage_migrations')
  @ApiOperation({
    summary: 'List migratable sources (Jira projects) on a connection',
  })
  async listSources(
    @Param('connectionId') connectionId: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    return this.discoveryService.listSources(user.organizationId, connectionId);
  }

  @Get('preview')
  @RequirePermissions('can_manage_migrations')
  @ApiOperation({
    summary:
      'Partial-tolerant preview of a Jira project (counts + warnings) before job creation',
  })
  async preview(
    @Param('connectionId') connectionId: string,
    @Query() query: DiscoveryQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    return this.discoveryService.previewProject(
      user.organizationId,
      connectionId,
      query.projectKey,
    );
  }

  @Get('space-preview')
  @RequirePermissions('can_manage_migrations')
  @ApiOperation({
    summary:
      'Lightweight preview of a Confluence space (page count + warnings) before job creation',
  })
  async spacePreview(
    @Param('connectionId') connectionId: string,
    @Query() query: SpacePreviewQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    return this.discoveryService.previewSpace(
      user.organizationId,
      connectionId,
      query.spaceKey,
    );
  }

  @Get('users-preview')
  @RequirePermissions('can_manage_migrations')
  @ApiOperation({
    summary:
      'Read-only user mapping preview: email matches vs would-be placeholders (creates nothing, sends nothing)',
  })
  async usersPreview(
    @Param('connectionId') connectionId: string,
    @Query() query: DiscoveryQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    return this.discoveryService.previewUsers(
      user.organizationId,
      connectionId,
      query.projectKey,
      query.provisionUsers === true,
      query.inviteUsers === true,
    );
  }
}
