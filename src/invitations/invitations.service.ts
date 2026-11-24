/**
 * @fileoverview Service for managing organization and space invitations.
 * Handles creation, listing, token-based lookup, acceptance (including space membership),
 * resending, and deletion of invitations. Integrates with Supabase Auth for generating
 * secure invitation links and with the space permissions model for applying custom permissions.
 * @module src/invitations/invitations.service
 * @author Prince Jadiya
 */

import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
  InternalServerErrorException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { MIGRATION_PLACEHOLDER_EMAIL_DOMAIN } from '../users/users.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { AutomationEventOutboxService } from '../automations/automation-event-outbox.service';
import { EntitlementsService } from '../licensing/entitlements.service';
import { PermissionsService } from '../permissions/permissions.service';
import { SpacesService } from '../spaces/spaces.service';
import { UserGroupsService } from '../user-groups/user-groups.service';
import {
  SPACE_PERMISSION_COLUMN_KEYS,
  normalizeSpacePermissions,
} from '../permissions/models/space-permissions.model';
import type { AuthTokenBundle } from '../auth/cookies.util';

/**
 * Shape of a row from the `invitations` table.
 * @private
 */
interface InvitationRow {
  /** Invitation UUID */
  id: string;
  /** Organization the invitation belongs to */
  organization_id: string;
  /** User ID of the person who created the invitation */
  invited_by: string;
  /** Email address of the invitee */
  email: string;
  /** Organization role offered to the invitee */
  role: string;
  /** Invitee's first name */
  first_name: string;
  /** Invitee's last name */
  last_name: string;
  /** Secure random token for invitation verification */
  token: string;
  /** Current status: `'pending'`, `'accepted'`, `'expired'` */
  status: string;
  /** ISO timestamp of when the invitation was created */
  created_at: string;
  /** ISO timestamp of when the invitation was accepted, or null */
  accepted_at: string | null;
  /** ISO timestamp of when the invitation expires */
  expires_at: string;
  /** Optional space ID for space-level invitations */
  space_id: string | null;
  /** Space role for space-level invitations */
  space_role: string;
  /** Custom space permissions attached to the invitation */
  space_permissions: Record<string, boolean> | null;
  /** ISO timestamp of when the invitation was declined, or null */
  declined_at: string | null;
  /** Optional custom role ID to assign on acceptance */
  custom_role_id: string | null;
}

/**
 * Shape of an organization row (partial select).
 * @private
 */
interface OrgRow {
  /** Organization display name */
  name: string;
  /** Organization URL slug */
  slug?: string;
  /** Optional default space where new members are auto-added */
  default_space_id?: string | null;
}

/**
 * Shape of a user row (partial select).
 *
 * Multi-tenant note: `organization_id` was dropped from `public.users`.
 * The legacy field is gone from this interface too. Membership is now
 * determined exclusively via `organization_members`.
 *
 * @private
 */
interface UserRow {
  /** Application-level user ID */
  id: string;
  /** User's email address */
  email: string;
  /** Linked Supabase auth user ID */
  auth_user_id?: string | null;
}

/**
 * Service responsible for all invitation CRUD operations and the invitation acceptance flow.
 *
 * @example
 * // Inject in a controller:
 * constructor(private readonly invitationsService: InvitationsService) {}
 *
 * const result = await this.invitationsService.createOrgInvitation({ ... });
 */
@Injectable()
export class InvitationsService {
  /** @private Logger instance scoped to this service */
  private readonly logger = new Logger(InvitationsService.name);

  /**
   * @param {SupabaseAdminService} supabaseAdmin - Admin Supabase client for database and auth operations
   * @param {ConfigService} configService - Config service for reading application URLs
   */
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly configService: ConfigService,
    private readonly auditLogsService: AuditLogsService,
    @Optional() private readonly outboxService?: AutomationEventOutboxService,
    // Optional so existing unit-test constructions keep compiling; DI always
    // supplies it (InvitationsModule imports LicensingModule).
    @Optional() private readonly entitlementsService?: EntitlementsService,
    // Optional for the same reason; they grant a claimed placeholder its migrated project roles and groups.
    @Optional() private readonly spacesService?: SpacesService,
    @Optional() private readonly userGroupsService?: UserGroupsService,
    @Optional() private readonly permissionsService?: PermissionsService,
  ) {}

  /**
   * Returns the Supabase admin client for convenience.
   *
   * @private
   * @returns {SupabaseClient} The admin Supabase client
   */
  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Generates a cryptographically secure random token for invitation verification.
   *
   * @private
   * @returns {string} A 64-character hex token
   */
  private generateToken(): string {
    return randomBytes(32).toString('hex');
  }

  /**
   * Frontend URL used in transactional emails. Invitation emails should always
   * point at the app page with our invitation token, never Supabase Auth verify.
   */
  private getFrontendUrl(): string {
    const url =
      this.configService.get<string>('frontendUrl') ||
      this.configService.get<string>('appUrl') ||
      'http://localhost:3000';

    return url.replace(/\/$/, '');
  }

  /**
   * Auth-subdomain URL for deep-links in invitation emails.
   * Reads AUTH_URL (e.g. https://auth.xisuite.cloud) so the link lands on the
   * correct subdomain. Falls back to FRONTEND_URL for single-domain deployments.
   */
  private getAuthUrl(): string {
    const url =
      this.configService.get<string>('authUrl') || this.getFrontendUrl();

    return url.replace(/\/$/, '');
  }

  private buildInvitationLink(token: string): string {
    return `${this.getAuthUrl()}/auth/accept-invitation?token=${encodeURIComponent(token)}`;
  }

  private buildAuthMetadata(invitation: InvitationRow) {
    // Multi-tenant: we do NOT embed organization_id or role into auth user
    // metadata. The invitee may join other tenants later and the metadata
    // would go stale. Active tenant is resolved per-request from the signed
    // active_org_id cookie + organization_members — see SupabaseAuthGuard.
    return {
      first_name: invitation.first_name,
      last_name: invitation.last_name,
      full_name:
        `${invitation.first_name ?? ''} ${invitation.last_name ?? ''}`.trim(),
      invitation_token: invitation.token,
    };
  }

  private async findAuthUserIdByEmail(email: string): Promise<string | null> {
    try {
      const pageSize = 1000;

      for (let page = 1; page <= 10; page += 1) {
        const { data, error } = await this.client.auth.admin.listUsers({
          page,
          perPage: pageSize,
        });

        if (error) {
          this.logger.warn(
            `Failed to list auth users while accepting invite: ${error.message}`,
          );
          return null;
        }

        const found = data.users.find(
          (user) => user.email?.toLowerCase() === email.toLowerCase(),
        );

        if (found) return found.id;
        if (data.users.length < pageSize) return null;
      }
    } catch (err) {
      this.logger.warn(
        `Failed to find auth user by email: ${(err as Error).message}`,
      );
    }

    return null;
  }

  private async ensureInviteeAccount(
    invitation: InvitationRow,
    password?: string,
  ): Promise<{ user: UserRow; tokens?: AuthTokenBundle }> {
    const userResult = await this.client
      .from('users')
      .select('id, email, auth_user_id')
      .eq('email', invitation.email)
      .maybeSingle();
    let userData = userResult.data as UserRow | null;

    if (!password) {
      if (!userData) {
        throw new NotFoundException(
          'User account not found for this invitation email',
        );
      }

      return { user: userData };
    }

    const metadata = this.buildAuthMetadata(invitation);
    let authUserId = userData?.auth_user_id ?? null;

    if (!authUserId) {
      authUserId = await this.findAuthUserIdByEmail(invitation.email);
    }

    if (authUserId) {
      // SECURITY (C4): an account already exists for this email. This is a
      // PUBLIC, token-only endpoint, so it must NEVER set/reset a pre-existing
      // account's password — otherwise anyone holding the invite token could
      // take the account over. The rightful owner accepts by signing in first
      // (the no-password "existing user" flow); the frontend maps this 409 to
      // the login-required screen so acceptance still completes after sign-in.
      throw new ConflictException({
        message:
          'An account already exists for this email. Please sign in to accept the invitation.',
        code: 'ACCOUNT_ALREADY_EXISTS',
      });
    } else {
      // New auth user — start with an empty app_metadata block. Role and
      // tenant context are derived per-request from organization_members.
      const { data, error } = await this.client.auth.admin.createUser({
        email: invitation.email,
        password,
        email_confirm: true,
        user_metadata: metadata,
      });

      if (error || !data.user) {
        this.logger.error(
          `Failed to create invited auth user: ${error?.message ?? 'No user returned'}`,
        );
        throw new BadRequestException('Failed to create invited user account');
      }

      authUserId = data.user.id;
    }

    // Multi-tenant: organization_id is dropped from public.users. Membership
    // is written to organization_members in acceptInvitation below.
    const upsertResult = await this.client
      .from('users')
      .upsert(
        {
          email: invitation.email,
          first_name: invitation.first_name,
          last_name: invitation.last_name,
          auth_user_id: authUserId,
          role: invitation.role || 'member',
          is_active: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'email' },
      )
      .select('id, email, auth_user_id')
      .single();

    if (upsertResult.error || !upsertResult.data) {
      this.logger.error(
        `Failed to upsert invited public user: ${upsertResult.error?.message ?? 'No user returned'}`,
      );
      throw new BadRequestException('Failed to create invited user profile');
    }

    userData = upsertResult.data as UserRow;

    const authClient = this.supabaseAdmin.createAuthClient();
    const { data: sessionData, error: signinError } =
      await authClient.auth.signInWithPassword({
        email: invitation.email,
        password,
      });

    if (signinError || !sessionData.session) {
      this.logger.error(
        `Failed to sign in invited user after accept: ${signinError?.message ?? 'No session returned'}`,
      );
      throw new BadRequestException('Invitation accepted but sign-in failed');
    }

    return {
      user: userData,
      tokens: {
        access_token: sessionData.session.access_token,
        refresh_token: sessionData.session.refresh_token,
        expires_in: sessionData.session.expires_in,
      },
    };
  }

  /**
   * Whether a member is a migration placeholder: no login, and the migration's synthetic address or still
   * mapped as a placeholder in this organization's crosswalk.
   *
   * @param {string} organizationId - Organization to check
   * @param {UserRow} user - The member
   * @returns {Promise<boolean>} True for an unclaimed placeholder
   */
  private async isPlaceholderMember(
    organizationId: string,
    user: UserRow,
  ): Promise<boolean> {
    if (user.auth_user_id) return false;
    if (user.email.toLowerCase().endsWith(MIGRATION_PLACEHOLDER_EMAIL_DOMAIN)) {
      return true;
    }

    const { data } = await this.client
      .from('migration_entity_map')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('entity_type', 'user')
      .eq('target_id', user.id)
      .eq('status', 'placeholder')
      .limit(1);

    return (data ?? []).length > 0;
  }

  /**
   * Hands an accepted invitee the migrated work that belongs to their email (XE-T682).
   *
   * Accepting proves the invitee owns the email, so no admin step is needed:
   * - the invitee's own row may BE the placeholder (the migration kept the real email and sign-up adopted the
   *   row); accept_invitation_atomic leaves its old `viewer` membership as is, so the invited role is applied here;
   * - a placeholder with a synthetic email whose source email is the invitee's is merged into the invitee;
   * - then the Jira project roles and groups the migration held back for those placeholders are granted.
   *
   * Runs after the acceptance committed, so a failure is logged and never fails the acceptance: an admin can
   * still merge from the Teams page.
   *
   * @param {InvitationRow} invitation - The accepted invitation
   * @param {string} userId - `public.users.id` of the invitee
   * @returns {Promise<void>}
   */
  private async claimPlaceholders(
    invitation: InvitationRow,
    userId: string,
  ): Promise<void> {
    try {
      const { data, error } = await this.client
        .from('migration_entity_map')
        .select('id, target_id, source_email')
        .eq('organization_id', invitation.organization_id)
        .eq('entity_type', 'user')
        .eq('status', 'placeholder');
      if (error) throw error;

      const rows = (data ?? []) as Array<{
        id: string;
        target_id: string;
        source_email: string | null;
      }>;
      const email = invitation.email.trim().toLowerCase();

      const ownRows = rows.filter((row) => row.target_id === userId);
      if (ownRows.length > 0) {
        const { error: roleError } = await this.client
          .from('organization_members')
          .update({ role: invitation.role })
          .eq('organization_id', invitation.organization_id)
          .eq('user_id', userId);
        if (roleError) throw roleError;

        const { error: mapError } = await this.client
          .from('migration_entity_map')
          .update({
            status: 'mapped',
            is_placeholder: false,
            match_method: 'invite_claim',
            updated_at: new Date().toISOString(),
          })
          .in(
            'id',
            ownRows.map((row) => row.id),
          );
        if (mapError) throw mapError;
        this.permissionsService?.bustOrg(invitation.organization_id);
      }

      const others = new Set(
        rows
          .filter(
            (row) =>
              row.target_id !== userId &&
              row.source_email?.trim().toLowerCase() === email,
          )
          .map((row) => row.target_id),
      );
      for (const placeholderId of others) {
        const { error: mergeError } = await this.client.rpc(
          'merge_placeholder_user',
          {
            p_org_id: invitation.organization_id,
            p_source: placeholderId,
            p_target: userId,
          },
        );
        if (mergeError) throw mergeError;

        void this.auditLogsService.logAction(
          invitation.organization_id,
          userId,
          'organization_member',
          userId,
          'update',
          {
            event: 'merge_placeholder',
            placeholder_id: placeholderId,
            source: 'invitation_accept',
            invitation_id: invitation.id,
          },
        );
      }

      const claimed = [...(ownRows.length > 0 ? [userId] : []), ...others];
      if (claimed.length > 0) {
        await this.grantMigratedAccess(invitation, userId, claimed);
      }
    } catch (e) {
      this.logger.warn(
        `Could not claim migrated placeholders for invitation ${invitation.id}:`,
        e,
      );
    }
  }

  /**
   * Grants the space roles and group memberships the migration recorded for placeholders instead of
   * granting them to a login nobody owned yet (`placeholder_user_ids` on the `role` / `user_group`
   * crosswalk rows). Existing memberships are kept as they are.
   *
   * @param {InvitationRow} invitation - The accepted invitation
   * @param {string} userId - `public.users.id` of the invitee
   * @param {string[]} placeholderIds - The claimed placeholders (the invitee's own id when adopted)
   * @returns {Promise<void>}
   */
  private async grantMigratedAccess(
    invitation: InvitationRow,
    userId: string,
    placeholderIds: string[],
  ): Promise<void> {
    const orgId = invitation.organization_id;
    const rows = new Map<
      string,
      {
        entity_type: string;
        target_id: string;
        metadata: Record<string, unknown>;
      }
    >();

    for (const placeholderId of placeholderIds) {
      const { data, error } = await this.client
        .from('migration_entity_map')
        .select('id, entity_type, target_id, metadata')
        .eq('organization_id', orgId)
        .in('entity_type', ['role', 'user_group'])
        .eq('status', 'mapped')
        .contains('metadata', { placeholder_user_ids: [placeholderId] });
      if (error) throw error;
      for (const row of (data ?? []) as Array<{
        id: string;
        entity_type: string;
        target_id: string;
        metadata: Record<string, unknown>;
      }>) {
        rows.set(row.id, row);
      }
    }

    for (const row of rows.values()) {
      try {
        if (row.entity_type === 'role') {
          const spaceId = row.metadata.space_id;
          if (typeof spaceId !== 'string' || !this.spacesService) continue;
          await this.spacesService.addSpaceMember(
            spaceId,
            orgId,
            invitation.invited_by,
            {
              member_type: 'user',
              user_id: userId,
              space_role: row.target_id,
            },
          );
        } else if (this.userGroupsService) {
          await this.userGroupsService.addMember(
            row.target_id,
            orgId,
            userId,
            null,
            invitation.invited_by,
          );
        }
      } catch (e) {
        // Already a member keeps the role they have; anything else must not stop the other grants.
        if (!(e instanceof ConflictException)) {
          this.logger.warn(
            `Could not grant migrated ${row.entity_type} ${row.target_id} to ${userId}:`,
            e,
          );
        }
      }
    }
  }

  // Note: addDefaultSpaceMembership() was folded into the
  // accept_invitation_atomic RPC. The RPC now upserts the default-space
  // membership inside the same transaction as the org membership, and returns
  // the default_space_id so the caller can emit the secondary audit row.

  /**
   * Best-effort cleanup for Supabase Auth users created only by an invite link.
   *
   * The Next.js compatibility service did this cleanup by listing every auth
   * user. The backend keeps the behavior, but looks up the stored auth_user_id
   * first so revoke/delete does not need a broad Auth admin scan.
   *
   * @private
   * @param {string} email - Email address from the invitation row
   * @returns {Promise<void>}
   */
  private async deleteAuthUserByEmail(email: string): Promise<void> {
    try {
      const { data: appUser } = await this.client
        .from('users')
        .select('auth_user_id')
        .eq('email', email)
        .maybeSingle();

      const authUserId = (appUser as { auth_user_id?: string } | null)
        ?.auth_user_id;

      if (authUserId) {
        await this.client.auth.admin.deleteUser(authUserId);
      }
    } catch (err) {
      this.logger.warn(
        `Failed to delete orphaned auth user for ${email}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Creates a new organization invitation, generates an app-owned invite link,
   * and returns the invitation data along with the link and organization name.
   *
   * @param {object} data - Invitation creation data
   * @param {string} data.email - Email address of the person to invite
   * @param {string} data.firstName - Invitee's first name
   * @param {string} data.lastName - Invitee's last name
   * @param {string} data.organizationId - The organization to invite into
   * @param {string} data.role - The role to assign (e.g., `'member'`, `'admin'`)
   * @param {string} data.invitedByUserId - The user ID of the inviter
   * @returns {Promise<{ invitation: Record<string, unknown>; invitationLink: string; organizationName: string }>}
   * @throws {BadRequestException} When the user already exists, an invitation is already pending,
   *   or the invitation/link creation fails
   */
  async createOrgInvitation(data: {
    email: string;
    firstName: string;
    lastName: string;
    organizationId: string;
    role: string;
    invitedByUserId: string;
  }): Promise<{
    invitation: Record<string, unknown>;
    invitationLink: string;
    organizationName: string;
  }> {
    const {
      email,
      firstName,
      lastName,
      organizationId,
      role,
      invitedByUserId,
    } = data;

    // Check if a user with this email already exists and, if so, whether they
    // are already a member of the inviting org. Multi-tenant: the dropped
    // `users.organization_id` column is replaced by an organization_members
    // lookup. A user may be invited into a second org, so we only block
    // re-inviting someone who is ALREADY a member of THIS specific org.
    const existingUserResult = await this.client
      .from('users')
      .select('id, email, auth_user_id')
      .eq('email', email)
      .maybeSingle();
    const existingUser = existingUserResult.data as UserRow | null;

    if (existingUser) {
      const existingMembership = await this.client
        .from('organization_members')
        .select('id')
        .eq('user_id', existingUser.id)
        .eq('organization_id', organizationId)
        .maybeSingle();

      // A migration placeholder holding this email is the invitee's own unclaimed work (XE-T682): inviting
      // them is how they claim it, so it must not count as "already a member".
      if (
        existingMembership.data &&
        !(await this.isPlaceholderMember(organizationId, existingUser))
      ) {
        throw new BadRequestException(
          'User already exists in this organization',
        );
      }
    }

    // Check for pending invitation
    const existingInvResult = await this.client
      .from('invitations')
      .select('id, status')
      .eq('email', email)
      .eq('organization_id', organizationId)
      .eq('status', 'pending')
      .maybeSingle();

    if (existingInvResult.data) {
      throw new BadRequestException('Invitation already sent to this email');
    }

    // Seat limit (licensing audit D1): refuse a NEW invitation that would take
    // the tenant past limit_users. Seats = active members + pending invites,
    // because every pending invite becomes a seat on acceptance.
    await this.entitlementsService?.assertSeatAvailable(organizationId);

    // Generate secure token
    const token = this.generateToken();

    // Create invitation record
    const createResult = await this.client
      .from('invitations')
      .insert({
        organization_id: organizationId,
        invited_by: invitedByUserId,
        email,
        role,
        first_name: firstName,
        last_name: lastName,
        token,
        status: 'pending',
        expires_at: new Date(
          Date.now() + 7 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      })
      .select()
      .single();
    const invitation = createResult.data as InvitationRow | null;

    if (createResult.error || !invitation) {
      this.logger.error('Error creating invitation:', createResult.error);
      throw new BadRequestException('Failed to create invitation');
    }

    // Get org name
    const orgResult = await this.client
      .from('organizations')
      .select('name, slug')
      .eq('id', organizationId)
      .single();
    const organization = orgResult.data as OrgRow | null;

    if (orgResult.error || !organization) {
      await this.client.from('invitations').delete().eq('id', invitation.id);
      throw new BadRequestException('Failed to fetch organization information');
    }

    const invitationLink = this.buildInvitationLink(token);

    void this.auditLogsService.logAction(
      organizationId,
      invitedByUserId,
      'invitation',
      invitation.id,
      'create',
      { email, role, invitation_type: 'organization' },
    );

    void this.outboxService?.write(organizationId, null, 'app.user.invited', {
      user: {
        id: invitation.id,
        email,
        name: email,
      },
      email,
      emailDomain: email.split('@')[1] ?? '',
      role,
      organization_id: organizationId,
      invitation_id: invitation.id,
    });

    return {
      invitation: invitation as unknown as Record<string, unknown>,
      invitationLink,
      organizationName: organization.name,
    };
  }

  /**
   * Returns a paginated list of invitations for the given organization.
   *
   * @param {string} organizationId - The organization to list invitations for
   * @param {number} [page=1] - Page number (1-based)
   * @param {number} [limit=50] - Number of items per page (max 100)
   * @returns {Promise<{ data: any[]; total: number; page: number; limit: number }>}
   * @throws {BadRequestException} When the query fails
   */
  async listInvitations(
    organizationId: string,
    page: number = 1,
    limit: number = 50,
  ) {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(Math.max(1, limit), 100);
    const offset = (safePage - 1) * safeLimit;

    const {
      data: rows,
      error,
      count,
    } = await this.client
      .from('invitations')
      .select(
        '*, inviter:users!invitations_invited_by_fkey(id, first_name, last_name, email)',
        { count: 'exact' },
      )
      .eq('organization_id', organizationId)
      .is('space_id', null)
      .order('created_at', { ascending: false })
      .range(offset, offset + safeLimit - 1);

    if (error) {
      this.logger.error('Error listing invitations:', error);
      throw new BadRequestException('Failed to list invitations');
    }

    return {
      data: rows || [],
      total: count || 0,
      page: safePage,
      limit: safeLimit,
    };
  }

  /**
   * Retrieves invitation details by the secure token, including organization and space names.
   *
   * @param {string} token - The secure invitation token from the email link
   * @returns {Promise<object>} Invitation details enriched with space and organization names
   * @throws {NotFoundException} When no invitation matches the given token
   */
  async getByToken(token: string) {
    const invResult = await this.client
      .from('invitations')
      .select(
        'id, email, status, expires_at, space_id, space_role, organization_id, first_name, last_name, role',
      )
      .eq('token', token)
      .single();
    const invitation = invResult.data as InvitationRow | null;

    if (invResult.error || !invitation) {
      throw new NotFoundException('Invitation not found');
    }

    let spaceName: string | null = null;
    if (invitation.space_id) {
      const spaceResult = await this.client
        .from('spaces')
        .select('name')
        .eq('id', invitation.space_id)
        .single();
      const space = spaceResult.data as { name: string } | null;
      spaceName = space?.name || null;
    }

    const orgResult = await this.client
      .from('organizations')
      .select('name')
      .eq('id', invitation.organization_id)
      .single();
    const org = orgResult.data as OrgRow | null;

    return {
      ...invitation,
      space_name: spaceName,
      organization_name: org?.name || null,
    };
  }

  /**
   * Accepts a pending invitation by verifying the token, checking expiry, and creating
   * space membership if applicable. All DB writes run inside the `accept_invitation_atomic`
   * RPC so a partial failure cannot leave an activated user without an org membership.
   * Also syncs linked notification status.
   *
   * @param {string} invitationId - The invitation UUID
   * @param {string} token - The secure invitation token for verification
   * @returns {Promise<{ success: true; alreadyAccepted?: boolean; organization?: object; tokens?: AuthTokenBundle }>}
   * @throws {NotFoundException} When the invitation or user account is not found
   * @throws {ForbiddenException} When the token does not match
   * @throws {BadRequestException} When the invitation is expired, not pending, or membership creation fails
   */
  async acceptInvitation(
    invitationId: string,
    token: string,
    password?: string,
  ): Promise<{
    success: true;
    alreadyAccepted?: boolean;
    organization?: {
      id: string;
      slug: string;
      name: string;
      role: string;
    };
    tokens?: AuthTokenBundle;
  }> {
    const fetchResult = await this.client
      .from('invitations')
      .select('*')
      .eq('id', invitationId)
      .single();
    const invitation = fetchResult.data as InvitationRow | null;

    if (fetchResult.error || !invitation) {
      throw new NotFoundException('Invitation not found');
    }

    // Verify token matches
    if (invitation.token !== token) {
      throw new ForbiddenException('Invalid invitation token');
    }

    // Check expiry
    if (new Date(invitation.expires_at) < new Date()) {
      await this.client
        .from('invitations')
        .update({ status: 'expired' })
        .eq('id', invitationId);
      throw new BadRequestException('Invitation has expired');
    }

    if (invitation.status !== 'pending') {
      // Idempotent path: re-accepting an already-accepted invitation returns
      // the joined org info instead of erroring so the frontend can still
      // redirect on a repeat click / bookmark / cross-tab race.
      if (invitation.status === 'accepted') {
        const org = await this.fetchOrganizationSummary(
          invitation.organization_id,
          invitation.role,
        );

        if (org) {
          return { success: true, alreadyAccepted: true, organization: org };
        }
      }

      throw new BadRequestException('Invitation is no longer pending');
    }

    const { user: userData, tokens } = await this.ensureInviteeAccount(
      invitation,
      password,
    );

    // Multi-tenant: all per-invitation writes — activate user, upsert
    // organization_members, optional space_members + space_permissions +
    // user_role_assignments, mark invitation accepted — run inside a single
    // PL/pgSQL RPC so a partial failure cannot leave the user in a broken
    // state. The TS-side space_permissions normalisation must still happen
    // here because the column whitelist + normaliser live in TS.
    let normalizedSpacePerms: Record<string, boolean> | null = null;
    if (invitation.space_id) {
      const permsObj = invitation.space_permissions;
      if (permsObj && Object.keys(permsObj).length > 0) {
        const rawPerms: Record<string, boolean> = {};
        for (const [key, value] of Object.entries(permsObj)) {
          if (typeof value !== 'boolean') continue;
          const flatKey = key.startsWith('can_') ? key.slice(4) : key;
          if (SPACE_PERMISSION_COLUMN_KEYS.has(flatKey)) {
            rawPerms[flatKey] = value;
          }
        }

        const normalized = normalizeSpacePermissions(rawPerms);
        const flat: Record<string, boolean> = {};
        for (const [key, value] of Object.entries(normalized)) {
          if (SPACE_PERMISSION_COLUMN_KEYS.has(key)) {
            flat[`can_${key}`] = value;
          }
        }
        if (Object.keys(flat).length > 0) {
          normalizedSpacePerms = flat;
        }
      }
    }

    const rpcResult = await this.client.rpc('accept_invitation_atomic', {
      p_invitation_id: invitationId,
      p_token: token,
      p_user_id: userData.id,
      p_space_perms: normalizedSpacePerms,
    });

    if (rpcResult.error) {
      const msg = rpcResult.error.message || '';
      if (msg.includes('INVITATION_NOT_FOUND')) {
        throw new NotFoundException('Invitation not found');
      }
      if (msg.includes('INVITATION_NOT_PENDING')) {
        // Race: invitation flipped to accepted between our pre-check and the
        // RPC's FOR UPDATE lock — same idempotent path as above.
        const org = await this.fetchOrganizationSummary(
          invitation.organization_id,
          invitation.role,
        );

        if (org) {
          return { success: true, alreadyAccepted: true, organization: org };
        }

        throw new BadRequestException('Invitation is no longer pending');
      }
      if (msg.includes('INVITATION_EXPIRED')) {
        throw new BadRequestException('Invitation has expired');
      }
      if (msg.includes('SPACE_MEMBER_EXISTS')) {
        throw new BadRequestException('User is already a member of this space');
      }
      this.logger.error('accept_invitation_atomic failed:', rpcResult.error);
      throw new BadRequestException('Failed to accept invitation');
    }

    const rpcContext = (rpcResult.data ?? {}) as {
      organization_id?: string;
      space_id?: string | null;
      default_space_id?: string | null;
      invited_by?: string;
    };

    // Preserve the secondary audit row for org-level invitations that land
    // in the org's default space (mirrors legacy addDefaultSpaceMembership).
    if (rpcContext.default_space_id) {
      void this.auditLogsService.logAction(
        invitation.organization_id,
        rpcContext.invited_by ?? invitation.invited_by,
        'space_member',
        rpcContext.default_space_id,
        'create',
        {
          source: 'organization_invitation_accept',
          user_id: userData.id,
          invitation_id: invitation.id,
        },
      );
    }

    await this.claimPlaceholders(invitation, userData.id);

    // Sync linked notification status
    try {
      const { data: notification } = await this.client
        .from('notifications')
        .select('id, user_id')
        .eq('reference_type', 'invitation')
        .eq('reference_id', invitationId)
        .maybeSingle();

      if (notification) {
        await this.client
          .from('notifications')
          .update({ action_status: 'accepted' })
          .eq('id', (notification as { id: string; user_id: string }).id);
      }
    } catch (e) {
      // Non-critical — log and continue
      this.logger.warn('Failed to sync notification status:', e);
    }

    void this.auditLogsService.logAction(
      invitation.organization_id,
      userData.id,
      invitation.space_id ? 'space_invitation' : 'invitation',
      invitation.id,
      'update',
      {
        action: 'accept',
        invited_by: invitation.invited_by,
        space_id: invitation.space_id,
      },
    );

    // Fetch org slug+name post-accept so the response is self-sufficient —
    // the frontend can cross-origin redirect to {slug}.{root}/ without a
    // follow-up bootstrap call. If the lookup fails (very unlikely under the
    // FK + transaction), omit `organization` entirely; frontend falls back to
    // redirectToTenantAfterAuth(). An empty-slug stand-in would pin an orphan
    // active_org_id cookie and must NOT be returned.
    const organization = await this.fetchOrganizationSummary(
      invitation.organization_id,
      invitation.role,
    );

    if (!organization) {
      this.logger.warn(
        `Org row missing post-accept for ${invitation.organization_id}; ` +
          'frontend will fall back to bootstrap-driven redirect',
      );
    }

    return {
      success: true,
      ...(organization ? { organization } : {}),
      ...(tokens ? { tokens } : {}),
    };
  }

  /**
   * Look up organization summary (id + slug + name) for the accept response.
   * Returns `null` if the org row vanished between membership creation and
   * this select (should never happen — FK + transaction).
   *
   * @private
   */
  private async fetchOrganizationSummary(
    organizationId: string,
    role: string,
  ): Promise<{ id: string; slug: string; name: string; role: string } | null> {
    const { data, error } = await this.client
      .from('organizations')
      .select('id, slug, name')
      .eq('id', organizationId)
      .maybeSingle();

    if (error || !data) {
      if (error) {
        this.logger.warn(
          `fetchOrganizationSummary failed for ${organizationId}: ${error.message}`,
        );
      }

      return null;
    }

    const row = data as { id: string; slug: string; name: string };

    return { id: row.id, slug: row.slug, name: row.name, role };
  }

  /**
   * Pending, non-expired, org-level invitations matching the given email.
   * Used by `GET /invitations/mine` for the onboarding empty-state. Does NOT
   * return the secure token — tokens stay email-only.
   *
   * Filters:
   *   - email match (case-insensitive)
   *   - status = 'pending'
   *   - space_id IS NULL (org-level only; space invites surface elsewhere)
   *   - expires_at > now()
   */
  async listPendingForEmail(email: string): Promise<
    Array<{
      id: string;
      organization_id: string;
      organization_name: string | null;
      organization_slug: string | null;
      role: string;
      invited_by_name: string | null;
      expires_at: string;
      created_at: string;
    }>
  > {
    const { data, error } = await this.client
      .from('invitations')
      .select(
        `
        id, organization_id, role, expires_at, created_at,
        organizations(name, slug),
        invited_by_user:users!invitations_invited_by_fkey(first_name, last_name)
      `,
      )
      .ilike('email', email)
      .eq('status', 'pending')
      .is('space_id', null)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.error(`listPendingForEmail failed: ${error.message}`);
      throw new InternalServerErrorException('Failed to load invitations');
    }

    // Filter out invitations whose org row is missing or incomplete (e.g.
    // soft-deleted org). These are dead links — suppress them server-side
    // rather than rendering ghost cards in the UI.
    return (data ?? [])
      .map((row) => {
        const org = row.organizations as {
          name?: string;
          slug?: string;
        } | null;

        if (!org?.slug || !org?.name) return null;

        const inviter = row.invited_by_user as {
          first_name?: string | null;
          last_name?: string | null;
        } | null;

        const invitedByName = inviter
          ? `${inviter.first_name ?? ''} ${inviter.last_name ?? ''}`.trim() ||
            null
          : null;

        return {
          id: row.id as string,
          organization_id: row.organization_id as string,
          organization_name: org.name,
          organization_slug: org.slug,
          role: row.role as string,
          invited_by_name: invitedByName,
          expires_at: row.expires_at as string,
          created_at: row.created_at as string,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
  }

  /**
   * Resends an invitation by generating a new token, extending the expiry,
   * and creating a fresh Supabase auth invite link.
   *
   * @param {string} invitationId - The invitation UUID to resend
   * @param {string} organizationId - The caller's organization ID (for ownership verification)
   * @returns {Promise<{ invitation: Record<string, unknown>; invitationLink: string; organizationName: string }>}
   * @throws {NotFoundException} When the invitation is not found
   * @throws {ForbiddenException} When the invitation belongs to a different organization
   * @throws {BadRequestException} When the invitation is already accepted or link generation fails
   */
  async resendInvitation(
    invitationId: string,
    organizationId: string,
  ): Promise<{
    invitation: Record<string, unknown>;
    invitationLink: string;
    organizationName: string;
  }> {
    const invResult = await this.client
      .from('invitations')
      .select('*')
      .eq('id', invitationId)
      .single();
    const invitation = invResult.data as InvitationRow | null;

    if (invResult.error || !invitation) {
      throw new NotFoundException('Invitation not found');
    }

    if (invitation.organization_id !== organizationId) {
      throw new ForbiddenException(
        'Cannot resend invitation from another organization',
      );
    }

    if (invitation.status === 'accepted') {
      throw new BadRequestException('Invitation has already been accepted');
    }

    // Generate new token and expiry
    const newToken = this.generateToken();
    const newExpiry = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000,
    ).toISOString();

    await this.client
      .from('invitations')
      .update({ token: newToken, expires_at: newExpiry, status: 'pending' })
      .eq('id', invitationId);

    // Get org name
    const orgResult = await this.client
      .from('organizations')
      .select('name')
      .eq('id', organizationId)
      .single();
    const org = orgResult.data as OrgRow | null;

    const invitationLink = this.buildInvitationLink(newToken);
    const updatedInvitation = {
      ...invitation,
      token: newToken,
      expires_at: newExpiry,
      status: 'pending',
    };

    void this.auditLogsService.logAction(
      organizationId,
      invitation.invited_by,
      'invitation',
      invitation.id,
      'update',
      { action: 'resend', email: invitation.email },
    );

    return {
      invitation: updatedInvitation as unknown as Record<string, unknown>,
      invitationLink,
      organizationName: org?.name || '',
    };
  }

  /**
   * Permanently deletes an invitation after verifying organization ownership.
   *
   * @param {string} invitationId - The invitation UUID to delete
   * @param {string} organizationId - The caller's organization ID (for ownership verification)
   * @returns {Promise<{ success: boolean }>}
   * @throws {NotFoundException} When the invitation is not found
   * @throws {ForbiddenException} When the invitation belongs to a different organization
   * @throws {BadRequestException} When the deletion query fails
   */
  async deleteInvitation(
    invitationId: string,
    organizationId: string,
    actorUserId?: string,
  ) {
    const fetchResult = await this.client
      .from('invitations')
      .select('id, organization_id, email, status')
      .eq('id', invitationId)
      .single();
    const invitation = fetchResult.data as {
      id: string;
      organization_id: string;
      email: string;
      status: string;
    } | null;

    if (fetchResult.error || !invitation) {
      throw new NotFoundException('Invitation not found');
    }

    if (invitation.organization_id !== organizationId) {
      throw new ForbiddenException(
        'Cannot delete invitation from another organization',
      );
    }

    const { error } = await this.client
      .from('invitations')
      .delete()
      .eq('id', invitationId);

    if (error) {
      throw new BadRequestException('Failed to delete invitation');
    }

    if (invitation.status !== 'accepted') {
      await this.deleteAuthUserByEmail(invitation.email);
    }

    if (actorUserId) {
      void this.auditLogsService.logAction(
        organizationId,
        actorUserId,
        'invitation',
        invitation.id,
        'delete',
        { email: invitation.email, status: invitation.status },
      );
    }

    return { success: true };
  }

  /**
   * Revokes a pending organization invitation after verifying organization ownership.
   *
   * @param {string} invitationId - The invitation UUID to revoke
   * @param {string} organizationId - The caller's organization ID (for ownership verification)
   * @returns {Promise<InvitationRow>}
   * @throws {NotFoundException} When the invitation is not found
   * @throws {ForbiddenException} When the invitation belongs to a different organization
   * @throws {BadRequestException} When the invitation was already accepted or revoke fails
   */
  async revokeInvitation(
    invitationId: string,
    organizationId: string,
    actorUserId?: string,
  ): Promise<Record<string, unknown>> {
    const fetchResult = await this.client
      .from('invitations')
      .select('*')
      .eq('id', invitationId)
      .single();
    const invitation = fetchResult.data as InvitationRow | null;

    if (fetchResult.error || !invitation) {
      throw new NotFoundException('Invitation not found');
    }

    if (invitation.organization_id !== organizationId) {
      throw new ForbiddenException(
        'Cannot revoke invitation from another organization',
      );
    }

    if (invitation.status === 'accepted') {
      throw new BadRequestException('Invitation has already been accepted');
    }

    const updateResult = await this.client
      .from('invitations')
      .update({ status: 'revoked' })
      .eq('id', invitationId)
      .select('*')
      .single();

    if (updateResult.error || !updateResult.data) {
      this.logger.error('Error revoking invitation:', updateResult.error);
      throw new BadRequestException('Failed to revoke invitation');
    }

    await this.deleteAuthUserByEmail(invitation.email);

    void this.auditLogsService.logAction(
      organizationId,
      actorUserId ?? invitation.invited_by,
      'invitation',
      invitation.id,
      'delete',
      { action: 'revoke', email: invitation.email },
    );

    return updateResult.data as Record<string, unknown>;
  }
}
