import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { StripeService } from '../stripe/stripe.service';
import { FormBuilderSubmissionsService } from './form-builder-submissions.service';
import { FormBuilderAssignmentsService } from './form-builder-assignments.service';
import { FormBuilderSubmissionEventsService } from './form-builder-submission-events.service';
import {
  FormBuilderPaymentConfigService,
  type PaymentFillConfig,
} from './form-builder-payment-config.service';
import type { CreateFormPaymentSessionDto } from './dto/create-form-payment-session.dto';
import { expandLayoutFields } from './logic/expand-layout-fields';

const FORMS_TABLE = 'form_builder';
const FIELDS_TABLE = 'form_builder_fields';
const ORDERS_TABLE = 'form_builder_orders';
const SUBMISSIONS_TABLE = 'form_builder_submissions';

// Stripe zero-decimal currencies — the amount is NOT multiplied by 100.
// https://docs.stripe.com/currencies#zero-decimal
const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif',
  'clp',
  'djf',
  'gnf',
  'jpy',
  'kmf',
  'krw',
  'mga',
  'pyg',
  'rwf',
  'ugx',
  'vnd',
  'vuv',
  'xaf',
  'xof',
  'xpf',
]);

// one product in a `products` field's stored options catalog
interface ProductCatalogItem {
  id: string;
  name?: string | null;
  // unit price in MAJOR currency units (e.g. 19.99 usd, 500 jpy)
  price?: number | string | null;
  qtyMin?: number | null;
  qtyMax?: number | null;
}

// a server-resolved purchase line (amounts already in MINOR units)
interface ResolvedLineItem {
  product_id: string;
  name: string;
  unit_amount: number;
  quantity: number;
  amount: number;
}

// a `form_builder_fields` row, narrowed to what a products-field lookup (direct or Layout-expanded) needs
interface FormFieldRow {
  field_key: string;
  field_type: string;
  label?: string | null;
  required?: boolean | null;
  is_hidden?: boolean | null;
  read_only?: boolean | null;
  options: unknown;
  validation_rules: Record<string, any> | null;
}

const FIELD_LOOKUP_COLS =
  'field_key, field_type, label, required, is_hidden, read_only, options, validation_rules';

interface OrderRow {
  id: string;
  status: string;
  submission_id: string | null;
  stripe_payment_intent_id: string | null;
  customer_email: string | null;
  form_id: string;
  space_id: string;
  organization_id: string;
}

// columns selected wherever an OrderRow is built — kept in sync with the interface above
const ORDER_COLS =
  'id, status, submission_id, stripe_payment_intent_id, customer_email, form_id, space_id, organization_id';

@Injectable()
export class FormBuilderPaymentsService {
  constructor(
    private readonly submissions: FormBuilderSubmissionsService,
    private readonly stripe: StripeService,
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly assignments: FormBuilderAssignmentsService,
    private readonly events: FormBuilderSubmissionEventsService,
    private readonly paymentConfig: FormBuilderPaymentConfigService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // Use the space's own Stripe key when connected; otherwise fall back to the global env key so
  // spaces that never configured Stripe keep working exactly as before.
  private async resolveStripeForSpace(
    orgId: string,
    spaceId: string,
  ): Promise<ReturnType<StripeService['getStripeClient']>> {
    const secret = await this.paymentConfig.getDecryptedSecret({
      orgId,
      spaceId,
    });

    if (secret) return this.stripe.getStripeClientForKey(secret);

    return this.stripe.getStripeClient('Payment processing is not configured');
  }

  // Non-secret Stripe config for the anonymous fill page.
  async getFillConfig(
    spaceId: string,
    formId: string,
  ): Promise<PaymentFillConfig> {
    const { data: formRow, error } = await this.client
      .from(FORMS_TABLE)
      .select('organization_id')
      .eq('id', formId)
      .eq('space_id', spaceId)
      .eq('is_deleted', false)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!formRow) throw new NotFoundException('Form not found');

    const orgId = (formRow as { organization_id: string }).organization_id;

    return this.paymentConfig.getFillConfig({ orgId, spaceId });
  }

  /**
   * Recomputes the order total from the stored product catalog, saves the form
   * answers as a DRAFT submission (so all gating runs BEFORE charging), records a
   * pending order, and opens an embedded Stripe Checkout session.
   *
   * @returns clientSecret (for Stripe.js embedded checkout), orderId and sessionId
   */
  async createCheckoutSession(
    spaceId: string,
    formId: string,
    dto: CreateFormPaymentSessionDto,
    origin?: string,
  ) {
    // 1) load the form (scoped to space, not deleted) — need org id + settings
    const { data: formRow, error: formErr } = await this.client
      .from(FORMS_TABLE)
      .select('id, organization_id, settings')
      .eq('id', formId)
      .eq('space_id', spaceId)
      .eq('is_deleted', false)
      .maybeSingle();

    if (formErr) throw new BadRequestException(formErr.message);
    if (!formRow) throw new NotFoundException('Form not found');

    const form = formRow as { id: string; organization_id: string };
    const organizationId = form.organization_id;

    // 1b) load the products field by field_key — direct row first (cheap, covers the common
    // top-level case). A `products` field placed inside a Layout container's cell is never its
    // own row in form_builder_fields (it lives in the layout row's options.cells[row][col]), so a
    // miss falls back to loading every field for the form and expanding Layout cells to find it.
    const { data: directField, error: fieldErr } = await this.client
      .from(FIELDS_TABLE)
      .select(FIELD_LOOKUP_COLS)
      .eq('form_id', formId)
      .eq('field_key', dto.field_key)
      .eq('field_type', 'products')
      .maybeSingle();

    if (fieldErr) throw new BadRequestException(fieldErr.message);

    let fieldRow = directField as FormFieldRow | null;

    if (!fieldRow) {
      const { data: allFieldRows, error: allFieldsErr } = await this.client
        .from(FIELDS_TABLE)
        .select(FIELD_LOOKUP_COLS)
        .eq('form_id', formId);

      if (allFieldsErr) throw new BadRequestException(allFieldsErr.message);

      const expanded = expandLayoutFields(
        (allFieldRows ?? []) as FormFieldRow[],
      );

      fieldRow =
        expanded.find(
          (f) => f.field_key === dto.field_key && f.field_type === 'products',
        ) ?? null;
    }

    if (!fieldRow) throw new NotFoundException('Payment field not found');

    const field = fieldRow;
    const rules = field.validation_rules ?? {};

    // 3) only Stripe is a functional gateway
    const gateway = String(rules.gateway ?? 'stripe').toLowerCase();

    if (gateway !== 'stripe')
      throw new BadRequestException(`Unsupported payment gateway: ${gateway}`);

    const currency = String(rules.currency ?? '').toLowerCase();

    if (!currency)
      throw new BadRequestException('Payment field has no currency configured');

    // 2) recompute the amount server-side from the stored catalog
    const catalog = this.parseCatalog(field.options);
    const { lineItems, amountTotal } = this.resolveLineItems(
      catalog,
      dto.selections,
      currency,
    );

    // free orders never reach Stripe — the frontend handles those directly
    if (amountTotal <= 0)
      throw new BadRequestException('Order total must be greater than zero');

    // 3b) ensure Stripe is configured before we create any records (throws if not).
    //     Uses the space's own key when connected, else the global env key.
    const stripeClient = await this.resolveStripeForSpace(
      organizationId,
      spaceId,
    );

    // 4) save the answers as a DRAFT — this runs publish-gate + allow_multiple +
    //    max_responses + validateAndClean + field_snapshot BEFORE charging.
    //    Anonymous fillers → submitted_by null.
    const submission = (await this.submissions.create(
      formId,
      { data: dto.submission_data, is_test: dto.is_test, surface: dto.surface },
      spaceId,
      organizationId,
      null,
      { ip: null, userAgent: null },
      true,
    )) as { id: string };

    // 5) record the pending order
    const { data: orderRow, error: orderErr } = await this.client
      .from(ORDERS_TABLE)
      .insert({
        organization_id: organizationId,
        space_id: spaceId,
        form_id: formId,
        submission_id: submission.id,
        field_key: dto.field_key,
        provider: 'stripe',
        amount_total: amountTotal,
        currency,
        status: 'pending',
        line_items: lineItems,
        metadata: origin ? { origin } : {},
      })
      .select('id')
      .single();

    if (orderErr) throw new BadRequestException(orderErr.message);

    const orderId = (orderRow as { id: string }).id;

    // 6) open the embedded Checkout session with ad-hoc price_data amounts
    //    (NOT Stripe Price ids). metadata + client_reference_id let the webhook
    //    and status poll tie the session back to this order.
    const session = await stripeClient.checkout.sessions.create({
      // Stripe API 2026-04-22 renamed 'embedded' → 'embedded_page' (still returns a client_secret
      // for Stripe.js Embedded Checkout).
      ui_mode: 'embedded_page',
      mode: 'payment',
      redirect_on_completion: 'never',
      line_items: lineItems.map((item) => ({
        price_data: {
          currency,
          product_data: { name: item.name },
          unit_amount: item.unit_amount,
        },
        quantity: item.quantity,
      })),
      metadata: { orderId, source: 'form_builder' },
      client_reference_id: orderId,
    });

    // link the session id back to the order
    const { error: linkErr } = await this.client
      .from(ORDERS_TABLE)
      .update({ stripe_checkout_session_id: session.id })
      .eq('id', orderId);

    if (linkErr) throw new BadRequestException(linkErr.message);

    return {
      clientSecret: session.client_secret,
      orderId,
      sessionId: session.id,
    };
  }

  /**
   * Returns the live Stripe status for a session and finalizes the order (flips
   * the draft submission to submitted) if payment has landed. Idempotent.
   */
  async getStatus(spaceId: string, formId: string, sessionId: string) {
    // Load the order FIRST: the session may live on the space's own Stripe account, so it must be
    // retrieved with the same client that created it (the global client would 404).
    const { data: orderRow, error } = await this.client
      .from(ORDERS_TABLE)
      .select(ORDER_COLS)
      .eq('stripe_checkout_session_id', sessionId)
      .eq('space_id', spaceId)
      .eq('form_id', formId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!orderRow) throw new NotFoundException('Order not found');

    const order = orderRow as OrderRow;

    const stripeClient = await this.resolveStripeForSpace(
      order.organization_id,
      spaceId,
    );

    const { data: statusData } = await this.stripe.getCheckoutStatus(
      sessionId,
      stripeClient,
    );

    const { status, paymentStatus, customerEmail } = statusData;

    let orderStatus = order.status;

    if (paymentStatus === 'paid') {
      const finalized = await this.finalize(order, {
        customerEmail: customerEmail ?? undefined,
      });

      orderStatus = finalized.status;
    }

    return { status, paymentStatus, orderStatus };
  }

  /**
   * Marks an order paid and flips its draft submission to submitted. Idempotent:
   * a NO-OP once the order is already paid. Shared by the status poll AND (in
   * spirit) the Stripe webhook — see FormBuilderPaymentsService note in
   * StripeService for why the webhook duplicates this tiny SQL instead of calling
   * this method (avoids a circular module dependency).
   */
  async finalize(
    orderIdOrRow: string | OrderRow,
    opts: {
      paymentIntentId?: string | null;
      customerEmail?: string | null;
    } = {},
  ): Promise<OrderRow> {
    const order =
      typeof orderIdOrRow === 'string'
        ? await this.loadOrder(orderIdOrRow)
        : orderIdOrRow;

    if (!order) throw new NotFoundException('Order not found');

    // idempotent — already finalized
    if (order.status === 'paid') return order;

    const { data: updatedRow, error } = await this.client
      .from(ORDERS_TABLE)
      .update({
        status: 'paid',
        stripe_payment_intent_id:
          opts.paymentIntentId ?? order.stripe_payment_intent_id ?? null,
        customer_email: opts.customerEmail ?? order.customer_email ?? null,
      })
      .eq('id', order.id)
      .neq('status', 'paid')
      .select(ORDER_COLS)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);

    // another finalize call won the race — treat as done
    const updated = (updatedRow as OrderRow | null) ?? {
      ...order,
      status: 'paid',
    };

    // flip the draft submission to submitted (guarded so re-runs are no-ops). Selecting the
    // flipped row lets us fire the submission-events seam ONLY when this call actually
    // transitioned the draft (single-fire; a lost race returns null and skips dispatch).
    if (order.submission_id) {
      const { data: flipped, error: subErr } = await this.client
        .from(SUBMISSIONS_TABLE)
        .update({ status: 'submitted' })
        .eq('id', order.submission_id)
        .eq('status', 'draft')
        .select('*')
        .maybeSingle();

      if (subErr) throw new BadRequestException(subErr.message);

      // approvals + outbound webhooks (best-effort; dispatch guards !is_test internally).
      if (flipped)
        void this.events.dispatch(flipped as Record<string, unknown>);
    }

    // best-effort: complete an assignment when the payer maps to an assigned user.
    // Payment submissions are anonymous (submitted_by null), so the Stripe customer
    // email is the only attribution signal. Never affects the payment outcome.
    if (order.submission_id) {
      const email =
        updated.customer_email ??
        opts.customerEmail ??
        order.customer_email ??
        null;

      if (email)
        void this.completeAssignmentByEmail(order, order.submission_id, email);
    }

    return updated;
  }

  // Resolve the payer's email to a user and complete their pending assignment for this
  // form. markCompletedOnSubmit is itself scoped to (form, space, org, user, pending), so
  // a wrong/foreign email can only ever no-op. Best-effort; never throws.
  private async completeAssignmentByEmail(
    order: OrderRow,
    submissionId: string,
    email: string,
  ): Promise<void> {
    try {
      const { data: userRow } = await this.client
        .from('users')
        .select('id')
        .eq('email', email)
        .limit(1)
        .maybeSingle();

      const userId = (userRow as { id?: string } | null)?.id ?? null;

      if (!userId) return;

      await this.assignments.markCompletedOnSubmit(
        order.form_id,
        userId,
        submissionId,
        order.space_id,
        order.organization_id,
      );
    } catch {
      // best-effort — payment finalize must never fail on assignment completion
    }
  }

  /**
   * Marks an order abandoned and deletes its still-draft submission. Used by the
   * checkout.session.expired webhook branch. Never touches a paid order.
   */
  async markAbandoned(orderId: string): Promise<void> {
    const order = await this.loadOrder(orderId);

    if (!order || order.status === 'paid') return;

    const { error } = await this.client
      .from(ORDERS_TABLE)
      .update({ status: 'abandoned' })
      .eq('id', orderId)
      .neq('status', 'paid');

    if (error) throw new BadRequestException(error.message);

    if (order.submission_id) {
      const { error: delErr } = await this.client
        .from(SUBMISSIONS_TABLE)
        .delete()
        .eq('id', order.submission_id)
        .eq('status', 'draft');

      if (delErr) throw new BadRequestException(delErr.message);
    }
  }

  private async loadOrder(orderId: string): Promise<OrderRow | null> {
    const { data, error } = await this.client
      .from(ORDERS_TABLE)
      .select(ORDER_COLS)
      .eq('id', orderId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);

    return (data as OrderRow | null) ?? null;
  }

  private parseCatalog(options: unknown): ProductCatalogItem[] {
    if (!Array.isArray(options)) return [];

    const items: ProductCatalogItem[] = [];

    for (const o of options as unknown[]) {
      if (
        o &&
        typeof o === 'object' &&
        typeof (o as { id?: unknown }).id === 'string'
      )
        items.push(o as ProductCatalogItem);
    }

    return items;
  }

  private resolveLineItems(
    catalog: ProductCatalogItem[],
    selections: Array<{ product_id: string; quantity: number }>,
    currency: string,
  ): { lineItems: ResolvedLineItem[]; amountTotal: number } {
    const byId = new Map(catalog.map((p) => [p.id, p]));
    const lineItems: ResolvedLineItem[] = [];
    let amountTotal = 0;

    for (const sel of selections) {
      const product = byId.get(sel.product_id);

      if (!product)
        throw new BadRequestException(`Unknown product: ${sel.product_id}`);

      const qtyMin = Number(product.qtyMin ?? 0);
      const qtyMax = product.qtyMax == null ? Infinity : Number(product.qtyMax);
      const quantity = Math.max(
        qtyMin,
        Math.min(qtyMax, Math.trunc(Number(sel.quantity) || 0)),
      );

      // clamped to 0 → not purchased; Stripe rejects a 0 quantity anyway
      if (quantity <= 0) continue;

      const unitAmount = this.toMinorUnits(
        Number(product.price ?? 0),
        currency,
      );

      if (!Number.isFinite(unitAmount) || unitAmount < 0)
        throw new BadRequestException(
          `Invalid price for product: ${sel.product_id}`,
        );

      const amount = unitAmount * quantity;

      lineItems.push({
        product_id: product.id,
        name: String(product.name ?? product.id),
        unit_amount: unitAmount,
        quantity,
        amount,
      });
      amountTotal += amount;
    }

    return { lineItems, amountTotal };
  }

  // convert a MAJOR-unit amount to Stripe MINOR units, honoring zero-decimal currencies
  private toMinorUnits(major: number, currency: string): number {
    const amount = Number(major) || 0;

    if (ZERO_DECIMAL_CURRENCIES.has(currency)) return Math.round(amount);

    return Math.round(amount * 100);
  }
}
