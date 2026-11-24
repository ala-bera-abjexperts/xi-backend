/**
 * @fileoverview `groups` stage — Jira groups → org-scoped `user_groups` + `user_group_members`.
 *
 * ORG-LEVEL BY CONSTRUCTION: Jira groups are instance-wide and `user_groups` has no `space_id`.
 * Runs directly after `users` (members resolve through the `user` crosswalk) and before `roles`
 * (which turns group actors into live `space_members` rows of `member_type: 'group'`).
 *
 * OVER-MIGRATION IS THE FAILURE MODE HERE, not under-mapping — the same lesson
 * `field-type.registry.ts` encodes for fields. A real instance's groups picker returns hundreds of
 * groups with no relationship to the migrated project, and `jira-software-users` routinely contains
 * the entire user base. So by DEFAULT this stage seeds only groups that are ACTORS of the migrated
 * project's roles (free from `getUsersAndRoles().roles[].actors`), which is precisely the set the
 * roles stage needs and nothing else. `scope.include_all_groups` opts into the full picker list.
 *
 * MEMBERS: only users already resolved through the `user` crosswalk are enrolled. Routing an
 * unresolved member through `UserMapper` would mint placeholder `users` rows for the whole
 * instance's population as a side effect of importing one group — an unbounded write triggered by
 * config. Unresolved members are counted and logged, never invented.
 *
 * TENANT SCOPING WARNING for future maintainers: `user_group_members` has NO `organization_id`.
 * Any hand-written query against it must join `user_groups!inner` — the service-role client
 * bypasses RLS, so nothing else stands between two tenants there. This stage only writes through
 * `UserGroupsService`, which scopes by the org-checked group id.
 */

import { ConflictException, Injectable } from '@nestjs/common';
import { UserGroupsService } from '../../../user-groups/user-groups.service';
import { isJiraAdapter } from '../../adapters/source-adapter.interface';
import type { NormalizedGroup } from '../../model/normalized';
import { isResolvedStatus } from './crosswalk-gate.util';
import { runScope } from './stage-helpers';
import {
  MigrationItemError,
  type IStageHandler,
  type ItemOutcome,
  type MigrationRunItemRow,
  type ProduceResult,
  type SeedItem,
  type StageContext,
} from './stage.interface';
import { USER_ENTITY } from './users.stage';

export const GROUPS_STAGE = 'groups';
export const USER_GROUP_ENTITY = 'user_group';

/** Safety ceiling is terminal and visible; it must never turn into a successful truncated group. */
const MAX_MEMBER_PAGES = 10_000;
const MEMBER_PAGE_SIZE = 50;

@Injectable()
export class GroupsStage implements IStageHandler {
  readonly stage = GROUPS_STAGE;

  constructor(private readonly userGroupsService: UserGroupsService) {}

  async produce(ctx: StageContext): Promise<ProduceResult> {
    const adapter = await ctx.getAdapter();

    if (!isJiraAdapter(adapter)) {
      await ctx.log('warn', 'groups stage: non-Jira source — seeding 0');

      return { items: [], nextCheckpoint: null, done: true };
    }

    // Default scope: groups the project's roles actually reference.
    const { roles } = await adapter.getUsersAndRoles(ctx.job.source_ref);
    const byName = new Map<string, NormalizedGroup>();

    for (const role of roles) {
      for (const actor of role.actors) {
        if (actor.type !== 'group' || !actor.sourceId) continue;

        byName.set(actor.sourceId, {
          sourceId: actor.sourceId,
          name: actor.name || actor.sourceId,
        });
      }
    }

    if (runScope(ctx).include_all_groups === true) {
      for (const group of await adapter.listGroups()) {
        if (!byName.has(group.sourceId)) byName.set(group.sourceId, group);
      }
    }

    const items: SeedItem[] = [...byName.values()].map((group) => ({
      entityType: USER_GROUP_ENTITY,
      sourceRef: group.sourceId,
      payload: group as unknown as Record<string, unknown>,
    }));

    if (items.length === 0) {
      await ctx.log(
        'info',
        'groups: no group is an actor of any migrated role — nothing to migrate ' +
          '(set scope.include_all_groups to import the full picker list)',
      );
    }

    return { items, nextCheckpoint: null, done: true };
  }

  async processItem(
    ctx: StageContext,
    item: MigrationRunItemRow,
  ): Promise<ItemOutcome> {
    const group = item.payload as unknown as NormalizedGroup | null;

    if (!group?.sourceId) {
      throw new MigrationItemError(
        'permanent',
        'Group item is missing its payload snapshot',
      );
    }

    const existing = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      USER_GROUP_ENTITY,
      group.sourceId,
    );

    if (existing?.status === 'mapped') {
      return {
        kind: 'skipped',
        reason: 'group already mapped',
        targetId: existing.target_id,
      };
    }

    if (ctx.dryRun) {
      await this.record(ctx, group, `planned:${group.sourceId}`, {
        planned: true,
      });

      return { kind: 'planned' };
    }

    const groupId = await this.adoptOrCreate(ctx, group);
    const members = await this.enrolMembers(ctx, group, groupId);

    await this.record(ctx, group, groupId, members);

    return { kind: 'created', targetId: groupId, targetTable: 'user_groups' };
  }

  /**
   * Adopt by name first — `UNIQUE (organization_id, name)` makes the name the natural key, and a
   * re-run (or a group that already exists in the org for unrelated reasons) must converge on the
   * existing row rather than 409.
   */
  private async adoptOrCreate(
    ctx: StageContext,
    group: NormalizedGroup,
  ): Promise<string> {
    const adopted = await this.findByName(ctx, group.name);

    if (adopted) {
      await ctx.log(
        'info',
        `groups: adopted the existing group "${group.name}"`,
        { group: group.name },
      );

      return adopted;
    }

    try {
      const created = await this.userGroupsService.create(ctx.orgId, {
        name: group.name,
        // Jira groups carry no description/colour/default role — inventing them is over-migration.
      });

      return (created.data as { id: string }).id;
    } catch (err) {
      if (!(err instanceof ConflictException)) throw err;

      // Raced a parallel item between lookup and insert; the winner's row is the right answer.
      const raced = await this.findByName(ctx, group.name);

      if (raced) return raced;

      throw new MigrationItemError(
        'conflict',
        `Group "${group.name}" conflicts but no matching row is readable: ${err.message}`,
      );
    }
  }

  private async findByName(
    ctx: StageContext,
    name: string,
  ): Promise<string | null> {
    const res = await this.userGroupsService.getAll(ctx.orgId);
    const wanted = name.trim().toLowerCase();
    const hit = (res.data as { id: string; name: string }[]).find(
      (g) => (g.name ?? '').trim().toLowerCase() === wanted,
    );

    return hit?.id ?? null;
  }

  /** Page the source membership, enrolling only crosswalk-resolved users. */
  private async enrolMembers(
    ctx: StageContext,
    group: NormalizedGroup,
    groupId: string,
  ): Promise<Record<string, unknown>> {
    const adapter = await ctx.getAdapter();

    if (!isJiraAdapter(adapter)) return { members_added: 0 };

    let added = 0;
    let already = 0;
    let unresolved = 0;
    let placeholdersSkipped = 0;
    const placeholderUserIds: string[] = [];
    let cursor: string | null = null;
    const seenCursors = new Set<string>();

    for (let page = 0; page < MAX_MEMBER_PAGES; page++) {
      const res = await adapter.getGroupMembers(group.sourceId, {
        cursor,
        pageSize: MEMBER_PAGE_SIZE,
      });

      for (const member of res.items) {
        const mapped = await ctx.entityMap.getTarget(
          ctx.orgId,
          ctx.job.connection_id,
          USER_ENTITY,
          member.sourceId,
        );

        if (!mapped || !isResolvedStatus(mapped.status, ctx.dryRun)) {
          unresolved++;

          continue;
        }

        // Placeholders never join member surfaces — same rule as `roles.stage.ts`. A group is a
        // permission container, and granting through a placeholder would hand access to an
        // account nobody can log into today but someone might claim later.
        if (mapped.is_placeholder) {
          placeholdersSkipped++;
          // Granted when the person accepts their invite (InvitationsService.claimPlaceholders).
          placeholderUserIds.push(mapped.target_id);

          continue;
        }

        try {
          await this.userGroupsService.addMember(
            groupId,
            ctx.orgId,
            mapped.target_id,
          );
          added++;
        } catch (err) {
          if (err instanceof ConflictException) {
            already++;

            continue;
          }

          throw err;
        }
      }

      const nextCursor = res.nextCursor;

      if (!nextCursor) break;

      if (nextCursor === cursor || seenCursors.has(nextCursor)) {
        throw new MigrationItemError(
          'permanent',
          `Group "${group.name}" membership repeated cursor "${nextCursor}"`,
        );
      }
      if (page === MAX_MEMBER_PAGES - 1) {
        throw new MigrationItemError(
          'permanent',
          `Group "${group.name}" membership exceeded ${MAX_MEMBER_PAGES} pages`,
        );
      }

      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    if (unresolved > 0) {
      await ctx.log(
        'warn',
        `groups: ${unresolved} member(s) of "${group.name}" are outside this migration's user set — ` +
          `not enrolled (placeholders are never enrolled either)`,
        { group: group.name },
      );
    }

    return {
      members_added: added,
      members_already: already,
      members_unresolved: unresolved,
      placeholders_skipped: placeholdersSkipped,
      placeholder_user_ids: placeholderUserIds,
    };
  }

  private async record(
    ctx: StageContext,
    group: NormalizedGroup,
    targetId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: ctx.run.id,
      entityType: USER_GROUP_ENTITY,
      sourceId: group.sourceId,
      sourceKey: group.name,
      targetTable: 'user_groups',
      targetId,
      status: ctx.dryRun ? 'planned' : 'mapped',
      metadata: { name: group.name, ...metadata },
    });
  }
}
