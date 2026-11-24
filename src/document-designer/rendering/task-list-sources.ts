/**
 * @fileoverview Task list sources for the Document Designer: the seven loop
 * dataSources that list an exported task's own comments, history,
 * attachments, SLA cycles, relations, linked wiki pages and linked assets —
 * their row-field catalogs, the virtual `<source>_count` task fields and the
 * value helpers shared by the list resolver and the field formatter.
 * Pure: type-only imports, so the resolver/renderers can import it without a
 * require cycle.
 * @module src/document-designer/rendering/task-list-sources
 */

import type {
  IBindableField,
  IDocElement,
  TaskListSource,
} from '../template-definition/template-definition.types';

export type { TaskListSource };

/** Contract order — mirrors the frontend's list. */
export const TASK_LIST_SOURCES = [
  'comments',
  'history',
  'attachments',
  'sla_history',
  'relations',
  'linked_wiki_pages',
  'linked_assets',
] as const satisfies readonly TaskListSource[];

/** Max ids per `.in()` filter in the list queries (keeps request URLs short). */
export const LIST_CHUNK_SIZE = 100;

/** Marker key every list row carries — the formatter / pass-fail guards key off it. */
export const TASK_LIST_ROW_SOURCE_KEY = '_row_source';

export function isTaskListSource(value: unknown): value is TaskListSource {
  return (
    typeof value === 'string' &&
    (TASK_LIST_SOURCES as readonly string[]).includes(value)
  );
}

/** The list a row belongs to, or null for any other row (tasks, subtasks, …). */
export function taskListRowSource(
  row: Record<string, unknown> | null | undefined,
): TaskListSource | null {
  const source = row?.[TASK_LIST_ROW_SOURCE_KEY];

  return isTaskListSource(source) ? source : null;
}

export const TASK_LIST_LABELS: Record<
  TaskListSource,
  { en: string; de: string }
> = {
  comments: { en: 'Comments', de: 'Kommentare' },
  history: { en: 'History', de: 'Verlauf' },
  attachments: { en: 'Attachments', de: 'Anhänge' },
  sla_history: { en: 'SLA history', de: 'SLA-Verlauf' },
  relations: { en: 'Relations', de: 'Beziehungen' },
  linked_wiki_pages: { en: 'Linked wiki pages', de: 'Verknüpfte Wiki-Seiten' },
  linked_assets: { en: 'Linked assets', de: 'Verknüpfte Assets' },
};

const rowField =
  (listSource: TaskListSource) =>
  (
    key: string,
    en: string,
    de: string,
    fieldType = 'string',
  ): IBindableField => ({
    key,
    label: { en, de },
    source: 'system',
    fieldType,
    listSource,
  });

const comment = rowField('comments');
const history = rowField('history');
const attachment = rowField('attachments');
const sla = rowField('sla_history');
const relation = rowField('relations');
const wiki = rowField('linked_wiki_pages');
const asset = rowField('linked_assets');

/** Row catalogs. Types: string | html | user | date | number | boolean | bytes | duration. */
export const TASK_LIST_ROW_FIELDS: Record<TaskListSource, IBindableField[]> = {
  comments: [
    comment('author', 'Author', 'Autor', 'user'),
    comment('created_at', 'Posted at', 'Erstellt am', 'date'),
    comment('updated_at', 'Edited at', 'Bearbeitet am', 'date'),
    comment('is_edited', 'Edited', 'Bearbeitet', 'boolean'),
    comment('content', 'Comment', 'Kommentar', 'html'),
  ],
  history: [
    history('changed_at', 'Date', 'Datum', 'date'),
    history('changed_by', 'Changed by', 'Geändert von', 'user'),
    history('action', 'Action', 'Aktion'),
    history('field', 'Field', 'Feld'),
    history('old_value', 'Old value', 'Alter Wert'),
    history('new_value', 'New value', 'Neuer Wert'),
  ],
  attachments: [
    attachment('file_name', 'File name', 'Dateiname'),
    attachment('kind', 'Kind', 'Art'),
    attachment('file_type', 'File type', 'Dateityp'),
    attachment('file_size', 'Size', 'Größe', 'bytes'),
    attachment('version', 'Version', 'Version', 'number'),
    attachment('uploaded_by', 'Uploaded by', 'Hochgeladen von', 'user'),
    attachment('uploaded_at', 'Uploaded at', 'Hochgeladen am', 'date'),
  ],
  sla_history: [
    sla('metric', 'SLA', 'SLA'),
    sla('cycle', 'Cycle', 'Zyklus', 'number'),
    sla('state', 'State', 'Status'),
    sla('outcome', 'Outcome', 'Ergebnis'),
    sla('target', 'Target', 'Ziel', 'duration'),
    sla('elapsed', 'Elapsed', 'Verstrichen', 'duration'),
    sla('deadline_at', 'Deadline', 'Frist', 'date'),
    sla('started_at', 'Started', 'Gestartet', 'date'),
    sla('completed_at', 'Completed', 'Abgeschlossen', 'date'),
    sla('calendar', 'Calendar', 'Kalender'),
  ],
  relations: [
    relation('relation', 'Relation', 'Beziehung'),
    relation('item_type', 'Type', 'Typ'),
    relation('item_key', 'Key', 'Schlüssel'),
    relation('item_title', 'Title', 'Titel'),
    relation('item_status', 'Status', 'Status'),
    relation('linked_at', 'Linked at', 'Verknüpft am', 'date'),
  ],
  linked_wiki_pages: [
    wiki('page_title', 'Title', 'Titel'),
    wiki('space', 'Space', 'Bereich'),
    wiki('is_published', 'Published', 'Veröffentlicht', 'boolean'),
    wiki('linked_at', 'Linked at', 'Verknüpft am', 'date'),
  ],
  linked_assets: [
    asset('asset_key', 'Key', 'Schlüssel'),
    asset('name', 'Name', 'Name'),
    asset('asset_type', 'Type', 'Typ'),
    asset('schema', 'Schema', 'Schema'),
    asset('relation', 'Relation', 'Beziehung'),
    asset('linked_at', 'Linked at', 'Verknüpft am', 'date'),
  ],
};

export function countKeyOf(source: TaskListSource): string {
  return `${source}_count`;
}

/** The list a `<source>_count` key counts, or null for any other key. */
export function taskListSourceOfCountKey(key: string): TaskListSource | null {
  if (!key.endsWith('_count')) return null;
  const source = key.slice(0, -'_count'.length);

  return isTaskListSource(source) ? source : null;
}

/** Virtual task fields appended to the Task catalog (stamped on export). */
export const TASK_LIST_COUNT_FIELDS: IBindableField[] = TASK_LIST_SOURCES.map(
  (source) => ({
    key: countKeyOf(source),
    label: {
      en: `${TASK_LIST_LABELS[source].en} count`,
      de: `Anzahl ${TASK_LIST_LABELS[source].de}`,
    },
    source: 'system',
    fieldType: 'number',
    virtual: true,
  }),
);

export interface ITaskListSourceCatalogEntry {
  key: TaskListSource;
  label: { en: string; de: string };
  fields: IBindableField[];
}

/** `listSources` of the Tasks bindable-fields response. */
export const TASK_LIST_SOURCES_CATALOG: ITaskListSourceCatalogEntry[] =
  TASK_LIST_SOURCES.map((key) => ({
    key,
    label: TASK_LIST_LABELS[key],
    fields: TASK_LIST_ROW_FIELDS[key],
  }));

// Table layout

/** Elements that become table columns; shapes and lines are card decoration, not data. */
const TABLE_CELL_TYPES = new Set(['field', 'text', 'link', 'image']);

/**
 * A list's table columns: its cell elements in reading order — designed lines top to bottom (elements that
 * overlap vertically share a line), each line left to right — so a one-row preset maps 1:1 and a card becomes
 * one column per box.
 */
export function listTableColumns(children: IDocElement[]): IDocElement[] {
  const cells = children
    .filter((el) => TABLE_CELL_TYPES.has(el.type))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: IDocElement[][] = [];
  let lineBottom = -Infinity;

  for (const el of cells) {
    if (lines.length > 0 && el.y < lineBottom) {
      lines[lines.length - 1].push(el);
      lineBottom = Math.max(lineBottom, el.y + el.height);
    } else {
      lines.push([el]);
      lineBottom = el.y + el.height;
    }
  }

  return lines.flatMap((line) => line.sort((a, b) => a.x - b.x));
}

/** Header text of a list column: the field's designer label, else its catalog label; '' for other cells. */
export function listColumnLabel(
  source: TaskListSource,
  el: IDocElement,
): string {
  if (el.type !== 'field') return '';
  if (el.binding.label) return el.binding.label;

  return (
    TASK_LIST_ROW_FIELDS[source].find(
      (field) => field.key === el.binding.fieldKey,
    )?.label.en ?? el.binding.fieldKey
  );
}

// Value helpers

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** 1024-based size: "512 B", "1.2 KB", "3.4 MB", "1.1 GB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '';
  let value = Math.abs(bytes);
  let unit = 0;

  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1);

  return `${bytes < 0 ? '-' : ''}${text} ${BYTE_UNITS[unit]}`;
}

/** Milliseconds as "3d 4h" (≥ 1 day), "2h 05m" (≥ 1 hour) or "45m"; "-" prefix when negative. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const totalMinutes = Math.floor(Math.abs(ms) / 60000);
  if (totalMinutes === 0) return '0m';

  const sign = ms < 0 ? '-' : '';
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${sign}${days}d ${hours}h`;
  if (hours > 0) return `${sign}${hours}h ${String(minutes).padStart(2, '0')}m`;

  return `${sign}${minutes}m`;
}

export interface IRelationTypeLabelSource {
  name?: string | null;
  outward_description?: string | null;
  inward_description?: string | null;
  is_directional?: boolean | null;
}

/** Direction-aware relation label, same as the Relations tab: non-directional types use their name. */
export function relationLabel(
  type: IRelationTypeLabelSource | null | undefined,
  direction: 'outward' | 'inward',
): string {
  if (!type) return '';
  if (type.is_directional === false) return type.name ?? '';

  const description =
    direction === 'outward'
      ? type.outward_description
      : type.inward_description;

  return description || type.name || '';
}

/** "not_applicable" → "Not applicable". */
export function humanizeValue(value: string): string {
  const text = value.replace(/_/g, ' ').trim();

  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "field_updated" → "Field Updated". */
export function titleCase(value: string): string {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

const HISTORY_ACTION_LABELS: Record<string, string> = {
  create: 'Created',
  update: 'Updated',
  status_change: 'Status changed',
  assign: 'Assigned',
  unassign: 'Unassigned',
  subtask_created: 'Subtask created',
  comment_added: 'Comment added',
  comment_updated: 'Comment edited',
  comment_deleted: 'Comment deleted',
  attachment_added: 'Attachment added',
  attachment_deleted: 'Attachment deleted',
  relationship_added: 'Relation added',
  relationship_deleted: 'Relation removed',
};

export function historyActionLabel(action: unknown): string {
  if (typeof action !== 'string' || !action) return '';

  return HISTORY_ACTION_LABELS[action] ?? titleCase(action);
}

/**
 * A history old/new value as text. Scalars go through `scalar` (the caller
 * resolves ids, statuses, dates there); objects follow the shapes the task
 * history writers store; arrays are joined.
 */
export function historyValueText(
  value: unknown,
  scalar: (value: string | number | boolean) => string,
  htmlToText: (html: string) => string,
): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value
      .map((entry) => historyValueText(entry, scalar, htmlToText))
      .filter(Boolean)
      .join(', ');
  }
  if (typeof value === 'object') {
    return historyObjectText(value as Record<string, unknown>, htmlToText);
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return scalar(value);
  }

  return '';
}

function historyObjectText(
  value: Record<string, unknown>,
  htmlToText: (html: string) => string,
): string {
  const text = (entry: unknown): string =>
    typeof entry === 'string'
      ? entry
      : typeof entry === 'number'
        ? String(entry)
        : '';

  // {key, summary} task refs, {target_key, target_summary|target_title} relations
  const key = text(value['key']) || text(value['target_key']);
  const title =
    text(value['summary']) ||
    text(value['target_summary']) ||
    text(value['target_title']) ||
    text(value['title']) ||
    text(value['name']);
  if (key || title) return key && title ? `${key} — ${title}` : key || title;

  const content = text(value['content']) || text(value['content_preview']);
  if (content) return htmlToText(content);

  const fileName = text(value['file_name']);
  if (fileName) return fileName;

  return value['id'] || value['target_id'] ? 'Unknown' : '';
}
