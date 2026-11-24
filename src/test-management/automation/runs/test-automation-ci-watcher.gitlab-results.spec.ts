import { Logger } from '@nestjs/common';

import { packSecretForStorage } from '../../../lib/crypto/encryption';
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
import { GithubActionsError } from '../test-automation-github.client';
import {
  downloadJobArtifacts,
  getPipeline,
  listPipelineJobs,
} from '../test-automation-gitlab.client';

jest.mock('../test-automation-gitlab.client', () => ({
  ...jest.requireActual<object>('../test-automation-gitlab.client'),
  getPipeline: jest.fn(),
  listPipelineJobs: jest.fn(),
  downloadJobArtifacts: jest.fn(),
}));

jest.mock('../../transfer/shared/zip-entries', () => ({
  readZipEntries: jest.fn(),
}));

type Chain = Record<string, jest.Mock> & {
  then: (done: (value: unknown) => unknown) => Promise<unknown>;
};

const CI_URL = 'https://gitlab.example.com/api/v4/projects/42/pipeline';
const PIPELINE_URL = 'https://gitlab.example.com/group/app/-/pipelines/7001';
const REPORT = Buffer.from(
  '<testsuite name="s" tests="2"><testcase classname="c" name="one"/><testcase classname="c" name="two"/></testsuite>',
);
const FAILING_REPORT = Buffer.from(
  '<testsuite name="s" tests="1"><testcase classname="c" name="n"><failure/></testcase></testsuite>',
);

const rowOf = (ci: object = {}, extra: object = {}) =>
  ({
    id: 'run-1',
    organization_id: 'org-1',
    space_id: 'space-1',
    config_id: 'config-1',
    target: 'execution',
    execution_id: 'exec-1',
    plan_id: null,
    started_by: 'user-1',
    status: 'REQUESTED',
    created_at: new Date().toISOString(),
    result_summary: {
      ci: {
        provider: 'gitlab',
        state: 'running',
        full_name: 'group/app',
        run_id: 7001,
        html_url: PIPELINE_URL,
        project_id: 42,
        ...ci,
      },
    },
    ...extra,
  }) as unknown as RunRow;

const job = (id: string, name: string, conclusion: string | null) => ({
  id,
  name,
  status: conclusion ? 'completed' : 'queued',
  conclusion,
  started_at: null,
  completed_at: null,
  html_url: null,
  steps: [],
});

interface Internals {
  follow(row: RunRow): Promise<void>;
}

interface Saved {
  result_summary: {
    ci: Record<string, unknown>;
    counts?: Record<string, number>;
    import?: Record<string, unknown>;
  };
  finished_at?: string;
}

describe('TestAutomationCiWatcherService, GitLab results', () => {
  const savedSecret = process.env.AI_ENCRYPTION_SECRET;
  const commit = jest.fn();
  const hasSpacePermission = jest.fn();
  const updates: Saved[] = [];
  const runFilters: unknown[][] = [];
  let claimed: RunRow | null;

  const chainFor = (table: string): Chain => {
    let payload: Saved | null = null;
    const chain = {
      then: (done) =>
        Promise.resolve(
          table === 'test_automation_configs'
            ? {
                data: {
                  ci_url: CI_URL,
                  ci_headers_enc: packSecretForStorage(
                    '{"PRIVATE-TOKEN":"glpat-secret-1"}',
                  ),
                },
                error: null,
              }
            : {
                data:
                  payload?.result_summary.ci.state === 'importing'
                    ? claimed
                    : null,
                error: null,
              },
        ).then(done),
    } as Chain;

    for (const name of ['select', 'maybeSingle', 'single']) {
      chain[name] = jest.fn(() => chain);
    }

    chain.eq = jest.fn((...args: unknown[]) => {
      if (table === 'test_automation_runs') runFilters.push(args);

      return chain;
    });
    chain.update = jest.fn((sent: Saved) => {
      payload = sent;
      updates.push(sent);

      return chain;
    });

    return chain;
  };

  const service = new TestAutomationCiWatcherService(
    {
      getClient: () => ({ from: chainFor }),
    } as unknown as SupabaseAdminService,
    {} as unknown as TestAutomationGitService,
    {
      assertAvailable: jest.fn().mockResolvedValue(undefined),
    } as unknown as TestManagementAccessService,
    { hasSpacePermission } as unknown as PermissionsService,
    { commit } as unknown as CucumberResultsService,
    { remove: jest.fn() } as unknown as TestExecutionsService,
    {} as unknown as TestRunsService,
    {} as unknown as TestPlanTestsService,
  ) as unknown as Internals;

  const lastSaved = () => updates[updates.length - 1];

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
    claimed = rowOf({ state: 'importing' });
    hasSpacePermission.mockReset().mockResolvedValue(true);
    commit.mockReset().mockResolvedValue({
      applied: [{}, {}],
      created_cases: [],
      warnings: [],
      file_saved: true,
    });
    (getPipeline as jest.Mock).mockReset();
    (listPipelineJobs as jest.Mock)
      .mockReset()
      .mockResolvedValue([
        job('900', 'test', 'success'),
        job('901', 'lint', 'skipped'),
        job('902', 'deploy', null),
      ]);
    (downloadJobArtifacts as jest.Mock)
      .mockReset()
      .mockResolvedValue(Buffer.from('zip'));
    (readZipEntries as jest.Mock).mockReset().mockResolvedValue({
      entries: [{ name: 'results.xml', data: REPORT }],
      skipped: [],
    });
  });

  it('claims a passed pipeline, imports its job artifacts and saves the outcome', async () => {
    (getPipeline as jest.Mock).mockResolvedValue({ state: 'passed' });

    await service.follow(rowOf());

    expect(updates[0].result_summary.ci).toMatchObject({
      state: 'importing',
      conclusion: 'success',
      claimed_at: expect.any(String) as string,
    });
    expect(runFilters).toEqual(
      expect.arrayContaining([
        ['status', 'REQUESTED'],
        ['result_summary->ci->>state', 'running'],
      ]),
    );

    // Only a job that ran is asked for its artifacts.
    expect(downloadJobArtifacts).toHaveBeenCalledTimes(1);
    expect(downloadJobArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: 'https://gitlab.example.com',
        headers: expect.objectContaining({
          'private-token': 'glpat-secret-1',
        }) as unknown,
      }),
      42,
      '900',
      expect.any(Number),
    );
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(
      expect.anything(),
      'space-1',
      'exec-1',
      expect.objectContaining({ originalname: 'results.xml' }),
      { create_unmatched: false },
      { addInSpace: false, noRerun: true },
    );

    const saved = lastSaved();

    expect(saved.result_summary.ci).toMatchObject({
      provider: 'gitlab',
      state: 'passed',
      conclusion: 'success',
    });
    expect(saved.result_summary.ci.claimed_at).toBeUndefined();
    expect(saved.result_summary.counts).toEqual({
      total: 2,
      passed: 2,
      failed: 0,
      skipped: 0,
    });
    expect(saved.result_summary.import).toMatchObject({
      uploaded: ['results.xml'],
      applied: 2,
    });
    expect(saved.finished_at).toEqual(expect.any(String));
  });

  it('marks a failed pipeline with failing tests as failed', async () => {
    (getPipeline as jest.Mock).mockResolvedValue({ state: 'failed' });
    (readZipEntries as jest.Mock).mockResolvedValue({
      entries: [{ name: 'results.xml', data: FAILING_REPORT }],
      skipped: [],
    });

    await service.follow(rowOf());

    expect(updates[0].result_summary.ci).toMatchObject({
      state: 'importing',
      conclusion: 'failed',
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(lastSaved().result_summary.ci).toMatchObject({ state: 'failed' });
  });

  it('saves no_results when no job kept artifacts', async () => {
    (getPipeline as jest.Mock).mockResolvedValue({ state: 'passed' });
    (downloadJobArtifacts as jest.Mock).mockResolvedValue(null);

    await service.follow(rowOf());

    expect(readZipEntries).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(lastSaved().result_summary.ci).toMatchObject({
      state: 'no_results',
      message: expect.stringContaining(
        'The pipeline saved no result file',
      ) as unknown,
    });
  });

  it('leaves out an artifact over the size limit and imports the rest', async () => {
    (getPipeline as jest.Mock).mockResolvedValue({ state: 'passed' });
    (listPipelineJobs as jest.Mock).mockResolvedValue([
      job('900', 'test', 'success'),
      job('903', 'build', 'success'),
    ]);
    (downloadJobArtifacts as jest.Mock)
      .mockResolvedValueOnce(Buffer.from('zip'))
      .mockRejectedValueOnce(
        new GithubActionsError(null, 'The artifact is too large', true),
      );

    await service.follow(rowOf());

    expect(commit).toHaveBeenCalledTimes(1);
    expect(lastSaved().result_summary.ci).toMatchObject({
      state: 'passed',
      message: 'Left out: build (The artifact is too large).',
    });
  });

  it('tries again later when GitLab fails while downloading', async () => {
    (getPipeline as jest.Mock).mockResolvedValue({ state: 'passed' });
    (downloadJobArtifacts as jest.Mock).mockRejectedValue(
      new GithubActionsError(502, 'GitLab answered 502'),
    );

    await expect(service.follow(rowOf())).rejects.toThrow('502');
    expect(updates).toHaveLength(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it('records nothing when another check claimed the run first', async () => {
    (getPipeline as jest.Mock).mockResolvedValue({ state: 'passed' });
    claimed = null;

    await service.follow(rowOf());

    expect(listPipelineJobs).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
  });

  it('leaves a run alone while its import is claimed', async () => {
    await service.follow(
      rowOf({ state: 'importing', claimed_at: new Date().toISOString() }),
    );

    expect(getPipeline).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('takes over an import whose claim expired', async () => {
    const claimedAt = new Date(Date.now() - 11 * 60_000).toISOString();

    (getPipeline as jest.Mock).mockResolvedValue({ state: 'passed' });

    await service.follow(rowOf({ state: 'importing', claimed_at: claimedAt }));

    expect(runFilters).toEqual(
      expect.arrayContaining([
        ['result_summary->ci->>state', 'importing'],
        ['result_summary->ci->>claimed_at', claimedAt],
      ]),
    );
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('does not record results for someone who lost the rights', async () => {
    (getPipeline as jest.Mock).mockResolvedValue({ state: 'passed' });
    hasSpacePermission.mockResolvedValue(false);

    await service.follow(rowOf());

    expect(downloadJobArtifacts).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(lastSaved().result_summary.ci).toMatchObject({
      state: 'results_failed',
    });
  });

  it('still imports nothing for a cancelled pipeline', async () => {
    (getPipeline as jest.Mock).mockResolvedValue({ state: 'cancelled' });

    await service.follow(rowOf());

    expect(listPipelineJobs).not.toHaveBeenCalled();
    expect(downloadJobArtifacts).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
    expect(updates[0].result_summary.ci).toMatchObject({ state: 'cancelled' });
  });
});
