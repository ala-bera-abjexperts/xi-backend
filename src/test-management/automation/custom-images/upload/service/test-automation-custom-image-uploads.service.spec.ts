import {
  BadRequestException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';

import type { AuditLogsService } from '../../../../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../../../../auth/interfaces/request-user.interface';
import type { SupabaseAdminService } from '../../../../../supabase/supabase-admin.service';
import type { TestManagementAccessService } from '../../../../access/test-management-access.service';
import type {
  CustomImageRow,
  TestAutomationCustomImagesService,
} from '../../../test-automation-custom-images.service';
import {
  TestAutomationCustomImageUploadsService,
  uploadRepository,
  type StartImageUpload,
} from './test-automation-custom-image-uploads.service';

const ORG = 'org-1';
const SPACE = 'space-1';
const HEX = 'a'.repeat(64);
const DIGEST = `sha256:${HEX}`;
const IMAGE_REF = `upload/image@${DIGEST}`;
const PATH = `${ORG}/${HEX}`;
const user = { userId: 'user-1', organizationId: ORG } as RequestUser;

function row(overrides: Partial<CustomImageRow> = {}): CustomImageRow {
  return {
    id: 'image-1',
    image_ref: IMAGE_REF,
    run_ref: null,
    registry: 'upload',
    repository: 'tests',
    digest: DIGEST,
    platform: 'linux/amd64',
    language: 'python',
    test_framework: 'pytest',
    size_bytes: 1000,
    status: 'checking',
    error_code: null,
    findings: [],
    scan: {},
    created_at: '2026-11-18T00:00:00Z',
    checked_at: null,
    approved_at: null,
    blocked_at: null,
    ...overrides,
  };
}

const start = (
  overrides: Partial<StartImageUpload> = {},
): StartImageUpload => ({
  file_name: 'My Tests.tar.gz',
  file_bytes: 1000,
  config_digest: DIGEST,
  platform: 'linux/amd64',
  gzip: true,
  language: 'python',
  test_framework: 'pytest',
  ...overrides,
});

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return {
      status: (error as HttpException).getStatus(),
      ...((error as HttpException).getResponse() as Record<string, unknown>),
    };
  }

  throw new Error('Expected a refusal');
};

describe('TestAutomationCustomImageUploadsService', () => {
  const saved = {
    uploads: process.env.TM_RUNNER_IMAGE_UPLOADS,
    platform: process.env.TM_RUNNER_PLATFORM,
    max: process.env.TM_RUNNER_USER_IMAGE_MAX_GB,
    supabase: process.env.SUPABASE_URL,
  };
  let images: Record<string, jest.Mock>;
  let bucket: Record<string, jest.Mock>;
  let storageFrom: jest.Mock;
  let log: jest.Mock;
  let assertAvailable: jest.Mock;
  let service: TestAutomationCustomImageUploadsService;

  beforeEach(() => {
    process.env.TM_RUNNER_IMAGE_UPLOADS = '1';
    process.env.TM_RUNNER_PLATFORM = 'linux/amd64';
    process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
    delete process.env.TM_RUNNER_USER_IMAGE_MAX_GB;
    images = {
      enabled: jest.fn().mockResolvedValue(true),
      findByRef: jest.fn().mockResolvedValue(null),
      withLinks: jest.fn(
        (_org: string, _space: string, image: CustomImageRow) =>
          Promise.resolve({ ...image, config_ids: [] }),
      ),
      askApproval: jest.fn(),
      assertRunnerTakesWork: jest.fn().mockResolvedValue(undefined),
      assertRoomToCheck: jest.fn().mockResolvedValue(undefined),
      insert: jest.fn().mockResolvedValue(row()),
      checkAgain: jest.fn().mockResolvedValue(row()),
    };
    bucket = {
      remove: jest.fn().mockResolvedValue({ data: [], error: null }),
      createSignedUploadUrl: jest.fn().mockResolvedValue({
        data: {
          signedUrl: `http://127.0.0.1:54321/storage/v1/object/upload/sign/test-automation-images/${PATH}?token=t`,
          token: 't',
          path: PATH,
        },
        error: null,
      }),
      list: jest.fn().mockResolvedValue({
        data: [{ name: HEX, id: 'file-1', metadata: { size: 1000 } }],
        error: null,
      }),
    };
    storageFrom = jest.fn(() => bucket);
    log = jest.fn().mockResolvedValue(undefined);
    assertAvailable = jest.fn().mockResolvedValue(undefined);
    service = new TestAutomationCustomImageUploadsService(
      {
        getClient: () => ({ storage: { from: storageFrom } }),
      } as unknown as SupabaseAdminService,
      { assertAvailable } as unknown as TestManagementAccessService,
      { logActionForRequest: log } as unknown as AuditLogsService,
      images as unknown as TestAutomationCustomImagesService,
    );
  });

  afterAll(() => {
    for (const [name, value] of [
      ['TM_RUNNER_IMAGE_UPLOADS', saved.uploads],
      ['TM_RUNNER_PLATFORM', saved.platform],
      ['TM_RUNNER_USER_IMAGE_MAX_GB', saved.max],
      ['SUPABASE_URL', saved.supabase],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  describe('start', () => {
    it('hands out an upload address after removing an old file at the same place', async () => {
      await expect(service.start(user, SPACE, start())).resolves.toEqual({
        reused: false,
        upload: {
          url: `/storage/v1/object/upload/sign/test-automation-images/${PATH}?token=t`,
          expires_in: 7200,
        },
      });
      expect(assertAvailable).toHaveBeenCalledWith(ORG, SPACE, { write: true });
      expect(images.findByRef).toHaveBeenCalledWith(ORG, IMAGE_REF);
      expect(storageFrom).toHaveBeenCalledWith('test-automation-images');
      expect(bucket.remove).toHaveBeenCalledWith([PATH]);
      expect(bucket.createSignedUploadUrl).toHaveBeenCalledWith(PATH, {
        upsert: false,
      });
      expect(bucket.remove.mock.invocationCallOrder[0]).toBeLessThan(
        bucket.createSignedUploadUrl.mock.invocationCallOrder[0],
      );
      expect(images.assertRunnerTakesWork).toHaveBeenCalled();
      expect(images.assertRoomToCheck).toHaveBeenCalledWith(ORG);
    });

    it('reuses an image the organisation already has unless it was refused', async () => {
      images.findByRef.mockResolvedValueOnce(row({ status: 'blocked' }));

      await expect(service.start(user, SPACE, start())).resolves.toMatchObject({
        reused: true,
        image: { id: 'image-1', status: 'blocked', config_ids: [] },
      });
      expect(bucket.createSignedUploadUrl).not.toHaveBeenCalled();

      images.findByRef.mockResolvedValueOnce(row({ status: 'refused' }));

      await expect(service.start(user, SPACE, start())).resolves.toMatchObject({
        reused: false,
      });
      expect(bucket.remove).toHaveBeenCalledWith([PATH]);
    });

    it('is not available while uploads are off, the table or the bucket is missing', async () => {
      delete process.env.TM_RUNNER_IMAGE_UPLOADS;
      await expect(
        codeOf(service.start(user, SPACE, start())),
      ).resolves.toMatchObject({ status: 503, code: 'UPLOADS_NOT_AVAILABLE' });

      process.env.TM_RUNNER_IMAGE_UPLOADS = '1';
      images.enabled.mockResolvedValueOnce(false);
      await expect(
        codeOf(service.start(user, SPACE, start())),
      ).resolves.toMatchObject({ status: 503, code: 'UPLOADS_NOT_AVAILABLE' });

      bucket.remove.mockResolvedValueOnce({
        data: null,
        error: { message: 'Bucket not found' },
      });
      await expect(
        codeOf(service.start(user, SPACE, start())),
      ).resolves.toMatchObject({ status: 503, code: 'UPLOADS_NOT_AVAILABLE' });
    });

    it('refuses a bad digest, a file too large and another platform', async () => {
      await expect(
        codeOf(
          service.start(user, SPACE, start({ config_digest: 'sha256:abc' })),
        ),
      ).resolves.toMatchObject({ status: 400, code: 'IMAGE_REF_INVALID' });

      process.env.TM_RUNNER_USER_IMAGE_MAX_GB = '1';
      await expect(
        codeOf(
          service.start(user, SPACE, start({ file_bytes: 1024 ** 3 + 1 })),
        ),
      ).resolves.toMatchObject({
        status: 400,
        code: 'IMAGE_TOO_LARGE',
        data: { max_bytes: 1024 ** 3 },
      });

      await expect(
        codeOf(service.start(user, SPACE, start({ platform: 'linux/arm64' }))),
      ).resolves.toMatchObject({ status: 400, code: 'IMAGE_WRONG_PLATFORM' });
      await expect(
        service.start(user, SPACE, start({ platform: 'linux/amd64/v1' })),
      ).resolves.toMatchObject({ reused: false });
      expect(images.findByRef).not.toHaveBeenCalledWith(ORG, 'sha256:abc');
    });

    it('asks for the language and framework of an image without labels', async () => {
      await expect(
        codeOf(
          service.start(
            user,
            SPACE,
            start({ language: undefined, test_framework: 'cypress' }),
          ),
        ),
      ).resolves.toMatchObject({
        status: 400,
        code: 'IMAGE_FRAMEWORK_NEEDED',
        data: {
          field: 'language',
          suggested: { language: 'javascript', test_framework: 'cypress' },
        },
      });
      expect(bucket.createSignedUploadUrl).not.toHaveBeenCalled();
    });

    it('refuses a framework of another language', async () => {
      await expect(
        codeOf(
          service.start(
            user,
            SPACE,
            start({ language: 'ruby', test_framework: 'pytest' }),
          ),
        ),
      ).resolves.toMatchObject({
        status: 400,
        code: 'IMAGE_FRAMEWORK_NEEDED',
        data: { field: 'test_framework' },
      });
      expect(bucket.createSignedUploadUrl).not.toHaveBeenCalled();
    });

    it("lets the file's own labels win over the user's choice", async () => {
      await expect(
        service.start(
          user,
          SPACE,
          start({
            language: 'ruby',
            test_framework: 'pytest',
            image_language: 'java',
            image_test_framework: 'junit',
          }),
        ),
      ).resolves.toMatchObject({ reused: false });
    });

    it('asks for both only when neither labels nor the user give them', async () => {
      await expect(
        codeOf(
          service.start(
            user,
            SPACE,
            start({ language: undefined, test_framework: undefined }),
          ),
        ),
      ).resolves.toMatchObject({
        status: 400,
        code: 'IMAGE_FRAMEWORK_NEEDED',
        data: { field: 'language' },
      });
    });

    it('keeps the rules of a check: runner on and room in the queue', async () => {
      images.assertRunnerTakesWork.mockRejectedValueOnce(
        new ServiceUnavailableException({ code: 'RUNNER_OFF' }),
      );
      await expect(
        codeOf(service.start(user, SPACE, start())),
      ).resolves.toMatchObject({ status: 503, code: 'RUNNER_OFF' });
      expect(bucket.createSignedUploadUrl).not.toHaveBeenCalled();
    });
  });

  describe('complete', () => {
    const finish = {
      config_digest: DIGEST,
      file_name: 'My Tests.tar.gz',
      gzip: true,
      language: 'python',
      test_framework: 'pytest',
    };

    it('records the uploaded image for its check', async () => {
      await expect(
        service.complete(user, SPACE, finish),
      ).resolves.toMatchObject({
        id: 'image-1',
        status: 'checking',
        config_ids: [],
      });
      expect(bucket.list).toHaveBeenCalledWith(ORG, { limit: 1, search: HEX });
      expect(images.insert).toHaveBeenCalledWith(
        user,
        {
          registry: 'upload',
          repository: 'my-tests',
          digest: DIGEST,
          imageRef: IMAGE_REF,
        },
        {
          status: 'checking',
          error_code: null,
          findings: [],
          run_ref: null,
          platform: 'linux/amd64',
          language: 'python',
          test_framework: 'pytest',
          size_bytes: 1000,
        },
        undefined,
      );
      expect(log).toHaveBeenCalledWith(
        user,
        'test_automation_user_image',
        'image-1',
        'create',
        expect.objectContaining({ uploaded: true }),
      );
    });

    it('checks a refused image again, and returns one already checking as it is', async () => {
      const refused = row({ status: 'refused' });

      images.findByRef.mockResolvedValueOnce(refused);
      await service.complete(user, SPACE, finish);
      expect(images.checkAgain).toHaveBeenCalledWith(
        ORG,
        refused,
        expect.objectContaining({ status: 'checking', size_bytes: 1000 }),
      );

      images.findByRef.mockResolvedValueOnce(row());
      bucket.list.mockClear();
      await expect(
        service.complete(user, SPACE, finish),
      ).resolves.toMatchObject({
        status: 'checking',
      });
      expect(bucket.list).not.toHaveBeenCalled();
      expect(images.insert).not.toHaveBeenCalled();
    });

    it('refuses a missing file, and removes one that is too large', async () => {
      bucket.list.mockResolvedValueOnce({ data: [], error: null });
      await expect(
        codeOf(service.complete(user, SPACE, finish)),
      ).resolves.toMatchObject({ status: 400, code: 'UPLOAD_MISSING' });
      expect(bucket.remove).not.toHaveBeenCalled();

      process.env.TM_RUNNER_USER_IMAGE_MAX_GB = '1';
      bucket.list.mockResolvedValueOnce({
        data: [{ name: HEX, id: 'file-1', metadata: { size: 1024 ** 3 + 1 } }],
        error: null,
      });
      await expect(
        codeOf(service.complete(user, SPACE, finish)),
      ).resolves.toMatchObject({ status: 400, code: 'IMAGE_TOO_LARGE' });
      expect(bucket.remove).toHaveBeenCalledWith([PATH]);
      expect(images.insert).not.toHaveBeenCalled();
    });

    it('records the labels of the file, even for a framework the worker must judge', async () => {
      await service.complete(user, SPACE, {
        ...finish,
        image_language: 'java',
        image_test_framework: 'junit',
      });

      expect(images.insert).toHaveBeenCalledWith(
        user,
        expect.anything(),
        expect.objectContaining({
          status: 'checking',
          language: 'java',
          test_framework: 'junit',
        }),
        undefined,
      );
    });

    it('keeps the uploaded image private when the person asks', async () => {
      await service.complete(user, SPACE, { ...finish, shared: false });

      expect(images.insert).toHaveBeenCalledWith(
        user,
        expect.anything(),
        expect.anything(),
        false,
      );
    });

    it('keeps the file when too many images wait for their check', async () => {
      images.assertRoomToCheck.mockRejectedValueOnce(
        new HttpException({ code: 'TOO_MANY_CHECKS' }, 429),
      );

      await expect(
        codeOf(service.complete(user, SPACE, finish)),
      ).resolves.toMatchObject({ status: 429, code: 'TOO_MANY_CHECKS' });
      expect(images.assertRoomToCheck).toHaveBeenCalledWith(ORG);
      expect(bucket.remove).not.toHaveBeenCalled();
      expect(images.insert).not.toHaveBeenCalled();
      expect(images.checkAgain).not.toHaveBeenCalled();
    });

    it('needs the labels and a valid digest', async () => {
      await expect(
        service.complete(user, SPACE, { ...finish, test_framework: undefined }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        codeOf(
          service.complete(user, SPACE, { ...finish, config_digest: HEX }),
        ),
      ).resolves.toMatchObject({ code: 'IMAGE_REF_INVALID' });
    });
  });
});

describe('uploadRepository', () => {
  it('makes a safe short name from the file name', () => {
    expect(uploadRepository('My Tests.tar.gz')).toBe('my-tests');
    expect(uploadRepository('api_v2.TAR')).toBe('api_v2');
    expect(uploadRepository('...tar')).toBe('uploaded-image');
    expect(uploadRepository(`${'x'.repeat(300)}.tar`)).toHaveLength(100);
  });
});
