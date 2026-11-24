/**
 * @fileoverview Service for managing custom fields — handles CRUD, soft
 * delete/restore, permanent delete (guarded by usage), active toggling,
 * and unique field-key generation.
 * @module src/custom-fields/custom-fields.service
 * @author Prince Jadiya
 */

import { randomBytes } from 'node:crypto';

import {
  Injectable,
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
  Optional,
  ForbiddenException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { PermissionsService } from '../permissions/permissions.service';
import { spaceGrantAllows } from '../permissions/models/space-permissions.model';
import { EntitlementsService } from '../licensing/entitlements.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { CustomField, FieldType } from './models/custom-field.model';
import { FIELD_TYPES_WITH_OPTIONS } from './models/custom-field.model';
import type { FieldOption } from './models/custom-field.model';
import {
  ISSUE_GROUP_MAX_FIELDS_PER_SPACE,
  isSingleIssueGroup,
  issueGroupOptionsError,
} from './utils/issue-group.util';

/**
 * Filters accepted by list endpoints.
 */
export interface CustomFieldFilters {
  field_type?: FieldType;
  is_active?: boolean;
  search?: string;
  is_deleted?: boolean;
  context?: string;
  scope?: 'organization' | 'space';
}

/** Payload accepted by `create`. */
export interface CreateCustomFieldInput {
  name: string;
  field_key?: string;
  field_type: FieldType;
  scope?: 'organization' | 'space';
  space_id?: string | null;
  description?: string | null;
  name_i18n?: Record<string, string>;
  description_i18n?: Record<string, string>;
  default_value?: unknown;
  options?: unknown[];
  validation_rules?: Record<string, unknown>;
  contexts?: string[];
  is_active?: boolean;
  sort_order?: number;
}

/** Payload accepted by `update`. */
export interface UpdateCustomFieldInput {
  name?: string;
  description?: string | null;
  name_i18n?: Record<string, string>;
  description_i18n?: Record<string, string>;
  default_value?: unknown;
  options?: unknown[];
  validation_rules?: Record<string, unknown>;
  contexts?: string[];
  is_active?: boolean;
  sort_order?: number;
  field_type?: FieldType;
  field_key?: string;
}

/**
 * Generates a slug-style field key from a human name.
 *
 * @param name Raw field name.
 * @returns A lowercase alphanumeric-underscore key, prefixed with `f_` if the
 *   first character would not be a letter.
 */
export function generateFieldKey(name: string): string {
  const slug = (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug) return 'field';
  return /^[a-z]/.test(slug) ? slug : `f_${slug}`;
}

/**
 * In-memory context filter that works regardless of whether `contexts` is
 * stored as a jsonb array or a JSON-encoded text string in the DB.
 * PostgREST's `cs` (contains) operator fails on older Supabase production
 * instances where the column type is `text` instead of `jsonb`.
 */
function filterByContext(rows: CustomField[], context: string): CustomField[] {
  return rows.filter((f) => {
    const ctx = f.contexts as unknown;
    if (Array.isArray(ctx)) return (ctx as string[]).includes(context);
    if (typeof ctx === 'string') {
      try {
        const parsed = JSON.parse(ctx) as unknown;
        return Array.isArray(parsed) && (parsed as string[]).includes(context);
      } catch {
        return false;
      }
    }
    return false;
  });
}

/**
 * Service that owns CRUD for `custom_fields`.
 */
@Injectable()
export class CustomFieldsService {
  private readonly logger = new Logger(CustomFieldsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    @Optional() private readonly auditLogsService?: AuditLogsService,
    // Optional so existing unit-test constructions keep compiling; DI always
    // supplies it (CustomFieldsModule imports LicensingModule).
    @Optional() private readonly entitlementsService?: EntitlementsService,
    @Optional() private readonly permissionsService?: PermissionsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * List custom fields for an organization (org-level scope only).
   *
   * @param organizationId Organization id.
   * @param filters Optional filters.
   */
  async getAll(
    organizationId: string,
    filters: CustomFieldFilters = {},
  ): Promise<{ data: CustomField[]; count: number }> {
    let q = this.client
      .from('custom_fields')
      .select('*')
      .eq('organization_id', organizationId)
      .is('space_id', null);
    if (filters.is_deleted === true) {
      q = q.eq('is_deleted', true);
    } else {
      q = q.or('is_deleted.is.null,is_deleted.eq.false');
    }
    if (filters.field_type) q = q.eq('field_type', filters.field_type);
    if (filters.is_active !== undefined)
      q = q.eq('is_active', filters.is_active);
    if (filters.scope) q = q.eq('scope', filters.scope);
    if (filters.search)
      q = q.or(
        `name.ilike.%${filters.search}%,description.ilike.%${filters.search}%`,
      );
    const result = await q
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });
    if (result.error) {
      this.logger.error(
        `[getAll] Supabase error — message="${result.error.message}" code="${(result.error as unknown as { code?: string }).code ?? ''}" details="${(result.error as unknown as { details?: string }).details ?? ''}" hint="${(result.error as unknown as { hint?: string }).hint ?? ''}"`,
      );
      throw new BadRequestException(result.error.message);
    }
    let rows = (result.data ?? []) as CustomField[];
    if (filters.context) rows = filterByContext(rows, filters.context);
    return { data: rows, count: rows.length };
  }

  /**
   * Get all fields available in a space (org-level + space-level).
   */
  async getBySpace(
    organizationId: string,
    spaceId: string,
    filters: CustomFieldFilters = {},
  ): Promise<{ data: CustomField[]; count: number }> {
    let q = this.client
      .from('custom_fields')
      .select('*')
      .eq('organization_id', organizationId)
      .or(`space_id.is.null,space_id.eq.${spaceId}`);
    if (filters.is_deleted === true) {
      q = q.eq('is_deleted', true);
    } else {
      q = q.or('is_deleted.is.null,is_deleted.eq.false');
    }
    if (filters.field_type) q = q.eq('field_type', filters.field_type);
    if (filters.is_active !== undefined)
      q = q.eq('is_active', filters.is_active);
    if (filters.scope) q = q.eq('scope', filters.scope);
    if (filters.search)
      q = q.or(
        `name.ilike.%${filters.search}%,description.ilike.%${filters.search}%`,
      );
    const result = await q
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });
    if (result.error) throw new BadRequestException(result.error.message);
    let rows = (result.data ?? []) as CustomField[];
    if (filters.context) rows = filterByContext(rows, filters.context);
    return { data: rows, count: rows.length };
  }

  /**
   * List all deleted custom fields for the organization (any scope/space).
   * Matches risk-management-app: no space_id filter, sorted by deleted_at DESC.
   */
  async getDeleted(
    organizationId: string,
  ): Promise<{ data: CustomField[]; count: number }> {
    const result = await this.client
      .from('custom_fields')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('is_deleted', true)
      .order('deleted_at', { ascending: false });
    if (result.error) throw new BadRequestException(result.error.message);
    const rows = (result.data ?? []) as CustomField[];
    return { data: rows, count: rows.length };
  }

  /** Fetch a single custom field by id, scoped to the caller's organization. */
  async getById(id: string, organizationId: string): Promise<CustomField> {
    const result = await this.client
      .from('custom_fields')
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (result.error) throw new BadRequestException(result.error.message);
    if (!result.data) throw new NotFoundException('Custom field not found');
    return result.data as CustomField;
  }

  /** Create a custom field. */
  async create(
    organizationId: string,
    userId: string | null,
    input: CreateCustomFieldInput,
  ): Promise<CustomField> {
    const scope = input.scope ?? 'organization';
    if (input.field_type === 'sla_time') {
      this.assertSlaField(scope, input);
      await this.authorizeSlaManagement(userId, organizationId, input.space_id);
    }
    if (scope === 'space' && !input.space_id) {
      throw new BadRequestException(
        'space_id is required when scope is "space"',
      );
    }
    if (scope === 'organization' && input.space_id) {
      throw new BadRequestException(
        'space_id must be null when scope is "organization"',
      );
    }
    if (FIELD_TYPES_WITH_OPTIONS.includes(input.field_type)) {
      if (!Array.isArray(input.options) || input.options.length === 0) {
        throw new BadRequestException(
          `Field type "${input.field_type}" requires non-empty options`,
        );
      }
    }
    await this.assertAssetConfigSourceSpace(
      scope,
      input.field_type,
      input.validation_rules,
      organizationId,
    );
    if (input.field_type === 'issue_group') {
      input = await this.prepareIssueGroupCreate(
        organizationId,
        userId,
        scope,
        input,
      );
    }

    // Warn-only plan-limit check: logs a breach, never refuses. The catalog key
    // is PER SPACE, so an organization-scoped field is not counted against it.
    // See EntitlementsService.checkLimit for why this is not a block yet.
    if (input.space_id) {
      const spaceId = input.space_id;

      await this.entitlementsService?.checkLimit(
        organizationId,
        'limit_custom_fields_per_space',
        async () => {
          const { count } = await this.client
            .from('custom_fields')
            .select('id', { count: 'exact', head: true })
            .eq('organization_id', organizationId)
            .eq('space_id', spaceId)
            .or('is_deleted.is.null,is_deleted.eq.false');

          return count ?? 0;
        },
      );
    }

    const fieldKey =
      input.field_key ??
      (await this.generateUniqueFieldKey(
        organizationId,
        input.name,
        input.space_id ?? null,
      ));

    // Conflict check
    let conflictQuery = this.client
      .from('custom_fields')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('field_key', fieldKey)
      .or('is_deleted.is.null,is_deleted.eq.false');

    if (input.space_id) {
      conflictQuery = conflictQuery.or(
        `space_id.is.null,space_id.eq.${input.space_id}`,
      );
    }

    // limit(1), not maybeSingle(): for an ORG-level field no space filter is
    // applied, so this legitimately matches every space-level row sharing the
    // key (the unique index is per (org, space_id, field_key)). maybeSingle()
    // turned that into a PGRST116 "multiple rows returned" 400 instead of the
    // intended 409.
    const conflictResult = await conflictQuery.limit(1);
    if (conflictResult.error) {
      throw new BadRequestException(conflictResult.error.message);
    }
    if ((conflictResult.data ?? []).length > 0) {
      throw new ConflictException(
        `A field with key "${fieldKey}" already exists`,
      );
    }

    const row = {
      organization_id: organizationId,
      space_id: input.space_id ?? null,
      scope,
      name: input.name,
      field_key: fieldKey,
      field_type: input.field_type,
      description: input.description ?? null,
      name_i18n: input.name_i18n ?? {},
      description_i18n: input.description_i18n ?? {},
      default_value: input.default_value ?? null,
      options: input.options ?? [],
      validation_rules: input.validation_rules ?? {},
      contexts:
        input.contexts ?? (input.field_type === 'sla_time' ? ['task'] : []),
      is_system: false,
      is_active: input.is_active ?? true,
      sort_order: input.sort_order ?? 0,
      created_by: userId,
      updated_by: userId,
    };
    const result = await this.client
      .from('custom_fields')
      .insert(row)
      .select()
      .single();

    if (result.error) {
      // Surface DB-level rejections as something a user can act on rather than
      // a raw Postgres string. 23505 = unique violation (incl. the scope-
      // uniqueness trigger); 23514 = check violation, e.g. a field_type the UI
      // offers but this database's CHECK constraint does not list yet.
      if (result.error.code === '23505') {
        throw new ConflictException(
          `A field with key "${fieldKey}" already exists`,
        );
      }
      if (result.error.code === '23514') {
        throw new BadRequestException(
          `Field type "${input.field_type}" is not supported by this database yet`,
        );
      }

      throw new BadRequestException(result.error.message);
    }
    const field = result.data as CustomField;

    this.logAudit(organizationId, userId, field.id, 'create', {
      name: field.name,
      field_key: field.field_key,
      field_type: field.field_type,
      scope: field.scope,
      space_id: field.space_id,
    });

    return field;
  }

  /** Update an existing custom field. */
  async update(
    id: string,
    userId: string | null,
    input: UpdateCustomFieldInput,
    organizationId: string,
  ): Promise<CustomField> {
    const existing = await this.getById(id, organizationId);
    if (existing.field_type === 'sla_time')
      await this.authorizeSlaManagement(
        userId,
        organizationId,
        existing.space_id,
      );
    if (existing.is_system) {
      throw new BadRequestException('Cannot modify system fields');
    }
    if (input.field_type && input.field_type !== existing.field_type) {
      throw new BadRequestException(
        'field_type cannot be changed after creation',
      );
    }
    if (input.field_key && input.field_key !== existing.field_key) {
      throw new BadRequestException(
        'field_key cannot be changed after creation',
      );
    }
    // Skipped when the patch omits validation_rules — a rename must not have to
    // resend the asset config (the patch below only writes defined keys).
    if (input.validation_rules !== undefined) {
      await this.assertAssetConfigSourceSpace(
        existing.scope ?? (existing.space_id ? 'space' : 'organization'),
        existing.field_type,
        input.validation_rules,
        organizationId,
      );
    }
    if (existing.field_type === 'sla_time')
      this.assertSlaField(existing.scope, input);
    if (existing.field_type === 'issue_group') {
      input = await this.prepareIssueGroupUpdate(
        organizationId,
        userId,
        existing,
        input,
      );
    }
    const patch: Record<string, unknown> = {
      updated_by: userId,
      updated_at: new Date().toISOString(),
    };
    for (const k of [
      'name',
      'description',
      'name_i18n',
      'description_i18n',
      'default_value',
      'options',
      'validation_rules',
      'contexts',
      'is_active',
      'sort_order',
    ] as const) {
      if (input[k] !== undefined) patch[k] = input[k];
      if (
        k === 'validation_rules' &&
        input[k] !== undefined &&
        existing.field_type === 'sla_time'
      ) {
        patch[k] = { ...existing.validation_rules, ...input.validation_rules };
      }
    }
    const result = await this.client
      .from('custom_fields')
      .update(patch)
      .eq('id', id)
      .select()
      .single();
    if (result.error) throw new BadRequestException(result.error.message);
    const field = result.data as CustomField;
    this.logAudit(organizationId, userId, id, 'update', patch);
    return field;
  }

  /** Soft delete a custom field. */
  async softDelete(
    id: string,
    userId: string | null,
    organizationId: string,
  ): Promise<void> {
    const existing = await this.getById(id, organizationId);
    if (existing.field_type === 'sla_time')
      await this.authorizeSlaManagement(
        userId,
        organizationId,
        existing.space_id,
      );
    if (existing.is_system) {
      throw new BadRequestException('Cannot delete system fields');
    }
    const result = await this.client
      .from('custom_fields')
      .update({
        is_deleted: true,
        deleted_at: new Date().toISOString(),
        deleted_by: userId,
        is_active: false,
      })
      .eq('id', id);
    if (result.error) throw new BadRequestException(result.error.message);

    this.logAudit(organizationId, userId, id, 'delete', {
      name: existing.name,
      field_key: existing.field_key,
    });
  }

  /** Restore a soft-deleted custom field. */
  async restore(
    id: string,
    organizationId: string,
    userId?: string | null,
  ): Promise<CustomField> {
    const existing = await this.getById(id, organizationId);
    if (existing.field_type === 'sla_time')
      await this.authorizeSlaManagement(
        userId,
        organizationId,
        existing.space_id,
      );
    if (!existing.is_deleted) {
      throw new BadRequestException('Custom field is not deleted');
    }
    if (existing.field_type === 'issue_group') {
      await this.assertIssueGroupNameFree(
        organizationId,
        existing.space_id,
        existing.name,
        existing.id,
      );
    }
    const result = await this.client
      .from('custom_fields')
      .update({ is_deleted: false, deleted_at: null, deleted_by: null })
      .eq('id', id)
      .select()
      .single();
    if (result.error) throw new BadRequestException(result.error.message);
    const field = result.data as CustomField;
    this.logAudit(organizationId, userId ?? null, id, 'restore', {
      name: field.name,
      field_key: field.field_key,
    });
    return field;
  }

  /** Permanently delete a field — blocked if any field group uses it. */
  async permanentDelete(
    id: string,
    organizationId: string,
    userId?: string | null,
  ): Promise<void> {
    const existing = await this.getById(id, organizationId);
    if (existing.field_type === 'sla_time')
      await this.authorizeSlaManagement(
        userId,
        organizationId,
        existing.space_id,
      );
    if (existing.is_system) {
      throw new BadRequestException('Cannot delete system fields');
    }
    const usage = await this.isFieldInUse(id);
    if (usage.inUse) {
      throw new ConflictException(
        `Cannot permanently delete: field is used in ${usage.count} field group(s)`,
      );
    }
    const result = await this.client
      .from('custom_fields')
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);
    if (result.error) throw new BadRequestException(result.error.message);

    this.logAudit(organizationId, userId ?? null, id, 'delete', {
      permanent: true,
      name: existing.name,
      field_key: existing.field_key,
    });
  }

  /** Toggle the `is_active` flag. */
  async toggleActive(
    id: string,
    isActive: boolean,
    organizationId: string,
    userId?: string | null,
  ): Promise<CustomField> {
    const existing = await this.getById(id, organizationId);
    if (existing.field_type === 'sla_time')
      await this.authorizeSlaManagement(
        userId,
        organizationId,
        existing.space_id,
      );
    if (existing.is_system && !isActive) {
      throw new BadRequestException('Cannot deactivate system fields');
    }
    const result = await this.client
      .from('custom_fields')
      .update({
        is_active: isActive,
        updated_by: userId ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();
    if (result.error) throw new BadRequestException(result.error.message);
    const field = result.data as CustomField;
    this.logAudit(organizationId, userId ?? null, id, 'update', {
      is_active: isActive,
    });
    return field;
  }

  async reorder(
    items: { id: string; sort_order: number }[],
    organizationId: string,
    userId?: string | null,
  ): Promise<void> {
    await Promise.all(
      items.map((item) =>
        this.client
          .from('custom_fields')
          .update({ sort_order: item.sort_order })
          .eq('id', item.id)
          .eq('organization_id', organizationId)
          .then((r) => {
            if (r.error) throw new BadRequestException(r.error.message);
          }),
      ),
    );
    this.logAudit(organizationId, userId, items[0]?.id ?? '', 'update', {
      reorder: items,
    });
  }

  /**
   * An org-scoped field is served to every space (`getBySpace` ORs
   * `space_id.is.null`) and has no ambient space to fall back on, so its asset
   * config must name the source space explicitly.
   *
   * Keyed off `field_type`, not off the presence of `validation_rules.asset`:
   * otherwise an asset field saved with empty rules slips through and lands
   * permanently unconfigured.
   */
  private async assertAssetConfigSourceSpace(
    scope: string,
    fieldType: string,
    validationRules: Record<string, unknown> | undefined,
    organizationId: string,
  ): Promise<void> {
    if (scope !== 'organization') return;
    if (fieldType !== 'asset' && fieldType !== 'asset_multi') return;

    const assetConfig = validationRules?.asset as
      | { space_id?: unknown }
      | undefined;

    const sourceSpaceId =
      typeof assetConfig?.space_id === 'string' ? assetConfig.space_id : '';

    if (!sourceSpaceId) {
      throw new BadRequestException(
        'An organization-level asset field must name the space its assets come from',
      );
    }

    // Reads are org-filtered anyway; this fails loudly at write time instead of
    // storing a pointer that yields an empty picker forever.
    const { data, error } = await this.client
      .from('spaces')
      .select('id')
      .eq('id', sourceSpaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) {
      throw new BadRequestException(
        'The asset source space does not belong to this organization',
      );
    }
  }

  private async authorizeSlaManagement(
    userId: string | null | undefined,
    organizationId: string,
    spaceId: string | null | undefined,
  ): Promise<void> {
    if (!userId || !spaceId || !this.permissionsService)
      throw new ForbiddenException('Space manage_sla permission is required');
    const { data, error } = await this.client
      .from('spaces')
      .select('id,organization_id')
      .eq('id', spaceId)
      .returns<{ id: string; organization_id: string }[]>()
      .maybeSingle();
    if (error)
      throw new ForbiddenException('Unable to verify SLA space access');
    if (!data || data.organization_id !== organizationId)
      throw new NotFoundException('Space not found');
    const grant = await this.permissionsService.resolveSpaceBaseGrant(
      userId,
      organizationId,
      spaceId,
    );
    if (!spaceGrantAllows(grant, 'manage_sla'))
      throw new ForbiddenException('Space manage_sla permission is required');
  }

  private assertSlaField(
    scope: string,
    input: CreateCustomFieldInput | UpdateCustomFieldInput,
  ): void {
    if (scope !== 'space')
      throw new BadRequestException('SLA fields must be space-scoped');
    if (
      input.contexts &&
      (input.contexts.length !== 1 || input.contexts[0] !== 'task')
    )
      throw new BadRequestException('SLA fields are task-only');
    if (
      input.default_value != null ||
      input.validation_rules?.required === true
    )
      throw new BadRequestException(
        'SLA fields are computed and cannot have defaults or be required',
      );
    if (input.validation_rules?.sla != null)
      throw new BadRequestException('Use the SLA configuration endpoint');
  }

  private logAudit(
    organizationId: string,
    userId: string | null | undefined,
    fieldId: string,
    action: 'create' | 'update' | 'delete' | 'restore',
    changes?: Record<string, unknown>,
  ): void {
    if (!userId || !this.auditLogsService) return;
    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'custom_field',
      fieldId,
      action,
      changes,
    );
  }

  /**
   * Generate a field key from a name that is guaranteed unique within the
   * given organization. Adds `_1`, `_2`, ... suffixes on conflict.
   */
  async generateUniqueFieldKey(
    organizationId: string,
    name: string,
    spaceId?: string | null,
  ): Promise<string> {
    const base = generateFieldKey(name);
    let candidate = base;
    let counter = 1;
    // Loop with a hard safety cap.
    for (let i = 0; i < 1000; i++) {
      let query = this.client
        .from('custom_fields')
        .select('id')
        .eq('organization_id', organizationId)
        .eq('field_key', candidate)
        .or('is_deleted.is.null,is_deleted.eq.false');

      if (spaceId) {
        query = query.or(`space_id.is.null,space_id.eq.${spaceId}`);
      }

      const r = await query.limit(1);
      if (r.error) throw new BadRequestException(r.error.message);
      if (!r.data || r.data.length === 0) return candidate;
      candidate = `${base}_${counter++}`;
    }
    return candidate;
  }

  /**
   * Space-only, task-only, and a key unique across the organization: a ticket moved to another
   * space keeps its values, so a reused key would silently match the other space's field.
   */
  private async prepareIssueGroupCreate(
    organizationId: string,
    userId: string | null,
    scope: string,
    input: CreateCustomFieldInput,
  ): Promise<CreateCustomFieldInput> {
    if (scope !== 'space' || !input.space_id) {
      throw new BadRequestException('An issue group field belongs to a space');
    }

    const { count, error } = await this.client
      .from('custom_fields')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('space_id', input.space_id)
      .eq('field_type', 'issue_group')
      .or('is_deleted.is.null,is_deleted.eq.false');

    if (error) throw new BadRequestException(error.message);
    if ((count ?? 0) >= ISSUE_GROUP_MAX_FIELDS_PER_SPACE) {
      throw new BadRequestException(
        `A space can have at most ${ISSUE_GROUP_MAX_FIELDS_PER_SPACE} issue group fields`,
      );
    }

    await this.assertIssueGroupNameFree(
      organizationId,
      input.space_id,
      input.name,
    );
    await this.assertIssueGroupOptions(organizationId, input.options, []);

    return {
      ...input,
      field_key: `${generateFieldKey(input.name).slice(0, 80)}_${randomBytes(4).toString('hex')}`,
      contexts: ['task'],
      options: this.stampIssueGroupOptions(input.options, [], userId),
    };
  }

  private async prepareIssueGroupUpdate(
    organizationId: string,
    userId: string | null,
    existing: CustomField,
    input: UpdateCustomFieldInput,
  ): Promise<UpdateCustomFieldInput> {
    if (input.name !== undefined) {
      await this.assertIssueGroupNameFree(
        organizationId,
        existing.space_id,
        input.name,
        existing.id,
      );
    }

    const tickets = () => {
      return this.client
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', organizationId)
        .eq('space_id', existing.space_id as string);
    };

    if (
      input.validation_rules !== undefined &&
      isSingleIssueGroup(input.validation_rules) &&
      !isSingleIssueGroup(existing.validation_rules)
    ) {
      // A second array element exists only on tickets holding several values.
      const { count, error } = await tickets().not(
        `custom_field_values->${existing.field_key}->1`,
        'is',
        null,
      );

      if (error) throw new BadRequestException(error.message);
      if (count) {
        throw new ConflictException(
          `${count} ticket(s) have several values for this field. Reduce them to one before switching to single select.`,
        );
      }
    }

    if (input.options === undefined) return input;

    const previous = existing.options ?? [];

    await this.assertIssueGroupOptions(
      organizationId,
      input.options,
      previous,
    );

    const kept = new Set((input.options as FieldOption[]).map((o) => o.value));

    for (const removed of previous.filter((o) => !kept.has(o.value))) {
      const { count, error } = await tickets().contains(
        'custom_field_values',
        { [existing.field_key]: [removed.value] },
      );

      if (error) throw new BadRequestException(error.message);
      if (count) {
        throw new ConflictException(
          `Option "${removed.label}" is used by ${count} ticket(s). Archive it instead.`,
        );
      }
    }

    return {
      ...input,
      contexts: ['task'],
      options: this.stampIssueGroupOptions(input.options, previous, userId),
    };
  }

  private async assertIssueGroupNameFree(
    organizationId: string,
    spaceId: string | null | undefined,
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const { data, error } = await this.client
      .from('custom_fields')
      .select('id, name')
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId as string)
      .eq('field_type', 'issue_group')
      .or('is_deleted.is.null,is_deleted.eq.false');

    if (error) throw new BadRequestException(error.message);

    const wanted = name.trim().toLocaleLowerCase();
    const taken = ((data ?? []) as Array<{ id: string; name: string }>).some(
      (f) => f.id !== exceptId && f.name.trim().toLocaleLowerCase() === wanted,
    );

    if (taken) {
      throw new ConflictException(
        `An issue group field named "${name.trim()}" already exists in this space`,
      );
    }
  }

  /** Leads are checked only when they change, so a lead who left never blocks an unrelated save. */
  private async assertIssueGroupOptions(
    organizationId: string,
    options: unknown,
    previous: FieldOption[],
  ): Promise<void> {
    const problem = issueGroupOptionsError(options);

    if (problem) throw new BadRequestException(problem);

    const before = new Map(previous.map((o) => [o.value, o.lead_user_id]));
    const leads = [
      ...new Set(
        (options as FieldOption[])
          .filter((o) => o.lead_user_id && o.lead_user_id !== before.get(o.value))
          .map((o) => o.lead_user_id as string),
      ),
    ];

    if (leads.length === 0) return;

    const { data, error } = await this.client
      .from('organization_members')
      .select('user_id, user:users!inner(is_active)')
      .eq('organization_id', organizationId)
      .in('user_id', leads);

    if (error) throw new BadRequestException(error.message);

    const active = new Set(
      ((data ?? []) as unknown as Array<{
        user_id: string;
        user: { is_active?: boolean | null } | null;
      }>)
        .filter((m) => m.user?.is_active !== false)
        .map((m) => m.user_id),
    );

    if (leads.some((id) => !active.has(id))) {
      throw new BadRequestException('An option lead must be an active user');
    }
  }

  private stampIssueGroupOptions(
    options: unknown,
    previous: FieldOption[],
    userId: string | null,
  ): FieldOption[] {
    const before = new Map(previous.map((o) => [o.value, o.created_by]));

    return (options as FieldOption[]).map((o) => ({
      ...o,
      label: o.label.trim(),
      status: o.status === 'archived' ? 'archived' : 'active',
      created_by: before.has(o.value) ? (before.get(o.value) ?? null) : userId,
    }));
  }

  /** Count how many `field_group_fields` rows reference this field. */
  async isFieldInUse(id: string): Promise<{ inUse: boolean; count: number }> {
    const r = await this.client
      .from('field_group_fields')
      .select('id', { count: 'exact', head: true })
      .eq('custom_field_id', id);
    if (r.error) throw new BadRequestException(r.error.message);
    const c = r.count ?? 0;
    return { inUse: c > 0, count: c };
  }
}
