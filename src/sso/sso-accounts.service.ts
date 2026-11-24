/**
 * @fileoverview Account lookup, creation and workspace attachment shared by
 * SCIM provisioning and SAML just-in-time sign-in (XE-T346).
 * @module src/sso/sso-accounts.service
 */

import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  Optional,
} from '@nestjs/common';
import { EntitlementsService } from '../licensing/entitlements.service';
import { PermissionsService } from '../permissions/permissions.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { UsersService, type PublicUser } from '../users/users.service';

/** `organization_members.role` values (DB CHECK constraint). */
export type SsoOrgRole = 'owner' | 'admin' | 'member' | 'viewer';

/** Profile names supplied by the IdP or the SCIM client. */
export interface ISsoAccountNames {
  firstName?: string | null;
  lastName?: string | null;
}

/** Error shape returned by the Supabase JS clients. */
interface ISupabaseError {
  code?: string;
  message: string;
}

/** Trims a name and turns blank input into `null`. */
function blankToNull(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

/**
 * Shared account rules for SCIM and SAML JIT.
 *
 * Emails are matched by exact equality after trim + lowercase, never `ilike`.
 * Neither path ever writes `users.email` or `users.is_active`: those belong to
 * the account owner and to platform administration, not to one workspace's IdP.
 */
@Injectable()
export class SsoAccountsService {
  private readonly logger = new Logger(SsoAccountsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly usersService: UsersService,
    private readonly permissionsService: PermissionsService,
    @Optional() private readonly entitlementsService?: EntitlementsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /** The part after the last `@`, lowercased, or `null` when there is none. */
  emailDomain(email: string): string | null {
    const normalized = this.normalizeEmail(email);
    const at = normalized.lastIndexOf('@');

    return at > 0 && at < normalized.length - 1
      ? normalized.slice(at + 1)
      : null;
  }

  /**
   * @throws {InternalServerErrorException} On a DB error, so a transient
   *   failure is never mistaken for "no such account"
   */
  async findUserByEmail(email: string): Promise<PublicUser | null> {
    const result = await this.client
      .from('users')
      .select('*')
      .eq('email', this.normalizeEmail(email))
      .maybeSingle();

    if (result.error) this.fail('look up the user', result.error);

    return result.data as PublicUser | null;
  }

  /** True when the email's domain is verified by this organization. */
  isDomainVerifiedForOrg(orgId: string, email: string): Promise<boolean> {
    return this.hasVerifiedDomain(orgId, email, null);
  }

  /**
   * The SAML mint gate: true only when the email's domain is verified by this
   * organization AND bound to this exact connection.
   */
  async isDomainBoundToConnection(
    orgId: string,
    connectionId: string,
    email: string,
  ): Promise<boolean> {
    if (!connectionId) return false;

    return this.hasVerifiedDomain(orgId, email, connectionId);
  }

  /**
   * Creates a confirmed auth user plus its `public.users` profile.
   *
   * @throws {ConflictException} `account_conflict` when GoTrue already has the
   *   email (an orphan auth user is refused, never adopted) or the profile row
   *   is already linked to a different auth user
   */
  async createAccount(
    email: string,
    names: ISsoAccountNames,
  ): Promise<PublicUser> {
    const normalized = this.normalizeEmail(email);
    const authUserId = await this.createAuthUser(normalized, names);

    try {
      return await this.linkProfile(normalized, authUserId, names);
    } catch (error) {
      // Leaving the auth user behind would block this email forever
      // (every later attempt hits email_exists and is refused as an orphan).
      await this.deleteAuthUser(authUserId);
      throw error;
    }
  }

  /**
   * Returns the profile's auth user id, creating the auth user when the
   * profile has none.
   *
   * @throws {ConflictException} `account_conflict` on `email_exists`, or when
   *   the profile was linked concurrently
   */
  async ensureAuthUser(user: PublicUser): Promise<string> {
    if (user.auth_user_id) return user.auth_user_id;

    const authUserId = await this.createAuthUser(
      this.normalizeEmail(user.email),
      { firstName: user.first_name, lastName: user.last_name },
    );
    const linked = await this.client
      .from('users')
      .update({ auth_user_id: authUserId })
      .eq('id', user.id)
      .is('auth_user_id', null)
      .select('id')
      .maybeSingle();

    if (linked.error || !linked.data) {
      await this.deleteAuthUser(authUserId);

      if (linked.error) this.fail('link the auth user', linked.error);

      throw new ConflictException('account_conflict');
    }

    return authUserId;
  }

  /** Sets first/last name only where the profile's value is null or blank. */
  async fillBlankNames(userId: string, names: ISsoAccountNames): Promise<void> {
    const firstName = blankToNull(names.firstName);
    const lastName = blankToNull(names.lastName);

    if (!firstName && !lastName) return;

    const user = await this.usersService.getUserById(userId);

    if (!user) return;

    const patch: Record<string, string> = {};

    if (firstName && !user.first_name?.trim()) patch.first_name = firstName;
    if (lastName && !user.last_name?.trim()) patch.last_name = lastName;

    if (Object.keys(patch).length === 0) return;

    const { error } = await this.client
      .from('users')
      .update(patch)
      .eq('id', userId);

    // Names are cosmetic; a failed fill must not fail provisioning.
    if (error) {
      this.logger.warn(`Failed to fill blank names: ${error.message}`);
    }
  }

  async getMemberRole(
    orgId: string,
    userId: string,
  ): Promise<SsoOrgRole | null> {
    const { data, error } = await this.client
      .from('organization_members')
      .select('role')
      .eq('organization_id', orgId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) this.fail('read the workspace role', error);

    return (data?.role as SsoOrgRole | undefined) ?? null;
  }

  async isCurrentOwner(
    orgId: string,
    userId: string | null | undefined,
  ): Promise<boolean> {
    if (!orgId || !userId) return false;

    return (await this.getMemberRole(orgId, userId)) === 'owner';
  }

  /**
   * Adds the user to the workspace (an existing membership and its role are
   * left untouched), expires their pending invitations and evicts cached
   * permissions.
   */
  async attachMember(
    orgId: string,
    userId: string,
    email: string,
    role: SsoOrgRole = 'member',
  ): Promise<void> {
    await this.assertSeatForNewMember(orgId, userId, email);

    const { error } = await this.client
      .from('organization_members')
      .upsert(
        { organization_id: orgId, user_id: userId, role },
        { onConflict: 'organization_id,user_id', ignoreDuplicates: true },
      );

    if (error) this.fail('add the workspace member', error);

    await this.expirePendingInvitations(orgId, email);
    this.permissionsService.bustUser(userId, orgId);
  }

  /**
   * Seat limit (licensing audit D1) for SSO JIT and SCIM provisioning. Throws
   * 403 LIMIT_EXCEEDED when adding this person needs a NEW seat and none is
   * left. No new seat is needed when they already have a membership row (the
   * upsert above leaves it untouched) or a pending invitation (it already
   * counts as a seat and is converted, not added). Call it BEFORE creating an
   * account so a refused JIT login leaves no orphan user behind.
   */
  async assertSeatForNewMember(
    orgId: string,
    userId: string | null,
    email: string,
  ): Promise<void> {
    if (!this.entitlementsService) return;

    if (userId) {
      const { data, error } = await this.client
        .from('organization_members')
        .select('id')
        .eq('organization_id', orgId)
        .eq('user_id', userId)
        .maybeSingle();

      if (error) this.fail('read the workspace membership', error);
      if (data) return;
    }

    const { data: invite, error: inviteError } = await this.client
      .from('invitations')
      .select('id')
      .eq('organization_id', orgId)
      .eq('status', 'pending')
      .eq('email', this.normalizeEmail(email))
      .limit(1)
      .maybeSingle();

    if (inviteError) this.fail('read pending invitations', inviteError);
    if (invite) return;

    await this.entitlementsService.assertSeatAvailable(orgId);
  }

  async expirePendingInvitations(orgId: string, email: string): Promise<void> {
    const { error } = await this.client
      .from('invitations')
      .update({ status: 'expired' })
      .eq('organization_id', orgId)
      .eq('status', 'pending')
      .eq('email', this.normalizeEmail(email));

    // Thrown, not logged: a surviving invitation would let a deprovisioned
    // user re-join the workspace.
    if (error) this.fail('expire pending invitations', error);
  }

  private async hasVerifiedDomain(
    orgId: string,
    email: string,
    connectionId: string | null,
  ): Promise<boolean> {
    const domain = this.emailDomain(email);

    if (!orgId || !domain) return false;

    let query = this.client
      .from('sso_domains')
      .select('id')
      .eq('organization_id', orgId)
      .eq('domain', domain)
      .not('verified_at', 'is', null);

    if (connectionId) query = query.eq('connection_id', connectionId);

    const { data, error } = await query.maybeSingle();

    if (error) this.fail('check the SSO domain', error);

    return Boolean(data);
  }

  private async createAuthUser(
    email: string,
    names: ISsoAccountNames,
  ): Promise<string> {
    const { data, error } = await this.client.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: {
        first_name: blankToNull(names.firstName),
        last_name: blankToNull(names.lastName),
      },
    });

    if (error && this.isEmailExists(error)) {
      throw new ConflictException('account_conflict');
    }

    if (error || !data.user) {
      this.logger.error(
        `Failed to create auth user: ${error?.message ?? 'no user returned'}`,
      );
      throw new InternalServerErrorException('Failed to create account');
    }

    return data.user.id;
  }

  /**
   * Links the profile row for a freshly created auth user. The production
   * `handle_new_user` trigger inserts that row itself; local stacks lack the
   * trigger, so the row is inserted here when absent.
   */
  private async linkProfile(
    email: string,
    authUserId: string,
    names: ISsoAccountNames,
  ): Promise<PublicUser> {
    const existing = await this.client
      .from('users')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (existing.error) this.fail('look up the profile', existing.error);

    const row = existing.data as PublicUser | null;

    if (!row) {
      const inserted = await this.client
        .from('users')
        .insert({
          email,
          first_name: blankToNull(names.firstName),
          last_name: blankToNull(names.lastName),
          auth_user_id: authUserId,
        })
        .select('*')
        .single();

      if (inserted.error) this.fail('create the profile', inserted.error);

      return inserted.data as PublicUser;
    }

    if (!row.auth_user_id) {
      const linked = await this.client
        .from('users')
        .update({ auth_user_id: authUserId })
        .eq('id', row.id)
        .is('auth_user_id', null)
        .select('id')
        .maybeSingle();

      if (linked.error) this.fail('link the profile', linked.error);
      if (!linked.data) throw new ConflictException('account_conflict');
    } else if (row.auth_user_id !== authUserId) {
      throw new ConflictException('account_conflict');
    }

    await this.fillBlankNames(row.id, names);

    return (
      (await this.usersService.getUserById(row.id)) ?? {
        ...row,
        auth_user_id: authUserId,
      }
    );
  }

  private async deleteAuthUser(authUserId: string): Promise<void> {
    const { error } = await this.client.auth.admin.deleteUser(authUserId);

    if (error) {
      this.logger.error(
        `Failed to remove unlinked auth user ${authUserId}: ${error.message}`,
      );
    }
  }

  private isEmailExists(error: ISupabaseError): boolean {
    return (
      error.code === 'email_exists' ||
      /already (been )?registered|exists/i.test(error.message)
    );
  }

  private fail(action: string, error: ISupabaseError): never {
    this.logger.error(`Failed to ${action}: ${error.message}`);
    throw new InternalServerErrorException(`Failed to ${action}`);
  }
}
