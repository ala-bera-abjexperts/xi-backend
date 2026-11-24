/**
 * @fileoverview REST controller for `/hierarchy-config` — the process/risk
 * hierarchy configuration management endpoints. Mirrors the old Next.js
 * routes under `risk-management-app/src/app/api/hierarchy-config/*`.
 * @module src/hierarchy-config/hierarchy-config.controller
 * @author Prince Jadiya
 */

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { HierarchyConfigService } from './hierarchy-config.service';
import {
  hierarchyConfigSchema,
  updateHierarchyConfigSchema,
  importHierarchyConfigSchema,
  validateHierarchyConfigInputSchema,
  type UpdateHierarchyConfigInput,
  type ImportHierarchyConfigInput,
  type ValidateHierarchyConfigInput,
} from './models/hierarchy-config.model';

/**
 * Controller for `/hierarchy-config`. Routes marked `@RequirePermissions`
 * require the current user to hold `can_manage_hierarchy` in the
 * current organization (checked by `PermissionsGuard`).
 */
@ApiTags('Hierarchy Config')
@ApiBearerAuth()
@Controller('hierarchy-config')
export class HierarchyConfigController {
  constructor(private readonly service: HierarchyConfigService) {}

  // ---------------------------------------------------------------------
  // STATIC subpaths first
  // ---------------------------------------------------------------------

  @Get('default')
  @ApiOperation({ summary: 'Return the system default hierarchy config' })
  @ApiResponse({ status: 200, description: 'Default config returned' })
  async getDefault() {
    const config = await this.service.getDefaultConfig();
    return { config };
  }

  @Post('validate')
  @ApiOperation({
    summary: 'Validate a hierarchy config without persisting it',
  })
  @ApiBody({ description: '`{ config: IHierarchyConfig }`' })
  @ApiResponse({ status: 200, description: 'Validation result' })
  validate(
    @Body(new ZodValidationPipe(validateHierarchyConfigInputSchema))
    body: ValidateHierarchyConfigInput,
  ) {
    return this.service.validateConfig(body.config);
  }

  @Post('import')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(['can_edit_hierarchy', 'can_manage_hierarchy'], {
    any: true,
  })
  @ApiOperation({ summary: 'Import a hierarchy config (sanitized + saved)' })
  @ApiBody({ description: '`{ spaceId, config: IHierarchyConfig }`' })
  @ApiResponse({ status: 200, description: 'Config imported' })
  async import(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(importHierarchyConfigSchema))
    body: ImportHierarchyConfigInput,
  ) {
    const record = await this.service.importConfig(
      user.organizationId,
      body.spaceId,
      body.config,
      user.userId,
    );
    return {
      config: record.config,
      record,
      success: true,
      message: 'Config imported successfully',
    };
  }

  @Get('export')
  @ApiOperation({ summary: 'Export the current hierarchy config as JSON' })
  @ApiQuery({ name: 'spaceId', required: true })
  @ApiResponse({ status: 200, description: 'Config exported' })
  async export(
    @CurrentUser() user: RequestUser,
    @Query('spaceId', new ParseUUIDPipe()) spaceId: string,
  ) {
    return this.service.exportConfig(user.organizationId, spaceId);
  }

  @Get('child-types/:requestType')
  @ApiOperation({
    summary: 'List valid child request types for a given parent type',
  })
  @ApiParam({ name: 'requestType' })
  @ApiQuery({ name: 'spaceId', required: true })
  @ApiResponse({ status: 200, description: 'Child types returned' })
  async getChildTypes(
    @CurrentUser() user: RequestUser,
    @Param('requestType') requestType: string,
    @Query('spaceId', new ParseUUIDPipe()) spaceId: string,
  ) {
    if (!requestType) {
      throw new BadRequestException('requestType path param is required');
    }
    const decoded = decodeURIComponent(requestType);
    const childTypes = await this.service.getValidChildTypes(
      user.organizationId,
      spaceId,
      decoded,
    );
    return { requestType: decoded, childTypes };
  }

  // ---------------------------------------------------------------------
  // Main config CRUD
  // ---------------------------------------------------------------------

  @Get()
  @ApiOperation({ summary: 'Get the hierarchy config for a space' })
  @ApiQuery({ name: 'spaceId', required: true })
  @ApiResponse({ status: 200, description: 'Config returned' })
  async get(
    @CurrentUser() user: RequestUser,
    @Query('spaceId', new ParseUUIDPipe()) spaceId: string,
  ) {
    return this.service.getConfig(user.organizationId, spaceId);
  }

  @Put()
  @UseGuards(PermissionsGuard)
  @RequirePermissions(['can_edit_hierarchy', 'can_manage_hierarchy'], {
    any: true,
  })
  @ApiOperation({ summary: 'Save (upsert) a hierarchy config for a space' })
  @ApiBody({ description: '`{ spaceId, config: IHierarchyConfig }`' })
  @ApiResponse({ status: 200, description: 'Config saved' })
  async save(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(updateHierarchyConfigSchema))
    body: UpdateHierarchyConfigInput,
  ) {
    const record = await this.service.saveConfig(
      user.organizationId,
      body.spaceId,
      body.config,
      user.userId,
    );
    return { config: record.config, record, success: true };
  }

  @Delete()
  @UseGuards(PermissionsGuard)
  @RequirePermissions(['can_delete_hierarchy', 'can_manage_hierarchy'], {
    any: true,
  })
  @ApiOperation({
    summary:
      'Reset the hierarchy config for a space back to the system default',
  })
  @ApiQuery({ name: 'spaceId', required: true })
  @ApiResponse({ status: 200, description: 'Config reset to default' })
  async reset(
    @CurrentUser() user: RequestUser,
    @Query('spaceId', new ParseUUIDPipe()) spaceId: string,
  ) {
    const record = await this.service.resetToDefault(
      user.organizationId,
      spaceId,
      user.userId,
    );
    return {
      config: record.config,
      record,
      success: true,
      message: 'Config reset to default',
    };
  }
}

// Keep the import-only usage of `hierarchyConfigSchema` lint-happy —
// it's used by consumers that import from this file.
export { hierarchyConfigSchema };
