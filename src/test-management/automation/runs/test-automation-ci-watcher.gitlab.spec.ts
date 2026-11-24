import { Logger } from '@nestjs/common';

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
import {
  cancelPipeline,
  getPipeline,
  listPipelineJobs,
  readJobTrace,
  type CiToolAccess,
} from '../test-automation-gitlab.client';

jest.mock('../test-automation-github.client', () => ({
  ...jest.requireActual<object>('../test-automation-github.client'),
  getRun: jest.fn(),
}));

jest.mock('../test-automation-gitlab.client', () => ({
  ...jest.requireActual<object>('../test-automation-gitlab.client'),
  getPipeline: jest.fn(),
  listPipelineJobs: jest.fn(),
  readJobTrace: jest.fn(),
  cancelPipeline: jest.fn(),
}));

type Chain = Record<string, jest.Mock> & {
  then: (done: (value: unknown) => unknown) => Promise<unknown>;
};

const CI_URL = 'https://gitlab.example.com/api/v4/projects/42/pipeline';
const PIPELINE_URL = 'https://gitlab.example.com/group/app/-/pipelines/7001';

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
        provider: 'gitlab',
        state: 'queued',
        full_name: 'group/app',
        run_id: 7001,
        html_url: PIPELINE_URL,
        project_id: 42,
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

describe('TestAutomationCiWatcherService, GitLab pipelines', () => {
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
    (listPipelineJobs as jest.Mock).mockReset();
    (readJobTrace as jest.Mock).mockReset();
    (cancelPipeline as jest.Mock).mockReset();
    config = {
      ci_url: CI_URL,
      ci_headers_enc: packSecretForStorage(
        '{"PRIVATE-TOKEN":"glpat-secret-1"}',
      ),
    };
  });

  describe('following', () => {
    it('never asks GitHub about a GitLab run', async () => {
      (getPipeline as jest.Mock).mockResolvedValue({ state: 'running' });

      await service.follow(rowOf());

      expect(find).not.toHaveBeenCalled();
      expect(getRun).not.toHaveBeenCalled();
      expect(getPipeline).toHaveBeenCalledWith(
        expect.objectContaining({
          origin: 'https://gitlab.example.com',
          base: 'https://gitlab.example.com/api/v4',
          headers: expect.objectContaining({
            'private-token': 'glpat-secret-1',
          }) as unknown,
        }),
        42,
        7001,
      );
      expect(savedCi()).toMatchObject({ provider: 'gitlab', state: 'running' });
      expect(updates[0].finished_at).toBeUndefined();
    });

    it('saves the end state and finish time, without importing', async () => {
      (getPipeline as jest.Mock).mockResolvedValue({
        state: 'cancelled',
        head_sha: 'b'.repeat(40),
        head_branch: 'main',
      });

      await service.follow(rowOf({ state: 'running' }));

      expect(savedCi()).toEqual({
        provider: 'gitlab',
        state: 'cancelled',
        full_name: 'group/app',
        run_id: 7001,
        html_url: PIPELINE_URL,
        project_id: 42,
        head_sha: 'b'.repeat(40),
        head_branch: 'main',
      });
      expect(updates[0].finished_at).toEqual(expect.any(String));
    });

    it('saves only while the state is still the one read', async () => {
      (getPipeline as jest.Mock).mockResolvedValue({ state: 'failed' });

      await service.follow(rowOf({ state: 'running' }));

      expect(runFilters).toEqual(
        expect.arrayContaining([
          ['status', 'REQUESTED'],
          ['result_summary->ci->>state', 'running'],
        ]),
      );
    });

    it('writes nothing when nothing changed', async () => {
      (getPipeline as jest.Mock).mockResolvedValue({ state: 'queued' });

      await service.follow(rowOf());

      expect(updates).toHaveLength(0);
    });

    it('notes once that the saved token is gone, and keeps the state', async () => {
      config = { ci_url: CI_URL, ci_headers_enc: null };

      await service.follow(rowOf());
      expect(getPipeline).not.toHaveBeenCalled();
      expect(savedCi()).toMatchObject({
        state: 'queued',
        message: expect.stringContaining('saved access details') as unknown,
      });

      const { message } = savedCi();

      updates.length = 0;
      await service.follow(rowOf({ message }));
      expect(updates).toHaveLength(0);
    });

    it('does not send the token to a setting moved to another host', async () => {
      config = {
        ...config,
        ci_url: 'https://other.example.com/api/v4/projects/42/pipeline',
      };

      await service.follow(rowOf());

      expect(getPipeline).not.toHaveBeenCalled();
    });

    it('marks a pipeline GitLab no longer knows as lost', async () => {
      (getPipeline as jest.Mock).mockRejectedValue(
        new GithubActionsError(404, 'GitLab answered 404'),
      );

      await service.follow(rowOf());

      expect(savedCi()).toMatchObject({
        state: 'lost',
        message: 'GitLab no longer knows this run',
      });
    });

    it('tries again later when GitLab is down', async () => {
      (getPipeline as jest.Mock).mockRejectedValue(
        new GithubActionsError(502, 'GitLab answered 502'),
      );

      await expect(service.follow(rowOf())).rejects.toThrow('502');
      expect(updates).toHaveLength(0);
    });

    it('gives up after 24 hours', async () => {
      await service.follow(
        rowOf({}, { created_at: new Date(Date.now() - 25 * 3600_000) }),
      );

      expect(getPipeline).not.toHaveBeenCalled();
      expect(savedCi()).toMatchObject({
        state: 'lost',
        message: 'GitLab gave no final result within 24 hours',
      });
    });
  });

  describe('jobs, logs and stopping', () => {
    const job = { id: '900', name: 'test', status: 'completed', steps: [] };

    it('lists the pipeline’s jobs', async () => {
      (listPipelineJobs as jest.Mock).mockResolvedValue([job]);

      await expect(service.jobs(rowOf())).resolves.toEqual([job]);
      expect(find).not.toHaveBeenCalled();
    });

    it('lists nothing for a start that could not be read', async () => {
      await expect(
        service.jobs(
          rowOf({ state: 'untracked', run_id: undefined, html_url: undefined }),
        ),
      ).resolves.toEqual([]);
    });

    it('refuses to list without the saved token', async () => {
      config = { ci_url: CI_URL, ci_headers_enc: null };

      await expect(service.jobs(rowOf())).rejects.toMatchObject({
        response: { code: 'CI_ACCESS_UNAVAILABLE' },
      });
    });

    it.each([401, 403])(
      'names a token GitLab refuses with %i as an access problem, not an outage',
      async (status) => {
        (listPipelineJobs as jest.Mock).mockRejectedValue(
          new GithubActionsError(status, `GitLab answered ${status}`),
        );

        await expect(service.jobs(rowOf())).rejects.toMatchObject({
          status: 409,
          response: { code: 'CI_ACCESS_UNAVAILABLE' },
        });
      },
    );

    it('still names a GitLab outage as unavailable', async () => {
      (listPipelineJobs as jest.Mock).mockRejectedValue(
        new GithubActionsError(502, 'GitLab answered 502'),
      );

      await expect(service.jobs(rowOf())).rejects.toMatchObject({
        status: 503,
        response: { code: 'CI_TOOL_UNAVAILABLE' },
      });
    });

    it('reads the log of a job of this run only', async () => {
      (listPipelineJobs as jest.Mock).mockResolvedValue([job]);
      (readJobTrace as jest.Mock).mockResolvedValue({
        text: 'ok',
        truncated: false,
        bytes: 2,
      });

      await expect(service.jobLog(rowOf(), '900')).resolves.toMatchObject({
        text: 'ok',
      });
      expect(readJobTrace).toHaveBeenCalledWith(expect.anything(), 42, '900');

      await expect(service.jobLog(rowOf(), '901')).rejects.toMatchObject({
        response: { message: 'This job is not part of the run' },
      });
      await expect(service.jobLog(rowOf(), '../x')).rejects.toMatchObject({
        response: { code: 'VALIDATION_FAILED' },
      });
    });

    it('can stop a going pipeline and records the request', async () => {
      (cancelPipeline as jest.Mock).mockResolvedValue(undefined);

      expect(service.isCancellable(rowOf())).toBe(true);
      expect(service.isCancellable(rowOf({ state: 'passed' }))).toBe(false);

      await service.cancel(rowOf());

      expect(cancelPipeline).toHaveBeenCalledWith(expect.anything(), 42, 7001);
      expect(updates[0]).toEqual({
        cancel_requested_at: expect.any(String) as string,
      });
    });

    it('names a refused stop without signing anyone out', async () => {
      (cancelPipeline as jest.Mock).mockRejectedValue(
        new GithubActionsError(403, 'GitLab answered 403'),
      );

      await expect(service.cancel(rowOf())).rejects.toMatchObject({
        status: 409,
        response: { code: 'CI_CANCEL_DENIED' },
      });
    });
  });

  describe('through the GitLab connection', () => {
    const gitlabCiConnection = jest.fn();
    const gitlabToken = jest.fn();
    const connected = new TestAutomationCiWatcherService(
      {
        getClient: () => ({ from: chainFor }),
      } as unknown as SupabaseAdminService,
      {
        gitlabCiConnection,
        gitlabToken,
      } as unknown as TestAutomationGitService,
      {} as unknown as TestManagementAccessService,
      {} as unknown as PermissionsService,
      {} as unknown as CucumberResultsService,
      {} as unknown as TestExecutionsService,
      {} as unknown as TestRunsService,
      {} as unknown as TestPlanTestsService,
    ) as unknown as Internals;

    beforeEach(() => {
      config = { ci_url: CI_URL, ci_headers_enc: null };
      gitlabCiConnection.mockReset().mockResolvedValue({
        connection: { id: 'conn-1' },
      });
      gitlabToken
        .mockReset()
        .mockResolvedValueOnce('gl-oauth-1')
        .mockResolvedValueOnce('gl-oauth-2');
    });

    it('reads with a fresh Bearer token of the connected account each time', async () => {
      (getPipeline as jest.Mock).mockResolvedValue({ state: 'running' });

      await connected.follow(rowOf());
      await connected.follow(rowOf());

      expect(gitlabCiConnection).toHaveBeenCalledWith('org-1', CI_URL);
      expect(gitlabToken).toHaveBeenCalledTimes(2);

      const [first, second] = (getPipeline as jest.Mock).mock.calls as [
        CiToolAccess,
      ][];

      expect(first[0]).toMatchObject({
        origin: 'https://gitlab.example.com',
        base: 'https://gitlab.example.com/api/v4',
        headers: { authorization: 'Bearer gl-oauth-1' },
      });
      expect(first[0].headers['private-token']).toBeUndefined();
      expect(second[0].headers.authorization).toBe('Bearer gl-oauth-2');
    });

    it('lists and stops with the connection too', async () => {
      (listPipelineJobs as jest.Mock).mockResolvedValue([]);
      (cancelPipeline as jest.Mock).mockResolvedValue(undefined);

      await connected.jobs(rowOf());
      await connected.cancel(rowOf());

      expect(
        ((listPipelineJobs as jest.Mock).mock.calls as [CiToolAccess][])[0][0]
          .headers.authorization,
      ).toBe('Bearer gl-oauth-1');
      expect(
        ((cancelPipeline as jest.Mock).mock.calls as [CiToolAccess][])[0][0]
          .headers.authorization,
      ).toBe('Bearer gl-oauth-2');
    });

    it.each([
      ['the project is no longer connected', 'unavailable'],
      ['the address is not a connected project', null],
    ])('notes lost access when %s', async (_name, answer) => {
      gitlabCiConnection.mockResolvedValue(answer);

      await connected.follow(rowOf());

      expect(getPipeline).not.toHaveBeenCalled();
      expect(gitlabToken).not.toHaveBeenCalled();
      expect(savedCi()).toMatchObject({
        state: 'queued',
        message: expect.stringContaining('saved access details') as unknown,
      });
    });

    it('refuses to list when the sign-in needs a reconnect', async () => {
      gitlabToken.mockReset().mockRejectedValue(new Error('reconnect'));

      await expect(connected.jobs(rowOf())).rejects.toMatchObject({
        status: 409,
        response: { code: 'CI_ACCESS_UNAVAILABLE' },
      });
    });

    it('never sends the token to a run on another host', async () => {
      await connected.follow(
        rowOf({ html_url: 'https://evil.example.com/group/app/-/pipelines/1' }),
      );

      expect(gitlabCiConnection).not.toHaveBeenCalled();
      expect(gitlabToken).not.toHaveBeenCalled();
    });

    it('keeps a saved login instead of the connection', async () => {
      config = {
        ci_url: CI_URL,
        ci_headers_enc: packSecretForStorage('{"Authorization":"Bearer own"}'),
      };

      await connected.follow(rowOf());

      expect(gitlabCiConnection).not.toHaveBeenCalled();
      expect(getPipeline).not.toHaveBeenCalled();
    });
  });
});
