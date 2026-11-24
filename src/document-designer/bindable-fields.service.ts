/**
 * @fileoverview Catalog of fields the designer's Fields panel can bind, per
 * source module: system columns (verified against the live table schemas),
 * meta fields, active custom fields for the entity context, and relation types
 * for linked-task loop regions. Labels ship inline in en + de.
 * @module src/document-designer/bindable-fields.service
 */

import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  TASK_LIST_COUNT_FIELDS,
  TASK_LIST_SOURCES_CATALOG,
  type ITaskListSourceCatalogEntry,
} from './rendering/task-list-sources';
import {
  DOCUMENT_SOURCE_ENTITIES,
  findSourceEntityConfig,
} from './source-entities';
import type {
  DocumentSourceEntity,
  IBindableField,
} from './template-definition/template-definition.types';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IBindableRelationType {
  id: string;
  name: string;
  inward: string;
  outward: string;
}

export interface IBindableFieldsResponse {
  fields: IBindableField[];
  relationTypes: IBindableRelationType[];
  /** Tasks only: the task list sources and their row fields. */
  listSources?: ITaskListSourceCatalogEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// System field catalogs (columns verified against the entity row contracts)
// ─────────────────────────────────────────────────────────────────────────────

const TASK_SYSTEM_FIELDS: IBindableField[] = [
  {
    key: 'key',
    label: { en: 'Key', de: 'Schlüssel' },
    source: 'system',
    fieldType: 'key',
  },
  {
    key: 'summary',
    label: { en: 'Title', de: 'Titel' },
    source: 'system',
    fieldType: 'string',
  },
  {
    key: 'description',
    label: { en: 'Description', de: 'Beschreibung' },
    source: 'system',
    fieldType: 'html',
  },
  // SEC-06. Empty on what a person made. A template shows it only where its author placed it.
  {
    key: 'ai_label',
    label: { en: 'AI label', de: 'KI-Kennzeichnung' },
    source: 'system',
    fieldType: 'string',
  },
  {
    key: 'status',
    label: { en: 'Status', de: 'Status' },
    source: 'system',
    fieldType: 'status',
  },
  {
    key: 'priority',
    label: { en: 'Priority', de: 'Priorität' },
    source: 'system',
    fieldType: 'priority',
  },
  {
    key: 'task_type_id',
    label: { en: 'Task type', de: 'Vorgangstyp' },
    source: 'system',
    fieldType: 'string',
  },
  {
    key: 'assigned_to',
    label: { en: 'Assignee', de: 'Zugewiesene Person' },
    source: 'system',
    fieldType: 'user',
  },
  {
    key: 'reporter',
    label: { en: 'Reporter', de: 'Melder' },
    source: 'system',
    fieldType: 'user',
  },
  {
    key: 'start_date',
    label: { en: 'Start date', de: 'Startdatum' },
    source: 'system',
    fieldType: 'date',
  },
  {
    key: 'due_date',
    label: { en: 'Due date', de: 'Fälligkeitsdatum' },
    source: 'system',
    fieldType: 'date',
  },
  {
    key: 'end_date',
    label: { en: 'End date', de: 'Enddatum' },
    source: 'system',
    fieldType: 'date',
  },
  {
    key: 'completed_at',
    label: { en: 'Completed at', de: 'Abgeschlossen am' },
    source: 'system',
    fieldType: 'date',
  },
  {
    key: 'created_at',
    label: { en: 'Created at', de: 'Erstellt am' },
    source: 'system',
    fieldType: 'date',
  },
  {
    key: 'updated_at',
    label: { en: 'Updated at', de: 'Aktualisiert am' },
    source: 'system',
    fieldType: 'date',
  },
  {
    key: 'progress',
    label: { en: 'Progress', de: 'Fortschritt' },
    source: 'system',
    fieldType: 'number',
  },
  {
    key: 'estimated_time',
    label: { en: 'Estimated time', de: 'Geschätzte Zeit' },
    source: 'system',
    fieldType: 'number',
  },
  {
    key: 'actual_time',
    label: { en: 'Actual time', de: 'Tatsächliche Zeit' },
    source: 'system',
    fieldType: 'number',
  },
  {
    key: 'estimated_cost',
    label: { en: 'Estimated cost', de: 'Geschätzte Kosten' },
    source: 'system',
    fieldType: 'number',
  },
  {
    key: 'actual_cost',
    label: { en: 'Actual cost', de: 'Tatsächliche Kosten' },
    source: 'system',
    fieldType: 'number',
  },
  {
    key: 'labels',
    label: { en: 'Labels', de: 'Labels' },
    source: 'system',
    fieldType: 'label[]',
  },
  {
    key: 'space_name',
    label: { en: 'Space', de: 'Bereich' },
    source: 'system',
    fieldType: 'string',
  },
  ...TASK_LIST_COUNT_FIELDS,
];

const PROCESS_SYSTEM_FIELDS: IBindableField[] = [
  {
    key: 'key',
    label: { en: 'Key', de: 'Schlüssel' },
    source: 'system',
    fieldType: 'key',
  },
  {
    key: 'title',
    label: { en: 'Title', de: 'Titel' },
    source: 'system',
    fieldType: 'string',
  },
  {
    key: 'description',
    label: { en: 'Description', de: 'Beschreibung' },
    source: 'system',
    fieldType: 'html',
  },
  {
    key: 'request_type',
    label: { en: 'Request type', de: 'Anfragetyp' },
    source: 'system',
    fieldType: 'string',
  },
  {
    key: 'status',
    label: { en: 'Status', de: 'Status' },
    source: 'system',
    fieldType: 'status',
  },
  {
    key: 'assigned_to',
    label: { en: 'Assignee', de: 'Zugewiesene Person' },
    source: 'system',
    fieldType: 'user',
  },
  {
    key: 'created_at',
    label: { en: 'Created at', de: 'Erstellt am' },
    source: 'system',
    fieldType: 'date',
  },
  {
    key: 'updated_at',
    label: { en: 'Updated at', de: 'Aktualisiert am' },
    source: 'system',
    fieldType: 'date',
  },
  {
    key: 'space_name',
    label: { en: 'Space', de: 'Bereich' },
    source: 'system',
    fieldType: 'string',
  },
];

/** Terser builder for the module catalogs below (columns verified in-schema). */
const sys = (
  key: string,
  en: string,
  de: string,
  fieldType = 'string',
): IBindableField => ({ key, label: { en, de }, source: 'system', fieldType });

const SPACE_FIELD = sys('space_name', 'Space', 'Bereich');
const CREATED_UPDATED: IBindableField[] = [
  sys('created_by', 'Created by', 'Erstellt von', 'user'),
  sys('created_at', 'Created at', 'Erstellt am', 'date'),
  sys('updated_at', 'Updated at', 'Aktualisiert am', 'date'),
];

const WIKI_SYSTEM_FIELDS: IBindableField[] = [
  sys('slug', 'Slug', 'Slug', 'key'),
  sys('title', 'Title', 'Titel'),
  sys('content', 'Content', 'Inhalt', 'html'),
  sys('workflow_status', 'Status', 'Status', 'status'),
  sys('is_published', 'Published', 'Veröffentlicht', 'boolean'),
  sys('published_at', 'Published at', 'Veröffentlicht am', 'date'),
  sys('updated_by', 'Updated by', 'Aktualisiert von', 'user'),
  ...CREATED_UPDATED,
  SPACE_FIELD,
];

const LIST_SYSTEM_FIELDS: IBindableField[] = [
  sys('title', 'Title', 'Titel'),
  sys('description', 'Description', 'Beschreibung', 'html'),
  sys('is_archived', 'Archived', 'Archiviert', 'boolean'),
  sys('updated_by', 'Updated by', 'Aktualisiert von', 'user'),
  ...CREATED_UPDATED,
  SPACE_FIELD,
];

const DASHBOARD_SYSTEM_FIELDS: IBindableField[] = [
  sys('name', 'Name', 'Name'),
  sys('description', 'Description', 'Beschreibung'),
  sys('status', 'Status', 'Status', 'status'),
  sys('visibility', 'Visibility', 'Sichtbarkeit'),
  sys('is_default', 'Default', 'Standard', 'boolean'),
  sys('is_shared', 'Shared', 'Geteilt', 'boolean'),
  sys('updated_by', 'Updated by', 'Aktualisiert von', 'user'),
  ...CREATED_UPDATED,
  SPACE_FIELD,
];

const BOARD_SYSTEM_FIELDS: IBindableField[] = [
  sys('board_key', 'Key', 'Schlüssel', 'key'),
  sys('name', 'Name', 'Name'),
  sys('description', 'Description', 'Beschreibung'),
  sys('board_type', 'Board type', 'Board-Typ'),
  sys('is_archived', 'Archived', 'Archiviert', 'boolean'),
  ...CREATED_UPDATED,
  SPACE_FIELD,
];

const PLAN_SYSTEM_FIELDS: IBindableField[] = [
  sys('plan_key', 'Key', 'Schlüssel', 'key'),
  sys('name', 'Name', 'Name'),
  sys('description', 'Description', 'Beschreibung', 'html'),
  sys('plan_type', 'Plan type', 'Plantyp'),
  sys('status', 'Status', 'Status', 'status'),
  sys('rag_status', 'RAG status', 'RAG-Status'),
  sys('start_date', 'Start date', 'Startdatum', 'date'),
  sys('end_date', 'End date', 'Enddatum', 'date'),
  sys('budget', 'Budget', 'Budget', 'number'),
  sys('currency', 'Currency', 'Währung'),
  sys('progress', 'Progress', 'Fortschritt', 'number'),
  sys('owner_id', 'Owner', 'Verantwortlich', 'user'),
  sys('is_archived', 'Archived', 'Archiviert', 'boolean'),
  ...CREATED_UPDATED,
  SPACE_FIELD,
];

const AUTOMATION_SYSTEM_FIELDS: IBindableField[] = [
  sys('name', 'Name', 'Name'),
  sys('description', 'Description', 'Beschreibung'),
  sys('status', 'Status', 'Status', 'status'),
  sys('last_run_at', 'Last run at', 'Letzter Lauf am', 'date'),
  sys('last_run_status', 'Last run status', 'Status letzter Lauf'),
  sys('next_run_at', 'Next run at', 'Nächster Lauf am', 'date'),
  sys('is_archived', 'Archived', 'Archiviert', 'boolean'),
  sys('updated_by', 'Updated by', 'Aktualisiert von', 'user'),
  ...CREATED_UPDATED,
  SPACE_FIELD,
];

const ASSET_SYSTEM_FIELDS: IBindableField[] = [
  sys('object_key', 'Key', 'Schlüssel', 'key'),
  sys('name', 'Name', 'Name'),
  sys('description', 'Description', 'Beschreibung', 'html'),
  sys('status', 'Status', 'Status', 'status'),
  sys('is_archived', 'Archived', 'Archiviert', 'boolean'),
  sys('updated_by', 'Updated by', 'Aktualisiert von', 'user'),
  ...CREATED_UPDATED,
  SPACE_FIELD,
];

const FILE_SYSTEM_FIELDS: IBindableField[] = [
  sys('name', 'File name', 'Dateiname'),
  sys('description', 'Description', 'Beschreibung', 'html'),
  sys('mime_type', 'File type', 'Dateityp'),
  sys('file_size', 'File size (bytes)', 'Dateigröße (Bytes)', 'number'),
  sys('updated_by', 'Updated by', 'Aktualisiert von', 'user'),
  ...CREATED_UPDATED,
  SPACE_FIELD,
];

const FORM_SYSTEM_FIELDS: IBindableField[] = [
  sys('form_key', 'Key', 'Schlüssel', 'key'),
  sys('name', 'Name', 'Name'),
  sys('description', 'Description', 'Beschreibung'),
  sys('status', 'Status', 'Status', 'status'),
  sys('version', 'Version', 'Version', 'number'),
  sys('is_public', 'Public', 'Öffentlich', 'boolean'),
  sys('public_slug', 'Public slug', 'Öffentlicher Slug'),
  sys('updated_by', 'Updated by', 'Aktualisiert von', 'user'),
  ...CREATED_UPDATED,
  SPACE_FIELD,
];

/** Exported for field-formatter.ts / document-data-resolver.service.ts — the single source of truth for a system field's declared type, per module. */
export const SYSTEM_FIELDS_BY_ENTITY: Record<
  DocumentSourceEntity,
  IBindableField[]
> = {
  tasks: TASK_SYSTEM_FIELDS,
  processes: PROCESS_SYSTEM_FIELDS,
  wiki: WIKI_SYSTEM_FIELDS,
  lists: LIST_SYSTEM_FIELDS,
  dashboards: DASHBOARD_SYSTEM_FIELDS,
  boards: BOARD_SYSTEM_FIELDS,
  plans: PLAN_SYSTEM_FIELDS,
  automations: AUTOMATION_SYSTEM_FIELDS,
  assets: ASSET_SYSTEM_FIELDS,
  file_explorer: FILE_SYSTEM_FIELDS,
  form_builder: FORM_SYSTEM_FIELDS,
};

const META_FIELDS: IBindableField[] = [
  {
    key: 'exportDate',
    label: { en: 'Export date', de: 'Exportdatum' },
    source: 'meta',
    fieldType: 'date',
  },
  {
    key: 'exportedBy',
    label: { en: 'Exported by', de: 'Exportiert von' },
    source: 'meta',
    fieldType: 'user',
  },
  {
    key: 'organizationName',
    label: { en: 'Organization', de: 'Organisation' },
    source: 'meta',
    fieldType: 'string',
  },
  {
    key: 'templateName',
    label: { en: 'Template name', de: 'Vorlagenname' },
    source: 'meta',
    fieldType: 'string',
  },
  {
    key: 'templateDescription',
    label: { en: 'Template description', de: 'Vorlagenbeschreibung' },
    source: 'meta',
    fieldType: 'string',
  },
  {
    // document_templates has no version column, so "last updated" is the
    // closest revision marker available.
    key: 'templateUpdatedAt',
    label: { en: 'Template last updated', de: 'Vorlage zuletzt aktualisiert' },
    source: 'meta',
    fieldType: 'date',
  },
  {
    key: 'itemIndex',
    label: { en: 'Item number', de: 'Elementnummer' },
    source: 'meta',
    fieldType: 'number',
  },
  {
    key: 'itemCount',
    label: { en: 'Item count', de: 'Anzahl Elemente' },
    source: 'meta',
    fieldType: 'number',
  },
];

@Injectable()
export class BindableFieldsService {
  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async getBindableFields(
    organizationId: string,
    sourceEntity: string,
    spaceIds?: string[],
  ): Promise<IBindableFieldsResponse> {
    const config = findSourceEntityConfig(sourceEntity);
    if (!config) {
      throw new BadRequestException(
        `source_entity must be one of: ${DOCUMENT_SOURCE_ENTITIES.join(', ')}`,
      );
    }

    const systemFields = SYSTEM_FIELDS_BY_ENTITY[config.key];

    const [customFields, relationTypes] = await Promise.all([
      // Modules with no `custom_fields.contexts` value have no bindable custom
      // fields — skip the query rather than returning every field in the org.
      config.customFieldContext
        ? this.fetchCustomFields(
            organizationId,
            config.customFieldContext,
            spaceIds,
          )
        : Promise.resolve([]),
      this.fetchRelationTypes(organizationId),
    ]);

    return {
      fields: [...systemFields, ...META_FIELDS, ...customFields],
      relationTypes,
      ...(config.key === 'tasks'
        ? { listSources: TASK_LIST_SOURCES_CATALOG }
        : {}),
    };
  }

  private async fetchCustomFields(
    organizationId: string,
    context: string,
    spaceIds?: string[],
  ): Promise<IBindableField[]> {
    let query = this.client
      .from('custom_fields')
      .select(
        'field_key, name, name_i18n, field_type, options, space_id, contexts',
      )
      .eq('organization_id', organizationId)
      .eq('is_active', true)
      .or('is_deleted.is.null,is_deleted.eq.false');

    const safeSpaceIds = (spaceIds ?? []).filter((id) => UUID_REGEX.test(id));
    if (safeSpaceIds.length > 0) {
      query = query.or(
        `space_id.is.null,space_id.in.(${safeSpaceIds.join(',')})`,
      );
    }

    const { data, error } = (await query) as {
      data: Array<{
        field_key: string;
        name: string;
        name_i18n: Record<string, string> | null;
        field_type: string;
        options: unknown;
        space_id: string | null;
        contexts: unknown;
      }> | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);

    const matching = (data ?? []).filter((row) =>
      contextsInclude(row.contexts, context),
    );

    // Org-scoped fields first so they win the field_key dedupe.
    matching.sort((a, b) => {
      if (!a.space_id && b.space_id) return -1;
      if (a.space_id && !b.space_id) return 1;
      return 0;
    });

    const seen = new Set<string>();
    const fields: IBindableField[] = [];
    for (const row of matching) {
      if (seen.has(row.field_key)) continue;
      seen.add(row.field_key);
      fields.push({
        key: row.field_key,
        label: {
          en: row.name,
          de: row.name_i18n?.['de'] ?? row.name,
        },
        source: 'custom_field',
        fieldType: row.field_type,
        options: normalizeOptions(row.options),
        scope: row.space_id ? 'space' : 'organization',
      });
    }

    return fields;
  }

  private async fetchRelationTypes(
    organizationId: string,
  ): Promise<IBindableRelationType[]> {
    const { data, error } = (await this.client
      .from('relation_types')
      .select('id, name, inward_description, outward_description')
      .eq('organization_id', organizationId)
      .eq('is_active', true)
      .eq('is_deleted', false)
      .order('sort_order', { ascending: true })) as {
      data: Array<{
        id: string;
        name: string;
        inward_description: string | null;
        outward_description: string | null;
      }> | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);

    return (data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      inward: row.inward_description ?? row.name,
      outward: row.outward_description ?? row.name,
    }));
  }
}

/**
 * `custom_fields.contexts` is jsonb on current schemas but a JSON-encoded
 * text string on older production instances (see custom-fields.service.ts
 * `filterByContext`) — handle both.
 */
function contextsInclude(contexts: unknown, context: string): boolean {
  if (Array.isArray(contexts)) return (contexts as string[]).includes(context);
  if (typeof contexts === 'string') {
    try {
      const parsed = JSON.parse(contexts) as unknown;
      return Array.isArray(parsed) && (parsed as string[]).includes(context);
    } catch {
      return false;
    }
  }
  return false;
}

function normalizeOptions(
  options: unknown,
): Array<{ value: string; label: string }> | undefined {
  if (!Array.isArray(options) || options.length === 0) return undefined;
  const normalized: Array<{ value: string; label: string }> = [];
  for (const entry of options) {
    if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      const value = record['value'];
      if (typeof value !== 'string' && typeof value !== 'number') continue;
      const label = record['label'];
      normalized.push({
        value: String(value),
        label: typeof label === 'string' ? label : String(value),
      });
    } else if (typeof entry === 'string') {
      normalized.push({ value: entry, label: entry });
    }
  }
  return normalized.length > 0 ? normalized : undefined;
}
