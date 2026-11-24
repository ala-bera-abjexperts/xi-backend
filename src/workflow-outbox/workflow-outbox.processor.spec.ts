/** @fileoverview Unit tests for WorkflowOutboxProcessor — claim + dispatch happy path, retry backoff, dead-letter, missing-RPC degradation. @module src/workflow-outbox/workflow-outbox.processor.spec @author Prince Jadiya */

import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { FireEventDispatcher } from './dispatchers/fire-event.dispatcher';
import type { FireWebhookDispatcher } from './dispatchers/fire-webhook.dispatcher';
import type { SendNotificationDispatcher } from './dispatchers/send-notification.dispatcher';
import {
  WorkflowOutboxProcessor,
  type OutboxRow,
} from './workflow-outbox.processor';

/** Build a single update chain that records calls and resolves to one updated row. */
function buildUpdateChain(data: unknown[] = [{ id: 'row-1' }]) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.update = jest.fn().mockImplementation(self);
  chain.eq = jest.fn().mockImplementation(self);
  chain.select = jest.fn().mockImplementation(self);
  chain.then = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve({ data, error: null }).then(onFulfilled);

  return chain;
}

describe('WorkflowOutboxProcessor', () => {
  let processor: WorkflowOutboxProcessor;
  let mockFrom: jest.Mock;
  let mockRpc: jest.Mock;
  let updateChain: ReturnType<typeof buildUpdateChain>;
  let sendNotification: { dispatch: jest.Mock };
  let fireWebhook: { dispatch: jest.Mock };
  let fireEvent: { dispatch: jest.Mock };

  function makeRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
    return {
      id: 'row-1',
      organization_id: 'org-1',
      task_id: 'task-1',
      transition_id: 'tx-1',
      rule_type: 'send_notification',
      payload: {},
      status: 'pending',
      attempt_count: 0,
      next_attempt_at: new Date().toISOString(),
      last_error: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    mockRpc = jest.fn();
    updateChain = buildUpdateChain();
    mockFrom.mockImplementation(() => updateChain);

    const supa = {
      getClient: () => ({ from: mockFrom, rpc: mockRpc }),
    } as unknown as SupabaseAdminService;

    sendNotification = { dispatch: jest.fn().mockResolvedValue(undefined) };
    fireWebhook = { dispatch: jest.fn().mockResolvedValue(undefined) };
    fireEvent = { dispatch: jest.fn().mockResolvedValue(undefined) };

    processor = new WorkflowOutboxProcessor(
      supa,
      sendNotification as unknown as SendNotificationDispatcher,
      fireWebhook as unknown as FireWebhookDispatcher,
      fireEvent as unknown as FireEventDispatcher,
    );
  });

  describe('drainOnce — happy path', () => {
    it('claims rows via RPC and routes each to the matching dispatcher', async () => {
      const rows: OutboxRow[] = [
        makeRow({ id: 'r1', rule_type: 'send_notification' }),
        makeRow({ id: 'r2', rule_type: 'trigger_webhook' }),
        makeRow({ id: 'r3', rule_type: 'fire_event' }),
      ];

      mockRpc.mockResolvedValue({ data: rows, error: null });

      await processor.drainOnce();

      expect(mockRpc).toHaveBeenCalledWith('drain_workflow_outbox', {
        batch_size: 50,
      });
      expect(sendNotification.dispatch).toHaveBeenCalledTimes(1);
      expect(fireWebhook.dispatch).toHaveBeenCalledTimes(1);
      expect(fireEvent.dispatch).toHaveBeenCalledTimes(1);

      // 3 success updates → one update payload per row.
      const updateCalls = (updateChain.update as jest.Mock).mock.calls;

      expect(updateCalls).toHaveLength(3);
      for (const [patch] of updateCalls as [{ status: string }][]) {
        expect(patch.status).toBe('succeeded');
      }
    });

    it('does nothing when the RPC returns an empty batch', async () => {
      mockRpc.mockResolvedValue({ data: [], error: null });

      await processor.drainOnce();

      expect(sendNotification.dispatch).not.toHaveBeenCalled();
      expect(updateChain.update).not.toHaveBeenCalled();
    });
  });

  describe('drainOnce — failure path', () => {
    it('increments attempt_count and schedules a backoff retry on transient failure', async () => {
      sendNotification.dispatch.mockRejectedValueOnce(new Error('boom'));
      mockRpc.mockResolvedValue({
        data: [makeRow({ attempt_count: 1 })],
        error: null,
      });

      const before = Date.now();

      await processor.drainOnce();

      const [patch] = (updateChain.update as jest.Mock).mock.calls[0] as [
        Record<string, unknown>,
      ];

      expect(patch.status).toBe('pending');
      expect(patch.attempt_count).toBe(2);
      expect(patch.last_error).toBe('boom');
      // 2^(attempt_count) = 4 seconds backoff for attempt 2.
      const nextAttemptAt = new Date(patch.next_attempt_at as string).getTime();

      expect(nextAttemptAt - before).toBeGreaterThanOrEqual(3000);
      expect(nextAttemptAt - before).toBeLessThanOrEqual(6000);
    });

    it('moves the row to dead-letter once attempt_count hits MAX_ATTEMPTS (5)', async () => {
      sendNotification.dispatch.mockRejectedValueOnce(new Error('fatal'));
      mockRpc.mockResolvedValue({
        data: [makeRow({ attempt_count: 4 })],
        error: null,
      });

      await processor.drainOnce();

      const [patch] = (updateChain.update as jest.Mock).mock.calls[0] as [
        Record<string, unknown>,
      ];

      expect(patch.status).toBe('dead');
      expect(patch.attempt_count).toBe(5);
      expect(patch.last_error).toBe('fatal');
      // dead-letter must not reschedule.
      expect(patch.next_attempt_at).toBeUndefined();
    });

    it('unknown rule_type results in a dead-letter eventually', async () => {
      mockRpc.mockResolvedValue({
        data: [
          makeRow({
            rule_type: 'unknown_type' as unknown as OutboxRow['rule_type'],
            attempt_count: 4,
          }),
        ],
        error: null,
      });

      await processor.drainOnce();

      const [patch] = (updateChain.update as jest.Mock).mock.calls[0] as [
        Record<string, unknown>,
      ];

      expect(patch.status).toBe('dead');
      expect(patch.last_error as string).toMatch(/Unknown rule_type/);
    });
  });

  describe('drainOnce — missing RPC degradation', () => {
    it('logs a warning and returns when the RPC does not exist', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: {
          code: 'PGRST202',
          message: 'Could not find the function public.drain_workflow_outbox',
        },
      });

      await expect(processor.drainOnce()).resolves.toBeUndefined();

      expect(sendNotification.dispatch).not.toHaveBeenCalled();
      expect(updateChain.update).not.toHaveBeenCalled();
    });

    it('also recognises bare PG 42883 (function does not exist) errors', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: {
          code: '42883',
          message: 'function does not exist',
        },
      });

      await expect(processor.drainOnce()).resolves.toBeUndefined();
    });
  });

  describe('drainOnce — claim_token fencing', () => {
    it('fences the completion write on the claim token when present', async () => {
      mockRpc.mockResolvedValue({
        data: [makeRow({ claim_token: 'tok-1' })],
        error: null,
      });

      await processor.drainOnce();

      expect(updateChain.eq).toHaveBeenCalledWith('status', 'in_progress');
      expect(updateChain.eq).toHaveBeenCalledWith('claim_token', 'tok-1');
      expect(updateChain.select).toHaveBeenCalledWith('id');
    });

    it('keeps the id + organization filter only when the claim has no token', async () => {
      mockRpc.mockResolvedValue({ data: [makeRow()], error: null });

      await processor.drainOnce();

      expect((updateChain.eq as jest.Mock).mock.calls).toEqual([
        ['id', 'row-1'],
        ['organization_id', 'org-1'],
      ]);
    });

    it('records nothing more when the claim was lost (0 rows updated)', async () => {
      updateChain = buildUpdateChain([]);
      mockFrom.mockImplementation(() => updateChain);
      mockRpc.mockResolvedValue({
        data: [makeRow({ claim_token: 'tok-1' })],
        error: null,
      });

      await processor.drainOnce();

      // Only the fenced success write — no failure/backoff/dead-letter write.
      expect(updateChain.update).toHaveBeenCalledTimes(1);
      expect(updateChain.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'succeeded' }),
      );
    });
  });

  describe('drain — overlap guard', () => {
    it('skips a tick while the previous one is still in flight', async () => {
      let release: (v: unknown) => void = () => {};

      mockRpc.mockReturnValueOnce(
        new Promise((res) => {
          release = res;
        }),
      );

      const tickA = processor.drain();

      await processor.drain();

      // The overlapping tick never reached the claim RPC.
      expect(mockRpc).toHaveBeenCalledTimes(1);

      release({ data: [], error: null });
      await tickA;

      // Guard released — the next tick claims again.
      mockRpc.mockResolvedValue({ data: [], error: null });
      await processor.drain();

      expect(mockRpc).toHaveBeenCalledTimes(2);
    });
  });
});
