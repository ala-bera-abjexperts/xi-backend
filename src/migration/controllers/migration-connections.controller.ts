/**
 * @fileoverview REST controller for migration source connections (Tenant Config ▸ Migration).
 *
 * Access control (defence in depth):
 *   1. `@RequirePermissions('can_manage_migrations')` + `PermissionsGuard` — org-level permission.
 *   2. Per-request org-module toggle check (`assertModuleEnabled`) — admin can disable mid-session
 *      and revocation is immediate (not cached), per the migration-tool security model.
 * Secrets are never returned — responses carry `masked_secret`.
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
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import { MigrationConnectionsService } from '../services/migration-connections.service';
import { CreateConnectionDto } from '../dto/create-connection.dto';
import { UpdateConnectionDto } from '../dto/update-connection.dto';
import { TestConnectionDto } from '../dto/test-connection.dto';
import { RequireFeature } from '../../auth/decorators/require-feature.decorator';

@RequireFeature('module_migration')
@ApiTags('Migration')
@ApiBearerAuth()
@Controller('migration/connections')
@UseGuards(PermissionsGuard)
export class MigrationConnectionsController {
  constructor(
    private readonly connectionsService: MigrationConnectionsService,
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

  @Get()
  @RequirePermissions('can_manage_migrations')
  @ApiOperation({ summary: 'List migration source connections' })
  async list(@CurrentUser() user: RequestUser) {
    await this.assertModuleEnabled(user.organizationId);

    return this.connectionsService.list(user.organizationId);
  }

  @Post('test')
  @RequirePermissions('can_manage_migrations')
  @ApiOperation({ summary: 'Test connection credentials without saving' })
  async testAdHoc(
    @CurrentUser() user: RequestUser,
    @Body() dto: TestConnectionDto,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    return this.connectionsService.testAdHoc(dto);
  }

  @Post()
  @RequirePermissions('can_manage_migrations')
  @ApiOperation({
    summary: 'Create a migration source connection (secret encrypted at rest)',
  })
  async create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateConnectionDto,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    return this.connectionsService.create(
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Get(':id')
  @RequirePermissions('can_manage_migrations')
  @ApiOperation({ summary: 'Get a migration source connection' })
  async get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.assertModuleEnabled(user.organizationId);

    return this.connectionsService.get(user.organizationId, id);
  }

  @Patch(':id')
  @RequirePermissions('can_manage_migrations')
  @ApiOperation({ summary: 'Update a migration source connection' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: UpdateConnectionDto,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    return this.connectionsService.update(
      user.organizationId,
      id,
      user.userId,
      dto,
    );
  }

  @Delete(':id')
  @RequirePermissions('can_manage_migrations')
  @ApiOperation({ summary: 'Delete a migration source connection' })
  async remove(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.assertModuleEnabled(user.organizationId);

    return this.connectionsService.remove(user.organizationId, id, user.userId);
  }

  @Post(':id/test')
  @RequirePermissions('can_manage_migrations')
  @ApiOperation({
    summary: 'Test a saved connection; persists detected deployment/version',
  })
  async testSaved(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.assertModuleEnabled(user.organizationId);

    return this.connectionsService.testSaved(user.organizationId, id);
  }
}
