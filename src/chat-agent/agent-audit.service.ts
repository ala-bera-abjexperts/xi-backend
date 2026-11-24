/**
 * @fileoverview The AI audit log (XE-T353 1.14, SEC-05): Robert's audit rows of one
 * organization, newest first, paged by `seq`, and their export as CSV or JSON.
 * The rows hold ids, codes, numbers and hashes only; names are joined here, per request.
 * @module src/chat-agent/agent-audit.service
 */

import { Injectable, InternalServerErrorException } from '@nestjs/common';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { ChatConversationsService } from '../chat/chat-conversations.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AgentRunsRepository } from './agent-runs.repository';
import type { AgentAuditQueryDto } from './dto/agent.dto';

/** Contract 4.4; the frontend's `AgentAuditEventView`. */
export interface AgentAuditEventView {
  seq: string;
  occurredAt: string;
  event: string;
  actor: { id: string | null; name: string | null };
  impersonatedBy?: { id: string; name: string | null };
  runId: string | null;
  actionId: string | null;
  conversationId: string | null;
  entity?: { type: string; id: string };
  data: Record<string, unknown>;
}

interface AuditRow {
  seq: number | string;
  occurred_at: string;
  event: string;
  run_id: string | null;
  action_id: string | null;
  conversation_id: string | null;
  actor_id: string | null;
  impersonated_by: string | null;
  entity_type: string | null;
  entity_id: string | null;
  data: Record<string, unknown> | null;
}

/** At most this many rows in one export. */
export const MAX_AUDIT_EXPORT = 50_000;
const EXPORT_PAGE = 1_000;
const DEFAULT_PAGE = 50;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A CSV cell; one that a spreadsheet would run as a formula gets a leading `'`. */
export function csvCell(value: unknown): string {
  let text =
    value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value as string | number | boolean);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const CSV_COLUMNS = [
  'seq',
  'occurred_at',
  'event',
  'actor_id',
  'actor_name',
  'impersonated_by',
  'impersonated_by_name',
  'run_id',
  'action_id',
  'conversation_id',
  'entity_type',
  'entity_id',
  'data',
];

export function toCsv(events: AgentAuditEventView[]): string {
  const lines = events.map((e) =>
    [
      e.seq,
      e.occurredAt,
      e.event,
      e.actor.id,
      e.actor.name,
      e.impersonatedBy?.id,
      e.impersonatedBy?.name,
      e.runId,
      e.actionId,
      e.conversationId,
      e.entity?.type,
      e.entity?.id,
      e.data,
    ]
      .map(csvCell)
      .join(','),
  );
  return [CSV_COLUMNS.join(','), ...lines].join('\r\n') + '\r\n';
}

@Injectable()
export class AgentAuditService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly conversations: ChatConversationsService,
    private readonly runs: AgentRunsRepository,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** GET /chat/agent/audit: one page, newest first. */
  async list(
    user: RequestUser,
    query: AgentAuditQueryDto,
  ): Promise<{ events: AgentAuditEventView[]; nextCursor: string | null }> {
    const limit = query.limit ?? DEFAULT_PAGE;
    const rows = await this.page(user, query, query.cursor ?? null, limit + 1);
    const page = rows.slice(0, limit);

    return {
      events: await this.toViews(page),
      nextCursor: rows.length > limit ? String(page.at(-1)?.seq) : null,
    };
  }

  /**
   * GET /chat/agent/audit/export: at most 50,000 rows, newest first. The export itself is
   * audited (`audit.exported`).
   */
  async export(
    user: RequestUser,
    query: AgentAuditQueryDto & { format: 'csv' | 'json' },
  ): Promise<{ body: string; capped: boolean }> {
    const rows: AuditRow[] = [];
    let cursor: string | null = null;
    for (;;) {
      const take = Math.min(EXPORT_PAGE, MAX_AUDIT_EXPORT + 1 - rows.length);
      const page = await this.page(user, query, cursor, take);
      rows.push(...page);
      if (page.length < take || rows.length > MAX_AUDIT_EXPORT) break;
      cursor = String(page.at(-1)?.seq);
    }
    const capped = rows.length > MAX_AUDIT_EXPORT;
    const events = await this.toViews(rows.slice(0, MAX_AUDIT_EXPORT));

    await this.runs.recordAudit({
      organizationId: user.organizationId,
      event: 'audit.exported',
      actorId: user.userId,
      impersonatedBy: user.impersonation?.realUserId ?? null,
      data: {
        format: query.format,
        rows: events.length,
        capped,
        ...(query.from && { from: query.from }),
        ...(query.to && { to: query.to }),
        ...(query.actorId && { actor_id: query.actorId }),
        ...(query.event && { event: query.event }),
        ...(query.conversationId && { conversation_id: query.conversationId }),
        ...(query.runId && { run_id: query.runId }),
      },
    });

    return {
      body:
        query.format === 'csv'
          ? toCsv(events)
          : JSON.stringify(events, null, 2),
      capped,
    };
  }

  private async page(
    user: RequestUser,
    query: AgentAuditQueryDto,
    cursor: string | null,
    limit: number,
  ): Promise<AuditRow[]> {
    let q = this.client
      .from('agent_audit_events')
      .select(
        'seq, occurred_at, event, run_id, action_id, conversation_id, actor_id, impersonated_by, entity_type, entity_id, data',
      )
      .eq('organization_id', user.organizationId);
    if (query.from) q = q.gte('occurred_at', query.from);
    // A day alone means the whole (UTC) day.
    if (query.to)
      q = q.lte(
        'occurred_at',
        DAY.test(query.to) ? `${query.to}T23:59:59.999Z` : query.to,
      );
    if (query.actorId) q = q.eq('actor_id', query.actorId);
    if (query.event) q = q.eq('event', query.event);
    if (query.conversationId) q = q.eq('conversation_id', query.conversationId);
    if (query.runId) q = q.eq('run_id', query.runId);
    if (cursor) q = q.lt('seq', cursor);

    const { data, error } = await q
      .order('seq', { ascending: false })
      .limit(limit);
    if (error)
      throw new InternalServerErrorException('Could not load the audit log');
    return (data ?? []) as AuditRow[];
  }

  /** Names of actors and impersonators, in one read per 100 people. */
  private async toViews(rows: AuditRow[]): Promise<AgentAuditEventView[]> {
    const ids = [
      ...new Set(
        rows.flatMap((r) =>
          [r.actor_id, r.impersonated_by].filter((id): id is string => !!id),
        ),
      ),
    ];
    const names = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 100) {
      const users = await this.conversations.loadUsers(ids.slice(i, i + 100));
      for (const [id, u] of users) names.set(id, u.name);
    }
    const nameOf = (id: string) => names.get(id) ?? null;

    return rows.map((r) => ({
      seq: String(r.seq),
      occurredAt: r.occurred_at,
      event: r.event,
      actor: { id: r.actor_id, name: r.actor_id ? nameOf(r.actor_id) : null },
      ...(r.impersonated_by && {
        impersonatedBy: {
          id: r.impersonated_by,
          name: nameOf(r.impersonated_by),
        },
      }),
      runId: r.run_id,
      actionId: r.action_id,
      conversationId: r.conversation_id,
      ...(r.entity_type &&
        r.entity_id && { entity: { type: r.entity_type, id: r.entity_id } }),
      data: r.data ?? {},
    }));
  }
}
