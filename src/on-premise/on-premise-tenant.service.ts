/**
 * @fileoverview Single-tenant helpers for on-premise deployments: resolve the one
 * configured organization, and attach an authenticated user to it.
 *
 * WHY THIS EXISTS. On-premise is single-tenant — `ON_PREMISE_ORG_SLUG` /
 * `ON_PREMISE_ORG_ID` pin the one organization the install serves. But nothing in
 * the product ever *joined* a user to it: `auth.service.signup()` only asks GoTrue
 * to create an `auth.users` row, and the `handle_new_user` trigger creates the
 * `public.users` profile. Neither writes `organization_members`. The only two
 * membership-writing paths are `create_organization_with_owner` (onboarding) and
 * `accept_invitation_atomic` (invites). So a self-service signup landed with zero
 * memberships, `signin()` returned `defaultOrganization: null`, and the frontend
 * offered to CREATE A SECOND ORGANIZATION on a deployment meant to have exactly
 * one. Two customers hit that screen.
 *
 * CLOUD SAFETY. Every public method returns immediately unless `onPrem.enabled`
 * is true. Off-premise this class issues no queries and performs no writes, so
 * SaaS multi-tenant behaviour is unchanged.
 *
 * @module src/on-premise/on-premise-tenant.service
 * @author Prince Jadiya
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

/**
 * Roles permitted by the `organization_members_role_check` CHECK constraint.
 * Kept in step with the migration; an unrecognised configured value falls back
 * to `member` rather than failing the insert at runtime.
 */
const VALID_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
type OrgRole = (typeof VALID_ROLES)[number];

/** Least privilege: a self-service signup must never gain control of the tenant. */
const DEFAULT_ROLE: OrgRole = 'member';

@Injectable()
export class OnPremiseTenantService {
  private readonly logger = new Logger(OnPremiseTenantService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly configService: ConfigService,
  ) {}

  /** True only on a self-hosted on-premise stack. */
  get isOnPremise(): boolean {
    return this.configService.get<boolean>('onPrem.enabled') === true;
  }

  /**
   * The role auto-joined users receive. `ON_PREMISE_DEFAULT_ROLE` overrides it;
   * anything outside the CHECK constraint is ignored with a warning so a typo in
   * client.conf degrades to `member` instead of breaking every login.
   */
  private get defaultRole(): OrgRole {
    const configured = (
      this.configService.get<string>('onPrem.defaultRole') || ''
    )
      .trim()
      .toLowerCase();

    if (!configured) return DEFAULT_ROLE;

    if ((VALID_ROLES as readonly string[]).includes(configured)) {
      return configured as OrgRole;
    }

    this.logger.warn(
      `ON_PREMISE_DEFAULT_ROLE="${configured}" is not one of ${VALID_ROLES.join('|')} — using "${DEFAULT_ROLE}".`,
    );

    return DEFAULT_ROLE;
  }

  /**
   * The single organization this on-premise install serves, or `null` when it
   * cannot be determined unambiguously.
   *
   * Resolution order, most explicit first:
   *   1. `ON_PREMISE_ORG_ID`   — an exact id pin.
   *   2. `ON_PREMISE_ORG_SLUG` — a slug pin (operators commonly set only this).
   *   3. The sole organization, when exactly one exists.
   *
   * Returns `null` on ambiguity (several orgs, no pin) or when a pin names an org
   * that does not exist. Never guesses and never creates an organization: on a
   * fresh install there is genuinely no org yet — no migration seeds one — and the
   * first user must still be able to create it through onboarding.
   */
  async resolveOrgId(): Promise<string | null> {
    if (!this.isOnPremise) return null;

    const client = this.supabaseAdmin.getClient();
    const pinnedId = (
      this.configService.get<string>('onPrem.orgId') || ''
    ).trim();
    const pinnedSlug = (
      this.configService.get<string>('onPrem.orgSlug') || ''
    ).trim();

    if (pinnedId) {
      const { data, error } = await client
        .from('organizations')
        .select('id')
        .eq('id', pinnedId)
        .maybeSingle();

      if (error) {
        this.logger.warn(`resolveOrgId: lookup by id failed: ${error.message}`);
        return null;
      }

      if (data?.id) return data.id as string;

      // A pin that matches nothing is a configuration error worth surfacing —
      // silently falling through to the sole-org guess would hide it.
      this.logger.warn(
        `ON_PREMISE_ORG_ID="${pinnedId}" does not match any organization.`,
      );
    }

    if (pinnedSlug) {
      const { data, error } = await client
        .from('organizations')
        .select('id')
        .eq('slug', pinnedSlug)
        .maybeSingle();

      if (error) {
        this.logger.warn(
          `resolveOrgId: lookup by slug failed: ${error.message}`,
        );
        return null;
      }

      if (data?.id) return data.id as string;

      this.logger.warn(
        `ON_PREMISE_ORG_SLUG="${pinnedSlug}" does not match any organization.`,
      );
    }

    // No usable pin — fall back to the sole organization. `limit(2)` is
    // deliberate: it distinguishes "exactly one" from "more than one" in a
    // single round trip, and we refuse to choose when it is more than one.
    const { data, error } = await client
      .from('organizations')
      .select('id')
      .limit(2);

    if (error) {
      this.logger.warn(
        `resolveOrgId: organizations lookup failed: ${error.message}`,
      );
      return null;
    }

    if (data && data.length === 1) return (data[0] as { id: string }).id;

    return null;
  }

  /**
   * Ensure an authenticated on-premise user belongs to the configured organization.
   *
   * Safe to call on EVERY login, not just the first: the insert is
   * `ON CONFLICT DO NOTHING` on the `(organization_id, user_id)` unique key.
   *
   * The three-column insert mirrors `accept_invitation_atomic` for a functional
   * reason, not a stylistic one — it fires the `sync_org_member_to_spaces` trigger,
   * which adds the user to the org's `default_space_id` (and, for owner/admin,
   * every space). Bypassing that trigger would create a member who can see nothing.
   *
   * Never throws: a failure here must not block a login. Worst case the user sees
   * the onboarding screen, exactly as before this method existed.
   *
   * @param publicUserId `public.users.id` (NOT `auth_user_id`)
   * @param email        used only to detect a pending invitation
   * @returns the org id joined, or `null` when nothing was done
   */
  async ensureDefaultMembership(
    publicUserId: string,
    email?: string | null,
  ): Promise<string | null> {
    if (!this.isOnPremise || !publicUserId) return null;

    try {
      const client = this.supabaseAdmin.getClient();

      // A pending invitation carries an explicit role chosen by an admin. Joining
      // first would silently downgrade an invited admin to `member`, so let the
      // invitation flow own this user.
      if (email) {
        const { data: invites } = await client
          .from('invitations')
          .select('id')
          .eq('email', email.trim().toLowerCase())
          .eq('status', 'pending')
          .limit(1);

        if (invites && invites.length > 0) {
          this.logger.log(
            `auto-join skipped for user ${publicUserId}: a pending invitation exists (its role wins).`,
          );

          return null;
        }
      }

      // Already a member of the pinned org? Nothing to do — and skip the write so
      // the common case (every subsequent login) costs one cheap read.
      const orgId = await this.resolveOrgId();

      if (!orgId) return null;

      // Never attach anyone to a deactivated tenant: that would route them into a
      // dead org instead of the existing "all organizations deactivated" screen.
      const { data: org, error: orgErr } = await client
        .from('organizations')
        .select('id, is_active')
        .eq('id', orgId)
        .maybeSingle();

      if (orgErr || !org) return null;

      if ((org as { is_active?: boolean | null }).is_active === false) {
        this.logger.warn(
          `auto-join skipped: organization ${orgId} is deactivated.`,
        );

        return null;
      }

      // A deactivated account must not be silently reactivated into the tenant.
      const { data: user, error: userErr } = await client
        .from('users')
        .select('id, is_active')
        .eq('id', publicUserId)
        .maybeSingle();

      if (userErr || !user) return null;

      if ((user as { is_active?: boolean | null }).is_active === false) {
        this.logger.warn(
          `auto-join skipped: user ${publicUserId} is deactivated.`,
        );

        return null;
      }

      // SCIM deprovisioned this user from the tenant; auto-join would undo that.
      const { data: inactiveLinks, error: linkErr } = await client
        .from('scim_links')
        .select('id')
        .eq('organization_id', orgId)
        .eq('local_user_id', publicUserId)
        .eq('is_active', false)
        .limit(1);

      if (linkErr) {
        this.logger.warn(
          `auto-join skipped: scim_links read failed for ${publicUserId}: ${linkErr.message}`,
        );

        return null;
      }

      if (inactiveLinks && inactiveLinks.length > 0) {
        this.logger.warn(
          `auto-join skipped: user ${publicUserId} was deprovisioned by SCIM.`,
        );

        return null;
      }

      const role = this.defaultRole;

      const { error: insertErr } = await client
        .from('organization_members')
        .upsert(
          { organization_id: orgId, user_id: publicUserId, role },
          { onConflict: 'organization_id,user_id', ignoreDuplicates: true },
        );

      if (insertErr) {
        this.logger.warn(
          `auto-join failed for user ${publicUserId} → org ${orgId}: ${insertErr.message}`,
        );

        return null;
      }

      this.logger.log(
        `on-premise auto-join: user ${publicUserId} → organization ${orgId} as "${role}".`,
      );

      return orgId;
    } catch (err) {
      // Deliberately swallowed: never let tenant plumbing break authentication.
      this.logger.warn(
        `auto-join errored for user ${publicUserId}: ${err instanceof Error ? err.message : String(err)}`,
      );

      return null;
    }
  }
}
