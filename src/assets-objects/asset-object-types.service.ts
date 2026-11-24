import { storageSafeFileName } from '../common/upload-filename';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { formatMaxUpload, UPLOAD_LIMITS } from '../common/upload-limits';
import { assertImageMime } from '../common/upload-mime';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { AssetSort } from './asset-sort.util';
import { AssetObjectHistoryService } from './asset-object-history.service';
import type { CreateAssetObjectTypeDto } from './dto/create-asset-object-type.dto';
import type { UpdateAssetObjectTypeDto } from './dto/update-asset-object-type.dto';
import type { MoveObjectTypeDto } from './dto/move-object-type.dto';
import type { SetAssetObjectTypePermissionsDto } from './dto/asset-object-type-permissions.dto';

const TABLE = 'asset_object_types';
const SCHEMAS_TABLE = 'asset_object_schemas';
const ATTRS_TABLE = 'asset_object_type_attributes';
const MAX_DEPTH = 10;
const IMAGES_BUCKET = 'asset-object-images';
/** Object images accept any `image/*` type, SVG included — this endpoint has always allowed SVG. */
const IMAGE_MIME_OPTS = { allowSvg: true } as const;

const MAX_IMAGE_SIZE_BYTES = UPLOAD_LIMITS.SMALL_IMAGE;

type TypeRow = Record<string, unknown> & {
  id: string;
  parent_object_type_id: string | null;
  parent_ids: string[];
  depth: number;
  schema_id: string;
  space_id: string;
  organization_id: string;
  version: number;
};

export interface IRestConfigEntry {
  section: string;
  label: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  description: string;
  body?: Record<string, unknown>;
  curlExample: string;
}

export interface IAssetObjectRestConfig {
  typeName: string;
  objectKey: string;
  typeId: string;
  attributes: Record<string, unknown>[];
  entries: IRestConfigEntry[];
}

@Injectable()
export class AssetObjectTypesService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly history: AssetObjectHistoryService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  private async loadRow(
    id: string,
    spaceId: string,
    organizationId: string,
  ): Promise<TypeRow> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .select('*')
      .eq('id', id)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Asset object type not found');

    return data as TypeRow;
  }

  async getTree(
    schemaId: string,
    spaceId: string,
    organizationId: string,
    userId?: string,
    sort?: AssetSort | null,
  ): Promise<Record<string, unknown>[]> {
    let query = this.client
      .from(TABLE)
      .select('*')
      .eq('schema_id', schemaId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId);

    // Ordering the flat rows is enough: the nesting pass below appends each row to its parent's
    // children in iteration order, so siblings inherit this ordering at every depth.
    // No sort requested means the manual, drag-assigned order — the historical default.
    query =
      sort && sort.field !== 'sort_order'
        ? query
            .order(sort.field, { ascending: sort.ascending })
            .order('name', { ascending: true })
        : query
            .order('sort_order', { ascending: true })
            .order('name', { ascending: true });

    const { data, error } = await query;

    if (error) throw new BadRequestException(error.message);

    let rows = (data ?? []) as TypeRow[];

    if (userId) {
      // Org owners see all types regardless of type-level permissions
      const { data: membership } = await this.client
        .from('organization_members')
        .select('role')
        .eq('user_id', userId)
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (
        (membership as Record<string, unknown> | null)?.['role'] !== 'owner'
      ) {
        // Fetch user's group memberships once (same query pattern as getMyPermission)
        const { data: memberships } = await this.client
          .from('user_group_members')
          .select('group_id')
          .eq('user_id', userId);

        const userGroupIds = new Set(
          (memberships ?? []).map(
            (m) => (m as Record<string, unknown>)['group_id'] as string,
          ),
        );

        // Pass 1: identify types where this user has no view access
        const hiddenIds = new Set<string>();

        for (const row of rows) {
          const perms = row['permissions'] as Record<string, unknown> | null;
          if (!perms) continue; // null = no restrictions → visible
          if (row['created_by'] === userId) continue; // creator always sees their types

          const groupPerms = (perms['group_permissions'] ?? []) as Array<{
            group_id: string;
            can_view?: boolean;
          }>;
          const userPerms = (perms['user_permissions'] ?? []) as Array<{
            user_id: string;
            can_view?: boolean;
          }>;

          if (groupPerms.length === 0 && userPerms.length === 0) continue; // empty = no restrictions

          const direct = userPerms.find((p) => p.user_id === userId);
          const fromUser = direct ? (direct.can_view ?? false) : false;
          const matched = groupPerms.filter((p) =>
            userGroupIds.has(p.group_id),
          );
          const fromGroup = matched.some((p) => p.can_view === true);

          if (!fromUser && !fromGroup) hiddenIds.add(row['id']);
        }

        // Pass 2: propagate hidden status to descendants via parent_ids (contains ALL ancestors)
        // Single pass is correct because parent_ids lists every ancestor, not just the immediate parent.
        const finalHiddenIds = new Set<string>(hiddenIds);
        for (const row of rows) {
          const parentIds = row['parent_ids'] ?? [];
          if (parentIds.some((pid) => finalHiddenIds.has(pid))) {
            finalHiddenIds.add(row['id']);
          }
        }

        rows = rows.filter((row) => !finalHiddenIds.has(row['id']));
      }
    }
    const byId = new Map<
      string,
      Record<string, unknown> & { children: unknown[] }
    >();

    for (const row of rows) {
      byId.set(row.id, { ...row, children: [] });
    }

    const roots: (Record<string, unknown> & { children: unknown[] })[] = [];

    for (const row of rows) {
      const node = byId.get(row.id)!;

      if (!row.parent_object_type_id) {
        roots.push(node);
      } else {
        const parent = byId.get(row.parent_object_type_id);

        if (parent) {
          parent.children.push(node);
        } else {
          // Orphan (parent deleted without cascade) — surface at root to avoid data loss
          roots.push(node);
        }
      }
    }

    return roots as Record<string, unknown>[];
  }

  async getOne(
    id: string,
    spaceId: string,
    organizationId: string,
  ): Promise<Record<string, unknown>> {
    return this.loadRow(id, spaceId, organizationId);
  }

  async getRestConfig(
    id: string,
    spaceId: string,
    organizationId: string,
  ): Promise<IAssetObjectRestConfig> {
    const typeRow = await this.loadRow(id, spaceId, organizationId);

    // Load schema to get object_key

    const { data: schemaData } = await this.client
      .from(SCHEMAS_TABLE)
      .select('object_key, name')
      .eq('id', typeRow.schema_id)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    const objectKey = schemaData
      ? (((schemaData as Record<string, unknown>)['object_key'] as string) ??
        'OBJ')
      : 'OBJ';

    // Try to load attribute definitions from table; graceful fallback to []

    const { data: attrsData } = await this.client
      .from(ATTRS_TABLE)
      .select(
        'field_key, name, data_type, is_required, options, reference_object_type_id',
      )
      .eq('object_type_id', id)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .order('sort_order', { ascending: true })
      .limit(50);

    const attributes = (attrsData ?? []) as Record<string, unknown>[];

    // `{baseUrl}` is filled by the browser with the API origin it actually calls (APP_URL is the frontend)
    const assetsBase = `{baseUrl}/spaces/${spaceId}/assets`;
    const objectsBase = `${assetsBase}/schemas/${String(typeRow['schema_id'])}/objects`;

    const typeName = String(typeRow['name']);

    // Real ids for every example so copied commands run as-is; a placeholder stays only where no such record exists
    const { data: typeObjectRows } = await this.client
      .from('asset_objects')
      .select('id, name, attribute_values')
      .eq('object_type_id', id)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('is_archived', false)
      .order('object_key', { ascending: true })
      .limit(200);

    const typeObjects = (typeObjectRows ?? []) as {
      id: string;
      name: string;
      attribute_values: Record<string, unknown> | null;
    }[];
    const typeObjectIds = typeObjects.map((o) => o.id);
    const firstObjectId = typeObjects[0]?.id ?? '{objectId}';
    const searchQuery = typeObjects[0]
      ? encodeURIComponent(typeObjects[0].name)
      : '{query}';

    // First child row of any object of this type, so the object id and child id in one URL belong together
    const firstChild = async (table: string) => {
      if (typeObjectIds.length === 0) return null;

      const { data } = await this.client
        .from(table)
        .select('id, object_id')
        .in('object_id', typeObjectIds)
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .order('created_at', { ascending: true })
        .limit(200);

      const rows = (data ?? []) as { id: string; object_id: string }[];

      // The earliest object (by key) that has one, then its oldest child
      return (
        rows.sort(
          (a, b) =>
            typeObjectIds.indexOf(a.object_id) -
            typeObjectIds.indexOf(b.object_id),
        )[0] ?? null
      );
    };

    const [attachment, comment, taskLink, reference, task] = await Promise.all([
      firstChild('asset_object_attachments'),
      firstChild('asset_object_comments'),
      firstChild('asset_object_task_links'),
      typeObjectIds.length === 0
        ? null
        : this.client
            .from('asset_object_references')
            .select('id, source_object_id, target_object_id')
            .eq('space_id', spaceId)
            .eq('organization_id', organizationId)
            .or(
              `source_object_id.in.(${typeObjectIds.join(',')}),target_object_id.in.(${typeObjectIds.join(',')})`,
            )
            .order('created_at', { ascending: true })
            .limit(200)
            .then(({ data }) => {
              const rows = (data ?? []) as {
                id: string;
                source_object_id: string;
                target_object_id: string;
              }[];

              // Rank by whichever end is the earliest object of this type
              const rank = (r: (typeof rows)[number]) =>
                Math.min(
                  ...[r.source_object_id, r.target_object_id]
                    .map((objectId) => typeObjectIds.indexOf(objectId))
                    .filter((index) => index >= 0),
                );

              return rows.sort((a, b) => rank(a) - rank(b))[0] ?? null;
            }),
      // Task links only accept a task from this space
      this.client
        .from('tasks')
        .select('id')
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .limit(1)
        .maybeSingle()
        .then(({ data }) => data as { id: string } | null),
    ]);

    // A reference is listed on either end, so use whichever end is an object of this type
    const referenceObjectId = !reference
      ? firstObjectId
      : typeObjectIds.includes(reference.source_object_id)
        ? reference.source_object_id
        : reference.target_object_id;

    // Reference targets must be another object in the same space
    const { data: otherObject } =
      typeObjectIds.length === 0
        ? { data: null }
        : await this.client
            .from('asset_objects')
            .select('id')
            .eq('space_id', spaceId)
            .eq('organization_id', organizationId)
            .eq('is_archived', false)
            .neq('id', referenceObjectId)
            .order('object_key', { ascending: true })
            .limit(1)
            .maybeSingle();

    const targetObjectId =
      (otherObject as { id: string } | null)?.id ?? '{targetObjectId}';

    // Sub-resources live under /assets/objects/:id (no schema segment); each section uses an object that owns its example child
    const objectBase = (objectId: string) =>
      `${assetsBase}/objects/${objectId}`;
    const attachmentsBase = `${objectBase(attachment?.object_id ?? firstObjectId)}/attachments`;
    const referencesBase = `${objectBase(referenceObjectId)}/references`;
    const commentsBase = `${objectBase(comment?.object_id ?? firstObjectId)}/comments`;
    const historyBase = `${objectBase(firstObjectId)}/history`;
    const taskLinksBase = `${objectBase(taskLink?.object_id ?? firstObjectId)}/task-links`;
    const attachmentId = attachment?.id ?? '{attachmentId}';
    const commentId = comment?.id ?? '{commentId}';
    const referenceId = reference?.id ?? '{referenceId}';
    const linkId = taskLink?.id ?? '{linkId}';
    const taskId = task?.id ?? '{taskUuid}';

    // Example bodies: the first stored value of each attribute on this type, else a valid dummy for its data type
    const needsMember = attributes.some(
      (attr) =>
        (attr['data_type'] === 'user' || attr['data_type'] === 'user_multi') &&
        !typeObjects.some(
          (o) => o.attribute_values?.[attr['field_key'] as string] != null,
        ),
    );

    const { data: member } = needsMember
      ? await this.client
          .from('organization_members')
          .select('user_id')
          .eq('organization_id', organizationId)
          .limit(1)
          .maybeSingle()
      : { data: null };

    const memberId = (member as { user_id: string } | null)?.user_id ?? null;

    const dummyFor = (attr: Record<string, unknown>): unknown => {
      const options = (attr['options'] ?? {}) as { values?: unknown[] };
      const firstOption =
        Array.isArray(options.values) && options.values.length > 0
          ? options.values[0]
          : 'Option 1';

      switch (attr['data_type']) {
        case 'integer':
          return 1;
        case 'float':
          return 1.5;
        case 'bool':
          return true;
        case 'date':
          return '2026-01-01';
        case 'datetime':
          return '2026-01-01T09:00:00.000Z';
        case 'email':
          return 'user@example.com';
        case 'url':
          return 'https://example.com';
        case 'select':
        case 'status':
          return firstOption;
        case 'multiselect':
          return [firstOption];
        case 'user':
          return memberId;
        case 'user_multi':
          return memberId ? [memberId] : null;
        case 'text':
        case 'textarea':
          return `Example ${String(attr['name'])}`;
        // A reference needs a real target, so without a stored value the key is left out
        default:
          return null;
      }
    };

    const attributeValues: Record<string, unknown> = {};

    for (const attr of attributes) {
      const key = attr['field_key'] as string;

      // Formulas are calculated and tab separators hold nothing
      if (
        attr['data_type'] === 'formula' ||
        attr['data_type'] === 'tab_separator'
      ) {
        continue;
      }

      const stored = typeObjects.find((o) => o.attribute_values?.[key] != null)
        ?.attribute_values?.[key];
      const value = stored ?? dummyFor(attr);

      if (value != null) attributeValues[key] = value;
    }

    const exampleBody: Record<string, unknown> = {
      object_type_id: id,
      name: `${typeName} instance`,
      attribute_values: attributeValues,
    };

    // Update accepts neither object_type_id nor version
    const updateBody: Record<string, unknown> = {
      name: `${typeName} instance`,
      attribute_values: attributeValues,
    };

    const entries: IRestConfigEntry[] = [
      // ── Objects ────────────────────────────────────────────────────────────
      {
        section: 'Objects',
        label: 'List',
        method: 'GET',
        path: `${objectsBase}?objectTypeId=${id}`,
        description: `List all ${typeName} objects in the space`,
        curlExample: `curl -X GET "${objectsBase}?objectTypeId=${id}" \\\n  -H "Authorization: Bearer {token}"`,
      },
      {
        section: 'Objects',
        label: 'Get',
        method: 'GET',
        path: `${objectsBase}/${firstObjectId}`,
        description: `Get a single ${typeName} object by ID`,
        curlExample: `curl -X GET "${objectsBase}/${firstObjectId}" \\\n  -H "Authorization: Bearer {token}"`,
      },
      {
        section: 'Objects',
        label: 'Create',
        method: 'POST',
        path: objectsBase,
        description: `Create a new ${typeName} object`,
        body: exampleBody,
        curlExample: `curl -X POST "${objectsBase}" \\\n  -H "Authorization: Bearer {token}" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(exampleBody, null, 2)}'`,
      },
      {
        section: 'Objects',
        label: 'Update',
        method: 'PATCH',
        path: `${objectsBase}/${firstObjectId}`,
        description: `Update a ${typeName} object (partial update)`,
        body: updateBody,
        curlExample: `curl -X PATCH "${objectsBase}/${firstObjectId}" \\\n  -H "Authorization: Bearer {token}" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(updateBody, null, 2)}'`,
      },
      {
        section: 'Objects',
        label: 'Delete',
        method: 'DELETE',
        path: `${objectsBase}/${firstObjectId}`,
        description: `Delete a ${typeName} object permanently`,
        curlExample: `curl -X DELETE "${objectsBase}/${firstObjectId}" \\\n  -H "Authorization: Bearer {token}"`,
      },
      {
        section: 'Objects',
        label: 'Search',
        method: 'GET',
        path: `${objectsBase}?objectTypeId=${id}&search=${searchQuery}`,
        description: `Search ${typeName} objects by name or filter by attributes`,
        curlExample: `curl -X GET "${objectsBase}?objectTypeId=${id}&search=${searchQuery}" \\\n  -H "Authorization: Bearer {token}"`,
      },

      // ── Attachments ────────────────────────────────────────────────────────
      {
        section: 'Attachments',
        label: 'List',
        method: 'GET',
        path: attachmentsBase,
        description: `List all file attachments for a ${typeName} object`,
        curlExample: `curl -X GET "${attachmentsBase}" \\\n  -H "Authorization: Bearer {token}"`,
      },
      {
        section: 'Attachments',
        label: 'Upload',
        method: 'POST',
        path: attachmentsBase,
        description: `Upload a file attachment to a ${typeName} object (multipart/form-data)`,
        curlExample: `curl -X POST "${attachmentsBase}" \\\n  -H "Authorization: Bearer {token}" \\\n  -F "file=@/path/to/file.pdf"`,
      },
      {
        section: 'Attachments',
        label: 'Get URL',
        method: 'GET',
        path: `${attachmentsBase}/${attachmentId}`,
        description: 'Get a signed download URL for a specific attachment',
        curlExample: `curl -X GET "${attachmentsBase}/${attachmentId}" \\\n  -H "Authorization: Bearer {token}"`,
      },
      {
        section: 'Attachments',
        label: 'Delete',
        method: 'DELETE',
        path: `${attachmentsBase}/${attachmentId}`,
        description: 'Permanently delete an attachment',
        curlExample: `curl -X DELETE "${attachmentsBase}/${attachmentId}" \\\n  -H "Authorization: Bearer {token}"`,
      },

      // ── References ─────────────────────────────────────────────────────────
      {
        section: 'References',
        label: 'List',
        method: 'GET',
        path: referencesBase,
        description: `List all inbound and outbound references for a ${typeName} object`,
        curlExample: `curl -X GET "${referencesBase}" \\\n  -H "Authorization: Bearer {token}"`,
      },
      {
        section: 'References',
        label: 'Create',
        method: 'POST',
        path: referencesBase,
        description: `Link another object to this ${typeName} object`,
        body: { target_object_id: targetObjectId, relation_type_id: null },
        curlExample: `curl -X POST "${referencesBase}" \\\n  -H "Authorization: Bearer {token}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"target_object_id":"${targetObjectId}"}'`,
      },
      {
        section: 'References',
        label: 'Delete',
        method: 'DELETE',
        path: `${referencesBase}/${referenceId}`,
        description: 'Remove a reference link',
        curlExample: `curl -X DELETE "${referencesBase}/${referenceId}" \\\n  -H "Authorization: Bearer {token}"`,
      },

      // ── Comments ───────────────────────────────────────────────────────────
      {
        section: 'Comments',
        label: 'List',
        method: 'GET',
        path: commentsBase,
        description: `List all comments on a ${typeName} object`,
        curlExample: `curl -X GET "${commentsBase}" \\\n  -H "Authorization: Bearer {token}"`,
      },
      {
        section: 'Comments',
        label: 'Create',
        method: 'POST',
        path: commentsBase,
        description: `Add a comment to a ${typeName} object`,
        body: { content: 'Your comment text here' },
        curlExample: `curl -X POST "${commentsBase}" \\\n  -H "Authorization: Bearer {token}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"content":"Your comment text here"}'`,
      },
      {
        section: 'Comments',
        label: 'Update',
        method: 'PATCH',
        path: `${commentsBase}/${commentId}`,
        description: 'Edit an existing comment',
        body: { content: 'Updated comment text' },
        curlExample: `curl -X PATCH "${commentsBase}/${commentId}" \\\n  -H "Authorization: Bearer {token}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"content":"Updated comment text"}'`,
      },
      {
        section: 'Comments',
        label: 'Delete',
        method: 'DELETE',
        path: `${commentsBase}/${commentId}`,
        description: 'Delete a comment',
        curlExample: `curl -X DELETE "${commentsBase}/${commentId}" \\\n  -H "Authorization: Bearer {token}"`,
      },

      // ── History ────────────────────────────────────────────────────────────
      {
        section: 'History',
        label: 'Get',
        method: 'GET',
        path: historyBase,
        description: `Retrieve the full change history log for a ${typeName} object`,
        curlExample: `curl -X GET "${historyBase}" \\\n  -H "Authorization: Bearer {token}"`,
      },

      // ── Task Links ─────────────────────────────────────────────────────────
      {
        section: 'Task Links',
        label: 'List',
        method: 'GET',
        path: taskLinksBase,
        description: `List all linked issues/tasks for a ${typeName} object`,
        curlExample: `curl -X GET "${taskLinksBase}" \\\n  -H "Authorization: Bearer {token}"`,
      },
      {
        section: 'Task Links',
        label: 'Create',
        method: 'POST',
        path: taskLinksBase,
        description: `Link an issue/task to a ${typeName} object`,
        body: { task_id: taskId, relation_type_id: null },
        curlExample: `curl -X POST "${taskLinksBase}" \\\n  -H "Authorization: Bearer {token}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"task_id":"${taskId}"}'`,
      },
      {
        section: 'Task Links',
        label: 'Delete',
        method: 'DELETE',
        path: `${taskLinksBase}/${linkId}`,
        description: 'Remove a task link',
        curlExample: `curl -X DELETE "${taskLinksBase}/${linkId}" \\\n  -H "Authorization: Bearer {token}"`,
      },
    ];

    return {
      typeName: String(typeRow['name']),
      objectKey,
      typeId: id,
      attributes,
      entries,
    };
  }

  async create(
    dto: CreateAssetObjectTypeDto,
    spaceId: string,
    organizationId: string,
    userId: string,
  ): Promise<Record<string, unknown>> {
    let parentIds: string[] = [];
    let depth = 0;

    if (dto.parent_object_type_id) {
      const parent = await this.loadRow(
        dto.parent_object_type_id,
        spaceId,
        organizationId,
      );

      if (parent.schema_id !== dto.schema_id) {
        throw new BadRequestException(
          'Parent type must belong to the same schema',
        );
      }

      depth = parent.depth + 1;

      if (depth > MAX_DEPTH) {
        throw new BadRequestException(
          `Maximum type depth of ${MAX_DEPTH} exceeded`,
        );
      }

      parentIds = [...parent.parent_ids, parent.id];
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .insert({
        organization_id: organizationId,
        space_id: spaceId,
        schema_id: dto.schema_id,
        parent_object_type_id: dto.parent_object_type_id ?? null,
        parent_ids: parentIds,
        depth,
        name: dto.name,
        description: dto.description ?? null,
        icon: dto.icon ?? null,
        color: dto.color ?? null,
        text_color: dto.text_color ?? null,
        is_abstract: dto.is_abstract ?? false,
        sort_order: dto.sort_order ?? 0,
        field_group_ids: dto.field_group_ids ?? [],
        is_active: dto.is_active ?? true,
        version: 1,
        created_by: userId,
        updated_by: userId,
      })
      .select('*')
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new ConflictException(
          `A type named "${dto.name}" already exists under this parent in the schema`,
        );
      }

      throw new BadRequestException(error.message);
    }

    const row = data as TypeRow;

    await this.history
      .logChange(
        null,
        row.schema_id,
        organizationId,
        spaceId,
        'type_create',
        userId,
        {
          metadata: { typeId: row.id, typeName: row['name'] },
        },
      )
      .catch(() => undefined);

    return row as Record<string, unknown>;
  }

  async update(
    id: string,
    dto: UpdateAssetObjectTypeDto,
    spaceId: string,
    organizationId: string,
    userId: string,
  ): Promise<Record<string, unknown>> {
    const patch: Record<string, unknown> = {
      updated_by: userId,
      version: dto.version + 1,
    };

    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.description !== undefined) patch.description = dto.description;
    if (dto.icon !== undefined) patch.icon = dto.icon;
    if (dto.color !== undefined) patch.color = dto.color;
    if (dto.text_color !== undefined) patch.text_color = dto.text_color;
    if (dto.is_abstract !== undefined) patch.is_abstract = dto.is_abstract;
    if (dto.sort_order !== undefined) patch.sort_order = dto.sort_order;
    if (dto.field_group_ids !== undefined)
      patch.field_group_ids = dto.field_group_ids;
    if (dto.permissions !== undefined) patch.permissions = dto.permissions;
    if (dto.is_active !== undefined) patch.is_active = dto.is_active;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .update(patch)
      .eq('id', id)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('version', dto.version)
      .select('*')
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) {
      const exists = await this.client
        .from(TABLE)
        .select('id')
        .eq('id', id)
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (!exists.data)
        throw new NotFoundException('Asset object type not found');

      throw new ConflictException('Stale version — refresh and retry');
    }

    const row = data as TypeRow;

    await this.history
      .logChange(
        null,
        row.schema_id,
        organizationId,
        spaceId,
        'type_update',
        userId,
        {
          metadata: { typeId: id },
        },
      )
      .catch(() => undefined);

    return row as Record<string, unknown>;
  }

  /**
   * Move a type to a new parent (or to root). Iterative BFS prevents cycles
   * and recomputes parent_ids/depth for the entire moved subtree (E18).
   * No DB transaction available in supabase-js — loop is the correct approach.
   */
  async move(
    id: string,
    dto: MoveObjectTypeDto,
    spaceId: string,
    organizationId: string,
    userId: string,
  ): Promise<Record<string, unknown>> {
    if (dto.new_parent_id === id) {
      throw new BadRequestException('A type cannot be its own parent');
    }

    const node = await this.loadRow(id, spaceId, organizationId);

    // BFS: collect all descendant ids (used for cycle detection)
    const descendantIds = new Set<string>();
    const queue: string[] = [id];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const { data: children, error: childError } = await this.client
        .from(TABLE)
        .select('id')
        .eq('parent_object_type_id', currentId)
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId);

      if (childError) throw new BadRequestException(childError.message);

      for (const child of children ?? []) {
        const childId = (child as { id: string }).id;

        if (!descendantIds.has(childId)) {
          descendantIds.add(childId);
          queue.push(childId);
        }
      }
    }

    let newParentIds: string[] = [];
    let newDepth = 0;

    if (dto.new_parent_id) {
      if (descendantIds.has(dto.new_parent_id)) {
        throw new BadRequestException(
          'Cannot move: would create a circular reference',
        );
      }

      const newParent = await this.loadRow(
        dto.new_parent_id,
        spaceId,
        organizationId,
      );

      if (newParent.schema_id !== String(node.schema_id)) {
        throw new BadRequestException(
          'New parent must belong to the same schema',
        );
      }

      newDepth = newParent.depth + 1;

      if (newDepth > MAX_DEPTH) {
        throw new BadRequestException(
          `Cannot move: maximum depth of ${MAX_DEPTH} exceeded`,
        );
      }

      newParentIds = [...newParent.parent_ids, newParent.id];
    }

    // Update the moved node itself
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data: movedNode, error: moveError } = await this.client
      .from(TABLE)
      .update({
        parent_object_type_id: dto.new_parent_id ?? null,
        parent_ids: newParentIds,
        depth: newDepth,
        sort_order: dto.sort_order ?? node.sort_order,
        version: node.version + 1,
        updated_by: userId,
      })
      .eq('id', id)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .select('*')
      .single();

    if (moveError) throw new BadRequestException(moveError.message);

    // Recompute parent_ids/depth for every descendant (E18: service-maintained only)
    if (descendantIds.size > 0) {
      // Load all descendants with their current parent chain so we can compute new paths
      const { data: descendants, error: descError } = await this.client
        .from(TABLE)
        .select('id, parent_object_type_id, parent_ids, depth')
        .in('id', Array.from(descendantIds))
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId);

      if (descError) throw new BadRequestException(descError.message);

      // Build a quick lookup: id → current row
      const descMap = new Map<string, TypeRow>();

      for (const d of descendants ?? []) {
        descMap.set((d as TypeRow).id, d as TypeRow);
      }

      // Process in BFS order (parents before children) so each child can
      // look up its already-updated parent from the map
      const updatedPaths = new Map<
        string,
        { parent_ids: string[]; depth: number }
      >();

      // Seed: the moved node's new path is authoritative
      updatedPaths.set(id, { parent_ids: newParentIds, depth: newDepth });

      const bfsQueue: string[] = [id];

      while (bfsQueue.length > 0) {
        const parentId = bfsQueue.shift()!;
        const parentPath = updatedPaths.get(parentId)!;

        for (const desc of descMap.values()) {
          if (
            desc.parent_object_type_id === parentId &&
            !updatedPaths.has(desc.id)
          ) {
            const descNewParentIds = [...parentPath.parent_ids, parentId];
            const descNewDepth = parentPath.depth + 1;

            updatedPaths.set(desc.id, {
              parent_ids: descNewParentIds,
              depth: descNewDepth,
            });
            bfsQueue.push(desc.id);

            await this.client
              .from(TABLE)
              .update({ parent_ids: descNewParentIds, depth: descNewDepth })
              .eq('id', desc.id)
              .eq('space_id', spaceId)
              .eq('organization_id', organizationId);
          }
        }
      }
    }

    await this.history
      .logChange(
        null,
        node.schema_id,
        organizationId,
        spaceId,
        'type_move',
        userId,
        {
          metadata: { typeId: id, newParentId: dto.new_parent_id ?? null },
        },
      )
      .catch(() => undefined);

    // Every legacy row defaults to sort_order 0, so setting only the moved node leaves an
    // incoherent order. Renumbering the destination siblings makes the first drag self-healing.
    await this.renumberSiblings(
      dto.new_parent_id ?? null,
      id,
      dto.sort_order,
      (movedNode as TypeRow).schema_id,
      spaceId,
      organizationId,
    );

    return movedNode as Record<string, unknown>;
  }

  /**
   * Rewrites `sort_order` as a dense 0..n sequence across one parent's children, placing the moved
   * node at `targetIndex`. Sibling `version` is deliberately left untouched: the client still holds
   * those versions, and bumping them would fail the optimistic-lock check on the very next drag.
   */
  private async renumberSiblings(
    parentId: string | null,
    movedId: string,
    targetIndex: number | undefined,
    schemaId: string,
    spaceId: string,
    organizationId: string,
  ): Promise<void> {
    let query = this.client
      .from(TABLE)
      .select('id, sort_order, name')
      .eq('schema_id', schemaId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });

    query = parentId
      ? query.eq('parent_object_type_id', parentId)
      : query.is('parent_object_type_id', null);

    const { data, error } = await query;

    if (error) throw new BadRequestException(error.message);

    const siblings = (data ?? []) as Array<{ id: string }>;
    const others = siblings.filter((s) => s.id !== movedId);
    const index = Math.max(
      0,
      Math.min(targetIndex ?? others.length, others.length),
    );
    const ordered = [
      ...others.slice(0, index).map((s) => s.id),
      movedId,
      ...others.slice(index).map((s) => s.id),
    ];

    await Promise.all(
      ordered.map((rowId, position) =>
        this.client
          .from(TABLE)
          .update({ sort_order: position })
          .eq('id', rowId)
          .eq('space_id', spaceId)
          .eq('organization_id', organizationId),
      ),
    );
  }

  async delete(
    id: string,
    spaceId: string,
    organizationId: string,
    userId?: string,
  ): Promise<{ success: true }> {
    // Load before delete to capture schema_id for history (and to confirm existence)
    const typeRow = await this.loadRow(id, spaceId, organizationId);

    const { count, error: countError } = await this.client
      .from(TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('parent_object_type_id', id)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId);

    if (countError) throw new BadRequestException(countError.message);

    const childCount = count ?? 0;

    if (childCount > 0) {
      throw new ConflictException({
        message: `Cannot delete type — it has ${childCount} child type(s). Remove children first.`,
        childCount,
      });
    }

    // Clean up stored image before deleting the row
    const existingImagePath = typeRow['image_path'] as string | null;

    if (existingImagePath) {
      await this.client.storage.from(IMAGES_BUCKET).remove([existingImagePath]);
    }

    const { error } = await this.client
      .from(TABLE)
      .delete()
      .eq('id', id)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId);

    if (error) {
      // FK RESTRICT on parent_object_type_id is the DB-level backstop
      if (error.code === '23503') {
        throw new ConflictException('Type has child types — delete them first');
      }

      throw new BadRequestException(error.message);
    }

    if (userId) {
      await this.history
        .logChange(
          null,
          typeRow.schema_id,
          organizationId,
          spaceId,
          'type_delete',
          userId,
          {
            metadata: { typeId: id, typeName: typeRow['name'] },
          },
        )
        .catch(() => undefined);
    }

    return { success: true };
  }

  async uploadImage(
    typeId: string,
    spaceId: string,
    organizationId: string,
    userId: string,
    file: Express.Multer.File,
  ): Promise<Record<string, unknown>> {
    const typeRow = await this.loadRow(typeId, spaceId, organizationId);

    if (!file) throw new BadRequestException('File is required');

    if (file.size > MAX_IMAGE_SIZE_BYTES) {
      throw new BadRequestException(
        `Image exceeds maximum size of ${formatMaxUpload(MAX_IMAGE_SIZE_BYTES)}`,
      );
    }

    assertImageMime(file.mimetype, IMAGE_MIME_OPTS);

    const sanitizedName = storageSafeFileName(file.originalname);
    const filePath = `object-types/${organizationId}/${typeId}/${Date.now()}-${sanitizedName}`;

    const oldImagePath = typeRow['image_path'] as string | null;

    if (oldImagePath) {
      await this.client.storage.from(IMAGES_BUCKET).remove([oldImagePath]);
    }

    const { error: uploadError } = await this.client.storage
      .from(IMAGES_BUCKET)
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (uploadError) {
      throw new BadRequestException(`Upload failed: ${uploadError.message}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .update({ image_path: filePath, updated_by: userId })
      .eq('id', typeId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .select('*')
      .single();

    if (error || !data) {
      await this.client.storage.from(IMAGES_BUCKET).remove([filePath]);
      throw new BadRequestException(
        error?.message ?? 'Failed to update type image',
      );
    }

    await this.history
      .logChange(
        null,
        typeRow.schema_id,
        organizationId,
        spaceId,
        'type_update',
        userId,
        { metadata: { typeId, action: 'image_uploaded' } },
      )
      .catch(() => undefined);

    return data as Record<string, unknown>;
  }

  async deleteImage(
    typeId: string,
    spaceId: string,
    organizationId: string,
    userId: string,
  ): Promise<Record<string, unknown>> {
    const typeRow = await this.loadRow(typeId, spaceId, organizationId);
    const imagePath = typeRow['image_path'] as string | null;

    if (imagePath) {
      await this.client.storage.from(IMAGES_BUCKET).remove([imagePath]);
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .update({ image_path: null, updated_by: userId })
      .eq('id', typeId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .select('*')
      .single();

    if (error || !data) {
      throw new BadRequestException(
        error?.message ?? 'Failed to remove type image',
      );
    }

    await this.history
      .logChange(
        null,
        typeRow.schema_id,
        organizationId,
        spaceId,
        'type_update',
        userId,
        { metadata: { typeId, action: 'image_deleted' } },
      )
      .catch(() => undefined);

    return data as Record<string, unknown>;
  }

  // ─── Object-Type Permissions ─────────────────────────────────────────────────

  async getPermissions(
    id: string,
    spaceId: string,
    organizationId: string,
  ): Promise<{
    object_type_id: string;
    group_permissions: Record<string, unknown>[];
    user_permissions: Record<string, unknown>[];
    creator: {
      user_id: string;
      user_name: string;
      user_email: string;
      user_avatar_url: string | null;
    } | null;
  }> {
    const typeRow = await this.loadRow(id, spaceId, organizationId);

    const existingPerms = typeRow['permissions'] as Record<
      string,
      unknown
    > | null;
    const groupPerms = (existingPerms?.['group_permissions'] ?? []) as Array<{
      group_id: string;
      can_view?: boolean;
      can_create?: boolean;
      can_edit?: boolean;
      can_delete?: boolean;
    }>;
    const userPerms = (existingPerms?.['user_permissions'] ?? []) as Array<{
      user_id: string;
      can_view?: boolean;
      can_create?: boolean;
      can_edit?: boolean;
      can_delete?: boolean;
    }>;

    // ── Enrich group permissions ──────────────────────────────────────────────

    let enrichedGroups: Record<string, unknown>[] = [];

    if (groupPerms.length > 0) {
      const groupIds = groupPerms.map((p) => p.group_id);

      const { data: groupRows, error: groupErr } = await this.client
        .from('user_groups')
        .select('id, name, color')
        .in('id', groupIds)
        .eq('organization_id', organizationId)
        .eq('is_deleted', false);

      if (groupErr) throw new BadRequestException(groupErr.message);

      const foundGroupIds = new Set(
        (groupRows ?? []).map(
          (g) => (g as Record<string, unknown>)['id'] as string,
        ),
      );

      const { data: memberRows } = await this.client
        .from('user_group_members')
        .select('group_id')
        .in('group_id', groupIds);

      const countMap = new Map<string, number>();
      for (const m of memberRows ?? []) {
        const gid = (m as Record<string, unknown>)['group_id'] as string;
        countMap.set(gid, (countMap.get(gid) ?? 0) + 1);
      }

      const groupMap = new Map<string, Record<string, unknown>>();
      for (const g of groupRows ?? []) {
        const row = g as Record<string, unknown>;
        groupMap.set(row['id'] as string, row);
      }

      enrichedGroups = groupPerms
        .filter((p) => foundGroupIds.has(p.group_id))
        .map((p) => {
          const g = groupMap.get(p.group_id)!;
          return {
            group_id: p.group_id,
            group_name: g['name'] as string,
            group_color: (g['color'] as string | null) ?? '#6B7280',
            member_count: countMap.get(p.group_id) ?? 0,
            can_view: p.can_view ?? true,
            can_create: p.can_create ?? false,
            can_edit: p.can_edit ?? false,
            can_delete: p.can_delete ?? false,
          };
        });
    }

    // ── Enrich user permissions ───────────────────────────────────────────────

    let enrichedUsers: Record<string, unknown>[] = [];

    if (userPerms.length > 0) {
      const userIds = userPerms.map((p) => p.user_id);

      const { data: userRows, error: userErr } = await this.client
        .from('users')
        .select('id, first_name, last_name, email, avatar_url')
        .in('id', userIds);

      if (userErr) throw new BadRequestException(userErr.message);

      const foundUserIds = new Set(
        (userRows ?? []).map(
          (u) => (u as Record<string, unknown>)['id'] as string,
        ),
      );
      const userMap = new Map<string, Record<string, unknown>>();
      for (const u of userRows ?? []) {
        const row = u as Record<string, unknown>;
        userMap.set(row['id'] as string, row);
      }

      enrichedUsers = userPerms
        .filter((p) => foundUserIds.has(p.user_id))
        .map((p) => {
          const u = userMap.get(p.user_id)!;
          const firstName = (u['first_name'] as string | null) ?? '';
          const lastName = (u['last_name'] as string | null) ?? '';
          return {
            user_id: p.user_id,
            user_name:
              `${firstName} ${lastName}`.trim() || (u['email'] as string),
            user_email: u['email'] as string,
            user_avatar_url: (u['avatar_url'] as string | null) ?? null,
            can_view: p.can_view ?? true,
            can_create: p.can_create ?? false,
            can_edit: p.can_edit ?? false,
            can_delete: p.can_delete ?? false,
          };
        });
    }

    // ── Enrich creator ────────────────────────────────────────────────────────

    let creator: {
      user_id: string;
      user_name: string;
      user_email: string;
      user_avatar_url: string | null;
    } | null = null;

    const creatorId = typeRow['created_by'] as string | null;

    if (creatorId) {
      const { data: cd } = await this.client
        .from('users')
        .select('first_name, last_name, email, avatar_url')
        .eq('id', creatorId)
        .maybeSingle();

      if (cd) {
        const first =
          ((cd as Record<string, unknown>)['first_name'] as string) ?? '';
        const last =
          ((cd as Record<string, unknown>)['last_name'] as string) ?? '';
        creator = {
          user_id: creatorId,
          user_name:
            `${first} ${last}`.trim() ||
            ((cd as Record<string, unknown>)['email'] as string),
          user_email: (cd as Record<string, unknown>)['email'] as string,
          user_avatar_url:
            ((cd as Record<string, unknown>)['avatar_url'] as string | null) ??
            null,
        };
      }
    }

    return {
      object_type_id: id,
      group_permissions: enrichedGroups,
      user_permissions: enrichedUsers,
      creator,
    };
  }

  async savePermissions(
    id: string,
    spaceId: string,
    organizationId: string,
    dto: SetAssetObjectTypePermissionsDto,
    userId: string,
  ): Promise<{
    object_type_id: string;
    group_permissions: Record<string, unknown>[];
  }> {
    const typeRow = await this.loadRow(id, spaceId, organizationId);

    // Only the type creator or org owner may modify permissions.
    const createdBy = typeRow['created_by'] as string | null;
    const isCreator = !!createdBy && createdBy === userId;

    if (!isCreator) {
      const { data: membershipRow } = await this.client
        .from('organization_members')
        .select('role')
        .eq('user_id', userId)
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (
        (membershipRow as Record<string, unknown> | null)?.['role'] !== 'owner'
      ) {
        throw new ForbiddenException(
          'Only the type creator or org owner can manage permissions',
        );
      }
    }

    if (dto.group_permissions.length > 0) {
      const groupIds = dto.group_permissions.map((p) => p.group_id);

      const { data: validGroups, error: validErr } = await this.client
        .from('user_groups')
        .select('id')
        .in('id', groupIds)
        .eq('organization_id', organizationId)
        .eq('is_deleted', false);

      if (validErr) throw new BadRequestException(validErr.message);

      const validIds = new Set(
        (validGroups ?? []).map(
          (g) => (g as Record<string, unknown>)['id'] as string,
        ),
      );
      const invalid = groupIds.filter((gid) => !validIds.has(gid));

      if (invalid.length > 0) {
        throw new BadRequestException(
          `The following group IDs are invalid or not in this organisation: ${invalid.join(', ')}`,
        );
      }
    }

    const userPermissionsInput = dto.user_permissions ?? [];

    if (userPermissionsInput.length > 0) {
      const userIds = userPermissionsInput.map((p) => p.user_id);

      const { data: validUsers, error: validUserErr } = await this.client
        .from('organization_members')
        .select('user_id')
        .in('user_id', userIds)
        .eq('organization_id', organizationId);

      if (validUserErr) throw new BadRequestException(validUserErr.message);

      const validUserIds = new Set(
        (validUsers ?? []).map(
          (u) => (u as Record<string, unknown>)['user_id'] as string,
        ),
      );
      const invalidUsers = userIds.filter((uid) => !validUserIds.has(uid));

      if (invalidUsers.length > 0) {
        throw new BadRequestException(
          `The following user IDs are not members of this organisation: ${invalidUsers.join(', ')}`,
        );
      }
    }

    const normalised = dto.group_permissions.map((p) => {
      const canView = p.can_view ?? true;
      const canEdit = p.can_edit ?? false;
      const canDelete = p.can_delete ?? false;
      const canCreate = p.can_create ?? false;
      const effectiveView = canView || canEdit || canDelete;
      return {
        group_id: p.group_id,
        can_view: effectiveView,
        can_create: effectiveView ? canCreate : false,
        can_edit: effectiveView ? canEdit : false,
        can_delete: effectiveView ? canDelete : false,
      };
    });

    const normalisedUsers = userPermissionsInput.map((p) => {
      const canView = p.can_view ?? true;
      const canEdit = p.can_edit ?? false;
      const canDelete = p.can_delete ?? false;
      const canCreate = p.can_create ?? false;
      const effectiveView = canView || canEdit || canDelete;
      return {
        user_id: p.user_id,
        can_view: effectiveView,
        can_create: effectiveView ? canCreate : false,
        can_edit: effectiveView ? canEdit : false,
        can_delete: effectiveView ? canDelete : false,
      };
    });

    const existingPerms =
      (typeRow['permissions'] as Record<string, unknown> | null) ?? {};
    const isEmpty = normalised.length === 0 && normalisedUsers.length === 0;

    const newPermissions = isEmpty
      ? null
      : {
          ...existingPerms,
          group_permissions: normalised,
          user_permissions: normalisedUsers,
        };

    const { error: updateErr } = await this.client
      .from(TABLE)
      .update({ permissions: newPermissions })
      .eq('id', id)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId);

    if (updateErr) throw new BadRequestException(updateErr.message);

    return this.getPermissions(id, spaceId, organizationId);
  }

  async getMyPermission(
    id: string,
    spaceId: string,
    organizationId: string,
    userId: string,
  ): Promise<{
    can_view: boolean;
    can_create: boolean;
    can_edit: boolean;
    can_delete: boolean;
    can_manage_permissions: boolean;
  }> {
    const typeRow = await this.loadRow(id, spaceId, organizationId);

    const typePermissions = typeRow['permissions'] as Record<
      string,
      unknown
    > | null;
    const createdBy = typeRow['created_by'] as string | null;
    const isCreator = !!createdBy && createdBy === userId;

    // Fetch org role upfront — needed for can_manage_permissions on every code path.
    const { data: membershipRow } = await this.client
      .from('organization_members')
      .select('role')
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    const isOrgOwner =
      (membershipRow as Record<string, unknown> | null)?.['role'] === 'owner';
    const canManagePermissions = isCreator || isOrgOwner;

    const ALL_TRUE = {
      can_view: true,
      can_create: true,
      can_edit: true,
      can_delete: true,
      can_manage_permissions: canManagePermissions,
    };
    const ALL_FALSE = {
      can_view: false,
      can_create: false,
      can_edit: false,
      can_delete: false,
      can_manage_permissions: false,
    };

    if (isCreator) return { ...ALL_TRUE, can_manage_permissions: true };

    const groupPerms = (typePermissions?.['group_permissions'] ?? []) as Array<{
      group_id: string;
      can_view?: boolean;
      can_create?: boolean;
      can_edit?: boolean;
      can_delete?: boolean;
    }>;
    const userPerms = (typePermissions?.['user_permissions'] ?? []) as Array<{
      user_id: string;
      can_view?: boolean;
      can_create?: boolean;
      can_edit?: boolean;
      can_delete?: boolean;
    }>;

    if (groupPerms.length === 0 && userPerms.length === 0) return ALL_TRUE;

    // Check explicit user permission entry first — explicit config overrides role
    const direct = userPerms.find((p) => p.user_id === userId);

    const fromUser: {
      can_view: boolean;
      can_create: boolean;
      can_edit: boolean;
      can_delete: boolean;
    } | null = direct
      ? {
          can_view: direct.can_view ?? false,
          can_create: direct.can_create ?? false,
          can_edit: direct.can_edit ?? false,
          can_delete: direct.can_delete ?? false,
        }
      : null;

    // Check group permissions
    let fromGroup: {
      can_view: boolean;
      can_create: boolean;
      can_edit: boolean;
      can_delete: boolean;
    } | null = null;

    if (groupPerms.length > 0) {
      const { data: memberships } = await this.client
        .from('user_group_members')
        .select('group_id')
        .eq('user_id', userId);

      const userGroupIds = new Set(
        (memberships ?? []).map(
          (m) => (m as Record<string, unknown>)['group_id'] as string,
        ),
      );

      const matched = groupPerms.filter((p) => userGroupIds.has(p.group_id));

      if (matched.length > 0) {
        fromGroup = {
          can_view: matched.some((p) => p.can_view === true),
          can_create: matched.some((p) => p.can_create === true),
          can_edit: matched.some((p) => p.can_edit === true),
          can_delete: matched.some((p) => p.can_delete === true),
        };
      }
    }

    // No explicit entry for this user or their groups — fall back to org role defaults.
    // Only the org owner gets unconditional access when not explicitly listed.
    if (fromUser === null && fromGroup === null) {
      if (isOrgOwner) return { ...ALL_TRUE, can_manage_permissions: true };

      return ALL_FALSE;
    }

    // Explicit permissions configured — use union of user + group entries.
    return {
      can_view: (fromUser?.can_view ?? false) || (fromGroup?.can_view ?? false),
      can_create:
        (fromUser?.can_create ?? false) || (fromGroup?.can_create ?? false),
      can_edit: (fromUser?.can_edit ?? false) || (fromGroup?.can_edit ?? false),
      can_delete:
        (fromUser?.can_delete ?? false) || (fromGroup?.can_delete ?? false),
      can_manage_permissions: canManagePermissions,
    };
  }
}
