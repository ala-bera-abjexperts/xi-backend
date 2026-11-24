/**
 * @fileoverview CRUD for migration jobs (`migration_jobs`). A job is the saved
 * wizard output: connection + source ref + scope + options, `status`
 * 'draft' → 'ready'. Runs/execution land in later phases.
 *
 * Tenant integrity is enforced by hand (`organization_id` on every query —
 * the service-role client bypasses RLS) and cross-references (`connection_id`,
 * `target_space_id`) are verified to belong to the same organization before
 * any write, so a job can never point at another tenant's connection or space.
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { CreateMigrationJobDto } from '../dto/create-migration-job.dto';
import type { UpdateMigrationJobDto } from '../dto/update-migration-job.dto';

const TABLE = 'migration_jobs';

/**
 * Shape of a `migration_jobs` row. The service-role client is untyped
 * (returns `any`), so reads are cast to this interface — after which all
 * downstream access is type-checked.
 */
export interface MigrationJobRow {
  id: string;
  organization_id: string;
  connection_id: string;
  name: string;
  source_kind: 'jira_project' | 'confluence_space';
  source_ref: string;
  target_space_id: string | null;
  scope: Record<string, unknown>;
  options: Record<string, unknown>;
  status: 'draft' | 'ready';
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class MigrationJobsService {
  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  async list(orgId: string): Promise<MigrationJobRow[]> {
    const { data, error } = (await this.db
      .from(TABLE)
      .select('*')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })) as {
      data: MigrationJobRow[] | null;
      error: { message: string } | null;
    };

    if (error)
      throw new BadRequestException(`Failed to list jobs: ${error.message}`);

    return data ?? [];
  }

  async get(orgId: string, id: string): Promise<MigrationJobRow> {
    const { data, error } = (await this.db
      .from(TABLE)
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle()) as {
      data: MigrationJobRow | null;
      error: { message: string } | null;
    };

    if (error)
      throw new BadRequestException(`Failed to load job: ${error.message}`);
    if (!data) throw new NotFoundException('Migration job not found');

    return data;
  }

  async create(
    orgId: string,
    userId: string,
    dto: CreateMigrationJobDto,
  ): Promise<MigrationJobRow> {
    // Tenant integrity: the referenced connection (and target space, when
    // given) must belong to the caller's organization.
    await this.assertConnectionInOrg(orgId, dto.connection_id);

    if (dto.target_space_id) {
      await this.assertSpaceInOrg(orgId, dto.target_space_id);
    }

    const now = new Date().toISOString();

    const { data, error } = (await this.db
      .from(TABLE)
      .insert({
        organization_id: orgId,
        connection_id: dto.connection_id,
        name: dto.name,
        source_kind: dto.source_kind,
        source_ref: dto.source_ref,
        target_space_id: dto.target_space_id ?? null,
        scope: dto.scope as unknown as Record<string, unknown>,
        options: dto.options as unknown as Record<string, unknown>,
        status: 'draft',
        created_by: userId,
        created_at: now,
        updated_at: now,
      })
      .select('*')
      .single()) as {
      data: MigrationJobRow | null;
      error: { message: string; code?: string } | null;
    };

    if (error) {
      if (error.code === '23505')
        throw new ConflictException(
          `A migration job named "${dto.name}" already exists`,
        );

      throw new BadRequestException(`Failed to create job: ${error.message}`);
    }

    return data as MigrationJobRow;
  }

  /** 409 while the job has a run in flight — its config must stay stable for the whole run. */
  private async assertNoActiveRun(orgId: string, jobId: string): Promise<void> {
    const { data } = (await this.db
      .from('migration_runs')
      .select('id, status')
      .eq('organization_id', orgId)
      .eq('job_id', jobId)
      .in('status', ['queued', 'preflight', 'running', 'paused', 'sleeping'])
      .limit(1)) as { data: { id: string; status: string }[] | null };

    if (data && data.length > 0) {
      throw new ConflictException(
        `This migration has a run in progress (${data[0].status}) — pause or cancel it before changing its configuration`,
      );
    }
  }

  async update(
    orgId: string,
    id: string,
    dto: UpdateMigrationJobDto,
  ): Promise<MigrationJobRow> {
    await this.get(orgId, id);

    // Changing what a run migrates while it's mid-flight makes it unreproducible: stages that
    // haven't run yet would use the new scope/options while completed stages used the old ones.
    // Renaming is harmless, so only guard the fields that actually drive a run.
    if (
      dto.scope !== undefined ||
      dto.options !== undefined ||
      dto.target_space_id !== undefined
    ) {
      await this.assertNoActiveRun(orgId, id);
    }

    if (dto.target_space_id !== undefined) {
      await this.assertSpaceInOrg(orgId, dto.target_space_id);
    }

    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.target_space_id !== undefined)
      patch.target_space_id = dto.target_space_id;
    if (dto.scope !== undefined)
      patch.scope = dto.scope as unknown as Record<string, unknown>;
    if (dto.options !== undefined)
      patch.options = dto.options as unknown as Record<string, unknown>;
    if (dto.status !== undefined) patch.status = dto.status;

    const { data, error } = (await this.db
      .from(TABLE)
      .update(patch)
      .eq('organization_id', orgId)
      .eq('id', id)
      .select('*')
      .single()) as {
      data: MigrationJobRow | null;
      error: { message: string; code?: string } | null;
    };

    if (error) {
      if (error.code === '23505')
        throw new ConflictException(
          `A migration job named "${dto.name}" already exists`,
        );

      throw new BadRequestException(`Failed to update job: ${error.message}`);
    }

    return data as MigrationJobRow;
  }

  async remove(orgId: string, id: string): Promise<{ success: true }> {
    await this.get(orgId, id);

    const { error } = (await this.db
      .from(TABLE)
      .delete()
      .eq('organization_id', orgId)
      .eq('id', id)) as { error: { message: string } | null };

    if (error)
      throw new BadRequestException(`Failed to delete job: ${error.message}`);

    return { success: true };
  }

  private async assertConnectionInOrg(
    orgId: string,
    connectionId: string,
  ): Promise<void> {
    const { data, error } = (await this.db
      .from('migration_connections')
      .select('id')
      .eq('organization_id', orgId)
      .eq('id', connectionId)
      .maybeSingle()) as {
      data: { id: string } | null;
      error: { message: string } | null;
    };

    if (error)
      throw new BadRequestException(
        `Failed to verify connection: ${error.message}`,
      );
    if (!data)
      throw new BadRequestException(
        'Connection not found in this organization',
      );
  }

  private async assertSpaceInOrg(
    orgId: string,
    spaceId: string,
  ): Promise<void> {
    const { data, error } = (await this.db
      .from('spaces')
      .select('id')
      .eq('organization_id', orgId)
      .eq('id', spaceId)
      .maybeSingle()) as {
      data: { id: string } | null;
      error: { message: string } | null;
    };

    if (error)
      throw new BadRequestException(
        `Failed to verify target space: ${error.message}`,
      );
    if (!data)
      throw new BadRequestException(
        'Target space not found in this organization',
      );
  }
}
