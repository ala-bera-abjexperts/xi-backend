/**
 * @fileoverview REST controller for `/groups` — user groups and member management.
 * @module src/user-groups/user-groups.controller
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
import { UserGroupsService } from './user-groups.service';
import { CreateUserGroupDto } from './dto/create-user-group.dto';
import { UpdateUserGroupDto } from './dto/update-user-group.dto';
import { PatchUserGroupDto } from './dto/patch-user-group.dto';
import { AddMembersDto } from './dto/add-members.dto';
import { RemoveMembersDto } from './dto/remove-members.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { GroupMembershipsQueryDto } from './dto/group-memberships-query.dto';

@ApiTags('User Groups')
@ApiBearerAuth()
@Controller('groups')
export class UserGroupsController {
  constructor(private readonly service: UserGroupsService) {}

  // ── Groups ──────────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'List user groups' })
  @ApiQuery({ name: 'is_deleted', required: false })
  @ApiQuery({ name: 'search', required: false })
  async list(
    @CurrentUser() user: RequestUser,
    @Query('is_deleted') isDeleted?: string,
    @Query('search') search?: string,
  ) {
    return this.service.getAll(user.organizationId, {
      is_deleted:
        isDeleted === 'true' ? true : isDeleted === 'false' ? false : undefined,
      search,
    });
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_groups')
  @ApiOperation({ summary: 'Create a user group' })
  async create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateUserGroupDto,
  ) {
    return this.service.create(user.organizationId, dto, user.userId);
  }

  /**
   * Reverse lookup of group memberships for a set of users.
   *
   * MUST stay declared above `@Get(':id')`: Nest matches in declaration order,
   * so the parameterised route would otherwise claim `/groups/memberships` and
   * its `ParseUUIDPipe` would reject the literal path with a 400.
   */
  @Get('memberships')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_groups')
  @ApiOperation({
    summary: 'Get group memberships for several users',
    description:
      "Returns a map of user id to the groups that user belongs to, restricted to the caller's organization and excluding soft-deleted groups. Every requested id is present in the response; users with no groups map to an empty array.",
  })
  @ApiQuery({
    name: 'user_ids',
    required: true,
    description: 'Comma-separated user ids',
  })
  async getMemberships(
    @CurrentUser() user: RequestUser,
    @Query() query: GroupMembershipsQueryDto,
  ) {
    return this.service.getMembershipsForUsers(
      user.organizationId,
      query.user_ids,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a user group by ID' })
  @ApiParam({ name: 'id' })
  @ApiQuery({ name: 'withMembers', required: false })
  async getById(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('withMembers') withMembers?: string,
  ) {
    if (withMembers === 'true') {
      const data = await this.service.getByIdWithMembers(
        id,
        user.organizationId,
      );
      return { data, success: true };
    }
    const data = await this.service.getById(id, user.organizationId);
    return { data, success: true };
  }

  @Put(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_groups')
  @ApiOperation({ summary: 'Update a user group' })
  @ApiParam({ name: 'id' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserGroupDto,
  ) {
    return this.service.update(id, user.organizationId, dto, user.userId);
  }

  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_groups')
  @ApiOperation({ summary: 'Soft-delete a user group' })
  @ApiParam({ name: 'id' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.delete(id, user.organizationId, user.userId);
  }

  @Patch(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_groups')
  @ApiOperation({ summary: 'Actions: restore | permanent_delete | duplicate' })
  @ApiParam({ name: 'id' })
  async patch(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchUserGroupDto,
  ) {
    switch (dto.action) {
      case 'restore':
        return this.service.restore(id, user.organizationId, user.userId);

      case 'permanent_delete':
        return this.service.permanentDelete(
          id,
          user.organizationId,
          user.userId,
        );

      case 'duplicate':
        if (!dto.newName) {
          throw new BadRequestException('newName is required for duplicate');
        }
        return this.service.duplicate(
          id,
          user.organizationId,
          dto.newName,
          dto.copyMembers ?? false,
          user.userId,
        );

      default:
        throw new BadRequestException(`Unknown action: ${String(dto.action)}`);
    }
  }

  // ── Members ──────────────────────────────────────────────────────────────

  @Get(':id/members')
  @ApiOperation({ summary: 'List members of a group' })
  @ApiParam({ name: 'id' })
  async listMembers(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getMembers(id, user.organizationId);
  }

  @Post(':id/members')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_groups')
  @ApiOperation({ summary: 'Add member(s) to a group' })
  @ApiParam({ name: 'id' })
  async addMembers(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddMembersDto,
  ) {
    const roleId = dto.role_id ?? null;

    // Bulk add
    if (dto.user_ids && dto.user_ids.length > 0) {
      return this.service.addMembers(
        id,
        user.organizationId,
        dto.user_ids,
        roleId,
        user.userId,
      );
    }

    // Single add
    if (!dto.user_id) {
      throw new BadRequestException('user_id or user_ids is required');
    }
    return this.service.addMember(
      id,
      user.organizationId,
      dto.user_id,
      roleId,
      user.userId,
    );
  }

  @Delete(':id/members')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_groups')
  @ApiOperation({ summary: 'Remove member(s) from a group' })
  @ApiParam({ name: 'id' })
  async removeMembers(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RemoveMembersDto,
  ) {
    // Bulk remove
    if (dto.user_ids && dto.user_ids.length > 0) {
      return this.service.removeMembers(
        id,
        user.organizationId,
        dto.user_ids,
        user.userId,
      );
    }

    // Single remove
    if (!dto.user_id) {
      throw new BadRequestException('user_id or user_ids is required');
    }
    return this.service.removeMember(
      id,
      user.organizationId,
      dto.user_id,
      user.userId,
    );
  }

  @Patch(':id/members')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_groups')
  @ApiOperation({ summary: 'Update role of a group member' })
  @ApiParam({ name: 'id' })
  async updateMemberRole(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMemberRoleDto,
  ) {
    return this.service.updateMemberRole(
      id,
      user.organizationId,
      dto.user_id,
      dto.role_id ?? null,
      user.userId,
    );
  }
}
