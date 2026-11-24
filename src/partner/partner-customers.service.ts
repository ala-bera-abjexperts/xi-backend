/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- dynamically-typed Supabase rows via the generic partner repository */
/**
 * @fileoverview Sub-ticket 4 (customers) - the partner's customer records and a
 * read-only view of their customers' licenses. Licenses are read straight from
 * organization_licenses, code-scoped to partner_id = the caller's org so a
 * partner can never see another partner's (or unrelated) licenses.
 * @module src/partner/partner-customers.service
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InvitationsService } from '../invitations/invitations.service';
import { PartnerRepository } from './partner.repository';
import type {
  CreateCustomerDto,
  ProvisionCustomerOrgDto,
  UpdateCustomerDto,
} from './dto/partner.dto';

const MS_PER_DAY = 86_400_000;
const AVG_DAYS_PER_MONTH = 30.437;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** A license row enriched for the "active licenses" list view. */
export interface PartnerLicenseListRow {
  [key: string]: unknown;
  /** organizations.name of the customer, falling back to the CRM record's name. */
  customer_company: string | null;
  /** Whole months of the license term; null when the term is open-ended. */
  term_months: number | null;
  /** Source invoice total amortized over the term; null when not computable. */
  mrr_cents: number | null;
  currency: string | null;
  /** The partner's CRM customer for this licence's org, when there is one. */
  customer_id: string | null;
}

@Injectable()
export class PartnerCustomersService {
  constructor(
    private readonly repo: PartnerRepository,
    // Optional so focused unit tests can build the service without it.
    @Optional() private readonly invitations?: InvitationsService,
  ) {}

  /**
   * C1 guard: a partner may only link a customer record to an organization it is
   * authorised to sell to (an accepted+linked lead, or an existing partner-sold
   * licence). `customer_organization_id` arrives from the client, and
   * `partner_convert_quote` later writes an `organization_licenses` row AND
   * entitlement overrides onto that org - so an unvalidated value is a
   * cross-tenant entitlement injection.
   *
   * A BEFORE trigger on `partner_customers` enforces the same rule, and
   * `partner_convert_quote` re-checks it: the repository uses the service-role
   * client, so RLS cannot be the boundary here. This check exists so the caller
   * gets a typed 403 instead of a raw Postgres `insufficient_privilege` 500.
   *
   * @throws {ForbiddenException} when the partner has no authorising relation.
   */
  private async assertCanSellTo(
    organizationId: string,
    customerOrganizationId: string | null | undefined,
  ): Promise<void> {
    // A prospect with no linked org is harmless - conversion rejects it anyway.
    if (!customerOrganizationId) {
      return;
    }

    const allowed = await this.repo.rpc<boolean>('partner_can_sell_to', {
      p_partner_org: organizationId,
      p_customer_org: customerOrganizationId,
    });

    if (allowed !== true) {
      throw new ForbiddenException(
        'Not authorised to link this organization as a customer. An accepted lead for this organization is required first.',
      );
    }
  }

  /**
   * The organizations this partner is allowed to link a customer record to.
   *
   * This is the discoverable half of {@link assertCanSellTo}. The rule lived only
   * in a Postgres function and a BEFORE trigger, so the UI had no way to offer a
   * choice: it rendered `customer_organization_id` as a free-text box and the
   * partner learned which values were legal by pasting a UUID and reading a 403.
   *
   * Mirrors the two branches of `partner_can_sell_to` exactly — an accepted or
   * converted linked lead, or an already partner-sold licence. It therefore
   * widens nothing: every id returned here would already have passed the guard.
   *
   * @param organizationId - The calling partner org
   * @returns Linkable organizations with the id of the customer record already
   *   using each one, so the caller can mark those as taken instead of failing on save.
   */
  async listLinkableOrganizations(organizationId: string): Promise<
    {
      id: string;
      name: string | null;
      slug: string | null;
      linked_customer_id: string | null;
    }[]
  > {
    const [leads, licences] = await Promise.all([
      this.repo.client
        .from('partner_leads')
        .select('customer_organization_id')
        .eq('organization_id', organizationId)
        .in('status', ['accepted', 'converted'])
        .eq('is_deleted', false)
        .not('customer_organization_id', 'is', null),
      this.repo.client
        .from('organization_licenses')
        .select('organization_id')
        .eq('partner_id', organizationId),
    ]);

    const orgIds = [
      ...new Set(
        [
          ...((leads.data ?? []) as any[]).map(
            (l) => l.customer_organization_id,
          ),
          ...((licences.data ?? []) as any[]).map((l) => l.organization_id),
        ]
          .filter(Boolean)
          .map(String),
      ),
    ];

    if (!orgIds.length) {
      return [];
    }

    const [orgs, taken] = await Promise.all([
      this.repo.client
        .from('organizations')
        .select('id,name,slug')
        .in('id', orgIds),
      this.repo.client
        .from('partner_customers')
        .select('id,customer_organization_id')
        .eq('organization_id', organizationId)
        .eq('is_deleted', false)
        .in('customer_organization_id', orgIds),
    ]);

    const takenBy = new Map<string, string>(
      ((taken.data ?? []) as any[]).map((c) => [
        String(c.customer_organization_id),
        String(c.id),
      ]),
    );

    return ((orgs.data ?? []) as any[])
      .map((o) => ({
        id: String(o.id),
        name: (o.name as string | null) ?? null,
        slug: (o.slug as string | null) ?? null,
        linked_customer_id: takenBy.get(String(o.id)) ?? null,
      }))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  }

  async list(
    organizationId: string,
    filters: {
      status?: string;
      search?: string;
      page?: number;
      pageSize?: number;
    },
  ) {
    const result = await this.repo.list('partner_customers', {
      page: filters.page,
      pageSize: filters.pageSize,
      filters: {
        organization_id: organizationId,
        is_deleted: false,
        ...(filters.status ? { status: filters.status } : {}),
      },
      search: filters.search
        ? { column: 'customer_name', term: filters.search }
        : undefined,
    });

    // Name each linked workspace here, so view-only partner users see it too
    // (the page used to fetch names through a manage-only endpoint).
    const orgIds = [
      ...new Set(
        (result.data as Array<{ customer_organization_id?: string | null }>)
          .map((r) => r.customer_organization_id)
          .filter((id): id is string => !!id),
      ),
    ];
    const names = new Map<string, string>();

    if (orgIds.length > 0) {
      const { data } = await this.repo.client
        .from('organizations')
        .select('id, name')
        .in('id', orgIds);

      for (const o of (data ?? []) as { id: string; name: string }[]) {
        names.set(o.id, o.name);
      }
    }

    return {
      ...result,
      data: (result.data as Array<Record<string, unknown>>).map((r) => ({
        ...r,
        customer_organization_name: r.customer_organization_id
          ? (names.get(r.customer_organization_id as string) ?? null)
          : null,
      })),
    };
  }

  async get(organizationId: string, customerId: string) {
    const row = await this.repo.findById(
      'partner_customers',
      customerId,
      organizationId,
    );
    if (!row || row.is_deleted) {
      throw new NotFoundException('Customer not found');
    }

    return row;
  }

  async create(organizationId: string, userId: string, dto: CreateCustomerDto) {
    const { addresses, ...row } = dto;
    await this.assertCanSellTo(organizationId, row.customer_organization_id);

    const created = await this.repo.insert('partner_customers', {
      ...row,
      organization_id: organizationId,
      status: row.status ?? 'prospect',
      created_by: userId,
      updated_by: userId,
    });

    if (addresses !== undefined) {
      await this.syncAddresses(
        organizationId,
        userId,
        created.id as string,
        addresses,
      );
    }

    return created;
  }

  /**
   * Replace a customer's addresses in one transaction (DB function, XE-T732
   * follow-up). The function re-checks that the customer belongs to this partner.
   * A lone address is made primary so there is always one to show first.
   */
  private async syncAddresses(
    organizationId: string,
    userId: string,
    customerId: string,
    addresses: NonNullable<CreateCustomerDto['addresses']>,
  ) {
    const rows = addresses.map((a, index) => ({
      ...a,
      is_primary: addresses.length === 1 ? true : a.is_primary === true,
      sort_order: index,
    }));

    await this.repo.rpc('partner_sync_customer_addresses', {
      p_customer_id: customerId,
      p_org_id: organizationId,
      p_user: userId,
      p_addresses: rows,
    });
  }

  async update(
    organizationId: string,
    userId: string,
    customerId: string,
    dto: UpdateCustomerDto,
  ) {
    await this.get(organizationId, customerId);
    const { addresses, ...patch } = dto;
    // Re-check on update: the org link can be introduced or repointed here.
    await this.assertCanSellTo(organizationId, patch.customer_organization_id);

    const updated = await this.repo.updateById(
      'partner_customers',
      customerId,
      { ...patch, updated_by: userId },
      organizationId,
    );

    if (addresses !== undefined) {
      await this.syncAddresses(organizationId, userId, customerId, addresses);
    }

    return updated;
  }

  async remove(organizationId: string, userId: string, customerId: string) {
    await this.get(organizationId, customerId);
    await this.repo.updateById(
      'partner_customers',
      customerId,
      {
        is_deleted: true,
        deleted_at: new Date().toISOString(),
        deleted_by: userId,
      },
      organizationId,
    );

    return { success: true };
  }

  /** Licenses of ONE customer (only if that customer belongs to this partner). */
  async listCustomerLicenses(organizationId: string, customerId: string) {
    const customer = await this.get(organizationId, customerId);
    if (!customer.customer_organization_id) {
      return [];
    }

    const { data, error } = await this.repo.client
      .from('organization_licenses')
      .select('*')
      .eq('organization_id', customer.customer_organization_id)
      .eq('partner_id', organizationId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new NotFoundException(error.message);
    }

    // XE-T737: same shape as the main licences list (term, MRR, company).
    return this.enrichLicenses(organizationId, data ?? []);
  }

  /**
   * XE-T737: one customer for the detail page - the CRM row plus the linked
   * organization's name and the lead it came from. Both lookups are keyed by ids
   * on a row already scoped to this partner; the lead is re-scoped to the
   * partner's own leads, so nothing outside the partner's boundary is read.
   */
  async getDetail(organizationId: string, customerId: string) {
    const customer = await this.get(organizationId, customerId);

    const [org, lead, addresses] = await Promise.all([
      customer.customer_organization_id
        ? this.repo.client
            .from('organizations')
            .select('name')
            .eq('id', customer.customer_organization_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      customer.source_lead_id
        ? this.repo.client
            .from('partner_leads')
            .select('id, lead_key, status, customer_company_name, submitted_at')
            .eq('id', customer.source_lead_id)
            .eq('organization_id', organizationId)
            .eq('is_deleted', false)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      this.repo.client
        .from('partner_customer_addresses')
        .select(
          'id, address_type, is_primary, address_line1, address_line2, city, postal_code, state, country, sort_order',
        )
        .eq('customer_id', customerId)
        .eq('organization_id', organizationId)
        .order('is_primary', { ascending: false })
        .order('sort_order', { ascending: true }),
    ]);

    return {
      ...customer,
      customer_organization_name:
        (org.data as { name?: string } | null)?.name ?? null,
      source_lead: lead.data ?? null,
      addresses: addresses.data ?? [],
    };
  }

  /**
   * Whole months in a license term.
   *
   * Returns null for an open-ended (`ends_at IS NULL`) license: there is no term
   * to amortize over, and collapsing it to "1" would book the entire invoice as a
   * single month of revenue - a silent MRR inflation.
   */
  private termMonths(startsAt: unknown, endsAt: unknown): number | null {
    if (!startsAt || !endsAt) {
      return null;
    }

    const start = new Date(String(startsAt)).getTime();
    const end = new Date(String(endsAt)).getTime();

    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return null;
    }

    // Terms are sold in whole months but stored as instants (a 12-month term ends
    // at 23:59:59 on the last day), so round the day span to the nearest month.
    return Math.max(
      1,
      Math.round((end - start) / MS_PER_DAY / AVG_DAYS_PER_MONTH),
    );
  }

  /**
   * Adds the customer company name and a per-license MRR to license rows.
   *
   * The `organizations` / `partner_invoices` lookups are keyed by ids taken from
   * rows already scoped to `partner_id = organizationId`, so this resolves labels
   * for records the partner can already see - it does not widen the boundary. The
   * `partner_customers` fallback is scoped to the partner's own CRM records.
   */
  private async enrichLicenses(
    organizationId: string,
    licenses: any[],
  ): Promise<PartnerLicenseListRow[]> {
    const unique = (values: unknown[]): string[] => [
      ...new Set(values.filter(Boolean).map(String)),
    ];

    const customerOrgIds = unique(licenses.map((l) => l.organization_id));
    const invoiceIds = unique(licenses.map((l) => l.source_invoice_id));

    const [orgs, customers, invoices] = await Promise.all([
      customerOrgIds.length
        ? this.repo.client
            .from('organizations')
            .select('id,name')
            .in('id', customerOrgIds)
        : Promise.resolve({ data: [] }),
      this.repo.client
        .from('partner_customers')
        .select('id,customer_organization_id,customer_name')
        .eq('organization_id', organizationId)
        .eq('is_deleted', false),
      invoiceIds.length
        ? this.repo.client
            .from('partner_invoices')
            .select('id,total_cents,currency')
            .eq('organization_id', organizationId)
            .in('id', invoiceIds)
        : Promise.resolve({ data: [] }),
    ]);

    const orgNameById = new Map<string, string>(
      ((orgs.data ?? []) as any[]).map((o) => [String(o.id), o.name as string]),
    );
    const crmNameByOrgId = new Map<string, string>(
      ((customers.data ?? []) as any[])
        .filter((c) => c.customer_organization_id)
        .map((c) => [
          String(c.customer_organization_id),
          c.customer_name as string,
        ]),
    );
    // XE-T733: lets the renewal list link straight to the customer page.
    const crmIdByOrgId = new Map<string, string>(
      ((customers.data ?? []) as any[])
        .filter((c) => c.customer_organization_id && c.id)
        .map((c) => [String(c.customer_organization_id), String(c.id)]),
    );
    const invoiceById = new Map<string, any>(
      ((invoices.data ?? []) as any[]).map((i) => [String(i.id), i]),
    );

    return licenses.map((license) => {
      const orgId = String(license.organization_id ?? '');
      const invoice = license.source_invoice_id
        ? invoiceById.get(String(license.source_invoice_id))
        : undefined;
      const months = this.termMonths(license.starts_at, license.ends_at);

      return {
        ...license,
        customer_company:
          orgNameById.get(orgId) ?? crmNameByOrgId.get(orgId) ?? null,
        customer_id: crmIdByOrgId.get(orgId) ?? null,
        term_months: months,
        mrr_cents:
          invoice && months
            ? Math.round(Number(invoice.total_cents ?? 0) / months)
            : null,
        currency: invoice ? ((invoice.currency as string) ?? null) : null,
      };
    });
  }

  /**
   * All licenses this partner sold/manages (the "active licenses" list feed),
   * enriched with the customer company and a per-license MRR.
   *
   * Pagination is opt-in - the on-prem install dialog reads the whole list as a
   * picker source - but is capped at 100 rows per page like every other partner
   * list.
   */
  async listAllLicenses(
    organizationId: string,
    filters: { activeOnly?: boolean; page?: number; pageSize?: number },
  ): Promise<PartnerLicenseListRow[]> {
    let query = this.repo.client
      .from('organization_licenses')
      .select('*')
      .eq('partner_id', organizationId);

    if (filters.activeOnly) {
      query = query.eq('status', 'active');
    }

    query = query.order('ends_at', { ascending: true });

    if (filters.page !== undefined || filters.pageSize !== undefined) {
      const page = Math.max(1, filters.page ?? 1);
      const pageSize = Math.min(
        filters.pageSize ?? DEFAULT_PAGE_SIZE,
        MAX_PAGE_SIZE,
      );
      const from = (page - 1) * pageSize;

      query = query.range(from, from + pageSize - 1);
    }

    // NOTE: the branch above is currently unreachable — partner-customers.controller.ts
    // does not forward page/pageSize, so this feed is always unpaginated and is
    // therefore subject to PostgREST's 1000-row cap.
    //
    // Left as-is ON PURPOSE. `PartnerCustomersService › listAllLicenses › leaves
    // the feed unpaginated when no page is requested` asserts this contract
    // deliberately, and partner licence volumes are nowhere near 1000, so the
    // truncation is theoretical here. Forcing DEFAULT_PAGE_SIZE (20) would cut
    // every current caller from "all licences" to 20 rows — a real regression
    // traded for a hypothetical one. Paginating this properly means changing the
    // controller, this service and the consuming UI together, which is a
    // deliberate follow-up rather than a drive-by.

    const { data, error } = await query;
    if (error) {
      throw new NotFoundException(error.message);
    }

    const licenses = data ?? [];
    if (!licenses.length) {
      return [];
    }

    return this.enrichLicenses(organizationId, licenses);
  }

  /**
   * Creates a NEW workspace (organization) for one of this partner's customers,
   * links it to the customer, and invites the customer's owner. The partner is
   * authorised to sell to an org it created (provisioned_by_partner_id), so the
   * customer can be quoted and licensed straight away. A new org starts on the
   * Free tier until a licence is sold.
   */
  async provisionOrg(
    organizationId: string,
    userId: string,
    customerId: string,
    dto: ProvisionCustomerOrgDto,
  ) {
    const customer = await this.repo.findById(
      'partner_customers',
      customerId,
      organizationId,
    );

    if (!customer || customer.is_deleted) {
      throw new NotFoundException('Customer not found');
    }
    if (customer.customer_organization_id) {
      throw new ConflictException(
        'This customer already has a linked workspace',
      );
    }

    const { data: taken } = await this.repo.client
      .from('organizations')
      .select('id')
      .eq('slug', dto.slug)
      .maybeSingle();

    if (taken) {
      throw new ConflictException(`The address "${dto.slug}" is already taken`);
    }

    const { data: org, error: orgError } = await this.repo.client
      .from('organizations')
      .insert({
        name: dto.org_name.trim(),
        slug: dto.slug,
        size: 'small',
        is_active: true,
        provisioned_by_partner_id: organizationId,
      })
      .select('id, name, slug')
      .single();

    if (orgError || !org) {
      throw new BadRequestException(
        orgError?.message ?? 'Failed to create the workspace',
      );
    }

    const created = org as { id: string; name: string; slug: string };

    try {
      await this.repo.updateById(
        'partner_customers',
        customerId,
        { customer_organization_id: created.id, updated_by: userId },
        organizationId,
      );
    } catch (err) {
      // Compensate: never leave an orphan org behind a failed link.
      await this.repo.client
        .from('organizations')
        .delete()
        .eq('id', created.id);
      throw err;
    }

    let invited = false;

    if (this.invitations) {
      try {
        await this.invitations.createOrgInvitation({
          email: dto.owner_email.trim().toLowerCase(),
          firstName: dto.owner_first_name ?? '',
          lastName: dto.owner_last_name ?? '',
          organizationId: created.id,
          role: 'owner',
          invitedByUserId: userId,
        });
        invited = true;
      } catch {
        // The workspace exists and is linked; the invite can be re-sent.
        invited = false;
      }
    }

    return { organization: created, owner_invited: invited };
  }
}
