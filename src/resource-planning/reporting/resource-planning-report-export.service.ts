import { BadRequestException, Injectable } from '@nestjs/common';
import { PdfRenderService } from '../../document-designer/rendering/pdf-render.service';
import type { ResourcePlanningReport } from './resource-planning-report.types';

const MAX_EXPORT_ROWS = 10_000;
const PDF_PAGE = { widthPx: 1123, heightPx: 794 } as const;

@Injectable()
export class ResourcePlanningReportExportService {
  constructor(private readonly pdfRenderService: PdfRenderService) {}

  toCsv(report: ResourcePlanningReport): string {
    this.assertExportSize(report);
    const headers = [
      'Bucket start',
      'Bucket end',
      'Group',
      'Group type',
      'Currency',
      'Capacity hours',
      'Planned hours',
      'Actual hours',
      'Utilization %',
      'Planned labor cost',
      'Actual labor cost',
      'Planned non-labor cost',
      'Actual non-labor cost',
      'Planned total cost',
      'Actual total cost',
      'Hours variance',
      'Cost variance',
      'Over allocated',
    ];
    const rows: Array<Array<string | number | boolean | null>> =
      report.rows.map((row) => [
        row.bucket_start,
        row.bucket_end,
        row.group_name,
        row.group_type,
        row.currency,
        row.capacity_hours,
        row.planned_hours,
        row.actual_hours,
        row.utilization_percent,
        row.planned_labor_cost,
        row.actual_labor_cost,
        row.planned_non_labor_cost,
        row.actual_non_labor_cost,
        row.planned_total_cost,
        row.actual_total_cost,
        row.variance_hours,
        row.variance_cost,
        row.over_allocated,
      ]);

    const totalsHeaders = [
      'Currency',
      'Capacity hours',
      'Planned hours',
      'Actual hours',
      'Utilization %',
      'Planned labor cost',
      'Actual labor cost',
      'Planned non-labor cost',
      'Actual non-labor cost',
      'Planned total cost',
      'Actual total cost',
      'Hours variance',
      'Cost variance',
      'Over allocated',
    ];
    const totalsRows: Array<Array<string | number | boolean | null>> =
      report.totals_by_currency.map((total) => [
        total.currency,
        total.capacity_hours,
        total.planned_hours,
        total.actual_hours,
        total.utilization_percent,
        total.planned_labor_cost,
        total.actual_labor_cost,
        total.planned_non_labor_cost,
        total.actual_non_labor_cost,
        total.planned_total_cost,
        total.actual_total_cost,
        total.variance_hours,
        total.variance_cost,
        total.over_allocated,
      ]);

    const mainSection = [headers, ...rows]
      .map((row) => row.map(csvCell).join(','))
      .join('\r\n');
    // Deduped totals, appended so a manual sum of `rows` isn't mistaken for
    // the authoritative total (rows can fan out across group/currency keys).
    const totalsSection = [['Totals'], totalsHeaders, ...totalsRows]
      .map((row) => row.map(csvCell).join(','))
      .join('\r\n');

    return `${mainSection}\r\n\r\n${totalsSection}`;
  }

  async toPdf(report: ResourcePlanningReport): Promise<Buffer> {
    return this.pdfRenderService.renderPdf(this.toHtml(report), PDF_PAGE);
  }

  toHtml(report: ResourcePlanningReport): string {
    this.assertExportSize(report);
    const tableRows = report.rows
      .map(
        (row) => `<tr>
<td>${html(row.bucket_start)}</td><td>${html(row.bucket_end)}</td>
<td>${html(row.group_name)}</td><td>${html(row.currency)}</td>
<td class="number">${number(row.capacity_hours)}</td>
<td class="number">${number(row.planned_hours)}</td>
<td class="number">${number(row.actual_hours)}</td>
<td class="number">${number(row.utilization_percent)}</td>
<td class="number">${number(row.planned_total_cost)}</td>
<td class="number">${number(row.actual_total_cost)}</td>
<td>${row.over_allocated ? 'Yes' : 'No'}</td>
</tr>`,
      )
      .join('');
    // Deduped totals, rendered separately so a manual sum of the rows table
    // isn't mistaken for the authoritative total (rows can fan out across
    // group/currency keys).
    const totalsRows = report.totals_by_currency
      .map(
        (total) => `<tr>
<td>${html(total.currency)}</td>
<td class="number">${number(total.capacity_hours)}</td>
<td class="number">${number(total.planned_hours)}</td>
<td class="number">${number(total.actual_hours)}</td>
<td class="number">${number(total.utilization_percent)}</td>
<td class="number">${number(total.planned_total_cost)}</td>
<td class="number">${number(total.actual_total_cost)}</td>
<td>${total.over_allocated ? 'Yes' : 'No'}</td>
</tr>`,
      )
      .join('');
    const exceptionRows = Object.entries(report.exceptions)
      .map(
        ([key, value]) =>
          `<li><span>${html(label(key))}</span><strong>${number(value)}</strong></li>`,
      )
      .join('');

    return `<!doctype html>
<html><head><meta charset="utf-8"><style>
@page { size: 1123px 794px; margin: 28px; }
* { box-sizing: border-box; } body { font: 12px Arial, sans-serif; color: #172033; margin: 0; }
h1 { margin: 0 0 4px; font-size: 22px; } .meta { color: #596579; margin-bottom: 18px; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th, td { padding: 6px; border: 1px solid #d8dee9; overflow-wrap: anywhere; }
th { background: #eef2f7; text-align: left; } .number { text-align: right; }
tr { break-inside: avoid; } h2 { font-size: 15px; margin-top: 18px; }
ul { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px 16px; padding: 0; list-style: none; }
li { display: flex; justify-content: space-between; gap: 8px; }
</style></head><body>
<h1>Resource Planning Report</h1>
<div class="meta">${html(report.range.from)} to ${html(report.range.to)} · ${html(report.range.bucket)} · grouped by ${html(report.range.group_by)}</div>
<table><thead><tr><th>Start</th><th>End</th><th>Group</th><th>Currency</th><th>Capacity h</th><th>Planned h</th><th>Actual h</th><th>Util. %</th><th>Planned cost</th><th>Actual cost</th><th>Over</th></tr></thead>
<tbody>${tableRows}</tbody></table>
<h2>Totals</h2>
<table><thead><tr><th>Currency</th><th>Capacity h</th><th>Planned h</th><th>Actual h</th><th>Util. %</th><th>Planned cost</th><th>Actual cost</th><th>Over</th></tr></thead>
<tbody>${totalsRows}</tbody></table>
<h2>Exceptions</h2><ul>${exceptionRows}</ul>
</body></html>`;
  }

  private assertExportSize(report: ResourcePlanningReport): void {
    if (report.rows.length > MAX_EXPORT_ROWS) {
      throw new BadRequestException(
        'Report exports are limited to 10,000 rows',
      );
    }
  }
}

function csvCell(value: string | number | boolean | null): string {
  if (value === null) return '';
  let text = String(value);
  if (typeof value === 'string' && /^\s*[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function html(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function number(value: number | null): string {
  return value === null
    ? '—'
    : value.toLocaleString('en', { maximumFractionDigits: 2 });
}

function label(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/^./, (letter) => letter.toUpperCase());
}
