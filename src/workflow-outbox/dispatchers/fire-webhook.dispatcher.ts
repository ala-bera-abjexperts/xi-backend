/** @fileoverview Dispatcher for queued trigger_webhook outbox rows — renders body, signs with HMAC, calls fetch. @module src/workflow-outbox/dispatchers/fire-webhook.dispatcher @author Rajbha Manek */

import { createHmac } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';

import { assertPublicHttpUrl } from '../../common/security/ssrf-guard';
import { TemplatingService } from '../../workflow-engine/templating/expand';

/** Outbox row payload shape for trigger_webhook rules. */
export interface FireWebhookPayload {
  cfg: {
    url: string;
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH';
    headers?: Record<string, string>;
    body_template?: string;
    /** Inline secret — used when no secret_ref is provided. v1 convenience. */
    secret?: string;
    /** Future per-org secret store key. v1 looks up via SecretsService later. */
    secret_ref?: string;
  };
  context: Record<string, unknown>;
}

/** Fetch timeout — design Part 5.5. */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Renders the configured body template, computes an HMAC signature when a
 * secret is available, and POSTs (or GET/PUT/PATCH) to the configured HTTPS
 * URL. Throws on non-2xx responses so the processor records the failure.
 */
@Injectable()
export class FireWebhookDispatcher {
  private readonly logger = new Logger(FireWebhookDispatcher.name);

  constructor(private readonly templating: TemplatingService) {}

  /**
   * Dispatch one outbox row.
   *
   * @throws Error when the URL is not HTTPS, fetch rejects, or the response
   *   status is outside 2xx.
   */
  async dispatch(row: {
    id: string;
    organization_id: string;
    task_id: string;
    transition_id: string | null;
    payload: FireWebhookPayload;
  }): Promise<void> {
    const { cfg, context } = row.payload;

    // SSRF guard: rejects non-HTTPS, embedded credentials, and any host that
    // resolves to a private/loopback/link-local/metadata address. Re-checked
    // here at dispatch time (not just at config save) to catch DNS changes.
    await assertPublicHttpUrl(cfg.url);

    const body =
      cfg.body_template && cfg.body_template.length > 0
        ? this.templating.expand(cfg.body_template, context)
        : JSON.stringify(context);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(cfg.headers ?? {}),
    };

    // Resolve the HMAC secret AT DISPATCH TIME, never store it on the outbox
    // row. In v1 we accept an inline `cfg.secret`; future versions can resolve
    // `cfg.secret_ref` against a per-org secret store. If neither is provided
    // we skip signing rather than failing the request.
    const secret = cfg.secret ?? null;

    if (secret) {
      const signature = createHmac('sha256', secret).update(body).digest('hex');

      headers['X-Workflow-Signature'] = `sha256=${signature}`;
    } else if (cfg.secret_ref) {
      this.logger.warn(
        `Outbox row ${row.id}: secret_ref provided but secret store lookup is not implemented in v1 — sending unsigned`,
      );
    }

    const method = cfg.method ?? 'POST';

    const response = await fetch(cfg.url, {
      method,
      headers,
      body: method === 'GET' ? undefined : body,
      // Do NOT auto-follow redirects: a 3xx to an internal host would bypass
      // the SSRF guard, which only validated the original URL.
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.status >= 300 && response.status < 400) {
      throw new Error(
        `Webhook ${cfg.url} returned a redirect (${response.status}); redirects are not followed`,
      );
    }

    if (!response.ok) {
      throw new Error(
        `Webhook ${cfg.url} returned non-2xx status ${response.status}`,
      );
    }
  }
}
