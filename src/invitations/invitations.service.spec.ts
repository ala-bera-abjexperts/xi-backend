import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InvitationsService } from './invitations.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('InvitationsService', () => {
  let service: InvitationsService;
  let mockQueryResults: Map<
    string,
    Array<{ data: unknown; error: unknown; count?: number }>
  >;
  let mockGenerateLink: jest.Mock;
  let mockRpc: jest.Mock;
  let mockAuditLogsService: { logAction: jest.Mock };

  function setQueryResult(
    table: string,
    data: unknown,
    error: unknown = null,
    count?: number,
  ) {
    const queue = mockQueryResults.get(table) ?? [];
    queue.push({ data, error, count });
    mockQueryResults.set(table, queue);
  }

  beforeEach(() => {
    mockQueryResults = new Map();
    mockGenerateLink = jest.fn().mockResolvedValue({
      data: { properties: { action_link: 'https://example.com/invite' } },
      error: null,
    });
    // acceptInvitation performs all per-invitation writes (activate user,
    // organization_members, space_members, mark accepted) in the
    // accept_invitation_atomic RPC rather than as discrete `from()` writes.
    mockRpc = jest.fn().mockResolvedValue({
      data: {
        organization_id: 'org-1',
        space_id: null,
        default_space_id: null,
        invited_by: 'user-1',
      },
      error: null,
    });
    mockAuditLogsService = {
      logAction: jest.fn().mockResolvedValue(undefined),
    };

    const mockFrom = jest.fn().mockImplementation((table: string) => {
      const queue = mockQueryResults.get(table);
      const result = queue?.length
        ? queue.length > 1
          ? queue.shift()!
          : queue[0]
        : {
            data: null,
            error: null,
          };
      return {
        select: jest.fn().mockReturnThis(),
        insert: jest.fn().mockReturnThis(),
        upsert: jest.fn().mockResolvedValue(result),
        update: jest.fn().mockReturnThis(),
        delete: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        is: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue(result),
        single: jest.fn().mockResolvedValue(result),
        order: jest.fn().mockReturnThis(),
        range: jest.fn().mockResolvedValue({
          data: result.data ? [result.data] : [],
          error: result.error,
          count: result.count ?? (result.data ? 1 : 0),
        }),
      };
    });

    const supabaseAdmin = {
      createAuthClient: () => ({
        auth: {
          signInWithPassword: jest.fn(),
        },
      }),
      getClient: () => ({
        auth: {
          admin: {
            generateLink: mockGenerateLink,
            createUser: jest.fn(),
            updateUserById: jest.fn(),
            listUsers: jest.fn(),
            deleteUser: jest.fn(),
          },
        },
        from: mockFrom,
        rpc: mockRpc,
      }),
    } as unknown as SupabaseAdminService;

    const configService = {
      get: jest.fn().mockReturnValue('http://localhost:3000'),
    } as unknown as ConfigService;

    service = new InvitationsService(
      supabaseAdmin,
      configService,
      mockAuditLogsService as any,
    );
  });

  describe('createOrgInvitation', () => {
    it('returns an app-owned invitation link without generating a Supabase Auth invite link', async () => {
      setQueryResult('users', null);
      setQueryResult('invitations', null);
      setQueryResult('invitations', {
        id: 'inv-1',
        organization_id: 'org-1',
        invited_by: 'user-1',
        email: 'test@example.com',
        role: 'admin',
        first_name: 'Test',
        last_name: 'User',
        token: 'app-token',
        status: 'pending',
        expires_at: '2099-01-01',
      });
      setQueryResult('organizations', { name: 'Test Org' });

      const result = await service.createOrgInvitation({
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
        organizationId: 'org-1',
        role: 'admin',
        invitedByUserId: 'user-1',
      });

      expect(result.invitationLink).toMatch(
        /^http:\/\/localhost:3000\/auth\/accept-invitation\?token=[a-f0-9]{64}$/,
      );
      expect(result.invitationLink).not.toContain('/auth/v1/verify');
      expect(mockGenerateLink).not.toHaveBeenCalled();
      expect(mockAuditLogsService.logAction).toHaveBeenCalledWith(
        'org-1',
        'user-1',
        'invitation',
        'inv-1',
        'create',
        expect.objectContaining({ email: 'test@example.com', role: 'admin' }),
      );
    });
  });

  describe('listInvitations', () => {
    it('should cap limit at 100', async () => {
      setQueryResult('invitations', []);
      const result = await service.listInvitations('org-1', 1, 999999);
      expect(result.limit).toBe(100);
    });

    it('should enforce minimum page of 1', async () => {
      setQueryResult('invitations', []);
      const result = await service.listInvitations('org-1', -5, 10);
      expect(result.page).toBe(1);
    });

    it('should return paginated data', async () => {
      setQueryResult('invitations', { id: 'inv-1' }, null, 1);
      const result = await service.listInvitations('org-1', 1, 50);
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('should only list organization-level invitations', async () => {
      setQueryResult('invitations', []);
      await service.listInvitations('org-1', 1, 50);
      const client = (service as unknown as { client: { from: jest.Mock } })
        .client;
      const query = client.from.mock.results.at(-1)?.value as Record<
        string,
        jest.Mock
      >;

      expect(query['is']).toHaveBeenCalledWith('space_id', null);
    });

    it('should use default values when no params', async () => {
      setQueryResult('invitations', []);
      const result = await service.listInvitations('org-1');
      expect(result.page).toBe(1);
      expect(result.limit).toBe(50);
    });
  });

  describe('getByToken', () => {
    it('should return invitation with org name', async () => {
      setQueryResult('invitations', {
        id: 'inv-1',
        email: 'test@example.com',
        status: 'pending',
        expires_at: '2099-01-01',
        space_id: null,
        space_role: 'member',
        organization_id: 'org-1',
        first_name: 'Test',
        last_name: 'User',
        role: 'member',
      });
      setQueryResult('organizations', { name: 'Test Org' });

      const result = await service.getByToken('valid-token');
      expect(result.email).toBe('test@example.com');
      expect(result.organization_name).toBe('Test Org');
    });

    it('should throw NotFoundException for invalid token', async () => {
      setQueryResult('invitations', null, { message: 'not found' });
      await expect(service.getByToken('bad-token')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('acceptInvitation', () => {
    const validInvitation = {
      id: 'inv-1',
      token: 'correct-token',
      status: 'pending',
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      space_id: null,
      space_role: 'member',
      space_permissions: null,
      email: 'test@example.com',
      organization_id: 'org-1',
      invited_by: 'user-1',
      role: 'member',
      first_name: 'Test',
      last_name: 'User',
      created_at: '2024-01-01',
      accepted_at: null,
      declined_at: null,
      custom_role_id: null,
    };

    it('should accept with correct token', async () => {
      setQueryResult('invitations', validInvitation);
      setQueryResult('users', {
        id: 'user-1',
        email: validInvitation.email,
        organization_id: null,
      });
      setQueryResult('notifications', null);
      const result = await service.acceptInvitation('inv-1', 'correct-token');
      expect(result.success).toBe(true);
      // Membership writes are delegated wholesale to the atomic RPC.
      expect(mockRpc).toHaveBeenCalledWith('accept_invitation_atomic', {
        p_invitation_id: 'inv-1',
        p_token: 'correct-token',
        p_user_id: 'user-1',
        p_space_perms: null,
      });
    });

    it('should reject wrong token with ForbiddenException', async () => {
      setQueryResult('invitations', validInvitation);
      await expect(
        service.acceptInvitation('inv-1', 'wrong-token'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject expired invitation with BadRequestException', async () => {
      setQueryResult('invitations', {
        ...validInvitation,
        expires_at: new Date(Date.now() - 86400000).toISOString(),
      });
      await expect(
        service.acceptInvitation('inv-1', 'correct-token'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject non-pending invitation', async () => {
      setQueryResult('invitations', {
        ...validInvitation,
        status: 'accepted',
      });
      await expect(
        service.acceptInvitation('inv-1', 'correct-token'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException when not found', async () => {
      setQueryResult('invitations', null, { message: 'not found' });
      await expect(
        service.acceptInvitation('inv-1', 'any-token'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('resendInvitation', () => {
    const existingInvitation = {
      id: 'inv-1',
      organization_id: 'org-1',
      status: 'pending',
      email: 'test@example.com',
      first_name: 'Test',
      last_name: 'User',
      role: 'member',
      token: 'old-token',
      expires_at: '2024-01-01',
      space_id: null,
      invited_by: 'user-1',
    };

    it('should resend successfully', async () => {
      setQueryResult('invitations', existingInvitation);
      setQueryResult('organizations', { name: 'Test Org' });
      const result = await service.resendInvitation('inv-1', 'org-1');
      expect(result.organizationName).toBe('Test Org');
      expect(result.invitationLink).toContain(
        'http://localhost:3000/auth/accept-invitation?token=',
      );
      expect(result.invitationLink).not.toContain('/auth/v1/verify');
      expect(mockGenerateLink).not.toHaveBeenCalled();
    });

    it('should reject wrong organization with ForbiddenException', async () => {
      setQueryResult('invitations', existingInvitation);
      await expect(
        service.resendInvitation('inv-1', 'wrong-org'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject accepted invitation with BadRequestException', async () => {
      setQueryResult('invitations', {
        ...existingInvitation,
        status: 'accepted',
      });
      await expect(service.resendInvitation('inv-1', 'org-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException when not found', async () => {
      setQueryResult('invitations', null, { message: 'not found' });
      await expect(service.resendInvitation('inv-1', 'org-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('deleteInvitation', () => {
    it('should delete successfully', async () => {
      setQueryResult('invitations', {
        id: 'inv-1',
        organization_id: 'org-1',
        email: 'test@example.com',
        status: 'accepted',
      });
      const result = await service.deleteInvitation('inv-1', 'org-1');
      expect(result.success).toBe(true);
    });

    it('should reject wrong organization with ForbiddenException', async () => {
      setQueryResult('invitations', {
        id: 'inv-1',
        organization_id: 'org-1',
        email: 'test@example.com',
        status: 'pending',
      });
      await expect(
        service.deleteInvitation('inv-1', 'wrong-org'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException when not found', async () => {
      setQueryResult('invitations', null, { message: 'not found' });
      await expect(service.deleteInvitation('inv-1', 'org-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('revokeInvitation', () => {
    it('should revoke pending invitations in the current organization', async () => {
      setQueryResult('invitations', {
        id: 'inv-1',
        organization_id: 'org-1',
        email: 'test@example.com',
        status: 'pending',
      });
      setQueryResult('users', null);

      const result = await service.revokeInvitation('inv-1', 'org-1');
      expect(result.id).toBe('inv-1');
    });

    it('should reject accepted invitations', async () => {
      setQueryResult('invitations', {
        id: 'inv-1',
        organization_id: 'org-1',
        email: 'test@example.com',
        status: 'accepted',
      });

      await expect(service.revokeInvitation('inv-1', 'org-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('migration placeholders (XE-T682)', () => {
    type Result = { data: unknown; error: unknown };

    /**
     * A client whose every chain is awaitable. `results[table]` is consumed in call order; the last entry
     * repeats. Every write is recorded so the claim can be asserted.
     */
    function buildPlaceholderService(
      results: Record<string, Result[]>,
      rpc: jest.Mock,
      extras: unknown[] = [],
    ) {
      const writes: Array<{ table: string; op: string; payload?: unknown }> =
        [];
      const from = jest.fn((table: string) => {
        const queue = results[table] ?? [{ data: null, error: null }];
        const result = queue.length > 1 ? queue.shift()! : queue[0];
        const chain: Record<string, unknown> = {};
        for (const name of [
          'select',
          'eq',
          'in',
          'limit',
          'order',
          'is',
          'contains',
        ]) {
          chain[name] = jest.fn(() => chain);
        }
        chain.update = jest.fn((payload: unknown) => {
          writes.push({ table, op: 'update', payload });
          return chain;
        });
        chain.insert = jest.fn((payload: unknown) => {
          writes.push({ table, op: 'insert', payload });
          return chain;
        });
        chain.maybeSingle = jest.fn().mockResolvedValue(result);
        chain.single = jest.fn().mockResolvedValue(result);
        chain.then = (resolve: (v: Result) => unknown) => resolve(result);
        return chain;
      });
      const supabaseAdmin = {
        createAuthClient: () => ({ auth: {} }),
        getClient: () => ({ auth: { admin: {} }, from, rpc }),
      } as unknown as SupabaseAdminService;
      const svc = new InvitationsService(
        supabaseAdmin,
        {
          get: jest.fn().mockReturnValue('http://localhost:3000'),
        } as unknown as ConfigService,
        mockAuditLogsService as any,
        undefined,
        undefined,
        ...(extras as []),
      );
      return { svc, writes };
    }

    const invitation = {
      id: 'inv-1',
      token: 'tok',
      status: 'pending',
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      space_id: null,
      space_permissions: null,
      email: 'Jane@Example.com',
      organization_id: 'org-1',
      invited_by: 'admin-1',
      role: 'member',
      first_name: 'Jane',
      last_name: 'Doe',
    };
    const acceptRpc = {
      data: { organization_id: 'org-1', default_space_id: null },
      error: null,
    };

    it('lets an admin invite the email a placeholder member holds', async () => {
      const { svc } = buildPlaceholderService(
        {
          users: [
            {
              data: {
                id: 'ph-1',
                email: 'jane@example.com',
                auth_user_id: null,
              },
              error: null,
            },
          ],
          organization_members: [{ data: { id: 'm-1' }, error: null }],
          migration_entity_map: [{ data: [{ id: 'map-1' }], error: null }],
          invitations: [
            { data: null, error: null },
            { data: { id: 'inv-1', token: 't' }, error: null },
          ],
          organizations: [{ data: { name: 'Org' }, error: null }],
        },
        jest.fn(),
      );

      await expect(
        svc.createOrgInvitation({
          email: 'jane@example.com',
          firstName: 'Jane',
          lastName: 'Doe',
          organizationId: 'org-1',
          role: 'member',
          invitedByUserId: 'admin-1',
        }),
      ).resolves.toMatchObject({ organizationName: 'Org' });
    });

    it('lets an admin invite over an orphaned synthetic-address placeholder without a crosswalk row', async () => {
      const { svc } = buildPlaceholderService(
        {
          users: [
            {
              data: {
                id: 'ph-1',
                email: 'mig-a-b@placeholder.invalid',
                auth_user_id: null,
              },
              error: null,
            },
          ],
          organization_members: [{ data: { id: 'm-1' }, error: null }],
          migration_entity_map: [{ data: [], error: null }],
          invitations: [
            { data: null, error: null },
            { data: { id: 'inv-1', token: 't' }, error: null },
          ],
          organizations: [{ data: { name: 'Org' }, error: null }],
        },
        jest.fn(),
      );

      await expect(
        svc.createOrgInvitation({
          email: 'mig-a-b@placeholder.invalid',
          firstName: 'A',
          lastName: 'B',
          organizationId: 'org-1',
          role: 'member',
          invitedByUserId: 'admin-1',
        }),
      ).resolves.toMatchObject({ organizationName: 'Org' });
    });

    it('still refuses to invite a real member twice', async () => {
      const { svc } = buildPlaceholderService(
        {
          users: [
            {
              data: {
                id: 'u-1',
                email: 'jane@example.com',
                auth_user_id: 'auth-1',
              },
              error: null,
            },
          ],
          organization_members: [{ data: { id: 'm-1' }, error: null }],
        },
        jest.fn(),
      );

      await expect(
        svc.createOrgInvitation({
          email: 'jane@example.com',
          firstName: 'Jane',
          lastName: 'Doe',
          organizationId: 'org-1',
          role: 'member',
          invitedByUserId: 'admin-1',
        }),
      ).rejects.toThrow('User already exists in this organization');
    });

    it('accepting as the placeholder row itself applies the invited role and marks it mapped', async () => {
      const rpc = jest.fn().mockResolvedValue(acceptRpc);
      const { svc, writes } = buildPlaceholderService(
        {
          invitations: [{ data: invitation, error: null }],
          users: [
            { data: { id: 'ph-1', email: 'jane@example.com' }, error: null },
          ],
          migration_entity_map: [
            {
              data: [{ id: 'map-1', target_id: 'ph-1', source_email: null }],
              error: null,
            },
          ],
        },
        rpc,
      );

      await svc.acceptInvitation('inv-1', 'tok');

      expect(writes).toEqual(
        expect.arrayContaining([
          {
            table: 'organization_members',
            op: 'update',
            payload: { role: 'member' },
          },
          {
            table: 'migration_entity_map',
            op: 'update',
            payload: expect.objectContaining({
              status: 'mapped',
              match_method: 'invite_claim',
            }) as unknown,
          },
        ]),
      );
      expect(rpc).not.toHaveBeenCalledWith(
        'merge_placeholder_user',
        expect.anything(),
      );
    });

    it('merges a synthetic-email placeholder whose source email is the invitee (case-insensitive)', async () => {
      const rpc = jest.fn().mockResolvedValue(acceptRpc);
      const { svc } = buildPlaceholderService(
        {
          invitations: [{ data: invitation, error: null }],
          users: [
            { data: { id: 'u-1', email: 'jane@example.com' }, error: null },
          ],
          migration_entity_map: [
            {
              data: [
                {
                  id: 'map-1',
                  target_id: 'ph-1',
                  source_email: 'jane@example.COM',
                },
                {
                  id: 'map-2',
                  target_id: 'ph-1',
                  source_email: 'jane@example.com',
                },
                {
                  id: 'map-3',
                  target_id: 'ph-9',
                  source_email: 'other@example.com',
                },
              ],
              error: null,
            },
          ],
        },
        rpc,
      );

      await svc.acceptInvitation('inv-1', 'tok');

      const merges = rpc.mock.calls.filter(
        ([name]) => name === 'merge_placeholder_user',
      );
      expect(merges).toEqual([
        [
          'merge_placeholder_user',
          { p_org_id: 'org-1', p_source: 'ph-1', p_target: 'u-1' },
        ],
      ]);
      expect(mockAuditLogsService.logAction).toHaveBeenCalledWith(
        'org-1',
        'u-1',
        'organization_member',
        'u-1',
        'update',
        expect.objectContaining({
          event: 'merge_placeholder',
          placeholder_id: 'ph-1',
        }),
      );
    });

    it('grants the project roles and groups the migration held back for the claimed placeholder', async () => {
      const rpc = jest.fn().mockResolvedValue(acceptRpc);
      const spaces = {
        addSpaceMember: jest
          .fn()
          .mockResolvedValueOnce({})
          .mockRejectedValueOnce(new ConflictException('exists')),
      };
      const groups = { addMember: jest.fn().mockResolvedValue({}) };
      const permissions = { bustOrg: jest.fn() };
      const { svc } = buildPlaceholderService(
        {
          invitations: [{ data: invitation, error: null }],
          users: [
            { data: { id: 'ph-1', email: 'jane@example.com' }, error: null },
          ],
          migration_entity_map: [
            {
              data: [{ id: 'map-1', target_id: 'ph-1', source_email: null }],
              error: null,
            },
            { data: null, error: null },
            {
              data: [
                {
                  id: 'role-1',
                  entity_type: 'role',
                  target_id: 'admin',
                  metadata: {
                    space_id: 'space-1',
                    placeholder_user_ids: ['ph-1'],
                  },
                },
                {
                  id: 'role-2',
                  entity_type: 'role',
                  target_id: 'member',
                  metadata: {
                    space_id: 'space-2',
                    placeholder_user_ids: ['ph-1'],
                  },
                },
                {
                  id: 'group-1',
                  entity_type: 'user_group',
                  target_id: 'grp-1',
                  metadata: { placeholder_user_ids: ['ph-1'] },
                },
              ],
              error: null,
            },
          ],
        },
        rpc,
        [spaces, groups, permissions],
      );

      await expect(svc.acceptInvitation('inv-1', 'tok')).resolves.toMatchObject(
        { success: true },
      );

      expect(spaces.addSpaceMember).toHaveBeenCalledWith(
        'space-1',
        'org-1',
        'admin-1',
        { member_type: 'user', user_id: 'ph-1', space_role: 'admin' },
      );
      // An existing membership (conflict) keeps its role and does not stop the remaining grants.
      expect(spaces.addSpaceMember).toHaveBeenCalledTimes(2);
      expect(groups.addMember).toHaveBeenCalledWith(
        'grp-1',
        'org-1',
        'ph-1',
        null,
        'admin-1',
      );
      expect(permissions.bustOrg).toHaveBeenCalledWith('org-1');
    });

    it('a failed claim never fails the acceptance', async () => {
      const rpc = jest.fn((name: string) =>
        Promise.resolve(
          name === 'merge_placeholder_user'
            ? { data: null, error: { message: 'boom' } }
            : acceptRpc,
        ),
      );
      const { svc } = buildPlaceholderService(
        {
          invitations: [{ data: invitation, error: null }],
          users: [
            { data: { id: 'u-1', email: 'jane@example.com' }, error: null },
          ],
          migration_entity_map: [
            {
              data: [
                {
                  id: 'map-1',
                  target_id: 'ph-1',
                  source_email: 'jane@example.com',
                },
              ],
              error: null,
            },
          ],
        },
        rpc,
      );

      await expect(svc.acceptInvitation('inv-1', 'tok')).resolves.toMatchObject(
        {
          success: true,
        },
      );
    });
  });
});
