import type { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import type { RunnerImage } from '../../../test-management/automation/automation-inputs';
import { spaceApprovalBlock } from '../../../test-management/automation/custom-images/approval/check/space-approval-check';
import { rm } from 'fs/promises';

import {
  fetchSchema1Manifest,
  parseUserImageRef,
  runnerPlatform,
  userImageRegistries,
  UserImageError,
  type Schema1Image,
  type UserImageRef,
} from '../../../test-management/automation/custom-images/registry/custom-image-review';
import {
  imageUploadsEnabled,
  OWN_IMAGE_KEY,
} from '../../../test-management/automation/custom-images/shared/inputs/custom-image-inputs';
import { UPLOAD_REGISTRY } from '../../../test-management/automation/custom-images/upload/storage/custom-image-storage';
import { CustomImageDocker, pullFailure } from '../docker/custom-image-docker';
import { ImageFileError } from '../image-file/tar/image-tar';
import {
  loadUploadedImage,
  prepareUploadedImage,
  uploadFolder,
  uploadRunTag,
} from '../image-file/load/load-upload';
import { convertSchema1 } from '../legacy/schema1-image';

const RUNTIME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,49}$/;

export interface CustomImageRunFailure {
  code: string;
  message: string;
}

/** What a queued run of a custom image setting carries about its image. */
export interface CustomImageRun {
  organization_id: string;
  // The space whose approval of the image is checked again; without it nothing is checked.
  space_id?: string;
  config_snapshot: {
    user_image_id?: string | null;
    run_ref?: string | null;
    platform?: string | null;
  };
}

type Client = ReturnType<SupabaseAdminService['getClient']>;
type RunDocker = Pick<
  CustomImageDocker,
  | 'hasRuntime'
  | 'imagePresent'
  | 'pullAnonymous'
  | 'loadImage'
  | 'tagImage'
  | 'imageLayers'
  | 'removeImage'
>;

interface ImageForRun {
  status: string;
  run_ref: string | null;
  registry?: string;
  digest?: string;
  size_bytes?: number | null;
}

/** The sandbox runtime for a user's own image, from TM_RUNNER_USER_RUNTIME, such as runsc. */
export function customImageRuntime(
  raw = process.env.TM_RUNNER_USER_RUNTIME,
): string | null {
  const value = raw?.trim() ?? '';

  return RUNTIME_PATTERN.test(value) ? value : null;
}

const refuse = (code: string, message: string) => ({ code, message });

/**
 * Checks a user's own image again right before its run: it may have been blocked, or this machine
 * changed, since the run was queued. Downloads it when it isn't here.
 */
export async function customImageForRun(
  client: Client,
  run: CustomImageRun,
  signal: AbortSignal,
  docker: RunDocker = new CustomImageDocker(),
): Promise<{ image: RunnerImage } | CustomImageRunFailure> {
  const snapshot = run.config_snapshot;

  // An uploaded image has no address to download from, so its run carries none.
  if (
    !snapshot.user_image_id ||
    !(snapshot.run_ref
      ? userImageRegistries().length > 0
      : imageUploadsEnabled())
  ) {
    return refuse(
      'IMAGE_NOT_APPROVED',
      'Using your own images is not switched on for this server',
    );
  }

  const { data, error } = await client
    .from('test_automation_user_images')
    .select('status, run_ref, registry, digest, size_bytes')
    .eq('id', snapshot.user_image_id)
    .eq('organization_id', run.organization_id)
    .maybeSingle();
  const image = error ? null : (data as ImageForRun | null);

  if (
    image?.status !== 'approved' ||
    image.run_ref !== (snapshot.run_ref ?? null)
  ) {
    return refuse(
      image?.status === 'blocked'
        ? 'IMAGE_BLOCKED'
        : image?.status === 'checking'
          ? 'IMAGE_CHECKING'
          : 'IMAGE_NOT_APPROVED',
      'Your image is not approved to run',
    );
  }

  // The space may have rejected the image, or started asking for approval, since the run was queued.
  if (run.space_id) {
    const block = await spaceApprovalBlock(
      client,
      run.organization_id,
      run.space_id,
      snapshot.user_image_id,
    ).catch(() => 'IMAGE_AWAITING_APPROVAL' as const);

    if (block) {
      return refuse(
        block,
        block === 'IMAGE_REJECTED_HERE'
          ? 'This image was rejected in this space'
          : 'This image waits for approval in this space',
      );
    }
  }

  if (snapshot.platform !== runnerPlatform()) {
    return refuse(
      'IMAGE_PLATFORM_CHANGED',
      'This server now uses another chip type; check your image again',
    );
  }

  const runtime = customImageRuntime();

  if (runtime && !(await docker.hasRuntime(runtime))) {
    return refuse(
      'RUNTIME_MISSING',
      'The sandbox for your own images is not installed on this server',
    );
  }

  if (image.registry === UPLOAD_REGISTRY) {
    return uploadedImageForRun(client, run, image, signal, docker);
  }

  if (!snapshot.run_ref) {
    return refuse('IMAGE_NOT_APPROVED', 'Your image is not approved to run');
  }

  if (!(await docker.imagePresent(snapshot.run_ref))) {
    // An old schema 1 image runs under the name of its converted copy.
    const converted = convertedTag(snapshot.run_ref);

    if (converted && (await docker.imagePresent(converted))) {
      return { image: { key: OWN_IMAGE_KEY, image: converted } };
    }

    const pulled = await docker.pullAnonymous(
      snapshot.run_ref,
      runnerPlatform(),
      signal,
    );

    if (pulled.code !== 0) {
      const failure = pullFailure(pulled.output);

      if (failure === 'machine') {
        return refuse(
          'RUNNER_FAILED',
          'This server could not download your image; try the run again later',
        );
      }

      if (failure !== 'rate_limited' && converted && !signal.aborted) {
        const ready = await convertedImageForRun(
          client,
          run,
          image,
          snapshot.run_ref,
          converted,
          signal,
          docker,
        );

        if (ready) return ready;
      }

      return refuse(
        failure === 'rate_limited'
          ? 'REGISTRY_RATE_LIMITED'
          : 'IMAGE_PULL_FAILED',
        'Your image could not be downloaded',
      );
    }

    // Lets the clean-up remove it once the image may no longer run.
    await client
      .from('test_automation_user_images')
      .update({ pulled_by_runner: true })
      .eq('id', snapshot.user_image_id)
      .eq('organization_id', run.organization_id);
  }

  return { image: { key: OWN_IMAGE_KEY, image: snapshot.run_ref } };
}

// ponytail: shared per worker process only; two machines each convert their own copy.
const conversions = new Map<string, Promise<void>>();

function convertedTag(runRef: string): string | null {
  try {
    return uploadRunTag(runRef.slice(runRef.lastIndexOf('@') + 1));
  } catch {
    return null;
  }
}

/**
 * Docker no longer downloads an old schema 1 image, so it is converted and loaded again, without a scan, as an
 * uploaded image is: its check passed, and the signed digest pins every layer. Null when it is not such an image.
 */
async function convertedImageForRun(
  client: Client,
  run: CustomImageRun,
  image: ImageForRun,
  runRef: string,
  tag: string,
  signal: AbortSignal,
  docker: RunDocker,
): Promise<{ image: RunnerImage } | CustomImageRunFailure | null> {
  let ref: UserImageRef;
  let old: Schema1Image | null;

  try {
    ref = parseUserImageRef(runRef, [image.registry ?? '']);
    old = await fetchSchema1Manifest(ref);
  } catch {
    return null;
  }

  if (!old) return null;

  const legacy = old;

  try {
    // Two runs of the same image at once share one conversion.
    let work = conversions.get(tag);

    if (!work) {
      work = (async () => {
        const folder = await uploadFolder();

        try {
          const file = await convertSchema1({
            ref,
            image: legacy,
            folder,
            signal,
          });

          await loadUploadedImage(docker, folder, file, tag, signal);
        } finally {
          await rm(folder, { recursive: true, force: true });
        }
      })().finally(() => conversions.delete(tag));
      conversions.set(tag, work);
    }

    await work;
  } catch (error) {
    if (
      error instanceof UserImageError &&
      error.code === 'REGISTRY_RATE_LIMITED'
    ) {
      return refuse(
        'REGISTRY_RATE_LIMITED',
        'Your image could not be downloaded',
      );
    }

    if (
      error instanceof ImageFileError ||
      (error instanceof UserImageError && error.code === 'IMAGE_NOT_PUBLIC')
    ) {
      return refuse('IMAGE_PULL_FAILED', 'Your image could not be downloaded');
    }

    return refuse(
      'RUNNER_FAILED',
      'This server could not prepare your image; try the run again later',
    );
  }

  // Lets the clean-up remove it once the image may no longer run.
  await client
    .from('test_automation_user_images')
    .update({ pulled_by_runner: true })
    .eq('id', run.config_snapshot.user_image_id ?? '')
    .eq('organization_id', run.organization_id);

  return { image: { key: OWN_IMAGE_KEY, image: tag } };
}

/** An uploaded image is removed after its check, so it is loaded again from its stored file when it isn't here. */
async function uploadedImageForRun(
  client: Client,
  run: CustomImageRun,
  image: ImageForRun,
  signal: AbortSignal,
  docker: RunDocker,
): Promise<{ image: RunnerImage } | CustomImageRunFailure> {
  const userImageId = run.config_snapshot.user_image_id ?? '';
  let tag: string;

  try {
    tag = uploadRunTag(image.digest ?? '');

    if (await docker.imagePresent(tag)) {
      return { image: { key: OWN_IMAGE_KEY, image: tag } };
    }

    await prepareUploadedImage(
      client,
      docker,
      {
        organization_id: run.organization_id,
        digest: image.digest ?? '',
        size_bytes: image.size_bytes,
      },
      signal,
    );
  } catch (error) {
    if (error instanceof ImageFileError) {
      return error.code === 'UPLOAD_MISSING'
        ? refuse(
            'UPLOAD_MISSING',
            'The file of your uploaded image is gone; upload the image again',
          )
        : refuse(error.code, 'Your uploaded image could not be prepared');
    }

    return refuse(
      'RUNNER_FAILED',
      'This server could not prepare your image; try the run again later',
    );
  }

  // Lets the clean-up remove it once the image may no longer run.
  await client
    .from('test_automation_user_images')
    .update({ pulled_by_runner: true })
    .eq('id', userImageId)
    .eq('organization_id', run.organization_id);

  return { image: { key: OWN_IMAGE_KEY, image: tag } };
}
