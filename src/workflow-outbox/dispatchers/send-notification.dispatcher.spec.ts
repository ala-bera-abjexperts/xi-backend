/** @fileoverview Unit tests for SendNotificationDispatcher — fan-out, idempotency, email failure. @module src/workflow-outbox/dispatchers/send-notification.dispatcher.spec @author Rajbha Manek */

import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import type { MailService } from '../../mail/mail.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { PermissionsService } from '../../permissions/permissions.service';
import { TemplatingService } from '../../workflow-engine/templating/expand';
import {
  SendNotificationDispatcher,
  type SendNotificationPayload,
} from './send-notification.dispatcher';

/** Build a thenable chain with terminal `.maybeSingle()` and awaitable behaviour. */
function buildChain(resolved: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = jest.fn().mockImplementation(self);
  chain.eq = jest.fn().mockImplementation(self);
  chain.in = jest.fn().mockImplementation(self);
  chain.limit = jest.fn().mockImplementation(self);
  chain.insert = jest.fn().mockImplementation(self);
  chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
  chain.single = jest.fn().mockResolvedValue(resolved);
  chain.then = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve(resolved).then(onFulfilled);

  return chain;
}

describe('SendNotificationDispatcher', () => {
  let dispatcher: SendNotificationDispatcher;
  let mockFrom: jest.Mock;
  let mailService: { sendNotification: jest.Mock };

  /** Per-call response map keyed by table name. */
  let responses: Record<string, ReturnType<typeof buildChain>>;

  beforeEach(() => {
    mockFrom = jest.fn();
    const supa = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;

    mailService = {
      sendNotification: jest.fn().mockResolvedValue(undefined),
    };

    const configService = {
      get: jest.fn().mockReturnValue('https://app.test'),
    } as unknown as ConfigService;

    dispatcher = new SendNotificationDispatcher(
      supa,
      mailService as unknown as MailService,
      new TemplatingService(),
      configService,
    );

    responses = {};
    // No preference rows = nobody has opted out, so every existing test keeps
    // its "email is sent" expectation. Override per-test to opt someone out.
    responses.notification_preferences = buildChain({ data: [], error: null });
    mockFrom.mockImplementation((table: string) => {
      const chain = responses[table];

      if (!chain) {
        throw new Error(`No mock response configured for table "${table}"`);
      }

      return chain;
    });
  });

  function row(payload: SendNotificationPayload) {
    return {
      id: 'outbox-1',
      organization_id: 'org-1',
      task_id: 'task-1',
      transition_id: 'tx-1',
      payload,
    };
  }

  it('fans out to assignee + reporter + specific_user, inserts one notification each, sends one email each', async () => {
    responses.tasks = buildChain({
      data: {
        assigned_to: 'user-a',
        reporter: 'user-b',
        created_by: null,
        key: 'TASK-1',
        space_id: 'space-1',
      },
      error: null,
    });
    responses.spaces = buildChain({ data: { key: 'SP' }, error: null });
    responses.users = buildChain({
      data: [
        {
          id: 'user-a',
          email: 'a@example.com',
          first_name: 'Alice',
          language: 'de',
        },
        {
          id: 'user-b',
          email: 'b@example.com',
          first_name: 'Bob',
          language: 'en',
        },
        {
          id: 'user-c',
          email: 'c@example.com',
          first_name: null,
          language: null,
        },
      ],
      error: null,
    });
    responses.notifications = buildChain({ data: null, error: null });

    await dispatcher.dispatch(
      row({
        cfg: {
          recipients: [
            { kind: 'assignee' },
            { kind: 'reporter' },
            { kind: 'specific_user', user_id: 'user-c' },
          ],
          subject: 'Hi {{task.title}}',
          body: 'Body for {{task.title}}',
        },
        context: { task: { title: 'Ship it' } },
      }),
    );

    // ENG-H5: idempotency lookup + insert are BATCHED regardless of recipient
    // count. On the mock chain, `.select` is hit twice when an insert happens:
    // once for the `.select('user_id')` idempotency lookup and once for the
    // `.insert(rows).select()` returning-rows call — never per-recipient.
    expect(responses.notifications.select).toHaveBeenCalledTimes(2);
    expect(responses.notifications.insert).toHaveBeenCalledTimes(1);
    expect(mailService.sendNotification).toHaveBeenCalledTimes(3);
    // The email is rendered through the branded notification template with the
    // recipient's greeting + locale and a deep link to the task.
    expect(mailService.sendNotification).toHaveBeenCalledWith(
      'a@example.com',
      expect.objectContaining({
        title: 'Hi Ship it',
        body: 'Body for Ship it',
        subject: 'Hi Ship it',
        recipientName: 'Alice',
        eyebrow: 'TASK-1',
        ctaUrl: 'https://app.test/spaces/SP/tasks/view/TASK-1',
      }),
      { organizationId: 'org-1', locale: 'de' },
    );
    // A recipient with no first_name still gets an email, just without a greeting.
    expect(mailService.sendNotification).toHaveBeenCalledWith(
      'c@example.com',
      expect.objectContaining({ recipientName: undefined }),
      { organizationId: 'org-1', locale: null },
    );
  });

  it('skips the email for a recipient who opted out, but still inserts the in-app row', async () => {
    responses.tasks = buildChain({
      data: {
        assigned_to: 'user-a',
        reporter: 'user-b',
        created_by: null,
        key: 'TASK-1',
        space_id: 'space-1',
      },
      error: null,
    });
    responses.spaces = buildChain({ data: { key: 'SP' }, error: null });
    responses.users = buildChain({
      data: [
        { id: 'user-a', email: 'a@example.com', first_name: 'Alice' },
        { id: 'user-b', email: 'b@example.com', first_name: 'Bob' },
      ],
      error: null,
    });
    responses.notifications = buildChain({ data: null, error: null });
    // Alice turned workflow-transition email off; Bob has no row at all.
    responses.notification_preferences = buildChain({
      data: [{ user_id: 'user-a', email: false }],
      error: null,
    });

    await dispatcher.dispatch(
      row({
        cfg: {
          recipients: [{ kind: 'assignee' }, { kind: 'reporter' }],
          subject: 'Hi',
          body: 'Body',
        },
        context: {},
      }),
    );

    // In-app delivery is unaffected — the preference gates email only, and the
    // insert is still a single batched call for both recipients.
    expect(responses.notifications.insert).toHaveBeenCalledTimes(1);

    expect(mailService.sendNotification).toHaveBeenCalledTimes(1);
    expect(mailService.sendNotification).toHaveBeenCalledWith(
      'b@example.com',
      expect.anything(),
      expect.anything(),
    );
    expect(mailService.sendNotification).not.toHaveBeenCalledWith(
      'a@example.com',
      expect.anything(),
      expect.anything(),
    );
  });

  it('caps fan-out at 500 recipients', async () => {
    const groupMembers = Array.from({ length: 700 }, (_, i) => ({
      user_id: `user-${i}`,
    }));
    const allUsers = groupMembers.map((m) => ({
      id: m.user_id,
      email: `${m.user_id}@example.com`,
    }));

    responses.tasks = buildChain({
      data: { assigned_to: null, reporter: null, created_by: null },
      error: null,
    });
    responses.user_group_members = buildChain({
      data: groupMembers,
      error: null,
    });
    responses.users = buildChain({ data: allUsers.slice(0, 500), error: null });
    responses.notifications = buildChain({ data: null, error: null });

    await dispatcher.dispatch(
      row({
        cfg: {
          recipients: [{ kind: 'specific_group', group_id: 'group-1' }],
          subject: 'S',
          body: 'B',
        },
        context: {},
      }),
    );

    // Confirm we capped at 500: the idempotency lookup is a single batched
    // SELECT then a single INSERT (which chains `.select()`), so `.select` is
    // hit twice — NOT 700 times — and emails are sent once per capped recipient.
    expect(responses.notifications.select).toHaveBeenCalledTimes(2);
    expect(responses.notifications.insert).toHaveBeenCalledTimes(1);
    expect(mailService.sendNotification).toHaveBeenCalledTimes(500);
  });

  it('skips in-app insert when an idempotency match already exists', async () => {
    responses.tasks = buildChain({
      data: { assigned_to: 'user-a', reporter: null, created_by: null },
      error: null,
    });
    responses.users = buildChain({
      data: [{ id: 'user-a', email: 'a@example.com' }],
      error: null,
    });
    // Existing row found for this user — batched lookup returns the matching
    // user_id, so the batched insert has nothing to write.
    responses.notifications = buildChain({
      data: [{ user_id: 'user-a' }],
      error: null,
    });

    await dispatcher.dispatch(
      row({
        cfg: {
          recipients: [{ kind: 'assignee' }],
          subject: 'S',
          body: 'B',
        },
        context: {},
      }),
    );

    expect(responses.notifications.insert).not.toHaveBeenCalled();
    // Email is still sent — idempotency only protects the in-app row.
    expect(mailService.sendNotification).toHaveBeenCalledTimes(1);
  });

  it('re-throws when sendNotification rejects so the processor retries', async () => {
    responses.tasks = buildChain({
      data: { assigned_to: 'user-a', reporter: null, created_by: null },
      error: null,
    });
    responses.users = buildChain({
      data: [{ id: 'user-a', email: 'a@example.com' }],
      error: null,
    });
    responses.notifications = buildChain({ data: null, error: null });

    mailService.sendNotification.mockRejectedValue(new Error('smtp timeout'));

    await expect(
      dispatcher.dispatch(
        row({
          cfg: {
            recipients: [{ kind: 'assignee' }],
            subject: 'S',
            body: 'B',
          },
          context: {},
        }),
      ),
    ).rejects.toThrow('smtp timeout');
  });

  it('logs and skips the PDF attachment in v1', async () => {
    // ENG-M8: the dispatcher now logs via the Nest Logger (not console.warn).
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    responses.tasks = buildChain({
      data: { assigned_to: 'user-a', reporter: null, created_by: null },
      error: null,
    });
    responses.users = buildChain({
      data: [{ id: 'user-a', email: 'a@example.com' }],
      error: null,
    });
    responses.notifications = buildChain({ data: null, error: null });

    await dispatcher.dispatch(
      row({
        cfg: {
          recipients: [{ kind: 'assignee' }],
          subject: 'S',
          body: 'B',
          attach_task_as_pdf: true,
        },
        context: {},
      }),
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('attach_task_as_pdf=true ignored'),
    );

    warnSpy.mockRestore();
  });

  it('H4 — filters specific_group lookup by user_groups.organization_id (no cross-org leak)', async () => {
    // We assert the query shape rather than the result set — the dispatcher
    // builds a `.from(user_group_members).select(user_id, user_groups!inner(...))
    // .eq(group_id, …).eq(user_groups.organization_id, ORG_ID)` chain.
    const groupChain = buildChain({
      data: [{ user_id: 'user-a' }],
      error: null,
    });

    responses.tasks = buildChain({
      data: { assigned_to: null, reporter: null, created_by: null },
      error: null,
    });
    responses.user_group_members = groupChain;
    responses.users = buildChain({
      data: [{ id: 'user-a', email: 'a@example.com' }],
      error: null,
    });
    responses.notifications = buildChain({ data: null, error: null });

    await dispatcher.dispatch(
      row({
        cfg: {
          recipients: [{ kind: 'specific_group', group_id: 'group-1' }],
          subject: 'S',
          body: 'B',
        },
        context: {},
      }),
    );

    // The chain's .select MUST include the inner join hint that scopes by org.
    expect(groupChain.select).toHaveBeenCalledWith(
      expect.stringContaining('user_groups!inner(organization_id)'),
    );
    // Two .eq calls: group_id + the org-scoped column on the joined table.
    expect(groupChain.eq).toHaveBeenCalledWith('group_id', 'group-1');
    expect(groupChain.eq).toHaveBeenCalledWith(
      'user_groups.organization_id',
      expect.any(String),
    );
  });

  it('scopes watcher rows to the org and drops inactive or revoked watchers', async () => {
    const taskWatchers = buildChain({
      data: [
        { user_id: 'allowed' },
        { user_id: 'revoked' },
        { user_id: 'inactive' },
        { user_id: 'actor' },
      ],
      error: null,
    });
    responses.tasks = buildChain({
      data: {
        assigned_to: null,
        reporter: null,
        created_by: null,
        key: 'TASK-1',
        space_id: null,
      },
      error: null,
    });
    responses.task_watchers = taskWatchers;
    responses.organization_members = buildChain({
      data: [
        { user_id: 'allowed', users: { is_active: true } },
        { user_id: 'revoked', users: { is_active: true } },
        { user_id: 'inactive', users: { is_active: false } },
        { user_id: 'actor', users: { is_active: true } },
      ],
      error: null,
    });
    responses.users = buildChain({
      data: [{ id: 'allowed', email: 'allowed@example.com' }],
      error: null,
    });
    responses.spaces = buildChain({ data: { key: 'SP' }, error: null });
    responses.notifications = buildChain({ data: null, error: null });
    const permissions = {
      getUserSpacePermissions: jest.fn((userId: string) =>
        Promise.resolve({
          isMember: userId === 'allowed',
          permissions: { view_tasks: userId === 'allowed' },
        }),
      ),
      getUserEffectivePermissions: jest.fn((userId: string) =>
        Promise.resolve({
          effective_permissions: { can_view_tasks: userId === 'allowed' },
        }),
      ),
    } as unknown as PermissionsService;
    dispatcher = new SendNotificationDispatcher(
      {
        getClient: () => ({ from: mockFrom }),
      } as unknown as SupabaseAdminService,
      mailService as unknown as MailService,
      new TemplatingService(),
      {
        get: jest.fn().mockReturnValue('https://app.test'),
      } as unknown as ConfigService,
      undefined,
      permissions,
    );

    await dispatcher.dispatch(
      row({
        cfg: { recipients: [{ kind: 'watchers' }], subject: 'S', body: 'B' },
        context: { user: { userId: 'actor' } },
      }),
    );

    expect(taskWatchers.eq).toHaveBeenCalledWith('organization_id', 'org-1');
    expect(responses.tasks.eq).toHaveBeenCalledWith('organization_id', 'org-1');
    expect(responses.organization_members.in).toHaveBeenCalledWith('user_id', [
      'allowed',
      'revoked',
      'inactive',
    ]);
    expect(responses.notifications.insert).toHaveBeenCalledWith([
      expect.objectContaining({ user_id: 'allowed' }),
    ]);
  });
});
