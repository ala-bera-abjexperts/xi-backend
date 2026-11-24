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
import { CalendarAdminService } from './calendar-admin.service';
import {
  CreateHolidaySchemeDayDto,
  UpdateHolidaySchemeDayDto,
} from './dto/holiday-scheme-day.dto';
import { AssignHolidaySchemeMemberDto } from './dto/holiday-scheme-member.dto';
import {
  CreateHolidaySchemeDto,
  UpdateHolidaySchemeDto,
} from './dto/holiday-scheme.dto';
import { AssignWorkloadSchemeMemberDto } from './dto/workload-scheme-member.dto';
import {
  CreateWorkloadSchemeDto,
  UpdateWorkloadSchemeDto,
} from './dto/workload-scheme.dto';

@RequireFeature('module_resource_planning')
@UseGuards(PermissionsGuard)
@ApiTags('Resource Planning')
@ApiBearerAuth()
@Controller('resource-planning')
export class CalendarAdminController {
  constructor(private readonly service: CalendarAdminService) {}

  // ==========================================================================
  // Workload schemes
  // ==========================================================================

  @Get('workload-schemes')
  @RequirePermissions('can_view_resource_planning')
  @ApiOperation({ summary: 'List workload schemes' })
  async listWorkloadSchemes(
    @CurrentUser() user: RequestUser,
    @Query('include_inactive') includeInactive?: string,
  ) {
    const data = await this.service.listWorkloadSchemes(
      user.organizationId,
      includeInactive === 'true',
    );
    return { data, count: data.length };
  }

  @Post('workload-schemes')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Create a workload scheme' })
  async createWorkloadScheme(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateWorkloadSchemeDto,
  ) {
    const data = await this.service.createWorkloadScheme(
      user.organizationId,
      user.userId,
      dto,
    );
    return { data, success: true };
  }

  @Patch('workload-schemes/:id')
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Update a workload scheme' })
  async updateWorkloadScheme(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkloadSchemeDto,
  ) {
    const data = await this.service.updateWorkloadScheme(
      id,
      user.organizationId,
      user.userId,
      dto,
    );
    return { data, success: true };
  }

  @Delete('workload-schemes/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Deactivate a workload scheme' })
  async deactivateWorkloadScheme(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const data = await this.service.deactivateWorkloadScheme(
      id,
      user.organizationId,
      user.userId,
    );
    return { data, success: true };
  }

  @Get('workload-scheme-members')
  @RequirePermissions('can_view_resource_planning')
  @ApiOperation({ summary: 'List workload scheme member assignments' })
  async listWorkloadSchemeMembers(@CurrentUser() user: RequestUser) {
    const data = await this.service.listWorkloadSchemeMembers(
      user.organizationId,
    );
    return { data, count: data.length };
  }

  @Post('workload-scheme-members')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Assign a user to a workload scheme' })
  async assignWorkloadSchemeMember(
    @CurrentUser() user: RequestUser,
    @Body() dto: AssignWorkloadSchemeMemberDto,
  ) {
    const data = await this.service.assignWorkloadSchemeMember(
      user.organizationId,
      user.userId,
      dto,
    );
    return { data, success: true };
  }

  @Delete('workload-scheme-members/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Remove a workload scheme member assignment' })
  async removeWorkloadSchemeMember(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.removeWorkloadSchemeMember(id, user.organizationId);
    return { success: true };
  }

  // ==========================================================================
  // Holiday schemes
  // ==========================================================================

  @Get('holiday-schemes')
  @RequirePermissions('can_view_resource_planning')
  @ApiOperation({ summary: 'List holiday schemes' })
  async listHolidaySchemes(
    @CurrentUser() user: RequestUser,
    @Query('include_inactive') includeInactive?: string,
  ) {
    const data = await this.service.listHolidaySchemes(
      user.organizationId,
      includeInactive === 'true',
    );
    return { data, count: data.length };
  }

  @Post('holiday-schemes')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Create a holiday scheme' })
  async createHolidayScheme(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateHolidaySchemeDto,
  ) {
    const data = await this.service.createHolidayScheme(
      user.organizationId,
      user.userId,
      dto,
    );
    return { data, success: true };
  }

  @Patch('holiday-schemes/:id')
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Update a holiday scheme' })
  async updateHolidayScheme(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateHolidaySchemeDto,
  ) {
    const data = await this.service.updateHolidayScheme(
      id,
      user.organizationId,
      user.userId,
      dto,
    );
    return { data, success: true };
  }

  @Delete('holiday-schemes/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Deactivate a holiday scheme' })
  async deactivateHolidayScheme(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const data = await this.service.deactivateHolidayScheme(
      id,
      user.organizationId,
      user.userId,
    );
    return { data, success: true };
  }

  @Get('holiday-scheme-days')
  @RequirePermissions('can_view_resource_planning')
  @ApiOperation({ summary: 'List holiday scheme days' })
  async listHolidaySchemeDays(
    @CurrentUser() user: RequestUser,
    @Query('scheme_id') schemeId?: string,
  ) {
    const data = await this.service.listHolidaySchemeDays(
      user.organizationId,
      schemeId,
    );
    return { data, count: data.length };
  }

  @Post('holiday-scheme-days')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Create a holiday scheme day' })
  async createHolidaySchemeDay(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateHolidaySchemeDayDto,
  ) {
    const data = await this.service.createHolidaySchemeDay(
      user.organizationId,
      user.userId,
      dto,
    );
    return { data, success: true };
  }

  @Patch('holiday-scheme-days/:id')
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Update a holiday scheme day' })
  async updateHolidaySchemeDay(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateHolidaySchemeDayDto,
  ) {
    const data = await this.service.updateHolidaySchemeDay(
      id,
      user.organizationId,
      user.userId,
      dto,
    );
    return { data, success: true };
  }

  @Delete('holiday-scheme-days/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Delete a holiday scheme day' })
  async deleteHolidaySchemeDay(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.deleteHolidaySchemeDay(id, user.organizationId);
    return { success: true };
  }

  @Get('holiday-scheme-members')
  @RequirePermissions('can_view_resource_planning')
  @ApiOperation({ summary: 'List holiday scheme member assignments' })
  async listHolidaySchemeMembers(@CurrentUser() user: RequestUser) {
    const data = await this.service.listHolidaySchemeMembers(
      user.organizationId,
    );
    return { data, count: data.length };
  }

  @Post('holiday-scheme-members')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Assign a user to a holiday scheme' })
  async assignHolidaySchemeMember(
    @CurrentUser() user: RequestUser,
    @Body() dto: AssignHolidaySchemeMemberDto,
  ) {
    const data = await this.service.assignHolidaySchemeMember(
      user.organizationId,
      user.userId,
      dto,
    );
    return { data, success: true };
  }

  @Delete('holiday-scheme-members/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Remove a holiday scheme member assignment' })
  async removeHolidaySchemeMember(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.removeHolidaySchemeMember(id, user.organizationId);
    return { success: true };
  }
}
