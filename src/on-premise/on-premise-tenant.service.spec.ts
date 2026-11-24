import { ConfigService } from '@nestjs/config';
import { OnPremiseTenantService } from './on-premise-tenant.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

/**
 * Minimal PostgREST-shaped stub. Each table gets a queue of results consumed in
 * call order, so a test states exactly what the DB returns without a real client.
 */
function makeClient(plan: Record<string, unknown[]>) {
  const calls: { table: string; op: string; payload?: unknown }[] = [];
  const queues: Record<string, unknown[]> = { ...plan };

  const take = (table: string) =>
    (queues[table] ?? []).shift() ?? { data: null, error: null };

  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const self = () => chain as never;

      chain.select = self;
      chain.eq = self;
      chain.limit = () => take(table);
      chain.maybeSingle = () => take(table);
      chain.upsert = (payload: unknown) => {
        calls.push({ table, op: 'upsert', payload });

        return take(table);
      };

      return chain;
    },
  };

  return { client, calls };
}

function makeService(
  cfg: Record<string, unknown>,
  plan: Record<string, unknown[]> = {},
) {
  const { client, calls } = makeClient(plan);
  const supabaseAdmin = {
    getClient: () => client,
  } as unknown as SupabaseAdminService;
  const configService = {
    get: (key: string) => cfg[key],
  } as unknown as ConfigService;

  return {
    service: new OnPremiseTenantService(supabaseAdmin, configService),
    calls,
    client,
  };
}

const ORG = 'org-1';
const USER = 'user-1';

describe('OnPremiseTenantService', () => {
  describe('cloud safety', () => {
    // The single most important test here: SaaS must be byte-for-byte unaffected.
    it('is an inert no-op off-premise — no queries, no writes', async () => {
      const getClient = jest.fn();
      const service = new OnPremiseTenantService(
        { getClient } as unknown as SupabaseAdminService,
        { get: () => false } as unknown as ConfigService,
      );

      await expect(
        service.ensureDefaultMembership(USER, 'a@b.c'),
      ).resolves.toBeNull();
      await expect(service.resolveOrgId()).resolves.toBeNull();
      expect(getClient).not.toHaveBeenCalled();
    });
  });

  describe('resolveOrgId', () => {
    it('prefers the pinned id', async () => {
      const { service } = makeService(
        { 'onPrem.enabled': true, 'onPrem.orgId': ORG },
        { organizations: [{ data: { id: ORG }, error: null }] },
      );

      await expect(service.resolveOrgId()).resolves.toBe(ORG);
    });

    it('falls back to the slug pin when no id is configured', async () => {
      const { service } = makeService(
        { 'onPrem.enabled': true, 'onPrem.orgSlug': 'acme' },
        { organizations: [{ data: { id: ORG }, error: null }] },
      );

      await expect(service.resolveOrgId()).resolves.toBe(ORG);
    });

    it('uses the sole organization when nothing is pinned', async () => {
      const { service } = makeService(
        { 'onPrem.enabled': true },
        { organizations: [{ data: [{ id: ORG }], error: null }] },
      );

      await expect(service.resolveOrgId()).resolves.toBe(ORG);
    });

    // Guessing here would attach users to an arbitrary tenant.
    it('refuses to guess when several orgs exist and nothing is pinned', async () => {
      const { service } = makeService(
        { 'onPrem.enabled': true },
        { organizations: [{ data: [{ id: 'a' }, { id: 'b' }], error: null }] },
      );

      await expect(service.resolveOrgId()).resolves.toBeNull();
    });

    // A fresh install seeds no organization; the first user must reach onboarding.
    it('returns null when no organization exists at all', async () => {
      const { service } = makeService(
        { 'onPrem.enabled': true },
        { organizations: [{ data: [], error: null }] },
      );

      await expect(service.resolveOrgId()).resolves.toBeNull();
    });
  });

  describe('ensureDefaultMembership', () => {
    const okPlan = (overrides: Record<string, unknown[]> = {}) => ({
      invitations: [{ data: [], error: null }],
      organizations: [
        { data: { id: ORG }, error: null }, // resolveOrgId (pinned lookup)
        { data: { id: ORG, is_active: true }, error: null }, // active check
      ],
      users: [{ data: { id: USER, is_active: true }, error: null }],
      organization_members: [{ data: null, error: null }],
      ...overrides,
    });

    it('joins the pinned org as "member" by default', async () => {
      const { service, calls } = makeService(
        { 'onPrem.enabled': true, 'onPrem.orgId': ORG },
        okPlan(),
      );

      await expect(
        service.ensureDefaultMembership(USER, 'a@b.c'),
      ).resolves.toBe(ORG);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        table: 'organization_members',
        payload: { organization_id: ORG, user_id: USER, role: 'member' },
      });
    });

    // A bad value in client.conf must degrade, not break every login.
    it('falls back to "member" when the configured role is invalid', async () => {
      const { service, calls } = makeService(
        {
          'onPrem.enabled': true,
          'onPrem.orgId': ORG,
          'onPrem.defaultRole': 'superuser',
        },
        okPlan(),
      );

      await service.ensureDefaultMembership(USER, 'a@b.c');
      expect(calls[0].payload).toMatchObject({ role: 'member' });
    });

    it('honours a valid configured role', async () => {
      const { service, calls } = makeService(
        {
          'onPrem.enabled': true,
          'onPrem.orgId': ORG,
          'onPrem.defaultRole': 'admin',
        },
        okPlan(),
      );

      await service.ensureDefaultMembership(USER, 'a@b.c');
      expect(calls[0].payload).toMatchObject({ role: 'admin' });
    });

    // Otherwise an admin invited by an owner would be silently downgraded.
    it('skips when a pending invitation exists — its role must win', async () => {
      const { service, calls } = makeService(
        { 'onPrem.enabled': true, 'onPrem.orgId': ORG },
        okPlan({ invitations: [{ data: [{ id: 'inv-1' }], error: null }] }),
      );

      await expect(
        service.ensureDefaultMembership(USER, 'a@b.c'),
      ).resolves.toBeNull();
      expect(calls).toHaveLength(0);
    });

    it('does not attach anyone to a deactivated organization', async () => {
      const { service, calls } = makeService(
        { 'onPrem.enabled': true, 'onPrem.orgId': ORG },
        okPlan({
          organizations: [
            { data: { id: ORG }, error: null },
            { data: { id: ORG, is_active: false }, error: null },
          ],
        }),
      );

      await expect(
        service.ensureDefaultMembership(USER, 'a@b.c'),
      ).resolves.toBeNull();
      expect(calls).toHaveLength(0);
    });

    it('does not silently reactivate a deactivated user', async () => {
      const { service, calls } = makeService(
        { 'onPrem.enabled': true, 'onPrem.orgId': ORG },
        okPlan({
          users: [{ data: { id: USER, is_active: false }, error: null }],
        }),
      );

      await expect(
        service.ensureDefaultMembership(USER, 'a@b.c'),
      ).resolves.toBeNull();
      expect(calls).toHaveLength(0);
    });

    // Otherwise the next login would undo an Entra deprovisioning.
    it('does not re-join a user SCIM deactivated in this org', async () => {
      const { service, calls } = makeService(
        { 'onPrem.enabled': true, 'onPrem.orgId': ORG },
        okPlan({ scim_links: [{ data: [{ id: 'link-1' }], error: null }] }),
      );

      await expect(
        service.ensureDefaultMembership(USER, 'a@b.c'),
      ).resolves.toBeNull();
      expect(calls).toHaveLength(0);
    });

    it('does nothing when the org cannot be resolved', async () => {
      const { service, calls } = makeService(
        { 'onPrem.enabled': true },
        okPlan({ organizations: [{ data: [], error: null }] }),
      );

      await expect(
        service.ensureDefaultMembership(USER, 'a@b.c'),
      ).resolves.toBeNull();
      expect(calls).toHaveLength(0);
    });

    // Tenant plumbing must never be able to break authentication.
    it('never throws when the insert fails', async () => {
      const { service } = makeService(
        { 'onPrem.enabled': true, 'onPrem.orgId': ORG },
        okPlan({
          organization_members: [{ data: null, error: { message: 'boom' } }],
        }),
      );

      await expect(
        service.ensureDefaultMembership(USER, 'a@b.c'),
      ).resolves.toBeNull();
    });

    it('ignores a blank user id', async () => {
      const { service, calls } = makeService(
        { 'onPrem.enabled': true, 'onPrem.orgId': ORG },
        okPlan(),
      );

      await expect(
        service.ensureDefaultMembership('', 'a@b.c'),
      ).resolves.toBeNull();
      expect(calls).toHaveLength(0);
    });
  });
});
