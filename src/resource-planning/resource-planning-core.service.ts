/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { OrganizationModulesService } from '../organization-modules/organization-modules.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type {
  CreateBudgetEntryDto,
  BudgetEntryQueryDto,
  UpdateBudgetEntryDto,
} from './dto/budget-entry.dto';
import {
  CURRENCY_REQUIRED_FOR_RATE_MESSAGE,
  type CreateCapacityPeriodDto,
  type UpdateCapacityPeriodDto,
} from './dto/capacity-period.dto';
import type {
  CreateOrganizationUnitDto,
  UpdateOrganizationUnitDto,
} from './dto/organization-unit.dto';
import type {
  CapacityPeriodQueryDto,
  UnitMembershipQueryDto,
} from './dto/resource-planning-common.dto';
import type {
  CreateUnitMembershipDto,
  UpdateUnitMembershipDto,
} from './dto/unit-membership.dto';
import {
  inSpaceScope,
  ResourcePlanningService,
} from './resource-planning.service';
import type {
  BudgetEntryRow,
  CapacityPeriodRow,
  OrganizationUnitRow,
  UnitMembershipRow,
} from './resource-planning-core.types';
import { assertEffectiveDateRange } from './resource-planning.validation';

@Injectable()
export class ResourcePlanningCoreService {
  private get client() {
    return this.supabaseAdmin.getClient();
  }

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly orgModulesService: OrganizationModulesService,
    private readonly resourcePlanningService: ResourcePlanningService,
  ) {}

  private async assertModuleEnabled(organizationId: string): Promise<void> {
    if (
      !(await this.orgModulesService.isEnabled(
        organizationId,
        'resource_planning',
      ))
    ) {
      throw new ForbiddenException('Resource Planning module is not enabled');
    }
  }

  async listUnits(
    organizationId: string,
    includeInactive = false,
  ): Promise<OrganizationUnitRow[]> {
    await this.assertModuleEnabled(organizationId);
    let query = this.client
      .from('organization_units')
      .select('*')
      .eq('organization_id', organizationId);

    if (!includeInactive) query = query.eq('is_active', true);

    const { data, error } = await query
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });
    if (error) throw new InternalServerErrorException(error.message);
    return (data ?? []) as OrganizationUnitRow[];
  }

  async createUnit(
    organizationId: string,
    actorUserId: string,
    dto: CreateOrganizationUnitDto,
  ): Promise<OrganizationUnitRow> {
    await this.assertModuleEnabled(organizationId);
    if (dto.parent_id) {
      const parent = await this.assertUnit(dto.parent_id, organizationId);
      if (!parent.is_active) {
        throw new BadRequestException('Parent unit is archived');
      }
      await this.assertUnitHasNoMembershipHistory(parent.id, organizationId);
    }

    const { data, error } = await this.client
      .from('organization_units')
      .insert({
        organization_id: organizationId,
        parent_id: dto.parent_id ?? null,
        name: dto.name.trim(),
        unit_type: dto.unit_type ?? 'unit',
        description: dto.description?.trim() || null,
        color: dto.color ?? null,
        sort_order: dto.sort_order ?? 0,
        is_active: dto.is_active ?? true,
        created_by: actorUserId,
        updated_by: actorUserId,
      })
      .select('*')
      .single();

    this.throwWriteError(error, 'A unit with this name already exists');
    return data as OrganizationUnitRow;
  }

  async updateUnit(
    id: string,
    organizationId: string,
    actorUserId: string,
    dto: UpdateOrganizationUnitDto,
  ): Promise<OrganizationUnitRow> {
    await this.assertModuleEnabled(organizationId);
    const existing = await this.assertUnit(id, organizationId);

    if (dto.parent_id !== undefined && dto.parent_id !== existing.parent_id) {
      if (dto.parent_id === id) {
        throw new BadRequestException('A unit cannot be its own parent');
      }
      if (dto.parent_id) {
        const parent = await this.assertUnit(dto.parent_id, organizationId);
        if (!parent.is_active) {
          throw new BadRequestException('Parent unit is archived');
        }
        await this.assertUnitHasNoMembershipHistory(parent.id, organizationId);
      }
      await this.assertNoHierarchyCycle(
        id,
        dto.parent_id ?? null,
        organizationId,
      );
    }

    // Archiving via PATCH must not skip the guards DELETE enforces.
    if (dto.is_active === false && existing.is_active) {
      await this.assertUnitArchivable(id, organizationId);
    }

    const patch: Record<string, unknown> = {
      updated_by: actorUserId,
      updated_at: new Date().toISOString(),
    };
    if (dto.name !== undefined) patch.name = dto.name.trim();
    if (dto.unit_type !== undefined) patch.unit_type = dto.unit_type;
    if (dto.parent_id !== undefined) patch.parent_id = dto.parent_id;
    if (dto.description !== undefined)
      patch.description = dto.description?.trim() || null;
    if (dto.color !== undefined) patch.color = dto.color;
    if (dto.sort_order !== undefined) patch.sort_order = dto.sort_order;
    if (dto.is_active !== undefined) patch.is_active = dto.is_active;

    const { data, error } = await this.client
      .from('organization_units')
      .update(patch)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select('*')
      .single();
    this.throwWriteError(error, 'A unit with this name already exists');
    return data as OrganizationUnitRow;
  }

  async archiveUnit(id: string, organizationId: string, actorUserId: string) {
    await this.assertModuleEnabled(organizationId);
    await this.assertUnit(id, organizationId);

    const { data: children, error: childError } = await this.client
      .from('organization_units')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('parent_id', id)
      .limit(1);
    if (childError) throw new InternalServerErrorException(childError.message);
    if ((children ?? []).length > 0) {
      throw new ConflictException('Archive child units first');
    }

    const today = new Date().toISOString().slice(0, 10);
    const { data: memberships, error: memberError } = await this.client
      .from('organization_unit_memberships')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('unit_id', id)
      .or(`effective_to.is.null,effective_to.gte.${today}`)
      .limit(1);
    if (memberError)
      throw new InternalServerErrorException(memberError.message);
    if ((memberships ?? []).length > 0) {
      throw new ConflictException('End active memberships before archiving');
    }

    const { error } = await this.client
      .from('organization_units')
      .update({
        is_active: false,
        updated_by: actorUserId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', organizationId);
    this.throwWriteError(error);
  }

  async listUnitMemberships(
    organizationId: string,
    queryDto: UnitMembershipQueryDto,
  ): Promise<UnitMembershipRow[]> {
    await this.assertModuleEnabled(organizationId);
    this.assertQueryRange(queryDto.from, queryDto.to);
    let query = this.client
      .from('organization_unit_memberships')
      .select('*')
      .eq('organization_id', organizationId);
    if (queryDto.unit_id) query = query.eq('unit_id', queryDto.unit_id);
    if (queryDto.user_id) query = query.eq('user_id', queryDto.user_id);
    if (queryDto.to) query = query.lte('effective_from', queryDto.to);
    if (queryDto.from) {
      query = query.or(
        `effective_to.is.null,effective_to.gte.${queryDto.from}`,
      );
    }
    const { data, error } = await query.order('effective_from', {
      ascending: true,
    });
    if (error) throw new InternalServerErrorException(error.message);
    return (data ?? []) as UnitMembershipRow[];
  }

  async createUnitMembership(
    organizationId: string,
    actorUserId: string,
    dto: CreateUnitMembershipDto,
  ): Promise<UnitMembershipRow> {
    await this.assertModuleEnabled(organizationId);
    assertEffectiveDateRange(dto.effective_from, dto.effective_to);
    await Promise.all([
      this.resourcePlanningService.assertOrganizationMember(
        organizationId,
        dto.user_id,
      ),
      this.assertLeafUnit(dto.unit_id, organizationId),
    ]);
    await this.assertNoPeriodOverlap({
      table: 'organization_unit_memberships',
      organizationId,
      userId: dto.user_id,
      effectiveFrom: dto.effective_from,
      effectiveTo: dto.effective_to,
      unitId: dto.unit_id,
    });

    const { data, error } = await this.client
      .from('organization_unit_memberships')
      .insert({
        organization_id: organizationId,
        unit_id: dto.unit_id,
        user_id: dto.user_id,
        effective_from: dto.effective_from,
        effective_to: dto.effective_to ?? null,
        allocation_percent: dto.allocation_percent ?? null,
        created_by: actorUserId,
        updated_by: actorUserId,
      })
      .select('*')
      .single();
    this.throwWriteError(
      error,
      'This user already has an overlapping unit membership',
    );
    return data as UnitMembershipRow;
  }

  async updateUnitMembership(
    id: string,
    organizationId: string,
    actorUserId: string,
    dto: UpdateUnitMembershipDto,
  ): Promise<UnitMembershipRow> {
    await this.assertModuleEnabled(organizationId);
    const existing = await this.findById<UnitMembershipRow>(
      'organization_unit_memberships',
      id,
      organizationId,
      'Unit membership not found',
    );
    const merged = { ...existing, ...dto };
    assertEffectiveDateRange(merged.effective_from, merged.effective_to);
    await Promise.all([
      this.resourcePlanningService.assertOrganizationMember(
        organizationId,
        merged.user_id,
      ),
      this.assertLeafUnit(merged.unit_id, organizationId),
    ]);
    await this.assertNoPeriodOverlap({
      table: 'organization_unit_memberships',
      organizationId,
      userId: merged.user_id,
      effectiveFrom: merged.effective_from,
      effectiveTo: merged.effective_to,
      excludeId: id,
      unitId: merged.unit_id,
    });

    const { data, error } = await this.client
      .from('organization_unit_memberships')
      .update({
        unit_id: merged.unit_id,
        user_id: merged.user_id,
        effective_from: merged.effective_from,
        effective_to: merged.effective_to,
        allocation_percent: merged.allocation_percent ?? null,
        updated_by: actorUserId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select('*')
      .single();
    this.throwWriteError(
      error,
      'This user already has an overlapping unit membership',
    );
    return data as UnitMembershipRow;
  }

  async deleteUnitMembership(id: string, organizationId: string) {
    await this.deleteById(
      'organization_unit_memberships',
      id,
      organizationId,
      'Unit membership not found',
    );
  }

  async listCapacityPeriods(
    organizationId: string,
    queryDto: CapacityPeriodQueryDto,
  ): Promise<CapacityPeriodRow[]> {
    await this.assertModuleEnabled(organizationId);
    this.assertQueryRange(queryDto.from, queryDto.to);
    let query = this.client
      .from('employee_capacity_periods')
      .select('*')
      .eq('organization_id', organizationId);
    if (queryDto.user_id) query = query.eq('user_id', queryDto.user_id);
    if (queryDto.to) query = query.lte('effective_from', queryDto.to);
    if (queryDto.from) {
      query = query.or(
        `effective_to.is.null,effective_to.gte.${queryDto.from}`,
      );
    }
    const { data, error } = await query.order('effective_from', {
      ascending: true,
    });
    if (error) throw new InternalServerErrorException(error.message);
    return (data ?? []) as CapacityPeriodRow[];
  }

  async createCapacityPeriod(
    organizationId: string,
    actorUserId: string,
    dto: CreateCapacityPeriodDto,
  ): Promise<CapacityPeriodRow> {
    await this.assertModuleEnabled(organizationId);
    assertEffectiveDateRange(dto.effective_from, dto.effective_to);
    await this.resourcePlanningService.assertOrganizationMember(
      organizationId,
      dto.user_id,
    );
    if (dto.is_active ?? true) {
      await this.assertNoPeriodOverlap({
        table: 'employee_capacity_periods',
        organizationId,
        userId: dto.user_id,
        effectiveFrom: dto.effective_from,
        effectiveTo: dto.effective_to,
        onlyActive: true,
      });
    }

    const { data, error } = await this.client
      .from('employee_capacity_periods')
      .insert({
        organization_id: organizationId,
        user_id: dto.user_id,
        effective_from: dto.effective_from,
        effective_to: dto.effective_to ?? null,
        weekly_capacity_hours: dto.weekly_capacity_hours,
        cost_rate: dto.cost_rate ?? null,
        currency: dto.currency?.trim().toUpperCase() ?? null,
        is_active: dto.is_active ?? true,
        created_by: actorUserId,
        updated_by: actorUserId,
      })
      .select('*')
      .single();
    this.throwWriteError(
      error,
      'This user already has an overlapping active capacity period',
    );
    return data as CapacityPeriodRow;
  }

  async updateCapacityPeriod(
    id: string,
    organizationId: string,
    actorUserId: string,
    dto: UpdateCapacityPeriodDto,
  ): Promise<CapacityPeriodRow> {
    await this.assertModuleEnabled(organizationId);
    const existing = await this.findById<CapacityPeriodRow>(
      'employee_capacity_periods',
      id,
      organizationId,
      'Capacity period not found',
    );
    const merged = { ...existing, ...dto };
    // Only PATCHes touching rate/currency are checked, so legacy rows (rate, no currency) stay editable.
    if (
      (dto.cost_rate !== undefined || dto.currency !== undefined) &&
      merged.cost_rate != null &&
      !merged.currency
    ) {
      throw new BadRequestException(CURRENCY_REQUIRED_FOR_RATE_MESSAGE);
    }
    assertEffectiveDateRange(merged.effective_from, merged.effective_to);
    await this.resourcePlanningService.assertOrganizationMember(
      organizationId,
      merged.user_id,
    );
    if (merged.is_active) {
      await this.assertNoPeriodOverlap({
        table: 'employee_capacity_periods',
        organizationId,
        userId: merged.user_id,
        effectiveFrom: merged.effective_from,
        effectiveTo: merged.effective_to,
        excludeId: id,
        onlyActive: true,
      });
    }

    const { data, error } = await this.client
      .from('employee_capacity_periods')
      .update({
        user_id: merged.user_id,
        effective_from: merged.effective_from,
        effective_to: merged.effective_to,
        weekly_capacity_hours: merged.weekly_capacity_hours,
        cost_rate: merged.cost_rate,
        currency: merged.currency?.trim().toUpperCase() ?? null,
        is_active: merged.is_active,
        updated_by: actorUserId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select('*')
      .single();
    this.throwWriteError(
      error,
      'This user already has an overlapping active capacity period',
    );
    return data as CapacityPeriodRow;
  }

  async deleteCapacityPeriod(id: string, organizationId: string) {
    await this.deleteById(
      'employee_capacity_periods',
      id,
      organizationId,
      'Capacity period not found',
    );
  }

  async listBudgetEntries(
    organizationId: string,
    userId: string,
    queryDto: BudgetEntryQueryDto,
  ): Promise<BudgetEntryRow[]> {
    await this.assertModuleEnabled(organizationId);
    this.assertQueryRange(queryDto.from, queryDto.to);
    if (queryDto.plan_id && queryDto.task_id) {
      throw new BadRequestException('Filter by plan_id or task_id, not both');
    }
    if (queryDto.space_id && !queryDto.plan_id && !queryDto.task_id) {
      throw new BadRequestException('space_id requires task_id or plan_id');
    }
    if (queryDto.plan_id) {
      const plan = await this.resourcePlanningService.assertPlanAccess(
        queryDto.plan_id,
        organizationId,
        userId,
        'view',
      );
      if (queryDto.space_id && plan.space_id !== queryDto.space_id) {
        throw new NotFoundException('Plan not found');
      }
    }
    if (queryDto.task_id) {
      const task = await this.resourcePlanningService.assertTaskAccess(
        queryDto.task_id,
        organizationId,
        userId,
        'view',
      );
      if (queryDto.space_id && task.space_id !== queryDto.space_id) {
        throw new NotFoundException('Task not found');
      }
    }

    // No task/plan filter means a multi-space read: embed each row's space so
    // it can be scoped to allowed spaces + null-space rows below.
    const scope =
      queryDto.plan_id || queryDto.task_id
        ? null
        : await this.resourcePlanningService.resolveSpaceScope(
            organizationId,
            userId,
          );

    let query = this.client
      .from('resource_budget_entries')
      .select(scope ? '*, plan:plans(space_id), task:tasks(space_id)' : '*')
      .eq('organization_id', organizationId);
    if (queryDto.plan_id) query = query.eq('plan_id', queryDto.plan_id);
    if (queryDto.task_id) query = query.eq('task_id', queryDto.task_id);
    if (queryDto.entry_type)
      query = query.eq('entry_type', queryDto.entry_type);
    if (queryDto.from) query = query.gte('effective_date', queryDto.from);
    if (queryDto.to) query = query.lte('effective_date', queryDto.to);
    const { data, error } = await query.order('effective_date', {
      ascending: true,
    });
    if (error) throw new InternalServerErrorException(error.message);
    // `unknown` first: supabase-js cannot parse a select string chosen at runtime.
    if (!scope) return (data ?? []) as unknown as BudgetEntryRow[];

    type SpaceEmbed = { space_id: string | null } | null;
    const rows = (data ?? []) as unknown as Array<
      BudgetEntryRow & { plan?: SpaceEmbed; task?: SpaceEmbed }
    >;
    // A missing embed yields undefined, which inSpaceScope rejects.
    return rows.flatMap(({ plan, task, ...entry }) =>
      inSpaceScope(
        scope,
        entry.plan_id ? plan?.space_id : entry.task_id ? task?.space_id : null,
      )
        ? [entry]
        : [],
    );
  }

  async createBudgetEntry(
    organizationId: string,
    actorUserId: string,
    dto: CreateBudgetEntryDto,
  ): Promise<BudgetEntryRow> {
    await this.assertModuleEnabled(organizationId);
    this.assertExactlyOneTarget(dto.plan_id, dto.task_id);
    await this.assertBudgetTargetAccess(
      dto.plan_id ?? null,
      dto.task_id ?? null,
      organizationId,
      actorUserId,
      'write',
    );
    const { data, error } = await this.client
      .from('resource_budget_entries')
      .insert({
        organization_id: organizationId,
        plan_id: dto.plan_id ?? null,
        task_id: dto.task_id ?? null,
        entry_type: dto.entry_type,
        name: dto.name.trim(),
        category: dto.category?.trim() || null,
        cost_category_id: dto.cost_category_id ?? null,
        quantity: dto.quantity ?? 1,
        unit_cost: dto.unit_cost ?? 0,
        currency: dto.currency.trim().toUpperCase(),
        effective_date: dto.effective_date,
        start_date: dto.start_date ?? null,
        end_date: dto.end_date ?? null,
        aggregation: dto.aggregation ?? 'manual',
        notes: dto.notes?.trim() || null,
        created_by: actorUserId,
        updated_by: actorUserId,
      })
      .select('*')
      .single();
    this.throwWriteError(error);
    return data as BudgetEntryRow;
  }

  async updateBudgetEntry(
    id: string,
    organizationId: string,
    actorUserId: string,
    dto: UpdateBudgetEntryDto,
  ): Promise<BudgetEntryRow> {
    await this.assertModuleEnabled(organizationId);
    const existing = await this.findById<BudgetEntryRow>(
      'resource_budget_entries',
      id,
      organizationId,
      'Budget entry not found',
    );
    const merged = { ...existing, ...dto };
    this.assertExactlyOneTarget(merged.plan_id, merged.task_id);
    await this.assertBudgetTargetAccess(
      existing.plan_id,
      existing.task_id,
      organizationId,
      actorUserId,
      'write',
    );

    const { data, error } = await this.client
      .from('resource_budget_entries')
      .update({
        entry_type: merged.entry_type,
        name: merged.name.trim(),
        category: merged.category?.trim() || null,
        cost_category_id: merged.cost_category_id ?? null,
        quantity: merged.quantity,
        unit_cost: merged.unit_cost,
        currency: merged.currency.trim().toUpperCase(),
        effective_date: merged.effective_date,
        start_date: merged.start_date ?? null,
        end_date: merged.end_date ?? null,
        aggregation: merged.aggregation ?? 'manual',
        notes: merged.notes?.trim() || null,
        updated_by: actorUserId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select('*')
      .single();
    this.throwWriteError(error);
    return data as BudgetEntryRow;
  }

  async deleteBudgetEntry(
    id: string,
    organizationId: string,
    actorUserId: string,
  ) {
    await this.assertModuleEnabled(organizationId);
    const existing = await this.findById<BudgetEntryRow>(
      'resource_budget_entries',
      id,
      organizationId,
      'Budget entry not found',
    );
    await this.assertBudgetTargetAccess(
      existing.plan_id,
      existing.task_id,
      organizationId,
      actorUserId,
      'write',
    );
    const { error } = await this.client
      .from('resource_budget_entries')
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);
    this.throwWriteError(error);
  }

  private async assertUnit(
    id: string,
    organizationId: string,
  ): Promise<OrganizationUnitRow> {
    return this.findById<OrganizationUnitRow>(
      'organization_units',
      id,
      organizationId,
      'Organization unit not found',
    );
  }

  private async assertLeafUnit(id: string, organizationId: string) {
    const unit = await this.assertUnit(id, organizationId);
    if (!unit.is_active) throw new BadRequestException('Unit is archived');
    const { data, error } = await this.client
      .from('organization_units')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('parent_id', id)
      .limit(1);
    if (error) throw new InternalServerErrorException(error.message);
    if ((data ?? []).length > 0) {
      throw new BadRequestException('Users can only belong to leaf units');
    }
  }

  private async assertUnitHasNoMembershipHistory(
    id: string,
    organizationId: string,
  ) {
    const { data, error } = await this.client
      .from('organization_unit_memberships')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('unit_id', id)
      .limit(1);
    if (error) throw new InternalServerErrorException(error.message);
    if ((data ?? []).length > 0) {
      throw new ConflictException(
        'A unit with membership history must remain a leaf',
      );
    }
  }

  /**
   * Same two conditions archiveUnit enforces inline, for the PATCH is_active path.
   * Kept separate so archiveUnit's existing behaviour stays byte-for-byte unchanged.
   */
  private async assertUnitArchivable(id: string, organizationId: string) {
    const { data: children, error: childError } = await this.client
      .from('organization_units')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('parent_id', id)
      .limit(1);
    if (childError) throw new InternalServerErrorException(childError.message);
    if ((children ?? []).length > 0) {
      throw new ConflictException('Archive child units first');
    }

    const today = new Date().toISOString().slice(0, 10);
    const { data: memberships, error: memberError } = await this.client
      .from('organization_unit_memberships')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('unit_id', id)
      .or(`effective_to.is.null,effective_to.gte.${today}`)
      .limit(1);
    if (memberError)
      throw new InternalServerErrorException(memberError.message);
    if ((memberships ?? []).length > 0) {
      throw new ConflictException('End active memberships before archiving');
    }
  }

  private async assertNoHierarchyCycle(
    unitId: string,
    parentId: string | null,
    organizationId: string,
  ) {
    if (!parentId) return;
    const { data, error } = await this.client
      .from('organization_units')
      .select('id, parent_id')
      .eq('organization_id', organizationId);
    if (error) throw new InternalServerErrorException(error.message);

    const parents = new Map(
      ((data ?? []) as Array<{ id: string; parent_id: string | null }>).map(
        (row) => [row.id, row.parent_id],
      ),
    );
    let cursor: string | null = parentId;
    const visited = new Set<string>();
    while (cursor) {
      if (cursor === unitId) {
        throw new BadRequestException('Unit hierarchy cannot contain a cycle');
      }
      if (visited.has(cursor)) {
        throw new InternalServerErrorException(
          'Existing organization unit hierarchy contains a cycle',
        );
      }
      visited.add(cursor);
      cursor = parents.get(cursor) ?? null;
    }
  }

  /**
   * `unitId`, when provided, scopes the overlap check to that specific unit —
   * Resource Planning 2.0's multi-team support: a user may hold several
   * simultaneous memberships across DIFFERENT units, so the app-level guard
   * must match the DB's `organization_unit_memberships_no_unit_overlap`
   * exclusion constraint exactly (org + unit + user + daterange), not the
   * older org + user rule. Only ever pass `unitId` for the
   * organization_unit_memberships table — employee_capacity_periods has no
   * unit concept and must keep the one-active-period-per-user rule unchanged.
   */
  private async assertNoPeriodOverlap(options: {
    table: 'organization_unit_memberships' | 'employee_capacity_periods';
    organizationId: string;
    userId: string;
    effectiveFrom: string;
    effectiveTo?: string | null;
    excludeId?: string;
    onlyActive?: boolean;
    unitId?: string;
  }) {
    const {
      table,
      organizationId,
      userId,
      effectiveFrom,
      effectiveTo,
      excludeId,
      onlyActive = false,
      unitId,
    } = options;
    let query = this.client
      .from(table)
      .select('id')
      .eq('organization_id', organizationId)
      .eq('user_id', userId)
      .lte('effective_from', effectiveTo ?? '9999-12-31')
      .or(`effective_to.is.null,effective_to.gte.${effectiveFrom}`);
    if (excludeId) query = query.neq('id', excludeId);
    if (onlyActive) query = query.eq('is_active', true);
    if (table === 'organization_unit_memberships' && unitId) {
      query = query.eq('unit_id', unitId);
    }
    const { data, error } = await query.limit(1);
    if (error) throw new InternalServerErrorException(error.message);
    if ((data ?? []).length > 0) {
      throw new ConflictException(
        table === 'organization_unit_memberships'
          ? 'This user already belongs to this unit over an overlapping date range'
          : 'This user already has an overlapping active capacity period',
      );
    }
  }

  private async assertBudgetTargetAccess(
    planId: string | null,
    taskId: string | null,
    organizationId: string,
    userId: string,
    level: 'view' | 'write',
  ) {
    if (planId) {
      await this.resourcePlanningService.assertPlanAccess(
        planId,
        organizationId,
        userId,
        level === 'view' ? 'view' : 'edit',
      );
    } else if (taskId) {
      await this.resourcePlanningService.assertTaskAccess(
        taskId,
        organizationId,
        userId,
        level,
      );
    }
  }

  private assertExactlyOneTarget(
    planId?: string | null,
    taskId?: string | null,
  ) {
    if (Boolean(planId) === Boolean(taskId)) {
      throw new BadRequestException(
        'Exactly one of plan_id or task_id is required',
      );
    }
  }

  private assertQueryRange(from?: string, to?: string) {
    if (from && to) assertEffectiveDateRange(from, to);
  }

  private async findById<T>(
    table: string,
    id: string,
    organizationId: string,
    message: string,
  ): Promise<T> {
    const { data, error } = await this.client
      .from(table)
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (error) throw new InternalServerErrorException(error.message);
    if (!data) throw new NotFoundException(message);
    return data as T;
  }

  private async deleteById(
    table: string,
    id: string,
    organizationId: string,
    message: string,
  ) {
    await this.assertModuleEnabled(organizationId);
    await this.findById(table, id, organizationId, message);
    const { error } = await this.client
      .from(table)
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);
    this.throwWriteError(error);
  }

  private throwWriteError(
    error: { code?: string; message: string } | null,
    conflictMessage?: string,
  ): void {
    if (!error) return;
    if (error.code === '23505' || error.code === '23P01') {
      throw new ConflictException(conflictMessage ?? error.message);
    }
    throw new BadRequestException(error.message);
  }
}
