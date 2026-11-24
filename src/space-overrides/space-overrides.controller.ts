/**
 * @fileoverview REST controller for `/space-overrides` — space-level entity overrides.
 * Handles priority, status, and custom_field overrides per space.
 * Mirrors risk-management-app /api/space-overrides with exact response parity.
 * @module src/space-overrides/space-overrides.controller
 */

import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { PermissionsService } from '../permissions/permissions.service';
import { SpaceOverridesService } from './space-overrides.service';
import { SetSpaceOverrideDto } from './dto/set-space-override.dto';

@ApiTags('Space Overrides')
@ApiBearerAuth()
@Controller('space-overrides')
export class SpaceOverridesController {
  constructor(
    private readonly service: SpaceOverridesService,
    private readonly permissionsService: PermissionsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Get space overrides by type',
    description:
      'Returns a map of entityId → isEnabled for the given space and override type.',
  })
  @ApiQuery({ name: 'spaceId', required: true })
  @ApiQuery({
    name: 'type',
    required: true,
    enum: ['priority', 'status', 'custom_field'],
  })
  async getOverrides(
    @CurrentUser() user: RequestUser,
    @Query('spaceId') spaceId?: string,
    @Query('type') type?: string,
  ) {
    if (!spaceId || !type) {
      throw new BadRequestException(
        'spaceId and valid type (priority, status, custom_field) are required',
      );
    }

    if (!['priority', 'status', 'custom_field'].includes(type)) {
      throw new BadRequestException(
        'Invalid type. Must be priority, status, or custom_field',
      );
    }

    const data = await this.service.getOverrides(
      user.organizationId,
      spaceId,
      type as 'priority' | 'status' | 'custom_field',
    );
    return { data };
  }

  @Post()
  @HttpCode(200)
  @UseGuards(PermissionsGuard)
  @RequirePermissions(
    ['can_edit_priorities', 'can_edit_statuses', 'can_manage_custom_fields'],
    { any: true },
  )
  @ApiOperation({ summary: 'Set a space override (upsert)' })
  async setOverride(
    @CurrentUser() user: RequestUser,
    @Body() dto: SetSpaceOverrideDto,
  ) {
    await this.assertCanManageOverride(user, dto);
    await this.service.setOverride(user.organizationId, user.userId, dto);
    return { success: true };
  }

  private async assertCanManageOverride(
    user: RequestUser,
    dto: SetSpaceOverrideDto,
  ): Promise<void> {
    const required = {
      priority: {
        organization: 'can_edit_priorities',
        space: 'edit_priorities',
      },
      status: {
        organization: 'can_edit_statuses',
        space: 'edit_statuses',
      },
      custom_field: {
        organization: 'can_manage_custom_fields',
        space: 'edit_custom_fields',
      },
    }[dto.type];

    const hasOrganizationPermission =
      await this.permissionsService.checkPermission(
        user.userId,
        user.organizationId,
        required.organization,
      );

    if (hasOrganizationPermission) return;

    const spacePermissions =
      await this.permissionsService.getUserSpacePermissions(
        user.userId,
        user.organizationId,
        dto.spaceId,
      );

    if (spacePermissions.permissions[required.space] === true) return;

    throw new ForbiddenException('Insufficient permissions');
  }
}
