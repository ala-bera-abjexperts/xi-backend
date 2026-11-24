// Automation webhook — receive, validate, and enqueue runs for webhook-triggered automations.

import { Injectable, Logger } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { findFirstActionableNodes } from './utils/dag-engine';
import {
  decryptWebhookSecret,
  verifyWebhookSignature,
} from './utils/webhook-crypto';
import type { IAutomationDefinition } from './interfaces/automation.interface';

interface AutomationRow {
  id: string;
  space_id: string;
  organization_id: string;
  published_version_id: string | null;
  webhook_secret_encrypted: string | null;
  webhook_secret_iv: string | null;
  webhook_secret_tag: string | null;
  webhook_rate_limit_per_sec: number | null;
  webhook_rate_limit_per_hour: number | null;
}

const DEFAULT_PER_SEC = parseInt(
  process.env.WEBHOOK_RATE_LIMIT_PER_SEC ?? '10',
  10,
);
const DEFAULT_PER_HOUR = parseInt(
  process.env.WEBHOOK_RATE_LIMIT_PER_HOUR ?? '1000',
  10,
);
const MAX_BODY_BYTES = parseInt(
  process.env.WEBHOOK_MAX_BODY_BYTES ?? '1000000',
  10,
);

// In-memory sliding-window rate limiter.
// Not suitable for multi-instance deployments — same trade-off as the source.
const tokenHitLog = new Map<string, number[]>();

function isRateLimited(
  token: string,
  perSec: number,
  perHour: number,
): boolean {
  const now = Date.now();
  const windowMs = 3_600_000; // 1 hour
  const prev = (tokenHitLog.get(token) ?? []).filter((t) => now - t < windowMs);
  const recentSec = prev.filter((t) => now - t < 1000);

  if (recentSec.length >= perSec || prev.length >= perHour) return true;

  tokenHitLog.set(token, [...prev, now]);
  return false;
}

// Redact auth-bearing headers before persisting them (delivery log, run trigger_payload,
// step input). A browser-originated test previously stored the caller's session cookie + JWT.
const SENSITIVE_HEADER_KEYS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-access-token',
  'x-auth-token',
  'x-api-key',
  'x-csrf-token',
]);

function redactSensitiveHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADER_KEYS.has(k.toLowerCase()) ? '[redacted]' : v;
  }

  return out;
}

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

@Injectable()
export class AutomationWebhookService {
  private readonly logger = new Logger(AutomationWebhookService.name);

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  async receive(
    token: string,
    rawBody: string,
    headers: Record<string, string>,
  ): Promise<WebhookResult> {
    if (!token || token.length < 16) {
      return { status: 400, body: { error: 'Invalid token' } };
    }

    if (isRateLimited(token, DEFAULT_PER_SEC, DEFAULT_PER_HOUR)) {
      return { status: 429, body: { error: 'Too many requests' } };
    }

    const autoResult = await this.db
      .from('automations')
      .select(
        'id,space_id,organization_id,published_version_id,webhook_secret_encrypted,webhook_secret_iv,webhook_secret_tag,webhook_rate_limit_per_sec,webhook_rate_limit_per_hour',
      )
      .eq('webhook_token', token)
      .eq('status', 'published')
      .maybeSingle();
    const autoErr = autoResult.error;
    const automation = autoResult.data as AutomationRow | null;

    if (autoErr || !automation) {
      return { status: 404, body: { error: 'Not found' } };
    }

    const autoPerSec = automation.webhook_rate_limit_per_sec ?? DEFAULT_PER_SEC;
    const autoPerHour =
      automation.webhook_rate_limit_per_hour ?? DEFAULT_PER_HOUR;

    if (
      (autoPerSec !== DEFAULT_PER_SEC || autoPerHour !== DEFAULT_PER_HOUR) &&
      isRateLimited(token, autoPerSec, autoPerHour)
    ) {
      return { status: 429, body: { error: 'Too many requests' } };
    }

    const bodyBytes = Buffer.byteLength(rawBody, 'utf8');
    if (bodyBytes > MAX_BODY_BYTES) {
      return { status: 413, body: { error: 'Payload too large' } };
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      parsedBody = rawBody;
    }

    const ip =
      ((headers['x-forwarded-for'] as string | undefined) ?? '')
        .split(',')[0]
        ?.trim() || null;

    let signatureAlgorithm: string = 'hmac-sha256';

    if (automation.published_version_id) {
      const { data: triggerVersion } = await this.db
        .from('automation_versions')
        .select('trigger_config')
        .eq('id', automation.published_version_id)
        .single();

      const tc = (triggerVersion?.trigger_config ?? {}) as Record<
        string,
        unknown
      >;
      if (typeof tc.signatureAlgorithm === 'string') {
        signatureAlgorithm = tc.signatureAlgorithm;
      }
    }

    let signatureValid = true;

    if (automation.webhook_secret_encrypted) {
      try {
        const secret = decryptWebhookSecret(
          automation.webhook_secret_encrypted,
          automation.webhook_secret_iv ?? '',
          automation.webhook_secret_tag ?? '',
        );
        signatureValid = verifyWebhookSignature(
          signatureAlgorithm as
            | 'bearer'
            | 'hmac-sha256'
            | 'hmac-sha1'
            | 'hmac-sha512',
          rawBody,
          headers,
          secret,
        );
      } catch {
        signatureValid = false;
      }
    }

    // Redact auth headers for all persisted copies. Done AFTER signature verification (which
    // used the raw headers) and never touches rawBody, so signed webhooks still validate.
    const safeHeaders = redactSensitiveHeaders(headers);

    let deliveryId: string | null = null;

    try {
      const deliveryResult = await this.db
        .from('automation_webhook_deliveries')
        .insert({
          automation_id: automation.id,
          space_id: automation.space_id,
          headers: safeHeaders,
          body: parsedBody,
          signature_valid: signatureValid,
          ip_address: ip,
        })
        .select('id')
        .single();

      deliveryId = (deliveryResult.data as { id: string } | null)?.id ?? null;
    } catch (e) {
      this.logger.warn(`Failed to log webhook delivery: ${String(e)}`);
    }

    // SECURITY (M): when a signing secret is configured, a bad/missing signature
    // must NOT execute the automation (previously `signature_valid` was computed
    // and logged but never enforced). Webhooks with no secret are unaffected.
    if (automation.webhook_secret_encrypted && !signatureValid) {
      return {
        status: 401,
        body: { received: false, error: 'invalid_signature' },
      };
    }

    if (!automation.published_version_id) {
      return { status: 200, body: { received: true, status: 'no_version' } };
    }

    let firstNodes: { id: string; data?: { kind?: string } }[] = [];
    let hasWebhookTrigger = false;

    try {
      const { data: version } = await this.db
        .from('automation_versions')
        .select('definition')
        .eq('id', automation.published_version_id)
        .single();

      const def = version?.definition as IAutomationDefinition | undefined;

      if (def) {
        hasWebhookTrigger = (def.nodes ?? []).some((n) => {
          const node = n as { type?: string; data?: { kind?: string } };

          return (
            node.type === 'trigger' && node.data?.kind === 'webhook.received'
          );
        });
        firstNodes = findFirstActionableNodes(def) as {
          id: string;
          data?: { kind?: string };
        }[];
      }
    } catch (e) {
      this.logger.warn(`DAG engine error: ${String(e)}`);
    }

    // Only run automations whose PUBLISHED definition actually contains a "Webhook received"
    // trigger. Every published automation gets a webhook_token (generated on publish regardless
    // of trigger type), but an app/schedule-triggered automation must NOT be runnable via this
    // URL. The delivery is still logged above (audit) — we just don't create a run.
    if (!hasWebhookTrigger) {
      return {
        status: 200,
        body: { received: true, status: 'not_webhook_trigger' },
      };
    }

    const triggerPayload = {
      headers: safeHeaders,
      body: parsedBody,
      received_at: new Date().toISOString(),
    };

    const runResult = await this.db
      .from('automation_runs')
      .insert({
        automation_id: automation.id,
        automation_version_id: automation.published_version_id,
        space_id: automation.space_id,
        organization_id: automation.organization_id,
        trigger_kind: 'webhook.received',
        trigger_payload: triggerPayload,
        status: 'running',
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (runResult.error || !runResult.data) {
      this.logger.error(`Failed to create run: ${runResult.error?.message}`);
      return { status: 200, body: { received: true, status: 'run_failed' } };
    }

    const run = runResult.data as { id: string };
    const runId = run.id;

    if (deliveryId) {
      void Promise.resolve(
        this.db
          .from('automation_webhook_deliveries')
          .update({ triggered_run_id: runId })
          .eq('id', deliveryId),
      ).catch(() => {});
    }

    for (const node of firstNodes) {
      await this.db.from('automation_run_steps').insert({
        run_id: runId,
        space_id: automation.space_id,
        node_id: node.id,
        node_kind: node.data?.kind ?? '',
        step_index: 0,
        status: 'pending',
        input: triggerPayload,
        retry_count: 0,
      });
    }

    if (firstNodes.length === 0) {
      this.logger.warn(
        `[webhook] automation ${automation.id} has no actionable nodes connected to the trigger. ` +
          `Run ${runId} marked succeeded with 0 steps. ` +
          `Open the automation editor and connect the trigger node to at least one action.`,
      );
      await this.db
        .from('automation_runs')
        .update({
          status: 'succeeded',
          finished_at: new Date().toISOString(),
        })
        .eq('id', runId);
    }

    return { status: 200, body: { received: true, runId } };
  }
}
