/**
 * @fileoverview Owner-only tenant file usage analytics endpoints.
 * The route lives under `/file-explorer` to avoid colliding with the existing
 * `/organizations/:id` parameterized route while still exposing tenant-wide usage.
 * @module src/file-explorer/file-explorer-usage.controller
 */

import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireRoles } from '../auth/decorators/require-roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { FileExplorerService } from './file-explorer.service';
import type { IFeOrganizationStorageUsage } from './interfaces/fe-storage-usage.interface';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';

@RequireFeature('module_file_explorer')
@ApiTags('File Explorer')
@ApiBearerAuth()
@Controller('file-explorer')
export class FileExplorerUsageController {
  constructor(private readonly service: FileExplorerService) {}

  /**
   * Return tenant-wide File Explorer storage usage for the active organization.
   * Owner-only by design because the response includes user-level consumption.
   */
  @Get('organization-storage')
  @UseGuards(RolesGuard)
  @RequireRoles('owner')
  @ApiOperation({
    summary: 'Get organization file storage usage (owner only)',
    description:
      'Returns File Explorer storage consumption by space, uploader, and largest files for the active organization.',
  })
  @ApiResponse({ status: 200, description: 'File usage statistics returned' })
  @ApiResponse({
    status: 403,
    description: 'Only organization owners can view tenant file usage',
  })
  async getFileUsage(
    @CurrentUser() user: RequestUser,
  ): Promise<{ data: IFeOrganizationStorageUsage }> {
    return { data: await this.service.getOrganizationStorageUsage(user) };
  }
}
