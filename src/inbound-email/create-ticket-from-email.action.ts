// "Create ticket from email" automation action.
//
// Deliberately NOT reusing app.task.create: that action writes straight to
// Supabase and never sanitizes `description` (actions/app-mutations/task.ts).
// Email bodies are attacker-controlled HTML from the public internet, so
// ingestion goes through TasksService.create, which runs sanitizeRichText and
// the full validation/audit/history path.
//
// Actions receive a plain ExecutionContext with no DI, which is exactly why
// app.task.create writes raw. The escape hatch is ActionRegistryService.register:
// an @Injectable that captures its services in the handler closure. Same pattern
// as document-designer/automation/export-by-template.action.ts.

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { ActionRegistryService } from '../automations/actions/action-registry.service';
import { AutomationConnectionsService } from '../automations/automation-connections.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { TasksService } from '../tasks/tasks.service';
import { GraphTokenService } from './graph-token.service';
import {
  importEmailAttachments,
  clampMaxFiles,
  DEFAULT_MAX_FILES,
  type AttachmentImportReport,
} from './attachment-import';
import type {
  ActionDefinition,
  ExecutionContext,
} from '../automations/actions/types';

interface EmailTriggerPayload {
  ledgerId?: string;
  from?: string;
  fromName?: string;
  subject?: string;
  summary?: string;
  bodyHtml?: string;
  receivedAt?: string;
  messageId?: string;
  hasAttachments?: boolean;
  attachments?: { name: string; contentType: string; size: number }[];
}

interface ActionConfig {
  taskType?: string;
  status?: string;
  priority?: string;
  assignedTo?: string;
  saveAttachments?: boolean;
  maxAttachments?: number;
}

interface ActionResult {
  taskId: string;
  taskKey: string | null;
  duplicate: boolean;
  attachmentsImported: number;
  attachmentsSkipped: number;
  attachmentsState: string;
}

/** Flattens the import report into the action's output shape. */
function withAttachments(
  base: { taskId: string; taskKey: string | null; duplicate: boolean },
  report: AttachmentImportReport,
): ActionResult {
  return {
    ...base,
    attachmentsImported: report.imported,
    attachmentsSkipped: report.skipped.length,
    attachmentsState: report.state,
  };
}

/**
 * The ledger row is the source of truth for attachment import, never ctx.triggerPayload.
 *
 * The poller's re-drive path rebuilds its outbox payload from the ledger and carries no body and no
 * attachment fields, so a re-driven run reading the payload would silently import nothing. Reading
 * the row makes the fresh path and the re-drive path behave identically.
 */
interface LedgerRow {
  task_id: string | null;
  space_id: string | null;
  connection_id: string | null;
  graph_message_id: string | null;
  attachments_imported_at: string | null;
}

const LEDGER_COLUMNS =
  'task_id, space_id, connection_id, graph_message_id, attachments_imported_at';

const IMPORT_DISABLED: AttachmentImportReport = {
  state: 'disabled',
  imported: 0,
  skipped: [],
};

@Injectable()
export class CreateTicketFromEmailAction implements OnModuleInit {
  private readonly logger = new Logger(CreateTicketFromEmailAction.name);

  constructor(
    private readonly registry: ActionRegistryService,
    private readonly tasksService: TasksService,
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly attachments: AttachmentsService,
    private readonly connectionsService: AutomationConnectionsService,
    private readonly tokenService: GraphTokenService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  onModuleInit(): void {
    this.registry.register(this.buildDefinition());
  }

  private buildDefinition(): ActionDefinition {
    return {
      kind: 'app.task.create_from_email',
      category: 'app_mutation',
      type: 'action',
      label: {
        en: 'Create ticket from email',
        de: 'Ticket aus E-Mail erstellen',
      },
      description: {
        en: 'Creates one ticket from the received email, with the body sanitised and duplicates prevented',
        de: 'Erstellt ein Ticket aus der empfangenen E-Mail, mit bereinigtem Inhalt und Duplikatschutz',
      },
      icon: 'bx-envelope-open',
      inputSchema: z.any(),
      configSchema: z.object({
        taskType: z.string().optional(),
        status: z.string().optional(),
        priority: z.string().optional(),
        assignedTo: z.string().optional(),
        // Defaults to TRUE: saving the files is the point of the feature, and an automation
        // published before this field existed has no such key at all. Defaulting to false left
        // every existing mailbox automation silently ignoring attachments until someone opened and
        // republished it, which reads as "the feature is broken". Matches the frontend schema
        // default, so a node configured in the UI and one that predates it behave the same.
        // Turning it off is still one click.
        saveAttachments: z.boolean().optional().default(true),
        maxAttachments: z.coerce.number().optional(),
      }),
      outputSchema: z.object({
        taskId: z.string(),
        taskKey: z.string().nullable(),
        duplicate: z.boolean(),
        // Surfaced so run history can show that a ticket was created but a file was not. The
        // attachment import never fails the run, so without these the drop is invisible.
        attachmentsImported: z.number(),
        attachmentsSkipped: z.number(),
        attachmentsState: z.string(),
      }),
      handler: async (config, _input, ctx) =>
        this.execute(config as ActionConfig, ctx),
    };
  }

  private async execute(
    config: ActionConfig,
    ctx: ExecutionContext,
  ): Promise<ActionResult> {
    const payload = (ctx.triggerPayload ?? {}) as EmailTriggerPayload;

    if (!payload.ledgerId) {
      // (400) marks this permanent for the worker's retry classifier — retrying an action wired
      // to the wrong trigger can never succeed, and 3 futile retries strand the ledger row.
      throw new Error(
        'Create ticket from email: this action only runs on an "Email received" trigger. (400)',
      );
    }

    // Idempotency gate 1 — a step retry or a manual run retry replays the same
    // trigger payload. If a ticket already exists for this email, return it
    // instead of creating a second one.
    const ledger = await this.loadLedger(payload.ledgerId);

    if (ledger?.task_id) {
      this.logger.log(
        `email ${payload.ledgerId} already produced task ${ledger.task_id} — returning it`,
      );

      // The ticket is done but the import may not be: a run that crashed between creating the task
      // and finishing its attachments would otherwise never pick them up, because every later
      // attempt short-circuits here. attachments_imported_at makes this a no-op once it succeeded.
      const report = await this.importAttachmentsSafely(
        config,
        ctx,
        payload.ledgerId,
        ledger,
        ledger.task_id,
      );

      return withAttachments(
        { taskId: ledger.task_id, taskKey: null, duplicate: true },
        report,
      );
    }

    // Claim so the poller's re-drive sweep stops re-emitting this message while
    // the run is in flight.
    await this.db
      .from('automation_inbound_email_events')
      .update({ run_id: ctx.runId })
      .eq('id', payload.ledgerId)
      .is('task_id', null);

    try {
      const taskTypeId =
        config.taskType ??
        (await this.resolveDefaultTaskType(ctx.organizationId, ctx.spaceId));

      const userId = await this.resolveCreator(payload.from, ctx);

      // The ledger id IS the task id. A retry whose first attempt committed the row but lost the
      // response collides on the primary key instead of creating a second ticket — Postgres, not
      // application logic, decides. Same reserved-id shape as help-center's createTaskForRequest.
      let task: { id: string; key?: string | null };

      try {
        task = await this.tasksService.create(
          ctx.organizationId,
          userId,
          {
            space_id: ctx.spaceId,
            task_type_id: taskTypeId,
            // Already capped at 500 by the normalizer; CreateTaskDto enforces it too.
            summary: payload.summary ?? payload.subject ?? '(no subject)',
            // sanitizeRichText runs inside create() — this is the whole reason the
            // ingestion path does not use app.task.create.
            description: this.buildDescription(
              payload,
              config.saveAttachments === true,
            ),
            ...(config.status ? { status: config.status } : {}),
            ...(config.priority ? { priority: config.priority } : {}),
            ...(config.assignedTo ? { assigned_to: config.assignedTo } : {}),
          },
          { taskId: payload.ledgerId },
        );
      } catch (err) {
        const code =
          (err as { cause?: { code?: string }; code?: string })?.cause?.code ??
          (err as { code?: string })?.code;

        const adopted =
          code === '23505'
            ? await this.adoptTask(payload.ledgerId, ctx.organizationId)
            : null;

        // Any other unique violation is a real failure, not our own earlier attempt.
        if (!adopted) throw err;

        this.logger.log(
          `email ${payload.ledgerId} already had task ${adopted.id} committed — adopting it`,
        );

        task = adopted;
      }

      // Idempotency gate 2 — only the first writer wins, and it decides who imports attachments.
      const { data: claimed, error: claimError } = await this.db
        .from('automation_inbound_email_events')
        .update({ status: 'created', task_id: task.id })
        .eq('id', payload.ledgerId)
        .is('task_id', null)
        .select('id')
        .maybeSingle();

      // A statement error is not a lost race. Swallowing it reports success while the ledger
      // still says 'pending', so the ticket exists but nothing records that it does.
      if (claimError) {
        throw new Error(
          `ledger claim failed for email ${payload.ledgerId}: ${claimError.message}`,
        );
      }

      if (!claimed) {
        // A concurrent attempt got there first. Narrow window, but report both
        // ids rather than leaving an unexplained orphan.
        const winner = await this.existingTask(payload.ledgerId);

        this.logger.warn(
          `email ${payload.ledgerId} raced: task ${task.id} created but ${winner ?? 'unknown'} already claimed it`,
        );

        // The winner imports; reporting 'disabled' here would be a lie, so say nothing happened on
        // this path specifically.
        return withAttachments(
          { taskId: winner ?? task.id, taskKey: null, duplicate: true },
          { state: 'already', imported: 0, skipped: [] },
        );
      }

      // Only the run that won the claim imports, so two concurrent attempts can never both upload
      // the same files under disambiguated names. The loser returned above without importing.
      const report = await this.importAttachmentsSafely(
        config,
        ctx,
        payload.ledgerId,
        ledger,
        task.id,
      );

      return withAttachments(
        {
          taskId: task.id,
          taskKey: (task as { key?: string | null }).key ?? null,
          duplicate: false,
        },
        report,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Visible on the ledger AND on the failed run, and retryable. Guarded on task_id so a
      // late-failing loser cannot overwrite a row another run already marked 'created'.
      await this.db
        .from('automation_inbound_email_events')
        .update({ status: 'failed', error_message: message })
        .eq('id', payload.ledgerId)
        .is('task_id', null);

      throw err;
    }
  }

  private buildDescription(
    payload: EmailTriggerPayload,
    saveAttachments: boolean,
  ): string {
    const parts = [payload.bodyHtml ?? ''];
    const sender = payload.fromName
      ? `${payload.fromName} &lt;${payload.from ?? ''}&gt;`
      : (payload.from ?? 'unknown sender');

    // Traceability footer: sender and received time stay on the ticket even if
    // the ledger row is later cleaned up.
    parts.push(
      `<p><em>Received from ${sender} at ${payload.receivedAt ?? 'unknown time'}.</em></p>`,
    );

    if (payload.hasAttachments && payload.attachments?.length) {
      const names = payload.attachments
        .map((a) => `${a.name} (${Math.round((a.size || 0) / 1024)} KB)`)
        .join(', ');

      // Two wordings, because only one of them can be honest. With the switch off nothing is ever
      // stored, so the original "not imported" line stays exactly as it was. With it on, this states
      // what the EMAIL carried rather than promising what landed — the import runs after the ticket
      // is created and a file can still be skipped as inline, oversized or unsupported, and the
      // Attachments panel is the truth for what actually arrived.
      parts.push(
        saveAttachments
          ? `<p><em>Original email had ${payload.attachments.length} attachment(s): ${names}</em></p>`
          : `<p><em>Original email had ${payload.attachments.length} attachment(s), not imported: ${names}</em></p>`,
      );
    }

    return parts.join('\n');
  }

  /** Mirrors TasksMineWriteService.resolveDefaultTaskTypeId, which is private. */
  private async resolveDefaultTaskType(
    organizationId: string,
    spaceId: string,
  ): Promise<string> {
    const types = await this.tasksService.getActiveTaskTypesForSpace(
      organizationId,
      spaceId,
    );

    if (types.length === 0) {
      throw new Error(
        'Create ticket from email: this space has no active task types configured. (400)',
      );
    }

    const canonical = types.find((t) => t.id === 'task');

    if (canonical) return canonical.id;

    const root = types.find((t) => !t.parent_level_id);

    return (root ?? types[0]).id;
  }

  /**
   * Sender → a user in this org, else the automation's acting user, else the
   * automation's owner. Fails loudly rather than passing null into create().
   */
  private async resolveCreator(
    fromAddress: string | undefined,
    ctx: ExecutionContext,
  ): Promise<string> {
    if (fromAddress) {
      // public.users.id, never auth.users.id — every task FK points at the former.
      //
      // ilike, not eq: Postgres equality is case-sensitive and nothing forces
      // users.email lowercase, so an internal sender stored as "John.Smith@..."
      // would silently fail to match and the ticket would be misattributed.
      // limit(1) rather than maybeSingle() — maybeSingle throws on >1 row, which
      // would fail ticket creation outright over a duplicate membership.
      // Escape LIKE wildcards first. "_" is common in real addresses, so an
      // unescaped ilike would let a crafted sender (a_b@x.com) match a
      // DIFFERENT user (axb@x.com) and misattribute the ticket to them.
      const pattern = fromAddress.replace(/[\\%_]/g, (c) => `\\${c}`);

      const { data } = await this.db
        .from('users')
        .select('id, organization_members!inner(organization_id)')
        .ilike('email', pattern)
        .eq('organization_members.organization_id', ctx.organizationId)
        .limit(1);

      const matched = ((data ?? []) as { id?: string }[])[0]?.id;

      if (matched) return matched;
    }

    if (ctx.actingUserId) return ctx.actingUserId;

    const { data: automation } = await this.db
      .from('automations')
      .select('created_by')
      .eq('id', ctx.automationId)
      .maybeSingle();

    const owner = (automation as { created_by?: string | null } | null)
      ?.created_by;

    if (owner) return owner;

    throw new Error(
      'Create ticket from email: no user could be resolved to own the ticket. ' +
        'Set AUTOMATION_SERVICE_USER_ID, or make sure the automation has an owner. (400)',
    );
  }

  private async loadLedger(ledgerId: string): Promise<LedgerRow | null> {
    const { data } = await this.db
      .from('automation_inbound_email_events')
      .select(LEDGER_COLUMNS)
      .eq('id', ledgerId)
      .maybeSingle();

    return (data as LedgerRow | null) ?? null;
  }

  /**
   * Import the email's attachments onto the ticket. Never throws.
   *
   * The ticket already exists by the time this runs and it is the thing that matters — a mailbox
   * that starts refusing attachment reads must not turn every incoming email into a failed run with
   * no ticket. Failures are recorded on the ledger and logged, and the row stays 'created'.
   */
  private async importAttachmentsSafely(
    config: ActionConfig,
    ctx: ExecutionContext,
    ledgerId: string,
    ledger: LedgerRow | null,
    taskId: string,
  ): Promise<AttachmentImportReport> {
    // Every early exit reports WHY. "imported 0" alone cannot distinguish "switched off" from
    // "nothing to import", and run history has to show the difference.
    if (config.saveAttachments !== true) return IMPORT_DISABLED;
    if (!ledger) return IMPORT_DISABLED;

    // Already done. Cheap guard that also stops a re-drive re-downloading everything from Graph,
    // which throttles hard.
    if (ledger.attachments_imported_at) {
      return { state: 'already', imported: 0, skipped: [] };
    }

    try {
      if (!ledger.graph_message_id) {
        // Ingested before this feature shipped, so the Graph id was never stored. Nothing to fetch.
        await this.noteAttachmentIssue(
          ledgerId,
          'attachments not imported: this email predates attachment support',
        );

        return { state: 'unsupported', imported: 0, skipped: [] };
      }

      if (!ledger.connection_id) {
        return { state: 'unsupported', imported: 0, skipped: [] };
      }

      const spaceId = ledger.space_id ?? ctx.spaceId;
      const task = await this.taskContext(taskId);

      if (!task) return { state: 'unsupported', imported: 0, skipped: [] };

      const [secret, metadata, updatedAt] = await Promise.all([
        this.connectionsService.getDecryptedSecret(
          ledger.connection_id,
          spaceId,
        ),
        this.connectionsService.getConnectionMetadata(
          ledger.connection_id,
          spaceId,
        ),
        this.connectionUpdatedAt(ledger.connection_id),
      ]);

      const creds = GraphTokenService.readCredentials(
        secret,
        metadata as Record<string, unknown>,
      );

      const accessToken = await this.tokenService.getToken(
        `${ledger.connection_id}:${updatedAt}`,
        creds,
      );

      const outcome = await importEmailAttachments(
        this.attachments,
        this.logger,
        {
          accessToken,
          mailboxAddress: creds.mailboxAddress,
          graphMessageId: ledger.graph_message_id,
          taskId,
          // From the task row, not the run context: importVersion writes whatever org/space it is
          // given without validating either, so these must describe the task itself.
          organizationId: task.organizationId,
          spaceId: task.spaceId,
          userId: task.createdBy,
          maxFiles: clampMaxFiles(config.maxAttachments ?? DEFAULT_MAX_FILES),
          existingNames: await this.existingAttachmentNames(taskId),
        },
      );

      await this.db
        .from('automation_inbound_email_events')
        .update({ attachments_imported_at: new Date().toISOString() })
        .eq('id', ledgerId);

      const skippedSummary = outcome.skipped
        .map((s) => `${s.name}: ${s.reason}`)
        .join('; ');

      this.logger.log(
        `email ${ledgerId}: imported ${outcome.imported} attachment(s) to task ${taskId}` +
          (outcome.skipped.length
            ? `, skipped ${outcome.skipped.length} (${skippedSummary})`
            : ''),
      );

      // A partial import is the case that used to vanish: the ticket is created, the run says
      // succeeded, and nothing anywhere said a file was dropped. Recording it on the ledger is what
      // makes it visible in the inbound-email view.
      if (outcome.skipped.length) {
        await this.noteAttachmentIssue(
          ledgerId,
          `${outcome.skipped.length} attachment(s) not imported — ${skippedSummary}`,
        );
      }

      return { state: 'done', ...outcome };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      this.logger.error(
        `email ${ledgerId}: attachment import failed for task ${taskId}: ${message}`,
      );
      await this.noteAttachmentIssue(
        ledgerId,
        `attachment import failed: ${message}`,
      );

      return { state: 'error', imported: 0, skipped: [], error: message };
    }
  }

  /**
   * Org, space and owner for the task, straight from the row.
   *
   * created_by is used to attribute the files. It is a real users.id and both attachment columns are
   * FKs, so this is the one value guaranteed to satisfy them on every path — including the duplicate
   * path, where the sender was resolved by an earlier run this one knows nothing about.
   */
  private async taskContext(taskId: string): Promise<{
    organizationId: string;
    spaceId: string | null;
    createdBy: string;
  } | null> {
    const { data } = await this.db
      .from('tasks')
      .select('organization_id, space_id, created_by')
      .eq('id', taskId)
      .maybeSingle();

    const row = data as {
      organization_id?: string;
      space_id?: string | null;
      created_by?: string | null;
    } | null;

    if (!row?.organization_id || !row.created_by) {
      this.logger.warn(
        `task ${taskId} has no organization or creator — skipping attachment import`,
      );

      return null;
    }

    return {
      organizationId: row.organization_id,
      spaceId: row.space_id ?? null,
      createdBy: row.created_by,
    };
  }

  /**
   * File names already on the task, lower-cased.
   *
   * file_attachments is UNIQUE(entity_type, entity_id, file_name), and importVersion adopts a
   * matching version instead of writing — so importing "report.pdf" onto a task that already has one
   * would return success while silently discarding the bytes. The importer renames around these.
   */
  private async existingAttachmentNames(taskId: string): Promise<Set<string>> {
    const { data } = await this.db
      .from('file_attachments')
      .select('file_name')
      .eq('entity_type', 'task')
      .eq('entity_id', taskId);

    return new Set(
      ((data ?? []) as { file_name?: string }[])
        .map((r) => (r.file_name ?? '').toLowerCase())
        .filter(Boolean),
    );
  }

  /** Part of the token cache key, so re-saved credentials take effect at once. */
  private async connectionUpdatedAt(connectionId: string): Promise<string> {
    const { data } = await this.db
      .from('automation_connections')
      .select('updated_at')
      .eq('id', connectionId)
      .maybeSingle();

    return (data as { updated_at: string } | null)?.updated_at ?? 'unknown';
  }

  /**
   * Record an attachment problem without failing the email.
   *
   * status stays 'created' on purpose: the ticket exists, so calling the row failed would be wrong
   * and would put it back in the re-drive sweep.
   */
  private async noteAttachmentIssue(
    ledgerId: string,
    message: string,
  ): Promise<void> {
    await this.db
      .from('automation_inbound_email_events')
      .update({ error_message: message })
      .eq('id', ledgerId);
  }

  private async existingTask(ledgerId: string): Promise<string | null> {
    const { data } = await this.db
      .from('automation_inbound_email_events')
      .select('task_id')
      .eq('id', ledgerId)
      .maybeSingle();

    return (data as { task_id: string | null } | null)?.task_id ?? null;
  }

  /**
   * The ticket a previous attempt already committed under the ledger id.
   *
   * The organization filter is the sanity guard: it turns "some other row happens to carry this
   * uuid" into a null, so a 23505 from an unrelated constraint still surfaces as a real failure.
   */
  private async adoptTask(
    ledgerId: string,
    organizationId: string,
  ): Promise<{ id: string; key: string | null } | null> {
    const { data } = await this.db
      .from('tasks')
      .select('id, key')
      .eq('id', ledgerId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    return (data as { id: string; key: string | null } | null) ?? null;
  }
}
