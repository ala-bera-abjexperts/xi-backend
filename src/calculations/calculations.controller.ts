/**
 * @fileoverview REST controller for `/calculations` — risk calculations and cache management.
 * @module src/calculations/calculations.controller
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { CalculationsService } from './calculations.service';
import { CalculateRiskDto } from './dto/calculate-risk.dto';
import { RecalculateTreeDto } from './dto/recalculate-tree.dto';

@ApiTags('Calculations')
@ApiBearerAuth()
// SECURITY (M): require process access. These endpoints run expensive tree
// recomputes and org-wide cache clears; previously any authenticated user could
// call them (org-scoped, so no cross-tenant, but a within-org DoS vector).
// Write/cache-clear ideally want can_edit_processes — refinement noted in report.
@UseGuards(PermissionsGuard)
@RequirePermissions('can_view_processes')
@Controller('calculations')
export class CalculationsController {
  constructor(private readonly service: CalculationsService) {}

  /**
   * POST /calculations/calculate
   * Calculates risk for a process (checks 1-hour cache first).
   * organization_id always comes from JWT — never from request body.
   * Response: ICalculationResult (net_risk, accumulated_risk, total_risk)
   */
  @Post('calculate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Calculate risk for a process (cached)' })
  async calculateRisk(
    @CurrentUser() user: RequestUser,
    @Body() dto: CalculateRiskDto,
  ): Promise<unknown> {
    return this.service.calculateRisk(user.organizationId, dto);
  }

  /**
   * POST /calculations/force-calculate
   * Clears the cache for the process then recalculates.
   * Response: ICalculationResult
   */
  @Post('force-calculate')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Force recalculate risk for a process (bypasses cache)',
  })
  async forceCalculate(
    @CurrentUser() user: RequestUser,
    @Body() dto: CalculateRiskDto,
  ): Promise<unknown> {
    return this.service.forceCalculateRisk(user.organizationId, dto);
  }

  /**
   * POST /calculations/recalculate-tree
   * Recalculates an entire process tree bottom-up.
   * Response: RPC result from recalculate_tree_bottom_up
   */
  @Post('recalculate-tree')
  @HttpCode(200)
  @ApiOperation({ summary: 'Recalculate entire process tree bottom-up' })
  async recalculateTree(
    @CurrentUser() user: RequestUser,
    @Body() dto: RecalculateTreeDto,
  ): Promise<unknown> {
    return this.service.recalculateTree(user.organizationId, dto);
  }

  /**
   * GET /calculations/cache/:processId
   * Returns the cached calculation result for a process, or null if expired/absent.
   */
  @Get('cache/:processId')
  @ApiOperation({ summary: 'Get cached calculation result for a process' })
  @ApiParam({ name: 'processId', description: 'Business process UUID' })
  async getCachedResult(
    @Param('processId', ParseUUIDPipe) processId: string,
  ): Promise<unknown> {
    return this.service.getCachedResult(processId);
  }

  /**
   * DELETE /calculations/cache
   * Clears all calculation cache for the organization.
   * Response: { deleted: number }
   * Must be declared BEFORE DELETE /calculations/cache/:processId.
   */
  @Delete('cache')
  @ApiOperation({ summary: 'Clear all calculation cache for the organization' })
  async clearOrganizationCache(
    @CurrentUser() user: RequestUser,
  ): Promise<unknown> {
    return this.service.clearOrganizationCache(user.organizationId);
  }

  /**
   * DELETE /calculations/cache/:processId
   * Clears the calculation cache for a process and its ancestors.
   */
  @Delete('cache/:processId')
  @ApiOperation({
    summary: 'Clear calculation cache for a process (and ancestors)',
  })
  @ApiParam({ name: 'processId', description: 'Business process UUID' })
  async clearProcessCache(
    @CurrentUser() user: RequestUser,
    @Param('processId', ParseUUIDPipe) processId: string,
  ): Promise<unknown> {
    await this.service.clearProcessCache(processId, user.organizationId);
    return { success: true };
  }
}
