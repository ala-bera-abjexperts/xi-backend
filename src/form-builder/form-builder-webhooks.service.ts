import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { assertPublicHttpUrl } from '../common/security/ssrf-guard';
import { encryptApiKey } from '../lib/crypto/encryption';
import { FormBuilderWebhookDispatcherService } from './form-builder-webhook-dispatcher.service';
import type { CreateWebhookDto } from './dto/create-webhook.dto';
import type { UpdateWebhookDto } from './dto/update-webhook.dto';

const WEBHOOKS_TABLE = 'form_builder_webhooks';
const DELIVERIES_TABLE = 'form_builder_webhook_deliveries';
const FORMS_TABLE = 'form_builder';

interface Ctx {
  spaceId: string;
  orgId: string;
}

// a webhook row as returned to the client — never carries the signing secret.
export interface WebhookView {
  id: string;
  form_id: string;
  provider: string;
  url: string;
  events: string[];
  is_active: boolean;
  hasSecret: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// CRUD for outbound webhooks. The signing secret is encrypted at rest (encryptApiKey) and
// NEVER returned — the view exposes only a `hasSecret` boolean. The backend uses the
// service-role client (RLS bypassed), so every query is scoped by org + space in app code.
@Injectable()
export class FormBuilderWebhooksService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly dispatcher: FormBuilderWebhookDispatcherService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async create(
    formId: string,
    dto: CreateWebhookDto,
    ctx: Ctx,
    userId: string,
  ): Promise<WebhookView> {
    await this.assertForm(formId, ctx);

    // authoritative HTTPS/SSRF check (rejects http, credentials, internal/loopback hosts).
    await this.assertUrlSafe(dto.url);

    const secretCols = dto.secret?.trim()
      ? this.encryptSecret(dto.secret.trim())
      : {};

    const { data, error } = await this.client
      .from(WEBHOOKS_TABLE)
      .insert({
        organization_id: ctx.orgId,
        space_id: ctx.spaceId,
        form_id: formId,
        provider: dto.provider ?? 'generic',
        url: dto.url,
        events: dto.events?.length ? dto.events : ['submission.created'],
        is_active: dto.isActive ?? true,
        created_by: userId,
        ...secretCols,
      })
      .select('*')
      .single();

    if (error) throw new BadRequestException(error.message);

    return this.toView(data as Record<string, unknown>);
  }

  async list(formId: string, ctx: Ctx): Promise<WebhookView[]> {
    await this.assertForm(formId, ctx);

    const { data, error } = await this.client
      .from(WEBHOOKS_TABLE)
      .select('*')
      .eq('form_id', formId)
      .eq('space_id', ctx.spaceId)
      .eq('organization_id', ctx.orgId)
      .order('created_at', { ascending: false });

    if (error) throw new BadRequestException(error.message);

    return (data ?? []).map((r) => this.toView(r as Record<string, unknown>));
  }

  async update(
    formId: string,
    webhookId: string,
    dto: UpdateWebhookDto,
    ctx: Ctx,
  ): Promise<WebhookView> {
    await this.getWebhookOr404(formId, webhookId, ctx);

    if (dto.url !== undefined) await this.assertUrlSafe(dto.url);

    const patch: Record<string, unknown> = {};

    if (dto.url !== undefined) patch.url = dto.url;
    if (dto.events !== undefined)
      patch.events = dto.events.length ? dto.events : ['submission.created'];
    if (dto.isActive !== undefined) patch.is_active = dto.isActive;
    // a provided non-empty secret re-encrypts; omitting it leaves the stored one untouched.
    if (dto.secret?.trim())
      Object.assign(patch, this.encryptSecret(dto.secret.trim()));

    const { data, error } = await this.client
      .from(WEBHOOKS_TABLE)
      .update(patch)
      .eq('id', webhookId)
      .eq('form_id', formId)
      .eq('space_id', ctx.spaceId)
      .eq('organization_id', ctx.orgId)
      .select('*')
      .single();

    if (error) throw new BadRequestException(error.message);

    return this.toView(data as Record<string, unknown>);
  }

  async remove(formId: string, webhookId: string, ctx: Ctx) {
    const { data, error } = await this.client
      .from(WEBHOOKS_TABLE)
      .delete()
      .eq('id', webhookId)
      .eq('form_id', formId)
      .eq('space_id', ctx.spaceId)
      .eq('organization_id', ctx.orgId)
      .select('id')
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Webhook not found');

    return { success: true as const };
  }

  async sendTest(formId: string, webhookId: string, ctx: Ctx) {
    const webhook = await this.getWebhookOr404(formId, webhookId, ctx);

    const result = await this.dispatcher.sendTest(webhook);

    return {
      ok: result.ok,
      statusCode: result.status,
      error: result.error ?? null,
    };
  }

  async listDeliveries(formId: string, webhookId: string, ctx: Ctx) {
    await this.getWebhookOr404(formId, webhookId, ctx);

    const { data, error } = await this.client
      .from(DELIVERIES_TABLE)
      .select(
        'id, event, status, attempt_count, response_code, last_error, next_attempt_at, submission_id, created_at, updated_at',
      )
      .eq('webhook_id', webhookId)
      .eq('space_id', ctx.spaceId)
      .eq('organization_id', ctx.orgId)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw new BadRequestException(error.message);

    return data ?? [];
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async assertForm(formId: string, ctx: Ctx): Promise<void> {
    const { data, error } = await this.client
      .from(FORMS_TABLE)
      .select('id')
      .eq('id', formId)
      .eq('space_id', ctx.spaceId)
      .eq('organization_id', ctx.orgId)
      .eq('is_deleted', false)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Form not found');
  }

  private async getWebhookOr404(
    formId: string,
    webhookId: string,
    ctx: Ctx,
  ): Promise<{
    id: string;
    provider: string;
    url: string;
    is_active: boolean;
    secret_encrypted: string | null;
    secret_iv: string | null;
    secret_tag: string | null;
  }> {
    const { data, error } = await this.client
      .from(WEBHOOKS_TABLE)
      .select(
        'id, provider, url, is_active, secret_encrypted, secret_iv, secret_tag',
      )
      .eq('id', webhookId)
      .eq('form_id', formId)
      .eq('space_id', ctx.spaceId)
      .eq('organization_id', ctx.orgId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Webhook not found');

    return data as {
      id: string;
      provider: string;
      url: string;
      is_active: boolean;
      secret_encrypted: string | null;
      secret_iv: string | null;
      secret_tag: string | null;
    };
  }

  private async assertUrlSafe(url: string): Promise<void> {
    try {
      await assertPublicHttpUrl(url);
    } catch (err) {
      throw new BadRequestException(
        (err as Error)?.message ?? 'Invalid webhook URL',
      );
    }
  }

  private encryptSecret(secret: string): {
    secret_encrypted: string;
    secret_iv: string;
    secret_tag: string;
  } {
    const { encrypted, iv, tag } = encryptApiKey(secret);

    return { secret_encrypted: encrypted, secret_iv: iv, secret_tag: tag };
  }

  private toView(row: Record<string, unknown>): WebhookView {
    return {
      id: row.id as string,
      form_id: row.form_id as string,
      provider: (row.provider as string) ?? 'generic',
      url: row.url as string,
      events: (row.events as string[]) ?? [],
      is_active: row.is_active as boolean,
      hasSecret: Boolean(row.secret_encrypted),
      created_by: (row.created_by as string | null) ?? null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }
}
