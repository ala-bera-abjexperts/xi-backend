/**
 * @fileoverview Service for managing space-level entity overrides.
 * Handles priority, status, and custom_field overrides per space.
 * Tables: space_priority_overrides, space_status_overrides, space_custom_field_overrides
 * @module src/space-overrides/space-overrides.service
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { SetSpaceOverrideDto } from './dto/set-space-override.dto';

type OverrideType = 'priority' | 'status' | 'custom_field';

const OVERRIDE_CONFIG: Record<
  OverrideType,
  {
    table: string;
    entityColumn: string;
    conflictKey: string;
    targetTable: string;
    targetName: string;
  }
> = {
  priority: {
    table: 'space_priority_overrides',
    entityColumn: 'priority_id',
    conflictKey: 'space_id,priority_id',
    targetTable: 'task_priorities',
    targetName: 'Task priority',
  },
  status: {
    table: 'space_status_overrides',
    entityColumn: 'status_id',
    conflictKey: 'space_id,status_id',
    targetTable: 'task_statuses',
    targetName: 'Task status',
  },
  custom_field: {
    table: 'space_custom_field_overrides',
    entityColumn: 'custom_field_id',
    conflictKey: 'space_id,custom_field_id',
    targetTable: 'custom_fields',
    targetName: 'Custom field',
  },
};

@Injectable()
export class SpaceOverridesService {
  private readonly logger = new Logger(SpaceOverridesService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    @Optional() private readonly auditLogsService?: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async getOverrides(
    organizationId: string,
    spaceId: string,
    type: OverrideType,
  ): Promise<Record<string, boolean>> {
    const config = OVERRIDE_CONFIG[type];

    await this.assertSpaceInOrganization(organizationId, spaceId);

    const { data, error } = await this.client
      .from(config.table)
      .select(`${config.entityColumn}, is_enabled`)
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId);

    if (error) {
      this.logger.error(
        `Failed to fetch ${type} overrides for space ${spaceId}:`,
        error,
      );
      throw new BadRequestException('Failed to fetch space overrides');
    }

    const overrides: Record<string, boolean> = {};
    for (const row of (data as unknown as Array<Record<string, unknown>>) ||
      []) {
      const entityId = row[config.entityColumn] as string;
      overrides[entityId] = row['is_enabled'] as boolean;
    }

    return overrides;
  }

  async setOverride(
    organizationId: string,
    actorUserId: string,
    dto: SetSpaceOverrideDto,
  ): Promise<void> {
    const config = OVERRIDE_CONFIG[dto.type];

    await this.assertSpaceInOrganization(organizationId, dto.spaceId);
    await this.assertEntityVisibleInSpace(organizationId, dto);

    const { error } = await this.client.from(config.table).upsert(
      {
        space_id: dto.spaceId,
        [config.entityColumn]: dto.entityId,
        organization_id: organizationId,
        is_enabled: dto.isEnabled,
        updated_at: new Date().toISOString(),
      },
      { onConflict: config.conflictKey },
    );

    if (error) {
      this.logger.error(`Failed to set ${dto.type} override:`, error);
      throw new BadRequestException('Failed to set space override');
    }

    this.logAudit(organizationId, actorUserId, dto);
  }

  private async assertSpaceInOrganization(
    organizationId: string,
    spaceId: string,
  ): Promise<void> {
    const { data, error } = await this.client
      .from('spaces')
      .select('id')
      .eq('id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Space not found');
  }

  private async assertEntityVisibleInSpace(
    organizationId: string,
    dto: SetSpaceOverrideDto,
  ): Promise<void> {
    const config = OVERRIDE_CONFIG[dto.type];

    const soResult = (await this.client
      .from(config.targetTable)
      .select('*')
      .eq('id', dto.entityId)
      .eq('organization_id', organizationId)
      .maybeSingle()) as {
      data: Record<string, unknown> | null;
      error: { message: string } | null;
    };

    if (soResult.error) throw new BadRequestException(soResult.error.message);
    if (!soResult.data)
      throw new NotFoundException(`${config.targetName} not found`);

    const entity = soResult.data as unknown as {
      id: string;
      organization_id: string;
      space_id: string | null;
      is_deleted?: boolean | null;
    };

    if (entity.is_deleted === true) {
      throw new BadRequestException(`${config.targetName} is deleted`);
    }

    if (entity.space_id && entity.space_id !== dto.spaceId) {
      throw new BadRequestException(
        `${config.targetName} belongs to a different space`,
      );
    }
  }

  private logAudit(
    organizationId: string,
    actorUserId: string | null | undefined,
    dto: SetSpaceOverrideDto,
  ): void {
    if (!actorUserId || !this.auditLogsService) return;

    void this.auditLogsService.logAction(
      organizationId,
      actorUserId,
      'space_override',
      dto.entityId,
      'update',
      {
        space_id: dto.spaceId,
        type: dto.type,
        entity_id: dto.entityId,
        is_enabled: dto.isEnabled,
      },
    );
  }
}
