/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- test doubles are typed as `any`; the type-checked unsafe rules add no value in mock assertions */
import { FormBuilderWebhookDispatcherService } from './form-builder-webhook-dispatcher.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { assertPublicHttpUrl } from '../common/security/ssrf-guard';
import { decryptApiKey } from '../lib/crypto/encryption';

jest.mock('../common/security/ssrf-guard', () => ({
  assertPublicHttpUrl: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../lib/crypto/encryption', () => ({
  encryptApiKey: jest.fn(() => ({ encrypted: 'enc', iv: 'iv', tag: 'tag' })),
  decryptApiKey: jest.fn(() => 'plain-secret'),
}));

const assertUrl = assertPublicHttpUrl as jest.Mock;
const decrypt = decryptApiKey as unknown as jest.Mock;

// A chainable + thenable Supabase query-builder stub (see webhooks spec for shape).
function buildChain(resolved: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;

  chain.select = jest.fn().mockImplementation(self);
  chain.insert = jest.fn().mockImplementation(self);
  chain.update = jest.fn().mockImplementation(self);
  chain.upsert = jest.fn().mockImplementation(self);
  chain.delete = jest.fn().mockImplementation(self);
  chain.eq = jest.fn().mockImplementation(self);
  chain.neq = jest.fn().mockImplementation(self);
  chain.in = jest.fn().mockImplementation(self);
  chain.contains = jest.fn().mockImplementation(self);
  chain.order = jest.fn().mockImplementation(self);
  chain.limit = jest.fn().mockImplementation(self);
  chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
  chain.single = jest.fn().mockResolvedValue(resolved);
  chain.then = (
    onFulfilled: (v: unknown) => unknown,
    onRejected?: (e: unknown) => unknown,
  ) => Promise.resolve(resolved).then(onFulfilled, onRejected);

  return chain;
}

const activeWebhookRow = {
  id: 'wh-1',
  provider: 'generic',
  url: 'https://hooks.example.com/x',
  is_active: true,
  secret_encrypted: null,
  secret_iv: null,
  secret_tag: null,
};

describe('FormBuilderWebhookDispatcherService', () => {
  let service: FormBuilderWebhookDispatcherService;
  let mockFrom: jest.Mock;
  let mockRpc: jest.Mock;
  let fetchMock: jest.Mock;
  const ctx = { spaceId: 'space-1', orgId: 'org-1' };

  function queueTables(
    tableQueues: Record<string, ReturnType<typeof buildChain>[]>,
  ) {
    mockFrom.mockImplementation((table: string) => tableQueues[table].shift());
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    mockRpc = jest.fn();

    const supabase = {
      getClient: () => ({ from: mockFrom, rpc: mockRpc }),
    } as unknown as SupabaseAdminService;

    service = new FormBuilderWebhookDispatcherService(supabase);

    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('enqueue', () => {
    it('upserts one idempotent pending delivery row per active subscribed hook', async () => {
      const hooksChain = buildChain({
        data: [{ id: 'h1' }, { id: 'h2' }],
        error: null,
      });
      const deliveriesChain = buildChain({ data: null, error: null });

      queueTables({
        form_builder_webhooks: [hooksChain],
        form_builder_webhook_deliveries: [deliveriesChain],
      });

      await service.enqueue(
        { id: 'sub-1', form_id: 'form-1' },
        'submission.created',
        ctx,
      );

      expect(hooksChain.contains).toHaveBeenCalledWith('events', [
        'submission.created',
      ]);
      expect(deliveriesChain.upsert).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            organization_id: 'org-1',
            space_id: 'space-1',
            webhook_id: 'h1',
            submission_id: 'sub-1',
            event: 'submission.created',
            status: 'pending',
          }),
          expect.objectContaining({ webhook_id: 'h2' }),
        ]),
        {
          onConflict: 'webhook_id,submission_id,event',
          ignoreDuplicates: true,
        },
      );
    });

    it('does not upsert anything when there are no active subscribed hooks', async () => {
      const hooksChain = buildChain({ data: [], error: null });

      queueTables({ form_builder_webhooks: [hooksChain] });

      await service.enqueue(
        { id: 'sub-1', form_id: 'form-1' },
        'submission.created',
        ctx,
      );

      expect(mockFrom).toHaveBeenCalledTimes(1);
      expect(mockFrom).toHaveBeenCalledWith('form_builder_webhooks');
    });

    it('swallows a hook-load error without throwing into the submit path', async () => {
      const hooksChain = buildChain({
        data: null,
        error: { message: 'boom' },
      });

      queueTables({ form_builder_webhooks: [hooksChain] });

      await expect(
        service.enqueue(
          { id: 'sub-1', form_id: 'form-1' },
          'submission.created',
          ctx,
        ),
      ).resolves.toBeUndefined();

      expect(mockFrom).toHaveBeenCalledTimes(1);
    });
  });

  describe('sendTest', () => {
    it('POSTs a test payload and returns ok on a 2xx response', async () => {
      const result = await service.sendTest(activeWebhookRow);

      expect(assertUrl).toHaveBeenCalledWith('https://hooks.example.com/x');
      expect(fetchMock).toHaveBeenCalledWith(
        'https://hooks.example.com/x',
        expect.objectContaining({ method: 'POST', redirect: 'manual' }),
      );
      expect(result).toEqual({ ok: true, status: 200 });
    });

    it('signs the body with HMAC when the hook has a secret', async () => {
      const result = await service.sendTest({
        ...activeWebhookRow,
        secret_encrypted: 'enc',
        secret_iv: 'iv',
        secret_tag: 'tag',
      });

      expect(decrypt).toHaveBeenCalledWith('enc', 'iv', 'tag');

      const headers = fetchMock.mock.calls[0][1].headers as Record<
        string,
        string
      >;

      expect(headers['X-FormBuilder-Signature']).toMatch(/^sha256=/);
      expect(result).toEqual({ ok: true, status: 200 });
    });

    it('returns a failure result on a non-2xx response', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });

      const result = await service.sendTest(activeWebhookRow);

      expect(result).toEqual({ ok: false, status: 500 });
    });

    it('treats a 3xx redirect as a failure (redirects are not followed)', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 302 });

      const result = await service.sendTest(activeWebhookRow);

      expect(result).toEqual({
        ok: false,
        status: 302,
        error: 'redirects are not followed',
      });
    });

    it('returns a failure result when fetch throws', async () => {
      fetchMock.mockRejectedValueOnce(new Error('network down'));

      const result = await service.sendTest(activeWebhookRow);

      expect(result).toEqual({
        ok: false,
        status: null,
        error: 'network down',
      });
    });
  });

  describe('drainOnce', () => {
    const deliveryRow = {
      id: 'd1',
      organization_id: 'org-1',
      space_id: 'space-1',
      webhook_id: 'wh-1',
      submission_id: 'sub-1',
      event: 'submission.created',
      status: 'pending',
      attempt_count: 0,
    };
    const submissionRow = {
      id: 'sub-1',
      form_id: 'form-1',
      data: { name: 'Ada' },
      field_snapshot: [],
      created_at: '2026-01-01T00:00:00Z',
    };

    it('marks a delivery delivered on a successful send', async () => {
      mockRpc.mockResolvedValue({ data: [deliveryRow], error: null });

      const webhookChain = buildChain({ data: activeWebhookRow, error: null });
      const subChain = buildChain({ data: submissionRow, error: null });
      const updateChain = buildChain({ data: [{ id: 'd1' }], error: null });

      queueTables({
        form_builder_webhooks: [webhookChain],
        form_builder_submissions: [subChain],
        form_builder_webhook_deliveries: [updateChain],
      });

      await service.drainOnce();

      expect(mockRpc).toHaveBeenCalledWith(
        'drain_form_builder_webhook_deliveries',
        { batch_size: 50 },
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(updateChain.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'delivered', response_code: 200 }),
      );
    });

    it('records a failure with backoff when the send is non-2xx', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 500 });
      mockRpc.mockResolvedValue({ data: [deliveryRow], error: null });

      const webhookChain = buildChain({ data: activeWebhookRow, error: null });
      const subChain = buildChain({ data: submissionRow, error: null });
      const updateChain = buildChain({ data: [{ id: 'd1' }], error: null });

      queueTables({
        form_builder_webhooks: [webhookChain],
        form_builder_submissions: [subChain],
        form_builder_webhook_deliveries: [updateChain],
      });

      await service.drainOnce();

      expect(updateChain.update).toHaveBeenCalledWith(
        expect.objectContaining({
          attempt_count: 1,
          status: 'pending',
          response_code: 500,
        }),
      );

      const patch = (updateChain.update as jest.Mock).mock.calls[0][0];

      expect(patch).toHaveProperty('next_attempt_at');
    });

    it('fences the completion write on the claim token when the claim carries one', async () => {
      mockRpc.mockResolvedValue({
        data: [{ ...deliveryRow, claim_token: 'tok-1' }],
        error: null,
      });

      const updateChain = buildChain({ data: [{ id: 'd1' }], error: null });

      queueTables({
        form_builder_webhooks: [
          buildChain({ data: activeWebhookRow, error: null }),
        ],
        form_builder_submissions: [
          buildChain({ data: submissionRow, error: null }),
        ],
        form_builder_webhook_deliveries: [updateChain],
      });

      await service.drainOnce();

      expect(updateChain.eq).toHaveBeenCalledWith('status', 'in_progress');
      expect(updateChain.eq).toHaveBeenCalledWith('claim_token', 'tok-1');
      expect(updateChain.select).toHaveBeenCalledWith('id');
    });

    it('keeps the id + organization filter only when the claim has no token', async () => {
      mockRpc.mockResolvedValue({ data: [deliveryRow], error: null });

      const updateChain = buildChain({ data: [{ id: 'd1' }], error: null });

      queueTables({
        form_builder_webhooks: [
          buildChain({ data: activeWebhookRow, error: null }),
        ],
        form_builder_submissions: [
          buildChain({ data: submissionRow, error: null }),
        ],
        form_builder_webhook_deliveries: [updateChain],
      });

      await service.drainOnce();

      expect((updateChain.eq as jest.Mock).mock.calls).toEqual([
        ['id', 'd1'],
        ['organization_id', 'org-1'],
      ]);
    });

    it('records nothing more when the claim was lost (0 rows updated)', async () => {
      mockRpc.mockResolvedValue({
        data: [{ ...deliveryRow, claim_token: 'tok-1' }],
        error: null,
      });

      const updateChain = buildChain({ data: [], error: null });

      queueTables({
        form_builder_webhooks: [
          buildChain({ data: activeWebhookRow, error: null }),
        ],
        form_builder_submissions: [
          buildChain({ data: submissionRow, error: null }),
        ],
        form_builder_webhook_deliveries: [updateChain],
      });

      await service.drainOnce();

      // exactly one write — the fenced delivered write; no failure/retry write follows.
      expect(updateChain.update).toHaveBeenCalledTimes(1);
      expect(
        mockFrom.mock.calls.filter(
          ([t]) => t === 'form_builder_webhook_deliveries',
        ),
      ).toHaveLength(1);
    });

    it('is a no-op when the claim RPC is not present yet', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'could not find the function', code: 'PGRST202' },
      });

      await service.drainOnce();

      expect(mockFrom).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('drain', () => {
    it('skips a tick that overlaps one still in flight', async () => {
      let release: (v: unknown) => void = () => {};

      mockRpc.mockReturnValueOnce(
        new Promise((res) => {
          release = res;
        }),
      );

      const first = service.drain();

      await service.drain();

      expect(mockRpc).toHaveBeenCalledTimes(1);

      release({ data: [], error: null });
      await first;

      mockRpc.mockResolvedValue({ data: [], error: null });
      await service.drain();

      expect(mockRpc).toHaveBeenCalledTimes(2);
    });
  });
});
