/**
 * @fileoverview Unit tests for GitActivityService (ticket 9): History rows per activity, "build fixed" only after a
 * failure, the recipient matrix (assignee, watchers, failed-build author), the exclusions (actor, hidden, muted,
 * disconnected, switched off), preference defaults, burst coalescing and the one-email-per-window rule.
 * The database is mocked.
 * @module src/git-integrations/git-activity.service.spec
 */

import type { NotificationEmailService } from '../notifications/notification-email.service';
import type { NotificationsBroadcastService } from '../notifications/notifications-broadcast.service';
import type { WatchersService } from '../watchers/watchers.service';
import { GitActivityService } from './git-activity.service';
import type { GitIdentitiesService } from './git-identities.service';
import type { IGitActivity } from './git-integrations.types';

// Every task counts as being in a space with the Development module on. The gate is an RPC with its own
// tests; these specs are about what happens behind it.
jest.mock('./git-integrations.util', () => ({
  ...jest.requireActual('./git-integrations.util'),
  developmentTaskIds: jest.fn((_db: unknown, _org: string, ids: string[]) =>
    Promise.resolve(new Set(ids)),
  ),
}));

const ORG = 'org-1';

interface ICall {
  method: string;
  args: unknown[];
}

function makeDb() {
  const chains: { table: string; calls: ICall[] }[] = [];
  const queues = new Map<string, { data?: unknown; error?: unknown }[]>();
  const from = (table: string) => {
    const chain = { table, calls: [] as ICall[] };
    const result = () => {
      const next = queues.get(table)?.shift() ?? {};

      return { data: next.data ?? null, error: next.error ?? null };
    };
    const builder: Record<string, unknown> = {};

    chains.push(chain);
    for (const method of [
      'select',
      'insert',
      'update',
      'eq',
      'in',
      'is',
      'gte',
      'order',
      'limit',
    ])
      builder[method] = (...args: unknown[]) => {
        chain.calls.push({ method, args });

        return builder;
      };
    builder.maybeSingle = () => Promise.resolve(result());
    builder.single = () => Promise.resolve(result());
    builder.then = (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(f, r);

    return builder;
  };

  return {
    client: { from },
    queue(table: string, ...results: { data?: unknown; error?: unknown }[]) {
      queues.set(table, [...(queues.get(table) ?? []), ...results]);
    },
    on: (table: string) => chains.filter((c) => c.table === table),
  };
}

const callsOf = (chain: { calls: ICall[] }, method: string) =>
  chain.calls.filter((c) => c.method === method).map((c) => c.args);

const TASK = {
  id: 't1',
  key: 'XE-T1',
  space_id: 'space-1',
  assigned_to: 'assignee',
};
const LIVE_REPO = {
  is_enabled: true,
  removed_at: null,
  connection: { status: 'active' },
};

function setup() {
  const db = makeDb();
  const identities = {
    resolveActor: jest.fn().mockResolvedValue(null),
    resolveAuthors: jest.fn().mockResolvedValue(new Map()),
  };
  const watchers = {
    taskWatcherIds: jest.fn().mockResolvedValue(['watcher']),
    visibleTaskUsers: jest.fn(
      async (_o: string, _s: string, ids: string[], actor: string) =>
        [...new Set(ids)].filter((id) => id !== actor && id !== 'hidden'),
    ),
    mutedTaskUsers: jest.fn().mockResolvedValue(new Set()),
  };
  const broadcast = { broadcastNotification: jest.fn() };
  const email = {
    gitText: jest.fn((type: string, meta: { count?: number }) => ({
      title: `${type} x${meta?.count ?? 1}`,
      body: 'body',
      linkLabel: 'View',
      linkUrl: null,
    })),
    emailForNotifications: jest.fn(),
  };
  const service = new GitActivityService(
    { getClient: () => db.client } as never,
    identities as unknown as GitIdentitiesService,
    watchers as unknown as WatchersService,
    broadcast as unknown as NotificationsBroadcastService,
    email as unknown as NotificationEmailService,
  );

  return { service, db, identities, watchers, broadcast, email };
}

const activity = (overrides: Partial<IGitActivity> = {}): IGitActivity => ({
  organizationId: ORG,
  provider: 'github',
  kind: 'pr_merged',
  taskIds: ['t1'],
  subject: {
    kind: 'pull_request',
    number: 12,
    title: 'Fix login',
    url: 'https://github.com/acme/api/pull/12',
    repository: 'acme/api',
  },
  actor: { externalId: '7', login: 'dev' },
  repositoryId: 'repo-1',
  ...overrides,
});

/** Queues a task, a live repository, no preference rows and the space key. */
function happy(db: ReturnType<typeof makeDb>) {
  db.queue('tasks', { data: TASK });
  db.queue('git_repositories', { data: LIVE_REPO });
  db.queue('notification_preferences', { data: [] });
  db.queue('spaces', { data: { key: 'XE' } });
}

const inserted = (db: ReturnType<typeof makeDb>) =>
  db
    .on('notifications')
    .flatMap((c) => callsOf(c, 'insert'))
    .map((a) => a[0] as Record<string, unknown>);

describe('GitActivityService', () => {
  describe('History', () => {
    it('pr_merged → one git_activity row with the source and the resolved developer', async () => {
      const { service, db, identities } = setup();

      identities.resolveActor.mockResolvedValue({
        userId: 'dev-user',
        name: 'Anna Berger',
        avatarUrl: null,
      });
      happy(db);

      await service.record(activity());

      expect(callsOf(db.on('task_history')[0], 'insert')[0][0]).toEqual({
        task_id: 't1',
        organization_id: ORG,
        action: 'git_activity',
        field_name: null,
        old_value: null,
        new_value: null,
        changed_by: 'dev-user',
        metadata: {
          source: 'git',
          provider: 'github',
          event: 'pr_merged',
          subject: activity().subject,
          actor: { login: 'dev', userId: 'dev-user', name: 'Anna Berger' },
        },
      });
    });

    it('automatic link → a pull_request_linked row like the manual one, marked auto', async () => {
      const { service, db } = setup();

      db.queue('tasks', { data: TASK });

      await service.record(activity({ kind: 'pr_linked' }));

      const row = callsOf(db.on('task_history')[0], 'insert')[0][0] as Record<
        string,
        unknown
      >;

      expect(row.action).toBe('pull_request_linked');
      expect(row.new_value).toEqual({
        provider: 'github',
        repository: 'acme/api',
        number: 12,
        title: 'Fix login',
        url: 'https://github.com/acme/api/pull/12',
      });
      expect(row.changed_by).toBeNull();
      expect(row.metadata).toEqual(
        expect.objectContaining({ event: 'pr_linked', auto: true }),
      );
    });

    it('automatic unlink → pull_request_unlinked; commits linked → git_activity with the count, no notification', async () => {
      const { service, db } = setup();

      db.queue('tasks', { data: TASK }, { data: TASK });

      await service.record(activity({ kind: 'pr_unlinked' }));
      await service.record(
        activity({
          kind: 'commits_linked',
          subject: { kind: 'commit', count: 3, branch: 'XE-T1-work' },
        }),
      );

      const rows = db
        .on('task_history')
        .map((c) => callsOf(c, 'insert')[0][0] as Record<string, unknown>);

      expect(rows.map((r) => r.action)).toEqual([
        'pull_request_unlinked',
        'git_activity',
      ]);
      expect(rows[1].metadata).toEqual(
        expect.objectContaining({
          event: 'commits_linked',
          subject: expect.objectContaining({ count: 3 }),
        }),
      );
      expect(db.on('notifications')).toHaveLength(0);
    });

    it('a non-http subject url is not stored', async () => {
      const { service, db } = setup();

      db.queue('tasks', { data: TASK });

      await service.record(
        activity({
          kind: 'pr_closed',
          subject: {
            kind: 'pull_request',
            number: 1,
            url: 'javascript:alert(1)',
          },
        }),
      );

      const row = callsOf(db.on('task_history')[0], 'insert')[0][0] as {
        metadata: { subject: { url: unknown } };
      };

      expect(row.metadata.subject.url).toBeNull();
    });

    it('manual link → no History row (ticket 4 wrote it), the notification names the person', async () => {
      const { service, db } = setup();

      db.queue('users', {
        data: { first_name: 'Max', last_name: 'Muster', email: 'm@x.io' },
      });
      db.queue('tasks', { data: TASK });
      db.queue('notification_preferences', {
        data: [{ user_id: 'assignee', in_app: true, email: false }],
      });
      db.queue('spaces', { data: { key: 'XE' } });

      await service.record(
        activity({
          kind: 'pr_linked',
          actor: { externalId: null, login: null },
          repositoryId: undefined,
          manualBy: 'linker',
        }),
      );

      expect(db.on('task_history')).toHaveLength(0);
      expect(inserted(db)[0]).toEqual(
        expect.objectContaining({
          user_id: 'assignee',
          type: 'git_pr_linked',
          metadata: expect.objectContaining({ actor_name: 'Max Muster' }),
        }),
      );
      expect(inserted(db)[0].metadata).not.toHaveProperty('auto');
    });

    it('unknown task (other org, deleted) → nothing', async () => {
      const { service, db } = setup();

      await service.record(activity());

      expect(db.on('task_history')).toHaveLength(0);
      expect(db.on('notifications')).toHaveLength(0);
    });
  });

  describe('build fixed', () => {
    const passed = activity({
      kind: 'build_passed',
      subject: {
        kind: 'build',
        title: 'CI',
        url: 'https://github.com/acme/api/actions/runs/1',
        branch: 'XE-T1-ci',
        sha: 'a'.repeat(40),
      },
    });

    it('after a recorded failure on the branch → build_fixed row and notification', async () => {
      const { service, db } = setup();

      db.queue('tasks', { data: TASK });
      db.queue('task_history', {
        data: { metadata: { event: 'build_failed' } },
      });
      db.queue('git_repositories', { data: LIVE_REPO });
      db.queue('notification_preferences', { data: [] });
      db.queue('spaces', { data: { key: 'XE' } });

      await service.record(passed);

      const lookup = db.on('task_history')[0];

      expect(callsOf(lookup, 'in')).toEqual([
        ['metadata->>event', ['build_failed', 'build_fixed']],
      ]);
      expect(callsOf(lookup, 'eq')).toContainEqual([
        'metadata->subject->>branch',
        'XE-T1-ci',
      ]);
      expect(
        (
          callsOf(db.on('task_history')[1], 'insert')[0][0] as {
            metadata: { event: string };
          }
        ).metadata.event,
      ).toBe('build_fixed');
      expect(inserted(db).map((n) => n.type)).toEqual([
        'git_build_fixed',
        'git_build_fixed',
      ]);
    });

    it('no failure before, or already fixed → nothing at all', async () => {
      const { service, db } = setup();

      db.queue('tasks', { data: TASK }, { data: TASK });
      db.queue(
        'task_history',
        { data: null },
        { data: { metadata: { event: 'build_fixed' } } },
      );

      await service.record(passed);
      await service.record(passed);

      expect(
        db.on('task_history').flatMap((c) => callsOf(c, 'insert')),
      ).toHaveLength(0);
      expect(db.on('notifications')).toHaveLength(0);
    });
  });

  describe('recipients', () => {
    it('pr_merged → assignee and watchers, each once, in-app only by default', async () => {
      const { service, db, watchers, email, broadcast } = setup();

      watchers.taskWatcherIds.mockResolvedValue(['watcher', 'assignee']);
      happy(db);

      await service.record(activity());

      expect(inserted(db).map((n) => n.user_id)).toEqual([
        'assignee',
        'watcher',
      ]);
      expect(inserted(db)[0]).toEqual({
        organization_id: ORG,
        user_id: 'assignee',
        type: 'git_pr_merged',
        title: 'git_pr_merged x1',
        body: 'body',
        is_read: false,
        reference_type: 'task',
        reference_id: 't1',
        metadata: {
          task_key: 'XE-T1',
          space_key: 'XE',
          provider: 'github',
          event: 'pr_merged',
          subject: {
            kind: 'pull_request',
            number: 12,
            title: 'Fix login',
            url: 'https://github.com/acme/api/pull/12',
            branch: null,
            repository: 'acme/api',
          },
          actor_login: 'dev',
          actor_name: null,
          count: 1,
        },
      });
      expect(broadcast.broadcastNotification).toHaveBeenCalledTimes(2);
      expect(email.emailForNotifications).not.toHaveBeenCalled();
    });

    it('the actor is never notified about their own action', async () => {
      const { service, db, identities, watchers } = setup();

      identities.resolveActor.mockResolvedValue({
        userId: 'assignee',
        name: 'A',
        avatarUrl: null,
      });
      happy(db);

      await service.record(activity());

      expect(watchers.visibleTaskUsers).toHaveBeenCalledWith(
        ORG,
        'space-1',
        ['assignee', 'watcher'],
        'assignee',
      );
      expect(inserted(db).map((n) => n.user_id)).toEqual(['watcher']);
    });

    it('people who cannot see the task or muted it are skipped', async () => {
      const { service, db, watchers } = setup();

      watchers.taskWatcherIds.mockResolvedValue(['hidden', 'muter', 'watcher']);
      watchers.mutedTaskUsers.mockResolvedValue(new Set(['muter']));
      happy(db);

      await service.record(activity());

      expect(inserted(db).map((n) => n.user_id)).toEqual([
        'assignee',
        'watcher',
      ]);
    });

    it('build failed → the open pull request author too, and email by default', async () => {
      const { service, db, identities, email } = setup();

      identities.resolveAuthors.mockResolvedValue(
        new Map([['55', { userId: 'author', name: 'Au', avatarUrl: null }]]),
      );
      db.queue('tasks', { data: { ...TASK, assigned_to: null } });
      db.queue('git_repositories', { data: LIVE_REPO });
      db.queue('git_pull_requests', {
        data: [{ author_external_id: '55', author_login: 'au' }],
      });
      db.queue('notification_preferences', { data: [] });
      db.queue('spaces', { data: { key: 'XE' } });

      await service.record(
        activity({
          kind: 'build_failed',
          subject: {
            kind: 'build',
            title: 'CI',
            sha: 'A'.repeat(40),
            branch: 'XE-T1-ci',
          },
        }),
      );

      expect(callsOf(db.on('git_pull_requests')[0], 'eq')).toContainEqual([
        'head_sha',
        'a'.repeat(40),
      ]);
      expect(inserted(db).map((n) => n.user_id)).toEqual(['watcher', 'author']);
      expect(email.emailForNotifications).toHaveBeenCalledTimes(2);
    });

    it('a disconnected, disabled or removed repository → History only', async () => {
      const { service, db } = setup();

      db.queue('tasks', { data: TASK }, { data: TASK }, { data: TASK });
      db.queue(
        'git_repositories',
        { data: { ...LIVE_REPO, connection: { status: 'disconnected' } } },
        { data: { ...LIVE_REPO, is_enabled: false } },
        { data: { ...LIVE_REPO, removed_at: '2026-10-20T00:00:00Z' } },
      );

      await service.record(activity());
      await service.record(activity());
      await service.record(activity());

      expect(db.on('task_history')).toHaveLength(3);
      expect(db.on('notifications')).toHaveLength(0);
    });

    it('pr_linked is off by default; history-only kinds never notify', async () => {
      const { service, db } = setup();

      db.queue('tasks', { data: TASK }, { data: TASK });
      db.queue('git_repositories', { data: LIVE_REPO });
      db.queue('notification_preferences', { data: [] });
      db.queue('spaces', { data: { key: 'XE' } });

      await service.record(activity({ kind: 'pr_linked' }));
      await service.record(activity({ kind: 'pr_opened' }));

      expect(db.on('notifications')).toHaveLength(0);
      expect(db.on('notification_preferences')).toHaveLength(1);
    });
  });

  describe('preferences, coalescing and email', () => {
    const failed = activity({
      kind: 'build_failed',
      subject: { kind: 'build', title: 'CI', branch: 'XE-T1-ci' },
    });

    it('"build failed" switched off → nothing for that person', async () => {
      const { service, db, email } = setup();

      db.queue('tasks', { data: TASK });
      db.queue('git_repositories', { data: LIVE_REPO });
      db.queue('notification_preferences', {
        data: [
          { user_id: 'assignee', in_app: false, email: false },
          { user_id: 'watcher', in_app: true, email: false },
        ],
      });
      db.queue('spaces', { data: { key: 'XE' } });

      await service.record(failed);

      expect(inserted(db).map((n) => n.user_id)).toEqual(['watcher']);
      expect(email.emailForNotifications).not.toHaveBeenCalled();
    });

    it('email only (in-app off) → one email, no bell row', async () => {
      const { service, db, email, watchers } = setup();

      watchers.taskWatcherIds.mockResolvedValue([]);
      db.queue('tasks', { data: TASK });
      db.queue('git_repositories', { data: LIVE_REPO });
      db.queue('notification_preferences', {
        data: [{ user_id: 'assignee', in_app: false, email: true }],
      });
      db.queue('spaces', { data: { key: 'XE' } });

      await service.record(failed);

      expect(db.on('notifications')).toHaveLength(0);
      expect(email.emailForNotifications).toHaveBeenCalledWith([
        expect.objectContaining({
          user_id: 'assignee',
          type: 'git_build_failed',
          reference_id: 't1',
        }),
      ]);
    });

    it('a burst: the unread notification is updated with a count, and only the first emails', async () => {
      const { service, db, email, watchers, broadcast } = setup();

      watchers.taskWatcherIds.mockResolvedValue([]);
      for (let i = 0; i < 2; i++) {
        db.queue('tasks', { data: TASK });
        db.queue('git_repositories', { data: LIVE_REPO });
        db.queue('notification_preferences', { data: [] });
        db.queue('spaces', { data: { key: 'XE' } });
      }
      db.queue(
        'notifications',
        { data: null }, // lookup: none open
        { data: { id: 'n1', user_id: 'assignee' } }, // insert
        { data: { id: 'n1', metadata: { count: 1 } } }, // lookup: open
        { data: { id: 'n1' } }, // update
      );

      await service.record(failed);
      await service.record(failed);

      const update = db
        .on('notifications')
        .flatMap((c) => callsOf(c, 'update'))[0][0] as {
        title: string;
        metadata: { count: number };
      };

      expect(inserted(db)).toHaveLength(1);
      expect(update.metadata.count).toBe(2);
      expect(update.title).toBe('git_build_failed x2');
      expect(callsOf(db.on('notifications')[0], 'eq')).toEqual(
        expect.arrayContaining([
          ['is_read', false],
          ['type', 'git_build_failed'],
          ['reference_id', 't1'],
          ['user_id', 'assignee'],
        ]),
      );
      expect(callsOf(db.on('notifications')[0], 'gte')).toHaveLength(1);
      expect(email.emailForNotifications).toHaveBeenCalledTimes(1);
      expect(broadcast.broadcastNotification).toHaveBeenCalledTimes(2);
    });

    it('read in between → a new bell row, but still one email per window', async () => {
      const { service, db, email, watchers } = setup();

      watchers.taskWatcherIds.mockResolvedValue([]);
      for (let i = 0; i < 2; i++) {
        db.queue('tasks', { data: TASK });
        db.queue('git_repositories', { data: LIVE_REPO });
        db.queue('notification_preferences', { data: [] });
        db.queue('spaces', { data: { key: 'XE' } });
      }

      await service.record(failed);
      await service.record(failed);

      expect(inserted(db)).toHaveLength(2);
      expect(email.emailForNotifications).toHaveBeenCalledTimes(1);
    });
  });

  describe('robustness', () => {
    it('one failing task does not stop the others, and record never throws', async () => {
      const { service, db } = setup();

      db.queue('tasks', { error: { message: 'boom' } }, { data: TASK });

      await expect(
        service.record(activity({ kind: 'pr_closed', taskIds: ['bad', 't1'] })),
      ).resolves.toBeUndefined();

      expect(db.on('task_history')).toHaveLength(1);
    });

    it('no tasks → no lookups at all', async () => {
      const { service, identities, db } = setup();

      await service.record(activity({ taskIds: [] }));

      expect(identities.resolveActor).not.toHaveBeenCalled();
      expect(db.on('tasks')).toHaveLength(0);
    });
  });
});
