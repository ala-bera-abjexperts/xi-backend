import {
  GoneException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

/**
 * @fileoverview Unit tests for the shared OAuth callbacks: identity-tagged states (ticket 2) go to
 * the personal-account handler, organization states go to the provider handler unchanged.
 * @module src/git-integrations/git-integrations-public.controller.spec
 */

import { createState } from '../calendar/integrations/calendar-oauth.state';
import { GitIntegrationsPublicController } from './git-integrations-public.controller';
import { identityStateTag, stateProviderTag } from './git-integrations.util';

const ENV_KEYS = [
  'AI_ENCRYPTION_SECRET',
  'CALENDAR_STATE_SECRET',
  'JWT_SECRET',
  'FRONTEND_URL',
  'ALLOWED_ORIGINS',
];

function setup() {
  const providers = {
    github: {
      handleCallback: jest.fn().mockResolvedValue('https://app/org-github'),
      handleWebhook: jest.fn().mockResolvedValue('ok'),
    },
    azureDevops: {
      handleCallback: jest.fn().mockResolvedValue('https://app/azure-done'),
      handleWebhook: jest.fn().mockResolvedValue('ok'),
    },
    gitlab: {
      handleCallback: jest.fn().mockResolvedValue('https://app/org-gitlab'),
    },
  };
  const identities = {
    handleCallback: jest.fn().mockResolvedValue('https://app/identity'),
  };
  const res = { redirect: jest.fn() };
  const controller = new GitIntegrationsPublicController(
    providers as never,
    identities as never,
  );

  return { controller, providers, identities, res };
}

describe('GitIntegrationsPublicController callbacks', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.AI_ENCRYPTION_SECRET = 'a'.repeat(64);
    process.env.FRONTEND_URL = 'https://app.example.com';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('github identity state goes to identities.handleCallback, not the org handler', async () => {
    const { controller, providers, identities, res } = setup();
    const state = createState(
      'u1',
      'o1',
      identityStateTag('github', 'profile'),
      'https://app.example.com/x',
    );

    await controller.githubCallback(
      'code-1',
      state,
      undefined,
      undefined,
      undefined,
      res as never,
    );

    expect(identities.handleCallback).toHaveBeenCalledWith({
      provider: 'github',
      page: 'profile',
      userId: 'u1',
      organizationId: 'o1',
      returnTo: 'https://app.example.com',
      code: 'code-1',
      error: undefined,
      state,
    });
    expect(providers.github.handleCallback).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('https://app/identity');
  });

  it('gitlab identity state goes to identities.handleCallback with the error', async () => {
    const { controller, providers, identities, res } = setup();
    const state = createState(
      'u1',
      'o1',
      identityStateTag('gitlab', 'integrations'),
    );

    await controller.gitlabCallback(
      undefined,
      state,
      'access_denied',
      res as never,
    );

    expect(identities.handleCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'gitlab',
        page: 'integrations',
        error: 'access_denied',
      }),
    );
    expect(providers.gitlab.handleCallback).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('https://app/identity');
  });

  it('an org state (git:github) goes to providers.github.handleCallback', async () => {
    const { controller, providers, identities, res } = setup();
    const state = createState('u1', 'o1', stateProviderTag('github'));

    await controller.githubCallback(
      'c',
      state,
      '123',
      'install',
      undefined,
      res as never,
    );

    expect(identities.handleCallback).not.toHaveBeenCalled();
    expect(providers.github.handleCallback).toHaveBeenCalledWith({
      code: 'c',
      state,
      installationId: '123',
      setupAction: 'install',
      error: undefined,
    });
    expect(res.redirect).toHaveBeenCalledWith('https://app/org-github');
  });

  it('a gitlab identity state arriving at the github callback is NOT treated as identity', async () => {
    const { controller, providers, identities, res } = setup();
    const state = createState(
      'u1',
      'o1',
      identityStateTag('gitlab', 'profile'),
    );

    await controller.githubCallback(
      'c',
      state,
      undefined,
      undefined,
      undefined,
      res as never,
    );

    expect(identities.handleCallback).not.toHaveBeenCalled();
    expect(providers.github.handleCallback).toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('https://app/org-github');
  });

  it('a tampered or missing state goes to the org handler, which rejects it', async () => {
    const { controller, providers, identities, res } = setup();
    const state = createState(
      'u1',
      'o1',
      identityStateTag('github', 'profile'),
    );

    await controller.githubCallback(
      'c',
      `${state}x`,
      undefined,
      undefined,
      undefined,
      res as never,
    );
    await controller.gitlabCallback('c', undefined, undefined, res as never);

    expect(identities.handleCallback).not.toHaveBeenCalled();
    expect(providers.github.handleCallback).toHaveBeenCalledTimes(1);
    expect(providers.gitlab.handleCallback).toHaveBeenCalledTimes(1);
  });

  it.each(['github', 'gitlab'] as const)(
    '%s: no state secret → not_configured without calling either',
    async (provider) => {
      const { controller, providers, identities, res } = setup();
      const state = createState(
        'u1',
        'o1',
        identityStateTag(provider, 'profile'),
      );

      delete process.env.AI_ENCRYPTION_SECRET;

      if (provider === 'github')
        await controller.githubCallback(
          'c',
          state,
          undefined,
          undefined,
          undefined,
          res as never,
        );
      else await controller.gitlabCallback('c', state, undefined, res as never);

      expect(res.redirect).toHaveBeenCalledWith(
        `https://app.example.com/tenant-config?tab=integrations&integration=${provider}&error=not_configured`,
      );
      expect(identities.handleCallback).not.toHaveBeenCalled();
      expect(providers[provider].handleCallback).not.toHaveBeenCalled();
    },
  );
  describe('Azure DevOps', () => {
    const HOOK = '33333333-3333-3333-3333-333333333333';
    const request = { rawBody: Buffer.from('{}') } as never;

    it('hands a delivery on with its Authorization header', async () => {
      const { controller, providers } = setup();

      await expect(
        controller.azureDevopsWebhook(request, HOOK, 'Basic abc'),
      ).resolves.toBeUndefined();
      expect(providers.azureDevops.handleWebhook).toHaveBeenCalledWith({
        hookId: HOOK,
        authorization: 'Basic abc',
        rawBody: Buffer.from('{}'),
      });
    });

    it.each([
      ['unauthorized', UnauthorizedException],
      ['gone', GoneException],
      ['retry', ServiceUnavailableException],
    ])('answers %s with the status Azure expects', async (outcome, type) => {
      const { controller, providers } = setup();

      providers.azureDevops.handleWebhook.mockResolvedValue(outcome);

      await expect(
        controller.azureDevopsWebhook(request, HOOK),
      ).rejects.toBeInstanceOf(type);
    });

    it('an organization sign-in goes to its handler', async () => {
      const { controller, providers, identities, res } = setup();
      const state = createState('u1', 'o1', 'git:azure_devops');

      await controller.azureDevopsCallback('c', state, undefined, res as never);

      expect(identities.handleCallback).not.toHaveBeenCalled();
      expect(providers.azureDevops.handleCallback).toHaveBeenCalledWith({
        code: 'c',
        state,
        error: undefined,
      });
      expect(res.redirect).toHaveBeenCalledWith('https://app/azure-done');
    });

    it('a personal link goes to the identities, with the state its verifier derives from', async () => {
      const { controller, providers, identities, res } = setup();
      const state = createState(
        'u1',
        'o1',
        identityStateTag('azure_devops', 'profile'),
      );

      await controller.azureDevopsCallback('c', state, undefined, res as never);

      expect(providers.azureDevops.handleCallback).not.toHaveBeenCalled();
      expect(identities.handleCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'azure_devops',
          page: 'profile',
          code: 'c',
          state,
        }),
      );
    });

    it('no state secret → not_configured without calling either', async () => {
      const { controller, providers, identities, res } = setup();

      delete process.env.AI_ENCRYPTION_SECRET;
      delete process.env.CALENDAR_STATE_SECRET;
      delete process.env.JWT_SECRET;

      await controller.azureDevopsCallback('c', 'x', undefined, res as never);

      expect(res.redirect).toHaveBeenCalledWith(
        expect.stringContaining('integration=azure_devops&error=not_configured'),
      );
      expect(identities.handleCallback).not.toHaveBeenCalled();
      expect(providers.azureDevops.handleCallback).not.toHaveBeenCalled();
    });
  });

  describe('own servers (ticket 11)', () => {
    const SERVER_ID = '11111111-1111-1111-1111-111111111111';

    it('an identity state with a server passes the server on', async () => {
      const { controller, identities, res } = setup();
      const state = createState(
        'u1',
        'o1',
        identityStateTag('github', 'profile', SERVER_ID),
      );

      await controller.githubCallback(
        'code-1',
        state,
        undefined,
        undefined,
        undefined,
        res as never,
      );

      expect(identities.handleCallback).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'github', serverId: SERVER_ID }),
      );
    });

    it('a server org state still goes to the GitHub org handler', async () => {
      const { controller, providers, identities, res } = setup();
      const state = createState(
        'u1',
        'o1',
        stateProviderTag('github', undefined, SERVER_ID),
      );

      await controller.githubCallback(
        'code-1',
        state,
        undefined,
        undefined,
        undefined,
        res as never,
      );

      expect(identities.handleCallback).not.toHaveBeenCalled();
      expect(providers.github.handleCallback).toHaveBeenCalled();
    });

    it('the server webhook route passes the server id and maps unauthorized to 401', async () => {
      const { controller, providers } = setup();
      const req = { rawBody: Buffer.from('{}') };

      await controller.githubServerWebhook(
        req as never,
        SERVER_ID,
        'ping',
        'd1',
        'sha256=x',
      );

      expect(providers.github.handleWebhook).toHaveBeenCalledWith({
        event: 'ping',
        deliveryId: 'd1',
        signature: 'sha256=x',
        rawBody: req.rawBody,
        serverId: SERVER_ID,
      });

      providers.github.handleWebhook.mockResolvedValue('unauthorized');

      await expect(
        controller.githubServerWebhook(req as never, SERVER_ID, 'ping'),
      ).rejects.toMatchObject({ status: 401 });
    });
  });
});
