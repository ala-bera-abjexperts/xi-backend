/**
 * @fileoverview Unit tests for the OrganizationsService covering organization
 * creation, branding CRUD, and logo upload/deletion.
 * @module src/organizations/organizations.service.spec
 * @author Prince Jadiya
 */

import { UPLOAD_LIMITS } from '../common/upload-limits';
import { Readable } from 'stream';
import { OrganizationsService } from './organizations.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { UsersService } from '../users/users.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

function createMockFile(
  overrides: Partial<Express.Multer.File> = {},
): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'test.png',
    encoding: '7bit',
    mimetype: 'image/png',
    size: 1024,
    buffer: Buffer.from('test'),
    stream: new Readable(),
    destination: '',
    filename: '',
    path: '',
    ...overrides,
  };
}
import { BadRequestException } from '@nestjs/common';

describe('OrganizationsService', () => {
  let service: OrganizationsService;
  let mockFrom: jest.Mock;
  let mockRpc: jest.Mock;
  let mockStorage: Record<string, jest.Mock>;
  let mockUsersService: Partial<UsersService>;
  let mockAuditLogsService: { logAction: jest.Mock };

  const mockOrg = {
    id: 'org-1',
    name: 'Test Org',
    slug: 'test-org',
    size: 'medium',
    is_active: true,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };

  const mockBranding = {
    organization_id: 'org-1',
    logo_light_url: null,
    logo_light_path: null,
    logo_dark_url: null,
    logo_dark_path: null,
    emblem_light_url: null,
    emblem_light_path: null,
    emblem_dark_url: null,
    emblem_dark_path: null,
    primary_color: '#3B82F6',
    updated_by: 'user-1',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };

  /**
   * Helper to build a chainable Supabase query mock.
   * Each call to select/eq/insert/update/upsert/delete returns `this`,
   * and the terminal methods (single/maybeSingle) resolve to the provided value.
   */
  function buildChain(resolvedValue: { data: unknown; error: unknown }) {
    const chain: Record<string, jest.Mock> = {};
    const self = () => chain;
    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.update = jest.fn().mockImplementation(self);
    chain.upsert = jest.fn().mockImplementation(self);
    chain.delete = jest.fn().mockImplementation(self);
    chain.single = jest.fn().mockResolvedValue(resolvedValue);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolvedValue);
    return chain;
  }

  beforeEach(() => {
    mockStorage = {
      upload: jest.fn().mockResolvedValue({ error: null }),
      remove: jest.fn().mockResolvedValue({ error: null }),
      getPublicUrl: jest.fn().mockReturnValue({
        data: { publicUrl: 'https://example.com/logo.png' },
      }),
    };

    mockFrom = jest.fn();
    mockRpc = jest.fn();

    const supabaseAdmin = {
      getClient: () => ({
        from: mockFrom,
        rpc: mockRpc,
        storage: {
          from: () => mockStorage,
        },
      }),
    } as unknown as SupabaseAdminService;

    mockUsersService = {
      getUserById: jest.fn(),
    };
    mockAuditLogsService = {
      logAction: jest.fn().mockResolvedValue(undefined),
    };

    service = new OrganizationsService(
      supabaseAdmin,
      mockUsersService as UsersService,
      mockAuditLogsService as unknown as AuditLogsService,
    );
  });

  // ── createOrganization ───────────────────────────────────────────────────

  describe('createOrganization', () => {
    it('should create an organization and set user as owner', async () => {
      (mockUsersService.getUserById as jest.Mock).mockResolvedValue({
        id: 'user-1',
        organization_id: null,
      });

      // slug check -> not found
      const slugChain = buildChain({ data: null, error: null });
      mockFrom.mockReturnValue(slugChain);

      // The org row and the 'owner' organization_members row are created
      // atomically inside the RPC, so it is the sole write path here.
      mockRpc.mockResolvedValue({ data: mockOrg, error: null });

      const result = await service.createOrganization('user-1', {
        name: 'Test Org',
        slug: 'test-org',
        size: 'medium',
      });

      expect(result).toEqual(mockOrg);
      expect(mockRpc).toHaveBeenCalledWith('create_organization_with_owner', {
        p_user_id: 'user-1',
        p_name: 'Test Org',
        p_slug: 'test-org',
        p_size: 'medium',
      });
    });

    it('should create an organization when the user already belongs to another one', async () => {
      // Membership now lives exclusively in organization_members, so the old
      // single-org guard was intentionally removed: an existing membership
      // must not block creating a further organization.
      (mockUsersService.getUserById as jest.Mock).mockResolvedValue({
        id: 'user-1',
        organization_id: 'existing-org',
      });

      const slugChain = buildChain({ data: null, error: null });
      mockFrom.mockReturnValue(slugChain);
      mockRpc.mockResolvedValue({ data: mockOrg, error: null });

      const result = await service.createOrganization('user-1', {
        name: 'Test Org',
        slug: 'test-org',
        size: 'medium',
      });

      expect(result).toEqual(mockOrg);
      expect(mockRpc).toHaveBeenCalledWith('create_organization_with_owner', {
        p_user_id: 'user-1',
        p_name: 'Test Org',
        p_slug: 'test-org',
        p_size: 'medium',
      });
    });

    it('should throw BadRequestException when slug is taken', async () => {
      (mockUsersService.getUserById as jest.Mock).mockResolvedValue({
        id: 'user-1',
        organization_id: null,
      });

      const slugChain = buildChain({
        data: { id: 'other-org' },
        error: null,
      });
      mockFrom.mockReturnValue(slugChain);

      await expect(
        service.createOrganization('user-1', {
          name: 'Test Org',
          slug: 'taken-slug',
          size: 'medium',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── getBranding ──────────────────────────────────────────────────────────

  describe('getBranding', () => {
    it('should return branding data when it exists', async () => {
      const chain = buildChain({ data: mockBranding, error: null });
      mockFrom.mockReturnValue(chain);

      const result = await service.getBranding('org-1');
      expect(result).toEqual(mockBranding);
    });

    it('should return null when no branding is configured', async () => {
      const chain = buildChain({ data: null, error: null });
      mockFrom.mockReturnValue(chain);

      const result = await service.getBranding('org-1');
      expect(result).toBeNull();
    });
  });

  // ── upsertBranding ──────────────────────────────────────────────────────

  describe('upsertBranding', () => {
    it('should create a new branding record', async () => {
      const chain = buildChain({ data: mockBranding, error: null });
      mockFrom.mockReturnValue(chain);

      const result = await service.upsertBranding('org-1', 'user-1', {
        organizationId: 'ignored-org',
        primary_color: '#3B82F6',
      });

      expect(result).toEqual(mockBranding);
      expect(chain.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: 'org-1',
          primary_color: '#3B82F6',
          updated_by: 'user-1',
        }),
        { onConflict: 'organization_id' },
      );
      const upsertCalls = chain.upsert.mock.calls as unknown[][];
      expect(upsertCalls[0]?.[0]).not.toHaveProperty('organizationId');
      expect(mockAuditLogsService.logAction).toHaveBeenCalledWith(
        'org-1',
        'user-1',
        'organization_branding',
        'org-1',
        'update',
        { primary_color: '#3B82F6' },
      );
    });

    it('should update an existing branding record', async () => {
      const updatedBranding = { ...mockBranding, primary_color: '#EF4444' };
      const chain = buildChain({ data: updatedBranding, error: null });
      mockFrom.mockReturnValue(chain);

      const result = await service.upsertBranding('org-1', 'user-1', {
        primary_color: '#EF4444',
      });

      expect(result.primary_color).toBe('#EF4444');
    });
  });

  // ── uploadLogo ───────────────────────────────────────────────────────────

  describe('uploadLogo', () => {
    const testFile = createMockFile({
      originalname: 'logo.png',
      mimetype: 'image/png',
      size: 1024,
    });

    it('should reject an invalid slot', async () => {
      await expect(
        service.uploadLogo('org-1', 'user-1', 'invalid_slot', testFile),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject an invalid file type', async () => {
      const badFile = createMockFile({ mimetype: 'application/pdf' });

      await expect(
        service.uploadLogo('org-1', 'user-1', 'logo_light', badFile),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject a file that exceeds the size limit', async () => {
      const largeFile = createMockFile({
        size: UPLOAD_LIMITS.SMALL_IMAGE + 1,
      });

      await expect(
        service.uploadLogo('org-1', 'user-1', 'logo_light', largeFile),
      ).rejects.toThrow(BadRequestException);
    });

    it('should upload logo and update branding', async () => {
      // getBranding -> no existing
      const brandingGetChain = buildChain({ data: null, error: null });
      // upsert -> success
      const updatedBranding = {
        ...mockBranding,
        logo_light_path: 'tenant-logos/org-1/logo_light-123-logo.png',
        logo_light_url: 'https://example.com/logo.png',
      };
      const upsertChain = buildChain({ data: updatedBranding, error: null });

      let callCount = 0;
      mockFrom.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? brandingGetChain : upsertChain;
      });

      const result = await service.uploadLogo(
        'org-1',
        'user-1',
        'logo_light',
        createMockFile({
          originalname: 'my logo!.png',
          mimetype: 'image/png',
          size: 1024,
        }),
      );

      expect(result.logo_light_url).toBe('https://example.com/logo.png');
      const uploadCalls = mockStorage.upload.mock.calls as unknown[][];
      expect(uploadCalls[0]?.[0]).toMatch(
        // storageSafeFileName trims trailing separators from the base: no dangling '_'.
        /tenant-logos\/org-1\/logo_light-\d+-my_logo\.png/,
      );
      expect(mockAuditLogsService.logAction).toHaveBeenCalledWith(
        'org-1',
        'user-1',
        'organization_branding',
        'org-1',
        'update',
        expect.objectContaining({
          slot: 'logo_light',
          path: expect.stringMatching(
            /tenant-logos\/org-1\/logo_light-\d+-my_logo\.png/,
          ) as unknown,
          url: 'https://example.com/logo.png',
        }) as unknown,
      );
    });
  });

  // ── deleteLogo ───────────────────────────────────────────────────────────

  describe('deleteLogo', () => {
    it('should throw BadRequestException for invalid slot', async () => {
      await expect(
        service.deleteLogo('org-1', 'user-1', 'bad_slot'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should upsert null logo fields when branding does not exist', async () => {
      const clearedBranding = {
        ...mockBranding,
        logo_light_path: null,
        logo_light_url: null,
      };
      const getChain = buildChain({ data: null, error: null });
      const upsertChain = buildChain({ data: clearedBranding, error: null });
      let callCount = 0;
      mockFrom.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? getChain : upsertChain;
      });

      const result = await service.deleteLogo('org-1', 'user-1', 'logo_light');

      expect(result.logo_light_path).toBeNull();
      expect(upsertChain.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: 'org-1',
          logo_light_path: null,
          logo_light_url: null,
          updated_by: 'user-1',
        }),
        { onConflict: 'organization_id' },
      );
    });

    it('should delete logo and clear branding fields', async () => {
      const existingBranding = {
        ...mockBranding,
        logo_light_path: 'tenant-logos/org-1/logo_light-old.png',
        logo_light_url: 'https://example.com/old-logo.png',
      };
      const clearedBranding = {
        ...mockBranding,
        logo_light_path: null,
        logo_light_url: null,
      };

      // getBranding -> existing
      const getChain = buildChain({ data: existingBranding, error: null });
      // update -> cleared
      const updateChain = buildChain({ data: clearedBranding, error: null });

      let callCount = 0;
      mockFrom.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? getChain : updateChain;
      });

      const result = await service.deleteLogo('org-1', 'user-1', 'logo_light');

      expect(result.logo_light_path).toBeNull();
      expect(result.logo_light_url).toBeNull();
      expect(mockAuditLogsService.logAction).toHaveBeenCalledWith(
        'org-1',
        'user-1',
        'organization_branding',
        'org-1',
        'update',
        { slot: 'logo_light', cleared: true },
      );
    });
  });
});
