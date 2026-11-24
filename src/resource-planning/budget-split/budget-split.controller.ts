/**
 * @fileoverview Routes for Budget Splits (Resource Planning > Ressource Tree).
 * All routes live under the global `api/v1` prefix with base path
 * `resource-planning`.
 * @module src/resource-planning/budget-split/budget-split.controller
 */

import {
  Body,
  Controller,
  Delete,
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
import { BudgetSplitService } from './budget-split.service';
import {
  CreateBudgetSplitDto,
  UpdateBudgetSplitDto,
} from './dto/budget-split.dto';

@RequireFeature('module_resource_planning')
@UseGuards(PermissionsGuard)
@ApiTags('Resource Planning')
@ApiBearerAuth()
@Controller('resource-planning')
export class BudgetSplitController {
  constructor(private readonly service: BudgetSplitService) {}

  @Post('budget-splits')
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Assign part of an overall budget to a task' })
  async create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateBudgetSplitDto,
  ) {
    const data = await this.service.create(user, dto);
    return { data, success: true };
  }

  @Patch('budget-splits/:id')
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Update a budget split' })
  @ApiParam({ name: 'id', description: 'Budget split ID' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBudgetSplitDto,
  ) {
    const data = await this.service.update(user, id, dto);
    return { data, success: true };
  }

  @Delete('budget-splits/:id')
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Delete a budget split' })
  @ApiParam({ name: 'id', description: 'Budget split ID' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.remove(user, id);
  }
}
