/**
 * @fileoverview Unit tests for GitPullRequestsController.link: URL validation, provider and
 * repository checks, provider failures, and when a manual link (with history) is written.
 * @module src/git-integrations/git-pull-requests.controller.spec
 */

import {
  BadGatewayException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';

import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { GitProvidersRegistry } from './git-providers.registry';
import { GitPullRequestsController } from './git-pull-requests.controller';
import type { GitPullRequestsService } from './git-pull-requests.service';
import type { GitServersService } from './git-servers.service';

const TASK = '11111111-1111-4111-8111-111111111111';
const user = { userId: 'user-1', organizationId: 'org-1' } as RequestUser;
const URL_12 = 'https://github.com/acme/api/pull/12';

function setup() {
  const repository = { id: 'repo-1', full_name: 'acme/api' };
  const connection = { id: 'conn-1', status: 'active' };
  const pr = { number: 12, title: 't', url: URL_12 };
  const pullRequests = {
    assertTask: jest.fn().mockResolvedValue(undefined),
    assertRepositoryInSpace: jest.fn().mockResolvedValue(undefined),
    findLinkTarget: jest.fn().mockResolvedValue({ connection, repository }),
    linkState: jest.fn().mockResolvedValue(null),
    sync: jest.fn().mockResolvedValue({
      pullRequestId: 'pr-1',
      applied: true,
      linked: [TASK],
      removed: [],
    }),
    linkManual: jest.fn().mockResolvedValue(undefined),
  };
  const adapter = {
    isConfigured: jest.fn().mockReturnValue(true),
    fetchPullRequest: jest.fn().mockResolvedValue(pr),
  };
  const providers = { get: jest.fn().mockReturnValue(adapter) };
  const servers = { list: jest.fn().mockResolvedValue([]) };
  const controller = new GitPullRequestsController(
    pullRequests as unknown as GitPullRequestsService,
    providers as unknown as GitProvidersRegistry,
    servers as unknown as GitServersService,
  );

  return {
    controller,
    servers,
    pullRequests,
    adapter,
    providers,
    repository,
    connection,
    pr,
  };
}

describe('GitPullRequestsController.link', () => {
  it('rejects an address that is not a pull request (400 invalid_url) before any lookup', async () => {
    const { controller, pullRequests } = setup();

    await expect(
      controller.link(user, TASK, {
        url: 'https://github.com/acme/api/issues/1',
      }),
    ).rejects.toThrow(new BadRequestException('invalid_url'));
    expect(pullRequests.assertTask).not.toHaveBeenCalled();
  });

  it('links by hand even when the sync just auto-linked it (key in the title), with history', async () => {
    const { controller, pullRequests, adapter, repository, connection, pr } =
      setup();

    const result = await controller.link(user, TASK, { url: URL_12 });

    expect(pullRequests.assertTask).toHaveBeenCalledWith('org-1', TASK);
    expect(pullRequests.findLinkTarget).toHaveBeenCalledWith('org-1', {
      provider: 'github',
      host: 'github.com',
      fullName: 'acme/api',
      number: 12,
    });
    expect(adapter.fetchPullRequest).toHaveBeenCalledWith(
      connection,
      repository,
      12,
    );
    expect(pullRequests.sync).toHaveBeenCalledWith(repository, pr);
    expect(pullRequests.linkManual).toHaveBeenCalledWith(user, TASK, 'pr-1', {
      provider: 'github',
      repository: 'acme/api',
      repositoryId: 'repo-1',
      pr,
    });
    expect(result).toEqual({ linked: true });
  });

  it('already linked: refreshes the pull request but writes no manual link or history', async () => {
    const { controller, pullRequests } = setup();

    pullRequests.linkState.mockResolvedValue('linked');

    const result = await controller.link(user, TASK, { url: URL_12 });

    expect(pullRequests.sync).toHaveBeenCalled();
    expect(pullRequests.linkManual).not.toHaveBeenCalled();
    expect(result.linked).toBe(false);
  });

  it('re-links a pull request that was unlinked by hand', async () => {
    const { controller, pullRequests } = setup();

    pullRequests.linkState.mockResolvedValue('unlinked');

    await controller.link(user, TASK, { url: URL_12 });

    expect(pullRequests.linkManual).toHaveBeenCalled();
  });

  it('provider not configured -> repository_not_connected', async () => {
    const { controller, adapter, pullRequests } = setup();

    adapter.isConfigured.mockReturnValue(false);

    await expect(controller.link(user, TASK, { url: URL_12 })).rejects.toThrow(
      'repository_not_connected',
    );
    expect(pullRequests.findLinkTarget).not.toHaveBeenCalled();
  });

  it('a provider outage is a 502 provider_unavailable and nothing is written', async () => {
    const { controller, adapter, pullRequests } = setup();

    adapter.fetchPullRequest.mockRejectedValue(new Error('ETIMEDOUT'));

    await expect(controller.link(user, TASK, { url: URL_12 })).rejects.toThrow(
      new BadGatewayException('provider_unavailable'),
    );
    expect(pullRequests.sync).not.toHaveBeenCalled();
    expect(pullRequests.linkManual).not.toHaveBeenCalled();
  });

  it('passes the provider 404 through (pull_request_not_found)', async () => {
    const { controller, adapter } = setup();

    adapter.fetchPullRequest.mockRejectedValue(
      new NotFoundException('pull_request_not_found'),
    );

    await expect(controller.link(user, TASK, { url: URL_12 })).rejects.toThrow(
      'pull_request_not_found',
    );
  });

  it('ticket 11: an address on an own server (relative root, old address) is read with its host key', async () => {
    const { controller, pullRequests, adapter, servers } = setup();

    servers.list.mockResolvedValue([
      {
        host: 'company.com',
        base_url: 'https://code.company.com/gitlab',
        previous_base_urls: ['https://company.com/gitlab'],
      },
    ]);
    adapter.isConfigured.mockReturnValue(false); // the built-in app is irrelevant for own servers

    await controller.link(user, TASK, {
      url: 'https://company.com/gitlab/grp/app/-/merge_requests/3',
    });

    expect(servers.list).toHaveBeenCalledWith('org-1');
    expect(pullRequests.findLinkTarget).toHaveBeenCalledWith('org-1', {
      provider: 'gitlab',
      host: 'company.com',
      fullName: 'grp/app',
      number: 3,
    });
  });
});
