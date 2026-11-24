/**
 * @fileoverview Controller for space management, membership, icon, modules, permissions, and invitation endpoints.
 * Provides 23 routes for CRUD, member management, icon upload/delete, archive/unarchive, modules, permissions, and space invitations.
 * @module src/spaces/spaces.controller
 * @author Prince Jadiya
 */

import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AllowWithoutSso } from '../auth/decorators/allow-without-sso.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import {
  SpacesService,
  Space,
  SpaceMember,
  SpaceModule,
  SpaceInvitation,
} from './spaces.service';
import { SpaceMemberRulesService } from './space-member-rules.service';
import { SpaceCategoriesService } from './space-categories.service';
import { TasksService } from '../tasks/tasks.service';
import { ReorderTasksDto } from '../tasks/dto/reorder-tasks.dto';
import { CreateSpaceDto } from './dto/create-space.dto';
import { UpdateSpaceDto } from './dto/update-space.dto';
import { CreateSpaceMemberDto } from './dto/create-space-member.dto';
import { UpdateSpaceMemberDto } from './dto/update-space-member.dto';
import { UpdateSpaceModulesDto } from './dto/update-space-modules.dto';
import { CreateSpaceInvitationsDto } from './dto/create-space-invitations.dto';
import { CreateSpaceCategoryDto } from './dto/create-space-category.dto';
import { UpdateSpaceCategoryDto } from './dto/update-space-category.dto';

/**
 * Controller for space management under the `/spaces` route prefix.
 *
 * Provides 23 endpoints:
 * - CRUD: list, create, get by key, get by id, update, delete
 * - Archive: archive (soft delete), unarchive
 * - Icon: upload, delete
 * - Members: list, add, update role, remove, implicit members
 * - Modules: list, update
 * - Permissions: get my permissions
 * - Invitations: list, bulk create, resend, revoke, accept
 */
@ApiTags('Spaces')
@ApiBearerAuth()
@Controller('spaces')
export class SpacesController {
  /**
   * @param {SpacesService} spacesService - Service for space operations
   */
  constructor(
    private readonly spacesService: SpacesService,
    private readonly categoriesService: SpaceCategoriesService,
    private readonly tasksService: TasksService,
    private readonly memberRules: SpaceMemberRulesService,
  ) {}

  // ── Spaces CRUD ─────────────────────────────────────────────────────────

  /**
   * Returns a paginated list of spaces for the user's organization.
   *
   * @param {RequestUser} user - The authenticated user
   * @param {number} page - Page number (default 1)
   * @param {number} pageSize - Items per page (default 20, max 50)
   * @param {string} is_active - Filter by active status
   * @param {string} is_archived - Filter by archived status
   * @param {string} category - Filter by category
   * @param {string} lead_id - Filter by lead user ID
   * @param {string} search - Search by name
   * @param {string} accessible_only - `true` limits the list to spaces the caller can view
   * @returns {Promise<{ data: Space[]; total: number; page: number; pageSize: number }>}
   */
  @Get()
  @ApiOperation({
    summary: 'List organization spaces',
    description:
      "Returns a paginated list of spaces for the authenticated user's organization. Supports filtering by active/archived status, category, lead, and name search.",
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'is_active', required: false, type: Boolean })
  @ApiQuery({ name: 'is_archived', required: false, type: Boolean })
  @ApiQuery({ name: 'category', required: false, type: String })
  @ApiQuery({ name: 'lead_id', required: false, type: String })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'accessible_only', required: false, type: Boolean })
  @ApiResponse({ status: 200, description: 'Paginated list of spaces' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async getSpaces(
    @CurrentUser() user: RequestUser,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('is_active') is_active?: string,
    @Query('is_archived') is_archived?: string,
    @Query('category') category?: string,
    @Query('lead_id') lead_id?: string,
    @Query('search') search?: string,
    @Query('accessible_only') accessible_only?: string,
  ): Promise<{ data: Space[]; total: number; page: number; pageSize: number }> {
    const filters: Record<string, unknown> = {};
    if (is_active !== undefined) filters.is_active = is_active === 'true';
    if (is_archived !== undefined) filters.is_archived = is_archived === 'true';
    if (category) filters.category = category;
    if (lead_id) filters.lead_id = lead_id;
    if (search) filters.search = search;
    if (accessible_only === 'true') filters.accessible_to_user_id = user.userId;

    return this.spacesService.getSpaces(
      user.organizationId,
      filters,
      parseInt(page ?? '1', 10),
      parseInt(pageSize ?? '20', 10),
    );
  }

  /**
   * Creates a new space within the user's organization.
   *
   * @param {RequestUser} user - The authenticated user
   * @param {CreateSpaceDto} body - Space creation payload
   * @returns {Promise<Space>} The newly created space
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_create_spaces')
  @ApiOperation({
    summary: 'Create space',
    description:
      "Creates a new space in the user's organization. Auto-generates a key if not provided. Requires can_create_spaces permission.",
  })
  @ApiResponse({ status: 201, description: 'Space created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  async createSpace(
    @CurrentUser() user: RequestUser,
    @Body() body: CreateSpaceDto,
  ): Promise<Space> {
    return this.spacesService.createSpace(
      user.organizationId,
      user.userId,
      body,
    );
  }

  /**
   * Returns the authenticated user's accessible spaces.
   *
   * @param {RequestUser} user - The authenticated user
   * @returns {Promise<Space[]>} Array of spaces
   */
  @Get('user')
  @ApiOperation({
    summary: "Get current user's spaces",
    description:
      'Returns all spaces the authenticated user has direct membership in.',
  })
  @ApiResponse({ status: 200, description: 'User spaces returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async getUserSpaces(@CurrentUser() user: RequestUser): Promise<Space[]> {
    return this.spacesService.getUserSpaces(user.userId, user.organizationId);
  }

  @Get('can-view')
  @ApiOperation({
    summary: 'Check whether current user can view spaces',
    description:
      'Compatibility endpoint for ticket forms that need the legacy can_view_space override check.',
  })
  @ApiResponse({ status: 200, description: 'Space visibility returned' })
  async canViewSpaces(
    @CurrentUser() user: RequestUser,
  ): Promise<{ canViewSpaces: boolean }> {
    return this.spacesService.canViewSpaces(user.userId, user.organizationId);
  }

  @Get('recent')
  @ApiOperation({
    summary: "Get current user's recent spaces",
    description:
      'Returns recently accessed spaces for the current user, falling back to recently updated organization spaces.',
  })
  @ApiResponse({ status: 200, description: 'Recent spaces returned' })
  async getRecentSpaces(@CurrentUser() user: RequestUser): Promise<Space[]> {
    return this.spacesService.getRecentSpaces(user.userId, user.organizationId);
  }

  /**
   * Checks if a space key is available within the user's organization.
   *
   * @param {RequestUser} user - The authenticated user
   * @param {string} key - Space key to check
   * @returns {Promise<{ available: boolean; space?: Space }>}
   */
  @Get('by-key/:key')
  @ApiOperation({
    summary: 'Check space key availability',
    description:
      "Checks if the given space key is available within the user's organization.",
  })
  @ApiParam({ name: 'key', description: 'Space key to check' })
  @ApiResponse({ status: 200, description: 'Key availability result' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async getSpaceByKey(
    @CurrentUser() user: RequestUser,
    @Param('key') key: string,
  ): Promise<{ exists: boolean; data?: Space }> {
    const result = await this.spacesService.getSpaceByKey(
      key,
      user.organizationId,
    );
    return { exists: !result.available, data: result.space };
  }

  /**
   * Lists the spaces the caller can access in their active org (member, org
   * owner/admin, or group/role grants). Backs the MCP `space.list` tool. Only
   * the global guard runs here (no space/feature guard) so normal app auth and
   * S2S callers reach it the same way.
   *
   * Declared before `@Get(':id')` so the literal `mine` segment wins routing
   * and isn't captured as an `:id` param (which carries a space guard).
   */
  @Get('mine')
  @ApiOperation({
    summary: 'List spaces the current user can access',
    description:
      'Returns the spaces the authenticated caller can access in their active ' +
      'organization (direct membership, org owner/admin, or group/role grants). ' +
      'Never cross-org, never non-member. Result is never null. Backs the MCP ' +
      'space.list tool.',
  })
  @ApiQuery({ name: 'includeArchived', required: false, type: Boolean })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Accessible spaces returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async getMySpaces(
    @CurrentUser() user: RequestUser,
    @Query('includeArchived') includeArchived?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<{
    spaces: Array<{
      id: string;
      key: string;
      name: string;
      description: string | null;
      icon: string | null;
      color: string | null;
      isArchived: boolean;
      modules: string[];
    }>;
    nextCursor?: string;
  }> {
    return this.spacesService.listMyAccessibleSpaces(user, {
      includeArchived: includeArchived === 'true',
      limit: limit ? parseInt(limit, 10) : undefined,
      cursor: cursor || undefined,
    });
  }

  /**
   * Resolves one accessible space (by UUID or key) with the caller's role and
   * effective space-permission keys. Backs the MCP `space.get` tool.
   *
   * Anti-probing: non-member, nonexistent, and cross-org all return the same
   * 404 so the endpoint can't enumerate spaces. Declared before `@Get(':id')`
   * so the literal `mine` prefix wins routing.
   */
  @Get('mine/:spaceIdOrKey')
  @ApiOperation({
    summary: 'Get one accessible space with the caller permissions',
    description:
      'Resolves a space by UUID or key and returns it with the caller role and ' +
      'effective space-permission keys. Non-member, nonexistent, and cross-org ' +
      'all return an identical 404 (anti-probing). Backs the MCP space.get tool.',
  })
  @ApiParam({ name: 'spaceIdOrKey', description: 'Space UUID or key' })
  @ApiResponse({ status: 200, description: 'Accessible space returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 404,
    description: 'Space not found or not accessible',
  })
  async getMySpace(
    @CurrentUser() user: RequestUser,
    @Param('spaceIdOrKey') spaceIdOrKey: string,
  ): Promise<{
    space: {
      id: string;
      key: string;
      name: string;
      description: string | null;
      isArchived: boolean;
      modules: string[];
    };
    myRole: string | null;
    myPermissions: string[];
  }> {
    return this.spacesService.getMyAccessibleSpace(user, spaceIdOrKey);
  }

  /**
   * Retrieves a space by its ID.
   *
   * @param {string} id - Space UUID
   * @returns {Promise<Space>} The space record
   */
  @Get(':id')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('view_space')
  @ApiOperation({
    summary: 'Get space details',
    description: 'Returns the space record for the given ID.',
  })
  @ApiParam({ name: 'id', description: 'Space UUID' })
  @ApiResponse({ status: 200, description: 'Space details returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Space not found' })
  async getSpaceById(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query('withRelations') withRelations?: string,
    @Query('with_details') with_details?: string,
  ): Promise<Space | Record<string, unknown>> {
    if (withRelations === 'true' || with_details === 'true') {
      return this.spacesService.getSpaceWithRelations(id, user.organizationId);
    }

    return this.spacesService.getSpaceById(id, user.organizationId);
  }

  /**
   * Updates a space's fields.
   *
   * @param {RequestUser} user - The authenticated user
   * @param {string} id - Space UUID
   * @param {UpdateSpaceDto} body - Fields to update
   * @returns {Promise<Space>} The updated space
   */
  @Put(':id')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('edit_space_settings')
  @ApiOperation({
    summary: 'Update space',
    description: 'Updates the specified space fields.',
  })
  @ApiParam({ name: 'id', description: 'Space UUID' })
  @ApiResponse({ status: 200, description: 'Space updated successfully' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Space not found' })
  async updateSpace(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() body: UpdateSpaceDto,
  ): Promise<Space> {
    return this.spacesService.updateSpace(
      id,
      user.userId,
      body,
      user.organizationId,
    );
  }

  /**
   * Archives (soft-delete) or hard-deletes a space.
   * Pass `?permanent=true` for hard deletion (space must already be archived).
   *
   * @param {RequestUser} user - The authenticated user
   * @param {string} id - Space UUID
   * @param {string} permanent - If 'true', performs hard deletion
   * @returns {Promise<Space | { deleted: true }>}
   */
  @Delete(':id')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('archive_space')
  @ApiOperation({
    summary: 'Delete space',
    description:
      'Archives (soft-delete) or permanently deletes a space. ' +
      'Pass ?archived=true to explicitly archive. ' +
      'Pass ?hard=true for permanent deletion (space must be archived first). ' +
      'Default (no params) archives the space.',
  })
  @ApiParam({ name: 'id', description: 'Space UUID' })
  @ApiQuery({
    name: 'archived',
    required: false,
    type: Boolean,
    description: 'If true, archives (soft-deletes) the space',
  })
  @ApiQuery({
    name: 'hard',
    required: false,
    type: Boolean,
    description:
      'If true, permanently deletes the space (must be archived first)',
  })
  @ApiResponse({ status: 200, description: 'Space deleted/archived' })
  @ApiResponse({
    status: 400,
    description: 'Space not archived (for permanent delete)',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async deleteSpace(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query('hard') hard?: string,
  ): Promise<{ success: boolean }> {
    if (hard === 'true') {
      await this.spacesService.deleteSpace(
        id,
        user.userId,
        user.organizationId,
      );
    } else {
      // archived=true or no params both archive the space (soft-delete)
      await this.spacesService.archiveSpace(
        id,
        user.userId,
        user.organizationId,
      );
    }

    return { success: true };
  }

  // ── Icon ────────────────────────────────────────────────────────────────

  /**
   * Uploads a space icon image.
   *
   * @param {RequestUser} user - The authenticated user
   * @param {string} id - Space UUID
   * @param {Express.Multer.File} file - The uploaded file
   * @returns {Promise<Space>} The updated space
   */
  @Post(':id/icon')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('edit_space_settings')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({
    summary: 'Upload space icon',
    description:
      'Uploads an icon image for the space. Max 5 MB. Supported: JPEG, PNG, WebP, SVG.',
  })
  @ApiParam({ name: 'id', description: 'Space UUID' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
      },
      required: ['file'],
    },
  })
  @ApiResponse({ status: 201, description: 'Icon uploaded successfully' })
  @ApiResponse({ status: 400, description: 'Invalid file type or size' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async uploadIcon(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<Space> {
    if (!file) {
      throw new BadRequestException('No file provided');
    }
    return this.spacesService.uploadIcon(
      id,
      user.userId,
      file.buffer,
      file.originalname,
      file.mimetype,
    );
  }

  /**
   * Deletes the space icon.
   *
   * @param {RequestUser} user - The authenticated user
   * @param {string} id - Space UUID
   * @returns {Promise<Space>} The updated space with cleared icon fields
   */
  @Delete(':id/icon')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('edit_space_settings')
  @ApiOperation({
    summary: 'Delete space icon',
    description: 'Deletes the space icon from storage and clears icon fields.',
  })
  @ApiParam({ name: 'id', description: 'Space UUID' })
  @ApiResponse({ status: 200, description: 'Icon deleted successfully' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Space not found' })
  async deleteIcon(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ): Promise<Space> {
    return this.spacesService.deleteIcon(id, user.userId);
  }

  // ── Archive ─────────────────────────────────────────────────────────────

  /**
   * Restores an archived space.
   *
   * @param {RequestUser} user - The authenticated user
   * @param {string} id - Space UUID
   * @returns {Promise<Space>} The restored space
   */
  @Post(':id/unarchive')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('archive_space')
  @ApiOperation({
    summary: 'Unarchive space',
    description: 'Restores a previously archived space.',
  })
  @ApiParam({ name: 'id', description: 'Space UUID' })
  @ApiResponse({ status: 201, description: 'Space unarchived successfully' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Space not found' })
  async unarchiveSpace(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ): Promise<Space> {
    // Only a space in the caller's organization; org admins pass the guard for any space id
    await this.spacesService.getSpaceById(id, user.organizationId);

    return this.spacesService.unarchiveSpace(id, user.userId);
  }

  // ── Members ─────────────────────────────────────────────────────────────

  /**
   * Returns all active members of a space.
   *
   * @param {string} id - Space UUID
   * @returns {Promise<SpaceMember[]>} Array of space members
   */
  @Get(':id/members')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('view_space')
  @ApiOperation({
    summary: 'List space members',
    description: 'Returns all active members of the specified space.',
  })
  @ApiParam({ name: 'id', description: 'Space UUID' })
  @ApiResponse({ status: 200, description: 'Space members returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Space not found' })
  async getSpaceMembers(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ): Promise<SpaceMember[]> {
    await this.memberRules.assertSpaceInOrg(user.organizationId, id);
    return this.spacesService.getSpaceMembersWithDetails(
      id,
      user.organizationId,
    );
  }

  /**
   * Adds a member to a space.
   *
   * @param {RequestUser} user - The authenticated user
   * @param {string} id - Space UUID
   * @param {CreateSpaceMemberDto} body - Member payload
   * @returns {Promise<SpaceMember>} The created member
   */
  @Post(':id/members')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('manage_members')
  @ApiOperation({
    summary: 'Add space member',
    description:
      'Adds a user, group, or role as a member of the space. Reactivates if previously removed.',
  })
  @ApiParam({ name: 'id', description: 'Space UUID' })
  @ApiResponse({ status: 201, description: 'Member added successfully' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 409, description: 'Member already exists' })
  async addSpaceMember(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() body: CreateSpaceMemberDto,
  ): Promise<SpaceMember> {
    await this.memberRules.assertCanAdd(user, id, body);
    return this.spacesService.addSpaceMember(
      id,
      user.organizationId,
      user.userId,
      body,
    );
  }

  /**
   * Updates a space member's role.
   *
   * @param {UpdateSpaceMemberDto} body - Member update payload
   * @returns {Promise<SpaceMember>} The updated member
   */
  @Patch(':id/members')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('manage_members')
  @ApiOperation({
    summary: 'Update space member role',
    description: 'Updates the role of an existing space member.',
  })
  @ApiParam({ name: 'id', description: 'Space UUID' })
  @ApiResponse({ status: 200, description: 'Member updated successfully' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async updateSpaceMember(
    @CurrentUser() user: RequestUser,
    @Body() body: UpdateSpaceMemberDto,
    @Param('id') id?: string,
  ): Promise<SpaceMember> {
    // The controller spec pins the 3-argument call, so only scope when :id is present.
    if (id) {
      await this.memberRules.assertCanChangeRole(user, id, body.member_id, body.space_role);
      return this.spacesService.updateSpaceMember(
        body.member_id,
        body,
        user.userId,
        id,
      );
    }
    return this.spacesService.updateSpaceMember(
      body.member_id,
      body,
      user.userId,
    );
  }

  /**
   * Removes a member from a space (hard delete with full cleanup).
   *
   * @param {RequestUser} user - Authenticated user
   * @param {string} id - Space UUID
   * @param {string} member_id - space_members record UUID (query parameter)
   * @returns {Promise<{ success: true }>} Confirmation of removal
   */
  @Delete(':id/members')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('manage_members')
  @ApiOperation({
    summary: 'Remove space member',
    description:
      'Permanently removes a space member. Cleans up permissions and derived memberships. Pass member_id as a query parameter.',
  })
  @ApiParam({ name: 'id', description: 'Space UUID' })
  @ApiQuery({
    name: 'member_id',
    required: true,
    type: String,
    description: 'UUID of the space_members record to remove',
  })
  @ApiResponse({ status: 200, description: 'Member removed successfully' })
  @ApiResponse({ status: 400, description: 'member_id missing or last admin' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Member not found' })
  async removeSpaceMember(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query('member_id') member_id: string,
  ): Promise<{ success: true }> {
    if (!member_id) {
      throw new BadRequestException('member_id query parameter is required');
    }
    await this.memberRules.assertCanRemove(user, id, member_id);
    return this.spacesService.removeSpaceMember(
      member_id,
      id,
      user.organizationId,
      user.userId,
    );
  }

  /**
   * Returns users with implicit access to the space via group or role memberships.
   *
   * @param {string} id - Space UUID
   * @returns {Promise<Record<string, unknown>[]>} Implicit access records
   */
  @Get(':id/members/implicit')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('view_space')
  @ApiOperation({
    summary: 'Get implicit space members',
    description:
      'Returns users who have implicit access to the space via group or role memberships.',
  })
  @ApiParam({ name: 'id', description: 'Space UUID' })
  @ApiResponse({ status: 200, description: 'Implicit members returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async getImplicitMembers(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ): Promise<{ userIds: string[] }> {
    await this.memberRules.assertSpaceInOrg(user.organizationId, id);
    const userIds = await this.spacesService.getImplicitSpaceMembers(id);

    return { userIds };
  }

  // ── Modules ──────────────────────────────────────────────────────────

  /**
   * Returns modules configured for a space.
   *
   * @param {string} id - Space UUID
   * @param {string} enabled_only - If 'true', return only enabled modules
   * @returns {Promise<SpaceModule[]>} Array of space modules
   * @author Prince Jadiya
   */
  // Per-user — sidebar legitimately fans out to several spaces on dashboard
  // mount (one /modules call per recent space), so 120/min is generous enough
  // to cover that pattern without raising false positives.
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Get(':id/modules')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('view_space')
  @ApiOperation({
    summary: 'List space modules',
    description:
      'Returns modules configured for the space, sorted by sort_order. Optionally filter to enabled only.',
  })
  @ApiParam({ name: 'id', description: 'Space UUID' })
  @ApiQuery({
    name: 'enabled_only',
    required: false,
    type: Boolean,
    description: 'If true, return only enabled modules',
  })
  @ApiResponse({ status: 200, description: 'Space modules returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async getSpaceModules(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query('enabled_only') enabled_only?: string,
    @Query('enabledOnly') enabledOnly?: string,
  ): Promise<SpaceModule[]> {
    return this.spacesService.getSpaceModules(
      id,
      user.organizationId,
      enabled_only === 'true' || enabledOnly === 'true',
    );
  }

  /**
   * Updates (upserts) space modules configuration.
   *
   * @param {RequestUser} user - The authenticated user
   * @param {string} id - Space UUID
   * @param {UpdateSpaceModulesDto} body - Modules update payload
   * @returns {Promise<SpaceModule[]>} The updated modules array
   * @author Prince Jadiya
   */
  @Put(':id/modules')
  @UseGuards(SpacePermissionsGuard)
  // Only the Space Permissions Modules Edit tick (members of the space) or org owner/admin
  @RequireSpacePermission('edit_space_modules', ['can_edit_space_modules'])
  @ApiOperation({
    summary: 'Update space modules',
    description:
      'Upserts space module records. Use to enable/disable modules, reorder, or update settings.',
  })
  @ApiParam({ name: 'id', description: 'Space UUID' })
  @ApiResponse({ status: 200, description: 'Modules updated successfully' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async updateSpaceModules(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() body: UpdateSpaceModulesDto,
  ): Promise<SpaceModule[]> {
    return this.spacesService.updateSpaceModules(
      id,
      user.userId,
      user.organizationId,
      body.modules,
    );
  }

  // ── Permissions ──────────────────────────────────────────────────────

  /**
   * Returns the authenticated user's effective permissions in a space.
   *
   * @param {RequestUser} user - The authenticated user
   * @param {string} id - Space UUID
   * @returns {Promise<Record<string, unknown>>} Effective permissions with source info
   * @author Prince Jadiya
   */
  @Get(':id/permissions/me')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('view_space')
  @ApiOperation({
    summary: 'Get my permissions in space',
    description:
      'Returns the effective permissions for the authenticated user in this space. Org admins/owners get full access.',
  })
  @ApiParam({ name: 'id', description: 'Space UUID' })
  @ApiResponse({ status: 200, description: 'Permissions returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async getMyPermissions(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ): Promise<Record<string, unknown>> {
    return this.spacesService.getUserSpacePermissions(
      user.userId,
      id,
      user.organizationId,
    );
  }

  /**
   * Returns all module-permission overrides for the space (admin UI).
   * Shape matches the legacy Next.js endpoint exactly so existing hooks
   * (useSpaceModulePermissions) work without code changes.
   */
  @Get(':id/permissions/modules')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('view_module_permissions')
  @ApiOperation({
    summary: 'List module permission overrides',
    description:
      'Returns every space_module_permissions row for this space. Used by the per-space ModulePermissionsSection admin UI.',
  })
  @ApiParam({ name: 'id', description: 'Space UUID' })
  @ApiResponse({ status: 200, description: 'Override list returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async listModulePermissions(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ): Promise<Record<string, unknown>[]> {
    return this.spacesService.listModulePermissions(id, user.organizationId);
  }

  /**
   * Bulk-upserts module permission overrides for the space.
   * Body shape: `{ overrides: { "<targetType>:<targetId>": { <permKey>: bool|null, ... }, ... } }`.
   * `null` values delete that key from the JSONB; an empty resulting object
   * deletes the row entirely (falls back to global).
   */
  @Put(':id/permissions/modules')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('manage_module_permissions')
  @ApiOperation({
    summary: 'Bulk-upsert module permission overrides',
    description:
      'Saves a batch of `space_module_permissions` overrides. Keys use `targetType:targetId` (e.g. `base_role:member`).',
  })
  @ApiParam({ name: 'id', description: 'Space UUID' })
  @ApiResponse({ status: 200, description: 'Overrides saved' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  async saveModulePermissions(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body()
    body: { overrides?: Record<string, Record<string, boolean | null>> },
  ): Promise<{ success: true; updated: number }> {
    if (!body?.overrides || typeof body.overrides !== 'object') {
      throw new BadRequestException(
        'Missing required field: overrides (object)',
      );
    }
    const updated = await this.spacesService.saveModulePermissions(
      id,
      body.overrides,
      user.userId,
      user.organizationId,
    );
    return { success: true, updated };
  }

  // ── Space Invitations ────────────────────────────────────────────────

  /**
   * Returns pending invitations for a space.
   *
   * @param {string} id - Space UUID
   * @returns {Promise<SpaceInvitation[]>} Array of pending invitations
   * @author Prince Jadiya
   */
  @Get(':id/invitations')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('invite_members')
  @ApiOperation({
    summary: 'List space invitations',
    description: 'Returns pending invitations for the specified space.',
  })
  @ApiParam({ name: 'id', description: 'Space UUID' })
  @ApiResponse({ status: 200, description: 'Space invitations returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async getSpaceInvitations(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ): Promise<SpaceInvitation[]> {
    await this.memberRules.assertSpaceInOrg(user.organizationId, id);
    return this.spacesService.getSpaceInvitations(id);
  }

  /**
   * Bulk-invites users to a space.
   *
   * @param {RequestUser} user - The authenticated user
   * @param {string} id - Space UUID
   * @param {CreateSpaceInvitationsDto} body - Bulk invitation payload
   * @returns {Promise<{ created: Record<string, unknown>[]; errors: Record<string, unknown>[] }>}
   * @author Prince Jadiya
   */
  @Post(':id/invitations')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('invite_members')
  @ApiOperation({
    summary: 'Bulk invite users to space',
    description:
      'Invites multiple users to a space. Validates each user exists, is an org member, not already a space member, and has no pending invite.',
  })
  @ApiParam({ name: 'id', description: 'Space UUID' })
  @ApiResponse({ status: 201, description: 'Invitations created' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async createSpaceInvitations(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() body: CreateSpaceInvitationsDto,
  ): Promise<{
    created: Record<string, unknown>[];
    errors: Record<string, unknown>[];
  }> {
    await this.memberRules.assertCanInvite(user, id, body.users);
    return this.spacesService.createSpaceInvitations(
      id,
      user.organizationId,
      user.userId,
      body.users,
    );
  }

  /**
   * Resends a space invitation with a new token and expiry.
   *
   * @param {RequestUser} user - The authenticated user
   * @param {string} id - Space UUID
   * @param {string} invitationId - Invitation UUID
   * @returns {Promise<SpaceInvitation>} The updated invitation
   * @author Prince Jadiya
   */
  @Post(':id/invitations/:invitationId')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('invite_members')
  @ApiOperation({
    summary: 'Resend space invitation',
    description:
      'Generates a new token and extends expiry for the specified space invitation.',
  })
  @ApiParam({ name: 'id', description: 'Space UUID' })
  @ApiParam({ name: 'invitationId', description: 'Invitation UUID' })
  @ApiResponse({ status: 201, description: 'Invitation resent' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Invitation not found' })
  async resendSpaceInvitation(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('invitationId') invitationId: string,
  ): Promise<SpaceInvitation> {
    await this.memberRules.assertSpaceInOrg(user.organizationId, id);
    return this.spacesService.resendSpaceInvitation(
      id,
      invitationId,
      user.organizationId,
    );
  }

  /**
   * Revokes a space invitation.
   *
   * @param {string} id - Space UUID
   * @param {string} invitationId - Invitation UUID
   * @returns {Promise<SpaceInvitation>} The revoked invitation
   * @author Prince Jadiya
   */
  @Delete(':id/invitations/:invitationId')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('invite_members')
  @ApiOperation({
    summary: 'Revoke space invitation',
    description: 'Sets the invitation status to revoked.',
  })
  @ApiParam({ name: 'id', description: 'Space UUID' })
  @ApiParam({ name: 'invitationId', description: 'Invitation UUID' })
  @ApiResponse({ status: 200, description: 'Invitation revoked' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Invitation not found' })
  async revokeSpaceInvitation(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('invitationId') invitationId: string,
  ): Promise<SpaceInvitation> {
    await this.memberRules.assertSpaceInOrg(user.organizationId, id);
    return this.spacesService.revokeSpaceInvitation(
      id,
      invitationId,
      user.userId,
    );
  }

  /**
   * Accepts a space invitation, adding the user as a space member.
   *
   * @param {RequestUser} user - The authenticated user
   * @param {string} id - Space UUID
   * @param {string} invitationId - Invitation UUID
   * @returns {Promise<{ success: boolean; member: SpaceMember }>}
   * @author Prince Jadiya
   */
  @Post(':id/invitations/:invitationId/accept')
  // Only creates the caller's own membership, like tenants/switch.
  @AllowWithoutSso()
  @ApiOperation({
    summary: 'Accept space invitation',
    description:
      "Accepts a pending space invitation. Verifies the user's email matches the invitation email and adds the user as a space member.",
  })
  @ApiParam({ name: 'id', description: 'Space UUID' })
  @ApiParam({ name: 'invitationId', description: 'Invitation UUID' })
  @ApiResponse({ status: 201, description: 'Invitation accepted' })
  @ApiResponse({ status: 400, description: 'Invalid or expired invitation' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Email mismatch' })
  @ApiResponse({ status: 404, description: 'Invitation not found' })
  async acceptSpaceInvitation(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('invitationId') invitationId: string,
  ): Promise<{ success: true; message: string }> {
    return this.spacesService.acceptSpaceInvitation(
      id,
      invitationId,
      user.userId,
      user.email,
    );
  }

  // ── Categories ────────────────────────────────────────────────────────────

  @Get(':id/categories')
  @ApiOperation({ summary: 'List categories for a space' })
  @ApiParam({ name: 'id', description: 'Space UUID' })
  async listCategories(@Param('id') id: string) {
    return this.categoriesService.getCategories(id);
  }

  @Post(':id/categories')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('edit_space_settings')
  @ApiOperation({ summary: 'Create a category in a space' })
  @ApiParam({ name: 'id', description: 'Space UUID' })
  async createCategory(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: CreateSpaceCategoryDto,
  ) {
    return this.categoriesService.createCategory(
      id,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Get(':id/categories/:categoryId')
  @ApiOperation({ summary: 'Get a space category by ID' })
  @ApiParam({ name: 'id', description: 'Space UUID' })
  @ApiParam({ name: 'categoryId', description: 'Category UUID' })
  async getCategoryById(
    @Param('id') id: string,
    @Param('categoryId') categoryId: string,
  ) {
    return this.categoriesService.getCategoryById(categoryId, id);
  }

  @Put(':id/categories/:categoryId')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('edit_space_settings')
  @ApiOperation({ summary: 'Update a space category' })
  @ApiParam({ name: 'id', description: 'Space UUID' })
  @ApiParam({ name: 'categoryId', description: 'Category UUID' })
  async updateCategory(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('categoryId') categoryId: string,
    @Body() dto: UpdateSpaceCategoryDto,
  ) {
    return this.categoriesService.updateCategory(
      categoryId,
      id,
      user.userId,
      dto,
    );
  }

  @Delete(':id/categories/:categoryId')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('edit_space_settings')
  @ApiOperation({ summary: 'Delete a space category' })
  @ApiParam({ name: 'id', description: 'Space UUID' })
  @ApiParam({ name: 'categoryId', description: 'Category UUID' })
  async deleteCategory(
    @Param('id') id: string,
    @Param('categoryId') categoryId: string,
  ) {
    return this.categoriesService.deleteCategory(categoryId, id);
  }

  // ── Task Reorder ─────────────────────────────────────────────────────────

  @Post(':id/tasks/reorder')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_edit_tasks')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Batch update sort_order (and optionally parent_task_id) for tasks',
  })
  @ApiParam({ name: 'id', description: 'Space UUID' })
  async reorderTasks(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() body: ReorderTasksDto,
  ) {
    const result = await this.tasksService.reorderTasks(
      id,
      user.organizationId,
      user.userId,
      body.updates,
    );
    return { success: true, updated: result.updated };
  }
}
