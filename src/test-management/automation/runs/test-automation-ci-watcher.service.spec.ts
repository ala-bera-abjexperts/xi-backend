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
import {
  GithubActionsError,
  listRunJobs,
} from '../test-automation-github.client';

jest.mock('../test-automation-github.client', () => ({
  ...jest.requireActual<object>('../test-automation-github.client'),
  listRunJobs: jest.fn(),
}));

const row = (ci: Record<string, unknown> | undefined): RunRow =>
  ({
    id: 'run-1',
    organization_id: 'org-1',
    result_summary: ci ? { ci } : {},
  }) as unknown as RunRow;

const tracked = row({ state: 'running', full_name: 'acme/tests', run_id: 123 });

describe('TestAutomationCiWatcherService.jobs', () => {
  const jobs = listRunJobs as jest.Mock;
  const findRepositoryByName = jest.fn();
  const actionsAccess = jest.fn();

  const service = new TestAutomationCiWatcherService(
    {} as unknown as SupabaseAdminService,
    {
      findRepositoryByName,
      actionsAccess,
    } as unknown as TestAutomationGitService,
    {} as unknown as TestManagementAccessService,
    {} as unknown as PermissionsService,
    {} as unknown as CucumberResultsService,
    {} as unknown as TestExecutionsService,
    {} as unknown as TestRunsService,
    {} as unknown as TestPlanTestsService,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    findRepositoryByName.mockResolvedValue({ state: 'connected' });
    actionsAccess.mockResolvedValue({ token: 'ghs_token' });
  });

  it('asks GitHub through the connection', async () => {
    const list = [{ id: '1', name: 'tests' }];

    jobs.mockResolvedValue(list);

    await expect(service.jobs(tracked)).resolves.toBe(list);
    expect(findRepositoryByName).toHaveBeenCalledWith('org-1', 'acme/tests');
    expect(jobs).toHaveBeenCalledWith({ token: 'ghs_token' }, 123);
  });

  it.each([
    ['an old CI run', row(undefined)],
    ['an untracked run', row({ state: 'untracked', full_name: 'acme/tests' })],
  ])('has no jobs for %s, without asking GitHub', async (_name, run) => {
    await expect(service.jobs(run)).resolves.toEqual([]);
    expect(jobs).not.toHaveBeenCalled();
  });

  it('says when GitHub no longer has the run', async () => {
    jobs.mockRejectedValue(new GithubActionsError(404, 'gone'));

    await expect(service.jobs(tracked)).rejects.toMatchObject({
      status: 404,
      response: { code: 'CI_RUN_GONE' },
    });
  });

  it.each([
    ['a 401', new GithubActionsError(401, 'bad token')],
    ['a 403', new GithubActionsError(403, 'rate limited')],
    ['a network failure', new GithubActionsError(null, 'no route')],
  ])(
    'turns %s into our own 503, so nobody is signed out',
    async (_name, failure) => {
      jobs.mockRejectedValue(failure);

      await expect(service.jobs(tracked)).rejects.toMatchObject({
        status: 503,
        response: { code: 'GITHUB_UNAVAILABLE' },
      });
    },
  );

  it('turns a failed token request into our own 503', async () => {
    actionsAccess.mockRejectedValue(new Error('bad key'));

    await expect(service.jobs(tracked)).rejects.toMatchObject({ status: 503 });
    expect(jobs).not.toHaveBeenCalled();
  });

  it('refuses when the connection has gone', async () => {
    findRepositoryByName.mockResolvedValue({ state: 'none' });

    await expect(service.jobs(tracked)).rejects.toMatchObject({
      status: 409,
      response: { code: 'GIT_CONNECTION_UNAVAILABLE' },
    });
    expect(jobs).not.toHaveBeenCalled();
  });
});
