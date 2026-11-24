/**
 * @fileoverview Storage quota configuration endpoints — owner/admin only except /my-quota.
 * @module src/storage-config/storage-config.controller
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireRoles } from '../auth/decorators/require-roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { StorageConfigService } from './storage-config.service';
import type {
  IOrgStorageConfigResponse,
  IUserEffectiveQuotaResponse,
} from './storage-config.service';
import type {
  UserStorageOverrideRow,
  UserStorageOverrideWithUsage,
} from './storage-config.repository';

class UpdateOrgConfigBody {
  @IsInt()
  @Min(1)
  defaultQuotaBytes!: number;
}

class SetUserOverrideBody {
  @IsInt()
  @Min(1)
  quotaBytes!: number;

  @IsIn(['admin', 'license'])
  overrideSource!: 'admin' | 'license';

  @IsOptional()
  @IsString()
  licensePlanKey?: string;
}

@ApiTags('Storage Config')
@ApiBearerAuth()
@Controller('storage-config')
export class StorageConfigController {
  constructor(private readonly service: StorageConfigService) {}

  /**
   * Get the organization's storage config, including SaaS mode detection
   * and license-plan default quota. Owner or admin only.
   */
  @Get()
  @UseGuards(RolesGuard)
  @RequireRoles('owner', 'admin')
  @ApiOperation({ summary: 'Get org storage quota config (owner/admin only)' })
  @ApiResponse({ status: 200, description: 'Org storage config returned' })
  @ApiResponse({ status: 403, description: 'Owner or admin role required' })
  async getOrgConfig(
    @CurrentUser() user: RequestUser,
  ): Promise<{ data: IOrgStorageConfigResponse }> {
    return { data: await this.service.getOrgConfig(user) };
  }

  /**
   * Update the org-level default per-user quota.
   * Blocked in SaaS mode (license controls the default).
   */
  @Patch()
  @UseGuards(RolesGuard)
  @RequireRoles('owner', 'admin')
  @ApiOperation({ summary: 'Update org default per-user quota (on-prem only)' })
  @ApiResponse({ status: 200, description: 'Org config updated' })
  @ApiResponse({
    status: 403,
    description: 'Owner/admin role required or SaaS mode',
  })
  async updateOrgConfig(
    @CurrentUser() user: RequestUser,
    @Body() body: UpdateOrgConfigBody,
  ): Promise<{ data: IOrgStorageConfigResponse }> {
    return {
      data: await this.service.updateOrgConfig(user, body.defaultQuotaBytes),
    };
  }

  /**
   * List all users who have per-user storage overrides, with their used bytes.
   * Owner or admin only.
   */
  @Get('user-overrides')
  @UseGuards(RolesGuard)
  @RequireRoles('owner', 'admin')
  @ApiOperation({
    summary: 'List user storage quota overrides (owner/admin only)',
  })
  @ApiResponse({ status: 200, description: 'User overrides returned' })
  async listUserOverrides(
    @CurrentUser() user: RequestUser,
  ): Promise<{ data: UserStorageOverrideWithUsage[] }> {
    return { data: await this.service.listUserOverrides(user) };
  }

  /**
   * Upsert a per-user storage quota override.
   * Owner or admin only.
   */
  @Put('user-overrides/:userId')
  @UseGuards(RolesGuard)
  @RequireRoles('owner', 'admin')
  @ApiOperation({
    summary: 'Set per-user storage quota override (owner/admin only)',
  })
  @ApiResponse({ status: 200, description: 'Override set' })
  async setUserOverride(
    @CurrentUser() user: RequestUser,
    @Param('userId', ParseUUIDPipe) targetUserId: string,
    @Body() body: SetUserOverrideBody,
  ): Promise<{ data: UserStorageOverrideRow }> {
    return {
      data: await this.service.setUserOverride(
        user,
        targetUserId,
        body.quotaBytes,
        body.overrideSource,
        body.licensePlanKey,
      ),
    };
  }

  /**
   * Remove a per-user storage quota override (revert to org default).
   * Idempotent — 200 even if no override existed.
   * Owner or admin only.
   */
  @Delete('user-overrides/:userId')
  @UseGuards(RolesGuard)
  @RequireRoles('owner', 'admin')
  @ApiOperation({
    summary: 'Remove per-user storage quota override (owner/admin only)',
  })
  @ApiResponse({ status: 200, description: 'Override removed' })
  async removeUserOverride(
    @CurrentUser() user: RequestUser,
    @Param('userId', ParseUUIDPipe) targetUserId: string,
  ): Promise<{ success: true }> {
    await this.service.removeUserOverride(user, targetUserId);

    return { success: true };
  }

  /**
   * Get the calling user's effective quota and used bytes.
   * Available to all authenticated users (not owner-only).
   */
  @Get('my-quota')
  @ApiOperation({ summary: 'Get my storage quota and usage' })
  @ApiResponse({ status: 200, description: 'Effective quota returned' })
  async getMyQuota(
    @CurrentUser() user: RequestUser,
  ): Promise<{ data: IUserEffectiveQuotaResponse }> {
    return { data: await this.service.getMyQuota(user) };
  }
}
