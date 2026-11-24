/**
 * @fileoverview Service for querying user profiles from the `public.users` table.
 * Provides lookup methods by auth user ID, email, and application-level user ID.
 * Used by the auth guard and other services that need to resolve user identities.
 * @module src/users/users.service
 * @author Prince Jadiya
 */

import { storageSafeFileName } from '../common/upload-filename';
import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  InternalServerErrorException,
  BadRequestException,
  ConflictException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { PermissionsService } from '../permissions/permissions.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { spacesOnlyOwnedBy } from '../spaces/space-member-rules.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { UpdateProfileDto } from './dto/update-profile.dto';
import type { OrganizationMemberRole } from './dto/update-organization-member-role.dto';

/**
 * Represents a row from the `public.users` table.
 *
 * This table is populated automatically by the `handle_new_user` database trigger
 * when a new Supabase auth user is created.
 */
export interface PublicUser {
  /** Application-level unique user identifier (UUID) */
  id: string;

  /** User's email address */
  email: string;

  /** User's first name */
  first_name: string;

  /** User's last name */
  last_name: string;

  /** Foreign key to `auth.users.id` in Supabase */
  auth_user_id: string;

  /** URL of the user's avatar image, or null */
  avatar_url: string | null;

  /** Storage path for the user's avatar file, or null */
  avatar_path: string | null;

  /** User's mobile phone number, or null */
  mobile: string | null;

  /** User's role label (display purposes), or null */
  role: string | null;

  /** User's country, or null */
  country: string | null;

  /** User's preferred language, or null */
  language: string | null;

  /** User's date of birth in ISO date format, or null */
  date_of_birth: string | null;

  /** URL of the user's cover image, or null */
  cover_image_url: string | null;

  /** Storage path for the user's cover image file, or null */
  cover_image_path: string | null;

  /** Whether the user account is active, or null if not set */
  is_active: boolean | null;

  /** ISO timestamp of when the user was created */
  created_at: string;

  /** ISO timestamp of the last profile update */
  updated_at: string;

  /** Organization membership role when returned from organization member lists */
  membership_role?: string;

  /**
   * Organization member lists only: a migration placeholder (no login, still mapped as a placeholder in
   * `migration_entity_map`) that an admin can merge into a real account.
   */
  is_placeholder?: boolean;
}

/** The synthetic address the migration gives a placeholder whose real email is unknown or already taken. */
export const MIGRATION_PLACEHOLDER_EMAIL_DOMAIN = '@placeholder.invalid';

/**
 * A migration placeholder never logged in and is either still mapped as one in the crosswalk, or carries the
 * synthetic address (deleting a migration connection cascades its crosswalk rows away). Mirrors the guard in
 * `merge_placeholder_user`.
 *
 * @param {Pick<PublicUser, 'id' | 'email' | 'auth_user_id'>} user - The member
 * @param {Set<string>} placeholderIds - Users the organization's crosswalk still maps as placeholders
 * @returns {boolean} True when the member can be merged into a real account
 */
export function isMigrationPlaceholder(
  user: Pick<PublicUser, 'id' | 'email' | 'auth_user_id'>,
  placeholderIds: Set<string>,
): boolean {
  if (user.auth_user_id) return false;

  return (
    placeholderIds.has(user.id) ||
    (user.email ?? '')
      .toLowerCase()
      .endsWith(MIGRATION_PLACEHOLDER_EMAIL_DOMAIN)
  );
}

/** Rows moved and duplicate rows dropped per `table.column` by a placeholder merge. */
export interface MergePlaceholderUserResult {
  dry_run: boolean;
  counts: Record<string, { moved: number; dropped: number }>;
}

/** The removed member, their former role and the access rows removed or revoked per table. */
export interface RemoveOrganizationMemberResult {
  user_id: string;
  role: OrganizationMemberRole;
  counts: Record<string, number>;
}

/**
 * Outcome of a bulk organization role change.
 *
 * Both arrays are always present: a wholly failed request returns an empty
 * `updated` rather than throwing, so callers can render per-user feedback.
 */
export interface BulkRoleChangeResult {
  /** `public.users.id` values whose role was changed successfully */
  updated: string[];

  /** One entry per user id that could not be changed, with the reason */
  errors: Array<{ user_id: string; message: string }>;
}

/** Outcome of a bulk member removal; like {@link BulkRoleChangeResult}, failures never throw. */
export interface BulkRemoveMembersResult {
  /** `public.users.id` values removed from the organization */
  removed: string[];

  /** One entry per user id that could not be removed, with the reason */
  errors: Array<{ user_id: string; message: string }>;
}

/**
 * Service for looking up user profiles in the `public.users` table via the Supabase admin client.
 *
 * @example
 * // Inject in a service or controller:
 * constructor(private readonly usersService: UsersService) {}
 *
 * const user = await this.usersService.getUserByEmail('user@example.com');
 */
@Injectable()
export class UsersService {
  /** @private Logger instance scoped to this service */
  private readonly logger = new Logger(UsersService.name);

  /**
   * @param {SupabaseAdminService} supabaseAdmin - Admin Supabase client for database queries
   * @param {PermissionsService} permissionsService - Used to evict cached effective
   *   permissions when a member's organization role changes
   * @param {AuditLogsService} [auditLogsService] - Optional audit trail writer
   */
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    // An org role change rewrites the caller's entire effective permission set,
    // and nothing else invalidates PermissionsService's cache for it, so every
    // role mutation here must call `bustOrg`. UsersModule already imports
    // PermissionsModule and PermissionsService depends only on Supabase, so
    // there is no cycle.
    private readonly permissionsService: PermissionsService,
    @Optional() private readonly auditLogsService?: AuditLogsService,
  ) {}

  /**
   * Retrieves a user profile by their Supabase auth user ID (`auth.users.id`).
   *
   * @param {string} authUserId - The Supabase auth user ID (UUID)
   * @returns {Promise<PublicUser | null>} The user profile, or null if not found
   * @throws {ServiceUnavailableException} When the lookup itself fails — a DB
   *   outage must not read as "no profile" (the auth guard would answer 401 and
   *   the frontend would log the user out).
   */
  async getUserByAuthUserId(authUserId: string): Promise<PublicUser | null> {
    const result = await this.supabaseAdmin
      .getClient()
      .from('users')
      .select('*')
      .eq('auth_user_id', authUserId)
      .maybeSingle();

    if (result.error) {
      this.logger.error(
        `Failed to get user by auth ID: ${result.error.message}`,
      );
      throw new ServiceUnavailableException('Could not load user profile');
    }

    return result.data as PublicUser | null;
  }

  /**
   * Retrieves a user profile by their email address.
   *
   * @param {string} email - The user's email address
   * @returns {Promise<PublicUser | null>} The user profile, or null if not found
   */
  async getUserByEmail(email: string): Promise<PublicUser | null> {
    const result = await this.supabaseAdmin
      .getClient()
      .from('users')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (result.error) {
      this.logger.error(`Failed to get user by email: ${result.error.message}`);
      return null;
    }

    return result.data as PublicUser | null;
  }

  /**
   * Retrieves a user profile by their application-level user ID (`public.users.id`).
   *
   * @param {string} userId - The application-level user ID (UUID)
   * @returns {Promise<PublicUser | null>} The user profile, or null if not found
   */
  async getUserById(userId: string): Promise<PublicUser | null> {
    const result = await this.supabaseAdmin
      .getClient()
      .from('users')
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    if (result.error) {
      this.logger.error(`Failed to get user by ID: ${result.error.message}`);
      return null;
    }

    return result.data as PublicUser | null;
  }

  // ── Profile Management Methods ──────────────────────────────────────────

  /**
   * Retrieves the authenticated user's profile with a fresh signed avatar URL.
   *
   * @param {string} authUserId - The Supabase auth user ID (UUID)
   * @returns {Promise<PublicUser>} The user profile with signed avatar/cover URLs
   * @throws {NotFoundException} When the user profile is not found
   */
  async getProfile(authUserId: string): Promise<PublicUser> {
    const user = await this.getUserByAuthUserId(authUserId);

    if (!user) {
      throw new NotFoundException('User profile not found');
    }

    if (user.avatar_path) {
      const signedUrl = await this.getAvatarSignedUrl(user.avatar_path);
      if (signedUrl) {
        user.avatar_url = signedUrl;
      } else {
        await this.clearMediaFields(user.id, {
          avatar_path: null,
          avatar_url: null,
        });
        user.avatar_path = null;
        user.avatar_url = null;
      }
    }

    if (user.cover_image_path) {
      const signedUrl = await this.getCoverImageSignedUrl(
        user.cover_image_path,
      );
      if (signedUrl) {
        user.cover_image_url = signedUrl;
      } else {
        await this.clearMediaFields(user.id, {
          cover_image_path: null,
          cover_image_url: null,
        });
        user.cover_image_path = null;
        user.cover_image_url = null;
      }
    }

    return user;
  }

  /**
   * Updates the user's profile with the provided fields.
   *
   * @param {string} userId - The application-level user ID (UUID)
   * @param {UpdateProfileDto} data - Partial profile fields to update
   * @returns {Promise<PublicUser>} The updated user profile
   * @throws {NotFoundException} When the user is not found
   * @throws {InternalServerErrorException} When the database update fails
   */
  async updateProfile(
    userId: string,
    data: UpdateProfileDto,
  ): Promise<PublicUser> {
    const client = this.supabaseAdmin.getClient();

    // SECURITY (H6): `public.users.role` is an AUTHORIZATION field — the
    // SUPER_ADMIN mirror read by SuperAdminGuard / FeatureGuard / SupabaseAuthGuard.
    // It must never be mass-assignable through self-service profile update (a
    // privilege-escalation vector), even though the DTO/legacy "job title" UI
    // still send it. Strip it here; role is assigned only via invitation/admin
    // flows. Kept in the DTO so existing clients get a normal 200, not a
    // forbidNonWhitelisted 400.
    const updatePayload: Record<string, unknown> = {
      ...data,
      updated_at: new Date().toISOString(),
    };

    delete updatePayload.role;

    const result = await client
      .from('users')
      .update(updatePayload)
      .eq('id', userId)
      .select('*')
      .single();

    if (result.error) {
      this.logger.error(`Failed to update profile: ${result.error.message}`);
      throw new InternalServerErrorException('Failed to update profile');
    }

    if (!result.data) {
      throw new NotFoundException('User not found');
    }

    return result.data as PublicUser;
  }

  /**
   * Uploads a new avatar image for the user to Supabase Storage and updates
   * the user record with the new avatar path and signed URL.
   *
   * @param {string} userId - The application-level user ID (UUID)
   * @param {Buffer} fileBuffer - The image file buffer
   * @param {string} fileName - Original file name
   * @param {string} mimeType - MIME type of the file (e.g., 'image/png')
   * @returns {Promise<PublicUser>} The updated user profile with new avatar URL
   * @throws {NotFoundException} When the user is not found
   * @throws {InternalServerErrorException} When upload or database update fails
   */
  async uploadAvatar(
    userId: string,
    fileBuffer: Buffer,
    fileName: string,
    mimeType: string,
  ): Promise<PublicUser> {
    const client = this.supabaseAdmin.getClient();

    // Get current user to check for existing avatar
    const currentUser = await this.getUserById(userId);
    if (!currentUser) {
      throw new NotFoundException('User not found');
    }

    const storagePath = `avatars/${userId}/${Date.now()}-${this.sanitizeFileName(fileName)}`;

    const { error: uploadError } = await client.storage
      .from('user-avatars')
      .upload(storagePath, fileBuffer, {
        contentType: mimeType,
        upsert: true,
      });

    if (uploadError) {
      this.logger.error(`Failed to upload avatar: ${uploadError.message}`);
      throw new InternalServerErrorException('Failed to upload avatar');
    }

    // Get signed URL (1 year)
    const { data: signedUrlData } = await client.storage
      .from('user-avatars')
      .createSignedUrl(storagePath, 365 * 24 * 60 * 60);

    // Delete old file if exists
    if (currentUser.avatar_path) {
      await client.storage
        .from('user-avatars')
        .remove([currentUser.avatar_path]);
    }

    // Update user record
    const updateResult = await client
      .from('users')
      .update({
        avatar_path: storagePath,
        avatar_url: signedUrlData?.signedUrl ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId)
      .select('*')
      .single();

    if (updateResult.error) {
      this.logger.error(
        `Failed to update avatar record: ${updateResult.error.message}`,
      );
      throw new InternalServerErrorException('Failed to update avatar record');
    }

    return updateResult.data as PublicUser;
  }

  /**
   * Deletes the user's avatar from Supabase Storage and clears the avatar fields.
   *
   * @param {string} userId - The application-level user ID (UUID)
   * @returns {Promise<PublicUser>} The updated user profile without avatar
   * @throws {NotFoundException} When the user is not found
   * @throws {InternalServerErrorException} When deletion or database update fails
   */
  async deleteAvatar(userId: string): Promise<PublicUser> {
    const client = this.supabaseAdmin.getClient();

    const currentUser = await this.getUserById(userId);
    if (!currentUser) {
      throw new NotFoundException('User not found');
    }

    if (!currentUser.avatar_path) {
      throw new BadRequestException('No avatar to delete');
    }

    if (currentUser.avatar_path) {
      await client.storage
        .from('user-avatars')
        .remove([currentUser.avatar_path]);
    }

    const result = await client
      .from('users')
      .update({
        avatar_path: null,
        avatar_url: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId)
      .select('*')
      .single();

    if (result.error) {
      this.logger.error(
        `Failed to delete avatar record: ${result.error.message}`,
      );
      throw new InternalServerErrorException('Failed to delete avatar');
    }

    return result.data as PublicUser;
  }

  /**
   * Uploads a new cover image for the user to Supabase Storage and updates
   * the user record with the new cover image path and signed URL.
   *
   * @param {string} userId - The application-level user ID (UUID)
   * @param {Buffer} fileBuffer - The image file buffer
   * @param {string} fileName - Original file name
   * @param {string} mimeType - MIME type of the file (e.g., 'image/png')
   * @returns {Promise<PublicUser>} The updated user profile with new cover image URL
   * @throws {NotFoundException} When the user is not found
   * @throws {InternalServerErrorException} When upload or database update fails
   */
  async uploadCoverImage(
    userId: string,
    fileBuffer: Buffer,
    fileName: string,
    mimeType: string,
  ): Promise<PublicUser> {
    const client = this.supabaseAdmin.getClient();

    const currentUser = await this.getUserById(userId);
    if (!currentUser) {
      throw new NotFoundException('User not found');
    }

    const storagePath = `covers/${userId}/${Date.now()}-${this.sanitizeFileName(fileName)}`;

    const { error: uploadError } = await client.storage
      .from('user-cover-images')
      .upload(storagePath, fileBuffer, {
        contentType: mimeType,
        upsert: true,
      });

    if (uploadError) {
      this.logger.error(`Failed to upload cover image: ${uploadError.message}`);
      throw new InternalServerErrorException('Failed to upload cover image');
    }

    // Get signed URL (1 year)
    const { data: signedUrlData } = await client.storage
      .from('user-cover-images')
      .createSignedUrl(storagePath, 365 * 24 * 60 * 60);

    // Delete old file if exists
    if (currentUser.cover_image_path) {
      await client.storage
        .from('user-cover-images')
        .remove([currentUser.cover_image_path]);
    }

    // Update user record
    const updateResult = await client
      .from('users')
      .update({
        cover_image_path: storagePath,
        cover_image_url: signedUrlData?.signedUrl ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId)
      .select('*')
      .single();

    if (updateResult.error) {
      this.logger.error(
        `Failed to update cover image record: ${updateResult.error.message}`,
      );
      throw new InternalServerErrorException(
        'Failed to update cover image record',
      );
    }

    return updateResult.data as PublicUser;
  }

  /**
   * Deletes the user's cover image from Supabase Storage and clears the cover image fields.
   *
   * @param {string} userId - The application-level user ID (UUID)
   * @returns {Promise<PublicUser>} The updated user profile without cover image
   * @throws {NotFoundException} When the user is not found
   * @throws {InternalServerErrorException} When deletion or database update fails
   */
  async deleteCoverImage(userId: string): Promise<PublicUser> {
    const client = this.supabaseAdmin.getClient();

    const currentUser = await this.getUserById(userId);
    if (!currentUser) {
      throw new NotFoundException('User not found');
    }

    if (!currentUser.cover_image_path) {
      throw new BadRequestException('No cover image to delete');
    }

    if (currentUser.cover_image_path) {
      await client.storage
        .from('user-cover-images')
        .remove([currentUser.cover_image_path]);
    }

    const result = await client
      .from('users')
      .update({
        cover_image_path: null,
        cover_image_url: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId)
      .select('*')
      .single();

    if (result.error) {
      this.logger.error(
        `Failed to delete cover image record: ${result.error.message}`,
      );
      throw new InternalServerErrorException('Failed to delete cover image');
    }

    return result.data as PublicUser;
  }

  /**
   * Lightweight org-scoped user search for picker UIs (e.g. rule SendNotification
   * recipient selector). Returns a flat, minimal projection — `id`, `name`,
   * `email`, `avatar_url`. Name falls back to the email when both first and
   * last name are empty so the picker never shows a blank label.
   *
   * Match is case-insensitive substring on either `first_name`, `last_name`,
   * or `email` via Supabase `or(...)` with `ilike`. Special characters that
   * would break PostgREST's `or` parser are stripped from the query string,
   * mirroring the sanitizer used in {@link saved-filters} search.
   *
   * @param {string} organizationId - Org to scope the search to (no cross-tenant leakage)
   * @param {string} q - Free-text query; empty/whitespace returns the first `limit` members
   * @param {number} limit - Maximum number of rows to return (caller should cap upstream)
   * @returns {Promise<Array<{id: string; name: string; email: string; avatar_url: string | null}>>}
   *   Mapped rows; empty array when the org has no members
   * @throws {BadRequestException} When the underlying Supabase query errors
   */
  async searchUsers(
    organizationId: string,
    q: string,
    limit: number,
  ): Promise<
    Array<{
      id: string;
      name: string;
      email: string;
      avatar_url: string | null;
    }>
  > {
    const client = this.supabaseAdmin.getClient();

    // Resolve the user_ids in this org first; users table has no org_id column
    const membersR = await client
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', organizationId);

    if (membersR.error) {
      this.logger.error(
        `Failed to load org members for user search: ${membersR.error.message}`,
      );
      throw new BadRequestException(membersR.error.message);
    }

    const userIds = (membersR.data ?? []).map(
      (m: { user_id: string }) => m.user_id,
    );

    if (userIds.length === 0) return [];

    let query = client
      .from('users')
      .select('id, first_name, last_name, email, avatar_url')
      .in('id', userIds)
      .limit(limit);

    // Strip PostgREST `or` separators / quote chars from the query before
    // interpolating — same sanitizer pattern used by saved-filters search.
    const safe = q.trim().replace(/[,.()"'\\]/g, '');

    if (safe) {
      query = query.or(
        `first_name.ilike.%${safe}%,last_name.ilike.%${safe}%,email.ilike.%${safe}%`,
      );
    }

    const r = await query;

    if (r.error) {
      this.logger.error(`Failed to search users: ${r.error.message}`);
      throw new BadRequestException(r.error.message);
    }

    type Row = {
      id: string;
      first_name: string | null;
      last_name: string | null;
      email: string;
      avatar_url: string | null;
    };

    return ((r.data ?? []) as Row[]).map((u) => {
      const full = `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim();

      return {
        id: u.id,
        name: full || u.email,
        email: u.email,
        avatar_url: u.avatar_url ?? null,
      };
    });
  }

  /**
   * Retrieves all members belonging to the same organization.
   *
   * @param {string} organizationId - The organization ID (UUID)
   * @returns {Promise<PublicUser[]>} Array of user profiles in the organization
   * @throws {InternalServerErrorException} When the database query fails
   */
  async getOrganizationMembers(organizationId: string): Promise<PublicUser[]> {
    const client = this.supabaseAdmin.getClient();

    const { data, error } = await client
      .from('organization_members')
      .select('role, user:users(*)')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: true });

    if (error) {
      this.logger.error(`Failed to get organization members: ${error.message}`);
      throw new InternalServerErrorException(
        'Failed to get organization members',
      );
    }

    // Placeholders are users the migration created for people it could not match; the crosswalk still points
    // at them while they are unmerged.
    const { data: placeholderRows, error: placeholderError } = await client
      .from('migration_entity_map')
      .select('target_id')
      .eq('organization_id', organizationId)
      .eq('entity_type', 'user')
      .eq('status', 'placeholder');

    if (placeholderError) {
      this.logger.error(
        `Failed to get migration placeholders: ${placeholderError.message}`,
      );
      throw new InternalServerErrorException(
        'Failed to get organization members',
      );
    }

    const placeholderIds = new Set(
      (placeholderRows ?? []).map(
        (row: { target_id: string }) => row.target_id,
      ),
    );

    type MemberRow = {
      role: string;
      user: PublicUser | PublicUser[] | null;
    };

    return ((data ?? []) as unknown as MemberRow[]).flatMap((row) => {
      const user = Array.isArray(row.user) ? row.user[0] : row.user;

      return user
        ? [
            {
              ...user,
              membership_role: row.role,
              is_placeholder: isMigrationPlaceholder(user, placeholderIds),
            },
          ]
        : [];
    });
  }

  /**
   * Removes a member from the caller's organization.
   *
   * `remove_organization_member` deletes the membership and the access it carries in this organization (space and
   * group memberships, role assignments, grants) and revokes their API keys, MCP grants and pending invites, in one
   * transaction. The user account, other organizations and authored content are kept.
   *
   * @param {RequestUser} actor - The authenticated caller
   * @param {string} targetUserId - `public.users.id` of the member to remove
   * @returns {Promise<RemoveOrganizationMemberResult>} The former role and per-table counts
   * @throws {ForbiddenException} When the caller targets themselves, or removes an owner without being one
   * @throws {NotFoundException} When the target is not a member of the caller's organization
   * @throws {BadRequestException} When no other active owner would remain
   */
  async removeOrganizationMember(
    actor: RequestUser,
    targetUserId: string,
  ): Promise<RemoveOrganizationMemberResult> {
    if (targetUserId === actor.userId) {
      throw new ForbiddenException('You cannot remove yourself');
    }

    // Never stops the removal: org owners and admins still manage these spaces. Recorded below.
    const leftWithoutOwner = await spacesOnlyOwnedBy(
      this.supabaseAdmin.getClient(),
      actor.organizationId,
      targetUserId,
    );

    // The owner rule is checked inside the RPC, under the same lock as the delete, so a promotion that lands
    // between a read here and the delete cannot slip through.
    const { data, error } = (await this.supabaseAdmin
      .getClient()
      .rpc('remove_organization_member', {
        p_org_id: actor.organizationId,
        p_user_id: targetUserId,
        p_allow_owner: this.getActorOrganizationRole(actor) === 'owner',
      })) as {
      data: Omit<RemoveOrganizationMemberResult, 'user_id'> | null;
      error: { code?: string; message?: string } | null;
    };

    if (error) {
      const message = error.message ?? '';
      if (/NOT_MEMBER/.test(message)) {
        throw new NotFoundException('Organization member not found');
      }
      if (/OWNER_FORBIDDEN/.test(message)) {
        throw new ForbiddenException('Only an owner can remove an owner');
      }
      // LAST_ACTIVE_OWNER from the RPC; `prevent_orphan_organization` (23514) is the backstop.
      if (
        /LAST_ACTIVE_OWNER/.test(message) ||
        error.code === '23514' ||
        /sole owner/i.test(message)
      ) {
        throw new BadRequestException(
          'This organization must keep at least one active owner',
        );
      }

      this.logger.error(`Failed to remove organization member: ${message}`);
      throw new InternalServerErrorException(
        'Failed to remove organization member',
      );
    }

    const result = { user_id: targetUserId, ...data! };

    if (this.auditLogsService) {
      void this.auditLogsService.logActionForRequest(
        actor,
        'organization_member',
        targetUserId,
        'delete',
        {
          event: 'remove_member',
          before: result.role,
          counts: result.counts,
          ...(leftWithoutOwner.length && { spaces_left_without_owner: leftWithoutOwner }),
        },
      );
    }

    // Membership, group and role rows feed the cached effective permissions.
    this.permissionsService.bustOrg(actor.organizationId);

    return result;
  }

  /**
   * Removes several members of the caller's organization, one {@link removeOrganizationMember} call per
   * user, so every rule, lock and audit entry applies to each. Partial success: failures are collected.
   *
   * Sequential on purpose: each RPC locks the org's owner rows, and the last-owner check must see the
   * previous removal.
   *
   * @param {RequestUser} actor - The authenticated caller
   * @param {string[]} userIds - `public.users.id` values to remove
   * @returns {Promise<BulkRemoveMembersResult>} Ids removed plus a per-user error list
   */
  async bulkRemoveOrganizationMembers(
    actor: RequestUser,
    userIds: string[],
  ): Promise<BulkRemoveMembersResult> {
    const removed: string[] = [];
    const errors: Array<{ user_id: string; message: string }> = [];

    for (const userId of [...new Set(userIds)]) {
      try {
        await this.removeOrganizationMember(actor, userId);
        removed.push(userId);
      } catch (err) {
        errors.push({
          user_id: userId,
          message:
            err instanceof Error ? err.message : 'Failed to remove member',
        });
      }
    }

    return { removed, errors };
  }

  /**
   * Folds a migration placeholder into a real member of the caller's organization (XE-T682).
   *
   * Everything the placeholder holds moves to the real member and the placeholder is deleted, in one
   * transaction inside `merge_placeholder_user`. With `dryRun` nothing changes and the counts preview the merge.
   *
   * @param {RequestUser} actor - The authenticated caller
   * @param {string} placeholderId - `public.users.id` of the placeholder
   * @param {string} targetUserId - `public.users.id` of the real member that keeps the work
   * @param {boolean} [dryRun=false] - Only count what would move
   * @returns {Promise<MergePlaceholderUserResult>} Per `table.column` counts
   * @throws {BadRequestException} When source and target are the same, or the target is not a real member
   * @throws {NotFoundException} When the source is not a placeholder of this organization
   * @throws {ConflictException} When the placeholder also belongs to another organization, or a row involved
   *   is locked by another process
   */
  async mergePlaceholderUser(
    actor: RequestUser,
    placeholderId: string,
    targetUserId: string,
    dryRun = false,
  ): Promise<MergePlaceholderUserResult> {
    const { data, error } = (await this.supabaseAdmin
      .getClient()
      .rpc('merge_placeholder_user', {
        p_org_id: actor.organizationId,
        p_source: placeholderId,
        p_target: targetUserId,
        p_dry_run: dryRun,
      })) as {
      data: MergePlaceholderUserResult | null;
      error: { message?: string } | null;
    };

    if (error) {
      const message = error.message ?? '';
      if (/SAME_USER/.test(message)) {
        throw new BadRequestException('A user cannot be merged into itself');
      }
      if (/NOT_PLACEHOLDER/.test(message)) {
        throw new NotFoundException('Migrated placeholder user not found');
      }
      if (/TARGET_INVALID/.test(message)) {
        throw new BadRequestException(
          'The target must be a registered member of this organization',
        );
      }
      if (/PLACEHOLDER_IN_OTHER_ORG/.test(message)) {
        throw new ConflictException(
          'This placeholder also belongs to another organization',
        );
      }
      if (/fenced SLA workflow/i.test(message)) {
        throw new ConflictException(
          'A task of this user is being processed, try again shortly',
        );
      }

      this.logger.error(`Failed to merge placeholder user: ${message}`);
      throw new InternalServerErrorException(
        'Failed to merge placeholder user',
      );
    }

    const result = data as MergePlaceholderUserResult;

    if (!dryRun) {
      if (this.auditLogsService) {
        void this.auditLogsService.logActionForRequest(
          actor,
          'organization_member',
          targetUserId,
          'update',
          {
            event: 'merge_placeholder',
            placeholder_id: placeholderId,
            counts: result.counts,
          },
        );
      }

      // The merge changes memberships and permission rows of the target.
      this.permissionsService.bustOrg(actor.organizationId);
    }

    return result;
  }

  /**
   * Resolves the actor's role in the organization the current request is scoped to.
   *
   * `RequestUser.role` is deliberately NOT consulted: that field carries
   * `public.users.role`, a free-text display label (e.g. "CEO", often null),
   * whereas authorisation depends on `organization_members.role` for the active
   * tenant. Treating the display label as the org role would let any member
   * whose label happened to read "owner" grant ownership.
   *
   * @param {RequestUser} actor - The authenticated caller
   * @returns {OrganizationMemberRole | undefined} The caller's role in the active org
   */
  private getActorOrganizationRole(
    actor: RequestUser,
  ): OrganizationMemberRole | undefined {
    return actor.memberships?.find(
      (membership) => membership.organizationId === actor.organizationId,
    )?.role;
  }

  /**
   * Changes one member's organization role within the caller's own tenant.
   *
   * @param {RequestUser} actor - The authenticated caller performing the change
   * @param {string} targetUserId - `public.users.id` of the member being changed
   * @param {OrganizationMemberRole} role - The role to assign
   * @returns {Promise<{ user_id: string; role: OrganizationMemberRole }>} The applied change
   * @throws {ForbiddenException} When the caller targets themselves, or grants or
   *   revokes `owner` without being an owner
   * @throws {NotFoundException} When the target is not a member of the caller's organization
   * @throws {BadRequestException} When the change would leave the organization without an owner
   */
  async updateOrganizationMemberRole(
    actor: RequestUser,
    targetUserId: string,
    role: OrganizationMemberRole,
  ): Promise<{ user_id: string; role: OrganizationMemberRole }> {
    if (targetUserId === actor.userId) {
      throw new ForbiddenException('You cannot change your own role');
    }

    const actorRole = this.getActorOrganizationRole(actor);

    // Checked before the row is loaded so a non-owner cannot distinguish
    // "not a member" from "refused" while probing for tenant membership.
    if (role === 'owner' && actorRole !== 'owner') {
      throw new ForbiddenException('Only an owner can grant the owner role');
    }

    const client = this.supabaseAdmin.getClient();

    // The organization_id predicate is the ONLY tenant boundary on this read:
    // the admin client is service-role, so RLS is bypassed entirely. Without it
    // a caller could rewrite roles in any organization.
    const { data: membership, error: loadError } = await client
      .from('organization_members')
      .select('role')
      .eq('user_id', targetUserId)
      .eq('organization_id', actor.organizationId)
      .maybeSingle();

    if (loadError) {
      this.logger.error(
        `Failed to load organization member: ${loadError.message}`,
      );
      throw new InternalServerErrorException(
        'Failed to load organization member',
      );
    }

    if (!membership) {
      throw new NotFoundException('Organization member not found');
    }

    const currentRole = (membership as { role: OrganizationMemberRole }).role;

    // Needs the loaded row, so unlike the grant check it cannot be hoisted.
    if (currentRole === 'owner' && actorRole !== 'owner') {
      throw new ForbiddenException("Only an owner can change an owner's role");
    }

    const { error: updateError } = await client
      .from('organization_members')
      .update({ role })
      .eq('user_id', targetUserId)
      .eq('organization_id', actor.organizationId);

    if (updateError) {
      // The `prevent_demote_last_owner` trigger raises check_violation (23514)
      // when the sole owner would be demoted. That is a caller mistake, so it
      // must surface as a 400 rather than a 500.
      if (
        updateError.code === '23514' ||
        /sole owner/i.test(updateError.message)
      ) {
        throw new BadRequestException(
          'This organization must keep at least one owner',
        );
      }

      this.logger.error(
        `Failed to update organization member role: ${updateError.message}`,
      );
      throw new InternalServerErrorException(
        'Failed to update organization member role',
      );
    }

    if (this.auditLogsService) {
      void this.auditLogsService.logActionForRequest(
        actor,
        'organization_member',
        targetUserId,
        'update',
        { event: 'update_role', before: currentRole, after: role },
      );
    }

    // A role change rewrites the member's effective permissions, which are
    // cached for several seconds. Nothing else evicts that cache, so skipping
    // this leaves the change invisible until the TTL lapses.
    this.permissionsService.bustOrg(actor.organizationId);

    return { user_id: targetUserId, role };
  }

  /**
   * Applies the same organization role to several members, one at a time.
   *
   * Deliberately partial: a failure for one user id (self-target, missing
   * member, last-owner guard) is recorded and the remaining ids still proceed,
   * mirroring `SpacesService.createSpaceInvitations`.
   *
   * @param {RequestUser} actor - The authenticated caller performing the change
   * @param {string[]} userIds - `public.users.id` values to update
   * @param {OrganizationMemberRole} role - The role to assign to each member
   * @returns {Promise<BulkRoleChangeResult>} Ids updated plus a per-user error list
   */
  async bulkUpdateOrganizationMemberRole(
    actor: RequestUser,
    userIds: string[],
    role: OrganizationMemberRole,
  ): Promise<BulkRoleChangeResult> {
    const updated: string[] = [];
    const errors: Array<{ user_id: string; message: string }> = [];

    for (const userId of [...new Set(userIds)]) {
      try {
        await this.updateOrganizationMemberRole(actor, userId, role);
        updated.push(userId);
      } catch (err) {
        errors.push({
          user_id: userId,
          message: err instanceof Error ? err.message : 'Failed to update role',
        });
      }
    }

    return { updated, errors };
  }

  /**
   * Generates a signed URL for an avatar stored in Supabase Storage.
   *
   * @param {string} path - The storage path of the avatar file
   * @param {number} [expiresIn=31536000] - URL expiry time in seconds (default: 1 year)
   * @returns {Promise<string | null>} The signed URL, or null if generation fails
   */
  async getAvatarSignedUrl(
    path: string,
    expiresIn: number = 365 * 24 * 60 * 60,
  ): Promise<string | null> {
    const { data, error } = await this.supabaseAdmin
      .getClient()
      .storage.from('user-avatars')
      .createSignedUrl(path, expiresIn);

    if (error) {
      this.logger.error(`Failed to get avatar signed URL: ${error.message}`);
      return null;
    }

    return data?.signedUrl ?? null;
  }

  /**
   * Generates a signed URL for a cover image stored in Supabase Storage.
   *
   * @param {string} path - The storage path of the cover image file
   * @param {number} [expiresIn=31536000] - URL expiry time in seconds (default: 1 year)
   * @returns {Promise<string | null>} The signed URL, or null if generation fails
   */
  async getCoverImageSignedUrl(
    path: string,
    expiresIn: number = 365 * 24 * 60 * 60,
  ): Promise<string | null> {
    const { data, error } = await this.supabaseAdmin
      .getClient()
      .storage.from('user-cover-images')
      .createSignedUrl(path, expiresIn);

    if (error) {
      this.logger.error(
        `Failed to get cover image signed URL: ${error.message}`,
      );
      return null;
    }

    return data?.signedUrl ?? null;
  }

  private sanitizeFileName(fileName: string): string {
    return storageSafeFileName(fileName);
  }

  private async clearMediaFields(
    userId: string,
    fields: Partial<
      Pick<
        PublicUser,
        'avatar_path' | 'avatar_url' | 'cover_image_path' | 'cover_image_url'
      >
    >,
  ): Promise<void> {
    const { error } = await this.supabaseAdmin
      .getClient()
      .from('users')
      .update(fields)
      .eq('id', userId);

    if (error) {
      this.logger.warn(
        `Failed to clear stale user media fields: ${error.message}`,
      );
    }
  }
}
