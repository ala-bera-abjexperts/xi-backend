import { RequestMethod, ValidationPipe } from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';

import { SPACE_PERMISSION_KEY } from '../../auth/decorators/require-space-permission.decorator';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { ListTestAutomationRunsQueryDto } from '../dto/test-automation.dto';
import type { TestAutomationCiService } from './test-automation-ci.service';
import type { TestAutomationCiVariablesService } from './test-automation-ci-variables.service';
import type { TestAutomationConfigsService } from './test-automation-configs.service';
import type { TestAutomationRunnerService } from './test-automation-runner.service';
import type { TestAutomationRunsService } from './test-automation-runs.service';
import { TestAutomationController } from './test-automation.controller';

const handlerOf = (name: string) =>
  Object.getOwnPropertyDescriptor(TestAutomationController.prototype, name)
    ?.value as object;

describe('TestAutomationController runner routes', () => {
  const user = { userId: 'user-1', organizationId: 'org-1' } as RequestUser;

  function build(
    runs: Partial<TestAutomationRunsService>,
    runner: Partial<TestAutomationRunnerService> = {},
  ) {
    return new TestAutomationController(
      {} as TestAutomationConfigsService,
      {} as TestAutomationCiService,
      runs as TestAutomationRunsService,
      {} as TestAutomationCiVariablesService,
      runner as TestAutomationRunnerService,
    );
  }

  it('shows the runner to people who can view tests', () => {
    const handler = handlerOf('runnerStatus');

    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('runner');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.GET,
    );
    expect(Reflect.getMetadata(SPACE_PERMISSION_KEY, handler)).toBe(
      'view_tests',
    );
  });

  it('lets people who can run tests start it, 3 times a minute', () => {
    const handler = handlerOf('startRunner');

    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('runner/start');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    );
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
    expect(Reflect.getMetadata(SPACE_PERMISSION_KEY, handler)).toBe(
      'execute_tests',
    );
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(3);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000);
  });

  it('passes the space and person to the runner service', async () => {
    const status = jest.fn().mockResolvedValue({ state: 'offline' });
    const start = jest.fn().mockResolvedValue({ result: 'STARTED' });
    const controller = build({}, { status, start });

    await expect(controller.runnerStatus('space-1', user)).resolves.toEqual({
      state: 'offline',
    });
    await expect(controller.startRunner('space-1', user)).resolves.toEqual({
      result: 'STARTED',
    });
    expect(status).toHaveBeenCalledWith(user, 'space-1');
    expect(start).toHaveBeenCalledWith(user, 'space-1');
  });

  it('turns "me" into the person asking for the run history', async () => {
    const list = jest
      .fn()
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });
    const forViewer = jest.fn().mockResolvedValue([]);
    const controller = build({ list, forViewer });

    await controller.listRuns(
      'space-1',
      { page: 1, pageSize: 10, startedBy: 'me' },
      user,
    );
    await controller.listRuns(
      'space-1',
      {
        page: 1,
        pageSize: 10,
        startedBy: '33333333-3333-4333-8333-333333333333',
      },
      user,
    );
    await controller.listRuns('space-1', { page: 1, pageSize: 10 }, user);

    expect(
      (
        list.mock.calls as [string, string, ListTestAutomationRunsQueryDto][]
      ).map((call) => call[2].startedBy),
    ).toEqual(['user-1', '33333333-3333-4333-8333-333333333333', undefined]);
  });

  it.each([
    ['me', true],
    ['33333333-3333-4333-8333-333333333333', true],
    ['someone', false],
    ["me' or 1=1", false],
    ['', false],
  ])('checks startedBy %p', async (startedBy, valid) => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const check = pipe.transform(
      { page: '1', pageSize: '10', startedBy },
      { type: 'query', metatype: ListTestAutomationRunsQueryDto },
    );

    if (valid) await expect(check).resolves.toMatchObject({ startedBy });
    else await expect(check).rejects.toBeDefined();
  });
});
