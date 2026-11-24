/**
 * @fileoverview Shared Document Designer export constants. Kept in a
 * dependency-free module so light consumers (the cleanup cron, the automation
 * wave) never drag in the render chain (puppeteer / jsdom).
 * @module src/document-designer/document-exports.constants
 */

/** Private storage bucket for generated export files (created in-migration). */
export const DOCUMENT_EXPORTS_BUCKET = 'document-exports';

/**
 * Buckets a template image element (`src.kind === 'storage'`) may reference.
 * The export pipeline signs storage paths with the SERVICE-ROLE client, which
 * bypasses every storage RLS policy — so the app code must own this
 * authorization check. Both allowed buckets use the
 * `<organization_id>/...` object-path convention, and the org prefix is
 * enforced alongside the bucket allowlist (see
 * {@link isAllowedTemplateImageSource}).
 */
export const ALLOWED_TEMPLATE_IMAGE_BUCKETS: readonly string[] = [
  'attachments',
  DOCUMENT_EXPORTS_BUCKET,
];

/**
 * Whether a storage-kind image source may be signed/rendered for the given
 * organization: the bucket must be allowlisted AND the object path must live
 * under the organization's own folder (`<organizationId>/...`). Degenerate
 * path segments ('', '.', '..') are rejected outright so a crafted path can
 * never alias outside the org prefix.
 */
export function isAllowedTemplateImageSource(
  organizationId: string,
  src: { bucket: string; path: string },
): boolean {
  if (!ALLOWED_TEMPLATE_IMAGE_BUCKETS.includes(src.bucket)) return false;
  if (!src.path.startsWith(`${organizationId}/`)) return false;

  const segments = src.path.split('/');
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    return false;
  }

  return true;
}
