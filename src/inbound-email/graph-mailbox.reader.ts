// Microsoft Graph mailbox reads.
//
// Plain fetch, matching every other integration in this codebase — no Graph SDK
// dependency. Every request carries an AbortController timeout: this runs on a
// background loop, and a hung mailbox must never stall it.

import { Logger } from '@nestjs/common';
import type { RawMessage } from './email-normalizer';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const REQUEST_TIMEOUT_MS = 20_000;

// Bounds worst-case poll duration and stops a flood becoming a 10,000-task run.
export const MAX_MESSAGES_PER_POLL = 50;

// Bounds on pagination. A poll must always finish well inside its lease so the
// row is released and the next cycle can make progress.
const MAX_PAGES = 10;
const MAX_FETCH_MS = 60_000;

const SELECT_FIELDS = [
  'id',
  'internetMessageId',
  'subject',
  'receivedDateTime',
  'hasAttachments',
  'body',
  'bodyPreview',
  'from',
  'sender',
].join(',');

export class GraphResyncRequiredError extends Error {
  constructor() {
    super('Graph delta token expired — resync required');
  }
}

export interface FetchResult {
  messages: RawMessage[];
  /** deltaLink to store for the next poll; null when Graph returned none. */
  nextCursor: string | null;
}

const logger = new Logger('GraphMailboxReader');

async function timedFetch(url: string, token: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        // Ask Graph for the headers the loop guards depend on.
        Prefer: 'outlook.body-content-type="html"',
      },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export function describeGraphError(status: number, body: string): string {
  if (status === 401)
    return 'Mailbox token was rejected (401) — the client secret may have been rotated or expired.';
  // App-only 403s are almost always consent or an access policy, never "reconnect".
  if (status === 403)
    return (
      'Mailbox access denied (403). Check that Mail.Read is granted as an ' +
      'APPLICATION permission with admin consent, and that any Exchange ' +
      'Application Access Policy includes this mailbox.'
    );
  if (status === 404)
    return 'Mailbox not found (404) — check the address, and note that Microsoft 365 group mailboxes are not supported.';
  if (status === 429)
    return 'Microsoft is throttling this mailbox (429) — the next poll will retry.';

  return `Graph API error (${status}): ${body.slice(0, 300)}`;
}

/**
 * Fetch messages newer than the watermark, or since the stored delta cursor.
 *
 * Throws GraphResyncRequiredError on 410 Gone so the caller can clear the
 * cursor and re-seed from the watermark instead of wedging permanently.
 */
export async function fetchNewMessages(args: {
  accessToken: string;
  mailboxAddress: string;
  folder: string;
  watermarkAt: string;
  deltaCursor: string | null;
  unreadOnly?: boolean;
}): Promise<FetchResult> {
  const { accessToken, mailboxAddress, folder, watermarkAt, deltaCursor } =
    args;

  let url: string;

  if (deltaCursor) {
    url = deltaCursor;
  } else {
    // App-only: address the mailbox explicitly, there is no signed-in "me".
    //
    // Scoped to a FOLDER on purpose. /users/{id}/messages returns the whole
    // mailbox — Sent Items, Drafts and Deleted Items included — which would turn
    // every message this mailbox sends, and every half-written draft, into a
    // ticket.
    const clauses = [`receivedDateTime gt ${watermarkAt}`];

    // Optional, default off: a human opening the mail in Outlook first would
    // otherwise mark it read and it would never become a ticket.
    if (args.unreadOnly) clauses.push('isRead eq false');

    const filter = encodeURIComponent(clauses.join(' and '));

    url =
      `${GRAPH}/users/${encodeURIComponent(mailboxAddress)}` +
      `/mailFolders/${encodeURIComponent(folder)}/messages` +
      `?$select=${SELECT_FIELDS}` +
      `&$filter=${filter}` +
      `&$orderby=receivedDateTime asc` +
      `&$top=${MAX_MESSAGES_PER_POLL}`;
  }

  const messages: RawMessage[] = [];
  let nextCursor: string | null = null;
  let pageUrl: string | null = url;

  // Two independent stop conditions, because "collected enough messages" is not
  // one: with a $filter over a large mailbox Graph returns pages that match
  // nothing yet still carry an @odata.nextLink, so messages.length can stay 0
  // while paging forever. Without these the poll spins until its lease expires,
  // gets re-claimed, and spins again — no error, no progress, nothing logged.
  const deadline = Date.now() + MAX_FETCH_MS;
  let pages = 0;

  while (pageUrl && messages.length < MAX_MESSAGES_PER_POLL) {
    if (pages >= MAX_PAGES || Date.now() > deadline) {
      logger.warn(
        `mailbox fetch stopped early after ${pages} page(s) — remaining messages are picked up next poll`,
      );
      break;
    }

    pages++;

    const res: Response = await timedFetch(pageUrl, accessToken);

    if (res.status === 410) throw new GraphResyncRequiredError();

    if (!res.ok) {
      const body = await res.text().catch(() => '');

      throw new Error(describeGraphError(res.status, body));
    }

    const json = (await res.json()) as {
      value?: RawMessage[];
      '@odata.nextLink'?: string;
      '@odata.deltaLink'?: string;
    };

    messages.push(...(json.value ?? []));

    if (json['@odata.deltaLink']) {
      nextCursor = json['@odata.deltaLink'];
      break;
    }

    // Stop paginating at the cap; the remainder is picked up next poll.
    pageUrl =
      messages.length < MAX_MESSAGES_PER_POLL
        ? (json['@odata.nextLink'] ?? null)
        : null;
  }

  return { messages: messages.slice(0, MAX_MESSAGES_PER_POLL), nextCursor };
}

/**
 * Attachment metadata only — Phase 1 does not import files. One extra call, and
 * only when Graph flagged the message as having attachments.
 */
export async function fetchAttachmentMeta(
  accessToken: string,
  mailboxAddress: string,
  messageId: string,
): Promise<{ name?: string; contentType?: string; size?: number }[]> {
  try {
    const res = await timedFetch(
      `${GRAPH}/users/${encodeURIComponent(mailboxAddress)}` +
        `/messages/${encodeURIComponent(messageId)}` +
        `/attachments?$select=name,contentType,size`,
      accessToken,
    );

    if (!res.ok) return [];

    const json = (await res.json()) as {
      value?: { name?: string; contentType?: string; size?: number }[];
    };

    return json.value ?? [];
  } catch (err) {
    // Metadata is a nice-to-have; never fail a ticket over it.
    logger.warn(`attachment metadata fetch failed: ${String(err)}`);

    return [];
  }
}
