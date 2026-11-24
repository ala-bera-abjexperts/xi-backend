/**
 * @fileoverview Routes for space Overall Budget records (Resource Planning >
 * Overall Budget). All routes live under the global `api/v1` prefix with base
 * path `resource-planning`.
 * @module src/resource-planning/overall-budget/overall-budget.controller
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
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
  CreateOverallBudgetDto,
  UpdateOverallBudgetDto,
} from './dto/overall-budget.dto';
import { OverallBudgetService } from './overall-budget.service';

@RequireFeature('module_resource_planning')
@UseGuards(PermissionsGuard)
@ApiTags('Resource Planning')
@ApiBearerAuth()
@Controller('resource-planning')
export class OverallBudgetController {
  constructor(private readonly service: OverallBudgetService) {}

  @Get('spaces/:spaceId/overall-budgets')
  @RequirePermissions('can_view_resource_planning')
  @ApiOperation({ summary: "List a space's overall budgets" })
  @ApiParam({ name: 'spaceId', description: 'Space ID' })
  async list(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ) {
    return this.service.list(user, spaceId);
  }

  @Post('spaces/:spaceId/overall-budgets')
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Create an overall budget in a space' })
  @ApiParam({ name: 'spaceId', description: 'Space ID' })
  async create(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: CreateOverallBudgetDto,
  ) {
    const data = await this.service.create(user, spaceId, dto);
    return { data, success: true };
  }

  @Patch('overall-budgets/:id')
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Update an overall budget' })
  @ApiParam({ name: 'id', description: 'Overall budget ID' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOverallBudgetDto,
  ) {
    const data = await this.service.update(user, id, dto);
    return { data, success: true };
  }

  @Delete('overall-budgets/:id')
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Delete an overall budget' })
  @ApiParam({ name: 'id', description: 'Overall budget ID' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.remove(user, id);
  }
}
