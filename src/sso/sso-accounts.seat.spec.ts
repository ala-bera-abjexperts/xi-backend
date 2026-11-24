/**
 * @fileoverview SSO JIT / SCIM seat checks: a new seat is needed only when the
 * person has no membership row and no pending invitation.
 */

import { SsoAccountsService } from './sso-accounts.service';

function serviceWith(opts: { member?: boolean; invite?: boolean }) {
  const assertSeatAvailable = jest.fn().mockResolvedValue(undefined);
  const from = jest.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'limit']) chain[m] = () => chain;
    chain.maybeSingle = () =>
      Promise.resolve({
        data:
          table === 'organization_members'
            ? opts.member
              ? { id: 'm' }
              : null
            : opts.invite
              ? { id: 'i' }
              : null,
        error: null,
      });

    return chain;
  });
  const service = new SsoAccountsService(
    { getClient: () => ({ from }) } as never,
    {} as never,
    {} as never,
    { assertSeatAvailable } as never,
  );

  return { service, assertSeatAvailable };
}

describe('SsoAccountsService.assertSeatForNewMember', () => {
  it('needs a seat for a brand-new person', async () => {
    const { service, assertSeatAvailable } = serviceWith({});
    await service.assertSeatForNewMember('org', 'user', 'A@x.io');
    expect(assertSeatAvailable).toHaveBeenCalledWith('org');
  });

  it('needs no seat for an existing member', async () => {
    const { service, assertSeatAvailable } = serviceWith({ member: true });
    await service.assertSeatForNewMember('org', 'user', 'a@x.io');
    expect(assertSeatAvailable).not.toHaveBeenCalled();
  });

  it('needs no seat when a pending invitation already holds one', async () => {
    const { service, assertSeatAvailable } = serviceWith({ invite: true });
    await service.assertSeatForNewMember('org', null, 'a@x.io');
    expect(assertSeatAvailable).not.toHaveBeenCalled();
  });
});
