import { BadRequestException } from '@nestjs/common';
import {
  decodeSearchCursor,
  encodeSearchCursor,
  snippetSegments,
  splitSearchQuery,
} from './chat-search';

const ID = '33333333-3333-4333-8333-333333333333';
const START = String.fromCharCode(2);
const STOP = String.fromCharCode(3);

/** A cursor as a client could forge it. */
const forge = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

describe('splitSearchQuery', () => {
  it.each([
    ['rechnung -lieferant', 'rechnung', 'lieferant'],
    ['-lieferant rechnung -angebot', 'rechnung', 'lieferant angebot'],
    ['rechnung', 'rechnung', ''],
    ['-lieferant', '', 'lieferant'],
    // A hyphen inside a word is part of the word.
    ['e-mail -e-rechnung', 'e-mail', 'e-rechnung'],
    // A phrase keeps its dashes; a negated phrase excludes its words.
    ['"offer -final" x', '"offer -final" x', ''],
    ['x -"foo bar"', 'x', 'foo bar'],
    ['"never closed -word', '"never closed -word', ''],
    // A dash on its own separates.
    ['angebot - kunde', 'angebot kunde', ''],
    ['angebot -- kunde', 'angebot kunde', ''],
    ['--kunde', '', 'kunde'],
    // Postgres skips ( ) ! & | < and then reads the dash as "not".
    ['(-foo) bar', '( ) bar', 'foo'],
    ['a(-b', 'a(', 'b'],
    ['a|-b', 'a|', 'b'],
    ['a<-b', 'a<', 'b'],
    ['"x"-y', '"x"', 'y'],
    // File names keep their punctuation for the "contains" match.
    ['report(1).pdf', 'report(1).pdf', ''],
    ['  spaced   out  ', 'spaced out', ''],
    ['', '', ''],
    ['-', '', ''],
  ])('%j → must match %j, must not match %j', (q, positive, negative) => {
    expect(splitSearchQuery(q)).toEqual({ positive, negative });
  });
});

describe('search cursor', () => {
  it('round-trips created_at exactly as the database printed it, microseconds included', () => {
    const cursor = { createdAt: '2026-09-30T10:00:00.123456+00:00', id: ID };
    const encoded = encodeSearchCursor(cursor);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeSearchCursor(encoded)).toEqual(cursor);
  });

  it.each([
    '2026-09-30T10:00:00+00:00',
    '2026-09-30T10:00:00.5+02:00',
    '2024-02-29T23:59:59.999999-11:30',
    '2026-09-30T10:00:00Z',
  ])('accepts the timestamp %s', (createdAt) => {
    expect(decodeSearchCursor(forge([createdAt, ID]))).toEqual({
      createdAt,
      id: ID,
    });
  });

  it('reads no cursor as the first page', () => {
    expect(decodeSearchCursor(undefined)).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['not base64', '!!!'],
    ['not json', Buffer.from('nope').toString('base64url')],
    [
      'one character changed',
      encodeSearchCursor({
        createdAt: '2026-09-30T10:00:00+00:00',
        id: ID,
      }).replace(/^./, '_'),
    ],
    ['an object', forge({ createdAt: '2026-09-30T10:00:00+00:00', id: ID })],
    ['half a cursor', forge(['2026-09-30T10:00:00+00:00'])],
    ['a third part', forge(['2026-09-30T10:00:00+00:00', ID, 'x'])],
    ['an id that is no uuid', forge(['2026-09-30T10:00:00+00:00', 'm1'])],
    ['an id that is not text', forge(['2026-09-30T10:00:00+00:00', 7])],
    ['sql in the timestamp', forge(["2026-09-30T10:00:00+00:00'; --", ID])],
    ['a date without time', forge(['2026-09-30', ID])],
    ['31 February', forge(['2026-02-31T10:00:00+00:00', ID])],
    ['month 13', forge(['2026-13-01T10:00:00+00:00', ID])],
    ['year 0', forge(['0000-01-01T10:00:00+00:00', ID])],
    ['an offset Postgres refuses', forge(['2026-09-30T10:00:00+16:00', ID])],
    ['infinity', forge(['infinity', ID])],
  ])('refuses a tampered cursor: %s', (_name, cursor) => {
    expect(() => decodeSearchCursor(cursor)).toThrow(
      new BadRequestException('Invalid cursor'),
    );
  });
});

describe('snippetSegments', () => {
  it('splits on the hit markers of the database function', () => {
    expect(
      snippetSegments(
        `Die ${START}Rechnungen${STOP} vom Mai ... zweite ${START}Rechnung${STOP}`,
      ),
    ).toEqual([
      { text: 'Die ', hit: false },
      { text: 'Rechnungen', hit: true },
      { text: ' vom Mai ... zweite ', hit: false },
      { text: 'Rechnung', hit: true },
    ]);
  });

  it('leaves html in a message as the text it is: nothing is escaped, stripped or marked up', () => {
    const segments = snippetSegments(
      `<b>bold</b> <img src=x onerror=alert(1)> ${START}<b>${STOP} &lt;mark&gt;`,
    );

    expect(segments).toEqual([
      { text: '<b>bold</b> <img src=x onerror=alert(1)> ', hit: false },
      { text: '<b>', hit: true },
      { text: ' &lt;mark&gt;', hit: false },
    ]);
    // The markers themselves never reach the client.
    expect(JSON.stringify(segments)).not.toMatch(/\\u000[23]/);
  });

  it('starts and ends with a hit without empty segments', () => {
    expect(snippetSegments(`${START}a${STOP} b ${START}c${STOP}`)).toEqual([
      { text: 'a', hit: true },
      { text: ' b ', hit: false },
      { text: 'c', hit: true },
    ]);
  });

  it('drops a marker that has no partner instead of passing it on', () => {
    expect(snippetSegments(`a ${START}b`)).toEqual([
      { text: 'a b', hit: false },
    ]);
    expect(snippetSegments(`a${STOP} ${START}b${STOP}`)).toEqual([
      { text: 'a ', hit: false },
      { text: 'b', hit: true },
    ]);
  });

  it('has no segments when nothing matched by text', () => {
    expect(snippetSegments(null)).toEqual([]);
    expect(snippetSegments('')).toEqual([]);
  });
});
