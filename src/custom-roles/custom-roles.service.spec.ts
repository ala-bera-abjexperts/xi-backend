/**
 * @fileoverview Unit tests for CustomRolesService — name-availability guard,
 * full role CRUD, soft/permanent delete + restore lifecycle, system-role
 * protections, role usage counting, duplicate, and user role assignments.
 * @module src/custom-roles/custom-roles.service.spec
 * @author Prince Jadiya
 */

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PermissionsService } from '../permissions/permissions.service';
import { CustomRolesService } from './custom-roles.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('CustomRolesService', () => {
  let service: CustomRolesService;
  let permissionsService: PermissionsService;
  let mockFrom: jest.Mock;

  const ORG = 'org-1';
  const USER = 'user-1';

  const mockRole = {
    id: 'role-1',
    organization_id: ORG,
    name: 'Reviewer',
    description: 'Can review work',
    color: '#6B7280',
    icon: null,
    base_role: 'member',
    permissions: {},
    is_system: false,
    is_active: true,
    is_deleted: false,
    deleted_at: null,
    deleted_by: null,
  };

  function buildChain(resolved: {
    data: unknown;
    error: unknown;
    count?: number;
  }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.neq = jest.fn().mockImplementation(self);
    chain.ilike = jest.fn().mockImplementation(self);
    chain.or = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.update = jest.fn().mockImplementation(self);
    chain.delete = jest.fn().mockImplementation(self);
    chain.single = jest.fn().mockResolvedValue(resolved);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled);
    return chain;
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    const supa = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;
    // Every mutating method now evicts PermissionsService's effective-permissions
    // cache, so the service takes it as a dependency. A jest.fn() is enough here:
    // these tests assert the Supabase calls, and `bustOrg` is verified separately
    // in permissions-cache-invalidation.spec.ts.
    permissionsService = {
      bustOrg: jest.fn(),
      bustUser: jest.fn(),
    } as unknown as PermissionsService;

    service = new CustomRolesService(supa, permissionsService);
  });

  // ── getAll ─────────────────────────────────────────────────────────────

  describe('getAll', () => {
    it('returns roles with count', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: [mockRole], error: null, count: 1 }),
      );
      const r = await service.getAll(ORG);
      expect(r.data).toHaveLength(1);
      expect(r.count).toBe(1);
    });

    it('applies base_role / is_active / search filters when provided', async () => {
      const chain = buildChain({ data: [], error: null, count: 0 });
      mockFrom.mockReturnValue(chain);
      await service.getAll(ORG, {
        base_role: 'admin',
        is_active: true,
        is_deleted: false,
        search: 'review',
      });
      const eqArgs = (chain.eq as jest.Mock).mock.calls.map(
        (c) => (c as unknown[])[0],
      );
      expect(eqArgs).toEqual(
        expect.arrayContaining([
          'organization_id',
          'is_deleted',
          'base_role',
          'is_active',
        ]),
      );
      expect(chain.or).toHaveBeenCalled();
    });

    it('throws BadRequest on DB error', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: null, error: { message: 'fail' }, count: 0 }),
      );
      await expect(service.getAll(ORG)).rejects.toThrow(BadRequestException);
    });
  });

  // ── getById ────────────────────────────────────────────────────────────

  describe('getById', () => {
    it('returns the role when found', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: mockRole, error: null }));
      const r = await service.getById('role-1', ORG);
      expect(r['id']).toBe('role-1');
    });

    it('throws NotFound when missing', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(service.getById('missing', ORG)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── create ─────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates a new role when name is available', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // assertNameAvailable (no conflict)
        .mockReturnValueOnce(buildChain({ data: mockRole, error: null })); // insert
      const r = await service.create(ORG, {
        name: 'Reviewer',
      } as never);
      expect((r.data as { id: string }).id).toBe('role-1');
    });

    it('rejects when name conflicts with an existing active role', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { id: 'existing' }, error: null }),
      );
      await expect(
        service.create(ORG, { name: 'Reviewer' } as never),
      ).rejects.toThrow(ConflictException);
    });

    it('throws BadRequest when insert fails', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(
          buildChain({ data: null, error: { message: 'fail' } }),
        );
      await expect(
        service.create(ORG, { name: 'Reviewer' } as never),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── update ─────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates the role when name is unchanged', async () => {
      const updated = { ...mockRole, color: '#FF0000' };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRole, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: updated, error: null })); // update
      const r = await service.update('role-1', ORG, {
        color: '#FF0000',
      } as never);
      expect((r.data as { color: string }).color).toBe('#FF0000');
    });

    it('refuses to modify system roles', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { ...mockRole, is_system: true }, error: null }),
      );
      await expect(
        service.update('role-1', ORG, { name: 'X' } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('checks name availability when renaming', async () => {
      const updated = { ...mockRole, name: 'New name' };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRole, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // assertNameAvailable (no conflict)
        .mockReturnValueOnce(buildChain({ data: updated, error: null })); // update
      const r = await service.update('role-1', ORG, {
        name: 'New name',
      } as never);
      expect((r.data as { name: string }).name).toBe('New name');
    });

    it('rejects rename when target name is taken', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRole, error: null })) // getById
        .mockReturnValueOnce(
          buildChain({ data: { id: 'other' }, error: null }),
        ); // conflict
      await expect(
        service.update('role-1', ORG, { name: 'Taken' } as never),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ── softDelete ─────────────────────────────────────────────────────────

  describe('softDelete', () => {
    it('soft-deletes a non-system, unused role', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRole, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 0 })) // countUsersWithRole
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // update is_deleted=true
      const r = await service.softDelete('role-1', ORG, USER);
      expect(r.success).toBe(true);
    });

    it('rejects deletion when role is system', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { ...mockRole, is_system: true }, error: null }),
      );
      await expect(service.softDelete('role-1', ORG, USER)).rejects.toThrow(
        /system roles/,
      );
    });

    it('rejects deletion when role is in use', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRole, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 3 }));
      await expect(service.softDelete('role-1', ORG, USER)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── toggleActive ───────────────────────────────────────────────────────

  describe('toggleActive', () => {
    it('flips is_active for a custom role', async () => {
      const updated = { ...mockRole, is_active: false };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRole, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: updated, error: null })); // update
      const r = await service.toggleActive('role-1', ORG, false);
      expect((r.data as { is_active: boolean }).is_active).toBe(false);
    });

    it('refuses to deactivate system roles', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { ...mockRole, is_system: true }, error: null }),
      );
      await expect(service.toggleActive('role-1', ORG, false)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── restore ────────────────────────────────────────────────────────────

  describe('restore', () => {
    it('restores a soft-deleted role', async () => {
      const deleted = { ...mockRole, is_deleted: true };
      const restored = { ...mockRole };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: deleted, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // assertNameAvailable
        .mockReturnValueOnce(buildChain({ data: restored, error: null })); // update
      const r = await service.restore('role-1', ORG);
      expect((r.data as { is_deleted: boolean }).is_deleted).toBe(false);
    });

    it('rejects when role is not deleted', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: mockRole, error: null }));
      await expect(service.restore('role-1', ORG)).rejects.toThrow(
        /not deleted/,
      );
    });
  });

  // ── permanentDelete ────────────────────────────────────────────────────

  describe('permanentDelete', () => {
    it('hard-deletes when role is already soft-deleted', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({ data: { ...mockRole, is_deleted: true }, error: null }),
        )
        .mockReturnValueOnce(buildChain({ data: null, error: null }));
      const r = await service.permanentDelete('role-1', ORG);
      expect(r.success).toBe(true);
    });

    it('rejects when role is system', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: { ...mockRole, is_system: true }, error: null }),
      );
      await expect(service.permanentDelete('role-1', ORG)).rejects.toThrow(
        /system roles/,
      );
    });

    it('rejects when role is not soft-deleted yet', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: mockRole, error: null }));
      await expect(service.permanentDelete('role-1', ORG)).rejects.toThrow(
        /soft-deleted first/,
      );
    });
  });

  // ── duplicate ──────────────────────────────────────────────────────────

  describe('duplicate', () => {
    it('clones the role under a new name', async () => {
      const cloned = { ...mockRole, id: 'role-2', name: 'Reviewer copy' };
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRole, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // assertNameAvailable
        .mockReturnValueOnce(buildChain({ data: cloned, error: null })); // insert
      const r = await service.duplicate('role-1', ORG, 'Reviewer copy');
      expect((r.data as { id: string }).id).toBe('role-2');
    });

    it('rejects when target name conflicts', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRole, error: null }))
        .mockReturnValueOnce(
          buildChain({ data: { id: 'existing' }, error: null }),
        );
      await expect(service.duplicate('role-1', ORG, 'Taken')).rejects.toThrow(
        ConflictException,
      );
    });
  });

  // ── checkUsage ─────────────────────────────────────────────────────────

  describe('checkUsage', () => {
    it('returns inUse=true when role has assignments', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRole, error: null })) // getById
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 5 })); // countUsersWithRole
      const r = await service.checkUsage('role-1', ORG);
      expect(r.data).toEqual({ inUse: true, usageCount: 5 });
    });

    it('returns inUse=false when role has no assignments', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockRole, error: null }))
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 0 }));
      const r = await service.checkUsage('role-1', ORG);
      expect(r.data).toEqual({ inUse: false, usageCount: 0 });
    });
  });

  // ── Assignments ────────────────────────────────────────────────────────

  describe('getAssignments', () => {
    it('returns assignments filtered by user_id', async () => {
      const chain = buildChain({
        data: [{ id: 'a-1', user_id: USER, role_id: 'role-1' }],
        error: null,
        count: 1,
      });
      mockFrom.mockReturnValue(chain);
      const r = await service.getAssignments(ORG, { user_id: USER });
      expect(r.count).toBe(1);
      const eqArgs = (chain.eq as jest.Mock).mock.calls.map(
        (c) => (c as unknown[])[0],
      );
      expect(eqArgs).toContain('user_id');
    });
  });

  describe('assignRole', () => {
    it('assigns a role to a user when role is active', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: { id: 'role-1', is_active: true, is_deleted: false },
            error: null,
          }),
        ) // role lookup
        .mockReturnValueOnce(
          buildChain({
            data: { id: 'a-1', user_id: USER, role_id: 'role-1' },
            error: null,
          }),
        ); // insert
      const r = await service.assignRole(ORG, USER, 'role-1');
      expect((r.data as { id: string }).id).toBe('a-1');
    });

    it('rejects when role is missing', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(service.assignRole(ORG, USER, 'missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects when role is inactive or deleted', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: { id: 'role-1', is_active: false, is_deleted: false },
          error: null,
        }),
      );
      await expect(service.assignRole(ORG, USER, 'role-1')).rejects.toThrow(
        /inactive or deleted/,
      );
    });

    it('throws ConflictException on duplicate assignment (Postgres 23505)', async () => {
      mockFrom
        .mockReturnValueOnce(
          buildChain({
            data: { id: 'role-1', is_active: true, is_deleted: false },
            error: null,
          }),
        )
        .mockReturnValueOnce(
          buildChain({
            data: null,
            error: { code: '23505', message: 'duplicate key' },
          }),
        );
      await expect(service.assignRole(ORG, USER, 'role-1')).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('unassignRole', () => {
    it('removes a specific role assignment', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      const r = await service.unassignRole(ORG, USER, 'role-1');
      expect(r.message).toBe('Role unassigned successfully');
    });

    it('removes all assignments when role_id is omitted', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      const r = await service.unassignRole(ORG, USER);
      expect(r.message).toBe('All roles unassigned from user');
    });
  });

  describe('deleteAssignmentById', () => {
    it('deletes an assignment row by id', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: { id: 'a-1' }, error: null })) // getAssignmentById
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // delete
      const r = await service.deleteAssignmentById('a-1', ORG);
      expect(r.success).toBe(true);
    });

    it('throws NotFound when assignment does not exist', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.deleteAssignmentById('missing', ORG),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
