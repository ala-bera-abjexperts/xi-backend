import { BadRequestException, NotFoundException } from '@nestjs/common';

import { FormBuilderPaymentsService } from './form-builder-payments.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { StripeService } from '../stripe/stripe.service';
import type { FormBuilderSubmissionsService } from './form-builder-submissions.service';
import type { FormBuilderAssignmentsService } from './form-builder-assignments.service';
import type { FormBuilderSubmissionEventsService } from './form-builder-submission-events.service';
import type { FormBuilderPaymentConfigService } from './form-builder-payment-config.service';
import type { CreateFormPaymentSessionDto } from './dto/create-form-payment-session.dto';

// A chainable + thenable Supabase query-builder stub. Every builder method returns
// the same object, terminal awaits resolve to `resolved`, and `.single()/.maybeSingle()`
// resolve to it too.
function buildChain(resolved: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;

  chain.select = jest.fn().mockImplementation(self);
  chain.eq = jest.fn().mockImplementation(self);
  chain.neq = jest.fn().mockImplementation(self);
  chain.in = jest.fn().mockImplementation(self);
  chain.order = jest.fn().mockImplementation(self);
  chain.limit = jest.fn().mockImplementation(self);
  chain.insert = jest.fn().mockImplementation(self);
  chain.update = jest.fn().mockImplementation(self);
  chain.delete = jest.fn().mockImplementation(self);
  chain.single = jest.fn().mockResolvedValue(resolved);
  chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
  chain.then = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve(resolved).then(onFulfilled);

  return chain;
}

// flush pending microtasks + timers so fire-and-forget (`void ...`) side effects settle
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('FormBuilderPaymentsService', () => {
  let service: FormBuilderPaymentsService;
  let mockFrom: jest.Mock;
  let submissions: { create: jest.Mock };
  let assignments: { markCompletedOnSubmit: jest.Mock };
  let events: { dispatch: jest.Mock };
  let sessionsCreate: jest.Mock;
  let spaceSessionsCreate: jest.Mock;
  // the global env-key client vs. the client built from a space's own connected secret
  let globalStripeClient: { checkout: { sessions: { create: jest.Mock } } };
  let spaceStripeClient: { checkout: { sessions: { create: jest.Mock } } };
  let stripe: {
    getStripeClient: jest.Mock;
    getStripeClientForKey: jest.Mock;
    getCheckoutStatus: jest.Mock;
  };
  let paymentConfig: { getDecryptedSecret: jest.Mock };

  function wire(tableQueues: Record<string, ReturnType<typeof buildChain>[]>) {
    mockFrom.mockImplementation((table: string) => {
      const queue = tableQueues[table];

      if (!queue || !queue.length)
        throw new Error(`unexpected from('${table}') call`);

      return queue.shift();
    });
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    submissions = { create: jest.fn().mockResolvedValue({ id: 'sub-1' }) };
    assignments = {
      markCompletedOnSubmit: jest.fn().mockResolvedValue(undefined),
    };
    events = { dispatch: jest.fn().mockResolvedValue(undefined) };
    sessionsCreate = jest.fn().mockResolvedValue({
      id: 'sess_1',
      client_secret: 'cs_test_123',
    });
    spaceSessionsCreate = jest.fn().mockResolvedValue({
      id: 'sess_space',
      client_secret: 'cs_space_456',
    });
    globalStripeClient = {
      checkout: { sessions: { create: sessionsCreate } },
    };
    spaceStripeClient = {
      checkout: { sessions: { create: spaceSessionsCreate } },
    };
    stripe = {
      getStripeClient: jest.fn().mockReturnValue(globalStripeClient),
      getStripeClientForKey: jest.fn().mockReturnValue(spaceStripeClient),
      getCheckoutStatus: jest.fn(),
    };
    // no per-space Stripe connection by default → the global env key is used
    paymentConfig = { getDecryptedSecret: jest.fn().mockResolvedValue(null) };

    const supabase = {
      getClient: () => ({ from: mockFrom, rpc: jest.fn() }),
    } as unknown as SupabaseAdminService;

    service = new FormBuilderPaymentsService(
      submissions as unknown as FormBuilderSubmissionsService,
      stripe as unknown as StripeService,
      supabase,
      assignments as unknown as FormBuilderAssignmentsService,
      events as unknown as FormBuilderSubmissionEventsService,
      paymentConfig as unknown as FormBuilderPaymentConfigService,
    );
  });

  describe('createCheckoutSession', () => {
    const dto = {
      field_key: 'products_1',
      selections: [{ product_id: 'p1', quantity: 2 }],
      submission_data: { name: 'Ada' },
      is_test: false,
    } as CreateFormPaymentSessionDto;

    function formChain() {
      return buildChain({
        data: { id: 'form-1', organization_id: 'org-1' },
        error: null,
      });
    }

    function fieldChain(rules: Record<string, unknown>) {
      return buildChain({
        data: {
          field_key: 'products_1',
          field_type: 'products',
          options: [
            { id: 'p1', name: 'Widget', price: 19.99, qtyMin: 1, qtyMax: 5 },
          ],
          validation_rules: rules,
        },
        error: null,
      });
    }

    it('saves a draft, records a pending order and opens an embedded Stripe session', async () => {
      const orderInsertChain = buildChain({
        data: { id: 'order-1' },
        error: null,
      });
      const orderLinkChain = buildChain({ data: null, error: null });

      wire({
        form_builder: [formChain()],
        form_builder_fields: [
          fieldChain({ gateway: 'stripe', currency: 'usd' }),
        ],
        form_builder_orders: [orderInsertChain, orderLinkChain],
      });

      await expect(
        service.createCheckoutSession('space-1', 'form-1', dto, 'https://app'),
      ).resolves.toEqual({
        clientSecret: 'cs_test_123',
        orderId: 'order-1',
        sessionId: 'sess_1',
      });

      // draft submission created before charging (last arg `true` = isDraft/paid path)
      expect(submissions.create).toHaveBeenCalledWith(
        'form-1',
        { data: { name: 'Ada' }, is_test: false },
        'space-1',
        'org-1',
        null,
        { ip: null, userAgent: null },
        true,
      );
      // amount recomputed server-side: 19.99 usd * 2 = 3998 minor units
      expect(orderInsertChain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: 'org-1',
          space_id: 'space-1',
          form_id: 'form-1',
          submission_id: 'sub-1',
          provider: 'stripe',
          amount_total: 3998,
          currency: 'usd',
          status: 'pending',
        }),
      );
      expect(sessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          ui_mode: 'embedded_page',
          mode: 'payment',
          client_reference_id: 'order-1',
          metadata: { orderId: 'order-1', source: 'form_builder' },
        }),
      );
      // the session id is linked back to the order
      expect(orderLinkChain.update).toHaveBeenCalledWith(
        expect.objectContaining({ stripe_checkout_session_id: 'sess_1' }),
      );
      // the Stripe key is resolved tenant-scoped (org + space) before charging;
      // with no per-space connection it falls back to the global env key
      expect(paymentConfig.getDecryptedSecret).toHaveBeenCalledWith({
        orgId: 'org-1',
        spaceId: 'space-1',
      });
      expect(stripe.getStripeClientForKey).not.toHaveBeenCalled();
      expect(stripe.getStripeClient).toHaveBeenCalled();
    });

    it("opens the session on the space's own Stripe account when one is connected", async () => {
      paymentConfig.getDecryptedSecret.mockResolvedValue('sk_space_live');

      const orderInsertChain = buildChain({
        data: { id: 'order-1' },
        error: null,
      });
      const orderLinkChain = buildChain({ data: null, error: null });

      wire({
        form_builder: [formChain()],
        form_builder_fields: [
          fieldChain({ gateway: 'stripe', currency: 'usd' }),
        ],
        form_builder_orders: [orderInsertChain, orderLinkChain],
      });

      await expect(
        service.createCheckoutSession('space-1', 'form-1', dto, 'https://app'),
      ).resolves.toEqual({
        clientSecret: 'cs_space_456',
        orderId: 'order-1',
        sessionId: 'sess_space',
      });

      expect(stripe.getStripeClientForKey).toHaveBeenCalledWith(
        'sk_space_live',
      );
      // the global env-key client must never be used once the space is connected
      expect(stripe.getStripeClient).not.toHaveBeenCalled();
      expect(sessionsCreate).not.toHaveBeenCalled();
      expect(spaceSessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ client_reference_id: 'order-1' }),
      );
      expect(orderLinkChain.update).toHaveBeenCalledWith(
        expect.objectContaining({ stripe_checkout_session_id: 'sess_space' }),
      );
    });

    it('throws NotFoundException when the form does not exist', async () => {
      wire({ form_builder: [buildChain({ data: null, error: null })] });

      await expect(
        service.createCheckoutSession('space-1', 'form-1', dto),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(submissions.create).not.toHaveBeenCalled();
    });

    it('rejects an unsupported (non-stripe) payment gateway', async () => {
      wire({
        form_builder: [formChain()],
        form_builder_fields: [
          fieldChain({ gateway: 'paypal', currency: 'usd' }),
        ],
      });

      await expect(
        service.createCheckoutSession('space-1', 'form-1', dto),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(stripe.getStripeClient).not.toHaveBeenCalled();
    });

    it('rejects a zero-total order before touching Stripe or creating a draft', async () => {
      const zeroField = buildChain({
        data: {
          field_key: 'products_1',
          field_type: 'products',
          options: [
            { id: 'p1', name: 'Free', price: 10, qtyMin: 0, qtyMax: 5 },
          ],
          validation_rules: { gateway: 'stripe', currency: 'usd' },
        },
        error: null,
      });
      const zeroDto = {
        field_key: 'products_1',
        selections: [{ product_id: 'p1', quantity: 0 }],
        submission_data: {},
      } as CreateFormPaymentSessionDto;

      wire({
        form_builder: [formChain()],
        form_builder_fields: [zeroField],
      });

      await expect(
        service.createCheckoutSession('space-1', 'form-1', zeroDto),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(stripe.getStripeClient).not.toHaveBeenCalled();
      expect(submissions.create).not.toHaveBeenCalled();
    });
  });

  describe('getStatus', () => {
    const order = {
      id: 'order-1',
      status: 'pending',
      submission_id: 'sub-1',
      stripe_payment_intent_id: null,
      customer_email: null,
      form_id: 'form-1',
      space_id: 'space-1',
      organization_id: 'org-1',
    };

    it('finalizes the order and flips the draft to submitted once paid', async () => {
      stripe.getCheckoutStatus.mockResolvedValue({
        data: {
          status: 'complete',
          paymentStatus: 'paid',
          customerEmail: 'buyer@example.com',
        },
      });

      const orderSelectChain = buildChain({ data: order, error: null });
      const orderUpdateChain = buildChain({
        data: { ...order, status: 'paid', customer_email: 'buyer@example.com' },
        error: null,
      });
      const subFlipChain = buildChain({
        data: { id: 'sub-1', status: 'submitted' },
        error: null,
      });
      const userChain = buildChain({ data: { id: 'user-9' }, error: null });

      wire({
        form_builder_orders: [orderSelectChain, orderUpdateChain],
        form_builder_submissions: [subFlipChain],
        users: [userChain],
      });

      await expect(
        service.getStatus('space-1', 'form-1', 'sess_1'),
      ).resolves.toEqual({
        status: 'complete',
        paymentStatus: 'paid',
        orderStatus: 'paid',
      });

      // the session is retrieved with the SAME client that created it — resolved
      // from the order's own org/space, not the caller's
      expect(paymentConfig.getDecryptedSecret).toHaveBeenCalledWith({
        orgId: 'org-1',
        spaceId: 'space-1',
      });
      expect(stripe.getCheckoutStatus).toHaveBeenCalledWith(
        'sess_1',
        globalStripeClient,
      );

      expect(orderUpdateChain.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'paid' }),
      );
      // the draft flip is guarded to draft rows only, and single-fires the events seam
      expect(subFlipChain.update).toHaveBeenCalledWith({ status: 'submitted' });
      expect(subFlipChain.eq).toHaveBeenCalledWith('status', 'draft');
      expect(events.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sub-1', status: 'submitted' }),
      );

      // best-effort assignment completion is fire-and-forget — let it settle
      await flush();
      expect(assignments.markCompletedOnSubmit).toHaveBeenCalledWith(
        'form-1',
        'user-9',
        'sub-1',
        'space-1',
        'org-1',
      );
    });

    it('does not finalize when the payment is not yet paid', async () => {
      stripe.getCheckoutStatus.mockResolvedValue({
        data: { status: 'open', paymentStatus: 'unpaid', customerEmail: null },
      });

      const orderSelectChain = buildChain({ data: order, error: null });

      wire({ form_builder_orders: [orderSelectChain] });

      await expect(
        service.getStatus('space-1', 'form-1', 'sess_1'),
      ).resolves.toEqual({
        status: 'open',
        paymentStatus: 'unpaid',
        orderStatus: 'pending',
      });
      // only the order load hit the DB — no finalize, no submission flip
      expect(mockFrom).toHaveBeenCalledTimes(1);
      expect(stripe.getCheckoutStatus).toHaveBeenCalledWith(
        'sess_1',
        globalStripeClient,
      );
      expect(events.dispatch).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when no order matches the session', async () => {
      stripe.getCheckoutStatus.mockResolvedValue({
        data: { status: 'open', paymentStatus: 'unpaid', customerEmail: null },
      });

      wire({ form_builder_orders: [buildChain({ data: null, error: null })] });

      await expect(
        service.getStatus('space-1', 'form-1', 'sess_1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('finalize', () => {
    const order = {
      id: 'order-1',
      status: 'pending',
      submission_id: 'sub-1',
      stripe_payment_intent_id: null,
      customer_email: null,
      form_id: 'form-1',
      space_id: 'space-1',
      organization_id: 'org-1',
    };

    it('is a no-op when the order is already paid', async () => {
      const paidOrder = { ...order, status: 'paid' };

      const result = await service.finalize(paidOrder as any);

      expect(result).toBe(paidOrder);
      expect(mockFrom).not.toHaveBeenCalled();
      expect(events.dispatch).not.toHaveBeenCalled();
    });

    it('loads an order by id, marks it paid and dispatches the flipped submission', async () => {
      const loadChain = buildChain({ data: order, error: null });
      const updateChain = buildChain({
        data: { ...order, status: 'paid', customer_email: 'b@example.com' },
        error: null,
      });
      const subFlipChain = buildChain({
        data: { id: 'sub-1', status: 'submitted' },
        error: null,
      });
      const userChain = buildChain({ data: { id: 'user-9' }, error: null });

      wire({
        form_builder_orders: [loadChain, updateChain],
        form_builder_submissions: [subFlipChain],
        users: [userChain],
      });

      const result = await service.finalize('order-1', {
        paymentIntentId: 'pi_1',
        customerEmail: 'b@example.com',
      });

      expect(result.status).toBe('paid');
      expect(updateChain.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'paid',
          stripe_payment_intent_id: 'pi_1',
          customer_email: 'b@example.com',
        }),
      );
      expect(updateChain.neq).toHaveBeenCalledWith('status', 'paid');
      expect(events.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sub-1', status: 'submitted' }),
      );
    });
  });

  describe('markAbandoned', () => {
    it('marks a pending order abandoned and deletes its still-draft submission', async () => {
      const order = {
        id: 'order-1',
        status: 'pending',
        submission_id: 'sub-1',
        stripe_payment_intent_id: null,
        customer_email: null,
        form_id: 'form-1',
        space_id: 'space-1',
        organization_id: 'org-1',
      };
      const loadChain = buildChain({ data: order, error: null });
      const updateChain = buildChain({ data: null, error: null });
      const delChain = buildChain({ data: null, error: null });

      wire({
        form_builder_orders: [loadChain, updateChain],
        form_builder_submissions: [delChain],
      });

      await expect(service.markAbandoned('order-1')).resolves.toBeUndefined();
      expect(updateChain.update).toHaveBeenCalledWith({ status: 'abandoned' });
      expect(delChain.delete).toHaveBeenCalled();
      expect(delChain.eq).toHaveBeenCalledWith('status', 'draft');
    });

    it('never touches an already-paid order', async () => {
      const paidOrder = {
        id: 'order-1',
        status: 'paid',
        submission_id: 'sub-1',
        stripe_payment_intent_id: null,
        customer_email: null,
        form_id: 'form-1',
        space_id: 'space-1',
        organization_id: 'org-1',
      };

      wire({
        form_builder_orders: [buildChain({ data: paidOrder, error: null })],
      });

      await expect(service.markAbandoned('order-1')).resolves.toBeUndefined();
      // only the load happened — no update, no submission delete
      expect(mockFrom).toHaveBeenCalledTimes(1);
    });
  });
});
