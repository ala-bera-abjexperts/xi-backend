/**
 * @fileoverview Unit tests for the SpacesService covering space CRUD, member management,
 * icon operations, and archive/unarchive flows.
 * @module src/spaces/spaces.service.spec
 * @author Prince Jadiya
 */

// jsdom cannot load in this jest env (its html-encoding-sniffer dep is ESM), and
// spaces.service transitively imports the DOMPurify-backed sanitizer via
// automations -> wiki -> wiki-content.util -> sanitize-rich-text. Without this the
// whole suite fails to LOAD, which reads as "0 tests" rather than a failure — the
// same reason ~42 suites are silently not running. Mocking the sanitizer breaks the
// import chain before jsdom is reached; this mirrors the workaround already used in
// common/utils/sanitize-wiki-content.spec.ts. Nothing here exercises sanitization.
jest.mock('../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (v: string | null | undefined) => v ?? null,
  sanitizeRichTextWithTables: (v: string | null | undefined) => v ?? null,
}));

import { UPLOAD_LIMITS } from '../common/upload-limits';
import { SpacesService } from './spaces.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

describe('SpacesService', () => {
  let service: SpacesService;
  let mockFrom: jest.Mock;
  let mockRpc: jest.Mock;
  let mockStorage: Record<string, jest.Mock>;
  let mockAuthAdminDeleteUser: jest.Mock;
  let mockSpaceStorageCleanup: {
    drainSpace: jest.Mock;
    drainSpaceRows: jest.Mock;
  };
  let mockMailService: {
    sendSpaceInvitationEmail: jest.Mock;
    sendSpaceInvitation: jest.Mock;
  };
  let mockAuditLogs: { logAction: jest.Mock; createLog: jest.Mock };

  // A real-format UUID: getSpaceById rejects non-UUID ids before querying.
  const SPACE_ID = '5bace000-0000-4000-8000-000000000001';

  const mockSpace = {
    id: SPACE_ID,
    organization_id: 'org-1',
    name: 'Engineering',
    key: 'ENG',
    description: 'Engineering workspace',
    description_i18n: null,
    name_i18n: null,
    icon: null,
    icon_url: null,
    icon_path: null,
    color: '#3B82F6',
    background_color: '#EFF6FF',
    category: 'engineering',
    space_type_id: null,
    lead_id: null,
    is_active: true,
    is_archived: false,
    archived_at: null,
    archived_by: null,
    settings: null,
    created_by: 'user-1',
    updated_by: 'user-1',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };

  const mockMember = {
    id: 'member-1',
    space_id: SPACE_ID,
    member_type: 'user',
    user_id: 'user-1',
    group_id: null,
    role_id: null,
    space_role: 'owner',
    permissions: null,
    notification_preferences: null,
    is_active: true,
    added_by: 'user-1',
    added_via_group_id: null,
    added_via_role_id: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };

  /**
   * Helper to build a chainable Supabase query mock.
   */
  /** Deletion answers the caller and drains afterwards; let those microtasks run. */
  const flushPendingDrain = () =>
    new Promise<void>((resolve) => setImmediate(resolve));

  function buildChain(resolvedValue: {
    data: unknown;
    error: unknown;
    count?: number;
  }) {
    const chain: Record<string, jest.Mock> = {} as Record<string, jest.Mock>;
    const self = () => chain;
    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.is = jest.fn().mockImplementation(self);
    chain.not = jest.fn().mockImplementation(self);
    chain.in = jest.fn().mockImplementation(self);
    chain.ilike = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.update = jest.fn().mockImplementation(self);
    chain.upsert = jest.fn().mockImplementation(self);
    chain.delete = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.range = jest.fn().mockResolvedValue(resolvedValue);
    chain.single = jest.fn().mockResolvedValue(resolvedValue);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolvedValue);
    // Allow `await chain` / `chain.then(...)` for terminal calls without
    // .single/.maybeSingle (e.g. update/delete/insert chains).
    (
      chain as unknown as {
        then: (cb: (v: unknown) => unknown) => Promise<unknown>;
      }
    ).then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolvedValue).then(onFulfilled);
    return chain;
  }

  beforeEach(() => {
    mockStorage = {
      upload: jest.fn().mockResolvedValue({ error: null }),
      remove: jest.fn().mockResolvedValue({ error: null }),
      getPublicUrl: jest.fn().mockReturnValue({
        data: { publicUrl: 'https://example.com/icon.png' },
      }),
    };

    mockFrom = jest.fn();
    mockRpc = jest.fn().mockResolvedValue({
      data: 'cleanup-job-1',
      error: null,
    });
    mockAuthAdminDeleteUser = jest.fn().mockResolvedValue({ data: null });
    mockSpaceStorageCleanup = {
      drainSpace: jest.fn().mockResolvedValue(0),
      drainSpaceRows: jest.fn().mockResolvedValue(0),
    };

    const supabaseAdmin = {
      getClient: () => ({
        auth: {
          admin: {
            deleteUser: mockAuthAdminDeleteUser,
          },
        },
        from: mockFrom,
        rpc: mockRpc,
        storage: {
          from: () => mockStorage,
        },
      }),
    } as unknown as SupabaseAdminService;

    mockAuditLogs = {
      logAction: jest.fn().mockResolvedValue(undefined),
      createLog: jest.fn().mockResolvedValue(undefined),
    };
    const auditLogsService =
      mockAuditLogs as unknown as import('../audit-logs/audit-logs.service').AuditLogsService;

    mockMailService = {
      sendSpaceInvitationEmail: jest.fn().mockResolvedValue(undefined),
      sendSpaceInvitation: jest.fn().mockResolvedValue(undefined),
    };

    service = new SpacesService(
      supabaseAdmin,
      auditLogsService,
      mockMailService as unknown as import('../mail/mail.service').MailService,
      mockSpaceStorageCleanup as unknown as import('./space-storage-cleanup.processor').SpaceStorageCleanupProcessor,
    );
  });

  // ── getSpaces ───────────────────────────────────────────────────────────

  describe('getSpaces', () => {
    it('should return paginated space data', async () => {
      const chain = buildChain({
        data: [mockSpace],
        error: null,
        count: 1,
      });
      mockFrom.mockReturnValue(chain);

      const result = await service.getSpaces('org-1', {}, 1, 20);

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
    });

    it('should cap page size at 50', async () => {
      const chain = buildChain({
        data: [],
        error: null,
        count: 0,
      });
      mockFrom.mockReturnValue(chain);

      const result = await service.getSpaces('org-1', {}, 1, 100);

      expect(result.pageSize).toBe(50);
    });

    it('should enforce minimum page of 1', async () => {
      const chain = buildChain({
        data: [],
        error: null,
        count: 0,
      });
      mockFrom.mockReturnValue(chain);

      const result = await service.getSpaces('org-1', {}, -5, 20);

      expect(result.page).toBe(1);
    });
  });

  // ── createSpace ─────────────────────────────────────────────────────────

  describe('createSpace', () => {
    it('should create a space and add creator as owner', async () => {
      // 1. key uniqueness check -> no conflict
      const noConflictChain = buildChain({ data: null, error: null });
      // 2. insert space -> success
      const spaceChain = buildChain({ data: mockSpace, error: null });
      // 3. insert member -> success
      const memberChain = buildChain({ data: mockMember, error: null });
      // 4. seed default modules (fire-and-forget) -> success
      const modulesChain = buildChain({ data: null, error: null });

      mockFrom
        .mockReturnValueOnce(noConflictChain)
        .mockReturnValueOnce(spaceChain)
        .mockReturnValueOnce(memberChain)
        .mockReturnValueOnce(modulesChain);

      const result = await service.createSpace('org-1', 'user-1', {
        name: 'Engineering',
        key: 'ENG',
      });

      expect(result).toEqual(mockSpace);
    });

    it('should auto-generate key when not provided', async () => {
      const noConflictChain = buildChain({ data: null, error: null });
      const spaceChain = buildChain({ data: mockSpace, error: null });
      const memberChain = buildChain({ data: mockMember, error: null });
      const modulesChain = buildChain({ data: null, error: null });

      mockFrom
        .mockReturnValueOnce(noConflictChain)
        .mockReturnValueOnce(spaceChain)
        .mockReturnValueOnce(memberChain)
        .mockReturnValueOnce(modulesChain);

      const result = await service.createSpace('org-1', 'user-1', {
        name: 'Engineering',
      });

      expect(result).toEqual(mockSpace);
      // The insert call should have been made with a generated key
      expect(spaceChain.insert).toHaveBeenCalled();
    });

    // The (organization_id, name) unique index used to surface as a generic 500.
    it('returns 409 when the name is already taken in the organization', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(
          buildChain({
            data: null,
            error: {
              code: '23505',
              message:
                'duplicate key value violates unique constraint "spaces_organization_id_name_key"',
            },
          }),
        );

      await expect(
        service.createSpace('org-1', 'user-1', {
          name: 'Engineering',
          key: 'ENG2',
        }),
      ).rejects.toThrow(
        new ConflictException(
          'A space named "Engineering" already exists in this organization',
        ),
      );
    });

    // Two requests can both pass the key pre-check; the unique index decides.
    it('returns 409 when a concurrent insert takes the key first', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(
          buildChain({
            data: null,
            error: {
              code: '23505',
              message:
                'duplicate key value violates unique constraint "spaces_org_key_unique"',
            },
          }),
        );

      await expect(
        service.createSpace('org-1', 'user-1', { name: 'Other', key: 'eng' }),
      ).rejects.toThrow(
        new ConflictException(
          'Space key "ENG" is already used in this organization',
        ),
      );
    });
  });

  // ── getUserSpaces ───────────────────────────────────────────────────────

  describe('getUserSpaces', () => {
    /**
     * Builds a thenable chain: every method returns `this`, and the chain itself
     * resolves to the given value when awaited (duck-typed Promise via `.then`).
     */
    function buildThenableChain(resolvedValue: {
      data: unknown;
      error: unknown;
    }) {
      const chain: Record<string, jest.Mock> & { then: jest.Mock } =
        {} as never;
      const self = () => chain;
      chain.select = jest.fn().mockImplementation(self);
      chain.eq = jest.fn().mockImplementation(self);
      chain.in = jest.fn().mockImplementation(self);
      chain.order = jest.fn().mockImplementation(self);
      chain.then = jest
        .fn()
        .mockImplementation((resolve: (val: unknown) => unknown) =>
          Promise.resolve(resolve(resolvedValue)),
        );
      return chain;
    }

    it('should return user spaces', async () => {
      const memberChain = buildThenableChain({
        data: [{ space_id: SPACE_ID }],
        error: null,
      });

      const spacesChain = buildThenableChain({
        data: [mockSpace],
        error: null,
      });

      let callCount = 0;
      mockFrom.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? memberChain : spacesChain;
      });

      const result = await service.getUserSpaces('user-1');

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(mockSpace);
    });

    it('should return empty array when user has no memberships', async () => {
      const memberChain = buildThenableChain({
        data: [],
        error: null,
      });

      mockFrom.mockReturnValue(memberChain);

      const result = await service.getUserSpaces('user-1');

      expect(result).toEqual([]);
    });

    /**
     * Tenant isolation. `space_members` has no organization_id, so membership
     * alone spans every org the user belongs to. Without an explicit filter a
     * multi-org user saw spaces from ALL their orgs in the sidebar switcher and
     * in the /auth/bootstrap payload — a cross-tenant leak.
     */
    it('scopes the spaces query to the caller organization when one is given', async () => {
      const memberChain = buildThenableChain({
        data: [{ space_id: SPACE_ID }],
        error: null,
      });
      const spacesChain = buildThenableChain({
        data: [mockSpace],
        error: null,
      });

      let callCount = 0;
      mockFrom.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? memberChain : spacesChain;
      });

      await service.getUserSpaces('user-1', 'org-1');

      expect(spacesChain.eq).toHaveBeenCalledWith('organization_id', 'org-1');
    });

    it('does NOT filter by organization when the org is empty (onboarding)', async () => {
      const memberChain = buildThenableChain({
        data: [{ space_id: SPACE_ID }],
        error: null,
      });
      const spacesChain = buildThenableChain({
        data: [mockSpace],
        error: null,
      });

      let callCount = 0;
      mockFrom.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? memberChain : spacesChain;
      });

      // '' would be an invalid uuid — filtering on it errors instead of
      // returning nothing, so the empty-org onboarding state must stay unscoped.
      await service.getUserSpaces('user-1', '');

      const orgFilterCalls = spacesChain.eq.mock.calls.filter(
        (c: unknown[]) => c[0] === 'organization_id',
      );

      expect(orgFilterCalls).toHaveLength(0);
    });

    /**
     * XE-T701: a new space no longer copies org owners/admins into space_members, so the
     * switcher/bootstrap list must not depend on a membership row for them.
     */
    describe('org owner/admin (XE-T701)', () => {
      const withPermissions = (isAdmin: boolean, viewDenied = false) =>
        Object.assign(service, {
          permissionsService: {
            isViewSpaceDenied: jest.fn().mockResolvedValue(viewDenied),
            isAdminOrOwner: jest.fn().mockResolvedValue(isAdmin),
          },
        });

      it('lists every active space of the org without reading space_members', async () => {
        withPermissions(true);
        const spacesChain = buildThenableChain({
          data: [mockSpace],
          error: null,
        });
        mockFrom.mockReturnValue(spacesChain);

        const result = await service.getUserSpaces('admin-1', 'org-1');

        expect(result).toEqual([mockSpace]);
        expect(mockFrom).toHaveBeenCalledTimes(1);
        expect(mockFrom).toHaveBeenCalledWith('spaces');
        expect(spacesChain.eq).toHaveBeenCalledWith('organization_id', 'org-1');
        expect(spacesChain.eq).toHaveBeenCalledWith('is_active', true);
        expect(spacesChain.eq).toHaveBeenCalledWith('is_archived', false);
        expect(spacesChain.in).not.toHaveBeenCalled();
      });

      it('keeps the membership lookup for everyone else', async () => {
        withPermissions(false);
        const memberChain = buildThenableChain({ data: [], error: null });
        mockFrom.mockReturnValue(memberChain);

        const result = await service.getUserSpaces('user-1', 'org-1');

        expect(result).toEqual([]);
        expect(mockFrom).toHaveBeenCalledWith('space_members');
      });

      it('still returns nothing when "view space" is denied for the role', async () => {
        withPermissions(true, true);

        const result = await service.getUserSpaces('admin-1', 'org-1');

        expect(result).toEqual([]);
        expect(mockFrom).not.toHaveBeenCalled();
      });
    });
  });

  // ── getSpaceByKey ───────────────────────────────────────────────────────

  describe('getSpaceByKey', () => {
    it('should return available false when key is taken', async () => {
      const chain = buildChain({ data: mockSpace, error: null });
      mockFrom.mockReturnValue(chain);

      const result = await service.getSpaceByKey('ENG', 'org-1');

      expect(result.available).toBe(false);
      expect(result.space).toEqual(mockSpace);
    });

    it('should return available true when key is free', async () => {
      const chain = buildChain({ data: null, error: null });
      mockFrom.mockReturnValue(chain);

      const result = await service.getSpaceByKey('FREE', 'org-1');

      expect(result.available).toBe(true);
      expect(result.space).toBeUndefined();
    });
  });

  // ── getSpaceById ────────────────────────────────────────────────────────

  describe('getSpaceById', () => {
    it('should return the space when found', async () => {
      const chain = buildChain({ data: mockSpace, error: null });
      mockFrom.mockReturnValue(chain);

      const result = await service.getSpaceById(SPACE_ID);

      expect(result).toEqual(mockSpace);
    });

    it('should throw NotFoundException when space not found', async () => {
      const chain = buildChain({ data: null, error: null });
      mockFrom.mockReturnValue(chain);

      await expect(
        service.getSpaceById('5bace000-0000-4000-8000-0000000000ff'),
      ).rejects.toThrow(NotFoundException);
    });

    // `GET /spaces/by-key` (no key) falls through to `:id`; the uuid cast used to 500.
    it('throws NotFoundException for a non-UUID id without querying', async () => {
      await expect(service.getSpaceById('by-key')).rejects.toThrow(
        new NotFoundException('Space not found'),
      );
      expect(mockFrom).not.toHaveBeenCalled();
    });
  });

  // ── updateSpace ─────────────────────────────────────────────────────────

  describe('updateSpace', () => {
    it('should update the space fields', async () => {
      const updatedSpace = { ...mockSpace, name: 'Engineering v2' };
      const chain = buildChain({ data: updatedSpace, error: null });
      mockFrom.mockReturnValue(chain);

      const result = await service.updateSpace(SPACE_ID, 'user-1', {
        name: 'Engineering v2',
      });

      expect(result.name).toBe('Engineering v2');
    });

    it('returns 409 when renaming onto a name already taken', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockSpace, error: null }))
        .mockReturnValueOnce(
          buildChain({
            data: null,
            error: {
              code: '23505',
              message:
                'duplicate key value violates unique constraint "spaces_organization_id_name_key"',
            },
          }),
        );

      await expect(
        service.updateSpace(SPACE_ID, 'user-1', { name: 'Marketing' }, 'org-1'),
      ).rejects.toThrow(
        new ConflictException(
          'A space named "Marketing" already exists in this organization',
        ),
      );
    });
  });

  // ── archiveSpace ────────────────────────────────────────────────────────

  describe('archiveSpace', () => {
    it('should archive the space', async () => {
      const archivedSpace = {
        ...mockSpace,
        is_archived: true,
        archived_at: '2024-06-01T00:00:00Z',
        archived_by: 'user-1',
      };
      const chain = buildChain({ data: archivedSpace, error: null });
      mockFrom.mockReturnValue(chain);

      const result = await service.archiveSpace(SPACE_ID, 'user-1');

      expect(result.is_archived).toBe(true);
      expect(result.archived_by).toBe('user-1');
    });
  });

  // ── deleteSpace ─────────────────────────────────────────────────────────

  describe('deleteSpace', () => {
    it('atomically records storage cleanup work with the database cascade', async () => {
      const archivedSpace = { ...mockSpace, is_archived: true };
      mockFrom.mockReturnValue(
        buildChain({ data: archivedSpace, error: null }),
      );

      await service.deleteSpace(SPACE_ID, 'user-1', 'org-1');
      await flushPendingDrain();

      expect(mockRpc).toHaveBeenCalledWith('delete_space_cascade', {
        p_organization_id: 'org-1',
        p_space_id: SPACE_ID,
        p_requested_by: 'user-1',
      });
      expect(mockSpaceStorageCleanup.drainSpace).toHaveBeenCalledWith(SPACE_ID);
      expect(mockFrom).toHaveBeenCalledTimes(1);
    });

    it('fails without touching storage when the atomic database cascade fails', async () => {
      const archivedSpace = { ...mockSpace, is_archived: true };
      mockFrom.mockReturnValue(
        buildChain({ data: archivedSpace, error: null }),
      );
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'foreign key violation' },
      });

      await expect(
        service.deleteSpace(SPACE_ID, 'user-1', 'org-1'),
      ).rejects.toThrow('Failed to delete space');
      expect(mockSpaceStorageCleanup.drainSpace).not.toHaveBeenCalled();
    });

    it('keeps a successful deletion successful when immediate cleanup must retry', async () => {
      const archivedSpace = { ...mockSpace, is_archived: true };
      mockFrom.mockReturnValue(
        buildChain({ data: archivedSpace, error: null }),
      );
      mockSpaceStorageCleanup.drainSpace.mockRejectedValue(
        new Error('storage unavailable'),
      );

      await expect(
        service.deleteSpace(SPACE_ID, 'user-1', 'org-1'),
      ).resolves.toBeUndefined();
      await flushPendingDrain();
      expect(mockSpaceStorageCleanup.drainSpace).toHaveBeenCalledWith(SPACE_ID);
    });

    it('should reject deletion of non-archived space', async () => {
      const chain = buildChain({ data: mockSpace, error: null });
      mockFrom.mockReturnValue(chain);

      await expect(service.deleteSpace(SPACE_ID)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockSpaceStorageCleanup.drainSpace).not.toHaveBeenCalled();
    });
  });

  // ── unarchiveSpace ──────────────────────────────────────────────────────

  describe('unarchiveSpace', () => {
    it('should restore an archived space', async () => {
      const restoredSpace = {
        ...mockSpace,
        is_archived: false,
        archived_at: null,
        archived_by: null,
      };
      const chain = buildChain({ data: restoredSpace, error: null });
      mockFrom.mockReturnValue(chain);

      const result = await service.unarchiveSpace(SPACE_ID, 'user-1');

      expect(result.is_archived).toBe(false);
      expect(result.archived_at).toBeNull();
    });
  });

  // ── getSpaceMembers ─────────────────────────────────────────────────────

  describe('getSpaceMembers', () => {
    it('should return active space members', async () => {
      const chain = buildChain({ data: [mockMember], error: null });
      chain.order = jest.fn().mockResolvedValue({
        data: [mockMember],
        error: null,
      });
      mockFrom.mockReturnValue(chain);

      const result = await service.getSpaceMembers(SPACE_ID);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(mockMember);
    });
  });

  describe('getSpaceMembersWithDetails', () => {
    it('lists members once the space is confirmed in the caller org', async () => {
      const spaceChain = buildChain({ data: mockSpace, error: null });
      const membersChain = buildChain({ data: [mockMember], error: null });
      membersChain.order = jest
        .fn()
        .mockResolvedValue({ data: [mockMember], error: null });
      mockFrom
        .mockReturnValueOnce(spaceChain)
        .mockReturnValueOnce(membersChain);

      const result = await service.getSpaceMembersWithDetails(
        SPACE_ID,
        'org-1',
      );

      expect(result).toEqual([mockMember]);
      expect(spaceChain.eq).toHaveBeenCalledWith('organization_id', 'org-1');
    });

    // Org admins pass SpacePermissionsGuard for any space id; this is what keeps another
    // tenant's member list (names, emails) out of their reach.
    it('404s without reading members when the space is in another org', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));

      await expect(
        service.getSpaceMembersWithDetails(SPACE_ID, 'org-1'),
      ).rejects.toThrow(new NotFoundException('Space not found'));
      expect(mockFrom).toHaveBeenCalledTimes(1);
      expect(mockFrom).toHaveBeenCalledWith('spaces');
    });

    it('404s for a non-UUID id or a missing org without querying', async () => {
      await expect(
        service.getSpaceMembersWithDetails('by-key', 'org-1'),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.getSpaceMembersWithDetails(SPACE_ID, ''),
      ).rejects.toThrow(NotFoundException);
      expect(mockFrom).not.toHaveBeenCalled();
    });
  });

  // ── addSpaceMember ──────────────────────────────────────────────────────

  describe('addSpaceMember', () => {
    it('should add a new member', async () => {
      // duplicate check -> not found
      const checkChain = buildChain({ data: null, error: null });
      // insert -> success
      const insertChain = buildChain({ data: mockMember, error: null });

      let callCount = 0;
      mockFrom.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? checkChain : insertChain;
      });

      const result = await service.addSpaceMember(SPACE_ID, 'org-1', 'user-1', {
        member_type: 'user',
        user_id: 'user-2',
        space_role: 'member',
      });

      expect(result).toEqual(mockMember);
    });

    it('should reject duplicate active member', async () => {
      const existingChain = buildChain({
        data: { ...mockMember, is_active: true },
        error: null,
      });
      mockFrom.mockReturnValue(existingChain);

      await expect(
        service.addSpaceMember(SPACE_ID, 'org-1', 'user-1', {
          member_type: 'user',
          user_id: 'user-1',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should reactivate an inactive member', async () => {
      const inactiveMember = { ...mockMember, is_active: false };
      const checkChain = buildChain({ data: inactiveMember, error: null });
      const reactivateChain = buildChain({
        data: { ...mockMember, is_active: true },
        error: null,
      });

      let callCount = 0;
      mockFrom.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? checkChain : reactivateChain;
      });

      const result = await service.addSpaceMember(SPACE_ID, 'org-1', 'user-1', {
        member_type: 'user',
        user_id: 'user-1',
      });

      expect(result.is_active).toBe(true);
    });
  });

  // ── updateSpaceMember ───────────────────────────────────────────────────

  describe('the member-added event', () => {
    it('carries the real name and email, as user and as member, and the space', async () => {
      const users = buildChain({ data: { email: 'a@b.test', first_name: 'Ala', last_name: 'Bera' }, error: null });
      const spaces = buildChain({ data: { name: 'Audit' }, error: null });
      mockFrom.mockReturnValueOnce(users).mockReturnValueOnce(spaces);
      const write = jest.fn();
      (service as unknown as { outboxService: { write: jest.Mock } }).outboxService = { write };

      await (service as unknown as { writeSpaceMemberOutbox: (...a: unknown[]) => Promise<void> }).writeSpaceMemberOutbox(
        { from: mockFrom },
        'org-1',
        SPACE_ID,
        { ...mockMember, user_id: 'u1' },
      );

      expect(users.select).toHaveBeenCalledWith('email, first_name, last_name');
      const payload = write.mock.calls[0][3];
      expect(payload.user).toEqual({ id: 'u1', email: 'a@b.test', name: 'Ala Bera' });
      expect(payload.member).toEqual(payload.user);
      expect(payload.space).toEqual({ id: SPACE_ID, name: 'Audit' });
    });
  });

  describe('updateSpaceMember', () => {
    it('should update the member role through the locked write', async () => {
      const updatedMember = { ...mockMember, space_role: 'admin' };
      mockFrom.mockReturnValue(buildChain({ data: updatedMember, error: null }));
      mockRpc.mockResolvedValue({ data: { ok: true, role: 'admin' }, error: null });

      const result = await service.updateSpaceMember('member-1', {
        member_id: 'member-1',
        space_role: 'admin',
      });

      expect(result.space_role).toBe('admin');
      expect(mockRpc).toHaveBeenCalledWith(
        'agent_space_member_write',
        expect.objectContaining({ p_op: 'role', p_role: 'admin', p_user_id: mockMember.user_id }),
      );
    });

    it('refuses to demote the last owner', async () => {
      mockFrom.mockReturnValue(buildChain({ data: { ...mockMember, space_role: 'owner' }, error: null }));
      mockRpc.mockResolvedValue({ data: { ok: false, code: 'last_owner' }, error: null });

      await expect(
        service.updateSpaceMember('member-1', { member_id: 'member-1', space_role: 'member' }),
      ).rejects.toThrow(ConflictException);
    });

    it('keeps the old guard for a group row', async () => {
      const groupRow = { ...mockMember, user_id: null, member_type: 'group', space_role: 'admin' };
      mockFrom.mockReturnValue(buildChain({ data: groupRow, error: null, count: 1 }));

      await expect(
        service.updateSpaceMember('member-1', { member_id: 'member-1', space_role: 'viewer' }),
      ).rejects.toThrow(BadRequestException);
      expect(mockRpc).not.toHaveBeenCalledWith('agent_space_member_write', expect.anything());
    });
  });

  // ── removeSpaceMember ───────────────────────────────────────────────────

  describe('removeSpaceMember', () => {
    it('should remove a person through the locked write', async () => {
      mockFrom.mockReturnValue(buildChain({ data: mockMember, error: null }));
      mockRpc.mockResolvedValue({ data: { ok: true, role: 'member' }, error: null });

      const result = await service.removeSpaceMember('member-1', SPACE_ID, 'org-1', 'user-1');

      expect(result.success).toBe(true);
      expect(mockRpc).toHaveBeenCalledWith(
        'agent_space_member_write',
        expect.objectContaining({ p_op: 'remove', p_user_id: mockMember.user_id, p_space_id: SPACE_ID }),
      );
    });

    it('refuses to remove the last owner', async () => {
      mockFrom.mockReturnValue(buildChain({ data: { ...mockMember, space_role: 'owner' }, error: null }));
      mockRpc.mockResolvedValue({ data: { ok: false, code: 'last_owner' }, error: null });

      await expect(service.removeSpaceMember('member-1', SPACE_ID, 'org-1', 'user-1')).rejects.toThrow(ConflictException);
    });

    it('keeps the old guard and the derived cleanup for a group row', async () => {
      const groupRow = { ...mockMember, user_id: null, group_id: 'g1', member_type: 'group', space_role: 'member' };
      const fetchChain = buildChain({ data: groupRow, error: null });
      const deleteChain = buildChain({ data: null, error: null });
      const permsChain = buildChain({ data: null, error: null });
      const derivedChain = buildChain({ data: [], error: null });

      mockFrom
        .mockReturnValueOnce(fetchChain)
        .mockReturnValueOnce(deleteChain)
        .mockReturnValueOnce(permsChain)
        .mockReturnValueOnce(derivedChain);

      await expect(service.removeSpaceMember('member-1', SPACE_ID, 'org-1', 'user-1')).resolves.toEqual({ success: true });
      expect(mockRpc).not.toHaveBeenCalledWith('agent_space_member_write', expect.anything());
    });
  });

  // ── uploadIcon ──────────────────────────────────────────────────────────

  describe('uploadIcon', () => {
    it('should reject invalid file type', async () => {
      await expect(
        service.uploadIcon(
          SPACE_ID,
          'user-1',
          Buffer.from('test'),
          'doc.pdf',
          'application/pdf',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject file exceeding size limit', async () => {
      const largeBuffer = Buffer.alloc(UPLOAD_LIMITS.SMALL_IMAGE + 1);

      await expect(
        service.uploadIcon(
          SPACE_ID,
          'user-1',
          largeBuffer,
          'big.png',
          'image/png',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── getImplicitSpaceMembers ─────────────────────────────────────────────

  describe('getImplicitSpaceMembers', () => {
    it('should return indirect user ids', async () => {
      const groupMember = {
        ...mockMember,
        member_type: 'group',
        group_id: 'group-1',
        user_id: null,
      };
      const roleMember = {
        ...mockMember,
        id: 'member-2',
        member_type: 'role',
        role_id: 'role-1',
        user_id: null,
      };
      const memberChain = buildChain({
        data: [groupMember, roleMember],
        error: null,
      });
      const groupUserChain = buildChain({
        data: [{ user_id: 'user-2' }],
        error: null,
      });
      const roleUserChain = buildChain({
        data: [{ user_id: 'user-3' }, { user_id: 'user-2' }],
        error: null,
      });

      mockFrom.mockImplementation((table: string) => {
        if (table === 'space_members') return memberChain;
        if (table === 'user_group_members') return groupUserChain;
        if (table === 'user_role_assignments') return roleUserChain;

        return buildChain({ data: [], error: null });
      });

      const result = await service.getImplicitSpaceMembers(SPACE_ID);

      expect(result).toEqual(['user-2', 'user-3']);
      expect(groupUserChain.in).toHaveBeenCalledWith('group_id', ['group-1']);
      expect(roleUserChain.in).toHaveBeenCalledWith('role_id', ['role-1']);
    });
  });

  // ── getSpaceModules ────────────────────────────────────────────────────

  describe('getSpaceModules', () => {
    const mockModule = {
      id: 'mod-1',
      space_id: SPACE_ID,
      module_type: 'wiki',
      is_enabled: true,
      sort_order: 0,
      settings: null,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };

    it('should return space modules sorted by sort_order', async () => {
      const chain = buildChain({ data: [mockModule], error: null });
      chain.order = jest.fn().mockResolvedValue({
        data: [mockModule],
        error: null,
      });
      mockFrom.mockReturnValue(chain);

      const result = await service.getSpaceModules(SPACE_ID);

      expect(result).toHaveLength(1);
      expect(result[0].module_type).toBe('wiki');
    });

    it('should filter enabled modules when enabledOnly is true', async () => {
      const chain = buildChain({ data: [mockModule], error: null });
      chain.order = jest.fn().mockResolvedValue({
        data: [mockModule],
        error: null,
      });
      mockFrom.mockReturnValue(chain);

      const result = await service.getSpaceModules(SPACE_ID, true);

      expect(chain.eq).toHaveBeenCalledWith('is_enabled', true);
      expect(result).toHaveLength(1);
    });
  });

  // ── updateSpaceModules ─────────────────────────────────────────────────

  describe('updateSpaceModules', () => {
    it('should upsert modules and return updated list', async () => {
      const mockModule = {
        id: 'mod-1',
        space_id: SPACE_ID,
        module_type: 'wiki',
        is_enabled: true,
        sort_order: 0,
        settings: null,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      };

      // upsert call -> success
      const upsertChain = buildChain({ data: [mockModule], error: null });
      // getSpaceModules call -> success
      const getChain = buildChain({ data: [mockModule], error: null });
      getChain.order = jest.fn().mockResolvedValue({
        data: [mockModule],
        error: null,
      });

      // 1: previous rows, 2: upsert, then getSpaceModules
      const previousChain = buildChain({ data: [], error: null });
      let callCount = 0;
      mockFrom.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return previousChain;
        return callCount === 2 ? upsertChain : getChain;
      });

      const result = await service.updateSpaceModules(SPACE_ID, 'user-1', [
        { module_type: 'wiki', is_enabled: true, sort_order: 0 },
      ]);

      expect(result).toHaveLength(1);
      expect(upsertChain.upsert).toHaveBeenCalled();
    });

    it('writes one space_module audit row per module whose state changed', async () => {
      jest
        .spyOn(
          service as unknown as {
            assertSpaceInOrganization: () => Promise<unknown>;
          },
          'assertSpaceInOrganization',
        )
        .mockResolvedValue({
          id: SPACE_ID,
          organization_id: 'org-1',
        });
      const previousChain = buildChain({
        data: [
          { module_type: 'wiki', is_enabled: true },
          { module_type: 'tasks', is_enabled: true },
        ],
        error: null,
      });
      const upsertChain = buildChain({
        data: [
          {
            id: 'mod-wiki',
            space_id: SPACE_ID,
            module_type: 'wiki',
            is_enabled: true,
          },
          {
            id: 'mod-tasks',
            space_id: SPACE_ID,
            module_type: 'tasks',
            is_enabled: false,
          },
        ],
        error: null,
      });
      const getChain = buildChain({ data: [], error: null });
      let callCount = 0;
      mockFrom.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return previousChain;
        return callCount === 2 ? upsertChain : getChain;
      });

      await service.updateSpaceModules(SPACE_ID, 'user-1', 'org-1', [
        { module_type: 'wiki', is_enabled: true, sort_order: 0 },
        { module_type: 'tasks', is_enabled: false, sort_order: 1 },
      ]);

      expect(mockAuditLogs.createLog).toHaveBeenCalledTimes(1);
      expect(mockAuditLogs.createLog).toHaveBeenCalledWith('org-1', 'user-1', {
        entity_type: 'space_module',
        entity_id: 'mod-tasks',
        action: 'update',
        changes: {
          space_id: SPACE_ID,
          module_type: 'tasks',
          is_enabled: false,
        },
      });
    });

    it('403s FEATURE_NOT_ENTITLED when enabling resource_planning without the licence', async () => {
      jest
        .spyOn(
          service as unknown as {
            assertSpaceInOrganization: () => Promise<unknown>;
          },
          'assertSpaceInOrganization',
        )
        .mockResolvedValue({
          id: SPACE_ID,
          organization_id: 'org-1',
        });
      Object.assign(service, {
        entitlementsService: {
          getEffectiveEntitlements: jest
            .fn()
            .mockResolvedValue({ has: () => false }),
        },
      });
      const chain = buildChain({ data: [], error: null });
      mockFrom.mockReturnValue(chain);

      const error: unknown = await service
        .updateSpaceModules(SPACE_ID, 'user-1', 'org-1', [
          {
            module_type: 'resource_planning',
            is_enabled: true,
            sort_order: 0,
          },
        ])
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: 'FEATURE_NOT_ENTITLED',
        feature_key: 'module_resource_planning',
      });
      expect(chain.upsert).not.toHaveBeenCalled();
    });

    it('403s FEATURE_NOT_ENTITLED when enabling calendar without the licence', async () => {
      jest
        .spyOn(
          service as unknown as {
            assertSpaceInOrganization: () => Promise<unknown>;
          },
          'assertSpaceInOrganization',
        )
        .mockResolvedValue({
          id: SPACE_ID,
          organization_id: 'org-1',
        });
      Object.assign(service, {
        entitlementsService: {
          getEffectiveEntitlements: jest
            .fn()
            .mockResolvedValue({ has: () => false }),
        },
      });
      const chain = buildChain({ data: [], error: null });
      mockFrom.mockReturnValue(chain);

      const error: unknown = await service
        .updateSpaceModules(SPACE_ID, 'user-1', 'org-1', [
          { module_type: 'calendar', is_enabled: true, sort_order: 0 },
        ])
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: 'FEATURE_NOT_ENTITLED',
        feature_key: 'module_calendar',
      });
      expect(chain.upsert).not.toHaveBeenCalled();
    });

    describe('test management task types', () => {
      let syncTaskTypes: jest.Mock;
      let upsertChain: Record<string, jest.Mock>;

      beforeEach(() => {
        jest
          .spyOn(
            service as unknown as {
              assertSpaceInOrganization: () => Promise<unknown>;
            },
            'assertSpaceInOrganization',
          )
          .mockResolvedValue({
            id: SPACE_ID,
            organization_id: 'org-1',
          });
        syncTaskTypes = jest.fn().mockResolvedValue(undefined);
        Object.assign(service, {
          entitlementsService: {
            getEffectiveEntitlements: jest
              .fn()
              .mockResolvedValue({ has: () => true }),
          },
          testManagementSettings: { syncTaskTypes },
        });
        const previousChain = buildChain({ data: [], error: null });
        upsertChain = buildChain({ data: [], error: null });
        const getChain = buildChain({ data: [], error: null });
        let callCount = 0;
        mockFrom.mockImplementation(() => {
          callCount++;
          if (callCount === 1) return previousChain;
          return callCount === 2 ? upsertChain : getChain;
        });
      });

      it('syncs task types on when test_management is enabled', async () => {
        await service.updateSpaceModules(SPACE_ID, 'user-1', 'org-1', [
          { module_type: 'test_management', is_enabled: true, sort_order: 0 },
        ]);

        expect(syncTaskTypes).toHaveBeenCalledTimes(1);
        expect(syncTaskTypes).toHaveBeenCalledWith(
          'org-1',
          SPACE_ID,
          true,
          'user-1',
        );
      });

      it('syncs task types off when test_management is disabled', async () => {
        await service.updateSpaceModules(SPACE_ID, 'user-1', 'org-1', [
          {
            module_type: 'test_management',
            is_enabled: false,
            sort_order: 0,
          },
        ]);

        expect(syncTaskTypes).toHaveBeenCalledTimes(1);
        expect(syncTaskTypes).toHaveBeenCalledWith(
          'org-1',
          SPACE_ID,
          false,
          'user-1',
        );
      });

      it('does not sync task types when test_management is not in the request', async () => {
        await service.updateSpaceModules(SPACE_ID, 'user-1', 'org-1', [
          { module_type: 'wiki', is_enabled: true, sort_order: 0 },
        ]);

        expect(syncTaskTypes).not.toHaveBeenCalled();
      });

      it('surfaces a task type sync failure after the modules are saved', async () => {
        const syncError = new Error('sync failed');
        syncTaskTypes.mockRejectedValue(syncError);

        await expect(
          service.updateSpaceModules(SPACE_ID, 'user-1', 'org-1', [
            {
              module_type: 'test_management',
              is_enabled: true,
              sort_order: 0,
            },
          ]),
        ).rejects.toBe(syncError);
        expect(upsertChain.upsert).toHaveBeenCalled();
      });
    });
  });

  // ── getMyPermissions ───────────────────────────────────────────────────

  describe('getMyPermissions', () => {
    it('should return full access for org admin', async () => {
      const chain = buildChain({
        data: { role: 'admin' },
        error: null,
      });
      mockFrom.mockReturnValue(chain);

      const result = await service.getMyPermissions(
        'user-1',
        SPACE_ID,
        'org-1',
      );

      expect(result.is_full_access).toBe(true);
      expect(result.source).toBe('organization_role');
    });

    it('should return full access for org owner', async () => {
      const chain = buildChain({
        data: { role: 'owner' },
        error: null,
      });
      mockFrom.mockReturnValue(chain);

      const result = await service.getMyPermissions(
        'user-1',
        SPACE_ID,
        'org-1',
      );

      expect(result.is_full_access).toBe(true);
      expect(result.source).toBe('organization_role');
    });

    it('should return space member permissions for non-admin', async () => {
      // org_members query -> member role
      const orgChain = buildChain({
        data: { role: 'member' },
        error: null,
      });
      // space_members query -> space member
      const spaceChain = buildChain({
        data: {
          ...mockMember,
          space_role: 'editor',
          permissions: { can_edit: true },
        },
        error: null,
      });

      let callCount = 0;
      mockFrom.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? orgChain : spaceChain;
      });

      const result = await service.getMyPermissions(
        'user-1',
        SPACE_ID,
        'org-1',
      );

      expect(result.source).toBe('space_member');
      expect(result.space_role).toBe('editor');
      expect(result.is_full_access).toBe(false);
    });

    it('should return no access when user is not a space member', async () => {
      const orgChain = buildChain({
        data: { role: 'member' },
        error: null,
      });
      const spaceChain = buildChain({ data: null, error: null });

      let callCount = 0;
      mockFrom.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? orgChain : spaceChain;
      });

      const result = await service.getMyPermissions(
        'user-1',
        SPACE_ID,
        'org-1',
      );

      expect(result.source).toBe('none');
      expect(result.is_full_access).toBe(false);
    });
  });

  // ── getSpaceInvitations ────────────────────────────────────────────────

  describe('getSpaceInvitations', () => {
    it('should return pending invitations for a space', async () => {
      const mockInvitation = {
        id: 'inv-1',
        space_id: SPACE_ID,
        email: 'test@example.com',
        status: 'pending',
      };
      const chain = buildChain({ data: [mockInvitation], error: null });
      chain.order = jest.fn().mockResolvedValue({
        data: [mockInvitation],
        error: null,
      });
      mockFrom.mockReturnValue(chain);

      const result = await service.getSpaceInvitations(SPACE_ID);

      expect(result).toHaveLength(1);
    });
  });

  // ── createSpaceInvitations ─────────────────────────────────────────────

  describe('createSpaceInvitations', () => {
    it('should create invitation for valid user', async () => {
      const mockInvitation = {
        id: 'inv-1',
        space_id: SPACE_ID,
        email: 'user2@example.com',
        status: 'pending',
      };

      // 1. space archived check -> not archived
      const spaceCheckChain = buildChain({
        data: { is_archived: false, name: 'Engineering' },
        error: null,
      });
      // 2. organization name lookup
      const orgNameChain = buildChain({
        data: { name: 'Acme Inc' },
        error: null,
      });
      // 3. inviter name lookup
      const inviterChain = buildChain({
        data: { first_name: 'Alice', last_name: 'Admin' },
        error: null,
      });
      // 4. user lookup -> found (identity + active-state only; org membership
      //    is resolved separately via organization_members)
      const userChain = buildChain({
        data: {
          id: 'user-2',
          email: 'user2@example.com',
          first_name: 'Test',
          last_name: 'User',
          is_active: true,
        },
        error: null,
      });
      // 5. organization_members lookup -> user is an org member
      const orgMembershipChain = buildChain({
        data: { id: 'om-1' },
        error: null,
      });
      // 6. existing member check -> not found
      const memberCheckChain = buildChain({ data: null, error: null });
      // 7. implicit members check -> none
      const implicitCheckChain = buildChain({ data: [], error: null });
      // 8. existing invite check -> not found
      const inviteCheckChain = buildChain({ data: null, error: null });
      // 9. insert invitation -> success
      const insertChain = buildChain({
        data: mockInvitation,
        error: null,
      });
      // 10. notification insert (chained .then on insert).
      const notificationChain = buildChain({ data: null, error: null });

      let callCount = 0;
      mockFrom.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return spaceCheckChain;
        if (callCount === 2) return orgNameChain;
        if (callCount === 3) return inviterChain;
        if (callCount === 4) return userChain;
        if (callCount === 5) return orgMembershipChain;
        if (callCount === 6) return memberCheckChain;
        if (callCount === 7) return implicitCheckChain;
        if (callCount === 8) return inviteCheckChain;
        if (callCount === 9) return insertChain;
        return notificationChain;
      });

      const result = await service.createSpaceInvitations(
        SPACE_ID,
        'org-1',
        'user-1',
        [{ user_id: 'user-2', space_role: 'member' }],
      );

      expect(result.created).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
    });

    it('should return error for non-existent user', async () => {
      const spaceCheckChain = buildChain({
        data: { is_archived: false },
        error: null,
      });
      const userChain = buildChain({ data: null, error: null });
      let callCount = 0;
      mockFrom.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return spaceCheckChain;
        return userChain;
      });

      const result = await service.createSpaceInvitations(
        SPACE_ID,
        'org-1',
        'user-1',
        [{ user_id: 'missing-user', space_role: 'member' }],
      );

      expect(result.created).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].reason).toBe('User not found');
    });
  });

  // ── resendSpaceInvitation ──────────────────────────────────────────────

  describe('resendSpaceInvitation', () => {
    const mockInvitation = {
      id: 'inv-1',
      space_id: SPACE_ID,
      organization_id: 'org-1',
      email: 'test@example.com',
      status: 'pending',
      token: 'old-token',
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    };

    it('should resend invitation with new token', async () => {
      // fetch -> found
      const fetchChain = buildChain({
        data: mockInvitation,
        error: null,
      });
      // update -> success
      const updateChain = buildChain({
        data: { ...mockInvitation, token: 'new-token' },
        error: null,
      });

      let callCount = 0;
      mockFrom.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? fetchChain : updateChain;
      });

      const result = await service.resendSpaceInvitation(
        SPACE_ID,
        'inv-1',
        'org-1',
      );

      expect(result.token).toBe('new-token');
      expect(mockAuthAdminDeleteUser).not.toHaveBeenCalled();
      expect(mockMailService.sendSpaceInvitation).toHaveBeenCalledWith(
        'test@example.com',
        expect.objectContaining({
          invitationLink:
            'http://localhost:3000/auth/accept-invitation?token=new-token',
          spaceRole: 'member',
        }),
      );
    });

    it('should throw NotFoundException when invitation not found', async () => {
      const chain = buildChain({
        data: null,
        error: { message: 'not found' },
      });
      mockFrom.mockReturnValue(chain);

      await expect(
        service.resendSpaceInvitation(SPACE_ID, 'missing', 'org-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw when invitation does not belong to space', async () => {
      const chain = buildChain({
        data: { ...mockInvitation, space_id: 'other-space' },
        error: null,
      });
      mockFrom.mockReturnValue(chain);

      await expect(
        service.resendSpaceInvitation(SPACE_ID, 'inv-1', 'org-1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── revokeSpaceInvitation ──────────────────────────────────────────────

  describe('revokeSpaceInvitation', () => {
    const mockInvitation = {
      id: 'inv-1',
      space_id: SPACE_ID,
      status: 'pending',
    };

    it('should revoke the invitation', async () => {
      const fetchChain = buildChain({
        data: mockInvitation,
        error: null,
      });
      const updateChain = buildChain({
        data: { ...mockInvitation, status: 'revoked' },
        error: null,
      });

      let callCount = 0;
      mockFrom.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? fetchChain : updateChain;
      });

      const result = await service.revokeSpaceInvitation(SPACE_ID, 'inv-1');

      expect(result.status).toBe('revoked');
    });

    it('should throw when invitation does not belong to space', async () => {
      const chain = buildChain({
        data: { ...mockInvitation, space_id: 'other-space' },
        error: null,
      });
      mockFrom.mockReturnValue(chain);

      await expect(
        service.revokeSpaceInvitation(SPACE_ID, 'inv-1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── acceptSpaceInvitation ──────────────────────────────────────────────

  describe('acceptSpaceInvitation', () => {
    const mockInvitation = {
      id: 'inv-1',
      space_id: SPACE_ID,
      organization_id: 'org-1',
      invited_by: 'user-1',
      email: 'user2@example.com',
      status: 'pending',
      space_role: 'member',
      space_permissions: null,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    };

    it('should accept invitation and create space membership', async () => {
      // fetch invitation
      const fetchChain = buildChain({
        data: mockInvitation,
        error: null,
      });
      // check existing member -> not found
      const memberCheckChain = buildChain({ data: null, error: null });
      // insert member -> success
      const insertChain = buildChain({
        data: { ...mockMember, user_id: 'user-2' },
        error: null,
      });
      // update invitation status -> success
      const updateChain = buildChain({ data: null, error: null });

      let callCount = 0;
      mockFrom.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return fetchChain;
        if (callCount === 4) return memberCheckChain;
        if (callCount === 5) return insertChain;
        return updateChain;
      });

      const result = await service.acceptSpaceInvitation(
        SPACE_ID,
        'inv-1',
        'user-2',
        'user2@example.com',
      );

      expect(result.success).toBe(true);
      expect(result.message).toBe('Invitation accepted');
    });

    it('should throw ForbiddenException when email does not match', async () => {
      const fetchChain = buildChain({
        data: mockInvitation,
        error: null,
      });
      mockFrom.mockReturnValue(fetchChain);

      await expect(
        service.acceptSpaceInvitation(
          SPACE_ID,
          'inv-1',
          'user-2',
          'wrong@example.com',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw when invitation is expired', async () => {
      const expiredInvitation = {
        ...mockInvitation,
        expires_at: new Date(Date.now() - 86400000).toISOString(),
      };
      // fetch -> expired invitation
      const fetchChain = buildChain({
        data: expiredInvitation,
        error: null,
      });
      // update status to expired
      const updateChain = buildChain({ data: null, error: null });

      let callCount = 0;
      mockFrom.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? fetchChain : updateChain;
      });

      await expect(
        service.acceptSpaceInvitation(
          SPACE_ID,
          'inv-1',
          'user-2',
          'user2@example.com',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw when invitation is not pending', async () => {
      const acceptedInvitation = {
        ...mockInvitation,
        status: 'accepted',
      };
      const fetchChain = buildChain({
        data: acceptedInvitation,
        error: null,
      });
      mockFrom.mockReturnValue(fetchChain);

      await expect(
        service.acceptSpaceInvitation(
          SPACE_ID,
          'inv-1',
          'user-2',
          'user2@example.com',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // MCP-facing accessible-space reads

  describe('MCP-facing accessible-space reads', () => {
    let mcpService: SpacesService;
    let mcpFrom: jest.Mock;
    let permissionsService: {
      isAdminOrOwner: jest.Mock;
      getUserSpacePermissions: jest.Mock;
    };

    const userOf = (overrides: Record<string, unknown> = {}) =>
      ({
        authUserId: 'auth-1',
        userId: 'user-1',
        email: 'user@example.com',
        organizationId: 'org-1',
        memberships: [],
        ...overrides,
      }) as unknown as import('../auth/interfaces/request-user.interface').RequestUser;

    // A chain whose terminal `await` resolves to the given value and that also
    // supports the keyset cursor (`gt`) used by listMyAccessibleSpaces.
    const listChain = (resolved: { data: unknown; error: unknown }) => {
      const chain: Record<string, jest.Mock> = {};
      const self = () => chain;
      chain.select = jest.fn().mockImplementation(self);
      chain.eq = jest.fn().mockImplementation(self);
      chain.is = jest.fn().mockImplementation(self);
      chain.not = jest.fn().mockImplementation(self);
      chain.gt = jest.fn().mockImplementation(self);
      chain.order = jest.fn().mockImplementation(self);
      chain.limit = jest.fn().mockImplementation(self);
      chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
      (
        chain as unknown as {
          then: (cb: (v: unknown) => unknown) => Promise<unknown>;
        }
      ).then = (cb: (v: unknown) => unknown) =>
        Promise.resolve(resolved).then(cb);

      return chain;
    };

    const modulesChain = (modules: string[]) =>
      listChain({
        data: modules.map((m) => ({ module_type: m })),
        error: null,
      });

    beforeEach(() => {
      mcpFrom = jest.fn();
      const supabaseAdmin = {
        getClient: () => ({ from: mcpFrom }),
      } as unknown as SupabaseAdminService;
      const auditLogsService = {
        logAction: jest.fn(),
      } as unknown as import('../audit-logs/audit-logs.service').AuditLogsService;
      const mailService =
        {} as unknown as import('../mail/mail.service').MailService;

      permissionsService = {
        isAdminOrOwner: jest.fn().mockResolvedValue(false),
        getUserSpacePermissions: jest.fn(),
      };

      mcpService = new SpacesService(
        supabaseAdmin,
        auditLogsService,
        mailService,
        {
          drainSpace: jest.fn(),
        } as unknown as import('./space-storage-cleanup.processor').SpaceStorageCleanupProcessor,
        undefined,
        permissionsService as unknown as import('../permissions/permissions.service').PermissionsService,
      );
    });

    describe('listMyAccessibleSpaces', () => {
      it('returns { spaces: [] } (never null) for the onboarding org', async () => {
        const result = await mcpService.listMyAccessibleSpaces(
          userOf({ organizationId: '' }),
        );

        expect(result).toEqual({ spaces: [] });
        expect(mcpFrom).not.toHaveBeenCalled();
      });

      it('keeps only member spaces and hides non-member spaces', async () => {
        // candidate spaces query
        mcpFrom.mockReturnValueOnce(
          listChain({
            data: [
              {
                id: SPACE_ID,
                key: 'ENG',
                name: 'Engineering',
                description: null,
                icon: null,
                color: null,
                is_archived: false,
              },
              {
                id: 'space-2',
                key: 'SEC',
                name: 'Secret',
                description: null,
                icon: null,
                color: null,
                is_archived: false,
              },
            ],
            error: null,
          }),
        );
        // space-1 member, space-2 not member
        permissionsService.getUserSpacePermissions
          .mockResolvedValueOnce({
            isMember: true,
            spaceRole: 'member',
            globalRole: 'member',
            permissions: {},
          })
          .mockResolvedValueOnce({
            isMember: false,
            spaceRole: null,
            globalRole: 'member',
            permissions: {},
          });
        // modules for space-1
        mcpFrom.mockReturnValueOnce(modulesChain(['boards', 'tasks']));

        const result = await mcpService.listMyAccessibleSpaces(userOf());

        expect(result.spaces).toHaveLength(1);
        expect(result.spaces[0]).toEqual({
          id: SPACE_ID,
          key: 'ENG',
          name: 'Engineering',
          description: null,
          icon: null,
          color: null,
          isArchived: false,
          modules: ['boards', 'tasks'],
        });
        expect(result.nextCursor).toBeUndefined();
      });

      it('short-circuits to all org spaces for an org admin/owner', async () => {
        permissionsService.isAdminOrOwner.mockResolvedValue(true);
        mcpFrom.mockReturnValueOnce(
          listChain({
            data: [
              {
                id: SPACE_ID,
                key: 'ENG',
                name: 'Engineering',
                description: null,
                icon: null,
                color: null,
                is_archived: false,
              },
              {
                id: 'space-2',
                key: 'SEC',
                name: 'Secret',
                description: null,
                icon: null,
                color: null,
                is_archived: false,
              },
            ],
            error: null,
          }),
        );
        // modules for each of the two spaces
        mcpFrom.mockReturnValueOnce(modulesChain([]));
        mcpFrom.mockReturnValueOnce(modulesChain([]));

        const result = await mcpService.listMyAccessibleSpaces(userOf());

        expect(result.spaces.map((s) => s.id)).toEqual([SPACE_ID, 'space-2']);
        // admin path never runs per-space membership checks
        expect(
          permissionsService.getUserSpacePermissions,
        ).not.toHaveBeenCalled();
      });

      it('excludes archived spaces by default and includes them with includeArchived', async () => {
        permissionsService.isAdminOrOwner.mockResolvedValue(true);
        const candidates = listChain({
          data: [
            {
              id: SPACE_ID,
              key: 'ENG',
              name: 'Engineering',
              description: null,
              icon: null,
              color: null,
              is_archived: false,
            },
          ],
          error: null,
        });
        mcpFrom.mockReturnValueOnce(candidates);
        mcpFrom.mockReturnValueOnce(modulesChain([]));

        await mcpService.listMyAccessibleSpaces(userOf(), {
          includeArchived: false,
        });

        // default path adds the is_archived=false filter
        expect(candidates.eq).toHaveBeenCalledWith('is_archived', false);

        // includeArchived path omits the is_archived filter
        mcpFrom.mockReset();
        const candidates2 = listChain({
          data: [
            {
              id: SPACE_ID,
              key: 'ENG',
              name: 'Engineering',
              description: null,
              icon: null,
              color: null,
              is_archived: true,
            },
          ],
          error: null,
        });
        mcpFrom.mockReturnValueOnce(candidates2);
        mcpFrom.mockReturnValueOnce(modulesChain([]));

        await mcpService.listMyAccessibleSpaces(userOf(), {
          includeArchived: true,
        });

        expect(candidates2.eq).not.toHaveBeenCalledWith('is_archived', false);
      });

      it('emits a nextCursor when more visible spaces remain than the limit', async () => {
        permissionsService.isAdminOrOwner.mockResolvedValue(true);
        mcpFrom.mockReturnValueOnce(
          listChain({
            data: [
              {
                id: SPACE_ID,
                key: 'A',
                name: 'A',
                description: null,
                icon: null,
                color: null,
                is_archived: false,
              },
              {
                id: 'space-2',
                key: 'B',
                name: 'B',
                description: null,
                icon: null,
                color: null,
                is_archived: false,
              },
            ],
            error: null,
          }),
        );
        // only the first (limited) space's modules are fetched
        mcpFrom.mockReturnValueOnce(modulesChain([]));

        const result = await mcpService.listMyAccessibleSpaces(userOf(), {
          limit: 1,
        });

        expect(result.spaces).toHaveLength(1);
        expect(result.nextCursor).toBe(SPACE_ID);
      });

      // Bounded keyset pagination

      const candidateRow = (id: string) => ({
        id,
        key: id.toUpperCase(),
        name: id,
        description: null,
        icon: null,
        color: null,
        is_archived: false,
      });

      it('(a) admin keyset fetches limit+1, returns limit rows + cursor, and resumes without dup/skip', async () => {
        permissionsService.isAdminOrOwner.mockResolvedValue(true);

        // Page 1: limit=2, so the keyset query fetches limit+1 = 3 rows.
        const page1 = listChain({
          data: [
            candidateRow(SPACE_ID),
            candidateRow('space-2'),
            candidateRow('space-3'),
          ],
          error: null,
        });
        mcpFrom.mockReturnValueOnce(page1);
        // modules for the 2 returned rows
        mcpFrom.mockReturnValueOnce(modulesChain([]));
        mcpFrom.mockReturnValueOnce(modulesChain([]));

        const r1 = await mcpService.listMyAccessibleSpaces(userOf(), {
          limit: 2,
        });

        expect(r1.spaces.map((s) => s.id)).toEqual([SPACE_ID, 'space-2']);
        expect(r1.nextCursor).toBe('space-2');
        // proves the keyset bound: limit + 1
        expect(page1.limit).toHaveBeenCalledWith(3);
        // admin path runs no per-space membership checks
        expect(
          permissionsService.getUserSpacePermissions,
        ).not.toHaveBeenCalled();

        // Page 2: resume from the cursor, no dup of space-2, no skip of space-3.
        const page2 = listChain({
          data: [candidateRow('space-3')],
          error: null,
        });
        mcpFrom.mockReturnValueOnce(page2);
        mcpFrom.mockReturnValueOnce(modulesChain([]));

        const r2 = await mcpService.listMyAccessibleSpaces(userOf(), {
          limit: 2,
          cursor: r1.nextCursor,
        });

        expect(r2.spaces.map((s) => s.id)).toEqual(['space-3']);
        expect(r2.nextCursor).toBeUndefined();
        // cursor was applied as a keyset `> id` filter
        expect(page2.gt).toHaveBeenCalledWith('id', 'space-2');
      });

      it('(b) non-admin bounded scan fetches only a candidate batch (limited, not select-all)', async () => {
        // isAdminOrOwner defaults to false (set in beforeEach)
        const batch = listChain({
          data: [candidateRow(SPACE_ID)],
          error: null,
        });
        mcpFrom.mockReturnValueOnce(batch);
        permissionsService.getUserSpacePermissions.mockResolvedValue({
          isMember: true,
          spaceRole: 'member',
          globalRole: 'member',
          permissions: {},
        });
        mcpFrom.mockReturnValueOnce(modulesChain([]));

        const result = await mcpService.listMyAccessibleSpaces(userOf());

        expect(result.spaces.map((s) => s.id)).toEqual([SPACE_ID]);
        // The candidate query must be bounded by a limit (SCAN_BATCH = 200),
        // not an unbounded select-all over every org space.
        expect(batch.limit).toHaveBeenCalledWith(200);
        // membership was checked only for the single scanned candidate
        expect(
          permissionsService.getUserSpacePermissions,
        ).toHaveBeenCalledTimes(1);
      });

      it('(c) a full-batch scan with few visible returns the candidate-id nextCursor (short page)', async () => {
        // Build a full batch of SCAN_BATCH (200) candidate ids. Only the first
        // is a member, so the page is short (1 row) but must still page on.
        const ids = Array.from(
          { length: 200 },
          (_, i) => `space-${String(i + 1).padStart(3, '0')}`,
        );
        const batch = listChain({
          data: ids.map(candidateRow),
          error: null,
        });
        mcpFrom.mockReturnValueOnce(batch);

        permissionsService.getUserSpacePermissions.mockImplementation(
          (_userId: string, _orgId: string, spaceId: string) =>
            Promise.resolve({
              isMember: spaceId === ids[0],
              spaceRole: spaceId === ids[0] ? 'member' : null,
              globalRole: 'member',
              permissions: {},
            }),
        );
        // modules for the single visible space
        mcpFrom.mockReturnValueOnce(modulesChain([]));

        const result = await mcpService.listMyAccessibleSpaces(userOf(), {
          limit: 25,
        });

        // Short page: fewer than `limit` visible rows,
        expect(result.spaces.map((s) => s.id)).toEqual([ids[0]]);
        // but a cursor is still emitted, anchored on the last scanned candidate
        // id (not the last visible id) so paging resumes into the unscanned tail.
        expect(result.nextCursor).toBe(ids[199]);
        // all 200 candidates in the batch were checked (bounded by SCAN_BATCH)
        expect(
          permissionsService.getUserSpacePermissions,
        ).toHaveBeenCalledTimes(200);
      });

      it('(d) non-admin with a non-full batch (candidates exhausted) returns no nextCursor', async () => {
        const batch = listChain({
          data: [candidateRow(SPACE_ID), candidateRow('space-2')],
          error: null,
        });
        mcpFrom.mockReturnValueOnce(batch);

        permissionsService.getUserSpacePermissions.mockResolvedValue({
          isMember: true,
          spaceRole: 'member',
          globalRole: 'member',
          permissions: {},
        });
        // modules for the two visible spaces
        mcpFrom.mockReturnValueOnce(modulesChain([]));
        mcpFrom.mockReturnValueOnce(modulesChain([]));

        const result = await mcpService.listMyAccessibleSpaces(userOf(), {
          limit: 25,
        });

        expect(result.spaces.map((s) => s.id)).toEqual([SPACE_ID, 'space-2']);
        // batch (2) < SCAN_BATCH (200), so candidates are exhausted, no further pages
        expect(result.nextCursor).toBeUndefined();
      });
    });

    describe('getMyAccessibleSpace', () => {
      it('returns detail + role + permission keys for a member (by UUID)', async () => {
        mcpFrom.mockReturnValueOnce(
          listChain({
            data: {
              id: '11111111-1111-4111-8111-111111111111',
              key: 'ENG',
              name: 'Engineering',
              description: 'desc',
              is_archived: false,
            },
            error: null,
          }),
        );
        permissionsService.getUserSpacePermissions.mockResolvedValue({
          isMember: true,
          spaceRole: 'admin',
          globalRole: 'admin',
          permissions: { view_space: true, edit_space_settings: false },
        });
        mcpFrom.mockReturnValueOnce(modulesChain(['boards']));

        const result = await mcpService.getMyAccessibleSpace(
          userOf(),
          '11111111-1111-4111-8111-111111111111',
        );

        expect(result.space.id).toBe('11111111-1111-4111-8111-111111111111');
        expect(result.space.modules).toEqual(['boards']);
        expect(result.myRole).toBe('admin');
        // only strictly-true permission keys are surfaced
        expect(result.myPermissions).toEqual(['view_space']);
      });

      it('throws NotFoundException for a non-member (same as nonexistent)', async () => {
        mcpFrom.mockReturnValueOnce(
          listChain({
            data: {
              id: '11111111-1111-4111-8111-111111111111',
              key: 'ENG',
              name: 'Engineering',
              description: null,
              is_archived: false,
            },
            error: null,
          }),
        );
        permissionsService.getUserSpacePermissions.mockResolvedValue({
          isMember: false,
          spaceRole: null,
          globalRole: 'member',
          permissions: {},
        });

        await expect(
          mcpService.getMyAccessibleSpace(
            userOf(),
            '11111111-1111-4111-8111-111111111111',
          ),
        ).rejects.toThrow(NotFoundException);
      });

      it('throws an identical NotFoundException for a nonexistent space', async () => {
        mcpFrom.mockReturnValueOnce(listChain({ data: null, error: null }));

        await expect(
          mcpService.getMyAccessibleSpace(
            userOf(),
            '11111111-1111-4111-8111-111111111111',
          ),
        ).rejects.toThrow(NotFoundException);
        // a nonexistent space never reaches the membership check
        expect(
          permissionsService.getUserSpacePermissions,
        ).not.toHaveBeenCalled();
      });

      it('resolves a non-UUID argument by key (case-insensitive)', async () => {
        const byKeyChain = listChain({
          data: {
            id: SPACE_ID,
            key: 'ENG',
            name: 'Engineering',
            description: null,
            description_i18n: null,
            name_i18n: null,
            icon: null,
            icon_url: null,
            icon_path: null,
            color: null,
            background_color: null,
            category: null,
            space_type_id: null,
            lead_id: null,
            is_active: true,
            is_archived: false,
            archived_at: null,
            archived_by: null,
            settings: null,
            created_by: null,
            updated_by: null,
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
          error: null,
        });
        mcpFrom.mockReturnValueOnce(byKeyChain);
        permissionsService.getUserSpacePermissions.mockResolvedValue({
          isMember: true,
          spaceRole: 'member',
          globalRole: 'member',
          permissions: {},
        });
        mcpFrom.mockReturnValueOnce(modulesChain([]));

        const result = await mcpService.getMyAccessibleSpace(userOf(), 'eng');

        expect(result.space.key).toBe('ENG');
        // getSpaceByKey upper-cases the key before querying
        expect(byKeyChain.eq).toHaveBeenCalledWith('key', 'ENG');
      });

      it('throws NotFoundException for the onboarding org', async () => {
        await expect(
          mcpService.getMyAccessibleSpace(
            userOf({ organizationId: '' }),
            'eng',
          ),
        ).rejects.toThrow(NotFoundException);
        expect(mcpFrom).not.toHaveBeenCalled();
      });
    });
  });
});
