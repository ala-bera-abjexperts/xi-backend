import ExcelJS from 'exceljs';

import { cellText, formatDate, guardFormula } from '../filter-export.format';
import {
  EXPORT_STRINGS,
  type ExportDocument,
  type RenderedExport,
} from '../filter-export.types';

const MAX_CELL_LENGTH = 32_767;
const MIN_COLUMN_WIDTH = 10;
const MAX_COLUMN_WIDTH = 60;

const DATE_FORMATS = {
  en: { date: 'yyyy-mm-dd', datetime: 'yyyy-mm-dd hh:mm' },
  de: { date: 'dd.mm.yyyy', datetime: 'dd.mm.yyyy hh:mm' },
} as const;

/** Excel refuses these characters, a name over 31 characters, and a leading or trailing quote. */
function sheetName(name: string, fallback: string, reserved: string): string {
  const clean = name
    .replace(/[\\/?*[\]:]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^'+|'+$/g, '')
    .trim()
    .slice(0, 31)
    .replace(/'+$/, '')
    .trim();

  return clean && clean.toLowerCase() !== reserved.toLowerCase()
    ? clean
    : fallback;
}

export async function renderXlsx(doc: ExportDocument): Promise<RenderedExport> {
  const strings = EXPORT_STRINGS[doc.locale];
  const workbook = new ExcelJS.Workbook();

  workbook.creator = 'XISUITE';

  const sheet = workbook.addWorksheet(
    sheetName(doc.title, 'Export', strings.infoSheet),
    { views: [{ state: 'frozen', ySplit: 1 }] },
  );

  const fit = (text: string) =>
    text.length > MAX_CELL_LENGTH
      ? `${text.slice(0, MAX_CELL_LENGTH - strings.truncated.length)}${strings.truncated}`
      : text;

  const widths = doc.columns.map((column) => column.label.length + 4);
  const header = sheet.addRow(
    doc.columns.map((column) => guardFormula(column.label)),
  );

  header.font = { bold: true };

  const keyIndex = doc.columns.findIndex((column) => column.id === 'key');

  for (const row of doc.rows) {
    const added = sheet.addRow(
      row.cells.map((cell) =>
        typeof cell === 'string' ? fit(guardFormula(cell)) : cell,
      ),
    );

    row.cells.forEach((cell, index) => {
      if (cell === null) return;

      const column = doc.columns[index];
      const target = added.getCell(index + 1);
      const text = cellText(cell, column.kind, doc.locale);

      widths[index] = Math.max(
        widths[index],
        ...text.split('\n').map((line) => line.length + 2),
      );

      if (cell instanceof Date) {
        target.numFmt =
          DATE_FORMATS[doc.locale][
            column.kind === 'datetime' ? 'datetime' : 'date'
          ];
      } else if (typeof cell === 'string') {
        if (cell.length > MAX_COLUMN_WIDTH || cell.includes('\n')) {
          target.alignment = { wrapText: true, vertical: 'top' };
        }

        if (index === keyIndex && row.keyHref) {
          target.value = {
            text: guardFormula(cell),
            hyperlink: row.keyHref,
          };
          target.font = { color: { argb: 'FF0563C1' }, underline: true };
        }
      }
    });
  }

  widths.forEach((width, index) => {
    sheet.getColumn(index + 1).width = Math.min(
      MAX_COLUMN_WIDTH,
      Math.max(MIN_COLUMN_WIDTH, width),
    );
  });

  if (doc.columns.length > 0) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: doc.rows.length + 1, column: doc.columns.length },
    };
  }

  const info = workbook.addWorksheet(strings.infoSheet);

  info.columns = [{ width: 18 }, { width: 80 }];

  for (const [label, value] of [
    [strings.filterName, doc.title],
    [strings.description, doc.description],
    [strings.query, doc.queryText],
    [strings.exportedBy, doc.exportedBy],
    [strings.exportedAt, formatDate(doc.exportedAt, true, doc.locale)],
    [strings.timeZone, doc.timeZone],
    [strings.rowCount, doc.rows.length],
  ] as const) {
    const row = info.addRow([
      label,
      typeof value === 'string' ? fit(guardFormula(value)) : value,
    ]);

    row.getCell(1).font = { bold: true };
    row.getCell(2).alignment = {
      wrapText: true,
      vertical: 'top',
      horizontal: 'left',
    };
  }

  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    extension: 'xlsx',
    contentType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
}
