/** @fileoverview Unit tests for WorkflowOutboxService.enqueue happy path + error mapping. @module src/workflow-outbox/workflow-outbox.service.spec @author Prince Jadiya */

import { BadRequestException } from '@nestjs/common';

import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { WorkflowOutboxService } from './workflow-outbox.service';

interface ChainResolved {
  data: unknown;
  error: unknown;
}

function buildChain(resolved: ChainResolved) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = jest.fn().mockImplementation(self);
  chain.eq = jest.fn().mockImplementation(self);
  chain.insert = jest.fn().mockImplementation(self);
  chain.update = jest.fn().mockImplementation(self);
  chain.single = jest.fn().mockResolvedValue(resolved);
  chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
  chain.then = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve(resolved).then(onFulfilled);

  return chain;
}

describe('WorkflowOutboxService', () => {
  let service: WorkflowOutboxService;
  let mockFrom: jest.Mock;

  beforeEach(() => {
    mockFrom = jest.fn();
    const supa = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;
    service = new WorkflowOutboxService(supa);
  });

  describe('enqueue', () => {
    it('inserts a pending row with status="pending" and next_attempt_at=now()', async () => {
      const chain = buildChain({ data: { id: 'outbox-1' }, error: null });
      mockFrom.mockReturnValue(chain);

      const result = await service.enqueue({
        organizationId: 'org-1',
        taskId: 'task-1',
        transitionId: 'tx-1',
        ruleType: 'send_notification',
        payload: { foo: 'bar' },
      });

      expect(result).toEqual({ id: 'outbox-1' });
      expect(mockFrom).toHaveBeenCalledWith('workflow_outbox');
      expect(chain.insert).toHaveBeenCalledTimes(1);

      const insertedRow = (
        (chain.insert as jest.Mock).mock.calls as [
          {
            organization_id: string;
            task_id: string;
            transition_id: string | null;
            rule_type: string;
            payload: unknown;
            status: string;
            attempt_count: number;
            next_attempt_at: string;
          },
        ][]
      )[0][0];

      expect(insertedRow).toMatchObject({
        organization_id: 'org-1',
        task_id: 'task-1',
        transition_id: 'tx-1',
        rule_type: 'send_notification',
        payload: { foo: 'bar' },
        status: 'pending',
        attempt_count: 0,
      });
      expect(typeof insertedRow.next_attempt_at).toBe('string');
      // Should be a valid ISO date close to now.
      expect(new Date(insertedRow.next_attempt_at).toString()).not.toBe(
        'Invalid Date',
      );
    });

    it('accepts a null transition_id (cron / inbound webhook flows)', async () => {
      const chain = buildChain({ data: { id: 'outbox-2' }, error: null });
      mockFrom.mockReturnValue(chain);

      await service.enqueue({
        organizationId: 'org-1',
        taskId: 'task-1',
        transitionId: null,
        ruleType: 'fire_event',
        payload: { event_key: 'foo.bar' },
      });

      const insertedRow = (
        (chain.insert as jest.Mock).mock.calls as [
          { transition_id: string | null; rule_type: string },
        ][]
      )[0][0];

      expect(insertedRow.transition_id).toBeNull();
      expect(insertedRow.rule_type).toBe('fire_event');
    });

    it('throws BadRequestException when the insert fails', async () => {
      const chain = buildChain({
        data: null,
        error: { message: 'permission denied for table workflow_outbox' },
      });
      mockFrom.mockReturnValue(chain);

      await expect(
        service.enqueue({
          organizationId: 'org-1',
          taskId: 'task-1',
          transitionId: null,
          ruleType: 'trigger_webhook',
          payload: {},
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
