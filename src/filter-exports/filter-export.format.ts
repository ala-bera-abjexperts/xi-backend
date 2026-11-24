/**
 * @fileoverview Value formatting shared by the filter export adapters.
 * @module src/filter-exports/filter-export.format
 */

import type {
  ExportCell,
  ExportColumnKind,
  FilterExportLocale,
} from './filter-export.types';

/**
 * Excel and Sheets execute a cell starting with one of these, so a leading quote makes it inert.
 * A plain number such as "-5" is not a formula and stays readable.
 */
export function guardFormula(text: string): string {
  const isPlainNumber = /^[+-]?(\d+\.?\d*|\.\d+)$/.test(text);

  return !isPlainNumber && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/** Text of a cell in the user's locale. Dates are already wall-clock, hence UTC here. */
export function cellText(
  cell: ExportCell,
  kind: ExportColumnKind,
  locale: FilterExportLocale,
): string {
  if (cell === null) return '';
  if (typeof cell === 'number') return cell.toLocaleString(locale);
  if (!(cell instanceof Date)) return cell;

  return formatDate(cell, kind === 'datetime', locale);
}

export function formatDate(
  date: Date,
  withTime: boolean,
  locale: FilterExportLocale,
): string {
  return date.toLocaleString(locale, {
    timeZone: 'UTC',
    dateStyle: 'medium',
    ...(withTime ? { timeStyle: 'short' } : {}),
  });
}

/** The same instant as the user reads it in `timeZone`, stored as UTC. */
export function toWallClock(date: Date, timeZone: string): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, Number(value)]),
  );

  return new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ),
  );
}

/** `<filter name>_<yyyy-MM-dd_HHmm>.<ext>`: umlauts stay, characters no file system allows go. */
export function exportFileName(
  name: string,
  exportedAt: Date,
  extension: string,
): string {
  const safeName =
    name
      .replace(/[\\/:*?"<>|\p{Cc}]/gu, '_')
      .trim()
      .slice(0, 100)
      .trim() || 'filter-export';
  const stamp = exportedAt.toISOString().slice(0, 16).replace('T', '_');

  return `${safeName}_${stamp.replace(':', '')}.${extension}`;
}
