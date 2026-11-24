import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';

import { AuditLogsService } from '../../../../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../../../../auth/interfaces/request-user.interface';
import { SupabaseAdminService } from '../../../../../supabase/supabase-admin.service';
import { TestManagementAccessService } from '../../../../access/test-management-access.service';
import { tmDbError } from '../../../../test-management-errors';
import {
  maxUserImageBytes,
  runnerPlatform,
} from '../../registry/custom-image-review';
import {
  assertChoiceMatches,
  TestAutomationCustomImagesService,
  type CustomImage,
  type CustomImageRow,
  type ReviewFields,
} from '../../../test-automation-custom-images.service';
import { TestAutomationRunnerService } from '../../../test-automation-runner.service';
import {
  imageUploadsEnabled,
  UPLOAD_IMAGE_CEILING_BYTES,
  USER_IMAGE_FRAMEWORKS,
} from '../../shared/inputs/custom-image-inputs';
import {
  ImageStorageError,
  removeStoredImages,
  signedImageUpload,
  storedImageSize,
  UPLOAD_REGISTRY,
  uploadPath,
  type ImageUploadTarget,
} from '../storage/custom-image-storage';

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export interface ImageUploadLabels {
  language?: string;
  test_framework?: string;
  // Read by the browser from the file's own labels.
  image_language?: string;
  image_test_framework?: string;
}

export interface StartImageUpload extends ImageUploadLabels {
  file_name: string;
  file_bytes: number;
  config_digest: string;
  platform: string;
  gzip: boolean;
}

export interface FinishImageUpload extends ImageUploadLabels {
  config_digest: string;
  file_name: string;
  gzip: boolean;
  // Others in the organisation may use the image; off keeps it to the person who uploads it.
  shared?: boolean;
}

export type ImageUploadStart =
  | { reused: true; image: CustomImage }
  | { reused: false; upload: Pick<ImageUploadTarget, 'url' | 'expires_in'> };

/** The largest file this server takes, kept below what Storage takes in one request. */
export function uploadLimitBytes(): number {
  return Math.min(maxUserImageBytes(), UPLOAD_IMAGE_CEILING_BYTES);
}

/** A readable name for the image from its file name, such as my-tests from My Tests.tar.gz. */
export function uploadRepository(fileName: string): string {
  const name = fileName
    .toLowerCase()
    .replace(/\.(tar\.gz|tgz|tar|gz)$/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+/, '')
    .slice(0, 100)
    .replace(/[._-]+$/, '');

  return name || 'uploaded-image';
}

/** Only os/architecture count; a chip variant such as v8 doesn't change what runs. */
function platformOf(platform: string): string {
  return platform.trim().toLowerCase().split('/').slice(0, 2).join('/');
}

function digestOf(raw: string): string {
  if (!DIGEST_PATTERN.test(raw)) {
    throw new BadRequestException({
      code: 'IMAGE_REF_INVALID',
      message:
        'The digest must be sha256: followed by 64 lowercase hex characters',
      data: { field: 'config_digest' },
    });
  }

  return raw;
}

function imageRefOf(digest: string): string {
  return `${UPLOAD_REGISTRY}/image@${digest}`;
}

/** The file's own labels win, as for an image from a registry; without them the user names both. */
function labelsOf(input: ImageUploadLabels): {
  language: string;
  test_framework: string;
} {
  const labelled = Boolean(input.image_language || input.image_test_framework);

  if (!labelled) assertChoiceMatches(input);

  // With only one label the worker refuses the file, so the other may come from the user.
  const language = input.image_language ?? input.language;
  const testFramework = input.image_test_framework ?? input.test_framework;

  if (language && testFramework) {
    return { language, test_framework: testFramework };
  }

  const known =
    testFramework && Object.hasOwn(USER_IMAGE_FRAMEWORKS, testFramework)
      ? USER_IMAGE_FRAMEWORKS[testFramework].language
      : null;

  throw new BadRequestException({
    code: 'IMAGE_FRAMEWORK_NEEDED',
    message:
      'This image has no labels, so enter its language and test framework.',
    data: {
      field: language ? 'test_framework' : 'language',
      suggested: {
        language: language ?? known,
        test_framework: testFramework ?? null,
      },
    },
  });
}

function tooLarge(limit: number): BadRequestException {
  return new BadRequestException({
    code: 'IMAGE_TOO_LARGE',
    message: `The file is larger than ${Math.floor(limit / 1024 ** 2)} MB`,
    data: { max_bytes: limit },
  });
}

/**
 * Users' own images uploaded as a docker save file. The browser sends the file straight to Storage; the API only
 * hands out the upload address and records the image once the file is there. The worker checks the file itself.
 */
@Injectable()
export class TestAutomationCustomImageUploadsService {
  private readonly logger = new Logger(
    TestAutomationCustomImageUploadsService.name,
  );

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: TestManagementAccessService,
    private readonly auditLogs: AuditLogsService,
    private readonly images: TestAutomationCustomImagesService,
    @Optional() private readonly runner?: TestAutomationRunnerService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** An image the organisation already has is reused; otherwise the browser gets an address to upload to. */
  async start(
    user: RequestUser,
    spaceId: string,
    input: StartImageUpload,
  ): Promise<ImageUploadStart> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });
    await this.assertUploads(user.organizationId);

    const digest = digestOf(input.config_digest);
    const existing = await this.images.findByRef(
      user.organizationId,
      imageRefOf(digest),
    );

    if (existing && existing.status !== 'refused') {
      this.images.askApproval(user, spaceId, existing.id);
      void this.auditLogs.logActionForRequest(
        user,
        'test_automation_user_image',
        existing.id,
        'update',
        { action: 'reused', space_id: spaceId },
      );

      return {
        reused: true,
        image: await this.images.withLinks(
          user.organizationId,
          spaceId,
          existing,
          user.userId,
        ),
      };
    }

    const limit = uploadLimitBytes();

    if (input.file_bytes > limit) throw tooLarge(limit);

    if (platformOf(input.platform) !== runnerPlatform()) {
      throw new BadRequestException({
        code: 'IMAGE_WRONG_PLATFORM',
        message: `The image is for ${input.platform}, but this server runs ${runnerPlatform()}`,
        data: { platform: runnerPlatform() },
      });
    }

    labelsOf(input);
    await this.images.assertRunnerTakesWork();
    await this.images.assertRoomToCheck(user.organizationId);

    const path = uploadPath(user.organizationId, digest);

    return this.fromStorage('start the image upload', async () => {
      // A file left by a refused image or an unfinished upload would make the new upload fail.
      await removeStoredImages(this.client, [path]);

      // The token and path are already in the address; the browser needs nothing more.
      const { url, expires_in } = await signedImageUpload(this.client, path);

      void this.auditLogs.logActionForRequest(
        user,
        'test_automation_user_image',
        spaceId,
        'create',
        {
          action: 'upload_started',
          space_id: spaceId,
          file_name: input.file_name,
          file_bytes: input.file_bytes,
        },
      );

      return { reused: false, upload: { url, expires_in } };
    });
  }

  /** Records the uploaded image for its check; asking twice returns the same image. */
  async complete(
    user: RequestUser,
    spaceId: string,
    input: FinishImageUpload,
  ): Promise<CustomImage> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });
    await this.assertUploads(user.organizationId);

    const digest = digestOf(input.config_digest);
    const imageRef = imageRefOf(digest);
    const labels = labelsOf(input);
    const existing = await this.images.findByRef(user.organizationId, imageRef);

    if (existing && existing.status !== 'refused') {
      this.images.askApproval(user, spaceId, existing.id);
      void this.auditLogs.logActionForRequest(
        user,
        'test_automation_user_image',
        existing.id,
        'update',
        { action: 'reused', space_id: spaceId },
      );

      return this.images.withLinks(
        user.organizationId,
        spaceId,
        existing,
        user.userId,
      );
    }

    const path = uploadPath(user.organizationId, digest);
    const limit = uploadLimitBytes();
    const size = await this.fromStorage('read the uploaded image', () =>
      storedImageSize(this.client, path),
    );

    if (size === null) {
      throw new BadRequestException({
        code: 'UPLOAD_MISSING',
        message: 'The file has not arrived; upload the image again',
      });
    }

    if (size > limit) {
      await this.fromStorage('remove the uploaded image', () =>
        removeStoredImages(this.client, [path]),
      );

      throw tooLarge(limit);
    }

    // Over the limit the file stays, so the user can finish later; old files are cleaned up after 3 hours.
    await this.images.assertRoomToCheck(user.organizationId);

    const fields: ReviewFields = {
      status: 'checking',
      error_code: null,
      findings: [],
      run_ref: null,
      platform: runnerPlatform(),
      language: labels.language,
      test_framework: labels.test_framework,
      size_bytes: size,
    };
    const row: CustomImageRow = existing
      ? await this.images.checkAgain(user.organizationId, existing, fields)
      : await this.images.insert(
          user,
          {
            registry: UPLOAD_REGISTRY,
            repository: uploadRepository(input.file_name),
            digest,
            imageRef,
          },
          fields,
          input.shared,
        );

    void this.auditLogs.logActionForRequest(
      user,
      'test_automation_user_image',
      row.id,
      existing ? 'update' : 'create',
      { status: row.status, image_ref: row.image_ref, uploaded: true },
    );

    if (row.status === 'checking') void this.runner?.autoStart(user, spaceId);

    this.images.askApproval(user, spaceId, row.id);

    return this.images.withLinks(
      user.organizationId,
      spaceId,
      row,
      user.userId,
    );
  }

  /** Uploads are their own switch: a server may take uploaded images without allowing any registry. */
  private async assertUploads(organizationId: string): Promise<void> {
    if (imageUploadsEnabled() && (await this.images.enabled(organizationId))) {
      return;
    }

    throw this.notAvailable();
  }

  private notAvailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'UPLOADS_NOT_AVAILABLE',
      message: 'Uploading your own images is not switched on for this server',
    });
  }

  private async fromStorage<T>(
    action: string,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof ImageStorageError)) throw error;
      if (error.missingBucket) throw this.notAvailable();

      throw tmDbError(this.logger, action, { message: error.message });
    }
  }
}
