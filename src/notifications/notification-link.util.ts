/**
 * @fileoverview Maps a notification's reference to a RELATIVE deep-link path
 * (e.g. `/spaces/ENG/tasks/view/ENG-42`) so notification emails can render a
 * working "View" CTA button. This is a backend port of the frontend
 * `getNotificationLink` (`src/utils/notification-helpers.ts`) covering the
 * reference types we send emails for.
 *
 * Differences vs the frontend copy (which can fall back to the current UI space
 * key — a context the backend does not have):
 *  - Every space-scoped branch relies solely on `metadata.space_key`.
 *  - The `process` branch uses `metadata.entity_key` (the process key) instead
 *    of the raw UUID reference id (the frontend copy is buggy here).
 *  - Adds a `wiki_comment` branch (the frontend has none).
 *
 * Returns a relative path, or `null` when a required key is missing — the caller
 * then simply omits the CTA button. Prepend `appUrl` for an absolute URL.
 * @module src/notifications/notification-link.util
 */

type Metadata = Record<string, unknown> | null | undefined;

/** Returns the value only if it is a non-empty string. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The organization's own app address: `appUrl` with its leading `app.` host label
 * swapped for the org slug (`https://app.x.cloud` → `https://acme.x.cloud`). A link
 * on `app.` loses its path at the tenant picker, so e-mail deep links need this.
 * Any other address (on-prem single host, localhost) or a missing slug is kept.
 *
 * @param appUrl - the configured APP_URL, without a trailing slash
 * @param slug - the organization slug
 * @returns the tenant base URL, without a trailing slash
 */
export function tenantBaseUrl(
  appUrl: string,
  slug: string | null | undefined,
): string {
  if (!slug) return appUrl;

  try {
    const url = new URL(appUrl);
    if (!url.hostname.startsWith('app.')) return appUrl;

    url.hostname = `${slug}.${url.hostname.slice('app.'.length)}`;

    return url.toString().replace(/\/+$/, '');
  } catch {
    return appUrl;
  }
}

/**
 * Builds a relative in-app path for a notification from its reference/metadata.
 *
 * @param referenceType - the notification's `reference_type`
 * @param referenceId - the notification's `reference_id`
 * @param metadata - the notification's `metadata` object
 * @returns a relative path (e.g. `/spaces/ENG/wiki/123`) or `null`
 */
export function buildNotificationPath(
  referenceType: string | null | undefined,
  referenceId: string | null | undefined,
  metadata: Metadata,
): string | null {
  const meta = metadata ?? {};

  // An explicit precomputed link always wins (mirrors the frontend precedence).
  const explicit = str(meta.link);
  if (explicit) return explicit;

  if (!referenceType) return null;

  const spaceKey = str(meta.space_key);

  switch (referenceType) {
    case 'task': {
      const taskKey = str(meta.task_key) ?? str(meta.entity_key);
      if (!spaceKey || !taskKey) return null;

      return `/spaces/${spaceKey}/tasks/view/${taskKey}`;
    }

    case 'task_comment': {
      const taskKey = str(meta.entity_key);
      if (!spaceKey || !taskKey) return null;

      return `/spaces/${spaceKey}/tasks/view/${taskKey}`;
    }

    case 'wiki_page':
    case 'wiki_comment':
    case 'wiki_review_requested':
    case 'wiki_review_decided': {
      const pageId = str(meta.entity_id) ?? str(referenceId);
      if (!spaceKey || !pageId) return null;

      return `/spaces/${spaceKey}/wiki/${pageId}`;
    }

    case 'process':
    case 'business_process':
    case 'process_comment': {
      const processKey = str(meta.entity_key);
      if (!spaceKey || !processKey) return null;

      return `/spaces/${spaceKey}/processes/view/${processKey}`;
    }

    case 'portfolio_management_letter': {
      const portfolioKey = str(meta.portfolio_key) ?? str(meta.portfolio_id);
      const letterId = str(referenceId);
      if (!portfolioKey || !letterId) return null;

      return `/portfolios/${portfolioKey}/letters/${letterId}`;
    }

    case 'file_attachment': {
      const entityType = str(meta.entity_type);
      const entityId = str(meta.entity_id);
      if (!spaceKey || !entityType || !entityId) return null;

      const prefix = `/spaces/${spaceKey}`;
      switch (entityType) {
        case 'task': {
          const taskKey = str(meta.task_key);

          return taskKey ? `${prefix}/tasks/view/${taskKey}` : null;
        }
        case 'wiki_page':
          return `${prefix}/wiki/${entityId}`;
        case 'asset_item': {
          const schemaKey = str(meta.schema_key);

          return schemaKey ? `${prefix}/lists/${schemaKey}/${entityId}` : null;
        }
        case 'process':
        case 'business_process':
          return `${prefix}/processes/view/${entityId}`;
        default:
          return null;
      }
    }

    default:
      return null;
  }
}
