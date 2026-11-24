/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- dynamically-typed Supabase rows via the generic partner repository */
/**
 * @fileoverview Sub-ticket 4 (sales) - license packages, quotes (with server-side
 * total recompute + atomic quote→invoice→license conversion), invoices, and
 * on-prem installs. Conversion delegates to the partner_convert_quote RPC and
 * busts the customer org's entitlements cache so new modules/seats resolve at once.
 *
 * Acceptance is customer-only: the partner can send a quote but cannot accept it,
 * and convertQuote refuses any quote the customer org has not accepted itself. The
 * customer-facing inbox (list/get/acceptIncomingQuote) lives at the bottom of this
 * file and is served by PartnerCustomerQuotesController without @RequirePartner().
 * @module src/partner/partner-sales.service
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PartnerRepository } from './partner.repository';
import { EntitlementsService } from '../licensing/entitlements.service';
import type {
  CreatePackageDto,
  CreateQuoteDto,
  UpdateInvoiceDto,
  UpdatePackageDto,
  UpdateQuoteDto,
} from './dto/partner.dto';

/** DTO package items → partner_license_package_items rows (defaults applied). */
function toPackageItemRows(
  organizationId: string,
  packageId: string,
  userId: string,
  items: CreatePackageDto['items'] = [],
) {
  return items.map((item, index) => ({
    organization_id: organizationId,
    package_id: packageId,
    item_type: item.item_type,
    feature_key: item.feature_key ?? null,
    label: item.label,
    quantity: item.quantity ?? 1,
    unit_price_cents: item.unit_price_cents ?? 0,
    per_period: item.per_period ?? true,
    sort_order: item.sort_order ?? index,
    created_by: userId,
    updated_by: userId,
  }));
}

/**
 * Renewal term for a licence that ran `start`..`end` (inclusive dates): it
 * starts the day after `end` (today if that is already past) and lasts as
 * long. Dates are YYYY-MM-DD, computed in UTC so no timezone shifts a day.
 */
export function renewalWindow(
  start: string,
  end: string,
  today: string,
): { start: string; end: string } {
  const day = 86_400_000;
  const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const newStart = Math.max(toMs(end) + day, toMs(today));

  return {
    start: iso(newStart),
    end: iso(newStart + (toMs(end) - toMs(start))),
  };
}

@Injectable()
export class PartnerSalesService {
  constructor(
    private readonly repo: PartnerRepository,
    private readonly entitlements: EntitlementsService,
  ) {}

  // ── Packages ───────────────────────────────────────────────────────────────
  /** Active entries of the global XISUITE price list (XE-T738). */
  async listResellableItems() {
    const { data, error } = await this.repo.client
      .from('partner_resellable_items')
      .select(
        'id, item_type, feature_key, name, description, default_unit_price_cents, default_per_period, sort_order',
      )
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });
    if (error) {
      throw new BadRequestException(error.message);
    }

    return data ?? [];
  }

  /**
   * XE-T738: package rows must come from the XISUITE price list. Every module
   * row needs a key, and every key must be an active price-list entry of the
   * same type. Runs before any write, so a bad row never leaves half a package.
   */
  private async assertItemsOnPriceList(items: CreatePackageDto['items']) {
    if (!items?.length) {
      return;
    }

    const missing = items.find(
      (i) => i.item_type === 'module' && !i.feature_key,
    );
    if (missing) {
      throw new BadRequestException(
        `Pick a module from the price list for "${missing.label}"`,
      );
    }

    const keys = [...new Set(items.map((i) => i.feature_key).filter(Boolean))];
    if (!keys.length) {
      return;
    }

    const { data, error } = await this.repo.client
      .from('partner_resellable_items')
      .select('feature_key, item_type')
      .eq('is_active', true)
      .in('feature_key', keys);
    if (error) {
      throw new BadRequestException(error.message);
    }

    const offered = new Map(
      (data ?? []).map((row: { feature_key: string; item_type: string }) => [
        row.feature_key,
        row.item_type,
      ]),
    );
    const bad = items.find(
      (i) => i.feature_key && offered.get(i.feature_key) !== i.item_type,
    );
    if (bad) {
      throw new BadRequestException(
        `"${bad.label}" (${bad.feature_key}) is not on the XISUITE price list as ${bad.item_type}`,
      );
    }
  }

  async listPackages(
    organizationId: string,
    filters: {
      status?: string;
      search?: string;
      page?: number;
      pageSize?: number;
    },
  ) {
    return this.repo.list('partner_license_packages', {
      // Item ids only, so the list's "Items" column counts real rows (it showed
      // 0 for every package because items were never loaded - XE-T740).
      select: '*, items:partner_license_package_items(id)',
      page: filters.page,
      pageSize: filters.pageSize,
      filters: {
        organization_id: organizationId,
        is_deleted: false,
        ...(filters.status ? { status: filters.status } : {}),
      },
      search: filters.search
        ? { column: 'name', term: filters.search }
        : undefined,
    });
  }

  async getPackage(organizationId: string, packageId: string) {
    const pkg = await this.repo.findById(
      'partner_license_packages',
      packageId,
      organizationId,
    );
    if (!pkg || pkg.is_deleted) {
      throw new NotFoundException('Package not found');
    }

    const items = await this.repo.findMany('partner_license_package_items', {
      package_id: packageId,
    });

    return { ...pkg, items };
  }

  async createPackage(
    organizationId: string,
    userId: string,
    dto: CreatePackageDto,
  ) {
    const { items, ...pkg } = dto;
    await this.assertItemsOnPriceList(items);
    const created = await this.repo
      .insert('partner_license_packages', {
        ...pkg,
        organization_id: organizationId,
        created_by: userId,
        updated_by: userId,
      })
      .catch((err: unknown) => {
        // The only unique rule on this table is the live package key.
        if (err instanceof ConflictException) {
          throw new ConflictException(
            `A package with the key "${dto.package_key}" already exists`,
          );
        }
        throw err;
      });

    // XE-T740: header and items are two writes. If the items fail, remove the
    // header again - otherwise an empty package is left behind and every retry
    // with the same key dies on UNIQUE(organization_id, package_key).
    try {
      await this.repo.insertMany(
        'partner_license_package_items',
        toPackageItemRows(organizationId, created.id as string, userId, items),
      );
    } catch (err) {
      await this.repo
        .deleteById(
          'partner_license_packages',
          created.id as string,
          organizationId,
        )
        .catch(() => undefined);
      throw err;
    }

    return this.getPackage(organizationId, created.id as string);
  }

  async updatePackage(
    organizationId: string,
    userId: string,
    packageId: string,
    dto: UpdatePackageDto,
  ) {
    const existing = await this.getPackage(organizationId, packageId);
    const { items, ...patch } = dto;
    await this.assertItemsOnPriceList(items);

    await this.repo.updateById(
      'partner_license_packages',
      packageId,
      { ...patch, updated_by: userId },
      organizationId,
    );

    // If items are supplied, replace the set. Insert the new rows first and only
    // then drop the old ones (XE-T740): a failing insert used to run after the
    // delete and wiped the package's items.
    if (items) {
      await this.repo.insertMany(
        'partner_license_package_items',
        toPackageItemRows(organizationId, packageId, userId, items),
      );

      const oldIds = (existing.items as Array<{ id: string }>).map((i) => i.id);
      if (oldIds.length) {
        const { error } = await this.repo.client
          .from('partner_license_package_items')
          .delete()
          .in('id', oldIds)
          .eq('package_id', packageId)
          .eq('organization_id', organizationId);
        if (error) {
          throw new BadRequestException(error.message);
        }
      }
    }

    return this.getPackage(organizationId, packageId);
  }

  async deletePackage(
    organizationId: string,
    userId: string,
    packageId: string,
  ) {
    await this.getPackage(organizationId, packageId);
    await this.repo.updateById(
      'partner_license_packages',
      packageId,
      {
        is_deleted: true,
        deleted_at: new Date().toISOString(),
        deleted_by: userId,
      },
      organizationId,
    );

    return { success: true };
  }

  // ── Quotes ───────────────────────────────────────────────────────────────
  async listQuotes(
    organizationId: string,
    filters: {
      status?: string;
      customerId?: string;
      page?: number;
      pageSize?: number;
      search?: string;
    },
  ) {
    return this.repo.list('partner_quotes', {
      page: filters.page,
      pageSize: filters.pageSize,
      // The quotes search box sent `search` but it was ignored (audit P8).
      ...(filters.search
        ? { search: { column: 'quote_key', term: filters.search } }
        : {}),
      filters: {
        organization_id: organizationId,
        is_deleted: false,
        ...(filters.status ? { status: filters.status } : {}),
        // XE-T737: the customer detail page lists one customer's documents.
        ...(filters.customerId ? { customer_id: filters.customerId } : {}),
      },
    });
  }

  async getQuote(organizationId: string, quoteId: string) {
    const quote = await this.repo.findById(
      'partner_quotes',
      quoteId,
      organizationId,
    );
    if (!quote || quote.is_deleted) {
      throw new NotFoundException('Quote not found');
    }

    const items = await this.repo.findMany('partner_quote_items', {
      quote_id: quoteId,
    });

    return { ...quote, items };
  }

  private computeTotals(
    items: CreateQuoteDto['items'],
    taxCents: number,
    extraDiscountCents: number,
  ) {
    const priced = items.map((item, index) => ({
      ...item,
      line_total_cents: item.quantity * item.unit_price_cents,
      sort_order: item.sort_order ?? index,
    }));

    const subtotal = priced
      .filter((i) => i.item_type !== 'discount')
      .reduce((sum, i) => sum + i.line_total_cents, 0);
    const lineDiscounts = priced
      .filter((i) => i.item_type === 'discount')
      .reduce((sum, i) => sum + i.line_total_cents, 0); // negative
    const discount = extraDiscountCents + Math.abs(Math.min(0, lineDiscounts));
    const total = Math.max(0, subtotal - discount + taxCents);

    return { priced, subtotal, discount, tax: taxCents, total };
  }

  async createQuote(
    organizationId: string,
    userId: string,
    dto: CreateQuoteDto,
  ) {
    if (new Date(dto.end_date) < new Date(dto.start_date)) {
      throw new BadRequestException('end_date must be on or after start_date');
    }

    // Validate the customer belongs to this partner.
    const customer = await this.repo.findById(
      'partner_customers',
      dto.customer_id,
      organizationId,
    );
    if (!customer) {
      throw new BadRequestException('Customer not found for this partner');
    }

    const { priced, subtotal, discount, tax, total } = this.computeTotals(
      dto.items,
      dto.tax_cents ?? 0,
      dto.discount_cents ?? 0,
    );

    const quote = await this.repo.insert('partner_quotes', {
      organization_id: organizationId,
      customer_id: dto.customer_id,
      package_id: dto.package_id ?? null,
      status: 'draft',
      deployment_type: dto.deployment_type ?? 'cloud',
      currency: dto.currency ?? 'EUR',
      start_date: dto.start_date,
      end_date: dto.end_date,
      included_users: dto.included_users ?? 0,
      billing_period: dto.billing_period ?? 'monthly',
      subtotal_cents: subtotal,
      discount_cents: discount,
      tax_cents: tax,
      total_cents: total,
      valid_until: dto.valid_until ?? null,
      notes: dto.notes ?? null,
      created_by: userId,
      updated_by: userId,
    });

    await this.repo.insertMany(
      'partner_quote_items',
      priced.map((item) => ({
        organization_id: organizationId,
        quote_id: quote.id,
        item_type: item.item_type,
        feature_key: item.feature_key ?? null,
        label: item.label,
        description: item.description ?? null,
        quantity: item.quantity,
        unit_price_cents: item.unit_price_cents,
        per_period: item.per_period ?? true,
        line_total_cents: item.line_total_cents,
        start_date: item.start_date ?? null,
        end_date: item.end_date ?? null,
        deployment_type: item.deployment_type ?? null,
        sort_order: item.sort_order,
        created_by: userId,
        updated_by: userId,
      })),
    );

    return this.getQuote(organizationId, quote.id as string);
  }

  async updateQuote(
    organizationId: string,
    userId: string,
    quoteId: string,
    dto: UpdateQuoteDto,
  ) {
    const quote = await this.getQuote(organizationId, quoteId);
    if (quote.status !== 'draft') {
      throw new BadRequestException('Only draft quotes can be edited');
    }

    const patch: Record<string, unknown> = { updated_by: userId };
    for (const key of [
      'customer_id',
      'package_id',
      'deployment_type',
      'currency',
      'start_date',
      'end_date',
      'included_users',
      'billing_period',
      'valid_until',
      'notes',
    ] as const) {
      if (dto[key] !== undefined) patch[key] = dto[key];
    }

    if (dto.items) {
      const { priced, subtotal, discount, tax, total } = this.computeTotals(
        dto.items,
        dto.tax_cents ?? quote.tax_cents ?? 0,
        dto.discount_cents ?? 0,
      );
      patch.subtotal_cents = subtotal;
      patch.discount_cents = discount;
      patch.tax_cents = tax;
      patch.total_cents = total;

      await this.repo.client
        .from('partner_quote_items')
        .delete()
        .eq('quote_id', quoteId)
        .eq('organization_id', organizationId);

      await this.repo.insertMany(
        'partner_quote_items',
        priced.map((item) => ({
          organization_id: organizationId,
          quote_id: quoteId,
          item_type: item.item_type,
          feature_key: item.feature_key ?? null,
          label: item.label,
          description: item.description ?? null,
          quantity: item.quantity,
          unit_price_cents: item.unit_price_cents,
          per_period: item.per_period ?? true,
          line_total_cents: item.line_total_cents,
          start_date: item.start_date ?? null,
          end_date: item.end_date ?? null,
          deployment_type: item.deployment_type ?? null,
          sort_order: item.sort_order,
          created_by: userId,
          updated_by: userId,
        })),
      );
    }

    await this.repo.updateById(
      'partner_quotes',
      quoteId,
      patch,
      organizationId,
    );

    return this.getQuote(organizationId, quoteId);
  }

  /**
   * Send a quote to the customer. `action` is a single-member union rather than a
   * bare call because 'accept' used to live here - acceptance is now exclusively
   * the customer's act (see acceptIncomingQuote), and the partner has no
   * transition that can reach 'accepted'.
   */
  async transitionQuote(
    organizationId: string,
    userId: string,
    quoteId: string,
    action: 'send',
  ) {
    void action;
    const quote = await this.getQuote(organizationId, quoteId);

    if (!['draft', 'sent'].includes(quote.status)) {
      throw new BadRequestException(`Cannot send a quote in '${quote.status}'`);
    }

    // Only a customer linked to a real org has an admin who can accept, and only
    // a linked org can carry the licence. Refuse at send time with a clear reason
    // instead of parking an unacceptable quote in 'sent' forever.
    const customer = await this.repo.findById(
      'partner_customers',
      quote.customer_id as string,
      organizationId,
    );
    if (!customer?.customer_organization_id) {
      throw new BadRequestException(
        'This customer is not linked to an organization yet, so nobody can accept the quote. Link the customer to their organization first (via an accepted lead).',
      );
    }

    return this.repo.updateById(
      'partner_quotes',
      quoteId,
      {
        status: 'sent',
        sent_at: new Date().toISOString(),
        updated_by: userId,
      },
      organizationId,
    );
  }

  /** Atomic quote → invoice + customer license (RPC), then bust the cache. */
  async convertQuote(organizationId: string, userId: string, quoteId: string) {
    const quote = await this.getQuote(organizationId, quoteId);

    const customer = await this.repo.findById(
      'partner_customers',
      quote.customer_id as string,
      organizationId,
    );
    const customerOrgId = customer?.customer_organization_id as
      | string
      | undefined;

    // The customer's own acceptance is what authorises conversion. The RPC enforces
    // this too (it is the transactional boundary); this check exists to turn the
    // raw plpgsql exception into an actionable 403 instead of a 400.
    //
    // Skipped once converted_license_id is set: the licence already exists, so the
    // RPC's idempotent already-converted return must stay reachable. Re-litigating
    // consent there would 403 instead of replaying the result - and would break
    // quotes converted before accepted_by_organization_id existed.
    if (
      !quote.converted_license_id &&
      (!customerOrgId ||
        quote.accepted_by_organization_id !== customerOrgId ||
        quote.status !== 'accepted')
    ) {
      throw new ForbiddenException(
        'This quote has not been accepted by the customer organization yet. Only the customer can accept a quote.',
      );
    }

    const result = await this.repo.rpc<{
      invoice_id: string;
      license_id: string;
      already_converted: boolean;
    }>('partner_convert_quote', { p_quote_id: quoteId, p_actor: userId });

    // Bust the customer org's entitlements cache so new modules/seats resolve now.
    // Conditional because the already-converted path above can reach here without
    // a linked customer org.
    if (customerOrgId) {
      this.entitlements.bust(customerOrgId);
    }

    return result;
  }

  // ── Customer-facing quote inbox ────────────────────────────────────────────
  // These are reached by the CUSTOMER org's admin, NOT the partner: the routes
  // carry no @RequirePartner() and are scoped to the caller's OWN organization
  // via partner_customers.customer_organization_id. A partner cannot reach them
  // for another org's quotes because organizationId comes from the auth context.

  /** Quotes addressed to `organizationId` that are awaiting its decision. */
  async listIncomingQuotes(
    organizationId: string,
    filters: { page?: number; pageSize?: number },
  ) {
    const page = filters.page ?? 1;
    const pageSize = Math.min(filters.pageSize ?? 20, 100);
    const from = (page - 1) * pageSize;

    // !inner + the embedded eq is the tenant boundary here: partner_quotes has no
    // customer org column of its own, so the scope lives on the joined row.
    const select =
      '*, partner_customers!inner(customer_organization_id, customer_name)';

    const { data, error, count } = await this.repo.client
      .from('partner_quotes')
      .select(select, { count: 'exact' })
      .eq('partner_customers.customer_organization_id', organizationId)
      .eq('status', 'sent')
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1);

    if (error) {
      throw new BadRequestException(
        error.message ?? 'Failed to list incoming quotes',
      );
    }

    return { data: data ?? [], totalCount: count ?? 0 };
  }

  /** A single incoming quote plus its line items, scoped to the caller's org. */
  async getIncomingQuote(organizationId: string, quoteId: string) {
    const { data, error } = await this.repo.client
      .from('partner_quotes')
      .select('*, partner_customers!inner(customer_organization_id)')
      .eq('id', quoteId)
      .eq('partner_customers.customer_organization_id', organizationId)
      .eq('is_deleted', false)
      .maybeSingle();

    if (error) {
      throw new BadRequestException(error.message ?? 'Failed to load quote');
    }
    if (!data) {
      throw new NotFoundException('Quote not found');
    }

    const items = await this.repo.findMany('partner_quote_items', {
      quote_id: quoteId,
    });

    return { ...data, items };
  }

  /**
   * The customer org accepts a quote addressed to it. Writing
   * accepted_by_organization_id = the caller's own org is what unlocks conversion;
   * no partner-side route can write that column.
   */
  async acceptIncomingQuote(
    organizationId: string,
    userId: string,
    quoteId: string,
  ) {
    const quote = await this.getIncomingQuote(organizationId, quoteId);

    if (quote.status !== 'sent') {
      throw new BadRequestException(
        `Cannot accept a quote in '${quote.status}'`,
      );
    }

    // Not scoped by organization_id: that column holds the PARTNER's org, and the
    // caller is the customer. getIncomingQuote above already proved the caller's
    // org is this quote's customer org, which is the authorisation that matters.
    return this.repo.updateById('partner_quotes', quoteId, {
      status: 'accepted',
      accepted_at: new Date().toISOString(),
      accepted_by: userId,
      accepted_by_organization_id: organizationId,
      updated_by: userId,
    });
  }

  // ── Invoices ───────────────────────────────────────────────────────────────
  async listInvoices(
    organizationId: string,
    filters: {
      status?: string;
      customerId?: string;
      page?: number;
      pageSize?: number;
    },
  ) {
    return this.repo.list('partner_invoices', {
      page: filters.page,
      pageSize: filters.pageSize,
      filters: {
        organization_id: organizationId,
        is_deleted: false,
        ...(filters.status ? { status: filters.status } : {}),
        // XE-T737: the customer detail page lists one customer's documents.
        ...(filters.customerId ? { customer_id: filters.customerId } : {}),
      },
    });
  }

  async getInvoice(organizationId: string, invoiceId: string) {
    const invoice = await this.repo.findById(
      'partner_invoices',
      invoiceId,
      organizationId,
    );
    if (!invoice || invoice.is_deleted) {
      throw new NotFoundException('Invoice not found');
    }

    const items = await this.repo.findMany('partner_invoice_items', {
      invoice_id: invoiceId,
    });

    return { ...invoice, items };
  }

  async updateInvoice(
    organizationId: string,
    userId: string,
    invoiceId: string,
    dto: UpdateInvoiceDto,
  ) {
    await this.getInvoice(organizationId, invoiceId);
    const patch: Record<string, unknown> = { ...dto, updated_by: userId };
    if (dto.status === 'paid') {
      patch.paid_at = new Date().toISOString();
    } else if (dto.status) {
      // Leaving 'paid' must clear paid_at, else partner_invoices_paid_check fails.
      patch.paid_at = null;
    }

    return this.repo.updateById(
      'partner_invoices',
      invoiceId,
      patch,
      organizationId,
    );
  }

  async markInvoicePaid(
    organizationId: string,
    userId: string,
    invoiceId: string,
  ) {
    await this.getInvoice(organizationId, invoiceId);

    return this.repo.updateById(
      'partner_invoices',
      invoiceId,
      { status: 'paid', paid_at: new Date().toISOString(), updated_by: userId },
      organizationId,
    );
  }

  // ── Renew / upgrade / cancel a sold licence (audit P4) ─────────────────────

  /** A licence this partner sold (partner_id), or 404. */
  private async soldLicence(organizationId: string, licenseId: string) {
    const { data, error } = await this.repo.client
      .from('organization_licenses')
      .select(
        'id, organization_id, status, starts_at, ends_at, source_quote_id, deployment_type, renewal_declined_at, metadata',
      )
      .eq('id', licenseId)
      .eq('partner_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException('Failed to load licence');
    if (!data) throw new NotFoundException('Licence not found');

    return data as {
      id: string;
      organization_id: string;
      status: string;
      starts_at: string;
      ends_at: string | null;
      source_quote_id: string | null;
      deployment_type: string | null;
    };
  }

  /** The quote a licence was sold from (template for renewal/upgrade). */
  private async sourceQuote(organizationId: string, quoteId: string | null) {
    if (!quoteId) {
      throw new BadRequestException(
        'This licence was not sold through a quote, so it cannot be renewed from here',
      );
    }

    return this.getQuote(organizationId, quoteId);
  }

  private async assertNoOpenFollowUp(
    organizationId: string,
    licenseId: string,
    kind: 'renewal' | 'upgrade',
  ) {
    const { data } = await this.repo.client
      .from('partner_quotes')
      .select('id, quote_key')
      .eq('organization_id', organizationId)
      .eq('renews_license_id', licenseId)
      .eq('quote_kind', kind)
      .eq('is_deleted', false)
      .in('status', ['draft', 'sent', 'accepted'])
      .limit(1)
      .maybeSingle();

    if (data) {
      const open = data as { id: string; quote_key: string };
      throw new ConflictException({
        message: `An open ${kind} quote already exists for this licence (${open.quote_key})`,
        quote_id: open.id,
      });
    }
  }

  /**
   * Draft renewal quote: same items, users and price as the licence's source
   * quote, starting the day after the licence ends (or today if it already
   * ended) for the same length. No overlap, so stacked seats never double.
   */
  async createRenewalQuote(
    organizationId: string,
    userId: string,
    licenseId: string,
  ) {
    const licence = await this.soldLicence(organizationId, licenseId);

    if (licence.status === 'cancelled') {
      throw new BadRequestException('A cancelled licence cannot be renewed');
    }

    await this.assertNoOpenFollowUp(organizationId, licenseId, 'renewal');
    const source = await this.sourceQuote(
      organizationId,
      licence.source_quote_id,
    );

    const window = renewalWindow(
      String(source.start_date),
      String(source.end_date),
      new Date().toISOString().slice(0, 10),
    );

    const quote = await this.createQuote(organizationId, userId, {
      customer_id: source.customer_id as string,
      package_id: (source.package_id as string | null) ?? undefined,
      deployment_type:
        (source.deployment_type as 'cloud' | 'onprem') ?? 'cloud',
      currency: source.currency as string,
      start_date: window.start,
      end_date: window.end,
      included_users: source.included_users as number,
      billing_period: source.billing_period as 'monthly',
      discount_cents: 0,
      tax_cents: source.tax_cents as number,
      notes: `Renewal of ${String((licence as { label?: string }).label ?? source.quote_key)}`,
      items: ((source.items ?? []) as Array<Record<string, unknown>>).map(
        (item, index) => ({
          item_type: item.item_type as 'module',
          feature_key: (item.feature_key as string | null) ?? undefined,
          label: item.label as string,
          description: (item.description as string | null) ?? undefined,
          quantity: item.quantity as number,
          unit_price_cents: item.unit_price_cents as number,
          per_period: item.per_period as boolean,
          deployment_type:
            (item.deployment_type as 'cloud' | 'onprem' | null) ?? undefined,
          sort_order: (item.sort_order as number | null) ?? index,
        }),
      ),
    } as CreateQuoteDto);

    return this.markFollowUp(
      organizationId,
      quote.id as string,
      licenseId,
      'renewal',
    );
  }

  /**
   * Draft upgrade quote: no items yet (the partner adds seats/modules), from
   * today until the licence's own end date, so the extra licence runs
   * co-terminus and stacks on top (limits sum, modules combine).
   */
  async createUpgradeQuote(
    organizationId: string,
    userId: string,
    licenseId: string,
  ) {
    const licence = await this.soldLicence(organizationId, licenseId);
    const now = Date.now();

    if (
      !['active', 'trialing', 'past_due'].includes(licence.status) ||
      (licence.ends_at && Date.parse(licence.ends_at) < now)
    ) {
      throw new BadRequestException('Only a running licence can be upgraded');
    }

    await this.assertNoOpenFollowUp(organizationId, licenseId, 'upgrade');
    const source = await this.sourceQuote(
      organizationId,
      licence.source_quote_id,
    );
    const today = new Date().toISOString().slice(0, 10);
    const end = licence.ends_at
      ? new Date(Date.parse(licence.ends_at)).toISOString().slice(0, 10)
      : String(source.end_date);

    const quote = await this.createQuote(organizationId, userId, {
      customer_id: source.customer_id as string,
      deployment_type:
        (source.deployment_type as 'cloud' | 'onprem') ?? 'cloud',
      currency: source.currency as string,
      start_date: today,
      end_date: end < today ? today : end,
      included_users: 0,
      billing_period: source.billing_period as 'monthly',
      notes: `Upgrade of ${String(source.quote_key)}`,
      items: [],
    } as unknown as CreateQuoteDto);

    return this.markFollowUp(
      organizationId,
      quote.id as string,
      licenseId,
      'upgrade',
    );
  }

  private async markFollowUp(
    organizationId: string,
    quoteId: string,
    licenseId: string,
    kind: 'renewal' | 'upgrade',
  ) {
    await this.repo.updateById(
      'partner_quotes',
      quoteId,
      { quote_kind: kind, renews_license_id: licenseId },
      organizationId,
    );

    return this.getQuote(organizationId, quoteId);
  }

  /**
   * `not_renewing`: keep the licence until its end date, drop it from renewal
   * reminders (`renew_again` undoes that). `now`: cancel immediately. The
   * customer loses what this licence granted at once (Free tier if it was the
   * only one), and its not-yet-earned commission is voided.
   */
  async cancelLicence(
    organizationId: string,
    userId: string,
    licenseId: string,
    mode: 'now' | 'not_renewing' | 'renew_again',
  ) {
    const licence = await this.soldLicence(organizationId, licenseId);
    const nowIso = new Date().toISOString();

    if (mode !== 'now') {
      const { error } = await this.repo.client
        .from('organization_licenses')
        .update({
          renewal_declined_at: mode === 'not_renewing' ? nowIso : null,
          updated_by: userId,
        })
        .eq('id', licenseId)
        .eq('partner_id', organizationId);

      if (error) throw new BadRequestException('Failed to update licence');

      return this.soldLicence(organizationId, licenseId);
    }

    if (licence.status === 'cancelled') return licence;

    const { error } = await this.repo.client
      .from('organization_licenses')
      .update({ status: 'cancelled', cancelled_at: nowIso, updated_by: userId })
      .eq('id', licenseId)
      .eq('partner_id', organizationId);

    if (error) throw new BadRequestException('Failed to cancel licence');

    // Commission not yet earned is void; earned/paid stays.
    await this.repo.client
      .from('partner_kickback_entries')
      .update({ status: 'void', updated_by: userId })
      .eq('organization_id', organizationId)
      .eq('source_type', 'license')
      .eq('source_id', licenseId)
      .eq('status', 'projected');

    await this.repo.insert('license_audit_events', {
      organization_id: licence.organization_id,
      organization_license_id: licenseId,
      actor_user_id: userId,
      event_type: 'license_cancelled_by_partner',
      event_source: 'app',
      before_data: { status: licence.status },
      after_data: { status: 'cancelled' },
    });

    this.entitlements.bust(licence.organization_id);

    return this.soldLicence(organizationId, licenseId);
  }
}
