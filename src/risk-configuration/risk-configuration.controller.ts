/**
 * @fileoverview REST controller for `/risk-configuration` — organization risk thresholds
 * and probability/impact mappings.
 * @module src/risk-configuration/risk-configuration.controller
 */

import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Optional,
  ParseUUIDPipe,
  Put,
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
import { RiskConfigurationService } from './risk-configuration.service';
import { PermissionsService } from '../permissions/permissions.service';
import { UpdateRiskConfigurationDto } from './dto/update-risk-configuration.dto';

@RequireFeature('module_risk')
@ApiTags('Risk Configuration')
@ApiBearerAuth()
@Controller('risk-configuration')
export class RiskConfigurationController {
  constructor(
    private readonly service: RiskConfigurationService,
    // Optional so existing unit construction keeps working; the module always provides it
    @Optional() private readonly permissionsService?: PermissionsService,
  ) {}

  /** The Risk Config Edit tick counts only from Space Settings, in a space the user belongs to. */
  private async assertCanEditRiskConfig(
    user: RequestUser,
    spaceId?: string,
  ): Promise<void> {
    if (!this.permissionsService) return;
    if (
      await this.permissionsService.hasSpaceWorkflowGrant(
        user.userId,
        user.organizationId,
        'can_edit_settings',
        'can_edit_risk_config',
        () => spaceId ?? null,
      )
    ) {
      return;
    }
    throw new ForbiddenException('Insufficient permissions');
  }

  /**
   * GET /risk-configuration
   * Returns the organization's risk config. Creates defaults if none exists.
   */
  @Get()
  @ApiOperation({
    summary: 'Get risk configuration (creates default if not set)',
  })
  async getConfiguration(@CurrentUser() user: RequestUser): Promise<unknown> {
    return this.service.getConfiguration(user.organizationId);
  }

  /**
   * PUT /risk-configuration
   * Updates probability_mappings, impact_mappings, and/or thresholds.
   */
  @Put()
  @UseGuards(PermissionsGuard)
  @RequirePermissions(['can_edit_settings', 'can_edit_risk_config'], {
    any: true,
  })
  @ApiOperation({ summary: 'Update risk configuration' })
  async updateConfiguration(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdateRiskConfigurationDto,
    @Query('spaceId', new ParseUUIDPipe({ optional: true })) spaceId?: string,
  ): Promise<unknown> {
    await this.assertCanEditRiskConfig(user, spaceId);

    return this.service.updateConfiguration(
      user.organizationId,
      dto,
      user.userId,
    );
  }

  /**
   * DELETE /risk-configuration
   * Resets to built-in defaults (probability_mappings, impact_mappings, thresholds).
   */
  @Delete()
  @UseGuards(PermissionsGuard)
  @RequirePermissions(['can_edit_settings', 'can_edit_risk_config'], {
    any: true,
  })
  @ApiOperation({ summary: 'Reset risk configuration to defaults' })
  async resetToDefaults(
    @CurrentUser() user: RequestUser,
    @Query('spaceId', new ParseUUIDPipe({ optional: true })) spaceId?: string,
  ): Promise<unknown> {
    await this.assertCanEditRiskConfig(user, spaceId);

    return this.service.resetToDefaults(user.organizationId, user.userId);
  }

  /**
   * GET /risk-configuration/calculate
   * Calculates financial risk value for a given probability and impact level (1–4).
   */
  @Get('calculate')
  @ApiOperation({
    summary: 'Calculate financial risk value for probability × impact',
  })
  @ApiQuery({ name: 'probability', description: 'Integer level 1–4' })
  @ApiQuery({ name: 'impact', description: 'Integer level 1–4' })
  async calculateFinancialRisk(
    @CurrentUser() user: RequestUser,
    @Query('probability') probability: string,
    @Query('impact') impact: string,
  ): Promise<unknown> {
    const p = Math.min(Math.max(parseInt(probability, 10) || 1, 1), 4);
    const i = Math.min(Math.max(parseInt(impact, 10) || 1, 1), 4);
    return this.service.calculateFinancialRisk(user.organizationId, p, i);
  }

  /**
   * GET /risk-configuration/risk-level
   * Returns the GREEN/ORANGE/RED classification for a financial risk value.
   */
  @Get('risk-level')
  @ApiOperation({
    summary: 'Get risk level (GREEN/ORANGE/RED) for a financial value',
  })
  @ApiQuery({ name: 'value', description: 'Financial risk value' })
  async getRiskLevel(
    @CurrentUser() user: RequestUser,
    @Query('value') value: string,
  ): Promise<unknown> {
    const v = parseFloat(value) || 0;
    return this.service.getRiskLevel(user.organizationId, v);
  }

  /**
   * GET /risk-configuration/risk-level-ranges
   * Returns the min/max ranges for GREEN, ORANGE, and RED levels.
   */
  @Get('risk-level-ranges')
  @ApiOperation({ summary: 'Get risk level threshold ranges' })
  async getRiskLevelRanges(@CurrentUser() user: RequestUser): Promise<unknown> {
    return this.service.getRiskLevelRanges(user.organizationId);
  }
}
