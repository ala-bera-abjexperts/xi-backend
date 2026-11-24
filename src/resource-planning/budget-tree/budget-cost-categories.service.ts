/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/**
 * @fileoverview CRUD for the Resource Planning 2.0 cost-category catalog, plus
 * an explicit "seed defaults" action. Categories are never auto-created on a
 * GET — a user must explicitly request the default RC/NRC set.
 * @module src/resource-planning/budget-tree/budget-cost-categories.service
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type {
  CreateBudgetCostCategoryDto,
  UpdateBudgetCostCategoryDto,
} from './dto/budget-cost-category.dto';
import type { BudgetCostCategoryRow } from './budget-tree.types';

/** Matches the reference screenshots' RC/NRC vertical category list. */
const DEFAULT_CATEGORIES: Array<
  Pick<
    CreateBudgetCostCategoryDto,
    'code' | 'label' | 'cost_group' | 'sort_order'
  >
> = [
  { code: 'RC', label: 'RC', cost_group: 'RC', sort_order: 10 },
  { code: 'EEE_RC', label: 'EEE RC', cost_group: 'RC', sort_order: 20 },
  { code: 'EM_RC', label: 'EM RC', cost_group: 'RC', sort_order: 30 },
  { code: 'EMP_RC', label: 'EMP RC', cost_group: 'RC', sort_order: 40 },
  { code: 'ESW_RC', label: 'ESW RC', cost_group: 'RC', sort_order: 50 },
  { code: 'MAW_RC', label: 'MAW RC', cost_group: 'RC', sort_order: 60 },
  { code: 'PSE_RC', label: 'PSE RC', cost_group: 'RC', sort_order: 70 },
  { code: 'SI_RC', label: 'SI RC', cost_group: 'RC', sort_order: 80 },
  {
    code: 'MATERIAL_RC',
    label: 'Material RC',
    cost_group: 'RC',
    sort_order: 90,
  },
  { code: 'AV_RC', label: 'AV RC', cost_group: 'RC', sort_order: 100 },
  { code: 'NRC', label: 'NRC', cost_group: 'NRC', sort_order: 110 },
  { code: 'AV_NRC', label: 'AV NRC', cost_group: 'NRC', sort_order: 120 },
  { code: 'EEE_NRC', label: 'EEE NRC', cost_group: 'NRC', sort_order: 130 },
  { code: 'EM_NRC', label: 'EM NRC', cost_group: 'NRC', sort_order: 140 },
  { code: 'EMP_NRC', label: 'EMP NRC', cost_group: 'NRC', sort_order: 150 },
  { code: 'ESW_NRC', label: 'ESW NRC', cost_group: 'NRC', sort_order: 160 },
  { code: 'MAW_NRC', label: 'MAW NRC', cost_group: 'NRC', sort_order: 170 },
  { code: 'PSE_NRC', label: 'PSE NRC', cost_group: 'NRC', sort_order: 180 },
  { code: 'SI_NRC', label: 'SI NRC', cost_group: 'NRC', sort_order: 190 },
  {
    code: 'MATERIAL_NRC',
    label: 'Material NRC',
    cost_group: 'NRC',
    sort_order: 200,
  },
];

@Injectable()
export class BudgetCostCategoriesService {
  private get client() {
    return this.supabaseAdmin.getClient();
  }

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly orgModulesService: OrganizationModulesService,
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

  private throwWriteError(
    error: { code?: string; message: string } | null,
    conflictMessage?: string,
  ): void {
    if (!error) return;
    if (error.code === '23505' || error.code === '23P01') {
      throw new ConflictException(conflictMessage ?? error.message);
    }
    if (error.code === '23503') {
      throw new ConflictException(
        'This category is still referenced by a budget entry',
      );
    }
    throw new BadRequestException(error.message);
  }

  async list(
    organizationId: string,
    includeInactive = false,
  ): Promise<BudgetCostCategoryRow[]> {
    await this.assertModuleEnabled(organizationId);
    let query = this.client
      .from('budget_cost_categories')
      .select('*')
      .eq('organization_id', organizationId);
    if (!includeInactive) query = query.eq('is_active', true);
    const { data, error } = await query.order('sort_order', {
      ascending: true,
    });
    if (error) throw new InternalServerErrorException(error.message);
    return (data ?? []) as BudgetCostCategoryRow[];
  }

  async create(
    organizationId: string,
    actorUserId: string,
    dto: CreateBudgetCostCategoryDto,
  ): Promise<BudgetCostCategoryRow> {
    await this.assertModuleEnabled(organizationId);
    const { data, error } = await this.client
      .from('budget_cost_categories')
      .insert({
        organization_id: organizationId,
        code: dto.code.trim().toUpperCase(),
        label: dto.label.trim(),
        cost_group: dto.cost_group ?? 'OTHER',
        sort_order: dto.sort_order ?? 0,
        color: dto.color ?? null,
        is_active: dto.is_active ?? true,
        created_by: actorUserId,
        updated_by: actorUserId,
      })
      .select('*')
      .single();
    this.throwWriteError(error, 'A category with this code already exists');
    return data as BudgetCostCategoryRow;
  }

  async update(
    id: string,
    organizationId: string,
    actorUserId: string,
    dto: UpdateBudgetCostCategoryDto,
  ): Promise<BudgetCostCategoryRow> {
    await this.assertModuleEnabled(organizationId);
    const { data: existing, error: findError } = await this.client
      .from('budget_cost_categories')
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (findError) throw new InternalServerErrorException(findError.message);
    if (!existing) throw new NotFoundException('Cost category not found');

    const { data, error } = await this.client
      .from('budget_cost_categories')
      .update({
        ...dto,
        code: dto.code ? dto.code.trim().toUpperCase() : undefined,
        label: dto.label ? dto.label.trim() : undefined,
        updated_by: actorUserId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select('*')
      .single();
    this.throwWriteError(error, 'A category with this code already exists');
    return data as BudgetCostCategoryRow;
  }

  async deactivate(
    id: string,
    organizationId: string,
    actorUserId: string,
  ): Promise<BudgetCostCategoryRow> {
    await this.assertModuleEnabled(organizationId);
    const { data, error } = await this.client
      .from('budget_cost_categories')
      .update({
        is_active: false,
        updated_by: actorUserId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select('*')
      .maybeSingle();
    if (error) throw new InternalServerErrorException(error.message);
    if (!data) throw new NotFoundException('Cost category not found');
    return data as BudgetCostCategoryRow;
  }

  /**
   * Inserts the default RC/NRC category set for categories that don't already
   * exist by code (case-insensitive) — idempotent, safe to call repeatedly.
   * Never called automatically; only from an explicit user action.
   */
  async seedDefaults(
    organizationId: string,
    actorUserId: string,
  ): Promise<BudgetCostCategoryRow[]> {
    await this.assertModuleEnabled(organizationId);
    const { data: existingRows, error: listError } = await this.client
      .from('budget_cost_categories')
      .select('code')
      .eq('organization_id', organizationId);
    if (listError) throw new InternalServerErrorException(listError.message);
    const existingCodes = new Set(
      ((existingRows ?? []) as Array<{ code: string }>).map((row) =>
        row.code.toUpperCase(),
      ),
    );

    const toInsert = DEFAULT_CATEGORIES.filter(
      (category) => !existingCodes.has(category.code.toUpperCase()),
    ).map((category) => ({
      organization_id: organizationId,
      code: category.code,
      label: category.label,
      cost_group: category.cost_group,
      sort_order: category.sort_order,
      is_active: true,
      created_by: actorUserId,
      updated_by: actorUserId,
    }));

    if (toInsert.length === 0) return this.list(organizationId, true);

    const { error } = await this.client
      .from('budget_cost_categories')
      .insert(toInsert);
    this.throwWriteError(error);
    return this.list(organizationId, true);
  }
}
