// The inbound-mailbox poll cycle.
//
// Claim a due poller → re-drive anything stuck → fetch new mail → record it →
// hand it to the automation engine via the outbox. Deliberately NOT inside
// AutomationTickService: runTick is serial behind a single isTicking guard, and
// its first step relays the outbox for every tenant. A hung Graph call in there
// would stall all app-event automations product-wide.

import { Injectable, Logger } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AutomationConnectionsService } from '../automations/automation-connections.service';
import { AutomationEventOutboxService } from '../automations/automation-event-outbox.service';
import {
  fetchNewMessages,
  fetchAttachmentMeta,
  GraphResyncRequiredError,
  type FetchResult,
} from './graph-mailbox.reader';
import {
  normalizeMessage,
  parseAddressList,
  type NormalizedEmail,
} from './email-normalizer';
import { GraphTokenService } from './graph-token.service';

const TRIGGER_KIND = 'mailbox.email_received';
const LEASE_SECONDS = 300;
const POLLERS_PER_CYCLE = 5;
const REDRIVE_PER_CYCLE = 25;
// A row must be stuck this long before re-driving, so a run that is merely
// queued is not re-emitted on the next cycle.
const REDRIVE_MIN_AGE_MS = 10 * 60_000;
// Clock margin for the run lookup: started_at is app time, created_at is DB time.
const REDRIVE_RUN_LOOKBACK_MS = 5 * 60_000;

const POLLER_COLUMNS =
  'id, automation_id, space_id, organization_id, connection_id, folder, delta_cursor, watermark_at, poll_interval_seconds, last_polled_at, lease_until';

interface PollerRow {
  id: string;
  automation_id: string;
  space_id: string;
  organization_id: string;
  connection_id: string;
  folder: string;
  delta_cursor: string | null;
  watermark_at: string;
  poll_interval_seconds: number;
  last_polled_at: string | null;
  lease_until: string | null;
}

@Injectable()
export class MailboxPollService {
  private readonly logger = new Logger(MailboxPollService.name);
  private readonly workerId = `mailbox-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly connectionsService: AutomationConnectionsService,
    private readonly outboxService: AutomationEventOutboxService,
    private readonly tokenService: GraphTokenService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  async runPollCycle(): Promise<{ polled: number; ingested: number }> {
    const claimed = await this.claimDuePollers();
    let ingested = 0;

    for (const poller of claimed) {
      try {
        ingested += await this.pollOne(poller);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        this.logger.error(
          `poll failed for automation ${poller.automation_id}: ${message}`,
        );
        // Surfaced on the connection/automation status; the next cycle retries.
        await this.finishPoll(poller.id, { lastError: message });
      }
    }

    return { polled: claimed.length, ingested };
  }

  /**
   * Atomic claim, mirroring AutomationQueueService.leaseSteps: select candidates,
   * then UPDATE with the lease predicate still in the WHERE. A second worker's
   * update matches zero rows, so double-claiming is impossible without an RPC.
   */
  private async claimDuePollers(): Promise<PollerRow[]> {
    const nowIso = new Date().toISOString();

    const { data: candidates } = await this.db
      .from('automation_mailbox_pollers')
      .select('id, last_polled_at, poll_interval_seconds')
      .eq('is_active', true)
      .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
      .order('last_polled_at', { ascending: true, nullsFirst: true })
      .limit(POLLERS_PER_CYCLE * 2);

    const due = (candidates ?? [])
      .filter((c) => {
        const row = c as {
          last_polled_at: string | null;
          poll_interval_seconds: number;
        };

        if (!row.last_polled_at) return true;

        const nextAt =
          new Date(row.last_polled_at).getTime() +
          row.poll_interval_seconds * 1000;

        return nextAt <= Date.now();
      })
      .slice(0, POLLERS_PER_CYCLE)
      .map((c) => (c as { id: string }).id);

    if (due.length === 0) return [];

    const leaseUntil = new Date(
      Date.now() + LEASE_SECONDS * 1000,
    ).toISOString();

    // Two claims, never one .or(): on a MUTATION PostgREST resolves .or() against
    // the RETURNING projection, so writing a future lease_until makes that very
    // predicate false — the row is leased but never returned and the poll silently
    // never runs. Simple filters are applied pre-update, and the two predicates are
    // disjoint, so no row is ever claimed twice.
    const { data: unleased } = await this.db
      .from('automation_mailbox_pollers')
      .update({ lease_until: leaseUntil, worker_id: this.workerId })
      .in('id', due)
      .is('lease_until', null)
      .select(POLLER_COLUMNS);

    const { data: expired } = await this.db
      .from('automation_mailbox_pollers')
      .update({ lease_until: leaseUntil, worker_id: this.workerId })
      .in('id', due)
      .lt('lease_until', nowIso)
      .select(POLLER_COLUMNS);

    const claimed = [
      ...(unleased ?? []),
      ...(expired ?? []),
    ] as unknown as PollerRow[];

    // A silent zero here is exactly how the .or() bug stayed invisible.
    if (claimed.length < due.length) {
      this.logger.warn(
        `claimed ${claimed.length}/${due.length} due mailbox poller(s)`,
      );
    }

    return claimed;
  }

  private async pollOne(poller: PollerRow): Promise<number> {
    // App-only credentials live on the connection: the secret encrypted, the
    // tenant/client/mailbox in metadata. Both reads are space-scoped — a
    // background loop has no controller-level tenant check.
    const [secret, metadata, updatedAt] = await Promise.all([
      this.connectionsService.getDecryptedSecret(
        poller.connection_id,
        poller.space_id,
      ),
      this.connectionsService.getConnectionMetadata(
        poller.connection_id,
        poller.space_id,
      ),
      this.connectionUpdatedAt(poller.connection_id),
    ]);

    const creds = GraphTokenService.readCredentials(
      secret,
      metadata as Record<string, unknown>,
    );

    // updatedAt in the key: re-saving the connection with a rotated secret
    // invalidates the cached token immediately instead of after its ~1h life.
    const accessToken = await this.tokenService.getToken(
      `${poller.connection_id}:${updatedAt}`,
      creds,
    );

    // Re-drive BEFORE fetching. enqueueRun returns false (not throws) on a
    // concurrency cap and the relay marks the outbox row relayed regardless, so
    // without this a capped message would be marked seen and never become a
    // ticket. The ledger is the work queue, not just a dedupe record.
    let ingested = await this.redrivePending(poller);

    const mailbox = creds.mailboxAddress;
    const config = await this.triggerConfig(poller.automation_id);

    let result: FetchResult;

    try {
      result = await fetchNewMessages({
        accessToken,
        mailboxAddress: mailbox,
        folder: poller.folder,
        watermarkAt: poller.watermark_at,
        deltaCursor: poller.delta_cursor,
        unreadOnly: config.unreadOnly === true,
      });
    } catch (err) {
      if (err instanceof GraphResyncRequiredError) {
        // Expired deltaLink. Clear it and re-seed from the watermark next cycle
        // rather than wedging this mailbox permanently on a 410.
        this.logger.warn(
          `delta cursor expired for automation ${poller.automation_id} — resyncing from watermark`,
        );
        await this.finishPoll(poller.id, {
          clearCursor: true,
          lastError: null,
        });

        return ingested;
      }

      throw err;
    }

    for (const raw of result.messages) {
      const normalized = normalizeMessage(raw, {
        mailboxAddress: mailbox,
        blockedSenders: parseAddressList(config.blockedSenders),
        allowedSenders: parseAddressList(config.allowedSenders),
        maxBodyChars: config.maxBodyChars,
      });

      if (!normalized.ok) {
        await this.recordSkip(poller, raw, normalized.skipReason);
        continue;
      }

      const email = normalized.email;

      // A reply to something already ingested would otherwise open a second
      // ticket for the same conversation. Checked BEFORE the attachment fetch so
      // a skipped reply costs no extra Graph call — Graph throttles aggressively.
      if (
        email.inReplyTo &&
        (await this.isKnownMessage(poller, email.inReplyTo))
      ) {
        await this.recordSkip(poller, raw, 'reply_to_existing_ticket');
        continue;
      }

      if (email.hasAttachments && raw.id) {
        email.attachments = (
          await fetchAttachmentMeta(accessToken, mailbox, raw.id)
        ).map((a) => ({
          name: a.name ?? 'attachment',
          contentType: a.contentType ?? 'application/octet-stream',
          size: a.size ?? 0,
        }));
      }

      const ledgerId = await this.insertLedgerRow(
        poller,
        email,
        raw.id ?? null,
      );

      // Null = UNIQUE conflict = another worker or an earlier poll already has
      // it. Postgres, not application logic, is what makes this race-proof.
      if (!ledgerId) continue;

      await this.emit(poller, email, ledgerId);
      ingested++;
    }

    // The non-delta /messages endpoint returns no deltaLink, so the watermark —
    // not the cursor — is what stops the query window growing forever. Advance
    // it to the newest message actually seen this cycle.
    // Compare as instants, never as strings: Graph returns "…Z" while Postgres
    // returns "…+00:00", and "…Z" > "…+00:00" is ALWAYS true lexically ('Z' 90 >
    // '+' 43), so a string guard would never actually guard.
    const newestSeen = result.messages
      .map((m) => m.receivedDateTime)
      .filter((d): d is string => Boolean(d))
      .reduce<string | undefined>(
        (newest, d) =>
          !newest || Date.parse(d) > Date.parse(newest) ? d : newest,
        undefined,
      );

    const advances =
      newestSeen !== undefined &&
      Date.parse(newestSeen) > Date.parse(poller.watermark_at);

    await this.finishPoll(poller.id, {
      cursor: result.nextCursor,
      watermarkAt: advances ? newestSeen : undefined,
      lastError: null,
    });

    return ingested;
  }

  /** Re-emit ledger rows that never got a run. */
  private async redrivePending(poller: PollerRow): Promise<number> {
    // Only rows genuinely stuck. Without the age floor this re-emits an outbox
    // row every cycle for a message whose run is merely still queued, growing
    // the outbox without bound.
    const staleBefore = new Date(Date.now() - REDRIVE_MIN_AGE_MS).toISOString();

    // run_id is a cheap index-backed pre-filter, never the decision. It is stamped only by the
    // create-ticket action, so a row whose automation has no such node — or whose branch routed
    // around it — keeps a NULL run_id forever and was re-emitted every cycle, without end.
    // A non-null run_id still proves a run happened, so excluding those here is always safe.
    const { data, error } = await this.db
      .from('automation_inbound_email_events')
      .select('id, message_id, from_address, subject, received_at, created_at')
      .eq('connection_id', poller.connection_id)
      .eq('status', 'pending')
      .is('run_id', null)
      .lt('created_at', staleBefore)
      .order('created_at', { ascending: true })
      .limit(REDRIVE_PER_CYCLE);

    // A silent zero is exactly how the .or() bug stayed invisible — never discard this error.
    if (error) {
      this.logger.error(
        `re-drive scan failed for automation ${poller.automation_id}: ${error.message}`,
      );

      return 0;
    }

    const candidates = (data ?? []) as {
      id: string;
      message_id: string | null;
      from_address: string | null;
      subject: string | null;
      received_at: string | null;
      created_at: string;
    }[];

    if (candidates.length === 0) return 0;

    // The real exit condition: did this message already produce a run? "Handed to the outbox" is
    // a different question — enqueueRun declines silently on a concurrency cap or when no action
    // node is connected, so the ledger stays the work queue rather than a dispatch log.
    const alreadyRun = await this.ledgerIdsWithRuns(
      poller.automation_id,
      candidates[0].created_at,
    );

    // Unknown state: skip this cycle rather than re-emit blindly. The next cycle retries.
    if (!alreadyRun) return 0;

    const rows = candidates.filter((row) => !alreadyRun.has(row.id));

    for (const row of rows) {
      await this.outboxService.write(
        poller.organization_id,
        poller.space_id,
        TRIGGER_KIND,
        {
          ledgerId: row.id,
          messageId: row.message_id,
          from: row.from_address,
          subject: row.subject,
          receivedAt: row.received_at,
          redriven: true,
        },
      );
    }

    if (rows.length > 0) {
      this.logger.log(
        `re-drove ${rows.length} pending message(s) for automation ${poller.automation_id}`,
      );
    }

    return 0;
  }

  /**
   * Ledger ids that already produced a run for this automation, since `since`.
   *
   * Answers the question the re-drive actually needs — "did this become a run?" — rather than
   * "was it handed to the outbox", which the ledger cannot distinguish from a dropped dispatch.
   * Reads `automation_runs` and not `automation_event_outbox` because the outbox is pruned daily
   * while runs are kept 90 days; a pruned outbox row would read as never-dispatched and storm.
   *
   * Returns null when the lookup itself failed, so the caller can hold rather than re-emit blind.
   */
  private async ledgerIdsWithRuns(
    automationId: string,
    since: string,
  ): Promise<Set<string> | null> {
    // Clock margin: started_at comes from the app while created_at comes from the DB, so a run
    // can legitimately look microseconds older than the ledger row that caused it.
    const from = new Date(
      Date.parse(since) - REDRIVE_RUN_LOOKBACK_MS,
    ).toISOString();

    // Served by automation_runs_automation_started_idx (automation_id, started_at DESC).
    const { data, error } = await this.db
      .from('automation_runs')
      .select('trigger_payload')
      .eq('automation_id', automationId)
      .eq('trigger_kind', TRIGGER_KIND)
      .gte('started_at', from);

    if (error) {
      this.logger.error(
        `re-drive run lookup failed for automation ${automationId}: ${error.message}`,
      );

      return null;
    }

    const ids = new Set<string>();

    for (const row of (data ?? []) as {
      trigger_payload: { ledgerId?: unknown } | null;
    }[]) {
      const id = row.trigger_payload?.ledgerId;

      if (typeof id === 'string') ids.add(id);
    }

    return ids;
  }

  private async insertLedgerRow(
    poller: PollerRow,
    email: NormalizedEmail,
    graphMessageId: string | null,
  ): Promise<string | null> {
    const { data, error } = await this.db
      .from('automation_inbound_email_events')
      .upsert(
        {
          connection_id: poller.connection_id,
          automation_id: poller.automation_id,
          space_id: poller.space_id,
          organization_id: poller.organization_id,
          dedupe_key: email.dedupeKey,
          message_id: email.messageId,
          in_reply_to: email.inReplyTo,
          from_address: email.from,
          subject: email.subject,
          received_at: email.receivedAt,
          status: 'pending',
          attachment_meta: email.attachments,
          // message_id above is the RFC internetMessageId; Graph cannot address an attachment by
          // it. This is the id the attachment reads need, and it is the only place it survives —
          // the re-drive path rebuilds its payload from this row, not from the original message.
          graph_message_id: graphMessageId,
        },
        { onConflict: 'connection_id,dedupe_key', ignoreDuplicates: true },
      )
      .select('id')
      .maybeSingle();

    // Two different things return no row, and they must not be treated alike.
    //
    // ignoreDuplicates gives data:null with NO error when this message was already ingested — the
    // normal dedupe path, and the caller is right to skip it. data:null WITH an error is a real
    // failure, and swallowing it loses the email permanently: the caller reads it as "duplicate",
    // the watermark still advances past this message, and nothing ever retries it. Throwing instead
    // leaves the watermark where it is, so the next cycle picks the message up again.
    if (error) {
      throw new Error(`ledger insert failed: ${error.message}`);
    }

    return (data as { id: string } | null)?.id ?? null;
  }

  private async emit(
    poller: PollerRow,
    email: NormalizedEmail,
    ledgerId: string,
  ): Promise<void> {
    // The tick's existing outbox relay matches this kind against the automation's
    // event subscription and creates the run — so the whole proven path
    // (concurrency caps, run + step seeding) is reused untouched.
    await this.outboxService.write(
      poller.organization_id,
      poller.space_id,
      TRIGGER_KIND,
      {
        ledgerId,
        messageId: email.messageId,
        from: email.from,
        fromName: email.fromName,
        subject: email.subject,
        summary: email.summary,
        bodyHtml: email.bodyHtml,
        receivedAt: email.receivedAt,
        hasAttachments: email.hasAttachments,
        attachments: email.attachments,
      },
    );
  }

  private async recordSkip(
    poller: PollerRow,
    raw: { id?: string; internetMessageId?: string; subject?: string | null },
    skipReason: string,
  ): Promise<void> {
    // Must be STABLE. A timestamp here would mint a fresh row every time a batch
    // is re-fetched (e.g. after a mid-batch error left the watermark unmoved),
    // growing the ledger without bound. Graph's message id is stable per mailbox.
    const key =
      raw.internetMessageId ??
      (raw.id ? `graph:${raw.id}` : null) ??
      `skip:${poller.id}:${Date.now()}`;

    // Skipped messages create no run, so without this line they are invisible
    // to an operator wondering why an email never became a ticket. The ledger
    // row is the durable record; this is the breadcrumb.
    this.logger.log(
      `skipped message for automation ${poller.automation_id}: ${skipReason}` +
        `${raw.subject ? ` (subject: ${raw.subject.slice(0, 80)})` : ''}`,
    );

    await this.db.from('automation_inbound_email_events').upsert(
      {
        connection_id: poller.connection_id,
        automation_id: poller.automation_id,
        space_id: poller.space_id,
        organization_id: poller.organization_id,
        dedupe_key: key,
        message_id: raw.internetMessageId ?? null,
        subject: raw.subject ?? null,
        status: 'skipped',
        skip_reason: skipReason,
      },
      { onConflict: 'connection_id,dedupe_key', ignoreDuplicates: true },
    );
  }

  private async isKnownMessage(
    poller: PollerRow,
    messageId: string,
  ): Promise<boolean> {
    // limit(1), not maybeSingle(): several ledger rows can legitimately carry the
    // same message_id (different dedupe keys), and maybeSingle throws on >1.
    const { data } = await this.db
      .from('automation_inbound_email_events')
      .select('id')
      .eq('connection_id', poller.connection_id)
      .eq('message_id', messageId)
      .limit(1);

    return (data ?? []).length > 0;
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

  private async triggerConfig(automationId: string): Promise<{
    blockedSenders?: string;
    allowedSenders?: string;
    maxBodyChars?: number;
    unreadOnly?: boolean;
  }> {
    // Read the PUBLISHED version specifically — an inner join across
    // automation_versions would happily hand back a stale draft's config.
    const { data: automation } = await this.db
      .from('automations')
      .select('published_version_id')
      .eq('id', automationId)
      .maybeSingle();

    const versionId = (
      automation as { published_version_id?: string | null } | null
    )?.published_version_id;

    if (!versionId) return {};

    const { data: version } = await this.db
      .from('automation_versions')
      .select('trigger_config')
      .eq('id', versionId)
      .maybeSingle();

    const cfg = (version as { trigger_config?: Record<string, unknown> } | null)
      ?.trigger_config;

    return (cfg ?? {}) as {
      blockedSenders?: string;
      allowedSenders?: string;
      maxBodyChars?: number;
      unreadOnly?: boolean;
    };
  }

  private async finishPoll(
    pollerId: string,
    opts: {
      cursor?: string | null;
      clearCursor?: boolean;
      watermarkAt?: string;
      lastError?: string | null;
    },
  ): Promise<void> {
    const patch: Record<string, unknown> = {
      last_polled_at: new Date().toISOString(),
      lease_until: null,
      worker_id: null,
    };

    if (opts.clearCursor) patch.delta_cursor = null;
    else if (opts.cursor !== undefined) patch.delta_cursor = opts.cursor;
    if (opts.watermarkAt) patch.watermark_at = opts.watermarkAt;
    if (opts.lastError !== undefined) patch.last_error = opts.lastError;

    const { error } = await this.db
      .from('automation_mailbox_pollers')
      .update(patch)
      .eq('id', pollerId);

    // Never swallow this: if the release fails, the lease stays held and the
    // mailbox silently stops polling with no error recorded anywhere.
    if (error) {
      this.logger.error(
        `failed to release poller ${pollerId}: ${error.message}`,
      );
    }
  }
}
