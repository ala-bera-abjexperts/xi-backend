/**
 * @fileoverview REST controller for `/custom-fields` — list, create, get,
 * update, delete, patch-action, and unique-key generation.
 * @module src/custom-fields/custom-fields.controller
 * @author Prince Jadiya
 */

import {
  BadRequestException,
  ForbiddenException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PermissionsService } from '../permissions/permissions.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import {
  CustomFieldsService,
  type CustomFieldFilters,
} from './custom-fields.service';
import type { FieldType } from './models/custom-field.model';
import { CreateCustomFieldDto } from './dto/create-custom-field.dto';
import { UpdateCustomFieldDto } from './dto/update-custom-field.dto';
import { PatchCustomFieldDto } from './dto/patch-custom-field.dto';
import { GenerateKeyDto } from './dto/generate-key.dto';
import { ReorderCustomFieldsDto } from './dto/reorder-custom-fields.dto';

/**
 * Controller for custom-field management under `/custom-fields`.
 */
@ApiTags('Custom Fields')
@ApiBearerAuth()
@Controller('custom-fields')
export class CustomFieldsController {
  constructor(
    private readonly service: CustomFieldsService,
    private readonly permissionsService: PermissionsService,
  ) {}

  /**
   * Org fields need `can_manage_custom_fields`; a space field also accepts the existing
   * per-space right (`create/edit/delete_custom_fields`) of that space.
   */
  private async assertCustomFieldWrite(
    user: RequestUser,
    spaceKey:
      | 'create_custom_fields'
      | 'edit_custom_fields'
      | 'delete_custom_fields',
    resolveSpaceId: () => Promise<string | null> | string | null,
  ): Promise<void> {
    if (
      await this.permissionsService.checkPermission(
        user.userId,
        user.organizationId,
        'can_manage_custom_fields',
      )
    ) {
      return;
    }

    const spaceId = await resolveSpaceId();

    if (spaceId) {
      const space = await this.permissionsService.getUserSpacePermissions(
        user.userId,
        user.organizationId,
        spaceId,
      );

      if (space.permissions[spaceKey] === true) return;
    }

    throw new ForbiddenException('Insufficient permissions');
  }

  private async fieldSpaceId(
    id: string,
    organizationId: string,
  ): Promise<string | null> {
    return (await this.service.getById(id, organizationId)).space_id ?? null;
  }

  /** List custom fields. */
  @Get()
  @ApiQuery({
    name: 'spaceId',
    required: false,
    description: 'UUID of space (returns org + space fields)',
  })
  @ApiQuery({
    name: 'field_type',
    required: false,
    description: 'Filter by field type (text, number, select, etc.)',
  })
  @ApiQuery({
    name: 'is_active',
    required: false,
    description: 'true or false',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search in name or description',
  })
  @ApiQuery({
    name: 'is_deleted',
    required: false,
    description: 'true to fetch deleted fields',
  })
  @ApiQuery({
    name: 'context',
    required: false,
    description: 'Filter by context (task, process, etc.)',
  })
  @ApiQuery({
    name: 'scope',
    required: false,
    description: 'organization or space',
  })
  @ApiOperation({ summary: 'List custom fields for the current organization' })
  @ApiResponse({ status: 200, description: 'Custom fields returned' })
  async list(
    @CurrentUser() user: RequestUser,
    @Query('spaceId', new ParseUUIDPipe({ optional: true }))
    spaceId?: string,
    @Query('field_type') field_type?: FieldType,
    @Query('is_active') is_active?: string,
    @Query('search') search?: string,
    @Query('is_deleted') is_deleted?: string,
    @Query('context') context?: string,
    @Query('scope') scope?: 'organization' | 'space',
  ) {
    const filters: CustomFieldFilters = {
      field_type,
      is_active: is_active === undefined ? undefined : is_active === 'true',
      search,
      is_deleted:
        is_deleted === 'true'
          ? true
          : is_deleted === 'false'
            ? false
            : undefined,
      context,
      scope,
    };
    if (is_deleted === 'true') {
      return this.service.getDeleted(user.organizationId);
    }
    if (spaceId) {
      return this.service.getBySpace(user.organizationId, spaceId, filters);
    }
    return this.service.getAll(user.organizationId, filters);
  }

  /** Create a new custom field. */
  @Post()
  @ApiOperation({ summary: 'Create a custom field' })
  @ApiResponse({ status: 201, description: 'Custom field created' })
  async create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateCustomFieldDto,
  ) {
    await this.assertCustomFieldWrite(
      user,
      'create_custom_fields',
      () => dto.space_id ?? null,
    );

    return this.service.create(user.organizationId, user.userId, dto);
  }

  /** Bulk reorder custom fields. */
  @Patch('reorder')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_custom_fields')
  @ApiOperation({ summary: 'Bulk reorder custom fields' })
  @ApiResponse({ status: 200, description: 'Custom fields reordered' })
  async reorder(
    @CurrentUser() user: RequestUser,
    @Body() dto: ReorderCustomFieldsDto,
  ) {
    await this.service.reorder(dto.items, user.organizationId, user.userId);

    return { success: true, message: 'Custom fields reordered' };
  }

  /** Generate a unique field key from a name. */
  @Post('generate-key')
  @ApiOperation({ summary: 'Generate a unique field key for a given name' })
  @ApiResponse({ status: 200, description: 'Returns `{ field_key }`' })
  async generateKey(
    @CurrentUser() user: RequestUser,
    @Body() dto: GenerateKeyDto,
  ) {
    await this.assertCustomFieldWrite(
      user,
      'create_custom_fields',
      () => dto.space_id ?? null,
    );

    const field_key = await this.service.generateUniqueFieldKey(
      user.organizationId,
      dto.name,
      dto.space_id ?? null,
    );
    return { field_key };
  }

  /** Get a single custom field by id. */
  @Get(':id')
  @ApiOperation({ summary: 'Get a custom field by id' })
  @ApiResponse({ status: 200, description: 'Custom field returned' })
  async getById(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getById(id, user.organizationId);
  }

  /** Update a custom field. */
  @Put(':id')
  @ApiOperation({ summary: 'Update a custom field' })
  @ApiResponse({ status: 200, description: 'Custom field updated' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomFieldDto,
  ) {
    await this.assertCustomFieldWrite(user, 'edit_custom_fields', () =>
      this.fieldSpaceId(id, user.organizationId),
    );

    return this.service.update(id, user.userId, dto, user.organizationId);
  }

  /** Soft delete a custom field. */
  @Delete(':id')
  @ApiOperation({ summary: 'Soft delete a custom field' })
  @ApiResponse({ status: 200, description: 'Custom field soft-deleted' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.assertCustomFieldWrite(user, 'delete_custom_fields', () =>
      this.fieldSpaceId(id, user.organizationId),
    );
    await this.service.softDelete(id, user.userId, user.organizationId);
    return { success: true, message: 'Custom field deleted' };
  }

  /** Action dispatcher: toggle_active, restore, permanent_delete. */
  @Patch(':id')
  @ApiOperation({
    summary:
      'Perform a maintenance action (toggle_active, restore, permanent_delete)',
  })
  @ApiResponse({ status: 200, description: 'Action applied' })
  async patch(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchCustomFieldDto,
  ) {
    // A hard delete needs the delete right; every other action is an edit
    await this.assertCustomFieldWrite(
      user,
      dto.action === 'permanent_delete'
        ? 'delete_custom_fields'
        : 'edit_custom_fields',
      () => this.fieldSpaceId(id, user.organizationId),
    );

    switch (dto.action) {
      case 'toggle_active':
        if (dto.is_active === undefined) {
          throw new BadRequestException(
            'is_active is required for action=toggle_active',
          );
        }
        return this.service.toggleActive(
          id,
          dto.is_active,
          user.organizationId,
          user.userId,
        );
      case 'restore': {
        const field = await this.service.restore(
          id,
          user.organizationId,
          user.userId,
        );
        return {
          data: field,
          success: true,
          message: 'Custom field restored successfully',
        };
      }
      case 'permanent_delete':
        await this.service.permanentDelete(
          id,
          user.organizationId,
          user.userId,
        );
        return { success: true, message: 'Custom field permanently deleted' };
      default: {
        // Treat as partial update — strip action + is_active helper fields
        const { action: _a, is_active: _i, ...rest } = dto;
        void _a;
        void _i;
        return this.service.update(
          id,
          user.userId,
          rest as UpdateCustomFieldDto,
          user.organizationId,
        );
      }
    }
  }
}
