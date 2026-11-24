import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Stripe from 'stripe';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { decryptApiKey } from '../lib/crypto/encryption';
import { FORM_SUBMISSION_FINALIZED_EVENT } from '../form-builder/form-builder-submission-events.service';
import type { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';

export interface StripeProductOption {
  productId: string;
  productName: string;
  priceId: string;
  amount: number | null;
  currency: string;
  recurring: boolean;
  interval?: string;
}

export interface StripeProductsResult {
  data: StripeProductOption[];
  truncated: boolean;
}

export interface CheckoutSessionResult {
  data: {
    clientSecret: string | null;
  };
}

export interface CheckoutStatusResult {
  data: {
    status: string | null;
    paymentStatus: string;
    customerEmail: string | null;
  };
}

export interface StripeWebhookResult {
  received: true;
}

type StripePrice = {
  id: string;
  product: string | { id: string };
  unit_amount: number | null;
  currency: string;
  type: string;
  recurring?: { interval?: string | null } | null;
};

type StripeWebhookEvent = {
  type: string;
  data: {
    object: {
      id?: string | null;
      // present on checkout.session.* — the runtime object carries these even
      // though the narrow type historically only exposed `id`.
      metadata?: Record<string, string> | null;
      payment_status?: string | null;
      amount_total?: number | null;
      payment_intent?: string | { id?: string } | null;
      customer_details?: { email?: string | null } | null;
    };
  };
};

// A Stripe product as returned when the default price is expanded (catalog import).
export type StripeProductWithPrice = {
  id: string;
  name: string;
  description?: string | null;
  images?: string[] | null;
  default_price?: StripePrice | string | null;
};

type StripeClient = {
  products: {
    list(params: {
      active: boolean;
      limit: number;
      expand?: string[];
    }): Promise<{
      data: StripeProductWithPrice[];
      has_more: boolean;
    }>;
    create(params: {
      name: string;
      description?: string;
      images?: string[];
    }): Promise<StripeProductWithPrice>;
  };
  prices: {
    list(params: { active: boolean; limit: number }): Promise<{
      data: StripePrice[];
      has_more: boolean;
    }>;
    retrieve(priceId: string): Promise<StripePrice>;
    create(params: {
      product: string;
      unit_amount: number;
      currency: string;
    }): Promise<StripePrice>;
  };
  checkout: {
    sessions: {
      create(params: Record<string, unknown>): Promise<{
        id: string;
        client_secret: string | null;
      }>;
      retrieve(sessionId: string): Promise<{
        status: string | null;
        payment_status: string;
        customer_details?: { email?: string | null } | null;
      }>;
    };
  };
  webhooks: {
    constructEvent(
      payload: Buffer | string,
      header: string,
      secret: string,
    ): StripeWebhookEvent;
  };
};

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);

  // Per-space Stripe clients keyed by secret key (see getStripeClientForKey).
  private readonly clientsByKey = new Map<string, StripeClient>();
  private stripeClient: StripeClient | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async listProducts(): Promise<StripeProductsResult> {
    try {
      const stripe = this.getStripeClient('Stripe is not configured');
      const products = await stripe.products.list({ active: true, limit: 100 });
      const prices = await stripe.prices.list({ active: true, limit: 100 });
      const pricesByProduct = new Map<string, StripePrice[]>();

      for (const price of prices.data) {
        const productId =
          typeof price.product === 'string' ? price.product : price.product.id;
        const existing = pricesByProduct.get(productId) ?? [];

        pricesByProduct.set(productId, [...existing, price]);
      }

      const options: StripeProductOption[] = [];

      for (const product of products.data) {
        const productPrices = pricesByProduct.get(product.id) ?? [];

        for (const price of productPrices) {
          options.push({
            productId: product.id,
            productName: product.name,
            priceId: price.id,
            amount: price.unit_amount,
            currency: price.currency,
            recurring: price.type === 'recurring',
            interval: price.recurring?.interval ?? undefined,
          });
        }
      }

      return {
        data: options,
        truncated: products.has_more || prices.has_more,
      };
    } catch (error) {
      this.rethrowStripeError(error, 'Failed to load products');
    }
  }

  async createCheckoutSession(
    dto: CreateCheckoutSessionDto,
    origin?: string,
  ): Promise<CheckoutSessionResult> {
    const { funnel_id: funnelId, price_ids: priceIds } = dto;

    try {
      const { data: funnel, error: funnelError } = await this.client
        .from('site_studio_funnels')
        .select(
          'id, live_products, published, sub_domain_name, preview_subdomain',
        )
        .eq('id', funnelId)
        .maybeSingle();

      if (funnelError != null || !funnel || !funnel.published) {
        throw new NotFoundException('Funnel not found or not published');
      }

      const liveProducts = this.normalizeLiveProducts(funnel.live_products);
      const allowedPriceIds = new Set(liveProducts.map((p) => p.priceId));
      const invalidIds = priceIds.filter((id) => !allowedPriceIds.has(id));

      if (invalidIds.length > 0) {
        throw new BadRequestException(
          `Invalid price IDs: ${invalidIds.join(', ')}`,
        );
      }

      const stripe = this.getStripeClient(
        'Payment processing is not configured',
      );
      const requestedProducts = liveProducts.filter((p) =>
        priceIds.includes(p.priceId),
      );
      const stripePrices = await Promise.all(
        requestedProducts.map((p) => stripe.prices.retrieve(p.priceId)),
      );
      const isRecurring = stripePrices.some((p) => p.type === 'recurring');

      if (isRecurring && stripePrices.some((p) => p.type !== 'recurring')) {
        throw new BadRequestException(
          'Cannot mix one-time and recurring prices in the same session',
        );
      }

      const returnUrl = await this.resolveCheckoutReturnUrl(
        funnel,
        dto.return_url,
        origin,
      );
      const session = await stripe.checkout.sessions.create({
        // Stripe API 2026-04-22 renamed 'embedded' → 'embedded_page'.
        ui_mode: 'embedded_page',
        mode: isRecurring ? 'subscription' : 'payment',
        line_items: priceIds.map((priceId) => ({
          price: priceId,
          quantity: 1,
        })),
        return_url: returnUrl,
      });

      return { data: { clientSecret: session.client_secret } };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }

      this.rethrowStripeError(error, 'Failed to create checkout session');
    }
  }

  // `client` lets a caller retrieve a session created on a space's own Stripe account.
  // Optional so existing callers (Site Studio) keep using the global client.
  async getCheckoutStatus(
    sessionId: string,
    client?: StripeClient,
  ): Promise<CheckoutStatusResult> {
    try {
      const stripe = client ?? this.getStripeClient('Stripe is not configured');
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      return {
        data: {
          status: session.status,
          paymentStatus: session.payment_status,
          customerEmail: session.customer_details?.email ?? null,
        },
      };
    } catch (error) {
      this.rethrowStripeError(error, 'Failed to retrieve checkout status');
    }
  }

  async handleWebhook(
    rawBody: Buffer | undefined,
    signature?: string,
  ): Promise<StripeWebhookResult> {
    if (!signature) {
      throw new BadRequestException('Missing stripe-signature header');
    }

    if (!rawBody) {
      throw new BadRequestException('Missing raw request body');
    }

    // A form-builder event from a space using its OWN Stripe account is signed with that space's
    // webhook secret (stored in form_builder_payment_configs). Resolve it first, then fall back to
    // the platform-wide env secret. Both are plain HMAC checks, so trying each body is safe.
    const spaceCreds = await this.resolveFormBuilderWebhookCreds(rawBody);
    const globalSecret = this.config.get<string>('stripe.webhookSecret');

    const secrets = [
      ...new Set(
        [spaceCreds?.webhookSecret, globalSecret].filter(
          (s): s is string => !!s,
        ),
      ),
    ];

    if (secrets.length === 0) {
      this.logger.error(
        '[stripe/webhook] No webhook secret configured (per-space or global)',
      );

      return { received: true };
    }

    // constructEvent is a pure HMAC check, but it hangs off a client instance — prefer the space's
    // own API key so a deployment with no global STRIPE_SECRET_KEY still verifies.
    const stripe = spaceCreds?.apiKey
      ? this.getStripeClientForKey(spaceCreds.apiKey)
      : this.getStripeClient('Stripe is not configured');

    let event: StripeWebhookEvent | null = null;
    let lastError = 'Invalid Stripe webhook signature';

    for (const secret of secrets) {
      try {
        event = stripe.webhooks.constructEvent(rawBody, signature, secret);
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : lastError;
      }
    }

    if (!event) {
      this.logger.error(
        `[stripe/webhook] Signature verification failed: ${lastError}`,
      );
      throw new BadRequestException(`Webhook error: ${lastError}`);
    }

    // Persist/handle the event, then always ack 200 (Stripe retries on non-2xx).
    // A handler failure is logged but never surfaced — the status poll finalizes
    // as a backup path.
    return this.logWebhookEvent(event)
      .then((): StripeWebhookResult => ({ received: true }))
      .catch((error): StripeWebhookResult => {
        const message =
          error instanceof Error ? error.stack || error.message : String(error);

        this.logger.error(
          `[stripe/webhook] Handler error for ${event.type}: ${message}`,
        );

        return { received: true };
      });
  }

  // Untrusted peek at the raw body to pick the right verification secret for a form-builder event.
  // Never used to act on the event — the caller still verifies the signature before any handling.
  // Returns the space's decrypted Stripe webhook secret + API key from form_builder_payment_configs,
  // or null to fall back to the platform env secret.
  private async resolveFormBuilderWebhookCreds(
    rawBody: Buffer,
  ): Promise<{ webhookSecret: string | null; apiKey: string | null } | null> {
    try {
      const parsed = JSON.parse(rawBody.toString('utf8')) as {
        data?: { object?: { metadata?: Record<string, unknown> } };
      };
      const meta = parsed?.data?.object?.metadata;

      if (!meta || meta.source !== 'form_builder') return null;

      const orderId = typeof meta.orderId === 'string' ? meta.orderId : null;

      if (!orderId) return null;

      const { data: order } = await this.client
        .from('form_builder_orders')
        .select('space_id, organization_id')
        .eq('id', orderId)
        .maybeSingle()
        .overrideTypes<{ space_id: string; organization_id: string }>();

      if (!order) return null;

      const { data: cfg } = await this.client
        .from('form_builder_payment_configs')
        .select(
          'secret_encrypted, secret_iv, secret_tag, webhook_secret_encrypted, webhook_secret_iv, webhook_secret_tag',
        )
        .eq('space_id', order.space_id)
        .eq('organization_id', order.organization_id)
        .maybeSingle()
        .overrideTypes<{
          secret_encrypted: string | null;
          secret_iv: string | null;
          secret_tag: string | null;
          webhook_secret_encrypted: string | null;
          webhook_secret_iv: string | null;
          webhook_secret_tag: string | null;
        }>();

      if (!cfg) return null;

      const decrypt = (
        enc: string | null,
        iv: string | null,
        tag: string | null,
      ): string | null => {
        if (!enc || !iv || !tag) return null;

        try {
          return decryptApiKey(enc, iv, tag);
        } catch {
          return null;
        }
      };

      return {
        webhookSecret: decrypt(
          cfg.webhook_secret_encrypted,
          cfg.webhook_secret_iv,
          cfg.webhook_secret_tag,
        ),
        apiKey: decrypt(cfg.secret_encrypted, cfg.secret_iv, cfg.secret_tag),
      };
    } catch {
      return null;
    }
  }

  // Public so FormBuilderPaymentsService can build ad-hoc form-payment sessions
  // (price_data amounts) on the same shared Stripe client.
  getStripeClient(missingKeyMessage: string): StripeClient {
    if (this.stripeClient) return this.stripeClient;

    const key = this.config.get<string>('stripe.secretKey');

    if (!key) {
      // A missing Stripe key is an unconfigured dependency, not an internal
      // fault, so surface it as 503 (Service Unavailable) with the caller's
      // own message. Paid endpoints then degrade cleanly instead of 500ing.
      throw new ServiceUnavailableException(missingKeyMessage);
    }

    this.stripeClient = new Stripe(key, {
      apiVersion: '2026-04-22.dahlia',
    }) as unknown as StripeClient;

    return this.stripeClient;
  }

  // Per-space Stripe client (a space can connect its own account). Cached per key.
  getStripeClientForKey(secretKey: string): StripeClient {
    const cached = this.clientsByKey.get(secretKey);

    if (cached) return cached;

    const client = new Stripe(secretKey, {
      apiVersion: '2026-04-22.dahlia',
    }) as unknown as StripeClient;

    this.clientsByKey.set(secretKey, client);

    return client;
  }

  private rethrowStripeError(error: unknown, fallbackMessage: string): never {
    if (
      error instanceof ServiceUnavailableException ||
      error instanceof InternalServerErrorException ||
      error instanceof BadRequestException ||
      error instanceof NotFoundException
    ) {
      throw error;
    }

    if (this.isStripeError(error)) {
      throw new BadRequestException(error.message);
    }

    throw new InternalServerErrorException(fallbackMessage);
  }

  private async logWebhookEvent(event: StripeWebhookEvent): Promise<void> {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;

        this.logger.log(
          `[stripe/webhook] checkout.session.completed ${
            session.id ?? 'unknown'
          }`,
        );

        await this.finalizeFormBuilderOrderFromSession(session);
        break;
      }

      case 'checkout.session.expired': {
        const session = event.data.object;

        this.logger.log(
          `[stripe/webhook] checkout.session.expired ${session.id ?? 'unknown'}`,
        );

        await this.abandonFormBuilderOrderFromSession(session);
        break;
      }

      case 'customer.subscription.created': {
        const subscription = event.data.object;

        this.logger.log(
          `[stripe/webhook] subscription.created ${
            subscription.id ?? 'unknown'
          }`,
        );
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;

        this.logger.log(
          `[stripe/webhook] subscription.updated ${
            subscription.id ?? 'unknown'
          }`,
        );
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;

        this.logger.log(
          `[stripe/webhook] subscription.deleted ${
            subscription.id ?? 'unknown'
          }`,
        );
        break;
      }

      default:
        break;
    }
  }

  // --- Form Builder payments bridge -----------------------------------------
  // These two helpers duplicate the tiny finalize/abandon SQL that lives in
  // FormBuilderPaymentsService (the canonical version). Reaching that service
  // from here would create a circular module dependency (form-builder <-> stripe),
  // so — since StripeService already holds the admin client — we run the handful
  // of UPDATEs directly. Keep the two in sync. Only form_builder-tagged sessions
  // are touched (metadata guard); funnel sessions are left completely untouched.

  private async finalizeFormBuilderOrderFromSession(
    session: StripeWebhookEvent['data']['object'],
  ): Promise<void> {
    const orderId = session.metadata?.orderId;

    if (!orderId || session.metadata?.source !== 'form_builder') return;

    const paymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : (session.payment_intent?.id ?? null);
    const customerEmail = session.customer_details?.email ?? null;

    const { data: order, error } = await this.client
      .from('form_builder_orders')
      .select('id, status, submission_id')
      .eq('id', orderId)
      .maybeSingle()
      .overrideTypes<{
        id: string;
        status: string;
        submission_id: string | null;
      }>();

    if (error) {
      this.logger.error(
        `[stripe/webhook] finalize load failed for order ${orderId}: ${error.message}`,
      );
      return;
    }

    // idempotent — already finalized (or unknown order)
    if (!order || order.status === 'paid') return;

    const { error: updErr } = await this.client
      .from('form_builder_orders')
      .update({
        status: 'paid',
        stripe_payment_intent_id: paymentIntentId,
        customer_email: customerEmail,
      })
      .eq('id', orderId)
      .neq('status', 'paid');

    if (updErr) {
      this.logger.error(
        `[stripe/webhook] finalize update failed for order ${orderId}: ${updErr.message}`,
      );
      return;
    }

    if (order.submission_id) {
      const { error: subErr } = await this.client
        .from('form_builder_submissions')
        .update({ status: 'submitted' })
        .eq('id', order.submission_id)
        .eq('status', 'draft');

      if (subErr) {
        this.logger.error(
          `[stripe/webhook] finalize submission update failed for order ${orderId}: ${subErr.message}`,
        );
      } else {
        // Notify the form-builder module (decoupled event — calling into it directly would
        // be a circular module dependency) so approvals + outbound webhooks also fire for
        // paid submissions finalized via the webhook (not the status poll). The listener
        // re-verifies the row and is idempotent, so a double-fire with finalize() is safe.
        this.eventEmitter.emit(FORM_SUBMISSION_FINALIZED_EVENT, {
          submissionId: order.submission_id,
        });
      }
    }
  }

  private async abandonFormBuilderOrderFromSession(
    session: StripeWebhookEvent['data']['object'],
  ): Promise<void> {
    const orderId = session.metadata?.orderId;

    if (!orderId || session.metadata?.source !== 'form_builder') return;

    const { data: order, error } = await this.client
      .from('form_builder_orders')
      .select('id, status, submission_id')
      .eq('id', orderId)
      .maybeSingle();

    if (error || !order || order.status === 'paid') return;

    const { error: updErr } = await this.client
      .from('form_builder_orders')
      .update({ status: 'abandoned' })
      .eq('id', orderId)
      .neq('status', 'paid');

    if (updErr) {
      this.logger.error(
        `[stripe/webhook] abandon update failed for order ${orderId}: ${updErr.message}`,
      );
      return;
    }

    if (order.submission_id) {
      const { error: delErr } = await this.client
        .from('form_builder_submissions')
        .delete()
        .eq('id', order.submission_id)
        .eq('status', 'draft');

      if (delErr) {
        this.logger.error(
          `[stripe/webhook] abandon submission delete failed for order ${orderId}: ${delErr.message}`,
        );
      }
    }
  }

  private isStripeError(
    error: unknown,
  ): error is { type: string; message: string } {
    return (
      typeof error === 'object' &&
      error !== null &&
      'type' in error &&
      typeof (error as { type?: unknown }).type === 'string' &&
      (error as { type: string }).type.startsWith('Stripe') &&
      'message' in error &&
      typeof (error as { message?: unknown }).message === 'string'
    );
  }

  private normalizeLiveProducts(value: unknown): Array<{
    productId: string;
    priceId: string;
    recurring: boolean;
  }> {
    if (!Array.isArray(value)) return [];

    return value.filter(
      (
        item,
      ): item is { productId: string; priceId: string; recurring: boolean } =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { productId?: unknown }).productId === 'string' &&
        typeof (item as { priceId?: unknown }).priceId === 'string' &&
        typeof (item as { recurring?: unknown }).recurring === 'boolean',
    );
  }

  private async resolveReturnOrigin(
    funnel: {
      id: string;
      sub_domain_name?: string | null;
      preview_subdomain?: string | null;
    },
    origin?: string,
  ): Promise<string> {
    const appUrl = this.config.get<string>('appUrl') || 'http://localhost:3000';

    if (!origin) return new URL(appUrl).origin;

    let requested: URL;

    try {
      requested = new URL(origin);
    } catch {
      throw new BadRequestException('Invalid checkout origin');
    }

    const allowedConfiguredOrigins = new Set(
      [
        appUrl,
        this.config.get<string>('frontendUrl'),
        ...(this.config.get<string[]>('allowedOrigins') ?? []),
      ]
        .filter((value): value is string => Boolean(value))
        .map((value) => new URL(value).origin),
    );

    if (allowedConfiguredOrigins.has(requested.origin)) {
      return requested.origin;
    }

    const frontendHost = new URL(appUrl).host;
    const allowedSubdomainHosts = [
      funnel.sub_domain_name,
      funnel.preview_subdomain,
    ]
      .filter((value): value is string => Boolean(value))
      .map((subdomain) => `${subdomain}.${frontendHost}`);

    if (allowedSubdomainHosts.includes(requested.host)) {
      return requested.origin;
    }

    const { data: domains, error } = await this.client
      .from('site_studio_domains')
      .select('domain')
      .eq('funnel_id', funnel.id)
      .eq('verified', true);

    if (error) throw new BadRequestException(error.message);

    const customHosts = new Set(
      ((domains ?? []) as Array<{ domain: string }>).map(
        (domain) => domain.domain,
      ),
    );

    if (customHosts.has(requested.host)) {
      return requested.origin;
    }

    throw new BadRequestException('Checkout origin is not allowed');
  }

  private async resolveCheckoutReturnUrl(
    funnel: {
      id: string;
      sub_domain_name?: string | null;
      preview_subdomain?: string | null;
    },
    returnUrl: string | undefined,
    origin?: string,
  ): Promise<string> {
    const fallbackOrigin = await this.resolveReturnOrigin(funnel, origin);

    if (!returnUrl) {
      return `${fallbackOrigin}?session_id={CHECKOUT_SESSION_ID}`;
    }

    let requested: URL;

    try {
      requested = new URL(returnUrl);
    } catch {
      throw new BadRequestException('Invalid checkout return URL');
    }

    await this.resolveReturnOrigin(funnel, requested.origin);

    if (
      returnUrl.includes('{CHECKOUT_SESSION_ID}') ||
      returnUrl.includes('%7BCHECKOUT_SESSION_ID%7D')
    ) {
      return returnUrl;
    }

    const separator = returnUrl.includes('?') ? '&' : '?';

    return `${returnUrl}${separator}session_id={CHECKOUT_SESSION_ID}`;
  }
}
