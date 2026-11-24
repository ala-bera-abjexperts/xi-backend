import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import type { AuditLogsService } from '../../../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../../../auth/interfaces/request-user.interface';
import { assertPublicHttpUrl } from '../../../../common/security/ssrf-guard';
import type { PermissionsService } from '../../../../permissions/permissions.service';
import type { SupabaseAdminService } from '../../../../supabase/supabase-admin.service';
import type { TestManagementAccessService } from '../../../access/test-management-access.service';
import type { TesterEligibilityService } from '../../../common/tester-eligibility.service';
import {
  CreateTestAutomationConfigDto,
  UpdateTestAutomationConfigDto,
  type StartTestAutomationRunDto,
} from '../../../dto/test-automation.dto';
import type { TestExecutionsService } from '../../../executions/test-executions.service';
import type { TestRunsService } from '../../../runs/test-runs.service';
import type { TestAutomationCiWatcherService } from '../../test-automation-ci-watcher.service';
import type { TestAutomationCiService } from '../../test-automation-ci.service';
import {
  TestAutomationConfigsService,
  type TestAutomationConfigRow,
} from '../../test-automation-configs.service';
import type { TestAutomationGitService } from '../../test-automation-git.service';
import { TestAutomationRunsService } from '../../test-automation-runs.service';
import type {
  CustomImageRow,
  TestAutomationCustomImagesService,
} from '../../test-automation-custom-images.service';

jest.mock('../../../../common/security/ssrf-guard', () => ({
  assertPublicHttpUrl: jest.fn(),
  isBlockedAddress: jest.fn(),
}));

const ORG = 'org-1';
const SPACE = 'space-1';
const CONFIG = 'config-1';
const IMAGE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const RUN_REF = `ghcr.io/team/tests@sha256:${'b'.repeat(64)}`;
const SERVER_IMAGE = `mcr.example.com/pw@sha256:${'a'.repeat(64)}`;
const user = { userId: 'user-1', organizationId: ORG } as RequestUser;

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
    'is',
    'not',
    'or',
    'order',
    'limit',
    'insert',
    'update',
    'single',
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

function setting(
  overrides: Partial<TestAutomationConfigRow> = {},
): TestAutomationConfigRow {
  return {
    id: CONFIG,
    name: 'Own image tests',
    kind: 'docker',
    preset: 'custom',
    image_key: 'own-image',
    source: 'zip',
    repo_url: null,
    repo_ref: null,
    work_dir: null,
    zip_path: 'setting.zip',
    command: 'pytest -q',
    result_paths: ['results.xml'],
    env: {},
    secrets_enc: null,
    allowed_hosts: [],
    create_unmatched: false,
    timeout_minutes: 30,
    trace_mode: 'off',
    ci_url: null,
    ci_method: null,
    ci_headers_enc: null,
    ci_body_template: null,
    archived_at: null,
    created_at: '2026-11-02T00:00:00Z',
    updated_at: '2026-11-02T00:00:00Z',
    ...overrides,
  };
}

function image(overrides: Partial<CustomImageRow> = {}): CustomImageRow {
  return {
    id: IMAGE_ID,
    image_ref: RUN_REF,
    run_ref: RUN_REF,
    registry: 'ghcr.io',
    repository: 'team/tests',
    digest: `sha256:${'b'.repeat(64)}`,
    platform: 'linux/amd64',
    language: 'python',
    test_framework: 'pytest',
    size_bytes: 1000,
    status: 'approved',
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

describe('custom images in runner settings and runs', () => {
  const savedEnv = {
    images: process.env.TM_RUNNER_IMAGES,
    enabled: process.env.TM_RUNNER_ENABLED,
  };
  let from: jest.Mock;
  let customImages: {
    enabled: jest.Mock;
    findById: jest.Mock;
    linkedImageId: jest.Mock;
    runnableImage: jest.Mock;
  };

  const next = (resolved: Resolved): Chain => {
    const chain = chainOf(resolved);

    from.mockReturnValueOnce(chain);

    return chain;
  };

  const refusal = async (run: Promise<unknown>) => {
    const error: unknown = await run.then(
      () => {
        throw new Error('Expected the call to be refused');
      },
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(BadRequestException);

    return (error as BadRequestException).getResponse() as Record<
      string,
      unknown
    >;
  };

  beforeAll(() => {
    process.env.TM_RUNNER_IMAGES = JSON.stringify({
      playwright: SERVER_IMAGE,
    });
  });

  afterAll(() => {
    if (savedEnv.images === undefined) delete process.env.TM_RUNNER_IMAGES;
    else process.env.TM_RUNNER_IMAGES = savedEnv.images;

    if (savedEnv.enabled === undefined) delete process.env.TM_RUNNER_ENABLED;
    else process.env.TM_RUNNER_ENABLED = savedEnv.enabled;
  });

  beforeEach(() => {
    process.env.TM_RUNNER_ENABLED = '1';
    (assertPublicHttpUrl as jest.Mock).mockResolvedValue(undefined);
    from = jest.fn();
    customImages = {
      enabled: jest.fn().mockResolvedValue(true),
      findById: jest.fn().mockResolvedValue(image({ status: 'needs_admin' })),
      linkedImageId: jest.fn().mockResolvedValue(IMAGE_ID),
      runnableImage: jest.fn().mockResolvedValue(image()),
    };
  });

  it('accepts a link, or no link, in the setting body', async () => {
    const errorsOf = async (body: Record<string, unknown>) =>
      validate(plainToInstance(UpdateTestAutomationConfigDto, body));

    await expect(errorsOf({ user_image_id: IMAGE_ID })).resolves.toEqual([]);
    await expect(errorsOf({ user_image_id: null })).resolves.toEqual([]);
    await expect(
      errorsOf({ user_image_id: 'not-an-id' }),
    ).resolves.toHaveLength(1);
    await expect(
      validate(
        plainToInstance(CreateTestAutomationConfigDto, {
          name: 'A',
          user_image_id: IMAGE_ID,
        }),
      ),
    ).resolves.toEqual([]);
  });

  describe('settings', () => {
    const build = (images?: TestAutomationCustomImagesService) =>
      new TestAutomationConfigsService(
        { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
        {
          assertAvailable: jest.fn().mockResolvedValue(undefined),
        } as unknown as TestManagementAccessService,
        { logActionForRequest: jest.fn() } as unknown as AuditLogsService,
        {
          hasSpacePermission: jest.fn().mockResolvedValue(true),
        } as unknown as PermissionsService,
        {} as unknown as TestAutomationGitService,
        undefined,
        images,
      );

    const create = (
      service: TestAutomationConfigsService,
      body: Partial<CreateTestAutomationConfigDto> = {},
    ) =>
      service.create(user, SPACE, {
        name: 'Own image tests',
        kind: 'docker',
        preset: 'custom',
        image_key: 'own-image',
        user_image_id: IMAGE_ID,
        source: 'zip',
        command: 'pytest -q',
        result_paths: ['results.xml'],
        ...body,
      });

    it('saves a checked custom image without asking for a server image', async () => {
      const service = build(
        customImages as unknown as TestAutomationCustomImagesService,
      );
      const inserted = next({ data: setting(), error: null });

      await create(service);

      expect(firstArg(inserted.insert)).toMatchObject({
        image_key: 'own-image',
        user_image_id: IMAGE_ID,
        preset: 'custom',
      });
      expect(customImages.findById).toHaveBeenCalledWith(ORG, IMAGE_ID);
    });

    it('refuses a custom image when the custom image service is missing', async () => {
      const response = await refusal(create(build()));

      expect(response).toMatchObject({ field: 'image_key' });
      expect(from).not.toHaveBeenCalled();
    });

    it('refuses a custom image for any framework but Custom', async () => {
      const service = build(
        customImages as unknown as TestAutomationCustomImagesService,
      );

      await expect(
        refusal(create(service, { preset: 'pytest' })),
      ).resolves.toMatchObject({ field: 'preset' });
    });

    it('refuses a refused image', async () => {
      customImages.findById.mockResolvedValue(image({ status: 'refused' }));

      const service = build(
        customImages as unknown as TestAutomationCustomImagesService,
      );

      await expect(refusal(create(service))).resolves.toMatchObject({
        field: 'user_image_id',
        message: 'This image was refused',
      });
    });

    it('keeps the link and skips its status when other fields change', async () => {
      customImages.findById.mockResolvedValue(image({ status: 'blocked' }));

      const service = build(
        customImages as unknown as TestAutomationCustomImagesService,
      );

      next({ data: setting(), error: null });

      const updated = next({
        data: setting({ timeout_minutes: 10 }),
        error: null,
      });

      await service.update(user, SPACE, CONFIG, { timeout_minutes: 10 });

      expect(firstArg(updated.update)).not.toHaveProperty('user_image_id');
      expect(customImages.linkedImageId).toHaveBeenCalledWith(ORG, CONFIG);
      expect(customImages.findById).not.toHaveBeenCalled();
    });

    it('swaps to another image only after checking it', async () => {
      const service = build(
        customImages as unknown as TestAutomationCustomImagesService,
      );

      customImages.findById.mockResolvedValue(
        image({ id: OTHER_ID, status: 'approved' }),
      );
      next({ data: setting(), error: null });

      const updated = next({ data: setting(), error: null });

      await service.update(user, SPACE, CONFIG, { user_image_id: OTHER_ID });

      expect(firstArg(updated.update)).toMatchObject({
        user_image_id: OTHER_ID,
      });
      expect(customImages.findById).toHaveBeenCalledWith(ORG, OTHER_ID);
    });

    it('clears the link when the setting moves to a server image', async () => {
      const service = build(
        customImages as unknown as TestAutomationCustomImagesService,
      );

      next({ data: setting(), error: null });

      const updated = next({
        data: setting({ preset: 'playwright', image_key: 'playwright' }),
        error: null,
      });

      await service.update(user, SPACE, CONFIG, {
        preset: 'playwright',
        image_key: 'playwright',
      });

      expect(firstArg(updated.update)).toMatchObject({
        image_key: 'playwright',
        user_image_id: null,
      });
      expect(customImages.enabled).not.toHaveBeenCalled();
    });

    it('never writes the link for a setting that never used a custom image', async () => {
      const service = build(
        customImages as unknown as TestAutomationCustomImagesService,
      );

      next({
        data: setting({ preset: 'playwright', image_key: 'playwright' }),
        error: null,
      });

      const updated = next({ data: setting(), error: null });

      await service.update(user, SPACE, CONFIG, { timeout_minutes: 10 });

      expect(firstArg(updated.update)).not.toHaveProperty('user_image_id');
      expect(customImages.enabled).not.toHaveBeenCalled();
    });

    it('keeps the link away from a CI job', async () => {
      const service = build(
        customImages as unknown as TestAutomationCustomImagesService,
      );

      await expect(
        refusal(
          service.create(user, SPACE, {
            name: 'Nightly',
            user_image_id: IMAGE_ID,
          }),
        ),
      ).resolves.toMatchObject({ field: 'user_image_id' });
    });
  });

  describe('runs', () => {
    const dto: StartTestAutomationRunDto = {
      config_id: CONFIG,
      target: 'execution',
      target_id: 'execution-1',
      request_id: 'request-1',
    };
    let findRow: jest.Mock;

    const build = (images?: TestAutomationCustomImagesService) =>
      new TestAutomationRunsService(
        {
          getClient: () => ({
            from,
            storage: {
              from: () => ({
                copy: jest.fn().mockResolvedValue({ error: null }),
                remove: jest.fn().mockResolvedValue({ error: null }),
              }),
            },
          }),
        } as unknown as SupabaseAdminService,
        {
          assertAvailable: jest.fn().mockResolvedValue(undefined),
        } as unknown as TestManagementAccessService,
        {
          hasSpacePermission: jest.fn().mockResolvedValue(true),
        } as unknown as PermissionsService,
        { logActionForRequest: jest.fn() } as unknown as AuditLogsService,
        {} as unknown as TestAutomationCiWatcherService,
        { findRow } as unknown as TestAutomationConfigsService,
        {
          findByRequest: jest.fn().mockResolvedValue(null),
          findTarget: jest.fn().mockResolvedValue({
            id: 'execution-1',
            key: 'P-TE1',
            is_archived: false,
          }),
        } as unknown as TestAutomationCiService,
        {} as unknown as TesterEligibilityService,
        {} as unknown as TestExecutionsService,
        {} as unknown as TestRunsService,
        undefined,
        images,
      );

    // The waiting-run count, the same-setting check, then the insert.
    const queueOpen = () => {
      next({ data: null, error: null, count: 0 });
      next({ data: null, error: null, count: 0 });

      return next({
        data: {
          id: 'run-1',
          config_id: CONFIG,
          status: 'QUEUED',
          kind: 'docker',
          target: 'execution',
          execution_id: 'execution-1',
          created_at: '2026-11-02T00:00:00Z',
          result_summary: {},
        },
        error: null,
      });
    };

    beforeEach(() => {
      findRow = jest.fn().mockResolvedValue(setting());
    });

    it('runs an approved custom image and keeps which one in the snapshot', async () => {
      const inserted = queueOpen();

      await build(
        customImages as unknown as TestAutomationCustomImagesService,
      ).start(user, SPACE, dto);

      expect(customImages.runnableImage).toHaveBeenCalledWith(ORG, CONFIG);
      expect(firstArg(inserted.insert).config_snapshot).toMatchObject({
        image_key: 'own-image',
        user_image_id: IMAGE_ID,
        run_ref: RUN_REF,
        platform: 'linux/amd64',
      });
    });

    it('queues nothing while the image may not run', async () => {
      customImages.runnableImage.mockRejectedValue(
        new BadRequestException({ code: 'IMAGE_CHECKING', message: 'wait' }),
      );

      await expect(
        build(
          customImages as unknown as TestAutomationCustomImagesService,
        ).start(user, SPACE, dto),
      ).rejects.toMatchObject({ response: { code: 'IMAGE_CHECKING' } });
      expect(from).not.toHaveBeenCalled();
    });

    it('refuses a custom image when the custom image service is missing', async () => {
      await expect(build().start(user, SPACE, dto)).rejects.toMatchObject({
        response: { code: 'IMAGE_NOT_APPROVED' },
      });
      expect(from).not.toHaveBeenCalled();
    });

    it('adds nothing to the snapshot of a server image run', async () => {
      findRow.mockResolvedValue(
        setting({ preset: 'playwright', image_key: 'playwright' }),
      );

      const inserted = queueOpen();

      await build(
        customImages as unknown as TestAutomationCustomImagesService,
      ).start(user, SPACE, dto);

      const snapshot = firstArg(inserted.insert).config_snapshot as Record<
        string,
        unknown
      >;

      expect(snapshot).not.toHaveProperty('user_image_id');
      expect(snapshot).not.toHaveProperty('run_ref');
      expect(snapshot).not.toHaveProperty('platform');
      expect(customImages.runnableImage).not.toHaveBeenCalled();
    });
  });
});
