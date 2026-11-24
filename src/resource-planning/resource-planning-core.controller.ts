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
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import {
  BudgetEntryQueryDto,
  CreateBudgetEntryDto,
  UpdateBudgetEntryDto,
} from './dto/budget-entry.dto';
import {
  CreateCapacityPeriodDto,
  UpdateCapacityPeriodDto,
} from './dto/capacity-period.dto';
import {
  CreateOrganizationUnitDto,
  UpdateOrganizationUnitDto,
} from './dto/organization-unit.dto';
import {
  CapacityPeriodQueryDto,
  UnitMembershipQueryDto,
} from './dto/resource-planning-common.dto';
import {
  CreateUnitMembershipDto,
  UpdateUnitMembershipDto,
} from './dto/unit-membership.dto';
import { ResourcePlanningCoreService } from './resource-planning-core.service';

@RequireFeature('module_resource_planning')
@UseGuards(PermissionsGuard)
@ApiTags('Resource Planning')
@ApiBearerAuth()
@Controller('resource-planning')
export class ResourcePlanningCoreController {
  constructor(private readonly service: ResourcePlanningCoreService) {}

  @Get('units')
  @RequirePermissions('can_view_resource_planning')
  @ApiOperation({ summary: 'List organization resource-planning units' })
  async listUnits(
    @CurrentUser() user: RequestUser,
    @Query('include_inactive') includeInactive?: string,
    @Query('include_archived') includeArchived?: string,
  ) {
    const data = await this.service.listUnits(
      user.organizationId,
      includeInactive === 'true' || includeArchived === 'true',
    );
    return { data, count: data.length };
  }

  @Post('units')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Create an organization resource-planning unit' })
  async createUnit(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateOrganizationUnitDto,
  ) {
    const data = await this.service.createUnit(
      user.organizationId,
      user.userId,
      dto,
    );
    return { data, success: true };
  }

  @Patch('units/:id')
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Update an organization resource-planning unit' })
  async updateUnit(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOrganizationUnitDto,
  ) {
    const data = await this.service.updateUnit(
      id,
      user.organizationId,
      user.userId,
      dto,
    );
    return { data, success: true };
  }

  @Delete('units/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Archive an organization resource-planning unit' })
  async archiveUnit(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.archiveUnit(id, user.organizationId, user.userId);
    return { success: true };
  }

  @Get('unit-memberships')
  @RequirePermissions('can_view_resource_planning')
  @ApiOperation({ summary: 'List effective-dated unit memberships' })
  async listUnitMemberships(
    @CurrentUser() user: RequestUser,
    @Query() query: UnitMembershipQueryDto,
  ) {
    const data = await this.service.listUnitMemberships(
      user.organizationId,
      query,
    );
    return { data, count: data.length };
  }

  @Post('unit-memberships')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Create an effective-dated unit membership' })
  async createUnitMembership(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateUnitMembershipDto,
  ) {
    const data = await this.service.createUnitMembership(
      user.organizationId,
      user.userId,
      dto,
    );
    return { data, success: true };
  }

  @Patch('unit-memberships/:id')
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Update an effective-dated unit membership' })
  async updateUnitMembership(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUnitMembershipDto,
  ) {
    const data = await this.service.updateUnitMembership(
      id,
      user.organizationId,
      user.userId,
      dto,
    );
    return { data, success: true };
  }

  @Delete('unit-memberships/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Delete an effective-dated unit membership' })
  async deleteUnitMembership(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.deleteUnitMembership(id, user.organizationId);
    return { success: true };
  }

  @Get('capacity-periods')
  @RequirePermissions('can_view_resource_planning')
  @ApiOperation({ summary: 'List effective-dated capacity and cost periods' })
  async listCapacityPeriods(
    @CurrentUser() user: RequestUser,
    @Query() query: CapacityPeriodQueryDto,
  ) {
    const data = await this.service.listCapacityPeriods(
      user.organizationId,
      query,
    );
    return { data, count: data.length };
  }

  @Post('capacity-periods')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Create an effective-dated capacity period' })
  async createCapacityPeriod(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateCapacityPeriodDto,
  ) {
    const data = await this.service.createCapacityPeriod(
      user.organizationId,
      user.userId,
      dto,
    );
    return { data, success: true };
  }

  @Patch('capacity-periods/:id')
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Update an effective-dated capacity period' })
  async updateCapacityPeriod(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCapacityPeriodDto,
  ) {
    const data = await this.service.updateCapacityPeriod(
      id,
      user.organizationId,
      user.userId,
      dto,
    );
    return { data, success: true };
  }

  @Delete('capacity-periods/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Delete an effective-dated capacity period' })
  async deleteCapacityPeriod(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.deleteCapacityPeriod(id, user.organizationId);
    return { success: true };
  }

  @Get('budget-entries')
  @RequirePermissions('can_view_resource_planning')
  @ApiOperation({ summary: 'List plan or task resource budget entries' })
  async listBudgetEntries(
    @CurrentUser() user: RequestUser,
    @Query() query: BudgetEntryQueryDto,
  ) {
    const data = await this.service.listBudgetEntries(
      user.organizationId,
      user.userId,
      query,
    );
    return { data, count: data.length };
  }

  @Post('budget-entries')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Create a plan or task resource budget entry' })
  async createBudgetEntry(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateBudgetEntryDto,
  ) {
    const data = await this.service.createBudgetEntry(
      user.organizationId,
      user.userId,
      dto,
    );
    return { data, success: true };
  }

  @Patch('budget-entries/:id')
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Update a resource budget entry' })
  async updateBudgetEntry(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBudgetEntryDto,
  ) {
    const data = await this.service.updateBudgetEntry(
      id,
      user.organizationId,
      user.userId,
      dto,
    );
    return { data, success: true };
  }

  @Delete('budget-entries/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Delete a resource budget entry' })
  async deleteBudgetEntry(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.deleteBudgetEntry(id, user.organizationId, user.userId);
    return { success: true };
  }
}
