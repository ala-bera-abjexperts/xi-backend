import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { PermissionsService } from '../permissions/permissions.service';
import {
  McpOrgSettingsRow,
  McpSettingsRepository,
} from './mcp-settings.repository';
import { McpSettingsService } from './mcp-settings.service';

const ORG = 'org-1';
const USER = 'user-1';

function makeRow(over: Partial<McpOrgSettingsRow> = {}): McpOrgSettingsRow {
  return {
    organization_id: ORG,
    is_enabled: true,
    allow_write_tools: false,
    allowed_tools: ['task.search'],
    updated_by: USER,
    updated_at: '2026-07-01T00:00:00Z',
    ...over,
  };
}

describe('McpSettingsService', () => {
  let service: McpSettingsService;
  let repository: jest.Mocked<McpSettingsRepository>;
  let permissions: jest.Mocked<PermissionsService>;
  let auditLogs: jest.Mocked<AuditLogsService>;
  let repo: Record<string, jest.Mock>;
  let perms: Record<string, jest.Mock>;
  let audit: Record<string, jest.Mock>;

  beforeEach(() => {
    repository = {
      getSettings: jest.fn(),
      upsertSettings: jest.fn(),
      listActiveGrants: jest.fn(),
      findGrantInOrg: jest.fn(),
      revokeGrant: jest.fn(),
      listRecentAudit: jest.fn(),
    } as unknown as jest.Mocked<McpSettingsRepository>;
    permissions = {
      isAdminOrOwner: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<PermissionsService>;
    auditLogs = {
      createLog: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AuditLogsService>;
    service = new McpSettingsService(repository, permissions, auditLogs);
    repo = repository as unknown as Record<string, jest.Mock>;
    perms = permissions as unknown as Record<string, jest.Mock>;
    audit = auditLogs as unknown as Record<string, jest.Mock>;
  });

  describe('getSettings', () => {
    it('returns fail-closed defaults + the catalog when no row exists', async () => {
      repo['getSettings'].mockResolvedValue(null);
      const view = await service.getSettings(ORG);
      expect(view.is_enabled).toBe(false);
      expect(view.allow_write_tools).toBe(false);
      expect(view.allowed_tools).toEqual([]);
      expect(view.catalog.length).toBe(33);
    });

    it('reflects the stored row', async () => {
      repo['getSettings'].mockResolvedValue(
        makeRow({ is_enabled: true, allowed_tools: ['task.get'] }),
      );
      const view = await service.getSettings(ORG);
      expect(view.is_enabled).toBe(true);
      expect(view.allowed_tools).toEqual(['task.get']);
    });
  });

  describe('updateSettings', () => {
    it('requires admin/owner', async () => {
      perms['isAdminOrOwner'].mockResolvedValue(false);
      await expect(
        service.updateSettings(ORG, USER, { is_enabled: true }),
      ).rejects.toThrow(ForbiddenException);
      expect(repo['upsertSettings']).not.toHaveBeenCalled();
    });

    it('rejects an empty patch', async () => {
      await expect(service.updateSettings(ORG, USER, {})).rejects.toThrow(
        BadRequestException,
      );
    });

    it('upserts only the provided fields and audits', async () => {
      repo['upsertSettings'].mockResolvedValue(makeRow({ is_enabled: true }));
      await service.updateSettings(ORG, USER, { is_enabled: true });
      expect(repo['upsertSettings']).toHaveBeenCalledWith(
        ORG,
        { is_enabled: true },
        USER,
      );
      expect(audit['createLog']).toHaveBeenCalledWith(
        ORG,
        USER,
        expect.objectContaining({ entity_type: 'mcp_settings' }),
      );
    });
  });

  describe('setToolEnabled', () => {
    it('rejects an unknown tool name before writing', async () => {
      await expect(
        service.setToolEnabled(ORG, USER, 'task.destroy', true),
      ).rejects.toThrow(BadRequestException);
      expect(repo['upsertSettings']).not.toHaveBeenCalled();
    });

    it('adds a tool (catalog-ordered) and audits', async () => {
      repo['getSettings'].mockResolvedValue(
        makeRow({ allowed_tools: ['task.get'] }),
      );
      repo['upsertSettings'].mockResolvedValue(
        makeRow({ allowed_tools: ['task.search', 'task.get'] }),
      );
      await service.setToolEnabled(ORG, USER, 'task.search', true);
      // org-ordered: task.search precedes task.get in the catalog.
      expect(repo['upsertSettings']).toHaveBeenCalledWith(
        ORG,
        { allowed_tools: ['task.search', 'task.get'] },
        USER,
      );
      expect(audit['createLog']).toHaveBeenCalledWith(
        ORG,
        USER,
        expect.objectContaining({
          entity_type: 'mcp_tool',
          entity_id: 'task.search',
        }),
      );
    });

    it('removes a tool when disabling', async () => {
      repo['getSettings'].mockResolvedValue(
        makeRow({ allowed_tools: ['task.search', 'task.get'] }),
      );
      repo['upsertSettings'].mockResolvedValue(
        makeRow({ allowed_tools: ['task.get'] }),
      );
      await service.setToolEnabled(ORG, USER, 'task.search', false);
      expect(repo['upsertSettings']).toHaveBeenCalledWith(
        ORG,
        { allowed_tools: ['task.get'] },
        USER,
      );
    });

    it('requires admin/owner', async () => {
      perms['isAdminOrOwner'].mockResolvedValue(false);
      await expect(
        service.setToolEnabled(ORG, USER, 'task.search', true),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('revokeGrant', () => {
    it('returns 404 for a grant not in the org (cross-org / unknown)', async () => {
      repo['findGrantInOrg'].mockResolvedValue(null);
      await expect(
        service.revokeGrant(ORG, USER, 'grant-x', null),
      ).rejects.toThrow(NotFoundException);
      expect(repo['revokeGrant']).not.toHaveBeenCalled();
    });

    it('revokes an in-org grant and audits', async () => {
      repo['findGrantInOrg'].mockResolvedValue({
        id: 'grant-1',
        revoked_at: null,
      });
      repo['revokeGrant'].mockResolvedValue(undefined);
      await service.revokeGrant(ORG, USER, 'grant-1', 'no longer needed');
      expect(repo['revokeGrant']).toHaveBeenCalledWith(
        'grant-1',
        USER,
        'no longer needed',
      );
      expect(audit['createLog']).toHaveBeenCalledWith(
        ORG,
        USER,
        expect.objectContaining({ entity_type: 'mcp_grant' }),
      );
    });

    it('requires admin/owner', async () => {
      perms['isAdminOrOwner'].mockResolvedValue(false);
      await expect(
        service.revokeGrant(ORG, USER, 'grant-1', null),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('listAudit', () => {
    it('caps the limit and requires admin/owner', async () => {
      repo['listRecentAudit'].mockResolvedValue([]);
      await service.listAudit(USER, ORG, 9999);
      expect(repo['listRecentAudit']).toHaveBeenCalledWith(ORG, 200);

      perms['isAdminOrOwner'].mockResolvedValue(false);
      await expect(service.listAudit(USER, ORG)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('listGrants', () => {
    it('requires admin/owner and delegates', async () => {
      repo['listActiveGrants'].mockResolvedValue([]);
      await expect(service.listGrants(USER, ORG)).resolves.toEqual([]);
      expect(repo['listActiveGrants']).toHaveBeenCalledWith(ORG);
    });
  });
});
