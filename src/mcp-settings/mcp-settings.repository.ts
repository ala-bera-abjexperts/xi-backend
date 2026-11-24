/**
 * @fileoverview Service-role data access for MCP org settings, grants, and the
 * tool-invocation audit slice. RLS is bypassed (admin client); the SERVICE layer
 * re-asserts owner/admin before every mutation. Every query is org-scoped.
 * @module src/mcp-settings/mcp-settings.repository
 */

import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

export interface McpOrgSettingsRow {
  organization_id: string;
  is_enabled: boolean;
  allow_write_tools: boolean;
  allowed_tools: string[];
  updated_by: string | null;
  updated_at: string;
}

export interface McpGrantView {
  id: string;
  userName: string;
  userEmail: string;
  clientName: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export interface McpAuditView {
  id: string;
  toolName: string;
  status: string;
  errorCode: string | null;
  createdAt: string;
  userName: string;
}

interface UserRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

function displayName(u: UserRow | undefined): string {
  if (!u) return 'Unknown user';
  const full = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
  return full || u.email || 'Unknown user';
}

@Injectable()
export class McpSettingsRepository {
  private static readonly SETTINGS = 'mcp_organization_settings';
  private static readonly GRANTS = 'mcp_oauth_grants';
  private static readonly CLIENTS = 'mcp_oauth_clients';
  private static readonly INVOCATIONS = 'mcp_tool_invocations';

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** The settings row, or null when the org has never configured MCP. */
  async getSettings(organizationId: string): Promise<McpOrgSettingsRow | null> {
    const { data, error } = await this.client
      .from(McpSettingsRepository.SETTINGS)
      .select(
        'organization_id, is_enabled, allow_write_tools, allowed_tools, updated_by, updated_at',
      )
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    return (data as McpOrgSettingsRow | null) ?? null;
  }

  /**
   * Upsert a partial settings patch. Missing columns keep their existing value
   * on an existing row, or their column DEFAULT on a first insert (is_enabled
   * false, allow_write_tools false, allowed_tools '{}').
   */
  async upsertSettings(
    organizationId: string,
    patch: Partial<
      Pick<
        McpOrgSettingsRow,
        'is_enabled' | 'allow_write_tools' | 'allowed_tools'
      >
    >,
    userId: string,
  ): Promise<McpOrgSettingsRow> {
    const { data, error } = await this.client
      .from(McpSettingsRepository.SETTINGS)
      .upsert(
        {
          organization_id: organizationId,
          ...patch,
          updated_by: userId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'organization_id' },
      )
      .select(
        'organization_id, is_enabled, allow_write_tools, allowed_tools, updated_by, updated_at',
      )
      .single();

    if (error) throw new BadRequestException(error.message);
    return data as McpOrgSettingsRow;
  }

  /** Active (non-revoked) grants for the org, joined to user + client in JS. */
  async listActiveGrants(organizationId: string): Promise<McpGrantView[]> {
    const { data: grants, error } = await this.client
      .from(McpSettingsRepository.GRANTS)
      .select('id, user_id, client_id, scopes, created_at, last_used_at')
      .eq('organization_id', organizationId)
      .is('revoked_at', null)
      .order('created_at', { ascending: false });

    if (error) throw new BadRequestException(error.message);
    const rows = (grants ?? []) as {
      id: string;
      user_id: string;
      client_id: string;
      scopes: string[] | null;
      created_at: string;
      last_used_at: string | null;
    }[];
    if (rows.length === 0) return [];

    const userIds = [...new Set(rows.map((r) => r.user_id))];
    const clientIds = [...new Set(rows.map((r) => r.client_id))];

    const [{ data: users }, { data: clients }] = await Promise.all([
      this.client
        .from('users')
        .select('id, first_name, last_name, email')
        .in('id', userIds),
      this.client
        .from(McpSettingsRepository.CLIENTS)
        .select('id, client_name')
        .in('id', clientIds),
    ]);

    const userById = new Map(
      ((users ?? []) as UserRow[]).map((u) => [u.id, u]),
    );
    const clientById = new Map(
      ((clients ?? []) as { id: string; client_name: string | null }[]).map(
        (c) => [c.id, c.client_name],
      ),
    );

    return rows.map((r) => ({
      id: r.id,
      userName: displayName(userById.get(r.user_id)),
      userEmail: userById.get(r.user_id)?.email ?? '',
      clientName: clientById.get(r.client_id) ?? 'Unknown client',
      scopes: r.scopes ?? [],
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }));
  }

  /** A single grant limited to the org (for revoke ownership checks). */
  async findGrantInOrg(
    organizationId: string,
    grantId: string,
  ): Promise<{ id: string; revoked_at: string | null } | null> {
    const { data, error } = await this.client
      .from(McpSettingsRepository.GRANTS)
      .select('id, revoked_at')
      .eq('organization_id', organizationId)
      .eq('id', grantId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    return (data as { id: string; revoked_at: string | null } | null) ?? null;
  }

  /** Revoke a grant (idempotent-ish; scoped to org via the id already checked). */
  async revokeGrant(
    grantId: string,
    revokedBy: string,
    reason: string | null,
  ): Promise<void> {
    const { error } = await this.client
      .from(McpSettingsRepository.GRANTS)
      .update({
        revoked_at: new Date().toISOString(),
        revoked_by: revokedBy,
        revoke_reason: reason,
      })
      .eq('id', grantId)
      .is('revoked_at', null);

    if (error) throw new BadRequestException(error.message);
  }

  /** Recent tool invocations for the org (audit slice), joined to user in JS. */
  async listRecentAudit(
    organizationId: string,
    limit: number,
  ): Promise<McpAuditView[]> {
    const { data, error } = await this.client
      .from(McpSettingsRepository.INVOCATIONS)
      .select('id, user_id, tool_name, status, error_code, created_at')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw new BadRequestException(error.message);
    const rows = (data ?? []) as {
      id: string;
      user_id: string | null;
      tool_name: string;
      status: string;
      error_code: string | null;
      created_at: string;
    }[];
    if (rows.length === 0) return [];

    const userIds = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
    const userById = new Map<string, UserRow>();
    if (userIds.length > 0) {
      const { data: users } = await this.client
        .from('users')
        .select('id, first_name, last_name, email')
        .in('id', userIds as string[]);
      for (const u of (users ?? []) as UserRow[]) userById.set(u.id, u);
    }

    return rows.map((r) => ({
      id: r.id,
      toolName: r.tool_name,
      status: r.status,
      errorCode: r.error_code,
      createdAt: r.created_at,
      userName: displayName(r.user_id ? userById.get(r.user_id) : undefined),
    }));
  }
}
