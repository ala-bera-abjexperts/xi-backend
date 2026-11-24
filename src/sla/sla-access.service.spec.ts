import { SlaAccessService } from './sla-access.service';
const user: any = { userId: 'u', organizationId: 'o' };
function setup(
  data: any,
  grant: any = { isMember: true, permissions: { manage_sla: true } },
) {
  const q: any = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data, error: null }),
  };
  const db: any = { getClient: () => ({ from: () => q }) };
  const permissions: any = {
    getUserSpacePermissions: jest.fn().mockResolvedValue(grant),
  };
  return { service: new SlaAccessService(db, permissions), q, permissions };
}
describe('SLA access', () => {
  it('uses actual space organization before admin bypass', async () => {
    const { service, permissions } = setup({
      id: 's',
      organization_id: 'other',
    });
    await expect(
      service.authorizeSpace(user, 'o', 's', 'manage_sla'),
    ).rejects.toThrow('Space not found');
    expect(permissions.getUserSpacePermissions).not.toHaveBeenCalled();
  });
  it('requires explicit permission', async () => {
    const { service } = setup(
      { id: 's', organization_id: 'o' },
      { isAdmin: false, isMember: true, permissions: {}, basePermissions: {} },
    );
    await expect(
      service.authorizeSpace(user, 'o', 's', 'manage_sla'),
    ).rejects.toThrow();
  });
  it('denies task cross organization', async () => {
    const { service } = setup({ id: 't', organization_id: 'other' });
    await expect(service.authorizeTask(user, 't')).rejects.toThrow(
      'Task not found',
    );
  });
  it('checks view_tasks and feature permission', async () => {
    const { service } = setup({ id: 't', organization_id: 'o', space_id: 's' });
    const auth = jest.spyOn(service, 'authorizeSpace').mockResolvedValue();
    await service.authorizeTask(user, 't', 'publish_customer_replies');
    expect(auth.mock.calls.map((c) => c[3])).toEqual([
      'view_tasks',
      'publish_customer_replies',
    ]);
  });
  it('rejects failed permission reads', async () => {
    const { service, q } = setup(null);
    q.maybeSingle.mockResolvedValue({ error: { message: 'down' } });
    await expect(service.authorizeTask(user, 't')).rejects.toThrow('Unable');
    await expect(
      service.authorizeSpace(user, 'o', 's', 'view_sla'),
    ).rejects.toThrow('Unable');
  });
  it('allows verified admin space', async () => {
    const { service } = setup({ id: 's', organization_id: 'o' });
    await expect(
      service.authorizeSpace(user, 'o', 's', 'manage_sla'),
    ).resolves.toBeUndefined();
  });
});

describe('SLA visibility parity', () => {
  it.each([
    { is_archived: true, is_active: true },
    { is_archived: false, is_active: false },
  ])('denies unavailable spaces %j', async (state) => {
    const { service, permissions } = setup({
      id: 's',
      organization_id: 'o',
      ...state,
    });
    await expect(
      service.authorizeSpace(user, 'o', 's', 'view_sla'),
    ).rejects.toThrow('Space not found');
    expect(permissions.getUserSpacePermissions).not.toHaveBeenCalled();
  });
  it('respects explicit feature override denial', async () => {
    const { service } = setup(
      { id: 's', organization_id: 'o' },
      { isMember: true, permissions: { view_tasks: true, view_sla: false } },
    );
    await expect(
      service.authorizeSpace(user, 'o', 's', 'view_sla'),
    ).rejects.toThrow('Insufficient');
  });
});
