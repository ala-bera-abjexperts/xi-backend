import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { decryptApiKey } from '../lib/crypto/encryption';
import { applyFieldMap, summarizeAll } from './integrations/field-map.util';
import {
  runIssueAction,
  type ActionResult,
} from './integrations/issue-actions';
import type { FieldMapEntry } from './dto/create-integration.dto';

const INTEGRATIONS_TABLE = 'form_builder_integrations';
const DELIVERIES_TABLE = 'form_builder_integration_deliveries';
const SUBMISSIONS_TABLE = 'form_builder_submissions';
const FORMS_TABLE = 'form_builder';

// Providers that authenticate with server-side env config instead of a per-integration stored
// secret. Their rows legitimately have no credential, so the missing-credential gate must skip them.
const SERVER_AUTH_PROVIDERS = new Set(['salesforce']);

const MAX_ATTEMPTS = 5;
const DRAIN_BATCH_SIZE = 50;

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
  integration_id: string;
  submission_id: string | null;
  event: string;
  status: string;
  attempt_count: number;
  external_ref: string | null;
  // set by each claim; absent on rows claimed by an older RPC version
  claim_token?: string | null;
}

interface IntegrationRow {
  id: string;
  provider: string;
  config: Record<string, unknown> | null;
  field_map: FieldMapEntry[] | null;
  is_active: boolean;
  secret_encrypted: string | null;
  secret_iv: string | null;
  secret_tag: string | null;
}

const TEST_EMAIL = 'formbuilder.test@example.com';
const TEST_TEXT = 'Form Builder Test';

// Sample value for one mapped target, picked from the target's name so the payload is plausible
// (a real email in an email property, a date in a date property, …).
function sampleForTarget(target: string): string | null {
  // labels/tags are split on commas by the provider actions — sampling one would create a junk
  // label in the real repo/board, so leave it unset and let the empty-label fallback apply.
  if (/label|tag/i.test(target)) return null;

  if (/mail/i.test(target)) return TEST_EMAIL;
  if (/phone|mobile/i.test(target)) return '+10000000000';
  if (/url|link|website/i.test(target)) return 'https://example.com';
  if (/date|due|start|end/i.test(target))
    return new Date().toISOString().slice(0, 10);
  if (/qty|quantity|amount|number|count|progress/i.test(target)) return '1';

  return TEST_TEXT;
}

// Minimum identifying fields for providers whose actions have no fallback, used only when the
// integration has no field_map yet (a brand-new integration must still be testable).
const TEST_FALLBACK_BY_PROVIDER: Record<string, Record<string, string>> = {
  hubspot: { email: TEST_EMAIL, firstname: 'Form Builder', lastname: 'Test' },
  salesforce: { LastName: 'Test', Company: TEST_TEXT, Email: TEST_EMAIL },
};

// "Send test" previously passed an empty field map, so providers without fallbacks (HubSpot needs an
// identifying property, Salesforce needs LastName+Company) could never be tested. Build the payload
// from the integration's OWN field_map so the test exercises the user's real mapping. Never throws.
function buildTestFields(integration: IntegrationRow): Record<string, string> {
  try {
    const out: Record<string, string> = {};

    for (const entry of integration.field_map ?? []) {
      const target = entry?.target;

      if (typeof target !== 'string' || !target) continue;

      const value = sampleForTarget(target);

      if (value !== null) out[target] = value;
    }

    if (Object.keys(out).length > 0) return out;

    // No mapping configured — fall back to the provider's required minimum, or {} so every other
    // provider keeps the exact behaviour it has today.
    return { ...(TEST_FALLBACK_BY_PROVIDER[integration.provider] ?? {}) };
  } catch {
    return {};
  }
}

// Native-integration delivery for Form Builder (Gmail). Parallel of the webhook dispatcher:
// enqueue inserts one pending delivery per active integration (idempotent via the
// (integration_id, submission_id, event) unique index), a @Cron drains due rows via the
// drain_form_builder_integration_deliveries claim RPC (SKIP LOCKED makes the claim atomic; the
// in-process drain guard + claim_token-fenced result writes stop a reclaimed row being recorded
// twice), and each claimed row runs the provider action once. A row that already has an
// external_ref is treated as delivered (email creation is NOT idempotent provider-side).
@Injectable()
export class FormBuilderIntegrationDispatcherService {
  private readonly logger = new Logger(
    FormBuilderIntegrationDispatcherService.name,
  );

  private rpcMissingLogged = false;

  private working = false;

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // Queue a delivery per active integration on this form. Best-effort — never throws into submit.
  async enqueue(
    submission: EnqueueSubmission,
    event: string,
    ctx: Ctx,
  ): Promise<void> {
    try {
      const { data: rows, error } = await this.client
        .from(INTEGRATIONS_TABLE)
        .select('id')
        .eq('form_id', submission.form_id)
        .eq('space_id', ctx.spaceId)
        .eq('organization_id', ctx.orgId)
        .eq('is_active', true);

      if (error) {
        this.logger.warn(`integration enqueue load failed: ${error.message}`);

        return;
      }

      const ids = (rows ?? []).map((r) => (r as { id: string }).id);

      if (!ids.length) return;

      const nowIso = new Date().toISOString();
      const deliveries = ids.map((integrationId) => ({
        organization_id: ctx.orgId,
        space_id: ctx.spaceId,
        integration_id: integrationId,
        submission_id: submission.id,
        event,
        status: 'pending',
        next_attempt_at: nowIso,
      }));

      const { error: insErr } = await this.client
        .from(DELIVERIES_TABLE)
        .upsert(deliveries, {
          onConflict: 'integration_id,submission_id,event',
          ignoreDuplicates: true,
        });

      if (insErr)
        this.logger.warn(
          `integration enqueue insert failed: ${insErr.message}`,
        );
    } catch (err) {
      this.logger.warn(
        `integration enqueue failed: ${(err as Error)?.message ?? err}`,
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
        `Unhandled error in form_builder integration drain: ${(err as Error).message}`,
      );
    } finally {
      this.working = false;
    }
  }

  async drainOnce(): Promise<void> {
    const rows = await this.claimBatch();

    if (rows.length === 0) return;

    for (const row of rows) {
      // Already produced an external ref on a prior tick → the send happened; don't repeat it.
      if (row.external_ref) {
        await this.markDelivered(row, 200, row.external_ref);

        continue;
      }

      const result = await this.attempt(row);

      if (result.ok)
        await this.markDelivered(row, result.status, result.externalRef);
      else await this.handleFailure(row, result);
    }
  }

  private async claimBatch(): Promise<DeliveryRow[]> {
    const { data, error } = (await this.client.rpc(
      'drain_form_builder_integration_deliveries',
      {
        batch_size: DRAIN_BATCH_SIZE,
      },
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
            'drain_form_builder_integration_deliveries RPC is not present yet — skipping ticks until the migration is applied',
          );
          this.rpcMissingLogged = true;
        }

        return [];
      }

      this.logger.error(
        `drain_form_builder_integration_deliveries RPC failed: ${message}`,
      );

      return [];
    }

    return data ?? [];
  }

  // Run one claimed row. Never throws — returns an ActionResult the caller acts on.
  private async attempt(delivery: DeliveryRow): Promise<ActionResult> {
    const integration = await this.loadIntegration(delivery.integration_id);

    if (!integration || !integration.is_active)
      return {
        ok: false,
        status: null,
        externalRef: null,
        error: 'integration inactive or deleted',
        retryable: false,
      };

    if (!delivery.submission_id)
      return {
        ok: false,
        status: null,
        externalRef: null,
        error: 'submission missing',
        retryable: false,
      };

    const credential = this.decryptCredential(integration);

    if (!credential && !SERVER_AUTH_PROVIDERS.has(integration.provider))
      return {
        ok: false,
        status: null,
        externalRef: null,
        error: 'missing credential',
        retryable: false,
      };

    const { data: sub, error: subErr } = await this.client
      .from(SUBMISSIONS_TABLE)
      .select('id, form_id, data, field_snapshot, created_at')
      .eq('id', delivery.submission_id)
      .maybeSingle();

    if (subErr)
      return {
        ok: false,
        status: null,
        externalRef: null,
        error: subErr.message,
        retryable: true,
      };
    if (!sub)
      return {
        ok: false,
        status: null,
        externalRef: null,
        error: 'submission missing',
        retryable: false,
      };

    const submission = sub as {
      id: string;
      form_id: string;
      data: unknown;
      field_snapshot: unknown;
    };
    const data = (submission.data as Record<string, unknown>) ?? {};
    const title = await this.loadFormTitle(submission.form_id);

    return runIssueAction(integration.provider, {
      provider: integration.provider,
      credential: credential ?? '',
      config: integration.config ?? {},
      fields: applyFieldMap(
        integration.field_map,
        data,
        submission.field_snapshot,
      ),
      fallbackTitle: `New submission: ${title}`,
      fallbackBody: summarizeAll(data, submission.field_snapshot),
    });
  }

  private async loadIntegration(id: string): Promise<IntegrationRow | null> {
    const { data, error } = await this.client
      .from(INTEGRATIONS_TABLE)
      .select(
        'id, provider, config, field_map, is_active, secret_encrypted, secret_iv, secret_tag',
      )
      .eq('id', id)
      .maybeSingle();

    if (error) {
      this.logger.warn(`load integration ${id} failed: ${error.message}`);

      return null;
    }

    return (data as IntegrationRow | null) ?? null;
  }

  private async loadFormTitle(formId: string): Promise<string> {
    const { data } = await this.client
      .from(FORMS_TABLE)
      .select('name')
      .eq('id', formId)
      .maybeSingle();

    return (
      ((data as { name?: string } | null)?.name ?? 'Form').trim() || 'Form'
    );
  }

  private decryptCredential(integration: IntegrationRow): string | null {
    if (
      !integration.secret_encrypted ||
      !integration.secret_iv ||
      !integration.secret_tag
    )
      return null;

    try {
      return decryptApiKey(
        integration.secret_encrypted,
        integration.secret_iv,
        integration.secret_tag,
      );
    } catch (err) {
      this.logger.warn(
        `credential decrypt failed for ${integration.id}: ${(err as Error)?.message ?? err}`,
      );

      return null;
    }
  }

  private async markDelivered(
    delivery: DeliveryRow,
    responseCode: number | null,
    externalRef: string | null,
  ): Promise<void> {
    const { error } = await this.updateClaimed(delivery, {
      status: 'delivered',
      response_code: responseCode,
      external_ref: externalRef,
      last_error: null,
      updated_at: new Date().toISOString(),
    });

    if (error)
      this.logger.error(
        `Failed to mark integration delivery ${delivery.id} delivered: ${error.message}`,
      );
  }

  private async handleFailure(
    delivery: DeliveryRow,
    result: ActionResult,
  ): Promise<void> {
    const nextAttemptCount = delivery.attempt_count + 1;
    // A non-retryable result (auth/4xx/config) is terminal immediately; otherwise cap at MAX_ATTEMPTS.
    const isDead =
      result.retryable === false || nextAttemptCount >= MAX_ATTEMPTS;
    const backoffSeconds = Math.pow(2, nextAttemptCount);
    const nextAttemptAt = new Date(
      Date.now() + backoffSeconds * 1000,
    ).toISOString();

    this.logger.warn(
      `integration delivery ${delivery.id} failed (attempt ${nextAttemptCount}/${MAX_ATTEMPTS}): ${result.error ?? result.status}`,
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
        `Failed to persist failure for integration delivery ${delivery.id}: ${error.message}`,
      );
  }

  // One-off send used by the "Send test" button — runs the action directly (bypasses the queue)
  // with empty fields, so Gmail falls back to sending to the connected address.
  async sendTest(integration: IntegrationRow): Promise<{
    ok: boolean;
    status: number | null;
    externalRef: string | null;
    error: string | null;
  }> {
    const credential = this.decryptCredential(integration);

    if (!credential && !SERVER_AUTH_PROVIDERS.has(integration.provider))
      return {
        ok: false,
        status: null,
        externalRef: null,
        error: 'missing credential',
      };

    const result = await runIssueAction(integration.provider, {
      provider: integration.provider,
      credential: credential ?? '',
      config: integration.config ?? {},
      fields: buildTestFields(integration),
      fallbackTitle: 'Form builder test',
      fallbackBody: 'This is a test delivery from the form builder.',
    });

    return {
      ok: result.ok,
      status: result.status,
      externalRef: result.externalRef,
      error: result.error ?? null,
    };
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

export type { IntegrationRow };
