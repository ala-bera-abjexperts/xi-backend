/**
 * @fileoverview The warn-only plan-limit check.
 * @module licensing/check-limit.spec
 *
 * Author: Prince Jadiya
 *
 * WHY THIS EXISTS
 * `limit_spaces`, `limit_users`, `limit_storage_mb`,
 * `limit_custom_fields_per_space` and `limit_automations` have been in the
 * catalog and on the price list since licensing shipped, and no production code
 * path ever called `getLimit()`. Every numeric limit was sold and unenforced.
 *
 * Turning them into hard blocks in one step would refuse creates for tenants
 * already over a ceiling nobody told them about. So `checkLimit` warns and
 * returns a verdict instead. The properties that make that safe are the ones
 * tested here:
 *
 *  1. it never throws, whatever the counts say;
 *  2. it never runs the count query when no finite limit applies, so an
 *     unlimited or grandfathered tenant pays nothing for it;
 *  3. it counts the create being made, not just the rows already there
 *     (at limit N, the (N+1)th create is the breach, not the Nth).
 */

import { EntitlementsService } from './entitlements.service';

type FakeEntitlements = { getLimit: (key: string) => number | null };

/**
 * A real instance so the method under test is the real one, with only
 * `getEffectiveEntitlements` stubbed. `Object.create` rather than `new` because
 * the constructor wants the repository, which this path never touches.
 */
function serviceWithLimit(limit: number | null) {
  const service = Object.create(
    EntitlementsService.prototype,
  ) as EntitlementsService;

  Object.assign(service, {
    getEffectiveEntitlements: (): Promise<FakeEntitlements> =>
      Promise.resolve({ getLimit: () => limit }),
    logger: { warn: jest.fn() },
  });

  return service;
}

describe('EntitlementsService.checkLimit', () => {
  it('skips the count entirely when no finite limit applies', async () => {
    const count = jest.fn<Promise<number>, []>();
    const service = serviceWithLimit(null);

    const verdict = await service.checkLimit('org-1', 'limit_spaces', count);

    // Unlimited plans and grandfathered tenants must not pay for a COUNT(*) on
    // every create.
    expect(count).not.toHaveBeenCalled();
    expect(verdict).toEqual({
      key: 'limit_spaces',
      limit: null,
      current: null,
      exceeded: false,
    });
  });

  it('allows the create that lands exactly on the limit', async () => {
    // limit 3, two rows exist: this create is the 3rd and is within the plan.
    const service = serviceWithLimit(3);

    const verdict = await service.checkLimit('org-1', 'limit_spaces', () =>
      Promise.resolve(2),
    );

    expect(verdict.exceeded).toBe(false);
    expect(verdict.current).toBe(2);
  });

  it('flags the create that goes one past the limit', async () => {
    // limit 3, three rows exist: this create is the 4th.
    const service = serviceWithLimit(3);

    const verdict = await service.checkLimit('org-1', 'limit_spaces', () =>
      Promise.resolve(3),
    );

    expect(verdict.exceeded).toBe(true);
    expect(verdict.limit).toBe(3);
    expect(verdict.current).toBe(3);
  });

  it('flags a tenant already far over the limit', async () => {
    const service = serviceWithLimit(5);

    const verdict = await service.checkLimit('org-1', 'limit_users', () =>
      Promise.resolve(97),
    );

    expect(verdict.exceeded).toBe(true);
  });

  it('handles a zero limit', async () => {
    // A plan that includes none of a feature: the very first create is a breach.
    const service = serviceWithLimit(0);

    const verdict = await service.checkLimit('org-1', 'limit_automations', () =>
      Promise.resolve(0),
    );

    expect(verdict.exceeded).toBe(true);
  });

  it('does not throw when the limit is exceeded', async () => {
    // The whole point of the warn-only phase. If this ever starts throwing, a
    // create path that has been working for every over-limit tenant begins
    // failing for them with no migration and no notice.
    const service = serviceWithLimit(1);

    await expect(
      service.checkLimit('org-1', 'limit_spaces', () => Promise.resolve(999)),
    ).resolves.toMatchObject({ exceeded: true });
  });

  it('logs exactly one warning per breach and none otherwise', async () => {
    const over = serviceWithLimit(1);
    const under = serviceWithLimit(10);
    const warnOver = (over as unknown as { logger: { warn: jest.Mock } }).logger
      .warn;
    const warnUnder = (under as unknown as { logger: { warn: jest.Mock } })
      .logger.warn;

    await over.checkLimit('org-1', 'limit_spaces', () => Promise.resolve(5));
    await under.checkLimit('org-2', 'limit_spaces', () => Promise.resolve(5));

    expect(warnOver).toHaveBeenCalledTimes(1);
    expect(warnUnder).not.toHaveBeenCalled();

    // The log line is the instrument used to size the affected population
    // before enforcement is switched on, so it must carry org, key and numbers.
    const line = String((warnOver.mock.calls[0] as unknown[])[0]);

    expect(line).toContain('[limit-exceeded]');
    expect(line).toContain('org=org-1');
    expect(line).toContain('key=limit_spaces');
    expect(line).toContain('limit=1');
    expect(line).toContain('current=5');
  });
});

describe('EntitlementsService seat enforcement (licensing audit D1)', () => {
  function seatService(limit: number | null, seatsInUse: number) {
    const service = serviceWithLimit(limit);
    const countSeatsInUse = jest.fn().mockResolvedValue(seatsInUse);
    Object.assign(service, { repository: { countSeatsInUse } });

    return { service, countSeatsInUse };
  }

  it('refuses a new seat past limit_users with 403 LIMIT_EXCEEDED', async () => {
    const { service } = seatService(5, 5);

    const error = (await service
      .assertSeatAvailable('org-1')
      .catch((e: unknown) => e)) as {
      getStatus: () => number;
      getResponse: () => { code: string };
    };

    expect(error.getStatus()).toBe(403);
    expect(error.getResponse().code).toBe('LIMIT_EXCEEDED');
  });

  it('allows the last free seat', async () => {
    const { service } = seatService(5, 4);

    await expect(service.assertSeatAvailable('org-1')).resolves.toBeUndefined();
  });

  it('never blocks (or counts) when the tenant is unlimited', async () => {
    const { service, countSeatsInUse } = seatService(null, 999);

    await expect(service.assertSeatAvailable('org-1')).resolves.toBeUndefined();
    expect(countSeatsInUse).not.toHaveBeenCalled();
  });

  it('keeps the other limits warn-only', async () => {
    const service = serviceWithLimit(3);

    await expect(
      service.checkLimit('org-1', 'limit_spaces', () => Promise.resolve(10)),
    ).resolves.toMatchObject({ exceeded: true });
  });
});
