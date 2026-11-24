import {
  type ChatNotifyInput,
  type ChatNotifyReason,
  type ChatPauseSettings,
  type WorkingHours,
  WEEK_DAYS,
  chatPreferenceKey,
  decideChatNotification,
  isOutsideWorkingHours,
  isPaused,
  isWorkingHours,
  localTime,
  nextAvailableAt,
} from './chat-notify-policy';

const at = (iso: string) => new Date(iso);

const everyDay = (start: string, end: string): WorkingHours =>
  Object.fromEntries(WEEK_DAYS.map((day) => [day, { start, end }]));

const schedule = (
  workingHours: WorkingHours | null,
  timezone: string | null = 'Europe/Vienna',
  dndUntil: string | null = null,
): ChatPauseSettings => ({ dndUntil, workingHours, timezone });

const base: ChatNotifyInput = {
  reason: 'mention',
  level: 'all',
  muted: false,
  muteMentions: false,
  paused: false,
  preferences: {},
  emailFallbackMinutes: 30,
};

describe('decideChatNotification', () => {
  const REASONS: ChatNotifyReason[] = [
    'plain',
    'mention',
    'dm',
    'thread_reply',
  ];
  const LEVELS = ['all', 'mentions', 'none'] as const;
  const BOOL = [false, true];

  /** The truth table of the design, written row by row. */
  const notifies = (i: ChatNotifyInput): boolean => {
    if (i.reason === 'plain') return false;
    if (i.reason === 'mention') {
      if (i.level !== 'none' && !i.muted) return true;
      return !i.muteMentions;
    }
    // dm and thread_reply: only when the conversation is not quiet
    return i.level !== 'none' && !i.muted;
  };

  it('follows the truth table for every combination (768 cases)', () => {
    let cases = 0;

    for (const reason of REASONS)
      for (const level of LEVELS)
        for (const muted of BOOL)
          for (const muteMentions of BOOL)
            for (const paused of BOOL)
              for (const inApp of BOOL)
                for (const email of BOOL)
                  for (const emailFallbackMinutes of [0, 15]) {
                    const input: ChatNotifyInput = {
                      reason,
                      level,
                      muted,
                      muteMentions,
                      paused,
                      preferences: {
                        [chatPreferenceKey(reason)]: { inApp, email },
                      },
                      emailFallbackMinutes,
                    };
                    const yes = notifies(input);

                    expect([input, decideChatNotification(input)]).toEqual([
                      input,
                      {
                        bell: !yes || !inApp ? 'none' : paused ? 'held' : 'now',
                        emailAfterMinutes:
                          yes &&
                          email &&
                          emailFallbackMinutes > 0 &&
                          (reason === 'mention' || reason === 'dm')
                            ? 15
                            : null,
                      },
                    ]);
                    cases += 1;
                  }

    expect(cases).toBe(768);
  });

  it('never creates a bell entry for a plain message, at any level (AC-1)', () => {
    for (const level of LEVELS) {
      expect(
        decideChatNotification({ ...base, reason: 'plain', level }),
      ).toEqual({ bell: 'none', emailAfterMinutes: null });
    }
  });

  it('lets a mention break through mute and "nothing" (AC-2, BR-3)', () => {
    expect(decideChatNotification({ ...base, muted: true }).bell).toBe('now');
    expect(decideChatNotification({ ...base, level: 'none' }).bell).toBe('now');
  });

  it('stops the break-through when the member muted mentions too', () => {
    expect(
      decideChatNotification({ ...base, muted: true, muteMentions: true }),
    ).toEqual({ bell: 'none', emailAfterMinutes: null });
    // mute_mentions alone changes nothing while the conversation is not quiet
    expect(decideChatNotification({ ...base, muteMentions: true }).bell).toBe(
      'now',
    );
  });

  it('notifies a DM unless that DM is muted', () => {
    expect(decideChatNotification({ ...base, reason: 'dm' })).toEqual({
      bell: 'now',
      emailAfterMinutes: 30,
    });
    expect(
      decideChatNotification({ ...base, reason: 'dm', muted: true }).bell,
    ).toBe('none');
  });

  it('holds while paused and still plans the email', () => {
    expect(
      decideChatNotification({ ...base, reason: 'dm', paused: true }),
    ).toEqual({ bell: 'held', emailAfterMinutes: 30 });
  });

  it('gives a thread reply a bell entry only, never an email', () => {
    expect(decideChatNotification({ ...base, reason: 'thread_reply' })).toEqual(
      { bell: 'now', emailAfterMinutes: null },
    );
    expect(
      decideChatNotification({ ...base, reason: 'thread_reply', muted: true })
        .bell,
    ).toBe('none');
  });

  it('reads chat_dm for a DM and chat_mention for mentions and thread replies', () => {
    const preferences = {
      chat_dm: { inApp: false, email: false },
      chat_mention: { inApp: true, email: true },
    };

    expect(
      decideChatNotification({ ...base, reason: 'dm', preferences }),
    ).toEqual({ bell: 'none', emailAfterMinutes: null });
    expect(decideChatNotification({ ...base, preferences }).bell).toBe('now');
    expect(
      decideChatNotification({ ...base, reason: 'thread_reply', preferences })
        .bell,
    ).toBe('now');
  });

  it('treats "never" as no email, and keeps the email when only the bell is off', () => {
    expect(
      decideChatNotification({ ...base, emailFallbackMinutes: 0 }),
    ).toEqual({ bell: 'now', emailAfterMinutes: null });
    expect(
      decideChatNotification({
        ...base,
        preferences: { chat_mention: { inApp: false, email: true } },
      }),
    ).toEqual({ bell: 'none', emailAfterMinutes: 30 });
  });
});

describe('isPaused', () => {
  const office = schedule({
    mon: { start: '09:00', end: '17:00' },
    tue: { start: '09:00', end: '17:00' },
    wed: { start: '09:00', end: '17:00' },
    thu: { start: '09:00', end: '17:00' },
    fri: { start: '09:00', end: '17:00' },
  });

  it('is not paused without settings, schedule or do-not-disturb', () => {
    const now = at('2026-10-14T03:00:00Z');

    expect(isPaused(null, now)).toBeNull();
    expect(isPaused(undefined, now)).toBeNull();
    expect(isPaused(schedule(null), now)).toBeNull();
    expect(isPaused(schedule({}), now)).toBeNull();
  });

  it('reports do-not-disturb until its end, before looking at the hours', () => {
    const dnd = schedule(null, null, '2026-10-14T12:00:00Z');

    expect(isPaused(dnd, at('2026-10-14T11:59:59Z'))).toBe('dnd');
    expect(isPaused(dnd, at('2026-10-14T12:00:00Z'))).toBeNull();
    expect(
      isPaused(
        { ...office, dndUntil: '2026-10-14T12:00:00Z' },
        at('2026-10-14T10:00:00Z'),
      ),
    ).toBe('dnd');
  });

  it('treats the start as inside and the end as outside, and a missing day as off', () => {
    // Wednesday 2026-10-14, Vienna is UTC+2
    expect(isPaused(office, at('2026-10-14T06:59:00Z'))).toBe('working_hours');
    expect(isPaused(office, at('2026-10-14T07:00:00Z'))).toBeNull();
    expect(isPaused(office, at('2026-10-14T14:59:00Z'))).toBeNull();
    expect(isPaused(office, at('2026-10-14T15:00:00Z'))).toBe('working_hours');
    // Saturday noon
    expect(isPaused(office, at('2026-10-17T10:00:00Z'))).toBe('working_hours');
  });

  it('keeps an overnight window with its start day', () => {
    // Friday 22:00 to 06:00 only
    const night = schedule({ fri: { start: '22:00', end: '06:00' } });

    expect(isPaused(night, at('2026-10-16T19:59:00Z'))).toBe('working_hours'); // Fri 21:59
    expect(isPaused(night, at('2026-10-16T20:00:00Z'))).toBeNull(); // Fri 22:00
    expect(isPaused(night, at('2026-10-17T03:59:00Z'))).toBeNull(); // Sat 05:59
    expect(isPaused(night, at('2026-10-17T04:00:00Z'))).toBe('working_hours'); // Sat 06:00
    // Saturday has no window of its own, so Saturday 23:00 is off
    expect(isPaused(night, at('2026-10-17T21:00:00Z'))).toBe('working_hours');
    // Thursday night belongs to Thursday, which is off: Friday 03:00 is off
    expect(isPaused(night, at('2026-10-16T01:00:00Z'))).toBe('working_hours');
  });

  it('ignores the schedule without a timezone or with an unknown one; do-not-disturb still works', () => {
    const now = at('2026-10-17T10:00:00Z'); // Saturday

    expect(isPaused({ ...office, timezone: null }, now)).toBeNull();
    expect(isPaused({ ...office, timezone: 'Mars/Olympus' }, now)).toBeNull();
    expect(
      isPaused(
        {
          ...office,
          timezone: 'Mars/Olympus',
          dndUntil: '2026-10-18T00:00:00Z',
        },
        now,
      ),
    ).toBe('dnd');
  });

  it('ignores a window whose start equals its end or that is malformed', () => {
    const now = at('2026-10-14T10:00:00Z');

    expect(
      isPaused(schedule({ wed: { start: '09:00', end: '09:00' } }), now),
    ).toBeNull();
    expect(
      isPaused(schedule({ wed: { start: '9', end: 'late' } }), now),
    ).toBeNull();
  });

  describe('daylight saving ends on 2026-10-25 at 01:00Z', () => {
    it('Europe/Vienna, Mon–Fri 09:00–17:00: the UTC boundary moves by one hour', () => {
      expect(isPaused(office, at('2026-10-23T07:30:00Z'))).toBeNull(); // Fri 09:30 CEST
      expect(isPaused(office, at('2026-10-26T07:30:00Z'))).toBe(
        'working_hours',
      ); // Mon 08:30 CET
      expect(isPaused(office, at('2026-10-26T08:00:00Z'))).toBeNull(); // Mon 09:00 CET
    });

    it('Europe/Vienna, quiet 22:00–07:00: both 02:30 hours are quiet', () => {
      const awake = schedule(everyDay('07:00', '22:00'));

      expect(isPaused(awake, at('2026-10-25T00:30:00Z'))).toBe('working_hours'); // 02:30 CEST
      expect(isPaused(awake, at('2026-10-25T01:30:00Z'))).toBe('working_hours'); // 02:30 CET
      expect(isPaused(awake, at('2026-10-25T05:59:00Z'))).toBe('working_hours'); // 06:59 CET
      expect(isPaused(awake, at('2026-10-25T06:00:00Z'))).toBeNull(); // 07:00 CET
    });

    it('Europe/Berlin, Sunday 08:00–17:00: 06:30Z is paused and release is 07:00Z', () => {
      const sunday = schedule(
        { sun: { start: '08:00', end: '17:00' } },
        'Europe/Berlin',
      );

      expect(isPaused(sunday, at('2026-10-25T06:30:00Z'))).toBe(
        'working_hours',
      );
      expect(nextAvailableAt(sunday, at('2026-10-25T06:30:00Z'))).toEqual(
        at('2026-10-25T07:00:00Z'),
      );
      // The same local time one week earlier (CEST) is one UTC hour sooner.
      expect(nextAvailableAt(sunday, at('2026-10-18T05:30:00Z'))).toEqual(
        at('2026-10-18T06:00:00Z'),
      );
    });

    it('Europe/Berlin, an overnight window stays open through both 02:xx hours', () => {
      const night = schedule(
        { sat: { start: '22:00', end: '06:00' } },
        'Europe/Berlin',
      );

      expect(isPaused(night, at('2026-10-24T20:00:00Z'))).toBeNull(); // Sat 22:00 CEST
      expect(isPaused(night, at('2026-10-25T00:30:00Z'))).toBeNull(); // 02:30 CEST
      expect(isPaused(night, at('2026-10-25T01:30:00Z'))).toBeNull(); // 02:30 CET
      expect(isPaused(night, at('2026-10-25T04:59:00Z'))).toBeNull(); // 05:59 CET
      expect(isPaused(night, at('2026-10-25T05:00:00Z'))).toBe('working_hours'); // 06:00 CET
    });
  });

  it('daylight saving starts (2027-03-28 01:00Z): a 02:30 start takes effect at 03:00', () => {
    const early = schedule(
      { sun: { start: '02:30', end: '04:00' } },
      'Europe/Berlin',
    );

    expect(isPaused(early, at('2027-03-28T00:59:00Z'))).toBe('working_hours'); // 01:59 CET
    expect(isPaused(early, at('2027-03-28T01:00:00Z'))).toBeNull(); // 03:00 CEST
    expect(nextAvailableAt(early, at('2027-03-28T00:10:00Z'))).toEqual(
      at('2027-03-28T01:00:00Z'),
    );
  });
});

describe('nextAvailableAt', () => {
  const office = schedule({ thu: { start: '08:00', end: '17:00' } });

  it('is now for someone who is not paused', () => {
    const now = at('2026-10-15T10:00:00Z');

    expect(nextAvailableAt(null, now)).toEqual(now);
    expect(nextAvailableAt(office, now)).toEqual(now);
  });

  it('is the end of do-not-disturb when the hours allow it then', () => {
    expect(
      nextAvailableAt(
        schedule(null, null, '2026-10-15T12:34:56Z'),
        at('2026-10-15T10:00:00Z'),
      ),
    ).toEqual(at('2026-10-15T12:34:56Z'));
  });

  it('is the next start of work for a DM at 21:00 (AC-3)', () => {
    // Wednesday 21:00 in Vienna; Thursday starts at 08:00 = 06:00Z
    expect(nextAvailableAt(office, at('2026-10-14T19:00:20Z'))).toEqual(
      at('2026-10-15T06:00:00Z'),
    );
  });

  it('finds a start that is not on a quarter hour', () => {
    const odd = schedule({ thu: { start: '08:07', end: '17:00' } });

    expect(nextAvailableAt(odd, at('2026-10-14T19:00:00Z'))).toEqual(
      at('2026-10-15T06:07:00Z'),
    );
  });

  it('moves past do-not-disturb to the next working window', () => {
    // do-not-disturb ends Thursday 18:00 local, after work: next Thursday 08:00
    expect(
      nextAvailableAt(
        { ...office, dndUntil: '2026-10-15T16:00:00Z' },
        at('2026-10-15T10:00:00Z'),
      ),
    ).toEqual(at('2026-10-22T06:00:00Z'));
  });

  it('never leaves the years Postgres can read, however far do-not-disturb reaches', () => {
    // Year 10000 is "+010000-…" in toISOString(), which Postgres refuses: one such
    // due_at would fail the whole queue insert and every sweep of that tenant.
    const next = nextAvailableAt(
      schedule(
        everyDay('08:00', '17:00'),
        'Europe/Vienna',
        '9999-12-31T23:59:59Z',
      ),
      at('2026-10-15T10:00:00Z'),
    );

    expect(next.toISOString()).toMatch(/^9999-12-/);
    expect(
      nextAvailableAt(
        schedule(null, null, '9999-12-31T23:59:59Z'),
        at('2026-10-15T10:00:00Z'),
      ).toISOString(),
    ).toMatch(/^9999-12-/);
  });
});

describe('isOutsideWorkingHours and localTime', () => {
  it('never looks at do-not-disturb', () => {
    expect(
      isOutsideWorkingHours(
        schedule(null, 'Europe/Vienna', '2099-01-01T00:00:00Z'),
        at('2026-10-14T10:00:00Z'),
      ),
    ).toBe(false);
  });

  it('formats the local time as HH:mm, or null without a usable zone', () => {
    const now = at('2026-10-14T19:40:00Z');

    expect(localTime('Europe/Vienna', now)).toBe('21:40');
    expect(localTime('America/New_York', at('2026-10-14T04:05:00Z'))).toBe(
      '00:05',
    );
    expect(localTime(null, now)).toBeNull();
    expect(localTime('Mars/Olympus', now)).toBeNull();
  });
});

describe('isWorkingHours', () => {
  it('accepts weekday keys with HH:mm pairs, including overnight', () => {
    expect(isWorkingHours({})).toBe(true);
    expect(
      isWorkingHours({
        mon: { start: '08:00', end: '17:00' },
        fri: { start: '22:00', end: '06:00' },
      }),
    ).toBe(true);
  });

  it.each([
    ['not an object', 'mon'],
    ['an array', []],
    ['null', null],
    ['an unknown day', { monday: { start: '08:00', end: '17:00' } }],
    ['start equal to end', { mon: { start: '08:00', end: '08:00' } }],
    ['a bad time', { mon: { start: '8:00', end: '17:00' } }],
    ['an impossible time', { mon: { start: '24:00', end: '17:00' } }],
    ['a missing end', { mon: { start: '08:00' } }],
    ['an extra key', { mon: { start: '08:00', end: '17:00', note: 'x' } }],
    ['a day set to null', { mon: null }],
  ])('rejects %s', (_name, value) => {
    expect(isWorkingHours(value)).toBe(false);
  });
});
