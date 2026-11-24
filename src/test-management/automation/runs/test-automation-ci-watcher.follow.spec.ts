import {
  ForbiddenException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';

import type { PermissionsService } from '../../../permissions/permissions.service';
import type { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import type { TestManagementAccessService } from '../../access/test-management-access.service';
import type { TestExecutionsService } from '../../executions/test-executions.service';
import type { TestPlanTestsService } from '../../plans/test-plan-tests.service';
import type { TestRunsService } from '../../runs/test-runs.service';
import type { CucumberResultsService } from '../../transfer/cucumber-results/cucumber-results.service';
import { readZipEntries } from '../../transfer/shared/zip-entries';
import type { RunRow } from '../test-automation-ci.service';
import { TestAutomationCiWatcherService } from '../test-automation-ci-watcher.service';
import type { TestAutomationGitService } from '../test-automation-git.service';
import {
  getRun,
  GithubActionsError,
  listArtifacts,
  listRunJobs,
  readJobLog,
} from '../test-automation-github.client';

jest.mock('../test-automation-github.client', () => ({
  ...jest.requireActual<object>('../test-automation-github.client'),
  getRun: jest.fn(),
  listArtifacts: jest.fn(),
  listRunJobs: jest.fn(),
  readJobLog: jest.fn(),
  downloadArtifact: jest.fn().mockResolvedValue(Buffer.from('zip')),
}));

jest.mock('../../transfer/shared/zip-entries', () => ({
  readZipEntries: jest.fn(),
}));

type Chain = Record<string, jest.Mock> & {
  then: (done: (value: unknown) => unknown) => Promise<unknown>;
};

const created = (minute: number) =>
  new Date(Date.UTC(2026, 10, 5, 10, minute)).toISOString();

const rowOf = (extra: object = {}, ci: object = {}) =>
  ({
    id: 'run-1',
    organization_id: 'org-1',
    space_id: 'space-1',
    target: 'execution',
    execution_id: 'exec-1',
    plan_id: null,
    started_by: 'user-1',
    created_at: new Date().toISOString(),
    result_summary: {
      ci: { state: 'running', full_name: 'acme/tests', run_id: 123, ...ci },
    },
    ...extra,
  }) as unknown as RunRow;

interface Internals {
  watch(): Promise<void>;
  follow(row: RunRow): Promise<void>;
  jobLog(row: RunRow, jobId: string): Promise<unknown>;
  record(
    row: RunRow,
    access: unknown,
    ci: unknown,
    conclusion: string | null,
  ): Promise<{ state: string; message?: string }>;
}

describe('TestAutomationCiWatcherService, following runs', () => {
  const find = jest.fn();
  const actionsAccess = jest.fn();
  const assertAvailable = jest.fn();
  const commit = jest.fn();
  const updates: Record<string, unknown>[] = [];
  let chain: Chain;
  let rows: RunRow[] = [];

  const service = new TestAutomationCiWatcherService(
    {
      getClient: () => ({ from: () => chain }),
    } as unknown as SupabaseAdminService,
    {
      findRepositoryByName: find,
      actionsAccess,
    } as unknown as TestAutomationGitService,
    { assertAvailable } as unknown as TestManagementAccessService,
    {
      hasSpacePermission: jest.fn().mockResolvedValue(true),
    } as unknown as PermissionsService,
    { commit } as unknown as CucumberResultsService,
    {} as unknown as TestExecutionsService,
    {} as unknown as TestRunsService,
    {} as unknown as TestPlanTestsService,
  ) as unknown as Internals;

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(() => {
    updates.length = 0;
    rows = [];
    find.mockReset().mockResolvedValue({ state: 'connected' });
    actionsAccess.mockReset().mockResolvedValue({ token: 'ghs_token' });
    assertAvailable.mockReset().mockResolvedValue(undefined);
    commit.mockReset();
    (getRun as jest.Mock).mockReset();

    chain = {
      then: (done) => Promise.resolve({ data: rows, error: null }).then(done),
    } as Chain;

    for (const name of ['select', 'eq', 'in', 'order', 'limit', 'gt', 'lt']) {
      chain[name] = jest.fn(() => chain);
    }

    chain.update = jest.fn((payload: Record<string, unknown>) => {
      updates.push(payload);

      return chain;
    });
  });

  describe('a long list of runs', () => {
    it('continues from where it stopped, then starts over', async () => {
      const follow = jest.spyOn(service, 'follow').mockResolvedValue(undefined);

      rows = Array.from({ length: 50 }, (_, index) =>
        rowOf({ id: `r${index}`, created_at: created(index) }),
      );
      await service.watch();
      expect(chain.gt).not.toHaveBeenCalled();
      expect(follow).toHaveBeenCalledTimes(50);

      rows = [rowOf({ id: 'newer', created_at: created(55) })];
      await service.watch();
      expect(chain.gt).toHaveBeenCalledWith('created_at', created(49));

      chain.gt.mockClear();
      await service.watch();
      expect(chain.gt).not.toHaveBeenCalled();

      follow.mockRestore();
    });
  });

  describe('a run never confirmed as sent', () => {
    it('ends it with its own code, only after the sending time has passed', async () => {
      await service.watch();

      expect(updates[0]).toMatchObject({
        status: 'ERROR',
        error_code: 'CI_INTERRUPTED',
        result_summary: {},
      });
      expect(chain.eq).toHaveBeenCalledWith(
        'result_summary->>send_pending',
        'true',
      );

      const [, before] = chain.lt.mock.calls[0] as [string, string];

      expect(Date.now() - Date.parse(before)).toBeGreaterThanOrEqual(
        2 * 60 * 1000 - 1000,
      );
    });
  });

  describe('a connection that is unavailable', () => {
    const saved = () =>
      (updates[0].result_summary as { ci: { message?: string } }).ci;

    it('says so once, keeping the run followed', async () => {
      find.mockResolvedValue({ state: 'unavailable' });

      await service.follow(rowOf());

      expect(saved().message).toContain('GitHub connection is unavailable');
      expect(updates[0]).not.toHaveProperty('finished_at');

      updates.length = 0;
      await service.follow(
        rowOf(
          {},
          {
            message:
              "The GitHub connection is unavailable, so this run can't be followed. It is checked again each minute for 24 hours.",
          },
        ),
      );
      expect(updates).toHaveLength(0);
    });

    it('clears the note when the connection is back', async () => {
      (getRun as jest.Mock).mockResolvedValue({ status: 'in_progress' });

      await service.follow(rowOf({}, { message: 'old note' }));

      expect(saved().message).toBeUndefined();
    });

    it('names the connection, not GitHub, when it gives up', async () => {
      await service.follow(
        rowOf(
          { created_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString() },
          {
            message:
              "The GitHub connection is unavailable, so this run can't be followed. It is checked again each minute for 24 hours.",
          },
        ),
      );

      expect(saved().message).toContain('connection stayed unavailable');
    });
  });

  describe('checking rights before recording', () => {
    const record = () =>
      service.record(rowOf(), {}, { run_id: 123 }, 'success');

    it.each([
      ['a database fault', new Error('connection lost')],
      ['a server error', new InternalServerErrorException('db down')],
    ])('tries again after %s, keeping the results', async (_name, failure) => {
      assertAvailable.mockRejectedValue(failure);

      await expect(record()).rejects.toBe(failure);
    });

    it('stops on a real refusal', async () => {
      assertAvailable.mockRejectedValue(new ForbiddenException('off'));

      await expect(record()).resolves.toMatchObject({
        state: 'results_failed',
      });
    });
  });

  describe('the commit and branch of a run', () => {
    const SHA = 'f'.repeat(40);
    const savedCi = () =>
      (updates[0].result_summary as { ci: Record<string, unknown> }).ci;

    it('saves them the first time GitHub gives them', async () => {
      (getRun as jest.Mock).mockResolvedValue({
        status: 'in_progress',
        head_sha: SHA,
        head_branch: 'main',
        run_attempt: 1,
        event: 'workflow_dispatch',
      });

      await service.follow(rowOf());

      expect(savedCi()).toMatchObject({
        state: 'running',
        head_sha: SHA,
        head_branch: 'main',
        run_attempt: 1,
        event: 'workflow_dispatch',
      });
    });

    it('does not save again when nothing changed', async () => {
      (getRun as jest.Mock).mockResolvedValue({
        status: 'in_progress',
        head_sha: SHA,
        head_branch: 'main',
      });

      await service.follow(rowOf({}, { head_sha: SHA, head_branch: 'main' }));

      expect(updates).toHaveLength(0);
    });

    it('never keeps a sha in the wrong shape', async () => {
      (getRun as jest.Mock).mockResolvedValue({
        status: 'queued',
        head_sha: '<script>',
      });

      await service.follow(rowOf({}, { state: 'queued' }));

      expect(updates).toHaveLength(0);
    });

    it('keeps them on a finished run', async () => {
      (getRun as jest.Mock).mockResolvedValue({
        status: 'completed',
        conclusion: 'cancelled',
        head_sha: SHA,
      });

      await service.follow(rowOf());

      expect(savedCi()).toMatchObject({ state: 'cancelled', head_sha: SHA });
    });
  });

  describe('a job log', () => {
    const log = { text: 'done', truncated: false, bytes: 4 };

    beforeEach(() => {
      (listRunJobs as jest.Mock)
        .mockReset()
        .mockResolvedValue([{ id: '55' }, { id: '56' }]);
      (readJobLog as jest.Mock).mockReset().mockResolvedValue(log);
    });

    it('reads the log of a job of this run', async () => {
      await expect(service.jobLog(rowOf(), '55')).resolves.toEqual(log);
      expect(listRunJobs).toHaveBeenCalledWith({ token: 'ghs_token' }, 123);
      expect(readJobLog).toHaveBeenCalledWith({ token: 'ghs_token' }, '55');
    });

    it.each([['abc'], ['1/../2'], ['1'.repeat(21)], ['']])(
      'refuses the job id %p before asking GitHub',
      async (jobId) => {
        await expect(service.jobLog(rowOf(), jobId)).rejects.toMatchObject({
          status: 400,
        });
        expect(listRunJobs).not.toHaveBeenCalled();
      },
    );

    it('refuses a job of another run', async () => {
      await expect(service.jobLog(rowOf(), '99')).rejects.toMatchObject({
        status: 404,
        response: { code: 'NOT_FOUND' },
      });
      expect(readJobLog).not.toHaveBeenCalled();
    });

    it('has nothing to read for a run without a workflow', async () => {
      await expect(
        service.jobLog(rowOf({ result_summary: {} }), '55'),
      ).rejects.toMatchObject({ status: 404 });
    });

    it.each([404, 410])(
      'says a log GitHub answers %s for is not there yet or expired',
      async (status) => {
        (readJobLog as jest.Mock).mockRejectedValue(
          new GithubActionsError(status, 'gone'),
        );

        await expect(service.jobLog(rowOf(), '55')).rejects.toMatchObject({
          status: 404,
          response: { code: 'CI_LOG_NOT_AVAILABLE' },
        });
      },
    );

    it.each([401, 403])(
      'never passes on GitHub’s %s, so nobody is signed out',
      async (status) => {
        (readJobLog as jest.Mock).mockRejectedValue(
          new GithubActionsError(status, 'denied'),
        );

        await expect(service.jobLog(rowOf(), '55')).rejects.toMatchObject({
          status: 503,
          response: { code: 'GITHUB_UNAVAILABLE' },
        });
      },
    );

    it('says when GitHub no longer has the run', async () => {
      (listRunJobs as jest.Mock).mockRejectedValue(
        new GithubActionsError(404, 'gone'),
      );

      await expect(service.jobLog(rowOf(), '55')).rejects.toMatchObject({
        response: { code: 'CI_RUN_GONE' },
      });
    });

    it('needs the connection', async () => {
      find.mockResolvedValue({ state: 'unavailable' });

      await expect(service.jobLog(rowOf(), '55')).rejects.toMatchObject({
        status: 409,
        response: { code: 'GIT_CONNECTION_UNAVAILABLE' },
      });
    });
  });

  describe('messages about results', () => {
    const report = Buffer.from(
      '<testsuite name="s"><testcase classname="c" name="n"/></testsuite>',
    );
    const record = () =>
      service.record(rowOf(), {}, { run_id: 123 }, 'success');

    it('says when a report file could not be kept', async () => {
      (listArtifacts as jest.Mock).mockResolvedValue([
        { id: 1, name: 'results', size_in_bytes: 10, expired: false },
      ]);
      (readZipEntries as jest.Mock).mockResolvedValue({
        entries: [{ name: 'r.xml', data: report }],
        skipped: [],
      });
      commit.mockResolvedValue({ applied: [{}], file_saved: false });

      await expect(record()).resolves.toMatchObject({
        state: 'passed',
        message:
          'Results were recorded, but these report files could not be kept: r.xml.',
      });
    });

    it('does not claim the upload step is missing', async () => {
      (listArtifacts as jest.Mock).mockResolvedValue([]);

      const { message } = await record();

      expect(message).toContain('tests write a JUnit or Cucumber file');
      expect(message).not.toContain('Add an upload-artifact step');
    });
  });
});
