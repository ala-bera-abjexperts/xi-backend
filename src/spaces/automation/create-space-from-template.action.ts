import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';

import { ActionRegistryService } from '../../automations/actions/action-registry.service';
import type {
  ActionDefinition,
  ExecutionContext,
} from '../../automations/actions/types';
import {
  hasUnresolvedPlaceholder,
  substitute,
} from '../../automations/utils/template';
import { PermissionsService } from '../../permissions/permissions.service';
import { SpaceTemplatesService } from '../../space-templates/space-templates.service';
import { SpacesService } from '../spaces.service';
import { buildTaskVariables } from './task-variables';

const LEDGER_TABLE = 'space_template_provisioning_runs';

// DB limits. The action calls SpacesService directly, so the controller's
// ValidationPipe never runs and CreateSpaceDto's decorators do not apply.
const MAX_NAME = 255;
const MAX_CATEGORY = 100;
const MAX_ICON = 100;
const MAX_COLOR = 7;
const KEY_ATTEMPTS = 8;

const configSchema = z.object({
  templateId: z.string().uuid(),
  spaceName: z.string().min(1),
  spaceKey: z
    .string()
    .regex(/^[A-Z0-9]{2,8}$/)
    .optional(),
  description: z.string().optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
  category: z.string().optional(),
  leadId: z.string().optional(),
  taskId: z.string().optional(),
  requiredVariables: z.array(z.string().min(1)).max(50).optional(),
});

type Config = z.infer<typeof configSchema>;

const outputSchema = z.object({
  space: z.object({ id: z.string(), key: z.string(), name: z.string() }),
  templateApplied: z.boolean(),
  substitutedCount: z.number(),
  unresolved: z.array(z.string()),
  warnings: z.array(z.string()),
  reused: z.boolean(),
});

/**
 * Derives a key candidate from the space name.
 *
 * Keeps the trailing digits when the name has any, because that is usually the part that
 * distinguishes one generated space from the next — "Project PN-4711" gives PROJ4711 rather
 * than PROJEC, which every other "Project …" would also produce.
 */
function keyBase(name: string): string {
  const alnum = name.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();

  if (alnum.length === 0) return 'SPACE';
  if (alnum.length <= 8) return alnum.padEnd(2, 'X');

  // Long name with digits: 4 leading characters + the last 4, so the number survives.
  if (/[0-9]/.test(alnum)) return `${alnum.slice(0, 4)}${alnum.slice(-4)}`;

  return alnum.slice(0, 8);
}

@Injectable()
export class CreateSpaceFromTemplateAction implements OnModuleInit {
  private readonly logger = new Logger(CreateSpaceFromTemplateAction.name);

  constructor(
    private readonly registry: ActionRegistryService,
    private readonly spacesService: SpacesService,
    private readonly spaceTemplatesService: SpaceTemplatesService,
    private readonly permissionsService: PermissionsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.buildDefinition());
  }

  private buildDefinition(): ActionDefinition {
    return {
      kind: 'app.space.create_from_template',
      category: 'app_mutation',
      type: 'action',
      label: {
        en: 'Create space from template',
        de: 'Bereich aus Vorlage erstellen',
      },
      description: {
        en: "Creates a space from a space template, filling the template's {{ }} placeholders with custom field values from the triggering task",
        de: 'Erstellt einen Bereich aus einer Bereichsvorlage und füllt die {{ }}-Platzhalter mit Werten benutzerdefinierter Felder der auslösenden Aufgabe',
      },
      icon: 'bx-grid-alt',
      inputSchema: z.unknown(),
      configSchema,
      outputSchema,
      handler: (config, _input, ctx) => this.execute(config as Config, ctx),
    };
  }

  /** Resolves the task whose custom fields feed the template. */
  private resolveTaskId(config: Config, ctx: ExecutionContext): string | null {
    if (config.taskId && !hasUnresolvedPlaceholder(config.taskId)) {
      return config.taskId;
    }

    const payload = ctx.triggerPayload as {
      task?: { id?: string };
      task_id?: string;
    } | null;

    return payload?.task?.id ?? payload?.task_id ?? null;
  }

  private assertLength(
    label: string,
    value: string | undefined,
    max: number,
  ): void {
    if (value !== undefined && value.length > max) {
      throw new Error(
        `Create space from template: "${label}" is ${value.length} characters after substitution, over the ${max} limit. (400)`,
      );
    }
  }

  private async execute(
    config: Config,
    ctx: ExecutionContext,
  ): Promise<z.infer<typeof outputSchema>> {
    const actingUserId = ctx.actingUserId;

    // A space whose created_by is null gets no owner from add_space_creator_as_admin.
    if (!actingUserId) {
      throw new Error(
        'Create space from template: no acting user for this automation — set a service user or an automation owner. (400)',
      );
    }

    const allowed = await this.permissionsService.checkPermission(
      actingUserId,
      ctx.organizationId,
      'can_create_spaces',
    );

    if (!allowed) {
      throw new Error(
        'Create space from template: the acting user lacks can_create_spaces. (403)',
      );
    }

    // Loud pre-validation — applyTemplateToSpace itself only warns and returns.
    const template = await this.spaceTemplatesService.getTemplate(
      config.templateId,
      ctx.organizationId,
    );

    if (!template.is_active) {
      throw new Error(
        `Create space from template: template "${template.name}" is inactive. (400)`,
      );
    }

    const taskId = this.resolveTaskId(config, ctx);

    if (!taskId) {
      throw new Error(
        'Create space from template: this trigger carries no task, so there are no custom field values to insert. Use a task trigger, or set Task ID. (400)',
      );
    }

    const vars = await buildTaskVariables(
      ctx.supabase,
      taskId,
      ctx.organizationId,
    );

    if (!vars) {
      throw new Error(
        `Create space from template: task ${taskId} was not found in this organization. (400)`,
      );
    }

    for (const shadowedKey of vars.shadowed) {
      ctx.logger.info(
        `Create space from template: custom field "${shadowedKey}" collides with a reserved name — use {{ task.custom_fields.${shadowedKey} }}`,
      );
    }

    for (const required of config.requiredVariables ?? []) {
      if (vars.values[required] === undefined || vars.values[required] === '') {
        throw new Error(
          `Create space from template: required variable "${required}" resolved to nothing for this trigger. (400)`,
        );
      }
    }

    const existing = await this.findLedgerSpace(ctx, taskId);

    if (existing) {
      ctx.logger.info(
        `Create space from template: space ${existing.id} already created for this task — reusing`,
      );

      return {
        space: existing,
        templateApplied: true,
        substitutedCount: 0,
        unresolved: [],
        warnings: [],
        reused: true,
      };
    }

    const name = substitute(config.spaceName, vars.ctx).trim();

    if (!name || hasUnresolvedPlaceholder(name)) {
      throw new Error(
        `Create space from template: the space name resolved to "${name}" — a variable in it has no value on this task. (400)`,
      );
    }

    const description = config.description
      ? substitute(config.description, vars.ctx)
      : undefined;

    const category = config.category
      ? substitute(config.category, vars.ctx)
      : undefined;

    this.assertLength('Space name', name, MAX_NAME);
    this.assertLength('Category', category, MAX_CATEGORY);
    this.assertLength('Icon', config.icon, MAX_ICON);
    this.assertLength('Color', config.color, MAX_COLOR);

    await this.assertNameAvailable(ctx, name);

    const space = await this.createWithKeySuffix(ctx, actingUserId, {
      name,
      description,
      category,
      icon: config.icon,
      color: config.color,
      leadId: this.optionalUuid(ctx, 'Space lead', config.leadId),
      explicitKey: config.spaceKey,
    });

    // Checkpoint before provisioning so a retry reuses this space rather than making another.
    await this.writeLedger(ctx, taskId, space.id);

    const applied = await this.spaceTemplatesService.applyTemplateToSpace(
      config.templateId,
      space.id,
      ctx.organizationId,
      actingUserId,
      vars.ctx,
    );

    const warnings = await this.verifyProvisioned(
      ctx,
      space.id,
      template.config,
    );

    return {
      space: { id: space.id, key: space.key, name: space.name },
      templateApplied: applied.applied,
      substitutedCount: applied.substitutedCount,
      unresolved: applied.unresolved.map((u) => u.path),
      warnings,
      reused: false,
    };
  }

  /** An optional id whose variable resolved to nothing is dropped, not fatal. */
  private optionalUuid(
    ctx: ExecutionContext,
    label: string,
    value?: string,
  ): string | undefined {
    if (!value) return undefined;

    if (hasUnresolvedPlaceholder(value)) {
      ctx.logger.info(
        `Create space from template: "${label}" left an unresolved {{ }} token — skipped`,
      );

      return undefined;
    }

    return value;
  }

  private async findLedgerSpace(
    ctx: ExecutionContext,
    taskId: string,
  ): Promise<{ id: string; key: string; name: string } | null> {
    const { data, error } = await ctx.supabase
      .from(LEDGER_TABLE)
      .select('space_id')
      .eq('automation_id', ctx.automationId)
      .eq('task_id', taskId)
      .maybeSingle<{ space_id: string | null }>();

    // A missing ledger table must not take the action down — provisioning is still correct,
    // only the duplicate guard is lost, and that is visible in the run log.
    if (error) {
      this.logger.warn(`ledger lookup failed: ${error.message}`);

      return null;
    }

    if (!data?.space_id) return null;

    const { data: space } = await ctx.supabase
      .from('spaces')
      .select('id, key, name')
      .eq('id', data.space_id)
      .eq('organization_id', ctx.organizationId)
      .maybeSingle<{ id: string; key: string; name: string }>();

    // Ledger row pointing at a deleted space — treat as not yet created.
    return space ?? null;
  }

  private async writeLedger(
    ctx: ExecutionContext,
    taskId: string,
    spaceId: string,
  ): Promise<void> {
    const { error } = await ctx.supabase.from(LEDGER_TABLE).upsert(
      {
        organization_id: ctx.organizationId,
        automation_id: ctx.automationId,
        task_id: taskId,
        run_id: ctx.runId,
        space_id: spaceId,
      },
      { onConflict: 'automation_id,task_id' },
    );

    if (error) this.logger.warn(`ledger write failed: ${error.message}`);
  }

  private async assertNameAvailable(
    ctx: ExecutionContext,
    name: string,
  ): Promise<void> {
    const { data } = await ctx.supabase
      .from('spaces')
      .select('id')
      .eq('organization_id', ctx.organizationId)
      .eq('name', name)
      .maybeSingle();

    if (data) {
      throw new Error(
        `Create space from template: a space named "${name}" already exists in this organization. (409)`,
      );
    }
  }

  /** Builds the nth candidate for a base, always within the varchar(8) / ^[A-Z0-9]{2,8}$ limits. */
  private keyCandidate(base: string, attempt: number): string {
    if (attempt === 0) return base.slice(0, 8);

    const suffix = String(attempt);

    return `${base.slice(0, 8 - suffix.length)}${suffix}`;
  }

  /**
   * Picks a key that is free right now, then creates the space.
   *
   * Reads the org's existing keys first so the first attempt is already unique, rather than
   * discovering the clash from a thrown conflict. SpacesService mints a 6-character key with
   * no disambiguator and throws on collision, so without this a second similarly-named space
   * fails outright.
   */
  private async createWithKeySuffix(
    ctx: ExecutionContext,
    userId: string,
    input: {
      name: string;
      description?: string;
      category?: string;
      icon?: string;
      color?: string;
      leadId?: string;
      explicitKey?: string;
    },
  ): Promise<{ id: string; key: string; name: string }> {
    const base = input.explicitKey ?? keyBase(input.name);
    let lastError: unknown;

    // Check first: everything already using this stem, in one read.
    const { data: existingRows } = await ctx.supabase
      .from('spaces')
      .select('key')
      .eq('organization_id', ctx.organizationId)
      .like('key', `${base.slice(0, 8)}%`);

    const taken = new Set(
      ((existingRows ?? []) as Array<{ key: string }>).map((r) => r.key),
    );

    let firstFree = 0;

    while (
      firstFree <= KEY_ATTEMPTS &&
      taken.has(this.keyCandidate(base, firstFree))
    ) {
      firstFree += 1;
    }

    // The loop still steps on conflict, covering a race between the read and the insert.
    for (
      let attempt = firstFree;
      attempt <= firstFree + KEY_ATTEMPTS;
      attempt++
    ) {
      const key = this.keyCandidate(base, attempt);

      try {
        const space = await this.spacesService.createSpace(
          ctx.organizationId,
          userId,
          {
            name: input.name,
            key,
            description: input.description,
            category: input.category,
            icon: input.icon,
            color: input.color,
            lead_id: input.leadId,
          },
        );

        return { id: space.id, key: space.key, name: space.name };
      } catch (err) {
        lastError = err;

        const message = err instanceof Error ? err.message : String(err);

        // Only a key conflict is worth another attempt; a name conflict never resolves.
        if (!/key .*already used/i.test(message)) throw err;
      }
    }

    throw new Error(
      `Create space from template: could not find a free space key after ${KEY_ATTEMPTS} attempts (${String(lastError)}). (409)`,
    );
  }

  /**
   * Reports anything the template asked for that is not reachable from the new space.
   *
   * applyTemplateToSpace swallows every per-step failure as a log warning, so without this
   * a half-provisioned space would still report a clean run.
   *
   * Checks identifiers rather than row counts on purpose: statuses, priorities and custom
   * fields are REUSED when an org-level row already carries the same key, so a count is
   * legitimately lower than the template's and would report a false failure.
   */
  private async verifyProvisioned(
    ctx: ExecutionContext,
    spaceId: string,
    templateConfig: Record<string, unknown>,
  ): Promise<string[]> {
    const warnings: string[] = [];

    const entries = (key: string): Array<Record<string, unknown>> =>
      Array.isArray(templateConfig[key])
        ? (templateConfig[key] as Array<Record<string, unknown>>)
        : [];

    // Reusable definitions — an org-level row (space_id IS NULL) satisfies the template too.
    const shared: Array<{
      cfgKey: string;
      table: string;
      idCol: string;
      label: string;
    }> = [
      {
        cfgKey: 'task_statuses',
        table: 'task_statuses',
        idCol: 'key',
        label: 'task statuses',
      },
      {
        cfgKey: 'priorities',
        table: 'task_priorities',
        idCol: 'key',
        label: 'priorities',
      },
      {
        cfgKey: 'custom_fields',
        table: 'custom_fields',
        idCol: 'field_key',
        label: 'custom fields',
      },
    ];

    for (const check of shared) {
      const wanted = entries(check.cfgKey)
        .map((row) => row[check.idCol])
        .filter((v): v is string => typeof v === 'string');

      if (wanted.length === 0) continue;

      const { data, error } = await ctx.supabase
        .from(check.table)
        .select(check.idCol)
        .eq('organization_id', ctx.organizationId)
        .or(`space_id.eq.${spaceId},space_id.is.null`)
        .in(check.idCol, wanted);

      if (error) continue;

      // The select column is dynamic, so supabase-js cannot infer the row shape.
      const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;

      const found = new Set(rows.map((row) => row[check.idCol] as string));

      const missing = wanted.filter((k) => !found.has(k));

      if (missing.length > 0) {
        warnings.push(`${check.label} not provisioned: ${missing.join(', ')}`);
      }
    }

    // Always created fresh and never reused, so a count is exact here. Names are compared
    // by count rather than value because a workflow name may itself have been substituted.
    const spaceScoped: Array<{ cfgKey: string; table: string; label: string }> =
      [
        {
          cfgKey: 'field_groups',
          table: 'field_groups',
          label: 'field groups',
        },
        { cfgKey: 'workflows', table: 'workflows', label: 'workflows' },
      ];

    for (const check of spaceScoped) {
      const expected = entries(check.cfgKey).length;

      if (expected === 0) continue;

      const { count, error } = await ctx.supabase
        .from(check.table)
        .select('id', { count: 'exact', head: true })
        .eq('space_id', spaceId);

      if (error) continue;

      if ((count ?? 0) < expected) {
        warnings.push(
          `${check.label}: template defined ${expected}, space has ${count ?? 0}`,
        );
      }
    }

    // Transitions carry substituted text too, and their insert is swallowed one level down
    // (`if (!newTr?.id) continue`), so a rejected row would otherwise report a clean run.
    const wantedTransitions = entries('workflows').reduce(
      (sum, wf) =>
        sum + (Array.isArray(wf.transitions) ? wf.transitions.length : 0),
      0,
    );

    if (wantedTransitions > 0) {
      const { data: wfRows } = await ctx.supabase
        .from('workflows')
        .select('id')
        .eq('space_id', spaceId);

      const wfIds = ((wfRows ?? []) as Array<{ id: string }>).map((w) => w.id);

      const { count } = wfIds.length
        ? await ctx.supabase
            .from('workflow_transitions')
            .select('id', { count: 'exact', head: true })
            .in('workflow_id', wfIds)
        : { count: 0 };

      if ((count ?? 0) < wantedTransitions) {
        warnings.push(
          `workflow transitions: template defined ${wantedTransitions}, space has ${count ?? 0} — check each transition's "kind" is one of regular/common/global/self_loop/global_loop/initial`,
        );
      }
    }

    return warnings;
  }
}
