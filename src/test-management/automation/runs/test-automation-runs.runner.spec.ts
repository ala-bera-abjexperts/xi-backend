import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import type { AuditLogsService } from '../../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../../auth/interfaces/request-user.interface';
import { assertPublicHttpUrl } from '../../../common/security/ssrf-guard';
import type { PermissionsService } from '../../../permissions/permissions.service';
import type { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import type { TestManagementAccessService } from '../../access/test-management-access.service';
import type { TesterEligibilityService } from '../../common/tester-eligibility.service';
import {
  StartTestAutomationRunDto,
  TriggerTestAutomationDto,
  ListTestAutomationRunsQueryDto,
  type TestAutomationRun,
} from '../../dto/test-automation.dto';
import type { TestExecutionsService } from '../../executions/test-executions.service';
import type { TestRunsService } from '../../runs/test-runs.service';
import {
  AUTOMATION_LIMITS,
  readQueuePerOrg,
  readQueuePerSpace,
} from '../automation-inputs';
import type { TestAutomationCiWatcherService } from '../test-automation-ci-watcher.service';
import type { TestAutomationCiService } from '../test-automation-ci.service';
import type {
  TestAutomationConfigRow,
  TestAutomationConfigsService,
} from '../test-automation-configs.service';
import { TestAutomationRunsService } from '../test-automation-runs.service';

jest.mock('../../../common/security/ssrf-guard', () => ({
  assertPublicHttpUrl: jest.fn(),
  isBlockedAddress: jest.fn(),
}));

const ORG = 'org-1';
const SPACE = 'space-1';
const CONFIG = 'config-1';
const EXECUTION = 'execution-1';
const RUN = 'run-1';
const user = { userId: 'user-1', organizationId: ORG } as RequestUser;
const IMAGE = `mcr.example.com/pw@sha256:${'a'.repeat(64)}`;
const dto: StartTestAutomationRunDto = {
  config_id: CONFIG,
  target: 'execution',
  target_id: EXECUTION,
  request_id: 'request-1',
};

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
    'order',
    'limit',
    'range',
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

function config(
  overrides: Partial<TestAutomationConfigRow> = {},
): TestAutomationConfigRow {
  return {
    id: CONFIG,
    name: 'Browser tests',
    kind: 'docker',
    preset: 'playwright',
    image_key: 'playwright',
    source: 'git',
    repo_url: 'https://git.example.com/a.git',
    repo_ref: 'main',
    work_dir: null,
    zip_path: null,
    command: null,
    result_paths: ['results.xml'],
    env: { BASE_URL: 'https://app.example.com' },
    secrets_enc: 'encv1:stored-secret',
    allowed_hosts: ['app.example.com'],
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

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN,
    organization_id: ORG,
    space_id: SPACE,
    config_id: CONFIG,
    config_name: 'Browser tests',
    started_by: 'user-1',
    kind: 'docker',
    target: 'execution',
    plan_id: null,
    execution_id: EXECUTION,
    status: 'QUEUED',
    outcome: null,
    error_code: null,
    error_message: null,
    created_at: '2026-11-02T00:00:00Z',
    started_at: null,
    finished_at: null,
    cancel_requested_at: null,
    result_summary: {},
    run_zip_path: null,
    ...overrides,
  };
}

describe('TestAutomationRunsService', () => {
  const savedEnabled = process.env.TM_RUNNER_ENABLED;
  const savedImages = process.env.TM_RUNNER_IMAGES;
  const publicCheck = assertPublicHttpUrl as jest.Mock;

  let service: TestAutomationRunsService;
  let from: jest.Mock;
  let copy: jest.Mock;
  let remove: jest.Mock;
  let assertAvailable: jest.Mock;
  let hasSpacePermission: jest.Mock;
  let findRow: jest.Mock;
  let zipFilePaths: jest.Mock;
  let zipFramework: jest.Mock;
  let findByRequest: jest.Mock;
  let findTarget: jest.Mock;
  let log: jest.Mock;
  let assertEligible: jest.Mock;
  let runNow: jest.Mock;
  let removeExecution: jest.Mock;
  let addRuns: jest.Mock;
  let jobs: jest.Mock;
  let isCancellable: jest.Mock;

  const next = (resolved: Resolved): Chain => {
    const chain = chainOf(resolved);

    from.mockReturnValueOnce(chain);

    return chain;
  };

  const caught = (run: Promise<unknown>): Promise<unknown> =>
    run.then(
      () => {
        throw new Error('Expected the call to be refused');
      },
      (reason: unknown) => reason,
    );

  const copiedTo = () => (copy.mock.calls as unknown[][])[0]?.[1] as string;

  beforeAll(() => {
    process.env.TM_RUNNER_IMAGES = JSON.stringify({ playwright: IMAGE });
  });

  afterAll(() => {
    if (savedEnabled === undefined) delete process.env.TM_RUNNER_ENABLED;
    else process.env.TM_RUNNER_ENABLED = savedEnabled;

    if (savedImages === undefined) delete process.env.TM_RUNNER_IMAGES;
    else process.env.TM_RUNNER_IMAGES = savedImages;
  });

  beforeEach(() => {
    process.env.TM_RUNNER_ENABLED = '1';
    publicCheck.mockReset();
    publicCheck.mockResolvedValue(undefined);

    from = jest.fn();
    copy = jest.fn().mockResolvedValue({ error: null });
    remove = jest.fn().mockResolvedValue({ error: null });
    assertAvailable = jest.fn().mockResolvedValue(undefined);
    hasSpacePermission = jest.fn().mockResolvedValue(true);
    findRow = jest.fn().mockResolvedValue(config());
    zipFilePaths = jest.fn().mockResolvedValue([]);
    zipFramework = jest.fn().mockResolvedValue({ files: [], detected: null });
    findByRequest = jest.fn().mockResolvedValue(null);
    findTarget = jest
      .fn()
      .mockResolvedValue({ id: EXECUTION, key: 'P-TE1', is_archived: false });
    log = jest.fn();
    assertEligible = jest.fn().mockResolvedValue(undefined);
    runNow = jest
      .fn()
      .mockResolvedValue({ execution_id: 'new-execution', replayed: false });
    removeExecution = jest.fn().mockResolvedValue({});
    addRuns = jest.fn().mockResolvedValue({ added: 0, skipped: [] });
    jobs = jest.fn().mockResolvedValue([]);
    isCancellable = jest.fn().mockReturnValue(false);

    service = new TestAutomationRunsService(
      {
        getClient: () => ({
          from,
          storage: { from: () => ({ copy, remove }) },
        }),
      } as unknown as SupabaseAdminService,
      { assertAvailable } as unknown as TestManagementAccessService,
      { hasSpacePermission } as unknown as PermissionsService,
      { logActionForRequest: log } as unknown as AuditLogsService,
      { jobs, isCancellable } as unknown as TestAutomationCiWatcherService,
      {
        findRow,
        zipFilePaths,
        zipFramework,
      } as unknown as TestAutomationConfigsService,
      { findByRequest, findTarget } as unknown as TestAutomationCiService,
      { assertEligible } as unknown as TesterEligibilityService,
      {
        runNow,
        remove: removeExecution,
      } as unknown as TestExecutionsService,
      { addRuns } as unknown as TestRunsService,
    );
  });

  describe('start', () => {
    // The waiting-run count and the insert, in the order the service makes them.
    const queueOpen = (row = runRow()) => {
      next({ data: null, error: null, count: 0 });
      next({ data: null, error: null, count: 0 }); // no run of this setting is going here

      return next({ data: row, error: null });
    };

    describe('who can start', () => {
      it('needs the right to manage test runs', async () => {
        hasSpacePermission.mockResolvedValue(false);

        await expect(service.start(user, SPACE, dto)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        expect(assertAvailable).toHaveBeenCalledWith(ORG, SPACE, {
          write: true,
        });
        expect(hasSpacePermission).toHaveBeenCalledWith(
          'user-1',
          ORG,
          SPACE,
          'manage_test_runs',
        );
        expect(findByRequest).not.toHaveBeenCalled();
        expect(from).not.toHaveBeenCalled();
      });

      it('needs the right to create tests when the setting creates them', async () => {
        findRow.mockResolvedValue(config({ create_unmatched: true }));
        hasSpacePermission.mockImplementation(
          (_user: string, _org: string, _space: string, right: string) =>
            Promise.resolve(right !== 'create_tests'),
        );

        await expect(service.start(user, SPACE, dto)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        expect(from).not.toHaveBeenCalled();
      });

      it('does not ask for that right otherwise', async () => {
        queueOpen();

        await service.start(user, SPACE, dto);

        expect(hasSpacePermission).toHaveBeenCalledTimes(1);
      });
    });

    describe('while the runner is off', () => {
      const runnerIs = (state: string, autoStarted = 'off') => {
        const acceptsRuns = jest.fn().mockResolvedValue(state);
        const autoStart = jest.fn().mockResolvedValue(autoStarted);

        (service as unknown as { runner: unknown }).runner = {
          acceptsRuns,
          autoStart,
        };

        return acceptsRuns;
      };

      it.each(['offline', 'draining', 'not_ready'])(
        'refuses a run with RUNNER_OFF while the runner is %s, and saves nothing',
        async (state) => {
          runnerIs(state);

          const refused = service.start(user, SPACE, dto);

          await expect(refused).rejects.toBeInstanceOf(ConflictException);
          await expect(refused).rejects.toMatchObject({
            response: { code: 'RUNNER_OFF' },
          });
          expect(findRow).not.toHaveBeenCalled();
          expect(from).not.toHaveBeenCalled();
          expect(copy).not.toHaveBeenCalled();
        },
      );

      it.each(['online', 'busy', 'starting'])(
        'queues a run while the runner is %s',
        async (state) => {
          const acceptsRuns = runnerIs(state);
          const inserted = queueOpen();

          await service.start(user, SPACE, dto);

          expect(acceptsRuns).toHaveBeenCalledTimes(1);
          expect(firstArg(inserted.insert)).toMatchObject({ status: 'QUEUED' });
        },
      );

      it('starts the runner when it is off and queues the run', async () => {
        runnerIs('offline', 'started');
        const inserted = queueOpen();

        await service.start(user, SPACE, dto);

        expect(firstArg(inserted.insert)).toMatchObject({ status: 'QUEUED' });
      });

      it('tells someone who may not start the runner to ask for it, and saves nothing', async () => {
        runnerIs('offline', 'forbidden');

        const refused = service.start(user, SPACE, dto);

        await expect(refused).rejects.toBeInstanceOf(ForbiddenException);
        await expect(refused).rejects.toMatchObject({
          response: { code: 'RUNNER_START_FORBIDDEN' },
        });
        expect(findRow).not.toHaveBeenCalled();
        expect(from).not.toHaveBeenCalled();
      });

      it('still returns the first start of the same request id', async () => {
        const acceptsRuns = runnerIs('offline');

        findByRequest.mockResolvedValue({ id: 'run-first' });

        await expect(service.start(user, SPACE, dto)).resolves.toEqual({
          id: 'run-first',
        });
        expect(acceptsRuns).not.toHaveBeenCalled();
      });
    });

    describe('one run of a setting at a time', () => {
      const eqCalls = (chain: Chain) =>
        (chain.eq.mock.calls as unknown[][]).map(([column, value]) => [
          column,
          value,
        ]);

      it('refuses a second run of the same setting on the same execution while one is going', async () => {
        next({ data: null, error: null, count: 0 });

        const going = next({ data: null, error: null, count: 1 });
        const reason = (await caught(
          service.start(user, SPACE, dto),
        )) as ConflictException;

        expect(reason).toBeInstanceOf(ConflictException);
        expect(reason.getResponse()).toMatchObject({
          code: 'RUN_ALREADY_GOING',
        });
        expect(eqCalls(going)).toEqual(
          expect.arrayContaining([
            ['organization_id', ORG],
            ['space_id', SPACE],
            ['config_id', CONFIG],
            ['kind', 'docker'],
            ['execution_id', EXECUTION],
          ]),
        );
        expect(going.in).toHaveBeenCalledWith('status', [
          'QUEUED',
          'RUNNING',
          'UPLOADING',
        ]);
        expect(from).toHaveBeenCalledTimes(2);
        expect(copy).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
      });

      it('looks at the plan for a plan start', async () => {
        findTarget.mockResolvedValue({
          id: 'plan-1',
          key: 'P-TP1',
          is_archived: false,
        });
        next({ data: null, error: null, count: 0 });

        const going = next({ data: null, error: null, count: 2 });

        await expect(
          service.start(user, SPACE, {
            ...dto,
            target: 'plan',
            target_id: 'plan-1',
          }),
        ).rejects.toMatchObject({ response: { code: 'RUN_ALREADY_GOING' } });
        expect(eqCalls(going)).toEqual(
          expect.arrayContaining([['plan_id', 'plan-1']]),
        );
        expect(eqCalls(going).map(([column]) => column)).not.toContain(
          'execution_id',
        );
      });

      it('queues once nothing of this setting is going here', async () => {
        const inserted = queueOpen();

        await service.start(user, SPACE, dto);

        expect(firstArg(inserted.insert)).toMatchObject({ status: 'QUEUED' });
      });

      it('still returns the first start of the same request id', async () => {
        findByRequest.mockResolvedValue({ id: 'run-first' });

        await expect(service.start(user, SPACE, dto)).resolves.toEqual({
          id: 'run-first',
        });
        expect(from).not.toHaveBeenCalled();
      });

      it('stops on a failed check', async () => {
        next({ data: null, error: null, count: 0 });
        next({ data: null, error: { message: 'db down' } });

        await expect(service.start(user, SPACE, dto)).rejects.toBeDefined();
        expect(copy).not.toHaveBeenCalled();
      });
    });

    describe('the same request id', () => {
      it('returns the first start, even with the runner switched off', async () => {
        delete process.env.TM_RUNNER_ENABLED;
        findByRequest.mockResolvedValue({ id: 'run-first' });

        await expect(service.start(user, SPACE, dto)).resolves.toEqual({
          id: 'run-first',
        });
        expect(findByRequest).toHaveBeenCalledWith(
          user,
          SPACE,
          CONFIG,
          'request-1',
        );
        expect(findRow).not.toHaveBeenCalled();
        expect(from).not.toHaveBeenCalled();
      });

      it('passes on a refusal for an id used by someone else', async () => {
        const reused = new ConflictException({ code: 'REQUEST_ID_REUSED' });

        findByRequest.mockRejectedValue(reused);

        await expect(service.start(user, SPACE, dto)).rejects.toBe(reused);
        expect(from).not.toHaveBeenCalled();
      });
    });

    describe('what must be true before queueing', () => {
      it.each(['', '0', 'true'])(
        'answers 503 when the runner switch is %j',
        async (value) => {
          process.env.TM_RUNNER_ENABLED = value;

          const error = await caught(service.start(user, SPACE, dto));

          expect(error).toBeInstanceOf(ServiceUnavailableException);
          expect(error).toMatchObject({
            response: { code: 'RUNNER_DISABLED' },
          });
          expect(findRow).not.toHaveBeenCalled();
        },
      );

      it('refuses an archived setting', async () => {
        findRow.mockResolvedValue(
          config({ archived_at: '2026-11-01T00:00:00Z' }),
        );

        await expect(service.start(user, SPACE, dto)).rejects.toMatchObject({
          response: { code: 'ARCHIVED' },
        });
      });

      it('refuses a CI job setting', async () => {
        findRow.mockResolvedValue(config({ kind: 'ci_job' }));

        const error = await caught(service.start(user, SPACE, dto));

        expect(error).toBeInstanceOf(BadRequestException);
        expect(error).toMatchObject({
          response: { code: 'NOT_A_RUNNER_SETTING' },
        });
      });

      it('needs a zip for a zip setting', async () => {
        findRow.mockResolvedValue(config({ source: 'zip', repo_url: null }));

        await expect(service.start(user, SPACE, dto)).rejects.toMatchObject({
          response: { code: 'ZIP_MISSING' },
        });
      });

      it('refuses an image the server no longer allows', async () => {
        findRow.mockResolvedValue(config({ image_key: 'removed' }));

        await expect(service.start(user, SPACE, dto)).rejects.toMatchObject({
          response: { code: 'IMAGE_NOT_ALLOWED' },
        });
      });

      it('refuses a repository that stopped being public', async () => {
        publicCheck.mockRejectedValue(new Error('private'));

        await expect(service.start(user, SPACE, dto)).rejects.toMatchObject({
          response: { field: 'repo_url' },
        });
        expect(publicCheck).toHaveBeenCalledWith(
          'https://git.example.com/a.git',
        );
      });

      it('refuses a host that stopped being public', async () => {
        findRow.mockResolvedValue(
          config({
            source: 'zip',
            repo_url: null,
            zip_path: 'setting.zip',
          }),
        );
        publicCheck.mockRejectedValue(new Error('private'));

        await expect(service.start(user, SPACE, dto)).rejects.toMatchObject({
          response: { field: 'allowed_hosts' },
        });
        expect(publicCheck).toHaveBeenCalledWith('https://app.example.com');
        expect(copy).not.toHaveBeenCalled();
      });

      it('passes on a refused target before copying anything', async () => {
        const gone = new ConflictException({ code: 'ARCHIVED' });

        findRow.mockResolvedValue(
          config({ source: 'zip', zip_path: 'setting.zip' }),
        );
        findTarget.mockRejectedValue(gone);

        await expect(service.start(user, SPACE, dto)).rejects.toBe(gone);
        expect(findTarget).toHaveBeenCalledWith(ORG, SPACE, dto);
        expect(copy).not.toHaveBeenCalled();
        expect(from).not.toHaveBeenCalled();
      });
    });

    describe('the queue limit', () => {
      it('refuses when the organization has the most runs waiting', async () => {
        findRow.mockResolvedValue(
          config({ source: 'zip', zip_path: 'setting.zip' }),
        );

        const count = next({
          data: null,
          error: null,
          count: AUTOMATION_LIMITS.queuedRuns,
        });
        const error = await caught(service.start(user, SPACE, dto));

        expect(error).toBeInstanceOf(ConflictException);
        expect(error).toMatchObject({ response: { code: 'QUEUE_FULL' } });
        expect(count.eq).toHaveBeenCalledWith('organization_id', ORG);
        expect(count.eq).toHaveBeenCalledWith('status', 'QUEUED');
        expect(copy).not.toHaveBeenCalled();
      });

      it('still queues one below the limit', async () => {
        next({
          data: null,
          error: null,
          count: AUTOMATION_LIMITS.queuedRuns - 1,
        });
        next({ data: null, error: null, count: 0 }); // no run of this setting is going here
        next({ data: runRow(), error: null });

        await expect(service.start(user, SPACE, dto)).resolves.toMatchObject({
          status: 'QUEUED',
        });
      });

      it('stops on a failed count', async () => {
        next({ data: null, error: { message: 'read failed' } });

        await expect(service.start(user, SPACE, dto)).rejects.toBeDefined();
        expect(from).toHaveBeenCalledTimes(1);
      });

      const waiting = (space: string, n: number) =>
        Array.from({ length: n }, () => ({ space_id: space }));

      const withEnv = async (
        values: Record<string, string>,
        body: () => Promise<void>,
      ) => {
        const saved = Object.fromEntries(
          Object.keys(values).map((key) => [key, process.env[key]]),
        );

        Object.assign(process.env, values);

        try {
          await body();
        } finally {
          for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }
      };

      it('refuses when this space has the most runs waiting', async () => {
        findRow.mockResolvedValue(
          config({ source: 'zip', zip_path: 'setting.zip' }),
        );

        next({ data: waiting(SPACE, 10), error: null, count: 10 });
        const error = await caught(service.start(user, SPACE, dto));

        expect(error).toBeInstanceOf(ConflictException);
        expect(error).toMatchObject({
          response: {
            code: 'QUEUE_FULL',
            message: expect.stringContaining('in this space') as string,
          },
        });
        expect(copy).not.toHaveBeenCalled();
      });

      it('counts only this space toward the space limit', async () => {
        next({
          data: [...waiting(SPACE, 9), ...waiting('space-2', 5)],
          error: null,
          count: 14,
        });
        next({ data: null, error: null, count: 0 }); // no run of this setting is going here
        next({ data: runRow(), error: null });

        await expect(service.start(user, SPACE, dto)).resolves.toMatchObject({
          status: 'QUEUED',
        });
      });

      it('takes the waiting limits from the environment', async () => {
        await withEnv({ TM_RUNNER_QUEUE_PER_ORG: '3' }, async () => {
          const count = next({ data: [], error: null, count: 3 });
          const error = await caught(service.start(user, SPACE, dto));

          expect(error).toMatchObject({
            response: {
              code: 'QUEUE_FULL',
              message: expect.stringContaining('At most 3 runs') as string,
            },
          });
          expect(count.limit).toHaveBeenCalledWith(3);
        });
      });
    });

    describe('reading the waiting limits', () => {
      it.each([
        [undefined, 20],
        ['', 20],
        ['abc', 20],
        ['0', 20],
        ['-5', 20],
        ['2.5', 20],
        ['1', 1],
        ['50', 50],
        ['5000', 1000],
      ])('reads %j per organisation as %i', (raw, value) => {
        expect(readQueuePerOrg(raw)).toBe(value);
      });

      it.each([
        [undefined, 10],
        ['abc', 10],
        ['0', 10],
        ['4', 4],
        ['15', 15],
      ])('reads %j per space as %i', (raw, value) => {
        expect(readQueuePerSpace(raw)).toBe(value);
      });

      it('never lets a space wait for more than the organisation', () => {
        const saved = process.env.TM_RUNNER_QUEUE_PER_ORG;

        process.env.TM_RUNNER_QUEUE_PER_ORG = '3';

        try {
          expect(readQueuePerSpace('10')).toBe(3);
        } finally {
          if (saved === undefined) delete process.env.TM_RUNNER_QUEUE_PER_ORG;
          else process.env.TM_RUNNER_QUEUE_PER_ORG = saved;
        }
      });
    });

    describe('queueing', () => {
      it('saves a waiting run for an execution', async () => {
        const inserted = queueOpen();

        await service.start(user, SPACE, dto);

        expect(firstArg(inserted.insert)).toMatchObject({
          organization_id: ORG,
          space_id: SPACE,
          config_id: CONFIG,
          kind: 'docker',
          target: 'execution',
          execution_id: EXECUTION,
          plan_id: null,
          request_id: 'request-1',
          started_by: 'user-1',
          status: 'QUEUED',
          run_zip_path: null,
        });
        expect(copy).not.toHaveBeenCalled();
      });

      it('links a plan start to the plan', async () => {
        const inserted = queueOpen();

        findTarget.mockResolvedValue({
          id: 'plan-1',
          key: 'P-TP1',
          is_archived: false,
        });

        await service.start(user, SPACE, {
          ...dto,
          target: 'plan',
          target_id: 'plan-1',
        });

        expect(firstArg(inserted.insert)).toMatchObject({
          target: 'plan',
          plan_id: 'plan-1',
          execution_id: null,
        });
      });

      it('keeps what the run needs in the snapshot, and never a secret', async () => {
        findRow.mockResolvedValue(
          config({ ci_headers_enc: 'encv1:stored-header' }),
        );

        const inserted = queueOpen();

        await service.start(user, SPACE, dto);

        const row = firstArg(inserted.insert);

        expect(row.config_snapshot).toEqual({
          name: 'Browser tests',
          preset: 'playwright',
          image_key: 'playwright',
          source: 'git',
          repo_url: 'https://git.example.com/a.git',
          repo_ref: 'main',
          work_dir: null,
          command: null,
          result_paths: ['results.xml'],
          env: { BASE_URL: 'https://app.example.com' },
          allowed_hosts: ['app.example.com'],
          create_unmatched: false,
          timeout_minutes: 30,
          trace_mode: 'off',
        });
        expect(JSON.stringify(row)).not.toContain('stored-secret');
        expect(JSON.stringify(row)).not.toContain('stored-header');
      });

      it('gives a zip run its own copy of the zip', async () => {
        findRow.mockResolvedValue(
          config({ source: 'zip', repo_url: null, zip_path: 'setting.zip' }),
        );

        const inserted = queueOpen();

        await service.start(user, SPACE, dto);

        const row = firstArg(inserted.insert);

        expect(copiedTo()).toBe(
          `automation/${ORG}/${SPACE}/${CONFIG}/runs/${row.id as string}.zip`,
        );
        expect((copy.mock.calls as unknown[][])[0]?.[0]).toBe('setting.zip');
        expect(row.run_zip_path).toBe(copiedTo());
        expect(remove).not.toHaveBeenCalled();
      });

      it('does not check a repository for a zip setting', async () => {
        findRow.mockResolvedValue(
          config({
            source: 'zip',
            repo_url: null,
            zip_path: 'setting.zip',
            allowed_hosts: [],
          }),
        );
        queueOpen();

        await service.start(user, SPACE, dto);

        expect(publicCheck).not.toHaveBeenCalled();
      });

      it('logs the start without anything from the setting', async () => {
        queueOpen();

        await service.start(user, SPACE, dto);

        expect(log).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(log.mock.calls)).not.toContain('stored-secret');
        expect(JSON.stringify(log.mock.calls)).not.toContain('BASE_URL');
      });

      it('never returns the path of the zip copy', async () => {
        queueOpen(runRow({ run_zip_path: 'automation/x.zip' }));

        const run = await service.start(user, SPACE, dto);

        expect(run).not.toHaveProperty('run_zip_path');
        expect(run).toMatchObject({
          id: RUN,
          config_name: 'Browser tests',
          status: 'QUEUED',
        });
      });
    });

    describe('selected test files', () => {
      const FILES = ['a.spec.js', 'tests/b.spec.js'];
      const withFiles = { ...dto, spec_files: FILES };

      const zipSetting = (overrides: Partial<TestAutomationConfigRow> = {}) =>
        findRow.mockResolvedValue(
          config({
            source: 'zip',
            repo_url: null,
            zip_path: 'setting.zip',
            ...overrides,
          }),
        );

      const codeOf = async (run: Promise<unknown>) =>
        (
          (await caught(run)) as { getResponse: () => { code?: string } }
        ).getResponse().code;

      it('saves them in the snapshot and the summary', async () => {
        zipSetting();
        zipFilePaths.mockResolvedValue(FILES);

        const inserted = queueOpen();

        await service.start(user, SPACE, withFiles);

        const row = firstArg(inserted.insert);

        expect(row.config_snapshot).toMatchObject({ spec_files: FILES });
        expect(row.result_summary).toEqual({ spec_files: FILES });
      });

      it('adds neither without a selection', async () => {
        zipSetting();

        const inserted = queueOpen();

        await service.start(user, SPACE, dto);

        const row = firstArg(inserted.insert);

        expect(row.config_snapshot).not.toHaveProperty('spec_files');
        expect(row).not.toHaveProperty('result_summary');
        expect(zipFilePaths).not.toHaveBeenCalled();
      });

      it('keeps the install command in the snapshot', async () => {
        findRow.mockResolvedValue(config({ install_command: 'npm i' }));

        const inserted = queueOpen();

        await service.start(user, SPACE, dto);

        expect(firstArg(inserted.insert).config_snapshot).toMatchObject({
          install_command: 'npm i',
        });
      });

      it('checks them on the run’s own copy, not the setting’s zip', async () => {
        zipSetting();
        zipFilePaths.mockResolvedValue(FILES);
        queueOpen();

        await service.start(user, SPACE, withFiles);

        expect(zipFilePaths).toHaveBeenCalledWith(copiedTo());
      });

      it('finds them under the tests folder, whatever the zip calls it', async () => {
        zipSetting({ work_dir: './e2e/' });
        zipFilePaths.mockResolvedValue([
          './e2e/a.spec.js',
          'e2e/tests/b.spec.js',
        ]);
        queueOpen();

        await expect(
          service.start(user, SPACE, withFiles),
        ).resolves.toBeDefined();
      });

      it('refuses a file not in the zip, and removes the copy', async () => {
        zipSetting();
        zipFilePaths.mockResolvedValue(['a.spec.js']);
        next({ data: null, error: null, count: 0 });
        next({ data: null, error: null, count: 0 }); // no run of this setting is going here

        const reason = (await caught(
          service.start(user, SPACE, withFiles),
        )) as BadRequestException;

        expect(reason).toBeInstanceOf(BadRequestException);
        expect(reason.getResponse()).toMatchObject({ code: 'SPEC_NOT_FOUND' });
        expect(JSON.stringify(reason.getResponse())).toContain(
          'tests/b.spec.js',
        );
        expect(remove).toHaveBeenCalledWith([copiedTo()]);
        expect(from).toHaveBeenCalledTimes(2);
      });

      it('does not count a file at the root as one under the tests folder', async () => {
        zipSetting({ work_dir: 'e2e' });
        zipFilePaths.mockResolvedValue(['a.spec.js', 'tests/b.spec.js']);
        next({ data: null, error: null, count: 0 });
        next({ data: null, error: null, count: 0 }); // no run of this setting is going here

        await expect(
          codeOf(service.start(user, SPACE, withFiles)),
        ).resolves.toBe('SPEC_NOT_FOUND');
      });

      it('removes the copy when the copy cannot be read either', async () => {
        const unreadable = new ServiceUnavailableException({
          code: 'ZIP_COPY_FAILED',
        });

        zipSetting();
        zipFilePaths.mockRejectedValue(unreadable);
        next({ data: null, error: null, count: 0 });
        next({ data: null, error: null, count: 0 }); // no run of this setting is going here

        await expect(service.start(user, SPACE, withFiles)).rejects.toBe(
          unreadable,
        );
        expect(remove).toHaveBeenCalledWith([copiedTo()]);
      });

      it('takes typed paths on a Git setting without any zip', async () => {
        const inserted = queueOpen();

        await service.start(user, SPACE, withFiles);

        expect(zipFilePaths).not.toHaveBeenCalled();
        expect(firstArg(inserted.insert).result_summary).toEqual({
          spec_files: FILES,
        });
      });

      it.each(['../a.spec.js', '-rf', 'a b.spec.js', '/a.spec.js'])(
        'refuses the path %j before doing anything',
        async (path) => {
          await expect(
            codeOf(service.start(user, SPACE, { ...dto, spec_files: [path] })),
          ).resolves.toBe('VALIDATION_FAILED');
          expect(findByRequest).not.toHaveBeenCalled();
          expect(copy).not.toHaveBeenCalled();
        },
      );

      it('refuses a list over the size one line can hold', async () => {
        const files = Array.from(
          { length: 100 },
          (_, index) => `${'x'.repeat(500)}${index}`,
        );

        await expect(
          codeOf(service.start(user, SPACE, { ...dto, spec_files: files })),
        ).resolves.toBe('VALIDATION_FAILED');
      });

      it('refuses a file Maven could not run, unless the setting has its own command', async () => {
        findRow.mockResolvedValue(config({ preset: 'maven' }));

        await expect(
          codeOf(
            service.start(user, SPACE, {
              ...dto,
              spec_files: ['LoginTest.java', 'data.xml'],
            }),
          ),
        ).resolves.toBe('VALIDATION_FAILED');
        expect(from).not.toHaveBeenCalled();

        findRow.mockResolvedValue(config({ preset: 'maven', command: 'make' }));
        queueOpen();

        await expect(
          service.start(user, SPACE, { ...dto, spec_files: ['data.xml'] }),
        ).resolves.toBeDefined();
      });

      describe('with the same request id', () => {
        const first = (summary: Record<string, unknown>) => ({
          id: 'run-first',
          result_summary: summary,
        });

        it('returns the first start for the same files, in any order', async () => {
          findByRequest.mockResolvedValue(
            first({ spec_files: ['a.spec.js', 'b.spec.js'] }),
          );

          await expect(
            service.start(user, SPACE, {
              ...dto,
              spec_files: ['b.spec.js', 'a.spec.js'],
            }),
          ).resolves.toMatchObject({ id: 'run-first' });
        });

        it.each<[Record<string, unknown>, string[] | undefined]>([
          [{ spec_files: ['a.spec.js'] }, ['b.spec.js']],
          [{ spec_files: ['a.spec.js'] }, undefined],
          [{}, ['a.spec.js']],
        ])('refuses another selection: %j, then %j', async (summary, files) => {
          findByRequest.mockResolvedValue(first(summary));

          await expect(
            codeOf(
              service.start(user, SPACE, {
                ...dto,
                ...(files ? { spec_files: files } : {}),
              }),
            ),
          ).resolves.toBe('REQUEST_ID_REUSED');
        });

        it('refuses another selection when two start at once', async () => {
          next({ data: null, error: null, count: 0 });
          next({ data: null, error: null, count: 0 }); // no run of this setting is going here
          next({ data: null, error: { code: '23505', message: 'duplicate' } });
          findByRequest
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(first({ spec_files: ['other.spec.js'] }));

          await expect(
            codeOf(service.start(user, SPACE, withFiles)),
          ).resolves.toBe('REQUEST_ID_REUSED');
        });
      });
    });

    describe('when saving goes wrong', () => {
      const zipSetting = () =>
        findRow.mockResolvedValue(
          config({ source: 'zip', repo_url: null, zip_path: 'setting.zip' }),
        );

      it('saves nothing when the zip cannot be copied', async () => {
        zipSetting();
        next({ data: null, error: null, count: 0 });
        next({ data: null, error: null, count: 0 }); // no run of this setting is going here
        copy.mockResolvedValue({ error: { message: 'storage down' } });

        const error = await caught(service.start(user, SPACE, dto));

        expect(error).toBeInstanceOf(ServiceUnavailableException);
        expect(error).toMatchObject({ response: { code: 'ZIP_COPY_FAILED' } });
        expect(from).toHaveBeenCalledTimes(2);
        expect(log).not.toHaveBeenCalled();
      });

      it('removes the copy when the run cannot be saved', async () => {
        zipSetting();
        next({ data: null, error: null, count: 0 });
        next({ data: null, error: null, count: 0 }); // no run of this setting is going here
        next({ data: null, error: { code: 'XX000', message: 'failed' } });

        await expect(service.start(user, SPACE, dto)).rejects.toBeDefined();
        expect(remove).toHaveBeenCalledWith([copiedTo()]);
        expect(log).not.toHaveBeenCalled();
      });

      it('returns the other click when two start at once, and removes this copy', async () => {
        zipSetting();
        next({ data: null, error: null, count: 0 });
        next({ data: null, error: null, count: 0 }); // no run of this setting is going here
        next({ data: null, error: { code: '23505', message: 'duplicate' } });
        findByRequest
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: 'run-other' });

        await expect(service.start(user, SPACE, dto)).resolves.toEqual({
          id: 'run-other',
        });
        expect(remove).toHaveBeenCalledWith([copiedTo()]);
        expect(log).not.toHaveBeenCalled();
      });

      it('answers with an error when no row comes back', async () => {
        next({ data: null, error: null, count: 0 });
        next({ data: null, error: null, count: 0 }); // no run of this setting is going here
        next({ data: null, error: null });

        await expect(service.start(user, SPACE, dto)).rejects.toBeDefined();
      });
    });
  });

  describe('start from a test case', () => {
    const CASE = 'case-1';
    const caseDto: StartTestAutomationRunDto = {
      config_id: CONFIG,
      target: 'execution',
      case_id: CASE,
      request_id: 'request-1',
    };
    const caseRow = (overrides: Record<string, unknown> = {}) => ({
      data: {
        is_archived: false,
        readiness: 'ready',
        automation_spec_path: null,
        ...overrides,
      },
      error: null,
    });
    const queueRoom = () => {
      next({ data: null, error: null, count: 0 });
      next({ data: null, error: null, count: 0 }); // no run of this setting is going for the case
    };
    const earlierRun = (executionId: string | null = 'old-execution') =>
      next({
        data: executionId ? { execution_id: executionId } : null,
        error: null,
      });
    const saved = (row = runRow()) => next({ data: row, error: null });

    it('refuses a second run of the same setting for the same test case while one is going', async () => {
      next({ data: null, error: null, count: 0 });

      const going = next({ data: null, error: null, count: 1 });

      await expect(service.start(user, SPACE, caseDto)).rejects.toMatchObject({
        response: { code: 'RUN_ALREADY_GOING' },
      });
      expect(going.eq).toHaveBeenCalledWith('result_summary->>case_id', CASE);
      expect(going.eq).not.toHaveBeenCalledWith(
        'execution_id',
        expect.anything(),
      );
      expect(runNow).not.toHaveBeenCalled();
      expect(from).toHaveBeenCalledTimes(2);
    });

    describe('the request', () => {
      const errorsOf = async (cls: new () => object, plain: object) =>
        (
          await validate(plainToInstance(cls, plain), {
            whitelist: true,
            forbidNonWhitelisted: true,
          })
        ).map((error) => error.property);
      const uuid = '11111111-1111-4111-8111-111111111111';

      it('relaxes target_id for a start only, and the CI trigger stays as it was', async () => {
        const body = {
          target: 'execution',
          request_id: uuid,
          config_id: uuid,
          case_id: uuid,
        };

        expect(await errorsOf(StartTestAutomationRunDto, body)).toEqual([]);
        expect(
          await errorsOf(StartTestAutomationRunDto, {
            ...body,
            target_id: 'nope',
          }),
        ).toEqual(['target_id']);
        expect(
          await errorsOf(TriggerTestAutomationDto, {
            target: 'execution',
            request_id: uuid,
          }),
        ).toEqual(['target_id']);
        expect(
          await errorsOf(TriggerTestAutomationDto, {
            target: 'execution',
            target_id: uuid,
            request_id: uuid,
            case_id: uuid,
          }),
        ).toEqual(['case_id']);
      });

      it('refuses a start with neither a target nor a test case', async () => {
        await expect(
          service.start(user, SPACE, {
            config_id: CONFIG,
            target: 'execution',
            request_id: 'request-1',
          }),
        ).rejects.toMatchObject({
          response: { code: 'VALIDATION_FAILED', field: 'target_id' },
        });
        expect(findByRequest).not.toHaveBeenCalled();
        expect(from).not.toHaveBeenCalled();
      });

      it('refuses a test case with a plan target', async () => {
        await expect(
          service.start(user, SPACE, {
            ...caseDto,
            target: 'plan',
            target_id: EXECUTION,
          }),
        ).rejects.toMatchObject({
          response: { code: 'VALIDATION_FAILED', field: 'case_id' },
        });
        expect(from).not.toHaveBeenCalled();
      });
    });

    describe('checks before anything is made', () => {
      const nothingMade = () => {
        expect(runNow).not.toHaveBeenCalled();
        expect(addRuns).not.toHaveBeenCalled();
        expect(copy).not.toHaveBeenCalled();
      };

      it('refuses someone who cannot be assigned, as Run now does', async () => {
        assertEligible.mockRejectedValue(
          new BadRequestException({ code: 'VALIDATION_FAILED' }),
        );

        await expect(service.start(user, SPACE, caseDto)).rejects.toMatchObject(
          { response: { code: 'VALIDATION_FAILED' } },
        );
        expect(assertEligible).toHaveBeenCalledWith(ORG, SPACE, 'user-1');
        expect(from).not.toHaveBeenCalled();
        nothingMade();
      });

      it('does not ask whether a person can be assigned for a plain start', async () => {
        queueRoom();
        saved();

        await service.start(user, SPACE, dto);

        expect(assertEligible).not.toHaveBeenCalled();
      });

      it('refuses a CI setting', async () => {
        findRow.mockResolvedValue(
          config({ kind: 'ci_job', ci_url: 'https://ci.example.com' }),
        );

        await expect(service.start(user, SPACE, caseDto)).rejects.toMatchObject(
          { response: { code: 'NOT_A_RUNNER_SETTING' } },
        );
        nothingMade();
      });

      it('needs the right to create tests when the setting creates them', async () => {
        findRow.mockResolvedValue(config({ create_unmatched: true }));
        hasSpacePermission.mockImplementation(
          (_user: string, _org: string, _space: string, right: string) =>
            Promise.resolve(right !== 'create_tests'),
        );

        await expect(
          service.start(user, SPACE, caseDto),
        ).rejects.toBeInstanceOf(ForbiddenException);
        nothingMade();
      });

      it('refuses when the queue is full, before reading the case', async () => {
        next({
          data: null,
          error: null,
          count: AUTOMATION_LIMITS.queuedRuns,
        });

        await expect(service.start(user, SPACE, caseDto)).rejects.toMatchObject(
          { response: { code: 'QUEUE_FULL' } },
        );
        expect(from).toHaveBeenCalledTimes(1);
        nothingMade();
      });

      it('refuses a switched off runner', async () => {
        delete process.env.TM_RUNNER_ENABLED;

        await expect(service.start(user, SPACE, caseDto)).rejects.toMatchObject(
          { response: { code: 'RUNNER_DISABLED' } },
        );
        nothingMade();
      });

      it.each([
        ['archived', { is_archived: true }, 'ARCHIVED'],
        ['deprecated', { readiness: 'deprecated' }, 'VALIDATION_FAILED'],
      ])('refuses a %s case', async (_name, row, code) => {
        queueRoom();
        next(caseRow(row));

        await expect(service.start(user, SPACE, caseDto)).rejects.toMatchObject(
          { response: { code } },
        );
        nothingMade();
      });

      it('answers 404 for a case of another space or organization', async () => {
        queueRoom();

        const lookup = next({ data: null, error: null });

        await expect(service.start(user, SPACE, caseDto)).rejects.toMatchObject(
          { response: { code: 'NOT_FOUND' } },
        );
        expect(lookup.eq).toHaveBeenCalledWith('organization_id', ORG);
        expect(lookup.eq).toHaveBeenCalledWith('space_id', SPACE);
        nothingMade();
      });

      it('refuses a linked file that is gone, removes the copy and makes no execution', async () => {
        findRow.mockResolvedValue(
          config({ source: 'zip', zip_path: 'zips/a.zip' }),
        );
        zipFilePaths.mockResolvedValue(['tests/other.spec.ts']);
        queueRoom();
        next(caseRow({ automation_spec_path: 'tests/login.spec.ts' }));

        const error = await caught(service.start(user, SPACE, caseDto));

        expect(error).toMatchObject({
          response: {
            code: 'SPEC_NOT_FOUND',
            message: 'Not in the test project: tests/login.spec.ts',
          },
        });
        expect(remove).toHaveBeenCalledWith([copiedTo()]);
        expect(runNow).not.toHaveBeenCalled();
      });
    });

    describe('which execution', () => {
      it('makes one through Run now the first time and saves the case on the run', async () => {
        queueRoom();
        next(caseRow());
        earlierRun(null);

        const insert = saved();

        await service.start(user, SPACE, caseDto);

        expect(runNow).toHaveBeenCalledWith(user, SPACE, CASE, {
          request_id: 'request-1',
        });
        expect(firstArg(insert.insert)).toMatchObject({
          target: 'execution',
          execution_id: 'new-execution',
          plan_id: null,
          result_summary: { case_id: CASE },
        });
      });

      it('reuses the latest execution of this case and setting, and puts the run back', async () => {
        queueRoom();
        next(caseRow());

        const lookup = earlierRun('old-execution');
        const insert = saved();

        await service.start(user, SPACE, caseDto);

        expect(lookup.eq).toHaveBeenCalledWith('organization_id', ORG);
        expect(lookup.eq).toHaveBeenCalledWith('space_id', SPACE);
        expect(lookup.eq).toHaveBeenCalledWith('config_id', CONFIG);
        expect(lookup.eq).toHaveBeenCalledWith(
          'result_summary->>case_id',
          CASE,
        );
        expect(lookup.eq).toHaveBeenCalledWith('execution.is_archived', false);
        expect(lookup.order).toHaveBeenCalledWith('created_at', {
          ascending: false,
        });
        expect(runNow).not.toHaveBeenCalled();
        expect(addRuns).toHaveBeenCalledWith(user, SPACE, 'old-execution', [
          CASE,
        ]);
        expect(firstArg(insert.insert)).toMatchObject({
          execution_id: 'old-execution',
        });
      });

      it('removes the zip copy when the execution cannot be made', async () => {
        findRow.mockResolvedValue(
          config({ source: 'zip', zip_path: 'zips/a.zip' }),
        );
        runNow.mockRejectedValue(new ConflictException({ code: 'ARCHIVED' }));
        queueRoom();
        next(caseRow());
        earlierRun(null);

        await expect(
          service.start(user, SPACE, caseDto),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(remove).toHaveBeenCalledWith([copiedTo()]);
      });
    });

    describe('test files', () => {
      it('runs the linked file through the normal selection', async () => {
        queueRoom();
        next(caseRow({ automation_spec_path: 'tests/login.spec.ts' }));
        earlierRun();

        const insert = saved();

        await service.start(user, SPACE, caseDto);

        const row = firstArg(insert.insert) as {
          config_snapshot: Record<string, unknown>;
          result_summary: Record<string, unknown>;
        };

        expect(row.config_snapshot.spec_files).toEqual(['tests/login.spec.ts']);
        expect(row.result_summary).toEqual({
          spec_files: ['tests/login.spec.ts'],
          case_id: CASE,
        });
      });

      it('runs the whole project when nothing is linked', async () => {
        queueRoom();
        next(caseRow());
        earlierRun();

        const insert = saved();

        await service.start(user, SPACE, caseDto);

        const row = firstArg(insert.insert) as {
          config_snapshot: Record<string, unknown>;
          result_summary: Record<string, unknown>;
        };

        expect(row.config_snapshot).not.toHaveProperty('spec_files');
        expect(row.result_summary).toEqual({ case_id: CASE });
      });

      it('applies the framework rule to a linked file too', async () => {
        findRow.mockResolvedValue(config({ preset: 'maven' }));
        queueRoom();
        next(caseRow({ automation_spec_path: 'src/notes.txt' }));

        await expect(service.start(user, SPACE, caseDto)).rejects.toMatchObject(
          { response: { field: 'spec_files' } },
        );
        expect(runNow).not.toHaveBeenCalled();
      });
    });

    describe('when the run cannot be saved', () => {
      const failedInsert = {
        data: null,
        error: { code: '500', message: 'boom' },
      };

      it('removes an execution this request made', async () => {
        queueRoom();
        next(caseRow());
        earlierRun(null);
        next(failedInsert);
        next({ data: null, error: null, count: 0 });

        await expect(service.start(user, SPACE, caseDto)).rejects.toBeDefined();
        expect(removeExecution).toHaveBeenCalledWith(
          user,
          SPACE,
          'new-execution',
          false,
        );
      });

      it('never removes a reused execution', async () => {
        queueRoom();
        next(caseRow());
        earlierRun('old-execution');
        next(failedInsert);

        await expect(service.start(user, SPACE, caseDto)).rejects.toBeDefined();
        expect(removeExecution).not.toHaveBeenCalled();
      });

      it('never removes an execution an earlier try of this request made', async () => {
        runNow.mockResolvedValue({
          execution_id: 'new-execution',
          replayed: true,
        });
        queueRoom();
        next(caseRow());
        earlierRun(null);
        next(failedInsert);

        await expect(service.start(user, SPACE, caseDto)).rejects.toBeDefined();
        expect(removeExecution).not.toHaveBeenCalled();
      });

      it('keeps an execution another run already points to', async () => {
        queueRoom();
        next(caseRow());
        earlierRun(null);
        next(failedInsert);
        next({ data: null, error: null, count: 1 });

        await expect(service.start(user, SPACE, caseDto)).rejects.toBeDefined();
        expect(removeExecution).not.toHaveBeenCalled();
      });

      it('answers with the save error when the execution has results and stays', async () => {
        removeExecution.mockRejectedValue(
          new ConflictException({ code: 'HAS_RESULTS' }),
        );
        queueRoom();
        next(caseRow());
        earlierRun(null);
        next(failedInsert);
        next({ data: null, error: null, count: 0 });

        const error = await caught(service.start(user, SPACE, caseDto));

        expect(error).not.toMatchObject({
          response: { code: 'HAS_RESULTS' },
        });
      });

      it('answers with the winning run on a double click and removes nothing', async () => {
        const winner = {
          ...runRow(),
          result_summary: { case_id: CASE },
        } as unknown as TestAutomationRun;

        queueRoom();
        next(caseRow());
        earlierRun(null);
        next({ data: null, error: { code: '23505', message: 'duplicate' } });
        findByRequest.mockResolvedValueOnce(null);
        findByRequest.mockResolvedValueOnce(winner);

        await expect(service.start(user, SPACE, caseDto)).resolves.toBe(winner);
        expect(removeExecution).not.toHaveBeenCalled();
      });
    });

    describe('replay', () => {
      const earlier = (summary: Record<string, unknown>) =>
        ({
          ...runRow(),
          result_summary: summary,
        }) as unknown as TestAutomationRun;

      it('answers with the first start, checking nothing else', async () => {
        const first = earlier({ case_id: CASE });

        findByRequest.mockResolvedValue(first);

        await expect(service.start(user, SPACE, caseDto)).resolves.toBe(first);
        expect(findRow).not.toHaveBeenCalled();
        expect(runNow).not.toHaveBeenCalled();
      });

      it('accepts a retry when the first start took its file from the link', async () => {
        const first = earlier({
          case_id: CASE,
          spec_files: ['tests/login.spec.ts'],
        });

        findByRequest.mockResolvedValue(first);

        await expect(service.start(user, SPACE, caseDto)).resolves.toBe(first);
      });

      it.each([
        ['another test case', { case_id: 'case-2' }, caseDto],
        ['a run with no test case', {}, caseDto],
        ['a test case when none is sent', { case_id: CASE }, dto],
      ])('refuses %s', async (_name, summary, body) => {
        findByRequest.mockResolvedValue(earlier(summary));

        await expect(service.start(user, SPACE, body)).rejects.toMatchObject({
          response: { code: 'REQUEST_ID_REUSED' },
        });
      });

      it('still compares files that were chosen', async () => {
        findByRequest.mockResolvedValue(
          earlier({ case_id: CASE, spec_files: ['a.spec.ts'] }),
        );

        await expect(
          service.start(user, SPACE, { ...caseDto, spec_files: ['b.spec.ts'] }),
        ).rejects.toMatchObject({ response: { code: 'REQUEST_ID_REUSED' } });
      });
    });

    describe('restart', () => {
      const restart = { ...caseDto, target_id: EXECUTION };

      it('accepts both when the execution really is this case run', async () => {
        queueRoom();
        next(caseRow());

        const owner = earlierRun(EXECUTION);
        const insert = saved();

        await service.start(user, SPACE, restart);

        expect(owner.eq).toHaveBeenCalledWith('execution_id', EXECUTION);
        expect(owner.eq).toHaveBeenCalledWith('config_id', CONFIG);
        expect(addRuns).toHaveBeenCalledWith(user, SPACE, EXECUTION, [CASE]);
        expect(runNow).not.toHaveBeenCalled();
        expect(firstArg(insert.insert)).toMatchObject({
          execution_id: EXECUTION,
          result_summary: { case_id: CASE },
        });
      });

      it('refuses an execution this case never ran in', async () => {
        queueRoom();
        next(caseRow());
        earlierRun(null);

        await expect(service.start(user, SPACE, restart)).rejects.toMatchObject(
          { response: { code: 'VALIDATION_FAILED', field: 'case_id' } },
        );
        expect(runNow).not.toHaveBeenCalled();
        expect(addRuns).not.toHaveBeenCalled();
        expect(copy).not.toHaveBeenCalled();
      });

      it('keeps the files of the old run', async () => {
        queueRoom();
        next(caseRow({ automation_spec_path: 'tests/new.spec.ts' }));
        earlierRun(EXECUTION);

        const insert = saved();

        await service.start(user, SPACE, {
          ...restart,
          spec_files: ['tests/old.spec.ts'],
        });

        expect(firstArg(insert.insert)).toMatchObject({
          result_summary: { spec_files: ['tests/old.spec.ts'], case_id: CASE },
        });
      });
    });
  });

  describe('cancel', () => {
    it('needs write access and answers 404 outside the space', async () => {
      const read = next({ data: null, error: null });

      await expect(service.cancel(user, SPACE, RUN)).rejects.toMatchObject({
        status: 404,
      });
      expect(assertAvailable).toHaveBeenCalledWith(ORG, SPACE, { write: true });
      expect(read.eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(read.eq).toHaveBeenCalledWith('space_id', SPACE);
    });

    it('cancels a waiting run at once and removes its zip copy', async () => {
      next({
        data: runRow({ run_zip_path: 'runs/a.zip' }),
        error: null,
      });

      const write = next({
        data: runRow({
          status: 'CANCELLED',
          finished_at: '2026-11-02T01:00:00Z',
        }),
        error: null,
      });
      const run = await service.cancel(user, SPACE, RUN);
      const patch = firstArg(write.update);

      expect(patch).toMatchObject({ status: 'CANCELLED', run_zip_path: null });
      expect(patch).toHaveProperty('finished_at');
      expect(write.eq).toHaveBeenCalledWith('status', 'QUEUED');
      expect(write.eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(remove).toHaveBeenCalledWith(['runs/a.zip']);
      expect(run.status).toBe('CANCELLED');
      expect(log).toHaveBeenCalledTimes(1);
    });

    it('asks the runner to stop when it took the run at the same moment', async () => {
      next({ data: runRow({ run_zip_path: 'runs/a.zip' }), error: null });
      next({ data: null, error: null });
      next({
        data: runRow({ status: 'RUNNING', run_zip_path: 'runs/a.zip' }),
        error: null,
      });

      const write = next({
        data: runRow({
          status: 'RUNNING',
          cancel_requested_at: '2026-11-02T01:00:00Z',
        }),
        error: null,
      });

      await service.cancel(user, SPACE, RUN);

      expect(firstArg(write.update)).toHaveProperty('cancel_requested_at');
      expect(remove).not.toHaveBeenCalled();
    });

    it('asks a running run to stop and leaves its zip for the runner', async () => {
      next({
        data: runRow({ status: 'RUNNING', run_zip_path: 'runs/a.zip' }),
        error: null,
      });

      const write = next({
        data: runRow({
          status: 'RUNNING',
          cancel_requested_at: '2026-11-02T01:00:00Z',
        }),
        error: null,
      });
      const run = await service.cancel(user, SPACE, RUN);

      expect(write.eq).toHaveBeenCalledWith('status', 'RUNNING');
      expect(write.is).toHaveBeenCalledWith('cancel_requested_at', null);
      expect(firstArg(write.update)).not.toHaveProperty('status');
      expect(remove).not.toHaveBeenCalled();
      expect(run.cancel_requested_at).toBe('2026-11-02T01:00:00Z');
      expect(log).toHaveBeenCalledTimes(1);
    });

    it('changes nothing when a stop was already asked for', async () => {
      next({
        data: runRow({
          status: 'RUNNING',
          cancel_requested_at: '2026-11-02T01:00:00Z',
        }),
        error: null,
      });

      await service.cancel(user, SPACE, RUN);

      expect(from).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
    });

    it('returns a cancelled run unchanged, so a double click is no error', async () => {
      next({
        data: runRow({
          status: 'CANCELLED',
          finished_at: '2026-11-02T01:00:00Z',
        }),
        error: null,
      });

      await expect(service.cancel(user, SPACE, RUN)).resolves.toMatchObject({
        status: 'CANCELLED',
      });
      expect(from).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
    });

    it.each(['UPLOADING', 'DONE', 'ERROR', 'REQUESTED'])(
      'refuses a run that is %s',
      async (status) => {
        next({ data: runRow({ status }), error: null });

        const error = await caught(service.cancel(user, SPACE, RUN));

        expect(error).toBeInstanceOf(ConflictException);
        expect(error).toMatchObject({
          response: { code: 'RUN_NOT_CANCELLABLE' },
        });
        expect(from).toHaveBeenCalledTimes(1);
      },
    );

    it('refuses a run that is cleaning up, as its result is decided', async () => {
      next({
        data: runRow({
          status: 'RUNNING',
          result_summary: { stage: 'cleaning_up' },
        }),
        error: null,
      });

      await expect(service.cancel(user, SPACE, RUN)).rejects.toMatchObject({
        response: { code: 'RUN_NOT_CANCELLABLE' },
      });
      expect(from).toHaveBeenCalledTimes(1);
    });

    it.each(['preparing', 'installing', 'running'])(
      'still lets someone stop a run that is %s',
      async (stage) => {
        next({
          data: runRow({ status: 'RUNNING', result_summary: { stage } }),
          error: null,
        });

        const write = next({
          data: runRow({
            status: 'RUNNING',
            cancel_requested_at: '2026-11-02T01:00:00Z',
          }),
          error: null,
        });

        await service.cancel(user, SPACE, RUN);

        expect(firstArg(write.update)).toHaveProperty('cancel_requested_at');
      },
    );

    it('refuses when the runner moved on to saving results at the same moment', async () => {
      next({ data: runRow({ status: 'RUNNING' }), error: null });
      next({ data: null, error: null });
      next({ data: runRow({ status: 'UPLOADING' }), error: null });

      await expect(service.cancel(user, SPACE, RUN)).rejects.toMatchObject({
        response: { code: 'RUN_NOT_CANCELLABLE' },
      });
      expect(log).not.toHaveBeenCalled();
    });

    it('returns the run when someone else asked to stop it at the same moment', async () => {
      next({ data: runRow({ status: 'RUNNING' }), error: null });
      next({ data: null, error: null });
      next({
        data: runRow({
          status: 'RUNNING',
          cancel_requested_at: '2026-11-02T01:00:00Z',
        }),
        error: null,
      });

      await expect(service.cancel(user, SPACE, RUN)).resolves.toMatchObject({
        cancel_requested_at: '2026-11-02T01:00:00Z',
      });
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it.each(['QUEUED', 'RUNNING', 'UPLOADING'])(
      'refuses a runner run that is %s',
      async (status) => {
        next({ data: runRow({ status }), error: null });

        await expect(service.remove(user, SPACE, RUN)).rejects.toMatchObject({
          status: 409,
          response: { code: 'RUN_IN_PROGRESS' },
        });
        expect(from).toHaveBeenCalledTimes(1);
        expect(remove).not.toHaveBeenCalled();
      },
    );

    it('deletes a finished runner run and its zip copy', async () => {
      next({
        data: runRow({ status: 'DONE', run_zip_path: 'runs/a.zip' }),
        error: null,
      });

      const removed = next({ data: { id: RUN }, error: null });

      removed.delete = jest.fn(() => removed);

      await service.remove(user, SPACE, RUN);

      expect(removed.delete).toHaveBeenCalledTimes(1);
      expect(removed.eq).toHaveBeenCalledWith('kind', 'docker');
      expect(remove).toHaveBeenCalledWith(['runs/a.zip']);
      expect(log).toHaveBeenCalledWith(
        user,
        'test_automation_run',
        RUN,
        'delete',
        expect.objectContaining({ status: 'DONE' }),
      );
    });

    it('keeps the copy when the delete finds nothing', async () => {
      next({
        data: runRow({ status: 'ERROR', run_zip_path: 'runs/a.zip' }),
        error: null,
      });

      const removed = next({ data: null, error: null });

      removed.delete = jest.fn(() => removed);

      await expect(service.remove(user, SPACE, RUN)).rejects.toMatchObject({
        status: 404,
      });
      expect(remove).not.toHaveBeenCalled();
    });
  });

  describe('a CI run', () => {
    it('is still cancelled only through the CI watcher', async () => {
      next({
        data: runRow({ kind: 'ci_job', status: 'REQUESTED' }),
        error: null,
      });

      await expect(service.cancel(user, SPACE, RUN)).rejects.toMatchObject({
        status: 409,
        response: { code: 'RUN_NOT_CANCELLABLE' },
      });
      expect(isCancellable).toHaveBeenCalled();
      expect(from).toHaveBeenCalledTimes(1);
    });

    it('has jobs read through the watcher, while a runner run has none', async () => {
      next({ data: runRow(), error: null });

      await expect(service.ciJobs(ORG, SPACE, RUN)).resolves.toEqual([]);
      expect(jobs).not.toHaveBeenCalled();

      const ci = runRow({ kind: 'ci_job', status: 'REQUESTED' });

      next({ data: ci, error: null });
      jobs.mockResolvedValue([{ id: 1 }]);

      await expect(service.ciJobs(ORG, SPACE, RUN)).resolves.toEqual([
        { id: 1 },
      ]);
      expect(jobs).toHaveBeenCalledWith(ci);
    });
  });

  describe('list', () => {
    const query: ListTestAutomationRunsQueryDto = { page: 2, pageSize: 10 };

    it('reads the page of this space, newest first', async () => {
      const read = next({
        data: [runRow({ run_zip_path: 'runs/a.zip' })],
        error: null,
        count: 11,
      });
      const page = await service.list(ORG, SPACE, query);

      expect(assertAvailable).toHaveBeenCalledWith(ORG, SPACE);
      expect(read.eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(read.eq).toHaveBeenCalledWith('space_id', SPACE);
      expect(read.order).toHaveBeenCalledWith('created_at', {
        ascending: false,
      });
      expect(read.range).toHaveBeenCalledWith(10, 19);
      expect(page).toMatchObject({ total: 11, page: 2, pageSize: 10 });
      expect(page.items[0]).toMatchObject({ id: RUN });
      expect(page.items[0]).not.toHaveProperty('run_zip_path');
      expect(page.items[0]).not.toHaveProperty('organization_id');
    });

    it('shows only the runs one person started when asked', async () => {
      const read = next({ data: [], error: null, count: 0 });

      await service.list(ORG, SPACE, { ...query, startedBy: 'user-7' });

      expect(read.eq).toHaveBeenCalledWith('started_by', 'user-7');
    });

    it('shows everyone runs when no person is given', async () => {
      const read = next({ data: [], error: null, count: 0 });

      await service.list(ORG, SPACE, query);

      expect(read.eq).not.toHaveBeenCalledWith('started_by', expect.anything());
    });

    it('says who started each listed run', async () => {
      next({ data: [runRow({ started_by: 'user-7' })], error: null, count: 1 });

      const page = await service.list(ORG, SPACE, query);

      expect(page.items[0]).toMatchObject({ started_by: 'user-7' });
    });

    it.each([
      ['started:asc', 'created_at', true],
      ['started:desc', 'created_at', false],
      ['setting:asc', 'config_snapshot->>name', true],
      ['setting:desc', 'config_snapshot->>name', false],
      ['status:asc', 'status', true],
      ['status:desc', 'status', false],
      ['setting', 'config_snapshot->>name', false],
    ])('sorts by %s', async (sort, column, ascending) => {
      const read = next({ data: [], error: null, count: 0 });

      await service.list(ORG, SPACE, { ...query, sort });

      expect(read.order).toHaveBeenNthCalledWith(1, column, { ascending });
      expect(read.order).toHaveBeenNthCalledWith(2, 'run_no', {
        ascending,
        nullsFirst: false,
      });
      expect(read.order).toHaveBeenLastCalledWith('created_at', { ascending });
    });

    it.each(['started', 'setting:asc', 'status:desc'])(
      'accepts the sort %s',
      async (sort) => {
        const errors = await validate(
          plainToInstance(ListTestAutomationRunsQueryDto, { sort }),
        );

        expect(errors).toEqual([]);
      },
    );

    it.each(['target', 'result:asc', 'started:up', 'id', 'status:asc;drop'])(
      'refuses the sort %s',
      async (sort) => {
        const errors = await validate(
          plainToInstance(ListTestAutomationRunsQueryDto, { sort }),
        );

        expect(errors).toHaveLength(1);
      },
    );

    it('leaves the test names and saved log out of each row, and keeps everything else', async () => {
      const summary = {
        stage: 'running',
        live_log: 'output',
        counts: { total: 2, passed: 1, failed: 1, skipped: 0 },
        tests: [{ name: 'a', status: 'passed' }],
        saved_log: 'end of the output',
        spec_files: ['a.spec.ts'],
        case_id: 'case-1',
        cleanup: 'removed',
      };

      next({
        data: [runRow({ result_summary: summary })],
        error: null,
        count: 1,
      });

      const page = await service.list(ORG, SPACE, query);

      expect(page.items[0].result_summary).toEqual({
        stage: 'running',
        live_log: 'output',
        counts: { total: 2, passed: 1, failed: 1, skipped: 0 },
        spec_files: ['a.spec.ts'],
        case_id: 'case-1',
        cleanup: 'removed',
      });
      expect(summary.tests).toHaveLength(1);
      expect(summary.saved_log).toBe('end of the output');
    });

    it('does not read the zip path at all', async () => {
      const read = next({ data: [], error: null, count: 0 });

      await service.list(ORG, SPACE, {});

      expect((read.select.mock.calls as unknown[][])[0]?.[0]).not.toContain(
        'run_zip_path',
      );
    });

    it('filters only by what was asked for', async () => {
      const none = next({ data: [], error: null, count: 0 });

      await service.list(ORG, SPACE, {});

      // Organization, space, and CI jobs only unless another kind is asked for.
      expect(none.eq).toHaveBeenCalledTimes(3);
      expect(none.eq).toHaveBeenCalledWith('kind', 'ci_job');

      const all = next({ data: [], error: null, count: 0 });

      await service.list(ORG, SPACE, {
        executionId: EXECUTION,
        planId: 'plan-1',
        configId: CONFIG,
      });

      expect(all.eq).toHaveBeenCalledWith('execution_id', EXECUTION);
      expect(all.eq).toHaveBeenCalledWith('plan_id', 'plan-1');
      expect(all.eq).toHaveBeenCalledWith('config_id', CONFIG);
    });

    it('lists runner runs or every kind when asked', async () => {
      const runner = next({ data: [], error: null, count: 0 });

      await service.list(ORG, SPACE, { kind: 'docker' });

      expect(runner.eq).toHaveBeenCalledWith('kind', 'docker');

      const every = next({ data: [], error: null, count: 0 });

      await service.list(ORG, SPACE, { kind: 'all' });

      expect(every.eq).not.toHaveBeenCalledWith('kind', expect.anything());
    });

    it('gives an empty page with the real total past the end', async () => {
      next({ data: null, error: { code: 'PGRST103', message: 'past end' } });
      next({ data: null, error: null, count: 3 });

      await expect(service.list(ORG, SPACE, query)).resolves.toEqual({
        items: [],
        total: 3,
        page: 2,
        pageSize: 10,
      });
    });
  });

  describe('get', () => {
    it('reads one run of the space without its zip path', async () => {
      const read = next({
        data: runRow({ run_zip_path: 'runs/a.zip' }),
        error: null,
      });
      const run = await service.get(ORG, SPACE, RUN);

      expect(assertAvailable).toHaveBeenCalledWith(ORG, SPACE);
      expect(read.eq).toHaveBeenCalledWith('id', RUN);
      expect(read.eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(read.eq).toHaveBeenCalledWith('space_id', SPACE);
      expect(run).toMatchObject({
        id: RUN,
        config_name: 'Browser tests',
        result_summary: {},
      });
      expect(run).not.toHaveProperty('run_zip_path');
    });

    it('names the run execution like the list does', async () => {
      next({
        data: {
          ...runRow(),
          execution: { task: { key: 'SPACE-T164' } },
          plan: null,
        },
        error: null,
      });

      const run = await service.get(ORG, SPACE, RUN);

      expect(run.target_key).toBe('SPACE-T164');
      expect(run).not.toHaveProperty('execution');
    });

    it('returns the test names and saved log the list leaves out', async () => {
      const tests = [{ name: 'a', status: 'passed' }];

      next({
        data: runRow({
          result_summary: { tests, saved_log: 'end of the output' },
        }),
        error: null,
      });

      const run = await service.get(ORG, SPACE, RUN);

      expect(run.result_summary).toEqual({
        tests,
        saved_log: 'end of the output',
      });
    });

    it('answers 404 for a run outside the space', async () => {
      next({ data: null, error: null });

      await expect(service.get(ORG, SPACE, RUN)).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe('forViewer', () => {
    const viewer = { userId: 'viewer-1', organizationId: ORG } as RequestUser;
    const ciRun = {
      id: 'r1',
      kind: 'ci_job',
      error_message: 'CI said: bad token abc123',
    } as TestAutomationRun;
    const dockerRun = {
      id: 'r2',
      kind: 'docker',
      error_message: 'The tests could not start',
    } as TestAutomationRun;

    it('hides the CI answer from people who cannot edit the setting, and only that', async () => {
      hasSpacePermission.mockResolvedValue(false);

      await expect(
        service.forViewer(viewer, SPACE, [ciRun, dockerRun]),
      ).resolves.toEqual([{ ...ciRun, error_message: null }, dockerRun]);
      expect(hasSpacePermission).toHaveBeenCalledWith(
        'viewer-1',
        ORG,
        SPACE,
        'edit_space_settings',
      );
    });

    it('keeps the CI answer for people who can edit the setting', async () => {
      hasSpacePermission.mockResolvedValue(true);

      await expect(service.forViewer(viewer, SPACE, [ciRun])).resolves.toEqual([
        ciRun,
      ]);
    });

    it('asks nothing when no run has a CI answer', async () => {
      hasSpacePermission.mockClear();

      await expect(
        service.forViewer(viewer, SPACE, [dockerRun]),
      ).resolves.toEqual([dockerRun]);
      expect(hasSpacePermission).not.toHaveBeenCalled();
    });
  });

  describe('specFiles', () => {
    const zipConfig = (overrides: Partial<TestAutomationConfigRow> = {}) =>
      config({
        source: 'zip',
        repo_url: null,
        zip_path: 'setting.zip',
        ...overrides,
      });

    const linkedRows = (...paths: string[]) => ({
      data: paths.map((path) => ({
        test_case: { automation_spec_path: path },
      })),
      error: null,
    });

    it('needs the right to manage test runs', async () => {
      hasSpacePermission.mockResolvedValue(false);

      await expect(
        service.specFiles(user, SPACE, CONFIG, {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(hasSpacePermission).toHaveBeenCalledWith(
        'user-1',
        ORG,
        SPACE,
        'manage_test_runs',
      );
      expect(findRow).not.toHaveBeenCalled();
    });

    it('needs Test Management to be available', async () => {
      assertAvailable.mockRejectedValue(new ForbiddenException());

      await expect(
        service.specFiles(user, SPACE, CONFIG, {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(findRow).not.toHaveBeenCalled();
    });

    it('refuses a CI job', async () => {
      findRow.mockResolvedValue(config({ kind: 'ci_job' }));

      const reason = (await caught(
        service.specFiles(user, SPACE, CONFIG, {}),
      )) as BadRequestException;

      expect(reason.getResponse()).toMatchObject({
        code: 'NOT_A_RUNNER_SETTING',
      });
    });

    it('lists what the framework can run, under the tests folder', async () => {
      findRow.mockResolvedValue(zipConfig({ work_dir: 'e2e' }));
      zipFilePaths.mockResolvedValue([
        'e2e/a.spec.js',
        'e2e/.env',
        'e2e/helper.js',
        'other/b.spec.js',
      ]);

      await expect(service.specFiles(user, SPACE, CONFIG, {})).resolves.toEqual(
        { files: ['a.spec.js'], linked: [], own_command: false },
      );
      expect(zipFilePaths).toHaveBeenCalledWith('setting.zip');
      expect(from).not.toHaveBeenCalled();
    });

    it('never returns anything but names', async () => {
      findRow.mockResolvedValue(zipConfig());
      zipFilePaths.mockResolvedValue(['a.spec.js']);

      const text = JSON.stringify(
        await service.specFiles(user, SPACE, CONFIG, {}),
      );

      expect(text).not.toContain('setting.zip');
      expect(text).not.toContain('BASE_URL');
    });

    it('says when the saved zip holds no files at all', async () => {
      findRow.mockResolvedValue(zipConfig());
      zipFilePaths.mockResolvedValue([]);

      await expect(service.specFiles(user, SPACE, CONFIG, {})).resolves.toEqual(
        { files: [], linked: [], own_command: false, empty: true },
      );
    });

    it('returns an empty list for a setting with no zip yet', async () => {
      findRow.mockResolvedValue(zipConfig({ zip_path: null }));

      await expect(service.specFiles(user, SPACE, CONFIG, {})).resolves.toEqual(
        { files: [], linked: [], own_command: false },
      );
      expect(zipFilePaths).not.toHaveBeenCalled();
    });

    it('reads links from the cases of an execution, in this organization and space', async () => {
      findRow.mockResolvedValue(zipConfig());
      zipFilePaths.mockResolvedValue(['a.spec.js', 'b.spec.js']);

      const chain = next(linkedRows('b.spec.js', 'b.spec.js', 'gone.spec.js'));

      await expect(
        service.specFiles(user, SPACE, CONFIG, {
          target: 'execution',
          target_id: EXECUTION,
        }),
      ).resolves.toMatchObject({ linked: ['b.spec.js'] });
      expect(from).toHaveBeenCalledWith('test_runs');
      expect(chain.eq).toHaveBeenCalledWith('execution_id', EXECUTION);
      expect(chain.eq).toHaveBeenCalledWith('test_case.organization_id', ORG);
      expect(chain.eq).toHaveBeenCalledWith('test_case.space_id', SPACE);
      expect(chain.eq).toHaveBeenCalledWith('test_case.is_archived', false);
    });

    it('reads links from the cases of a plan', async () => {
      findRow.mockResolvedValue(zipConfig());

      const chain = next(linkedRows());

      await service.specFiles(user, SPACE, CONFIG, {
        target: 'plan',
        target_id: 'plan-1',
      });

      expect(from).toHaveBeenCalledWith('test_plan_tests');
      expect(chain.eq).toHaveBeenCalledWith('plan_id', 'plan-1');
    });

    it('stops on a failed read of the links', async () => {
      findRow.mockResolvedValue(zipConfig());
      next({ data: null, error: { message: 'down' } });

      await expect(
        service.specFiles(user, SPACE, CONFIG, {
          target: 'plan',
          target_id: 'plan-1',
        }),
      ).rejects.toBeDefined();
    });

    it('has no list for a Git setting, and keeps every link', async () => {
      next(linkedRows('tests/a.spec.js'));

      await expect(
        service.specFiles(user, SPACE, CONFIG, {
          target: 'plan',
          target_id: 'plan-1',
        }),
      ).resolves.toEqual({
        files: [],
        linked: ['tests/a.spec.js'],
        own_command: false,
      });
      expect(zipFilePaths).not.toHaveBeenCalled();
    });

    it.each<[Partial<TestAutomationConfigRow>, boolean]>([
      [{ preset: 'custom', command: 'make' }, true],
      [{ preset: 'pytest', command: 'pytest -q' }, true],
      [{ preset: 'pytest', command: null }, false],
    ])('says whether %j has its own command', async (overrides, own) => {
      findRow.mockResolvedValue(config(overrides));

      await expect(
        service.specFiles(user, SPACE, CONFIG, {}),
      ).resolves.toMatchObject({ own_command: own });
    });
  });

  describe('a setting that detects its framework', () => {
    const FILES = [
      'package.json',
      'tests/a.test.js',
      'tests/b.cy.js',
      'README.md',
    ];
    const autoZip = (overrides: Partial<TestAutomationConfigRow> = {}) =>
      config({
        preset: 'auto',
        image_key: 'auto',
        source: 'zip',
        repo_url: null,
        zip_path: 'setting.zip',
        result_paths: ['.xisuite-results/results.xml'],
        ...overrides,
      });
    const jest30 = {
      preset: 'jest',
      image_key: 'node-24',
      reason: 'package.json devDependencies',
    };
    const queueOpen = () => {
      next({ data: null, error: null, count: 0 });
      next({ data: null, error: null, count: 0 }); // no run of this setting is going here

      return next({ data: runRow(), error: null });
    };

    it('lists the test files of the detected framework', async () => {
      findRow.mockResolvedValue(autoZip());
      zipFramework.mockResolvedValue({ files: FILES, detected: jest30 });

      await expect(service.specFiles(user, SPACE, CONFIG, {})).resolves.toEqual(
        { files: ['tests/a.test.js'], linked: [], own_command: false },
      );
      expect(zipFramework).toHaveBeenCalledWith('setting.zip', null);
      expect(zipFilePaths).not.toHaveBeenCalled();
    });

    it('lists any Node.js test file while no framework is found', async () => {
      findRow.mockResolvedValue(autoZip());
      zipFramework.mockResolvedValue({ files: FILES, detected: null });

      await expect(
        service.specFiles(user, SPACE, CONFIG, {}),
      ).resolves.toMatchObject({ files: ['tests/a.test.js', 'tests/b.cy.js'] });
    });

    it('queues an auto run while the runner is on, with no image of its own', async () => {
      findRow.mockResolvedValue(autoZip());

      const inserted = queueOpen();

      await service.start(user, SPACE, dto);

      expect(firstArg(inserted.insert).config_snapshot).toMatchObject({
        preset: 'auto',
        image_key: 'auto',
      });
    });

    it('still refuses the auto image on a named framework', async () => {
      findRow.mockResolvedValue(autoZip({ preset: 'jest' }));

      await expect(service.start(user, SPACE, dto)).rejects.toMatchObject({
        response: { code: 'IMAGE_NOT_ALLOWED' },
      });
    });

    it('checks chosen files against the detected framework on the run’s copy', async () => {
      findRow.mockResolvedValue(autoZip());
      zipFramework.mockResolvedValue({ files: FILES, detected: jest30 });
      queueOpen();

      await expect(
        service.start(user, SPACE, { ...dto, spec_files: ['tests/a.test.js'] }),
      ).resolves.toBeDefined();
      expect(zipFramework).toHaveBeenCalledWith(copiedTo(), null);
    });

    it('refuses a file the detected framework would not run, and removes the copy', async () => {
      findRow.mockResolvedValue(autoZip());
      zipFramework.mockResolvedValue({ files: FILES, detected: jest30 });
      next({ data: null, error: null, count: 0 });
      next({ data: null, error: null, count: 0 }); // no run of this setting is going here

      const reason = (await caught(
        service.start(user, SPACE, { ...dto, spec_files: ['tests/b.cy.js'] }),
      )) as BadRequestException;

      expect(reason.getResponse()).toMatchObject({ code: 'SPEC_NOT_FOUND' });
      expect(remove).toHaveBeenCalledWith([copiedTo()]);
    });
  });
});
