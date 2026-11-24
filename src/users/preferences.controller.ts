/**
 * @fileoverview Controller for user preferences endpoints including recent items,
 * sidebar configuration, and starred spaces. All endpoints require authentication.
 * @module src/users/preferences.controller
 * @author Prince Jadiya
 */

import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Body,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { PreferencesService } from './preferences.service';
import { TrackRecentItemDto } from './dto/track-recent-item.dto';
import { UpdateSidebarPreferencesDto } from './dto/update-sidebar-preferences.dto';
import { ToggleStarDto } from './dto/toggle-star.dto';
import { SaveColumnPreferencesDto } from './dto/save-column-preferences.dto';
import {
  SaveTaskCommentPreferencesDto,
  type TaskCommentSort,
  type TaskCommentTieSort,
} from './dto/save-task-comment-preferences.dto';

/**
 * Controller for user preferences under the `/users` route prefix.
 *
 * All endpoints require authentication (Bearer token) via the global auth guard.
 *
 * Endpoints:
 * - `GET    /users/recent-items`                  -- Get recent items
 * - `POST   /users/recent-items`                  -- Track item access
 * - `DELETE  /users/recent-items`                  -- Clear all recent items
 * - `DELETE  /users/recent-items/:itemType/:itemId` -- Remove specific recent item
 * - `GET    /users/sidebar-preferences`            -- Get sidebar config
 * - `PATCH  /users/sidebar-preferences`            -- Update sidebar config
 * - `GET    /users/starred-spaces`                 -- Get starred spaces
 * - `POST   /users/starred-spaces`                 -- Toggle star on a space
 *
 * @author Prince Jadiya
 */
@ApiTags('User Preferences')
@ApiBearerAuth()
@Controller('users')
export class PreferencesController {
  /**
   * @param {PreferencesService} preferencesService - Service for user preference operations
   */
  constructor(private readonly preferencesService: PreferencesService) {}

  // ── Recent Items ─────────────────────────────────────────────────────────

  /**
   * Returns recently accessed items for the authenticated user, ordered by
   * most recently accessed first.
   *
   * @param {RequestUser} user - The authenticated user extracted by {@link CurrentUser}
   * @param {number} [limit] - Maximum number of items to return (default: 10)
   * @param {string} [item_type] - Optional filter by item type
   * @returns {Promise<any[]>} Array of recent item records
   * @author Prince Jadiya
   */
  @Get('recent-items')
  @ApiOperation({
    summary: 'Get recent items',
    description:
      'Returns recently accessed items for the authenticated user, ordered by most recent first.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Maximum number of items to return (default: 10)',
  })
  @ApiQuery({
    name: 'item_type',
    required: false,
    type: String,
    description: 'Filter by item type (e.g., space, page, issue)',
  })
  @ApiResponse({ status: 200, description: 'Recent items returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async getRecentItems(
    @CurrentUser() user: RequestUser,
    @Query('limit') limit?: number,
    @Query('item_type') item_type?: string,
  ): Promise<any[]> {
    return this.preferencesService.getRecentItems(
      user.userId,
      user.organizationId,
      limit ? Number(limit) : undefined,
      item_type,
    );
  }

  /**
   * Tracks access to an item, creating or updating the recent item record.
   *
   * @param {RequestUser} user - The authenticated user extracted by {@link CurrentUser}
   * @param {TrackRecentItemDto} body - Item details to track
   * @returns {Promise<any>} The upserted recent item record
   * @author Prince Jadiya
   */
  @Post('recent-items')
  @ApiOperation({
    summary: 'Track item access',
    description:
      'Records or updates a recently accessed item for the authenticated user.',
  })
  @ApiResponse({ status: 201, description: 'Item access tracked' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async trackAccess(
    @CurrentUser() user: RequestUser,
    @Body() body: TrackRecentItemDto,
  ): Promise<any> {
    return this.preferencesService.trackAccess(
      user.userId,
      user.organizationId,
      body,
    );
  }

  /**
   * Clears all recent items for the authenticated user.
   *
   * @param {RequestUser} user - The authenticated user extracted by {@link CurrentUser}
   * @returns {Promise<{ deleted: boolean }>} Confirmation of deletion
   * @author Prince Jadiya
   */
  @Delete('recent-items')
  @ApiOperation({
    summary: 'Clear all recent items',
    description: 'Deletes all recent item records for the authenticated user.',
  })
  @ApiResponse({ status: 200, description: 'All recent items cleared' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async clearAllRecentItems(
    @CurrentUser() user: RequestUser,
  ): Promise<{ success: boolean; message: string }> {
    return this.preferencesService.clearAllRecentItems(
      user.userId,
      user.organizationId,
    );
  }

  /**
   * Removes a specific recent item identified by item type and item ID.
   *
   * @param {RequestUser} user - The authenticated user extracted by {@link CurrentUser}
   * @param {string} itemType - The type of the item to remove
   * @param {string} itemId - The UUID of the item to remove
   * @returns {Promise<{ deleted: boolean }>} Confirmation of deletion
   * @author Prince Jadiya
   */
  @Delete('recent-items/:itemType/:itemId')
  @ApiOperation({
    summary: 'Remove specific recent item',
    description:
      'Deletes a specific recent item by its type and ID for the authenticated user.',
  })
  @ApiParam({ name: 'itemType', description: 'Item type (e.g., space, page)' })
  @ApiParam({ name: 'itemId', description: 'UUID of the item' })
  @ApiResponse({ status: 200, description: 'Recent item removed' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async deleteRecentItem(
    @CurrentUser() user: RequestUser,
    @Param('itemType') itemType: string,
    @Param('itemId') itemId: string,
  ): Promise<{ success: true; message: string }> {
    return this.preferencesService.deleteRecentItem(
      user.userId,
      user.organizationId,
      itemType,
      itemId,
    );
  }

  // ── Sidebar Preferences ──────────────────────────────────────────────────

  /**
   * Returns the authenticated user's sidebar configuration. If no preferences
   * exist, sensible defaults are returned.
   *
   * @param {RequestUser} user - The authenticated user extracted by {@link CurrentUser}
   * @returns {Promise<any>} The sidebar preferences record or defaults
   * @author Prince Jadiya
   */
  @Get('sidebar-preferences')
  @ApiOperation({
    summary: 'Get sidebar preferences',
    description:
      "Returns the authenticated user's sidebar configuration, or defaults if none set.",
  })
  @ApiResponse({ status: 200, description: 'Sidebar preferences returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async getSidebarPreferences(@CurrentUser() user: RequestUser): Promise<any> {
    return this.preferencesService.getSidebarPreferences(
      user.userId,
      user.organizationId,
    );
  }

  /**
   * Updates the authenticated user's sidebar configuration. Only provided
   * fields are merged into the existing config.
   *
   * @param {RequestUser} user - The authenticated user extracted by {@link CurrentUser}
   * @param {UpdateSidebarPreferencesDto} body - Partial sidebar settings to update
   * @returns {Promise<any>} The updated sidebar preferences record
   * @author Prince Jadiya
   */
  @Patch('sidebar-preferences')
  @ApiOperation({
    summary: 'Update sidebar preferences',
    description:
      "Updates the authenticated user's sidebar configuration. Only provided fields are merged.",
  })
  @ApiResponse({
    status: 200,
    description: 'Sidebar preferences updated',
  })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async updateSidebarPreferences(
    @CurrentUser() user: RequestUser,
    @Body() body: UpdateSidebarPreferencesDto,
  ): Promise<any> {
    return this.preferencesService.updateSidebarPreferences(
      user.userId,
      user.organizationId,
      body,
    );
  }

  /**
   * Resets sidebar preferences to defaults by deleting the stored config.
   *
   * @param {RequestUser} user - The authenticated user
   * @returns {Promise<any>} The default sidebar configuration
   * @author Prince Jadiya
   */
  @Post('sidebar-preferences/reset')
  @ApiOperation({
    summary: 'Reset sidebar preferences',
    description:
      'Deletes the stored sidebar configuration and returns defaults.',
  })
  @ApiResponse({ status: 201, description: 'Sidebar preferences reset' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async resetSidebarPreferences(
    @CurrentUser() user: RequestUser,
  ): Promise<unknown> {
    return await this.preferencesService.resetSidebarPreferences(
      user.userId,
      user.organizationId,
    );
  }

  // ── Starred Spaces ───────────────────────────────────────────────────────

  /**
   * Returns all spaces starred by the authenticated user, with space details.
   *
   * @param {RequestUser} user - The authenticated user extracted by {@link CurrentUser}
   * @returns {Promise<any[]>} Array of starred space records with space details
   * @author Prince Jadiya
   */
  @Get('starred-spaces')
  @ApiOperation({
    summary: 'Get starred spaces',
    description:
      'Returns all spaces starred by the authenticated user, with space details.',
  })
  @ApiResponse({ status: 200, description: 'Starred spaces returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async getStarredSpaces(@CurrentUser() user: RequestUser): Promise<any[]> {
    return this.preferencesService.getStarredSpaces(
      user.userId,
      user.organizationId,
    );
  }

  /**
   * Toggles the starred state of a space. If already starred, the space is
   * unstarred. If not starred, it is starred.
   *
   * @param {RequestUser} user - The authenticated user extracted by {@link CurrentUser}
   * @param {ToggleStarDto} body - Contains the space_id to toggle
   * @returns {Promise<{ starred: boolean }>} Whether the space is now starred
   * @author Prince Jadiya
   */
  @Post('starred-spaces')
  @ApiOperation({
    summary: 'Toggle star on a space',
    description:
      'Stars a space if not already starred, or unstars it if already starred.',
  })
  @ApiResponse({ status: 201, description: 'Star toggled successfully' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async toggleStar(
    @CurrentUser() user: RequestUser,
    @Body() body: ToggleStarDto,
  ): Promise<{ is_starred: boolean; space_id: string }> {
    return this.preferencesService.toggleStar(
      user.userId,
      user.organizationId,
      body.space_id,
    );
  }

  // ── Column Preferences ────────────────────────────────────────────────────

  @Get('column-preferences')
  @ApiOperation({
    summary: 'Get column preferences for a view',
    description:
      'Returns saved preferences or defaults (is_default: true) when no record exists.',
  })
  @ApiQuery({ name: 'viewId', required: true })
  @ApiResponse({ status: 200, description: 'Column preferences returned' })
  @ApiResponse({ status: 400, description: 'viewId is required' })
  async getColumnPreferences(
    @CurrentUser() user: RequestUser,
    @Query('viewId') viewId?: string,
  ) {
    if (!viewId) {
      throw new BadRequestException('viewId is required');
    }
    return this.preferencesService.getColumnPreferences(
      user.userId,
      user.organizationId,
      viewId,
    );
  }

  @Post('column-preferences')
  @HttpCode(201)
  @ApiOperation({ summary: 'Save column preferences for a view (upsert)' })
  @ApiResponse({
    status: 201,
    description: 'Preferences saved',
  })
  async saveColumnPreferences(
    @CurrentUser() user: RequestUser,
    @Body() dto: SaveColumnPreferencesDto,
  ) {
    return this.preferencesService.saveColumnPreferences(
      user.userId,
      user.organizationId,
      dto,
    );
  }

  @Delete('column-preferences')
  @ApiOperation({ summary: 'Reset column preferences to defaults' })
  @ApiQuery({ name: 'viewId', required: true })
  @ApiResponse({
    status: 200,
    description: 'Preferences reset',
  })
  async resetColumnPreferences(
    @CurrentUser() user: RequestUser,
    @Query('viewId') viewId?: string,
  ) {
    if (!viewId) {
      throw new BadRequestException('viewId is required');
    }
    return this.preferencesService.resetColumnPreferences(
      user.userId,
      user.organizationId,
      viewId,
    );
  }

  @Get('task-comment-preferences')
  @ApiOperation({ summary: 'Get task comment sort preference' })
  @ApiResponse({ status: 200, description: 'Sort preference returned' })
  async getTaskCommentPreferences(
    @CurrentUser() user: RequestUser,
  ): Promise<{ sort: TaskCommentSort; then: TaskCommentTieSort[] }> {
    return this.preferencesService.getTaskCommentPreferences(
      user.userId,
      user.organizationId,
    );
  }

  @Put('task-comment-preferences')
  @ApiOperation({ summary: 'Save task comment sort preference (upsert)' })
  @ApiResponse({ status: 200, description: 'Sort preference saved' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  async saveTaskCommentPreferences(
    @CurrentUser() user: RequestUser,
    @Body() dto: SaveTaskCommentPreferencesDto,
  ): Promise<{ sort: TaskCommentSort; then: TaskCommentTieSort[] }> {
    return this.preferencesService.saveTaskCommentPreferences(
      user.userId,
      user.organizationId,
      dto,
    );
  }
}
