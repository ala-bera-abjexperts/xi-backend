import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  INTERCEPTORS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { REQUIRE_FEATURE_KEY } from '../../../../../auth/decorators/require-feature.decorator';
import { SPACE_PERMISSION_KEY } from '../../../../../auth/decorators/require-space-permission.decorator';
import type { RequestUser } from '../../../../../auth/interfaces/request-user.interface';
import {
  CheckCustomImageDto,
  TestAutomationCustomImagesController,
} from '../../../test-automation-custom-images.controller';
import {
  FinishImageUploadDto,
  StartImageUploadDto,
  TestAutomationCustomImageUploadsController,
} from './test-automation-custom-image-uploads.controller';
import type { TestAutomationCustomImageUploadsService } from '../service/test-automation-custom-image-uploads.service';

const handlerOf = (name: string) =>
  Object.getOwnPropertyDescriptor(
    TestAutomationCustomImageUploadsController.prototype,
    name,
  )?.value as object;

const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('TestAutomationCustomImageUploadsController', () => {
  it('sits behind the same feature, guard, interceptor and path as the other custom image routes', () => {
    for (const key of [
      PATH_METADATA,
      GUARDS_METADATA,
      INTERCEPTORS_METADATA,
      REQUIRE_FEATURE_KEY,
    ]) {
      expect(
        Reflect.getMetadata(key, TestAutomationCustomImageUploadsController),
      ).toEqual(Reflect.getMetadata(key, TestAutomationCustomImagesController));
    }
  });

  it.each([
    ['start', 'custom-images/uploads'],
    ['complete', 'custom-images/uploads/complete'],
  ])(
    '%s is POST %s for space admins, answers 200 and is throttled',
    (name, path) => {
      const handler = handlerOf(name);

      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
        RequestMethod.POST,
      );
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
      expect(Reflect.getMetadata(SPACE_PERMISSION_KEY, handler)).toBe(
        'edit_space_settings',
      );
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
      expect(
        Reflect.getMetadata('THROTTLER:LIMITdefault', handler) as number,
      ).toBe(10);
    },
  );

  it('passes the body to the service', async () => {
    const uploads = {
      start: jest.fn().mockResolvedValue({ reused: false }),
      complete: jest.fn().mockResolvedValue({ id: 'image-1' }),
    };
    const controller = new TestAutomationCustomImageUploadsController(
      uploads as unknown as TestAutomationCustomImageUploadsService,
    );
    const user = { userId: 'user-1', organizationId: 'org-1' } as RequestUser;
    const body = { config_digest: DIGEST } as StartImageUploadDto;

    await controller.start('space-1', body, user);
    await controller.complete('space-1', body, user);

    expect(uploads.start).toHaveBeenCalledWith(user, 'space-1', body);
    expect(uploads.complete).toHaveBeenCalledWith(user, 'space-1', body);
  });

  it('validates the start body', async () => {
    const valid = {
      file_name: ' tests.tar ',
      file_bytes: 2048,
      config_digest: DIGEST,
      platform: 'linux/amd64',
      gzip: false,
      language: 'python',
      test_framework: 'pytest',
    };

    await expect(
      validate(plainToInstance(StartImageUploadDto, valid)),
    ).resolves.toEqual([]);
    expect(plainToInstance(StartImageUploadDto, valid).file_name).toBe(
      'tests.tar',
    );

    for (const broken of [
      { file_bytes: 0 },
      { file_bytes: 1.5 },
      { file_name: '' },
      { file_name: 'x'.repeat(256) },
      { platform: 'x'.repeat(51) },
      { gzip: 'yes' },
      { language: 'Python!' },
    ]) {
      const errors = await validate(
        plainToInstance(StartImageUploadDto, { ...valid, ...broken }),
      );

      expect(errors.map((error) => error.property)).toEqual(
        Object.keys(broken),
      );
    }
  });

  it('validates the complete body, with the labels optional', async () => {
    await expect(
      validate(
        plainToInstance(FinishImageUploadDto, {
          config_digest: DIGEST,
          file_name: 'tests.tar',
          gzip: true,
        }),
      ),
    ).resolves.toEqual([]);
  });

  it('takes only a plain .tar, .tar.gz or .tgz file name', async () => {
    const errorsFor = async (fileName: string) =>
      (
        await validate(
          plainToInstance(FinishImageUploadDto, {
            config_digest: DIGEST,
            file_name: fileName,
            gzip: false,
          }),
        )
      ).map((error) => error.property);

    for (const good of ['tests.tar', 'My Tests.TAR.GZ', 'a.tgz']) {
      await expect(errorsFor(good)).resolves.toEqual([]);
    }

    for (const bad of [
      '../tests.tar',
      'dir\\tests.tar',
      'tests\u0001.tar',
      'tests.zip',
      'tests.tar.bz2',
      '.tar.gz.exe',
    ]) {
      await expect(errorsFor(bad)).resolves.toEqual(['file_name']);
    }
  });

  it('takes a platform as os/arch with an optional variant', async () => {
    const valid = {
      file_name: 'tests.tar',
      file_bytes: 2048,
      config_digest: DIGEST,
      gzip: false,
    };

    for (const good of ['linux/amd64', 'linux/arm64/v8']) {
      await expect(
        validate(
          plainToInstance(StartImageUploadDto, { ...valid, platform: good }),
        ),
      ).resolves.toEqual([]);
    }

    for (const bad of ['linux', 'Linux/amd64', 'linux/arm64/v8/x', 'a/b c']) {
      const errors = await validate(
        plainToInstance(StartImageUploadDto, { ...valid, platform: bad }),
      );

      expect(errors.map((error) => error.property)).toEqual(['platform']);
    }
  });

  const checkChoices = async <T extends object>(
    Dto: new () => T,
    base: Record<string, unknown>,
  ) => {
    const empty = plainToInstance(Dto, {
      ...base,
      language: ' ',
      test_framework: '',
    });

    expect(empty).not.toHaveProperty('language', expect.anything());
    expect(empty).not.toHaveProperty('test_framework', expect.anything());
    await expect(validate(empty)).resolves.toEqual([]);
    await expect(
      validate(
        plainToInstance(Dto, {
          ...base,
          language: 'javascript',
          test_framework: 'jest',
        }),
      ),
    ).resolves.toEqual([]);

    await expect(
      validate(
        plainToInstance(Dto, {
          ...base,
          language: 'java',
          test_framework: 'junit',
        }),
      ),
    ).resolves.toEqual([]);

    const errors = await validate(
      plainToInstance(Dto, {
        ...base,
        language: 'not-a-language',
        test_framework: 'Bad Name!',
      }),
    );

    expect(errors.map((error) => error.property).sort()).toEqual([
      'language',
      'test_framework',
    ]);
  };

  it('the upload body takes only listed languages and well-formed frameworks, and ignores empty ones', async () => {
    await checkChoices(FinishImageUploadDto, {
      config_digest: DIGEST,
      file_name: 'tests.tar',
      gzip: false,
    });
  });

  it('takes any well-formed label read from the file, and ignores empty ones', async () => {
    const base = { config_digest: DIGEST, file_name: 'tests.tar', gzip: false };
    const empty = plainToInstance(FinishImageUploadDto, {
      ...base,
      image_language: ' ',
      image_test_framework: '',
    });

    expect(empty.image_language).toBeUndefined();
    expect(empty.image_test_framework).toBeUndefined();
    await expect(validate(empty)).resolves.toEqual([]);
    await expect(
      validate(
        plainToInstance(StartImageUploadDto, {
          ...base,
          file_bytes: 1,
          platform: 'linux/amd64',
          image_language: 'java',
          image_test_framework: 'junit',
        }),
      ),
    ).resolves.toEqual([]);

    const errors = await validate(
      plainToInstance(FinishImageUploadDto, {
        ...base,
        image_language: 'Java!',
        image_test_framework: 'x'.repeat(51),
      }),
    );

    expect(errors.map((error) => error.property).sort()).toEqual([
      'image_language',
      'image_test_framework',
    ]);
  });

  it('the check body takes only listed languages and well-formed frameworks, and ignores empty ones', async () => {
    await checkChoices(CheckCustomImageDto, {
      image_ref: `ghcr.io/team/tests@${DIGEST}`,
    });
  });
});
