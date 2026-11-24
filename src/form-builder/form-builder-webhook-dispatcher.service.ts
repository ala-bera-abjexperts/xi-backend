import { createHmac } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { assertPublicHttpUrl } from '../common/security/ssrf-guard';
import { decryptApiKey } from '../lib/crypto/encryption';
import { toText } from './integrations/field-map.util';

const WEBHOOKS_TABLE = 'form_builder_webhooks';
const DELIVERIES_TABLE = 'form_builder_webhook_deliveries';
const SUBMISSIONS_TABLE = 'form_builder_submissions';

// aligned with the drain RPC default
const DRAIN_BATCH_SIZE = 50;
// retry attempts before a delivery is moved to status='dead'
const MAX_ATTEMPTS = 5;
// mirror of the workflow-outbox dispatcher timeout
const FETCH_TIMEOUT_MS = 15_000;

// providers that receive the full JSON payload (an automation catch-hook or the generic
// webhook) rather than a formatted chat message. Everything else goes through formatChatBody
// and receives a { text } chat message (slack/rocketchat/zohocliq/webex/telegram/googlechat/
// mattermost), with discord ({ content }) and teams (MessageCard) as the two special shapes.
const JSON_PROVIDERS = new Set([
  'generic',
  'zapier',
  'make',
  'n8n',
  'pipedream',
  'ifttt',
  'powerautomate',
  'airtable',
  'googlesheets',
]);

interface Ctx {
  spaceId: string;
  orgId: string;
}

interface EnqueueSubmission {
  id: string;
  form_id: string;
}

interface DeliveryRow {
  id: string;
  organization_id: string;
  space_id: string;
  webhook_id: string;
  submission_id: string | null;
  event: string;
  status: string;
  attempt_count: number;
  // set by each claim; absent on rows claimed by an older RPC version
  claim_token?: string | null;
}

interface WebhookRow {
  id: string;
  provider: string;
  url: string;
  is_active: boolean;
  secret_encrypted: string | null;
  secret_iv: string | null;
  secret_tag: string | null;
}

interface DeliverResult {
  ok: boolean;
  status: number | null;
  error?: string;
}

// Outbound webhook delivery for Form Builder. Enqueue inserts one pending delivery per
// active hook (idempotent via the (webhook_id, submission_id, event) unique index — dispatch
// can safely fire from all three "->submitted" sites). A @Cron drains due rows via the
// drain_form_builder_webhook_deliveries claim RPC. SKIP LOCKED only makes the claim atomic; the
// in-process drain guard + claim_token-fenced result writes are what stop a reclaimed row being
// recorded twice.
// The DB is the sole delivery path — there is NO synchronous fire on enqueue, so the cron
// claim is the only place a POST happens (except the one-off sendTest).
@Injectable()
export class FormBuilderWebhookDispatcherService {
  private readonly logger = new Logger(
    FormBuilderWebhookDispatcherService.name,
  );

  private rpcMissingLogged = false;

  private working = false;

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // Queue a delivery per active hook subscribed to this event. Best-effort — never throws
  // into the submit path.
  async enqueue(
    submission: EnqueueSubmission,
    event: string,
    ctx: Ctx,
  ): Promise<void> {
    try {
      const { data: hooks, error } = await this.client
        .from(WEBHOOKS_TABLE)
        .select('id')
        .eq('form_id', submission.form_id)
        .eq('space_id', ctx.spaceId)
        .eq('organization_id', ctx.orgId)
        .eq('is_active', true)
        .contains('events', [event]);

      if (error) {
        this.logger.warn(`webhook enqueue load failed: ${error.message}`);

        return;
      }

      const hookIds = (hooks ?? []).map((h) => (h as { id: string }).id);

      if (!hookIds.length) return;

      const nowIso = new Date().toISOString();
      const rows = hookIds.map((webhookId) => ({
        organization_id: ctx.orgId,
        space_id: ctx.spaceId,
        webhook_id: webhookId,
        submission_id: submission.id,
        event,
        status: 'pending',
        next_attempt_at: nowIso,
      }));

      // ON CONFLICT DO NOTHING via the (webhook_id, submission_id, event) unique index.
      const { error: insErr } = await this.client
        .from(DELIVERIES_TABLE)
        .upsert(rows, {
          onConflict: 'webhook_id,submission_id,event',
          ignoreDuplicates: true,
        });

      if (insErr)
        this.logger.warn(`webhook enqueue insert failed: ${insErr.message}`);
    } catch (err) {
      this.logger.warn(
        `webhook enqueue failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  // In-process overlap guard: a batch of slow sends can outlast the 5 s schedule, and a stacked
  // tick would claim more rows on top of the ones still being sent.
  @Cron('*/5 * * * * *')
  async drain(): Promise<void> {
    if (this.working) return;

    this.working = true;

    try {
      await this.drainOnce();
    } catch (err) {
      this.logger.error(
        `Unhandled error in form_builder webhook drain: ${(err as Error).message}`,
      );
    } finally {
      this.working = false;
    }
  }

  async drainOnce(): Promise<void> {
    const rows = await this.claimBatch();

    if (rows.length === 0) return;

    for (const row of rows) {
      const result = await this.attempt(row);

      if (result.ok) await this.markDelivered(row, result.status);
      else await this.handleFailure(row, result);
    }
  }

  private async claimBatch(): Promise<DeliveryRow[]> {
    const { data, error } = (await this.client.rpc(
      'drain_form_builder_webhook_deliveries',
      { batch_size: DRAIN_BATCH_SIZE },
    )) as {
      data: DeliveryRow[] | null;
      error: { message: string; code?: string } | null;
    };

    if (error) {
      const message = error.message ?? '';
      const code = error.code ?? '';

      if (
        code === 'PGRST202' ||
        code === '42883' ||
        /does not exist/i.test(message) ||
        /could not find the function/i.test(message)
      ) {
        if (!this.rpcMissingLogged) {
          this.logger.warn(
            'drain_form_builder_webhook_deliveries RPC is not present yet — skipping ticks until the migration is applied',
          );
          this.rpcMissingLogged = true;
        }

        return [];
      }

      this.logger.error(
        `drain_form_builder_webhook_deliveries RPC failed: ${message}`,
      );

      return [];
    }

    return data ?? [];
  }

  // Deliver one claimed row. Never throws — returns a DeliverResult the caller acts on.
  private async attempt(delivery: DeliveryRow): Promise<DeliverResult> {
    const webhook = await this.loadWebhook(delivery.webhook_id);

    // hook deleted or deactivated after enqueue → terminal, no retries.
    if (!webhook || !webhook.is_active)
      return { ok: false, status: null, error: 'webhook inactive or deleted' };

    if (!delivery.submission_id)
      return { ok: false, status: null, error: 'submission missing' };

    const { data: sub, error: subErr } = await this.client
      .from(SUBMISSIONS_TABLE)
      .select('id, form_id, data, field_snapshot, created_at')
      .eq('id', delivery.submission_id)
      .maybeSingle();

    if (subErr) return { ok: false, status: null, error: subErr.message };
    if (!sub) return { ok: false, status: null, error: 'submission missing' };

    const submission = sub as {
      id: string;
      form_id: string;
      data: unknown;
      field_snapshot: unknown;
      created_at: string;
    };

    const provider = webhook.provider || 'generic';

    let body: string;

    if (JSON_PROVIDERS.has(provider)) {
      body = JSON.stringify({
        event: delivery.event,
        form_id: submission.form_id,
        submission_id: submission.id,
        submitted_at: submission.created_at,
        data: submission.data,
        field_snapshot: submission.field_snapshot,
      });
    } else {
      const title = await this.loadFormTitle(submission.form_id);

      body = this.formatChatBody(
        provider,
        title,
        submission.data,
        submission.field_snapshot,
      );
    }

    return this.deliver(webhook, body, submission.id);
  }

  // The single HTTP send path, shared by the cron and sendTest. SSRF-guards the URL (also
  // catches DNS rebinding at fire time), signs with HMAC when a secret is set, and refuses
  // to follow redirects (a 3xx to an internal host would bypass the guard).
  private async deliver(
    webhook: WebhookRow,
    body: string,
    idempotencyKey: string | null,
  ): Promise<DeliverResult> {
    try {
      await assertPublicHttpUrl(webhook.url);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (idempotencyKey) headers['X-FormBuilder-Idempotency'] = idempotencyKey;

      const secret = this.decryptSecret(webhook);

      if (secret) {
        const signature = createHmac('sha256', secret)
          .update(body)
          .digest('hex');

        headers['X-FormBuilder-Signature'] = `sha256=${signature}`;
      }

      const response = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (response.status >= 300 && response.status < 400)
        return {
          ok: false,
          status: response.status,
          error: 'redirects are not followed',
        };

      return { ok: response.ok, status: response.status };
    } catch (err) {
      return {
        ok: false,
        status: null,
        error: (err as Error)?.message ?? 'fetch failed',
      };
    }
  }

  // One-off manual test from the CRUD service — sends a sample payload and returns the
  // outcome. Does NOT enqueue a delivery row. Shape matches the real delivery for the hook's
  // provider so the test exercises the same formatting a live submission would.
  async sendTest(webhook: WebhookRow): Promise<DeliverResult> {
    const provider = webhook.provider || 'generic';
    const sample = {
      message: 'This is a test delivery from the form builder.',
    };

    let body: string;

    if (JSON_PROVIDERS.has(provider)) {
      body = JSON.stringify({
        event: 'submission.created',
        test: true,
        form_id: null,
        submission_id: null,
        submitted_at: new Date().toISOString(),
        data: sample,
        field_snapshot: [],
      });
    } else {
      body = this.formatChatBody(provider, 'Test form', sample, []);
    }

    return this.deliver(webhook, body, null);
  }

  // Look up a form's title for the human-readable chat message headings. Falls back to a
  // generic label so a missing/renamed form never breaks delivery.
  private async loadFormTitle(formId: string): Promise<string> {
    const { data } = await this.client
      .from('form_builder')
      .select('title')
      .eq('id', formId)
      .maybeSingle();

    const title = (data as { title?: unknown } | null)?.title;

    return typeof title === 'string' && title.trim() ? title : 'Form';
  }

  // Shape a chat-provider message body. Slack wants { text }, Discord { content } (2000-char
  // cap), Teams a legacy MessageCard, Telegram uses HTML-escaped text with parse_mode:HTML.
  // The body is a compact "New submission" summary built from answer values + snapshot labels.
  private formatChatBody(
    provider: string,
    title: string,
    data: unknown,
    snapshot: unknown,
  ): string {
    const heading = `New submission: ${title}`;
    const summary = this.summarize(data, snapshot);
    const text = summary ? `${heading}\n${summary}` : heading;

    if (provider === 'discord')
      return JSON.stringify({ content: text.slice(0, 1900) });

    if (provider === 'teams')
      return JSON.stringify({
        '@type': 'MessageCard',
        '@context': 'http://schema.org/extensions',
        summary: heading,
        themeColor: '0076D7',
        title: heading,
        text: summary || heading,
      });

    if (provider === 'telegram') {
      // Telegram HTML mode: escape entities so user data with <, >, & never creates
      // unclosed tags — the UNCLOSED_TAG error occurs when these chars reach the parser.
      const esc = (s: string) =>
        s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      const safeHeading = `<b>${esc(`New submission: ${title}`)}</b>`;
      const safeSummary = summary
        .split('\n')
        .map((line) => esc(line))
        .join('\n');
      const telegramText = safeSummary
        ? `${safeHeading}\n\n${safeSummary}`
        : safeHeading;

      return JSON.stringify({
        text: telegramText.slice(0, 4096),
        parse_mode: 'HTML',
      });
    }

    // slack / rocketchat / zohocliq / webex / googlechat / mattermost all use { text }.
    return JSON.stringify({ text });
  }

  // Build "• Label: value" lines from the submission answers, resolving labels from the
  // per-submission field_snapshot (falls back to the field key). Capped for message size.
  private summarize(data: unknown, snapshot: unknown): string {
    const labelByKey = new Map<string, string>();
    const typeByKey = new Map<string, string>();
    const optionsByKey = new Map<string, unknown>();

    if (Array.isArray(snapshot)) {
      for (const entry of snapshot) {
        const field = entry as {
          field_key?: unknown;
          label?: unknown;
          field_type?: unknown;
          options?: unknown;
        };
        const key =
          typeof field?.field_key === 'string' ? field.field_key : null;

        if (!key) continue;

        labelByKey.set(
          key,
          typeof field.label === 'string' && field.label ? field.label : key,
        );
        if (typeof field.field_type === 'string')
          typeByKey.set(key, field.field_type);
        if (field.options !== undefined) optionsByKey.set(key, field.options);
      }
    }

    if (!data || typeof data !== 'object') return '';

    const lines: string[] = [];

    for (const [key, value] of Object.entries(
      data as Record<string, unknown>,
    )) {
      if (lines.length >= 12) break;

      // Shared with the integration path: field-type aware (address/full_name/date_range never
      // become JSON) and choice-aware (a stored option value shows its label, not "option_1").
      const text = toText(value, typeByKey.get(key), optionsByKey.get(key));

      if (!text) continue;

      const label = labelByKey.get(key) ?? key;
      const trimmed = text.length > 200 ? `${text.slice(0, 200)}…` : text;

      lines.push(`• ${label}: ${trimmed}`);
    }

    return lines.join('\n');
  }

  private async loadWebhook(webhookId: string): Promise<WebhookRow | null> {
    const { data, error } = await this.client
      .from(WEBHOOKS_TABLE)
      .select(
        'id, provider, url, is_active, secret_encrypted, secret_iv, secret_tag',
      )
      .eq('id', webhookId)
      .maybeSingle();

    if (error) {
      this.logger.warn(`loadWebhook failed: ${error.message}`);

      return null;
    }

    return (data as WebhookRow | null) ?? null;
  }

  private decryptSecret(webhook: WebhookRow): string | null {
    if (!webhook.secret_encrypted || !webhook.secret_iv || !webhook.secret_tag)
      return null;

    try {
      return decryptApiKey(
        webhook.secret_encrypted,
        webhook.secret_iv,
        webhook.secret_tag,
      );
    } catch (err) {
      this.logger.warn(
        `webhook secret decrypt failed for ${webhook.id}: ${(err as Error)?.message ?? err}`,
      );

      return null;
    }
  }

  private async markDelivered(
    delivery: DeliveryRow,
    responseCode: number | null,
  ): Promise<void> {
    const { error } = await this.updateClaimed(delivery, {
      status: 'delivered',
      response_code: responseCode,
      last_error: null,
      updated_at: new Date().toISOString(),
    });

    if (error)
      this.logger.error(
        `Failed to mark delivery ${delivery.id} delivered: ${error.message}`,
      );
  }

  private async handleFailure(
    delivery: DeliveryRow,
    result: DeliverResult,
  ): Promise<void> {
    const nextAttemptCount = delivery.attempt_count + 1;
    const isDead = nextAttemptCount >= MAX_ATTEMPTS;
    const backoffSeconds = Math.pow(2, nextAttemptCount);
    const nextAttemptAt = new Date(
      Date.now() + backoffSeconds * 1000,
    ).toISOString();

    this.logger.warn(
      `webhook delivery ${delivery.id} failed (attempt ${nextAttemptCount}/${MAX_ATTEMPTS}): ${result.error ?? result.status}`,
    );

    const patch: Record<string, unknown> = {
      attempt_count: nextAttemptCount,
      status: isDead ? 'dead' : 'pending',
      response_code: result.status,
      last_error: result.error ?? `status ${result.status ?? 'unknown'}`,
      updated_at: new Date().toISOString(),
    };

    if (!isDead) patch.next_attempt_at = nextAttemptAt;

    const { error } = await this.updateClaimed(delivery, patch);

    if (error)
      this.logger.error(
        `Failed to persist failure for delivery ${delivery.id}: ${error.message}`,
      );
  }

  // Write a result onto a claimed row, fenced on the claim token when the RPC handed us one so a
  // row reclaimed by another worker is left alone. 0 rows updated is logged and otherwise ignored
  // (no retry, no dead-letter) — the worker that now holds the claim records the outcome.
  private async updateClaimed(
    delivery: DeliveryRow,
    patch: Record<string, unknown>,
  ): Promise<{ error: { message: string } | null }> {
    let query = this.client
      .from(DELIVERIES_TABLE)
      .update(patch)
      .eq('id', delivery.id)
      .eq('organization_id', delivery.organization_id);

    if (delivery.claim_token)
      query = query
        .eq('status', 'in_progress')
        .eq('claim_token', delivery.claim_token);

    const { data, error } = await query.select('id');

    if (!error && !data?.length)
      this.logger.warn(
        `claim lost for ${DELIVERIES_TABLE} row ${delivery.id} (reclaimed by another worker) — not recording result`,
      );

    return { error };
  }
}
