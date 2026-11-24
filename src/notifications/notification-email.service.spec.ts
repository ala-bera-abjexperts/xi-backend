import type { ConfigService } from '@nestjs/config';
import { readFileSync } from 'fs';
import { join } from 'path';

import type { MailService } from '../mail/mail.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { NotificationEmailService } from './notification-email.service';

/** Thenable Supabase-query stub resolving to `{ data, error }`. */
function chain(resolved: { data: unknown; error?: unknown }) {
  const c: Record<string, unknown> = {};
  const self = () => c;
  c.select = jest.fn().mockImplementation(self);
  c.in = jest.fn().mockImplementation(self);
  c.eq = jest.fn().mockImplementation(self);
  c.maybeSingle = jest.fn().mockResolvedValue({ error: null, ...resolved });
  c.then = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve({ error: null, ...resolved }).then(onFulfilled);

  return c;
}

describe('NotificationEmailService', () => {
  let service: NotificationEmailService;
  let mail: { sendNotification: jest.Mock };
  let responses: Record<string, ReturnType<typeof chain>>;
  let fromMock: jest.Mock;

  beforeEach(() => {
    // No slug by default → links keep the configured app URL (fallback path).
    responses = { organizations: chain({ data: [] }) };
    fromMock = jest.fn((table: string) => {
      if (!responses[table]) throw new Error(`no mock for table "${table}"`);

      return responses[table];
    });
    const supa = {
      getClient: () => ({ from: fromMock }),
    } as unknown as SupabaseAdminService;
    mail = { sendNotification: jest.fn().mockResolvedValue(undefined) };
    const config = {
      get: jest.fn().mockReturnValue('https://app.test'),
    } as unknown as ConfigService;

    service = new NotificationEmailService(
      supa,
      mail as unknown as MailService,
      config,
    );
  });

  function row(over: Record<string, unknown> = {}) {
    return {
      organization_id: 'org-1',
      user_id: 'user-a',
      type: 'task_mention',
      title: 'Alice mentioned you',
      body: 'hello',
      reference_type: 'task',
      reference_id: 'task-uuid',
      metadata: { space_key: 'ENG', entity_key: 'ENG-1' },
      ...over,
    };
  }

  it('sends a branded email with greeting, locale, and CTA for a mention', async () => {
    responses.users = chain({
      data: [
        { id: 'user-a', email: 'a@x.com', first_name: 'Alice', language: 'de' },
      ],
    });
    responses.notification_preferences = chain({ data: [] });

    await service.emailForNotifications([row()]);

    expect(mail.sendNotification).toHaveBeenCalledTimes(1);
    expect(mail.sendNotification).toHaveBeenCalledWith(
      'a@x.com',
      expect.objectContaining({
        title: 'Alice mentioned you',
        body: 'hello',
        recipientName: 'Alice',
        ctaUrl: 'https://app.test/spaces/ENG/tasks/view/ENG-1',
      }),
      { organizationId: 'org-1', locale: 'de' },
    );
  });

  it("links to the organization's own host, not app. (XE-T728)", async () => {
    responses.users = chain({
      data: [
        { id: 'user-a', email: 'a@x.com', first_name: 'Alice', language: 'en' },
      ],
    });
    responses.notification_preferences = chain({ data: [] });
    responses.organizations = chain({
      data: [{ id: 'org-1', slug: 'acme' }],
    });

    await service.emailForNotifications([row()]);

    expect(mail.sendNotification).toHaveBeenCalledWith(
      'a@x.com',
      expect.objectContaining({
        ctaUrl: 'https://acme.test/spaces/ENG/tasks/view/ENG-1',
      }),
      expect.anything(),
    );
  });

  it('sends watcher updates through the watcher_updates preference', async () => {
    responses.users = chain({
      data: [
        { id: 'user-a', email: 'a@x.com', first_name: 'Alice', language: 'en' },
      ],
    });
    responses.notification_preferences = chain({ data: [] });

    await service.emailForNotifications([row({ type: 'watcher_updates' })]);

    expect(mail.sendNotification).toHaveBeenCalledTimes(1);
  });

  it('skips when the email preference for that type is disabled', async () => {
    responses.users = chain({
      data: [
        { id: 'user-a', email: 'a@x.com', first_name: 'A', language: 'en' },
      ],
    });
    responses.notification_preferences = chain({
      data: [
        {
          user_id: 'user-a',
          organization_id: 'org-1',
          notification_type: 'task_mention',
          email: false,
        },
      ],
    });

    await service.emailForNotifications([row()]);

    expect(mail.sendNotification).not.toHaveBeenCalled();
  });

  it('skips recipients with no email address', async () => {
    responses.users = chain({
      data: [{ id: 'user-a', email: null, first_name: 'A', language: 'en' }],
    });
    responses.notification_preferences = chain({ data: [] });

    await service.emailForNotifications([row()]);

    expect(mail.sendNotification).not.toHaveBeenCalled();
  });

  it('never throws when a send fails and keeps sending the rest of the batch', async () => {
    responses.users = chain({
      data: [
        { id: 'user-a', email: 'a@x.com', first_name: 'A', language: 'en' },
        { id: 'user-b', email: 'b@x.com', first_name: 'B', language: 'en' },
      ],
    });
    responses.notification_preferences = chain({ data: [] });
    mail.sendNotification.mockRejectedValueOnce(new Error('smtp down'));

    await expect(
      service.emailForNotifications([row(), row({ user_id: 'user-b' })]),
    ).resolves.toBeUndefined();
    // First rejected, second still attempted — the batch is not aborted.
    expect(mail.sendNotification).toHaveBeenCalledTimes(2);
  });

  it('ignores non-emailable types without any query or email', async () => {
    await service.emailForNotifications([row({ type: 'workflowTransition' })]);

    expect(mail.sendNotification).not.toHaveBeenCalled();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it.each(['chat_mention', 'chat_dm', 'chat_summary'])(
    'never emails %s at once: chat sends its own delayed email without message text',
    async (type) => {
      await service.emailForNotifications([row({ type, body: null })]);

      expect(mail.sendNotification).not.toHaveBeenCalled();
      expect(fromMock).not.toHaveBeenCalled();
    },
  );

  it('omits the CTA button when metadata lacks link keys', async () => {
    responses.users = chain({
      data: [
        { id: 'user-a', email: 'a@x.com', first_name: 'A', language: 'en' },
      ],
    });
    responses.notification_preferences = chain({ data: [] });

    await service.emailForNotifications([row({ metadata: {} })]);

    expect(mail.sendNotification).toHaveBeenCalledWith(
      'a@x.com',
      expect.objectContaining({ ctaUrl: undefined }),
      expect.anything(),
    );
  });

  it('maps management_letter_* to the management_letter preference key', async () => {
    responses.users = chain({
      data: [
        { id: 'user-a', email: 'a@x.com', first_name: 'A', language: 'en' },
      ],
    });
    responses.notification_preferences = chain({
      data: [
        {
          user_id: 'user-a',
          organization_id: 'org-1',
          notification_type: 'management_letter',
          email: false,
        },
      ],
    });

    await service.emailForNotifications([
      row({
        type: 'management_letter_assigned',
        reference_type: 'portfolio_management_letter',
        reference_id: 'letter-1',
        metadata: { portfolio_key: 'PF' },
      }),
    ]);

    // Gated by the mapped `management_letter` preference.
    expect(mail.sendNotification).not.toHaveBeenCalled();
  });

  it('defaults to sending when no preference row exists', async () => {
    responses.users = chain({
      data: [
        { id: 'user-a', email: 'a@x.com', first_name: 'A', language: 'en' },
      ],
    });
    responses.notification_preferences = chain({ data: [] });

    await service.emailForNotifications([row()]);

    expect(mail.sendNotification).toHaveBeenCalledTimes(1);
  });

  // isEmailEnabled — used by space-invitation + reminder gating.
  describe('isEmailEnabled', () => {
    it('returns the stored email flag', async () => {
      responses.notification_preferences = chain({ data: { email: false } });

      await expect(
        service.isEmailEnabled('user-a', 'org-1', 'space_invitation'),
      ).resolves.toBe(false);
    });

    it('defaults to true when no preference row exists', async () => {
      responses.notification_preferences = chain({ data: null });

      await expect(
        service.isEmailEnabled('user-a', 'org-1', 'file_explorer_reminder'),
      ).resolves.toBe(true);
    });

    it('fails open (true) on a lookup error', async () => {
      const throwing = chain({ data: null });
      throwing.maybeSingle = jest.fn().mockRejectedValue(new Error('db down'));
      responses.notification_preferences = throwing;

      await expect(
        service.isEmailEnabled('user-a', 'org-1', 'space_invitation'),
      ).resolves.toBe(true);
    });
  });

  describe('git development notifications (ticket 9)', () => {
    /** The real mail catalogs, interpolated like EmailTemplateService does. */
    const catalogs: Record<string, Record<string, string>> = {
      en: JSON.parse(
        readFileSync(join(__dirname, '../mail/i18n/en.json'), 'utf8'),
      ) as Record<string, string>,
      de: JSON.parse(
        readFileSync(join(__dirname, '../mail/i18n/de.json'), 'utf8'),
      ) as Record<string, string>,
    };
    const translate = (
      locale: string | null,
      key: string,
      vars: Record<string, unknown> = {},
    ) =>
      (catalogs[locale ?? 'en']?.[key] ?? catalogs.en[key] ?? key).replace(
        /\{(\w+)\}/g,
        (_m, k: string) => String(vars[k] ?? ''),
      );
    const gitRow = (over: Record<string, unknown> = {}) =>
      row({
        type: 'git_build_failed',
        title: 'stored',
        body: 'stored',
        metadata: {
          space_key: 'XE',
          task_key: 'XE-T1',
          provider: 'github',
          count: 1,
          subject: {
            title: 'CI',
            branch: 'XE-T1-ci',
            repository: 'acme/api',
            url: 'https://github.com/acme/api/actions/runs/1',
          },
        },
        ...over,
      });

    beforeEach(() => {
      (mail as unknown as { translate: jest.Mock }).translate =
        jest.fn(translate);
    });

    it("build failed: emailed by default in the recipient's language, with task and build links", async () => {
      responses.users = chain({
        data: [
          {
            id: 'user-a',
            email: 'a@x.com',
            first_name: 'Anna',
            language: 'de',
          },
        ],
      });
      responses.notification_preferences = chain({ data: [] });

      await service.emailForNotifications([gitRow()]);

      expect(mail.sendNotification).toHaveBeenCalledWith(
        'a@x.com',
        expect.objectContaining({
          title: 'Build fehlgeschlagen · XE-T1',
          body: 'Der Build „CI“ ist auf Branch XE-T1-ci in acme/api fehlgeschlagen.',
          ctaUrl: 'https://app.test/spaces/XE/tasks/view/XE-T1',
          secondaryUrl: 'https://github.com/acme/api/actions/runs/1',
          secondaryLabel: 'Build ansehen',
        }),
        { organizationId: 'org-1', locale: 'de' },
      );
    });

    it('pull request merged: no email without a preference row (default off), sent when switched on', async () => {
      responses.users = chain({
        data: [
          {
            id: 'user-a',
            email: 'a@x.com',
            first_name: 'Anna',
            language: 'en',
          },
        ],
      });
      responses.notification_preferences = chain({ data: [] });

      const merged = gitRow({ type: 'git_pr_merged' });

      await service.emailForNotifications([merged]);
      expect(mail.sendNotification).not.toHaveBeenCalled();

      responses.notification_preferences = chain({
        data: [
          {
            user_id: 'user-a',
            organization_id: 'org-1',
            notification_type: 'git_pr_merged',
            email: true,
          },
        ],
      });
      await service.emailForNotifications([merged]);
      expect(mail.sendNotification).toHaveBeenCalledWith(
        'a@x.com',
        expect.objectContaining({
          title: expect.stringContaining('merged · XE-T1'),
        }),
        expect.anything(),
      );
    });

    it('"build failed" email switched off → no email', async () => {
      responses.users = chain({
        data: [
          {
            id: 'user-a',
            email: 'a@x.com',
            first_name: 'Anna',
            language: 'en',
          },
        ],
      });
      responses.notification_preferences = chain({
        data: [
          {
            user_id: 'user-a',
            organization_id: 'org-1',
            notification_type: 'git_build_failed',
            email: false,
          },
        ],
      });

      await service.emailForNotifications([gitRow()]);

      expect(mail.sendNotification).not.toHaveBeenCalled();
    });

    it('gitText: GitLab says merge request; a burst uses the count; a non-http link is dropped', () => {
      const text = service.gitText(
        'git_pr_merged',
        {
          task_key: 'XE-T1',
          provider: 'gitlab',
          count: 3,
          subject: { number: 7, title: 'Fix', url: 'javascript:x' },
        },
        'en',
      );

      expect(text).toEqual({
        title: '3 merge requests merged · XE-T1',
        body: '3 merge requests were merged for XE-T1. Latest: #7 “Fix”.',
        linkLabel: 'View merge request',
        linkUrl: null,
      });
      expect(
        service.gitText(
          'git_pr_linked',
          {
            task_key: 'XE-T1',
            provider: 'github',
            auto: true,
            actor_login: 'anna-dev',
            subject: { number: 12, title: 'Fix' },
          },
          'en',
        ).body,
      ).toBe(
        'Pull request #12 “Fix” by anna-dev was linked to XE-T1 automatically.',
      );
    });
  });
});
