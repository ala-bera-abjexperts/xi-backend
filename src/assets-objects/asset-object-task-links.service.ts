import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AssetObjectHistoryService } from './asset-object-history.service';
import type { CreateAssetObjectTaskLinkDto } from './dto/create-asset-object-task-link.dto';

const TABLE = 'asset_object_task_links';
const OBJECTS_TABLE = 'asset_objects';
const TASKS_TABLE = 'tasks';

type ObjectRow = {
  id: string;
  schema_id: string;
  space_id: string;
  organization_id: string;
};

@Injectable()
export class AssetObjectTaskLinksService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly history: AssetObjectHistoryService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  private async loadObject(
    id: string,
    spaceId: string,
    organizationId: string,
  ): Promise<ObjectRow> {
    const { data, error } = await this.client
      .from(OBJECTS_TABLE)
      .select('id,schema_id,space_id,organization_id')
      .eq('id', id)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException(`Asset object ${id} not found`);

    return data as ObjectRow;
  }

  async listForObject(
    spaceId: string,
    organizationId: string,
    objectId: string,
  ): Promise<Record<string, unknown>[]> {
    const { data, error } = await this.client
      .from(TABLE)
      .select(
        `id, object_id, task_id, relation_type_id, created_by, created_at,
        task:tasks!asset_object_task_links_task_id_fkey(
          id, key, summary, status, space_id
        ),
        relation_type:relation_types!asset_object_task_links_relation_type_id_fkey(
          id, name, color, icon
        )`,
      )
      .eq('object_id', objectId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: true });

    if (error) throw new BadRequestException(error.message);

    return (data ?? []) as Record<string, unknown>[];
  }

  async listForTask(
    spaceId: string,
    organizationId: string,
    taskId: string,
  ): Promise<Record<string, unknown>[]> {
    const { data, error } = await this.client
      .from(TABLE)
      .select(
        `id, object_id, task_id, relation_type_id, created_by, created_at,
        object:asset_objects!asset_object_task_links_object_id_fkey(
          id, name, object_key, object_type_id, schema_id,
          object_type:asset_object_types!asset_objects_object_type_id_fkey(
            id, name, icon, color
          )
        ),
        relation_type:relation_types!asset_object_task_links_relation_type_id_fkey(
          id, name, color, icon
        )`,
      )
      .eq('task_id', taskId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: true });

    if (error) throw new BadRequestException(error.message);

    return (data ?? []) as Record<string, unknown>[];
  }

  async create(
    spaceId: string,
    organizationId: string,
    userId: string,
    objectId: string,
    dto: CreateAssetObjectTaskLinkDto,
  ): Promise<Record<string, unknown>> {
    // 1. Load asset object — validates it exists in this space + org
    const obj = await this.loadObject(objectId, spaceId, organizationId);

    // 2. Verify the task exists in the same org
    const { data: task, error: taskErr } = await this.client
      .from(TASKS_TABLE)
      .select('id,space_id')
      .eq('id', dto.task_id)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (taskErr) throw new BadRequestException(taskErr.message);
    if (!task) throw new NotFoundException(`Task ${dto.task_id} not found`);

    // 3. Guard: task must be in the same space
    const taskRow = task as { id: string; space_id: string };
    if (taskRow.space_id !== spaceId) {
      throw new BadRequestException('Task is in a different space');
    }

    // 4. Optional relation type must belong to this org and not be trashed;
    //    otherwise a cross-tenant type is stored and its name renders.
    if (dto.relation_type_id) {
      const { data: rt, error: rtErr } = await this.client
        .from('relation_types')
        .select('id')
        .eq('id', dto.relation_type_id)
        .eq('organization_id', organizationId)
        .eq('is_deleted', false)
        .maybeSingle();

      if (rtErr) throw new BadRequestException(rtErr.message);
      if (!rt) throw new BadRequestException('Unknown relation type');
    }

    // 5. Insert
    const { data, error } = await this.client
      .from(TABLE)
      .insert({
        organization_id: organizationId,
        space_id: spaceId,
        object_id: objectId,
        task_id: dto.task_id,
        relation_type_id: dto.relation_type_id ?? null,
        created_by: userId,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new ConflictException('This task is already linked');
      }
      throw new BadRequestException(error.message);
    }

    const link = data as Record<string, unknown>;
    const linkId = link['id'] as string;

    // 6. Log history (never throws)
    await this.history
      .logChange(
        objectId,
        obj.schema_id,
        organizationId,
        spaceId,
        'task_link_added',
        userId,
        {
          metadata: {
            taskId: dto.task_id,
            linkId,
            relationTypeId: dto.relation_type_id ?? null,
          },
        },
      )
      .catch(() => undefined);

    return link;
  }

  async delete(
    spaceId: string,
    organizationId: string,
    userId: string,
    objectId: string,
    linkId: string,
  ): Promise<{ success: true }> {
    // 1. Load asset object to get schema_id for history
    const obj = await this.loadObject(objectId, spaceId, organizationId);

    // 2. Verify link exists and belongs to this object + space
    const { data: existing, error: fetchErr } = await this.client
      .from(TABLE)
      .select('id,task_id')
      .eq('id', linkId)
      .eq('object_id', objectId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (fetchErr) throw new BadRequestException(fetchErr.message);
    if (!existing) throw new NotFoundException('Task link not found');

    const existingRow = existing as { id: string; task_id: string };

    // 3. Delete
    const { error } = await this.client
      .from(TABLE)
      .delete()
      .eq('id', linkId)
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId);

    if (error) throw new BadRequestException(error.message);

    // 4. Log history (never throws)
    await this.history
      .logChange(
        objectId,
        obj.schema_id,
        organizationId,
        spaceId,
        'task_link_removed',
        userId,
        { metadata: { taskId: existingRow.task_id, linkId } },
      )
      .catch(() => undefined);

    return { success: true };
  }

  async deleteForTask(
    spaceId: string,
    organizationId: string,
    userId: string,
    taskId: string,
    linkId: string,
  ): Promise<{ success: true }> {
    // 1. Verify link exists and belongs to this task + space
    const { data: existing, error: fetchErr } = await this.client
      .from(TABLE)
      .select('id,object_id')
      .eq('id', linkId)
      .eq('task_id', taskId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (fetchErr) throw new BadRequestException(fetchErr.message);
    if (!existing) throw new NotFoundException('Asset link not found');

    const existingRow = existing as { id: string; object_id: string };

    // 2. Load the object to get schema_id for history
    const obj = await this.loadObject(
      existingRow.object_id,
      spaceId,
      organizationId,
    );

    // 3. Delete
    const { error } = await this.client
      .from(TABLE)
      .delete()
      .eq('id', linkId)
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId);

    if (error) throw new BadRequestException(error.message);

    // 4. Log history (never throws)
    await this.history
      .logChange(
        existingRow.object_id,
        obj.schema_id,
        organizationId,
        spaceId,
        'task_link_removed',
        userId,
        { metadata: { taskId, linkId } },
      )
      .catch(() => undefined);

    return { success: true };
  }
}
