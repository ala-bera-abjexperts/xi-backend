/**
 * Jira Server (`/secure/attachment|thumbnail/:id`) and Jira Cloud
 * (`/rest/api/:version/attachment/content|thumbnail/:id`) URLs are stable source references, not
 * portable content URLs.  Once the attachment stage has copied the bytes, descriptions/comments
 * must point at the target attachment endpoint instead.  Keep this deliberately HTML-string based:
 * it only changes quoted href/src attribute values, so existing rich-text markup and user content
 * are otherwise untouched.
 */

export interface JiraAttachmentLink {
  sourceId: string;
  url: string;
  filename: string;
}

export interface JiraAttachmentRelinkReport {
  html: string;
  /** Number of href/src values rewritten to XiSuite download routes. */
  rewritten: number;
  /**
   * Origin-permitted source links with no entry in the target map.  Foreign-origin and
   * already-relinked URLs are never included: third-party links stay external and unreported.
   */
  unresolved: JiraAttachmentLink[];
}

export interface JiraAttachmentRelinkOptions {
  /** The migration connection URL. Absolute links on any other origin stay untouched. */
  sourceBaseUrl?: string | null;
  /**
   * Additional origins the SOURCE advertised for its own files (Jira's configured `base.url`,
   * recorded as `source_origin` on each attachment mapping). On-premise the connection URL and the
   * advertised URL routinely differ, so hrefs carry the advertised host — those must relink too.
   * Origins outside this set remain foreign and stay byte-for-byte untouched.
   */
  allowedOrigins?: readonly string[];
}

const ATTRIBUTE_RE = /\b(?:href|src)\s*=\s*(["'])([^"']*)\1/gi;
const SOURCE_PATH_RE =
  /(?:^|\/)(?:secure\/(?:attachment|thumbnail)|rest\/api\/\d+\/attachment\/(?:content|thumbnail))\/([^/?#]+)(?:\/|$)/i;
const ABSOLUTE_URL_RE = /^[a-z][a-z\d+.-]*:/i;

interface ParsedSourceLink {
  sourceId: string;
  filename: string;
}

/** Shape-only parse: is this a Jira attachment/thumbnail URL, and which id does it carry? */
function parseSourceLink(rawUrl: string): ParsedSourceLink | null {
  let url: URL;

  try {
    url = new URL(rawUrl, 'https://shape.invalid');
  } catch {
    return null;
  }

  const match = SOURCE_PATH_RE.exec(url.pathname);

  if (!match) return null;

  let sourceId = match[1];
  let filename = url.pathname.slice(match.index + match[0].length);

  try {
    sourceId = decodeURIComponent(sourceId);
    filename = decodeURIComponent(filename);
  } catch {
    // Keep the raw values — a malformed escape must not hide a recognisable attachment link.
  }

  return { sourceId, filename };
}

function sourceAttachmentId(
  rawUrl: string,
  options: JiraAttachmentRelinkOptions,
): string | null {
  const { sourceBaseUrl, allowedOrigins } = options;

  if (
    ABSOLUTE_URL_RE.test(rawUrl) &&
    (sourceBaseUrl || allowedOrigins?.length)
  ) {
    let url: URL;

    try {
      url = new URL(rawUrl);
    } catch {
      return null;
    }

    try {
      const permitted = new Set(allowedOrigins ?? []);

      if (sourceBaseUrl) permitted.add(new URL(sourceBaseUrl).origin);
      if (!permitted.has(url.origin)) return null;
    } catch {
      // The migration connection was validated when created.  A malformed value here must never
      // make us rewrite a foreign URL just because it happens to contain a Jira-looking path.
      return null;
    }
  }

  return parseSourceLink(rawUrl)?.sourceId ?? null;
}

/**
 * Shape-only scan for Jira attachment/thumbnail links.  No origin decision happens here — the
 * caller first resolves the candidate ids against the crosswalk and derives the permitted origins
 * from what it finds, so a task full of unmapped links on a split-origin Jira is still reported.
 */
export function collectJiraAttachmentLinks(html: string): JiraAttachmentLink[] {
  if (!html) return [];

  const links = new Map<string, JiraAttachmentLink>();

  for (const match of html.matchAll(ATTRIBUTE_RE)) {
    const url = match[2];
    const parsed = parseSourceLink(url);

    if (parsed && !links.has(parsed.sourceId)) {
      links.set(parsed.sourceId, {
        sourceId: parsed.sourceId,
        url,
        filename: parsed.filename,
      });
    }
  }

  return [...links.values()];
}

/**
 * Rewrites mapped Jira Server `/secure/attachment/:id/...`, `/secure/thumbnail/:id/...` and Jira
 * Cloud `/rest/api/:version/attachment/content|thumbnail/:id` URLs and reports every
 * origin-permitted source link that has no migrated target.  Unmapped,
 * malformed, foreign-origin, and already-relinked values stay byte-for-byte intact.
 */
export function relinkJiraAttachmentHtmlWithReport(
  html: string,
  targets: ReadonlyMap<string, string>,
  options: JiraAttachmentRelinkOptions = {},
): JiraAttachmentRelinkReport {
  const unresolved = new Map<string, JiraAttachmentLink>();
  let rewritten = 0;

  if (!html) return { html, rewritten, unresolved: [] };

  // Jira's empty attachment glyph is source chrome, not an uploaded document.
  const portableHtml = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const attr = (name: string) =>
      new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(tag)?.[2];
    if (
      !attr('class')?.split(/\s+/).includes('rendericon') ||
      attr('alt') !== ''
    )
      return tag;
    try {
      const url = new URL(
        attr('src') ?? '',
        options.sourceBaseUrl ?? undefined,
      );
      const origins = new Set(options.allowedOrigins ?? []);
      if (options.sourceBaseUrl)
        origins.add(new URL(options.sourceBaseUrl).origin);
      return origins.has(url.origin) &&
        /\/images\/icons\/link_attachment_\d+\.gif$/.test(url.pathname)
        ? ''
        : tag;
    } catch {
      return tag;
    }
  });
  const relinked = portableHtml.replace(
    ATTRIBUTE_RE,
    (attribute, _quote: string, rawUrl: string) => {
      const sourceId = sourceAttachmentId(rawUrl, options);

      if (!sourceId) return attribute;

      const targetId = targets.get(sourceId);

      if (!targetId) {
        if (!unresolved.has(sourceId)) {
          const { filename } = parseSourceLink(rawUrl) ?? { filename: '' };

          unresolved.set(sourceId, { sourceId, url: rawUrl, filename });
        }

        return attribute;
      }

      rewritten++;

      return attribute.replace(
        rawUrl,
        `/api/v1/attachments/${encodeURIComponent(targetId)}/download`,
      );
    },
  );

  return { html: relinked, rewritten, unresolved: [...unresolved.values()] };
}

export function relinkJiraAttachmentHtml(
  html: string,
  targets: ReadonlyMap<string, string>,
  options: JiraAttachmentRelinkOptions = {},
): string {
  return relinkJiraAttachmentHtmlWithReport(html, targets, options).html;
}
