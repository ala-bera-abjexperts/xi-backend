/**
 * @fileoverview Asking another organization to accept a restore, and deciding one.
 * @module src/backup/controllers/restore-approvals.controller
 *
 * Same three gates as the rest of the module: the feature flag on the class, a permission per
 * method, and `assertModuleEnabled()` re-checked per request rather than cached.
 *
 * The permissions here sit on opposite sides of the conversation, which is unusual enough to say
 * out loud. `can_restore_backups` lets you ASK, and it is held in your own organization.
 * `can_approve_incoming_restores` lets you ANSWER, and it is held in the organization being written
 * into — so the person who may decide is deliberately not the person who may request.
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
import {
  CreateRestoreApprovalRequestDto,
  DecideRestoreApprovalDto,
} from '../dto/restore-approval.dto';
import { RestoreApprovalsService } from '../services/restore-approvals.service';

@ApiTags('Backup')
@ApiBearerAuth()
@RequireFeature('module_backup')
@Controller('backup/restore-approvals')
@UseGuards(PermissionsGuard)
export class RestoreApprovalsController {
  constructor(
    private readonly approvals: RestoreApprovalsService,
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

  /**
   * Requests that were sent TO this organization.
   *
   * Declared before `:id` so the literal segment is never captured as a uuid.
   */
  @Get('incoming')
  @RequirePermissions('can_approve_incoming_restores')
  @ApiOperation({
    summary: 'Restores other organizations have asked to write into yours.',
  })
  async incoming(@CurrentUser() user: RequestUser) {
    await this.assertModuleEnabled(user.organizationId);

    return this.approvals.listIncoming(user.organizationId);
  }

  /** Requests this organization has raised, and where each got to. */
  @Get('outgoing')
  @RequirePermissions('can_restore_backups')
  @ApiOperation({ summary: 'Restore approvals you have asked for.' })
  async outgoing(@CurrentUser() user: RequestUser) {
    await this.assertModuleEnabled(user.organizationId);

    return this.approvals.listOutgoing(user.organizationId);
  }

  @Post()
  @RequirePermissions('can_restore_backups')
  @ImpersonationBlocked()
  // Raising a request notifies people. Rate limited so it cannot be used to flood an owner's inbox.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Ask another organization to accept a restore into it. Writes nothing to their data.',
  })
  async create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateRestoreApprovalRequestDto,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    const { id } = await this.approvals.create(
      user.organizationId,
      user.userId,
      {
        targetOrganizationId: dto.target_organization_id,
        targetId: dto.target_id,
        artifactId: dto.artifact_id,
        tables: dto.tables,
        sourceSpaceId: dto.source_space_id,
        destinationSpaceId: dto.destination_space_id,
        includeIdentity: dto.include_identity,
        note: dto.note,
      },
    );

    return {
      id,
      detail:
        'The request was sent. An owner of that organization has to approve it before the restore can run.',
    };
  }

  @Post(':id/approve')
  @RequirePermissions('can_approve_incoming_restores')
  @ImpersonationBlocked()
  @ApiOperation({
    summary:
      'Allow a restore into this organization. Nothing is written until the requester runs it.',
  })
  async approve(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideRestoreApprovalDto,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    const request = await this.approvals.decide(
      user.organizationId,
      user.userId,
      id,
      true,
      dto.note,
    );

    return {
      data: request,
      detail: 'Approved. The other organization can now run this restore once.',
    };
  }

  @Post(':id/reject')
  @RequirePermissions('can_approve_incoming_restores')
  @ImpersonationBlocked()
  @ApiOperation({ summary: 'Refuse a restore into this organization.' })
  async reject(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideRestoreApprovalDto,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    const request = await this.approvals.decide(
      user.organizationId,
      user.userId,
      id,
      false,
      dto.note,
    );

    return { data: request, detail: 'Rejected. Nothing was written.' };
  }

  /** The requester withdrawing their own unanswered ask. */
  @Post(':id/cancel')
  @RequirePermissions('can_restore_backups')
  @ImpersonationBlocked()
  @ApiOperation({ summary: 'Withdraw a request you raised.' })
  async cancel(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.assertModuleEnabled(user.organizationId);

    return this.approvals.cancel(user.organizationId, id);
  }
}
