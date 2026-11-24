import { cellText, guardFormula } from '../filter-export.format';
import type { ExportDocument, RenderedExport } from '../filter-export.types';

const quote = (text: string) => `"${guardFormula(text).replace(/"/g, '""')}"`;

export function renderCsv(doc: ExportDocument): RenderedExport {
  const lines = [
    doc.columns.map((column) => quote(column.label)).join(','),
    ...doc.rows.map((row) =>
      row.cells
        .map((cell, index) =>
          // Numbers stay machine-readable: "1.234,5" would land in two cells or as text.
          typeof cell === 'number'
            ? String(cell)
            : quote(cellText(cell, doc.columns[index].kind, doc.locale)),
        )
        .join(','),
    ),
  ];

  return {
    // The BOM is what makes Excel read umlauts as UTF-8.
    buffer: Buffer.from(`\ufeff${lines.join('\n')}`, 'utf8'),
    extension: 'csv',
    contentType: 'text/csv; charset=utf-8',
  };
}
