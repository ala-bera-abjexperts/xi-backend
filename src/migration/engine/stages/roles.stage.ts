/**
 * @fileoverview `roles` stage — Jira project roles → space membership.
 *
 * `space_members.space_role` is CHECK-constrained to owner|admin|member|viewer, so
 * well-known Jira roles map onto those (Administrators → admin, everything else →
 * member). Actors: real matched users become space members; PLACEHOLDER users are
 * deliberately NOT added (they must stay invisible to member surfaces) but recorded in this
 * role's crosswalk (`placeholder_user_ids` + `space_id`) so accepting an invite grants the role
 * then (InvitationsService.claimPlaceholders); group actors
 * become LIVE group memberships (`member_type: 'group'`) through the `user_group`
 * crosswalk the `groups` stage writes — never flattened into individual users.
 */

import { ConflictException, Injectable } from '@nestjs/common';
import { SpacesService } from '../../../spaces/spaces.service';
import { isJiraAdapter } from '../../adapters/source-adapter.interface';
import type { NormalizedRole } from '../../model/normalized';
import {
  blockedOnSpace,
  requireActingUser,
  resolveTargetSpace,
} from './stage-helpers';
import {
  MigrationItemError,
  type IStageHandler,
  type ItemOutcome,
  type MigrationRunItemRow,
  type ProduceResult,
  type StageContext,
} from './stage.interface';
import { mapSpaceRole } from './space-role.util';

export const ROLES_STAGE = 'roles';
export const ROLE_ENTITY = 'role';

@Injectable()
export class RolesStage implements IStageHandler {
  readonly stage = ROLES_STAGE;

  constructor(private readonly spacesService: SpacesService) {}

  async produce(ctx: StageContext): Promise<ProduceResult> {
    const adapter = await ctx.getAdapter();

    if (!isJiraAdapter(adapter)) {
      await ctx.log('warn', 'roles stage: non-Jira source — seeding 0 roles');

      return { items: [], nextCheckpoint: null, done: true };
    }

    const { roles } = await adapter.getUsersAndRoles(ctx.job.source_ref);

    return {
      items: roles.map((role) => ({
        entityType: ROLE_ENTITY,
        // PROJECT-SCOPED on purpose. Jira role IDS are instance-wide ("Administrators" is 10002 on
        // every project), but a role's MATERIALIZATION — the space_members rows it produces — is
        // per space. Keyed on the bare id, the first project to migrate marks the role "done" for
        // the whole CONNECTION, and every later project's roles stage skips without writing a
        // single member. Observed live: KAN's Administrators skipped because SDP had mapped 10002.
        sourceRef: `${ctx.job.source_ref}:${role.sourceId}`,
        payload: role as unknown as Record<string, unknown>,
      })),
      nextCheckpoint: null,
      done: true,
    };
  }

  async processItem(
    ctx: StageContext,
    item: MigrationRunItemRow,
  ): Promise<ItemOutcome> {
    const role = item.payload as unknown as NormalizedRole | null;

    if (!role?.sourceId) {
      throw new MigrationItemError(
        'permanent',
        'Role item is missing its payload snapshot',
      );
    }

    // Same scoped identity as produce — see the comment there.
    const crosswalkId = `${ctx.job.source_ref}:${role.sourceId}`;

    const existing = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      ROLE_ENTITY,
      crosswalkId,
    );

    if (existing) {
      if (existing.status === 'mapped') {
        return {
          kind: 'skipped',
          reason: 'role already mapped',
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

    const { spaceId, gateOpen } = await resolveTargetSpace(ctx);

    if (!gateOpen) return blockedOnSpace(ctx);

    const { role: spaceRole, matched: roleNameMatched } = mapSpaceRole(
      role.name,
    );

    if (!roleNameMatched) {
      // Info, not warn: "Entwickler → member" is the correct outcome. The line exists so that an
      // unrecognized ADMINISTRATOR name in a new locale is discoverable from the run log instead of
      // from a customer noticing their admins have no admin rights.
      await ctx.log(
        'info',
        `roles: "${role.name}" is not a recognized administrator role — its members join as "member"`,
      );
    }
    const userActors = role.actors.filter((a) => a.type === 'user');
    const groupActors = role.actors.filter((a) => a.type === 'group');

    if (ctx.dryRun) {
      await ctx.entityMap.recordMapping({
        orgId: ctx.orgId,
        connectionId: ctx.job.connection_id,
        jobId: ctx.job.id,
        runId: ctx.run.id,
        entityType: ROLE_ENTITY,
        sourceId: crosswalkId,
        sourceKey: role.name,
        targetTable: 'space_members',
        targetId: `planned:${spaceRole}`,
        status: 'planned',
        metadata: {
          space_role: spaceRole,
          user_actors: userActors.length,
          group_actors: groupActors.length,
        },
      });

      return { kind: 'planned' };
    }

    const actingUser = requireActingUser(ctx);

    let added = 0;
    let skippedPlaceholders = 0;
    const placeholderUserIds: string[] = [];
    let unresolved = 0;

    for (const actor of userActors) {
      const mapped = await ctx.entityMap.getTarget(
        ctx.orgId,
        ctx.job.connection_id,
        'user',
        actor.sourceId,
      );

      if (!mapped || mapped.status === 'planned') {
        unresolved++;
        await ctx.log(
          'warn',
          `role ${role.name}: actor ${actor.sourceId} not in user crosswalk`,
        );
        continue;
      }

      // Placeholders never become members — they must stay invisible to member surfaces.
      if (mapped.is_placeholder) {
        skippedPlaceholders++;
        placeholderUserIds.push(mapped.target_id);
        continue;
      }

      try {
        await this.spacesService.addSpaceMember(
          spaceId!,
          ctx.orgId,
          actingUser,
          {
            member_type: 'user',
            user_id: mapped.target_id,
            space_role: spaceRole,
          },
        );
        added++;
      } catch (err) {
        if (err instanceof ConflictException) continue; // already a member — fine

        throw err;
      }
    }

    // Group actors join as GROUPS (`member_type: 'group'`), not as their flattened membership.
    // The distinction is live behaviour, not bookkeeping: adding a user to the XISUITE group later
    // grants them this space, which is what the Jira role actually meant. Flattening would freeze
    // today's membership and silently stop tracking the group.
    //
    // A group missing from the crosswalk degrades to a warn, NEVER `blocked`: the groups stage may
    // legitimately not have migrated it (permissions, truncated picker), and a role must not stall
    // a run over an unmigratable actor.
    let groupsAdded = 0;
    let groupsUnresolved = 0;

    for (const group of groupActors) {
      const mapped = await ctx.entityMap.getTarget(
        ctx.orgId,
        ctx.job.connection_id,
        'user_group',
        group.sourceId,
      );

      if (!mapped || mapped.status !== 'mapped') {
        groupsUnresolved++;
        await ctx.log(
          'warn',
          `role ${role.name}: group actor "${group.name}" is not in the group crosswalk — skipped`,
        );

        continue;
      }

      try {
        await this.spacesService.addSpaceMember(
          spaceId!,
          ctx.orgId,
          actingUser,
          {
            member_type: 'group',
            group_id: mapped.target_id,
            space_role: spaceRole,
          },
        );
        groupsAdded++;
      } catch (err) {
        if (err instanceof ConflictException) continue; // already a member — fine

        throw err;
      }
    }

    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: ctx.run.id,
      entityType: ROLE_ENTITY,
      sourceId: crosswalkId,
      sourceKey: role.name,
      targetTable: 'space_members',
      targetId: spaceRole,
      status: 'mapped',
      metadata: {
        space_role: spaceRole,
        space_id: spaceId,
        members_added: added,
        placeholders_skipped: skippedPlaceholders,
        placeholder_user_ids: placeholderUserIds,
        actors_unresolved: unresolved,
        groups_added: groupsAdded,
        groups_unresolved: groupsUnresolved,
      },
    });

    return {
      kind: 'created',
      targetId: spaceRole,
      targetTable: 'space_members',
    };
  }
}
