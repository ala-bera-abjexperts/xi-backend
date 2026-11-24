import { ConflictException } from '@nestjs/common';

import type { AuditLogsService } from '../../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../../auth/interfaces/request-user.interface';
import { GithubApiError } from '../../../git-integrations/github/github-app.client';
import type { PermissionsService } from '../../../permissions/permissions.service';
import type { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import type { TestManagementAccessService } from '../../access/test-management-access.service';
import { TestAutomationConfigsService } from '../test-automation-configs.service';
import {
  GitlabConnectionError,
  type TestAutomationGitService,
} from '../test-automation-git.service';
import { GithubActionsError } from '../test-automation-github.client';

const SPACE = 'space-1';
const REPO = 'repo-1';
const user = { userId: 'user-1', organizationId: 'org-1' } as RequestUser;

describe('TestAutomationConfigsService, repository APIs', () => {
  const assertAvailable = jest.fn();
  const log = jest.fn();
  const findRepositoryById = jest.fn();
  const actionsAccess = jest.fn();
  const branchNames = jest.fn();
  const send = jest.fn();
  const realFetch = global.fetch;

  const service = new TestAutomationConfigsService(
    {} as unknown as SupabaseAdminService,
    { assertAvailable } as unknown as TestManagementAccessService,
    { logActionForRequest: log } as unknown as AuditLogsService,
    {} as unknown as PermissionsService,
    {
      findRepositoryById,
      actionsAccess,
      branchNames,
    } as unknown as TestAutomationGitService,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    assertAvailable.mockResolvedValue(undefined);
    findRepositoryById.mockResolvedValue({
      state: 'connected',
      repository: { full_name: 'acme/tests' },
    });
    actionsAccess.mockResolvedValue({
      apiUrl: 'https://api.github.com',
      fullName: 'acme/tests',
      token: 'ghs_token',
    });
    global.fetch = send as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  describe('repositoryBranches', () => {
    it('reads through the connection, for this organization only', async () => {
      branchNames.mockResolvedValue(['main']);

      await expect(
        service.repositoryBranches(user, SPACE, REPO),
      ).resolves.toEqual(['main']);
      expect(assertAvailable).toHaveBeenCalledWith('org-1', SPACE, {
        write: false,
      });
      expect(findRepositoryById).toHaveBeenCalledWith('org-1', REPO);
    });

    it('refuses a repository that is not connected, without calling GitHub', async () => {
      findRepositoryById.mockResolvedValue({ state: 'none' });

      await expect(
        service.repositoryBranches(user, SPACE, REPO),
      ).rejects.toMatchObject({
        status: 400,
        response: { field: 'ci_repository_id' },
      });
      expect(branchNames).not.toHaveBeenCalled();
    });

    it('does not look up the repository when the space is refused', async () => {
      assertAvailable.mockRejectedValue(new ConflictException('off'));

      await expect(
        service.repositoryBranches(user, SPACE, REPO),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(findRepositoryById).not.toHaveBeenCalled();
    });

    it.each([
      ['a 401 from GitHub', new GithubApiError(401, 'bad token')],
      ['a 403 from GitHub', new GithubApiError(403, 'no permission')],
      ['a network failure', new TypeError('fetch failed')],
    ])('turns %s into our own 503', async (_name, failure) => {
      branchNames.mockRejectedValue(failure);

      await expect(
        service.repositoryBranches(user, SPACE, REPO),
      ).rejects.toMatchObject({
        status: 503,
        response: { code: 'GITHUB_UNAVAILABLE' },
      });
    });
  });

  describe('repositoryWorkflowFiles', () => {
    it('lists the files', async () => {
      send.mockResolvedValue(
        new Response(JSON.stringify([{ name: 'tests.yml', type: 'file' }]), {
          status: 200,
        }),
      );

      await expect(
        service.repositoryWorkflowFiles(user, SPACE, REPO),
      ).resolves.toEqual(['tests.yml']);
    });

    it('turns a failed token request into our own 503', async () => {
      actionsAccess.mockRejectedValue(new GithubApiError(401, 'bad key'));

      await expect(
        service.repositoryWorkflowFiles(user, SPACE, REPO),
      ).rejects.toMatchObject({ status: 503 });
    });
  });

  describe.each([
    [
      'createRepositoryWorkflowFile',
      'create',
      201,
      (body = { content: 'on: workflow_dispatch' }, name = 'tests.yml') =>
        service.createRepositoryWorkflowFile(user, SPACE, REPO, {
          file_name: name,
          ...body,
        }),
    ],
    [
      'updateRepositoryWorkflowFile',
      'update',
      200,
      (body = { content: 'on: workflow_dispatch' }, name = 'tests.yml') =>
        service.updateRepositoryWorkflowFile(user, SPACE, REPO, name, {
          sha: 'a'.repeat(40),
          ...body,
        }),
    ],
  ] as const)('%s', (_method, action, okStatus, write) => {
    it('commits, audits and names the file', async () => {
      send.mockResolvedValue(new Response('{}', { status: okStatus }));

      await expect(write()).resolves.toEqual({ id: REPO, name: 'tests.yml' });
      expect(assertAvailable).toHaveBeenCalledWith('org-1', SPACE, {
        write: true,
      });
      expect(log).toHaveBeenCalledWith(
        user,
        'test_automation_workflow_file',
        REPO,
        action,
        {
          file_name: 'tests.yml',
          repository: 'acme/tests',
          space_id: SPACE,
        },
      );
    });

    it.each([[403], [404], [422]])(
      'reads a %s from GitHub as refused, never as the person lacking rights',
      async (status) => {
        send.mockResolvedValue(new Response('{}', { status }));

        await expect(write()).rejects.toMatchObject({
          status: 409,
          response: { code: 'GITHUB_WRITE_REFUSED' },
        });
        expect(log).not.toHaveBeenCalled();
      },
    );

    it.each([[401], [429], [500]])(
      'reads a %s from GitHub as unavailable, so nobody is signed out',
      async (status) => {
        send.mockResolvedValue(new Response(null, { status }));

        await expect(write()).rejects.toMatchObject({
          status: 503,
          response: { code: 'GITHUB_UNAVAILABLE' },
        });
      },
    );

    it('reads a network failure as unavailable', async () => {
      send.mockRejectedValue(new TypeError('fetch failed'));

      await expect(write()).rejects.toMatchObject({ status: 503 });
    });

    it('reads a refused token request as refused', async () => {
      actionsAccess.mockRejectedValue(new GithubApiError(403, 'suspended'));

      await expect(write()).rejects.toMatchObject({
        response: { code: 'GITHUB_WRITE_REFUSED' },
      });
    });

    it.each([
      ['no workflow_dispatch', 'on: push'],
      ['workflow_dispatch only in a comment', '# workflow_dispatch\non: push'],
      ['content over 64 KB', `on: workflow_dispatch\n${'x'.repeat(65_536)}`],
    ])('refuses %s before calling GitHub', async (_name, content) => {
      await expect(write({ content })).rejects.toMatchObject({
        status: 400,
        response: { field: 'content' },
      });
      expect(send).not.toHaveBeenCalled();
    });

    it.each([['../secrets.yml'], ['a.txt']])(
      'refuses the name %s before calling GitHub',
      async (name) => {
        await expect(write(undefined, name)).rejects.toMatchObject({
          status: 400,
          response: { field: 'ci_workflow' },
        });
        expect(send).not.toHaveBeenCalled();
      },
    );

    it('commits nothing when the space is read-only', async () => {
      assertAvailable.mockRejectedValue(new ConflictException('read only'));

      await expect(write()).rejects.toBeInstanceOf(ConflictException);
      expect(send).not.toHaveBeenCalled();
    });

    it('refuses a repository that is not connected', async () => {
      findRepositoryById.mockResolvedValue({ state: 'none' });

      await expect(write()).rejects.toMatchObject({ status: 400 });
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('createRepositoryWorkflowFile, an existing name', () => {
    it('says the file exists, without an audit entry', async () => {
      send.mockResolvedValue(
        new Response('{"message":"sha was not supplied."}', { status: 422 }),
      );

      await expect(
        service.createRepositoryWorkflowFile(user, SPACE, REPO, {
          file_name: 'tests.yml',
          content: 'on: workflow_dispatch',
        }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'WORKFLOW_FILE_EXISTS' },
      });
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('updateRepositoryWorkflowFile, a changed file', () => {
    it('says the file changed, without an audit entry', async () => {
      send.mockResolvedValue(new Response('{}', { status: 409 }));

      await expect(
        service.updateRepositoryWorkflowFile(user, SPACE, REPO, 'tests.yml', {
          content: 'on: workflow_dispatch',
          sha: 'a'.repeat(40),
        }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'WORKFLOW_FILE_CHANGED' },
      });
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('repositoryWorkflowFile', () => {
    const read = (name = 'tests.yml') =>
      service.repositoryWorkflowFile(user, SPACE, REPO, name);
    const answer = (extra: Record<string, unknown> = {}) =>
      new Response(
        JSON.stringify({
          type: 'file',
          size: 21,
          encoding: 'base64',
          content: Buffer.from('on: workflow_dispatch').toString('base64'),
          sha: 'abc',
          ...extra,
        }),
        { status: 200 },
      );

    it('returns the text and its version', async () => {
      send.mockResolvedValue(answer());

      await expect(read()).resolves.toEqual({
        id: REPO,
        name: 'tests.yml',
        content: 'on: workflow_dispatch',
        sha: 'abc',
      });
    });

    it('says when the file is gone', async () => {
      send.mockResolvedValue(new Response(null, { status: 404 }));

      await expect(read()).rejects.toMatchObject({
        status: 404,
        response: { code: 'WORKFLOW_FILE_NOT_FOUND' },
      });
    });

    it('says when the file cannot be opened here', async () => {
      send.mockResolvedValue(answer({ size: 70_000 }));

      await expect(read()).rejects.toMatchObject({
        status: 409,
        response: { code: 'WORKFLOW_FILE_UNREADABLE' },
      });
    });

    it('refuses a path before calling GitHub', async () => {
      await expect(read('../secrets.yml')).rejects.toMatchObject({
        status: 400,
      });
      expect(send).not.toHaveBeenCalled();
    });

    it('reads a 403 from GitHub as unavailable, never as the person lacking rights', async () => {
      send.mockResolvedValue(new Response(null, { status: 403 }));

      await expect(read()).rejects.toMatchObject({
        status: 503,
        response: { code: 'GITHUB_UNAVAILABLE' },
      });
    });
  });

  describe('a GitLab project from the list', () => {
    const gitlabRepositoryById = jest.fn();
    const gitlabBranchNames = jest.fn();
    const gitlabMatch = {
      repository: { id: REPO, full_name: 'group/app', external_id: '42' },
      app: { apiUrl: 'https://gitlab.example.com/api/v4' },
    };
    const withGitlab = new TestAutomationConfigsService(
      {} as unknown as SupabaseAdminService,
      { assertAvailable } as unknown as TestManagementAccessService,
      { logActionForRequest: log } as unknown as AuditLogsService,
      {} as unknown as PermissionsService,
      {
        findRepositoryById,
        branchNames,
        gitlabRepositoryById,
        gitlabBranchNames,
      } as unknown as TestAutomationGitService,
    );

    beforeEach(() => {
      assertAvailable.mockResolvedValue(undefined);
      findRepositoryById.mockResolvedValue({ state: 'none' });
      gitlabRepositoryById.mockResolvedValue(gitlabMatch);
    });

    it('lists its branches through the GitLab connection', async () => {
      gitlabBranchNames.mockResolvedValue(['main', 'dev']);

      await expect(
        withGitlab.repositoryBranches(user, SPACE, REPO),
      ).resolves.toEqual(['main', 'dev']);
      expect(gitlabRepositoryById).toHaveBeenCalledWith('org-1', REPO);
      expect(gitlabBranchNames).toHaveBeenCalledWith(gitlabMatch);
      expect(branchNames).not.toHaveBeenCalled();
    });

    it.each([
      ['a sign-in that needs a reconnect', new GitlabConnectionError()],
      ['a 401 from GitLab', new GithubActionsError(401, 'GitLab answered 401')],
    ])('asks for a reconnect after %s', async (_name, failure) => {
      gitlabBranchNames.mockRejectedValue(failure);

      await expect(
        withGitlab.repositoryBranches(user, SPACE, REPO),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'GIT_CONNECTION_UNAVAILABLE' },
      });
    });

    it.each([
      ['a 403 from GitLab', new GithubActionsError(403, 'GitLab answered 403')],
      ['a network failure', new GithubActionsError(null, 'unreachable')],
    ])('turns %s into our own 503', async (_name, failure) => {
      gitlabBranchNames.mockRejectedValue(failure);

      await expect(
        withGitlab.repositoryBranches(user, SPACE, REPO),
      ).rejects.toMatchObject({
        status: 503,
        response: { code: 'GITLAB_UNAVAILABLE' },
      });
    });

    it('never sends the token to a plain http server', async () => {
      gitlabRepositoryById.mockResolvedValue({
        ...gitlabMatch,
        app: { apiUrl: 'http://gitlab.example.com/api/v4' },
      });

      await expect(
        withGitlab.repositoryBranches(user, SPACE, REPO),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: 'VALIDATION_FAILED', field: 'ci_repository_id' },
      });
      expect(gitlabBranchNames).not.toHaveBeenCalled();
    });

    it.each([
      ['list', () => withGitlab.repositoryWorkflowFiles(user, SPACE, REPO)],
      [
        'read',
        () => withGitlab.repositoryWorkflowFile(user, SPACE, REPO, 'a.yml'),
      ],
      [
        'create',
        () =>
          withGitlab.createRepositoryWorkflowFile(user, SPACE, REPO, {
            file_name: 'a.yml',
            content: 'on: workflow_dispatch',
          }),
      ],
    ])('refuses to %s workflow files of GitLab', async (_name, call) => {
      await expect(call()).rejects.toMatchObject({
        status: 400,
        response: { code: 'NOT_GITHUB' },
      });
      expect(send).not.toHaveBeenCalled();
    });

    it('keeps today’s answer when the GitLab lookup fails', async () => {
      gitlabRepositoryById.mockRejectedValue(new Error('database down'));

      await expect(
        withGitlab.repositoryBranches(user, SPACE, REPO),
      ).rejects.toMatchObject({
        status: 400,
        response: { field: 'ci_repository_id' },
      });
    });
  });
});
