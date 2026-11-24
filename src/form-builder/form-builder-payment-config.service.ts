import { BadRequestException, Injectable } from '@nestjs/common';

import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { StripeService } from '../stripe/stripe.service';
import { toMajorUnits, toMinorUnits } from './payments/currency.util';
import {
  encryptApiKey,
  decryptApiKey,
  hintForSecret,
} from '../lib/crypto/encryption';
import type { SavePaymentConfigDto } from './dto/save-payment-config.dto';
import type { CreateStripeProductDto } from './dto/create-stripe-product.dto';

// A Stripe catalog product mapped into the builder's product shape.
export interface StripeCatalogItem {
  id: string;
  name: string;
  description?: string;
  image?: string;
  price: number;
  currency: string;
  recurring: boolean;
}

const CONFIG_TABLE = 'form_builder_payment_configs';

interface Ctx {
  spaceId: string;
  orgId: string;
}

// Client view — secrets redacted to booleans; the publishable key is not secret.
export interface PaymentConfigView {
  configured: boolean;
  provider: string;
  publishableKey: string | null;
  hasSecretKey: boolean;
  hasWebhookSecret: boolean;

  // Masked previews ("sk_****9a") so the UI can show which key is stored. Never the full secret.
  secretKeyHint: string | null;
  webhookSecretHint: string | null;
  is_active: boolean;
}

// Non-secret subset for the anonymous fill page.
export interface PaymentFillConfig {
  enabled: boolean;
  publishableKey: string | null;
  gateway: string;
}

interface ConfigRow {
  publishable_key: string | null;
  secret_encrypted: string | null;
  secret_iv: string | null;
  secret_tag: string | null;
  webhook_secret_encrypted: string | null;
  webhook_secret_iv: string | null;
  webhook_secret_tag: string | null;
  is_active: boolean;
  provider: string;
}

// Per-space Stripe connection — secrets encrypted at rest, scoped by org+space in app code.
@Injectable()
export class FormBuilderPaymentConfigService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly stripe: StripeService,
  ) {}

  // The space's Stripe client, built from its saved secret key.
  private async stripeForSpace(ctx: Ctx) {
    const secret = await this.getDecryptedSecret(ctx);

    if (!secret)
      throw new BadRequestException('Stripe is not connected for this space');

    return this.stripe.getStripeClientForKey(secret);
  }

  // Import the connected Stripe account's active catalog into the builder.
  async listStripeProducts(ctx: Ctx): Promise<StripeCatalogItem[]> {
    const stripe = await this.stripeForSpace(ctx);

    try {
      const res = await stripe.products.list({
        active: true,
        limit: 100,
        expand: ['data.default_price'],
      });

      return (res.data ?? [])
        .map((p) => {
          const price =
            p.default_price && typeof p.default_price === 'object'
              ? p.default_price
              : null;
          const currency = price?.currency ?? 'usd';

          return {
            id: p.id,
            name: p.name,
            description: p.description ?? undefined,
            image: p.images?.[0] ?? undefined,
            price: price ? toMajorUnits(price.unit_amount ?? 0, currency) : 0,
            currency: currency.toUpperCase(),
            // Recurring prices can't be charged by the one-off checkout this form uses.
            recurring: Boolean(price?.recurring?.interval),
          };
        })
        .filter((p) => !p.recurring);
    } catch (err) {
      throw new BadRequestException(
        (err as Error)?.message ?? 'Could not load Stripe products',
      );
    }
  }

  // Push a product defined in the builder to Stripe (creates a Product + a one-off Price).
  async createStripeProduct(
    ctx: Ctx,
    dto: CreateStripeProductDto,
  ): Promise<StripeCatalogItem> {
    const stripe = await this.stripeForSpace(ctx);
    const currency = (dto.currency || 'usd').toLowerCase();

    try {
      const product = await stripe.products.create({
        name: dto.name.trim(),
        ...(dto.description?.trim()
          ? { description: dto.description.trim() }
          : {}),
        ...(dto.image?.trim() ? { images: [dto.image.trim()] } : {}),
      });

      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: toMinorUnits(dto.price, currency),
        currency,
      });

      return {
        id: product.id,
        name: product.name,
        description: product.description ?? undefined,
        image: product.images?.[0] ?? undefined,
        price: toMajorUnits(price.unit_amount ?? 0, currency),
        currency: currency.toUpperCase(),
        recurring: false,
      };
    } catch (err) {
      throw new BadRequestException(
        (err as Error)?.message ?? 'Could not create the Stripe product',
      );
    }
  }

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async getConfig(ctx: Ctx): Promise<PaymentConfigView> {
    const row = await this.loadRow(ctx);

    return this.toView(row);
  }

  async saveConfig(
    ctx: Ctx,
    dto: SavePaymentConfigDto,
    userId: string,
  ): Promise<PaymentConfigView> {
    const existing = await this.loadRow(ctx);

    const patch: Record<string, unknown> = {
      organization_id: ctx.orgId,
      space_id: ctx.spaceId,
      provider: 'stripe',
    };

    if (dto.publishableKey !== undefined)
      patch.publishable_key = dto.publishableKey.trim() || null;
    if (dto.isActive !== undefined) patch.is_active = dto.isActive;
    // a non-empty secret re-encrypts; omitting it keeps the stored one.
    if (dto.secretKey?.trim())
      Object.assign(patch, this.encryptSecret(dto.secretKey.trim()));
    if (dto.webhookSecret?.trim())
      Object.assign(patch, this.encryptWebhookSecret(dto.webhookSecret.trim()));

    if (existing) {
      const { data, error } = await this.client
        .from(CONFIG_TABLE)
        .update(patch)
        .eq('organization_id', ctx.orgId)
        .eq('space_id', ctx.spaceId)
        .select('*')
        .single();

      if (error) throw new BadRequestException(error.message);

      return this.toView(data as ConfigRow);
    }

    const { data, error } = await this.client
      .from(CONFIG_TABLE)
      .insert({ ...patch, created_by: userId })
      .select('*')
      .single();

    if (error) throw new BadRequestException(error.message);

    return this.toView(data as ConfigRow);
  }

  async getFillConfig(ctx: Ctx): Promise<PaymentFillConfig> {
    const row = await this.loadRow(ctx);
    const enabled = Boolean(row?.is_active && row?.secret_encrypted);

    return {
      enabled,
      publishableKey: enabled ? (row?.publishable_key ?? null) : null,
      gateway: 'stripe',
    };
  }

  // Decrypted secret for building a per-space Stripe client. Null → caller falls back to the env key.
  async getDecryptedSecret(ctx: Ctx): Promise<string | null> {
    const row = await this.loadRow(ctx);

    if (
      !row ||
      !row.is_active ||
      !row.secret_encrypted ||
      !row.secret_iv ||
      !row.secret_tag
    )
      return null;

    try {
      return decryptApiKey(row.secret_encrypted, row.secret_iv, row.secret_tag);
    } catch {
      return null;
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async loadRow(ctx: Ctx): Promise<ConfigRow | null> {
    const { data, error } = await this.client
      .from(CONFIG_TABLE)
      .select(
        'publishable_key, secret_encrypted, secret_iv, secret_tag, webhook_secret_encrypted, webhook_secret_iv, webhook_secret_tag, is_active, provider',
      )
      .eq('organization_id', ctx.orgId)
      .eq('space_id', ctx.spaceId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);

    return (data as ConfigRow | null) ?? null;
  }

  private encryptSecret(secret: string): {
    secret_encrypted: string;
    secret_iv: string;
    secret_tag: string;
  } {
    const { encrypted, iv, tag } = encryptApiKey(secret);

    return { secret_encrypted: encrypted, secret_iv: iv, secret_tag: tag };
  }

  private encryptWebhookSecret(secret: string): {
    webhook_secret_encrypted: string;
    webhook_secret_iv: string;
    webhook_secret_tag: string;
  } {
    const { encrypted, iv, tag } = encryptApiKey(secret);

    return {
      webhook_secret_encrypted: encrypted,
      webhook_secret_iv: iv,
      webhook_secret_tag: tag,
    };
  }

  // Decrypt only to build a masked preview; never returns the plaintext.
  private hint(
    encrypted: string | null | undefined,
    iv: string | null | undefined,
    tag: string | null | undefined,
  ): string | null {
    if (!encrypted || !iv || !tag) return null;

    try {
      return hintForSecret(decryptApiKey(encrypted, iv, tag));
    } catch {
      return null;
    }
  }

  private toView(row: ConfigRow | null): PaymentConfigView {
    const hasSecretKey = Boolean(row?.secret_encrypted);

    return {
      configured: hasSecretKey && Boolean(row?.is_active),
      provider: row?.provider ?? 'stripe',
      publishableKey: row?.publishable_key ?? null,
      hasSecretKey,
      hasWebhookSecret: Boolean(row?.webhook_secret_encrypted),
      secretKeyHint: this.hint(
        row?.secret_encrypted,
        row?.secret_iv,
        row?.secret_tag,
      ),
      webhookSecretHint: this.hint(
        row?.webhook_secret_encrypted,
        row?.webhook_secret_iv,
        row?.webhook_secret_tag,
      ),
      is_active: row?.is_active ?? true,
    };
  }
}
