/**
 * @fileoverview Business logic for tenant MCP governance: the org enable/write
 * master toggles, the per-tool allow-list, connected-grant listing + revocation,
 * and the tool-usage audit slice. Every mutation re-asserts owner/admin (RLS is
 * bypassed by the service-role client) and writes an audit-log entry. The org is
 * always the caller's active org — never a request parameter.
 * @module src/mcp-settings/mcp-settings.service
 */

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { PermissionsService } from '../permissions/permissions.service';
import {
  MCP_TOOL_CATALOG,
  McpToolCatalogEntry,
  isKnownMcpTool,
} from './mcp-tool-catalog';
import {
  McpAuditView,
  McpGrantView,
  McpSettingsRepository,
} from './mcp-settings.repository';

const AUDIT_LIMIT_DEFAULT = 50;
const AUDIT_LIMIT_MAX = 200;

export interface McpSettingsView {
  is_enabled: boolean;
  allow_write_tools: boolean;
  allowed_tools: string[];
  catalog: readonly McpToolCatalogEntry[];
}

@Injectable()
export class McpSettingsService {
  constructor(
    private readonly repository: McpSettingsRepository,
    private readonly permissionsService: PermissionsService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  private async assertAdminOrOwner(
    userId: string,
    organizationId: string,
  ): Promise<void> {
    if (
      !(await this.permissionsService.isAdminOrOwner(userId, organizationId))
    ) {
      throw new ForbiddenException(
        'Only organization admins or owners can manage MCP settings',
      );
    }
  }

  /** Current settings for the org (defaults when never configured) + the catalog. */
  async getSettings(organizationId: string): Promise<McpSettingsView> {
    const row = await this.repository.getSettings(organizationId);
    return {
      is_enabled: row?.is_enabled ?? false,
      allow_write_tools: row?.allow_write_tools ?? false,
      allowed_tools: row?.allowed_tools ?? [],
      catalog: MCP_TOOL_CATALOG,
    };
  }

  /** Update the master toggles (is_enabled and/or allow_write_tools). */
  async updateSettings(
    organizationId: string,
    userId: string,
    patch: { is_enabled?: boolean; allow_write_tools?: boolean },
  ): Promise<McpSettingsView> {
    await this.assertAdminOrOwner(userId, organizationId);

    const fields: { is_enabled?: boolean; allow_write_tools?: boolean } = {};
    if (patch.is_enabled !== undefined) fields.is_enabled = patch.is_enabled;
    if (patch.allow_write_tools !== undefined) {
      fields.allow_write_tools = patch.allow_write_tools;
    }
    if (Object.keys(fields).length === 0) {
      throw new BadRequestException(
        'Provide is_enabled and/or allow_write_tools',
      );
    }

    const row = await this.repository.upsertSettings(
      organizationId,
      fields,
      userId,
    );

    await this.auditLogs.createLog(organizationId, userId, {
      entity_type: 'mcp_settings',
      entity_id: organizationId,
      action: 'update',
      changes: fields,
    });

    return {
      is_enabled: row.is_enabled,
      allow_write_tools: row.allow_write_tools,
      allowed_tools: row.allowed_tools,
      catalog: MCP_TOOL_CATALOG,
    };
  }

  /** Enable/disable a single tool in the org's per-tool allow-list. */
  async setToolEnabled(
    organizationId: string,
    userId: string,
    toolName: string,
    enabled: boolean,
  ): Promise<McpSettingsView> {
    await this.assertAdminOrOwner(userId, organizationId);

    if (!isKnownMcpTool(toolName)) {
      throw new BadRequestException(`Unknown MCP tool: ${toolName}`);
    }

    const current = await this.repository.getSettings(organizationId);
    const existing = new Set(current?.allowed_tools ?? []);
    if (enabled) existing.add(toolName);
    else existing.delete(toolName);

    // Keep the stored order stable + catalog-ordered so the row is deterministic.
    const nextAllowed = MCP_TOOL_CATALOG.filter((t) =>
      existing.has(t.name),
    ).map((t) => t.name);

    const row = await this.repository.upsertSettings(
      organizationId,
      { allowed_tools: nextAllowed },
      userId,
    );

    await this.auditLogs.createLog(organizationId, userId, {
      entity_type: 'mcp_tool',
      entity_id: toolName,
      action: 'update',
      changes: { tool: toolName, enabled },
    });

    return {
      is_enabled: row.is_enabled,
      allow_write_tools: row.allow_write_tools,
      allowed_tools: row.allowed_tools,
      catalog: MCP_TOOL_CATALOG,
    };
  }

  /** Active connected clients (grants) for the org. Owner/admin only. */
  async listGrants(
    userId: string,
    organizationId: string,
  ): Promise<McpGrantView[]> {
    await this.assertAdminOrOwner(userId, organizationId);
    return this.repository.listActiveGrants(organizationId);
  }

  /** Revoke a connected client's grant. Cross-org / unknown id => 404 (uniform). */
  async revokeGrant(
    organizationId: string,
    userId: string,
    grantId: string,
    reason: string | null,
  ): Promise<{ revoked: true }> {
    await this.assertAdminOrOwner(userId, organizationId);

    const grant = await this.repository.findGrantInOrg(organizationId, grantId);
    if (!grant) {
      throw new NotFoundException('Grant not found');
    }

    await this.repository.revokeGrant(grantId, userId, reason);

    await this.auditLogs.createLog(organizationId, userId, {
      entity_type: 'mcp_grant',
      entity_id: grantId,
      action: 'update',
      changes: { revoked: true, reason: reason ?? null },
    });

    return { revoked: true };
  }

  /** Recent tool-usage audit slice for the org. Owner/admin only. */
  async listAudit(
    userId: string,
    organizationId: string,
    limit?: number,
  ): Promise<McpAuditView[]> {
    await this.assertAdminOrOwner(userId, organizationId);
    const capped = Math.min(
      Math.max(1, limit ?? AUDIT_LIMIT_DEFAULT),
      AUDIT_LIMIT_MAX,
    );
    return this.repository.listRecentAudit(organizationId, capped);
  }
}
