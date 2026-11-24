import { BadRequestException } from '@nestjs/common';
import { AdminTenantsService } from './admin-tenants.service';

describe('AdminTenantsService', () => {
  it('rejects tenant user creation without password when send_invite is false', async () => {
    const from = jest.fn();
    const service = new AdminTenantsService(
      { getClient: () => ({ from }) } as never,
      { logAction: jest.fn() } as never,
      { bustOrg: jest.fn() } as never,
    );

    await expect(
      service.createTenantUser(
        'tenant-1',
        {
          email: 'person@example.com',
          first_name: 'Person',
          last_name: 'Example',
          role: 'member',
          send_invite: false,
        },
        'actor-1',
      ),
    ).rejects.toThrow(BadRequestException);

    expect(from).not.toHaveBeenCalled();
  });

  describe('deleteTenantUser', () => {
    function setup(rpcResult: { data?: unknown; error?: { message: string } }) {
      const bustOrg = jest.fn();
      const rpc = jest.fn().mockResolvedValue(rpcResult);
      const service = new AdminTenantsService(
        { getClient: () => ({ rpc }) } as never,
        { logAction: jest.fn() } as never,
        { bustOrg } as never,
      );

      jest
        .spyOn(service as never, 'fetchTenantUser')
        .mockResolvedValue({ membership_role: 'member' } as never);
      jest
        .spyOn(service as never, 'audit')
        .mockResolvedValue(undefined as never);

      return { service, bustOrg };
    }

    it('drops the cached permissions of the tenant, so a removed member loses access now', async () => {
      const { service, bustOrg } = setup({ data: { counts: {} } });

      await service.deleteTenantUser('tenant-1', 'user-1', 'actor-1');

      expect(bustOrg).toHaveBeenCalledWith('tenant-1');
    });

    it('notes the spaces they alone owned, and removes them all the same', async () => {
      const rows = [{ data: [{ space_id: 'space-1' }] }, { data: [] }];
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'neq']) chain[m] = () => chain;
      chain.then = (done: (r: unknown) => unknown) => Promise.resolve(rows.shift()).then(done);
      const rpc = jest.fn().mockResolvedValue({ data: { counts: {} } });
      const service = new AdminTenantsService(
        { getClient: () => ({ rpc, from: () => chain }) } as never,
        { logAction: jest.fn() } as never,
        { bustOrg: jest.fn() } as never,
      );
      jest.spyOn(service as never, 'fetchTenantUser').mockResolvedValue({ membership_role: 'member' } as never);
      const audit = jest.spyOn(service as never, 'audit').mockResolvedValue(undefined as never);

      await service.deleteTenantUser('tenant-1', 'user-1', 'actor-1');

      expect(rpc).toHaveBeenCalled();
      expect(JSON.stringify(audit.mock.calls[0])).toContain('"spaces_left_without_owner":["space-1"]');
    });

    it('leaves the cache alone when the removal failed', async () => {
      const { service, bustOrg } = setup({
        error: { message: 'LAST_ACTIVE_OWNER' },
      });

      await expect(
        service.deleteTenantUser('tenant-1', 'user-1', 'actor-1'),
      ).rejects.toThrow(BadRequestException);
      expect(bustOrg).not.toHaveBeenCalled();
    });
  });
});
