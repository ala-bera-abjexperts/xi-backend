/**
 * @fileoverview Pure helpers of the message search (XE-T353 CHAT-17): the negation
 * split, the paging cursor and the highlighted snippet. The search itself is the
 * database function `chat_search_messages` (migration 20261011100100_chat_search.sql).
 * @module src/chat/chat-search
 */

import { BadRequestException } from '@nestjs/common';

/** Where the search continues: the last row of the page before. */
export interface ChatSearchCursor {
  /** Exactly as the database returned it (microseconds included). */
  createdAt: string;
  id: string;
}

/** A piece of the snippet. It is plain text and must be rendered as text, never as html. */
export interface ChatSnippetSegment {
  text: string;
  hit: boolean;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A timestamp as Postgres prints it in json: 2026-09-30T10:00:00.123456+00:00. */
const TIMESTAMP_RE =
  /^(?!0000)(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,6})?(Z|[+-](0\d|1[0-5]):[0-5]\d)$/;

/**
 * The words of a web search query as Postgres reads them: a "quoted phrase" (with the
 * dashes right before it), or a run of characters up to a blank, a quote or one of
 * the characters ! & | ( ) < that websearch_to_tsquery skips.
 */
const SEARCH_TOKEN = /(-*)"([^"]*)"?|[^\s"!&|()<]+/g;

/**
 * Splits `rechnung -lieferant` into what must match and what must not. The database
 * function takes the two apart: a "-word" left inside a query that is OR-ed over
 * three languages matches the very messages it should exclude. So nothing that
 * Postgres would read as "not" may stay in the positive part:
 *  - "quoted phrases" stay as they are, dashes inside included;
 *  - a dash on its own ("offer - customer") separates, it does not exclude.
 * ponytail: -"exact phrase" excludes every word of the phrase, not the phrase as a
 * whole; the function would need a phrase form of p_not for more.
 */
export function splitSearchQuery(q: string): {
  positive: string;
  negative: string;
} {
  const negative: string[] = [];

  const positive = q
    .replace(
      SEARCH_TOKEN,
      (token: string, dashes?: string, phrase?: string) => {
        if (phrase !== undefined) {
          if (!dashes) return token;
          negative.push(...phrase.split(/\s+/));
          return ' ';
        }
        if (!token.startsWith('-')) return token;
        negative.push(token.replace(/^-+/, ''));
        return ' ';
      },
    )
    .replace(/\s+/g, ' ')
    .trim();

  return { positive, negative: negative.filter(Boolean).join(' ') };
}

/** Whether Postgres will take the value as a timestamp (so a forged cursor is a 400, not a 500). */
function isTimestamp(value: string): boolean {
  const [, year, month, day] = TIMESTAMP_RE.exec(value) ?? [];

  // 31 February passes the pattern but is no date.
  return (
    !!day && new Date(Date.UTC(+year, +month - 1, +day)).getUTCDate() === +day
  );
}

/** The opaque `nextCursor` of a search page. */
export function encodeSearchCursor(cursor: ChatSearchCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id])).toString(
    'base64url',
  );
}

/**
 * Reads a cursor back. It only moves the position inside what the caller may read
 * anyway (the function applies every access rule again), so it is checked for its
 * shape, not signed.
 *
 * @throws BadRequestException when it is not a cursor this API handed out
 */
export function decodeSearchCursor(cursor?: string): ChatSearchCursor | null {
  if (cursor === undefined) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    parsed = null;
  }

  const parts: unknown[] = Array.isArray(parsed) ? parsed : [];
  const [createdAt, id] = parts;
  if (
    parts.length !== 2 ||
    typeof createdAt !== 'string' ||
    typeof id !== 'string' ||
    !isTimestamp(createdAt) ||
    !UUID_RE.test(id)
  ) {
    throw new BadRequestException('Invalid cursor');
  }

  return { createdAt, id };
}

// The markers are control characters on purpose: no message text contains them.
// eslint-disable-next-line no-control-regex
const SNIPPET_HIT = /\u0002([^\u0002\u0003]*)\u0003/;
// eslint-disable-next-line no-control-regex
const SNIPPET_MARKER = /[\u0002\u0003]/g;

/**
 * Turns the snippet of the database function (hits between chr(2) and chr(3)) into
 * segments. Nothing is escaped or stripped: "<b>" in a message stays the text "<b>".
 */
export function snippetSegments(snippet: string | null): ChatSnippetSegment[] {
  if (!snippet) return [];

  // With one capture group, split() alternates: outside, hit, outside, hit, …
  return snippet
    .split(SNIPPET_HIT)
    .map((text, index) => ({
      text: text.replace(SNIPPET_MARKER, ''),
      hit: index % 2 === 1,
    }))
    .filter((segment) => segment.text !== '');
}
