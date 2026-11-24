import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { isBlockedAddress } from '../../common/security/ssrf-guard';
import { sanitizeRichText } from '../../common/utils/sanitize-rich-text';

const MAX_BYTES = 2 * 1024 * 1024;
export interface FeedItem {
  title: string;
  url: string | null;
  content: string;
  date: string | null;
}
export interface Feed {
  title: string;
  url: string | null;
  description: string;
  items: FeedItem[];
}

function publicAddress(address: string): boolean {
  // IPv6 global unicast only. This also excludes mapped/translated IPv4 forms.
  return (
    !isBlockedAddress(address) &&
    (isIP(address) !== 6 || /^[23][0-9a-f]{3}:/i.test(address))
  );
}

export async function validateFeedUrl(raw: string) {
  const url = new URL(raw);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    raw.length > 2048
  ) {
    throw new Error('Use a public HTTP or HTTPS feed URL without credentials');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const records = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true });
  if (
    !records.length ||
    records.some((record) => !publicAddress(record.address))
  ) {
    throw new Error('Feed URL must resolve to a public address');
  }
  return { url, address: records[0].address, family: records[0].family };
}

function safeLink(raw: string): string | null {
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function xmlDocument(xml: string): Document {
  if (
    /<!\s*(?:DOCTYPE|ENTITY)/i.test(xml) ||
    Buffer.byteLength(xml) > MAX_BYTES
  )
    throw new Error('Unsupported or oversized feed XML');
  const { JSDOM } = require('jsdom') as {
    JSDOM: new (
      html: string,
      options: { contentType: string },
    ) => { window: { document: Document } };
  };
  try {
    return new JSDOM(xml, { contentType: 'text/xml' }).window.document;
  } catch {
    throw new Error('Feed is not valid XML');
  }
}

export function parseFeed(xml: string): Feed {
  const doc = xmlDocument(xml);
  const root = doc.documentElement;
  if (!['rss', 'RDF', 'feed'].includes(root.localName))
    throw new Error('URL did not return an RSS or Atom feed');
  const children = (node: Element, name: string) =>
    Array.from(node.children).filter((child) => child.localName === name);
  const text = (node: Element, name: string) =>
    children(node, name)[0]?.textContent?.trim() ?? '';
  const markup = (node: Element, name: string) => {
    const element = children(node, name)[0];
    return element?.getAttribute('type') === 'xhtml'
      ? element.innerHTML
      : (element?.textContent?.trim() ?? '');
  };
  const channel = children(root, 'channel')[0] ?? root;
  const link = (node: Element) => {
    const element = children(node, 'link').find(
      (el) => !el.getAttribute('rel') || el.getAttribute('rel') === 'alternate',
    );
    return safeLink(
      element?.getAttribute('href') || element?.textContent || '',
    );
  };
  const clean = (html: string) => {
    // Feed images/embeds would contact third parties from the reader's browser.
    const safe = sanitizeRichText(html, { allowTables: true }) ?? '';
    return safe.replace(
      /<(?:img|iframe|video|audio|source|use|image)\b[^>]*>(?:<\/(?:iframe|video|audio)>)?/gi,
      '',
    );
  };
  const entries =
    root.localName === 'feed'
      ? children(root, 'entry')
      : children(root.localName === 'RDF' ? root : channel, 'item');
  return {
    title: text(channel, 'title'),
    url: link(channel),
    description: clean(
      text(channel, 'description') || text(channel, 'subtitle'),
    ),
    items: entries.map((entry) => ({
      title: text(entry, 'title') || 'Untitled entry',
      url: link(entry),
      content: clean(
        markup(entry, 'encoded') ||
          markup(entry, 'content') ||
          markup(entry, 'description') ||
          markup(entry, 'summary'),
      ),
      date:
        text(entry, 'pubDate') ||
        text(entry, 'published') ||
        text(entry, 'updated') ||
        text(entry, 'date') ||
        null,
    })),
  };
}

async function download(
  raw: string,
  signal: AbortSignal,
  redirects = 0,
): Promise<string> {
  signal.throwIfAborted();
  const target = await new Promise<Awaited<ReturnType<typeof validateFeedUrl>>>(
    (resolve, reject) => {
      const abort = () => reject(new Error('Feed request timed out'));
      signal.addEventListener('abort', abort, { once: true });
      void validateFeedUrl(raw)
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', abort));
    },
  );
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = (
      target.url.protocol === 'https:' ? httpsRequest : httpRequest
    )(
      target.url,
      {
        signal,
        family: target.family,
        headers: {
          Accept:
            'application/rss+xml, application/atom+xml, application/xml, text/xml',
          'Accept-Encoding': 'identity',
        },
        // Connect to the validated address; retain original Host and TLS hostname.
        lookup: (_hostname, _options, callback) =>
          callback(null, target.address, target.family),
      },
      (response) => {
        response.on('error', reject);
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.resume();
          if (redirects >= 3 || !response.headers.location)
            return reject(new Error('Feed has too many redirects'));
          try {
            return void download(
              new URL(response.headers.location, target.url).href,
              signal,
              redirects + 1,
            ).then(resolve, reject);
          } catch {
            reject(new Error('Feed server returned an invalid redirect'));
            return;
          }
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`Feed server returned HTTP ${status}`));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) {
            response.destroy(new Error('Feed exceeds the 2 MB limit'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          try {
            const buffer = Buffer.concat(chunks);
            const charset =
              /charset=["']?([^;\s"']+)/i.exec(
                response.headers['content-type'] ?? '',
              )?.[1] ??
              /encoding=["']([^"']+)/i.exec(
                buffer.subarray(0, 160).toString('ascii'),
              )?.[1] ??
              'utf-8';
            resolve(new TextDecoder(charset, { fatal: true }).decode(buffer));
          } catch {
            reject(new Error('Feed character encoding is invalid'));
          }
        });
      },
    );
    request.on('error', reject);
    request.end();
  });
}

const cache = new Map<string, { expires: number; feed: Feed }>();
export async function fetchFeed(url: string): Promise<Feed> {
  const cached = cache.get(url);
  if (cached && cached.expires > Date.now()) return cached.feed;
  const feed = parseFeed(await download(url, AbortSignal.timeout(10_000)));
  if (cache.size >= 100) cache.delete(cache.keys().next().value!);
  cache.set(url, { expires: Date.now() + 60 * 60_000, feed });
  return feed;
}
