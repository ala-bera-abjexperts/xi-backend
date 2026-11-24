/**
 * @fileoverview The row/column model every filter export format renders. To add a format,
 * see docs/filter-exports.md.
 * @module src/filter-exports/filter-export.types
 */

export const FILTER_EXPORT_FORMATS = ['csv', 'xlsx', 'pdf'] as const;
export type FilterExportFormat = (typeof FILTER_EXPORT_FORMATS)[number];

export const FILTER_EXPORT_LOCALES = ['en', 'de'] as const;
export type FilterExportLocale = (typeof FILTER_EXPORT_LOCALES)[number];

export type ExportColumnKind = 'text' | 'number' | 'date' | 'datetime';

export interface ExportColumn {
  id: string;
  label: string;
  kind: ExportColumnKind;
}

/**
 * A `Date` holds the wall-clock time the user should read, stored as UTC, so every adapter
 * renders it in UTC and the time zone is applied exactly once (see `toWallClock`).
 */
export type ExportCell = string | number | Date | null;

export interface ExportRow {
  cells: ExportCell[];
  /** Absolute link for the Key column, when the entity has a page. */
  keyHref: string | null;
}

export interface ExportDocument {
  title: string;
  description: string;
  queryText: string;
  columns: ExportColumn[];
  rows: ExportRow[];
  locale: FilterExportLocale;
  exportedBy: string;
  /** Wall-clock export time; see {@link ExportCell}. */
  exportedAt: Date;
  timeZone: string;
}

export interface RenderedExport {
  buffer: Buffer;
  extension: string;
  contentType: string;
}

export const EXPORT_STRINGS = {
  en: {
    process: 'Process',
    task: 'Task',
    list_item: 'List Item',
    wiki_page: 'Wiki Page',
    yes: 'Yes',
    no: 'No',
    and: 'AND',
    or: 'OR',
    not: 'NOT',
    pullRequests: 'Pull requests',
    buildStatus: 'Build status',
    filterName: 'Filter',
    description: 'Description',
    query: 'Query',
    exportedBy: 'Exported by',
    exportedAt: 'Exported at',
    rowCount: 'Rows',
    timeZone: 'Time zone',
    infoSheet: 'Info',
    noResults: 'No results',
    page: 'Page',
    of: 'of',
    truncated: '… [truncated]',
  },
  de: {
    process: 'Prozess',
    task: 'Aufgabe',
    list_item: 'Listeneintrag',
    wiki_page: 'Wiki-Seite',
    yes: 'Ja',
    no: 'Nein',
    and: 'UND',
    or: 'ODER',
    not: 'NICHT',
    pullRequests: 'Pull Requests',
    buildStatus: 'Build-Status',
    filterName: 'Filter',
    description: 'Beschreibung',
    query: 'Abfrage',
    exportedBy: 'Exportiert von',
    exportedAt: 'Exportiert am',
    rowCount: 'Zeilen',
    timeZone: 'Zeitzone',
    infoSheet: 'Info',
    noResults: 'Keine Ergebnisse',
    page: 'Seite',
    of: 'von',
    truncated: '… [gekürzt]',
  },
} as const;
