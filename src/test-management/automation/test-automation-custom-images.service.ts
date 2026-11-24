import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';

import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { PermissionsService } from '../../permissions/permissions.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { TestManagementAccessService } from '../access/test-management-access.service';
import { notFound, tmDbError } from '../test-management-errors';
import { invalid, runnerEnabled } from './automation-inputs';
import { TestAutomationRunnerService } from './test-automation-runner.service';
import { CustomImageApprovalService } from './custom-images/approval/service/custom-image-approval.service';
import {
  DockerHubError,
  dockerHubTags,
  searchDockerHub,
  type DockerHubRepository,
  type DockerHubTags,
} from './custom-images/docker-hub/docker-hub';
import {
  parseUserImageRef,
  reviewImageInRegistry,
  runnerPlatform,
  UserImageError,
  userImageRegistries,
  type UserImageErrorCode,
  type UserImageRef,
} from './custom-images/registry/custom-image-review';
import {
  imageUploadsEnabled,
  isOwnImageKey,
  MISSING_SCHEMA,
  OWN_IMAGE_KEY,
  USER_IMAGE_FRAMEWORKS,
} from './custom-images/shared/inputs/custom-image-inputs';
import { PROGRAMMING_LANGUAGES } from './custom-images/shared/languages/programming-languages';
import { UPLOAD_REGISTRY } from './custom-images/upload/storage/custom-image-storage';

export type CustomImageStatus =
  | 'checking'
  | 'approved'
  | 'needs_admin'
  | 'refused'
  | 'blocked';

export interface CustomImageFinding {
  code: string;
  detail: string;
}

/** A custom image as stored; an uploaded one has the registry "upload". */
export interface CustomImageRow {
  id: string;
  image_ref: string;
  run_ref: string | null;
  registry: string;
  repository: string;
  digest: string;
  platform: string;
  language: string | null;
  test_framework: string | null;
  size_bytes: number | null;
  status: CustomImageStatus;
  error_code: string | null;
  findings: CustomImageFinding[];
  scan: Record<string, unknown>;
  created_at: string;
  checked_at: string | null;
  approved_at: string | null;
  blocked_at: string | null;
  // Others in the organisation may use it; off keeps it to the person who added it, owners and admins.
  shared?: boolean;
  created_by?: string | null;
}

/** A custom image with the settings of this space that use it; who added it is never sent, only whether it was you. */
export interface CustomImage extends Omit<CustomImageRow, 'created_by'> {
  config_ids: string[];
  mine: boolean;
  // How far the worker is, while the image is being checked.
  progress?: Record<string, unknown>;
  // This space's approval, when the space asks for it.
  space_approval?: SpaceApproval | null;
  // The stored result of the security check; status may differ while this space's approval is waiting.
  check_status?: CustomImageStatus;
}

export interface SpaceApproval {
  status: 'not_requested' | 'pending' | 'approved' | 'rejected';
}

export interface CustomImageSettings {
  enabled: boolean;
  docker_hub_enabled: boolean;
  uploads_enabled: boolean;
  frameworks: { framework: string; language: string }[];
  languages: readonly { value: string; name: string }[];
}

export interface ImageChoice {
  language?: string;
  test_framework?: string;
}

export const CUSTOM_IMAGES_TABLE = 'test_automation_user_images';
const IMAGE_COLUMNS =
  'id, image_ref, run_ref, registry, repository, digest, platform, language, test_framework, size_bytes, status, ' +
  'error_code, findings, scan, created_at, checked_at, approved_at, blocked_at, shared, created_by';
const MAX_CHECKING = 3;

// Trying again later can pass, so these are reported without keeping a record.
const PASSING_PROBLEMS = new Set<UserImageErrorCode>([
  'REGISTRY_UNREACHABLE',
  'REGISTRY_RATE_LIMITED',
]);

// These codes carry facts the screen's text doesn't; for the rest the message only repeats the code's own text.
const DETAIL_CODES = new Set<UserImageErrorCode>([
  'IMAGE_PLATFORM_MISSING',
  'REGISTRY_NOT_ALLOWED',
  'REGISTRY_UNREACHABLE',
]);

export interface ReviewFields {
  status: CustomImageStatus;
  error_code: string | null;
  findings: CustomImageFinding[];
  run_ref: string | null;
  platform: string;
  language: string | null;
  test_framework: string | null;
  size_bytes: number | null;
}

/** Shared, or added by this person; a private image of someone else is otherwise hidden. */
function openTo(row: CustomImageRow, userId: string): boolean {
  return (
    row.shared !== false ||
    (Boolean(row.created_by) && row.created_by === userId)
  );
}

/** What the screen gets: who added the image stays on the server, only whether it was this person. */
function present(
  row: CustomImageRow,
  configIds: string[],
  userId: string,
): CustomImage {
  const { created_by: createdBy, ...image } = row;

  return {
    ...image,
    config_ids: configIds,
    mine: Boolean(createdBy) && createdBy === userId,
  };
}

/**
 * The image as this space sees it. A space that asks for approval sees a checked image as waiting until its owners or
 * admins approve it, or as refused once they reject it; the stored result of the check is left as it is for other spaces.
 */
function forSpace(
  image: CustomImage,
  approval: SpaceApproval | null,
): CustomImage {
  const seen = {
    ...image,
    check_status: image.status,
    space_approval: approval,
  };

  if (!approval || image.status !== 'approved') return seen;
  if (approval.status === 'approved') return seen;

  return {
    ...seen,
    status: approval.status === 'rejected' ? 'refused' : 'needs_admin',
  };
}

/** Why a setting with a custom image can't run yet. */
export function imageNotRunnable(
  image: CustomImageRow | null,
): BadRequestException {
  if (image?.status === 'checking') {
    return new BadRequestException({
      code: 'IMAGE_CHECKING',
      message: 'Your image is still being checked',
    });
  }

  if (image?.status === 'blocked') {
    return new BadRequestException({
      code: 'IMAGE_BLOCKED',
      message: 'Your image was blocked by an admin',
    });
  }

  return new BadRequestException({
    code: 'IMAGE_NOT_APPROVED',
    message: 'Your image is not approved to run',
  });
}

/** A language and framework entered together must belong together, such as javascript with jest. */
export function assertChoiceMatches(choice: ImageChoice): void {
  const { language, test_framework: testFramework } = choice;

  if (!language || !testFramework) return;

  const known = Object.hasOwn(USER_IMAGE_FRAMEWORKS, testFramework)
    ? USER_IMAGE_FRAMEWORKS[testFramework].language
    : null;

  // A framework new to this server can belong to any language.
  if (known === null || known === language) return;

  throw new BadRequestException({
    code: 'IMAGE_FRAMEWORK_NEEDED',
    message: `${testFramework} is not a ${language} test framework.`,
    data: {
      field: 'test_framework',
      suggested: { language: known ?? language, test_framework: testFramework },
    },
  });
}

/** The server may have dropped the registry, or uploads, since the image was checked. */
function registryAllowed(image: CustomImageRow): boolean {
  return image.registry === UPLOAD_REGISTRY
    ? imageUploadsEnabled()
    : userImageRegistries().includes(image.registry);
}

function registryNotAllowed(image: CustomImageRow): BadRequestException {
  return new BadRequestException({
    code: 'REGISTRY_NOT_ALLOWED',
    message:
      image.registry === UPLOAD_REGISTRY
        ? "Uploaded images aren't allowed on this server any more"
        : `Images from ${image.registry} aren't allowed on this server any more`,
  });
}

/**
 * The link of a runner setting to its custom image after a change; undefined leaves the column as it is, so a
 * setting with a server image never writes it.
 */
export async function customImageLink(
  images: TestAutomationCustomImagesService | undefined,
  organizationId: string,
  change: {
    requested: string | null | undefined;
    preset: string;
    imageKey: string;
    current: { id: string; image_key: string | null } | null;
  },
): Promise<string | null | undefined> {
  const { requested, preset, imageKey, current } = change;
  const hadOwnImage = isOwnImageKey(current?.image_key);

  if (!isOwnImageKey(imageKey)) {
    if (requested) {
      throw invalid(
        'user_image_id',
        'Only a setting that uses your own image links to one',
      );
    }

    return hadOwnImage ? null : undefined;
  }

  if (preset !== 'custom') {
    throw invalid('preset', 'Your own image works with the Custom framework');
  }

  if (!images || !(await images.enabled(organizationId))) {
    throw invalid(
      'image_key',
      'Using your own images is not switched on for this server',
    );
  }

  const saved =
    current && hadOwnImage
      ? await images.linkedImageId(organizationId, current.id)
      : null;
  const imageId = requested === undefined ? saved : requested;

  if (!imageId) throw invalid('user_image_id', 'Check your image first');

  // The saved image is checked again when a run starts, so other fields stay editable after its status changed.
  if (imageId === saved) return undefined;

  const image = await images.findById(organizationId, imageId);

  if (!image) throw invalid('user_image_id', 'Check your image first');

  if (image.status === 'refused' || image.status === 'blocked') {
    throw invalid(
      'user_image_id',
      image.status === 'blocked'
        ? 'This image is blocked'
        : 'This image was refused',
    );
  }

  return image.id;
}

/** Images users bring for their own test runs, checked before any setting may use them. */
@Injectable()
export class TestAutomationCustomImagesService {
  private readonly logger = new Logger(TestAutomationCustomImagesService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: TestManagementAccessService,
    private readonly permissions: PermissionsService,
    private readonly auditLogs: AuditLogsService,
    private readonly runner: TestAutomationRunnerService,
    @Optional()
    private readonly imageApprovals?: CustomImageApprovalService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** On when the server allows registries or uploads and the table exists; any other database error is a real error. */
  async enabled(organizationId: string): Promise<boolean> {
    if (userImageRegistries().length === 0 && !imageUploadsEnabled()) {
      return false;
    }

    const { error } = await this.client
      .from(CUSTOM_IMAGES_TABLE)
      .select('id')
      .eq('organization_id', organizationId)
      .limit(1);

    if (!error) return true;
    if (MISSING_SCHEMA.has(error.code)) return false;

    throw tmDbError(this.logger, 'check custom images', error);
  }

  async settings(
    user: RequestUser,
    spaceId: string,
  ): Promise<CustomImageSettings> {
    await this.access.assertAvailable(user.organizationId, spaceId);

    const enabled = await this.enabled(user.organizationId);

    return {
      enabled,
      docker_hub_enabled:
        enabled && userImageRegistries().includes('docker.io'),
      uploads_enabled: enabled && imageUploadsEnabled(),
      frameworks: enabled
        ? Object.entries(USER_IMAGE_FRAMEWORKS).map(([framework, item]) => ({
            framework,
            language: item.language,
          }))
        : [],
      languages: enabled ? PROGRAMMING_LANGUAGES : [],
    };
  }

  async list(user: RequestUser, spaceId: string): Promise<CustomImage[]> {
    await this.access.assertAvailable(user.organizationId, spaceId);
    await this.assertEnabled(user.organizationId);

    const { data, error } = await this.client
      .from(CUSTOM_IMAGES_TABLE)
      .select(IMAGE_COLUMNS)
      .eq('organization_id', user.organizationId)
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) throw tmDbError(this.logger, 'list custom images', error);

    const all = (data ?? []) as unknown as CustomImageRow[];
    const links = await this.spaceLinks(
      user.organizationId,
      spaceId,
      all.map((row) => row.id),
    );
    // Asked only when someone else's private image is there to hide.
    const admin =
      all.some((row) => !openTo(row, user.userId)) &&
      (await this.permissions.isAdminOrOwner(user.userId, user.organizationId));
    const rows = all.filter(
      (row) => admin || openTo(row, user.userId) || links.has(row.id),
    );
    const progress = await this.progressOf(
      user.organizationId,
      rows.filter((row) => row.status === 'checking').map((row) => row.id),
    );
    const approvals = await this.spaceApprovalsOf(
      user.organizationId,
      spaceId,
      rows.map((row) => row.id),
    );

    return rows.map((row) =>
      forSpace(
        {
          ...present(row, links.get(row.id) ?? [], user.userId),
          ...(progress.has(row.id) ? { progress: progress.get(row.id) } : {}),
        },
        approvals(row.id),
      ),
    );
  }

  /** How far the worker is with images still being checked; nothing when the progress column isn't there yet. */
  private async progressOf(
    organizationId: string,
    ids: string[],
  ): Promise<Map<string, Record<string, unknown>>> {
    if (ids.length === 0) return new Map();

    const { data, error } = await this.client
      .from(CUSTOM_IMAGES_TABLE)
      .select('id, progress')
      .eq('organization_id', organizationId)
      .in('id', ids);

    if (error) return new Map();

    return new Map(
      ((data ?? []) as { id: string; progress: Record<string, unknown> }[])
        .filter((row) => Object.keys(row.progress ?? {}).length > 0)
        .map((row) => [row.id, row.progress]),
    );
  }

  async get(
    user: RequestUser,
    spaceId: string,
    imageId: string,
  ): Promise<CustomImage> {
    await this.access.assertAvailable(user.organizationId, spaceId);
    await this.assertEnabled(user.organizationId);

    const row = await this.findById(user.organizationId, imageId);

    if (!row) throw notFound();

    const image = await this.withLinks(
      user.organizationId,
      spaceId,
      row,
      user.userId,
    );

    // Someone else's private image reads as missing, unless a setting here uses it.
    if (
      !openTo(row, user.userId) &&
      image.config_ids.length === 0 &&
      !(await this.permissions.isAdminOrOwner(user.userId, user.organizationId))
    ) {
      throw notFound();
    }

    const progress = await this.progressOf(
      user.organizationId,
      row.status === 'checking' ? [row.id] : [],
    );

    return progress.has(row.id)
      ? { ...image, progress: progress.get(row.id) }
      : image;
  }

  /** This space's approval answer per image; null for every image while the space doesn't ask for approval. */
  private async spaceApprovalsOf(
    organizationId: string,
    spaceId: string,
    imageIds: string[],
  ): Promise<(imageId: string) => SpaceApproval | null> {
    const found = this.imageApprovals
      ? await this.imageApprovals.spaceApprovals(
          organizationId,
          spaceId,
          imageIds,
        )
      : null;

    return (imageId) =>
      found?.required
        ? { status: found.statuses.get(imageId) ?? 'not_requested' }
        : null;
  }

  /** Checks an image in its registry and keeps the result; an image checked before is reused unless it was refused. */
  async check(
    user: RequestUser,
    spaceId: string,
    imageRef: string,
    choice: ImageChoice = {},
    shared?: boolean,
  ): Promise<CustomImage> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });
    await this.assertEnabled(user.organizationId);

    const ref = this.parse(imageRef);
    const existing = await this.findByRef(user.organizationId, ref.imageRef);

    // Bringing the same image again reuses it; its share choice stays with whoever added it first.
    if (existing && existing.status !== 'refused') {
      this.askApproval(user, spaceId, existing.id);
      void this.auditLogs.logActionForRequest(
        user,
        'test_automation_user_image',
        existing.id,
        'update',
        { action: 'reused', space_id: spaceId },
      );

      return this.withLinks(
        user.organizationId,
        spaceId,
        existing,
        user.userId,
      );
    }

    await this.assertRunnerTakesWork();
    await this.assertRoomToCheck(user.organizationId);

    const fields = await this.review(ref, choice);
    const row = existing
      ? await this.checkAgain(user.organizationId, existing, fields)
      : await this.insert(user, ref, fields, shared);

    void this.auditLogs.logActionForRequest(
      user,
      'test_automation_user_image',
      row.id,
      existing ? 'update' : 'create',
      { status: row.status, image_ref: row.image_ref },
    );

    if (row.status === 'checking') void this.runner.autoStart(user, spaceId);

    this.askApproval(user, spaceId, row.id);

    return this.withLinks(user.organizationId, spaceId, row, user.userId);
  }

  /** Asks this space for approval of an image as soon as it is added; the notice goes out once its check passes. */
  askApproval(user: RequestUser, spaceId: string, imageId: string): void {
    void this.imageApprovals
      ?.ensureRequest(user.organizationId, spaceId, imageId, user.userId)
      .catch((err: Error) =>
        this.logger.warn(`Image approval not asked: ${err.message}`),
      );
  }

  /** Lets others in the organisation use an image, or keeps it private; only whoever added it, an owner or an admin may. */
  async setSharing(
    user: RequestUser,
    spaceId: string,
    imageId: string,
    shared: boolean,
  ): Promise<CustomImage> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });
    await this.assertEnabled(user.organizationId);

    const row = await this.findById(user.organizationId, imageId);

    if (!row) throw notFound();

    const own = Boolean(row.created_by) && row.created_by === user.userId;

    if (
      !own &&
      !(await this.permissions.isAdminOrOwner(user.userId, user.organizationId))
    ) {
      // Someone else's private image reads as missing, as it does in the list.
      if (!openTo(row, user.userId)) throw notFound();

      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message:
          'Only whoever added the image, or an owner or admin, can change who may use it',
      });
    }

    const { error } = await this.client
      .from(CUSTOM_IMAGES_TABLE)
      .update({ shared })
      .eq('id', row.id)
      .eq('organization_id', user.organizationId);

    if (error)
      throw tmDbError(this.logger, 'change custom image sharing', error);

    void this.auditLogs.logActionForRequest(
      user,
      'test_automation_user_image',
      row.id,
      'update',
      { shared },
    );

    return this.withLinks(
      user.organizationId,
      spaceId,
      { ...row, shared },
      user.userId,
    );
  }

  async block(
    user: RequestUser,
    spaceId: string,
    imageId: string,
  ): Promise<CustomImage> {
    return this.decide(user, spaceId, imageId, 'blocked');
  }

  /** Images on Docker Hub matching what the user typed or pasted. */
  async searchDockerHub(
    user: RequestUser,
    spaceId: string,
    text: string,
  ): Promise<DockerHubRepository[]> {
    await this.assertDockerHub(user, spaceId);

    return this.fromDockerHub(() => searchDockerHub(text));
  }

  /** Versions of a Docker Hub image for this server's chip type. */
  async dockerHubTags(
    user: RequestUser,
    spaceId: string,
    repository: string,
    filter?: string,
  ): Promise<DockerHubTags> {
    await this.assertDockerHub(user, spaceId);

    return this.fromDockerHub(() =>
      dockerHubTags(repository, runnerPlatform(), filter),
    );
  }

  async findById(
    organizationId: string,
    imageId: string,
  ): Promise<CustomImageRow | null> {
    const { data, error } = await this.client
      .from(CUSTOM_IMAGES_TABLE)
      .select(IMAGE_COLUMNS)
      .eq('id', imageId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) {
      if (MISSING_SCHEMA.has(error.code)) return null;

      throw tmDbError(this.logger, 'load custom image', error);
    }

    return data as unknown as CustomImageRow | null;
  }

  /** The image a setting links to, read apart from the setting's columns so settings load before the migration. */
  async linkedImageId(
    organizationId: string,
    configId: string,
  ): Promise<string | null> {
    const { data, error } = await this.client
      .from('test_automation_configs')
      .select('user_image_id')
      .eq('id', configId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) {
      if (MISSING_SCHEMA.has(error.code)) return null;

      throw tmDbError(this.logger, 'load the image of a setting', error);
    }

    return (
      (data as { user_image_id: string | null } | null)?.user_image_id ?? null
    );
  }

  /** The approved image a run of this setting uses, from a registry or uploads the server still allows. */
  async runnableImage(
    organizationId: string,
    configId: string,
  ): Promise<CustomImageRow> {
    const imageId = (await this.enabled(organizationId))
      ? await this.linkedImageId(organizationId, configId)
      : null;
    const image = imageId ? await this.findById(organizationId, imageId) : null;

    if (!image || image.status !== 'approved') throw imageNotRunnable(image);
    if (!registryAllowed(image)) throw registryNotAllowed(image);

    return image;
  }

  private async assertEnabled(organizationId: string): Promise<void> {
    if (await this.enabled(organizationId)) return;

    throw new ServiceUnavailableException({
      code: 'USER_IMAGES_NOT_AVAILABLE',
      message: 'Using your own images is not switched on for this server',
    });
  }

  /** Only a worker finishes a check; a stopped runner is fine, the image waits until it starts. */
  assertRunnerTakesWork(): Promise<void> {
    if (!runnerEnabled()) {
      return Promise.reject(
        new ServiceUnavailableException({
          code: 'RUNNER_OFF',
          message: 'The test runner is not switched on for this server',
        }),
      );
    }

    return Promise.resolve();
  }

  private async assertDockerHub(
    user: RequestUser,
    spaceId: string,
  ): Promise<void> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });
    await this.assertEnabled(user.organizationId);

    if (!userImageRegistries().includes('docker.io')) {
      throw new BadRequestException({
        code: 'REGISTRY_NOT_ALLOWED',
        message: "Images from Docker Hub aren't allowed on this server",
      });
    }
  }

  private async fromDockerHub<T>(load: () => Promise<T>): Promise<T> {
    try {
      return await load();
    } catch (error) {
      if (!(error instanceof DockerHubError)) throw error;

      if (error.code === 'REGISTRY_RATE_LIMITED') {
        throw new HttpException(
          { code: error.code, message: error.message },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      throw new ServiceUnavailableException({
        code: error.code,
        message: error.message,
      });
    }
  }

  private parse(imageRef: string): UserImageRef {
    try {
      return parseUserImageRef(imageRef);
    } catch (error) {
      if (error instanceof UserImageError) {
        throw new BadRequestException({
          code: error.code,
          message: error.message,
          data: { field: 'image_ref' },
        });
      }

      throw error;
    }
  }

  private async review(
    ref: UserImageRef,
    choice: ImageChoice,
  ): Promise<ReviewFields> {
    try {
      const review = await reviewImageInRegistry(ref);
      const refused = review.findings.length > 0;

      // The image's own labels win, so a user can't relabel a labelled image.
      const labelled = review.language !== null;

      if (!labelled) assertChoiceMatches(choice);

      // What the user entered comes first; the image's own settings fill the rest.
      const language = labelled
        ? review.language
        : (choice.language ?? review.hints.language);
      const testFramework = labelled
        ? review.testFramework
        : (choice.test_framework ??
          (language === review.hints.language
            ? review.hints.testFramework
            : null));

      if (!refused && (!language || !testFramework)) {
        throw new BadRequestException({
          code: 'IMAGE_FRAMEWORK_NEEDED',
          message:
            'This image has no labels, so enter its language and test framework.',
          data: {
            field: language ? 'test_framework' : 'language',
            suggested: { language, test_framework: testFramework },
          },
        });
      }

      return {
        status: refused ? 'refused' : 'checking',
        error_code: refused ? review.findings[0].code : null,
        findings: review.findings,
        run_ref: review.runRef,
        platform: review.platform,
        language,
        test_framework: testFramework,
        size_bytes: review.sizeBytes,
      };
    } catch (error) {
      if (!(error instanceof UserImageError)) throw error;

      if (PASSING_PROBLEMS.has(error.code)) {
        throw new BadRequestException({
          code: error.code,
          message: error.message,
        });
      }

      return {
        status: 'refused',
        error_code: error.code,
        findings: [
          {
            code: error.code,
            detail: DETAIL_CODES.has(error.code) ? error.message : '',
          },
        ],
        run_ref: null,
        platform: runnerPlatform(),
        language: null,
        test_framework: null,
        size_bytes: null,
      };
    }
  }

  /** Each check downloads and scans on the runner, so an organisation waits for a few at a time. */
  async assertRoomToCheck(organizationId: string): Promise<void> {
    const { count, error } = await this.client
      .from(CUSTOM_IMAGES_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('status', 'checking');

    if (error) throw tmDbError(this.logger, 'count custom image checks', error);

    if ((count ?? 0) >= MAX_CHECKING) {
      throw new HttpException(
        {
          code: 'TOO_MANY_CHECKS',
          message: `At most ${MAX_CHECKING} images can wait for their check at once`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** A second check of the same image at the same moment keeps the first row, which both then read. */
  async insert(
    user: RequestUser,
    ref: UserImageRef,
    fields: ReviewFields,
    shared?: boolean,
  ): Promise<CustomImageRow> {
    const { error } = await this.client.from(CUSTOM_IMAGES_TABLE).upsert(
      {
        organization_id: user.organizationId,
        image_ref: ref.imageRef,
        registry: ref.registry,
        repository: ref.repository,
        digest: ref.digest,
        created_by: user.userId,
        // Only the first adding decides; a duplicate is ignored below.
        ...(shared === false ? { shared: false } : {}),
        ...fields,
        checked_at:
          fields.status === 'refused' ? new Date().toISOString() : null,
      },
      { onConflict: 'organization_id,image_ref', ignoreDuplicates: true },
    );

    if (error) throw tmDbError(this.logger, 'save custom image', error);

    const row = await this.findByRef(user.organizationId, ref.imageRef);

    if (!row) throw notFound();

    return row;
  }

  /** A refused image starts again from the beginning and joins the end of the queue. */
  async checkAgain(
    organizationId: string,
    existing: CustomImageRow,
    fields: ReviewFields,
  ): Promise<CustomImageRow> {
    const now = new Date().toISOString();
    const { data, error } = await this.client
      .from(CUSTOM_IMAGES_TABLE)
      .update({
        ...fields,
        scan: {},
        progress: {},
        attempts: 0,
        worker_id: null,
        lease_until: null,
        created_at: now,
        checked_at: fields.status === 'refused' ? now : null,
      })
      .eq('id', existing.id)
      .eq('organization_id', organizationId)
      .eq('status', 'refused')
      .select(IMAGE_COLUMNS)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'check custom image again', error);

    // Changed by someone else in between, so their result is the one that counts.
    return (
      (data as unknown as CustomImageRow | null) ??
      (await this.findById(organizationId, existing.id)) ??
      existing
    );
  }

  private async decide(
    user: RequestUser,
    spaceId: string,
    imageId: string,
    status: 'blocked',
  ): Promise<CustomImage> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });
    await this.assertEnabled(user.organizationId);

    if (
      !(await this.permissions.isAdminOrOwner(user.userId, user.organizationId))
    ) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Only an owner or admin of the organisation can do this',
      });
    }

    const row = await this.findById(user.organizationId, imageId);

    if (!row) throw notFound();

    const from: CustomImageStatus[] = [
      'checking',
      'approved',
      'needs_admin',
      'refused',
    ];
    const now = new Date().toISOString();
    const { data, error } = from.includes(row.status)
      ? await this.client
          .from(CUSTOM_IMAGES_TABLE)
          .update({
            status,
            blocked_by: user.userId,
            blocked_at: now,
            worker_id: null,
            lease_until: null,
          })
          .eq('id', imageId)
          .eq('organization_id', user.organizationId)
          .in('status', from)
          .select(IMAGE_COLUMNS)
          .maybeSingle()
      : { data: null, error: null };

    if (error)
      throw tmDbError(this.logger, `set custom image ${status}`, error);

    if (!data) {
      throw new ConflictException({
        code: 'IMAGE_NOT_WAITING',
        message: 'This image is already blocked',
      });
    }

    void this.auditLogs.logActionForRequest(
      user,
      'test_automation_user_image',
      imageId,
      'update',
      { status, previous_status: row.status },
    );

    return this.withLinks(
      user.organizationId,
      spaceId,
      data as unknown as CustomImageRow,
      user.userId,
    );
  }

  async findByRef(
    organizationId: string,
    imageRef: string,
  ): Promise<CustomImageRow | null> {
    const { data, error } = await this.client
      .from(CUSTOM_IMAGES_TABLE)
      .select(IMAGE_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('image_ref', imageRef)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load custom image', error);

    return data as unknown as CustomImageRow | null;
  }

  async withLinks(
    organizationId: string,
    spaceId: string,
    row: CustomImageRow,
    userId: string,
  ): Promise<CustomImage> {
    const [links, approvals] = await Promise.all([
      this.spaceLinks(organizationId, spaceId, [row.id]),
      this.spaceApprovalsOf(organizationId, spaceId, [row.id]),
    ]);

    return forSpace(
      present(row, links.get(row.id) ?? [], userId),
      approvals(row.id),
    );
  }

  /** The settings of this space that use each image. */
  private async spaceLinks(
    organizationId: string,
    spaceId: string,
    imageIds: string[],
  ): Promise<Map<string, string[]>> {
    const links = new Map<string, string[]>();

    if (imageIds.length === 0) return links;

    const { data, error } = await this.client
      .from('test_automation_configs')
      .select('id, user_image_id')
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .eq('image_key', OWN_IMAGE_KEY)
      .in('user_image_id', imageIds);

    if (error) throw tmDbError(this.logger, 'load custom image links', error);

    for (const link of (data ?? []) as {
      id: string;
      user_image_id: string;
    }[]) {
      links.set(link.user_image_id, [
        ...(links.get(link.user_image_id) ?? []),
        link.id,
      ]);
    }

    return links;
  }
}
