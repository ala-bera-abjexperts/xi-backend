import {
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { SsoAccountsService } from './sso-accounts.service';

type Result = { data: unknown; error: unknown };

/** Chainable Supabase query stub that resolves to `result`. */
function query(result: Result = { data: null, error: null }) {
  const q: Record<string, jest.Mock> & {
    then: (resolve: (r: Result) => unknown) => Promise<unknown>;
  } = {
    then: (resolve) => Promise.resolve(result).then(resolve),
  } as never;

  for (const method of [
    'select',
    'insert',
    'update',
    'upsert',
    'delete',
    'eq',
    'is',
    'not',
    'in',
  ]) {
    q[method] = jest.fn(() => q);
  }

  q.single = jest.fn(() => Promise.resolve(result));
  q.maybeSingle = jest.fn(() => Promise.resolve(result));

  return q;
}

function make() {
  const queues: Record<string, ReturnType<typeof query>[]> = {};
  const createUser = jest.fn();
  const deleteUser = jest.fn().mockResolvedValue({ error: null });
  const client = {
    from: jest.fn((table: string) => queues[table]?.shift() ?? query()),
    auth: { admin: { createUser, deleteUser } },
  };
  const usersService = {
    getUserById: jest.fn().mockResolvedValue(null),
  };
  const permissionsService = { bustUser: jest.fn() };
  const service = new SsoAccountsService(
    { getClient: () => client } as never,
    usersService as never,
    permissionsService as never,
  );
  const enqueue = (table: string, ...builders: ReturnType<typeof query>[]) => {
    queues[table] = [...(queues[table] ?? []), ...builders];
  };

  return {
    service,
    client,
    createUser,
    usersService,
    permissionsService,
    enqueue,
  };
}

describe('SsoAccountsService', () => {
  it('normalises emails and extracts the domain after the last @', () => {
    const { service } = make();

    expect(service.normalizeEmail('  Jane@Example.COM ')).toBe(
      'jane@example.com',
    );
    expect(service.emailDomain('a@b@Corp.Example.com')).toBe(
      'corp.example.com',
    );
    expect(service.emailDomain('no-at-sign')).toBeNull();
  });

  describe('findUserByEmail', () => {
    it('looks the user up by normalised email', async () => {
      const { service, enqueue } = make();
      const user = { id: 'u1', email: 'jane@example.com' };
      const lookup = query({ data: user, error: null });
      enqueue('users', lookup);

      await expect(service.findUserByEmail(' Jane@Example.com ')).resolves.toBe(
        user,
      );
      expect(lookup.eq).toHaveBeenCalledWith('email', 'jane@example.com');
    });

    it('throws on a DB error instead of reporting no account', async () => {
      const { service, enqueue } = make();
      enqueue('users', query({ data: null, error: { message: 'timeout' } }));

      await expect(
        service.findUserByEmail('jane@example.com'),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('createAccount', () => {
    it.each([
      { code: 'email_exists', message: 'whatever' },
      {
        message: 'A user with this email address has already been registered',
      },
    ])(
      'refuses an existing auth user with account_conflict (%o)',
      async (error) => {
        const { service, createUser, client } = make();
        createUser.mockResolvedValue({ data: { user: null }, error });

        await expect(
          service.createAccount('jane@example.com', {}),
        ).rejects.toThrow(new ConflictException('account_conflict'));
        expect(client.from).not.toHaveBeenCalled();
      },
    );

    it('inserts the profile by normalised email without touching is_active', async () => {
      const { service, createUser, enqueue } = make();
      const profile = { id: 'u1', email: 'jane@example.com' };
      const lookup = query();
      const insert = query({ data: profile, error: null });
      createUser.mockResolvedValue({
        data: { user: { id: 'auth-1' } },
        error: null,
      });
      enqueue('users', lookup, insert);

      await expect(
        service.createAccount(' Jane@Example.com ', {
          firstName: 'Jane',
          lastName: ' ',
        }),
      ).resolves.toBe(profile);

      expect(createUser).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'jane@example.com',
          email_confirm: true,
        }),
      );
      expect(lookup.eq).toHaveBeenCalledWith('email', 'jane@example.com');
      expect(insert.insert).toHaveBeenCalledWith({
        email: 'jane@example.com',
        first_name: 'Jane',
        last_name: null,
        auth_user_id: 'auth-1',
      });
    });

    it('removes the new auth user when the profile belongs to another auth user', async () => {
      const { service, createUser, client, enqueue } = make();
      createUser.mockResolvedValue({
        data: { user: { id: 'auth-new' } },
        error: null,
      });
      enqueue(
        'users',
        query({ data: { id: 'u1', auth_user_id: 'auth-old' }, error: null }),
      );

      await expect(
        service.createAccount('jane@example.com', {}),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(client.auth.admin.deleteUser).toHaveBeenCalledWith('auth-new');
    });
  });

  it('attachMember upserts ignoring duplicates, expires invitations and busts permissions', async () => {
    const { service, permissionsService, enqueue } = make();
    const members = query();
    const invitations = query();
    enqueue('organization_members', members);
    enqueue('invitations', invitations);

    await service.attachMember('org-1', 'u1', ' Jane@Example.com');

    expect(members.upsert).toHaveBeenCalledWith(
      { organization_id: 'org-1', user_id: 'u1', role: 'member' },
      { onConflict: 'organization_id,user_id', ignoreDuplicates: true },
    );
    expect(invitations.update).toHaveBeenCalledWith({ status: 'expired' });
    expect(invitations.eq).toHaveBeenCalledWith('organization_id', 'org-1');
    expect(invitations.eq).toHaveBeenCalledWith('status', 'pending');
    expect(invitations.eq).toHaveBeenCalledWith('email', 'jane@example.com');
    expect(permissionsService.bustUser).toHaveBeenCalledWith('u1', 'org-1');
  });

  describe('isDomainBoundToConnection', () => {
    it('queries only verified domains of this org bound to this connection', async () => {
      const { service, enqueue } = make();
      const domains = query({ data: { id: 'd1' }, error: null });
      enqueue('sso_domains', domains);

      await expect(
        service.isDomainBoundToConnection('org-1', 'conn-1', 'j@Example.com'),
      ).resolves.toBe(true);
      expect(domains.eq).toHaveBeenCalledWith('organization_id', 'org-1');
      expect(domains.eq).toHaveBeenCalledWith('domain', 'example.com');
      expect(domains.eq).toHaveBeenCalledWith('connection_id', 'conn-1');
      expect(domains.not).toHaveBeenCalledWith('verified_at', 'is', null);
    });

    it('is false for an unverified or other-connection domain (no matching row)', async () => {
      const { service, enqueue } = make();
      enqueue('sso_domains', query());

      await expect(
        service.isDomainBoundToConnection('org-1', 'conn-2', 'j@example.com'),
      ).resolves.toBe(false);
    });

    it('is false without a connection or a domain, without querying', async () => {
      const { service, client } = make();

      await expect(
        service.isDomainBoundToConnection('org-1', '', 'j@example.com'),
      ).resolves.toBe(false);
      await expect(
        service.isDomainBoundToConnection('org-1', 'conn-1', 'not-an-email'),
      ).resolves.toBe(false);
      expect(client.from).not.toHaveBeenCalled();
    });
  });
});
