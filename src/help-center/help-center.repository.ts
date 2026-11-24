/**
 * @fileoverview Data access layer for Help Center — support request CRUD.
 * Uses the service-role admin client; row-level isolation (creator-or-shared)
 * is enforced here in app code, not RLS — {@link HelpCenterRepository.findVisible}
 * is the single gate every share-aware route goes through.
 * @module src/help-center/help-center.repository
 */

import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { CreateSupportRequestDto } from './dto/create-support-request.dto';
import type { ListSupportRequestsQueryDto } from './dto/list-support-requests-query.dto';
import type { CustomField } from '../custom-fields/models/custom-field.model';
import {
  SUPPORT_REQUEST_PRIORITY_KEYS,
  priorityBucketForLadderRow,
  toSupportRequestPriorityBucket,
  type PriorityLadderRow,
} from './priority.util';

export interface ISupportRequest {
  id: string;
  task_id?: string | null;
  organization_id: string;
  created_by: string;
  ticket_number: number;
  subject: string;
  category: string;
  priority: string;
  /** Org/space-configurable priority (source of truth); `priority` is the legacy bucket. */
  priority_id?: string | null;
  description: string;
  module_affected: string | null;
  space_id: string | null;
  status: string;
  admin_response: string | null;
  resolved_at: string | null;
  request_type: string | null;
  custom_field_values: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type SupportRequestTaskField = Pick<
  CustomField,
  'field_key' | 'field_type' | 'name' | 'validation_rules' | 'options'
>;

export type SupportRequestViewerRole = 'creator' | 'shared';

export interface IEnrichedSupportRequestTask {
  id: string;
  key: string;
  version: number;
  status_id: string | null;
  space_id: string | null;
  status_config: {
    id: string;
    name: string;
    key: string;
    color: string;
    is_completed: boolean;
  } | null;
}

export interface IEnrichedSupportRequestUser {
  id: string;
  first_name: string | null;
  last_name: string | null;
}

/** The configurable priority joined onto a support request, when `priority_id` is set. */
export interface IEnrichedSupportRequestPriority {
  id: string;
  name: string;
  key: string;
  color: string;
}

/** `support_requests.*` plus the joined task / requester / space the portal renders. */
export interface IEnrichedSupportRequest extends ISupportRequest {
  task: IEnrichedSupportRequestTask | null;
  requester: IEnrichedSupportRequestUser | null;
  space: { id: string; name: string; key: string } | null;
  priority_config?: IEnrichedSupportRequestPriority | null;
}

export interface IPortalComment {
  id: string;
  content: string;
  created_at: string;
  author: IEnrichedSupportRequestUser | null;
}

export interface IStatusHistoryRow {
  id: string;
  changed_at: string;
  new_value: unknown;
}

@Injectable()
export class HelpCenterRepository {
  private static readonly TABLE = 'support_requests';
  private static readonly SHARES_TABLE = 'support_request_shares';

  // PostgREST column hint: `task_id` names the FK column explicitly, which is required
  // because support_requests.task_id carries TWO foreign keys to tasks (the plain
  // support_requests_task_id_fkey and the composite tenant-scoped sla_request_task_tenant) —
  // without the hint PostgREST cannot pick one and the embed is rejected as ambiguous.
  private static readonly ENRICHED_TASK_FIELDS =
    'id,key,version,status_id,space_id,status_config:status_id(id,name,key,color,is_completed)';

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  private throwDbError(error: { code?: string; message?: string }): never {
    const msg = error.message ?? 'Database error';
    // Constraint / validation codes → 400; anything else → 500
    const clientCodes = ['23505', '23503', '23514', '23502', '22P02'];
    if (error.code && clientCodes.includes(error.code)) {
      throw new BadRequestException(msg);
    }

    throw new InternalServerErrorException(msg);
  }

  /**
   * Escape ILIKE wildcards (`\`, `%`, `_`) so an exact-match lookup can't be turned into a
   * pattern search (precedent: `create-ticket-from-email.action.ts:414`'s `[\\%_]`).
   * Does NOT cover `*` — PostgREST itself substitutes a literal `*` for `%` in `ilike`
   * filter values before Postgres ever sees a pattern, so no amount of backslash-escaping
   * here can neutralize it. Callers must reject `*` outright (see {@link findUserIdByEmail}).
   */
  private escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (match) => `\\${match}`);
  }

  /**
   * The `*, task:..., requester:..., space:...` select used by every enriched read.
   * `innerJoinTask` switches the task embed to `!inner` so a `task.status_id` filter
   * actually excludes non-matching rows instead of just nulling the embedded object.
   */
  private buildEnrichedSelect(innerJoinTask: boolean): string {
    const taskEmbed = innerJoinTask
      ? `task:task_id!inner(${HelpCenterRepository.ENRICHED_TASK_FIELDS})`
      : `task:task_id(${HelpCenterRepository.ENRICHED_TASK_FIELDS})`;

    // `priority_config` (aliased) carries the configurable priority's display fields so the
    // portal can render its real name/color; `priority` stays the legacy bucket from `*`.
    return `*, ${taskEmbed}, requester:created_by(id,first_name,last_name), space:space_id(id,name,key), priority_config:priority_id(id,name,key,color)`;
  }

  async findForStaff(id: string): Promise<ISupportRequest> {
    const { data, error } = await this.db
      .from('support_requests')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) this.throwDbError(error);
    if (!data) throw new NotFoundException('Support request not found');
    return data as ISupportRequest;
  }

  async reserveTask(request: ISupportRequest): Promise<string> {
    const { data, error } = await this.db.rpc('sla_reserve_request_task', {
      p_request_id: request.id,
      p_organization_id: request.organization_id,
    });
    if (error) this.throwDbError(error);
    return data as string;
  }

  async linkTask(
    request: ISupportRequest,
    taskId: string,
  ): Promise<ISupportRequest> {
    const { data, error } = await this.db.rpc('sla_link_request_task', {
      p_request_id: request.id,
      p_task_id: taskId,
      p_organization_id: request.organization_id,
    });
    if (error) this.throwDbError(error);
    return data as ISupportRequest;
  }

  /**
   * Insert a new support request row and return the created record.
   */
  async create(
    organizationId: string,
    userId: string,
    dto: CreateSupportRequestDto,
  ): Promise<ISupportRequest> {
    const insertResult = await this.db
      .from(HelpCenterRepository.TABLE)
      .insert({
        organization_id: organizationId,
        created_by: userId,
        subject: dto.subject,
        category: dto.category,
        priority: dto.priority ?? 'medium',
        ...(dto.priority_id ? { priority_id: dto.priority_id } : {}),
        description: dto.description,
        ...(dto.module_affected
          ? { module_affected: dto.module_affected }
          : {}),
        ...(dto.spaceId ? { space_id: dto.spaceId } : {}),
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.request_type ? { request_type: dto.request_type } : {}),
        custom_field_values: dto.custom_field_values ?? {},
      })
      .select('*')
      .single();

    const insertData = insertResult.data as ISupportRequest | null;
    const insertError = insertResult.error;

    if (insertError) this.throwDbError(insertError);

    return insertData as ISupportRequest;
  }

  /**
   * The priority ladder a ticket's space sees: org-wide rows plus that space's own rows.
   * Ordered by `sort_order` then `key` so the bucket a custom key maps to is stable.
   */
  async loadPriorityLadder(
    organizationId: string,
    spaceId: string | null,
  ): Promise<PriorityLadderRow[]> {
    let q = this.db
      .from('task_priorities')
      .select('id,key,space_id')
      .eq('organization_id', organizationId);

    q = spaceId
      ? q.or(`space_id.is.null,space_id.eq.${spaceId}`)
      : q.is('space_id', null);

    const { data, error } = await q
      .order('sort_order', { ascending: true })
      .order('key', { ascending: true });
    if (error) this.throwDbError(error);

    return (data ?? []) as PriorityLadderRow[];
  }

  /**
   * The legacy bucket a configurable priority id collapses to, used to also match rows saved
   * before `priority_id` existed. Resolves through the priority's OWN org/space ladder so a
   * custom key maps positionally rather than by name. Returns null when the id is unknown.
   */
  async priorityBucketForId(
    priorityId: string,
    spaceId: string | null,
  ): Promise<string | null> {
    const { data, error } = await this.db
      .from('task_priorities')
      .select('id,key,organization_id,space_id')
      .eq('id', priorityId)
      .maybeSingle();
    if (error) this.throwDbError(error);

    const row = data as (PriorityLadderRow & { organization_id: string }) | null;
    if (!row) return null;

    // Fast path: a seeded key is already a legal bucket, so no ladder read is needed.
    if (SUPPORT_REQUEST_PRIORITY_KEYS.has(row.key)) return row.key;

    // Load the same ladder the ticket's space would see, so a custom key buckets positionally.
    let q = this.db
      .from('task_priorities')
      .select('id,key,space_id')
      .eq('organization_id', row.organization_id);
    const effectiveSpace = row.space_id ?? spaceId;

    q = effectiveSpace
      ? q.or(`space_id.is.null,space_id.eq.${effectiveSpace}`)
      : q.is('space_id', null);

    const ladderRes = await q;
    if (ladderRes.error) this.throwDbError(ladderRes.error);

    const ladder = (ladderRes.data ?? []) as PriorityLadderRow[];
    const self = ladder.find((r) => r.id === row.id);

    return self
      ? priorityBucketForLadderRow(ladder, self)
      : toSupportRequestPriorityBucket(row.key);
  }

  /**
   * Return paginated, enriched support requests visible to `userId` under the
   * requested `scope` (contract §1). `scope=shared` with zero shares short-circuits
   * without querying `support_requests` at all.
   */
  async findByUser(
    userId: string,
    query: ListSupportRequestsQueryDto,
  ): Promise<{ data: IEnrichedSupportRequest[]; count: number }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;
    const scope = query.scope ?? 'mine';

    let sharedIds: string[] | null = null;
    if (scope === 'shared' || scope === 'all') {
      const { data, error } = await this.db
        .from(HelpCenterRepository.SHARES_TABLE)
        .select('request_id')
        .eq('user_id', userId);
      if (error) this.throwDbError(error);
      sharedIds = (data ?? []).map(
        (row) => (row as { request_id: string }).request_id,
      );

      if (scope === 'shared' && sharedIds.length === 0) {
        return { data: [], count: 0 };
      }
    }

    let q = this.db
      .from(HelpCenterRepository.TABLE)
      .select(this.buildEnrichedSelect(Boolean(query.taskStatusId)), {
        count: 'exact',
      });

    if (scope === 'mine') {
      q = q.eq('created_by', userId);
    } else if (scope === 'shared') {
      q = q.in('id', sharedIds as string[]);
    } else if (sharedIds && sharedIds.length > 0) {
      // scope=all: created by me OR shared with me. `sharedIds` are UUIDs we just
      // read back from our own share table, never caller-supplied — safe to interpolate.
      q = q.or(`created_by.eq.${userId},id.in.(${sharedIds.join(',')})`);
    } else {
      q = q.eq('created_by', userId);
    }

    if (query.status) {
      q = q.eq('status', query.status);
    }

    if (query.spaceId) {
      // Tickets with no space_id are org-wide and visible on any space-filtered page
      q = q.or(`space_id.eq.${query.spaceId},space_id.is.null`);
    }

    if (query.taskStatusId) {
      q = q.eq('task.status_id', query.taskStatusId);
    }

    if (query.priorityId) {
      // A row is a match when it carries the exact id, OR it predates the priority_id column
      // and its legacy bucket is the one that id maps to. Kept as one `.or()` so both sets
      // return in a single page.
      const bucket = await this.priorityBucketForId(
        query.priorityId,
        query.spaceId ?? null,
      );

      q = bucket
        ? q.or(
            `priority_id.eq.${query.priorityId},and(priority_id.is.null,priority.eq.${bucket})`,
          )
        : q.eq('priority_id', query.priorityId);
    } else if (query.priority) {
      q = q.eq('priority', query.priority);
    }

    if (query.requestType) {
      q = q.eq('request_type', query.requestType);
    }

    if (query.createdFrom) {
      q = q.gte('created_at', query.createdFrom);
    }

    if (query.createdTo) {
      q = q.lte('created_at', query.createdTo);
    }

    if (query.search) {
      // Sanitize search to prevent PostgREST .or() injection (same pattern as
      // tasks.service.ts's task search).
      const safe = query.search.trim().replace(/[,.()"'\\%*]/g, '');
      if (safe.length > 0) {
        const parts = [`subject.ilike.%${safe}%`];
        // bigint safety: a digit string longer than bigint's max (19 digits) would throw at
        // the DB, so cap at 18 digits and let anything longer fall back to a subject-only
        // search rather than error.
        if (/^\d+$/.test(safe) && safe.length <= 18)
          parts.push(`ticket_number.eq.${safe}`);
        q = q.or(parts.join(','));
      }
    }

    const sortBy = query.sortBy ?? 'created_at';
    const sortDir = query.sortDir ?? 'desc';
    q = q
      .order(sortBy, { ascending: sortDir === 'asc' })
      .order('id')
      .range(offset, offset + limit - 1);

    const { data, error, count } = await q;

    if (error) this.throwDbError(error);

    return {
      data: (data ?? []) as unknown as IEnrichedSupportRequest[],
      count: count ?? 0,
    };
  }

  /**
   * Return spaces the user is a member of, ordered by join date.
   */
  async findUserSpaces(
    userId: string,
  ): Promise<
    Array<{ id: string; name: string; color: string | null; key: string }>
  > {
    const { data, error } = await this.db
      .from('space_members')
      .select('spaces!inner(id, name, color, key)')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });

    if (error) this.throwDbError(error);

    return (data ?? [])
      .map(
        (row) =>
          (
            row as unknown as {
              spaces: {
                id: string;
                name: string;
                color: string | null;
                key: string;
              } | null;
            }
          ).spaces,
      )
      .filter(Boolean) as Array<{
      id: string;
      name: string;
      color: string | null;
      key: string;
    }>;
  }

  /**
   * Return enabled module_type keys for a space.
   * Returns empty array if the user is not a member of the space.
   */
  async findEnabledModulesForSpace(
    spaceId: string,
    userId: string,
  ): Promise<string[]> {
    const { data: membership } = await this.db
      .from('space_members')
      .select('id')
      .eq('space_id', spaceId)
      .eq('user_id', userId)
      .maybeSingle();

    if (!membership) return [];

    const { data, error } = await this.db
      .from('space_modules')
      .select('module_type')
      .eq('space_id', spaceId)
      .eq('is_enabled', true);

    if (error) this.throwDbError(error);

    return (data ?? []).map((m) => m.module_type as string);
  }

  /**
   * Return the organization_id that owns the given space.
   * Returns null if the space does not exist (e.g. was deleted).
   */
  async findSpaceOrganization(spaceId: string): Promise<string | null> {
    const { data } = await this.db
      .from('spaces')
      .select('organization_id')
      .eq('id', spaceId)
      .maybeSingle();

    return (
      (data as { organization_id: string } | null)?.organization_id ?? null
    );
  }

  /**
   * Return active task custom fields that may accept public support-form values.
   */
  async findActiveTaskCustomFields(
    organizationId: string,
    spaceId: string,
    fieldKeys: string[],
  ): Promise<SupportRequestTaskField[]> {
    if (fieldKeys.length === 0) return [];

    // `contexts` is JSONB, so PostgREST must receive a JSON literal. Passing a
    // JavaScript array to `.contains()` serializes like a Postgres array and
    // makes Postgres reject token "task" as invalid JSON.
    let query = this.db
      .from('custom_fields')
      .select('field_key, field_type, name, validation_rules, options')
      .eq('organization_id', organizationId)
      .eq('is_active', true)
      .eq('is_deleted', false)
      .filter('contexts', 'cs', JSON.stringify(['task']))
      .in('field_key', fieldKeys);

    query = query.or(`space_id.is.null,space_id.eq.${spaceId}`);

    const { data, error } = await query;

    if (error) this.throwDbError(error);

    return (data ?? []) as SupportRequestTaskField[];
  }

  /**
   * Return a single enriched support request and the caller's viewer role, iff the
   * caller is either the creator or has a `support_request_shares` row. This is the
   * ONE place visibility is decided — every share-aware route routes through it.
   * Throws 404 (never 403) for anything not visible, so existence is never leaked.
   */
  async findVisible(
    id: string,
    userId: string,
  ): Promise<{
    request: IEnrichedSupportRequest;
    viewer_role: SupportRequestViewerRole;
  }> {
    const { data, error } = await this.db
      .from(HelpCenterRepository.TABLE)
      .select(this.buildEnrichedSelect(false))
      .eq('id', id)
      .maybeSingle();

    if (error) this.throwDbError(error);

    const request = data as IEnrichedSupportRequest | null;
    if (!request) throw new NotFoundException('Support request not found');

    if (request.created_by === userId) {
      return { request, viewer_role: 'creator' };
    }

    const share = await this.findShare(id, userId);
    if (!share) throw new NotFoundException('Support request not found');

    return { request, viewer_role: 'shared' };
  }

  /**
   * Return a single support request. Throws 404 if not visible to the caller
   * (creator or shared — see {@link findVisible}). Kept for callers that only
   * need the plain request, not the viewer role.
   */
  async findById(id: string, userId: string): Promise<ISupportRequest> {
    const { request } = await this.findVisible(id, userId);
    return request;
  }

  /** A single `support_request_shares` row, or null if `userId` has no share on `requestId`. */
  async findShare(
    requestId: string,
    userId: string,
  ): Promise<{ user_id: string } | null> {
    const { data, error } = await this.db
      .from(HelpCenterRepository.SHARES_TABLE)
      .select('user_id')
      .eq('request_id', requestId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) this.throwDbError(error);
    return (data as { user_id: string } | null) ?? null;
  }

  /** Shared users (not including the creator), oldest share first. Never selects email. */
  async listShares(
    requestId: string,
  ): Promise<
    Array<{ user_id: string; user: IEnrichedSupportRequestUser | null }>
  > {
    const { data, error } = await this.db
      .from(HelpCenterRepository.SHARES_TABLE)
      .select('user_id, user:user_id(id, first_name, last_name)')
      .eq('request_id', requestId)
      .order('created_at', { ascending: true });
    if (error) this.throwDbError(error);
    return (data ?? []) as unknown as Array<{
      user_id: string;
      user: IEnrichedSupportRequestUser | null;
    }>;
  }

  /**
   * Case-insensitive exact email lookup. Caller passes an already trim/lowercased value.
   *
   * `*` is rejected before it ever reaches `ilike`: PostgREST rewrites a literal `*` to `%`
   * in `like`/`ilike` filter values, so `escapeLike`'s backslash-escaping cannot neutralize
   * it — an unrejected `*` would turn this exact-match lookup into a wildcard account probe.
   *
   * `.limit(2)` (not `.maybeSingle()`) so two case-insensitively-colliding users can never
   * raise PGRST116 into a 500 — anything other than exactly one match is treated the same as
   * no match, keeping this method's contract (null or one id, never a throw) as the caller's
   * "204 always" guarantee depends on it.
   *
   * A resolved user must also be related to `organizationId` — a member of it, or someone
   * who has already raised a support request in it — otherwise this returns null exactly
   * as it would for an unknown email. This stops the share-by-email endpoint from being used
   * to probe for the existence of accounts in another tenant.
   */
  async findUserIdByEmail(
    email: string,
    organizationId: string,
  ): Promise<{ id: string } | null> {
    if (email.includes('*')) return null;

    const escaped = this.escapeLike(email);
    const { data, error } = await this.db
      .from('users')
      .select('id')
      .ilike('email', escaped)
      .limit(2);
    if (error) this.throwDbError(error);

    const rows = (data ?? []) as { id: string }[];
    if (rows.length !== 1) return null;
    const target = rows[0];

    const related = await this.isRelatedToOrganization(
      target.id,
      organizationId,
    );
    return related ? target : null;
  }

  /**
   * True iff `userId` is a member of `organizationId`, or has previously created a support
   * request in it (a known customer of that org's help center, even without a membership
   * row). At most two extra queries, the second short-circuited by the first.
   */
  private async isRelatedToOrganization(
    userId: string,
    organizationId: string,
  ): Promise<boolean> {
    const { data: member, error: memberError } = await this.db
      .from('organization_members')
      .select('user_id')
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .limit(1)
      .maybeSingle();
    if (memberError) this.throwDbError(memberError);
    if (member) return true;

    const { data: requester, error: requesterError } = await this.db
      .from('support_requests')
      .select('id')
      .eq('created_by', userId)
      .eq('organization_id', organizationId)
      .limit(1)
      .maybeSingle();
    if (requesterError) this.throwDbError(requesterError);
    return !!requester;
  }

  /** Insert-ignore a share row; DB-level backstop against a racing duplicate share. */
  async insertShare(
    requestId: string,
    userId: string,
    organizationId: string,
    sharedBy: string,
  ): Promise<void> {
    const { error } = await this.db
      .from(HelpCenterRepository.SHARES_TABLE)
      .upsert(
        {
          request_id: requestId,
          user_id: userId,
          organization_id: organizationId,
          shared_by: sharedBy,
        },
        { onConflict: 'request_id,user_id', ignoreDuplicates: true },
      );
    if (error) this.throwDbError(error);
  }

  /** Idempotent: deleting a share that doesn't exist is a no-op, not an error. */
  async deleteShare(requestId: string, userId: string): Promise<void> {
    const { error } = await this.db
      .from(HelpCenterRepository.SHARES_TABLE)
      .delete()
      .eq('request_id', requestId)
      .eq('user_id', userId);
    if (error) this.throwDbError(error);
  }

  /** Minimal user identity for building a comment/share author display name. */
  async findUserName(
    userId: string,
  ): Promise<IEnrichedSupportRequestUser | null> {
    const { data, error } = await this.db
      .from('users')
      .select('id, first_name, last_name')
      .eq('id', userId)
      .maybeSingle();
    if (error) this.throwDbError(error);
    return (data as IEnrichedSupportRequestUser | null) ?? null;
  }

  /** Portal-visible comments only — `task_comments` rows carrying this request's marker. */
  async listPortalComments(requestId: string): Promise<IPortalComment[]> {
    const { data, error } = await this.db
      .from('task_comments')
      .select(
        'id, content, created_at, author:created_by(id, first_name, last_name)',
      )
      .eq('support_request_id', requestId)
      .order('created_at', { ascending: true });
    if (error) this.throwDbError(error);
    return (data ?? []) as unknown as IPortalComment[];
  }

  /**
   * `task_history` status-change rows for a task, oldest first. Selects only the
   * columns the activity feed needs — never actor or old_value.
   */
  async listStatusHistory(taskId: string): Promise<IStatusHistoryRow[]> {
    const { data, error } = await this.db
      .from('task_history')
      .select('id, changed_at, new_value')
      .eq('task_id', taskId)
      .in('action', ['status_change', 'status_changed'])
      .eq('field_name', 'status')
      .order('changed_at', { ascending: true });
    if (error) this.throwDbError(error);
    return (data ?? []) as IStatusHistoryRow[];
  }

  /**
   * The workflow engine's own audit rows for a task, oldest first.
   *
   * `task_history.new_value` is the legacy `tasks.status` BUCKET, not the status key —
   * `tasks.status` is CHECK-constrained to six values, so a non-legacy status (e.g.
   * `obsolete`, bucket `done`) loses its identity there. The exact destination status of an
   * engine-driven change survives only in `audit_logs.changes.to_status_id`, which the
   * activity feed uses to disambiguate those rows. Status changes made outside the engine
   * (bulk status update, direct PATCH) have no such row and fall back to the bucket mapping.
   */
  async listTransitionAudits(
    taskId: string,
  ): Promise<Array<{ changed_at: string; to_status_id: string }>> {
    const { data, error } = await this.db
      .from('audit_logs')
      .select('created_at, to_status_id:changes->>to_status_id')
      .eq('entity_type', 'task')
      .eq('action', 'workflow.transition.executed')
      .eq('entity_id', taskId)
      .not('changes->>to_status_id', 'is', null)
      .order('created_at', { ascending: true });
    if (error) this.throwDbError(error);
    return (data ?? []).map((row) => ({
      changed_at: (row as { created_at: string }).created_at,
      to_status_id: (row as { to_status_id: string }).to_status_id,
    }));
  }

  /**
   * The stored `content` of a `supportTicketList` element on a PUBLISHED page of a
   * PUBLISHED funnel, plus the funnel's org — or null for anything else. The element is
   * found by id anywhere in the page tree (children live in `content` arrays — same walk
   * as `PublicSiteStudioService#findElementById`). This stored block, never the request,
   * is what authorizes a customer status transition (contract §7).
   */
  async findPublishedElementContent(
    funnelId: string,
    pageId: string,
    elementId: string,
  ): Promise<{
    organizationId: string;
    content: { allowedStatusIds?: unknown; spaceId?: unknown };
  } | null> {
    const { data: page, error: pageError } = await this.db
      .from('site_studio_pages')
      .select('content')
      .eq('id', pageId)
      .eq('funnel_id', funnelId)
      .eq('published', true)
      .maybeSingle();
    if (pageError) this.throwDbError(pageError);
    if (!page) return null;

    const { data: funnel, error: funnelError } = await this.db
      .from('site_studio_funnels')
      .select('organization_id')
      .eq('id', funnelId)
      .eq('published', true)
      .maybeSingle();
    if (funnelError) this.throwDbError(funnelError);
    if (!funnel) return null;

    const element = this.findElementById(
      (page as { content: unknown }).content,
      elementId,
    );
    if (element?.type !== 'supportTicketList') return null;

    const content =
      element.content &&
      typeof element.content === 'object' &&
      !Array.isArray(element.content)
        ? (element.content as { allowedStatusIds?: unknown; spaceId?: unknown })
        : {};

    return {
      organizationId: (funnel as { organization_id: string }).organization_id,
      content,
    };
  }

  private findElementById(
    elements: unknown,
    elementId: string,
  ): { id?: unknown; type?: unknown; content?: unknown } | null {
    if (!Array.isArray(elements)) return null;

    for (const element of elements as Array<{
      id?: unknown;
      type?: unknown;
      content?: unknown;
    } | null>) {
      if (!element) continue;
      if (element.id === elementId) return element;
      const found = this.findElementById(element.content, elementId);
      if (found) return found;
    }

    return null;
  }

  /** id / name / color for a set of status ids, in one org-scoped query. */
  async findStatusesByIds(
    organizationId: string,
    ids: string[],
  ): Promise<Array<{ id: string; name: string; color: string | null }>> {
    const { data, error } = await this.db
      .from('task_statuses')
      .select('id, name, color')
      .eq('organization_id', organizationId)
      .in('id', ids);
    if (error) this.throwDbError(error);
    return (data ?? []) as Array<{
      id: string;
      name: string;
      color: string | null;
    }>;
  }

  /** Statuses visible to a task: its space's own statuses plus org-wide (space_id null) ones. */
  async listTaskStatuses(
    organizationId: string,
    spaceId: string | null,
  ): Promise<Array<{ id: string; key: string; name: string; color: string }>> {
    let q = this.db
      .from('task_statuses')
      .select('id, key, name, color')
      .eq('organization_id', organizationId);
    q = spaceId
      ? q.or(`space_id.eq.${spaceId},space_id.is.null`)
      : q.is('space_id', null);

    const { data, error } = await q;
    if (error) this.throwDbError(error);
    return (data ?? []) as Array<{
      id: string;
      key: string;
      name: string;
      color: string;
    }>;
  }
}
