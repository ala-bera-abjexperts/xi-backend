import { RequestMethod } from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';

import { SPACE_PERMISSION_KEY } from '../../auth/decorators/require-space-permission.decorator';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import type { TestAutomationCiService } from './test-automation-ci.service';
import type { TestAutomationCiVariablesService } from './test-automation-ci-variables.service';
import type { TestAutomationConfigsService } from './test-automation-configs.service';
import type { TestAutomationRunsService } from './test-automation-runs.service';
import { TestAutomationController } from './test-automation.controller';

describe('TestAutomationController framework route', () => {
  const handler = Object.getOwnPropertyDescriptor(
    TestAutomationController.prototype,
    'framework',
  )?.value as object;

  it('is a GET on configs/:configId/framework for people who can view tests', () => {
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      'configs/:configId/framework',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.GET,
    );
    expect(Reflect.getMetadata(SPACE_PERMISSION_KEY, handler)).toBe(
      'view_tests',
    );
  });

  it('is throttled to 10 a minute, because it downloads the zip', () => {
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(10);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000);
  });

  it('asks the settings service with the space, setting and person', async () => {
    const framework = jest.fn().mockResolvedValue({ preset: null });
    const controller = new TestAutomationController(
      { framework } as unknown as TestAutomationConfigsService,
      {} as TestAutomationCiService,
      {} as TestAutomationRunsService,
      {} as TestAutomationCiVariablesService,
    );
    const user = { userId: 'user-1', organizationId: 'org-1' } as RequestUser;

    await expect(
      controller.framework('space-1', 'config-1', user),
    ).resolves.toEqual({
      preset: null,
    });
    expect(framework).toHaveBeenCalledWith(user, 'space-1', 'config-1');
  });
});

describe('TestAutomationController delete-files route', () => {
  const handler = Object.getOwnPropertyDescriptor(
    TestAutomationController.prototype,
    'deleteFiles',
  )?.value as object;

  it('is a POST on configs/:configId/files/delete for people who edit settings', () => {
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      'configs/:configId/files/delete',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    );
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
    expect(Reflect.getMetadata(SPACE_PERMISSION_KEY, handler)).toBe(
      'edit_space_settings',
    );
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(10);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000);
  });

  it('passes the body to the settings service', async () => {
    const deleteFiles = jest.fn().mockResolvedValue({ version: null });
    const controller = new TestAutomationController(
      { deleteFiles } as unknown as TestAutomationConfigsService,
      {} as TestAutomationCiService,
      {} as TestAutomationRunsService,
      {} as TestAutomationCiVariablesService,
    );
    const user = { userId: 'user-1', organizationId: 'org-1' } as RequestUser;
    const dto = { paths: ['a.txt', 'b.txt'], version: null };

    await expect(
      controller.deleteFiles('space-1', 'config-1', dto, user),
    ).resolves.toEqual({ version: null });
    expect(deleteFiles).toHaveBeenCalledWith(user, 'space-1', 'config-1', dto);
  });
});
