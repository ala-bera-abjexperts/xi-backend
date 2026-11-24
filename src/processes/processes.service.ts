/**
 * @fileoverview Service for ISMS business processes — CRUD with key
 * generation, type-specific validation, multi-parent relationships,
 * cascade delete, and reorder.
 * @module src/processes/processes.service
 * @author Prince Jadiya
 */

import {
  Injectable,
  Optional,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { NotificationsBroadcastService } from '../notifications/notifications-broadcast.service';
import { NotificationEmailService } from '../notifications/notification-email.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { extractUserMentionIds } from '../common/utils/mention-extractor';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { AutomationEventOutboxService } from '../automations/automation-event-outbox.service';
import type { CreateProcessDto } from './dto/create-process.dto';
import type { UpdateProcessDto } from './dto/update-process.dto';
import type { CreateProcessRelationshipDto } from './dto/create-process-relationship.dto';

export interface BusinessProcess {
  id: string;
  organization_id: string;
  space_id: string;
  key: string;
  title: string;
  description: string | null;
  request_type: string;
  status: string;
  hierarchy_level_id: string | null;
  parent_id: string | null;
  sort_order: number;
  vuln_c_p: number | null;
  vuln_c_i: number | null;
  vuln_i_p: number | null;
  vuln_i_i: number | null;
  vuln_a_p: number | null;
  vuln_a_i: number | null;
  action_c_p: number | null;
  action_c_i: number | null;
  action_i_p: number | null;
  action_i_i: number | null;
  action_a_p: number | null;
  action_a_i: number | null;
  custom_field_values: Record<string, unknown>;
  assigned_to: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

const VULN_KEYS = [
  'vuln_c_p',
  'vuln_c_i',
  'vuln_i_p',
  'vuln_i_i',
  'vuln_a_p',
  'vuln_a_i',
] as const;

const ACTION_KEYS = [
  'action_c_p',
  'action_c_i',
  'action_i_p',
  'action_i_i',
  'action_a_p',
  'action_a_i',
] as const;

@Injectable()
export class ProcessesService {
  private static readonly TABLE = 'business_processes';
  private static readonly RELATIONSHIPS_TABLE = 'process_relationships';
  private static readonly SPACES_TABLE = 'spaces';

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly auditLogsService: AuditLogsService,
    private readonly outboxService?: AutomationEventOutboxService,
    @Optional()
    private readonly notificationsBroadcast?: NotificationsBroadcastService,
    @Optional()
    private readonly notificationEmail?: NotificationEmailService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // ------------------------------------------------------------------
  // Read
  // ------------------------------------------------------------------

  async getById(
    id: string,
    organizationId: string,
    spaceId?: string,
  ): Promise<BusinessProcess> {
    const r = await this.client
      .from(ProcessesService.TABLE)
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (r.error) throw new BadRequestException(r.error.message);
    if (!r.data) throw new NotFoundException('Process not found');
    if (spaceId && (r.data as BusinessProcess).space_id !== spaceId) {
      throw new NotFoundException('Process not found in this space');
    }
    return r.data as BusinessProcess;
  }

  async getByKey(
    key: string,
    organizationId: string,
    spaceId?: string,
  ): Promise<BusinessProcess> {
    const r = await this.client
      .from(ProcessesService.TABLE)
      .select('*')
      .eq('key', key)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (r.error) throw new BadRequestException(r.error.message);
    if (!r.data) throw new NotFoundException('Process not found');
    if (spaceId && (r.data as BusinessProcess).space_id !== spaceId) {
      throw new NotFoundException('Process not found in this space');
    }
    return r.data as BusinessProcess;
  }

  async getAll(
    organizationId: string,
    spaceId?: string,
    filters?: {
      status?: string;
      request_type?: string;
      search?: string;
      page?: number;
      pageSize?: number;
    },
  ): Promise<{
    data: BusinessProcess[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = filters?.page ?? 1;
    const pageSize = filters?.pageSize ?? 50;
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let query = this.client
      .from(ProcessesService.TABLE)
      .select('*', { count: 'exact' })
      .eq('organization_id', organizationId);

    if (spaceId) query = query.eq('space_id', spaceId);
    if (filters?.status) query = query.eq('status', filters.status);
    if (filters?.request_type)
      query = query.eq('request_type', filters.request_type);

    if (filters?.search) {
      const safe = filters.search.replace(/[,.()"'\\]/g, '');
      if (safe.length > 0) {
        query = query.or(`title.ilike.%${safe}%,description.ilike.%${safe}%`);
      }
    }

    const r = await query
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false })
      .range(from, to);

    if (r.error) throw new BadRequestException(r.error.message);
    return {
      data: (r.data ?? []) as BusinessProcess[],
      total: r.count ?? 0,
      page,
      pageSize,
    };
  }

  async getAllWithParents(
    organizationId: string,
    spaceId?: string,
    filters?: {
      status?: string;
      request_type?: string;
      search?: string;
    },
  ): Promise<Array<BusinessProcess & { parent_ids: string[] }>> {
    const result = await this.getAll(organizationId, spaceId, {
      status: filters?.status,
      request_type: filters?.request_type,
      search: filters?.search,
      page: 1,
      pageSize: 10000,
    });
    return this.attachParentIds(result.data, organizationId);
  }

  async getByIdWithParents(
    id: string,
    organizationId: string,
    spaceId?: string,
  ): Promise<BusinessProcess & { parent_ids: string[] }> {
    const process = await this.getById(id, organizationId, spaceId);
    const parentIds = await this.getParentIds(process.id, organizationId);
    return { ...process, parent_ids: parentIds };
  }

  async getByKeyWithParents(
    key: string,
    organizationId: string,
    spaceId?: string,
  ): Promise<BusinessProcess & { parent_ids: string[] }> {
    const process = await this.getByKey(key, organizationId, spaceId);
    const parentIds = await this.getParentIds(process.id, organizationId);
    return { ...process, parent_ids: parentIds };
  }

  async getProcessTree(
    organizationId: string,
    rootProcessId?: string,
    spaceId?: string,
  ): Promise<unknown[]> {
    const params: Record<string, string | null> = {
      p_organization_id: organizationId,
      p_root_process_id: rootProcessId ?? null,
    };

    if (spaceId) {
      params.p_space_id = spaceId;
    }

    const result = await this.client.rpc(
      'get_business_process_tree_v2',
      params,
    );

    if (result.error) {
      throw new BadRequestException(result.error.message);
    }

    const rows = (result.data ?? []) as any[];

    if (rows.length === 0) return rows;

    // get_business_process_tree_v2 does not include `key` in its RETURNS TABLE
    // definition (changing the signature requires DROP which is disallowed).
    // Fetch key separately and merge it in so navigation links in
    // ProcessHierarchyTree.tsx can build /processes/view/:key URLs.
    const ids = rows.map((r: any) => r.id);
    const { data: keyRows, error: keyError } = await this.client
      .from('business_processes')
      .select('id, key')
      .in('id', ids);

    if (keyError) throw new BadRequestException(keyError.message);

    const keyMap = new Map((keyRows ?? []).map((r: any) => [r.id, r.key]));

    return rows.map((r: any) => ({ ...r, key: keyMap.get(r.id) ?? null }));
  }

  // ------------------------------------------------------------------
  // Create
  // ------------------------------------------------------------------

  async create(
    organizationId: string,
    userId: string,
    dto: CreateProcessDto,
    // Server-side callers only (Robert's Confirm): a repeated create collides on the primary key.
    trusted?: { id?: string },
  ): Promise<BusinessProcess> {
    // Type-specific validation
    this.validateTypeSpecific(dto);

    const key = await this.generateKey(organizationId, dto.space_id);
    const parentIds = this.normalizeParentIds(dto);

    const row: Record<string, unknown> = {
      ...(trusted?.id && { id: trusted.id }),
      organization_id: organizationId,
      space_id: dto.space_id,
      key,
      title: dto.title,
      description: dto.description ?? null,
      request_type: dto.request_type,
      status: dto.status ?? 'active',
      hierarchy_level_id: dto.hierarchy_level_id ?? null,
      parent_id: parentIds[0] ?? null,
      sort_order: dto.sort_order ?? 0,
      assigned_to: dto.assigned_to ?? null,
      custom_field_values: dto.custom_field_values ?? {},
      created_by: userId,
      updated_by: userId,
    };

    // Copy optional numeric fields if provided
    for (const k of [...VULN_KEYS, ...ACTION_KEYS]) {
      if (dto[k] !== undefined) row[k] = dto[k];
    }

    const r = await this.client
      .from(ProcessesService.TABLE)
      .insert(row)
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    const created = r.data as BusinessProcess;

    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'business_process',
      created.id,
      'create',
    );

    void this.outboxService?.write(
      organizationId,
      created.space_id,
      'app.process.created',
      {
        process: {
          id: created.id,
          name: created.title,
          space_id: created.space_id,
          organization_id: organizationId,
        },
        process_id: created.id,
        space_id: created.space_id,
        created_by: userId,
      },
    );

    // Handle multi-parent relationships
    for (const parentId of parentIds) {
      await this.insertRelationship(organizationId, parentId, created.id);
    }

    if (created.description) {
      void this.notifyMentionedUsers(
        String(created.description),
        'process',
        created.id,
        created.id,
        created.title,
        organizationId,
        userId,
        created.space_id,
        created.key,
      );
    }

    return created;
  }

  // ------------------------------------------------------------------
  // Update
  // ------------------------------------------------------------------

  async update(
    id: string,
    organizationId: string,
    userId: string,
    dto: UpdateProcessDto,
  ): Promise<BusinessProcess> {
    const existing = await this.getById(id, organizationId);

    // If request_type is being changed, validate the new type
    const effectiveType = dto.request_type ?? existing.request_type;
    const merged = { ...existing, ...dto };
    if (dto.request_type) {
      this.validateTypeSpecific({
        ...merged,
        request_type: effectiveType,
      } as unknown as CreateProcessDto);
    }

    const patch: Record<string, unknown> = { updated_by: userId };
    for (const key of [
      'title',
      'description',
      'request_type',
      'status',
      'hierarchy_level_id',
      'parent_id',
      'assigned_to',
      'sort_order',
      'custom_field_values',
      ...VULN_KEYS,
      ...ACTION_KEYS,
    ] as const) {
      if (dto[key] !== undefined) patch[key] = dto[key];
    }

    const r = await this.client
      .from(ProcessesService.TABLE)
      .update(patch)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    const changedFields: Record<string, { old: unknown; new: unknown }> = {};
    for (const [key, newVal] of Object.entries(patch)) {
      if (['updated_by', 'updated_at'].includes(key)) continue;
      changedFields[key] = {
        old: (existing as unknown as Record<string, unknown>)[key] ?? null,
        new: newVal,
      };
    }
    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'business_process',
      id,
      'update',
      changedFields,
    );

    void this.outboxService?.write(
      organizationId,
      existing.space_id,
      'app.process.updated',
      {
        process: {
          id,
          name: (r.data as BusinessProcess).title,
          space_id: existing.space_id,
          organization_id: organizationId,
        },
        process_id: id,
        space_id: existing.space_id,
        updated_by: userId,
      },
    );

    if (dto.description !== undefined) {
      void this.notifyMentionedUsers(
        String(patch.description ?? ''),
        'process',
        id,
        id,
        existing.title,
        organizationId,
        userId,
        existing.space_id,
        existing.key,
        existing.description,
      );
    }

    if (dto.parent_ids !== undefined || dto.parent_id !== undefined) {
      const parentIds = this.normalizeParentIds(dto);

      await this.replaceRelationships(organizationId, id, parentIds);

      // Emit relationship event so automations with app.process.relationship_changed
      // trigger fire when parents are changed via the edit form.
      void this.outboxService?.write(
        organizationId,
        existing.space_id,
        'app.process.relationship_changed',
        {
          child_process_id: id,
          parent_process_ids: parentIds,
          parent_process_id: parentIds[0] ?? null,
          action: 'replaced',
          organization_id: organizationId,
          space_id: existing.space_id,
        },
      );
    }

    return r.data as BusinessProcess;
  }

  // ------------------------------------------------------------------
  // Delete (cascade)
  // ------------------------------------------------------------------

  async delete(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    await this.getById(id, organizationId);
    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'business_process',
      id,
      'delete',
    );

    // Delete relationships where this process is child
    const r1 = await this.client
      .from(ProcessesService.RELATIONSHIPS_TABLE)
      .delete()
      .eq('child_process_id', id)
      .eq('organization_id', organizationId);
    if (r1.error) throw new BadRequestException(r1.error.message);

    // Delete relationships where this process is parent
    const r2 = await this.client
      .from(ProcessesService.RELATIONSHIPS_TABLE)
      .delete()
      .eq('parent_process_id', id)
      .eq('organization_id', organizationId);
    if (r2.error) throw new BadRequestException(r2.error.message);

    // Delete the process
    const r3 = await this.client
      .from(ProcessesService.TABLE)
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);
    if (r3.error) throw new BadRequestException(r3.error.message);
  }

  // ------------------------------------------------------------------
  // Reorder
  // ------------------------------------------------------------------

  async reorder(
    items: { id: string; sort_order: number }[],
    organizationId: string,
  ): Promise<void> {
    if (items.length === 0) return;

    // Was one sequential UPDATE per process — i.e. one PostgREST HTTP round trip
    // per item, on every drag. Now two requests total regardless of list size.
    //
    // The read is what keeps this safe. It re-scopes the ids to `organizationId`,
    // exactly as the per-row `.eq('organization_id', ...)` did: an id belonging to
    // another tenant simply doesn't come back and is skipped, so this cannot be
    // used to reorder another org's processes. A blind upsert keyed on `id` would
    // have dropped that tenant check — the one thing that must not regress here.
    //
    // Full rows are round-tripped with only `sort_order` changed, so no column can
    // be lost to an omitted-field upsert.
    const ids = items.map((item) => item.id);

    const existing = await this.client
      .from(ProcessesService.TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .in('id', ids);

    if (existing.error) throw new BadRequestException(existing.error.message);

    const sortOrderById = new Map(
      items.map((item) => [item.id, item.sort_order]),
    );

    const rows = (
      (existing.data ?? []) as unknown as Array<Record<string, unknown>>
    ).map((row) => ({
      ...row,
      sort_order: sortOrderById.get(row['id'] as string) ?? row['sort_order'],
    }));

    if (rows.length === 0) return;

    const upserted = await this.client
      .from(ProcessesService.TABLE)
      .upsert(rows, { onConflict: 'id' });

    if (upserted.error) throw new BadRequestException(upserted.error.message);
  }

  // ------------------------------------------------------------------
  // Relationships
  // ------------------------------------------------------------------

  async getRelationships(
    processId: string,
    organizationId: string,
  ): Promise<{ parents: unknown[]; children: unknown[] }> {
    await this.getById(processId, organizationId);
    const parents = await this.client
      .from(ProcessesService.RELATIONSHIPS_TABLE)
      .select('*')
      .eq('child_process_id', processId)
      .eq('organization_id', organizationId);
    if (parents.error) throw new BadRequestException(parents.error.message);

    const children = await this.client
      .from(ProcessesService.RELATIONSHIPS_TABLE)
      .select('*')
      .eq('parent_process_id', processId)
      .eq('organization_id', organizationId);
    if (children.error) throw new BadRequestException(children.error.message);

    return {
      parents: (parents.data ?? []) as unknown[],
      children: (children.data ?? []) as unknown[],
    };
  }

  async createRelationship(
    childProcessId: string,
    organizationId: string,
    dto: CreateProcessRelationshipDto,
  ): Promise<unknown> {
    const childProcess = await this.getById(childProcessId, organizationId);

    if (dto.parent_process_id === childProcessId) {
      throw new BadRequestException('A process cannot be a parent of itself');
    }

    // Verify parent exists in same org
    const parentCheck = await this.client
      .from(ProcessesService.TABLE)
      .select('id')
      .eq('id', dto.parent_process_id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (parentCheck.error)
      throw new BadRequestException(parentCheck.error.message);
    if (!parentCheck.data) {
      throw new NotFoundException('Parent process not found');
    }

    // Duplicate check
    const dup = await this.client
      .from(ProcessesService.RELATIONSHIPS_TABLE)
      .select('id')
      .eq('parent_process_id', dto.parent_process_id)
      .eq('child_process_id', childProcessId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (dup.data) {
      throw new ConflictException('This relationship already exists');
    }

    const insert = await this.client
      .from(ProcessesService.RELATIONSHIPS_TABLE)
      .insert({
        organization_id: organizationId,
        parent_process_id: dto.parent_process_id,
        child_process_id: childProcessId,
        relation_type_id: dto.relation_type_id ?? null,
        relationship_type: dto.relationship_type ?? 'parent_child',
      })
      .select()
      .single();
    if (insert.error) throw new BadRequestException(insert.error.message);

    void this.outboxService?.write(
      organizationId,
      (childProcess as { space_id: string }).space_id,
      'app.process.relationship_changed',
      {
        child_process_id: childProcessId,
        parent_process_id: dto.parent_process_id,
        action: 'created',
        organization_id: organizationId,
      },
    );

    return insert.data;
  }

  async deleteRelationship(
    processId: string,
    relationshipId: string,
    organizationId: string,
  ): Promise<void> {
    const process = await this.getById(processId, organizationId);
    const r = await this.client
      .from(ProcessesService.RELATIONSHIPS_TABLE)
      .delete()
      .eq('id', relationshipId)
      .eq('organization_id', organizationId);
    if (r.error) throw new BadRequestException(r.error.message);

    void this.outboxService?.write(
      organizationId,
      (process as { space_id: string }).space_id,
      'app.process.relationship_changed',
      {
        child_process_id: processId,
        relationship_id: relationshipId,
        action: 'deleted',
        organization_id: organizationId,
      },
    );
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private validateTypeSpecific(dto: CreateProcessDto): void {
    if (dto.request_type === 'Maßnahme') {
      const hasAction = ACTION_KEYS.some(
        (k) => dto[k] !== undefined && dto[k] !== null,
      );
      if (!hasAction) {
        throw new BadRequestException(
          'Maßnahme requires at least one action_* value',
        );
      }
    }
    if (dto.request_type === 'Schwachstelle') {
      const hasVuln = VULN_KEYS.some(
        (k) => dto[k] !== undefined && dto[k] !== null,
      );
      if (!hasVuln) {
        throw new BadRequestException(
          'Schwachstelle requires at least one vuln_* value',
        );
      }
    }
  }

  private normalizeParentIds(dto: {
    parent_id?: string | null;
    parent_ids?: string[];
  }): string[] {
    const parentIds = dto.parent_ids?.length
      ? dto.parent_ids
      : dto.parent_id
        ? [dto.parent_id]
        : [];

    return Array.from(new Set(parentIds.filter(Boolean)));
  }

  private async insertRelationship(
    organizationId: string,
    parentProcessId: string,
    childProcessId: string,
  ): Promise<void> {
    // Verify parent exists in same org
    const parentCheck = await this.client
      .from(ProcessesService.TABLE)
      .select('id')
      .eq('id', parentProcessId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (!parentCheck.data) return; // silently skip unknown parents

    const r = await this.client
      .from(ProcessesService.RELATIONSHIPS_TABLE)
      .insert({
        organization_id: organizationId,
        parent_process_id: parentProcessId,
        child_process_id: childProcessId,
        relationship_type: 'parent_child',
      });
    if (r.error) throw new BadRequestException(r.error.message);
  }

  private async replaceRelationships(
    organizationId: string,
    childProcessId: string,
    parentProcessIds: string[],
  ): Promise<void> {
    const deleteResult = await this.client
      .from(ProcessesService.RELATIONSHIPS_TABLE)
      .delete()
      .eq('child_process_id', childProcessId)
      .eq('organization_id', organizationId);
    if (deleteResult.error)
      throw new BadRequestException(deleteResult.error.message);

    for (const parentProcessId of parentProcessIds) {
      await this.insertRelationship(
        organizationId,
        parentProcessId,
        childProcessId,
      );
    }
  }

  private async attachParentIds(
    processes: BusinessProcess[],
    organizationId: string,
  ): Promise<Array<BusinessProcess & { parent_ids: string[] }>> {
    if (processes.length === 0) return [];

    const r = await this.client
      .from(ProcessesService.RELATIONSHIPS_TABLE)
      .select('parent_process_id, child_process_id')
      .eq('organization_id', organizationId);
    if (r.error) throw new BadRequestException(r.error.message);

    const parentMap = new Map<string, string[]>();
    for (const relationship of (r.data ?? []) as Array<{
      parent_process_id?: string;
      child_process_id?: string;
    }>) {
      if (!relationship.parent_process_id || !relationship.child_process_id) {
        continue;
      }
      const current = parentMap.get(relationship.child_process_id) ?? [];
      current.push(relationship.parent_process_id);
      parentMap.set(relationship.child_process_id, current);
    }

    return processes.map((process) => ({
      ...process,
      parent_ids: parentMap.get(process.id) ?? [],
    }));
  }

  private async getParentIds(
    processId: string,
    organizationId: string,
  ): Promise<string[]> {
    const r = await this.client
      .from(ProcessesService.RELATIONSHIPS_TABLE)
      .select('parent_process_id')
      .eq('child_process_id', processId)
      .eq('organization_id', organizationId);
    if (r.error) throw new BadRequestException(r.error.message);
    return ((r.data ?? []) as Array<{ parent_process_id?: string }>)
      .map((row) => row.parent_process_id)
      .filter((id): id is string => Boolean(id));
  }

  // ── Diagram ────────────────────────────────────────────────────────────

  private static readonly DIAGRAMS_TABLE = 'process_diagrams';

  /**
   * GET /processes/:id/diagram
   * Returns the saved diagram row, or null if none exists.
   *
   * The global ResponseInterceptor wraps the return value in
   * { statusCode, hasError, data, message }. Returning a bare row
   * (not { data: row }) avoids a double-wrap that the frontend
   * unwrapApiData helper cannot strip — the bug that caused all
   * BPMN diagrams to render as "No diagram" after the NestJS migration.
   */
  async getDiagram(
    processId: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(ProcessesService.DIAGRAMS_TABLE)
      .select('*')
      .eq('process_id', processId)
      .eq('organization_id', organizationId)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw new BadRequestException(error.message);
    }

    return data ? (data as Record<string, unknown>) : null;
  }

  /**
   * PUT /processes/:id/diagram
   * Upserts the diagram for a process and returns the persisted row.
   * Returns the bare row (single-wrap contract — see getDiagram note).
   */
  async upsertDiagram(
    processId: string,
    organizationId: string,
    userId: string,
    xml: string,
    previewSvg?: string,
  ): Promise<Record<string, unknown>> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(ProcessesService.DIAGRAMS_TABLE)
      .upsert(
        {
          process_id: processId,
          organization_id: organizationId,
          xml,
          preview_svg: previewSvg ?? '',
          updated_by: userId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'process_id' },
      )
      .select()
      .single();

    if (error || !data) {
      throw new BadRequestException(
        error?.message ?? 'Failed to upsert diagram',
      );
    }

    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'business_process',
      processId,
      'update',
      {
        action: 'diagram_updated',
      },
    );

    return data as Record<string, unknown>;
  }

  private async generateKey(
    organizationId: string,
    spaceId: string,
  ): Promise<string> {
    const spaceResult = await this.client
      .from(ProcessesService.SPACES_TABLE)
      .select('key')
      .eq('id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    const spaceKey = (spaceResult.data as { key?: string } | null)?.key ?? 'S';

    const maxResult = await this.client
      .from(ProcessesService.TABLE)
      .select('key')
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let nextNum = 1;
    if (maxResult.data) {
      const existing = (maxResult.data as { key: string }).key;
      const match = existing.match(/-P(\d+)$/);
      if (match) nextNum = parseInt(match[1], 10) + 1;
    }

    return `${spaceKey}-P${nextNum}`;
  }

  // ---- Comments ---------------------------------------------------------

  private static readonly COMMENTS_TABLE = 'process_comments';
  private static readonly COMMENT_SELECT =
    '*, user:users(first_name, last_name, avatar_url)';

  async getComments(
    processId: string,
    organizationId: string,
  ): Promise<unknown[]> {
    await this.getById(processId, organizationId);

    const { data, error } = await this.client
      .from(ProcessesService.COMMENTS_TABLE)
      .select(ProcessesService.COMMENT_SELECT)
      .eq('process_id', processId)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false });

    if (error) throw new BadRequestException(error.message);
    return (data ?? []) as Record<string, unknown>[];
  }

  private async notifyMentionedUsers(
    html: string,
    referenceType: string,
    referenceId: string,
    entityId: string,
    entityName: string,
    orgId: string,
    mentionedByUserId: string,
    spaceId?: string | null,
    entityKey?: string | null,
    oldHtml?: string | null,
  ): Promise<void> {
    const newIds = extractUserMentionIds(html);

    if (!newIds.length) return;

    // On UPDATE, only notify users who are newly mentioned (not in the old content).
    const oldIds = new Set(oldHtml ? extractUserMentionIds(oldHtml) : []);
    const diffIds = newIds.filter((id) => !oldIds.has(id));
    const toFilter = diffIds.filter((id) => id !== mentionedByUserId);

    if (!toFilter.length) return;

    const { data: members } = await this.client
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', orgId)
      .in('user_id', toFilter);

    const toNotify = ((members ?? []) as { user_id: string }[]).map(
      (m) => m.user_id,
    );

    if (!toNotify.length) return;

    let spaceKey: string | null = null;

    if (spaceId) {
      const spaceRes = await this.client
        .from('spaces')
        .select('key')
        .eq('id', spaceId)
        .maybeSingle();

      spaceKey = (spaceRes.data as { key?: string } | null)?.key ?? null;
    }

    // Fetch the mentioner's display name.
    const { data: mentioner } = await this.client
      .from('users')
      .select('first_name, last_name')
      .eq('id', mentionedByUserId)
      .maybeSingle();

    const mentionerName = mentioner
      ? `${(mentioner as { first_name?: string | null }).first_name ?? ''} ${(mentioner as { last_name?: string | null }).last_name ?? ''}`.trim() ||
        'Someone'
      : 'Someone';

    const rawText = html.replace(/<[^>]+>/g, '').slice(0, 200);
    const body = rawText.replace(/@/g, '').replace(/\s+/g, ' ').trim() || null;

    const isProcessMention = referenceType === 'process';
    const title = isProcessMention
      ? `${mentionerName} mentioned you in "${entityName || 'a process'}"`
      : `${mentionerName} mentioned you in a comment`;

    const { data: insertedNotifs, error: insertError } = await this.client
      .from('notifications')
      .insert(
        toNotify.map((userId) => ({
          organization_id: orgId,
          user_id: userId,
          type: 'comment_mention',
          title,
          body,
          is_read: false,
          reference_type: referenceType,
          reference_id: referenceId,
          metadata: {
            mentioned_by_user_id: mentionedByUserId,
            mentioner_name: mentionerName,
            entity_id: entityId,
            entity_name: entityName,
            ...(spaceKey && { space_key: spaceKey }),
            ...(entityKey && { entity_key: entityKey }),
          },
        })),
      )
      .select();

    if (insertError) {
      console.error(
        '[ProcessesService.notifyMentionedUsers] INSERT failed:',
        insertError.message,
        insertError,
      );
    } else if (insertedNotifs) {
      for (const notif of insertedNotifs) {
        void this.notificationsBroadcast?.broadcastNotification(
          notif as Record<string, unknown>,
        );
      }
      void this.notificationEmail?.emailForNotifications(
        insertedNotifs as Record<string, unknown>[],
      );
    }
  }

  async createComment(
    processId: string,
    organizationId: string,
    userId: string,
    content: string,
  ): Promise<unknown> {
    const proc = await this.getById(processId, organizationId);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(ProcessesService.COMMENTS_TABLE)
      .insert({
        process_id: processId,
        organization_id: organizationId,
        content,
        created_by: userId,
      })
      .select(ProcessesService.COMMENT_SELECT)
      .single();

    if (error) throw new BadRequestException(error.message);
    const preview = content.replace(/<[^>]+>/g, '').substring(0, 100);
    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'business_process',
      processId,
      'update',
      {
        action: 'comment_added',
        comment_id: (data as { id: string }).id,
        content_preview: preview,
      },
    );
    const newCommentId = (data as { id: string }).id;

    void this.notifyMentionedUsers(
      content,
      'process_comment',
      newCommentId,
      proc.id,
      proc.title,
      organizationId,
      userId,
      proc.space_id,
      proc.key,
    );

    return data;
  }

  async updateComment(
    processId: string,
    commentId: string,
    organizationId: string,
    userId: string,
    content: string,
  ): Promise<unknown> {
    const proc = await this.getById(processId, organizationId);

    const { data: existing, error: findError } = await this.client
      .from(ProcessesService.COMMENTS_TABLE)
      .select('id, created_by, content')
      .eq('id', commentId)
      .eq('process_id', processId)
      .maybeSingle();

    if (findError) throw new BadRequestException(findError.message);
    if (!existing) throw new NotFoundException('Comment not found');
    if ((existing as { created_by: string }).created_by !== userId) {
      throw new ForbiddenException('Only the author can edit this comment');
    }

    const oldPreview =
      (existing as { content?: string }).content
        ?.replace(/<[^>]+>/g, '')
        .substring(0, 100) ?? '';

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(ProcessesService.COMMENTS_TABLE)
      .update({ content, updated_at: new Date().toISOString() })
      .eq('id', commentId)
      .select(ProcessesService.COMMENT_SELECT)
      .single();

    if (error) throw new BadRequestException(error.message);
    const newPreview = content.replace(/<[^>]+>/g, '').substring(0, 100);
    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'business_process',
      processId,
      'update',
      {
        action: 'comment_updated',
        comment_id: commentId,
        old_preview: oldPreview,
        content_preview: newPreview,
      },
    );
    void this.notifyMentionedUsers(
      content,
      'process_comment',
      commentId,
      proc.id,
      proc.title,
      organizationId,
      userId,
      proc.space_id,
      proc.key,
      (existing as { content?: string }).content ?? null,
    );

    return data;
  }

  async deleteComment(
    processId: string,
    commentId: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    await this.getById(processId, organizationId);

    const { data: existing, error: findError } = await this.client
      .from(ProcessesService.COMMENTS_TABLE)
      .select('id, created_by, content')
      .eq('id', commentId)
      .eq('process_id', processId)
      .maybeSingle();

    if (findError) throw new BadRequestException(findError.message);
    if (!existing) throw new NotFoundException('Comment not found');
    if ((existing as { created_by: string }).created_by !== userId) {
      throw new ForbiddenException('Only the author can delete this comment');
    }

    const deletedPreview =
      (existing as { content?: string }).content
        ?.replace(/<[^>]+>/g, '')
        .substring(0, 100) ?? '';

    const { error } = await this.client
      .from(ProcessesService.COMMENTS_TABLE)
      .delete()
      .eq('id', commentId)
      .eq('process_id', processId)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);
    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'business_process',
      processId,
      'update',
      {
        action: 'comment_deleted',
        comment_id: commentId,
        content_preview: deletedPreview,
      },
    );
  }

  // ---- History ----------------------------------------------------------

  async getHistory(processId: string, orgId: string): Promise<unknown[]> {
    // Only `result.data` is consumed below, so skip the exact count.
    const result = await this.auditLogsService.getLogs(
      orgId,
      {
        entity_type: 'business_process',
        entity_id: processId,
        limit: '50',
      },
      { withCount: false },
    );

    const USER_FIELDS = new Set(['assigned_to', 'reporter', 'owner_id']);
    // parent_id = singular FK, parent_ids = JSONB array (multi-parent hierarchy)
    const PROCESS_REF_FIELDS = new Set(['parent_id', 'parent_ids']);
    const logs = result.data as any[];

    // Helper: collect process IDs from a value that may be string, string[], or a diff {old, new}
    const collectProcessIds = (v: any, target: Set<string>) => {
      if (!v) return;
      if (typeof v === 'string') {
        target.add(v);
        return;
      }
      if (Array.isArray(v)) {
        v.forEach((id) => typeof id === 'string' && id && target.add(id));
        return;
      }
      if (typeof v === 'object') {
        collectProcessIds(v.old, target);
        collectProcessIds(v.new, target);
      }
    };

    const userIds = new Set<string>();
    const processIds = new Set<string>();
    for (const log of logs) {
      const changes = log.changes as Record<string, any> | null;
      if (!changes) continue;
      for (const [key, val] of Object.entries(changes)) {
        if (USER_FIELDS.has(key) && val && typeof val === 'object') {
          if (typeof val.old === 'string' && val.old) userIds.add(val.old);
          if (typeof val.new === 'string' && val.new) userIds.add(val.new);
        }
        if (PROCESS_REF_FIELDS.has(key)) {
          collectProcessIds(val, processIds);
        }
      }
    }

    const usersMap: Record<string, unknown> = {};
    if (userIds.size > 0) {
      const { data: users } = await this.client
        .from('users')
        .select('id, first_name, last_name, email, avatar_url')
        .in('id', [...userIds]);
      for (const u of (users ?? []) as any[]) {
        usersMap[u.id] = {
          ...u,
          full_name:
            `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email,
        };
      }
    }

    const processesMap: Record<string, { id: string; title: string }> = {};
    if (processIds.size > 0) {
      const { data: processes } = await this.client
        .from(ProcessesService.TABLE)
        .select('id, title')
        .in('id', [...processIds]);
      for (const p of (processes ?? []) as any[]) {
        processesMap[p.id] = { id: p.id, title: p.title };
      }
    }

    // Resolve a process ref value to enriched form
    const resolveProcessVal = (v: any): any => {
      if (!v) return v;
      if (typeof v === 'string') return processesMap[v] ?? null;
      if (Array.isArray(v))
        return v.map((id) => processesMap[id] ?? null).filter(Boolean);
      return v;
    };

    return logs.map((log) => {
      const changes = log.changes as Record<string, any> | null;
      if (!changes) return log;
      const enrichedChanges = { ...changes };
      for (const [key, val] of Object.entries(changes)) {
        if (USER_FIELDS.has(key) && val && typeof val === 'object') {
          enrichedChanges[key] = {
            ...val,
            old_user: val.old ? (usersMap[val.old] ?? null) : null,
            new_user: val.new ? (usersMap[val.new] ?? null) : null,
          };
        }
        if (PROCESS_REF_FIELDS.has(key)) {
          // Diff format: {old, new} — enrich each side
          if (
            val &&
            typeof val === 'object' &&
            !Array.isArray(val) &&
            ('old' in val || 'new' in val)
          ) {
            enrichedChanges[key] = {
              ...val,
              old_process: resolveProcessVal(val.old),
              new_process: resolveProcessVal(val.new),
            };
          } else {
            // Plain value (create event) — wrap with resolved
            enrichedChanges[key] = {
              value: val,
              resolved: resolveProcessVal(val),
            };
          }
        }
      }
      return { ...log, changes: enrichedChanges };
    });
  }
}
