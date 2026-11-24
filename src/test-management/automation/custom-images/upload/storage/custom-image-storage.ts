import { browserSafeStorageUrl } from '../../../../../common/utils/browser-storage-url';
import type { SupabaseAdminService } from '../../../../../supabase/supabase-admin.service';

type Client = ReturnType<SupabaseAdminService['getClient']>;

export const IMAGE_BUCKET = 'test-automation-images';

// The registry of an image a user uploaded as a file.
export const UPLOAD_REGISTRY = 'upload';

// Fixed by Supabase: a signed upload address works for two hours.
export const SIGNED_UPLOAD_SECONDS = 7200;

export interface ImageUploadTarget {
  url: string;
  token: string;
  path: string;
  expires_in: number;
}

/** Thrown when Storage itself fails; `missingBucket` means uploads aren't set up on this server. */
export class ImageStorageError extends Error {
  constructor(
    message: string,
    readonly missingBucket: boolean,
  ) {
    super(message);
  }
}

function storageError(error: { message: string }): ImageStorageError {
  return new ImageStorageError(
    error.message,
    /bucket not found/i.test(error.message),
  );
}

/** Where an organisation's uploaded image is kept: one file per image, named by its config digest. */
export function uploadPath(organizationId: string, digest: string): string {
  return `${organizationId}/${digest.replace(/^sha256:/, '')}`;
}

/** A one-time address the browser sends the file to, so the file never passes through the API. */
export async function signedImageUpload(
  client: Client,
  path: string,
): Promise<ImageUploadTarget> {
  const { data, error } = await client.storage
    .from(IMAGE_BUCKET)
    .createSignedUploadUrl(path, { upsert: false });

  if (error || !data) {
    throw storageError(error ?? { message: 'No upload address returned' });
  }

  return {
    url: browserSafeStorageUrl(data.signedUrl),
    token: data.token,
    path: data.path,
    expires_in: SIGNED_UPLOAD_SECONDS,
  };
}

/** The real size of a stored file, or null when there is none. */
export async function storedImageSize(
  client: Client,
  path: string,
): Promise<number | null> {
  const slash = path.lastIndexOf('/');
  const name = path.slice(slash + 1);
  const { data, error } = await client.storage
    .from(IMAGE_BUCKET)
    .list(path.slice(0, slash), { limit: 1, search: name });

  if (error) throw storageError(error);

  const match = (data ?? []).find((entry) => entry.name === name);

  if (!match) return null;

  const size = (match.metadata as { size?: unknown } | null)?.size;

  return typeof size === 'number' ? size : 0;
}

/** Removing a file that isn't there is not an error. */
export async function removeStoredImages(
  client: Client,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;

  const { error } = await client.storage.from(IMAGE_BUCKET).remove(paths);

  if (error) throw storageError(error);
}
