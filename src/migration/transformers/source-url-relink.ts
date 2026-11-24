/** Relink plain source-system anchors through existing migration crosswalks. */

import type { MigrationEntityMapService } from '../services/migration-entity-map.service';
import { pageReferenceKey, type CirDoc, type CirNode } from './canonical-ir';
import type { CirResolved } from './cir-serializer';

type ParsedSourceUrl =
  | { kind: 'page'; spaceKey?: string; pageSourceId: string; fragment?: string }
  | {
      kind: 'attachment';
      image: boolean;
      pageSourceId: string;
      filename: string;
    }
  | { kind: 'jiraIssue'; issueKey: string }
  | { kind: 'jiraAttachment'; attachmentId: string; filename: string };

const DISPLAY_RE = /(?:^|\/)display\/([^/]+)\/(.+)$/;
const VIEWPAGE_RE = /[?&]pageId=(\d+)/;
const VIEWPAGE_PATH_RE = /(?:^|\/)pages\/viewpage\.action$/;
const DOWNLOAD_ATTACHMENTS_RE = /(?:^|\/)download\/attachments\/(\d+)\/(.+)$/;
const DOWNLOAD_THUMBNAILS_RE = /(?:^|\/)download\/thumbnails\/(\d+)\/(.+)$/;
const JIRA_ISSUE_RE = /(?:^|\/)browse\/([A-Z][A-Z0-9_]*-\d+)\/?$/i;
const JIRA_ATTACHMENT_RE =
  /(?:^|\/)(?:secure\/(?:attachment|thumbnail)|rest\/api\/\d+\/attachment\/(?:content|thumbnail))\/(\d+)(?:\/([^?#]*))?$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|bmp|webp|svg)$/i;
const ABSOLUTE_URL_RE = /^[a-z][a-z\d+.-]*:/i;

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

function decodeFragment(value: string): string {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return value.trim();
  }
}

function basePath(baseUrl?: string | null): string {
  if (!baseUrl) return '';

  try {
    const path = new URL(baseUrl).pathname.replace(/\/+$/, '');

    return path === '/' ? '' : path;
  } catch {
    return '';
  }
}

function normalizedOrigin(url: string | null | undefined): string | null {
  if (!url) return null;

  try {
    const parsed = new URL(url);

    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

function sourceBaseUrl(baseUrl?: string | null): URL | null {
  if (!baseUrl) return null;

  try {
    const parsed = new URL(baseUrl);

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      return null;
    if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';

    return parsed;
  } catch {
    return null;
  }
}

function resolveHref(href: string, baseUrl?: string | null): URL | null {
  const trimmed = href.trim();

  if (!trimmed || trimmed.startsWith('#')) return null;

  try {
    if (ABSOLUTE_URL_RE.test(trimmed)) return new URL(trimmed);

    const base = sourceBaseUrl(baseUrl);

    return base ? new URL(trimmed, base) : null;
  } catch {
    return null;
  }
}

/** Parse a candidate URL shape without deciding whether its origin is trusted. */
export function parseSourceUrl(
  href: string,
  sourceBaseUrl?: string | null,
): ParsedSourceUrl | null {
  let raw = href.trim();
  let fragment: string | undefined;

  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);

      raw = url.pathname + url.search;
      fragment = decodeFragment(url.hash.slice(1)) || undefined;
    } catch {
      return null;
    }
  } else {
    const hashIndex = raw.indexOf('#');

    if (hashIndex >= 0) {
      fragment = decodeFragment(raw.slice(hashIndex + 1)) || undefined;
      raw = raw.slice(0, hashIndex);
    }
  }

  const context = basePath(sourceBaseUrl);

  if (context && (raw === context || raw.startsWith(`${context}/`))) {
    raw = raw.slice(context.length) || '/';
  }

  const pathOnly = raw.split('?')[0];
  const display = DISPLAY_RE.exec(raw);

  if (display) {
    const spaceKey = decodePath(display[1]);
    const title = decodePath(display[2]);

    if (spaceKey && title) {
      return {
        kind: 'page',
        spaceKey,
        pageSourceId: title,
        ...(fragment ? { fragment } : {}),
      };
    }
  }

  const viewpage = VIEWPAGE_RE.exec(raw);

  if (viewpage && VIEWPAGE_PATH_RE.test(pathOnly)) {
    return {
      kind: 'page',
      pageSourceId: viewpage[1],
      ...(fragment ? { fragment } : {}),
    };
  }

  const attachment = DOWNLOAD_ATTACHMENTS_RE.exec(pathOnly);

  if (attachment) {
    const filename = decodePath(attachment[2]);

    return {
      kind: 'attachment',
      image: IMAGE_EXT_RE.test(filename),
      pageSourceId: attachment[1],
      filename,
    };
  }

  const thumbnail = DOWNLOAD_THUMBNAILS_RE.exec(pathOnly);

  if (thumbnail) {
    const filename = decodePath(thumbnail[2]);

    return {
      kind: 'attachment',
      image: true,
      pageSourceId: thumbnail[1],
      filename,
    };
  }

  const issue = JIRA_ISSUE_RE.exec(pathOnly);

  if (issue) {
    return { kind: 'jiraIssue', issueKey: issue[1].toUpperCase() };
  }

  const jiraAttachment = JIRA_ATTACHMENT_RE.exec(pathOnly);

  if (jiraAttachment) {
    return {
      kind: 'jiraAttachment',
      attachmentId: jiraAttachment[1],
      filename: decodePath(jiraAttachment[2] ?? ''),
    };
  }

  return null;
}

interface PendingLink {
  container: CirNode[];
  index: number;
  href: string;
  parsed: ParsedSourceUrl;
}

function collectPendingLinks(
  nodes: CirNode[],
  pending: PendingLink[],
  sourceBaseUrl?: string | null,
): void {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];

    if (node.type === 'link' && !node.preserveSource) {
      const parsed = parseSourceUrl(node.href, sourceBaseUrl);

      if (parsed)
        pending.push({ container: nodes, index, href: node.href, parsed });
    }

    const children = (node as { children?: CirNode[] }).children;

    if (Array.isArray(children)) {
      collectPendingLinks(children, pending, sourceBaseUrl);
    }
  }
}

export interface JiraOriginConnection {
  id: string;
  origin: string;
}

export interface SourceUrlRelinkContext {
  orgId: string;
  connectionId: string;
  sourceBaseUrl?: string | null;
  findJiraConnectionsByOrigin?: (
    sourceUrl: string,
  ) => Promise<readonly JiraOriginConnection[]>;
  resolveJiraIssueTargets?: (
    orgId: string,
    connectionId: string,
    issueKeys: string[],
  ) => Promise<{
    targets: ReadonlyMap<string, { taskKey: string }>;
    unresolved: ReadonlyMap<string, string>;
  }>;
  resolveJiraAttachmentTargets?: (
    orgId: string,
    connectionId: string,
    sourceIds: string[],
  ) => Promise<{
    targets: ReadonlyMap<string, { attachmentId: string }>;
    unresolved: ReadonlyMap<string, string>;
  }>;
}

export interface UnresolvedSourceLink {
  href: string;
  kind: ParsedSourceUrl['kind'];
  sourceRef: string;
  reason: string;
}

export interface SourceUrlRelinkResult {
  rewritten: number;
  unresolved: UnresolvedSourceLink[];
}

function unresolved(
  pending: PendingLink,
  reason: string,
): UnresolvedSourceLink {
  const sourceRef =
    pending.parsed.kind === 'page'
      ? pending.parsed.pageSourceId
      : pending.parsed.kind === 'attachment'
        ? `${pending.parsed.pageSourceId}:${pending.parsed.filename}`
        : pending.parsed.kind === 'jiraIssue'
          ? pending.parsed.issueKey
          : pending.parsed.attachmentId;

  return { href: pending.href, kind: pending.parsed.kind, sourceRef, reason };
}

function isCurrentConfluenceLink(
  href: string,
  sourceBaseUrl?: string | null,
): boolean {
  if (!ABSOLUTE_URL_RE.test(href.trim())) return true;

  const currentOrigin = normalizedOrigin(sourceBaseUrl);
  const hrefOrigin = normalizedOrigin(href);

  return Boolean(currentOrigin && hrefOrigin && currentOrigin === hrefOrigin);
}

function dedupeUnresolved(
  items: UnresolvedSourceLink[],
): UnresolvedSourceLink[] {
  const seen = new Set<string>();

  return items.filter((item) => {
    const key = `${item.kind}:${item.sourceRef}:${item.reason}`;

    if (seen.has(key)) return false;
    seen.add(key);

    return true;
  });
}

function textOf(node: CirNode): string {
  if (node.type === 'text') return node.text;

  const children = (node as { children?: CirNode[] }).children;

  return Array.isArray(children) ? children.map(textOf).join('') : '';
}

/**
 * Resolve every eligible source anchor in one document. The original link stays in place whenever
 * a source origin, crosswalk, or live target cannot be proved.
 */
export async function relinkSourceUrls(
  cir: CirDoc,
  entityMap: MigrationEntityMapService,
  ctx: SourceUrlRelinkContext,
  resolved: CirResolved,
): Promise<SourceUrlRelinkResult> {
  const all: PendingLink[] = [];

  collectPendingLinks(cir.children, all, ctx.sourceBaseUrl);

  const pending = all.filter((link) =>
    link.parsed.kind === 'page' || link.parsed.kind === 'attachment'
      ? isCurrentConfluenceLink(link.href, ctx.sourceBaseUrl)
      : true,
  );

  if (pending.length === 0) return { rewritten: 0, unresolved: [] };

  const unresolvedLinks: UnresolvedSourceLink[] = [];
  const pageRefs = new Map<
    string,
    { sourceId: string; sourceSpaceKey?: string }
  >();
  const attachmentPages = new Set<string>();

  for (const link of pending) {
    if (link.parsed.kind === 'page') {
      const key = pageReferenceKey(
        link.parsed.pageSourceId,
        link.parsed.spaceKey,
      );

      pageRefs.set(key, {
        sourceId: link.parsed.pageSourceId,
        ...(link.parsed.spaceKey
          ? { sourceSpaceKey: link.parsed.spaceKey }
          : {}),
      });
    }

    if (link.parsed.kind === 'attachment') {
      attachmentPages.add(link.parsed.pageSourceId);
    }
  }

  const pageHits = pageRefs.size
    ? await entityMap.resolveWikiPageTargets(ctx.orgId, ctx.connectionId, [
        ...pageRefs.values(),
      ])
    : new Map<
        string,
        { pageId: string; pageSlug?: string; spaceKey?: string; title?: string }
      >();

  const attachmentUrls = new Map<string, Map<string, string>>();

  for (const pageSourceId of attachmentPages) {
    const rows = await entityMap.listPageAttachments(
      ctx.orgId,
      ctx.connectionId,
      pageSourceId,
    );

    attachmentUrls.set(
      pageSourceId,
      new Map(
        rows.flatMap((row) =>
          typeof row.metadata?.url === 'string' &&
          typeof row.metadata?.filename === 'string'
            ? [[row.metadata.filename.toLowerCase(), row.metadata.url] as const]
            : [],
        ),
      ),
    );
  }

  const jiraConnectionByPending = new Map<PendingLink, string>();
  const jiraOriginLookup = new Map<
    string,
    Promise<readonly JiraOriginConnection[]>
  >();

  for (const link of pending) {
    if (
      link.parsed.kind !== 'jiraIssue' &&
      link.parsed.kind !== 'jiraAttachment'
    ) {
      continue;
    }

    if (!ctx.findJiraConnectionsByOrigin) continue;

    const resolvedHref = resolveHref(link.href, ctx.sourceBaseUrl);

    if (!resolvedHref) continue;

    let connections = jiraOriginLookup.get(resolvedHref.origin);

    if (!connections) {
      connections = ctx.findJiraConnectionsByOrigin(resolvedHref.toString());
      jiraOriginLookup.set(resolvedHref.origin, connections);
    }

    const matches = await connections;

    if (matches.length === 0) continue;

    if (matches.length > 1) {
      unresolvedLinks.push(
        unresolved(
          link,
          'source origin matches multiple active Jira connections in this organization',
        ),
      );
      continue;
    }

    jiraConnectionByPending.set(link, matches[0].id);
  }

  const issueKeysByConnection = new Map<string, Set<string>>();
  const attachmentIdsByConnection = new Map<string, Set<string>>();

  for (const [link, connectionId] of jiraConnectionByPending) {
    if (link.parsed.kind === 'jiraIssue') {
      const keys = issueKeysByConnection.get(connectionId) ?? new Set<string>();

      keys.add(link.parsed.issueKey);
      issueKeysByConnection.set(connectionId, keys);
      continue;
    }

    if (link.parsed.kind !== 'jiraAttachment') continue;

    const ids =
      attachmentIdsByConnection.get(connectionId) ?? new Set<string>();

    ids.add(link.parsed.attachmentId);
    attachmentIdsByConnection.set(connectionId, ids);
  }

  const jiraIssues = new Map<
    string,
    {
      targets: ReadonlyMap<string, { taskKey: string }>;
      unresolved: ReadonlyMap<string, string>;
    }
  >();

  for (const [connectionId, keys] of issueKeysByConnection) {
    const result = ctx.resolveJiraIssueTargets
      ? await ctx.resolveJiraIssueTargets(ctx.orgId, connectionId, [...keys])
      : {
          targets: await entityMap.resolveIssueTargets(
            ctx.orgId,
            connectionId,
            [...keys],
          ),
          unresolved: new Map<string, string>(),
        };

    jiraIssues.set(connectionId, result);
  }

  const jiraAttachments = new Map<
    string,
    {
      targets: ReadonlyMap<string, { attachmentId: string }>;
      unresolved: ReadonlyMap<string, string>;
    }
  >();

  for (const [connectionId, ids] of attachmentIdsByConnection) {
    const result = ctx.resolveJiraAttachmentTargets
      ? await ctx.resolveJiraAttachmentTargets(ctx.orgId, connectionId, [
          ...ids,
        ])
      : {
          targets: await entityMap.resolveAttachmentTargets(
            ctx.orgId,
            connectionId,
            [...ids],
          ),
          unresolved: new Map<string, string>(),
        };

    jiraAttachments.set(connectionId, result);
  }

  let rewritten = 0;

  for (const link of pending) {
    const node = link.container[link.index] as Extract<
      CirNode,
      { type: 'link' }
    >;

    if (link.parsed.kind === 'page') {
      const refKey = pageReferenceKey(
        link.parsed.pageSourceId,
        link.parsed.spaceKey,
      );
      const hit = pageHits.get(refKey);

      if (!hit?.pageId) {
        unresolvedLinks.push(
          unresolved(
            link,
            link.parsed.spaceKey
              ? `page "${link.parsed.pageSourceId}" in space "${link.parsed.spaceKey}" was not migrated or no longer exists`
              : `page "${link.parsed.pageSourceId}" was not migrated or no longer exists`,
          ),
        );
        continue;
      }

      resolved.pages.set(refKey, {
        ...hit,
        url: hit.spaceKey
          ? `/spaces/${hit.spaceKey}/wiki/${hit.pageSlug ?? hit.pageId}`
          : `/wiki/${hit.pageId}`,
      });
      link.container[link.index] = {
        type: 'pageLink',
        pageSourceId: link.parsed.pageSourceId,
        ...(link.parsed.spaceKey
          ? { sourceSpaceKey: link.parsed.spaceKey }
          : {}),
        ...(link.parsed.fragment ? { fragment: link.parsed.fragment } : {}),
        text: textOf(node),
      };
      rewritten += 1;
      continue;
    }

    if (link.parsed.kind === 'attachment') {
      const url = attachmentUrls
        .get(link.parsed.pageSourceId)
        ?.get(link.parsed.filename.toLowerCase());

      if (!url) {
        unresolvedLinks.push(
          unresolved(
            link,
            `attachment "${link.parsed.filename}" was not migrated or no longer exists`,
          ),
        );
        continue;
      }

      link.container[link.index] = {
        type: 'media',
        kind: link.parsed.image ? 'image' : 'file',
        filename: link.parsed.filename,
        src: url,
      };
      rewritten += 1;
      continue;
    }

    const connectionId = jiraConnectionByPending.get(link);

    if (!connectionId) continue;

    if (link.parsed.kind === 'jiraIssue') {
      const result = jiraIssues.get(connectionId);
      const target = result?.targets.get(link.parsed.issueKey);

      if (!target) {
        unresolvedLinks.push(
          unresolved(
            link,
            result?.unresolved.get(link.parsed.issueKey) ??
              `issue "${link.parsed.issueKey}" was not migrated or no longer exists`,
          ),
        );
        continue;
      }

      link.container[link.index] = {
        ...node,
        href: `/tasks/${encodeURIComponent(target.taskKey)}`,
      };
      rewritten += 1;
      continue;
    }

    const result = jiraAttachments.get(connectionId);
    const target = result?.targets.get(link.parsed.attachmentId);

    if (!target) {
      unresolvedLinks.push(
        unresolved(
          link,
          result?.unresolved.get(link.parsed.attachmentId) ??
            `attachment "${link.parsed.filename || link.parsed.attachmentId}" was not migrated or no longer exists`,
        ),
      );
      continue;
    }

    link.container[link.index] = {
      ...node,
      href: `/api/v1/attachments/${encodeURIComponent(target.attachmentId)}/download`,
    };
    rewritten += 1;
  }

  return { rewritten, unresolved: dedupeUnresolved(unresolvedLinks) };
}
