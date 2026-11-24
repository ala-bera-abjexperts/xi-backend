/**
 * @fileoverview Managing where a restore may write.
 * @module src/backup/controllers/restore-destinations.controller
 *
 * Same three gates as the rest of the module: the feature flag on the class, a permission per
 * method, and `assertModuleEnabled()` re-checked on every request rather than cached.
 *
 * Everything here needs `can_restore_backups`, including the read. A destination row names another
 * database and the fingerprint of the key that opens it, which is closer to holding the credential
 * than to reading a setting — so it gets the audience that can already restore, not the wider one
 * that can merely watch backups run.
 *
 * Also `@ImpersonationBlocked()` throughout: an admin wearing a tenant user's face must not be able
 * to point that tenant's restores at a database of their choosing.
 */

import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import {
  CreateRestoreDestinationDto,
  ProbeDestinationOrganizationsDto,
} from '../dto/restore-destination.dto';
import { RestoreDestinationsService } from '../services/restore-destinations.service';

@ApiTags('Backup')
@ApiBearerAuth()
@RequireFeature('module_backup')
@Controller('backup/restore-destinations')
@UseGuards(PermissionsGuard)
export class RestoreDestinationsController {
  constructor(
    private readonly destinations: RestoreDestinationsService,
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
  @RequirePermissions('can_restore_backups')
  @ImpersonationBlocked()
  @ApiOperation({
    summary:
      'Destinations this organization can restore into. Never returns a key.',
  })
  async list(@CurrentUser() user: RequestUser) {
    await this.assertModuleEnabled(user.organizationId);

    return this.destinations.list(user.organizationId);
  }

  /**
   * Spaces of one organization the caller belongs to.
   *
   * Declared before `POST /` and above the `:id` routes so a literal path segment is never shadowed
   * by the parameterised ones.
   */
  @Get('organizations/:organizationId/spaces')
  @RequirePermissions('can_restore_backups')
  @ImpersonationBlocked()
  @ApiOperation({
    summary:
      'Spaces of an organization you belong to, for narrowing a restore to one space.',
  })
  async spaces(
    @CurrentUser() user: RequestUser,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    return this.destinations.listSpaces(user.userId, organizationId);
  }

  @Post()
  @RequirePermissions('can_restore_backups')
  @ImpersonationBlocked()
  @ApiOperation({
    summary:
      'Add a destination. Another organization requires another Supabase instance.',
  })
  async create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateRestoreDestinationDto,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    const created = await this.destinations.create(
      user.organizationId,
      user.userId,
      {
        name: dto.name,
        kind: dto.kind,
        supabaseUrl: dto.supabase_url,
        serviceKey: dto.service_key,
        targetOrganizationId: dto.target_organization_id,
      },
    );

    // Logged without the URL: the audit trail records that a destination was added, not where a
    // service-role key was sent.
    await this.auditLogs.logAction(
      user.organizationId,
      user.userId,
      'restore_destination',
      created.id,
      'create',
      { kind: created.kind },
    );

    return created;
  }

  /**
   * The organizations that exist on a destination, for the "restore into" picker.
   *
   * A POST rather than a GET because the service-role key is in the body: a GET would put it in
   * the URL, and from there into browser history, proxy logs and the referrer header.
   *
   * Declared before `:id/test` so `organizations` is matched as a literal path rather than being
   * read as a destination id.
   *
   * Throttled on the same reasoning as the test endpoint, and a little tighter: each call opens a
   * connection to an address the caller chose, so an unthrottled version turns this server into a
   * port scanner for whoever can reach it.
   */
  @Post('organizations')
  @RequirePermissions('can_restore_backups')
  @ImpersonationBlocked()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'List the organizations on another instance, to choose one to restore into.',
  })
  async organizations(
    @CurrentUser() user: RequestUser,
    @Body() dto: ProbeDestinationOrganizationsDto,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    return this.destinations.listRemoteOrganizations(
      dto.supabase_url,
      dto.service_key,
    );
  }

  /**
   * Proves the destination answers, before a restore depends on it.
   *
   * Throttled because each call opens a connection to an address the caller chose, and an
   * unthrottled version is a way to make this server probe hosts on someone else's behalf.
   */
  @Post(':id/test')
  @RequirePermissions('can_restore_backups')
  @ImpersonationBlocked()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Check the destination is reachable and record the result.',
  })
  async test(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    return this.destinations.test(user.organizationId, id);
  }

  @Delete(':id')
  @RequirePermissions('can_restore_backups')
  @ImpersonationBlocked()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a destination. Past runs keep their history.',
  })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.assertModuleEnabled(user.organizationId);
    await this.destinations.remove(user.organizationId, id);

    await this.auditLogs.logAction(
      user.organizationId,
      user.userId,
      'restore_destination',
      id,
      'delete',
      {},
    );
  }
}
