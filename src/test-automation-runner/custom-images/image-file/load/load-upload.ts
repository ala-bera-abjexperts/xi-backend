import { once } from 'events';
import { createWriteStream } from 'fs';
import { mkdir, mkdtemp, readdir, rm, stat } from 'fs/promises';
import { join } from 'path';
import { Readable } from 'stream';
import { finished } from 'stream/promises';
import type { ReadableStream as WebReadableStream } from 'stream/web';

import type { SupabaseAdminService } from '../../../../supabase/supabase-admin.service';
import {
  IMAGE_BUCKET,
  uploadPath,
} from '../../../../test-management/automation/custom-images/upload/storage/custom-image-storage';
import { UPLOADED_IMAGE_PATTERN } from '../../../docker-driver';
import {
  hasEnoughDisk,
  readMinFreeGb,
  runnerWorkDir,
} from '../../../runner.sweep';
import {
  pullFailure,
  type CustomImageDocker,
} from '../../docker/custom-image-docker';
import { TryLater } from '../../review/scanner/custom-image-scanner';
import {
  ImageFileError,
  readImageFile,
  type ImageFile,
} from '../tar/image-tar';

type Client = ReturnType<SupabaseAdminService['getClient']>;
type LoadDocker = Pick<
  CustomImageDocker,
  'loadImage' | 'tagImage' | 'imageLayers' | 'removeImage'
>;

export interface UploadedImage {
  organization_id: string;
  digest: string;
  size_bytes?: number | null;
}

// The cleaned copy of the file; the scanner reads it under this name.
export const CLEAN_TAR = 'image.tar';
const FOLDER_PREFIX = 'upload-';
// A check or a run is done with its folder long before this.
const LEFTOVER_MS = 3 * 60 * 60 * 1000;

/** Docker on this machine could not load at all; the file itself may be fine. */
export class LoadMachineProblem extends Error {}

/** The name an uploaded image runs under, from its config digest. */
export function uploadRunTag(digest: string): string {
  const tag = `xis-tm-upload:${digest.replace(/^sha256:/, '')}`;

  if (!UPLOADED_IMAGE_PATTERN.test(tag)) {
    throw new ImageFileError(
      'IMAGE_FILE_INVALID',
      'The uploaded image has no valid digest',
    );
  }

  return tag;
}

/** Room for the cleaned copy, Docker's copy and the unpacked layers, beside the usual free space. */
export function hasRoomForUpload(fileBytes: number): Promise<boolean> {
  return hasEnoughDisk(
    readMinFreeGb() + (4 * Math.max(fileBytes, 0)) / 1024 ** 3,
  );
}

function scansFolder(): string {
  return join(runnerWorkDir(), 'scans');
}

/** Not named like a run id, so the run sweep never removes it mid-check. */
export async function uploadFolder(): Promise<string> {
  await mkdir(scansFolder(), { recursive: true, mode: 0o700 });

  return mkdtemp(join(scansFolder(), FOLDER_PREFIX));
}

/** Folders a stopped worker left behind. */
export async function removeLeftoverUploadFolders(
  now = Date.now(),
): Promise<void> {
  const names = await readdir(scansFolder()).catch(() => [] as string[]);

  for (const name of names.filter((item) => item.startsWith(FOLDER_PREFIX))) {
    const folder = join(scansFolder(), name);
    const info = await stat(folder).catch(() => null);

    if (info && now - info.mtimeMs > LEFTOVER_MS) {
      await rm(folder, { recursive: true, force: true });
    }
  }
}

function isMissing(error: {
  message: string;
  status?: unknown;
  statusCode?: unknown;
}): boolean {
  return (
    error.status === 404 ||
    String(error.statusCode) === '404' ||
    /not.?found/i.test(error.message)
  );
}

/**
 * Streams the stored file through the reader into a cleaned copy in `folder`, and checks that it holds the
 * image the row names. The file is never held in memory.
 */
export async function readUploadedImage(
  client: Client,
  image: UploadedImage,
  folder: string,
  signal: AbortSignal,
  onBytes?: (bytes: number) => void,
): Promise<ImageFile> {
  const { data, error } = await client.storage
    .from(IMAGE_BUCKET)
    .download(uploadPath(image.organization_id, image.digest), {}, { signal })
    .asStream();

  if (error || !data) {
    if (error && isMissing(error)) {
      throw new ImageFileError(
        'UPLOAD_MISSING',
        'The uploaded file is gone; upload the image again',
      );
    }

    throw new TryLater('The uploaded file could not be downloaded');
  }

  const source = Readable.fromWeb(
    data as unknown as WebReadableStream<Uint8Array>,
  );
  const out = createWriteStream(join(folder, CLEAN_TAR), {
    flags: 'wx',
    mode: 0o600,
  });
  const state: { failure: Error | null; read: number } = {
    failure: null,
    read: 0,
  };

  out.on('error', (failure) => {
    state.failure = failure;
  });

  async function* counted(): AsyncGenerator<Buffer> {
    for await (const chunk of source) {
      const piece = chunk as Buffer;

      state.read += piece.length;
      onBytes?.(state.read);

      yield piece;
    }
  }

  try {
    const file = await readImageFile(counted(), async (chunk) => {
      if (state.failure) throw state.failure;
      if (!out.write(chunk)) await once(out, 'drain');
    });

    out.end();
    await finished(out);

    if (file.configDigest !== image.digest) {
      throw new ImageFileError(
        'DIGEST_MISMATCH',
        'The file holds another image than the one uploaded',
      );
    }

    return file;
  } finally {
    source.destroy();
    out.destroy();
  }
}

/** Loads the cleaned copy, names it and checks that Docker holds exactly the layers the file describes. */
export async function loadUploadedImage(
  docker: LoadDocker,
  folder: string,
  file: ImageFile,
  tag: string,
  signal: AbortSignal,
): Promise<void> {
  const result = await docker.loadImage(join(folder, CLEAN_TAR), signal);

  if (result.code !== 0) {
    if (pullFailure(result.output) === 'machine') {
      throw new LoadMachineProblem(result.output);
    }

    throw new TryLater('Docker could not load the image');
  }

  if (result.loaded.length !== 1) {
    throw new ImageFileError(
      'IMAGE_FILE_NOT_ONE',
      'Docker loaded more or less than one image from the file',
    );
  }

  if (!(await docker.tagImage(result.loaded[0], tag))) {
    throw new TryLater('Docker could not name the loaded image');
  }

  const layers = await docker.imageLayers(tag);

  if (layers?.join(',') === file.diffIds.join(',')) return;

  await docker.removeImage(tag);

  if (!layers) throw new TryLater('Docker could not describe the loaded image');

  throw new ImageFileError(
    'DIGEST_MISMATCH',
    'Docker loaded other layers than the file describes',
  );
}

/** Before a run: the image was removed after its check, so it is loaded again from its stored file, without a scan. */
export async function prepareUploadedImage(
  client: Client,
  docker: LoadDocker,
  image: UploadedImage,
  signal: AbortSignal,
): Promise<string> {
  const tag = uploadRunTag(image.digest);

  if (!(await hasRoomForUpload(image.size_bytes ?? 0))) {
    throw new LoadMachineProblem('Not enough free disk for the image');
  }

  const folder = await uploadFolder();

  try {
    const file = await readUploadedImage(client, image, folder, signal);

    await loadUploadedImage(docker, folder, file, tag, signal);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }

  return tag;
}
