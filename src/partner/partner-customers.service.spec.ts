/**
 * @fileoverview Unit tests for PartnerCustomersService: org-scoped lookups,
 * not-found handling, default prospect status on create, the rule that a
 * customer with no linked org returns no licenses (cross-partner isolation),
 * and the enrichment of the all-licenses feed (customer company + per-license
 * MRR amortized over the term).
 * @module src/partner/partner-customers.service.spec
 */

import { NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PartnerCustomersService } from './partner-customers.service';
import { CreateCustomerDto } from './dto/partner.dto';
import { PartnerRepository } from './partner.repository';

const ORG = 'org-1';
const USER = 'user-1';

function buildChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, jest.Mock> & {
    then: (r: (v: unknown) => unknown) => Promise<unknown>;
  } = {} as never;
  const self = () => chain;

  chain.select = jest.fn(self);
  chain.eq = jest.fn(self);
  chain.in = jest.fn(self);
  chain.order = jest.fn(self);
  chain.range = jest.fn(self);
  chain.maybeSingle = jest.fn(() => Promise.resolve(result));
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(result).then(resolve);

  return chain;
}

/** Tables the service reaches for; each gets its own chain so per-table
 *  results and `.eq` assertions stay independent. */
const TABLES = [
  'organization_licenses',
  'organizations',
  'partner_customers',
  'partner_invoices',
  'partner_leads',
  'partner_customer_addresses',
];

function setup(
  clientResult: { data: unknown; error: unknown } = { data: [], error: null },
  byTable: Record<string, { data: unknown; error: unknown }> = {},
) {
  const chains: Record<string, ReturnType<typeof buildChain>> = {};

  for (const table of TABLES) {
    chains[table] = buildChain(byTable[table] ?? clientResult);
  }

  const repo = {
    insert: jest.fn().mockResolvedValue({ id: 'cust-1' }),
    updateById: jest.fn().mockResolvedValue({ id: 'cust-1' }),
    findById: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    list: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    rpc: jest.fn().mockResolvedValue(null),
    client: {
      from: jest.fn(
        (table: string) => (chains[table] ??= buildChain(clientResult)),
      ),
    },
  } as unknown as PartnerRepository;
  const service = new PartnerCustomersService(repo);

  return { service, repo, chain: chains.organization_licenses, chains };
}

describe('PartnerCustomersService', () => {
  describe('get', () => {
    it('throws NotFound when the customer is missing', async () => {
      const { service, repo } = setup();
      (repo.findById as jest.Mock).mockResolvedValue(null);

      await expect(service.get(ORG, 'cust-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws NotFound when the customer is soft-deleted', async () => {
      const { service, repo } = setup();
      (repo.findById as jest.Mock).mockResolvedValue({
        id: 'cust-1',
        is_deleted: true,
      });

      await expect(service.get(ORG, 'cust-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // XE-T732 follow-up: addresses + VAT.
  describe('addresses', () => {
    const ADDRESS = {
      address_type: 'billing' as const,
      address_line1: 'Ring 1',
      city: 'Wien',
      postal_code: '1010',
      country: 'AT',
    };

    it('creates the customer row without addresses, then syncs them for this org', async () => {
      const { service, repo } = setup();

      await service.create(ORG, USER, {
        customer_name: 'Helena Inc',
        vat_number: 'ATU12345678',
        addresses: [ADDRESS],
      } as never);

      const row = (repo.insert as jest.Mock).mock.calls[0][1];
      expect(row).not.toHaveProperty('addresses');
      expect(row).toMatchObject({ vat_number: 'ATU12345678' });
      expect(repo.rpc).toHaveBeenCalledWith('partner_sync_customer_addresses', {
        p_customer_id: 'cust-1',
        p_org_id: ORG,
        p_user: USER,
        // a lone address becomes the primary one
        p_addresses: [{ ...ADDRESS, is_primary: true, sort_order: 0 }],
      });
    });

    it('leaves addresses untouched when the update does not send them', async () => {
      const { service, repo } = setup();
      (repo.findById as jest.Mock).mockResolvedValue({
        id: 'cust-1',
        is_deleted: false,
      });

      await service.update(ORG, USER, 'cust-1', { contact_name: 'X' } as never);

      expect(repo.rpc).not.toHaveBeenCalled();
    });

    it('clears all addresses when the update sends an empty list', async () => {
      const { service, repo } = setup();
      (repo.findById as jest.Mock).mockResolvedValue({
        id: 'cust-1',
        is_deleted: false,
      });

      await service.update(ORG, USER, 'cust-1', { addresses: [] } as never);

      const patch = (repo.updateById as jest.Mock).mock.calls[0][2];
      expect(patch).not.toHaveProperty('addresses');
      expect(repo.rpc).toHaveBeenCalledWith(
        'partner_sync_customer_addresses',
        expect.objectContaining({
          p_customer_id: 'cust-1',
          p_org_id: ORG,
          p_addresses: [],
        }),
      );
    });

    it('keeps the chosen primary among several addresses', async () => {
      const { service, repo } = setup();
      (repo.findById as jest.Mock).mockResolvedValue({
        id: 'cust-1',
        is_deleted: false,
      });

      await service.update(ORG, USER, 'cust-1', {
        addresses: [
          ADDRESS,
          { ...ADDRESS, address_type: 'shipping', is_primary: true },
        ],
      } as never);

      const sent = (repo.rpc as jest.Mock).mock.calls[0][1].p_addresses;
      expect(sent.map((a: { is_primary: boolean }) => a.is_primary)).toEqual([
        false,
        true,
      ]);
    });

    it('rejects two primary addresses and a non-ISO country in the DTO', async () => {
      const dto = plainToInstance(CreateCustomerDto, {
        customer_name: 'Helena Inc',
        addresses: [
          { ...ADDRESS, is_primary: true },
          { ...ADDRESS, country: 'Austria', is_primary: true },
        ],
      });

      const errors = await validate(dto);
      const messages = JSON.stringify(errors);

      expect(messages).toContain('Only one address can be the primary address');
      expect(messages).toContain('two-letter ISO code');
    });
  });

  describe('create', () => {
    it('defaults the customer status to prospect', async () => {
      const { service, repo } = setup();

      await service.create(ORG, USER, { customer_name: 'Helena Inc' } as never);

      expect(repo.insert).toHaveBeenCalledWith(
        'partner_customers',
        expect.objectContaining({
          customer_name: 'Helena Inc',
          organization_id: ORG,
          status: 'prospect',
        }),
      );
    });
  });

  describe('listCustomerLicenses', () => {
    it('returns an empty list when the customer has no linked org', async () => {
      const { service, repo } = setup();
      (repo.findById as jest.Mock).mockResolvedValue({
        id: 'cust-1',
        is_deleted: false,
        customer_organization_id: null,
      });

      const result = await service.listCustomerLicenses(ORG, 'cust-1');

      expect(result).toEqual([]);
      expect(repo.client.from).not.toHaveBeenCalled();
    });

    it('scopes licenses to the linked org and the calling partner', async () => {
      const license = { id: 'lic-1', status: 'active' };
      const { service, repo, chain } = setup({
        data: [license],
        error: null,
      });
      (repo.findById as jest.Mock).mockResolvedValue({
        id: 'cust-1',
        is_deleted: false,
        customer_organization_id: 'cust-org-1',
      });

      const result = await service.listCustomerLicenses(ORG, 'cust-1');

      expect(repo.client.from).toHaveBeenCalledWith('organization_licenses');
      expect(chain.eq).toHaveBeenCalledWith('organization_id', 'cust-org-1');
      expect(chain.eq).toHaveBeenCalledWith('partner_id', ORG);
      // XE-T737: enriched like the main licences list.
      expect(result[0]).toMatchObject(license);
      expect(result[0]).toHaveProperty('term_months');
      expect(result[0]).toHaveProperty('mrr_cents');
    });
  });

  // XE-T737: the customer detail page.
  describe('getDetail', () => {
    it('adds the linked org name and the partner-scoped source lead', async () => {
      const { service, repo, chains } = setup(
        { data: null, error: null },
        {
          organizations: { data: { name: 'Helena GmbH' }, error: null },
          partner_leads: {
            data: {
              id: 'lead-1',
              lead_key: 'LEAD-2026-000001',
              status: 'converted',
            },
            error: null,
          },
        },
      );
      (repo.findById as jest.Mock).mockResolvedValue({
        id: 'cust-1',
        is_deleted: false,
        customer_organization_id: 'cust-org-1',
        source_lead_id: 'lead-1',
      });

      const result = await service.getDetail(ORG, 'cust-1');

      expect(result).toMatchObject({
        id: 'cust-1',
        customer_organization_name: 'Helena GmbH',
        source_lead: { lead_key: 'LEAD-2026-000001' },
      });
      // The lead lookup must stay inside this partner's own leads.
      expect(chains.partner_leads.eq).toHaveBeenCalledWith(
        'organization_id',
        ORG,
      );
      expect(chains.partner_leads.eq).toHaveBeenCalledWith('is_deleted', false);
      // addresses are read for this customer inside this partner only
      expect(chains.partner_customer_addresses.eq).toHaveBeenCalledWith(
        'customer_id',
        'cust-1',
      );
      expect(chains.partner_customer_addresses.eq).toHaveBeenCalledWith(
        'organization_id',
        ORG,
      );
    });

    it('skips both lookups for an unlinked prospect without a lead', async () => {
      const { service, repo } = setup();
      (repo.findById as jest.Mock).mockResolvedValue({
        id: 'cust-1',
        is_deleted: false,
        customer_organization_id: null,
        source_lead_id: null,
      });

      const result = await service.getDetail(ORG, 'cust-1');

      expect(result).toMatchObject({
        customer_organization_name: null,
        source_lead: null,
      });
      expect(repo.client.from).not.toHaveBeenCalledWith('organizations');
      expect(repo.client.from).not.toHaveBeenCalledWith('partner_leads');
    });

    it("404s for another partner's or a deleted customer", async () => {
      const { service, repo } = setup();
      (repo.findById as jest.Mock).mockResolvedValue(null);

      await expect(service.getDetail(ORG, 'cust-x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('listAllLicenses', () => {
    // A 12-month term: 250000 cents / 12 months = 20833 cents/month.
    const YEAR_LICENSE = {
      id: 'lic-1',
      organization_id: 'cust-org-1',
      status: 'active',
      seats_used: 3,
      seats_purchased: 25,
      starts_at: '2026-08-01T00:00:00+00:00',
      ends_at: '2027-07-31T23:59:59+00:00',
      source_invoice_id: 'inv-1',
    };

    function setupLicenses(
      licenses: unknown[],
      overrides: Record<string, { data: unknown; error: unknown }> = {},
    ) {
      return setup(
        { data: [], error: null },
        {
          organization_licenses: { data: licenses, error: null },
          organizations: {
            data: [{ id: 'cust-org-1', name: 'Port Acme' }],
            error: null,
          },
          partner_customers: { data: [], error: null },
          partner_invoices: {
            data: [{ id: 'inv-1', total_cents: 250000, currency: 'EUR' }],
            error: null,
          },
          ...overrides,
        },
      );
    }

    it('scopes the feed to the calling partner', async () => {
      const { service, chain } = setupLicenses([YEAR_LICENSE]);

      await service.listAllLicenses(ORG, {});

      expect(chain.eq).toHaveBeenCalledWith('partner_id', ORG);
    });

    it('enriches rows with the customer company, seats and amortized MRR', async () => {
      const { service } = setupLicenses([YEAR_LICENSE]);

      const [row] = await service.listAllLicenses(ORG, {});

      expect(row).toMatchObject({
        customer_company: 'Port Acme',
        term_months: 12,
        mrr_cents: 20833,
        currency: 'EUR',
        seats_used: 3,
        seats_purchased: 25,
        ends_at: '2027-07-31T23:59:59+00:00',
      });
    });

    it('reports no MRR for an open-ended license instead of booking the whole invoice as one month', async () => {
      const { service } = setupLicenses([{ ...YEAR_LICENSE, ends_at: null }]);

      const [row] = await service.listAllLicenses(ORG, {});

      expect(row.term_months).toBeNull();
      expect(row.mrr_cents).toBeNull();
    });

    it('reports no MRR when the license has no source invoice', async () => {
      const { service } = setupLicenses([
        { ...YEAR_LICENSE, source_invoice_id: null },
      ]);

      const [row] = await service.listAllLicenses(ORG, {});

      expect(row.mrr_cents).toBeNull();
      expect(row.currency).toBeNull();
    });

    it('falls back to the CRM customer name when the linked org is unresolved', async () => {
      const { service } = setupLicenses([YEAR_LICENSE], {
        organizations: { data: [], error: null },
        partner_customers: {
          data: [
            {
              customer_organization_id: 'cust-org-1',
              customer_name: 'Acme (CRM)',
            },
          ],
          error: null,
        },
      });

      const [row] = await service.listAllLicenses(ORG, {});

      expect(row.customer_company).toBe('Acme (CRM)');
    });

    // XE-T733: the renewal list links each licence to its customer page.
    it('carries the CRM customer id for the licence org, or null without one', async () => {
      const linked = setupLicenses([YEAR_LICENSE], {
        partner_customers: {
          data: [
            {
              id: 'cust-1',
              customer_organization_id: 'cust-org-1',
              customer_name: 'Acme',
            },
          ],
          error: null,
        },
      });
      const [row] = await linked.service.listAllLicenses(ORG, {});
      expect(row.customer_id).toBe('cust-1');

      const unlinked = setupLicenses([YEAR_LICENSE], {
        partner_customers: { data: [], error: null },
      });
      const [orphan] = await unlinked.service.listAllLicenses(ORG, {});
      expect(orphan.customer_id).toBeNull();
    });

    it('scopes the invoice lookup to the calling partner', async () => {
      const { service, chains } = setupLicenses([YEAR_LICENSE]);

      await service.listAllLicenses(ORG, {});

      expect(chains.partner_invoices.eq).toHaveBeenCalledWith(
        'organization_id',
        ORG,
      );
      expect(chains.partner_invoices.in).toHaveBeenCalledWith('id', ['inv-1']);
    });

    it('leaves the feed unpaginated when no page is requested', async () => {
      const { service, chain } = setupLicenses([YEAR_LICENSE]);

      await service.listAllLicenses(ORG, {});

      expect(chain.range).not.toHaveBeenCalled();
    });

    it('paginates when asked and caps the page size at 100', async () => {
      const { service, chain } = setupLicenses([YEAR_LICENSE]);

      await service.listAllLicenses(ORG, { page: 2, pageSize: 500 });

      expect(chain.range).toHaveBeenCalledWith(100, 199);
    });
  });
});
