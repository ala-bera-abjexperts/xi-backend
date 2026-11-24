/**
 * @fileoverview Unit tests for TriggerWebhookPostFunction.
 * @module src/workflow-engine/handlers/post-functions/trigger-webhook.post.spec
 * @author Prince Jadiya
 */

import type { WorkflowOutboxService } from '../../../workflow-outbox/workflow-outbox.service';
import { TemplatingService } from '../../templating/expand';
import {
  TriggerWebhookPostFunction,
  type TriggerWebhookConfig,
} from './trigger-webhook.post';
import type { IEvaluationContext } from '../handler.types';

describe('TriggerWebhookPostFunction', () => {
  let outbox: jest.Mocked<WorkflowOutboxService>;
  let handler: TriggerWebhookPostFunction;

  beforeEach(() => {
    outbox = {
      enqueue: jest.fn().mockResolvedValue({ id: 'outbox-1' }),
    } as unknown as jest.Mocked<WorkflowOutboxService>;
    handler = new TriggerWebhookPostFunction(outbox, new TemplatingService());
  });

  const ctx = (
    overrides: Partial<IEvaluationContext> = {},
  ): IEvaluationContext => ({
    organizationId: 'org-1',
    spaceId: 'space-1',
    taskId: 'task-1',
    task: { id: 'task-1', title: 'Outage' },
    transitionId: 'tx-1',
    transition: { id: 'tx-1', name: 'Resolve' },
    userId: 'user-1',
    user: { id: 'user-1' },
    userRoles: [],
    userGroups: [],
    customFieldValues: {},
    ...overrides,
  });

  describe('schema', () => {
    it('accepts a minimal HTTPS config with defaults', () => {
      const r = handler.schema.safeParse({
        type: 'trigger_webhook',
        url: 'https://example.com/hook',
      });

      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.method).toBe('POST');
      }
    });

    it('accepts a full config with headers, body template, and secret', () => {
      const r = handler.schema.safeParse({
        type: 'trigger_webhook',
        url: 'https://example.com/hook',
        method: 'PUT',
        headers: { 'X-Foo': 'bar' },
        body_template: '{"task":"{{task.id}}"}',
        secret: 'shhh',
      });

      expect(r.success).toBe(true);
    });

    it('accepts a config with secret_ref instead of secret', () => {
      const r = handler.schema.safeParse({
        type: 'trigger_webhook',
        url: 'https://example.com/hook',
        secret_ref: 'webhook.default',
      });

      expect(r.success).toBe(true);
    });

    it('rejects HTTP (non-HTTPS) URL', () => {
      const r = handler.schema.safeParse({
        type: 'trigger_webhook',
        url: 'http://example.com/hook',
      });

      expect(r.success).toBe(false);
    });

    it('rejects malformed URL', () => {
      const r = handler.schema.safeParse({
        type: 'trigger_webhook',
        url: 'not-a-url',
      });

      expect(r.success).toBe(false);
    });

    it('rejects unsupported method', () => {
      const r = handler.schema.safeParse({
        type: 'trigger_webhook',
        url: 'https://example.com/hook',
        method: 'DELETE',
      });

      expect(r.success).toBe(false);
    });

    it('rejects body_template longer than 10000 chars', () => {
      const r = handler.schema.safeParse({
        type: 'trigger_webhook',
        url: 'https://example.com/hook',
        body_template: 'x'.repeat(10001),
      });

      expect(r.success).toBe(false);
    });
  });

  describe('run', () => {
    it('enqueues a trigger_webhook row carrying the raw body_template + token context', async () => {
      const cfg: TriggerWebhookConfig = {
        type: 'trigger_webhook',
        url: 'https://example.com/hook',
        method: 'POST',
        headers: { 'X-Source': 'workflow' },
        body_template: '{"task":"{{task.id}}","name":"{{transition.name}}"}',
        secret: 'shhh',
      };

      await handler.run(cfg, ctx());
      const enqueueCalls = (
        outbox.enqueue as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls;
      expect(enqueueCalls).toHaveLength(1);
      const args = enqueueCalls[0][0] as Record<string, unknown>;

      expect(args.organizationId).toBe('org-1');
      expect(args.taskId).toBe('task-1');
      expect(args.transitionId).toBe('tx-1');
      expect(args.ruleType).toBe('trigger_webhook');
      // Payload mirrors FireWebhookPayload in the dispatcher (cfg + context).
      // The dispatcher renders body_template at dispatch time so secret rotations
      // between enqueue and dispatch take effect.
      const payload = args.payload as {
        cfg: {
          url: string;
          method: string;
          headers: Record<string, string>;
          body_template?: string;
          secret?: string;
          secret_ref?: string;
        };
        context: Record<string, unknown>;
      };

      expect(payload.cfg.url).toBe('https://example.com/hook');
      expect(payload.cfg.method).toBe('POST');
      expect(payload.cfg.headers).toEqual({ 'X-Source': 'workflow' });
      expect(payload.cfg.body_template).toBe(
        '{"task":"{{task.id}}","name":"{{transition.name}}"}',
      );
      expect(payload.cfg.secret).toBe('shhh');
      expect(payload.cfg.secret_ref).toBeUndefined();
      // Token context attached for dispatcher-side template expansion.
      expect(payload.context).toBeDefined();
    });

    it('omits body_template (left undefined) so dispatcher can substitute a JSON dump fallback', async () => {
      const cfg: TriggerWebhookConfig = {
        type: 'trigger_webhook',
        url: 'https://example.com/hook',
        method: 'POST',
      };

      await handler.run(cfg, ctx());
      const payload = outbox.enqueue.mock.calls[0][0].payload as {
        cfg: { body_template?: string };
        context: Record<string, unknown>;
      };

      expect(payload.cfg.body_template).toBeUndefined();
      expect((payload.context.task as { id: string }).id).toBe('task-1');
      expect((payload.context.transition as { name: string }).name).toBe(
        'Resolve',
      );
    });

    it('forwards secret_ref untouched for later resolution', async () => {
      const cfg: TriggerWebhookConfig = {
        type: 'trigger_webhook',
        url: 'https://example.com/hook',
        method: 'POST',
        secret_ref: 'webhook.default',
      };

      await handler.run(cfg, ctx());
      const payload = outbox.enqueue.mock.calls[0][0].payload as {
        cfg: { secret?: string; secret_ref?: string };
      };

      expect(payload.cfg.secret).toBeUndefined();
      expect(payload.cfg.secret_ref).toBe('webhook.default');
    });

    it('propagates outbox failures', async () => {
      outbox.enqueue.mockRejectedValueOnce(new Error('outbox down'));
      const cfg: TriggerWebhookConfig = {
        type: 'trigger_webhook',
        url: 'https://example.com/hook',
        method: 'POST',
      };

      await expect(handler.run(cfg, ctx())).rejects.toThrow(/outbox down/);
    });

    it('throws when ctx.taskId is missing', async () => {
      const cfg: TriggerWebhookConfig = {
        type: 'trigger_webhook',
        url: 'https://example.com/hook',
        method: 'POST',
      };

      await expect(handler.run(cfg, ctx({ taskId: null }))).rejects.toThrow(
        /requires ctx.taskId/,
      );
      const enqueueCallsOnError = (
        outbox.enqueue as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls;
      expect(enqueueCallsOnError).toHaveLength(0);
    });
  });

  describe('findReferences', () => {
    it('returns empty array', () => {
      const refs = handler.findReferences({
        type: 'trigger_webhook',
        url: 'https://example.com/hook',
        method: 'POST',
      });

      expect(refs).toEqual([]);
    });
  });
});
