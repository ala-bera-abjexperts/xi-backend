/**
 * @fileoverview Builds the row/column model for a filter export and hands it to a format adapter.
 * Values are resolved here, on the server, because the filter view resolves them in the browser
 * (users, linked tasks, assets). Lookups run on the service-role client, so references are scoped
 * to spaces the user may view: a linked record they may not see exports as an empty cell.
 * @module src/filter-exports/filter-exports.service
 */

import {
  BadRequestException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';

import { PdfRenderService } from '../document-designer/rendering/pdf-render.service';
import type { IFilterResultItem } from '../saved-filters/filter-query-engine';
import {
  SavedFiltersService,
  type IFilterFieldDefinition,
} from '../saved-filters/saved-filters.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { renderCsv } from './adapters/csv.adapter';
import { PDF_MAX_COLUMNS, renderPdf } from './adapters/pdf.adapter';
import { renderXlsx } from './adapters/xlsx.adapter';
import type { ExportFilterDto } from './dto/export-filter.dto';
import { exportFileName, toWallClock } from './filter-export.format';
import {
  EXPORT_STRINGS,
  type ExportCell,
  type ExportColumn,
  type ExportColumnKind,
  type ExportDocument,
  type FilterExportFormat,
  type FilterExportLocale,
  type RenderedExport,
} from './filter-export.types';

/** CSV's existing limit. A PDF over 2000 rows is hundreds of pages and strains the browser pool. */
export const FILTER_EXPORT_MAX_ROWS: Record<FilterExportFormat, number> = {
  csv: 10_000,
  xlsx: 10_000,
  pdf: 2_000,
};

const STANDARD_KINDS: Record<string, ExportColumnKind> = {
  entity_type: 'text',
  key: 'text',
  title: 'text',
  status: 'text',
  priority: 'text',
  assigned_to: 'text',
  reporter: 'text',
  space_name: 'text',
  created_at: 'datetime',
  updated_at: 'datetime',
  due_date: 'date',
  start_date: 'date',
  description: 'text',
  request_type: 'text',
};

const PR_COLUMN = 'pull_requests';
const BUILD_COLUMN = 'build_status';

const CUSTOM_FIELD_KINDS: Record<string, ExportColumnKind> = {
  number: 'number',
  date: 'date',
  datetime: 'datetime',
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HAS_OFFSET_RE = /(Z|[+-]\d{2}(:?\d{2})?)$/i;
const LOOKUP_CHUNK = 200;
/** Far past Excel's cell limit and what a PDF shows; bounds the regexes on pathological input. */
const MAX_HTML_LENGTH = 200_000;

interface LinkedRecordType {
  table: string;
  select: string;
  permission: string;
  label: (row: Record<string, unknown>) => string;
  /** The record is also protected by its own permissions, beyond its space. */
  isRestricted?: (row: Record<string, unknown>) => boolean;
}

const LINKED_RECORD_TYPES: Record<string, LinkedRecordType> = {
  task: {
    table: 'tasks',
    select: 'id, space_id, key, summary',
    permission: 'view_tasks',
    label: (row) => [row['key'], row['summary']].filter(Boolean).join(' '),
  },
  wiki_page: {
    table: 'wiki_pages',
    select: 'id, space_id, title, has_custom_permissions',
    permission: 'view_wiki_pages',
    label: (row) => row['title'] as string,
    isRestricted: (row) => row['has_custom_permissions'] === true,
  },
  list_item: {
    table: 'asset_items',
    select: 'id, space_id, title',
    permission: 'view_lists',
    label: (row) => row['title'] as string,
  },
  asset: {
    table: 'asset_objects',
    select: 'id, space_id, name, permissions',
    permission: 'view_assets',
    label: (row) => row['name'] as string,
    isRestricted: (row) => {
      const permissions = row['permissions'] as {
        user_permissions?: unknown[];
        group_permissions?: unknown[];
      } | null;

      return (
        (permissions?.user_permissions?.length ?? 0) > 0 ||
        (permissions?.group_permissions?.length ?? 0) > 0
      );
    },
  },
};

const LINKED_FIELD_TYPES: Record<string, string> = {
  task: 'task',
  wiki_page: 'wiki_page',
  list_item: 'list_item',
  asset: 'asset',
  asset_multi: 'asset',
};

/** Same reading as the filter view: "in_progress" becomes "In Progress", "P1" stays. */
function humanizeKey(raw: unknown): string {
  if (typeof raw !== 'string') return '';

  return raw
    .trim()
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (/[a-z]/.test(word) ? word : word.toLowerCase()))
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** XML and PDF writers choke on control characters; line breaks and tabs are real content. */
function cleanText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
}

/**
 * Plain text, not sanitising: the result never reaches a browser as HTML (the PDF adapter escapes
 * it). A DOM parser here costs about 1.6 ms per value, which blocks the server for 16 s per 10,000 rows.
 */
function htmlToText(value: string): string {
  if (!value.includes('<') && !value.includes('&')) return cleanText(value);

  return cleanText(
    value
      .slice(0, MAX_HTML_LENGTH)
      .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, '\n')
      // `[^<>]`, not `[^>]`: on a run of unclosed `<` the latter rescans to the end from every
      // `<` (200k chars took 13 s). A real tag never contains a raw `<`.
      // ponytail: the style/script pattern above is still quadratic (~0.5 s at 200k); the write
      // path sanitises those tags away, so swap in an indexOf scan only if imported data has them.
      .replace(/<[^<>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\n{3,}/g, '\n\n'),
  );
}

function toDate(
  value: unknown,
  kind: ExportColumnKind,
  timeZone: string,
): Date | null {
  if (typeof value !== 'string' || !value) return null;

  // A date-only value is a calendar day: shifting it by a time zone would change the day.
  if (DATE_ONLY_RE.test(value)) return new Date(`${value}T00:00:00.000Z`);

  // No offset means it is already wall-clock time, whatever zone the server runs in.
  const parsed = new Date(HAS_OFFSET_RE.test(value) ? value : `${value}Z`);

  if (Number.isNaN(parsed.getTime())) return null;

  const wallClock = toWallClock(parsed, timeZone);

  return kind === 'date'
    ? new Date(wallClock.toISOString().slice(0, 10))
    : wallClock;
}

/** Text of a scalar; objects have no display text of their own. */
function scalarText(value: unknown): string {
  if (typeof value === 'string') return value;

  return typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : '';
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function personName(person: {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
}): string {
  return (
    [person.first_name, person.last_name].filter(Boolean).join(' ') ||
    person.email ||
    ''
  );
}

function resolveTimeZone(requested?: string): string {
  if (!requested) return 'UTC';

  try {
    new Intl.DateTimeFormat('en', { timeZone: requested });

    return requested;
  } catch {
    return 'UTC';
  }
}

interface Lookups {
  users: Map<string, string>;
  statuses: Map<string, string>;
  linked: Record<string, Map<string, string>>;
}

@Injectable()
export class FilterExportsService {
  constructor(
    private readonly savedFilters: SavedFiltersService,
    private readonly pdfRenderService: PdfRenderService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async export(
    filterId: string,
    dto: ExportFilterDto,
    organizationId: string,
    userId: string,
    origin: string | undefined,
    signal: AbortSignal,
  ): Promise<{ buffer: Buffer; fileName: string; contentType: string }> {
    // Throws unless the user may view this filter.
    const { data: filter } = await this.savedFilters.getById(
      filterId,
      organizationId,
      userId,
    );

    const { data: fields } = await this.savedFilters.getFilterableFields(
      organizationId,
      userId,
      dto.source_type === 'wiki'
        ? ['wiki']
        : (dto.source_entity_types ?? ['processes', 'tasks', 'lists']),
    );
    const fieldsByName = new Map(fields.map((field) => [field.name, field]));
    const requested = this.resolveColumns(dto, fieldsByName);

    this.assertColumnLimit(dto.format, requested.length);

    const { items, withGit, pullRequests } =
      await this.savedFilters.collectFilterExportItems(
        filterId,
        dto,
        organizationId,
        userId,
        FILTER_EXPORT_MAX_ROWS[dto.format],
        signal,
      );

    const strings = EXPORT_STRINGS[dto.locale];
    const showGit = withGit && items.some((i) => i.entity_type === 'task');
    const columns: ExportColumn[] = showGit
      ? [
          ...requested,
          { id: PR_COLUMN, label: strings.pullRequests, kind: 'text' },
          { id: BUILD_COLUMN, label: strings.buildStatus, kind: 'text' },
        ]
      : requested;

    this.assertColumnLimit(dto.format, columns.length);

    const lookups = await this.loadLookups(
      items,
      columns,
      fieldsByName,
      organizationId,
      userId,
    );
    signal.throwIfAborted();

    const timeZone = resolveTimeZone(dto.time_zone);
    const exportedAt = toWallClock(new Date(), timeZone);
    const baseUrl = /^https?:\/\/[^/]+$/.test(origin ?? '') ? origin : null;

    const doc: ExportDocument = {
      title: cleanText((filter['name'] as string) || 'Filter'),
      description: cleanText((filter['description'] as string) || ''),
      queryText: this.describeQuery(dto.query, fieldsByName, dto.locale),
      columns,
      rows: items.map((item) => ({
        cells: columns.map((column) =>
          this.cellValue(
            item,
            column,
            fieldsByName,
            lookups,
            pullRequests,
            dto.locale,
            timeZone,
          ),
        ),
        keyHref: baseUrl && item.key ? this.entityHref(item, baseUrl) : null,
      })),
      locale: dto.locale,
      exportedBy:
        (await this.loadUserNames([userId], organizationId)).get(userId) ?? '',
      exportedAt,
      timeZone,
    };

    const rendered = await this.render(dto.format, doc);

    await this.savedFilters.auditFilterExport(
      filterId,
      organizationId,
      userId,
      dto.format,
      items.length,
    );

    return {
      buffer: rendered.buffer,
      contentType: rendered.contentType,
      fileName: exportFileName(doc.title, exportedAt, rendered.extension),
    };
  }

  private render(
    format: FilterExportFormat,
    doc: ExportDocument,
  ): RenderedExport | Promise<RenderedExport> {
    switch (format) {
      case 'csv':
        return renderCsv(doc);
      case 'xlsx':
        return renderXlsx(doc);
      case 'pdf':
        return renderPdf(doc, (html, page, options) =>
          this.pdfRenderService.renderPdf(html, page, undefined, options),
        );
    }
  }

  private assertColumnLimit(format: FilterExportFormat, count: number): void {
    if (format === 'pdf' && count > PDF_MAX_COLUMNS) {
      throw new UnprocessableEntityException({
        code: 'FILTER_EXPORT_TOO_MANY_COLUMNS',
        message: `A PDF can hold at most ${PDF_MAX_COLUMNS} columns. Hide some columns and try again.`,
      });
    }
  }

  /** Only columns the filter view can show: `_entity` and fields the user cannot see stay out. */
  private resolveColumns(
    dto: ExportFilterDto,
    fieldsByName: Map<string, IFilterFieldDefinition>,
  ): ExportColumn[] {
    const seen = new Set<string>();
    const columns: ExportColumn[] = [];

    for (const { id, label } of dto.columns) {
      if (seen.has(id)) continue;
      seen.add(id);

      const field = fieldsByName.get(id);
      const kind = field?.isCustomField
        ? (CUSTOM_FIELD_KINDS[field.customFieldType ?? ''] ?? 'text')
        : STANDARD_KINDS[id];

      if (kind) columns.push({ id, label: cleanText(label), kind });
    }

    if (columns.length === 0) {
      throw new BadRequestException('No exportable columns were requested');
    }

    return columns;
  }

  private async loadLookups(
    items: IFilterResultItem[],
    columns: ExportColumn[],
    fieldsByName: Map<string, IFilterFieldDefinition>,
    organizationId: string,
    userId: string,
  ): Promise<Lookups> {
    const userIds = new Set<string>();
    const linkedIds: Record<string, Set<string>> = {};
    const has = (id: string) => columns.some((column) => column.id === id);

    for (const item of items) {
      for (const id of ['assigned_to', 'reporter'] as const) {
        const value = item[id] as unknown;

        if (has(id) && typeof value === 'string') userIds.add(value);
      }

      for (const { id } of columns) {
        const field = fieldsByName.get(id);

        if (!field?.isCustomField) continue;

        const value = item.custom_field_values?.[
          id.replace(/^cf_/, '')
        ] as unknown;

        if (value === null || value === undefined) continue;

        const type = field.customFieldType ?? '';
        const linkedType = LINKED_FIELD_TYPES[type];
        const ids = asList(value).filter(
          (entry): entry is string => typeof entry === 'string' && !!entry,
        );

        if (type === 'user_select' || type === 'user_multi') {
          ids.forEach((entry) => userIds.add(entry));
        } else if (linkedType) {
          linkedIds[linkedType] ??= new Set();
          ids.forEach((entry) => linkedIds[linkedType].add(entry));
        }
      }
    }

    const linked: Record<string, Map<string, string>> = {};

    await Promise.all(
      Object.entries(linkedIds).map(async ([type, ids]) => {
        linked[type] = await this.loadLinkedLabels(
          LINKED_RECORD_TYPES[type],
          [...ids],
          organizationId,
          userId,
        );
      }),
    );

    return {
      users: await this.loadUserNames([...userIds], organizationId),
      statuses:
        has('status') && items.some((i) => i.entity_type === 'task')
          ? await this.loadTaskStatusNames(organizationId)
          : new Map<string, string>(),
      linked,
    };
  }

  private async selectIn(
    table: string,
    select: string,
    column: string,
    ids: string[],
    organizationId: string,
  ): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    const validIds = ids.filter((id) => UUID_RE.test(id));

    for (let i = 0; i < validIds.length; i += LOOKUP_CHUNK) {
      const { data, error } = await this.client
        .from(table)
        .select(select)
        .eq('organization_id', organizationId)
        .in(column, validIds.slice(i, i + LOOKUP_CHUNK));

      if (error) throw new BadRequestException(error.message);
      rows.push(...((data ?? []) as unknown as Record<string, unknown>[]));
    }

    return rows;
  }

  /** Names of this organization's members only. */
  private async loadUserNames(
    userIds: string[],
    organizationId: string,
  ): Promise<Map<string, string>> {
    const rows = await this.selectIn(
      'organization_members',
      'user:users!organization_members_user_id_fkey(id, first_name, last_name, email)',
      'user_id',
      userIds,
      organizationId,
    );
    const names = new Map<string, string>();

    for (const row of rows) {
      const user = row['user'] as {
        id: string;
        first_name?: string | null;
        last_name?: string | null;
        email?: string | null;
      } | null;

      if (user) names.set(user.id, personName(user));
    }

    return names;
  }

  private async loadLinkedLabels(
    type: LinkedRecordType,
    ids: string[],
    organizationId: string,
    userId: string,
  ): Promise<Map<string, string>> {
    const permittedSpaces = new Set(
      await this.savedFilters.getPermittedSpaceIdsForPermission(
        userId,
        organizationId,
        type.permission,
      ),
    );
    const rows = await this.selectIn(
      type.table,
      type.select,
      'id',
      ids,
      organizationId,
    );
    const labels = new Map<string, string>();

    for (const row of rows) {
      if (
        permittedSpaces.has(row['space_id'] as string) &&
        !type.isRestricted?.(row)
      ) {
        labels.set(row['id'] as string, cleanText(type.label(row) ?? ''));
      }
    }

    return labels;
  }

  /** Keyed by `<space>:<key>`, with `:<key>` for the org-wide statuses a task may also use. */
  private async loadTaskStatusNames(
    organizationId: string,
  ): Promise<Map<string, string>> {
    const { data, error } = await this.client
      .from('task_statuses')
      .select('space_id, key, name')
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);

    const names = new Map<string, string>();

    for (const row of (data ?? []) as {
      space_id: string | null;
      key: string;
      name: string;
    }[]) {
      names.set(`${row.space_id ?? ''}:${row.key}`, row.name);
      if (!names.has(`:${row.key}`)) names.set(`:${row.key}`, row.name);
    }

    return names;
  }

  private cellValue(
    item: IFilterResultItem,
    column: ExportColumn,
    fieldsByName: Map<string, IFilterFieldDefinition>,
    lookups: Lookups,
    pullRequests: Map<string, string[]>,
    locale: FilterExportLocale,
    timeZone: string,
  ): ExportCell {
    const blankToNull = (text: string): string | null =>
      cleanText(text) || null;
    const field = fieldsByName.get(column.id);

    if (field?.isCustomField) {
      return this.customFieldValue(
        item.custom_field_values?.[column.id.replace(/^cf_/, '')],
        field,
        lookups,
        locale,
        timeZone,
      );
    }

    switch (column.id) {
      case 'entity_type':
        return EXPORT_STRINGS[locale][item.entity_type];
      case 'status':
        return blankToNull(this.statusName(item, lookups));
      case 'priority':
        return blankToNull(humanizeKey(item.priority));
      case 'assigned_to':
      case 'reporter':
        return blankToNull(this.userValue(item[column.id], lookups));
      case 'created_at':
      case 'updated_at':
      case 'due_date':
      case 'start_date':
        return toDate(item[column.id], column.kind, timeZone);
      case 'description':
        return blankToNull(htmlToText(item.description ?? ''));
      case 'request_type':
        return UUID_RE.test(item.request_type ?? '')
          ? null
          : blankToNull(humanizeKey(item.request_type));
      case PR_COLUMN:
        return blankToNull((pullRequests.get(item.id) ?? []).join('\n'));
      case BUILD_COLUMN:
        return blankToNull(humanizeKey(item._entity?.git_build_state));
      default:
        return blankToNull(
          String(item[column.id as 'key' | 'title' | 'space_name'] ?? ''),
        );
    }
  }

  private statusName(item: IFilterResultItem, lookups: Lookups): string {
    const status = item.status ?? '';

    if (item.entity_type === 'task') {
      const name =
        lookups.statuses.get(`${item.space_id}:${status}`) ??
        lookups.statuses.get(`:${status}`);

      if (name) return name;
    }

    return humanizeKey(status);
  }

  private userValue(value: unknown, lookups: Lookups): string {
    if (typeof value === 'string') return lookups.users.get(value) ?? '';

    return value && typeof value === 'object'
      ? personName(value as Parameters<typeof personName>[0])
      : '';
  }

  private customFieldValue(
    value: unknown,
    field: IFilterFieldDefinition,
    lookups: Lookups,
    locale: FilterExportLocale,
    timeZone: string,
  ): ExportCell {
    if (value === null || value === undefined || value === '') return null;

    const type = field.customFieldType ?? '';
    const strings = EXPORT_STRINGS[locale];
    const joined = (parts: string[]) =>
      parts.filter(Boolean).join(', ') || null;
    const entries = asList(value);

    switch (type) {
      case 'number': {
        const parsed = Number(value);

        return Number.isFinite(parsed) ? parsed : null;
      }
      case 'date':
      case 'datetime':
        return toDate(value, type === 'date' ? 'date' : 'datetime', timeZone);
      case 'checkbox':
        return value === true || value === 'true' ? strings.yes : strings.no;
      case 'user_select':
      case 'user_multi':
        return joined(entries.map((id) => lookups.users.get(String(id)) ?? ''));
      case 'editor':
        return typeof value === 'string' ? htmlToText(value) || null : null;
    }

    const linkedType = LINKED_FIELD_TYPES[type];

    if (linkedType) {
      return joined(
        entries.map(
          (id) => lookups.linked[linkedType]?.get(scalarText(id)) ?? '',
        ),
      );
    }

    const optionLabels = new Map(
      field.values?.map((option) => [option.name, option.label]) ?? [],
    );

    return joined(
      entries.map((entry) => {
        if (entry && typeof entry === 'object') {
          const named = entry as { label?: unknown; name?: unknown };

          return cleanText(scalarText(named.label ?? named.name));
        }

        const text = scalarText(entry);

        if (optionLabels.has(text)) return optionLabels.get(text) as string;

        return UUID_RE.test(text) ? '' : cleanText(text);
      }),
    );
  }

  private entityHref(item: IFilterResultItem, baseUrl: string): string | null {
    const key = encodeURIComponent(item.key ?? '');

    switch (item.entity_type) {
      case 'process':
        return `${baseUrl}/processes/view/${key}`;
      case 'task':
        return `${baseUrl}/tasks/view/${key}`;
      case 'wiki_page': {
        const spaceKey = (item._entity?.space as { key?: string } | null)?.key;

        return spaceKey
          ? `${baseUrl}/spaces/${encodeURIComponent(spaceKey)}/wiki/${item.id}`
          : null;
      }
      default:
        return null;
    }
  }

  /** A readable one-liner of the query for the report header; ids are left out. */
  private describeQuery(
    query: Record<string, unknown>,
    fieldsByName: Map<string, IFilterFieldDefinition>,
    locale: FilterExportLocale,
  ): string {
    const strings = EXPORT_STRINGS[locale];

    const describe = (node: Record<string, unknown>, top: boolean): string => {
      if (Array.isArray(node['rules'])) {
        const parts = (node['rules'] as Record<string, unknown>[])
          .map((rule) => describe(rule, false))
          .filter(Boolean);
        const text = parts.join(
          ` ${node['combinator'] === 'or' ? strings.or : strings.and} `,
        );

        if (!text) return '';

        const grouped = top || parts.length === 1 ? text : `(${text})`;

        return node['not'] ? `${strings.not} ${grouped}` : grouped;
      }

      const name = scalarText(node['field']);
      const field = fieldsByName.get(name);
      const operatorName = scalarText(node['operator']);
      const operator =
        field?.operators?.find((op) => op.name === operatorName)?.label ??
        operatorName;
      const value = node['value'];
      const values = (
        value === null || value === undefined ? [] : asList(value)
      )
        .map(scalarText)
        .map(
          (entry) =>
            field?.values?.find((option) => option.name === entry)?.label ??
            entry,
        )
        .filter((entry) => !UUID_RE.test(entry));

      return cleanText(
        [field?.label ?? name, operator, values.join(', ')]
          .filter(Boolean)
          .join(' '),
      );
    };

    return describe(query, true);
  }
}
