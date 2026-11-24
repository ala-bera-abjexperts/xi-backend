/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/**
 * @fileoverview CRUD for Resource Planning 2.0 workload and holiday schemes.
 * Distinct from working-calendar.service.ts, which is the read-only resolver
 * used internally by capacity/report math — this service is what the settings
 * UI calls to create/manage schemes. Mirrors the CRUD conventions established
 * in resource-planning-core.service.ts (assertModuleEnabled guard, findById /
 * throwWriteError helpers, archive blocked while members exist).
 * @module src/resource-planning/calendar/calendar-admin.service
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
import { ResourcePlanningService } from '../resource-planning.service';
import type {
  CreateHolidaySchemeDayDto,
  UpdateHolidaySchemeDayDto,
} from './dto/holiday-scheme-day.dto';
import { assertHolidaySchemeDayShape } from './dto/holiday-scheme-day.dto';
import type { AssignHolidaySchemeMemberDto } from './dto/holiday-scheme-member.dto';
import type {
  CreateHolidaySchemeDto,
  UpdateHolidaySchemeDto,
} from './dto/holiday-scheme.dto';
import type { AssignWorkloadSchemeMemberDto } from './dto/workload-scheme-member.dto';
import type {
  CreateWorkloadSchemeDto,
  UpdateWorkloadSchemeDto,
} from './dto/workload-scheme.dto';
import type {
  HolidaySchemeDayRow,
  HolidaySchemeMemberRow,
  HolidaySchemeRow,
  WorkloadSchemeMemberRow,
  WorkloadSchemeRow,
} from './calendar-admin.types';

@Injectable()
export class CalendarAdminService {
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

  // ==========================================================================
  // Workload schemes
  // ==========================================================================

  async listWorkloadSchemes(
    organizationId: string,
    includeInactive = false,
  ): Promise<WorkloadSchemeRow[]> {
    await this.assertModuleEnabled(organizationId);
    let query = this.client
      .from('workload_schemes')
      .select('*')
      .eq('organization_id', organizationId);
    if (!includeInactive) query = query.eq('is_active', true);
    const { data, error } = await query.order('name', { ascending: true });
    if (error) throw new InternalServerErrorException(error.message);
    return (data ?? []) as WorkloadSchemeRow[];
  }

  async createWorkloadScheme(
    organizationId: string,
    actorUserId: string,
    dto: CreateWorkloadSchemeDto,
  ): Promise<WorkloadSchemeRow> {
    await this.assertModuleEnabled(organizationId);
    const { data, error } = await this.client
      .from('workload_schemes')
      .insert({
        organization_id: organizationId,
        name: dto.name,
        description: dto.description ?? null,
        monday_hours: dto.monday_hours ?? 8,
        tuesday_hours: dto.tuesday_hours ?? 8,
        wednesday_hours: dto.wednesday_hours ?? 8,
        thursday_hours: dto.thursday_hours ?? 8,
        friday_hours: dto.friday_hours ?? 8,
        saturday_hours: dto.saturday_hours ?? 0,
        sunday_hours: dto.sunday_hours ?? 0,
        is_default: dto.is_default ?? false,
        is_active: dto.is_active ?? true,
        created_by: actorUserId,
        updated_by: actorUserId,
      })
      .select('*')
      .single();
    this.throwWriteError(
      error,
      'A workload scheme with this name already exists',
    );
    return data as WorkloadSchemeRow;
  }

  async updateWorkloadScheme(
    id: string,
    organizationId: string,
    actorUserId: string,
    dto: UpdateWorkloadSchemeDto,
  ): Promise<WorkloadSchemeRow> {
    await this.assertModuleEnabled(organizationId);
    await this.findById(
      'workload_schemes',
      id,
      organizationId,
      'Workload scheme not found',
    );
    const { data, error } = await this.client
      .from('workload_schemes')
      .update({
        ...dto,
        updated_by: actorUserId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select('*')
      .single();
    this.throwWriteError(
      error,
      'A workload scheme with this name already exists',
    );
    return data as WorkloadSchemeRow;
  }

  /** Blocked while any member is currently assigned — mirrors archiveUnit's guard. */
  async deactivateWorkloadScheme(
    id: string,
    organizationId: string,
    actorUserId: string,
  ): Promise<WorkloadSchemeRow> {
    await this.assertModuleEnabled(organizationId);
    await this.findById(
      'workload_schemes',
      id,
      organizationId,
      'Workload scheme not found',
    );
    const { data: members, error: memberError } = await this.client
      .from('workload_scheme_members')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('scheme_id', id)
      .limit(1);
    if (memberError)
      throw new InternalServerErrorException(memberError.message);
    if ((members ?? []).length > 0) {
      throw new ConflictException(
        'Reassign every member off this scheme before deactivating it',
      );
    }
    const { data, error } = await this.client
      .from('workload_schemes')
      .update({
        is_active: false,
        is_default: false,
        updated_by: actorUserId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select('*')
      .single();
    this.throwWriteError(error);
    return data as WorkloadSchemeRow;
  }

  async listWorkloadSchemeMembers(
    organizationId: string,
  ): Promise<WorkloadSchemeMemberRow[]> {
    await this.assertModuleEnabled(organizationId);
    const { data, error } = await this.client
      .from('workload_scheme_members')
      .select('*')
      .eq('organization_id', organizationId);
    if (error) throw new InternalServerErrorException(error.message);
    return (data ?? []) as WorkloadSchemeMemberRow[];
  }

  async assignWorkloadSchemeMember(
    organizationId: string,
    actorUserId: string,
    dto: AssignWorkloadSchemeMemberDto,
  ): Promise<WorkloadSchemeMemberRow> {
    await this.assertModuleEnabled(organizationId);
    await this.resourcePlanningService.assertOrganizationMember(
      organizationId,
      dto.user_id,
    );
    await this.findById(
      'workload_schemes',
      dto.scheme_id,
      organizationId,
      'Workload scheme not found',
    );
    const { data, error } = await this.client
      .from('workload_scheme_members')
      .upsert(
        {
          organization_id: organizationId,
          scheme_id: dto.scheme_id,
          user_id: dto.user_id,
          created_by: actorUserId,
          updated_by: actorUserId,
        },
        { onConflict: 'organization_id,user_id' },
      )
      .select('*')
      .single();
    this.throwWriteError(error);
    return data as WorkloadSchemeMemberRow;
  }

  async removeWorkloadSchemeMember(id: string, organizationId: string) {
    await this.assertModuleEnabled(organizationId);
    await this.findById(
      'workload_scheme_members',
      id,
      organizationId,
      'Workload scheme member not found',
    );
    const { error } = await this.client
      .from('workload_scheme_members')
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);
    this.throwWriteError(error);
  }

  // ==========================================================================
  // Holiday schemes
  // ==========================================================================

  async listHolidaySchemes(
    organizationId: string,
    includeInactive = false,
  ): Promise<HolidaySchemeRow[]> {
    await this.assertModuleEnabled(organizationId);
    let query = this.client
      .from('holiday_schemes')
      .select('*')
      .eq('organization_id', organizationId);
    if (!includeInactive) query = query.eq('is_active', true);
    const { data, error } = await query.order('name', { ascending: true });
    if (error) throw new InternalServerErrorException(error.message);
    return (data ?? []) as HolidaySchemeRow[];
  }

  async createHolidayScheme(
    organizationId: string,
    actorUserId: string,
    dto: CreateHolidaySchemeDto,
  ): Promise<HolidaySchemeRow> {
    await this.assertModuleEnabled(organizationId);
    const { data, error } = await this.client
      .from('holiday_schemes')
      .insert({
        organization_id: organizationId,
        name: dto.name,
        description: dto.description ?? null,
        is_default: dto.is_default ?? false,
        is_active: dto.is_active ?? true,
        created_by: actorUserId,
        updated_by: actorUserId,
      })
      .select('*')
      .single();
    this.throwWriteError(
      error,
      'A holiday scheme with this name already exists',
    );
    return data as HolidaySchemeRow;
  }

  async updateHolidayScheme(
    id: string,
    organizationId: string,
    actorUserId: string,
    dto: UpdateHolidaySchemeDto,
  ): Promise<HolidaySchemeRow> {
    await this.assertModuleEnabled(organizationId);
    await this.findById(
      'holiday_schemes',
      id,
      organizationId,
      'Holiday scheme not found',
    );
    const { data, error } = await this.client
      .from('holiday_schemes')
      .update({
        ...dto,
        updated_by: actorUserId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select('*')
      .single();
    this.throwWriteError(
      error,
      'A holiday scheme with this name already exists',
    );
    return data as HolidaySchemeRow;
  }

  async deactivateHolidayScheme(
    id: string,
    organizationId: string,
    actorUserId: string,
  ): Promise<HolidaySchemeRow> {
    await this.assertModuleEnabled(organizationId);
    await this.findById(
      'holiday_schemes',
      id,
      organizationId,
      'Holiday scheme not found',
    );
    const { data: members, error: memberError } = await this.client
      .from('holiday_scheme_members')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('scheme_id', id)
      .limit(1);
    if (memberError)
      throw new InternalServerErrorException(memberError.message);
    if ((members ?? []).length > 0) {
      throw new ConflictException(
        'Reassign every member off this scheme before deactivating it',
      );
    }
    const { data, error } = await this.client
      .from('holiday_schemes')
      .update({
        is_active: false,
        is_default: false,
        updated_by: actorUserId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select('*')
      .single();
    this.throwWriteError(error);
    return data as HolidaySchemeRow;
  }

  async listHolidaySchemeDays(
    organizationId: string,
    schemeId?: string,
  ): Promise<HolidaySchemeDayRow[]> {
    await this.assertModuleEnabled(organizationId);
    let query = this.client
      .from('holiday_scheme_days')
      .select('*')
      .eq('organization_id', organizationId);
    if (schemeId) query = query.eq('scheme_id', schemeId);
    const { data, error } = await query.order('name', { ascending: true });
    if (error) throw new InternalServerErrorException(error.message);
    return (data ?? []) as HolidaySchemeDayRow[];
  }

  async createHolidaySchemeDay(
    organizationId: string,
    actorUserId: string,
    dto: CreateHolidaySchemeDayDto,
  ): Promise<HolidaySchemeDayRow> {
    await this.assertModuleEnabled(organizationId);
    assertHolidaySchemeDayShape(dto);
    await this.findById(
      'holiday_schemes',
      dto.scheme_id,
      organizationId,
      'Holiday scheme not found',
    );
    const { data, error } = await this.client
      .from('holiday_scheme_days')
      .insert({
        organization_id: organizationId,
        scheme_id: dto.scheme_id,
        name: dto.name,
        description: dto.description ?? null,
        recurrence: dto.recurrence,
        month: dto.recurrence === 'fixed_annual' ? dto.month : null,
        day: dto.recurrence === 'fixed_annual' ? dto.day : null,
        holiday_date: dto.recurrence === 'one_off' ? dto.holiday_date : null,
        duration_days: dto.duration_days ?? 1,
        created_by: actorUserId,
        updated_by: actorUserId,
      })
      .select('*')
      .single();
    this.throwWriteError(error);
    return data as HolidaySchemeDayRow;
  }

  async updateHolidaySchemeDay(
    id: string,
    organizationId: string,
    actorUserId: string,
    dto: UpdateHolidaySchemeDayDto,
  ): Promise<HolidaySchemeDayRow> {
    await this.assertModuleEnabled(organizationId);
    const existing = await this.findById<HolidaySchemeDayRow>(
      'holiday_scheme_days',
      id,
      organizationId,
      'Holiday scheme day not found',
    );
    const merged = { ...existing, ...dto };
    assertHolidaySchemeDayShape(merged);
    const { data, error } = await this.client
      .from('holiday_scheme_days')
      .update({
        name: merged.name,
        description: merged.description ?? null,
        recurrence: merged.recurrence,
        month: merged.recurrence === 'fixed_annual' ? merged.month : null,
        day: merged.recurrence === 'fixed_annual' ? merged.day : null,
        holiday_date:
          merged.recurrence === 'one_off' ? merged.holiday_date : null,
        duration_days: merged.duration_days ?? 1,
        updated_by: actorUserId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select('*')
      .single();
    this.throwWriteError(error);
    return data as HolidaySchemeDayRow;
  }

  async deleteHolidaySchemeDay(id: string, organizationId: string) {
    await this.assertModuleEnabled(organizationId);
    await this.findById(
      'holiday_scheme_days',
      id,
      organizationId,
      'Holiday scheme day not found',
    );
    const { error } = await this.client
      .from('holiday_scheme_days')
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);
    this.throwWriteError(error);
  }

  async listHolidaySchemeMembers(
    organizationId: string,
  ): Promise<HolidaySchemeMemberRow[]> {
    await this.assertModuleEnabled(organizationId);
    const { data, error } = await this.client
      .from('holiday_scheme_members')
      .select('*')
      .eq('organization_id', organizationId);
    if (error) throw new InternalServerErrorException(error.message);
    return (data ?? []) as HolidaySchemeMemberRow[];
  }

  async assignHolidaySchemeMember(
    organizationId: string,
    actorUserId: string,
    dto: AssignHolidaySchemeMemberDto,
  ): Promise<HolidaySchemeMemberRow> {
    await this.assertModuleEnabled(organizationId);
    await this.resourcePlanningService.assertOrganizationMember(
      organizationId,
      dto.user_id,
    );
    await this.findById(
      'holiday_schemes',
      dto.scheme_id,
      organizationId,
      'Holiday scheme not found',
    );
    const { data, error } = await this.client
      .from('holiday_scheme_members')
      .upsert(
        {
          organization_id: organizationId,
          scheme_id: dto.scheme_id,
          user_id: dto.user_id,
          created_by: actorUserId,
          updated_by: actorUserId,
        },
        { onConflict: 'organization_id,user_id' },
      )
      .select('*')
      .single();
    this.throwWriteError(error);
    return data as HolidaySchemeMemberRow;
  }

  async removeHolidaySchemeMember(id: string, organizationId: string) {
    await this.assertModuleEnabled(organizationId);
    await this.findById(
      'holiday_scheme_members',
      id,
      organizationId,
      'Holiday scheme member not found',
    );
    const { error } = await this.client
      .from('holiday_scheme_members')
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);
    this.throwWriteError(error);
  }
}
