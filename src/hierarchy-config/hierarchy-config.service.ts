/**
 * @fileoverview Service for the process/risk hierarchy configuration
 * (`hierarchy_configurations` table). Org-scoped, per-space, with
 * upsert semantics matching the old Next.js service.
 *
 * Matches the old `HierarchyConfigService` 1:1 so frontend behavior
 * is unchanged. All reads/writes go through `SupabaseAdminService`
 * (service-role key); org scoping is enforced in code since RLS is
 * org-level only.
 * @module src/hierarchy-config/hierarchy-config.service
 * @author Prince Jadiya
 */

import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  hierarchyConfigSchema,
  validateHierarchyConfig,
  sanitizeHierarchyConfig,
  getValidChildTypesFromConfig,
  FALLBACK_DEFAULT_HIERARCHY_CONFIG,
  type IHierarchyConfig,
  type IHierarchyConfigRecord,
  type HierarchyValidationResult,
} from './models/hierarchy-config.model';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, field: string): void {
  if (!UUID_RE.test(value)) {
    throw new BadRequestException(`${field} must be a valid UUID`);
  }
}

/**
 * Shape returned by `getConfig` — matches the old
 * `GET /api/hierarchy-config` response envelope.
 */
export interface GetConfigResult {
  config: IHierarchyConfig;
  record: IHierarchyConfigRecord | null;
  isDefault: boolean;
}

/**
 * Shape returned by `exportConfig` — matches the old
 * `GET /api/hierarchy-config/export` response.
 */
export interface ExportHierarchyConfigData {
  organizationId: string;
  exportedAt: string;
  config: IHierarchyConfig;
}

@Injectable()
export class HierarchyConfigService {
  private static readonly TABLE = 'hierarchy_configurations';

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Fetch the default config from the Supabase RPC, falling back to
   * a hard-coded minimal default if the RPC is unavailable.
   */
  async getDefaultConfig(): Promise<IHierarchyConfig> {
    const r = await this.client.rpc('get_default_hierarchy_config_json');
    if (r.error || !r.data) {
      return FALLBACK_DEFAULT_HIERARCHY_CONFIG;
    }
    return r.data as IHierarchyConfig;
  }

  /**
   * Look up the config row for a given (org, space). Returns `null`
   * when no record exists. Scoped to `organization_id` as defense
   * in depth beyond RLS.
   */
  private async findBySpace(
    organizationId: string,
    spaceId: string,
  ): Promise<IHierarchyConfigRecord | null> {
    const r = await this.client
      .from(HierarchyConfigService.TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .maybeSingle();
    if (r.error) throw new BadRequestException(r.error.message);
    return (r.data as IHierarchyConfigRecord | null) ?? null;
  }

  /**
   * Get the active config for a (org, space). If no row exists in
   * the DB we return the system default with `isDefault: true` —
   * we do **not** persist it (the old service did; we deliberately
   * avoid the side effect to keep reads idempotent).
   */
  async getConfig(
    organizationId: string,
    spaceId: string,
  ): Promise<GetConfigResult> {
    assertUuid(organizationId, 'organizationId');
    assertUuid(spaceId, 'spaceId');
    const record = await this.findBySpace(organizationId, spaceId);
    if (record) {
      return { config: record.config, record, isDefault: false };
    }
    const def = await this.getDefaultConfig();
    return { config: def, record: null, isDefault: true };
  }

  /**
   * Validate a config without persisting. Useful for the front-end
   * "validate before save" preview.
   */
  validateConfig(config: IHierarchyConfig): HierarchyValidationResult {
    const parsed = hierarchyConfigSchema.safeParse(config);
    if (!parsed.success) {
      return {
        isValid: false,
        errors: parsed.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      };
    }
    return validateHierarchyConfig(parsed.data);
  }

  /**
   * Upsert a config for a (org, space). Runs the zod schema check
   * and the comprehensive business-rule validator before writing.
   */
  async saveConfig(
    organizationId: string,
    spaceId: string,
    config: IHierarchyConfig,
    userId: string | null,
    auditOperation: string = 'save',
  ): Promise<IHierarchyConfigRecord> {
    assertUuid(organizationId, 'organizationId');
    assertUuid(spaceId, 'spaceId');

    const parsed = hierarchyConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Invalid hierarchy configuration',
        errors: parsed.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    const business = validateHierarchyConfig(parsed.data);
    if (!business.isValid) {
      throw new BadRequestException({
        message: 'Invalid hierarchy configuration',
        errors: business.errors,
      });
    }

    const existing = await this.findBySpace(organizationId, spaceId);
    if (existing) {
      const r = await this.client
        .from(HierarchyConfigService.TABLE)
        .update({
          config: parsed.data,
          version: parsed.data.version || '1.0',
          updated_by: userId,
          updated_at: new Date().toISOString(),
        })
        .eq('organization_id', organizationId)
        .eq('space_id', spaceId)
        .select()
        .single();
      if (r.error) throw new BadRequestException(r.error.message);
      const record = r.data as IHierarchyConfigRecord;
      void this.logAudit(organizationId, userId, record.id, 'update', {
        operation: auditOperation,
        space_id: spaceId,
        version: parsed.data.version || '1.0',
        level_count: parsed.data.levels.length,
      });
      return record;
    }

    const r = await this.client
      .from(HierarchyConfigService.TABLE)
      .insert({
        organization_id: organizationId,
        space_id: spaceId,
        config: parsed.data,
        version: parsed.data.version || '1.0',
        created_by: userId,
        updated_by: userId,
      })
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    const record = r.data as IHierarchyConfigRecord;
    void this.logAudit(organizationId, userId, record.id, 'create', {
      operation: auditOperation,
      space_id: spaceId,
      version: parsed.data.version || '1.0',
      level_count: parsed.data.levels.length,
    });
    return record;
  }

  /**
   * Replace the space config with the system default. Unlike
   * `deleteConfig`, this leaves a row behind so level_field_*
   * assignments pinned to "level_geschaeftsprozess" etc. keep
   * resolving without a gap.
   */
  async resetToDefault(
    organizationId: string,
    spaceId: string,
    userId: string | null,
  ): Promise<IHierarchyConfigRecord> {
    const def = await this.getDefaultConfig();
    return this.saveConfig(organizationId, spaceId, def, userId, 'reset');
  }

  /**
   * Import a config from an external JSON file. XSS-sanitized
   * before it reaches `saveConfig`.
   */
  async importConfig(
    organizationId: string,
    spaceId: string,
    config: IHierarchyConfig,
    userId: string | null,
  ): Promise<IHierarchyConfigRecord> {
    const parsed = hierarchyConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Invalid import payload',
        errors: parsed.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    const clean = sanitizeHierarchyConfig(parsed.data);
    return this.saveConfig(organizationId, spaceId, clean, userId, 'import');
  }

  /**
   * Produce the export envelope for frontend download. Always
   * returns *some* config — either the persisted record or the
   * default — so the download UX never dead-ends.
   */
  async exportConfig(
    organizationId: string,
    spaceId: string,
  ): Promise<ExportHierarchyConfigData> {
    const { config } = await this.getConfig(organizationId, spaceId);
    return {
      organizationId,
      exportedAt: new Date().toISOString(),
      config,
    };
  }

  /**
   * Hard delete the per-space row. Throws 404 when there's nothing
   * to delete (so the UI can distinguish "already-default" from
   * "was reset successfully").
   */
  async deleteConfig(organizationId: string, spaceId: string): Promise<void> {
    assertUuid(organizationId, 'organizationId');
    assertUuid(spaceId, 'spaceId');
    const existing = await this.findBySpace(organizationId, spaceId);
    if (!existing) {
      throw new NotFoundException('Hierarchy config not found for this space');
    }
    const r = await this.client
      .from(HierarchyConfigService.TABLE)
      .delete()
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId);
    if (r.error) throw new BadRequestException(r.error.message);
    void this.logAudit(organizationId, null, existing.id, 'delete', {
      operation: 'delete',
      space_id: spaceId,
    });
  }

  /**
   * Resolve the valid child `requestType`s for a parent type.
   * Prefers the Supabase RPC (which consults assignment tables),
   * falls back to a pure-config lookup when the RPC fails.
   */
  async getValidChildTypes(
    organizationId: string,
    spaceId: string,
    requestType: string,
  ): Promise<string[]> {
    assertUuid(organizationId, 'organizationId');
    assertUuid(spaceId, 'spaceId');
    const rpc = await this.client.rpc('get_child_link_types_dynamic', {
      p_request_type: requestType,
      p_organization_id: organizationId,
    });
    if (!rpc.error && Array.isArray(rpc.data)) {
      return rpc.data as string[];
    }
    const { config } = await this.getConfig(organizationId, spaceId);
    return getValidChildTypesFromConfig(config, requestType);
  }

  private async logAudit(
    organizationId: string,
    userId: string | null,
    entityId: string,
    action: 'create' | 'update' | 'delete',
    changes: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.client.from('audit_logs').insert({
        organization_id: organizationId,
        user_id: userId,
        entity_type: 'hierarchy_config',
        entity_id: entityId,
        action,
        changes,
      });
    } catch {
      // Audit is best-effort and must not break the primary mutation.
    }
  }
}
