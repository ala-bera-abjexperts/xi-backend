/**
 * @fileoverview Unit tests for GitIntegrationsHealthCron: health checks per provider (also without a
 * built-in app, ticket 11), the own-server checks, and the first-connection pull request import (claim,
 * sync each, give back on failure).
 * @module src/git-integrations/git-integrations-health.cron.spec
 */

import { GitIntegrationsHealthCron } from './git-integrations-health.cron';

function setup() {
  const github = {
    provider: 'github',
    isConfigured: jest.fn().mockReturnValue(true),
    checkHealth: jest.fn().mockResolvedValue(undefined),
    listRecentPullRequests: jest
      .fn()
      .mockResolvedValue([{ number: 1 }, { number: 2 }]),
    listKeyBranches: jest
      .fn()
      .mockResolvedValue([{ name: 'XE-T1-x', pushedAt: null }]),
  };
  const gitlab = {
    provider: 'gitlab',
    isConfigured: jest.fn().mockReturnValue(false),
    checkHealth: jest.fn().mockResolvedValue(undefined),
    listRecentPullRequests: jest.fn(),
  };
  const serverTests = { checkServers: jest.fn().mockResolvedValue(undefined) };
  const core = { pruneDeliveries: jest.fn().mockResolvedValue(undefined) };
  const providers = {
    all: () => [github, gitlab],
    get: (name: string) => (name === 'github' ? github : gitlab),
  };
  const pullRequests = {
    claimBackfill: jest.fn().mockResolvedValue([]),
    sync: jest.fn().mockResolvedValue({}),
    syncBranch: jest.fn().mockResolvedValue(undefined),
    releaseBackfill: jest.fn().mockResolvedValue(undefined),
  };
  const cron = new GitIntegrationsHealthCron(
    core as never,
    providers as never,
    pullRequests as never,
    serverTests as never,
  );

  return { cron, github, gitlab, core, pullRequests, serverTests };
}

const claim = (id: string) => ({
  connection: { id: 'c' },
  repository: { id, provider: 'github' },
});

describe('GitIntegrationsHealthCron', () => {
  it('checks every provider (an own server needs no built-in app), the servers, imports claimed repositories, prunes deliveries', async () => {
    const { cron, github, gitlab, core, pullRequests, serverTests } = setup();

    pullRequests.claimBackfill.mockResolvedValue([claim('r1')]);

    await cron.run();

    expect(github.checkHealth).toHaveBeenCalled();
    expect(gitlab.checkHealth).toHaveBeenCalled();
    expect(serverTests.checkServers).toHaveBeenCalled();
    expect(pullRequests.claimBackfill).toHaveBeenCalledWith([
      'github',
      'gitlab',
    ]);

    const [, , since] = github.listRecentPullRequests.mock
      .calls[0] as unknown[];

    expect(Date.now() - (since as Date).getTime()).toBeGreaterThanOrEqual(
      30 * 24 * 60 * 60 * 1000 - 1000,
    );
    expect(pullRequests.sync).toHaveBeenCalledTimes(2);
    expect(pullRequests.releaseBackfill).not.toHaveBeenCalled();
    expect(core.pruneDeliveries).toHaveBeenCalled();
  });

  it('a failed import gives that repository back and continues with the next', async () => {
    const { cron, github, pullRequests } = setup();

    pullRequests.claimBackfill.mockResolvedValue([claim('r1'), claim('r2')]);
    github.listRecentPullRequests.mockRejectedValueOnce(
      new Error('rate limited'),
    );

    await cron.run();

    expect(pullRequests.releaseBackfill).toHaveBeenCalledWith({
      id: 'r1',
      provider: 'github',
    });
    expect(pullRequests.sync).toHaveBeenCalledTimes(2);
  });

  it('a failing claim query never stops the delivery prune', async () => {
    const { cron, core, pullRequests } = setup();

    pullRequests.claimBackfill.mockRejectedValue(new Error('db down'));

    await cron.run();

    expect(core.pruneDeliveries).toHaveBeenCalled();
  });

  it('also imports branches named after a task (ticket 5)', async () => {
    const { cron, pullRequests } = setup();

    pullRequests.claimBackfill.mockResolvedValue([claim('r1')]);

    await cron.run();

    expect(pullRequests.syncBranch).toHaveBeenCalledWith(
      { id: 'r1', provider: 'github' },
      'XE-T1-x',
      null,
      false,
    );
  });
});
