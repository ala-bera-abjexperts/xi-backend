import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StripeService } from './stripe.service';

function createConfig(values: Record<string, unknown> = {}) {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

function createSupabase(
  funnelResult: { data: unknown; error: unknown },
  domainsResult: { data: unknown; error: unknown } = { data: [], error: null },
) {
  const maybeSingle = jest.fn().mockResolvedValue(funnelResult);
  const funnelQuery = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle,
  };
  const domainsQuery = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    then: (resolve: (value: { data: unknown; error: unknown }) => unknown) =>
      Promise.resolve(domainsResult).then(resolve),
  };
  const client = {
    from: jest.fn((table: string) =>
      table === 'site_studio_domains' ? domainsQuery : funnelQuery,
    ),
  };

  return {
    supabase: {
      getClient: jest.fn().mockReturnValue(client),
    },
    client,
    query: funnelQuery,
    domainsQuery,
  };
}

function createStripeFake() {
  return {
    products: {
      list: jest.fn().mockResolvedValue({
        data: [{ id: 'prod_1', name: 'Risk Pro' }],
        has_more: false,
      }),
    },
    prices: {
      list: jest.fn().mockResolvedValue({
        data: [
          {
            id: 'price_1',
            product: 'prod_1',
            unit_amount: 1500,
            currency: 'usd',
            type: 'recurring',
            recurring: { interval: 'month' },
          },
        ],
        has_more: true,
      }),
      retrieve: jest.fn().mockResolvedValue({
        id: 'price_1',
        product: 'prod_1',
        unit_amount: 1500,
        currency: 'usd',
        type: 'recurring',
        recurring: { interval: 'month' },
      }),
    },
    checkout: {
      sessions: {
        create: jest.fn().mockResolvedValue({ client_secret: 'secret_123' }),
        retrieve: jest.fn().mockResolvedValue({
          status: 'complete',
          payment_status: 'paid',
          customer_details: { email: 'buyer@example.com' },
        }),
      },
    },
    webhooks: {
      constructEvent: jest.fn().mockReturnValue({
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_test_123' } },
      }),
    },
  };
}

describe('StripeService', () => {
  it('lists active Stripe products using the legacy response body shape', async () => {
    const supabase = createSupabase({ data: null, error: null });
    const service = new StripeService(
      createConfig(),
      supabase.supabase as never,
    );
    const stripe = createStripeFake();

    (service as unknown as { stripeClient: typeof stripe }).stripeClient =
      stripe;

    await expect(service.listProducts()).resolves.toEqual({
      data: [
        {
          productId: 'prod_1',
          productName: 'Risk Pro',
          priceId: 'price_1',
          amount: 1500,
          currency: 'usd',
          recurring: true,
          interval: 'month',
        },
      ],
      truncated: true,
    });
  });

  it('returns a clean 503 when Stripe products are requested without configuration', async () => {
    const supabase = createSupabase({ data: null, error: null });
    const service = new StripeService(
      createConfig({ 'stripe.secretKey': undefined }),
      supabase.supabase as never,
    );

    await expect(service.listProducts()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('creates checkout sessions only for configured prices on published funnels', async () => {
    const supabase = createSupabase(
      {
        data: {
          id: 'funnel-1',
          published: true,
          live_products: [
            { productId: 'prod_1', priceId: 'price_1', recurring: true },
          ],
        },
        error: null,
      },
      { data: [{ domain: 'site.example' }], error: null },
    );
    const service = new StripeService(
      createConfig(),
      supabase.supabase as never,
    );
    const stripe = createStripeFake();

    (service as unknown as { stripeClient: typeof stripe }).stripeClient =
      stripe;

    await expect(
      service.createCheckoutSession(
        {
          funnel_id: 'funnel-1',
          price_ids: ['price_1'],
          return_url:
            'https://site.example/pricing?plan=pro&session_id={CHECKOUT_SESSION_ID}',
        },
        'https://site.example',
      ),
    ).resolves.toEqual({ data: { clientSecret: 'secret_123' } });
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith({
      ui_mode: 'embedded_page',
      mode: 'subscription',
      line_items: [{ price: 'price_1', quantity: 1 }],
      return_url:
        'https://site.example/pricing?plan=pro&session_id={CHECKOUT_SESSION_ID}',
    });
  });

  it('rejects checkout return origins outside configured and funnel-owned domains', async () => {
    const supabase = createSupabase({
      data: {
        id: 'funnel-1',
        published: true,
        sub_domain_name: 'approved',
        preview_subdomain: 'preview',
        live_products: [
          { productId: 'prod_1', priceId: 'price_1', recurring: true },
        ],
      },
      error: null,
    });
    const service = new StripeService(
      createConfig({ appUrl: 'https://app.example' }),
      supabase.supabase as never,
    );
    const stripe = createStripeFake();

    (service as unknown as { stripeClient: typeof stripe }).stripeClient =
      stripe;

    await expect(
      service.createCheckoutSession(
        { funnel_id: 'funnel-1', price_ids: ['price_1'] },
        'https://evil.example',
      ),
    ).rejects.toThrow('Checkout origin is not allowed');
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('rejects unpublished or missing funnels before creating a checkout session', async () => {
    const supabase = createSupabase({ data: null, error: null });
    const service = new StripeService(
      createConfig(),
      supabase.supabase as never,
    );
    const stripe = createStripeFake();

    (service as unknown as { stripeClient: typeof stripe }).stripeClient =
      stripe;

    await expect(
      service.createCheckoutSession({
        funnel_id: 'missing-funnel',
        price_ids: ['price_1'],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('rejects prices that are not configured on the funnel', async () => {
    const supabase = createSupabase({
      data: {
        id: 'funnel-1',
        published: true,
        live_products: [
          { productId: 'prod_1', priceId: 'price_1', recurring: true },
        ],
      },
      error: null,
    });
    const service = new StripeService(
      createConfig(),
      supabase.supabase as never,
    );
    const stripe = createStripeFake();

    (service as unknown as { stripeClient: typeof stripe }).stripeClient =
      stripe;

    await expect(
      service.createCheckoutSession({
        funnel_id: 'funnel-1',
        price_ids: ['price_2'],
      }),
    ).rejects.toThrow('Invalid price IDs: price_2');
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('keeps Stripe one-time and recurring prices from being mixed', async () => {
    const supabase = createSupabase({
      data: {
        id: 'funnel-1',
        published: true,
        live_products: [
          { productId: 'prod_1', priceId: 'price_1', recurring: true },
          { productId: 'prod_2', priceId: 'price_2', recurring: false },
        ],
      },
      error: null,
    });
    const service = new StripeService(
      createConfig(),
      supabase.supabase as never,
    );
    const stripe = createStripeFake();

    stripe.prices.retrieve
      .mockResolvedValueOnce({ id: 'price_1', type: 'recurring' })
      .mockResolvedValueOnce({ id: 'price_2', type: 'one_time' });
    (service as unknown as { stripeClient: typeof stripe }).stripeClient =
      stripe;

    await expect(
      service.createCheckoutSession({
        funnel_id: 'funnel-1',
        price_ids: ['price_1', 'price_2'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('returns a clean checkout configuration error when Stripe is not configured', async () => {
    const supabase = createSupabase({
      data: {
        id: 'funnel-1',
        published: true,
        live_products: [
          { productId: 'prod_1', priceId: 'price_1', recurring: true },
        ],
      },
      error: null,
    });
    const service = new StripeService(
      createConfig({ 'stripe.secretKey': undefined }),
      supabase.supabase as never,
    );

    await expect(
      service.createCheckoutSession({
        funnel_id: 'funnel-1',
        price_ids: ['price_1'],
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('returns checkout status with the legacy response body shape', async () => {
    const supabase = createSupabase({ data: null, error: null });
    const service = new StripeService(
      createConfig(),
      supabase.supabase as never,
    );
    const stripe = createStripeFake();

    (service as unknown as { stripeClient: typeof stripe }).stripeClient =
      stripe;

    await expect(service.getCheckoutStatus('cs_test_123')).resolves.toEqual({
      data: {
        status: 'complete',
        paymentStatus: 'paid',
        customerEmail: 'buyer@example.com',
      },
    });
  });

  it('verifies signed Stripe webhook payloads', async () => {
    const supabase = createSupabase({ data: null, error: null });
    const service = new StripeService(
      createConfig({ 'stripe.webhookSecret': 'whsec_test' }),
      supabase.supabase as never,
    );
    const stripe = createStripeFake();
    const payload = Buffer.from('{"id":"evt_test"}');

    (service as unknown as { stripeClient: typeof stripe }).stripeClient =
      stripe;

    await expect(service.handleWebhook(payload, 'sig_test')).resolves.toEqual({
      received: true,
    });
    expect(stripe.webhooks.constructEvent).toHaveBeenCalledWith(
      payload,
      'sig_test',
      'whsec_test',
    );
  });

  it('rejects Stripe webhooks without a signature header', async () => {
    const supabase = createSupabase({ data: null, error: null });
    const service = new StripeService(
      createConfig({ 'stripe.webhookSecret': 'whsec_test' }),
      supabase.supabase as never,
    );

    await expect(
      service.handleWebhook(Buffer.from('{}'), undefined),
    ).rejects.toThrow('Missing stripe-signature header');
  });

  it('keeps the legacy received response when the Stripe webhook secret is not configured', async () => {
    const supabase = createSupabase({ data: null, error: null });
    const service = new StripeService(
      createConfig(),
      supabase.supabase as never,
    );
    const stripe = createStripeFake();

    (service as unknown as { stripeClient: typeof stripe }).stripeClient =
      stripe;

    await expect(
      service.handleWebhook(Buffer.from('{}'), 'sig_test'),
    ).resolves.toEqual({
      received: true,
    });
    expect(stripe.webhooks.constructEvent).not.toHaveBeenCalled();
  });

  it('maps invalid Stripe webhook signatures to bad request errors', async () => {
    const supabase = createSupabase({ data: null, error: null });
    const service = new StripeService(
      createConfig({ 'stripe.webhookSecret': 'whsec_test' }),
      supabase.supabase as never,
    );
    const stripe = createStripeFake();

    stripe.webhooks.constructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature');
    });
    (service as unknown as { stripeClient: typeof stripe }).stripeClient =
      stripe;

    await expect(
      service.handleWebhook(Buffer.from('{}'), 'sig_test'),
    ).rejects.toThrow(
      'Webhook error: No signatures found matching the expected signature',
    );
  });
});
