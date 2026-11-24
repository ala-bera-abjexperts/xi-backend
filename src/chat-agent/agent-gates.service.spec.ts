import { InternalServerErrorException } from '@nestjs/common';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { EntitlementsService } from '../licensing/entitlements.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AgentGatesService } from './agent-gates.service';
import type { AgentSettingsService } from './agent-settings.service';
import { ROBERT_ID } from './agent.constants';

/** Thenable query double: every builder call returns itself and records it. */
function chain(result: { data: unknown; error?: unknown }) {
  const calls: Array<[string, unknown[]]> = [];
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === 'then') {
          return (
            resolve: (v: unknown) => unknown,
            reject: (e: unknown) => unknown,
          ) =>
            Promise.resolve({ error: null, ...result }).then(resolve, reject);
        }
        if (prop === 'calls') return calls;
        return (...args: unknown[]) => {
          calls.push([prop, args]);
          return proxy;
        };
      },
    },
  );
  return proxy as Record<string, unknown> & {
    calls: Array<[string, unknown[]]>;
  };
}

describe('AgentGatesService', () => {
  const user = { userId: 'user-1', organizationId: 'org-1' } as RequestUser;

  // Every gate open; each test closes the ones it is about.
  let licensed: boolean;
  let permitted: boolean;
  let settings: { enabled: boolean; allowInDms: boolean };
  let config: { data: unknown; error?: unknown };
  let from: jest.Mock;
  let checkPermission: jest.Mock;
  let getEffectiveEntitlements: jest.Mock;
  let service: AgentGatesService;

  beforeEach(() => {
    licensed = true;
    permitted = true;
    settings = { enabled: true, allowInDms: true };
    config = { data: { provider_name: 'openai', is_active: true } };
    from = jest.fn(() => chain(config));
    checkPermission = jest.fn(() => Promise.resolve(permitted));
    getEffectiveEntitlements = jest.fn(() =>
      Promise.resolve({
        has: (key: string) => key !== 'feature_ai_assist' || licensed,
      }),
    );
    service = new AgentGatesService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      { getEffectiveEntitlements } as unknown as EntitlementsService,
      { checkPermission } as unknown as PermissionsService,
      {
        read: jest.fn(() => Promise.resolve(settings)),
      } as unknown as AgentSettingsService,
    );
  });

  describe('status', () => {
    it('is ok with the licence, the permission, the switch and a provider', async () => {
      await expect(service.status(user)).resolves.toEqual({
        state: 'ok',
        provider: 'openai',
        dmAllowed: true,
        robertId: ROBERT_ID,
      });
    });

    it('asks for the AI licence and can_use_robert of the caller in their organization', async () => {
      await service.status(user);

      expect(getEffectiveEntitlements).toHaveBeenCalledWith('org-1');
      expect(checkPermission).toHaveBeenCalledWith(
        'user-1',
        'org-1',
        'can_use_robert',
      );
    });

    it('reads the provider of the caller organization only, and never the key', async () => {
      await service.status(user);

      expect(from).toHaveBeenCalledWith('ai_provider_configs');
      expect(
        (from.mock.results[0].value as ReturnType<typeof chain>).calls,
      ).toEqual([
        ['select', ['provider_name, is_active']],
        ['eq', ['organization_id', 'org-1']],
        ['maybeSingle', []],
      ]);
    });

    it.each([
      ['not_licensed', () => (licensed = false)],
      ['no_permission', () => (permitted = false)],
      ['disabled', () => (settings.enabled = false)],
      ['not_configured', () => (config.data = null)],
      [
        'not_configured',
        () => (config.data = { provider_name: 'openai', is_active: false }),
      ],
    ])('is %s when that gate alone is closed', async (state, close) => {
      close();

      await expect(service.status(user)).resolves.toMatchObject({ state });
    });

    // Each row closes one gate more, from the last to the first: the first
    // closed gate in the order licence, permission, switch, provider wins.
    it.each([
      ['disabled', { enabled: false, provider: false }],
      ['no_permission', { permitted: false, enabled: false, provider: false }],
      [
        'not_licensed',
        { licensed: false, permitted: false, enabled: false, provider: false },
      ],
    ])('answers %s first when later gates are closed too', async (state, c) => {
      const closed = c as Record<string, boolean | undefined>;
      if (closed.licensed === false) licensed = false;
      if (closed.permitted === false) permitted = false;
      if (closed.enabled === false) settings.enabled = false;
      if (closed.provider === false) config.data = null;

      await expect(service.status(user)).resolves.toMatchObject({ state });
    });

    it('treats a configuration without the is_active flag as configured', async () => {
      config.data = { provider_name: 'anthropic', is_active: null };

      await expect(service.status(user)).resolves.toMatchObject({
        state: 'ok',
        provider: 'anthropic',
      });
    });

    it('has no provider when none is configured', async () => {
      config.data = null;

      await expect(service.status(user)).resolves.toMatchObject({
        provider: null,
      });
    });

    it('reports whether Robert may be mentioned in direct messages', async () => {
      settings.allowInDms = false;

      await expect(service.status(user)).resolves.toMatchObject({
        state: 'ok',
        dmAllowed: false,
      });
    });

    it('fails instead of guessing when the configuration cannot be read', async () => {
      config = { data: null, error: { message: 'boom' } };

      await expect(service.status(user)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('refusal (the gate before a run starts)', () => {
    const channel = { kind: 'space' as const, dm_key: null };
    const dm = { kind: 'dm' as const, dm_key: 'user-1:user-2' };
    const robertDm = { kind: 'dm' as const, dm_key: `user-1:${ROBERT_ID}` };

    it('lets Robert answer when every gate is open', async () => {
      await expect(service.refusal(user, channel)).resolves.toBeNull();
      await expect(service.refusal(user, dm)).resolves.toBeNull();
      await expect(service.refusal(user)).resolves.toBeNull();
    });

    it('refuses an impersonated caller before anything else is looked at', async () => {
      licensed = false;

      await expect(
        service.refusal(
          { ...user, impersonation: { realUserId: 'sa-1' } } as RequestUser,
          channel,
        ),
      ).resolves.toBe('impersonating');
      expect(getEffectiveEntitlements).not.toHaveBeenCalled();
      expect(from).not.toHaveBeenCalled();
    });

    it.each([
      ['not_licensed', () => (licensed = false)],
      ['no_permission', () => (permitted = false)],
      ['disabled', () => (settings.enabled = false)],
      ['not_configured', () => (config.data = null)],
    ])('refuses with %s', async (code, close) => {
      close();

      await expect(service.refusal(user, channel)).resolves.toBe(code);
    });

    it('refuses a mention in a direct message when Robert is off for DMs', async () => {
      settings.allowInDms = false;

      await expect(service.refusal(user, dm)).resolves.toBe('dm_disabled');
    });

    it('never refuses the private conversation with Robert, a group or a channel for that', async () => {
      settings.allowInDms = false;

      await expect(service.refusal(user, robertDm)).resolves.toBeNull();
      await expect(service.refusal(user, channel)).resolves.toBeNull();
      await expect(
        service.refusal(user, { kind: 'group', dm_key: null }),
      ).resolves.toBeNull();
      // Without the conversation the database function applies the DM rule.
      await expect(service.refusal(user)).resolves.toBeNull();
    });

    it('answers "disabled" before "dm_disabled", and "dm_disabled" before "not_configured"', async () => {
      settings.allowInDms = false;
      config.data = null;

      await expect(service.refusal(user, dm)).resolves.toBe('dm_disabled');

      settings.enabled = false;

      await expect(service.refusal(user, dm)).resolves.toBe('disabled');
    });
  });
});
