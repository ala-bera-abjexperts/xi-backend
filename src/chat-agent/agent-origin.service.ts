/**
 * @fileoverview "Drafted by Robert" on an object (SEC-06) and the way back to the conversation
 * (ROB-13). Read only, for one object at a time: lists never come here. Depends on nothing of chat,
 * tasks or wiki, so those modules can use it.
 * @module src/chat-agent/agent-origin.service
 */
import { Injectable, Logger } from '@nestjs/common';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { PermissionsService } from '../permissions/permissions.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

export type OriginEntity = 'task' | 'wiki_page' | 'process' | 'plan';
const SHOWN: ReadonlySet<string> = new Set<OriginEntity>(['task', 'wiki_page', 'process', 'plan']);

/** Only what this viewer may know: a non-member gets no id, no name and no text of the chat. */
export type OriginSource =
  | { kind: 'link'; conversationId: string; messageId: string; threadRootId: string | null }
  | { kind: 'private' }
  | { kind: 'deleted' };

export interface RobertOrigin {
  createdAt: string;
  requestedBy: string | null;
  confirmedBy: string | null;
  editedBy: string[];
  source: OriginSource;
}

/** 1.22.1: one plan Robert added an existing task to (the link row still exists). */
export interface RobertPlanLink {
  planId: string;
  planKey: string | null;
  planName: string;
  createdAt: string;
  confirmedBy: string | null;
  source: OriginSource;
}

interface OriginRow {
  conversation_id: string;
  trigger_message_id: string;
  source_message_ids: string[] | null;
  invoker_id: string | null;
  confirmer_id: string | null;
  created_at: string;
}

const nameOf = (u?: { first_name?: string | null; last_name?: string | null }) => {
  const name = `${u?.first_name ?? ''} ${u?.last_name ?? ''}`.trim();
  return name || null;
};

@Injectable()
export class AgentOriginService {
  private readonly logger = new Logger(AgentOriginService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly permissions: PermissionsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * The label of one object the viewer already got through its own route. The tenant comes from
   * that object's row. A person's object costs one lookup by primary key. Never throws: a label
   * that can't be read must not take the screen down.
   */
  async forObject(
    viewer: RequestUser,
    entityType: OriginEntity,
    row: { id?: unknown; organization_id?: unknown; updated_by?: unknown; created_by?: unknown },
  ): Promise<RobertOrigin | null> {
    if (!SHOWN.has(entityType) || typeof row.id !== 'string' || typeof row.organization_id !== 'string') return null;
    try {
      const origin = await this.originRow(row.organization_id, entityType, row.id);
      if (!origin) return null;
      const [editors, source] = await Promise.all([
        this.editors(row.organization_id, entityType, row.id, origin.created_at),
        this.sourceFor(viewer, row.organization_id, origin),
      ]);
      const names = await this.names([origin.invoker_id, origin.confirmer_id, ...editors]);
      return {
        createdAt: origin.created_at,
        requestedBy: origin.invoker_id ? (names.get(origin.invoker_id) ?? null) : null,
        confirmedBy: origin.confirmer_id ? (names.get(origin.confirmer_id) ?? null) : null,
        editedBy: editors.map((id) => names.get(id)).filter((n): n is string => !!n),
        source,
      };
    } catch (err) {
      this.logger.warn(`Origin of ${entityType} ${String(row.id)} not read: ${String(err)}`);
      return null;
    }
  }

  /**
   * 1.23: "Suggested by Robert · reviewed by … · date" on the rows of a plan's risks or stakeholders,
   * one batched lookup for the list (and one source check per conversation, not per row). The same
   * viewer rules as forObject: members get the way back to the chat, others "a private conversation".
   * Never throws.
   */
  async suggestedLabels(
    viewer: RequestUser,
    organizationId: string,
    entityType: 'plan_risk' | 'plan_stakeholder',
    ids: string[],
  ): Promise<Record<string, RobertOrigin>> {
    const out: Record<string, RobertOrigin> = {};
    try {
      const rows: (OriginRow & { entity_id: string })[] = [];
      for (let i = 0; i < ids.length; i += 500) {
        const { data, error } = await this.client
          .from('agent_object_origins')
          .select('entity_id, conversation_id, trigger_message_id, source_message_ids, invoker_id, confirmer_id, created_at')
          .eq('organization_id', organizationId)
          .eq('entity_type', entityType)
          .in('entity_id', ids.slice(i, i + 500));
        if (error) throw new Error(error.message);
        rows.push(...((data ?? []) as typeof rows));
      }
      if (!rows.length) return out;
      const names = await this.names(rows.flatMap((r) => [r.invoker_id, r.confirmer_id]));
      const sources = new Map<string, Promise<OriginSource>>();
      for (const r of rows) {
        const key = `${r.conversation_id}|${r.trigger_message_id}|${(r.source_message_ids ?? []).join(',')}`;
        if (!sources.has(key)) sources.set(key, this.sourceFor(viewer, organizationId, r));
        out[r.entity_id] = {
          createdAt: r.created_at,
          requestedBy: r.invoker_id ? (names.get(r.invoker_id) ?? null) : null,
          confirmedBy: r.confirmer_id ? (names.get(r.confirmer_id) ?? null) : null,
          editedBy: [],
          source: await (sources.get(key) as Promise<OriginSource>),
        };
      }
    } catch (err) {
      this.logger.warn(`Suggested labels of ${entityType} not read: ${String(err)}`);
    }
    return out;
  }

  /** One batched lookup for an export: who reviewed each object Robert drafted, and when. */
  async labels(organizationId: string, ids: string[]): Promise<Map<string, { confirmedBy: string | null; createdAt: string }>> {
    const out = new Map<string, { confirmedBy: string | null; createdAt: string }>();
    const rows: { entity_id: string; confirmer_id: string | null; created_at: string }[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const { data, error } = await this.client
        .from('agent_object_origins')
        .select('entity_id, confirmer_id, created_at')
        .eq('organization_id', organizationId)
        .in('entity_type', [...SHOWN])
        .in('entity_id', ids.slice(i, i + 500));
      if (error) throw new Error(error.message);
      rows.push(...((data ?? []) as typeof rows));
    }
    if (!rows.length) return out;
    const names = await this.names(rows.map((r) => r.confirmer_id));
    for (const r of rows)
      out.set(r.entity_id, { confirmedBy: r.confirmer_id ? (names.get(r.confirmer_id) ?? null) : null, createdAt: r.created_at });
    return out;
  }

  /**
   * 1.22.1: the plans Robert added this task to, one line each, only while that link row exists:
   * a link undone or removed and added again by a person shows nothing (its new row has no
   * origin). The tenant comes from the task's row. Never throws.
   */
  async addedToPlans(
    viewer: RequestUser,
    row: { id?: unknown; organization_id?: unknown },
  ): Promise<RobertPlanLink[]> {
    if (typeof row.id !== 'string' || typeof row.organization_id !== 'string') return [];
    const organizationId = row.organization_id;
    try {
      const { data: links, error } = await this.client
        .from('plan_tasks')
        .select('id, plan_id, plan:plans!inner(plan_key, name, organization_id)')
        .eq('task_id', row.id)
        .eq('plan.organization_id', organizationId);
      if (error) throw new Error(error.message);
      const byId = new Map(
        ((links ?? []) as unknown as { id: string; plan_id: string; plan: { plan_key: string | null; name: string } }[]).map((l) => [l.id, l]),
      );
      if (!byId.size) return [];
      const { data: origins, error: originError } = await this.client
        .from('agent_object_origins')
        .select('entity_id, conversation_id, trigger_message_id, source_message_ids, invoker_id, confirmer_id, created_at')
        .eq('organization_id', organizationId)
        .eq('entity_type', 'plan_link')
        .in('entity_id', [...byId.keys()]);
      if (originError) throw new Error(originError.message);
      const rows = (origins ?? []) as (OriginRow & { entity_id: string })[];
      if (!rows.length) return [];
      const names = await this.names(rows.map((o) => o.confirmer_id));
      const out: RobertPlanLink[] = [];
      for (const o of rows) {
        const link = byId.get(o.entity_id);
        if (!link) continue;
        out.push({
          planId: link.plan_id,
          planKey: link.plan?.plan_key ?? null,
          planName: link.plan?.name ?? '',
          createdAt: o.created_at,
          confirmedBy: o.confirmer_id ? (names.get(o.confirmer_id) ?? null) : null,
          source: await this.sourceFor(viewer, organizationId, o),
        });
      }
      return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    } catch (err) {
      this.logger.warn(`Plan links of task ${String(row.id)} not read: ${String(err)}`);
      return [];
    }
  }

  /**
   * 1.22.1: the Robert marker of each row of one plan, in one batch: "drafted" for a task Robert
   * made, "added" for one Robert put into this plan. A few queries per view, never one per row.
   */
  async planMarkers(organizationId: string, planId: string, taskIds: string[]): Promise<Map<string, 'drafted' | 'added'>> {
    const out = new Map<string, 'drafted' | 'added'>();
    if (!taskIds.length) return out;
    for (const id of (await this.labels(organizationId, taskIds)).keys()) out.set(id, 'drafted');
    const { data: links, error } = await this.client.from('plan_tasks').select('id, task_id').eq('plan_id', planId);
    if (error) throw new Error(error.message);
    const linkTask = new Map(((links ?? []) as { id: string; task_id: string }[]).map((l) => [l.id, l.task_id]));
    const linkIds = [...linkTask.keys()];
    for (let i = 0; i < linkIds.length; i += 500) {
      const { data, error: originError } = await this.client
        .from('agent_object_origins')
        .select('entity_id')
        .eq('organization_id', organizationId)
        .eq('entity_type', 'plan_link')
        .in('entity_id', linkIds.slice(i, i + 500));
      if (originError) throw new Error(originError.message);
      for (const { entity_id } of (data ?? []) as { entity_id: string }[]) {
        const task = linkTask.get(entity_id);
        if (task) out.set(task, 'added');
      }
    }
    return out;
  }

  /** For screens outside the tenant: no name, no link, nothing about the conversation. */
  async isDraftedByRobert(organizationId: string, entityType: OriginEntity, id: string): Promise<boolean> {
    try {
      return !!(await this.originRow(organizationId, entityType, id));
    } catch {
      return false;
    }
  }

  private async originRow(organizationId: string, entityType: string, id: string): Promise<OriginRow | null> {
    const { data, error } = await this.client
      .from('agent_object_origins')
      .select('conversation_id, trigger_message_id, source_message_ids, invoker_id, confirmer_id, created_at')
      .eq('organization_id', organizationId)
      .eq('entity_type', entityType)
      .eq('entity_id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as OriginRow | null) ?? null;
  }

  /** Who changed it after Robert made it, newest first, once each. Includes the invoker. */
  private async editors(organizationId: string, entityType: OriginEntity, id: string, since: string): Promise<string[]> {
    const query =
      entityType === 'task'
        ? this.client
            .from('task_history')
            .select('changed_by, action')
            .eq('task_id', id)
            .eq('organization_id', organizationId)
            .gt('changed_at', since)
            .not('action', 'in', '(create,subtask_created)')
            .order('changed_at', { ascending: false })
        : entityType === 'wiki_page'
          ? this.client
              .from('wiki_page_versions')
              .select('changed_by')
              .eq('wiki_page_id', id)
              .gt('created_at', since)
              .order('created_at', { ascending: false })
          : this.client
              .from('audit_logs')
              .select('changed_by:user_id, action')
              .eq('organization_id', organizationId)
              // A plan keeps no history table either (1.22): its edits are audited like a process's.
              .eq('entity_type', entityType === 'plan' ? 'plan' : 'business_process')
              .eq('entity_id', id)
              .eq('action', 'update')
              .gt('created_at', since)
              .order('created_at', { ascending: false });
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { changed_by?: string | null; user_id?: string | null }[];
    return [...new Set(rows.map((r) => r.changed_by ?? r.user_id).filter((who): who is string => !!who))];
  }

  private async names(ids: (string | null)[]): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];
    const { data, error } = await this.client.from('users').select('id, first_name, last_name').in('id', wanted);
    if (error) throw new Error(error.message);
    const out = new Map<string, string>();
    for (const u of (data ?? []) as { id: string; first_name?: string | null; last_name?: string | null }[]) {
      const name = nameOf(u);
      if (name) out.set(u.id, name);
    }
    return out;
  }

  /** The same rule as reading the conversation: its members, or who can see the space of a space chat. */
  private async sourceFor(viewer: RequestUser, organizationId: string, origin: OriginRow): Promise<OriginSource> {
    const { data: conversation, error } = await this.client
      .from('chat_conversations')
      .select('id, kind, space_id')
      .eq('id', origin.conversation_id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!conversation) return { kind: 'deleted' };

    const { data: member, error: memberError } = await this.client
      .from('chat_members')
      .select('history_from_seq')
      .eq('conversation_id', origin.conversation_id)
      .eq('organization_id', organizationId)
      .eq('user_id', viewer.userId)
      .maybeSingle();
    if (memberError) throw new Error(memberError.message);

    const { kind, space_id: spaceId } = conversation as { kind: string; space_id: string | null };
    const allowed =
      kind === 'space' && spaceId
        ? await this.permissions
            .getViewableSpaceIds(viewer.userId, organizationId, [spaceId])
            .then((viewable) => viewable === null || viewable.includes(spaceId))
        : !!member;
    if (!allowed) return { kind: 'private' };

    const ids = [...(origin.source_message_ids ?? []), origin.trigger_message_id];
    const { data: rows, error: messagesError } = await this.client
      .from('chat_messages')
      .select('id, seq, thread_root_id, deleted_at')
      .eq('conversation_id', origin.conversation_id)
      .eq('organization_id', organizationId)
      .in('id', ids);
    if (messagesError) throw new Error(messagesError.message);
    const messages = (rows ?? []) as { id: string; seq: number; thread_root_id: string | null; deleted_at: string | null }[];

    // Someone who joined later can't read those messages, whatever the conversation shows them now.
    const cutOff = Number((member as { history_from_seq?: number } | null)?.history_from_seq ?? 0);
    if (cutOff > 0 && messages.length && messages.every((m) => Number(m.seq) < cutOff)) return { kind: 'private' };

    const first = messages
      .filter((m) => !m.deleted_at && Number(m.seq) >= cutOff)
      .sort((a, b) => Number(a.seq) - Number(b.seq))[0];
    if (!first) return { kind: 'deleted' };
    return { kind: 'link', conversationId: origin.conversation_id, messageId: first.id, threadRootId: first.thread_root_id };
  }
}
