/**
 * @fileoverview Service for audit log CRUD and analytics.
 * Mirrors the AuditService / AuditLogRepository from the risk-management-app.
 * @module src/audit-logs/audit-logs.service
 * @author Prince Jadiya
 */

import { Injectable, Logger } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { CreateAuditLogDto } from './dto/create-audit-log.dto';
import type { ListAuditLogsQueryDto } from './dto/list-audit-logs-query.dto';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { getImpersonatedByUserId } from '../common/context/impersonation-context';

const TABLE = 'audit_logs';

interface AuditLogRecord {
  id: string;
  organization_id: string;
  user_id: string | null;
  entity_type: string;
  entity_id: string | null;
  action: string;
  changes: Record<string, unknown> | null;
  created_at: string;
  user: { first_name: string; last_name: string; email: string } | null;
}

interface PaginatedResult {
  data: AuditLogRecord[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

interface AuditStats {
  total: number;
  byAction: Record<string, number>;
  byEntityType: Record<string, number>;
  byUser: Record<string, number>;
}

@Injectable()
export class AuditLogsService {
  private readonly logger = new Logger(AuditLogsService.name);

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Insert a single audit log entry.
   * Silently catches errors — matching Next.js logAction() pattern.
   *
   * @param {string} orgId - Organization the action happened in.
   * @param {string | null} userId - The acting user (the impersonation TARGET
   *   when an SA is impersonating — the row reflects who the action ran "as").
   * @param {CreateAuditLogDto} dto - Audit entry fields.
   * @param {string | null} [impersonatedByUserId=null] - When the action was
   *   performed inside an impersonation overlay, the SA's real public.users.id;
   *   otherwise null. Stored in `impersonated_by_user_id` for forensics.
   */
  async createLog(
    orgId: string,
    userId: string | null,
    dto: CreateAuditLogDto,
    impersonatedByUserId: string | null = null,
  ): Promise<void> {
    try {
      // Explicit arg wins; the ALS fallback fills the gap for callers that run
      // inside an impersonation request but do not thread the id manually.
      const effectiveImpersonatedBy =
        impersonatedByUserId ?? getImpersonatedByUserId();

      const { error } = await this.client.from(TABLE).insert({
        organization_id: orgId,
        user_id: userId,
        entity_type: dto.entity_type,
        entity_id: dto.entity_id ?? null,
        action: dto.action,
        changes: dto.changes ?? null,
        impersonated_by_user_id: effectiveImpersonatedBy,
      });

      if (error) throw error;
    } catch (err) {
      this.logger.error('Failed to create audit log', err);
    }
  }

  /**
   * Convenience wrapper used by other services internally.
   * Never throws — audit failures must not break primary operations.
   *
   * The `'workflow.transition.executed'` literal is widened in for the
   * workflow engine: each successful state transition writes one
   * per-transition audit trace (entity_type='task', action=<this literal>)
   * so the UI / compliance exports can reconstruct the full history.
   *
   * P8/D5: the four `'workflow.*'` literals (`draft.created`,
   * `draft.discarded`, `published`, `assignment.changed`) are widened in so
   * the draft + publish lifecycle and the P7 assignment migration path can
   * write typed audit rows without an `as never` cast.
   *
   * @param {string | null} [impersonatedByUserId] - Optional SA real user id
   *   when the action ran inside an impersonation overlay. Defaults to null
   *   (normal, non-impersonated behavior) so existing callers are unaffected.
   */
  async logAction(
    orgId: string,
    userId: string,
    entityType: string,
    entityId: string,
    action:
      | 'create'
      | 'update'
      | 'delete'
      | 'calculate'
      | 'archive'
      | 'restore'
      | 'workflow.transition.executed'
      | 'workflow.draft.created'
      | 'workflow.draft.discarded'
      | 'workflow.published'
      | 'workflow.assignment.changed'
      | 'form.approval.submitted'
      | 'form.approval.approved'
      | 'form.approval.rejected'
      | 'form.approval.auto_cancelled'
      | 'form.approval.finalized'
      // Backup & Restore. See AUDIT_ACTIONS in dto/create-audit-log.dto.ts.
      | 'backup',
    changes?: Record<string, unknown>,
    impersonatedByUserId?: string | null,
  ): Promise<void> {
    try {
      await this.createLog(
        orgId,
        userId,
        {
          entity_type: entityType,
          entity_id: entityId,
          action,
          changes,
        },
        impersonatedByUserId ?? null,
      );
    } catch (err) {
      this.logger.error('Failed to log action', err);
    }
  }

  /**
   * Request-aware audit logging. Resolves org/user/impersonation context
   * directly from the authenticated {@link RequestUser}, so callers that have
   * a request user in scope do not have to thread the impersonation id
   * manually. When the request is a normal (non-impersonation) one,
   * `impersonated_by_user_id` is written as null — identical to logAction.
   *
   * @param {RequestUser} user - The authenticated request user (may carry an
   *   active impersonation overlay).
   * @param {string} entityType - Entity type being acted on.
   * @param {string} entityId - Entity id being acted on.
   * @param {'create'|'update'|'delete'|'calculate'|'archive'|'restore'} action - Action verb.
   * @param {Record<string, unknown>} [changes] - Optional change payload.
   */
  async logActionForRequest(
    user: RequestUser,
    entityType: string,
    entityId: string,
    action:
      | 'create'
      | 'update'
      | 'delete'
      | 'calculate'
      | 'archive'
      | 'restore',
    changes?: Record<string, unknown>,
  ): Promise<void> {
    return this.logAction(
      user.organizationId || '',
      user.userId,
      entityType,
      entityId,
      action,
      changes,
      user.impersonation?.realUserId ?? null,
    );
  }

  async logSystemAction(
    orgId: string,
    entityType: string,
    entityId: string,
    // H5 fix — widened in parallel with `logAction` so a system-initiated
    // workflow transition (e.g., the cron trigger in P6+ or an inbound
    // webhook that fires without a real user identity) can write its audit
    // row through the same code path. Without this, callers would have to
    // either route through `logAction` with a fake userId or skip auditing
    // entirely — both are worse than just letting the literal through.
    //
    // P8/D5: same widening as logAction — the four workflow-lifecycle
    // literals stay in lockstep so system-initiated publish/discard paths
    // (e.g. a future cron-driven cleanup) keep audit type safety.
    action:
      | 'create'
      | 'update'
      | 'delete'
      | 'calculate'
      | 'archive'
      | 'restore'
      | 'workflow.transition.executed'
      | 'workflow.draft.created'
      | 'workflow.draft.discarded'
      | 'workflow.published'
      | 'workflow.assignment.changed'
      | 'form.approval.submitted'
      | 'form.approval.approved'
      | 'form.approval.rejected'
      | 'form.approval.auto_cancelled'
      | 'form.approval.finalized',
    changes?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.createLog(orgId, null, {
        entity_type: entityType,
        entity_id: entityId,
        action,
        changes,
      });
    } catch (err) {
      this.logger.error('Failed to log system action', err);
    }
  }

  /**
   * Paginated list of audit logs for an organization, with optional filters.
   * Response shape matches AuditLogRepository.findPaginated() exactly.
   *
   * PERF: `count: 'exact'` makes PostgREST run a second, unbounded aggregate over
   * every row matching the filter — an O(tenant audit rows) cost on an append-only
   * table that grows forever. Callers that only consume `data` should pass
   * `{ withCount: false }` to skip it. When the count is skipped, `total` falls back
   * to the number of rows on this page and `hasMore` to "was the page full?" — so
   * neither field is ever a misleading zero. `GET /audit-logs` keeps the exact count
   * because it renders a real total.
   */
  async getLogs(
    orgId: string,
    query: ListAuditLogsQueryDto,
    options: { withCount?: boolean } = {},
  ): Promise<PaginatedResult> {
    const withCount = options.withCount ?? true;
    const pageSize = Math.min(
      Math.max(parseInt(query.limit ?? '50', 10) || 50, 1),
      100,
    );
    const offset = Math.max(parseInt(query.offset ?? '0', 10) || 0, 0);

    let q = this.client
      .from(TABLE)
      // Disambiguate by FK constraint — audit_logs has two FKs to users
      // (user_id = actor, impersonated_by_user_id = admin impersonating).
      .select(
        '*, user:users!audit_logs_user_id_fkey(first_name, last_name, email, avatar_url)',
        withCount ? { count: 'exact' } : undefined,
      )
      .eq('organization_id', orgId);

    if (query.entity_type) q = q.eq('entity_type', query.entity_type);
    if (query.entity_id) q = q.eq('entity_id', query.entity_id);
    if (query.entity_ids) q = q.in('entity_id', query.entity_ids.split(','));
    if (query.action) q = q.eq('action', query.action);
    if (query.user_id) q = q.eq('user_id', query.user_id);
    if (query.start_date) q = q.gte('created_at', query.start_date);
    if (query.end_date) q = q.lte('created_at', query.end_date);

    q = q
      .order('created_at', { ascending: false })
      .range(offset, offset + pageSize - 1);

    const { data, error, count } = await q;

    if (error) throw new Error(error.message);

    const rows = (data ?? []) as AuditLogRecord[];

    // With the count requested this is identical to the previous behaviour.
    // Without it, report the page we actually have rather than a bogus 0.
    const total = withCount ? (count ?? 0) : rows.length;
    const hasMore = withCount
      ? total > offset + pageSize
      : rows.length === pageSize;

    return {
      data: rows,
      total,
      page: Math.floor(offset / pageSize) + 1,
      pageSize,
      hasMore,
    };
  }

  /**
   * Fetch the most recent activity across the organization.
   * Returns the raw data array (not wrapped in pagination envelope).
   */
  async getRecentActivity(
    orgId: string,
    limit: number = 20,
  ): Promise<AuditLogRecord[]> {
    // Only `data` is returned, so skip the exact count. This path is the global
    // navbar poll (every 30s, per user, per tab) — the dominant caller.
    const result = await this.getLogs(
      orgId,
      {
        limit: String(Math.min(limit, 100)),
        offset: '0',
      },
      { withCount: false },
    );
    return result.data;
  }

  /**
   * Compute aggregate statistics for the organization's audit logs.
   * Matches AuditService.getAuditStatistics() output exactly.
   */
  async getAuditStatistics(
    orgId: string,
    startDate?: string,
    endDate?: string,
  ): Promise<AuditStats> {
    // Stats are computed from `logs.data` only (note `total: logs.data.length`
    // below, not the query count), so the exact count is pure waste here.
    const logs = await this.getLogs(
      orgId,
      {
        start_date: startDate,
        end_date: endDate,
        limit: '100',
        offset: '0',
      },
      { withCount: false },
    );

    const stats: AuditStats = {
      total: logs.data.length,
      byAction: {},
      byEntityType: {},
      byUser: {},
    };

    for (const log of logs.data) {
      stats.byAction[log.action] = (stats.byAction[log.action] ?? 0) + 1;
      stats.byEntityType[log.entity_type] =
        (stats.byEntityType[log.entity_type] ?? 0) + 1;
      if (log.user_id) {
        stats.byUser[log.user_id] = (stats.byUser[log.user_id] ?? 0) + 1;
      }
    }

    return stats;
  }
}
