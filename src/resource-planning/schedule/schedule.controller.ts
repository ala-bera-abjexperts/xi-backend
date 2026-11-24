/**
 * @fileoverview Controller for the Resource Planning 2.0, Sub Task 2 schedule endpoint.
 * @module src/resource-planning/schedule/schedule.controller
 */

import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequireFeature } from '../../auth/decorators/require-feature.decorator';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { ScheduleQueryDto } from './dto/schedule-query.dto';
import { ScheduleService } from './schedule.service';

@RequireFeature('module_resource_planning')
@UseGuards(PermissionsGuard)
@ApiTags('Resource Planning')
@ApiBearerAuth()
@Controller('resource-planning')
export class ScheduleController {
  constructor(private readonly scheduleService: ScheduleService) {}

  @Get('schedule')
  @RequirePermissions('can_view_resource_planning')
  @ApiOperation({
    summary: 'Per-user-per-day/week capacity and dated assignments',
  })
  async getSchedule(
    @CurrentUser() user: RequestUser,
    @Query() query: ScheduleQueryDto,
  ) {
    const data = await this.scheduleService.getSchedule(
      user.organizationId,
      {
        from: query.from,
        to: query.to,
        granularity: query.granularity ?? 'week',
        unitIds: query.unit_ids,
        userIds: query.user_ids,
        roles: query.roles,
        portfolioId: query.portfolio_id,
        planIds: query.plan_ids,
        spaceId: query.space_id,
      },
      user.userId,
    );
    return { data };
  }

  @Get('schedule/roles')
  @RequirePermissions('can_view_resource_planning')
  @ApiOperation({
    summary: 'Distinct role labels in use across plan/task allocations',
  })
  async getScheduleRoles(@CurrentUser() user: RequestUser) {
    return {
      data: await this.scheduleService.listDistinctRoles(user.organizationId),
    };
  }
}
