/**
 * @fileoverview REST controller for `/roles` and `/user-role-assignments`.
 * Mirrors risk-management-app API routes with exact parity.
 * @module src/custom-roles/custom-roles.controller
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
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { CustomRolesService } from './custom-roles.service';
import { CreateCustomRoleDto } from './dto/create-custom-role.dto';
import { UpdateCustomRoleDto } from './dto/update-custom-role.dto';
import { PatchCustomRoleDto } from './dto/patch-custom-role.dto';
import { AssignRoleDto } from './dto/assign-role.dto';
import { UnassignRoleDto } from './dto/unassign-role.dto';

// ── Custom Roles ─────────────────────────────────────────────────────────────

@ApiTags('Custom Roles')
@ApiBearerAuth()
@Controller('roles')
export class CustomRolesController {
  constructor(private readonly service: CustomRolesService) {}

  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_users')
  @ApiOperation({ summary: 'List custom roles' })
  @ApiQuery({
    name: 'base_role',
    required: false,
    enum: ['owner', 'admin', 'member', 'viewer'],
  })
  @ApiQuery({ name: 'is_active', required: false })
  @ApiQuery({ name: 'is_deleted', required: false })
  @ApiQuery({ name: 'search', required: false })
  async list(
    @CurrentUser() user: RequestUser,
    @Query('base_role') baseRole?: string,
    @Query('is_active') isActive?: string,
    @Query('is_deleted') isDeleted?: string,
    @Query('search') search?: string,
  ) {
    return this.service.getAll(user.organizationId, {
      base_role: baseRole,
      is_active: isActive !== undefined ? isActive === 'true' : undefined,
      is_deleted: isDeleted !== undefined ? isDeleted === 'true' : undefined,
      search,
    });
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_roles')
  @ApiOperation({ summary: 'Create a custom role' })
  async create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateCustomRoleDto,
  ) {
    return this.service.create(user.organizationId, dto);
  }

  @Get(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_users')
  @ApiOperation({ summary: 'Get custom role by ID' })
  @ApiParam({ name: 'id' })
  async getById(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const data = await this.service.getById(id, user.organizationId);
    return { data };
  }

  @Put(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_roles')
  @ApiOperation({ summary: 'Update a custom role' })
  @ApiParam({ name: 'id' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomRoleDto,
  ) {
    return this.service.update(id, user.organizationId, dto);
  }

  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_roles')
  @ApiOperation({ summary: 'Soft-delete a custom role' })
  @ApiParam({ name: 'id' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.softDelete(id, user.organizationId, user.userId);
  }

  @Patch(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_roles')
  @ApiOperation({
    summary:
      'Actions: toggle_active | restore | permanent_delete | duplicate | check_usage',
  })
  @ApiParam({ name: 'id' })
  async patch(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchCustomRoleDto,
  ) {
    switch (dto.action) {
      case 'toggle_active':
        if (dto.is_active === undefined) {
          throw new BadRequestException(
            'is_active is required for toggle_active',
          );
        }
        return this.service.toggleActive(
          id,
          user.organizationId,
          dto.is_active,
        );

      case 'restore':
        return this.service.restore(id, user.organizationId);

      case 'permanent_delete':
        return this.service.permanentDelete(id, user.organizationId);

      case 'duplicate':
        if (!dto.newName) {
          throw new BadRequestException('newName is required for duplicate');
        }
        return this.service.duplicate(id, user.organizationId, dto.newName);

      case 'check_usage':
        return this.service.checkUsage(id, user.organizationId);

      default:
        throw new BadRequestException(`Unknown action: ${String(dto.action)}`);
    }
  }
}

// ── User Role Assignments ─────────────────────────────────────────────────────

// Deliberately NOT gated by `feature_custom_roles`, unlike CustomRolesController
// above.
//
// Creating and editing custom roles is the premium capability. Assigning and
// UNASSIGNING them is not: a tenant whose licence lapses would otherwise be
// stranded with role assignments it can no longer see or remove, and removing an
// assignment is exactly what such a tenant needs to do to get back to base
// roles. Locking must never trap a customer in a state they cannot exit.
@ApiTags('User Role Assignments')
@ApiBearerAuth()
@Controller('user-role-assignments')
export class UserRoleAssignmentsController {
  constructor(private readonly service: CustomRolesService) {}

  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_users')
  @ApiOperation({
    summary: 'List role assignments (filter by user_id or role_id)',
  })
  @ApiQuery({ name: 'user_id', required: false })
  @ApiQuery({ name: 'role_id', required: false })
  async list(
    @CurrentUser() user: RequestUser,
    @Query('user_id') userId?: string,
    @Query('role_id') roleId?: string,
  ) {
    return this.service.getAssignments(user.organizationId, {
      user_id: userId,
      role_id: roleId,
    });
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_roles')
  @ApiOperation({ summary: 'Assign a role to a user' })
  async assign(@CurrentUser() user: RequestUser, @Body() dto: AssignRoleDto) {
    return this.service.assignRole(
      user.organizationId,
      dto.user_id,
      dto.role_id,
      user.userId,
    );
  }

  @Delete()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_roles')
  @ApiOperation({
    summary:
      'Unassign role(s) from a user (role_id optional — omit to remove all)',
  })
  async unassign(
    @CurrentUser() user: RequestUser,
    @Body() dto: UnassignRoleDto,
  ) {
    return this.service.unassignRole(
      user.organizationId,
      dto.user_id,
      dto.role_id,
      user.userId,
    );
  }

  @Get(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_users')
  @ApiOperation({ summary: 'Get a role assignment by ID' })
  @ApiParam({ name: 'id' })
  async getById(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const data = await this.service.getAssignmentById(id, user.organizationId);
    return { data };
  }

  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_roles')
  @ApiOperation({ summary: 'Delete a role assignment by ID' })
  @ApiParam({ name: 'id' })
  async deleteById(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.deleteAssignmentById(
      id,
      user.organizationId,
      user.userId,
    );
  }
}
