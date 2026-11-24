import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import type { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import type { CiServersService } from '../../ci-servers/ci-servers.service';
import { assertPublicHttpUrl } from '../../common/security/ssrf-guard';
import { packSecretForStorage } from '../../lib/crypto/encryption';
import type { PermissionsService } from '../../permissions/permissions.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { TestManagementAccessService } from '../access/test-management-access.service';
import type {
  TestAutomationRun,
  TriggerTestAutomationDto,
} from '../dto/test-automation.dto';
import type { TestExecutionsService } from '../executions/test-executions.service';
import { safeHttpsRequest } from './safe-https-request';
import { TestAutomationCiService } from './test-automation-ci.service';
import { TestAutomationCiVariablesService } from './test-automation-ci-variables.service';
import {
  GitlabConnectionError,
  type TestAutomationGitService,
} from './test-automation-git.service';
import type {
  TestAutomationConfigRow,
  TestAutomationConfigsService,
} from './test-automation-configs.service';
import { putRepositoryVariable } from './test-automation-github.client';
import { ciToolFetch } from './test-automation-gitlab.client';
import type { TestManagementApiKeysService } from '../api-keys/test-management-api-keys.service';
import type { TestAutomationConfig } from '../dto/test-automation.dto';

jest.mock('../../common/security/ssrf-guard', () => ({
  assertPublicHttpUrl: jest.fn(),
  isBlockedAddress: jest.fn(),
}));
jest.mock('./safe-https-request', () => ({ safeHttpsRequest: jest.fn() }));
// Only the read the Jenkins credential check makes; the rest stays real.
jest.mock('./test-automation-gitlab.client', () => ({
  ...jest.requireActual<object>('./test-automation-gitlab.client'),
  ciToolFetch: jest.fn(),
}));
// Only the variable write a GitHub send makes; the rest stays real.
jest.mock('./test-automation-github.client', () => ({
  ...jest.requireActual<object>('./test-automation-github.client'),
  putRepositoryVariable: jest.fn(),
}));

const ORG = 'org-1';
const SPACE = 'space-1';
const CONFIG = 'config-1';
const EXECUTION = 'execution-1';
const REQUEST = 'request-1';
const user = { userId: 'user-1', organizationId: ORG } as RequestUser;
const dto: TriggerTestAutomationDto = {
  target: 'execution',
  target_id: EXECUTION,
  request_id: REQUEST,
};

interface Resolved {
  data?: unknown;
  error: { code?: string; message: string } | null;
}

type Chain = Record<string, jest.Mock> & PromiseLike<Resolved>;

function chainOf(resolved: Resolved): Chain {
  const chain = {} as Chain;

  for (const name of [
    'select',
    'eq',
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
    name: 'Nightly',
    kind: 'ci_job',
    ci_url: 'https://ci.example.com/job/a?token=url-token',
    ci_method: 'POST',
    ci_headers_enc: null,
    ci_body_template: null,
    archived_at: null,
    ...overrides,
  } as TestAutomationConfigRow;
}

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    organization_id: ORG,
    space_id: SPACE,
    config_id: CONFIG,
    started_by: 'user-1',
    kind: 'ci_job',
    target: 'execution',
    plan_id: null,
    execution_id: EXECUTION,
    status: 'REQUESTED',
    outcome: null,
    error_code: null,
    error_message: null,
    created_at: '2026-11-02T00:00:00Z',
    finished_at: '2026-11-02T00:00:00Z',
    ...overrides,
  };
}

describe('TestAutomationCiService', () => {
  const savedSecret = process.env.AI_ENCRYPTION_SECRET;
  const publicCheck = assertPublicHttpUrl as jest.Mock;
  const send = safeHttpsRequest as jest.Mock;

  let service: TestAutomationCiService;
  let from: jest.Mock;
  let assertAvailable: jest.Mock;
  let hasSpacePermission: jest.Mock;
  let findRow: jest.Mock;
  let log: jest.Mock;

  const next = (resolved: Resolved): Chain => {
    const chain = chainOf(resolved);

    from.mockReturnValueOnce(chain);

    return chain;
  };

  // The reads and the insert of a first start, in the order the service makes them.
  const firstStart = (
    target: Record<string, unknown> = {
      id: EXECUTION,
      is_archived: false,
      task: { key: 'P-TE1' },
    },
  ) => {
    next({ data: null, error: null });
    next({ data: target, error: null });
    next({ data: { key: 'P' }, error: null });

    return next({ data: runRow(), error: null });
  };

  const sentCall = () =>
    (send.mock.calls as unknown[][])[0] as [
      string,
      string,
      Record<string, string>,
      string | null,
    ];

  beforeAll(() => {
    process.env.AI_ENCRYPTION_SECRET = 'a'.repeat(64);
  });

  afterAll(() => {
    if (savedSecret === undefined) delete process.env.AI_ENCRYPTION_SECRET;
    else process.env.AI_ENCRYPTION_SECRET = savedSecret;
  });

  beforeEach(() => {
    publicCheck.mockReset();
    publicCheck.mockResolvedValue(undefined);
    send.mockReset();
    send.mockResolvedValue({ status: 201, body: '' });

    from = jest.fn();
    assertAvailable = jest.fn().mockResolvedValue(undefined);
    hasSpacePermission = jest.fn().mockResolvedValue(true);
    findRow = jest.fn().mockResolvedValue(config());
    log = jest.fn();

    service = new TestAutomationCiService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      { assertAvailable } as unknown as TestManagementAccessService,
      { hasSpacePermission } as unknown as PermissionsService,
      { findRow } as unknown as TestAutomationConfigsService,
      { logActionForRequest: log } as unknown as AuditLogsService,
    );
  });

  describe('who and what can start', () => {
    it('needs the right to manage test runs', async () => {
      hasSpacePermission.mockResolvedValue(false);

      await expect(
        service.trigger(user, SPACE, CONFIG, dto),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(assertAvailable).toHaveBeenCalledWith(ORG, SPACE, { write: true });
      expect(hasSpacePermission).toHaveBeenCalledWith(
        'user-1',
        ORG,
        SPACE,
        'manage_test_runs',
      );
      expect(send).not.toHaveBeenCalled();
    });

    it('refuses an archived setting', async () => {
      next({ data: null, error: null });
      findRow.mockResolvedValue(
        config({ archived_at: '2026-11-01T00:00:00Z' }),
      );

      await expect(
        service.trigger(user, SPACE, CONFIG, dto),
      ).rejects.toMatchObject({ response: { code: 'ARCHIVED' } });
      expect(send).not.toHaveBeenCalled();
    });

    it('refuses a setting with no CI address', async () => {
      next({ data: null, error: null });
      findRow.mockResolvedValue(config({ ci_url: null }));

      await expect(
        service.trigger(user, SPACE, CONFIG, dto),
      ).rejects.toMatchObject({ response: { code: 'NOT_A_CI_JOB' } });
    });

    it('answers 404 for a target outside the space', async () => {
      next({ data: null, error: null });

      const target = next({ data: null, error: null });

      await expect(
        service.trigger(user, SPACE, CONFIG, dto),
      ).rejects.toMatchObject({ status: 404 });
      expect(target.eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(target.eq).toHaveBeenCalledWith('space_id', SPACE);
      expect(from).toHaveBeenLastCalledWith('test_executions');
    });

    it('refuses an archived target', async () => {
      next({ data: null, error: null });
      next({
        data: { id: EXECUTION, is_archived: true, task: { key: 'P-TE1' } },
        error: null,
      });

      await expect(
        service.trigger(user, SPACE, CONFIG, dto),
      ).rejects.toMatchObject({ response: { code: 'ARCHIVED' } });
    });
  });

  describe('the same request id', () => {
    it('returns the first start without a second call', async () => {
      next({ data: runRow(), error: null });

      await expect(
        service.trigger(user, SPACE, CONFIG, dto),
      ).resolves.toMatchObject({ id: 'run-1', status: 'REQUESTED' });
      expect(findRow).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });

    it.each([
      ['another person', { started_by: 'user-2' }],
      ['another setting', { config_id: 'config-2' }],
      ['another space', { space_id: 'space-2' }],
      ['another organization', { organization_id: 'org-2' }],
    ])('refuses an id used by %s', async (_name, row) => {
      next({ data: runRow(row), error: null });

      const error: unknown = await service
        .trigger(user, SPACE, CONFIG, dto)
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(ConflictException);
      expect(error).toMatchObject({ response: { code: 'REQUEST_ID_REUSED' } });
      expect(send).not.toHaveBeenCalled();
    });

    it('returns the other click when two start at once', async () => {
      next({ data: null, error: null });
      next({
        data: { id: EXECUTION, is_archived: false, task: { key: 'P-TE1' } },
        error: null,
      });
      next({ data: { key: 'P' }, error: null });
      next({ data: null, error: { code: '23505', message: 'duplicate' } });
      next({ data: runRow({ id: 'run-other' }), error: null });

      await expect(
        service.trigger(user, SPACE, CONFIG, dto),
      ).resolves.toMatchObject({ id: 'run-other' });
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('a successful start', () => {
    const reads = () => {
      next({ data: null, error: null });
      next({
        data: { id: EXECUTION, is_archived: false, task: { key: 'P-TE1' } },
        error: null,
      });
      next({ data: { key: 'P' }, error: null });

      return next({
        data: runRow({ result_summary: { send_pending: true } }),
        error: null,
      });
    };

    it('marks a run while it is sent and clears the mark on an answer', async () => {
      const inserted = reads();
      const cleared = next({
        data: runRow({ result_summary: {} }),
        error: null,
      });

      await service.trigger(user, SPACE, CONFIG, dto);

      expect(firstArg(inserted.insert)).toMatchObject({
        result_summary: { send_pending: true },
      });
      expect(firstArg(cleared.update)).toEqual({ result_summary: {} });
    });

    it('clears the mark when the CI tool refuses', async () => {
      reads();
      send.mockResolvedValue({ status: 404, body: '' });

      const failed = next({
        data: runRow({ status: 'ERROR', error_code: 'CI_REJECTED_404' }),
        error: null,
      });

      await service.trigger(user, SPACE, CONFIG, dto);

      expect(firstArg(failed.update)).toMatchObject({
        status: 'ERROR',
        error_code: 'CI_REJECTED_404',
        result_summary: {},
      });
    });

    it('records the start before calling the CI tool', async () => {
      const inserted = firstStart();

      send.mockImplementation(() => {
        expect(inserted.insert).toHaveBeenCalledTimes(1);

        return Promise.resolve({ status: 201, body: '' });
      });

      await expect(
        service.trigger(user, SPACE, CONFIG, dto),
      ).resolves.toMatchObject({ status: 'REQUESTED', error_code: null });
      expect(send).toHaveBeenCalledTimes(1);
      expect(from).toHaveBeenCalledTimes(4);
    });

    it('keeps no token in what it records', async () => {
      const inserted = firstStart();

      await service.trigger(user, SPACE, CONFIG, dto);

      const row = firstArg(inserted.insert);

      expect(row).toMatchObject({
        organization_id: ORG,
        space_id: SPACE,
        config_id: CONFIG,
        kind: 'ci_job',
        execution_id: EXECUTION,
        plan_id: null,
        request_id: REQUEST,
        started_by: 'user-1',
        status: 'REQUESTED',
      });
      expect(row.config_snapshot).toEqual({
        name: 'Nightly',
        ci_method: 'POST',
        ci_url: 'https://ci.example.com/job/a',
      });
      expect(JSON.stringify(row)).not.toContain('url-token');
    });

    it('links a plan start to the plan', async () => {
      const inserted = firstStart({
        id: 'plan-1',
        is_archived: false,
        task: { key: 'P-TP1' },
      });

      await service.trigger(user, SPACE, CONFIG, {
        ...dto,
        target: 'plan',
        target_id: 'plan-1',
      });

      expect(firstArg(inserted.insert)).toMatchObject({
        plan_id: 'plan-1',
        execution_id: null,
      });
      expect(from).toHaveBeenCalledWith('test_plans');
    });

    it('sends the saved headers and fills the body', async () => {
      findRow.mockResolvedValue(
        config({
          ci_method: 'PUT',
          ci_headers_enc: packSecretForStorage('{"X-Token":"header-value"}'),
          ci_body_template:
            '{"execution":"{executionKey}","plan":"{planKey}","space":"{spaceKey}"}',
        }),
      );
      firstStart();

      await service.trigger(user, SPACE, CONFIG, dto);

      const [url, method, headers, body] = sentCall();

      expect(url).toBe('https://ci.example.com/job/a?token=url-token');
      expect(method).toBe('PUT');
      expect(headers).toEqual({
        'X-Token': 'header-value',
        'content-type': 'application/json',
      });
      expect(JSON.parse(body ?? '')).toEqual({
        execution: 'P-TE1',
        plan: '',
        space: 'P',
      });
    });

    describe('the ids a pipeline uploads with', () => {
      const idsTemplate = {
        ci_body_template:
          '{"execution":"{executionId}","plan":"{planId}","space":"{spaceId}"}',
      };

      it('names the execution and the space for an execution target', async () => {
        findRow.mockResolvedValue(config(idsTemplate));
        firstStart();

        await service.trigger(user, SPACE, CONFIG, dto);

        expect(JSON.parse(sentCall()[3] ?? '')).toEqual({
          execution: EXECUTION,
          plan: '',
          space: SPACE,
        });
      });

      it('names the plan and the space for a plan target', async () => {
        findRow.mockResolvedValue(config(idsTemplate));
        firstStart();

        await service.trigger(user, SPACE, CONFIG, {
          ...dto,
          target: 'plan',
          target_id: 'plan-1',
        });

        const sent = JSON.parse(sentCall()[3] ?? '') as Record<string, string>;

        expect(sent.execution).toBe('');
        expect(sent.space).toBe(SPACE);
        expect(sent.plan).not.toBe('');
      });
    });

    it('keeps a content type the setting chose', async () => {
      findRow.mockResolvedValue(
        config({
          ci_headers_enc: packSecretForStorage(
            '{"Content-Type":"application/x-www-form-urlencoded"}',
          ),
          ci_body_template: 'ref=main',
        }),
      );
      firstStart();

      await service.trigger(user, SPACE, CONFIG, dto);

      expect(sentCall()[2]).toEqual({
        'Content-Type': 'application/x-www-form-urlencoded',
      });
    });

    it('sends no body and no content type without a template', async () => {
      firstStart();

      await service.trigger(user, SPACE, CONFIG, dto);

      expect(sentCall()[2]).toEqual({});
      expect(sentCall()[3]).toBeNull();
    });

    it('logs the start without any secret', async () => {
      findRow.mockResolvedValue(
        config({
          ci_headers_enc: packSecretForStorage('{"X-Token":"header-value"}'),
        }),
      );
      firstStart();

      await service.trigger(user, SPACE, CONFIG, dto);

      expect(log).toHaveBeenCalledTimes(1);

      const text = JSON.stringify(log.mock.calls);

      expect(text).not.toContain('header-value');
      expect(text).not.toContain('url-token');
    });
  });

  describe('a workflow of a connected repository', () => {
    const TOKEN = 'ghs_connection_token';
    const DISPATCH =
      'https://api.github.com/repos/acme/tests/actions/workflows/tests.yml/dispatches';
    const ciConnection = jest.fn();
    const tokenFor = jest.fn();
    const match = {
      state: 'connected',
      repository: { full_name: 'acme/tests' },
      installationId: '42',
    };
    let linked: TestAutomationCiService;

    const connectedStart = () => {
      findRow.mockResolvedValue(
        config({
          ci_url: DISPATCH,
          ci_body_template:
            '{"ref":"main","inputs":{},"return_run_details":true}',
        }),
      );

      return firstStart();
    };

    // The write that follows the call: the started run's id, or the failure.
    const nextWrite = () =>
      next({ data: runRow({ result_summary: {} }), error: null });

    beforeEach(() => {
      ciConnection.mockReset();
      tokenFor.mockReset();
      ciConnection.mockResolvedValue({
        state: 'connected',
        match,
        workflow: 'tests.yml',
      });
      tokenFor.mockResolvedValue(TOKEN);
      send.mockResolvedValue({
        status: 200,
        body: JSON.stringify({
          workflow_run_id: 123,
          run_url: 'https://api.github.com/run/123',
          html_url: 'https://github.com/acme/tests/actions/runs/123',
        }),
      });

      linked = new TestAutomationCiService(
        { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
        { assertAvailable } as unknown as TestManagementAccessService,
        { hasSpacePermission } as unknown as PermissionsService,
        { findRow } as unknown as TestAutomationConfigsService,
        { logActionForRequest: log } as unknown as AuditLogsService,
        { ciConnection, tokenFor } as unknown as TestAutomationGitService,
      );
    });

    it('sends the connection’s token and keeps the started run’s id', async () => {
      const inserted = connectedStart();
      const write = nextWrite();

      await linked.trigger(user, SPACE, CONFIG, dto);

      const [url, method, headers] = sentCall();

      expect(url).toBe(DISPATCH);
      expect(method).toBe('POST');
      expect(headers).toMatchObject({
        authorization: `Bearer ${TOKEN}`,
        accept: 'application/vnd.github+json',
        'user-agent': expect.any(String) as string,
      });
      expect(firstArg(write.update)).toEqual({
        result_summary: {
          ci: {
            state: 'queued',
            full_name: 'acme/tests',
            run_id: 123,
            html_url: 'https://github.com/acme/tests/actions/runs/123',
          },
        },
      });
      expect(JSON.stringify(firstArg(inserted.insert))).not.toContain(TOKEN);
      expect(JSON.stringify(firstArg(write.update))).not.toContain(TOKEN);
    });

    it('marks a run it can’t follow when GitHub gives no id', async () => {
      connectedStart();
      send.mockResolvedValue({ status: 204, body: '' });

      const write = nextWrite();

      await linked.trigger(user, SPACE, CONFIG, dto);

      expect(firstArg(write.update)).toEqual({
        result_summary: { ci: { state: 'untracked', full_name: 'acme/tests' } },
      });
    });

    it.each([
      [{ workflow_run_id: 'abc', html_url: 'https://github.com/x' }],
      [{ workflow_run_id: 1, html_url: 'javascript:alert(1)' }],
      [{ workflow_run_id: 1 }],
    ])('doesn’t trust a malformed answer: %j', async (answer) => {
      connectedStart();
      send.mockResolvedValue({ status: 200, body: JSON.stringify(answer) });

      const write = nextWrite();

      await linked.trigger(user, SPACE, CONFIG, dto);

      expect(firstArg(write.update)).toEqual({
        result_summary: { ci: { state: 'untracked', full_name: 'acme/tests' } },
      });
    });

    it('lets stored headers win without asking the connection', async () => {
      findRow.mockResolvedValue(
        config({
          ci_url: DISPATCH,
          ci_headers_enc: packSecretForStorage(
            JSON.stringify({ Authorization: 'Bearer own-token' }),
          ),
        }),
      );
      firstStart();

      await linked.trigger(user, SPACE, CONFIG, dto);

      expect(ciConnection).not.toHaveBeenCalled();
      expect(tokenFor).not.toHaveBeenCalled();
      expect(sentCall()[2]).toEqual({ Authorization: 'Bearer own-token' });
    });

    it('signs with the connection when only headers other than a login are saved', async () => {
      findRow.mockResolvedValue(
        config({
          ci_url: DISPATCH,
          ci_headers_enc: packSecretForStorage(
            JSON.stringify({
              Accept: 'application/vnd.github+json',
              'User-Agent': 'xisuite-tm',
            }),
          ),
        }),
      );
      firstStart();
      nextWrite();

      await linked.trigger(user, SPACE, CONFIG, dto);

      expect(ciConnection).toHaveBeenCalledWith(ORG, DISPATCH);
      expect(tokenFor).toHaveBeenCalledWith(match);
      expect(sentCall()[2]).toMatchObject({
        authorization: `Bearer ${TOKEN}`,
      });
    });

    it('keeps a saved login written in lower case', async () => {
      findRow.mockResolvedValue(
        config({
          ci_url: DISPATCH,
          ci_headers_enc: packSecretForStorage(
            JSON.stringify({ authorization: 'Bearer own-token' }),
          ),
        }),
      );
      firstStart();

      await linked.trigger(user, SPACE, CONFIG, dto);

      expect(ciConnection).not.toHaveBeenCalled();
      expect(sentCall()[2]).toEqual({ authorization: 'Bearer own-token' });
    });

    it('sends any other address exactly as today, with no token', async () => {
      ciConnection.mockResolvedValue(null);
      firstStart();
      send.mockResolvedValue({ status: 201, body: '' });

      await expect(
        linked.trigger(user, SPACE, CONFIG, dto),
      ).resolves.toMatchObject({ status: 'REQUESTED' });

      expect(tokenFor).not.toHaveBeenCalled();
      expect(sentCall()[2]).toEqual({});
      expect(from).toHaveBeenCalledTimes(4);
    });

    it('sends nothing when the repository is no longer connected', async () => {
      ciConnection.mockResolvedValue({ state: 'unavailable' });
      connectedStart();

      const write = nextWrite();

      await linked.trigger(user, SPACE, CONFIG, dto);

      expect(send).not.toHaveBeenCalled();
      expect(firstArg(write.update)).toMatchObject({
        status: 'ERROR',
        error_code: 'GIT_CONNECTION_UNAVAILABLE',
      });
    });

    it('records a failed token instead of leaving the run as started', async () => {
      tokenFor.mockRejectedValue(new Error('GitHub answered 401'));
      connectedStart();

      const write = nextWrite();

      await linked.trigger(user, SPACE, CONFIG, dto);

      expect(send).not.toHaveBeenCalled();
      expect(firstArg(write.update)).toMatchObject({
        status: 'ERROR',
        error_code: 'GIT_TOKEN_FAILED',
      });
    });

    it('records a failed lookup the same way', async () => {
      ciConnection.mockRejectedValue(new Error('database down'));
      connectedStart();

      const write = nextWrite();

      await linked.trigger(user, SPACE, CONFIG, dto);

      expect(send).not.toHaveBeenCalled();
      expect(firstArg(write.update)).toMatchObject({
        error_code: 'GIT_TOKEN_FAILED',
      });
    });

    it('names the missing permission on a refusal', async () => {
      connectedStart();
      send.mockResolvedValue({
        status: 403,
        body: '{"message":"Resource not accessible by integration"}',
      });

      const write = nextWrite();

      await linked.trigger(user, SPACE, CONFIG, dto);

      expect(firstArg(write.update)).toMatchObject({
        status: 'ERROR',
        error_code: 'GIT_ACTIONS_DENIED',
      });
    });

    it('doesn’t call a rate limit a missing permission', async () => {
      connectedStart();
      send.mockResolvedValue({
        status: 403,
        body: '{"message":"API rate limit exceeded"}',
      });

      const write = nextWrite();

      await linked.trigger(user, SPACE, CONFIG, dto);

      expect(firstArg(write.update)).toMatchObject({
        error_code: 'CI_REJECTED_403',
      });
    });

    it('hides a bare token GitHub echoes in a rejection', async () => {
      connectedStart();
      send.mockResolvedValue({
        status: 422,
        body: `Unexpected inputs, token ${TOKEN}`,
      });

      const write = nextWrite();

      await linked.trigger(user, SPACE, CONFIG, dto);

      const saved = firstArg(write.update);

      expect(saved).toMatchObject({ error_code: 'CI_REJECTED_422' });
      expect(saved.error_message).toContain('Unexpected inputs');
      expect(JSON.stringify(saved)).not.toContain(TOKEN);
    });

    it('asks only once for a repeated request id', async () => {
      next({ data: runRow(), error: null });

      await linked.trigger(user, SPACE, CONFIG, dto);

      expect(ciConnection).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('a pipeline of a connected GitLab project', () => {
    const TOKEN = 'gl-oauth-token-1';
    const PIPELINE = 'https://gitlab.example.com/api/v4/projects/42/pipeline';
    const match = { connection: { id: 'conn-1' } };
    const gitlabCiConnection = jest.fn();
    const gitlabToken = jest.fn();
    const ciConnection = jest.fn();
    let linked: TestAutomationCiService;

    const gitlabStart = (headers: string | null = null, url = PIPELINE) => {
      findRow.mockResolvedValue(
        config({
          ci_url: url,
          ci_headers_enc: headers ? packSecretForStorage(headers) : null,
          ci_body_template: '{"ref":"main","variables":[]}',
        }),
      );
      firstStart();

      return next({ data: runRow({ result_summary: {} }), error: null });
    };

    beforeEach(() => {
      gitlabCiConnection.mockReset().mockResolvedValue(match);
      gitlabToken.mockReset().mockResolvedValue(TOKEN);
      ciConnection.mockReset().mockResolvedValue(null);
      send.mockResolvedValue({
        status: 201,
        body: JSON.stringify({
          id: 7001,
          project_id: 42,
          ref: 'main',
          web_url: 'https://gitlab.example.com/group/app/-/pipelines/7001',
        }),
      });

      linked = new TestAutomationCiService(
        { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
        { assertAvailable } as unknown as TestManagementAccessService,
        { hasSpacePermission } as unknown as PermissionsService,
        { findRow } as unknown as TestAutomationConfigsService,
        { logActionForRequest: log } as unknown as AuditLogsService,
        {
          gitlabCiConnection,
          gitlabToken,
          ciConnection,
        } as unknown as TestAutomationGitService,
      );
    });

    it('signs with the connected account and follows the pipeline', async () => {
      const write = gitlabStart();

      await linked.trigger(user, SPACE, CONFIG, dto);

      const [url, , headers, body] = sentCall();

      expect(gitlabCiConnection).toHaveBeenCalledWith(ORG, PIPELINE);
      expect(gitlabToken).toHaveBeenCalledWith(ORG, match.connection);
      expect(url).toBe(PIPELINE);
      expect(headers).toEqual({
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      });
      expect(body).toBe('{"ref":"main","variables":[]}');
      expect(firstArg(write.update)).toEqual({
        result_summary: {
          ci: {
            provider: 'gitlab',
            state: 'queued',
            full_name: 'group/app',
            run_id: 7001,
            html_url: 'https://gitlab.example.com/group/app/-/pipelines/7001',
            head_branch: 'main',
            project_id: 42,
          },
        },
      });
      expect(JSON.stringify(firstArg(write.update))).not.toContain(TOKEN);
    });

    it.each([
      ['a saved private token', '{"PRIVATE-TOKEN":"glpat-own"}'],
      ['a saved login', '{"Authorization":"Bearer own"}'],
    ])('keeps %s and never asks the connection', async (_name, headers) => {
      gitlabStart(headers);

      await linked.trigger(user, SPACE, CONFIG, dto);

      expect(gitlabCiConnection).not.toHaveBeenCalled();
      expect(gitlabToken).not.toHaveBeenCalled();
      expect(sentCall()[2].authorization).not.toBe(`Bearer ${TOKEN}`);
    });

    it('never treats a trigger address as connected', async () => {
      gitlabStart(
        null,
        'https://gitlab.example.com/api/v4/projects/42/trigger/pipeline',
      );

      await linked.trigger(user, SPACE, CONFIG, dto);

      expect(gitlabCiConnection).not.toHaveBeenCalled();
      expect(sentCall()[2]).toEqual({ 'content-type': 'application/json' });
    });

    it('sends an address of a project it doesn’t know exactly as today', async () => {
      gitlabCiConnection.mockResolvedValue(null);
      gitlabStart();

      await linked.trigger(user, SPACE, CONFIG, dto);

      expect(gitlabToken).not.toHaveBeenCalled();
      expect(sentCall()[2]).toEqual({ 'content-type': 'application/json' });
    });

    it.each([
      [
        'a project no longer connected',
        () => gitlabCiConnection.mockResolvedValue('unavailable'),
        'GIT_CONNECTION_UNAVAILABLE',
      ],
      [
        'a sign-in that needs a reconnect',
        () => gitlabToken.mockRejectedValue(new GitlabConnectionError()),
        'GIT_CONNECTION_UNAVAILABLE',
      ],
      [
        'a token request that failed',
        () => gitlabToken.mockRejectedValue(new Error('GitLab answered 503')),
        'GIT_TOKEN_FAILED',
      ],
    ])('sends nothing for %s', async (_name, arrange, code) => {
      arrange();

      const write = gitlabStart();

      await linked.trigger(user, SPACE, CONFIG, dto);

      expect(send).not.toHaveBeenCalled();
      expect(firstArg(write.update)).toMatchObject({
        status: 'ERROR',
        error_code: code,
      });
    });

    it.each([
      [
        400,
        '{"message":{"base":["Insufficient permissions to set pipeline variables"]}}',
        'CI_VARIABLES_REFUSED',
      ],
      [400, '{"message":{"base":["Reference not found"]}}', 'CI_REF_NOT_FOUND'],
      [401, '{"message":"401 Unauthorized"}', 'GIT_CONNECTION_UNAVAILABLE'],
      [403, '{"message":"403 Forbidden"}', 'CI_ACCESS_DENIED'],
    ])('names GitLab’s %i refusal %s', async (status, body, code) => {
      const write = gitlabStart();

      send.mockResolvedValue({ status, body });
      await linked.trigger(user, SPACE, CONFIG, dto);

      expect(firstArg(write.update)).toMatchObject({
        status: 'ERROR',
        error_code: code,
        result_summary: {
          ci: { provider: 'gitlab', state: 'untracked', full_name: '42' },
        },
      });
    });

    it('hides the token GitLab echoes in any other refusal', async () => {
      const write = gitlabStart();

      send.mockResolvedValue({ status: 422, body: `bad request ${TOKEN}` });
      await linked.trigger(user, SPACE, CONFIG, dto);

      const saved = firstArg(write.update);

      expect(saved).toMatchObject({ error_code: 'CI_REJECTED_422' });
      expect(JSON.stringify(saved)).not.toContain(TOKEN);
    });
  });

  describe('a failed start', () => {
    const failedWith = async (result: Record<string, unknown>) => {
      firstStart();
      send.mockResolvedValue(result);

      const update = next({
        data: runRow({ status: 'ERROR', error_code: 'X' }),
        error: null,
      });

      await service.trigger(user, SPACE, CONFIG, dto);

      return firstArg(update.update);
    };

    it('does not call a host that stopped being public', async () => {
      firstStart();
      publicCheck.mockRejectedValue(new Error('private'));

      const update = next({
        data: runRow({ status: 'ERROR', error_code: 'CI_BLOCKED_HOST' }),
        error: null,
      });

      await expect(
        service.trigger(user, SPACE, CONFIG, dto),
      ).resolves.toMatchObject({
        status: 'ERROR',
        error_code: 'CI_BLOCKED_HOST',
      });
      expect(send).not.toHaveBeenCalled();
      expect(firstArg(update.update)).toMatchObject({
        status: 'ERROR',
        error_code: 'CI_BLOCKED_HOST',
      });
    });

    it.each([
      ['CI_BLOCKED_HOST', 'CI_BLOCKED_HOST'],
      ['CI_TIMEOUT', 'CI_TIMEOUT'],
      ['CI_UNREACHABLE', 'CI_UNREACHABLE'],
    ])('records %s', async (failure, code) => {
      await expect(failedWith({ body: '', failure })).resolves.toMatchObject({
        status: 'ERROR',
        error_code: code,
      });
    });

    it('records the status of a refusal', async () => {
      await expect(
        failedWith({ status: 403, body: 'no access' }),
      ).resolves.toMatchObject({
        error_code: 'CI_REJECTED_403',
        error_message: 'The CI tool answered 403: no access',
      });
    });

    it('treats a redirect as a refusal', async () => {
      await expect(
        failedWith({ status: 302, body: '' }),
      ).resolves.toMatchObject({
        error_code: 'CI_REJECTED_302',
        error_message: 'The CI tool answered 302',
      });
    });

    it('hides header values and URL tokens the CI tool echoes back', async () => {
      findRow.mockResolvedValue(
        config({
          ci_headers_enc: packSecretForStorage('{"X-Token":"header-value"}'),
        }),
      );

      const written = await failedWith({
        status: 400,
        body: 'bad header-value and url-token here',
      });

      expect(written.error_message).toBe(
        'The CI tool answered 400: bad *** and *** here',
      );
    });

    it('hides the bare token of a stored Bearer header', async () => {
      findRow.mockResolvedValue(
        config({
          ci_headers_enc: packSecretForStorage(
            '{"Authorization":"Bearer glpat-secret-123"}',
          ),
        }),
      );

      const written = await failedWith({
        status: 401,
        body: 'token glpat-secret-123 is invalid',
      });

      expect(written.error_message).toBe(
        'The CI tool answered 401: token *** is invalid',
      );
    });

    it('hides a whole stored header before its parts', async () => {
      findRow.mockResolvedValue(
        config({
          ci_headers_enc: packSecretForStorage(
            '{"Authorization":"Bearer glpat-secret-123"}',
          ),
        }),
      );

      const written = await failedWith({
        status: 401,
        body: 'Bearer glpat-secret-123',
      });

      expect(written.error_message).toBe('The CI tool answered 401: ***');
    });

    it('hides a token typed into the request text and keeps short values', async () => {
      findRow.mockResolvedValue(
        config({
          ci_body_template: '{"token":"trigger-secret-99","ref":"main"}',
        }),
      );

      const written = await failedWith({
        status: 400,
        body: 'bad trigger-secret-99 for ref main',
      });

      expect(written.error_message).toBe(
        'The CI tool answered 400: bad *** for ref main',
      );
    });

    it('does not hide values filled in from the request text', async () => {
      findRow.mockResolvedValue(
        config({ ci_body_template: '{"execution":"{executionKey}-nightly"}' }),
      );

      const written = await failedWith({
        status: 400,
        body: 'unknown execution P-TE1-nightly',
      });

      expect(written.error_message).toBe(
        'The CI tool answered 400: unknown execution P-TE1-nightly',
      );
    });

    it('masks nothing extra when the request text is not JSON', async () => {
      findRow.mockResolvedValue(config({ ci_body_template: 'ref=main' }));

      const written = await failedWith({
        status: 400,
        body: 'ref=main rejected',
      });

      expect(written.error_message).toBe(
        'The CI tool answered 400: ref=main rejected',
      );
    });

    it('keeps the error text short', async () => {
      const written = await failedWith({
        status: 500,
        body: 'x'.repeat(3000),
      });

      expect((written.error_message as string).length).toBeLessThanOrEqual(600);
    });

    it('still answers when the failure cannot be recorded', async () => {
      firstStart();
      send.mockResolvedValue({ body: '', failure: 'CI_TIMEOUT' });
      next({ data: null, error: { message: 'write failed' } });

      await expect(
        service.trigger(user, SPACE, CONFIG, dto),
      ).resolves.toMatchObject({ id: 'run-1', status: 'REQUESTED' });
      expect(log).toHaveBeenCalledTimes(1);
    });
  });

  describe('GitLab and Jenkins starts that are followed', () => {
    const GITLAB = 'https://gitlab.example.com/api/v4/projects/42/pipeline';
    const JENKINS =
      'https://jenkins.example.com/job/team/job/nightly/buildWithParameters?x=1';
    const SHA = 'a'.repeat(40);
    const pipeline = {
      id: 7001,
      iid: 12,
      project_id: 42,
      sha: SHA,
      ref: 'main',
      status: 'created',
      web_url: 'https://gitlab.example.com/group/app/-/pipelines/7001',
    };

    const start = (ciUrl: string, headers: string | null) => {
      findRow.mockResolvedValue(
        config({
          ci_url: ciUrl,
          ci_headers_enc: headers ? packSecretForStorage(headers) : null,
        }),
      );
      next({ data: null, error: null });
      next({
        data: { id: EXECUTION, is_archived: false, task: { key: 'P-TE1' } },
        error: null,
      });
      next({ data: { key: 'P' }, error: null });
      next({
        data: runRow({ result_summary: { send_pending: true } }),
        error: null,
      });

      return next({ data: runRow({ result_summary: {} }), error: null });
    };

    it('keeps the pipeline of a GitLab start so it can be followed', async () => {
      const write = start(GITLAB, '{"Private-Token":"glpat-secret-1"}');

      send.mockResolvedValue({ status: 201, body: JSON.stringify(pipeline) });
      await service.trigger(user, SPACE, CONFIG, dto);

      expect(firstArg(write.update)).toEqual({
        result_summary: {
          ci: {
            provider: 'gitlab',
            state: 'queued',
            full_name: 'group/app',
            run_id: 7001,
            html_url: pipeline.web_url,
            head_sha: SHA,
            head_branch: 'main',
            project_id: 42,
          },
        },
      });
      expect(JSON.stringify(firstArg(write.update))).not.toContain('glpat');
    });

    it('reads a GitLab answer cut at 2 KB without taking a nested id', async () => {
      const write = start(
        'https://gitlab.example.com/api/v4/projects/group%2Fapp/trigger/pipeline',
        '{"PRIVATE-TOKEN":"glpat-secret-1"}',
      );
      const cut = JSON.stringify({
        ...pipeline,
        user: { id: 99, name: 'x'.repeat(3000) },
      }).slice(0, 2048);

      send.mockResolvedValue({ status: 201, body: cut });
      await service.trigger(user, SPACE, CONFIG, dto);

      expect(firstArg(write.update)).toMatchObject({
        result_summary: {
          ci: { state: 'queued', run_id: 7001, project_id: 42 },
        },
      });
    });

    it('marks a GitLab start it cannot read as untracked', async () => {
      const write = start(GITLAB, '{"private-token":"glpat-secret-1"}');

      send.mockResolvedValue({
        status: 201,
        body: JSON.stringify({
          ...pipeline,
          web_url: 'https://evil.example.com/group/app/-/pipelines/7001',
        }),
      });
      await service.trigger(user, SPACE, CONFIG, dto);

      expect(firstArg(write.update)).toEqual({
        result_summary: {
          ci: { provider: 'gitlab', state: 'untracked', full_name: '42' },
        },
      });
    });

    it('keeps the queue item of a Jenkins start on the same host', async () => {
      const write = start(JENKINS, '{"Authorization":"Basic dTp0b2tlbg=="}');

      send.mockResolvedValue({
        status: 201,
        body: '',
        location: 'https://jenkins.example.com/queue/item/55/',
      });
      await service.trigger(user, SPACE, CONFIG, dto);

      expect(firstArg(write.update)).toEqual({
        result_summary: {
          ci: {
            provider: 'jenkins',
            state: 'queued',
            full_name: 'team/nightly',
            queue_url: 'https://jenkins.example.com/queue/item/55/',
          },
        },
      });
    });

    it.each([
      'https://other.example.com/queue/item/55/',
      'https://jenkins.example.com/job/team/55/',
      undefined,
    ])('does not follow a Jenkins queue item at %s', async (location) => {
      const write = start(JENKINS, '{"authorization":"Basic dTp0b2tlbg=="}');

      send.mockResolvedValue({ status: 201, body: '', location });
      await service.trigger(user, SPACE, CONFIG, dto);

      expect(firstArg(write.update)).toEqual({
        result_summary: {
          ci: {
            provider: 'jenkins',
            state: 'untracked',
            full_name: 'team/nightly',
          },
        },
      });
    });

    it.each([
      [GITLAB, null],
      [GITLAB, '{"Authorization":"Bearer x"}'],
      [JENKINS, '{"X-Token":"abc"}'],
    ])(
      'keeps today’s "sent" without a token to read with (%s, %s)',
      async (ciUrl, headers) => {
        const cleared = start(ciUrl, headers);

        send.mockResolvedValue({
          status: 201,
          body: JSON.stringify(pipeline),
          location: 'https://jenkins.example.com/queue/item/55/',
        });
        await service.trigger(user, SPACE, CONFIG, dto);

        expect(firstArg(cleared.update)).toEqual({ result_summary: {} });
      },
    );

    it('follows nothing when the CI tool refused the start', async () => {
      const failed = start(GITLAB, '{"PRIVATE-TOKEN":"glpat-secret-1"}');

      send.mockResolvedValue({ status: 400, body: JSON.stringify(pipeline) });
      await service.trigger(user, SPACE, CONFIG, dto);

      expect(firstArg(failed.update)).toMatchObject({
        status: 'ERROR',
        result_summary: {
          ci: { provider: 'gitlab', state: 'untracked', full_name: '42' },
        },
      });
    });

    it('names Jenkins on a refused Jenkins start', async () => {
      const failed = start(JENKINS, '{"Authorization":"Basic dTp0b2tlbg=="}');

      send.mockResolvedValue({ status: 422, body: 'Nope' });
      await service.trigger(user, SPACE, CONFIG, dto);

      expect(firstArg(failed.update)).toMatchObject({
        status: 'ERROR',
        result_summary: {
          ci: {
            provider: 'jenkins',
            state: 'untracked',
            full_name: 'team/nightly',
          },
        },
      });
    });

    it('names no CI tool on a refused start at any other address', async () => {
      const failed = start('https://ci.example.com/hooks/start', null);

      send.mockResolvedValue({ status: 422, body: 'Nope' });
      await service.trigger(user, SPACE, CONFIG, dto);

      expect(
        (firstArg(failed.update) as { result_summary: object }).result_summary,
      ).toEqual({});
    });

    describe('a job on a connected Jenkins server', () => {
      const JOB = 'https://jenkins.example.com/job/team/job/nightly';
      const TOKEN = 'api-token-123456';
      const LOGIN = `Basic ${Buffer.from(`jenkins-user:${TOKEN}`).toString('base64')}`;
      const server = {
        id: 'server-1',
        base_url: 'https://jenkins.example.com',
      };
      const findForJobUrl = jest.fn();
      const authorizationFor = jest.fn();
      const markNeedsAttention = jest.fn();
      let linked: TestAutomationCiService;

      beforeEach(() => {
        findForJobUrl.mockReset().mockResolvedValue(server);
        authorizationFor.mockReset().mockReturnValue(LOGIN);
        markNeedsAttention.mockReset().mockResolvedValue(undefined);
        linked = new TestAutomationCiService(
          { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
          { assertAvailable } as unknown as TestManagementAccessService,
          { hasSpacePermission } as unknown as PermissionsService,
          { findRow } as unknown as TestAutomationConfigsService,
          { logActionForRequest: log } as unknown as AuditLogsService,
          undefined,
          undefined,
          {
            findForJobUrl,
            authorizationFor,
            markNeedsAttention,
          } as unknown as CiServersService,
        );
      });

      it('signs the start in as the server’s user, sends inputs as a form and follows the queue item', async () => {
        const write = start(`${JOB}/buildWithParameters`, null);

        findRow.mockResolvedValue(
          config({
            ci_url: `${JOB}/buildWithParameters`,
            ci_body_template: 'RUN_ID={runId}&SUITE=smoke',
          }),
        );
        send.mockResolvedValue({
          status: 201,
          body: '',
          location: 'https://jenkins.example.com/queue/item/55/',
        });
        await linked.trigger(user, SPACE, CONFIG, dto);

        const [url, , headers, body] = sentCall();

        expect(findForJobUrl).toHaveBeenCalledWith(
          ORG,
          `${JOB}/buildWithParameters`,
        );
        expect(url).toBe(`${JOB}/buildWithParameters`);
        expect(headers).toEqual({
          authorization: LOGIN,
          'content-type': 'application/x-www-form-urlencoded',
        });
        expect(body).toMatch(/^RUN_ID=[0-9a-f-]{36}&SUITE=smoke$/);
        expect(firstArg(write.update)).toEqual({
          result_summary: {
            ci: {
              provider: 'jenkins',
              state: 'queued',
              full_name: 'team/nightly',
              queue_url: 'https://jenkins.example.com/queue/item/55/',
            },
          },
        });
        expect(markNeedsAttention).not.toHaveBeenCalled();
      });

      it('keeps a saved login and never asks for the server', async () => {
        start(`${JOB}/build`, '{"Authorization":"Basic dTp0b2tlbg=="}');
        send.mockResolvedValue({ status: 201, body: '' });
        await linked.trigger(user, SPACE, CONFIG, dto);

        expect(findForJobUrl).not.toHaveBeenCalled();
        expect(sentCall()[2]).toEqual({ Authorization: 'Basic dTp0b2tlbg==' });
      });

      it('leaves a job on no connected server as it is', async () => {
        findForJobUrl.mockResolvedValue(null);
        const cleared = start(`${JOB}/build`, null);

        send.mockResolvedValue({ status: 201, body: '' });
        await linked.trigger(user, SPACE, CONFIG, dto);

        expect(sentCall()[2]).toEqual({});
        expect(firstArg(cleared.update)).toEqual({ result_summary: {} });
      });

      it.each([401, 403])(
        'flags the server and asks an admin to fix it on a %s, hiding the login',
        async (status) => {
          const failed = start(`${JOB}/build`, null);

          send.mockResolvedValue({
            status,
            body: `bad ${LOGIN} ${TOKEN} jenkins-user:${TOKEN}`,
          });
          await linked.trigger(user, SPACE, CONFIG, dto);

          const saved = firstArg(failed.update);

          expect(saved).toMatchObject({
            status: 'ERROR',
            error_code: 'CI_ACCESS_UNAVAILABLE',
            error_message: expect.stringContaining(
              'Tenant Configuration → Integrations',
            ) as string,
          });
          expect(JSON.stringify(saved)).not.toContain(TOKEN);
          expect(markNeedsAttention).toHaveBeenCalledWith(
            ORG,
            'server-1',
            expect.any(String),
          );
        },
      );

      it('names a crumb refusal without flagging the server', async () => {
        const failed = start(`${JOB}/build`, null);

        send.mockResolvedValue({
          status: 403,
          body: 'No valid crumb was included in the request',
        });
        await linked.trigger(user, SPACE, CONFIG, dto);

        expect(firstArg(failed.update)).toMatchObject({
          error_code: 'CI_ACCESS_DENIED',
          error_message: expect.stringContaining('crumb') as string,
        });
        expect(markNeedsAttention).not.toHaveBeenCalled();
      });

      it('hides the login in any other refusal', async () => {
        const failed = start(`${JOB}/build`, null);

        send.mockResolvedValue({ status: 500, body: `oops ${TOKEN}` });
        await linked.trigger(user, SPACE, CONFIG, dto);

        expect(firstArg(failed.update)).toMatchObject({
          error_code: 'CI_REJECTED_500',
        });
        expect(JSON.stringify(firstArg(failed.update))).not.toContain(TOKEN);
      });

      it('fails clearly when the server cannot be read, sending nothing', async () => {
        findForJobUrl.mockRejectedValue(new Error('db down'));
        const failed = start(`${JOB}/build`, null);

        await linked.trigger(user, SPACE, CONFIG, dto);

        expect(send).not.toHaveBeenCalled();
        expect(firstArg(failed.update)).toMatchObject({
          error_code: 'CI_ACCESS_UNAVAILABLE',
        });
        expect(markNeedsAttention).not.toHaveBeenCalled();
      });
    });
  });
});

describe('TestAutomationCiService, one test case, test keys and form values', () => {
  const savedSecret = process.env.AI_ENCRYPTION_SECRET;
  const publicCheck = assertPublicHttpUrl as jest.Mock;
  const send = safeHttpsRequest as jest.Mock;
  const CASE = '00000000-0000-4000-8000-000000000001';
  const CASE_REQUEST = '00000000-0000-4000-8000-0000000000aa';
  const caseDto = { case_id: CASE, request_id: CASE_REQUEST };

  let service: TestAutomationCiService;
  let from: jest.Mock;
  let hasSpacePermission: jest.Mock;
  let checkPermission: jest.Mock;
  let findRow: jest.Mock;
  let create: jest.Mock;
  let removeFailedImport: jest.Mock;

  const next = (resolved: Resolved): Chain => {
    const chain = chainOf(resolved);

    chain.limit = jest.fn(() => chain);
    from.mockReturnValueOnce(chain);

    return chain;
  };

  const caseRow = (overrides: Record<string, unknown> = {}) => ({
    id: CASE,
    is_archived: false,
    readiness: 'ready',
    test_type: 'playwright',
    task: { key: 'P-TC1' },
    ...overrides,
  });

  const settings = {
    test_types: [
      { id: 'playwright', kind: 'unstructured' },
      { id: 'manual', kind: 'steps' },
    ],
  };

  // The run lookup, the case and the space's test types, in the order the service reads them.
  const caseReads = (row = caseRow()) => {
    next({ data: null, error: null });
    next({ data: row, error: null });
    next({ data: settings, error: null });
  };

  const sentBody = () => (send.mock.calls as unknown[][])[0]?.[3] as string;

  beforeAll(() => {
    process.env.AI_ENCRYPTION_SECRET = 'a'.repeat(64);
  });

  afterAll(() => {
    if (savedSecret === undefined) delete process.env.AI_ENCRYPTION_SECRET;
    else process.env.AI_ENCRYPTION_SECRET = savedSecret;
  });

  beforeEach(() => {
    publicCheck.mockReset();
    publicCheck.mockResolvedValue(undefined);
    send.mockReset();
    send.mockResolvedValue({ status: 201, body: '' });

    from = jest.fn();
    hasSpacePermission = jest.fn().mockResolvedValue(true);
    checkPermission = jest.fn().mockResolvedValue(true);
    findRow = jest.fn().mockResolvedValue(config());
    create = jest.fn().mockResolvedValue({ execution_id: EXECUTION });
    removeFailedImport = jest.fn().mockResolvedValue(undefined);

    service = new TestAutomationCiService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      {
        assertAvailable: jest.fn().mockResolvedValue(undefined),
      } as unknown as TestManagementAccessService,
      { hasSpacePermission, checkPermission } as unknown as PermissionsService,
      { findRow } as unknown as TestAutomationConfigsService,
      { logActionForRequest: jest.fn() } as unknown as AuditLogsService,
      undefined,
      { create, removeFailedImport } as unknown as TestExecutionsService,
    );
  });

  describe('starting one test case', () => {
    it('returns the first start of the same request at once', async () => {
      next({ data: runRow({ request_id: CASE_REQUEST }), error: null });

      await expect(
        service.triggerCase(user, SPACE, CONFIG, caseDto),
      ).resolves.toMatchObject({ id: 'run-1' });
      expect(create).not.toHaveBeenCalled();
      expect(findRow).not.toHaveBeenCalled();
    });

    it('needs the right to manage test runs', async () => {
      hasSpacePermission.mockResolvedValue(false);

      await expect(
        service.triggerCase(user, SPACE, CONFIG, caseDto),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(create).not.toHaveBeenCalled();
    });

    it('refuses an archived setting before creating anything', async () => {
      next({ data: null, error: null });
      findRow.mockResolvedValue(
        config({ archived_at: '2026-11-01T00:00:00Z' }),
      );

      await expect(
        service.triggerCase(user, SPACE, CONFIG, caseDto),
      ).rejects.toMatchObject({ response: { code: 'ARCHIVED' } });
      expect(create).not.toHaveBeenCalled();
    });

    it.each([
      [
        'a manual test type',
        caseRow({ test_type: 'manual' }),
        'CASE_NOT_AUTOMATED',
      ],
      [
        'a type the space no longer has',
        caseRow({ test_type: 'gone' }),
        'CASE_NOT_AUTOMATED',
      ],
      ['an archived case', caseRow({ is_archived: true }), 'ARCHIVED'],
      [
        'a deprecated case',
        caseRow({ readiness: 'deprecated' }),
        'CASE_DEPRECATED',
      ],
    ])('refuses %s', async (_name, row, code) => {
      caseReads(row);

      await expect(
        service.triggerCase(user, SPACE, CONFIG, caseDto),
      ).rejects.toMatchObject({ response: { code } });
      expect(create).not.toHaveBeenCalled();
    });

    it('refuses a case of another space', async () => {
      next({ data: null, error: null });
      next({ data: null, error: null });

      await expect(
        service.triggerCase(user, SPACE, CONFIG, caseDto),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('needs the right to create tasks, for the execution ticket', async () => {
      caseReads();
      checkPermission.mockResolvedValue(false);

      await expect(
        service.triggerCase(user, SPACE, CONFIG, caseDto),
      ).rejects.toMatchObject({
        response: { code: 'TICKET_CREATE_FORBIDDEN' },
      });
      expect(checkPermission).toHaveBeenCalledWith(
        'user-1',
        ORG,
        'can_create_tasks',
      );
      expect(create).not.toHaveBeenCalled();
    });

    it('creates an execution with only this test, then starts the job for it', async () => {
      caseReads();

      const trigger = jest
        .spyOn(service, 'trigger')
        .mockResolvedValue(runRow() as unknown as TestAutomationRun);

      await service.triggerCase(user, SPACE, CONFIG, caseDto);

      const [, space, input] = create.mock.calls[0] as [
        unknown,
        string,
        { request_id: string; from: string; case_ids: string[]; name: string },
      ];

      expect(space).toBe(SPACE);
      expect(input).toMatchObject({ from: 'cases', case_ids: [CASE] });
      expect(input.name).toMatch(
        /^CI · P-TC1 · \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/,
      );
      expect(input.request_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(input.request_id).not.toBe(CASE_REQUEST);
      expect(trigger).toHaveBeenCalledWith(user, SPACE, CONFIG, {
        target: 'execution',
        target_id: EXECUTION,
        request_id: CASE_REQUEST,
      });
    });

    it('names the same execution when the same request is sent again', async () => {
      jest
        .spyOn(service, 'trigger')
        .mockResolvedValue(runRow() as unknown as TestAutomationRun);

      caseReads();
      await service.triggerCase(user, SPACE, CONFIG, caseDto);
      caseReads();
      await service.triggerCase(user, SPACE, CONFIG, caseDto);

      const ids = (
        create.mock.calls as [unknown, unknown, { request_id: string }][]
      ).map(([, , input]) => input.request_id);

      expect(ids[0]).toBe(ids[1]);
    });

    it('takes the execution back when the start fails before its run is saved', async () => {
      caseReads();

      const failure = new Error('db down');

      jest.spyOn(service, 'trigger').mockRejectedValue(failure);
      next({ data: null, error: null });

      await expect(
        service.triggerCase(user, SPACE, CONFIG, caseDto),
      ).rejects.toBe(failure);
      expect(removeFailedImport).toHaveBeenCalledWith(user, SPACE, EXECUTION);
    });

    it('keeps the execution when its run was saved before the failure', async () => {
      caseReads();
      jest.spyOn(service, 'trigger').mockRejectedValue(new Error('late'));
      next({ data: { id: 'run-1' }, error: null });

      await expect(
        service.triggerCase(user, SPACE, CONFIG, caseDto),
      ).rejects.toThrow('late');
      expect(removeFailedImport).not.toHaveBeenCalled();
    });

    it('keeps the execution of a run the CI tool refused', async () => {
      caseReads();
      jest.spyOn(service, 'trigger').mockResolvedValue(
        runRow({
          status: 'ERROR',
          error_code: 'CI_REJECTED_404',
        }) as unknown as TestAutomationRun,
      );

      await expect(
        service.triggerCase(user, SPACE, CONFIG, caseDto),
      ).resolves.toMatchObject({ status: 'ERROR' });
      expect(removeFailedImport).not.toHaveBeenCalled();
    });

    it('still fails with the first error when taking the execution back fails', async () => {
      caseReads();
      jest.spyOn(service, 'trigger').mockRejectedValue(new Error('first'));
      next({ data: null, error: null });
      removeFailedImport.mockRejectedValue(new Error('second'));

      await expect(
        service.triggerCase(user, SPACE, CONFIG, caseDto),
      ).rejects.toThrow('first');
    });
  });

  describe('the {testKeys} value', () => {
    const keyRows = (keys: string[]) =>
      keys.map((key) => ({ test_case: { task: { key } } }));

    // The run lookup, the execution, the space key and the tests, then the insert and the cleared mark.
    const startWith = async (template: string, keys: string[]) => {
      findRow.mockResolvedValue(config({ ci_body_template: template }));
      next({ data: null, error: null });
      next({
        data: { id: EXECUTION, is_archived: false, task: { key: 'P-TE1' } },
        error: null,
      });
      next({ data: { key: 'P' }, error: null });

      const tests = next({ data: keyRows(keys), error: null });

      next({
        data: runRow({ result_summary: { send_pending: true } }),
        error: null,
      });
      next({ data: runRow({ result_summary: {} }), error: null });

      await service.trigger(user, SPACE, CONFIG, dto);

      // Wrapped: the chain can be awaited, so returning it bare would resolve it.
      return { tests };
    };

    it('sends the keys of the execution’s tests in order', async () => {
      const { tests } = await startWith('{"keys":"{testKeys}"}', [
        'P-TC10',
        'P-TC2',
        'P-TC2',
      ]);

      expect(sentBody()).toBe('{"keys":"P-TC2,P-TC10"}');
      expect(tests.eq).toHaveBeenCalledWith('execution_id', EXECUTION);
      expect(tests.eq).toHaveBeenCalledWith('test_case.is_archived', false);
      expect(tests.limit).toHaveBeenCalledWith(101);
    });

    it('sends nothing for more than 100 tests, which means run them all', async () => {
      await startWith(
        'KEYS={testKeys}',
        Array.from({ length: 101 }, (_, index) => `P-TC${index}`),
      );

      expect(sentBody()).toBe('KEYS=');
    });

    it('leaves the keys out when they would make the request too long', async () => {
      const template = `${'x'.repeat(9990)}{testKeys}`;

      await startWith(template, ['P-TC1', 'P-TC2']);

      expect(sentBody()).toBe('x'.repeat(9990));
    });

    it('does not read the tests when the request has no {testKeys}', async () => {
      findRow.mockResolvedValue(
        config({ ci_body_template: '{"run":"{runId}"}' }),
      );
      next({ data: null, error: null });
      next({
        data: { id: EXECUTION, is_archived: false, task: { key: 'P-TE1' } },
        error: null,
      });
      next({ data: { key: 'P' }, error: null });
      next({
        data: runRow({ result_summary: { send_pending: true } }),
        error: null,
      });
      next({ data: runRow({ result_summary: {} }), error: null });

      await service.trigger(user, SPACE, CONFIG, dto);

      expect(from).toHaveBeenCalledTimes(5);
      expect(from).not.toHaveBeenCalledWith('test_runs');
    });
  });

  describe('a form request text', () => {
    const failedWith = async (
      headers: string,
      template: string,
      body: string,
    ) => {
      findRow.mockResolvedValue(
        config({
          ci_headers_enc: packSecretForStorage(headers),
          ci_body_template: template,
        }),
      );
      next({ data: null, error: null });
      next({
        data: { id: EXECUTION, is_archived: false, task: { key: 'P-TE1' } },
        error: null,
      });
      next({ data: { key: 'P' }, error: null });
      next({ data: runRow(), error: null });
      send.mockResolvedValue({ status: 400, body });

      const update = next({
        data: runRow({ status: 'ERROR', error_code: 'CI_REJECTED_400' }),
        error: null,
      });

      await service.trigger(user, SPACE, CONFIG, dto);

      return firstArg(update.update).error_message;
    };

    it.each([
      ['application/x-www-form-urlencoded'],
      ['Application/X-WWW-Form-Urlencoded; charset=utf-8'],
    ])(
      'hides a token typed into it, as sent and decoded, for %s',
      async (type) => {
        await expect(
          failedWith(
            JSON.stringify({ 'Content-Type': type }),
            'token=abc%2Bsecret99&ref=main&run={runId}',
            'bad abc%2Bsecret99 / abc+secret99 for main',
          ),
        ).resolves.toBe('The CI tool answered 400: bad *** / *** for main');
      },
    );

    it('hides nothing extra without a form Content-Type', async () => {
      await expect(
        failedWith(
          JSON.stringify({ 'X-Other': 'value-123' }),
          'token=abc%2Bsecret99',
          'bad abc+secret99',
        ),
      ).resolves.toBe('The CI tool answered 400: bad abc+secret99');
    });
  });
});

describe('TestAutomationCiService, writes after the CI tool answered', () => {
  const send = safeHttpsRequest as jest.Mock;
  const publicCheck = assertPublicHttpUrl as jest.Mock;
  let from: jest.Mock;
  let service: TestAutomationCiService;

  const next = (resolved: Resolved): Chain => {
    const chain = chainOf(resolved);

    from.mockReturnValueOnce(chain);

    return chain;
  };

  // Request id, target, space key and the insert that leaves the marker.
  const started = () => {
    next({ data: null, error: null });
    next({
      data: { id: EXECUTION, is_archived: false, task: { key: 'P-TE1' } },
      error: null,
    });
    next({ data: { key: 'P' }, error: null });
    next({
      data: runRow({ result_summary: { send_pending: true } }),
      error: null,
    });
  };

  beforeEach(() => {
    publicCheck.mockReset();
    publicCheck.mockResolvedValue(undefined);
    send.mockReset();
    from = jest.fn();
    service = new TestAutomationCiService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      {
        assertAvailable: jest.fn().mockResolvedValue(undefined),
      } as unknown as TestManagementAccessService,
      {
        hasSpacePermission: jest.fn().mockResolvedValue(true),
      } as unknown as PermissionsService,
      {
        findRow: jest.fn().mockResolvedValue(config()),
      } as unknown as TestAutomationConfigsService,
      { logActionForRequest: jest.fn() } as unknown as AuditLogsService,
    );
  });

  it('clears the marker only while it is still there', async () => {
    send.mockResolvedValue({ status: 201, body: '' });
    started();

    const sent = next({ data: runRow({ result_summary: {} }), error: null });

    await expect(
      service.trigger(user, SPACE, CONFIG, dto),
    ).resolves.toMatchObject({
      status: 'REQUESTED',
      result_summary: {},
    });
    expect(firstArg(sent.update)).toEqual({ result_summary: {} });
    expect(sent.eq).toHaveBeenCalledWith(
      'result_summary->>send_pending',
      'true',
    );
    expect(sent.maybeSingle).toHaveBeenCalled();
  });

  it('records a refusal only while the marker is still there', async () => {
    send.mockResolvedValue({ status: 500, body: 'down' });
    started();

    const failed = next({
      data: runRow({ status: 'ERROR', error_code: 'CI_REJECTED_500' }),
      error: null,
    });

    await expect(
      service.trigger(user, SPACE, CONFIG, dto),
    ).resolves.toMatchObject({
      status: 'ERROR',
      error_code: 'CI_REJECTED_500',
    });
    expect(firstArg(failed.update)).toMatchObject({
      status: 'ERROR',
      error_code: 'CI_REJECTED_500',
    });
    expect(failed.eq).toHaveBeenCalledWith(
      'result_summary->>send_pending',
      'true',
    );
  });

  it.each([
    ['accepted', 201],
    ['refused', 500],
  ])(
    'never undoes a close by the upload when the CI tool %s the job',
    async (_label, status) => {
      send.mockResolvedValue({ status, body: '' });
      started();

      // The job's upload closed the run first, so the update matches no row.
      const late = next({ data: null, error: null });

      await expect(
        service.trigger(user, SPACE, CONFIG, dto),
      ).resolves.toMatchObject({
        id: 'run-1',
        status: 'REQUESTED',
      });
      expect(late.eq).toHaveBeenCalledWith(
        'result_summary->>send_pending',
        'true',
      );
      expect(from).toHaveBeenCalledTimes(5);
    },
  );
});

describe('TestAutomationCiVariablesService, Send to CI', () => {
  const send = safeHttpsRequest as jest.Mock;
  const read = ciToolFetch as jest.Mock;
  const putVariable = putRepositoryVariable as jest.Mock;
  const GITHUB_ACCESS = {
    apiUrl: 'https://api.github.com',
    fullName: 'acme/tests',
    token: 'gh-token',
  };
  const publicCheck = assertPublicHttpUrl as jest.Mock;
  const TOKEN = `xis_tm_${'a'.repeat(43)}`;
  const API = 'https://gitlab.example.com/api/v4';
  const JENKINS = 'https://ci.example.com/credentials/store/system/domain/_';
  const JOB_ID = '12345678-aaaa-bbbb-cccc-123456789012';
  let get: jest.Mock;
  let create: jest.Mock;
  let list: jest.Mock;
  let revoke: jest.Mock;
  let audit: jest.Mock;
  let findForJobUrl: jest.Mock;
  let service: TestAutomationCiVariablesService;

  const job = (
    ci_connected: TestAutomationConfig['ci_connected'],
    overrides: Partial<TestAutomationConfig> = {},
  ) =>
    ({
      id: JOB_ID,
      name: 'Nightly',
      kind: 'ci_job',
      ci_url: 'https://ci.example.com/job/a/build',
      archived_at: null,
      ci_connected,
      ...overrides,
    }) as TestAutomationConfig;
  const gitlabJob = job({
    provider: 'gitlab',
    full_name: 'acme/tests',
    workflow: '.gitlab-ci.yml',
    ref: 'main',
    inputs: {},
  });
  const jenkinsJob = job({
    provider: 'jenkins',
    server_id: 'server-1',
    full_name: 'CI',
    job_url: 'https://ci.example.com/job/a',
    inputs: {},
  });
  const githubJob = job({
    full_name: 'acme/tests',
    workflow: 'tests.yml',
    ref: 'main',
    inputs: {},
  });
  const sent = (index: number) =>
    (send.mock.calls as unknown[][])[index] as [
      string,
      string,
      Record<string, string>,
      string,
    ];

  beforeEach(() => {
    send.mockReset();
    read.mockReset();
    putVariable.mockReset();
    putVariable.mockResolvedValue(201);
    publicCheck.mockReset();
    publicCheck.mockResolvedValue(undefined);
    get = jest.fn().mockResolvedValue(gitlabJob);
    create = jest.fn((_user: RequestUser, body: { name: string }) =>
      Promise.resolve({
        token: TOKEN,
        api_key: {
          id: 'key-new',
          name: body.name,
          token_prefix: 'xis_tm_aaaa',
          expires_at: '2027-02-01T00:00:00Z',
        },
      }),
    );
    list = jest.fn().mockResolvedValue([
      { id: 'key-new', name: 'CI · Nightly · 12345678' },
      { id: 'key-old', name: 'CI · Nightly · 12345678' },
      { id: 'key-other', name: 'CI · Other · 87654321' },
    ]);
    revoke = jest.fn().mockResolvedValue({ id: 'x' });
    audit = jest.fn();
    findForJobUrl = jest.fn().mockResolvedValue({
      id: 'server-1',
      base_url: 'https://ci.example.com',
    });
    process.env.PUBLIC_API_URL = 'https://api.example.com';
    service = new TestAutomationCiVariablesService(
      {
        assertAvailable: jest.fn().mockResolvedValue(undefined),
      } as unknown as TestManagementAccessService,
      { get } as unknown as TestAutomationConfigsService,
      {
        ciConnection: jest.fn().mockResolvedValue({
          state: 'connected',
          match: { repository: { web_url: 'https://github.com/acme/tests/' } },
        }),
        actionsAccess: jest.fn().mockResolvedValue(GITHUB_ACCESS),
        gitlabCiConnection: jest.fn().mockResolvedValue({
          repository: { external_id: '42' },
          connection: {},
          app: { apiUrl: API },
        }),
        gitlabToken: jest.fn().mockResolvedValue('gitlab-access-token'),
      } as unknown as TestAutomationGitService,
      {
        findForJobUrl,
        authorizationFor: jest.fn().mockReturnValue('Basic dXNlcjp0b2tlbg=='),
      } as unknown as CiServersService,
      { create, list, revoke } as unknown as TestManagementApiKeysService,
      { logActionForRequest: audit } as unknown as AuditLogsService,
    );
  });

  afterAll(() => {
    delete process.env.PUBLIC_API_URL;
  });

  it('writes the address and then the masked key as GitLab project variables', async () => {
    send.mockResolvedValue({ status: 201, body: '{}' });

    await expect(
      service.send(user, SPACE, JOB_ID, { expires_in_days: 30 }),
    ).resolves.toEqual({
      provider: 'gitlab',
      written: ['XISUITE_URL', 'XISUITE_TM_KEY'],
      skipped: [],
      api_key: {
        id: 'key-new',
        name: 'CI · Nightly · 12345678',
        token_prefix: 'xis_tm_aaaa',
        expires_at: '2027-02-01T00:00:00Z',
      },
      previous: { revoked: 1, kept: [] },
    });
    expect(create).toHaveBeenCalledWith(user, {
      expires_in_days: 30,
      name: 'CI · Nightly · 12345678',
    });
    expect(sent(0)[0]).toBe(`${API}/projects/42/variables`);
    expect(JSON.parse(sent(0)[3])).toMatchObject({
      key: 'XISUITE_URL',
      value: 'https://api.example.com',
      masked: false,
    });
    expect(JSON.parse(sent(1)[3])).toEqual({
      key: 'XISUITE_TM_KEY',
      value: TOKEN,
      masked: true,
      protected: false,
      variable_type: 'env_var',
      environment_scope: '*',
    });
    expect(sent(1)[2]).toMatchObject({
      authorization: 'Bearer gitlab-access-token',
      'content-type': 'application/json',
    });
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(user, 'key-old');
    expect(JSON.stringify(audit.mock.calls)).not.toContain(TOKEN);
    expect(audit).toHaveBeenCalledWith(
      user,
      'test_automation_config',
      JOB_ID,
      'update',
      expect.objectContaining({
        event: 'ci_variables_sent',
        written: ['XISUITE_URL', 'XISUITE_TM_KEY'],
      }) as object,
    );
  });

  it('updates a GitLab variable that already exists', async () => {
    send
      .mockResolvedValueOnce({ status: 201, body: '{}' })
      .mockResolvedValueOnce({
        status: 400,
        body: '{"message":{"key":["(XISUITE_TM_KEY) has already been taken"]}}',
      })
      .mockResolvedValueOnce({ status: 200, body: '{}' });

    await expect(service.send(user, SPACE, JOB_ID, {})).resolves.toMatchObject({
      written: ['XISUITE_URL', 'XISUITE_TM_KEY'],
    });
    expect(sent(2)[0]).toBe(
      `${API}/projects/42/variables/XISUITE_TM_KEY?filter%5Benvironment_scope%5D=*`,
    );
    expect(sent(2)[1]).toBe('PUT');
    expect(JSON.parse(sent(2)[3])).toEqual({
      value: TOKEN,
      masked: true,
      protected: false,
    });
  });

  it('skips the address when this server has none', async () => {
    delete process.env.PUBLIC_API_URL;
    delete process.env.APP_URL;
    send.mockResolvedValue({ status: 201, body: '{}' });

    await expect(service.send(user, SPACE, JOB_ID, {})).resolves.toMatchObject({
      written: ['XISUITE_TM_KEY'],
      skipped: [expect.objectContaining({ name: 'XISUITE_URL' })],
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('revokes the new key and names the Maintainer role when GitLab refuses', async () => {
    send.mockResolvedValue({ status: 403, body: TOKEN });

    const error = (await service
      .send(user, SPACE, JOB_ID, {})
      .catch((reason: unknown) => reason)) as ConflictException;

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({
      code: 'CI_SECRET_WRITE_REFUSED',
      message: expect.stringContaining('Maintainer') as string,
    });
    expect(JSON.stringify(error.getResponse())).not.toContain(TOKEN);
    expect(revoke).toHaveBeenCalledWith(user, 'key-new');
    expect(list).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('says so when GitLab will not mask the value', async () => {
    send
      .mockResolvedValueOnce({ status: 201, body: '{}' })
      .mockResolvedValueOnce({
        status: 400,
        body: '{"message":{"value":["cannot be masked"]}}',
      });

    await expect(service.send(user, SPACE, JOB_ID, {})).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'CI_SECRET_WRITE_REFUSED',
        message: expect.stringContaining('mask') as string,
      }) as object,
    });
    expect(revoke).toHaveBeenCalledWith(user, 'key-new');
  });

  it('creates the Jenkins system credential and reads it back', async () => {
    get.mockResolvedValue(jenkinsJob);
    read
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    send.mockResolvedValue({ status: 302, body: '' });

    await expect(service.send(user, SPACE, JOB_ID, {})).resolves.toMatchObject({
      provider: 'jenkins',
      written: ['xisuite-tm-key'],
      skipped: [expect.objectContaining({ name: 'XISUITE_URL' })],
    });
    expect((read.mock.calls as unknown[][])[0][1]).toBe(
      `${JENKINS}/credential/xisuite-tm-key/api/json`,
    );
    expect(sent(0)[0]).toBe(`${JENKINS}/createCredentials`);
    expect(sent(0)[2]).toMatchObject({
      authorization: 'Basic dXNlcjp0b2tlbg==',
      'content-type': 'application/x-www-form-urlencoded',
    });

    const form = JSON.parse(
      new URLSearchParams(sent(0)[3]).get('json') ?? '',
    ) as { credentials: Record<string, string> };

    expect(form.credentials).toMatchObject({
      scope: 'GLOBAL',
      id: 'xisuite-tm-key',
      secret: TOKEN,
      $class:
        'org.jenkinsci.plugins.plaincredentials.impl.StringCredentialsImpl',
    });
  });

  it('updates an existing Jenkins credential with its config.xml', async () => {
    get.mockResolvedValue(jenkinsJob);
    read.mockResolvedValue(new Response(null, { status: 200 }));
    send.mockResolvedValue({ status: 200, body: '' });

    await expect(service.send(user, SPACE, JOB_ID, {})).resolves.toMatchObject({
      written: ['xisuite-tm-key'],
    });
    expect(sent(0)[0]).toBe(`${JENKINS}/credential/xisuite-tm-key/config.xml`);
    expect(sent(0)[2]).toMatchObject({ 'content-type': 'application/xml' });
    expect(sent(0)[3]).toContain(`<secret>${TOKEN}</secret>`);
  });

  it.each([
    ['refused', 403, 'CI_SECRET_WRITE_REFUSED'],
    ['broken', 500, 'CI_TOOL_UNAVAILABLE'],
  ])('revokes the new key when Jenkins is %s', async (_label, status, code) => {
    get.mockResolvedValue(jenkinsJob);
    read.mockResolvedValue(new Response(null, { status: 404 }));
    send.mockResolvedValue({ status, body: '' });

    await expect(service.send(user, SPACE, JOB_ID, {})).rejects.toMatchObject({
      response: expect.objectContaining({ code }) as object,
    });
    expect(revoke).toHaveBeenCalledWith(user, 'key-new');
  });

  it('writes the address and then the key as GitHub repository variables', async () => {
    get.mockResolvedValue(githubJob);

    const result = await service.send(user, SPACE, JOB_ID, {});

    expect(result).toMatchObject({
      provider: 'github',
      written: ['XISUITE_URL', 'XISUITE_TM_KEY'],
      skipped: [],
      manual_url: 'https://github.com/acme/tests/settings/variables/actions',
    });
    expect(result).not.toHaveProperty('token');
    expect(putVariable.mock.calls).toEqual([
      [GITHUB_ACCESS, 'XISUITE_URL', 'https://api.example.com'],
      [GITHUB_ACCESS, 'XISUITE_TM_KEY', TOKEN],
    ]);
    expect(send).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith(user, 'key-old');
  });

  it('writes only the key to GitHub when the server address is not set', async () => {
    get.mockResolvedValue(githubJob);
    delete process.env.PUBLIC_API_URL;

    await expect(service.send(user, SPACE, JOB_ID, {})).resolves.toMatchObject({
      written: ['XISUITE_TM_KEY'],
      skipped: [
        {
          name: 'XISUITE_URL',
          reason: 'The server address is not set on this server',
        },
      ],
    });
  });

  it.each([403, 404])(
    'removes the new key and asks for the GitHub permission when GitHub answers %s',
    async (status) => {
      get.mockResolvedValue(githubJob);
      putVariable.mockResolvedValueOnce(201).mockResolvedValueOnce(status);

      await expect(service.send(user, SPACE, JOB_ID, {})).rejects.toMatchObject(
        {
          response: expect.objectContaining({
            code: 'CI_SECRET_WRITE_REFUSED',
            message: expect.stringContaining(
              'Variables: Read and write',
            ) as string,
          }) as object,
        },
      );
      expect(revoke).toHaveBeenCalledWith(user, 'key-new');
      expect(revoke).not.toHaveBeenCalledWith(user, 'key-old');
    },
  );

  it('keeps the old key when GitHub cannot be reached', async () => {
    get.mockResolvedValue(githubJob);
    putVariable.mockRejectedValue(new Error('GitHub could not be reached'));

    await expect(service.send(user, SPACE, JOB_ID, {})).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'CI_TOOL_UNAVAILABLE',
      }) as object,
    });
    expect(revoke).toHaveBeenCalledWith(user, 'key-new');
    expect(revoke).not.toHaveBeenCalledWith(user, 'key-old');
  });

  it('refuses a job without a connection before any key exists', async () => {
    get.mockResolvedValue(job(undefined));

    await expect(service.send(user, SPACE, JOB_ID, {})).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'NOT_CONNECTED' }) as object,
    });

    findForJobUrl.mockResolvedValue(null);
    get.mockResolvedValue(jenkinsJob);

    await expect(service.send(user, SPACE, JOB_ID, {})).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'NOT_CONNECTED' }) as object,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ['an archived job', { archived_at: '2026-11-01T00:00:00Z' }, 'ARCHIVED'],
    ['a runner setting', { kind: 'docker' }, 'NOT_A_CI_JOB'],
  ] as [string, Partial<TestAutomationConfig>, string][])(
    'refuses %s',
    async (_label, overrides, code) => {
      get.mockResolvedValue({ ...gitlabJob, ...overrides });

      await expect(service.send(user, SPACE, JOB_ID, {})).rejects.toMatchObject(
        {
          response: expect.objectContaining({ code }) as object,
        },
      );
      expect(create).not.toHaveBeenCalled();
    },
  );

  it('refuses a second send while one is running', async () => {
    let finish: (value: { status: number; body: string }) => void = () =>
      undefined;

    send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    send.mockResolvedValue({ status: 201, body: '{}' });

    const first = service.send(user, SPACE, JOB_ID, {});

    await new Promise((resolve) => setImmediate(resolve));
    await expect(service.send(user, SPACE, JOB_ID, {})).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'IN_PROGRESS' }) as object,
    });
    finish({ status: 201, body: '{}' });
    await expect(first).resolves.toMatchObject({ provider: 'gitlab' });
    await expect(service.send(user, SPACE, JOB_ID, {})).resolves.toMatchObject({
      provider: 'gitlab',
    });
  });

  it('keeps the key name within 100 characters', async () => {
    send.mockResolvedValue({ status: 201, body: '{}' });
    get.mockResolvedValue({ ...gitlabJob, name: 'x'.repeat(200) });

    await service.send(user, SPACE, JOB_ID, {});

    const name = (create.mock.calls as [RequestUser, { name: string }][])[0][1]
      .name;

    expect(name).toHaveLength(100);
    expect(name.endsWith(' · 12345678')).toBe(true);
  });

  it('names the owner of an earlier key the caller may not revoke', async () => {
    send.mockResolvedValue({ status: 201, body: '{}' });
    list.mockResolvedValue([
      {
        id: 'key-old',
        name: 'CI · Nightly · 12345678',
        owner: { id: 'u2', email: 'b@example.com', name: 'Bea' },
      },
    ]);
    revoke.mockRejectedValue(new NotFoundException());

    await expect(service.send(user, SPACE, JOB_ID, {})).resolves.toMatchObject({
      previous: { revoked: 0, kept: ['Bea'] },
    });
  });

  describe('a key saved from the API keys card', () => {
    const TARGET = 'abcdef12-aaaa-bbbb-cccc-123456789012';
    let git: Record<string, jest.Mock>;
    let servers: Record<string, jest.Mock>;
    let card: TestAutomationCiVariablesService;

    beforeEach(() => {
      git = {
        connectedRepositories: jest.fn().mockResolvedValue([
          { id: 'r1', provider: 'github', full_name: 'acme/app' },
          { id: 'r2', provider: 'gitlab', full_name: 'qa/app' },
          { id: 'r3', provider: 'azure_devops', full_name: 'az/app' },
        ]),
        externalIntegrationsLicensed: jest.fn().mockResolvedValue(true),
        findRepositoryById: jest.fn().mockResolvedValue({
          state: 'connected',
          repository: {
            full_name: 'acme/app',
            web_url: 'https://github.com/acme/app',
          },
        }),
        actionsAccess: jest.fn().mockResolvedValue(GITHUB_ACCESS),
        gitlabRepositoryById: jest.fn().mockResolvedValue({
          repository: { external_id: '77', full_name: 'qa/app' },
          connection: {},
          app: { apiUrl: API },
        }),
        gitlabToken: jest.fn().mockResolvedValue('gitlab-access-token'),
      };
      servers = {
        listForOrg: jest
          .fn()
          .mockResolvedValue([{ id: 's1', name: 'Local Jenkins' }]),
        rowFor: jest.fn().mockResolvedValue({
          id: TARGET,
          name: 'Local Jenkins',
          base_url: 'https://ci.example.com',
        }),
        authorizationFor: jest.fn().mockReturnValue('Basic dXNlcjp0b2tlbg=='),
      };
      list.mockResolvedValue([
        { id: 'key-new', name: 'CI · qa/app · abcdef12' },
        { id: 'key-card-old', name: 'CI · qa/app · abcdef12' },
        { id: 'key-job', name: 'CI · Nightly · 12345678' },
      ]);
      card = new TestAutomationCiVariablesService(
        {
          assertAvailable: jest.fn(),
        } as unknown as TestManagementAccessService,
        { get } as unknown as TestAutomationConfigsService,
        git as unknown as TestAutomationGitService,
        servers as unknown as CiServersService,
        { create, list, revoke } as unknown as TestManagementApiKeysService,
        { logActionForRequest: audit } as unknown as AuditLogsService,
      );
    });

    it('lists only GitHub and GitLab repositories, and Jenkins servers when licensed', async () => {
      await expect(card.targets(ORG)).resolves.toEqual({
        repositories: [
          { id: 'r1', provider: 'github', full_name: 'acme/app' },
          { id: 'r2', provider: 'gitlab', full_name: 'qa/app' },
        ],
        servers: [{ id: 's1', name: 'Local Jenkins' }],
      });

      git.externalIntegrationsLicensed.mockResolvedValue(false);

      await expect(card.targets(ORG)).resolves.toMatchObject({ servers: [] });
      expect(servers.listForOrg).toHaveBeenCalledTimes(1);
    });

    it('leaves out targets that already hold an active key from this card', async () => {
      git.connectedRepositories.mockResolvedValue([
        { id: 'aaaaaaaa-1111', provider: 'github', full_name: 'acme/app' },
        { id: 'bbbbbbbb-2222', provider: 'gitlab', full_name: 'qa/app' },
        { id: 'cccccccc-3333', provider: 'github', full_name: 'acme/old' },
      ]);
      servers.listForOrg.mockResolvedValue([
        { id: 'dddddddd-4444', name: 'Local Jenkins' },
        { id: 'eeeeeeee-5555', name: 'Other Jenkins' },
      ]);
      list.mockResolvedValue([
        { id: 'k1', name: 'CI · acme/app · aaaaaaaa', expired: false },
        { id: 'k2', name: 'CI · acme/old · cccccccc', expired: true },
        { id: 'k3', name: 'CI · Local Jenkins · dddddddd', expired: false },
        { id: 'k4', name: 'Laptop · bbbbbbbb', expired: false },
      ]);

      await expect(card.targets(ORG, user)).resolves.toEqual({
        repositories: [
          { id: 'bbbbbbbb-2222', provider: 'gitlab', full_name: 'qa/app' },
          { id: 'cccccccc-3333', provider: 'github', full_name: 'acme/old' },
        ],
        servers: [{ id: 'eeeeeeee-5555', name: 'Other Jenkins' }],
      });
      expect(list).toHaveBeenCalledWith(user, true);
    });

    it('offers every target when the keys cannot be listed', async () => {
      list.mockRejectedValue(new Error('database down'));

      await expect(card.targets(ORG, user)).resolves.toMatchObject({
        repositories: [{ id: 'r1' }, { id: 'r2' }],
        servers: [{ id: 's1' }],
      });
    });

    it('saves a GitLab key named after the project and rotates only its own earlier card key', async () => {
      send.mockResolvedValue({ status: 201, body: '{}' });

      await expect(
        card.sendToTarget(user, {
          provider: 'gitlab',
          target_id: TARGET,
          expires_in_days: 30,
        }),
      ).resolves.toMatchObject({
        provider: 'gitlab',
        written: ['XISUITE_URL', 'XISUITE_TM_KEY'],
        previous: { revoked: 1, kept: [] },
      });
      expect(git.gitlabRepositoryById).toHaveBeenCalledWith(ORG, TARGET);
      expect(create).toHaveBeenCalledWith(user, {
        expires_in_days: 30,
        name: 'CI · qa/app · abcdef12',
      });
      expect(sent(1)[0]).toBe(`${API}/projects/77/variables`);
      expect(revoke).toHaveBeenCalledWith(user, 'key-card-old');
      expect(revoke).not.toHaveBeenCalledWith(user, 'key-job');
      expect(JSON.stringify(audit.mock.calls)).not.toContain(TOKEN);
      expect(audit).toHaveBeenCalledWith(
        user,
        'test_management_api_key',
        'key-new',
        'create',
        expect.objectContaining({
          event: 'ci_key_saved',
          target_id: TARGET,
        }) as object,
      );
    });

    it('saves the Jenkins credential on the picked server', async () => {
      read
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(new Response(null, { status: 200 }));
      send.mockResolvedValue({ status: 302, body: '' });

      await expect(
        card.sendToTarget(user, { provider: 'jenkins', target_id: TARGET }),
      ).resolves.toMatchObject({
        provider: 'jenkins',
        written: ['xisuite-tm-key'],
      });
      expect(servers.rowFor).toHaveBeenCalledWith(ORG, TARGET);
      expect(sent(0)[0]).toBe(`${JENKINS}/createCredentials`);
      expect(create).toHaveBeenCalledWith(user, {
        name: 'CI · Local Jenkins · abcdef12',
      });
    });

    it('saves the key in the picked GitHub repository as a variable', async () => {
      await expect(
        card.sendToTarget(user, { provider: 'github', target_id: TARGET }),
      ).resolves.toMatchObject({
        provider: 'github',
        written: ['XISUITE_URL', 'XISUITE_TM_KEY'],
        manual_url: 'https://github.com/acme/app/settings/variables/actions',
      });
      expect(git.actionsAccess).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'connected' }),
      );
      expect(send).not.toHaveBeenCalled();
    });

    it.each([
      ['an unknown GitHub repository', 'github', 'findRepositoryById'],
      ['an unusable GitLab project', 'gitlab', 'gitlabRepositoryById'],
      ['a Jenkins server of another organization', 'jenkins', 'rowFor'],
      ['Jenkins without the licence', 'jenkins', 'licence'],
    ] as const)(
      'refuses %s before any key exists',
      async (_label, provider, missing) => {
        if (missing === 'findRepositoryById') {
          git.findRepositoryById.mockResolvedValue({ state: 'none' });
        } else if (missing === 'gitlabRepositoryById') {
          git.gitlabRepositoryById.mockResolvedValue(null);
        } else if (missing === 'rowFor') {
          servers.rowFor.mockResolvedValue(null);
        } else {
          git.externalIntegrationsLicensed.mockResolvedValue(false);
        }

        await expect(
          card.sendToTarget(user, { provider, target_id: TARGET }),
        ).rejects.toMatchObject({
          response: expect.objectContaining({
            code: 'NOT_CONNECTED',
          }) as object,
        });
        expect(create).not.toHaveBeenCalled();
      },
    );

    it('revokes the new key and keeps the earlier one when GitLab refuses', async () => {
      send.mockResolvedValue({ status: 403, body: '' });

      await expect(
        card.sendToTarget(user, { provider: 'gitlab', target_id: TARGET }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'CI_SECRET_WRITE_REFUSED',
        }) as object,
      });
      expect(revoke).toHaveBeenCalledWith(user, 'key-new');
      expect(revoke).not.toHaveBeenCalledWith(user, 'key-card-old');
    });

    it('refuses a second save for the same target while one is running', async () => {
      let finish: (value: { status: number; body: string }) => void = () =>
        undefined;

      send.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      send.mockResolvedValue({ status: 201, body: '{}' });

      const first = card.sendToTarget(user, {
        provider: 'gitlab',
        target_id: TARGET,
      });

      await new Promise((resolve) => setImmediate(resolve));
      await expect(
        card.sendToTarget(user, { provider: 'gitlab', target_id: TARGET }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'IN_PROGRESS' }) as object,
      });
      finish({ status: 201, body: '{}' });
      await expect(first).resolves.toMatchObject({ provider: 'gitlab' });
    });
  });
});
