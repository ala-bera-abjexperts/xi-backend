/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/**
 * @fileoverview Org-level Planning roster: the employees listed under
 * Resource Planning > Capacity and rates. Listing and adding go through the
 * resource_planning_roster_list / resource_planning_roster_add SQL functions
 * (membership and deactivation checks live there); removal is a plain delete.
 * The client is service-role, so every call is scoped to the caller's
 * organization here.
 * @module src/resource-planning/roster/planning-roster.service
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import {
  PLANNING_ROSTER_DEFAULT_LIMIT,
  type ListPlanningRosterQueryDto,
} from './dto/planning-roster.dto';

const ROSTER_TABLE = 'resource_planning_roster';

export interface PlanningRosterCapacity {
  weekly_capacity_hours: number;
  cost_rate: number | null;
  currency: string | null;
  is_active: boolean;
}

export interface PlanningRosterEntry {
  user_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
  is_active: boolean;
  added_at: string;
  /** Null when the employee has no employee_capacity row yet. */
  capacity: PlanningRosterCapacity | null;
}

export interface PlanningRosterListResult {
  data: PlanningRosterEntry[];
  count: number;
  page: number;
  limit: number;
}

export interface PlanningRosterAddResult {
  added: number;
  already_listed: number;
  deactivated: number;
  not_member: number;
}

/** Row shape of resource_planning_roster_list; numerics may arrive as strings. */
interface PlanningRosterListRow {
  user_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
  is_active: boolean;
  added_at: string;
  weekly_capacity_hours: number | string | null;
  cost_rate: number | string | null;
  currency: string | null;
  capacity_is_active: boolean | null;
  total_count?: number | string;
}

interface PlanningRosterAddRpcResult {
  added: number;
  already_listed: number;
  deactivated: number;
  not_member: number;
  added_user_ids: string[];
}

@Injectable()
export class PlanningRosterService {
  private get client() {
    return this.supabaseAdmin.getClient();
  }

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly orgModulesService: OrganizationModulesService,
    private readonly auditLogs: AuditLogsService,
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

  async list(
    organizationId: string,
    query: ListPlanningRosterQueryDto,
  ): Promise<PlanningRosterListResult> {
    await this.assertModuleEnabled(organizationId);
    const page = query.page ?? 1;
    const limit = query.limit ?? PLANNING_ROSTER_DEFAULT_LIMIT;

    const { data, error } = await this.client.rpc(
      'resource_planning_roster_list',
      {
        p_organization_id: organizationId,
        p_search: query.search || null,
        p_limit: limit,
        p_offset: (page - 1) * limit,
      },
    );
    if (error) throw new InternalServerErrorException(error.message);

    const rows = (data ?? []) as PlanningRosterListRow[];
    return {
      data: rows.map((row) => ({
        user_id: row.user_id,
        email: row.email,
        first_name: row.first_name,
        last_name: row.last_name,
        avatar_url: row.avatar_url,
        is_active: row.is_active,
        added_at: row.added_at,
        capacity:
          row.capacity_is_active === null
            ? null
            : {
                weekly_capacity_hours: Number(row.weekly_capacity_hours),
                cost_rate:
                  row.cost_rate === null ? null : Number(row.cost_rate),
                currency: row.currency,
                is_active: row.capacity_is_active,
              },
      })),
      count: Number(rows[0]?.total_count ?? 0),
      page,
      limit,
    };
  }

  async addUsers(
    user: RequestUser,
    userIds: string[],
  ): Promise<PlanningRosterAddResult> {
    return this.add(user, userIds, null);
  }

  async addGroup(
    user: RequestUser,
    groupId: string,
  ): Promise<PlanningRosterAddResult> {
    return this.add(user, null, groupId);
  }

  async remove(
    user: RequestUser,
    targetUserId: string,
  ): Promise<{ removed: boolean }> {
    await this.assertModuleEnabled(user.organizationId);

    const { data, error } = await this.client
      .from(ROSTER_TABLE)
      .delete()
      .eq('organization_id', user.organizationId)
      .eq('user_id', targetUserId)
      .select('user_id');
    if (error) throw new InternalServerErrorException(error.message);

    const removed = ((data ?? []) as { user_id: string }[]).length > 0;
    if (removed) {
      void this.auditLogs.logActionForRequest(
        user,
        ROSTER_TABLE,
        user.organizationId,
        'delete',
        { user_id: targetUserId },
      );
    }
    return { removed };
  }

  /** Exactly one of userIds / groupId is non-null; the SQL function enforces it too. */
  private async add(
    user: RequestUser,
    userIds: string[] | null,
    groupId: string | null,
  ): Promise<PlanningRosterAddResult> {
    await this.assertModuleEnabled(user.organizationId);

    const { data, error } = await this.client.rpc(
      'resource_planning_roster_add',
      {
        p_organization_id: user.organizationId,
        p_added_by: user.userId,
        p_user_ids: userIds,
        p_group_id: groupId,
      },
    );
    if (error) this.throwAddError(error);

    const rpcResult = data as PlanningRosterAddRpcResult;
    const result: PlanningRosterAddResult = {
      added: Number(rpcResult.added),
      already_listed: Number(rpcResult.already_listed),
      deactivated: Number(rpcResult.deactivated),
      not_member: Number(rpcResult.not_member),
    };

    if (result.added > 0) {
      void this.auditLogs.logActionForRequest(
        user,
        ROSTER_TABLE,
        user.organizationId,
        'create',
        {
          source: groupId ? 'group' : 'users',
          ...(groupId ? { group_id: groupId } : {}),
          added_user_ids: rpcResult.added_user_ids,
          already_listed: result.already_listed,
          deactivated: result.deactivated,
          not_member: result.not_member,
        },
      );
    }
    return result;
  }

  private throwAddError(error: { code?: string; message: string }): never {
    // P0002: group missing/deleted in this org; 23503: membership trigger
    // fired because a user left the org mid-call; 22023: bad arguments.
    if (error.code === 'P0002') {
      throw new NotFoundException('User group not found');
    }
    if (error.code === '23503') {
      throw new ConflictException(
        'An employee is no longer a member of this organization',
      );
    }
    if (error.code === '22023') throw new BadRequestException(error.message);
    throw new InternalServerErrorException(error.message);
  }
}
