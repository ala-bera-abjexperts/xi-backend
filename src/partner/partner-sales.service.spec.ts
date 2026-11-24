/**
 * @fileoverview Unit tests for PartnerSalesService: package-item defaulting
 * (regression for the per_period NOT-NULL bug), quote total computation incl.
 * discount lines, the quote state machine, convert-to-license RPC + entitlements
 * cache bust, and the invoice paid_at clearing rule. Also pins the customer-accept
 * governance rule: only the customer org can accept, and convert refuses anything
 * the customer org did not accept itself.
 * @module src/partner/partner-sales.service.spec
 */

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PartnerSalesService } from './partner-sales.service';
import { PackageItemDto, UpsertPartnerListingDto } from './dto/partner.dto';
import { PartnerRepository } from './partner.repository';
import { EntitlementsService } from '../licensing/entitlements.service';

const ORG = 'org-1';
const USER = 'user-1';

function buildChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, jest.Mock> = {};
  const self = () => chain;

  chain.select = jest.fn(self);
  chain.eq = jest.fn(self);
  chain.delete = jest.fn(self);
  chain.maybeSingle = jest.fn(() => Promise.resolve(result));

  return chain;
}

/**
 * partner_resellable_items lookup (XE-T738). By default every requested key is
 * on the price list as a module; pass `offered` to narrow it.
 */
function priceListChain(
  offered?: Array<{ feature_key: string; item_type: string }>,
) {
  const chain: Record<string, jest.Mock> = {};
  chain.select = jest.fn(() => chain);
  chain.eq = jest.fn(() => chain);
  chain.in = jest.fn((_col: string, keys: string[]) =>
    Promise.resolve({
      data:
        offered ?? keys.map((k) => ({ feature_key: k, item_type: 'module' })),
      error: null,
    }),
  );
  return chain;
}

function setup() {
  const chain = buildChain({ data: null, error: null });
  const priceList = priceListChain();
  const repo = {
    insert: jest.fn().mockResolvedValue({ id: 'created-1' }),
    insertMany: jest.fn().mockResolvedValue([]),
    updateById: jest.fn().mockResolvedValue({ id: 'updated-1' }),
    findById: jest.fn(),
    findOne: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    list: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    rpc: jest.fn(),
    client: {
      from: jest.fn((table: string) =>
        table === 'partner_resellable_items' ? priceList : chain,
      ),
    },
  } as unknown as PartnerRepository;
  const entitlements = { bust: jest.fn() } as unknown as EntitlementsService;
  const service = new PartnerSalesService(repo, entitlements);

  return { service, repo, entitlements };
}

describe('PartnerSalesService', () => {
  describe('createPackage', () => {
    it('defaults per_period, quantity and unit_price_cents on package items', async () => {
      const { service, repo } = setup();
      (repo.findById as jest.Mock).mockResolvedValue({
        id: 'created-1',
        is_deleted: false,
      });

      await service.createPackage(ORG, USER, {
        package_key: 'growth_cloud_2026',
        name: 'Growth Cloud Bundle 2026',
        items: [
          {
            item_type: 'module',
            feature_key: 'module_risk',
            label: 'Risk module',
          },
        ],
      } as never);

      const rows = (repo.insertMany as jest.Mock).mock.calls[0][1];

      expect(repo.insertMany).toHaveBeenCalledWith(
        'partner_license_package_items',
        expect.any(Array),
      );
      expect(rows[0]).toMatchObject({
        item_type: 'module',
        feature_key: 'module_risk',
        quantity: 1,
        unit_price_cents: 0,
        per_period: true,
        sort_order: 0,
      });
      expect(rows[0].per_period).not.toBeUndefined();
    });

    // XE-T740: a failed item insert used to leave an empty package behind,
    // so every retry with the same key hit the unique index (409).
    it('removes the package again when its items cannot be inserted', async () => {
      const { service, repo } = setup();
      const deleteById = jest.fn().mockResolvedValue(undefined);
      Object.assign(repo, { deleteById });
      (repo.insertMany as jest.Mock).mockRejectedValue(
        new BadRequestException('violates check constraint'),
      );

      await expect(
        service.createPackage(ORG, USER, {
          package_key: 'paket01',
          name: 'PAKET01',
          items: [
            {
              item_type: 'module',
              feature_key: 'module_tasks',
              label: 'Tasks',
            },
          ],
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(deleteById).toHaveBeenCalledWith(
        'partner_license_packages',
        'created-1',
        ORG,
      );
    });

    // XE-T738: rows come from the XISUITE price list.
    it('requires a price-list module on every module row', async () => {
      const { service, repo } = setup();

      await expect(
        service.createPackage(ORG, USER, {
          package_key: 'p1',
          name: 'P1',
          items: [{ item_type: 'module', label: 'Free text' }],
        } as never),
      ).rejects.toThrow('Pick a module from the price list');
      expect(repo.insert).not.toHaveBeenCalled();
    });

    it('rejects a key offered under a different type', async () => {
      const { service, repo } = setup();
      const priceList = priceListChain([
        { feature_key: 'limit_users', item_type: 'user_seat' },
      ]);
      (repo.client.from as jest.Mock).mockImplementation(() => priceList);

      await expect(
        service.createPackage(ORG, USER, {
          package_key: 'p1',
          name: 'P1',
          items: [
            { item_type: 'addon', feature_key: 'limit_users', label: 'Seats' },
          ],
        } as never),
      ).rejects.toThrow('not on the XISUITE price list as addon');
      expect(repo.insert).not.toHaveBeenCalled();
    });

    it('allows a key-less addon row without a price-list lookup', async () => {
      const { service, repo } = setup();
      (repo.findById as jest.Mock).mockResolvedValue({
        id: 'created-1',
        is_deleted: false,
      });

      await service.createPackage(ORG, USER, {
        package_key: 'p1',
        name: 'P1',
        items: [{ item_type: 'addon', label: 'Onboarding workshop' }],
      } as never);

      expect(repo.client.from).not.toHaveBeenCalledWith(
        'partner_resellable_items',
      );
      expect(repo.insert).toHaveBeenCalled();
    });
  });

  describe('updatePackage', () => {
    function withExistingItems(repo: PartnerRepository) {
      (repo.findById as jest.Mock).mockResolvedValue({
        id: 'pkg-1',
        is_deleted: false,
      });
      (repo.findMany as jest.Mock).mockResolvedValue([
        { id: 'old-1' },
        { id: 'old-2' },
      ]);
    }

    it('keeps the old items when inserting the new set fails', async () => {
      const { service, repo } = setup();
      withExistingItems(repo);
      (repo.insertMany as jest.Mock).mockRejectedValue(
        new BadRequestException('bad item'),
      );

      await expect(
        service.updatePackage(ORG, USER, 'pkg-1', {
          items: [
            {
              item_type: 'module',
              feature_key: 'module_tasks',
              label: 'Tasks',
            },
          ],
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(repo.client.from).not.toHaveBeenCalledWith(
        'partner_license_package_items',
      );
    });

    it('rejects a module that is not on the XISUITE price list before writing', async () => {
      const { service, repo } = setup();
      withExistingItems(repo);
      const priceList = priceListChain([]);
      (repo.client.from as jest.Mock).mockImplementation(() => priceList);

      await expect(
        service.updatePackage(ORG, USER, 'pkg-1', {
          items: [
            { item_type: 'module', feature_key: 'module_risk', label: 'Risk' },
          ],
        } as never),
      ).rejects.toThrow('not on the XISUITE price list');

      expect(repo.updateById).not.toHaveBeenCalled();
      expect(repo.insertMany).not.toHaveBeenCalled();
    });

    it('deletes exactly the previous items after the new set is stored', async () => {
      const { service, repo } = setup();
      withExistingItems(repo);
      const chain = buildChain({ data: null, error: null });
      chain.in = jest.fn(() => chain);
      chain.eq = jest.fn(() => chain);
      (chain as unknown as { then: unknown }).then = (
        resolve: (v: unknown) => void,
      ) => resolve({ error: null });
      const priceList = priceListChain();
      (repo.client.from as jest.Mock).mockImplementation((table: string) =>
        table === 'partner_resellable_items' ? priceList : chain,
      );

      await service.updatePackage(ORG, USER, 'pkg-1', {
        items: [
          { item_type: 'module', feature_key: 'module_wiki', label: 'Wiki' },
        ],
      } as never);

      const insertOrder = (repo.insertMany as jest.Mock).mock
        .invocationCallOrder[0];
      const deleteOrder = chain.delete.mock.invocationCallOrder[0];
      expect(insertOrder).toBeLessThan(deleteOrder);
      expect(chain.in).toHaveBeenCalledWith('id', ['old-1', 'old-2']);
      expect(chain.eq).toHaveBeenCalledWith('organization_id', ORG);
    });
  });

  describe('PackageItemDto.feature_key', () => {
    async function errorsFor(feature_key: string) {
      const dto = plainToInstance(PackageItemDto, {
        item_type: 'module',
        label: 'x',
        feature_key,
      });
      return (await validate(dto)).filter((e) => e.property === 'feature_key');
    }

    it.each(['module_tasks', 'limit_users'])('accepts %s', async (key) => {
      expect(await errorsFor(key)).toHaveLength(0);
    });

    it.each(['tasks', 'Module_tasks', 'module_partners', 'feature_sso'])(
      'rejects %s',
      async (key) => {
        expect(await errorsFor(key)).toHaveLength(1);
      },
    );
  });

  describe('createQuote', () => {
    const baseDto = {
      customer_id: 'cust-1',
      start_date: '2026-07-01',
      end_date: '2027-06-30',
      tax_cents: 16625,
      items: [
        {
          item_type: 'module',
          feature_key: 'module_portfolios',
          label: 'Portfolio',
          quantity: 1,
          unit_price_cents: 0,
        },
        {
          item_type: 'user_seat',
          feature_key: 'limit_users',
          label: 'Seats',
          quantity: 25,
          unit_price_cents: 1500,
        },
        {
          item_type: 'addon',
          feature_key: 'module_site_studio',
          label: 'Site Studio',
          quantity: 1,
          unit_price_cents: 50000,
        },
        {
          item_type: 'discount',
          label: 'Loyalty discount',
          quantity: 1,
          unit_price_cents: -7500,
        },
      ],
    };

    it('rejects an end_date before the start_date', async () => {
      const { service, repo } = setup();
      (repo.findById as jest.Mock).mockResolvedValue({ id: 'cust-1' });

      await expect(
        service.createQuote(ORG, USER, {
          ...baseDto,
          start_date: '2027-01-01',
          end_date: '2026-01-01',
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a quote for a customer not owned by this partner', async () => {
      const { service, repo } = setup();
      (repo.findById as jest.Mock).mockResolvedValue(null);

      await expect(
        service.createQuote(ORG, USER, baseDto as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('computes subtotal (excluding discounts), discount, and total', async () => {
      const { service, repo } = setup();
      (repo.findById as jest.Mock).mockImplementation((table: string) =>
        table === 'partner_customers'
          ? { id: 'cust-1' }
          : { id: 'created-1', is_deleted: false, customer_id: 'cust-1' },
      );

      await service.createQuote(ORG, USER, baseDto as never);

      expect(repo.insert).toHaveBeenCalledWith(
        'partner_quotes',
        expect.objectContaining({
          subtotal_cents: 87500,
          discount_cents: 7500,
          tax_cents: 16625,
          total_cents: 96625,
        }),
      );
    });
  });

  describe('transitionQuote', () => {
    it('rejects sending a quote that is already accepted', async () => {
      const { service, repo } = setup();
      (repo.findById as jest.Mock).mockResolvedValue({
        id: 'quote-1',
        status: 'accepted',
        is_deleted: false,
      });

      await expect(
        service.transitionQuote(ORG, USER, 'quote-1', 'send'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('sends a draft quote for a customer linked to an organization', async () => {
      const { service, repo } = setup();
      (repo.findById as jest.Mock).mockImplementation((table: string) =>
        table === 'partner_customers'
          ? { id: 'cust-1', customer_organization_id: 'cust-org-1' }
          : {
              id: 'quote-1',
              status: 'draft',
              is_deleted: false,
              customer_id: 'cust-1',
            },
      );

      await service.transitionQuote(ORG, USER, 'quote-1', 'send');

      expect(repo.updateById).toHaveBeenCalledWith(
        'partner_quotes',
        'quote-1',
        expect.objectContaining({ status: 'sent' }),
        ORG,
      );
    });

    it('refuses to send a quote for an unlinked prospect (nobody could accept it)', async () => {
      const { service, repo } = setup();
      (repo.findById as jest.Mock).mockImplementation((table: string) =>
        table === 'partner_customers'
          ? { id: 'cust-1', customer_organization_id: null }
          : {
              id: 'quote-1',
              status: 'draft',
              is_deleted: false,
              customer_id: 'cust-1',
            },
      );

      await expect(
        service.transitionQuote(ORG, USER, 'quote-1', 'send'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.updateById).not.toHaveBeenCalled();
    });
  });

  describe('convertQuote', () => {
    /** A quote the customer org has accepted - the only convertible shape. */
    function customerAccepted() {
      return (table: string) =>
        table === 'partner_customers'
          ? { id: 'cust-1', customer_organization_id: 'cust-org-1' }
          : {
              id: 'quote-1',
              is_deleted: false,
              customer_id: 'cust-1',
              status: 'accepted',
              accepted_by_organization_id: 'cust-org-1',
            };
    }

    it('calls the convert RPC and busts the customer org entitlements cache', async () => {
      const { service, repo, entitlements } = setup();
      (repo.findById as jest.Mock).mockImplementation(customerAccepted());
      (repo.rpc as jest.Mock).mockResolvedValue({
        invoice_id: 'inv-1',
        license_id: 'lic-1',
        already_converted: false,
      });

      const result = await service.convertQuote(ORG, USER, 'quote-1');

      expect(repo.rpc).toHaveBeenCalledWith('partner_convert_quote', {
        p_quote_id: 'quote-1',
        p_actor: USER,
      });
      expect(entitlements.bust).toHaveBeenCalledWith('cust-org-1');
      expect(result).toEqual({
        invoice_id: 'inv-1',
        license_id: 'lic-1',
        already_converted: false,
      });
    });

    it('refuses a quote the customer has not accepted', async () => {
      const { service, repo } = setup();
      (repo.findById as jest.Mock).mockImplementation((table: string) =>
        table === 'partner_customers'
          ? { id: 'cust-1', customer_organization_id: 'cust-org-1' }
          : {
              id: 'quote-1',
              is_deleted: false,
              customer_id: 'cust-1',
              status: 'sent',
              accepted_by_organization_id: null,
            },
      );

      await expect(
        service.convertQuote(ORG, USER, 'quote-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repo.rpc).not.toHaveBeenCalled();
    });

    it('still replays an already-converted quote (the licence exists; consent is moot)', async () => {
      const { service, repo } = setup();
      (repo.findById as jest.Mock).mockImplementation((table: string) =>
        table === 'partner_customers'
          ? { id: 'cust-1', customer_organization_id: 'cust-org-1' }
          : {
              id: 'quote-1',
              is_deleted: false,
              customer_id: 'cust-1',
              status: 'converted',
              // Converted before accepted_by_organization_id existed.
              accepted_by_organization_id: null,
              converted_license_id: 'lic-1',
            },
      );
      (repo.rpc as jest.Mock).mockResolvedValue({
        invoice_id: 'inv-1',
        license_id: 'lic-1',
        already_converted: true,
      });

      await expect(service.convertQuote(ORG, USER, 'quote-1')).resolves.toEqual(
        { invoice_id: 'inv-1', license_id: 'lic-1', already_converted: true },
      );
    });

    it('refuses a quote accepted by an org other than the customer (partner self-accept)', async () => {
      const { service, repo } = setup();
      (repo.findById as jest.Mock).mockImplementation((table: string) =>
        table === 'partner_customers'
          ? { id: 'cust-1', customer_organization_id: 'cust-org-1' }
          : {
              id: 'quote-1',
              is_deleted: false,
              customer_id: 'cust-1',
              status: 'accepted',
              accepted_by_organization_id: ORG,
            },
      );

      await expect(
        service.convertQuote(ORG, USER, 'quote-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repo.rpc).not.toHaveBeenCalled();
    });
  });

  describe('acceptIncomingQuote', () => {
    /**
     * getIncomingQuote reads through repo.client, so drive the chain's maybeSingle
     * rather than repo.findById.
     */
    function setupIncoming(quote: unknown) {
      const chain = buildChain({ data: quote, error: null });
      const repo = {
        updateById: jest.fn().mockResolvedValue({ id: 'quote-1' }),
        findMany: jest.fn().mockResolvedValue([]),
        client: { from: jest.fn(() => chain) },
      } as unknown as PartnerRepository;
      const entitlements = {
        bust: jest.fn(),
      } as unknown as EntitlementsService;

      return { service: new PartnerSalesService(repo, entitlements), repo };
    }

    it('stamps the accepting org, which is what unlocks conversion', async () => {
      const { service, repo } = setupIncoming({
        id: 'quote-1',
        status: 'sent',
        is_deleted: false,
      });

      await service.acceptIncomingQuote('cust-org-1', USER, 'quote-1');

      expect(repo.updateById).toHaveBeenCalledWith(
        'partner_quotes',
        'quote-1',
        {
          status: 'accepted',
          accepted_at: expect.any(String),
          accepted_by: USER,
          accepted_by_organization_id: 'cust-org-1',
          updated_by: USER,
        },
      );
    });

    it('throws NotFound when the quote is not addressed to the caller org', async () => {
      const { service } = setupIncoming(null);

      await expect(
        service.acceptIncomingQuote('other-org', USER, 'quote-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects accepting a quote that is not in sent', async () => {
      const { service, repo } = setupIncoming({
        id: 'quote-1',
        status: 'draft',
        is_deleted: false,
      });

      await expect(
        service.acceptIncomingQuote('cust-org-1', USER, 'quote-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.updateById).not.toHaveBeenCalled();
    });
  });

  describe('updateInvoice', () => {
    it('sets paid_at when transitioning to paid', async () => {
      const { service, repo } = setup();
      (repo.findById as jest.Mock).mockResolvedValue({
        id: 'inv-1',
        is_deleted: false,
      });

      await service.updateInvoice(ORG, USER, 'inv-1', {
        status: 'paid',
      } as never);

      const patch = (repo.updateById as jest.Mock).mock.calls[0][2];

      expect(patch.status).toBe('paid');
      expect(patch.paid_at).toEqual(expect.any(String));
    });

    it('clears paid_at when leaving the paid status', async () => {
      const { service, repo } = setup();
      (repo.findById as jest.Mock).mockResolvedValue({
        id: 'inv-1',
        is_deleted: false,
      });

      await service.updateInvoice(ORG, USER, 'inv-1', {
        status: 'issued',
      } as never);

      const patch = (repo.updateById as jest.Mock).mock.calls[0][2];

      expect(patch.status).toBe('issued');
      expect(patch.paid_at).toBeNull();
    });
  });

  describe('getInvoice', () => {
    it('throws NotFound for a missing invoice', async () => {
      const { service, repo } = setup();
      (repo.findById as jest.Mock).mockResolvedValue(null);

      await expect(service.getInvoice(ORG, 'inv-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});

// XE-T734: listing gallery / directory flag validation.
describe('UpsertPartnerListingDto (XE-T734)', () => {
  const errorsFor = async (patch: Record<string, unknown>) =>
    validate(
      plainToInstance(UpsertPartnerListingDto, {
        slug: 'abj-experts',
        ...patch,
      }),
    );

  it('accepts up to six http(s) gallery URLs and the directory flag', async () => {
    const urls = Array.from(
      { length: 6 },
      (_, i) => `https://cdn.example.com/${i}.png`,
    );
    expect(
      await errorsFor({ gallery_urls: urls, show_in_directory: true }),
    ).toHaveLength(0);
  });

  it('rejects a seventh image', async () => {
    const urls = Array.from(
      { length: 7 },
      (_, i) => `https://cdn.example.com/${i}.png`,
    );
    expect((await errorsFor({ gallery_urls: urls }))[0].property).toBe(
      'gallery_urls',
    );
  });

  it('rejects a non-http URL (e.g. javascript:)', async () => {
    expect(
      (await errorsFor({ gallery_urls: ['javascript:alert(1)'] }))[0].property,
    ).toBe('gallery_urls');
  });

  it('accepts null logo_url so a logo can be removed', async () => {
    expect(await errorsFor({ logo_url: null })).toHaveLength(0);
  });
});
