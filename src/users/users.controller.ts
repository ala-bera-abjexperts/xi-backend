/**
 * @fileoverview Controller for user profile management endpoints. Provides routes for
 * viewing and updating profiles, uploading/deleting avatars and cover images, and
 * listing organization members.
 * @module src/users/users.controller
 * @author Prince Jadiya
 */

import {
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Delete,
  Body,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  HttpCode,
  HttpStatus,
  ParseIntPipe,
  ParseUUIDPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { ImpersonationBlocked } from '../auth/decorators/impersonation-blocked.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { formatMaxUpload, UPLOAD_LIMITS } from '../common/upload-limits';
import { assertImageMime } from '../common/upload-mime';
import { UsersService, PublicUser } from './users.service';
import type {
  BulkRemoveMembersResult,
  BulkRoleChangeResult,
  MergePlaceholderUserResult,
  RemoveOrganizationMemberResult,
} from './users.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import {
  BulkRemoveOrganizationMembersDto,
  BulkUpdateOrganizationMemberRoleDto,
  UpdateOrganizationMemberRoleDto,
} from './dto/update-organization-member-role.dto';
import type { OrganizationMemberRole } from './dto/update-organization-member-role.dto';
import { MergePlaceholderUserDto } from './dto/merge-placeholder-user.dto';

/** Maximum results the search endpoint will return regardless of caller-supplied limit. */
const SEARCH_MAX_LIMIT = 50;

/** Default page size when the caller does not pass `limit`. */
const SEARCH_DEFAULT_LIMIT = 20;

/**
 * Avatars and cover images accept any `image/*` type EXCEPT SVG.
 *
 * SVG stays out because both are rendered inline wherever a user appears, so a crafted SVG would
 * execute for every viewer of that profile. This matches the behaviour these endpoints have always
 * had — the previous allow-list named only raster formats.
 */
const PROFILE_IMAGE_MIME_OPTS = { allowSvg: false } as const;

/** Maximum avatar file size */
const AVATAR_MAX_SIZE = UPLOAD_LIMITS.SMALL_IMAGE;

/** Maximum cover image file size */
const COVER_IMAGE_MAX_SIZE = UPLOAD_LIMITS.CONTENT_IMAGE;

/**
 * Controller for user profile management under the `/users` route prefix.
 *
 * All endpoints require authentication (Bearer token) via the global auth guard.
 *
 * Endpoints:
 * - `GET /users/profile` -- Get current user profile with signed avatar URL
 * - `PATCH /users/profile` -- Update profile fields
 * - `POST /users/avatar` -- Upload avatar image
 * - `DELETE /users/avatar` -- Delete avatar image
 * - `POST /users/cover-image` -- Upload cover image
 * - `DELETE /users/cover-image` -- Delete cover image
 * - `GET /users/organization-members` -- List all members in the user's organization
 * - `PATCH /users/organization-members/role` -- Change several members' organization roles
 * - `PATCH /users/organization-members/:userId/role` -- Change one member's organization role
 * - `DELETE /users/organization-members/:userId` -- Remove a member from the organization
 * - `POST /users/organization-members/bulk-delete` -- Remove several members from the organization
 */
@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  /**
   * @param {UsersService} usersService - Service for user profile operations
   */
  constructor(private readonly usersService: UsersService) {}

  /**
   * Returns the authenticated user's profile with a fresh signed avatar URL.
   *
   * @param {RequestUser} user - The authenticated user extracted by {@link CurrentUser}
   * @returns {Promise<PublicUser>} The user's full public profile
   */
  @Get('profile')
  @ApiOperation({
    summary: 'Get current user profile',
    description:
      "Returns the authenticated user's profile with a fresh signed avatar and cover image URL.",
  })
  @ApiResponse({ status: 200, description: 'User profile returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'User profile not found' })
  async getProfile(
    @CurrentUser() user: RequestUser,
  ): Promise<{ user: PublicUser }> {
    const profile = await this.usersService.getProfile(user.authUserId);
    return { user: profile };
  }

  /**
   * Updates the authenticated user's profile with the provided fields.
   *
   * @param {RequestUser} user - The authenticated user extracted by {@link CurrentUser}
   * @param {UpdateProfileDto} body - Partial profile fields to update
   * @returns {Promise<PublicUser>} The updated user profile
   */
  @Patch('profile')
  @ApiOperation({
    summary: 'Update user profile',
    description:
      "Updates the authenticated user's profile fields. Only provided fields are changed.",
  })
  @ApiResponse({ status: 200, description: 'Profile updated successfully' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async updateProfile(
    @CurrentUser() user: RequestUser,
    @Body() body: UpdateProfileDto,
  ): Promise<{ user: PublicUser; message: string }> {
    const updated = await this.usersService.updateProfile(user.userId, body);
    return { user: updated, message: 'Profile updated successfully' };
  }

  /**
   * Uploads a new avatar image for the authenticated user.
   * Accepts multipart/form-data with a single file field named `file`.
   *
   * @param {RequestUser} user - The authenticated user extracted by {@link CurrentUser}
   * @param {Express.Multer.File} file - The uploaded file
   * @returns {Promise<PublicUser>} The updated user profile with new avatar URL
   * @throws {BadRequestException} When file is missing, too large, or has invalid MIME type
   */
  @Post('avatar')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: AVATAR_MAX_SIZE } }),
  )
  @ApiOperation({
    summary: 'Upload avatar image',
    description:
      'Uploads a new avatar image (max 5 MB). Supported formats: JPEG, PNG, GIF, WebP.',
  })
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
  @ApiResponse({ status: 201, description: 'Avatar uploaded successfully' })
  @ApiResponse({
    status: 400,
    description: 'No file provided, file too large, or invalid MIME type',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async uploadAvatar(
    @CurrentUser() user: RequestUser,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<{ user: PublicUser; message: string }> {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    if (file.size > AVATAR_MAX_SIZE) {
      throw new BadRequestException(
        `File size exceeds the ${formatMaxUpload(AVATAR_MAX_SIZE)} limit for avatars`,
      );
    }

    assertImageMime(file.mimetype, PROFILE_IMAGE_MIME_OPTS);

    const result = await this.usersService.uploadAvatar(
      user.userId,
      file.buffer,
      file.originalname,
      file.mimetype,
    );
    return { user: result, message: 'Avatar uploaded successfully' };
  }

  /**
   * Deletes the authenticated user's avatar image from storage and clears the avatar fields.
   *
   * @param {RequestUser} user - The authenticated user extracted by {@link CurrentUser}
   * @returns {Promise<PublicUser>} The updated user profile without avatar
   */
  @Delete('avatar')
  @ApiOperation({
    summary: 'Delete avatar image',
    description:
      "Removes the user's avatar from storage and clears the avatar URL and path.",
  })
  @ApiResponse({ status: 200, description: 'Avatar deleted successfully' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async deleteAvatar(
    @CurrentUser() user: RequestUser,
  ): Promise<{ user: PublicUser; message: string }> {
    const result = await this.usersService.deleteAvatar(user.userId);
    return { user: result, message: 'Avatar deleted successfully' };
  }

  /**
   * Uploads a new cover image for the authenticated user.
   * Accepts multipart/form-data with a single file field named `file`.
   *
   * @param {RequestUser} user - The authenticated user extracted by {@link CurrentUser}
   * @param {Express.Multer.File} file - The uploaded file
   * @returns {Promise<PublicUser>} The updated user profile with new cover image URL
   * @throws {BadRequestException} When file is missing, too large, or has invalid MIME type
   */
  @Post('cover-image')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: COVER_IMAGE_MAX_SIZE } }),
  )
  @ApiOperation({
    summary: 'Upload cover image',
    description:
      'Uploads a new cover image (max 10 MB). Supported formats: JPEG, PNG, GIF, WebP.',
  })
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
  @ApiResponse({
    status: 201,
    description: 'Cover image uploaded successfully',
  })
  @ApiResponse({
    status: 400,
    description: 'No file provided, file too large, or invalid MIME type',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async uploadCoverImage(
    @CurrentUser() user: RequestUser,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<{ user: PublicUser; message: string }> {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    if (file.size > COVER_IMAGE_MAX_SIZE) {
      throw new BadRequestException(
        `File size exceeds the ${formatMaxUpload(COVER_IMAGE_MAX_SIZE)} limit for cover images`,
      );
    }

    assertImageMime(file.mimetype, PROFILE_IMAGE_MIME_OPTS);

    const result = await this.usersService.uploadCoverImage(
      user.userId,
      file.buffer,
      file.originalname,
      file.mimetype,
    );
    return { user: result, message: 'Cover image uploaded successfully' };
  }

  /**
   * Deletes the authenticated user's cover image from storage and clears the cover image fields.
   *
   * @param {RequestUser} user - The authenticated user extracted by {@link CurrentUser}
   * @returns {Promise<PublicUser>} The updated user profile without cover image
   */
  @Delete('cover-image')
  @ApiOperation({
    summary: 'Delete cover image',
    description:
      "Removes the user's cover image from storage and clears the cover image URL and path.",
  })
  @ApiResponse({
    status: 200,
    description: 'Cover image deleted successfully',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async deleteCoverImage(
    @CurrentUser() user: RequestUser,
  ): Promise<{ user: PublicUser; message: string }> {
    const result = await this.usersService.deleteCoverImage(user.userId);
    return { user: result, message: 'Cover image deleted successfully' };
  }

  /**
   * Lightweight org-scoped user search for picker UIs (e.g. workflow rule
   * SendNotification recipient selector). Returns only the columns the
   * frontend picker needs — never full profile data.
   *
   * @param {RequestUser} user - Authenticated user; org id is read from the token
   * @param {string} [q] - Optional case-insensitive substring matched against
   *   first name, last name, and email
   * @param {number} [limit] - Caller-supplied page size; clamped to
   *   {@link SEARCH_MAX_LIMIT}. Defaults to {@link SEARCH_DEFAULT_LIMIT}.
   * @returns Picker rows + `success` flag.
   */
  @Get('search')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_users')
  @ApiOperation({
    summary: 'Search users in current org by name or email (ilike)',
    description:
      'Returns a lightweight list of `{ id, name, email, avatar_url }` for picker UIs. ' +
      'Scoped to the caller’s organization. Empty `q` returns the first `limit` members.',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'Search query (case-insensitive substring)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: `Max results (default ${SEARCH_DEFAULT_LIMIT}, max ${SEARCH_MAX_LIMIT})`,
  })
  @ApiResponse({ status: 200, description: 'Search results returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing can_view_users' })
  async searchUsers(
    @CurrentUser() user: RequestUser,
    @Query('q') q?: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ): Promise<
    Array<{
      id: string;
      name: string;
      email: string;
      avatar_url: string | null;
    }>
  > {
    const clamped = Math.min(limit ?? SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT);

    return this.usersService.searchUsers(user.organizationId, q ?? '', clamped);
  }

  /**
   * Returns all members belonging to the authenticated user's organization.
   *
   * @param {RequestUser} user - The authenticated user extracted by {@link CurrentUser}
   * @returns {Promise<PublicUser[]>} Array of user profiles in the organization
   */
  @Get('organization-members')
  @ApiOperation({
    summary: 'List organization members',
    description:
      "Returns all user profiles belonging to the authenticated user's organization.",
  })
  @ApiResponse({
    status: 200,
    description: 'Organization members returned',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async getOrganizationMembers(
    @CurrentUser() user: RequestUser,
  ): Promise<{ members: PublicUser[]; total: number }> {
    const members = await this.usersService.getOrganizationMembers(
      user.organizationId,
    );
    return { members, total: members.length };
  }

  /**
   * Changes the organization role of several members of the caller's organization.
   *
   * Declared before the `:userId` variant purely for readability; the two paths
   * differ in segment count so their order does not affect route matching.
   *
   * @param {RequestUser} user - The authenticated user extracted by {@link CurrentUser}
   * @param {BulkUpdateOrganizationMemberRoleDto} body - Target user ids and the new role
   * @returns {Promise<BulkRoleChangeResult>} Updated ids plus per-user errors
   */
  @Patch('organization-members/role')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_users')
  @ImpersonationBlocked()
  @ApiOperation({
    summary: 'Change several members organization roles',
    description:
      "Applies one organization role to many members of the caller's own organization. Partial success: each user id is applied independently and failures are returned in `errors` rather than aborting the request. Granting or revoking 'owner' requires the caller to be an owner, and the caller cannot change their own role.",
  })
  @ApiResponse({ status: 200, description: 'Bulk role change processed' })
  @ApiResponse({ status: 400, description: 'Invalid role or user_ids' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing can_edit_users' })
  async bulkUpdateOrganizationMemberRole(
    @CurrentUser() user: RequestUser,
    @Body() body: BulkUpdateOrganizationMemberRoleDto,
  ): Promise<BulkRoleChangeResult> {
    return this.usersService.bulkUpdateOrganizationMemberRole(
      user,
      body.user_ids,
      body.role,
    );
  }

  /**
   * Changes the organization role of one member of the caller's organization.
   *
   * @param {RequestUser} user - The authenticated user extracted by {@link CurrentUser}
   * @param {string} userId - `public.users.id` of the member to change
   * @param {UpdateOrganizationMemberRoleDto} body - The new role
   * @returns {Promise<{ user_id: string; role: OrganizationMemberRole }>} The applied change
   */
  @Patch('organization-members/:userId/role')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_users')
  @ImpersonationBlocked()
  @ApiOperation({
    summary: 'Change a member organization role',
    description:
      "Updates `organization_members.role` for one member of the caller's own organization. Granting or revoking 'owner' requires the caller to be an owner, the caller cannot change their own role, and demoting the sole owner is rejected by the `prevent_demote_last_owner` database trigger.",
  })
  @ApiParam({ name: 'userId', description: 'public.users.id of the member' })
  @ApiResponse({ status: 200, description: 'Role updated' })
  @ApiResponse({
    status: 400,
    description:
      'Invalid role, or the organization would be left without an owner',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing can_edit_users, self-target, or owner-only change',
  })
  @ApiResponse({ status: 404, description: 'Member not found in organization' })
  async updateOrganizationMemberRole(
    @CurrentUser() user: RequestUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: UpdateOrganizationMemberRoleDto,
  ): Promise<{ user_id: string; role: OrganizationMemberRole }> {
    return this.usersService.updateOrganizationMemberRole(
      user,
      userId,
      body.role,
    );
  }

  /**
   * Removes a member from the caller's organization.
   *
   * @param {RequestUser} user - The authenticated user extracted by {@link CurrentUser}
   * @param {string} userId - `public.users.id` of the member to remove
   * @returns {Promise<RemoveOrganizationMemberResult>} The former role and per-table counts
   */
  @Delete('organization-members/:userId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_users')
  @ImpersonationBlocked()
  @ApiOperation({
    summary: 'Remove a member from the organization',
    description:
      "Removes the member from the caller's own organization together with the access it carries there (space and group memberships, role assignments, grants) and revokes their API keys, MCP grants and pending invites. Atomic. The user account, other organizations and authored content are kept. Removing an owner requires the caller to be an owner, the caller cannot remove themselves, and the sole owner cannot be removed.",
  })
  @ApiParam({ name: 'userId', description: 'public.users.id of the member' })
  @ApiResponse({ status: 200, description: 'Member removed' })
  @ApiResponse({
    status: 400,
    description: 'The organization would be left without an owner',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing can_edit_users, self-target, or owner-only removal',
  })
  @ApiResponse({ status: 404, description: 'Member not found in organization' })
  async removeOrganizationMember(
    @CurrentUser() user: RequestUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<RemoveOrganizationMemberResult> {
    return this.usersService.removeOrganizationMember(user, userId);
  }

  /**
   * Removes several members of the caller's organization, applying the single-remove rules to each.
   *
   * @param {RequestUser} user - The authenticated user extracted by {@link CurrentUser}
   * @param {BulkRemoveOrganizationMembersDto} body - Target user ids
   * @returns {Promise<BulkRemoveMembersResult>} Removed ids plus per-user errors
   */
  @Post('organization-members/bulk-delete')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_users')
  @ImpersonationBlocked()
  @ApiOperation({
    summary: 'Remove several members from the organization',
    description:
      "Removes many members of the caller's own organization. Partial success: each user id is removed independently (atomic per user, same rules as the single DELETE) and failures are returned in `errors` rather than aborting the request.",
  })
  @ApiResponse({ status: 200, description: 'Bulk removal processed' })
  @ApiResponse({ status: 400, description: 'Invalid user_ids' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing can_edit_users' })
  async bulkRemoveOrganizationMembers(
    @CurrentUser() user: RequestUser,
    @Body() body: BulkRemoveOrganizationMembersDto,
  ): Promise<BulkRemoveMembersResult> {
    return this.usersService.bulkRemoveOrganizationMembers(user, body.user_ids);
  }

  /**
   * Merges a migration placeholder into a real member of the caller's organization (XE-T682).
   *
   * @param {RequestUser} user - The authenticated user extracted by {@link CurrentUser}
   * @param {string} userId - `public.users.id` of the placeholder
   * @param {MergePlaceholderUserDto} body - The real member, and whether to only preview
   * @returns {Promise<MergePlaceholderUserResult>} Per `table.column` counts
   */
  @Post('organization-members/:userId/merge')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_users')
  @ImpersonationBlocked()
  @ApiOperation({
    summary: 'Merge a migrated placeholder into a real member',
    description:
      "Moves everything a migration placeholder user holds (tasks, comments, history, attachments, mentions, watchers, memberships, permissions) to a registered member of the caller's organization, then deletes the placeholder. Atomic. With `dry_run` nothing changes and the counts preview the merge.",
  })
  @ApiParam({
    name: 'userId',
    description: 'public.users.id of the placeholder',
  })
  @ApiResponse({
    status: 200,
    description: 'Merged, or previewed with dry_run',
  })
  @ApiResponse({
    status: 400,
    description: 'Same user, or the target is not a registered member',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing can_edit_users' })
  @ApiResponse({
    status: 404,
    description: 'Not a placeholder of this organization',
  })
  @ApiResponse({
    status: 409,
    description:
      'Placeholder belongs to another organization too, or a row is locked',
  })
  async mergePlaceholderUser(
    @CurrentUser() user: RequestUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: MergePlaceholderUserDto,
  ): Promise<MergePlaceholderUserResult> {
    return this.usersService.mergePlaceholderUser(
      user,
      userId,
      body.target_user_id,
      body.dry_run ?? false,
    );
  }
}
