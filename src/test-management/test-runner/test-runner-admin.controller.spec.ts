import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';

import { SUPER_ADMIN_KEY } from '../../auth/decorators/require-super-admin.decorator';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { SuperAdminGuard } from '../../auth/guards/super-admin.guard';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { TestRunnerAdminController } from './test-runner-admin.controller';

describe('TestRunnerAdminController', () => {
  const user = { userId: 'admin-1' } as RequestUser;
  const handler = Object.getOwnPropertyDescriptor(
    TestRunnerAdminController.prototype,
    'stop',
  )?.value as object;

  function build(error: { message: string } | null = null) {
    const upsert = jest.fn().mockResolvedValue({ error });
    const from = jest.fn(() => ({ upsert }));
    const controller = new TestRunnerAdminController({
      getClient: () => ({ from }),
    } as unknown as SupabaseAdminService);

    jest
      .spyOn(
        (controller as unknown as { logger: { log: () => void } }).logger,
        'log',
      )
      .mockImplementation(() => undefined);

    return { controller, from, upsert };
  }

  it('is only for platform admins, behind the super admin guard', () => {
    expect(
      Reflect.getMetadata(SUPER_ADMIN_KEY, TestRunnerAdminController),
    ).toBe(true);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, TestRunnerAdminController),
    ).toContain(SuperAdminGuard);
    expect(Reflect.getMetadata(PATH_METADATA, TestRunnerAdminController)).toBe(
      'admin/test-runner',
    );
  });

  it('is a POST on stop that answers 200, 5 times a minute', () => {
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('stop');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    );
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(5);
  });

  it('saves the stop time that the runners read', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-11-12T10:00:00.000Z') });

    try {
      const { controller, from, upsert } = build();

      await expect(controller.stop(user)).resolves.toEqual({
        result: 'STOP_REQUESTED',
      });
      expect(from).toHaveBeenCalledWith('cron_run_state');
      expect(upsert).toHaveBeenCalledWith({
        job_name: 'tm_runner.drain',
        last_run_at: '2026-11-12T10:00:00.000Z',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('answers a clear error when the request cannot be saved', async () => {
    const { controller } = build({ message: 'down' });

    await expect(controller.stop(user)).rejects.toMatchObject({
      response: { code: 'RUNNER_STOP_FAILED' },
    });
  });
});
