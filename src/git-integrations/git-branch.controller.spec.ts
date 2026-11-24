/**
 * @fileoverview Unit tests for GitBranchController.config (ticket 3): the per-member read of the
 * organization's branch convention, whether Git is in use, and the caller's own linked logins.
 * @module src/git-integrations/git-branch.controller.spec
 */

import { GitBranchController } from './git-branch.controller';

const user = { userId: 'user-1', organizationId: 'org-1' } as never;

function make(
  overrides: {
    providers?: string[];
    settings?: object;
    mine?: object[];
    everConnected?: boolean;
  } = {},
) {
  const core = {
    connectedProviders: jest.fn().mockResolvedValue(overrides.providers ?? []),
    everConnected: jest
      .fn()
      .mockResolvedValue(
        overrides.everConnected ?? (overrides.providers ?? []).length > 0,
      ),
    getBranchSettings: jest
      .fn()
      .mockResolvedValue(
        overrides.settings ?? { prefix: '', keyCase: 'upper' },
      ),
  };
  const identities = {
    listMine: jest.fn().mockResolvedValue(
      overrides.mine ?? [
        { provider: 'github', configured: true, identity: null },
        { provider: 'gitlab', configured: true, identity: null },
      ],
    ),
  };

  return {
    controller: new GitBranchController(core as never, identities as never),
    core,
    identities,
  };
}

describe('GitBranchController.config', () => {
  it('is disabled with no live connections', async () => {
    const { controller } = make();

    await expect(controller.config(user)).resolves.toEqual({
      enabled: false,
      everConnected: false,
      prefix: '',
      keyCase: 'upper',
      connectedProviders: [],
      linked: { github: null, gitlab: null, azure_devops: null },
    });
  });

  it('is enabled with connections and passes settings and linked logins through', async () => {
    const { controller } = make({
      providers: ['github', 'gitlab'],
      settings: { prefix: '{username}/', keyCase: 'lower' },
      mine: [
        {
          provider: 'github',
          configured: true,
          identity: { login: 'octocat' },
        },
        { provider: 'gitlab', configured: true, identity: null },
      ],
    });

    await expect(controller.config(user)).resolves.toEqual({
      enabled: true,
      everConnected: true,
      prefix: '{username}/',
      keyCase: 'lower',
      connectedProviders: ['github', 'gitlab'],
      linked: { github: 'octocat', gitlab: null, azure_devops: null },
    });
  });

  it('uses only the request user org/user ids', async () => {
    const { controller, core, identities } = make();

    await controller.config(user);

    expect(core.connectedProviders).toHaveBeenCalledTimes(1);
    expect(core.connectedProviders).toHaveBeenCalledWith('org-1');
    expect(core.getBranchSettings).toHaveBeenCalledTimes(1);
    expect(core.getBranchSettings).toHaveBeenCalledWith('org-1');
    expect(identities.listMine).toHaveBeenCalledTimes(1);
    expect(identities.listMine).toHaveBeenCalledWith('user-1');
  });

  it('reports a past connection after a disconnect (ticket 5): disabled but everConnected', async () => {
    const { controller, core } = make({ providers: [], everConnected: true });

    await expect(controller.config(user)).resolves.toMatchObject({
      enabled: false,
      everConnected: true,
    });
    expect(core.everConnected).toHaveBeenCalledWith('org-1');
  });
});
