/**
 * @fileoverview Routes for the org-level Planning roster (Resource Planning >
 * Capacity and rates). All routes live under the global `api/v1` prefix with
 * base path `resource-planning`.
 * @module src/resource-planning/roster/planning-roster.controller
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequireFeature } from '../../auth/decorators/require-feature.decorator';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import {
  AddPlanningRosterGroupDto,
  AddPlanningRosterUsersDto,
  ListPlanningRosterQueryDto,
} from './dto/planning-roster.dto';
import { PlanningRosterService } from './planning-roster.service';

@RequireFeature('module_resource_planning')
@UseGuards(PermissionsGuard)
@ApiTags('Resource Planning')
@ApiBearerAuth()
@Controller('resource-planning')
export class PlanningRosterController {
  constructor(private readonly service: PlanningRosterService) {}

  @Get('roster')
  @RequirePermissions('can_view_resource_planning')
  @ApiOperation({ summary: 'List the planning roster for the organization' })
  async list(
    @CurrentUser() user: RequestUser,
    @Query() query: ListPlanningRosterQueryDto,
  ) {
    return this.service.list(user.organizationId, query);
  }

  @Post('roster/users')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Add employees to the planning roster' })
  async addUsers(
    @CurrentUser() user: RequestUser,
    @Body() dto: AddPlanningRosterUsersDto,
  ) {
    const data = await this.service.addUsers(user, dto.user_ids);
    return { data, success: true };
  }

  @Post('roster/groups')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({
    summary: "Add a user group's members to the planning roster",
  })
  async addGroup(
    @CurrentUser() user: RequestUser,
    @Body() dto: AddPlanningRosterGroupDto,
  ) {
    const data = await this.service.addGroup(user, dto.group_id);
    return { data, success: true };
  }

  @Delete('roster/:userId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Remove an employee from the planning roster' })
  @ApiParam({ name: 'userId', description: 'Target user ID' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('userId', ParseUUIDPipe) targetUserId: string,
  ) {
    const { removed } = await this.service.remove(user, targetUserId);
    return { success: true, removed };
  }
}
