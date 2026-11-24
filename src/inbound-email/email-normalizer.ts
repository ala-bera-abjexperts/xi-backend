// Turns a raw Graph message into a task-shaped payload, or a reason to skip it.
//
// Pure functions only — no IO — so every edge case here is cheap to reason about.

import { createHash } from 'crypto';

// tasks.summary is @MaxLength(500); "Re: Fwd:" chains blow past it routinely.
const MAX_SUMMARY = 500;
const DEFAULT_MAX_BODY = 100_000;

export interface RawMessage {
  id?: string;
  internetMessageId?: string;
  subject?: string | null;
  receivedDateTime?: string;
  hasAttachments?: boolean;
  body?: { contentType?: string; content?: string } | null;
  bodyPreview?: string | null;
  from?: { emailAddress?: { address?: string; name?: string } } | null;
  sender?: { emailAddress?: { address?: string; name?: string } } | null;
  internetMessageHeaders?: { name?: string; value?: string }[] | null;
  attachments?: { name?: string; contentType?: string; size?: number }[] | null;
}

export interface NormalizedEmail {
  dedupeKey: string;
  messageId: string | null;
  inReplyTo: string | null;
  from: string;
  fromName: string | null;
  subject: string;
  summary: string;
  bodyHtml: string;
  receivedAt: string;
  hasAttachments: boolean;
  attachments: { name: string; contentType: string; size: number }[];
}

export type NormalizeResult =
  | { ok: true; email: NormalizedEmail }
  | { ok: false; skipReason: string };

function header(msg: RawMessage, name: string): string | null {
  const hit = (msg.internetMessageHeaders ?? []).find(
    (h) => (h.name ?? '').toLowerCase() === name.toLowerCase(),
  );

  return hit?.value ?? null;
}

// "<abc@host>" and "abc@host" must hash to the same key.
function normalizeMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/^</, '').replace(/>$/, '');

  return trimmed.length > 0 ? trimmed.toLowerCase() : null;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Flattens table markup into allow-listed tags.
 *
 * sanitizeRichText runs with allowTables:false inside TasksService.create, and
 * DOMPurify's DEFAULT_FORBID_CONTENTS drops the *text* of <thead>/<colgroup>,
 * not just the tags. Most system email is table-laid-out, so without this the
 * header row silently disappears from the ticket.
 */
export function flattenTables(html: string): string {
  if (!/<t(able|head|body|r|d|h)\b/i.test(html)) return html;

  return html
    .replace(/<\/?(table|tbody|thead|tfoot|colgroup|col)[^>]*>/gi, '')
    .replace(/<th\b[^>]*>/gi, '<strong>')
    .replace(/<\/th>/gi, '</strong> ')
    .replace(/<td\b[^>]*>/gi, '')
    .replace(/<\/td>/gi, ' ')
    .replace(/<tr\b[^>]*>/gi, '<p>')
    .replace(/<\/tr>/gi, '</p>');
}

/**
 * Trim a subject to at most `max` UTF-16 units (what CreateTaskDto's @MaxLength
 * counts) while never splitting a surrogate pair.
 *
 * Iterating the string yields whole code points, so an emoji is either kept or
 * dropped — never cut in half into a lone surrogate, which is invalid UTF-8 and
 * would be rejected or mangled by Postgres.
 */
function truncateSubject(subject: string, max: number): string {
  if (subject.length <= max) return subject;

  let out = '';

  for (const ch of subject) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }

  return `${out}…`;
}

/**
 * Cut an HTML body down to `max` characters.
 *
 * Cuts on a tag boundary rather than mid-tag: slicing blindly can land inside an
 * attribute and leave an unterminated quote, which swallows everything that
 * follows — including the truncation notice, so the reader would never be told
 * the message was cut.
 */
function truncate(html: string, max: number): string {
  if (html.length <= max) return html;

  const cut = html.slice(0, max);
  const lastClose = cut.lastIndexOf('>');
  const lastOpen = cut.lastIndexOf('<');
  // If a '<' is still open at the cut point, drop that partial tag.
  const safe = lastOpen > lastClose ? cut.slice(0, lastOpen) : cut;

  return `${safe}\n<p><em>[Message truncated — original was ${html.length} characters]</em></p>`;
}

/**
 * `includeSubdomains` deliberately differs between the two call sites.
 *
 * A block-list should match broadly — "@corp.com" must also stop
 * user@mail.corp.com, or the block leaks through any subdomain. An allow-list
 * must match strictly, because loosening it would let an attacker-controlled
 * subdomain in.
 */
function matchesList(
  address: string,
  list: string[],
  includeSubdomains: boolean,
): boolean {
  const addr = address.toLowerCase();
  const domain = addr.slice(addr.lastIndexOf('@') + 1);

  return list.some((entry) => {
    if (!entry.startsWith('@')) return addr === entry;

    const entryDomain = entry.slice(1);

    return includeSubdomains
      ? domain === entryDomain || domain.endsWith(`.${entryDomain}`)
      : domain === entryDomain;
  });
}

// trigger_config is user-authored JSON, so this may arrive as anything.
export function parseAddressList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  }

  if (typeof raw !== 'string') return [];

  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export interface NormalizeOptions {
  mailboxAddress?: string | null;
  blockedSenders?: string[];
  allowedSenders?: string[];
  maxBodyChars?: number;
}

export function normalizeMessage(
  msg: RawMessage,
  opts: NormalizeOptions = {},
): NormalizeResult {
  const from =
    msg.from?.emailAddress?.address ?? msg.sender?.emailAddress?.address ?? '';

  // Recorded, never silently dropped — a ticket with no sender is untraceable.
  if (!from) return { ok: false, skipReason: 'no_sender' };

  const fromLower = from.toLowerCase();

  // Loop guard 1: the mailbox talking to itself.
  if (opts.mailboxAddress && fromLower === opts.mailboxAddress.toLowerCase()) {
    return { ok: false, skipReason: 'self_send' };
  }

  // Loop guard 2: auto-responders and bulk mail, per RFC 3834 / common practice.
  const autoSubmitted = (header(msg, 'Auto-Submitted') ?? '').toLowerCase();

  if (autoSubmitted && autoSubmitted !== 'no') {
    return { ok: false, skipReason: 'auto_submitted' };
  }

  const precedence = (header(msg, 'Precedence') ?? '').toLowerCase();

  if (['bulk', 'list', 'junk'].includes(precedence)) {
    return { ok: false, skipReason: `precedence_${precedence}` };
  }

  if (
    opts.blockedSenders?.length &&
    matchesList(fromLower, opts.blockedSenders, true)
  ) {
    return { ok: false, skipReason: 'sender_blocked' };
  }
  if (
    opts.allowedSenders?.length &&
    !matchesList(fromLower, opts.allowedSenders, false)
  ) {
    return { ok: false, skipReason: 'sender_not_allowed' };
  }

  const receivedAt = msg.receivedDateTime ?? new Date().toISOString();
  const rawSubject = (msg.subject ?? '').trim();
  const subject = rawSubject.length > 0 ? rawSubject : '(no subject)';
  const summary = truncateSubject(subject, MAX_SUMMARY);

  // Track WHERE the content came from, not just what contentType claims. When
  // body.content is absent we fall back to bodyPreview, which is always plain
  // text — running that through the HTML path would render escaped markup.
  const usedPreview = !msg.body?.content && Boolean(msg.bodyPreview);
  const contentType = usedPreview
    ? 'text'
    : (msg.body?.contentType ?? '').toLowerCase();
  const rawBody = msg.body?.content ?? msg.bodyPreview ?? '';

  // An HTML shell with no words ("<html><body></body></html>") is non-empty as a
  // string but empty to a reader, and would otherwise produce a blank ticket
  // with no explanation.
  const hasVisibleText =
    rawBody
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .trim().length > 0;

  let bodyHtml: string;

  if (!hasVisibleText) {
    bodyHtml = `<p><em>This email had no body. Sent by ${escapeHtml(from)} at ${escapeHtml(receivedAt)}.</em></p>`;
  } else if (contentType === 'html') {
    bodyHtml = flattenTables(rawBody);
  } else {
    // Plain text: wrap so the editor renders it as paragraphs, not one blob.
    bodyHtml = rawBody
      .split(/\r?\n\r?\n/)
      .map((p) => `<p>${escapeHtml(p).replace(/\r?\n/g, '<br>')}</p>`)
      .join('');
  }

  // Coerce: trigger_config JSON can hand us "100000" as a string, and a bad
  // value must not disable truncation altogether.
  const cap = Number(opts.maxBodyChars);

  bodyHtml = truncate(
    bodyHtml,
    Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_MAX_BODY,
  );

  const messageId =
    normalizeMessageId(msg.internetMessageId) ??
    normalizeMessageId(header(msg, 'Message-ID'));

  // Fall back to a content hash: a surprising number of automated senders omit
  // or reuse Message-ID, and the dedupe key must still be stable per message.
  const dedupeKey =
    messageId ??
    sha256(`${fromLower}|${subject}|${receivedAt}|${rawBody.slice(0, 4096)}`);

  return {
    ok: true,
    email: {
      dedupeKey,
      messageId,
      inReplyTo: normalizeMessageId(header(msg, 'In-Reply-To')),
      from,
      fromName:
        msg.from?.emailAddress?.name ?? msg.sender?.emailAddress?.name ?? null,
      subject,
      summary,
      bodyHtml,
      receivedAt,
      hasAttachments: msg.hasAttachments === true,
      attachments: (msg.attachments ?? []).map((a) => ({
        name: a.name ?? 'attachment',
        contentType: a.contentType ?? 'application/octet-stream',
        size: a.size ?? 0,
      })),
    },
  };
}
