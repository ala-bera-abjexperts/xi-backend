/**
 * @fileoverview Source↔target crosswalk (`migration_entity_map`) — the referential-integrity
 * and idempotency backbone. Every cross-entity reference a stage writes MUST resolve through
 * here; a missing row means the item gets `blocked`, so the engine physically cannot write a
 * dangling reference. Dry-run records `planned` rows (validating gates without target writes);
 * a later live run overwrites them with real `mapped` targets via upsert.
 *
 * All queries hand-scope `organization_id` — the service-role client bypasses RLS.
 */

import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { pageReferenceKey } from '../transformers/canonical-ir';

const TABLE = 'migration_entity_map';

export type ValidatedMigrationTargetTable =
  | 'spaces'
  | 'tasks'
  | 'task_comments'
  | 'file_attachments'
  | 'status_categories'
  | 'task_statuses';

/**
 * Rows whose meaning belongs to one migrated Jira project/space. When that space was deleted,
 * these mappings must be replayed. Organization-wide identities deliberately stay out: users,
 * groups, priorities and resolutions remain reusable across projects.
 */
const STALE_SPACE_PROJECT_ENTITIES = [
  'space',
  'role',
  'issue_type',
  'field_group',
  'workflow',
  'workflow_assignment',
  'issue',
  'watcher',
  'board',
  'board_card',
  'sprint',
  'link',
  'comment',
  'attachment',
  'history',
] as const;

export type EntityMapStatus =
  | 'mapped'
  | 'placeholder'
  | 'planned'
  | 'skipped'
  | 'failed';

export interface MigrationEntityMapRow {
  id: string;
  organization_id: string;
  source_connection_id: string;
  job_id: string | null;
  run_id: string | null;
  entity_type: string;
  source_id: string;
  source_key: string | null;
  target_table: string | null;
  target_id: string;
  status: EntityMapStatus;
  match_method: string | null;
  is_placeholder: boolean;
  source_email: string | null;
  source_hash: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface RecordMappingInput {
  orgId: string;
  connectionId: string;
  jobId?: string | null;
  runId?: string | null;
  entityType: string;
  sourceId: string;
  sourceKey?: string | null;
  targetTable?: string | null;
  targetId: string;
  status?: EntityMapStatus;
  matchMethod?: string | null;
  isPlaceholder?: boolean;
  sourceEmail?: string | null;
  sourceHash?: string | null;
  metadata?: Record<string, unknown>;
}

export interface PageReference {
  sourceId: string;
  sourceSpaceKey?: string;
}

export interface ResolvedWikiPageTarget {
  pageId: string;
  pageSlug?: string;
  spaceKey?: string;
  title?: string;
}

export interface ResolvedAttachmentTarget {
  attachmentId: string;
}

export type SpaceTargetState =
  | 'unmapped'
  | 'planned'
  | 'active'
  | 'archived'
  | 'missing';

export interface SpaceTargetInspection {
  mapping: MigrationEntityMapRow | null;
  state: SpaceTargetState;
}

export type ValidatedWikiChildTargetTable =
  | 'wiki_page_attachments'
  | 'wiki_page_comments';

const CONFLUENCE_SPACE_ENTITIES = [
  'space',
  'page',
  'confluence_page_watcher',
  'confluence_space_watcher',
  'page_attachment',
  'page_comment',
  'page_labels',
  'page_restriction',
  // Revision crosswalks are space-scoped like everything else here. Leaving them out would let
  // stale-space recovery drop the page/attachment rows while orphaning their version rows, so a
  // re-import would then believe every revision was already migrated.
  'page_version',
  'page_attachment_version',
] as const;

@Injectable()
export class MigrationEntityMapService {
  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  async getTarget(
    orgId: string,
    connectionId: string,
    entityType: string,
    sourceId: string,
  ): Promise<MigrationEntityMapRow | null> {
    const { data, error } = (await this.db
      .from(TABLE)
      .select('*')
      .eq('organization_id', orgId)
      .eq('source_connection_id', connectionId)
      .eq('entity_type', entityType)
      .eq('source_id', sourceId)
      .maybeSingle()) as {
      data: MigrationEntityMapRow | null;
      error: { message: string } | null;
    };

    if (error)
      throw new BadRequestException(
        `Crosswalk lookup failed: ${error.message}`,
      );

    return data;
  }

  /**
   * A typed idempotency lookup that refuses a mapped row after its physical target was deleted.
   * Kept separate from getTarget: many valid crosswalk rows use composite or non-row target ids.
   */
  async getExistingTarget(
    orgId: string,
    connectionId: string,
    entityType: string,
    sourceId: string,
    targetTable: ValidatedMigrationTargetTable,
  ): Promise<MigrationEntityMapRow | null> {
    const row = await this.getTarget(orgId, connectionId, entityType, sourceId);

    if (!row || (row.status !== 'mapped' && row.status !== 'placeholder')) {
      return row;
    }

    if (row.target_table !== targetTable) return null;

    const { data, error } = (await this.db
      .from(targetTable)
      .select('id')
      .eq('organization_id', orgId)
      .eq('id', row.target_id)
      .limit(1)) as {
      data: { id: string }[] | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new BadRequestException(
        `Mapped ${entityType} target lookup failed: ${error.message}`,
      );
    }

    return (data ?? []).length > 0 ? row : null;
  }

  /** Inspect a mapped space without treating an archived row as a usable migration target. */
  async inspectSpaceTarget(
    orgId: string,
    connectionId: string,
    sourceId: string,
  ): Promise<SpaceTargetInspection> {
    const mapping = await this.getTarget(
      orgId,
      connectionId,
      'space',
      sourceId,
    );

    if (!mapping) return { mapping: null, state: 'unmapped' };
    if (mapping.status === 'planned') return { mapping, state: 'planned' };
    if (mapping.status !== 'mapped' || mapping.target_table !== 'spaces') {
      return { mapping, state: 'unmapped' };
    }

    const { data, error } = (await this.db
      .from('spaces')
      .select('id, is_archived')
      .eq('organization_id', orgId)
      .eq('id', mapping.target_id)
      .limit(1)) as {
      data: { id: string; is_archived: boolean | null }[] | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new BadRequestException(
        `Mapped space target lookup failed: ${error.message}`,
      );
    }

    const space = data?.[0];
    if (!space) return { mapping, state: 'missing' };

    return {
      mapping,
      state: space.is_archived ? 'archived' : 'active',
    };
  }

  /** Exact mapped wiki page whose physical row still belongs to the expected space. */
  async getExistingWikiPageTarget(
    orgId: string,
    connectionId: string,
    sourceId: string,
    expectedSpaceId?: string,
  ): Promise<MigrationEntityMapRow | null> {
    const row = await this.getTarget(orgId, connectionId, 'page', sourceId);

    if (!row || row.status !== 'mapped' || row.target_table !== 'wiki_pages') {
      return row;
    }

    let query = this.db
      .from('wiki_pages')
      .select('id')
      .eq('organization_id', orgId)
      .eq('is_archived', false)
      .eq('id', row.target_id);

    if (expectedSpaceId) query = query.eq('space_id', expectedSpaceId);

    const { data, error } = (await query.limit(1)) as {
      data: { id: string }[] | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new BadRequestException(
        `Mapped wiki page target lookup failed: ${error.message}`,
      );
    }

    return (data ?? []).length > 0 ? row : null;
  }

  /** Exact mapped wiki attachment/comment whose physical row still belongs to its owning page. */
  async getExistingWikiChildTarget(
    orgId: string,
    connectionId: string,
    entityType: 'page_attachment' | 'page_comment',
    sourceId: string,
    targetTable: ValidatedWikiChildTargetTable,
    expectedPageId: string,
  ): Promise<MigrationEntityMapRow | null> {
    const row = await this.getTarget(orgId, connectionId, entityType, sourceId);

    if (!row || row.status !== 'mapped' || row.target_table !== targetTable) {
      return row;
    }

    const { data, error } = (await this.db
      .from(targetTable)
      .select('id')
      .eq('id', row.target_id)
      .eq('wiki_page_id', expectedPageId)
      .limit(1)) as {
      data: { id: string }[] | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new BadRequestException(
        `Mapped ${entityType} target lookup failed: ${error.message}`,
      );
    }

    return (data ?? []).length > 0 ? row : null;
  }

  /** Custom-field mappings use field_key as target_id; the physical UUID lives in metadata. */
  async getExistingCustomFieldTarget(
    orgId: string,
    connectionId: string,
    sourceId: string,
  ): Promise<MigrationEntityMapRow | null> {
    const row = await this.getTarget(
      orgId,
      connectionId,
      'custom_field',
      sourceId,
    );

    if (
      !row ||
      row.status !== 'mapped' ||
      row.target_table !== 'custom_fields'
    ) {
      return row;
    }

    const targetId = row.metadata?.custom_field_id;
    if (typeof targetId !== 'string' || !targetId) return null;

    const { data, error } = (await this.db
      .from('custom_fields')
      .select('id')
      .eq('organization_id', orgId)
      .eq('id', targetId)
      .limit(1)) as {
      data: { id: string }[] | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new BadRequestException(
        `Mapped custom field target lookup failed: ${error.message}`,
      );
    }

    return (data ?? []).length > 0 ? row : null;
  }

  /**
   * Clear one deleted space's project-local recovery state. Called only after the space mapping was
   * physically checked and found stale; later stages then recreate or adopt their targets normally.
   */
  async recoverStaleSpaceMappings(
    orgId: string,
    connectionId: string,
    jobId: string,
  ): Promise<void> {
    const { error } = await this.db
      .from(TABLE)
      .delete()
      .eq('organization_id', orgId)
      .eq('source_connection_id', connectionId)
      .eq('job_id', jobId)
      .in('entity_type', [...STALE_SPACE_PROJECT_ENTITIES]);

    if (error) {
      throw new BadRequestException(
        `Stale project crosswalk cleanup failed: ${error.message}`,
      );
    }
  }

  /**
   * Invalidate one deleted Confluence space and only the page-owned rows beneath that source space.
   * Other spaces on the same connection and Jira mappings are deliberately retained.
   */
  async recoverStaleConfluenceSpaceMappings(
    orgId: string,
    connectionId: string,
    sourceSpaceRef: string,
    staleSpaceTargetId: string,
  ): Promise<void> {
    type RecoveryRow = Pick<
      MigrationEntityMapRow,
      'id' | 'entity_type' | 'source_id' | 'target_id' | 'metadata'
    >;
    const rows: RecoveryRow[] = [];

    for (let offset = 0; ; offset += 1000) {
      const { data, error } = (await this.db
        .from(TABLE)
        .select('id, entity_type, source_id, target_id, metadata')
        .eq('organization_id', orgId)
        .eq('source_connection_id', connectionId)
        .order('id', { ascending: true })
        .range(offset, offset + 999)
        .in('entity_type', [...CONFLUENCE_SPACE_ENTITIES])) as {
        data: RecoveryRow[] | null;
        error: { message: string } | null;
      };

      if (error) {
        throw new BadRequestException(
          `Stale Confluence crosswalk lookup failed: ${error.message}`,
        );
      }

      const page = data ?? [];
      rows.push(...page);
      if (page.length < 1000) break;
    }
    const staleSpace = rows.find(
      (row) =>
        row.entity_type === 'space' &&
        row.source_id === sourceSpaceRef &&
        row.target_id === staleSpaceTargetId,
    );

    // A concurrent run may already have replaced the space mapping. Never erase its fresh children.
    if (!staleSpace) return;

    const pages = rows.filter(
      (row) =>
        row.entity_type === 'page' &&
        row.metadata?.space_ref === sourceSpaceRef,
    );
    const pageSourceIds = new Set(pages.map((row) => row.source_id));
    const owned = rows.filter((row) => {
      if (row.id === staleSpace.id) return true;
      if (row.entity_type === 'page') return pages.includes(row);

      if (
        row.entity_type === 'page_labels' ||
        row.entity_type === 'page_restriction'
      ) {
        return pageSourceIds.has(row.source_id);
      }

      if (row.entity_type === 'confluence_space_watcher') {
        return row.metadata?.resource_source_id === sourceSpaceRef;
      }

      if (row.entity_type === 'confluence_page_watcher') {
        return (
          typeof row.metadata?.resource_source_id === 'string' &&
          pageSourceIds.has(row.metadata.resource_source_id)
        );
      }

      return (
        (row.entity_type === 'page_attachment' ||
          row.entity_type === 'page_comment') &&
        typeof row.metadata?.page_source_id === 'string' &&
        pageSourceIds.has(row.metadata.page_source_id)
      );
    });

    // Delete descendants first and compare every old target id. If another run has already
    // replaced a row, its new target survives. Keeping the stale space mapping until last also
    // makes an interrupted cleanup safely retryable.
    for (const row of owned) {
      if (row === staleSpace) continue;

      await this.deleteExactStaleMapping(
        orgId,
        connectionId,
        row.entity_type,
        row.source_id,
        row.target_id,
      );
    }

    await this.deleteExactStaleMapping(
      orgId,
      connectionId,
      staleSpace.entity_type,
      staleSpace.source_id,
      staleSpace.target_id,
    );
  }

  /** Delete a stale row only while its exact source and target identity still match. */
  async deleteExactStaleMapping(
    orgId: string,
    connectionId: string,
    entityType: string,
    sourceId: string,
    staleTargetId: string,
  ): Promise<boolean> {
    const { data, error } = (await this.db
      .from(TABLE)
      .delete()
      .eq('organization_id', orgId)
      .eq('source_connection_id', connectionId)
      .eq('entity_type', entityType)
      .eq('source_id', sourceId)
      .eq('target_id', staleTargetId)
      .select('id')
      .maybeSingle()) as {
      data: { id: string } | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new BadRequestException(
        `Exact stale crosswalk cleanup failed: ${error.message}`,
      );
    }

    return Boolean(data);
  }

  /**
   * Every crosswalk row of one entity type for a connection — the JQL transpiler's raw material
   * (status/priority/type/user/custom-field name→target maps are built from these).
   *
   * Hand-scoped by org AND connection: the service-role client bypasses RLS, and a connection is
   * the unit of source identity.
   */
  async listByEntityType(
    orgId: string,
    connectionId: string,
    entityType: string,
  ): Promise<MigrationEntityMapRow[]> {
    const rows: MigrationEntityMapRow[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await this.db
        .from(TABLE)
        .select('*')
        .eq('organization_id', orgId)
        .eq('source_connection_id', connectionId)
        .eq('entity_type', entityType)
        .order('id', { ascending: true })
        .range(offset, offset + 999);
      if (error)
        throw new BadRequestException(
          `Crosswalk list failed: ${error.message}`,
        );
      const page = (data ?? []) as MigrationEntityMapRow[];
      rows.push(...page);
      if (page.length < 1000) return rows;
    }
  }

  /** Source aliases are never local IDs: resolve only through this connection's crosswalk. */
  async resolveProfileTargets(
    orgId: string,
    connectionId: string,
    spaceId: string,
    references: string[],
  ): Promise<Map<string, { userId?: string; displayName?: string }>> {
    const result = new Map<string, { userId?: string; displayName?: string }>();
    const refs = [
      ...new Set(references.map((ref) => ref.trim()).filter(Boolean)),
    ];
    if (!refs.length) return result;
    const { data: space, error: spaceError } = await this.db
      .from('spaces')
      .select('id')
      .eq('organization_id', orgId)
      .eq('id', spaceId)
      .maybeSingle();
    if (spaceError)
      throw new BadRequestException('Profile target space lookup failed');
    if (!space) return result;

    for (let start = 0; start < refs.length; start += 100) {
      const chunk = refs.slice(start, start + 100);
      const rows = new Map<string, MigrationEntityMapRow>();
      for (const column of ['source_id', 'source_key']) {
        for (let offset = 0; ; offset += 1000) {
          const { data, error } = await this.db
            .from(TABLE)
            .select('*')
            .eq('organization_id', orgId)
            .eq('source_connection_id', connectionId)
            .eq('entity_type', 'user')
            .in(column, chunk)
            .order('id', { ascending: true })
            .range(offset, offset + 999);
          if (error)
            throw new BadRequestException('Profile crosswalk lookup failed');
          for (const row of data ?? [])
            rows.set(row.id, row as MigrationEntityMapRow);
          if ((data ?? []).length < 1000) break;
        }
      }
      const candidates = new Map<string, string>();
      for (const ref of chunk) {
        const matches = [...rows.values()].filter(
          (row) => row.source_id === ref || row.source_key === ref,
        );
        const names = [
          ...new Set(
            matches
              .map((row) => row.metadata?.display_name)
              .filter(
                (name): name is string =>
                  typeof name === 'string' && !!name.trim(),
              ),
          ),
        ];
        result.set(ref, names.length === 1 ? { displayName: names[0] } : {});
        const ids = [
          ...new Set(
            matches
              .filter(
                (row) =>
                  row.status === 'mapped' &&
                  !row.is_placeholder &&
                  row.target_table === 'users',
              )
              .map((row) => row.target_id),
          ),
        ];
        // Decide ambiguity before membership filtering; visibility must never choose an identity.
        if (ids.length === 1 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ids[0]))
          candidates.set(ref, ids[0]);
      }
      const ids = [...new Set(candidates.values())];
      if (!ids.length) continue;
      const allowed: Set<string>[] = [];
      for (const table of ['users', 'organization_members', 'space_members']) {
        const visible = new Set<string>();
        const column = table === 'users' ? 'id' : 'user_id';
        for (let offset = 0; ; offset += 1000) {
          let query = this.db.from(table).select(column).in(column, ids);
          if (table === 'organization_members')
            query = query.eq('organization_id', orgId);
          else query = query.eq('is_active', true);
          if (table === 'space_members') query = query.eq('space_id', spaceId);
          const { data, error } = await query
            .order('id', { ascending: true })
            .range(offset, offset + 999);
          if (error)
            throw new BadRequestException(
              'Profile target membership lookup failed',
            );
          for (const row of data ?? []) visible.add(row[column]);
          if ((data ?? []).length < 1000) break;
        }
        allowed.push(visible);
      }
      for (const [ref, userId] of candidates) {
        if (allowed.every((set) => set.has(userId)))
          result.set(ref, { ...result.get(ref), userId });
      }
    }
    return result;
  }

  /** Batch lookup — returns a Map keyed by source_id (only found rows present). */
  async getTargets(
    orgId: string,
    connectionId: string,
    entityType: string,
    sourceIds: string[],
  ): Promise<Map<string, MigrationEntityMapRow>> {
    const result = new Map<string, MigrationEntityMapRow>();

    if (sourceIds.length === 0) return result;

    // Chunk to keep the IN() list bounded.
    for (let i = 0; i < sourceIds.length; i += 200) {
      const chunk = sourceIds.slice(i, i + 200);

      const { data, error } = (await this.db
        .from(TABLE)
        .select('*')
        .eq('organization_id', orgId)
        .eq('source_connection_id', connectionId)
        .eq('entity_type', entityType)
        .in('source_id', chunk)) as {
        data: MigrationEntityMapRow[] | null;
        error: { message: string } | null;
      };

      if (error)
        throw new BadRequestException(
          `Crosswalk batch lookup failed: ${error.message}`,
        );

      for (const row of data ?? []) result.set(row.source_id, row);
    }

    return result;
  }

  /** Exact Jira source key → live target task key for single-work-item wiki embeds. */
  async resolveIssueTargets(
    orgId: string,
    connectionId: string,
    sourceKeys: string[],
  ): Promise<Map<string, { taskKey: string }>> {
    const keys = [
      ...new Set(sourceKeys.map((key) => key.trim()).filter(Boolean)),
    ].slice(0, 200);
    const result = new Map<string, { taskKey: string }>();

    if (keys.length === 0) return result;

    const { data: rows, error } = (await this.db
      .from(TABLE)
      .select('source_key, target_id')
      .eq('organization_id', orgId)
      .eq('source_connection_id', connectionId)
      .eq('entity_type', 'issue')
      .eq('status', 'mapped')
      .in('source_key', keys)) as {
      data: { source_key: string | null; target_id: string }[] | null;
      error: { message: string } | null;
    };

    if (error)
      throw new BadRequestException(
        `Issue crosswalk lookup failed: ${error.message}`,
      );

    const targetIds = [
      ...new Set((rows ?? []).map((row) => row.target_id).filter(Boolean)),
    ];

    if (targetIds.length === 0) return result;

    const { data: tasks, error: taskError } = (await this.db
      .from('tasks')
      .select('id, key')
      .eq('organization_id', orgId)
      .in('id', targetIds)) as {
      data: { id: string; key: string | null }[] | null;
      error: { message: string } | null;
    };

    if (taskError)
      throw new BadRequestException(
        `Mapped task lookup failed: ${taskError.message}`,
      );

    const taskKeyById = new Map(
      (tasks ?? [])
        .filter((task) => !!task.key)
        .map((task) => [task.id, task.key!]),
    );

    for (const row of rows ?? []) {
      const taskKey = taskKeyById.get(row.target_id);

      if (row.source_key && taskKey) result.set(row.source_key, { taskKey });
    }

    return result;
  }

  /** Exact Jira attachment ids whose mapped unified attachment still exists. */
  async resolveAttachmentTargets(
    orgId: string,
    connectionId: string,
    sourceIds: string[],
  ): Promise<Map<string, ResolvedAttachmentTarget>> {
    const ids = [
      ...new Set(sourceIds.map((id) => id.trim()).filter(Boolean)),
    ].slice(0, 200);
    const result = new Map<string, ResolvedAttachmentTarget>();

    if (ids.length === 0) return result;

    const { data: rows, error } = (await this.db
      .from(TABLE)
      .select('source_id, target_id')
      .eq('organization_id', orgId)
      .eq('source_connection_id', connectionId)
      .eq('entity_type', 'attachment')
      .eq('status', 'mapped')
      .in('source_id', ids)) as {
      data: { source_id: string; target_id: string }[] | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new BadRequestException(
        `Attachment crosswalk lookup failed: ${error.message}`,
      );
    }

    const targetIds = [
      ...new Set((rows ?? []).map((row) => row.target_id).filter(Boolean)),
    ];

    if (targetIds.length === 0) return result;

    const { data: attachments, error: attachmentError } = (await this.db
      .from('file_attachments')
      .select('id')
      .eq('organization_id', orgId)
      .in('id', targetIds)) as {
      data: { id: string }[] | null;
      error: { message: string } | null;
    };

    if (attachmentError) {
      throw new BadRequestException(
        `Mapped attachment lookup failed: ${attachmentError.message}`,
      );
    }

    const existing = new Set(
      (attachments ?? []).map((attachment) => attachment.id),
    );

    for (const row of rows ?? []) {
      if (existing.has(row.target_id)) {
        result.set(row.source_id, { attachmentId: row.target_id });
      }
    }

    return result;
  }

  /**
   * Resolve wiki page references to their actual target page and space route.
   *
   * Confluence Server storage only supplies a page title plus an optional `ri:space-key`; a title
   * is not connection-unique. Prefer a direct source-id mapping (ADF), then fall back to the page
   * mapping's source_key scoped by metadata.space_ref. Ambiguous legacy title rows intentionally
   * stay unresolved rather than creating a link to the wrong space.
   */
  async resolveWikiPageTargets(
    orgId: string,
    connectionId: string,
    references: PageReference[],
  ): Promise<Map<string, ResolvedWikiPageTarget>> {
    const unique = new Map<string, PageReference>();

    for (const ref of references) {
      if (!ref.sourceId) continue;
      unique.set(pageReferenceKey(ref.sourceId, ref.sourceSpaceKey), ref);
    }
    if (unique.size === 0) return new Map();

    const refs = [...unique.values()];
    const direct = await this.getTargets(
      orgId,
      connectionId,
      'page',
      refs.filter((ref) => !ref.sourceSpaceKey).map((ref) => ref.sourceId),
    );
    const matches = new Map<string, MigrationEntityMapRow>();

    for (const ref of refs) {
      if (ref.sourceSpaceKey) continue;
      const row = direct.get(ref.sourceId);

      if (row?.status === 'mapped' && row.target_id) {
        matches.set(pageReferenceKey(ref.sourceId), row);
      }
    }

    const unresolved = refs.filter(
      (ref) => !matches.has(pageReferenceKey(ref.sourceId, ref.sourceSpaceKey)),
    );
    const titles = [...new Set(unresolved.map((ref) => ref.sourceId))];

    if (titles.length > 0) {
      const { data, error } = (await this.db
        .from(TABLE)
        .select('*')
        .eq('organization_id', orgId)
        .eq('source_connection_id', connectionId)
        .eq('entity_type', 'page')
        .eq('status', 'mapped')
        .in('source_key', titles)) as {
        data: MigrationEntityMapRow[] | null;
        error: { message: string } | null;
      };

      if (error) {
        throw new BadRequestException(
          `Page-title crosswalk lookup failed: ${error.message}`,
        );
      }

      for (const ref of unresolved) {
        const candidates = (data ?? []).filter(
          (row) =>
            row.source_key === ref.sourceId &&
            (!ref.sourceSpaceKey ||
              row.metadata?.space_ref === ref.sourceSpaceKey),
        );

        if (candidates.length === 1) {
          matches.set(
            pageReferenceKey(ref.sourceId, ref.sourceSpaceKey),
            candidates[0],
          );
        }
      }
    }

    const targetIds = [
      ...new Set([...matches.values()].map((row) => row.target_id)),
    ];

    if (targetIds.length === 0) return new Map();

    const { data: pages, error: pagesError } = (await this.db
      .from('wiki_pages')
      .select('id, slug, space_id')
      .eq('organization_id', orgId)
      .in('id', targetIds)) as {
      data:
        | { id: string; slug: string | null; space_id: string | null }[]
        | null;
      error: { message: string } | null;
    };

    if (pagesError) {
      throw new BadRequestException(
        `Target wiki-page lookup failed: ${pagesError.message}`,
      );
    }

    const pageById = new Map((pages ?? []).map((page) => [page.id, page]));
    const spaceIds = [
      ...new Set(
        (pages ?? [])
          .map((page) => page.space_id)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const spaceKeys = new Map<string, string>();

    if (spaceIds.length > 0) {
      const { data: spaces, error: spacesError } = (await this.db
        .from('spaces')
        .select('id, key')
        .eq('organization_id', orgId)
        .in('id', spaceIds)) as {
        data: { id: string; key: string | null }[] | null;
        error: { message: string } | null;
      };

      if (spacesError) {
        throw new BadRequestException(
          `Target wiki-space lookup failed: ${spacesError.message}`,
        );
      }

      for (const space of spaces ?? []) {
        if (space.key) spaceKeys.set(space.id, space.key);
      }
    }

    const resolved = new Map<string, ResolvedWikiPageTarget>();

    for (const [key, row] of matches) {
      const page = pageById.get(row.target_id);

      if (!page) continue;
      resolved.set(key, {
        pageId: page.id,
        ...(page.slug ? { pageSlug: page.slug } : {}),
        ...(page.space_id && spaceKeys.get(page.space_id)
          ? { spaceKey: spaceKeys.get(page.space_id) }
          : {}),
        ...(typeof row.metadata?.title === 'string'
          ? { title: row.metadata.title }
          : {}),
      });
    }

    return resolved;
  }

  /**
   * Every attachment mapped for one page. Attachment rows are keyed `${pageSourceId}:${filename}`,
   * so a prefix match enumerates the page's whole set — needed by the `attachments` macro, which
   * lists ALL of a page's files, not just the ones inlined in the body.
   */
  async listPageAttachments(
    orgId: string,
    connectionId: string,
    pageSourceId: string,
  ): Promise<MigrationEntityMapRow[]> {
    // `%`/`_`/`\` in a page id would alter LIKE semantics — escape them.
    const prefix = pageSourceId.replace(/([%_\\])/g, '\\$1');

    const { data, error } = (await this.db
      .from(TABLE)
      .select('*')
      .eq('organization_id', orgId)
      .eq('source_connection_id', connectionId)
      .eq('entity_type', 'page_attachment')
      .eq('status', 'mapped')
      .like('source_id', `${prefix}:%`)
      .order('created_at', { ascending: true })) as {
      data: MigrationEntityMapRow[] | null;
      error: { message: string } | null;
    };

    if (error)
      throw new BadRequestException(
        `Crosswalk attachment lookup failed: ${error.message}`,
      );

    return data ?? [];
  }

  /**
   * Source ids of the custom fields this connection actually MATERIALISED as XISUITE custom fields
   * (`metadata.outcome = 'custom_field'`).
   *
   * The issues stage asks the source for exactly these and no others. Requesting `*navigable`
   * instead would drag the devstatus blob — a multi-KB serialized Java object present on EVERY
   * issue — through the whole project, while listing only system fields (the previous behaviour)
   * fetched no custom values at all, so `custom_field_values` was empty on every migrated task even
   * though the definitions had migrated correctly.
   *
   * Filtering on the outcome is what keeps this precise: fields the registry SKIPPED (LexoRank,
   * JPO scheduling, devstatus) never materialised, so they are excluded here by construction rather
   * than by a second hand-maintained deny-list that could drift.
   */
  async listMappedCustomFieldSourceIds(
    orgId: string,
    connectionId: string,
  ): Promise<string[]> {
    const { data, error } = (await this.db
      .from(TABLE)
      .select('source_id, metadata')
      .eq('organization_id', orgId)
      .eq('source_connection_id', connectionId)
      .eq('entity_type', 'custom_field')
      .eq('status', 'mapped')) as {
      data:
        | { source_id: string; metadata: Record<string, unknown> | null }[]
        | null;
      error: { message: string } | null;
    };

    if (error)
      throw new BadRequestException(
        `Crosswalk custom-field lookup failed: ${error.message}`,
      );

    return (data ?? [])
      .filter((row) => row.metadata?.outcome === 'custom_field')
      .map((row) => row.source_id)
      .filter((id) => id.startsWith('customfield_'));
  }

  /**
   * Idempotent upsert on UNIQUE(org, connection, entity_type, source_id) —
   * a re-run overwrites `planned` rows with live `mapped` targets.
   */
  async recordMapping(
    input: RecordMappingInput,
  ): Promise<MigrationEntityMapRow> {
    const { data, error } = (await this.db
      .from(TABLE)
      .upsert(
        {
          organization_id: input.orgId,
          source_connection_id: input.connectionId,
          job_id: input.jobId ?? null,
          run_id: input.runId ?? null,
          entity_type: input.entityType,
          source_id: input.sourceId,
          source_key: input.sourceKey ?? null,
          target_table: input.targetTable ?? null,
          target_id: input.targetId,
          status: input.status ?? 'mapped',
          match_method: input.matchMethod ?? null,
          is_placeholder: input.isPlaceholder === true,
          source_email: input.sourceEmail ?? null,
          source_hash: input.sourceHash ?? null,
          metadata: input.metadata ?? {},
          updated_at: new Date().toISOString(),
        },
        {
          onConflict:
            'organization_id,source_connection_id,entity_type,source_id',
        },
      )
      .select('*')
      .single()) as {
      data: MigrationEntityMapRow | null;
      error: { message: string } | null;
    };

    if (error || !data)
      throw new BadRequestException(
        `Crosswalk write failed: ${error?.message ?? 'no row returned'}`,
      );

    return data;
  }

  /**
   * True when the referenced entity is resolvable for gating purposes:
   * `mapped`/`placeholder` always gate-open; `planned` gates open ONLY in dry-run
   * (a live run must not build on plans that never materialized).
   */
  async isGateOpen(
    orgId: string,
    connectionId: string,
    entityType: string,
    sourceId: string,
    dryRun: boolean,
  ): Promise<boolean> {
    const row = await this.getTarget(orgId, connectionId, entityType, sourceId);

    if (!row) return false;

    if (row.status === 'mapped' || row.status === 'placeholder') return true;

    return dryRun && row.status === 'planned';
  }
}
