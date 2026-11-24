import { rm } from 'fs/promises';

import { Logger } from '@nestjs/common';

import { AuditLogsService } from '../../../../audit-logs/audit-logs.service';
import { stripIllegalXml } from '../../../../backup/engine/writers/xml.writer';
import { SupabaseAdminService } from '../../../../supabase/supabase-admin.service';
import {
  checkImage,
  fetchSchema1Manifest,
  findingDetail,
  LABEL_FRAMEWORK,
  LABEL_LANGUAGE,
  maxUserImageBytes,
  parseUserImageRef,
  runnerPlatform,
  UserImageError,
  volumesLeftBehind,
  type Schema1Image,
  type UserImageRef,
} from '../../../../test-management/automation/custom-images/registry/custom-image-review';
import { USER_IMAGE_FRAMEWORKS } from '../../../../test-management/automation/custom-images/shared/inputs/custom-image-inputs';
import { UPLOAD_REGISTRY } from '../../../../test-management/automation/custom-images/upload/storage/custom-image-storage';
import {
  PINNED_IMAGE_PATTERN,
  type DockerResult,
} from '../../../docker-driver';
import {
  pullFailure,
  type CustomImageDetails,
  type CustomImageDocker,
} from '../../docker/custom-image-docker';
import { ImageFileError, type ImageFile } from '../../image-file/tar/image-tar';
import {
  hasRoomForUpload,
  loadUploadedImage,
  LoadMachineProblem,
  readUploadedImage,
  removeLeftoverUploadFolders,
  uploadFolder,
  uploadRunTag,
} from '../../image-file/load/load-upload';
import { convertSchema1 } from '../../legacy/schema1-image';
import {
  dockerTrivyScanner,
  scannerImage,
  TryLater,
  type ScanImage,
  type ScanResult,
} from '../scanner/custom-image-scanner';

const TABLE = 'test_automation_user_images';
// A pull may take 15 minutes and a scan 10, so one lease covers the whole check.
const LEASE_SECONDS = 1800;
const REVIEW_MS = 25 * 60_000;
const RETRY_AFTER_MS = 15 * 60_000;
const PROGRESS_EVERY_MS = 2_000;
// The check's log shown on the screen: the newest lines only, each cut, colour codes removed.
const LOG_LINES = 100;
const LOG_LINE_LENGTH = 300;
// eslint-disable-next-line no-control-regex
const COLOUR_CODES = /\u001b\[[0-9;]*[A-Za-z]/g;
// Docker's line for a part of the image it found, and the words that mean the part is ready.
const IMAGE_PART =
  /^([0-9a-f]{12}): (Pulling fs layer|Waiting|Already exists|Pull complete)$/;
const PART_READY = new Set(['Already exists', 'Pull complete']);
const FORBIDDEN_LABEL_PREFIXES = [
  'com.docker.compose.',
  'com.supabase.',
  'xisuite.',
];
// Images other rows still use stay on the machine.
const DONE_STATUSES = '(refused,blocked)';

// System packages that make an image something other than a test image.
const FORBIDDEN_PACKAGE =
  /^(postgresql(-\d+)?|mysql-server.*|mariadb-server.*|mongodb(-org)?(-server)?|redis-server|nginx(-.*)?|apache2|httpd|openssh-server|docker(-ce|-ce-cli|\.io)?|containerd(\.io)?|moby-.*|xmrig|kubelet|k3s)$/;

export interface CheckProgress {
  step: 'download' | 'inspect' | 'scan';
  percent: number;
  done?: number;
  total?: number;
  started_at: string;
  log?: string[];
}

export interface LeasedCustomImage {
  id: string;
  organization_id: string;
  registry: string;
  attempts?: number;
  run_ref: string;
  platform: string;
  language: string | null;
  test_framework: string | null;
  pulled_by_runner: boolean;
  // An uploaded image is found by its config digest; its file size is what the disk must hold.
  digest?: string;
  size_bytes?: number | null;
}

interface Finding {
  code: string;
  detail: string;
}

/** A pull the registry refused for good, such as an image that no longer exists. */
class RefusedPull extends Error {}

/** A pull this machine could not do, such as a full disk; the image is not to blame. */
class MachineProblem extends Error {}

/** Package names that prove the declared framework is inside the image; other frameworks are not checked for a package. */
function frameworkPackages(framework: string | null): string[] | undefined {
  return framework && Object.hasOwn(USER_IMAGE_FRAMEWORKS, framework)
    ? USER_IMAGE_FRAMEWORKS[framework].packages
    : undefined;
}

/** How far a download is, from Docker's pull lines; the download is 5 to 70 per cent of the whole check. */
export function downloadProgress(output: string): {
  done: number;
  total: number;
  percent: number;
} {
  const seen = new Set<string>();
  const ready = new Set<string>();

  for (const line of output.split(/\r?\n/)) {
    const part = IMAGE_PART.exec(line.trim());

    if (!part) continue;

    seen.add(part[1]);
    if (PART_READY.has(part[2])) ready.add(part[1]);
  }

  const total = seen.size;

  return {
    done: ready.size,
    total,
    percent: total ? 5 + Math.floor((65 * ready.size) / total) : 5,
  };
}

/** The scanner the setting names, or none. */
export function configuredScanner(
  raw = process.env.TM_RUNNER_SCANNER,
): ScanImage | null {
  const image = scannerImage(raw);

  return image && PINNED_IMAGE_PATTERN.test(image)
    ? dockerTrivyScanner(image)
    : null;
}

type ReviewDocker = Pick<
  CustomImageDocker,
  | 'imagePresent'
  | 'pullAnonymous'
  | 'inspectImage'
  | 'removeImage'
  | 'platform'
  | 'removeScannerLeftovers'
  | 'loadImage'
  | 'tagImage'
  | 'imageLayers'
>;

/** The second check of a user's own image, on the runner machine: download, inspect and scan, never start it. */
export class CustomImageReviewer {
  private readonly logger = new Logger(CustomImageReviewer.name);
  private lastProblem: string | null | undefined;
  private lastProgressAt = 0;
  private lastProgress: CheckProgress | null = null;
  private logLines: string[] = [];

  constructor(
    private readonly docker: ReviewDocker,
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly scan: ScanImage | null = configuredScanner(),
    // Tells the spaces that ask for approval once the image passed; never undoes the result.
    private readonly onApproved?: (image: {
      id: string;
      organization_id: string;
    }) => Promise<void>,
    private readonly auditLogs?: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** Why image checks can't run on this machine right now, or null when they can. */
  async readiness(): Promise<string | null> {
    const platform = await this.docker.platform().catch(() => null);

    if (platform !== runnerPlatform()) {
      return `Docker runs ${platform ?? 'nothing'}, but TM_RUNNER_PLATFORM is ${runnerPlatform()}`;
    }

    const setting = process.env.TM_RUNNER_SCANNER?.trim();

    if (!setting) {
      return process.env.NODE_ENV === 'production'
        ? 'SCANNER_MISSING: set TM_RUNNER_SCANNER to docker:<Trivy image>@sha256:…'
        : null;
    }

    const image = scannerImage(setting);

    if (!image || !PINNED_IMAGE_PATTERN.test(image)) {
      return 'SCANNER_MISSING: TM_RUNNER_SCANNER must name the Trivy image by digest, such as docker:aquasec/trivy@sha256:…';
    }

    if (!(await this.docker.imagePresent(image).catch(() => false))) {
      return `SCANNER_MISSING: the Trivy image ${image} is not on this machine; run docker pull ${image}`;
    }

    return null;
  }

  /** Takes the next image waiting for its check. Answers whether there was one. */
  async processNext(workerId: string): Promise<boolean> {
    const problem = await this.readiness();

    // Said once per change, not on every poll.
    if (problem !== this.lastProblem) {
      if (problem) this.logger.warn(`Image checks paused: ${problem}`);
      else if (this.lastProblem) this.logger.log('Image checks resumed');
    }

    this.lastProblem = problem;

    if (problem) return false;

    const { data, error } = (await this.client.rpc(
      'tm_lease_user_image_review',
      { p_worker_id: workerId, p_lease_seconds: LEASE_SECONDS },
    )) as {
      data: LeasedCustomImage[] | null;
      error: { code?: string; message: string } | null;
    };

    if (error) {
      this.logger.error('Failed to take an image to check', error);

      return false;
    }

    const image = data?.[0];

    if (!image) return false;

    if (image.registry === UPLOAD_REGISTRY) {
      await this.reviewUpload(image, workerId);

      return true;
    }

    await this.review(image, workerId);

    return true;
  }

  /** Runs on the sweep: removes downloads of images that may no longer run, and scanner containers left behind. */
  async cleanUp(): Promise<void> {
    try {
      await this.docker.removeScannerLeftovers();
      await removeLeftoverUploadFolders();

      const { data, error } = await this.client
        .from(TABLE)
        .select('id, organization_id, run_ref, registry, digest')
        .in('status', ['refused', 'blocked'])
        .eq('pulled_by_runner', true)
        .limit(20);

      if (error) return;

      for (const row of (data ?? []) as Pick<
        LeasedCustomImage,
        'id' | 'organization_id' | 'run_ref' | 'registry' | 'digest'
      >[]) {
        await this.removeDownloaded(row);
      }
    } catch (error) {
      // The next sweep tries again.
      this.logger.warn(
        `Image clean-up skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async review(
    image: LeasedCustomImage,
    workerId: string,
  ): Promise<void> {
    const signal = AbortSignal.timeout(REVIEW_MS);
    const startedAt = new Date().toISOString();
    let pulledHere = false;

    this.lastProgressAt = 0;
    this.lastProgress = null;
    this.logLines = [];

    if (!image.run_ref) {
      await this.save(image, workerId, {
        status: 'refused',
        error_code: 'UNSUPPORTED_MANIFEST',
        findings: [
          { code: 'UNSUPPORTED_MANIFEST', detail: 'No image to download' },
        ],
      });

      return;
    }

    try {
      if (!(await this.docker.imagePresent(image.run_ref))) {
        this.log(`Download started: ${image.run_ref}`);

        try {
          await this.pull(image, workerId, signal, startedAt);
        } catch (error) {
          const old = await this.oldFormat(image, error, signal);

          if (!old) throw error;

          await this.reviewConverted(image, workerId, old, signal, startedAt);

          return;
        }

        pulledHere = true;
        this.log('Download finished');
      } else {
        this.log('Already on this server');
      }

      this.log('Inspecting the image');
      await this.report(
        image,
        workerId,
        { step: 'inspect', percent: 75, started_at: startedAt },
        true,
      );

      const details = await this.docker.inspectImage(image.run_ref);

      if (!details) {
        throw new TryLater('The downloaded image could not be read');
      }

      const findings = this.inspect(image, details);

      if (this.scan) {
        this.log('Security check started (Trivy)');
        await this.report(
          image,
          workerId,
          { step: 'scan', percent: 80, started_at: startedAt },
          true,
        );
      } else {
        this.log('No security scanner on this server');
      }

      const scan = await this.runScan(image, workerId, signal);

      // The last lines reach the screen before the result does.
      if (this.lastProgress) {
        await this.report(image, workerId, this.lastProgress, true);
      }

      if (scan) findings.push(...this.scanFindings(image, scan));

      // An image whose checks find no problem is approved at once.
      await this.save(image, workerId, {
        status: findings.length > 0 ? 'refused' : 'approved',
        error_code: findings[0]?.code ?? null,
        findings,
        size_bytes: details.size,
        scan: scan
          ? {
              scanner: 'trivy',
              critical: scan.critical,
              high: scan.high,
              secrets: scan.secrets.slice(0, 50),
            }
          : { scanner: null },
      });

      // The check is done with the image; a test run downloads it again when it needs it.
      if (pulledHere) await this.removeDownloaded(image);
    } catch (error) {
      if (error instanceof RefusedPull) {
        await this.save(image, workerId, {
          status: 'refused',
          error_code: 'IMAGE_PULL_FAILED',
          findings: [
            {
              code: 'IMAGE_PULL_FAILED',
              detail: 'The image could not be downloaded',
            },
          ],
        });

        return;
      }

      if (pulledHere) await this.removeDownloaded(image);

      if (error instanceof MachineProblem && !signal.aborted) {
        this.logger.warn(
          `Image ${image.id} is handed back: ${error.message.slice(0, 300)}`,
        );
        await this.handBack(image, workerId);

        return;
      }

      if (error instanceof TryLater || signal.aborted) {
        this.logger.warn(
          `Image ${image.id} is checked again later: ${error instanceof Error ? error.message : String(error)}`,
        );
      } else {
        this.logger.error(`Image ${image.id} could not be checked`, error);
      }

      await this.tryLater(image, workerId);
    }
  }

  /** An uploaded file: read and clean it, check what it holds, scan it, then load it once to prove Docker takes it. */
  private async reviewUpload(
    image: LeasedCustomImage,
    workerId: string,
  ): Promise<void> {
    const signal = AbortSignal.timeout(REVIEW_MS);
    const startedAt = new Date().toISOString();
    const total = image.size_bytes ?? 0;
    let folder: string | null = null;
    let loaded = false;

    this.lastProgressAt = 0;
    this.lastProgress = null;
    this.logLines = [];

    if (!(await hasRoomForUpload(total))) {
      this.logger.warn(
        `Image ${image.id} is handed back: not enough free disk`,
      );
      await this.handBack(image, workerId);

      return;
    }

    try {
      const tag = uploadRunTag(image.digest ?? '');

      folder = await uploadFolder();
      this.log('Download started: the uploaded file');
      await this.report(
        image,
        workerId,
        { step: 'download', percent: 5, started_at: startedAt },
        true,
      );

      const file = await readUploadedImage(
        this.client,
        { organization_id: image.organization_id, digest: image.digest ?? '' },
        folder,
        signal,
        (read) =>
          void this.report(image, workerId, {
            step: 'download',
            percent: total
              ? 5 + Math.min(65, Math.floor((65 * read) / total))
              : 5,
            started_at: startedAt,
          }),
      );

      this.log('Download finished; the file is a valid image');
      await this.report(
        image,
        workerId,
        { step: 'inspect', percent: 75, started_at: startedAt },
        true,
      );

      const findings = this.uploadFindings(image, file);
      let scan: ScanResult | null = null;

      if (findings.length === 0) {
        if (this.scan) {
          this.log('Security check started (Trivy)');
          await this.report(
            image,
            workerId,
            { step: 'scan', percent: 80, started_at: startedAt },
            true,
          );
        } else {
          this.log('No security scanner on this server');
        }

        scan = await this.runScan(image, workerId, signal, tag, folder);

        if (scan) findings.push(...this.scanFindings(image, scan));
      }

      // Loaded only when nothing refused it yet, so a refused file never reaches Docker.
      if (findings.length === 0) {
        this.log('Loading the image into Docker');
        await loadUploadedImage(this.docker, folder, file, tag, signal);
        loaded = true;
        await this.client
          .from(TABLE)
          .update({ pulled_by_runner: true })
          .eq('id', image.id)
          .eq('organization_id', image.organization_id);
        this.log('Docker holds exactly the layers of the file');
      }

      await rm(folder, { recursive: true, force: true });
      folder = null;

      if (this.lastProgress) {
        await this.report(image, workerId, this.lastProgress, true);
      }

      await this.save(image, workerId, {
        // An image whose checks find no problem is approved at once.
        status: findings.length > 0 ? 'refused' : 'approved',
        error_code: findings[0]?.code ?? null,
        findings,
        scan: scan
          ? {
              scanner: 'trivy',
              critical: scan.critical,
              high: scan.high,
              secrets: scan.secrets.slice(0, 50),
            }
          : { scanner: null },
      });

      // A test run loads it again from the stored file when it needs it.
      if (loaded) await this.removeDownloaded(image);
    } catch (error) {
      if (loaded) await this.removeDownloaded(image);

      if (error instanceof ImageFileError) {
        await this.save(image, workerId, {
          status: 'refused',
          error_code: error.code,
          findings: [
            { code: error.code, detail: findingDetail(error.message) },
          ],
        });

        return;
      }

      if (error instanceof LoadMachineProblem && !signal.aborted) {
        this.logger.warn(
          `Image ${image.id} is handed back: ${error.message.slice(0, 300)}`,
        );
        await this.handBack(image, workerId);

        return;
      }

      if (error instanceof TryLater || signal.aborted) {
        this.logger.warn(
          `Image ${image.id} is checked again later: ${error instanceof Error ? error.message : String(error)}`,
        );
      } else {
        this.logger.error(`Image ${image.id} could not be checked`, error);
      }

      await this.tryLater(image, workerId);
    } finally {
      if (folder) await rm(folder, { recursive: true, force: true });
    }
  }

  /** The old schema 1 description behind a pull Docker refused, or null for any other failed pull. */
  private async oldFormat(
    image: LeasedCustomImage,
    error: unknown,
    signal: AbortSignal,
  ): Promise<{ ref: UserImageRef; image: Schema1Image } | null> {
    if (
      signal.aborted ||
      !(error instanceof RefusedPull || error instanceof TryLater)
    ) {
      return null;
    }

    try {
      const ref = parseUserImageRef(image.run_ref, [image.registry]);
      const old = await fetchSchema1Manifest(ref);

      return old ? { ref, image: old } : null;
    } catch (lookup) {
      this.logger.warn(
        `Image ${image.id}: format check failed: ${lookup instanceof Error ? lookup.message : String(lookup)}`,
      );

      return null;
    }
  }

  /** An old schema 1 image Docker no longer downloads: converted here, then checked like an uploaded file. */
  private async reviewConverted(
    image: LeasedCustomImage,
    workerId: string,
    old: { ref: UserImageRef; image: Schema1Image },
    signal: AbortSignal,
    startedAt: string,
  ): Promise<void> {
    let folder: string | null = null;
    let loaded = false;

    try {
      const tag = uploadRunTag(old.ref.digest);

      this.log('Old image format: downloading and converting it');
      folder = await uploadFolder();

      const file = await convertSchema1({
        ref: old.ref,
        image: old.image,
        folder,
        signal,
        onBytes: (done, total) =>
          void this.report(image, workerId, {
            step: 'download',
            percent: total
              ? 5 + Math.min(65, Math.floor((65 * done) / total))
              : 5,
            started_at: startedAt,
          }),
      });

      this.log('Download finished; the image was converted');
      await this.report(
        image,
        workerId,
        { step: 'inspect', percent: 75, started_at: startedAt },
        true,
      );

      const findings = this.uploadFindings(image, file);
      let scan: ScanResult | null = null;

      if (findings.length === 0) {
        if (this.scan) {
          this.log('Security check started (Trivy)');
          await this.report(
            image,
            workerId,
            { step: 'scan', percent: 80, started_at: startedAt },
            true,
          );
        } else {
          this.log('No security scanner on this server');
        }

        scan = await this.runScan(image, workerId, signal, tag, folder);

        if (scan) findings.push(...this.scanFindings(image, scan));
      }

      // Loaded only when nothing refused it, so a refused image never reaches Docker.
      if (findings.length === 0) {
        this.log('Loading the image into Docker');
        await loadUploadedImage(this.docker, folder, file, tag, signal);
        loaded = true;
        await this.client
          .from(TABLE)
          .update({ pulled_by_runner: true })
          .eq('id', image.id)
          .eq('organization_id', image.organization_id);
        this.log('Docker holds exactly the layers of the image');
      }

      await rm(folder, { recursive: true, force: true });
      folder = null;

      if (this.lastProgress) {
        await this.report(image, workerId, this.lastProgress, true);
      }

      await this.save(image, workerId, {
        status: findings.length > 0 ? 'refused' : 'approved',
        error_code: findings[0]?.code ?? null,
        findings,
        size_bytes:
          file.configBytes +
          file.layerBytes.reduce((sum, bytes) => sum + bytes, 0),
        scan: scan
          ? {
              scanner: 'trivy',
              critical: scan.critical,
              high: scan.high,
              secrets: scan.secrets.slice(0, 50),
            }
          : { scanner: null },
      });

      // A test run converts it again when it needs it, as it downloads any other image again.
      if (loaded) await this.removeDownloaded(image);
    } catch (error) {
      if (loaded) await this.removeDownloaded(image);

      const refusal =
        error instanceof ImageFileError
          ? error.code
          : error instanceof UserImageError &&
              !['REGISTRY_RATE_LIMITED', 'REGISTRY_UNREACHABLE'].includes(
                error.code,
              )
            ? error.code === 'IMAGE_NOT_PUBLIC'
              ? 'IMAGE_PULL_FAILED'
              : error.code
            : null;

      if (refusal && !signal.aborted) {
        await this.save(image, workerId, {
          status: 'refused',
          error_code: refusal,
          findings: [
            {
              code: refusal,
              detail: findingDetail((error as Error).message),
            },
          ],
        });

        return;
      }

      if (error instanceof LoadMachineProblem && !signal.aborted) {
        this.logger.warn(
          `Image ${image.id} is handed back: ${error.message.slice(0, 300)}`,
        );
        await this.handBack(image, workerId);

        return;
      }

      this.logger.warn(
        `Image ${image.id} is checked again later: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.tryLater(image, workerId);
    } finally {
      if (folder) await rm(folder, { recursive: true, force: true });
    }
  }

  /** The same rules as for an image from a registry, read from the uploaded file. */
  private uploadFindings(image: LeasedCustomImage, file: ImageFile): Finding[] {
    const review = checkImage(
      {
        config: { size: file.configBytes },
        layers: file.layerBytes.map((size) => ({ size })),
      },
      file.config,
      image.platform,
      maxUserImageBytes(),
    );
    const settings = (file.config.config ?? {}) as Record<string, unknown>;
    const labels = (settings.Labels ?? {}) as Record<string, unknown>;
    const labelled =
      Object.hasOwn(labels, LABEL_LANGUAGE) ||
      Object.hasOwn(labels, LABEL_FRAMEWORK);
    const findings: Finding[] = [...review.findings];

    // An image without labels uses the language and framework the user entered.
    if (
      labelled &&
      (labels[LABEL_LANGUAGE] !== image.language ||
        labels[LABEL_FRAMEWORK] !== image.test_framework)
    ) {
      findings.push({
        code: 'IMAGE_BAD_LABELS',
        detail: 'The labels differ from the ones given at upload',
      });
    }

    return findings;
  }

  private async pull(
    image: LeasedCustomImage,
    workerId: string,
    signal: AbortSignal,
    startedAt: string,
  ): Promise<void> {
    let output = '';
    const lines = this.lineReader();

    const result: DockerResult = await this.docker.pullAnonymous(
      image.run_ref,
      image.platform,
      signal,
      (chunk) => {
        output += chunk.toString('utf8');
        lines.push(chunk);

        void this.report(image, workerId, {
          step: 'download',
          ...downloadProgress(output),
          started_at: startedAt,
        });
      },
    );

    lines.flush();

    if (result.code !== 0) {
      const failure = pullFailure(result.output);

      if (failure === 'refused' && !signal.aborted) throw new RefusedPull();
      if (failure === 'machine') throw new MachineProblem(result.output);

      throw new TryLater(
        failure === 'rate_limited'
          ? 'The registry is limiting downloads'
          : 'The download did not finish',
      );
    }

    // Marked now, so a stop during the scan still leaves the image to be removed later.
    await this.client
      .from(TABLE)
      .update({ pulled_by_runner: true })
      .eq('id', image.id)
      .eq('organization_id', image.organization_id);
  }

  private inspect(
    image: LeasedCustomImage,
    details: CustomImageDetails,
  ): Finding[] {
    const findings: Finding[] = [];
    const digest = image.run_ref.slice(image.run_ref.lastIndexOf('@'));

    if (!details.repoDigests.some((item) => item.endsWith(digest))) {
      findings.push({
        code: 'DIGEST_MISMATCH',
        detail: 'The downloaded image has another digest',
      });
    }

    if (`${details.os}/${details.architecture}` !== image.platform) {
      findings.push({
        code: 'IMAGE_WRONG_PLATFORM',
        detail: findingDetail(`${details.os}/${details.architecture}`),
      });
    }

    const labelled =
      Object.hasOwn(details.labels, LABEL_LANGUAGE) ||
      Object.hasOwn(details.labels, LABEL_FRAMEWORK);

    // An image without labels uses the language and framework the user entered.
    if (
      labelled &&
      (details.labels[LABEL_LANGUAGE] !== image.language ||
        details.labels[LABEL_FRAMEWORK] !== image.test_framework)
    ) {
      findings.push({
        code: 'IMAGE_BAD_LABELS',
        detail: 'The labels differ from the first check',
      });
    }

    const forbidden = Object.keys(details.labels).filter(
      (name) =>
        name !== LABEL_LANGUAGE &&
        name !== LABEL_FRAMEWORK &&
        FORBIDDEN_LABEL_PREFIXES.some((prefix) => name.startsWith(prefix)),
    );

    if (forbidden.length > 0) {
      findings.push({
        code: 'IMAGE_BAD_LABELS',
        detail: findingDetail(forbidden.slice(0, 5).join(', ')),
      });
    }

    const leftBehind = volumesLeftBehind(details.volumes);

    if (leftBehind.length > 0) {
      findings.push({
        code: 'IMAGE_HAS_VOLUMES',
        detail: findingDetail(leftBehind.slice(0, 5).join(', ')),
      });
    }

    if (details.size > maxUserImageBytes()) {
      findings.push({
        code: 'IMAGE_TOO_LARGE',
        detail: `${Math.ceil(details.size / 1024 ** 2)} MB unpacked`,
      });
    }

    return findings;
  }

  private scanFindings(image: LeasedCustomImage, scan: ScanResult): Finding[] {
    const findings: Finding[] = [];
    const evidence = frameworkPackages(image.test_framework);

    if (evidence && !evidence.some((name) => scan.packages.has(name))) {
      findings.push({
        code: 'IMAGE_NOT_TEST_IMAGE',
        detail: `No ${image.test_framework ?? ''} package was found in the image`,
      });
    }

    const forbidden = [...scan.systemPackages].filter((name) =>
      FORBIDDEN_PACKAGE.test(name),
    );

    if (forbidden.length > 0) {
      findings.push({
        code: 'IMAGE_FORBIDDEN_SOFTWARE',
        detail: findingDetail(forbidden.slice(0, 5).join(', ')),
      });
    }

    if (scan.critical > 0) {
      findings.push({
        code: 'IMAGE_CRITICAL_VULNERABILITIES',
        detail: `${scan.critical} critical`,
      });
    }

    return findings;
  }

  /** Only while the image still waits for this worker, so a block made meanwhile is never undone. */
  private async save(
    image: LeasedCustomImage,
    workerId: string,
    fields: Record<string, unknown>,
  ): Promise<boolean> {
    const { data, error } = await this.client
      .from(TABLE)
      .update({
        ...fields,
        progress: {},
        checked_at: new Date().toISOString(),
        worker_id: null,
        lease_until: null,
      })
      .eq('id', image.id)
      .eq('organization_id', image.organization_id)
      .eq('status', 'checking')
      .eq('worker_id', workerId)
      .select('id')
      .maybeSingle();

    if (error) {
      this.logger.error(`Failed to save the check of image ${image.id}`, error);
    }

    if (data && (fields.status === 'approved' || fields.status === 'refused')) {
      void this.auditLogs?.logSystemAction(
        image.organization_id,
        'test_automation_user_image',
        image.id,
        'update',
        {
          action: fields.status === 'approved' ? 'scan_passed' : 'scan_refused',
          status: fields.status,
          error_code: fields.error_code ?? null,
        },
      );
    }

    if (data && fields.status === 'approved' && this.onApproved) {
      await this.onApproved(image).catch((err: unknown) =>
        this.logger.warn(
          `Approval notice for image ${image.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }

    return Boolean(data);
  }

  /** Shows how far the check is; at most every 2 seconds, and never needed for the check itself. */
  private async report(
    image: LeasedCustomImage,
    workerId: string,
    progress: CheckProgress,
    now = false,
  ): Promise<void> {
    this.lastProgress = progress;

    if (!now && Date.now() - this.lastProgressAt < PROGRESS_EVERY_MS) return;

    this.lastProgressAt = Date.now();

    try {
      await this.client
        .from(TABLE)
        .update({ progress: { ...progress, log: [...this.logLines] } })
        .eq('id', image.id)
        .eq('organization_id', image.organization_id)
        .eq('status', 'checking')
        .eq('worker_id', workerId);
    } catch {
      // Progress is only shown; the check goes on without it.
    }
  }

  /** Runs the scanner with its log lines going to the check's log. */
  private async runScan(
    image: LeasedCustomImage,
    workerId: string,
    signal: AbortSignal,
    ref = image.run_ref,
    savedIn?: string,
  ): Promise<ScanResult | null> {
    if (!this.scan) return null;

    const lines = this.lineReader();
    const onOutput = (chunk: Buffer) => {
      lines.push(chunk);

      if (this.lastProgress) {
        void this.report(image, workerId, this.lastProgress);
      }
    };
    const result = savedIn
      ? await this.scan(ref, signal, onOutput, savedIn)
      : await this.scan(ref, signal, onOutput);

    lines.flush();
    this.log('Security check finished');

    return result;
  }

  /** Adds a line to the check's log with the time; only the newest lines are kept. */
  private log(text: string): void {
    const time = new Date().toISOString().slice(11, 19);
    const line = stripIllegalXml(text.replace(COLOUR_CODES, '')).trim();

    if (!line) return;

    this.logLines.push(`${time} ${line}`.slice(0, LOG_LINE_LENGTH));

    if (this.logLines.length > LOG_LINES) {
      this.logLines.splice(0, this.logLines.length - LOG_LINES);
    }
  }

  /** Splits a program's output into whole lines for the log, keeping a line that isn't finished yet. */
  private lineReader(): { push: (chunk: Buffer) => void; flush: () => void } {
    let rest = '';

    return {
      push: (chunk) => {
        const parts = (rest + chunk.toString('utf8')).split(/\r?\n|\r/);

        rest = parts.pop() ?? '';
        parts.forEach((part) => this.log(part));
      },
      flush: () => {
        this.log(rest);
        rest = '';
      },
    };
  }

  /** Gives the image back without using up one of its tries; it waits a while so the next images get their turn. */
  private async handBack(
    image: LeasedCustomImage,
    workerId: string,
  ): Promise<void> {
    await this.client
      .from(TABLE)
      .update({
        attempts: Math.max((image.attempts ?? 1) - 1, 0),
        worker_id: null,
        lease_until: new Date(Date.now() + RETRY_AFTER_MS).toISOString(),
        progress: {},
      })
      .eq('id', image.id)
      .eq('organization_id', image.organization_id)
      .eq('status', 'checking')
      .eq('worker_id', workerId);
  }

  private async tryLater(
    image: LeasedCustomImage,
    workerId: string,
  ): Promise<void> {
    await this.client
      .from(TABLE)
      .update({
        lease_until: new Date(Date.now() + RETRY_AFTER_MS).toISOString(),
        progress: {},
      })
      .eq('id', image.id)
      .eq('organization_id', image.organization_id)
      .eq('status', 'checking')
      .eq('worker_id', workerId);
  }

  /** Removes a download of this runner unless another image row, of any organisation, still uses it. */
  private async removeDownloaded(
    image: Pick<LeasedCustomImage, 'id' | 'organization_id' | 'run_ref'> &
      Partial<Pick<LeasedCustomImage, 'registry' | 'digest'>>,
  ): Promise<void> {
    // An uploaded image runs under a name made from its digest, which rows of other organisations share.
    const upload = image.registry === UPLOAD_REGISTRY && Boolean(image.digest);
    const ref = upload ? uploadRunTag(image.digest ?? '') : image.run_ref;
    const [column, value] = upload
      ? ['digest', image.digest]
      : ['run_ref', image.run_ref];

    if (ref) {
      const { count, error } = await this.client
        .from(TABLE)
        .select('id', { count: 'exact', head: true })
        .eq(column, value)
        .neq('id', image.id)
        .not('status', 'in', DONE_STATUSES);

      // Unknown means in use; the next sweep tries again.
      if (error) return;

      if ((count ?? 0) === 0) {
        await this.docker.removeImage(ref);

        // An old schema 1 image runs under the name of its converted copy.
        if (!upload) await this.removeConverted(ref);
      } else {
        // The rows still using it take over the clean-up, so it goes once the last of them may no longer run.
        await this.client
          .from(TABLE)
          .update({ pulled_by_runner: true })
          .eq(column, value)
          .neq('id', image.id)
          .not('status', 'in', DONE_STATUSES);
      }
    }

    await this.client
      .from(TABLE)
      .update({ pulled_by_runner: false })
      .eq('id', image.id)
      .eq('organization_id', image.organization_id);
  }

  /** The converted copy of an old schema 1 image, named after the digest in its address. */
  private async removeConverted(runRef: string): Promise<void> {
    let tag: string;

    try {
      tag = uploadRunTag(runRef.slice(runRef.lastIndexOf('@') + 1));
    } catch {
      return;
    }

    if (await this.docker.imagePresent(tag)) {
      await this.docker.removeImage(tag);
    }
  }
}
