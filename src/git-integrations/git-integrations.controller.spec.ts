/**
 * @fileoverview Unit tests for the ticket 11 parts of GitIntegrationsController: the own-server routes
 * delegate with the caller's organization, `serverId` reaches connect / detail / members, the built-in
 * page leaves own servers' connections out, and a server of another provider is a 404.
 * @module src/git-integrations/git-integrations.controller.spec
 */

import { NotFoundException } from '@nestjs/common';

import { GitIntegrationsController } from './git-integrations.controller';

process.env.CALENDAR_STATE_SECRET ??= 'x'.repeat(48);

const ORG = 'org-1';
const USER = 'user-1';
const SERVER_ID = '11111111-1111-4111-8111-111111111111';
const user = { userId: USER, organizationId: ORG } as never;

function setup() {
  const adapter = (provider: 'github' | 'gitlab') => ({
    provider,
    isConfigured: jest.fn().mockReturnValue(true),
    connectUrl: jest.fn().mockResolvedValue(`https://${provider}/authorize`),
    manageUrl: jest.fn().mockReturnValue(null),
  });
  const github = adapter('github');
  const gitlab = adapter('gitlab');
  const core = {
    getOverview: jest.fn().mockResolvedValue([]),
    getDetail: jest.fn().mockResolvedValue({}),
  };
  const providers = {
    get: (name: string) => (name === 'github' ? github : gitlab),
    configured: () => ({ github: true, gitlab: false }),
  };
  const identities = {
    listLinkedMembers: jest.fn().mockResolvedValue([]),
    removeMemberLink: jest.fn().mockResolvedValue(undefined),
  };
  const servers = {
    list: jest
      .fn()
      .mockResolvedValue([
        { id: SERVER_ID, provider: 'gitlab', host: 'gitlab.company.local' },
      ]),
    get: jest.fn().mockResolvedValue({
      id: SERVER_ID,
      provider: 'gitlab',
      host: 'gitlab.company.local',
    }),
    toApp: jest.fn().mockReturnValue({
      provider: 'gitlab',
      clientId: 'a',
      clientSecret: 'b',
    }),
    overview: jest.fn().mockResolvedValue({ servers: [] }),
    create: jest.fn().mockResolvedValue({ id: SERVER_ID }),
    update: jest.fn().mockResolvedValue({ id: SERVER_ID }),
    remove: jest.fn().mockResolvedValue(undefined),
    setup: jest.fn().mockResolvedValue({}),
    rotateWebhookSecret: jest.fn().mockResolvedValue({ webhookSecret: 's' }),
    auditTest: jest.fn(),
  };
  const serverTests = {
    test: jest.fn().mockResolvedValue({ ok: true, checks: [] }),
  };
  const controller = new GitIntegrationsController(
    core as never,
    providers as never,
    identities as never,
    servers as never,
    serverTests as never,
  );

  return { controller, core, github, gitlab, identities, servers, serverTests };
}

describe('GitIntegrationsController (ticket 11)', () => {
  it('server routes pass the caller organization and user', async () => {
    const { controller, servers, serverTests } = setup();

    await controller.listServers(user);
    await controller.createServer(user, {
      provider: 'gitlab',
      baseUrl: 'https://gitlab.company.local',
      name: 'GitLab',
    });
    await controller.updateServer(user, SERVER_ID, { name: 'New' });
    await controller.serverSetup(user, SERVER_ID);
    await controller.rotateServerWebhookSecret(user, SERVER_ID);
    await controller.removeServer(user, SERVER_ID);
    const result = await controller.testServer(user, SERVER_ID);

    expect(servers.overview).toHaveBeenCalledWith(ORG);
    expect(servers.create).toHaveBeenCalledWith(ORG, USER, expect.anything());
    expect(servers.update).toHaveBeenCalledWith(ORG, SERVER_ID, USER, {
      name: 'New',
    });
    expect(servers.setup).toHaveBeenCalledWith(ORG, SERVER_ID, USER);
    expect(servers.rotateWebhookSecret).toHaveBeenCalledWith(
      ORG,
      SERVER_ID,
      USER,
    );
    expect(servers.remove).toHaveBeenCalledWith(ORG, SERVER_ID, USER);
    expect(serverTests.test).toHaveBeenCalledWith(ORG, SERVER_ID);
    expect(servers.auditTest).toHaveBeenCalledWith(
      ORG,
      USER,
      SERVER_ID,
      result,
    );
  });

  it('the overview leaves the own servers out of the built-in cards', async () => {
    const { controller, core } = setup();

    await controller.overview(user);

    const [, , ownHosts] = core.getOverview.mock.calls[0] as [
      string,
      unknown,
      Record<string, Set<string>>,
    ];

    expect([...ownHosts.gitlab]).toEqual(['gitlab.company.local']);
    expect([...ownHosts.github]).toEqual([]);
  });

  it('detail without serverId: built-in page excluding own servers; with serverId: only that server', async () => {
    const { controller, core } = setup();

    await controller.detail(user, 'gitlab');
    expect(core.getDetail.mock.calls[0][4]).toEqual({
      exclude: new Set(['gitlab.company.local']),
    });

    await controller.detail(user, 'gitlab', SERVER_ID);
    expect(core.getDetail.mock.calls[1][2]).toBe(true);
    expect(core.getDetail.mock.calls[1][4]).toEqual({
      only: 'gitlab.company.local',
    });
  });

  it("a server of the other provider is a 404 on the provider's page", async () => {
    const { controller } = setup();

    await expect(
      controller.detail(user, 'github', SERVER_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('connect and members carry the serverId', async () => {
    const { controller, gitlab, identities } = setup();

    await controller.connect(user, 'gitlab', 'https://t.app', SERVER_ID);
    expect(gitlab.connectUrl).toHaveBeenCalledWith(
      USER,
      ORG,
      'https://t.app',
      undefined,
      SERVER_ID,
    );

    await controller.linkedMembers(user, 'gitlab', SERVER_ID);
    expect(identities.listLinkedMembers).toHaveBeenCalledWith(
      ORG,
      'gitlab',
      SERVER_ID,
    );

    await controller.removeMemberLink(user, 'gitlab', 'target', SERVER_ID);
    expect(identities.removeMemberLink).toHaveBeenCalledWith(
      ORG,
      USER,
      'gitlab',
      'target',
      SERVER_ID,
    );
  });
});
