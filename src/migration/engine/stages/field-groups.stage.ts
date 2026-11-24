/**
 * @fileoverview `field_groups` stage — reproduces the SOURCE's field layout as XISUITE field
 * groups and assigns them to every migrated task-type level, so the fields actually SURFACE on a
 * task form. Without the level assignment the fields exist but are invisible: a migration that
 * looks successful and shows the user nothing.
 *
 * Groups come from Jira SCREEN TABS (`adapter.getScreens`), which are Jira's own field grouping —
 * a project laid out as "Planning / Delivery / Stakeholders" arrives that way. This used to invent
 * one catch-all group and never read the source at all, so the customer's layout was discarded.
 * `resolveGroups` falls back to that single group when no usable tabs exist.
 *
 * ONE aggregate item: groups and their membership are a single logical write, so per-field items
 * would race N writers onto one group. `addFieldsToGroupBatch` is used over `addFieldToGroup`
 * because the batch variant self-filters duplicates and returns `[]` instead of throwing 409 —
 * i.e. it is idempotent, which a resumable engine requires.
 *
 * Identifier trap: `AddFieldToGroupDto.custom_field_id` is validated against `custom_fields.id`
 * (field-groups.service.ts:489), but the crosswalk's `target_id` is the TEXT `field_key`. The UUID
 * therefore comes from `metadata.custom_field_id`, which the custom_fields stage stashes.
 */

import { ConflictException, Injectable } from '@nestjs/common';
import { FieldGroupsService } from '../../../custom-fields/field-groups.service';
import { isJiraAdapter } from '../../adapters/source-adapter.interface';
import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import type { MigrationEntityMapRow } from '../../services/migration-entity-map.service';
import { CUSTOM_FIELD_ENTITY } from './custom-fields.stage';
import { ISSUE_TYPE_ENTITY } from './issue-type.stage';
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

export const FIELD_GROUPS_STAGE = 'field_groups';
export const FIELD_GROUP_ENTITY = 'field_group';

const GROUP_NAME = 'Migrated Custom Fields';

@Injectable()
export class FieldGroupsStage implements IStageHandler {
  readonly stage = FIELD_GROUPS_STAGE;

  constructor(
    private readonly fieldGroupsService: FieldGroupsService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * ONE aggregate item — the group and its membership are a single logical write. Nothing to await:
   * the item is derived purely from the job, and the crosswalk reads happen in processItem where
   * the space gate is resolved.
   */
  produce(ctx: StageContext): Promise<ProduceResult> {
    return Promise.resolve({
      items: [
        {
          entityType: FIELD_GROUP_ENTITY,
          sourceRef: `fieldgroup:${ctx.job.source_ref}`,
        },
      ],
      nextCheckpoint: null,
      done: true,
    });
  }

  async processItem(
    ctx: StageContext,
    item: MigrationRunItemRow,
  ): Promise<ItemOutcome> {
    const { spaceId, gateOpen } = await resolveTargetSpace(ctx);

    if (!gateOpen) return blockedOnSpace(ctx);

    // Fields the custom_fields stage actually CREATED. `native`/`skip` rows carry no
    // custom_field_id, so they filter out here by construction.
    // The crosswalk is per CONNECTION and Jira field ids are site-wide, so it also holds every
    // other project's fields. Only the fields this run's project reports belong in its group.
    const runFieldIds = await this.runSourceRefs(ctx, CUSTOM_FIELD_ENTITY);
    const fieldRows = (await this.listMapped(ctx, CUSTOM_FIELD_ENTITY)).filter(
      (row) => runFieldIds.has(row.source_id),
    );
    const customFieldIdBySourceId = new Map<string, string>();

    for (const row of fieldRows) {
      const id = row.metadata?.custom_field_id;

      if (typeof id === 'string' && id.length > 0) {
        customFieldIdBySourceId.set(row.source_id, id);
      }
    }

    // A crosswalk row can outlive its custom_fields row (deleted after an earlier run), and
    // addFieldsToGroupBatch rejects the WHOLE batch on one missing id — so drop the stale ones.
    if (!ctx.dryRun) await this.dropStaleFields(ctx, customFieldIdBySourceId);

    const fieldIds = [...customFieldIdBySourceId.values()];

    if (fieldIds.length === 0) {
      // The common case on the test data: 13 custom fields, all plugin-internal → all excluded.
      // An empty group assigned to every level would be user-visible clutter for zero content.
      return {
        kind: 'skipped',
        reason: 'no custom fields were migrated — nothing to group',
      };
    }

    // Same scoping for levels: `level_field_group_assignments` has no space column and keys on the
    // level slug, so assigning another project's level would surface this group in THAT space.
    const spaceLevels = ctx.dryRun
      ? null
      : await this.spaceLevelIds(ctx, spaceId!);
    const levelIds = (await this.listMapped(ctx, ISSUE_TYPE_ENTITY))
      .map((r) => r.target_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .filter((id) => !spaceLevels || spaceLevels.has(id));

    if (ctx.dryRun) {
      await ctx.entityMap.recordMapping({
        orgId: ctx.orgId,
        connectionId: ctx.job.connection_id,
        jobId: ctx.job.id,
        runId: ctx.run.id,
        entityType: FIELD_GROUP_ENTITY,
        sourceId: item.source_ref ?? `fieldgroup:${ctx.job.source_ref}`,
        sourceKey: GROUP_NAME,
        targetTable: 'field_groups',
        targetId: `planned:${GROUP_NAME}`,
        status: 'planned',
        metadata: {
          field_count: fieldIds.length,
          level_count: levelIds.length,
        },
      });

      return { kind: 'planned' };
    }

    const actor = requireActingUser(ctx);
    const planned = await this.resolveGroups(ctx, customFieldIdBySourceId);
    let assigned = 0;

    for (const spec of planned) {
      const group = await this.getOrCreateGroup(
        ctx,
        spaceId!,
        actor,
        spec.name,
      );

      // Idempotent: returns [] for members already present rather than throwing.
      await this.fieldGroupsService.addFieldsToGroupBatch(
        group.id,
        spec.fieldIds.map((id, i) => ({ custom_field_id: id, sort_order: i })),
        ctx.orgId,
        actor,
      );

      for (const levelId of levelIds) {
        try {
          await this.fieldGroupsService.assignGroupToLevel(
            ctx.orgId,
            {
              type: 'group',
              hierarchy_level_id: levelId,
              entity_type: 'task',
              field_group_id: group.id,
            },
            actor,
          );
          assigned += 1;
        } catch (err) {
          // 409 = already assigned (a resumed or repeated run). Anything else is real.
          if (!(err instanceof ConflictException)) throw err;
        }
      }

      await ctx.entityMap.recordMapping({
        orgId: ctx.orgId,
        connectionId: ctx.job.connection_id,
        jobId: ctx.job.id,
        runId: ctx.run.id,
        entityType: FIELD_GROUP_ENTITY,
        sourceId: spec.sourceId,
        sourceKey: spec.name,
        targetTable: 'field_groups',
        targetId: group.id,
        status: 'mapped',
        metadata: {
          field_count: spec.fieldIds.length,
          level_count: levelIds.length,
          from_source_tab: spec.fromSourceTab,
        },
      });
    }

    await ctx.log(
      'info',
      `field_groups: created ${planned.length} group(s) from ` +
        `${planned[0]?.fromSourceTab ? 'the source screen tabs' : 'a single fallback group'}`,
    );

    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: ctx.run.id,
      entityType: FIELD_GROUP_ENTITY,
      sourceId: item.source_ref ?? `fieldgroup:${ctx.job.source_ref}`,
      sourceKey: `${planned.length} group(s)`,
      targetTable: 'field_groups',
      targetId: `groups:${planned.length}`,
      status: 'mapped',
      metadata: {
        field_count: fieldIds.length,
        level_count: levelIds.length,
        newly_assigned: assigned,
        group_names: planned.map((g) => g.name),
      },
    });

    return {
      kind: 'created',
      targetId: `groups:${planned.length}`,
      targetTable: 'field_groups',
    };
  }

  /**
   * The groups to create, mirroring the SOURCE's own field layout.
   *
   * A Jira screen TAB is the closest analogue to an XISUITE field group, so a project laid out as
   * "Planning / Delivery / Stakeholders" arrives that way instead of collapsing into one
   * undifferentiated list. Only tabs that actually contribute a migrated custom field become
   * groups: screens carry system fields (`summary`, `priority`, ...) and plugin-internal fields
   * that never became XISUITE custom fields, and a group full of nothing is worse than no group.
   *
   * Falls back to the original single "Migrated Custom Fields" group whenever the source exposes no
   * usable tabs (Cloud without admin scope, a project whose screens are unreadable, or a layout
   * where every tab is system-only). Fields the tabs do not mention are appended to the LAST group
   * so nothing silently disappears from the form.
   */
  private async resolveGroups(
    ctx: StageContext,
    customFieldIdBySourceId: Map<string, string>,
  ): Promise<
    {
      sourceId: string;
      name: string;
      fieldIds: string[];
      fromSourceTab: boolean;
    }[]
  > {
    const fallback = [
      {
        sourceId: `fieldgroup:${ctx.job.source_ref}`,
        name: GROUP_NAME,
        fieldIds: [...customFieldIdBySourceId.values()],
        fromSourceTab: false,
      },
    ];

    const adapter = await ctx.getAdapter();

    if (!isJiraAdapter(adapter)) return fallback;

    const screens = await adapter.getScreens(ctx.job.source_ref);
    for (const screen of screens) {
      for (const warning of screen.migrationWarnings ?? []) {
        await ctx.log('warn', `field_groups: ${warning}`, {
          sourceId: screen.sourceId,
        });
      }
    }
    const groups: {
      sourceId: string;
      name: string;
      fieldIds: string[];
      fromSourceTab: boolean;
    }[] = [];
    const placed = new Set<string>();

    // Richest layout first. A field can appear on SEVERAL screens (a project typically has a
    // default screen and a bug screen), and whichever screen is visited first claims it — so
    // without this ordering an arbitrary single-tab screen wins and flattens the whole layout.
    // Verified live: the one-tab "SDP: Scrum Bug Screen" swallowed all 23 fields and the
    // four-tab default screen (Planning / Delivery / Stakeholders) contributed nothing.
    // A screen with one tab expresses no grouping at all, so it must never outrank a multi-tab one.
    const byRichestLayout = [...screens].sort(
      (a, b) => b.tabs.length - a.tabs.length,
    );

    for (const screen of byRichestLayout) {
      for (const tab of screen.tabs) {
        const fieldIds: string[] = [];

        for (const fieldSourceId of tab.fieldSourceIds) {
          const customFieldId = customFieldIdBySourceId.get(fieldSourceId);

          // A field lives on ONE tab per screen, but two SCREENS can both show it. First tab wins,
          // otherwise the field would be duplicated across groups on the same form.
          if (customFieldId && !placed.has(customFieldId)) {
            placed.add(customFieldId);
            fieldIds.push(customFieldId);
          }
        }

        if (fieldIds.length > 0) {
          groups.push({
            sourceId: `fieldgroup:tab:${tab.sourceId}`,
            name: tab.name,
            fieldIds,
            fromSourceTab: true,
          });
        }
      }
    }

    if (groups.length === 0) return fallback;

    const unplaced = [...customFieldIdBySourceId.values()].filter(
      (id) => !placed.has(id),
    );

    if (unplaced.length > 0) {
      groups[groups.length - 1].fieldIds.push(...unplaced);
    }

    return groups;
  }

  /**
   * Adopt-or-create. `create` has no natural unique key to 409 on, so a blind create on a resumed
   * run would silently mint a SECOND "Migrated Custom Fields" group — check first.
   */
  private async getOrCreateGroup(
    ctx: StageContext,
    spaceId: string,
    actor: string,
    name: string,
  ): Promise<{ id: string }> {
    const existing = await this.findGroup(ctx.orgId, spaceId, name);

    if (existing) return existing;

    try {
      return await this.fieldGroupsService.create(ctx.orgId, actor, {
        name,
        space_id: spaceId,
        description: 'Custom fields imported by the Atlassian migration.',
      });
    } catch (err) {
      if (!(err instanceof ConflictException)) throw err;

      const raced = await this.findGroup(ctx.orgId, spaceId, name);

      if (!raced) {
        throw new MigrationItemError(
          'conflict',
          `Field group "${name}" conflicts but is not readable: ${err.message}`,
        );
      }

      return raced;
    }
  }

  private async findGroup(
    orgId: string,
    spaceId: string,
    name: string,
  ): Promise<{ id: string } | null> {
    const { data, error } = (await this.db
      .from('field_groups')
      .select('id')
      .eq('organization_id', orgId)
      .eq('space_id', spaceId)
      .eq('name', name)
      .or('is_deleted.is.null,is_deleted.eq.false')
      .maybeSingle()) as {
      data: { id: string } | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new MigrationItemError(
        'transient',
        `Field-group lookup failed: ${error.message}`,
      );
    }

    return data;
  }

  /**
   * Removes (in place) every mapping whose `custom_fields` row no longer exists in this org.
   * Same existence check `addFieldsToGroupBatch` applies, so what survives here will not throw there.
   */
  private async dropStaleFields(
    ctx: StageContext,
    customFieldIdBySourceId: Map<string, string>,
  ): Promise<void> {
    const ids = [...customFieldIdBySourceId.values()];
    const live = new Set<string>();

    for (let offset = 0; offset < ids.length; offset += 200) {
      const { data, error } = (await this.db
        .from('custom_fields')
        .select('id')
        .eq('organization_id', ctx.orgId)
        .in('id', ids.slice(offset, offset + 200))) as {
        data: { id: string }[] | null;
        error: { message: string } | null;
      };

      if (error) {
        throw new MigrationItemError(
          'transient',
          `Custom-field existence check failed: ${error.message}`,
        );
      }

      for (const row of data ?? []) live.add(row.id);
    }

    const staleSourceIds = [...customFieldIdBySourceId]
      .filter(([, id]) => !live.has(id))
      .map(([sourceId]) => sourceId);

    if (staleSourceIds.length === 0) return;

    for (const sourceId of staleSourceIds) {
      customFieldIdBySourceId.delete(sourceId);
    }

    await ctx.log(
      'warn',
      `field_groups: ignored ${staleSourceIds.length} stale custom-field mapping(s) ` +
        'whose custom field no longer exists',
      { sourceIds: staleSourceIds },
    );
  }

  /**
   * Every `mapped` crosswalk row of one entity type for this connection. The service exposes only
   * keyed lookups (`getTarget`/`getTargets` need source ids we don't hold here), so this queries
   * directly — hand-scoped by organization_id, because the service-role client bypasses RLS.
   */
  /** Source ids of the entity items seeded in THIS run. */
  private async runSourceRefs(
    ctx: StageContext,
    entityType: string,
  ): Promise<Set<string>> {
    const { data, error } = (await this.db
      .from('migration_run_items')
      .select('source_ref')
      .eq('organization_id', ctx.orgId)
      .eq('run_id', ctx.run.id)
      .eq('entity_type', entityType)
      .eq('item_kind', 'entity')) as {
      data: { source_ref: string | null }[] | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new MigrationItemError(
        'transient',
        `Run item list failed for "${entityType}": ${error.message}`,
      );
    }

    return new Set(
      (data ?? [])
        .map((r) => r.source_ref)
        .filter((ref): ref is string => !!ref),
    );
  }

  /** Level ids in the target space's hierarchy config (empty when it has none). */
  private async spaceLevelIds(
    ctx: StageContext,
    spaceId: string,
  ): Promise<Set<string>> {
    const { data, error } = (await this.db
      .from('task_hierarchy_configurations')
      .select('config')
      .eq('organization_id', ctx.orgId)
      .eq('space_id', spaceId)
      .limit(1)) as {
      data: { config: { levels?: { id?: unknown }[] } | null }[] | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new MigrationItemError(
        'transient',
        `Hierarchy lookup failed: ${error.message}`,
      );
    }

    return new Set(
      (data?.[0]?.config?.levels ?? [])
        .map((level) => level.id)
        .filter((id): id is string => typeof id === 'string'),
    );
  }

  private async listMapped(
    ctx: StageContext,
    entityType: string,
  ): Promise<MigrationEntityMapRow[]> {
    const { data, error } = (await this.db
      .from('migration_entity_map')
      .select('*')
      .eq('organization_id', ctx.orgId)
      .eq('source_connection_id', ctx.job.connection_id)
      .eq('entity_type', entityType)
      .eq('status', 'mapped')) as {
      data: MigrationEntityMapRow[] | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new MigrationItemError(
        'transient',
        `Crosswalk list failed for "${entityType}": ${error.message}`,
      );
    }

    return data ?? [];
  }
}
