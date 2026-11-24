import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { lookup as dnsLookup } from 'dns/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import {
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';

import type { AttachmentsService } from '../attachments/attachments.service';
import { packSecretForStorage } from '../lib/crypto/encryption';
import type { PermissionsService } from '../permissions/permissions.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { TestAutomationGitService } from '../test-management/automation/test-automation-git.service';
import type { TestManagementAccessService } from '../test-management/access/test-management-access.service';
import type { TestExecutionsService } from '../test-management/executions/test-executions.service';
import type { TestPlanTestsService } from '../test-management/plans/test-plan-tests.service';
import type { TestRunsService } from '../test-management/runs/test-runs.service';
import type { CucumberResultsService } from '../test-management/transfer/cucumber-results/cucumber-results.service';
import {
  DockerCommandError,
  type DockerDriver,
  type DockerResult,
  type RunTestsOptions,
} from './docker-driver';
import { HEARTBEAT_MS, RunnerService, type LeasedRun } from './runner.service';
import { safeUnzip, UnzipError } from './safe-unzip';

jest.mock('dns/promises', () => ({ lookup: jest.fn() }));
jest.mock('./safe-unzip', () => ({
  ...jest.requireActual<Record<string, unknown>>('./safe-unzip'),
  safeUnzip: jest.fn(),
}));

const RUN = '11111111-1111-4111-8111-111111111111';
const ORG = 'org-1';
const SPACE = 'space-1';
const WORKER = 'worker-1';
const IMAGE = `mcr.example.com/pw@sha256:${'a'.repeat(64)}`;
const JUNIT = '<testsuite><testcase classname="a" name="b"/></testsuite>';

function leasedRun(
  overrides: Partial<LeasedRun> = {},
  snapshot: Partial<LeasedRun['config_snapshot']> = {},
): LeasedRun {
  return {
    id: RUN,
    organization_id: ORG,
    space_id: SPACE,
    config_id: 'config-1',
    target: 'execution',
    plan_id: null,
    execution_id: 'execution-1',
    started_by: 'user-1',
    run_zip_path: null,
    ...overrides,
    config_snapshot: {
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
      ...snapshot,
    },
  };
}

interface TableAnswer {
  data?: unknown;
  error: { message: string } | null;
}

type Chain = Record<string, jest.Mock> & PromiseLike<TableAnswer>;

describe('RunnerService', () => {
  const saved = {
    secret: process.env.AI_ENCRYPTION_SECRET,
    images: process.env.TM_RUNNER_IMAGES,
    workDir: process.env.TM_RUNNER_WORK_DIR,
    privateHosts: process.env.TM_RUNNER_PRIVATE_HOSTS,
  };
  const lookup = dnsLookup as unknown as jest.Mock;
  const unzip = safeUnzip as unknown as jest.Mock;

  let base: string;
  let service: RunnerService;
  let tables: Record<string, TableAnswer>;
  let runAnswers: TableAnswer[];
  let runUpdates: Record<string, unknown>[];
  let runChains: Chain[];
  let rpc: jest.Mock;
  let download: jest.Mock;
  let remove: jest.Mock;
  let assertAvailable: jest.Mock;
  let hasSpacePermission: jest.Mock;
  let commit: jest.Mock;
  let importResults: jest.Mock;
  let createImport: jest.Mock;
  let removeExecution: jest.Mock;
  let addRuns: jest.Mock;
  let testIds: jest.Mock;
  let addPlanTests: jest.Mock;
  let upload: jest.Mock;
  let docker: Record<string, jest.Mock>;

  const chain = (table: string): Chain => {
    const built = {} as Chain;
    let answer: TableAnswer = tables[table] ?? { data: null, error: null };

    for (const name of ['select', 'eq', 'is', 'in', 'maybeSingle']) {
      built[name] = jest.fn(() => built);
    }

    built.update = jest.fn((patch: Record<string, unknown>) => {
      if (table === 'test_automation_runs') {
        runUpdates.push(patch);
        runChains.push(built);
        answer = runAnswers.shift() ?? {
          data: { id: RUN, status: 'RUNNING', cancel_requested_at: null },
          error: null,
        };
      }

      return built;
    });

    Object.assign(built, {
      then: (onFulfilled: (value: TableAnswer) => unknown) =>
        Promise.resolve(answer).then(onFulfilled),
    });

    return built;
  };

  /** Makes the test step write a results file, as a real framework would. */
  const testsWrite = (
    files: Record<string, string> = { 'results.xml': JUNIT },
    answer: DockerResult = { code: 0, output: 'all good' },
  ) => {
    docker.runTests.mockImplementation((options: RunTestsOptions) => {
      for (const [path, content] of Object.entries(files)) {
        const full = join(options.runFolder, path);

        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      }

      return Promise.resolve(answer);
    });
  };

  const lastSave = (): Record<string, unknown> => {
    const saves = runUpdates.filter((patch) => 'finished_at' in patch);

    expect(saves).toHaveLength(1);

    return saves[0];
  };

  const testOptions = () =>
    (docker.runTests.mock.calls as RunTestsOptions[][])[0][0];

  const firstUpload = () =>
    (upload.mock.calls as { file: Express.Multer.File }[][])[0][0];

  const runFolder = () => join(base, RUN);

  beforeAll(() => {
    process.env.AI_ENCRYPTION_SECRET = 'a'.repeat(64);
    process.env.TM_RUNNER_IMAGES = JSON.stringify({ playwright: IMAGE });
  });

  afterAll(() => {
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };

    restore('AI_ENCRYPTION_SECRET', saved.secret);
    restore('TM_RUNNER_IMAGES', saved.images);
    restore('TM_RUNNER_WORK_DIR', saved.workDir);
    restore('TM_RUNNER_PRIVATE_HOSTS', saved.privateHosts);
  });

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'runner-spec-'));
    process.env.TM_RUNNER_WORK_DIR = base;
    delete process.env.TM_RUNNER_PRIVATE_HOSTS;

    tables = {
      test_executions: {
        data: { id: 'execution-1', is_archived: false },
        error: null,
      },
      test_plans: { data: { id: 'plan-1', is_archived: false }, error: null },
      test_automation_configs: {
        data: { secrets_enc: null, archived_at: null },
        error: null,
      },
    };
    runAnswers = [];
    runUpdates = [];
    runChains = [];
    rpc = jest.fn().mockResolvedValue({ data: [], error: null });
    download = jest.fn().mockResolvedValue({
      data: new Blob(['zip bytes']),
      error: null,
    });
    remove = jest.fn().mockResolvedValue({ error: null });
    assertAvailable = jest.fn().mockResolvedValue(undefined);
    hasSpacePermission = jest.fn().mockResolvedValue(true);
    commit = jest.fn().mockResolvedValue({
      applied: [{ run_id: 'r1' }],
      created_cases: [],
      warnings: [],
    });
    importResults = jest.fn().mockResolvedValue({
      applied: [{ run_id: 'r1' }],
      created_cases: [{ case_id: 'c1' }],
      execution: { id: 'execution-new', key: 'P-TE9', replayed: false },
    });
    createImport = jest.fn().mockResolvedValue({
      execution_id: 'execution-new',
      key: 'P-TE9',
    });
    removeExecution = jest.fn().mockResolvedValue({});
    addRuns = jest.fn().mockResolvedValue({ added: 2, skipped: [] });
    testIds = jest.fn().mockResolvedValue(['c1', 'c2']);
    addPlanTests = jest.fn().mockResolvedValue({ changed: true });
    upload = jest.fn().mockResolvedValue({});
    lookup.mockReset();
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    unzip.mockReset();
    unzip.mockResolvedValue(undefined);
    docker = {
      createNetwork: jest.fn().mockResolvedValue(undefined),
      startProxy: jest.fn().mockResolvedValue(undefined),
      cloneRepo: jest.fn().mockResolvedValue({ code: 0, output: 'cloned' }),
      runTests: jest.fn(),
      stop: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    testsWrite();

    service = new RunnerService(
      {
        getClient: () => ({
          rpc,
          from: chain,
          storage: { from: () => ({ download, remove }) },
        }),
      } as unknown as SupabaseAdminService,
      { assertAvailable } as unknown as TestManagementAccessService,
      { hasSpacePermission } as unknown as PermissionsService,
      { commit, importResults } as unknown as CucumberResultsService,
      { upload } as unknown as AttachmentsService,
      docker as unknown as DockerDriver,
      {
        createImport,
        remove: removeExecution,
      } as unknown as TestExecutionsService,
      { addRuns } as unknown as TestRunsService,
      { testIds, add: addPlanTests } as unknown as TestPlanTestsService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    rmSync(base, { recursive: true, force: true });
  });

  describe('taking a run', () => {
    it('asks for a lease and reports when nothing waits', async () => {
      await expect(service.processNext(WORKER)).resolves.toBe(false);

      expect(rpc).toHaveBeenCalledWith('tm_lease_automation_run_fair', {
        p_worker_id: WORKER,
        p_lease_seconds: 60,
        p_max_per_org: 1,
      });
      expect(docker.createNetwork).not.toHaveBeenCalled();
    });

    it('runs what it was handed', async () => {
      rpc.mockResolvedValue({ data: [leasedRun()], error: null });

      await expect(service.processNext(WORKER)).resolves.toBe(true);
      expect(lastSave()).toMatchObject({ status: 'DONE' });
    });

    it('survives a failed lease', async () => {
      rpc.mockResolvedValue({ data: null, error: { message: 'down' } });

      await expect(service.processNext(WORKER)).resolves.toBe(false);
    });

    it('does not fall back on a real error of the fair pick', async () => {
      rpc.mockResolvedValue({ data: null, error: { message: 'down' } });

      await service.processNext(WORKER);

      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledWith(
        'tm_lease_automation_run_fair',
        expect.anything(),
      );
    });

    it('sends the per-organisation limit from the environment', async () => {
      const saved = process.env.TM_RUNNER_RUNNING_PER_ORG;

      process.env.TM_RUNNER_RUNNING_PER_ORG = '3';

      try {
        await service.processNext(WORKER);
      } finally {
        if (saved === undefined) delete process.env.TM_RUNNER_RUNNING_PER_ORG;
        else process.env.TM_RUNNER_RUNNING_PER_ORG = saved;
      }

      expect(rpc).toHaveBeenCalledWith(
        'tm_lease_automation_run_fair',
        expect.objectContaining({ p_max_per_org: 3 }),
      );
    });

    it.each([
      ['PGRST202', 'Could not find the function'],
      ['42883', 'function does not exist'],
      [
        undefined,
        'function public.tm_lease_automation_run_fair does not exist',
      ],
    ])(
      'falls back to the old pick while the fair pick is missing (%s)',
      async (code, message) => {
        rpc
          .mockResolvedValueOnce({ data: null, error: { code, message } })
          .mockResolvedValueOnce({ data: [], error: null })
          .mockResolvedValueOnce({ data: [], error: null });

        await expect(service.processNext(WORKER)).resolves.toBe(false);
        await expect(service.processNext(WORKER)).resolves.toBe(false);

        expect(rpc.mock.calls.map((call: unknown[]) => call[0])).toEqual([
          'tm_lease_automation_run_fair',
          'tm_lease_automation_run',
          'tm_lease_automation_run',
        ]);
        expect(rpc).toHaveBeenLastCalledWith('tm_lease_automation_run', {
          p_worker_id: WORKER,
          p_lease_seconds: 60,
        });
      },
    );
  });

  describe('a run that works', () => {
    it('ends DONE and passed when the tests pass', async () => {
      await service.execute(leasedRun(), WORKER);

      expect(lastSave()).toMatchObject({
        status: 'DONE',
        outcome: 'passed',
        exit_code: 0,
        error_code: null,
        lease_until: null,
        run_zip_path: null,
      });
    });

    it('ends DONE with failed tests when the tests fail but wrote results', async () => {
      testsWrite(undefined, { code: 1, output: '1 failed' });

      await service.execute(leasedRun(), WORKER);

      expect(lastSave()).toMatchObject({
        status: 'DONE',
        outcome: 'failed_tests',
        exit_code: 1,
      });
    });

    it('moves to UPLOADING only without a cancel, and before recording', async () => {
      commit.mockImplementation(() => {
        expect(runUpdates.map((patch) => patch.status)).toContain('UPLOADING');

        return Promise.resolve({ applied: [], created_cases: [] });
      });

      await service.execute(leasedRun(), WORKER);

      expect(commit).toHaveBeenCalledTimes(1);
    });

    it('makes the move to UPLOADING conditional on no cancel', async () => {
      await service.execute(leasedRun(), WORKER);

      const index = runUpdates.findIndex(
        (patch) => patch.status === 'UPLOADING',
      );
      const write = runChains[index];

      expect(write.eq).toHaveBeenCalledWith('status', 'RUNNING');
      expect(write.eq).toHaveBeenCalledWith('worker_id', WORKER);
      expect(write.is).toHaveBeenCalledWith('cancel_requested_at', null);
    });

    it('records the file into the execution as the person who started it', async () => {
      await service.execute(leasedRun({}, { create_unmatched: false }), WORKER);

      const [user, space, execution, file, options, mode] = (
        commit.mock.calls as unknown[][]
      )[0] as [
        { userId: string; organizationId: string },
        string,
        string,
        Express.Multer.File,
        unknown,
        unknown,
      ];

      expect(user).toMatchObject({ userId: 'user-1', organizationId: ORG });
      expect(space).toBe(SPACE);
      expect(execution).toBe('execution-1');
      expect(file.originalname).toBe('results.xml');
      expect(file.buffer.toString()).toContain(
        `xisuite-automation-run ${RUN}/1`,
      );
      expect(options).toEqual({ create_unmatched: false });
      expect(mode).toEqual({ addInSpace: false, noRerun: true });
      expect(importResults).not.toHaveBeenCalled();
    });

    describe('a run from one test case', () => {
      const caseRun = (snapshot = {}) =>
        leasedRun({ result_summary: { case_id: 'case-1' } }, snapshot);
      const modeOf = () => (commit.mock.calls as unknown[][])[0][5];
      const optionsOf = () => (commit.mock.calls as unknown[][])[0][4];

      it('tells the import to record only that case and creates no test cases', async () => {
        await service.execute(caseRun({ create_unmatched: true }), WORKER);

        expect(modeOf()).toEqual({
          addInSpace: false,
          noRerun: true,
          only_case_id: 'case-1',
        });
        expect(optionsOf()).toEqual({ create_unmatched: false });
      });

      it('keeps the case on the run through every write and the final save', async () => {
        await service.execute(caseRun(), WORKER);

        const summaries = runUpdates.flatMap((patch) =>
          patch.result_summary ? [patch.result_summary] : [],
        );

        expect(summaries.length).toBeGreaterThan(1);

        for (const summary of summaries) {
          expect(summary).toMatchObject({ case_id: 'case-1' });
        }

        expect(lastSave().result_summary).toMatchObject({ case_id: 'case-1' });
      });
    });

    it('keeps what was recorded in the summary', async () => {
      commit.mockResolvedValue({
        applied: [{ run_id: 'r1' }, { run_id: 'r2' }],
        created_cases: [{ case_id: 'c1' }],
        warnings: [{ code: 'W1' }],
      });

      await service.execute(leasedRun(), WORKER);

      expect(lastSave().result_summary).toMatchObject({
        exit_code: 0,
        import: {
          uploaded: ['results.xml'],
          applied: 2,
          created: 1,
          warnings: [{ code: 'W1' }],
        },
      });
    });

    it('notes files it refused but still records the good ones', async () => {
      testsWrite({ 'results.xml': JUNIT, 'other.txt': 'x' });

      await service.execute(
        leasedRun({}, { result_paths: ['results.xml', 'other.txt'] }),
        WORKER,
      );

      expect(lastSave()).toMatchObject({ status: 'DONE' });
      expect(lastSave().result_summary).toMatchObject({
        file_problems: [{ path: 'other.txt', code: 'NOT_XML' }],
      });
    });

    it('notes a browser version mismatch', async () => {
      testsWrite(undefined, {
        code: 1,
        output: "Error: Executable doesn't exist at /ms-playwright/chromium",
      });

      await service.execute(leasedRun(), WORKER);

      expect(lastSave().result_summary).toMatchObject({
        warnings: ['BROWSER_VERSION_MISMATCH'],
      });
    });
  });

  describe('a plan run', () => {
    const planRun = () =>
      leasedRun({ target: 'plan', plan_id: 'plan-1', execution_id: null });

    it('creates one execution with the plan’s tests, then sends every file to it', async () => {
      testsWrite({ 'r/a.xml': JUNIT, 'r/b.xml': JUNIT });

      await service.execute(
        leasedRun(
          { target: 'plan', plan_id: 'plan-1', execution_id: null },
          { result_paths: ['r/*.xml'], create_unmatched: true },
        ),
        WORKER,
      );

      expect(importResults).not.toHaveBeenCalled();
      expect(createImport).toHaveBeenCalledTimes(1);
      expect((createImport.mock.calls as unknown[][])[0][2]).toMatchObject({
        request_id: RUN,
        plan_id: 'plan-1',
        name: expect.stringContaining('Automation Browser tests') as string,
      });
      expect(addRuns).toHaveBeenCalledTimes(1);
      expect((addRuns.mock.calls as unknown[][])[0].slice(1)).toEqual([
        SPACE,
        'execution-new',
        ['c1', 'c2'],
      ]);
      expect(commit).toHaveBeenCalledTimes(2);

      for (const call of commit.mock.calls as unknown[][]) {
        expect(call[2]).toBe('execution-new');
        expect(call[4]).toEqual({ create_unmatched: true });
        expect(call[5]).toEqual({ addInSpace: true, noRerun: true });
      }
    });

    it('adds the plan’s tests before the first result', async () => {
      await service.execute(planRun(), WORKER);

      expect(addRuns.mock.invocationCallOrder[0]).toBeLessThan(
        commit.mock.invocationCallOrder[0],
      );
    });

    it('does not ask for runs when the plan has no tests', async () => {
      testIds.mockResolvedValue([]);

      await service.execute(planRun(), WORKER);

      expect(addRuns).not.toHaveBeenCalled();
      expect(commit).toHaveBeenCalledTimes(1);
    });

    it('creates nothing when no result file appears', async () => {
      docker.runTests.mockResolvedValue({ code: 1, output: 'crash' });

      await service.execute(planRun(), WORKER);

      expect(createImport).not.toHaveBeenCalled();
    });

    it('adds a newly created test to the plan', async () => {
      commit.mockResolvedValue({
        applied: [{ run_id: 'r1' }],
        created_cases: [{ case_id: 'new-1', key: 'TC9' }],
        warnings: [],
      });

      await service.execute(planRun(), WORKER);

      expect(addPlanTests).toHaveBeenCalledWith(
        expect.anything(),
        SPACE,
        'plan-1',
        { source: 'cases', case_ids: ['new-1'] },
      );
    });

    it('leaves the plan alone when no test was created', async () => {
      await service.execute(planRun(), WORKER);

      expect(addPlanTests).not.toHaveBeenCalled();
    });

    it('still finishes, with a warning, when the plan cannot be updated', async () => {
      commit.mockResolvedValue({
        applied: [{ run_id: 'r1' }],
        created_cases: [{ case_id: 'new-1', key: 'TC9' }],
        warnings: [],
      });
      addPlanTests.mockRejectedValue(new Error('plan archived'));

      await service.execute(planRun(), WORKER);

      expect(lastSave()).toMatchObject({ status: 'DONE' });
      expect(lastSave().result_summary).toMatchObject({
        import: {
          warnings: [expect.objectContaining({ code: 'PLAN_NOT_UPDATED' })],
        },
      });
    });

    it('calls none of this for an execution run', async () => {
      commit.mockResolvedValue({
        applied: [{ run_id: 'r1' }],
        created_cases: [{ case_id: 'new-1', key: 'TC9' }],
        warnings: [],
      });

      await service.execute(leasedRun(), WORKER);

      expect(createImport).not.toHaveBeenCalled();
      expect(testIds).not.toHaveBeenCalled();
      expect(addRuns).not.toHaveBeenCalled();
      expect(addPlanTests).not.toHaveBeenCalled();
    });

    it('links the run to the new execution', async () => {
      await service.execute(planRun(), WORKER);

      expect(runUpdates).toContainEqual({ execution_id: 'execution-new' });
    });

    it('attaches the log to the new execution', async () => {
      await service.execute(planRun(), WORKER);

      expect(upload).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'test_execution',
          entityId: 'execution-new',
        }),
      );
    });

    it('has nowhere to attach a log when it fails before any results', async () => {
      docker.runTests.mockResolvedValue({ code: 1, output: 'crash' });

      await service.execute(planRun(), WORKER);

      expect(lastSave()).toMatchObject({ error_code: 'RESULTS_MISSING' });
      expect(upload).not.toHaveBeenCalled();
    });
  });

  describe('checks when the run starts', () => {
    const expectNoDocker = () => {
      expect(docker.createNetwork).not.toHaveBeenCalled();
      expect(docker.runTests).not.toHaveBeenCalled();
    };

    it('cancels when the module or licence is off', async () => {
      assertAvailable.mockRejectedValue(new ForbiddenException());

      await service.execute(leasedRun(), WORKER);

      expect(assertAvailable).toHaveBeenCalledWith(ORG, SPACE, { write: true });
      expect(lastSave()).toMatchObject({
        status: 'CANCELLED',
        error_code: 'MODULE_DISABLED',
      });
      expectNoDocker();
    });

    it('cancels when the person who started it left', async () => {
      await service.execute(leasedRun({ started_by: null }), WORKER);

      expect(lastSave()).toMatchObject({
        status: 'CANCELLED',
        error_code: 'PERMISSION_LOST',
      });
      expectNoDocker();
    });

    it.each(['execute_tests', 'manage_test_runs'])(
      'cancels when the person lost %s',
      async (lost) => {
        hasSpacePermission.mockImplementation(
          (_user: string, _org: string, _space: string, right: string) =>
            Promise.resolve(right !== lost),
        );

        await service.execute(leasedRun(), WORKER);

        expect(lastSave()).toMatchObject({ error_code: 'PERMISSION_LOST' });
        expectNoDocker();
      },
    );

    it('needs create_tests only when the setting creates tests', async () => {
      hasSpacePermission.mockImplementation(
        (_user: string, _org: string, _space: string, right: string) =>
          Promise.resolve(right !== 'create_tests'),
      );

      await service.execute(leasedRun(), WORKER);
      expect(lastSave()).toMatchObject({ status: 'DONE' });

      runUpdates = [];
      await service.execute(leasedRun({}, { create_unmatched: true }), WORKER);
      expect(lastSave()).toMatchObject({ error_code: 'PERMISSION_LOST' });
    });

    it.each([
      ['deleted', { data: null, error: null }],
      ['archived', { data: { id: 'e', is_archived: true }, error: null }],
    ])('stops when the execution was %s', async (_name, answer) => {
      tables.test_executions = answer;

      await service.execute(leasedRun(), WORKER);

      expect(lastSave()).toMatchObject({
        status: 'ERROR',
        error_code: 'EXECUTION_GONE',
      });
      expectNoDocker();
    });

    it('stops when the link to the execution was cleared', async () => {
      await service.execute(leasedRun({ execution_id: null }), WORKER);

      expect(lastSave()).toMatchObject({ error_code: 'EXECUTION_GONE' });
    });

    it('stops when the setting was deleted', async () => {
      await service.execute(leasedRun({ config_id: null }), WORKER);

      expect(lastSave()).toMatchObject({ error_code: 'CONFIG_GONE' });
      expectNoDocker();
    });

    it('cancels when the setting was archived', async () => {
      tables.test_automation_configs = {
        data: { secrets_enc: null, archived_at: '2026-11-02T00:00:00Z' },
        error: null,
      };

      await service.execute(leasedRun(), WORKER);

      expect(lastSave()).toMatchObject({
        status: 'CANCELLED',
        error_code: 'CONFIG_ARCHIVED',
      });
    });

    it('stops when the image is no longer allowed', async () => {
      await service.execute(leasedRun({}, { image_key: 'gone' }), WORKER);

      expect(lastSave()).toMatchObject({ error_code: 'IMAGE_NOT_ALLOWED' });
      expectNoDocker();
    });

    it('checks the rights again right before recording', async () => {
      docker.runTests.mockImplementation((options: RunTestsOptions) => {
        writeFileSync(join(options.runFolder, 'results.xml'), JUNIT);
        hasSpacePermission.mockResolvedValue(false);

        return Promise.resolve({ code: 0, output: '' });
      });

      await service.execute(leasedRun(), WORKER);

      expect(commit).not.toHaveBeenCalled();
      expect(lastSave()).toMatchObject({ error_code: 'PERMISSION_LOST' });
    });
  });

  describe('network', () => {
    it('pins each public host to the address it checked', async () => {
      await service.execute(leasedRun(), WORKER);

      expect(docker.createNetwork).toHaveBeenCalledWith(RUN);
      expect(docker.startProxy).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: RUN,
          configFolder: join(realpathSync(base), RUN, 'proxy'),
          hosts: expect.arrayContaining([
            { host: 'app.example.com', address: '93.184.216.34' },
            { host: 'registry.npmjs.org', address: '93.184.216.34' },
            { host: 'git.example.com', address: '93.184.216.34' },
          ]) as unknown,
        }),
      );
    });

    it('pins an IPv4 address when DNS lists IPv6 first', async () => {
      lookup.mockResolvedValue([
        { address: '2606:4700:4700::1111', family: 6 },
        { address: '93.184.216.34', family: 4 },
      ]);

      await service.execute(leasedRun(), WORKER);

      expect(docker.startProxy).toHaveBeenCalledWith(
        expect.objectContaining({
          hosts: expect.arrayContaining([
            { host: 'app.example.com', address: '93.184.216.34' },
          ]) as unknown,
        }),
      );
    });

    it('keeps the IPv6 address of a host that has nothing else', async () => {
      lookup.mockResolvedValue([
        { address: '2606:4700:4700::1111', family: 6 },
      ]);

      await service.execute(leasedRun(), WORKER);

      expect(docker.startProxy).toHaveBeenCalledWith(
        expect.objectContaining({
          hosts: expect.arrayContaining([
            { host: 'app.example.com', address: '2606:4700:4700::1111' },
          ]) as unknown,
        }),
      );
    });

    it('writes the allowed hosts where the proxy reads them', async () => {
      let filter = '';
      let config = '';

      docker.startProxy.mockImplementation(
        (options: { configFolder: string }) => {
          filter = readFileSync(join(options.configFolder, 'filter'), 'utf8');
          config = readFileSync(
            join(options.configFolder, 'tinyproxy.conf'),
            'utf8',
          );

          return Promise.resolve();
        },
      );

      await service.execute(
        leasedRun({}, { allowed_hosts: ['app.example.com:8443'] }),
        WORKER,
      );

      expect(filter).toContain('^(https?://)?app\\.example\\.com:8443(/|$)');
      expect(filter).toContain('^(https?://)?git\\.example\\.com(:443)?(/|$)');
      expect(config).toContain('ConnectPort 8443');
      expect(config).toContain('FilterDefaultDeny Yes');
    });

    it.each(['10.0.0.5', '127.0.0.1', '169.254.169.254'])(
      'refuses a host that resolves to %s and starts nothing',
      async (address) => {
        lookup.mockResolvedValue([
          { address: '93.184.216.34', family: 4 },
          { address, family: 4 },
        ]);

        await service.execute(leasedRun(), WORKER);

        expect(lastSave()).toMatchObject({
          status: 'ERROR',
          error_code: 'BLOCKED_HOST',
        });
        expect(docker.createNetwork).not.toHaveBeenCalled();
      },
    );

    it('refuses a host that does not resolve', async () => {
      lookup.mockRejectedValue(new Error('ENOTFOUND'));

      await service.execute(leasedRun(), WORKER);

      expect(lastSave()).toMatchObject({ error_code: 'BLOCKED_HOST' });
    });

    it('allows private hosts only from the operator setting, without resolving them', async () => {
      process.env.TM_RUNNER_PRIVATE_HOSTS = 'abj-experts.lvh.me:3000';

      await service.execute(leasedRun({}, { allowed_hosts: [] }), WORKER);

      expect(lookup).not.toHaveBeenCalledWith(
        'abj-experts.lvh.me',
        expect.anything(),
      );
    });

    it('sends a private host through the host gateway', async () => {
      process.env.TM_RUNNER_PRIVATE_HOSTS = 'abj-experts.lvh.me:3000';

      await service.execute(leasedRun(), WORKER);

      expect(docker.startProxy).toHaveBeenCalledWith(
        expect.objectContaining({
          hosts: expect.arrayContaining([
            { host: 'abj-experts.lvh.me', address: 'host-gateway' },
          ]) as unknown,
        }),
      );
    });

    describe('in production', () => {
      const savedEnv = process.env.NODE_ENV;

      afterEach(() => {
        process.env.NODE_ENV = savedEnv;
      });

      it('ignores private hosts, so tests never reach the machine’s own services', async () => {
        process.env.NODE_ENV = 'production';
        process.env.TM_RUNNER_PRIVATE_HOSTS = 'abj-experts.lvh.me:3000';

        let filter = '';

        docker.startProxy.mockImplementation(
          (options: { configFolder: string }) => {
            filter = readFileSync(join(options.configFolder, 'filter'), 'utf8');

            return Promise.resolve();
          },
        );

        await service.execute(leasedRun(), WORKER);

        const { hosts } = (
          docker.startProxy.mock.calls as { hosts: { address: string }[] }[][]
        )[0][0];

        expect(hosts.map(({ address }) => address)).not.toContain(
          'host-gateway',
        );
        expect(filter).not.toContain('lvh');
      });
    });

    it('reports a proxy that could not start, with Docker’s answer', async () => {
      docker.startProxy.mockRejectedValue(
        new DockerCommandError('start the proxy', 'no such image'),
      );

      await service.execute(leasedRun(), WORKER);

      expect(lastSave()).toMatchObject({ error_code: 'START_FAILED' });
      expect(lastSave().error_message).toContain('no such image');
      expect(docker.runTests).not.toHaveBeenCalled();
    });
  });

  describe('App and API URLs', () => {
    const PUBLIC = [{ address: '93.184.216.34', family: 4 }];
    let filter: string;
    let config: string;

    beforeEach(() => {
      filter = '';
      config = '';
      docker.startProxy.mockImplementation(
        (options: { configFolder: string }) => {
          filter = readFileSync(join(options.configFolder, 'filter'), 'utf8');
          config = readFileSync(
            join(options.configFolder, 'tinyproxy.conf'),
            'utf8',
          );

          return Promise.resolve();
        },
      );
    });

    const appRun = (env: Record<string, string>, allowedHosts: string[] = []) =>
      leasedRun({}, { env, allowed_hosts: allowedHosts });
    const looked = () =>
      (lookup.mock.calls as string[][]).map(([host]) => host);
    const pins = () =>
      (
        docker.startProxy.mock.calls as {
          hosts: { host: string; address: string }[];
        }[][]
      )[0][0].hosts;
    const savedLog = () => firstUpload().file.buffer.toString();
    const warnings = () =>
      (lastSave().result_summary as { warnings?: string[] }).warnings ?? [];
    const withSecrets = (secrets: Record<string, string>) => {
      tables.test_automation_configs = {
        data: {
          secrets_enc: packSecretForStorage(JSON.stringify(secrets)),
          archived_at: null,
        },
        error: null,
      };
    };

    it('opens and pins the public host of an App URL, and sends Node through the proxy', async () => {
      await service.execute(
        appRun({ BASE_URL: 'https://shop.example.org/login' }),
        WORKER,
      );

      expect(lastSave()).toMatchObject({ status: 'DONE' });
      expect(looked()).toContain('shop.example.org');
      expect(pins()).toContainEqual({
        host: 'shop.example.org',
        address: '93.184.216.34',
      });
      expect(filter).toContain('^(https?://)?shop\\.example\\.org(:443)?(/|$)');
      expect(testOptions().env.NODE_USE_ENV_PROXY).toBe('1');
      expect(testOptions().env.NO_PROXY).toBe('localhost,127.0.0.1,::1');
      expect(warnings()).not.toContain('APP_URL_BLOCKED');
    });

    it('opens the port of an API URL', async () => {
      await service.execute(
        appRun({ API_URL: 'http://api.example.org:8080/v1' }),
        WORKER,
      );

      expect(filter).toContain('^(https?://)?api\\.example\\.org:8080(/|$)');
      expect(config).toContain('ConnectPort 8080');
      expect(pins()).toContainEqual({
        host: 'api.example.org',
        address: '93.184.216.34',
      });
    });

    it('looks a host up once when both URLs share it', async () => {
      await service.execute(
        appRun({
          BASE_URL: 'https://x.example.org/a',
          API_URL: 'https://x.example.org/b',
        }),
        WORKER,
      );

      expect(looked().filter((host) => host === 'x.example.org')).toHaveLength(
        1,
      );
      expect(
        pins().filter(({ host }) => host === 'x.example.org'),
      ).toHaveLength(1);
      expect(filter.match(/x\\.example\\.org/g)).toHaveLength(1);
    });

    it('adds nothing for a host the setting already allows', async () => {
      await service.execute(
        appRun(
          {
            BASE_URL: 'https://app.example.com',
            API_URL: 'https://app.example.com/api',
          },
          ['app.example.com'],
        ),
        WORKER,
      );

      expect(
        looked().filter((host) => host === 'app.example.com'),
      ).toHaveLength(1);
      expect(
        pins().filter(({ host }) => host === 'app.example.com'),
      ).toHaveLength(1);
      expect(testOptions().env).not.toHaveProperty('NODE_USE_ENV_PROXY');
    });

    it('adds only the new port of a host the setting already allows', async () => {
      await service.execute(
        appRun({ API_URL: 'https://app.example.com:8443' }, [
          'app.example.com',
        ]),
        WORKER,
      );

      expect(
        looked().filter((host) => host === 'app.example.com'),
      ).toHaveLength(1);
      expect(filter).toContain('^(https?://)?app\\.example\\.com:8443(/|$)');
      expect(testOptions().env.NODE_USE_ENV_PROXY).toBe('1');
    });

    it('leaves a development host to the private list, and names a port it lacks', async () => {
      process.env.TM_RUNNER_PRIVATE_HOSTS = 'abj-experts.lvh.me:3000';

      await service.execute(
        appRun({ BASE_URL: 'https://abj-experts.lvh.me:3002/app' }),
        WORKER,
      );

      expect(looked()).not.toContain('abj-experts.lvh.me');
      expect(
        pins().filter(({ host }) => host === 'abj-experts.lvh.me'),
      ).toEqual([{ host: 'abj-experts.lvh.me', address: 'host-gateway' }]);
      expect(filter).not.toContain('3002');
      expect(savedLog()).toContain(
        "BASE_URL host abj-experts.lvh.me:3002 uses a port TM_RUNNER_PRIVATE_HOSTS doesn't list",
      );
      expect(testOptions().env).not.toHaveProperty('NODE_USE_ENV_PROXY');
      expect(warnings()).not.toContain('APP_URL_BLOCKED');
    });

    it('says nothing about a development host on the listed port', async () => {
      process.env.TM_RUNNER_PRIVATE_HOSTS = 'abj-experts.lvh.me:3000';

      await service.execute(
        appRun({ BASE_URL: 'http://abj-experts.lvh.me:3000' }),
        WORKER,
      );

      expect(savedLog()).not.toContain('BASE_URL');
    });

    it('skips localhost addresses without a word', async () => {
      await service.execute(
        appRun({
          BASE_URL: 'http://app.localhost:3000',
          API_URL: 'http://localhost:3001',
        }),
        WORKER,
      );

      expect(lastSave()).toMatchObject({ status: 'DONE' });
      expect(looked().some((host) => host.includes('localhost'))).toBe(false);
      expect(filter).not.toContain('localhost');
      expect(savedLog()).not.toContain('BASE_URL');
      expect(savedLog()).not.toContain('API_URL');
      expect(warnings()).not.toContain('APP_URL_BLOCKED');
    });

    it.each([
      'ftp://files.example.org',
      'https://93.184.216.34/x',
      'https://example.org./x',
      'https://under_score.example.org',
      'https://[2606:4700::1111]:8080',
      'not an address',
    ])('ignores %s and says so without the value', async (value) => {
      await service.execute(appRun({ BASE_URL: value }), WORKER);

      expect(lastSave()).toMatchObject({ status: 'DONE' });
      expect(looked()).toEqual(['registry.npmjs.org', 'git.example.com']);
      expect(savedLog()).toContain(
        "BASE_URL is not an http or https address with a host name, so the tests can't reach it",
      );
      expect(savedLog()).not.toContain(value);
      expect(testOptions().env).not.toHaveProperty('NODE_USE_ENV_PROXY');
      expect(warnings()).not.toContain('APP_URL_BLOCKED');
    });

    it('uses the secret of the same name, as the tests get it', async () => {
      withSecrets({ BASE_URL: 'https://secret.example.org/app' });

      await service.execute(
        appRun({ BASE_URL: 'https://plain.example.org' }),
        WORKER,
      );

      expect(looked()).toContain('secret.example.org');
      expect(looked()).not.toContain('plain.example.org');
      expect(testOptions().env.BASE_URL).toBe('https://secret.example.org/app');
    });

    it.each<[string, () => Promise<unknown>]>([
      [
        'is private',
        () => Promise.resolve([{ address: '10.0.0.5', family: 4 }]),
      ],
      ['does not resolve', () => Promise.reject(new Error('ENOTFOUND'))],
    ])('warns instead of failing when the host %s', async (_, answer) => {
      lookup.mockImplementation((host: string) =>
        host === 'blocked.example.org' ? answer() : Promise.resolve(PUBLIC),
      );

      await service.execute(
        appRun({
          BASE_URL: 'https://blocked.example.org/private-path',
          API_URL: 'https://api.example.org',
        }),
        WORKER,
      );

      expect(lastSave()).toMatchObject({ status: 'DONE', error_code: null });
      expect(warnings()).toContain('APP_URL_BLOCKED');
      expect(filter).not.toContain('blocked');
      expect(filter).toContain('api\\.example\\.org');
      expect(pins().some(({ host }) => host === 'blocked.example.org')).toBe(
        false,
      );
      expect(savedLog()).toContain(
        "BASE_URL host blocked.example.org isn't a public address, so the tests can't reach it",
      );
      expect(savedLog()).not.toContain('private-path');
      expect(testOptions().env.NODE_USE_ENV_PROXY).toBe('1');
    });

    it('adds no proxy flag when the only URL host is blocked', async () => {
      lookup.mockImplementation((host: string) =>
        host === 'blocked.example.org'
          ? Promise.resolve([{ address: '127.0.0.1', family: 4 }])
          : Promise.resolve(PUBLIC),
      );

      await service.execute(
        appRun({ BASE_URL: 'https://blocked.example.org' }),
        WORKER,
      );

      expect(warnings()).toEqual(['APP_URL_BLOCKED']);
      expect(testOptions().env).not.toHaveProperty('NODE_USE_ENV_PROXY');
    });

    it.each<[string, Record<string, string>]>([
      ['neither is set', {}],
      [
        'both are skipped',
        { BASE_URL: 'http://localhost:3000', API_URL: 'ftp://x.example.org' },
      ],
    ])('changes nothing when %s', async (_, env) => {
      await service.execute(appRun(env, ['app.example.com']), WORKER);

      expect(looked()).toEqual([
        'app.example.com',
        'registry.npmjs.org',
        'git.example.com',
      ]);
      expect(pins()).toEqual([
        { host: 'app.example.com', address: '93.184.216.34' },
        { host: 'registry.npmjs.org', address: '93.184.216.34' },
        { host: 'git.example.com', address: '93.184.216.34' },
      ]);
      expect(filter).toBe(
        [
          '^(https?://)?app\\.example\\.com(:443)?(/|$)',
          '^(https?://)?registry\\.npmjs\\.org(:443)?(/|$)',
          '^(https?://)?git\\.example\\.com(:443)?(/|$)',
          '',
        ].join('\n'),
      );
      expect(config).not.toMatch(/ConnectPort (?!443)/);
      expect(testOptions().env).toEqual({
        ...env,
        XISUITE_RESULT: 'results.xml',
        PLAYWRIGHT_JUNIT_OUTPUT_NAME: 'results.xml',
        DEBUG: 'pw:api',
      });
      expect(warnings()).toEqual([]);
    });
  });

  describe('the final save', () => {
    const saves = () => runUpdates.filter((patch) => 'finished_at' in patch);
    const blip = { data: null, error: { message: 'blip' } };
    // The three stage writes of a run that stops before its upload.
    const stageWrites = [
      { data: null, error: null },
      { data: null, error: null },
      { data: null, error: null },
    ];
    const liveWrites = () =>
      runUpdates.filter(
        (patch) =>
          !('finished_at' in patch) &&
          'live_log' in
            ((patch.result_summary ?? {}) as Record<string, unknown>),
      );

    beforeEach(() => {
      // Ends before any upload, so the only update of the run is the save.
      docker.runTests.mockResolvedValue({ code: 1, output: 'crash' });
    });

    it('does one update when it works', async () => {
      await service.execute(leasedRun(), WORKER);

      expect(saves()).toHaveLength(1);
    });

    it('tries again after a database blip', async () => {
      runAnswers.push(...stageWrites, blip);

      await service.execute(leasedRun(), WORKER);

      expect(saves()).toHaveLength(2);
      expect(saves()[1]).toMatchObject({
        status: 'ERROR',
        error_code: 'RESULTS_MISSING',
      });
    });

    it('gives up after three tries, leaving the run to the reaper', async () => {
      runAnswers.push(...stageWrites, blip, blip, blip);

      await expect(
        service.execute(leasedRun(), WORKER),
      ).resolves.toBeUndefined();

      expect(saves()).toHaveLength(3);
      expect(docker.remove).toHaveBeenCalledWith(RUN);
    });

    it('saves the output while tests run, and the final save replaces it', async () => {
      docker.runTests.mockImplementation((options: RunTestsOptions) => {
        options.onOutput?.(Buffer.from('Running 5 tests\n'));

        return Promise.resolve({ code: 1, output: 'crash' });
      });

      await service.execute(leasedRun(), WORKER);

      const live = liveWrites();

      expect(live.length).toBeGreaterThan(0);
      expect(live[0].result_summary).toMatchObject({
        live_log: 'Running 5 tests\n',
      });
      expect(lastSave().result_summary).not.toHaveProperty('live_log');
    });

    it('saves nothing extra when a test step prints nothing', async () => {
      docker.runTests.mockResolvedValue({ code: 1, output: 'crash' });

      await service.execute(leasedRun(), WORKER);

      expect(liveWrites()).toHaveLength(0);
    });

    it('removes NUL bytes from the error text', async () => {
      docker.runTests.mockResolvedValue({ code: 1, output: 'cr\0ash' });

      await service.execute(leasedRun(), WORKER);

      expect(lastSave().error_message).toContain('crash');
      expect(lastSave().error_message).not.toContain('\0');
    });

    it('removes NUL bytes from the summary, however deep', async () => {
      docker.runTests.mockImplementation((options: RunTestsOptions) => {
        writeFileSync(join(options.runFolder, 'results.xml'), JUNIT);

        return Promise.resolve({ code: 0, output: 'ok' });
      });
      commit.mockResolvedValue({
        applied: [],
        created_cases: [],
        warnings: [{ code: 'W1', message: 'bad\0text', nested: ['a\0b'] }],
      });

      await service.execute(leasedRun(), WORKER);

      const summary = lastSave().result_summary as {
        import: { warnings: Record<string, unknown>[] };
      };

      expect(summary.import.warnings[0]).toEqual({
        code: 'W1',
        message: 'badtext',
        nested: ['ab'],
      });
    });
  });

  describe('results that reached no test', () => {
    const answer = (names: string[]) => ({
      applied: [{ run_id: 'r1' }],
      created_cases: [],
      warnings: [],
      dropped: { count: names.length, names },
    });
    const summaryOf = (save: Record<string, unknown>) =>
      save.result_summary as { import: Record<string, unknown> };

    it('adds them up across files and keeps the outcome', async () => {
      commit
        .mockResolvedValueOnce(answer(['a.one', 'a.two']))
        .mockResolvedValueOnce(answer(['b.one']));
      testsWrite({ 'a.xml': JUNIT, 'b.xml': JUNIT });

      await service.execute(leasedRun({}, { result_paths: ['*.xml'] }), WORKER);

      const save = lastSave();

      expect(save).toMatchObject({ status: 'DONE', outcome: 'passed' });
      expect(summaryOf(save).import.dropped).toEqual({
        count: 3,
        names: ['a.one', 'a.two', 'b.one'],
      });
    });

    it('stops listing names at 50 across files', async () => {
      const names = (prefix: string) =>
        Array.from({ length: 40 }, (_, index) => `${prefix}${index}`);

      commit
        .mockResolvedValueOnce(answer(names('a')))
        .mockResolvedValueOnce(answer(names('b')));
      testsWrite({ 'a.xml': JUNIT, 'b.xml': JUNIT });

      await service.execute(leasedRun({}, { result_paths: ['*.xml'] }), WORKER);

      const { dropped } = summaryOf(lastSave()).import as {
        dropped: { count: number; names: string[] };
      };

      expect(dropped.count).toBe(80);
      expect(dropped.names).toHaveLength(50);
    });
  });

  describe('commands and selected files', () => {
    it('runs a queued copy of a setting from before these fields as it always did', async () => {
      await service.execute(leasedRun(), WORKER);

      expect(testOptions().command).toBe(
        "if [ -f package-lock.json ]; then npm ci; else npm install; fi && printf '%s\\n' XISUITE_TESTS_START && npx playwright test --reporter=list,junit,/work/.xisuite-progress.cjs",
      );
      expect(testOptions()).not.toHaveProperty('args');
      expect(testOptions().env).not.toHaveProperty('XISUITE_SPEC_FILES');
      expect(lastSave()).toMatchObject({ status: 'DONE' });
    });

    it('passes the selected files and uses the install command of the copy', async () => {
      await service.execute(
        leasedRun(
          {},
          {
            preset: 'pytest',
            install_command: 'pip install . # local',
            spec_files: ['test_a.py', 'test_b.py'],
          },
        ),
        WORKER,
      );

      expect(testOptions().command).toBe(
        `(\npip install . # local\n) && printf '%s\\n' XISUITE_TESTS_START && python -m pytest -v --junitxml="$XISUITE_RESULT" "$@"`,
      );
      expect(testOptions().args).toEqual(['test_a.py', 'test_b.py']);
      expect(testOptions().env.XISUITE_SPEC_FILES).toBe('test_a.py,test_b.py');
    });

    it('starts Playwright patterns from the tests folder of the copy', async () => {
      await service.execute(
        leasedRun({}, { work_dir: 'e2e', spec_files: ['a.spec.js'] }),
        WORKER,
      );

      expect(testOptions().args).toEqual(['^/work/e2e/a\\.spec\\.js$']);
    });

    it('lets a stored command run on any framework', async () => {
      await service.execute(leasedRun({}, { command: 'make e2e' }), WORKER);

      expect(testOptions().command).toContain('(\nmake e2e\n)');
    });

    it('keeps the selection in the saved summary', async () => {
      await service.execute(
        leasedRun({ result_summary: { spec_files: ['a.spec.js'] } }, {}),
        WORKER,
      );

      expect(lastSave().result_summary).toMatchObject({
        spec_files: ['a.spec.js'],
      });
    });

    it('stops at a failed install: the log explains it and no result is recorded', async () => {
      docker.runTests.mockResolvedValue({
        code: 7,
        output: 'install failed',
      });

      await service.execute(
        leasedRun({}, { install_command: 'npm i' }),
        WORKER,
      );

      expect(commit).not.toHaveBeenCalled();
      expect(lastSave()).toMatchObject({
        status: 'ERROR',
        error_code: 'RESULTS_MISSING',
      });
      expect(lastSave().error_message).toContain('install failed');
    });
  });

  describe('test code', () => {
    it('does not take a result file that came with the code as this run’s', async () => {
      let shipped = '';

      docker.cloneRepo.mockImplementation((options: { runFolder: string }) => {
        shipped = join(options.runFolder, 'results.xml');
        writeFileSync(shipped, JUNIT);

        return Promise.resolve({ code: 0, output: '' });
      });
      docker.runTests.mockResolvedValue({ code: 1, output: 'npm failed' });

      await service.execute(leasedRun(), WORKER);

      expect(commit).not.toHaveBeenCalled();
      expect(lastSave()).toMatchObject({
        status: 'ERROR',
        error_code: 'RESULTS_MISSING',
      });
      expect(lastSave().error_message).toContain('npm failed');
      expect(JSON.stringify(lastSave())).toContain('NOT_FROM_THIS_RUN');
    });

    describe('Cypress', () => {
      const cypress = () =>
        leasedRun(
          {},
          {
            preset: 'cypress',
            result_paths: ['results/junit.xml'],
          },
        );

      it('records the results file of every spec', async () => {
        testsWrite({
          '.xisuite-results/cypress-a.xml': JUNIT,
          '.xisuite-results/cypress-b.xml': JUNIT,
        });

        await service.execute(cypress(), WORKER);

        expect(commit).toHaveBeenCalledTimes(2);
        expect(lastSave()).toMatchObject({ status: 'DONE' });
        expect(lastSave().result_summary).toMatchObject({
          import: {
            uploaded: [
              join('.xisuite-results', 'cypress-a.xml'),
              join('.xisuite-results', 'cypress-b.xml'),
            ],
          },
        });
      });

      it('does not take a results file that came with the code as this run’s', async () => {
        docker.cloneRepo.mockImplementation(
          (options: { runFolder: string }) => {
            const folder = join(options.runFolder, '.xisuite-results');

            mkdirSync(folder, { recursive: true });
            writeFileSync(join(folder, 'cypress-old.xml'), JUNIT);

            return Promise.resolve({ code: 0, output: '' });
          },
        );
        docker.runTests.mockResolvedValue({ code: 1, output: 'npm failed' });

        await service.execute(cypress(), WORKER);

        expect(commit).not.toHaveBeenCalled();
        expect(lastSave()).toMatchObject({
          status: 'ERROR',
          error_code: 'RESULTS_MISSING',
        });
        expect(JSON.stringify(lastSave())).toContain('NOT_FROM_THIS_RUN');
      });
    });

    it('keeps the value files outside every folder a container mounts', async () => {
      await service.execute(leasedRun(), WORKER);

      const envFolder = join(realpathSync(base), RUN, 'env');

      expect(testOptions().envFolder).toBe(envFolder);
      expect(docker.cloneRepo).toHaveBeenCalledWith(
        expect.objectContaining({ envFolder }),
      );
    });

    it('clones a git setting and does not touch storage', async () => {
      await service.execute(leasedRun(), WORKER);

      expect(docker.cloneRepo).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: RUN,
          repoUrl: 'https://git.example.com/a.git',
          repoRef: 'main',
          runFolder: join(realpathSync(base), RUN, 'project'),
        }),
      );
      expect(download).not.toHaveBeenCalled();
    });

    it('reports a failed clone with the end of its output', async () => {
      docker.cloneRepo.mockResolvedValue({
        code: 128,
        output: 'fatal: repository not found',
      });

      await service.execute(leasedRun(), WORKER);

      expect(lastSave()).toMatchObject({
        status: 'ERROR',
        error_code: 'CLONE_FAILED',
      });
      expect(lastSave().error_message).toContain('repository not found');
      expect(docker.runTests).not.toHaveBeenCalled();
    });

    const zipRun = () =>
      leasedRun(
        { run_zip_path: 'runs/a.zip' },
        { source: 'zip', repo_url: null, repo_ref: null },
      );

    it('unpacks the run’s own zip and removes that copy afterwards', async () => {
      await service.execute(zipRun(), WORKER);

      expect(docker.cloneRepo).not.toHaveBeenCalled();
      expect((unzip.mock.calls as unknown[][])[0][1]).toBe(
        join(realpathSync(base), RUN, 'project'),
      );
      expect(remove).toHaveBeenCalledWith(['runs/a.zip']);
    });

    describe('the reporter that names each test as it starts', () => {
      const reporterSeenByTests = () => {
        const seen: { text: string | null } = { text: null };

        docker.runTests.mockImplementation((options: RunTestsOptions) => {
          const path = join(options.runFolder, '.xisuite-progress.cjs');

          seen.text = existsSync(path) ? readFileSync(path, 'utf8') : null;

          return Promise.resolve({ code: 0, output: '' });
        });

        return seen;
      };

      it('is in the project before a Playwright run starts', async () => {
        const seen = reporterSeenByTests();

        await service.execute(leasedRun(), WORKER);

        expect(seen.text).toContain('onTestBegin');
      });

      it('never replaces a project file of the same name', async () => {
        const seen = reporterSeenByTests();

        docker.cloneRepo.mockImplementation(
          (options: { runFolder: string }) => {
            writeFileSync(
              join(options.runFolder, '.xisuite-progress.cjs'),
              'their own',
            );

            return Promise.resolve({ code: 0, output: '' });
          },
        );

        await service.execute(leasedRun(), WORKER);

        expect(seen.text).toBe('their own');
      });

      it('is not added for other frameworks', async () => {
        const seen = reporterSeenByTests();

        const images = process.env.TM_RUNNER_IMAGES;

        process.env.TM_RUNNER_IMAGES = JSON.stringify({
          'pytest-py3.12': IMAGE,
        });

        await service.execute(
          leasedRun({}, { preset: 'pytest', image_key: 'pytest-py3.12' }),
          WORKER,
        );

        process.env.TM_RUNNER_IMAGES = images;

        expect(docker.runTests).toHaveBeenCalled();
        expect(seen.text).toBeNull();
      });
    });

    it('reports a zip copy that is gone', async () => {
      download.mockResolvedValue({
        data: null,
        error: { message: 'not found' },
      });

      await service.execute(zipRun(), WORKER);

      expect(lastSave()).toMatchObject({ error_code: 'ZIP_MISSING' });
    });

    it('reports a run without a zip path', async () => {
      await service.execute(
        leasedRun({}, { source: 'zip', repo_url: null }),
        WORKER,
      );

      expect(lastSave()).toMatchObject({ error_code: 'ZIP_MISSING' });
    });

    it('reports a refused zip', async () => {
      unzip.mockRejectedValue(new UnzipError('UNSAFE_PATH'));

      await service.execute(zipRun(), WORKER);

      expect(lastSave()).toMatchObject({ error_code: 'ZIP_REJECTED' });
      expect(docker.runTests).not.toHaveBeenCalled();
    });
  });

  describe('a repository of the GitHub connection', () => {
    const TOKEN = 'ghs_connection_token';
    const REPO_URL = 'https://github.com/acme/tests';
    const findRepository = jest.fn();
    const tokenFor = jest.fn();

    const repository = (isPrivate = true) => ({
      id: 'repo-1',
      full_name: 'acme/tests',
      web_url: REPO_URL,
      is_private: isPrivate,
    });

    const connected = (isPrivate = true) => ({
      state: 'connected',
      repository: repository(isPrivate),
      installationId: '42',
    });

    const withConnection = () =>
      new RunnerService(
        {
          getClient: () => ({
            rpc,
            from: chain,
            storage: { from: () => ({ download, remove }) },
          }),
        } as unknown as SupabaseAdminService,
        { assertAvailable } as unknown as TestManagementAccessService,
        { hasSpacePermission } as unknown as PermissionsService,
        { commit, importResults } as unknown as CucumberResultsService,
        { upload } as unknown as AttachmentsService,
        docker as unknown as DockerDriver,
        {
          createImport,
          remove: removeExecution,
        } as unknown as TestExecutionsService,
        { addRuns } as unknown as TestRunsService,
        { testIds, add: addPlanTests } as unknown as TestPlanTestsService,
        { findRepository, tokenFor } as unknown as TestAutomationGitService,
      );

    const typedAddress = 'https://GitHub.com/Acme/Tests.git';

    const run = () =>
      withConnection().execute(
        leasedRun({}, { repo_url: typedAddress }),
        WORKER,
      );

    const cloneOptions = () =>
      (docker.cloneRepo.mock.calls as [Record<string, unknown>][])[0][0];

    beforeEach(() => {
      findRepository.mockReset();
      tokenFor.mockReset();
      findRepository.mockResolvedValue(connected());
      tokenFor.mockResolvedValue(TOKEN);
    });

    it('clones with the connection’s token, at the matched repository’s address', async () => {
      await run();

      expect(findRepository).toHaveBeenCalledWith(
        leasedRun().organization_id,
        typedAddress,
      );
      expect(cloneOptions()).toMatchObject({ token: TOKEN, repoUrl: REPO_URL });
    });

    it('never gives the token to the tests or saves it', async () => {
      docker.cloneRepo.mockResolvedValue({
        code: 0,
        output: `cloned with ${TOKEN}`,
      });

      await run();

      expect(JSON.stringify(testOptions())).not.toContain(TOKEN);
      expect(JSON.stringify(runUpdates)).not.toContain(TOKEN);
    });

    it('hides the token when a clone fails and prints it', async () => {
      docker.cloneRepo.mockResolvedValue({
        code: 128,
        output: `fatal: could not read from https://x:${TOKEN}@github.com`,
      });

      await run();

      expect(lastSave()).toMatchObject({
        status: 'ERROR',
        error_code: 'CLONE_FAILED',
      });
      expect(JSON.stringify(runUpdates)).not.toContain(TOKEN);
    });

    it('lets a setting’s own token win without asking the connection', async () => {
      tables.test_automation_configs = {
        data: {
          secrets_enc: packSecretForStorage(
            JSON.stringify({ GIT_TOKEN: 'own-token' }),
          ),
          archived_at: null,
        },
        error: null,
      };

      await run();

      expect(findRepository).not.toHaveBeenCalled();
      expect(tokenFor).not.toHaveBeenCalled();
      expect(cloneOptions()).toMatchObject({
        token: 'own-token',
        repoUrl: typedAddress,
      });
    });

    it('treats an empty stored token as no token, so the connection is used', async () => {
      tables.test_automation_configs = {
        data: {
          secrets_enc: packSecretForStorage(JSON.stringify({ GIT_TOKEN: '' })),
          archived_at: null,
        },
        error: null,
      };

      await run();

      expect(cloneOptions()).toMatchObject({ token: TOKEN, repoUrl: REPO_URL });
    });

    it('leaves an address the connection doesn’t know exactly as it was', async () => {
      findRepository.mockResolvedValue({ state: 'none' });

      await run();

      expect(tokenFor).not.toHaveBeenCalled();
      expect(cloneOptions().repoUrl).toBe(typedAddress);
      expect(cloneOptions()).not.toHaveProperty('token');
    });

    it('falls back to today’s clone when the repository can’t be read', async () => {
      findRepository.mockRejectedValue(new Error('database down'));

      await run();

      expect(cloneOptions().repoUrl).toBe(typedAddress);
      expect(cloneOptions()).not.toHaveProperty('token');
    });

    it('stops a private repository the connection no longer serves', async () => {
      findRepository.mockResolvedValue({
        state: 'unavailable',
        repository: repository(),
      });

      await run();

      expect(docker.cloneRepo).not.toHaveBeenCalled();
      expect(lastSave()).toMatchObject({
        status: 'ERROR',
        error_code: 'GIT_CONNECTION_UNAVAILABLE',
      });
    });

    it('still clones a public repository the connection no longer serves', async () => {
      findRepository.mockResolvedValue({
        state: 'unavailable',
        repository: repository(false),
      });

      await run();

      expect(cloneOptions().repoUrl).toBe(typedAddress);
      expect(cloneOptions()).not.toHaveProperty('token');
    });

    it('stops a private repository when GitHub refuses a token', async () => {
      tokenFor.mockRejectedValue(new Error('GitHub answered 401'));

      await run();

      expect(docker.cloneRepo).not.toHaveBeenCalled();
      expect(lastSave()).toMatchObject({
        status: 'ERROR',
        error_code: 'GIT_TOKEN_FAILED',
      });
    });

    it('still clones a public repository when GitHub refuses a token', async () => {
      findRepository.mockResolvedValue(connected(false));
      tokenFor.mockRejectedValue(new Error('GitHub answered 503'));

      await run();

      expect(cloneOptions()).not.toHaveProperty('token');
      expect(lastSave().error_code).not.toBe('GIT_TOKEN_FAILED');
    });

    it('never asks the connection for a zip setting', async () => {
      await withConnection().execute(
        leasedRun(
          { run_zip_path: 'runs/a.zip' },
          { source: 'zip', repo_url: null, repo_ref: null },
        ),
        WORKER,
      );

      expect(findRepository).not.toHaveBeenCalled();
      expect(docker.cloneRepo).not.toHaveBeenCalled();
    });
  });

  describe('secrets and variables', () => {
    const withSecrets = (secrets: Record<string, string>) => {
      tables.test_automation_configs = {
        data: {
          secrets_enc: packSecretForStorage(JSON.stringify(secrets)),
          archived_at: null,
        },
        error: null,
      };
    };

    it('gives the tests the setting’s variables and secrets', async () => {
      withSecrets({ API_TOKEN: 'secret-value' });

      await service.execute(leasedRun(), WORKER);

      expect(testOptions().env).toMatchObject({
        BASE_URL: 'https://app.example.com',
        API_TOKEN: 'secret-value',
        XISUITE_RESULT: 'results.xml',
        PLAYWRIGHT_JUNIT_OUTPUT_NAME: 'results.xml',
      });
    });

    it('uses GIT_TOKEN for the clone and never gives it to the tests', async () => {
      withSecrets({ GIT_TOKEN: 'git-secret', API_TOKEN: 'secret-value' });

      await service.execute(leasedRun(), WORKER);

      expect(docker.cloneRepo).toHaveBeenCalledWith(
        expect.objectContaining({ token: 'git-secret' }),
      );
      expect(testOptions().env).not.toHaveProperty('GIT_TOKEN');
      expect(JSON.stringify(testOptions())).not.toContain('git-secret');
    });

    it('clones a public repository without a token', async () => {
      await service.execute(leasedRun(), WORKER);

      expect(docker.cloneRepo).toHaveBeenCalledWith(
        expect.not.objectContaining({ token: expect.anything() as string }),
      );
    });

    it('never lets a setting replace what the runner sets', async () => {
      await service.execute(
        leasedRun({}, { env: { XISUITE_RESULT: 'other.xml' } }),
        WORKER,
      );

      expect(testOptions().env.XISUITE_RESULT).toBe('results.xml');
    });

    describe('in result files', () => {
      const uploadedText = (call = 0) =>
        (commit.mock.calls as unknown[][])[call][3] as Express.Multer.File;

      const failing = (message: string) =>
        `<testsuite><testcase name="a"><failure message="${message}"/></testcase></testsuite>`;

      it('hides a secret a test printed in a failure message', async () => {
        withSecrets({ API_TOKEN: 'secret-value' });
        testsWrite({ 'results.xml': failing('token secret-value') });

        await service.execute(leasedRun(), WORKER);

        const stored = uploadedText();

        expect(stored.buffer.toString()).not.toContain('secret-value');
        expect(stored.buffer.toString()).toContain('token ***');
        expect(stored.size).toBe(stored.buffer.length);
      });

      it('hides the git token too', async () => {
        withSecrets({ GIT_TOKEN: 'git-secret' });
        testsWrite({ 'results.xml': failing('cloned with git-secret') });

        await service.execute(leasedRun(), WORKER);

        expect(uploadedText().buffer.toString()).not.toContain('git-secret');
      });

      it('keeps the exact bytes of a file with no secret in it', async () => {
        withSecrets({ API_TOKEN: 'secret-value' });
        testsWrite({ 'results.xml': failing('plain failure') });

        await service.execute(leasedRun(), WORKER);

        expect(uploadedText().buffer.toString()).toBe(
          `${failing('plain failure')}\n<!-- xisuite-automation-run ${RUN}/1 -->\n`,
        );
      });

      it('stores nothing when a secret collides with the XML itself', async () => {
        withSecrets({ API_TOKEN: 'testcase' });
        testsWrite({
          'a.xml': failing('plain failure'),
          'b.xml': failing('plain failure'),
        });

        await service.execute(
          leasedRun({}, { result_paths: ['*.xml'] }),
          WORKER,
        );

        const save = lastSave();

        expect(commit).not.toHaveBeenCalled();
        expect(save).toMatchObject({
          status: 'ERROR',
          error_code: 'RESULT_NOT_MASKABLE',
        });
        expect(JSON.stringify(save)).not.toContain('"testcase"');
      });
    });

    it('hides secrets, including the git token, in the saved log', async () => {
      withSecrets({ GIT_TOKEN: 'git-secret', API_TOKEN: 'secret-value' });
      docker.cloneRepo.mockResolvedValue({
        code: 0,
        output: 'cloned with git-secret',
      });
      testsWrite(undefined, { code: 0, output: 'token secret-value used' });

      await service.execute(leasedRun(), WORKER);

      const log = firstUpload().file.buffer.toString();

      expect(log).toContain('cloned with ***');
      expect(log).toContain('token *** used');
    });

    it('hides secrets in the error text too', async () => {
      withSecrets({ GIT_TOKEN: 'git-secret' });
      docker.cloneRepo.mockResolvedValue({
        code: 128,
        output: 'could not use git-secret',
      });

      await service.execute(leasedRun(), WORKER);

      expect(lastSave().error_message).toContain('could not use ***');
      expect(lastSave().error_message).not.toContain('git-secret');
    });

    it('keeps secrets out of the summary', async () => {
      withSecrets({ API_TOKEN: 'secret-value' });

      await service.execute(leasedRun(), WORKER);

      expect(JSON.stringify(lastSave())).not.toContain('secret-value');
    });

    it('gives Maven the proxy as JVM options, after the setting’s own', async () => {
      await service.execute(
        leasedRun(
          {},
          {
            preset: 'maven',
            env: { MAVEN_OPTS: '-Xmx1g' },
            result_paths: ['results.xml'],
          },
        ),
        WORKER,
      );

      const options = testOptions().env.MAVEN_OPTS;

      expect(options.startsWith('-Xmx1g ')).toBe(true);
      expect(options).toContain(`-Dhttps.proxyHost=xis-tm-run-${RUN}-proxy`);
      expect(options).toContain('-Dhttps.proxyPort=8888');
    });

    it('adds no JVM options to other presets', async () => {
      await service.execute(leasedRun(), WORKER);

      expect(testOptions().env).not.toHaveProperty('MAVEN_OPTS');
    });
  });

  describe('results', () => {
    it('reports tests that wrote no results, with the end of their output', async () => {
      docker.runTests.mockResolvedValue({ code: 2, output: 'npm failed' });

      await service.execute(leasedRun(), WORKER);

      expect(lastSave()).toMatchObject({
        status: 'ERROR',
        error_code: 'RESULTS_MISSING',
        exit_code: 2,
      });
      expect(lastSave().error_message).toContain('npm failed');
      expect(commit).not.toHaveBeenCalled();
    });

    it('keeps the very end of a long output in the error text', async () => {
      const lines = Array.from(
        { length: 150 },
        (_, index) => `line ${index} ${'x'.repeat(40)}`,
      );

      docker.runTests.mockResolvedValue({
        code: 1,
        output: [...lines, 'the real failure'].join('\n'),
      });

      await service.execute(leasedRun(), WORKER);

      const message = lastSave().error_message as string;

      expect(message.length).toBeLessThanOrEqual(2000);
      expect(message.startsWith('The tests finished')).toBe(true);
      expect(message.endsWith('the real failure')).toBe(true);
    });

    it('never leaves part of a secret where the error text was cut', async () => {
      const secret = 'abcdefghijklmnop';

      tables.test_automation_configs = {
        data: {
          secrets_enc: packSecretForStorage(
            JSON.stringify({ API_TOKEN: secret }),
          ),
          archived_at: null,
        },
        error: null,
      };
      // The secret sits across the point where the text gets cut.
      docker.runTests.mockResolvedValue({
        code: 1,
        output: `${secret}${'y'.repeat(1950)}`,
      });

      await service.execute(leasedRun(), WORKER);

      const message = lastSave().error_message as string;

      for (let cut = 4; cut <= secret.length; cut += 1) {
        expect(message).not.toContain(secret.slice(-cut));
      }
    });

    it('reports a test container that could not start', async () => {
      docker.runTests.mockResolvedValue({ code: 125, output: 'no such image' });

      await service.execute(leasedRun(), WORKER);

      expect(lastSave()).toMatchObject({ error_code: 'START_FAILED' });
    });

    it('passes on the import’s reason when nothing could be recorded', async () => {
      commit.mockRejectedValue(
        new HttpException(
          { code: 'NOTHING_TO_APPLY', message: 'Nothing to record' },
          400,
        ),
      );

      await service.execute(leasedRun(), WORKER);

      expect(lastSave()).toMatchObject({
        status: 'ERROR',
        error_code: 'NOTHING_TO_APPLY',
      });
    });

    it('counts its own file already recorded as a success', async () => {
      commit.mockRejectedValue(
        new HttpException(
          { code: 'IMPORT_ALREADY_APPLIED', message: 'Already' },
          409,
        ),
      );

      await service.execute(leasedRun(), WORKER);

      expect(lastSave()).toMatchObject({ status: 'DONE', outcome: 'passed' });
    });

    describe('a file with nothing to apply', () => {
      const nothing = () =>
        new HttpException(
          { code: 'NOTHING_TO_APPLY', message: 'Nothing to record' },
          400,
        );
      const twoFiles = { result_paths: ['r/*.xml'] };

      beforeEach(() => {
        testsWrite({ 'r/a.xml': JUNIT, 'r/b.xml': JUNIT });
      });

      it('does not stop the next file', async () => {
        commit
          .mockRejectedValueOnce(nothing())
          .mockResolvedValueOnce({ applied: [{}], created_cases: [] });

        await service.execute(leasedRun({}, twoFiles), WORKER);

        expect(commit).toHaveBeenCalledTimes(2);
        expect(lastSave()).toMatchObject({ status: 'DONE', outcome: 'passed' });
        expect(lastSave().result_summary).toMatchObject({
          import: {
            uploaded: [join('r', 'b.xml')],
            nothing_to_apply: [join('r', 'a.xml')],
            applied: 1,
          },
        });
      });

      it('fails the run when every file has nothing, keeping the chosen execution', async () => {
        commit.mockRejectedValue(nothing());

        await service.execute(leasedRun({}, twoFiles), WORKER);

        expect(commit).toHaveBeenCalledTimes(2);
        expect(lastSave()).toMatchObject({
          status: 'ERROR',
          error_code: 'NOTHING_TO_APPLY',
        });
        expect(removeExecution).not.toHaveBeenCalled();
      });

      const planTwoFiles = () =>
        leasedRun(
          { target: 'plan', plan_id: 'plan-1', execution_id: null },
          twoFiles,
        );

      it('removes the execution made for a plan run, and attaches no log to it', async () => {
        commit.mockRejectedValue(nothing());

        await service.execute(planTwoFiles(), WORKER);

        expect(removeExecution).toHaveBeenCalledWith(
          expect.anything(),
          SPACE,
          'execution-new',
          false,
        );
        expect(upload).not.toHaveBeenCalled();
        expect(lastSave()).toMatchObject({ error_code: 'NOTHING_TO_APPLY' });
      });

      it('still reports the failure when that execution cannot be removed', async () => {
        commit.mockRejectedValue(nothing());
        removeExecution.mockRejectedValue(new Error('has results'));

        await service.execute(planTwoFiles(), WORKER);

        expect(lastSave()).toMatchObject({ error_code: 'NOTHING_TO_APPLY' });
      });

      it('keeps a plan run’s execution when another file recorded results', async () => {
        commit
          .mockRejectedValueOnce(nothing())
          .mockResolvedValueOnce({ applied: [{}], created_cases: [] });

        await service.execute(planTwoFiles(), WORKER);

        expect(removeExecution).not.toHaveBeenCalled();
        expect(lastSave()).toMatchObject({ status: 'DONE' });
      });
    });

    describe('a run of only skipped tests', () => {
      const SKIPPED =
        '<testsuite><testcase name="a"><skipped/></testcase>' +
        '<testcase name="b"><skipped/></testcase></testsuite>';
      const nothing = () =>
        new HttpException(
          { code: 'NOTHING_TO_APPLY', message: 'Nothing to record' },
          400,
        );
      const twoFiles = { result_paths: ['r/*.xml'] };

      beforeEach(() => {
        commit.mockRejectedValue(nothing());
      });

      it('ends as passed with a warning', async () => {
        testsWrite({ 'results.xml': SKIPPED });

        await service.execute(leasedRun(), WORKER);

        expect(lastSave()).toMatchObject({
          status: 'DONE',
          outcome: 'passed',
          error_code: null,
          error_message: null,
          exit_code: 0,
        });
        expect(lastSave().result_summary).toMatchObject({
          counts: { total: 2, passed: 0, failed: 0, skipped: 2 },
          warnings: ['ALL_SKIPPED'],
          import: { uploaded: [], nothing_to_apply: ['results.xml'] },
        });
      });

      it('ends as passed when every file holds only skipped tests', async () => {
        testsWrite({ 'r/a.xml': SKIPPED, 'r/b.xml': SKIPPED });

        await service.execute(leasedRun({}, twoFiles), WORKER);

        expect(commit).toHaveBeenCalledTimes(2);
        expect(lastSave()).toMatchObject({ status: 'DONE', outcome: 'passed' });
        expect(lastSave().result_summary).toMatchObject({
          counts: { total: 4, skipped: 4 },
          warnings: ['ALL_SKIPPED'],
          import: {
            nothing_to_apply: [join('r', 'a.xml'), join('r', 'b.xml')],
          },
        });
      });

      it('removes the empty execution made for a plan run', async () => {
        testsWrite({ 'results.xml': SKIPPED });

        await service.execute(
          leasedRun({ target: 'plan', plan_id: 'plan-1', execution_id: null }),
          WORKER,
        );

        expect(removeExecution).toHaveBeenCalledWith(
          expect.anything(),
          SPACE,
          'execution-new',
          false,
        );
        expect(lastSave()).toMatchObject({ status: 'DONE', outcome: 'passed' });
      });

      it('still fails when a passed test could not be recorded', async () => {
        testsWrite({ 'r/a.xml': SKIPPED, 'r/b.xml': JUNIT });

        await service.execute(leasedRun({}, twoFiles), WORKER);

        expect(lastSave()).toMatchObject({
          status: 'ERROR',
          error_code: 'NOTHING_TO_APPLY',
        });
        expect(
          (lastSave().result_summary as { warnings?: string[] }).warnings,
        ).toBeUndefined();
      });

      it('still fails when the file holds no tests', async () => {
        testsWrite({ 'results.xml': '<testsuite></testsuite>' });

        await service.execute(leasedRun(), WORKER);

        expect(lastSave()).toMatchObject({
          status: 'ERROR',
          error_code: 'NOTHING_TO_APPLY',
        });
      });

      it('still fails when the tests exited with an error', async () => {
        testsWrite({ 'results.xml': SKIPPED }, { code: 1, output: 'failed' });

        await service.execute(leasedRun(), WORKER);

        expect(lastSave()).toMatchObject({
          status: 'ERROR',
          error_code: 'NOTHING_TO_APPLY',
          exit_code: 1,
        });
      });
    });

    it('says what was recorded when a later file fails', async () => {
      testsWrite({ 'r/a.xml': JUNIT, 'r/b.xml': JUNIT });
      commit
        .mockResolvedValueOnce({ applied: [{}], created_cases: [] })
        .mockRejectedValueOnce(
          new HttpException({ code: 'BAD_FILE', message: 'Bad file' }, 400),
        );

      await service.execute(
        leasedRun({}, { result_paths: ['r/*.xml'] }),
        WORKER,
      );

      expect(lastSave()).toMatchObject({
        status: 'ERROR',
        error_code: 'PARTIAL_UPLOAD',
      });
      expect(lastSave().result_summary).toMatchObject({
        import: { uploaded: ['r/a.xml'], applied: 1 },
      });
    });

    it('treats a refused import as lost rights', async () => {
      commit.mockRejectedValue(new ForbiddenException('no'));

      await service.execute(leasedRun(), WORKER);

      expect(lastSave()).toMatchObject({
        status: 'CANCELLED',
        error_code: 'PERMISSION_LOST',
      });
    });

    it('treats a missing execution during the import as gone', async () => {
      commit.mockRejectedValue(new NotFoundException('gone'));

      await service.execute(leasedRun(), WORKER);

      expect(lastSave()).toMatchObject({ error_code: 'EXECUTION_GONE' });
    });

    it('never builds an error code the database would refuse', async () => {
      commit.mockRejectedValue(new Error('boom'));

      await service.execute(leasedRun(), WORKER);

      expect(lastSave().error_code).toBe('IMPORT_FAILED');
    });
  });

  describe('log and trace', () => {
    it('attaches the log to the execution under the run’s name', async () => {
      await service.execute(leasedRun(), WORKER);

      expect(firstUpload()).toMatchObject({
        entityType: 'test_execution',
        entityId: 'execution-1',
      });
      expect(firstUpload().file.originalname).toBe(`automation-${RUN}-log.txt`);
    });

    it('still ends the run when the log cannot be attached', async () => {
      upload.mockRejectedValue(new Error('storage down'));

      await service.execute(leasedRun(), WORKER);

      expect(lastSave()).toMatchObject({ status: 'DONE', outcome: 'passed' });
      expect(lastSave().result_summary).toMatchObject({
        warnings: ['LOG_NOT_SAVED'],
      });
    });

    it('attaches no log when the run stopped before producing any', async () => {
      assertAvailable.mockRejectedValue(new ForbiddenException());

      await service.execute(leasedRun(), WORKER);

      expect(upload).not.toHaveBeenCalled();
    });

    const traced = () => leasedRun({}, { trace_mode: 'on_failure' });

    it('asks for a trace only when the setting wants one', async () => {
      await service.execute(traced(), WORKER);
      expect(testOptions().command).toContain('--trace retain-on-failure');

      docker.runTests.mockClear();
      await service.execute(leasedRun(), WORKER);
      expect(testOptions().command).not.toContain('--trace');
    });

    it('attaches a trace when tests failed', async () => {
      testsWrite(
        { 'results.xml': JUNIT, 'test-results/a/trace.zip': 'trace' },
        { code: 1, output: 'failed' },
      );

      await service.execute(traced(), WORKER);

      const names = (
        upload.mock.calls as { file: Express.Multer.File }[][]
      ).map(([call]) => call.file.originalname);

      expect(names).toContain(`automation-${RUN}-trace.zip`);
    });

    it('attaches no trace when tests passed', async () => {
      testsWrite({ 'results.xml': JUNIT, 'test-results/a/trace.zip': 'trace' });

      await service.execute(traced(), WORKER);

      expect(upload).toHaveBeenCalledTimes(1);
    });

    it('does not fail the run when no trace was written', async () => {
      testsWrite(undefined, { code: 1, output: 'failed' });

      await service.execute(traced(), WORKER);

      expect(lastSave()).toMatchObject({ outcome: 'failed_tests' });
    });
  });

  describe('progress while a run goes', () => {
    const stages = () =>
      runUpdates
        .map(
          (patch) =>
            (patch.result_summary as { stage?: string } | undefined)?.stage,
        )
        .filter(Boolean);

    it('keeps what the API saved on the run', async () => {
      await service.execute(
        leasedRun({ result_summary: { spec_files: ['a.spec.ts'] } }),
        WORKER,
      );

      expect(runUpdates[0].result_summary).toMatchObject({
        spec_files: ['a.spec.ts'],
      });
      expect(lastSave().result_summary).toMatchObject({
        spec_files: ['a.spec.ts'],
      });
    });

    it('goes through the stages, and the final save drops the stage', async () => {
      await service.execute(leasedRun(), WORKER);

      expect(stages()).toEqual([
        'preparing',
        'installing',
        'saving',
        'cleaning_up',
      ]);
      expect(lastSave().result_summary).not.toHaveProperty('stage');
    });

    it('treats an overridden install as an install step', async () => {
      await service.execute(
        leasedRun({}, { preset: 'maven', install_command: 'make deps' }),
        WORKER,
      );

      expect(stages()).toEqual([
        'preparing',
        'installing',
        'saving',
        'cleaning_up',
      ]);
    });

    it('goes straight to running without an install step', async () => {
      await service.execute(leasedRun({}, { preset: 'maven' }), WORKER);

      expect(stages()).toEqual([
        'preparing',
        'running',
        'saving',
        'cleaning_up',
      ]);
      expect(testOptions().command).not.toContain('XISUITE_TESTS_START');
    });

    it('prints a marker between the install and the tests', async () => {
      await service.execute(leasedRun(), WORKER);

      expect(testOptions().command).toContain(
        "&& printf '%s\\n' XISUITE_TESTS_START && npx playwright test",
      );
    });

    it('moves to running at the marker, and shows the marker nowhere', async () => {
      docker.runTests.mockImplementation((options: RunTestsOptions) => {
        options.onOutput?.(Buffer.from('installed\nXISUITE_'));
        options.onOutput?.(Buffer.from('TESTS_START\nRunning 5 tests\n'));

        return Promise.resolve({
          code: 1,
          output: 'installed\nXISUITE_TESTS_START\nRunning 5 tests\n',
        });
      });

      await service.execute(leasedRun(), WORKER);

      expect(stages()).toEqual(
        expect.arrayContaining(['installing', 'running']),
      );
      expect(stages().indexOf('installing')).toBeLessThan(
        stages().indexOf('running'),
      );

      const everything = JSON.stringify(runUpdates);

      expect(everything).not.toContain('XISUITE_TESTS_START');
      expect(everything).toContain('Running 5 tests');
      expect(firstUpload().file.buffer.toString('utf8')).not.toContain(
        'XISUITE_TESTS_START',
      );
    });

    it('stays in the install stage when the install fails', async () => {
      docker.runTests.mockImplementation((options: RunTestsOptions) => {
        options.onOutput?.(Buffer.from('npm ERR! 404\n'));

        return Promise.resolve({ code: 1, output: 'npm ERR! 404\n' });
      });

      await service.execute(leasedRun(), WORKER);

      expect(stages()).not.toContain('running');
      expect(lastSave()).toMatchObject({ error_code: 'RESULTS_MISSING' });
    });

    it('keeps the live text on the writes after it', async () => {
      docker.runTests.mockImplementation((options: RunTestsOptions) => {
        options.onOutput?.(Buffer.from('some output\n'));

        return Promise.resolve({ code: 1, output: 'some output\n' });
      });

      await service.execute(leasedRun(), WORKER);

      const write = runUpdates.find(
        (patch) =>
          (patch.result_summary as { stage?: string } | undefined)?.stage ===
          'cleaning_up',
      );

      expect(write?.result_summary).toMatchObject({
        live_log: 'some output\n',
      });
      expect(lastSave().result_summary).not.toHaveProperty('live_log');
    });

    it('does not stop a run when a stage cannot be saved', async () => {
      runAnswers.push({ data: null, error: { message: 'blip' } });

      await service.execute(leasedRun(), WORKER);

      expect(lastSave()).toMatchObject({ status: 'DONE' });
    });

    it('only writes to a run this worker still holds', async () => {
      await service.execute(leasedRun(), WORKER);

      expect(runChains[0].eq).toHaveBeenCalledWith('worker_id', WORKER);
      expect(runChains[0].in).toHaveBeenCalledWith('status', [
        'RUNNING',
        'UPLOADING',
      ]);
    });
  });

  describe('counting the tests', () => {
    const summary = () =>
      lastSave().result_summary as {
        counts: Record<string, number>;
        tests: { name: string; status: string }[];
      };

    it('saves the counts and each test', async () => {
      testsWrite({
        'results.xml':
          '<testsuite><testcase name="ok"/><testcase name="bad"><failure/></testcase>' +
          '<testcase name="later"><skipped/></testcase></testsuite>',
      });

      await service.execute(leasedRun(), WORKER);

      expect(summary().counts).toEqual({
        total: 3,
        passed: 1,
        failed: 1,
        skipped: 1,
      });
      expect(summary().tests).toEqual(
        expect.arrayContaining([
          { name: 'ok', status: 'passed' },
          { name: 'bad', status: 'failed' },
          { name: 'later', status: 'skipped' },
        ]),
      );
    });

    it('reads the masked file, so a secret never reaches the list', async () => {
      tables.test_automation_configs = {
        data: {
          secrets_enc: packSecretForStorage(
            JSON.stringify({ API_TOKEN: 'secret-value' }),
          ),
          archived_at: null,
        },
        error: null,
      };
      testsWrite({
        'results.xml':
          '<testsuite><testcase name="login with secret-value"/></testsuite>',
      });

      await service.execute(leasedRun(), WORKER);

      expect(JSON.stringify(summary())).not.toContain('secret-value');
      expect(summary().tests[0].name).toBe('login with ***');
    });

    it('lists at most 500 tests, with short names, but counts them all', async () => {
      const cases = Array.from(
        { length: 600 },
        (_, index) => `<testcase name="t${index}${'x'.repeat(300)}"/>`,
      );

      testsWrite({
        'results.xml': `<testsuite>${cases.join('')}</testsuite>`,
      });

      await service.execute(leasedRun(), WORKER);

      expect(summary().counts.total).toBe(600);
      expect(summary().tests).toHaveLength(500);
      expect(summary().tests[0].name.length).toBeLessThanOrEqual(200);
    });

    it('never cuts a name inside a character', async () => {
      testsWrite({
        'results.xml': `<testsuite><testcase name="${'😀'.repeat(150)}"/></testsuite>`,
      });

      await service.execute(leasedRun(), WORKER);

      expect(Array.from(summary().tests[0].name)).toHaveLength(150);
      expect(summary().tests[0].name).not.toMatch(/\p{Cs}/u);
    });

    it('strips control characters from names', async () => {
      testsWrite({
        'results.xml': '<testsuite><testcase name="a&#9;b"/></testsuite>',
      });

      await service.execute(leasedRun(), WORKER);

      expect(summary().tests[0].name).toBe('ab');
    });

    it('does not stop a run over a file it cannot read', async () => {
      testsWrite({ 'results.xml': 'not xml at all' });

      await service.execute(leasedRun(), WORKER);

      expect(lastSave()).toMatchObject({ status: 'DONE' });
      expect(summary().counts.total).toBe(0);
    });
  });

  describe('keeping the log without a file', () => {
    const summary = () =>
      lastSave().result_summary as { saved_log?: string; warnings?: string[] };

    beforeEach(() => {
      docker.runTests.mockResolvedValue({ code: 1, output: 'crash output' });
    });

    it('keeps it for a plan run with no execution', async () => {
      await service.execute(
        leasedRun({
          target: 'plan',
          plan_id: 'plan-1',
          execution_id: null,
        }),
        WORKER,
      );

      expect(upload).not.toHaveBeenCalled();
      expect(summary().saved_log).toContain('crash output');
    });

    it('keeps it when the file could not be attached', async () => {
      upload.mockRejectedValue(new ForbiddenException('rights lost'));

      await service.execute(leasedRun(), WORKER);

      expect(summary().saved_log).toContain('crash output');
      expect(summary().warnings).toContain('LOG_NOT_SAVED');
    });

    it('keeps nothing extra when the file was attached', async () => {
      await service.execute(leasedRun(), WORKER);

      expect(summary().saved_log).toBeUndefined();
    });

    it('hides secrets and keeps only the end', async () => {
      tables.test_automation_configs = {
        data: {
          secrets_enc: packSecretForStorage(
            JSON.stringify({ API_TOKEN: 'secret-value' }),
          ),
          archived_at: null,
        },
        error: null,
      };
      upload.mockRejectedValue(new Error('storage down'));
      docker.runTests.mockResolvedValue({
        code: 1,
        output: `${'early line\n'.repeat(20_000)}token secret-value\n`,
      });

      await service.execute(leasedRun(), WORKER);

      const saved = summary().saved_log as string;

      expect(saved).not.toContain('secret-value');
      expect(saved).toContain('token ***');
      expect(Buffer.byteLength(saved)).toBeLessThanOrEqual(64 * 1024);
    });
  });

  describe('docker problems', () => {
    const savedEnabled = process.env.TM_RUNNER_ENABLED;

    afterEach(() => {
      if (savedEnabled === undefined) delete process.env.TM_RUNNER_ENABLED;
      else process.env.TM_RUNNER_ENABLED = savedEnabled;
    });

    it('says a built-in image is missing', async () => {
      process.env.TM_RUNNER_ENABLED = '1';
      docker.runTests.mockResolvedValue({
        code: 125,
        output: "Unable to find image 'xis-tm-runner-node:latest' locally",
      });

      await service.execute(
        leasedRun({}, { preset: 'jest', image_key: 'node-24' }),
        WORKER,
      );

      expect(lastSave()).toMatchObject({ error_code: 'IMAGE_MISSING' });
    });

    it('keeps the plain start failure for an image from a registry', async () => {
      docker.runTests.mockResolvedValue({
        code: 125,
        output: "Unable to find image 'x' locally",
      });

      await service.execute(leasedRun(), WORKER);

      expect(lastSave()).toMatchObject({ error_code: 'START_FAILED' });
    });

    it('says the proxy image is missing', async () => {
      docker.startProxy.mockRejectedValue(
        new DockerCommandError(
          'start the proxy',
          "Unable to find image 'xis-tm-runner-proxy:latest' locally",
        ),
      );

      await service.execute(leasedRun(), WORKER);

      expect(lastSave()).toMatchObject({ error_code: 'IMAGE_MISSING' });
    });

    it('names the proxy image when that is the one missing', async () => {
      docker.startProxy.mockRejectedValue(
        new DockerCommandError(
          'start the proxy',
          'No such image: xis-tm-runner-proxy:latest',
        ),
      );

      await service.execute(leasedRun(), WORKER);

      expect(lastSave()).toMatchObject({ error_code: 'IMAGE_MISSING' });
      expect(lastSave().error_message).toMatch(
        /^The network proxy image is not built on the runner machine/,
      );
    });

    it('keeps the test image text for a missing test image', async () => {
      process.env.TM_RUNNER_ENABLED = '1';
      docker.runTests.mockResolvedValue({
        code: 125,
        output: "Unable to find image 'xis-tm-runner-node:latest' locally",
      });

      await service.execute(
        leasedRun({}, { preset: 'jest', image_key: 'node-24' }),
        WORKER,
      );

      expect(lastSave().error_message).toMatch(
        /^A test image is not built on the runner machine/,
      );
    });

    it('ends START_FAILED when the network does not answer in time', async () => {
      docker.createNetwork.mockRejectedValue(
        new DockerCommandError(
          'create the run network',
          'Docker did not answer within 30 s',
        ),
      );

      await service.execute(leasedRun(), WORKER);

      expect(lastSave()).toMatchObject({
        status: 'ERROR',
        error_code: 'START_FAILED',
      });
      expect(lastSave().error_message).toContain(
        'Docker did not answer within 30 s',
      );
    });

    it('hides the machine’s folder in error text', async () => {
      const folder = join(realpathSync(base), RUN);

      docker.startProxy.mockRejectedValue(
        new DockerCommandError(
          'start the proxy',
          `invalid mount ${folder}/proxy`,
        ),
      );

      await service.execute(leasedRun(), WORKER);

      expect(JSON.stringify(lastSave())).not.toContain(folder);
      expect(lastSave().error_message).toContain('invalid mount ***/proxy');
    });
  });

  describe('cleaning up', () => {
    it('cleans up before the final save, and records that it worked', async () => {
      let savedBefore = true;

      docker.remove.mockImplementation(() => {
        savedBefore = runUpdates.some((patch) => 'finished_at' in patch);

        return Promise.resolve();
      });

      await service.execute(leasedRun(), WORKER);

      expect(savedBefore).toBe(false);
      expect(lastSave().result_summary).toMatchObject({ cleanup: 'removed' });
    });

    it('says so when something could not be removed', async () => {
      docker.remove.mockRejectedValue(new Error('docker gone'));

      await service.execute(leasedRun(), WORKER);

      expect(lastSave()).toMatchObject({ status: 'DONE' });
      expect(lastSave().result_summary).toMatchObject({ cleanup: 'failed' });
    });

    it('removes containers and the run folder after a good run', async () => {
      let during = false;

      docker.runTests.mockImplementation((options: RunTestsOptions) => {
        writeFileSync(join(options.runFolder, 'results.xml'), JUNIT);
        during = existsSync(runFolder());

        return Promise.resolve({ code: 0, output: '' });
      });

      await service.execute(leasedRun(), WORKER);

      expect(during).toBe(true);
      expect(docker.remove).toHaveBeenCalledWith(RUN);
      expect(existsSync(runFolder())).toBe(false);
    });

    it('cleans up after a failed run too', async () => {
      docker.runTests.mockRejectedValue(new Error('docker gone'));

      await service.execute(
        leasedRun(
          { run_zip_path: 'runs/a.zip' },
          { source: 'zip', repo_url: null },
        ),
        WORKER,
      );

      expect(lastSave()).toMatchObject({ error_code: 'RUNNER_FAILED' });
      expect(docker.remove).toHaveBeenCalledWith(RUN);
      expect(existsSync(runFolder())).toBe(false);
      expect(remove).toHaveBeenCalledWith(['runs/a.zip']);
    });

    it('finishes the other steps when removing containers fails', async () => {
      docker.remove.mockRejectedValue(new Error('docker gone'));

      await expect(
        service.execute(leasedRun(), WORKER),
      ).resolves.toBeUndefined();
      expect(existsSync(runFolder())).toBe(false);
    });

    it('never shows an unexpected problem’s text to the user', async () => {
      docker.runTests.mockRejectedValue(new Error('internal path /secret'));

      await service.execute(leasedRun(), WORKER);

      expect(lastSave().error_message).not.toContain('/secret');
    });

    it('only updates a run this worker still holds', async () => {
      await service.execute(leasedRun(), WORKER);

      const index = runUpdates.findIndex((patch) => 'finished_at' in patch);
      const write = runChains[index];

      expect(write.eq).toHaveBeenCalledWith('id', RUN);
      expect(write.eq).toHaveBeenCalledWith('worker_id', WORKER);
      expect(write.in).toHaveBeenCalledWith('status', ['RUNNING', 'UPLOADING']);
    });
  });

  describe('while it runs', () => {
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    /** Lets a run reach its test step, with the clock under the spec's control. */
    const reachTests = async () => {
      jest.useFakeTimers({
        doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
      });

      let finishTests: (result: DockerResult) => void = () => undefined;

      docker.runTests.mockImplementation(
        (options: RunTestsOptions) =>
          new Promise<DockerResult>((resolve) => {
            finishTests = (result) => {
              // A killed run can already have written its results.
              writeFileSync(join(options.runFolder, 'results.xml'), JUNIT);
              resolve(result);
            };
          }),
      );

      const running = service.execute(leasedRun(), WORKER);

      while (docker.runTests.mock.calls.length === 0) await settle();

      return { running, finish: (r: DockerResult) => finishTests(r) };
    };

    const heartbeat = async () => {
      jest.advanceTimersByTime(HEARTBEAT_MS);
      await settle();
    };

    it('renews the lease on every heartbeat', async () => {
      const { running, finish } = await reachTests();

      await heartbeat();

      const beat = runUpdates.find((patch) => 'lease_until' in patch);

      expect(beat).toHaveProperty('lease_until');
      expect(beat).toHaveProperty('heartbeat_at');

      finish({ code: 1, output: '' });
      await running;
    });

    it('stops the containers when someone cancels', async () => {
      const { running, finish } = await reachTests();

      runAnswers.push({
        data: {
          status: 'RUNNING',
          cancel_requested_at: '2026-11-02T00:00:00Z',
        },
        error: null,
      });
      await heartbeat();

      expect(docker.stop).toHaveBeenCalledWith(RUN);

      finish({ code: 137, output: 'killed' });
      await running;

      expect(lastSave()).toMatchObject({
        status: 'CANCELLED',
        error_code: null,
      });
      expect(commit).not.toHaveBeenCalled();
    });

    it('stops at the time limit', async () => {
      const { running, finish } = await reachTests();

      jest.advanceTimersByTime(30 * 60_000);
      await settle();

      expect(docker.stop).toHaveBeenCalledWith(RUN);

      finish({ code: 137, output: 'killed' });
      await running;

      expect(lastSave()).toMatchObject({
        status: 'ERROR',
        error_code: 'TIMEOUT',
      });
      expect(commit).not.toHaveBeenCalled();
    });

    describe('the error text of a timeout', () => {
      const timedOut = async (output: string) => {
        const { running, finish } = await reachTests();

        jest.advanceTimersByTime(30 * 60_000);
        await settle();
        finish({ code: 137, output });
        await running;

        return lastSave().error_message as string;
      };

      it('keeps the end of the log', async () => {
        const message = await timedOut('stuck in npm install');

        expect(message).toContain('took longer than its time limit');
        expect(message).toContain('stuck in npm install');
      });

      it('hides secrets in it', async () => {
        tables.test_automation_configs = {
          data: {
            secrets_enc: packSecretForStorage(
              JSON.stringify({ API_TOKEN: 'secret-value' }),
            ),
            archived_at: null,
          },
          error: null,
        };

        const message = await timedOut('token secret-value');

        expect(message).not.toContain('secret-value');
        expect(message).toContain('token ***');
      });
    });

    describe('when a docker command ignores the stop', () => {
      /** A hung image pull: only killing the command ends it. */
      const reachHungPull = async () => {
        jest.useFakeTimers({
          doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
        });

        docker.runTests.mockImplementation(
          (options: RunTestsOptions) =>
            new Promise<DockerResult>((_, reject) => {
              options.signal?.addEventListener('abort', () =>
                reject(new Error('The operation was aborted')),
              );
            }),
        );

        const running = service.execute(leasedRun(), WORKER);

        while (docker.runTests.mock.calls.length === 0) await settle();

        return { running };
      };

      const advance = async (ms: number) => {
        jest.advanceTimersByTime(ms);
        await settle();
      };

      it('stops again on each heartbeat, for a container that started after the limit', async () => {
        const { running, finish } = await reachTests();

        await advance(30 * 60_000);
        docker.stop.mockClear();
        await heartbeat();

        expect(docker.stop).toHaveBeenCalledWith(RUN);

        finish({ code: 137, output: '' });
        await running;
      });

      it('leaves the command alone until 60 seconds after the limit', async () => {
        const { running, finish } = await reachTests();

        await advance(30 * 60_000);
        await advance(59_000);

        expect(testOptions().signal?.aborted).toBe(false);

        await advance(1_000);

        expect(testOptions().signal?.aborted).toBe(true);

        finish({ code: 137, output: '' });
        await running;
      });

      it('ends a killed command as a timeout', async () => {
        const { running } = await reachHungPull();

        await advance(30 * 60_000);
        await advance(60_000);
        await running;

        expect(lastSave()).toMatchObject({
          status: 'ERROR',
          error_code: 'TIMEOUT',
        });
        expect(docker.remove).toHaveBeenCalledWith(RUN);
        expect(jest.getTimerCount()).toBe(0);
      });

      it('gives the plain message when the killed command left no output', async () => {
        docker.cloneRepo.mockResolvedValue({ code: 0, output: '' });

        const { running } = await reachHungPull();

        await advance(30 * 60_000);
        await advance(60_000);
        await running;

        expect(lastSave().error_message).toMatch(
          /^The run took longer than its time limit\n?$/,
        );
      });

      it('kills it 60 seconds after a cancel too', async () => {
        const { running } = await reachHungPull();

        runAnswers.push({
          data: {
            status: 'RUNNING',
            cancel_requested_at: '2026-11-02T00:00:00Z',
          },
          error: null,
        });
        await heartbeat();

        expect(testOptions().signal?.aborted).toBe(false);

        await advance(60_000);
        await running;

        expect(lastSave()).toMatchObject({ status: 'CANCELLED' });
      });

      it('kills it 60 seconds after the run was lost', async () => {
        const { running } = await reachHungPull();

        runAnswers.push({ data: null, error: null });
        await heartbeat();
        await advance(60_000);
        await running;

        expect(testOptions().signal?.aborted).toBe(true);
      });

      it('kills nothing once a run has ended normally', async () => {
        const { running, finish } = await reachTests();

        finish({ code: 0, output: '' });
        await running;
        await advance(31 * 60_000);

        expect(testOptions().signal?.aborted).toBe(false);
      });
    });

    it('stops and saves nothing when it lost the run', async () => {
      const { running, finish } = await reachTests();

      runAnswers.push({ data: null, error: null });
      await heartbeat();

      expect(docker.stop).toHaveBeenCalledWith(RUN);

      finish({ code: 137, output: '' });
      await running;

      expect(runUpdates.filter((patch) => 'finished_at' in patch)).toEqual([]);
      expect(upload).not.toHaveBeenCalled();
      expect(docker.remove).toHaveBeenCalledWith(RUN);
    });

    it('keeps going when one heartbeat fails', async () => {
      const { running, finish } = await reachTests();

      runAnswers.push({ data: null, error: { message: 'blip' } });
      await heartbeat();

      expect(docker.stop).not.toHaveBeenCalled();

      finish({ code: 1, output: '' });
      await running;
    });

    it('drops the results when a cancel arrives after the tests', async () => {
      // Two stage writes come first; then the move to UPLOADING finds no row.
      runAnswers.push(
        { data: null, error: null },
        { data: null, error: null },
        { data: null, error: null },
      );

      await service.execute(leasedRun(), WORKER);

      expect(commit).not.toHaveBeenCalled();
      expect(lastSave()).toMatchObject({ status: 'CANCELLED' });
    });

    describe('steps that hang', () => {
      const advance = async (ms: number) => {
        jest.advanceTimersByTime(ms);
        await settle();
      };

      const fake = () =>
        jest.useFakeTimers({
          doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
        });

      const never = () => new Promise<never>(() => undefined);

      it('ends as a timeout when the limit passes during the upload', async () => {
        fake();

        let release: (value: unknown) => void = () => undefined;

        commit.mockImplementation(
          () =>
            new Promise((resolve) => {
              release = resolve;
            }),
        );

        const running = service.execute(leasedRun(), WORKER);

        while (commit.mock.calls.length === 0) await settle();

        await advance(30 * 60_000);
        release({
          applied: [{ run_id: 'r1' }],
          created_cases: [],
          warnings: [],
        });
        await running;

        expect(lastSave()).toMatchObject({
          status: 'ERROR',
          error_code: 'TIMEOUT',
          outcome: null,
        });
        expect(lastSave().result_summary).toMatchObject({
          import: { applied: 1 },
        });
      });

      it('lets go of a recording that never ends', async () => {
        fake();
        commit.mockImplementation(never);

        const running = service.execute(leasedRun(), WORKER);

        while (commit.mock.calls.length === 0) await settle();

        await advance(15 * 60_000);
        await running;

        expect(lastSave()).toMatchObject({
          status: 'ERROR',
          error_code: 'IMPORT_FAILED',
        });
        expect(docker.remove).toHaveBeenCalledWith(RUN);
      });

      it('lets go of a download that never ends, at the time limit', async () => {
        fake();
        download.mockImplementation(never);

        const running = service.execute(
          leasedRun(
            { run_zip_path: 'runs/a.zip' },
            { source: 'zip', repo_url: null },
          ),
          WORKER,
        );

        while (download.mock.calls.length === 0) await settle();

        await advance(30 * 60_000);
        await advance(60_000);
        await advance(5_000);
        await running;

        expect(lastSave()).toMatchObject({
          status: 'ERROR',
          error_code: 'TIMEOUT',
        });
        expect(docker.remove).toHaveBeenCalledWith(RUN);
        expect(jest.getTimerCount()).toBe(0);
      });

      it('keeps the output of a test step that was forced to stop', async () => {
        fake();
        docker.runTests.mockImplementation(
          (options: RunTestsOptions) =>
            new Promise<DockerResult>((resolve) => {
              options.signal?.addEventListener('abort', () =>
                resolve({ code: 137, output: 'partial output' }),
              );
            }),
        );

        const running = service.execute(leasedRun(), WORKER);

        while (docker.runTests.mock.calls.length === 0) await settle();

        await advance(30 * 60_000);
        await advance(60_000);
        await running;

        expect(lastSave()).toMatchObject({ error_code: 'TIMEOUT' });
        expect(lastSave().error_message).toContain('partial output');
        expect(firstUpload().file.buffer.toString('utf8')).toContain(
          'partial output',
        );
      });

      it('saves the result when clean-up hangs, and says it did not finish', async () => {
        fake();
        docker.remove.mockImplementation(never);

        const running = service.execute(leasedRun(), WORKER);

        while (docker.remove.mock.calls.length === 0) await settle();

        expect(runUpdates.filter((patch) => 'finished_at' in patch)).toEqual(
          [],
        );

        await advance(60_000);
        await running;

        expect(lastSave()).toMatchObject({ status: 'DONE' });
        expect(lastSave().result_summary).toMatchObject({ cleanup: 'failed' });
        expect(jest.getTimerCount()).toBe(0);
      });

      it('still removes the zip copy when Docker hangs', async () => {
        fake();
        docker.remove.mockImplementation(never);

        const running = service.execute(
          leasedRun(
            { run_zip_path: 'runs/a.zip' },
            { source: 'zip', repo_url: null },
          ),
          WORKER,
        );

        while (docker.remove.mock.calls.length === 0) await settle();

        expect(remove).toHaveBeenCalledWith(['runs/a.zip']);

        await advance(60_000);
        await running;
      });

      it('saves the result and cleans up when keeping the output throws', async () => {
        jest
          .spyOn(
            service as unknown as { attachOutput: () => Promise<void> },
            'attachOutput',
          )
          .mockRejectedValue(new Error('unexpected'));

        await service.execute(leasedRun(), WORKER);

        expect(lastSave()).toMatchObject({ status: 'DONE' });
        expect(docker.remove).toHaveBeenCalledWith(RUN);
      });

      it('renews the lease while a stop hangs', async () => {
        const { running, finish } = await reachTests();

        docker.stop.mockImplementation(never);
        await advance(30 * 60_000);

        runUpdates.length = 0;
        await heartbeat();

        expect(runUpdates.some((patch) => 'lease_until' in patch)).toBe(true);

        finish({ code: 137, output: '' });
        await running;
      });

      it('takes no notice of a heartbeat answer during the final save', async () => {
        const { running, finish } = await reachTests();
        const saves = () =>
          runUpdates.filter((patch) => 'finished_at' in patch);

        runAnswers.push(
          { data: { id: RUN }, error: null },
          { data: null, error: null },
          { data: null, error: { message: 'blip' } },
          { data: null, error: null },
        );
        finish({ code: 0, output: '' });

        while (saves().length === 0) await settle();

        await heartbeat();

        expect(docker.stop).not.toHaveBeenCalled();

        await advance(1_000);
        await running;

        expect(saves()).toHaveLength(2);
      });
    });

    describe('the disk limit', () => {
      const saved = process.env.TM_RUNNER_MAX_DISK_MB;

      afterEach(() => {
        if (saved === undefined) delete process.env.TM_RUNNER_MAX_DISK_MB;
        else process.env.TM_RUNNER_MAX_DISK_MB = saved;
      });

      it('stops a run whose folder grew past it', async () => {
        process.env.TM_RUNNER_MAX_DISK_MB = '0.000001';

        const { running, finish } = await reachTests();

        writeFileSync(join(runFolder(), 'project', 'big.bin'), 'x'.repeat(100));
        jest.advanceTimersByTime(15_000);

        while (docker.stop.mock.calls.length === 0) await settle();

        finish({ code: 137, output: 'killed' });
        await running;

        expect(lastSave()).toMatchObject({
          status: 'ERROR',
          error_code: 'DISK_LIMIT',
        });
        expect(lastSave().error_message).toContain('killed');
      });

      it('leaves a run alone below it', async () => {
        const { running, finish } = await reachTests();

        await heartbeat();

        expect(docker.stop).not.toHaveBeenCalled();

        finish({ code: 0, output: '' });
        await running;

        expect(lastSave()).toMatchObject({ status: 'DONE' });
      });
    });

    it('leaves no timer running after the run', async () => {
      const { running, finish } = await reachTests();

      finish({ code: 1, output: '' });
      await running;

      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('too many result files', () => {
    it('keeps the outcome and warns that some files were left out', async () => {
      testsWrite(
        Object.fromEntries(
          Array.from({ length: 21 }, (_, i) => [
            `out/r-${String(i).padStart(2, '0')}.xml`,
            JUNIT,
          ]),
        ),
      );

      await service.execute(
        leasedRun({}, { result_paths: ['out/*.xml'] }),
        WORKER,
      );

      expect(lastSave()).toMatchObject({ status: 'DONE', outcome: 'passed' });
      expect(lastSave().result_summary).toMatchObject({
        warnings: ['TOO_MANY_FILES'],
      });
    });

    it('adds no warning when every file fits', async () => {
      await service.execute(leasedRun(), WORKER);

      expect(
        (lastSave().result_summary as { warnings?: string[] }).warnings ?? [],
      ).not.toContain('TOO_MANY_FILES');
    });
  });

  describe('an auto run', () => {
    const savedEnabled = process.env.TM_RUNNER_ENABLED;
    const autoRun = (snapshot: Partial<LeasedRun['config_snapshot']> = {}) =>
      leasedRun(
        { run_zip_path: 'runs/a.zip' },
        {
          preset: 'auto',
          image_key: 'auto',
          source: 'zip',
          repo_url: null,
          repo_ref: null,
          result_paths: ['.xisuite-results/results.xml'],
          ...snapshot,
        },
      );
    const unzipped = (files: Record<string, string>) => {
      unzip.mockImplementation((_zip: Buffer, folder: string) => {
        for (const [path, content] of Object.entries(files)) {
          const full = join(folder, path);

          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, content);
        }

        return Promise.resolve();
      });
    };

    beforeEach(() => {
      process.env.TM_RUNNER_ENABLED = '1';
      testsWrite({ '.xisuite-results/results.xml': JUNIT });
    });

    afterEach(() => {
      if (savedEnabled === undefined) delete process.env.TM_RUNNER_ENABLED;
      else process.env.TM_RUNNER_ENABLED = savedEnabled;
    });

    it('detects Jest after the unzip and runs it in the Node.js image', async () => {
      unzipped({
        'package.json': JSON.stringify({ devDependencies: { jest: '30' } }),
        'tests/cart.test.js': '',
      });

      await service.execute(autoRun(), WORKER);

      expect(lastSave()).toMatchObject({ status: 'DONE', outcome: 'passed' });
      expect(testOptions().image).toBe('xis-tm-runner-node:latest');
      expect(testOptions().command).toContain('npx jest --ci');
      expect(testOptions().env.JEST_JUNIT_OUTPUT_FILE).toBe(
        '.xisuite-results/results.xml',
      );
      expect(lastSave().result_summary).toMatchObject({
        detected_framework: {
          preset: 'jest',
          image_key: 'node-24',
          reason: 'package.json devDependencies',
        },
      });
      expect(firstUpload().file.buffer.toString()).toContain(
        'Detected framework: jest (package.json devDependencies)',
      );
    });

    it('starts the proxy with the npm registry before it knows the framework', async () => {
      unzipped({ 'playwright.config.ts': '' });

      await service.execute(autoRun(), WORKER);

      expect(lookup).toHaveBeenCalledWith('registry.npmjs.org', { all: true });
      expect(testOptions().image).toBe(IMAGE);
    });

    it('ends FRAMEWORK_NOT_DETECTED when the tests folder has no known framework', async () => {
      unzipped({
        'web/package.json': JSON.stringify({ devDependencies: { jest: '30' } }),
      });

      await service.execute(autoRun({ work_dir: 'api' }), WORKER);

      expect(lastSave()).toMatchObject({
        status: 'ERROR',
        error_code: 'FRAMEWORK_NOT_DETECTED',
      });
      expect(lastSave().error_message).toContain('found in api');
      expect(docker.runTests).not.toHaveBeenCalled();
    });

    it.each([
      ['requirements.txt', 'Python projects are not supported yet'],
      ['build.gradle', 'Gradle projects are not supported yet'],
    ])(
      'ends FRAMEWORK_NOT_SUPPORTED for a project with %s',
      async (file, message) => {
        unzipped({ [file]: '' });

        await service.execute(autoRun(), WORKER);

        expect(lastSave()).toMatchObject({
          status: 'ERROR',
          error_code: 'FRAMEWORK_NOT_SUPPORTED',
          error_message: message,
        });
        expect(docker.runTests).not.toHaveBeenCalled();
      },
    );

    it('names JUnit and the tests folder when nothing is found', async () => {
      unzipped({ 'README.md': '' });

      await service.execute(autoRun(), WORKER);

      expect(lastSave().error_message).toContain(
        'Playwright, Cypress, Jest, Vitest, Mocha, Node.js test runner or JUnit (Maven)',
      );
      expect(lastSave().error_message).toContain('found in the project folder');
      expect(lastSave().error_message).toContain('tests folder');
    });

    it('detects a zip before any network, and opens it for that framework only', async () => {
      unzipped({ 'pom.xml': '<project/>' });
      testsWrite({ 'target/surefire-reports/TEST-a.xml': JUNIT });

      await service.execute(autoRun(), WORKER);

      expect(lastSave()).toMatchObject({ status: 'DONE' });
      expect(unzip.mock.invocationCallOrder[0]).toBeLessThan(
        docker.createNetwork.mock.invocationCallOrder[0],
      );

      const looked = (lookup.mock.calls as string[][]).map(([host]) => host);

      expect(looked).toEqual(
        expect.arrayContaining(['repo.maven.apache.org', 'repo1.maven.org']),
      );
      expect(looked).not.toContain('registry.npmjs.org');
    });

    it('opens no Maven host for a zip that is a Node.js project', async () => {
      unzipped({ 'jest.config.js': '' });

      await service.execute(autoRun(), WORKER);

      const looked = (lookup.mock.calls as string[][]).map(([host]) => host);

      expect(looked).toContain('registry.npmjs.org');
      expect(looked).not.toContain('repo.maven.apache.org');
    });

    it('opens no network when the zip has no known framework', async () => {
      unzipped({ 'README.md': '' });

      await service.execute(autoRun(), WORKER);

      expect(lastSave()).toMatchObject({
        error_code: 'FRAMEWORK_NOT_DETECTED',
      });
      expect(docker.createNetwork).not.toHaveBeenCalled();
      expect(docker.startProxy).not.toHaveBeenCalled();
      expect(docker.remove).toHaveBeenCalledWith(RUN);
      expect(lastSave().result_summary).toMatchObject({ cleanup: 'removed' });
    });

    it('lets an auto Git run reach npm and Maven Central, because it clones first', async () => {
      docker.cloneRepo.mockImplementation((options: { runFolder: string }) => {
        writeFileSync(join(options.runFolder, 'pom.xml'), '<project/>');

        return Promise.resolve({ code: 0, output: '' });
      });
      testsWrite({ 'target/surefire-reports/TEST-a.xml': JUNIT });

      await service.execute(
        autoRun({
          source: 'git',
          repo_url: 'https://git.example.com/a.git',
          repo_ref: 'main',
        }),
        WORKER,
      );

      expect(lastSave()).toMatchObject({ status: 'DONE' });
      expect(docker.createNetwork.mock.invocationCallOrder[0]).toBeLessThan(
        docker.cloneRepo.mock.invocationCallOrder[0],
      );

      const looked = (lookup.mock.calls as string[][]).map(([host]) => host);

      expect(looked).toEqual(
        expect.arrayContaining([
          'registry.npmjs.org',
          'repo.maven.apache.org',
          'repo1.maven.org',
        ]),
      );
    });

    it('runs a Maven project in the JUnit image and reads Surefire results', async () => {
      unzipped({
        'pom.xml': '<project/>',
        'src/test/java/LoginTest.java': '',
      });
      testsWrite({
        'target/surefire-reports/TEST-LoginTest.xml': JUNIT,
        'api/target/surefire-reports/TEST-Api.xml': JUNIT,
        '.xisuite-results/results.xml': JUNIT,
      });

      await service.execute(
        autoRun({ spec_files: ['src/test/java/LoginTest.java'] }),
        WORKER,
      );

      expect(lastSave()).toMatchObject({ status: 'DONE', outcome: 'passed' });
      expect(testOptions().image).toBe('xis-tm-runner-junit:latest');
      expect(testOptions().command).toContain('mvn -B');
      expect(testOptions().env.XISUITE_MAVEN_TESTS).toBe('LoginTest');
      expect(lastSave().result_summary).toMatchObject({
        detected_framework: { preset: 'maven', reason: 'pom.xml' },
        import: {
          uploaded: [
            join('api', 'target', 'surefire-reports', 'TEST-Api.xml'),
            join('target', 'surefire-reports', 'TEST-LoginTest.xml'),
          ],
        },
      });
    });

    it("keeps a Maven setting's own result paths when it is not auto", async () => {
      testsWrite({ 'target/surefire-reports/TEST-a.xml': JUNIT });

      await service.execute(
        leasedRun(
          {},
          {
            preset: 'maven',
            image_key: 'maven-3.9-java21',
            result_paths: ['out/results.xml'],
          },
        ),
        WORKER,
      );

      expect(lastSave()).toMatchObject({
        status: 'ERROR',
        error_code: 'RESULTS_MISSING',
      });
    });

    it('refuses chosen files the detected framework would not run', async () => {
      unzipped({ 'vitest.config.ts': '' });

      await service.execute(autoRun({ spec_files: ['notes.md'] }), WORKER);

      expect(lastSave()).toMatchObject({
        status: 'ERROR',
        error_code: 'SPEC_NOT_FOUND',
      });
    });

    it('never follows a linked tests folder out of the project', async () => {
      unzip.mockImplementation((_zip: Buffer, folder: string) => {
        const outside = join(base, 'outside');

        mkdirSync(outside, { recursive: true });
        writeFileSync(join(outside, 'jest.config.js'), '');
        mkdirSync(folder, { recursive: true });
        symlinkSync(outside, join(folder, 'tests'));

        return Promise.resolve();
      });

      await service.execute(autoRun({ work_dir: 'tests' }), WORKER);

      expect(lastSave()).toMatchObject({
        error_code: 'FRAMEWORK_NOT_DETECTED',
      });
    });
  });
});
