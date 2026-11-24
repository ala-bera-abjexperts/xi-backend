/**
 * @fileoverview Who the caller is, for the calendar rules.
 *
 * Read fresh on every request rather than copied into the calendar, so someone who leaves the
 * organization stops matching on the very next call. That is the property worth pinning here.
 */
import { CalendarPrincipalsService } from './calendar-principals.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('CalendarPrincipalsService', () => {
  let service: CalendarPrincipalsService;
  let chain: Record<string, jest.Mock>;
  let from: jest.Mock;

  const ORG = 'org-1';
  const USER = 'user-1';

  /** One membership lookup, answering with whatever role a case wants. */
  function membership(role: string | null) {
    const resolved = { data: role === null ? null : { role }, error: null };

    chain = {
      select: jest.fn(),
      eq: jest.fn(),
      maybeSingle: jest.fn().mockResolvedValue(resolved),
    };

    chain.select.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);

    from = jest.fn().mockReturnValue(chain);

    const supa = {
      getClient: () => ({ from }),
    } as unknown as SupabaseAdminService;

    service = new CalendarPrincipalsService(supa);
  }

  it('reads the membership of this organization only', async () => {
    membership('member');

    await service.resolve(USER, ORG);

    expect(from).toHaveBeenCalledWith('organization_members');
    expect(chain.eq).toHaveBeenCalledWith('organization_id', ORG);
    expect(chain.eq).toHaveBeenCalledWith('user_id', USER);
  });

  it('answers with the id it was asked about', async () => {
    membership('member');

    await expect(service.resolve(USER, ORG)).resolves.toEqual(
      expect.objectContaining({ userId: USER }),
    );
  });

  it.each(['owner', 'admin'])('treats %s as an organization administrator', async (role) => {
    membership(role);

    const principals = await service.resolve(USER, ORG);

    expect(principals.isOrgAdmin).toBe(true);
    expect(principals.isOrgMember).toBe(true);
  });

  it.each(['member', 'viewer'])('treats %s as a member but not an administrator', async (role) => {
    membership(role);

    const principals = await service.resolve(USER, ORG);

    expect(principals.isOrgAdmin).toBe(false);
    expect(principals.isOrgMember).toBe(true);
  });

  it('treats somebody with no membership row as neither', async () => {
    // Their users row survives when they leave, so this is what stops a stale share granting.
    membership(null);

    const principals = await service.resolve(USER, ORG);

    expect(principals.isOrgAdmin).toBe(false);
    expect(principals.isOrgMember).toBe(false);
  });

  it('asks again on every call rather than remembering the answer', async () => {
    membership('member');

    await service.resolve(USER, ORG);
    await service.resolve(USER, ORG);

    expect(from).toHaveBeenCalledTimes(2);
  });
});
