/**
 * @fileoverview REST controller for migration jobs (saved wizard output:
 * connection + source ref + scope + options; status draft/ready).
 *
 * Access control (defence in depth) mirrors the connections controller:
 *   1. `@RequirePermissions('can_manage_migrations')` + `PermissionsGuard` — org-level permission.
 *   2. Per-request org-module toggle check (`assertModuleEnabled`) — admin can disable mid-session
 *      and revocation is immediate (not cached), per the migration-tool security model.
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
import { MigrationJobsService } from '../services/migration-jobs.service';
import { CreateMigrationJobDto } from '../dto/create-migration-job.dto';
import { UpdateMigrationJobDto } from '../dto/update-migration-job.dto';
import { RequireFeature } from '../../auth/decorators/require-feature.decorator';

@RequireFeature('module_migration')
@ApiTags('Migration')
@ApiBearerAuth()
@Controller('migration/jobs')
@UseGuards(PermissionsGuard)
export class MigrationJobsController {
  constructor(
    private readonly jobsService: MigrationJobsService,
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
  @ApiOperation({ summary: 'List migration jobs' })
  async list(@CurrentUser() user: RequestUser) {
    await this.assertModuleEnabled(user.organizationId);

    return this.jobsService.list(user.organizationId);
  }

  @Post()
  @RequirePermissions('can_manage_migrations')
  @ApiOperation({ summary: 'Create a migration job (draft)' })
  async create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateMigrationJobDto,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    return this.jobsService.create(user.organizationId, user.userId, dto);
  }

  @Get(':id')
  @RequirePermissions('can_manage_migrations')
  @ApiOperation({ summary: 'Get a migration job' })
  async get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.assertModuleEnabled(user.organizationId);

    return this.jobsService.get(user.organizationId, id);
  }

  @Patch(':id')
  @RequirePermissions('can_manage_migrations')
  @ApiOperation({
    summary:
      'Update a migration job (connection/source are immutable after creation)',
  })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: UpdateMigrationJobDto,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    return this.jobsService.update(user.organizationId, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('can_manage_migrations')
  @ApiOperation({ summary: 'Delete a migration job' })
  async remove(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.assertModuleEnabled(user.organizationId);

    return this.jobsService.remove(user.organizationId, id);
  }
}
