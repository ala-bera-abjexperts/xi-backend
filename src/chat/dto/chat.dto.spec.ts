import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ChatAvailabilityDto,
  ListMessagesQueryDto,
  SearchMessagesQueryDto,
  SendMessageDto,
  UpdateChatSettingsDto,
  UpdateMyConversationStateDto,
} from './chat.dto';

/** The names of the properties that failed validation. */
const invalid = async (dto: new () => object, body: Record<string, unknown>) =>
  (await validate(plainToInstance(dto, body))).map((error) => error.property);

const UUID = '22222222-2222-4222-8222-222222222222';

describe('SendMessageDto', () => {
  const send = { id: UUID, bodyHtml: '<p>@Robert</p>' };

  it('accepts a send without a timezone (older clients) and with an IANA zone', async () => {
    await expect(invalid(SendMessageDto, send)).resolves.toEqual([]);
    await expect(
      invalid(SendMessageDto, { ...send, timezone: 'Europe/Vienna' }),
    ).resolves.toEqual([]);
    await expect(
      invalid(SendMessageDto, { ...send, timezone: 'UTC' }),
    ).resolves.toEqual([]);
  });

  it.each([
    ['an unknown zone', 'Mars/Olympus'],
    ['an offset', 'GMT+2'],
    ['an empty zone', ''],
    ['not text', 2],
    ['a zone over 64 characters', `Europe/${'x'.repeat(60)}`],
  ])('rejects %s', async (_, timezone) => {
    await expect(
      invalid(SendMessageDto, { ...send, timezone }),
    ).resolves.toEqual(['timezone']);
  });
});

describe('UpdateChatSettingsDto', () => {
  it('accepts every setting, and null to clear one', async () => {
    await expect(
      invalid(UpdateChatSettingsDto, {
        dndUntil: '2026-10-14T12:00:00.000Z',
        workingHours: {
          mon: { start: '08:00', end: '17:00' },
          fri: { start: '22:00', end: '06:00' },
        },
        timezone: 'Europe/Vienna',
        emailFallbackMinutes: 15,
      }),
    ).resolves.toEqual([]);
    await expect(
      invalid(UpdateChatSettingsDto, {
        dndUntil: null,
        workingHours: null,
        timezone: null,
        emailFallbackMinutes: 0,
      }),
    ).resolves.toEqual([]);
    await expect(invalid(UpdateChatSettingsDto, {})).resolves.toEqual([]);
  });

  it.each([
    ['an unknown timezone', { timezone: 'Mars/Olympus' }, 'timezone'],
    ['an empty timezone', { timezone: '' }, 'timezone'],
    ['a timezone that is not text', { timezone: 2 }, 'timezone'],
    [
      'a do-not-disturb end that is no timestamp',
      { dndUntil: 'later' },
      'dndUntil',
    ],
    [
      'a delay that is not offered',
      { emailFallbackMinutes: 45 },
      'emailFallbackMinutes',
    ],
    ['a delay as text', { emailFallbackMinutes: '30' }, 'emailFallbackMinutes'],
    [
      'working hours whose start equals the end',
      { workingHours: { mon: { start: '08:00', end: '08:00' } } },
      'workingHours',
    ],
    [
      'working hours for an unknown day',
      { workingHours: { monday: { start: '08:00', end: '17:00' } } },
      'workingHours',
    ],
    [
      'working hours with extra data in a day',
      { workingHours: { mon: { start: '08:00', end: '17:00', x: '<b>' } } },
      'workingHours',
    ],
    [
      'working hours that are not an object',
      { workingHours: '9-5' },
      'workingHours',
    ],
  ])('rejects %s', async (_name, body, property) => {
    await expect(invalid(UpdateChatSettingsDto, body)).resolves.toEqual([
      property,
    ]);
  });
});

describe('ChatAvailabilityDto', () => {
  it('takes 1 to 50 user ids', async () => {
    const ids = (count: number) => Array.from({ length: count }, () => UUID);

    await expect(
      invalid(ChatAvailabilityDto, { userIds: ids(1) }),
    ).resolves.toEqual([]);
    await expect(
      invalid(ChatAvailabilityDto, { userIds: ids(50) }),
    ).resolves.toEqual([]);
    await expect(
      invalid(ChatAvailabilityDto, { userIds: [] }),
    ).resolves.toEqual(['userIds']);
    await expect(
      invalid(ChatAvailabilityDto, { userIds: ids(51) }),
    ).resolves.toEqual(['userIds']);
    await expect(
      invalid(ChatAvailabilityDto, { userIds: ['not-a-uuid'] }),
    ).resolves.toEqual(['userIds']);
    await expect(invalid(ChatAvailabilityDto, {})).resolves.toEqual([
      'userIds',
    ]);
  });
});

describe('UpdateMyConversationStateDto', () => {
  it('takes muteMentions as a boolean only', async () => {
    await expect(
      invalid(UpdateMyConversationStateDto, { muteMentions: true }),
    ).resolves.toEqual([]);
    await expect(
      invalid(UpdateMyConversationStateDto, { muteMentions: 'yes' }),
    ).resolves.toEqual(['muteMentions']);
  });
});

describe('SearchMessagesQueryDto', () => {
  // A query string: every value arrives as text.
  const everything = {
    q: 'rechnung -lieferant',
    conversationId: UUID,
    authorId: UUID,
    from: '2026-09-01T00:00:00Z',
    to: '2026-09-30T23:59:59Z',
    hasAttachment: 'true',
    hasObject: 'false',
    objectType: 'wiki_page',
    pinned: 'true',
    mentionsMe: 'false',
    cursor: 'WyIyMDI2LTA5LTMwVDEwOjAwOjAwKzAwOjAwIiwiMSJd',
    limit: '50',
  };

  it('takes every filter and reads the booleans and the limit from their text form', async () => {
    await expect(invalid(SearchMessagesQueryDto, everything)).resolves.toEqual(
      [],
    );
    expect(plainToInstance(SearchMessagesQueryDto, everything)).toMatchObject({
      hasAttachment: true,
      // 'false' is false, not a non-empty (truthy) string.
      hasObject: false,
      pinned: true,
      mentionsMe: false,
      limit: 50,
    });
  });

  it('takes filters without q, and nothing at all (the service asks for one of them)', async () => {
    await expect(
      invalid(SearchMessagesQueryDto, { pinned: 'true' }),
    ).resolves.toEqual([]);
    await expect(invalid(SearchMessagesQueryDto, {})).resolves.toEqual([]);
  });

  it.each([
    ['an empty q', { q: '' }, 'q'],
    ['a q over 200 characters', { q: 'a'.repeat(201) }, 'q'],
    [
      'a conversation that is no uuid',
      { conversationId: 'x' },
      'conversationId',
    ],
    ['an author that is no uuid', { authorId: 'x' }, 'authorId'],
    ['a start that is no date', { from: 'yesterday' }, 'from'],
    ['an end that is no date', { to: 'tomorrow' }, 'to'],
    ['a boolean that is neither true nor false', { pinned: 'yes' }, 'pinned'],
    ['a boolean as a number', { hasAttachment: '1' }, 'hasAttachment'],
    ['hasObject that is no boolean', { hasObject: 'no' }, 'hasObject'],
    ['mentionsMe that is no boolean', { mentionsMe: '' }, 'mentionsMe'],
    [
      'an object type that search cannot filter',
      { objectType: 'board' },
      'objectType',
    ],
    ['a cursor over 200 characters', { cursor: 'a'.repeat(201) }, 'cursor'],
    ['limit 0', { limit: '0' }, 'limit'],
    ['limit 51', { limit: '51' }, 'limit'],
  ])('rejects %s', async (_name, query, property) => {
    await expect(invalid(SearchMessagesQueryDto, query)).resolves.toEqual([
      property,
    ]);
  });

  it('passes the global ValidationPipe as a query string and refuses unknown parameters', async () => {
    // The options of main.ts.
    const pipe = new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    });
    const read = (query: Record<string, string>) =>
      pipe.transform(query, {
        type: 'query',
        metatype: SearchMessagesQueryDto,
      }) as Promise<SearchMessagesQueryDto>;

    await expect(
      read({ q: 'x', pinned: 'false', hasObject: 'true', limit: '5' }),
    ).resolves.toEqual({ q: 'x', pinned: false, hasObject: true, limit: 5 });
    await expect(read({ q: 'x', spaceId: UUID })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('has 200 characters of room for q', async () => {
    await expect(
      invalid(SearchMessagesQueryDto, { q: 'a'.repeat(200) }),
    ).resolves.toEqual([]);
  });
});

describe('ListMessagesQueryDto', () => {
  it('takes aroundMessageId as a uuid only', async () => {
    await expect(
      invalid(ListMessagesQueryDto, { aroundMessageId: UUID, limit: '50' }),
    ).resolves.toEqual([]);
    await expect(
      invalid(ListMessagesQueryDto, { aroundMessageId: 'm1' }),
    ).resolves.toEqual(['aroundMessageId']);
  });
});
