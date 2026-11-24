// Microsoft Graph attachment reads.
//
// Split from graph-mailbox.reader.ts because this is a two-step read and the split IS the design:
// list metadata first, decide, and only then pull bytes. A single GET on /attachments returns every
// attachment with contentBytes inline as base64 — a 20 MB file arrives as ~27 MB of JSON that has to
// be parsed and held in memory before it can even be rejected for being too large.
//
// Same conventions as the mailbox reader: plain fetch, no Graph SDK, AbortController on every call
// because this runs on a background loop and a hung mailbox must never stall it.

import { Logger } from '@nestjs/common';
import { describeGraphError } from './graph-mailbox.reader';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const LIST_TIMEOUT_MS = 20_000;
// Longer than the list call: this one moves real bytes over the wire.
const DOWNLOAD_TIMEOUT_MS = 60_000;

const logger = new Logger('GraphAttachmentReader');

/** Only this type has retrievable bytes. */
export const FILE_ATTACHMENT_TYPE = '#microsoft.graph.fileAttachment';

export interface GraphAttachmentMeta {
  id: string;
  name: string;
  contentType: string;
  /**
   * Graph reports the attachment size INCLUDING MIME encoding overhead, so it over-estimates the
   * real file by roughly a third. Good enough as a pre-download guard — the true length is checked
   * again after download.
   */
  size: number;
  isInline: boolean;
  /** Absent on some tenants when $select is used; callers must tolerate an empty string. */
  odataType: string;
}

async function timedFetch(
  url: string,
  token: string,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    return await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Attachment metadata for one message.
 *
 * $select deliberately omits contentBytes — that single word is what keeps this call small.
 */
export async function listAttachments(
  accessToken: string,
  mailboxAddress: string,
  graphMessageId: string,
): Promise<GraphAttachmentMeta[]> {
  const res = await timedFetch(
    `${GRAPH}/users/${encodeURIComponent(mailboxAddress)}` +
      `/messages/${encodeURIComponent(graphMessageId)}` +
      `/attachments?$select=id,name,contentType,size,isInline`,
    accessToken,
    LIST_TIMEOUT_MS,
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');

    throw new Error(describeGraphError(res.status, body));
  }

  const json = (await res.json()) as {
    value?: {
      id?: string;
      name?: string;
      contentType?: string;
      size?: number;
      isInline?: boolean;
      '@odata.type'?: string;
    }[];
  };

  return (json.value ?? [])
    .filter((a): a is typeof a & { id: string } => Boolean(a.id))
    .map((a) => ({
      id: a.id,
      // Never '' — importVersion rejects a blank file name outright.
      name: (a.name ?? '').trim() || 'attachment',
      contentType: a.contentType || 'application/octet-stream',
      size: typeof a.size === 'number' && a.size > 0 ? a.size : 0,
      isInline: a.isInline === true,
      odataType: a['@odata.type'] ?? '',
    }));
}

/**
 * Raw bytes for one attachment.
 *
 * /$value returns the file itself rather than a base64 field, so nothing has to be decoded and the
 * buffer is exactly the file size. Only fileAttachment supports it: a referenceAttachment is a link
 * with no bytes and errors here, which is precisely how an absent @odata.type gets caught — the
 * caller treats a throw as "skip this one".
 */
export async function downloadAttachment(
  accessToken: string,
  mailboxAddress: string,
  graphMessageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const res = await timedFetch(
    `${GRAPH}/users/${encodeURIComponent(mailboxAddress)}` +
      `/messages/${encodeURIComponent(graphMessageId)}` +
      `/attachments/${encodeURIComponent(attachmentId)}/$value`,
    accessToken,
    DOWNLOAD_TIMEOUT_MS,
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');

    throw new Error(describeGraphError(res.status, body));
  }

  const buffer = Buffer.from(await res.arrayBuffer());

  if (buffer.byteLength === 0) {
    logger.warn(`attachment ${attachmentId} downloaded as 0 bytes`);
  }

  return buffer;
}
