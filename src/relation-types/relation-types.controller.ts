/**
 * @fileoverview REST controller for `/relation-types` — bidirectional
 * relationship type CRUD with system-type protection.
 * @module src/relation-types/relation-types.controller
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
import { RelationTypesService } from './relation-types.service';
import { CreateRelationTypeDto } from './dto/create-relation-type.dto';
import { UpdateRelationTypeDto } from './dto/update-relation-type.dto';
import { PatchRelationTypeDto } from './dto/patch-relation-type.dto';
import { ReorderRelationTypesDto } from './dto/reorder-relation-types.dto';

@ApiTags('Relation Types')
@ApiBearerAuth()
@Controller('relation-types')
export class RelationTypesController {
  constructor(private readonly service: RelationTypesService) {}

  @Get()
  @ApiOperation({ summary: 'List relation types for the organization' })
  @ApiQuery({
    name: 'includeInactive',
    required: false,
    description: 'Include inactive relation types',
  })
  @ApiResponse({ status: 200, description: 'Relation types returned' })
  async list(
    @CurrentUser() user: RequestUser,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.service.getAll(user.organizationId, includeInactive === 'true');
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_relation_types')
  @ApiOperation({ summary: 'Create a relation type' })
  @ApiResponse({ status: 201, description: 'Relation type created' })
  async create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateRelationTypeDto,
  ) {
    return this.service.create(user.organizationId, user.userId, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a relation type by ID' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Relation type returned' })
  async getById(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getById(id, user.organizationId);
  }

  @Patch('reorder')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_relation_types')
  @ApiOperation({ summary: 'Bulk reorder relation types' })
  @ApiResponse({ status: 200, description: 'Relation types reordered' })
  async reorder(
    @CurrentUser() user: RequestUser,
    @Body() dto: ReorderRelationTypesDto,
  ) {
    await this.service.reorder(dto.items, user.organizationId, user.userId);

    return { success: true, message: 'Relation types reordered' };
  }

  @Put(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_relation_types')
  @ApiOperation({ summary: 'Update a relation type (system types immutable)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Relation type updated' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRelationTypeDto,
  ) {
    return this.service.update(id, user.organizationId, user.userId, dto);
  }

  @Patch(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_relation_types')
  @ApiOperation({ summary: 'Patch action: toggle_active, duplicate' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Action applied' })
  async patch(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchRelationTypeDto,
  ) {
    if (!dto.action) {
      return this.service.update(id, user.organizationId, user.userId, dto);
    }

    switch (dto.action) {
      case 'toggle_active':
        if (dto.is_active === undefined) {
          throw new BadRequestException(
            'is_active is required for toggle_active',
          );
        }
        return this.service.toggleActive(
          id,
          dto.is_active,
          user.organizationId,
          user.userId,
        );
      case 'duplicate':
        return this.service.duplicate(
          id,
          user.organizationId,
          user.userId,
          dto.newName,
        );
      default:
        throw new BadRequestException(`Unknown action: ${dto.action}`);
    }
  }

  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_relation_types')
  @ApiOperation({
    summary: 'Delete a relation type (blocked if in use or system type)',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Relation type deleted' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.delete(id, user.organizationId, user.userId);
    return { success: true, message: 'Relation type deleted' };
  }
}
