/**
 * @fileoverview `space` stage — creates the target XISUITE space for the Jira project
 * via `SpacesService.createSpace` (name = project name, German ok; key derived ≤ 8
 * chars with truncation + collision suffix; lead resolved through the user crosswalk,
 * lossy-logged when unresolvable). When the job carries a `target_space_id`, the
 * existing space is adopted instead of creating one.
 *
 * Crosswalk: entity `space`, source_id = the JOB's project key (`job.source_ref`) so
 * every later stage resolves the space without extra source calls; metadata carries
 * the numeric project id + key derivation facts.
 */

import { ConflictException, Injectable } from '@nestjs/common';
import { SpacesService } from '../../../spaces/spaces.service';
import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import { isJiraAdapter } from '../../adapters/source-adapter.interface';
import type { NormalizedProject } from '../../model/normalized';
import { deriveSpaceKey } from '../../util/space-key.util';
import {
  SPACE_ENTITY,
  requireActingUser,
  targetOverridesMappedSpace,
} from './stage-helpers';
import {
  MigrationItemError,
  type IStageHandler,
  type ItemOutcome,
  type MigrationRunItemRow,
  type ProduceResult,
  type StageContext,
} from './stage.interface';

export const SPACE_STAGE = 'space';

@Injectable()
export class SpaceStage implements IStageHandler {
  readonly stage = SPACE_STAGE;

  constructor(
    private readonly spacesService: SpacesService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /** Exactly one item: the project itself (payload snapshot avoids a re-fetch). */
  async produce(ctx: StageContext): Promise<ProduceResult> {
    const adapter = await ctx.getAdapter();

    if (!isJiraAdapter(adapter)) {
      throw new MigrationItemError(
        'permanent',
        'The space stage currently supports Jira sources only',
      );
    }

    const project = await adapter.getProjectDetails(ctx.job.source_ref);

    return {
      items: [
        {
          entityType: SPACE_ENTITY,
          sourceRef: ctx.job.source_ref,
          payload: project as unknown as Record<string, unknown>,
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
    const project = item.payload as unknown as NormalizedProject | null;

    if (!project?.key) {
      throw new MigrationItemError(
        'permanent',
        'Space item is missing its project snapshot',
      );
    }

    const mapped = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      SPACE_ENTITY,
      ctx.job.source_ref,
    );
    const existing = await ctx.entityMap.getExistingTarget(
      ctx.orgId,
      ctx.job.connection_id,
      SPACE_ENTITY,
      ctx.job.source_ref,
      'spaces',
    );

    // An explicit target space on the job outranks a crosswalk row left by an earlier run against
    // the same source. The crosswalk is keyed on (org, connection, entity_type, source_id) — not on
    // the target — so without this guard, picking a target space is SILENTLY IGNORED whenever that
    // project was migrated before through the same connection: the operator selects a space, the
    // job card reads "Target space linked", and every stage still writes into the space the first
    // run created. Observed live: a KAN run targeted at a fresh space put all 53 issues into the
    // "KANBAN (2)" space a previous run had made. XE-T549.
    //
    // When the job's target already equals the mapped target, the skip is correct — that is the
    // idempotent re-run path and must stay a no-op.
    const targetOverridesExistingMapping = targetOverridesMappedSpace(
      ctx.job.target_space_id,
      existing?.target_id,
    );

    if (existing && !targetOverridesExistingMapping) {
      if (existing.status === 'mapped') {
        return {
          kind: 'skipped',
          reason: 'space already mapped',
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

    if (targetOverridesExistingMapping) {
      await ctx.log(
        'warn',
        `Target space overrides an earlier mapping for "${ctx.job.source_ref}": ` +
          `content now migrates into the space selected on this migration, not the one a previous run created.`,
        {
          previous_target_id: existing!.target_id,
          new_target_id: ctx.job.target_space_id,
        },
      );
    }

    // The space crosswalk can outlive a customer-deleted space. A live auto-create rerun must replay
    // every project-owned stage, while keeping org-global users/groups/priorities/resolutions.
    if (mapped?.status === 'mapped' && !existing && !ctx.job.target_space_id) {
      if (mapped.metadata?.adopted === true) {
        throw new MigrationItemError(
          'permanent',
          'The selected target space no longer exists. Select another target space before rerunning the migration.',
        );
      }

      if (ctx.dryRun) return { kind: 'planned' };

      await ctx.entityMap.recoverStaleSpaceMappings(
        ctx.orgId,
        ctx.job.connection_id,
        mapped.job_id ?? ctx.job.id,
      );
    }

    // Adopt an existing target space when the job asks for it.
    if (ctx.job.target_space_id) {
      return this.adoptExistingSpace(ctx, project);
    }

    const derived = await deriveSpaceKey(project.key, async (candidate) => {
      const { data } = (await this.db
        .from('spaces')
        .select('id')
        .eq('organization_id', ctx.orgId)
        .eq('key', candidate)
        .limit(1)) as { data: { id: string }[] | null };

      return (data ?? []).length > 0;
    });

    if (derived.truncated || derived.suffixed) {
      await ctx.log(
        'warn',
        `Space key derived as "${derived.key}" from "${project.key}"` +
          `${derived.truncated ? ' (truncated to 8 chars)' : ''}${derived.suffixed ? ' (collision suffix)' : ''}`,
      );
    }

    const leadId = await this.resolveLead(ctx, project);

    if (ctx.dryRun) {
      await ctx.entityMap.recordMapping({
        orgId: ctx.orgId,
        connectionId: ctx.job.connection_id,
        jobId: ctx.job.id,
        runId: ctx.run.id,
        entityType: SPACE_ENTITY,
        sourceId: ctx.job.source_ref,
        sourceKey: project.key,
        targetTable: 'spaces',
        targetId: `planned:${derived.key}`,
        status: 'planned',
        metadata: {
          project_source_id: project.sourceId,
          derived_key: derived.key,
          truncated: derived.truncated,
          suffixed: derived.suffixed,
          lead_resolved: !!leadId,
        },
      });

      return { kind: 'planned' };
    }

    const actingUser = requireActingUser(ctx);

    // `spaces` is unique on (organization_id, name) as well as on key. `deriveSpaceKey` only
    // dodges the KEY, so a project whose NAME already exists still 23505s — and
    // `SpacesService.createSpace` surfaces that as a generic 500 ("Failed to create space"), not a
    // ConflictException, so the catch below never fired: the item was misread as `transient`,
    // retried 5×, and died. Every downstream stage then failed with "Dependency space:SDP did not
    // migrate (dead)".
    //
    // This is reachable in normal use, not just a test artifact: the UNDO deliberately preserves
    // spaces (they may be adopted, and dropping one cascades far past the migration) while clearing
    // the crosswalk — so undo-then-re-import always leaves an orphaned space whose name collides.
    // Verified live: 41 downstream failures from exactly this.
    const name = await this.deriveUniqueName(ctx, project.name || project.key);

    if (name !== (project.name || project.key)) {
      await ctx.log(
        'warn',
        `Space name "${project.name}" is already taken in this organization — created as "${name}"`,
        { sourceRef: project.key },
      );
    }

    let spaceId: string;

    try {
      const space = await this.spacesService.createSpace(
        ctx.orgId,
        actingUser,
        {
          name,
          key: derived.key,
          description: project.description?.slice(0, 1000) || undefined,
          lead_id: leadId ?? undefined,
        },
      );

      spaceId = space.id;
    } catch (err) {
      if (err instanceof ConflictException) {
        // Key raced with a concurrent creation — transient so the retry re-derives.
        throw new MigrationItemError(
          'transient',
          `Space key collision: ${err.message}`,
        );
      }

      throw err;
    }

    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: ctx.run.id,
      entityType: SPACE_ENTITY,
      sourceId: ctx.job.source_ref,
      sourceKey: project.key,
      targetTable: 'spaces',
      targetId: spaceId,
      status: 'mapped',
      metadata: {
        project_source_id: project.sourceId,
        key: derived.key,
        truncated: derived.truncated,
        suffixed: derived.suffixed,
        lead_resolved: !!leadId,
      },
    });

    await ctx.log(
      'info',
      `Created space "${derived.key}" for project ${project.key}`,
      {
        spaceId,
      },
    );

    return { kind: 'created', targetId: spaceId, targetTable: 'spaces' };
  }

  private async adoptExistingSpace(
    ctx: StageContext,
    project: NormalizedProject,
  ): Promise<ItemOutcome> {
    const targetSpaceId = ctx.job.target_space_id!;

    // Tenant integrity: the jobs service verified org ownership at save time —
    // re-verify here because the space may have been deleted since.
    const { data } = (await this.db
      .from('spaces')
      .select('id')
      .eq('organization_id', ctx.orgId)
      .eq('id', targetSpaceId)
      .limit(1)) as { data: { id: string }[] | null };

    if (!data || data.length === 0) {
      throw new MigrationItemError(
        'permanent',
        "The job's target space no longer exists in this organization",
      );
    }

    if (ctx.dryRun) {
      await ctx.entityMap.recordMapping({
        orgId: ctx.orgId,
        connectionId: ctx.job.connection_id,
        jobId: ctx.job.id,
        runId: ctx.run.id,
        entityType: SPACE_ENTITY,
        sourceId: ctx.job.source_ref,
        sourceKey: project.key,
        targetTable: 'spaces',
        targetId: `planned:existing`,
        status: 'planned',
        metadata: {
          project_source_id: project.sourceId,
          adopted: true,
          target_space_id: targetSpaceId,
        },
      });

      return { kind: 'planned' };
    }

    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: ctx.run.id,
      entityType: SPACE_ENTITY,
      sourceId: ctx.job.source_ref,
      sourceKey: project.key,
      targetTable: 'spaces',
      targetId: targetSpaceId,
      status: 'mapped',
      matchMethod: 'existing',
      metadata: {
        project_source_id: project.sourceId,
        adopted: true,
        target_space_id: targetSpaceId,
      },
    });

    return { kind: 'updated', targetId: targetSpaceId, targetTable: 'spaces' };
  }

  /** Lead via the P3 user crosswalk — absent/unmapped/planned → null + lossy log. */
  /**
   * A space name free of `spaces_organization_id_name_key`. Mirrors `deriveSpaceKey`'s suffix
   * strategy, but on the name — Jira project names are not unique across re-imports, and an orphaned
   * space left by an undo (which preserves spaces by design) holds the original name.
   *
   * Hand-scoped by organization_id: the service-role client bypasses RLS.
   */
  private async deriveUniqueName(
    ctx: StageContext,
    desired: string,
  ): Promise<string> {
    const taken = async (candidate: string): Promise<boolean> => {
      const { data, error } = (await this.supabaseAdmin
        .getClient()
        .from('spaces')
        .select('id')
        .eq('organization_id', ctx.orgId)
        .eq('name', candidate)
        .limit(1)) as {
        data: { id: string }[] | null;
        error: { message: string } | null;
      };

      if (error) {
        throw new MigrationItemError(
          'transient',
          `Space name lookup failed: ${error.message}`,
        );
      }

      return (data ?? []).length > 0;
    };

    if (!(await taken(desired))) return desired;

    for (let n = 2; n < 100; n++) {
      const candidate = `${desired} (${n})`;

      if (!(await taken(candidate))) return candidate;
    }

    throw new MigrationItemError(
      'permanent',
      `Could not derive a free space name from "${desired}" — 100 variants are taken`,
    );
  }

  private async resolveLead(
    ctx: StageContext,
    project: NormalizedProject,
  ): Promise<string | null> {
    if (!project.leadUserSourceId) return null;

    const lead = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      'user',
      project.leadUserSourceId,
    );

    if (lead && (lead.status === 'mapped' || lead.status === 'placeholder')) {
      return lead.target_id;
    }

    await ctx.log(
      'warn',
      `Project lead "${project.leadUserSourceId}" is not in the user crosswalk — space created without a lead`,
    );

    return null;
  }
}
