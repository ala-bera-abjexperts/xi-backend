/**
 * @fileoverview `confluence_space` stage — creates (or adopts) the target XISUITE space for a
 * Confluence space. Writes a `space` crosswalk entity (source_id = the job's space key) so the
 * downstream pages/attachments stages resolve it via `resolveTargetSpace`, exactly like the Jira
 * space stage. Space permissions are best-effort and never block a run (Server has no REST surface).
 */

import { ConflictException, Injectable } from '@nestjs/common';
import { SpacesService } from '../../../spaces/spaces.service';
import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import { isConfluenceAdapter } from '../../adapters/source-adapter.interface';
import type { NormalizedSpace } from '../../model/normalized';
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

export const CONFLUENCE_SPACE_STAGE = 'confluence_space';

@Injectable()
export class ConfluenceSpaceStage implements IStageHandler {
  readonly stage = CONFLUENCE_SPACE_STAGE;

  constructor(
    private readonly spacesService: SpacesService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  async produce(ctx: StageContext): Promise<ProduceResult> {
    const adapter = await ctx.getAdapter();

    if (!isConfluenceAdapter(adapter)) {
      throw new MigrationItemError(
        'permanent',
        'The Confluence space stage requires a Confluence connection',
      );
    }

    const space = await adapter.getSpaceDetails(ctx.job.source_ref);

    return {
      items: [
        {
          entityType: SPACE_ENTITY,
          sourceRef: ctx.job.source_ref,
          payload: space as unknown as Record<string, unknown>,
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
    const space = item.payload as unknown as NormalizedSpace | null;

    if (!space?.key) {
      throw new MigrationItemError(
        'permanent',
        'Space item is missing its snapshot',
      );
    }

    const inspection = await ctx.entityMap.inspectSpaceTarget(
      ctx.orgId,
      ctx.job.connection_id,
      ctx.job.source_ref,
    );
    const existing = inspection.mapping;

    // See the identical guard in space.stage.ts. The crosswalk is keyed on
    // (org, connection, entity_type, source_id) and not on the target, so an explicit
    // `target_space_id` must outrank a mapping left by an earlier run — otherwise choosing a target
    // space is silently ignored for any source that was migrated before through this connection.
    // This is the path that lets a Confluence space join a Jira project already migrated into the
    // same XISUITE space, which is what XE-T549 actually asks for.
    const targetOverridesExistingMapping = targetOverridesMappedSpace(
      ctx.job.target_space_id,
      existing?.target_id,
    );

    if (
      inspection.state === 'active' &&
      existing &&
      !targetOverridesExistingMapping
    ) {
      return {
        kind: 'skipped',
        reason: 'space already mapped',
        targetId: existing.target_id,
      };
    }

    if (
      inspection.state === 'planned' &&
      existing &&
      ctx.dryRun &&
      !targetOverridesExistingMapping
    ) {
      return {
        kind: 'skipped',
        reason: 'already planned',
        targetId: existing.target_id,
      };
    }

    if (inspection.state === 'archived') {
      throw new MigrationItemError(
        'permanent',
        'The mapped target space is archived. Restore it to reuse it, or permanently delete it before rerunning the migration.',
      );
    }

    if (
      inspection.state === 'missing' &&
      existing?.metadata?.adopted === true
    ) {
      throw new MigrationItemError(
        'permanent',
        'The selected target space no longer exists. Select another target space before rerunning the migration.',
      );
    }

    if (inspection.state === 'missing' && ctx.dryRun) {
      // A dry run must not replace the only evidence that this target was deleted.
      return { kind: 'planned' };
    }

    if (inspection.state === 'missing' && existing) {
      await ctx.entityMap.recoverStaleConfluenceSpaceMappings(
        ctx.orgId,
        ctx.job.connection_id,
        ctx.job.source_ref,
        existing.target_id,
      );
    }

    if (ctx.job.target_space_id) {
      return this.adoptExistingSpace(ctx, space);
    }

    const derived = await deriveSpaceKey(space.key, async (candidate) => {
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
        `Space key derived as "${derived.key}" from "${space.key}"` +
          `${derived.truncated ? ' (truncated)' : ''}${derived.suffixed ? ' (collision suffix)' : ''}`,
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
        sourceKey: space.key,
        targetTable: 'spaces',
        targetId: `planned:${derived.key}`,
        status: 'planned',
        metadata: { confluence_key: space.key, derived_key: derived.key },
      });

      return { kind: 'planned' };
    }

    const actingUser = requireActingUser(ctx);

    const desiredName = space.name || space.key;
    const name = await this.deriveUniqueName(ctx, desiredName);

    if (name !== desiredName) {
      await ctx.log(
        'warn',
        `Space name "${desiredName}" is already taken in this organization — created as "${name}"`,
        { sourceRef: space.key },
      );
    }

    let spaceId: string;

    try {
      const created = await this.spacesService.createSpace(
        ctx.orgId,
        actingUser,
        {
          name,
          key: derived.key,
          description: space.description?.slice(0, 1000) || undefined,
        },
      );

      spaceId = created.id;
    } catch (err) {
      if (err instanceof ConflictException) {
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
      sourceKey: space.key,
      targetTable: 'spaces',
      targetId: spaceId,
      status: 'mapped',
      metadata: { confluence_key: space.key, key: derived.key },
    });

    await ctx.log(
      'info',
      `Created space "${derived.key}" for Confluence space ${space.key}`,
      {
        spaceId,
      },
    );

    await this.reportSourcePermissions(ctx, space.key);

    return { kind: 'created', targetId: spaceId, targetTable: 'spaces' };
  }

  /** `spaces` is unique by name as well as key, so re-imports need both suffixes. */
  private async deriveUniqueName(
    ctx: StageContext,
    desired: string,
  ): Promise<string> {
    const taken = async (candidate: string): Promise<boolean> => {
      const { data, error } = (await this.db
        .from('spaces')
        .select('id')
        .eq('organization_id', ctx.orgId)
        .eq('name', candidate)
        .limit(1)) as {
        data: { id: string }[] | null;
        error: { message: string } | null;
      };

      if (error)
        throw new MigrationItemError(
          'transient',
          `Space name lookup failed: ${error.message}`,
        );

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

  /**
   * Record the source space's ACL as a run log.
   *
   * `getSpacePermissions` had no caller at all, so the operator was given no way to see what access
   * the Confluence space granted. It is reported rather than APPLIED because every principal here is
   * a Confluence account/group id: turning those into `space_members` needs the Confluence user
   * producer, and the `users` stage is still a no-op for Confluence, so writing them now would
   * silently grant nothing. Optional on the interface (Server has no REST surface) and never fatal —
   * a permissions read must not be able to fail a space that migrated correctly.
   */
  private async reportSourcePermissions(
    ctx: StageContext,
    spaceKey: string,
  ): Promise<void> {
    try {
      const adapter = await ctx.getAdapter();

      if (!isConfluenceAdapter(adapter) || !adapter.getSpacePermissions) return;

      const perms = await adapter.getSpacePermissions(spaceKey);
      const byType = perms.reduce<Record<string, number>>((acc, p) => {
        acc[p.principalType] = (acc[p.principalType] ?? 0) + 1;

        return acc;
      }, {});

      await ctx.log(
        'info',
        `Source space grants ${perms.length} permission(s) — not applied, because Confluence ` +
          `principals cannot be mapped to users until the Confluence user producer exists`,
        {
          spacePermsReported: true,
          byPrincipalType: byType,
          operations: [...new Set(perms.map((p) => p.operation))].slice(0, 20),
        },
      );
    } catch (err) {
      await ctx.log('warn', 'Could not read source space permissions', {
        spacePermsSkipped: true,
        error: (err as Error).message,
      });
    }
  }

  private async adoptExistingSpace(
    ctx: StageContext,
    space: NormalizedSpace,
  ): Promise<ItemOutcome> {
    const targetSpaceId = ctx.job.target_space_id!;

    const { data } = (await this.db
      .from('spaces')
      .select('id, is_archived')
      .eq('organization_id', ctx.orgId)
      .eq('id', targetSpaceId)
      .limit(1)) as {
      data: { id: string; is_archived: boolean | null }[] | null;
    };

    if (!data || data.length === 0) {
      throw new MigrationItemError(
        'permanent',
        "The job's target space no longer exists in this organization",
      );
    }

    if (data[0].is_archived) {
      throw new MigrationItemError(
        'permanent',
        "The job's target space is archived. Restore it before rerunning the migration",
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
        sourceKey: space.key,
        targetTable: 'spaces',
        targetId: 'planned:existing',
        status: 'planned',
        metadata: {
          confluence_key: space.key,
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
      sourceKey: space.key,
      targetTable: 'spaces',
      targetId: targetSpaceId,
      status: 'mapped',
      matchMethod: 'existing',
      metadata: {
        confluence_key: space.key,
        adopted: true,
        target_space_id: targetSpaceId,
      },
    });

    return { kind: 'updated', targetId: targetSpaceId, targetTable: 'spaces' };
  }
}
