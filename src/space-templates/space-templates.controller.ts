/**
 * @fileoverview Controller for space template CRUD and snapshot/apply operations.
 * Provides 7 endpoints: list, create, get, update, delete, save-from-space, apply-to-space.
 */

import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { SpaceTemplatesService } from './space-templates.service';
import { CreateSpaceTemplateDto } from './dto/create-space-template.dto';
import { UpdateSpaceTemplateDto } from './dto/update-space-template.dto';
import { SaveSpaceAsTemplateDto } from './dto/save-space-as-template.dto';

@ApiTags('Space Templates')
@ApiBearerAuth()
@UseGuards(PermissionsGuard)
// SECURITY (H3/H4): class-level requirement so the guard is NOT a no-op. Managing
// space templates (config that provisions spaces) requires the space-creation
// permission. getAllAndOverride lets any handler override if ever needed.
@RequirePermissions('can_create_spaces')
@Controller('space-templates')
export class SpaceTemplatesController {
  constructor(private readonly spaceTemplatesService: SpaceTemplatesService) {}

  /**
   * List all templates visible to the current organization
   * (system templates + org-own templates).
   */
  @Get()
  @ApiOperation({ summary: 'List space templates' })
  @ApiQuery({ name: 'organizationId', required: true, type: String })
  @ApiResponse({ status: 200, description: 'List of space templates' })
  async listTemplates(
    @Query('organizationId') organizationId: string,
    @CurrentUser() user: RequestUser,
  ) {
    // SECURITY (H3): never trust a client-supplied organizationId — always scope
    // to the authenticated active org. (The query param is ignored, kept only for
    // backward-compatible request shapes.)
    const orgId = user.organizationId;

    return this.spaceTemplatesService.listTemplates(orgId);
  }

  /**
   * Get a single template by id.
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get a space template by id' })
  @ApiParam({ name: 'id', type: String })
  @ApiQuery({ name: 'organizationId', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Space template detail' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async getTemplate(
    @Param('id') id: string,
    @Query('organizationId') organizationId: string,
    @CurrentUser() user: RequestUser,
  ) {
    // SECURITY (H3): never trust a client-supplied organizationId — always scope
    // to the authenticated active org. (The query param is ignored, kept only for
    // backward-compatible request shapes.)
    const orgId = user.organizationId;

    return this.spaceTemplatesService.getTemplate(id, orgId);
  }

  /**
   * Create a new org-scoped space template.
   */
  @Post()
  @ApiOperation({ summary: 'Create a space template' })
  @ApiQuery({ name: 'organizationId', required: false, type: String })
  @ApiResponse({ status: 201, description: 'Created' })
  async createTemplate(
    @Body() dto: CreateSpaceTemplateDto,
    @Query('organizationId') organizationId: string,
    @CurrentUser() user: RequestUser,
  ) {
    // SECURITY (H3): never trust a client-supplied organizationId — always scope
    // to the authenticated active org. (The query param is ignored, kept only for
    // backward-compatible request shapes.)
    const orgId = user.organizationId;

    return this.spaceTemplatesService.createTemplate(orgId, user.userId, dto);
  }

  /**
   * Update a non-system org-scoped template.
   */
  @Put(':id')
  @ApiOperation({ summary: 'Update a space template' })
  @ApiParam({ name: 'id', type: String })
  @ApiQuery({ name: 'organizationId', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Updated' })
  @ApiResponse({ status: 403, description: 'Cannot modify system template' })
  async updateTemplate(
    @Param('id') id: string,
    @Body() dto: UpdateSpaceTemplateDto,
    @Query('organizationId') organizationId: string,
    @CurrentUser() user: RequestUser,
  ) {
    // SECURITY (H3): never trust a client-supplied organizationId — always scope
    // to the authenticated active org. (The query param is ignored, kept only for
    // backward-compatible request shapes.)
    const orgId = user.organizationId;

    return this.spaceTemplatesService.updateTemplate(
      id,
      orgId,
      user.userId,
      dto,
    );
  }

  /**
   * Delete a non-system org-scoped template.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a space template' })
  @ApiParam({ name: 'id', type: String })
  @ApiQuery({ name: 'organizationId', required: false, type: String })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 403, description: 'Cannot delete system template' })
  async deleteTemplate(
    @Param('id') id: string,
    @Query('organizationId') organizationId: string,
    @CurrentUser() user: RequestUser,
  ) {
    // SECURITY (H3): never trust a client-supplied organizationId — always scope
    // to the authenticated active org. (The query param is ignored, kept only for
    // backward-compatible request shapes.)
    const orgId = user.organizationId;

    await this.spaceTemplatesService.deleteTemplate(id, orgId);
  }

  /**
   * Snapshot an existing space's configuration into a new template.
   */
  @Post('from-space/:spaceId')
  @ApiOperation({ summary: 'Save a space config as a template' })
  @ApiParam({ name: 'spaceId', type: String })
  @ApiQuery({ name: 'organizationId', required: false, type: String })
  @ApiResponse({ status: 201, description: 'Template created from space' })
  async createFromSpace(
    @Param('spaceId') spaceId: string,
    @Body() dto: SaveSpaceAsTemplateDto,
    @Query('organizationId') organizationId: string,
    @CurrentUser() user: RequestUser,
  ) {
    // SECURITY (H3): never trust a client-supplied organizationId — always scope
    // to the authenticated active org. (The query param is ignored, kept only for
    // backward-compatible request shapes.)
    const orgId = user.organizationId;

    return this.spaceTemplatesService.createTemplateFromSpace(
      spaceId,
      orgId,
      user.userId,
      dto,
    );
  }

  /**
   * Apply a template to an existing space (re-apply after creation).
   */
  @Post(':id/apply/:spaceId')
  @ApiOperation({ summary: 'Apply a template to an existing space' })
  @ApiParam({ name: 'id', type: String, description: 'Template id' })
  @ApiParam({ name: 'spaceId', type: String, description: 'Target space id' })
  @ApiQuery({ name: 'organizationId', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Template applied' })
  async applyTemplate(
    @Param('id') id: string,
    @Param('spaceId') spaceId: string,
    @Query('organizationId') organizationId: string,
    @CurrentUser() user: RequestUser,
  ) {
    // SECURITY (H3): never trust a client-supplied organizationId — always scope
    // to the authenticated active org. (The query param is ignored, kept only for
    // backward-compatible request shapes.)
    const orgId = user.organizationId;

    await this.spaceTemplatesService.applyTemplateToSpace(
      id,
      spaceId,
      orgId,
      user.userId,
    );

    return { success: true };
  }
}
