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

import { REQUIRE_FEATURE_KEY } from '../../../../auth/decorators/require-feature.decorator';
import { SPACE_PERMISSION_KEY } from '../../../../auth/decorators/require-space-permission.decorator';
import { SpacePermissionsGuard } from '../../../../auth/guards/space-permissions.guard';
import type { RequestUser } from '../../../../auth/interfaces/request-user.interface';
import { TestManagementResponseInterceptor } from '../../../test-management-response.interceptor';
import { TestAutomationController } from '../../test-automation.controller';
import {
  CheckCustomImageDto,
  TestAutomationCustomImagesController,
} from '../../test-automation-custom-images.controller';
import type { TestAutomationCustomImagesService } from '../../test-automation-custom-images.service';

const handlerOf = (name: string) =>
  Object.getOwnPropertyDescriptor(
    TestAutomationCustomImagesController.prototype,
    name,
  )?.value as object;

const IMAGE_ID = '11111111-1111-4111-8111-111111111111';

describe('TestAutomationCustomImagesController', () => {
  const user = { userId: 'user-1', organizationId: 'org-1' } as RequestUser;

  it('sits behind the same feature, guard, interceptor and path as the automation routes', () => {
    for (const key of [PATH_METADATA, GUARDS_METADATA, INTERCEPTORS_METADATA]) {
      expect(
        Reflect.getMetadata(key, TestAutomationCustomImagesController),
      ).toEqual(Reflect.getMetadata(key, TestAutomationController));
    }

    expect(
      Reflect.getMetadata(
        GUARDS_METADATA,
        TestAutomationCustomImagesController,
      ),
    ).toEqual([SpacePermissionsGuard]);
    expect(
      Reflect.getMetadata(
        INTERCEPTORS_METADATA,
        TestAutomationCustomImagesController,
      ),
    ).toEqual([TestManagementResponseInterceptor]);
    expect(
      Reflect.getMetadata(
        REQUIRE_FEATURE_KEY,
        TestAutomationCustomImagesController,
      ),
    ).toEqual(
      Reflect.getMetadata(REQUIRE_FEATURE_KEY, TestAutomationController),
    );
  });

  it.each([
    [
      'settings',
      RequestMethod.GET,
      'custom-images/settings',
      'view_tests',
      null,
    ],
    ['list', RequestMethod.GET, 'custom-images', 'view_tests', null],
    ['get', RequestMethod.GET, 'custom-images/:imageId', 'view_tests', null],
    [
      'check',
      RequestMethod.POST,
      'custom-images/check',
      'edit_space_settings',
      10,
    ],
    [
      'block',
      RequestMethod.POST,
      'custom-images/:imageId/block',
      'edit_space_settings',
      null,
    ],
    [
      'searchDockerHub',
      RequestMethod.GET,
      'docker-hub/search',
      'edit_space_settings',
      30,
    ],
    [
      'dockerHubTags',
      RequestMethod.GET,
      'docker-hub/tags',
      'edit_space_settings',
      30,
    ],
  ])('%s is %s %s for %s', (name, method, path, permission, limit) => {
    const handler = handlerOf(name);

    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
    expect(Reflect.getMetadata(SPACE_PERMISSION_KEY, handler)).toBe(permission);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(
      limit ?? undefined,
    );

    if (limit) {
      expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000);
    }

    if (method === RequestMethod.POST) {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
    }
  });

  it('declares the settings route before the image id route', () => {
    const names = Object.getOwnPropertyNames(
      TestAutomationCustomImagesController.prototype,
    );

    expect(names.indexOf('settings')).toBeLessThan(names.indexOf('get'));
  });

  it('passes the space, the person and the input to the service', async () => {
    const service = {
      settings: jest.fn().mockResolvedValue({ enabled: true }),
      list: jest.fn().mockResolvedValue([]),
      get: jest.fn().mockResolvedValue({ id: IMAGE_ID }),
      check: jest.fn().mockResolvedValue({ id: IMAGE_ID }),
      block: jest.fn().mockResolvedValue({ id: IMAGE_ID }),
      searchDockerHub: jest.fn().mockResolvedValue([]),
      dockerHubTags: jest.fn().mockResolvedValue({ tags: [], more: false }),
    };
    const controller = new TestAutomationCustomImagesController(
      service as unknown as TestAutomationCustomImagesService,
    );

    await controller.settings('space-1', user);
    await controller.list('space-1', user);
    await controller.get('space-1', IMAGE_ID, user);
    await controller.check(
      'space-1',
      { image_ref: 'ghcr.io/a/b@sha256:x', language: 'python' },
      user,
    );
    await controller.block('space-1', IMAGE_ID, user);
    await controller.searchDockerHub('space-1', { q: 'cassandra' }, user);
    await controller.dockerHubTags(
      'space-1',
      { repository: 'apache/cassandra', name: '5' },
      user,
    );

    expect(service.settings).toHaveBeenCalledWith(user, 'space-1');
    expect(service.list).toHaveBeenCalledWith(user, 'space-1');
    expect(service.get).toHaveBeenCalledWith(user, 'space-1', IMAGE_ID);
    expect(service.check).toHaveBeenCalledWith(
      user,
      'space-1',
      'ghcr.io/a/b@sha256:x',
      { language: 'python', test_framework: undefined },
      undefined,
    );
    expect(service.block).toHaveBeenCalledWith(user, 'space-1', IMAGE_ID);
    expect(service.searchDockerHub).toHaveBeenCalledWith(
      user,
      'space-1',
      'cassandra',
    );
    expect(service.dockerHubTags).toHaveBeenCalledWith(
      user,
      'space-1',
      'apache/cassandra',
      '5',
    );
  });

  it('takes only an address and an optional language and framework to check', async () => {
    const errorsOf = (body: Record<string, unknown>) =>
      validate(plainToInstance(CheckCustomImageDto, body));

    await expect(
      errorsOf({ image_ref: ' ghcr.io/a/b@sha256:x ', language: 'python' }),
    ).resolves.toEqual([]);
    await expect(errorsOf({})).resolves.toHaveLength(1);
    await expect(
      errorsOf({ image_ref: 'a', test_framework: 'Not Valid!' }),
    ).resolves.toHaveLength(1);
  });
});
