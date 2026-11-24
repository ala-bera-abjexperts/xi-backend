import { FormBuilderIntegrationDispatcherService } from './form-builder-integration-dispatcher.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { runIssueAction } from './integrations/issue-actions';

jest.mock('../lib/crypto/encryption', () => ({
  decryptApiKey: jest.fn(() => 'plain-credential'),
}));

jest.mock('./integrations/issue-actions', () => ({
  runIssueAction: jest.fn(),
}));

const runAction = runIssueAction as jest.Mock;

// A chainable + thenable Supabase query-builder stub (same shape as the webhook dispatcher spec).
function buildChain(resolved: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;

  chain.select = jest.fn().mockImplementation(self);
  chain.update = jest.fn().mockImplementation(self);
  chain.eq = jest.fn().mockImplementation(self);
  chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
  chain.then = (
    onFulfilled: (v: unknown) => unknown,
    onRejected?: (e: unknown) => unknown,
  ) => Promise.resolve(resolved).then(onFulfilled, onRejected);

  return chain;
}

const integrationRow = {
  id: 'int-1',
  provider: 'gmail',
  config: {},
  field_map: [],
  is_active: true,
  secret_encrypted: 'enc',
  secret_iv: 'iv',
  secret_tag: 'tag',
};

const deliveryRow = {
  id: 'd1',
  organization_id: 'org-1',
  space_id: 'space-1',
  integration_id: 'int-1',
  submission_id: 'sub-1',
  event: 'submission.created',
  status: 'pending',
  attempt_count: 0,
  external_ref: null,
};

const submissionRow = {
  id: 'sub-1',
  form_id: 'form-1',
  data: { name: 'Ada' },
  field_snapshot: [],
};

describe('FormBuilderIntegrationDispatcherService', () => {
  let service: FormBuilderIntegrationDispatcherService;
  let mockFrom: jest.Mock;
  let mockRpc: jest.Mock;

  function queueTables(
    tableQueues: Record<string, ReturnType<typeof buildChain>[]>,
  ) {
    mockFrom.mockImplementation((table: string) => tableQueues[table].shift());
  }

  // One claimed row whose action succeeds; the deliveries write resolves to `updated`.
  function queueSuccessfulSend(updated: unknown[]) {
    const updateChain = buildChain({ data: updated, error: null });

    queueTables({
      form_builder_integrations: [
        buildChain({ data: integrationRow, error: null }),
      ],
      form_builder_submissions: [
        buildChain({ data: submissionRow, error: null }),
      ],
      form_builder: [buildChain({ data: { name: 'Intake' }, error: null })],
      form_builder_integration_deliveries: [updateChain],
    });

    return updateChain;
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    mockRpc = jest.fn();

    const supabase = {
      getClient: () => ({ from: mockFrom, rpc: mockRpc }),
    } as unknown as SupabaseAdminService;

    service = new FormBuilderIntegrationDispatcherService(supabase);

    runAction.mockResolvedValue({
      ok: true,
      status: 200,
      externalRef: 'msg-1',
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('drainOnce', () => {
    it('fences the completion write on the claim token when the claim carries one', async () => {
      mockRpc.mockResolvedValue({
        data: [{ ...deliveryRow, claim_token: 'tok-1' }],
        error: null,
      });

      const updateChain = queueSuccessfulSend([{ id: 'd1' }]);

      await service.drainOnce();

      expect(runAction).toHaveBeenCalledTimes(1);
      expect(updateChain.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'delivered', external_ref: 'msg-1' }),
      );
      expect(updateChain.eq).toHaveBeenCalledWith('status', 'in_progress');
      expect(updateChain.eq).toHaveBeenCalledWith('claim_token', 'tok-1');
      expect(updateChain.select).toHaveBeenCalledWith('id');
    });

    it('keeps the id + organization filter only when the claim has no token', async () => {
      mockRpc.mockResolvedValue({ data: [deliveryRow], error: null });

      const updateChain = queueSuccessfulSend([{ id: 'd1' }]);

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

      const updateChain = queueSuccessfulSend([]);

      await service.drainOnce();

      // exactly one write — the fenced delivered write; no failure/retry write follows.
      expect(updateChain.update).toHaveBeenCalledTimes(1);
      expect(
        mockFrom.mock.calls.filter(
          ([t]) => t === 'form_builder_integration_deliveries',
        ),
      ).toHaveLength(1);
    });

    it('does not re-run the action for a row that already has an external_ref', async () => {
      mockRpc.mockResolvedValue({
        data: [{ ...deliveryRow, external_ref: 'msg-0', claim_token: 'tok-1' }],
        error: null,
      });

      const updateChain = buildChain({ data: [{ id: 'd1' }], error: null });

      queueTables({ form_builder_integration_deliveries: [updateChain] });

      await service.drainOnce();

      expect(runAction).not.toHaveBeenCalled();
      expect(updateChain.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'delivered', external_ref: 'msg-0' }),
      );
      expect(updateChain.eq).toHaveBeenCalledWith('claim_token', 'tok-1');
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
