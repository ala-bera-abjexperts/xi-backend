/**
 * @fileoverview Unit tests for AddCommentPostFunction.
 * @module src/workflow-engine/handlers/post-functions/add-comment.post.spec
 * @author Rajbha Manek
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { TemplatingService } from '../../templating/expand';
import {
  AddCommentPostFunction,
  buildTokenContext,
  type AddCommentConfig,
} from './add-comment.post';
import type { IEvaluationContext } from '../handler.types';

describe('AddCommentPostFunction', () => {
  const handler = new AddCommentPostFunction(new TemplatingService());

  const ctx = (
    overrides: Partial<IEvaluationContext> = {},
  ): IEvaluationContext => ({
    organizationId: 'org-1',
    spaceId: 'space-1',
    taskId: 'task-1',
    task: { id: 'task-1', title: 'Investigate outage' },
    transitionId: 'tx-1',
    transition: { id: 'tx-1', name: 'Resolve' },
    userId: 'user-1',
    user: { id: 'user-1', email: 'u@x.com' },
    userRoles: [],
    userGroups: [],
    customFieldValues: {},
    ...overrides,
  });

  function makeTxn(insertError: { message: string } | null = null): {
    txn: SupabaseClient;
    insert: jest.Mock;
  } {
    const insert = jest
      .fn()
      .mockResolvedValue({ data: null, error: insertError });
    const from = jest.fn().mockReturnValue({ insert });
    const txn = { from } as unknown as SupabaseClient;

    return { txn, insert };
  }

  describe('schema', () => {
    it('accepts a valid template with default as_system', () => {
      const r = handler.schema.safeParse({
        type: 'add_comment',
        template: 'Hello {{task.title}}',
      });

      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.as_system).toBe(false);
      }
    });

    it('accepts an explicit as_system flag', () => {
      const r = handler.schema.safeParse({
        type: 'add_comment',
        template: 'system message',
        as_system: true,
      });

      expect(r.success).toBe(true);
    });

    it('rejects empty template', () => {
      const r = handler.schema.safeParse({
        type: 'add_comment',
        template: '',
      });

      expect(r.success).toBe(false);
    });

    it('rejects template longer than 4000 chars', () => {
      const r = handler.schema.safeParse({
        type: 'add_comment',
        template: 'x'.repeat(4001),
      });

      expect(r.success).toBe(false);
    });

    it('rejects wrong type discriminator', () => {
      const r = handler.schema.safeParse({
        type: 'log_entry',
        template: 'hello',
      });

      expect(r.success).toBe(false);
    });
  });

  describe('run', () => {
    it('inserts an expanded comment with the current user as author', async () => {
      const { txn, insert } = makeTxn();
      const cfg: AddCommentConfig = {
        type: 'add_comment',
        template: 'Hello {{task.title}}',
        as_system: false,
      };

      await handler.run(cfg, ctx({ txn }));
      expect(insert).toHaveBeenCalledWith({
        organization_id: 'org-1',
        task_id: 'task-1',
        content: 'Hello Investigate outage',
        created_by: 'user-1',
      });
    });

    it('writes created_by=null when as_system=true', async () => {
      const { txn, insert } = makeTxn();
      const cfg: AddCommentConfig = {
        type: 'add_comment',
        template: 'workflow note',
        as_system: true,
      };

      await handler.run(cfg, ctx({ txn }));
      expect(insert).toHaveBeenCalledWith(
        expect.objectContaining({ created_by: null, content: 'workflow note' }),
      );
    });

    it('writes created_by=null when no ctx.userId is set', async () => {
      const { txn, insert } = makeTxn();
      const cfg: AddCommentConfig = {
        type: 'add_comment',
        template: 'hello',
        as_system: false,
      };

      await handler.run(cfg, ctx({ txn, userId: null }));
      expect(insert).toHaveBeenCalledWith(
        expect.objectContaining({ created_by: null }),
      );
    });

    it('leaves unknown tokens unchanged in the body', async () => {
      const { txn, insert } = makeTxn();
      const cfg: AddCommentConfig = {
        type: 'add_comment',
        template: 'Hi {{nonexistent}}',
        as_system: false,
      };

      await handler.run(cfg, ctx({ txn }));
      expect(insert).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'Hi {{nonexistent}}' }),
      );
    });

    it('throws when the insert errors', async () => {
      const { txn } = makeTxn({ message: 'insert fail' });
      const cfg: AddCommentConfig = {
        type: 'add_comment',
        template: 'hi',
        as_system: false,
      };

      await expect(handler.run(cfg, ctx({ txn }))).rejects.toThrow(
        /insert fail/,
      );
    });

    it('throws when ctx.txn is missing', async () => {
      const cfg: AddCommentConfig = {
        type: 'add_comment',
        template: 'hi',
        as_system: false,
      };

      await expect(handler.run(cfg, ctx())).rejects.toThrow(/requires ctx.txn/);
    });
  });

  describe('findReferences', () => {
    it('returns empty array', () => {
      const refs = handler.findReferences({
        type: 'add_comment',
        template: 'hi',
        as_system: false,
      });

      expect(refs).toEqual([]);
    });
  });

  describe('buildTokenContext', () => {
    it('exposes task, transition, workflow, user, and status fields', () => {
      const tokens = buildTokenContext(
        ctx({
          from_status_id: 'old',
          to_status_id: 'new',
          workflow: { id: 'wf-1', name: 'Default' },
          screen_input: { reason: 'ok' },
          customFieldValues: { 'fld-1': 1 },
        }),
      );

      expect(tokens).toEqual({
        task: { id: 'task-1', title: 'Investigate outage' },
        transition: { id: 'tx-1', name: 'Resolve' },
        workflow: { id: 'wf-1', name: 'Default' },
        user: { id: 'user-1', email: 'u@x.com' },
        from_status_id: 'old',
        to_status_id: 'new',
        custom_field_values: { 'fld-1': 1 },
        screen_input: { reason: 'ok' },
      });
    });
  });
});
