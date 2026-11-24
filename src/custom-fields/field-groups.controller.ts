/**
 * @fileoverview REST controller for `/field-groups` — CRUD, membership,
 * reorder, level assignments, and assignment permissions.
 * @module src/custom-fields/field-groups.controller
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
  Patch,
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
import { FieldGroupsService } from './field-groups.service';
import { CreateFieldGroupDto } from './dto/create-field-group.dto';
import { UpdateFieldGroupDto } from './dto/update-field-group.dto';
import { PatchFieldGroupDto } from './dto/patch-field-group.dto';
import { AddFieldToGroupDto } from './dto/add-field-to-group.dto';
import { AddFieldsBatchDto } from './dto/add-fields-batch.dto';
import { UpdateFieldInGroupDto } from './dto/update-field-in-group.dto';
import { ReorderFieldsDto } from './dto/reorder-fields.dto';
import { ReorderFieldGroupsDto } from './dto/reorder-field-groups.dto';
import {
  AssignLevelDto,
  type AssignmentEntityType,
} from './dto/assign-level.dto';
import { UnassignLevelDto } from './dto/unassign-level.dto';
import { SetAssignmentPermissionsDto } from './dto/set-assignment-permissions.dto';
import {
  CreateWikiAssignmentDto,
  UpdateWikiAssignmentDto,
} from './dto/wiki-assignment.dto';

/**
 * Controller for `/field-groups`. Static subpaths are declared before `:id`
 * to ensure correct Express route matching.
 */
@ApiTags('Field Groups')
@ApiBearerAuth()
@Controller('field-groups')
export class FieldGroupsController {
  constructor(private readonly service: FieldGroupsService) {}

  // ---------------------------------------------------------------------
  // Collection
  // ---------------------------------------------------------------------

  @Get()
  @ApiOperation({ summary: 'List field groups for the current organization' })
  @ApiQuery({ name: 'spaceId', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'is_deleted', required: false })
  @ApiResponse({ status: 200, description: 'Field groups returned' })
  async list(
    @CurrentUser() user: RequestUser,
    @Query('spaceId', new ParseUUIDPipe({ optional: true }))
    spaceId?: string,
    @Query('search') search?: string,
    @Query('is_deleted') is_deleted?: string,
  ) {
    const filters = {
      search,
      is_deleted:
        is_deleted === 'true'
          ? true
          : is_deleted === 'false'
            ? false
            : undefined,
    };

    if (spaceId) {
      return this.service.getBySpace(user.organizationId, spaceId, filters);
    }
    return this.service.getAll(user.organizationId, filters);
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions(['can_manage_custom_fields', 'can_create_field_groups'], {
    any: true,
  })
  @ApiOperation({ summary: 'Create a field group' })
  @ApiBody({ type: CreateFieldGroupDto })
  @ApiResponse({ status: 201, description: 'Field group created' })
  async create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateFieldGroupDto,
  ) {
    return this.service.create(user.organizationId, user.userId, dto);
  }

  // ---------------------------------------------------------------------
  // STATIC SUBPATHS — must precede `:id` routes
  // ---------------------------------------------------------------------

  @Patch('reorder')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(['can_manage_custom_fields', 'can_edit_field_groups'], {
    any: true,
  })
  @ApiOperation({ summary: 'Bulk reorder field groups' })
  @ApiResponse({ status: 200, description: 'Field groups reordered' })
  async reorder(
    @CurrentUser() user: RequestUser,
    @Body() dto: ReorderFieldGroupsDto,
  ) {
    await this.service.reorder(dto.items, user.organizationId, user.userId);

    return { success: true, message: 'Field groups reordered' };
  }

  @Get('for-level')
  @ApiOperation({
    summary: 'Get the full field configuration for a hierarchy level',
    description:
      'Returns groups + standalone fields assigned to a level, optionally grouped by UI section.',
  })
  @ApiQuery({ name: 'hierarchyLevelId', required: true })
  @ApiQuery({ name: 'entityType', required: true })
  @ApiQuery({ name: 'bySection', required: false })
  @ApiQuery({
    name: 'spaceId',
    required: false,
    description:
      'UUID of space — returns org-level + space-specific groups/fields',
  })
  @ApiQuery({
    name: 'organizationId',
    required: false,
    description: 'Accepted for compatibility; org comes from auth token',
  })
  @ApiResponse({ status: 200, description: 'Level fields configuration' })
  async getForLevel(
    @CurrentUser() user: RequestUser,
    @Query('hierarchyLevelId') hierarchyLevelId: string,
    @Query('entityType') entityType: AssignmentEntityType,
    @Query('bySection') bySection?: string,
    @Query('spaceId') spaceId?: string,
  ) {
    if (!hierarchyLevelId || !entityType) {
      throw new BadRequestException(
        'hierarchyLevelId and entityType are required',
      );
    }
    return this.service.getLevelFieldsConfiguration(
      user.organizationId,
      hierarchyLevelId,
      entityType,
      bySection === 'true',
      spaceId,
    );
  }

  @Get('level-assignments')
  @ApiOperation({ summary: 'List level assignments (groups and/or fields)' })
  @ApiQuery({ name: 'hierarchyLevelId', required: true })
  @ApiQuery({ name: 'entityType', required: true })
  @ApiQuery({ name: 'type', required: false, enum: ['groups', 'fields'] })
  @ApiResponse({ status: 200, description: 'Assignments returned' })
  async listLevelAssignments(
    @CurrentUser() user: RequestUser,
    @Query('hierarchyLevelId') hierarchyLevelId: string,
    @Query('entityType') entityType: AssignmentEntityType,
    @Query('type') type?: 'groups' | 'fields',
    @Query('spaceId') spaceId?: string,
  ) {
    if (!hierarchyLevelId || !entityType) {
      throw new BadRequestException(
        'hierarchyLevelId and entityType are required',
      );
    }
    // Default to 'groups' when type not specified (matches Next.js behavior)
    return this.service.getLevelAssignments(
      user.organizationId,
      hierarchyLevelId,
      entityType,
      type ?? 'groups',
      spaceId,
    );
  }

  @Post('level-assignments')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_custom_fields')
  @ApiOperation({
    summary: 'Assign a field group or standalone field to a hierarchy level',
  })
  @ApiBody({ description: 'Discriminated by `type` ("group" | "field")' })
  @ApiResponse({ status: 201, description: 'Assignment created' })
  async createLevelAssignment(
    @CurrentUser() user: RequestUser,
    @Body() dto: AssignLevelDto,
  ) {
    if (dto.type === 'group') {
      if (!dto.field_group_id) {
        throw new BadRequestException(
          'field_group_id is required when type=group',
        );
      }
      return this.service.assignGroupToLevel(
        user.organizationId,
        {
          type: 'group',
          hierarchy_level_id: dto.hierarchy_level_id,
          entity_type: dto.entity_type,
          field_group_id: dto.field_group_id,
          section: dto.section,
          sort_order: dto.sort_order,
          is_collapsed_default: dto.is_collapsed_default,
        },
        user.userId,
      );
    }
    if (dto.type === 'field') {
      if (!dto.custom_field_id) {
        throw new BadRequestException(
          'custom_field_id is required when type=field',
        );
      }
      return this.service.assignFieldToLevel(
        user.organizationId,
        {
          type: 'field',
          hierarchy_level_id: dto.hierarchy_level_id,
          entity_type: dto.entity_type,
          custom_field_id: dto.custom_field_id,
          section: dto.section,
          sort_order: dto.sort_order,
          is_required: dto.is_required,
          is_hidden: dto.is_hidden,
          column_span: dto.column_span,
        },
        user.userId,
      );
    }
    throw new BadRequestException('type must be "group" or "field"');
  }

  @Delete('level-assignments')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_custom_fields')
  @ApiOperation({ summary: 'Remove a group or field assignment from a level' })
  @ApiBody({ type: UnassignLevelDto })
  @ApiResponse({ status: 200, description: 'Assignment removed' })
  async deleteLevelAssignment(
    @CurrentUser() user: RequestUser,
    @Body() dto: UnassignLevelDto,
  ) {
    if (dto.type === 'group') {
      if (!dto.field_group_id) {
        throw new BadRequestException(
          'field_group_id is required when type=group',
        );
      }
      await this.service.unassignGroupFromLevel(
        user.organizationId,
        dto.hierarchy_level_id,
        dto.entity_type,
        dto.field_group_id,
        user.userId,
      );
      return {
        success: true,
        message: 'Field group unassigned from level successfully',
      };
    }
    if (dto.type === 'field') {
      if (!dto.custom_field_id) {
        throw new BadRequestException(
          'custom_field_id is required when type=field',
        );
      }
      await this.service.unassignFieldFromLevel(
        user.organizationId,
        dto.hierarchy_level_id,
        dto.entity_type,
        dto.custom_field_id,
        user.userId,
      );
      return {
        success: true,
        message: 'Field unassigned from level successfully',
      };
    }
    throw new BadRequestException('type must be "group" or "field"');
  }

  // ---------------------------------------------------------------------
  // Wiki field assignments (Wiki 2.0) — static subpath, precedes `:id`
  // ---------------------------------------------------------------------

  @Get('wiki-assignments')
  @ApiOperation({
    summary: 'List wiki field assignments for a space',
    description:
      'Returns group and standalone-field assignments for the wiki of the ' +
      'given space, each embedding its field group (with member fields) or ' +
      'custom-field definition.',
  })
  @ApiQuery({ name: 'space_id', required: true, description: 'Space UUID' })
  @ApiResponse({ status: 200, description: 'Assignments returned' })
  async listWikiAssignments(
    @CurrentUser() user: RequestUser,
    @Query('space_id', new ParseUUIDPipe({ optional: true }))
    spaceId?: string,
  ) {
    if (!spaceId) {
      throw new BadRequestException('space_id is required');
    }
    return this.service.getWikiAssignments(user.organizationId, spaceId);
  }

  @Post('wiki-assignments')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_custom_fields')
  @ApiOperation({
    summary: "Assign a field group or standalone field to a space's wiki",
  })
  @ApiBody({ type: CreateWikiAssignmentDto })
  @ApiResponse({ status: 201, description: 'Assignment created' })
  @ApiResponse({ status: 409, description: 'Assignment already exists' })
  async createWikiAssignment(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateWikiAssignmentDto,
  ) {
    return this.service.createWikiAssignment(
      user.organizationId,
      dto,
      user.userId,
    );
  }

  @Patch('wiki-assignments/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_custom_fields')
  @ApiOperation({
    summary: 'Update layout/behaviour flags of a wiki field assignment',
  })
  @ApiParam({ name: 'id', description: 'Assignment id' })
  @ApiBody({ type: UpdateWikiAssignmentDto })
  @ApiResponse({ status: 200, description: 'Assignment updated' })
  async updateWikiAssignment(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWikiAssignmentDto,
  ) {
    return this.service.updateWikiAssignment(
      id,
      user.organizationId,
      dto,
      user.userId,
    );
  }

  @Delete('wiki-assignments/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_custom_fields')
  @ApiOperation({ summary: 'Remove a wiki field assignment' })
  @ApiParam({ name: 'id', description: 'Assignment id' })
  @ApiResponse({ status: 200, description: 'Assignment removed' })
  async deleteWikiAssignment(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.deleteWikiAssignment(
      id,
      user.organizationId,
      user.userId,
    );
    return { success: true, message: 'Wiki field assignment removed' };
  }

  // ---------------------------------------------------------------------
  // :id routes
  // ---------------------------------------------------------------------

  @Get(':id')
  @ApiOperation({ summary: 'Get a field group by id (with fields embedded)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Field group returned' })
  async getById(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('includeFields') includeFields?: string,
    @Query('spaceId', new ParseUUIDPipe({ optional: true })) spaceId?: string,
  ) {
    if (includeFields === 'false') {
      return this.service.getById(id, user.organizationId);
    }
    return this.service.getByIdWithFields(id, user.organizationId, spaceId);
  }

  @Put(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(['can_manage_custom_fields', 'can_edit_field_groups'], {
    any: true,
  })
  @ApiOperation({ summary: 'Update a field group' })
  @ApiParam({ name: 'id' })
  @ApiBody({ type: UpdateFieldGroupDto })
  @ApiResponse({ status: 200, description: 'Field group updated' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFieldGroupDto,
  ) {
    return this.service.update(id, user.userId, dto, user.organizationId);
  }

  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(['can_manage_custom_fields', 'can_delete_field_groups'], {
    any: true,
  })
  @ApiOperation({ summary: 'Soft delete a field group (cascades assignments)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Field group soft-deleted' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.softDelete(id, user.userId, user.organizationId);
    return { success: true };
  }

  @Patch(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_custom_fields')
  @ApiOperation({
    summary: 'Action dispatcher: restore | permanent_delete | duplicate',
  })
  @ApiParam({ name: 'id' })
  @ApiBody({ type: PatchFieldGroupDto })
  @ApiResponse({ status: 200, description: 'Action applied' })
  async patch(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchFieldGroupDto,
  ) {
    switch (dto.action) {
      case 'restore':
        return this.service.restore(id, user.organizationId, user.userId);
      case 'permanent_delete':
        await this.service.permanentDelete(
          id,
          user.organizationId,
          user.userId,
        );
        return { success: true };
      case 'duplicate':
        if (!dto.newName) {
          throw new BadRequestException(
            'newName is required for action=duplicate',
          );
        }
        return this.service.duplicate(
          id,
          user.userId,
          dto.newName,
          dto.copyFields ?? true,
          user.organizationId,
        );
    }
  }

  // ---------------------------------------------------------------------
  // Fields-in-group subresource
  // ---------------------------------------------------------------------

  @Get(':id/fields')
  @ApiOperation({ summary: 'List fields belonging to a field group' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Fields returned' })
  async listFields(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getFieldsInGroup(id, user.organizationId);
  }

  @Post(':id/fields')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(['can_manage_custom_fields', 'can_edit_field_groups'], {
    any: true,
  })
  @ApiOperation({
    summary: 'Add field(s) to a group — accepts a single entry or a batch',
  })
  @ApiParam({ name: 'id' })
  @ApiBody({
    description:
      'Single `AddFieldToGroupDto` or `AddFieldsBatchDto` (detected by `fields` array)',
  })
  @ApiResponse({ status: 201, description: 'Field(s) added' })
  async addField(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AddFieldToGroupDto | AddFieldsBatchDto,
  ) {
    if (Array.isArray((body as AddFieldsBatchDto).fields)) {
      const batch = body as AddFieldsBatchDto;
      const merged = batch.fields.map((f) => ({
        ...f,
        is_required: f.is_required ?? batch.is_required,
        is_hidden: f.is_hidden ?? batch.is_hidden,
        column_span: f.column_span ?? batch.column_span,
      }));
      return this.service.addFieldsToGroupBatch(
        id,
        merged,
        user.organizationId,
        user.userId,
      );
    }
    return this.service.addFieldToGroup(
      id,
      body as AddFieldToGroupDto,
      user.organizationId,
      user.userId,
    );
  }

  @Put(':id/fields')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(['can_manage_custom_fields', 'can_edit_field_groups'], {
    any: true,
  })
  @ApiOperation({
    summary:
      'Update per-field settings OR reorder fields (when body has `reorder: true`)',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Update applied' })
  async updateFields(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body()
    body:
      | ReorderFieldsDto
      | (UpdateFieldInGroupDto & { custom_field_id: string }),
  ) {
    if ((body as ReorderFieldsDto).reorder === true) {
      const b = body as ReorderFieldsDto;
      await this.service.reorderFields(
        id,
        b.fields,
        user.organizationId,
        user.userId,
      );
      return { success: true };
    }
    const b = body as UpdateFieldInGroupDto & { custom_field_id: string };
    if (!b.custom_field_id) {
      throw new BadRequestException('custom_field_id is required');
    }
    return this.service.updateFieldInGroup(
      id,
      b.custom_field_id,
      b,
      user.organizationId,
      user.userId,
    );
  }

  @Delete(':id/fields')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(['can_manage_custom_fields', 'can_edit_field_groups'], {
    any: true,
  })
  @ApiOperation({ summary: 'Remove a field from a group' })
  @ApiParam({ name: 'id' })
  @ApiQuery({ name: 'custom_field_id', required: true })
  @ApiResponse({ status: 200, description: 'Field removed from group' })
  async removeField(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('custom_field_id') customFieldIdFromQuery: string | undefined,
    @Body() body?: { custom_field_id?: string },
  ) {
    const customFieldId = customFieldIdFromQuery ?? body?.custom_field_id;

    if (!customFieldId) {
      throw new BadRequestException('custom_field_id is required');
    }
    await this.service.removeFieldFromGroup(
      id,
      customFieldId,
      user.organizationId,
      user.userId,
    );
    return { success: true, message: 'Field removed from group successfully' };
  }

  // ---------------------------------------------------------------------
  // Assignment permissions (:id here refers to the ASSIGNMENT id)
  // ---------------------------------------------------------------------

  @Get(':id/permissions')
  @ApiOperation({
    summary:
      'Get permissions for a level-field-group assignment. NOTE: `:id` is the ASSIGNMENT id, not the group id.',
  })
  @ApiParam({ name: 'id', description: 'Assignment id' })
  @ApiResponse({ status: 200, description: 'Permissions returned' })
  async getAssignmentPermissions(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) assignmentId: string,
  ) {
    return this.service.getGroupAssignmentPermissions(
      assignmentId,
      user.organizationId,
    );
  }

  @Put(':id/permissions')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_custom_fields')
  @ApiOperation({
    summary:
      'Replace permissions for a level-field-group assignment. NOTE: `:id` is the ASSIGNMENT id.',
  })
  @ApiParam({ name: 'id', description: 'Assignment id' })
  @ApiBody({ type: SetAssignmentPermissionsDto })
  @ApiResponse({ status: 200, description: 'Permissions replaced' })
  async setAssignmentPermissions(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) assignmentId: string,
    @Body() dto: SetAssignmentPermissionsDto,
  ) {
    await this.service.bulkSetGroupAssignmentPermissions(
      assignmentId,
      dto.permissions,
      user.organizationId,
      user.userId,
    );
    return { success: true, message: 'Permissions updated successfully' };
  }
}
