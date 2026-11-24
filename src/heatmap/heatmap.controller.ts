/**
 * @fileoverview REST controller for `/heatmap` — heatmap config, data generation, and risk summary.
 * @module src/heatmap/heatmap.controller
 */

import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  InternalServerErrorException,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { HeatmapService } from './heatmap.service';
import { HeatmapConfigDto } from './dto/heatmap-config.dto';
import { GenerateHeatmapQueryDto } from './dto/generate-heatmap-query.dto';
import { GenerateHeatmapBodyDto } from './dto/generate-heatmap-body.dto';
import { RiskSummaryQueryDto } from './dto/risk-summary-query.dto';

@RequireFeature('module_heatmap')
@ApiTags('Heatmap')
@ApiBearerAuth()
@Controller('heatmap')
export class HeatmapController {
  constructor(private readonly service: HeatmapService) {}

  // ── Heatmap Data ──────────────────────────────────────────────────────

  /**
   * GET /heatmap
   * Generates heatmap matrix data using query-param configuration.
   * Response: { success, heatMapData, configuration, metadata }
   */
  @Get()
  @ApiOperation({ summary: 'Generate heatmap matrix from query params' })
  async generateGet(
    @CurrentUser() user: RequestUser,
    @Query() query: GenerateHeatmapQueryDto,
  ): Promise<unknown> {
    const result = await this.service.generateHeatmapData(
      user.organizationId,
      user.userId,
      this.parseQueryConfig(query),
    );
    this.throwIfGenerationFailed(result);
    return result;
  }

  /**
   * POST /heatmap
   * Generates heatmap matrix data using full config in request body.
   * Response: { success, heatMapData, configuration, metadata }
   */
  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Generate heatmap matrix from body config' })
  async generatePost(
    @CurrentUser() user: RequestUser,
    @Body() dto: GenerateHeatmapBodyDto,
  ): Promise<unknown> {
    const result = await this.service.generateHeatmapData(
      user.organizationId,
      user.userId,
      this.parseBodyConfig(dto),
    );
    this.throwIfGenerationFailed(result);
    return result;
  }

  /**
   * GET /heatmap/risk-summary
   * Returns processes grouped by probability×impact with risk level labels.
   * Response: { success, riskSummary: [...], totalRisks: number }
   */
  @Get('risk-summary')
  @ApiOperation({ summary: 'Get risk summary grouped by probability/impact' })
  async riskSummary(
    @CurrentUser() user: RequestUser,
    @Query() query: RiskSummaryQueryDto,
  ): Promise<unknown> {
    return this.service.getRiskSummary(user.organizationId, user.userId, {
      requestTypes: query.requestTypes?.split(',').filter(Boolean),
      status: query.status?.split(',').filter(Boolean) ?? ['active'],
      spaceId: query.spaceId,
    });
  }

  // ── Heatmap Configuration ─────────────────────────────────────────────

  /**
   * GET /heatmap/config
   * Returns the saved config or built-in defaults.
   * Response: { config: HeatmapConfiguration, isDefault: boolean }
   */
  @Get('config')
  @ApiOperation({
    summary: 'Get heatmap configuration (returns default if not set)',
  })
  async getConfig(@CurrentUser() user: RequestUser): Promise<unknown> {
    return this.service.getConfig(user.organizationId, user.userId);
  }

  /**
   * POST /heatmap/config
   * Creates a new heatmap configuration.
   * Response: { config: HeatmapConfiguration }
   */
  @Post('config')
  @ApiOperation({ summary: 'Create heatmap configuration' })
  async createConfig(
    @CurrentUser() user: RequestUser,
    @Body() dto: HeatmapConfigDto,
  ): Promise<unknown> {
    return this.service.createConfig(
      user.organizationId,
      user.userId,
      this.parseConfigPayload(dto),
    );
  }

  /**
   * PUT /heatmap/config
   * Upserts the heatmap configuration (creates or updates).
   * Response: { config: HeatmapConfiguration }
   */
  @Put('config')
  @ApiOperation({ summary: 'Upsert heatmap configuration' })
  async upsertConfig(
    @CurrentUser() user: RequestUser,
    @Body() dto: HeatmapConfigDto,
  ): Promise<unknown> {
    return this.service.upsertConfig(
      user.organizationId,
      user.userId,
      this.parseConfigPayload(dto),
    );
  }

  /**
   * DELETE /heatmap/config
   * Deletes the custom config, reverting to defaults.
   * Response: { success: true, message: 'Configuration reset to default' }
   */
  @Delete('config')
  @ApiOperation({ summary: 'Reset heatmap configuration to default' })
  async deleteConfig(@CurrentUser() user: RequestUser): Promise<unknown> {
    return this.service.deleteConfig(user.organizationId, user.userId);
  }

  // ── Private ───────────────────────────────────────────────────────────

  private parseQueryConfig(
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

  private parseBodyConfig(dto: GenerateHeatmapBodyDto): GenerateHeatmapBodyDto {
    const rest = { ...dto };
    delete (rest as Record<string, unknown>)['organizationId'];
    const { config, ...direct } = rest;
    return (config ?? direct) as GenerateHeatmapBodyDto;
  }

  private parseConfigPayload(dto: HeatmapConfigDto): HeatmapConfigDto {
    const rest = { ...dto };
    delete (rest as Record<string, unknown>)['organizationId'];
    const { config, ...direct } = rest;
    return (config ?? direct) as HeatmapConfigDto;
  }

  private throwIfGenerationFailed(result: Record<string, unknown>): void {
    if (result['success'] === false) {
      throw new InternalServerErrorException(
        result['error'] ?? 'Failed to generate heatmap data',
      );
    }
  }
}

// Gated like HeatmapController above. This compatibility controller serves the
// same data through the older `GET|POST /dashboard/heatmap` shape and was missed
// when the licence gate was added, so `module_heatmap` could be withheld while
// this route still answered. It is authenticated (@ApiBearerAuth, @CurrentUser),
// so FeatureGuard has a user to resolve entitlements from.
@RequireFeature('module_heatmap')
@ApiTags('Dashboard Heatmap Compatibility')
@ApiBearerAuth()
@Controller('dashboard')
export class LegacyDashboardHeatmapController {
  constructor(private readonly service: HeatmapService) {}

  @Get('heatmap')
  @ApiOperation({
    summary: 'Generate legacy dashboard heatmap matrix from query params',
  })
  async generateGet(
    @CurrentUser() user: RequestUser,
    @Query() query: GenerateHeatmapQueryDto,
  ): Promise<unknown> {
    const result = await this.service.generateHeatmapData(
      user.organizationId,
      user.userId,
      this.parseQueryConfig(query),
    );
    this.throwIfGenerationFailed(result);
    return result;
  }

  @Post('heatmap')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Generate legacy dashboard heatmap matrix from body config',
  })
  async generatePost(
    @CurrentUser() user: RequestUser,
    @Body() dto: GenerateHeatmapBodyDto,
  ): Promise<unknown> {
    const result = await this.service.generateHeatmapData(
      user.organizationId,
      user.userId,
      this.parseBodyConfig(dto),
    );
    this.throwIfGenerationFailed(result);
    return result;
  }

  @Get('risk-summary')
  @ApiOperation({ summary: 'Get legacy dashboard heatmap risk summary' })
  async riskSummary(
    @CurrentUser() user: RequestUser,
    @Query() query: RiskSummaryQueryDto,
  ): Promise<unknown> {
    return this.service.getRiskSummary(user.organizationId, user.userId, {
      requestTypes: query.requestTypes?.split(',').filter(Boolean),
      status: query.status?.split(',').filter(Boolean) ?? ['active'],
      spaceId: query.spaceId,
    });
  }

  private parseQueryConfig(
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

  private parseBodyConfig(dto: GenerateHeatmapBodyDto): GenerateHeatmapBodyDto {
    const rest = { ...dto };
    delete (rest as Record<string, unknown>)['organizationId'];
    const { config, ...direct } = rest;
    return (config ?? direct) as GenerateHeatmapBodyDto;
  }

  private throwIfGenerationFailed(result: Record<string, unknown>): void {
    if (result['success'] === false) {
      throw new InternalServerErrorException(
        result['error'] ?? 'Failed to generate heatmap data',
      );
    }
  }
}
