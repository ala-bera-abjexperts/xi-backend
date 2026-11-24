import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { ROBERT_ID } from '../chat-agent/agent.constants';
import type { MailService } from '../mail/mail.service';
import type { NotificationsBroadcastService } from '../notifications/notifications-broadcast.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type {
  ChatAccessService,
  ChatConversationRow,
} from './chat-access.service';
import { ChatNotificationsService } from './chat-notifications.service';
import type { ChatRealtimeService } from './chat-realtime.service';

type Row = Record<string, unknown>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}T/;
const isDate = (value: unknown): value is string =>
  typeof value === 'string' && DATE_RE.test(value);
/** Timestamps compare as instants, everything else as it is. */
const order = (a: unknown, b: unknown): number => {
  const [x, y] =
    isDate(a) && isDate(b) ? [Date.parse(a), Date.parse(b)] : [a, b];

  return (x as number) < (y as number)
    ? -1
    : (x as number) > (y as number)
      ? 1
      : 0;
};
/** `metadata->>key` reads into the json column, like PostgREST. */
const read = (row: Row, column: string): unknown => {
  const [name, key] = column.split('->>');

  return key ? ((row[name] as Row | null)?.[key] ?? null) : (row[name] ?? null);
};

const TABLE_DEFAULTS: Record<string, Row> = {
  chat_notification_queue: { attempts: 0, claimed_at: null },
  chat_user_settings: {
    dnd_until: null,
    working_hours: null,
    timezone: null,
    email_fallback: true,
    email_fallback_minutes: 30,
  },
  chat_members: {
    notify_level: 'all',
    muted_until: null,
    mute_mentions: false,
    last_read_seq: 0,
  },
};
const UNIQUE: Record<string, string[]> = {
  chat_notification_queue: ['user_id', 'message_id'],
};

/**
 * In-memory stand-in for the service-role client. Unlike a canned chain it really
 * applies filters, RETURNING and unique keys, and each statement runs in one step
 * when awaited, so two services sharing one FakeDb interleave like two instances.
 */
class FakeDb {
  tables: Record<string, Row[]> = {};
  /** Every statement in execution order. */
  log: { by: string; table: string; op: string; columns: string[] }[] = [];
  /** table → message: statements on it fail with a database error. */
  errors: Record<string, string> = {};
  private serial = 0;

  rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }

  seed(table: string, ...rows: object[]): Row[] {
    const added = rows.map((row) => this.withDefaults(table, row as Row));
    this.rows(table).push(...added);

    return added;
  }

  withDefaults(table: string, row: Row): Row {
    this.serial += 1;

    return {
      id: `${table}-${this.serial}`,
      created_at: new Date(Date.now() + this.serial).toISOString(),
      ...TABLE_DEFAULTS[table],
      ...row,
    };
  }

  client(by: string) {
    return { from: (table: string) => new FakeQuery(this, table, by) };
  }
}

class FakeQuery {
  private op = 'select';
  private payload: Row | Row[] = [];
  private options: { onConflict?: string; ignoreDuplicates?: boolean } = {};
  private filters: ((row: Row) => boolean)[] = [];
  private columns: string[] = [];
  private returning = false;
  private sort?: { column: string; ascending: boolean };
  private max?: number;

  constructor(
    private readonly db: FakeDb,
    private readonly table: string,
    private readonly by: string,
  ) {}

  private where(column: string, test: (value: unknown) => boolean): this {
    this.columns.push(column);
    this.filters.push((row) => test(read(row, column)));

    return this;
  }

  select(): this {
    if (this.op !== 'select') this.returning = true;

    return this;
  }
  insert(rows: Row | Row[]): this {
    this.op = 'insert';
    this.payload = rows;

    return this;
  }
  upsert(rows: Row | Row[], options: FakeQuery['options'] = {}): this {
    this.op = 'upsert';
    this.payload = rows;
    this.options = options;

    return this;
  }
  update(patch: Row): this {
    this.op = 'update';
    this.payload = patch;

    return this;
  }
  delete(): this {
    this.op = 'delete';

    return this;
  }
  eq(column: string, value: unknown): this {
    return this.where(column, (v) => order(v, value) === 0 && v !== null);
  }
  in(column: string, values: unknown[]): this {
    return this.where(column, (v) => values.includes(v));
  }
  is(column: string, value: unknown): this {
    return this.where(column, (v) => v === value);
  }
  lt(column: string, value: unknown): this {
    return this.where(column, (v) => v !== null && order(v, value) < 0);
  }
  lte(column: string, value: unknown): this {
    return this.where(column, (v) => v !== null && order(v, value) <= 0);
  }
  gte(column: string, value: unknown): this {
    return this.where(column, (v) => v !== null && order(v, value) >= 0);
  }
  or(expression: string): this {
    // PostgREST applies .or() on a mutation to the RETURNING rows, not to the WHERE.
    if (this.op !== 'select') {
      throw new Error('.or() must not be used on a mutation');
    }

    const tests = expression.split(',').map((term) => {
      const [column, operator, ...rest] = term.split('.');
      const value = rest.join('.');

      return (row: Row) => {
        const v = read(row, column);
        if (operator === 'is') return v === null;
        if (operator === 'lt') return v !== null && order(v, value) < 0;

        return v === value;
      };
    });
    this.filters.push((row) => tests.some((test) => test(row)));

    return this;
  }
  order(column: string, { ascending }: { ascending: boolean }): this {
    this.sort = { column, ascending };

    return this;
  }
  limit(max: number): this {
    this.max = max;

    return this;
  }

  then(
    resolve: (value: { data: unknown; error: unknown }) => unknown,
    reject: (reason: unknown) => unknown,
  ) {
    return Promise.resolve()
      .then(() => this.run())
      .then(resolve, reject);
  }

  private run(): { data: unknown; error: unknown } {
    const { db, table } = this;
    const payload = [this.payload].flat();

    db.log.push({
      by: this.by,
      table,
      op: this.op,
      columns:
        this.op === 'insert' || this.op === 'upsert'
          ? payload.every((row) => 'organization_id' in row)
            ? ['organization_id']
            : []
          : this.columns,
    });
    if (db.errors[table]) {
      return { data: null, error: { message: db.errors[table] } };
    }

    const all = db.rows(table);
    const matches = (row: Row) => this.filters.every((test) => test(row));
    const conflict = (
      this.options.onConflict?.split(',') ??
      UNIQUE[table] ??
      []
    ).map((column) => column.trim());
    const existing = (row: Row) =>
      conflict.length === 0
        ? undefined
        : all.find((other) => conflict.every((c) => other[c] === row[c]));
    let result: Row[] = [];

    if (this.op === 'select') {
      result = all.filter(matches);
      if (this.sort) {
        const { column, ascending } = this.sort;
        result.sort(
          (a, b) => order(a[column], b[column]) * (ascending ? 1 : -1),
        );
      }
      if (this.max !== undefined) result = result.slice(0, this.max);
    } else if (this.op === 'insert' || this.op === 'upsert') {
      for (const row of payload) {
        const found = existing(row);

        if (found && this.op === 'insert') {
          return { data: null, error: { message: 'duplicate key value' } };
        }
        if (found && this.options.ignoreDuplicates) continue;
        if (found) {
          result.push(Object.assign(found, row));
          continue;
        }

        const created = db.withDefaults(table, row);
        all.push(created);
        result.push(created);
      }
    } else if (this.op === 'update') {
      result = all.filter(matches);
      for (const row of result) Object.assign(row, this.payload);
    } else {
      result = all.filter(matches);
      db.tables[table] = all.filter((row) => !result.includes(row));
    }

    const data = result.map((row) => ({ ...row }));

    return {
      data: this.op === 'select' || this.returning ? data : null,
      error: null,
    };
  }
}

const ORG = 'org-1';
const QUEUE = 'chat_notification_queue';
const SECRET = 'TOP-SECRET payroll figures';

const conversationRow = (
  overrides: Partial<ChatConversationRow>,
): ChatConversationRow => ({
  id: 'conv-g',
  organization_id: ORG,
  kind: 'group',
  space_id: null,
  title: 'Audit',
  description: null,
  dm_key: null,
  is_announcement: false,
  created_by: null,
  last_seq: 10,
  last_message_at: null,
  archived_at: null,
  created_at: '2026-10-01T00:00:00.000Z',
  ...overrides,
});

const group = conversationRow({});
const dm = conversationRow({
  id: 'conv-d',
  kind: 'dm',
  title: null,
  dm_key: 'user-1:user-2',
});
const channel = conversationRow({
  id: 'conv-s',
  kind: 'space',
  title: null,
  space_id: 'space-1',
});

describe('ChatNotificationsService', () => {
  const author = { userId: 'user-1', organizationId: ORG } as RequestUser;
  const ben = { userId: 'user-2', organizationId: ORG } as RequestUser;
  // Wednesday 2026-10-14, 12:00 in Vienna
  const NOON = new Date('2026-10-14T10:00:00.000Z');
  const minutesAfter = (date: Date, minutes: number) =>
    new Date(date.getTime() + minutes * 60_000).toISOString();

  let db: FakeDb;
  /** People who can view space-1 (the readers of its channel). */
  let spaceViewers: Set<string>;
  let filterReaders: jest.Mock;
  /** Whether the instances built from here on can send email. */
  let mailEnabled = false;

  /** One backend instance on the shared database. */
  const instance = (by = 'a') => {
    const mail = {
      sendNotification: jest
        .fn<Promise<void>, unknown[]>()
        .mockResolvedValue(undefined),
      deliveryEnabled: mailEnabled,
    };
    const broadcastNotification = jest
      .fn<Promise<void>, unknown[]>()
      .mockResolvedValue(undefined);
    const realtime = { broadcast: jest.fn().mockResolvedValue(undefined) };
    const service = new ChatNotificationsService(
      { getClient: () => db.client(by) } as unknown as SupabaseAdminService,
      { filterReaders } as unknown as ChatAccessService,
      realtime as unknown as ChatRealtimeService,
      mail as unknown as MailService,
      { get: () => 'https://app.test/' } as unknown as ConfigService,
      { broadcastNotification } as unknown as NotificationsBroadcastService,
    );

    return { service, mail, broadcastNotification, realtime };
  };
  let a: ReturnType<typeof instance>;

  const bell = (userId?: string) =>
    db.rows('notifications').filter((row) => !userId || row.user_id === userId);
  const queue = (userId?: string) =>
    db.rows(QUEUE).filter((row) => !userId || row.user_id === userId);
  const message = (id = 'm1', seq = 5, threadRootId: string | null = null) => ({
    id,
    seq,
    threadRootId,
  });
  /** A stored message; its text is in the database so a leak would show. */
  const seedMessage = (id: string, overrides: Row = {}) =>
    db.seed('chat_messages', {
      id,
      organization_id: ORG,
      conversation_id: group.id,
      kind: 'user',
      author_id: 'user-1',
      body_text: SECRET,
      thread_root_id: null,
      deleted_at: null,
      ...overrides,
    });
  /** Returns a copy, so an assertion can never compare a stored row with itself. */
  const seedQueue = (overrides: Row = {}): Row => ({
    ...db.seed(QUEUE, {
      organization_id: ORG,
      user_id: 'user-2',
      conversation_id: group.id,
      message_id: 'm1',
      seq: 5,
      reason: 'mention',
      actor_id: 'user-1',
      stage: 'email',
      due_at: minutesAfter(NOON, -1),
      ...overrides,
    })[0],
  });
  const setSettings = (userId: string, settings: Row) =>
    db.seed('chat_user_settings', {
      organization_id: ORG,
      user_id: userId,
      ...settings,
    });
  const setPreference = (
    userId: string,
    type: string,
    inApp: boolean,
    email: boolean,
  ) =>
    db.seed('notification_preferences', {
      organization_id: ORG,
      user_id: userId,
      notification_type: type,
      in_app: inApp,
      email,
    });
  const member = (conversationId: string, userId: string) =>
    db
      .rows('chat_members')
      .find(
        (row) =>
          row.conversation_id === conversationId && row.user_id === userId,
      ) as Row;

  beforeEach(() => {
    jest.useFakeTimers({ now: NOON.getTime() });
    db = new FakeDb();
    spaceViewers = new Set(['user-1', 'user-2', 'user-3']);
    filterReaders = jest.fn(
      (conversation: ChatConversationRow, userIds: string[]) =>
        Promise.resolve(
          userIds.filter((id) =>
            conversation.kind === 'space'
              ? spaceViewers.has(id)
              : !!member(conversation.id, id),
          ),
        ),
    );

    db.seed(
      'users',
      {
        id: 'user-1',
        first_name: 'Anna',
        last_name: 'Adler',
        email: 'anna@x.test',
        language: 'de',
      },
      {
        id: 'user-2',
        first_name: 'Ben',
        last_name: 'Berg',
        email: 'ben@x.test',
        language: 'de',
      },
      {
        id: 'user-3',
        first_name: 'Carla',
        last_name: 'Cole',
        email: 'carla@x.test',
        language: 'en',
      },
      {
        id: 'user-4',
        first_name: 'Dan',
        last_name: 'Dorn',
        email: 'dan@x.test',
        language: 'en',
      },
    );
    db.seed(
      'organization_members',
      ...['user-1', 'user-2', 'user-3', 'user-4'].map((user_id) => ({
        organization_id: ORG,
        user_id,
      })),
    );
    db.seed('chat_conversations', group, dm, channel);
    db.seed('spaces', { id: 'space-1', organization_id: ORG, name: 'Finance' });
    db.seed(
      'chat_members',
      ...[
        [group.id, 'user-1'],
        [group.id, 'user-2'],
        [group.id, 'user-4'],
        [dm.id, 'user-1'],
        [dm.id, 'user-2'],
      ].map(([conversation_id, user_id]) => ({
        organization_id: ORG,
        conversation_id,
        user_id,
      })),
    );
    a = instance();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('onMessage', () => {
    it('notifies only org members who can read the chat, never the author', async () => {
      await a.service.onMessage(author, group, message(), [
        'user-1', // the author
        'user-2',
        'user-3', // in the organization, not in the group
        'user-9', // not in the organization
      ]);

      expect(filterReaders).toHaveBeenCalledWith(group, ['user-2', 'user-3']);
      expect(bell()).toEqual([
        expect.objectContaining({
          organization_id: ORG,
          user_id: 'user-2',
          type: 'chat_mention',
          title: 'Anna Adler mentioned you in "Audit"',
          body: null,
          is_read: false,
          action_status: 'none',
          reference_type: 'chat_message',
          reference_id: 'm1',
          metadata: {
            link: '/chat/conv-g?m=m1',
            conversation_id: 'conv-g',
            seq: 5,
            reason: 'mention',
            actor_name: 'Anna Adler',
            where: '"Audit"',
          },
        }),
      ]);
    });

    it('creates exactly one chat_mention entry with a working link for someone without a settings row', async () => {
      expect(db.rows('chat_user_settings')).toEqual([]);

      await a.service.onMessage(author, group, message('m7', 9), ['user-2']);

      expect(bell('user-2')).toHaveLength(1);
      expect(bell('user-2')[0]).toMatchObject({
        type: 'chat_mention',
        metadata: { link: '/chat/conv-g?m=m7' },
      });
    });

    it('broadcasts a redacted copy on the public channel: ids, a generic title and the link', async () => {
      seedMessage('m1');

      await a.service.onMessage(author, group, message(), ['user-2']);

      const [stored] = bell('user-2');
      // The exact payload: no names, no conversation title, no body.
      expect(a.broadcastNotification.mock.calls).toEqual([
        [
          {
            id: stored.id,
            user_id: 'user-2',
            type: 'chat_mention',
            title: 'You were mentioned in chat',
            created_at: stored.created_at,
            metadata: { link: '/chat/conv-g?m=m1' },
          },
        ],
      ]);
      expect(JSON.stringify([bell(), queue()])).not.toContain(SECRET);
    });

    it('keeps the sender and the conversation on the stored row only, whatever the reason', async () => {
      seedMessage('root', { seq: 1, author_id: 'user-4' });

      await a.service.onMessage(author, group, message('m1', 5), ['user-2']);
      await a.service.onMessage(author, dm, message('m2', 6), []);
      await a.service.onMessage(author, group, message('r1', 7, 'root'), []);

      expect(bell().map((row) => (row.metadata as Row).reason)).toEqual([
        'mention',
        'dm',
        'thread_reply',
      ]);
      for (const row of bell()) {
        expect(row.metadata).toMatchObject({ actor_name: 'Anna Adler' });
      }

      const copies = a.broadcastNotification.mock.calls.map(
        ([copy]) => copy as Row,
      );
      expect(copies).toHaveLength(3);
      for (const copy of copies) {
        expect(Object.keys(copy.metadata as Row)).toEqual(['link']);
        expect(copy.metadata).not.toHaveProperty('actor_name');
        expect(copy.metadata).not.toHaveProperty('where');
      }
      expect(JSON.stringify(copies)).not.toMatch(
        /Anna|Adler|Audit|actor_name|where|reason/,
      );
    });

    it('does nothing when only the author is mentioned', async () => {
      await a.service.onMessage(author, group, message(), ['user-1']);

      expect(bell()).toEqual([]);
      expect(queue()).toEqual([]);
      expect(db.log.map((entry) => entry.table)).not.toContain('notifications');
    });

    it('never notifies Robert: not for a mention, nor for a message in the Robert chat', async () => {
      await a.service.onMessage(author, group, message(), [ROBERT_ID]);
      await a.service.onMessage(
        author,
        { ...dm, dm_key: `${ROBERT_ID}:user-1` },
        message('m2', 6),
        [],
      );

      // He is no organization member, so he never reaches the reader check.
      expect(
        (filterReaders.mock.calls as unknown[][]).map((call) => call[1]),
      ).toEqual([[], []]);
      expect(bell()).toEqual([]);
      expect(queue()).toEqual([]);
    });

    it('never creates a bell entry for a plain group message', async () => {
      await a.service.onMessage(author, group, message(), []);

      expect(bell()).toEqual([]);
      expect(queue()).toEqual([]);
    });

    it('never throws, so a notification problem cannot fail the message', async () => {
      filterReaders.mockRejectedValue(new Error('db down'));
      await expect(
        a.service.onMessage(author, group, message(), ['user-2']),
      ).resolves.toBeUndefined();

      filterReaders.mockResolvedValue(['user-2']);
      db.errors.chat_user_settings = 'relation does not exist';
      await expect(
        a.service.onMessage(author, group, message(), ['user-2']),
      ).resolves.toBeUndefined();
    });

    it('still queues the email when the bell row cannot be written', async () => {
      db.errors.notifications = 'insert failed';

      await a.service.onMessage(author, group, message(), ['user-2']);

      expect(queue('user-2')).toHaveLength(1);
    });

    it('loads members, settings and preferences once each, however many recipients', async () => {
      await a.service.onMessage(author, group, message(), ['user-2', 'user-4']);

      const selects = (table: string) =>
        db.log.filter(
          (entry) => entry.table === table && entry.op === 'select',
        );
      expect(bell()).toHaveLength(2);
      expect(selects('chat_members')).toHaveLength(1);
      expect(selects('chat_user_settings')).toHaveLength(1);
      expect(selects('notification_preferences')).toHaveLength(1);
    });

    it('queues the email fallback for an unread mention: 30 minutes by default, the chosen delay otherwise', async () => {
      setSettings('user-4', { email_fallback_minutes: 15 });

      await a.service.onMessage(author, group, message(), ['user-2', 'user-4']);

      expect(queue('user-2')).toEqual([
        expect.objectContaining({
          organization_id: ORG,
          conversation_id: 'conv-g',
          message_id: 'm1',
          seq: 5,
          reason: 'mention',
          actor_id: 'user-1',
          stage: 'email',
          due_at: minutesAfter(NOON, 30),
          attempts: 0,
          claimed_at: null,
        }),
      ]);
      expect(queue('user-4')[0].due_at).toBe(minutesAfter(NOON, 15));
    });

    it('lets a mention through a muted conversation, unless mentions are muted too (AC-2)', async () => {
      member(group.id, 'user-2').muted_until = minutesAfter(NOON, 60);
      Object.assign(member(group.id, 'user-4'), {
        notify_level: 'none',
        mute_mentions: true,
      });

      await a.service.onMessage(author, group, message(), ['user-2', 'user-4']);

      expect(bell().map((row) => row.user_id)).toEqual(['user-2']);
      expect(queue().map((row) => row.user_id)).toEqual(['user-2']);
    });

    it('treats a mute that has ended as not muted', async () => {
      Object.assign(member(group.id, 'user-2'), {
        muted_until: minutesAfter(NOON, -1),
        mute_mentions: true,
      });

      await a.service.onMessage(author, group, message(), ['user-2']);

      expect(bell('user-2')).toHaveLength(1);
    });

    describe('direct messages', () => {
      it('notifies the other person without any mention', async () => {
        await a.service.onMessage(author, dm, message(), []);

        expect(bell()).toEqual([
          expect.objectContaining({
            user_id: 'user-2',
            type: 'chat_dm',
            title: 'Anna Adler sent you a direct message',
            body: null,
            // No `where`: a DM is phrased without one.
            metadata: {
              link: '/chat/conv-d?m=m1',
              conversation_id: 'conv-d',
              seq: 5,
              reason: 'dm',
              actor_name: 'Anna Adler',
            },
          }),
        ]);
        expect(a.broadcastNotification.mock.calls[0][0]).toMatchObject({
          title: 'New direct message',
        });
        expect(queue('user-2')[0]).toMatchObject({
          reason: 'dm',
          stage: 'email',
        });
      });

      it('does not notify a muted DM', async () => {
        member(dm.id, 'user-2').muted_until = minutesAfter(NOON, 60);

        await a.service.onMessage(author, dm, message(), []);

        expect(bell()).toEqual([]);
        expect(queue()).toEqual([]);
      });

      it('adds no second entry while an unread one is under 5 minutes old, but queues every message', async () => {
        await a.service.onMessage(author, dm, message('m1', 5), []);
        jest.setSystemTime(NOON.getTime() + 4 * 60_000);

        await a.service.onMessage(author, dm, message('m2', 6), []);

        expect(bell()).toHaveLength(1);
        expect(queue().map((row) => row.message_id)).toEqual(['m1', 'm2']);
      });

      it('adds a new entry once the earlier one is read or older than 5 minutes', async () => {
        await a.service.onMessage(author, dm, message('m1', 5), []);

        jest.setSystemTime(NOON.getTime() + 6 * 60_000);
        await a.service.onMessage(author, dm, message('m2', 6), []);
        expect(bell()).toHaveLength(2);

        bell().forEach((row) => {
          row.is_read = true;
        });
        await a.service.onMessage(author, dm, message('m3', 7), []);
        expect(bell()).toHaveLength(3);
      });

      it('makes a mention inside a DM one entry, as a mention', async () => {
        await a.service.onMessage(author, dm, message(), ['user-2']);

        expect(bell().map((row) => row.type)).toEqual(['chat_mention']);
        // A DM has no name of its own, so the row stores no `where`.
        expect(bell()[0]).toMatchObject({
          title: 'Anna Adler mentioned you in a direct message',
          metadata: { reason: 'mention', actor_name: 'Anna Adler' },
        });
        expect(bell()[0].metadata).not.toHaveProperty('where');
        expect(queue().map((row) => row.reason)).toEqual(['mention']);
      });

      it('has nobody to notify in the notes-to-self DM', async () => {
        const notes = conversationRow({
          id: 'conv-n',
          kind: 'dm',
          dm_key: 'user-1:user-1',
        });

        await a.service.onMessage(author, notes, message(), []);

        expect(bell()).toEqual([]);
      });
    });

    describe('thread replies', () => {
      beforeEach(() => {
        // user-2 started the thread, user-4 and the author replied.
        seedMessage('root', { seq: 1, author_id: 'user-2' });
        seedMessage('r1', {
          seq: 2,
          author_id: 'user-4',
          thread_root_id: 'root',
        });
        seedMessage('r2', {
          seq: 3,
          author_id: 'user-1',
          thread_root_id: 'root',
        });
        seedMessage('other', { seq: 4, author_id: 'user-3' });
      });

      it('notifies the thread author and everyone who replied, bell only', async () => {
        await a.service.onMessage(author, group, message('r3', 5, 'root'), []);

        expect(bell().map((row) => [row.user_id, row.type, row.title])).toEqual(
          [
            [
              'user-2',
              'chat_mention',
              'Anna Adler replied in a thread in "Audit"',
            ],
            [
              'user-4',
              'chat_mention',
              'Anna Adler replied in a thread in "Audit"',
            ],
          ],
        );
        expect(bell()[0].metadata).toEqual({
          link: '/chat/conv-g?m=r3',
          conversation_id: 'conv-g',
          seq: 5,
          reason: 'thread_reply',
          actor_name: 'Anna Adler',
          where: '"Audit"',
          thread_root_id: 'root',
        });
        expect(a.broadcastNotification.mock.calls[0][0]).toMatchObject({
          title: 'New reply in a thread',
          metadata: { link: '/chat/conv-g?m=r3' },
        });
        // A thread reply is never emailed.
        expect(queue()).toEqual([]);
      });

      it('adds no second entry for the same thread within 5 minutes, but does for another thread', async () => {
        seedMessage('root2', { seq: 6, author_id: 'user-2' });

        await a.service.onMessage(author, group, message('r3', 7, 'root'), []);
        await a.service.onMessage(author, group, message('r4', 8, 'root'), []);
        expect(bell('user-2')).toHaveLength(1);

        await a.service.onMessage(author, group, message('x1', 9, 'root2'), []);
        expect(
          bell('user-2').map((row) => (row.metadata as Row).thread_root_id),
        ).toEqual(['root', 'root2']);
      });

      it('does not notify followers of a muted conversation or at level "nothing"', async () => {
        member(group.id, 'user-2').notify_level = 'none';
        member(group.id, 'user-4').muted_until = minutesAfter(NOON, 60);

        await a.service.onMessage(author, group, message('r3', 5, 'root'), []);

        expect(bell()).toEqual([]);
      });

      it('gives a follower who is also mentioned one entry, as a mention', async () => {
        await a.service.onMessage(author, group, message('r3', 5, 'root'), [
          'user-2',
        ]);

        expect(bell('user-2')).toHaveLength(1);
        expect(bell('user-2')[0].title).toBe(
          'Anna Adler mentioned you in "Audit"',
        );
        expect(bell('user-2')[0].metadata).toMatchObject({ reason: 'mention' });
        expect(bell('user-2')[0].metadata).not.toHaveProperty('thread_root_id');
        expect(queue('user-2')[0].reason).toBe('mention');
      });
    });

    describe('space channels', () => {
      it('creates the state row of a mentioned reader who never opened the channel, one before the message', async () => {
        db.seed('chat_members', {
          organization_id: ORG,
          conversation_id: channel.id,
          user_id: 'user-3',
          last_read_seq: 2,
        });

        await a.service.onMessage(author, channel, message('m1', 8), [
          'user-2', // can view the space, never opened the channel
          'user-3', // already has a row
          'user-4', // cannot view the space
        ]);

        expect(member(channel.id, 'user-2')).toMatchObject({
          organization_id: ORG,
          notify_level: 'mentions',
          last_read_seq: 7,
        });
        expect(member(channel.id, 'user-3').last_read_seq).toBe(2);
        expect(member(channel.id, 'user-4')).toBeUndefined();
        // Their row did not exist when the message's own signal went out.
        expect(a.realtime.broadcast).toHaveBeenCalledWith([
          {
            topic: 'chat-user:user-2',
            event: 'inbox.changed',
            payload: { conversationId: 'conv-s' },
          },
        ]);
        expect(bell().map((row) => [row.user_id, row.title])).toEqual([
          ['user-2', 'Anna Adler mentioned you in #Finance'],
          ['user-3', 'Anna Adler mentioned you in #Finance'],
        ]);
        expect(bell()[0].metadata).toMatchObject({
          reason: 'mention',
          actor_name: 'Anna Adler',
          where: '#Finance',
        });
      });

      it('creates no state rows in a group or DM', async () => {
        const before = db.rows('chat_members').length;

        await a.service.onMessage(author, group, message(), ['user-2']);

        expect(db.rows('chat_members')).toHaveLength(before);
        expect(a.realtime.broadcast).not.toHaveBeenCalled();
      });
    });

    describe('while the recipient is paused', () => {
      // Wednesday 21:00 in Vienna
      const EVENING = new Date('2026-10-14T19:00:00.000Z');

      beforeEach(() => {
        jest.setSystemTime(EVENING.getTime());
        setSettings('user-2', {
          working_hours: Object.fromEntries(
            ['mon', 'tue', 'wed', 'thu', 'fri'].map((day) => [
              day,
              { start: '08:00', end: '17:00' },
            ]),
          ),
          timezone: 'Europe/Vienna',
        });
      });

      it('holds a DM sent at 21:00 until 08:00 local time (AC-3)', async () => {
        await a.service.onMessage(author, dm, message(), []);

        expect(bell()).toEqual([]);
        expect(a.broadcastNotification).not.toHaveBeenCalled();
        expect(queue('user-2')).toEqual([
          expect.objectContaining({
            reason: 'dm',
            stage: 'held',
            due_at: '2026-10-15T06:00:00.000Z',
          }),
        ]);
      });

      it('holds during do not disturb until it ends', async () => {
        jest.setSystemTime(NOON.getTime());
        setSettings('user-4', { dnd_until: minutesAfter(NOON, 90) });

        await a.service.onMessage(author, group, message(), ['user-4']);

        expect(bell('user-4')).toEqual([]);
        expect(queue('user-4')[0]).toMatchObject({
          stage: 'held',
          due_at: minutesAfter(NOON, 90),
        });
      });

      it('holds a thread reply too, although it is never emailed', async () => {
        seedMessage('root', { seq: 1, author_id: 'user-2' });

        await a.service.onMessage(author, group, message('r1', 5, 'root'), []);

        expect(queue('user-2')[0]).toMatchObject({
          reason: 'thread_reply',
          stage: 'held',
        });
      });
    });

    describe('preferences', () => {
      it('writes no bell entry with in-app off, and still queues the email', async () => {
        setPreference('user-2', 'chat_mention', false, true);

        await a.service.onMessage(author, group, message(), ['user-2']);

        expect(bell()).toEqual([]);
        expect(queue('user-2')[0]).toMatchObject({ stage: 'email' });
      });

      it('queues nothing with email off, or with the fallback set to never', async () => {
        setPreference('user-2', 'chat_mention', true, false);
        setSettings('user-4', { email_fallback: false });

        await a.service.onMessage(author, group, message(), [
          'user-2',
          'user-4',
        ]);

        expect(bell()).toHaveLength(2);
        expect(queue()).toEqual([]);
      });

      it('gates a DM by chat_dm, not by chat_mention', async () => {
        setPreference('user-2', 'chat_mention', false, false);

        await a.service.onMessage(author, dm, message(), []);

        expect(bell('user-2')).toHaveLength(1);
        expect(queue('user-2')).toHaveLength(1);
      });
    });

    describe('edits', () => {
      it('notifies only the given new mentions: not the DM, not the thread again', async () => {
        seedMessage('root', { seq: 1, author_id: 'user-4' });

        await a.service.onMessage(author, dm, message('m1', 5), [], true);
        await a.service.onMessage(
          author,
          group,
          message('r1', 6, 'root'),
          ['user-2'],
          true,
        );

        expect(bell().map((row) => [row.user_id, row.type])).toEqual([
          ['user-2', 'chat_mention'],
        ]);
      });

      it('keeps the one queue row per person and message as it is', async () => {
        await a.service.onMessage(author, group, message(), ['user-2']);
        // Already retried once after a mail server error.
        const state = { attempts: 1, due_at: minutesAfter(NOON, 3) };
        Object.assign(queue('user-2')[0], state);

        await a.service.onMessage(author, group, message(), ['user-2'], true);

        expect(queue('user-2')).toEqual([expect.objectContaining(state)]);
      });

      it('does not notify a member whose history starts after the message: they cannot read it', async () => {
        // Dan was added "from now on" after message 5.
        member(group.id, 'user-4').history_from_seq = 5;

        await a.service.onMessage(
          author,
          group,
          message('m1', 5),
          ['user-2', 'user-4'],
          true,
        );

        expect(bell().map((row) => row.user_id)).toEqual(['user-2']);
        expect(queue().map((row) => row.user_id)).toEqual(['user-2']);
      });

      it('adds no second entry while the person has an unread one for the same message', async () => {
        // The DM already told Ben about m1, the thread reply told Dan about r1.
        seedMessage('root', { seq: 1, author_id: 'user-4' });
        await a.service.onMessage(author, dm, message('m1', 5), []);
        await a.service.onMessage(author, group, message('r1', 6, 'root'), []);
        const told = [
          ['user-2', 'm1'],
          ['user-4', 'r1'],
        ];
        expect(bell().map((row) => [row.user_id, row.reference_id])).toEqual(
          told,
        );

        await a.service.onMessage(
          author,
          dm,
          message('m1', 5),
          ['user-2'],
          true,
        );
        await a.service.onMessage(
          author,
          group,
          message('r1', 6, 'root'),
          ['user-2', 'user-4'],
          true,
        );

        // Only Ben's mention in r1 is news.
        expect(bell().map((row) => [row.user_id, row.reference_id])).toEqual([
          ...told,
          ['user-2', 'r1'],
        ]);

        // Once Dan has read his entry, a new mention tells him again.
        bell('user-4')[0].is_read = true;
        await a.service.onMessage(
          author,
          group,
          message('r1', 6, 'root'),
          ['user-4'],
          true,
        );
        expect(bell('user-4')).toHaveLength(2);
      });
    });
  });

  describe('onRead', () => {
    it('drops my pending rows and marks my unread chat entries read, up to the read position only', async () => {
      const mine = { organization_id: ORG, user_id: 'user-2', is_read: false };
      const chat = (seq: number, conversation_id = group.id) => ({
        ...mine,
        reference_type: 'chat_message',
        metadata: { conversation_id, seq },
      });
      seedQueue({ message_id: 'm1', seq: 5 });
      seedQueue({ message_id: 'm2', seq: 9 }); // not read yet
      seedQueue({ message_id: 'm3', seq: 4, conversation_id: dm.id });
      seedQueue({ message_id: 'm1', seq: 5, user_id: 'user-4' });
      db.seed(
        'notifications',
        { id: 'read-me', ...chat(5) },
        { id: 'summary', ...chat(7), type: 'chat_summary' },
        { id: 'later', ...chat(9) },
        { id: 'other-conversation', ...chat(3, dm.id) },
        { id: 'someone-else', ...chat(5), user_id: 'user-4' },
        { id: 'a-task', ...mine, reference_type: 'task', metadata: {} },
      );

      await a.service.onRead(ben, group.id, 7);

      expect(queue().map((row) => [row.user_id, row.message_id])).toEqual([
        ['user-2', 'm2'],
        ['user-2', 'm3'],
        ['user-4', 'm1'],
      ]);
      expect(
        bell()
          .filter((row) => row.is_read)
          .map((row) => row.id),
      ).toEqual(['read-me', 'summary']);
    });

    it('never throws', async () => {
      db.errors[QUEUE] = 'relation does not exist';

      await expect(a.service.onRead(ben, group.id, 7)).resolves.toBeUndefined();
    });
  });

  describe('settings', () => {
    it('answers the defaults for someone who never saved any', async () => {
      await expect(a.service.getSettings(ben)).resolves.toEqual({
        dndUntil: null,
        workingHours: null,
        timezone: null,
        emailFallbackMinutes: 30,
        paused: null,
        emailDeliveryEnabled: false,
      });
    });

    it('computes the pause for now and reports "never" as 0', async () => {
      const dndUntil = minutesAfter(NOON, 30);
      setSettings('user-2', {
        dnd_until: dndUntil,
        timezone: 'Europe/Vienna',
        working_hours: { wed: { start: '08:00', end: '17:00' } },
        email_fallback: false,
      });
      a.mail.deliveryEnabled = true;

      await expect(a.service.getSettings(ben)).resolves.toEqual({
        dndUntil,
        workingHours: { wed: { start: '08:00', end: '17:00' } },
        timezone: 'Europe/Vienna',
        emailFallbackMinutes: 0,
        paused: 'dnd',
        emailDeliveryEnabled: true,
      });

      jest.setSystemTime(NOON.getTime() + 31 * 60_000);
      await expect(a.service.getSettings(ben)).resolves.toMatchObject({
        dndUntil: null, // over
        paused: null,
      });

      jest.setSystemTime(Date.parse('2026-10-14T19:00:00Z')); // 21:00
      await expect(a.service.getSettings(ben)).resolves.toMatchObject({
        paused: 'working_hours',
      });
    });

    it('never reads the settings of the same person in another organization', async () => {
      setSettings('user-2', { dnd_until: minutesAfter(NOON, 30) });

      await expect(
        a.service.getSettings({ ...ben, organizationId: 'org-2' }),
      ).resolves.toMatchObject({ dndUntil: null, paused: null });
    });

    it('saves only the given keys, for the caller and their organization', async () => {
      setSettings('user-2', { timezone: 'Europe/Vienna' });
      setSettings('user-4', {});

      const view = await a.service.updateSettings(ben, {
        dndUntil: minutesAfter(NOON, 60),
        emailFallbackMinutes: 15,
      });

      expect(view).toMatchObject({
        dndUntil: minutesAfter(NOON, 60),
        timezone: 'Europe/Vienna',
        emailFallbackMinutes: 15,
        paused: 'dnd',
      });
      expect(db.rows('chat_user_settings')).toEqual([
        expect.objectContaining({
          organization_id: ORG,
          user_id: 'user-2',
          dnd_until: minutesAfter(NOON, 60),
          timezone: 'Europe/Vienna',
          email_fallback: true,
          email_fallback_minutes: 15,
        }),
        expect.objectContaining({ user_id: 'user-4', dnd_until: null }),
      ]);
    });

    it('creates the row on first save and stores "never" as the boolean', async () => {
      const view = await a.service.updateSettings(ben, {
        emailFallbackMinutes: 0,
      });

      expect(view.emailFallbackMinutes).toBe(0);
      expect(db.rows('chat_user_settings')).toEqual([
        expect.objectContaining({
          organization_id: ORG,
          user_id: 'user-2',
          email_fallback: false,
          // the minutes column only ever holds 15, 30 or 60
          email_fallback_minutes: 30,
        }),
      ]);
    });

    it('refuses working hours without a timezone, also when the stored one is being cleared', async () => {
      const workingHours = { mon: { start: '08:00', end: '17:00' } };

      await expect(
        a.service.updateSettings(ben, { workingHours }),
      ).rejects.toThrow(BadRequestException);
      expect(db.rows('chat_user_settings')).toEqual([]);

      await a.service.updateSettings(ben, {
        workingHours,
        timezone: 'Europe/Vienna',
      });
      // The timezone is already stored: the hours alone are fine now.
      await expect(
        a.service.updateSettings(ben, {
          workingHours: { tue: { start: '09:00', end: '12:00' } },
        }),
      ).resolves.toMatchObject({
        workingHours: { tue: { start: '09:00', end: '12:00' } },
      });
      await expect(
        a.service.updateSettings(ben, { timezone: null }),
      ).rejects.toThrow(BadRequestException);
    });

    it('stores do not disturb as an instant, and refuses what the database cannot read', async () => {
      await a.service.updateSettings(ben, {
        dndUntil: '2026-10-14T14:00:00+02:00',
      });
      expect(db.rows('chat_user_settings')[0].dnd_until).toBe(
        '2026-10-14T12:00:00.000Z',
      );

      // Both pass @IsISO8601: a week date, and an offset that lands in year 10000.
      for (const dndUntil of ['2026-W42-3', '9999-12-31T23:59:59-12:00']) {
        await expect(
          a.service.updateSettings(ben, { dndUntil }),
        ).rejects.toThrow(BadRequestException);
      }
      expect(db.rows('chat_user_settings')[0].dnd_until).toBe(
        '2026-10-14T12:00:00.000Z',
      );
    });

    it('stores an empty schedule as none, and null clears a value', async () => {
      setSettings('user-2', {
        timezone: 'Europe/Vienna',
        working_hours: { mon: { start: '08:00', end: '17:00' } },
        dnd_until: minutesAfter(NOON, 60),
      });

      await a.service.updateSettings(ben, { workingHours: {}, dndUntil: null });

      expect(db.rows('chat_user_settings')[0]).toMatchObject({
        working_hours: null,
        dnd_until: null,
        timezone: 'Europe/Vienna',
      });
    });

    it('wakes my held rows when the pause changes, so ending it releases within a minute', async () => {
      const later = minutesAfter(NOON, 600);
      seedQueue({ message_id: 'm1', stage: 'held', due_at: later });
      seedQueue({ message_id: 'm2', stage: 'email', due_at: later });
      seedQueue({
        message_id: 'm3',
        stage: 'held',
        due_at: later,
        user_id: 'user-4',
      });

      await a.service.updateSettings(ben, { emailFallbackMinutes: 60 });
      expect(queue().map((row) => row.due_at)).toEqual([later, later, later]);

      await a.service.updateSettings(ben, { dndUntil: null });
      expect(queue().map((row) => row.due_at)).toEqual([
        NOON.toISOString(),
        later,
        later,
      ]);
    });
  });

  describe('availability', () => {
    it('answers outside-hours and the local time, never do not disturb', async () => {
      const hours = { wed: { start: '08:00', end: '17:00' } };
      setSettings('user-2', {
        timezone: 'Europe/Vienna',
        working_hours: hours,
        dnd_until: minutesAfter(NOON, 600), // private
      });
      setSettings('user-3', { timezone: 'Asia/Tokyo', working_hours: hours });
      setSettings('user-4', { timezone: 'America/New_York' });
      // The same person in another organization must not be read.
      db.seed('chat_user_settings', {
        organization_id: 'org-2',
        user_id: 'user-5',
        timezone: 'Asia/Tokyo',
        working_hours: hours,
      });

      await expect(
        a.service.availability(author, [
          'user-2',
          'user-3',
          'user-4',
          'user-5',
          'user-2',
        ]),
      ).resolves.toEqual([
        { userId: 'user-2', outsideWorkingHours: false, localTime: '12:00' },
        { userId: 'user-3', outsideWorkingHours: true, localTime: '19:00' },
        { userId: 'user-4', outsideWorkingHours: false, localTime: '06:00' },
        { userId: 'user-5', outsideWorkingHours: false, localTime: null },
      ]);
    });
  });

  describe('sweep', () => {
    afterEach(() => {
      mailEnabled = false;
    });

    beforeEach(() => {
      mailEnabled = true;
      a.mail.deliveryEnabled = true;
      seedMessage('m1', { seq: 5 });
      seedMessage('m2', { seq: 6 });
      seedMessage('m3', { seq: 7 });
      seedMessage('d1', {
        seq: 3,
        conversation_id: dm.id,
        author_id: 'user-4',
      });
      db.seed(
        'chat_message_refs',
        ...['m1', 'm2', 'm3'].map((message_id) => ({
          organization_id: ORG,
          message_id,
          ref_type: 'user',
          ref_id: 'user-2',
        })),
      );
    });

    describe('release of held notifications', () => {
      const held = (overrides: Row) =>
        seedQueue({ stage: 'held', ...overrides });

      it('releases everything held as ONE summary entry and starts the email delay (AC-5)', async () => {
        held({ message_id: 'm1', seq: 5 });
        held({ message_id: 'm2', seq: 6 });
        held({ message_id: 'm3', seq: 7, reason: 'thread_reply' });
        // Not due on its own: released together with the others.
        const newest = held({
          message_id: 'd1',
          seq: 3,
          conversation_id: dm.id,
          reason: 'dm',
          actor_id: 'user-4',
          due_at: minutesAfter(NOON, 500),
        });

        await a.service.sweepOnce(NOON);

        expect(bell()).toEqual([
          expect.objectContaining({
            organization_id: ORG,
            user_id: 'user-2',
            type: 'chat_summary',
            title: '4 new chat notifications while you were away',
            body: null,
            is_read: false,
            action_status: 'none',
            reference_type: 'chat_message',
            reference_id: newest.message_id,
            // A summary names nobody: the count is all the client phrases it from.
            metadata: {
              link: '/chat/conv-d?m=d1',
              conversation_id: 'conv-d',
              seq: 3,
              count: 4,
            },
          }),
        ]);
        expect(a.broadcastNotification.mock.calls).toEqual([
          [
            {
              id: bell()[0].id,
              user_id: 'user-2',
              type: 'chat_summary',
              title: 'New chat notifications',
              created_at: bell()[0].created_at,
              metadata: { link: '/chat/conv-d?m=d1' },
            },
          ],
        ]);
        // Mentions and DMs wait for the email now; the thread reply is done.
        expect(
          queue().map((row) => [
            row.message_id,
            row.stage,
            row.due_at,
            row.claimed_at,
          ]),
        ).toEqual([
          ['m1', 'email', minutesAfter(NOON, 30), null],
          ['m2', 'email', minutesAfter(NOON, 30), null],
          ['d1', 'email', minutesAfter(NOON, 30), null],
        ]);
        expect(a.mail.sendNotification).not.toHaveBeenCalled();
      });

      it('queues no email on a server that sends none', async () => {
        a.mail.deliveryEnabled = false;
        held({ message_id: 'm1', seq: 5 });
        held({
          message_id: 'd1',
          seq: 3,
          conversation_id: dm.id,
          reason: 'dm',
        });

        await a.service.sweepOnce(NOON);

        expect(bell().map((row) => row.type)).toEqual(['chat_summary']);
        expect(queue()).toEqual([]);
      });

      it('releases what was held without sending an email that is not due yet', async () => {
        held({ message_id: 'm1', seq: 5, reason: 'thread_reply' });
        seedQueue({
          message_id: 'm2',
          seq: 6,
          due_at: minutesAfter(NOON, 20),
        });

        await a.service.sweepOnce(NOON);

        expect(bell().map((row) => row.type)).toEqual(['chat_summary']);
        expect(a.mail.sendNotification).not.toHaveBeenCalled();
        expect(
          queue().map((row) => [row.message_id, row.stage, row.due_at]),
        ).toEqual([['m2', 'email', minutesAfter(NOON, 20)]]);
      });

      it('says "1 new chat notification" for a single one', async () => {
        held({});

        await a.service.sweepOnce(NOON);

        expect(bell()[0].title).toBe(
          '1 new chat notification while you were away',
        );
      });

      it('moves the rows of someone who is still paused to the end of the pause, and delivers nothing', async () => {
        setSettings('user-2', { dnd_until: minutesAfter(NOON, 45) });
        held({ message_id: 'm1' });
        const notDue = seedQueue({
          message_id: 'm2',
          due_at: minutesAfter(NOON, 10),
        });

        await a.service.sweepOnce(NOON);

        expect(bell()).toEqual([]);
        expect(a.mail.sendNotification).not.toHaveBeenCalled();
        expect(
          queue().map((row) => [row.stage, row.due_at, row.claimed_at]),
        ).toEqual([
          ['held', minutesAfter(NOON, 45), null],
          // not due yet: only handed back
          ['email', notDue.due_at, null],
        ]);
      });

      it('holds a due email too while the person is outside working hours', async () => {
        setSettings('user-2', {
          timezone: 'Europe/Vienna',
          working_hours: { thu: { start: '08:00', end: '17:00' } },
        });
        seedQueue({});

        await a.service.sweepOnce(NOON); // Wednesday

        expect(a.mail.sendNotification).not.toHaveBeenCalled();
        expect(queue()[0]).toMatchObject({
          stage: 'email',
          due_at: '2026-10-15T06:00:00.000Z',
        });
      });

      it('writes no summary with in-app off, and no email row with email off', async () => {
        setPreference('user-2', 'chat_mention', false, false);
        held({});

        await a.service.sweepOnce(NOON);

        expect(bell()).toEqual([]);
        expect(queue()).toEqual([]);
      });

      it('counts only what is still valid', async () => {
        held({ message_id: 'm1', seq: 5 });
        held({ message_id: 'm2', seq: 6 });
        member(group.id, 'user-2').last_read_seq = 5; // m1 was read meanwhile

        await a.service.sweepOnce(NOON);

        expect(bell()[0]).toMatchObject({
          title: '1 new chat notification while you were away',
          metadata: { count: 1 },
        });
      });
    });

    describe('email fallback', () => {
      it('sends ONE email for everything pending, with names, counts and a link but no message text (AC-4)', async () => {
        seedQueue({ message_id: 'm1', seq: 5 });
        seedQueue({ message_id: 'm2', seq: 6, actor_id: 'user-3' });
        // Not due for another 20 minutes: goes into the same email.
        seedQueue({
          message_id: 'd1',
          seq: 3,
          conversation_id: dm.id,
          reason: 'dm',
          actor_id: 'user-4',
          due_at: minutesAfter(NOON, 20),
        });
        // At-most-once: the rows are gone before the mail server is called.
        a.mail.sendNotification.mockImplementation(() => {
          expect(queue('user-2')).toEqual([]);

          return Promise.resolve();
        });

        await a.service.sweepOnce(NOON);

        expect(a.mail.sendNotification.mock.calls).toEqual([
          [
            'ben@x.test',
            {
              title: 'You have 3 unread chat messages',
              subject: 'You have 3 unread chat messages',
              eyebrow: 'Chat',
              body: 'Anna Adler, Carla Cole in "Audit" (2)\nDan Dorn in a direct message (1)',
              ctaUrl: 'https://app.test/chat',
              ctaLabel: 'Open chat',
              recipientName: 'Ben',
            },
            { organizationId: ORG, locale: 'de' },
          ],
        ]);
        expect(
          JSON.stringify(a.mail.sendNotification.mock.calls),
        ).not.toContain(SECRET);
        // SMTP is off in this instance: the logged mail counts as sent.
        expect(queue()).toEqual([]);
        expect(bell()).toEqual([]);
      });

      it('links straight to the message when everything is in one conversation', async () => {
        db.seed(
          'chat_conversations',
          conversationRow({
            id: 'conv-s2',
            kind: 'space',
            space_id: 'space-1',
          }),
        );
        seedMessage('s1', { seq: 2, conversation_id: 'conv-s2' });
        seedQueue({
          message_id: 's1',
          seq: 2,
          conversation_id: 'conv-s2',
          reason: 'dm',
        });
        spaceViewers.add('user-2');

        await a.service.sweepOnce(NOON);

        expect(a.mail.sendNotification.mock.calls[0][1]).toMatchObject({
          title: 'You have 1 unread chat message',
          body: 'Anna Adler in #Finance (1)',
          ctaUrl: 'https://app.test/chat/conv-s2?m=s1',
        });
      });

      it('leaves rows alone while none of them is due', async () => {
        seedQueue({ due_at: minutesAfter(NOON, 5) });

        await a.service.sweepOnce(NOON);

        expect(a.mail.sendNotification).not.toHaveBeenCalled();
        expect(queue()).toEqual([
          expect.objectContaining({ stage: 'email', claimed_at: null }),
        ]);
        expect(db.log.filter((entry) => entry.op !== 'select')).toEqual([]);
      });

      it.each([
        [
          'the message was deleted',
          () => {
            db.rows('chat_messages')[0].deleted_at = NOON.toISOString();
          },
        ],
        [
          'the message is gone',
          () => {
            db.tables.chat_messages = [];
          },
        ],
        [
          'it was read meanwhile',
          () => {
            member(group.id, 'user-2').last_read_seq = 5;
          },
        ],
        [
          'the person can no longer read the conversation',
          () => {
            db.tables.chat_members = db
              .rows('chat_members')
              .filter((row) => row.user_id !== 'user-2');
          },
        ],
        [
          'the mention was edited out',
          () => {
            db.tables.chat_message_refs = [];
          },
        ],
      ])('drops the row and sends nothing when %s', async (_name, change) => {
        seedQueue({ message_id: 'm1', seq: 5 });
        change();

        await a.service.sweepOnce(NOON);

        expect(a.mail.sendNotification).not.toHaveBeenCalled();
        expect(queue()).toEqual([]);
      });

      it('still emails a DM whose mention was edited out, as a DM', async () => {
        seedQueue({ message_id: 'd1', seq: 3, conversation_id: dm.id });

        await a.service.sweepOnce(NOON);

        expect(a.mail.sendNotification).toHaveBeenCalledTimes(1);
      });

      it('sends nothing when the email preference is off, the fallback is "never", or there is no address', async () => {
        setPreference('user-2', 'chat_mention', true, false);
        setSettings('user-4', { email_fallback: false });
        db.rows('users').find((row) => row.id === 'user-3')!.email = null;
        db.seed('chat_members', {
          organization_id: ORG,
          conversation_id: group.id,
          user_id: 'user-3',
        });
        db.seed(
          'chat_message_refs',
          ...['user-3', 'user-4'].map((ref_id) => ({
            organization_id: ORG,
            message_id: 'm1',
            ref_type: 'user',
            ref_id,
          })),
        );
        seedQueue({ user_id: 'user-2' });
        seedQueue({ user_id: 'user-3' });
        seedQueue({ user_id: 'user-4' });

        await a.service.sweepOnce(NOON);

        expect(a.mail.sendNotification).not.toHaveBeenCalled();
        expect(queue()).toEqual([]);
      });

      it('queues again after a mail server error, with one more attempt, 5 minutes later', async () => {
        seedQueue({ message_id: 'm1', seq: 5 });
        seedQueue({ message_id: 'm2', seq: 6, attempts: 1 });
        a.mail.sendNotification.mockRejectedValue(new Error('SMTP 451'));

        await a.service.sweepOnce(NOON);

        expect(
          queue().map((row) => [
            row.message_id,
            row.stage,
            row.attempts,
            row.due_at,
            row.claimed_at,
          ]),
        ).toEqual([
          ['m1', 'email', 1, minutesAfter(NOON, 5), null],
          ['m2', 'email', 2, minutesAfter(NOON, 5), null],
        ]);
      });

      it('gives up after the third failed attempt', async () => {
        seedQueue({});
        a.mail.sendNotification.mockRejectedValue(new Error('SMTP 451'));

        for (const minutes of [0, 6, 12, 18]) {
          await a.service.sweepOnce(
            new Date(NOON.getTime() + minutes * 60_000),
          );
        }

        expect(a.mail.sendNotification).toHaveBeenCalledTimes(3);
        expect(queue()).toEqual([]);
      });
    });

    describe('more than one instance', () => {
      it('does not deliver twice when two instances sweep at the same moment', async () => {
        const b = instance('b');
        seedQueue({ message_id: 'm1', seq: 5 });
        seedQueue({ message_id: 'm2', seq: 6, stage: 'held' });

        await Promise.all([
          a.service.sweepOnce(NOON),
          b.service.sweepOnce(NOON),
        ]);

        // The ticks really interleaved: both saw the due rows before either claimed.
        const firstClaim = db.log.findIndex((entry) => entry.op === 'update');
        expect(
          db.log
            .slice(0, firstClaim)
            .filter((entry) => entry.table === QUEUE)
            .map((entry) => entry.by),
        ).toEqual(['a', 'b']);

        expect(
          a.mail.sendNotification.mock.calls.length +
            b.mail.sendNotification.mock.calls.length,
        ).toBe(1);
        expect(bell().map((row) => row.type)).toEqual(['chat_summary']);
        expect(
          a.broadcastNotification.mock.calls.length +
            b.broadcastNotification.mock.calls.length,
        ).toBe(1);
        // m2 moved on to the email stage exactly once and is free again.
        expect(
          queue().map((row) => [row.message_id, row.stage, row.claimed_at]),
        ).toEqual([['m2', 'email', null]]);
      });

      it('does not deliver twice when the second instance starts while the first is sending', async () => {
        const b = instance('b');
        seedQueue({ message_id: 'm1', seq: 5 });
        a.mail.sendNotification.mockImplementation(async () => {
          await b.service.sweepOnce(NOON);
        });

        await a.service.sweepOnce(NOON);

        expect(a.mail.sendNotification).toHaveBeenCalledTimes(1);
        expect(b.mail.sendNotification).not.toHaveBeenCalled();
      });

      it('leaves a fresh claim alone and takes over one that is older than 5 minutes', async () => {
        const row = seedQueue({ claimed_at: minutesAfter(NOON, -4) });

        await a.service.sweepOnce(NOON);
        expect(a.mail.sendNotification).not.toHaveBeenCalled();
        expect(queue()[0].claimed_at).toBe(row.claimed_at);

        await a.service.sweepOnce(new Date(NOON.getTime() + 2 * 60_000));
        expect(a.mail.sendNotification).toHaveBeenCalledTimes(1);
        expect(queue()).toEqual([]);
      });

      it('delivers nothing from rows another instance took over meanwhile', async () => {
        seedQueue({});
        // Another instance re-claims the row right after this one's claim.
        filterReaders.mockImplementation((_c: unknown, ids: string[]) => {
          queue()[0].claimed_at = minutesAfter(NOON, 1);

          return Promise.resolve(ids);
        });

        await a.service.sweepOnce(NOON);

        expect(a.mail.sendNotification).not.toHaveBeenCalled();
        expect(queue()).toEqual([
          expect.objectContaining({ claimed_at: minutesAfter(NOON, 1) }),
        ]);
      });
    });

    it('keeps one tenant working when another one fails', async () => {
      db.seed('organization_members', {
        organization_id: 'org-2',
        user_id: 'user-2',
      });
      db.seed(
        'chat_conversations',
        conversationRow({ id: 'conv-x', organization_id: 'org-2' }),
      );
      db.seed('chat_members', {
        organization_id: 'org-2',
        conversation_id: 'conv-x',
        user_id: 'user-2',
      });
      seedMessage('x1', {
        organization_id: 'org-2',
        conversation_id: 'conv-x',
      });
      seedQueue({
        organization_id: 'org-2',
        conversation_id: 'conv-x',
        message_id: 'x1',
        reason: 'dm',
        due_at: minutesAfter(NOON, -9),
      });
      seedQueue({ message_id: 'm1' });
      filterReaders.mockImplementation(
        (conversation: ChatConversationRow, ids: string[]) =>
          conversation.organization_id === 'org-2'
            ? Promise.reject(new Error('boom'))
            : Promise.resolve(ids),
      );

      await a.service.sweepOnce(NOON);

      expect(a.mail.sendNotification).toHaveBeenCalledTimes(1);
      expect(a.mail.sendNotification.mock.calls[0][2]).toMatchObject({
        organizationId: ORG,
      });
      // The failed tenant's row is handed back for the next sweep.
      expect(queue()).toEqual([
        expect.objectContaining({ organization_id: 'org-2', claimed_at: null }),
      ]);
    });

    it('scopes every statement after the tenant lookup to one organization', async () => {
      seedQueue({ message_id: 'm1', seq: 5 });
      seedQueue({ message_id: 'm2', seq: 6, stage: 'held' });
      await a.service.onMessage(author, channel, message('m9', 9), ['user-3']);
      await a.service.onRead(ben, dm.id, 1);
      await a.service.updateSettings(ben, { dndUntil: null });
      await a.service.availability(ben, ['user-3']);
      await a.service.sweepOnce(new Date(NOON.getTime() + 60_000));

      const unscoped = db.log
        .filter((entry) => entry.table !== 'users') // users is not a tenant table
        .filter((entry) => !entry.columns.includes('organization_id'))
        .map((entry) => `${entry.op} ${entry.table}`);
      expect(db.log.length).toBeGreaterThan(20);
      expect(unscoped).toEqual([`select ${QUEUE}`]);
    });

    describe('the cron tick', () => {
      it('never throws, and logs instead, when the database is down', async () => {
        db.errors[QUEUE] = 'relation "chat_notification_queue" does not exist';

        await expect(a.service.sweep()).resolves.toBeUndefined();
      });

      it('skips a tick while the previous one is still running', async () => {
        seedQueue({});
        const once = jest.spyOn(a.service, 'sweepOnce');

        await Promise.all([a.service.sweep(), a.service.sweep()]);
        expect(once).toHaveBeenCalledTimes(1);

        // ...and runs again afterwards.
        await a.service.sweep();
        expect(once).toHaveBeenCalledTimes(2);
      });
    });
  });
});
