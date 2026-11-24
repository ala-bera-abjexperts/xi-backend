/**
 * @fileoverview Service for space template CRUD and apply/snapshot operations.
 * Handles listing, creating, updating, deleting templates, and the core
 * applyTemplateToSpace algorithm that provisions all config into a new space.
 */

import {
  Injectable,
  Logger,
  ForbiddenException,
  NotFoundException,
  InternalServerErrorException,
  Optional,
} from '@nestjs/common';
import { EntitlementsService } from '../licensing/entitlements.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { ITaskHierarchyConfig } from '../task-hierarchy-config/models/task-hierarchy-config.model';
import { TestManagementSettingsService } from '../test-management/settings/test-management-settings.service';
import { deepSubstitute } from '../automations/utils/deep-substitute';
import type { EvalContext } from '../automations/utils/expression';
import {
  CONFIG_DENY_KEYS,
  CONFIG_SCOPED_DENY_KEYS,
} from './space-template-config-denylist';
import type { CreateSpaceTemplateDto } from './dto/create-space-template.dto';
import type { UpdateSpaceTemplateDto } from './dto/update-space-template.dto';
import type { SaveSpaceAsTemplateDto } from './dto/save-space-as-template.dto';

export interface SpaceTemplate {
  id: string;
  organization_id: string | null;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  category: string | null;
  is_system: boolean;
  is_active: boolean;
  config: Record<string, unknown>;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Outcome of applyTemplateToSpace. `applied: false` means the template was not usable. */
export interface TemplateApplyResult {
  applied: boolean;
  substitutedCount: number;
  unresolved: Array<{ path: string; value: string }>;
}

@Injectable()
export class SpaceTemplatesService {
  private readonly logger = new Logger(SpaceTemplatesService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    // Optional so bare unit-test construction still works; absent reads as
    // "not entitled", so Resource Planning is never copied without a licence.
    @Optional() private readonly entitlementsService?: EntitlementsService,
    @Optional()
    private readonly testManagementSettings?: TestManagementSettingsService,
  ) {}

  /** Resource Planning is licence-gated, so a template may neither carry it
   *  out of, nor into, a tenant without module_resource_planning. */
  private async dropUnlicensedResourcePlanning<
    T extends { module_type: string },
  >(organizationId: string, modules: T[]): Promise<T[]> {
    if (!modules.some((m) => m.module_type === 'resource_planning')) {
      return modules;
    }
    const entitlements =
      await this.entitlementsService?.getEffectiveEntitlements(organizationId);
    return entitlements?.has('module_resource_planning')
      ? modules
      : modules.filter((m) => m.module_type !== 'resource_planning');
  }

  // ============================================================================
  // CRUD
  // ============================================================================

  /**
   * List all templates visible to an organization:
   * system templates (organization_id IS NULL) + org-own templates.
   */
  async listTemplates(organizationId: string): Promise<SpaceTemplate[]> {
    const client = this.supabaseAdmin.getClient();

    const { data, error } = await client
      .from('space_templates')
      .select('*')
      .or(`organization_id.is.null,organization_id.eq.${organizationId}`)
      .eq('is_active', true)
      .order('is_system', { ascending: false })
      .order('created_at', { ascending: true });

    if (error) {
      this.logger.error(`listTemplates failed: ${error.message}`);
      throw new InternalServerErrorException('Failed to list space templates');
    }

    return (data ?? []) as SpaceTemplate[];
  }

  /** Get a single template by id, accessible to the org. */
  async getTemplate(
    id: string,
    organizationId: string,
  ): Promise<SpaceTemplate> {
    const client = this.supabaseAdmin.getClient();

    const { data, error } = await client
      .from('space_templates')
      .select('*')
      .eq('id', id)
      .or(`organization_id.is.null,organization_id.eq.${organizationId}`)
      .maybeSingle();

    if (error) {
      this.logger.error(`getTemplate failed: ${error.message}`);
      throw new InternalServerErrorException('Failed to get space template');
    }

    if (!data) {
      throw new NotFoundException('Space template not found');
    }

    return data as SpaceTemplate;
  }

  /** Create a new org-scoped template. */
  async createTemplate(
    organizationId: string,
    userId: string,
    dto: CreateSpaceTemplateDto,
  ): Promise<SpaceTemplate> {
    const client = this.supabaseAdmin.getClient();

    const { data, error } = await client
      .from('space_templates')
      .insert({
        organization_id: organizationId,
        name: dto.name,
        description: dto.description ?? null,
        icon: dto.icon ?? null,
        color: dto.color ?? '#3B82F6',
        category: dto.category ?? null,
        is_system: false,
        is_active: dto.is_active ?? true,
        config: dto.config ?? {},
        created_by: userId,
        updated_by: userId,
      })
      .select('*')
      .single();

    if (error || !data) {
      this.logger.error(`createTemplate failed: ${error?.message}`);
      throw new InternalServerErrorException('Failed to create space template');
    }

    return data as SpaceTemplate;
  }

  /** Update a non-system org-scoped template. */
  async updateTemplate(
    id: string,
    organizationId: string,
    userId: string,
    dto: UpdateSpaceTemplateDto,
  ): Promise<SpaceTemplate> {
    const existing = await this.getTemplate(id, organizationId);

    if (existing.is_system) {
      throw new ForbiddenException('Cannot modify system templates');
    }

    if (existing.organization_id !== organizationId) {
      throw new ForbiddenException(
        'Cannot modify templates from another organization',
      );
    }

    const client = this.supabaseAdmin.getClient();
    const updates: Record<string, unknown> = { updated_by: userId };

    if (dto.name !== undefined) updates.name = dto.name;
    if (dto.description !== undefined) updates.description = dto.description;
    if (dto.icon !== undefined) updates.icon = dto.icon;
    if (dto.color !== undefined) updates.color = dto.color;
    if (dto.category !== undefined) updates.category = dto.category;
    if (dto.config !== undefined) updates.config = dto.config;
    if (dto.is_active !== undefined) updates.is_active = dto.is_active;

    const { data, error } = await client
      .from('space_templates')
      .update(updates)
      .eq('id', id)
      .select('*')
      .single();

    if (error || !data) {
      this.logger.error(`updateTemplate failed: ${error?.message}`);
      throw new InternalServerErrorException('Failed to update space template');
    }

    return data as SpaceTemplate;
  }

  /** Delete a non-system org-scoped template. */
  async deleteTemplate(id: string, organizationId: string): Promise<void> {
    const existing = await this.getTemplate(id, organizationId);

    if (existing.is_system) {
      throw new ForbiddenException('Cannot delete system templates');
    }

    if (existing.organization_id !== organizationId) {
      throw new ForbiddenException(
        'Cannot delete templates from another organization',
      );
    }

    const client = this.supabaseAdmin.getClient();
    const { error } = await client
      .from('space_templates')
      .delete()
      .eq('id', id);

    if (error) {
      this.logger.error(`deleteTemplate failed: ${error.message}`);
      throw new InternalServerErrorException('Failed to delete space template');
    }
  }

  // ============================================================================
  // Save Space as Template
  // ============================================================================

  /**
   * Snapshot an existing space's configuration into a new org template.
   * Only reads space-scoped items (WHERE space_id = spaceId).
   */
  async createTemplateFromSpace(
    spaceId: string,
    organizationId: string,
    userId: string,
    dto: SaveSpaceAsTemplateDto,
  ): Promise<SpaceTemplate> {
    const config = await this.buildConfigFromSpace(spaceId, organizationId);

    return this.createTemplate(organizationId, userId, {
      name: dto.name,
      description: dto.description,
      icon: dto.icon,
      color: dto.color,
      config,
    });
  }

  /**
   * Build a portable config JSONB from an existing space.
   * All UUIDs are replaced with human-readable keys/labels/names.
   */
  async buildConfigFromSpace(
    spaceId: string,
    organizationId: string,
  ): Promise<Record<string, unknown>> {
    const client = this.supabaseAdmin.getClient();

    // SECURITY (H3): the SOURCE space must belong to the caller's org, otherwise
    // a user could snapshot another tenant's space configuration into a template.
    const { data: srcSpace } = await client
      .from('spaces')
      .select('id, organization_id')
      .eq('id', spaceId)
      .maybeSingle();

    if (!srcSpace || srcSpace.organization_id !== organizationId) {
      throw new ForbiddenException(
        'Source space does not belong to your organization',
      );
    }

    // ── 1. Modules ─────────────────────────────────────────────────────────
    const { data: rawModules } = await client
      .from('space_modules')
      .select('module_type, is_enabled, sort_order, settings')
      .eq('space_id', spaceId)
      .order('sort_order');

    const modules = await this.dropUnlicensedResourcePlanning(
      organizationId,
      (rawModules ?? []).map((m) => ({
        module_type: m.module_type,
        is_enabled: m.is_enabled,
        sort_order: m.sort_order,
        settings: m.settings ?? {},
      })),
    );

    // ── 2. Task Statuses ────────────────────────────────────────────────────
    const { data: rawStatuses } = await client
      .from('task_statuses')
      .select('key, name, color, icon, sort_order, is_default, is_completed')
      .eq('space_id', spaceId)
      .eq('is_active', true)
      .order('sort_order');

    const task_statuses = (rawStatuses ?? []).map((s) => ({
      key: s.key,
      name: s.name,
      color: s.color,
      icon: s.icon ?? undefined,
      sort_order: s.sort_order,
      is_default: s.is_default,
      is_completed: s.is_completed,
    }));

    // ── 3. Task Priorities ──────────────────────────────────────────────────
    const { data: rawPriorities } = await client
      .from('task_priorities')
      .select('key, name, color, icon, sort_order, is_default')
      .eq('space_id', spaceId)
      .eq('is_active', true)
      .order('sort_order');

    const priorities = (rawPriorities ?? []).map((p) => ({
      key: p.key,
      name: p.name,
      color: p.color,
      icon: p.icon ?? undefined,
      sort_order: p.sort_order,
      is_default: p.is_default,
    }));

    // ── 4. Custom Fields ────────────────────────────────────────────────────
    const { data: rawFields } = await client
      .from('custom_fields')
      .select(
        'field_key, name, field_type, description, default_value, options, validation_rules, contexts, sort_order',
      )
      .eq('space_id', spaceId)
      .eq('is_active', true)
      .eq('is_deleted', false)
      .order('sort_order');

    const custom_fields = (rawFields ?? []).map((f) => {
      // Asset config holds the SOURCE space's schema_id/object_type_ids, which dangle
      // in any other space — strip it to keep the exported config UUID-free.
      const { asset: _asset, ...validationRules } = (f.validation_rules ??
        {}) as Record<string, unknown>;

      return {
        field_key: f.field_key,
        name: f.name,
        field_type: f.field_type,
        description: f.description ?? undefined,
        default_value: f.default_value ?? undefined,
        options: f.options ?? undefined,
        validation_rules: f.validation_rules ? validationRules : undefined,
        contexts: f.contexts ?? [],
        sort_order: f.sort_order,
      };
    });

    // Build UUID→field_key lookup for field_group_fields resolution
    const { data: fieldIdKeyRows } = await client
      .from('custom_fields')
      .select('id, field_key')
      .eq('space_id', spaceId)
      .eq('is_deleted', false);

    const fieldIdToKey = new Map<string, string>(
      (fieldIdKeyRows ?? []).map(
        (r) => [r.id, r.field_key] as [string, string],
      ),
    );

    // ── 5. Field Groups ─────────────────────────────────────────────────────
    const { data: rawGroups } = await client
      .from('field_groups')
      .select(
        'id, name, description, sort_order, color, icon, is_collapsed_default',
      )
      .eq('space_id', spaceId)
      .eq('is_deleted', false)
      .order('sort_order');

    const field_groups: unknown[] = [];

    for (const g of rawGroups ?? []) {
      const { data: rawGFields } = await client
        .from('field_group_fields')
        .select(
          'custom_field_id, sort_order, is_required, is_hidden, column_span, default_value_override',
        )
        .eq('field_group_id', g.id)
        .order('sort_order');

      const fields = (rawGFields ?? [])
        .map((gf) => {
          const fk = fieldIdToKey.get(gf.custom_field_id);

          if (!fk) return null;

          return {
            field_key: fk,
            sort_order: gf.sort_order,
            is_required: gf.is_required,
            is_hidden: gf.is_hidden,
            column_span: gf.column_span,
            default_value_override: gf.default_value_override ?? undefined,
          };
        })
        .filter(Boolean);

      field_groups.push({
        name: g.name,
        description: g.description ?? undefined,
        sort_order: g.sort_order,
        color: g.color ?? undefined,
        icon: g.icon ?? undefined,
        is_collapsed_default: g.is_collapsed_default,
        fields,
      });
    }

    // ── 6. Workflows ────────────────────────────────────────────────────────
    const { data: rawWorkflows } = await client
      .from('workflows')
      .select('id, name, description, initial_status_id')
      .eq('space_id', spaceId)
      .eq('is_archived', false);

    const workflows: unknown[] = [];

    for (const wf of rawWorkflows ?? []) {
      // Fetch nodes
      const { data: rawNodes } = await client
        .from('workflow_nodes')
        .select(
          'id, kind, status_id, label, position_x, position_y, properties',
        )
        .eq('workflow_id', wf.id);

      // Build node UUID→label map (for transition resolution)
      const nodeIdToLabel = new Map<string, string>();
      const statusIdToKey = new Map<string, string>();

      // Build status UUID→key lookup (from task_statuses with space_id)
      const statusIds = (rawNodes ?? [])
        .filter((n) => n.status_id)
        .map((n) => n.status_id as string);

      if (statusIds.length > 0) {
        const { data: statusRows } = await client
          .from('task_statuses')
          .select('id, key')
          .in('id', statusIds);

        for (const s of statusRows ?? []) {
          statusIdToKey.set(s.id, s.key);
        }
      }

      // Also resolve initial_status_id
      let initial_status_key: string | undefined;

      if (wf.initial_status_id) {
        if (statusIdToKey.has(wf.initial_status_id)) {
          initial_status_key = statusIdToKey.get(wf.initial_status_id);
        } else {
          const { data: initStatus } = await client
            .from('task_statuses')
            .select('key')
            .eq('id', wf.initial_status_id)
            .maybeSingle();

          initial_status_key = initStatus?.key;
        }
      }

      // Build field group UUID→name lookup for screen_field_group_id
      const { data: fgRows } = await client
        .from('field_groups')
        .select('id, name')
        .eq('space_id', spaceId)
        .eq('is_deleted', false);

      const fgIdToName = new Map<string, string>(
        (fgRows ?? []).map((r) => [r.id, r.name] as [string, string]),
      );

      const nodes = (rawNodes ?? []).map((n) => {
        let label: string;

        if (n.kind === 'start') {
          label = '__start__';
        } else if (n.kind === 'decision') {
          label = n.label ?? `decision_${n.id.slice(0, 8)}`;
        } else {
          // status node
          label =
            n.label ??
            statusIdToKey.get(n.status_id) ??
            `status_${n.id.slice(0, 8)}`;
        }

        nodeIdToLabel.set(n.id, label);

        return {
          kind: n.kind,
          label,
          status_key: n.status_id ? statusIdToKey.get(n.status_id) : undefined,
          position_x: n.position_x,
          position_y: n.position_y,
          properties: n.properties ?? {},
        };
      });

      // Fetch transitions
      const { data: rawTransitions } = await client
        .from('workflow_transitions')
        .select(
          'id, name, kind, to_node_id, screen_field_group_id, sort_order, conditions, validators, post_functions, triggers, properties',
        )
        .eq('workflow_id', wf.id)
        .order('sort_order');

      const transitions: unknown[] = [];

      for (const tr of rawTransitions ?? []) {
        const to_node_label = nodeIdToLabel.get(tr.to_node_id);

        if (!to_node_label) continue;

        // Fetch sources (many-to-many junction)
        const { data: srcRows } = await client
          .from('workflow_transition_sources')
          .select('from_node_id')
          .eq('transition_id', tr.id);

        const from_node_labels = (srcRows ?? [])
          .map((s) => nodeIdToLabel.get(s.from_node_id))
          .filter(Boolean) as string[];

        transitions.push({
          name: tr.name,
          kind: tr.kind,
          sort_order: tr.sort_order,
          from_node_labels,
          to_node_label,
          screen_field_group_name: tr.screen_field_group_id
            ? fgIdToName.get(tr.screen_field_group_id)
            : undefined,
          conditions: tr.conditions ?? [],
          validators: tr.validators ?? [],
          post_functions: tr.post_functions ?? [],
          triggers: tr.triggers ?? [],
          properties: tr.properties ?? {},
        });
      }

      workflows.push({
        name: wf.name,
        description: wf.description ?? undefined,
        initial_status_key,
        nodes,
        transitions,
      });
    }

    // ── 7. Task Hierarchy Config ────────────────────────────────────────────
    const { data: rawHierarchy } = await client
      .from('task_hierarchy_configurations')
      .select('config')
      .eq('space_id', spaceId)
      .maybeSingle();

    // Test task types belong to the module; applying the template adds them again.
    const testTypeIds = new Set(
      (await this.testManagementSettings?.mappedTaskTypeIds(
        organizationId,
        spaceId,
      )) ?? [],
    );
    const task_hierarchy_config = withoutTaskTypes(
      (rawHierarchy?.config as ITaskHierarchyConfig | null) ?? null,
      testTypeIds,
    );

    // ── Development module repositories: ids of this tenant only, applied only within it ──
    const { data: devRepos } = await client
      .from('git_space_repositories')
      .select('repository_id')
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId);

    return {
      modules,
      priorities,
      task_statuses,
      custom_fields,
      field_groups,
      workflows,
      task_hierarchy_config,
      permissions: { default_member_role: 'member' },
      development_repositories: {
        organization_id: organizationId,
        repository_ids: (devRepos ?? []).map((row) => row.repository_id),
      },
    };
  }

  // ============================================================================
  // Apply Template to Space
  // ============================================================================

  /**
   * Apply a template's config to an existing space.
   * Each step is idempotent — safe to retry after a partial failure.
   * Non-fatal errors are logged; they never block space creation.
   *
   * @param templateId - UUID of the space_templates row
   * @param spaceId    - Target space to configure
   * @param orgId      - Organization that owns both template and space
   * @param userId     - User performing the action (for created_by / updated_by)
   * @param variables  - Optional {{ }} values. Omit for the unchanged, verbatim behaviour.
   */
  async applyTemplateToSpace(
    templateId: string,
    spaceId: string,
    orgId: string,
    userId: string,
    variables?: EvalContext,
  ): Promise<TemplateApplyResult> {
    const client = this.supabaseAdmin.getClient();

    // ── Guard: template must be accessible to this org ──────────────────────
    const { data: tpl } = await client
      .from('space_templates')
      .select('id, organization_id, config')
      .eq('id', templateId)
      .maybeSingle();

    if (!tpl) {
      this.logger.warn(
        `applyTemplateToSpace: template ${templateId} not found`,
      );
      return { applied: false, substitutedCount: 0, unresolved: [] };
    }

    if (tpl.organization_id !== null && tpl.organization_id !== orgId) {
      this.logger.warn(
        `applyTemplateToSpace: template ${templateId} belongs to different org`,
      );
      return { applied: false, substitutedCount: 0, unresolved: [] };
    }

    // SECURITY (H3): the TARGET space must belong to the caller's org — otherwise
    // a user could inject module/status/field/workflow config into another
    // tenant's space. (The internal space-creation caller passes a freshly-created
    // same-org space, so this never fires on the legitimate path.)
    const { data: targetSpace } = await client
      .from('spaces')
      .select('id, organization_id')
      .eq('id', spaceId)
      .maybeSingle();

    if (!targetSpace || targetSpace.organization_id !== orgId) {
      this.logger.warn(
        `applyTemplateToSpace: space ${spaceId} not in org ${orgId} — refusing`,
      );
      throw new ForbiddenException(
        'Target space does not belong to your organization',
      );
    }

    const rawConfig = (tpl.config ?? {}) as Record<string, unknown>;

    // No variables => same object reference, so the existing callers are byte-identical.
    const substitution = variables
      ? deepSubstitute(rawConfig, variables, {
          denyKeys: CONFIG_DENY_KEYS,
          scopedDenyKeys: CONFIG_SCOPED_DENY_KEYS,
        })
      : { value: rawConfig, substitutedCount: 0, unresolved: [] };

    const config = substitution.value;

    // Remapping tables — built progressively during apply
    const statusKeyMap = new Map<string, string>();
    const fieldKeyMap = new Map<string, string>();
    const fieldGroupNameMap = new Map<string, string>();
    const nodeIdMap = new Map<string, string>();

    // ── Step 1: Modules ─────────────────────────────────────────────────────
    const configModules = await this.dropUnlicensedResourcePlanning(
      orgId,
      (config.modules ?? []) as Array<{
        module_type: string;
        is_enabled: boolean;
        sort_order: number;
        settings?: Record<string, unknown>;
      }>,
    );

    for (const m of configModules) {
      // supabase-js reports failures in `error` and never throws, so a
      // try/catch here could not see them.
      const { error } = await client.from('space_modules').upsert(
        {
          space_id: spaceId,
          module_type: m.module_type,
          is_enabled: m.is_enabled,
          sort_order: m.sort_order,
          settings: m.settings ?? {},
        },
        { onConflict: 'space_id,module_type' },
      );
      if (error) {
        this.logger.warn(
          `applyTemplateToSpace: module upsert failed for ${m.module_type}: ${error.message}`,
        );
      }
    }

    // ── Step 1b: Development module repositories ────────────────────────────
    // Same tenant only: a template from another tenant (or a global one) never carries usable ids. Only
    // repositories still available in Tenant Config are assigned; the rest are dropped.
    const devRepos = config.development_repositories as
      | { organization_id?: string; repository_ids?: string[] }
      | undefined;

    if (
      devRepos?.organization_id === orgId &&
      devRepos.repository_ids?.length
    ) {
      const { data: live, error: liveError } = await client
        .from('git_repositories')
        .select(
          'id, connection:git_connections!git_repositories_connection_fkey!inner(status)',
        )
        .eq('organization_id', orgId)
        .eq('is_enabled', true)
        .is('removed_at', null)
        .neq('connection.status', 'disconnected')
        .in('id', devRepos.repository_ids);
      const ids = (live ?? []).map((row) => row.id as string);
      const { error } =
        liveError || !ids.length
          ? { error: liveError }
          : await client.rpc('git_set_space_repositories', {
              p_org: orgId,
              p_space_id: spaceId,
              p_repository_ids: ids,
              p_user: userId,
            });

      if (error) {
        this.logger.warn(
          `applyTemplateToSpace: development repositories failed: ${error.message}`,
        );
      }
    }

    // ── Step 2: Task Statuses ────────────────────────────────────────────────
    // Pre-load existing org-level and space-level statuses into map
    const { data: existingStatuses } = await client
      .from('task_statuses')
      .select('id, key')
      .eq('organization_id', orgId)
      .or(`space_id.is.null,space_id.eq.${spaceId}`);

    for (const s of existingStatuses ?? []) {
      statusKeyMap.set(s.key, s.id);
    }

    const configStatuses = (config.task_statuses ?? []) as Array<{
      key: string;
      name: string;
      color: string;
      icon?: string;
      sort_order: number;
      is_default: boolean;
      is_completed: boolean;
    }>;

    for (const s of configStatuses) {
      if (statusKeyMap.has(s.key)) continue;

      try {
        const { data: inserted } = await client
          .from('task_statuses')
          .insert({
            organization_id: orgId,
            space_id: spaceId,
            name: s.name,
            key: s.key,
            color: s.color,
            icon: s.icon ?? null,
            sort_order: s.sort_order,
            is_default: s.is_default,
            is_completed: s.is_completed,
            category_id: null,
            is_active: true,
          })
          .select('id')
          .single();

        if (inserted?.id) {
          statusKeyMap.set(s.key, inserted.id);
        }
      } catch (err) {
        this.logger.warn(
          `applyTemplateToSpace: status insert failed for ${s.key}: ${err}`,
        );
      }
    }

    // ── Step 3: Task Priorities ──────────────────────────────────────────────
    const { data: existingPriorities } = await client
      .from('task_priorities')
      .select('key')
      .eq('space_id', spaceId);

    const existingPriorityKeys = new Set(
      (existingPriorities ?? []).map((p) => p.key),
    );

    const configPriorities = (config.priorities ?? []) as Array<{
      key: string;
      name: string;
      color: string;
      icon?: string;
      sort_order: number;
      is_default: boolean;
    }>;

    for (const p of configPriorities) {
      if (existingPriorityKeys.has(p.key)) continue;

      try {
        await client.from('task_priorities').insert({
          organization_id: orgId,
          space_id: spaceId,
          name: p.name,
          key: p.key,
          color: p.color,
          icon: p.icon ?? null,
          sort_order: p.sort_order,
          is_default: p.is_default,
          is_active: true,
        });
      } catch (err) {
        this.logger.warn(
          `applyTemplateToSpace: priority insert failed for ${p.key}: ${err}`,
        );
      }
    }

    // ── Step 4: Custom Fields ────────────────────────────────────────────────
    // Pre-load org-level fields (reusable without creating space-level copies)
    const { data: orgFields } = await client
      .from('custom_fields')
      .select('id, field_key')
      .eq('organization_id', orgId)
      .is('space_id', null)
      .eq('is_deleted', false);

    for (const f of orgFields ?? []) {
      fieldKeyMap.set(f.field_key, f.id);
    }

    // Also pre-load existing space-level fields
    const { data: spaceFields } = await client
      .from('custom_fields')
      .select('id, field_key')
      .eq('space_id', spaceId)
      .eq('is_deleted', false);

    for (const f of spaceFields ?? []) {
      fieldKeyMap.set(f.field_key, f.id);
    }

    const configFields = (config.custom_fields ?? []) as Array<{
      field_key: string;
      name: string;
      field_type: string;
      description?: string;
      default_value?: unknown;
      options?: unknown[];
      validation_rules?: unknown;
      contexts: string[];
      sort_order: number;
    }>;

    for (const f of configFields) {
      if (fieldKeyMap.has(f.field_key)) continue;

      try {
        const { data: inserted } = await client
          .from('custom_fields')
          .insert({
            organization_id: orgId,
            space_id: spaceId,
            name: f.name,
            field_key: f.field_key,
            field_type: f.field_type,
            description: f.description ?? null,
            default_value: f.default_value ?? null,
            options: f.options ?? null,
            validation_rules: f.validation_rules ?? null,
            contexts: f.contexts ?? [],
            sort_order: f.sort_order,
            scope: 'space',
            is_active: true,
            is_deleted: false,
          })
          .select('id')
          .single();

        if (inserted?.id) {
          fieldKeyMap.set(f.field_key, inserted.id);
        }
      } catch (err) {
        this.logger.warn(
          `applyTemplateToSpace: custom field insert failed for ${f.field_key}: ${err}`,
        );
      }
    }

    // ── Step 5: Field Groups ─────────────────────────────────────────────────
    const configGroups = (config.field_groups ?? []) as Array<{
      name: string;
      description?: string;
      sort_order: number;
      color?: string;
      icon?: string;
      is_collapsed_default: boolean;
      fields: Array<{
        field_key: string;
        sort_order: number;
        is_required: boolean;
        is_hidden: boolean;
        column_span: number;
        default_value_override?: unknown;
      }>;
    }>;

    for (const g of configGroups) {
      try {
        const { data: newGroup } = await client
          .from('field_groups')
          .insert({
            organization_id: orgId,
            space_id: spaceId,
            name: g.name,
            description: g.description ?? null,
            sort_order: g.sort_order,
            color: g.color ?? null,
            icon: g.icon ?? null,
            is_collapsed_default: g.is_collapsed_default,
            is_deleted: false,
          })
          .select('id')
          .single();

        if (!newGroup?.id) continue;

        fieldGroupNameMap.set(g.name, newGroup.id);

        for (const fRef of g.fields) {
          const cfId = fieldKeyMap.get(fRef.field_key);

          if (!cfId) {
            this.logger.warn(
              `applyTemplateToSpace: field_key ${fRef.field_key} not in map, skipping field_group_fields row`,
            );
            continue;
          }

          await client.from('field_group_fields').insert({
            field_group_id: newGroup.id,
            custom_field_id: cfId,
            sort_order: fRef.sort_order,
            is_required: fRef.is_required,
            is_hidden: fRef.is_hidden,
            column_span: fRef.column_span,
            default_value_override: fRef.default_value_override ?? null,
          });
        }
      } catch (err) {
        this.logger.warn(
          `applyTemplateToSpace: field group insert failed for ${g.name}: ${err}`,
        );
      }
    }

    // ── Step 6: Workflows ────────────────────────────────────────────────────
    const configWorkflows = (config.workflows ?? []) as Array<{
      name: string;
      description?: string;
      initial_status_key?: string;
      nodes: Array<{
        kind: 'status' | 'decision' | 'start';
        label?: string;
        status_key?: string;
        position_x: number;
        position_y: number;
        properties?: Record<string, unknown>;
      }>;
      transitions: Array<{
        name: string;
        kind: string;
        sort_order: number;
        from_node_labels: string[];
        to_node_label: string;
        screen_field_group_name?: string;
        conditions: unknown[];
        validators: unknown[];
        post_functions: unknown[];
        triggers: unknown[];
        properties?: Record<string, unknown>;
      }>;
    }>;

    for (const wf of configWorkflows) {
      try {
        // Create workflow
        const { data: newWf } = await client
          .from('workflows')
          .insert({
            organization_id: orgId,
            space_id: spaceId,
            name: wf.name,
            description: wf.description ?? null,
            is_active: false,
            is_draft: false,
            parent_workflow_id: null,
            lock_token: null,
            lock_user_id: null,
            lock_acquired_at: null,
            created_by: userId,
            updated_by: userId,
          })
          .select('id')
          .single();

        if (!newWf?.id) continue;

        const newWorkflowId = newWf.id;

        // Create nodes
        nodeIdMap.clear();

        for (const node of wf.nodes) {
          const statusId = node.status_key
            ? statusKeyMap.get(node.status_key)
            : null;

          if (node.kind === 'status' && !statusId) {
            this.logger.warn(
              `applyTemplateToSpace: status_key ${node.status_key} not found, skipping node`,
            );
            continue;
          }

          const nodeLabel =
            node.kind === 'start'
              ? '__start__'
              : (node.label ??
                node.status_key ??
                `node_${newWorkflowId.slice(0, 8)}`);

          const { data: newNode } = await client
            .from('workflow_nodes')
            .insert({
              workflow_id: newWorkflowId,
              kind: node.kind,
              status_id: statusId ?? null,
              label: node.label ?? null,
              position_x: node.position_x,
              position_y: node.position_y,
              properties: node.properties ?? {},
            })
            .select('id')
            .single();

          if (newNode?.id) {
            nodeIdMap.set(nodeLabel, newNode.id);
          }
        }

        // Set initial_status_id
        if (wf.initial_status_key) {
          const initStatusId = statusKeyMap.get(wf.initial_status_key);

          if (initStatusId) {
            await client
              .from('workflows')
              .update({ initial_status_id: initStatusId })
              .eq('id', newWorkflowId);
          }
        }

        // Create transitions + sources
        for (const tr of wf.transitions) {
          const toNodeId = nodeIdMap.get(tr.to_node_label);

          if (!toNodeId) {
            this.logger.warn(
              `applyTemplateToSpace: to_node_label "${tr.to_node_label}" not found, skipping transition`,
            );
            continue;
          }

          const screenFgId = tr.screen_field_group_name
            ? (fieldGroupNameMap.get(tr.screen_field_group_name) ?? null)
            : null;

          const remappedPf = this.remapPostFunctionRefs(
            tr.post_functions,
            fieldKeyMap,
            fieldGroupNameMap,
          );

          const { data: newTr } = await client
            .from('workflow_transitions')
            .insert({
              workflow_id: newWorkflowId,
              name: tr.name,
              kind: tr.kind,
              to_node_id: toNodeId,
              screen_field_group_id: screenFgId,
              sort_order: tr.sort_order,
              conditions: tr.conditions ?? [],
              validators: tr.validators ?? [],
              post_functions: remappedPf,
              triggers: tr.triggers ?? [],
              properties: tr.properties ?? {},
            })
            .select('id')
            .single();

          if (!newTr?.id) continue;

          for (const fromLabel of tr.from_node_labels) {
            const fromNodeId = nodeIdMap.get(fromLabel);

            if (!fromNodeId) {
              this.logger.warn(
                `applyTemplateToSpace: from_node_label "${fromLabel}" not found, skipping source row`,
              );
              continue;
            }

            await client.from('workflow_transition_sources').insert({
              transition_id: newTr.id,
              from_node_id: fromNodeId,
            });
          }
        }
      } catch (err) {
        this.logger.warn(
          `applyTemplateToSpace: workflow "${wf.name}" failed: ${err}`,
        );
      }
    }

    // ── Step 7: Task Hierarchy Config ────────────────────────────────────────
    const hierarchyConfig = config.task_hierarchy_config;

    if (hierarchyConfig !== null && hierarchyConfig !== undefined) {
      try {
        await client.from('task_hierarchy_configurations').upsert(
          {
            organization_id: orgId,
            space_id: spaceId,
            config: hierarchyConfig,
            created_by: userId,
            updated_by: userId,
          },
          { onConflict: 'space_id', ignoreDuplicates: true },
        );
      } catch (err) {
        this.logger.warn(
          `applyTemplateToSpace: task_hierarchy_config upsert failed: ${err}`,
        );
      }
    }

    // Runs after the template's own types are saved, so the test types are added on top of them.
    const testManagement = configModules.find(
      (m) => m.module_type === 'test_management',
    );
    if (testManagement && this.testManagementSettings) {
      try {
        await this.testManagementSettings.syncTaskTypes(
          orgId,
          spaceId,
          testManagement.is_enabled,
          userId,
        );
      } catch (err) {
        this.logger.warn(
          `applyTemplateToSpace: test task types sync failed: ${err}`,
        );
      }
    }

    this.logger.log(
      `applyTemplateToSpace: template ${templateId} applied to space ${spaceId}`,
    );

    return {
      applied: true,
      substitutedCount: substitution.substitutedCount,
      unresolved: substitution.unresolved,
    };
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  /**
   * Remap UUID references inside post_functions for org-templated spaces.
   * - field_id: look up by field_key in fieldKeyMap
   * - screen_field_group_id: look up by name in fieldGroupNameMap
   * - resolution_id / user_id / role_id / group_id: org-scoped, leave as-is
   */
  private remapPostFunctionRefs(
    postFunctions: unknown[],
    fieldKeyMap: Map<string, string>,
    fieldGroupNameMap: Map<string, string>,
  ): unknown[] {
    if (!Array.isArray(postFunctions)) return [];

    return postFunctions.map((pf) => {
      if (typeof pf !== 'object' || pf === null) return pf;

      const obj = { ...(pf as Record<string, unknown>) };

      // Remap field_id via field_key stored in the post-function
      if (obj._field_key && typeof obj._field_key === 'string') {
        const mapped = fieldKeyMap.get(obj._field_key);

        if (mapped) {
          obj.field_id = mapped;
        }

        delete obj._field_key;
      }

      // Remap screen_field_group_id via group name
      if (
        obj._screen_field_group_name &&
        typeof obj._screen_field_group_name === 'string'
      ) {
        const mapped = fieldGroupNameMap.get(obj._screen_field_group_name);

        if (mapped) {
          obj.screen_field_group_id = mapped;
        }

        delete obj._screen_field_group_name;
      }

      return obj;
    });
  }
}

function withoutTaskTypes(
  config: ITaskHierarchyConfig | null,
  ids: Set<string>,
): ITaskHierarchyConfig | null {
  if (!config || ids.size === 0) return config;

  return {
    ...config,
    levels: config.levels
      .filter((l) => !ids.has(l.id))
      .map((l) => ({
        ...l,
        parent_level_id:
          l.parent_level_id && ids.has(l.parent_level_id)
            ? null
            : l.parent_level_id,
        allowed_parent_types: (l.allowed_parent_types ?? []).filter(
          (id) => !ids.has(id),
        ),
        allowed_child_types: (l.allowed_child_types ?? []).filter(
          (id) => !ids.has(id),
        ),
      })),
  };
}
