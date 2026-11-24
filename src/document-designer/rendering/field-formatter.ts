/**
 * @fileoverview Value formatting for document field bindings and `{{token}}`
 * interpolation. Every function returns HTML-SAFE output: plain values are
 * entity-escaped via {@link escapeHtml}; HTML-capable values (editor custom
 * fields, task descriptions) are sanitized via the shared sanitizer when
 * `format.renderHtml` is set, otherwise stripped to text.
 * @module src/document-designer/rendering/field-formatter
 */

import { format as formatDateFns } from 'date-fns';
import { SYSTEM_FIELDS_BY_ENTITY } from '../bindable-fields.service';
import type {
  DocumentSourceEntity,
  IDocFieldBinding,
  IDocFieldFormat,
} from '../template-definition/template-definition.types';
import {
  extractWikiPlainText,
  tiptapToHtml,
} from '../../wiki/wiki-content.util';
import type {
  IDocumentDataContext,
  IDocumentFieldDef,
} from './document-data-resolver.service';
import { sanitizeHtml, stripHtmlToText } from './html-sanitizer';
import {
  formatBytes,
  formatDuration,
  TASK_LIST_LABELS,
  TASK_LIST_ROW_FIELDS,
  taskListRowSource,
  type TaskListSource,
} from './task-list-sources';

export const DEFAULT_DATE_FORMAT = 'dd.MM.yyyy';

/** Render-time context for `meta` bindings (export date, item counters, …). */
export interface IDocumentMetaContext {
  exportDate: Date;
  exportedByUserId?: string | null;
  /** 1-based index of the current top-level item. */
  itemIndex?: number;
  itemCount?: number;
  /** Name of the template that produced this document. */
  templateName?: string | null;
  templateDescription?: string | null;
  /**
   * When the template was last edited. `document_templates` has no version
   * column, so this is the closest thing to a revision marker.
   */
  templateUpdatedAt?: Date | null;
  /** Which module the template is bound to — drives generic system-field type dispatch. */
  sourceEntity?: DocumentSourceEntity;
}

const META_KEYS = new Set([
  'exportDate',
  'exportedBy',
  'organizationName',
  'itemIndex',
  'itemCount',
  'templateName',
  'templateDescription',
  'templateUpdatedAt',
]);

/**
 * Coerce an unknown value to text without relying on Object's default
 * `[object Object]` stringification (objects become JSON).
 */
function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/** Escape a value for insertion into HTML text or attribute context. */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return toText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Format a field binding for the current item into HTML-safe markup.
 * Missing/unknown fields yield `''` and push a warning.
 */
export function formatFieldValue(
  binding: IDocFieldBinding,
  rawItem: Record<string, unknown> | null,
  dataCtx: IDocumentDataContext,
  meta: IDocumentMetaContext,
  warnings: string[],
): string {
  const listSource = taskListRowSource(rawItem);
  if (listSource && binding.source !== 'meta') {
    return formatTaskListRowField(
      listSource,
      binding,
      rawItem as Record<string, unknown>,
      dataCtx,
      warnings,
    );
  }

  switch (binding.source) {
    case 'meta':
      return formatMetaField(binding, dataCtx, meta, warnings);
    case 'system':
      return formatSystemField(binding, rawItem, dataCtx, meta, warnings);
    case 'custom_field':
      return formatCustomField(binding, rawItem, dataCtx, warnings);
    default:
      warnings.push(`Unknown binding source for field ${binding.fieldKey}`);
      return '';
  }
}

/**
 * Resolve a `{{token}}` key to PLAIN TEXT (unescaped — callers escape before
 * inserting into HTML). Source detection: meta keys → meta, keys present on
 * the raw row → system, otherwise custom field.
 */
export function resolveTokenText(
  fieldKey: string,
  rawItem: Record<string, unknown> | null,
  dataCtx: IDocumentDataContext,
  meta: IDocumentMetaContext,
  warnings: string[],
): string {
  const source: IDocFieldBinding['source'] = META_KEYS.has(fieldKey)
    ? 'meta'
    : rawItem && Object.prototype.hasOwnProperty.call(rawItem, fieldKey)
      ? 'system'
      : 'custom_field';

  const html = formatFieldValue(
    { source, fieldKey, format: { renderHtml: false } },
    rawItem,
    dataCtx,
    meta,
    warnings,
  );

  return decodeBasicEntities(html);
}

// ─────────────────────────────────────────────────────────────────────────────
// Meta
// ─────────────────────────────────────────────────────────────────────────────

function formatMetaField(
  binding: IDocFieldBinding,
  dataCtx: IDocumentDataContext,
  meta: IDocumentMetaContext,
  warnings: string[],
): string {
  switch (binding.fieldKey) {
    case 'exportDate':
      return escapeHtml(
        formatDateValue(meta.exportDate, binding.format, warnings),
      );
    case 'exportedBy':
      return escapeHtml(
        formatUser(meta.exportedByUserId, binding.format, dataCtx, warnings),
      );
    case 'organizationName':
      return escapeHtml(dataCtx.lookups.organizationName);
    case 'itemIndex':
      return escapeHtml(meta.itemIndex != null ? String(meta.itemIndex) : '');
    case 'itemCount':
      return escapeHtml(meta.itemCount != null ? String(meta.itemCount) : '');
    case 'templateName':
      return escapeHtml(meta.templateName ?? '');
    case 'templateDescription':
      return escapeHtml(meta.templateDescription ?? '');
    case 'templateUpdatedAt':
      // Reuses formatDateValue so it honours the same format options as exportDate.
      return escapeHtml(
        meta.templateUpdatedAt
          ? formatDateValue(meta.templateUpdatedAt, binding.format, warnings)
          : '',
      );
    default:
      warnings.push(`Unknown meta field: ${binding.fieldKey}`);
      return '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// System
// ─────────────────────────────────────────────────────────────────────────────

function formatSystemField(
  binding: IDocFieldBinding,
  rawItem: Record<string, unknown> | null,
  dataCtx: IDocumentDataContext,
  meta: IDocumentMetaContext,
  warnings: string[],
): string {
  if (!rawItem) {
    warnings.push(
      `System field ${binding.fieldKey} has no item context (rendered empty)`,
    );
    return '';
  }

  const key = binding.fieldKey;
  const value = rawItem[key];

  // Keys needing bespoke logic beyond simple type dispatch: space_name/labels
  // have no plain 1:1 column value at all; content is wiki's only field whose
  // format varies per-row (see the 'content' case below).
  switch (key) {
    case 'space_name': {
      const spaceId = rawItem['space_id'];
      const space =
        typeof spaceId === 'string'
          ? dataCtx.lookups.spacesById[spaceId]
          : undefined;
      return escapeHtml(space?.name ?? '');
    }
    case 'labels':
      return escapeHtml(Array.isArray(value) ? value.join(', ') : '');
    case 'content': {
      // wiki_pages.content is HTML for most rows, but Editor.js JSON or
      // Tiptap JSON for others (wiki_pages.content_format) — routing those
      // through the HTML formatter would print the raw JSON. Reuse the same
      // format-aware plain-text extractor the MCP read path already uses
      // rather than writing a second Editor.js/Tiptap parser.
      const contentFormat = rawItem['content_format'];

      // Tiptap JSON asked for as rich text: serialize it instead of flattening. The plain-text
      // extractor reads only an image's `alt`, so every picture on a wiki page was absent from
      // every exported document. Plain text stays the default, so templates that never set
      // `renderHtml` are unchanged.
      if (contentFormat === 'tiptap' && binding.format?.renderHtml) {
        return formatHtmlValue(tiptapToHtml(value), binding.format);
      }

      if (contentFormat === 'editorjs' || contentFormat === 'tiptap') {
        return escapeHtml(extractWikiPlainText(value, contentFormat as string));
      }
      return formatHtmlValue(value, binding.format);
    }
    default:
      break;
  }

  if (!Object.prototype.hasOwnProperty.call(rawItem, key)) {
    warnings.push(`Unknown system field: ${key}`);
    return '';
  }

  // Generic dispatch by the field's declared type — the same per-module
  // catalog the Fields panel uses (bindable-fields.service.ts), so every
  // module's system columns are covered uniformly instead of a per-key list
  // that only ever grew for the module it was originally written against.
  const fieldType = findSystemFieldType(meta.sourceEntity, key);

  switch (fieldType) {
    case 'status':
    case 'priority': {
      // `${key}_id` is only a real column on tasks (status_id/priority_id);
      // any other module's differently-named status field (e.g. wiki's
      // workflow_status) simply has no such column and falls through to the
      // humanized raw value, same as it always did for those modules.
      const refId = rawItem[`${key}_id`];
      const lookupDict =
        fieldType === 'status'
          ? dataCtx.lookups.statusesById
          : dataCtx.lookups.prioritiesById;
      const lookup =
        (typeof refId === 'string' && lookupDict[refId]) ||
        (typeof value === 'string' && lookupDict[value]) ||
        null;
      return escapeHtml(lookup ? lookup.name : humanize(value));
    }
    case 'user':
      return escapeHtml(formatUser(value, binding.format, dataCtx, warnings));
    case 'date':
      if (value === null || value === undefined || value === '') return '';

      return escapeHtml(formatDateValue(value, binding.format, warnings));
    case 'number':
      if (value === null || value === undefined || value === '') return '';

      return escapeHtml(formatNumber(value, binding.format));
    case 'boolean':
      if (value === null || value === undefined || value === '') return '';

      return escapeHtml(value === true || value === 'true' ? 'Yes' : 'No');
    case 'html':
      return formatHtmlValue(value, binding.format);
    default:
      if (value === null || value === undefined) return '';

      return escapeHtml(value);
  }
}

/** Declared `fieldType` for a system column, per bindable-fields.service.ts's per-module catalog. */
function findSystemFieldType(
  sourceEntity: DocumentSourceEntity | undefined,
  key: string,
): string | undefined {
  if (!sourceEntity) return undefined;

  return SYSTEM_FIELDS_BY_ENTITY[sourceEntity]?.find((f) => f.key === key)
    ?.fieldType;
}

// Task list rows (comments, history, …) — typed by the row catalog

function formatTaskListRowField(
  listSource: TaskListSource,
  binding: IDocFieldBinding,
  row: Record<string, unknown>,
  dataCtx: IDocumentDataContext,
  warnings: string[],
): string {
  const listLabel = TASK_LIST_LABELS[listSource].en;
  const field = TASK_LIST_ROW_FIELDS[listSource].find(
    (entry) => entry.key === binding.fieldKey,
  );
  if (!field) {
    pushWarningOnce(
      warnings,
      `Field ${binding.fieldKey} is not available in ${listLabel} rows (rendered empty)`,
    );
    return '';
  }

  const value = row[field.key];
  if (value === null || value === undefined || value === '') return '';

  // Row-dependent warnings (a user id, a date) would repeat once per row — collapse them.
  const rowWarnings: string[] = [];
  let html: string;

  switch (field.fieldType) {
    case 'user':
      html = escapeHtml(
        formatUser(value, binding.format, dataCtx, rowWarnings),
      );
      if (rowWarnings.length > 0) {
        pushWarningOnce(
          warnings,
          `${listLabel}: some users are not members of this organization or no longer exist (rendered empty)`,
        );
      }
      return html;
    case 'date':
      html = escapeHtml(formatDateValue(value, binding.format, rowWarnings));
      for (const warning of rowWarnings) pushWarningOnce(warnings, warning);
      return html;
    case 'number':
      return escapeHtml(formatNumber(value, binding.format));
    case 'boolean':
      return escapeHtml(value === true || value === 'true' ? 'Yes' : 'No');
    case 'html':
      return formatHtmlValue(value, binding.format);
    case 'bytes':
      return escapeHtml(formatBytes(Number(value)));
    case 'duration':
      return escapeHtml(formatDuration(Number(value)));
    default:
      return escapeHtml(value);
  }
}

function pushWarningOnce(warnings: string[], message: string): void {
  if (!warnings.includes(message)) warnings.push(message);
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom fields
// ─────────────────────────────────────────────────────────────────────────────

function formatCustomField(
  binding: IDocFieldBinding,
  rawItem: Record<string, unknown> | null,
  dataCtx: IDocumentDataContext,
  warnings: string[],
): string {
  const key = binding.fieldKey.startsWith('cf_')
    ? binding.fieldKey.slice(3)
    : binding.fieldKey;

  const def = resolveFieldDef(key, rawItem, dataCtx);
  if (!def) {
    warnings.push(`Unknown custom field: ${key}`);
    return '';
  }

  const customValues = rawItem?.['custom_field_values'];
  const value =
    customValues && typeof customValues === 'object'
      ? (customValues as Record<string, unknown>)[key]
      : undefined;

  const isEmpty =
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0);
  if (isEmpty) return escapeHtml('-');

  switch (def.field_type) {
    case 'checkbox':
      return escapeHtml(value === true || value === 'true' ? 'Yes' : 'No');
    case 'select':
    case 'radio':
    case 'cascading_select':
    case 'list_item':
      return escapeHtml(optionLabel(def, value));
    case 'multiselect':
    case 'issue_group':
    case 'label':
    case 'list_item_multi': {
      const values = Array.isArray(value)
        ? value
        : toText(value)
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean);
      return escapeHtml(
        values.map((entry) => optionLabel(def, entry)).join(', '),
      );
    }
    case 'date':
    case 'datetime':
      return escapeHtml(formatDateValue(value, binding.format, warnings));
    case 'user_select':
      return escapeHtml(formatUser(value, binding.format, dataCtx, warnings));
    case 'user_multi': {
      const values = Array.isArray(value) ? value : [value];
      return escapeHtml(
        values
          .map((entry) => formatUser(entry, binding.format, dataCtx, warnings))
          .filter(Boolean)
          .join(', '),
      );
    }
    // Names are resolved ahead of render time by DocumentDataResolverService
    // (fetchAssetLookups), one object at a time through the same ACL-respecting
    // per-object-type can_view check the assets module uses everywhere else —
    // never a batched/admin-client lookup. See dataCtx.lookups.assetsById.
    case 'asset':
    case 'asset_multi': {
      const values = Array.isArray(value) ? value : [value];
      return escapeHtml(
        values
          .map((entry) =>
            typeof entry === 'string' && entry
              ? (dataCtx.lookups.assetsById[entry]?.name ?? '-')
              : '',
          )
          .filter(Boolean)
          .join(', '),
      );
    }
    case 'editor':
      return formatHtmlValue(value, binding.format);
    case 'number':
      return escapeHtml(formatNumber(value, binding.format));
    case 'task': {
      const taskId = toText(value);
      const lookup = dataCtx.lookups.tasksById[taskId];
      if (!lookup) {
        warnings.push(`Task ${taskId} not found in lookup (rendered empty)`);
        return '';
      }
      return escapeHtml(
        lookup.key ? `${lookup.key} — ${lookup.name}` : lookup.name,
      );
    }
    case 'wiki_page': {
      const pageId = toText(value);
      const lookup = dataCtx.lookups.wikiPagesById[pageId];
      if (!lookup) {
        warnings.push(
          `Wiki page ${pageId} not found in lookup (rendered empty)`,
        );
        return '';
      }
      return escapeHtml(lookup.name);
    }
    // `file`/`file_multi` values are self-contained refs (name/mime/size
    // denormalised at write time, see fileFieldRefSchema in
    // custom-field.model.ts) — no lookup needed, unlike task/wiki_page/asset.
    case 'file':
      return escapeHtml(fileRefName(value));
    case 'file_multi': {
      const values = Array.isArray(value) ? value : [value];
      return escapeHtml(
        values
          .map((entry) => fileRefName(entry))
          .filter(Boolean)
          .join(', '),
      );
    }
    case 'grid':
      return formatGridValue(value, def);
    default:
      // string, url, time, … → raw string fallback.
      return escapeHtml(value);
  }
}

function fileRefName(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const name = (value as Record<string, unknown>)['name'];
  return typeof name === 'string' ? name : '';
}

/** Renders a `grid` value as an HTML table using the field's column definitions (`def.options`). */
function formatGridValue(value: unknown, def: IDocumentFieldDef): string {
  const rows = Array.isArray(value) ? value : [];
  const columns = def.options;

  if (!columns || columns.length === 0) {
    return escapeHtml(
      rows
        .map((row) =>
          toText(
            row && typeof row === 'object'
              ? (row as Record<string, unknown>)['values']
              : row,
          ),
        )
        .join('; '),
    );
  }

  const headerHtml = columns
    .map((col) => `<th>${escapeHtml(col.label)}</th>`)
    .join('');
  const rowsHtml = rows
    .map((row) => {
      const cellValues =
        row && typeof row === 'object'
          ? ((row as Record<string, unknown>)['values'] as
              | Record<string, unknown>
              | undefined)
          : undefined;
      const cellsHtml = columns
        .map(
          (col) =>
            `<td>${escapeHtml(cellValues?.[col.value])}&nbsp;&nbsp;</td>`,
        )
        .join('');
      return `<tr>${cellsHtml}</tr>`;
    })
    .join('');

  return `<table class="doc-grid-table"><thead><tr>${headerHtml}</tr></thead><tbody>${rowsHtml}</tbody></table>`;
}

export function resolveFieldDef(
  key: string,
  rawItem: Record<string, unknown> | null,
  dataCtx: IDocumentDataContext,
): IDocumentFieldDef | null {
  // Org-scoped definitions win over space-scoped ones (mirrors the dedupe
  // rule in the bindable-fields catalog).
  const orgDef = dataCtx.orgFieldDefs[key];
  if (orgDef) return orgDef;

  const spaceId = rawItem?.['space_id'];
  if (typeof spaceId === 'string') {
    const spaceDef = dataCtx.fieldDefsBySpace[spaceId]?.[key];
    if (spaceDef) return spaceDef;
  }

  // Fall back to any space's definition of the key (formatting hint only).
  for (const defs of Object.values(dataCtx.fieldDefsBySpace)) {
    if (defs[key]) return defs[key];
  }
  return null;
}

function optionLabel(def: IDocumentFieldDef, value: unknown): string {
  const asString = toText(value);
  const option = def.options.find((entry) => entry.value === asString);
  return option?.label ?? asString;
}

// ─────────────────────────────────────────────────────────────────────────────
// Primitive formatters
// ─────────────────────────────────────────────────────────────────────────────

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a raw value into a Date. Date-ONLY strings (Postgres `date` columns,
 * e.g. '2026-07-19') are parsed as LOCAL dates — `new Date('2026-07-19')`
 * parses UTC midnight, which date-fns then formats in the server's local
 * timezone and renders the PREVIOUS calendar day on any server west of UTC.
 * Local parsing keeps the calendar day stable regardless of server TZ.
 */
function parseDateValue(value: unknown): Date {
  if (value instanceof Date) return value;

  const text = toText(value).trim();
  if (DATE_ONLY_REGEX.test(text)) {
    const [year, month, day] = text.split('-').map(Number);
    return new Date(year, month - 1, day);
  }
  return new Date(text);
}

function formatDateValue(
  value: unknown,
  format: IDocFieldFormat | undefined,
  warnings: string[],
): string {
  const date = parseDateValue(value);
  if (Number.isNaN(date.getTime())) {
    return toText(value);
  }

  const pattern = format?.dateFormat ?? DEFAULT_DATE_FORMAT;
  try {
    return formatDateFns(date, pattern);
  } catch {
    warnings.push(`Invalid date format '${pattern}' (used default)`);
    return formatDateFns(date, DEFAULT_DATE_FORMAT);
  }
}

function formatNumber(
  value: unknown,
  format: IDocFieldFormat | undefined,
): string {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return toText(value);

  switch (format?.numberFormat) {
    case 'percent':
      return `${new Intl.NumberFormat('en-US', {
        maximumFractionDigits: 2,
      }).format(num)}%`;
    case 'currency':
      try {
        return new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: format?.currency ?? 'EUR',
        }).format(num);
      } catch {
        return new Intl.NumberFormat('en-US', {
          maximumFractionDigits: 2,
        }).format(num);
      }
    default:
      return new Intl.NumberFormat('en-US', {
        maximumFractionDigits: 2,
      }).format(num);
  }
}

function formatUser(
  value: unknown,
  format: IDocFieldFormat | undefined,
  dataCtx: IDocumentDataContext,
  warnings: string[],
): string {
  if (value === null || value === undefined || value === '') return '';

  const userId = toText(value);
  const user = dataCtx.lookups.usersById[userId];
  if (!user) {
    warnings.push(`User ${userId} not found in lookup (rendered empty)`);
    return '';
  }

  if (format?.userDisplay === 'email') return user.email ?? '';

  const name = [user.first_name, user.last_name]
    .filter(Boolean)
    .join(' ')
    .trim();
  return name || user.email || '';
}

function formatHtmlValue(
  value: unknown,
  format: IDocFieldFormat | undefined,
): string {
  if (value === null || value === undefined || value === '') return '';
  const html = toText(value);
  return format?.renderHtml ? sanitizeHtml(html) : stripHtmlToText(html);
}

function humanize(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = toText(value).replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Reverse the escaping applied by {@link escapeHtml} for plain-text token
 * resolution ({@link resolveTokenText} funnels through the HTML formatter and
 * needs the raw text back — the renderer re-escapes on insertion).
 */
function decodeBasicEntities(html: string): string {
  return html
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
