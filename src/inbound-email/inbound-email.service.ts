// Read model for inbound-email visibility.
//
// The ledger and the poller row accumulate everything a user needs to answer "what happened to my
// email?" — received, skipped and why, which ticket it became, whether attachments made it, whether
// the mailbox is even polling — and until now none of it left the database. This service is the
// read side; nothing here writes.

import { Injectable } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

// The ledger grows by one row per email per automation. Newest-first with a cap keeps the response
// bounded; the index this relies on is (space_id, created_at DESC), which is why the query filters
// on space_id and not on automation_id alone.
const MAX_EVENTS = 50;

const EVENT_COLUMNS = `
  id, status, subject, from_address, received_at, created_at,
  skip_reason, error_message, task_id, run_id,
  attachments_imported_at, attachment_meta,
  task:tasks(key),
  run:automation_runs(status)
`;

export interface InboundEmailEvent {
  id: string;
  status: string;
  subject: string | null;
  fromAddress: string | null;
  receivedAt: string | null;
  createdAt: string;
  skipReason: string | null;
  errorMessage: string | null;
  taskId: string | null;
  taskKey: string | null;
  runId: string | null;
  runStatus: string | null;
  attachmentCount: number;
  attachmentsImportedAt: string | null;
}

export interface MailboxHealth {
  isActive: boolean;
  lastPolledAt: string | null;
  lastError: string | null;
  pollIntervalSeconds: number;
  /**
   * Interval configured in the unpublished draft, or null when there is no draft.
   * The poller row is written on publish only, so pollIntervalSeconds above is the
   * published one — this lets the banner say the draft disagrees.
   */
  draftPollIntervalSeconds: number | null;
}

export interface InboundEmailOverview {
  events: InboundEmailEvent[];
  mailbox: MailboxHealth | null;
}

@Injectable()
export class InboundEmailService {
  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Recent inbound emails for one automation, plus the mailbox's polling health.
   *
   * spaceId is required rather than derived: it is the leading column of the only usable index, and
   * passing it explicitly keeps this a second tenancy filter on top of the caller's org check.
   */
  async getOverview(
    automationId: string,
    spaceId: string,
  ): Promise<InboundEmailOverview> {
    const [events, mailbox] = await Promise.all([
      this.listEvents(automationId, spaceId),
      this.mailboxHealth(automationId),
    ]);

    return { events, mailbox };
  }

  private async listEvents(
    automationId: string,
    spaceId: string,
  ): Promise<InboundEmailEvent[]> {
    const { data, error } = await this.db
      .from('automation_inbound_email_events')
      .select(EVENT_COLUMNS)
      // space_id first so the (space_id, created_at DESC) index is used; automation_id narrows the
      // result within it. There is no index on automation_id alone.
      .eq('space_id', spaceId)
      .eq('automation_id', automationId)
      .order('created_at', { ascending: false })
      .limit(MAX_EVENTS);

    if (error) throw new Error(error.message);

    return (data ?? []).map((row) => this.toEvent(row));
  }

  private toEvent(row: unknown): InboundEmailEvent {
    const r = row as Record<string, unknown>;

    // Both embeds are nullable FKs with ON DELETE SET NULL, so a deleted ticket or run yields null
    // rather than a dangling id. PostgREST returns an object for a to-one embed, but tolerate an
    // array shape so a relationship-hint change cannot break this view.
    const task = this.firstEmbed(r.task) as { key?: string } | null;
    const run = this.firstEmbed(r.run) as { status?: string } | null;
    const meta = r.attachment_meta;

    return {
      id: (r.id as string) ?? '',
      status: (r.status as string | null) ?? 'pending',
      subject: (r.subject as string | null) ?? null,
      fromAddress: (r.from_address as string | null) ?? null,
      receivedAt: (r.received_at as string | null) ?? null,
      createdAt: (r.created_at as string) ?? '',
      skipReason: (r.skip_reason as string | null) ?? null,
      errorMessage: (r.error_message as string | null) ?? null,
      taskId: (r.task_id as string | null) ?? null,
      taskKey: task?.key ?? null,
      runId: (r.run_id as string | null) ?? null,
      runStatus: run?.status ?? null,
      attachmentCount: Array.isArray(meta) ? meta.length : 0,
      attachmentsImportedAt:
        (r.attachments_imported_at as string | null) ?? null,
    };
  }

  private firstEmbed(value: unknown): Record<string, unknown> | null {
    if (Array.isArray(value)) {
      return (value[0] as Record<string, unknown>) ?? null;
    }

    return (value as Record<string, unknown> | null) ?? null;
  }

  /** Null when this automation has no mailbox trigger — an empty state, not an error. */
  private async mailboxHealth(
    automationId: string,
  ): Promise<MailboxHealth | null> {
    // automation_id is UNIQUE on this table, so at most one row.
    const { data } = await this.db
      .from('automation_mailbox_pollers')
      .select('is_active, last_polled_at, last_error, poll_interval_seconds')
      .eq('automation_id', automationId)
      .maybeSingle();

    if (!data) return null;

    const row = data as {
      is_active?: boolean;
      last_polled_at?: string | null;
      last_error?: string | null;
      poll_interval_seconds?: number;
    };

    // Read the draft's interval purely so the banner can flag that an unpublished
    // change is not live yet. Runs after the early return above, so it never fires
    // for automations without a mailbox trigger. trigger_config is NOT NULL and is
    // written on every draft save, so no definition.nodes traversal is needed.
    const { data: draftRow } = await this.db
      .from('automation_versions')
      .select('trigger_config')
      .eq('automation_id', automationId)
      .eq('is_draft', true)
      .order('version_number', { ascending: false })
      .limit(1)
      .maybeSingle();

    const draftInterval = Number(
      (draftRow as { trigger_config?: Record<string, unknown> } | null)
        ?.trigger_config?.pollIntervalSeconds,
    );

    return {
      isActive: row.is_active === true,
      lastPolledAt: row.last_polled_at ?? null,
      lastError: row.last_error ?? null,
      pollIntervalSeconds: row.poll_interval_seconds ?? 300,
      draftPollIntervalSeconds: Number.isFinite(draftInterval)
        ? draftInterval
        : null,
    };
  }
}
