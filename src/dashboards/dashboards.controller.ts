/**
 * @fileoverview REST controller for `/dashboards` — dashboard CRUD,
 * widget management, widget data, permissions, and analytics.
 * @module src/dashboards/dashboards.controller
 */

import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  InternalServerErrorException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { HeatmapService } from '../heatmap/heatmap.service';
import { GenerateHeatmapBodyDto } from '../heatmap/dto/generate-heatmap-body.dto';
import { GenerateHeatmapQueryDto } from '../heatmap/dto/generate-heatmap-query.dto';
import { RiskSummaryQueryDto } from '../heatmap/dto/risk-summary-query.dto';
import { DashboardsService } from './dashboards.service';
import { CreateDashboardDto } from './dto/create-dashboard.dto';
import { UpdateDashboardDto } from './dto/update-dashboard.dto';
import { PatchDashboardDto } from './dto/patch-dashboard.dto';
import { CreateWidgetDto } from './dto/create-widget.dto';
import { UpdateWidgetDto } from './dto/update-widget.dto';
import { UpdateLayoutDto } from './dto/update-layout.dto';
import { CreatePermissionDto } from './dto/create-permission.dto';
import { UpdatePermissionDto } from './dto/update-permission.dto';

@RequireFeature('module_dashboards')
@ApiTags('Dashboards')
@ApiBearerAuth()
@Controller('dashboards')
export class DashboardsController {
  constructor(
    private readonly service: DashboardsService,
    private readonly heatmapService: HeatmapService,
  ) {}

  // ---- Static paths first (before /:id) ----------------------------------

  @Get('risk-summary')
  @ApiOperation({
    summary: 'Get legacy-compatible heatmap risk summary for the organisation',
  })
  @ApiQuery({ name: 'spaceId', required: false })
  @ApiResponse({ status: 200, description: 'Risk summary returned' })
  async getRiskSummary(
    @CurrentUser() user: RequestUser,
    @Query() query: RiskSummaryQueryDto,
  ) {
    return this.requireSuccessfulHeatmapResult(
      await this.heatmapService.getRiskSummary(
        user.organizationId,
        user.userId,
        {
          requestTypes: query.requestTypes?.split(',').filter(Boolean),
          status: query.status?.split(',').filter(Boolean) ?? ['active'],
          spaceId: query.spaceId,
        },
      ),
    );
  }

  @Get('heatmap')
  @ApiOperation({ summary: 'Get legacy-compatible risk heatmap matrix data' })
  @ApiQuery({ name: 'spaceId', required: false })
  @ApiResponse({ status: 200, description: 'Heatmap data returned' })
  async getHeatmap(
    @CurrentUser() user: RequestUser,
    @Query() query: GenerateHeatmapQueryDto,
  ) {
    return this.requireSuccessfulHeatmapResult(
      await this.heatmapService.generateHeatmapData(
        user.organizationId,
        user.userId,
        this.parseHeatmapQueryConfig(query),
      ),
    );
  }

  @Post('heatmap')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Generate legacy-compatible risk heatmap matrix data',
  })
  @ApiResponse({ status: 200, description: 'Heatmap data returned' })
  async generateHeatmapPost(
    @CurrentUser() user: RequestUser,
    @Body() dto: GenerateHeatmapBodyDto,
  ) {
    return this.requireSuccessfulHeatmapResult(
      await this.heatmapService.generateHeatmapData(
        user.organizationId,
        user.userId,
        this.parseHeatmapBodyConfig(dto),
      ),
    );
  }

  // ---- Dashboard CRUD ----------------------------------------------------

  @Get()
  @ApiOperation({ summary: 'List dashboards with optional filters' })
  @ApiQuery({ name: 'spaceId', required: false })
  @ApiQuery({ name: 'includeOrgLevel', required: false })
  @ApiQuery({ name: 'default', required: false })
  @ApiQuery({ name: 'is_default', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'visibility', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'pageSize', required: false })
  @ApiResponse({ status: 200, description: 'Paginated dashboards returned' })
  async list(
    @CurrentUser() user: RequestUser,
    @Query('spaceId') spaceId?: string,
    @Query('includeOrgLevel') includeOrgLevel?: string,
    @Query('default') defaultDashboard?: string,
    @Query('is_default') is_default?: string,
    @Query('status') status?: string,
    @Query('visibility') visibility?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.getAll(
      user.organizationId,
      {
        spaceId,
        includeOrgLevel: includeOrgLevel === 'true',
        default: defaultDashboard === 'true',
        is_default:
          is_default !== undefined ? is_default === 'true' : undefined,
        status,
        visibility,
        search,
        page: page ? parseInt(page, 10) : undefined,
        pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
      },
      user.userId,
    );
  }

  @Post()
  @ApiOperation({ summary: 'Create a dashboard' })
  @ApiResponse({ status: 201, description: 'Dashboard created' })
  async create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateDashboardDto,
  ) {
    return this.service.create(user.organizationId, user.userId, dto);
  }

  private parseHeatmapQueryConfig(
    query: GenerateHeatmapQueryDto,
  ): GenerateHeatmapBodyDto {
    return {
      matrixSize: query.matrixSize
        ? Math.min(Math.max(parseInt(query.matrixSize, 10) || 5, 2), 5)
        : 5,
      showIssueCount: query.showIssueCount !== 'false',
      title: query.title ?? 'ISMS Risk Assessment Matrix',
      requestTypes: query.requestTypes?.split(',').filter(Boolean),
      status: query.status?.split(',').filter(Boolean) ?? ['active'],
      coloringMode:
        (query.coloringMode as 'risk-level' | 'individual-cells') ??
        'risk-level',
      cellFontSize: query.cellFontSize,
      spaceId: query.spaceId,
    };
  }

  private parseHeatmapBodyConfig(
    dto: GenerateHeatmapBodyDto,
  ): GenerateHeatmapBodyDto {
    const { config, ...direct } = dto as GenerateHeatmapBodyDto & {
      organizationId?: string;
    };
    delete (direct as Record<string, unknown>)['organizationId'];
    return (config ?? direct) as GenerateHeatmapBodyDto;
  }

  private requireSuccessfulHeatmapResult<
    T extends { success?: boolean; error?: unknown },
  >(result: T): T {
    if (result?.success === false) {
      throw new InternalServerErrorException(
        typeof result.error === 'string'
          ? result.error
          : 'Failed to generate heatmap data',
      );
    }

    return result;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a dashboard by ID' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Dashboard returned' })
  async getById(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getByIdWithUserPermissions(
      id,
      user.organizationId,
      user.userId,
    );
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a dashboard' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Dashboard updated' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDashboardDto,
  ) {
    return this.service.update(id, user.organizationId, user.userId, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Dashboard actions: set_default or archive' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Action applied' })
  async patch(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchDashboardDto,
  ) {
    if (dto.action === 'set_default') {
      return this.service.setAsDefault(id, user.organizationId, user.userId);
    }
    return this.service.archive(id, user.organizationId, user.userId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete a dashboard (cannot delete default)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Dashboard deleted' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.delete(id, user.organizationId, user.userId);
    return { success: true, message: 'Dashboard deleted' };
  }

  // ---- Widgets -----------------------------------------------------------

  @Get(':id/widgets')
  @ApiOperation({ summary: 'List widgets for a dashboard' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Widgets returned' })
  async listWidgets(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const data = await this.service.getWidgets(
      id,
      user.organizationId,
      user.userId,
    );
    return { data, count: data.length };
  }

  @Post(':id/widgets')
  @ApiOperation({ summary: 'Add a widget to a dashboard' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 201, description: 'Widget created' })
  async createWidget(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateWidgetDto,
  ) {
    return this.service.createWidget(id, user.organizationId, user.userId, dto);
  }

  @Get(':id/widgets/layout')
  @ApiOperation({ summary: 'Get layout positions for all widgets' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Layout returned' })
  async getLayout(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getLayout(id, user.organizationId, user.userId);
  }

  @Patch(':id/widgets/layout')
  @ApiOperation({ summary: 'Bulk-update widget positions' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Layout updated' })
  async updateLayout(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLayoutDto,
  ) {
    await this.service.updateLayout(id, user.organizationId, user.userId, dto);
    return { success: true };
  }

  @Get(':id/widgets/:wid')
  @ApiOperation({ summary: 'Get a single widget' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'wid' })
  @ApiResponse({ status: 200, description: 'Widget returned' })
  async getWidget(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('wid', ParseUUIDPipe) wid: string,
  ) {
    return this.service.getWidgetById(
      id,
      wid,
      user.organizationId,
      user.userId,
    );
  }

  @Put(':id/widgets/:wid')
  @ApiOperation({ summary: 'Update a widget' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'wid' })
  @ApiResponse({ status: 200, description: 'Widget updated' })
  async updateWidget(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('wid', ParseUUIDPipe) wid: string,
    @Body() dto: UpdateWidgetDto,
  ) {
    return this.service.updateWidget(
      id,
      wid,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Delete(':id/widgets/:wid')
  @ApiOperation({ summary: 'Soft-delete a widget' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'wid' })
  @ApiResponse({ status: 200, description: 'Widget deleted' })
  async deleteWidget(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('wid', ParseUUIDPipe) wid: string,
  ) {
    await this.service.deleteWidget(id, wid, user.organizationId, user.userId);
    return { success: true, message: 'Widget deleted' };
  }

  @Get(':id/widgets/:wid/data')
  @ApiOperation({
    summary: 'Fetch widget data (saved_filter / custom_query / simple modes)',
  })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'wid' })
  @ApiQuery({ name: 'spaceId', required: false })
  @ApiQuery({ name: 'sprintId', required: false })
  @ApiResponse({ status: 200, description: 'Widget data returned' })
  async getWidgetData(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('wid', ParseUUIDPipe) wid: string,
    @Query('spaceId') spaceId?: string,
    @Query('offset') offset?: string,
    @Query('sprintId', new ParseUUIDPipe({ optional: true }))
    sprintId?: string,
  ) {
    return this.service.getWidgetData(
      id,
      wid,
      user.organizationId,
      user.userId,
      spaceId,
      offset === undefined ? 0 : Number(offset),
      sprintId,
    );
  }

  @Patch(':id/widgets/:wid/filter-targets')
  @ApiOperation({ summary: 'Set filter widget targets' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'wid' })
  @ApiResponse({ status: 200, description: 'Filter targets updated' })
  async setFilterTargets(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('wid', ParseUUIDPipe) wid: string,
    @Body('targetIds') targetIds: string[],
  ) {
    await this.service.setFilterTargets(
      id,
      wid,
      user.organizationId,
      user.userId,
      targetIds ?? [],
    );
    return { success: true };
  }

  // ---- Permissions -------------------------------------------------------

  @Get(':id/permissions')
  @ApiOperation({ summary: 'List dashboard permissions' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Permissions returned' })
  async listPermissions(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const data = await this.service.getPermissions(
      id,
      user.organizationId,
      user.userId,
    );
    return { data, count: data.length };
  }

  @Post(':id/permissions')
  @ApiOperation({ summary: 'Grant a dashboard permission' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 201, description: 'Permission granted' })
  async grantPermission(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreatePermissionDto,
  ) {
    const data = await this.service.grantPermission(
      id,
      user.organizationId,
      user.userId,
      dto,
    );
    return { data, success: true };
  }

  @Put(':id/permissions/:pid')
  @Patch(':id/permissions/:pid')
  @ApiOperation({ summary: 'Update a permission level' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'pid' })
  @ApiResponse({ status: 200, description: 'Permission updated' })
  async updatePermission(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('pid', ParseUUIDPipe) pid: string,
    @Body() dto: UpdatePermissionDto,
  ) {
    const data = await this.service.updatePermission(
      id,
      pid,
      user.organizationId,
      user.userId,
      dto,
    );
    return { data, success: true };
  }

  @Delete(':id/permissions/:pid')
  @ApiOperation({ summary: 'Revoke a dashboard permission' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'pid' })
  @ApiResponse({ status: 200, description: 'Permission revoked' })
  async revokePermission(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('pid', ParseUUIDPipe) pid: string,
  ) {
    await this.service.revokePermission(
      id,
      pid,
      user.organizationId,
      user.userId,
    );
    return { success: true, message: 'Permission revoked successfully' };
  }
}
