/**
 * @fileoverview `links` stage — Jira issue links → `task_relationships`.
 *
 * OUTWARD ONLY. Jira reports every link TWICE — once from each side ("A blocks B" appears on A as
 * outward and on B as inward). `task_relationships_unique (source_id, target_id, relation_type_id)`
 * plus an explicit dup pre-check that throws 409 means importing both sides fails half of them. So
 * inward links are dropped by construction: the outward copy already carries the same edge.
 *
 * `relation_type_id` is a **UUID, not a name**, and `relation_types` rows are PER-ORGANIZATION
 * (`is_system=true` for built-ins like "Blocks"). Jira's link-type names are resolved against the
 * target org's own rows, case-insensitively, with a "Relates"-style fallback so an unknown Jira link
 * type degrades to a generic relationship rather than losing the edge entirely.
 *
 * Re-fetches issues with `fields:['issuelinks']`: the `issues` stage deliberately excludes them from
 * ISSUE_FIELDS (it would drag the devstatus blob and link payloads through 9,826 rows for nothing),
 * so the link graph is read here, once, on its own.
 *
 * MEASURED: SDP has ZERO issue links — this stage is built for real customers and cannot be
 * exercised by the live test data.
 */

import { ConflictException, Injectable } from '@nestjs/common';
import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import { TasksService } from '../../../tasks/tasks.service';
import { isJiraAdapter } from '../../adapters/source-adapter.interface';
import type {
  NormalizedLink,
  NormalizedRemoteLink,
} from '../../model/normalized';
import type { CreateRelationTypeDto } from '../../../relation-types/dto/create-relation-type.dto';
import { RelationTypesService } from '../../../relation-types/relation-types.service';
import { ISSUE_ENTITY } from './issues.stage';
import {
  fallbackRelationType,
  matchRelationType,
  type RelationTypeRow,
} from './relation-type-match.util';
import { requireActingUser, runScope, scopeIncludes } from './stage-helpers';
import {
  MigrationItemError,
  type IStageHandler,
  type ItemOutcome,
  type MigrationRunItemRow,
  type ProduceResult,
  type SeedItem,
  type StageContext,
} from './stage.interface';

export const LINKS_STAGE = 'links';
export const LINK_ENTITY = 'link';

interface LinkPayload {
  issueSourceId: string;
  link: NormalizedLink;
}

interface RemoteLinkPayload {
  issueSourceId: string;
  remoteLink: NormalizedRemoteLink;
}

@Injectable()
export class LinksStage implements IStageHandler {
  readonly stage = LINKS_STAGE;

  constructor(
    private readonly tasksService: TasksService,
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly relationTypesService: RelationTypesService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /** One page of issues per call; seeds one item per OUTWARD link. Cursor rides the checkpoint. */
  async produce(
    ctx: StageContext,
    collectionItem: MigrationRunItemRow,
  ): Promise<ProduceResult> {
    const adapter = await ctx.getAdapter();

    if (!isJiraAdapter(adapter)) {
      await ctx.log('warn', 'links stage: non-Jira source — seeding 0');

      return { items: [], nextCheckpoint: null, done: true };
    }

    // The admin explicitly excluded links — honour it, and say so rather than silently importing.
    if (!scopeIncludes(ctx, 'include_links')) {
      await ctx.log('info', 'links stage: excluded by job scope — seeding 0');

      return { items: [], nextCheckpoint: null, done: true };
    }

    const checkpoint = collectionItem.checkpoint ?? {};
    const cursor =
      typeof checkpoint.cursor === 'string' ? checkpoint.cursor : null;

    const iterator = adapter.iterateIssues(ctx.job.source_ref, {
      cursor,
      pageSize: 100,
      fields: ['issuelinks'],
      ...(runScope(ctx).jql ? { jql: runScope(ctx).jql } : {}),
    });
    const first = await iterator.next();

    if (first.done || !first.value) {
      return { items: [], nextCheckpoint: null, done: true };
    }

    const page = first.value;
    const items: SeedItem[] = [];

    for (const issue of page.items) {
      for (const link of issue.links ?? []) {
        // Inward is the mirror of an outward link on the other issue — importing both 409s.
        if (link.direction !== 'outward') continue;

        const payload: LinkPayload = { issueSourceId: issue.sourceId, link };

        items.push({
          entityType: LINK_ENTITY,
          // Stable, unique per edge: same key on a re-run → idempotent via the crosswalk.
          sourceRef: `${issue.sourceId}:${link.type}:${link.otherIssueSourceId}`,
          payload: payload as unknown as Record<string, unknown>,
        });
      }

      // REMOTE links (Link → Web Link): how a PDF or Confluence page is attached to a Jira
      // issue as a link. Never part of `fields.issuelinks`, so they are fetched per issue
      // here and imported as a task comment — otherwise they silently vanish.
      const remoteLinks = await adapter.getIssueRemoteLinks(issue.key);

      for (const remoteLink of remoteLinks) {
        const payload: RemoteLinkPayload = {
          issueSourceId: issue.sourceId,
          remoteLink,
        };

        items.push({
          entityType: LINK_ENTITY,
          sourceRef: `${issue.sourceId}:remotelink:${remoteLink.sourceId || remoteLink.url}`,
          payload: payload as unknown as Record<string, unknown>,
        });
      }
    }

    return {
      items,
      nextCheckpoint: page.nextCursor ? { cursor: page.nextCursor } : null,
      done: page.nextCursor === null,
    };
  }

  async processItem(
    ctx: StageContext,
    item: MigrationRunItemRow,
  ): Promise<ItemOutcome> {
    const payload = item.payload as unknown as
      | (LinkPayload & { remoteLink?: NormalizedRemoteLink })
      | null;

    if (!payload) {
      throw new MigrationItemError(
        'permanent',
        'Link item is missing its payload snapshot',
      );
    }

    // A REMOTE link (web link to a document/URL) becomes a task comment — the only
    // target surface that can carry an external reference on a task.
    if (payload.remoteLink?.url) {
      return this.processRemoteLink(ctx, item, {
        issueSourceId: payload.issueSourceId,
        remoteLink: payload.remoteLink,
      });
    }

    if (!payload.link?.otherIssueSourceId) {
      throw new MigrationItemError(
        'permanent',
        'Link item is missing its payload snapshot',
      );
    }

    const sourceRef = item.source_ref ?? '';
    const existing = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      LINK_ENTITY,
      sourceRef,
    );

    if (existing?.status === 'mapped') {
      return { kind: 'skipped', reason: 'link already mapped' };
    }

    // Both ends must exist. A miss blocks — never write half an edge.
    const from = await this.gate(ctx, payload.issueSourceId);

    if (!from) {
      return this.missingEndpoint(ctx, item, payload.issueSourceId);
    }

    const to = await this.gate(ctx, payload.link.otherIssueSourceId);

    if (!to) {
      return this.missingEndpoint(ctx, item, payload.link.otherIssueSourceId);
    }

    const relationTypeId = await this.resolveRelationType(
      ctx,
      payload.link.type,
    );

    if (!relationTypeId) {
      // No relation type at all in this org — the edge cannot be represented. Report it; do not
      // fail the run over a link.
      await ctx.log(
        'warn',
        `links: no relation type available for Jira link "${payload.link.type}" — link skipped`,
        { sourceRef },
      );

      return {
        kind: 'skipped',
        reason: `no relation type for "${payload.link.type}"`,
      };
    }

    if (ctx.dryRun) {
      await ctx.entityMap.recordMapping({
        orgId: ctx.orgId,
        connectionId: ctx.job.connection_id,
        jobId: ctx.job.id,
        runId: ctx.run.id,
        entityType: LINK_ENTITY,
        sourceId: sourceRef,
        sourceKey: payload.link.type,
        targetTable: 'task_relationships',
        targetId: `planned:${sourceRef}`,
        status: 'planned',
        metadata: {
          type: payload.link.type,
          relation: payload.link.relationName,
        },
      });

      return { kind: 'planned' };
    }

    try {
      await this.tasksService.createRelationship(
        from,
        ctx.orgId,
        requireActingUser(ctx),
        { target_id: to, relation_type_id: relationTypeId },
      );
    } catch (err) {
      // 409 = the edge already exists (resumed run, or Jira reported it from both sides despite the
      // outward filter). Converge rather than fail.
      if (err instanceof ConflictException) {
        await ctx.entityMap.recordMapping({
          orgId: ctx.orgId,
          connectionId: ctx.job.connection_id,
          jobId: ctx.job.id,
          runId: ctx.run.id,
          entityType: LINK_ENTITY,
          sourceId: sourceRef,
          sourceKey: payload.link.type,
          targetTable: 'task_relationships',
          targetId: `${from}:${to}`,
          status: 'mapped',
          metadata: { type: payload.link.type, adopted: true },
        });

        return { kind: 'skipped', reason: 'relationship already exists' };
      }

      throw err;
    }

    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: ctx.run.id,
      entityType: LINK_ENTITY,
      sourceId: sourceRef,
      sourceKey: payload.link.type,
      targetTable: 'task_relationships',
      targetId: `${from}:${to}`,
      status: 'mapped',
      metadata: {
        type: payload.link.type,
        relation: payload.link.relationName,
        relation_type_id: relationTypeId,
      },
    });

    return {
      kind: 'created',
      targetId: `${from}:${to}`,
      targetTable: 'task_relationships',
    };
  }

  private async missingEndpoint(
    ctx: StageContext,
    item: MigrationRunItemRow,
    sourceId: string,
  ): Promise<ItemOutcome> {
    const { data, error } = await this.db
      .from('migration_run_items')
      .select('status')
      .eq('organization_id', ctx.orgId)
      .eq('run_id', ctx.run.id)
      .eq('entity_type', ISSUE_ENTITY)
      .eq('item_kind', 'entity')
      .eq('source_ref', sourceId)
      .maybeSingle();
    if (error)
      throw new Error(
        `Could not inspect link endpoint ${sourceId}: ${error.message}`,
      );
    if (!data) {
      const reason = `Link endpoint ${sourceId} is absent from this run's source inventory; reference preserved, scope unchanged`;
      await ctx.log('warn', reason, {
        sourceRef: item.source_ref,
        endpointSourceId: sourceId,
        reason: 'endpoint_absent_from_run_inventory',
      });
      return { kind: 'skipped', reason };
    }
    if (['failed', 'dead', 'cancelled', 'skipped'].includes(data.status)) {
      throw new MigrationItemError(
        'permanent',
        `Selected link endpoint ${sourceId} did not import (${data.status}); repair the issue and retry this link ${item.source_ref}`,
      );
    }
    return {
      kind: 'blocked',
      waitingFor: { entityType: ISSUE_ENTITY, sourceId },
    };
  }

  /** The mapped task id for an issue, or null. */
  private async gate(
    ctx: StageContext,
    issueSourceId: string,
  ): Promise<string | null> {
    const row = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      ISSUE_ENTITY,
      issueSourceId,
    );

    if (!row) return null;
    if (row.status === 'mapped') return row.target_id;
    if (row.status === 'planned' && ctx.dryRun) return row.target_id;

    return null;
  }

  /**
   * Import one Jira remote link as a task comment carrying the URL.
   *
   * A remote link is how a document (PDF, Confluence page, external system) is attached to a
   * Jira issue as a LINK, and it lives on its own REST resource — which is why these references
   * used to vanish during migration. The comment preserves the source title and URL verbatim.
   * Idempotent through the crosswalk like every other link item.
   */
  private async processRemoteLink(
    ctx: StageContext,
    item: MigrationRunItemRow,
    payload: { issueSourceId: string; remoteLink: NormalizedRemoteLink },
  ): Promise<ItemOutcome> {
    const { issueSourceId, remoteLink } = payload;
    const sourceRef = item.source_ref ?? '';

    const existing = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      LINK_ENTITY,
      sourceRef,
    );

    if (existing?.status === 'mapped') {
      return { kind: 'skipped', reason: 'remote link already mapped' };
    }

    const taskId = await this.gate(ctx, issueSourceId);

    if (!taskId) {
      return this.missingEndpoint(ctx, item, issueSourceId);
    }

    const title = remoteLink.title || remoteLink.url;

    if (ctx.dryRun) {
      await ctx.entityMap.recordMapping({
        orgId: ctx.orgId,
        connectionId: ctx.job.connection_id,
        jobId: ctx.job.id,
        runId: ctx.run.id,
        entityType: LINK_ENTITY,
        sourceId: sourceRef,
        sourceKey: 'remotelink',
        targetTable: 'task_comments',
        targetId: `planned:${sourceRef}`,
        status: 'planned',
        metadata: { url: remoteLink.url, title },
      });

      return { kind: 'planned' };
    }

    // Escape the title so a source title containing HTML cannot inject markup.
    const safeTitle = title
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const safeUrl = remoteLink.url
      .replace(/"/g, '%22')
      .replace(/</g, '%3C')
      .replace(/>/g, '%3E');
    const content =
      `<p>Linked document (from Jira): <a href="${safeUrl}">${safeTitle}</a></p>` +
      (remoteLink.summary
        ? `<p>${remoteLink.summary
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')}</p>`
        : '');

    const { data, error } = (await this.db
      .from('task_comments')
      .insert({
        task_id: taskId,
        organization_id: ctx.orgId,
        content,
        created_by: requireActingUser(ctx),
      })
      .select('id')
      .single()) as {
      data: { id: string } | null;
      error: { message: string } | null;
    };

    if (error || !data) {
      throw new MigrationItemError(
        'transient',
        `Remote-link comment insert failed for ${sourceRef}: ${error?.message ?? 'no row returned'}`,
      );
    }

    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: ctx.run.id,
      entityType: LINK_ENTITY,
      sourceId: sourceRef,
      sourceKey: 'remotelink',
      targetTable: 'task_comments',
      targetId: data.id,
      status: 'mapped',
      metadata: { url: remoteLink.url, title },
    });

    return {
      kind: 'created',
      targetId: data.id,
      targetTable: 'task_comments',
    };
  }

  /** Read this org's live relation types. */
  private async loadRelationTypes(
    ctx: StageContext,
  ): Promise<RelationTypeRow[]> {
    const { data, error } = (await this.db
      .from('relation_types')
      .select('id, name')
      .eq('organization_id', ctx.orgId)
      .or('is_deleted.is.null,is_deleted.eq.false')) as {
      data: RelationTypeRow[] | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new MigrationItemError(
        'transient',
        `Relation-type lookup failed: ${error.message}`,
      );
    }

    return data ?? [];
  }

  /**
   * Jira link-type name → this ORG's `relation_types.id`.
   *
   * Ladder: exact name, then a known spelling hint, then CREATE, then a generic type.
   *
   * The create rung is the point of this method. Previously the ladder ended at "any active type",
   * which meant an unrecognised Jira link type was not dropped but silently RELABELLED — a "Causes"
   * link arrived as "Relates" and nothing recorded that its meaning had been discarded. Creating the
   * missing type keeps the edge honest; the generic fallback survives only for the case where the
   * create itself fails, and it now logs the loss.
   */
  private async resolveRelationType(
    ctx: StageContext,
    jiraTypeName: string,
  ): Promise<string | null> {
    const rows = await this.loadRelationTypes(ctx);
    const match = matchRelationType(jiraTypeName, rows);

    if (match.action !== 'none') return match.id;

    const created = await this.createRelationType(ctx, jiraTypeName);

    if (created) return created;

    // Create failed AND nothing matched. Re-read once: under parallel link items another item may
    // have created this very type between our lookup and now.
    const reread = await this.loadRelationTypes(ctx);
    const second = matchRelationType(jiraTypeName, reread);

    if (second.action !== 'none') return second.id;

    const fallback = fallbackRelationType(reread);

    if (!fallback) return null;

    // Lossy, so it must be auditable rather than merely happening.
    await ctx.log(
      'warn',
      `links: Jira link type "${jiraTypeName}" could not be matched or created — ` +
        `recorded as "${fallback.name}", so this link's specific meaning is lost`,
      { jiraTypeName, fellBackTo: fallback.name },
    );

    return fallback.id;
  }

  /**
   * Create the missing relation type, using the SOURCE's own directional labels.
   *
   * Link items run in PARALLEL, so N items referencing the same unknown type will race N creates.
   * Exactly one wins; the losers must adopt rather than fail. Both failure shapes are caught:
   * `assertNameUnique` throws `ConflictException`, but a race that slips past it reaches the insert
   * and `RelationTypesService.create` wraps every insert error in `BadRequestException` — including
   * a duplicate-key violation. Catching only `ConflictException` would leave that second path
   * escaping as a `transient` error, retrying a deterministic failure until the item died.
   *
   * @returns The new type's id, or `null` when the type could not be created for any reason.
   */
  private async createRelationType(
    ctx: StageContext,
    jiraTypeName: string,
  ): Promise<string | null> {
    // The DTO caps name at 100 and descriptions at 255, and those limits are enforced by
    // class-validator, so an over-long Jira type name would be rejected rather than truncated.
    const name = jiraTypeName.trim().slice(0, 100);

    if (!name) return null;

    const descriptions = await this.linkTypeDescriptions(ctx, name);
    const dto: CreateRelationTypeDto = {
      name,
      outward_description: descriptions.outward.slice(0, 255),
      inward_description: descriptions.inward.slice(0, 255),
      is_directional: true,
    };

    try {
      const created = await this.relationTypesService.create(
        ctx.orgId,
        requireActingUser(ctx),
        dto,
      );

      await ctx.log(
        'info',
        `links: created relation type "${name}" from the Jira link type of the same name`,
        { jiraTypeName: name },
      );

      return created.id;
    } catch (err) {
      const message = (err as Error)?.message ?? '';
      const isDuplicate =
        err instanceof ConflictException ||
        /duplicate key|23505|already exists/i.test(message);

      if (!isDuplicate) {
        await ctx.log(
          'warn',
          `links: could not create relation type "${name}": ${message}`,
          { jiraTypeName: name },
        );
      }

      return null;
    }
  }

  /**
   * Both directional labels for a Jira link type, read from the source.
   *
   * `NormalizedLink.relationName` only carries the label for the direction the link was seen from,
   * so reconstructing a type from a link alone would invent half of it ("blocks" → "is blocks by").
   * The instance-wide type list is fetched instead.
   *
   * Deliberately NOT memoized on the instance. Stages are Nest singletons, so a field cache would
   * outlive the run and be reused for the NEXT job — a different connection, pointing at a different
   * Jira, whose link types are not these. The fetch only happens on the rare unmatched-type path, so
   * re-reading is far cheaper than a wrong answer that persists until the process restarts.
   *
   * Falls back to the type name for both labels when the list is unreadable: visibly plain beats
   * visibly wrong.
   */
  private async linkTypeDescriptions(
    ctx: StageContext,
    name: string,
  ): Promise<{ outward: string; inward: string }> {
    const adapter = await ctx.getAdapter();
    const types = isJiraAdapter(adapter)
      ? await adapter.getIssueLinkTypes()
      : [];
    const wanted = name.trim().toLowerCase();
    const hit = types.find((t) => t.name.trim().toLowerCase() === wanted);

    return {
      outward: hit?.outward || name,
      inward: hit?.inward || name,
    };
  }
}
