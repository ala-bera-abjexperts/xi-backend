/**
 * @fileoverview Product plans and their items for Robert (XE-T353 1.22, ROB-08): which plans a person
 * may use, and the writes of a Confirm. Everything is asked with the rules of the human plan routes
 * (PlansService), as the person who confirms. "Plan" here is a product plan; the model's batch of
 * cards is an AgentPlan elsewhere in chat-agent.
 * @module src/chat-agent/agent-plans.service
 */
import { Injectable, Optional } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { PermissionsService } from '../permissions/permissions.service';
import { CreatePlanDto } from '../plans/dto/create-plan.dto';
import { CreatePlanItemDto } from '../plans/dto/create-plan-item.dto';
import { PlansService } from '../plans/plans.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  AgentGovernanceError,
  type AgentActor,
} from './agent-governance.service';

export const PLAN_TYPES = ['waterfall', 'agile', 'hybrid', 'ipma'] as const;
export type AgentPlanType = (typeof PLAN_TYPES)[number];
export const PLAN_ITEM_TYPES = [
  'phase',
  'work_package',
  'task',
  'milestone',
] as const;
export type AgentPlanItemType = (typeof PLAN_ITEM_TYPES)[number];
export const PLAN_ITEM_PRIORITIES = [
  'highest',
  'high',
  'medium',
  'low',
  'lowest',
] as const;

export interface ProductPlanRow {
  id: string;
  plan_key: string | null;
  name: string;
  space_id: string;
  status: string;
  is_archived: boolean | null;
  start_date: string | null;
  end_date: string | null;
  currency: string | null;
}

export interface PlanItemRow {
  taskId: string;
  key: string | null;
  summary: string;
  itemType: string;
}

/** A new product plan (1.22), as the card shows it. Always created as Draft. */
export interface AgentProductPlanInput {
  spaceId: string;
  name: string;
  description: string | null;
  planType: AgentPlanType;
  startDate: string | null;
  endDate: string | null;
  ownerId: string | null;
}

export interface AgentPlanItemInput {
  name: string;
  description: string | null;
  itemType: AgentPlanItemType;
  startDate: string | null;
  endDate: string | null;
  ownerId: string | null;
  priority: string | null;
  estimatedHours: number | null;
  estimatedCost: number | null;
  progress: number | null;
}

const PLAN_COLUMNS =
  'id, plan_key, name, space_id, status, is_archived, start_date, end_date, currency';
/** ponytail: the newest 200 plans of the organization are looked at; search the server when tenants pass that. */
const MAX_PLANS = 200;
const RANK: Record<string, number> = { view: 1, edit: 2, admin: 3 };

const isInvalid = async (dto: object): Promise<boolean> =>
  (await validate(dto)).length > 0;
const isUniqueViolation = (err: unknown) =>
  /duplicate key|23505/.test(String((err as Error)?.message ?? '')) ||
  ((err as { code?: string })?.code ?? '') === '23505';

const escapeHtml = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
/** How a plan item description is stored: escaped paragraphs, like a person's rich text. */
export const planItemHtml = (text: string | null) =>
  text
    ? text
        .split(/\n{2,}/)
        .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
        .join('')
    : undefined;
const asHtml = planItemHtml;

/** CreatePlanItemDto allows 10,000 characters of description; the stored HTML is what counts. */
export const PLAN_ITEM_DESCRIPTION_MAX = 10_000;
/** tasks.estimated_time is an integer of minutes; tasks.estimated_cost is numeric(12,2). */
export const PLAN_ITEM_MAX_HOURS = 1_000_000;
export const PLAN_ITEM_MAX_COST = 9_999_999_999.99;

/** The text cut so its stored HTML fits (audit 2026-11-10): the card shows what is stored. */
export function fitPlanItemText(text: string): string {
  let out = Array.from(text).slice(0, PLAN_ITEM_DESCRIPTION_MAX).join('');
  for (
    let over = (planItemHtml(out) ?? '').length - PLAN_ITEM_DESCRIPTION_MAX;
    over > 0;
  ) {
    out = Array.from(out)
      .slice(0, -Math.max(1, Math.ceil(over / 5)))
      .join('')
      .trimEnd();
    over = (planItemHtml(out) ?? '').length - PLAN_ITEM_DESCRIPTION_MAX;
  }
  return out;
}

@Injectable()
export class AgentPlansService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly permissions: PermissionsService,
    @Optional() private readonly plans?: PlansService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** Whether plans can be made at all here (the service is wired). */
  get available(): boolean {
    return !!this.plans;
  }

  /**
   * The plans the person may add items to, the human route's 'edit' rule (PlansService
   * userCanAccessPlan): org owner or admin, edit_plans in the space, or an explicit edit or admin
   * row on the plan. Archived plans are included, so the card can say why it can't use one.
   */
  async editablePlans(
    actor: AgentActor,
    spaceId?: string | null,
    level: 'view' | 'edit' = 'edit',
  ): Promise<ProductPlanRow[]> {
    let query = this.client
      .from('plans')
      .select(PLAN_COLUMNS)
      .eq('organization_id', actor.organizationId)
      .order('updated_at', { ascending: false })
      .limit(MAX_PLANS);
    if (spaceId) query = query.eq('space_id', spaceId);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return this.filterAccess(actor, (data ?? []) as ProductPlanRow[], level);
  }

  /** One plan of the organization, whatever the person may do with it (null: no such plan). */
  async planById(
    actor: AgentActor,
    id: string,
  ): Promise<ProductPlanRow | null> {
    const { data, error } = await this.client
      .from('plans')
      .select(PLAN_COLUMNS)
      .eq('id', id)
      .eq('organization_id', actor.organizationId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as ProductPlanRow | null) ?? null;
  }

  async canEdit(actor: AgentActor, plan: ProductPlanRow): Promise<boolean> {
    return (await this.filterAccess(actor, [plan], 'edit')).length === 1;
  }

  /** The human Undo rule for a plan: what deletePlan asks ('admin' level). */
  async canDelete(actor: AgentActor, plan: ProductPlanRow): Promise<boolean> {
    return (await this.filterAccess(actor, [plan], 'admin')).length === 1;
  }

  /**
   * createPlan's own rule (assertSpacePlanPermission): a space member holding create_plans. It has no
   * owner or admin bypass, so neither has Robert.
   */
  async canCreateIn(actor: AgentActor, spaceId: string): Promise<boolean> {
    const access = await this.permissions.getUserSpacePermissions(
      actor.userId,
      actor.organizationId,
      spaceId,
    );
    return access.isMember && access.permissions['create_plans'] === true;
  }

  /** Items of a plan by task key or by name, for a parent named in the request. */
  async findItems(planId: string, words: string): Promise<PlanItemRow[]> {
    const { data, error } = await this.client
      .from('plan_tasks')
      .select(
        'task_id, item_type, task:tasks!plan_tasks_task_id_fkey(key, summary)',
      )
      .eq('plan_id', planId)
      .limit(1000);
    if (error) throw new Error(error.message);
    const rows = (
      (data ?? []) as unknown as {
        task_id: string;
        item_type: string;
        task: { key: string | null; summary: string } | null;
      }[]
    ).map((r) => ({
      taskId: r.task_id,
      key: r.task?.key ?? null,
      summary: r.task?.summary ?? '',
      itemType: r.item_type,
    }));
    const said = words.trim().toLowerCase();
    const byKey = rows.filter((r) => r.key?.toLowerCase() === said);
    if (byKey.length) return byKey;
    const exact = rows.filter((r) => r.summary.trim().toLowerCase() === said);
    return exact.length
      ? exact
      : rows.filter((r) => r.summary.toLowerCase().includes(said)).slice(0, 6);
  }

  /** One new plan under the reserved id, as the person; adopted when a crashed try already made it. */
  async createPlan(
    actor: AgentActor,
    id: string,
    input: AgentProductPlanInput,
  ): Promise<{ adopted: boolean }> {
    if (!this.plans) throw new AgentGovernanceError('internal');
    if (await this.planRowExists(actor, id)) {
      await this.keepCreatorAdmin(id, actor.userId);
      return { adopted: true };
    }
    if (!(await this.canCreateIn(actor, input.spaceId)))
      throw new AgentGovernanceError('no_create_plan');

    const dto = plainToInstance(CreatePlanDto, {
      space_id: input.spaceId,
      name: input.name,
      plan_type: input.planType,
      ...(input.description && { description: input.description }),
      ...(input.startDate && { start_date: input.startDate }),
      ...(input.endDate && { end_date: input.endDate }),
      ...(input.ownerId && { owner_id: input.ownerId }),
    });
    if (await isInvalid(dto)) throw new AgentGovernanceError('invalid_input');
    try {
      await this.plans.createPlan(actor.organizationId, actor.userId, dto, {
        id,
      });
      return { adopted: false };
    } catch (err) {
      if (await this.planRowExists(actor, id).catch(() => false)) {
        await this.keepCreatorAdmin(id, actor.userId);
        return { adopted: true };
      }
      throw err;
    }
  }

  /**
   * One new item: its task under the reserved id, written exactly as the human addItem writes it,
   * then its plan link under the plan's lock. Both halves are adopted on a retry.
   */
  async addItem(
    actor: AgentActor,
    taskId: string,
    planId: string,
    parentTaskId: string | null,
    input: AgentPlanItemInput,
  ): Promise<{ adopted: boolean }> {
    if (!this.plans) throw new AgentGovernanceError('internal');
    const { organizationId, userId } = actor;
    const plan = await this.plans.assertCanEditPlan(
      planId,
      organizationId,
      userId,
    );
    if (plan['is_archived'] === true || plan['status'] === 'archived')
      throw new AgentGovernanceError('plan_archived');

    let created = false;
    if (!(await this.taskExists(organizationId, taskId))) {
      const milestone = input.itemType === 'milestone';
      const dto = plainToInstance(CreatePlanItemDto, {
        name: input.name,
        item_type: input.itemType,
        ...(input.description && { description: asHtml(input.description) }),
        ...(parentTaskId && { parent_id: parentTaskId }),
        ...(input.startDate && { start_date: input.startDate }),
        ...(input.endDate && { end_date: input.endDate }),
        // Same day span the human edit route stores; the Gantt draws `duration || 1` days.
        ...(milestone
          ? { duration_days: 0 }
          : input.startDate &&
            input.endDate && {
              duration_days: Math.max(
                0,
                Math.round(
                  (Date.parse(input.endDate) - Date.parse(input.startDate)) /
                    86_400_000,
                ),
              ),
            }),
        ...(input.ownerId && { assigned_to: input.ownerId }),
        ...(input.priority && { priority: input.priority }),
        ...(input.estimatedHours !== null && {
          estimated_hours: input.estimatedHours,
        }),
        ...(input.estimatedCost !== null && {
          estimated_cost: input.estimatedCost,
        }),
        ...(input.progress !== null && { progress: input.progress }),
      });
      if (await isInvalid(dto)) throw new AgentGovernanceError('invalid_input');
      try {
        await this.plans.insertPlanItemTask(
          planId,
          plan,
          organizationId,
          userId,
          dto,
          {
            taskId,
            // Whole minutes: estimated_time is an integer, and 20 min is 1/3 h.
            ...(input.estimatedHours !== null && {
              estimatedMinutes: Math.round(input.estimatedHours * 60),
            }),
          },
        );
        created = true;
      } catch (err) {
        if (
          !(
            isUniqueViolation(err) &&
            (await this.taskExists(organizationId, taskId).catch(() => false))
          )
        )
          throw err;
      }
    }

    const { data, error } = (await this.client.rpc('agent_plan_item_link', {
      p_organization_id: organizationId,
      p_plan_id: planId,
      p_task_id: taskId,
      p_item_type: input.itemType,
      p_color: null,
    })) as { data: unknown; error: { message: string } | null };
    if (error) {
      // A person's addItem takes its task back when the link fails; so does this one.
      if (created)
        await this.client
          .from('tasks')
          .delete()
          .eq('id', taskId)
          .eq('organization_id', organizationId);
      if (/archived/.test(error.message))
        throw new AgentGovernanceError('plan_archived');
      if (/not found/.test(error.message))
        throw new AgentGovernanceError('plan_unavailable');
      throw new Error(error.message);
    }
    const link = data as { adopted?: boolean } | null;
    if (!link?.adopted)
      await this.plans.auditPlanItemCreated(
        organizationId,
        userId,
        taskId,
        planId,
        input.itemType,
      );
    return { adopted: !created };
  }

  /** 1.22.1: the audit rows of a link and a dependency, as a person's add writes them. Never throw. */
  async auditLinked(actor: AgentActor, planId: string, taskId: string, itemType: string): Promise<void> {
    await this.plans
      ?.auditPlanItemCreated(actor.organizationId, actor.userId, taskId, planId, itemType, taskId)
      .catch(() => undefined);
  }

  async auditDependency(
    actor: AgentActor,
    planId: string,
    relationshipId: string,
    predecessorId: string,
    successorId: string,
    type: string,
  ): Promise<void> {
    await this.plans
      ?.auditDependencyCreated(actor.organizationId, actor.userId, relationshipId, planId, predecessorId, successorId, type)
      .catch(() => undefined);
  }

  /** 1.23: the audit rows a person's add writes, for a risk, stakeholder or dates Robert wrote. Never throws. */
  async auditChange(
    actor: AgentActor,
    entityType: 'plan_risk' | 'plan_stakeholder' | 'plan_item',
    entityId: string,
    action: 'create' | 'update',
    changes: Record<string, unknown>,
  ): Promise<void> {
    await this.plans?.auditPlanChange(actor.organizationId, actor.userId, entityType, entityId, action, changes).catch(() => undefined);
  }

  /** The active baseline of a plan, if any: a Robert baseline's Undo makes it active again. */
  async activeBaseline(planId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from('plan_baselines')
      .select('id')
      .eq('plan_id', planId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    return ((data ?? []) as { id: string }[])[0]?.id ?? null;
  }

  /**
   * 1.23: a baseline on request, exactly as the human route takes it (PlansService.createBaseline:
   * plan admin, snapshot of the items, the others made inactive, its outbox event), under the
   * reserved id. Adopted when a crashed try already made it.
   */
  async takeBaseline(actor: AgentActor, id: string, planId: string, name: string): Promise<{ adopted: boolean }> {
    if (!this.plans) throw new AgentGovernanceError('module_off');
    const { data } = await this.client.from('plan_baselines').select('id').eq('id', id).eq('plan_id', planId).maybeSingle();
    if (data) return { adopted: true };
    await this.plans.createBaseline(planId, actor.organizationId, actor.userId, { name }, { id });
    return { adopted: false };
  }

  /** WBS numbers, once per plan after a Confirm or an Undo. Never throws. */
  async recalculate(planIds: Iterable<string>): Promise<void> {
    for (const id of new Set(planIds)) {
      try {
        await this.plans?.recalculateWbs(id);
      } catch {
        // The numbers are recalculated by the plan's next change; nothing is lost.
      }
    }
  }

  /** The plan a task is an item of, for the WBS after its Undo. */
  async planOfTask(
    organizationId: string,
    taskId: string,
  ): Promise<string | null> {
    const { data } = await this.client
      .from('plan_tasks')
      .select('plan_id, plans!inner(organization_id)')
      .eq('task_id', taskId)
      .eq('plans.organization_id', organizationId)
      .limit(1);
    return ((data ?? []) as { plan_id: string }[])[0]?.plan_id ?? null;
  }

  private async filterAccess(
    actor: AgentActor,
    rows: ProductPlanRow[],
    level: 'view' | 'edit' | 'admin',
  ): Promise<ProductPlanRow[]> {
    if (!rows.length) return [];
    if (
      await this.permissions.isAdminOrOwner(actor.userId, actor.organizationId)
    )
      return rows;
    const key =
      level === 'view'
        ? 'view_plans'
        : level === 'edit'
          ? 'edit_plans'
          : 'delete_plans';
    const spaces = new Map<string, boolean>();
    for (const spaceId of new Set(rows.map((r) => r.space_id))) {
      const access = await this.permissions.getUserSpacePermissions(
        actor.userId,
        actor.organizationId,
        spaceId,
      );
      spaces.set(spaceId, access.isMember && access.permissions[key] === true);
    }
    const { data, error } = await this.client
      .from('plan_permissions')
      .select('plan_id, permission_level')
      .eq('user_id', actor.userId)
      .in(
        'plan_id',
        rows.map((r) => r.id),
      );
    if (error) throw new Error(error.message);
    const explicit = new Map(
      ((data ?? []) as { plan_id: string; permission_level: string }[]).map(
        (p) => [p.plan_id, p.permission_level],
      ),
    );
    return rows.filter(
      (r) =>
        spaces.get(r.space_id) ||
        (RANK[explicit.get(r.id) ?? ''] ?? 0) >= RANK[level],
    );
  }

  private async planRowExists(actor: AgentActor, id: string): Promise<boolean> {
    return !!(await this.planById(actor, id));
  }

  private async taskExists(
    organizationId: string,
    id: string,
  ): Promise<boolean> {
    const { data, error } = await this.client
      .from('tasks')
      .select('id')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return !!data;
  }

  /** createPlan writes the creator's admin row right after the plan; a crash in between loses it. */
  async keepCreatorAdmin(
    planId: string,
    userId: string,
  ): Promise<void> {
    await this.client
      .from('plan_permissions')
      .upsert(
        { plan_id: planId, user_id: userId, permission_level: 'admin' },
        { onConflict: 'plan_id,user_id', ignoreDuplicates: true },
      );
  }
}
