import type {
  IPdfPageSize,
  IPdfRenderOptions,
} from '../../document-designer/rendering/pdf-render.service';
import { cellText, formatDate } from '../filter-export.format';
import {
  EXPORT_STRINGS,
  type ExportColumn,
  type ExportDocument,
  type RenderedExport,
} from '../filter-export.types';

/** More columns than this are unreadable even on A3, so the export asks to remove some. */
export const PDF_MAX_COLUMNS = 20;
const A4_MAX_COLUMNS = 12;
const MAX_CELL_CHARS = 300;
/** Well above the renderer's 30 s default: this is up to 2000 table rows, not a one-page template. */
const RENDER_TIMEOUT_MS = 120_000;

const A4_LANDSCAPE: IPdfPageSize = { widthPx: 1123, heightPx: 794 };
const A3_LANDSCAPE: IPdfPageSize = { widthPx: 1587, heightPx: 1123 };

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const clip = (text: string) =>
  text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}…` : text;

/** Share of the page width: free text gets the most room. */
function columnWeight(column: ExportColumn): number {
  if (column.id === 'description') return 5;
  if (column.id === 'title') return 4;
  if (column.id !== 'key' && column.kind !== 'text') return 1.5;

  return 2;
}

/** Bigger text while it fits; the smallest size (8.5 px, about 6.5 pt) still prints legibly. */
function fontSizePx(columnCount: number): number {
  if (columnCount <= 8) return 11;
  if (columnCount <= A4_MAX_COLUMNS) return 9.5;

  return columnCount <= 16 ? 10 : 8.5;
}

export function renderPdfHtml(doc: ExportDocument, page: IPdfPageSize): string {
  const strings = EXPORT_STRINGS[doc.locale];
  const totalWeight = doc.columns.reduce(
    (sum, column) => sum + columnWeight(column),
    0,
  );

  const colgroup = doc.columns
    .map(
      (column) =>
        `<col style="width:${((columnWeight(column) / totalWeight) * 100).toFixed(2)}%">`,
    )
    .join('');
  const head = doc.columns
    .map((column) => `<th dir="auto">${escapeHtml(column.label)}</th>`)
    .join('');

  const body = doc.rows.length
    ? doc.rows
        .map(
          (row) =>
            `<tr>${row.cells
              .map((cell, index) => {
                const column = doc.columns[index];
                const text = escapeHtml(
                  clip(cellText(cell, column.kind, doc.locale)),
                );

                return column.kind === 'number'
                  ? `<td class="num">${text}</td>`
                  : `<td dir="auto">${text}</td>`;
              })
              .join('')}</tr>`,
        )
        .join('')
    : `<tr><td class="empty" colspan="${doc.columns.length}">${strings.noResults}</td></tr>`;

  const subtitle = [doc.description, doc.queryText]
    .filter(Boolean)
    .map((line) => `<p dir="auto">${escapeHtml(clip(line))}</p>`)
    .join('');
  const meta = [
    `${strings.exportedAt}: ${formatDate(doc.exportedAt, true, doc.locale)} (${doc.timeZone})`,
    `${strings.exportedBy}: ${doc.exportedBy}`,
    `${strings.rowCount}: ${doc.rows.length.toLocaleString(doc.locale)}`,
  ]
    .map(escapeHtml)
    .join(' · ');

  return `<!doctype html><html lang="${doc.locale}"><head><meta charset="utf-8"><style>
@page { size: ${page.widthPx}px ${page.heightPx}px; margin: 32px 28px 44px; }
body { margin: 0; color: #1f2937; font: ${fontSizePx(doc.columns.length)}px Helvetica, Arial, 'Liberation Sans', FreeSans, sans-serif; }
h1 { margin: 0 0 4px; font-size: 18px; overflow-wrap: anywhere; }
p { margin: 0 0 2px; color: #4b5563; font-size: 10px; overflow-wrap: anywhere; }
.meta { margin: 4px 0 12px; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
th { background: #f3f4f6; font-weight: 600; text-align: start; }
th, td { border: 1px solid #e5e7eb; padding: 3px 5px; vertical-align: top; overflow-wrap: anywhere; white-space: pre-line; }
.num { text-align: end; }
.empty { padding: 16px; color: #6b7280; text-align: center; }
</style></head><body>
<h1 dir="auto">${escapeHtml(doc.title)}</h1>${subtitle}<p class="meta">${meta}</p>
<table><colgroup>${colgroup}</colgroup><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
</body></html>`;
}

export async function renderPdf(
  doc: ExportDocument,
  render: (
    html: string,
    page: IPdfPageSize,
    options: IPdfRenderOptions,
  ) => Promise<Buffer>,
): Promise<RenderedExport> {
  const strings = EXPORT_STRINGS[doc.locale];
  const page =
    doc.columns.length > A4_MAX_COLUMNS ? A3_LANDSCAPE : A4_LANDSCAPE;

  const footerHtml = `<div style="width:100%;padding:0 28px;font:9px Helvetica,Arial,sans-serif;color:#6b7280;display:flex;justify-content:space-between">
<span>XISUITE</span><span>${strings.page} <span class="pageNumber"></span> ${strings.of} <span class="totalPages"></span></span></div>`;

  return {
    buffer: await render(renderPdfHtml(doc, page), page, {
      footerHtml,
      timeoutMs: RENDER_TIMEOUT_MS,
    }),
    extension: 'pdf',
    contentType: 'application/pdf',
  };
}
