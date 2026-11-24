/**
 * @fileoverview Unit tests for SendInAppNotificationPostFunction — recipient
 * resolution, the actor fallback when recipients resolve to zero, and dedup.
 * @module src/workflow-engine/handlers/post-functions/send-inapp-notification.post.spec
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  SendInAppNotificationPostFunction,
  type SendInAppNotificationConfig,
} from './send-inapp-notification.post';
import type { IEvaluationContext } from '../handler.types';
import type { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import type { TemplatingService } from '../../templating/expand';
import type { PermissionsService } from '../../../permissions/permissions.service';

describe('SendInAppNotificationPostFunction', () => {
  const templating = {
    expand: (s: string) => s,
  } as unknown as TemplatingService;

  /**
   * Build a handler with a mocked admin client. `taskAssignedTo` is what the
   * tasks-table fallback SELECT returns for `assigned_to`; `insert` captures the
   * notifications insert payload.
   */
  function makeHandler(opts: { taskAssignedTo?: string | null } = {}): {
    handler: SendInAppNotificationPostFunction;
    insert: jest.Mock;
  } {
    const insert = jest.fn().mockReturnValue({
      select: jest
        .fn()
        .mockResolvedValue({ data: [{ id: 'n1' }], error: null }),
    });
    const tasksMaybeSingle = jest.fn().mockResolvedValue({
      data: { assigned_to: opts.taskAssignedTo ?? null },
      error: null,
    });
    const taskChain: Record<string, jest.Mock> = {};
    taskChain.eq = jest.fn().mockReturnValue(taskChain);
    taskChain.maybeSingle = tasksMaybeSingle;
    const from = jest.fn((table: string) =>
      table === 'notifications'
        ? { insert }
        : { select: jest.fn().mockReturnValue(taskChain) },
    );
    const client = { from } as unknown as SupabaseClient;
    const supabaseAdmin = {
      getClient: () => client,
    } as unknown as SupabaseAdminService;
    const handler = new SendInAppNotificationPostFunction(
      supabaseAdmin,
      templating,
    );

    return { handler, insert };
  }

  const ctx = (
    overrides: Partial<IEvaluationContext> = {},
  ): IEvaluationContext => ({
    organizationId: 'org-1',
    spaceId: 'space-1',
    taskId: 'task-1',
    task: null,
    transitionId: 'tx-1',
    transition: null,
    userId: 'actor-1',
    user: null,
    userRoles: [],
    userGroups: [],
    customFieldValues: {},
    ...overrides,
  });

  const assigneeCfg: SendInAppNotificationConfig = {
    type: 'send_inapp_notification',
    title: 'Hi',
    recipients: [{ kind: 'assignee' }],
  };

  it('notifies the assignee when the task has one', async () => {
    const { handler, insert } = makeHandler({ taskAssignedTo: 'assignee-1' });

    await handler.run(assigneeCfg, ctx({ userId: 'actor-1' }));

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({
        user_id: 'assignee-1',
        type: 'workflowTransition',
      }),
    ]);
  });

  it('falls back to the transition actor when recipients resolve to zero', async () => {
    const { handler, insert } = makeHandler({ taskAssignedTo: null });

    await handler.run(assigneeCfg, ctx({ userId: 'actor-1' }));

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({ user_id: 'actor-1' }),
    ]);
  });

  it('inserts nothing when there are zero recipients and no actor', async () => {
    const { handler, insert } = makeHandler({ taskAssignedTo: null });

    await handler.run(assigneeCfg, ctx({ userId: null }));

    expect(insert).not.toHaveBeenCalled();
  });

  it('inserts nothing when there is no taskId', async () => {
    const { handler, insert } = makeHandler();

    await handler.run(assigneeCfg, ctx({ taskId: null }));

    expect(insert).not.toHaveBeenCalled();
  });

  it('dedupes recipients that resolve to the same user', async () => {
    const { handler, insert } = makeHandler({ taskAssignedTo: 'u1' });
    const cfg: SendInAppNotificationConfig = {
      type: 'send_inapp_notification',
      title: 'Hi',
      recipients: [
        { kind: 'assignee' },
        {
          kind: 'specific_user',
          user_id: 'u1',
        },
      ],
    };

    await handler.run(cfg, ctx());

    // toHaveBeenCalledWith does an exact array match, so a single-element array
    // asserts both the content and that the duplicate was collapsed.
    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({ user_id: 'u1' }),
    ]);
  });

  // reference_id is a `uuid` column. The cron runtime fires with a composite,
  // non-uuid execution id, which must NOT be written verbatim (it 500s the
  // insert). These lock the UUID-guard.
  const TX_UUID = 'aaaaaaaa-1111-2222-3333-444444444444';
  const EXEC_UUID = 'bbbbbbbb-1111-2222-3333-555555555555';

  it('uses ctx.transitionId as reference_id when execution_id is a non-uuid cron id', async () => {
    const { handler, insert } = makeHandler({ taskAssignedTo: 'assignee-1' });

    await handler.run(
      assigneeCfg,
      ctx({
        transitionId: TX_UUID,
        execution_id: `cron:${TX_UUID}:task-1:2026-07-17T15:32:00.000Z`,
      }),
    );

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({
        reference_type: 'workflow_execution',
        reference_id: TX_UUID,
      }),
    ]);
  });

  it('uses execution_id as reference_id when it is a valid uuid', async () => {
    const { handler, insert } = makeHandler({ taskAssignedTo: 'assignee-1' });

    await handler.run(
      assigneeCfg,
      ctx({ transitionId: TX_UUID, execution_id: EXEC_UUID }),
    );

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({ reference_id: EXEC_UUID }),
    ]);
  });

  it('falls back to ctx.transitionId when execution_id is undefined', async () => {
    const { handler, insert } = makeHandler({ taskAssignedTo: 'assignee-1' });

    await handler.run(assigneeCfg, ctx({ transitionId: TX_UUID }));

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({ reference_id: TX_UUID }),
    ]);
  });

  it('org-scopes and access-filters watcher recipients', async () => {
    const makeChain = (result: { data: unknown; error: unknown }) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = jest.fn(self);
      chain.eq = jest.fn(self);
      chain.in = jest.fn(self);
      chain.insert = jest.fn(self);
      chain.then = (fn: (value: unknown) => unknown) =>
        Promise.resolve(result).then(fn);
      return chain as Record<string, jest.Mock> & PromiseLike<unknown>;
    };
    const watcherChain = makeChain({
      data: [{ user_id: 'allowed' }, { user_id: 'actor-1' }],
      error: null,
    });
    const memberChain = makeChain({
      data: [
        { user_id: 'allowed', users: { is_active: true } },
        { user_id: 'actor-1', users: { is_active: true } },
      ],
      error: null,
    });
    const notificationChain = makeChain({ data: [{ id: 'n1' }], error: null });
    const taskChain = makeChain({
      data: { space_id: null },
      error: null,
    });
    taskChain.maybeSingle = jest
      .fn()
      .mockResolvedValue({ data: { space_id: null }, error: null });
    const from = jest.fn((table: string) => {
      if (table === 'tasks') return taskChain;
      if (table === 'task_watchers') return watcherChain;
      if (table === 'organization_members') return memberChain;
      if (table === 'notifications') return notificationChain;
      throw new Error(`Unexpected table ${table}`);
    });
    const effectivePermissions = jest.fn().mockResolvedValue({
      effective_permissions: { can_view_tasks: true },
    });
    const permissions = {
      getUserSpacePermissions: jest.fn((userId: string) =>
        Promise.resolve({
          isMember: userId === 'allowed',
          permissions: { view_tasks: userId === 'allowed' },
        }),
      ),
      getUserEffectivePermissions: effectivePermissions,
    } as unknown as PermissionsService;
    const handler = new SendInAppNotificationPostFunction(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      templating,
      undefined,
      permissions,
    );

    await handler.run(
      {
        type: 'send_inapp_notification',
        title: 'Hi',
        recipients: [{ kind: 'watchers' }],
      },
      ctx(),
    );

    expect(watcherChain.eq).toHaveBeenCalledWith('organization_id', 'org-1');
    expect(taskChain.eq).toHaveBeenCalledWith('organization_id', 'org-1');
    expect(notificationChain.insert).toHaveBeenCalledWith([
      expect.objectContaining({ user_id: 'allowed' }),
    ]);
    expect(memberChain.in).toHaveBeenCalledWith('user_id', ['allowed']);
    expect(effectivePermissions).toHaveBeenCalledWith('allowed', 'org-1');
  });

  it('does not fall back to the actor when explicit watchers resolve empty', async () => {
    const { handler, insert } = makeHandler();
    Reflect.set(handler, 'resolveRecipients', jest.fn().mockResolvedValue([]));

    await handler.run(
      {
        type: 'send_inapp_notification',
        title: 'Hi',
        recipients: [{ kind: 'watchers' }],
      },
      ctx({ userId: 'actor-1' }),
    );

    expect(insert).not.toHaveBeenCalled();
  });
});
