import { ConfigService } from '@nestjs/config';
import { OnPremUpdateNoticeCron } from './on-prem-update-notice.cron';
import type { UpdateState } from './interfaces/update-state.interface';
import { claimCronSlot } from '../common/utils/cron-claim';

// The daily-check claim has its own spec (cron-claim.spec.ts); granted here unless a test says not.
jest.mock('../common/utils/cron-claim', () => ({ claimCronSlot: jest.fn() }));
beforeEach(() => jest.mocked(claimCronSlot).mockResolvedValue('stamp'));

/**
 * Minimal PostgREST-shaped stub, in the style of on-premise-tenant.service.spec.ts.
 * Each table gets a queue of results consumed in call order, and every write is recorded so a
 * test can assert exactly what the cron did rather than how it did it.
 */
function makeClient(plan: Record<string, unknown[]> = {}) {
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
      // supabase-js query builders are thenable, so a query with no .single()/.limit()
      // terminator resolves simply by being awaited. The owners lookup does exactly that.
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(take(table)).then(resolve);
      chain.upsert = (payload: unknown) => {
        calls.push({ table, op: 'upsert', payload });
        return take(table);
      };
      chain.insert = (payload: unknown) => {
        calls.push({ table, op: 'insert', payload });
        const res = take(table) as Record<string, unknown>;
        // .insert(...).select() is used for notifications; .insert(...) alone for the claim.
        return Object.assign(Object.create(null) as object, res, {
          select: () => res,
        });
      };
      return chain;
    },
  };
  return { client, calls };
}

const AVAILABLE: UpdateState = {
  status: 'update_available',
  updaterReachable: true,
  updateAvailable: { any: true },
  targetVersions: { release: '1.1.27' },
  currentVersions: { backend: { ref: 'docker.io/x/xisuite-backend:1.1.25' } },
} as unknown as UpdateState;

function build(opts: {
  state?: UpdateState;
  plan?: Record<string, unknown[]>;
  orgId?: string | null;
  onPrem?: boolean;
}) {
  const { client, calls } = makeClient(opts.plan);
  const check = jest.fn().mockResolvedValue({ accepted: true });
  const getStatus = jest.fn().mockResolvedValue(opts.state ?? AVAILABLE);
  const broadcast = { broadcastNotification: jest.fn() };
  const email = { emailForNotifications: jest.fn() };

  const cron = new OnPremUpdateNoticeCron(
    {
      get: (k: string) =>
        k === 'onPrem.enabled' ? opts.onPrem !== false : undefined,
    } as unknown as ConfigService,
    { check, getStatus } as never,
    {
      resolveOrgId: jest.fn().mockResolvedValue(opts.orgId ?? 'org-1'),
    } as never,
    { getClient: () => client } as never,
    broadcast as never,
    email as never,
  );
  return { cron, calls, check, getStatus, broadcast, email };
}

/** The rows the cron inserts into `notifications` (as opposed to its cron_run_state claim). */
const notificationInserts = (
  calls: { table: string; op: string; payload?: unknown }[],
) => calls.filter((c) => c.table === 'notifications' && c.op === 'insert');

const OWNERS = {
  data: [
    {
      user_id: 'u1',
      users: { email: 'a@x.com', first_name: 'A', language: 'en' },
    },
    {
      user_id: 'u2',
      users: { email: 'b@x.com', first_name: 'B', language: 'de' },
    },
  ],
  error: null,
};

describe('OnPremUpdateNoticeCron', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['setTimeout'] }));
  afterEach(() => jest.useRealTimers());

  it('does nothing in SaaS mode', async () => {
    const { cron, calls, check } = build({ onPrem: false });
    await cron.notifyIfUpdateAvailable();
    expect(check).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('stays silent when the updater sidecar is unreachable', async () => {
    // A firewalled or stopped box must not mail the owners an error every night.
    const { cron, calls, check } = build({
      state: {
        status: 'deploy_unreachable',
        updaterReachable: false,
      } as UpdateState,
      plan: {
        cron_run_state: [],
      },
    });
    await cron.notifyIfUpdateAvailable();
    expect(check).not.toHaveBeenCalled();
    expect(notificationInserts(calls)).toHaveLength(0);
  });

  it('stays silent on Kubernetes, where upgrades are managed externally', async () => {
    const { cron, calls, check } = build({
      state: {
        status: 'managed_externally',
        updaterReachable: false,
      } as UpdateState,
    });
    await cron.notifyIfUpdateAvailable();
    expect(check).not.toHaveBeenCalled();
    expect(notificationInserts(calls)).toHaveLength(0);
  });

  it('notifies nobody when there is no update', async () => {
    const { cron, calls } = build({
      state: {
        status: 'no_update_available',
        updaterReachable: true,
        updateAvailable: { any: false },
      } as unknown as UpdateState,
      plan: {
        cron_run_state: [],
      },
    });
    await cron.notifyIfUpdateAvailable();
    expect(notificationInserts(calls)).toHaveLength(0);
  });

  it('notifies every owner once when an update is available', async () => {
    const { cron, calls, broadcast, email } = build({
      plan: {
        cron_run_state: [
          { data: null, error: null }, // claim insert succeeds
        ],
        organization_members: [OWNERS],
        notifications: [{ data: [{ id: 'n1' }, { id: 'n2' }], error: null }],
      },
    });
    await cron.notifyIfUpdateAvailable();

    const inserts = notificationInserts(calls);
    expect(inserts).toHaveLength(1);
    const rows = inserts[0].payload as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0].type).toBe('system_update_available');
    expect(rows[0].organization_id).toBe('org-1');
    // reference_id is a uuid column, so the version has to live in metadata.
    expect((rows[0].metadata as Record<string, unknown>).version).toBe(
      '1.1.27',
    );
    expect(broadcast.broadcastNotification).toHaveBeenCalledTimes(2);
    expect(email.emailForNotifications).toHaveBeenCalledTimes(1);
  });

  it('does not notify twice for the same version', async () => {
    // The claim row already exists -> unique_violation -> silence. This is the property that
    // stops a daily cron turning one release into a nightly mailshot.
    const { cron, calls, broadcast } = build({
      plan: {
        cron_run_state: [
          { data: null, error: { code: '23505', message: 'duplicate key' } },
        ],
        organization_members: [OWNERS],
      },
    });
    await cron.notifyIfUpdateAvailable();
    expect(notificationInserts(calls)).toHaveLength(0);
    expect(broadcast.broadcastNotification).not.toHaveBeenCalled();
  });

  it('skips the whole run when it already checked within 23 hours', async () => {
    const { cron, calls, check } = build({
      plan: {},
    });
    jest.mocked(claimCronSlot).mockResolvedValue(null);
    await cron.notifyIfUpdateAvailable();
    expect(check).not.toHaveBeenCalled();
    expect(notificationInserts(calls)).toHaveLength(0);
  });

  it('does not guess an organization when the tenant cannot be resolved', async () => {
    const { cron, calls } = build({
      orgId: null,
      plan: {
        cron_run_state: [{ data: null, error: null }],
      },
    });
    await cron.notifyIfUpdateAvailable();
    expect(notificationInserts(calls)).toHaveLength(0);
  });
});
