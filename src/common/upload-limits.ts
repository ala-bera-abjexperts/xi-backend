/**
 * @fileoverview Central file-upload size caps, tiered by purpose and gated on deployment.
 * @module common/upload-limits
 * @author Prince Jadiya
 *
 * Every upload cap in the codebase resolves through this module. Before it existed as the single
 * source of truth, each feature carried its own `const MAX_* = N * 1024 * 1024`, and those drifted:
 * task attachments sat at 10 MB while process attachments allowed 50 MB, and the image endpoints
 * never consulted the on-premise helper at all, so a self-hosted customer who was promised 1 GB
 * uploads still got 5 MB avatars.
 *
 * ON-PREMISE
 * Heavy-file buckets are allowed up to 5 GB on SELF-HOSTED / on-premise deployments (a customer
 * requirement — raised from 1 GiB for Jira-migration attachments) but stay at their smaller cloud
 * caps on the hosted SaaS build. The same backend image serves both, so the cap has to be resolved
 * per deployment rather than hardcoded. NOTE: files above ~2 GiB only actually work on surfaces
 * with a streaming path (migration attachment import, File Explorer signed uploads) — a fully
 * buffered path is bounded by Node's ~4 GiB Buffer cap and by heap, and the deployment's storage
 * `FILE_SIZE_LIMIT` / proxy body limits must also be raised to match.
 *
 * The on-premise flag is read ONCE at module load — the same pattern used by `app.module.ts` to
 * conditionally register `OnPremUpdatesModule`. This matters because
 * `FileInterceptor('file', { limits: { fileSize } })` evaluates its options at decorator-evaluation
 * time (module load), so the cap cannot come from a request-scoped config; a module-load constant
 * is the only thing that works there. `IS_ON_PREMISE=true` is rendered into the on-prem backend.env
 * by the deployer and is absent on cloud (see env.validation.ts — optional).
 */

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

/**
 * True when this process is a self-hosted / on-premise deployment.
 *
 * Exported because the storage-quota path (`storage-config.repository.ts`) also branches on it:
 * on-premise the bytes live on the customer's own hardware, so the default quota is not ours to
 * ration.
 */
export const IS_ON_PREMISE = ['true', '1', 'yes'].includes(
  (process.env.IS_ON_PREMISE || '').trim().toLowerCase(),
);

/**
 * Heavy-file allowance for on-premise, overridable per install: the operator sets
 * `ON_PREM_MAX_UPLOAD_BYTES` (bytes) in backend.env to raise or lower the floor — it is their
 * hardware, so the ceiling is theirs to pick. Unset or invalid falls back to 5 GB. Read once at
 * module load like `IS_ON_PREMISE` (FileInterceptor evaluates its limits at decorator time).
 * Values past ~4 GiB only actually work on streaming surfaces — see the module header.
 */
// Floored to whole bytes: multer 2.5+ rejects a non-integer `limits.fileSize` at boot.
const onPremOverride = Math.floor(Number(process.env.ON_PREM_MAX_UPLOAD_BYTES));
const ON_PREM_MAX_BYTES =
  Number.isFinite(onPremOverride) && onPremOverride > 0
    ? onPremOverride
    : 5 * GB;

/**
 * Resolve a file-upload byte cap for the current deployment.
 *
 * On-premise takes the LARGER of the two rather than unconditionally returning `ON_PREM_MAX_BYTES`.
 * The unconditional form was a downgrade for any tier whose cloud allowance already exceeded the
 * on-prem floor — Site Studio video (2 GB on cloud) would have silently dropped to the floor the
 * moment a deployment set `IS_ON_PREMISE=true`. On-premise must never be the more restrictive
 * deployment.
 *
 * @param cloudDefaultBytes the cap to apply on the hosted/cloud build.
 * @returns `max(5 GB, cloudDefaultBytes)` on on-premise, `cloudDefaultBytes` on cloud.
 */
export function maxUploadBytes(cloudDefaultBytes: number): number {
  return IS_ON_PREMISE
    ? Math.max(ON_PREM_MAX_BYTES, cloudDefaultBytes)
    : cloudDefaultBytes;
}

/**
 * Upload caps by purpose. Pick the tier that matches what the endpoint accepts, rather than
 * inventing a new constant — a one-off number here is how the limits drifted apart last time.
 *
 * Cloud values are benchmarked against comparable tools (Jira Cloud 1 GB default / 2 GB max per
 * file, ClickUp 1 GB, Monday 500 MB); on-premise lifts everything to at least 5 GB via
 * `maxUploadBytes`, so self-hosted customers keep a higher ceiling than cloud.
 */
export const UPLOAD_LIMITS = {
  /** Avatars, org logos, space icons, asset-object/schema/type images. */
  SMALL_IMAGE: maxUploadBytes(10 * MB),

  /** Wiki inline images, TipTap editor uploads, user cover images. */
  CONTENT_IMAGE: maxUploadBytes(25 * MB),

  /**
   * General attachments: task, process, GDPR, asset, asset-object, wiki, form-builder.
   *
   * CLOUD is 1 GB to match Jira Cloud's default per-file attachment size. ON-PREMISE is unchanged
   * at 5 GB (`maxUploadBytes` returns `max(5 GB, cloudDefault)`), so this raises cloud ONLY and
   * never lowers a self-hosted deployment.
   *
   * NOTE: the upload path buffers the whole file in the process (multer memory storage -> `Buffer`)
   * and the browser reaches us through the Next `/api/v1` proxy, so a 1 GB upload costs roughly
   * that much RSS per concurrent request. That ceiling already existed on-premise at 5 GB; the real
   * fix for large files is a signed direct-to-storage upload (see `file-explorer-storage.service.ts`
   * `createSignedUploadUrl`), not a larger number here.
   */
  ATTACHMENT: maxUploadBytes(1 * GB),

  /** Site Studio media. Exceeded the original 1 GiB on-prem floor — why `maxUploadBytes` takes a max. */
  VIDEO: maxUploadBytes(2 * GB),

  /** List CSV/XLSX import. Parsed in memory by `xlsx`, so it stays well below ATTACHMENT. */
  IMPORT: maxUploadBytes(25 * MB),
} as const;

/**
 * File Explorer cap — `null` means NO cap.
 *
 * File Explorer is the one surface that uploads direct-to-storage via a signed upload URL, so the
 * bytes never pass through this process's heap and a very large cap costs us nothing. On-premise
 * the storage is the customer's own, so we impose no application-level ceiling at all; the real
 * bound is whatever `file_size_limit` they set on their bucket.
 *
 * A `null` here must be translated by the caller into an OMITTED multer `limits` key — multer has
 * no sentinel for "unlimited", absence is the only way to express it.
 */
export const FILE_EXPLORER_MAX_BYTES: number | null = IS_ON_PREMISE
  ? null
  : 5 * GB;

/**
 * Default per-user storage quota when neither `user_storage_overrides` nor
 * `organization_storage_config` supplies one.
 *
 * Mirrors the Priority-3 fallback inside the `get_user_effective_quota_bytes` SQL function; the two
 * are expected to agree. Raised from 5 GB because a single File Explorer file may now BE 5 GB, and
 * a quota equal to the max file size means one upload consumes a user's entire allowance.
 */
export const DEFAULT_STORAGE_QUOTA_BYTES = 100 * GB;

/** Human-readable form of a byte cap for user-facing error messages. */
export function formatMaxUpload(bytes: number): string {
  const mb = bytes / MB;

  if (mb < 1024) return `${Math.round(mb)} MB`;

  const gb = mb / 1024;

  // Trim a trailing ".0" so 2 GB does not render as "2.0 GB".
  return `${Number(gb.toFixed(1))} GB`;
}
