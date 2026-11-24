import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { MailService } from '../mail/mail.service';
import type { NotificationsBroadcastService } from '../notifications/notifications-broadcast.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AgentSettingsService } from './agent-settings.service';

type Result = { data: unknown; error?: unknown };

/** Thenable query double: every builder call returns itself and records it. */
function chain(result: Result) {
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

describe('AgentSettingsService', () => {
  const user = { userId: 'user-1', organizationId: 'org-1' } as RequestUser;

  /** What `from(table)` answers; a list is used up one query at a time. */
  let tables: Record<string, Result | Result[]>;
  let from: jest.Mock;
  let checkPermission: jest.Mock;
  let broadcastNotification: jest.Mock;
  let sendNotification: jest.Mock;
  let service: AgentSettingsService;

  /** The tables that were asked, in order. */
  const asked = () => (from.mock.calls as [string][]).map(([table]) => table);

  /** The queries made against one table, in order. */
  const queries = (table: string) =>
    from.mock.calls
      .map(([name], index) => [name, from.mock.results[index].value] as const)
      .filter(([name]) => name === table)
      .map(([, query]) => query as ReturnType<typeof chain>);

  beforeEach(() => {
    tables = {};
    from = jest.fn((table: string) => {
      const answer = tables[table] ?? { data: null };

      return chain(
        Array.isArray(answer) ? (answer.shift() ?? { data: null }) : answer,
      );
    });
    checkPermission = jest.fn().mockResolvedValue(true);
    broadcastNotification = jest.fn().mockResolvedValue(undefined);
    sendNotification = jest.fn().mockResolvedValue(undefined);
    service = new AgentSettingsService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      { checkPermission } as unknown as PermissionsService,
      { broadcastNotification } as unknown as NotificationsBroadcastService,
      { sendNotification } as unknown as MailService,
      {
        get: () => 'https://app.example.com/',
      } as unknown as ConfigService,
    );
  });

  afterEach(() => jest.useRealTimers());

  describe('read', () => {
    it('is enabled, allowed in DMs and uncapped when the organization has no row', async () => {
      await expect(service.read('org-1')).resolves.toEqual({
        enabled: true,
        allowInDms: true,
        monthlyTokenCap: null,
        userDailyTokenCap: null,
        storePrompts: false,
      });
      expect(queries('agent_settings')[0].calls).toContainEqual([
        'eq',
        ['organization_id', 'org-1'],
      ]);
    });

    it('returns the stored row', async () => {
      tables.agent_settings = {
        data: {
          enabled: false,
          allow_in_dms: false,
          monthly_token_cap: 2_000_000,
          user_daily_token_cap: 200_000,
          store_prompts: true,
        },
      };

      await expect(service.read('org-1')).resolves.toEqual({
        enabled: false,
        allowInDms: false,
        monthlyTokenCap: 2_000_000,
        userDailyTokenCap: 200_000,
        storePrompts: true,
      });
    });

    it('fails when the settings cannot be read (never "enabled" by accident)', async () => {
      tables.agent_settings = { data: null, error: { message: 'boom' } };

      await expect(service.read('org-1')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('get', () => {
    it("adds the reservation of one run and this UTC month's usage against the cap", async () => {
      jest.useFakeTimers({ now: Date.parse('2026-10-11T08:00:00Z') });
      tables.agent_settings = {
        data: {
          enabled: true,
          allow_in_dms: true,
          monthly_token_cap: 2_000_000,
          user_daily_token_cap: null,
          store_prompts: false,
        },
      };
      tables.agent_usage_counters = {
        data: {
          used_tokens: 1_650_000,
          alert80_at: '2026-10-09T10:00:00Z',
          alert100_at: null,
        },
      };

      await expect(service.get(user)).resolves.toEqual({
        enabled: true,
        allowInDms: true,
        monthlyTokenCap: 2_000_000,
        userDailyTokenCap: null,
        storePrompts: false,
        reservePerRun: 60_000,
        usage: {
          month: {
            used: 1_650_000,
            cap: 2_000_000,
            resetsAt: '2026-11-01T00:00:00.000Z',
          },
          alert80At: '2026-10-09T10:00:00Z',
          alert100At: null,
        },
      });
      // The tenant's own counter of this month, nobody else's.
      expect(queries('agent_usage_counters')[0].calls).toEqual([
        ['select', ['used_tokens, alert80_at, alert100_at']],
        ['eq', ['organization_id', 'org-1']],
        ['eq', ['scope', 'org_month']],
        ['eq', ['subject_id', 'org-1']],
        ['eq', ['period_start', '2026-10-01']],
        ['maybeSingle', []],
      ]);
    });

    it('has used nothing before the first run of the month, and resets in January after December', async () => {
      jest.useFakeTimers({ now: Date.parse('2026-12-31T23:30:00Z') });

      const view = await service.get(user);

      expect(view.usage).toEqual({
        month: { used: 0, cap: null, resetsAt: '2027-01-01T00:00:00.000Z' },
        alert80At: null,
        alert100At: null,
      });
      expect(queries('agent_usage_counters')[0].calls).toContainEqual([
        'eq',
        ['period_start', '2026-12-01'],
      ]);
    });

    it('fails when the usage cannot be read', async () => {
      tables.agent_usage_counters = { data: null, error: { message: 'boom' } };

      await expect(service.get(user)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('update', () => {
    const dto = {
      enabled: false,
      allowInDms: true,
      monthlyTokenCap: 2_000_000,
      userDailyTokenCap: null,
      storePrompts: true,
    };

    it('stores the settings of the caller organization and who changed them', async () => {
      await service.update(user, dto);

      expect(queries('agent_settings')[0].calls).toEqual([
        [
          'upsert',
          [
            {
              organization_id: 'org-1',
              enabled: false,
              allow_in_dms: true,
              monthly_token_cap: 2_000_000,
              // null removes the cap.
              user_daily_token_cap: null,
              store_prompts: true,
              updated_by: 'user-1',
            },
            { onConflict: 'organization_id' },
          ],
        ],
      ]);
    });

    it('writes settings.changed to the Robert audit trail: booleans and numbers only', async () => {
      await service.update(user, dto);

      expect(queries('agent_audit_events')[0].calls).toEqual([
        [
          'insert',
          [
            {
              organization_id: 'org-1',
              event: 'settings.changed',
              actor_id: 'user-1',
              data: {
                enabled: false,
                allow_in_dms: true,
                monthly_token_cap: 2_000_000,
                user_daily_token_cap: null,
                store_prompts: true,
              },
            },
          ],
        ],
      ]);
    });

    it('writes the audit row before the change, and changes nothing without it', async () => {
      await service.update(user, dto);

      expect(asked().slice(0, 2)).toEqual([
        'agent_audit_events',
        'agent_settings',
      ]);

      from.mockClear();
      tables.agent_audit_events = { data: null, error: { message: 'boom' } };

      await expect(service.update(user, dto)).rejects.toThrow(
        InternalServerErrorException,
      );
      expect(asked()).toEqual(['agent_audit_events']);
    });

    it('fails when the settings cannot be saved', async () => {
      // Only the save fails; reading the settings back would work.
      tables.agent_settings = [
        { data: null, error: { message: 'boom' } },
        { data: null },
      ];

      await expect(service.update(user, dto)).rejects.toThrow(
        'Could not save Robert settings',
      );
    });

    it('answers with the saved settings and the usage', async () => {
      tables.agent_settings = [
        { data: null },
        {
          data: {
            enabled: false,
            allow_in_dms: true,
            monthly_token_cap: 2_000_000,
            user_daily_token_cap: null,
            store_prompts: true,
          },
        },
      ];

      await expect(service.update(user, dto)).resolves.toMatchObject({
        enabled: false,
        monthlyTokenCap: 2_000_000,
        reservePerRun: 60_000,
        usage: { month: { used: 0, cap: 2_000_000 } },
      });
    });
  });

  describe('usage', () => {
    const log = (overrides: Record<string, unknown> = {}) => ({
      user_id: 'user-1',
      operation_type: 'robert_run',
      tokens_used: 1000,
      created_at: '2026-10-02T09:00:00+00:00',
      user: { first_name: 'Anna', last_name: 'Auer', email: 'a@x' },
      ...overrides,
    });

    it('groups the period by day, user, feature and model', async () => {
      tables.ai_usage_logs = {
        data: [
          log(),
          log({ tokens_used: 500, created_at: '2026-10-03T23:59:59+00:00' }),
          log({
            user_id: 'user-2',
            tokens_used: 4000,
            created_at: '2026-10-03T10:00:00+00:00',
            user: { first_name: null, last_name: null, email: 'b@x' },
          }),
          log({ user_id: 'user-3', tokens_used: null, user: null }),
        ],
      };
      tables.agent_runs = {
        data: [
          {
            provider: 'openai',
            model: 'gpt-x',
            tokens_in: 900,
            tokens_out: 100,
          },
          {
            provider: 'openai',
            model: 'gpt-x',
            tokens_in: 400,
            tokens_out: 100,
          },
          { provider: null, model: null, tokens_in: 9000, tokens_out: 0 },
        ],
      };

      await expect(
        service.usage(user, { from: '2026-10-01', to: '2026-10-03' }),
      ).resolves.toEqual({
        // Every day of the period, also one without usage.
        byDay: [
          { date: '2026-10-01', tokens: 0 },
          { date: '2026-10-02', tokens: 1000 },
          { date: '2026-10-03', tokens: 4500 },
        ],
        byUser: [
          { userId: 'user-2', name: 'b@x', tokens: 4000, runs: 1 },
          { userId: 'user-1', name: 'Anna Auer', tokens: 1500, runs: 2 },
          { userId: 'user-3', name: 'Unknown user', tokens: 0, runs: 1 },
        ],
        byModel: [
          {
            provider: 'unknown',
            model: 'unknown',
            tokensIn: 9000,
            tokensOut: 0,
            runs: 1,
          },
          {
            provider: 'openai',
            model: 'gpt-x',
            tokensIn: 1300,
            tokensOut: 200,
            runs: 2,
          },
        ],
        byFeature: [{ feature: 'robert_run', tokens: 5500, runs: 4 }],
      });
    });

    it('counts a timestamp on its UTC day, whatever offset it is written with', async () => {
      tables.ai_usage_logs = {
        data: [log({ created_at: '2026-10-02T01:30:00+02:00' })],
      };

      const { byDay } = await service.usage(user, {
        from: '2026-10-01',
        to: '2026-10-02',
      });

      expect(byDay).toEqual([
        { date: '2026-10-01', tokens: 1000 },
        { date: '2026-10-02', tokens: 0 },
      ]);
    });

    it('reads only the caller organization, and whole UTC days with both ends included', async () => {
      await service.usage(user, { from: '2026-10-01', to: '2026-10-31' });

      for (const table of ['ai_usage_logs', 'agent_runs']) {
        const { calls } = queries(table)[0];

        expect(calls).toContainEqual(['eq', ['organization_id', 'org-1']]);
        expect(calls).toContainEqual([
          'gte',
          ['created_at', '2026-10-01T00:00:00.000Z'],
        ]);
        expect(calls).toContainEqual([
          'lt',
          ['created_at', '2026-11-01T00:00:00.000Z'],
        ]);
        expect(calls).toContainEqual(['range', [0, 999]]);
      }
      // The connection test and the other AI features are not Robert's usage.
      expect(queries('ai_usage_logs')[0].calls).toContainEqual([
        'eq',
        ['operation_type', 'robert_run'],
      ]);
      // A run that never reached the model is in no model's numbers.
      expect(queries('agent_runs')[0].calls).toContainEqual([
        'gt',
        ['model_calls', 0],
      ]);
    });

    it('reads past the 1,000 rows one answer can hold', async () => {
      tables.ai_usage_logs = [
        { data: Array.from({ length: 1000 }, () => log({ tokens_used: 1 })) },
        { data: [log({ tokens_used: 1 })] },
      ];

      const { byFeature } = await service.usage(user, {
        from: '2026-10-02',
        to: '2026-10-02',
      });

      expect(byFeature).toEqual([
        { feature: 'robert_run', tokens: 1001, runs: 1001 },
      ]);
      expect(queries('ai_usage_logs')[1].calls).toContainEqual([
        'range',
        [1000, 1999],
      ]);
    });

    it('accepts one day and a whole year, and refuses a reversed or longer period', async () => {
      await expect(
        service.usage(user, { from: '2026-10-11', to: '2026-10-11' }),
      ).resolves.toMatchObject({
        byDay: [{ date: '2026-10-11', tokens: 0 }],
      });
      await expect(
        service.usage(user, { from: '2028-01-01', to: '2028-12-31' }),
      ).resolves.toBeDefined();

      from.mockClear();

      await expect(
        service.usage(user, { from: '2026-10-12', to: '2026-10-11' }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.usage(user, { from: '2026-01-01', to: '2027-01-02' }),
      ).rejects.toThrow(BadRequestException);
      expect(from).not.toHaveBeenCalled();
    });
  });

  describe('notifyBudgetAlert', () => {
    const bell = (userId: string) => ({
      id: `n-${userId}`,
      user_id: userId,
      type: 'robert_budget',
      title: 'x',
      created_at: '2026-10-11T08:00:00Z',
      metadata: { link: '/tenant-config?tab=configuration', threshold: 80 },
    });

    beforeEach(() => {
      tables.organization_members = {
        data: [{ user_id: 'owner-1' }, { user_id: 'admin-1' }],
      };
      // admin-1 also holds a custom role; member-1 holds one that adds the key;
      // member-2 holds one that does not.
      tables.user_role_assignments = {
        data: [
          { user_id: 'admin-1' },
          { user_id: 'member-1' },
          { user_id: 'member-2' },
        ],
      };
      checkPermission.mockImplementation((userId: string) =>
        Promise.resolve(userId !== 'member-2'),
      );
      tables.notifications = {
        data: [bell('owner-1'), bell('admin-1'), bell('member-1')],
      };
      tables.users = {
        data: [
          {
            id: 'owner-1',
            email: 'owner@x.io',
            first_name: 'Olga',
            language: 'de',
          },
          { id: 'admin-1', email: null, first_name: 'Adam', language: 'en' },
          {
            id: 'member-1',
            email: 'm@x.io',
            first_name: null,
            language: null,
          },
        ],
      };
    });

    it('asks only the people of that organization who can hold the key, each once', async () => {
      await service.notifyBudgetAlert('org-1', 80);

      expect(queries('organization_members')[0].calls).toEqual([
        ['select', ['user_id']],
        ['eq', ['organization_id', 'org-1']],
        ['in', ['role', ['owner', 'admin']]],
      ]);
      expect(queries('user_role_assignments')[0].calls).toEqual([
        ['select', ['user_id']],
        ['eq', ['organization_id', 'org-1']],
      ]);
      expect(checkPermission.mock.calls).toEqual([
        ['owner-1', 'org-1', 'can_manage_robert'],
        ['admin-1', 'org-1', 'can_manage_robert'],
        ['member-1', 'org-1', 'can_manage_robert'],
        ['member-2', 'org-1', 'can_manage_robert'],
      ]);
    });

    it('writes one bell entry per manager, without any text of a chat message', async () => {
      await service.notifyBudgetAlert('org-1', 80);

      const [[, [rows]]] = queries('notifications')[0].calls as [
        [string, [Record<string, unknown>[]]],
      ];

      expect(rows).toEqual(
        ['owner-1', 'admin-1', 'member-1'].map((userId) => ({
          organization_id: 'org-1',
          user_id: userId,
          type: 'robert_budget',
          title: "Robert has used 80% of this month's AI budget",
          body: null,
          is_read: false,
          action_status: 'none',
          metadata: { link: '/tenant-config?tab=configuration', threshold: 80 },
        })),
      );
      expect(
        (broadcastNotification.mock.calls as [unknown][]).map(([row]) => row),
      ).toEqual([bell('owner-1'), bell('admin-1'), bell('member-1')]);
    });

    it('sends one email to every manager who has an address, with a link to the AI settings', async () => {
      await service.notifyBudgetAlert('org-1', 100);

      expect(sendNotification.mock.calls).toEqual([
        [
          'owner@x.io',
          {
            title: "Robert's AI budget for this month is used up",
            subject: "Robert's AI budget for this month is used up",
            eyebrow: 'Robert',
            body: 'New requests to Robert are refused until the budget resets next month or the limit is raised in the AI settings.',
            ctaUrl: 'https://app.example.com/tenant-config?tab=configuration',
            ctaLabel: 'Open AI settings',
            recipientName: 'Olga',
          },
          { organizationId: 'org-1', locale: 'de' },
        ],
        [
          'm@x.io',
          expect.objectContaining({ recipientName: undefined }),
          { organizationId: 'org-1', locale: null },
        ],
      ]);
    });

    it('delivers nothing when nobody holds can_manage_robert', async () => {
      checkPermission.mockResolvedValue(false);

      await service.notifyBudgetAlert('org-1', 80);

      expect(queries('notifications')).toEqual([]);
      expect(sendNotification).not.toHaveBeenCalled();
    });

    it('still emails the others when one email fails', async () => {
      sendNotification.mockRejectedValueOnce(new Error('smtp down'));

      await expect(
        service.notifyBudgetAlert('org-1', 80),
      ).resolves.toBeUndefined();
      expect(sendNotification).toHaveBeenCalledTimes(2);
    });

    it.each(['organization_members', 'user_role_assignments', 'notifications'])(
      'never throws when %s fails: the run that caused the alert goes on',
      async (table) => {
        tables[table] = { data: null, error: { message: 'boom' } };

        await expect(
          service.notifyBudgetAlert('org-1', 100),
        ).resolves.toBeUndefined();
        expect(sendNotification).not.toHaveBeenCalled();
      },
    );
  });

  describe('notifyProviderProblem', () => {
    beforeEach(() => {
      tables.organization_members = {
        data: [{ user_id: 'owner-1' }, { user_id: 'admin-1' }],
      };
      tables.user_role_assignments = { data: [] };
      tables.notifications = [
        // No provider notice in the last 24 hours.
        { data: [] },
        {
          data: [
            { id: 'n-owner-1', user_id: 'owner-1' },
            { id: 'n-admin-1', user_id: 'admin-1' },
          ],
        },
      ];
    });

    it('writes one bell entry per manager, with no detail and no email', async () => {
      jest.useFakeTimers({ now: Date.parse('2026-10-22T10:00:00Z') });

      await service.notifyProviderProblem('org-1');

      const [check, insert] = queries('notifications');

      expect(check.calls).toEqual([
        ['select', ['id']],
        ['eq', ['organization_id', 'org-1']],
        ['eq', ['type', 'robert_provider']],
        ['gte', ['created_at', '2026-10-21T10:00:00.000Z']],
        ['limit', [1]],
      ]);
      expect(insert.calls[0]).toEqual([
        'insert',
        [
          ['owner-1', 'admin-1'].map((userId) => ({
            organization_id: 'org-1',
            user_id: userId,
            type: 'robert_provider',
            title:
              "Robert can't use your AI provider. Check the AI key in the AI settings.",
            body: null,
            is_read: false,
            action_status: 'none',
            metadata: { link: '/tenant-config?tab=configuration' },
          })),
        ],
      ]);
      expect(broadcastNotification).toHaveBeenCalledTimes(2);
      expect(sendNotification).not.toHaveBeenCalled();
    });

    it('rings at most once in 24 hours per organization', async () => {
      tables.notifications = [{ data: [{ id: 'n-earlier' }] }];

      await service.notifyProviderProblem('org-1');

      expect(queries('notifications')).toHaveLength(1);
      expect(asked()).not.toContain('organization_members');
      expect(broadcastNotification).not.toHaveBeenCalled();
    });

    it('rings nobody when nobody holds can_manage_robert', async () => {
      checkPermission.mockResolvedValue(false);

      await service.notifyProviderProblem('org-1');

      expect(queries('notifications')).toHaveLength(1);
    });

    it.each([
      ['the 24-hour check', 0],
      ['the insert', 1],
    ])('never throws when %s fails', async (_label, failing) => {
      (tables.notifications as Result[])[failing] = {
        data: null,
        error: { message: 'boom' },
      };

      await expect(
        service.notifyProviderProblem('org-1'),
      ).resolves.toBeUndefined();
      expect(broadcastNotification).not.toHaveBeenCalled();
    });

    it('never throws when the managers cannot be read', async () => {
      tables.organization_members = { data: null, error: { message: 'boom' } };

      await expect(
        service.notifyProviderProblem('org-1'),
      ).resolves.toBeUndefined();
      expect(queries('notifications')).toHaveLength(1);
    });
  });
});
