import { ConflictException } from '@nestjs/common';

import type { AuditLogsService } from '../../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../../auth/interfaces/request-user.interface';
import type { PermissionsService } from '../../../permissions/permissions.service';
import type { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import type { TestManagementAccessService } from '../../access/test-management-access.service';
import type { TestAutomationCiWatcherService } from '../test-automation-ci-watcher.service';
import { TestAutomationRunsService } from '../test-automation-runs.service';

const ORG = 'org-1';
const SPACE = 'space-1';
const RUN = 'run-1';
const TARGET = 'target-1';

interface Result {
  data?: unknown;
  error?: unknown;
  count?: number;
}

describe('TestAutomationRunsService, read APIs', () => {
  const assertAvailable = jest.fn();
  const jobs = jest.fn();
  const from = jest.fn();
  const queries: Record<string, jest.Mock>[] = [];

  // Each table call takes the next answer, in the order the service asks.
  const answers = (...results: Result[]) => {
    results.forEach((result) => {
      const query: Record<string, jest.Mock> = {};

      for (const method of ['select', 'eq', 'in']) {
        query[method] = jest.fn(() => query);
      }

      query.maybeSingle = jest.fn(() => Promise.resolve(result));
      query.then = jest.fn((done: (value: Result) => unknown) =>
        Promise.resolve(result).then(done),
      );
      queries.push(query);
      from.mockReturnValueOnce(query);
    });
  };

  const service = new TestAutomationRunsService(
    { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
    { assertAvailable } as unknown as TestManagementAccessService,
    {} as unknown as PermissionsService,
    {} as unknown as AuditLogsService,
    { jobs } as unknown as TestAutomationCiWatcherService,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    queries.length = 0;
    assertAvailable.mockResolvedValue(undefined);
  });

  describe('ciJobs', () => {
    it('reads the jobs of a run in this space', async () => {
      const run = { id: RUN, kind: 'ci_job' };
      const list = [{ id: '1', name: 'tests' }];

      answers({ data: run, error: null });
      jobs.mockResolvedValue(list);

      await expect(service.ciJobs(ORG, SPACE, RUN)).resolves.toBe(list);
      expect(queries[0].eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(queries[0].eq).toHaveBeenCalledWith('space_id', SPACE);
      expect(jobs).toHaveBeenCalledWith(run);
    });

    it('asks nothing of GitHub when the run is not in this space', async () => {
      answers({ data: null, error: null });

      await expect(service.ciJobs(ORG, SPACE, RUN)).rejects.toMatchObject({
        status: 404,
      });
      expect(jobs).not.toHaveBeenCalled();
    });

    it('asks nothing of GitHub when the space is refused', async () => {
      assertAvailable.mockRejectedValue(new ConflictException('off'));

      await expect(service.ciJobs(ORG, SPACE, RUN)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(from).not.toHaveBeenCalled();
    });
  });

  describe('testCounts', () => {
    const types = [
      { id: 'manual', kind: 'manual' },
      { id: 'generic', kind: 'unstructured' },
      { id: 'cucumber', kind: 'gherkin' },
    ];

    it('counts all tests of an execution and the automated ones', async () => {
      answers(
        { data: { test_types: types }, error: null },
        { count: 5, error: null },
        { count: 2, error: null },
      );

      await expect(
        service.testCounts(ORG, SPACE, {
          target: 'execution',
          target_id: TARGET,
        }),
      ).resolves.toEqual({ total: 5, automated: 2 });
      expect(from).toHaveBeenNthCalledWith(2, 'test_runs');
      expect(queries[1].eq).toHaveBeenCalledWith('execution_id', TARGET);
      expect(queries[2].in).toHaveBeenCalledWith('test_case.test_type', [
        'generic',
        'cucumber',
      ]);
    });

    it('reads a plan from its own table', async () => {
      answers(
        { data: { test_types: types }, error: null },
        { count: 3, error: null },
        { count: 1, error: null },
      );

      await service.testCounts(ORG, SPACE, {
        target: 'plan',
        target_id: TARGET,
      });

      expect(from).toHaveBeenNthCalledWith(2, 'test_plan_tests');
      expect(queries[1].eq).toHaveBeenCalledWith('plan_id', TARGET);
    });

    it('answers no automated tests when the space has no automated type', async () => {
      answers({ data: null, error: null }, { count: 4, error: null });

      await expect(
        service.testCounts(ORG, SPACE, {
          target: 'plan',
          target_id: TARGET,
        }),
      ).resolves.toEqual({ total: 4, automated: 0 });
      expect(from).toHaveBeenCalledTimes(2);
    });

    it('stays in this organization and space, and skips archived tests', async () => {
      answers(
        { data: { test_types: [] }, error: null },
        { count: 0, error: null },
      );

      await service.testCounts(ORG, SPACE, {
        target: 'plan',
        target_id: TARGET,
      });

      expect(queries[1].eq).toHaveBeenCalledWith(
        'test_case.organization_id',
        ORG,
      );
      expect(queries[1].eq).toHaveBeenCalledWith('test_case.space_id', SPACE);
      expect(queries[1].eq).toHaveBeenCalledWith(
        'test_case.is_archived',
        false,
      );
    });

    it('reads nothing when the space is refused', async () => {
      assertAvailable.mockRejectedValue(new ConflictException('off'));

      await expect(
        service.testCounts(ORG, SPACE, {
          target: 'plan',
          target_id: TARGET,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(from).not.toHaveBeenCalled();
    });
  });
});

describe('TestAutomationRunsService.list', () => {
  const from = jest.fn();
  const service = new TestAutomationRunsService(
    { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
    {
      assertAvailable: jest.fn().mockResolvedValue(undefined),
    } as unknown as TestManagementAccessService,
    {} as unknown as PermissionsService,
    {} as unknown as AuditLogsService,
    {} as unknown as TestAutomationCiWatcherService,
  );

  const runsPage = () => {
    const query: Record<string, jest.Mock> = {};

    for (const method of ['select', 'eq', 'in', 'order', 'range']) {
      query[method] = jest.fn(() => query);
    }

    query.then = jest.fn((done: (value: Result) => unknown) =>
      Promise.resolve({ data: [], error: null, count: 0 }).then(done),
    );
    from.mockReturnValueOnce(query);

    return query;
  };

  beforeEach(() => from.mockReset());

  it('lists every status when none is asked for', async () => {
    const query = runsPage();

    await service.list(ORG, SPACE, { configId: 'config-1', kind: 'all' });

    expect(query.in).not.toHaveBeenCalled();
  });

  it('keeps only the asked statuses, together with the other filters', async () => {
    const query = runsPage();

    await service.list(ORG, SPACE, {
      configId: 'config-1',
      kind: 'all',
      status: ['DONE', 'ERROR'],
    });

    expect(query.eq).toHaveBeenCalledWith('config_id', 'config-1');
    expect(query.in).toHaveBeenCalledWith('status', ['DONE', 'ERROR']);
  });
});

describe('TestAutomationRunsService.closeByUpload', () => {
  const EXEC = 'exec-1';
  const PLAN = 'plan-1';
  const from = jest.fn();
  const logActionForRequest = jest.fn();
  const user = {
    userId: 'user-1',
    organizationId: ORG,
    appMetadata: { tm_api_key_id: 'key-1' },
  } as unknown as RequestUser;
  const chains: Record<string, jest.Mock>[] = [];

  // Each table call takes the next answer, in the order the service asks.
  const answers = (...results: Result[]) => {
    results.forEach((result) => {
      const chain: Record<string, jest.Mock> = {};

      for (const method of [
        'select',
        'update',
        'eq',
        'in',
        'is',
        'or',
        'range',
        'returns',
      ]) {
        chain[method] = jest.fn(() => chain);
      }

      chain.maybeSingle = jest.fn(() => Promise.resolve(result));
      chain.then = jest.fn((done: (value: Result) => unknown) =>
        Promise.resolve(result).then(done),
      );
      chains.push(chain);
      from.mockReturnValueOnce(chain);
    });
  };

  const service = new TestAutomationRunsService(
    { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
    {} as unknown as TestManagementAccessService,
    {} as unknown as PermissionsService,
    { logActionForRequest } as unknown as AuditLogsService,
    {} as unknown as TestAutomationCiWatcherService,
  );

  const waiting = (extra: Record<string, unknown> = {}) => ({
    id: RUN,
    status: 'REQUESTED',
    target: 'execution',
    plan_id: null,
    execution_id: EXEC,
    result_summary: {},
    ...extra,
  });

  const runs = {
    data: [
      {
        id: 'r1',
        current_attempt_no: 1,
        case: { task: { summary: 'Login works' } },
        attempts: [{ attempt_no: 1, status: 'PASS' }],
      },
      {
        id: 'r2',
        current_attempt_no: 2,
        case: { task: { summary: 'Logout works' } },
        attempts: [
          { attempt_no: 1, status: 'PASS' },
          { attempt_no: 2, status: 'FAIL' },
        ],
      },
      {
        id: 'r3',
        current_attempt_no: 1,
        case: { task: { summary: 'Not run' } },
        attempts: [{ attempt_no: 1, status: 'TODO' }],
      },
    ],
    error: null,
  };

  const applied = (...rows: [string, string][]) => ({
    applied: rows.map(([run_id, status]) => ({
      run_id,
      status,
      attempt_no: 1,
      new_attempt: false,
    })),
  });

  beforeEach(() => {
    jest.resetAllMocks();
    chains.length = 0;
  });

  it('closes a waiting run in one conditional update, from the applied results', async () => {
    answers(
      {
        data: waiting({ result_summary: { ci: { state: 'untracked' } } }),
        error: null,
      },
      runs,
      { data: { id: RUN }, error: null },
    );

    await expect(
      service.closeByUpload(
        user,
        SPACE,
        RUN,
        EXEC,
        applied(['r1', 'PASS'], ['r2', 'FAIL']),
      ),
    ).resolves.toEqual({ closed: true });

    const update = chains[2];
    const [values] = update.update.mock.calls[0] as [Record<string, unknown>];

    expect(values).toEqual({
      result_summary: {
        counts: { total: 2, passed: 1, failed: 1, skipped: 0 },
        tests: [
          { name: 'Login works', status: 'passed' },
          { name: 'Logout works', status: 'failed' },
        ],
        ci: { state: 'failed', closed_by: 'upload' },
      },
      finished_at: expect.any(String) as string,
    });
    expect(update.eq).toHaveBeenCalledWith('kind', 'ci_job');
    expect(update.eq).toHaveBeenCalledWith('status', 'REQUESTED');
    expect(update.eq).toHaveBeenCalledWith('execution_id', EXEC);
    expect(update.or).toHaveBeenCalledWith(
      'result_summary->>send_pending.is.null,result_summary->>send_pending.neq.true',
    );
    expect(update.or).toHaveBeenCalledWith(
      'result_summary->ci.is.null,result_summary->ci->>state.eq.untracked',
    );
    expect(update.is).toHaveBeenCalledWith('result_summary->ci->run_id', null);
    expect(logActionForRequest).toHaveBeenCalledWith(
      user,
      'test_automation_run',
      RUN,
      'update',
      {
        action: 'close_by_upload',
        execution_id: EXEC,
        state: 'failed',
        tm_api_key_id: 'key-1',
      },
    );
  });

  it('counts the execution itself for a repaired upload that recorded nothing new', async () => {
    answers({ data: waiting(), error: null }, runs, {
      data: { id: RUN },
      error: null,
    });

    await service.closeByUpload(user, SPACE, RUN, EXEC, { applied: [] });

    const [values] = chains[2].update.mock.calls[0] as [
      { result_summary: { counts: unknown; ci: unknown } },
    ];

    expect(values.result_summary.counts).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
      skipped: 0,
    });
    expect(values.result_summary.ci).toEqual({
      state: 'failed',
      closed_by: 'upload',
    });
  });

  it('writes the execution back on a plan run when it belongs to that plan', async () => {
    answers(
      {
        data: waiting({ target: 'plan', plan_id: PLAN, execution_id: null }),
        error: null,
      },
      { data: { plan_id: PLAN }, error: null },
      runs,
      { data: { id: RUN }, error: null },
    );

    await expect(
      service.closeByUpload(user, SPACE, RUN, EXEC, applied(['r1', 'PASS'])),
    ).resolves.toEqual({ closed: true });

    const update = chains[3];

    expect(update.update).toHaveBeenCalledWith(
      expect.objectContaining({
        execution_id: EXEC,
        result_summary: expect.objectContaining({
          ci: { state: 'passed', closed_by: 'upload' },
        }) as Record<string, unknown>,
      }),
    );
    expect(update.is).toHaveBeenCalledWith('execution_id', null);
  });

  it('leaves a plan run alone when the execution is of another plan', async () => {
    answers(
      {
        data: waiting({ target: 'plan', plan_id: PLAN, execution_id: null }),
        error: null,
      },
      { data: { plan_id: 'plan-2' }, error: null },
    );

    await expect(
      service.closeByUpload(user, SPACE, RUN, EXEC, applied(['r1', 'PASS'])),
    ).resolves.toMatchObject({
      closed: false,
      warning: { code: 'RUN_NOT_CLOSABLE' },
    });
    expect(from).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'a followed GitHub run',
      { result_summary: { ci: { state: 'queued', run_id: 7 } } },
    ],
    ['a run still being sent', { result_summary: { send_pending: true } }],
    ['a failed start', { status: 'ERROR' }],
    ['a run of another execution', { execution_id: 'exec-2' }],
  ])('never closes %s', async (_label, extra) => {
    answers({ data: waiting(extra), error: null });

    await expect(
      service.closeByUpload(user, SPACE, RUN, EXEC, applied(['r1', 'PASS'])),
    ).resolves.toMatchObject({
      closed: false,
      warning: { code: 'RUN_NOT_CLOSABLE' },
    });
    expect(from).toHaveBeenCalledTimes(1);
    expect(logActionForRequest).not.toHaveBeenCalled();
  });

  it('says a run that already has a result is closed', async () => {
    answers({
      data: waiting({
        result_summary: { ci: { state: 'passed', closed_by: 'upload' } },
      }),
      error: null,
    });

    await expect(
      service.closeByUpload(user, SPACE, RUN, EXEC, applied(['r1', 'PASS'])),
    ).resolves.toMatchObject({ warning: { code: 'RUN_ALREADY_CLOSED' } });
  });

  it('says so when another upload closed the run first', async () => {
    answers({ data: waiting(), error: null }, runs, {
      data: null,
      error: null,
    });

    await expect(
      service.closeByUpload(user, SPACE, RUN, EXEC, applied(['r1', 'PASS'])),
    ).resolves.toMatchObject({ warning: { code: 'RUN_ALREADY_CLOSED' } });
    expect(logActionForRequest).not.toHaveBeenCalled();
  });

  it('says the target is gone when the execution of an execution run was deleted', async () => {
    answers({ data: waiting({ execution_id: null }), error: null });

    await expect(
      service.closeByUpload(user, SPACE, RUN, EXEC, applied(['r1', 'PASS'])),
    ).resolves.toMatchObject({ warning: { code: 'RUN_TARGET_GONE' } });
  });

  it('never fails the upload, also when the database does', async () => {
    answers(
      { data: null, error: null },
      { data: null, error: { message: 'down' } },
    );

    await expect(
      service.closeByUpload(user, SPACE, RUN, EXEC, applied(['r1', 'PASS'])),
    ).resolves.toMatchObject({ warning: { code: 'RUN_NOT_CLOSABLE' } });
    await expect(
      service.closeByUpload(user, SPACE, RUN, EXEC, applied(['r1', 'PASS'])),
    ).resolves.toMatchObject({ warning: { code: 'RUN_NOT_CLOSABLE' } });
  });
});
