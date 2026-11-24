/**
 * @fileoverview Identity resolution for migrated actors (assignees, reporters, comment
 * authors, role members, mentions). The rule: match by EMAIL within the target org; else,
 * when the job opts in, PROVISION a real account from the source's own data and mail a
 * set-password link; else create a linked PLACEHOLDER `public.users` row (`auth_user_id`
 * stays NULL; the DB column is verified nullable).
 *
 * Provisioning is opt-in per job and never happens in preview, because it creates real
 * accounts and sends real mail — on an air-gapped deployment that is one message per source
 * user through the customer's own relay. Preview reports `would_create` so the whole list is
 * reviewable before a single message is sent.
 *
 * Deliberately NOT built on `InvitationsService.ensureInviteeAccount`: its no-password
 * path cannot create rows and its password path always creates an auth account.
 *
 * Tenant isolation: `users.email` is GLOBALLY unique, so a raw email hit may belong to
 * another tenant — a match counts ONLY when that user is a member of the target org.
 *
 * A placeholder keeps the actor's REAL email when that address is unused, so the person keeps
 * their identity and a second connection migrating the same account resolves to the SAME row.
 * When the address is missing or already claimed it falls back to a deterministic,
 * connection-scoped synthetic address (`mig-{conn8}-{sha1(stableId)12}@placeholder.invalid`),
 * which keeps concurrent workers converging on one row without ever adopting a stranger's account.
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { MailService } from '../../mail/mail.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import {
  isProvisionableEmail,
  PLACEHOLDER_DOMAIN,
} from './provisionable-email.util';
import type { NormalizedUser } from '../model/normalized';

export type UserMatchMethod = 'email' | 'created' | 'placeholder';

export interface ResolvedUser {
  /** public.users.id — the crosswalk target_id ('' in preview mode for placeholders). */
  userId: string;
  matchMethod: UserMatchMethod;
  isPlaceholder: boolean;
  /** Persisted onto the crosswalk row (display_name is metadata only, never a key). */
  metadata: {
    source_type: 'jira' | 'confluence';
    source_id: string;
    email: string | null;
    display_name: string;
    match_method: UserMatchMethod;
    is_placeholder: boolean;
    source_active: boolean;
  };
}

@Injectable()
export class UserMapper {
  private readonly logger = new Logger(UserMapper.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly mail: MailService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /** Deterministic, connection-scoped, non-routable, PII-free synthetic address. */
  syntheticEmail(connectionId: string, stableId: string): string {
    const hash = createHash('sha1').update(stableId).digest('hex').slice(0, 12);

    return `mig-${connectionId.replace(/-/g, '').slice(0, 8)}-${hash}@${PLACEHOLDER_DOMAIN}`;
  }

  /**
   * Resolve a source actor to a `public.users` row.
   * `previewOnly` never writes — it reports the would-be outcome for the review UI.
   */
  async resolveUser(
    orgId: string,
    connectionId: string,
    actor: NormalizedUser,
    opts: { previewOnly?: boolean; provision?: boolean } = {},
  ): Promise<ResolvedUser> {
    const email = (actor.email ?? '').trim();

    const metadataBase = {
      source_type: actor.sourceType,
      source_id: actor.sourceId,
      email: email || null,
      display_name: actor.displayName,
      source_active: actor.active !== false,
    };

    if (email) {
      const matched = await this.findOrgMemberByEmail(orgId, email);

      if (matched) {
        // A member who never signed in is an earlier migration's placeholder for this person: reuse it,
        // but keep it a placeholder so it is still invited and stays off member surfaces.
        const isPlaceholder = !matched.authUserId;

        return {
          userId: matched.id,
          matchMethod: 'email',
          isPlaceholder,
          metadata: {
            ...metadataBase,
            match_method: 'email',
            is_placeholder: isPlaceholder,
          },
        };
      }
    }

    // Provisioning is gated on the job opting in AND the address looking like a real person's.
    // `active` matters because a deactivated Jira account is usually someone who has left.
    const provisionable =
      opts.provision === true &&
      actor.active !== false &&
      isProvisionableEmail(email);

    if (opts.previewOnly) {
      // Report the would-be outcome so the whole create-list is reviewable BEFORE any account
      // exists or any mail is sent. Never writes.
      const wouldCreate = provisionable && !(await this.emailExists(email));

      return {
        userId: '',
        matchMethod: wouldCreate ? 'created' : 'placeholder',
        isPlaceholder: !wouldCreate,
        metadata: {
          ...metadataBase,
          match_method: wouldCreate ? 'created' : 'placeholder',
          is_placeholder: !wouldCreate,
        },
      };
    }

    if (provisionable) {
      const provisionedId = await this.provisionUser(orgId, actor, email);

      if (provisionedId) {
        return {
          userId: provisionedId,
          matchMethod: 'created',
          isPlaceholder: false,
          metadata: {
            ...metadataBase,
            match_method: 'created',
            is_placeholder: false,
          },
        };
      }
      // Fall through: provisioning declined or failed, so the actor still gets a placeholder and
      // the run continues. Attribution is never lost.
    }

    const userId = await this.getOrCreatePlaceholder(
      orgId,
      connectionId,
      actor,
    );

    return {
      userId,
      matchMethod: 'placeholder',
      isPlaceholder: true,
      metadata: {
        ...metadataBase,
        match_method: 'placeholder',
        is_placeholder: true,
      },
    };
  }

  /**
   * Email match restricted to MEMBERS of the target org. A user row with that email
   * in another tenant is NOT a match (cross-tenant isolation) — placeholder instead.
   */
  private async findOrgMemberByEmail(
    orgId: string,
    email: string,
  ): Promise<{ id: string; authUserId: string | null } | null> {
    // ilike with escaped pattern chars = case-insensitive exact match. users.email
    // is a case-SENSITIVE unique index, so case-variant duplicates CAN coexist —
    // fetch up to a few candidates (never maybeSingle, which errors on multi-row)
    // and prefer the exact-case row.
    const pattern = email.replace(/([\\%_])/g, '\\$1');

    const { data: candidates, error } = (await this.db
      .from('users')
      .select('id, email, auth_user_id')
      .ilike('email', pattern)
      .limit(5)) as {
      data: { id: string; email: string; auth_user_id: string | null }[] | null;
      error: { message: string } | null;
    };

    if (error)
      throw new BadRequestException(
        `User email lookup failed: ${error.message}`,
      );

    if (!candidates || candidates.length === 0) return null;

    const ordered = [
      ...candidates.filter((c) => c.email === email),
      ...candidates.filter((c) => c.email !== email),
    ];

    // A match counts only when the candidate is a member of the TARGET org.
    for (const candidate of ordered) {
      const { data: membership, error: memberError } = (await this.db
        .from('organization_members')
        .select('id')
        .eq('organization_id', orgId)
        .eq('user_id', candidate.id)
        .limit(1)) as {
        data: { id: string }[] | null;
        error: { message: string } | null;
      };

      if (memberError)
        throw new BadRequestException(
          `Membership lookup failed: ${memberError.message}`,
        );

      if (membership && membership.length > 0)
        return { id: candidate.id, authUserId: candidate.auth_user_id };
    }

    return null;
  }

  /**
   * Create (or reuse) the linked placeholder row — deduped on the synthetic email's
   * global uniqueness, so concurrent workers converge on one row. `is_active: false`
   * blocks sign-in.
   *
   * The placeholder is also enrolled in the target org as a `viewer`, because a
   * placeholder that is not an org member cannot be referenced at all:
   * `TasksService.assertUserInOrganization` gates `reporter`/`assigned_to` on an
   * `organization_members` row and rejects the write otherwise. That guard is a
   * tenant-isolation control (it stops a caller pointing `reporter` at a user in
   * another org), so the migration must satisfy it rather than weaken it — and
   * carrying attribution is the placeholder's only purpose.
   *
   * `viewer` is the least-privilege role the CHECK constraint allows, and the row
   * grants nothing on its own: sign-in is blocked by `is_active: false` +
   * `auth_user_id: null`, no invitation is sent (that is a separate flow), and
   * `seats_used` is an explicit licensing field rather than a member count.
   *
   * The role is load-bearing, not cosmetic. The `on_org_member_sync_spaces` trigger
   * (`sync_org_member_to_spaces`) fans an `owner`/`admin` member out to EVERY space in the org —
   * so anything above `viewer` would silently make every migrated Jira user a member of every
   * space. `viewer` skips that branch. Its second branch still auto-joins ANY role to the org's
   * `default_space_id` as `member`, so a placeholder does land in the default space: that is the
   * platform's own invariant for org members, it stays inside the tenant, and sign-in remains
   * blocked. Do not "fix" it by deleting that row — it is re-created on the next placeholder write.
   */
  private async getOrCreatePlaceholder(
    orgId: string,
    connectionId: string,
    actor: NormalizedUser,
  ): Promise<string> {
    const displayName = actor.displayName?.trim() || actor.sourceId;
    const [firstName, ...rest] = displayName.split(/\s+/);
    const profile = {
      first_name: firstName,
      last_name: rest.join(' ') || null,
      auth_user_id: null,
      is_active: false,
      updated_at: new Date().toISOString(),
    };

    // Keep the person's REAL address when it is free. Two reasons, both verified live:
    // the synthetic address discards an identity the crosswalk already knows
    // (`c.kienzl@o-range.at`), and because it embeds the connection id, migrating the same Jira
    // account through a second connection minted a DUPLICATE user row for one human. With the real
    // address the next run's `findOrgMemberByEmail` matches this row instead of creating a twin.
    const realEmail = (actor.email ?? '').trim();
    const claimed = realEmail ? await this.emailExists(realEmail) : true;

    if (realEmail && !claimed) {
      const insert = (await this.db
        .from('users')
        .insert({ email: realEmail, ...profile })
        .select('id')
        .single()) as {
        data: { id: string } | null;
        error: { message: string; code?: string } | null;
      };

      if (!insert.error && insert.data) {
        await this.ensureOrgMembership(orgId, insert.data.id);

        return insert.data.id;
      }

      // 23505 means the address was claimed between the check and the insert. It may now belong to
      // ANOTHER tenant, so fall through to the synthetic address rather than adopting that row.
      if (insert.error && insert.error.code !== '23505') {
        throw new BadRequestException(
          `Placeholder user creation failed: ${insert.error.message}`,
        );
      }
    }

    // Fallback: the deterministic, connection-scoped, non-routable address. Used when the source
    // has no email, or the real one is already taken — `users.email` is GLOBALLY unique, so a hit
    // may be a different tenant's account and adopting it would be cross-tenant takeover.
    const { data, error } = (await this.db
      .from('users')
      .upsert(
        {
          email: this.syntheticEmail(connectionId, actor.sourceId),
          ...profile,
        },
        { onConflict: 'email' },
      )
      .select('id')
      .single()) as {
      data: { id: string } | null;
      error: { message: string } | null;
    };

    if (error || !data)
      throw new BadRequestException(
        `Placeholder user creation failed: ${error?.message ?? 'no row returned'}`,
      );

    await this.ensureOrgMembership(orgId, data.id);

    return data.id;
  }

  /** Is this address already used by ANY user row? (`users.email` is globally unique.) */
  private async emailExists(email: string): Promise<boolean> {
    const pattern = email.replace(/([\\%_])/g, '\\$1');

    const { data, error } = (await this.db
      .from('users')
      .select('id')
      .ilike('email', pattern)
      .limit(1)) as {
      data: { id: string }[] | null;
      error: { message: string } | null;
    };

    if (error)
      throw new BadRequestException(
        `User email availability check failed: ${error.message}`,
      );

    return (data?.length ?? 0) > 0;
  }

  /**
   * Enrol the placeholder in the target org as `viewer` — see the note on
   * `getOrCreatePlaceholder`: without a membership row every reporter/assignee write is rejected,
   * and any role above `viewer` fans the user out to every space in the org.
   */
  private async ensureOrgMembership(
    orgId: string,
    userId: string,
  ): Promise<void> {
    const { error } = await this.db
      .from('organization_members')
      .upsert(
        { organization_id: orgId, user_id: userId, role: 'viewer' },
        { onConflict: 'organization_id,user_id', ignoreDuplicates: true },
      );

    if (error)
      throw new BadRequestException(
        `Placeholder membership creation failed: ${error.message}`,
      );
  }

  /**
   * Create a real account for a source actor and mail them a set-password link.
   *
   * Only ever creates when the address is unused. An address already on a `public.users` row may
   * belong to another tenant (`users.email` is globally unique but membership is not), and silently
   * adopting it would cross the isolation boundary that `findOrgMemberByEmail` exists to enforce —
   * so that case declines and the caller falls back to a placeholder.
   *
   * `handle_new_user` builds the `public.users` profile from the auth row, so this must NOT insert
   * one itself. It does have to set `is_active` afterwards: that trigger never touches the column,
   * and `PermissionsGuard` filters memberships on it.
   *
   * @returns the new `public.users.id`, or `null` when provisioning was declined or failed.
   */
  private async provisionUser(
    orgId: string,
    actor: NormalizedUser,
    email: string,
  ): Promise<string | null> {
    if (await this.emailExists(email)) return null;

    const [firstName, ...rest] = (actor.displayName ?? '').trim().split(/\s+/);
    const lastName = rest.join(' ') || null;

    try {
      const { data: createdAuth, error: authError } =
        await this.db.auth.admin.createUser({
          email,
          email_confirm: true,
          user_metadata: {
            first_name: firstName || null,
            last_name: lastName,
            full_name: actor.displayName || null,
          },
        });

      if (authError || !createdAuth?.user) {
        this.logger.warn(
          `Provisioning ${actor.sourceId} failed: ${authError?.message ?? 'no auth user returned'}`,
        );

        return null;
      }

      const { data: profile, error: profileError } = (await this.db
        .from('users')
        .update({ is_active: true, updated_at: new Date().toISOString() })
        .eq('auth_user_id', createdAuth.user.id)
        .select('id')
        .maybeSingle()) as {
        data: { id: string } | null;
        error: { message: string } | null;
      };

      if (profileError || !profile?.id) {
        // The trigger is present in both migration chains, so this means something is genuinely
        // wrong with the deployment rather than with this actor. Decline; do not guess an id.
        this.logger.warn(
          `Provisioned ${email} but no profile row appeared (handle_new_user missing?): ${profileError?.message ?? 'not found'}`,
        );

        return null;
      }

      await this.ensureOrgMembership(orgId, profile.id);
      await this.sendSetPasswordLink(orgId, email, firstName || undefined);

      return profile.id;
    } catch (err) {
      this.logger.warn(
        `Provisioning ${actor.sourceId} threw: ${(err as Error).message}`,
      );

      return null;
    }
  }

  /**
   * Mail the set-password link. FIRE AND FORGET on purpose.
   *
   * `MailService.send` rethrows on transport failure, and the migration worker would classify that
   * as a failed item and retry it — re-sending on every retry. A relay outage would become a mail
   * storm. The account is already usable via the normal forgot-password flow, so a failed send is
   * logged and nothing more.
   */
  private async sendSetPasswordLink(
    orgId: string,
    email: string,
    firstName?: string,
  ): Promise<void> {
    try {
      const appUrl = process.env.APP_URL ?? process.env.FRONTEND_URL ?? '';
      const { data, error } = await this.db.auth.admin.generateLink({
        type: 'recovery',
        email,
        options: { redirectTo: `${appUrl}/auth/update-password` },
      });

      const link = data?.properties?.action_link;

      if (error || !link) {
        this.logger.warn(
          `No set-password link for ${email}: ${error?.message ?? 'none returned'}`,
        );

        return;
      }

      await this.mail.sendPasswordReset(email, link, firstName, {
        organizationId: orgId,
      });
    } catch (err) {
      this.logger.warn(
        `Set-password mail to ${email} failed: ${(err as Error).message}`,
      );
    }
  }
}
