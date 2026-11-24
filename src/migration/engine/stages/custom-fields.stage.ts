/**
 * @fileoverview `custom_fields` stage — Jira fields → space-scoped `custom_fields` rows.
 *
 * Every field the source reports is seeded as an item, and `mapField()` is the SINGLE decision
 * point for what happens to it (three-way: `custom_field` | `native` | `skip`). Producing only the
 * "interesting" fields would duplicate the exclusion logic here and leave no record of the ones we
 * chose to drop — so all three outcomes are crosswalked, and `metadata.outcome` says which.
 *
 * Why exclusion matters: a live census of the Jira 8.22.4 box found 13 custom fields, EVERY one
 * plugin-internal plumbing (`gh-*`, `jpo-*`, devsummary, teams) and zero user-defined. Migrating
 * `custom:*` indiscriminately would manufacture bogus "Sprint"/"Epic Link"/"Rank" fields that
 * duplicate native concepts and collide with the boards/sprints phase. Over-migration is the real
 * failure mode on this data — not under-mapping.
 *
 * The crosswalk `target_id` is the TEXT `field_key`, but `FieldGroupsService.addFieldsToGroupBatch`
 * needs the row UUID — so the UUID is stashed in `metadata.custom_field_id` for the field_groups
 * stage to read. (`AddFieldToGroupDto.custom_field_id` is validated against `custom_fields.id`;
 * handing it a field_key yields NotFound/22P02.)
 */

import { ConflictException, Injectable } from '@nestjs/common';
import { CustomFieldsService } from '../../../custom-fields/custom-fields.service';
import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import { isJiraAdapter } from '../../adapters/source-adapter.interface';
import { mapField } from '../../mappers/field-type.registry';
import type { NormalizedField } from '../../model/normalized';
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

export const CUSTOM_FIELDS_STAGE = 'custom_fields';
export const CUSTOM_FIELD_ENTITY = 'custom_field';

@Injectable()
export class CustomFieldsStage implements IStageHandler {
  readonly stage = CUSTOM_FIELDS_STAGE;

  constructor(
    private readonly customFieldsService: CustomFieldsService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Fields are reported per issue type by createmeta, so the same field id recurs across types.
   * Seed ONE item per distinct field, unioning the issue types it appears on — a per-(type,field)
   * item would race N writers onto one `field_key` and 409 all but the first.
   */
  async produce(ctx: StageContext): Promise<ProduceResult> {
    const adapter = await ctx.getAdapter();

    if (!isJiraAdapter(adapter)) {
      await ctx.log('warn', 'custom_fields stage: non-Jira source — seeding 0');

      return { items: [], nextCheckpoint: null, done: true };
    }

    const issueTypes = await adapter.getIssueTypes(ctx.job.source_ref);
    const bySourceId = new Map<string, NormalizedField>();

    for (const type of issueTypes) {
      const fields = await adapter.getFieldsForIssueType(
        ctx.job.source_ref,
        type.sourceId,
      );

      for (const field of fields) {
        const existing = bySourceId.get(field.sourceId);

        if (!existing) {
          bySourceId.set(field.sourceId, { ...field });

          continue;
        }

        // Union the issue types; keep the first field definition otherwise. A field can be
        // required on one type and optional on another — required-anywhere wins, since a
        // migrated value must never be rejected by a stricter target rule.
        existing.issueTypeSourceIds = Array.from(
          new Set([
            ...(existing.issueTypeSourceIds ?? []),
            ...(field.issueTypeSourceIds ?? []),
          ]),
        );
        existing.required = existing.required || field.required;

        // Prefer whichever definition actually carries options — createmeta omits allowedValues
        // on types where the field is not editable.
        if (!existing.allowedValues?.length && field.allowedValues?.length) {
          existing.allowedValues = field.allowedValues;
        }
      }
    }

    // One admin-endpoint read decides which fields are GLOBAL on the source. The rule is "never
    // promote on ambiguity": org scope requires the context response to CONTAIN the field AND list
    // zero projects. An unreadable endpoint yields an empty map, so every field stays space-scoped
    // — exactly the pre-existing behaviour, zero regression.
    const contexts = await adapter.getCustomFieldContexts();

    return {
      items: Array.from(bySourceId.values()).map((field) => {
        const projectIds = contexts.get(field.sourceId);
        const globalOnSource =
          Array.isArray(projectIds) && projectIds.length === 0;

        return {
          entityType: CUSTOM_FIELD_ENTITY,
          sourceRef: field.sourceId,
          payload: {
            ...field,
            globalOnSource,
          } as unknown as Record<string, unknown>,
        };
      }),
      nextCheckpoint: null,
      done: true,
    };
  }

  async processItem(
    ctx: StageContext,
    item: MigrationRunItemRow,
  ): Promise<ItemOutcome> {
    const field = item.payload as unknown as NormalizedField | null;

    if (!field?.sourceId) {
      throw new MigrationItemError(
        'permanent',
        'Custom-field item is missing its payload snapshot',
      );
    }

    const existing = await ctx.entityMap.getExistingCustomFieldTarget(
      ctx.orgId,
      ctx.job.connection_id,
      field.sourceId,
    );

    if (existing) {
      if (existing.status === 'mapped') {
        return {
          kind: 'skipped',
          reason: 'field already mapped',
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

    const outcome = mapField(field);

    // `native` and `skip` are decisions, not failures — record them so a re-run is a no-op and the
    // issues/boards phases can consume the correspondence (e.g. gh-sprint → native sprint).
    if (outcome.kind !== 'custom_field') {
      await ctx.entityMap.recordMapping({
        orgId: ctx.orgId,
        connectionId: ctx.job.connection_id,
        jobId: ctx.job.id,
        runId: ctx.run.id,
        entityType: CUSTOM_FIELD_ENTITY,
        sourceId: field.sourceId,
        sourceKey: field.name,
        targetTable: null,
        targetId:
          outcome.kind === 'native' ? `native:${outcome.native}` : 'skip',
        status: ctx.dryRun ? 'planned' : 'mapped',
        metadata: {
          outcome: outcome.kind,
          reason: outcome.reason,
          name: field.name,
          ...(outcome.kind === 'native' ? { native: outcome.native } : {}),
        },
      });

      if (ctx.dryRun) return { kind: 'planned' };

      return { kind: 'skipped', reason: outcome.reason };
    }

    const { spaceId, gateOpen } = await resolveTargetSpace(ctx);

    if (!gateOpen) return blockedOnSpace(ctx);

    if (outcome.lossy) {
      await ctx.log('warn', `custom_fields: ${outcome.lossy}`, {
        sourceId: field.sourceId,
        fieldKey: outcome.fieldKey,
      });
    }

    if (ctx.dryRun) {
      await ctx.entityMap.recordMapping({
        orgId: ctx.orgId,
        connectionId: ctx.job.connection_id,
        jobId: ctx.job.id,
        runId: ctx.run.id,
        entityType: CUSTOM_FIELD_ENTITY,
        sourceId: field.sourceId,
        sourceKey: outcome.fieldKey,
        targetTable: 'custom_fields',
        targetId: `planned:${outcome.fieldKey}`,
        status: 'planned',
        metadata: {
          outcome: 'custom_field',
          field_key: outcome.fieldKey,
          field_type: outcome.fieldType,
          option_count: outcome.options.length,
          name: field.name,
          ...(outcome.lossy ? { lossy: outcome.lossy } : {}),
        },
      });

      return { kind: 'planned' };
    }

    let created: { id: string };

    // ADOPT-FIRST. Looking before creating is what makes a repeat migration converge instead of
    // colliding: `field_key` is unique per ORGANIZATION, so the second migration of the same Jira
    // project would otherwise 409 on every single field it already imported.
    const preExisting = await this.findByFieldKey(
      ctx.orgId,
      outcome.fieldKey,
      spaceId,
    );

    if (preExisting) {
      await ctx.log(
        'info',
        `custom_fields: adopted the existing field "${outcome.fieldKey}" rather than creating a duplicate`,
        { sourceId: field.sourceId, customFieldId: preExisting.id },
      );

      created = preExisting;
    } else {
      created = await this.createField(ctx, field, outcome, spaceId);
    }

    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: ctx.run.id,
      entityType: CUSTOM_FIELD_ENTITY,
      sourceId: field.sourceId,
      sourceKey: outcome.fieldKey,
      targetTable: 'custom_fields',
      // The crosswalk's target_id is the TEXT field_key (the stable, human-readable handle the
      // issues stage keys custom_field_values by) — the UUID rides in metadata for field_groups.
      targetId: outcome.fieldKey,
      status: 'mapped',
      metadata: {
        outcome: 'custom_field',
        custom_field_id: created.id,
        field_key: outcome.fieldKey,
        field_type: outcome.fieldType,
        issue_type_source_ids: field.issueTypeSourceIds ?? [],
        name: field.name,
        adopted: !!preExisting,
        ...(outcome.lossy ? { lossy: outcome.lossy } : {}),
      },
    });

    return {
      kind: 'created',
      targetId: created.id,
      targetTable: 'custom_fields',
    };
  }

  /** Create the field, adopting on a raced conflict rather than failing the item. */
  private async createField(
    ctx: StageContext,
    field: NormalizedField,
    // Derived from the mapper rather than restated: `field_type` is a union, not a string, and
    // hand-writing the shape here would either not compile or need a cast that hides a real
    // mismatch the day the mapper's outcome changes.
    outcome: Extract<ReturnType<typeof mapField>, { kind: 'custom_field' }>,
    spaceId: string | null | undefined,
  ): Promise<{ id: string }> {
    let created: { id: string };

    try {
      // A field whose Jira context is GLOBAL migrates ORG-LEVEL (`space_id` null): that is what the
      // source says it is, it is visible from every space via the union reads, and it is what stops
      // a second project's migration minting a per-space copy. `scope` and `space_id` are
      // hard-coupled by the service's own validation, so both switch together.
      const orgLevel =
        (field as { globalOnSource?: boolean }).globalOnSource === true;

      created = await this.customFieldsService.create(
        ctx.orgId,
        requireActingUser(ctx),
        {
          name: field.name || outcome.fieldKey,
          field_key: outcome.fieldKey,
          field_type: outcome.fieldType,
          ...(orgLevel
            ? { scope: 'organization' as const }
            : { scope: 'space' as const, space_id: spaceId! }),
          // A Jira issue field maps to the TASK context. Without this the service defaults
          // `contexts` to [], which makes the field invisible everywhere it is filtered by context
          // (task forms, the saved-filter/board field list) — the field migrates but is unusable.
          contexts: ['task'],
          options: outcome.options,
          validation_rules: outcome.validationRules as Record<string, unknown>,
        },
      );

      if (orgLevel) {
        await ctx.log(
          'info',
          `custom_fields: "${outcome.fieldKey}" has a GLOBAL context on the source — created org-level`,
          { sourceId: field.sourceId },
        );
      }
    } catch (err) {
      if (!(err instanceof ConflictException)) throw err;

      // `field_key` is unique per ORGANIZATION (custom-fields.service.ts:264-285), not per space.
      // A 409 means the key already exists — from an earlier partial run, or a same-named field in
      // a sibling space. Adopt it rather than failing the item: re-running a migration must
      // converge, and the field_groups stage only needs a real UUID to point at.
      const adopted = await this.findByFieldKey(ctx.orgId, outcome.fieldKey);

      if (!adopted) {
        throw new MigrationItemError(
          'conflict',
          `Field key "${outcome.fieldKey}" conflicts but no matching field is readable: ${err.message}`,
        );
      }

      await ctx.log(
        'warn',
        `custom_fields: adopted pre-existing field "${outcome.fieldKey}"`,
        { sourceId: field.sourceId, customFieldId: adopted.id },
      );

      created = adopted;
    }

    return created;
  }

  /**
   * Org-scoped lookup by field_key — the service exposes no key filter (CustomFieldFilters has none).
   *
   * Returns at most one row, ORG-LEVEL PREFERRED, then this space, then any sibling space.
   *
   * The ordering and the `.limit(1)` are both load-bearing. `custom_fields` carries two INDEPENDENT
   * partial unique indexes — one on `(organization_id, field_key) WHERE space_id IS NULL`, one on
   * `(organization_id, space_id, field_key) WHERE space_id IS NOT NULL` — so the same `field_key`
   * legitimately exists once per space plus once at org level. This lookup therefore routinely sees
   * SEVERAL rows: the live test org holds 23 keys duplicated across two spaces.
   *
   * The previous `.maybeSingle()` turned that into a PostgREST error, which surfaces as
   * `BadRequestException`, which the worker classifies as TRANSIENT — so the item retried a
   * perfectly deterministic failure until it exhausted its attempts and died, and the run reported
   * `partially_completed` for what is really a resolvable duplicate. Ordering and taking one row
   * makes the answer deterministic instead of an error.
   */
  private async findByFieldKey(
    orgId: string,
    fieldKey: string,
    spaceId?: string | null,
  ): Promise<{ id: string } | null> {
    const { data, error } = (await this.db
      .from('custom_fields')
      .select('id, space_id')
      .eq('organization_id', orgId)
      .eq('field_key', fieldKey)
      // Mirrors the service's own soft-delete predicate (custom-fields.service.ts:140) — the column
      // is `is_deleted` (nullable boolean), not a `deleted_at` timestamp.
      .or('is_deleted.is.null,is_deleted.eq.false')) as {
      data: { id: string; space_id: string | null }[] | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new MigrationItemError(
        'transient',
        `Custom-field lookup failed: ${error.message}`,
      );
    }

    const rows = data ?? [];

    if (rows.length === 0) return null;

    // Org-level wins: it is visible from every space, so reusing it is what stops repeat migrations
    // minting one copy per space.
    const orgLevel = rows.find((r) => !r.space_id);

    if (orgLevel) return { id: orgLevel.id };

    const sameSpace = spaceId
      ? rows.find((r) => r.space_id === spaceId)
      : undefined;

    if (sameSpace) return { id: sameSpace.id };

    // A sibling space's row. Adopting it is correct for the crosswalk (`field_key` is the handle the
    // issues stage uses, and it is org-unique by the service's own conflict rule), and it is what
    // keeps a second migration of the same project from failing outright.
    return { id: rows[0].id };
  }
}
