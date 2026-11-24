import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';

import type { AuditLogsService } from '../../../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../../../auth/interfaces/request-user.interface';
import type { PermissionsService } from '../../../../permissions/permissions.service';
import type { SupabaseAdminService } from '../../../../supabase/supabase-admin.service';
import type { TestManagementAccessService } from '../../../access/test-management-access.service';
import type { TestAutomationRunnerService } from '../../test-automation-runner.service';
import { DockerHubError, searchDockerHub } from '../docker-hub/docker-hub';
import {
  reviewImageInRegistry,
  UserImageError,
} from '../registry/custom-image-review';
import {
  customImageLink,
  TestAutomationCustomImagesService,
  type CustomImageRow,
} from '../../test-automation-custom-images.service';

jest.mock('../docker-hub/docker-hub', () => ({
  ...jest.requireActual<typeof import('../docker-hub/docker-hub')>(
    '../docker-hub/docker-hub',
  ),
  searchDockerHub: jest.fn(),
}));

jest.mock('../registry/custom-image-review', () => ({
  ...jest.requireActual<typeof import('../registry/custom-image-review')>(
    '../registry/custom-image-review',
  ),
  reviewImageInRegistry: jest.fn(),
}));

const ORG = 'org-1';
const SPACE = 'space-1';
const IMAGE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const REF = `ghcr.io/team/tests@${DIGEST}`;
const user = { userId: 'user-1', organizationId: ORG } as RequestUser;
const review = reviewImageInRegistry as unknown as jest.Mock;

interface Resolved {
  data?: unknown;
  error: { code?: string; message: string } | null;
  count?: number | null;
}

type Chain = Record<string, jest.Mock> & PromiseLike<Resolved>;

function chainOf(resolved: Resolved): Chain {
  const chain = {} as Chain;

  for (const name of [
    'select',
    'eq',
    'in',
    'order',
    'limit',
    'update',
    'upsert',
    'maybeSingle',
  ]) {
    chain[name] = jest.fn(() => chain);
  }

  Object.assign(chain, {
    then: (onFulfilled: (value: Resolved) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled),
  });

  return chain;
}

function firstArg(mock: jest.Mock): Record<string, unknown> {
  return (mock.mock.calls as unknown[][])[0]?.[0] as Record<string, unknown>;
}

function imageRow(overrides: Partial<CustomImageRow> = {}): CustomImageRow {
  return {
    id: IMAGE_ID,
    image_ref: REF,
    run_ref: REF,
    registry: 'ghcr.io',
    repository: 'team/tests',
    digest: DIGEST,
    platform: 'linux/amd64',
    language: 'python',
    test_framework: 'pytest',
    size_bytes: 1000,
    status: 'checking',
    error_code: null,
    findings: [],
    scan: {},
    created_at: '2026-11-17T00:00:00Z',
    checked_at: null,
    approved_at: null,
    blocked_at: null,
    ...overrides,
  };
}

const uploadRow = (overrides: Partial<CustomImageRow> = {}) =>
  imageRow({
    image_ref: `upload@${DIGEST}`,
    run_ref: `xis-tm-upload:${'a'.repeat(64)}`,
    registry: 'upload',
    ...overrides,
  });

const passed = {
  runRef: REF,
  platform: 'linux/amd64',
  language: 'python',
  testFramework: 'pytest',
  hints: { language: null, testFramework: null },
  sizeBytes: 1000,
  findings: [],
};

const ENV_KEYS = [
  'TM_RUNNER_USER_REGISTRIES',
  'TM_RUNNER_ENABLED',
  'TM_RUNNER_IMAGE_UPLOADS',
] as const;

describe('TestAutomationCustomImagesService', () => {
  const savedEnv = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  let from: jest.Mock;
  let chains: Chain[];
  let assertAvailable: jest.Mock;
  let isAdminOrOwner: jest.Mock;
  let acceptsRuns: jest.Mock;
  let autoStart: jest.Mock;
  let log: jest.Mock;
  let service: TestAutomationCustomImagesService;

  // Answers the next database calls in order.
  const answers = (...resolved: Resolved[]) => {
    for (const value of resolved) {
      const chain = chainOf(value);

      chains.push(chain);
      from.mockReturnValueOnce(chain);
    }
  };

  const ok: Resolved = { data: null, error: null };
  const noLinks: Resolved = { data: [], error: null };
  const room: Resolved = { data: null, error: null, count: 0 };

  beforeEach(() => {
    process.env.TM_RUNNER_USER_REGISTRIES = 'ghcr.io';
    process.env.TM_RUNNER_ENABLED = '1';
    delete process.env.TM_RUNNER_IMAGE_UPLOADS;
    chains = [];
    from = jest.fn();
    assertAvailable = jest.fn().mockResolvedValue(undefined);
    isAdminOrOwner = jest.fn().mockResolvedValue(true);
    acceptsRuns = jest.fn().mockResolvedValue('online');
    autoStart = jest.fn().mockResolvedValue('off');
    log = jest.fn().mockResolvedValue(undefined);
    review.mockReset();
    review.mockResolvedValue(passed);

    service = new TestAutomationCustomImagesService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      { assertAvailable } as unknown as TestManagementAccessService,
      { isAdminOrOwner } as unknown as PermissionsService,
      { logActionForRequest: log } as unknown as AuditLogsService,
      { acceptsRuns, autoStart } as unknown as TestAutomationRunnerService,
    );
  });

  afterAll(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('enabled', () => {
    it('is off without allowed registries, without asking the database', async () => {
      delete process.env.TM_RUNNER_USER_REGISTRIES;

      await expect(service.enabled(ORG)).resolves.toBe(false);
      expect(from).not.toHaveBeenCalled();
    });

    it('is off while the table is missing, and on once it exists', async () => {
      answers({ error: { code: '42P01', message: 'missing' } }, ok);

      await expect(service.enabled(ORG)).resolves.toBe(false);
      await expect(service.enabled(ORG)).resolves.toBe(true);
      expect(chains[1].eq).toHaveBeenCalledWith('organization_id', ORG);
    });

    it('reports any other database error instead of switching off', async () => {
      answers({ error: { code: '08006', message: 'connection lost' } });

      await expect(service.enabled(ORG)).rejects.toBeInstanceOf(HttpException);
    });
  });

  describe('settings', () => {
    it('names Docker Hub, uploads and the frameworks only while the feature is on', async () => {
      process.env.TM_RUNNER_USER_REGISTRIES = 'ghcr.io,docker.io';
      process.env.TM_RUNNER_IMAGE_UPLOADS = '1';
      answers(ok);

      const on = await service.settings(user, SPACE);

      expect(on).toMatchObject({
        enabled: true,
        docker_hub_enabled: true,
        uploads_enabled: true,
      });
      expect(on.frameworks).toContainEqual({
        framework: 'pytest',
        language: 'python',
      });
      expect(on.languages).toContainEqual({ value: 'csharp', name: 'C#' });
      expect(assertAvailable).toHaveBeenCalledWith(ORG, SPACE);

      delete process.env.TM_RUNNER_USER_REGISTRIES;
      delete process.env.TM_RUNNER_IMAGE_UPLOADS;

      await expect(service.settings(user, SPACE)).resolves.toEqual({
        enabled: false,
        docker_hub_enabled: false,
        uploads_enabled: false,
        frameworks: [],
        languages: [],
      });
    });
  });

  describe('list', () => {
    it('adds how far the worker is to images still being checked', async () => {
      const progress = { step: 'download', percent: 48, started_at: 'now' };

      answers(
        ok,
        {
          data: [imageRow(), imageRow({ id: 'other', status: 'approved' })],
          error: null,
        },
        noLinks,
        { data: [{ id: IMAGE_ID, progress }], error: null },
      );

      const images = await service.list(user, SPACE);

      expect(images[0]).toMatchObject({ progress });
      expect(images[1]).not.toHaveProperty('progress');
      expect(chains[1].eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(chains[3].eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(chains[3].in).toHaveBeenCalledWith('id', [IMAGE_ID]);
    });

    it('still lists the images when the progress column is not there yet', async () => {
      answers(ok, { data: [imageRow()], error: null }, noLinks, {
        data: null,
        error: { code: '42703', message: 'no column' },
      });

      const images = await service.list(user, SPACE);

      expect(images).toHaveLength(1);
      expect(images[0]).not.toHaveProperty('progress');
    });

    it('lists an uploaded image with the settings of this space that use it', async () => {
      answers(
        ok,
        { data: [uploadRow({ status: 'approved' })], error: null },
        { data: [{ id: 'config-1', user_image_id: IMAGE_ID }], error: null },
      );

      await expect(service.list(user, SPACE)).resolves.toMatchObject([
        { registry: 'upload', config_ids: ['config-1'] },
      ]);
      expect(chains[2].eq).toHaveBeenCalledWith('space_id', SPACE);
      expect(chains[2].eq).toHaveBeenCalledWith('image_key', 'own-image');
    });
  });

  describe('get', () => {
    it('finds nothing of another organisation', async () => {
      answers(ok, ok);

      await expect(service.get(user, SPACE, IMAGE_ID)).rejects.toMatchObject({
        response: { code: 'NOT_FOUND' },
      });
      expect(chains[1].eq).toHaveBeenCalledWith('organization_id', ORG);
    });

    it('adds how far the worker is while the image is being checked', async () => {
      const progress = { step: 'scan', percent: 80, started_at: 'now' };

      answers(ok, { data: imageRow(), error: null }, noLinks, {
        data: [{ id: IMAGE_ID, progress }],
        error: null,
      });

      await expect(service.get(user, SPACE, IMAGE_ID)).resolves.toMatchObject({
        id: IMAGE_ID,
        progress,
      });
      expect(chains[3].in).toHaveBeenCalledWith('id', [IMAGE_ID]);
    });

    it('asks for no progress once the check is done', async () => {
      answers(
        ok,
        { data: imageRow({ status: 'approved' }), error: null },
        noLinks,
      );

      const image = await service.get(user, SPACE, IMAGE_ID);

      expect(image).not.toHaveProperty('progress');
      expect(from).toHaveBeenCalledTimes(3);
    });
  });

  describe('Docker Hub', () => {
    const hubSearch = searchDockerHub as unknown as jest.Mock;

    it('answers only when Docker Hub is an allowed registry', async () => {
      answers(ok);

      const error = await service
        .searchDockerHub(user, SPACE, 'cassandra')
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error).toMatchObject({
        response: { code: 'REGISTRY_NOT_ALLOWED' },
      });
      expect(hubSearch).not.toHaveBeenCalled();
      expect(assertAvailable).toHaveBeenCalledWith(ORG, SPACE, { write: true });
    });

    it('passes the search on, and turns Docker Hub problems into answers', async () => {
      process.env.TM_RUNNER_USER_REGISTRIES = 'ghcr.io,docker.io';
      hubSearch.mockResolvedValueOnce([
        { repository: 'cassandra', official: true, description: '', pulls: 1 },
      ]);
      answers(ok);

      await expect(
        service.searchDockerHub(user, SPACE, 'cassandra'),
      ).resolves.toHaveLength(1);

      hubSearch.mockRejectedValueOnce(
        new DockerHubError('REGISTRY_RATE_LIMITED', 'slow down'),
      );
      answers(ok);

      await expect(
        service.searchDockerHub(user, SPACE, 'cassandra'),
      ).rejects.toMatchObject({ status: 429 });

      hubSearch.mockRejectedValueOnce(
        new DockerHubError('DOCKER_HUB_UNREACHABLE', 'down'),
      );
      answers(ok);

      await expect(
        service.searchDockerHub(user, SPACE, 'cassandra'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('answers 503 when custom images are off', async () => {
      delete process.env.TM_RUNNER_USER_REGISTRIES;

      await expect(
        service.searchDockerHub(user, SPACE, 'cassandra'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('check', () => {
    it('answers 503 when the feature is off', async () => {
      delete process.env.TM_RUNNER_USER_REGISTRIES;

      await expect(service.check(user, SPACE, REF)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('refuses a bad address before asking the registry', async () => {
      answers(ok);

      const error = await service
        .check(user, SPACE, 'ghcr.io/team/tests:latest')
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error).toMatchObject({ response: { code: 'IMAGE_REF_INVALID' } });
      expect(review).not.toHaveBeenCalled();
    });

    it('reuses an image checked before without asking the registry or the runner', async () => {
      acceptsRuns.mockResolvedValue('offline');
      answers(
        ok,
        { data: imageRow({ status: 'approved' }), error: null },
        noLinks,
      );

      await expect(service.check(user, SPACE, REF)).resolves.toMatchObject({
        status: 'approved',
        config_ids: [],
      });
      expect(review).not.toHaveBeenCalled();
      expect(acceptsRuns).not.toHaveBeenCalled();
    });

    it('starts no new check while the runner is switched off on the server', async () => {
      delete process.env.TM_RUNNER_ENABLED;
      answers(ok, ok);

      const error = await service
        .check(user, SPACE, REF)
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(error).toMatchObject({ response: { code: 'RUNNER_OFF' } });
      expect(review).not.toHaveBeenCalled();
      expect(from).toHaveBeenCalledTimes(2);
    });

    it('checks an image while the runner is stopped; it waits until the runner starts', async () => {
      acceptsRuns.mockResolvedValue('offline');
      answers(ok, ok, room, ok, { data: imageRow(), error: null }, noLinks);

      await expect(service.check(user, SPACE, REF)).resolves.toMatchObject({
        status: 'checking',
      });
      expect(acceptsRuns).not.toHaveBeenCalled();
    });

    it('starts the runner for an image left waiting for its check, not for a reused image', async () => {
      answers(
        ok,
        { data: imageRow({ status: 'approved' }), error: null },
        noLinks,
      );

      await service.check(user, SPACE, REF);
      expect(autoStart).not.toHaveBeenCalled();

      answers(ok, ok, room, ok, { data: imageRow(), error: null }, noLinks);

      await expect(service.check(user, SPACE, REF)).resolves.toMatchObject({
        status: 'checking',
      });
      expect(autoStart).toHaveBeenCalledTimes(1);
      expect(autoStart).toHaveBeenCalledWith(user, SPACE);
    });

    it('answers the same when the user may not start the runner', async () => {
      autoStart.mockResolvedValue('forbidden');
      answers(ok, ok, room, ok, { data: imageRow(), error: null }, noLinks);

      await expect(service.check(user, SPACE, REF)).resolves.toMatchObject({
        status: 'checking',
      });
    });

    it('refuses a fourth image waiting for its check', async () => {
      answers(ok, ok, { data: null, error: null, count: 3 });

      const error = await service
        .check(user, SPACE, REF)
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(HttpException);
      expect(error).toMatchObject({ response: { code: 'TOO_MANY_CHECKS' } });
      expect(review).not.toHaveBeenCalled();
    });

    it('keeps a passed image as waiting for the runner, for this organisation only', async () => {
      answers(ok, ok, room, ok, { data: imageRow(), error: null }, noLinks);

      await expect(service.check(user, SPACE, REF)).resolves.toMatchObject({
        status: 'checking',
      });

      const [row, options] = chains[3].upsert.mock.calls[0] as [
        Record<string, unknown>,
        Record<string, unknown>,
      ];

      expect(row).toMatchObject({
        organization_id: ORG,
        image_ref: REF,
        created_by: 'user-1',
        status: 'checking',
        run_ref: REF,
        checked_at: null,
      });
      expect(options).toEqual({
        onConflict: 'organization_id,image_ref',
        ignoreDuplicates: true,
      });
      expect(chains[1].eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(chains[2].eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(log).toHaveBeenCalledWith(
        user,
        'test_automation_user_image',
        IMAGE_ID,
        'create',
        { status: 'checking', image_ref: REF },
      );
    });

    it('asks for the framework of an image without labels and stores nothing', async () => {
      review.mockResolvedValue({
        ...passed,
        language: null,
        testFramework: null,
      });
      answers(ok, ok, room);

      const error = await service
        .check(user, SPACE, REF, { language: 'javascript' })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error).toMatchObject({
        response: {
          code: 'IMAGE_FRAMEWORK_NEEDED',
          data: { field: 'test_framework' },
        },
      });
      expect(chains).toHaveLength(3);
    });

    it('uses the framework the user entered for an image without labels', async () => {
      review.mockResolvedValue({
        ...passed,
        language: null,
        testFramework: null,
      });
      answers(ok, ok, room, ok, { data: imageRow(), error: null }, noLinks);

      await service.check(user, SPACE, REF, {
        language: 'javascript',
        test_framework: 'cypress',
      });

      expect(firstArg(chains[3].upsert)).toMatchObject({
        status: 'checking',
        language: 'javascript',
        test_framework: 'cypress',
      });
    });

    it('checks an image without labels by what its own settings name', async () => {
      review.mockResolvedValue({
        ...passed,
        language: null,
        testFramework: null,
        hints: { language: 'javascript', testFramework: 'cypress' },
      });
      answers(ok, ok, room, ok, { data: imageRow(), error: null }, noLinks);

      await service.check(user, SPACE, REF);

      expect(firstArg(chains[3].upsert)).toMatchObject({
        status: 'checking',
        language: 'javascript',
        test_framework: 'cypress',
      });
    });

    it("never pairs the image's framework with another language the user entered", async () => {
      review.mockResolvedValue({
        ...passed,
        language: null,
        testFramework: null,
        hints: { language: 'javascript', testFramework: 'cypress' },
      });
      answers(ok, ok, room);

      await expect(
        service.check(user, SPACE, REF, { language: 'python' }),
      ).rejects.toMatchObject({
        response: { code: 'IMAGE_FRAMEWORK_NEEDED' },
      });
    });

    it('refuses a framework of another language for an image without labels', async () => {
      review.mockResolvedValue({
        ...passed,
        language: null,
        testFramework: null,
      });
      answers(ok, ok, room);

      await expect(
        service.check(user, SPACE, REF, {
          language: 'python',
          test_framework: 'jest',
        }),
      ).rejects.toMatchObject({
        response: {
          code: 'IMAGE_FRAMEWORK_NEEDED',
          data: { field: 'test_framework' },
        },
      });
      expect(chains).toHaveLength(3);
    });

    it('takes a framework new to this server with any listed language', async () => {
      review.mockResolvedValue({
        ...passed,
        language: null,
        testFramework: null,
      });
      answers(ok, ok, room, ok, { data: imageRow(), error: null }, noLinks);

      await service.check(user, SPACE, REF, {
        language: 'java',
        test_framework: 'junit',
      });

      expect(firstArg(chains[3].upsert)).toMatchObject({
        status: 'checking',
        language: 'java',
        test_framework: 'junit',
      });
    });

    it("ignores a mismatched choice when the image's own labels decide", async () => {
      answers(ok, ok, room, ok, { data: imageRow(), error: null }, noLinks);

      await service.check(user, SPACE, REF, {
        language: 'python',
        test_framework: 'jest',
      });

      expect(firstArg(chains[3].upsert)).toMatchObject({
        language: 'python',
        test_framework: 'pytest',
      });
    });

    it("keeps the image's own labels over what the user entered", async () => {
      answers(ok, ok, room, ok, { data: imageRow(), error: null }, noLinks);

      await service.check(user, SPACE, REF, {
        language: 'javascript',
        test_framework: 'cypress',
      });

      expect(firstArg(chains[3].upsert)).toMatchObject({
        language: 'python',
        test_framework: 'pytest',
      });
    });

    it('stores an image with findings as refused, with every finding', async () => {
      review.mockResolvedValue({
        ...passed,
        findings: [
          { code: 'IMAGE_LABELS_MISSING', detail: 'labels' },
          { code: 'IMAGE_HAS_VOLUMES', detail: '/data' },
        ],
      });
      answers(
        ok,
        ok,
        room,
        ok,
        { data: imageRow({ status: 'refused' }), error: null },
        noLinks,
      );

      await service.check(user, SPACE, REF);

      expect(firstArg(chains[3].upsert)).toMatchObject({
        status: 'refused',
        error_code: 'IMAGE_LABELS_MISSING',
        findings: [
          { code: 'IMAGE_LABELS_MISSING', detail: 'labels' },
          { code: 'IMAGE_HAS_VOLUMES', detail: '/data' },
        ],
      });
      expect(firstArg(chains[3].upsert).checked_at).toEqual(expect.any(String));
    });

    it('stores a lasting registry problem as refused, keeping a reason only when it adds facts', async () => {
      const stored = async (error: UserImageError) => {
        chains = [];
        review.mockRejectedValue(error);
        answers(
          ok,
          ok,
          room,
          ok,
          { data: imageRow({ status: 'refused' }), error: null },
          noLinks,
        );
        await service.check(user, SPACE, REF);

        return firstArg(chains[3].upsert);
      };

      await expect(
        stored(new UserImageError('DIGEST_MISMATCH', 'different content')),
      ).resolves.toMatchObject({
        status: 'refused',
        error_code: 'DIGEST_MISMATCH',
        run_ref: null,
        findings: [{ code: 'DIGEST_MISMATCH', detail: '' }],
      });
      await expect(
        stored(
          new UserImageError(
            'IMAGE_PLATFORM_MISSING',
            'No linux/arm64 version',
          ),
        ),
      ).resolves.toMatchObject({
        findings: [
          { code: 'IMAGE_PLATFORM_MISSING', detail: 'No linux/arm64 version' },
        ],
      });
    });

    it('reports a passing registry problem without keeping a record', async () => {
      review.mockRejectedValue(
        new UserImageError('REGISTRY_RATE_LIMITED', 'try later'),
      );
      answers(ok, ok, room);

      await expect(service.check(user, SPACE, REF)).rejects.toMatchObject({
        response: { code: 'REGISTRY_RATE_LIMITED' },
      });
      expect(from).toHaveBeenCalledTimes(3);
    });

    it('checks a refused image again from the beginning, at the end of the queue', async () => {
      answers(
        ok,
        { data: imageRow({ status: 'refused' }), error: null },
        room,
        { data: imageRow(), error: null },
        noLinks,
      );

      await service.check(user, SPACE, REF);

      const update = firstArg(chains[3].update);

      expect(update).toMatchObject({
        status: 'checking',
        attempts: 0,
        worker_id: null,
        lease_until: null,
        scan: {},
        progress: {},
        checked_at: null,
      });
      expect(Date.parse(String(update.created_at))).toBeGreaterThan(
        Date.parse('2026-11-17T00:00:00Z'),
      );
      expect(chains[3].eq).toHaveBeenCalledWith('status', 'refused');
      expect(chains[3].eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(log).toHaveBeenCalledWith(
        user,
        'test_automation_user_image',
        IMAGE_ID,
        'update',
        expect.anything(),
      );
    });
  });

  describe('approve and block', () => {
    it('lets only an owner or admin decide', async () => {
      isAdminOrOwner.mockResolvedValue(false);
      answers(ok);

      await expect(service.block(user, SPACE, IMAGE_ID)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(from).toHaveBeenCalledTimes(1);
    });

    it('blocks an approved image and frees its check', async () => {
      answers(
        ok,
        { data: imageRow({ status: 'approved' }), error: null },
        { data: imageRow({ status: 'blocked' }), error: null },
        noLinks,
      );

      await service.block(user, SPACE, IMAGE_ID);

      expect(firstArg(chains[2].update)).toMatchObject({
        status: 'blocked',
        blocked_by: 'user-1',
        worker_id: null,
        lease_until: null,
      });
    });

    it('blocks an image from a dropped registry too', async () => {
      answers(
        ok,
        {
          data: imageRow({ status: 'approved', registry: 'quay.io' }),
          error: null,
        },
        { data: imageRow({ status: 'blocked' }), error: null },
        noLinks,
      );

      await expect(service.block(user, SPACE, IMAGE_ID)).resolves.toMatchObject(
        { status: 'blocked' },
      );
    });

    it('does not block an image twice', async () => {
      answers(ok, { data: imageRow({ status: 'blocked' }), error: null });

      await expect(service.block(user, SPACE, IMAGE_ID)).rejects.toMatchObject({
        response: { code: 'IMAGE_NOT_WAITING' },
      });
    });

    it('finds nothing of another organisation', async () => {
      answers(ok, ok);

      await expect(service.block(user, SPACE, IMAGE_ID)).rejects.toMatchObject({
        response: { code: 'NOT_FOUND' },
      });
      expect(chains[1].eq).toHaveBeenCalledWith('organization_id', ORG);
    });
  });

  describe('sharing', () => {
    const privateRow = (createdBy: string) =>
      imageRow({ status: 'approved', shared: false, created_by: createdBy });

    it("hides someone else's private image and never sends who added an image", async () => {
      isAdminOrOwner.mockResolvedValue(false);
      answers(
        ok,
        {
          data: [
            privateRow('user-2'),
            imageRow({
              id: OTHER_ID,
              status: 'approved',
              created_by: 'user-2',
            }),
          ],
          error: null,
        },
        noLinks,
      );

      const images = await service.list(user, SPACE);

      expect(images.map((image) => image.id)).toEqual([OTHER_ID]);
      expect(images[0]).toMatchObject({ mine: false });
      expect(images[0]).not.toHaveProperty('created_by');
    });

    it('shows a private image to whoever added it, without asking for their role', async () => {
      answers(ok, { data: [privateRow('user-1')], error: null }, noLinks);

      await expect(service.list(user, SPACE)).resolves.toMatchObject([
        { id: IMAGE_ID, mine: true, shared: false },
      ]);
      expect(isAdminOrOwner).not.toHaveBeenCalled();
    });

    it('shows a private image to an owner or admin', async () => {
      answers(ok, { data: [privateRow('user-2')], error: null }, noLinks);

      await expect(service.list(user, SPACE)).resolves.toHaveLength(1);
      expect(isAdminOrOwner).toHaveBeenCalledWith('user-1', ORG);
    });

    it('keeps showing a private image that a setting of this space uses', async () => {
      isAdminOrOwner.mockResolvedValue(false);
      answers(
        ok,
        { data: [privateRow('user-2')], error: null },
        { data: [{ id: 'config-1', user_image_id: IMAGE_ID }], error: null },
      );

      await expect(service.list(user, SPACE)).resolves.toMatchObject([
        { id: IMAGE_ID, config_ids: ['config-1'], mine: false },
      ]);
    });

    it("reads someone else's private image as missing when nothing here uses it", async () => {
      isAdminOrOwner.mockResolvedValue(false);
      answers(ok, { data: privateRow('user-2'), error: null }, noLinks);

      await expect(service.get(user, SPACE, IMAGE_ID)).rejects.toMatchObject({
        response: { code: 'NOT_FOUND' },
      });
    });

    it('stores the choice to keep a newly checked image private', async () => {
      answers(ok, ok, room, ok, { data: imageRow(), error: null }, noLinks);

      await service.check(user, SPACE, REF, {}, false);

      expect(firstArg(chains[3].upsert)).toMatchObject({ shared: false });
    });

    it('leaves a newly checked image shared when nothing is asked', async () => {
      answers(ok, ok, room, ok, { data: imageRow(), error: null }, noLinks);

      await service.check(user, SPACE, REF);

      expect(firstArg(chains[3].upsert)).not.toHaveProperty('shared');
    });

    it('lets whoever added an image change who may use it, and records it', async () => {
      answers(ok, { data: privateRow('user-1'), error: null }, ok, noLinks);

      await expect(
        service.setSharing(user, SPACE, IMAGE_ID, true),
      ).resolves.toMatchObject({ id: IMAGE_ID, shared: true, mine: true });
      expect(chains[2].update).toHaveBeenCalledWith({ shared: true });
      expect(chains[2].eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(isAdminOrOwner).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        user,
        'test_automation_user_image',
        IMAGE_ID,
        'update',
        { shared: true },
      );
    });

    it('lets an owner or admin change it for an image someone else added', async () => {
      answers(ok, { data: privateRow('user-2'), error: null }, ok, noLinks);

      await expect(
        service.setSharing(user, SPACE, IMAGE_ID, true),
      ).resolves.toMatchObject({ shared: true, mine: false });
    });

    it("refuses anyone else, and someone else's private image reads as missing", async () => {
      isAdminOrOwner.mockResolvedValue(false);
      answers(ok, {
        data: imageRow({ status: 'approved', created_by: 'user-2' }),
        error: null,
      });

      await expect(
        service.setSharing(user, SPACE, IMAGE_ID, false),
      ).rejects.toMatchObject({ response: { code: 'FORBIDDEN' } });

      answers(ok, { data: privateRow('user-2'), error: null });

      await expect(
        service.setSharing(user, SPACE, IMAGE_ID, true),
      ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
      expect(chains.some((chain) => chain.update.mock.calls.length > 0)).toBe(
        false,
      );
    });
  });

  describe('linkedImageId', () => {
    it('reads no link while the column is missing', async () => {
      answers({ error: { code: '42703', message: 'no column' } });

      await expect(service.linkedImageId(ORG, 'config-1')).resolves.toBeNull();
    });

    it('reads the link of a setting of the same organisation', async () => {
      answers({ data: { user_image_id: IMAGE_ID }, error: null });

      await expect(service.linkedImageId(ORG, 'config-1')).resolves.toBe(
        IMAGE_ID,
      );
      expect(chains[0].eq).toHaveBeenCalledWith('organization_id', ORG);
    });
  });

  describe('runnableImage', () => {
    const linkTo = (row: CustomImageRow | null) =>
      answers(
        ok,
        { data: { user_image_id: IMAGE_ID }, error: null },
        {
          data: row,
          error: null,
        },
      );

    it('hands back an approved image of an allowed registry', async () => {
      linkTo(imageRow({ status: 'approved' }));

      await expect(
        service.runnableImage(ORG, 'config-1'),
      ).resolves.toMatchObject({ id: IMAGE_ID, run_ref: REF });
      expect(chains[2].eq).toHaveBeenCalledWith('organization_id', ORG);
    });

    it('says why an image cannot run yet', async () => {
      linkTo(imageRow({ status: 'checking' }));
      await expect(
        service.runnableImage(ORG, 'config-1'),
      ).rejects.toMatchObject({ response: { code: 'IMAGE_CHECKING' } });

      linkTo(imageRow({ status: 'blocked' }));
      await expect(
        service.runnableImage(ORG, 'config-1'),
      ).rejects.toMatchObject({ response: { code: 'IMAGE_BLOCKED' } });

      linkTo(null);
      await expect(
        service.runnableImage(ORG, 'config-1'),
      ).rejects.toMatchObject({ response: { code: 'IMAGE_NOT_APPROVED' } });
    });

    it('refuses an approved image whose registry is no longer allowed', async () => {
      linkTo(imageRow({ status: 'approved', registry: 'quay.io' }));

      await expect(
        service.runnableImage(ORG, 'config-1'),
      ).rejects.toMatchObject({ response: { code: 'REGISTRY_NOT_ALLOWED' } });
    });

    it('runs an approved uploaded image only while uploads are allowed', async () => {
      linkTo(uploadRow({ status: 'approved' }));
      await expect(
        service.runnableImage(ORG, 'config-1'),
      ).rejects.toMatchObject({ response: { code: 'REGISTRY_NOT_ALLOWED' } });

      process.env.TM_RUNNER_IMAGE_UPLOADS = '1';
      linkTo(uploadRow({ status: 'approved' }));
      await expect(
        service.runnableImage(ORG, 'config-1'),
      ).resolves.toMatchObject({ registry: 'upload' });
    });

    it('runs nothing while the feature is off', async () => {
      delete process.env.TM_RUNNER_USER_REGISTRIES;

      await expect(
        service.runnableImage(ORG, 'config-1'),
      ).rejects.toMatchObject({ response: { code: 'IMAGE_NOT_APPROVED' } });
      expect(from).not.toHaveBeenCalled();
    });
  });

  describe('customImageLink', () => {
    const current = (image_key: string) => ({ id: 'config-1', image_key });
    const link = (
      change: Partial<Parameters<typeof customImageLink>[2]>,
      images: TestAutomationCustomImagesService | null = service,
    ) =>
      customImageLink(images ?? undefined, ORG, {
        requested: undefined,
        preset: 'custom',
        imageKey: 'own-image',
        current: null,
        ...change,
      });

    it('leaves the link alone for a server image, and clears it when leaving a custom image', async () => {
      await expect(
        link({ imageKey: 'node-20', current: current('node-20') }),
      ).resolves.toBeUndefined();
      await expect(
        link({ imageKey: 'node-20', current: current('own-image') }),
      ).resolves.toBeNull();
      await expect(
        link({
          preset: 'auto',
          imageKey: 'auto',
          current: current('own-image'),
        }),
      ).resolves.toBeNull();
      await expect(
        link({ imageKey: 'node-20', requested: null }),
      ).resolves.toBeUndefined();
      expect(from).not.toHaveBeenCalled();
    });

    it('refuses a link on a setting with a server image', async () => {
      await expect(
        link({ imageKey: 'node-20', requested: IMAGE_ID }),
      ).rejects.toMatchObject({
        response: { code: 'VALIDATION_FAILED', field: 'user_image_id' },
      });
    });

    it('uses a custom image only with the Custom framework', async () => {
      await expect(link({ preset: 'node-test' })).rejects.toMatchObject({
        response: { field: 'preset' },
      });
    });

    it('refuses a custom image while the feature is off or not built in', async () => {
      await expect(link({ requested: IMAGE_ID }, null)).rejects.toMatchObject({
        response: { field: 'image_key' },
      });

      delete process.env.TM_RUNNER_USER_REGISTRIES;

      await expect(link({ requested: IMAGE_ID })).rejects.toMatchObject({
        response: { field: 'image_key' },
      });
    });

    it('needs a checked image', async () => {
      answers(ok, ok);
      await expect(link({ requested: IMAGE_ID })).rejects.toMatchObject({
        response: { field: 'user_image_id', message: 'Check your image first' },
      });

      answers(ok);
      await expect(link({ requested: null })).rejects.toMatchObject({
        response: { field: 'user_image_id' },
      });
    });

    it('links a new image of this organisation unless it was refused or blocked', async () => {
      answers(ok, { data: imageRow({ status: 'needs_admin' }), error: null });
      await expect(link({ requested: IMAGE_ID })).resolves.toBe(IMAGE_ID);
      expect(chains[1].eq).toHaveBeenCalledWith('organization_id', ORG);

      answers(ok, { data: imageRow({ status: 'refused' }), error: null });
      await expect(link({ requested: IMAGE_ID })).rejects.toMatchObject({
        response: { message: 'This image was refused' },
      });

      answers(ok, { data: imageRow({ status: 'blocked' }), error: null });
      await expect(link({ requested: IMAGE_ID })).rejects.toMatchObject({
        response: { message: 'This image is blocked' },
      });
    });

    it('keeps the saved image without checking it again, so other fields stay editable', async () => {
      answers(ok, { data: { user_image_id: IMAGE_ID }, error: null });
      await expect(
        link({ current: current('own-image') }),
      ).resolves.toBeUndefined();

      answers(ok, { data: { user_image_id: IMAGE_ID }, error: null });
      await expect(
        link({ current: current('own-image'), requested: IMAGE_ID }),
      ).resolves.toBeUndefined();
      expect(from).toHaveBeenCalledTimes(4);
    });

    it('checks a different image when the saved one is swapped', async () => {
      answers(
        ok,
        { data: { user_image_id: IMAGE_ID }, error: null },
        { data: imageRow({ id: OTHER_ID, status: 'blocked' }), error: null },
      );

      await expect(
        link({ current: current('own-image'), requested: OTHER_ID }),
      ).rejects.toMatchObject({
        response: { message: 'This image is blocked' },
      });
    });
  });
});
