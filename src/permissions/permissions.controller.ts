/**
 * @fileoverview REST controller for `/permissions` — effective permissions, check, menu,
 * spaces, and level permission endpoints.
 * Mirrors risk-management-app API routes with exact response parity.
 * @module src/permissions/permissions.controller
 */

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { PermissionsService } from './permissions.service';
import { CheckPermissionDto } from './dto/check-permission.dto';
import { SaveMenuPermissionDto } from './dto/save-menu-permission.dto';
import { BulkMenuPermissionDto } from './dto/bulk-menu-permission.dto';
import { DeleteMenuPermissionDto } from './dto/delete-menu-permission.dto';
import { SaveLevelPermissionDto } from './dto/save-level-permission.dto';
import { DeleteLevelPermissionDto } from './dto/delete-level-permission.dto';
import { BulkSpacePermissionDto } from './dto/bulk-space-permission.dto';

@ApiTags('Permissions')
@ApiBearerAuth()
@Controller('permissions')
export class PermissionsController {
  constructor(private readonly service: PermissionsService) {}

  // ── Effective Permissions ─────────────────────────────────────────────────

  // Per-user — called on every page mount by usePermissions and the menu
  // visibility hook. 60/min is comfortably above normal navigation patterns
  // but catches accidental render loops.
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Get('effective')
  @ApiOperation({ summary: "Get current user's effective permissions" })
  @ApiQuery({ name: 'spaceId', required: false, type: String })
  @ApiQuery({ name: 'spaceKey', required: false, type: String })
  async getEffective(
    @CurrentUser() user: RequestUser,
    @Query('spaceId') spaceId?: string,
    @Query('spaceKey') spaceKey?: string,
  ) {
    const data = await this.service.getUserEffectivePermissions(
      user.userId,
      user.organizationId,
    );

    // With no space param the response is identical to before. With ?spaceId
    // or ?spaceKey we append a `space` slice (or null for non-member,
    // cross-org, or missing). Same null either way so we don't leak which
    // spaces exist.
    if (!spaceId && !spaceKey) {
      return { data, success: true };
    }

    const space = await this.service.getEffectiveSpaceSlice(
      user.userId,
      user.organizationId,
      { spaceId, spaceKey },
    );

    return { data, space, success: true };
  }

  // ── Permission Check ──────────────────────────────────────────────────────

  @Post('check')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Check permission(s) for current user',
    description:
      'Single: { permission } → { data: boolean }. Multiple: { permissions, mode } → { data: { allowed, mode, permissions } }',
  })
  async check(
    @CurrentUser() user: RequestUser,
    @Body() dto: CheckPermissionDto,
  ) {
    if (!dto.permission && !dto.permissions?.length) {
      throw new BadRequestException(
        'Either permission or permissions array required',
      );
    }

    if (dto.permission) {
      const result = await this.service.checkPermission(
        user.userId,
        user.organizationId,
        dto.permission,
      );
      return { data: result, success: true };
    }

    const mode = dto.mode ?? 'all';
    let allowed: boolean;
    if (mode === 'any') {
      allowed = await this.service.hasAnyPermission(
        user.userId,
        user.organizationId,
        dto.permissions!,
      );
    } else {
      allowed = await this.service.hasAllPermissions(
        user.userId,
        user.organizationId,
        dto.permissions!,
      );
    }
    return {
      data: { allowed, mode, permissions: dto.permissions },
      success: true,
    };
  }

  // ── Menu Permissions ──────────────────────────────────────────────────────

  // Per-user — called on every page mount for sidebar menu visibility.
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Get('menu')
  @ApiOperation({
    summary: 'Get menu permissions',
    description:
      "With userId query: returns current user's effective menu entries. Without: returns all entries (admin UI).",
  })
  @ApiQuery({ name: 'userId', required: false })
  async getMenu(
    @CurrentUser() user: RequestUser,
    @Query('userId') userId?: string,
  ) {
    if (userId) {
      const data = await this.service.getMenuPermissions(
        user.userId,
        user.organizationId,
      );
      return { data, success: true };
    }

    const data = await this.service.getAllMenuPermissions(user.organizationId);
    return { data, count: data.length, success: true };
  }

  @Post('menu')
  @HttpCode(201)
  @ApiOperation({ summary: 'Save a menu permission (admin/owner only)' })
  async saveMenu(
    @CurrentUser() user: RequestUser,
    @Body() dto: SaveMenuPermissionDto,
  ) {
    const isAdmin = await this.service.isAdminOrOwner(
      user.userId,
      user.organizationId,
    );
    if (!isAdmin) throw new ForbiddenException('Admin access required');

    const data = await this.service.saveMenuPermission(
      user.organizationId,
      dto.menuKey,
      dto.targetType,
      dto.targetId ?? null,
      dto.baseRole ?? null,
      dto.canView ?? true,
      user.userId,
    );
    return { data, success: true };
  }

  @Put('menu')
  @ApiOperation({ summary: 'Bulk save menu permissions (admin/owner only)' })
  async bulkSaveMenu(
    @CurrentUser() user: RequestUser,
    @Body() dto: BulkMenuPermissionDto,
  ) {
    const isAdmin = await this.service.isAdminOrOwner(
      user.userId,
      user.organizationId,
    );
    if (!isAdmin) throw new ForbiddenException('Admin access required');

    await this.service.saveMenuPermissions(
      user.organizationId,
      dto.permissions,
      user.userId,
    );
    return {
      success: true,
      message: `Saved ${dto.permissions.length} permission(s)`,
    };
  }

  @Delete('menu')
  @ApiOperation({ summary: 'Delete a menu permission (admin/owner only)' })
  async deleteMenu(
    @CurrentUser() user: RequestUser,
    @Body() dto: DeleteMenuPermissionDto,
  ) {
    const isAdmin = await this.service.isAdminOrOwner(
      user.userId,
      user.organizationId,
    );
    if (!isAdmin) throw new ForbiddenException('Admin access required');

    await this.service.deleteMenuPermission(
      dto.id,
      user.organizationId,
      user.userId,
    );
    return { success: true, message: 'Permission deleted' };
  }

  // ── Space Overrides ───────────────────────────────────────────────────────

  @Get('spaces')
  @ApiOperation({
    summary: 'Get base role overrides and group permission overrides',
    description:
      'Response: { overrides, groupOverrides } — no success wrapper.',
  })
  async getSpaces(@CurrentUser() user: RequestUser) {
    await this.service.assertCanViewSpacePermissions(
      user.userId,
      user.organizationId,
    );

    return this.service.getSpaceOverrides(user.organizationId);
  }

  @Put('spaces')
  @ApiOperation({
    summary:
      'Bulk save space permissions (admin/owner or can_manage_space_permissions)',
  })
  async updateSpaces(
    @CurrentUser() user: RequestUser,
    @Body() dto: BulkSpacePermissionDto,
  ) {
    await this.service.assertCanManageSpacePermissions(
      user.userId,
      user.organizationId,
    );

    const counts = await this.service.bulkSaveSpaceOverrides(
      user.organizationId,
      dto.permissions,
      user.userId,
    );
    return {
      success: true,
      message: `Updated ${counts.roleCount} role(s), ${counts.baseRoleCount} base role(s), ${counts.groupCount} group(s)`,
    };
  }

  // ── Level Permissions ─────────────────────────────────────────────────────

  @Get('level')
  @ApiOperation({
    summary: 'Get level permissions',
    description:
      "With userId + hierarchyLevelId: returns current user's level permissions. Without: returns all (admin UI).",
  })
  @ApiQuery({ name: 'userId', required: false })
  @ApiQuery({ name: 'hierarchyLevelId', required: false })
  @ApiQuery({
    name: 'entityType',
    required: false,
    enum: ['process', 'task'],
  })
  async getLevel(
    @CurrentUser() user: RequestUser,
    @Query('userId') userId?: string,
    @Query('hierarchyLevelId') hierarchyLevelId?: string,
    @Query('entityType') entityType?: string,
  ) {
    if (userId && hierarchyLevelId) {
      const data = await this.service.getLevelPermissions(
        user.userId,
        user.organizationId,
        hierarchyLevelId,
        entityType || 'process',
      );
      return { data, success: true };
    }

    const data = await this.service.getAllLevelPermissions(user.organizationId);
    return { data, count: data.length, success: true };
  }

  @Post('level')
  @HttpCode(201)
  @ApiOperation({ summary: 'Save a level permission (admin/owner only)' })
  async saveLevel(
    @CurrentUser() user: RequestUser,
    @Body() dto: SaveLevelPermissionDto,
  ) {
    const isAdmin = await this.service.isAdminOrOwner(
      user.userId,
      user.organizationId,
    );
    if (!isAdmin) throw new ForbiddenException('Admin access required');

    const {
      hierarchyLevelId,
      entityType,
      targetType,
      targetId,
      baseRole,
      ...permFields
    } = dto;

    const data = await this.service.saveLevelPermission(
      user.organizationId,
      hierarchyLevelId,
      entityType,
      targetType,
      targetId ?? null,
      baseRole ?? null,
      permFields as Record<string, boolean>,
      user.userId,
    );
    return { data, success: true };
  }

  @Delete('level')
  @ApiOperation({ summary: 'Delete a level permission (admin/owner only)' })
  async deleteLevel(
    @CurrentUser() user: RequestUser,
    @Body() dto: DeleteLevelPermissionDto,
  ) {
    const isAdmin = await this.service.isAdminOrOwner(
      user.userId,
      user.organizationId,
    );
    if (!isAdmin) throw new ForbiddenException('Admin access required');

    await this.service.deleteLevelPermission(
      dto.id,
      user.organizationId,
      user.userId,
    );
    return { success: true, message: 'Permission deleted' };
  }
}
