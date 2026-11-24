/**
 * @fileoverview `issue_types` stage — Jira issue types → the space's task-hierarchy
 * config (`task_hierarchy_configurations.config.levels[]`, ONE JSONB row per space).
 *
 * A SINGLE aggregate work item builds the full `levels[]` and writes it with one
 * `saveConfig` — per-type writes would be a read-modify-write race on one row, and
 * hierarchy edges reference sibling levels. Level `id`s are deduped ASCII slugs
 * (TEXT — the future `tasks.task_type_id`); each Jira type gets its own crosswalk
 * row (`entity_type='issue_type'`, target = level id) for per-type idempotency.
 *
 * Merge, never clobber: an adopted space's existing config keeps its levels; a Jira
 * type whose slug collides with an existing level ADOPTS that level (no duplicate id).
 */

import { Injectable } from '@nestjs/common';
import { TaskHierarchyConfigService } from '../../../task-hierarchy-config/task-hierarchy-config.service';
import type { ITaskTypeLevel } from '../../../task-hierarchy-config/models/task-hierarchy-config.model';
import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import {
  isJiraAdapter,
  type IJiraSourceAdapter,
} from '../../adapters/source-adapter.interface';
import type { NormalizedIssueType } from '../../model/normalized';
import { asciiSlug, dedupeKeys } from '../../util/slug.util';
import {
  blockedOnSpace,
  requireActingUser,
  resolveTargetSpace,
  runScope,
} from './stage-helpers';
import {
  MigrationItemError,
  type IStageHandler,
  type ItemOutcome,
  type MigrationRunItemRow,
  type ProduceResult,
  type StageContext,
} from './stage.interface';

export const ISSUE_TYPES_STAGE = 'issue_types';
export const ISSUE_TYPE_ENTITY = 'issue_type';

const ORG_DEFAULT_STATUS_KEYS = [
  'open',
  'in_progress',
  'review',
  'done',
  'closed',
  'blocked',
];

const HINT_COLORS: Record<string, string> = {
  epic: '#8B5CF6',
  subtask: '#6B7280',
  standard: '#3B82F6',
};

type TypeWithId = NormalizedIssueType & { levelId: string };

interface ObservedTypePair {
  parentLevelId: string;
  childLevelId: string;
}

interface AggregatePayload {
  issueTypes: TypeWithId[];
}

@Injectable()
export class IssueTypeStage implements IStageHandler {
  readonly stage = ISSUE_TYPES_STAGE;

  constructor(
    private readonly hierarchyService: TaskHierarchyConfigService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /** ONE aggregate item — the hierarchy is a single JSONB row per space. */
  async produce(ctx: StageContext): Promise<ProduceResult> {
    const adapter = await ctx.getAdapter();

    if (!isJiraAdapter(adapter)) {
      await ctx.log('warn', 'issue_types stage: non-Jira source — seeding 0');

      return { items: [], nextCheckpoint: null, done: true };
    }

    const issueTypes = await adapter.getIssueTypes(ctx.job.source_ref);
    const ids = dedupeKeys(
      issueTypes,
      (t) => asciiSlug(t.name, 'type', t.sourceId),
      (t) => t.sourceId,
    );

    const typedIssueTypes = issueTypes.map((t) => ({
      ...t,
      levelId: ids.get(t)!,
    }));
    const payload: AggregatePayload = {
      issueTypes: typedIssueTypes,
    };

    return {
      items: [
        {
          entityType: ISSUE_TYPE_ENTITY,
          sourceRef: `hierarchy:${ctx.job.source_ref}`,
          payload: payload as unknown as Record<string, unknown>,
        },
      ],
      nextCheckpoint: null,
      done: true,
    };
  }

  async processItem(
    ctx: StageContext,
    item: MigrationRunItemRow,
  ): Promise<ItemOutcome> {
    const payload = item.payload as unknown as AggregatePayload | null;

    if (!payload?.issueTypes) {
      throw new MigrationItemError(
        'permanent',
        'Issue-type item is missing its payload snapshot',
      );
    }

    if (payload.issueTypes.length === 0) {
      return { kind: 'skipped', reason: 'project has no issue types' };
    }

    const { spaceId, gateOpen } = await resolveTargetSpace(ctx);

    if (!gateOpen) return blockedOnSpace(ctx);

    if (ctx.dryRun) {
      for (const type of payload.issueTypes) {
        await ctx.entityMap.recordMapping({
          orgId: ctx.orgId,
          connectionId: ctx.job.connection_id,
          jobId: ctx.job.id,
          runId: ctx.run.id,
          entityType: ISSUE_TYPE_ENTITY,
          sourceId: type.sourceId,
          sourceKey: type.name,
          targetTable: 'task_hierarchy_configurations',
          targetId: `planned:${type.levelId}`,
          status: 'planned',
          metadata: {
            level_id: type.levelId,
            hint: type.hierarchyHint,
            subtask: type.isSubtask,
          },
        });
      }

      return { kind: 'planned' };
    }

    const adapter = await ctx.getAdapter();
    if (!isJiraAdapter(adapter)) {
      throw new MigrationItemError(
        'permanent',
        'Issue-type hierarchy pre-pass requires a Jira source adapter',
      );
    }
    const observedTypePairs = await this.observedTypePairs(
      adapter,
      ctx,
      payload.issueTypes,
    );

    // Merge with any existing config (adopted space / partial re-run) — never clobber.
    const existingConfig = await this.hierarchyService.getConfig(
      ctx.orgId,
      spaceId!,
    );
    const baseLevels: ITaskTypeLevel[] = existingConfig.isDefault
      ? []
      : [...existingConfig.config.levels];
    const existingIds = new Set(baseLevels.map((l) => l.id));

    const allowedStatuses = await this.migratedStatuses(ctx);
    const newLevels = this.buildLevels(
      payload.issueTypes,
      existingIds,
      allowedStatuses,
      observedTypePairs,
    );
    const combinedLevels = [...baseLevels, ...newLevels];
    const mergedLevels = this.mergeObservedPairsIntoExisting(
      combinedLevels,
      existingIds,
      observedTypePairs,
    );
    const hierarchyChanged = mergedLevels.some(
      (level, index) => level !== combinedLevels[index],
    );

    // Idempotency accounting: which types append vs adopt an existing level id.
    const adopted = payload.issueTypes.filter((t) =>
      existingIds.has(t.levelId),
    );
    const appended = newLevels.length;

    // Full idempotent skip: nothing new to write AND every type is already mapped
    // in the crosswalk → a pure re-run does zero work (clean re-run semantics).
    if (appended === 0 && !hierarchyChanged) {
      const mapped = await ctx.entityMap.getTargets(
        ctx.orgId,
        ctx.job.connection_id,
        ISSUE_TYPE_ENTITY,
        payload.issueTypes.map((t) => t.sourceId),
      );
      const allMapped = payload.issueTypes.every(
        (t) => mapped.get(t.sourceId)?.status === 'mapped',
      );

      if (allMapped) {
        return {
          kind: 'skipped',
          reason: 'all issue types already mapped',
          targetId: `levels:${payload.issueTypes.length}`,
        };
      }
    }

    if (appended > 0 || hierarchyChanged) {
      await this.hierarchyService.saveConfig(
        ctx.orgId,
        spaceId!,
        { version: existingConfig.config.version, levels: mergedLevels },
        requireActingUser(ctx),
        'migration',
      );
    }

    for (const type of payload.issueTypes) {
      await ctx.entityMap.recordMapping({
        orgId: ctx.orgId,
        connectionId: ctx.job.connection_id,
        jobId: ctx.job.id,
        runId: ctx.run.id,
        entityType: ISSUE_TYPE_ENTITY,
        sourceId: type.sourceId,
        sourceKey: type.name,
        targetTable: 'task_hierarchy_configurations',
        targetId: type.levelId,
        status: 'mapped',
        matchMethod:
          existingIds.has(type.levelId) && adopted.includes(type)
            ? 'existing'
            : 'created',
        metadata: {
          level_id: type.levelId,
          hint: type.hierarchyHint,
          subtask: type.isSubtask,
        },
      });
    }

    await ctx.log(
      'info',
      `Hierarchy: ${appended} level(s) written, ${adopted.length} adopted existing`,
      { levels: payload.issueTypes.map((t) => t.levelId) },
    );

    return {
      kind: 'created',
      targetId: `levels:${payload.issueTypes.length}`,
      targetTable: 'task_hierarchy_configurations',
    };
  }

  /** Build fully-explicit levels (ITaskTypeLevel is a z.output type — no field optional). */
  private buildLevels(
    types: TypeWithId[],
    existingIds: Set<string>,
    migratedStatuses: { key: string; category: string | null }[],
    observedTypePairs: ObservedTypePair[],
  ): ITaskTypeLevel[] {
    const fresh = types.filter((t) => !existingIds.has(t.levelId));
    const epics = fresh.filter((t) => t.hierarchyHint === 'epic');
    const subtasks = fresh.filter((t) => t.isSubtask);
    const standards = fresh.filter(
      (t) => !t.isSubtask && t.hierarchyHint !== 'epic',
    );

    const epicIds = epics.map((t) => t.levelId);
    const standardIds = standards.map((t) => t.levelId);
    const subtaskIds = subtasks.map((t) => t.levelId);
    const observedParents = this.indexPairs(
      observedTypePairs,
      'childLevelId',
      'parentLevelId',
    );
    const observedChildren = this.indexPairs(
      observedTypePairs,
      'parentLevelId',
      'childLevelId',
    );

    const allowedStatuses = [
      ...new Set([
        ...ORG_DEFAULT_STATUS_KEYS,
        ...migratedStatuses.map((s) => s.key),
      ]),
    ];

    // The status this run migrated for Jira's "new" category. On a German instance that is
    // `zu_erledigen`, not the seeded English `open` — without this every task created in the
    // migrated space afterwards silently falls back to a status the migration did not bring.
    const defaultStatus =
      migratedStatuses.find((s) => s.category === 'new')?.key ?? 'open';

    const makeLevel = (
      type: TypeWithId,
      sortOrder: number,
      parents: string[],
      children: string[],
    ): ITaskTypeLevel => ({
      id: type.levelId,
      name: type.name || type.levelId,
      name_i18n: {},
      description: type.description?.slice(0, 500) || null,
      description_i18n: {},
      icon: null,
      color:
        HINT_COLORS[type.hierarchyHint ?? 'standard'] ?? HINT_COLORS.standard,
      text_color: '#FFFFFF',
      parent_level_id: null,
      allowed_parent_types: this.appendToRestrictedRule(
        parents,
        observedParents.get(type.levelId) ?? [],
      ),
      allowed_child_types: this.appendToRestrictedRule(
        children,
        observedChildren.get(type.levelId) ?? [],
      ),
      max_depth: 10,
      default_status: defaultStatus,
      // `default_priority` stays 'medium': the priorities stage now ALIASES a localized name onto
      // the seeded key, so `medium` exists in a German space too, and Jira exposes no
      // default-priority concept to migrate. Deriving one would be an invented correspondence.
      default_priority: 'medium',
      field_group_ids: [],
      allowed_statuses: allowedStatuses,
      sort_order: sortOrder,
      is_active: true,
    });

    let sort = 0;
    const levels: ITaskTypeLevel[] = [];

    for (const epic of epics) {
      levels.push(makeLevel(epic, sort++, [], standardIds));
    }

    for (const standard of standards) {
      levels.push(makeLevel(standard, sort++, epicIds, subtaskIds));
    }

    for (const subtask of subtasks) {
      levels.push(makeLevel(subtask, sort++, standardIds, []));
    }

    return levels;
  }

  /**
   * Scan the complete scoped issue stream before seeding the aggregate hierarchy item.
   * Parent types are resolved only after the scan because a parent may arrive after its child.
   */
  private async observedTypePairs(
    adapter: IJiraSourceAdapter,
    ctx: StageContext,
    issueTypes: TypeWithId[],
  ): Promise<ObservedTypePair[]> {
    const issueTypeByIssue = new Map<string, string>();
    const parentReferences: { childIssueId: string; parentIssueId: string }[] =
      [];
    const scope = runScope(ctx);

    for await (const page of adapter.iterateIssues(ctx.job.source_ref, {
      fields: ['issuetype', 'parent'],
      ...(scope.jql ? { jql: scope.jql } : {}),
    })) {
      for (const issue of page.items) {
        issueTypeByIssue.set(issue.sourceId, issue.issueTypeSourceId);
        if (issue.parentSourceId) {
          parentReferences.push({
            childIssueId: issue.sourceId,
            parentIssueId: issue.parentSourceId,
          });
        }
      }
    }

    const levelBySourceType = new Map(
      issueTypes.map((type) => [type.sourceId, type.levelId]),
    );
    const pairs: ObservedTypePair[] = [];
    const seen = new Set<string>();

    for (const reference of parentReferences) {
      const parentLevelId = levelBySourceType.get(
        issueTypeByIssue.get(reference.parentIssueId) ?? '',
      );
      const childLevelId = levelBySourceType.get(
        issueTypeByIssue.get(reference.childIssueId) ?? '',
      );

      if (!parentLevelId || !childLevelId) continue;

      const key = `${parentLevelId}\u0000${childLevelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ parentLevelId, childLevelId });
    }

    return pairs;
  }

  /** Existing empty arrays are wildcards; adding one observed id would narrow them. */
  private mergeObservedPairsIntoExisting(
    levels: ITaskTypeLevel[],
    existingIds: Set<string>,
    observedTypePairs: ObservedTypePair[],
  ): ITaskTypeLevel[] {
    const observedParents = this.indexPairs(
      observedTypePairs,
      'childLevelId',
      'parentLevelId',
    );
    const observedChildren = this.indexPairs(
      observedTypePairs,
      'parentLevelId',
      'childLevelId',
    );

    return levels.map((level) => {
      if (!existingIds.has(level.id)) return level;

      const parents = this.appendToRestrictedRule(
        level.allowed_parent_types,
        observedParents.get(level.id) ?? [],
      );
      const children = this.appendToRestrictedRule(
        level.allowed_child_types,
        observedChildren.get(level.id) ?? [],
      );

      return parents === level.allowed_parent_types &&
        children === level.allowed_child_types
        ? level
        : {
            ...level,
            allowed_parent_types: parents,
            allowed_child_types: children,
          };
    });
  }

  private indexPairs(
    pairs: ObservedTypePair[],
    key: keyof ObservedTypePair,
    value: keyof ObservedTypePair,
  ): Map<string, string[]> {
    const indexed = new Map<string, string[]>();

    for (const pair of pairs) {
      const values = indexed.get(pair[key]) ?? [];
      if (!values.includes(pair[value])) {
        indexed.set(pair[key], [...values, pair[value]]);
      }
    }

    return indexed;
  }

  private appendToRestrictedRule(
    existing: string[],
    observed: string[],
  ): string[] {
    return existing.length === 0
      ? existing
      : this.appendUnique(existing, observed);
  }

  private appendUnique(existing: string[], additions: string[]): string[] {
    const fresh = additions.filter((id) => !existing.includes(id));

    return fresh.length === 0 ? existing : [...existing, ...fresh];
  }

  /**
   * Space statuses already crosswalked this run: keys union into `allowed_statuses`, and the
   * `new`-category one supplies `default_status` so a migrated space defaults to its OWN starting
   * status rather than the seeded English `open`.
   */
  private async migratedStatuses(
    ctx: StageContext,
  ): Promise<{ key: string; category: string | null }[]> {
    const { data: items, error: itemsError } = (await this.db
      .from('migration_run_items')
      .select('target_id, payload')
      .eq('organization_id', ctx.orgId)
      .eq('run_id', ctx.run.id)
      .eq('stage', 'task_statuses')
      .eq('entity_type', 'task_status')
      .eq('item_kind', 'entity')
      .in('status', ['succeeded', 'skipped'])) as {
      data:
        | {
            target_id: string | null;
            payload: Record<string, unknown> | null;
          }[]
        | null;
      error: { message: string } | null;
    };

    if (itemsError) {
      throw new MigrationItemError(
        'transient',
        `Current-run status lookup failed: ${itemsError.message}`,
      );
    }

    if ((items ?? []).some((row) => !row.target_id)) {
      throw new MigrationItemError(
        'permanent',
        'A completed task-status item has no target status',
      );
    }

    const targetIds = [...new Set((items ?? []).map((row) => row.target_id!))];

    if (targetIds.length === 0) return [];

    const { data: statuses, error: statusesError } = (await this.db
      .from('task_statuses')
      .select('id, key')
      .eq('organization_id', ctx.orgId)
      .in('id', targetIds)) as {
      data: { id: string; key: string | null }[] | null;
      error: { message: string } | null;
    };

    if (statusesError) {
      throw new MigrationItemError(
        'transient',
        `Target status lookup failed: ${statusesError.message}`,
      );
    }

    const statusById = new Map(
      (statuses ?? []).map((status) => [status.id, status.key]),
    );

    return (items ?? []).map((item) => {
      const key = statusById.get(item.target_id!);

      if (!key) {
        throw new MigrationItemError(
          'permanent',
          `Completed task-status target "${item.target_id}" no longer exists`,
        );
      }

      return {
        key,
        category:
          typeof item.payload?.statusCategory === 'string'
            ? item.payload.statusCategory
            : null,
      };
    });
  }
}
