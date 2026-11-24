// Read-only visibility for inbound-email ingestion.
//
// Answers "what happened to my email?" — received, skipped and why, which ticket it became, whether
// attachments made it, and whether the mailbox is polling at all. All of that state already existed
// in the database with no way to read it.

import {
  Controller,
  Get,
  Param,
  Query,
  ForbiddenException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { PermissionsService } from '../permissions/permissions.service';
import { spaceGrantAllows } from '../permissions/models/space-permissions.model';
import { AutomationsService } from '../automations/automations.service';
import { InboundEmailService } from './inbound-email.service';

const REQUIRED_PERMISSION = 'can_view_automations';

@RequireFeature('module_automations')
@ApiTags('Inbound Email')
@ApiBearerAuth()
@Controller('automations')
export class InboundEmailController {
  constructor(
    private readonly automationsService: AutomationsService,
    private readonly inboundEmailService: InboundEmailService,
    private readonly permissionsService: PermissionsService,
  ) {}

  @Get(':id/inbound-emails')
  @ApiOperation({
    summary: 'Recent inbound emails for a mailbox automation',
    description:
      'Returns the most recent ingested emails for this automation — status, skip reason, error, ' +
      'the ticket produced and whether attachments were imported — plus the mailbox poller health. ' +
      'Returns an empty list with a null mailbox when the automation has no mailbox trigger.',
  })
  @ApiParam({ name: 'id', description: 'Automation UUID' })
  @ApiQuery({
    name: 'spaceId',
    required: false,
    description: "Space UUID — validated against the automation's actual space",
  })
  @ApiResponse({ status: 200, description: 'Inbound email overview' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Lacks can_view_automations in this space',
  })
  @ApiResponse({
    status: 404,
    description: 'Automation not found in this organization',
  })
  async listInboundEmails(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    // Org scope first: getById filters by organization_id, so an automation belonging to another
    // tenant 404s here rather than leaking its email subjects and sender addresses.
    const automation = await this.automationsService.getById(
      id,
      user.organizationId,
    );

    await this.assertCanView(user, automation.space_id, spaceId);

    const data = await this.inboundEmailService.getOverview(
      id,
      automation.space_id,
    );

    return { data };
  }

  /**
   * Space-permission check, done inline rather than with SpacePermissionsGuard.
   *
   * That guard resolves the space as `params.spaceId || params.id || query.spaceId`, and on a
   * `/automations/:id/...` route `params.id` is the AUTOMATION id — so the guard would test
   * membership of a space that does not exist and reject everyone. That is why the sibling
   * `:id/runs` routes carry no space guard at all.
   *
   * resolveSpaceBaseGrant + spaceGrantAllows are the guard's own primitives, so this reaches the
   * same verdict it would; re-implementing the rule instead is what let two copies drift apart
   * before (see the comment in space-permissions.guard.ts).
   */
  private async assertCanView(
    user: RequestUser,
    automationSpaceId: string,
    requestedSpaceId?: string,
  ): Promise<void> {
    if (requestedSpaceId && requestedSpaceId !== automationSpaceId) {
      throw new ForbiddenException('spaceId does not match this automation');
    }

    const grant = await this.permissionsService.resolveSpaceBaseGrant(
      user.userId,
      user.organizationId,
      automationSpaceId,
    );

    if (!grant.isAdmin && !grant.isMember) {
      throw new ForbiddenException('Not a member of this space');
    }

    if (!spaceGrantAllows(grant, REQUIRED_PERMISSION)) {
      throw new ForbiddenException(
        'You do not have permission to view automations in this space',
      );
    }
  }
}
