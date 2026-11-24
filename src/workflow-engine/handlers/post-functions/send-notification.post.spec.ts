/**
 * @fileoverview Unit tests for SendNotificationPostFunction.
 * @module src/workflow-engine/handlers/post-functions/send-notification.post.spec
 * @author Prince Jadiya
 */

import type { WorkflowOutboxService } from '../../../workflow-outbox/workflow-outbox.service';
import { TemplatingService } from '../../templating/expand';
import {
  SendNotificationPostFunction,
  type SendNotificationConfig,
} from './send-notification.post';
import type { IEvaluationContext } from '../handler.types';

describe('SendNotificationPostFunction', () => {
  const userId = '123e4567-e89b-12d3-a456-426614174000';
  const groupId = '123e4567-e89b-12d3-a456-426614174001';
  const roleId = '123e4567-e89b-12d3-a456-426614174002';

  let outbox: jest.Mocked<WorkflowOutboxService>;
  let handler: SendNotificationPostFunction;

  beforeEach(() => {
    outbox = {
      enqueue: jest.fn().mockResolvedValue({ id: 'outbox-1' }),
    } as unknown as jest.Mocked<WorkflowOutboxService>;
    handler = new SendNotificationPostFunction(outbox, new TemplatingService());
  });

  const ctx = (
    overrides: Partial<IEvaluationContext> = {},
  ): IEvaluationContext => ({
    organizationId: 'org-1',
    spaceId: 'space-1',
    taskId: 'task-1',
    task: { id: 'task-1', title: 'Critical bug' },
    transitionId: 'tx-1',
    transition: { id: 'tx-1', name: 'Escalate' },
    userId: 'user-1',
    user: { id: 'user-1', email: 'u@x.com' },
    userRoles: [],
    userGroups: [],
    customFieldValues: {},
    ...overrides,
  });

  describe('schema', () => {
    it('accepts a single assignee recipient with defaults', () => {
      const r = handler.schema.safeParse({
        type: 'send_notification',
        recipients: [{ kind: 'assignee' }],
        subject: 'Hi',
        body: 'Body',
      });

      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.attach_task_as_pdf).toBe(false);
      }
    });

    it('accepts a mixed recipient list', () => {
      const r = handler.schema.safeParse({
        type: 'send_notification',
        recipients: [
          { kind: 'reporter' },
          { kind: 'watchers' },
          { kind: 'specific_user', user_id: userId },
          { kind: 'specific_group', group_id: groupId },
          { kind: 'role', role_id: roleId },
        ],
        subject: 'Hi',
        body: 'Body',
        attach_task_as_pdf: true,
      });

      expect(r.success).toBe(true);
    });

    it('rejects empty recipients list', () => {
      const r = handler.schema.safeParse({
        type: 'send_notification',
        recipients: [],
        subject: 'Hi',
        body: 'Body',
      });

      expect(r.success).toBe(false);
    });

    it('rejects more than 20 recipients', () => {
      const recipients = Array.from({ length: 21 }, () => ({
        kind: 'assignee' as const,
      }));
      const r = handler.schema.safeParse({
        type: 'send_notification',
        recipients,
        subject: 'Hi',
        body: 'Body',
      });

      expect(r.success).toBe(false);
    });

    it('rejects specific_user without user_id', () => {
      const r = handler.schema.safeParse({
        type: 'send_notification',
        recipients: [{ kind: 'specific_user' }],
        subject: 'Hi',
        body: 'Body',
      });

      expect(r.success).toBe(false);
    });

    it('rejects empty subject', () => {
      const r = handler.schema.safeParse({
        type: 'send_notification',
        recipients: [{ kind: 'assignee' }],
        subject: '',
        body: 'Body',
      });

      expect(r.success).toBe(false);
    });

    it('rejects subject longer than 200 chars', () => {
      const r = handler.schema.safeParse({
        type: 'send_notification',
        recipients: [{ kind: 'assignee' }],
        subject: 'x'.repeat(201),
        body: 'Body',
      });

      expect(r.success).toBe(false);
    });

    it('rejects body longer than 10000 chars', () => {
      const r = handler.schema.safeParse({
        type: 'send_notification',
        recipients: [{ kind: 'assignee' }],
        subject: 'Hi',
        body: 'x'.repeat(10001),
      });

      expect(r.success).toBe(false);
    });
  });

  describe('run', () => {
    it('enqueues a workflow_outbox row with rendered subject and body', async () => {
      const cfg: SendNotificationConfig = {
        type: 'send_notification',
        recipients: [{ kind: 'assignee' }],
        subject: 'Update: {{task.title}}',
        body: 'Task {{task.title}} moved on transition {{transition.name}}',
        attach_task_as_pdf: false,
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
      expect(args.ruleType).toBe('send_notification');
      // Payload mirrors the dispatcher's SendNotificationPayload (cfg + context wrap).
      const payload = args.payload as {
        cfg: {
          subject: string;
          body: string;
          recipients: unknown[];
          attach_task_as_pdf?: boolean;
        };
        context: Record<string, unknown>;
      };

      expect(payload.cfg).toEqual({
        subject: 'Update: Critical bug',
        body: 'Task Critical bug moved on transition Escalate',
        recipients: [{ kind: 'assignee' }],
        attach_task_as_pdf: false,
      });
      expect(payload.context).toBeDefined();
    });

    it('forwards multiple recipient kinds verbatim', async () => {
      const cfg: SendNotificationConfig = {
        type: 'send_notification',
        recipients: [
          { kind: 'assignee' },
          { kind: 'specific_user', user_id: userId },
          { kind: 'role', role_id: roleId },
        ],
        subject: 'Hi',
        body: 'Body',
        attach_task_as_pdf: true,
      };

      await handler.run(cfg, ctx());
      const args = outbox.enqueue.mock.calls[0][0];
      const payload = args.payload as {
        cfg: { recipients: unknown[]; attach_task_as_pdf: boolean };
      };

      expect(payload.cfg.recipients).toEqual(cfg.recipients);
      expect(payload.cfg.attach_task_as_pdf).toBe(true);
    });

    it('propagates outbox failures', async () => {
      outbox.enqueue.mockRejectedValueOnce(new Error('outbox down'));
      const cfg: SendNotificationConfig = {
        type: 'send_notification',
        recipients: [{ kind: 'assignee' }],
        subject: 'Hi',
        body: 'Body',
        attach_task_as_pdf: false,
      };

      await expect(handler.run(cfg, ctx())).rejects.toThrow(/outbox down/);
    });

    it('throws when ctx.taskId is missing', async () => {
      const cfg: SendNotificationConfig = {
        type: 'send_notification',
        recipients: [{ kind: 'assignee' }],
        subject: 'Hi',
        body: 'Body',
        attach_task_as_pdf: false,
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
    it('returns specific user/group/role refs and skips assignee/reporter/watchers', () => {
      const refs = handler.findReferences({
        type: 'send_notification',
        recipients: [
          { kind: 'assignee' },
          { kind: 'reporter' },
          { kind: 'watchers' },
          { kind: 'specific_user', user_id: userId },
          { kind: 'specific_group', group_id: groupId },
          { kind: 'role', role_id: roleId },
        ],
        subject: 'Hi',
        body: 'Body',
        attach_task_as_pdf: false,
      });

      expect(refs).toEqual([
        { kind: 'user', id: userId },
        { kind: 'group', id: groupId },
        { kind: 'role', id: roleId },
      ]);
    });

    it('returns empty when all recipients are role-relative', () => {
      const refs = handler.findReferences({
        type: 'send_notification',
        recipients: [
          { kind: 'assignee' },
          { kind: 'reporter' },
          { kind: 'watchers' },
        ],
        subject: 'Hi',
        body: 'Body',
        attach_task_as_pdf: false,
      });

      expect(refs).toEqual([]);
    });
  });
});
