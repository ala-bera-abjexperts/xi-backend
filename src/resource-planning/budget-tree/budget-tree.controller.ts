import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequireFeature } from '../../auth/decorators/require-feature.decorator';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { BudgetCostCategoriesService } from './budget-cost-categories.service';
import { BudgetTimelineService } from './budget-timeline.service';
import { BudgetTreeService } from './budget-tree.service';
import {
  CreateBudgetCostCategoryDto,
  UpdateBudgetCostCategoryDto,
} from './dto/budget-cost-category.dto';
import { BudgetTimelineQueryDto } from './dto/budget-timeline-query.dto';
import { BudgetTreeQueryDto } from './dto/budget-tree-query.dto';

@RequireFeature('module_resource_planning')
@UseGuards(PermissionsGuard)
@ApiTags('Resource Planning')
@ApiBearerAuth()
@Controller('resource-planning')
export class BudgetTreeController {
  constructor(
    private readonly categoriesService: BudgetCostCategoriesService,
    private readonly treeService: BudgetTreeService,
    private readonly timelineService: BudgetTimelineService,
  ) {}

  @Get('budget-categories')
  @RequirePermissions('can_view_resource_planning')
  @ApiOperation({ summary: 'List budget cost categories' })
  async listCategories(
    @CurrentUser() user: RequestUser,
    @Query('include_inactive') includeInactive?: string,
  ) {
    const data = await this.categoriesService.list(
      user.organizationId,
      includeInactive === 'true',
    );
    return { data, count: data.length };
  }

  @Post('budget-categories')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Create a budget cost category' })
  async createCategory(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateBudgetCostCategoryDto,
  ) {
    const data = await this.categoriesService.create(
      user.organizationId,
      user.userId,
      dto,
    );
    return { data, success: true };
  }

  @Patch('budget-categories/:id')
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Update a budget cost category' })
  async updateCategory(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBudgetCostCategoryDto,
  ) {
    const data = await this.categoriesService.update(
      id,
      user.organizationId,
      user.userId,
      dto,
    );
    return { data, success: true };
  }

  @Delete('budget-categories/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Deactivate a budget cost category' })
  async deactivateCategory(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const data = await this.categoriesService.deactivate(
      id,
      user.organizationId,
      user.userId,
    );
    return { data, success: true };
  }

  @Post('budget-categories/seed-defaults')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Seed the default RC/NRC cost category set' })
  async seedDefaultCategories(@CurrentUser() user: RequestUser) {
    const data = await this.categoriesService.seedDefaults(
      user.organizationId,
      user.userId,
    );
    return { data, count: data.length };
  }

  @Get('tasks/:taskId/budget-tree')
  @RequirePermissions('can_view_resource_planning')
  @ApiOperation({ summary: 'Get the budget rollup tree for a task' })
  async getBudgetTree(
    @CurrentUser() user: RequestUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Query() query: BudgetTreeQueryDto,
  ) {
    const data = await this.treeService.getBudgetTree(
      taskId,
      user.organizationId,
      user.userId,
      {
        depth: query.depth,
        spaceId: query.space_id,
        includeDependencies: query.include_dependencies,
      },
    );
    return { data };
  }

  @Get('tasks/:taskId/budget-timeline')
  @RequirePermissions('can_view_resource_planning')
  @ApiOperation({
    summary:
      'Get the month timeline (bars, planned budget and hours per month) for a task tree',
  })
  async getBudgetTimeline(
    @CurrentUser() user: RequestUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Query() query: BudgetTimelineQueryDto,
  ) {
    const data = await this.timelineService.getTimeline(
      taskId,
      user.organizationId,
      user.userId,
      {
        depth: query.depth,
        spaceId: query.space_id,
        from: query.from,
        to: query.to,
        tz: query.tz,
      },
    );
    return { data };
  }
}
