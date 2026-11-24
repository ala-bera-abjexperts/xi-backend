/**
 * @fileoverview `users` stage — the DAG root. Seeds one item per distinct source user
 * (project role actors, enriched with emails where the source allows) and resolves each
 * through the UserMapper: email-match within the target org, else linked placeholder
 * (NO invitation email, no auth account). Dry-run records `planned` crosswalk rows with
 * the would-match method; live runs record `mapped`/`placeholder` rows that every later
 * stage (issues/comments/roles) resolves assignees and authors through.
 *
 * With `invite_users` (XE-T682) a live run also invites each placeholder that has a usable email to
 * the org: Jira administrators as `admin`, everyone else as `member`. Accepting claims the placeholder
 * (InvitationsService.claimPlaceholders), so the person gets their work and project roles.
 */

import { BadRequestException, Injectable } from '@nestjs/common';
import { InvitationsService } from '../../../invitations/invitations.service';
import { MailService } from '../../../mail/mail.service';
import {
  isConfluenceAdapter,
  isJiraAdapter,
  type IJiraSourceAdapter,
} from '../../adapters/source-adapter.interface';
import type { NormalizedUser } from '../../model/normalized';
import { isProvisionableEmail } from '../../mappers/provisionable-email.util';
import { UserMapper } from '../../mappers/user.mapper';
import type { MigrationEntityMapRow } from '../../services/migration-entity-map.service';
import { requireActingUser, runOptions } from './stage-helpers';
import {
  MigrationItemError,
  type IStageHandler,
  type ItemOutcome,
  type MigrationRunItemRow,
  type ProduceResult,
  type SeedItem,
  type StageContext,
} from './stage.interface';

export const USERS_STAGE = 'users';

/** Crosswalk entity type downstream mappers resolve actors through. */
export const USER_ENTITY = 'user';

/**
 * Jira's administrator groups: Server/DC ships `jira-administrators` and `jira-system-administrators`,
 * Cloud has `site-admins` and `jira-admins-<site>`.
 * ponytail: group-name heuristic; read the global permission scheme if customers rename these groups.
 */
const JIRA_ADMIN_GROUP =
  /^(jira-administrators|jira-system-administrators|site-admins|jira-admins(-.+)?)$/i;

/** Source ids of the members of the instance's Jira administrator groups; empty when they can't be read. */
export async function findJiraAdminIds(
  adapter: IJiraSourceAdapter,
  warn: (message: string) => void,
): Promise<Set<string>> {
  const ids = new Set<string>();

  try {
    const groups = (await adapter.listGroups()).filter((g) =>
      JIRA_ADMIN_GROUP.test(g.name),
    );

    for (const group of groups) {
      let cursor: string | null = null;

      // Admin groups are small; the cap only stops a source that never ends its paging.
      for (let page = 0; page < 20; page++) {
        const res = await adapter.getGroupMembers(group.sourceId, { cursor });

        res.items.forEach((u) => ids.add(u.sourceId));
        if (!res.nextCursor || res.nextCursor === cursor) break;
        cursor = res.nextCursor;
      }
    }
  } catch (err) {
    warn(
      `Could not read Jira administrator groups, everyone is invited as member: ${(err as Error).message}`,
    );
  }

  return ids;
}

/** Org role an invited source user gets, or why they are not invited. */
export function inviteDecision(
  actor: NormalizedUser,
  jiraAdmin: boolean,
): { role: 'admin' | 'member' } | { skip: string } {
  if (actor.active === false) return { skip: 'inactive_in_source' };
  if (!isProvisionableEmail((actor.email ?? '').trim())) {
    return { skip: 'no_usable_email' };
  }

  return { role: jiraAdmin ? 'admin' : 'member' };
}

/** The users-stage item payload: the source user plus whether they are a Jira administrator. */
type UserItemPayload = NormalizedUser & { jiraAdmin?: boolean };

@Injectable()
export class UsersStage implements IStageHandler {
  readonly stage = USERS_STAGE;

  constructor(
    private readonly userMapper: UserMapper,
    private readonly invitationsService: InvitationsService,
    private readonly mailService: MailService,
  ) {}

  /** One bounded page: project users are already deduped by stable id in the adapter. */
  async produce(ctx: StageContext): Promise<ProduceResult> {
    const adapter = await ctx.getAdapter();

    let users: NormalizedUser[];

    if (isJiraAdapter(adapter)) {
      ({ users } = await adapter.getUsersAndRoles(ctx.job.source_ref));
    } else if (isConfluenceAdapter(adapter) && adapter.getSpaceUsers) {
      // Confluence Cloud hides emails outright, so every one of these resolves to a linked
      // placeholder rather than an email match — which is exactly what `UserMapper` already does when
      // `email` is absent. Without this branch every `@mention` in the space migrates unresolved.
      users = await adapter.getSpaceUsers(
        ctx.job.source_ref,
        (message, meta) => {
          void ctx.log('warn', message, meta);
        },
      );
    } else {
      await ctx.log(
        'warn',
        'users stage: this source has no user extraction — seeding 0 users',
      );

      return { items: [], nextCheckpoint: null, done: true };
    }
    // Only read when invites are on, so a run without them makes exactly the calls it always made.
    const adminIds =
      isJiraAdapter(adapter) &&
      runOptions(ctx).invite_users === true &&
      !ctx.dryRun
        ? await findJiraAdminIds(adapter, (message) => {
            void ctx.log('warn', message);
          })
        : new Set<string>();
    const seen = new Set<string>();
    const items: SeedItem[] = [];

    for (const user of users) {
      if (!user.sourceId || seen.has(user.sourceId)) continue;

      seen.add(user.sourceId);
      const payload: UserItemPayload = adminIds.has(user.sourceId)
        ? { ...user, jiraAdmin: true }
        : user;

      items.push({
        entityType: USER_ENTITY,
        sourceRef: user.sourceId,
        // Snapshot so processItem never re-fetches the source.
        payload: payload as unknown as Record<string, unknown>,
      });
    }

    await ctx.log(
      'info',
      `users producer seeded ${items.length} distinct source users`,
      {
        count: items.length,
      },
    );

    return { items, nextCheckpoint: null, done: true };
  }

  async processItem(
    ctx: StageContext,
    item: MigrationRunItemRow,
  ): Promise<ItemOutcome> {
    const actor = item.payload as unknown as UserItemPayload | null;

    if (!actor || !actor.sourceId) {
      throw new MigrationItemError(
        'permanent',
        'User item is missing its normalized payload snapshot',
      );
    }

    // Idempotency: an existing terminal crosswalk row means this user is done.
    const existing = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      USER_ENTITY,
      actor.sourceId,
    );

    if (existing) {
      // A re-run with invites switched on still invites the placeholders an earlier run left; a pending
      // invite is not duplicated, an expired one is sent again.
      if (existing.status === 'placeholder' && this.invitesOn(ctx)) {
        await this.inviteAndRecord(ctx, actor, existing);
      }

      if (existing.status === 'mapped' || existing.status === 'placeholder') {
        return {
          kind: 'skipped',
          reason: 'user already mapped',
          targetId: existing.target_id,
        };
      }

      if (existing.status === 'planned' && ctx.dryRun) {
        return {
          kind: 'skipped',
          reason: 'already planned',
          targetId: existing.target_id,
        };
      }
    }

    const resolved = await this.userMapper.resolveUser(
      ctx.orgId,
      ctx.job.connection_id,
      actor,
      {
        previewOnly: ctx.dryRun,
        provision: runOptions(ctx).provision_users === true,
      },
    );

    if (ctx.dryRun) {
      await ctx.entityMap.recordMapping({
        orgId: ctx.orgId,
        connectionId: ctx.job.connection_id,
        jobId: ctx.job.id,
        runId: ctx.run.id,
        entityType: USER_ENTITY,
        sourceId: actor.sourceId,
        sourceKey: actor.username ?? null,
        targetTable: 'users',
        targetId: resolved.userId || `planned:${resolved.matchMethod}`,
        status: 'planned',
        matchMethod: resolved.matchMethod,
        isPlaceholder: resolved.isPlaceholder,
        sourceEmail: actor.email ?? null,
        metadata: resolved.metadata,
      });

      return { kind: 'planned' };
    }

    // Recorded before inviting: the crosswalk row is what tells InvitationsService a member holding this
    // email is a placeholder, not a real member it must refuse to invite twice.
    const row = await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: ctx.run.id,
      entityType: USER_ENTITY,
      sourceId: actor.sourceId,
      sourceKey: actor.username ?? null,
      targetTable: 'users',
      targetId: resolved.userId,
      status: resolved.isPlaceholder ? 'placeholder' : 'mapped',
      matchMethod: resolved.matchMethod,
      isPlaceholder: resolved.isPlaceholder,
      sourceEmail: actor.email ?? null,
      metadata: resolved.metadata,
    });
    const invite =
      resolved.isPlaceholder && this.invitesOn(ctx)
        ? await this.inviteAndRecord(ctx, actor, row)
        : null;

    await ctx.log(
      'info',
      `user ${actor.sourceId} → ${resolved.matchMethod}${resolved.isPlaceholder ? ' (placeholder)' : ''}` +
        (invite ? `, invite ${invite.status}` : ''),
      { target: resolved.userId },
    );

    return { kind: 'created', targetId: resolved.userId, targetTable: 'users' };
  }

  /** Invites the person behind a placeholder crosswalk row and keeps the outcome on that row. */
  private async inviteAndRecord(
    ctx: StageContext,
    actor: UserItemPayload,
    row: MigrationEntityMapRow,
  ): Promise<{ status: string; role?: string; reason?: string }> {
    const invite = await this.invite(ctx, actor, row.target_id);

    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: ctx.run.id,
      entityType: USER_ENTITY,
      sourceId: actor.sourceId,
      sourceKey: row.source_key,
      targetTable: row.target_table,
      targetId: row.target_id,
      status: row.status,
      matchMethod: row.match_method,
      isPlaceholder: row.is_placeholder,
      sourceEmail: row.source_email,
      metadata: { ...row.metadata, invite },
    });

    return invite;
  }

  private invitesOn(ctx: StageContext): boolean {
    return !ctx.dryRun && runOptions(ctx).invite_users === true;
  }

  /**
   * Invites a placeholder's person to the org and mails the link. Never throws: the placeholder mapping is
   * what the rest of the run depends on, and a missing invite can still be sent from the Teams page.
   */
  private async invite(
    ctx: StageContext,
    actor: UserItemPayload,
    placeholderId: string,
  ): Promise<{ status: string; role?: string; reason?: string }> {
    const decision = inviteDecision(actor, actor.jiraAdmin === true);

    if ('skip' in decision) return { status: 'skipped', reason: decision.skip };

    // Supabase Auth stores addresses lower-cased; inviting the same form keeps accept and claim on one row.
    const email = actor.email!.trim().toLowerCase();
    const [firstName, ...rest] = (actor.displayName || email)
      .trim()
      .split(/\s+/);
    const lastName = rest.join(' ');
    const { role } = decision;

    let created: Awaited<ReturnType<InvitationsService['createOrgInvitation']>>;

    try {
      created = await this.invitationsService.createOrgInvitation({
        email,
        firstName,
        lastName,
        organizationId: ctx.orgId,
        role,
        invitedByUserId: requireActingUser(ctx),
      });
    } catch (err) {
      const message = (err as Error).message;

      if (err instanceof BadRequestException && /already sent/i.test(message)) {
        return { status: 'pending', role };
      }
      if (
        err instanceof BadRequestException &&
        /already exists/i.test(message)
      ) {
        return { status: 'skipped', reason: 'already_member' };
      }

      await ctx.log(
        'warn',
        `invite for user ${actor.sourceId} failed: ${message}`,
        {
          target: placeholderId,
        },
      );

      return { status: 'failed', role, reason: message };
    }

    try {
      await this.mailService.sendInvitation(email, {
        invitationLink: created.invitationLink,
        organizationName: created.organizationName,
        firstName,
        lastName,
        role,
        organizationId: ctx.orgId,
      });
    } catch (err) {
      await ctx.log(
        'warn',
        `invite email for user ${actor.sourceId} not sent (resend it from Teams): ${(err as Error).message}`,
        { target: placeholderId },
      );

      return { status: 'mail_failed', role };
    }

    return { status: 'sent', role };
  }
}
