/**
 * @fileoverview Unit tests for LogEntryPostFunction.
 * @module src/workflow-engine/handlers/post-functions/log-entry.post.spec
 * @author Rajbha Manek
 */

import { TemplatingService } from '../../templating/expand';
import { LogEntryPostFunction, type LogEntryConfig } from './log-entry.post';
import type { IEvaluationContext } from '../handler.types';

describe('LogEntryPostFunction', () => {
  const handler = new LogEntryPostFunction(new TemplatingService());

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
    it('accepts a valid template', () => {
      const r = handler.schema.safeParse({
        type: 'log_entry',
        template: 'transition fired',
      });

      expect(r.success).toBe(true);
    });

    it('rejects empty template', () => {
      const r = handler.schema.safeParse({
        type: 'log_entry',
        template: '',
      });

      expect(r.success).toBe(false);
    });

    it('rejects template longer than 1000 chars', () => {
      const r = handler.schema.safeParse({
        type: 'log_entry',
        template: 'x'.repeat(1001),
      });

      expect(r.success).toBe(false);
    });

    it('rejects wrong type discriminator', () => {
      const r = handler.schema.safeParse({
        type: 'add_comment',
        template: 'hi',
      });

      expect(r.success).toBe(false);
    });
  });

  describe('run', () => {
    it('expands the template and writes a tagged log line', async () => {
      const log = jest
        .spyOn(
          (
            handler as unknown as {
              logger: { log: (...args: unknown[]) => void };
            }
          ).logger,
          'log',
        )
        .mockImplementation(() => undefined);
      const cfg: LogEntryConfig = {
        type: 'log_entry',
        template: 'task={{task.title}} done',
      };

      await handler.run(cfg, ctx());
      expect(log).toHaveBeenCalledTimes(1);
      const line = (log.mock.calls[0][0] as string) ?? '';

      expect(line).toContain('[workflow.log_entry]');
      expect(line).toContain('task=Outage done');
      expect(line).toContain('org=org-1');
      expect(line).toContain('transition=tx-1');
      log.mockRestore();
    });

    it('leaves unknown tokens in the rendered message', async () => {
      const log = jest
        .spyOn(
          (
            handler as unknown as {
              logger: { log: (...args: unknown[]) => void };
            }
          ).logger,
          'log',
        )
        .mockImplementation(() => undefined);
      const cfg: LogEntryConfig = {
        type: 'log_entry',
        template: 'unknown {{nope}}',
      };

      await handler.run(cfg, ctx());
      expect((log.mock.calls[0][0] as string) ?? '').toContain(
        'unknown {{nope}}',
      );
      log.mockRestore();
    });

    it('throws when ctx.taskId is missing', async () => {
      const cfg: LogEntryConfig = { type: 'log_entry', template: 'hi' };

      await expect(handler.run(cfg, ctx({ taskId: null }))).rejects.toThrow(
        /requires ctx.taskId/,
      );
    });
  });

  describe('findReferences', () => {
    it('returns empty array', () => {
      const refs = handler.findReferences({
        type: 'log_entry',
        template: 'hi',
      });

      expect(refs).toEqual([]);
    });
  });
});
