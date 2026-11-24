import { Logger } from '@nestjs/common';

import type { CiServersService } from '../../../ci-servers/ci-servers.service';
import { packSecretForStorage } from '../../../lib/crypto/encryption';
import type { PermissionsService } from '../../../permissions/permissions.service';
import type { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import type { TestManagementAccessService } from '../../access/test-management-access.service';
import type { TestExecutionsService } from '../../executions/test-executions.service';
import type { TestPlanTestsService } from '../../plans/test-plan-tests.service';
import type { TestRunsService } from '../../runs/test-runs.service';
import type { CucumberResultsService } from '../../transfer/cucumber-results/cucumber-results.service';
import type { RunRow } from '../test-automation-ci.service';
import { TestAutomationCiWatcherService } from '../test-automation-ci-watcher.service';
import type { TestAutomationGitService } from '../test-automation-git.service';
import { getRun, GithubActionsError } from '../test-automation-github.client';
import { getPipeline } from '../test-automation-gitlab.client';
import {
  cancelQueueItem,
  jenkinsBuildJob,
  jenkinsProgress,
  readConsole,
  stopBuild,
} from '../test-automation-jenkins.client';

jest.mock('../test-automation-github.client', () => ({
  ...jest.requireActual<object>('../test-automation-github.client'),
  getRun: jest.fn(),
}));

jest.mock('../test-automation-gitlab.client', () => ({
  ...jest.requireActual<object>('../test-automation-gitlab.client'),
  getPipeline: jest.fn(),
}));

jest.mock('../test-automation-jenkins.client', () => ({
  ...jest.requireActual<object>('../test-automation-jenkins.client'),
  jenkinsProgress: jest.fn(),
  jenkinsBuildJob: jest.fn(),
  readConsole: jest.fn(),
  stopBuild: jest.fn(),
  cancelQueueItem: jest.fn(),
}));

type Chain = Record<string, jest.Mock> & {
  then: (done: (value: unknown) => unknown) => Promise<unknown>;
};

const CI_URL =
  'https://jenkins.example.com/job/team/job/nightly/buildWithParameters';
const QUEUE_URL = 'https://jenkins.example.com/queue/item/55/';
const BUILD_URL = 'https://jenkins.example.com/job/team/job/nightly/8/';

const rowOf = (ci: object = {}, extra: object = {}) =>
  ({
    id: 'run-1',
    organization_id: 'org-1',
    space_id: 'space-1',
    config_id: 'config-1',
    status: 'REQUESTED',
    created_at: new Date().toISOString(),
    result_summary: {
      ci: {
        provider: 'jenkins',
        state: 'queued',
        full_name: 'team/nightly',
        queue_url: QUEUE_URL,
        ...ci,
      },
    },
    ...extra,
  }) as unknown as RunRow;

interface Internals {
  follow(row: RunRow): Promise<void>;
  jobs(row: RunRow): Promise<unknown>;
  jobLog(row: RunRow, jobId: string): Promise<unknown>;
  cancel(row: RunRow): Promise<unknown>;
  isCancellable(row: RunRow): boolean;
}

describe('TestAutomationCiWatcherService, Jenkins builds', () => {
  const savedSecret = process.env.AI_ENCRYPTION_SECRET;
  const find = jest.fn();
  const updates: Record<string, unknown>[] = [];
  const runFilters: unknown[][] = [];
  let config: Record<string, unknown> | null;

  const chainFor = (table: string): Chain => {
    const chain = {
      then: (done) =>
        Promise.resolve(
          table === 'test_automation_configs'
            ? { data: config, error: null }
            : { data: { id: 'run-1' }, error: null },
        ).then(done),
    } as Chain;

    for (const name of ['select', 'maybeSingle', 'single']) {
      chain[name] = jest.fn(() => chain);
    }

    chain.eq = jest.fn((...args: unknown[]) => {
      if (table === 'test_automation_runs') runFilters.push(args);

      return chain;
    });
    chain.update = jest.fn((payload: Record<string, unknown>) => {
      updates.push(payload);

      return chain;
    });

    return chain;
  };

  const service = new TestAutomationCiWatcherService(
    {
      getClient: () => ({ from: chainFor }),
    } as unknown as SupabaseAdminService,
    { findRepositoryByName: find } as unknown as TestAutomationGitService,
    {} as unknown as TestManagementAccessService,
    {} as unknown as PermissionsService,
    {} as unknown as CucumberResultsService,
    {} as unknown as TestExecutionsService,
    {} as unknown as TestRunsService,
    {} as unknown as TestPlanTestsService,
  ) as unknown as Internals;

  const savedCi = () =>
    (updates[0]?.result_summary as { ci: Record<string, unknown> }).ci;
  const progress = jenkinsProgress as jest.Mock;

  beforeAll(() => {
    Logger.overrideLogger(false);
    process.env.AI_ENCRYPTION_SECRET = 'a'.repeat(64);
  });

  afterAll(() => {
    if (savedSecret === undefined) delete process.env.AI_ENCRYPTION_SECRET;
    else process.env.AI_ENCRYPTION_SECRET = savedSecret;
  });

  beforeEach(() => {
    updates.length = 0;
    runFilters.length = 0;
    find.mockReset();
    (getRun as jest.Mock).mockReset();
    (getPipeline as jest.Mock).mockReset();
    progress.mockReset();
    (jenkinsBuildJob as jest.Mock).mockReset();
    (readConsole as jest.Mock).mockReset();
    (stopBuild as jest.Mock).mockReset();
    (cancelQueueItem as jest.Mock).mockReset();
    config = {
      ci_url: CI_URL,
      ci_headers_enc: packSecretForStorage(
        '{"Authorization":"Basic dXNlcjp0b2tlbjEyMzQ="}',
      ),
    };
  });

  describe('following', () => {
    it('waits while the build is in the queue, asking neither GitHub nor GitLab', async () => {
      progress.mockResolvedValue({ state: 'queued' });

      await service.follow(rowOf());

      expect(progress).toHaveBeenCalledWith(
        expect.objectContaining({
          origin: 'https://jenkins.example.com',
          headers: expect.objectContaining({
            authorization: 'Basic dXNlcjp0b2tlbjEyMzQ=',
          }) as unknown,
        }),
        expect.objectContaining({ queue_url: QUEUE_URL }),
      );
      expect(find).not.toHaveBeenCalled();
      expect(getRun).not.toHaveBeenCalled();
      expect(getPipeline).not.toHaveBeenCalled();
      expect(updates).toHaveLength(0);
    });

    it('keeps the build number and address once it has started', async () => {
      progress.mockResolvedValue({
        state: 'running',
        run_id: 8,
        html_url: BUILD_URL,
      });

      await service.follow(rowOf());

      expect(savedCi()).toEqual({
        provider: 'jenkins',
        state: 'running',
        full_name: 'team/nightly',
        queue_url: QUEUE_URL,
        run_id: 8,
        html_url: BUILD_URL,
      });
      expect(updates[0].finished_at).toBeUndefined();
    });

    it('saves the end state and finish time, only if the state is unchanged', async () => {
      progress.mockResolvedValue({ state: 'failed' });

      await service.follow(
        rowOf({ state: 'running', run_id: 8, html_url: BUILD_URL }),
      );

      expect(savedCi()).toMatchObject({ state: 'failed', run_id: 8 });
      expect(updates[0].finished_at).toEqual(expect.any(String));
      expect(runFilters).toEqual(
        expect.arrayContaining([['result_summary->ci->>state', 'running']]),
      );
    });

    it('marks a build named on another host as lost', async () => {
      progress.mockRejectedValue(
        new GithubActionsError(
          null,
          'Jenkins named a build that is not on the host of the setting',
          true,
        ),
      );

      await service.follow(rowOf());

      expect(savedCi()).toMatchObject({
        state: 'lost',
        message: 'Jenkins named a build that is not on the host of the setting',
      });
    });

    it('does not read without a saved login', async () => {
      config = {
        ci_url: CI_URL,
        ci_headers_enc: packSecretForStorage('{"X-Token":"abc"}'),
      };

      await service.follow(rowOf());

      expect(progress).not.toHaveBeenCalled();
      expect(savedCi()).toMatchObject({ state: 'queued' });
    });

    describe('a job on a connected Jenkins server', () => {
      const LOGIN = 'Basic c2VydmVyOnNlcnZlci10b2tlbg==';
      const findForJobUrl = jest.fn();
      const linked = new TestAutomationCiWatcherService(
        {
          getClient: () => ({ from: chainFor }),
        } as unknown as SupabaseAdminService,
        { findRepositoryByName: find } as unknown as TestAutomationGitService,
        {} as unknown as TestManagementAccessService,
        {} as unknown as PermissionsService,
        {} as unknown as CucumberResultsService,
        {} as unknown as TestExecutionsService,
        {} as unknown as TestRunsService,
        {} as unknown as TestPlanTestsService,
        {
          findForJobUrl,
          authorizationFor: () => LOGIN,
        } as unknown as CiServersService,
      ) as unknown as Internals;

      beforeEach(() => {
        findForJobUrl.mockReset().mockResolvedValue({ id: 'server-1' });
        config = { ci_url: CI_URL, ci_headers_enc: null };
      });

      it('reads with the server’s login, looked up again for each check', async () => {
        progress.mockResolvedValue({ state: 'queued' });

        await linked.follow(rowOf());
        await linked.follow(rowOf());

        expect(findForJobUrl).toHaveBeenCalledTimes(2);
        expect(findForJobUrl).toHaveBeenCalledWith('org-1', CI_URL);
        expect(progress).toHaveBeenCalledWith(
          expect.objectContaining({
            origin: 'https://jenkins.example.com',
            headers: expect.objectContaining({
              authorization: LOGIN,
            }) as unknown,
          }),
          expect.objectContaining({ queue_url: QUEUE_URL }),
        );
      });

      it('keeps a saved login over the server’s', async () => {
        config = {
          ci_url: CI_URL,
          ci_headers_enc: packSecretForStorage(
            '{"Authorization":"Basic dXNlcjp0b2tlbjEyMzQ="}',
          ),
        };
        progress.mockResolvedValue({ state: 'queued' });

        await linked.follow(rowOf());

        expect(findForJobUrl).not.toHaveBeenCalled();
      });

      it.each([
        ['no connected server', () => findForJobUrl.mockResolvedValue(null)],
        [
          'a failed lookup',
          () => findForJobUrl.mockRejectedValue(new Error('db down')),
        ],
      ])('reads nothing with %s', async (_name, arrange) => {
        arrange();

        await linked.follow(rowOf());

        expect(progress).not.toHaveBeenCalled();
        expect(savedCi()).toMatchObject({ state: 'queued' });
      });

      it('never sends the server’s login to a build on another host', async () => {
        progress.mockResolvedValue({ state: 'queued' });

        await linked.follow(
          rowOf({ queue_url: 'https://other.example.com/queue/item/55/' }),
        );

        expect(progress).not.toHaveBeenCalled();
      });
    });

    it('gives up on a build still queued after 24 hours', async () => {
      await service.follow(
        rowOf({}, { created_at: new Date(Date.now() - 25 * 3600_000) }),
      );

      expect(progress).not.toHaveBeenCalled();
      expect(savedCi()).toMatchObject({
        state: 'lost',
        message: 'Jenkins gave no final result within 24 hours',
      });
    });
  });

  describe('jobs, logs and stopping', () => {
    const started = { state: 'running', run_id: 8, html_url: BUILD_URL };
    const job = { id: '8', name: 'team/nightly', status: 'in_progress' };

    it('has no job while the build is queued', async () => {
      await expect(service.jobs(rowOf())).resolves.toEqual([]);
      await expect(service.jobLog(rowOf(), '8')).rejects.toMatchObject({
        status: 404,
      });
    });

    it('shows the build as its one job and reads its console', async () => {
      (jenkinsBuildJob as jest.Mock).mockResolvedValue(job);
      (readConsole as jest.Mock).mockResolvedValue({
        text: 'ok',
        truncated: false,
        bytes: 2,
      });

      await expect(service.jobs(rowOf(started))).resolves.toEqual([job]);
      expect(jenkinsBuildJob).toHaveBeenCalledWith(
        expect.anything(),
        'team/nightly',
        8,
        BUILD_URL,
      );

      await expect(service.jobLog(rowOf(started), '8')).resolves.toMatchObject({
        text: 'ok',
      });
      expect(readConsole).toHaveBeenCalledWith(expect.anything(), BUILD_URL);
      await expect(service.jobLog(rowOf(started), '9')).rejects.toMatchObject({
        response: { message: 'This job is not part of the run' },
      });
    });

    it('takes a queued build out of the queue', async () => {
      expect(service.isCancellable(rowOf())).toBe(true);

      await service.cancel(rowOf());

      expect(cancelQueueItem).toHaveBeenCalledWith(
        expect.anything(),
        QUEUE_URL,
      );
      expect(stopBuild).not.toHaveBeenCalled();
      expect(updates[0]).toEqual({
        cancel_requested_at: expect.any(String) as string,
      });
    });

    it('stops a running build', async () => {
      await service.cancel(rowOf(started));

      expect(stopBuild).toHaveBeenCalledWith(expect.anything(), BUILD_URL);
      expect(cancelQueueItem).not.toHaveBeenCalled();
    });

    it('cannot stop a finished build', () => {
      expect(service.isCancellable(rowOf({ state: 'cancelled' }))).toBe(false);
    });
  });
});
