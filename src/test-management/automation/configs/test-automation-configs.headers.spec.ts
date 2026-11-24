import type { AuditLogsService } from '../../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../../auth/interfaces/request-user.interface';
import type { CiServersService } from '../../../ci-servers/ci-servers.service';
import type { PermissionsService } from '../../../permissions/permissions.service';
import type { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import type { TestManagementAccessService } from '../../access/test-management-access.service';
import type {
  TestAutomationConfig,
  UpdateTestAutomationConfigDto,
} from '../../dto/test-automation.dto';
import {
  TestAutomationConfigsService,
  type TestAutomationConfigRow,
} from '../test-automation-configs.service';
import type { TestAutomationGitService } from '../test-automation-git.service';

jest.mock('../automation-inputs', () => ({
  ...jest.requireActual<object>('../automation-inputs'),
  checkCiUrl: jest.fn((url: string) => Promise.resolve(url)),
}));

const SAVED = {
  ci_url: 'https://ci.example.com/job/a',
  ci_method: 'POST',
  ci_headers_enc: 'sealed',
  ci_body_template: null,
};

interface Prepares {
  prepare(
    dto: UpdateTestAutomationConfigDto,
    current: typeof SAVED | null,
    organizationId: string,
  ): Promise<Record<string, unknown>>;
}

describe('TestAutomationConfigsService, saved headers on a new address', () => {
  const service = new TestAutomationConfigsService(
    {} as unknown as SupabaseAdminService,
    {} as unknown as TestManagementAccessService,
    {} as unknown as AuditLogsService,
    {} as unknown as PermissionsService,
    {
      ciConnection: jest.fn().mockResolvedValue(null),
    } as unknown as TestAutomationGitService,
  ) as unknown as Prepares;

  const prepare = (
    dto: UpdateTestAutomationConfigDto,
    current: typeof SAVED | null = SAVED,
  ) => service.prepare(dto, current, 'org-1');

  it('refuses another server while the saved headers would follow', async () => {
    await expect(
      prepare({ ci_url: 'https://evil.example.com/job/a' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ field: 'ci_headers' }) as object,
    });
  });

  it.each([
    ['another port', 'https://ci.example.com:8443/job/a'],
    ['another subdomain', 'https://other.ci.example.com/job/a'],
  ])('counts %s as another server', async (_name, ci_url) => {
    await expect(prepare({ ci_url })).rejects.toMatchObject({
      response: expect.objectContaining({ field: 'ci_headers' }) as object,
    });
  });

  it('allows another path on the same server', async () => {
    await expect(
      prepare({ ci_url: 'https://ci.example.com/job/b' }),
    ).resolves.toMatchObject({ ci_url: 'https://ci.example.com/job/b' });
  });

  it('allows another server once the headers are cleared', async () => {
    await expect(
      prepare({
        ci_url: 'https://other.example.com/job',
        clear_ci_headers: true,
      }),
    ).resolves.toMatchObject({ ci_headers_enc: null });
  });

  it('allows another server when new headers are sent', async () => {
    await expect(
      prepare({ ci_url: 'https://other.example.com/job', ci_headers: {} }),
    ).resolves.toMatchObject({ ci_url: 'https://other.example.com/job' });
  });

  it('allows another server when no headers are saved', async () => {
    await expect(
      prepare(
        { ci_url: 'https://other.example.com/job' },
        { ...SAVED, ci_headers_enc: null as unknown as string },
      ),
    ).resolves.toMatchObject({ ci_url: 'https://other.example.com/job' });
  });

  it('leaves a change that keeps the address alone', async () => {
    await expect(prepare({ ci_method: 'PUT' })).resolves.toMatchObject({
      ci_method: 'PUT',
    });
  });

  it('asks nothing of a new job', async () => {
    await expect(
      prepare({ ci_url: 'https://other.example.com/job' }, null),
    ).resolves.toMatchObject({ ci_url: 'https://other.example.com/job' });
  });
});

describe('TestAutomationConfigsService, headers for a connected repository', () => {
  const DISPATCH =
    'https://api.github.com/repos/acme/tests/actions/workflows/tests.yml/dispatches';
  const ciConnection = jest.fn().mockResolvedValue({ state: 'connected' });
  const service = new TestAutomationConfigsService(
    {} as unknown as SupabaseAdminService,
    {} as unknown as TestManagementAccessService,
    {} as unknown as AuditLogsService,
    {} as unknown as PermissionsService,
    { ciConnection } as unknown as TestAutomationGitService,
  ) as unknown as Prepares;

  const savedSecret = process.env.AI_ENCRYPTION_SECRET;

  beforeEach(() => {
    ciConnection.mockClear();
    process.env.AI_ENCRYPTION_SECRET = 'a'.repeat(64);
  });

  afterEach(() => {
    if (savedSecret === undefined) delete process.env.AI_ENCRYPTION_SECRET;
    else process.env.AI_ENCRYPTION_SECRET = savedSecret;
  });

  it('saves headers that are not a login, so the connection still signs the request', async () => {
    await expect(
      service.prepare(
        {
          ci_url: DISPATCH,
          ci_headers: { Accept: 'application/vnd.github+json' },
        },
        null,
        'org-1',
      ),
    ).resolves.toMatchObject({ ci_url: DISPATCH });
    expect(ciConnection).not.toHaveBeenCalled();
  });

  it('still refuses a saved login, in any letter case', async () => {
    await expect(
      service.prepare(
        { ci_url: DISPATCH, ci_headers: { authorization: 'Bearer own' } },
        null,
        'org-1',
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ field: 'ci_headers' }) as object,
    });
  });
});

describe('TestAutomationConfigsService, a job of a connected GitLab project', () => {
  const PIPELINE = 'https://gitlab.example.com/api/v4/projects/42/pipeline';
  const match = {
    repository: { id: 'repo-gl', full_name: 'group/app', external_id: '42' },
    connection: { id: 'conn-1' },
    app: { apiUrl: 'https://gitlab.example.com/api/v4' },
  };
  const findRepositoryById = jest.fn();
  const gitlabRepositoryById = jest.fn();
  const gitlabCiConnection = jest.fn();
  const ciConnection = jest.fn();
  const service = new TestAutomationConfigsService(
    {} as unknown as SupabaseAdminService,
    {} as unknown as TestManagementAccessService,
    {} as unknown as AuditLogsService,
    {} as unknown as PermissionsService,
    {
      findRepositoryById,
      gitlabRepositoryById,
      gitlabCiConnection,
      ciConnection,
      gitlabPipelineUrl: () => PIPELINE,
    } as unknown as TestAutomationGitService,
  ) as unknown as Prepares & {
    present(
      organizationId: string,
      row: TestAutomationConfigRow,
      canEdit: boolean,
    ): Promise<TestAutomationConfig>;
  };
  const savedSecret = process.env.AI_ENCRYPTION_SECRET;

  const pick = (dto: UpdateTestAutomationConfigDto = {}) =>
    service.prepare(
      { ci_repository_id: 'repo-gl', ci_ref: 'main', ...dto },
      null,
      'org-1',
    );

  beforeEach(() => {
    jest.clearAllMocks();
    findRepositoryById.mockResolvedValue({ state: 'none' });
    gitlabRepositoryById.mockResolvedValue(match);
    gitlabCiConnection.mockResolvedValue(match);
    ciConnection.mockResolvedValue(null);
    process.env.AI_ENCRYPTION_SECRET = 'a'.repeat(64);
  });

  afterEach(() => {
    if (savedSecret === undefined) delete process.env.AI_ENCRYPTION_SECRET;
    else process.env.AI_ENCRYPTION_SECRET = savedSecret;
  });

  it('saves the project’s pipeline address with the inputs as variables and no credential', async () => {
    await expect(
      pick({ ci_inputs: { RUN_ID: '{runId}', SUITE: 'smoke' } }),
    ).resolves.toEqual({
      ci_url: PIPELINE,
      ci_method: 'POST',
      ci_headers_enc: null,
      ci_body_template: JSON.stringify({
        ref: 'main',
        variables: [
          { key: 'RUN_ID', value: '{runId}' },
          { key: 'SUITE', value: 'smoke' },
        ],
      }),
    });
    expect(gitlabRepositoryById).toHaveBeenCalledWith('org-1', 'repo-gl');
  });

  it.each([
    ['no branch', { ci_ref: undefined }, 'ci_ref'],
    ['a branch git could read as an option', { ci_ref: '-x' }, 'ci_ref'],
    ['a workflow file', { ci_workflow: 'tests.yml' }, 'ci_workflow'],
    ['a typed address', { ci_url: PIPELINE }, 'ci_url'],
    ['typed headers', { ci_headers: { 'PRIVATE-TOKEN': 'x' } }, 'ci_headers'],
    ['a bad input name', { ci_inputs: { 'a b': 'x' } }, 'ci_inputs'],
  ] as const)('refuses %s', async (_name, dto, field) => {
    await expect(pick(dto)).rejects.toMatchObject({
      response: { code: 'VALIDATION_FAILED', field },
    });
  });

  it('refuses a GitLab server without https', async () => {
    gitlabRepositoryById.mockResolvedValue({
      ...match,
      app: { apiUrl: 'http://gitlab.example.com/api/v4' },
    });

    await expect(pick()).rejects.toMatchObject({
      response: {
        field: 'ci_repository_id',
        message: 'GitLab server must use https',
      },
    });
  });

  it('still refuses a repository connected nowhere', async () => {
    gitlabRepositoryById.mockResolvedValue(null);

    await expect(pick()).rejects.toMatchObject({
      response: { field: 'ci_repository_id' },
    });
  });

  it('refuses a saved login for the address of a connected project', async () => {
    await expect(
      service.prepare(
        { ci_url: PIPELINE, ci_headers: { Authorization: 'Bearer own' } },
        null,
        'org-1',
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ field: 'ci_headers' }) as object,
    });
    expect(gitlabCiConnection).toHaveBeenCalledWith('org-1', PIPELINE);
  });

  it('keeps a saved login for a trigger address without asking', async () => {
    const trigger =
      'https://gitlab.example.com/api/v4/projects/42/trigger/pipeline';

    await expect(
      service.prepare(
        { ci_url: trigger, ci_headers: { Authorization: 'Bearer own' } },
        null,
        'org-1',
      ),
    ).resolves.toMatchObject({ ci_url: trigger });
    expect(gitlabCiConnection).not.toHaveBeenCalled();
  });

  it('moves a typed job of a connected project to the connection, body untouched', async () => {
    await expect(
      service.prepare(
        { use_connection: true },
        { ...SAVED, ci_url: PIPELINE },
        'org-1',
      ),
    ).resolves.toEqual({ ci_headers_enc: null });
  });

  it('refuses a variable name GitLab would reject', async () => {
    await expect(pick({ ci_inputs: { 'run-id': 'x' } })).rejects.toMatchObject({
      response: { code: 'VALIDATION_FAILED', field: 'ci_inputs' },
    });
  });

  describe('a trigger-token job moving to the connection', () => {
    const TRIGGER =
      'https://gitlab.example.com/api/v4/projects/42/trigger/pipeline';
    const move = (body: string | null) =>
      service.prepare(
        { use_connection: true },
        {
          ...SAVED,
          ci_url: TRIGGER,
          ci_body_template: body,
        } as unknown as typeof SAVED,
        'org-1',
      );

    it('moves to the pipeline address and drops the trigger token', async () => {
      await expect(
        move(
          '{"token":"glptt-secret","ref":"main","variables":{"XISUITE_RUN_ID":"{runId}"}}',
        ),
      ).resolves.toEqual({
        ci_url: PIPELINE,
        ci_headers_enc: null,
        ci_body_template: JSON.stringify({
          ref: 'main',
          variables: [{ key: 'XISUITE_RUN_ID', value: '{runId}' }],
        }),
      });
      expect(gitlabCiConnection).toHaveBeenCalledWith('org-1', PIPELINE);
    });

    it.each([
      ['a form body', 'token=x&ref=main'],
      ['no branch', '{"token":"x"}'],
      ['no body', null],
    ])('asks to pick the project again for %s', async (_name, body) => {
      await expect(move(body)).rejects.toMatchObject({
        response: { field: 'use_connection' },
      });
    });

    it('refuses when the project is not connected', async () => {
      gitlabCiConnection.mockResolvedValue('unavailable');

      await expect(move('{"token":"x","ref":"main"}')).rejects.toMatchObject({
        response: { field: 'use_connection' },
      });
    });
  });

  describe('reading the job back', () => {
    const row = (over: Partial<TestAutomationConfigRow> = {}) =>
      ({
        id: 'config-1',
        kind: 'ci_job',
        ci_url: PIPELINE,
        ci_method: 'POST',
        ci_headers_enc: null,
        ci_body_template:
          '{"ref":"main","variables":[{"key":"RUN_ID","value":"{runId}"}]}',
        ...over,
      }) as TestAutomationConfigRow;

    it('names the project, branch and inputs for an editor', async () => {
      await expect(
        service.present('org-1', row(), true),
      ).resolves.toMatchObject({
        ci_connected: {
          provider: 'gitlab',
          full_name: 'group/app',
          workflow: '.gitlab-ci.yml',
          ref: 'main',
          inputs: { RUN_ID: '{runId}' },
        },
      });
    });

    it.each([
      ['someone who can’t edit', row(), false],
      ['a job with saved headers', row({ ci_headers_enc: 'sealed' }), true],
      ['a body without a branch', row({ ci_body_template: '{}' }), true],
      [
        'a trigger address',
        row({
          ci_url:
            'https://gitlab.example.com/api/v4/projects/42/trigger/pipeline',
        }),
        true,
      ],
    ])('says nothing for %s', async (_name, saved, canEdit) => {
      const config = await service.present('org-1', saved, canEdit);

      expect(config.ci_connected).toBeUndefined();
    });

    it('says nothing once the project is no longer connected', async () => {
      gitlabCiConnection.mockResolvedValue('unavailable');

      const config = await service.present('org-1', row(), true);

      expect(config.ci_connected).toBeUndefined();
    });
  });
});

describe('TestAutomationConfigsService, a job of a connected Jenkins server', () => {
  const SERVER_ID = '7c1d2a8e-4b6f-4f3a-9e2d-1a2b3c4d5e6f';
  const BASE = 'https://jenkins.example.com';
  const JOB = `${BASE}/job/team/job/nightly`;
  const server = {
    id: SERVER_ID,
    name: 'Main Jenkins',
    base_url: BASE,
  };
  const listForOrg = jest.fn();
  const findForJobUrl = jest.fn();
  const listJobs = jest.fn();
  const assertAvailable = jest.fn();
  const ciConnection = jest.fn();
  const gitlabCiConnection = jest.fn();
  const service = new TestAutomationConfigsService(
    {} as unknown as SupabaseAdminService,
    { assertAvailable } as unknown as TestManagementAccessService,
    {} as unknown as AuditLogsService,
    {} as unknown as PermissionsService,
    { ciConnection, gitlabCiConnection } as unknown as TestAutomationGitService,
    { listForOrg, findForJobUrl, listJobs } as unknown as CiServersService,
  ) as unknown as Prepares &
    Pick<TestAutomationConfigsService, 'ciServerList' | 'ciServerJobs'> & {
      present(
        organizationId: string,
        row: TestAutomationConfigRow,
        canEdit: boolean,
      ): Promise<TestAutomationConfig>;
    };
  const user = { userId: 'user-1', organizationId: 'org-1' } as RequestUser;
  const savedSecret = process.env.AI_ENCRYPTION_SECRET;

  const pick = (dto: UpdateTestAutomationConfigDto = {}) =>
    service.prepare(
      { ci_server_id: SERVER_ID, ci_jenkins_job: `${JOB}/`, ...dto },
      null,
      'org-1',
    );

  beforeEach(() => {
    jest.clearAllMocks();
    assertAvailable.mockResolvedValue(undefined);
    listForOrg.mockResolvedValue([server]);
    findForJobUrl.mockResolvedValue(server);
    ciConnection.mockResolvedValue(null);
    gitlabCiConnection.mockResolvedValue(null);
    process.env.AI_ENCRYPTION_SECRET = 'a'.repeat(64);
  });

  afterEach(() => {
    if (savedSecret === undefined) delete process.env.AI_ENCRYPTION_SECRET;
    else process.env.AI_ENCRYPTION_SECRET = savedSecret;
  });

  it('lists the organization’s servers and a server’s jobs after the space check', async () => {
    listJobs.mockResolvedValue([{ name: 'team', url: `${BASE}/job/team/` }]);

    await expect(service.ciServerList(user, 'space-1')).resolves.toEqual([
      server,
    ]);
    await expect(
      service.ciServerJobs(user, 'space-1', SERVER_ID),
    ).resolves.toEqual([{ name: 'team', url: `${BASE}/job/team/` }]);
    expect(assertAvailable).toHaveBeenCalledWith('org-1', 'space-1');
    expect(listJobs).toHaveBeenCalledWith('org-1', SERVER_ID);
  });

  it('lists nothing when the space check fails', async () => {
    assertAvailable.mockRejectedValueOnce(new Error('module off'));

    await expect(service.ciServerList(user, 'space-1')).rejects.toThrow(
      'module off',
    );
    expect(listForOrg).not.toHaveBeenCalled();
  });

  it('saves the job’s build address with no credential and no body when there are no inputs', async () => {
    await expect(pick()).resolves.toEqual({
      ci_url: `${JOB}/build`,
      ci_method: 'POST',
      ci_headers_enc: null,
      ci_body_template: null,
    });
    expect(listForOrg).toHaveBeenCalledWith('org-1');
  });

  it('sends inputs as a form body, keeping placeholders for the start', async () => {
    await expect(
      pick({ ci_inputs: { RUN_ID: '{runId}', SUITE: 'a b&c=d' } }),
    ).resolves.toEqual({
      ci_url: `${JOB}/buildWithParameters`,
      ci_method: 'POST',
      ci_headers_enc: null,
      ci_body_template: 'RUN_ID={runId}&SUITE=a%20b%26c%3Dd',
    });
  });

  it('starts a job that takes parameters with buildWithParameters and the run values, even with no inputs', async () => {
    listJobs.mockResolvedValue([
      { name: 'nightly', url: `${JOB}/`, has_parameters: true },
    ]);

    await expect(pick()).resolves.toMatchObject({
      ci_url: `${JOB}/buildWithParameters`,
      ci_body_template:
        'XISUITE_SPACE_ID={spaceId}&XISUITE_PLAN_ID={planId}&XISUITE_EXECUTION_ID={executionId}&XISUITE_RUN_ID={runId}&XISUITE_TEST_KEYS={testKeys}',
    });
    expect(listJobs).toHaveBeenCalledWith('org-1', SERVER_ID);
  });

  it('lets a typed value win over a run value', async () => {
    listJobs.mockResolvedValue([
      { name: 'nightly', url: `${JOB}/`, has_parameters: true },
    ]);

    const saved = await pick({
      ci_inputs: { XISUITE_TEST_KEYS: 'T-1', SUITE: 'smoke' },
    });

    expect(saved.ci_body_template).toContain('XISUITE_TEST_KEYS=T-1');
    expect(saved.ci_body_template).not.toContain('{testKeys}');
    expect(saved.ci_body_template).toContain('XISUITE_RUN_ID={runId}');
    expect(saved.ci_body_template).toContain('SUITE=smoke');
  });

  it('refuses inputs for a job that takes no parameters', async () => {
    listJobs.mockResolvedValue([
      { name: 'nightly', url: `${JOB}/`, has_parameters: false },
    ]);

    await expect(
      pick({ ci_inputs: { RUN_ID: '{runId}' } }),
    ).rejects.toMatchObject({
      response: { code: 'VALIDATION_FAILED', field: 'ci_inputs' },
    });
  });

  it('keeps the inputs rule when Jenkins cannot be asked', async () => {
    listJobs.mockRejectedValue(new Error('unreachable'));

    await expect(pick()).resolves.toMatchObject({ ci_url: `${JOB}/build` });
    await expect(
      pick({ ci_inputs: { RUN_ID: '{runId}' } }),
    ).resolves.toMatchObject({ ci_url: `${JOB}/buildWithParameters` });
  });

  it.each([
    ['a typed address', { ci_url: `${JOB}/build` }, 'ci_url'],
    [
      'typed headers',
      { ci_headers: { Authorization: 'Basic x' } },
      'ci_headers',
    ],
    [
      'a repository as well',
      { ci_repository_id: SERVER_ID },
      'ci_repository_id',
    ],
    ['a workflow file', { ci_workflow: 'tests.yml' }, 'ci_workflow'],
    [
      'a job on another server',
      { ci_jenkins_job: 'https://evil.example.com/job/a' },
      'ci_jenkins_job',
    ],
    [
      'a job address with a query',
      { ci_jenkins_job: `${JOB}?token=x` },
      'ci_jenkins_job',
    ],
    ['the server root', { ci_jenkins_job: BASE }, 'ci_jenkins_job'],
    [
      'a server the organization does not have',
      { ci_server_id: '00000000-0000-4000-8000-000000000000' },
      'ci_server_id',
    ],
  ] as const)('refuses %s', async (_name, dto, field) => {
    await expect(pick(dto)).rejects.toMatchObject({
      response: { code: 'VALIDATION_FAILED', field },
    });
  });

  it('refuses a Jenkins server on a Docker run', async () => {
    const docker = service as unknown as {
      prepareFor(
        kind: 'docker',
        dto: UpdateTestAutomationConfigDto,
        current: null,
        organizationId: string,
      ): Promise<unknown>;
    };

    await expect(
      docker.prepareFor('docker', { ci_server_id: SERVER_ID }, null, 'org-1'),
    ).rejects.toMatchObject({ response: { field: 'ci_server_id' } });
  });

  it('names the Jenkins connection when a typed field is sent', async () => {
    await expect(pick({ ci_method: 'PUT' })).rejects.toMatchObject({
      response: {
        field: 'ci_method',
        message: expect.stringContaining('Jenkins') as string,
      },
    });
  });

  it('keeps a typed login for a connected Jenkins job address', async () => {
    await expect(
      service.prepare(
        {
          ci_url: `${JOB}/build`,
          ci_headers: { Authorization: 'Basic dTp0b2tlbg==' },
        },
        null,
        'org-1',
      ),
    ).resolves.toMatchObject({ ci_url: `${JOB}/build` });
  });

  it('moves a typed Jenkins job to the connected server, address and body untouched', async () => {
    await expect(
      service.prepare(
        { use_connection: true },
        { ...SAVED, ci_url: `${JOB}/build` },
        'org-1',
      ),
    ).resolves.toEqual({ ci_headers_enc: null });
    expect(findForJobUrl).toHaveBeenCalledWith('org-1', `${JOB}/build`);
  });

  it('refuses the move when no connected server holds the job', async () => {
    findForJobUrl.mockResolvedValue(null);

    await expect(
      service.prepare(
        { use_connection: true },
        { ...SAVED, ci_url: `${JOB}/build` },
        'org-1',
      ),
    ).rejects.toMatchObject({ response: { field: 'use_connection' } });
  });

  describe('reading the job back', () => {
    const row = (over: Partial<TestAutomationConfigRow> = {}) =>
      ({
        id: 'config-1',
        kind: 'ci_job',
        ci_url: `${JOB}/buildWithParameters`,
        ci_method: 'POST',
        ci_headers_enc: null,
        ci_body_template: 'RUN_ID={runId}&SUITE=a%20b',
        ...over,
      }) as TestAutomationConfigRow;

    it('names the server, job and inputs for an editor', async () => {
      await expect(
        service.present('org-1', row(), true),
      ).resolves.toMatchObject({
        ci_connected: {
          provider: 'jenkins',
          server_id: SERVER_ID,
          full_name: 'Main Jenkins',
          job_url: JOB,
          inputs: { RUN_ID: '{runId}', SUITE: 'a b' },
        },
      });
    });

    it.each([
      ['someone who can’t edit', row(), false],
      ['a job with saved headers', row({ ci_headers_enc: 'sealed' }), true],
      [
        'an address with a query',
        row({ ci_url: `${JOB}/build?token=x` }),
        true,
      ],
    ])('says nothing for %s', async (_name, saved, canEdit) => {
      const config = await service.present('org-1', saved, canEdit);

      expect(config.ci_connected).toBeUndefined();
    });

    it('keeps today’s answer when the server lookup fails', async () => {
      findForJobUrl.mockRejectedValue(new Error('db down'));

      const config = await service.present('org-1', row(), true);

      expect(config.ci_connected).toBeUndefined();
      expect(config.ci_url).toBe(`${JOB}/buildWithParameters`);
    });
  });
});
